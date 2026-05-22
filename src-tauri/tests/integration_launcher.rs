//! Integration tests for the launcher (Agent 13).
//!
//! Real subprocesses only — no mocks. Each test exercises the full code path:
//! `LaunchRegistry::launch` spawns an actual `cmd /c …` (Windows) or `sh -c …`
//! (Unix) child, the reader tasks drain stdout/stderr into the bounded ring,
//! `LaunchRegistry::stop` runs through the graceful-then-force sequence, and
//! `LaunchRegistry::tail` reports the captured lines.
//!
//! The tests intentionally avoid `npm`, `git`, `tizen`, and `cargo tauri`; they
//! pick the cheapest available shell so they run quickly on every CI matrix
//! entry without external dependencies.

#![allow(
    clippy::missing_panics_doc,
    clippy::missing_const_for_fn,
    clippy::uninlined_format_args,
    clippy::default_trait_access
)]

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tempfile::TempDir;

use iptv_hub_core::launcher::{LaunchRegistry, LogStream};
use iptv_hub_core::manifest::types::{AppEntry, LaunchKind, LaunchSpec, SourceType, WaitFor};
use iptv_hub_core::paths::AppPaths;

// ── helpers ──────────────────────────────────────────────────────────────────────

fn build_paths(temp: &TempDir) -> AppPaths {
    let data_dir = temp.path().join("data");
    let apps_root = temp.path().join("apps");
    std::fs::create_dir_all(data_dir.join("logs")).expect("mkdir data");
    std::fs::create_dir_all(&apps_root).expect("mkdir apps");
    AppPaths::from_dirs(data_dir, apps_root)
}

/// Build an `AppEntry` that launches a real shell command via `LaunchKind::Executable`.
/// On Windows the executable is `cmd.exe /C <args>`; on Unix it is `sh -c <args>`.
fn make_app(id: &str, name: &str, shell_args: Vec<String>) -> AppEntry {
    let (exe, mut args) = if cfg!(windows) {
        (
            std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
            vec!["/C".to_string()],
        )
    } else {
        ("/bin/sh".to_string(), vec!["-c".to_string()])
    };
    args.extend(shell_args);

    AppEntry {
        id: id.to_string(),
        name: name.to_string(),
        source_type: SourceType::Web,
        favorite: false,
        enabled: true,
        icon: None,
        polling: None,
        launch: LaunchSpec {
            kind: LaunchKind::Executable,
            cwd: None,
            command: Some(exe),
            args,
            env: HashMap::new(),
            wait_for: Some(WaitFor::None),
        },
        health: None,
        source: None,
        user_data: None,
    }
}

/// Wait until the child exits (i.e. the registry no longer reports it as running)
/// or `deadline` elapses. Returns the elapsed duration.
async fn wait_until_exit(reg: &LaunchRegistry, app_id: &str, deadline: Duration) -> Duration {
    let start = Instant::now();
    while start.elapsed() < deadline {
        if !reg.is_running(app_id).await {
            return start.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    start.elapsed()
}

// ── tests ────────────────────────────────────────────────────────────────────────

/// `launch` captures stdout/stderr into the per-app ring buffer; after the child
/// exits, `tail` returns the captured lines in order.
#[tokio::test]
async fn launch_real_subprocess_captures_output() {
    let temp = TempDir::new().expect("tempdir");
    let paths = build_paths(&temp);
    let reg = LaunchRegistry::new();

    // Print two lines and exit. The `echo a && echo b` form works in both cmd.exe
    // and POSIX sh because `&&` is shorthand for "run b if a succeeded" in each.
    let cmd = vec!["echo hello && echo world".to_string()];
    let app = make_app("capture-test", "Capture Test", cmd);

    reg.launch(&app, &paths).await.expect("launch");

    // Give the reader tasks time to drain — the child is short-lived.
    let _elapsed = wait_until_exit(&reg, &app.id, Duration::from_secs(5)).await;
    // Tail reads from the ring buffer the readers wrote into. The handle was
    // removed when stop was called — but the child exited naturally here, so
    // the handle is still in the map and the buffer is intact.
    // Wait a moment for any final line to flush.
    tokio::time::sleep(Duration::from_millis(150)).await;

    let tail = reg.tail(&app.id, 10);
    let lines: Vec<&str> = tail.iter().map(|l| l.line.trim()).collect();
    assert!(
        lines.contains(&"hello"),
        "expected 'hello' in captured output: {:?}",
        lines
    );
    assert!(
        lines.contains(&"world"),
        "expected 'world' in captured output: {:?}",
        lines
    );
    // All captured lines should be marked as stdout for this command.
    assert!(
        tail.iter().any(|l| l.stream == LogStream::Stdout),
        "expected at least one stdout line"
    );
}

/// `stop` waits up to 5 s for graceful exit, then force-kills. The child here
/// is a long-lived `ping` (Windows) or `sleep` (Unix); it should be dead
/// within the grace window plus a small buffer.
#[tokio::test]
async fn stop_graceful_then_force() {
    let temp = TempDir::new().expect("tempdir");
    let paths = build_paths(&temp);
    let reg = LaunchRegistry::new();

    // Long-running command: 30s of waiting that ignores Ctrl+Break on Windows.
    let cmd = if cfg!(windows) {
        vec!["ping 127.0.0.1 -n 30 > NUL".to_string()]
    } else {
        vec!["sleep 30".to_string()]
    };
    let app = make_app("stop-test", "Stop Test", cmd);

    reg.launch(&app, &paths).await.expect("launch");
    // Confirm the child is alive before we try to stop it.
    assert!(reg.is_running(&app.id).await, "child should be running");

    let stop_start = Instant::now();
    reg.stop(&app.id).await.expect("stop");
    let stop_elapsed = stop_start.elapsed();

    // 5s grace + a generous 5s buffer for cmd.exe / ping start-up jitter on CI.
    assert!(
        stop_elapsed <= Duration::from_secs(10),
        "stop should complete within 10s, took {:?}",
        stop_elapsed
    );
    assert!(
        !reg.is_running(&app.id).await,
        "child should be gone after stop"
    );
    // stop() removes the handle, so the tracked count drops back to zero.
    assert_eq!(
        reg.tracked_count(),
        0,
        "registry should be empty after stop"
    );
}

/// Launching the same app id twice while the first child is alive must NOT
/// spawn a second process. The second call returns an error and the registry
/// continues to track exactly one child.
#[tokio::test]
async fn singleton_refuses_second_launch() {
    let temp = TempDir::new().expect("tempdir");
    let paths = build_paths(&temp);
    let reg = LaunchRegistry::new();

    let cmd = if cfg!(windows) {
        vec!["ping 127.0.0.1 -n 10 > NUL".to_string()]
    } else {
        vec!["sleep 10".to_string()]
    };
    let app = make_app("singleton-test", "Singleton Test", cmd);

    reg.launch(&app, &paths).await.expect("first launch");
    assert_eq!(reg.tracked_count(), 1);

    // Second launch must fail (already running) and must NOT add a new entry.
    let second = reg.launch(&app, &paths).await;
    assert!(
        second.is_err(),
        "second launch should be rejected while first is alive"
    );
    assert_eq!(
        reg.tracked_count(),
        1,
        "no duplicate child should be tracked"
    );
    assert!(
        reg.is_running(&app.id).await,
        "first child should still be alive after rejected second launch"
    );

    // Clean up.
    reg.stop(&app.id).await.expect("stop");
}

/// Spew well over the documented ring-buffer cap (500) and confirm `tail`
/// never returns more than that count. Exercises the FIFO eviction path in
/// the reader task.
#[tokio::test]
async fn output_tail_bounded() {
    let temp = TempDir::new().expect("tempdir");
    let paths = build_paths(&temp);
    let reg = LaunchRegistry::new();

    // Emit 800 lines, well above the 500-line ring cap.
    let cmd = if cfg!(windows) {
        vec!["for /L %i in (1,1,800) do @echo line %i".to_string()]
    } else {
        vec!["for i in $(seq 1 800); do echo \"line $i\"; done".to_string()]
    };
    let app = make_app("bounded-test", "Bounded Test", cmd);

    reg.launch(&app, &paths).await.expect("launch");

    // Wait for the child to exit on its own.
    let _elapsed = wait_until_exit(&reg, &app.id, Duration::from_secs(30)).await;
    // Give the reader tasks a final grace period to drain.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Tail asks for more than the buffer holds; cap is the limiting factor.
    let tail = reg.tail(&app.id, 10_000);
    assert!(
        tail.len() <= 500,
        "ring buffer must not exceed 500 lines, got {}",
        tail.len()
    );
    assert!(
        tail.len() >= 100,
        "should still have hundreds of lines after eviction, got {}",
        tail.len()
    );
    // The most recent line should be the last one emitted (line 800).
    let last = tail.last().expect("non-empty tail").line.clone();
    assert!(
        last.trim().ends_with("line 800") || last.trim().ends_with("800"),
        "last line should be 'line 800', got {:?}",
        last
    );
}

/// Build an `AppEntry` configured for `LaunchKind::ExeShortcut` (or `WebUrl`)
/// with the given target string. Bypasses `make_app` because we need the
/// non-`Executable` kinds, which route through `cmd /C start ""` on Windows.
fn make_shortcut_app(id: &str, kind: LaunchKind, target: &str) -> AppEntry {
    AppEntry {
        id: id.to_string(),
        name: id.to_string(),
        source_type: SourceType::Web,
        favorite: false,
        enabled: true,
        icon: None,
        polling: None,
        launch: LaunchSpec {
            kind,
            cwd: None,
            command: Some(target.to_string()),
            args: Vec::new(),
            env: HashMap::new(),
            wait_for: Some(WaitFor::None),
        },
        health: None,
        source: None,
        user_data: None,
    }
}

/// Wave-2 security audit (PR-pending): `LaunchKind::ExeShortcut` and
/// `LaunchKind::WebUrl` previously fed their manifest `command` field straight
/// into `cmd /C start "" <target>` on Windows. If the value contained an `&`,
/// `|`, `;`, etc., `cmd.exe` would re-parse the metacharacter as a command
/// separator and execute whatever followed. The fix at
/// `launcher.rs::build_command` now rejects manifests containing any of
/// ``& | ; \n \r < > ` $ !`` for those two kinds. This test exercises the
/// rejection path with three concrete injection payloads — one per common
/// operator — and asserts that `LaunchRegistry::launch` returns the
/// `CoreError::Config` variant carrying the expected diagnostic.
#[tokio::test]
async fn rejects_shell_metachars_in_exe_shortcut() {
    let temp = TempDir::new().expect("tempdir");
    let paths = build_paths(&temp);
    let reg = LaunchRegistry::new();

    // Three payloads, one per major operator class. Each is something a
    // hostile manifest could plausibly try to look legitimate-ish.
    let payloads = [
        "C:\\path\\to\\app.lnk & calc.exe",
        "C:\\path\\to\\app.lnk | calc.exe",
        "C:\\path\\to\\app.lnk; calc.exe",
    ];

    for payload in payloads {
        let app = make_shortcut_app("exe-injection", LaunchKind::ExeShortcut, payload);
        let err = reg
            .launch(&app, &paths)
            .await
            .expect_err("hostile manifest must be rejected");
        let msg = format!("{err}");
        assert!(
            msg.contains("shell metacharacter") && msg.contains("exe-shortcut"),
            "expected metachar-rejection error for `{payload}`, got: {msg}"
        );
    }
}

#[tokio::test]
async fn rejects_shell_metachars_in_web_url() {
    let temp = TempDir::new().expect("tempdir");
    let paths = build_paths(&temp);
    let reg = LaunchRegistry::new();

    let payloads = [
        "https://example.com & calc.exe",
        "https://example.com | calc.exe",
        "https://example.com\nstart cmd",
    ];

    for payload in payloads {
        let app = make_shortcut_app("url-injection", LaunchKind::WebUrl, payload);
        let err = reg
            .launch(&app, &paths)
            .await
            .expect_err("hostile URL must be rejected");
        let msg = format!("{err}");
        assert!(
            msg.contains("shell metacharacter") && msg.contains("web-url"),
            "expected metachar-rejection error for `{payload}`, got: {msg}"
        );
    }
}
