# iptv-restream

IPTV restream + watch2gether web app, packaged for the IPTV-Hub VPS stack.

- **Upstream**: [antebrl/IPTV-Restream](https://github.com/antebrl/IPTV-Restream)
- **Pinned commit**: `d9705451cece0141201d97c76c545b112e675587` (release `v2.2`)
- **License (upstream)**: MIT — see upstream `LICENSE`
- **Host port** (per `deploy/ports.json` slot 10): `127.0.0.1:9690`
- **Container port**: `80` (edge nginx)

## What it does

> *"A simple IPTV restream and synchronization (watch2gether) application with web frontend.
> Share your iptv playlist and watch it together with your friends."* — upstream README

The deployable container bundles three upstream components into one image:

| Upstream service | What it does | How we bundle it |
| --- | --- | --- |
| `iptv_restream_frontend` | Vite/React SPA built with `npm run build` | Static bundle baked into `/usr/share/nginx/html` |
| `iptv_restream_backend` | Node + Express + socket.io + ffmpeg on port `5000` | Runs under `supervisord` on `127.0.0.1:5000` |
| `iptv_restream_nginx` | Edge reverse proxy on port `80` | Same nginx config (with hostnames rewritten to `127.0.0.1`) runs under `supervisord` |

Single-container packaging keeps the IPTV-Hub deploy model uniform (one app = one
service fragment = one host port). The upstream multi-compose layout still works
verbatim if you'd rather use it directly — see `upstream/docker-compose.yml` after
the clone in step 1 of "How to update" below.

## DaveAI provider-vault integration

The `overrides/frontend/` layer is copied over the pinned upstream frontend
during the Docker build. It keeps the upstream restream/watch2gether UI, but
switches DaveTV deployments to provider-vault channels first:

- Apollo Group TV and XtremeHD are loaded from `/api/provider-vault/catalog`.
- Playback uses same-origin `/api/provider-vault/stream` URLs so raw provider
  hosts, usernames, and passwords are never bundled or rendered.
- Upstream demo channels are hidden whenever provider-vault catalogs are
  available.
- Provider-vault channels are read-only inside IPTV Restream; channel management
  still belongs to the DaveTV vault/admin flow.
- HLS playback uses a larger buffer window (`maxBufferLength=180`,
  `maxMaxBufferLength=600`, `backBufferLength=90`) for steadier long-form
  streams.

For the hosted `iptv-restream.daveai.tech` subdomain, add the nginx location in
`nginx-provider-vault-location.conf` to the HTTPS server block. It preserves the
DaveTV auth gate and proxies only `/api/provider-vault/*` to the vault service.

## Environment variables

All variables are optional. The container starts with sensible defaults if every
variable is unset. They are read by the upstream backend at startup (`dotenv` in
`backend/server.js`).

| Env var | Set as | Purpose |
| --- | --- | --- |
| `IPTV_RESTREAM_ADMIN_ENABLED` | `deploy/.env` | `true` to require admin login for channel management. Defaults to off (anyone with HTTP access can manage channels). |
| `IPTV_RESTREAM_ADMIN_PASSWORD` | `deploy/.env` | Plaintext admin password; required when `IPTV_RESTREAM_ADMIN_ENABLED=true`. Used by `backend/controllers/AuthController.js` to issue JWTs. |
| `IPTV_RESTREAM_CHANNEL_SELECTION_REQUIRES_ADMIN` | `deploy/.env` | `true` to require admin login to *switch* the currently-watched channel (independent of channel-add gating). |
| `IPTV_RESTREAM_BACKEND_URL` | `deploy/.env` | Override the public origin the backend emits in generated `.m3u` playlists. Leave unset and the request `Host:` header is used. |

These are forwarded to the container via the `environment:` block in
`docker-compose.service.yml`. The upstream-side names (without the
`IPTV_RESTREAM_` prefix) are documented in
[`deployment/README.md`](https://github.com/antebrl/IPTV-Restream/blob/d9705451cece0141201d97c76c545b112e675587/deployment/README.md).

Example `deploy/.env` lines for admin mode:

```sh
IPTV_RESTREAM_ADMIN_ENABLED=true
IPTV_RESTREAM_ADMIN_PASSWORD=replace-with-a-real-password
IPTV_RESTREAM_CHANNEL_SELECTION_REQUIRES_ADMIN=false
```

## Volumes

| Volume / mount | Container path | Purpose |
| --- | --- | --- |
| `tmpfs` (512 MiB) | `/streams/` | ffmpeg HLS segments. tmpfs matches upstream's `streams_data` driver opts; nothing persists across container restarts (by design). |
| Bind mount `./data/iptv-restream/channels` | `/channels` | Persistent JSON state for added channels and playlists. Lives under the deploy install root next to other app state. Created on first run if missing. Survives container restarts. |

## Build sources

The Dockerfile fetches upstream at the pinned commit `d9705451cece0141201d97c76c545b112e675587`
via shallow `git fetch`, then runs the same build steps the upstream
`frontend/Dockerfile` and `backend/Dockerfile` use:

1. `cd frontend && npm ci && npm run build` to produce the static SPA.
2. `cd backend && npm ci --omit=dev` to install backend dependencies.

The runtime image is `node:20-bookworm-slim` with `nginx`, `ffmpeg`,
`supervisor`, `wget`, and `tini` installed from the Debian repos. `nginx`
serves the SPA bundle directly and reverse-proxies `/api/`, `/socket.io/`,
`/proxy/`, and `/streams/` to the backend on `127.0.0.1:5000`, mirroring the
upstream `deployment/nginx/nginx.conf` byte-for-byte except for the hostname
replacement.

## How to update

This is a Dockerfile-based build (not a pre-pulled image), so updates require
a rebuild:

```sh
# 1. Edit deploy/apps/iptv-restream/Dockerfile and bump ARG UPSTREAM_REF
#    to the new upstream commit SHA. (Find it via `git ls-remote
#    https://github.com/antebrl/IPTV-Restream.git refs/heads/main`.)
# 2. Rebuild:
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.apps.yml \
  build --no-cache iptv-restream
# 3. Recreate the running container:
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.apps.yml \
  up -d iptv-restream
```

To verify the upstream still publishes the components the build expects:

```sh
git clone --depth 1 https://github.com/antebrl/IPTV-Restream.git /tmp/iptv-restream-check
ls /tmp/iptv-restream-check/{frontend/package.json,backend/server.js,deployment/nginx/nginx.conf}
```

If any of those files moves, the Dockerfile needs corresponding edits before
the rebuild will succeed.

## Health check

The compose fragment runs `wget --spider http://127.0.0.1:80/` every 30 s.
The root path (`/`) returns the Vite SPA `index.html` once both nginx and
the backend are up, so an HTTP 200 on `/` implies the whole pipeline is alive.

## Routing on the host

Per `deploy/PORTS.md`, the container binds **only** to `127.0.0.1:9690`. The
host's edge nginx (configured by `deploy/scripts/generate-stack.sh` from
`deploy/nginx/iptv-hub-site.conf.template`) proxies
`iptv-restream.<DEPLOY_DOMAIN>` → `127.0.0.1:9690`. No public port is opened
from this container.
