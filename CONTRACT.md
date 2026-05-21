# IPTV Hub — Production Contract

> **This contract is binding on every agent, every PR, and every release.** If a requirement
> here is not explicitly relaxed in writing, assume the stricter option. Violating this
> contract is the only acceptable definition of "broken build", even when CI is green.

## 1. Purpose

This contract exists to prevent the four common failure modes that the project owner has
explicitly forbidden:

1. **AI slop** — code that looks right but doesn't run.
2. **Placeholders and stubs** — `TODO: implement`, empty handlers, "coming soon" buttons.
3. **Mock-only test strategy** — green tests that don't touch the real code path.
4. **Works-on-my-machine** — repos that won't run on a clean clone.

If any of these are present at PR time, the PR is not done. There is no "fix it later".

## 2. Hard rules (non-negotiable)

### 2.1 Zero placeholders in runtime code

Forbidden tokens anywhere under `src-tauri/src/`, `frontend/src/`, and `scripts/`:

```
TODO       FIXME      XXX        HACK
stub       Stub       STUB
mock       Mock       MOCK       (in runtime paths; tests/fixtures are allowed)
placeholder            PLACEHOLDER
"not implemented"      NotImplementedException
todo!()    unimplemented!()                      (Rust macros)
"coming soon"          "experimental — disabled"
```

A pre-commit hook and a CI gate (`scripts/forbid-stubs.sh`) enforce this. If a feature is
not yet implemented, **it must be removed from the UI and from the public API surface, not
wired to a stub**.

### 2.2 No mock-only testing

Mocks are allowed only for:

- Paid external APIs.
- Non-deterministic hardware (a real Samsung TV at deploy time).
- Network failure injection in negative-path tests.

For every source type (`git`, `release`, `installer`, `web`, `tizen`), there **must** be at
least one integration test that exercises the real code path against a real fixture (a real
local git repo, a real local HTTP server serving a real release artifact, a real MSI built
from a tiny WiX project, etc.). See [`docs/TESTING.md`](./docs/TESTING.md).

### 2.3 Full wiring required

- Every UI control is wired to a real Tauri command.
- Every Tauri command has a real Rust handler that returns real data.
- Every database query has a real migration applied in CI before tests run.
- Every external call has a real timeout, real retry policy, and real error type.

### 2.4 Zero-warning default

- `cargo build` and `cargo clippy -- -D warnings`: zero warnings.
- `tsc --noEmit --strict`: zero errors.
- `eslint`: zero warnings.
- `cargo fmt --check` and `prettier --check`: no diff.
- PSScriptAnalyzer on every script: zero warnings.

Time-bounded allowlists with an expiry date are permitted only with an issue link and a
hard expiry that fails CI when reached.

### 2.5 Reproducibility

- `git clone && ./scripts/doctor.sh && ./scripts/run-dev.sh` works on a clean machine.
- CI runs the exact same scripts as local. CI is not a separate code path.
- Lockfiles (`Cargo.lock`, `package-lock.json`) are committed and respected.

## 3. Definition of Done (DoD)

A PR is "done" only when **all** the following are true. Self-check before requesting review.

### Build and run

- [ ] `scripts/doctor.{ps1,sh}` reports PASS on a clean Windows 11 box.
- [ ] `scripts/run-dev.{ps1,sh}` boots Tauri dev mode and the main window renders.
- [ ] `scripts/build.{ps1,sh}` produces a release MSI under `dist/`.

### Quality

- [ ] `scripts/format.{ps1,sh}` produces no diff after run.
- [ ] `scripts/lint.{ps1,sh}` exits 0 with zero warnings.
- [ ] `cargo clippy -- -D warnings` exits 0.
- [ ] `tsc --noEmit --strict` exits 0.

### Real tests

- [ ] `scripts/test.{ps1,sh}` runs and passes:
  - Unit tests for pure logic.
  - Integration tests for every source type against real fixtures.
  - Smoke test that boots the app, renders the main window, runs one real workflow, exits cleanly.
  - At least one Playwright/WebdriverIO test against the Tauri binary for any UI change.
- [ ] No skipped tests without a tracked issue and expiry date.
- [ ] No flaky tests. Quarantine is not allowed.

### Security

- [ ] `cargo audit` and `npm audit --omit=dev`: no unaddressed critical/high findings.
- [ ] No secrets in source. `.env.example` updated if new env vars introduced.
- [ ] Any new risky surface (executing user-supplied content, downloading binaries, etc.)
  is documented in [`SECURITY.md`](./SECURITY.md) with mitigations.

### Docs and changelog

- [ ] [`README.md`](./README.md) updated if user-visible behaviour changed.
- [ ] [`ARCHITECTURE.md`](./ARCHITECTURE.md) updated if a new component or boundary appeared.
- [ ] [`CHANGELOG.md`](./CHANGELOG.md) has a new entry under `[Unreleased]`.
- [ ] If a manifest field was added or changed, [`docs/MANIFEST_SCHEMA.md`](./docs/MANIFEST_SCHEMA.md)
  and [`schema/apps.schema.json`](./schema/apps.schema.json) are both updated.

## 4. Look-and-feel contract

The UI must match [`docs/UI_SPEC.md`](./docs/UI_SPEC.md) and the approved mockups byte-for-byte
on the tokens listed below. These are not suggestions; they were approved by the project owner
and are the visual contract.

- Card padding, border radius, and 1px hairline gutters between cards.
- Two-column responsive grid down to a hard floor of 360 px per column.
- The five source-type pills (`GIT`, `REL`, `MSI`, `WEB`, `TIZEN`) with the exact background
  and text colour pairs listed in [`docs/UI_SPEC.md`](./docs/UI_SPEC.md).
- The three status dots (`ok` green, `warn` amber, `err` red) with the exact hex values.
- Mono font for SHAs, versions, file paths, and timestamps in the activity log.
- Dense control-panel feel: no hero whitespace, no decorative shadows or gradients.

Any deviation from these tokens is a UI bug, not a "style preference".

## 5. Safety and stability

- All long-running work uses Rust `tokio::CancellationToken` or async tasks that can be
  aborted; the UI must be able to cancel any operation it started.
- No blocking work on the Tauri main thread. Use `tauri::async_runtime::spawn` or
  `tokio::task::spawn_blocking`.
- All network calls have an explicit timeout (default 30 s) and exponential backoff
  (3 retries, 1 s base, 2x multiplier, jitter).
- The poller has bounded concurrency (default 4 sources at a time).
- Rollback snapshots are retained for 7 days by default, configurable per source.

## 6. Security baseline

- Tauri allowlist is the **minimum surface required**. New allowlist entries require a
  comment justifying why and what would break without them.
- Filesystem access is restricted to `cache/`, `upstream/`, `user-data/`, and the binary's
  own data dir.
- Shell execution is restricted to a fixed allowlist of binaries discovered via `which`
  (e.g. `git`, `npm`, `sdb`, vendor installers from `cache/installers/<verified-hash>/`).
- GitHub tokens, if configured, live in the OS keychain via `keyring-rs` — never in
  config files or environment variables that touch disk.
- Downloads are verified by SHA-256 against the published asset digest where available.

## 7. What the agent swarm must produce

Every agent owns a slice of [`docs/AGENT_PLAN.md`](./docs/AGENT_PLAN.md). At hand-off time,
each agent must deliver:

- The code their slice owns, complete and wired.
- The tests their slice owns, against real fixtures.
- The documentation their slice owns, in the appropriate doc file.
- A CHANGELOG entry under `[Unreleased]` describing the change.

Slices are designed to minimise cross-agent coupling: agents communicate **only** through
documented interfaces (Tauri command signatures, manifest schema, database schema, the
`Source` trait). If an agent finds an undocumented coupling, they must add the interface
documentation before merging.

## 8. The only acceptable reasons not to implement something

- It is unsafe, illegal, or unethical.
- It requires paid services the agent cannot access (then the integration point and config
  shape must still be implemented and unit-tested with the real call disabled by config).
- The project owner has explicitly asked to skip it (recorded in the PR description).

In those cases the agent must provide:

- The exact gap.
- The exact integration steps to close it later.
- The config keys reserved for the integration (in config files, not runtime code).

## 9. Enforcement

- Pre-commit: format, lint, forbid-stubs scan.
- Pre-push: typecheck, unit tests.
- CI: full DoD checklist. **CI gates merge.**
- Release: full DoD plus a smoke install on a clean Windows runner.

If a check is flaking, the check is a bug. Fix the check, do not bypass it.
