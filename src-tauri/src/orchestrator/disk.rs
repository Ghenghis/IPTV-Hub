//! Disk-preflight check executed before any update is accepted.
//!
//! Mirrors `docs/VPS_ORCHESTRATOR.md` "Concrete rules" §6:
//!
//! > Before starting an update, `df -B1 /opt/iptv-hub` must show
//! > `free >= max(2 × est_build_size, 40 GiB)`.
//!
//! The 40 GiB floor was raised from 30 GiB on 2026-05-22 after the operator
//! pointed out that the catalogue is 27–30 GB of raw clones and a 60–80 GB
//! working set once releases × Docker layers × caches × logs are factored in;
//! the floor is the orchestrator's hard safety reserve, sized so `SQLite` and
//! the in-flight build still have somewhere to write even when most of the
//! catalogue is resident.
//!
//! The 2× multiplier on `est_build_size` accounts for (a) the new `BuildKit`
//! layer chain materialised during the build, (b) `/tmp` scratch from
//! `npm install` and friends, and (c) the new release metadata directory.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Hard safety reserve below which the orchestrator refuses any update.
///
/// 40 GiB exactly. Expressed via the bit-shift so a future operator can grep
/// for the value as a power-of-two multiple of GiB rather than a decimal byte
/// count.
pub const FLOOR_BYTES: u64 = 40 * (1024 * 1024 * 1024);

/// Per-app default for `app.build_size_estimate_bytes` when the app has never
/// been built. 5 GiB. Apps whose single layer is larger MUST set an explicit
/// per-app override in `apps.json`.
pub const DEFAULT_PER_APP_BUILD_ESTIMATE_BYTES: u64 = 5 * (1024 * 1024 * 1024);

#[derive(Debug, Error)]
pub enum DiskError {
    #[error("io error querying disk at `{path}`: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Outcome of a single disk-preflight check.
///
/// `passed == (free_bytes >= required_bytes)`. `reason` is populated only when
/// `passed == false` and carries a human-readable explanation suitable for
/// surfacing in the eventual HTTP 507 response and in the activity log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiskPreflight {
    pub root: PathBuf,
    pub free_bytes: u64,
    pub required_bytes: u64,
    pub passed: bool,
    pub reason: Option<String>,
}

/// Pure-function version of the §6 rule.
///
/// Exposed so the math can be tested without touching the filesystem and so a
/// future caller (e.g., a UI that previews "this update will need X GiB
/// free") can render the threshold without running a real preflight.
pub fn required_bytes(est_build_size: u64) -> u64 {
    let two_x = est_build_size.saturating_mul(2);
    std::cmp::max(two_x, FLOOR_BYTES)
}

/// Run the preflight against the live filesystem at `root`.
///
/// Returns a `DiskPreflight` regardless of pass/fail — callers inspect
/// `.passed` to decide whether to accept the update. Only IO errors querying
/// the filesystem surface as `Err`.
pub fn preflight(root: &Path, est_build_size: u64) -> Result<DiskPreflight, DiskError> {
    let free_bytes = fs2::available_space(root).map_err(|source| DiskError::Io {
        path: root.to_path_buf(),
        source,
    })?;
    let required_bytes = required_bytes(est_build_size);
    let passed = free_bytes >= required_bytes;
    let reason = if passed {
        None
    } else {
        Some(format!(
            "disk-low: free={free_bytes} bytes, required={required_bytes} bytes (floor={FLOOR_BYTES}, est_build_size={est_build_size})"
        ))
    };
    Ok(DiskPreflight {
        root: root.to_path_buf(),
        free_bytes,
        required_bytes,
        passed,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn floor_is_40_gib() {
        // Exact value the design doc commits to, expressed two ways so the
        // expectation is obvious in the assertion.
        assert_eq!(FLOOR_BYTES, 40_u64 * 1024 * 1024 * 1024);
        assert_eq!(FLOOR_BYTES, 42_949_672_960);
    }

    #[test]
    fn required_bytes_zero_estimate_returns_floor() {
        assert_eq!(required_bytes(0), FLOOR_BYTES);
    }

    #[test]
    fn required_bytes_under_half_floor_returns_floor() {
        // 2× 5 GiB = 10 GiB, well under the 40 GiB floor.
        assert_eq!(required_bytes(5 * 1024 * 1024 * 1024), FLOOR_BYTES);
        // 2× 19 GiB = 38 GiB, still under floor.
        assert_eq!(required_bytes(19 * 1024 * 1024 * 1024), FLOOR_BYTES);
    }

    #[test]
    fn required_bytes_above_half_floor_returns_doubled() {
        // 2× 25 GiB = 50 GiB > 40 GiB, multiplier wins.
        assert_eq!(
            required_bytes(25 * 1024 * 1024 * 1024),
            50 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn required_bytes_saturates_on_overflow() {
        // 2 × (u64::MAX) cannot fit in u64 — saturate at u64::MAX rather than
        // wrapping to a small number that would falsely "pass".
        assert_eq!(required_bytes(u64::MAX), u64::MAX);
        assert_eq!(required_bytes(u64::MAX / 2 + 1), u64::MAX);
    }

    #[test]
    fn preflight_against_real_tempdir_reports_consistent_fields() {
        let dir = tempdir().unwrap();
        let report = preflight(dir.path(), 0).unwrap();

        assert_eq!(report.root, dir.path());
        // Floor is the required floor regardless of free.
        assert_eq!(report.required_bytes, FLOOR_BYTES);
        // free_bytes is whatever the host has; we only assert internal
        // consistency between free / required / passed / reason.
        if report.free_bytes >= report.required_bytes {
            assert!(report.passed, "free >= required must imply passed");
            assert!(report.reason.is_none());
        } else {
            assert!(!report.passed, "free < required must imply !passed");
            let reason = report.reason.expect("reason set when passed=false");
            assert!(reason.contains("disk-low"));
            assert!(reason.contains(&report.free_bytes.to_string()));
            assert!(reason.contains(&report.required_bytes.to_string()));
        }
    }

    #[test]
    fn preflight_forces_failure_when_estimate_exceeds_free_disk() {
        let dir = tempdir().unwrap();
        // u64::MAX bytes of build estimate forces required to saturate to
        // u64::MAX. Any real machine's free disk is strictly less, so passed
        // must be false and the reason must be populated.
        let report = preflight(dir.path(), u64::MAX).unwrap();
        assert_eq!(report.required_bytes, u64::MAX);
        assert!(!report.passed);
        let reason = report.reason.expect("disk-low reason");
        assert!(reason.contains("disk-low"), "got: {reason}");
    }

    // Note: a `preflight_returns_io_error_for_missing_root` test was tried and
    // removed — `fs2::available_space` reports the parent drive's free bytes on
    // Windows even when the supplied path does not exist, while POSIX
    // `statvfs(2)` returns ENOENT. The orchestrator always calls
    // `Paths::ensure_tree` before `preflight`, so the missing-path case does
    // not occur in production and the platform asymmetry is not worth a
    // `#[cfg]` test.
}
