//! Item domain service: ingestion, lifecycle, storage, views.
//!
//! All heavy lifting for the shelf lives here. The functions take a connection
//! plus the current settings snapshot so they stay free of global state and are
//! testable in isolation.

use std::collections::HashSet;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::fsx;
use crate::ids::{create_id, now_ms};
use crate::paths;
use crate::settings::{compute_expires_at, Settings};
use crate::thumbs;
use crate::types::*;

const COLUMNS: &str = "id, type, name, ref_path, stored_rel, thumb_rel, storage_mode, \
text_content, html_content, url, size, source_app, source, created_at, updated_at, \
expires_at, pinned, pinned_at, status, hash, identity, sort_order, deleted_at, \
last_checked_at, moved_in, original_path, meta";

#[derive(Debug, Clone)]
pub struct ItemRow {
    pub id: String,
    pub item_type: String,
    pub name: String,
    pub ref_path: Option<String>,
    pub stored_rel: Option<String>,
    pub thumb_rel: Option<String>,
    pub storage_mode: String,
    pub text_content: Option<String>,
    pub html_content: Option<String>,
    pub url: Option<String>,
    pub size: i64,
    pub source_app: Option<String>,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: Option<i64>,
    pub pinned: bool,
    pub pinned_at: Option<i64>,
    pub status: String,
    pub hash: Option<String>,
    pub identity: String,
    pub sort_order: f64,
    pub deleted_at: Option<i64>,
    pub last_checked_at: Option<i64>,
    pub moved_in: bool,
    pub original_path: Option<String>,
    pub meta: Option<String>,
}

impl ItemRow {
    pub fn item_type(&self) -> ItemType {
        ItemType::parse(&self.item_type)
    }

    pub fn is_file_like(&self) -> bool {
        self.item_type().is_file_like()
    }
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<ItemRow> {
    Ok(ItemRow {
        id: row.get(0)?,
        item_type: row.get(1)?,
        name: row.get(2)?,
        ref_path: row.get(3)?,
        stored_rel: row.get(4)?,
        thumb_rel: row.get(5)?,
        storage_mode: row.get(6)?,
        text_content: row.get(7)?,
        html_content: row.get(8)?,
        url: row.get(9)?,
        size: row.get(10)?,
        source_app: row.get(11)?,
        source: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        expires_at: row.get(15)?,
        pinned: row.get::<_, i64>(16)? != 0,
        pinned_at: row.get(17)?,
        status: row.get(18)?,
        hash: row.get(19)?,
        identity: row.get(20)?,
        sort_order: row.get(21)?,
        deleted_at: row.get(22)?,
        last_checked_at: row.get(23)?,
        moved_in: row.get::<_, i64>(24)? != 0,
        original_path: row.get(25)?,
        meta: row.get(26)?,
    })
}

pub struct ItemContext<'a> {
    pub connection: &'a Connection,
    pub settings: &'a Settings,
}

impl<'a> ItemContext<'a> {
    pub fn new(connection: &'a Connection, settings: &'a Settings) -> ItemContext<'a> {
        ItemContext {
            connection,
            settings,
        }
    }

    pub fn storage_root(&self) -> PathBuf {
        paths::resolve_storage_root(&self.settings.storage_dir)
    }

    pub fn files_root(&self) -> PathBuf {
        self.storage_root().join("files")
    }

    pub fn thumbs_root(&self) -> PathBuf {
        self.storage_root().join("thumbs")
    }

    pub fn ensure_layout(&self) {
        let _ = fsx::ensure_dir(&self.files_root());
        let _ = fsx::ensure_dir(&self.thumbs_root());
    }
}

fn with_transaction<T>(
    connection: &Connection,
    action: impl FnOnce() -> T,
) -> T {
    let _ = connection.execute_batch("BEGIN IMMEDIATE");
    let result = action();
    let _ = connection.execute_batch("COMMIT");
    result
}

pub fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut out: String = value.chars().take(limit.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Number of items in one capture that triggers the bulk notice toast.
pub const BULK_HINT: usize = 5;

/// How many children of a dropped folder are pulled into its collection.
const FOLDER_EXPAND_LIMIT: usize = 100;

pub fn clean_source_app(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let cleaned: String = raw
        .chars()
        .map(|ch| if (ch as u32) < 0x20 { ' ' } else { ch })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(80).collect())
    }
}

pub fn normalize_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let lower = trimmed.to_lowercase();
    let rest = if lower.starts_with("https://") {
        &trimmed[8..]
    } else if lower.starts_with("http://") {
        &trimmed[7..]
    } else {
        return None;
    };
    if trimmed.chars().any(|ch| ch.is_whitespace()) || trimmed.chars().count() > 4096 {
        return None;
    }
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim();
    if host.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

pub fn name_for_url(url: &str) -> String {
    let lower = url.to_lowercase();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        url
    };
    let without_query = rest.split(['?', '#']).next().unwrap_or(rest);
    let name = without_query.trim_end_matches('/');
    if name.is_empty() {
        truncate_chars(url, 64)
    } else {
        truncate_chars(name, 64)
    }
}

pub fn title_for_text(text: &str) -> String {
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return truncate_chars(trimmed, 56);
        }
    }
    "文本片段".to_string()
}

pub fn preview_for_text(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, 220)
}

pub fn list_rows(connection: &Connection) -> Vec<ItemRow> {
    let sql = format!(
        "SELECT {COLUMNS} FROM items WHERE status IN ('active', 'missing')
         ORDER BY pinned DESC, pinned_at DESC, sort_order DESC, created_at DESC"
    );
    let mut statement = match connection.prepare(&sql) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = statement.query_map([], |row| map_row(row));
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

pub fn row_by_id(connection: &Connection, id: &str) -> Option<ItemRow> {
    let sql = format!("SELECT {COLUMNS} FROM items WHERE id = ?1");
    connection
        .query_row(&sql, params![id], |row| map_row(row))
        .optional()
        .ok()
        .flatten()
}

pub fn active_count(connection: &Connection) -> usize {
    connection
        .query_row(
            "SELECT COUNT(*) FROM items WHERE status IN ('active', 'missing')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize
}

fn find_duplicate(connection: &Connection, identity: &str) -> Option<ItemRow> {
    let sql = format!(
        "SELECT {COLUMNS} FROM items WHERE identity = ?1 AND status IN ('active', 'missing')
         ORDER BY created_at DESC LIMIT 1"
    );
    connection
        .query_row(&sql, params![identity], |row| map_row(row))
        .optional()
        .ok()
        .flatten()
}

fn touch_duplicate(connection: &Connection, settings: &Settings, row: &ItemRow, source_app: Option<&str>) {
    let now = now_ms();
    let expires_at = if row.pinned {
        None
    } else {
        compute_expires_at(&settings.default_ttl, now)
    };
    let _ = connection.execute(
        "UPDATE items SET sort_order = ?1, updated_at = ?2, expires_at = ?3,
         source_app = COALESCE(?4, source_app) WHERE id = ?5",
        params![
            (now + 1000) as f64,
            now,
            expires_at,
            source_app,
            row.id
        ],
    );
}

fn insert_row(connection: &Connection, row: &ItemRow) -> rusqlite::Result<()> {
    connection.execute(
        &format!(
            "INSERT INTO items ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
             ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
             ?25, ?26, ?27)"
        ),
        params![
            row.id,
            row.item_type,
            row.name,
            row.ref_path,
            row.stored_rel,
            row.thumb_rel,
            row.storage_mode,
            row.text_content,
            row.html_content,
            row.url,
            row.size,
            row.source_app,
            row.source,
            row.created_at,
            row.updated_at,
            row.expires_at,
            if row.pinned { 1 } else { 0 },
            row.pinned_at,
            row.status,
            row.hash,
            row.identity,
            row.sort_order,
            row.deleted_at,
            row.last_checked_at,
            if row.moved_in { 1 } else { 0 },
            row.original_path,
            row.meta,
        ],
    )?;
    Ok(())
}

pub struct InsertOutcome {
    pub added: bool,
    pub duplicate: bool,
}

fn quota_error_for_path(ctx: &ItemContext<'_>, name: &str, size: u64) -> Option<ItemError> {
    let capacity = ctx.settings.capacity_bytes();
    if capacity > 0 {
        let used = usage(ctx).stored_bytes;
        if used + size as i64 > capacity {
            return Some(ItemError::named(
                "quota",
                format!(
                    "容量不足：还需要 {}，当前上限 {}。请在设置中调整上限或清理内容。",
                    format_bytes(size as i64),
                    format_bytes(capacity)
                ),
                name,
            ));
        }
    }
    let free = fsx::free_disk_bytes(&ctx.storage_root());
    if free < size + 48 * 1024 * 1024 {
        return Some(ItemError::named(
            "disk_full",
            format!(
                "磁盘空间不足，至少还需要 {} 可用空间。",
                format_bytes(size as i64 + 48 * 1024 * 1024)
            ),
            name,
        ));
    }
    None
}

pub fn format_bytes(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes <= 0 {
        return "0 B".into();
    }
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let digits = if unit == 0 {
        0
    } else if value >= 100.0 {
        0
    } else if value >= 10.0 {
        1
    } else {
        1
    };
    let text = format!("{value:.digits$}");
    let text = text.trim_end_matches(".0").to_string();
    format!("{text} {}", UNITS[unit])
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

fn insert_file_like(
    ctx: &ItemContext<'_>,
    source_path: &Path,
    options: &AddPathsOptions,
) -> Result<InsertOutcome, ItemError> {
    let name = basename(source_path);
    let metadata = std::fs::metadata(source_path).map_err(|error| {
        describe_io_error(&error, &name)
    })?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(ItemError::named(
            "unsupported",
            "暂不支持这种文件类型（仅支持普通文件与文件夹）。",
            name,
        ));
    }

    let is_directory = metadata.is_dir();
    let item_type = if is_directory {
        ItemType::Folder
    } else if fsx::is_image_path(source_path) {
        ItemType::Image
    } else {
        ItemType::File
    };
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let identity = fsx::file_identity(source_path, metadata.len(), mtime_ms, item_type.as_str());
    let source_app = clean_source_app(options.source_app.as_deref());
    let source = options
        .source
        .clone()
        .unwrap_or_else(|| "drop".to_string());
    let effect = options
        .effect
        .clone()
        .unwrap_or_else(|| ctx.settings.drop_effect.clone());

    if let Some(duplicate) = find_duplicate(ctx.connection, &identity) {
        touch_duplicate(ctx.connection, ctx.settings, &duplicate, source_app.as_deref());
        return Ok(InsertOutcome {
            added: false,
            duplicate: true,
        });
    }

    if active_count(ctx.connection) >= MAX_ITEMS_TOTAL {
        return Err(ItemError::new(
            "quota",
            format!("暂存台已达到 {MAX_ITEMS_TOTAL} 项上限，请先清理一些内容。"),
        ));
    }

    let cut = effect == "cut";
    let storage_root = ctx.storage_root();
    if cut && fsx::is_protected_path(source_path, &storage_root) {
        return Err(ItemError::named(
            "permission",
            "系统目录或 FlowTray 数据目录中的内容不能以剪切方式移入。请改为复制。",
            name,
        ));
    }

    let use_copy = cut || ctx.settings.storage_mode == "copy";
    let created_at = now_ms();
    let expires_at = compute_expires_at(&ctx.settings.default_ttl, created_at);

    if use_copy {
        let size = if is_directory {
            fsx::directory_size(source_path)
        } else {
            metadata.len()
        };
        if let Some(error) = quota_error_for_path(ctx, &name, size) {
            return Err(error);
        }
        let id = create_id("it_");
        let directory = ctx.files_root().join(&id);
        fsx::ensure_dir(&directory).map_err(|error| describe_io_error(&error, &name))?;
        let destination = fsx::unique_destination(&directory, &name);
        let move_result = if cut {
            fsx::move_path(source_path, &destination, is_directory)
        } else {
            fsx::copy_path(source_path, &destination, is_directory)
        };
        if let Err(error) = move_result {
            fsx::remove_path(&directory);
            return Err(describe_io_error(&error, &name));
        }
        let stored_rel = fsx::to_relative(&storage_root, &destination).unwrap_or_default();
        let thumb_rel = thumbs::create_thumbnail(&ctx.thumbs_root(), &storage_root, &id, &destination);
        let stored_size = if is_directory {
            size
        } else {
            std::fs::metadata(&destination)
                .map(|meta| meta.len())
                .unwrap_or(size)
        };
        let row = ItemRow {
            id,
            item_type: item_type.as_str().to_string(),
            name,
            ref_path: None,
            stored_rel: Some(stored_rel),
            thumb_rel,
            storage_mode: "copy".into(),
            text_content: None,
            html_content: None,
            url: None,
            size: stored_size as i64,
            source_app,
            source,
            created_at,
            updated_at: created_at,
            expires_at,
            pinned: false,
            pinned_at: None,
            status: "active".into(),
            hash: None,
            identity,
            sort_order: (created_at + (MAX_DROP_ITEMS as i64) * 2) as f64,
            deleted_at: None,
            last_checked_at: Some(created_at),
            moved_in: cut,
            original_path: Some(fsx::path_display(source_path)),
            meta: Some(
                serde_json::json!({ "cut": cut, "isDirectory": is_directory }).to_string(),
            ),
        };
        insert_row(ctx.connection, &row).map_err(|error| ItemError::named("unknown", error.to_string(), row.name))?;
        return Ok(InsertOutcome {
            added: true,
            duplicate: false,
        });
    }

    // Reference mode keeps the original file and only stores a thumbnail.
    let id = create_id("it_");
    let thumb_rel = thumbs::create_thumbnail(&ctx.thumbs_root(), &storage_root, &id, source_path);
    let row = ItemRow {
        id,
        item_type: item_type.as_str().to_string(),
        name,
        ref_path: Some(fsx::path_display(source_path)),
        stored_rel: None,
        thumb_rel,
        storage_mode: "reference".into(),
        text_content: None,
        html_content: None,
        url: None,
        size: if is_directory { 0 } else { metadata.len() as i64 },
        source_app,
        source,
        created_at,
        updated_at: created_at,
        expires_at,
        pinned: false,
        pinned_at: None,
        status: "active".into(),
        hash: None,
        identity,
        sort_order: (created_at + (MAX_DROP_ITEMS as i64) * 2) as f64,
        deleted_at: None,
        last_checked_at: Some(created_at),
        moved_in: false,
        original_path: Some(fsx::path_display(source_path)),
        meta: Some(serde_json::json!({ "isDirectory": is_directory }).to_string()),
    };
    insert_row(ctx.connection, &row).map_err(|error| ItemError::named("unknown", error.to_string(), row.name))?;
    Ok(InsertOutcome {
        added: true,
        duplicate: false,
    })
}

pub fn describe_io_error(error: &std::io::Error, name: &str) -> ItemError {
    use std::io::ErrorKind;
    let code = match error.kind() {
        ErrorKind::PermissionDenied => "permission",
        ErrorKind::NotFound => "not_found",
        ErrorKind::StorageFull => "disk_full",
        ErrorKind::InvalidFilename | ErrorKind::InvalidInput => "invalid",
        ErrorKind::Unsupported => "unsupported",
        _ => {
            let raw = error.raw_os_error().unwrap_or(0);
            match raw {
                5 | 32 | 33 => "permission",
                2 | 3 => "not_found",
                112 | 39 => "disk_full",
                _ => "unknown",
            }
        }
    };
    let message = match code {
        "permission" => format!("没有权限读取或写入「{name}」。请检查文件权限，或以管理员身份运行 FlowTray。"),
        "not_found" => format!("「{name}」已不存在，可能被移动或删除。"),
        "disk_full" => format!("磁盘空间不足，无法写入「{name}」。请清理磁盘或更换存储位置。"),
        "invalid" => format!("「{name}」不是有效的文件名或路径。"),
        "unsupported" => format!("暂不支持这种内容：「{name}」。"),
        _ => format!("处理「{name}」时出现未知错误，请稍后重试。"),
    };
    ItemError::named(code, message, name)
}

pub fn add_paths(ctx: &ItemContext<'_>, paths: Vec<String>, options: &AddPathsOptions) -> MutationResult {
    let mut result = MutationResult::default();
    let mut unique: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let trimmed = path.trim().to_string();
        if trimmed.is_empty() || !seen.insert(trimmed.clone()) {
            continue;
        }
        unique.push(trimmed);
        if unique.len() >= MAX_DROP_ITEMS {
            break;
        }
    }
    if unique.is_empty() {
        return result.failed(ItemError::new("unsupported", "没有收到可暂存的文件。"));
    }
    if active_count(ctx.connection) >= MAX_ITEMS_TOTAL {
        return result.failed(ItemError::new(
            "quota",
            format!("暂存台已达到 {MAX_ITEMS_TOTAL} 项上限，请先清理一些内容。"),
        ));
    }
    ctx.ensure_layout();
    for path in unique {
        let source_path = Path::new(&path).to_path_buf();
        let is_directory = std::fs::metadata(&source_path)
            .map(|meta| meta.is_dir())
            .unwrap_or(false);
        match insert_file_like(ctx, &source_path, options) {
            Ok(outcome) => {
                if outcome.added {
                    result.added += 1;
                }
                if outcome.duplicate {
                    result.duplicates += 1;
                }
            }
            Err(error) => result.errors.push(error),
        }
        if is_directory {
            // A dropped folder becomes a collection: one level of its contents is
            // added with a `folder:<name>` source so the shelf can show it as a
            // second-level menu (same idea as the clipboard collection).
            let label = basename(&source_path);
            let mut child_options = options.clone();
            child_options.source = Some(format!("folder:{label}"));
            if let Ok(entries) = std::fs::read_dir(&source_path) {
                for entry in entries.flatten().take(FOLDER_EXPAND_LIMIT) {
                    let child = entry.path();
                    match insert_file_like(ctx, &child, &child_options) {
                        Ok(outcome) => {
                            if outcome.added {
                                result.added += 1;
                            }
                            if outcome.duplicate {
                                result.duplicates += 1;
                            }
                        }
                        Err(error) => result.errors.push(error),
                    }
                }
            }
        }
    }
    result.ok = result.added > 0 || result.duplicates > 0;
    result
}

pub fn add_text(ctx: &ItemContext<'_>, input: &AddTextInput) -> MutationResult {
    let mut result = MutationResult::default();
    let raw = input.text.replace('\u{0}', "").replace("\r\n", "\n");
    let text = raw.trim_start_matches('\u{feff}').to_string();
    if text.trim().is_empty() {
        return result.failed(ItemError::new("invalid", "文本内容为空，未添加。"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return result.failed(ItemError::new(
            "too_large",
            format!("文本超过 {} 万字，暂不支持。", MAX_TEXT_CHARS / 10000),
        ));
    }
    if active_count(ctx.connection) >= MAX_ITEMS_TOTAL {
        return result.failed(ItemError::new("quota", "暂存台已满，请先清理一些内容。"));
    }

    let normalized_url = if text.chars().count() <= 4096 && !text.contains('\n') {
        normalize_url(&text)
    } else {
        None
    };
    let item_type = if normalized_url.is_some() {
        ItemType::Url
    } else {
        ItemType::Text
    };
    let identity = match &normalized_url {
        Some(url) => format!("url:{url}"),
        None => format!("text:{}", fsx::hash_text(&text)),
    };
    if let Some(duplicate) = find_duplicate(ctx.connection, &identity) {
        touch_duplicate(
            ctx.connection,
            ctx.settings,
            &duplicate,
            clean_source_app(input.source_app.as_deref()).as_deref(),
        );
        result.duplicates = 1;
        return result;
    }

    let now = now_ms();
    let html = if normalized_url.is_none() {
        input
            .html
            .as_ref()
            .filter(|value| value.chars().count() <= 1_000_000)
            .cloned()
    } else {
        None
    };
    let name = match &normalized_url {
        Some(url) => name_for_url(url),
        None => title_for_text(&text),
    };
    let row = ItemRow {
        id: create_id("it_"),
        item_type: item_type.as_str().to_string(),
        name,
        ref_path: None,
        stored_rel: None,
        thumb_rel: None,
        storage_mode: "reference".into(),
        text_content: Some(text.clone()),
        html_content: html,
        url: normalized_url.clone(),
        size: text.len() as i64,
        source_app: clean_source_app(input.source_app.as_deref()),
        source: input.source.clone().unwrap_or_else(|| "manual".into()),
        created_at: now,
        updated_at: now,
        expires_at: compute_expires_at(&ctx.settings.default_ttl, now),
        pinned: false,
        pinned_at: None,
        status: "active".into(),
        hash: if normalized_url.is_some() {
            None
        } else {
            Some(fsx::hash_text(&text))
        },
        identity,
        sort_order: (now + 2000) as f64,
        deleted_at: None,
        last_checked_at: Some(now),
        moved_in: false,
        original_path: None,
        meta: None,
    };
    match insert_row(ctx.connection, &row) {
        Ok(()) => result.added = 1,
        Err(error) => {
            return result.failed(ItemError::new("unknown", error.to_string()));
        }
    }
    result
}

pub fn add_urls(
    ctx: &ItemContext<'_>,
    urls: Vec<String>,
    source_app: Option<&str>,
    source: Option<&str>,
) -> MutationResult {
    let mut result = MutationResult::default();
    let mut seen = HashSet::new();
    let mut index = 0i64;
    for raw in urls.into_iter().take(20) {
        let url = match normalize_url(&raw) {
            Some(url) if seen.insert(url.clone()) => url,
            _ => continue,
        };
        let identity = format!("url:{url}");
        if let Some(duplicate) = find_duplicate(ctx.connection, &identity) {
            touch_duplicate(
                ctx.connection,
                ctx.settings,
                &duplicate,
                clean_source_app(source_app).as_deref(),
            );
            result.duplicates += 1;
            continue;
        }
        if active_count(ctx.connection) >= MAX_ITEMS_TOTAL {
            result
                .errors
                .push(ItemError::new("quota", "暂存台已满，请先清理一些内容。"));
            break;
        }
        let now = now_ms();
        let row = ItemRow {
            id: create_id("it_"),
            item_type: ItemType::Url.as_str().to_string(),
            name: name_for_url(&url),
            ref_path: None,
            stored_rel: None,
            thumb_rel: None,
            storage_mode: "reference".into(),
            text_content: Some(url.clone()),
            html_content: None,
            url: Some(url.clone()),
            size: url.len() as i64,
            source_app: clean_source_app(source_app),
            source: source.unwrap_or("manual").to_string(),
            created_at: now,
            updated_at: now,
            expires_at: compute_expires_at(&ctx.settings.default_ttl, now),
            pinned: false,
            pinned_at: None,
            status: "active".into(),
            hash: None,
            identity,
            sort_order: (now + 1800 - index) as f64,
            deleted_at: None,
            last_checked_at: Some(now),
            moved_in: false,
            original_path: None,
            meta: None,
        };
        index += 1;
        if insert_row(ctx.connection, &row).is_ok() {
            result.added += 1;
        }
    }
    result
}

pub fn add_image_buffer(
    ctx: &ItemContext<'_>,
    buffer: &[u8],
    name: Option<&str>,
    source_app: Option<&str>,
    source: &str,
) -> MutationResult {
    let mut result = MutationResult::default();
    if buffer.is_empty() {
        return result.failed(ItemError::new("invalid", "图片内容为空，未添加。"));
    }
    if buffer.len() > MAX_IMAGE_BYTES {
        return result.failed(ItemError::new("too_large", "图片超过 64 MB，暂不支持。"));
    }
    let decoded = match image::load_from_memory(buffer) {
        Ok(image) => image,
        Err(_) => return result.failed(ItemError::new("unsupported", "无法识别这张图片。")),
    };
    let dimensions = (decoded.width(), decoded.height());
    let mut png: Vec<u8> = Vec::new();
    if decoded
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .is_err()
    {
        return result.failed(ItemError::new("unknown", "图片转码失败，未添加。"));
    }
    let hash = fsx::hash_bytes(&png);
    let identity = format!("image:{hash}");
    if let Some(duplicate) = find_duplicate(ctx.connection, &identity) {
        touch_duplicate(
            ctx.connection,
            ctx.settings,
            &duplicate,
            clean_source_app(source_app).as_deref(),
        );
        result.duplicates = 1;
        return result;
    }
    if active_count(ctx.connection) >= MAX_ITEMS_TOTAL {
        return result.failed(ItemError::new("quota", "暂存台已满，请先清理一些内容。"));
    }
    let size = png.len() as u64;
    if let Some(error) = quota_error_for_path(ctx, name.unwrap_or("图片"), size) {
        return result.failed(error);
    }
    ctx.ensure_layout();
    let now = now_ms();
    let id = create_id("it_");
    let stamp = chrono_like_stamp(now);
    let fallback = format!("剪贴板图片 {stamp}.png");
    let safe_name = fsx::sanitize_file_name(name.unwrap_or(&fallback), &fallback);
    let file_name = if safe_name.to_lowercase().ends_with(".png") {
        safe_name
    } else {
        format!("{safe_name}.png")
    };
    let directory = ctx.files_root().join(&id);
    if let Err(error) = fsx::ensure_dir(&directory) {
        return result.failed(describe_io_error(&error, &file_name));
    }
    let destination = fsx::unique_destination(&directory, &file_name);
    if let Err(error) = std::fs::write(&destination, &png) {
        fsx::remove_path(&directory);
        return result.failed(describe_io_error(&error, &file_name));
    }
    let storage_root = ctx.storage_root();
    let stored_rel = fsx::to_relative(&storage_root, &destination).unwrap_or_default();
    let thumb_rel = thumbs::create_thumbnail(&ctx.thumbs_root(), &storage_root, &id, &destination);
    let row = ItemRow {
        id,
        item_type: ItemType::Image.as_str().to_string(),
        name: file_name,
        ref_path: None,
        stored_rel: Some(stored_rel),
        thumb_rel,
        storage_mode: "copy".into(),
        text_content: None,
        html_content: None,
        url: None,
        size: size as i64,
        source_app: clean_source_app(source_app),
        source: source.to_string(),
        created_at: now,
        updated_at: now,
        expires_at: compute_expires_at(&ctx.settings.default_ttl, now),
        pinned: false,
        pinned_at: None,
        status: "active".into(),
        hash: Some(hash),
        identity,
        sort_order: (now + 2000) as f64,
        deleted_at: None,
        last_checked_at: Some(now),
        moved_in: false,
        original_path: None,
        meta: Some(
            serde_json::json!({ "width": dimensions.0, "height": dimensions.1 }).to_string(),
        ),
    };
    match insert_row(ctx.connection, &row) {
        Ok(()) => result.added = 1,
        Err(error) => return result.failed(ItemError::new("unknown", error.to_string())),
    }
    result
}

fn chrono_like_stamp(now: i64) -> String {
    // Local time via SystemTime offset is not available without a tz crate;
    // a UTC-style "MM-DD HH-mm" stamp is enough for a clipboard image name.
    let seconds = (now / 1000).max(0) as u64;
    let days = seconds / 86_400;
    let time_of_day = seconds % 86_400;
    let (month, day) = civil_from_days(days as i64);
    format!(
        "{:02}-{:02} {:02}-{:02}",
        month,
        day,
        time_of_day / 3600,
        (time_of_day % 3600) / 60
    )
}

/// Howard Hinnant's civil-from-days algorithm (UTC, month/day only).
fn civil_from_days(days_since_epoch: i64) -> (u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let _ = y;
    (m as u32, d as u32)
}

pub fn update(
    ctx: &ItemContext<'_>,
    id: &str,
    pinned: Option<bool>,
    name: Option<&str>,
) -> MutationResult {
    let mut result = MutationResult::default();
    let row = match row_by_id(ctx.connection, id) {
        Some(row) if row.status == "active" || row.status == "missing" => row,
        _ => return result.failed(ItemError::new("not_found", "这条内容已不在暂存台中。")),
    };
    let now = now_ms();
    let mut new_pinned = row.pinned;
    let mut pinned_at = row.pinned_at;
    let mut expires_at = row.expires_at;
    if let Some(value) = pinned {
        new_pinned = value;
        pinned_at = if value { Some(now) } else { None };
        expires_at = if value {
            None
        } else {
            compute_expires_at(&ctx.settings.default_ttl, now)
        };
    }
    let new_name = match name {
        Some(value) if !value.trim().is_empty() => {
            fsx::sanitize_file_name(value.trim(), &row.name)
                .chars()
                .take(120)
                .collect::<String>()
        }
        _ => row.name.clone(),
    };
    let _ = ctx.connection.execute(
        "UPDATE items SET pinned = ?1, pinned_at = ?2, expires_at = ?3, name = ?4,
         updated_at = ?5 WHERE id = ?6",
        params![
            if new_pinned { 1 } else { 0 },
            pinned_at,
            expires_at,
            new_name,
            now,
            id
        ],
    );
    result
}

pub fn set_pinned(ctx: &ItemContext<'_>, ids: &[String], pinned: bool) -> MutationResult {
    let mut result = MutationResult::default();
    let rows: Vec<ItemRow> = ids
        .iter()
        .filter_map(|id| row_by_id(ctx.connection, id))
        .filter(|row| row.status == "active" || row.status == "missing")
        .collect();
    if rows.is_empty() {
        return result.failed(ItemError::new("not_found", "没有可固定的内容。"));
    }
    let now = now_ms();
    with_transaction(ctx.connection, || {
        for row in &rows {
            let _ = ctx.connection.execute(
                "UPDATE items SET pinned = ?1, pinned_at = ?2, expires_at = ?3, updated_at = ?4
                 WHERE id = ?5",
                params![
                    if pinned { 1 } else { 0 },
                    if pinned { Some(now) } else { None::<i64> },
                    if pinned {
                        None
                    } else {
                        compute_expires_at(&ctx.settings.default_ttl, now)
                    },
                    now,
                    row.id
                ],
            );
        }
    });
    result
}

pub fn remove(ctx: &ItemContext<'_>, ids: &[String]) -> MutationResult {
    let mut result = MutationResult::default();
    let unique: Vec<&String> = {
        let mut seen = HashSet::new();
        ids.iter().filter(|id| seen.insert(id.as_str())).collect()
    };
    if unique.is_empty() {
        return result;
    }
    let now = now_ms();
    with_transaction(ctx.connection, || {
        for id in &unique {
            let _ = ctx.connection.execute(
                "UPDATE items SET status = 'deleted', deleted_at = ?1, updated_at = ?2
                 WHERE id = ?3 AND status IN ('active', 'missing')",
                params![now, now, id],
            );
        }
    });
    result
}

pub fn clear(ctx: &ItemContext<'_>, include_pinned: bool) -> (MutationResult, Vec<String>) {
    let sql = format!(
        "SELECT {COLUMNS} FROM items WHERE status IN ('active', 'missing'){}",
        if include_pinned { "" } else { " AND pinned = 0" }
    );
    let rows: Vec<ItemRow> = match ctx.connection.prepare(&sql) {
        Ok(mut statement) => statement
            .query_map([], |row| map_row(row))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let mut result = MutationResult::default();
    if rows.is_empty() {
        result.ok = false;
        result.message = Some(if include_pinned {
            "暂存台已经是空的。".to_string()
        } else {
            "没有可清理的临时项。".to_string()
        });
        return (result, Vec::new());
    }
    let now = now_ms();
    with_transaction(ctx.connection, || {
        for row in &rows {
            let _ = ctx.connection.execute(
                "UPDATE items SET status = 'deleted', deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                params![now, now, row.id],
            );
        }
    });
    (result, rows.into_iter().map(|row| row.id).collect())
}

pub fn restore(ctx: &ItemContext<'_>, ids: &[String], extend_expiry: bool) -> usize {
    let mut restored = 0usize;
    let now = now_ms();
    for id in ids {
        let row = match row_by_id(ctx.connection, id) {
            Some(row) => row,
            None => continue,
        };
        if row.status != "deleted" && row.status != "expired" {
            continue;
        }
        let still_exists = row_still_exists(ctx, &row);
        let expires_at = if row.pinned {
            None
        } else if extend_expiry || row.expires_at.is_none() || row.expires_at.unwrap_or(0) <= now {
            compute_expires_at(&ctx.settings.default_ttl, now)
        } else {
            row.expires_at
        };
        let _ = ctx.connection.execute(
            "UPDATE items SET status = ?1, deleted_at = NULL, updated_at = ?2, expires_at = ?3
             WHERE id = ?4",
            params![
                if still_exists { "active" } else { "missing" },
                now,
                expires_at,
                id
            ],
        );
        restored += 1;
    }
    restored
}

fn row_still_exists(ctx: &ItemContext<'_>, row: &ItemRow) -> bool {
    if !row.is_file_like() {
        return true;
    }
    resolve_item_path(ctx, row)
        .map(|path| fsx::path_exists(&path))
        .unwrap_or(false)
}

pub fn resolve_item_path(ctx: &ItemContext<'_>, row: &ItemRow) -> Option<PathBuf> {
    if let Some(relative) = &row.stored_rel {
        return fsx::resolve_under(&ctx.storage_root(), relative);
    }
    row.ref_path.as_ref().map(PathBuf::from)
}

pub fn mark_moved_out(ctx: &ItemContext<'_>, ids: &[String]) -> usize {
    let mut removed = 0usize;
    let now = now_ms();
    for id in ids {
        let row = match row_by_id(ctx.connection, id) {
            Some(row) if row.is_file_like() => row,
            _ => continue,
        };
        let exists = resolve_item_path(ctx, &row)
            .map(|path| fsx::path_exists(&path))
            .unwrap_or(false);
        if !exists {
            let _ = ctx.connection.execute(
                "UPDATE items SET status = 'deleted', deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                params![now, now, row.id],
            );
            removed += 1;
        }
    }
    removed
}

pub fn restore_original(ctx: &ItemContext<'_>, id: &str) -> MutationResult {
    let mut result = MutationResult::default();
    let row = match row_by_id(ctx.connection, id) {
        Some(row) if row.status == "active" => row,
        _ => return result.failed(ItemError::new("not_found", "这条内容已不在暂存台中。")),
    };
    let (original, stored) = match (&row.original_path, &row.stored_rel) {
        (Some(original), Some(_)) if row.moved_in => (original.clone(), resolve_item_path(ctx, &row)),
        _ => {
            return result.failed(ItemError::new(
                "invalid",
                "这条内容不是剪切移入的，无法放回原处。",
            ))
        }
    };
    let stored = match stored {
        Some(path) if fsx::path_exists(&path) => path,
        _ => return result.failed(ItemError::new("not_found", "暂存副本已丢失，无法放回原处。")),
    };
    let original_path = PathBuf::from(&original);
    if fsx::path_exists(&original_path) {
        return result.failed(ItemError::new(
            "invalid",
            "原位置已存在同名文件，请先移动它，或改用拖出。",
        ));
    }
    if let Some(parent) = original_path.parent() {
        if !fsx::path_exists(parent) {
            return result.failed(ItemError::new(
                "not_found",
                "原位置所在文件夹已不存在，无法放回。",
            ));
        }
    }
    let is_directory = row.item_type() == ItemType::Folder;
    if let Err(error) = fsx::move_path(&stored, &original_path, is_directory) {
        return result.failed(describe_io_error(&error, &row.name));
    }
    let now = now_ms();
    let _ = ctx.connection.execute(
        "UPDATE items SET ref_path = ?1, stored_rel = NULL, storage_mode = 'reference',
         moved_in = 0, original_path = ?2, status = 'active', updated_at = ?3 WHERE id = ?4",
        params![original.clone(), original, now, id],
    );
    fsx::remove_path(&ctx.files_root().join(id));
    result.message = Some("已放回原位置。".into());
    result
}

pub fn relocate(ctx: &ItemContext<'_>, id: &str, new_path: &Path) -> MutationResult {
    let mut result = MutationResult::default();
    let row = match row_by_id(ctx.connection, id) {
        Some(row) if row.status == "active" || row.status == "missing" => row,
        _ => return result.failed(ItemError::new("not_found", "这条内容已不在暂存台中。")),
    };
    if !row.is_file_like() {
        return result.failed(ItemError::new("invalid", "文本和链接无需重新定位。"));
    }
    let metadata = match std::fs::metadata(new_path) {
        Ok(meta) => meta,
        Err(error) => return result.failed(describe_io_error(&error, &row.name)),
    };
    if row.item_type() == ItemType::Folder && !metadata.is_dir() {
        return result.failed(ItemError::new("invalid", "请选择一个文件夹。"));
    }
    if row.item_type() != ItemType::Folder && !metadata.is_file() {
        return result.failed(ItemError::new("invalid", "请选择一个文件。"));
    }
    let now = now_ms();
    let new_name = basename(new_path);
    let _ = ctx.connection.execute(
        "UPDATE items SET ref_path = ?1, stored_rel = NULL, storage_mode = 'reference',
         moved_in = 0, original_path = ?2, status = 'active', size = ?3, name = ?4,
         last_checked_at = ?5, updated_at = ?6 WHERE id = ?7",
        params![
            fsx::path_display(new_path),
            fsx::path_display(new_path),
            metadata.len() as i64,
            new_name,
            now,
            now,
            id
        ],
    );
    if row.stored_rel.is_some() {
        fsx::remove_path(&ctx.files_root().join(id));
    }
    if let Some(thumb) = &row.thumb_rel {
        if let Some(path) = fsx::resolve_under(&ctx.storage_root(), thumb) {
            fsx::remove_path(&path);
        }
    }
    let storage_root = ctx.storage_root();
    let thumb_rel = thumbs::create_thumbnail(&ctx.thumbs_root(), &storage_root, id, new_path);
    let _ = ctx.connection.execute(
        "UPDATE items SET thumb_rel = ?1 WHERE id = ?2",
        params![thumb_rel, id],
    );
    result.message = Some("已重新定位。".into());
    result
}

pub fn verify(ctx: &ItemContext<'_>) -> (usize, usize) {
    let sql = format!(
        "SELECT {COLUMNS} FROM items WHERE status IN ('active', 'missing')
         AND type IN ('file', 'folder', 'image')"
    );
    let rows: Vec<ItemRow> = match ctx.connection.prepare(&sql) {
        Ok(mut statement) => statement
            .query_map([], |row| map_row(row))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let now = now_ms();
    let mut missing = 0usize;
    let mut recovered = 0usize;
    for row in rows {
        let exists = resolve_item_path(ctx, &row)
            .map(|path| fsx::path_exists(&path))
            .unwrap_or(false);
        if !exists && row.status == "active" {
            let _ = ctx.connection.execute(
                "UPDATE items SET status = 'missing', last_checked_at = ?1 WHERE id = ?2",
                params![now, row.id],
            );
            missing += 1;
        } else if exists && row.status == "missing" {
            let _ = ctx.connection.execute(
                "UPDATE items SET status = 'active', last_checked_at = ?1 WHERE id = ?2",
                params![now, row.id],
            );
            recovered += 1;
        } else {
            let _ = ctx.connection.execute(
                "UPDATE items SET last_checked_at = ?1 WHERE id = ?2",
                params![now, row.id],
            );
        }
    }
    (missing, recovered)
}

pub struct SweepOutcome {
    pub expired: usize,
    pub ids: Vec<String>,
    pub remind: usize,
}

pub fn sweep_expired(
    ctx: &ItemContext<'_>,
    now: i64,
    notified: &mut HashSet<String>,
) -> SweepOutcome {
    let mut ids: Vec<String> = Vec::new();
    let mut expired_rows: Vec<ItemRow> = Vec::new();
    let sql = format!(
        "SELECT {COLUMNS} FROM items WHERE status IN ('active', 'missing') AND pinned = 0
         AND expires_at IS NOT NULL AND expires_at <= ?1"
    );
    if let Ok(mut statement) = ctx.connection.prepare(&sql) {
        if let Ok(rows) = statement.query_map(params![now], |row| map_row(row)) {
            expired_rows = rows.flatten().collect();
        }
    }
    if !expired_rows.is_empty() {
        with_transaction(ctx.connection, || {
            for row in &expired_rows {
                let _ = ctx.connection.execute(
                    "UPDATE items SET status = 'expired', deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                    params![now, now, row.id],
                );
                ids.push(row.id.clone());
            }
        });
    }

    let soon_sql = format!(
        "SELECT {COLUMNS} FROM items WHERE status IN ('active', 'missing') AND pinned = 0
         AND expires_at IS NOT NULL AND expires_at > ?1 AND expires_at <= ?2"
    );
    let mut remind = 0usize;
    if let Ok(mut statement) = ctx.connection.prepare(&soon_sql) {
        if let Ok(rows) = statement.query_map(params![now, now + EXPIRY_REMINDER_MS], |row| map_row(row)) {
            for row in rows.flatten() {
                if notified.insert(row.id) {
                    remind += 1;
                }
            }
        }
    }
    if notified.len() > 500 {
        let keep: HashSet<String> = notified.iter().take(200).cloned().collect();
        *notified = keep;
    }
    SweepOutcome {
        expired: ids.len(),
        ids,
        remind,
    }
}

pub fn purge_trash(ctx: &ItemContext<'_>, older_than: i64) -> usize {
    let sql = format!(
        "SELECT {COLUMNS} FROM items WHERE status IN ('deleted', 'expired')
         AND deleted_at IS NOT NULL AND deleted_at < ?1"
    );
    let rows: Vec<ItemRow> = match ctx.connection.prepare(&sql) {
        Ok(mut statement) => statement
            .query_map(params![older_than], |row| map_row(row))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let mut purged = 0usize;
    for row in rows {
        if row.stored_rel.is_some() {
            fsx::remove_path(&ctx.files_root().join(&row.id));
        }
        if let Some(thumb) = &row.thumb_rel {
            if let Some(path) = fsx::resolve_under(&ctx.storage_root(), thumb) {
                fsx::remove_path(&path);
            }
        }
        if ctx
            .connection
            .execute("DELETE FROM items WHERE id = ?1", params![row.id])
            .is_ok()
        {
            purged += 1;
        }
    }
    purged
}

pub fn usage(ctx: &ItemContext<'_>) -> StorageUsage {
    let stored: i64 = ctx
        .connection
        .query_row(
            "SELECT COALESCE(SUM(size), 0) FROM items WHERE stored_rel IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let referenced: i64 = ctx
        .connection
        .query_row(
            "SELECT COALESCE(SUM(size), 0) FROM items WHERE stored_rel IS NULL
             AND type IN ('file', 'folder', 'image') AND status IN ('active', 'missing')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let (items, pinned, missing): (i64, i64, i64) = ctx
        .connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END), 0)
             FROM items WHERE status IN ('active', 'missing')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap_or((0, 0, 0));
    StorageUsage {
        stored_bytes: stored,
        referenced_bytes: referenced,
        capacity_bytes: ctx.settings.capacity_bytes(),
        item_count: items,
        pinned_count: pinned,
        missing_count: missing,
    }
}

pub fn get_view(ctx: &ItemContext<'_>, row: &ItemRow, now: i64) -> ShelfItemView {
    let absolute = resolve_item_path(ctx, row).map(|path| fsx::path_display(&path));
    let item_type = row.item_type();
    let ext = if item_type == ItemType::Text || item_type == ItemType::Url {
        None
    } else {
        fsx::file_extension(&row.name)
    };
    let thumb_url = row.thumb_rel.as_ref().map(|_| {
        format!(
            "http://flowtray.localhost/thumb/{}?v={}",
            urlencode(&row.id),
            row.updated_at
        )
    });
    let text_content = if item_type == ItemType::Text || item_type == ItemType::Url {
        row.text_content.clone()
    } else {
        None
    };
    let expires_in_ms = row.expires_at.map(|value| (value - now).max(0));
    ShelfItemView {
        id: row.id.clone(),
        item_type: row.item_type.clone(),
        name: row.name.clone(),
        preview: if item_type == ItemType::Text {
            row.text_content.as_ref().map(|text| preview_for_text(text))
        } else {
            None
        },
        text_content,
        text_length: if item_type == ItemType::Text {
            row.text_content.as_ref().map(|text| text.chars().count())
        } else {
            None
        },
        url: row.url.clone(),
        path: absolute,
        ext,
        size: row.size,
        source_app: row.source_app.clone(),
        source: row.source.clone(),
        created_at: row.created_at,
        expires_at: row.expires_at,
        pinned: row.pinned,
        status: row.status.clone(),
        storage_mode: row.storage_mode.clone(),
        has_thumb: row.thumb_rel.is_some(),
        thumb_url,
        moved_in: row.moved_in,
        expires_in_ms,
        expiring_soon: !row.pinned
            && row
                .expires_at
                .map(|value| value - now <= EXPIRY_REMINDER_MS && value > now)
                .unwrap_or(false),
    }
}

pub fn get_items(ctx: &ItemContext<'_>, now: i64) -> Vec<ShelfItemView> {
    list_rows(ctx.connection)
        .iter()
        .map(|row| get_view(ctx, row, now))
        .collect()
}

pub fn get_detail(ctx: &ItemContext<'_>, id: &str) -> Option<ShelfItemDetail> {
    let row = row_by_id(ctx.connection, id)?;
    if row.status != "active" && row.status != "missing" {
        return None;
    }
    let view = get_view(ctx, &row, now_ms());
    let meta = row
        .meta
        .as_ref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
    Some(ShelfItemDetail {
        view,
        text_content: row.text_content.clone(),
        original_path: row.original_path.clone(),
        hash: row.hash.clone(),
        last_checked_at: row.last_checked_at,
        meta,
    })
}

pub fn get_thumb_path(ctx: &ItemContext<'_>, id: &str) -> Option<PathBuf> {
    let row = row_by_id(ctx.connection, id)?;
    let relative = row.thumb_rel?;
    let path = fsx::resolve_under(&ctx.storage_root(), &relative)?;
    if fsx::path_exists(&path) {
        Some(path)
    } else {
        None
    }
}

pub fn get_copyable_rows(ctx: &ItemContext<'_>, ids: &[String]) -> Vec<ItemRow> {
    ids.iter()
        .filter_map(|id| row_by_id(ctx.connection, id))
        .filter(|row| row.status == "active" || row.status == "missing")
        .collect()
}

pub fn get_file_like_rows(ctx: &ItemContext<'_>, ids: &[String]) -> Vec<ItemRow> {
    get_copyable_rows(ctx, ids)
        .into_iter()
        .filter(|row| row.is_file_like())
        .collect()
}

pub fn existing_paths(ctx: &ItemContext<'_>, rows: &[ItemRow]) -> (Vec<String>, Vec<ItemError>) {
    let mut paths = Vec::new();
    let mut errors = Vec::new();
    for row in rows {
        match resolve_item_path(ctx, row) {
            Some(path) if fsx::path_exists(&path) => paths.push(fsx::path_display(&path)),
            _ => errors.push(ItemError::named(
                "not_found",
                format!("「{}」已失效，请重新定位后再试。", row.name),
                row.name.clone(),
            )),
        }
    }
    (paths, errors)
}

pub fn enforce_clipboard_limit(ctx: &ItemContext<'_>, max: i64) -> usize {
    let sql = format!(
        "SELECT {COLUMNS} FROM items WHERE status = 'active' AND source = 'clipboard'
         ORDER BY created_at ASC"
    );
    let rows: Vec<ItemRow> = match ctx.connection.prepare(&sql) {
        Ok(mut statement) => statement
            .query_map([], |row| map_row(row))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let excess = rows.len() as i64 - max;
    if excess <= 0 {
        return 0;
    }
    let now = now_ms();
    let mut removed = 0i64;
    for row in rows {
        if removed >= excess {
            break;
        }
        if row.pinned {
            continue;
        }
        let _ = ctx.connection.execute(
            "UPDATE items SET status = 'deleted', deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![now, now, row.id],
        );
        removed += 1;
    }
    removed as usize
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_http_urls_only() {
        assert_eq!(
            normalize_url(" https://example.com/a "),
            Some("https://example.com/a".to_string())
        );
        assert!(normalize_url("file:///c:/x").is_none());
        assert!(normalize_url("https://example .com").is_none());
        assert!(normalize_url("https://").is_none());
    }

    #[test]
    fn builds_readable_text_titles() {
        assert_eq!(title_for_text("\n\n  第一行内容\n第二行"), "第一行内容");
        assert_eq!(title_for_text("   "), "文本片段");
    }

    #[test]
    fn wraps_truncation_on_char_boundaries() {
        let truncated = truncate_chars("中文内容", 3);
        assert_eq!(truncated, "中文…");
        assert_eq!(truncate_chars("短", 8), "短");
    }

    #[test]
    fn formats_sizes() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(2048), "2 KB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5 MB");
    }
}
