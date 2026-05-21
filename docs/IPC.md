# IPTV Hub — IPC Reference

The Tauri runtime exposes an 18-command IPC surface to the frontend. Every command is
declared in [`src-tauri/src/main.rs`](../src-tauri/src/main.rs) inside
`tauri::generate_handler![]` and lives in a submodule of
[`src-tauri/src/commands/`](../src-tauri/src/commands/). The TypeScript wrapper
[`frontend/src/lib/api.ts`](../frontend/src/lib/api.ts) is the single source of truth
on the JS side — its shape mirrors what is documented here byte-for-byte.

## Conventions

- **Errors.** Every command returns `Result<T, CoreError>`. `CoreError` is the
  serializable enum defined in [`src-tauri/src/errors.rs`](../src-tauri/src/errors.rs):

  ```jsonc
  // { "kind": "config", "message": "…" }            // bad input / unknown id
  // { "kind": "io",     "path": "…", "message": "…" }
  // { "kind": "git",    "message": "…" }
  // { "kind": "not_fast_forward", "message": "…" }
  // { "kind": "network", "message": "…" }
  // { "kind": "sha_mismatch", "expected": "…", "got": "…" }
  // { "kind": "not_supported", "message": "…" }
  // { "kind": "post_update_failed", "message": "…" }
  // { "kind": "smoke_failed", "message": "…" }
  // { "kind": "internal", "message": "…" }          // sqlx, unexpected
  ```

- **Argument names.** Tauri marshals JS argument names to Rust parameter names
  one-to-one. The frontend uses camelCase (`api.activity.history(appId, …)`) which
  Tauri rewrites to snake_case (`app_id`) on the wire — that is why
  `list_update_history` accepts `appId` in TS and `app_id` in Rust.

- **Side effects.** `add_app`, `remove_app`, `set_favorite`, `set_enabled`,
  `set_setting`, `apply_update`, and `rollback` mutate the manifest or the database
  and append to the `activity_log` table. The poller (Wave 2, Agent 10) drives
  `check_for_update` automatically; manual invocation from the UI uses the same code
  path.

- **Events.** `apply_update` additionally emits `iptv-hub://progress` payloads on the
  Tauri event bus while running. Subscribers wire up via
  [`frontend/src/lib/events.ts`](../frontend/src/lib/events.ts).

---

## Command index (as registered in `main.rs`)

| # | Command | Submodule | Mutates |
| - | --- | --- | --- |
| 1 | `list_apps` | `commands::apps` | no |
| 2 | `get_app` | `commands::apps` | no |
| 3 | `add_app` | `commands::apps` | yes (manifest + `apps` row) |
| 4 | `remove_app` | `commands::apps` | yes |
| 5 | `set_favorite` | `commands::apps` | yes (manifest) |
| 6 | `set_enabled` | `commands::apps` | yes (manifest) |
| 7 | `check_for_update` | `commands::updates` | yes (`apps` row, activity) |
| 8 | `plan_update` | `commands::updates` | no |
| 9 | `apply_update` | `commands::updates` | yes (apps, snapshots, history, activity) |
| 10 | `rollback` | `commands::updates` | yes |
| 11 | `launch` | `commands::launch` | yes (activity log only) |
| 12 | `stop` | `commands::launch` | yes (activity log only) |
| 13 | `get_settings` | `commands::settings` | no |
| 14 | `set_setting` | `commands::settings` | yes (settings + activity) |
| 15 | `list_activity` | `commands::activity` | no |
| 16 | `list_update_history` | `commands::activity` | no |
| 17 | `list_snapshots` | `commands::activity` | no |
| 18 | `seed_from_folder` | `commands::seed` | no |

---

### 1 — `list_apps() -> Vec<AppView>`

**Source**: `src-tauri/src/commands/apps.rs` — function `list_apps`.

**TS signature**: `api.apps.list(): Promise<AppView[]>`.

Joins the in-memory manifest (one `AppEntry` per app) with the per-row state in the
`apps` SQL table so the frontend gets static config + runtime status in one call.

**Errors**:
- `CoreError::Internal` — when the underlying `SELECT … FROM apps` fails (any
  `sqlx::Error` is mapped here).

**Request**: `{}` (no arguments).

**Response**:

```jsonc
[
  {
    "id": "iptvnator",
    "name": "iptvnator",
    "source_type": "git",
    "favorite": true,
    "enabled": true,
    "status": "ok",
    "status_message": null,
    "current_version": null,
    "current_sha": "9f2a1b0",
    "last_poll_at": "2025-05-21T08:14:33Z",
    "last_success_at": "2025-05-21T08:14:33Z",
    "icon_kind": "initials",
    "icon_value": "PT",
    "sub_label": "upstream/iptvnator"
  }
]
```

---

### 2 — `get_app(id: String) -> AppView`

**Source**: `src-tauri/src/commands/apps.rs` — function `get_app`.

**TS signature**: `api.apps.get(id: string): Promise<AppView>`.

Convenience wrapper around `list_apps` that returns the single row matching `id`.

**Errors**:
- `CoreError::Config { message: "app not found: <id>" }` — when no manifest entry
  matches `id`.
- `CoreError::Internal` — propagated from the underlying `list_apps` query.

**Request**: `{ "id": "iptvnator" }`

**Response**: same `AppView` shape as one element of `list_apps`'s response.

---

### 3 — `add_app(entry: AppEntry) -> ()`

**Source**: `src-tauri/src/commands/apps.rs` — function `add_app`.

**TS signature**: `api.apps.add(entry: AppEntry): Promise<void>`.

Appends `entry` to the manifest, persists `apps.json` atomically (temp + rename),
and inserts a matching idle row into the `apps` table. The seed-from-folder wizard
calls this once per enabled row.

`AppEntry` matches the shape documented in
[`docs/MANIFEST_SCHEMA.md`](./MANIFEST_SCHEMA.md) §2 — the JSON `type` field is the
kebab-case `SourceType` enum (`git`, `release-binary`, `installer`, `web`,
`tizen-ipk`).

**Errors**:
- `CoreError::Config { message: "duplicate app id: <id>" }` — when an entry with
  the same `id` already exists.
- `CoreError::Io` — when persisting the manifest fails.
- `CoreError::Internal` — when the `INSERT OR IGNORE INTO apps` statement fails.

**Request**:

```jsonc
{
  "entry": {
    "id": "iptvnator",
    "name": "iptvnator",
    "type": "git",
    "favorite": false,
    "enabled": true,
    "icon": { "kind": "initials", "value": "PT" },
    "polling": { "enabled": true, "interval_minutes": 60, "jitter_seconds": 30 },
    "launch": { "kind": "executable", "cwd": "iptvnator", "args": [], "env": {} },
    "source": {
      "url": "https://github.com/4gray/iptvnator.git",
      "branch": "main",
      "fetch_strategy": "fast-forward-only"
    }
  }
}
```

**Response**: `null` (Rust `()`).

---

### 4 — `remove_app(id: String) -> ()`

**Source**: `src-tauri/src/commands/apps.rs` — function `remove_app`.

**TS signature**: `api.apps.remove(id: string): Promise<void>`.

Removes the manifest entry for `id`, atomically rewrites `apps.json`, and deletes
the matching `apps` row. The DB schema cascades `app_id` references in
`activity_log` and related tables to `NULL` so historical rows survive the delete.

**Errors**:
- `CoreError::Config { message: "app not found: <id>" }` — no entry with that id.
- `CoreError::Io` — when persisting the manifest fails.
- `CoreError::Internal` — when the `DELETE FROM apps` statement fails.

**Request**: `{ "id": "iptvnator" }`

**Response**: `null`.

---

### 5 — `set_favorite(id: String, favorite: bool) -> ()`

**Source**: `src-tauri/src/commands/apps.rs` — function `set_favorite`.

**TS signature**: `api.apps.setFavorite(id: string, favorite: boolean): Promise<void>`.

Toggles the `favorite` flag on the named manifest entry and persists the manifest.
The frontend uses this from the heart-star button on every app card.

**Errors**:
- `CoreError::Config { message: "app not found: <id>" }` — no entry matches.
- `CoreError::Io` — when persisting the manifest fails.

**Request**: `{ "id": "iptvnator", "favorite": true }`

**Response**: `null`.

---

### 6 — `set_enabled(id: String, enabled: bool) -> ()`

**Source**: `src-tauri/src/commands/apps.rs` — function `set_enabled`.

**TS signature**: `api.apps.setEnabled(id: string, enabled: boolean): Promise<void>`.

Toggles the `enabled` flag on the named manifest entry. A disabled app is hidden
from the poller and refused at launch time, but the row stays in `apps.json` so a
later toggle restores it without re-seeding.

**Errors**:
- `CoreError::Config { message: "app not found: <id>" }`.
- `CoreError::Io` — when persisting the manifest fails.

**Request**: `{ "id": "iptvnator", "enabled": false }`

**Response**: `null`.

---

### 7 — `check_for_update(id: String) -> UpdateState`

**Source**: `src-tauri/src/commands/updates.rs` — function `check_for_update`.

**TS signature**: `api.updates.check(id: string): Promise<UpdateState>`.

Dispatches to the `Source` implementation for the app's `type`, runs the source's
`check`, and persists the outcome to the `apps` row (status, last_poll_at,
last_success_at / last_failure_at, consecutive_failures). Appends one
`activity_log` row.

`UpdateState` is a tagged union (`#[serde(tag = "kind", rename_all = "snake_case")]`):

```jsonc
{ "kind": "up_to_date",        "current": "9f2a1b0" }
{ "kind": "update_available",  "from": "9f2a1b0", "to": "4c8e1d2", "summary": "3 commits ahead" }
{ "kind": "error",             "message": "git: connection refused" }
```

**Errors**:
- `CoreError::Config { message: "app not found: <id>" }`.
- `CoreError::Git`, `CoreError::Network`, `CoreError::Io`, … — surfaced from the
  source's `check` implementation. Each is also recorded as an `error`-level
  `activity_log` row.
- `CoreError::Internal` — when the DB update or activity write fails (best
  effort: the function returns the source's result regardless).

**Request**: `{ "id": "iptvnator" }`

**Response**:

```jsonc
{ "kind": "update_available", "from": "9f2a1b0", "to": "4c8e1d2", "summary": "3 commits ahead on main" }
```

---

### 8 — `plan_update(id: String) -> UpdatePlan`

**Source**: `src-tauri/src/commands/updates.rs` — function `plan_update`.

**TS signature**: `api.updates.plan(id: string): Promise<UpdatePlan>`.

Read-only — produces the modal body for the update sheet. No DB writes, no
filesystem side effects.

**Errors**:
- `CoreError::Config { message: "app not found: <id>" }`.
- `CoreError::Git`, `CoreError::Network`, `CoreError::Io`, … — surfaced from the
  source's `plan` (each source decides which checks it must run to build the
  plan; for `git`, that includes a fetch from origin).

**Request**: `{ "id": "iptvnator" }`

**Response**:

```jsonc
{
  "app_id": "iptvnator",
  "source_type": "git",
  "from_label": "9f2a1b0",
  "to_label": "4c8e1d2",
  "from_meta": [{ "key": "branch", "value": "main" }],
  "to_meta":   [{ "key": "branch", "value": "main" }],
  "incoming": [
    { "kind": "commit", "sha": "4c8e1d2", "message": "fix: m3u parser", "author": "4gray" }
  ],
  "steps": [
    { "title": "Fetch origin", "detail": null, "tag": "safe" },
    { "title": "Fast-forward main", "detail": null, "tag": "safe" },
    { "title": "npm ci", "detail": "≈ 90s", "tag": "time_estimate" }
  ],
  "rollback_retention_days": 7
}
```

---

### 9 — `apply_update(id: String) -> UpdateOutcome`

**Source**: `src-tauri/src/commands/updates.rs` — function `apply_update`.

**TS signature**: `api.updates.apply(id: string): Promise<UpdateOutcome>`.

End-to-end update flow:

1. Re-runs `Source::plan` to defeat any stale-plan race window.
2. Snapshots the upstream directory (if present) and records a row in `snapshots`.
3. Writes a swap marker via `rollback::begin_swap` — crash recovery uses this.
4. Spawns the progress pump that drains `ProgressEvent`s onto the
   `iptv-hub://progress` event bus.
5. Calls `Source::apply`. On success: commits the swap, updates `apps.current_version` /
   `current_sha`, writes an `update_history` row, and logs activity. On failure:
   drops the swap guard (the marker stays on disk so the next launch can restore
   the snapshot), marks `apps` as `error`, and writes a failure row to
   `update_history`.

Concurrent emissions on `iptv-hub://progress` (see
`frontend/src/lib/events.ts::ProgressEvent`):

```jsonc
{ "app_id": "iptvnator", "step": "fetch", "message": "fetching origin",
  "bytes_done": 1024, "bytes_total": 8192 }
```

**Errors**:
- `CoreError::Config` — app not found, manifest write failure.
- `CoreError::Io` — snapshot creation, swap-marker write failure.
- `CoreError::Git`, `CoreError::Network`, `CoreError::ShaMismatch`,
  `CoreError::PostUpdateFailed`, `CoreError::SmokeFailed`, … — propagated verbatim
  from the source's `apply`.
- `CoreError::Internal` — `INSERT INTO snapshots` failure or other DB error.

**Request**: `{ "id": "iptvnator" }`

**Response**:

```jsonc
{
  "new_version": null,
  "new_sha": "4c8e1d2",
  "bytes_downloaded": 162840,
  "elapsed_ms": 4231,
  "messages": ["fast-forwarded main 9f2a1b0..4c8e1d2", "npm ci ok"]
}
```

---

### 10 — `rollback(id: String, snapshot_id: String) -> ()`

**Source**: `src-tauri/src/commands/updates.rs` — function `rollback`.

**TS signature**: `api.updates.rollback(id: string, snapshotId: string): Promise<void>`.

Restores the upstream directory from a snapshot row. The source's `rollback` hook
is tried first (the installer source re-runs the uninstaller before extracting);
if the source returns `CoreError::NotSupported`, the orchestrator falls back to a
plain `restore_archive` of the upstream directory.

**Errors**:
- `CoreError::Config { message: "app not found: <id>" }`.
- `CoreError::Config { message: "snapshot '<id>' not found for app '<app>'" }` —
  no row in `snapshots` matches the (`app_id`, `snapshot_id`) pair.
- `CoreError::Config { message: "snapshot archive missing on disk: <path>" }` —
  the row exists but the archive file does not.
- `CoreError::Io`, `CoreError::Internal` — restore failure or DB write error.

**Request**: `{ "id": "iptvnator", "snapshotId": "snap-20250521-081433" }`

**Response**: `null`.

---

### 11 — `launch(id: String) -> ()`

**Source**: `src-tauri/src/commands/launch.rs` — function `launch`.

**TS signature**: `api.launch.launch(id: string): Promise<void>`.

Dispatches the app's `LaunchSpec` to the shared `LaunchRegistry`. Returns once the
child has been spawned and the `wait_for` probe (port/process/http) has resolved.
Writes one `activity_log` row (info on success, error on failure).

**Errors**:
- `CoreError::Config { message: "app not found: <id>" }`.
- `CoreError::Config` — when `LaunchRegistry` was not registered with
  `app.manage(...)` (a wiring bug).
- `CoreError::Io` — `Command::spawn` failure.
- `CoreError::SmokeFailed` — when the `wait_for` probe times out.
- `CoreError::Config { message: "already running: <id>" }` — duplicate launch.

**Request**: `{ "id": "iptvnator" }`

**Response**: `null`.

---

### 12 — `stop(id: String) -> ()`

**Source**: `src-tauri/src/commands/launch.rs` — function `stop`.

**TS signature**: `api.launch.stop(id: string): Promise<void>`.

Asks the registry to stop the tracked child. The call returns after the
registry's 5 s graceful phase plus the forced-kill phase, so the UI knows the
process is really gone before flipping the card status back to `idle`.

**Errors**:
- `CoreError::Config` — registry not managed (wiring bug).
- `CoreError::Config { message: "not running: <id>" }` — no tracked child.
- `CoreError::Io` — kill failure.

**Request**: `{ "id": "iptvnator" }`

**Response**: `null`.

---

### 13 — `get_settings() -> SettingsView`

**Source**: `src-tauri/src/commands/settings.rs` — function `get_settings`.

**TS signature**: `api.settings.get(): Promise<SettingsView>`.

Reads every row in the `settings` table and overlays it on top of the in-memory
`AppConfig` defaults. DB rows win when present; missing rows fall back to the
default so a fresh install still returns a fully-typed object.

**Errors**:
- `CoreError::Internal` — when the `SELECT … FROM settings` query fails.

**Request**: `{}`

**Response**:

```jsonc
{
  "theme": "system",
  "poll_concurrency": 4,
  "default_poll_interval_minutes": 15,
  "snapshot_retention_days": 7,
  "activity_log_retention_days": 30,
  "source_url_allowlist": ["github.com", "raw.githubusercontent.com"],
  "github_token": null
}
```

---

### 14 — `set_setting(key: String, value: String) -> ()`

**Source**: `src-tauri/src/commands/settings.rs` — function `set_setting`.

**TS signature**: `api.settings.set(key: string, value: string): Promise<void>`.

UPSERTs one row into the `settings` table. Keys are restricted to a hard-coded
whitelist (`ACCEPTED_KEYS` — `theme`, `poll_concurrency`,
`default_poll_interval_minutes`, `snapshot_retention_days`,
`activity_log_retention_days`, `source_url_allowlist`, `github_token`). Values
are type-checked against the corresponding field. Appends one `activity_log`
row recording the key that changed but never the value (the `github_token`
secret never lands in the log).

**Errors**:
- `CoreError::Config { message: "unknown setting key: <key>" }` — not in the
  whitelist.
- `CoreError::Config` — value fails per-key validation (`theme` must be
  `system|light|dark`, integer fields must parse to `>= 1`,
  `source_url_allowlist` must be a JSON array of non-empty strings,
  `github_token` must be empty or `>= 20` chars).
- `CoreError::Internal` — when the UPSERT itself fails.

**Request**: `{ "key": "theme", "value": "dark" }`

**Response**: `null`.

---

### 15 — `list_activity(limit: u32, offset: u32) -> Vec<ActivityEntry>`

**Source**: `src-tauri/src/commands/activity.rs` — function `list_activity`.

**TS signature**: `api.activity.list(limit: number, offset: number): Promise<ActivityEntry[]>`.

Returns activity-log rows newest-first. `limit` is silently clamped to a 1000
ceiling; a large `offset` past the end of data returns an empty array (not an
error) so the frontend can keep paging without a special end-of-data branch.

**Errors**:
- `CoreError::Internal` — when the SELECT fails.

**Request**: `{ "limit": 100, "offset": 0 }`

**Response**:

```jsonc
[
  {
    "id": 42,
    "at": "2025-05-21T08:14:33Z",
    "app_id": "iptvnator",
    "action": "check",
    "message": "update available · 9f2a1b0 -> 4c8e1d2",
    "level": "info"
  }
]
```

---

### 16 — `list_update_history(app_id: String, limit: u32) -> Vec<UpdateHistoryEntry>`

**Source**: `src-tauri/src/commands/activity.rs` — function `list_update_history`.

**TS signature**: `api.activity.history(appId: string, limit: number): Promise<UpdateHistoryEntry[]>`.

Returns `update_history` rows for one app, newest-first. Used by the per-app
"history" panel in the update modal. `limit` is clamped to 1000.

**Errors**:
- `CoreError::Internal` — when the SELECT fails.

**Request**: `{ "appId": "iptvnator", "limit": 50 }`

**Response**:

```jsonc
[
  {
    "id": 17,
    "started_at": "2025-05-21T08:14:32Z",
    "app_id": "iptvnator",
    "from_version": "9f2a1b0",
    "to_version": "4c8e1d2",
    "outcome": "ok",
    "error_message": null
  }
]
```

---

### 17 — `list_snapshots(app_id: String) -> Vec<SnapshotEntry>`

**Source**: `src-tauri/src/commands/activity.rs` — function `list_snapshots`.

**TS signature**: `api.activity.snapshots(appId: string): Promise<SnapshotEntry[]>`.

Returns every snapshot row for the given `app_id`, newest-first. Snapshots are
pruned by the retention worker so the row count is bounded — no pagination.

**Errors**:
- `CoreError::Internal` — when the SELECT fails.

**Request**: `{ "appId": "iptvnator" }`

**Response**:

```jsonc
[
  {
    "id": "snap-20250521-081433",
    "app_id": "iptvnator",
    "size_bytes": 318232,
    "sha256": "f3a1…b00d",
    "created_at": "2025-05-21T08:14:33Z"
  }
]
```

---

### 18 — `seed_from_folder(path: String) -> SeedScanView`

**Source**: `src-tauri/src/commands/seed.rs` — function `seed_from_folder`.

**TS signature**: `api.seed.fromFolder(path: string): Promise<SeedScanView>`.

Read-only. Delegates to `crate::seed::scan_directory` which walks every immediate
sub-directory of `path` and classifies each one (git → web → installer →
tizen-ipk → executable → unclassified). Returns the proposed manifest entries
plus the list of un-classifiable directories. The seed wizard in
[`frontend/src/pages/seed.ts`](../frontend/src/pages/seed.ts) calls this and then
fans out `add_app` calls per row.

**Errors**:
- `CoreError::Config { message: "seed root does not exist: <path>" }` — the
  argument does not exist on disk.
- `CoreError::Config { message: "seed scan root is not a directory: <path>" }` —
  the argument exists but is a file or other non-directory entry.
- `CoreError::Io` — when reading the directory or any of its entries fails.
- `CoreError::Config { message: "unreadable folder name: <path>" }` — when a
  candidate directory has a non-UTF-8 name.

**Request**: `{ "path": "C:\\IPTV\\upstream" }`

**Response**:

```jsonc
{
  "apps": [
    {
      "id": "iptvnator",
      "name": "iptvnator",
      "type": "git",
      "favorite": false,
      "enabled": true,
      "icon": { "kind": "initials", "value": "PT" },
      "polling": { "enabled": true, "interval_minutes": 60, "jitter_seconds": 30 },
      "launch": { "kind": "executable", "cwd": "iptvnator", "args": [], "env": {} },
      "source": { "url": "", "branch": "main", "fetch_strategy": "fast-forward-only" }
    }
  ],
  "unclassified": ["C:\\IPTV\\upstream\\loose-binary-dir"]
}
```
