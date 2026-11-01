//! Thumbnail generation for image items.
//!
//! Only real image previews are stored; the renderer draws type badges for
//! everything else, which keeps dark/light theming consistent.

use std::path::Path;

use crate::fsx;

const THUMB_BOX: u32 = 360;

pub fn create_thumbnail(
    thumbs_root: &Path,
    storage_root: &Path,
    id: &str,
    source: &Path,
) -> Option<String> {
    if !fsx::is_image_path(source) {
        return None;
    }
    let reader = image::ImageReader::open(source).ok()?.with_guessed_format().ok()?;
    let decoded = reader.decode().ok()?;
    let thumbnail = decoded.thumbnail(THUMB_BOX, THUMB_BOX);
    let _ = fsx::ensure_dir(thumbs_root);
    let target = thumbs_root.join(format!("{id}.png"));
    thumbnail.save_with_format(&target, image::ImageFormat::Png).ok()?;
    let relative = fsx::to_relative(storage_root, &target)?;
    Some(relative)
}

/// Write a PNG buffer to disk and return the storage-relative path.
pub fn write_png(storage_files_root: &Path, name: &str, bytes: &[u8]) -> std::io::Result<std::path::PathBuf> {
    fsx::ensure_dir(storage_files_root)?;
    let target = fsx::unique_destination(storage_files_root, name);
    std::fs::write(&target, bytes)?;
    Ok(target)
}
