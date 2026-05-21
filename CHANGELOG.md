# Changelog

All notable changes to IPTV Hub will be recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Phase 4 (2026-05-21)

- **Playwright E2E test infrastructure** at `frontend/tests/e2e/`. `shell.spec.ts`
  drives a real Chromium against the Vite-served frontend, asserts the title bar
  + chip bar render, every chip filter toggles to `aria-pressed=true`, the
  settings overlay opens and renders the Settings page. `preview.spec.ts` runs
  `toHaveScreenshot` against `preview.html` so any visual change to any
  component variant is caught before merge. CI workflow runs both on every push
  via `.github/workflows/ci.yml::playwright-e2e`, uploading the HTML report and
  visual-diff artifacts on failure.
- **`frontend/preview.html`** — standalone visual-regression preview page that
  renders every component in every documented state side-by-side (title bar,
  chip bar at 0 + mixed counts, app card in `ok` / `update_available` / `error`
  / `idle`, update modal opened with a git plan with safe/time/risky tags,
  activity log seeded with 4 fixture rows, status bar with mixed counts).
  Vite multi-page config emits both `dist/index.html` and `dist/preview.html`.
  Backs the Agent 02 acceptance `toHaveScreenshot` reference.
- **SECURITY_AUDIT.md** documenting the `cargo audit` + `npm audit --omit=dev`
  baseline: 1 medium-severity advisory (RUSTSEC-2023-0071, transitive `rsa` via
  `sqlx-mysql`, no runtime exposure), 18 unmaintained-gtk-rs warnings
  (Linux-only, not in Windows MSI), 0 npm production vulnerabilities. Per
  CONTRACT §3 no unaddressed critical/high.

### Added — Phase 3b (2026-05-21)

- **`<iptv-title-bar>` + `<iptv-chip-bar>`** Web Components extracted from the
  inline shell into `frontend/src/components/title-bar.ts` + `chip-bar.ts`.
  Emit `iptv:search`, `iptv:sync`, `iptv:settings`, `iptv:filter` (with `ChipKey`
  detail). Eight chips per UI_SPEC §3.2 (all, updates, favorites, git, web,
  installer, release, tizen) with the locked `--pill-*` colour tokens.
- **`<iptv-activity-log>` + `<iptv-status-bar>`** at
  `frontend/src/components/{activity-log,status-bar}.ts`. Subscribe to the
  `iptv-hub://activity` and `iptv-hub://status` Tauri events via `lib/events.ts`,
  prepend new rows and recompute live counts. Both store the `UnlistenFn` and
  release on `disconnectedCallback` (with a `#disposed` guard for the
  late-resolve race).
- **App-card event rename** from hyphen-form (`iptv-launch` etc.) to colon-form
  (`iptv:launch`, `iptv:update`, `iptv:menu`, `iptv:favorite`) per UI_SPEC §3.3.
  `observedAttributes()` now reacts to `app` attribute changes; secondary
  button follows the documented state machine (`ok` → "Up to date" disabled;
  `error` → "Retry"; `update_available` → "Update"; otherwise "Check").
- **Update-modal API** now exposes `open(plan, appName)` + `close()` (the
  property setter is preserved with `@deprecated`); emits `iptv:apply` /
  `iptv:cancel`; Esc handler detaches on close to avoid listener leaks.
- **Settings/Sources page** at `frontend/src/pages/settings.{ts,css}` —
  three-tab layout (General | Sources | Update history). General tab inline
  edits the seven persisted keys via `api.settings.set` with per-key
  success/error badges. Sources tab is full CRUD over `apps.json`. Update
  history lazy-merges per-app history across all apps, sorted newest-first.
- **Seed-from-folder wizard** at `frontend/src/pages/seed.{ts,css}` — operator
  enters a folder, the page calls `api.seed.fromFolder(path)`, renders the
  proposed manifest as an editable table, and pushes each enabled row through
  `api.apps.add(entry)` on Apply.
- **`docs/IPC.md`** — single-source-of-truth reference for all 18 commands
  registered in `tauri::generate_handler![]` plus the three `iptv-hub://*`
  event payloads emitted from the backend.
- **`frontend/src/lib/api.ts` + `events.ts`** — typed wrapper around every
  Tauri command (`api.apps.*`, `api.updates.*`, `api.launch.*`, `api.settings.*`,
  `api.activity.*`, `api.seed.*`) and every event subscriber
  (`events.onProgress`, `events.onActivity`, `events.onStatusChanged`).
- **Main shell rewire** — `frontend/src/main.ts` swaps the inline `<header>` /
  `<nav>` / `<aside>` / `<footer>` HTML for the four new custom elements,
  renames every event listener to colon-form, wires the real `launch` / `stop`
  / `check_for_update` / `apply_update` commands, and routes Settings / Seed
  pages into the overlay slot.

### Added — Phase 3a (2026-05-21)

- **`commands::updates`** (`check_for_update`, `plan_update`, `apply_update`,
  `rollback`) — dispatch through `sources::dispatch(source_type)`; apply path
  wraps the install in a `rollback::begin_swap` / `SwapGuard::commit` cycle,
  drains the `ApplyCtx::progress` channel into `iptv-hub://progress` events,
  persists `apps.current_version` / `current_sha` on success, drops the
  SwapGuard without commit on failure so `recover_orphan_swaps` restores at
  next launch.
- **`commands::launch`** (`launch`, `stop`) — fetches `LaunchRegistry` from
  Tauri-managed state, wires to `crate::launcher::LaunchRegistry::{launch,
  stop}`, writes activity rows on each transition.
- **`commands::settings`** (`get_settings`, `set_setting`) — merges
  `state.config` defaults with the persisted `settings` table, validates writes
  against the hard-coded `ACCEPTED_KEYS` whitelist.
- **`commands::activity`** (`list_activity`, `list_update_history`,
  `list_snapshots`) — direct `query_as` reads against the real schema with
  defensive limit clamping at 1000 rows.
- **`commands::seed`** (`seed_from_folder`) — thin wrapper around the new
  `crate::seed::scan_directory` heuristic classifier.
- **`db::queries`** — `AppRepository`, `ActivityLogRepository`,
  `SnapshotRepository`, `UpdateHistoryRepository` traits with a single
  `SqliteRepositories { pool }` concrete impl. Four round-trip tests against
  an in-memory SQLite + the real migration.
- **`crate::seed`** — directory classifier with five first-match rules
  (`.git` → git source; `package.json` without `.git` → web; under
  `Program Files` or sibling `.lnk` → installer candidate; sibling `.ipk` →
  tizen-ipk; otherwise → executable launch). Integration test asserts
  byte-for-byte equality against the 28-folder golden fixture at
  `tests/fixtures/seed/expected-apps.json`.
- **`main.rs` wiring** — all 18 commands now registered in
  `tauri::generate_handler![]`; `LaunchRegistry` is `app.manage(...)`'d;
  `rollback::recover_orphan_swaps` runs at startup before the poller spawns.

### Added — Phase 2 (2026-05-21)

- **Real poller** — replaces the prior tick-and-do-nothing skeleton with a
  full implementation: `tokio::sync::Semaphore` (default 4) for bounded
  concurrency, interval + jitter wake, per-app back-off after three
  consecutive failures (next poll ≥ 1 h out), `force_poll(app_id)` mpsc
  channel, real source dispatch via `sources::dispatch(...).check(...)`, DB
  updates to the `apps` row + an `activity_log` insertion per probe.
- **Launcher completion** — `Stdio::piped()` capture into a bounded per-app
  ring buffer + optional `mpsc::Sender<LogLine>` for the activity log;
  `stop()` uses `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)` on Windows
  with a 5 s wait then forced kill; per-app singleton via `FindWindowW` +
  `SetForegroundWindow` when relaunched.
- **Rollback completion** — `sweep_expired(retention_days)` walks the
  rollback root deleting files older than the cutoff; `begin_swap` returns a
  `SwapGuard` that writes a JSON marker before the swap and removes it on
  commit; `recover_orphan_swaps` reads any leftover markers at startup and
  re-runs `restore_archive` for each.
- **Manifest v0 → v1 migrations** — `manifest::migrations` module with a
  `current_version` / `detect_version` / `migrate_to_current` chain. Loader
  auto-persists migrated manifests back to disk; original preserved at `.bak`
  via the existing atomic write.
- **`fs2` advisory lock** in `manifest::writer` — 5×100 ms retry with
  portable `lock_contended_error()` detection.
- **`integration_git.rs`** — seven tests against real bare repos via `git2`:
  up-to-date check, update-available check, plan emits commit list, apply
  fast-forwards local to remote, apply refuses force-push with
  `CoreError::NotFastForward` containing "non-fast-forward", post_update
  command execution, rollback restores from snapshot.
- **`integration_smoke.rs`** — seven tests against real listeners: TCP port
  open/closed, real `ping` child process detection, real `hyper` server
  returning 2xx vs 500, `WaitFor::None` immediate-Ok path.

### Added — Phase 1 (2026-05-21)

- **`tsconfig.json` fix** — removed `vite.config.ts` from `include`
  (`rootDir`/include conflict was failing `tsc --noEmit`; CONTRACT §2.4 gate
  is now real).
- **`tokens.css` synced to UI_SPEC** — status dots now `#639922` / `#BA7517`
  / `#E24B4A` (was `#3fb950` / `#d29922` / `#f85149`); five source-type pill
  colours and three plan-step tag pills now match UI_SPEC §2.3 / §2.4 / §6.3
  byte-for-byte in both the dark default and the light override + a
  `prefers-color-scheme: light` block.
- **`forbid-stubs.sh` broadened** to match CONTRACT §2.1's bare-token list
  (`TODO` / `FIXME` / `XXX` / `HACK` / bare `stub`/`Stub`/`STUB` /
  `placeholder` / `mock` / `not implemented` / `coming soon`); HTML
  `placeholder=` attribute and CSS `::placeholder` are whitelisted.
  PowerShell sibling `forbid-stubs.ps1` added for Windows-native CI.
- **`scripts/{pre-commit,release}.{sh,ps1}`** added; `install-pre-commit.
  {sh,ps1}` rewritten to install `lefthook` (with `npx` fallback).
- **`lefthook.yml`** at repo root — pre-commit runs format-check + lint-staged
  prettier/eslint + forbid-stubs in parallel; pre-push runs `cargo clippy
  -D warnings` + full `cargo test` + `tsc --noEmit`.
- **`frontend/package-lock.json` tracked** (was unstaged, breaking CONTRACT
  §2.5 reproducibility).

### Added — Deploy infrastructure (2026-05-21)

- **Port allocation policy** at `deploy/PORTS.md` (binding, with a
  machine-readable mirror at `deploy/ports.json`) — 28-app deterministic
  10-port-per-app table in the 9600-9899 band, verified collision-free
  against the live VPS.
- **VPS preflight** at `deploy/scripts/preflight.{sh,ps1}` — refuses to deploy
  if any policy port is already bound on the target host.
- **nginx-integrated deploy** at `deploy/scripts/deploy.py` — Paramiko-driven
  SSH that SCPs the `deploy/` tree, renders per-app nginx fragments from
  `deploy/nginx/iptv-hub-site.conf.template`, stage-validates via a sandboxed
  `nginx -t`, copies into `/etc/nginx/conf.d/`, reloads nginx, then
  `docker compose up -d`s the apps. Privacy-sanitised stdout: every line
  rewrites the VPS host / user / password tokens before printing.
- **URL inventory audit** at `deploy/INVENTORY.md` +
  `deploy/inventory-status.json` — classifies all 28 catalogue entries as
  `yes-pure-web` / `yes-with-adaptation` / `no-desktop` / `no-installer` /
  `no-tizen-tv`, lists every URL that actually resolves, and documents
  credible replacement candidates for the 17 `github.com/example/...`
  placeholders.

### Added (foundational)

- Contract kit scaffolding: README, CONTRACT, ARCHITECTURE, SECURITY, docs/,
  schema/, src-tauri/ skeleton, frontend/ skeleton, scripts/, CI workflow,
  and the 24-agent build plan.
- `release-binary` source (Agent 06): GitHub releases API probe with rate-limit
  detection, regex asset pattern matching, resumable streaming download with
  exponential backoff and `Range:` resume, SHA-256 verification (with
  `sha256_required` policy), and three install strategies (`extract` for
  zip/tar/tar.gz, `run-installer` for vendor executables, `copy` for single-file
  drops). Integration tests against a real local `hyper` server cover the happy
  path, hash mismatch, asset pattern mismatch, mid-stream network drop with
  resume, and the GitHub rate-limit response shape.
- `web` source (Agent 08): git fast-forward-only fetch, post-merge lockfile drift
  detection with frozen-lockfile install for npm/yarn/pnpm/bun, and a process-wide
  port reservation set that scans `port+1..=port+10` when the manifest's preferred
  port is busy. Real-fixture integration tests under
  `src-tauri/tests/integration_web.rs` exercise fetch, install, port-collision
  selection, and lockfile-drift install triggering against a bare git repo built
  at test time from `src-tauri/tests/fixtures/apps/tiny-web-app/`.
- `tizen-ipk` source (Agent 09): `TizenSource` implementing fetch (github-release | url)
  with sha-256 verification and a real `sdb` wrapper for Samsung TV deploy. Fixture
  `sdb` shims (`tests/fixtures/bin/sdb.cmd` + `tests/fixtures/bin/sdb`) drive
  integration tests that PATH-override the lookup. Tests cover both fetch kinds,
  the deploy happy path, the "no devices paired" diagnostic, and the install-failure
  diagnostic.
- `installer` source (Agent 07): Windows MSI/EXE source implementation under
  `src-tauri/src/sources/installer.rs`. Reads currently-installed `DisplayVersion`
  from the Windows registry uninstall key (HKCU first, HKLM fallback), supporting
  both GUID-form (`{...}`) and display-name-form keys. Probes upstream version and
  SHA-256 via simple JSONPath (subset covering `$.tag_name` and `$.assets[0].sha256`
  patterns). Downloads to `cache/installers/<id>/<sha>.<ext>`, SHA-256 verifies,
  snapshots the prior uninstall-key values to a JSON file, then runs silent install
  (`msiexec /i ... /qn` for MSIs, native exe for EXE installers). Rollback re-runs
  the captured `UninstallString` and re-installs a cached prior installer when
  present; surfaces `CoreError::NotSupported` when no cached installer is available.
  Non-Windows hosts get a real `not_supported`-returning `Source` implementation, as
  documented in `docs/AGENT_PLAN.md` Agent 07 and CONTRACT §8 (not a stub).
  Integration tests at `src-tauri/tests/integration_installer.rs` build three tiny
  MSIs via WiX (v1, v2, broken-cab) through `tests/fixtures/installers/build.ps1`
  and exercise install / upgrade / rollback / uninstall against the real Windows
  registry. When WiX is absent the build script exits 78 and every test prints a
  clear skip line rather than silently passing.

## [0.1.0] — TBD

First tagged release will land when:

- All 24 agent slices have merged and the DoD checklist passes.
- A clean Windows 11 runner can install the MSI, launch the app, seed the manifest from
  a directory of real IPTV apps, sync, and apply at least one git update and one release
  update end-to-end without manual intervention.
