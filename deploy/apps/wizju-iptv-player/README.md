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
| `README.md`                   | This file.                                                         |

The `upstream/` sub-directory is **not** committed. Operators populate it during
deploy by cloning the upstream repo at the pinned tag (see "Update path"
below). The compose `build.context` points at `./apps/wizju-iptv-player/upstream`
and the `dockerfile` field walks up one level to find the committed
`Dockerfile`.

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
  deploy/apps/wizju-iptv-player/upstream
```

A standalone test build (without an `upstream/` checkout) can use the per-app
folder as context — the upstream `package.json`, `vite.config.web.ts`, and
`src/` must be present at the context root for it to succeed.

## Update path

To pull a new upstream release:

1. `cd deploy/apps/wizju-iptv-player/upstream && git fetch && git checkout <tag>`
2. `pnpm install --frozen-lockfile` (sanity-check the lockfile still resolves).
3. Rebuild via `deploy/scripts/generate-stack.sh` -> `docker compose build wizju-iptv-player`.
4. `docker compose up -d wizju-iptv-player` to roll the running container.

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

- The SPA fetches playlist URLs directly from the user's browser. CORS is
  enforced by remote IPTV providers; this image cannot proxy them. If a
  playlist host rejects browser CORS, the operator needs a separate proxy —
  out of scope for this slice.
- No server-side analytics, metrics, or logging is emitted by the SPA itself.
  Per-app traffic is observable only via the host edge nginx access log
  configured by `deploy/scripts/generate-stack.sh`.
