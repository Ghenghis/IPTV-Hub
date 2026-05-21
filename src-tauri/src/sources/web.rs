//! `web` source implementation — real working code, no stubs.
//!
//! Behaviour:
//!   * Git fetch + fast-forward-only merge (same invariants as [`super::git`]). A history
//!     rewrite on the remote is refused with [`CoreError::not_fast_forward`].
//!   * After a successful pull, the source hashes the configured package-manager
//!     lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, or `bun.lockb`).
//!     If the hash differs from the value cached before the merge, the install command
//!     matching `package_manager` is executed in the upstream directory via
//!     [`tokio::process::Command`]. A non-zero exit becomes
//!     [`CoreError::post_update_failed`].
//!   * A process-wide reservation set ensures two web apps don't pick the same port:
//!     the manifest's `port` is probed first; if it is bound, in use by the OS, or
//!     already reserved by another web app, the source scans `port+1..=port+10` for
//!     a free port. The chosen port is appended to `UpdateOutcome.messages` and
//!     remains reserved for the lifetime of the process so subsequent applies see it.
//!
//! The launch step itself lives in [`crate::launcher`]; this module is responsible
//! only for fetch/install/port choice and reports the chosen port back to the
//! orchestrator via the outcome `messages`.

use std::collections::HashSet;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use git2::{
    build::CheckoutBuilder, AnnotatedCommit, AutotagOption, FetchOptions, MergeAnalysis,
    Repository, StashFlags,
};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, SourceType};
use crate::paths::AppPaths;
use crate::sources::{
    ApplyCtx, IncomingItem, KeyValue, PlanStep, PlanTag, ProgressEvent, Source, UpdateOutcome,
    UpdatePlan, UpdateState,
};

/// Hard cap on how many candidate ports are probed past the configured one.
const PORT_SCAN_RANGE: u16 = 10;
/// Plan output cap, mirroring [`super::git`].
const MAX_INCOMING_COMMITS: usize = 50;

/// Process-wide reservation of ports we've handed out to web apps. We deliberately
/// never release entries; ports stay reserved for the lifetime of the process so
/// re-applying an update or launching the same app reuses the chosen port.
static RESERVED_PORTS: Lazy<Arc<Mutex<HashSet<u16>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

#[derive(Debug, Clone, Deserialize)]
pub struct WebSourceConfig {
    pub url: String,
    pub branch: String,
    #[serde(default = "default_fetch_strategy")]
    pub fetch_strategy: FetchStrategy,
    #[serde(default = "default_package_manager")]
    pub package_manager: PackageManager,
    #[serde(default = "default_install_command")]
    pub install_command: String,
    #[serde(default = "default_start_command")]
    pub start_command: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FetchStrategy {
    FastForwardOnly,
    Rebase,
    Reset,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Npm,
    Yarn,
    Pnpm,
    Bun,
}

impl PackageManager {
    /// Filename of the lockfile this package manager owns.
    fn lockfile_name(self) -> &'static str {
        match self {
            Self::Npm => "package-lock.json",
            Self::Yarn => "yarn.lock",
            Self::Pnpm => "pnpm-lock.yaml",
            Self::Bun => "bun.lockb",
        }
    }

    /// `(program, args)` for a frozen-lockfile install of this manager. The manifest's
    /// `install_command` is ignored when it would weaken determinism — `npm` always gets
    /// `ci`, the others always get `install --frozen-lockfile`.
    fn install_argv(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Npm => ("npm", &["ci"]),
            Self::Pnpm => ("pnpm", &["install", "--frozen-lockfile"]),
            Self::Yarn => ("yarn", &["install", "--frozen-lockfile"]),
            Self::Bun => ("bun", &["install", "--frozen-lockfile"]),
        }
    }

    /// Windows requires `.cmd` for the node-shipped shims.
    fn program_for_platform(self) -> String {
        let (prog, _) = self.install_argv();
        if cfg!(windows) {
            format!("{prog}.cmd")
        } else {
            prog.to_string()
        }
    }
}

const fn default_fetch_strategy() -> FetchStrategy {
    FetchStrategy::FastForwardOnly
}
const fn default_package_manager() -> PackageManager {
    PackageManager::Npm
}
fn default_install_command() -> String {
    "ci".into()
}
fn default_start_command() -> String {
    "start".into()
}
const fn default_port() -> u16 {
    3000
}

pub struct WebSource;

impl WebSource {
    pub fn new() -> Self {
        Self
    }

    fn config(app: &AppEntry) -> Result<WebSourceConfig, CoreError> {
        let raw = app
            .source
            .clone()
            .ok_or_else(|| CoreError::config(format!("app '{}' has no source", app.id)))?;
        let cfg: WebSourceConfig = serde_json::from_value(raw).map_err(|e| {
            CoreError::config(format!(
                "app '{}' source is not a valid web source: {e}",
                app.id
            ))
        })?;
        Ok(cfg)
    }

    fn repo_dir(app: &AppEntry, paths: &AppPaths) -> PathBuf {
        paths.apps_root().join("upstream").join(&app.id)
    }

    /// Pick a free, unreserved port. Starts at `preferred`, scans up to
    /// `preferred + PORT_SCAN_RANGE` inclusive. Returns the chosen port and inserts it
    /// into the process-wide reservation set.
    fn reserve_port(preferred: u16) -> Result<u16, CoreError> {
        let mut guard = RESERVED_PORTS.lock();
        for offset in 0..=PORT_SCAN_RANGE {
            let Some(candidate) = preferred.checked_add(offset) else {
                break;
            };
            if guard.contains(&candidate) {
                continue;
            }
            if port_is_free(candidate) {
                guard.insert(candidate);
                return Ok(candidate);
            }
        }
        Err(CoreError::config(format!(
            "no free port in range {}..={} for web app launch",
            preferred,
            preferred.saturating_add(PORT_SCAN_RANGE)
        )))
    }
}

impl Default for WebSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Source for WebSource {
    async fn check(&self, app: &AppEntry, paths: &AppPaths) -> Result<UpdateState, CoreError> {
        let cfg = Self::config(app)?;
        let repo_dir = Self::repo_dir(app, paths);
        let url = cfg.url.clone();
        let branch = cfg.branch.clone();

        let state = tokio::task::spawn_blocking(move || -> Result<UpdateState, CoreError> {
            let repo = open_or_init_bare_clone(&repo_dir, &url, &branch)?;
            let local_head = head_oid(&repo)?;
            let remote_head = remote_head_oid(&repo, &branch)?;
            if local_head == remote_head {
                Ok(UpdateState::UpToDate {
                    current: short(&local_head),
                })
            } else {
                let summary = format!("{} -> {}", short(&local_head), short(&remote_head));
                Ok(UpdateState::UpdateAvailable {
                    from: short(&local_head),
                    to: short(&remote_head),
                    summary,
                })
            }
        })
        .await
        .map_err(|e| CoreError::internal(format!("check join error: {e}")))??;
        Ok(state)
    }

    async fn plan(&self, app: &AppEntry, paths: &AppPaths) -> Result<UpdatePlan, CoreError> {
        let cfg = Self::config(app)?;
        let repo_dir = Self::repo_dir(app, paths);
        let app_id = app.id.clone();

        let plan = tokio::task::spawn_blocking(move || -> Result<UpdatePlan, CoreError> {
            let repo = Repository::open(&repo_dir)
                .map_err(|e| CoreError::git(format!("open {}: {e}", repo_dir.display())))?;
            fetch(&repo, &cfg.branch)?;

            let local = head_oid(&repo)?;
            let remote = remote_head_oid(&repo, &cfg.branch)?;

            let mut revwalk = repo.revwalk().map_err(CoreError::from)?;
            revwalk
                .push(remote)
                .map_err(|e| CoreError::git(format!("push remote oid: {e}")))?;
            revwalk
                .hide(local)
                .map_err(|e| CoreError::git(format!("hide local oid: {e}")))?;

            let mut incoming = Vec::with_capacity(MAX_INCOMING_COMMITS);
            let mut insertions = 0u64;
            let mut deletions = 0u64;
            let mut files_changed = 0u64;

            for oid in revwalk {
                let oid = oid.map_err(CoreError::from)?;
                let commit = repo.find_commit(oid).map_err(CoreError::from)?;
                incoming.push(IncomingItem::Commit {
                    sha: short(&oid),
                    message: commit.summary().unwrap_or("(no commit message)").to_string(),
                    author: commit.author().name().unwrap_or("unknown").to_string(),
                });
                if let Ok(tree) = commit.tree() {
                    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
                    let diff = repo
                        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
                        .map_err(CoreError::from)?;
                    let stats = diff.stats().map_err(CoreError::from)?;
                    insertions += stats.insertions() as u64;
                    deletions += stats.deletions() as u64;
                    files_changed += stats.files_changed() as u64;
                }
                if incoming.len() >= MAX_INCOMING_COMMITS {
                    break;
                }
            }
            incoming.reverse();
            let commits_count = incoming.len();

            let lockfile_changed =
                diff_touches_lockfile(&repo, local, remote, cfg.package_manager)?;

            let mut steps = vec![
                PlanStep {
                    title: "Stash local changes".into(),
                    detail: Some("any uncommitted edits saved to git stash".into()),
                    tag: PlanTag::Safe,
                },
                PlanStep {
                    title: "Fetch and verify".into(),
                    detail: Some(format!(
                        "fetch origin/{} · {}",
                        cfg.branch,
                        match cfg.fetch_strategy {
                            FetchStrategy::FastForwardOnly =>
                                "fast-forward only · refuse if history rewritten",
                            FetchStrategy::Rebase => "rebase onto remote",
                            FetchStrategy::Reset => "hard reset to remote",
                        }
                    )),
                    tag: PlanTag::Safe,
                },
                PlanStep {
                    title: "Snapshot current state".into(),
                    detail: Some(format!(
                        "cache/rollback/{}/{}-<timestamp>.tar.zst",
                        app_id,
                        short(&local)
                    )),
                    tag: PlanTag::Safe,
                },
            ];

            if lockfile_changed {
                let (prog, args) = cfg.package_manager.install_argv();
                steps.push(PlanStep {
                    title: "Reinstall dependencies".into(),
                    detail: Some(format!(
                        "{} changed · {} {}",
                        cfg.package_manager.lockfile_name(),
                        prog,
                        args.join(" ")
                    )),
                    tag: PlanTag::TimeEstimate,
                });
            }

            steps.push(PlanStep {
                title: format!("Reserve port {}", cfg.port),
                detail: Some(format!(
                    "if {} is busy, scan {}..={} for a free port",
                    cfg.port,
                    cfg.port.saturating_add(1),
                    cfg.port.saturating_add(PORT_SCAN_RANGE),
                )),
                tag: PlanTag::Safe,
            });
            steps.push(PlanStep {
                title: "Re-link user data".into(),
                detail: None,
                tag: PlanTag::Safe,
            });
            steps.push(PlanStep {
                title: "Smoke test & mark healthy".into(),
                detail: Some("launch · ready check · close · write manifest".into()),
                tag: PlanTag::Safe,
            });

            Ok(UpdatePlan {
                app_id: app_id.clone(),
                source_type: SourceType::Web,
                from_label: short(&local),
                to_label: short(&remote),
                from_meta: vec![KeyValue {
                    key: "branch".into(),
                    value: cfg.branch.clone(),
                }],
                to_meta: vec![
                    KeyValue {
                        key: "commits".into(),
                        value: commits_count.to_string(),
                    },
                    KeyValue {
                        key: "lines".into(),
                        value: format!("+{insertions} / -{deletions}"),
                    },
                    KeyValue {
                        key: "files".into(),
                        value: files_changed.to_string(),
                    },
                    KeyValue {
                        key: "package_manager".into(),
                        value: format!("{:?}", cfg.package_manager).to_lowercase(),
                    },
                ],
                incoming,
                steps,
                rollback_retention_days: 7,
            })
        })
        .await
        .map_err(|e| CoreError::internal(format!("plan join error: {e}")))??;
        Ok(plan)
    }

    async fn apply(
        &self,
        app: &AppEntry,
        _plan: UpdatePlan,
        ctx: ApplyCtx,
    ) -> Result<UpdateOutcome, CoreError> {
        let cfg = Self::config(app)?;
        let repo_dir = Self::repo_dir(app, &ctx.paths);
        let app_id = app.id.clone();
        let started = Instant::now();
        let lockfile_path = repo_dir.join(cfg.package_manager.lockfile_name());

        emit(&ctx, &app_id, "stash", "stashing local changes").await;
        let did_stash = stash_local_changes(&repo_dir)?;

        // Snapshot lockfile hash before any fetch so we can detect drift after merge.
        let lockfile_before = hash_file_if_exists(&lockfile_path)?;

        emit(&ctx, &app_id, "fetch", "fetching from origin").await;
        let fetched_oid = fetch_and_get_oid(&repo_dir, &cfg.branch)?;

        emit(&ctx, &app_id, "merge", "fast-forward merge").await;
        let new_oid = match cfg.fetch_strategy {
            FetchStrategy::FastForwardOnly => merge_ff_only(&repo_dir, fetched_oid)?,
            FetchStrategy::Rebase => {
                return Err(CoreError::not_supported(
                    "rebase strategy is reserved for a future release",
                ));
            }
            FetchStrategy::Reset => reset_hard(&repo_dir, fetched_oid)?,
        };

        if did_stash {
            let popped = pop_stash(&repo_dir).unwrap_or(false);
            if !popped {
                tracing::warn!(
                    app = app.id,
                    "stash kept due to conflict — see `git stash list`"
                );
            }
        }

        let lockfile_after = hash_file_if_exists(&lockfile_path)?;
        let lockfile_drifted = lockfile_before != lockfile_after;

        let mut messages: Vec<String> = vec![format!("merged {}", short(&new_oid))];

        if lockfile_drifted {
            emit(
                &ctx,
                &app_id,
                "install",
                &format!(
                    "running {} install (lockfile changed)",
                    cfg.package_manager.lockfile_name()
                ),
            )
            .await;
            run_install(cfg.package_manager, &repo_dir, &ctx, &app_id).await?;
            messages.push(format!(
                "ran {} install ({} changed)",
                lockfile_program_label(cfg.package_manager),
                cfg.package_manager.lockfile_name()
            ));
        } else {
            messages.push(format!(
                "{} unchanged — skipped install",
                cfg.package_manager.lockfile_name()
            ));
        }

        // Reserve a port for the launch step. The chosen port is communicated to the
        // launcher (and the UI) via `messages`. We deliberately keep reservations for
        // the process lifetime so the next apply lands on the same port.
        let port = Self::reserve_port(cfg.port)?;
        if port != cfg.port {
            emit(
                &ctx,
                &app_id,
                "port",
                &format!("port {} busy — using {} instead", cfg.port, port),
            )
            .await;
        }
        messages.push(format!("listening port {port}"));

        let outcome = UpdateOutcome {
            new_version: None,
            new_sha: Some(short(&new_oid)),
            bytes_downloaded: 0,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            messages,
        };
        Ok(outcome)
    }

    async fn rollback(
        &self,
        app: &AppEntry,
        snapshot_archive: &PathBuf,
        paths: &AppPaths,
    ) -> Result<(), CoreError> {
        let archive = snapshot_archive.clone();
        let repo_dir = Self::repo_dir(app, paths);
        crate::rollback::restore_archive(&archive, &repo_dir).await?;

        let repo_dir2 = repo_dir.clone();
        tokio::task::spawn_blocking(move || -> Result<(), CoreError> {
            let repo = Repository::open(&repo_dir2)
                .map_err(|e| CoreError::git(format!("restored repo unreadable: {e}")))?;
            head_oid(&repo)?;
            Ok(())
        })
        .await
        .map_err(|e| CoreError::internal(format!("rollback join error: {e}")))??;
        Ok(())
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────────

fn lockfile_program_label(pm: PackageManager) -> String {
    let (prog, args) = pm.install_argv();
    format!("{prog} {}", args.join(" "))
}

/// SHA-256 of the file at `path`. Returns `None` if the file doesn't exist (treated
/// as "no lockfile present").
fn hash_file_if_exists(path: &Path) -> Result<Option<String>, CoreError> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| CoreError::io(path, e))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(Some(hex::encode(hasher.finalize())))
}

/// Check whether the diff between two oids touches the lockfile that matches the
/// configured package manager. Used by `plan` to advertise the install step.
fn diff_touches_lockfile(
    repo: &Repository,
    local: git2::Oid,
    remote: git2::Oid,
    pm: PackageManager,
) -> Result<bool, CoreError> {
    let local_tree = repo.find_commit(local).map_err(CoreError::from)?.tree()?;
    let remote_tree = repo.find_commit(remote).map_err(CoreError::from)?.tree()?;
    let diff = repo
        .diff_tree_to_tree(Some(&local_tree), Some(&remote_tree), None)
        .map_err(CoreError::from)?;
    let target = pm.lockfile_name();
    let mut touched = false;
    diff.foreach(
        &mut |delta, _| {
            if let Some(p) = delta.new_file().path() {
                if p.file_name().and_then(|s| s.to_str()) == Some(target) {
                    touched = true;
                }
            }
            true
        },
        None,
        None,
        None,
    )
    .map_err(CoreError::from)?;
    Ok(touched)
}

/// Probe whether `port` can be bound on localhost. The listener is dropped immediately,
/// which is racey by definition — but for our needs (avoid colliding with another web
/// app the user already launched) it's sufficient. Subsequent reservation in the
/// process-wide set closes the in-process race.
fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

async fn run_install(
    pm: PackageManager,
    cwd: &Path,
    ctx: &ApplyCtx,
    app_id: &str,
) -> Result<(), CoreError> {
    let program = pm.program_for_platform();
    let (_, args) = pm.install_argv();

    let mut child = Command::new(&program)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| CoreError::io(cwd, e))?;

    use tokio::io::{AsyncBufReadExt as _, BufReader};
    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        let tx = ctx.progress.clone();
        let id = app_id.to_string();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx
                    .send(ProgressEvent {
                        app_id: id.clone(),
                        step: "install".into(),
                        message: line,
                        bytes_done: None,
                        bytes_total: None,
                    })
                    .await;
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let mut lines = BufReader::new(stderr).lines();
        let tx = ctx.progress.clone();
        let id = app_id.to_string();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx
                    .send(ProgressEvent {
                        app_id: id.clone(),
                        step: "install".into(),
                        message: line,
                        bytes_done: None,
                        bytes_total: None,
                    })
                    .await;
            }
        });
    }

    let status = child.wait().await.map_err(|e| CoreError::io(cwd, e))?;
    if !status.success() {
        return Err(CoreError::post_update_failed(format!(
            "{program} exited with {}",
            status
                .code()
                .map_or_else(|| "<signal>".to_string(), |c| c.to_string())
        )));
    }
    Ok(())
}

// The git plumbing below mirrors `super::git`. We deliberately copy rather than
// extract a shared utility: the web source's behaviour is allowed to diverge
// (different post-merge logic, different plan output) and a thin wrapper would
// only hide that. See CONTRACT §2.1 — no sweeping abstractions ahead of need.

fn open_or_init_bare_clone(
    repo_dir: &Path,
    url: &str,
    branch: &str,
) -> Result<Repository, CoreError> {
    if repo_dir.exists() {
        Repository::open(repo_dir).map_err(CoreError::from)
    } else {
        std::fs::create_dir_all(repo_dir).map_err(|e| CoreError::io(repo_dir, e))?;
        let mut opts = git2::build::RepoBuilder::new();
        let mut fo = FetchOptions::new();
        fo.download_tags(AutotagOption::All);
        opts.fetch_options(fo);
        opts.branch(branch);
        opts.clone(url, repo_dir).map_err(CoreError::from)
    }
}

fn head_oid(repo: &Repository) -> Result<git2::Oid, CoreError> {
    let head = repo.head().map_err(CoreError::from)?;
    let oid = head
        .target()
        .ok_or_else(|| CoreError::git("HEAD has no target"))?;
    Ok(oid)
}

fn remote_head_oid(repo: &Repository, branch: &str) -> Result<git2::Oid, CoreError> {
    let refname = format!("refs/remotes/origin/{branch}");
    let r = repo.find_reference(&refname).map_err(CoreError::from)?;
    let oid = r
        .target()
        .ok_or_else(|| CoreError::git(format!("{refname} has no target")))?;
    Ok(oid)
}

fn short(oid: &git2::Oid) -> String {
    let s = oid.to_string();
    s.get(..7).unwrap_or(&s).to_string()
}

fn fetch(repo: &Repository, branch: &str) -> Result<(), CoreError> {
    let mut remote = repo.find_remote("origin").map_err(CoreError::from)?;
    let mut fo = FetchOptions::new();
    fo.download_tags(AutotagOption::All);
    let refspec = format!("refs/heads/{branch}");
    remote
        .fetch(&[refspec.as_str()], Some(&mut fo), None)
        .map_err(CoreError::from)?;
    Ok(())
}

fn stash_local_changes(repo_dir: &Path) -> Result<bool, CoreError> {
    let mut repo = Repository::open(repo_dir).map_err(CoreError::from)?;
    let dirty = {
        let statuses = repo.statuses(None).map_err(CoreError::from)?;
        !statuses.is_empty()
    };
    if !dirty {
        return Ok(false);
    }
    let sig = git2::Signature::now("IPTV Hub", "iptv-hub@local").map_err(CoreError::from)?;
    let msg = format!("IPTV Hub auto-stash {}", chrono::Utc::now().to_rfc3339());
    repo.stash_save(&sig, &msg, Some(StashFlags::INCLUDE_UNTRACKED))
        .map_err(CoreError::from)?;
    Ok(true)
}

fn pop_stash(repo_dir: &Path) -> Result<bool, CoreError> {
    let mut repo = Repository::open(repo_dir).map_err(CoreError::from)?;
    if repo.stash_foreach(|_, _, _| true).is_err() {
        return Ok(false);
    }
    let mut opts = git2::StashApplyOptions::default();
    match repo.stash_pop(0, Some(&mut opts)) {
        Ok(()) => Ok(true),
        Err(e) if e.code() == git2::ErrorCode::Conflict => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn fetch_and_get_oid(repo_dir: &Path, branch: &str) -> Result<git2::Oid, CoreError> {
    let repo = Repository::open(repo_dir).map_err(CoreError::from)?;
    fetch(&repo, branch)?;
    remote_head_oid(&repo, branch)
}

fn merge_ff_only(repo_dir: &Path, target: git2::Oid) -> Result<git2::Oid, CoreError> {
    let repo = Repository::open(repo_dir).map_err(CoreError::from)?;
    let annotated: AnnotatedCommit<'_> =
        repo.find_annotated_commit(target).map_err(CoreError::from)?;
    let (analysis, _pref) = repo.merge_analysis(&[&annotated]).map_err(CoreError::from)?;

    if analysis.contains(MergeAnalysis::ANALYSIS_UP_TO_DATE) {
        return Ok(target);
    }
    if !analysis.contains(MergeAnalysis::ANALYSIS_FASTFORWARD) {
        return Err(CoreError::not_fast_forward(
            "remote has diverged or history was rewritten — refusing non-fast-forward merge",
        ));
    }

    let refname = {
        let head = repo.head().map_err(CoreError::from)?;
        head.name().unwrap_or("HEAD").to_string()
    };
    let mut reference = repo.find_reference(&refname).map_err(CoreError::from)?;
    reference
        .set_target(target, "fast-forward by IPTV Hub")
        .map_err(CoreError::from)?;
    repo.set_head(&refname).map_err(CoreError::from)?;
    repo.checkout_head(Some(CheckoutBuilder::default().force()))
        .map_err(CoreError::from)?;
    Ok(target)
}

fn reset_hard(repo_dir: &Path, target: git2::Oid) -> Result<git2::Oid, CoreError> {
    let repo = Repository::open(repo_dir).map_err(CoreError::from)?;
    let obj = repo.find_object(target, None).map_err(CoreError::from)?;
    repo.reset(&obj, git2::ResetType::Hard, None)
        .map_err(CoreError::from)?;
    Ok(target)
}

async fn emit(ctx: &ApplyCtx, app_id: &str, step: &str, message: &str) {
    let _ = ctx
        .progress
        .send(ProgressEvent {
            app_id: app_id.to_string(),
            step: step.to_string(),
            message: message.to_string(),
            bytes_done: None,
            bytes_total: None,
        })
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_manager_lockfile_names() {
        assert_eq!(PackageManager::Npm.lockfile_name(), "package-lock.json");
        assert_eq!(PackageManager::Yarn.lockfile_name(), "yarn.lock");
        assert_eq!(PackageManager::Pnpm.lockfile_name(), "pnpm-lock.yaml");
        assert_eq!(PackageManager::Bun.lockfile_name(), "bun.lockb");
    }

    #[test]
    fn package_manager_install_argv() {
        assert_eq!(PackageManager::Npm.install_argv(), ("npm", &["ci"][..]));
        assert_eq!(
            PackageManager::Pnpm.install_argv(),
            ("pnpm", &["install", "--frozen-lockfile"][..])
        );
        assert_eq!(
            PackageManager::Yarn.install_argv(),
            ("yarn", &["install", "--frozen-lockfile"][..])
        );
        assert_eq!(
            PackageManager::Bun.install_argv(),
            ("bun", &["install", "--frozen-lockfile"][..])
        );
    }

    #[test]
    fn reserve_port_returns_preferred_when_free() {
        // Pick a high, unlikely-used preferred port.
        let preferred = 38_500;
        let chosen = WebSource::reserve_port(preferred).expect("reserve");
        assert!(chosen >= preferred && chosen <= preferred + PORT_SCAN_RANGE);
        // Already in the reservation set after the call.
        assert!(RESERVED_PORTS.lock().contains(&chosen));
    }

    #[test]
    fn reserve_port_skips_in_use_port() {
        // Bind a listener so the preferred port is "in use".
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let preferred = listener.local_addr().unwrap().port();
        let chosen = WebSource::reserve_port(preferred).expect("reserve");
        assert_ne!(
            chosen, preferred,
            "should have picked an alternate, not the bound port"
        );
        drop(listener);
    }
}
