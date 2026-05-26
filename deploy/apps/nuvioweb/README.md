# nuvioweb

Web build of **NuvioTV** (Stremio-addon web client) packaged for the IPTV Hub
VPS deploy stack.

| Field | Value |
| --- | --- |
| Upstream | https://github.com/NuvioMedia/NuvioWeb |
| Pinned ref | `main` (override with `--build-arg NUVIOWEB_REF=<sha>`) |
| Stack | JavaScript (esbuild + babel + postcss) → static `dist/` |
| Container port | `8080` |
| Host port (policy slot) | `127.0.0.1:9730` — see [`deploy/PORTS.md`](../../PORTS.md) |
| Runtime image | `nginx:1.27-alpine` |
| Build image | `node:20-alpine` |

## What this app is

NuvioTV Web is a single-page client that talks to user-installed Stremio
addons for content discovery and source resolution. It does **not** host or
proxy media itself; everything is browser-side. There is no backend.

The DaveAI deployment adds one browser-side override script:
`overrides/nuvio-daveai-vault-addon.js`. It registers a local
Stremio-compatible "DaveAI IPTV" addon that exposes Apollo Group TV and
XtremeHD as Nuvio catalogs while fetching real catalog and stream URLs from the
authenticated DaveTV provider vault. The browser only sees tokenized
`/api/provider-vault/stream` URLs; provider usernames and passwords stay
server-side. The override also pins the first-run language to English so the
app does not start in a browser/system locale the user did not ask for.
For hosted deployments it also removes stale cross-origin DaveAI addon URLs,
rewrites legacy `apps.daveai.tech/api/provider-vault` requests back to the
same-origin provider vault, and stubs the optional avatar RPC with a local empty
catalog.

Because the upstream emits a fully self-contained `dist/` (entry `index.html`
+ minified `app.bundle.js` + processed CSS + assets), the runtime is plain
nginx — no Node process needed in production.

## Build

```bash
docker build \
  -f deploy/apps/nuvioweb/Dockerfile \
  -t iptv-hub-nuvioweb:latest \
  ./deploy/apps/nuvioweb/
```

Or through the orchestrator (the normal path):

```bash
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.apps.yml \
  build nuvioweb
```

The Dockerfile clones the upstream inside the build stage; the build context
here only carries the Dockerfile, the nginx config, and this README, so no
upstream source ever lands in the repo. The resolved commit SHA is written
to `/usr/share/nginx/html/.nuvioweb.commit` inside the image for provenance.

## Run

```bash
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.apps.yml \
  up -d nuvioweb

curl -fsS http://127.0.0.1:9730/        # serves index.html
curl -fsS http://127.0.0.1:9730/.nuvioweb.commit   # build provenance
```

## Configuration

NuvioWeb reads runtime configuration from `nuvio.env.js`, which the upstream
build emits as a default placeholder if neither `nuvio.env.js` nor
`nuvio.env.example.js` exists at build time. None of the keys are required
for the app to render — they unlock optional integrations.

| Key | Purpose | Required? |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase project URL for the optional account/sync layer | optional |
| `SUPABASE_ANON_KEY` | Supabase anon JWT for the same layer | optional |
| `TV_LOGIN_REDIRECT_BASE_URL` | OAuth-style callback base used by the TV login QR flow | optional |
| `YOUTUBE_PROXY_URL` | Path to the bundled YouTube embed proxy (default `youtube-proxy.html`) | optional |
| `ADDON_REMOTE_BASE_URL` | Base URL for remote-managed Stremio addon list | optional |
| `WEBOS_SERVICE_ID` | LG webOS service id (TV wrapper only — unused on web) | optional |
| `ENABLE_REMOTE_WRAPPER_MODE` | Toggles hosted-wrapper mode (TV only) | optional, default `false` |
| `PREFERRED_PLAYBACK_ORDER` | Array picking among `native-hls`, `hls.js`, `dash.js`, `native-file`, `platform-avplay` | optional |
| `TMDB_API_KEY` | TMDB API key for metadata enrichment | optional |

End-user runtime addon URLs (the actual Stremio addons) are added by the
user inside the app UI; they are not deploy-time configuration.

### Setting these in the deployed image

To override the generated default `nuvio.env.js`, supply your own file via
volume mount at deploy time — it is loaded by `index.html` before the bundle.
Add to the operator's `docker-compose.override.yml`:

```yaml
services:
  nuvioweb:
    volumes:
      - /opt/iptv-hub/config/nuvioweb/nuvio.env.js:/usr/share/nginx/html/nuvio.env.js:ro
```

The file is a plain JavaScript snippet that assigns `globalThis.__NUVIO_ENV__`;
see the upstream `scripts/build.mjs` for the exact shape.

## Healthcheck

The compose service runs `wget --spider http://127.0.0.1:8080/` every 30 s
(`start_period=10s`, `retries=3`). The Dockerfile carries the same probe so
`docker run` users get the status without compose.

## DaveAI Provider Proof

Latest Codex proof for the DaveAI override:

- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\nuvio-provider-vault-proof-20260526\local-proof-summary.json`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\nuvio-provider-vault-proof-20260526\nuvio-vault-addon-local.png`
- VPS backup before live static injection:
  `/var/backups/daveai-apps/nuvio-before-provider-vault-20260526T1746Z.tgz`

## Update path

1. Pick an upstream commit at https://github.com/NuvioMedia/NuvioWeb and copy
   the SHA.
2. Rebuild with the new ref:

   ```bash
   docker build \
     --build-arg NUVIOWEB_REF=<new-sha> \
     -f deploy/apps/nuvioweb/Dockerfile \
     -t iptv-hub-nuvioweb:<new-sha> \
     ./deploy/apps/nuvioweb/
   ```

3. Smoke-test locally:

   ```bash
   docker run --rm -p 9730:8080 iptv-hub-nuvioweb:<new-sha>
   curl -fsS http://127.0.0.1:9730/ | head
   ```

4. If the upstream introduces a new build step (e.g. a new env file pathway),
   update this README's configuration table and the build stage in
   `Dockerfile` together; do not silently inherit upstream changes.

## Files in this directory

- `Dockerfile` — multi-stage build (`node:20-alpine` → `nginx:1.27-alpine`).
- `nginx.conf` — runtime nginx site, listens on `:8080`, gzip + caching.
- `overrides/nuvio-daveai-vault-addon.js` — DaveAI provider-vault virtual
  Stremio addon for Apollo Group TV and XtremeHD.
- `overrides/daveai-avatar-catalog.json` — hosted fallback for the optional
  avatar RPC that is not wired in the DaveAI static deployment.
- `docker-compose.service.yml` — service fragment consumed by
  `deploy/scripts/generate-stack.sh`.
- `README.md` — this file.
