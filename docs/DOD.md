# IPTV Hub — Definition of Done

Every PR. Every agent. Every release. Self-check before requesting review.

## Pre-flight

- [ ] Branch named `agent/NN-slug` or `feat/<slug>`.
- [ ] Commits follow the convention in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- [ ] No commits with `WIP`, `tmp`, `fix typo` (squashed into meaningful commits).

## Build

- [ ] `cargo build --workspace --all-features` clean.
- [ ] `cargo build --workspace --release` clean.
- [ ] `npm run build --workspace=frontend` clean.
- [ ] `cargo tauri build` produces an MSI in `dist/`.

## Quality

- [ ] `cargo fmt --check` no diff.
- [ ] `prettier --check 'frontend/**/*.{ts,css,html,json}'` no diff.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` zero warnings.
- [ ] `tsc --noEmit --strict` for frontend zero errors.
- [ ] `eslint frontend/src --max-warnings 0` zero warnings.
- [ ] `PSScriptAnalyzer` on every `.ps1` zero warnings.
- [ ] `shellcheck` on every `.sh` zero warnings.

## Anti-stub

- [ ] `scripts/forbid-stubs.sh` exits 0.
- [ ] No `todo!()`, `unimplemented!()`, `panic!("not implemented")` in runtime paths.
- [ ] No `// TODO`, `// FIXME`, `// XXX`, `// HACK` in runtime paths.
- [ ] No "coming soon", "stub", "placeholder", "mock data" strings in runtime paths.
- [ ] Every UI control either does its job or has been removed from the UI.
- [ ] Every Tauri command in `frontend/src/lib/api.ts` is implemented in
  `src-tauri/src/commands/`.
- [ ] Every Rust command handler returns real data; no `Ok(Default::default())` filler.

## Real tests

- [ ] `cargo test --workspace` passes.
- [ ] At least one integration test against real fixtures touches every code path the PR
  introduces or modifies.
- [ ] Mocks, if any, are documented at the test site and a real-path test exists alongside.
- [ ] No `#[ignore]` without a tracked issue and expiry.
- [ ] `vitest run` for frontend passes.
- [ ] Playwright/WDIO E2E for any UI change passes against the dev server or Tauri binary.

## Security

- [ ] `cargo audit` no unaddressed `critical` or `high` advisories.
- [ ] `npm audit --omit=dev` no unaddressed `critical` or `high`.
- [ ] No secrets in code (verified by `trufflehog filesystem` in CI).
- [ ] If a new external host is contacted, it is in the manifest allowlist in
  `config/default.toml` and called out in the PR.
- [ ] If a new file path outside `cache/`, `upstream/`, `user-data/`, or app-data is
  accessed, [`SECURITY.md`](../SECURITY.md) is updated with justification.

## Docs

- [ ] Doc owned by this slice is updated in the same PR.
- [ ] [`CHANGELOG.md`](../CHANGELOG.md) `[Unreleased]` has a new bullet.
- [ ] [`README.md`](../README.md) updated if user-visible behaviour changed.
- [ ] [`ARCHITECTURE.md`](../ARCHITECTURE.md) updated if a new component or boundary appeared.

## Smoke

- [ ] `scripts/run-dev.sh` (or `.ps1`) brings up Tauri dev mode and the main window renders.
- [ ] One real workflow end-to-end works:
  - For backend PRs: an integration test that simulates the full user journey.
  - For UI PRs: a Playwright/WDIO test that drives the workflow.

## Reviewer checklist

- [ ] PR description references the agent slice and the doc(s) being satisfied.
- [ ] CI is green.
- [ ] No new warnings appeared in the build output.
- [ ] The changes match the documented interface; no unexpected coupling.

## Release-only additions

- [ ] Version bumped via `scripts/bump-version.{ps1,sh}`.
- [ ] `CHANGELOG.md` `[Unreleased]` rotated to `[<version>] — <date>`.
- [ ] Tag pushed; release workflow green.
- [ ] Clean-VM install of the MSI confirmed by the owner.
- [ ] Release notes reviewed by the owner.
