//! Resolves the four roots IPTV Hub touches: app-data, manifest, cache, logs.
//!
//! Two install modes: per-user (`%APPDATA%\IPTV-Hub` on Windows, `$HOME/.config/iptv-hub`
//! elsewhere) and portable (binary's own directory if a `PORTABLE` marker file is present).

use std::path::{Path, PathBuf};

use crate::errors::CoreError;

#[derive(Debug, Clone)]
pub struct AppPaths {
    data_dir: PathBuf,
    apps_root: PathBuf,
}

impl AppPaths {
    pub fn resolve(app: &tauri::AppHandle) -> Result<Self, CoreError> {
        // Portable mode: marker file alongside the binary.
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        if let Some(dir) = exe_dir {
            if dir.join("PORTABLE").exists() {
                return Ok(Self {
                    data_dir: dir.clone(),
                    apps_root: dir.join("apps"),
                });
            }
        }

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| CoreError::config(format!("resolve app data dir: {e}")))?;
        // The default apps_root lives outside app-data so user paths look like the
        // documented `C:\IPTV\` on Windows. The user can override in settings.
        let apps_root = if cfg!(windows) {
            PathBuf::from("C:\\IPTV")
        } else {
            data_dir.join("apps-root")
        };
        Ok(Self { data_dir, apps_root })
    }

    pub async fn ensure_exist(&self) -> Result<(), CoreError> {
        for p in [
            &self.data_dir,
            &self.apps_root,
            &self.apps_root.join("upstream"),
            &self.apps_root.join("user-data"),
            &self.apps_root.join("cache"),
            &self.apps_root.join("cache").join("rollback"),
            &self.apps_root.join("cache").join("installers"),
            &self.apps_root.join("cache").join("icons"),
            &self.logs_dir(),
        ] {
            tokio::fs::create_dir_all(p).await.map_err(|e| CoreError::io(p, e))?;
        }
        Ok(())
    }

    pub fn data_dir(&self) -> &Path { &self.data_dir }
    pub fn apps_root(&self) -> &Path { &self.apps_root }
    pub fn manifest_path(&self) -> PathBuf { self.data_dir.join("apps.json") }
    pub fn database_path(&self) -> PathBuf { self.data_dir.join("iptv-hub.db") }
    pub fn logs_dir(&self) -> PathBuf { self.data_dir.join("logs") }

    /// Build an [`AppPaths`] rooted at `root` without needing a Tauri AppHandle.
    /// Used by integration tests that exercise sources against tempdir-rooted trees.
    /// `data_dir` is `<root>` and `apps_root` is `<root>/apps`, mirroring the portable
    /// install layout.
    #[doc(hidden)]
    pub fn for_tests(root: PathBuf) -> Self {
        Self {
            data_dir: root.clone(),
            apps_root: root.join("apps"),
        }
    }
}
