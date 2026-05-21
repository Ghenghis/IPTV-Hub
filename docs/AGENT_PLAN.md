# IPTV Hub — Agent Build Plan

24 parallel slices. Each agent owns one slice end-to-end: implementation, tests, docs,
CHANGELOG. Slices are designed to **minimise inter-agent coupling**; agents talk only
through documented interfaces (manifest schema, DB schema, the `Source` trait, Tauri
command signatures).

> Read [`CONTRACT.md`](../CONTRACT.md) first. Read your slice. Then implement. **No
> stubs, no placeholders, no mocks-only tests.**

## Dependency wave order

Agents within the same wave run in parallel. A wave does not start until the previous wave
has merged.

```
Wave 1 (foundations, no inter-deps):
  01 Repo scaffold      02 Tokens/CSS        03 Manifest schema    04 DB & migrations
  19 Scripts            20 CI                21 Pre-commit hooks

Wave 2 (depends on Wave 1):
  05 Source trait + git impl     06 Release source    07 Installer source
  08 Web source                  09 Tizen source       10 Poller
  11 Rollback engine             12 Smoke test runner  13 Launcher (process spawn)
  14 Tauri commands (IPC)        15 Manifest loader / writer

Wave 3 (depends on Wave 2):
  16 Title bar + chip bar UI     17 App card component
  18 Update modal                22 Activity log + status bar
  23 Settings/sources page       24 Seed-from-folder UX

Wave 4 (depends on Wave 3):
  E2E + release packaging — all hands; no new slices.
```

## Slice catalogue

Every entry below has: **owns**, **depends on**, **must produce**, **acceptance**.

---

### Agent 01 — Repo scaffold

**Owns:** `Cargo.toml` (workspace), `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
`src-tauri/build.rs`, `src-tauri/src/main.rs` (entry point only, no business logic),
`frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`,
`frontend/index.html` (skeleton), `.editorconfig`, `.gitignore`, `LICENSE`.

**Depends on:** nothing.

**Must produce:**

- A workspace that builds with `cargo build --workspace` and `npm install && npm run build`
  from a clean clone with zero warnings.
- `cargo tauri info` reports a sensible config.
- `npm run dev` opens a placeholder page that says "IPTV Hub" using
  `frontend/src/styles/tokens.css` (Agent 02 owns the CSS itself; this agent just imports it).

**Acceptance:**

- `scripts/doctor.ps1` (Agent 19) reports PASS on a Windows runner.
- `scripts/run-dev.ps1` brings up Tauri dev mode and the window renders.

---

### Agent 02 — Design tokens & CSS

**Owns:** `frontend/src/styles/tokens.css`, `reset.css`, `base.css`, `components.css`.
Specifies and implements the full token system from [`UI_SPEC.md`](./UI_SPEC.md).

**Depends on:** nothing.

**Must produce:**

- All tokens in §2 of UI_SPEC implemented as CSS custom properties.
- Dark / light mode switching via `prefers-color-scheme` and a `data-theme` override on
  `<html>`.
- A Storybook-free preview page at `frontend/preview.html` that renders every component
  state side-by-side for visual regression.

**Acceptance:**

- Visual diff (Playwright `toHaveScreenshot`) of `preview.html` against the approved
  reference screenshots checked into `frontend/tests/snapshots/`.

---

### Agent 03 — Manifest schema

**Owns:** `schema/apps.schema.json`, `schema/examples/*.json` (one example per source
type plus a full 28-app example built from the user's actual folder list).
Implementation in `src-tauri/src/manifest/schema.rs` (codegen via `schemafy` or
`typify` to produce Rust types from the JSON Schema).

**Depends on:** Agent 01.

**Must produce:**

- A JSON Schema 2020-12 file matching [`MANIFEST_SCHEMA.md`](./MANIFEST_SCHEMA.md) exactly.
- Generated or hand-rolled Rust types in `src-tauri/src/manifest/types.rs` with full
  `serde` support and round-trip tests.
- A `validate` function that returns structured errors with the exact JSON Pointer of
  the violation.

**Acceptance:**

- Every example in `schema/examples/` validates.
- A deliberately-malformed manifest in `tests/fixtures/manifests/bad_*.json` fails
  validation with the expected error message.
- 100% of fields in `MANIFEST_SCHEMA.md` are exercised by at least one example.

---

### Agent 04 — Database & migrations

**Owns:** `src-tauri/src/db/mod.rs`, `src-tauri/src/db/queries.rs`,
`src-tauri/migrations/001_initial.sql`, the `Pool<Sqlite>` setup, the
`AppRepository` / `ActivityLogRepository` / `SnapshotRepository` traits.

**Depends on:** Agent 01.

**Must produce:**

- The schema in [`DATABASE.md`](./DATABASE.md) as a real `sqlx` migration.
- All queries compile-time-checked with `sqlx::query!` against a checked-in
  `sqlx-data.json` (or runtime-only with `query_as`, but compile-time preferred).
- Backup of `iptv-hub.db` to `iptv-hub.db.bak` before every migration run.

**Acceptance:**

- `cargo sqlx prepare` succeeds in CI without a running database.
- Integration test runs migrations from empty, inserts canned data via the repos, reads
  it back, and asserts shape.

---

### Agent 05 — Source trait + `git` implementation

**Owns:** `src-tauri/src/sources/mod.rs` (trait), `src-tauri/src/sources/git.rs`,
real git integration tests under `tests/integration_git.rs`.

**Depends on:** Agents 03, 04.

**Must produce:**

- The `Source` trait (see `ARCHITECTURE.md` §4).
- A full git implementation that does real `git fetch`, real `merge --ff-only`, real
  history-rewrite detection. Uses `git2-rs`.
- The integration test sets up real bare repos via `git2-rs` (no mocking), exercises
  every step in [`UPDATE_FLOWS.md`](./UPDATE_FLOWS.md) §2.
- The plan output matches the structure consumed by the Update modal (Agent 18).

**Acceptance:**

- `cargo test --test integration_git` passes on Linux, macOS, and Windows.
- A test that force-pushes the "remote" and confirms the apply step refuses with the
  documented error string.

---

### Agent 06 — `release-binary` source

**Owns:** `src-tauri/src/sources/release.rs`, `tests/integration_release.rs`.

**Depends on:** Agents 03, 04, 05 (the `Source` trait).

**Must produce:**

- GitHub releases probing (the API call), asset pattern matching, download with resume,
  SHA-256 verification, install via `extract` / `run-installer` / `copy` strategies.
- The integration test stands up a real local HTTP server serving real-looking release
  JSON and binary files with known SHA-256s.
- Handling of the `sha256_required: true` policy when no hash is published.

**Acceptance:**

- Tests cover: happy path, hash mismatch, asset pattern mismatch, network drop with
  resume, GitHub rate-limit response (`X-RateLimit-Remaining: 0`).

---

### Agent 07 — `installer` source

**Owns:** `src-tauri/src/sources/installer.rs`, `tests/integration_installer.rs`.

**Depends on:** Agents 03, 04, 05.

**Must produce:**

- Reading current version from the registry via `windows-rs`.
- Downloading the MSI/EXE, verifying SHA-256.
- Running silent install with `install_args`.
- Snapshotting the registry uninstall key for rollback.
- The integration test builds a real tiny MSI via WiX (script in
  `tests/fixtures/installers/build.ps1`) and verifies the full cycle.

**Acceptance:**

- Test is gated `#[cfg(windows)]` and runs in CI on the Windows runner.
- Failure path: a deliberately broken MSI returns non-zero; rollback restores the prior
  registry entry.

---

### Agent 08 — `web` source

**Owns:** `src-tauri/src/sources/web.rs`, `tests/integration_web.rs`.

**Depends on:** Agents 03, 04, 05, 13 (launcher for dev-server start).

**Must produce:**

- Git-source behaviour for fetch, plus lockfile change detection and `npm/yarn/pnpm/bun
  ci/install` execution after pull.
- Port discovery and reservation so two web apps don't collide on the same port.
- Integration test against a real tiny Node project committed under
  `tests/fixtures/apps/tiny-web-app/`.

**Acceptance:**

- Test installs deps, starts the dev server, hits its health endpoint, kills it.
- Test verifies port collision detection by starting a dummy listener and asserting the
  source picks a different port.

---

### Agent 09 — `tizen-ipk` source

**Owns:** `src-tauri/src/sources/tizen.rs`, `tests/integration_tizen.rs`.

**Depends on:** Agents 03, 04, 05.

**Must produce:**

- Fetch and verify (real HTTP fixture, real SHA-256).
- A `sdb` wrapper that calls a real `sdb` binary if found, or a fixture binary at
  `tests/fixtures/bin/sdb` during tests.
- The deploy action records its outcome separately from fetch outcomes.

**Acceptance:**

- Fetch test against the HTTP fixture passes end-to-end.
- Deploy test using the fixture `sdb` exercises happy path and "no devices" path.

---

### Agent 10 — Poller

**Owns:** `src-tauri/src/poller.rs`, `tests/integration_poller.rs`.

**Depends on:** Agent 04, 05–09 (all sources implementing the trait).

**Must produce:**

- A long-lived tokio task that wakes every `interval_minutes` with `jitter_seconds`.
- Bounded concurrency via `tokio::sync::Semaphore` (default 4).
- Per-app back-off after 3 consecutive failures.
- A `force_poll(app_id)` method invoked by the "Sync now" button.

**Acceptance:**

- Integration test seeds 8 apps and asserts at most 4 are in-flight at any time
  (measured via instrumentation).
- Back-off test deliberately fails an app 3 times and asserts the next scheduled poll is
  ≥ 1 hour out.

---

### Agent 11 — Rollback engine

**Owns:** `src-tauri/src/rollback.rs`, `tests/integration_rollback.rs`.

**Depends on:** Agents 03, 04, 11.

**Must produce:**

- `take(app)` — tar.zst snapshot using `zstd`-rs and `tar`-rs (no shelling out).
- `restore(app, snapshot_id)` — universal restore.
- Daily expiry sweep.
- Crash-safe behaviour: if the app process dies while a `swap` is in progress, the next
  launch detects the half-state and restores.

**Acceptance:**

- Snapshot/restore round-trips on a real tree with symlinks, large binary files, and
  empty directories.
- Crash-recovery test uses `kill -9` (signal on Unix; `TerminateProcess` on Windows) in
  the middle of a swap and asserts the next launch restores cleanly.

---

### Agent 12 — Smoke test runner

**Owns:** `src-tauri/src/smoke_test.rs`, `tests/integration_smoke.rs`.

**Depends on:** Agents 03, 04, 13.

**Must produce:**

- The four `wait_for`/`HealthSpec` kinds (port, process, http, none) with real probing,
  no mocking of the actual probe.
- Configurable per-kind timeout, returning rich errors.

**Acceptance:**

- One integration test per kind:
  - port: opens a real TCP listener, asserts smoke succeeds within 1 s.
  - process: spawns a real `sleep`/`timeout` process, asserts process detection works.
  - http: starts a real local HTTP server returning 200, asserts smoke succeeds.
  - none: asserts smoke returns OK immediately.

---

### Agent 13 — Launcher (process spawn)

**Owns:** `src-tauri/src/launcher.rs`, `tests/integration_launcher.rs`.

**Depends on:** Agents 03, 04.

**Must produce:**

- `launch(app)` resolving `LaunchSpec.kind` to a concrete subprocess invocation.
- Output tail to the activity log (bounded buffer).
- `stop(app)` that sends SIGTERM, then SIGKILL after a 5 s grace period.
- Per-app singleton: launching an already-running app focuses the existing window where
  possible (Windows-only via `FindWindow` from `windows-rs`).

**Acceptance:**

- Tests launch and stop a real subprocess (a tiny test helper binary built in
  `tests/fixtures/bin/`).
- Output capture test asserts that the activity log received the expected lines within
  the bounded buffer.

---

### Agent 14 — Tauri commands (IPC)

**Owns:** `src-tauri/src/commands/*.rs`, `frontend/src/lib/api.ts`, `frontend/src/lib/events.ts`,
`docs/IPC.md` (new doc the agent authors as part of this slice).

**Depends on:** Agents 03, 04, 05–13 (so the commands can call into real handlers).

**Must produce:**

- The full command surface:
  - `list_apps()`, `get_app(id)`, `add_app(entry)`, `remove_app(id)`, `set_favorite(id, bool)`,
    `set_enabled(id, bool)`.
  - `check_for_update(id)`, `plan_update(id)`, `apply_update(id)`, `rollback(id, snapshot_id)`.
  - `launch(id)`, `stop(id)`.
  - `seed_from_folder(path)`.
  - `get_settings()`, `set_setting(key, value)`.
  - `list_activity(limit, offset)`, `list_update_history(app_id, limit)`,
    `list_snapshots(app_id)`.
- Strongly typed Rust DTOs (no `serde_json::Value` anywhere on the boundary).
- A matching TypeScript wrapper for every command, with full type definitions.

**Acceptance:**

- Round-trip test per command: invoke from TS in a headless Tauri test, assert payloads.
- Every command appears in `docs/IPC.md` with: signature, errors, example payload.

---

### Agent 15 — Manifest loader / writer

**Owns:** `src-tauri/src/manifest/mod.rs`, `src-tauri/src/manifest/loader.rs`,
`src-tauri/src/manifest/writer.rs`, `src-tauri/src/manifest/migrations/`.

**Depends on:** Agent 03.

**Must produce:**

- Atomic load: read → validate → migrate (if needed) → write back.
- Atomic write: temp file + rename + bak.
- File-lock to prevent concurrent writes (advisory lock via `fs2`).
- Tests covering: well-formed v1, well-formed v0 (forces a migration), malformed,
  duplicate id, missing required fields.

**Acceptance:**

- 100 % of error paths from `MANIFEST_SCHEMA.md` are tested.

---

### Agent 16 — Title bar & chip bar

**Owns:** `frontend/src/components/title-bar.ts`, `frontend/src/components/chip-bar.ts`,
their styles in `components.css`, tests in `frontend/tests/components/`.

**Depends on:** Agents 02, 14.

**Must produce:**

- `<iptv-title-bar>` with search input, sync button, settings button.
- `<iptv-chip-bar>` with the seven canonical chips from UI_SPEC §3.2.
- Both emit DOM events (`iptv:search`, `iptv:sync`, `iptv:filter`) consumed by the main
  page.

**Acceptance:**

- Visual test matches the snapshot in `frontend/tests/snapshots/title-and-chip-bar.png`.
- Keyboard test: Tab through chips lands focus in the expected order; Enter activates.

---

### Agent 17 — App card

**Owns:** `frontend/src/components/app-card.ts`, its styles.

**Depends on:** Agents 02, 14, 16.

**Must produce:**

- `<iptv-app-card app="..."` attribute receives a JSON-serialized `AppView`.
- Renders rows 1, 2, 3 from UI_SPEC §3.3.
- Emits `iptv:launch`, `iptv:update`, `iptv:menu` events.
- Reactive: re-renders when its `app` attribute changes (no manual rerender call needed).

**Acceptance:**

- Visual snapshot covers `ok`, `update_available`, `error`, `idle` states.
- Test asserts that clicking **Launch** with an `idle` status app emits `iptv:launch`
  but the visual indicator changes optimistically.

---

### Agent 18 — Update preview modal

**Owns:** `frontend/src/components/update-modal.ts`, its styles.

**Depends on:** Agents 02, 14, 17.

**Must produce:**

- `<iptv-update-modal>` opens with `open(planJson)` and emits `iptv:apply` / `iptv:cancel`.
- Renders all five sections from UI_SPEC §3.4 using **only** data from the plan; no
  hand-written copy in the frontend.

**Acceptance:**

- Visual snapshot covers a git plan, a release plan, an installer plan, a tizen plan.
- Test asserts that pressing Esc emits `iptv:cancel`.

---

### Agent 19 — Scripts

**Owns:** every script in `scripts/`. Both `.ps1` and `.sh` for parity.

**Depends on:** Agent 01.

**Must produce:**

- `doctor` — checks: Node ≥ 20, Rust toolchain matches `rust-toolchain.toml`, WebView2
  runtime present, no ports in use, free disk space.
- `run-dev` — `cargo tauri dev` with logging set to `info`.
- `test`, `format`, `lint`, `build`, `release`.
- `pre-commit` — runs format-check, lint, forbid-stubs.
- `forbid-stubs` — scans runtime paths for the tokens in CONTRACT §2.1.
- `seed-apps` — scans a directory and produces a draft `apps.json`.

**Acceptance:**

- Every script runs on PowerShell 7 + and Bash 5 +.
- PSScriptAnalyzer and shellcheck both clean.
- Doctor reports PASS on a clean Windows 11 install with prerequisites installed.

---

### Agent 20 — CI

**Owns:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
`.github/workflows/security.yml`, `.github/dependabot.yml`,
`.github/PULL_REQUEST_TEMPLATE.md`.

**Depends on:** Agent 19.

**Must produce:**

- `ci.yml`: matrix on Windows + Linux for build, but the Windows runner is the only one
  required to be green for merge (Linux runs faster checks).
- Security workflow: `cargo audit`, `npm audit --omit=dev`, secret scan
  (`trufflehog filesystem`).
- Release workflow per `PACKAGING.md`.
- Dependabot weekly for cargo + npm + actions.

**Acceptance:**

- A "tripwire" PR with a deliberate stub (`todo!()`) is failed by the CI's
  `forbid-stubs` step.
- A "tripwire" PR with a deliberate clippy warning is failed.
- A "tripwire" PR with a deliberate tsc error is failed.

---

### Agent 21 — Pre-commit hooks

**Owns:** `.husky/`, `lefthook.yml` (the agent picks one and removes the other; preference
is `lefthook` because it has Rust+JS support natively).

**Depends on:** Agent 19.

**Must produce:**

- `pre-commit`: format, lint-staged, forbid-stubs scan.
- `pre-push`: tsc, cargo check, cargo clippy -- -D warnings.

**Acceptance:**

- Hooks installed by `npm install`. A deliberate stub commit fails at pre-commit, not
  later.

---

### Agent 22 — Activity log & status bar

**Owns:** `frontend/src/components/activity-log.ts`, `frontend/src/components/status-bar.ts`,
their styles, plus the IPC events `activity:new` and `status:changed` subscription on the
frontend.

**Depends on:** Agents 02, 14.

**Must produce:**

- Recent Activity panel showing the 4 most-recent rows (UI_SPEC §3.5).
- Status bar with live counts (UI_SPEC §3.6).
- A "Show all" action that navigates to the full activity page.

**Acceptance:**

- Visual snapshot of both components against a canned activity dataset.
- Live-update test: emit an `activity:new` event and assert the panel reflects it within
  the next animation frame.

---

### Agent 23 — Settings / Sources page

**Owns:** `frontend/src/pages/settings.ts`, `frontend/src/pages/settings.css`.

**Depends on:** Agents 14, 17.

**Must produce:**

- A page with three tabs: **General** (theme, poll interval, app-data roots),
  **Sources** (full CRUD on every manifest entry), **Update history** (a global view).
- Sources tab uses the `<iptv-app-card>` component in a list-mode variant for editing.

**Acceptance:**

- End-to-end test adds an app, edits its launch command, disables polling, removes it,
  asserting `apps.json` reflects every change.

---

### Agent 24 — Seed-from-folder

**Owns:** `src-tauri/src/seed.rs`, `frontend/src/pages/seed.ts`, the matching command in
the IPC surface.

**Depends on:** Agents 03, 14, 15.

**Must produce:**

- A scanner that classifies a directory:
  - Has `.git`? → `git` source.
  - Has `package.json` but no `.git`? → `web` source pinned at current state.
  - Lives under `Program Files`? → `installer` candidate; user is asked for the
    registry key.
  - Has a `.ipk` file alongside? → `tizen-ipk`.
  - Otherwise → `executable` launch only (no update source).
- A UI wizard that shows the proposed manifest, lets the user edit each row, and saves
  to `apps.json`.
- Uses the user's actual 28-folder input (`AuthoIPTV`, `cinexa`, `clubtivi-windows`,
  `Extreme-InfiniTV`, `free-tv-iptv`, `HarmonyIPTV`, `IPTauriV`, `iptv`, `iptvnator`,
  `IPTV-Restream`, `iptv-stream`, `MaxVideoPlayer`, `neptune-tv`, `NuvioWeb`, `open-tv`,
  `orbiscast`, `PiTV`, `react-iptv`, `Smart-IPTV-Web`, `stalker-ui`, `stremio`, `TVapp`,
  `wizju-iptv-player`, `xstream-player`, `ynotv`, plus installer files) as the golden
  test fixture for the seed scanner. Expected output is checked into
  `tests/fixtures/seed/expected-apps.json` and the test must reproduce it byte-for-byte.

**Acceptance:**

- Seed test against the canonical fixture produces the expected manifest.
- All 28 entries have correct source-type classification, a defaulted launch spec, and
  a defaulted icon.

---

## Cross-cutting rules every agent follows

1. Every PR updates `CHANGELOG.md` `[Unreleased]`.
2. Every PR runs `scripts/pre-commit.sh` locally before pushing.
3. Every PR keeps the doc affected by the slice in sync (e.g. Agent 14 owns `docs/IPC.md`).
4. If an agent needs a new dependency, they justify it in the PR description and update
   `cargo audit` / `npm audit` baselines.
5. **An agent that finishes early picks up the next-wave's foundational slice rather
   than gold-plating their own.** Gold-plating produces AI slop.

## What the human owner does

- Reviews architecture-level changes (new boundaries, new sources, schema bumps).
- Approves the visual snapshots after Agent 02 + 16/17/18/22 land.
- Runs the manual Tizen TV deploy test before each release.
- Tags releases.
