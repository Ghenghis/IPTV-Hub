//! Background poller.
//!
//! A long-lived `tokio` task that wakes on a configurable interval, dispatches each
//! enabled app to its appropriate `Source` implementation, and writes the result
//! into the database. Concurrency is bounded by a [`tokio::sync::Semaphore`]
//! (default 4 permits). Per-app failures are tracked and after three consecutive
//! errors the app is held in back-off for at least one hour. A force-poll channel
//! lets the UI's "Sync now" button bypass the interval (it still respects the
//! semaphore so the app does not stampede a slow source).
//!
//! The architecture follows `docs/UPDATE_FLOWS.md` §8 (concurrency rules) and
//! satisfies `docs/AGENT_PLAN.md` Agent 10 acceptance criteria.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::Utc;
use tokio::sync::{broadcast, mpsc, oneshot, RwLock, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::app_state::AppState;
use crate::errors::CoreError;
use crate::manifest::types::AppEntry;
use crate::sources::{dispatch, UpdateState};

/// Number of consecutive failures that trigger back-off.
const BACKOFF_THRESHOLD: u32 = 3;
/// Duration the app is held in back-off once the threshold is hit.
const BACKOFF_DURATION: Duration = Duration::from_secs(60 * 60); // 1 hour
/// Capacity of the per-app probe instrumentation channel.
const EVENTS_CHANNEL_CAPACITY: usize = 256;
/// Capacity of the force-poll request channel.
const FORCE_POLL_CHANNEL_CAPACITY: usize = 64;

/// Per-app run-time bookkeeping. Lives in the poller's shared state, keyed by app id.
#[derive(Debug, Clone, Default)]
struct BackoffState {
    /// Consecutive failures since the last success.
    consecutive_failures: u32,
    /// Earliest instant at which the next scheduled poll for this app may run.
    /// Force-polls bypass this — the user knows what they're doing when they click sync.
    next_poll_after: Option<Instant>,
}

/// Lifecycle event emitted by the poller for instrumentation. Integration tests
/// subscribe to these to observe concurrency; production wiring (Agent 22) maps
/// them onto Tauri events for the status bar.
#[derive(Debug, Clone)]
pub enum ProbeEvent {
    /// A per-app probe has acquired its semaphore permit and started running.
    Started { app_id: String },
    /// A per-app probe has completed (success or error).
    Finished {
        app_id: String,
        outcome: ProbeOutcome,
    },
}

#[derive(Debug, Clone)]
pub enum ProbeOutcome {
    UpToDate,
    UpdateAvailable,
    Error(String),
}

/// A single force-poll request. The `done` channel signals completion (or the
/// reason it could not run, e.g. unknown app id).
struct ForcePollRequest {
    app_id: String,
    done: oneshot::Sender<Result<(), CoreError>>,
}

/// Handle returned by [`Poller::spawn`]. Drops do not cancel — the caller is
/// expected to invoke [`shutdown`](Self::shutdown) for graceful termination.
pub struct PollerHandle {
    cancel: CancellationToken,
    join: JoinHandle<()>,
    force_poll_tx: mpsc::Sender<ForcePollRequest>,
    events_tx: broadcast::Sender<ProbeEvent>,
}

impl PollerHandle {
    /// Signal the loop to stop and wait for the background task to finish.
    pub async fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.join.await;
    }

    /// Request an immediate poll of `app_id`. The request bypasses the interval
    /// and any active back-off but still respects the concurrency semaphore.
    /// Returns when the probe has completed.
    pub async fn force_poll(&self, app_id: &str) -> Result<(), CoreError> {
        let (done_tx, done_rx) = oneshot::channel();
        let request = ForcePollRequest {
            app_id: app_id.to_string(),
            done: done_tx,
        };
        self.force_poll_tx
            .send(request)
            .await
            .map_err(|_| CoreError::internal("poller has shut down; cannot force-poll"))?;
        done_rx
            .await
            .map_err(|_| CoreError::internal("poller dropped force-poll response channel"))?
    }

    /// Subscribe to the probe-lifecycle event stream. Each subscriber receives
    /// every event emitted after subscription.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ProbeEvent> {
        self.events_tx.subscribe()
    }
}

/// The poller. Construct with [`Poller::new`], then call [`Poller::spawn`] to
/// start the background loop.
pub struct Poller {
    state: AppState,
}

impl Poller {
    pub const fn new(state: AppState) -> Self {
        Self { state }
    }

    /// Spawn the poller as a long-lived task and return the control handle.
    pub fn spawn(self) -> PollerHandle {
        let cancel = CancellationToken::new();
        let cancel_for_loop = cancel.clone();

        let (force_poll_tx, force_poll_rx) =
            mpsc::channel::<ForcePollRequest>(FORCE_POLL_CHANNEL_CAPACITY);
        let (events_tx, _) = broadcast::channel::<ProbeEvent>(EVENTS_CHANNEL_CAPACITY);
        let events_for_loop = events_tx.clone();

        let interval_minutes = u64::from(self.state.config.default_poll_interval_minutes);
        let interval = Duration::from_secs(interval_minutes.saturating_mul(60));
        let max_concurrency = self.state.config.poll_concurrency.max(1);
        let semaphore = Arc::new(Semaphore::new(max_concurrency));
        let backoff_states: Arc<RwLock<HashMap<String, BackoffState>>> = Arc::default();
        let state = self.state;

        let join = tokio::spawn(async move {
            tracing::info!(
                interval_secs = interval.as_secs(),
                concurrency = max_concurrency,
                "poller started"
            );
            run_loop(LoopParams {
                state,
                cancel: cancel_for_loop,
                force_poll_rx,
                events_tx: events_for_loop,
                interval,
                semaphore,
                backoff_states,
            })
            .await;
            tracing::info!("poller stopped");
        });

        PollerHandle {
            cancel,
            join,
            force_poll_tx,
            events_tx,
        }
    }
}

/// Inputs to the long-lived loop. Bundled so the function signature stays narrow.
struct LoopParams {
    state: AppState,
    cancel: CancellationToken,
    force_poll_rx: mpsc::Receiver<ForcePollRequest>,
    events_tx: broadcast::Sender<ProbeEvent>,
    interval: Duration,
    semaphore: Arc<Semaphore>,
    backoff_states: Arc<RwLock<HashMap<String, BackoffState>>>,
}

async fn run_loop(params: LoopParams) {
    let LoopParams {
        state,
        cancel,
        mut force_poll_rx,
        events_tx,
        interval,
        semaphore,
        backoff_states,
    } = params;

    loop {
        let wake = wake_duration(interval);
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            request = force_poll_rx.recv() => {
                if let Some(req) = request {
                    handle_force_poll(
                        &state,
                        &semaphore,
                        &events_tx,
                        &backoff_states,
                        &cancel,
                        req,
                    );
                } else {
                    // Channel closed — the handle was dropped without shutdown.
                    // Treat as shutdown to avoid a busy spin.
                    break;
                }
            }
            () = tokio::time::sleep(wake) => {
                run_scheduled_tick(
                    &state,
                    &semaphore,
                    &events_tx,
                    &backoff_states,
                    &cancel,
                );
            }
        }
    }
}

/// Compute the duration until the next scheduled tick. Adds a clock-derived
/// jitter of up to `default_poll_interval_minutes`'s share of jitter seconds so
/// many instances don't sync up on the same wall-clock minute.
fn wake_duration(base: Duration) -> Duration {
    // Pull jitter from the system clock so we don't need the `rand` crate.
    // Up to 30 seconds of jitter is plenty to avoid herd effects.
    let jitter_secs = clock_jitter_secs(30);
    base.saturating_add(Duration::from_secs(jitter_secs))
}

fn clock_jitter_secs(max: u64) -> u64 {
    if max == 0 {
        return 0;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    u64::from(nanos) % max
}

/// Iterate every enabled app from the manifest and spawn a probe for any whose
/// back-off has elapsed. Each spawned task acquires a semaphore permit before
/// running its actual probe.
fn run_scheduled_tick(
    state: &AppState,
    semaphore: &Arc<Semaphore>,
    events_tx: &broadcast::Sender<ProbeEvent>,
    backoff_states: &Arc<RwLock<HashMap<String, BackoffState>>>,
    cancel: &CancellationToken,
) {
    let apps: Vec<AppEntry> = {
        let manifest = state.manifest.read();
        manifest
            .apps
            .iter()
            .filter(|a| a.enabled)
            .filter(|a| polling_enabled(a))
            .cloned()
            .collect()
    };

    let now = Instant::now();
    for app in apps {
        let backoff = backoff_states.clone();
        let semaphore = semaphore.clone();
        let events_tx = events_tx.clone();
        let cancel = cancel.clone();
        let state = state.clone();
        let app_id = app.id.clone();
        tokio::spawn(async move {
            // Check back-off; scheduled polls obey it. Read into an owned `Option`
            // so the `RwLock` read guard is dropped before any further await — the
            // `clippy::significant_drop_in_scrutinee` lint forbids holding it
            // across the body of the `if let`.
            let next_poll_after: Option<Instant> = {
                let guard = backoff.read().await;
                guard.get(&app_id).and_then(|b| b.next_poll_after)
            };
            if let Some(next_poll_after) = next_poll_after {
                if now < next_poll_after {
                    tracing::debug!(app = %app_id, "skip: in back-off");
                    return;
                }
            }
            let _ = run_probe(&state, &semaphore, &events_tx, &backoff, &cancel, &app).await;
        });
    }
}

/// Handle a single force-poll request. Looks up the app, spawns a probe task,
/// and forwards the outcome on the `done` channel. Bypasses interval and
/// back-off; still respects the semaphore.
fn handle_force_poll(
    state: &AppState,
    semaphore: &Arc<Semaphore>,
    events_tx: &broadcast::Sender<ProbeEvent>,
    backoff_states: &Arc<RwLock<HashMap<String, BackoffState>>>,
    cancel: &CancellationToken,
    req: ForcePollRequest,
) {
    let app = {
        let manifest = state.manifest.read();
        manifest.apps.iter().find(|a| a.id == req.app_id).cloned()
    };

    let Some(app) = app else {
        let _ = req.done.send(Err(CoreError::config(format!(
            "force_poll: unknown app id '{}'",
            req.app_id
        ))));
        return;
    };

    let backoff = backoff_states.clone();
    let semaphore = semaphore.clone();
    let events_tx = events_tx.clone();
    let cancel = cancel.clone();
    let state = state.clone();
    tokio::spawn(async move {
        let result = run_probe(&state, &semaphore, &events_tx, &backoff, &cancel, &app).await;
        let _ = req.done.send(result);
    });
}

/// Acquire a semaphore permit and dispatch the source check. Updates the DB
/// and back-off tracker. Emits lifecycle events.
async fn run_probe(
    state: &AppState,
    semaphore: &Arc<Semaphore>,
    events_tx: &broadcast::Sender<ProbeEvent>,
    backoff_states: &Arc<RwLock<HashMap<String, BackoffState>>>,
    cancel: &CancellationToken,
    app: &AppEntry,
) -> Result<(), CoreError> {
    let permit = tokio::select! {
        () = cancel.cancelled() => return Err(CoreError::internal("cancelled")),
        permit = semaphore.clone().acquire_owned() => permit
            .map_err(|e| CoreError::internal(format!("semaphore closed: {e}")))?,
    };

    let _ = events_tx.send(ProbeEvent::Started {
        app_id: app.id.clone(),
    });

    let result = probe_app(state, app).await;

    let (outcome, probe_result): (ProbeOutcome, Result<(), CoreError>) = match &result {
        Ok(UpdateState::UpToDate { .. }) => (ProbeOutcome::UpToDate, Ok(())),
        Ok(UpdateState::UpdateAvailable { .. }) => (ProbeOutcome::UpdateAvailable, Ok(())),
        Ok(UpdateState::Error { message }) => (
            ProbeOutcome::Error(message.clone()),
            Err(CoreError::internal(message.clone())),
        ),
        Err(e) => (ProbeOutcome::Error(e.to_string()), Err(clone_error(e))),
    };

    update_backoff(backoff_states, &app.id, probe_result.is_ok()).await;

    let _ = events_tx.send(ProbeEvent::Finished {
        app_id: app.id.clone(),
        outcome,
    });

    drop(permit);
    probe_result
}

/// Re-create a `CoreError` value by stringifying — the type is not `Clone`.
fn clone_error(e: &CoreError) -> CoreError {
    CoreError::internal(e.to_string())
}

/// Execute the source check for a single app and persist the outcome.
async fn probe_app(state: &AppState, app: &AppEntry) -> Result<UpdateState, CoreError> {
    let source = dispatch(app.source_type);
    let result = source.check(app, &state.paths).await;

    let now = Utc::now().to_rfc3339();
    match &result {
        Ok(UpdateState::UpToDate { current }) => {
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
            .bind(&now)
            .bind(&now)
            .bind(&app.id)
            .execute(&state.db)
            .await;
            insert_activity(
                state,
                &app.id,
                "poll",
                "info",
                &format!("up-to-date · {current}"),
            )
            .await;
        }
        Ok(UpdateState::UpdateAvailable { from, to, summary }) => {
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
            .bind(&now)
            .bind(&now)
            .bind(&app.id)
            .execute(&state.db)
            .await;
            insert_activity(
                state,
                &app.id,
                "poll",
                "info",
                &format!("update available · {from} -> {to}"),
            )
            .await;
        }
        Ok(UpdateState::Error { message }) => {
            persist_failure(state, app, message, &now).await;
        }
        Err(e) => {
            let message = e.to_string();
            persist_failure(state, app, &message, &now).await;
        }
    }
    result
}

async fn persist_failure(state: &AppState, app: &AppEntry, message: &str, now: &str) {
    let backoff_until_value: Option<String> = compute_backoff_until_for_db(state, &app.id).await;
    let _ = sqlx::query(
        "UPDATE apps \
         SET status = ?, status_message = ?, last_poll_at = ?, last_failure_at = ?, \
             consecutive_failures = consecutive_failures + 1, \
             backoff_until = COALESCE(?, backoff_until), \
             updated_at = datetime('now') \
         WHERE id = ?",
    )
    .bind("error")
    .bind(message)
    .bind(now)
    .bind(now)
    .bind(backoff_until_value)
    .bind(&app.id)
    .execute(&state.db)
    .await;
    insert_activity(state, &app.id, "poll", "error", message).await;
}

/// Read the current DB `consecutive_failures` and, if this failure will put the
/// count at or above the threshold, compute a back-off timestamp the DB can
/// store. The in-memory back-off (separate from this) is updated by
/// [`update_backoff`]; the two must agree, so this helper mirrors the same
/// threshold.
async fn compute_backoff_until_for_db(state: &AppState, app_id: &str) -> Option<String> {
    let existing: Result<(i64,), sqlx::Error> =
        sqlx::query_as("SELECT consecutive_failures FROM apps WHERE id = ?")
            .bind(app_id)
            .fetch_one(&state.db)
            .await;
    let prior = existing.map(|(c,)| c).unwrap_or(0);
    let next_failure_count = prior.saturating_add(1);
    if next_failure_count >= i64::from(BACKOFF_THRESHOLD) {
        let when = Utc::now() + chrono::Duration::from_std(BACKOFF_DURATION).ok()?;
        Some(when.to_rfc3339())
    } else {
        None
    }
}

async fn insert_activity(state: &AppState, app_id: &str, action: &str, level: &str, message: &str) {
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

async fn update_backoff(
    backoff_states: &Arc<RwLock<HashMap<String, BackoffState>>>,
    app_id: &str,
    success: bool,
) {
    // Tightly scope the write guard so the lock is released as soon as the
    // mutation is done — `clippy::significant_drop_tightening` requires it.
    let mut guard = backoff_states.write().await;
    let entry = guard.entry(app_id.to_string()).or_default();
    if success {
        entry.consecutive_failures = 0;
        entry.next_poll_after = None;
    } else {
        entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
        if entry.consecutive_failures >= BACKOFF_THRESHOLD {
            entry.next_poll_after = Some(Instant::now() + BACKOFF_DURATION);
        }
    }
    drop(guard);
}

fn polling_enabled(app: &AppEntry) -> bool {
    app.polling.as_ref().is_none_or(|p| p.enabled)
}
