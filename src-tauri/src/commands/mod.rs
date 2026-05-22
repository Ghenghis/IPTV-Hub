//! Tauri IPC command surface.
//!
//! Every command exposed to the frontend lives in one of the submodules below
//! and is registered in `tauri::generate_handler![ ... ]` in `src/main.rs`.
//! Strongly-typed DTOs only — no `serde_json::Value` on the boundary.

pub mod activity;
pub mod apps;
pub mod launch;
pub mod seed;
pub mod settings;
pub mod updates;
