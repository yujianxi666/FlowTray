//! Tauri IPC command surface. Every command mirrors the preload API the React
//! renderer already speaks, so the UI layer only needed a thin bridge.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value};
use tauri::State;

use crate::actions;
use crate::app::App;
use crate::clipboard;
use crate::drag_out;
use crate::items;
use crate::types::*;
use crate::winapi;

type AppState<'a> = State<'a, Arc<App>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsPayload {
    pub paths: Vec<String>,
    #[serde(default)]
    pub options: Option<AddPathsOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPayload {
    pub text: String,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub source_app: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlsPayload {
    pub urls: Vec<String>,
    #[serde(default)]
    pub source_app: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePayload {
    pub data: Vec<u8>,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub source_app: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdPayload {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdsPayload {
    pub ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePayload {
    pub id: String,
    pub patch: UpdatePatch,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePatch {
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinPayload {
    pub ids: Vec<String>,
    pub pinned: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearPayload {
    #[serde(default)]
    pub include_pinned: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPayload {
    pub ids: Vec<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragPayload {
    pub ids: Vec<String>,
    pub effect: String,
}

#[derive(Debug, Deserialize)]
pub struct SettingsPayload {
    pub patch: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearDataPayload {
    pub include_settings: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizePayload {
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Deserialize)]
pub struct LockPayload {
    pub locked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionPayload {
    #[serde(default)]
    pub section: Option<String>,
}

// ---------------------------------------------------------------- application

#[tauri::command]
pub async fn app_get_snapshot(state: AppState<'_>) -> Result<ShelfSnapshot, String> {
    Ok(app_get_snapshot_inner(state))
}

fn app_get_snapshot_inner(state: AppState<'_>) -> ShelfSnapshot {
    state.snapshot()
}

#[tauri::command]
pub fn app_foreground() -> Option<ForegroundInfo> {
    winapi::foreground_info()
}

#[tauri::command]
pub fn app_toggle_window(state: AppState<'_>) {
    state.toggle_shelf();
}

#[tauri::command]
pub fn app_hide_window(state: AppState<'_>) {
    state.hide_shelf();
}

#[tauri::command]
pub fn app_quit(state: AppState<'_>) {
    crate::tray::quit(state.inner().clone());
}

#[tauri::command]
pub fn app_restart(state: AppState<'_>) {
    state.mark_quitting();
    if let Some(handle) = state.handle() {
        handle.restart();
    }
}

#[tauri::command]
pub fn app_restart_admin(state: AppState<'_>) -> bool {
    let ok = crate::autostart::restart_as_admin();
    if ok {
        state.mark_quitting();
        if let Some(handle) = state.handle() {
            let handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(350));
                handle.exit(0);
            });
        }
    } else {
        state.toast(
            "error",
            "请求管理员权限失败。你可以右键 FlowTray 图标，选择“以管理员身份运行”。",
        );
    }
    ok
}

#[tauri::command]
pub fn app_open_data_dir() {
    actions::open_data_dir();
}

#[tauri::command]
pub fn app_open_logs_dir() {
    actions::open_logs_dir();
}

// --------------------------------------------------------------------- items

#[tauri::command]
pub async fn items_add_paths(state: AppState<'_>, payload: PathsPayload) -> Result<MutationResult, String> {
    Ok(items_add_paths_inner(state, payload))
}

fn items_add_paths_inner(state: AppState<'_>, payload: PathsPayload) -> MutationResult {
    let options = payload.options.unwrap_or(AddPathsOptions {
        effect: None,
        source_app: None,
        source: None,
    });
    let bulk = payload.paths.len() >= crate::items::BULK_HINT;
    let result = state.mutate(|ctx| items::add_paths(ctx, payload.paths, &options));
    if bulk && result.added > 0 {
        state.toast(
            "info",
            &format!(
                "本次加入了 {} 个文件，可用顶部类型筛选快速定位。",
                result.added
            ),
        );
    }
    result
}

#[tauri::command]
pub async fn items_add_text(state: AppState<'_>, payload: TextPayload) -> Result<MutationResult, String> {
    Ok(items_add_text_inner(state, payload))
}

fn items_add_text_inner(state: AppState<'_>, payload: TextPayload) -> MutationResult {
    let input = AddTextInput {
        text: payload.text,
        html: payload.html,
        source_app: payload.source_app,
        source: payload.source,
    };
    state.mutate(|ctx| items::add_text(ctx, &input))
}

#[tauri::command]
pub async fn items_add_urls(state: AppState<'_>, payload: UrlsPayload) -> Result<MutationResult, String> {
    Ok(items_add_urls_inner(state, payload))
}

fn items_add_urls_inner(state: AppState<'_>, payload: UrlsPayload) -> MutationResult {
    state.mutate(|ctx| {
        items::add_urls(
            ctx,
            payload.urls,
            payload.source_app.as_deref(),
            Some("drop"),
        )
    })
}

#[tauri::command]
pub async fn items_add_clipboard(state: AppState<'_>) -> Result<MutationResult, String> {
    Ok(items_add_clipboard_inner(state))
}

fn items_add_clipboard_inner(state: AppState<'_>) -> MutationResult {
    actions::capture_from_shelf(state.inner())
}

#[tauri::command]
pub async fn items_add_image(state: AppState<'_>, payload: ImagePayload) -> Result<MutationResult, String> {
    Ok(items_add_image_inner(state, payload))
}

fn items_add_image_inner(state: AppState<'_>, payload: ImagePayload) -> MutationResult {
    if payload.data.len() > MAX_IMAGE_BYTES {
        return MutationResult::default().failed(ItemError::new(
            "too_large",
            "图片超过 64 MB，未添加。",
        ));
    }
    state.mutate(|ctx| {
        items::add_image_buffer(
            ctx,
            &payload.data,
            payload.name.as_deref(),
            payload.source_app.as_deref(),
            "drop",
        )
    })
}

#[tauri::command]
pub async fn items_update(state: AppState<'_>, payload: UpdatePayload) -> Result<MutationResult, String> {
    Ok(items_update_inner(state, payload))
}

fn items_update_inner(state: AppState<'_>, payload: UpdatePayload) -> MutationResult {
    state.mutate(|ctx| {
        items::update(
            ctx,
            &payload.id,
            payload.patch.pinned,
            payload.patch.name.as_deref(),
        )
    })
}

#[tauri::command]
pub async fn items_pin(state: AppState<'_>, payload: PinPayload) -> Result<MutationResult, String> {
    Ok(items_pin_inner(state, payload))
}

fn items_pin_inner(state: AppState<'_>, payload: PinPayload) -> MutationResult {
    state.mutate(|ctx| items::set_pinned(ctx, &payload.ids, payload.pinned))
}

#[tauri::command]
pub async fn items_remove(state: AppState<'_>, payload: IdsPayload) -> Result<MutationResult, String> {
    Ok(items_remove_inner(state, payload))
}

fn items_remove_inner(state: AppState<'_>, payload: IdsPayload) -> MutationResult {
    actions::remove_items(state.inner(), payload.ids)
}

#[tauri::command]
pub async fn items_clear(state: AppState<'_>, payload: ClearPayload) -> Result<MutationResult, String> {
    Ok(items_clear_inner(state, payload))
}

fn items_clear_inner(state: AppState<'_>, payload: ClearPayload) -> MutationResult {
    actions::clear_items(state.inner(), payload.include_pinned.unwrap_or(false))
}

#[tauri::command]
pub async fn items_undo(state: AppState<'_>) -> Result<MutationResult, String> {
    Ok(items_undo_inner(state))
}

fn items_undo_inner(state: AppState<'_>) -> MutationResult {
    actions::restore_undo(state.inner())
}

#[tauri::command]
pub async fn items_copy(state: AppState<'_>, payload: CopyPayload) -> Result<CopyResult, String> {
    Ok(items_copy_inner(state, payload))
}

fn items_copy_inner(state: AppState<'_>, payload: CopyPayload) -> CopyResult {
    actions::copy_items(
        state.inner(),
        payload.ids,
        payload.kind.unwrap_or_else(|| "auto".to_string()),
    )
}

#[tauri::command]
pub async fn items_open(state: AppState<'_>, payload: IdPayload) -> Result<CopyResult, String> {
    Ok(items_open_inner(state, payload))
}

fn items_open_inner(state: AppState<'_>, payload: IdPayload) -> CopyResult {
    actions::open_item(state.inner(), &payload.id)
}

#[tauri::command]
pub async fn items_reveal(state: AppState<'_>, payload: IdPayload) -> Result<CopyResult, String> {
    Ok(items_reveal_inner(state, payload))
}

fn items_reveal_inner(state: AppState<'_>, payload: IdPayload) -> CopyResult {
    actions::reveal_item(state.inner(), &payload.id)
}

#[tauri::command]
pub async fn items_relocate(state: AppState<'_>, payload: IdPayload) -> Result<MutationResult, String> {
    Ok(items_relocate_inner(state, payload))
}

fn items_relocate_inner(state: AppState<'_>, payload: IdPayload) -> MutationResult {
    actions::relocate_item(state.inner(), &payload.id)
}

#[tauri::command]
pub async fn items_restore_original(state: AppState<'_>, payload: IdPayload) -> Result<MutationResult, String> {
    Ok(items_restore_original_inner(state, payload))
}

fn items_restore_original_inner(state: AppState<'_>, payload: IdPayload) -> MutationResult {
    actions::restore_original(state.inner(), &payload.id)
}

#[tauri::command]
pub async fn items_detail(state: AppState<'_>, payload: IdPayload) -> Result<Option<ShelfItemDetail>, String> {
    Ok(items_detail_inner(state, payload))
}

fn items_detail_inner(state: AppState<'_>, payload: IdPayload) -> Option<ShelfItemDetail> {
    state.query(|ctx| items::get_detail(ctx, &payload.id))
}

#[tauri::command]
pub fn items_start_drag(state: AppState<'_>, payload: DragPayload) {
    drag_out::start(state.inner().clone(), payload.ids, payload.effect);
}

#[tauri::command]
pub fn items_clipboard_read() -> Option<serde_json::Value> {
    clipboard::read_raw().map(|raw| {
        serde_json::json!({
            "types": raw.types,
            "text": raw.text,
            "html": raw.html,
            "files": raw.files,
            "links": raw.links,
        })
    })
}

// ------------------------------------------------------------------ settings

#[tauri::command]
pub async fn settings_update(state: AppState<'_>, payload: SettingsPayload) -> Result<SettingsUpdateResult, String> {
    Ok(settings_update_inner(state, payload))
}

fn settings_update_inner(state: AppState<'_>, payload: SettingsPayload) -> SettingsUpdateResult {
    actions::update_settings(state.inner(), payload.patch)
}

#[tauri::command]
pub async fn settings_reset(state: AppState<'_>) -> Result<SettingsUpdateResult, String> {
    Ok(settings_reset_inner(state))
}

fn settings_reset_inner(state: AppState<'_>) -> SettingsUpdateResult {
    actions::reset_settings(state.inner())
}

#[tauri::command]
pub async fn settings_export(state: AppState<'_>) -> Result<ClearDataResult, String> {
    Ok(settings_export_inner(state))
}

fn settings_export_inner(state: AppState<'_>) -> ClearDataResult {
    actions::export_settings(state.inner())
}

#[tauri::command]
pub async fn settings_choose_storage(state: AppState<'_>) -> Result<StorageChoice, String> {
    Ok(settings_choose_storage_inner(state))
}

fn settings_choose_storage_inner(state: AppState<'_>) -> StorageChoice {
    actions::choose_storage_dir(state.inner())
}

#[tauri::command]
pub fn settings_open_storage(state: AppState<'_>) {
    actions::open_storage_dir(state.inner());
}

#[tauri::command]
pub fn settings_open_data() {
    actions::open_data_dir();
}

#[tauri::command]
pub fn settings_open_logs() {
    actions::open_logs_dir();
}

#[tauri::command]
pub async fn settings_clear_data(state: AppState<'_>, payload: ClearDataPayload) -> Result<ClearDataResult, String> {
    Ok(settings_clear_data_inner(state, payload))
}

fn settings_clear_data_inner(state: AppState<'_>, payload: ClearDataPayload) -> ClearDataResult {
    actions::clear_all_data(state.inner(), payload.include_settings)
}

// -------------------------------------------------------------------- window

#[tauri::command]
pub fn window_resize_live(state: AppState<'_>, payload: ResizePayload) {
    state.set_size_live(payload.width, payload.height);
}

#[tauri::command]
pub fn window_hide_ready(state: AppState<'_>) {
    state.hide_ready();
}

#[tauri::command]
pub fn window_resize_end(state: AppState<'_>) {
    state.commit_window_size();
}

#[tauri::command]
pub fn window_interaction_lock(state: AppState<'_>, payload: LockPayload) {
    state.set_interaction_locked(payload.locked);
}

#[tauri::command]
pub fn window_open_settings(state: AppState<'_>, payload: SectionPayload) {
    actions::open_settings(state.inner(), payload.section);
}

#[tauri::command]
pub fn window_open_onboarding(state: AppState<'_>) {
    actions::open_onboarding(state.inner());
}

// ----------------------------------------------------------------- shortcuts

#[tauri::command]
pub fn shortcuts_suspend(state: AppState<'_>) {
    if let Some(service) = state.hotkeys_service.lock().as_ref() {
        service.suspend();
    }
}

#[tauri::command]
pub fn shortcuts_resume(state: AppState<'_>) {
    if let Some(service) = state.hotkeys_service.lock().as_ref() {
        service.resume();
    }
    state.schedule_broadcast();
}

// ------------------------------------------------------------------------ e2e

#[tauri::command]
pub fn e2e_seed(state: AppState<'_>, specs: Vec<Value>) -> MutationResult {
    let mut combined = MutationResult::default();
    for spec in specs {
        let kind = spec.get("type").and_then(|value| value.as_str()).unwrap_or("");
        let source_app = spec
            .get("sourceApp")
            .and_then(|value| value.as_str())
            .unwrap_or("E2E")
            .to_string();
        let result = match kind {
            "text" => spec
                .get("text")
                .and_then(|value| value.as_str())
                .map(|text| {
                    state.mutate(|ctx| {
                        items::add_text(
                            ctx,
                            &AddTextInput {
                                text: text.to_string(),
                                html: None,
                                source_app: Some(source_app.clone()),
                                source: Some("manual".into()),
                            },
                        )
                    })
                }),
            "url" => spec
                .get("url")
                .and_then(|value| value.as_str())
                .map(|url| {
                    state.mutate(|ctx| {
                        items::add_urls(ctx, vec![url.to_string()], Some(&source_app), Some("manual"))
                    })
                }),
            _ => spec
                .get("path")
                .and_then(|value| value.as_str())
                .map(|path| {
                    state.mutate(|ctx| {
                        items::add_paths(
                            ctx,
                            vec![path.to_string()],
                            &AddPathsOptions {
                                effect: Some("copy".into()),
                                source_app: Some(source_app.clone()),
                                source: Some("drop".into()),
                            },
                        )
                    })
                }),
        };
        if let Some(result) = result {
            combined.added += result.added;
            combined.duplicates += result.duplicates;
            combined.errors.extend(result.errors);
        }
    }
    combined
}

#[tauri::command]
pub fn e2e_settings(state: AppState<'_>, payload: SettingsPayload) -> SettingsUpdateResult {
    actions::update_settings(state.inner(), payload.patch)
}

#[tauri::command]
pub fn e2e_sweep(state: AppState<'_>) {
    let outcome = {
        let mut notified = state.notified.lock();
        state.query(|ctx| items::sweep_expired(ctx, crate::ids::now_ms(), &mut notified))
    };
    if outcome.expired > 0 {
        actions::handle_expired(state.inner(), outcome.ids);
    }
    state.schedule_broadcast();
}

#[tauri::command]
pub fn e2e_flush(state: AppState<'_>) {
    state.schedule_broadcast();
}
