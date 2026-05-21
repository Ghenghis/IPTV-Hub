//! Atomic manifest writer. Writes to `<path>.tmp`, renames the previous file to
//! `<path>.bak`, then renames `<path>.tmp` to `<path>`. On any error before the final
//! rename, the original file is untouched.

use std::path::Path;

use crate::errors::CoreError;
use crate::manifest::types::Manifest;

pub async fn write_atomic(path: &Path, manifest: &Manifest) -> Result<(), CoreError> {
    let parent = path.parent().ok_or_else(|| {
        CoreError::config(format!("manifest path {} has no parent", path.display()))
    })?;
    tokio::fs::create_dir_all(parent).await.map_err(|e| CoreError::io(parent, e))?;

    let tmp = path.with_extension("json.tmp");
    let bak = path.with_extension("json.bak");

    let json = serde_json::to_vec_pretty(manifest)
        .map_err(|e| CoreError::config(format!("serialize manifest: {e}")))?;
    tokio::fs::write(&tmp, &json).await.map_err(|e| CoreError::io(&tmp, e))?;

    if path.exists() {
        // Best-effort backup; if this fails, abort.
        tokio::fs::rename(path, &bak).await.map_err(|e| CoreError::io(path, e))?;
    }
    tokio::fs::rename(&tmp, path).await.map_err(|e| CoreError::io(path, e))?;
    Ok(())
}
