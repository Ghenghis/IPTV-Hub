# Changelog

All notable changes to IPTV Hub will be recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Contract kit scaffolding: README, CONTRACT, ARCHITECTURE, SECURITY, docs/, schema/,
  src-tauri/ skeleton, frontend/ skeleton, scripts/, CI workflow, and the 24-agent
  build plan.
- Agent 09: `sources::tizen::TizenSource` implementing fetch (github-release | url)
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
