# Changelog

All notable changes to IPTV Hub will be recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Contract kit scaffolding: README, CONTRACT, ARCHITECTURE, SECURITY, docs/, schema/,
  src-tauri/ skeleton, frontend/ skeleton, scripts/, CI workflow, and the 24-agent
  build plan.
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

## [0.1.0] — TBD

First tagged release will land when:

- All 24 agent slices have merged and the DoD checklist passes.
- A clean Windows 11 runner can install the MSI, launch the app, seed the manifest from
  a directory of real IPTV apps, sync, and apply at least one git update and one release
  update end-to-end without manual intervention.
