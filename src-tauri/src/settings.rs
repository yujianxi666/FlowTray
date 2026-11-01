//! Persisted settings: defaults, normalisation and validated patching.
//!
//! The shape mirrors the renderer's `Settings` type one-to-one so the settings
//! panel keeps working without a translation layer.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::types::{FieldError, SettingsUpdateResult};

pub const SENSITIVE_APPS_DEFAULT: &[&str] = &[
    "keepass",
    "keepassxc",
    "1password",
    "bitwarden",
    "lastpass",
    "dashline",
    "enpass",
    "roboform",
    "protonpass",
    "nordpass",
    "keeper",
    "keepersecurity",
    "sticky password",
    "authenticator",
    "credentialmanager",
    "credentialuibroker",
    "logonui",
    "cmdkey",
];

pub const SENSITIVE_TITLES_DEFAULT: &[&str] = &[
    "password",
    "passwort",
    "contraseña",
    "密码",
    "凭据",
    "credentials",
    "vault",
    "authenticator",
    "密码管理",
];

pub const TTL_OPTIONS: &[(&str, i64)] = &[
    ("1h", 60 * 60 * 1000),
    ("24h", 24 * 60 * 60 * 1000),
    ("7d", 7 * 24 * 60 * 60 * 1000),
];

pub fn ttl_ms(ttl: &str) -> Option<i64> {
    TTL_OPTIONS
        .iter()
        .find(|(value, _)| *value == ttl)
        .map(|(_, ms)| *ms)
}

pub fn compute_expires_at(ttl: &str, now: i64) -> Option<i64> {
    ttl_ms(ttl).map(|ms| now + ms)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub default_ttl: String,
    pub expiry_reminder: bool,
    pub capacity_mb: i64,
    pub storage_mode: String,
    pub storage_dir: String,
    pub launch_at_login: bool,
    pub launch_as_admin: bool,
    pub open_at_launch: bool,
    pub always_on_top: bool,
    pub hide_on_blur: bool,
    pub edge_reveal: bool,
    pub edge_delay_ms: i64,
    pub shelf_width: i64,
    pub shelf_height: i64,
    pub shelf_side: String,
    pub view_mode: String,
    pub show_source: bool,
    pub glass: bool,
    pub dark_background: String,
    pub dark_accent: String,
    pub light_background: String,
    pub light_accent: String,
    pub drop_effect: String,
    pub drag_out_effect: String,
    /// Remove the shelf entries after a successful drag-out (inversion key flips it).
    pub drag_out_auto_remove: bool,
    /// Keep clipboard captures in their own collection instead of the main list.
    pub clipboard_separate: bool,
    pub drag_modifier: String,
    pub safe_drag_copy: bool,
    pub clipboard_monitor: bool,
    pub clipboard_max_items: i64,
    pub sensitive_apps: Vec<String>,
    pub sensitive_titles: Vec<String>,
    pub hotkey_toggle: String,
    pub hotkey_capture: String,
    pub onboarding_done: bool,
    pub reduce_motion: bool,
    pub log_level: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            default_ttl: "24h".into(),
            expiry_reminder: true,
            capacity_mb: 2048,
            storage_mode: "reference".into(),
            storage_dir: String::new(),
            launch_at_login: false,
            launch_as_admin: false,
            open_at_launch: true,
            always_on_top: true,
            hide_on_blur: false,
            edge_reveal: true,
            edge_delay_ms: 450,
            shelf_width: 396,
            shelf_height: 680,
            shelf_side: "right".into(),
            view_mode: "list".into(),
            show_source: true,
            glass: true,
            dark_background: "#000000".into(),
            dark_accent: "#FFFFFF".into(),
            light_background: "#FFFFFF".into(),
            light_accent: "#808080".into(),
            drop_effect: "copy".into(),
            drag_out_effect: "copy".into(),
            drag_out_auto_remove: false,
            clipboard_separate: true,
            drag_modifier: "ctrl".into(),
            safe_drag_copy: true,
            clipboard_monitor: false,
            clipboard_max_items: 200,
            sensitive_apps: SENSITIVE_APPS_DEFAULT.iter().map(|s| s.to_string()).collect(),
            sensitive_titles: SENSITIVE_TITLES_DEFAULT
                .iter()
                .map(|s| s.to_string())
                .collect(),
            hotkey_toggle: "Control+Alt+Shift+Space".into(),
            hotkey_capture: "Control+Shift+D".into(),
            onboarding_done: false,
            reduce_motion: false,
            log_level: "info".into(),
        }
    }
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

fn clamp_int(value: i64, min: i64, max: i64) -> i64 {
    value.max(min).min(max)
}

fn one_of(value: &str, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

pub fn sanitize_sensitive_list(values: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let trimmed = value.trim().to_lowercase();
        if trimmed.is_empty() || trimmed.chars().count() > 80 || !seen.insert(trimmed.clone()) {
            continue;
        }
        result.push(trimmed);
        if result.len() >= 100 {
            break;
        }
    }
    result
}

impl Settings {
    /// Clamp every field into the supported range. Unknown enum values fall back
    /// to the defaults instead of failing the whole load.
    pub fn normalize(&mut self) {
        self.theme = one_of(&self.theme, &["system", "dark", "light"], "system");
        self.default_ttl = one_of(&self.default_ttl, &["1h", "24h", "7d", "never"], "24h");
        self.capacity_mb = clamp_int(self.capacity_mb, 0, 1024 * 1024);
        self.storage_mode = one_of(&self.storage_mode, &["reference", "copy"], "reference");
        self.edge_delay_ms = clamp_int(self.edge_delay_ms, 150, 2000);
        self.shelf_width = clamp_int(self.shelf_width, 340, 560);
        self.shelf_height = clamp_int(self.shelf_height, 480, 1000);
        self.shelf_side = one_of(&self.shelf_side, &["left", "right"], "right");
        self.view_mode = one_of(&self.view_mode, &["list", "grid"], "list");
        self.drop_effect = one_of(&self.drop_effect, &["copy", "cut"], "copy");
        self.drag_out_effect = one_of(&self.drag_out_effect, &["copy", "cut"], "copy");
        self.drag_modifier = one_of(&self.drag_modifier, &["ctrl", "shift", "alt"], "ctrl");
        self.clipboard_max_items = clamp_int(self.clipboard_max_items, 10, 1000);
        self.log_level = one_of(&self.log_level, &["info", "debug"], "info");
        if !is_hex_color(&self.dark_background) {
            self.dark_background = "#000000".into();
        }
        if !is_hex_color(&self.dark_accent) {
            self.dark_accent = "#FFFFFF".into();
        }
        if !is_hex_color(&self.light_background) {
            self.light_background = "#FFFFFF".into();
        }
        if !is_hex_color(&self.light_accent) {
            self.light_accent = "#808080".into();
        }
        if self.storage_dir.chars().count() > 1024 {
            self.storage_dir = String::new();
        }
        self.sensitive_apps = sanitize_sensitive_list(&self.sensitive_apps);
        self.sensitive_titles = sanitize_sensitive_list(&self.sensitive_titles);
        self.hotkey_toggle = self.hotkey_toggle.trim().to_string();
        self.hotkey_capture = self.hotkey_capture.trim().to_string();
        if self.hotkey_toggle.chars().count() < 3 || self.hotkey_toggle.chars().count() > 64 {
            self.hotkey_toggle = Settings::default().hotkey_toggle;
        }
        if self.hotkey_capture.chars().count() < 3 || self.hotkey_capture.chars().count() > 64 {
            self.hotkey_capture = Settings::default().hotkey_capture;
        }
    }

    /// Apply a partial update coming from the renderer. Returns the list of
    /// rejected fields; accepted fields are written into `self`.
    pub fn apply_patch(&mut self, patch: &Map<String, Value>) -> SettingsUpdateResult {
        let mut errors: Vec<FieldError> = Vec::new();
        let mut reject = |field: &str, message: &str| {
            errors.push(FieldError {
                field: field.to_string(),
                message: message.to_string(),
            })
        };

        for (key, value) in patch {
            match key.as_str() {
                "storageDir" => {
                    reject("storageDir", "请使用“更改存储位置”来迁移数据。");
                }
                "theme" => match value.as_str() {
                    Some(v @ ("system" | "dark" | "light")) => self.theme = v.into(),
                    _ => reject("theme", "主题取值无效。"),
                },
                "defaultTtl" => match value.as_str() {
                    Some(v @ ("1h" | "24h" | "7d" | "never")) => self.default_ttl = v.into(),
                    _ => reject("defaultTtl", "有效期取值无效。"),
                },
                "expiryReminder" => self.expiry_reminder = read_bool(value, &mut reject, key),
                "capacityMb" => match value.as_i64() {
                    Some(v) if (0..=1_048_576).contains(&v) => self.capacity_mb = v,
                    _ => reject("capacityMb", "容量上限需要是 0 到 1048576 之间的整数。"),
                },
                "storageMode" => match value.as_str() {
                    Some(v @ ("reference" | "copy")) => self.storage_mode = v.into(),
                    _ => reject("storageMode", "存储模式取值无效。"),
                },
                "launchAtLogin" => self.launch_at_login = read_bool(value, &mut reject, key),
                "launchAsAdmin" => self.launch_as_admin = read_bool(value, &mut reject, key),
                "openAtLaunch" => self.open_at_launch = read_bool(value, &mut reject, key),
                "alwaysOnTop" => self.always_on_top = read_bool(value, &mut reject, key),
                "hideOnBlur" => self.hide_on_blur = read_bool(value, &mut reject, key),
                "edgeReveal" => self.edge_reveal = read_bool(value, &mut reject, key),
                "edgeDelayMs" => match value.as_i64() {
                    Some(v) if (150..=2000).contains(&v) => self.edge_delay_ms = v,
                    _ => reject("edgeDelayMs", "触发停留时间需要是 150 到 2000 毫秒。"),
                },
                "shelfWidth" => match value.as_i64() {
                    Some(v) if (340..=560).contains(&v) => self.shelf_width = v,
                    _ => reject("shelfWidth", "宽度需要是 340 到 560 之间。"),
                },
                "shelfHeight" => match value.as_i64() {
                    Some(v) if (480..=1000).contains(&v) => self.shelf_height = v,
                    _ => reject("shelfHeight", "高度需要是 480 到 1000 之间。"),
                },
                "shelfSide" => match value.as_str() {
                    Some(v @ ("left" | "right")) => self.shelf_side = v.into(),
                    _ => reject("shelfSide", "停靠方向取值无效。"),
                },
                "viewMode" => match value.as_str() {
                    Some(v @ ("list" | "grid")) => self.view_mode = v.into(),
                    _ => reject("viewMode", "视图取值无效。"),
                },
                "showSource" => self.show_source = read_bool(value, &mut reject, key),
                "glass" => self.glass = read_bool(value, &mut reject, key),
                "darkBackground" => set_color(&mut self.dark_background, value, "darkBackground", &mut reject),
                "darkAccent" => set_color(&mut self.dark_accent, value, "darkAccent", &mut reject),
                "lightBackground" => set_color(&mut self.light_background, value, "lightBackground", &mut reject),
                "lightAccent" => set_color(&mut self.light_accent, value, "lightAccent", &mut reject),
                "dropEffect" => match value.as_str() {
                    Some(v @ ("copy" | "cut")) => self.drop_effect = v.into(),
                    _ => reject("dropEffect", "拖入方式取值无效。"),
                },
                "dragOutEffect" => match value.as_str() {
                    Some(v @ ("copy" | "cut")) => self.drag_out_effect = v.into(),
                    _ => reject("dragOutEffect", "拖出方式取值无效。"),
                },
                "dragOutAutoRemove" => match value.as_bool() {
                    Some(flag) => self.drag_out_auto_remove = flag,
                    None => reject("dragOutAutoRemove", "拖出后删除必须是布尔值。"),
                },
                "clipboardSeparate" => match value.as_bool() {
                    Some(flag) => self.clipboard_separate = flag,
                    None => reject("clipboardSeparate", "剪贴板分组必须是布尔值。"),
                },
                "dragModifier" => match value.as_str() {
                    Some(v @ ("ctrl" | "shift" | "alt")) => self.drag_modifier = v.into(),
                    _ => reject("dragModifier", "切换键取值无效。"),
                },
                "safeDragCopy" => self.safe_drag_copy = read_bool(value, &mut reject, key),
                "clipboardMonitor" => self.clipboard_monitor = read_bool(value, &mut reject, key),
                "clipboardMaxItems" => match value.as_i64() {
                    Some(v) if (10..=1000).contains(&v) => self.clipboard_max_items = v,
                    _ => reject("clipboardMaxItems", "剪贴板条数需要是 10 到 1000 之间。"),
                },
                "sensitiveApps" => {
                    if let Some(list) = read_string_list(value, 100, 80) {
                        self.sensitive_apps = sanitize_sensitive_list(&list);
                    } else {
                        reject("sensitiveApps", "排除列表格式无效。");
                    }
                }
                "sensitiveTitles" => {
                    if let Some(list) = read_string_list(value, 100, 80) {
                        self.sensitive_titles = sanitize_sensitive_list(&list);
                    } else {
                        reject("sensitiveTitles", "标题排除列表格式无效。");
                    }
                }
                "hotkeyToggle" => match value.as_str() {
                    Some(v) if (3..=64).contains(&v.trim().chars().count()) => {
                        self.hotkey_toggle = v.trim().to_string()
                    }
                    _ => reject("hotkeyToggle", "呼出快捷键格式无效。"),
                },
                "hotkeyCapture" => match value.as_str() {
                    Some(v) if (3..=64).contains(&v.trim().chars().count()) => {
                        self.hotkey_capture = v.trim().to_string()
                    }
                    _ => reject("hotkeyCapture", "存入快捷键格式无效。"),
                },
                "onboardingDone" => self.onboarding_done = read_bool(value, &mut reject, key),
                "reduceMotion" => self.reduce_motion = read_bool(value, &mut reject, key),
                "logLevel" => match value.as_str() {
                    Some(v @ ("info" | "debug")) => self.log_level = v.into(),
                    _ => reject("logLevel", "日志级别取值无效。"),
                },
                _ => {}
            }
        }

        if self.hotkey_toggle == self.hotkey_capture {
            reject("hotkey", "两个快捷键不能相同。");
        }

        if errors.is_empty() {
            self.normalize();
            SettingsUpdateResult::ok()
        } else {
            SettingsUpdateResult {
                ok: false,
                errors,
            }
        }
    }

    pub fn capacity_bytes(&self) -> i64 {
        self.capacity_mb * 1024 * 1024
    }
}

fn read_bool(
    value: &Value,
    reject: &mut impl FnMut(&str, &str),
    key: &str,
) -> bool {
    match value.as_bool() {
        Some(v) => v,
        None => {
            reject(key, "需要一个布尔值。");
            false
        }
    }
}

fn set_color(target: &mut String, value: &Value, key: &str, reject: &mut impl FnMut(&str, &str)) {
    match value.as_str() {
        Some(v) if is_hex_color(v) => *target = v.to_string(),
        _ => reject(key, "颜色需要是 #RRGGBB 格式。"),
    }
}

fn read_string_list(value: &Value, max_items: usize, max_len: usize) -> Option<Vec<String>> {
    let array = value.as_array()?;
    let mut result = Vec::new();
    for entry in array.iter().take(max_items) {
        let text = entry.as_str()?.trim().to_string();
        if text.is_empty() || text.chars().count() > max_len {
            continue;
        }
        result.push(text);
    }
    Some(result)
}

/// Is the active foreground application excluded from clipboard capture?
pub fn is_sensitive_source(
    process_name: &str,
    title: &str,
    apps: &[String],
    titles: &[String],
) -> bool {
    let process = process_name
        .to_lowercase()
        .trim_end_matches(".exe")
        .trim()
        .to_string();
    if !process.is_empty() && apps.iter().any(|app| app.trim() == process) {
        return true;
    }
    let lower_title = title.to_lowercase();
    titles
        .iter()
        .any(|keyword| !keyword.trim().is_empty() && lower_title.contains(keyword.trim()))
}
