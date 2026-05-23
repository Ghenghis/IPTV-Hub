//! VPS orchestrator — P1 storage layer.
//!
//! P1 deliberately ships only the storage primitives: typed paths, per-app
//! advisory locks, and the disk preflight. It does NOT include repo cloning,
//! Docker build invocation, the HTTP API, the auth layer, the UI, or
//! Provider Vault integration — each lands in its own subsequent PR per
//! `docs/VPS_IMPLEMENTATION_PLAN.md`.
//!
//! The public surface mirrors that plan:
//!
//! - [`Paths`] resolves the layout under any VPS root.
//! - [`AppLock`] holds the per-app advisory lock the update worker will
//!   eventually take around build → smoke → swap.
//! - [`disk::preflight`] returns the §6 disk-low decision.
//! - [`probe`] is the smoke-test driver wired up to the
//!   `iptv-hub-orchestrator probe` CLI — it creates the tree, acquires +
//!   releases the lock for each requested app, runs the preflight, and
//!   returns a JSON-serialisable [`ProbeReport`].

pub mod disk;
pub mod lock;
pub mod paths;

pub use disk::{preflight, DiskError, DiskPreflight, FLOOR_BYTES};
pub use lock::{AppLock, LockError};
pub use paths::{validate_app_id, AppIdError, PathError, Paths, ShaError};

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("io error creating directory tree at `{path}`: {source}")]
    EnsureTree {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Lock(#[from] LockError),
    #[error(transparent)]
    Disk(#[from] DiskError),
}

/// Per-app outcome captured by [`probe`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LockProbe {
    pub app: String,
    pub lock_path: PathBuf,
    /// `true` if `AppLock::try_acquire` returned a guard. Always `true` in
    /// the happy path (no other process holds the lock on a fresh probe).
    pub acquired: bool,
    /// `true` if the guard was dropped before the probe returned. The Drop
    /// implementation closes the file handle, which the OS treats as a lock
    /// release.
    pub released: bool,
}

/// JSON-serialisable summary returned by [`probe`] and printed by the
/// `iptv-hub-orchestrator probe` CLI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProbeReport {
    pub root: PathBuf,
    /// Top-level directories actually created (or already present) under
    /// `<root>`. Mirrors [`Paths::top_level_dirs`].
    pub tree: Vec<PathBuf>,
    /// One entry per app id passed in. Empty if the caller probed without
    /// app ids — useful for verifying just the tree + disk preflight.
    pub locks: Vec<LockProbe>,
    pub disk: DiskPreflight,
}

/// Smoke-test driver: create the tree, exercise the lock subsystem for each
/// requested app, and run the §6 disk preflight against the root.
///
/// Used by the `iptv-hub-orchestrator probe` CLI to verify that a freshly
/// provisioned VPS root has working filesystem semantics. Returns the
/// composite report so the caller can render JSON, exit non-zero on disk-low,
/// etc. Errors from individual sub-checks surface as `Err(ProbeError)` and
/// short-circuit the probe — there is no partial report on failure.
pub fn probe(root: impl Into<PathBuf>, app_ids: &[String]) -> Result<ProbeReport, ProbeError> {
    let paths = Paths::new(root);
    let tree = paths
        .ensure_tree()
        .map_err(|source| ProbeError::EnsureTree {
            path: paths.root().to_path_buf(),
            source,
        })?;

    let mut locks = Vec::with_capacity(app_ids.len());
    for app in app_ids {
        let guard = AppLock::try_acquire(&paths, app)?;
        let lock_path = guard.lock_path().to_path_buf();
        drop(guard);
        locks.push(LockProbe {
            app: app.clone(),
            lock_path,
            acquired: true,
            released: true,
        });
    }

    let disk = disk::preflight(paths.root(), 0)?;

    Ok(ProbeReport {
        root: paths.root().to_path_buf(),
        tree,
        locks,
        disk,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn probe_creates_tree_and_runs_disk_preflight() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("orch");
        let report = probe(&root, &[]).unwrap();

        assert_eq!(report.root, root);
        assert!(!report.tree.is_empty());
        assert!(report.locks.is_empty(), "no app ids → no lock probes");
        // Disk preflight ran; required_bytes equals the floor when est=0.
        assert_eq!(report.disk.required_bytes, FLOOR_BYTES);
        // Every reported dir is on disk.
        for d in &report.tree {
            assert!(d.is_dir());
        }
    }

    #[test]
    fn probe_exercises_lock_subsystem_for_each_app() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("orch");
        let apps = vec!["wizju-iptv-player".to_owned(), "tvapp".to_owned()];
        let report = probe(&root, &apps).unwrap();

        assert_eq!(report.locks.len(), 2);
        for (probe_entry, app_id) in report.locks.iter().zip(apps.iter()) {
            assert_eq!(&probe_entry.app, app_id);
            assert!(probe_entry.acquired);
            assert!(probe_entry.released);
            // Lock file exists on disk (we never delete lock files).
            assert!(probe_entry.lock_path.is_file());
        }
    }

    #[test]
    fn probe_releases_locks_so_a_subsequent_probe_reacquires() {
        // The whole point of releasing on Drop is that a second probe run can
        // re-acquire the same lock immediately. A regression here would mean
        // the orchestrator's update worker would only ever get to run an app
        // once per process lifetime.
        let dir = tempdir().unwrap();
        let root = dir.path().join("orch");
        let apps = vec!["wizju-iptv-player".to_owned()];
        probe(&root, &apps).unwrap();
        probe(&root, &apps).unwrap();
    }

    #[test]
    fn probe_surfaces_invalid_app_id_via_error() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("orch");
        let err = probe(&root, &["Bad/Id".to_owned()]).unwrap_err();
        assert!(
            matches!(err, ProbeError::Lock(LockError::AppId(_))),
            "got {err:?}"
        );
    }

    #[test]
    fn probe_report_round_trips_through_json() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("orch");
        let report = probe(&root, &["wizju-iptv-player".to_owned()]).unwrap();
        let json = serde_json::to_string(&report).unwrap();
        let parsed: ProbeReport = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, report);
    }
}
