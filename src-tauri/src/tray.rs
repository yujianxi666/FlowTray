//! Tray icon and context menu.

use std::sync::Arc;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;
use crate::actions;
use crate::app::App;
use crate::types::StorageUsage;

pub const TRAY_ID: &str = "flowtray-tray";

fn format_accelerator(accelerator: &str) -> String {
    let labels: Vec<String> = accelerator
        .split('+')
        .map(|part| match part.trim() {
            "Control" | "Ctrl" | "CommandOrControl" => "Ctrl".to_string(),
            "Alt" => "Alt".to_string(),
            "Shift" => "Shift".to_string(),
            "Space" => "空格".to_string(),
            other => other.to_string(),
        })
        .collect();
    labels.join(" + ")
}

fn build_menu(
    app: &Arc<App>,
    handle: &AppHandle,
    usage: &StorageUsage,
) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = app.settings();
    let visible = app.is_visible();
    let toggle_label = format!(
        "{}    {}",
        if visible { "隐藏流转台" } else { "显示流转台" },
        format_accelerator(&settings.hotkey_toggle)
    );
    let capture_label = format!(
        "从剪贴板暂存    {}",
        format_accelerator(&settings.hotkey_capture)
    );
    let toggle = MenuItem::with_id(handle, "toggle", toggle_label, true, None::<&str>)?;
    let capture = MenuItem::with_id(handle, "capture", capture_label, true, None::<&str>)?;
    let status = MenuItem::with_id(
        handle,
        "status",
        format!(
            "已暂存 {} 项 · 固定 {} 项",
            usage.item_count, usage.pinned_count
        ),
        false,
        None::<&str>,
    )?;
    let clear = MenuItem::with_id(handle, "clear", "清空未固定项…", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(handle, "settings", "设置…", true, None::<&str>)?;
    let onboarding =
        MenuItem::with_id(handle, "onboarding", "查看新手引导", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        handle,
        "autostart",
        "开机自动启动",
        true,
        settings.launch_at_login || settings.launch_as_admin,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(handle, "quit", "退出 FlowTray", true, None::<&str>)?;
    Menu::with_items(
        handle,
        &[
            &toggle,
            &capture,
            &PredefinedMenuItem::separator(handle)?,
            &status,
            &PredefinedMenuItem::separator(handle)?,
            &clear,
            &settings_item,
            &onboarding,
            &PredefinedMenuItem::separator(handle)?,
            &autostart,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )
}

pub fn init(app: &Arc<App>, handle: &AppHandle) -> tauri::Result<()> {
    let usage = app.query(|ctx| crate::items::usage(ctx));
    let menu = build_menu(app, handle, &usage)?;
    let icon = tauri::image::Image::from_bytes(crate::paths::tray_icon_bytes())?;
    let app_for_menu = app.clone();
    let app_for_click = app.clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("FlowTray 流转台")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |handle, event| {
            let id = event.id().as_ref().to_string();
            match id.as_str() {
                "toggle" => app_for_menu.toggle_shelf(),
                "capture" => actions::capture_from_tray(&app_for_menu),
                "clear" => actions::open_clear_confirm(&app_for_menu),
                "settings" => actions::open_settings(&app_for_menu, None),
                "onboarding" => actions::open_onboarding(&app_for_menu),
                "autostart" => {
                    let current = app_for_menu.settings();
                    let enabled = !(current.launch_at_login || current.launch_as_admin);
                    let mut patch = serde_json::Map::new();
                    patch.insert("launchAtLogin".into(), serde_json::json!(enabled));
                    patch.insert("launchAsAdmin".into(), serde_json::json!(false));
                    let result = actions::update_settings(&app_for_menu, patch);
                    if !result.ok {
                        let message = result
                            .errors
                            .first()
                            .map(|error| error.message.clone())
                            .unwrap_or_else(|| "更新开机启动失败。".into());
                        app_for_menu.show_shelf("tray", true);
                        app_for_menu.toast("error", message);
                    }
                    let _ = handle;
                }
                "quit" => quit(app_for_menu.clone()),
                _ => {}
            }
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                app_for_click.toggle_shelf();
            }
        })
        .build(handle)?;
    Ok(())
}

pub fn quit(app: Arc<App>) {
    app.mark_quitting();
    if let Some(handle) = app.handle() {
        handle.exit(0);
    }
}

pub fn refresh_now(app: &Arc<App>) {
    // Fallback only: querying the database from the event-loop thread blocks the
    // UI whenever a file operation holds the connection, which is what made the
    // window "not respond". Callers pass the count they already have.
    let usage = app.query(|ctx| crate::items::usage(ctx));
    refresh_with(app, &usage);
}

/// Same as [`refresh_now`] but without touching the database.
pub fn refresh_with(app: &Arc<App>, usage: &crate::types::StorageUsage) {
    let Some(handle) = app.handle() else {
        return;
    };
    let Some(tray) = handle.tray_by_id(TRAY_ID) else {
        return;
    };
    let tooltip = if usage.item_count > 0 {
        format!("FlowTray · {} 项暂存", usage.item_count)
    } else {
        "FlowTray 流转台".to_string()
    };
    let _ = tray.set_tooltip(Some(tooltip));
    if let Ok(menu) = build_menu(app, handle, usage) {
        let _ = tray.set_menu(Some(menu));
    }
}
