//! Edge reveal: pointer polling (no global hook) shows a thin handle in the
//! outer quarter of the screen and expands the shelf when the pointer rests on
//! the edge. Polling keeps working during native OLE drags.

use std::sync::Arc;

use crate::app::App;
use crate::ids::now_ms;
use crate::winapi;

pub fn spawn(app: Arc<App>) {
    // The polling loop must never run on the caller's (event-loop) thread.
    std::thread::spawn(move || run(app));
}

fn run(app: Arc<App>) {
    let mut dwell_started_at = 0i64;
    let mut armed = true;
    let mut last_reveal_at = 0i64;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if app.is_quitting() {
            break;
        }
        if app
            .edge_rearm
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            armed = true;
            last_reveal_at = 0;
        }
        let settings = app.settings();
        if !settings.edge_reveal {
            dwell_started_at = 0;
            if app.is_peeking() {
                app.hide_peek();
            }
            continue;
        }
        if app.is_full_visible() {
            dwell_started_at = 0;
            armed = false;
            if app.is_peeking() {
                app.hide_peek();
            }
            continue;
        }
        let (x, y) = winapi::cursor_position();
        let work = winapi::work_area_for(x, y);
        let edge_x = if settings.shelf_side == "right" {
            work.right - 1
        } else {
            work.left
        };
        let distance = (x - edge_x).abs();
        let quarter = (((work.right - work.left) as f64) * 0.25).max(120.0) as i32;
        let in_range = y >= work.top && y <= work.bottom;
        let near_edge = distance <= quarter && in_range;
        if !near_edge {
            dwell_started_at = 0;
            if app.is_peeking() {
                app.hide_peek();
            }
            if distance > 80 {
                armed = true;
            }
            continue;
        }
        if !app.is_peeking() {
            app.show_peek();
        }
        if distance > 4 {
            dwell_started_at = 0;
            continue;
        }
        if !armed {
            continue;
        }
        let now = now_ms();
        if now - last_reveal_at < 900 {
            continue;
        }
        if dwell_started_at == 0 {
            dwell_started_at = now;
            continue;
        }
        if now - dwell_started_at >= settings.edge_delay_ms {
            dwell_started_at = 0;
            armed = false;
            last_reveal_at = now;
            app.show_shelf("edge", true);
        }
    }
}

pub fn rearm(app: &Arc<App>) {
    app.edge_rearm
        .store(true, std::sync::atomic::Ordering::SeqCst);
}
