//! Landing zone resolution for the OLE-free drag-out.
//!
//! Windows will not let a background (or WebView2-hosted) thread own the mouse
//! capture for a modal `DoDragDrop`, so the native drag session never runs here.
//! Instead the shelf tracks the pointer itself and, when the button is released,
//! resolves what is under the cursor:
//!
//! - the desktop → the files are copied (or moved) into the desktop folder;
//! - anything else → the files go to the clipboard and the user pastes them.
//!
//! `IFileOperation` is deliberately avoided: a plain copy with collision-safe
//! names has the same result for a shelf of temporary files and cannot fail
//! halfway with a progress dialog we cannot cancel.

use std::path::{Path, PathBuf};

use windows::core::PCWSTR;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Desktop, KF_FLAG_DEFAULT};
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetParent, WindowFromPoint};

fn desktop_dir() -> Option<PathBuf> {
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None).ok()?;
        let text = path.to_string().ok()?;
        Some(PathBuf::from(text))
    }
}

fn class_name(hwnd: windows::Win32::Foundation::HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

/// Folder the drop should land in, if the pointer is over a shell surface we can
/// write to directly.
pub fn landing_folder() -> Option<(PathBuf, String)> {
    let (x, y) = crate::winapi::cursor_position();
    let mut hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    if hwnd.0.is_null() {
        return None;
    }
    // Walk up a few levels: the desktop is `Progman`/`WorkerW` with a
    // `SHELLDLL_DefView` child, Explorer windows are `CabinetWClass`.
    let mut is_desktop = false;
    for _ in 0..6 {
        match class_name(hwnd).as_str() {
            "Progman" | "WorkerW" => {
                is_desktop = true;
                break;
            }
            "SHELLDLL_DefView" => {
                is_desktop = true;
                break;
            }
            _ => {}
        }
        let Ok(parent) = (unsafe { GetParent(hwnd) }) else {
            break;
        };
        if parent.0.is_null() {
            break;
        }
        hwnd = parent;
    }
    if is_desktop {
        let folder = desktop_dir()?;
        if folder.is_dir() {
            return Some((folder, "桌面".to_string()));
        }
    }
    None
}

/// Copies `files` into `destination`, never overwriting an existing name.
/// Returns the number of transferred entries.
pub fn copy_into(destination: &Path, files: &[String], move_files: bool) -> (usize, Vec<String>) {
    let mut copied = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for item in files {
        let source = Path::new(item);
        let Some(name) = source.file_name().map(|value| value.to_string_lossy().to_string()) else {
            errors.push(format!("无法识别的路径：{item}"));
            continue;
        };
        let target = crate::fsx::unique_destination(destination, &name);
        let is_directory = source.is_dir();
        let result = if move_files {
            crate::fsx::move_path(source, &target, true)
        } else {
            crate::fsx::copy_path(source, &target, is_directory)
        };
        match result {
            Ok(()) => copied += 1,
            Err(error) => errors.push(format!("{name}: {error}")),
        }
    }
    (copied, errors)
}

/// True while the cursor is above one of our own windows (the shelf itself).
pub fn over_own_window() -> bool {
    let (x, y) = crate::winapi::cursor_position();
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    if hwnd.0.is_null() {
        return false;
    }
    let mut pid = 0u32;
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid == std::process::id()
}

/// Returns the folder a drag landed on, for logging.
pub fn describe_landing() -> String {
    match landing_folder() {
        Some((path, label)) => format!("{label} ({})", path.display()),
        None => "other".to_string(),
    }
}

#[allow(dead_code)]
pub fn logs_hint() -> PCWSTR {
    PCWSTR::null()
}
