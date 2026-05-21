//! Manifest loader.
//!
//! Reads `apps.json`, validates against the JSON Schema, runs migrations if the
//! `schema_version` is behind, and rewrites the upgraded form back to disk (preserving
//! the original at `apps.json.bak`). The schema itself is embedded at compile time from
//! `schema/apps.schema.json` so the binary is self-contained.
//!
//! ## Error paths (mirrors `docs/MANIFEST_SCHEMA.md` §10)
//!
//! 1. Malformed JSON               → `CoreError::Config` with the byte offset.
//! 2. JSON Schema violation        → `CoreError::Config` with one bullet per error.
//! 3. Duplicate `apps[*].id`       → `CoreError::Config` naming the duplicate id.
//! 4. Future `schema_version`      → `CoreError::Config` (the migration runner rejects it).
//! 5. Filesystem I/O               → `CoreError::Io` carrying the failing path.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use crate::errors::CoreError;
use crate::manifest::migrations;
use crate::manifest::types::Manifest;

const SCHEMA_JSON: &str = include_str!("../../../schema/apps.schema.json");

static SCHEMA: LazyLock<jsonschema::JSONSchema> = LazyLock::new(|| {
    let value: serde_json::Value =
        serde_json::from_str(SCHEMA_JSON).expect("embedded schema must be valid JSON");
    jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .compile(&value)
        .expect("embedded schema must compile")
});

/// Validate a fully-typed [`Manifest`] against the JSON Schema and the cross-cutting
/// duplicate-id rule. Used by [`crate::manifest::ManifestStore::replace`] before a write.
///
/// The intermediate `serde_json::Value` has null leaves removed before schema validation
/// for the same reason the writer does it: the type's `Option<T>` fields emit `null` for
/// `None`, but the schema treats every property as a non-nullable typed value. The
/// writer applies the same transform, so what we validate matches what we persist.
pub fn validate(manifest: &Manifest) -> Result<(), CoreError> {
    let mut value = serde_json::to_value(manifest)
        .map_err(|e| CoreError::config(format!("serialize manifest: {e}")))?;
    strip_null_fields(&mut value);
    validate_value(&value)?;
    check_unique_ids_from_manifest(manifest)?;
    Ok(())
}

/// Mirrors [`crate::manifest::writer::strip_null_fields`]: removes `null` leaves from
/// every object in `value`. Kept private to this module so the writer and validator
/// stay symmetric without exposing the helper to other agents.
fn strip_null_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            for v in map.values_mut() {
                strip_null_fields(v);
            }
        }
        serde_json::Value::Array(items) => {
            for v in items.iter_mut() {
                strip_null_fields(v);
            }
        }
        _ => {}
    }
}

/// Validate a raw `serde_json::Value` against the embedded JSON Schema. Surfaces every
/// schema error as a single multi-line message so the user sees the full failure list
/// in one shot instead of having to fix-and-retry.
fn validate_value(value: &serde_json::Value) -> Result<(), CoreError> {
    if let Err(errors) = SCHEMA.validate(value) {
        let messages: Vec<String> = errors
            .map(|e| format!("at {}: {}", e.instance_path, e))
            .collect();
        return Err(CoreError::config(format!(
            "manifest failed validation:\n  - {}",
            messages.join("\n  - ")
        )));
    }
    Ok(())
}

/// JSON Schema 2020-12 cannot natively express "the value of `apps[*].id` is unique
/// across the array", so we do it ourselves. Done at the raw-Value layer so the
/// migration runner can call it before the typed deserialize attempts to silently merge
/// duplicates.
fn check_unique_ids_from_value(value: &serde_json::Value) -> Result<(), CoreError> {
    let Some(apps) = value.get("apps").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    let mut seen: HashSet<&str> = HashSet::new();
    for entry in apps {
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if !seen.insert(id) {
            return Err(CoreError::config(format!(
                "duplicate apps[*].id detected: '{id}' (every app must have a unique id)"
            )));
        }
    }
    Ok(())
}

fn check_unique_ids_from_manifest(manifest: &Manifest) -> Result<(), CoreError> {
    let mut seen: HashSet<&str> = HashSet::new();
    for app in &manifest.apps {
        if !seen.insert(app.id.as_str()) {
            return Err(CoreError::config(format!(
                "duplicate apps[*].id detected: '{}' (every app must have a unique id)",
                app.id
            )));
        }
    }
    Ok(())
}

/// Atomic load: read → migrate (if behind) → validate → write back (only if a migration
/// ran). If the file does not exist, a default v1 manifest is synthesised and persisted
/// so subsequent loads are cheap.
pub async fn load_and_validate(path: &Path) -> Result<Manifest, CoreError> {
    if !path.exists() {
        // First run: synthesise an empty manifest pointing at sensible defaults.
        let default = Manifest {
            schema_version: migrations::current_version(),
            apps_root: default_root("C:\\IPTV").to_string(),
            user_data_root: default_root("C:\\IPTV\\user-data").to_string(),
            cache_root: default_root("C:\\IPTV\\cache").to_string(),
            apps: Vec::new(),
        };
        crate::manifest::writer::write_atomic(path, &default).await?;
        return Ok(default);
    }

    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| CoreError::io(path, e))?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| CoreError::config(format!("parse {}: {e}", path.display())))?;

    let on_disk_version = migrations::detect_version(&raw);
    let migrated = migrations::migrate_to_current(raw)?;
    let migration_ran = on_disk_version != migrations::current_version();

    if let Err(errors) = SCHEMA.validate(&migrated) {
        let messages: Vec<String> = errors
            .map(|e| format!("at {}: {}", e.instance_path, e))
            .collect();
        return Err(CoreError::config(format!(
            "{} failed validation:\n  - {}",
            path.display(),
            messages.join("\n  - ")
        )));
    }
    check_unique_ids_from_value(&migrated)?;

    let manifest: Manifest = serde_json::from_value(migrated)
        .map_err(|e| CoreError::config(format!("decode {}: {e}", path.display())))?;

    if migration_ran {
        // Persist the upgraded form back to disk so the next load is a no-op. The atomic
        // writer preserves the original file at `apps.json.bak`, so the migration is
        // reversible by hand if something goes wrong.
        crate::manifest::writer::write_atomic(path, &manifest).await?;
    }
    Ok(manifest)
}

#[cfg(target_os = "windows")]
const fn default_root(value: &str) -> &str {
    value
}

#[cfg(not(target_os = "windows"))]
const fn default_root(_: &str) -> &str {
    "/tmp/iptv-hub"
}
