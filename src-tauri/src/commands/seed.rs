//! `seed` command group — directory-scanning entry point for the seed-from-folder
//! wizard (Agent 24).
//!
//! Thin wrapper around [`crate::seed::scan_directory`] — keeps the heuristic
//! classifier behind a single, typed Tauri command. The frontend wizard receives
//! the proposed manifest, lets the operator edit each row, and then calls
//! `add_app` per row to persist into `apps.json`.

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::errors::CoreError;
use crate::manifest::types::AppEntry;
use crate::seed::SeedScanResult;

/// View shape returned to the frontend.
///
/// Same payload as [`SeedScanResult`] but with `PathBuf`s flattened to strings
/// so the frontend can render them without bespoke deserialisation. Keep field
/// names in lockstep with `SeedScanResult`.
#[derive(Debug, Clone, Serialize)]
pub struct SeedScanView {
    pub apps: Vec<AppEntry>,
    pub unclassified: Vec<String>,
}

impl From<SeedScanResult> for SeedScanView {
    fn from(value: SeedScanResult) -> Self {
        Self {
            apps: value.apps,
            unclassified: value
                .unclassified
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
        }
    }
}

#[tauri::command]
pub async fn seed_from_folder(
    path: String,
    _state: State<'_, AppState>,
) -> Result<SeedScanView, CoreError> {
    let root = Path::new(&path);
    if !root.exists() {
        return Err(CoreError::config(format!(
            "seed root does not exist: {path}"
        )));
    }
    let result = crate::seed::scan_directory(root).await?;
    Ok(result.into())
}
