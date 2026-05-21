//! Rollback / snapshot engine.
//!
//! Snapshots are tar.zst archives stored under `cache/rollback/<app_id>/`. The orchestrator
//! creates them before any destructive operation and restores them via [`restore_archive`]
//! if the operation fails its smoke test.
//!
//! Snapshot creation is also exposed here so source implementations can call it directly
//! during their `apply` phase.
//!
//! Two crash-safety primitives also live here:
//!
//! * [`sweep_expired`] — daily expiry sweep. Walks the rollback root and deletes archives
//!   whose `mtime` is older than `retention_days`. Wired by the caller to a 24h timer.
//! * [`begin_swap`] / [`SwapGuard`] / [`recover_orphan_swaps`] — crash-safe marker files.
//!   A marker is written before each in-place swap and deleted on commit. On startup the
//!   orchestrator scans for orphan markers and restores from the recorded snapshot.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use ulid::Ulid;
use walkdir::WalkDir;

use crate::errors::CoreError;
use crate::paths::AppPaths;

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

    let (size_bytes, sha256) =
        tokio::task::spawn_blocking(move || -> Result<(u64, String), CoreError> {
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
    Ok(SnapshotResult {
        id,
        path: dest,
        size_bytes,
        sha256,
    })
}

/// Extract a tar.zst archive into `target_dir`, replacing its contents.
///
/// The strategy is: (1) move the existing `target_dir` aside to a temp sibling, (2)
/// extract into a fresh `target_dir`, (3) on success, delete the temp sibling; on
/// failure, restore the temp sibling. This keeps rollback itself crash-safe.
pub async fn restore_archive(archive: &Path, target_dir: &Path) -> Result<(), CoreError> {
    let archive_for_log = archive.to_path_buf();
    let archive = archive.to_path_buf();
    let target = target_dir.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<(), CoreError> {
        let parent = target.parent().ok_or_else(|| {
            CoreError::config(format!("target {} has no parent", target.display()))
        })?;
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

    info!(archive = %archive_for_log.display(), target = %target_dir.display(), "snapshot restored");
    Ok(())
}

// ── Daily expiry sweep ───────────────────────────────────────────────────────────

const SECONDS_PER_DAY: u64 = 86_400;

/// Walk `rollback_root` and delete every regular file whose modification time is older
/// than `retention_days` days. Returns the number of files deleted.
///
/// The function is conservative: directories and symlinks are not touched, files whose
/// mtime cannot be read are skipped (with a warning), and an empty `rollback_root` is a
/// no-op success. This is what the orchestrator runs at boot and on a 24h timer.
pub async fn sweep_expired(rollback_root: &Path, retention_days: u32) -> Result<usize, CoreError> {
    let root = rollback_root.to_path_buf();
    let retention = Duration::from_secs(u64::from(retention_days) * SECONDS_PER_DAY);

    tokio::task::spawn_blocking(move || -> Result<usize, CoreError> {
        if !root.exists() {
            return Ok(0);
        }
        let cutoff = SystemTime::now()
            .checked_sub(retention)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let mut deleted = 0usize;
        for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            let path = entry.path();
            if !entry.file_type().is_file() {
                continue;
            }
            // Skip marker files; they are owned by SwapGuard / recover_orphan_swaps.
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".swap.marker"))
            {
                continue;
            }
            let modified = match entry.metadata() {
                Ok(meta) => match meta.modified() {
                    Ok(t) => t,
                    Err(e) => {
                        warn!(path = %path.display(), error = %e, "sweep_expired: skipping (mtime unreadable)");
                        continue;
                    }
                },
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "sweep_expired: skipping (metadata unreadable)");
                    continue;
                }
            };
            if modified < cutoff {
                match std::fs::remove_file(path) {
                    Ok(()) => {
                        deleted += 1;
                        info!(path = %path.display(), "sweep_expired: removed");
                    }
                    Err(e) => {
                        warn!(path = %path.display(), error = %e, "sweep_expired: remove failed");
                    }
                }
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| CoreError::internal(format!("sweep_expired join error: {e}")))?
}

// ── Crash-safe swap markers ──────────────────────────────────────────────────────

/// On-disk shape of a swap marker file. Serialised as JSON for easy debugging.
///
/// Fields are kept narrow on purpose: only what `recover_orphan_swaps` needs to roll
/// back. We deliberately store an absolute path to the archive so recovery does not
/// have to re-derive the path from layout conventions that may have changed.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SwapMarker {
    /// Stable app id from the manifest. Echoed in recovery logs.
    app_id: String,
    /// Absolute path to the tar.zst snapshot to restore on recovery.
    snapshot_archive: PathBuf,
    /// Absolute path to the install/working directory the swap was about to overwrite.
    target_dir: PathBuf,
    /// UTC ISO-8601 timestamp the swap began at. Diagnostic only.
    began_at: String,
}

/// Guard returned by [`begin_swap`]. Drop without calling [`SwapGuard::commit`] leaves
/// the marker file in place — that is the crash-recovery signal.
///
/// The guard is intentionally not `Drop`-cleanup-on-success: a successful swap calls
/// `commit()` explicitly, and a panic or process death leaves the marker for
/// [`recover_orphan_swaps`] to find. This is the whole point.
#[must_use = "the swap marker stays on disk until commit() is called"]
pub struct SwapGuard {
    marker_path: PathBuf,
    /// Set to `true` after `commit()` succeeds. The `Drop` impl uses this to decide
    /// whether to emit a "marker left on disk" warning (commit path) or stay silent.
    committed: bool,
}

impl SwapGuard {
    /// Delete the marker file. Call this **only** after the swap has succeeded.
    ///
    /// Returns an error if the underlying `remove_file` syscall fails; in that case the
    /// marker stays on disk and recovery will (harmlessly) re-restore the same snapshot
    /// on next launch — a wasted operation, not a correctness bug.
    pub fn commit(mut self) -> Result<(), CoreError> {
        std::fs::remove_file(&self.marker_path).map_err(|e| CoreError::io(&self.marker_path, e))?;
        self.committed = true;
        info!(marker = %self.marker_path.display(), "swap marker committed");
        Ok(())
    }

    /// Path to the marker file. Exposed for tests; production code does not need it.
    #[doc(hidden)]
    #[must_use]
    pub fn marker_path(&self) -> &Path {
        &self.marker_path
    }
}

impl Drop for SwapGuard {
    fn drop(&mut self) {
        if !self.committed {
            warn!(
                marker = %self.marker_path.display(),
                "SwapGuard dropped without commit — crash recovery will restore from this marker on next launch"
            );
        }
    }
}

/// Write a `<app_id>.swap.marker` file under `cache/rollback/` and return a
/// [`SwapGuard`] that will leave the marker behind unless `commit()` is called.
///
/// Call site protocol:
/// 1. `let guard = begin_swap(app_id, &paths, &snapshot_archive, &target_dir)?;`
/// 2. Do the in-place swap (extract, rename, whatever).
/// 3. On success: `guard.commit()?;`. On failure: just let `guard` drop — recovery on
///    next launch will roll the half-state back.
pub fn begin_swap(
    app_id: &str,
    paths: &AppPaths,
    snapshot_archive: &Path,
    target_dir: &Path,
) -> Result<SwapGuard, CoreError> {
    let rollback_root = paths.apps_root().join("cache").join("rollback");
    std::fs::create_dir_all(&rollback_root).map_err(|e| CoreError::io(&rollback_root, e))?;

    let marker_path = rollback_root.join(format!("{app_id}.swap.marker"));
    let marker = SwapMarker {
        app_id: app_id.to_string(),
        snapshot_archive: snapshot_archive.to_path_buf(),
        target_dir: target_dir.to_path_buf(),
        began_at: Utc::now().to_rfc3339(),
    };
    let body = serde_json::to_vec_pretty(&marker)
        .map_err(|e| CoreError::internal(format!("serialize swap marker: {e}")))?;

    // Atomic-ish write: write to a temp file alongside, fsync, rename. A torn marker is
    // worse than no marker because recover_orphan_swaps would try to parse garbage.
    let tmp_path = rollback_root.join(format!("{app_id}.swap.marker.tmp"));
    {
        use std::io::Write as _;
        let mut f = File::create(&tmp_path).map_err(|e| CoreError::io(&tmp_path, e))?;
        f.write_all(&body)
            .map_err(|e| CoreError::io(&tmp_path, e))?;
        f.sync_all().map_err(|e| CoreError::io(&tmp_path, e))?;
    }
    std::fs::rename(&tmp_path, &marker_path).map_err(|e| CoreError::io(&marker_path, e))?;

    info!(
        app_id,
        marker = %marker_path.display(),
        archive = %snapshot_archive.display(),
        "swap marker written"
    );

    Ok(SwapGuard {
        marker_path,
        committed: false,
    })
}

/// Scan the rollback root for orphan `.swap.marker` files and restore each one.
///
/// Called by `main.rs` at startup. Returns the list of `app_id`s that were rolled
/// back. A marker that cannot be parsed is moved aside with a `.corrupt` suffix and
/// logged — we do not delete unknown data silently.
pub async fn recover_orphan_swaps(paths: &AppPaths) -> Result<Vec<String>, CoreError> {
    let rollback_root = paths.apps_root().join("cache").join("rollback");
    if !rollback_root.exists() {
        return Ok(Vec::new());
    }

    // Collect marker paths synchronously — directory walk is cheap and the entries
    // themselves are tiny JSON files. Restore work is async per marker.
    let marker_paths: Vec<PathBuf> = {
        let root = rollback_root.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<PathBuf>, CoreError> {
            let mut out = Vec::new();
            let read = std::fs::read_dir(&root).map_err(|e| CoreError::io(&root, e))?;
            for entry in read {
                let entry = entry.map_err(|e| CoreError::io(&root, e))?;
                let path = entry.path();
                if path.is_file()
                    && path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with(".swap.marker"))
                {
                    out.push(path);
                }
            }
            Ok(out)
        })
        .await
        .map_err(|e| CoreError::internal(format!("recover_orphan_swaps scan join error: {e}")))??
    };

    let mut recovered = Vec::with_capacity(marker_paths.len());
    for marker_path in marker_paths {
        match read_marker(&marker_path) {
            Ok(marker) => {
                info!(
                    app_id = %marker.app_id,
                    archive = %marker.snapshot_archive.display(),
                    target = %marker.target_dir.display(),
                    "recover_orphan_swaps: rolling back half-finished swap"
                );
                match restore_archive(&marker.snapshot_archive, &marker.target_dir).await {
                    Ok(()) => {
                        if let Err(e) = std::fs::remove_file(&marker_path) {
                            warn!(
                                marker = %marker_path.display(),
                                error = %e,
                                "recover_orphan_swaps: restore succeeded but marker remove failed"
                            );
                        }
                        recovered.push(marker.app_id);
                    }
                    Err(e) => {
                        warn!(
                            app_id = %marker.app_id,
                            archive = %marker.snapshot_archive.display(),
                            error = %e,
                            "recover_orphan_swaps: restore failed; marker left in place for retry"
                        );
                    }
                }
            }
            Err(e) => {
                let corrupt_path = marker_path.with_extension("marker.corrupt");
                warn!(
                    marker = %marker_path.display(),
                    error = %e,
                    moved_to = %corrupt_path.display(),
                    "recover_orphan_swaps: marker unreadable; quarantining"
                );
                if let Err(rename_err) = std::fs::rename(&marker_path, &corrupt_path) {
                    warn!(
                        marker = %marker_path.display(),
                        error = %rename_err,
                        "recover_orphan_swaps: quarantine rename failed"
                    );
                }
            }
        }
    }
    Ok(recovered)
}

fn read_marker(path: &Path) -> Result<SwapMarker, CoreError> {
    let bytes = std::fs::read(path).map_err(|e| CoreError::io(path, e))?;
    serde_json::from_slice::<SwapMarker>(&bytes)
        .map_err(|e| CoreError::internal(format!("parse swap marker {}: {e}", path.display())))
}
