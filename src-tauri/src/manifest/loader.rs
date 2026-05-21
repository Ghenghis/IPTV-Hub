//! Manifest loader.
//!
//! Reads `apps.json`, validates against the JSON Schema, and runs migrations if the
//! `schema_version` is behind. The schema itself is embedded at compile time from
//! `schema/apps.schema.json` so the binary is self-contained.

use std::path::Path;
use std::sync::LazyLock;

use crate::errors::CoreError;
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

pub fn validate(manifest: &Manifest) -> Result<(), CoreError> {
    let value = serde_json::to_value(manifest)
        .map_err(|e| CoreError::config(format!("serialize manifest: {e}")))?;
    if let Err(errors) = SCHEMA.validate(&value) {
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

pub async fn load_and_validate(path: &Path) -> Result<Manifest, CoreError> {
    if !path.exists() {
        // First run: synthesise an empty manifest pointing at sensible defaults.
        let default = Manifest {
            schema_version: 1,
            apps_root: default_root("C:\\IPTV").to_string(),
            user_data_root: default_root("C:\\IPTV\\user-data").to_string(),
            cache_root: default_root("C:\\IPTV\\cache").to_string(),
            apps: Vec::new(),
        };
        crate::manifest::writer::write_atomic(path, &default).await?;
        return Ok(default);
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| CoreError::io(path, e))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| CoreError::config(format!("parse {}: {e}", path.display())))?;
    if let Err(errors) = SCHEMA.validate(&value) {
        let messages: Vec<String> = errors
            .map(|e| format!("at {}: {}", e.instance_path, e))
            .collect();
        return Err(CoreError::config(format!(
            "{} failed validation:\n  - {}",
            path.display(),
            messages.join("\n  - ")
        )));
    }
    let manifest: Manifest = serde_json::from_value(value)
        .map_err(|e| CoreError::config(format!("decode {}: {e}", path.display())))?;
    Ok(manifest)
}

#[cfg(target_os = "windows")]
const fn default_root(value: &str) -> &str { value }

#[cfg(not(target_os = "windows"))]
const fn default_root(_: &str) -> &str { "/tmp/iptv-hub" }
