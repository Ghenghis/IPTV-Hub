//! `updates` command group — the four IPC commands that drive the update modal.
//!
//! Each command follows the same pattern as [`crate::commands::apps`]:
//! `#[tauri::command] pub async fn`, typed `Result<T, CoreError>` return,
//! never canned payloads. The source-specific knowledge lives in
//! [`crate::sources`]; this module is the orchestration glue around it:
//!
//! * looking up an [`AppEntry`] from the in-memory manifest,
//! * dispatching to the right [`crate::sources::Source`] implementation,
//! * persisting the outcome (`apps.status`, `apps.last_poll_at`,
//!   `apps.last_success_at`, `current_version`, `current_sha`,
//!   `snapshots`, `activity_log`, `update_history`),
//! * pumping the apply progress channel onto a Tauri event so the UI can
//!   render its step indicator.
//!
//! The rollback story is owned here: [`apply_update`] takes a real
//! [`crate::rollback::create_archive`] snapshot of the upstream directory
//! before calling `Source::apply`, then wraps the call in
//! [`crate::rollback::begin_swap`] / [`crate::rollback::SwapGuard::commit`].
//! If the apply fails, the [`crate::rollback::SwapGuard`] drops without
//! committing — the marker stays on disk and the next process launch
//! restores from the snapshot via
//! [`crate::rollback::recover_orphan_swaps`]. That is the crash-safe
//! recovery contract from `docs/UPDATE_FLOWS.md`.

use std::path::PathBuf;
use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter as _, State};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::app_state::AppState;
use crate::errors::CoreError;
use crate::manifest::types::AppEntry;
use crate::rollback::{begin_swap, create_archive, restore_archive, SwapGuard};
use crate::sources::{dispatch, ApplyCtx, ProgressEvent, UpdateOutcome, UpdatePlan, UpdateState};

/// Channel capacity for the apply progress pump. The receiver lives in a
/// short-lived task that drains every event onto the Tauri event bus, so a
/// buffer of 64 is comfortably larger than any single apply emits per tick.
const PROGRESS_CHANNEL_CAPACITY: usize = 64;

/// Tauri event name the frontend subscribes to for per-app apply progress.
/// Documented in `docs/IPC.md` as the progress sink for the update modal.
const PROGRESS_EVENT: &str = "iptv-hub://progress";

/// How long to wait for the progress pump to drain after `Source::apply`
/// returns. The pump exits when its sender is dropped (with `ctx`), so this
/// is a hard ceiling on the drain — not a normal-path delay.
const PROGRESS_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

/// Default rollback retention if `config.snapshot_retention_days` overflows
/// a `Duration::try_days` call. Matches `AppConfig::default()`.
const FALLBACK_RETENTION_DAYS: i64 = 7;

// ── shared helpers ───────────────────────────────────────────────────────────

/// Look the app up by id in the in-memory manifest. The `parking_lot` read
/// guard is dropped before this function returns so callers can `.await`
/// without holding a `!Send` guard across an await boundary.
fn lookup_app(state: &State<'_, AppState>, id: &str) -> Result<AppEntry, CoreError> {
    state
        .manifest
        .read()
        .apps
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or_else(|| CoreError::config(format!("app not found: {id}")))
}

/// Append one row to `activity_log`. Mirrors `commands::launch::log_activity`
/// and `poller::insert_activity`: errors are swallowed because the work that
/// produced the row has already happened, and the user-facing failure (if
/// any) is surfaced via the command's own `Result`.
async fn log_activity(
    state: &State<'_, AppState>,
    app_id: &str,
    action: &str,
    level: &str,
    message: &str,
) {
    let _ = sqlx::query(
        "INSERT INTO activity_log (at, app_id, action, level, message) \
         VALUES (datetime('now'), ?, ?, ?, ?)",
    )
    .bind(app_id)
    .bind(action)
    .bind(level)
    .bind(message)
    .execute(&state.db)
    .await;
}

/// Append one row to `activity_log` carrying a `details_json` blob — used by
/// `apply_update` and `rollback` to record the outcome payload so the
/// activity-log UI can render the version transition without re-querying.
async fn log_activity_with_details(
    state: &State<'_, AppState>,
    app_id: &str,
    action: &str,
    level: &str,
    message: &str,
    details_json: &str,
) {
    let _ = sqlx::query(
        "INSERT INTO activity_log (at, app_id, action, level, message, details_json) \
         VALUES (datetime('now'), ?, ?, ?, ?, ?)",
    )
    .bind(app_id)
    .bind(action)
    .bind(level)
    .bind(message)
    .bind(details_json)
    .execute(&state.db)
    .await;
}

/// Conventional upstream directory for an app — the same path
/// `git`/`web` sources use, and the target the rollback marker records.
/// Other source types (release, installer, tizen) manage their own install
/// dirs internally but still benefit from a snapshot of this canonical dir
/// for crash recovery, because it is where their working copies live.
fn upstream_dir(app: &AppEntry, state: &State<'_, AppState>) -> PathBuf {
    state.paths.apps_root().join("upstream").join(&app.id)
}

// ── check_for_update ─────────────────────────────────────────────────────────

/// Run the source `check` for one app, persist the result, log activity,
/// return the [`UpdateState`] verbatim. This is what the UI's "Sync now"
/// button calls; the background poller calls the same dispatch chain via
/// its own bookkeeping in [`crate::poller`].
#[tauri::command]
pub async fn check_for_update(
    id: String,
    state: State<'_, AppState>,
) -> Result<UpdateState, CoreError> {
    let app = lookup_app(&state, &id)?;
    let source = dispatch(app.source_type);
    let result = source.check(&app, &state.paths).await;
    let now = Utc::now().to_rfc3339();

    match &result {
        Ok(UpdateState::UpToDate { current }) => {
            persist_check_up_to_date(&state, &id, current, &now).await;
        }
        Ok(UpdateState::UpdateAvailable { from, to, summary }) => {
            persist_check_update_available(&state, &id, from, to, summary, &now).await;
        }
        Ok(UpdateState::Error { message }) => {
            persist_check_failure(&state, &id, message, &now).await;
        }
        Err(e) => {
            persist_check_failure(&state, &id, &e.to_string(), &now).await;
        }
    }

    result
}

async fn persist_check_up_to_date(
    state: &State<'_, AppState>,
    app_id: &str,
    current: &str,
    now: &str,
) {
    let _ = sqlx::query(
        "UPDATE apps \
         SET status = ?, status_message = NULL, current_sha = ?, \
             last_poll_at = ?, last_success_at = ?, \
             consecutive_failures = 0, backoff_until = NULL, \
             updated_at = datetime('now') \
         WHERE id = ?",
    )
    .bind("ok")
    .bind(current)
    .bind(now)
    .bind(now)
    .bind(app_id)
    .execute(&state.db)
    .await;
    log_activity(
        state,
        app_id,
        "check",
        "info",
        &format!("up-to-date · {current}"),
    )
    .await;
}

async fn persist_check_update_available(
    state: &State<'_, AppState>,
    app_id: &str,
    from: &str,
    to: &str,
    summary: &str,
    now: &str,
) {
    let _ = sqlx::query(
        "UPDATE apps \
         SET status = ?, status_message = ?, current_sha = ?, \
             last_poll_at = ?, last_success_at = ?, \
             consecutive_failures = 0, backoff_until = NULL, \
             updated_at = datetime('now') \
         WHERE id = ?",
    )
    .bind("update_available")
    .bind(summary)
    .bind(from)
    .bind(now)
    .bind(now)
    .bind(app_id)
    .execute(&state.db)
    .await;
    log_activity(
        state,
        app_id,
        "check",
        "info",
        &format!("update available · {from} -> {to}"),
    )
    .await;
}

async fn persist_check_failure(
    state: &State<'_, AppState>,
    app_id: &str,
    message: &str,
    now: &str,
) {
    let _ = sqlx::query(
        "UPDATE apps \
         SET status = ?, status_message = ?, last_poll_at = ?, last_failure_at = ?, \
             consecutive_failures = consecutive_failures + 1, \
             updated_at = datetime('now') \
         WHERE id = ?",
    )
    .bind("error")
    .bind(message)
    .bind(now)
    .bind(now)
    .bind(app_id)
    .execute(&state.db)
    .await;
    log_activity(state, app_id, "check", "error", message).await;
}

// ── plan_update ──────────────────────────────────────────────────────────────

/// Render the update plan for the UI's update modal. Read-only — no DB
/// writes, no side effects. The frontend renders the returned
/// [`UpdatePlan`] verbatim without inventing any text.
#[tauri::command]
pub async fn plan_update(id: String, state: State<'_, AppState>) -> Result<UpdatePlan, CoreError> {
    let app = lookup_app(&state, &id)?;
    let source = dispatch(app.source_type);
    source.plan(&app, &state.paths).await
}

// ── apply_update ─────────────────────────────────────────────────────────────

/// What we recorded when (and if) we snapshotted the upstream directory
/// before calling `Source::apply`. `id` is empty when the target directory
/// did not exist (first-time install), in which case no marker was written.
struct Snapshot {
    id: String,
    path: PathBuf,
    guard: Option<SwapGuard>,
}

impl Snapshot {
    const fn is_empty(&self) -> bool {
        self.guard.is_none()
    }

    fn id_for_history(&self) -> Option<&str> {
        if self.id.is_empty() {
            None
        } else {
            Some(&self.id)
        }
    }
}

/// Snapshot the existing upstream dir if there is one and register a swap
/// marker. A first-time install has nothing to snapshot — in that case we
/// return an empty `Snapshot` (no DB row, no swap marker). Recovery for the
/// no-snapshot case is just "delete the half-extracted target on next
/// launch", which `recover_orphan_swaps` does naturally because there is no
/// marker pointing at it.
async fn snapshot_for_apply(
    state: &State<'_, AppState>,
    app_id: &str,
    target_dir: &std::path::Path,
) -> Result<Snapshot, CoreError> {
    if !target_dir.exists() {
        return Ok(Snapshot {
            id: String::new(),
            path: PathBuf::new(),
            guard: None,
        });
    }

    // Short version label is used only in the filename; truncating the app
    // id keeps the on-disk path tidy.
    let short_version: String = app_id.chars().take(24).collect();
    let cache_root = state.paths.apps_root().join("cache");
    let snap = create_archive(app_id, &short_version, target_dir, &cache_root).await?;
    let snapshot_id = snap.id.clone();
    let snapshot_path = snap.path.clone();

    let created_at = Utc::now();
    let retention = chrono::Duration::try_days(i64::from(state.config.snapshot_retention_days))
        .unwrap_or_else(|| chrono::Duration::days(FALLBACK_RETENTION_DAYS));
    let expires_at = created_at + retention;

    sqlx::query(
        "INSERT INTO snapshots (id, app_id, path, size_bytes, sha256, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&snapshot_id)
    .bind(app_id)
    .bind(snap.path.to_string_lossy().to_string())
    .bind(i64::try_from(snap.size_bytes).unwrap_or(i64::MAX))
    .bind(&snap.sha256)
    .bind(created_at.to_rfc3339())
    .bind(expires_at.to_rfc3339())
    .execute(&state.db)
    .await?;

    let guard = begin_swap(app_id, &state.paths, &snap.path, target_dir)?;

    Ok(Snapshot {
        id: snapshot_id,
        path: snapshot_path,
        guard: Some(guard),
    })
}

/// Persist a successful apply: commit the swap guard, update `apps`, record
/// `update_history`, and log the outcome to `activity_log`.
async fn persist_apply_success(
    state: &State<'_, AppState>,
    app_id: &str,
    outcome: &UpdateOutcome,
    mut snapshot: Snapshot,
    plan_meta: &PlanMeta,
    started_at: &str,
    finished_at: &str,
) -> Result<(), CoreError> {
    if let Some(g) = snapshot.guard.take() {
        g.commit()?;
    }
    sqlx::query(
        "UPDATE apps \
         SET status = 'ok', status_message = NULL, \
             current_version = COALESCE(?, current_version), \
             current_sha = COALESCE(?, current_sha), \
             last_poll_at = ?, last_success_at = ?, \
             consecutive_failures = 0, backoff_until = NULL, \
             updated_at = datetime('now') \
         WHERE id = ?",
    )
    .bind(outcome.new_version.clone())
    .bind(outcome.new_sha.clone())
    .bind(finished_at)
    .bind(finished_at)
    .bind(app_id)
    .execute(&state.db)
    .await?;

    let _ = sqlx::query(
        "INSERT INTO update_history \
         (app_id, started_at, finished_at, outcome, from_version, to_version, snapshot_id, plan_json) \
         VALUES (?, ?, ?, 'ok', ?, ?, ?, ?)",
    )
    .bind(app_id)
    .bind(started_at)
    .bind(finished_at)
    .bind(&plan_meta.from_label)
    .bind(&plan_meta.to_label)
    .bind(snapshot.id_for_history())
    .bind(&plan_meta.plan_json)
    .execute(&state.db)
    .await;

    let snapshot_id_json = if snapshot.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(snapshot.id.clone())
    };
    let snapshot_path_json = if snapshot.path.as_os_str().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(snapshot.path.to_string_lossy().into_owned())
    };

    let details = serde_json::json!({
        "new_version": outcome.new_version,
        "new_sha": outcome.new_sha,
        "bytes_downloaded": outcome.bytes_downloaded,
        "elapsed_ms": outcome.elapsed_ms,
        "snapshot_id": snapshot_id_json,
        "snapshot_path": snapshot_path_json,
    })
    .to_string();

    log_activity_with_details(
        state,
        app_id,
        "apply",
        "info",
        &format!(
            "updated · {} -> {}",
            plan_meta.from_label, plan_meta.to_label
        ),
        &details,
    )
    .await;

    Ok(())
}

/// Persist a failed apply: drop the guard (which leaves the marker on disk
/// for `recover_orphan_swaps`), mark the app as `error`, write the failure
/// to `update_history`, and log the error message.
async fn persist_apply_failure(
    state: &State<'_, AppState>,
    app_id: &str,
    message: &str,
    snapshot: Snapshot,
    plan_meta: &PlanMeta,
    started_at: &str,
    finished_at: &str,
) {
    drop(snapshot.guard);
    let _ = sqlx::query(
        "UPDATE apps \
         SET status = 'error', status_message = ?, \
             last_poll_at = ?, last_failure_at = ?, \
             consecutive_failures = consecutive_failures + 1, \
             updated_at = datetime('now') \
         WHERE id = ?",
    )
    .bind(message)
    .bind(finished_at)
    .bind(finished_at)
    .bind(app_id)
    .execute(&state.db)
    .await;

    let snapshot_id_for_history: Option<&str> = if snapshot.id.is_empty() {
        None
    } else {
        Some(&snapshot.id)
    };
    let _ = sqlx::query(
        "INSERT INTO update_history \
         (app_id, started_at, finished_at, outcome, from_version, to_version, snapshot_id, \
          error_message, plan_json) \
         VALUES (?, ?, ?, 'error', ?, ?, ?, ?, ?)",
    )
    .bind(app_id)
    .bind(started_at)
    .bind(finished_at)
    .bind(&plan_meta.from_label)
    .bind(&plan_meta.to_label)
    .bind(snapshot_id_for_history)
    .bind(message)
    .bind(&plan_meta.plan_json)
    .execute(&state.db)
    .await;

    log_activity(state, app_id, "apply", "error", message).await;
}

/// Plan metadata captured before `Source::apply` consumes the plan. Used so
/// the success and failure paths can record `from`/`to` and the plan JSON
/// without re-planning.
struct PlanMeta {
    from_label: String,
    to_label: String,
    plan_json: String,
}

impl PlanMeta {
    fn from_plan(plan: &UpdatePlan) -> Self {
        Self {
            from_label: plan.from_label.clone(),
            to_label: plan.to_label.clone(),
            plan_json: serde_json::to_string(plan).unwrap_or_else(|_| "{}".to_string()),
        }
    }
}

/// Apply an update end-to-end:
///
/// 1. Re-plan, so apply runs against a fresh snapshot of upstream's state.
/// 2. Snapshot the upstream directory (if any) and write a swap marker.
/// 3. Spawn a progress pump that drains `ApplyCtx::progress` onto Tauri.
/// 4. Run `source.apply`. On success: commit the swap marker, update the
///    `apps` row, write `update_history`, log activity. On failure: drop
///    the [`SwapGuard`] without committing — `recover_orphan_swaps` will
///    restore from the snapshot on the next process launch.
#[tauri::command]
pub async fn apply_update(
    id: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<UpdateOutcome, CoreError> {
    let app = lookup_app(&state, &id)?;
    let source = dispatch(app.source_type);

    // Re-plan so apply() works against the latest state. Cheap and removes
    // the stale-plan race window between plan_update() and apply_update().
    let plan = source.plan(&app, &state.paths).await?;
    let plan_meta = PlanMeta::from_plan(&plan);

    let target_dir = upstream_dir(&app, &state);
    let snapshot = snapshot_for_apply(&state, &id, &target_dir).await?;

    // Progress pump: drain ProgressEvent → Tauri event bus.
    let (progress_tx, mut progress_rx) = mpsc::channel::<ProgressEvent>(PROGRESS_CHANNEL_CAPACITY);
    let app_handle_for_pump = app_handle.clone();
    let pump = tokio::spawn(async move {
        while let Some(evt) = progress_rx.recv().await {
            // Best-effort emit; a closed window is not a failure of the apply.
            let _ = app_handle_for_pump.emit(PROGRESS_EVENT, &evt);
        }
    });

    let cancel = CancellationToken::new();
    let ctx = ApplyCtx {
        paths: state.paths.clone(),
        progress: progress_tx,
        cancel: cancel.clone(),
    };

    let started_at = Utc::now().to_rfc3339();
    let apply_result = source.apply(&app, plan, ctx).await;

    // The pump exits when the sender is dropped (which happens above when
    // `ctx` falls out of scope at the end of `apply().await`). We wait
    // briefly for any in-flight events to drain before reporting back.
    drop(cancel);
    let _ = tokio::time::timeout(PROGRESS_DRAIN_TIMEOUT, pump).await;

    let finished_at = Utc::now().to_rfc3339();

    match apply_result {
        Ok(outcome) => {
            persist_apply_success(
                &state,
                &id,
                &outcome,
                snapshot,
                &plan_meta,
                &started_at,
                &finished_at,
            )
            .await?;
            Ok(outcome)
        }
        Err(e) => {
            let message = e.to_string();
            persist_apply_failure(
                &state,
                &id,
                &message,
                snapshot,
                &plan_meta,
                &started_at,
                &finished_at,
            )
            .await;
            Err(e)
        }
    }
}

// ── rollback ─────────────────────────────────────────────────────────────────

/// Restore an app to a previous snapshot. Looks the archive path up from
/// the `snapshots` table by `(app_id, snapshot_id)`, dispatches to the
/// source's rollback hook (each source knows whether it needs to do extra
/// work — e.g. the installer source re-runs the uninstaller before
/// extracting), updates `apps.status` and logs the activity.
///
/// If the source's rollback hook returns `NotSupported` (web and release
/// may choose to do so because they have no source-specific teardown), we
/// fall back to a plain [`restore_archive`] of the upstream directory. The
/// contract documented in `docs/UPDATE_FLOWS.md` §4 is that every source
/// can be rolled back, even if its source-specific hook is a no-op.
#[tauri::command]
pub async fn rollback(
    id: String,
    snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<(), CoreError> {
    let app = lookup_app(&state, &id)?;

    // Look the archive path up by composite key (app_id, snapshot_id).
    let row: (String,) = sqlx::query_as("SELECT path FROM snapshots WHERE id = ? AND app_id = ?")
        .bind(&snapshot_id)
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| {
            CoreError::config(format!("snapshot '{snapshot_id}' not found for app '{id}'"))
        })?;

    let archive = PathBuf::from(row.0);
    if !archive.exists() {
        return Err(CoreError::config(format!(
            "snapshot archive missing on disk: {}",
            archive.display()
        )));
    }

    let source = dispatch(app.source_type);
    let source_result = source.rollback(&app, &archive, &state.paths).await;
    let rollback_result = match source_result {
        Err(CoreError::NotSupported { .. }) => {
            let target = upstream_dir(&app, &state);
            restore_archive(&archive, &target).await
        }
        other => other,
    };

    let now_iso = Utc::now().to_rfc3339();
    match rollback_result {
        Ok(()) => {
            sqlx::query(
                "UPDATE apps \
                 SET status = 'ok', status_message = NULL, \
                     last_poll_at = ?, last_success_at = ?, \
                     consecutive_failures = 0, backoff_until = NULL, \
                     updated_at = datetime('now') \
                 WHERE id = ?",
            )
            .bind(&now_iso)
            .bind(&now_iso)
            .bind(&id)
            .execute(&state.db)
            .await?;

            let details = serde_json::json!({
                "snapshot_id": snapshot_id,
                "archive": archive.to_string_lossy(),
            })
            .to_string();
            log_activity_with_details(
                &state,
                &id,
                "rollback",
                "info",
                &format!("rolled back to snapshot {snapshot_id}"),
                &details,
            )
            .await;
            Ok(())
        }
        Err(e) => {
            let message = e.to_string();
            let _ = sqlx::query(
                "UPDATE apps \
                 SET status = 'error', status_message = ?, \
                     last_poll_at = ?, last_failure_at = ?, \
                     consecutive_failures = consecutive_failures + 1, \
                     updated_at = datetime('now') \
                 WHERE id = ?",
            )
            .bind(&message)
            .bind(&now_iso)
            .bind(&now_iso)
            .bind(&id)
            .execute(&state.db)
            .await;
            log_activity(&state, &id, "rollback", "error", &message).await;
            Err(e)
        }
    }
}
