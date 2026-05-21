//! IPTV Hub — core library.
//!
//! This crate is consumed by `src/main.rs` (the Tauri binary) and by the integration
//! test suite. Every public type below is a stable agent-to-agent boundary; changes
//! ripple through `docs/IPC.md` and the relevant module documentation.

pub mod app_state;
pub mod commands;
pub mod config;
pub mod db;
pub mod errors;
pub mod launcher;
pub mod manifest;
pub mod paths;
pub mod poller;
pub mod rollback;
pub mod seed;
pub mod smoke_test;
pub mod sources;
