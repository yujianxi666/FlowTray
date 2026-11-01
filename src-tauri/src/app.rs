//! Central application state: database handle, settings snapshot, undo slot,
//! window mode bookkeeping and the snapshot broadcaster that pushes state into
//! the React renderer.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, OnceLock};

use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::db;
use crate::ids::{create_id, now_ms};
use crate::items::{self, ItemContext};
use crate::logger::LOGGER;
use crate::paths;
use crate::settings::Settings;
use crate::shortcuts::HotkeyHandle;
use crate::types::*;

pub const UNDO_CLEAR_MS: i64 = 30_000;
pub const UNDO_DELETE_MS: i64 = 10_000;
pub const UNDO_EXPIRY_MS: i64 = 60_000;

#[derive(Debug, Clone)]
pub struct UndoEntry {
    pub kind: String,
    pub ids: Vec<String>,
    pub state: UndoState,
}

#[derive(Debug, Default)]
pub struct ClipboardState {
    pub monitoring: bool,
    pub last_fingerprint: String,
    pub suppress_until: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowMode {
    Hidden,
    Full,
    Peek,
}

impl WindowMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            WindowMode::Hidden => "hidden",
            WindowMode::Full => "full",
            WindowMode::Peek => "peek",
        }
    }
}

#[derive(Debug)]
pub struct WindowState {
    pub mode: WindowMode,
    /// Last geometry applied to the native window (logical x, y, w, h).
    pub geom: Option<(f64, f64, f64, f64)>,
    /// Current window flags, so repeated shows do not churn Win32 styles.
    pub ignore_cursor: bool,
    pub topmost: bool,
    pub last_show_at: i64,
    pub last_focus_at: i64,
    pub last_blur_at: i64,
    pub edge_grace_until: i64,
    pub interaction_locked: bool,
    pub interaction_locked_at: i64,
    pub shown_focused: bool,
    /// True once the window actually received focus since it was last shown.
    pub had_focus: bool,
    pub peeking: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        WindowState {
            mode: WindowMode::Hidden,
            geom: None,
            ignore_cursor: false,
            topmost: true,
            last_show_at: 0,
            last_focus_at: 0,
            last_blur_at: 0,
            edge_grace_until: 0,
            interaction_locked: false,
            interaction_locked_at: 0,
            shown_focused: false,
            had_focus: false,
            peeking: false,
        }
    }
}

pub struct App {
    pub db: Mutex<Connection>,
    pub db_path: PathBuf,
    pub settings: RwLock<Settings>,
    pub undo: Mutex<Option<UndoEntry>>,
    pub revision: AtomicU64,
    pub handle: OnceLock<AppHandle>,
    pub elevated: AtomicBool,
    pub autostart_warning: Mutex<Option<String>>,
    pub hotkeys: Mutex<HotkeyPair>,
    pub hotkeys_service: Mutex<Option<HotkeyHandle>>,
    pub notified: Mutex<HashSet<String>>,
    pub broadcast_tx: Mutex<Option<Sender<()>>>,
    pub clipboard: Mutex<ClipboardState>,
    pub window: Mutex<WindowState>,
    /// Set when the shelf was hidden so the edge poller may reveal it again.
    pub edge_rearm: Arc<AtomicBool>,
    /// Hide request generation: non-zero while a hide animation is in flight.
    pub pending_hide: Arc<AtomicU64>,
    pub quitting: AtomicBool,
    /// True while an OLE drag-out loop is running; only one may exist at a time.
    pub drag_active: AtomicBool,
    pub drag_staging: Mutex<Vec<PathBuf>>,
    pub storage_warning: Mutex<Option<String>>,
    pub booted_at: i64,
}

impl App {
    pub fn new(db_path: PathBuf) -> Arc<App> {
        let db_path = db_path;
        let connection = open_database(&db_path);
        let settings = load_settings(&connection);
        db::persist_settings(&connection, &settings);
        let app = Arc::new(App {
            db: Mutex::new(connection),
            db_path,
            settings: RwLock::new(settings),
            undo: Mutex::new(None),
            revision: AtomicU64::new(0),
            handle: OnceLock::new(),
            elevated: AtomicBool::new(false),
            autostart_warning: Mutex::new(None),
            hotkeys: Mutex::new(HotkeyPair {
                toggle: HotkeyStatus::default(),
                capture: HotkeyStatus::default(),
            }),
            hotkeys_service: Mutex::new(None),
            notified: Mutex::new(HashSet::new()),
            broadcast_tx: Mutex::new(None),
            clipboard: Mutex::new(ClipboardState::default()),
            window: Mutex::new(WindowState::default()),
            edge_rearm: Arc::new(AtomicBool::new(false)),
            pending_hide: Arc::new(AtomicU64::new(0)),
            quitting: AtomicBool::new(false),
            drag_active: AtomicBool::new(false),
            drag_staging: Mutex::new(Vec::new()),
            storage_warning: Mutex::new(None),
            booted_at: now_ms(),
        });
        app
    }

    pub fn attach(&self, handle: AppHandle) {
        let _ = self.handle.set(handle);
    }

    pub fn handle(&self) -> Option<&AppHandle> {
        self.handle.get()
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().clone()
    }

    /// Run an item operation against a locked connection plus the current
    /// settings snapshot, then queue a renderer broadcast.
    pub fn mutate<T>(&self, action: impl FnOnce(&ItemContext<'_>) -> T) -> T {
        let result = {
            let settings = self.settings.read().clone();
            let connection = self.db.lock();
            let ctx = ItemContext::new(&connection, &settings);
            action(&ctx)
        };
        self.schedule_broadcast();
        result
    }

    /// Same as [`App::mutate`] but without queueing a broadcast.
    pub fn query<T>(&self, action: impl FnOnce(&ItemContext<'_>) -> T) -> T {
        let settings = self.settings.read().clone();
        let connection = self.db.lock();
        let ctx = ItemContext::new(&connection, &settings);
        action(&ctx)
    }

    pub fn schedule_broadcast(&self) {
        if let Some(tx) = self.broadcast_tx.lock().as_ref() {
            let _ = tx.send(());
        }
    }

    pub fn send_command(&self, command: UiCommand) {
        if let Some(handle) = self.handle() {
            let _ = handle.emit_to("shelf", "evt:command", command);
        }
    }

    pub fn toast(&self, tone: &str, message: impl Into<String>) {
        self.send_command(UiCommand::Toast {
            tone: tone.to_string(),
            message: message.into(),
        });
    }

    pub fn broadcast_snapshot(self: &Arc<Self>) {
        let snapshot = self.snapshot();
        if let Some(handle) = self.handle() {
            let _ = handle.emit_to("shelf", "evt:snapshot", &snapshot);
            // Menus and tooltips must be touched from the event-loop thread, but
            // the usage numbers come from the snapshot we just built: a second
            // database query on the UI thread is what blocked it during file
            // copies and made the window look frozen.
            let app = self.clone();
            let usage = snapshot.usage.clone();
            let _ = handle.run_on_main_thread(move || crate::tray::refresh_with(&app, &usage));
        }
    }

    pub fn snapshot(&self) -> ShelfSnapshot {
        let now = now_ms();
        let settings = self.settings();
        let usage = self.query(|ctx| items::usage(ctx));
        let item_views = self.query(|ctx| items::get_items(ctx, now));
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let handle = self.handle();
        let version = handle
            .map(|value| value.package_info().version.to_string())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        let runtime_version = tauri::webview_version().unwrap_or_else(|_| "WebView2".to_string());
        let host = HostInfo {
            version,
            runtime_version,
            platform: std::env::consts::OS.to_string(),
            is_packaged: !cfg!(debug_assertions),
            is_elevated: self.elevated.load(Ordering::Relaxed),
            supports_acrylic: cfg!(windows),
            data_path: paths::user_data_dir().to_string_lossy().to_string(),
            storage_path: paths::resolve_storage_root(&settings.storage_dir)
                .to_string_lossy()
                .to_string(),
            logs_path: paths::logs_dir().to_string_lossy().to_string(),
            autostart_warning: self.autostart_warning.lock().clone(),
            hotkeys: self.hotkeys.lock().clone(),
        };
        ShelfSnapshot {
            revision,
            items: item_views,
            settings,
            usage,
            host,
            undo: self.undo_state(now),
            now,
        }
    }

    pub fn undo_state(&self, now: i64) -> Option<UndoState> {
        let guard = self.undo.lock();
        let entry = guard.as_ref()?;
        if entry.state.expires_at <= now {
            return None;
        }
        Some(entry.state.clone())
    }

    pub fn set_undo(&self, kind: &str, ids: Vec<String>) {
        if ids.is_empty() {
            return;
        }
        let window = match kind {
            "clear" => UNDO_CLEAR_MS,
            "delete" => UNDO_DELETE_MS,
            _ => UNDO_EXPIRY_MS,
        };
        let label_prefix = match kind {
            "clear" => "已清空",
            "delete" => "已删除",
            _ => "到期清理",
        };
        let now = now_ms();
        let state = UndoState {
            kind: kind.to_string(),
            count: ids.len(),
            expires_at: now + window,
            label: format!("{label_prefix} {} 项", ids.len()),
        };
        *self.undo.lock() = Some(UndoEntry {
            kind: kind.to_string(),
            ids,
            state,
        });
        self.schedule_broadcast();
    }

    pub fn take_undo(&self) -> Option<UndoEntry> {
        let mut guard = self.undo.lock();
        let entry = guard.take()?;
        if entry.state.expires_at <= now_ms() {
            return None;
        }
        Some(entry)
    }

    pub fn clear_undo(&self) {
        *self.undo.lock() = None;
    }

    pub fn set_settings(&self, settings: Settings) {
        db::persist_settings(&self.db.lock(), &settings);
        *self.settings.write() = settings;
    }

    pub fn set_storage_dir(&self, directory: String) {
        let mut settings = self.settings.write();
        settings.storage_dir = directory;
        db::persist_settings(&self.db.lock(), &settings);
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Relaxed)
    }

    pub fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::Relaxed);
    }

    pub fn meta_flag(&self, key: &str) -> bool {
        let connection = self.db.lock();
        db::meta_flag(&connection, key)
    }

    pub fn set_meta_flag(&self, key: &str, value: bool) {
        let connection = self.db.lock();
        db::set_meta_flag(&connection, key, value);
    }

    pub fn storage_root(&self) -> PathBuf {
        paths::resolve_storage_root(&self.settings().storage_dir)
    }

    pub fn files_root(&self) -> PathBuf {
        self.storage_root().join("files")
    }

    pub fn thumbs_root(&self) -> PathBuf {
        self.storage_root().join("thumbs")
    }

    /// Track staged drag copies so they can be cleaned after the drag finishes.
    pub fn remember_staging(&self, path: PathBuf) {
        self.drag_staging.lock().push(path);
    }

    pub fn take_staging(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.drag_staging.lock())
    }
}

fn open_database(path: &Path) -> Connection {
    match db::open(path) {
        Ok(connection) => connection,
        Err(error) => {
            LOGGER.error(
                "database.open_failed",
                Some(serde_json::json!({ "error": error.to_string() })),
            );
            let backup = path.with_extension(format!("db.corrupt-{}", now_ms()));
            let _ = std::fs::rename(path, &backup);
            for suffix in ["-wal", "-shm"] {
                let sidecar = PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix));
                let _ = std::fs::rename(&sidecar, PathBuf::from(format!(
                    "{}{}",
                    backup.to_string_lossy(),
                    suffix
                )));
            }
            db::open(path).unwrap_or_else(|fallback_error| {
                LOGGER.error(
                    "database.recreate_failed",
                    Some(serde_json::json!({ "error": fallback_error.to_string() })),
                );
                panic!("FlowTray 无法创建数据库: {fallback_error}");
            })
        }
    }
}

fn load_settings(connection: &Connection) -> Settings {
    let rows = db::load_settings_rows(connection);
    let defaults = Settings::default();
    let mut value = serde_json::to_value(&defaults).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(object) = value.as_object_mut() {
        for (key, entry) in rows {
            object.insert(key, entry);
        }
    }
    let mut settings: Settings = serde_json::from_value(value).unwrap_or(defaults);
    // Migration: pure-modifier defaults could never be registered by Windows.
    if !db::meta_flag(connection, "hotkey_default_v2") {
        if matches!(
            settings.hotkey_toggle.as_str(),
            "Control+Shift+Space" | "Control+Alt+Space"
        ) {
            settings.hotkey_toggle = Settings::default().hotkey_toggle;
        }
        db::set_meta_flag(connection, "hotkey_default_v2", true);
    }
    settings.normalize();
    settings
}

pub fn new_id(prefix: &str) -> String {
    create_id(prefix)
}
