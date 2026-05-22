//! v0 -> v1 manifest migration.
//!
//! ## What changed
//!
//! Two shape differences distinguish v0 from v1:
//!
//! 1. **Top-level `schema_version` field.** v0 manifests did not carry an explicit
//!    version tag. v1 requires `schema_version: 1`.
//!
//! 2. **Per-entry source-type field.** v0 used `source_type` on each app entry; v1
//!    renamed this to `type` to match the JSON Schema and to mirror the `type` tag used
//!    everywhere else in the public docs (see `docs/MANIFEST_SCHEMA.md`).
//!
//! ## Transform
//!
//! - Insert `schema_version: 1` at the root (overwriting any previous value, including
//!   the absent case and any non-integer sentinel).
//! - For every entry in `apps`, if a `source_type` key is present, rename it to `type`.
//!   If both keys are present (a misconfigured input), the existing `type` wins and
//!   `source_type` is removed — this matches the principle of least surprise: a v0
//!   author who already wrote `type` clearly meant the v1 spelling.
//!
//! The transform is purely value-level: it does not validate the migrated shape, it does
//! not deserialize into the typed `Manifest`, and it never touches the filesystem. The
//! loader runs the JSON Schema and the duplicate-id check on the migrated value before
//! anything is written back to disk.

use crate::errors::CoreError;

/// Apply the v0 -> v1 transform.
///
/// Returns an error if the root value is not a JSON object (a v0 manifest must be an
/// object; an array or scalar at the root is a malformed file, not a legacy file).
pub fn migrate(mut raw: serde_json::Value) -> Result<serde_json::Value, CoreError> {
    let obj = raw
        .as_object_mut()
        .ok_or_else(|| CoreError::config("v0 -> v1: root of apps.json must be a JSON object"))?;

    obj.insert(
        "schema_version".to_string(),
        serde_json::Value::from(super::CURRENT_VERSION),
    );

    if let Some(apps) = obj.get_mut("apps").and_then(|v| v.as_array_mut()) {
        for (idx, entry) in apps.iter_mut().enumerate() {
            let Some(entry_obj) = entry.as_object_mut() else {
                return Err(CoreError::config(format!(
                    "v0 -> v1: apps[{idx}] is not a JSON object"
                )));
            };
            if let Some(source_type_value) = entry_obj.remove("source_type") {
                // The v1 spelling wins if both were somehow present.
                entry_obj
                    .entry("type".to_string())
                    .or_insert(source_type_value);
            }
        }
    }

    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renames_source_type_to_type() {
        let input = json!({
            "apps_root": "C:\\IPTV",
            "user_data_root": "C:\\IPTV\\user-data",
            "cache_root": "C:\\IPTV\\cache",
            "apps": [
                { "id": "a", "name": "A", "source_type": "git",
                  "launch": { "kind": "executable" },
                  "source": { "url": "https://example.com/a.git", "branch": "main" } }
            ]
        });
        let out = migrate(input).expect("migrate");
        assert_eq!(out["schema_version"], 1);
        assert_eq!(out["apps"][0]["type"], "git");
        assert!(out["apps"][0].get("source_type").is_none());
    }

    #[test]
    fn injects_schema_version_when_absent() {
        let input = json!({ "apps": [] });
        let out = migrate(input).expect("migrate");
        assert_eq!(out["schema_version"], 1);
    }

    #[test]
    fn type_wins_when_both_present() {
        let input = json!({
            "apps": [
                { "id": "a", "name": "A", "source_type": "git", "type": "web" }
            ]
        });
        let out = migrate(input).expect("migrate");
        assert_eq!(out["apps"][0]["type"], "web");
        assert!(out["apps"][0].get("source_type").is_none());
    }

    #[test]
    fn rejects_non_object_root() {
        let err = migrate(json!([1, 2, 3])).expect_err("non-object root");
        assert!(err.to_string().contains("must be a JSON object"));
    }

    #[test]
    fn rejects_non_object_app_entry() {
        let input = json!({ "apps": ["not an object"] });
        let err = migrate(input).expect_err("non-object entry");
        assert!(err.to_string().contains("apps[0] is not a JSON object"));
    }
}
