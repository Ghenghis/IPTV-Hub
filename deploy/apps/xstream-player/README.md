# xstream-player (IPTV Hub deploy)

A modern, self-hosted web IPTV player built with Next.js and React. Features
Xstream Codes support, cross-device sync, TMDB integration, OpenSubtitles
integration, and an ad-free premium experience.

- **Upstream repo:** https://github.com/jandersonss/xstream-player
- **Upstream image:** https://hub.docker.com/r/jandersonss/xstream-player
- **Catalogue id:** `xstream-player` (index 24)
- **Host port:** `127.0.0.1:9830` (per `deploy/PORTS.md` §3)
- **Container port:** `3000` (Next.js standalone server)
- **Routing target:** `xstream-player.<DEPLOY_DOMAIN>` -> `127.0.0.1:9830`

## Image pin

This deployment uses the upstream-published image, pinned by tag **and**
sha256 digest. The IPTV-Hub deploy contract (`CONTRACT.md` §2.5) forbids
`:latest` and other floating tags.

```
jandersonss/xstream-player:1.5.1
  @sha256:a3ef8567318d69130b71b440ffc49c568f114d338f5fb13782b4c68935dcc88f
```

| Field          | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Tag            | `1.5.1`                                                            |
| Digest         | `sha256:a3ef8567318d69130b71b440ffc49c568f114d338f5fb13782b4c68935dcc88f` |
| Published      | 2026-05-13                                                         |
| Compressed size| 71,910,806 bytes (~71.9 MB)                                        |
| Resolved from  | `GET https://hub.docker.com/v2/repositories/jandersonss/xstream-player/tags/1.5.1` |

## Environment variables

The upstream image bakes sensible defaults; you do not need to override any of
them for a standard deploy. Listed here for completeness (all set in the
upstream Dockerfile, re-stated in `docker-compose.service.yml`):

| Variable                  | Default        | Notes                                  |
| ------------------------- | -------------- | -------------------------------------- |
| `NODE_ENV`                | `production`   | Next.js production mode.               |
| `NEXT_TELEMETRY_DISABLED` | `1`            | Disables Next.js anonymous telemetry.  |
| `PORT`                    | `3000`         | Container-internal HTTP port.          |
| `HOSTNAME`                | `0.0.0.0`      | Bind all interfaces inside container.  |

No application-specific runtime env vars are required by the upstream image.
IPTV provider credentials (Xstream Codes) are entered through the web UI on
first run and persisted to `/app/data/config.json` inside the volume.

## Persistent data

- **Volume:** `xstream_player_data` (named volume; resolves to
  `${COMPOSE_PROJECT_NAME:-iptv-hub}_xstream_player_data`).
- **Mount point:** `/app/data` inside the container.
- **Contents:** `config.json` with the user's IPTV provider credentials and
  client preferences. **Unencrypted** — back this volume up alongside the
  other IPTV-Hub state.

A named Docker volume (rather than a host bind mount) avoids the uid-1001
permission problem the upstream README documents — Docker initialises the
volume with the container user's ownership on first mount.

## Update path

1. Look up the newest tag and digest:

   ```sh
   curl -s https://hub.docker.com/v2/repositories/jandersonss/xstream-player/tags?page_size=25 \
     | jq -r '.results[] | "\(.name)\t\(.digest)\t\(.last_updated)"'
   ```

   Or open https://hub.docker.com/r/jandersonss/xstream-player/tags in a browser.

2. Pick the most recent **semver** tag (avoid `latest`, `1.5` floating, etc.).
3. Update three places in this directory:
   - `Dockerfile` — the `FROM` line.
   - `docker-compose.service.yml` — the `image:` line **and** the
     `iptv-hub.image-digest` label.
   - `README.md` — the "Image pin" table above.
4. Re-run `deploy/scripts/generate-stack.sh` and the IPTV-Hub deploy harness.
5. Commit with a message like `chore(xstream-player): bump to <tag> (<digest-short>)`.

## Local verification

```sh
# From the repo root, after the per-app fragment is in place:
docker pull jandersonss/xstream-player@sha256:a3ef8567318d69130b71b440ffc49c568f114d338f5fb13782b4c68935dcc88f

# Smoke run (host port 9830 -> container 3000):
docker run --rm -d \
  --name iptv-hub-xstream-player-smoke \
  -p 127.0.0.1:9830:3000 \
  -v iptv_hub_xstream_player_smoke:/app/data \
  jandersonss/xstream-player@sha256:a3ef8567318d69130b71b440ffc49c568f114d338f5fb13782b4c68935dcc88f

curl -sf http://127.0.0.1:9830/ -o /dev/null && echo OK || echo FAIL
docker stop iptv-hub-xstream-player-smoke
docker volume rm iptv_hub_xstream_player_smoke
```

`docker pull` should report the same digest line that is pinned above. If it
does not, the upstream tag has been re-pushed under the same name — investigate
before bumping (`CONTRACT.md` §2.5 forbids accepting a silently-changed tag).

## Security notes

- The image is third-party and signed only by Docker Hub's standard manifest
  digest. The sha256 pin above is the project's trust anchor.
- `config.json` stores IPTV provider credentials in plaintext on disk
  (upstream behaviour, not changeable from outside). The volume must be
  treated as a secret store: back it up encrypted; do not commit dumps.
- The container binds to `127.0.0.1` on the host. Public exposure happens
  only via the host's nginx with TLS (see `deploy/docker-compose.yml`
  preamble).
