//! VPS-root path resolution for the orchestrator.
//!
//! Every directory the orchestrator writes to is derived from one `Paths` value
//! constructed from the root passed on the command line (typically
//! `/opt/iptv-hub` in production or a tempdir under test). The layout is the
//! one merged in `docs/VPS_ORCHESTRATOR.md` "Hard storage policy":
//!
//! ```text
//! <root>/
//! ├── repos/<app>/
//! ├── cache/{cargo,docker,node-modules-<app>}/
//! ├── releases/<app>/<sha>/
//! ├── live/<app>          (symlink → releases/<app>/<sha>)
//! ├── data/<app>/
//! ├── logs/<app>/
//! ├── locks/{<app>.lock,global.sem}
//! └── state/orchestrator.db
//! ```
//!
//! `ensure_tree()` creates only the top-level directories — per-app
//! subdirectories appear on demand as repos are cloned, releases are built,
//! etc., so a freshly-probed root with no apps stays empty under each tier.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Maximum length of an app id, in bytes.
///
/// App ids are concatenated into filesystem paths under `repos/`, `releases/`,
/// `data/`, `logs/`, and `locks/<id>.lock`, so the cap keeps the longest
/// derived path within common filesystem limits even for deep nesting.
pub const MAX_APP_ID_BYTES: usize = 64;

/// Reasons an app id may be rejected.
///
/// The orchestrator is the only writer of these paths, but app ids originate
/// from `apps.json` (operator-authored). A typo or pasted Windows path would
/// otherwise punch a hole in our storage layout; validation closes that hole.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum AppIdError {
    #[error("app id is empty")]
    Empty,
    #[error("app id is longer than {MAX_APP_ID_BYTES} bytes (got {0})")]
    TooLong(usize),
    #[error("app id may not start or end with '-' (got {0:?})")]
    EdgeHyphen(String),
    #[error("app id byte {byte:#04x} at position {position} is not [a-z0-9-]")]
    InvalidByte { position: usize, byte: u8 },
}

/// Reasons a release sha may be rejected.
///
/// Shas come from `git rev-parse`. We never trust them blindly — a remote that
/// returned `../../etc/passwd` instead of a hex sha would otherwise leak the
/// release tree out of the VPS root.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum ShaError {
    #[error("release sha is empty")]
    Empty,
    #[error("release sha contains a path separator or '..'")]
    Unsafe,
}

/// Combined error returned by per-app path builders that resolve both an
/// app id and a release sha.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum PathError {
    #[error(transparent)]
    AppId(#[from] AppIdError),
    #[error(transparent)]
    Sha(#[from] ShaError),
}

/// Accepts an app id matching `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`.
///
/// Concretely: lowercase ASCII + digits, optional inner hyphens, length 1–64,
/// first and last byte must be alphanumeric.
pub fn validate_app_id(id: &str) -> Result<(), AppIdError> {
    if id.is_empty() {
        return Err(AppIdError::Empty);
    }
    if id.len() > MAX_APP_ID_BYTES {
        return Err(AppIdError::TooLong(id.len()));
    }
    let bytes = id.as_bytes();
    for (position, &byte) in bytes.iter().enumerate() {
        let edge = position == 0 || position == bytes.len() - 1;
        let is_alnum = byte.is_ascii_lowercase() || byte.is_ascii_digit();
        let allowed_here = if edge {
            is_alnum
        } else {
            is_alnum || byte == b'-'
        };
        if !allowed_here {
            // Tell the caller about edge-hyphen specifically — it's the most
            // common typo (e.g., `-wizju` or `wizju-`).
            if edge && byte == b'-' {
                return Err(AppIdError::EdgeHyphen(id.to_owned()));
            }
            return Err(AppIdError::InvalidByte { position, byte });
        }
    }
    Ok(())
}

/// Accepts a release sha that is non-empty and contains no path-traversal tokens.
///
/// We intentionally do NOT require hex — manifest versions may also flow
/// through this code path, and a `v1.2.3` tag is a legitimate
/// `releases/<app>/<sha-or-version>/` directory name.
pub fn validate_sha(sha: &str) -> Result<(), ShaError> {
    if sha.is_empty() {
        return Err(ShaError::Empty);
    }
    // The substring check on `..` covers `../foo`, `..`, `foo..bar`, etc.,
    // but the single-dot case slips past it: a sha of `.` would resolve
    // `releases/<app>/.` to `releases/<app>/` itself, letting a caller write
    // outside the per-release directory. Reject the literal `.` explicitly.
    if sha == "." || sha.contains('/') || sha.contains('\\') || sha.contains("..") {
        return Err(ShaError::Unsafe);
    }
    Ok(())
}

/// Typed accessors for every directory the orchestrator owns under a single
/// VPS root.
///
/// All accessors are pure-functional: they compose `PathBuf`s and never touch
/// the filesystem. Only `ensure_tree()` writes to disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn repos(&self) -> PathBuf {
        self.root.join("repos")
    }

    pub fn repo(&self, app: &str) -> Result<PathBuf, AppIdError> {
        validate_app_id(app)?;
        Ok(self.repos().join(app))
    }

    pub fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }

    pub fn cache_cargo(&self) -> PathBuf {
        self.cache().join("cargo")
    }

    pub fn cache_docker(&self) -> PathBuf {
        self.cache().join("docker")
    }

    pub fn cache_node_modules(&self, app: &str) -> Result<PathBuf, AppIdError> {
        validate_app_id(app)?;
        Ok(self.cache().join(format!("node-modules-{app}")))
    }

    pub fn releases(&self) -> PathBuf {
        self.root.join("releases")
    }

    pub fn release(&self, app: &str, sha: &str) -> Result<PathBuf, PathError> {
        validate_app_id(app)?;
        validate_sha(sha)?;
        Ok(self.releases().join(app).join(sha))
    }

    pub fn live(&self) -> PathBuf {
        self.root.join("live")
    }

    pub fn live_app(&self, app: &str) -> Result<PathBuf, AppIdError> {
        validate_app_id(app)?;
        Ok(self.live().join(app))
    }

    pub fn data(&self) -> PathBuf {
        self.root.join("data")
    }

    pub fn data_app(&self, app: &str) -> Result<PathBuf, AppIdError> {
        validate_app_id(app)?;
        Ok(self.data().join(app))
    }

    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn logs_app(&self, app: &str) -> Result<PathBuf, AppIdError> {
        validate_app_id(app)?;
        Ok(self.logs().join(app))
    }

    pub fn locks(&self) -> PathBuf {
        self.root.join("locks")
    }

    pub fn app_lock_file(&self, app: &str) -> Result<PathBuf, AppIdError> {
        validate_app_id(app)?;
        Ok(self.locks().join(format!("{app}.lock")))
    }

    pub fn global_sem_file(&self) -> PathBuf {
        self.locks().join("global.sem")
    }

    pub fn state(&self) -> PathBuf {
        self.root.join("state")
    }

    pub fn state_db(&self) -> PathBuf {
        self.state().join("orchestrator.db")
    }

    /// Creates the top-level directory tree at `<root>`. Idempotent — re-running
    /// against an existing tree is a no-op.
    ///
    /// Per-app subdirectories (e.g., `repos/wizju-iptv-player/`,
    /// `data/wizju-iptv-player/`) are created on demand by the subsystem that
    /// owns them, not here. P1's invariant is just "the top-level layout exists
    /// so later phases can write into it."
    pub fn ensure_tree(&self) -> std::io::Result<Vec<PathBuf>> {
        let dirs = self.top_level_dirs();
        for dir in &dirs {
            std::fs::create_dir_all(dir)?;
        }
        Ok(dirs)
    }

    /// The canonical ordered list of top-level dirs `ensure_tree` creates.
    /// Exposed so the probe report can list exactly what was touched.
    pub fn top_level_dirs(&self) -> Vec<PathBuf> {
        vec![
            self.root.clone(),
            self.repos(),
            self.cache(),
            self.cache_cargo(),
            self.cache_docker(),
            self.releases(),
            self.live(),
            self.data(),
            self.logs(),
            self.locks(),
            self.state(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn validate_app_id_accepts_canonical_examples() {
        for id in [
            "wizju-iptv-player",
            "tvapp",
            "nuvioweb",
            "smart-iptv-web",
            "a",
            "z9",
            "a-b-c",
            "0",
        ] {
            assert!(validate_app_id(id).is_ok(), "expected `{id}` to be valid");
        }
    }

    #[test]
    fn validate_app_id_rejects_empty() {
        assert_eq!(validate_app_id(""), Err(AppIdError::Empty));
    }

    #[test]
    fn validate_app_id_rejects_too_long() {
        let long_id: String = "a".repeat(MAX_APP_ID_BYTES + 1);
        assert_eq!(
            validate_app_id(&long_id),
            Err(AppIdError::TooLong(MAX_APP_ID_BYTES + 1))
        );
    }

    #[test]
    fn validate_app_id_accepts_exactly_max_length() {
        let id: String = "a".repeat(MAX_APP_ID_BYTES);
        assert!(validate_app_id(&id).is_ok());
    }

    #[test]
    fn validate_app_id_rejects_uppercase() {
        // Upper-case A is byte 0x41 at position 0.
        assert_eq!(
            validate_app_id("Wizju"),
            Err(AppIdError::InvalidByte {
                position: 0,
                byte: b'W',
            })
        );
    }

    #[test]
    fn validate_app_id_rejects_path_separators() {
        assert!(matches!(
            validate_app_id("wizju/iptv"),
            Err(AppIdError::InvalidByte { byte: b'/', .. })
        ));
        assert!(matches!(
            validate_app_id("wizju\\iptv"),
            Err(AppIdError::InvalidByte { byte: b'\\', .. })
        ));
    }

    #[test]
    fn validate_app_id_rejects_parent_dir_token() {
        // `..` first invalid byte is `.` at position 0.
        assert!(matches!(
            validate_app_id(".."),
            Err(AppIdError::InvalidByte { byte: b'.', .. })
        ));
    }

    #[test]
    fn validate_app_id_rejects_edge_hyphen() {
        assert_eq!(
            validate_app_id("-wizju"),
            Err(AppIdError::EdgeHyphen("-wizju".to_owned()))
        );
        assert_eq!(
            validate_app_id("wizju-"),
            Err(AppIdError::EdgeHyphen("wizju-".to_owned()))
        );
        // Inner hyphens are fine — already covered by the canonical examples.
    }

    #[test]
    fn validate_app_id_rejects_non_ascii() {
        // U+00FC (ü) encodes as two bytes 0xC3 0xBC in UTF-8; first byte trips
        // at position 0.
        let id = "ü";
        assert!(matches!(
            validate_app_id(id),
            Err(AppIdError::InvalidByte { position: 0, .. })
        ));
    }

    #[test]
    fn validate_sha_accepts_hex_and_tags() {
        for sha in ["abc123", "v1.2.3", "0f9ec3d4e", "main"] {
            assert!(validate_sha(sha).is_ok(), "expected `{sha}` to be valid");
        }
    }

    #[test]
    fn validate_sha_rejects_empty_and_traversal() {
        assert_eq!(validate_sha(""), Err(ShaError::Empty));
        assert_eq!(validate_sha("../etc"), Err(ShaError::Unsafe));
        assert_eq!(validate_sha("a/b"), Err(ShaError::Unsafe));
        assert_eq!(validate_sha("a\\b"), Err(ShaError::Unsafe));
        // Single-dot sha resolves to the parent app's release dir
        // (`releases/<app>/.` ≡ `releases/<app>/`). The `contains("..")`
        // guard does not catch it, so it gets its own explicit clause —
        // this assertion is the regression test for the Gemini review on
        // PR #29.
        assert_eq!(validate_sha("."), Err(ShaError::Unsafe));
    }

    #[test]
    fn validate_sha_rejects_single_dot_specifically() {
        // Standalone regression assertion: `.` alone must fail. Kept
        // separate from the broader traversal test so a future refactor
        // that loosens validation cannot accidentally drop this case
        // without an obvious test-name-level signal.
        match validate_sha(".") {
            Err(ShaError::Unsafe) => {}
            other => panic!("expected Err(ShaError::Unsafe) for `.`, got {other:?}"),
        }
    }

    #[test]
    fn paths_compose_under_root() {
        let p = Paths::new("/opt/iptv-hub");
        assert_eq!(p.root(), Path::new("/opt/iptv-hub"));
        assert_eq!(p.repos(), Path::new("/opt/iptv-hub/repos"));
        assert_eq!(p.cache_cargo(), Path::new("/opt/iptv-hub/cache/cargo"));
        assert_eq!(p.cache_docker(), Path::new("/opt/iptv-hub/cache/docker"));
        assert_eq!(p.releases(), Path::new("/opt/iptv-hub/releases"));
        assert_eq!(p.live(), Path::new("/opt/iptv-hub/live"));
        assert_eq!(p.data(), Path::new("/opt/iptv-hub/data"));
        assert_eq!(p.logs(), Path::new("/opt/iptv-hub/logs"));
        assert_eq!(p.locks(), Path::new("/opt/iptv-hub/locks"));
        assert_eq!(p.state(), Path::new("/opt/iptv-hub/state"));
        assert_eq!(
            p.state_db(),
            Path::new("/opt/iptv-hub/state/orchestrator.db")
        );
        assert_eq!(
            p.global_sem_file(),
            Path::new("/opt/iptv-hub/locks/global.sem")
        );
    }

    #[test]
    fn per_app_accessors_validate_and_compose() {
        let p = Paths::new("/r");
        assert_eq!(p.repo("wizju").unwrap(), Path::new("/r/repos/wizju"));
        assert_eq!(
            p.cache_node_modules("wizju").unwrap(),
            Path::new("/r/cache/node-modules-wizju")
        );
        assert_eq!(
            p.release("wizju", "abc123").unwrap(),
            Path::new("/r/releases/wizju/abc123")
        );
        assert_eq!(p.live_app("wizju").unwrap(), Path::new("/r/live/wizju"));
        assert_eq!(p.data_app("wizju").unwrap(), Path::new("/r/data/wizju"));
        assert_eq!(p.logs_app("wizju").unwrap(), Path::new("/r/logs/wizju"));
        assert_eq!(
            p.app_lock_file("wizju").unwrap(),
            Path::new("/r/locks/wizju.lock")
        );

        // Invalid app id surfaces as AppIdError through every accessor.
        assert!(p.repo("BadId").is_err());
        assert!(p.live_app("../etc").is_err());

        // Release sha validation catches separators.
        assert!(matches!(
            p.release("wizju", "../danger"),
            Err(PathError::Sha(ShaError::Unsafe))
        ));
    }

    #[test]
    fn ensure_tree_creates_expected_dirs() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("opt-iptv-hub");
        let paths = Paths::new(&root);

        let created = paths.ensure_tree().unwrap();

        // Every reported dir exists and is a directory.
        for d in &created {
            assert!(d.is_dir(), "expected `{}` to be a directory", d.display());
        }
        // Specifically the leaves the design contract names.
        assert!(paths.repos().is_dir());
        assert!(paths.cache_cargo().is_dir());
        assert!(paths.cache_docker().is_dir());
        assert!(paths.releases().is_dir());
        assert!(paths.live().is_dir());
        assert!(paths.data().is_dir());
        assert!(paths.logs().is_dir());
        assert!(paths.locks().is_dir());
        assert!(paths.state().is_dir());
        // state_db itself is a file the SQLite layer creates later — it does
        // NOT exist after P1 probe.
        assert!(!paths.state_db().exists());
    }

    #[test]
    fn ensure_tree_is_idempotent() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();
        // Second call must succeed without error.
        paths.ensure_tree().unwrap();
    }
}
