//! Shelf window geometry and visibility.
//!
//! The shelf is a frameless, transparent, always-on-top window docked to a
//! screen edge. Peek mode reuses the same window at 32x180 so the app never pays
//! for a second renderer.
//!
//! All geometry is exchanged with Tauri in *logical* pixels; monitor and cursor
//! measurements come from Win32 in physical pixels and are converted with the
//! window's DPI scale factor.

use std::sync::Arc;

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::app::{App, WindowMode};
use crate::ids::now_ms;
use crate::types::UiCommand;
use crate::winapi;

pub const PEEK_WIDTH: f64 = 32.0;
pub const PEEK_HEIGHT: f64 = 180.0;
pub const HIDE_ANIMATION_MS: u64 = 200;

pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl App {
    pub fn shelf_window(&self) -> Option<WebviewWindow> {
        self.handle()?.get_webview_window("shelf")
    }

    fn scale_factor(window: &WebviewWindow) -> f64 {
        let value = window.scale_factor().unwrap_or(1.0);
        if value.is_finite() && value > 0.0 {
            value
        } else {
            1.0
        }
    }

    fn clamp_card_width(value: i64) -> f64 {
        value.clamp(340, 560) as f64
    }

    fn clamp_card_height(value: i64, work_height: f64) -> f64 {
        let max = (work_height - 32.0).max(480.0).min(1000.0);
        (value as f64).clamp(480.0, max)
    }

    /// Work area of the monitor that contains the cursor, in logical pixels.
    fn work_area_logical(window: &WebviewWindow) -> (f64, f64, f64, f64) {
        let scale = Self::scale_factor(window);
        let (cursor_x, cursor_y) = winapi::cursor_position();
        let work = winapi::work_area_for(cursor_x, cursor_y);
        (
            work.left as f64 / scale,
            work.top as f64 / scale,
            (work.right - work.left) as f64 / scale,
            (work.bottom - work.top) as f64 / scale,
        )
    }

    fn geometry_for(&self, window: &WebviewWindow, card_width: i64, card_height: i64) -> Geometry {
        let settings = self.settings();
        let (work_x, work_y, work_w, work_h) = Self::work_area_logical(window);
        let height = Self::clamp_card_height(card_height, work_h);
        let width = Self::clamp_card_width(card_width);
        let x = if settings.shelf_side == "right" {
            work_x + work_w - width
        } else {
            work_x
        };
        let y = work_y + ((work_h - height) / 2.0).max(8.0);
        Geometry {
            x,
            y,
            width,
            height,
        }
    }

    pub fn card_size(&self) -> (i64, i64) {
        let settings = self.settings();
        match self.shelf_window() {
            Some(window) => match window.inner_size() {
                Ok(size) if size.width > 80 => {
                    let scale = Self::scale_factor(&window);
                    (
                        Self::clamp_card_width((size.width as f64 / scale).round() as i64) as i64,
                        Self::clamp_card_height(
                            (size.height as f64 / scale).round() as i64,
                            Self::work_area_logical(&window).3,
                        ) as i64,
                    )
                }
                _ => (settings.shelf_width, settings.shelf_height),
            },
            None => (settings.shelf_width, settings.shelf_height),
        }
    }

    pub fn position_and_size(&self, window: &WebviewWindow) {
        let settings = self.settings();
        let geometry = self.geometry_for(window, settings.shelf_width, settings.shelf_height);
        self.apply_geometry(window, &geometry);
    }

    /// Applies geometry only when it actually changed. Every redundant
    /// `set_size`/`set_position` triggers a Win32 layout pass and re-composite,
    /// which is what makes repeated shows feel jumpy.
    fn apply_geometry(&self, window: &WebviewWindow, geometry: &Geometry) {
        let next = (
            geometry.x.round(),
            geometry.y.round(),
            geometry.width.round(),
            geometry.height.round(),
        );
        let mut state = self.window.lock();
        if state.geom == Some(next) {
            return;
        }
        state.geom = Some(next);
        drop(state);
        let _ = window.set_size(LogicalSize::new(geometry.width, geometry.height));
        let _ = window.set_position(LogicalPosition::new(geometry.x, geometry.y));
    }

    fn set_ignore_cursor(&self, window: &WebviewWindow, ignore: bool) {
        let mut state = self.window.lock();
        if state.ignore_cursor == ignore {
            return;
        }
        state.ignore_cursor = ignore;
        drop(state);
        let _ = window.set_ignore_cursor_events(ignore);
    }

    fn set_topmost(&self, window: &WebviewWindow, topmost: bool) {
        let mut state = self.window.lock();
        if state.topmost == topmost {
            return;
        }
        state.topmost = topmost;
        drop(state);
        let _ = window.set_always_on_top(topmost);
    }

    pub fn is_full_visible(&self) -> bool {
        let state = self.window.lock();
        state.mode == WindowMode::Full
            && self
                .shelf_window()
                .map(|window| window.is_visible().unwrap_or(false))
                .unwrap_or(false)
    }

    pub fn is_peeking(&self) -> bool {
        let state = self.window.lock();
        state.peeking && state.mode == WindowMode::Peek
    }

    pub fn is_visible(&self) -> bool {
        // The native window may already be shown while parked off-screen for the
        // first WebView2 composite pass; only the logical mode counts here.
        if self.window.lock().mode == WindowMode::Hidden {
            return false;
        }
        self.shelf_window()
            .map(|window| window.is_visible().unwrap_or(false))
            .unwrap_or(false)
    }

    pub fn show_shelf(self: &Arc<Self>, reason: &str, focus: bool) {
        let Some(window) = self.shelf_window() else {
            crate::logger::LOGGER.warn("shelf.show.no_window", None);
            return;
        };
        let settings = self.settings();
        // Any pending hide animation is superseded.
        self.pending_hide.store(0, std::sync::atomic::Ordering::SeqCst);
        let was_peeking = self.is_peeking();
        if was_peeking {
            // Resize while invisible so the shelf does not visibly stretch from
            // the 32px peek strip to the full card.
            let _ = window.hide();
        }
        self.set_ignore_cursor(&window, false);
        self.set_topmost(&window, settings.always_on_top);
        self.position_and_size(&window);
        {
            let mut state = self.window.lock();
            state.mode = WindowMode::Full;
            state.peeking = false;
            state.edge_grace_until = if reason == "edge" {
                now_ms() + 2500
            } else {
                0
            };
            state.shown_focused = focus;
            state.had_focus = false;
            state.last_show_at = now_ms();
            if focus {
                state.last_focus_at = now_ms();
            }
        }
        // Show first, then let the renderer animate in: the webview keeps the
        // content invisible until the window is composited, so the first visible
        // frame is the start of the animation instead of a flash.
        let _ = window.show();
        // The WebView2 child does not follow a resize that happened while the
        // window was hidden (peek strip -> full shelf). Without re-applying the
        // geometry after `show` the UI stays painted inside the old 32x180 strip
        // and the shelf looks completely empty.
        {
            self.window.lock().geom = None;
        }
        self.position_and_size(&window);
        if focus {
            let _ = window.set_focus();
            let _ = window.unminimize();
        }
        if settings.always_on_top {
            raise_window(&window);
        }
        self.send_command(UiCommand::WindowShown {
            reason: reason.to_string(),
        });
        self.schedule_broadcast();
    }

    pub fn hide_shelf(&self) {
        let Some(window) = self.shelf_window() else {
            crate::logger::LOGGER.warn("shelf.hide.no_window", None);
            return;
        };
        crate::logger::LOGGER.info(
            "shelf.hide",
            Some(serde_json::json!({
                "visible": window.is_visible().unwrap_or(false),
                "mode": format!("{:?}", self.window.lock().mode),
            })),
        );
        let mode = self.window.lock().mode;
        if mode == WindowMode::Peek {
            self.hide_peek();
            return;
        }
        if !window.is_visible().unwrap_or(false) {
            return;
        }
        self.send_command(UiCommand::WindowWillHide);
        {
            let mut state = self.window.lock();
            state.mode = WindowMode::Hidden;
            state.shown_focused = false;
            state.peeking = false;
        }
        // The renderer plays the leave animation and calls `window_hide_ready`
        // when it finishes; the timer is only a safety net for a stuck webview.
        let epoch = self
            .pending_hide
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let pending = self.pending_hide.clone();
        self.edge_rearm
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let handle = self.handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(HIDE_ANIMATION_MS + 160));
            if pending
                .compare_exchange(
                    epoch,
                    0,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_err()
            {
                return;
            }
            if let Some(app_handle) = handle.get() {
                if let Some(window) = app_handle.get_webview_window("shelf") {
                    let result = window.hide();
                    crate::logger::LOGGER.info(
                        "shelf.hide.timer",
                        Some(serde_json::json!({ "ok": result.is_ok() })),
                    );
                }
            }
        });
    }

    /// Called by the renderer once the leave animation finished.
    pub fn hide_ready(&self) {
        if self
            .pending_hide
            .swap(0, std::sync::atomic::Ordering::SeqCst)
            == 0
        {
            return;
        }
        if let Some(window) = self.shelf_window() {
            let result = window.hide();
            crate::logger::LOGGER.info(
                "shelf.hide.ready",
                Some(serde_json::json!({ "ok": result.is_ok() })),
            );
        }
    }

    pub fn toggle_shelf(self: &Arc<Self>) {
        if self.is_full_visible() {
            self.hide_shelf();
        } else {
            self.show_shelf("hotkey", true);
        }
    }

    pub fn show_peek(&self) {
        let Some(window) = self.shelf_window() else {
            return;
        };
        let settings = self.settings();
        let (work_x, work_y, work_w, work_h) = Self::work_area_logical(&window);
        let scale = Self::scale_factor(&window);
        let _ = scale;
        let height = PEEK_HEIGHT.min((work_h - 24.0).max(120.0));
        let width = PEEK_WIDTH;
        let x = if settings.shelf_side == "right" {
            work_x + work_w - width
        } else {
            work_x
        };
        // Always the vertical centre of the work area: the strip must not chase
        // the cursor, and re-positioning on every pointer move caused stutter.
        let y = work_y + (work_h - height) / 2.0;
        let geometry = Geometry {
            x,
            y,
            width,
            height,
        };
        if self.is_peeking() && window.is_visible().unwrap_or(false) {
            return;
        }
        self.apply_geometry(&window, &geometry);
        self.set_topmost(&window, true);
        self.set_ignore_cursor(&window, true);
        let _ = window.show();
        // Re-apply while visible so the webview actually takes the strip size.
        {
            let mut state = self.window.lock();
            state.geom = None;
        }
        self.apply_geometry(&window, &geometry);
        {
            let mut state = self.window.lock();
            state.mode = WindowMode::Peek;
            state.peeking = true;
        }
    }

    pub fn hide_peek(&self) {
        let Some(window) = self.shelf_window() else {
            return;
        };
        {
            let mut state = self.window.lock();
            if state.mode != WindowMode::Peek {
                return;
            }
            state.mode = WindowMode::Hidden;
            state.peeking = false;
        }
        let _ = window.hide();
        self.set_ignore_cursor(&window, false);
        self.edge_rearm
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn apply_window_settings(&self) {
        let Some(window) = self.shelf_window() else {
            return;
        };
        let settings = self.settings();
        self.set_topmost(&window, settings.always_on_top);
        if self.window.lock().mode == WindowMode::Full {
            // Picking the other screen edge (or a different size) has to move the
            // native window right away; `apply_geometry` dedupes unchanged values.
            self.position_and_size(&window);
        }
    }

    pub fn set_size_live(&self, card_width: i64, card_height: i64) {
        let Some(window) = self.shelf_window() else {
            return;
        };
        if self.window.lock().mode != WindowMode::Full {
            return;
        }
        let geometry = self.geometry_for(&window, card_width, card_height);
        self.apply_geometry(&window, &geometry);
    }

    pub fn commit_window_size(&self) {
        let (width, height) = self.card_size();
        let mut settings = self.settings();
        settings.shelf_width = width;
        settings.shelf_height = height;
        self.set_settings(settings);
        self.schedule_broadcast();
    }

    pub fn set_interaction_locked(&self, locked: bool) {
        let mut state = self.window.lock();
        state.interaction_locked = locked;
        state.interaction_locked_at = if locked { now_ms() } else { 0 };
        if !locked {
            // Just finished a drag/drop: treat it as fresh interaction so the
            // pending blur watchdog does not hide the shelf right after a drop.
            state.last_show_at = now_ms();
        }
    }

    /// Called from the window blur event: hide when the user configured it.
    pub fn handle_blur(self: &Arc<Self>) {
        self.send_command(UiCommand::Blur);
        {
            let mut state = self.window.lock();
            state.last_blur_at = now_ms();
            state.shown_focused = false;
        }
        let settings = self.settings();
        if !settings.hide_on_blur {
            return;
        }
        // A freshly shown window can receive a blur before Windows grants it the
        // foreground (e.g. started from a background process), which would hide it
        // again instantly. Ignore blur for a moment after showing.
        if now_ms() - self.window.lock().last_show_at < 1200 {
            return;
        }
        {
            let state = self.window.lock();
            // A stale lock (drag cancelled without a leave event) expires on its own.
            if state.interaction_locked && now_ms() - state.interaction_locked_at < 8000 {
                return;
            }
        }
        if self.window.lock().mode != WindowMode::Full {
            return;
        }
        let app = self.clone();
        std::thread::spawn(move || {
            // A click on another window keeps the primary button down for a moment,
            // and a file drag keeps it down until the drop. Wait for the release so
            // drags never hide the shelf, then apply the normal hide rules.
            let deadline = now_ms() + 8000;
            while winapi::left_button_down() && now_ms() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            std::thread::sleep(std::time::Duration::from_millis(220));
            {
                let state = app.window.lock();
                let held = state.interaction_locked && now_ms() - state.interaction_locked_at < 8000;
                if held {
                    return;
                }
                if now_ms() - state.last_show_at < 900 {
                    return;
                }
            }
            if !app.settings().hide_on_blur {
                return;
            }
            if let Some(window) = app.shelf_window() {
                if window.is_focused().unwrap_or(false) {
                    return;
                }
            }
            app.hide_shelf();
        });
    }

    pub fn handle_focus(&self) {
        let mut state = self.window.lock();
        state.had_focus = true;
        state.last_focus_at = now_ms();
        state.last_blur_at = 0;
        state.shown_focused = true;
    }

    pub fn show_after_bootstrap(self: &Arc<Self>, force: bool) {
        let settings = self.settings();
        if force || !settings.onboarding_done || settings.open_at_launch {
            self.show_shelf("app", true);
            // Older WebView2 builds did not composite the first programmatic show of
            // a transparent, initially-hidden window. The entrance animation now forces
            // that first frame, so the hide/show workaround is opt-in: set
            // FLOWTRAY_BOOTSTRAP_REPAINT=1 if a machine still shows a blank shelf.
            if std::env::var("FLOWTRAY_BOOTSTRAP_REPAINT").as_deref() == Ok("1") {
                let app = self.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(160));
                    if let Some(window) = app.shelf_window() {
                        let _ = window.hide();
                        std::thread::sleep(std::time::Duration::from_millis(90));
                        app.show_shelf("app", true);
                    }
                });
            }
        }
        if !settings.onboarding_done {
            self.send_command(UiCommand::OpenOnboarding);
        }
    }
}

fn raise_window(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Ok(handle) = window.hwnd() else {
        return;
    };
    unsafe {
        let _ = SetWindowPos(
            HWND(handle.0 as isize as *mut core::ffi::c_void),
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}
