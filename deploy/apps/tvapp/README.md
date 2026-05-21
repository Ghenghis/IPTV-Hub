# tvapp (TVApp2) — IPTV Hub deployment

## Upstream

- Source repo: <https://github.com/TheBinaryNinja/tvapp2>
- Maintainers: Aetherinox, iFlip721, Optx (BinaryNinja)
- License: MIT
- Description: self-hosted Docker container that fetches M3U playlists and XMLTV
  EPG guide data from TheTvApp, TVPass, and MoveOnJoy, then re-serves them as a
  local HDHomeRun-compatible endpoint usable by Jellyfin/Plex/Emby.

## Image coordinates

This deployment pins to the upstream-published multi-arch image. We do **not**
rebuild — TheBinaryNinja already publishes signed `linux/amd64` and `linux/arm64`
manifests to all three registries below, and rebuilding locally would diverge
from those artefacts.

| Registry  | Reference (pinned tag + manifest-list digest) |
| --------- | --------------------------------------------- |
| GHCR      | `ghcr.io/thebinaryninja/tvapp2:1.5.9@sha256:934d578925c0e560dca4e009b0b82d7dfa93ffb56c64ec36ef134ba8d4d335c6` |
| Docker Hub | `thebinaryninja/tvapp2:1.5.9` (same content; not the canonical reference here) |
| Gitea     | `git.binaryninja.net/binaryninja/tvapp2:1.5.9` (mirror) |

**Compressed image size (amd64):** ~46.4 MiB across 12 layers.

The digest is the **manifest-list** digest (multi-arch). Docker resolves it to
`sha256:a1608ad586f7cbff1286d42de304d75ba89b2089f47aa3ae258b657dbfc474d9` on
`linux/amd64` and `sha256:7297ca6cf43b622e33962b35f473cceed9cf649fd013adff053a8f954de9ab55`
on `linux/arm64` at pull time.

## Port allocation

| Host (bound to 127.0.0.1) | Container | Protocol | Purpose            |
| ------------------------- | --------- | -------- | ------------------ |
| `127.0.0.1:9810`          | `4124`    | TCP/HTTP | Web UI + HDHomeRun |

Slot 22 in `deploy/PORTS.md`. Host nginx proxies
`tvapp.<DEPLOY_DOMAIN>` → `127.0.0.1:9810` via the rendered fragment in
`deploy/build/nginx/iptv-hub-tvapp.conf`.

## Environment variables

All variables are optional; defaults match upstream. Override via the operator
`.env` file (`deploy/.env`) consumed by `docker compose`.

| Variable                | Default        | Notes                                                                       |
| ----------------------- | -------------- | --------------------------------------------------------------------------- |
| `TVAPP_TZ`              | `Etc/UTC`      | IANA timezone for log timestamps.                                           |
| `TVAPP_STREAM_QUALITY`  | `hd`           | `hd` or `sd`.                                                               |
| `TVAPP_LOG_LEVEL`       | `4` (info)     | 1=error, 2=warn, 3=notice, 4=info, 5=debug, 6=verbose, 7=trace.             |
| `TVAPP_TASK_CRON_SYNC`  | `0 0 */3 * *`  | Cron for refreshing M3U/EPG. **No quotes** around the value.                |
| `TVAPP_HEALTH_TIMER`    | `600000`       | Health check interval (ms) inside the container.                            |

Locked at upstream defaults (not exposed as `.env` knobs): `WEB_IP=0.0.0.0`,
`WEB_PORT=4124`, `URL_REPO=https://git.binaryninja.net/binaryninja/`. Changing
`URL_REPO` breaks playlist/EPG sourcing (per upstream README warning).

## Persistent state (bind mounts)

| Host path                                          | Container path  | Contents                                                |
| -------------------------------------------------- | --------------- | ------------------------------------------------------- |
| `${VPS_INSTALL_ROOT}/data/tvapp/config`            | `/config`       | URLs cache, generated `playlist.m3u8`, `xmltv.xml(.gz)` |
| `${VPS_INSTALL_ROOT}/data/tvapp/app`               | `/usr/bin/app`  | Built TVApp2 runtime (post-build assets)                |

`VPS_INSTALL_ROOT` defaults to `/opt/iptv-hub` per `deploy/scripts/generate-stack.sh`.
Bind mounts (rather than named volumes) keep state visible to plain `tar`/`ls`
on the host — no `docker volume inspect` round-trip for backup. Named volumes
are intentionally avoided because the generator splices this fragment's body
under `services:` in the merged compose file; any top-level `volumes:` key
would break the merge.

## Update path

The image is pinned by tag **and** digest, so `docker pull` is a no-op unless
you bump the pin. To upgrade:

```sh
# 1. From inside this repo, on a workstation with docker:
NEW_TAG=1.6.0  # pick from https://github.com/TheBinaryNinja/tvapp2/releases
docker buildx imagetools inspect "ghcr.io/thebinaryninja/tvapp2:${NEW_TAG}" \
  --format '{{.Manifest.Digest}}'

# 2. Update both files in deploy/apps/tvapp/ with the new tag + digest:
#      - Dockerfile (FROM line)
#      - docker-compose.service.yml (image: line, and iptv-hub.upstream-tag /
#        iptv-hub.image-digest labels)

# 3. Re-run the stack generator (regenerates deploy/docker-compose.apps.yml):
deploy/scripts/generate-stack.sh

# 4. On the VPS, after the next deploy.py SCP'es the new compose files:
docker compose -f docker-compose.yml -f docker-compose.apps.yml pull tvapp
docker compose -f docker-compose.yml -f docker-compose.apps.yml up -d tvapp
```

`:latest` is forbidden by CONTRACT.md §2.5 (reproducibility) and by the strict
deploy policy. Always pin tag + digest.

## Healthcheck

Container probes `http://127.0.0.1:4124/api/health?silent=true` every 30s. The
host nginx fragment also exposes `${ROUTING_PREFIX}/__iptv_hub_probe` for the
`deploy/scripts/verify.py` aggregate dashboard.

## Verifying locally

```sh
# Pull verification (requires a working docker engine):
docker pull ghcr.io/thebinaryninja/tvapp2:1.5.9@sha256:934d578925c0e560dca4e009b0b82d7dfa93ffb56c64ec36ef134ba8d4d335c6

# Registry-only verification (no local pull needed):
docker buildx imagetools inspect \
  ghcr.io/thebinaryninja/tvapp2:1.5.9@sha256:934d578925c0e560dca4e009b0b82d7dfa93ffb56c64ec36ef134ba8d4d335c6
```

## Files in this directory

| Path                         | Purpose                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `Dockerfile`                 | Pass-through `FROM` with the pinned digest.             |
| `docker-compose.service.yml` | Service fragment spliced by `scripts/generate-stack.sh`.|
| `upstream/`                  | Read-only clone of `TheBinaryNinja/tvapp2` for audit.   |
| `README.md`                  | This file.                                              |
