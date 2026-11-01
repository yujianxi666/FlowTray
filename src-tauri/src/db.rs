//! SQLite storage bootstrap. Schema and pragmas intentionally match the
//! previous Electron build so an existing `flowtray.db` keeps working.

use std::path::Path;

use rusqlite::Connection;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  ref_path TEXT,
  stored_rel TEXT,
  thumb_rel TEXT,
  storage_mode TEXT NOT NULL DEFAULT 'reference',
  text_content TEXT,
  html_content TEXT,
  url TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  source_app TEXT,
  source TEXT NOT NULL DEFAULT 'drop',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  hash TEXT,
  identity TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  last_checked_at INTEGER,
  moved_in INTEGER NOT NULL DEFAULT 0,
  original_path TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_sort ON items(sort_order DESC);
CREATE INDEX IF NOT EXISTS idx_items_expires ON items(expires_at);
CREATE INDEX IF NOT EXISTS idx_items_identity ON items(identity);
"#;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let connection = Connection::open(path)?;
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         PRAGMA busy_timeout = 4000;",
    )?;
    connection.execute_batch(SCHEMA)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if version == 0 {
        let _ = connection.execute_batch("PRAGMA user_version = 1");
    }
    Ok(connection)
}

/// Load every `settings` row as a JSON object.
pub fn load_settings_rows(connection: &Connection) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    if let Ok(mut statement) = connection.prepare("SELECT key, value FROM settings") {
        if let Ok(rows) = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&row.1) {
                    map.insert(row.0, value);
                }
            }
        }
    }
    map
}

pub fn persist_settings(connection: &Connection, settings: &crate::settings::Settings) {
    let value = match serde_json::to_value(settings) {
        Ok(value) => value,
        Err(_) => return,
    };
    if let Some(object) = value.as_object() {
        for (key, entry) in object {
            let _ = connection.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, serde_json::to_string(entry).unwrap_or_default()],
            );
        }
    }
}

pub fn meta_flag(connection: &Connection, key: &str) -> bool {
    connection
        .query_row("SELECT value FROM meta WHERE key = ?", [key], |row| {
            row.get::<_, String>(0)
        })
        .map(|value| !value.is_empty() && value != "false")
        .unwrap_or(false)
}

pub fn set_meta_flag(connection: &Connection, key: &str, value: bool) {
    let _ = connection.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, if value { "true" } else { "false" }],
    );
}
