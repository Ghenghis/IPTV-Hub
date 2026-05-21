//! IPTV Hub — main entry.
//!
//! Boots the runtime in this order:
//!   1. Resolve app-data directory (per-user or portable).
//!   2. Initialise tracing (rolling file + stderr).
//!   3. Load layered configuration.
//!   4. Open the `SQLite` pool and run migrations.
//!   5. Load and validate `apps.json`.
//!   6. Start the poller as a long-lived task.
//!   7. Hand off to the Tauri runtime with the command surface registered.

// `async_setup` takes `&mut tauri::App` because it's the shape `tauri::Builder::setup`
// gives us; the body legitimately needs access to `App::manage`. The `Send` bounds
// failing on internal Tauri/tao `Rc<_>` types are a Tauri-runtime constraint, not a
// real concurrency bug — the future is `block_on`-ed on the main thread.
#![allow(
    clippy::future_not_send,
    clippy::needless_pass_by_ref_mut,
    // The `tauri::generate_context!` macro expands to a large struct literal.
    clippy::large_stack_frames,
)]

use std::sync::Arc;

use anyhow::Context;
use tauri::Manager;
use tracing_subscriber::{layer::SubscriberExt as _, util::SubscriberInitExt as _, EnvFilter};

use iptv_hub_core::{
    app_state::AppState, commands, config::AppConfig, db, launcher::LaunchRegistry,
    manifest::ManifestStore, paths::AppPaths, poller::Poller, rollback,
};

fn main() -> anyhow::Result<()> {
    // Tauri itself owns the tokio runtime, so we build a setup function it can call.
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Run setup synchronously enough to satisfy `setup` but use Tauri's
            // async runtime for IO work via `tauri::async_runtime::block_on`.
            tauri::async_runtime::block_on(async_setup(app))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // apps subgroup — Agent 14 / commands::apps
            commands::apps::list_apps,
            commands::apps::get_app,
            commands::apps::add_app,
            commands::apps::remove_app,
            commands::apps::set_favorite,
            commands::apps::set_enabled,
            // updates subgroup — Agent 14a / commands::updates
            commands::updates::check_for_update,
            commands::updates::plan_update,
            commands::updates::apply_update,
            commands::updates::rollback,
            // launch subgroup — Agent 14b / commands::launch
            commands::launch::launch,
            commands::launch::stop,
            // settings subgroup — Agent 14c / commands::settings
            commands::settings::get_settings,
            commands::settings::set_setting,
            // activity / history / snapshots — Agent 14d / commands::activity
            commands::activity::list_activity,
            commands::activity::list_update_history,
            commands::activity::list_snapshots,
            // seed-from-folder — Agent 24 / commands::seed
            commands::seed::seed_from_folder,
        ])
        .run(tauri::generate_context!())
        .context("failed to run Tauri runtime")
}

async fn async_setup(app: &mut tauri::App) -> anyhow::Result<()> {
    let paths = AppPaths::resolve(app.handle())?;
    paths.ensure_exist().await?;

    init_tracing(&paths)?;
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "starting IPTV Hub");

    let config = AppConfig::load(&paths).context("load config")?;
    let pool = db::open_pool(&paths.database_path()).await?;
    db::run_migrations(&pool).await?;

    let manifest = ManifestStore::load(paths.manifest_path()).await?;
    let manifest = Arc::new(manifest);

    let state = AppState::new(paths.clone(), config.clone(), pool.clone(), manifest);

    // Crash recovery: if a previous run died mid-swap, restore the affected apps
    // from their snapshot archives before anything else can launch them.
    match rollback::recover_orphan_swaps(&paths).await {
        Ok(ids) if !ids.is_empty() => {
            tracing::warn!(count = ids.len(), app_ids = ?ids, "recovered orphan swaps");
        }
        Ok(_) => {
            tracing::debug!("orphan-swap recovery scan clean (no markers)");
        }
        Err(err) => {
            tracing::error!(error = %err, "orphan-swap recovery failed; continuing startup");
        }
    }

    let poller = Poller::new(state.clone());
    let poller_handle = poller.spawn();

    let launch_registry = LaunchRegistry::new();

    app.manage(state);
    app.manage(poller_handle);
    app.manage(launch_registry);

    Ok(())
}

fn init_tracing(paths: &AppPaths) -> anyhow::Result<()> {
    let log_dir = paths.logs_dir();
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&log_dir, "iptv-hub.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(guard)); // keep the appender alive for process lifetime

    let env_filter =
        EnvFilter::try_from_env("IPTV_HUB_LOG").unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_target(false),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(file_writer)
                .json(),
        )
        .try_init()
        .context("init tracing")?;
    Ok(())
}
