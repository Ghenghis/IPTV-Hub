//! IPTV Hub — main entry.
//!
//! Boots the runtime in this order:
//!   1. Resolve app-data directory (per-user or portable).
//!   2. Initialise tracing (rolling file + stderr).
//!   3. Load layered configuration.
//!   4. Open the SQLite pool and run migrations.
//!   5. Load and validate `apps.json`.
//!   6. Start the poller as a long-lived task.
//!   7. Hand off to the Tauri runtime with the command surface registered.

use std::sync::Arc;

use anyhow::Context;
use tauri::Manager;
use tracing_subscriber::{layer::SubscriberExt as _, util::SubscriberInitExt as _, EnvFilter};

use iptv_hub_core::{
    app_state::AppState,
    commands,
    config::AppConfig,
    db,
    manifest::ManifestStore,
    paths::AppPaths,
    poller::Poller,
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
            // Wave 1 — Agent 14 (apps subgroup), real implementations in commands::apps
            commands::apps::list_apps,
            commands::apps::get_app,
            commands::apps::add_app,
            commands::apps::remove_app,
            commands::apps::set_favorite,
            commands::apps::set_enabled,
            // The remaining command groups are added by the agents owning their slices.
            // Until then, the frontend's API wrapper marks them as "not yet available"
            // and the relevant UI surfaces hide behind feature checks. See AGENT_PLAN.md.
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

    let state = AppState::new(paths.clone(), config.clone(), pool.clone(), manifest.clone());

    let poller = Poller::new(state.clone());
    let poller_handle = poller.spawn();

    app.manage(state);
    app.manage(poller_handle);

    Ok(())
}

fn init_tracing(paths: &AppPaths) -> anyhow::Result<()> {
    let log_dir = paths.logs_dir();
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&log_dir, "iptv-hub.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(guard)); // keep the appender alive for process lifetime

    let env_filter = EnvFilter::try_from_env("IPTV_HUB_LOG").unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr).with_target(false))
        .with(tracing_subscriber::fmt::layer().with_writer(file_writer).json())
        .try_init()
        .context("init tracing")?;
    Ok(())
}
