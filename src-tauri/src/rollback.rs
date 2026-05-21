//! Rollback / snapshot engine.
//!
//! Snapshots are tar.zst archives stored under `cache/rollback/<app_id>/`. The orchestrator
//! creates them before any destructive operation and restores them via [`restore_archive`]
//! if the operation fails its smoke test.
//!
//! Snapshot creation is also exposed here so source implementations can call it directly
//! during their `apply` phase.

use std::fs::File;
use std::path::{Path, PathBuf};

use chrono::Utc;
use sha2::{Digest, Sha256};
use tracing::info;
use ulid::Ulid;
use walkdir::WalkDir;

use crate::errors::CoreError;

pub struct SnapshotResult {
    pub id: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
}

/// Build a tar.zst archive of `source_dir` under `cache_root/rollback/<app_id>/`.
///
/// The archive name embeds a short version label and a UTC timestamp so multiple
/// snapshots are ordered chronologically by filename.
pub async fn create_archive(
    app_id: &str,
    short_version: &str,
    source_dir: &Path,
    cache_root: &Path,
) -> Result<SnapshotResult, CoreError> {
    let dest_dir = cache_root.join("rollback").join(app_id);
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| CoreError::io(&dest_dir, e))?;

    let ts = Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let id = Ulid::new().to_string();
    let filename = format!("{short_version}-{ts}.tar.zst");
    let dest = dest_dir.join(&filename);

    let source = source_dir.to_path_buf();
    let dest_owned = dest.clone();

    let (size_bytes, sha256) = tokio::task::spawn_blocking(move || -> Result<(u64, String), CoreError> {
        let file = File::create(&dest_owned).map_err(|e| CoreError::io(&dest_owned, e))?;
        let encoder = zstd::stream::write::Encoder::new(file, 3)
            .map_err(|e| CoreError::internal(format!("zstd encoder: {e}")))?
            .auto_finish();
        let mut tar = tar::Builder::new(encoder);
        tar.follow_symlinks(false);

        // Walk the source dir; tar each regular file relative to the source root.
        for entry in WalkDir::new(&source) {
            let entry = entry.map_err(|e| CoreError::internal(format!("walkdir: {e}")))?;
            let path = entry.path();
            let rel = path
                .strip_prefix(&source)
                .map_err(|e| CoreError::internal(format!("strip_prefix: {e}")))?;
            if rel.as_os_str().is_empty() {
                continue;
            }
            tar.append_path_with_name(path, rel)
                .map_err(|e| CoreError::io(path, e))?;
        }
        tar.finish().map_err(|e| CoreError::io(&source, e))?;

        // Compute size + sha256 of the written archive.
        let bytes = std::fs::read(&dest_owned).map_err(|e| CoreError::io(&dest_owned, e))?;
        let size = bytes.len() as u64;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = hex::encode(hasher.finalize());
        Ok((size, hash))
    })
    .await
    .map_err(|e| CoreError::internal(format!("snapshot join error: {e}")))??;

    info!(app_id, %size_bytes, sha256, archive = %dest.display(), "snapshot created");
    Ok(SnapshotResult { id, path: dest, size_bytes, sha256 })
}

/// Extract a tar.zst archive into `target_dir`, replacing its contents.
///
/// The strategy is: (1) move the existing target_dir aside to a temp sibling, (2)
/// extract into a fresh target_dir, (3) on success, delete the temp sibling; on
/// failure, restore the temp sibling. This keeps rollback itself crash-safe.
pub async fn restore_archive(archive: &Path, target_dir: &Path) -> Result<(), CoreError> {
    let archive = archive.to_path_buf();
    let target = target_dir.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<(), CoreError> {
        let parent = target
            .parent()
            .ok_or_else(|| CoreError::config(format!("target {} has no parent", target.display())))?;
        let temp_aside = parent.join(format!(
            ".{}.restoring.{}",
            target.file_name().unwrap_or_default().to_string_lossy(),
            Ulid::new()
        ));

        let target_existed = target.exists();
        if target_existed {
            std::fs::rename(&target, &temp_aside).map_err(|e| CoreError::io(&target, e))?;
        }
        std::fs::create_dir_all(&target).map_err(|e| CoreError::io(&target, e))?;

        let result: Result<(), CoreError> = (|| {
            let file = File::open(&archive).map_err(|e| CoreError::io(&archive, e))?;
            let decoder = zstd::stream::read::Decoder::new(file)
                .map_err(|e| CoreError::internal(format!("zstd decoder: {e}")))?;
            let mut tar = tar::Archive::new(decoder);
            tar.set_preserve_permissions(true);
            tar.set_overwrite(true);
            tar.unpack(&target).map_err(|e| CoreError::io(&target, e))?;
            Ok(())
        })();

        match result {
            Ok(()) => {
                if target_existed {
                    let _ = std::fs::remove_dir_all(&temp_aside);
                }
                Ok(())
            }
            Err(e) => {
                // Restore the aside copy
                let _ = std::fs::remove_dir_all(&target);
                if target_existed {
                    let _ = std::fs::rename(&temp_aside, &target);
                }
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| CoreError::internal(format!("restore join error: {e}")))??;

    info!(archive = %archive.display(), target = %target_dir.display(), "snapshot restored");
    Ok(())
}
