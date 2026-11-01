//! High-level application actions shared by IPC commands, the tray menu and the
//! global hotkeys.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::app::App;
use crate::clipboard;
use crate::fsx;
use crate::ids::now_ms;
use crate::items;
use crate::logger::LOGGER;
use crate::paths;
use crate::settings::Settings;
use crate::types::*;
use crate::winapi;

pub fn result_message(result: &MutationResult, prefix: &str) -> String {
    if result.added > 0 {
        let duplicates = if result.duplicates > 0 {
            format!("，{} 项已存在", result.duplicates)
        } else {
            String::new()
        };
        return format!("{prefix} {} 项{duplicates}。", result.added);
    }
    if result.duplicates > 0 {
        return "这些内容已在暂存台中，已为你置顶。".to_string();
    }
    prefix.to_string()
}

fn report_capture(app: &Arc<App>, result: MutationResult) {
    if result.ok {
        let message = result_message(&result, "已从剪贴板暂存");
        app.toast("success", message);
    } else {
        let message = result
            .errors
            .first()
            .map(|error| error.message.clone())
            .unwrap_or_else(|| "剪贴板里没有可暂存的内容。".to_string());
        app.toast("error", message);
    }
}

pub fn capture_from_hotkey(app: &Arc<App>) {
    let result = clipboard::capture_explicit(app, true);
    app.show_shelf("hotkey", true);
    report_capture(app, result);
}

pub fn capture_from_tray(app: &Arc<App>) {
    let result = clipboard::capture_explicit(app, true);
    app.show_shelf("tray", true);
    report_capture(app, result);
}

pub fn capture_from_shelf(app: &Arc<App>) -> MutationResult {
    let result = clipboard::capture_explicit(app, false);
    report_capture(app, result.clone());
    app.schedule_broadcast();
    result
}

pub fn open_settings(app: &Arc<App>, section: Option<String>) {
    app.show_shelf("ipc", true);
    app.send_command(UiCommand::OpenSettings { section });
}

pub fn open_onboarding(app: &Arc<App>) {
    app.show_shelf("ipc", true);
    app.send_command(UiCommand::OpenOnboarding);
}

pub fn open_clear_confirm(app: &Arc<App>) {
    app.show_shelf("tray", true);
    app.send_command(UiCommand::OpenClearConfirm);
}

pub fn remove_items(app: &Arc<App>, ids: Vec<String>) -> MutationResult {
    let existing: Vec<String> = app.query(|ctx| {
        items::get_copyable_rows(ctx, &ids)
            .into_iter()
            .map(|row| row.id)
            .collect()
    });
    let result = app.mutate(|ctx| items::remove(ctx, &ids));
    app.set_undo("delete", existing);
    result
}

pub fn clear_items(app: &Arc<App>, include_pinned: bool) -> MutationResult {
    let (result, ids) = app.mutate(|ctx| items::clear(ctx, include_pinned));
    app.set_undo("clear", ids);
    result
}

pub fn restore_undo(app: &Arc<App>) -> MutationResult {
    let Some(entry) = app.take_undo() else {
        return MutationResult::default().failed(ItemError::new("invalid", "撤销窗口已过期。"));
    };
    let restore_ids = entry.ids.clone();
    let extend = entry.kind == "expiry";
    let restored = app.mutate(|ctx| items::restore(ctx, &restore_ids, extend));
    if restored > 0 {
        MutationResult {
            ok: true,
            added: restored,
            duplicates: 0,
            errors: Vec::new(),
            message: None,
            undo: None,
        }
    } else {
        MutationResult::default().failed(ItemError::new("not_found", "这些内容已无法恢复。"))
    }
}

pub fn copy_items(app: &Arc<App>, ids: Vec<String>, kind: String) -> CopyResult {
    let result = clipboard::copy_selection(app, &ids, &kind);
    clipboard::mark_self_write(app);
    result
}

pub fn open_item(app: &Arc<App>, id: &str) -> CopyResult {
    let detail = app.query(|ctx| items::get_detail(ctx, id));
    let Some(detail) = detail else {
        return CopyResult::failure("这条内容已不在暂存台中。");
    };
    if detail.view.item_type == "url" {
        let url = detail.view.url.clone().or(detail.text_content.clone());
        let Some(url) = url else {
            return CopyResult::failure("链接格式无效，无法打开。");
        };
        return match winapi::open_url(&url) {
            Ok(()) => CopyResult::ok(),
            Err(message) => CopyResult::failure(message),
        };
    }
    if detail.view.item_type == "text" {
        return CopyResult::failure("文本卡片请打开预览后复制。");
    }
    let Some(path) = detail.view.path.as_ref() else {
        return CopyResult::failure("文件已失效或被移动，请重新定位。");
    };
    let path = PathBuf::from(path);
    if !fsx::path_exists(&path) {
        return CopyResult::failure("文件已失效或被移动，请重新定位。");
    }
    match winapi::open_path(&path) {
        Ok(()) => CopyResult::ok(),
        Err(message) => CopyResult::failure(message),
    }
}

pub fn reveal_item(app: &Arc<App>, id: &str) -> CopyResult {
    let detail = app.query(|ctx| items::get_detail(ctx, id));
    let Some(detail) = detail else {
        return CopyResult::failure("没有可定位的文件。");
    };
    let Some(path) = detail.view.path else {
        return CopyResult::failure("没有可定位的文件。");
    };
    let path = PathBuf::from(path);
    if !fsx::path_exists(&path) {
        return CopyResult::failure("文件已失效或被移动，无法定位。");
    }
    winapi::reveal_path(&path);
    CopyResult::ok()
}

pub fn relocate_item(app: &Arc<App>, id: &str) -> MutationResult {
    let detail = app.query(|ctx| items::get_detail(ctx, id));
    let Some(detail) = detail else {
        return MutationResult::default().failed(ItemError::new("not_found", "这条内容已不在暂存台中。"));
    };
    if !matches!(detail.view.item_type.as_str(), "file" | "folder" | "image") {
        return MutationResult::default().failed(ItemError::new(
            "invalid",
            "这条内容不支持重新定位。",
        ));
    }
    let title = if detail.view.item_type == "folder" {
        "选择文件夹的新位置"
    } else {
        "重新定位文件"
    };
    app.set_interaction_locked(true);
    let picked = winapi::pick_folder(title, None);
    app.set_interaction_locked(false);
    let Some(path) = picked else {
        return MutationResult::default().failed(ItemError::new("invalid", "已取消重新定位。"));
    };
    // For files, the folder picker only yields a directory; fall back to the
    // original folder selection semantics by accepting a directory that holds
    // the file with the same name.
    let candidate = if detail.view.item_type == "folder" || path.is_file() {
        path
    } else {
        let name = detail.view.name.clone();
        let nested = path.join(&name);
        if fsx::path_exists(&nested) {
            nested
        } else {
            return MutationResult::default().failed(ItemError::new(
                "invalid",
                format!("所选文件夹中没有找到「{name}」。"),
            ));
        }
    };
    app.mutate(|ctx| items::relocate(ctx, id, &candidate))
}

pub fn restore_original(app: &Arc<App>, id: &str) -> MutationResult {
    app.mutate(|ctx| items::restore_original(ctx, id))
}

pub fn update_settings(app: &Arc<App>, patch: Map<String, Value>) -> SettingsUpdateResult {
    let previous = app.settings();
    let mut draft = previous.clone();
    let validation = draft.apply_patch(&patch);
    if !validation.ok {
        return validation;
    }
    let touches_hotkeys = patch.contains_key("hotkeyToggle") || patch.contains_key("hotkeyCapture");
    if touches_hotkeys && draft.hotkey_toggle == draft.hotkey_capture {
        return SettingsUpdateResult::error("hotkey", "两个快捷键不能相同。");
    }
    if patch.get("launchAsAdmin").and_then(|value| value.as_bool()) == Some(true) {
        let elevated = winapi::is_elevated();
        app.elevated.store(elevated, std::sync::atomic::Ordering::Relaxed);
        if !elevated {
            return SettingsUpdateResult::error(
                "launchAsAdmin",
                "管理员自启动需要以管理员身份运行。请先使用“以管理员身份重启”。",
            );
        }
    }

    if touches_hotkeys {
        let apply = app
            .hotkeys_service
            .lock()
            .as_ref()
            .map(|service| service.apply(&draft.hotkey_toggle, &draft.hotkey_capture))
            .unwrap_or_else(|| Err("快捷键服务尚未就绪。".to_string()));
        if let Err(error) = apply {
            return SettingsUpdateResult::error("hotkey", error);
        }
    }

    app.set_settings(draft.clone());
    // Side effects the renderer cannot apply on its own: the docked window has to
    // move/resize and the always-on-top flag lives on the native window.
    app.apply_window_settings();
    if patch.contains_key("clipboardMonitor") {
        app.clipboard.lock().monitoring = draft.clipboard_monitor;
    }
    // Without this the panel keeps showing the old values: every control looked
    // dead because the UI only redraws from a broadcast snapshot.
    app.schedule_broadcast();

    if patch.contains_key("launchAtLogin") || patch.contains_key("launchAsAdmin") {
        // `schtasks` can take seconds (and antivirus makes it worse); running it on
        // the main thread froze the window, which looked like the app had crashed.
        let app_background = app.clone();
        let launch_at_login = draft.launch_at_login;
        let launch_as_admin = draft.launch_as_admin;
        std::thread::spawn(move || {
            let elevated = winapi::is_elevated();
            let outcome =
                crate::autostart::apply(launch_at_login, launch_as_admin, elevated);
            *app_background.autostart_warning.lock() =
                outcome.warning.clone().or(outcome.error.clone());
            crate::logger::LOGGER.info(
                "autostart.applied",
                Some(serde_json::json!({
                    "ok": outcome.ok,
                    "login": launch_at_login,
                    "admin": launch_as_admin,
                })),
            );
            app_background.schedule_broadcast();
        });
    }

    SettingsUpdateResult::ok()
}

/// Writes the current settings (and the user data location) to a JSON file the
/// user picked, so a configuration can be carried to another machine.
pub fn export_settings(app: &Arc<App>) -> ClearDataResult {
    let stamp = crate::ids::now_ms();
    let name = format!("flowtray-settings-{stamp}.json");
    let Some(path) = winapi::save_file_dialog("导出 FlowTray 设置", &name) else {
        return ClearDataResult {
            ok: false,
            message: Some("已取消导出。".into()),
        };
    };
    let settings = app.settings();
    let payload = serde_json::json!({
        "kind": "flowtray-settings",
        "exportedAt": stamp,
        "version": env!("CARGO_PKG_VERSION"),
        "dataPath": crate::paths::user_data_dir().to_string_lossy(),
        "settings": settings,
    });
    let written = serde_json::to_vec_pretty(&payload)
        .map_err(|error| error.to_string())
        .and_then(|bytes| std::fs::write(&path, &bytes).map_err(|error| error.to_string()));
    match written {
        Ok(()) => {
            LOGGER.info(
                "settings.exported",
                Some(serde_json::json!({ "path": path.to_string_lossy() })),
            );
            ClearDataResult {
                ok: true,
                message: Some(format!("设置已导出到 {}", path.display())),
            }
        }
        Err(error) => ClearDataResult {
            ok: false,
            message: Some(format!("导出失败：{error}")),
        },
    }
}

pub fn reset_settings(app: &Arc<App>) -> SettingsUpdateResult {
    let previous = app.settings();
    let mut next = Settings::default();
    next.storage_dir = previous.storage_dir.clone();
    next.onboarding_done = previous.onboarding_done;
    if let Some(service) = app.hotkeys_service.lock().as_ref() {
        let _ = service.apply(&next.hotkey_toggle, &next.hotkey_capture);
    }
    app.set_settings(next.clone());
    let elevated = winapi::is_elevated();
    let _ = crate::autostart::apply(next.launch_at_login, next.launch_as_admin, elevated);
    *app.autostart_warning.lock() = crate::autostart::warning_for(next.launch_as_admin, elevated);
    app.clipboard.lock().monitoring = next.clipboard_monitor;
    app.apply_window_settings();
    app.schedule_broadcast();
    SettingsUpdateResult::ok()
}

pub fn choose_storage_dir(app: &Arc<App>) -> StorageChoice {
    let current = app.storage_root();
    app.set_interaction_locked(true);
    let picked = winapi::pick_folder("选择 FlowTray 的存储位置", Some(&current));
    app.set_interaction_locked(false);
    let Some(chosen) = picked else {
        return StorageChoice {
            ok: false,
            message: Some("已取消。".into()),
            path: None,
        };
    };
    if chosen == current {
        return StorageChoice {
            ok: false,
            message: Some("这已经是当前存储位置。".into()),
            path: None,
        };
    }
    if fsx::is_path_inside(&chosen, &current) || fsx::is_path_inside(&current, &chosen) {
        return StorageChoice {
            ok: false,
            message: Some("不能选择当前存储位置的子目录或父目录。".into()),
            path: None,
        };
    }
    if let Err(error) = fsx::ensure_dir(&chosen) {
        return StorageChoice {
            ok: false,
            message: Some(format!("无法使用这个文件夹：{error}")),
            path: None,
        };
    }
    for name in ["files", "thumbs"] {
        let target = chosen.join(name);
        if let Ok(entries) = std::fs::read_dir(&target) {
            if entries.count() > 0 {
                return StorageChoice {
                    ok: false,
                    message: Some(format!("目标文件夹中的 {name} 目录非空，请选择一个空文件夹。")),
                    path: None,
                };
            }
        }
    }
    let probe = chosen.join(format!(".flowtray-write-test-{}", now_ms()));
    if std::fs::write(&probe, b"ok").is_err() {
        return StorageChoice {
            ok: false,
            message: Some("无法写入这个文件夹，请检查权限。".into()),
            path: None,
        };
    }
    let _ = std::fs::remove_file(&probe);

    let was_monitoring = app.clipboard.lock().monitoring;
    app.clipboard.lock().monitoring = false;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for name in ["files", "thumbs"] {
        let from = current.join(name);
        let to = chosen.join(name);
        if fsx::path_exists(&from) {
            if fsx::path_exists(&to) {
                fsx::remove_path(&to);
            }
            match fsx::move_path(&from, &to, true) {
                Ok(()) => moved.push((from, to)),
                Err(error) => {
                    for (origin, destination) in moved.iter().rev() {
                        let _ = fsx::move_path(destination, origin, true);
                    }
                    app.clipboard.lock().monitoring = was_monitoring;
                    LOGGER.warn(
                        "storage.migrate_failed",
                        Some(serde_json::json!({ "error": error.to_string() })),
                    );
                    return StorageChoice {
                        ok: false,
                        message: Some(
                            "迁移失败，已尽量恢复原位置。请检查磁盘空间与权限。".into(),
                        ),
                        path: None,
                    };
                }
            }
        } else {
            let _ = fsx::ensure_dir(&to);
        }
    }
    app.set_storage_dir(chosen.to_string_lossy().to_string());
    app.mutate(|ctx| ctx.ensure_layout());
    app.clipboard.lock().monitoring = was_monitoring;
    app.schedule_broadcast();
    StorageChoice {
        ok: true,
        message: Some("存储位置已更新。".into()),
        path: Some(chosen.to_string_lossy().to_string()),
    }
}

pub fn open_storage_dir(app: &Arc<App>) {
    let path = app.storage_root();
    let _ = fsx::ensure_dir(&path);
    let _ = winapi::open_folder(&path);
}

pub fn open_data_dir() {
    let path = paths::user_data_dir();
    let _ = fsx::ensure_dir(&path);
    let _ = winapi::open_folder(&path);
}

pub fn open_logs_dir() {
    let path = paths::logs_dir();
    let _ = fsx::ensure_dir(&path);
    let _ = winapi::open_folder(&path);
}

pub fn clear_all_data(app: &Arc<App>, include_settings: bool) -> ClearDataResult {
    app.clipboard.lock().monitoring = false;
    if let Some(service) = app.hotkeys_service.lock().as_ref() {
        service.suspend();
    }
    app.clear_undo();
    let result = (|| -> Result<(), String> {
        {
            let connection = app.db.lock();
            connection
                .execute("DELETE FROM items", [])
                .map_err(|error| error.to_string())?;
            if include_settings {
                let _ = connection.execute("DELETE FROM settings", []);
                let _ = connection.execute("DELETE FROM meta", []);
            }
        }
        fsx::remove_path(&app.files_root());
        fsx::remove_path(&app.thumbs_root());
        fsx::remove_path(&paths::drag_cache_dir());
        let _ = fsx::ensure_dir(&app.files_root());
        let _ = fsx::ensure_dir(&app.thumbs_root());
        if include_settings {
            fsx::remove_path(&paths::logs_dir());
            fsx::remove_path(&app.db_path);
            fsx::remove_path(&PathBuf::from(format!("{}-wal", app.db_path.to_string_lossy())));
            fsx::remove_path(&PathBuf::from(format!("{}-shm", app.db_path.to_string_lossy())));
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            LOGGER.info(
                "data.cleared",
                Some(serde_json::json!({ "includeSettings": include_settings })),
            );
            app.mark_quitting();
            if let Some(handle) = app.handle() {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(350));
                    handle.restart();
                });
            }
            ClearDataResult {
                ok: true,
                message: Some("本地数据已清除，FlowTray 将重新启动。".into()),
            }
        }
        Err(error) => {
            LOGGER.warn(
                "data.clear_failed",
                Some(serde_json::json!({ "error": error })),
            );
            ClearDataResult {
                ok: false,
                message: Some("清除数据失败，请关闭应用后手动删除数据目录。".into()),
            }
        }
    }
}

pub fn notify(app: &Arc<App>, title: &str, body: &str) {
    LOGGER.info(
        "notification.shown",
        Some(serde_json::json!({ "title": title })),
    );
    if !app.is_visible() {
        app.show_shelf("app", false);
    }
    app.toast("info", format!("{title}：{body}"));
}

pub fn handle_expired(app: &Arc<App>, ids: Vec<String>) {
    if ids.is_empty() {
        return;
    }
    app.set_undo("expiry", ids.clone());
    if !app.is_visible() {
        notify(app, "已自动清理到期内容", &format!("{} 项临时内容已到期并移出暂存台。", ids.len()));
    }
}

pub fn handle_remind(app: &Arc<App>, count: usize) {
    if count == 0 {
        return;
    }
    let message = format!("有 {count} 项内容将在 15 分钟内到期。");
    if app.is_visible() {
        app.toast("info", message);
    } else {
        notify(app, "FlowTray 到期提醒", &format!("{message}固定后即可长期保留。"));
    }
}
