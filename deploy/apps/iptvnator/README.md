# iptvnator — IPTV Hub deploy slice

Self-hosted PWA build of [`4gray/iptvnator`](https://github.com/4gray/iptvnator)
for the IPTV-Hub VPS stack.

## Upstream

| Field                   | Value                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| Upstream repo           | https://github.com/4gray/iptvnator                                           |
| Upstream Dockerfile     | https://github.com/4gray/iptvnator/blob/master/docker/Dockerfile             |
| Upstream docker README  | https://github.com/4gray/iptvnator/blob/master/docker/README.md              |
| Pinned commit (SHA)     | `b2909a11863cc46de250d13a0c5180dc49b997c6`                                   |
| Pinned commit date      | 2026-05-21 (`feat(workspace): add keyboard shortcuts help (#957)`)           |
| Upstream version        | `0.22.0` (`package.json`)                                                    |
| Stack                   | Angular PWA + Nx + Express `web-backend`, served by nginx in a Node container |
| License                 | MIT (see [`LICENSE`](https://github.com/4gray/iptvnator/blob/b2909a11/LICENSE)) |

The upstream image (`4gray/iptvnator:latest` on Docker Hub) is also published.
We do **not** consume the published tag here — the contract requires pinned
inputs end-to-end, so the IPTV-Hub Dockerfile fetches the commit by SHA and
runs the upstream build recipe verbatim. If the upstream is unreachable at
build time, switch the compose `image:` line to `4gray/iptvnator@sha256:<digest>`
once Docker Hub adds digest-pinned tags for the matching commit.

## Port allocation

| Bind                      | Port | Source                                  |
| ------------------------- | ---- | --------------------------------------- |
| Container internal        | `80` | Upstream `docker/Dockerfile` `EXPOSE 80` |
| Host (`127.0.0.1` only)   | `9680` | `deploy/PORTS.md` row #09 (`iptvnator`) |

The host port is bound to loopback only. Public ingress goes through the
operator-side host nginx (`deploy/nginx/iptv-hub-site.conf.template`) which
proxies `iptvnator.<DEPLOY_DOMAIN>` → `127.0.0.1:9680`.

## Environment variables

Inherited from upstream (`docker/README.md`). Defaults shown match
`docker-compose.service.yml` in this directory.

| Variable                                 | Default in IPTV-Hub                      | Purpose |
| ---------------------------------------- | ---------------------------------------- | ------- |
| `BACKEND_URL`                            | `/api`                                   | Browser-facing path for the bundled Express backend; the in-container nginx proxies `/api/ → 127.0.0.1:${PORT}`. Keep at `/api`. |
| `CLIENT_URL`                             | `http://127.0.0.1:9680` (overridable via `IPTVNATOR_CLIENT_URL`) | CORS allow-origin for the backend. In production set to `https://iptvnator.<DEPLOY_DOMAIN>` (multiple values comma-separated). |
| `PORT`                                   | `3000`                                   | Internal Express port. The nginx config template substitutes this at container startup. |
| `IPTVNATOR_PROXY_ALLOW_PRIVATE_NETWORKS` | `0`                                      | **Keep at `0`.** Setting to `1` lets the in-container backend proxy private/loopback/link-local IPs, which is unsafe on a public VPS. |
| `NODE_EXTRA_CA_CERTS`                    | unset                                    | Optional path inside container to a CA bundle for IPTV providers with private CAs. |

Override `CLIENT_URL` for production by exporting `IPTVNATOR_CLIENT_URL`
before `docker compose up`, or by writing a `docker-compose.override.yml`
in the deploy root.

## DaveAI provider-vault bootstrap

The IPTV-Hub build injects
`iptvnator-daveai-vault-bootstrap.js` into the generated PWA before the Angular
bundle starts. The bootstrap keeps Apollo Group TV and XtremeHD credentials
server-side by importing provider-vault catalog rows as ordinary IPTVnator M3U
playlists in IndexedDB:

| Provider       | Playlist title                         | Browser data |
| -------------- | -------------------------------------- | ------------ |
| Apollo Group TV | `Apollo Group TV - DaveAI Vault`       | Safe `/api/provider-vault/stream` URLs only |
| XtremeHD       | `XtremeHD - DaveAI Vault`              | Safe `/api/provider-vault/stream` URLs only |

The script also pins first-run language defaults to English and leaves a small
“DaveAI Providers” refresh panel so the user can refresh either provider catalog
without typing credentials into IPTVnator. It does not modify the upstream
Angular bundle and can be removed by deleting the injected script tag plus the
override file.

Current hosted bootstrap: `20260526-v5`. This version force-refreshes stale
Xtream deep links into the safe DaveAI playlist route and prevents the legacy
cleanup pass from deleting DaveAI vault playlists. Live proof is recorded in
`PROOF-20260526.md`.

## Build & run (local)

```sh
# From repo root.
docker build -t iptv-hub/iptvnator:0.22.0-b2909a11 deploy/apps/iptvnator
```

The build runs three stages: a `git`-pinned fetch of the upstream tree at the
pinned SHA, a Node 22 build stage (`pnpm nx build web --configuration=pwa`
plus `pnpm nx build web-backend`), and a Node 22 runtime stage with nginx
fronting the static PWA and proxying `/api/` to the Express backend. The
build takes 5–10 minutes the first time because the Angular bundle is large.

To run the container standalone (without the rest of the stack):

```sh
docker run --rm -p 127.0.0.1:9680:80 \
    -e CLIENT_URL=http://127.0.0.1:9680 \
    iptv-hub/iptvnator:0.22.0-b2909a11
```

Then open <http://127.0.0.1:9680/>.

## Integration into the IPTV-Hub stack

The compose fragment `docker-compose.service.yml` is consumed by
`deploy/scripts/generate-stack.sh`, which splices it into
`deploy/docker-compose.apps.yml`. The full stack is then brought up by:

```sh
docker compose \
    -f deploy/docker-compose.yml \
    -f deploy/docker-compose.apps.yml up -d
```

The container joins the `iptv_hub_net` bridge network. The host's existing
nginx (managed outside this repo) proxies the public URL to `127.0.0.1:9680`.

## Update path

1. Pick a newer upstream commit on `master` of `4gray/iptvnator`.
2. Update **three places** in this directory:
   - `Dockerfile`: the `IPTVNATOR_SHA` ARG and the header comment.
   - `docker-compose.service.yml`: the `image:` tag suffix and the
     `iptv-hub.upstream-sha` / `iptv-hub.upstream-version` labels.
   - `README.md`: the table at the top of this file.
3. If `node:22-alpine` or `alpine/git:v2.49.0` upstream digests have changed,
   re-resolve via:
   ```sh
   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
   curl -sI -H "Authorization: Bearer $TOKEN" \
       -H "Accept: application/vnd.oci.image.index.v1+json" \
       https://registry-1.docker.io/v2/library/node/manifests/22-alpine \
     | awk -F': ' '/docker-content-digest/{print $2}'
   ```
   then update the `@sha256:` pins.
4. `docker compose build iptvnator` and verify `/api/health` returns 200.
5. Commit and bump `CHANGELOG.md` under `[Unreleased]`.

## Files

| File                            | Purpose                                                |
| ------------------------------- | ------------------------------------------------------ |
| `Dockerfile`                    | Pinned multi-stage build — fetch, Node build, runtime. |
| `docker-compose.service.yml`    | Service fragment merged into `docker-compose.apps.yml`. |
| `overrides/iptvnator-daveai-vault-bootstrap.js` | DaveAI provider-vault playlist seeder for Apollo/XtremeHD. |
| `README.md`                     | This file.                                             |
