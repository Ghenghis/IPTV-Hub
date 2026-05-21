# iptv-hub-cloud-pack

Lane: `lane-cloud-pack`. Extends the existing iptv-hub repo with the
infrastructure that puts the family IPTV apps behind `*.daveai.tech` on the
Hostinger VPS, gated by Authentik with family-only access.

## What this lane adds

```
docs/53_AUTHENTIK_INVITATION_FLOW.md          → family-only auth design
docs/54_IPTV_HUB_CLOUD_DEPLOYMENT.md          → end-to-end runbook
docs/55_UFW_CLOUDFLARE_ORIGIN_LOCKDOWN.md     → firewall lockdown
docs/56_WILDCARD_TLS_CERT_SETUP.md            → *.daveai.tech ACME DNS-01
docs/57_SAMSUNG_TV_DEVICE_CODE_FLOW.md        → TV login UX

upstream/nginx/auth-gate.conf.example         → reusable Authentik auth_request
upstream/nginx/iptv-app-proxy.conf.example    → reusable proxy headers block
upstream/nginx/auth.daveai.tech.conf.example  → Authentik public site
upstream/nginx/opentv.daveai.tech.conf.example
upstream/nginx/iptvnator.daveai.tech.conf.example
upstream/nginx/pitv.daveai.tech.conf.example
upstream/nginx/smartiptv.daveai.tech.conf.example
upstream/nginx/nuvio.daveai.tech.conf.example
upstream/nginx/reactiptv.daveai.tech.conf.example
upstream/nginx/neptune.daveai.tech.conf.example

authentik/docker-compose.yml                  → server + worker + pg + redis
authentik/authentik.env.example               → secrets schema (real file is git-ignored)
authentik/scripts/seed-family-users.py        → real Python seed, idempotent

apps/open-tv/docker-compose.yml
apps/iptvnator/docker-compose.yml
apps/pitv/docker-compose.yml
apps/smart-iptv-web/docker-compose.yml
apps/nuvioweb/docker-compose.yml
apps/react-iptv/docker-compose.yml
apps/neptune-tv/docker-compose.yml

scripts/sync-secrets.sh                       → operator laptop → VPS, never git
scripts/cloud-bootstrap.sh                    → first-time VPS prep
scripts/cloud-ufw-cloudflare.sh               → firewall lockdown
scripts/cloud-deploy-app.sh                   → per-app deploy

.gitignore.cloud-pack                         → defense-in-depth for secrets
```

## Merging this lane

This pack is structured to drop straight onto your existing repo without
overwriting anything. Numbered docs continue from `52_CLOUDFLARE_REAL_IP_AND_SSL.md`
(shipped in `lane-a-provider-registry`); both Nginx include conventions —
`cloudflare-real-ip.conf.example` from lane-a and `auth-gate.conf.example`
from this lane — coexist.

```bash
# from the iptv-hub repo root
git checkout -b lane-cloud-pack origin/main
rsync -a /path/to/iptv-hub-cloud-pack/ ./

# verify the contract still holds
bash scripts/forbid-stubs.sh
git status
git add docs/53_*.md docs/54_*.md docs/55_*.md docs/56_*.md docs/57_*.md \
        upstream/nginx/auth-gate.conf.example \
        upstream/nginx/iptv-app-proxy.conf.example \
        upstream/nginx/auth.daveai.tech.conf.example \
        upstream/nginx/opentv.daveai.tech.conf.example \
        upstream/nginx/iptvnator.daveai.tech.conf.example \
        upstream/nginx/pitv.daveai.tech.conf.example \
        upstream/nginx/smartiptv.daveai.tech.conf.example \
        upstream/nginx/nuvio.daveai.tech.conf.example \
        upstream/nginx/reactiptv.daveai.tech.conf.example \
        upstream/nginx/neptune.daveai.tech.conf.example \
        authentik/ apps/ scripts/

git commit -m "lane-cloud-pack: cloud deployment for family IPTV stack

- Authentik invitation flow with family-admins / family-members groups
- Wildcard TLS via acme.sh + Cloudflare DNS-01
- UFW lockdown so origin is reachable only from Cloudflare IPs
- Samsung TV device-code login (doc 57)
- Per-app Nginx site + Docker compose for 7 IPTV apps
- sync-secrets.sh solves the git-ignored .env deploy blocker"
```

## What is intentionally NOT in this lane

- **Tauri command surface** for `cloud_deploy(app_id)` etc. That lives in
  `src-tauri/src/cloud/` and is owned by Agent 25's slice; this lane provides
  the shell scripts those commands wrap.
- **App image builds.** Compose files reference GHCR images. If the image
  doesn't exist yet for a given app, Agent 25's deploy command builds from
  the manifest's git source and pushes to GHCR before calling
  `cloud-deploy-app.sh`.
- **Federation between local + cloud installs.** Running `iptvnator` locally
  and on the VPS gives two independent stores. A future lane could sync them
  via a CRDT or a periodic export.
- **Public sign-up.** Deliberately. Doc 53 § "Trust model" is the contract.

## Contract compliance

`forbid-stubs.sh` (from the base repo) passes against this lane. No
`TODO: implement`, no `unimplemented!`, no `"mock data"`, no empty
`Err(_) => {}` arms, no `coming soon`. Every script and config compiles,
parses, and is deployable as-is.
