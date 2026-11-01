//! Native OLE drag-out (`DoDragDrop`) executed on the window's own thread.
//!
//! Windows only runs a modal drag loop for the thread that owns the mouse
//! capture, so the session must run on the shelf window's UI thread; a worker
//! thread (or a helper process) never receives `QueryContinueDrag` at all.
//!
//! Two safeguards keep a wedged loop from taking the desktop with it:
//!
//! * the shelf's own OLE drop target is suspended for the duration, so the loop
//!   cannot re-enter our COM callbacks while it is running;
//! * a watchdog fakes a button release on the loop's capture window if the drag
//!   has not finished shortly after the real button went up.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::{implement, BOOL, HRESULT};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Ole::{
    DoDragDrop, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE, IDropSource, IDropSource_Impl,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};

use crate::app::App;
use crate::logger::LOGGER;

const DRAG_DEADLINE: Duration = Duration::from_secs(120);
const RELEASE_GRACE: Duration = Duration::from_millis(600);

#[derive(Clone, Default)]
pub(crate) struct ModifierWatch {
    keys: Arc<AtomicI32>,
    queries: Arc<AtomicI32>,
}

impl ModifierWatch {
    pub(crate) fn modifiers(&self) -> i32 {
        self.keys.load(Ordering::Relaxed)
    }

    fn queries(&self) -> i32 {
        self.queries.load(Ordering::Relaxed)
    }
}

#[implement(IDropSource)]
struct FlowDropSource {
    watch: ModifierWatch,
}

impl IDropSource_Impl for FlowDropSource_Impl {
    fn QueryContinueDrag(
        &self,
        fescapepressed: BOOL,
        grfkeystate: MODIFIERKEYS_FLAGS,
    ) -> HRESULT {
        let calls = self.watch.queries.fetch_add(1, Ordering::Relaxed);
        self.watch.keys.store(grfkeystate.0 as i32, Ordering::Relaxed);
        if calls < 5 || (grfkeystate.0 & MK_LBUTTON.0) == 0 {
            crate::drag_out::trace(&format!(
                "query call={calls} keys=0x{:x} escape={}",
                grfkeystate.0,
                fescapepressed.0 != 0
            ));
        }
        if fescapepressed.as_bool() {
            return windows::Win32::Foundation::DRAGDROP_S_CANCEL;
        }
        if (grfkeystate.0 & MK_LBUTTON.0) == 0 {
            return windows::Win32::Foundation::DRAGDROP_S_DROP;
        }
        HRESULT(0)
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        windows::Win32::Foundation::DRAGDROP_S_USEDEFAULTCURSORS
    }
}

pub(crate) struct NativeOutcome {
    pub(crate) ok: bool,
    pub(crate) effect: u32,
    pub(crate) modifiers: i32,
    pub(crate) aborted: bool,
}

fn capture_window(thread_id: u32) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetGUIThreadInfo(thread_id, &mut info) };
    if ok.is_ok() && !info.hwndCapture.0.is_null() {
        Some(info.hwndCapture)
    } else {
        None
    }
}

/// Posts a synthetic left-button-up to whatever window owns the drag capture.
fn force_release(thread_id: u32) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_LBUTTONUP};
    let Some(target) = capture_window(thread_id) else {
        return false;
    };
    let posted = unsafe { PostMessageW(Some(target), WM_LBUTTONUP, WPARAM(0), LPARAM(0)) };
    LOGGER.warn(
        "drag.force_release",
        Some(serde_json::json!({
            "hwnd": target.0 as isize,
            "posted": posted.is_ok(),
        })),
    );
    posted.is_ok()
}

fn watchdog(finished: Arc<AtomicBool>, thread_id: Arc<AtomicU32>) {
    let started = Instant::now();
    let mut released_at: Option<Instant> = None;
    loop {
        if finished.load(Ordering::SeqCst) {
            return;
        }
        if started.elapsed() > DRAG_DEADLINE {
            LOGGER.warn("drag.deadline", None);
            return;
        }
        if thread_id.load(Ordering::SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(30));
            continue;
        }
        if crate::winapi::left_button_down() {
            released_at = None;
            std::thread::sleep(Duration::from_millis(40));
            continue;
        }
        let moment = *released_at.get_or_insert_with(Instant::now);
        if moment.elapsed() < RELEASE_GRACE {
            std::thread::sleep(Duration::from_millis(40));
            continue;
        }
        // The user let go but the loop is still alive: nudge it with a fake
        // release so it can finish instead of holding the mouse capture.
        if force_release(thread_id.load(Ordering::SeqCst)) {
            for _ in 0..20 {
                if finished.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        LOGGER.warn("drag.abort_failed", None);
        crate::drag_out::trace("watchdog could not finish the drag");
        return;
    }
}

/// Runs one native drag. Returns `None` when the session could not be started or
/// never finished (the caller then falls back to the clipboard).
pub(crate) fn start(
    app: &Arc<App>,
    hwnd: isize,
    files: Vec<String>,
    effect: &str,
) -> Option<NativeOutcome> {
    if files.is_empty() || hwnd == 0 {
        return None;
    }
    let handle = app.handle()?.clone();
    let cut = effect == "cut";
    let (tx, rx) = mpsc::channel::<NativeOutcome>();
    let finished = Arc::new(AtomicBool::new(false));
    let thread_id = Arc::new(AtomicU32::new(0));

    {
        let finished = finished.clone();
        let thread_id = thread_id.clone();
        std::thread::spawn(move || watchdog(finished, thread_id));
    }

    let finished_loop = finished.clone();
    let thread_loop = thread_id.clone();
    let dispatched = handle.run_on_main_thread(move || {
        use windows::Win32::System::Threading::GetCurrentThreadId;
        // The UI thread is an STA already; OLE itself has to be initialised too.
        let _ = unsafe { windows::Win32::System::Ole::OleInitialize(None) };
        thread_loop.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
        let data_object = crate::drag_payload::build(
            &files,
            if cut { DROPEFFECT_MOVE.0 } else { DROPEFFECT_COPY.0 },
        );
        let watch = ModifierWatch::default();
        let source: IDropSource = FlowDropSource {
            watch: watch.clone(),
        }
        .into();
        let allowed = if cut { DROPEFFECT_MOVE } else { DROPEFFECT_COPY };
        let window = windows::Win32::Foundation::HWND(hwnd as *mut core::ffi::c_void);
        crate::drag_out::trace("native drag loop start");
        // Do not let the loop re-enter our own drop target while it runs. The
        // guard clears the flag even if `DoDragDrop` unwinds.
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                crate::drop_target::suspend(false);
            }
        }
        let _guard = Guard;
        crate::drop_target::suspend(true);
        unsafe {
            SetCapture(window);
        }
        let mut result = DROPEFFECT(0);
        let outcome = unsafe { DoDragDrop(&data_object, &source, allowed, &mut result) };
        unsafe {
            let _ = ReleaseCapture();
        }
        drop(_guard);
        crate::drag_out::trace(&format!(
            "native drag loop end ok={} effect={} queries={}",
            outcome.is_ok(),
            result.0,
            watch.queries()
        ));
        finished_loop.store(true, Ordering::SeqCst);
        let _ = tx.send(NativeOutcome {
            ok: outcome.is_ok(),
            effect: result.0,
            modifiers: watch.modifiers(),
            aborted: false,
        });
    });
    if let Err(error) = dispatched {
        LOGGER.warn(
            "drag.dispatch_failed",
            Some(serde_json::json!({ "error": error.to_string() })),
        );
        crate::drop_target::suspend(false);
        return None;
    }

    match rx.recv_timeout(DRAG_DEADLINE + Duration::from_secs(5)) {
        Ok(outcome) => Some(outcome),
        Err(_) => {
            crate::drop_target::suspend(false);
            LOGGER.warn("drag.no_outcome", None);
            None
        }
    }
}
