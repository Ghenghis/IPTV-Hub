# IPTV Hub — Testing

> The contract: **no mock-only test strategy**. For every source type, at least one
> integration test must exercise the real code path against real fixtures. See section 2.2
> of [`CONTRACT.md`](../CONTRACT.md).

## 1. Pyramid

```
              ┌──────────────────────────────┐
              │   E2E (Playwright/WDIO)      │     ~5 tests, slow
              │   driving the real binary    │
              ├──────────────────────────────┤
              │   Integration (Rust + real   │     ~30 tests
              │   fixtures: git, HTTP, MSI)  │
              ├──────────────────────────────┤
              │   Component / IPC contract   │     ~50 tests
              ├──────────────────────────────┤
              │   Unit (pure logic only)     │     dozens
              └──────────────────────────────┘
```

Pure-logic unit tests are welcome and cheap. They are not, on their own, sufficient.

## 2. Real fixtures

### 2.1 Git fixtures (`tests/fixtures/apps/`)

We build real, tiny git repos at test setup time, using `git2-rs`. No mocking, no
`gitoxide` stubs. The setup module creates:

- `tests/fixtures/apps/tiny-app-a/` — 3 commits on `main`, no lockfiles.
- `tests/fixtures/apps/tiny-app-b/` — 5 commits, includes a `package.json` with a tiny
  `npm install` graph (one dependency).
- `tests/fixtures/apps/tiny-app-history-rewrite/` — a repo where the "remote" is force-pushed
  between two test runs (to verify fast-forward-only refuses).
- `tests/fixtures/apps/tiny-app-with-userdata/` — verifies the symlink mount through a
  pull cycle.

The setup function returns `git2::Repository` handles wired to bare repos under
`tests/fixtures/_bare/`, simulating the "remote".

### 2.2 HTTP fixtures (`tests/fixtures/http/`)

A real HTTP server (`tokio` + `hyper`) bound to `127.0.0.1:<random>` per test, serving:

- GitHub releases API responses (canned JSON files committed to the repo).
- Release asset binaries (small `.exe`-shaped files with predictable SHA-256).
- Vendor `version.json` endpoints (small JSON files).

The server records every request so tests can assert on the requests we made (e.g. that
we sent `If-Match` headers, that we used `Range` for resume).

### 2.3 MSI fixtures (`tests/fixtures/installers/`)

A tiny MSI is built once via WiX in a `tests/fixtures/installers/build.ps1` script. The
MSI registers an uninstall key with a known DisplayName and DisplayVersion. The
integration test:

1. Runs the MSI silently.
2. Reads the uninstall key to confirm version detection works.
3. Runs a "newer" MSI built from the same WiX with bumped version.
4. Confirms detection picks up the new version.
5. Uninstalls.

This test runs only in CI under a Windows runner (gated by `cfg(windows)` and a
`[ignore = "windows-only"]` attribute that the test runner enables on Windows).

### 2.4 Tizen fixtures

The Tizen tests cover the **fetch** half end-to-end against the HTTP fixture (downloading
a fake `.ipk`). The **deploy** half mocks `sdb` via a fixture binary at
`tests/fixtures/bin/sdb` that responds to `devices` and `install` predictably. This is one
of the explicit exceptions in section 2.2 of the contract (real hardware not available
in CI), and is paired with a manual deploy test that the maintainer runs against an actual
Samsung TV before each release.

## 3. Test commands

### Rust

```bash
# All unit + integration tests
cargo test --workspace --all-features

# Just integration tests (real fixtures)
cargo test --workspace --test integration

# Specific source type
cargo test --workspace --test integration_git
cargo test --workspace --test integration_release
cargo test --workspace --test integration_installer    # windows-only
cargo test --workspace --test integration_web
cargo test --workspace --test integration_tizen
```

### Frontend

```bash
cd frontend
npm run test:e2e                        # Playwright — drives the Vite dev server
```

`tests/e2e/shell.spec.ts` boots Vite (`npm run dev`) and drives the rendered shell
with real Chromium: every chip filter toggles to `aria-pressed=true`, the Settings
overlay opens. The frontend's `load()` invokes Tauri's `invoke()` for `list_apps`;
without a Tauri runtime that call rejects and the shell renders its error path —
which is itself a real code path being exercised. No IPC responses are mocked.

`tests/e2e/preview.spec.ts` runs Playwright `toHaveScreenshot('preview.png')` against
`preview.html` for visual regression of every component state. **Disabled by default**
until baselines are committed — see the spec's header for the 3-step opt-in.

### Known gap: real-Tauri-binary E2E

The Playwright spec above drives the Vite-served frontend, **not the real Tauri
binary**. `cargo tauri dev` opens a native window whose webview is owned by the
OS, not Chromium; Playwright cannot reach it without `tauri-driver`, the Tauri
WebDriver bridge. `tauri-driver`'s Tauri 2 support is currently nightly-only and
not yet wired here.

The integration-test layer (`cargo test --workspace`) DOES exercise the full
backend (sources, poller, rollback, launcher, manifest, db::queries) against
real fixtures — that's where the IPC contract is validated end-to-end on the
Rust side. The remaining gap is the Tauri WebView ↔ frontend wire, which
currently has no automated coverage past the visual shell.

When `tauri-driver` Tauri-2 support stabilises, the second spec at
`frontend/tests/e2e/binary.spec.ts` should be added with the WebdriverIO →
`tauri-driver` → release MSI → real-`invoke` flow that exercises a true full-stack
update workflow.

## 4. CI gates

`scripts/test.{ps1,sh}` runs in order, fail-fast:

1. `cargo fmt --check`, `prettier --check`, PSScriptAnalyzer.
2. `cargo clippy --workspace --all-targets -- -D warnings`.
3. `tsc --noEmit --strict` for the frontend.
4. `cargo test --workspace` (unit + integration, MSI tests on Windows runner only).
5. `npm run test:e2e` — Playwright frontend smoke + (when baselines land)
   `toHaveScreenshot` visual regression vs `preview.html`.

Total CI runtime target: under 6 minutes for a clean run. If it grows past that, split
the integration matrix into parallel jobs.

## 5. Coverage policy

- Minimum line coverage on `src-tauri/src/sources/` modules: **80 %**.
- Minimum line coverage on `src-tauri/src/manifest.rs`: **90 %** (it's the schema validator).
- Minimum branch coverage on `src-tauri/src/rollback.rs`: **80 %** (this is the
  safety-critical path).
- Other modules: no minimum but coverage is reported.

`cargo tarpaulin` for Rust, `vitest --coverage` for frontend. Reports are uploaded as
CI artifacts. Coverage targets are enforced by `scripts/test.sh` exiting non-zero if any
target is missed.

## 6. Flake policy

- Any test that fails on a retry without a code change is treated as a bug.
- Quarantining is not allowed.
- A flaky test must either be fixed or removed within the PR that observed the flake.

## 7. Smoke test (real)

The Definition of Done smoke test runs **the real binary**:

1. `scripts/build.{ps1,sh}` produces `dist/iptv-hub-<version>.msi`.
2. `scripts/smoke.{ps1,sh}` installs the MSI in a temp directory, launches it with a test
   `apps-root` (containing two real tiny git fixtures), drives it through the seed →
   sync → apply update flow via WebDriverIO, then uninstalls.

This is in CI on the Windows runner, gated behind `if: github.ref == 'refs/heads/main'`
or `if: github.event_name == 'release'`. The PR runs the unit + integration + frontend
unit tests; the smoke runs on main and on releases.
