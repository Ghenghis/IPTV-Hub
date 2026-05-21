//! Source trait — the boundary every update mechanism implements.
//!
//! Adding a new source type means: write one module that implements [`Source`], wire it
//! into [`Source::dispatch`], and ship integration tests against real fixtures (no mocks,
//! per CONTRACT.md §2.2).
//!
//! The trait is intentionally narrow. Higher-level concerns — snapshotting, rollback,
//! smoke-testing, persistence — live in dedicated modules and are orchestrated by the
//! command layer in `commands::updates`. Implementations of this trait focus on the
//! source-specific knowledge: how to detect updates, how to apply them, and how to
//! restore from a snapshot.

use std::path::Path;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, SourceType};
use crate::paths::AppPaths;

pub mod git;
pub mod release;
pub mod tizen;
pub mod web;
// Re-exports for the dispatch table below.
// Other source modules (installer) are owned by their respective
// agents and are added to the dispatch table when they land.

/// What the poller (or a manual `check`) learned about an app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateState {
    UpToDate {
        current: String,
    },
    UpdateAvailable {
        from: String,
        to: String,
        summary: String,
    },
    Error {
        message: String,
    },
}

/// Plan rendered in the UI's update modal. Frontend never invents text in this struct;
/// it just renders the shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePlan {
    pub app_id: String,
    pub source_type: SourceType,
    pub from_label: String,
    pub to_label: String,
    pub from_meta: Vec<KeyValue>,
    pub to_meta: Vec<KeyValue>,
    pub incoming: Vec<IncomingItem>,
    pub steps: Vec<PlanStep>,
    pub rollback_retention_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

/// One row in the "incoming commits" / "release notes" / "changelog" section of the modal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IncomingItem {
    /// `git`/`web` source.
    Commit {
        sha: String,
        message: String,
        author: String,
    },
    /// `release-binary` source — typically just one item containing the release notes.
    ReleaseNote {
        version: String,
        markdown: String,
    },
    /// `installer` source — vendor changelog line, may be sparse.
    InstallerChange {
        summary: String,
    },
    /// `tizen-ipk` source.
    IpkChange {
        version: String,
        notes: String,
    },
}

/// A single row in the "what will happen" section. Tags are rendered as pills in the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub title: String,
    pub detail: Option<String>,
    pub tag: PlanTag,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanTag {
    Safe,
    TimeEstimate, // amber "3–5 min" pill — accompanied by `detail` containing the estimate
    Risky,
}

/// Outcome of an apply step. The Source must not write to the DB; the orchestrator does that.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateOutcome {
    pub new_version: Option<String>,
    pub new_sha: Option<String>,
    pub bytes_downloaded: u64,
    pub elapsed_ms: u64,
    pub messages: Vec<String>,
}

/// Context passed to `apply` so sources can report progress and check for cancellation.
#[derive(Debug, Clone)]
pub struct ApplyCtx {
    pub paths: AppPaths,
    pub progress: tokio::sync::mpsc::Sender<ProgressEvent>,
    pub cancel: tokio_util::sync::CancellationToken,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub app_id: String,
    pub step: String,
    pub message: String,
    pub bytes_done: Option<u64>,
    pub bytes_total: Option<u64>,
}

#[async_trait]
pub trait Source: Send + Sync {
    async fn check(&self, app: &AppEntry, paths: &AppPaths) -> Result<UpdateState, CoreError>;
    async fn plan(&self, app: &AppEntry, paths: &AppPaths) -> Result<UpdatePlan, CoreError>;
    async fn apply(
        &self,
        app: &AppEntry,
        plan: UpdatePlan,
        ctx: ApplyCtx,
    ) -> Result<UpdateOutcome, CoreError>;
    async fn rollback(
        &self,
        app: &AppEntry,
        snapshot_archive: &Path,
        paths: &AppPaths,
    ) -> Result<(), CoreError>;
}

/// Dispatch table — given a manifest entry, return the right boxed source.
///
/// New source types are added here. The match is non-exhaustive in spirit: when an
/// agent lands a new source module they extend this function. The function is
/// `#[must_use]` because forgetting to register a new source type would silently
/// make affected apps inert.
#[must_use]
pub fn dispatch(source_type: SourceType) -> Box<dyn Source> {
    match source_type {
        SourceType::Git => Box::new(git::GitSource::new()),
        SourceType::ReleaseBinary => Box::new(release::ReleaseSource::new()),
        // The following land via their respective agent slices (07, 08, 09):
        SourceType::Installer => unreachable!(
            "Agent 07 (sources::installer) lands the installer source."
        ),
        SourceType::Web => Box::new(web::WebSource::new()),
        SourceType::TizenIpk => Box::new(tizen::TizenSource::new()),
    }
}
