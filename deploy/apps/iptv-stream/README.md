# iptv-stream (IPTV Hub app slot 11)

Python-based IPTV web player with EPG and HLS catchup, packaged for the
IPTV-Hub VPS stack.

## Upstream

- **Repo**: <https://github.com/RickyRLD/iptv-player>
- **Pinned commit**: `441eba81c620bea77e22d8e2d5dcf889b0d569a9`
  (`docs: add professional README`, 2026-03-22)
- **License**: MIT
- **Stack**: Python 3.10+ standard library only — zero pip dependencies.
  The HTML/CSS/JS frontend (hls.js player + EPG grid) is embedded inline in
  `iptv_player.py`; the upstream C# WinForms wrapper (`iptv_player.cs`) is
  Windows-only and not used in the container.

## Port binding

Per [`deploy/PORTS.md`](../../PORTS.md) slot 11:

| Where         | Bind                  |
| ------------- | --------------------- |
| Host (Linux)  | `127.0.0.1:9700`      |
| Container     | `0.0.0.0:8765`        |
| Public        | via nginx → `iptv-stream.<DEPLOY_DOMAIN>` |

The container is **never** reachable from the public internet directly. The
host nginx (`deploy/nginx/iptv-hub-site.conf.template`) is the only ingress.

## Build

```sh
docker build \
  -f deploy/apps/iptv-stream/Dockerfile \
  -t iptv-hub-iptv-stream:latest \
  ./deploy/apps/iptv-stream/
```

The build is reproducible: `Dockerfile` clones the pinned upstream SHA inside
the `fetch` stage. Nothing under `deploy/apps/iptv-stream/upstream/` is read by
the build (that path is just where a developer can `git clone` the repo
locally for inspection — it is `.gitignore`d).

## Environment variables

All variables have safe defaults baked into the image; override per deploy via
the compose `environment:` block or `deploy/.env`.

| Variable          | Default                                | Purpose                                                                 |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `IPTV_BIND_HOST`  | `0.0.0.0`                              | Listen address inside the container. Do not change unless tunneling.    |
| `IPTV_PORT`       | `8765`                                 | Container-internal HTTP port. Must stay 8765 to match the policy slot.  |
| `IPTV_M3U_FILE`   | `/app/data/rpl.m3u`                    | Path inside the container where the M3U playlist lives.                 |
| `IPTV_EPG_URL`    | `http://list.plusx.tv/pl10.gz`         | XMLTV-gz feed URL. Upstream default; override for a different provider. |
| `PYTHONUNBUFFERED`| `1`                                    | Ensures container logs flush immediately.                               |

## Volumes

| Container path             | Host source                                         | Mode | Notes                                                            |
| -------------------------- | --------------------------------------------------- | ---- | ---------------------------------------------------------------- |
| `/app/data/rpl.m3u`        | `${VPS_INSTALL_ROOT}/user-data/iptv-stream/rpl.m3u` | `ro` | Operator-supplied playlist. Create the file before `up`.         |

Before the first `docker compose up`:

```sh
sudo install -d -o "$USER" -g "$USER" -m 0750 \
    /opt/iptv-hub/user-data/iptv-stream
sudo install -o "$USER" -g "$USER" -m 0644 /dev/null \
    /opt/iptv-hub/user-data/iptv-stream/rpl.m3u
# then copy your real playlist on top of that empty file:
cp /path/to/your-playlist.m3u /opt/iptv-hub/user-data/iptv-stream/rpl.m3u
```

The image ships an empty placeholder file at `/app/data/rpl.m3u` so the
container will start even before the bind-mount target exists on the host —
but the channel list stays empty until a real playlist replaces it.

## Health check

The container's `HEALTHCHECK` polls
`http://127.0.0.1:8765/api/epg/status` every 30 s; that endpoint always
returns a JSON status document, so it works as a liveness probe regardless of
whether the EPG fetch has completed.

The compose service fragment repeats the same probe at the docker-compose
layer for the verify dashboard to read.

## Run locally (without the rest of the stack)

```sh
docker run --rm -p 127.0.0.1:9700:8765 \
  -v "$PWD/sample-playlist.m3u:/app/data/rpl.m3u:ro" \
  iptv-hub-iptv-stream:latest
# Browse http://127.0.0.1:9700/
```

## Update path

1. Pick a newer commit from <https://github.com/RickyRLD/iptv-player>.
2. Edit `Dockerfile` and bump `IPTV_PLAYER_SHA` to the new value.
3. Verify the four `sed`-style literal patches in the build-time
   `PYPATCH` heredoc still match the upstream source. If upstream
   reformats one of the four lines, the patch step fails the build (by
   design — silent drift is worse than a broken build).
4. `docker build -f deploy/apps/iptv-stream/Dockerfile -t iptv-hub-iptv-stream:test ./deploy/apps/iptv-stream/`
5. `docker run --rm -p 127.0.0.1:9700:8765 iptv-hub-iptv-stream:test` and
   hit `/api/epg/status` to confirm.
6. Commit the bumped SHA.

## API reference

Inherited from upstream README (verified against `iptv_player.py`
`do_GET`):

| Method | Endpoint                                     | Purpose                                              |
| ------ | -------------------------------------------- | ---------------------------------------------------- |
| GET    | `/`                                          | Embedded HTML player UI.                             |
| GET    | `/api/channels`                              | Full channel list parsed from the M3U.               |
| GET    | `/api/epg/status`                            | EPG loader state JSON (used by the health probe).    |
| GET    | `/api/epg/channel?id=<tvg-id>`               | EPG entries for one channel.                         |
| GET    | `/api/catchup?url=<m3u8>&start=<ts>&dur=<s>` | Returns a Flussonic-style catchup URL.               |
| GET    | `/api/reload_epg`                            | Re-fetches the EPG in a background thread.           |

## Out of scope

- The upstream `.exe`/WebView2 path (`iptv_player.cs`, `compile.bat`) is
  Windows-only and not packaged here. Use the upstream `installer` source if a
  desktop entry is needed.
- The upstream `agent-harness/` CLI is a developer aid, not a production
  surface; it is dropped during the `fetch` build stage to keep the image
  small.
