#!/usr/bin/env bash
# scripts/cloud-ufw-cloudflare.sh
#
# Lane: lane-cloud-pack. Implements doc 55 — the firewall lockdown that
# closes the spoofing/bypass hole at the network layer.
#
# Invocation:
#   ssh root@187.77.30.206 'bash -s' < scripts/cloud-ufw-cloudflare.sh
#
# Idempotent. Reads current Cloudflare CIDRs from /etc/iptv-hub/cloudflare-ips-v[46].txt
# (cloud-bootstrap.sh creates and refreshes these).
#
# Refuses to run if those files are missing — failing closed is the right
# default for a firewall script.

set -euo pipefail

log() { echo "[ufw] $*"; }

V4=/etc/iptv-hub/cloudflare-ips-v4.txt
V6=/etc/iptv-hub/cloudflare-ips-v6.txt

if [[ ! -s "$V4" || ! -s "$V6" ]]; then
    cat >&2 <<EOF
cloud-ufw-cloudflare: missing Cloudflare IP files.
  expected $V4 and $V6
  run cloud-bootstrap.sh first.
EOF
    exit 1
fi

# Operator SSH IP — pulled from /opt/iptv-hub/secrets/cloudflare.env.
OPERATOR_IP=""
if [[ -f /opt/iptv-hub/secrets/cloudflare.env ]]; then
    set -a; source /opt/iptv-hub/secrets/cloudflare.env; set +a
    OPERATOR_IP="${OPERATOR_SSH_IP:-}"
fi

if [[ -z "$OPERATOR_IP" ]]; then
    cat <<EOF

==========================================================================
WARNING: OPERATOR_SSH_IP is not set in /opt/iptv-hub/secrets/cloudflare.env

The script will allow SSH from ANY source. This is the safe default for
first-time bootstrap (we don't want to lock you out), but you should set
OPERATOR_SSH_IP=<your_home_IP> in cloudflare.env and re-run this script
once you confirm the origin lockdown is working.
==========================================================================

EOF
    OPERATOR_IP="any"
fi

# ── Baseline ───────────────────────────────────────────────────────────────

log "setting baseline policy"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed

# ── SSH ───────────────────────────────────────────────────────────────────

if [[ "$OPERATOR_IP" == "any" ]]; then
    ufw allow 22/tcp comment "ssh (any — TIGHTEN THIS)"
else
    ufw allow from "$OPERATOR_IP" to any port 22 proto tcp \
        comment "ssh (operator)"
fi

# ── Cloudflare 80/443 ─────────────────────────────────────────────────────

log "allowing 80,443 from $(wc -l < "$V4") IPv4 + $(wc -l < "$V6") IPv6 Cloudflare ranges"
while IFS= read -r cidr; do
    [[ -z "$cidr" || "$cidr" =~ ^# ]] && continue
    ufw allow proto tcp from "$cidr" to any port 80,443 \
        comment "cloudflare v4" >/dev/null
done < "$V4"

while IFS= read -r cidr; do
    [[ -z "$cidr" || "$cidr" =~ ^# ]] && continue
    ufw allow proto tcp from "$cidr" to any port 80,443 \
        comment "cloudflare v6" >/dev/null
done < "$V6"

# ── Docker bridges ────────────────────────────────────────────────────────

# Allow Docker's internal traffic. Docker manages its own iptables chains
# under DOCKER-USER; UFW shouldn't touch them. We just whitelist localhost
# so the host can reach published 127.0.0.1 ports.
ufw allow from 127.0.0.1 to 127.0.0.1 comment "docker host loopback" >/dev/null

# ── Enable + print ────────────────────────────────────────────────────────

ufw --force enable >/dev/null
log "ufw enabled. Current rules:"
ufw status numbered

cat <<EOF

cloud-ufw-cloudflare: done.

verify from the operator laptop:
  curl -sI https://opentv.daveai.tech | head -1     # expect: redirect to auth
  curl -sI --connect-timeout 5 https://187.77.30.206  # expect: timeout

if SSH on this VPS breaks, recover via the Hostinger panel's web console
(it bypasses UFW because it tunnels through the hypervisor).
EOF
