//! File-system helpers with the safety rails FlowTray relies on: sanitised file
//! names, storage-root confinement, protected-path checks and atomic copies.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "tif", "tiff",
];

const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn ensure_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

pub fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn file_extension(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    if dot == 0 || dot + 1 >= name.len() {
        return None;
    }
    Some(name[dot + 1..].to_lowercase())
}

pub fn sanitize_file_name(input: &str, fallback: &str) -> String {
    let mut name: String = input
        .chars()
        .map(|ch| {
            if (ch as u32) < 0x20 || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                ' '
            } else {
                ch
            }
        })
        .collect();
    name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    while name.ends_with('.') || name.ends_with(' ') {
        name.pop();
    }
    if name.is_empty() {
        name = fallback.to_string();
    }
    let ext = file_extension(&name)
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let base = if ext.is_empty() {
        name.clone()
    } else {
        name[..name.len() - ext.len()].to_string()
    };
    let safe_base = if RESERVED_NAMES.contains(&base.to_lowercase().as_str()) {
        format!("{base}_")
    } else {
        base
    };
    let max_base = std::cmp::max(8, 110usize.saturating_sub(ext.len()));
    let clipped: String = safe_base.chars().take(max_base).collect();
    let result = format!("{clipped}{ext}").trim().to_string();
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

pub fn unique_destination(directory: &Path, file_name: &str) -> PathBuf {
    let safe = sanitize_file_name(file_name, "未命名");
    let candidate = directory.join(&safe);
    if !path_exists(&candidate) {
        return candidate;
    }
    let ext = file_extension(&safe)
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let base = if ext.is_empty() {
        safe.clone()
    } else {
        safe[..safe.len() - ext.len()].to_string()
    };
    for index in 2..500 {
        let next = directory.join(format!("{base} ({index}){ext}"));
        if !path_exists(&next) {
            return next;
        }
    }
    directory.join(format!("{base}-{}{ext}", crate::ids::now_ms()))
}

pub fn to_relative(root: &Path, absolute: &Path) -> Option<String> {
    let relative = absolute.strip_prefix(root).ok()?;
    let parts: Vec<String> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    Some(parts.join("/"))
}

pub fn resolve_under(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.trim().is_empty() {
        return None;
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return None;
    }
    let mut resolved = root.to_path_buf();
    for component in candidate.components() {
        match component {
            Component::Normal(value) => resolved.push(value),
            Component::CurDir => {}
            Component::ParentDir => return None,
            _ => return None,
        }
    }
    if !is_path_inside(&resolved, root) {
        return None;
    }
    Some(resolved)
}

pub fn is_path_inside(child: &Path, parent: &Path) -> bool {
    let child_norm = normalize_for_compare(child);
    let parent_norm = normalize_for_compare(parent);
    child_norm == parent_norm
        || child_norm
            .strip_prefix(&format!("{parent_norm}\\"))
            .is_some()
        || child_norm
            .strip_prefix(&format!("{parent_norm}/"))
            .is_some()
}

fn normalize_for_compare(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let trimmed = text.trim_end_matches('\\');
    trimmed.to_lowercase()
}

pub fn is_protected_path(target: &Path, storage_root: &Path) -> bool {
    if target.as_os_str().is_empty() {
        return true;
    }
    if is_path_inside(target, storage_root) {
        return true;
    }
    let resolved = target.to_string_lossy().to_string();
    let lower = resolved.to_lowercase();
    if lower.len() <= 3 && lower.contains(':') {
        return true;
    }
    let mut roots: Vec<String> = Vec::new();
    for key in ["WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                roots.push(value);
            }
        }
    }
    roots.push("C:\\System Volume Information".to_string());
    roots.iter().any(|root| {
        let normalized = root.trim_end_matches('\\').to_lowercase();
        lower == normalized || lower.starts_with(&format!("{normalized}\\"))
    })
}

pub fn copy_path(source: &Path, destination: &Path, is_directory: bool) -> io::Result<()> {
    if let Some(parent) = destination.parent() {
        ensure_dir(parent)?;
    }
    if !is_directory {
        fs::copy(source, destination)?;
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let child_source = entry.path();
        let child_destination = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_path(&child_source, &child_destination, true)?;
        } else if file_type.is_symlink() {
            // Copy the target contents rather than the link itself so the copy
            // survives even when the link is removed later.
            if let Ok(target) = fs::canonicalize(&child_source) {
                if target.is_dir() {
                    copy_path(&target, &child_destination, true)?;
                } else {
                    fs::copy(&target, &child_destination)?;
                }
            }
        } else {
            fs::copy(&child_source, &child_destination)?;
        }
    }
    Ok(())
}

pub fn move_path(source: &Path, destination: &Path, is_directory: bool) -> io::Result<()> {
    if let Some(parent) = destination.parent() {
        ensure_dir(parent)?;
    }
    if fs::rename(source, destination).is_ok() {
        return Ok(());
    }
    copy_path(source, destination, is_directory)?;
    remove_path(source);
    Ok(())
}

pub fn remove_path(target: &Path) {
    if target.is_dir() && !target.is_symlink() {
        let _ = fs::remove_dir_all(target);
    } else {
        let _ = fs::remove_file(target);
    }
}

pub fn free_disk_bytes(path: &Path) -> u64 {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide = HSTRING::from(path.to_string_lossy().to_string());
        let mut free = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(&wide, Some(&mut free), None, None)
        };
        if ok.is_ok() {
            return free;
        }
    }
    u64::MAX
}

pub fn hash_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex(&hasher.finalize())
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn normalize_identity_path(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

pub fn file_identity(path: &Path, size: u64, mtime_ms: i64, item_type: &str) -> String {
    format!(
        "file:{}:{}:{}:{}",
        normalize_identity_path(path),
        size,
        mtime_ms,
        item_type
    )
}

pub fn directory_size(target: &Path) -> u64 {
    let mut total = 0u64;
    let mut entries = 0usize;
    let mut queue = vec![target.to_path_buf()];
    while let Some(current) = queue.pop() {
        let listing = match fs::read_dir(&current) {
            Ok(listing) => listing,
            Err(_) => continue,
        };
        for entry in listing.flatten() {
            entries += 1;
            if entries > 60_000 {
                return total;
            }
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => queue.push(path),
                Ok(kind) if kind.is_file() => {
                    if let Ok(meta) = entry.metadata() {
                        total += meta.len();
                    }
                }
                _ => {}
            }
        }
    }
    total
}

pub fn file_size_and_mtime(path: &Path) -> io::Result<(u64, i64)> {
    let meta = fs::metadata(path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Ok((meta.len(), mtime))
}

pub fn path_display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_invalid_characters() {
        let name = sanitize_file_name("a<b>c:d|e?.txt", "fallback");
        assert!(!name.contains('<'));
        assert!(!name.contains(':'));
        assert!(name.ends_with(".txt"));
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = Path::new("C:\\data");
        assert!(resolve_under(root, "../secret").is_none());
        assert!(resolve_under(root, "files/a.png").is_some());
    }

    #[test]
    fn confined_paths_compare_case_insensitively() {
        assert!(is_path_inside(
            Path::new("C:\\Users\\Me\\FlowTray\\files"),
            Path::new("c:\\users\\me\\flowtray")
        ));
        assert!(!is_path_inside(
            Path::new("C:\\Users\\Me\\Other"),
            Path::new("C:\\Users\\Me\\FlowTray")
        ));
    }
}
