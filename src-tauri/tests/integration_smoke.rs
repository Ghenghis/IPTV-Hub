//! Integration tests for the smoke-test runner (`smoke_test::wait_for`).
//!
//! Per CONTRACT.md §2.2: **no mock-only test strategy**. Each test exercises the real
//! probe against a real fixture:
//!   * `Port`    — a real `tokio::net::TcpListener` accepting on `127.0.0.1`.
//!   * `Process` — a real `tokio::process::Command` child running `ping.exe` on Windows
//!     (or `sleep` on other platforms).
//!   * `Http`    — a real `hyper` server bound on `127.0.0.1:0`.
//!   * `None`    — verifies the immediate-OK path with no I/O.
//!
//! Every test is wrapped in `tokio::time::timeout` so a hang cannot wedge CI. All
//! listeners and child processes are explicitly closed at the end of each test.
//!
//! Acceptance criteria: one `#[tokio::test]` per `WaitFor` variant against real
//! listeners/processes/HTTP servers — no mocking of the actual probe. Must pass on
//! Windows.

#![allow(
    clippy::missing_panics_doc,
    clippy::uninlined_format_args,
    clippy::too_many_lines
)]

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::timeout;

use iptv_hub_core::errors::CoreError;
use iptv_hub_core::manifest::types::WaitFor;
use iptv_hub_core::smoke_test::wait_for;

// ── shared bounds ────────────────────────────────────────────────────────────────

/// Hard outer bound for every test. The probe's own `timeout_ms` is set much smaller;
/// this just keeps a misbehaving probe from wedging CI for minutes.
const TEST_HARD_TIMEOUT: Duration = Duration::from_secs(15);

// ── Port probe ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn wait_for_port_succeeds_against_real_listener() {
    timeout(TEST_HARD_TIMEOUT, async {
        // Real OS-picked free port on 127.0.0.1 — no host param exposed by the probe,
        // which is hard-wired to 127.0.0.1 (see smoke_test::wait_port).
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("local_addr").port();

        // Accept loop in the background so connect() actually completes — without
        // someone calling accept(), the kernel still completes the connect on
        // localhost, but we mirror real-server behaviour to avoid surprises.
        let accept_task = tokio::spawn(async move {
            // One accept is enough; the probe only needs the connect handshake.
            let _ = listener.accept().await;
        });

        let spec = WaitFor::Port {
            value: port,
            timeout_ms: 2_000,
        };

        wait_for(&spec).await.expect("port probe must succeed");

        accept_task.abort();
    })
    .await
    .expect("test hit hard timeout");
}

#[tokio::test]
async fn wait_for_port_fails_when_nothing_listens() {
    timeout(TEST_HARD_TIMEOUT, async {
        // Bind a listener to grab a free port, then drop it so the port is unused.
        // Race with another binder is acceptable: even if something else binds in
        // the gap, the probe-against-bound-listener case is covered by the positive
        // test; here we only care about negative-path error messaging.
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind 127.0.0.1:0");
            listener.local_addr().expect("local_addr").port()
            // listener dropped here -> port released
        };

        let spec = WaitFor::Port {
            value: port,
            timeout_ms: 500,
        };

        let err = wait_for(&spec)
            .await
            .expect_err("port probe must fail for unbound port");

        match err {
            CoreError::SmokeFailed { message } => {
                assert!(
                    message.contains(&format!("port {port}")) && message.contains("not open"),
                    "expected clear port-not-open message, got: {message}"
                );
            }
            other => panic!("expected SmokeFailed, got {other:?}"),
        }
    })
    .await
    .expect("test hit hard timeout");
}

// ── Process probe ────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn spawn_long_lived_child() -> (tokio::process::Child, &'static str) {
    // `ping 127.0.0.1 -n 10` on Windows spawns `PING.EXE` for ~9 seconds, which is
    // plenty of headroom for the probe + assertions. `tasklist` matches by
    // image name; the impl already case-folds.
    let child = tokio::process::Command::new("cmd")
        .args(["/C", "ping", "127.0.0.1", "-n", "10"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn ping via cmd");
    (child, "PING.EXE")
}

#[cfg(not(windows))]
fn spawn_long_lived_child() -> (tokio::process::Child, &'static str) {
    // `sleep 10` runs for 10 seconds; `pgrep -x sleep` is what the impl uses.
    let child = tokio::process::Command::new("sleep")
        .arg("10")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn sleep");
    (child, "sleep")
}

#[tokio::test]
async fn wait_for_process_succeeds_against_real_child() {
    timeout(TEST_HARD_TIMEOUT, async {
        let (mut child, process_name) = spawn_long_lived_child();

        // Give the OS process table a moment to register the child. The probe loops
        // with a 300 ms tick, so even without this the probe would catch the
        // process — but making the wait explicit avoids a flaky-on-slow-CI window.
        tokio::time::sleep(Duration::from_millis(150)).await;

        let spec = WaitFor::Process {
            value: process_name.to_string(),
            timeout_ms: 5_000,
        };

        let result = wait_for(&spec).await;

        // Always clean up the child, regardless of probe outcome.
        let _ = child.kill().await;
        let _ = child.wait().await;

        result.expect("process probe must succeed for real running child");
    })
    .await
    .expect("test hit hard timeout");
}

#[tokio::test]
async fn wait_for_process_fails_for_nonexistent_process() {
    timeout(TEST_HARD_TIMEOUT, async {
        // A name that cannot match any real process image.
        let spec = WaitFor::Process {
            value: "iptv-hub-nonexistent-process-name-zzz.exe".to_string(),
            timeout_ms: 600,
        };

        let err = wait_for(&spec)
            .await
            .expect_err("process probe must fail for missing process");

        match err {
            CoreError::SmokeFailed { message } => {
                assert!(
                    message.contains("not running"),
                    "expected clear not-running message, got: {message}"
                );
            }
            other => panic!("expected SmokeFailed, got {other:?}"),
        }
    })
    .await
    .expect("test hit hard timeout");
}

// ── HTTP probe ───────────────────────────────────────────────────────────────────

/// Spawn a tiny hyper server that returns `status_code` on `/health`. Returns the
/// base URL plus a shutdown sender that ends the accept loop when dropped/sent.
async fn spawn_health_server(status_code: StatusCode) -> (String, oneshot::Sender<()>) {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("bind 127.0.0.1:0");
    let addr = listener.local_addr().expect("local_addr");
    let base = format!("http://{addr}");

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let shutting_down = Arc::new(AtomicBool::new(false));
    let shutting_down_loop = shutting_down.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                accept = listener.accept() => {
                    let Ok((stream, _)) = accept else { break; };
                    if shutting_down_loop.load(Ordering::SeqCst) {
                        break;
                    }
                    tokio::spawn(async move {
                        let io = TokioIo::new(stream);
                        let service = service_fn(move |req| async move {
                            Ok::<_, Infallible>(health_response(&req, status_code))
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(io, service)
                            .await;
                    });
                }
                _ = &mut shutdown_rx => {
                    shutting_down_loop.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    });

    // Tiny readiness sleep: bind() returned, but spawned task may not have polled yet.
    tokio::time::sleep(Duration::from_millis(20)).await;
    (base, shutdown_tx)
}

fn health_response(
    req: &Request<hyper::body::Incoming>,
    status_code: StatusCode,
) -> Response<Full<Bytes>> {
    if req.uri().path() == "/health" {
        Response::builder()
            .status(status_code)
            .header("Content-Type", "text/plain")
            .body(Full::new(Bytes::from_static(b"health probe body")))
            .expect("build response")
    } else {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Full::new(Bytes::from_static(b"not found")))
            .expect("build response")
    }
}

#[tokio::test]
async fn wait_for_http_succeeds_against_real_2xx_server() {
    timeout(TEST_HARD_TIMEOUT, async {
        let (base, shutdown) = spawn_health_server(StatusCode::OK).await;
        let url = format!("{base}/health");

        let spec = WaitFor::Http {
            value: url,
            timeout_ms: 5_000,
        };

        let result = wait_for(&spec).await;

        let _ = shutdown.send(());
        result.expect("http probe must succeed against real 200 server");
    })
    .await
    .expect("test hit hard timeout");
}

#[tokio::test]
async fn wait_for_http_fails_against_real_500_server() {
    timeout(TEST_HARD_TIMEOUT, async {
        // The probe re-tries any non-2xx until `timeout_ms` elapses, then returns
        // `SmokeFailed`. A short probe timeout keeps the test fast while still
        // exercising the real loop against a real 500-responding server.
        let (base, shutdown) = spawn_health_server(StatusCode::INTERNAL_SERVER_ERROR).await;
        let url = format!("{base}/health");

        let spec = WaitFor::Http {
            value: url.clone(),
            timeout_ms: 800,
        };

        let err = wait_for(&spec)
            .await
            .expect_err("http probe must fail when server returns 500");

        let _ = shutdown.send(());

        match err {
            CoreError::SmokeFailed { message } => {
                assert!(
                    message.contains(&url) && message.contains("not 2xx"),
                    "expected clear not-2xx message, got: {message}"
                );
            }
            other => panic!("expected SmokeFailed, got {other:?}"),
        }
    })
    .await
    .expect("test hit hard timeout");
}

// ── None (no-op) ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn wait_for_none_returns_immediately() {
    timeout(Duration::from_secs(2), async {
        let started = std::time::Instant::now();
        wait_for(&WaitFor::None).await.expect("None must be Ok");
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_millis(100),
            "None branch must be effectively instant, took {elapsed:?}"
        );
    })
    .await
    .expect("test hit hard timeout");
}
