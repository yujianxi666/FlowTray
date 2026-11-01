//! Background lifecycle: expiry sweeps, missing-file verification, trash purge,
//! drag-cache cleanup and the clipboard monitor loop.

use std::sync::Arc;

use crate::actions;
use crate::app::App;
use crate::clipboard;
use crate::fsx;
use crate::ids::now_ms;
use crate::items;
use crate::logger::LOGGER;
use crate::paths;
use crate::types::TRASH_RETENTION_MS;

pub fn boot(app: &Arc<App>) {
    app.mutate(|ctx| ctx.ensure_layout());
    let (missing, recovered) = app.query(|ctx| items::verify(ctx));
    if missing > 0 || recovered > 0 {
        LOGGER.info(
            "lifecycle.startup_verify",
            Some(serde_json::json!({ "missing": missing, "recovered": recovered })),
        );
    }
    let outcome = {
        let mut notified = app.notified.lock();
        app.query(|ctx| items::sweep_expired(ctx, now_ms(), &mut notified))
    };
    if outcome.expired > 0 {
        actions::handle_expired(app, outcome.ids);
    }
    app.mutate(|ctx| items::purge_trash(ctx, now_ms() - TRASH_RETENTION_MS));
    cleanup_drag_cache();
    app.schedule_broadcast();
}

pub fn spawn(app: Arc<App>) {
    std::thread::spawn(move || {
        let mut last_verify = now_ms();
        let mut last_purge = now_ms();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if app.is_quitting() {
                break;
            }
            tick(&app, &mut last_verify, &mut last_purge);
        }
    });
}

fn tick(app: &Arc<App>, last_verify: &mut i64, last_purge: &mut i64) {
    let now = now_ms();
    let outcome = {
        let mut notified = app.notified.lock();
        app.query(|ctx| items::sweep_expired(ctx, now, &mut notified))
    };
    if outcome.expired > 0 {
        actions::handle_expired(app, outcome.ids);
    }
    if outcome.remind > 0 {
        actions::handle_remind(app, outcome.remind);
    }
    if now - *last_verify > 3 * 60_000 {
        app.query(|ctx| items::verify(ctx));
        *last_verify = now;
    }
    if now - *last_purge > 60 * 60_000 {
        app.mutate(|ctx| items::purge_trash(ctx, now - TRASH_RETENTION_MS));
        cleanup_drag_cache();
        *last_purge = now;
    }
    if outcome.expired > 0 || outcome.remind > 0 {
        app.schedule_broadcast();
    }
}

pub fn cleanup_drag_cache() {
    let root = paths::drag_cache_dir();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let cutoff = now_ms() - 48 * 60 * 60 * 1000;
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        if modified < cutoff {
            fsx::remove_path(&entry.path());
        }
    }
}

pub fn spawn_clipboard_monitor(app: Arc<App>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(700));
        if app.is_quitting() {
            break;
        }
        if !app.clipboard.lock().monitoring {
            continue;
        }
        clipboard::tick_monitor(&app);
    });
}
