# smart-iptv-web

IPTV Hub catalogue slot **19**. Web-based IPTV player with optional EPG sidecar.

## Upstream

- **Source**: <https://github.com/Web-IPTV/iptv>
- **Pinned commit**: `46b6b677d5eeef0c91c18d45ac00a2fa9daf0a32`
  (declared as `UPSTREAM_REF` in `Dockerfile`; bump it deliberately, do not
  pull `HEAD`).
- **License**: MIT (per upstream `package.json`).
- **Language / stack**: HTML / JS player + Node.js (Express) EPG server.
  The upstream README documents the run command as
  `python3 -m http.server 8080` for the UI and `node epg-server.js` for the
  EPG service on port `3001`.

The upstream repo **does not ship a Dockerfile**. The Dockerfile in this
directory was authored from scratch and faithfully reproduces upstream's
documented run model.

## Architecture

One container per process (one-process-per-container is cleaner than a
supervisord shim for two unrelated services). The single `Dockerfile`
declares two targets so both images share the upstream `fetch` stage:

| Container                   | Target | Base image                                | Internal port | Host port (loopback) |
| --------------------------- | ------ | ----------------------------------------- | ------------- | -------------------- |
| `..._smart-iptv-web`        | `ui`   | `nginxinc/nginx-unprivileged:1.27-alpine` | **8080**      | **9780**             |
| `..._smart-iptv-web_epg`    | `epg`  | `node:20.18-alpine`                       | **3001**      | **9781**             |

Host port mapping follows `deploy/PORTS.md` §3 (catalogue index 19,
slot base 9780; ws/aux slot +1 = 9781). Both ports bind to `127.0.0.1` only.

## DaveTV hosted override

The live DaveTV service at `smart-iptv-web.daveai.tech` currently runs a
Next.js provider-vault build, not the original static upstream container
described above. The hosted override files that must be preserved when
rebuilding that live service are tracked here:

```text
overrides/app/SmartHomeClient.tsx
overrides/components/auth/Login.tsx
overrides/components/dashboard/ChannelGrid.tsx
overrides/components/player/VideoPlayer.tsx
overrides/components/dashboard/SettingsView.tsx
```

These override files make the hosted provider-vault experience real:

- Apollo Group TV, XtremeHD, and Combined Tagged provider modes;
- English catalog profile by default;
- browser storage keeps provider IDs and display names only, not raw provider
  host, username, or password;
- HLS/MPEG-TS buffer controls with 300-second default buffering and 256/512 MB
  presets;
- provider-vault HLS manifests are always played with HLS.js, even when the
  upstream source extension is `ts`.

See `PROOF-20260528.md` for the current strict Apollo/XtremeHD/combined proof.

### EPG port — explicit

The EPG service listens on container port **3001** and is published to host
`127.0.0.1:9781`. The UI does **not** call it automatically: the operator
must set `SMART_IPTV_WEB_EPG_BASE_URL` (consumed by the player at runtime via
its settings panel) to an absolute URL that the operator's host nginx routes
back to `127.0.0.1:9781`. The EPG service is optional; the UI works as a
plain IPTV player without it.

## Environment variables

All are optional. None are needed for the player to play streams.

| Variable                              | Service | Default       | Purpose                                                                                                 |
| ------------------------------------- | ------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `SMART_IPTV_WEB_EPG_BASE_URL`         | ui      | empty         | Absolute URL of the EPG service as seen by the browser, e.g. `https://smart-iptv-web-epg.daveai.tech/`. |
| `SMART_IPTV_WEB_M3U_URL`              | epg     | empty         | Default playlist URL the operator wants the player to suggest. Stored only as env passthrough.          |
| `SMART_IPTV_WEB_EPG_URL`              | epg     | empty         | Upstream XMLTV / EPG feed URL the operator's python script should pull from.                            |
| `SMART_IPTV_WEB_EPG_SCRIPT_PATH`      | epg     | `/app/epg_fetch.py` | Path inside the container to the operator-supplied python EPG fetcher (see "EPG fetcher" below).  |
| `SMART_IPTV_WEB_CACHE_MINUTES`        | epg     | `30`          | How long the EPG service caches a channel's programme list before re-running the python script.        |

The player UI also reads the legacy upstream variables (`HTTP_PORT`,
`EPG_PORT`, `M3U_FILE_PATH`) via its in-browser `localStorage` settings
panel — see `CONFIGURATION.md` from upstream (copied into the image at
`/usr/share/nginx/html/CONFIGURATION.md`).

## EPG fetcher script

`epg-server.js` spawns `python3 <EPG_SCRIPT_PATH> <channelId> --limit 20`
when a client hits `GET /api/epg/:channelId`. Upstream **does not** ship a
real `epg_fetch.py` — it expects the operator to provide one (the upstream
env example hardcodes `/Users/harshalkutkar/epg_fetch.py`, the maintainer's
local path).

Until you mount one in, the following EPG endpoints behave as follows:

| Endpoint                       | Status without script | Status with script                |
| ------------------------------ | --------------------- | --------------------------------- |
| `GET  /api/health`             | 200 OK                | 200 OK                            |
| `GET  /api/cache/status`       | 200 OK (empty cache)  | 200 OK                            |
| `DELETE /api/cache`            | 200 OK                | 200 OK                            |
| `GET  /api/epg/:channelId`     | 500 (python missing)  | 200 OK (cached after first hit)   |

To wire in a real fetcher, uncomment the volume in
`docker-compose.service.yml`:

```yaml
volumes:
  - /opt/iptv-hub/smart-iptv-web/epg_fetch.py:/app/epg_fetch.py:ro
```

The python script must accept `<channelId> --limit N` and emit lines in the
format `YYYYMMDDHHMMSS +0000 -> YYYYMMDDHHMMSS +0000 | Programme title`
(see `epg-server.js` `parseEPGOutput()` for the exact regex).

## Build

The companion `docker-compose.service.yml` builds both targets in one
`docker compose build` pass. To verify a single target locally:

```sh
# UI (primary)
docker build --target ui  -f deploy/apps/smart-iptv-web/Dockerfile \
    -t iptv-hub-smart-iptv-web-ui:test  ./deploy/apps/smart-iptv-web/

# EPG sidecar
docker build --target epg -f deploy/apps/smart-iptv-web/Dockerfile \
    -t iptv-hub-smart-iptv-web-epg:test ./deploy/apps/smart-iptv-web/
```

The build context is `./deploy/apps/smart-iptv-web/` because the Dockerfile
clones the upstream repo in its `fetch` stage — no local source is needed.

## Run

Under the hub orchestrator:

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.apps.yml \
    up -d smart-iptv-web smart-iptv-web-epg
```

Then:

- Player landing page: `http://127.0.0.1:9780/`
- Player full UI:      `http://127.0.0.1:9780/web-iptv.html`
- EPG health:          `http://127.0.0.1:9781/api/health`

## Update path

1. Check the upstream repo for a new commit on `main` and review the diff
   against `46b6b67…`.
2. Bump `UPSTREAM_REF` in `Dockerfile` to the new SHA (do **not** use a
   moving ref like `main`).
3. Bump the image tag in `docker-compose.service.yml` (e.g.
   `iptv-hub-smart-iptv-web-ui:1.0.1`).
4. Rebuild and redeploy:
   ```sh
   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.apps.yml \
       build smart-iptv-web smart-iptv-web-epg
   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.apps.yml \
       up -d smart-iptv-web smart-iptv-web-epg
   ```
5. The pinned SHA is also written to `/usr/share/nginx/html/UPSTREAM_SHA`
   inside the UI image and `/app/UPSTREAM_SHA` inside the EPG image so the
   verify dashboard can prove which upstream commit is live.

## Known limitations (honest)

- The UI is delivered as plain static files because the upstream "build" is
  Electron-only and not relevant for a web deployment. The player runs
  entirely client-side; M3U playlists are fetched directly by the browser
  and need CORS-friendly hosts.
- The EPG service requires an operator-supplied `epg_fetch.py`. Without it,
  only the cache/health endpoints function — this matches upstream's
  shipped behaviour, not a regression.
- `mpegts.js` is loaded from a CDN by `web-iptv.html`; the player will not
  function in air-gapped deployments without re-pointing that script tag.
