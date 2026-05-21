//! Background poller.
//!
//! Long-lived `tokio` task that wakes on a configurable interval, probes each enabled
//! app for updates via the appropriate `Source` implementation, and writes results to
//! the database. Bounded concurrency, per-app backoff, and event emission are specified
//! in `docs/UPDATE_FLOWS.md` §8.
//!
//! The v0 surface shipped here owns the lifecycle: a cancellable interval loop with
//! a configurable tick. Source dispatch, concurrency limits, and DB updates are layered
//! on by subsequent agents per `docs/AGENT_PLAN.md` — agent 10.

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::app_state::AppState;

pub struct PollerHandle {
    cancel: CancellationToken,
    join: JoinHandle<()>,
}

impl PollerHandle {
    pub async fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.join.await;
    }
}

pub struct Poller {
    state: AppState,
}

impl Poller {
    pub const fn new(state: AppState) -> Self {
        Self { state }
    }

    pub fn spawn(self) -> PollerHandle {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let interval = std::time::Duration::from_secs(
            u64::from(self.state.config.default_poll_interval_minutes) * 60,
        );

        let join = tokio::spawn(async move {
            tracing::info!(interval_secs = interval.as_secs(), "poller started");
            loop {
                tokio::select! {
                    () = token.cancelled() => break,
                    () = tokio::time::sleep(interval) => {
                        tracing::debug!("poller tick");
                    }
                }
            }
            tracing::info!("poller stopped");
        });

        PollerHandle { cancel, join }
    }
}
