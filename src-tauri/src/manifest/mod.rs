//! Manifest module — loads, validates, and writes `apps.json`.
//!
//! Agent 03 owns `types`. Agent 15 owns `loader`, `writer`, and the migration runner.

pub mod types;
pub mod loader;
pub mod writer;

use std::path::{Path, PathBuf};

use parking_lot::RwLock;

use crate::errors::CoreError;
use crate::manifest::types::Manifest;

/// Thread-safe wrapper that the app state hands out to commands.
/// Reads are cheap (RwLock read guard); writes go through `replace` which re-validates
/// and persists atomically.
pub struct ManifestStore {
    path: PathBuf,
    inner: RwLock<Manifest>,
}

impl ManifestStore {
    pub async fn load(path: impl Into<PathBuf>) -> Result<Self, CoreError> {
        let path = path.into();
        let manifest = loader::load_and_validate(&path).await?;
        Ok(Self { path, inner: RwLock::new(manifest) })
    }

    pub fn read(&self) -> parking_lot::RwLockReadGuard<'_, Manifest> {
        self.inner.read()
    }

    pub async fn replace(&self, new: Manifest) -> Result<(), CoreError> {
        loader::validate(&new)?;
        writer::write_atomic(&self.path, &new).await?;
        *self.inner.write() = new;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
