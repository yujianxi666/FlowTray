//! Thin, typed wrappers around the Win32 surface FlowTray needs: elevation,
//! foreground process, shell verbs, folder picker, cursor and monitor geometry.

use std::path::{Path, PathBuf};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE, CLSCTX_INPROC_SERVER,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, VK_CONTROL, VK_LBUTTON, VK_MENU, VK_SHIFT,
};
use windows::Win32::UI::Shell::{
    SHOpenFolderAndSelectItems, SHParseDisplayName, ShellExecuteW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, MessageBoxW, MB_ICONERROR, MB_OK,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::types::ForegroundInfo;

pub fn wide(value: &str) -> Vec<u16> {
    let mut buffer: Vec<u16> = value.encode_utf16().collect();
    buffer.push(0);
    buffer
}

pub fn pcwstr(value: &Vec<u16>) -> PCWSTR {
    PCWSTR::from_raw(value.as_ptr())
}

pub fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

pub fn set_app_user_model_id(identifier: &str) {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let value = windows::core::HSTRING::from(identifier);
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&value);
    }
}

fn process_name_for_pid(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR::from_raw(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if result.is_err() {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    }
}

fn window_title(hwnd: HWND) -> String {
    unsafe {
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let written = GetWindowTextW(hwnd, &mut buffer);
        String::from_utf16_lossy(&buffer[..written.max(0) as usize])
            .replace(['\r', '\n', '\t'], " ")
    }
}

pub fn friendly_app_name(process_name: &str) -> String {
    let key = process_name
        .to_lowercase()
        .trim_end_matches(".exe")
        .to_string();
    let friendly = match key.as_str() {
        "explorer" => "资源管理器",
        "chrome" => "Chrome",
        "msedge" => "Edge",
        "firefox" => "Firefox",
        "wechat" => "微信",
        "weixin" => "微信",
        "qq" => "QQ",
        "telegram" => "Telegram",
        "discord" => "Discord",
        "slack" => "Slack",
        "feishu" => "飞书",
        "lark" => "飞书",
        "dingtalk" => "钉钉",
        "code" => "VS Code",
        "notepad" => "记事本",
        "winword" => "Word",
        "excel" => "Excel",
        "powerpnt" => "PowerPoint",
        "outlook" => "Outlook",
        "thunderbird" => "Thunderbird",
        "wps" => "WPS",
        "acrord32" => "Acrobat Reader",
        "photoshop" => "Photoshop",
        "figma" => "Figma",
        "notion" => "Notion",
        "obsidian" => "Obsidian",
        "spotify" => "Spotify",
        "vlc" => "VLC",
        "flowtray" => "FlowTray",
        _ => "",
    };
    if friendly.is_empty() {
        process_name.trim_end_matches(".exe").to_string()
    } else {
        friendly.to_string()
    }
}

pub fn foreground_info() -> Option<ForegroundInfo> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process_name = process_name_for_pid(pid);
        if process_name.is_empty() {
            return None;
        }
        let title = window_title(hwnd);
        Some(ForegroundInfo {
            process_name: process_name.chars().take(120).collect(),
            title: title.chars().take(300).collect(),
            app_name: friendly_app_name(&process_name),
        })
    }
}

fn shell_open(target: &str) -> bool {
    let verb = wide("open");
    let file = wide(target);
    let result = unsafe {
        ShellExecuteW(
            None,
            pcwstr(&verb),
            pcwstr(&file),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    result.0 as isize > 32
}

pub fn open_path(path: &Path) -> Result<(), String> {
    let target = path.to_string_lossy().to_string();
    if target.contains('\0') {
        return Err("路径包含非法字符。".into());
    }
    if shell_open(&target) {
        Ok(())
    } else {
        Err("系统无法打开这个文件，可能缺少关联应用或权限不足。".into())
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("链接格式无效，无法打开。".into());
    }
    if shell_open(url) {
        Ok(())
    } else {
        Err("无法在浏览器中打开这个链接。".into())
    }
}

pub fn open_folder(path: &Path) -> Result<(), String> {
    let target = path.to_string_lossy().to_string();
    if shell_open(&target) {
        Ok(())
    } else {
        Err("无法打开目录。".into())
    }
}

pub fn reveal_path(path: &Path) {
    unsafe {
        let target = windows::core::HSTRING::from(path.to_string_lossy().to_string());
        let mut pidl = std::ptr::null_mut();
        let mut attributes = 0u32;
        if SHParseDisplayName(&target, None, &mut pidl, 0, Some(&mut attributes)).is_ok()
            && !pidl.is_null()
        {
            let _ = SHOpenFolderAndSelectItems(pidl, None, 0);
            CoTaskMemFree(Some(pidl as *const core::ffi::c_void));
        } else {
            let parent = path.parent().unwrap_or(Path::new("."));
            let _ = open_folder(parent);
        }
    }
}

pub fn restart_as_admin(executable: &Path) -> bool {
    let verb = wide("runas");
    let file = wide(&executable.to_string_lossy());
    let result = unsafe {
        ShellExecuteW(
            None,
            pcwstr(&verb),
            pcwstr(&file),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    result.0 as isize > 32
}

pub fn show_error(title: &str, message: &str) {
    let title_wide = wide(title);
    let message_wide = wide(message);
    unsafe {
        MessageBoxW(
            None,
            pcwstr(&message_wide),
            pcwstr(&title_wide),
            MB_OK | MB_ICONERROR,
        );
    }
}

pub fn confirm(title: &str, message: &str) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO,
    };
    let title_wide = wide(title);
    let message_wide = wide(message);
    let result = unsafe {
        MessageBoxW(
            None,
            pcwstr(&message_wide),
            pcwstr(&title_wide),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        )
    };
    result == IDYES
}

/// True while the primary mouse button is held (file drags keep it down).
pub fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

pub fn cursor_position() -> (i32, i32) {
    let mut point = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut point);
    }
    (point.x, point.y)
}

pub fn work_area_for(x: i32, y: i32) -> RECT {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            info.rcWork
        } else {
            RECT {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            }
        }
    }
}

pub fn primary_work_area() -> RECT {
    work_area_for(0, 0)
}

/// Ctrl / Shift / Alt pressed right now — used by the drop target so the
/// renderer can invert copy/cut exactly like the old DOM implementation.
pub fn modifier_state() -> (bool, bool, bool) {
    unsafe {
        let ctrl = GetKeyState(VK_CONTROL.0 as i32) < 0;
        let shift = GetKeyState(VK_SHIFT.0 as i32) < 0;
        let alt = GetKeyState(VK_MENU.0 as i32) < 0;
        (ctrl, shift, alt)
    }
}

pub fn left_mouse_down() -> bool {
    unsafe { GetKeyState(VK_LBUTTON.0 as i32) < 0 }
}

pub struct ComApartment;

impl ComApartment {
    /// Initialises OLE on the calling thread. `DoDragDrop` returns
    /// CO_E_NOTINITIALIZED (0x800401F0) unless OLE itself was initialised, which
    /// plain `CoInitializeEx` does not do.
    pub fn init() -> Option<ComApartment> {
        unsafe {
            let ole = windows::Win32::System::Ole::OleInitialize(None);
            if ole.is_ok() {
                return Some(ComApartment);
            }
            let result = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            if result.is_ok() || result.0 == windows::Win32::Foundation::RPC_E_CHANGED_MODE.0 {
                Some(ComApartment)
            } else {
                crate::logger::LOGGER.warn(
                    "com.init_failed",
                    Some(serde_json::json!({
                        "ole": ole.err().map(|error| error.code().0),
                        "co": result.0,
                    })),
                );
                None
            }
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::Ole::OleUninitialize();
        }
    }
}

/// Modern folder picker using `IFileOpenDialog`.
pub fn pick_folder(title: &str, initial: Option<&Path>) -> Option<PathBuf> {
    use windows::Win32::UI::Shell::{
        FileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH, IFileOpenDialog,
    };
    unsafe {
        let dialog: IFileOpenDialog =
            match CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) {
                Ok(dialog) => dialog,
                Err(_) => return pick_folder_legacy(title),
            };
        let mut options = match dialog.GetOptions() {
            Ok(options) => options,
            Err(_) => return pick_folder_legacy(title),
        };
        options |= FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM;
        let _ = dialog.SetOptions(options);
        let title_wide = windows::core::HSTRING::from(title);
        let _ = dialog.SetTitle(&title_wide);
        if let Some(start) = initial {
            let start_wide = windows::core::HSTRING::from(start.to_string_lossy().to_string());
            if let Ok(item) =
                windows::Win32::UI::Shell::SHCreateItemFromParsingName::<
                    _, _, windows::Win32::UI::Shell::IShellItem,
                >(&start_wide, None)
            {
                let _ = dialog.SetFolder(&item);
            }
        }
        if dialog.Show(None).is_err() {
            return None;
        }
        let item = dialog.GetResult().ok()?;
        let display = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = display.to_string().ok()?;
        CoTaskMemFree(Some(display.0 as *const core::ffi::c_void));
        Some(PathBuf::from(path))
    }
}

fn pick_folder_legacy(title: &str) -> Option<PathBuf> {
    use windows::Win32::UI::Shell::{
        SHBrowseForFolderW, SHGetPathFromIDListW, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS,
        BROWSEINFOW,
    };
    let title_wide = wide(title);
    let mut info = BROWSEINFOW {
        lpszTitle: pcwstr(&title_wide),
        ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
        ..Default::default()
    };
    unsafe {
        let pidl = SHBrowseForFolderW(&mut info);
        if pidl.is_null() {
            return None;
        }
        let mut buffer = [0u16; 260];
        let ok = SHGetPathFromIDListW(pidl, &mut buffer).as_bool();
        CoTaskMemFree(Some(pidl as *const core::ffi::c_void));
        if !ok {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(
            &buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(0)],
        )))
    }
}

pub fn bring_to_front(hwnd: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};
    unsafe {
        let window = HWND(hwnd as *mut core::ffi::c_void);
        let _ = ShowWindow(window, SW_RESTORE);
        let _ = SetForegroundWindow(window);
    }
}

pub fn find_window_by_title(title: &str) -> Option<isize> {
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    let title_wide = windows::core::HSTRING::from(title);
    unsafe {
        let hwnd = FindWindowW(None, &title_wide).ok()?;
        if hwnd.0.is_null() {
            None
        } else {
            Some(hwnd.0 as isize)
        }
    }
}

#[allow(dead_code)]
pub fn lparam_point(lparam: LPARAM) -> (i32, i32) {
    let value = lparam.0 as u32;
    let x = (value & 0xffff) as i16 as i32;
    let y = ((value >> 16) & 0xffff) as i16 as i32;
    (x, y)
}

/// "Save as" dialog for exporting the settings JSON.
pub fn save_file_dialog(title: &str, default_name: &str) -> Option<PathBuf> {
    use windows::Win32::UI::Shell::{
        FileSaveDialog, IFileSaveDialog, FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, SIGDN_FILESYSPATH,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let dialog: IFileSaveDialog =
            CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let mut options = dialog.GetOptions().ok()?;
        options |= FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT;
        let _ = dialog.SetOptions(options);
        let _ = dialog.SetTitle(&windows::core::HSTRING::from(title));
        let name = windows::core::HSTRING::from(default_name);
        let _ = dialog.SetFileName(&name);
        if dialog.Show(None).is_err() {
            return None;
        }
        let item = dialog.GetResult().ok()?;
        let display = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = display.to_string().ok()?;
        CoTaskMemFree(Some(display.0 as *const core::ffi::c_void));
        Some(PathBuf::from(path))
    }
}
