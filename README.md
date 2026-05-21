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
manifest entries for every recognised folder via `scripts/seed-apps.ps1`.

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
| [`src-tauri/`](./src-tauri/) | Rust core. |
| [`frontend/`](./frontend/) | Web frontend (vanilla TS + Web Components). |
| [`scripts/`](./scripts/) | Doctor, run-dev, build, test, format, lint, release. |
| [`tests/`](./tests/) | Integration fixtures and tests. |
| [`.github/workflows/`](./.github/workflows/) | CI pipelines. |

## Status

This is the **contract kit**: documentation, schema, design system, and pattern code. Agents
implement against this spec, following [`CONTRACT.md`](./CONTRACT.md) and
[`docs/AGENT_PLAN.md`](./docs/AGENT_PLAN.md).

## License

MIT. See [`LICENSE`](./LICENSE).
