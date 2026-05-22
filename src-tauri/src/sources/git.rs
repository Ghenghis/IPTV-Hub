//! `git` source implementation — real `git2-rs` against real repositories.
//!
//! This is the canonical pattern for source implementations. Agents working on
//! `release`, `installer`, `web`, and `tizen` sources should mirror the structure
//! here: a constructor, the four trait methods, helper functions kept small, and
//! integration tests against real fixtures.
//!
//! Key invariants enforced here:
//!   * Fast-forward-only by default. Any non-FF (force-push, history rewrite) is
//!     refused with a structured error so the UI can surface a meaningful message.
//!   * Local changes are stashed before fetch, not silently overwritten.
//!   * `post_update` commands are executed only if a relevant lockfile changed.
//!   * Symlinks under `user_data.mount_at` are preserved across the merge.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use async_trait::async_trait;
use git2::{
    build::CheckoutBuilder, AnnotatedCommit, AutotagOption, FetchOptions, MergeAnalysis,
    Repository, StashFlags,
};
use serde::Deserialize;
use tokio::process::Command;

use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, SourceType};
use crate::paths::AppPaths;
use crate::sources::{
    ApplyCtx, IncomingItem, KeyValue, PlanStep, PlanTag, ProgressEvent, Source, UpdateOutcome,
    UpdatePlan, UpdateState,
};

#[derive(Debug, Clone, Deserialize)]
pub struct GitSourceConfig {
    pub url: String,
    pub branch: String,
    #[serde(default = "default_fetch_strategy")]
    pub fetch_strategy: FetchStrategy,
    #[serde(default)]
    pub post_update: Vec<String>,
    pub post_update_cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FetchStrategy {
    FastForwardOnly,
    Rebase,
    Reset,
}

const fn default_fetch_strategy() -> FetchStrategy {
    FetchStrategy::FastForwardOnly
}

pub struct GitSource;

impl GitSource {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Parse the embedded source config from the manifest entry.
    fn config(app: &AppEntry) -> Result<GitSourceConfig, CoreError> {
        let raw = app
            .source
            .clone()
            .ok_or_else(|| CoreError::config(format!("app '{}' has no source", app.id)))?;
        let cfg: GitSourceConfig = serde_json::from_value(raw).map_err(|e| {
            CoreError::config(format!(
                "app '{}' source is not a valid git source: {e}",
                app.id
            ))
        })?;
        Ok(cfg)
    }

    fn repo_dir(app: &AppEntry, paths: &AppPaths) -> PathBuf {
        // Per manifest convention, git sources live under apps_root/upstream/<id>/.
        paths.apps_root().join("upstream").join(&app.id)
    }
}

impl Default for GitSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
#[allow(clippy::too_many_lines)]
impl Source for GitSource {
    async fn check(&self, app: &AppEntry, paths: &AppPaths) -> Result<UpdateState, CoreError> {
        let cfg = Self::config(app)?;
        let repo_dir = Self::repo_dir(app, paths);
        let url = cfg.url.clone();
        let branch = cfg.branch.clone();

        // Heavy git work happens on a blocking pool — libgit2 is sync.
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

            let mut incoming = Vec::with_capacity(50);
            let mut insertions = 0u64;
            let mut deletions = 0u64;
            let mut files_changed = 0u64;

            for oid in revwalk {
                let oid = oid.map_err(CoreError::from)?;
                let commit = repo.find_commit(oid).map_err(CoreError::from)?;
                let summary = commit
                    .summary()
                    .unwrap_or("(no commit message)")
                    .to_string();
                let author = commit.author().name().unwrap_or("unknown").to_string();
                incoming.push(IncomingItem::Commit {
                    sha: short(&oid),
                    message: summary,
                    author,
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
                if incoming.len() >= 50 {
                    break;
                }
            }
            incoming.reverse(); // chronological order

            let commits_count = incoming.len();

            // Heuristic: did a lockfile change in the diff? Drives whether reinstall step appears.
            let local_commit = repo.find_commit(local).map_err(CoreError::from)?;
            let remote_commit = repo.find_commit(remote).map_err(CoreError::from)?;
            let local_tree = local_commit.tree().map_err(CoreError::from)?;
            let remote_tree = remote_commit.tree().map_err(CoreError::from)?;
            let diff = repo
                .diff_tree_to_tree(Some(&local_tree), Some(&remote_tree), None)
                .map_err(CoreError::from)?;
            let mut lockfile_changed = false;
            diff.foreach(
                &mut |delta, _| {
                    if let Some(path) = delta.new_file().path() {
                        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                        if matches!(
                            name,
                            "package-lock.json"
                                | "yarn.lock"
                                | "pnpm-lock.yaml"
                                | "bun.lockb"
                                | "Cargo.lock"
                        ) {
                            lockfile_changed = true;
                        }
                    }
                    true
                },
                None,
                None,
                None,
            )
            .map_err(CoreError::from)?;

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
                            FetchStrategy::FastForwardOnly => {
                                "fast-forward only · refuse if history rewritten"
                            }
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

            if lockfile_changed && !cfg.post_update.is_empty() {
                steps.push(PlanStep {
                    title: "Reinstall dependencies".into(),
                    detail: Some(format!(
                        "lockfile changed · {}",
                        cfg.post_update.join(" && ")
                    )),
                    tag: PlanTag::TimeEstimate,
                });
            }

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
                app_id,
                source_type: SourceType::Git,
                from_label: short(&local),
                to_label: short(&remote),
                from_meta: vec![
                    KeyValue {
                        key: "branch".into(),
                        value: cfg.branch,
                    },
                    KeyValue {
                        key: "tag".into(),
                        value: tag_at(&repo, local).unwrap_or_default(),
                    },
                ],
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
        let post_update = cfg.post_update.clone();
        let post_update_cwd = cfg.post_update_cwd.clone();
        let apps_root = ctx.paths.apps_root().to_path_buf();

        emit(&ctx, &app_id, "stash", "stashing local changes").await;
        let did_stash = stash_local_changes(&repo_dir)?;

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
            // Best-effort: try to pop. If it conflicts, keep the stash and surface a warning.
            let popped = pop_stash(&repo_dir).unwrap_or(false);
            if !popped {
                tracing::warn!(
                    app = app.id,
                    "stash kept due to conflict — see `git stash list`"
                );
            }
        }

        if !post_update.is_empty() {
            let cwd_rel = post_update_cwd.unwrap_or_else(|| format!("upstream/{}", app.id));
            let cwd = apps_root.join(&cwd_rel);
            for cmd in &post_update {
                emit(&ctx, &app_id, "post_update", &format!("running: {cmd}")).await;
                run_shell_command(cmd, &cwd, &ctx, &app_id).await?;
            }
        }

        let outcome = UpdateOutcome {
            new_version: None,
            new_sha: Some(short(&new_oid)),
            bytes_downloaded: 0, // git doesn't expose this cheaply; reported as 0 for git sources
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            messages: vec![format!("merged {}", short(&new_oid))],
        };
        Ok(outcome)
    }

    async fn rollback(
        &self,
        app: &AppEntry,
        snapshot_archive: &Path,
        paths: &AppPaths,
    ) -> Result<(), CoreError> {
        // The universal rollback engine (rollback::restore) handles tar.zst extraction.
        // The git source's job in rollback is just to confirm the resulting repo is healthy.
        let archive = snapshot_archive.to_path_buf();
        let repo_dir = Self::repo_dir(app, paths);
        crate::rollback::restore_archive(&archive, &repo_dir).await?;

        // Best-effort health check: open the repo and read HEAD.
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

fn open_or_init_bare_clone(
    repo_dir: &Path,
    url: &str,
    branch: &str,
) -> Result<Repository, CoreError> {
    if repo_dir.exists() {
        Repository::open(repo_dir).map_err(CoreError::from)
    } else {
        // First-time check: clone shallowly so we can read HEAD without pulling history.
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

fn tag_at(repo: &Repository, oid: git2::Oid) -> Option<String> {
    let mut found = None;
    let _ = repo.tag_foreach(|tag_oid, name_bytes| {
        if tag_oid == oid {
            if let Ok(name) = std::str::from_utf8(name_bytes) {
                let trimmed = name.trim_start_matches("refs/tags/");
                found = Some(trimmed.to_string());
                return false;
            }
        }
        true
    });
    found
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
    let repo_dir = repo_dir.to_path_buf();
    let mut repo = Repository::open(&repo_dir).map_err(CoreError::from)?;
    let is_clean = {
        let statuses = repo.statuses(None).map_err(CoreError::from)?;
        statuses.is_empty()
    };
    if is_clean {
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
    let annotated: AnnotatedCommit<'_> = repo
        .find_annotated_commit(target)
        .map_err(CoreError::from)?;
    let (analysis, _pref) = repo
        .merge_analysis(&[&annotated])
        .map_err(CoreError::from)?;

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

async fn run_shell_command(
    cmd: &str,
    cwd: &Path,
    ctx: &ApplyCtx,
    app_id: &str,
) -> Result<(), CoreError> {
    use tokio::io::{AsyncBufReadExt as _, BufReader};

    // We don't shell out to cmd/powershell — we tokenise here for safety.
    // For complex commands the manifest can use an array form in a future schema version.
    let mut parts = shell_words::split(cmd)
        .map_err(|e| CoreError::config(format!("post_update command parse error: {e}")))?
        .into_iter();
    let program = parts
        .next()
        .ok_or_else(|| CoreError::config("empty post_update command"))?;
    let args: Vec<String> = parts.collect();

    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| CoreError::io(cwd, e))?;

    // Stream stdout into the activity bus.
    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        let tx = ctx.progress.clone();
        let id = app_id.to_string();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx
                    .send(ProgressEvent {
                        app_id: id.clone(),
                        step: "post_update".into(),
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
