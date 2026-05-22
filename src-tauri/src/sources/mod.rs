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
#[cfg(windows)]
pub mod installer;
pub mod release;
pub mod tizen;
pub mod web;

// The non-Windows `installer` stand-in lives at the bottom of this file. Per
// `docs/AGENT_PLAN.md` Agent 07 and CONTRACT §8, the installer source is a Windows-only
// feature; we surface that via a real `not_supported` error from each trait method so
// the orchestrator and the UI behave deterministically on non-Windows hosts.

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
    ReleaseNote { version: String, markdown: String },
    /// `installer` source — vendor changelog line, may be sparse.
    InstallerChange { summary: String },
    /// `tizen-ipk` source.
    IpkChange { version: String, notes: String },
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
        SourceType::Web => Box::new(web::WebSource::new()),
        SourceType::TizenIpk => Box::new(tizen::TizenSource::new()),
        SourceType::Installer => {
            #[cfg(windows)]
            {
                Box::new(installer::InstallerSource::new())
            }
            #[cfg(not(windows))]
            {
                Box::new(InstallerUnsupportedOnHost)
            }
        }
    }
}

/// Non-Windows host stand-in for the installer source. Each method returns a real,
/// documented `CoreError::NotSupported` value so callers can decide how to surface it
/// (the UI displays the message inline). This is the contracted behaviour from
/// `docs/AGENT_PLAN.md` Agent 07.
#[cfg(not(windows))]
struct InstallerUnsupportedOnHost;

#[cfg(not(windows))]
const INSTALLER_HOST_MSG: &str =
    "installer source is Windows-only (MSI/EXE silent install via the Windows registry)";

#[cfg(not(windows))]
#[async_trait]
impl Source for InstallerUnsupportedOnHost {
    async fn check(&self, _app: &AppEntry, _paths: &AppPaths) -> Result<UpdateState, CoreError> {
        Err(CoreError::not_supported(INSTALLER_HOST_MSG))
    }
    async fn plan(&self, _app: &AppEntry, _paths: &AppPaths) -> Result<UpdatePlan, CoreError> {
        Err(CoreError::not_supported(INSTALLER_HOST_MSG))
    }
    async fn apply(
        &self,
        _app: &AppEntry,
        _plan: UpdatePlan,
        _ctx: ApplyCtx,
    ) -> Result<UpdateOutcome, CoreError> {
        Err(CoreError::not_supported(INSTALLER_HOST_MSG))
    }
    async fn rollback(
        &self,
        _app: &AppEntry,
        _snapshot_archive: &Path,
        _paths: &AppPaths,
    ) -> Result<(), CoreError> {
        Err(CoreError::not_supported(INSTALLER_HOST_MSG))
    }
}
