# xstream-player (DaveAI source build)

A DaveAI-maintained build of the upstream Next.js IPTV player, packaged for
`apps.daveai.tech`. This app is used for Xtream Codes-compatible providers such
as XtremeHD and Apollo Group TV.

- **Upstream repo:** https://github.com/jandersonss/xstream-player
- **Source base:** upstream `v1.5.1`
- **Catalogue id:** `xstream-player` (index 24)
- **Host port:** `127.0.0.1:9830` in IPTV-Hub Docker deploys
- **Live VPS service:** `davetv-xstream-player.service` on `127.0.0.1:3101`
- **Public route:** `xstream-player.daveai.tech` behind the DaveTV auth gate

## DaveAI changes

The app is no longer deployed as a direct third-party image pin. DaveAI builds
from the checked-in `source/` tree so provider compatibility and playback
polish can be versioned and reviewed.

Current DaveAI deltas:

- English-first interface for login, dashboard, navigation, empty states,
  settings, series, movies, live TV, and player controls.
- Provider-vault support for managed provider credentials. When Apollo Group TV
  and XtremeHD are configured in the private vault, the login screen shows
  one-click provider buttons and keeps raw credentials server-side.
- Apollo/XtremeHD-friendly Xtream Codes flow retained from the live VPS build.
  Live TV, movie, and series playback use tokenized provider-vault stream URLs
  for managed provider sessions, with manual Xtream login still available as a
  fallback.
- Larger HLS buffering profile for VOD playback:
  - VOD target buffer: 300 seconds.
  - Live target buffer: 90 seconds.
  - VOD startup wait: 20 seconds or first useful buffer, whichever comes first.
  - Larger VOD memory budget: 512 MB by default.
- Conservative ABR ramp-up to reduce movie stalls on bursty IPTV providers.
- Next.js standalone Docker image built from local source.

## Runtime environment

| Variable                  | Default        | Notes                                      |
| ------------------------- | -------------- | ------------------------------------------ |
| `NODE_ENV`                | `production`   | Next.js production mode.                   |
| `NEXT_TELEMETRY_DISABLED` | `1`            | Disables Next.js anonymous telemetry.      |
| `PORT`                    | `3000`         | Container-internal HTTP port.              |
| `HOSTNAME`                | `0.0.0.0`      | Container bind address.                    |
| `IPTV_PRIVATE_DIR`        | `/app/private` | Read-only private provider-vault material. |

Playback tuning can be overridden at build/runtime when needed:

| Variable                         | Default |
| -------------------------------- | ------- |
| `NEXT_PUBLIC_XSTREAM_VOD_BUFFER_SECONDS` | `300`   |
| `NEXT_PUBLIC_XSTREAM_LIVE_BUFFER_SECONDS` | `90`    |
| `NEXT_PUBLIC_XSTREAM_VOD_START_BUFFER_SECONDS` | `20` |
| `NEXT_PUBLIC_XSTREAM_LIVE_START_BUFFER_SECONDS` | `6` |
| `NEXT_PUBLIC_XSTREAM_VOD_MAX_BUFFER_MB` | `512`   |
| `NEXT_PUBLIC_XSTREAM_LIVE_MAX_BUFFER_MB` | `192`  |

## Persistent data

- **Volume:** `xstream_player_data`
- **Mount point:** `/app/data`
- **Contents:** IPTV credentials and local preferences.

The provider-vault private directory is mounted separately as read-only:

- **Volume:** `xstream_player_private`
- **Mount point:** `/app/private:ro`

Treat both volumes as sensitive. Provider credentials must not be committed.

## Local build and smoke test

From the repo root:

```sh
docker build -t daveai/xstream-player:1.5.1-daveai.1 ./deploy/apps/xstream-player

docker run --rm -d \
  --name iptv-hub-xstream-player-smoke \
  -p 127.0.0.1:9830:3000 \
  -v iptv_hub_xstream_player_smoke:/app/data \
  daveai/xstream-player:1.5.1-daveai.1

curl -sf http://127.0.0.1:9830/ -o /dev/null && echo OK || echo FAIL
docker stop iptv-hub-xstream-player-smoke
docker volume rm iptv_hub_xstream_player_smoke
```

Expected first-screen English text:

- `Welcome`
- `Enter your IPTV credentials to start streaming`
- `SERVER URL`
- `USERNAME`
- `PASSWORD`
- `Connect`
- `Compatible with the Xtream Codes API`

## VPS deploy notes

The current production VPS service is source-based at:

```text
/opt/davetv/services/xstream-player
```

After source updates on the VPS:

```sh
cd /opt/davetv/services/xstream-player
NODE_ENV=production npm run build
systemctl restart davetv-xstream-player.service
curl -sf http://127.0.0.1:3101/ -o /dev/null && echo OK
```

The production service currently sits behind the DaveTV auth gate. External
unauthenticated probes should redirect to login; direct localhost probes on the
VPS should return the rendered app.

## Security notes

- Provider credentials are sensitive and must remain outside git.
- The container binds only to loopback in the composed deploy.
- Public exposure must happen through nginx/TLS and the DaveTV auth gate.
- Keep the source tree free of `.next`, `node_modules`, private provider data,
  and local `.env` files.
