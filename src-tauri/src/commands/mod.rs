//! Tauri IPC command surface.
//!
//! Every command listed in `docs/IPC.md` lives in one of the submodules below.
//! Agent 14 owns this module; as each command slice lands, the corresponding
//! `pub mod ...;` line is added here and the matching handler is added to
//! `tauri::generate_handler![ ... ]` in `src/main.rs`.

pub mod apps;
// pub mod activity;   // Agent 14 — list_activity, list_update_history, list_snapshots
// pub mod launch;     // Agent 13/14 — launch, stop
// pub mod seed;       // Agent 24 — seed_from_folder
// pub mod settings;   // Agent 14 — get_settings, set_setting
// pub mod updates;    // Agent 14 — check_for_update, plan_update, apply_update, cancel_update, rollback
