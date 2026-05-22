# IPTV Hub — VPS deployment kit

This directory packages the entire VPS-side stack: reverse proxy, per-app
Docker services, port policy, preflight, verify, and uninstall. Everything is
infrastructure-as-code; no manual server-side fiddling required.

> **Status**: the cross-cutting infrastructure (Caddy, compose root, scripts,
> port policy) is committed and locally verified. Per-app services land one at
> a time as the URL audit (`deploy/INVENTORY.md`) verifies each upstream repo
> is real, fetchable, and web-deployable. The kit refuses to invent fake URLs.

## Files

| Path | Purpose |
| --- | --- |
| [`PORTS.md`](./PORTS.md) | Binding port policy (28-app deterministic table). |
| [`ports.json`](./ports.json) | Machine-readable mirror, consumed by every script. |
| `INVENTORY.md` (generated) | Real vs dead URL audit + web-deployability verdict per app. |
| `inventory-status.json` (generated) | Same data, machine-readable. |
| [`.env.example`](./.env.example) | Operator env template (copy to `.env` on the VPS). |
| [`docker-compose.yml`](./docker-compose.yml) | Cross-cutting services (Caddy, healthcheck aggregator). |
| `docker-compose.apps.yml` (generated) | Per-app services, merged from `apps/<id>/`. |
| [`caddy/Caddyfile.template`](./caddy/Caddyfile.template) | Reverse-proxy template. |
| `caddy/Caddyfile` (generated) | Rendered config consumed by Caddy at runtime. |
| [`scripts/preflight.sh`](./scripts/preflight.sh) | Refuses to deploy if any policy port is in use on the host. |
| [`scripts/preflight.ps1`](./scripts/preflight.ps1) | Local Windows mirror of the above. |
| [`scripts/generate-stack.sh`](./scripts/generate-stack.sh) | Renders Caddyfile + apps compose from policy + inventory. |
| [`scripts/deploy.sh`](./scripts/deploy.sh) | One-shot: preflight → generate → pull → up → verify. |
| [`scripts/verify.sh`](./scripts/verify.sh) | Hits every deployed app through Caddy, writes status.json. |
| [`scripts/uninstall.sh`](./scripts/uninstall.sh) | Tear-down (safe; `--purge` to wipe volumes). |
| `apps/<id>/` | Per-app Dockerfile + service fragment (added per real, verified app). |
| `healthcheck/` | Loopback-only Nginx that serves the verify dashboard. |

## One-time host setup

The VPS needs:

- Linux x86_64 (Ubuntu 22.04 LTS or 24.04 LTS recommended, also works on
  Debian 12, Rocky 9, Alma 9).
- Docker 24+ with the Compose v2 plugin (`docker compose ...`, NOT
  `docker-compose ...`).
- `jq` and `curl` on PATH.
- Open inbound 80 + 443 in the firewall. Nothing else faces the public net.
- Ports listed in [`PORTS.md`](./PORTS.md) free on the loopback interface
  (`scripts/preflight.sh` enforces this).
- A DNS name pointing at the VPS for the chosen `DEPLOY_DOMAIN`, plus a
  wildcard `*.<domain>` if you use subdomain routing.

Pre-create the host directories the bind mounts expect (paths are configurable
via `.env`):

```
sudo install -d -o $USER -g $USER -m 750 \
  /opt/iptv-hub/data \
  /opt/iptv-hub/cache \
  /opt/iptv-hub/caddy-data \
  /opt/iptv-hub/caddy-config \
  /opt/iptv-hub/logs/caddy
```

## Per-deploy workflow

```bash
# 0. (once) clone the repo to the VPS
git clone https://github.com/<owner>/iptv-hub /opt/iptv-hub-repo
cd /opt/iptv-hub-repo/deploy

# 1. configure
cp .env.example .env
$EDITOR .env                # set DEPLOY_DOMAIN, ACME_EMAIL, paths

# 2. deploy (idempotent — safe to re-run)
bash scripts/deploy.sh
```

`deploy.sh` runs in order: **preflight → generate-stack → docker compose pull
→ docker compose up -d → verify**. If any step fails, the prior healthy
containers keep running; there is no half-deploy state.

## Routing scheme

`.env` chooses one of:

- `ROUTING_SCHEME=subdomain` (default) — each app at
  `https://<id>.<DEPLOY_DOMAIN>/`. Cleanest; per-app cookies; one cert per app
  via ACME HTTP-01.
- `ROUTING_SCHEME=path` — each app at `https://<DEPLOY_DOMAIN>/<id>/`. Useful
  when you can't set up wildcard DNS. Requires the app itself to support
  path-prefix hosting (not all do).

## Adding a new app

1. Wait for the URL audit to mark the upstream `web_deployable: yes-*` in
   `inventory-status.json`. If the URL is dead, the kit refuses to add the
   app — fix the source URL in the schema first.
2. Create `deploy/apps/<id>/Dockerfile` — pinned base image, deterministic
   build, single `EXPOSE <internal-port>` line.
3. Create `deploy/apps/<id>/docker-compose.service.yml` — service entry that
   uses the app id verbatim as the service name. Bind to the policy port from
   [`ports.json`](./ports.json) — no other port is allowed.
4. Re-run `scripts/deploy.sh`.

There is **no** template-app-with-fake-content step; we don't ship apps whose
sources we haven't verified.

## Removing the stack

```bash
bash scripts/uninstall.sh --yes              # stop containers, keep volumes
bash scripts/uninstall.sh --purge --yes      # ALSO wipe certs and app data
```

`--purge` is destructive; the explicit `--yes` is required by design.

## Strict policy boundary

This deploy kit enforces the same CONTRACT.md rules as the launcher:

- **No fake URLs.** If `INVENTORY.md` doesn't mark an app deployable, the
  generator skips it. Caddy never proxies to a service that doesn't exist.
- **No port collisions.** `preflight.sh` aborts if any policy port is bound.
- **No public app endpoints.** Apps bind to loopback / docker bridge only;
  Caddy on 80/443 is the single ingress.
- **No half-state.** Failed deploys abort before changing the running set.
- **No silent secrets.** `.env` is `.gitignore`'d; nothing reads from outside it.
