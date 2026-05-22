//! Centralised SQL access for the IPTV Hub core.
//!
//! Every other module talks to the database through the traits in this file, never
//! by hand-writing `sqlx::query!` invocations. The traits are kept small and
//! focused (one per logical table) so individual call sites can take only what
//! they need and so tests can swap in fakes by impl-ing the trait directly.
//!
//! The single [`SqliteRepositories`] struct implements all four traits and is
//! the only impl built into the binary. It is cheap to clone — `SqlitePool` is
//! itself an `Arc`-wrapped handle — so callers should hand it around by value
//! rather than wrapping it in another `Arc`.
//!
//! Field names on the `*Row` DTOs mirror the canonical column names in
//! `migrations/001_initial.sql` exactly so that `serde` serialises straight to
//! the JSON shape documented in `docs/DATABASE.md` without any ad-hoc renames.
//!
//! `update_history` and `snapshots` carry schema-required columns
//! (`plan_json`, `expires_at`) that the trait API does not expose. Their values
//! are filled in here with sensible defaults so the trait stays narrow:
//!
//! * `plan_json` defaults to `'{}'` — callers that need richer plan tracking
//!   should add a dedicated method rather than smuggling JSON through `record`.
//! * `expires_at` defaults to `created_at + 7 days`, matching the retention
//!   policy in `CONTRACT.md` §5.

use async_trait::async_trait;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::errors::CoreError;

/// Default snapshot retention. Matches `CONTRACT.md` §5 ("Rollback snapshots
/// are retained for 7 days by default"). The retention worker may delete
/// earlier; this is just the timestamp written at creation time.
const SNAPSHOT_RETENTION_DAYS: i64 = 7;

// ──────────────────────────────────────────────────────────────────────────────
// Row types
// ──────────────────────────────────────────────────────────────────────────────

/// One row from the `apps` table. Field names match the column names in
/// `migrations/001_initial.sql` verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRow {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub current_version: Option<String>,
    pub current_sha: Option<String>,
    pub status: String,
    pub status_message: Option<String>,
    pub last_poll_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_failure_at: Option<String>,
    pub consecutive_failures: i64,
    pub backoff_until: Option<String>,
    pub favorite: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// One row from the `activity_log` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityRow {
    pub id: i64,
    pub at: String,
    pub app_id: Option<String>,
    pub correlation: Option<String>,
    pub action: String,
    pub level: String,
    pub message: String,
    pub details_json: Option<String>,
}

/// One row from the `snapshots` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRow {
    pub id: String,
    pub app_id: String,
    pub path: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub created_at: String,
    pub expires_at: String,
}

/// One row from the `update_history` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateHistoryRow {
    pub id: i64,
    pub app_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub outcome: String,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub snapshot_id: Option<String>,
    pub error_message: Option<String>,
    pub plan_json: String,
}

// ──────────────────────────────────────────────────────────────────────────────
// Traits
// ──────────────────────────────────────────────────────────────────────────────

/// All operations against the `apps` table.
#[async_trait]
pub trait AppRepository: Send + Sync {
    /// Return every row, ordered by `id` for deterministic test snapshots.
    async fn list(&self) -> Result<Vec<AppRow>, CoreError>;

    /// Look up one row by primary key. `Ok(None)` when no such row exists.
    async fn get(&self, id: &str) -> Result<Option<AppRow>, CoreError>;

    /// Insert or replace an entire row. Used by the manifest reconciler when
    /// the manifest is reloaded and we want the DB to reflect new defaults.
    async fn upsert(&self, row: &AppRow) -> Result<(), CoreError>;

    /// Atomic status + message update with no side effects on other columns.
    /// `updated_at` is bumped to `datetime('now')`.
    async fn update_status(
        &self,
        id: &str,
        status: &str,
        message: Option<&str>,
    ) -> Result<(), CoreError>;

    /// Update the currently-installed version / sha pair atomically.
    async fn update_version(
        &self,
        id: &str,
        version: Option<&str>,
        sha: Option<&str>,
    ) -> Result<(), CoreError>;

    /// Record the outcome of one poll: bumps `last_poll_at` and either resets
    /// `consecutive_failures` (success) or increments it (failure).
    async fn touch_poll(&self, id: &str, success: bool) -> Result<(), CoreError>;

    /// Hard delete a row by id. The `apps(id)` FK on `update_history` and
    /// `snapshots` is `ON DELETE CASCADE`, so this also removes history rows.
    async fn delete(&self, id: &str) -> Result<(), CoreError>;
}

/// Append-only access to `activity_log`. The frontend reads via `list`; every
/// long-running component writes via `insert`.
#[async_trait]
pub trait ActivityLogRepository: Send + Sync {
    async fn insert(
        &self,
        app_id: &str,
        action: &str,
        message: &str,
        status: &str,
    ) -> Result<(), CoreError>;

    async fn list(&self, limit: u32, offset: u32) -> Result<Vec<ActivityRow>, CoreError>;
}

/// All operations against the `snapshots` table.
#[async_trait]
pub trait SnapshotRepository: Send + Sync {
    async fn list_for_app(&self, app_id: &str) -> Result<Vec<SnapshotRow>, CoreError>;

    /// Record a freshly created snapshot. `expires_at` is set to
    /// `created_at + 7 days`; the retention worker reads this column.
    async fn record(
        &self,
        app_id: &str,
        snapshot_id: &str,
        path: &str,
        size_bytes: i64,
        sha256: &str,
    ) -> Result<(), CoreError>;

    async fn delete(&self, snapshot_id: &str) -> Result<(), CoreError>;
}

/// All operations against the `update_history` table.
#[async_trait]
pub trait UpdateHistoryRepository: Send + Sync {
    /// Record the result of one update attempt. `started_at` and `finished_at`
    /// are both set to `datetime('now')` — callers that need to measure
    /// duration should call `update_status` on the row separately.
    async fn record(
        &self,
        app_id: &str,
        from_version: Option<&str>,
        to_version: Option<&str>,
        outcome: &str,
        message: Option<&str>,
    ) -> Result<(), CoreError>;

    async fn list_for_app(
        &self,
        app_id: &str,
        limit: u32,
    ) -> Result<Vec<UpdateHistoryRow>, CoreError>;
}

// ──────────────────────────────────────────────────────────────────────────────
// SqliteRepositories — single concrete impl backed by the project pool
// ──────────────────────────────────────────────────────────────────────────────

/// Single concrete repository implementing all four traits.
///
/// Backed by the project's `SqlitePool`. The pool is `Arc`-wrapped internally
/// by `sqlx`, so cloning this struct is cheap and Tauri state can hand it out
/// per-command without an outer `Arc`.
#[derive(Debug, Clone)]
pub struct SqliteRepositories {
    pub pool: SqlitePool,
}

impl SqliteRepositories {
    /// Construct a repository wrapper around an already-opened pool. The pool
    /// is expected to have migrations applied already — see
    /// [`crate::db::run_migrations`].
    pub const fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

/// Tuple decode for `apps` — column order must match every SELECT below.
/// Kept as a private alias to keep `query_as` calls one-liners and dodge
/// `clippy::type_complexity` on the public surface.
type AppDbRow = (
    String,         // id
    String,         // name
    String,         // source_type
    Option<String>, // current_version
    Option<String>, // current_sha
    String,         // status
    Option<String>, // status_message
    Option<String>, // last_poll_at
    Option<String>, // last_success_at
    Option<String>, // last_failure_at
    i64,            // consecutive_failures
    Option<String>, // backoff_until
    i64,            // favorite (0/1)
    i64,            // enabled  (0/1)
    String,         // created_at
    String,         // updated_at
);

fn app_row_from_db(r: AppDbRow) -> AppRow {
    AppRow {
        id: r.0,
        name: r.1,
        source_type: r.2,
        current_version: r.3,
        current_sha: r.4,
        status: r.5,
        status_message: r.6,
        last_poll_at: r.7,
        last_success_at: r.8,
        last_failure_at: r.9,
        consecutive_failures: r.10,
        backoff_until: r.11,
        favorite: r.12 != 0,
        enabled: r.13 != 0,
        created_at: r.14,
        updated_at: r.15,
    }
}

const APP_SELECT: &str = "SELECT id, name, source_type, current_version, current_sha, status, \
     status_message, last_poll_at, last_success_at, last_failure_at, \
     consecutive_failures, backoff_until, favorite, enabled, created_at, updated_at \
     FROM apps";

#[async_trait]
impl AppRepository for SqliteRepositories {
    async fn list(&self) -> Result<Vec<AppRow>, CoreError> {
        let sql = format!("{APP_SELECT} ORDER BY id");
        let rows: Vec<AppDbRow> = sqlx::query_as(&sql).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(app_row_from_db).collect())
    }

    async fn get(&self, id: &str) -> Result<Option<AppRow>, CoreError> {
        let sql = format!("{APP_SELECT} WHERE id = ?");
        let row: Option<AppDbRow> = sqlx::query_as(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(app_row_from_db))
    }

    async fn upsert(&self, row: &AppRow) -> Result<(), CoreError> {
        sqlx::query(
            "INSERT INTO apps (id, name, source_type, current_version, current_sha, status, \
                 status_message, last_poll_at, last_success_at, last_failure_at, \
                 consecutive_failures, backoff_until, favorite, enabled, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
                 name = excluded.name, \
                 source_type = excluded.source_type, \
                 current_version = excluded.current_version, \
                 current_sha = excluded.current_sha, \
                 status = excluded.status, \
                 status_message = excluded.status_message, \
                 last_poll_at = excluded.last_poll_at, \
                 last_success_at = excluded.last_success_at, \
                 last_failure_at = excluded.last_failure_at, \
                 consecutive_failures = excluded.consecutive_failures, \
                 backoff_until = excluded.backoff_until, \
                 favorite = excluded.favorite, \
                 enabled = excluded.enabled, \
                 updated_at = datetime('now')",
        )
        .bind(&row.id)
        .bind(&row.name)
        .bind(&row.source_type)
        .bind(&row.current_version)
        .bind(&row.current_sha)
        .bind(&row.status)
        .bind(&row.status_message)
        .bind(&row.last_poll_at)
        .bind(&row.last_success_at)
        .bind(&row.last_failure_at)
        .bind(row.consecutive_failures)
        .bind(&row.backoff_until)
        .bind(i64::from(row.favorite))
        .bind(i64::from(row.enabled))
        .bind(&row.created_at)
        .bind(&row.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn update_status(
        &self,
        id: &str,
        status: &str,
        message: Option<&str>,
    ) -> Result<(), CoreError> {
        sqlx::query(
            "UPDATE apps SET status = ?, status_message = ?, updated_at = datetime('now') \
             WHERE id = ?",
        )
        .bind(status)
        .bind(message)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn update_version(
        &self,
        id: &str,
        version: Option<&str>,
        sha: Option<&str>,
    ) -> Result<(), CoreError> {
        sqlx::query(
            "UPDATE apps SET current_version = ?, current_sha = ?, updated_at = datetime('now') \
             WHERE id = ?",
        )
        .bind(version)
        .bind(sha)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn touch_poll(&self, id: &str, success: bool) -> Result<(), CoreError> {
        let now = Utc::now().to_rfc3339();
        if success {
            sqlx::query(
                "UPDATE apps SET last_poll_at = ?, last_success_at = ?, \
                     consecutive_failures = 0, backoff_until = NULL, \
                     updated_at = datetime('now') \
                 WHERE id = ?",
            )
            .bind(&now)
            .bind(&now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        } else {
            sqlx::query(
                "UPDATE apps SET last_poll_at = ?, last_failure_at = ?, \
                     consecutive_failures = consecutive_failures + 1, \
                     updated_at = datetime('now') \
                 WHERE id = ?",
            )
            .bind(&now)
            .bind(&now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), CoreError> {
        sqlx::query("DELETE FROM apps WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[async_trait]
impl ActivityLogRepository for SqliteRepositories {
    async fn insert(
        &self,
        app_id: &str,
        action: &str,
        message: &str,
        status: &str,
    ) -> Result<(), CoreError> {
        sqlx::query(
            "INSERT INTO activity_log (at, app_id, action, level, message) \
             VALUES (datetime('now'), ?, ?, ?, ?)",
        )
        .bind(app_id)
        .bind(action)
        .bind(status)
        .bind(message)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn list(&self, limit: u32, offset: u32) -> Result<Vec<ActivityRow>, CoreError> {
        type Row = (
            i64,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
            String,
            Option<String>,
        );
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, at, app_id, correlation, action, level, message, details_json \
             FROM activity_log ORDER BY at DESC, id DESC LIMIT ? OFFSET ?",
        )
        .bind(i64::from(limit))
        .bind(i64::from(offset))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| ActivityRow {
                id: r.0,
                at: r.1,
                app_id: r.2,
                correlation: r.3,
                action: r.4,
                level: r.5,
                message: r.6,
                details_json: r.7,
            })
            .collect())
    }
}

#[async_trait]
impl SnapshotRepository for SqliteRepositories {
    async fn list_for_app(&self, app_id: &str) -> Result<Vec<SnapshotRow>, CoreError> {
        type Row = (String, String, String, i64, String, String, String);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, app_id, path, size_bytes, sha256, created_at, expires_at \
             FROM snapshots WHERE app_id = ? ORDER BY created_at DESC",
        )
        .bind(app_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| SnapshotRow {
                id: r.0,
                app_id: r.1,
                path: r.2,
                size_bytes: r.3,
                sha256: r.4,
                created_at: r.5,
                expires_at: r.6,
            })
            .collect())
    }

    async fn record(
        &self,
        app_id: &str,
        snapshot_id: &str,
        path: &str,
        size_bytes: i64,
        sha256: &str,
    ) -> Result<(), CoreError> {
        let now = Utc::now();
        let created_at = now.to_rfc3339();
        let expires_at = (now + Duration::days(SNAPSHOT_RETENTION_DAYS)).to_rfc3339();
        sqlx::query(
            "INSERT INTO snapshots (id, app_id, path, size_bytes, sha256, created_at, expires_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(snapshot_id)
        .bind(app_id)
        .bind(path)
        .bind(size_bytes)
        .bind(sha256)
        .bind(&created_at)
        .bind(&expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn delete(&self, snapshot_id: &str) -> Result<(), CoreError> {
        sqlx::query("DELETE FROM snapshots WHERE id = ?")
            .bind(snapshot_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[async_trait]
impl UpdateHistoryRepository for SqliteRepositories {
    async fn record(
        &self,
        app_id: &str,
        from_version: Option<&str>,
        to_version: Option<&str>,
        outcome: &str,
        message: Option<&str>,
    ) -> Result<(), CoreError> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO update_history \
                 (app_id, started_at, finished_at, outcome, from_version, to_version, \
                  error_message, plan_json) \
             VALUES (?, ?, ?, ?, ?, ?, ?, '{}')",
        )
        .bind(app_id)
        .bind(&now)
        .bind(&now)
        .bind(outcome)
        .bind(from_version)
        .bind(to_version)
        .bind(message)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn list_for_app(
        &self,
        app_id: &str,
        limit: u32,
    ) -> Result<Vec<UpdateHistoryRow>, CoreError> {
        type Row = (
            i64,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
        );
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, app_id, started_at, finished_at, outcome, from_version, to_version, \
                 snapshot_id, error_message, plan_json \
             FROM update_history WHERE app_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
        )
        .bind(app_id)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| UpdateHistoryRow {
                id: r.0,
                app_id: r.1,
                started_at: r.2,
                finished_at: r.3,
                outcome: r.4,
                from_version: r.5,
                to_version: r.6,
                snapshot_id: r.7,
                error_message: r.8,
                plan_json: r.9,
            })
            .collect())
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests — real in-memory SQLite, real migrations, real roundtrips.
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    /// Spin up an in-memory `SQLite` pool with the project's migrations applied.
    ///
    /// `:memory:` databases are per-connection in `SQLite`, so we cap the pool
    /// at one connection. That is enough for unit tests that exercise one
    /// repository call at a time, and avoids the "shared cache" URL syntax
    /// that varies across sqlx versions.
    async fn memory_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("parse sqlite memory url")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("connect in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");
        pool
    }

    fn fixture_app(id: &str) -> AppRow {
        AppRow {
            id: id.to_string(),
            name: format!("App {id}"),
            source_type: "git".to_string(),
            current_version: None,
            current_sha: None,
            status: "idle".to_string(),
            status_message: None,
            last_poll_at: None,
            last_success_at: None,
            last_failure_at: None,
            consecutive_failures: 0,
            backoff_until: None,
            favorite: false,
            enabled: true,
            created_at: "2026-01-01T00:00:00+00:00".to_string(),
            updated_at: "2026-01-01T00:00:00+00:00".to_string(),
        }
    }

    #[tokio::test]
    async fn app_repository_upsert_get_update_delete_roundtrip() {
        let repo = SqliteRepositories::new(memory_pool().await);

        // Insert via upsert, then fetch it back.
        let row = fixture_app("kodi");
        AppRepository::upsert(&repo, &row).await.expect("upsert");
        let fetched = AppRepository::get(&repo, "kodi")
            .await
            .expect("get")
            .expect("row present");
        assert_eq!(fetched.id, "kodi");
        assert_eq!(fetched.name, "App kodi");
        assert_eq!(fetched.status, "idle");
        assert!(fetched.enabled);
        assert!(!fetched.favorite);

        // Status update only touches the two columns it should.
        AppRepository::update_status(&repo, "kodi", "ok", Some("hello"))
            .await
            .expect("update_status");
        let after_status = AppRepository::get(&repo, "kodi")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(after_status.status, "ok");
        assert_eq!(after_status.status_message.as_deref(), Some("hello"));
        assert_eq!(after_status.name, "App kodi"); // unchanged

        // Version update writes the new values.
        AppRepository::update_version(&repo, "kodi", Some("19.4"), Some("abcdef"))
            .await
            .expect("update_version");
        let after_version = AppRepository::get(&repo, "kodi")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(after_version.current_version.as_deref(), Some("19.4"));
        assert_eq!(after_version.current_sha.as_deref(), Some("abcdef"));

        // Touch poll — failure path bumps consecutive_failures, success resets.
        AppRepository::touch_poll(&repo, "kodi", false)
            .await
            .expect("poll fail");
        let after_fail = AppRepository::get(&repo, "kodi")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(after_fail.consecutive_failures, 1);
        assert!(after_fail.last_failure_at.is_some());

        AppRepository::touch_poll(&repo, "kodi", true)
            .await
            .expect("poll ok");
        let after_ok = AppRepository::get(&repo, "kodi")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(after_ok.consecutive_failures, 0);
        assert!(after_ok.last_success_at.is_some());
        assert!(after_ok.backoff_until.is_none());

        // Listing returns the one row we inserted.
        let listed = AppRepository::list(&repo).await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "kodi");

        // Delete removes it; subsequent get returns None.
        AppRepository::delete(&repo, "kodi").await.expect("delete");
        assert!(AppRepository::get(&repo, "kodi")
            .await
            .expect("get")
            .is_none());
        assert!(AppRepository::list(&repo).await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn activity_log_insert_and_list_paginates_newest_first() {
        let repo = SqliteRepositories::new(memory_pool().await);
        // FK on activity_log.app_id requires a real app row first.
        AppRepository::upsert(&repo, &fixture_app("kodi"))
            .await
            .expect("upsert app");

        for i in 0..3_u32 {
            repo.insert("kodi", "poll", &format!("entry {i}"), "info")
                .await
                .expect("insert activity");
        }

        let page = ActivityLogRepository::list(&repo, 2, 0)
            .await
            .expect("list activity");
        assert_eq!(page.len(), 2);
        // Newest first — last insert wins.
        assert_eq!(page[0].message, "entry 2");
        assert_eq!(page[0].action, "poll");
        assert_eq!(page[0].level, "info");
        assert_eq!(page[0].app_id.as_deref(), Some("kodi"));

        let page2 = ActivityLogRepository::list(&repo, 2, 2)
            .await
            .expect("list activity offset");
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].message, "entry 0");
    }

    #[tokio::test]
    async fn snapshot_record_list_delete_roundtrip() {
        let repo = SqliteRepositories::new(memory_pool().await);
        AppRepository::upsert(&repo, &fixture_app("kodi"))
            .await
            .expect("upsert app");

        SnapshotRepository::record(
            &repo,
            "kodi",
            "snap-1",
            "/tmp/snap1.tar.zst",
            12345,
            "deadbeef",
        )
        .await
        .expect("record snap-1");
        SnapshotRepository::record(
            &repo,
            "kodi",
            "snap-2",
            "/tmp/snap2.tar.zst",
            67890,
            "cafef00d",
        )
        .await
        .expect("record snap-2");

        let listed = SnapshotRepository::list_for_app(&repo, "kodi")
            .await
            .expect("list snapshots");
        assert_eq!(listed.len(), 2);
        // Each row carries the schema-required expires_at, populated by the repo.
        for snap in &listed {
            assert_eq!(snap.app_id, "kodi");
            assert!(!snap.expires_at.is_empty());
            assert!(!snap.created_at.is_empty());
        }
        let by_id: std::collections::HashSet<&str> = listed.iter().map(|s| s.id.as_str()).collect();
        assert!(by_id.contains("snap-1"));
        assert!(by_id.contains("snap-2"));

        SnapshotRepository::delete(&repo, "snap-1")
            .await
            .expect("delete snap-1");
        let after_delete = SnapshotRepository::list_for_app(&repo, "kodi")
            .await
            .expect("list after delete");
        assert_eq!(after_delete.len(), 1);
        assert_eq!(after_delete[0].id, "snap-2");
    }

    #[tokio::test]
    async fn update_history_record_and_list_orders_newest_first() {
        let repo = SqliteRepositories::new(memory_pool().await);
        AppRepository::upsert(&repo, &fixture_app("kodi"))
            .await
            .expect("upsert app");

        UpdateHistoryRepository::record(&repo, "kodi", Some("1.0"), Some("1.1"), "success", None)
            .await
            .expect("record success");
        UpdateHistoryRepository::record(
            &repo,
            "kodi",
            Some("1.1"),
            Some("1.2"),
            "failure",
            Some("boom"),
        )
        .await
        .expect("record failure");

        let listed = UpdateHistoryRepository::list_for_app(&repo, "kodi", 10)
            .await
            .expect("list history");
        assert_eq!(listed.len(), 2);
        // Newest first — failure row wins.
        assert_eq!(listed[0].outcome, "failure");
        assert_eq!(listed[0].error_message.as_deref(), Some("boom"));
        assert_eq!(listed[0].from_version.as_deref(), Some("1.1"));
        assert_eq!(listed[0].to_version.as_deref(), Some("1.2"));
        assert_eq!(listed[0].plan_json, "{}");
        assert_eq!(listed[1].outcome, "success");
        assert!(listed[1].error_message.is_none());

        // Limit clamps the result.
        let one = UpdateHistoryRepository::list_for_app(&repo, "kodi", 1)
            .await
            .expect("list with limit");
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].outcome, "failure");
    }
}
