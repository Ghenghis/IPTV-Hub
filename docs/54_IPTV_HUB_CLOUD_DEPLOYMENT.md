# 54 · IPTV Hub cloud deployment runbook

Lane: `lane-cloud-pack`. Requires `52_CLOUDFLARE_REAL_IP_AND_SSL.md` and
`53_AUTHENTIK_INVITATION_FLOW.md` to be applied first.

This is the operator runbook for bringing the family IPTV stack online on
`srv1376124.hstgr.cloud` (Hostinger KVM 4, `187.77.30.206`). Every step is
idempotent — re-running is safe and is the recommended recovery path.

## What ships in this lane

| Component | Where | Purpose |
|---|---|---|
| Wildcard TLS cert | `/etc/letsencrypt/live/daveai.tech-wildcard/` | `*.daveai.tech` via Cloudflare DNS-01 |
| Nginx site configs | `upstream/nginx/*.daveai.tech.conf.example` | One per subdomain, copied to `/etc/nginx/sites-available/` |
| `auth-gate` include | `upstream/nginx/auth-gate.conf.example` | Reusable Authentik `auth_request` snippet |
| `cloudflare-real-ip` include | shipped in lane `lane-a-provider-registry` (doc 52) | Real visitor IPs |
| Authentik stack | `authentik/docker-compose.yml` | Auth gateway, postgres, redis, worker |
| App containers | `apps/<id>/docker-compose.yml` | One per IPTV app, bound to `127.0.0.1:<port>` |
| Secrets sync | `scripts/sync-secrets.sh` | `scp` from operator laptop → `/opt/iptv-hub/secrets/` |
| Bootstrap | `scripts/cloud-bootstrap.sh` | First-time VPS prep |
| UFW lockdown | `scripts/cloud-ufw-cloudflare.sh` (see doc 55) | Origin reachable only from Cloudflare |

## Filesystem layout on the VPS

Everything the cloud pack owns lives under `/opt/iptv-hub/`. Anything outside
that path is either OS (Ubuntu base) or operator-provided (the wildcard cert
under `/etc/letsencrypt/`, the Nginx site files under `/etc/nginx/`).

```
/opt/iptv-hub/
├── authentik/
│   ├── docker-compose.yml
│   └── data/                       # postgres + media, persisted
├── apps/
│   ├── open-tv/
│   │   └── docker-compose.yml
│   ├── pitv/
│   │   └── docker-compose.yml
│   └── …
├── user-data/                      # per-app persistent data, never wiped
│   ├── open-tv/
│   └── …
├── secrets/                        # mode 0600, owner root
│   ├── authentik.env
│   ├── cloudflare.env
│   └── smtp.env
└── logs/
    └── deploy.log                  # cloud-bootstrap.sh appends here
```

No app container ever publishes a port to `0.0.0.0`. Every app binds to
`127.0.0.1:<n>` and Nginx upstreams to it. The only sockets reachable from
outside the VPS are 80, 443, and 22 — and 80/443 are firewalled to Cloudflare
ranges only (see doc 55).

## Secrets layout

The operator (Dave) keeps secrets on the laptop under `~/.iptv-hub-secrets/`.
The directory tree mirrors `/opt/iptv-hub/secrets/` exactly. Files:

| File | Keys |
|---|---|
| `authentik.env` | `AUTHENTIK_SECRET_KEY`, `AUTHENTIK_PG_PASS`, `AUTHENTIK_BOOTSTRAP_TOKEN` |
| `cloudflare.env` | `CF_DNS_API_TOKEN` (the `daveai` token), `CF_ACCOUNT_ID` |
| `smtp.env` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_APP_PASSWORD`, `SMTP_FROM` |

These files are never committed to git. The `.gitignore` blocks
`*.env`, `secrets/`, and `~/.iptv-hub-secrets/` defensively, but the primary
defence is that `scripts/sync-secrets.sh` is the only authorised path
on→off the operator laptop, and it uses `scp` over SSH — git never touches them.

## Bootstrap (first time on a new VPS)

Run from the operator laptop, not on the VPS:

```bash
# 1. Confirm DNS + SSL preconditions (Cloudflare wildcard A + Full Strict).
#    See doc 52 if either is not in place.

# 2. Sync the secrets onto the VPS.
bash scripts/sync-secrets.sh

# 3. Bootstrap the VPS (Docker, UFW, directories, wildcard cert).
ssh root@187.77.30.206 'bash -s' < scripts/cloud-bootstrap.sh

# 4. Lock down origin to Cloudflare IPs.
ssh root@187.77.30.206 'bash -s' < scripts/cloud-ufw-cloudflare.sh

# 5. Bring up Authentik and seed the ten family admins.
scp -r authentik root@187.77.30.206:/opt/iptv-hub/
ssh root@187.77.30.206 'cd /opt/iptv-hub/authentik && docker compose up -d'
ssh root@187.77.30.206 'cd /opt/iptv-hub/authentik && \
    docker compose exec -T authentik-server python3 - < scripts/seed-family-users.py'

# 6. Roll out the apps you want online. open-tv first as the smoke test.
scp -r apps/open-tv root@187.77.30.206:/opt/iptv-hub/apps/
ssh root@187.77.30.206 'cd /opt/iptv-hub/apps/open-tv && docker compose up -d'

# 7. Install the Nginx sites for each app + reload.
scp upstream/nginx/auth-gate.conf.example \
    upstream/nginx/auth.daveai.tech.conf.example \
    upstream/nginx/opentv.daveai.tech.conf.example \
    root@187.77.30.206:/etc/nginx/sites-available/
ssh root@187.77.30.206 'cd /etc/nginx/sites-available && \
    for f in auth.daveai.tech opentv.daveai.tech; do \
      ln -sf /etc/nginx/sites-available/$f.conf.example /etc/nginx/sites-enabled/$f.conf; \
    done && nginx -t && nginx -s reload'

# 8. Smoke test from the operator laptop.
curl -I https://opentv.daveai.tech
# Expect: HTTP/2 302, location: https://auth.daveai.tech/if/flow/...
```

If step 8 returns 200 directly, the auth gate is not wired — re-check the
`include /etc/nginx/auth-gate.conf;` line in the site config.

## Per-app deploy (after bootstrap)

Every IPTV app follows the same pattern. To add `pitv` to the family stack:

```bash
# 1. Push the app's compose + the matching Nginx site.
scp -r apps/pitv root@187.77.30.206:/opt/iptv-hub/apps/
scp upstream/nginx/pitv.daveai.tech.conf.example \
    root@187.77.30.206:/etc/nginx/sites-available/

# 2. Start the app container.
ssh root@187.77.30.206 'cd /opt/iptv-hub/apps/pitv && docker compose up -d'

# 3. Enable the Nginx site and reload.
ssh root@187.77.30.206 'ln -sf /etc/nginx/sites-available/pitv.daveai.tech.conf.example \
    /etc/nginx/sites-enabled/pitv.daveai.tech.conf && \
    nginx -t && nginx -s reload'

# 4. Verify.
curl -I https://pitv.daveai.tech
```

The IPTV Hub launcher's `cloud_deploy(app_id)` command (Agent 25 slice)
automates exactly these three steps via SSH.

## Update workflow

App updates respect the same contract the local IPTV Hub does — snapshot
first, then apply, then smoke test, then commit. For cloud apps the snapshot
is a `docker commit` of the current container + a `tar.zst` of the user-data
volume; rollback is a `docker run` of the snapshot tag + restoring the
volume tarball.

The mechanics live in the Rust core (`src-tauri/src/cloud/`); this doc just
states the invariant.

## Recovery scenarios

**Authentik unreachable, family locked out.** SSH into the VPS, exec into
`authentik-server`, run `ak create_token --identifier root` to mint a
recovery token, then visit the admin UI with that token.

**Wildcard cert expired or revoked.** Re-run `acme.sh --issue` with the
DNS-01 challenge. Doc 56 has the exact command. The site configs reference
the cert by path; no Nginx restart is required for renewal, only for
revocation+reissue.

**One app misbehaving, taking down the whole reload.** `nginx -t` fails
fast on a bad site config. If it passes but a backend container is dead,
the affected subdomain returns 502 — other subdomains are unaffected.
`docker compose -f apps/<id>/docker-compose.yml restart` to recover.

**Cloudflare IP ranges changed.** `scripts/update-cloudflare-ips.sh` rewrites
both the `cloudflare-real-ip.conf` include and the UFW rules. It is wired
into a weekly systemd timer; manual runs are safe.

**Full VPS rebuild.** Run the bootstrap section again on a fresh VPS. The
secrets sync brings the cert state forward; user data is restored from the
most recent `tar.zst` in `/opt/iptv-hub/cache/rollback/`.

## What this lane does **not** do

- It does not move the desktop Tauri launcher to the cloud. The Tauri app
  remains the operator's control surface; the VPS is where the family-facing
  apps live.
- It does not federate user data between the local app and the cloud app.
  `iptvnator` running on the Tauri host and `iptvnator` running on the VPS
  are two independent installs with two independent playlists. Federation is
  out of scope and can land in a later lane.
- It does not implement a billing/quota system. The family stack assumes
  trusted users; rate-limiting beyond what Cloudflare does at the edge is
  not part of this lane.
