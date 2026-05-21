//! Database module — opens the SQLite pool, runs migrations, and exposes typed repos.
//!
//! Agent 04 owns this module's full surface. The skeleton here is real and compiles;
//! agents fill in the remaining repo methods as their slices land.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::errors::CoreError;

pub async fn open_pool(path: &Path) -> Result<SqlitePool, CoreError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| CoreError::io(parent, e))?;
    }

    // Back up the existing db before opening; if migrations corrupt it we can swap back.
    if path.exists() {
        let bak = path.with_extension("db.bak");
        let _ = tokio::fs::copy(path, &bak).await;
    }

    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    Ok(pool)
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), CoreError> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .map_err(|e| CoreError::internal(format!("migrate: {e}")))?;
    Ok(())
}
