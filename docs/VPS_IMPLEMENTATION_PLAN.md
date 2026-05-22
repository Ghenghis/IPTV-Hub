# VPS Implementation Plan

> **Companion to `docs/VPS_ORCHESTRATOR.md`.** That doc is the architecture;
> this doc is the **execution order**: which app we prove end-to-end first,
> which phases must land before that proof is real, what's local-doable vs
> operator-side, and how each subsequent app gets folded in without breaking
> the golden path.

## Decision: golden-path app = `wizju-iptv-player`

The mandate is "Build the golden path first, then expand app by app." Picking
the right first app is the most important decision in this plan; if we pick
something flaky or huge, every later step inherits that risk.

### Inventory snapshot (from `deploy/INVENTORY.md`)

- 28 catalogue entries total.
- 10 are web-deployable (8 pure-web + 2 with adaptation), each with a real
  `Dockerfile` and `docker-compose.service.yml` already committed under
  `deploy/apps/<app>/`.
- The other 18 are desktop / Tizen / static-playlist / no-real-candidate
  and explicitly NOT in scope for the VPS orchestrator. They will be
  honestly marked "not web-deployable" in `docs/DAVETV_APP_MATRIX.md`.

### Selection criteria for the golden path

| Criterion | Why it matters | Candidates |
|---|---|---|
| Real public upstream that builds cleanly | We have to actually `git clone` and `pnpm/npm install` it on the VPS | All 10, but some are docker-compose-shipping apps with their own multi-service shape |
| Simple lifecycle (build → serve static) | Forces the orchestrator's `repo→build→image→healthcheck→swap` path through every step without runtime weirdness | `wizju-iptv-player`, `nuvioweb`, `smart-iptv-web` |
| Small build (~30-90 s, not 10 minutes) | We want a fast feedback loop on the orchestrator's correctness, not on build perf | `wizju-iptv-player`, `nuvioweb` |
| No provider credentials needed for empty-state smoke | First proof must run without secrets so the operator can replicate end-to-end without setting up a provider | All Vite/Vue/Next apps boot with an empty UI |
| Existing Dockerfile + compose fragment already written + uses orchestrator conventions (loopback bind, named volume, `iptv_hub_net`, healthcheck) | Avoids new infra in the golden-path PR | `wizju-iptv-player` ships exactly this shape |
| Healthcheck is trivial (HTTP 200 on `/`) | The orchestrator's `health::probe_http()` works first try | `wizju-iptv-player`, `tvapp`, `xstream-player` |

### Winner: `wizju-iptv-player`

- Upstream: [`j2jstudio/wizju-iptv-player`](https://github.com/j2jstudio/wizju-iptv-player).
- Lifecycle: `pnpm install --frozen-lockfile` → `pnpm build:web` → `nginx` serves `dist-web/`.
- Existing artifacts: [Dockerfile](../deploy/apps/wizju-iptv-player/Dockerfile) + [compose fragment](../deploy/apps/wizju-iptv-player/docker-compose.service.yml).
- Port: `127.0.0.1:9820:80` (loopback only; edge nginx proxies the public hostname to 9820).
- Healthcheck: HTTP `GET /` on container port 80 returns 200 (nginx serves
  `dist-web/index.html`). Trivial to probe.
- Build time: ~30-60 s on a warm `node_modules` cache, ~90 s cold.
- License: legitimate open-source; no premium content embedded.

Runner-up `tvapp` was rejected as golden path because it ships an
already-built multi-arch image — that bypasses the orchestrator's "build
from repo" path which is exactly what we need to prove. We'll fold tvapp
in during Wave 8 once the orchestrator is stable.

## Golden-path acceptance criteria

A successful golden path means the operator can run a single command on
the VPS and see:

1. `iptv-hub-orchestrator probe --root /opt/iptv-hub` succeeds.
2. The orchestrator HTTP API (loopback `127.0.0.1:9700`) is reachable via
   the edge nginx at `https://<vps>/admin/`.
3. `GET /apps/wizju-iptv-player` returns `{ status: "UNKNOWN" }` (never
   built).
4. `POST /apps/wizju-iptv-player/update` returns 202 with `job_id` +
   `progress_url`.
5. The build worker dequeues the job, takes the per-app lock, acquires a
   global-sem slot, runs `git fetch && docker build && smoke + healthcheck`,
   then atomically swaps `live/wizju-iptv-player` and brings the production
   container up on `127.0.0.1:9820`.
6. `GET /apps/wizju-iptv-player` returns `{ status: "HEALTHY", current_sha: "..." }`.
7. `POST /apps/wizju-iptv-player/launch` returns 200 with `{ url: "https://<vps>/apps/wizju-iptv-player/" }`.
8. The browser visits that URL and sees the real wizju UI (empty state is
   acceptable — proves the served bytes are real, not a placeholder).
9. **Failure path**: introducing a deliberate `pnpm build:web` error in the
   upstream repo causes the next update to fail; the activity log shows the
   real `pnpm` stderr; `live/wizju-iptv-player` still points at the prior
   release; the public URL still serves the working version.
10. Playwright captures the dashboard in `READY`, `UPDATING`, and `FAILED`
    states under three viewports (desktop / tablet / TV 1920×1080).

If any of these 10 fails, we are NOT done.

## What I can do locally vs operator-side

This implementation plan deliberately separates work that doesn't need a
VPS from work that does. Everything in the first column lands as
regular code PRs; everything in the second column is documented for the
operator with reproduce commands.

| Local-doable on this machine | Operator-side on the VPS |
|---|---|
| All Rust code (orchestrator binary, repo/container/health/disk managers, HTTP API, SQLite control plane) | Real DNS + TLS termination (`hub.<domain>`) |
| Unit tests for path resolution, locks, parse functions | First-time `users.toml` bootstrap (one-shot setup URL) |
| Integration tests against real Docker (Docker Desktop or local Docker on this Windows box) | systemd unit installation + on-boot start |
| Playwright UI tests against the static `vps.html` (Vite-served) | Real-disk preflight numbers (28 GB of real DaveTV apps) |
| docker-compose generation + `docker compose config` validation | Edge nginx reload after `users.toml` is set up |
| Local build of `wizju-iptv-player` end-to-end on Docker Desktop, including the orchestrator-driven build path | Real run against `git fetch` traffic from `j2jstudio/wizju-iptv-player` on the VPS network |
| Failure-path E2E (intentional build error, orchestrator catches it, last-known-good stays live) | Real-traffic Playwright over HTTPS against the VPS hostname |

The first column is everything in this plan's Phase 1 → Phase 6. The
second column is the contents of `docs/VPS_DEPLOY_REPORT.md` (a future
artifact in this plan's Phase 8). Both must exist before we claim
"done."

## Phases (one PR per phase)

| Phase | Branch | Lands code | Acceptance |
|---|---|---|---|
| **P0** | this PR (`session/2026-05-22-vps-implementation-plan`) | docs/VPS_IMPLEMENTATION_PLAN.md (this file) | Golden-path app chosen; plan reviewable. |
| **P1** | `feat/orchestrator-storage` | `src-tauri/src/orchestrator/{mod,paths,lock,disk}.rs` + CLI subcommand `iptv-hub-orchestrator probe` | Unit tests for path resolution, advisory-lock acquisition, disk preflight; `probe --root /tmp/X` creates the directory tree and locks. |
| **P2** | `feat/orchestrator-repo` | `src-tauri/src/orchestrator/repo.rs` (clone-once-then-fetch over `git2`) | Integration test that clones a tiny fixture repo, fetches a new commit, returns new sha. |
| **P3** | `feat/orchestrator-container` | `src-tauri/src/orchestrator/{container,health}.rs` | Integration test that builds `wizju-iptv-player` via the orchestrator path, probes its healthcheck on a temp port, stops it cleanly. **Real Docker, real build, real probe** — no mocks. |
| **P4** | `feat/orchestrator-swap` | atomic-rename helpers + production-side compose fragment regeneration | Integration test that runs P1→P2→P3 in sequence and verifies `live/wizju-iptv-player` flips only after the rolling healthcheck passes; `mv -T` semantics verified via concurrent stat. |
| **P5** | `feat/orchestrator-api` | `src-tauri/src/bin/iptv-hub-orchestrator.rs` (axum) with `GET /apps`, `POST /apps/:id/launch`, `POST /apps/:id/update`, `GET /apps/:id/jobs/:job_id`, `GET /apps/:id/jobs/:job_id/logs`, plus the Security L1-L6 layers from `VPS_ORCHESTRATOR.md` (HTTPS-via-edge, Basic→cookie session, Bearer token, CSRF, rate limit, audit log) | `reqwest` integration test against a real `iptv-hub-orchestrator` binary on `127.0.0.1`; auth bootstrap covered. |
| **P6** | `feat/orchestrator-ui` | `frontend/vps.html` + `frontend/src/vps-entry.ts` (re-uses existing Web Components for app cards; new admin-only views for jobs/logs) | Playwright spec covering dashboard READY/UPDATING/FAILED states; screenshots committed to `docs/screenshots/` under desktop / tablet / TV viewports per the operator's TV-friendly requirement. |
| **P7** | `feat/orchestrator-prune` | `src-tauri/src/orchestrator/prune.rs` + nightly worker tick | Simulated old-release directory pruned (keep last 3); logs gzipped after 14 days; weekly `docker image prune --filter until=168h`. |
| **P8** | `feat/orchestrator-provider` | Provider Vault integration via the launcher-page protocol (`/launch/<app>?t=<token>`) for `LocalStorageSeed` adapter kinds | Integration test against a stub Xtream server using a runner-secret credential; no real provider creds in repo or CI. |

After P8 lands, **the operator runs the golden-path acceptance test on a
real VPS** (8 GB free disk, Docker installed, nginx already deployed) and
the result is captured in `docs/VPS_E2E_REPORT.md`.

## Phase-after-golden-path: app matrix expansion (Wave 8)

Once the wizju golden path is green, each remaining web-deployable app
gets a small PR that:

1. Adds the app to `apps.json` (or repoints the existing entry to the
   verified upstream — see `deploy/INVENTORY.md`'s "candidate" column).
2. Verifies the existing `deploy/apps/<app>/Dockerfile` actually builds
   against today's upstream (the dockerfiles were written 2026-05-21;
   upstream may have drifted).
3. Updates `docs/DAVETV_APP_MATRIX.md` with the verified status
   (SUPPORTED / NEEDS-ADAPTATION / UNSUPPORTED + reason).
4. Adds a per-app Playwright spec capturing its launched state.

Each app PR must not regress any other app's golden path. The
orchestrator's per-app lock makes this true at runtime; the per-app PR
isolation makes it true at code-review time.

## What this plan explicitly does NOT do

- Does not claim all 28 apps work. Only `wizju-iptv-player` is the
  golden-path commitment; the 9 other web-deployable apps fold in
  one-by-one in Wave 8.
- Does not invent any new app URLs or fictional candidates. Every
  upstream cited is either today's `apps.json` value or the verified
  candidate from `deploy/INVENTORY.md`.
- Does not bundle any DaveTV provider's streams, content URLs, or
  subscription state.
- Does not claim end-to-end VPS proof from local-only artifacts. The
  VPS-side acceptance test (real DNS, real disk numbers, real
  systemd) is operator-side and gets its own report
  (`docs/VPS_E2E_REPORT.md`) before "done" can be claimed.
- Does not skip Phase 1's storage layer to ship Phase 5's HTTP API
  faster. The phases are sequenced so each one builds on tested code,
  not on hope.

## Blocker protocol acknowledgment

Per the operator's `CORE RULE: PROBLEM SOLVE, DO NOT GIVE UP` directive,
each phase that hits a real blocker (e.g., `git2` won't link against
`vendored-openssl` on a particular base image, or `docker build` needs
BuildKit cache mounts not available in the test environment) will be
documented in `docs/SKIPPED_LEDGER.md` with:
- exact file/line + error,
- attempted fixes,
- next command to run,
- whether real VPS access is required to resolve.

Blockers do NOT halt the plan — other phases continue, and the blocker
is revisited before any "done" claim.
