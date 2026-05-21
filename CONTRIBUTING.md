# Contributing to IPTV Hub

## For the agent swarm

Read these in order before doing anything:

1. [`CONTRACT.md`](./CONTRACT.md) — the rules.
2. [`docs/AGENT_PLAN.md`](./docs/AGENT_PLAN.md) — find your slice.
3. [`docs/DOD.md`](./docs/DOD.md) — your exit checklist.
4. The doc for your specific area (e.g. an agent owning the manifest schema reads
   [`docs/MANIFEST_SCHEMA.md`](./docs/MANIFEST_SCHEMA.md)).

Then:

1. Create a branch named `agent/NN-short-slug` (e.g. `agent/05-git-source`).
2. Implement against your slice's documented interface only. If you need something from
   another slice, use the documented interface; do not reach into another slice's internals.
3. Run `scripts/pre-commit.sh` (or `.ps1`) before every commit.
4. Open a PR using `.github/PULL_REQUEST_TEMPLATE.md`.
5. CI must be green before requesting human review.

## For humans

```pwsh
# Windows
git clone <repo> iptv-hub
cd iptv-hub
.\scripts\doctor.ps1
.\scripts\run-dev.ps1
```

```bash
# WSL / macOS / Linux (development only — Tauri targets Windows)
./scripts/doctor.sh
./scripts/run-dev.sh
```

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with one extension:

- `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`, `perf:`
- `agent(NN):` prefix when the commit is the primary deliverable of agent NN.
  Example: `agent(05): feat(sources/git): implement fast-forward-only fetch with rollback`.

## Branching

- `main` is always green and shippable.
- Agent branches: `agent/NN-slug`.
- Feature branches (human): `feat/<slug>`.
- Hotfix branches: `hotfix/<slug>`.

## Code style

- Rust: `rustfmt` defaults, `clippy -D warnings`.
- TypeScript: `prettier` defaults, `eslint --max-warnings 0`.
- CSS: tokens-first (see [`docs/UI_SPEC.md`](./docs/UI_SPEC.md)). No magic numbers.
- PowerShell: `PSScriptAnalyzer` default ruleset, fail on warning.

## Tests

- See [`docs/TESTING.md`](./docs/TESTING.md).
- Every source type has at least one real integration test.
- No `#[ignore]` without an issue link and an expiry date.
