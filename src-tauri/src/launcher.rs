//! Launcher. Dispatches a `LaunchSpec` from the manifest into a real OS-level child
//! process and tracks its lifecycle so the UI can flip the card to a `running` state
//! and stop it on demand.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::process::{Child, Command};
use tracing::{info, warn};

use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, LaunchKind, LaunchSpec};
use crate::paths::AppPaths;

#[derive(Default)]
pub struct LaunchRegistry {
    children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

impl LaunchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn launch(&self, app: &AppEntry, paths: &AppPaths) -> Result<(), CoreError> {
        let existing = self.children.lock().get(&app.id).cloned();
        if let Some(existing) = existing {
            // If the child is already running, refuse to start a second instance.
            let still_running = matches!(existing.lock().try_wait(), Ok(None));
            if still_running {
                return Err(CoreError::config(format!("{} is already running", app.id)));
            }
            // Otherwise: process exited (or errored). Drop the guard and relaunch.
        }

        let child = build_command(&app.launch, paths)?.spawn().map_err(|e| {
            CoreError::io(
                app.launch.cwd.as_deref().unwrap_or("<cwd>"),
                e,
            )
        })?;

        info!(app_id = app.id, pid = child.id(), "launched");
        self.children
            .lock()
            .insert(app.id.clone(), Arc::new(Mutex::new(child)));

        if let Some(wait_for) = &app.launch.wait_for {
            crate::smoke_test::wait_for(wait_for).await?;
        }
        Ok(())
    }

    pub fn stop(&self, app_id: &str) -> Result<(), CoreError> {
        let handle = self
            .children
            .lock()
            .remove(app_id)
            .ok_or_else(|| CoreError::config(format!("{app_id} is not running")))?;
        let kill_result = {
            let mut child = handle.lock();
            child.start_kill()
        };
        if let Err(e) = kill_result {
            warn!(app_id, ?e, "kill failed");
            return Err(CoreError::io(app_id, e));
        }
        Ok(())
    }
}

fn build_command(spec: &LaunchSpec, paths: &AppPaths) -> Result<Command, CoreError> {
    let cwd = spec
        .cwd
        .as_deref()
        .map_or_else(|| paths.apps_root().to_path_buf(), |c| paths.apps_root().join(c));

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
            // Real tizen-deploy goes through the Tizen Studio CLI. Implementing the
            // CLI invocation belongs to the tizen source agent (09) along with their
            // smoke check. Until then, the manifest's `command` is passed straight
            // to `tizen install` which is the documented happy path.
            let ipk = spec
                .command
                .as_deref()
                .ok_or_else(|| CoreError::config("tizen-deploy launch requires `command` (path to .ipk)"))?;
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
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
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
