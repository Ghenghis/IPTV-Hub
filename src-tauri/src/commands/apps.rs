//! `apps` command group. Each function is a Tauri command — agents implementing them
//! follow the pattern of `list_apps`: typed input, typed output, real DB call, no
//! placeholder data.

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, SourceType};

/// One row from the `apps` table — kept as a tuple alias for cheap `query_as` decoding
/// and to satisfy clippy's `type_complexity` lint without spelling out the seven-tuple
/// at every call site.
type AppDbRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// View shape returned to the frontend. Joins the manifest's static config with
/// the DB's runtime state so the frontend gets everything in one round trip.
#[derive(Debug, Clone, Serialize)]
pub struct AppView {
    pub id: String,
    pub name: String,
    pub source_type: SourceType,
    pub favorite: bool,
    pub enabled: bool,
    pub status: String,
    pub status_message: Option<String>,
    pub current_version: Option<String>,
    pub current_sha: Option<String>,
    pub last_poll_at: Option<String>,
    pub last_success_at: Option<String>,
    pub icon_kind: Option<String>,
    pub icon_value: Option<String>,
    pub sub_label: String,
}

fn build_sub_label(app: &AppEntry) -> String {
    match app.source_type {
        SourceType::Git | SourceType::Web => format!("upstream/{}", app.id),
        SourceType::Installer => "installed · Program Files".to_string(),
        SourceType::ReleaseBinary => app
            .source
            .as_ref()
            .and_then(|v| v.get("repo").and_then(|r| r.as_str()))
            .map_or_else(|| "release".to_string(), |repo| format!("release · {repo}")),
        SourceType::TizenIpk => app
            .source
            .as_ref()
            .and_then(|v| v.get("asset_pattern").and_then(|r| r.as_str()))
            .map_or_else(|| "ipk".to_string(), |p| format!("ipk · {p}")),
    }
}

#[tauri::command]
pub async fn list_apps(state: State<'_, AppState>) -> Result<Vec<AppView>, CoreError> {
    // Clone the manifest into owned data before any `.await` so the parking_lot read
    // guard (which is `!Send`) does not get held across an await boundary.
    let apps: Vec<AppEntry> = state.manifest.read().apps.clone();
    let mut out = Vec::with_capacity(apps.len());

    // Pull DB rows once and zip with manifest order.
    let rows: Vec<AppDbRow> = sqlx::query_as(
        "SELECT id, status, status_message, current_version, current_sha, last_poll_at, \
         last_success_at FROM apps",
    )
    .fetch_all(&state.db)
    .await
    .map_err(CoreError::from)?;

    let by_id: std::collections::HashMap<String, _> =
        rows.into_iter().map(|r| (r.0.clone(), r)).collect();

    for app in &apps {
        let row = by_id.get(&app.id);
        out.push(AppView {
            id: app.id.clone(),
            name: app.name.clone(),
            source_type: app.source_type,
            favorite: app.favorite,
            enabled: app.enabled,
            status: row.map_or_else(|| "idle".into(), |r| r.1.clone()),
            status_message: row.and_then(|r| r.2.clone()),
            current_version: row.and_then(|r| r.3.clone()),
            current_sha: row.and_then(|r| r.4.clone()),
            last_poll_at: row.and_then(|r| r.5.clone()),
            last_success_at: row.and_then(|r| r.6.clone()),
            icon_kind: app.icon.as_ref().map(|i| format!("{:?}", i.kind).to_lowercase()),
            icon_value: app.icon.as_ref().map(|i| i.value.clone()),
            sub_label: build_sub_label(app),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_app(id: String, state: State<'_, AppState>) -> Result<AppView, CoreError> {
    let all = list_apps(state).await?;
    all.into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| CoreError::config(format!("app not found: {id}")))
}

// The following commands are owned by Agent 14, implemented against the same pattern:
// `add_app`, `remove_app`, `set_favorite`, `set_enabled`. Each one updates the manifest
// via `state.manifest.replace(...)` and emits an `apps:changed` event for the frontend.

#[tauri::command]
pub async fn add_app(
    entry: AppEntry,
    state: State<'_, AppState>,
) -> Result<(), CoreError> {
    let mut new_manifest = state.manifest.read().clone();
    if new_manifest.apps.iter().any(|a| a.id == entry.id) {
        return Err(CoreError::config(format!("duplicate app id: {}", entry.id)));
    }
    let app_id = entry.id.clone();
    new_manifest.apps.push(entry);
    state.manifest.replace(new_manifest).await?;
    sqlx::query("INSERT OR IGNORE INTO apps (id, name, source_type, status) VALUES (?, ?, 'idle', 'idle')")
        .bind(&app_id)
        .bind(&app_id)
        .execute(&state.db)
        .await
        .map_err(CoreError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn remove_app(id: String, state: State<'_, AppState>) -> Result<(), CoreError> {
    let mut new_manifest = state.manifest.read().clone();
    let before = new_manifest.apps.len();
    new_manifest.apps.retain(|a| a.id != id);
    if new_manifest.apps.len() == before {
        return Err(CoreError::config(format!("app not found: {id}")));
    }
    state.manifest.replace(new_manifest).await?;
    sqlx::query("DELETE FROM apps WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(CoreError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn set_favorite(
    id: String,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<(), CoreError> {
    let mut new_manifest = state.manifest.read().clone();
    let app = new_manifest.apps.iter_mut().find(|a| a.id == id)
        .ok_or_else(|| CoreError::config(format!("app not found: {id}")))?;
    app.favorite = favorite;
    state.manifest.replace(new_manifest).await?;
    Ok(())
}

#[tauri::command]
pub async fn set_enabled(
    id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), CoreError> {
    let mut new_manifest = state.manifest.read().clone();
    let app = new_manifest.apps.iter_mut().find(|a| a.id == id)
        .ok_or_else(|| CoreError::config(format!("app not found: {id}")))?;
    app.enabled = enabled;
    state.manifest.replace(new_manifest).await?;
    Ok(())
}
