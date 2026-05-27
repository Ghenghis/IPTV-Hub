# stalker-ui (IPTV Hub deployment slice)

WebUI wrapper around Stalker / Ministra IPTV portal accounts: profile manager,
HLS playlist endpoint, Stalker-style proxy endpoint, per-profile filtering.

| Field | Value |
| --- | --- |
| Upstream | <https://github.com/kidpoleon/stalkerhek> |
| Pinned commit | `0fdc13f8ed33137a54d96420edc387951a54c9f5` (2026-05-19) |
| Upstream licence | GPL-3.0 (see [`upstream/LICENSE`](./upstream/LICENSE)) |
| Language / build | Go 1.24 (`./cmd/stalkerhek`) |
| Catalogue index | 20 |
| Host port (loopback) | **9790** |
| Container port | **4400** |
| Listener inside container | `0.0.0.0:4400` (`webui/webui.go: Addr: ":4400"`) |
| WebUI entry path | `/dashboard` |
| Health probe paths | `/health`, `/healthz` (unauthenticated) |
| Persistent volume | `${VPS_INSTALL_ROOT}/data/stalker-ui` → `/data` |
| Image tag | `iptv-hub-stalker-ui:local` |

The upstream source tree is vendored under [`upstream/`](./upstream/) so the
Docker build context is self-contained and the deployment is reproducible
without a fresh `git clone` at deploy time.

## Files

| Path | Purpose |
| --- | --- |
| [`Dockerfile`](./Dockerfile) | Multi-stage build: `golang:1.24-alpine` → `alpine:3.20`. Mirrors upstream's Dockerfile, paths adjusted for the vendored `upstream/` tree, plus a non-root `stalker` user and `/data` ownership. |
| [`docker-compose.service.yml`](./docker-compose.service.yml) | Service fragment spliced into `deploy/docker-compose.apps.yml` by `deploy/scripts/generate-stack.sh`. Binds host `127.0.0.1:9790` to container `4400`. |
| `upstream/` | Vendored snapshot of `kidpoleon/stalkerhek` at the pinned commit above. |

## Environment variables

All variables are read by the stalkerhek binary at startup. Required values
are signalled by their absence — when unset, stalkerhek falls back to in-image
defaults that **do not persist across container recreate**.

| Variable | Default in image | Purpose |
| --- | --- | --- |
| `STALKERHEK_ROOT` | `/app` | Root of bundled assets (`graphic/` lives here). Must point at the directory inside the image. Do not change. |
| `STALKERHEK_PROFILES_FILE` | `/data/profiles.json` | Encrypted Stalker portal profiles (URL, MAC, serial, device id, signature, optional username/password). Created on first profile save through the WebUI. |
| `STALKERHEK_AUTH_FILE` | `/data/auth.json` | WebUI user store. Auto-derived from `STALKERHEK_PROFILES_FILE`'s directory when unset. |
| `STALKERHEK_FILTERS_FILE` | `/data/filters.json` | Per-profile category/genre/channel filters. |
| `STALKERHEK_RESTART_HOURS` | `24` | Process exits cleanly every N hours; Docker restarts it. Set `0` to disable. |
| `STALKERHEK_DISABLE_AUTH` | _(unset)_ | Setting to `1` removes the WebUI login. **Do not do this in a deployed environment** — `/dashboard` exposes portal credentials in plain text. |
| `STALKERHEK_ALLOW_REGISTER` | _(unset)_ | Set to `1` only during initial admin enrolment. Disable once the admin user exists. |
| `STALKERHEK_TRUSTED_SUBNETS` | _(unset)_ | Comma-separated CIDR list (e.g. `127.0.0.1/32,10.0.0.0/8`) whose requests bypass the login wall. Useful when fronted by a known-good reverse proxy on the same host. |
| `STALKERHEK_WEBUI_GZIP` | _(unset)_ | Set to `1` to gzip WebUI HTML/JS/CSS responses. |

Stalker portal credentials themselves are entered through the WebUI at
`/dashboard` after the first login — they are not supplied via env vars,
because the upstream auth flow signs portal responses against secrets that
the WebUI generates per profile.

## Ports

This service binds host loopback only:

```
127.0.0.1:9790  ->  container 4400 (WebUI)
```

The container's WebUI listens on `0.0.0.0:4400` (`webui/webui.go`), which is
reachable from the docker bridge — bridge-mode port mapping is supported even
though the upstream `docker-compose.yml` defaults to `network_mode: host`. We
use bridge mode here because every other app on the VPS does, and the
healthcheck-aggregator + nginx ingress only need port 9790 visible.

If you later configure additional Stalker profiles that expose HLS or proxy
endpoints, add the extra `host:container` mappings to
[`docker-compose.service.yml`](./docker-compose.service.yml) by reserving
ports from this app's slot (`9791`–`9799`, per
[`../PORTS.md`](../../PORTS.md) §3).

## Update path

The upstream snapshot is pinned by directory contents, not by submodule, so
updating means re-vendoring the tree:

```
cd deploy/apps/stalker-ui
rm -rf upstream
git clone --depth=1 https://github.com/kidpoleon/stalkerhek.git upstream
( cd upstream && git rev-parse HEAD )   # record the new commit SHA
```

Then:

1. Update the `Pinned commit` row in this README.
2. Update the `iptv-hub.upstream.commit` label and the corresponding comment
   in [`docker-compose.service.yml`](./docker-compose.service.yml).
3. Update the commit SHA in [`Dockerfile`](./Dockerfile)'s header.
4. Rebuild the image:
   ```
   docker build -f deploy/apps/stalker-ui/Dockerfile \
                -t iptv-hub-stalker-ui:test \
                ./deploy/apps/stalker-ui/
   ```
5. Re-run `deploy/scripts/generate-stack.sh` and `deploy/scripts/deploy.sh`.

Note: do not modify files under `upstream/` in-tree. If a patch is genuinely
needed, send it upstream first; if it is unavoidable in the meantime, add it
under a sibling `patches/` directory and apply it as a build step in the
Dockerfile so the provenance is auditable.

## Reverse-proxy fragment

`deploy/scripts/generate-stack.sh` renders an nginx site fragment for this
service from [`../../nginx/iptv-hub-site.conf.template`](../../nginx/iptv-hub-site.conf.template).
The rendered fragment proxies `Host: stalker-ui.<DEPLOY_DOMAIN>` (or the
path-mode equivalent) to `127.0.0.1:9790`. WebSocket upgrade and long
read/send timeouts are already present in the template — stalkerhek's live
profile-status updates use them.

## Operational notes

- The container runs as a non-root `stalker` user (uid/gid auto-assigned by
  Alpine; bind-mount permissions on `/data` must allow this user to write).
  If you see "permission denied" on first start, run
  `sudo chown -R 100:101 ${VPS_INSTALL_ROOT}/data/stalker-ui` (Alpine's
  first `adduser -S` lands at uid 100, gid 101 with this image's package
  set); double-check by `docker exec -it iptv-hub_stalker-ui id`.
- The process restarts itself every 24 hours by default
  (`STALKERHEK_RESTART_HOURS`). This is normal; profiles in `/data` survive.
- The Stalker portal protocol talks plain HTTP in many deployments; outgoing
  traffic from the container goes through the docker bridge and out the
  host's default route — no extra firewall rules are needed.

## DaveTV Provider-Vault Host Build

The hosted static Stalker UI at `https://stalker-ui.daveai.tech/` uses the
tracked `static-web-overrides/` React/Vite build rather than the Go WebUI
container above. The hosted build loads Apollo Group TV and XtremeHD through
the DaveTV provider vault only, keeps provider credentials server-side, and
plays through same-origin `/api/provider-vault/stream` and
`/api/provider-vault/segment` URLs.

Provider rows are interleaved when the user browses all live channels, movies,
or series. That keeps both Apollo Group TV and XtremeHD visible near the top of
the catalog instead of burying the second provider after the first provider's
full result set.

Latest deep playback proof:

- `npm run build` from `G:\Github\IPTV-web\stalker-ui`
- deployed sha256:
  `c53ead67954d35c707cda203803e9d3b53f4e90d568bc0a601da98f06f92271c`
- proof summary:
  `C:\Users\Admin\Downloads\VPS\_visual_artifacts\stalker-ui-provider-playback-proof-20260527\summary.json`
- screenshots:
  `stalker-ui-apollo-player.png`, `stalker-ui-xtremehd-player.png`
