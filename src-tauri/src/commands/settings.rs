//! `settings` command group.
//!
//! Exposes the merged view of [`AppConfig`] defaults and the persisted `settings`
//! table to the frontend, and lets the UI write individual keys back through a
//! hard-coded whitelist.
//!
//! Per CONTRACT §2.1 the whitelist is compiled in; there is no dynamic schema. Any
//! key not in [`ACCEPTED_KEYS`] is rejected with [`CoreError::Config`].

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::errors::CoreError;

/// Settings keys the frontend is allowed to write.
///
/// Read paths do not consult this list — every persisted row is returned, even
/// if a future schema adds rows the current build doesn't recognise
/// (forward-compat read, strict write).
///
/// Each entry corresponds to a field on either [`crate::config::AppConfig`] or to
/// the seeded UI preference rows in `migrations/001_initial.sql`.
pub const ACCEPTED_KEYS: &[&str] = &[
    "theme",
    "poll_concurrency",
    "default_poll_interval_minutes",
    "snapshot_retention_days",
    "activity_log_retention_days",
    "source_url_allowlist",
    "github_token",
];

/// Typed projection of the merged config + DB state returned to the frontend.
///
/// Field names match [`crate::config::AppConfig`] one-to-one so the TypeScript
/// binding can reuse the same shape on both sides of the IPC boundary. `theme`
/// and `github_token` live only in the DB and have no `AppConfig` equivalent —
/// they are surfaced here so the frontend gets a single typed object.
#[derive(Debug, Clone, Serialize)]
pub struct SettingsView {
    pub theme: String,
    pub poll_concurrency: usize,
    pub default_poll_interval_minutes: u32,
    pub snapshot_retention_days: u32,
    pub activity_log_retention_days: u32,
    pub source_url_allowlist: Vec<String>,
    pub github_token: Option<String>,
}

/// Read every row in the `settings` table, then overlay the result on top of the
/// in-memory [`AppConfig`] defaults. DB rows win when present; missing rows fall
/// back to the default so a fresh install with an empty table still returns a
/// fully-typed object.
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<SettingsView, CoreError> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM settings")
        .fetch_all(&state.db)
        .await
        .map_err(CoreError::from)?;
    let db: HashMap<String, String> = rows.into_iter().collect();

    let cfg = &state.config;

    Ok(SettingsView {
        theme: db.get("theme").cloned().unwrap_or_else(|| "system".into()),
        poll_concurrency: db
            .get("poll_concurrency")
            .and_then(|v| v.parse().ok())
            .unwrap_or(cfg.poll_concurrency),
        default_poll_interval_minutes: db
            .get("default_poll_interval_minutes")
            .and_then(|v| v.parse().ok())
            .unwrap_or(cfg.default_poll_interval_minutes),
        snapshot_retention_days: db
            .get("snapshot_retention_days")
            .and_then(|v| v.parse().ok())
            .unwrap_or(cfg.snapshot_retention_days),
        activity_log_retention_days: db
            .get("activity_log_retention_days")
            .and_then(|v| v.parse().ok())
            .unwrap_or(cfg.activity_log_retention_days),
        source_url_allowlist: db
            .get("source_url_allowlist")
            .and_then(|v| serde_json::from_str::<Vec<String>>(v).ok())
            .unwrap_or_else(|| cfg.source_url_allowlist.clone()),
        github_token: db.get("github_token").cloned().filter(|v| !v.is_empty()),
    })
}

/// Write a single setting row, UPSERT semantics. Keys are validated against
/// [`ACCEPTED_KEYS`]; values are type-checked against the corresponding field
/// so a malformed integer never lands in the DB. The activity log records the
/// key that changed but never the value — `github_token` is a secret and the
/// other rows are not worth the log noise.
#[tauri::command]
pub async fn set_setting(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), CoreError> {
    if !ACCEPTED_KEYS.contains(&key.as_str()) {
        return Err(CoreError::config(format!("unknown setting key: {key}")));
    }

    validate_value(&key, &value)?;

    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(&key)
    .bind(&value)
    .execute(&state.db)
    .await
    .map_err(CoreError::from)?;

    // Activity log: record that the setting changed without leaking the new value.
    // Failures here are non-fatal — a flaky activity log must not break a save.
    let log_res = sqlx::query(
        "INSERT INTO activity_log (at, app_id, action, level, message) \
         VALUES (datetime('now'), NULL, ?, 'info', ?)",
    )
    .bind("settings.set")
    .bind(format!("setting changed: {key}"))
    .execute(&state.db)
    .await;
    if let Err(e) = log_res {
        tracing::warn!(error = %e, key = %key, "activity log insert failed for set_setting");
    }

    Ok(())
}

/// Per-key shape validation. We refuse to persist a value that can't round-trip
/// through the type the `get_settings` reader expects.
fn validate_value(key: &str, value: &str) -> Result<(), CoreError> {
    match key {
        "theme" => match value {
            "system" | "light" | "dark" => Ok(()),
            other => Err(CoreError::config(format!(
                "theme must be one of system|light|dark, got {other}"
            ))),
        },
        "poll_concurrency" => {
            let n: usize = value
                .parse()
                .map_err(|e| CoreError::config(format!("poll_concurrency must be usize: {e}")))?;
            if n == 0 {
                return Err(CoreError::config("poll_concurrency must be >= 1"));
            }
            Ok(())
        }
        "default_poll_interval_minutes"
        | "snapshot_retention_days"
        | "activity_log_retention_days" => {
            let n: u32 = value
                .parse()
                .map_err(|e| CoreError::config(format!("{key} must be u32: {e}")))?;
            if n == 0 {
                return Err(CoreError::config(format!("{key} must be >= 1")));
            }
            Ok(())
        }
        "source_url_allowlist" => {
            let parsed: Vec<String> = serde_json::from_str(value).map_err(|e| {
                CoreError::config(format!(
                    "source_url_allowlist must be a JSON array of strings: {e}"
                ))
            })?;
            if parsed.iter().any(String::is_empty) {
                return Err(CoreError::config(
                    "source_url_allowlist entries must be non-empty",
                ));
            }
            Ok(())
        }
        "github_token" => {
            // Empty string is the explicit "clear" gesture — accepted. Otherwise
            // require a minimum length that rules out obvious typos. Real format
            // validation lives in the keyring layer (Agent 14 / SECURITY.md).
            if !value.is_empty() && value.len() < 20 {
                return Err(CoreError::config(
                    "github_token looks too short to be a real token",
                ));
            }
            Ok(())
        }
        _ => Err(CoreError::config(format!("unknown setting key: {key}"))),
    }
}

#[cfg(test)]
mod sanity {
    use super::{validate_value, ACCEPTED_KEYS};

    #[test]
    fn whitelist_contains_expected_keys() {
        for k in [
            "theme",
            "poll_concurrency",
            "default_poll_interval_minutes",
            "snapshot_retention_days",
            "activity_log_retention_days",
            "source_url_allowlist",
            "github_token",
        ] {
            assert!(ACCEPTED_KEYS.contains(&k), "missing whitelist entry: {k}");
        }
    }

    #[test]
    fn validate_value_accepts_well_formed_inputs() {
        assert!(validate_value("theme", "dark").is_ok());
        assert!(validate_value("poll_concurrency", "4").is_ok());
        assert!(validate_value("default_poll_interval_minutes", "15").is_ok());
        assert!(validate_value("snapshot_retention_days", "7").is_ok());
        assert!(validate_value("activity_log_retention_days", "30").is_ok());
        assert!(validate_value("source_url_allowlist", r#"["github.com"]"#).is_ok());
        assert!(validate_value("github_token", "").is_ok());
        assert!(validate_value("github_token", "ghp_aaaaaaaaaaaaaaaaaaaa").is_ok());
    }

    #[test]
    fn validate_value_rejects_bad_inputs() {
        assert!(validate_value("theme", "neon").is_err());
        assert!(validate_value("poll_concurrency", "0").is_err());
        assert!(validate_value("poll_concurrency", "-1").is_err());
        assert!(validate_value("default_poll_interval_minutes", "0").is_err());
        assert!(validate_value("source_url_allowlist", "not-json").is_err());
        assert!(validate_value("source_url_allowlist", r#"[""]"#).is_err());
        assert!(validate_value("github_token", "short").is_err());
    }
}
