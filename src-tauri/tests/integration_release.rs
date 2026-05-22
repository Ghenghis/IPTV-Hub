//! Integration tests for the `release-binary` source.
//!
//! Per CONTRACT.md §2.2: **no mock-only test strategy**. These tests stand up a real
//! `hyper` HTTP server on `127.0.0.1:0`, serve real release JSON and real binary asset
//! bytes, and drive the [`ReleaseSource`] through `check`, `plan`, and `apply` against
//! that server. No mocking of `reqwest`; no canned responses inside the source. The
//! only "fake" is the server itself — which is real code we control end to end.
//!
//! Coverage:
//!   * `happy_path_check_plan_apply`         — check → plan → apply → outcome.
//!   * `sha256_mismatch_refuses`             — published digest disagrees with body bytes.
//!   * `asset_pattern_mismatch_returns_error`— no asset matches the pattern.
//!   * `network_drop_resumes_with_range`     — server truncates first attempt; retry sends `Range:`.
//!   * `rate_limit_response_mapped_clearly`  — 403 + `X-RateLimit-Remaining: 0` → `CoreError::Network`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use iptv_hub_core::errors::CoreError;
use iptv_hub_core::manifest::types::{AppEntry, LaunchKind, LaunchSpec, SourceType};
use iptv_hub_core::sources::release::{InstallStrategy, ReleaseSource};
use iptv_hub_core::sources::{ApplyCtx, Source, UpdatePlan, UpdateState};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// Behaviour switch for the fixture server: how does it respond to the asset request?
#[derive(Debug, Clone, Copy)]
enum AssetBehaviour {
    /// Serve the whole body on every request.
    Normal,
    /// On the first request, drop the connection after N bytes; on later requests, honour
    /// `Range:` headers and return 206 Partial Content.
    TruncateThenResume { first_bytes: usize },
}

#[derive(Debug, Clone, Copy)]
enum MetaBehaviour {
    /// Return the canned release JSON.
    Normal,
    /// Return 403 + `X-RateLimit-Remaining: 0`.
    RateLimited,
    /// Return the canned release JSON but no asset matching the pattern.
    NoMatchingAsset,
}

struct FixtureConfig {
    asset_bytes: Vec<u8>,
    asset_name: String,
    tag_name: String,
    /// SHA-256 the server *publishes*. May intentionally differ from the body bytes for
    /// the corruption test.
    published_sha: Option<String>,
    asset_behaviour: AssetBehaviour,
    meta_behaviour: MetaBehaviour,
}

/// Spawn the fixture server and return its base URL plus a counter of asset hits.
async fn spawn_fixture(cfg: FixtureConfig) -> (String, Arc<AssetHitCounter>) {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("bind 127.0.0.1:0");
    let addr = listener.local_addr().expect("local_addr");
    let base = format!("http://{addr}");

    let counter = Arc::new(AssetHitCounter::default());
    let state = Arc::new(FixtureState {
        cfg,
        base: base.clone(),
        hits: counter.clone(),
    });

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let state = state.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let service = service_fn(move |req| {
                    let state = state.clone();
                    async move { handle(state, req).await }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, service)
                    .await;
            });
        }
    });

    // Tiny readiness sleep — bind() returned, but spawned task may not have polled yet.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    (base, counter)
}

#[derive(Default)]
struct AssetHitCounter {
    count: AtomicUsize,
    range_headers: parking_lot::Mutex<Vec<String>>,
}

impl AssetHitCounter {
    fn hits(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
    fn range_headers(&self) -> Vec<String> {
        self.range_headers.lock().clone()
    }
}

struct FixtureState {
    cfg: FixtureConfig,
    base: String,
    hits: Arc<AssetHitCounter>,
}

#[allow(clippy::unused_async)] // signature required by hyper::service::service_fn
async fn handle(
    state: Arc<FixtureState>,
    req: Request<hyper::body::Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = req.uri().path().to_string();
    if path.ends_with("/releases/latest") {
        return Ok(meta_response(&state));
    }
    if path.starts_with("/asset/") {
        let range = req
            .headers()
            .get(hyper::header::RANGE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        state
            .hits
            .range_headers
            .lock()
            .push(range.clone().unwrap_or_default());
        state.hits.count.fetch_add(1, Ordering::SeqCst);
        return Ok(asset_response(&state, range.as_deref()));
    }
    Ok(Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Full::new(Bytes::from_static(b"not found")))
        .unwrap())
}

fn meta_response(state: &FixtureState) -> Response<Full<Bytes>> {
    match state.cfg.meta_behaviour {
        MetaBehaviour::RateLimited => Response::builder()
            .status(StatusCode::FORBIDDEN)
            .header("X-RateLimit-Remaining", "0")
            .header("X-RateLimit-Reset", "9999999999")
            .body(Full::new(Bytes::from_static(b"rate limited")))
            .unwrap(),
        MetaBehaviour::NoMatchingAsset => {
            let body = json!({
                "tag_name": state.cfg.tag_name,
                "body": "release notes",
                "assets": [
                    {
                        "name": "totally-different-asset.txt",
                        "browser_download_url": format!("{}/asset/{}", state.base, "totally-different-asset.txt"),
                        "size": 12,
                    }
                ]
            });
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(Full::new(Bytes::from(body.to_string().into_bytes())))
                .unwrap()
        }
        MetaBehaviour::Normal => {
            let mut asset = serde_json::Map::new();
            asset.insert("name".into(), json!(state.cfg.asset_name));
            asset.insert(
                "browser_download_url".into(),
                json!(format!("{}/asset/{}", state.base, state.cfg.asset_name)),
            );
            asset.insert("size".into(), json!(state.cfg.asset_bytes.len() as u64));
            if let Some(sha) = &state.cfg.published_sha {
                asset.insert("sha256".into(), json!(format!("sha256:{sha}")));
            }
            let body = json!({
                "tag_name": state.cfg.tag_name,
                "body": "release notes here",
                "assets": [asset],
            });
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(Full::new(Bytes::from(body.to_string().into_bytes())))
                .unwrap()
        }
    }
}

fn asset_response(state: &FixtureState, range_header: Option<&str>) -> Response<Full<Bytes>> {
    let bytes: &[u8] = &state.cfg.asset_bytes;

    if let AssetBehaviour::TruncateThenResume { first_bytes } = state.cfg.asset_behaviour {
        if state.hits.hits() == 1 {
            // First attempt: return only `first_bytes` of the asset, with a Content-Length
            // matching the truncated body. The client knows `expected_size` from the
            // release JSON, sees `total < expected_size` after the stream ends, and
            // retries with a `Range:` header for the remainder.
            let truncated = bytes.iter().take(first_bytes).copied().collect::<Vec<_>>();
            return Response::builder()
                .status(StatusCode::OK)
                .header("Content-Length", truncated.len().to_string())
                .body(Full::new(Bytes::from(truncated)))
                .unwrap();
        }
    }

    if let Some(rh) = range_header {
        // `bytes=N-` form only — the production source emits exactly this.
        if let Some(start_str) = rh.strip_prefix("bytes=").and_then(|s| s.strip_suffix('-')) {
            if let Ok(start) = start_str.parse::<usize>() {
                let end = bytes.len().saturating_sub(1);
                let slice = &bytes[start..];
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(
                        "Content-Range",
                        format!("bytes {start}-{end}/{}", bytes.len()),
                    )
                    .header("Content-Length", slice.len().to_string())
                    .body(Full::new(Bytes::from(slice.to_vec())))
                    .unwrap();
            }
        }
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Length", bytes.len().to_string())
        .body(Full::new(Bytes::from(bytes.to_vec())))
        .unwrap()
}

/// Build a release asset that looks like a tiny zip with one text file inside.
fn build_zip_asset() -> Vec<u8> {
    use std::io::Write as _;
    let buf = std::io::Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(buf);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("readme.txt", opts).unwrap();
    zip.write_all(b"hello from iptv-hub release source")
        .unwrap();
    let cursor = zip.finish().unwrap();
    cursor.into_inner()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

/// Build a test [`AppEntry`] that points the release source at the fixture server.
fn make_app(
    base_url: &str,
    asset_pattern: &str,
    install_strategy: InstallStrategy,
    install_dir: &std::path::Path,
    sha256_required: bool,
) -> AppEntry {
    AppEntry {
        id: "test-release-app".into(),
        name: "Test Release App".into(),
        source_type: SourceType::ReleaseBinary,
        favorite: false,
        enabled: true,
        icon: None,
        polling: None,
        launch: LaunchSpec {
            kind: LaunchKind::Executable,
            cwd: None,
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            wait_for: None,
        },
        health: None,
        source: Some(json!({
            "repo": "test/owner",
            "asset_pattern": asset_pattern,
            "version_strategy": "semver",
            "sha256_required": sha256_required,
            "install_dir": install_dir.display().to_string(),
            "install_strategy": match install_strategy {
                InstallStrategy::Extract => "extract",
                InstallStrategy::RunInstaller => "run-installer",
                InstallStrategy::Copy => "copy",
            },
            "api_base": base_url,
            "download_base": base_url,
        })),
        user_data: None,
    }
}

fn make_paths(temp: &TempDir) -> iptv_hub_core::paths::AppPaths {
    iptv_hub_core::paths::AppPaths::for_test(
        temp.path().to_path_buf(),
        temp.path().join("apps-root"),
    )
}

fn make_ctx(
    paths: iptv_hub_core::paths::AppPaths,
) -> (
    ApplyCtx,
    mpsc::Receiver<iptv_hub_core::sources::ProgressEvent>,
) {
    let (tx, rx) = mpsc::channel(64);
    let ctx = ApplyCtx {
        paths,
        progress: tx,
        cancel: tokio_util::sync::CancellationToken::new(),
    };
    (ctx, rx)
}

#[tokio::test]
async fn happy_path_check_plan_apply() {
    let asset_bytes = build_zip_asset();
    let digest = sha256_hex(&asset_bytes);
    let (base, hits) = spawn_fixture(FixtureConfig {
        asset_bytes,
        asset_name: "iptv-hub-tiny-v1.0.0.zip".into(),
        tag_name: "v1.0.0".into(),
        published_sha: Some(digest.clone()),
        asset_behaviour: AssetBehaviour::Normal,
        meta_behaviour: MetaBehaviour::Normal,
    })
    .await;

    let temp = TempDir::new().expect("tempdir");
    std::fs::create_dir_all(temp.path().join("apps-root")).unwrap();
    let install_dir = temp.path().join("apps-root").join("install");
    let app = make_app(
        &base,
        r".*\.zip$",
        InstallStrategy::Extract,
        &install_dir,
        true,
    );
    let paths = make_paths(&temp);
    let src = ReleaseSource::new();

    let state = src.check(&app, &paths).await.expect("check ok");
    match state {
        UpdateState::UpdateAvailable { to, .. } => assert_eq!(to, "v1.0.0"),
        other => panic!("expected UpdateAvailable, got {other:?}"),
    }

    let plan: UpdatePlan = src.plan(&app, &paths).await.expect("plan ok");
    assert_eq!(plan.to_label, "v1.0.0");
    assert!(plan
        .steps
        .iter()
        .any(|s| s.title.contains("Verify SHA-256")));

    let (ctx, mut rx) = make_ctx(paths);
    tokio::spawn(async move {
        // Drain progress so the channel never backs up. We only assert it's non-empty
        // below, so this background drain is enough.
        while rx.recv().await.is_some() {}
    });
    let outcome = src.apply(&app, plan, ctx).await.expect("apply ok");
    assert_eq!(outcome.new_version.as_deref(), Some("v1.0.0"));
    assert!(outcome.bytes_downloaded > 0);
    assert!(install_dir.join("readme.txt").exists(), "zip not extracted");
    let contents = std::fs::read_to_string(install_dir.join("readme.txt")).unwrap();
    assert!(contents.contains("hello from iptv-hub"));
    assert!(hits.hits() >= 1);
}

#[tokio::test]
async fn sha256_mismatch_refuses() {
    let real_bytes = build_zip_asset();
    let _real_sha = sha256_hex(&real_bytes);
    let lying_sha = sha256_hex(b"this is not the real body");

    let (base, _hits) = spawn_fixture(FixtureConfig {
        asset_bytes: real_bytes,
        asset_name: "iptv-hub-tiny-v1.0.0.zip".into(),
        tag_name: "v1.0.0".into(),
        published_sha: Some(lying_sha.clone()),
        asset_behaviour: AssetBehaviour::Normal,
        meta_behaviour: MetaBehaviour::Normal,
    })
    .await;

    let temp = TempDir::new().expect("tempdir");
    std::fs::create_dir_all(temp.path().join("apps-root")).unwrap();
    let install_dir = temp.path().join("apps-root").join("install");
    let app = make_app(
        &base,
        r".*\.zip$",
        InstallStrategy::Extract,
        &install_dir,
        true,
    );
    let paths = make_paths(&temp);
    let src = ReleaseSource::new();
    let plan = src.plan(&app, &paths).await.expect("plan ok");

    let (ctx, mut rx) = make_ctx(paths);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let err = src.apply(&app, plan, ctx).await.expect_err("must reject");
    match err {
        CoreError::ShaMismatch { expected, .. } => assert_eq!(expected, lying_sha),
        other => panic!("expected ShaMismatch, got {other:?}"),
    }
    assert!(
        !install_dir.exists()
            || std::fs::read_dir(&install_dir)
                .map(std::iter::Iterator::count)
                .unwrap_or(0)
                == 0,
        "install_dir must not be touched on hash mismatch"
    );
}

#[tokio::test]
async fn asset_pattern_mismatch_returns_error() {
    let asset_bytes = build_zip_asset();
    let digest = sha256_hex(&asset_bytes);
    let (base, _hits) = spawn_fixture(FixtureConfig {
        asset_bytes,
        asset_name: "ignored.zip".into(),
        tag_name: "v1.0.0".into(),
        published_sha: Some(digest),
        asset_behaviour: AssetBehaviour::Normal,
        meta_behaviour: MetaBehaviour::NoMatchingAsset,
    })
    .await;

    let temp = TempDir::new().expect("tempdir");
    let install_dir = temp.path().join("install");
    let app = make_app(
        &base,
        r".*win.*x64.*\.exe$",
        InstallStrategy::Extract,
        &install_dir,
        true,
    );
    let paths = make_paths(&temp);
    let src = ReleaseSource::new();

    let state = src
        .check(&app, &paths)
        .await
        .expect("check ok (Error variant)");
    match state {
        UpdateState::Error { message } => {
            assert!(message.contains("no asset matching"), "got: {message}");
        }
        other => panic!("expected Error state, got {other:?}"),
    }

    let plan_err = src.plan(&app, &paths).await.expect_err("plan must error");
    match plan_err {
        CoreError::Config { message } => {
            assert!(message.contains("no asset matching"), "got: {message}");
        }
        other => panic!("expected Config, got {other:?}"),
    }
}

#[tokio::test]
async fn network_drop_resumes_with_range() {
    let asset_bytes = build_zip_asset();
    let total = asset_bytes.len();
    assert!(total > 60, "asset must be big enough to truncate");
    let digest = sha256_hex(&asset_bytes);
    let (base, hits) = spawn_fixture(FixtureConfig {
        asset_bytes,
        asset_name: "iptv-hub-tiny-v1.0.0.zip".into(),
        tag_name: "v1.0.0".into(),
        published_sha: Some(digest.clone()),
        asset_behaviour: AssetBehaviour::TruncateThenResume {
            first_bytes: total / 3,
        },
        meta_behaviour: MetaBehaviour::Normal,
    })
    .await;

    let temp = TempDir::new().expect("tempdir");
    std::fs::create_dir_all(temp.path().join("apps-root")).unwrap();
    let install_dir = temp.path().join("apps-root").join("install");
    let app = make_app(
        &base,
        r".*\.zip$",
        InstallStrategy::Extract,
        &install_dir,
        true,
    );
    let paths = make_paths(&temp);
    let src = ReleaseSource::new();
    let plan = src.plan(&app, &paths).await.expect("plan ok");
    let (ctx, mut rx) = make_ctx(paths);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let outcome = src
        .apply(&app, plan, ctx)
        .await
        .expect("apply ok after resume");

    assert!(usize::try_from(outcome.bytes_downloaded).unwrap_or(0) == total);
    assert!(hits.hits() >= 2, "should have retried at least once");
    let ranges = hits.range_headers();
    let saw_range = ranges.iter().any(|h| h.starts_with("bytes="));
    assert!(
        saw_range,
        "expected a Range: header on retry, saw: {ranges:?}"
    );
    assert!(install_dir.join("readme.txt").exists());
}

#[tokio::test]
async fn rate_limit_response_mapped_clearly() {
    let (base, _hits) = spawn_fixture(FixtureConfig {
        asset_bytes: Vec::new(),
        asset_name: "irrelevant".into(),
        tag_name: "v0.0.0".into(),
        published_sha: None,
        asset_behaviour: AssetBehaviour::Normal,
        meta_behaviour: MetaBehaviour::RateLimited,
    })
    .await;

    let temp = TempDir::new().expect("tempdir");
    let install_dir = temp.path().join("install");
    let app = make_app(
        &base,
        r".*\.zip$",
        InstallStrategy::Extract,
        &install_dir,
        true,
    );
    let paths = make_paths(&temp);
    let src = ReleaseSource::new();

    let err = src.check(&app, &paths).await.expect_err("must error");
    match err {
        CoreError::Network { message } => {
            assert!(
                message.to_ascii_lowercase().contains("rate limit"),
                "expected rate-limit message, got: {message}"
            );
        }
        other => panic!("expected Network, got {other:?}"),
    }
}
