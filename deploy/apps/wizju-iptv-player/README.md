# wizju-iptv-player — IPTV Hub deployment slice

Static web bundle for [j2jstudio/wizju-iptv-player](https://github.com/j2jstudio/wizju-iptv-player),
fronted by nginx and slotted into the IPTV Hub stack at host port **9820** (per
`deploy/PORTS.md` app #23).

## Upstream

- Repo: https://github.com/j2jstudio/wizju-iptv-player
- Stack: TypeScript + Vue 3 + Vite (web mode via `vite.config.web.ts`)
- Build command upstream: `pnpm build:web` (runs `vue-tsc --build` then
  `vite build --config vite.config.web.ts`)
- Build output: `dist-web/`
- Runtime: pure static SPA — there is no server-side component. All playlist
  parsing happens in the browser (see upstream `README.md` "Privacy" note).

## What this directory contains

| File                          | Purpose                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `Dockerfile`                  | Multi-stage build: `node:20-alpine` builds, `nginx:1.27-alpine` serves. |
| `docker-compose.service.yml`  | Service fragment merged by `scripts/generate-stack.sh` into the per-app compose bundle. |
| `overrides/`                  | DaveAI provider-vault integration and hosted playback polish applied over upstream before build. |
| `README.md`                   | This file.                                                         |

The `upstream/` sub-directory is **not** committed. Operators populate it during
deploy by cloning the upstream repo at the pinned tag (see "Update path"
below). The compose `build.context` points at `./apps/wizju-iptv-player` so the
committed Dockerfile can copy both `upstream/` and the tracked `overrides/`
layer.

## DaveAI provider-vault integration

This hosted build auto-seeds two first-class Wizju sources when the DaveTV
provider vault reports them configured:

| Provider | Wizju source id | Runtime data path |
| -------- | --------------- | ----------------- |
| Apollo Group TV | `daveai-vault-apollo` | `/api/provider-vault/catalog` -> safe `/api/provider-vault/stream` URLs |
| XtremeHD | `daveai-vault-xtremehd` | `/api/provider-vault/catalog` -> safe `/api/provider-vault/stream` URLs |

Raw provider usernames, passwords, and host URLs never enter browser storage or
this repository. The overrides also make Wizju's existing Refresh action
understand provider-vault catalog URLs, so the app can refresh Apollo/XtremeHD
through the same UI it uses for M3U sources.

Playback polish added for hosted use:

- Video.js `preload=auto` and same-origin provider-vault stream URLs.
- VHS/HLS retry and quality-stability options (`maxPlaylistRetries`,
  `smoothQualityChange`, `enableLowInitialPlaylist: false`).
- Safari keeps native HLS; Chromium-based browsers use VHS for better recovery.

## Ports

| Direction        | Port                | Bind                |
| ---------------- | ------------------- | ------------------- |
| Host (operator)  | `9820`              | `127.0.0.1` only    |
| Container (app)  | `80`                | nginx               |

`9820` is the deterministic slot for `wizju-iptv-player` from
`deploy/PORTS.md` §3. Per the formula `slot_base(N) = 9600 + N * 10` with N
the 0-based catalogue index, and `wizju-iptv-player` at 1-based row #23
(N=22), the base is `9600 + 22 * 10 = 9820`.

The container only ever listens on 80 internally; the host edge nginx
(operator-managed) proxies `wizju-iptv-player.<DEPLOY_DOMAIN>` to
`127.0.0.1:9820`.

## Environment variables

The upstream is a pure client-side SPA — it ships **no server-side runtime**
and reads no env vars at runtime. Build-time constants documented in upstream
`README.md` ("Multi-Platform Build Variables") are baked in by Vite when the
image is built:

| Var (build-time) | Default in this image | Notes |
| ---------------- | --------------------- | ----- |
| `__PLATFORM__`         | `"web"`         | Set by `vite.config.web.ts` — do not override. |
| `__IS_CHROME_EXTENSION__` | `false`      | Set by `vite.config.web.ts` — do not override. |

The compose fragment honours `COMPOSE_PROJECT_NAME` for container naming, but
that is a global stack-wide variable defined in `deploy/.env`, not specific
to this app.

## Build, locally

From the repository root (so the `upstream/` checkout sits beside `Dockerfile`):

```bash
# Populate the upstream checkout (one-time, or use a fresh clone per build).
git clone --depth 1 https://github.com/j2jstudio/wizju-iptv-player.git \
    deploy/apps/wizju-iptv-player/upstream

# Build the image. The Dockerfile lives one level up from the build context.
docker build \
  -f deploy/apps/wizju-iptv-player/Dockerfile \
  -t iptv-hub/wizju-iptv-player:local \
  deploy/apps/wizju-iptv-player
```

A standalone test build needs `upstream/` present under the per-app folder.
The DaveAI changes are then applied from tracked `overrides/` during the build.

## Update path

To pull a new upstream release:

1. `cd deploy/apps/wizju-iptv-player/upstream && git fetch && git checkout <tag>`
2. Keep the DaveAI `overrides/` layer in place.
3. `pnpm install --frozen-lockfile` (sanity-check the lockfile still resolves).
4. Rebuild via `deploy/scripts/generate-stack.sh` -> `docker compose build wizju-iptv-player`.
5. `docker compose up -d wizju-iptv-player` to roll the running container.

If upstream changes the web build script name or output directory, both must
be updated in the Dockerfile in lock-step:

- Build script -> `pnpm run build:web`
- Output dir   -> `dist-web/` (currently set by `vite.config.web.ts`)

## Healthcheck

The compose fragment runs `wget -qO- http://127.0.0.1:80/` every 30 s. nginx
serves `index.html` for `/`, so a `200` response means the static bundle
is reachable. nginx 1.27-alpine does not ship `curl`; `wget` is busybox-built-in
and is the correct choice for that base image.

## Known limitations

- Hosted DaveAI providers use the same-origin provider vault. Manually-added
  third-party M3U URLs are still fetched by the user's browser, so CORS remains
  the remote playlist host's decision.
- No server-side analytics, metrics, or logging is emitted by the SPA itself.
  Per-app traffic is observable only via the host edge nginx access log
  configured by `deploy/scripts/generate-stack.sh`.
