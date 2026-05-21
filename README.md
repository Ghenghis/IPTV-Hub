# IPTV Hub

Unified launcher and update manager for 25-30 IPTV / video-streaming applications on
Windows 11, with safe co-existence between **git-tracked source repos**, **release-tracked
binaries**, **Windows installers (MSI/EXE)**, **web/dev-server projects**, and **Tizen `.ipk`
packages for Samsung TVs**.

> Designed for someone who runs many community IPTV/video projects side-by-side and wants
> one place to launch them and keep them up to date without ever stepping on user data.

## Why it exists

Running 28+ IPTV apps means:

- Different update mechanisms (git pull, GitHub release download, MSI re-install, manual `.ipk` deploy).
- Lockfile / dependency rot if you forget to `npm ci` after a pull.
- Lost playlists and EPG caches when a folder gets nuked by a bad pull.
- No idea which apps actually work right now without launching them.

IPTV Hub fixes all four:

- **One launcher** with consistent Launch / Update / Details actions per app.
- **Manifest-driven** sources — every app declares how it updates, where its user data lives,
  and how to smoke-test it.
- **Two-folder model** — `upstream/` is fully managed (safe to wipe); `user-data/` is yours
  and is never touched by an update.
- **Rollback for everything** — every update writes a snapshot first; revert is one click.
- **Background poller** flags updates; you decide when to apply.

## Stack

- **Tauri 2** (Rust core, ~10 MB binary, native MSI handling).
- **SQLite** for state (apps, update history, rollback snapshots, activity log).
- **Vanilla TypeScript + Web Components + native CSS** for the frontend.
  No React, no JSX — matches the owner's documented preference.
- **`git2-rs`** for git operations, **`reqwest`** for releases, **`windows-rs`** for installer
  registry and process control.

## Quickstart

```pwsh
# Windows (PowerShell)
git clone <repo> iptv-hub
cd iptv-hub
.\scripts\doctor.ps1            # verify prerequisites
.\scripts\run-dev.ps1           # launches Tauri dev mode, wired and ready
```

```bash
# WSL / macOS / Linux
./scripts/doctor.sh
./scripts/run-dev.sh
```

The first run scans a configured `apps-root` folder (default: `C:\IPTV\`) and creates
manifest entries for every recognised folder via `scripts/seed-apps.ps1` (the script
wraps the `iptv-hub-seed` CLI binary; the same scanner powers the in-app Seed-from-folder
wizard reachable from the Settings overlay).

### Build a release MSI

```pwsh
.\scripts\build.ps1     # one-time installs cargo-tauri-cli; produces the MSI
```

`scripts/build.ps1` is idempotent on a fresh clone — it installs `cargo-tauri-cli` once
if missing, then runs `npm run build` + `cargo tauri build`. The MSI lands at
`src-tauri/target/release/bundle/msi/`.

## Layout (target)

```
C:\IPTV\
├── upstream\              # fully managed by IPTV Hub — clones, releases, installers
├── user-data\             # your configs, playlists, EPG caches — NEVER touched by an update
├── cache\                 # icons, release metadata, rollback snapshots
└── hub\                   # the IPTV Hub binary + apps.json manifest
```

## What's where in this repo

| Path | What it is |
| --- | --- |
| [`CONTRACT.md`](./CONTRACT.md) | Standing production contract every agent and PR must satisfy. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System architecture, components, data flow, diagrams. |
| [`docs/PRODUCT_SPEC.md`](./docs/PRODUCT_SPEC.md) | What we're building, for whom, what "done" means. |
| [`docs/UI_SPEC.md`](./docs/UI_SPEC.md) | Design tokens and component specs (extracted from the approved mockups). |
| [`docs/MANIFEST_SCHEMA.md`](./docs/MANIFEST_SCHEMA.md) | The `apps.json` schema, documented. |
| [`docs/UPDATE_FLOWS.md`](./docs/UPDATE_FLOWS.md) | Per-source-type update flow specifications. |
| [`docs/DATABASE.md`](./docs/DATABASE.md) | SQLite schema and queries. |
| [`docs/TESTING.md`](./docs/TESTING.md) | Testing strategy and real fixtures (no mock-only suites). |
| [`docs/PACKAGING.md`](./docs/PACKAGING.md) | Build and release pipeline. |
| [`docs/AGENT_PLAN.md`](./docs/AGENT_PLAN.md) | The 24-agent parallel build plan. |
| [`docs/DOD.md`](./docs/DOD.md) | Definition of Done checklist. |
| [`docs/diagrams/`](./docs/diagrams/) | Mermaid diagrams. |
| [`schema/apps.schema.json`](./schema/apps.schema.json) | Validatable JSON Schema for the manifest. |
| [`src-tauri/`](./src-tauri/) | Rust core (binary `iptv-hub` + CLI `iptv-hub-seed` + library `iptv_hub_core`). |
| [`frontend/`](./frontend/) | Web frontend (vanilla TS + Web Components). |
| [`scripts/`](./scripts/) | Doctor, run-dev, build, test, format, lint, release, seed-apps, pre-commit. |
| [`deploy/`](./deploy/) | VPS deployment kit (port policy, nginx fragments, Paramiko-driven `deploy.py`). |
| [`tests/`](./tests/) | Integration fixtures and tests. |
| [`.github/workflows/`](./.github/workflows/) | CI pipelines. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Per-PR record of what landed. |
| [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) | `cargo audit` / `npm audit` baseline. |

## Status

All 24 slices in [`docs/AGENT_PLAN.md`](./docs/AGENT_PLAN.md) have been delivered: every
source type (git/release/installer/web/tizen) has a real backend implementation, real
integration tests against real fixtures, and end-to-end wiring through the 18 Tauri
commands listed in [`docs/IPC.md`](./docs/IPC.md). The frontend ships the title bar,
chip bar, app card, update modal, activity log, status bar, settings page, and
seed-from-folder wizard documented in [`docs/UI_SPEC.md`](./docs/UI_SPEC.md).

The full Definition-of-Done gate (`cargo build` / `cargo clippy -D warnings` /
`cargo test --workspace` / `tsc --noEmit` / `eslint --max-warnings=0` / `prettier --check` /
`bash scripts/forbid-stubs.sh` / Playwright shell smoke) passes on a clean Windows 11
machine after a one-time `cargo install tauri-cli` (handled automatically by
`scripts/build.ps1`). See [`CHANGELOG.md`](./CHANGELOG.md) for the per-phase delta.

Outstanding (operator decisions, not code):
- 17 of 28 catalogue URLs in `schema/examples/full-28-apps.json` point at
  `github.com/example/...` placeholders. [`deploy/INVENTORY.md`](./deploy/INVENTORY.md)
  documents credible replacement candidates; the deploy kit refuses to Dockerize
  apps whose upstream URL doesn't actually exist.
- Playwright visual-regression baseline screenshots (`frontend/tests/e2e/preview.spec.ts-snapshots/`)
  must be generated on the target CI OS once and committed; the spec auto-skips until
  `IPTV_HUB_VISUAL_REGRESSION=1` is set.

## License

MIT. See [`LICENSE`](./LICENSE).
