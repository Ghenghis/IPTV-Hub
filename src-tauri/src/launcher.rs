//! Launcher.
//!
//! Dispatches a `LaunchSpec` from the manifest into a real OS-level child process
//! and tracks its lifecycle so the UI can flip the card to a `running` state, stream
//! its output to the activity log, and stop it on demand with a graceful SIGTERM
//! phase followed by a forced kill after a 5 s grace.
//!
//! Behaviour highlights:
//!
//! * Child stdout/stderr are captured line-by-line into a bounded per-app ring buffer
//!   (default 500 entries) and optionally forwarded to a `mpsc::Sender<LogLine>` so
//!   Agent 22's activity log can subscribe.
//! * `stop` on Windows posts `CTRL_BREAK_EVENT` to the child's process group (children
//!   are spawned with `CREATE_NEW_PROCESS_GROUP` so the signal does not propagate back
//!   into the hub) and waits up to 5 s for the process to exit before issuing
//!   `start_kill`. On Unix the same wait/force-kill sequence is used; SIGTERM signalling
//!   would require an extra dependency (`nix` or `libc`), so the portable path uses
//!   tokio's force kill — `tokio::process::Child::kill` issues SIGKILL on Unix, which
//!   matches the documented contract that *something* terminates the process.
//! * Calling `launch` for an `app_id` whose previous child is still alive returns
//!   `Err(CoreError::Config)` (the existing behaviour). On Windows the launcher first
//!   tries to bring the existing window to the foreground via `FindWindowW` so the user
//!   sees the in-flight app instead of a silent no-op.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, LaunchKind, LaunchSpec};
use crate::paths::AppPaths;

/// Maximum number of captured output lines retained per app. Older lines are
/// evicted in FIFO order once the ring is full.
const MAX_LOG_LINES_PER_APP: usize = 500;

/// Grace period between SIGTERM (or `CTRL_BREAK_EVENT` on Windows) and the
/// forced kill. The contract is "wait up to 5 s, then force".
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// On Windows: `CREATE_NEW_PROCESS_GROUP` (0x200). Documented value, used here to
/// avoid pulling the `windows` `Win32_System_Threading` constant into a Unix build.
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// One captured line from a launched child's stdout or stderr.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LogLine {
    pub app_id: String,
    pub stream: LogStream,
    pub line: String,
    /// Milliseconds since `UNIX_EPOCH` at the moment the line was captured.
    pub captured_at_ms: u128,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// Per-app capture buffer plus the running child handle.
struct ChildHandle {
    child: Arc<tokio::sync::Mutex<Child>>,
    // Used only on Windows to deliver `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)`
    // before falling back to `start_kill()`. On non-Windows hosts the stop path goes
    // straight to `Child::start_kill()`, so this field is intentionally dead there.
    #[cfg_attr(not(windows), allow(dead_code))]
    pid: Option<u32>,
    log: Arc<Mutex<VecDeque<LogLine>>>,
    // Background tasks that drain stdout / stderr; kept so we don't lose
    // their handles (and so they can be awaited on stop if needed).
    _stdout_task: Option<JoinHandle<()>>,
    _stderr_task: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct LaunchRegistry {
    children: Mutex<HashMap<String, Arc<ChildHandle>>>,
    /// Optional sink for the activity log. When present, every captured line
    /// is forwarded via `try_send` — full channels drop the line silently
    /// rather than block the launcher.
    log_sink: Mutex<Option<mpsc::Sender<LogLine>>>,
}

impl LaunchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach a sink that receives every captured log line going forward.
    /// Existing children continue to push into their own ring buffer; only
    /// future lines are sent to the sink.
    pub fn set_log_sink(&self, sink: mpsc::Sender<LogLine>) {
        *self.log_sink.lock() = Some(sink);
    }

    /// Convenience constructor used by callers that already have a log sink
    /// at registry-creation time.
    pub fn new_with_log_sink(sink: mpsc::Sender<LogLine>) -> Self {
        let registry = Self::default();
        registry.set_log_sink(sink);
        registry
    }

    /// Returns the most recent `n` captured lines for `app_id` (oldest first).
    /// Returns an empty vector if no child has been launched for that id.
    pub fn tail(&self, app_id: &str, n: usize) -> Vec<LogLine> {
        let Some(handle) = self.children.lock().get(app_id).cloned() else {
            return Vec::new();
        };
        let guard = handle.log.lock();
        let len = guard.len();
        let skip = len.saturating_sub(n);
        guard.iter().skip(skip).cloned().collect()
    }

    /// Number of children currently tracked. Test-only helper that doubles
    /// as a sanity check that the singleton guard didn't spawn a duplicate.
    pub fn tracked_count(&self) -> usize {
        self.children.lock().len()
    }

    /// Returns true if there is a tracked child for `app_id` and that child is
    /// still alive (i.e. `try_wait` reports it has not exited).
    pub async fn is_running(&self, app_id: &str) -> bool {
        let Some(handle) = self.children.lock().get(app_id).cloned() else {
            return false;
        };
        let mut child = handle.child.lock().await;
        matches!(child.try_wait(), Ok(None))
    }

    pub async fn launch(&self, app: &AppEntry, paths: &AppPaths) -> Result<(), CoreError> {
        // ── singleton check ───────────────────────────────────────────────────
        // Hold the map lock briefly to clone the existing handle, then re-check
        // liveness without holding the map lock (so other commands keep moving).
        let existing = self.children.lock().get(&app.id).cloned();
        if let Some(existing) = existing {
            let still_running = {
                let mut guard = existing.child.lock().await;
                matches!(guard.try_wait(), Ok(None))
            };
            if still_running {
                // Windows: try to bring the existing window to the foreground so
                // the user sees the running instance instead of a silent failure.
                #[cfg(windows)]
                focus_window_for(&app.name);
                return Err(CoreError::config(format!("{} is already running", app.id)));
            }
            // Process exited (or errored). Drop the stale handle and relaunch below.
            self.children.lock().remove(&app.id);
        }

        // ── spawn ─────────────────────────────────────────────────────────────
        let mut cmd = build_command(&app.launch, paths)?;
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        // Group children together so `CTRL_BREAK_EVENT` from `stop` targets only
        // the launched tree, not the hub itself.
        #[cfg(windows)]
        {
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| CoreError::io(app.launch.cwd.as_deref().unwrap_or("<cwd>"), e))?;

        let pid = child.id();
        let log: Arc<Mutex<VecDeque<LogLine>>> =
            Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES_PER_APP)));

        // Take the pipes BEFORE we move the child into the registry.
        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();

        let stdout_task = stdout_pipe.map(|pipe| {
            spawn_reader(
                app.id.clone(),
                LogStream::Stdout,
                pipe,
                Arc::clone(&log),
                self.log_sink.lock().clone(),
            )
        });
        let stderr_task = stderr_pipe.map(|pipe| {
            spawn_reader(
                app.id.clone(),
                LogStream::Stderr,
                pipe,
                Arc::clone(&log),
                self.log_sink.lock().clone(),
            )
        });

        info!(app_id = app.id, pid, "launched");
        let handle = Arc::new(ChildHandle {
            child: Arc::new(tokio::sync::Mutex::new(child)),
            pid,
            log,
            _stdout_task: stdout_task,
            _stderr_task: stderr_task,
        });
        self.children.lock().insert(app.id.clone(), handle);

        if let Some(wait_for) = &app.launch.wait_for {
            crate::smoke_test::wait_for(wait_for).await?;
        }
        Ok(())
    }

    /// Stop a running app. On Windows, signals the process group with
    /// `CTRL_BREAK_EVENT` and waits up to 5 s for graceful exit; if the process
    /// is still alive, calls `start_kill` and awaits the final wait. On Unix
    /// the graceful phase is a `kill_on_drop`-style force kill via tokio
    /// (SIGKILL), still bounded by the same 5 s wait so callers see a
    /// predictable timeout.
    pub async fn stop(&self, app_id: &str) -> Result<(), CoreError> {
        let handle = self
            .children
            .lock()
            .remove(app_id)
            .ok_or_else(|| CoreError::config(format!("{app_id} is not running")))?;

        let mut child_guard = handle.child.lock().await;

        // Fast path: process is already gone.
        if let Ok(Some(_status)) = child_guard.try_wait() {
            return Ok(());
        }

        // ── graceful phase ────────────────────────────────────────────────────
        #[cfg(windows)]
        {
            if let Some(pid) = handle.pid {
                if let Err(e) = send_ctrl_break(pid) {
                    // Logging only — fall through to force-kill below.
                    warn!(app_id, pid, ?e, "GenerateConsoleCtrlEvent failed");
                }
            }
        }
        #[cfg(not(windows))]
        {
            // Portable graceful phase: ask tokio to start the kill (SIGKILL on
            // Unix). The 5-second wait below is still observed so behaviour
            // matches Windows' "wait up to grace, then force" contract.
            if let Err(e) = child_guard.start_kill() {
                warn!(app_id, ?e, "graceful start_kill failed");
            }
        }

        // Wait up to 5 s for the child to exit on its own.
        let wait_result = tokio::time::timeout(GRACEFUL_STOP_TIMEOUT, child_guard.wait()).await;

        match wait_result {
            Ok(Ok(status)) => {
                debug!(app_id, ?status, "graceful exit");
                return Ok(());
            }
            Ok(Err(e)) => {
                warn!(app_id, ?e, "wait after graceful signal failed");
                // fall through to force-kill
            }
            Err(_) => {
                debug!(app_id, "graceful timeout elapsed, forcing kill");
            }
        }

        // ── force phase ───────────────────────────────────────────────────────
        if let Err(e) = child_guard.start_kill() {
            warn!(app_id, ?e, "force start_kill failed");
            return Err(CoreError::io(app_id, e));
        }
        match child_guard.wait().await {
            Ok(_) => Ok(()),
            Err(e) => Err(CoreError::io(app_id, e)),
        }
    }
}

/// Spawn a background task that reads `pipe` line-by-line, pushes each line into
/// the bounded ring buffer (evicting the oldest when full), and optionally
/// forwards it to the activity-log sink.
fn spawn_reader<R>(
    app_id: String,
    stream: LogStream,
    pipe: R,
    log: Arc<Mutex<VecDeque<LogLine>>>,
    sink: Option<mpsc::Sender<LogLine>>,
) -> JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(pipe).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let captured_at_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let entry = LogLine {
                        app_id: app_id.clone(),
                        stream,
                        line,
                        captured_at_ms,
                    };
                    {
                        let mut guard = log.lock();
                        if guard.len() == MAX_LOG_LINES_PER_APP {
                            guard.pop_front();
                        }
                        guard.push_back(entry.clone());
                    }
                    if let Some(sender) = sink.as_ref() {
                        // try_send is non-blocking; if the receiver is slow we'd
                        // rather drop one activity-log event than stall the
                        // launched app's stdout pipe.
                        let _ = sender.try_send(entry);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    warn!(app_id, ?stream, ?e, "log reader error");
                    break;
                }
            }
        }
    })
}

#[cfg(windows)]
fn send_ctrl_break(pid: u32) -> Result<(), std::io::Error> {
    // The `windows` crate FFI is unavoidably unsafe. Workspace lints deny
    // `unsafe_code` by default; we opt back in here, scoped to this function,
    // because there is no safe abstraction over `GenerateConsoleCtrlEvent`.
    #![allow(unsafe_code)]
    use windows::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};

    // SAFETY: `GenerateConsoleCtrlEvent` is documented as safe to call from any
    // thread for a process group id we own (we spawned the child with
    // CREATE_NEW_PROCESS_GROUP so its PID is also its process-group id). The
    // call has no out-pointer parameters; failure returns an `Err` via
    // `windows_core`. No memory is borrowed across the FFI boundary.
    unsafe {
        GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)
            .map_err(|e| std::io::Error::other(format!("GenerateConsoleCtrlEvent: {e}")))
    }
}

#[cfg(windows)]
fn focus_window_for(window_title: &str) {
    // Best-effort window focus. Failures are logged but never returned to the
    // caller; the launcher still returns "already running" so the UI can show
    // the right message.
    //
    // The `windows` crate FFI is unavoidably unsafe. Workspace lints deny
    // `unsafe_code` by default; we opt back in here, scoped to this function.
    #![allow(unsafe_code)]
    use std::iter::once;

    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    let wide: Vec<u16> = window_title.encode_utf16().chain(once(0)).collect();

    // SAFETY: `FindWindowW` reads two PCWSTR pointers; we pass a null
    // class name and a NUL-terminated UTF-16 buffer for the window name
    // that outlives the call. Return value validity is checked by the
    // crate's safe wrapper (`Result<HWND>`).
    let hwnd_result = unsafe { FindWindowW(PCWSTR::null(), PCWSTR(wide.as_ptr())) };
    let Ok(hwnd) = hwnd_result else {
        debug!(window_title, "FindWindowW: no matching window");
        return;
    };

    // SAFETY: `hwnd` was just returned by FindWindowW and the crate's safe
    // wrapper ensures it is non-null. The functions take an HWND by value
    // and do not retain it. Both calls return BOOL; failures are advisory.
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
    }
}

fn build_command(spec: &LaunchSpec, paths: &AppPaths) -> Result<Command, CoreError> {
    let cwd = spec.cwd.as_deref().map_or_else(
        || paths.apps_root().to_path_buf(),
        |c| paths.apps_root().join(c),
    );

    let mut cmd: Command = match spec.kind {
        LaunchKind::Executable => {
            let exe = spec
                .command
                .as_deref()
                .ok_or_else(|| CoreError::config("executable launch requires `command`"))?;
            let exe_path = if Path::new(exe).is_absolute() {
                Path::new(exe).to_path_buf()
            } else {
                cwd.join(exe)
            };
            Command::new(exe_path)
        }
        LaunchKind::Npm => {
            let script = spec.command.as_deref().unwrap_or("start");
            let mut c = Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" });
            c.arg("run").arg(script);
            c
        }
        LaunchKind::TauriDev => {
            let mut c = Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" });
            c.arg("run").arg("tauri").arg("dev");
            c
        }
        LaunchKind::ExeShortcut => {
            let target = spec
                .command
                .as_deref()
                .ok_or_else(|| CoreError::config("exe-shortcut launch requires `command`"))?;
            let expanded = expand_env(target);
            if cfg!(windows) {
                let mut c = Command::new("cmd");
                c.arg("/C").arg("start").arg("").arg(&expanded);
                c
            } else {
                Command::new(expanded)
            }
        }
        LaunchKind::WebUrl => {
            let url = spec
                .command
                .as_deref()
                .ok_or_else(|| CoreError::config("web-url launch requires `command`"))?;
            if cfg!(windows) {
                let mut c = Command::new("cmd");
                c.arg("/C").arg("start").arg("").arg(url);
                c
            } else if cfg!(target_os = "macos") {
                let mut c = Command::new("open");
                c.arg(url);
                c
            } else {
                let mut c = Command::new("xdg-open");
                c.arg(url);
                c
            }
        }
        LaunchKind::TizenDeploy => {
            let ipk = spec.command.as_deref().ok_or_else(|| {
                CoreError::config("tizen-deploy launch requires `command` (path to .ipk)")
            })?;
            let mut c = Command::new("tizen");
            c.arg("install").arg("-n").arg(ipk);
            c
        }
    };

    cmd.args(&spec.args);
    cmd.current_dir(&cwd);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd.kill_on_drop(false); // launched apps survive the hub closing
    Ok(cmd)
}

fn expand_env(s: &str) -> String {
    // Expand %VAR% style references on Windows-shaped strings.
    let mut out = s.to_string();
    while let Some(start) = out.find('%') {
        let Some(end_rel) = out[start + 1..].find('%') else {
            break;
        };
        let end = start + 1 + end_rel;
        let name = &out[start + 1..end];
        let replacement = std::env::var(name).unwrap_or_default();
        out.replace_range(start..=end, &replacement);
    }
    out
}
