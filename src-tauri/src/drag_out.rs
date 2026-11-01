//! Drag-out without OLE.
//!
//! Windows only lets the *capturing* thread run a modal `DoDragDrop`, and inside
//! a WebView2 window that capture belongs to the browser process: an in-process
//! attempt keeps the loop alive forever (taking the whole desktop's drag & drop
//! with it) and an out-of-process attempt never even starts (the helper gets no
//! `QueryContinueDrag`). The shelf therefore tracks the pointer itself: when the
//! button is released it resolves what is under the cursor and either copies the
//! files into that folder (desktop) or puts them on the clipboard.
//!
//! Copy drags are staged through hard links (or copies) so a target can never
//! touch the user's original file.

use std::sync::Arc;

use crate::app::App;
use crate::fsx;
use crate::ids::now_ms;
use crate::items;
use crate::logger::LOGGER;
use crate::paths;
use crate::types::{ItemType, UiCommand};

const COPY_STAGE_LIMIT: u64 = 64 * 1024 * 1024;
const FOLDER_STAGE_LIMIT: u64 = 256 * 1024 * 1024;

/// Optional line trace for drag diagnostics, written to the log folder by
/// default so a manual test always leaves evidence behind.
pub(crate) fn trace(line: &str) {
    use std::io::Write;
    use std::sync::OnceLock;
    static PATH: OnceLock<std::path::PathBuf> = OnceLock::new();
    let path = PATH.get_or_init(|| match std::env::var("FLOWTRAY_DRAG_TRACE") {
        Ok(value) if !value.trim().is_empty() => std::path::PathBuf::from(value),
        _ => crate::paths::logs_dir().join("drag-trace.log"),
    });
    let _ = std::fs::create_dir_all(crate::paths::logs_dir());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let stamp = crate::ids::now_ms();
        let _ = writeln!(file, "{stamp} {line}");
    }
}

/// Returns true when the inversion key was held during the drop.
fn modifier_inverted(modifier: &str, keys: i32) -> bool {
    let flag = match modifier {
        "shift" => windows::Win32::System::SystemServices::MK_SHIFT.0,
        "alt" => {
            if unsafe {
                windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
                    windows::Win32::UI::Input::KeyboardAndMouse::VK_MENU.0 as i32,
                ) as u16
                    & 0x8000
                    != 0
            } {
                return true;
            }
            0
        }
        _ => windows::Win32::System::SystemServices::MK_CONTROL.0,
    };
    keys & flag as i32 != 0
}

struct Preparation {
    files: Vec<String>,
    staging: Option<std::path::PathBuf>,
    warnings: Vec<String>,
}

fn prepare(app: &Arc<App>, ids: &[String], effect: &str) -> Preparation {
    let settings = app.settings();
    let rows = app.query(|ctx| items::get_file_like_rows(ctx, ids));
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let stage_copy = effect == "copy" && settings.safe_drag_copy;
    let staging_root = if stage_copy {
        let root = paths::drag_cache_dir()
            .join(format!("batch-{}-{}", now_ms(), crate::ids::create_id("")));
        let _ = fsx::ensure_dir(&root);
        Some(root)
    } else {
        None
    };

    for row in rows {
        let Some(source) = app.query(|ctx| items::resolve_item_path(ctx, &row)) else {
            continue;
        };
        if !fsx::path_exists(&source) {
            continue;
        }
        if !stage_copy {
            files.push(fsx::path_display(&source));
            continue;
        }
        let Some(staging_root) = staging_root.as_ref() else {
            files.push(fsx::path_display(&source));
            continue;
        };
        let is_directory = row.item_type() == ItemType::Folder;
        let destination = fsx::unique_destination(staging_root, &row.name);
        let staged = if is_directory {
            match fsx::directory_size(&source) {
                size if size <= FOLDER_STAGE_LIMIT => {
                    fsx::copy_path(&source, &destination, true).is_ok()
                }
                _ => false,
            }
        } else {
            match std::fs::hard_link(&source, &destination) {
                Ok(()) => true,
                Err(_) => match std::fs::metadata(&source) {
                    Ok(metadata) if metadata.len() <= COPY_STAGE_LIMIT => {
                        std::fs::copy(&source, &destination).is_ok()
                    }
                    _ => false,
                },
            }
        };
        if staged {
            files.push(fsx::path_display(&destination));
        } else {
            files.push(fsx::path_display(&source));
            warnings.push(if is_directory {
                format!("「{}」较大，已按原路径拖出。", row.name)
            } else {
                format!(
                    "「{}」超过 64 MB 且无法创建安全副本，已按原路径拖出。",
                    row.name
                )
            });
        }
    }

    Preparation {
        files,
        staging: staging_root,
        warnings,
    }
}




pub fn start(app: Arc<App>, ids: Vec<String>, effect: String) {
    let effect = if effect == "cut" { "cut" } else { "copy" }.to_string();
    if app
        .drag_active
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        LOGGER.info("drag.busy", None);
        return;
    }
    app.send_command(UiCommand::DragOutStart {
        effect: effect.clone(),
        count: ids.len(),
    });
    let hwnd = app
        .shelf_window()
        .and_then(|window| window.hwnd().ok())
        .map(|handle| handle.0 as isize)
        .unwrap_or(0);
    if hwnd == 0 {
        app.drag_active
            .store(false, std::sync::atomic::Ordering::SeqCst);
        app.toast("error", "拖出失败，请改用复制，或稍后重试。");
        return;
    }
    if ids.len() >= items::BULK_HINT {
        app.toast(
            "info",
            &format!("正在拖出 {} 项，松手放到目标应用即可。", ids.len()),
        );
    }
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let finish = |app: &Arc<App>, message: Option<(&str, String)>| {
            if let Some((tone, message)) = message {
                app.toast(tone, message);
            }
            app.send_command(UiCommand::DragOutEnd {
                effect: effect.clone(),
                count: ids.len(),
            });
            app.drag_active
                .store(false, std::sync::atomic::Ordering::SeqCst);
        };
        let preparation = prepare(&app_clone, &ids, &effect);
        if preparation.files.is_empty() {
            finish(&app_clone, Some(("error", "文件已失效或不可访问，无法拖出。".into())));
            return;
        }
        if let Some(staging) = preparation.staging {
            app_clone.remember_staging(staging);
        }
        if let Some(warning) = preparation.warnings.first() {
            app_clone.toast("info", warning.clone());
        }

        // Real system drag: `DoDragDrop` on the shelf window's own thread, so the
        // OLE loop owns the mouse capture and WeChat/Explorer accept the files.
        let outcome = crate::drag_native::start(
            &app_clone,
            hwnd,
            preparation.files.clone(),
            &effect,
        );
        match outcome {
            Some(result) if result.ok => {
                let moved = (result.effect & 0x2) != 0;
                let settings = app_clone.settings();
                let inverted = modifier_inverted(settings.drag_modifier.as_str(), result.modifiers);
                let should_remove = settings.drag_out_auto_remove != inverted;
                LOGGER.info(
                    "drag.finished",
                    Some(serde_json::json!({
                        "effect": effect,
                        "result": result.effect,
                        "moved": moved,
                        "inverted": inverted,
                        "remove": should_remove,
                    })),
                );
                if should_remove {
                    std::thread::sleep(std::time::Duration::from_millis(650));
                    let ids_for_move = ids.clone();
                    let removed = app_clone.mutate(|ctx| items::mark_moved_out(ctx, &ids_for_move));
                    if removed > 0 {
                        app_clone.toast("success", format!("已从流转台移除 {removed} 项。"));
                    }
                }
                finish(&app_clone, None);
            }
            Some(result) => {
                LOGGER.warn(
                    "drag.cancelled",
                    Some(serde_json::json!({ "effect": result.effect })),
                );
                finish(&app_clone, Some(("info", "已取消拖出。".into())));
            }
            None => {
                // The native session never finished (see `drag.abort_failed` in
                // the log). Still deliver something: a drop on the desktop is
                // copied straight into the desktop folder, everything else goes
                // to the clipboard so the user can paste it.
                if let Some((folder, label)) = crate::drag_landing::landing_folder() {
                    let (copied, _errors) =
                        crate::drag_landing::copy_into(&folder, &preparation.files, false);
                    if copied > 0 {
                        LOGGER.info("drag.delivered_fallback", None);
                        finish(
                            &app_clone,
                            Some(("success", format!("已把 {copied} 个文件放到{label}。"))),
                        );
                        return;
                    }
                }
                let copied = crate::clipboard::copy_selection(&app_clone, &ids, "files");
                crate::clipboard::mark_self_write(&app_clone);
                if copied.ok {
                    finish(
                        &app_clone,
                        Some((
                            "info",
                            "拖拽会话没有完成，已把文件放入剪贴板：按 Ctrl+V 粘贴。".into(),
                        )),
                    );
                } else {
                    finish(
                        &app_clone,
                        Some(("error", "拖出失败，请使用卡片上的「复制」后粘贴。".into())),
                    );
                }
            }
        }
    });
}
