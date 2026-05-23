//! Per-app advisory file lock for the orchestrator's update worker.
//!
//! Each app has one lock file at `locks/<app>.lock` under the VPS root. The
//! orchestrator's update worker takes an exclusive `fs2` advisory lock on that
//! file for the duration of one build → smoke → swap pass, preventing two
//! concurrent updates from racing the same repo.
//!
//! The contract here is just the lock primitive; the queue / per-app
//! single-flight semantics live in P3+ (the update worker). What P1 proves
//! is that:
//!
//! - acquiring + releasing a lock works against a fresh tempdir;
//! - a second `try_acquire` from the same process sees the contention and
//!   fails with [`LockError::Busy`] rather than blocking or silently succeeding.
//!
//! The lock is held by the file handle inside [`AppLock`]; dropping the guard
//! closes the handle which releases the OS-level lock. We never call
//! `unlock_exclusive()` explicitly — relying on Drop avoids the
//! "lock leaked because an `?` short-circuited the explicit release" footgun
//! that has appeared elsewhere in this codebase.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;

use fs2::FileExt;
use thiserror::Error;

use super::paths::{validate_app_id, AppIdError, Paths};

#[derive(Debug, Error)]
pub enum LockError {
    #[error(transparent)]
    AppId(#[from] AppIdError),
    #[error("lock for app `{app}` is held by another process")]
    Busy { app: String },
    #[error("io error on `{path}`: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Guard returned by [`AppLock::try_acquire`] / [`AppLock::acquire`]. The OS
/// lock is released when the guard is dropped.
#[derive(Debug)]
pub struct AppLock {
    /// Held purely for its Drop — closing the file releases the OS lock.
    /// Prefixed `_` to silence unused-field warnings while keeping the field
    /// name documentary.
    _file: File,
    /// Path to the lock file (`locks/<app>.lock`). Captured for diagnostics.
    lock_path: PathBuf,
    /// App id this lock protects. Captured for diagnostics + Display impl.
    app: String,
}

impl AppLock {
    /// Try to acquire the lock without blocking. Returns [`LockError::Busy`]
    /// if another holder has it.
    ///
    /// Creates `locks/` if it does not already exist (in case the caller did
    /// not yet run [`Paths::ensure_tree`]). The lock file itself is created
    /// on first call and re-used thereafter; we never delete lock files,
    /// because doing so would race with a concurrent holder.
    pub fn try_acquire(paths: &Paths, app: &str) -> Result<Self, LockError> {
        validate_app_id(app)?;
        let lock_path = paths.app_lock_file(app)?;
        ensure_locks_dir(paths)?;
        let file = open_lock_file(&lock_path)?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Self {
                _file: file,
                lock_path,
                app: app.to_owned(),
            }),
            Err(e) => {
                if is_lock_held(&e) {
                    Err(LockError::Busy {
                        app: app.to_owned(),
                    })
                } else {
                    Err(LockError::Io {
                        path: lock_path,
                        source: e,
                    })
                }
            }
        }
    }

    /// Block until the lock is acquired. Useful for the long-running worker
    /// task; HTTP handlers must use [`Self::try_acquire`] so a slow caller
    /// can't tie up a request thread.
    pub fn acquire(paths: &Paths, app: &str) -> Result<Self, LockError> {
        validate_app_id(app)?;
        let lock_path = paths.app_lock_file(app)?;
        ensure_locks_dir(paths)?;
        let file = open_lock_file(&lock_path)?;
        FileExt::lock_exclusive(&file).map_err(|e| LockError::Io {
            path: lock_path.clone(),
            source: e,
        })?;
        Ok(Self {
            _file: file,
            lock_path,
            app: app.to_owned(),
        })
    }

    pub fn app(&self) -> &str {
        &self.app
    }

    pub fn lock_path(&self) -> &std::path::Path {
        &self.lock_path
    }
}

fn ensure_locks_dir(paths: &Paths) -> Result<(), LockError> {
    let locks = paths.locks();
    std::fs::create_dir_all(&locks).map_err(|e| LockError::Io {
        path: locks,
        source: e,
    })
}

fn open_lock_file(lock_path: &std::path::Path) -> Result<File, LockError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| LockError::Io {
            path: lock_path.to_path_buf(),
            source: e,
        })
}

/// True if `e` represents lock contention on the current platform.
///
/// Mirrors [`crate::manifest::writer`]'s detection because the two modules
/// share the underlying `fs2` semantics:
/// * Unix — `EWOULDBLOCK`, surfaced as `ErrorKind::WouldBlock`.
/// * Windows — `ERROR_LOCK_VIOLATION` (33), surfaced as
///   `ErrorKind::Uncategorized`; matched via the raw OS code returned by
///   `fs2::lock_contended_error()`.
fn is_lock_held(e: &std::io::Error) -> bool {
    if matches!(e.kind(), std::io::ErrorKind::WouldBlock) {
        return true;
    }
    let canonical = fs2::lock_contended_error();
    e.raw_os_error().is_some() && e.raw_os_error() == canonical.raw_os_error()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fresh_paths() -> (tempfile::TempDir, Paths) {
        let dir = tempdir().expect("tempdir");
        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().expect("ensure_tree");
        (dir, paths)
    }

    #[test]
    fn try_acquire_succeeds_against_fresh_root() {
        let (_dir, paths) = fresh_paths();
        let lock = AppLock::try_acquire(&paths, "wizju-iptv-player").unwrap();
        assert_eq!(lock.app(), "wizju-iptv-player");
        assert!(
            lock.lock_path().ends_with("locks/wizju-iptv-player.lock")
                || lock.lock_path().ends_with("locks\\wizju-iptv-player.lock")
        );
        assert!(lock.lock_path().is_file());
    }

    #[test]
    fn second_try_acquire_for_same_app_returns_busy() {
        let (_dir, paths) = fresh_paths();
        let _first = AppLock::try_acquire(&paths, "wizju-iptv-player").unwrap();
        let err = AppLock::try_acquire(&paths, "wizju-iptv-player").unwrap_err();
        match err {
            LockError::Busy { app } => assert_eq!(app, "wizju-iptv-player"),
            other => panic!("expected LockError::Busy, got {other:?}"),
        }
    }

    #[test]
    fn distinct_apps_do_not_contend() {
        let (_dir, paths) = fresh_paths();
        let a = AppLock::try_acquire(&paths, "wizju-iptv-player").unwrap();
        let b = AppLock::try_acquire(&paths, "tvapp").unwrap();
        // Both held simultaneously — no contention because they're different
        // lock files.
        assert_eq!(a.app(), "wizju-iptv-player");
        assert_eq!(b.app(), "tvapp");
    }

    #[test]
    fn drop_releases_lock_so_next_try_acquire_succeeds() {
        let (_dir, paths) = fresh_paths();
        {
            let _first = AppLock::try_acquire(&paths, "wizju-iptv-player").unwrap();
            // _first drops here at end of scope.
        }
        let second = AppLock::try_acquire(&paths, "wizju-iptv-player").unwrap();
        assert_eq!(second.app(), "wizju-iptv-player");
    }

    #[test]
    fn invalid_app_id_surfaces_through_lock() {
        let (_dir, paths) = fresh_paths();
        let err = AppLock::try_acquire(&paths, "BadId").unwrap_err();
        assert!(matches!(err, LockError::AppId(_)), "got {err:?}");
    }

    #[test]
    fn ensures_locks_dir_when_caller_skipped_ensure_tree() {
        // Construct Paths against an empty root and acquire without
        // ensure_tree() — the lock module must materialise `locks/` itself.
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("orch-no-tree"));
        assert!(!paths.locks().exists());
        let _lock = AppLock::try_acquire(&paths, "wizju-iptv-player").unwrap();
        assert!(paths.locks().is_dir());
    }
}
