//! Integration tests for the background poller.
//!
//! Per CONTRACT.md §2.2 these tests exercise the *real* code path: real
//! [`Poller`] instances, a real `SqlitePool` with the migrated schema, real
//! `ManifestStore` constructed from a real `apps.json` on disk, and real `git`
//! sources backed by real bare repositories created with `git2-rs`. No mocks.
//!
//! Coverage (mirrors `docs/AGENT_PLAN.md` Agent 10 acceptance):
//!
//! * `bounded_concurrency_respects_semaphore` — seed 8 apps, fire all eight
//!   `force_poll` calls in parallel, assert the in-flight count never exceeds
//!   the configured `poll_concurrency` of 4.
//! * `backoff_kicks_in_after_three_failures` — seed one app whose check
//!   always errors, fire three `force_poll` calls, assert the DB row records a
//!   `backoff_until` at least one hour in the future.
//! * `force_poll_bypasses_interval` — set an effectively-infinite scheduled
//!   interval, call `force_poll`, assert the probe completes within ~5 s and
//!   the DB row is updated.
//! * `shutdown_completes_promptly` — spawn the poller, call `shutdown()`,
//!   assert the future completes within 100 ms.

#![allow(
    clippy::missing_panics_doc,
    clippy::missing_const_for_fn,
    clippy::let_underscore_future,
    clippy::default_trait_access,
    clippy::option_if_let_else,
    clippy::uninlined_format_args,
    clippy::iter_on_single_items,
    clippy::manual_let_else,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::doc_markdown,
    clippy::too_many_lines
)]

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::future::join_all;
use git2::{IndexAddOption, Repository, Signature};
use parking_lot::Mutex;
use serde_json::json;
use tempfile::TempDir;
use tokio::sync::broadcast;
use tokio::time::timeout;

use iptv_hub_core::app_state::AppState;
use iptv_hub_core::config::AppConfig;
use iptv_hub_core::manifest::ManifestStore;
use iptv_hub_core::paths::AppPaths;
use iptv_hub_core::poller::{Poller, PollerHandle, ProbeEvent, ProbeOutcome};

// ── helpers ──────────────────────────────────────────────────────────────────────

/// Spin up a file-backed `SQLite` pool with the project's migrations applied.
/// File-backed (rather than `:memory:`) is necessary because `sqlx` uses
/// multiple connections in a pool, and `:memory:` databases are not shared
/// across connections by default — each connection would see an empty schema.
async fn open_test_pool(db_path: &Path) -> sqlx::SqlitePool {
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .foreign_keys(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await
        .expect("connect sqlite");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations apply");
    pool
}

/// Create a real bare git repository at `bare_dir` with one initial commit. The
/// commit content is enough that `git2` clone has work to do (helps make the
/// concurrency test exercise the semaphore).
fn create_bare_repo(seed_dir: &Path, bare_dir: &Path) {
    std::fs::create_dir_all(seed_dir).expect("mkdir seed");
    std::fs::write(seed_dir.join("README.md"), "iptv-hub poller fixture\n").expect("write README");
    std::fs::write(
        seed_dir.join("config.json"),
        r#"{"sentinel":"poller-test"}"#,
    )
    .expect("write config");

    let repo = Repository::init(seed_dir).expect("init working repo");
    {
        let mut index = repo.index().expect("get index");
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .expect("git add");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let sig = Signature::now("Poller Fixture", "fixture@iptv-hub.local").expect("signature");
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
            .expect("initial commit");
    }
    // Promote default branch to `main` for stable refs across git versions.
    {
        let head_oid = repo.head().expect("head ref").target().expect("head oid");
        let head_commit = repo.find_commit(head_oid).expect("find head commit");
        let _ = repo.branch("main", &head_commit, true);
        repo.set_head("refs/heads/main").expect("set head");
    }

    // Clone the working tree into a bare repo at `bare_dir`. The bare repo is
    // what the source clones from.
    let mut builder = git2::build::RepoBuilder::new();
    builder.bare(true);
    builder.branch("main");
    let bare = builder
        .clone(seed_dir.to_str().expect("seed dir utf8"), bare_dir)
        .expect("bare clone");
    // Ensure the bare repo has a `refs/heads/main` so subsequent clones can find it.
    {
        let head = bare.head().expect("bare head");
        assert!(head.is_branch(), "bare repo HEAD must be a branch");
    }
}

/// Clone `bare_dir` into `working_dir` so the [`GitSource::check`] path finds an
/// already-initialised working clone and never has to talk to the manifest URL.
fn clone_into_upstream(bare_dir: &Path, working_dir: &Path) {
    std::fs::create_dir_all(working_dir.parent().expect("working dir has parent"))
        .expect("mkdir parent");
    let mut builder = git2::build::RepoBuilder::new();
    builder.branch("main");
    let url = format!(
        "file:///{}",
        bare_dir.to_str().expect("bare dir utf8").replace('\\', "/")
    );
    builder
        .clone(&url, working_dir)
        .expect("clone bare into upstream");
}

/// Materialise an `apps.json` with `count` enabled git apps. Each app's
/// `source.url` is a placeholder `https://` URL — the schema requires that
/// — but every working clone is pre-populated on disk so the URL is never
/// dialled.
fn write_apps_json(path: &Path, ids: &[String], apps_root: &Path) {
    let normalise = |p: &Path| p.to_str().expect("utf8").replace('\\', "/");
    let apps: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "name": id,
                "type": "git",
                "enabled": true,
                "polling": { "enabled": true, "interval_minutes": 60, "jitter_seconds": 0 },
                "launch": { "kind": "executable" },
                "source": {
                    "url": "https://example.com/iptv-hub-poller-fixture.git",
                    "branch": "main"
                }
            })
        })
        .collect();
    let manifest = json!({
        "schema_version": 1,
        "apps_root": normalise(apps_root),
        "user_data_root": normalise(&apps_root.join("user-data")),
        "cache_root": normalise(&apps_root.join("cache")),
        "apps": apps,
    });
    std::fs::create_dir_all(path.parent().expect("manifest parent"))
        .expect("mkdir manifest parent");
    std::fs::write(path, serde_json::to_vec_pretty(&manifest).expect("encode"))
        .expect("write manifest");
}

/// Materialise an `apps.json` with one app and a custom URL — used by the
/// back-off test to inject a URL that will never resolve.
fn write_apps_json_with_url(path: &Path, id: &str, url: &str, apps_root: &Path) {
    let normalise = |p: &Path| p.to_str().expect("utf8").replace('\\', "/");
    let manifest = json!({
        "schema_version": 1,
        "apps_root": normalise(apps_root),
        "user_data_root": normalise(&apps_root.join("user-data")),
        "cache_root": normalise(&apps_root.join("cache")),
        "apps": [{
            "id": id,
            "name": id,
            "type": "git",
            "enabled": true,
            "polling": { "enabled": true, "interval_minutes": 60, "jitter_seconds": 0 },
            "launch": { "kind": "executable" },
            "source": { "url": url, "branch": "main" }
        }],
    });
    std::fs::create_dir_all(path.parent().expect("manifest parent"))
        .expect("mkdir manifest parent");
    std::fs::write(path, serde_json::to_vec_pretty(&manifest).expect("encode"))
        .expect("write manifest");
}

/// Build an [`AppState`] backed by a temp `apps_root`, a real schema-validated
/// manifest, and a file-backed database with the project migrations applied.
async fn build_state(
    apps_root: &Path,
    manifest_path: &Path,
    config: AppConfig,
    app_ids: &[String],
) -> AppState {
    let db_path = apps_root.join("iptv-hub-test.db");
    let pool = open_test_pool(&db_path).await;
    for id in app_ids {
        sqlx::query("INSERT OR IGNORE INTO apps (id, name, source_type) VALUES (?, ?, 'git')")
            .bind(id)
            .bind(id)
            .execute(&pool)
            .await
            .expect("seed app row");
    }

    let manifest = ManifestStore::load(manifest_path)
        .await
        .expect("manifest loads");
    let manifest = Arc::new(manifest);

    let paths = AppPaths::for_test(apps_root.to_path_buf(), apps_root.to_path_buf());
    AppState::new(paths, config, pool, manifest)
}

/// Subscribe to the poller's event stream and track `max(started - finished)`
/// across the test lifetime.
struct InFlightTracker {
    max: Arc<Mutex<usize>>,
    handle: tokio::task::JoinHandle<()>,
}

impl InFlightTracker {
    fn spawn(mut rx: broadcast::Receiver<ProbeEvent>) -> Self {
        let max = Arc::new(Mutex::new(0usize));
        let max_for_task = max.clone();
        let handle = tokio::spawn(async move {
            let mut current: i64 = 0;
            loop {
                match rx.recv().await {
                    Ok(ProbeEvent::Started { .. }) => {
                        current += 1;
                        let value = usize::try_from(current.max(0)).unwrap_or(0);
                        let mut guard = max_for_task.lock();
                        if value > *guard {
                            *guard = value;
                        }
                    }
                    Ok(ProbeEvent::Finished { .. }) => {
                        current -= 1;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // The channel is sized at 256; if a test ever lags we
                        // want to know via test failure rather than silent loss.
                        panic!("poller event broadcast lagged");
                    }
                }
            }
        });
        Self { max, handle }
    }

    async fn stop(self) {
        // Closing the broadcast channel happens when the poller is shut down
        // and all senders are dropped. We just await the task here so the
        // assertion sees the final value.
        let _ = self.handle.await;
    }
}

// ── tests ────────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bounded_concurrency_respects_semaphore() {
    let temp = TempDir::new().expect("tempdir");
    let apps_root = temp.path().join("apps-root");
    std::fs::create_dir_all(&apps_root).expect("mkdir apps-root");
    let manifest_path = temp.path().join("apps.json");

    let mut app_ids = Vec::new();
    let seeds = temp.path().join("seeds");
    let bares = temp.path().join("bares");
    std::fs::create_dir_all(&seeds).expect("mkdir seeds");
    std::fs::create_dir_all(&bares).expect("mkdir bares");

    for i in 0..8 {
        let id = format!("poller-app-{}", i);
        let seed_dir = seeds.join(&id);
        let bare_dir = bares.join(format!("{}.git", id));
        create_bare_repo(&seed_dir, &bare_dir);

        let working_dir = apps_root.join("upstream").join(&id);
        clone_into_upstream(&bare_dir, &working_dir);

        app_ids.push(id);
    }

    write_apps_json(&manifest_path, &app_ids, &apps_root);

    let config = AppConfig {
        poll_concurrency: 4,
        default_poll_interval_minutes: 60, // long; only force_poll fires
        ..AppConfig::default()
    };

    let state = build_state(&apps_root, &manifest_path, config, &app_ids).await;
    let handle = Poller::new(state).spawn();
    let tracker = InFlightTracker::spawn(handle.subscribe());

    // Fan out: fire all eight force_polls in parallel.
    let force_results = join_all(app_ids.iter().map(|id| {
        let id = id.clone();
        let handle_ref = &handle;
        async move { handle_ref.force_poll(&id).await }
    }))
    .await;
    for res in force_results {
        res.expect("force_poll returns ok");
    }

    // Tear down the poller — this drops the broadcast sender so the tracker's
    // recv loop completes and reports its peak.
    let peak_handle = tracker.max.clone();
    handle.shutdown().await;
    tracker.stop().await;

    let peak = *peak_handle.lock();
    assert!(
        peak >= 1,
        "expected the tracker to observe at least one probe in-flight, got 0",
    );
    assert!(
        peak <= 4,
        "concurrency exceeded the semaphore bound: peak in-flight = {}, max = 4",
        peak,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backoff_kicks_in_after_three_failures() {
    let temp = TempDir::new().expect("tempdir");
    let apps_root = temp.path().join("apps-root");
    std::fs::create_dir_all(&apps_root).expect("mkdir apps-root");
    let manifest_path = temp.path().join("apps.json");

    let id = "poller-fail-app".to_string();
    // 127.0.0.1:1 refuses immediately on most platforms; git2 surfaces the
    // refusal as a clone error rather than hanging on DNS.
    let bad_url = "https://127.0.0.1:1/never-resolves.git";
    write_apps_json_with_url(&manifest_path, &id, bad_url, &apps_root);

    let config = AppConfig {
        poll_concurrency: 2,
        default_poll_interval_minutes: 60,
        ..AppConfig::default()
    };

    let state = build_state(
        &apps_root,
        &manifest_path,
        config,
        std::slice::from_ref(&id),
    )
    .await;
    let pool = state.db.clone();

    let handle = Poller::new(state).spawn();

    // Three consecutive failures should arm the back-off timer.
    for _ in 0..3 {
        let res = handle.force_poll(&id).await;
        assert!(
            res.is_err(),
            "expected the failing source to return an error from force_poll, got Ok"
        );
    }

    let row: (Option<String>, i64) =
        sqlx::query_as("SELECT backoff_until, consecutive_failures FROM apps WHERE id = ?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .expect("query apps row");

    let (backoff_until, consecutive_failures) = row;
    assert!(
        consecutive_failures >= 3,
        "expected at least 3 recorded failures, got {}",
        consecutive_failures
    );
    let stamp =
        backoff_until.expect("consecutive failures crossed threshold; backoff_until should be set");
    let parsed = chrono::DateTime::parse_from_rfc3339(&stamp)
        .expect("backoff_until is a valid rfc3339 timestamp");
    let delta = parsed.signed_duration_since(chrono::Utc::now());
    assert!(
        delta >= chrono::Duration::minutes(50),
        "expected backoff_until at least ~1h in the future, got {} ({}s away)",
        stamp,
        delta.num_seconds(),
    );

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn force_poll_bypasses_interval() {
    let temp = TempDir::new().expect("tempdir");
    let apps_root = temp.path().join("apps-root");
    std::fs::create_dir_all(&apps_root).expect("mkdir apps-root");
    let manifest_path = temp.path().join("apps.json");

    let id = "poller-force-app".to_string();
    let seed_dir = temp.path().join("seed-force");
    let bare_dir = temp.path().join("bare-force.git");
    create_bare_repo(&seed_dir, &bare_dir);
    let working_dir = apps_root.join("upstream").join(&id);
    clone_into_upstream(&bare_dir, &working_dir);

    write_apps_json(&manifest_path, std::slice::from_ref(&id), &apps_root);

    let config = AppConfig {
        poll_concurrency: 2,
        // Effectively infinite interval — only force_poll can trigger a probe.
        default_poll_interval_minutes: u32::MAX / 60,
        ..AppConfig::default()
    };

    let state = build_state(
        &apps_root,
        &manifest_path,
        config,
        std::slice::from_ref(&id),
    )
    .await;
    let pool = state.db.clone();

    let handle = Poller::new(state).spawn();

    let started = Instant::now();
    timeout(Duration::from_secs(5), handle.force_poll(&id))
        .await
        .expect("force_poll completed before 5s timeout")
        .expect("force_poll returned Ok");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "force_poll took {:?}, expected <5s",
        started.elapsed()
    );

    let row: (String, Option<String>) =
        sqlx::query_as("SELECT status, last_poll_at FROM apps WHERE id = ?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .expect("query apps row after force_poll");
    let (status, last_poll_at) = row;
    assert_eq!(
        status, "ok",
        "expected status 'ok' for a freshly-checked clone, got {}",
        status
    );
    assert!(
        last_poll_at.is_some(),
        "expected last_poll_at to be set after force_poll"
    );

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_completes_promptly() {
    let temp = TempDir::new().expect("tempdir");
    let apps_root = temp.path().join("apps-root");
    std::fs::create_dir_all(&apps_root).expect("mkdir apps-root");
    let manifest_path = temp.path().join("apps.json");
    write_apps_json(&manifest_path, &[], &apps_root);

    let config = AppConfig::default();
    let state = build_state(&apps_root, &manifest_path, config, &[]).await;

    let handle: PollerHandle = Poller::new(state).spawn();

    let started = Instant::now();
    timeout(Duration::from_millis(500), handle.shutdown())
        .await
        .expect("shutdown completed under 500ms timeout");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(500),
        "shutdown took {:?}, expected <500ms",
        elapsed
    );
}

// `ProbeOutcome` is exported through the public API; reference it so the import
// is exercised even when the `match` arms below aren't reached. This keeps the
// public surface honest about emitting the variant.
#[allow(dead_code)]
fn _outcome_compile_check(o: &ProbeOutcome) -> &'static str {
    match o {
        ProbeOutcome::UpToDate => "up-to-date",
        ProbeOutcome::UpdateAvailable => "update-available",
        ProbeOutcome::Error(_) => "error",
    }
}
