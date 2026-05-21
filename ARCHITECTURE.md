# IPTV Hub — Architecture

## 1. System map

```
┌─────────────────────────── IPTV Hub (Tauri binary) ───────────────────────────┐
│                                                                                │
│   ┌──────────────────────────────┐         ┌────────────────────────────────┐ │
│   │  Frontend (Webview)          │  IPC    │  Rust Core                     │ │
│   │  vanilla TS + Web Components │ ◄─────► │  tokio + sqlx + git2 + reqwest │ │
│   │                              │         │                                │ │
│   │  • App grid                  │         │  • Manifest (apps.json)        │ │
│   │  • Chip filter bar           │         │  • Source trait + 5 impls      │ │
│   │  • Update preview modal      │         │  • Poller (bounded concurrency)│ │
│   │  • Activity log              │         │  • Rollback engine             │ │
│   │  • Settings/Sources page     │         │  • Smoke-test runner           │ │
│   └──────────────────────────────┘         │  • Launcher (process spawn)    │ │
│                                            │  • SQLite repo                 │ │
│                                            └────────────────────────────────┘ │
│                                                          │                     │
└──────────────────────────────────────────────────────────┼─────────────────────┘
                                                           │
                          ┌────────────────────────────────┼────────────────────────────────┐
                          │                                │                                │
                          ▼                                ▼                                ▼
                 ┌────────────────┐              ┌────────────────┐              ┌────────────────┐
                 │  upstream/     │              │  user-data/    │              │  cache/        │
                 │  (managed)     │              │  (yours)       │              │  (managed)     │
                 │                │              │                │              │                │
                 │  git clones    │              │  configs       │              │  icons         │
                 │  release dirs  │              │  playlists     │              │  rollback snaps│
                 │  install pts   │              │  EPG caches    │              │  release meta  │
                 └────────────────┘              └────────────────┘              └────────────────┘
                          ▲                                                              ▲
                          │                                                              │
                          │ git fetch / release download / installer fetch               │
                          │ Symlinks: upstream/<app>/userData → user-data/<app>/         │
                          ▼                                                              │
                 ┌────────────────────────────────┐                              ┌────────────────┐
                 │  External sources              │                              │  GitHub keychain│
                 │  GitHub / GitLab / mirrors     │                              │  via keyring-rs│
                 │  Vendor MSI URLs               │                              └────────────────┘
                 │  Samsung TV (sdb)              │
                 └────────────────────────────────┘
```

Diagrams in [`docs/diagrams/`](./docs/diagrams/) render the same picture as Mermaid for
GitHub rendering.

## 2. Process model

- **Single Tauri process** with a Rust core and one webview.
- **Tokio runtime** for all async work in the core; one shared multi-thread runtime.
- **Poller** is a long-lived `tokio::spawn` task that wakes on a configurable interval (default
  15 minutes) and processes up to `poll_concurrency` (default 4) sources at a time using
  `tokio::sync::Semaphore`.
- **Launcher** spawns child processes via `tokio::process::Command` with stdout/stderr piped
  back to the activity log via an in-memory broadcast channel.
- **No background services or system tray daemons** in v1. Closing the window closes the app.
  System tray is on the roadmap (v0.2) behind a config flag.

## 3. Data flow

### Read path (display the app grid)

1. Frontend mounts and calls `cmd_list_apps()`.
2. Core reads `apps.json` and joins with `apps` table (last poll status, last update result).
3. Returns a `Vec<AppView>` to the frontend.
4. Frontend renders cards by category; status dot from `apps.status`.

### Poll path (find updates)

1. Poller wakes (timer or "Sync now" button).
2. For each enabled app, dispatches to the right `Source` impl based on `manifest.type`.
3. `Source::check_for_update(&app) -> Result<UpdateState>` returns one of:
   `UpToDate`, `UpdateAvailable { from, to, summary }`, or `Error { message }`.
4. Result is persisted to the `apps` table and broadcast on the activity bus.
5. Frontend's update-counter chip refreshes.

### Update path (apply an update)

See [`docs/UPDATE_FLOWS.md`](./docs/UPDATE_FLOWS.md). The high-level sequence is the same
for every source type:

```
plan → confirm → snapshot → fetch → verify → swap → relink → smoke → commit | rollback
```

The plan step is what the **Update preview modal** in the UI displays.

## 4. Key boundaries

### The `Source` trait

Every update mechanism implements the same trait. Adding a new source type is one file +
one match arm + one set of integration tests.

```rust
#[async_trait::async_trait]
pub trait Source: Send + Sync {
    async fn check(&self, app: &App) -> Result<UpdateState>;
    async fn plan(&self, app: &App) -> Result<UpdatePlan>;
    async fn apply(&self, app: &App, plan: UpdatePlan, ctx: ApplyCtx) -> Result<UpdateOutcome>;
    async fn rollback(&self, app: &App, snapshot_id: &str) -> Result<()>;
}
```

Implementations live under `src-tauri/src/sources/`:

- `git.rs` — uses `git2-rs`, fast-forward-only, refuses on history rewrite.
- `release.rs` — GitHub releases API + sha256 verification.
- `installer.rs` — Windows MSI/EXE handling, registry-based version detection.
- `web.rs` — git source + `package.json` script discovery + port-managed dev server.
- `tizen.rs` — `.ipk` download + optional `sdb` integration for TV deploy.

### Tauri IPC commands

All commands are listed in [`docs/IPC.md`](#) (to be authored by Agent 04). Each command has:

- A typed Rust handler.
- A typed TypeScript wrapper in `frontend/src/lib/api.ts`.
- A round-trip integration test.

No command takes or returns `serde_json::Value`. Everything is strongly typed.

### Database

SQLite with `sqlx` migrations. Schema in [`docs/DATABASE.md`](./docs/DATABASE.md). The
database is the source of truth for **runtime state** (last poll, last update outcome,
activity log, rollback snapshots). `apps.json` is the source of truth for **configuration**
(which apps exist, where they live, how they update).

## 5. Configuration

Layered config, last-write-wins:

1. **Built-in defaults** — compiled into the binary.
2. **`config/default.toml`** — shipped with the binary.
3. **`%APPDATA%\IPTV-Hub\config.toml`** — user overrides.
4. **Environment** — `IPTV_HUB_*` variables (mostly used by CI).

`apps.json` is **not** part of the layered config; it lives alongside the binary at
`<install-dir>/apps.json` and is mutable by the running app (writes are atomic via
write-temp-and-rename).

## 6. Threading model

- **Frontend → Core**: Tauri's IPC bridge (built on top of message-passing).
- **Core → Frontend**: typed events via `tauri::Window::emit` (named events listed in
  `frontend/src/lib/events.ts`).
- **Core internal**: `tokio::mpsc` for the activity bus; `tokio::Mutex` only where shared
  mutable state is unavoidable (the SQLite connection pool is `Arc<Pool<Sqlite>>` and does
  not need wrapping).

## 7. Observability

- **Activity log** in SQLite (`activity_log` table) is the always-on record; it backs the
  Recent Activity panel in the UI.
- **Structured logs** via `tracing` + `tracing-subscriber` to a rotating file at
  `cache/logs/iptv-hub.log` (7-day retention).
- **No telemetry to the network** in v1. Local-only.

## 8. Diagrams

- [`docs/diagrams/system-architecture.mmd`](./docs/diagrams/system-architecture.mmd) — the
  picture above as Mermaid.
- [`docs/diagrams/update-state-machine.mmd`](./docs/diagrams/update-state-machine.mmd) — the
  per-app lifecycle.
- [`docs/diagrams/git-update-flow.mmd`](./docs/diagrams/git-update-flow.mmd) — git-specific
  sequence.
- [`docs/diagrams/release-update-flow.mmd`](./docs/diagrams/release-update-flow.mmd) — release
  binary sequence.
- [`docs/diagrams/installer-update-flow.mmd`](./docs/diagrams/installer-update-flow.mmd) —
  MSI/EXE sequence.
