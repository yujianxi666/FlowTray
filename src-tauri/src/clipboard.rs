//! Windows clipboard integration: typed reads (text / HTML / file list / image),
//! writes for copy actions, and the optional privacy-aware monitor.

use std::io::Cursor;
use std::sync::Arc;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Shell::{DragQueryFileW, DROPFILES, HDROP};

use crate::app::App;
use crate::fsx;
use crate::ids::now_ms;
use crate::items;
use crate::logger::LOGGER;
use crate::settings::{is_sensitive_source, Settings};
use crate::types::{AddTextInput, ItemError, MutationResult};
use crate::winapi;

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
const CF_HDROP: u32 = 15;

#[derive(Debug, Default, Clone)]
pub struct ClipboardRaw {
    pub types: Vec<String>,
    pub text: String,
    pub html: String,
    pub files: Vec<String>,
    pub links: Vec<String>,
    pub image_png: Option<Vec<u8>>,
    pub fingerprint: String,
}

impl ClipboardRaw {
    pub fn has_content(&self) -> bool {
        !self.files.is_empty()
            || !self.links.is_empty()
            || self.image_png.is_some()
            || !self.text.trim().is_empty()
    }
}

pub fn register_format(name: &str) -> u32 {
    let wide = winapi::wide(name);
    unsafe { RegisterClipboardFormatW(PCWSTR::from_raw(wide.as_ptr())) }
}

fn format_name(format: u32) -> String {
    match format {
        CF_UNICODETEXT => "text/plain".to_string(),
        CF_DIB => "image/bmp".to_string(),
        CF_HDROP => "Files".to_string(),
        _ => format!("fmt:{format}"),
    }
}

unsafe fn global_bytes(handle: HANDLE, declared: Option<usize>) -> Option<Vec<u8>> {
    if handle.0.is_null() {
        return None;
    }
    let global = HGLOBAL(handle.0);
    let size = declared.unwrap_or_else(|| GlobalSize(global));
    if size == 0 {
        return None;
    }
    let pointer = GlobalLock(global) as *const u8;
    if pointer.is_null() {
        return None;
    }
    let bytes = std::slice::from_raw_parts(pointer, size).to_vec();
    let _ = GlobalUnlock(global);
    Some(bytes)
}

fn read_unicode_text() -> String {
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
            return String::new();
        }
        match GetClipboardData(CF_UNICODETEXT) {
            Ok(handle) => global_bytes(handle, None)
                .map(|bytes| {
                    let wide: Vec<u16> = bytes
                        .chunks_exact(2)
                        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                        .take_while(|value| *value != 0)
                        .collect();
                    String::from_utf16_lossy(&wide)
                })
                .unwrap_or_default(),
            Err(_) => String::new(),
        }
    }
}

fn read_raw_format(format: u32) -> Option<Vec<u8>> {
    unsafe {
        if IsClipboardFormatAvailable(format).is_err() {
            return None;
        }
        let handle = GetClipboardData(format).ok()?;
        global_bytes(handle, None)
    }
}

pub fn html_format_id() -> u32 {
    register_format("HTML Format")
}

pub fn parse_html_format(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).to_string();
    let header_end = text.find("<html").unwrap_or(0);
    let header = &text[..header_end];
    let index_of = |key: &str| -> Option<usize> {
        header
            .lines()
            .find(|line| line.to_lowercase().starts_with(&key.to_lowercase()))
            .and_then(|line| line.split(':').nth(1))
            .and_then(|value| value.trim().parse::<usize>().ok())
    };
    if let (Some(start), Some(end)) = (index_of("StartFragment"), index_of("EndFragment")) {
        if start < end && end <= text.len() {
            return text[start..end].to_string();
        }
    }
    text
}

fn read_files() -> Vec<String> {
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP).is_err() {
            return Vec::new();
        }
        let Ok(handle) = GetClipboardData(CF_HDROP) else {
            return Vec::new();
        };
        let drop = HDROP(handle.0);
        let count = DragQueryFileW(drop, u32::MAX, None);
        let mut files = Vec::new();
        for index in 0..count {
            let length = DragQueryFileW(drop, index, None) as usize;
            if length == 0 {
                continue;
            }
            let mut buffer = vec![0u16; length + 1];
            DragQueryFileW(drop, index, Some(&mut buffer));
            let path = String::from_utf16_lossy(&buffer[..length]);
            if !path.trim().is_empty() {
                files.push(path);
            }
        }
        files
    }
}

fn dib_to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 40 {
        return None;
    }
    let header_size = u32::from_le_bytes(bytes[0..4].try_into().ok()?) as usize;
    let width = i32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let height = i32::from_le_bytes(bytes[8..12].try_into().ok()?);
    let bit_count = u16::from_le_bytes(bytes[14..16].try_into().ok()?);
    let compression = u32::from_le_bytes(bytes[16..20].try_into().ok()?);
    if width <= 0 || height == 0 || compression != 0 || !(bit_count == 24 || bit_count == 32) {
        return None;
    }
    let top_down = height < 0;
    let height = height.unsigned_abs() as usize;
    let width = width as usize;
    let bytes_per_pixel = (bit_count / 8) as usize;
    let stride = (width * bytes_per_pixel + 3) & !3;
    let palette_size = 0usize;
    let pixel_offset = header_size + palette_size;
    let needed = pixel_offset + stride * height;
    if bytes.len() < needed {
        return None;
    }
    let mut buffer = image::RgbaImage::new(width as u32, height as u32);
    for row in 0..height {
        let source_row = if top_down { row } else { height - 1 - row };
        let row_start = pixel_offset + source_row * stride;
        for column in 0..width {
            let index = row_start + column * bytes_per_pixel;
            let blue = bytes[index];
            let green = bytes[index + 1];
            let red = bytes[index + 2];
            let alpha = if bytes_per_pixel == 4 {
                let value = bytes[index + 3];
                if value == 0 {
                    255
                } else {
                    value
                }
            } else {
                255
            };
            buffer.put_pixel(column as u32, row as u32, image::Rgba([red, green, blue, alpha]));
        }
    }
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(buffer)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(png)
}

fn read_image_png() -> Option<Vec<u8>> {
    let png_format = register_format("PNG");
    if png_format != 0 {
        if let Some(bytes) = read_raw_format(png_format) {
            if !bytes.is_empty() {
                return Some(bytes);
            }
        }
    }
    let dib = read_raw_format(CF_DIB)?;
    dib_to_png(&dib)
}

fn links_from_text(text: &str) -> Vec<String> {
    let mut links = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if items::normalize_url(trimmed).is_some() {
            links.push(trimmed.to_string());
        }
    }
    links
}

pub fn read_raw() -> Option<ClipboardRaw> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let mut raw = ClipboardRaw::default();
        raw.text = read_unicode_text();
        if let Some(bytes) = read_raw_format(CF_HDROP) {
            let _ = bytes;
        }
        raw.files = read_files();
        let html_format = html_format_id();
        if html_format != 0 {
            if let Some(bytes) = read_raw_format(html_format) {
                raw.html = parse_html_format(&bytes);
            }
        }
        raw.image_png = read_image_png();
        let _ = CloseClipboard();

        raw.links = links_from_text(&raw.text);
        let mut types = Vec::new();
        if !raw.text.is_empty() {
            types.push(format_name(CF_UNICODETEXT));
        }
        if !raw.files.is_empty() {
            types.push(format_name(CF_HDROP));
        }
        if raw.image_png.is_some() {
            types.push(format_name(CF_DIB));
        }
        if !raw.html.is_empty() {
            types.push("text/html".to_string());
        }
        raw.types = types;

        let mut hasher_input = String::new();
        hasher_input.push_str(&raw.text);
        hasher_input.push('\u{1}');
        hasher_input.push_str(&raw.html);
        hasher_input.push('\u{1}');
        hasher_input.push_str(&raw.files.join("|"));
        let image_hash = raw
            .image_png
            .as_ref()
            .map(|png| fsx::hash_bytes(png))
            .unwrap_or_default();
        raw.fingerprint = fsx::hash_text(&format!("{hasher_input}\u{1}{image_hash}"));
        Some(raw)
    }
}

fn put_clipboard(format: u32, bytes: &[u8]) -> bool {
    unsafe {
        let Ok(handle) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else {
            return false;
        };
        let pointer = GlobalLock(handle) as *mut u8;
        if pointer.is_null() {
            return false;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
        let _ = GlobalUnlock(handle);
        let result = SetClipboardData(format, Some(HANDLE(handle.0)));
        if result.is_err() {
            return false;
        }
        true
    }
}

fn put_clipboard_utf16(format: u32, value: &str) -> bool {
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    wide.push(0);
    let bytes: Vec<u8> = wide.iter().flat_map(|unit| unit.to_le_bytes()).collect();
    put_clipboard(format, &bytes)
}

fn build_html_clipboard(payload: &str) -> Vec<u8> {
    let header_template = "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n";
    let prefix = "<html><body><!--StartFragment-->";
    let suffix = "<!--EndFragment--></body></html>";
    let placeholder = header_template
        .replace("{:010}", "0000000000")
        .replace("{:010}", "0000000000")
        .replace("{:010}", "0000000000")
        .replace("{:010}", "0000000000");
    let header_len = placeholder.len();
    let start_html = header_len;
    let start_fragment = header_len + prefix.len();
    let end_fragment = start_fragment + payload.len();
    let end_html = end_fragment + suffix.len();
    let header = format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n"
    );
    let mut bytes = Vec::new();
    bytes.extend_from_slice(header.as_bytes());
    bytes.extend_from_slice(prefix.as_bytes());
    bytes.extend_from_slice(payload.as_bytes());
    bytes.extend_from_slice(suffix.as_bytes());
    bytes
}

pub fn write_text(text: &str, html: Option<&str>) -> bool {
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let _ = EmptyClipboard();
        let mut ok = put_clipboard_utf16(CF_UNICODETEXT, text);
        if let Some(html) = html.filter(|value| !value.trim().is_empty()) {
            let format = html_format_id();
            if format != 0 {
                ok = put_clipboard(format, &build_html_clipboard(html)) || ok;
            }
        }
        let _ = CloseClipboard();
        ok
    }
}

pub fn write_image(png: &[u8]) -> bool {
    let Ok(decoded) = image::load_from_memory(png) else {
        return false;
    };
    let mut bmp = Vec::new();
    if decoded
        .write_to(&mut Cursor::new(&mut bmp), image::ImageFormat::Bmp)
        .is_err()
    {
        return false;
    }
    // Strip the 14-byte BITMAPFILEHEADER to obtain a CF_DIB payload.
    let dib = if bmp.len() > 14 { &bmp[14..] } else { &bmp[..] };
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let _ = EmptyClipboard();
        let mut ok = put_clipboard(CF_DIB, dib);
        let format = register_format("PNG");
        if format != 0 {
            ok = put_clipboard(format, png) || ok;
        }
        let _ = CloseClipboard();
        ok
    }
}

fn build_hdrop(paths: &[String]) -> Vec<u8> {
    let mut list: Vec<u16> = Vec::new();
    for path in paths {
        list.extend(path.encode_utf16());
        list.push(0);
    }
    list.push(0);
    let header_size = std::mem::size_of::<DROPFILES>();
    let byte_len = header_size + list.len() * 2;
    let mut bytes = vec![0u8; byte_len];
    let drop = bytes.as_mut_ptr() as *mut DROPFILES;
    unsafe {
        (*drop).pFiles = header_size as u32;
        (*drop).fWide = true.into();
        (*drop).fNC = false.into();
        (*drop).pt = windows::Win32::Foundation::POINT { x: 0, y: 0 };
    }
    let payload: Vec<u8> = list.iter().flat_map(|unit| unit.to_le_bytes()).collect();
    bytes[header_size..].copy_from_slice(&payload);
    bytes
}

pub fn write_files(paths: &[String]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let list = build_hdrop(paths);
    let plain = paths.join("\r\n");
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let _ = EmptyClipboard();
        let mut ok = put_clipboard(CF_HDROP, &list);
        ok = put_clipboard_utf16(CF_UNICODETEXT, &plain) || ok;
        let _ = CloseClipboard();
        ok
    }
}

/// Copy the selection according to the renderer's `kind`.
pub fn copy_selection(app: &Arc<App>, ids: &[String], kind: &str) -> crate::types::CopyResult {
    let (rows, paths, path_errors) = app.query(|ctx| {
        let rows = items::get_copyable_rows(ctx, ids);
        let file_rows: Vec<items::ItemRow> = rows
            .iter()
            .filter(|row| row.is_file_like())
            .cloned()
            .collect();
        let (paths, errors) = items::existing_paths(ctx, &file_rows);
        (rows, paths, errors)
    });

    if rows.is_empty() {
        return crate::types::CopyResult::failure("没有可复制的内容。");
    }

    let file_rows: Vec<&items::ItemRow> = rows.iter().filter(|row| row.is_file_like()).collect();
    let all_files = !file_rows.is_empty() && file_rows.len() == rows.len();

    if kind == "files" || (kind == "auto" && all_files) || (kind == "auto" && rows.len() == 1 && file_rows.len() == 1) {
        if paths.is_empty() {
            return crate::types::CopyResult::failure(
                path_errors
                    .first()
                    .map(|error| error.message.clone())
                    .unwrap_or_else(|| "文件已失效，无法复制。".into()),
            );
        }
        if write_files(&paths) {
            let message = if paths.len() > 1 {
                format!("已复制 {} 个文件，可直接粘贴到资源管理器或聊天窗口。", paths.len())
            } else {
                "已复制文件，可直接粘贴。".to_string()
            };
            return crate::types::CopyResult::with_message(message);
        }
        return crate::types::CopyResult::failure("复制失败，剪贴板可能正被其他程序占用。");
    }

    if kind == "path" {
        let mut lines = Vec::new();
        for row in &rows {
            let line = app.query(|ctx| items::resolve_item_path(ctx, row))
                .map(|path| fsx::path_display(&path))
                .or_else(|| row.url.clone())
                .or_else(|| row.text_content.clone())
                .unwrap_or_default();
            if !line.is_empty() {
                lines.push(line);
            }
        }
        if lines.is_empty() {
            return crate::types::CopyResult::failure("没有可复制的路径。");
        }
        return if write_text(&lines.join("\r\n"), None) {
            crate::types::CopyResult::with_message(format!("已复制 {} 条路径。", lines.len()))
        } else {
            crate::types::CopyResult::failure("复制失败，剪贴板可能正被其他程序占用。")
        };
    }

    if kind == "text" {
        let texts: Vec<String> = rows
            .iter()
            .filter(|row| row.item_type().as_str() == "text" || row.item_type().as_str() == "url")
            .map(|row| row.text_content.clone().or_else(|| row.url.clone()).unwrap_or_default())
            .filter(|text| !text.is_empty())
            .collect();
        if texts.is_empty() {
            return crate::types::CopyResult::failure("选中的内容里没有文本。");
        }
        return if write_text(&texts.join("\r\n\r\n"), None) {
            crate::types::CopyResult::with_message(format!("已复制 {} 条文本。", texts.len()))
        } else {
            crate::types::CopyResult::failure("复制失败，剪贴板可能正被其他程序占用。")
        };
    }

    // Single item special cases.
    if rows.len() == 1 {
        let row = &rows[0];
        match row.item_type().as_str() {
            "text" => {
                let text = row.text_content.clone().unwrap_or_default();
                return if write_text(&text, row.html_content.as_deref()) {
                    crate::types::CopyResult::with_message("已复制文本，可直接粘贴。")
                } else {
                    crate::types::CopyResult::failure("复制失败，剪贴板可能正被其他程序占用。")
                };
            }
            "url" => {
                let url = row.url.clone().or_else(|| row.text_content.clone()).unwrap_or_default();
                let html = format!("<a href=\"{}\">{}</a>", url.replace('"', "&quot;"), url);
                return if write_text(&url, Some(&html)) {
                    crate::types::CopyResult::with_message("已复制链接。")
                } else {
                    crate::types::CopyResult::failure("复制失败，剪贴板可能正被其他程序占用。")
                };
            }
            "image" => {
                if let Some(message) = copy_image_item(app, row) {
                    return message;
                }
            }
            _ => {}
        }
    }

    let mut lines = Vec::new();
    for row in &rows {
        let line = app
            .query(|ctx| items::resolve_item_path(ctx, row))
            .map(|path| fsx::path_display(&path))
            .or_else(|| row.url.clone())
            .or_else(|| row.text_content.clone())
            .unwrap_or_else(|| row.name.clone());
        lines.push(line);
    }
    if write_text(&lines.join("\r\n"), None) {
        crate::types::CopyResult::with_message(format!("已复制 {} 项内容。", rows.len()))
    } else {
        crate::types::CopyResult::failure("复制失败，剪贴板可能正被其他程序占用。")
    }
}

fn copy_image_item(app: &Arc<App>, row: &items::ItemRow) -> Option<crate::types::CopyResult> {
    let path = app.query(|ctx| items::resolve_item_path(ctx, row))?;
    if !fsx::path_exists(&path) {
        return Some(crate::types::CopyResult::failure("图片已失效，无法复制。"));
    }
    let bytes = std::fs::read(&path).ok()?;
    if write_image(&bytes) {
        Some(crate::types::CopyResult::with_message("已复制图片，可直接粘贴。"))
    } else {
        Some(crate::types::CopyResult::failure("复制图片失败，请稍后重试。"))
    }
}

fn ingest(app: &Arc<App>, raw: &ClipboardRaw, source_app: Option<&str>, explicit: bool) -> MutationResult {
    let source_app = source_app.map(|value| value.to_string());
    // Automatic monitor captures are grouped in their own collection; an explicit
    // "存入剪贴板" stays in the main list because the user asked for it.
    let source = if explicit { "clipboard" } else { "clipboard_auto" };
    if !raw.files.is_empty() {
        let result = app.mutate(|ctx| {
            items::add_paths(
                ctx,
                raw.files.clone(),
                &crate::types::AddPathsOptions {
                    effect: Some("copy".into()),
                    source_app,
                    source: Some(source.to_string()),
                },
            )
        });
        if result.added >= crate::items::BULK_HINT {
            app.toast(
                "info",
                &format!(
                    "检测到 {} 个文件，已收进剪贴板合集，避免刷屏。",
                    result.added
                ),
            );
        }
        return result;
    }
    if !raw.links.is_empty() {
        return app.mutate(|ctx| {
            items::add_urls(
                ctx,
                raw.links.clone(),
                source_app.as_deref(),
                Some(source),
            )
        });
    }
    if let Some(png) = &raw.image_png {
        if raw.text.trim().is_empty() || explicit {
            if png.len() > crate::types::MAX_IMAGE_BYTES {
                return MutationResult::default().failed(ItemError::new(
                    "too_large",
                    "剪贴板图片超过 64 MB，未收录。",
                ));
            }
            return app.mutate(|ctx| {
                items::add_image_buffer(ctx, png, None, source_app.as_deref(), source)
            });
        }
    }
    if raw.text.trim().is_empty() {
        return MutationResult::default().failed(ItemError::new(
            "clipboard_empty",
            "剪贴板里没有可暂存的内容。",
        ));
    }
    let input = AddTextInput {
        text: raw.text.clone(),
        html: if raw.html.chars().count() <= 1_000_000 {
            Some(raw.html.clone())
        } else {
            None
        },
        source_app,
        source: Some(source.to_string()),
    };
    app.mutate(|ctx| items::add_text(ctx, &input))
}

pub fn capture_explicit(app: &Arc<App>, source_from_foreground: bool) -> MutationResult {
    let Some(raw) = read_raw() else {
        return MutationResult::default().failed(ItemError::new(
            "clipboard_empty",
            "剪贴板里没有可暂存的内容。",
        ));
    };
    if !raw.has_content() {
        return MutationResult::default().failed(ItemError::new(
            "clipboard_empty",
            "剪贴板里没有可暂存的内容。",
        ));
    }
    let mut source_app: Option<String> = None;
    if source_from_foreground {
        if let Some(info) = winapi::foreground_info() {
            let settings = app.settings();
            if is_sensitive_source(
                &info.process_name,
                &info.title,
                &settings.sensitive_apps,
                &settings.sensitive_titles,
            ) {
                LOGGER.info(
                    "clipboard.sensitive_skip",
                    Some(serde_json::json!({ "app": info.app_name })),
                );
                return MutationResult::default().failed(ItemError::new(
                    "sensitive",
                    format!(
                        "当前应用「{}」在隐私排除列表中，未收录剪贴板内容。",
                        info.app_name
                    ),
                ));
            }
            source_app = Some(info.app_name);
        }
    }
    let result = ingest(app, &raw, source_app.as_deref(), true);
    if result.ok {
        {
            let mut settings = app.settings();
            let limit = settings.clipboard_max_items;
            settings.clipboard_max_items = limit;
            drop(settings);
            let max = app.settings().clipboard_max_items;
            app.mutate(|ctx| items::enforce_clipboard_limit(ctx, max));
        }
        let mut state = app.clipboard.lock();
        state.last_fingerprint = raw.fingerprint;
        state.suppress_until = now_ms() + 600;
    }
    result
}

pub fn tick_monitor(app: &Arc<App>) {
    if app.clipboard.lock().suppress_until > now_ms() {
        return;
    }
    let Some(raw) = read_raw() else {
        return;
    };
    {
        let state = app.clipboard.lock();
        if state.last_fingerprint == raw.fingerprint {
            return;
        }
    }
    app.clipboard.lock().last_fingerprint = raw.fingerprint.clone();
    if !raw.has_content() {
        return;
    }
    let Some(info) = winapi::foreground_info() else {
        return;
    };
    let lower = info.process_name.to_lowercase();
    if lower.contains("flowtray") {
        return;
    }
    let Settings {
        sensitive_apps,
        sensitive_titles,
        ..
    } = app.settings();
    if is_sensitive_source(
        &info.process_name,
        &info.title,
        &sensitive_apps,
        &sensitive_titles,
    ) {
        LOGGER.info(
            "clipboard.skipped_sensitive",
            Some(serde_json::json!({ "app": info.app_name })),
        );
        return;
    }
    let _ = ingest(app, &raw, Some(&info.app_name), false);
    let max = app.settings().clipboard_max_items;
    app.mutate(|ctx| items::enforce_clipboard_limit(ctx, max));
    app.schedule_broadcast();
}

pub fn mark_self_write(app: &Arc<App>) {
    let mut state = app.clipboard.lock();
    state.suppress_until = now_ms() + 1400;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if let Some(raw) = read_raw() {
            app.clipboard.lock().last_fingerprint = raw.fingerprint;
        }
    });
}
