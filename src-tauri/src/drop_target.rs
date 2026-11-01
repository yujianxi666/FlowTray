//! Native OLE drop target.
//!
//! wry's built-in handler only forwards `CF_HDROP` file paths and swallows every
//! other clipboard format, which would drop text/URL drags on the floor. This
//! module installs its own `IDropTarget` on the shelf window (and every child
//! window owned by WebView2) and forwards paths, text, HTML, URLs and the live
//! modifier state to the renderer as Tauri events.

use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::Arc;

use tauri::{Emitter, Manager};
use windows::core::{implement, BOOL, Ref, Result as WinResult};
use windows::Win32::Foundation::{HWND, LPARAM, POINTL};
use windows::Win32::System::Com::{
    IDataObject, STGMEDIUM, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    OleInitialize, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, DROPEFFECT, DROPEFFECT_COPY,
    DROPEFFECT_MOVE, IDropTarget, IDropTarget_Impl,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::DROPFILES;
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetWindow, GW_CHILD, GW_HWNDNEXT};

use crate::app::App;
use crate::ids::now_ms;
use crate::logger::LOGGER;
use crate::types::DropPayload;
use crate::winapi;

thread_local! {
    /// COM objects must stay alive for as long as the window is registered.
    static KEEP_ALIVE: RefCell<Vec<IDropTarget>> = const { RefCell::new(Vec::new()) };
    static REGISTERED: RefCell<HashSet<isize>> = RefCell::new(HashSet::new());
}

/// Diagnostics: how many times OLE asked the target to hover/drop.
static OVER_CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// While our own drag-out is running the OLE loop sits on this thread; letting it
/// call back into our drop target re-enters the event loop mid-drag, so the
/// target politely refuses every format for the duration.
/// Expiry timestamp (ms). `0` means "not suspended". A hard deadline is used
/// instead of a boolean so a drag-out that dies half-way can never leave the
/// shelf rejecting every future drop with the "禁止" cursor.
static SUSPENDED_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const SUSPEND_LIMIT_MS: i64 = 90_000;

pub fn suspend(on: bool) {
    if on {
        let until = crate::ids::now_ms() + SUSPEND_LIMIT_MS;
        SUSPENDED_UNTIL.store(until.max(0) as u64, std::sync::atomic::Ordering::SeqCst);
        LOGGER.info("drop.suspended", None);
    } else {
        SUSPENDED_UNTIL.store(0, std::sync::atomic::Ordering::SeqCst);
        LOGGER.info("drop.resumed", None);
    }
}

fn is_suspended() -> bool {
    let until = SUSPENDED_UNTIL.load(std::sync::atomic::Ordering::Relaxed);
    if until == 0 {
        return false;
    }
    if crate::ids::now_ms() as u64 >= until {
        SUSPENDED_UNTIL.store(0, std::sync::atomic::Ordering::Relaxed);
        LOGGER.warn("drop.suspend_expired", None);
        return false;
    }
    true
}

#[implement(IDropTarget)]
pub struct FlowDropTarget {
    app: Arc<App>,
}

fn invert(effect: &str) -> String {
    if effect == "cut" {
        "copy".to_string()
    } else {
        "cut".to_string()
    }
}

fn current_effect(app: &Arc<App>) -> String {
    let settings = app.settings();
    let (ctrl, shift, alt) = winapi::modifier_state();
    let pressed = match settings.drag_modifier.as_str() {
        "shift" => shift,
        "alt" => alt,
        _ => ctrl,
    };
    if pressed {
        invert(&settings.drop_effect)
    } else {
        settings.drop_effect.clone()
    }
}

unsafe fn medium_bytes(medium: &STGMEDIUM) -> Option<Vec<u8>> {
    let handle = medium.u.hGlobal;
    if handle.0.is_null() {
        return None;
    }
    let size = GlobalSize(handle);
    if size == 0 {
        return None;
    }
    let pointer = GlobalLock(handle) as *const u8;
    if pointer.is_null() {
        return None;
    }
    let bytes = std::slice::from_raw_parts(pointer, size).to_vec();
    let _ = GlobalUnlock(handle);
    Some(bytes)
}

unsafe fn read_format(data: &Ref<'_, IDataObject>, format: u32) -> Option<Vec<u8>> {
    let object = data.as_ref()?;
    let format_etc = FORMATETC {
        cfFormat: format as u16,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let mut medium = match object.GetData(&format_etc) {
        Ok(medium) => medium,
        Err(_) => return None,
    };
    let bytes = medium_bytes(&medium);
    ReleaseStgMedium(&mut medium);
    bytes
}

fn utf16_to_string(bytes: &[u8]) -> String {
    let wide: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .take_while(|value| *value != 0)
        .collect();
    String::from_utf16_lossy(&wide)
}

/// CF_HDROP is an `HGLOBAL` that starts with a `DROPFILES` header. The payload
/// is copied out of the medium before parsing, so the handle cannot be handed to
/// `DragQueryFileW` (that expects the real HGLOBAL, not a copy of its contents).
fn parse_hdrop(bytes: &[u8]) -> Vec<String> {
    let mut paths = Vec::new();
    if bytes.len() < std::mem::size_of::<DROPFILES>() {
        return paths;
    }
    let header = bytes.as_ptr() as *const DROPFILES;
    let offset = unsafe { (*header).pFiles } as usize;
    let wide = unsafe { (*header).fWide.as_bool() };
    if offset == 0 || offset >= bytes.len() {
        return paths;
    }
    let payload = &bytes[offset..];
    if wide {
        let units: Vec<u16> = payload
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        for part in units.split(|value| *value == 0) {
            if part.is_empty() {
                continue;
            }
            let path = String::from_utf16_lossy(part);
            if !path.trim().is_empty() {
                paths.push(path);
            }
        }
    } else {
        for part in payload.split(|value| *value == 0) {
            if part.is_empty() {
                continue;
            }
            let path = String::from_utf8_lossy(part).to_string();
            if !path.trim().is_empty() {
                paths.push(path);
            }
        }
    }
    paths
}

fn extract_payload(data: &Ref<'_, IDataObject>, pt: Option<&POINTL>) -> DropPayload {
    let mut paths: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut html = String::new();
    unsafe {
        if let Some(bytes) = read_format(data, 15) {
            paths.extend(parse_hdrop(&bytes));
        }
        // Text/HTML/URL formats only matter when no files are being dropped; each
        // extra format is a cross-process `GetData` call made on the source
        // application's drag thread, so keep the file case minimal.
        if paths.is_empty() {
            if let Some(bytes) = read_format(data, 13) {
                text = utf16_to_string(&bytes);
            }
            let html_format = crate::clipboard::html_format_id();
            if html_format != 0 {
                if let Some(bytes) = read_format(data, html_format) {
                    html = crate::clipboard::parse_html_format(&bytes);
                }
            }
            let url_format = crate::clipboard::register_format("UniformResourceLocatorW");
            if url_format != 0 {
                if let Some(bytes) = read_format(data, url_format) {
                    let url = utf16_to_string(&bytes);
                    if !url.trim().is_empty() && text.trim().is_empty() {
                        text = url;
                    }
                }
            }
        }
    }
    let mut urls: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if crate::items::normalize_url(trimmed).is_some() {
            urls.push(trimmed.to_string());
        }
    }
    let (ctrl, shift, alt) = winapi::modifier_state();
    let (x, y) = match pt {
        Some(point) => (point.x, point.y),
        None => winapi::cursor_position(),
    };
    DropPayload {
        paths,
        text,
        html,
        urls,
        ctrl,
        shift,
        alt,
        x,
        y,
    }
}

/// Forwards target callbacks to the renderer on a dedicated thread.
///
/// OLE calls `DragEnter`/`DragOver`/`Drop` synchronously from inside
/// `DoDragDrop`. Emitting a Tauri event inline means the modal drag loop waits
/// for the WebView IPC, and a slow reply there freezes the drag (and the whole
/// window when the loop runs on the UI thread). Queuing keeps the loop free.
type TargetEvent = (&'static str, Option<DropPayload>);

static EVENT_TX: std::sync::OnceLock<std::sync::mpsc::Sender<TargetEvent>> =
    std::sync::OnceLock::new();
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

fn channel() -> &'static std::sync::mpsc::Sender<TargetEvent> {
    EVENT_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<TargetEvent>();
        std::thread::spawn(move || {
            while let Ok((event, payload)) = rx.recv() {
                let Some(handle) = APP_HANDLE.get() else {
                    continue;
                };
                match payload {
                    Some(payload) => {
                        let _ = handle.emit_to("shelf", event, &payload);
                    }
                    None => {
                        let _ = handle.emit_to("shelf", event, ());
                    }
                }
            }
        });
        tx
    })
}

fn emit(app: &Arc<App>, event: &'static str, payload: &DropPayload) {
    if let Some(handle) = app.handle() {
        let _ = APP_HANDLE.set(handle.clone());
    }
    let _ = channel().send((event, Some(payload.clone())));
}

fn emit_empty(app: &Arc<App>, event: &'static str) {
    if let Some(handle) = app.handle() {
        let _ = APP_HANDLE.set(handle.clone());
    }
    let _ = channel().send((event, None));
}

fn effect_flag(effect: &str) -> DROPEFFECT {
    if effect == "cut" {
        DROPEFFECT_MOVE
    } else {
        DROPEFFECT_COPY
    }
}

impl IDropTarget_Impl for FlowDropTarget_Impl {
    fn DragEnter(
        &self,
        pdataobj: Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> WinResult<()> {
        if is_suspended() {
            unsafe {
                if !pdweffect.is_null() {
                    *pdweffect = DROPEFFECT(0);
                }
            }
            return Ok(());
        }
        let payload = extract_payload(&pdataobj, Some(pt));
        LOGGER.debug(
            "drop.enter",
            Some(serde_json::json!({
                "paths": payload.paths.len(),
                "text": payload.text.chars().count(),
                "html": !payload.html.is_empty(),
            })),
        );
        LOGGER.debug("drop.enter.pre_emit", None);
        emit(&self.app, "drop:enter", &payload);
        LOGGER.debug("drop.enter.post_emit", None);
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = effect_flag(&current_effect(&self.app));
            }
        }
        let _ = now_ms();
        Ok(())
    }

    fn DragOver(
        &self,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> WinResult<()> {
        if is_suspended() {
            unsafe {
                if !pdweffect.is_null() {
                    *pdweffect = DROPEFFECT(0);
                }
            }
            return Ok(());
        }
        OVER_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = effect_flag(&current_effect(&self.app));
            }
        }
        let (ctrl, shift, alt) = winapi::modifier_state();
        let payload = DropPayload {
            paths: Vec::new(),
            text: String::new(),
            html: String::new(),
            urls: Vec::new(),
            ctrl,
            shift,
            alt,
            x: pt.x,
            y: pt.y,
        };
        emit(&self.app, "drop:over", &payload);
        Ok(())
    }

    fn DragLeave(&self) -> WinResult<()> {
        LOGGER.debug(
            "drop.leave",
            Some(serde_json::json!({
                "over": OVER_CALLS.load(std::sync::atomic::Ordering::Relaxed),
            })),
        );
        emit_empty(&self.app, "drop:leave");
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> WinResult<()> {
        if is_suspended() {
            unsafe {
                if !pdweffect.is_null() {
                    *pdweffect = DROPEFFECT(0);
                }
            }
            return Ok(());
        }
        let payload = extract_payload(&pdataobj, Some(pt));
        let effect = current_effect(&self.app);
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = effect_flag(&effect);
            }
        }
        LOGGER.debug(
            "drop.drop",
            Some(serde_json::json!({
                "paths": payload.paths.len(),
                "effect": effect,
            })),
        );
        emit(&self.app, "drop:drop", &payload);
        if let Some(handle) = self.app.handle().cloned() {
            let detail = serde_json::json!({
                "effect": effect,
                "ctrl": payload.ctrl,
                "shift": payload.shift,
                "alt": payload.alt
            });
            // Never block the OLE drop callback on the WebView IPC.
            std::thread::spawn(move || {
                let _ = handle.emit_to("shelf", "drop:effect", detail);
            });
        }
        Ok(())
    }
}

unsafe fn register_window(app: &Arc<App>, hwnd: HWND) {
    let key = hwnd.0 as isize;
    let already = REGISTERED.with(|cell| cell.borrow_mut().contains(&key));
    if already {
        return;
    }
    // WebView2 registers its own target on its child windows; revoke it so our
    // handler (which understands text/HTML/URL payloads) receives the drop.
    let _ = RevokeDragDrop(hwnd);
    let target: IDropTarget = FlowDropTarget { app: app.clone() }.into();
    match RegisterDragDrop(hwnd, &target) {
        Ok(()) => {
            REGISTERED.with(|cell| {
                cell.borrow_mut().insert(key);
            });
            KEEP_ALIVE.with(|cell| cell.borrow_mut().push(target));
        }
        Err(error) => {
            LOGGER.warn(
                "drop_target.register_failed",
                Some(serde_json::json!({
                    "hwnd": key,
                    "code": format!("{:#x}", error.code().0),
                })),
            );
        }
    }
}

unsafe extern "system" fn collect_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<isize>);
    list.push(hwnd.0 as isize);
    BOOL(1)
}

pub fn install(app: &Arc<App>, hwnd: isize) {
    unsafe {
        let _ = OleInitialize(None);
    }
    let Some(handle) = app.handle().cloned() else {
        return;
    };
    unsafe {
        register_window(app, HWND(hwnd as *mut core::ffi::c_void));
    }
    LOGGER.info(
        "drop_target.installed",
        Some(serde_json::json!({ "windows": REGISTERED.with(|cell| cell.borrow().len()) })),
    );
    let app = app.clone();
    std::thread::spawn(move || {
        // Keep watching for WebView2 child windows: they are created lazily and
        // only the deepest registered window receives the OLE drop, so a window
        // created after startup (devtools, IME, another renderer) has to be
        // picked up as well. Two minutes covers slow WebView2 starts.
        for attempt in 0..240 {
            let delay = if attempt == 0 { 80 } else { 350 };
            std::thread::sleep(std::time::Duration::from_millis(delay));
            let app = app.clone();
            if let Err(error) = handle.run_on_main_thread(move || unsafe {
                let root = HWND(hwnd as *mut core::ffi::c_void);
                register_window(&app, root);
                let mut children: Vec<isize> = Vec::new();
                let _ = EnumChildWindows(
                    Some(root),
                    Some(collect_child),
                    LPARAM(&mut children as *mut _ as isize),
                );
                for value in children {
                    register_window(&app, HWND(value as *mut core::ffi::c_void));
                }
                let mut child = GetWindow(root, GW_CHILD).unwrap_or_default();
                let mut depth = 0;
                while !child.0.is_null() && depth < 32 {
                    register_window(&app, child);
                    child = GetWindow(child, GW_HWNDNEXT).unwrap_or_default();
                    depth += 1;
                }
            }) {
                LOGGER.warn(
                    "drop_target.dispatch_failed",
                    Some(serde_json::json!({ "error": error.to_string() })),
                );
            }
            // Keep watching for WebView2 child windows; they are created lazily
            // and only the deepest registered window receives the OLE drop.
            if attempt > 20 {
                let count = REGISTERED.with(|cell| cell.borrow().len());
                if count > 0 && attempt % 20 == 0 {
                    LOGGER.debug(
                        "drop_target.watch",
                        Some(serde_json::json!({ "windows": count })),
                    );
                }
            }
        }
    });
}

pub fn uninstall(app: &Arc<App>) {
    let Some(handle) = app.handle() else {
        return;
    };
    let Some(window) = handle.get_webview_window("shelf") else {
        return;
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = RevokeDragDrop(HWND(hwnd.0));
        }
    }
    KEEP_ALIVE.with(|cell| cell.borrow_mut().clear());
    REGISTERED.with(|cell| cell.borrow_mut().clear());
}
