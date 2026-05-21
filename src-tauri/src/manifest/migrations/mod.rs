//! Schema-version migrations for `apps.json`.
//!
//! Manifests are versioned by the top-level `schema_version` field. On load, the
//! [`detect_version`] function inspects a freshly-parsed `serde_json::Value` and reports
//! the on-disk version; [`migrate_to_current`] runs the chain of per-version transforms
//! until the value matches the shape declared by `schema/apps.schema.json`.
//!
//! ## Versions
//!
//! * **v0** — legacy shape. Two distinguishing features:
//!   1. Top-level `schema_version` is absent (or `0`).
//!   2. Each entry under `apps[*]` uses the field name `source_type` instead of the v1
//!      field name `type`.
//!
//!   This is the only legacy shape we have ever shipped, so it is the only one we need
//!   to migrate from. The transform inserts `schema_version: 1` at the top level and
//!   renames every `apps[*].source_type` to `apps[*].type` in place.
//!
//! * **v1** — the current shape declared by `schema/apps.schema.json`. See
//!   [`docs/MANIFEST_SCHEMA.md`](../../../../docs/MANIFEST_SCHEMA.md).
//!
//! ## Adding a future migration
//!
//! When `schema_version` bumps to `2`:
//!
//! 1. Bump [`CURRENT_VERSION`] to `2`.
//! 2. Add `mod v1_to_v2;` and a `v1_to_v2::migrate` function below.
//! 3. Extend the `loop` in [`migrate_to_current`] so each step bumps the on-disk version
//!    by exactly one.
//!
//! No migration is allowed to mutate the input file directly; all transforms are pure
//! `serde_json::Value -> Result<serde_json::Value, CoreError>` so the loader can decide
//! whether to persist the upgraded form back to disk.

pub mod v0_to_v1;

use crate::errors::CoreError;

/// The schema version this build of IPTV Hub understands. Bumped on every breaking
/// manifest change.
pub const CURRENT_VERSION: u32 = 1;

/// Returns the schema version this build understands. Wraps [`CURRENT_VERSION`] so
/// callers do not need to import the constant.
pub const fn current_version() -> u32 {
    CURRENT_VERSION
}

/// Inspects a freshly-parsed `apps.json` payload and reports its on-disk version.
///
/// The detection rules, in order:
///
/// 1. If the value is not an object, return `0` so the migration runner produces a clean
///    error message instead of a panic.
/// 2. If `schema_version` is missing, return `0` (legacy v0).
/// 3. If `schema_version` is an unsigned integer, return its value.
/// 4. If `schema_version` is present but not an integer, return `0` so the legacy
///    migration runs and produces a deterministic failure if the value cannot be
///    coerced.
pub fn detect_version(raw: &serde_json::Value) -> u32 {
    let Some(obj) = raw.as_object() else {
        return 0;
    };
    obj.get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .map_or(0, |n| u32::try_from(n).unwrap_or(0))
}

/// Runs the chain of per-version transforms until `raw` matches [`CURRENT_VERSION`].
///
/// The runner is deliberately written as a `while` loop on the detected version so that
/// future migrations (`v1 -> v2`, `v2 -> v3`, ...) compose naturally: each transform
/// bumps the version by exactly one and the loop terminates when the version matches.
///
/// Returns an error if the on-disk version is newer than this build understands
/// (forward-compatibility is out of scope: a newer manifest is a configuration error,
/// not something we silently downgrade).
pub fn migrate_to_current(mut raw: serde_json::Value) -> Result<serde_json::Value, CoreError> {
    let mut version = detect_version(&raw);
    while version < CURRENT_VERSION {
        raw = match version {
            0 => v0_to_v1::migrate(raw)?,
            // No other backward migrations exist yet; the match exists for future versions.
            other => {
                return Err(CoreError::config(format!(
                    "no migration registered for schema_version {other} -> {}",
                    other + 1
                )));
            }
        };
        let new_version = detect_version(&raw);
        if new_version <= version {
            return Err(CoreError::config(format!(
                "migration from schema_version {version} did not advance the version \
                 (still {new_version}); refusing to loop"
            )));
        }
        version = new_version;
    }
    if version > CURRENT_VERSION {
        return Err(CoreError::config(format!(
            "manifest schema_version {version} is newer than this build supports \
             (current = {CURRENT_VERSION}); upgrade IPTV Hub or pin to an older manifest"
        )));
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_missing_version_as_v0() {
        let v = json!({ "apps": [] });
        assert_eq!(detect_version(&v), 0);
    }

    #[test]
    fn detects_explicit_v1() {
        let v = json!({ "schema_version": 1, "apps": [] });
        assert_eq!(detect_version(&v), 1);
    }

    #[test]
    fn non_object_root_detected_as_v0_for_clean_error() {
        let v = json!([1, 2, 3]);
        assert_eq!(detect_version(&v), 0);
    }

    #[test]
    fn migrate_v1_is_noop() {
        let v = json!({ "schema_version": 1, "apps": [] });
        let out = migrate_to_current(v.clone()).expect("v1 is current");
        assert_eq!(out, v);
    }

    #[test]
    fn migrate_future_version_rejected() {
        let v = json!({ "schema_version": 99, "apps": [] });
        let err = migrate_to_current(v).expect_err("must reject future version");
        let msg = err.to_string();
        assert!(
            msg.contains("newer than this build supports"),
            "msg = {msg}"
        );
    }
}
