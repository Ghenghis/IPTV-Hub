//! Shared state handed to every Tauri command via `tauri::State`. The fields are
//! cheaply cloneable (`Arc` + `Pool` + `PathBuf`); commands acquire what they need
//! without holding locks across await points.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::config::AppConfig;
use crate::manifest::ManifestStore;
use crate::paths::AppPaths;

#[derive(Clone)]
pub struct AppState {
    pub paths: AppPaths,
    pub config: AppConfig,
    pub db: SqlitePool,
    pub manifest: Arc<ManifestStore>,
}

impl AppState {
    pub const fn new(
        paths: AppPaths,
        config: AppConfig,
        db: SqlitePool,
        manifest: Arc<ManifestStore>,
    ) -> Self {
        Self { paths, config, db, manifest }
    }
}
