//! `launch` command group. Two commands wire the UI's "Launch" and "Stop" buttons
//! through to the real [`crate::launcher::LaunchRegistry`]:
//!
//! * [`launch`] — look up an [`AppEntry`] from the manifest, dispatch the
//!   [`LaunchSpec`] to the registry, and append an `activity_log` row.
//! * [`stop`]   — ask the registry to stop the tracked child. The call returns
//!   after the registry's 5 s graceful phase plus the forced-kill phase
//!   complete, so the UI knows the process is really gone before it flips the
//!   card back to `idle`.
//!
//! ## Wiring contract
//!
//! [`LaunchRegistry`] is a **managed singleton**: a single instance is shared
//! across every IPC call so two clicks on the same card can never race two
//! `Child` handles into the registry's map.
//!
//! The orchestrator (Agent 14, `src/main.rs::async_setup`) is responsible for:
//!
//! ```ignore
//! let launch_registry = iptv_hub_core::launcher::LaunchRegistry::new();
//! app.manage(launch_registry);
//! ```
//!
//! and for adding `commands::launch::launch` and `commands::launch::stop` to
//! the `tauri::generate_handler!` macro list. Both commands resolve the
//! registry via [`tauri::AppHandle::state`], so once the registry is managed
//! they are picked up without any further glue.

use tauri::{AppHandle, Manager as _, State};

use crate::app_state::AppState;
use crate::errors::CoreError;
use crate::launcher::LaunchRegistry;
use crate::manifest::types::AppEntry;

/// Resolve the managed [`LaunchRegistry`] from the Tauri state map. If the
/// orchestrator has not registered one via `app.manage(LaunchRegistry::new())`
/// we surface a clear `Config` error so the UI does not silently lose launches.
fn registry(app_handle: &AppHandle) -> Result<State<'_, LaunchRegistry>, CoreError> {
    app_handle.try_state::<LaunchRegistry>().ok_or_else(|| {
        CoreError::config(
            "LaunchRegistry is not managed by the Tauri runtime; \
             call `app.manage(LaunchRegistry::new())` in async_setup",
        )
    })
}

/// Look the app up by id in the in-memory manifest. Cloned so the `parking_lot`
/// guard is never held across an await boundary in the caller.
fn lookup_app(state: &State<'_, AppState>, id: &str) -> Result<AppEntry, CoreError> {
    state
        .manifest
        .read()
        .apps
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or_else(|| CoreError::config(format!("app not found: {id}")))
}

/// Append one row to `activity_log`. Mirrors `poller::insert_activity`: the
/// insert is best-effort so a transient DB hiccup never breaks a launch. Any
/// error is logged at `warn!` (operator-visible via `RUST_LOG=warn`) but does
/// NOT propagate — the launch itself has already happened (or already failed)
/// and the caller's `CoreError` is what the UI surfaces. See
/// [`crate::db::audit_write`] for the rationale.
async fn log_activity(
    state: &State<'_, AppState>,
    app_id: &str,
    action: &str,
    level: &str,
    message: &str,
) {
    crate::db::audit_write(
        "log_launch_activity",
        sqlx::query(
            "INSERT INTO activity_log (at, app_id, action, level, message) \
             VALUES (datetime('now'), ?, ?, ?, ?)",
        )
        .bind(app_id)
        .bind(action)
        .bind(level)
        .bind(message)
        .execute(&state.db),
    )
    .await;
}

/// Launch an app by id. Dispatches the manifest's `LaunchSpec` to the shared
/// [`LaunchRegistry`] and writes an `activity_log` row recording the outcome.
///
/// Returns `Ok(())` once the child has been spawned (and `wait_for` — if any —
/// has resolved). Errors propagate the registry's failure verbatim so the UI
/// can surface "already running" vs "spawn failed" vs "smoke test failed"
/// distinctly via [`CoreError`]'s tag.
#[tauri::command]
pub async fn launch(
    id: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), CoreError> {
    let app = lookup_app(&state, &id)?;
    let paths = state.paths.clone();
    let reg = registry(&app_handle)?;

    match reg.launch(&app, &paths).await {
        Ok(()) => {
            log_activity(
                &state,
                &id,
                "launch",
                "info",
                &format!("launched {}", app.name),
            )
            .await;
            Ok(())
        }
        Err(e) => {
            log_activity(
                &state,
                &id,
                "launch",
                "error",
                &format!("launch failed: {e}"),
            )
            .await;
            Err(e)
        }
    }
}

/// Stop a running app by id. Returns once the registry's graceful-then-forced
/// stop sequence (5 s SIGTERM-equivalent grace, then `start_kill`) has
/// completed. Writes an `activity_log` row whether the stop succeeded or not.
#[tauri::command]
pub async fn stop(
    id: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), CoreError> {
    let reg = registry(&app_handle)?;

    match reg.stop(&id).await {
        Ok(()) => {
            log_activity(&state, &id, "stop", "info", "stopped").await;
            Ok(())
        }
        Err(e) => {
            log_activity(&state, &id, "stop", "error", &format!("stop failed: {e}")).await;
            Err(e)
        }
    }
}

#[cfg(test)]
mod sanity {
    //! Compile-only sanity check. The commands themselves are exercised by the
    //! Tauri integration tests once `main.rs` wires them into the handler list;
    //! this block ensures the module compiles in isolation when included.

    use super::{AppEntry, CoreError, LaunchRegistry};

    const fn assert_send<T: Send>() {}

    #[test]
    fn module_compiles() {
        // Touch every imported symbol so an accidental `use` rot here fails
        // the unit-test build rather than waiting for the full Tauri compile.
        assert_send::<CoreError>();
        assert_send::<AppEntry>();
        let ctor: fn() -> LaunchRegistry = LaunchRegistry::new;
        // Constructing a registry has no observable side effect, but the
        // call still ensures the symbol is reachable and callable.
        let registry = ctor();
        assert_eq!(registry.tracked_count(), 0);
    }
}
