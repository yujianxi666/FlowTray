//! Well-known FlowTray paths. Everything lives under the per-user data folder,
//! matching the original Electron build so an upgrade keeps the same location.

use std::path::{Path, PathBuf};

pub const GUTTER: i32 = 0;

pub fn user_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("FLOWTRAY_USER_DATA") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    // The installed build keeps everything next to the program (the installer
    // drops a marker file), so uninstalling the folder removes the data too.
    if let Some(root) = portable_data_dir() {
        return root;
    }
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    if appdata.is_empty() {
        return std::env::temp_dir().join("FlowTray");
    }
    Path::new(&appdata).join("FlowTray")
}

/// `<install dir>\data` when the installer placed `FlowTray.portable` next to
/// the executable.
pub fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if dir.join("FlowTray.portable").exists() {
        Some(dir.join("data"))
    } else {
        None
    }
}

pub fn default_storage_root() -> PathBuf {
    user_data_dir().join("storage")
}

pub fn resolve_storage_root(storage_dir: &str) -> PathBuf {
    let trimmed = storage_dir.trim();
    if trimmed.is_empty() {
        default_storage_root()
    } else {
        PathBuf::from(trimmed)
    }
}

pub fn db_file() -> PathBuf {
    user_data_dir().join("flowtray.db")
}

pub fn logs_dir() -> PathBuf {
    user_data_dir().join("logs")
}

pub fn drag_cache_dir() -> PathBuf {
    user_data_dir().join("drag-cache")
}

pub fn tray_icon_bytes() -> &'static [u8] {
    include_bytes!("../icons/tray.png")
}

/// Windows 11 reports build 22000+; the CSS glass effect is available there.
pub fn is_windows11() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOW};
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        let ok = unsafe { GetVersionExW(&mut info) }.is_ok();
        return ok && info.dwBuildNumber >= 22000;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default()
}
