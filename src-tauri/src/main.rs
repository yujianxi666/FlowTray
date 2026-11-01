#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod app;
mod autostart;
mod clipboard;
mod commands;
mod db;
mod drag_landing;
mod drag_native;
mod drag_payload;
mod drag_out;
mod drop_target;
mod edge;
mod fsx;
mod ids;
mod items;
mod lifecycle;
mod logger;
mod paths;
mod redact;
mod settings;
mod shortcuts;
mod thumbs;
mod tray;
mod types;
mod winapi;
mod window;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use app::App;
use logger::{Level, LOGGER};

fn main() {
    install_panic_hook();

    // The embedded manifest is not guaranteed to apply on every toolchain, so the
    // DPI mode is set explicitly before any window exists. Without this the app
    // runs in DPI-virtualised coordinates and docks short of the screen edge.
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    if !acquire_single_instance() {
        return;
    }

    let state = App::new(paths::db_file());
    let app_for_setup = state.clone();

    let builder = tauri::Builder::default()
        .manage(state)
        .register_uri_scheme_protocol("flowtray", |ctx, request| {
            let state = ctx.app_handle().state::<Arc<App>>().inner().clone();
            let path = request.uri().path().to_string();
            let id = path
                .trim_start_matches('/')
                .strip_prefix("thumb/")
                .map(|value| value.to_string())
                .unwrap_or_default();
            let decoded = percent_decode(&id);
            let thumb = state.query(|ctx| items::get_thumb_path(ctx, &decoded));
            match thumb.and_then(|file| std::fs::read(file).ok()) {
                Some(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", "image/png")
                    .header("Cache-Control", "no-store")
                    .body(bytes)
                    .unwrap_or_else(|_| {
                        tauri::http::Response::builder()
                            .status(500)
                            .body(Vec::new())
                            .expect("static response")
                    }),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .expect("static response"),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_get_snapshot,
            commands::app_foreground,
            commands::app_toggle_window,
            commands::app_hide_window,
            commands::app_quit,
            commands::app_restart,
            commands::app_restart_admin,
            commands::app_open_data_dir,
            commands::app_open_logs_dir,
            commands::items_add_paths,
            commands::items_add_text,
            commands::items_add_urls,
            commands::items_add_clipboard,
            commands::items_add_image,
            commands::items_update,
            commands::items_pin,
            commands::items_remove,
            commands::items_clear,
            commands::items_undo,
            commands::items_copy,
            commands::items_open,
            commands::items_reveal,
            commands::items_relocate,
            commands::items_restore_original,
            commands::items_detail,
            commands::items_start_drag,
            commands::items_clipboard_read,
            commands::settings_update,
            commands::settings_reset,
            commands::settings_export,
            commands::settings_choose_storage,
            commands::settings_open_storage,
            commands::settings_open_data,
            commands::settings_open_logs,
            commands::settings_clear_data,
            commands::window_resize_live,
            commands::window_hide_ready,
            commands::window_resize_end,
            commands::window_interaction_lock,
            commands::window_open_settings,
            commands::window_open_onboarding,
            commands::shortcuts_suspend,
            commands::shortcuts_resume,
            commands::e2e_seed,
            commands::e2e_settings,
            commands::e2e_sweep,
            commands::e2e_flush,
        ])
        .setup(move |tauri_app| {
            let state = app_for_setup.clone();
            state.attach(tauri_app.handle().clone());
            winapi::set_app_user_model_id("com.flowtray.desktop");
            let settings = state.settings();
            LOGGER.init(
                &paths::logs_dir(),
                if settings.log_level == "debug" {
                    Level::Debug
                } else {
                    Level::Info
                },
            );
            LOGGER.info(
                "app.ready",
                Some(serde_json::json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "userData": paths::user_data_dir().to_string_lossy(),
                })),
            );

            // A manual launch (double-click / shortcut) always reveals the shelf.
            // Only autostart launches honour the "启动时展开" setting.
            let autostart_launch = std::env::args().any(|arg| arg == "--autostart");
            let manual_launch = !autostart_launch;
            // The first launch of the Tauri build always reveals the shelf, even if
            // the migrated Electron settings asked for a tray-only start.
            let first_tauri_run = !state.meta_flag("tauri_seen");
            if first_tauri_run {
                state.set_meta_flag("tauri_seen", true);
                LOGGER.info("boot.first_tauri_run", None);
            }

            // Create the shelf window ourselves so the WebView2 profile lives in
            // FlowTray's own data directory instead of %LOCALAPPDATA%.
            let window_config = tauri_app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "shelf")
                .cloned();
            if let Some(config) = window_config {
                let profile = paths::user_data_dir().join("webview");
                let _ = std::fs::create_dir_all(&profile);
                let builder = tauri::WebviewWindowBuilder::from_config(tauri_app.handle(), &config)?
                    .data_directory(profile);
                let created = builder.build()?;
                // WebView2 only registers its OLE drop target once the webview has
                // actually been composited. The shelf starts hidden and is only
                // shown on demand, so give it one off-screen composite pass now:
                // without it the first real drop can be ignored entirely.
                let _ = created.set_position(tauri::LogicalPosition::new(-10000.0, -10000.0));
                // Same artwork as the tray and the About page: the executable
                // resource cannot be compiled here (no windres), so the window
                // icon is applied at runtime instead of coming from the exe.
                if let Ok(icon) =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
                {
                    let _ = created.set_icon(icon);
                }
                let _ = created.show();
            }

            let elevated = winapi::is_elevated();
            state
                .elevated
                .store(elevated, std::sync::atomic::Ordering::Relaxed);
            let autostart = autostart::apply(
                settings.launch_at_login,
                settings.launch_as_admin,
                elevated,
            );
            *state.autostart_warning.lock() =
                autostart.warning.clone().or(autostart.error.clone());
            state.clipboard.lock().monitoring = settings.clipboard_monitor;

            // Broadcast coalescer: at most one snapshot every 32 ms.
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            *state.broadcast_tx.lock() = Some(tx);
            let broadcaster = state.clone();
            std::thread::spawn(move || {
                while rx.recv().is_ok() {
                    std::thread::sleep(std::time::Duration::from_millis(32));
                    while rx.try_recv().is_ok() {}
                    broadcaster.broadcast_snapshot();
                }
            });

            // Watchdog: the event-loop thread must answer within a few seconds.
            // When it does not, the log records it instead of the window silently
            // turning into "未响应".
            {
                let handle = tauri_app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let (tx, rx) = std::sync::mpsc::channel();
                    if handle
                        .run_on_main_thread(move || {
                            let _ = tx.send(());
                        })
                        .is_err()
                    {
                        return;
                    }
                    if rx
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .is_err()
                    {
                        crate::logger::LOGGER.warn(
                            "ui.main_thread_stalled",
                            Some(serde_json::json!({ "waitedMs": 5000 })),
                        );
                        std::thread::sleep(std::time::Duration::from_secs(15));
                    }
                });
            }

            // Global hotkeys are intentionally not registered: the feature was
            // removed from the UI, so the app must not reserve system-wide keys.
            // Tray icon, edge reveal and the second-instance launch remain.

            if let Some(window) = tauri_app.get_webview_window("shelf") {
                let events_app = state.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Focused(true) => events_app.handle_focus(),
                    WindowEvent::Focused(false) => events_app.handle_blur(),
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        events_app.hide_shelf();
                    }
                    _ => {}
                });
                // wry's built-in handler only forwards `CF_HDROP` and is
                // registered on whichever WebView2 children exist at creation
                // time, so text/URL drags were dropped and a lazily created
                // render widget could swallow the whole drop. Our own target is
                // installed on every child (and re-installed while WebView2
                // spins up new ones), so it is the default path now. Set
                // FLOWTRAY_OLE_DROP_TARGET=0 to fall back to the built-in one.
                if std::env::var("FLOWTRAY_OLE_DROP_TARGET").as_deref() != Ok("0") {
                    if let Ok(handle) = window.hwnd() {
                        drop_target::install(&state, handle.0 as isize);
                    }
                }
            }

            let tray_ready = match tray::init(&state, tauri_app.handle()) {
                Ok(()) => true,
                Err(error) => {
                    LOGGER.warn(
                        "tray.init_failed",
                        Some(serde_json::json!({ "error": error.to_string() })),
                    );
                    false
                }
            };

            lifecycle::boot(&state);
            lifecycle::spawn(state.clone());
            lifecycle::spawn_clipboard_monitor(state.clone());
            edge::spawn(state.clone());
            state.schedule_broadcast();

            // Second launches ask the running instance to reveal the shelf instead of
            // silently starting another process.
            if let Some(event) = show_event_handle() {
                let listener = state.clone();
                std::thread::spawn(move || loop {
                    if listener.is_quitting() {
                        break;
                    }
                    if wait_for_show(event) {
                        LOGGER.info("instance.show_requested", None);
                        listener.show_shelf("ipc", true);
                        listener.toast("info", "FlowTray 已在运行，为你唤出流转台。");
                    }
                });
            }

            let boot_app = state.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(900));
                boot_app.show_after_bootstrap(first_tauri_run || !tray_ready || manual_launch);
                boot_app.schedule_broadcast();
            });
            Ok(())
        });

    let tauri_app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            // The setup hook cannot create the WebView2 profile (access denied) when the
            // executable inherited a restrictive integrity label or the data directory is
            // not writable. Explain the real cause instead of a bare panic.
            LOGGER.error(
                "app.build_failed",
                Some(serde_json::json!({ "error": error.to_string() })),
            );
            let sep = char::from(92u8);
            let nl = char::from(10u8);
            winapi::show_error(
                "FlowTray 启动失败",
                &format!(
                    "无法初始化界面：{error}{nl}{nl}常见原因：程序所在的文件夹带有低完整性标签或权限受限，无法写入 %APPDATA%{sep}FlowTray。{nl}解决办法：把 FlowTray.exe 复制到桌面或安装到本机后再运行；若使用安装包，请先安装再启动。{nl}{nl}日志目录：{dir}",
                    dir = paths::logs_dir().display()
                ),
            );
            std::process::exit(2);
        }
    };

    tauri_app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let state = handle.state::<Arc<App>>();
            if !state.is_quitting() {
                api.prevent_exit();
            }
            let _ = handle.emit_to("shelf", "evt:shutdown", ());
        }
    });
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}


static SHOW_EVENT: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

fn show_event_handle() -> Option<isize> {
    let value = SHOW_EVENT.load(std::sync::atomic::Ordering::SeqCst);
    if value == 0 {
        None
    } else {
        Some(value)
    }
}

fn wait_for_show(event: isize) -> bool {
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::WaitForSingleObject;
    unsafe {
        let handle = HANDLE(event as *mut core::ffi::c_void);
        WaitForSingleObject(handle, 400) == WAIT_OBJECT_0
    }
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let report = format!("{info}");
        let directory = paths::logs_dir();
        let _ = std::fs::create_dir_all(&directory);
        let crash_file = directory.join("crash.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&crash_file)
        {
            use std::io::Write;
            let _ = writeln!(file, "{}", report);
        }
        winapi::show_error(
            "FlowTray 启动失败",
            &format!(
                "FlowTray 遇到未处理的错误：\n\n{}\n\n日志目录：{}",
                report,
                directory.display()
            ),
        );
        default_hook(info);
    }));
}

fn acquire_single_instance() -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::{CreateEventW, CreateMutexW, SetEvent};
    let sep = char::from(92u8);
    let name = HSTRING::from(format!("Local{sep}FlowTray.SingleInstance"));
    let event_name = HSTRING::from(format!("Local{sep}FlowTray.ShowShelf"));
    unsafe {
        let Ok(mutex) = CreateMutexW(None, true, &name) else {
            return true;
        };
        let already_running = GetLastError() == ERROR_ALREADY_EXISTS;
        let event = CreateEventW(None, false, false, &event_name).ok();
        if let Some(event) = &event {
            SHOW_EVENT.store(event.0 as isize, std::sync::atomic::Ordering::SeqCst);
        }
        if already_running {
            // Ask the running instance to reveal its shelf, then exit quietly so a
            // double-click always produces a visible result.
            if let Some(event) = &event {
                let _ = SetEvent(*event);
            }
            let _ = CloseHandle(mutex);
            if let Some(event) = &event {
                let _ = CloseHandle(*event);
            }
            return false;
        }
        // Keep both handles alive for the process lifetime.
        std::mem::forget(mutex);
        if let Some(event) = event {
            std::mem::forget(event);
        }
        true
    }
}
