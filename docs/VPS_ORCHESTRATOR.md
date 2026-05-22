# VPS Orchestrator — design

> **Status: design doc, not yet implemented.** The corresponding code lands
> across multiple sequenced follow-up PRs (Phase 1 through Phase 8 at the foot
> of this doc). Doc is committed first so the architecture, storage policy,
> and lifecycle states are reviewable before any code lands.
>
> **Why this doc exists:** the operator clarified on 2026-05-22 that IPTV-Hub
> is more than a desktop launcher — it must also become a **VPS-hosted web
> orchestrator** that fronts the DaveTV web-app catalogue. The user opens the
> orchestrator on their VPS, clicks an app, and IPTV-Hub either launches it
> immediately (if current and healthy) or pulls/builds/healthchecks/swaps it
> into service first, **never** replacing a known-good live release until the
> new one passes smoke tests.
>
> The catalogue is ~25 GB on disk. Recloning and rebuilding the world on every
> click is not viable; this doc defines the persistent-cache + atomic-release
> + per-app-lock architecture that keeps it fast and safe.

## Scope clarification

| Surface | What runs there | Identity |
|---|---|---|
| **Desktop IPTV-Hub** (existing Tauri app) | Local launcher; manifest-driven; opens apps installed on the user's machine | `IPTV Hub` |
| **VPS IPTV-Hub** (this design) | Web orchestrator; same manifest format; serves the DaveTV web-app catalogue from the user's VPS via nginx | `IPTV Hub` |
| **DaveTV web apps** | The 25–28 catalogued web players run by the orchestrator (or referenced by the desktop launcher) | "DaveTV web-app catalogue" |

The desktop and VPS deployments share:
- the same `apps.json` schema (with VPS-specific fields added in Phase 2);
- the same `Provider Vault` design (see [`PROVIDER_VAULT.md`](PROVIDER_VAULT.md));
- the same per-app adapter contract (env-var, localStorage seed, URL query, generated M3U);
- the same activity-log and update-history conventions.

What's different on VPS: orchestration is **server-side** instead of native. The "launcher" doesn't spawn a `cmd /C` child process; it routes nginx upstream to the right `127.0.0.1:port` container, and "update" means `git pull` + `docker build` + healthcheck swap rather than running an MSI.

## Hard storage policy

```
/opt/iptv-hub/
├── repos/<app>/                       persistent git clone, never wiped
├── cache/                             persistent build cache (cargo, npm, docker layers)
│   ├── cargo/                         shared Rust build cache where applicable
│   ├── node-modules-<app>/            per-app node_modules tarball if useful
│   └── docker/                        BuildKit cache mount
├── releases/<app>/<sha-or-version>/   release METADATA dir, one per built version
│                                      (build context snapshot, build log, resolved
│                                      docker-compose fragment, healthcheck script,
│                                      smoke-test output, build/healthcheck timestamps).
│                                      The RUNTIME artifact for each release is a
│                                      Docker image tagged `iptv-hub/<app>:<sha>`;
│                                      this directory holds the metadata that pins
│                                      that image to a release.
├── live/<app>                         symlink → releases/<app>/<current-sha>/
│                                      Pointing the symlink at the metadata dir
│                                      gives an operator a single path to inspect
│                                      "what is currently live" (build log,
│                                      healthcheck output, compose fragment) WITHOUT
│                                      decoding which image tag is running. The
│                                      symlink and the running image are kept in
│                                      lock-step by `swap_live()` (see "Atomic
│                                      swap" below).
├── data/<app>/                        per-app persistent user-data (volumes), NEVER wiped on update
├── logs/<app>/                        per-app stdout/stderr + healthcheck output, rotated by N days
├── locks/                             advisory file locks (per-app update lock + global concurrency)
└── state/orchestrator.db              SQLite control-plane state (apps, releases, history)
```

### Why both a host dir AND a Docker image per release

(Resolving the architectural ambiguity flagged in code review on this PR.)

The release "thing" lives in **two** places, by design:

| Where | What | Why |
|---|---|---|
| `iptv-hub/<app>:<sha>` Docker image tag | The runtime artifact — application code, dependencies, base image | This is what the container manager pulls / runs / kills. The orchestrator NEVER mutates a running container's filesystem from the host. The image is the unit of immutability. |
| `releases/<app>/<sha>/` host directory | Release metadata: build context snapshot, build log, the resolved `docker-compose.service.yml` that pins this exact image tag, the healthcheck script + smoke output, build/swap timestamps | Operators need to be able to read these without `docker exec`. CI / a remote backup can sync these directories. The build log specifically is required by acceptance criterion 3 ("Update fails → UI shows real build/smoke logs") — the log is a file, not a Docker layer. |

The host directory is **not** mounted into the runtime container. The runtime container's filesystem is whatever the `iptv-hub/<app>:<sha>` image declares. The only host paths that bind-mount at runtime are:
- `data/<app>/` for user-data volumes (persistent across releases — schema is per-app's manifest, not the orchestrator's).
- `logs/<app>/` for stdout/stderr capture (optional; many apps stream via the Docker logging driver instead).

The `releases/<app>/<sha>/docker-compose.service.yml` is rendered by the orchestrator at build time. It pins the image tag (`image: iptv-hub/<app>:<sha>`) so that `docker compose up -d` against that fragment brings up exactly that release, regardless of what `latest` resolves to. The pinned tag is how the atomic swap works: the orchestrator runs `docker compose -f releases/<app>/<new-sha>/docker-compose.service.yml up -d`, healthchecks, then flips the symlink and removes the old container.

This also defines the prune rule precisely: a release directory can be deleted ONLY when (a) `live/<app>` does not symlink to it AND (b) the image tag `iptv-hub/<app>:<sha>` is no longer referenced by any running container. Image pruning piggy-backs on the directory prune; `docker image rm iptv-hub/<app>:<sha>` runs after the directory is removed.

Concrete rules:

1. **Never reclone.** A repo's `.git` lives at `/opt/iptv-hub/repos/<app>` forever. Updates are `git fetch --prune && git reset --hard origin/<branch>` against that working tree.
2. **Never delete an in-use release.** `releases/<app>/<sha>/` is removed only when (a) `live/<app>` no longer points at it AND (b) the prune policy says enough versions back.
3. **Atomic swap.** New releases are built to a fresh `releases/<app>/<new-sha>/` directory. Once the build + smoke + healthcheck pass, `live/<app>` is updated with `ln -sfn releases/<app>/<new-sha> live/<app>` (atomic on POSIX). Nginx upstream picks up the new symlink target on its next request (no nginx reload needed if upstreams are loopback ports owned by docker containers; the swap is the container restart).
4. **Per-app update lock.** Updates take a `flock` on `locks/<app>.lock` so two concurrent clicks can't race the same repo. The second clicker sees "update already in progress" and tails the activity log.
5. **Global concurrency cap.** A semaphore at `locks/global.sem` caps **1–2 heavy builds at a time**. The fourth concurrent click queues with an honest "waiting for build slot" message.
6. **Disk preflight.** Before starting an update, `df -B1 /opt/iptv-hub` must show `free >= max(2× largest-app-build-size, 30 GiB)`. If not, the update is refused **before** any destructive action; the existing `live/` stays untouched.
7. **Prune policy.** After a successful swap, keep the most recent **3** known-good releases per app (configurable). Older releases are removed only if no service is currently bound. Logs older than **14 days** are gzipped; older than **90 days** are deleted. Docker images: `docker image prune` weekly with `--filter "until=336h"`.

## Lifecycle states (per app)

```
                          ┌──────────────┐
                          │   UNKNOWN    │ (never built; first-click path)
                          └──────┬───────┘
                                 │  click + queue accepted
                                 ▼
                          ┌──────────────┐
                          │   BUILDING   │ (lock held, build in progress)
                          └─────┬────┬───┘
                                │    │
                       smoke OK │    │ build/smoke fail
                                ▼    ▼
                         ┌──────────────┐
                         │   HEALTHY    │   ←   live/<app> -> releases/<app>/<sha>
                         └──┬────┬────┬─┘
                            │    │    │
        upstream advances ▲ │    │    │ ▼ click while up-to-date
                            │    │    │
                            ▼    │    └─────────────► [LAUNCH IMMEDIATELY]
                  ┌──────────────┘
                  │  UPDATE_AVAILABLE  (poller saw new upstream sha)
                  └──┬───────────────
                     │ click
                     ▼
                  back to BUILDING
```

A failed build during the BUILDING transition keeps the prior `live/<app>` symlink pointed at the last known-good release. The activity log captures the build's stdout/stderr verbatim and the UI surfaces the failure with **real logs**, not a redacted "something went wrong."

## API surface (10 components)

| # | Component | Responsibility | Lives in |
|---|---|---|---|
| 1 | **IPTV-Hub Web UI** | Dashboard that lists every app card; shows live state (HEALTHY/BUILDING/UPDATE_AVAILABLE/FAILED); click = launch or queue update | `frontend/` (re-uses the existing Web Component shell behind a Vite-built `vps.html` entry) |
| 2 | **Orchestrator API** | HTTP endpoints: `GET /apps`, `GET /apps/:id`, `POST /apps/:id/launch`, `POST /apps/:id/update`, `GET /apps/:id/logs`, `POST /apps/:id/rollback` | New `src-tauri/src/bin/iptv-hub-orchestrator.rs` (axum or rocket), shipped as a separate binary alongside the Tauri desktop one. **Same Rust workspace**; same `iptv_hub_core` lib. |
| 3 | **Update worker queue** | Tokio task pool bounded by `locks/global.sem`; dequeues per-app update jobs, takes the per-app lock, runs build + smoke + swap | Same orchestrator binary |
| 4 | **Per-app repo manager** | Owns `repos/<app>`. `fetch_or_clone`, `current_sha`, `checkout_sha`, `apply_pending_update`. Re-uses `iptv_hub_core::sources::git` where possible. | New `src-tauri/src/orchestrator/repo.rs` |
| 5 | **Per-app container manager** | Owns Docker images + containers for each live release. `build_image(app, sha) -> ImageTag` (produces `iptv-hub/<app>:<sha>`), `compose_up(release_dir)` (renders the pinned `docker-compose.service.yml` in the release dir and runs `docker compose up -d --no-deps`), `health_probe`, `stop`, `rm`. The host `releases/<app>/<sha>/` dir holds release metadata only (build log, compose fragment, healthcheck output); the runtime code lives in the image tag, not in the host directory. Re-uses `deploy/apps/<app>/Dockerfile` already in repo as the build context. | New `src-tauri/src/orchestrator/container.rs` |
| 6 | **Nginx fragment integration** | After a successful swap, ensure the nginx fragment for that app points at the new container's loopback port. Re-uses `deploy/nginx/` already in repo. | Existing files, new `src-tauri/src/orchestrator/nginx.rs` |
| 7 | **Healthcheck registry** | For each running container: HTTP probe / TCP probe (per app's declared `health.kind`), rolling-window pass-count to gate the swap. Re-uses existing `manifest.app.health` schema. | New `src-tauri/src/orchestrator/health.rs` |
| 8 | **Activity + update history log** | Same SQLite schema as desktop (`activity_log`, `update_history`, `snapshots` tables). Persists at `state/orchestrator.db`. | Re-uses existing `src-tauri/src/db/queries.rs` |
| 9 | **Disk/cache/prune manager** | Periodic `df` preflight before accepting an update; nightly prune of old `releases/`, gzip-then-delete logs, weekly Docker prune | New `src-tauri/src/orchestrator/disk.rs` |
| 10 | **Provider Vault integration** | At app launch, resolve credentials from the OS keychain via the existing Vault design and inject them into the container per the app's adapter (env-var / localStorage / URL query / generated M3U file). | Wraps existing `provider_*` commands in HTTP form for the orchestrator |

## Update flow (the critical path)

```text
POST /apps/iptv-restream/update
│
├── Step 1: try_lock(locks/iptv-restream.lock)
│   │       └── BUSY → return 409 { in_progress: true }
│   └── OK
├── Step 2: acquire(locks/global.sem)
│   │       └── full → enqueue, return 202 { queued: true }
│   └── OK
├── Step 3: disk preflight
│   │       df free >= max(2×est_size, 30 GiB)?
│   │       NO  → release lock+sem, return 507 { reason: "disk-low" }
│   │       YES → continue
├── Step 4: fetch upstream into repos/iptv-restream
│   │       git fetch --prune origin
├── Step 5: compute new sha; allocate releases/iptv-restream/<sha>/
│           and write build context snapshot + initial metadata into it
├── Step 6: docker build -t iptv-hub/iptv-restream:<sha> (BuildKit cache mount)
│   │       Build output streams into releases/<sha>/build.log on the host.
│   │       The release directory holds the build LOG, not the built code; the
│   │       built code lives inside the image tag.
│   │       fail → leave build.log in place; do NOT touch live/;
│   │              release lock+sem; return 500 { logs_url }
├── Step 7: render releases/<sha>/docker-compose.service.yml pinning
│           `image: iptv-hub/iptv-restream:<sha>` and a temporary
│           loopback port. `docker compose -f <that-file> up -d` brings the
│           candidate container up. Run the per-app smoke test against it.
│           fail → docker compose down; mark dir failed; release lock+sem; return 500
├── Step 8: healthcheck rolling window (e.g., 3 consecutive HTTP 200 within 30s)
│           against the candidate container.
│           fail → docker compose down; mark dir failed; release lock+sem; return 500
├── Step 9: ATOMIC SWAP — three coordinated operations executed in this order:
│           (1) re-render the production-side docker-compose for the app to
│               pin `image: iptv-hub/iptv-restream:<sha>` on the prod port,
│           (2) `docker compose up -d --no-deps iptv-restream` with that file,
│               which replaces the old container with the new one,
│           (3) `ln -sfn releases/<sha> live/iptv-restream` so the host-side
│               "what is live" pointer matches the running image.
│           If step (2) fails, the symlink (3) is NOT updated and the previous
│           container is restored via `docker compose up -d` with the previous
│           release's pinned fragment (read from the OLD live/<app>/
│           docker-compose.service.yml).
├── Step 10: prune older releases per policy (keep 3)
├── Step 11: release lock+sem; emit `iptv-hub://activity` + `iptv-hub://status`
└── 200 OK { new_sha, elapsed_ms, log_url }
```

**Invariants enforced at every step:**
- The previous `live/<app>` is touched only at Step 9.
- A failure at Steps 4–8 leaves `live/<app>` unchanged.
- Two concurrent clicks for the same app cannot both reach Step 4 (per-app lock).
- More than 2 concurrent builds across all apps cannot be in flight (global sem).
- Disk space is verified at Step 3 **before** any destructive action.

## Launch flow (when current + healthy)

```text
POST /apps/iptv-restream/launch
├── lookup live/iptv-restream  →  releases/iptv-restream/<sha>
├── if container HEALTHY:
│       return 200 { url: "https://<vps>/apps/iptv-restream/" }   # immediate
├── if container DOWN but release HEALTHY:
│       start container → wait for first HEALTHY probe → return 200
├── if no live symlink (never built):
│       enqueue update → return 202 { queued: true, progress_url }
```

## Acceptance proof (operator-supplied)

The operator confirmed (2026-05-22) these are the required E2E pass criteria:

| # | Scenario | Expected behaviour |
|---|---|---|
| 1 | One app **current** | Launch immediately, no rebuild, < 2 s response |
| 2 | One app **outdated** | Pull + build + healthcheck + swap, then launch; old live stays up until swap |
| 3 | One app **update fails** | Old `live/<app>` remains in service; UI shows the real build/smoke logs |
| 4 | **Concurrent clicks** on the same app | First click takes the lock; subsequent clicks join the same update job, tail the same logs, no repo corruption |
| 5 | **Disk low** | Update refused **before** repo/build touched; clear error in UI; nothing live is harmed |
| 6 | **Nginx routes** | Always point at HEALTHY release; never at a half-built or failed container |
| 7 | **Playwright captures** | Hub dashboard, "updating" state, "ready" state, "failure" state, the launched web app embedded in iframe (or new-tab redirect), three viewports (mobile/tablet/TV) |

## Implementation plan (sequenced PRs)

| Phase | Scope | Branch | Acceptance |
|---|---|---|---|
| **P1** | Storage layout + per-app lock + disk preflight, in Rust + a CLI smoke binary `iptv-hub-orchestrator probe` | `feat/orchestrator-storage` | Unit tests for path resolution, lock acquisition, disk-low rejection; CI green |
| **P2** | `orchestrator/repo.rs` re-uses `git2`; clone-once-then-fetch; sha resolution | `feat/orchestrator-repo` | Integration test that clones a tiny fixture repo, fetches a new commit, returns new sha |
| **P3** | `orchestrator/container.rs` + `orchestrator/health.rs` against the existing per-app `Dockerfile`s | `feat/orchestrator-container` | Integration test that builds the smallest catalogue app, probes its healthcheck, stops it cleanly |
| **P4** | Atomic swap (`live/<app>` symlink) + nginx fragment wiring | `feat/orchestrator-swap` | Integration test that runs P1 → P2 → P3 in sequence and verifies the symlink flips only after smoke passes |
| **P5** | Orchestrator HTTP API (axum) — `GET /apps`, `POST /apps/:id/{launch,update}`, `GET /apps/:id/logs` | `feat/orchestrator-api` | HTTP-level test with `reqwest` against a real `iptv-hub-orchestrator` binary running on `127.0.0.1` |
| **P6** | Web UI at `vps.html` — list cards with live state via SSE / polling | `feat/orchestrator-ui` | Playwright spec captures dashboard, updating state, ready state, failure state |
| **P7** | Disk/cache/prune manager + nightly worker | `feat/orchestrator-prune` | Unit + integration: simulated old-release directory pruned; logs gzipped after N days |
| **P8** | Provider Vault integration at launch time (per-app adapter resolution) | `feat/orchestrator-provider` | Integration test against a stub Xtream server using a runner-secret credential; no real provider creds in repo or CI |

Each phase ships as its own PR with its own proof bundle (CI logs, screenshots where UI is affected). No phase short-circuits — P5 cannot land without P1's storage layout, etc.

## What this design explicitly does NOT do

- Does not bundle any DaveTV provider's streams, content URLs, or subscription state.
- Does not store provider credentials anywhere outside the OS keychain (re-uses [`PROVIDER_VAULT.md`](PROVIDER_VAULT.md)).
- Does not auto-update on a schedule by default. Updates are user-initiated (click in the UI) OR explicitly opted-in to "auto-apply when poller sees new sha" per-app. Background polling never builds without confirmation unless that opt-in is set.
- Does not run untrusted code from the manifest. The shell-injection hardening in `launcher.rs` (PR #22) and the schema-level command validation continue to apply to the orchestrator's container `command` field.
- Does not promote a release into `live/` until smoke + healthcheck pass. There is no "fast path" that bypasses verification, regardless of operator urgency.
- Does not delete an in-use release. The prune policy operates only on releases that `live/<app>` does not point at.

## Reproduction (for future PRs that implement this)

```bash
# P1 storage smoke (after implementation):
target/release/iptv-hub-orchestrator probe --root /tmp/orch-test
#   - verifies /tmp/orch-test/{repos,cache,releases,live,data,logs,locks,state}
#     can be created and locked

# P2 repo smoke:
target/release/iptv-hub-orchestrator repo update --app tvapp
#   - prints: fetched 12 commits; new_sha=abc123...

# P5 API smoke:
curl -s http://127.0.0.1:9700/apps | jq
curl -s -X POST http://127.0.0.1:9700/apps/tvapp/launch | jq
```

(The `9700` port assignment is provisional; it slots into the existing 9600–9899 port policy already documented in `deploy/INVENTORY.md`.)
