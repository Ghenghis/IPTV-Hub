//! `activity` command group. Read-only listings backing the activity log,
//! per-app update history, and per-app snapshot inventory views in the UI.
//!
//! All three commands follow the same shape as [`crate::commands::apps::list_apps`]:
//! typed input, typed output, a single `sqlx::query_as` against the real database,
//! and never canned or fabricated rows. Pagination is defensive — `limit` is clamped
//! to a hard ceiling and a large `offset` returns an empty `Vec` rather than an
//! error so the frontend can keep paging without special-casing the end of data.
//!
//! Field names on the DTOs mirror the actual column names in
//! `migrations/001_initial.sql` (`at`, `level`, `started_at`, `created_at`, …) so
//! that `serde` serialises them straight onto the wire without ad-hoc renames.

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::errors::CoreError;

/// Defensive ceiling on `limit` for paginated listings. The frontend's virtualised
/// table never needs more than a few hundred rows in flight; anything beyond this
/// is almost certainly a caller bug, so we silently clamp instead of erroring.
const MAX_LIMIT: u32 = 1000;

/// One row from `activity_log`. Column order matches the SELECT below exactly so
/// the tuple decode in `sqlx::query_as` lines up without further mapping.
type ActivityDbRow = (
    i64,            // id
    String,         // at
    Option<String>, // app_id   (nullable: ON DELETE SET NULL)
    String,         // action
    String,         // message
    String,         // level
);

/// One row from `update_history`.
type UpdateHistoryDbRow = (
    i64,            // id
    String,         // started_at
    String,         // app_id
    Option<String>, // from_version
    Option<String>, // to_version
    String,         // outcome
    Option<String>, // error_message
);

/// One row from `snapshots`.
type SnapshotDbRow = (
    String, // id
    String, // app_id
    i64,    // size_bytes
    String, // sha256
    String, // created_at
);

/// View shape returned for a single `activity_log` entry.
///
/// Field names match the DB columns verbatim — `at` for the timestamp, `level`
/// for severity — so the JSON shipped to the frontend matches what the schema
/// documentation says.
#[derive(Debug, Clone, Serialize)]
pub struct ActivityEntry {
    pub id: i64,
    pub at: String,
    pub app_id: Option<String>,
    pub action: String,
    pub message: String,
    pub level: String,
}

/// View shape returned for one `update_history` row.
///
/// `started_at` and `error_message` are the real schema column names;
/// `to_version` / `from_version` are nullable for in-flight or
/// never-completed updates.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateHistoryEntry {
    pub id: i64,
    pub started_at: String,
    pub app_id: String,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub outcome: String,
    pub error_message: Option<String>,
}

/// View shape returned for one `snapshots` row.
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotEntry {
    pub id: String,
    pub app_id: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub created_at: String,
}

/// Clamp a caller-supplied limit to [`MAX_LIMIT`]. Kept as a free fn so the
/// individual commands stay one query each and remain trivially auditable.
/// `Ord::min` is `const` since Rust 1.83 (workspace MSRV is 1.85).
const fn clamp_limit(limit: u32) -> u32 {
    if limit > MAX_LIMIT {
        MAX_LIMIT
    } else {
        limit
    }
}

/// List the most recent rows from `activity_log`, newest first.
///
/// `limit` is clamped to [`MAX_LIMIT`] silently. A large `offset` that exceeds
/// the total row count simply returns an empty `Vec` — `SQLite`'s `LIMIT … OFFSET`
/// is well-defined in that case and does not error.
#[tauri::command]
pub async fn list_activity(
    limit: u32,
    offset: u32,
    state: State<'_, AppState>,
) -> Result<Vec<ActivityEntry>, CoreError> {
    let limit = clamp_limit(limit);

    let rows: Vec<ActivityDbRow> = sqlx::query_as(
        "SELECT id, at, app_id, action, message, level \
         FROM activity_log \
         ORDER BY at DESC \
         LIMIT ? OFFSET ?",
    )
    .bind(i64::from(limit))
    .bind(i64::from(offset))
    .fetch_all(&state.db)
    .await
    .map_err(CoreError::from)?;

    Ok(rows
        .into_iter()
        .map(|r| ActivityEntry {
            id: r.0,
            at: r.1,
            app_id: r.2,
            action: r.3,
            message: r.4,
            level: r.5,
        })
        .collect())
}

/// List the most recent `update_history` rows for one `app_id`, newest first.
#[tauri::command]
pub async fn list_update_history(
    app_id: String,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<Vec<UpdateHistoryEntry>, CoreError> {
    let limit = clamp_limit(limit);

    let rows: Vec<UpdateHistoryDbRow> = sqlx::query_as(
        "SELECT id, started_at, app_id, from_version, to_version, outcome, error_message \
         FROM update_history \
         WHERE app_id = ? \
         ORDER BY started_at DESC \
         LIMIT ?",
    )
    .bind(&app_id)
    .bind(i64::from(limit))
    .fetch_all(&state.db)
    .await
    .map_err(CoreError::from)?;

    Ok(rows
        .into_iter()
        .map(|r| UpdateHistoryEntry {
            id: r.0,
            started_at: r.1,
            app_id: r.2,
            from_version: r.3,
            to_version: r.4,
            outcome: r.5,
            error_message: r.6,
        })
        .collect())
}

/// List every `snapshots` row for one `app_id`, newest first. Snapshots are
/// pruned by the retention worker, so the row count per app is bounded and
/// pagination is unnecessary here.
#[tauri::command]
pub async fn list_snapshots(
    app_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SnapshotEntry>, CoreError> {
    let rows: Vec<SnapshotDbRow> = sqlx::query_as(
        "SELECT id, app_id, size_bytes, sha256, created_at \
         FROM snapshots \
         WHERE app_id = ? \
         ORDER BY created_at DESC",
    )
    .bind(&app_id)
    .fetch_all(&state.db)
    .await
    .map_err(CoreError::from)?;

    Ok(rows
        .into_iter()
        .map(|r| SnapshotEntry {
            id: r.0,
            app_id: r.1,
            size_bytes: r.2,
            sha256: r.3,
            created_at: r.4,
        })
        .collect())
}
