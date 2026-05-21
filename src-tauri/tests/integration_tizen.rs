//! Integration tests for the `tizen-ipk` source.
//!
//! These tests exercise the real `TizenSource::apply` code path against:
//!   * A real local hyper HTTP server serving canned GitHub release JSON + asset bytes.
//!   * A real fixture `sdb` executable on PATH (`tests/fixtures/bin/sdb[.cmd]`) that
//!     mimics device probing and `install` behaviour with realistic stdout/stderr/exit
//!     codes. This is the explicit hardware exception in CONTRACT.md §2.2 — real
//!     Samsung TVs are not available in CI.
//!
//! No mocking of the source itself: every byte downloaded goes through the real
//! `reqwest` client; every sha-256 verification goes through the real `sha2` crate;
//! every `sdb` invocation goes through `tokio::process::Command`. The fixture only
//! replaces the *target* of the spawn (a real binary), per the contract.

#![allow(
    clippy::missing_panics_doc,
    clippy::missing_const_for_fn,
    clippy::let_underscore_future,
    clippy::default_trait_access,
    clippy::option_if_let_else,
    clippy::uninlined_format_args,
    clippy::await_holding_lock,
    clippy::doc_markdown,
    clippy::unused_async,
    clippy::manual_let_else,
)]

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use iptv_hub_core::errors::CoreError;
use iptv_hub_core::manifest::types::{AppEntry, LaunchKind, LaunchSpec, SourceType};
use iptv_hub_core::sources::{ApplyCtx, Source, UpdatePlan};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const ASSET_BODY: &[u8] = b"PK\x03\x04tizen-ipk-fixture-payload-v1\n";
const ASSET_NAME: &str = "app.ipk";

fn asset_sha256() -> String {
    let mut hasher = Sha256::new();
    hasher.update(ASSET_BODY);
    hex::encode(hasher.finalize())
}

/// A real HTTP fixture server. Spawned per-test on a random port. Holds a shutdown
/// channel so the test can tear it down cleanly.
struct FixtureServer {
    addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    handle: tokio::task::JoinHandle<()>,
}

impl FixtureServer {
    async fn start(include_digest: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind random port");
        let addr = listener.local_addr().expect("local addr");
        let (tx, mut rx) = oneshot::channel::<()>();
        let include_digest_arc = Arc::new(include_digest);
        let addr_arc = Arc::new(addr);
        let handle = tokio::spawn(async move {
            loop {
                let conn = tokio::select! {
                    _ = &mut rx => break,
                    res = listener.accept() => res,
                };
                let (stream, _peer) = match conn {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let io = TokioIo::new(stream);
                let include = Arc::clone(&include_digest_arc);
                let addr2 = Arc::clone(&addr_arc);
                tokio::spawn(async move {
                    let svc =
                        service_fn(move |req: Request<hyper::body::Incoming>| {
                            let include = Arc::clone(&include);
                            let addr2 = Arc::clone(&addr2);
                            async move { handle_request(req, &include, &addr2).await }
                        });
                    let _ = http1::Builder::new().serve_connection(io, svc).await;
                });
            }
        });
        Self {
            addr,
            shutdown: Some(tx),
            handle,
        }
    }

    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = self.handle.await;
    }
}

async fn handle_request(
    req: Request<hyper::body::Incoming>,
    include_digest: &bool,
    server_addr: &SocketAddr,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = req.uri().path().to_string();
    if path.ends_with("/releases/latest") {
        let download_url = format!("http://{server_addr}/download/{ASSET_NAME}");
        let mut asset = json!({
            "name": ASSET_NAME,
            "browser_download_url": download_url,
            "size": ASSET_BODY.len(),
        });
        if *include_digest {
            asset
                .as_object_mut()
                .unwrap()
                .insert("digest".to_string(), json!(format!("sha256:{}", asset_sha256())));
        }
        let body = json!({
            "tag_name": "v1.2.3",
            "body": "Release notes for v1.2.3.\nFixes the channel list crash.",
            "assets": [asset],
        });
        let json_bytes = serde_json::to_vec(&body).expect("serialize");
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(json_bytes)))
            .unwrap());
    }
    if path.starts_with("/download/") {
        if req.method() == hyper::Method::HEAD {
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/vnd.tizen.ipk")
                .header("content-length", ASSET_BODY.len().to_string());
            if *include_digest {
                builder = builder.header("digest", format!("sha-256={}", asset_sha256()));
            }
            return Ok(builder.body(Full::new(Bytes::new())).unwrap());
        }
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/vnd.tizen.ipk")
            .header("content-length", ASSET_BODY.len().to_string())
            .body(Full::new(Bytes::from(ASSET_BODY)))
            .unwrap());
    }
    Ok(Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Full::new(Bytes::from_static(b"not found")))
        .unwrap())
}

/// Build the AppEntry the source consumes. The `source` JSON shape matches MANIFEST_SCHEMA §8.5.
fn app_for_github_release(repo: &str) -> AppEntry {
    AppEntry {
        id: "tizen-fixture".to_string(),
        name: "Tizen Fixture".to_string(),
        source_type: SourceType::TizenIpk,
        favorite: false,
        enabled: true,
        icon: None,
        polling: None,
        launch: LaunchSpec {
            kind: LaunchKind::TizenDeploy,
            cwd: None,
            command: None,
            args: vec![],
            env: std::collections::HashMap::new(),
            wait_for: None,
        },
        health: None,
        source: Some(json!({
            "source_kind": "github-release",
            "repo": repo,
            "asset_pattern": r".*\.ipk$",
            "device_serial": null,
            "version_strategy": "semver"
        })),
        user_data: None,
    }
}

fn app_for_direct_url(download_url: &str) -> AppEntry {
    AppEntry {
        id: "tizen-fixture-url".to_string(),
        name: "Tizen Fixture URL".to_string(),
        source_type: SourceType::TizenIpk,
        favorite: false,
        enabled: true,
        icon: None,
        polling: None,
        launch: LaunchSpec {
            kind: LaunchKind::TizenDeploy,
            cwd: None,
            command: None,
            args: vec![],
            env: std::collections::HashMap::new(),
            wait_for: None,
        },
        health: None,
        source: Some(json!({
            "source_kind": "url",
            "download_url": download_url,
            "device_serial": null,
            "version_strategy": "semver"
        })),
        user_data: None,
    }
}

/// Build an AppPaths-shaped tempdir tree. AppPaths is constructed via tauri normally;
/// integration tests use the `for_tests` constructor exposed for this purpose.
fn make_paths(tmp: &TempDir) -> iptv_hub_core::paths::AppPaths {
    iptv_hub_core::paths::AppPaths::for_tests(tmp.path())
}

/// Create an ApplyCtx with a dummy progress channel.
fn make_ctx(paths: iptv_hub_core::paths::AppPaths) -> (ApplyCtx, tokio::sync::mpsc::Receiver<iptv_hub_core::sources::ProgressEvent>) {
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

/// Build a UpdatePlan placeholder; the tizen source ignores it during apply.
fn dummy_plan(app_id: &str) -> UpdatePlan {
    UpdatePlan {
        app_id: app_id.to_string(),
        source_type: SourceType::TizenIpk,
        from_label: "current".to_string(),
        to_label: "v1.2.3".to_string(),
        from_meta: vec![],
        to_meta: vec![],
        incoming: vec![],
        steps: vec![],
        rollback_retention_days: 7,
    }
}

/// Guard that adds `fixture/bin/` to PATH and restores the original PATH on Drop.
/// Also sets `IPTV_HUB_TEST_SDB_MODE` and removes it on Drop.
struct PathGuard {
    original_path: Option<String>,
    original_mode: Option<String>,
}

impl PathGuard {
    fn install(mode: &str) -> Self {
        let original_path = std::env::var("PATH").ok();
        let original_mode = std::env::var("IPTV_HUB_TEST_SDB_MODE").ok();
        let fixture_bin = fixture_bin_dir();
        let sep = if cfg!(windows) { ";" } else { ":" };
        let new_path = match &original_path {
            Some(p) => format!("{}{sep}{p}", fixture_bin.display()),
            None => fixture_bin.display().to_string(),
        };
        // SAFETY: tests are single-threaded by mutex below.
        std::env::set_var("PATH", new_path);
        std::env::set_var("IPTV_HUB_TEST_SDB_MODE", mode);
        Self {
            original_path,
            original_mode,
        }
    }
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        if let Some(p) = self.original_path.take() {
            std::env::set_var("PATH", p);
        } else {
            std::env::remove_var("PATH");
        }
        if let Some(m) = self.original_mode.take() {
            std::env::set_var("IPTV_HUB_TEST_SDB_MODE", m);
        } else {
            std::env::remove_var("IPTV_HUB_TEST_SDB_MODE");
        }
    }
}

fn fixture_bin_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR points to src-tauri/; fixture is at workspace_root/tests/fixtures/bin.
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = crate_dir.parent().unwrap();
    workspace_root.join("tests").join("fixtures").join("bin")
}

/// Tests mutate the process-wide PATH and environment. Serialize them.
static ENV_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn set_github_base(url: &str) -> EnvGuard {
    let original = std::env::var("IPTV_HUB_TIZEN_GITHUB_API_BASE").ok();
    std::env::set_var("IPTV_HUB_TIZEN_GITHUB_API_BASE", url);
    EnvGuard {
        key: "IPTV_HUB_TIZEN_GITHUB_API_BASE",
        original,
    }
}

struct EnvGuard {
    key: &'static str,
    original: Option<String>,
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(v) = self.original.take() {
            std::env::set_var(self.key, v);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fetch_via_github_release_verifies_sha() {
    let _lock = ENV_LOCK.lock();
    let _path_guard = PathGuard::install("ok");
    let tmp = TempDir::new().expect("tempdir");
    let server = FixtureServer::start(true).await; // include digest
    let _api_guard = set_github_base(&server.base_url());

    let app = app_for_github_release("owner/repo");
    let paths = make_paths(&tmp);
    let (ctx, _rx) = make_ctx(paths);

    let source = iptv_hub_core::sources::tizen::TizenSource::new();
    let outcome = source
        .apply(&app, dummy_plan(&app.id), ctx)
        .await
        .expect("apply should succeed when sha matches");

    assert_eq!(outcome.new_version.as_deref(), Some("v1.2.3"));
    assert_eq!(
        outcome.bytes_downloaded,
        u64::try_from(ASSET_BODY.len()).expect("len fits in u64")
    );
    let expected_sha = asset_sha256();
    assert!(
        outcome.messages.iter().any(|m| m.contains(&expected_sha)),
        "expected sha verification message in: {:?}",
        outcome.messages
    );
    // Verify the IPK landed in the cache under its sha.
    let ipk_dir = tmp
        .path()
        .join("apps")
        .join("cache")
        .join("installers")
        .join(&app.id);
    let ipk_path = ipk_dir.join(format!("{expected_sha}.ipk"));
    assert!(ipk_path.exists(), "ipk should be cached at {}", ipk_path.display());
    let bytes = tokio::fs::read(&ipk_path).await.expect("read cached ipk");
    assert_eq!(bytes, ASSET_BODY, "cached file should match served body");

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fetch_via_direct_url_verifies_sha() {
    let _lock = ENV_LOCK.lock();
    let _path_guard = PathGuard::install("ok");
    let tmp = TempDir::new().expect("tempdir");
    let server = FixtureServer::start(true).await;
    let url = format!("{}/download/{}", server.base_url(), ASSET_NAME);

    let app = app_for_direct_url(&url);
    let paths = make_paths(&tmp);
    let (ctx, _rx) = make_ctx(paths);

    let source = iptv_hub_core::sources::tizen::TizenSource::new();
    let outcome = source
        .apply(&app, dummy_plan(&app.id), ctx)
        .await
        .expect("apply via url should succeed");

    assert_eq!(
        outcome.bytes_downloaded,
        u64::try_from(ASSET_BODY.len()).expect("len fits in u64")
    );
    let expected_sha = asset_sha256();
    assert!(
        outcome.messages.iter().any(|m| m.contains("sha256 verified")),
        "expected sha256 verified message in: {:?}",
        outcome.messages
    );
    let cached = tmp
        .path()
        .join("apps")
        .join("cache")
        .join("installers")
        .join(&app.id)
        .join(format!("{expected_sha}.ipk"));
    assert!(cached.exists(), "ipk should be cached at {}", cached.display());

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_happy_path() {
    let _lock = ENV_LOCK.lock();
    let _path_guard = PathGuard::install("ok");
    let tmp = TempDir::new().expect("tempdir");
    let server = FixtureServer::start(true).await;
    let _api_guard = set_github_base(&server.base_url());

    let app = app_for_github_release("owner/repo");
    let paths = make_paths(&tmp);
    let (ctx, _rx) = make_ctx(paths);

    let source = iptv_hub_core::sources::tizen::TizenSource::new();
    let outcome = source
        .apply(&app, dummy_plan(&app.id), ctx)
        .await
        .expect("deploy happy path should succeed");

    // The fixture sdb shim prints "Installed <path>" on success; the source records the
    // full sdb invocation evidence in UpdateOutcome.messages.
    assert!(
        outcome
            .messages
            .iter()
            .any(|m| m.contains("sdb install invocation")),
        "expected sdb install invocation evidence in: {:?}",
        outcome.messages
    );
    assert!(
        outcome
            .messages
            .iter()
            .any(|m| m.contains("paired device")),
        "expected paired-device probe evidence in: {:?}",
        outcome.messages
    );
    assert!(
        outcome
            .messages
            .iter()
            .any(|m| m.contains("sdb stdout: Installed")),
        "expected sdb stdout 'Installed' line in: {:?}",
        outcome.messages
    );

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_no_devices() {
    let _lock = ENV_LOCK.lock();
    let _path_guard = PathGuard::install("no-devices");
    let tmp = TempDir::new().expect("tempdir");
    let server = FixtureServer::start(true).await;
    let _api_guard = set_github_base(&server.base_url());

    let app = app_for_github_release("owner/repo");
    let paths = make_paths(&tmp);
    let (ctx, _rx) = make_ctx(paths);

    let source = iptv_hub_core::sources::tizen::TizenSource::new();
    let err = source
        .apply(&app, dummy_plan(&app.id), ctx)
        .await
        .expect_err("deploy should fail when no devices paired");

    match err {
        CoreError::NotSupported { ref message } => {
            assert!(
                message.contains("no Samsung TV detected"),
                "unexpected error message: {message}"
            );
        }
        other => panic!("expected NotSupported, got {other:?}"),
    }

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_install_failure() {
    let _lock = ENV_LOCK.lock();
    let _path_guard = PathGuard::install("install-fail");
    let tmp = TempDir::new().expect("tempdir");
    let server = FixtureServer::start(true).await;
    let _api_guard = set_github_base(&server.base_url());

    let app = app_for_github_release("owner/repo");
    let paths = make_paths(&tmp);
    let (ctx, _rx) = make_ctx(paths);

    let source = iptv_hub_core::sources::tizen::TizenSource::new();
    let err = source
        .apply(&app, dummy_plan(&app.id), ctx)
        .await
        .expect_err("deploy should propagate sdb install failure");

    match err {
        CoreError::Internal { ref message } => {
            assert!(
                message.contains("install failed: corrupted ipk")
                    || message.contains("sdb install failed"),
                "expected install failure detail; got: {message}"
            );
        }
        other => panic!("expected Internal, got {other:?}"),
    }

    server.stop().await;
}
