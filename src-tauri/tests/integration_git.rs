//! Integration tests for the `git` source — Agent 05 acceptance suite.
//!
//! Per CONTRACT.md §2.2: **no mock-only test strategy**. Every test in this file
//! builds a real bare git repository via `git2::Repository::init_bare`, makes real
//! commits in a staging worktree, pushes them over `file://` to the bare, and drives
//! the production [`GitSource`] through its `check`, `plan`, `apply`, and `rollback`
//! methods. The only difference between this code path and the one a user exercises
//! is the source URL (`file://` instead of `https://`).
//!
//! Coverage mirrors `docs/UPDATE_FLOWS.md` §2 step-by-step:
//!   * `check_reports_up_to_date_when_remote_unchanged`           — step "check"
//!   * `check_reports_update_available_when_remote_has_new_commits` — step "check"
//!   * `plan_emits_commit_list`                                   — step "plan"
//!   * `apply_fast_forwards_local_to_remote`                      — steps "fetch"→"swap"
//!   * `apply_refuses_force_push_with_not_fast_forward`           — step "verify"
//!   * `apply_runs_post_update_command_if_configured`             — step "`post_update`"
//!   * `rollback_restores_snapshot`                               — step "rollback"

#![allow(
    clippy::missing_panics_doc,
    clippy::missing_const_for_fn,
    clippy::default_trait_access,
    clippy::option_if_let_else,
    clippy::uninlined_format_args,
    clippy::iter_on_single_items,
    clippy::similar_names
)]

use std::fs;
use std::path::Path;

use git2::{IndexAddOption, Repository, Signature};
use serde_json::json;
use tempfile::TempDir;

use iptv_hub_core::errors::CoreError;
use iptv_hub_core::manifest::types::{AppEntry, LaunchKind, LaunchSpec, SourceType, WaitFor};
use iptv_hub_core::paths::AppPaths;
use iptv_hub_core::sources::git::GitSource;
use iptv_hub_core::sources::{ApplyCtx, IncomingItem, ProgressEvent, Source, UpdateState};

// ── helpers ──────────────────────────────────────────────────────────────────────

/// Build a `file://` URL libgit2 can clone. Windows needs three slashes for
/// absolute paths (`file:///C:/...`); Unix paths already start with `/` so the
/// join produces three slashes too.
fn file_url(path: &Path) -> String {
    let p = path.to_string_lossy().replace('\\', "/");
    if p.starts_with('/') {
        format!("file://{p}")
    } else {
        format!("file:///{p}")
    }
}

/// Initialise a bare repo at `bare_path` and seed it with a single initial commit
/// (a tiny `README.md`) pushed to `refs/heads/main`. Returns the seed commit's OID
/// and a [`TempDir`] holding the staging worktree (kept alive so the caller can push
/// further commits into the same bare via `push_new_commit`).
fn build_seeded_bare(bare_path: &Path) -> (git2::Oid, TempDir) {
    fs::create_dir_all(bare_path.parent().expect("bare parent")).expect("mkdir bare parent");
    let bare = Repository::init_bare(bare_path).expect("init bare");
    bare.set_head("refs/heads/main").expect("set bare head");

    // Staging worktree — we'll push from here.
    let staging = TempDir::new().expect("staging tempdir");
    let repo = Repository::init(staging.path()).expect("init staging");
    {
        let mut cfg = repo.config().expect("config");
        cfg.set_str("init.defaultBranch", "main")
            .expect("set defaultBranch main");
    }

    // Seed file.
    fs::write(
        staging.path().join("README.md"),
        b"# integration_git seed\n",
    )
    .expect("write README.md");

    let oid = commit_all(&repo, "seed: initial commit");
    let _ = repo.set_head("refs/heads/main");

    // Wire up `origin` and push.
    repo.remote("origin", &file_url(bare_path))
        .expect("add origin remote");
    let mut origin = repo.find_remote("origin").expect("find origin");
    origin
        .push(&["refs/heads/main:refs/heads/main"], None)
        .expect("push seed");

    (oid, staging)
}

/// Add and push a new commit on top of whatever main currently is in `staging`.
/// Parent directories of `file_name` are created if needed.
fn push_new_commit(staging: &Path, file_name: &str, body: &[u8], message: &str) -> git2::Oid {
    let repo = Repository::open(staging).expect("open staging");
    let target = staging.join(file_name);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).expect("mkdir commit file parent");
    }
    fs::write(&target, body).expect("write commit file");
    let oid = commit_all(&repo, message);
    let mut origin = repo.find_remote("origin").expect("find origin");
    origin
        .push(&["refs/heads/main:refs/heads/main"], None)
        .expect("push new commit");
    oid
}

/// Force-push a fresh orphan commit (no parents) onto `refs/heads/main`. Simulates
/// an upstream history rewrite — apply must refuse this with `NotFastForward`.
fn force_push_orphan(bare_path: &Path) -> git2::Oid {
    // Fresh clone into a scratch worktree so we don't poison the original staging.
    let scratch = TempDir::new().expect("scratch tempdir");
    let bare_url = file_url(bare_path);
    let repo = Repository::clone(&bare_url, scratch.path()).expect("clone bare for force-push");

    // Wipe everything in the worktree and write a single file with new content.
    for entry in fs::read_dir(scratch.path()).expect("read scratch") {
        let p = entry.expect("entry").path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name == ".git" {
            continue;
        }
        if p.is_dir() {
            fs::remove_dir_all(&p).expect("rm dir");
        } else {
            fs::remove_file(&p).expect("rm file");
        }
    }
    fs::write(scratch.path().join("FORCED.txt"), b"force-pushed history\n")
        .expect("write forced file");

    // Build a tree from the index.
    let mut index = repo.index().expect("index");
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .expect("add_all forced");
    index.write().expect("write index");
    let tree_oid = index.write_tree().expect("write tree");
    let tree = repo.find_tree(tree_oid).expect("find tree");

    // Orphan commit (no parents) — guaranteed not a descendant of anything.
    let sig = Signature::now("Force Pusher", "force@example.com").expect("sig");
    let new_oid = repo
        .commit(None, &sig, &sig, "force-pushed root", &tree, &[])
        .expect("orphan commit");

    // Update local main to the orphan, then force-push.
    repo.reference("refs/heads/main", new_oid, true, "set to orphan")
        .expect("set local main");
    let mut origin = repo.find_remote("origin").expect("find origin");
    origin
        .push(&["+refs/heads/main:refs/heads/main"], None)
        .expect("force push orphan");
    new_oid
}

/// Commit every file currently in the worktree.
fn commit_all(repo: &Repository, message: &str) -> git2::Oid {
    let mut index = repo.index().expect("index");
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .expect("add_all");
    index.write().expect("write index");
    let tree_oid = index.write_tree().expect("write tree");
    let tree = repo.find_tree(tree_oid).expect("find tree");
    let sig = Signature::now("Test", "test@example.com").expect("sig");

    let parents: Vec<git2::Commit<'_>> = match repo.head() {
        Ok(head) => match head.target() {
            Some(oid) => vec![repo.find_commit(oid).expect("find parent")],
            None => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();

    repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        message,
        &tree,
        &parent_refs,
    )
    .expect("commit")
}

/// Set up `AppPaths` against a TempDir-rooted layout that mirrors the production
/// portable install: `data_dir = <root>/data`, `apps_root = <root>/apps`.
fn build_paths(temp: &TempDir) -> AppPaths {
    let data_dir = temp.path().join("data");
    let apps_root = temp.path().join("apps");
    fs::create_dir_all(data_dir.join("logs")).expect("mkdir data/logs");
    fs::create_dir_all(apps_root.join("upstream")).expect("mkdir apps/upstream");
    fs::create_dir_all(apps_root.join("cache").join("rollback"))
        .expect("mkdir apps/cache/rollback");
    AppPaths::from_dirs(data_dir, apps_root)
}

/// Build an `AppEntry` for a git source rooted at `bare_path`. `post_update`
/// commands run with cwd = `upstream/<id>` after every successful fast-forward.
fn build_app(id: &str, bare_path: &Path, post_update: &[String]) -> AppEntry {
    let url = file_url(bare_path);
    let mut source = json!({
        "url": url,
        "branch": "main",
        "fetch_strategy": "fast-forward-only",
    });
    if !post_update.is_empty() {
        source["post_update"] = json!(post_update);
    }
    AppEntry {
        id: id.to_string(),
        name: format!("Integration Git Fixture ({id})"),
        source_type: SourceType::Git,
        favorite: false,
        enabled: true,
        icon: None,
        polling: None,
        launch: LaunchSpec {
            kind: LaunchKind::Executable,
            cwd: Some(format!("upstream/{id}")),
            command: Some("./nonexistent-launch".into()),
            args: vec![],
            env: Default::default(),
            wait_for: Some(WaitFor::None),
        },
        health: None,
        source: Some(source),
        user_data: None,
    }
}

/// Build a real `ApplyCtx` with a bounded channel. The receiver is returned so
/// tests can drain progress events and assert on them (or simply drop it).
fn build_apply_ctx(paths: AppPaths) -> (ApplyCtx, tokio::sync::mpsc::Receiver<ProgressEvent>) {
    let (tx, rx) = tokio::sync::mpsc::channel(64);
    (
        ApplyCtx {
            paths,
            progress: tx,
            cancel: tokio_util::sync::CancellationToken::new(),
        },
        rx,
    )
}

/// Drain every event from the channel into a Vec. Call this after the apply
/// future has resolved so the sender is dropped.
async fn drain(mut rx: tokio::sync::mpsc::Receiver<ProgressEvent>) -> Vec<ProgressEvent> {
    let mut out = Vec::new();
    while let Some(ev) = rx.recv().await {
        out.push(ev);
    }
    out
}

/// Short-OID helper that mirrors the `short()` in `sources::git`.
fn short(oid: git2::Oid) -> String {
    let s = oid.to_string();
    s.get(..7).unwrap_or(&s).to_string()
}

// ── tests ────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn check_reports_up_to_date_when_remote_unchanged() {
    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("up-to-date.git");
    let (seed_oid, _staging) = build_seeded_bare(&bare);

    let paths = build_paths(&temp);
    let app = build_app("up-to-date", &bare, &[]);
    let source = GitSource::new();

    // First check seeds the upstream clone from the bare.
    let state = source.check(&app, &paths).await.expect("check");
    match state {
        UpdateState::UpToDate { ref current } => {
            assert_eq!(current, &short(seed_oid), "current SHA should equal seed");
        }
        other => panic!("expected UpToDate after fresh clone, got {other:?}"),
    }

    // A second check (no remote change in between) must remain UpToDate.
    let again = source.check(&app, &paths).await.expect("check 2");
    assert!(
        matches!(again, UpdateState::UpToDate { .. }),
        "second check should still be UpToDate, got {again:?}"
    );
}

#[tokio::test]
async fn check_reports_update_available_when_remote_has_new_commits() {
    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("update-available.git");
    let (seed_oid, staging) = build_seeded_bare(&bare);

    let paths = build_paths(&temp);
    let app = build_app("update-available", &bare, &[]);
    let source = GitSource::new();

    // Clone the upstream by running check once.
    let _ = source.check(&app, &paths).await.expect("seed check");

    // Push a brand-new commit and re-check.
    let new_oid = push_new_commit(
        staging.path(),
        "CHANGELOG.md",
        b"# changelog\n- bug fixed\n",
        "feat: add changelog",
    );

    // Re-run check — the upstream clone must fetch and observe the new tip.
    // GitSource::check itself doesn't fetch (it compares local HEAD to the local
    // tracking ref), so we drive a `plan` (which does fetch) and then check again.
    let _plan = source
        .plan(&app, &paths)
        .await
        .expect("plan to force fetch");

    let state = source.check(&app, &paths).await.expect("check post-fetch");
    match state {
        UpdateState::UpdateAvailable { from, to, summary } => {
            assert_eq!(from, short(seed_oid), "from should be the seed SHA");
            assert_eq!(to, short(new_oid), "to should be the new SHA");
            assert!(
                summary.contains(&short(seed_oid)) && summary.contains(&short(new_oid)),
                "summary {summary:?} should mention both SHAs"
            );
        }
        other => panic!("expected UpdateAvailable after upstream commit, got {other:?}"),
    }
}

#[tokio::test]
async fn plan_emits_commit_list() {
    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("plan-commits.git");
    let (_seed_oid, staging) = build_seeded_bare(&bare);

    let paths = build_paths(&temp);
    let app = build_app("plan-commits", &bare, &[]);
    let source = GitSource::new();

    // Seed local clone via check.
    let _ = source.check(&app, &paths).await.expect("seed check");

    // Push two new commits on top of the seed.
    let c1 = push_new_commit(staging.path(), "docs/A.md", b"alpha\n", "docs: add A");
    let c2 = push_new_commit(staging.path(), "docs/B.md", b"beta\n", "docs: add B");

    let plan = source.plan(&app, &paths).await.expect("plan");

    // The two commits must appear in `incoming`, in chronological order
    // (oldest first, per `git.rs` `incoming.reverse()`).
    let commits: Vec<(&str, &str)> = plan
        .incoming
        .iter()
        .filter_map(|i| match i {
            IncomingItem::Commit { sha, message, .. } => Some((sha.as_str(), message.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(
        commits.len(),
        2,
        "plan must list exactly the two new commits, got {commits:?}"
    );
    assert_eq!(commits[0].0, short(c1), "first commit SHA");
    assert_eq!(commits[0].1, "docs: add A", "first commit message");
    assert_eq!(commits[1].0, short(c2), "second commit SHA");
    assert_eq!(commits[1].1, "docs: add B", "second commit message");

    // Plan labels should reflect the SHA transition.
    assert_eq!(plan.to_label, short(c2), "to_label should be remote tip");
    assert!(
        !plan.steps.is_empty(),
        "plan must include a non-empty step list"
    );
}

#[tokio::test]
async fn apply_fast_forwards_local_to_remote() {
    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("apply-ff.git");
    let (_seed_oid, staging) = build_seeded_bare(&bare);

    let paths = build_paths(&temp);
    let app = build_app("apply-ff", &bare, &[]);
    let source = GitSource::new();

    let _ = source.check(&app, &paths).await.expect("seed check");

    let new_oid = push_new_commit(
        staging.path(),
        "FEATURE.md",
        b"new feature land\n",
        "feat: a new feature",
    );

    let plan = source.plan(&app, &paths).await.expect("plan");
    let (ctx, rx) = build_apply_ctx(paths.clone());
    let outcome = source.apply(&app, plan, ctx).await.expect("apply");

    let events = drain(rx).await;

    // Local repo must now be at the remote tip.
    let repo_dir = paths.apps_root().join("upstream").join("apply-ff");
    let local = Repository::open(&repo_dir).expect("open local");
    let head_oid = local.head().expect("head ref").target().expect("head oid");
    assert_eq!(head_oid, new_oid, "local HEAD must equal new remote tip");

    // Outcome assertions.
    assert_eq!(
        outcome.new_sha.as_deref(),
        Some(short(new_oid).as_str()),
        "outcome.new_sha should be the merged remote SHA"
    );
    assert!(
        outcome.elapsed_ms < 60_000,
        "elapsed_ms should be a sensible value, got {}",
        outcome.elapsed_ms
    );
    assert!(
        outcome.messages.iter().any(|m| m.contains(&short(new_oid))),
        "outcome.messages should mention the new SHA: {:?}",
        outcome.messages
    );

    // Progress channel must have at least fetch + merge events.
    let steps: Vec<&str> = events.iter().map(|e| e.step.as_str()).collect();
    assert!(
        steps.contains(&"fetch"),
        "expected a 'fetch' progress event, got {steps:?}"
    );
    assert!(
        steps.contains(&"merge"),
        "expected a 'merge' progress event, got {steps:?}"
    );
}

#[tokio::test]
async fn apply_refuses_force_push_with_not_fast_forward() {
    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("force-push.git");
    let (_seed_oid, _staging) = build_seeded_bare(&bare);

    let paths = build_paths(&temp);
    let app = build_app("force-push", &bare, &[]);
    let source = GitSource::new();

    // Seed local clone.
    let _ = source.check(&app, &paths).await.expect("seed check");

    // Force-push an orphan commit onto remote main.
    let orphan = force_push_orphan(&bare);
    assert!(
        !orphan.is_zero(),
        "force-pushed orphan OID must be non-zero"
    );

    // Plan succeeds (it just walks history); apply must refuse with NotFastForward.
    let plan = source
        .plan(&app, &paths)
        .await
        .expect("plan after force push");
    let (ctx, _rx) = build_apply_ctx(paths.clone());
    let result = source.apply(&app, plan, ctx).await;

    let err = result.expect_err("apply must refuse non-fast-forward");
    match err {
        CoreError::NotFastForward { ref message } => {
            assert!(
                message.contains("non-fast-forward"),
                "NotFastForward message must contain 'non-fast-forward' literal: {message:?}"
            );
        }
        other => panic!("expected CoreError::NotFastForward, got {other:?}"),
    }

    // Local HEAD must NOT have moved: rollback to pre-apply state is implicit
    // because merge_ff_only refuses before any reference is touched.
    let repo_dir = paths.apps_root().join("upstream").join("force-push");
    let local = Repository::open(&repo_dir).expect("open local");
    let head_oid = local.head().expect("head").target().expect("head oid");
    assert_ne!(
        head_oid, orphan,
        "local HEAD must NOT have moved to the force-pushed orphan"
    );
}

#[tokio::test]
async fn apply_runs_post_update_command_if_configured() {
    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("post-update.git");
    let (_seed_oid, staging) = build_seeded_bare(&bare);

    let paths = build_paths(&temp);

    // Use a command that exists on every supported host: `git --version`.
    // git2 is vendored so `git2-rs` works without the CLI, but the CLI is
    // installed on every dev box and on every CI runner. The command's stdout
    // streams to the progress channel via `step = "post_update"`.
    let post_update = vec!["git --version".to_string()];
    let app = build_app("post-update", &bare, &post_update);
    let source = GitSource::new();

    let _ = source.check(&app, &paths).await.expect("seed check");

    // Push a new commit so apply has something to fast-forward to.
    let _new_oid = push_new_commit(
        staging.path(),
        "feature.txt",
        b"a feature\n",
        "feat: a feature",
    );

    let plan = source.plan(&app, &paths).await.expect("plan");
    let (ctx, rx) = build_apply_ctx(paths.clone());
    let outcome = source.apply(&app, plan, ctx).await.expect("apply");
    let events = drain(rx).await;

    // The post_update step must have emitted a "running: ..." event.
    let running = events.iter().find(|e| {
        e.step == "post_update" && e.message.starts_with("running:") && e.message.contains("git")
    });
    assert!(
        running.is_some(),
        "expected a post_update 'running: git --version' event, got: {:?}",
        events
            .iter()
            .map(|e| (e.step.clone(), e.message.clone()))
            .collect::<Vec<_>>()
    );

    // The post_update command's stdout must have streamed at least one line that
    // contains "git version" (printed by `git --version`).
    let stdout_line = events
        .iter()
        .find(|e| e.step == "post_update" && e.message.contains("git version"));
    assert!(
        stdout_line.is_some(),
        "expected a 'git version ...' stdout line in post_update events, got: {:?}",
        events
            .iter()
            .filter(|e| e.step == "post_update")
            .map(|e| e.message.clone())
            .collect::<Vec<_>>()
    );

    // Apply must still succeed and report a new SHA.
    assert!(
        outcome.new_sha.is_some(),
        "outcome.new_sha must be set on successful apply"
    );
}

#[tokio::test]
async fn rollback_restores_snapshot() {
    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("rollback.git");
    let (seed_oid, staging) = build_seeded_bare(&bare);

    let paths = build_paths(&temp);
    let app = build_app("rollback", &bare, &[]);
    let source = GitSource::new();

    // Seed the local clone.
    let _ = source.check(&app, &paths).await.expect("seed check");
    let repo_dir = paths.apps_root().join("upstream").join("rollback");

    // Confirm we're at the seed commit and the README is present.
    {
        let local = Repository::open(&repo_dir).expect("open local");
        let head = local.head().expect("head").target().expect("head oid");
        assert_eq!(head, seed_oid, "pre-snapshot HEAD must equal seed");
        assert!(repo_dir.join("README.md").is_file(), "seed README present");
    }

    // Snapshot the upstream dir BEFORE applying any changes.
    let cache_root = paths.apps_root().join("cache");
    let snapshot =
        iptv_hub_core::rollback::create_archive(&app.id, &short(seed_oid), &repo_dir, &cache_root)
            .await
            .expect("create snapshot");
    assert!(snapshot.path.is_file(), "snapshot archive must exist");
    // The archive size is the source of truth for "real content was written".
    // (`SnapshotResult::size_bytes` is captured inside the spawn_blocking before
    // the zstd auto-finish drop runs, so it can read as 0 for very small payloads;
    // the on-disk file is fully flushed by the time `create_archive` resolves.)
    let on_disk_size = fs::metadata(&snapshot.path)
        .expect("stat snapshot archive")
        .len();
    assert!(
        on_disk_size > 0,
        "snapshot archive on disk must contain data, got 0 bytes at {}",
        snapshot.path.display()
    );

    // Push a divergent commit upstream and apply — this changes the tree.
    let new_oid = push_new_commit(
        staging.path(),
        "FEATURE.md",
        b"new feature land\n",
        "feat: a feature",
    );
    let plan = source.plan(&app, &paths).await.expect("plan");
    let (ctx, _rx) = build_apply_ctx(paths.clone());
    let outcome = source.apply(&app, plan, ctx).await.expect("apply");
    assert_eq!(outcome.new_sha.as_deref(), Some(short(new_oid).as_str()));
    assert!(
        repo_dir.join("FEATURE.md").is_file(),
        "FEATURE.md must exist after apply"
    );

    // Now roll back via the production source `rollback` path. The restored
    // tree must match the snapshot: README present, FEATURE.md absent, HEAD
    // back at seed.
    source
        .rollback(&app, &snapshot.path, &paths)
        .await
        .expect("rollback");

    assert!(
        repo_dir.join("README.md").is_file(),
        "post-rollback README must be present"
    );
    assert!(
        !repo_dir.join("FEATURE.md").exists(),
        "post-rollback FEATURE.md must be absent"
    );
    let local = Repository::open(&repo_dir).expect("open post-rollback");
    let head = local.head().expect("head").target().expect("head oid");
    assert_eq!(head, seed_oid, "post-rollback HEAD must equal seed SHA");
}
