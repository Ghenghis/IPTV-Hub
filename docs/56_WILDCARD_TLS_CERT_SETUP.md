# 56 · Wildcard TLS for `*.daveai.tech`

Lane: `lane-cloud-pack`. Issues a wildcard certificate used by every
subdomain in this lane and the next.

## Why wildcard over per-host

Per-host certs would require an HTTP-01 challenge for every new subdomain,
which means opening port 80 to Let's Encrypt validators _and_ rolling out a
new cert every time the family wants `<something>.daveai.tech`. A wildcard
cert is issued once for `*.daveai.tech`, every subdomain inherits it, and
renewal is fully automated via the Cloudflare DNS-01 challenge.

Domain Universal SSL at Cloudflare's edge handles the browser-facing cert.
This wildcard is the origin cert that satisfies Cloudflare's Full (Strict)
mode — see doc 52.

## Tool choice: `acme.sh`

`acme.sh` is the lightest cert client that supports the Cloudflare DNS-01
challenge out of the box. Certbot also works (`certbot-dns-cloudflare`) but
adds a Python dependency stack to the VPS that nothing else uses. We pick
`acme.sh`.

## Inputs

| Item | Source |
|---|---|
| Cloudflare API token | `daveai` token, scope `Zone:DNS:Edit` for `daveai.tech` |
| Token value | `/opt/iptv-hub/secrets/cloudflare.env` → `CF_DNS_API_TOKEN` |
| Account email | `fnice1971@gmail.com` (for Let's Encrypt expiry warnings) |

## Issuance

Runs once on the VPS, then again only when adding new SAN domains. Renewal
is automatic.

```bash
# Install acme.sh (one-time, idempotent).
curl https://get.acme.sh | sh -s email=fnice1971@gmail.com

# Source the token.
set -a; source /opt/iptv-hub/secrets/cloudflare.env; set +a
export CF_Token="${CF_DNS_API_TOKEN}"

# Issue. The DNS-01 challenge creates a temporary TXT record at
# _acme-challenge.daveai.tech via Cloudflare API, then deletes it.
~/.acme.sh/acme.sh --issue --dns dns_cf \
    -d 'daveai.tech' \
    -d '*.daveai.tech' \
    --server letsencrypt \
    --keylength ec-256

# Install the cert into the canonical path Nginx expects.
mkdir -p /etc/letsencrypt/live/daveai.tech-wildcard
~/.acme.sh/acme.sh --install-cert -d 'daveai.tech' --ecc \
    --cert-file       /etc/letsencrypt/live/daveai.tech-wildcard/cert.pem \
    --key-file        /etc/letsencrypt/live/daveai.tech-wildcard/privkey.pem \
    --fullchain-file  /etc/letsencrypt/live/daveai.tech-wildcard/fullchain.pem \
    --reloadcmd       'nginx -t && nginx -s reload'
```

Nginx site configs reference this fixed path:

```
ssl_certificate     /etc/letsencrypt/live/daveai.tech-wildcard/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/daveai.tech-wildcard/privkey.pem;
```

This is what every `upstream/nginx/*.daveai.tech.conf.example` in this lane
references.

## Renewal

`acme.sh` installs its own cron entry at install time that runs daily.
Renewals trigger ~30 days before expiry. The `--reloadcmd` above is invoked
after a successful renew, so Nginx picks up the new cert without operator
involvement.

Sanity check: `~/.acme.sh/acme.sh --list` shows the cert and its next
renewal date.

## Failure modes

- **Token revoked or missing perms.** `acme.sh` logs `Add txt record error`
  and aborts. Regenerate the token at Cloudflare with `Zone:DNS:Edit` on
  `daveai.tech`, re-run `--install-cert`.
- **Rate limit hit.** Let's Encrypt limits new orders per registered domain
  per week (50 at time of writing). Re-issuing too many times during
  troubleshooting can lock you out. The wildcard cert covers everything; you
  should only re-issue when adding a new apex domain.
- **DNS propagation slow.** `acme.sh` waits up to 120s for the TXT record to
  propagate. Cloudflare is usually <5s. If it consistently times out, add
  `--dns-sleep 60` to the issue command.

## What this lane does **not** do

- Does not configure browser-facing HSTS. Cloudflare handles HSTS at the
  edge; setting it again at the origin is redundant and can lock the family
  out if the cert ever fails. Revisit if Cloudflare is removed from the path.
- Does not configure OCSP stapling beyond `acme.sh` defaults.
- Does not cover `daveai.tech` apex SOA / NS — those are Cloudflare's
  responsibility.
