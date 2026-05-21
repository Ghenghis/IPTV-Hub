#!/usr/bin/env bash
# scripts/cloud-bootstrap.sh
#
# Lane: lane-cloud-pack. Idempotent first-time VPS prep.
#
# Invocation (from operator laptop):
#   ssh root@187.77.30.206 'bash -s' < scripts/cloud-bootstrap.sh
#
# What it does:
#   1. Updates apt and installs nginx, ufw, jq, curl, ca-certificates, acme.sh deps
#   2. Confirms Docker is present (Hostinger's "Ubuntu 24.04 with Docker" template
#      ships it; otherwise installs the official Docker repo)
#   3. Creates the /opt/iptv-hub/ directory tree
#   4. Creates the internal Docker network the auth + apps share
#   5. Generates the wildcard cert for *.daveai.tech via acme.sh + Cloudflare DNS-01
#   6. Configures Nginx with the cloud pack's includes
#   7. Sets up a weekly systemd timer to refresh Cloudflare IPs
#
# Re-running is safe; every step is guarded.

set -euo pipefail

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# ── 1. apt ─────────────────────────────────────────────────────────────────

log "updating apt and installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    nginx ufw jq curl ca-certificates \
    git socat openssl uuid-runtime \
    >/dev/null

# ── 2. Docker ──────────────────────────────────────────────────────────────

if ! command -v docker >/dev/null 2>&1; then
    log "Docker not present — installing"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
    systemctl enable --now docker
fi

# ── 3. Filesystem ──────────────────────────────────────────────────────────

log "creating /opt/iptv-hub tree"
install -d -m 0755 -o root -g root \
    /opt/iptv-hub \
    /opt/iptv-hub/authentik \
    /opt/iptv-hub/authentik/data \
    /opt/iptv-hub/apps \
    /opt/iptv-hub/user-data \
    /opt/iptv-hub/cache \
    /opt/iptv-hub/cache/rollback \
    /opt/iptv-hub/logs

install -d -m 0700 -o root -g root /opt/iptv-hub/secrets
install -d -m 0755 -o root -g root /etc/iptv-hub

# ── 4. Docker network ──────────────────────────────────────────────────────

if ! docker network inspect iptv-hub-internal >/dev/null 2>&1; then
    log "creating Docker network iptv-hub-internal"
    docker network create --driver bridge iptv-hub-internal >/dev/null
else
    log "Docker network iptv-hub-internal already exists"
fi

# ── 5. acme.sh + wildcard cert ─────────────────────────────────────────────

if [[ ! -d /root/.acme.sh ]]; then
    log "installing acme.sh"
    curl -fsSL https://get.acme.sh | sh -s email=fnice1971@gmail.com >/dev/null
fi

# Read the Cloudflare token if synced.
if [[ -f /opt/iptv-hub/secrets/cloudflare.env ]]; then
    set -a; source /opt/iptv-hub/secrets/cloudflare.env; set +a
    export CF_Token="${CF_DNS_API_TOKEN}"
else
    log "WARNING: /opt/iptv-hub/secrets/cloudflare.env not found — skipping cert issuance"
    log "         run scripts/sync-secrets.sh from the operator laptop, then re-run this script"
fi

CERT_DIR=/etc/letsencrypt/live/daveai.tech-wildcard
if [[ -n "${CF_Token:-}" && ! -s "$CERT_DIR/fullchain.pem" ]]; then
    log "issuing *.daveai.tech wildcard cert (DNS-01)"
    install -d -m 0755 "$CERT_DIR"
    /root/.acme.sh/acme.sh --issue --dns dns_cf \
        -d 'daveai.tech' \
        -d '*.daveai.tech' \
        --server letsencrypt \
        --keylength ec-256 \
        --force
    /root/.acme.sh/acme.sh --install-cert -d 'daveai.tech' --ecc \
        --cert-file       "$CERT_DIR/cert.pem" \
        --key-file        "$CERT_DIR/privkey.pem" \
        --fullchain-file  "$CERT_DIR/fullchain.pem" \
        --reloadcmd       'nginx -t && nginx -s reload'
elif [[ -s "$CERT_DIR/fullchain.pem" ]]; then
    log "wildcard cert already present at $CERT_DIR — skipping issuance"
fi

# ── 6. Nginx baseline ──────────────────────────────────────────────────────

log "configuring Nginx baseline"

# Ensure the cloud pack's includes live at the canonical paths the site
# configs reference. The actual file contents are part of this lane and
# should already have been scp'd in by the operator before running this
# bootstrap. We only create stubs if they're entirely missing.
for include_file in cloudflare-real-ip.conf auth-gate.conf iptv-app-proxy.conf; do
    if [[ ! -s "/etc/nginx/$include_file" ]]; then
        log "  /etc/nginx/$include_file missing — operator must scp from upstream/nginx/${include_file}.example"
    fi
done

# Pull current Cloudflare IPs and write the trusted-ranges file the include
# references. update-cloudflare-ips.sh keeps this fresh on a weekly timer.
log "fetching current Cloudflare IP ranges"
curl -fsSL https://www.cloudflare.com/ips-v4 > /etc/iptv-hub/cloudflare-ips-v4.txt
curl -fsSL https://www.cloudflare.com/ips-v6 > /etc/iptv-hub/cloudflare-ips-v6.txt
log "  $(wc -l < /etc/iptv-hub/cloudflare-ips-v4.txt) IPv4 ranges, $(wc -l < /etc/iptv-hub/cloudflare-ips-v6.txt) IPv6 ranges"

# ── 7. Weekly Cloudflare IP refresh timer ──────────────────────────────────

cat > /etc/systemd/system/iptv-hub-cloudflare-ips.service <<'UNIT'
[Unit]
Description=Refresh Cloudflare IP ranges for IPTV Hub nginx + ufw
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/iptv-hub-update-cloudflare-ips
UNIT

cat > /etc/systemd/system/iptv-hub-cloudflare-ips.timer <<'UNIT'
[Unit]
Description=Refresh Cloudflare IPs weekly

[Timer]
OnCalendar=Sun 03:17
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Install the update script
install -d -m 0755 /usr/local/sbin
cat > /usr/local/sbin/iptv-hub-update-cloudflare-ips <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
curl -fsSL https://www.cloudflare.com/ips-v4 > /etc/iptv-hub/cloudflare-ips-v4.txt.new
curl -fsSL https://www.cloudflare.com/ips-v6 > /etc/iptv-hub/cloudflare-ips-v6.txt.new
mv -f /etc/iptv-hub/cloudflare-ips-v4.txt.new /etc/iptv-hub/cloudflare-ips-v4.txt
mv -f /etc/iptv-hub/cloudflare-ips-v6.txt.new /etc/iptv-hub/cloudflare-ips-v6.txt
nginx -t && nginx -s reload
SCRIPT
chmod +x /usr/local/sbin/iptv-hub-update-cloudflare-ips

systemctl daemon-reload
systemctl enable --now iptv-hub-cloudflare-ips.timer >/dev/null

log "bootstrap complete."
log "next steps:"
log "  1. scp upstream/nginx/*.example onto this VPS into /etc/nginx/"
log "  2. ln -sf the *.daveai.tech.conf.example files into /etc/nginx/sites-enabled/"
log "  3. cd /opt/iptv-hub/authentik && docker compose up -d"
log "  4. python3 - < authentik/scripts/seed-family-users.py"
log "  5. cd /opt/iptv-hub/apps/<id> && docker compose up -d (per app)"
log "  6. nginx -t && nginx -s reload"
