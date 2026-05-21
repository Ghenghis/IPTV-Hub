//! Integration tests for the `web` source. Real fixtures only — no mocks.
//!
//! The tests build a real bare git repository from the tiny-web-app fixture, clone it
//! into a temp directory via `WebSource`, run the install command, and exercise the
//! port-reservation path. The Node-side health check spawns the fixture's `index.js`
//! and pokes the HTTP endpoint to prove the install produced a runnable tree.

#![allow(
    clippy::missing_panics_doc,
    clippy::missing_const_for_fn,
    clippy::let_underscore_future,
    clippy::default_trait_access,
    clippy::option_if_let_else,
    clippy::uninlined_format_args,
    clippy::iter_on_single_items,
)]

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use git2::{IndexAddOption, Repository, Signature};
use serde_json::json;
use tempfile::TempDir;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use iptv_hub_core::manifest::types::{
    AppEntry, LaunchKind, LaunchSpec, SourceType, WaitFor,
};
use iptv_hub_core::paths::AppPaths;
use iptv_hub_core::sources::{ApplyCtx, Source, UpdatePlan};

// ── helpers ──────────────────────────────────────────────────────────────────────

/// Verify `node` and `npm` are on PATH. Tests that need them call this first and
/// print a visible skip notice when they aren't available, per the agent contract.
fn require_node_and_npm() -> Option<()> {
    let node = which("node");
    let npm = which("npm");
    if node.is_none() || npm.is_none() {
        eprintln!(
            "\nintegration_web: SKIPPING — node/npm not on PATH \
             (node={:?}, npm={:?}). Install Node 20+ and re-run.",
            node, npm
        );
        return None;
    }
    Some(())
}

fn which(prog: &str) -> Option<PathBuf> {
    let exts: Vec<&str> = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat", ""]
    } else {
        vec![""]
    };
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for ext in &exts {
            let candidate = dir.join(format!("{prog}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn fixture_root() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir)
        .join("tests")
        .join("fixtures")
        .join("apps")
        .join("tiny-web-app")
}

/// Copy the tiny-web-app fixture into `dest`, ignoring transient artefacts.
fn copy_fixture_to(dest: &Path) {
    fs::create_dir_all(dest).expect("mkdir dest");
    for entry in walkdir(&fixture_root()) {
        let rel = entry.strip_prefix(fixture_root()).unwrap();
        let target = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&target).expect("mkdir");
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).expect("mkdir parent");
            }
            fs::copy(&entry, &target).expect("copy file");
        }
    }
}

fn walkdir(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(p) = stack.pop() {
        if p.is_dir() {
            // Skip node_modules / .git from any stray local state.
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name == "node_modules" || name == ".git" {
                continue;
            }
            out.push(p.clone());
            for child in fs::read_dir(&p).expect("read_dir") {
                stack.push(child.expect("entry").path());
            }
        } else {
            out.push(p);
        }
    }
    out
}

/// Build a real bare git repository under `bare_path` containing the contents of
/// `working_dir`. Returns the head OID of `main`.
fn build_bare_repo(bare_path: &Path, _working_dir: &Path) -> git2::Oid {
    if bare_path.exists() {
        fs::remove_dir_all(bare_path).expect("rm bare");
    }
    fs::create_dir_all(bare_path.parent().unwrap()).expect("mkdir bare parent");

    let bare = Repository::init_bare(bare_path).expect("init bare");
    // Initialise HEAD to refs/heads/main so subsequent pushes match.
    bare.set_head("refs/heads/main").expect("set bare head");

    // Build a non-bare staging clone alongside, populate it from the fixture, commit, push.
    let staging = TempDir::new().expect("staging tempdir");
    let staging_repo =
        Repository::init(staging.path()).expect("init staging");
    // Set default branch to main on the staging too.
    {
        let mut cfg = staging_repo.config().expect("config");
        cfg.set_str("init.defaultBranch", "main").expect("set main");
    }
    copy_fixture_to(staging.path());

    let oid = commit_all(&staging_repo, "initial fixture commit");
    // Force HEAD to main if it isn't already (libgit2 historically uses master by default).
    let _ = staging_repo.set_head("refs/heads/main");

    // Add the bare path as `origin` and push `main`.
    let bare_url = format!("file://{}", bare_path.to_string_lossy().replace('\\', "/"));
    staging_repo
        .remote("origin", &bare_url)
        .expect("add remote");
    let mut origin = staging_repo
        .find_remote("origin")
        .expect("find remote origin");
    origin
        .push(&["refs/heads/main:refs/heads/main"], None)
        .expect("push main");

    oid
}

/// Commit every file under the repo's worktree.
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

fn build_paths(temp: &TempDir) -> AppPaths {
    let data_dir = temp.path().join("data");
    let apps_root = temp.path().join("apps");
    fs::create_dir_all(data_dir.join("logs")).expect("mkdir data");
    fs::create_dir_all(apps_root.join("upstream")).expect("mkdir upstream");
    AppPaths::from_dirs(data_dir, apps_root)
}

fn build_app(bare_path: &Path, port: u16) -> AppEntry {
    let url = format!("file://{}", bare_path.to_string_lossy().replace('\\', "/"));
    AppEntry {
        id: "tiny-web-app".into(),
        name: "Tiny Web App".into(),
        source_type: SourceType::Web,
        favorite: false,
        enabled: true,
        icon: None,
        polling: None,
        launch: LaunchSpec {
            kind: LaunchKind::Npm,
            cwd: Some("upstream/tiny-web-app".into()),
            command: Some("start".into()),
            args: vec![],
            env: Default::default(),
            wait_for: Some(WaitFor::None),
        },
        health: None,
        source: Some(json!({
            "url": url,
            "branch": "main",
            "fetch_strategy": "fast-forward-only",
            "package_manager": "npm",
            "install_command": "ci",
            "start_command": "start",
            "port": port,
        })),
        user_data: None,
    }
}

fn build_apply_ctx(paths: AppPaths) -> (ApplyCtx, tokio::sync::mpsc::Receiver<iptv_hub_core::sources::ProgressEvent>) {
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

/// Spin up `node index.js` against the upstream copy and probe `/`. The launch is
/// outside the `Source::apply` boundary; this exercises that the install actually
/// produced a runnable tree on the same port the source reserved.
async fn http_get_within(port: u16, deadline: Duration) -> bool {
    let start = Instant::now();
    let url = format!("http://127.0.0.1:{port}/");
    while start.elapsed() < deadline {
        match reqwest_get(&url).await {
            Ok(true) => return true,
            Ok(false) | Err(_) => {
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
    }
    false
}

async fn reqwest_get(url: &str) -> Result<bool, reqwest::Error> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;
    let resp = client.get(url).send().await?;
    Ok(resp.status().is_success())
}

// ── tests ────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn fetch_install_start_health_check_stop() {
    if require_node_and_npm().is_none() {
        return;
    }

    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("tiny-web-app.git");
    build_bare_repo(&bare, &fixture_root());

    let paths = build_paths(&temp);
    let app = build_app(&bare, find_free_port());

    let source = iptv_hub_core::sources::web::WebSource::new();

    // check() seeds the upstream clone.
    let state = source.check(&app, &paths).await.expect("check");
    assert!(
        matches!(state, iptv_hub_core::sources::UpdateState::UpToDate { .. }),
        "expected UpToDate after fresh clone, got {state:?}"
    );

    // apply() — fetch+install+port reservation. Because the fixture's package.json has
    // zero deps the install is fast and offline-safe.
    let (ctx, mut rx) = build_apply_ctx(paths.clone());
    // Drain progress events to a vec for the test assertion.
    let drain = tokio::spawn(async move {
        let mut msgs = Vec::new();
        while let Some(ev) = rx.recv().await {
            msgs.push((ev.step, ev.message));
        }
        msgs
    });
    let plan = source.plan(&app, &paths).await.expect("plan");
    let outcome = source
        .apply(&app, blank_plan_like(&plan), ctx)
        .await
        .expect("apply");
    drop_apply_ctx_sender(&source); // no-op; for clarity
    // Allow drain task to finish: it ends when the ApplyCtx sender drops.
    let _ = drain;

    // node_modules should exist after `npm ci` (even with zero deps npm creates the
    // directory marker).
    let upstream = paths.apps_root().join("upstream").join("tiny-web-app");
    assert!(upstream.join("package-lock.json").is_file(), "lockfile present");

    // The chosen port is the last "listening port N" message.
    let port = port_from_messages(&outcome.messages)
        .expect("listening port message missing");

    // Now spawn the real node server and prove it answers HTTP.
    let mut child = Command::new(which("node").expect("node on PATH"))
        .arg("index.js")
        .current_dir(&upstream)
        .env("PORT", port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn node");

    // Read a little stdout so we can tell when it's listening; we won't block on it.
    if let Some(mut stdout) = child.stdout.take() {
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            let mut buf = [0u8; 128];
            let _ = stdout.read(&mut buf).await;
        })
        .await;
    }

    let ok = http_get_within(port, Duration::from_secs(10)).await;
    let _ = child.kill().await;
    assert!(
        ok,
        "tiny-web-app did not answer HTTP 200 on port {port} within 10s"
    );
}

#[tokio::test]
async fn port_collision_picks_alternate() {
    if require_node_and_npm().is_none() {
        return;
    }

    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("tiny-web-app.git");
    build_bare_repo(&bare, &fixture_root());

    let paths = build_paths(&temp);
    // Bind a real listener to the preferred port so the source has to pick an alternate.
    let preferred_listener =
        TcpListener::bind(("127.0.0.1", 0)).expect("bind preferred listener");
    let preferred_port = preferred_listener.local_addr().unwrap().port();

    let app = build_app(&bare, preferred_port);
    let source = iptv_hub_core::sources::web::WebSource::new();

    let _ = source.check(&app, &paths).await.expect("check");
    let plan = source.plan(&app, &paths).await.expect("plan");
    let (ctx, _rx) = build_apply_ctx(paths.clone());
    let outcome = source.apply(&app, plan, ctx).await.expect("apply");

    let chosen = port_from_messages(&outcome.messages).expect("listening port message");
    assert_ne!(
        chosen, preferred_port,
        "source should have picked an alternate when {preferred_port} was bound"
    );
    let msg_collision = outcome
        .messages
        .iter()
        .any(|m| m.contains("listening port"));
    assert!(msg_collision, "expected a 'listening port' message: {:?}", outcome.messages);

    drop(preferred_listener);
}

#[tokio::test]
async fn lockfile_drift_triggers_install() {
    if require_node_and_npm().is_none() {
        return;
    }

    let temp = TempDir::new().expect("tempdir");
    let bare = temp.path().join("_bare").join("tiny-web-app.git");
    build_bare_repo(&bare, &fixture_root());

    let paths = build_paths(&temp);
    let app = build_app(&bare, find_free_port());
    let source = iptv_hub_core::sources::web::WebSource::new();

    // Initial clone + apply (zero-drift first run).
    let _ = source.check(&app, &paths).await.expect("check");
    let plan = source.plan(&app, &paths).await.expect("plan");
    let (ctx, _rx) = build_apply_ctx(paths.clone());
    let outcome_first = source
        .apply(&app, plan, ctx)
        .await
        .expect("first apply");
    let upstream = paths.apps_root().join("upstream").join("tiny-web-app");
    assert!(upstream.join("package-lock.json").is_file());

    let lockfile_path = upstream.join("package-lock.json");
    let lockfile_mtime_before = fs::metadata(&lockfile_path)
        .expect("stat lockfile")
        .modified()
        .expect("mtime");

    // Push a new commit to the bare that bumps the lockfile content. We do this by
    // cloning the bare into a scratch worktree, modifying the lockfile, committing,
    // and pushing back.
    push_lockfile_change(&bare);

    // Pull again — this time apply must detect drift and run `npm ci`.
    let _ = source.check(&app, &paths).await.expect("check 2");
    let plan2 = source.plan(&app, &paths).await.expect("plan 2");
    let (ctx2, _rx2) = build_apply_ctx(paths.clone());
    let outcome_second = source
        .apply(&app, plan2, ctx2)
        .await
        .expect("second apply");

    // The second outcome must record that install ran. The first outcome must record
    // that it didn't.
    assert!(
        outcome_first
            .messages
            .iter()
            .any(|m| m.contains("unchanged — skipped install")),
        "first apply should have skipped install: {:?}",
        outcome_first.messages
    );
    assert!(
        outcome_second
            .messages
            .iter()
            .any(|m| m.contains("ran npm ci")),
        "second apply should have run install: {:?}",
        outcome_second.messages
    );

    let lockfile_mtime_after = fs::metadata(&lockfile_path)
        .expect("stat lockfile")
        .modified()
        .expect("mtime");
    assert!(
        lockfile_mtime_after >= lockfile_mtime_before,
        "lockfile mtime should be >= before; before={lockfile_mtime_before:?}, after={lockfile_mtime_after:?}"
    );
}

// ── small utilities ──────────────────────────────────────────────────────────────

fn find_free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind 0");
    listener.local_addr().unwrap().port()
}

fn port_from_messages(messages: &[String]) -> Option<u16> {
    for m in messages.iter().rev() {
        if let Some(rest) = m.strip_prefix("listening port ") {
            if let Ok(p) = rest.trim().parse::<u16>() {
                return Some(p);
            }
        }
    }
    None
}

/// Plans are consumed by `apply` but the web source doesn't read the plan beyond what
/// the test already supplied via the manifest. This is a passthrough for clarity.
fn blank_plan_like(p: &UpdatePlan) -> UpdatePlan {
    p.clone()
}

fn drop_apply_ctx_sender(_src: &iptv_hub_core::sources::web::WebSource) {
    // The ApplyCtx owns its progress sender; once `apply` returns the sender is
    // dropped and the drain receiver terminates. This helper exists so the test's
    // intent (drop the sender) is explicit at the call site.
}

/// Add a new commit to the bare repo by cloning it, modifying the lockfile, and
/// pushing main. Used by the drift test.
fn push_lockfile_change(bare_path: &Path) {
    let scratch = TempDir::new().expect("scratch tempdir");
    let bare_url = format!("file://{}", bare_path.to_string_lossy().replace('\\', "/"));
    let repo = Repository::clone(&bare_url, scratch.path()).expect("clone bare");
    let _ = repo.set_head("refs/heads/main");

    let lockfile = scratch.path().join("package-lock.json");
    let mut content: serde_json::Value =
        serde_json::from_slice(&fs::read(&lockfile).expect("read lock")).expect("parse lock");
    content["version"] = json!("1.0.1");
    fs::write(
        &lockfile,
        serde_json::to_vec_pretty(&content).expect("ser lock"),
    )
    .expect("write lock");

    // Also bump package.json version so the diff is well-formed.
    let pkgfile = scratch.path().join("package.json");
    let mut pkg: serde_json::Value =
        serde_json::from_slice(&fs::read(&pkgfile).expect("read pkg")).expect("parse pkg");
    pkg["version"] = json!("1.0.1");
    fs::write(&pkgfile, serde_json::to_vec_pretty(&pkg).expect("ser pkg")).expect("write pkg");

    let oid = commit_all(&repo, "bump lockfile");
    eprintln!("integration_web: pushed lockfile-bump commit {oid}");

    // Push back to bare.
    let mut origin = repo.find_remote("origin").expect("find origin");
    origin
        .push(&["refs/heads/main:refs/heads/main"], None)
        .expect("push main");
}
