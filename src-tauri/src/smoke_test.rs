//! Smoke test runner. Translates a `WaitFor` spec from the manifest into a real
//! readiness probe and returns once the condition holds (or times out).
//!
//! Used by:
//!   * The launcher to decide when an app is ready after `launch`.
//!   * The update orchestrator to confirm an app boots after `apply`.

use std::time::{Duration, Instant};

use tokio::net::TcpStream;
use tracing::debug;

use crate::errors::CoreError;
use crate::manifest::types::WaitFor;

pub async fn wait_for(spec: &WaitFor) -> Result<(), CoreError> {
    match spec {
        WaitFor::None => Ok(()),
        WaitFor::Port { value, timeout_ms } => wait_port(*value, *timeout_ms).await,
        WaitFor::Process { value, timeout_ms } => wait_process(value, *timeout_ms).await,
        WaitFor::Http { value, timeout_ms } => wait_http(value, *timeout_ms).await,
    }
}

async fn wait_port(port: u16, timeout_ms: u32) -> Result<(), CoreError> {
    let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
    let addr = format!("127.0.0.1:{port}");
    loop {
        if Instant::now() >= deadline {
            return Err(CoreError::smoke_failed(format!("port {port} not open within {timeout_ms} ms")));
        }
        match tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(&addr)).await {
            Ok(Ok(_)) => return Ok(()),
            _ => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}

async fn wait_http(url: &str, timeout_ms: u32) -> Result<(), CoreError> {
    let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(2000))
        .build()
        .map_err(CoreError::from)?;
    loop {
        if Instant::now() >= deadline {
            return Err(CoreError::smoke_failed(format!("http {url} not 2xx within {timeout_ms} ms")));
        }
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                debug!(%url, "smoke http ok");
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn wait_process(name: &str, timeout_ms: u32) -> Result<(), CoreError> {
    let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
    while Instant::now() < deadline {
        if process_is_running(name)? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(CoreError::smoke_failed(format!("process {name} not running within {timeout_ms} ms")))
}

#[cfg(windows)]
fn process_is_running(name: &str) -> Result<bool, CoreError> {
    use std::process::Command;
    let output = Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])
        .output()
        .map_err(|e| CoreError::io("tasklist", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_lowercase().contains(&name.to_lowercase()))
}

#[cfg(not(windows))]
fn process_is_running(name: &str) -> Result<bool, CoreError> {
    use std::process::Command;
    let output = Command::new("pgrep")
        .args(["-x", name])
        .output()
        .map_err(|e| CoreError::io("pgrep", e))?;
    Ok(output.status.success())
}
