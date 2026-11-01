//! Launch-at-login (registry Run key) and privileged auto-start (scheduled task).

use std::process::Command;

use windows::core::HSTRING;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_SET_VALUE, REG_SZ,
};

use crate::logger::LOGGER;

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME: &str = "FlowTray";
const TASK_NAME: &str = "FlowTray";

fn quote(value: &str) -> String {
    format!("\"{}\"", value)
}

pub fn current_executable() -> String {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub fn set_login_item(enabled: bool) -> bool {
    let executable = current_executable();
    if executable.is_empty() {
        return false;
    }
    unsafe {
        let mut key = HKEY::default();
        let path = HSTRING::from(RUN_KEY);
        if RegOpenKeyExW(HKEY_CURRENT_USER, &path, None, KEY_SET_VALUE, &mut key)
            != ERROR_SUCCESS
        {
            return false;
        }
        let name = HSTRING::from(VALUE_NAME);
        let result = if enabled {
            let command = format!("{} --autostart", quote(&executable));
            let bytes: Vec<u8> = command
                .encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(|unit| unit.to_le_bytes())
                .collect();
            RegSetValueExW(key, &name, None, REG_SZ, Some(&bytes))
        } else {
            RegDeleteValueW(key, &name)
        };
        let _ = RegCloseKey(key);
        result == ERROR_SUCCESS
    }
}

fn run_hidden(program: &str, args: &[&str]) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new(program)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
            .args(args)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn task_exists() -> bool {
    run_hidden("schtasks.exe", &["/Query", "/TN", TASK_NAME])
}

fn create_task() -> Result<(), String> {
    let executable = current_executable();
    let command = format!("{} --autostart", quote(&executable));
    let ok = run_hidden(
        "schtasks.exe",
        &[
            "/Create", "/F", "/TN", TASK_NAME, "/SC", "ONLOGON", "/RL", "HIGHEST", "/TR", &command,
        ],
    );
    if ok {
        Ok(())
    } else {
        Err("创建管理员自启动任务失败，请以管理员身份重启后再试。".to_string())
    }
}

fn delete_task() {
    let _ = run_hidden("schtasks.exe", &["/Delete", "/F", "/TN", TASK_NAME]);
}

pub struct AutostartOutcome {
    pub ok: bool,
    pub warning: Option<String>,
    pub error: Option<String>,
}

pub fn apply(launch_at_login: bool, launch_as_admin: bool, elevated: bool) -> AutostartOutcome {
    if launch_as_admin {
        if !elevated {
            set_login_item(false);
            return AutostartOutcome {
                ok: false,
                warning: Some(
                    "管理员自启动需要以管理员身份运行 FlowTray。请使用“以管理员身份重启”。".into(),
                ),
                error: None,
            };
        }
        if let Err(error) = create_task() {
            set_login_item(false);
            LOGGER.warn(
                "autostart.task_failed",
                Some(serde_json::json!({ "error": error })),
            );
            return AutostartOutcome {
                ok: false,
                warning: None,
                error: Some(error),
            };
        }
        set_login_item(false);
        return AutostartOutcome {
            ok: true,
            warning: None,
            error: None,
        };
    }
    delete_task();
    set_login_item(launch_at_login);
    AutostartOutcome {
        ok: true,
        warning: None,
        error: None,
    }
}

pub fn warning_for(launch_as_admin: bool, elevated: bool) -> Option<String> {
    if !launch_as_admin {
        return None;
    }
    if !elevated {
        return Some("已开启管理员自启动，但当前不是管理员进程，任务未能生效。".into());
    }
    if !task_exists() {
        return Some("管理员自启动任务未找到，请重新保存该设置。".into());
    }
    None
}

pub fn restart_as_admin() -> bool {
    let executable = current_executable();
    if executable.is_empty() {
        return false;
    }
    crate::winapi::restart_as_admin(std::path::Path::new(&executable))
}
