<!-- IPTV Hub pull request -->

## What changed
<!-- 2-4 sentence summary of the change. -->

## Definition of Done — checklist (see CONTRACT.md and docs/DOD.md)

### Build + Run
- [ ] `bash scripts/test.sh` passes locally (or `scripts/test.ps1` on Windows)
- [ ] `bash scripts/forbid-stubs.sh` returns clean
- [ ] App boots from a clean clone with `bash scripts/run-dev.sh`

### Quality
- [ ] `cargo fmt --all -- --check` is clean
- [ ] `cargo clippy --workspace --all-targets --locked -- -D warnings` is clean
- [ ] `frontend: npm run build` (tsc + vite) is clean
- [ ] No new uses of `unwrap()`, `expect()`, or `panic!` in runtime paths

### Tests (real, not mocks)
- [ ] Unit/integration tests added or updated for changed behaviour
- [ ] No new mock-only tests (CONTRACT.md §3.2)

### Docs + Schema
- [ ] If runtime types changed, the JSON schema was updated and re-validated
- [ ] If commands changed, `docs/IPC.md` (when present) and the relevant SKILL doc are updated
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]`

### Agent ownership
- [ ] If this PR closes an agent slice, `docs/AGENT_PLAN.md` is updated
- [ ] If this PR adds a Tauri command, it's registered in `src/main.rs::invoke_handler!` and `commands/mod.rs`

## Screenshots (if UI changed)
<!-- Drag images here. -->

## Notes for reviewers
<!-- Anything that helps the review go faster. -->
