//! Domain types shared with the React frontend.
//!
//! Every struct serialises to the exact JSON shape the renderer was written
//! against, so the UI layer can stay almost unchanged after the Tauri port.

use serde::{Deserialize, Serialize};

pub const MAX_TEXT_CHARS: usize = 2_000_000;
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_DROP_ITEMS: usize = 200;
pub const MAX_ITEMS_TOTAL: usize = 3000;
pub const EXPIRY_REMINDER_MS: i64 = 15 * 60 * 1000;
pub const TRASH_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    File,
    Folder,
    Image,
    Text,
    Url,
}

impl ItemType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ItemType::File => "file",
            ItemType::Folder => "folder",
            ItemType::Image => "image",
            ItemType::Text => "text",
            ItemType::Url => "url",
        }
    }

    pub fn parse(value: &str) -> ItemType {
        match value {
            "folder" => ItemType::Folder,
            "image" => ItemType::Image,
            "text" => ItemType::Text,
            "url" => ItemType::Url,
            _ => ItemType::File,
        }
    }

    pub fn is_file_like(&self) -> bool {
        matches!(self, ItemType::File | ItemType::Folder | ItemType::Image)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ItemError {
    pub fn new(code: &str, message: impl Into<String>) -> ItemError {
        ItemError {
            code: code.to_string(),
            message: message.into(),
            name: None,
        }
    }

    pub fn named(code: &str, message: impl Into<String>, name: impl Into<String>) -> ItemError {
        ItemError {
            code: code.to_string(),
            message: message.into(),
            name: Some(name.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub ok: bool,
    pub added: usize,
    pub duplicates: usize,
    pub errors: Vec<ItemError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo: Option<UndoState>,
}

impl Default for MutationResult {
    fn default() -> Self {
        MutationResult {
            ok: true,
            added: 0,
            duplicates: 0,
            errors: Vec::new(),
            message: None,
            undo: None,
        }
    }
}

impl MutationResult {
    pub fn failed(mut self, error: ItemError) -> MutationResult {
        self.ok = false;
        self.errors.push(error);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItemView {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub name: String,
    pub preview: Option<String>,
    pub text_content: Option<String>,
    pub text_length: Option<usize>,
    pub url: Option<String>,
    pub path: Option<String>,
    pub ext: Option<String>,
    pub size: i64,
    pub source_app: Option<String>,
    pub source: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub pinned: bool,
    pub status: String,
    pub storage_mode: String,
    pub has_thumb: bool,
    pub thumb_url: Option<String>,
    pub moved_in: bool,
    pub expires_in_ms: Option<i64>,
    pub expiring_soon: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItemDetail {
    #[serde(flatten)]
    pub view: ShelfItemView,
    pub text_content: Option<String>,
    pub original_path: Option<String>,
    pub hash: Option<String>,
    pub last_checked_at: Option<i64>,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub stored_bytes: i64,
    pub referenced_bytes: i64,
    pub capacity_bytes: i64,
    pub item_count: i64,
    pub pinned_count: i64,
    pub missing_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub accelerator: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for HotkeyStatus {
    fn default() -> Self {
        HotkeyStatus {
            accelerator: String::new(),
            ok: false,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyPair {
    pub toggle: HotkeyStatus,
    pub capture: HotkeyStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub version: String,
    pub runtime_version: String,
    pub platform: String,
    pub is_packaged: bool,
    pub is_elevated: bool,
    pub supports_acrylic: bool,
    pub data_path: String,
    pub storage_path: String,
    pub logs_path: String,
    pub autostart_warning: Option<String>,
    pub hotkeys: HotkeyPair,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub kind: String,
    pub count: usize,
    pub expires_at: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfSnapshot {
    pub revision: u64,
    pub items: Vec<ShelfItemView>,
    pub settings: crate::settings::Settings,
    pub usage: StorageUsage,
    pub host: HostInfo,
    pub undo: Option<UndoState>,
    pub now: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdateResult {
    pub ok: bool,
    pub errors: Vec<FieldError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

impl SettingsUpdateResult {
    pub fn ok() -> SettingsUpdateResult {
        SettingsUpdateResult {
            ok: true,
            errors: Vec::new(),
        }
    }

    pub fn error(field: &str, message: impl Into<String>) -> SettingsUpdateResult {
        SettingsUpdateResult {
            ok: false,
            errors: vec![FieldError {
                field: field.to_string(),
                message: message.into(),
            }],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl CopyResult {
    pub fn ok() -> CopyResult {
        CopyResult {
            ok: true,
            message: None,
        }
    }

    pub fn with_message(message: impl Into<String>) -> CopyResult {
        CopyResult {
            ok: true,
            message: Some(message.into()),
        }
    }

    pub fn failure(message: impl Into<String>) -> CopyResult {
        CopyResult {
            ok: false,
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearDataResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundInfo {
    pub process_name: String,
    pub title: String,
    pub app_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageChoice {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Commands pushed from the backend into the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum UiCommand {
    OpenSettings { section: Option<String> },
    OpenOnboarding,
    OpenClearConfirm,
    FocusSearch,
    Toast { tone: String, message: String },
    DragOutStart { effect: String, count: usize },
    DragOutEnd { effect: String, count: usize },
    WindowShown { reason: String },
    WindowWillHide,
    ItemsExpired { count: usize },
    Blur,
}

/// Native drag payload produced by the custom OLE drop target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropPayload {
    pub paths: Vec<String>,
    pub text: String,
    pub html: String,
    pub urls: Vec<String>,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutRequest {
    pub ids: Vec<String>,
    pub effect: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPathsOptions {
    pub effect: Option<String>,
    pub source_app: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTextInput {
    pub text: String,
    pub html: Option<String>,
    pub source_app: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddImageInput {
    pub data: Vec<u8>,
    pub mime: String,
    pub name: Option<String>,
    pub source_app: Option<String>,
}
