//! Minimal structured logger: JSON lines, size rotation, redacted payloads.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::ids::now_ms;
use crate::redact::redact_value;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 10,
    Info = 20,
    Warn = 30,
    Error = 40,
}

impl Level {
    fn label(&self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

pub struct Logger {
    file: Mutex<Option<PathBuf>>,
    level: AtomicU8,
}

impl Logger {
    pub const fn new() -> Logger {
        Logger {
            file: Mutex::new(None),
            level: AtomicU8::new(Level::Info as u8),
        }
    }

    pub fn init(&self, directory: &Path, level: Level) {
        self.set_level(level);
        let _ = fs::create_dir_all(directory);
        let file = directory.join("main.log");
        self.rotate_if_needed(&file);
        *self.file.lock().unwrap() = Some(file);
    }

    pub fn set_level(&self, level: Level) {
        self.level.store(level as u8, Ordering::Relaxed);
    }

    pub fn level(&self) -> Level {
        match self.level.load(Ordering::Relaxed) {
            10 => Level::Debug,
            30 => Level::Warn,
            40 => Level::Error,
            _ => Level::Info,
        }
    }

    pub fn path(&self) -> Option<PathBuf> {
        self.file.lock().unwrap().clone()
    }

    fn rotate_if_needed(&self, file: &Path) {
        if let Ok(meta) = fs::metadata(file) {
            if meta.len() >= MAX_LOG_BYTES {
                let backup = file.with_extension("log.1");
                let _ = fs::remove_file(&backup);
                let _ = fs::rename(file, backup);
            }
        }
    }

    pub fn log(&self, level: Level, event: &str, data: Option<Value>) {
        if level < self.level() {
            return;
        }
        let mut payload = json!({
            "ts": now_ms(),
            "level": level.label(),
            "event": event,
        });
        if let Some(value) = data {
            payload["data"] = redact_value(&value, 0);
        }
        let line = format!("{}\n", payload);
        let file = self.file.lock().unwrap().clone();
        match file {
            Some(path) => {
                if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(&path) {
                    let _ = handle.write_all(line.as_bytes());
                }
            }
            None => {
                #[cfg(debug_assertions)]
                eprint!("{line}");
            }
        }
    }

    pub fn debug(&self, event: &str, data: Option<Value>) {
        self.log(Level::Debug, event, data);
    }

    pub fn info(&self, event: &str, data: Option<Value>) {
        self.log(Level::Info, event, data);
    }

    pub fn warn(&self, event: &str, data: Option<Value>) {
        self.log(Level::Warn, event, data);
    }

    pub fn error(&self, event: &str, data: Option<Value>) {
        self.log(Level::Error, event, data);
    }
}

pub static LOGGER: Logger = Logger::new();
