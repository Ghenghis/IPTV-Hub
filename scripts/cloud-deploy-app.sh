#!/usr/bin/env bash
# scripts/cloud-deploy-app.sh
#
# Lane: lane-cloud-pack. Deploys ONE IPTV app to the VPS — the building block
# Agent 25's `cloud_deploy(app_id)` Tauri command wraps.
#
# Invocation (from operator laptop):
#   scripts/cloud-deploy-app.sh <app_id>
#
# Where <app_id> matches a directory under apps/ AND a site file under
# upstream/nginx/ matching the subdomain convention.
#
# Idempotent. If the app is already deployed, this re-syncs the compose
# file, pulls fresh image, recreates the container, reloads Nginx.

set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "usage: $0 <app_id>" >&2
    echo "       <app_id> is a directory under apps/ (e.g. open-tv, pitv)" >&2
    exit 2
fi

APP_ID="$1"
VPS="${IPTV_HUB_VPS:-root@187.77.30.206}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Locate the compose file and the matching site config ──────────────────

COMPOSE_FILE="$ROOT/apps/$APP_ID/docker-compose.yml"
if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "cloud-deploy-app: $COMPOSE_FILE not found" >&2
    exit 1
fi

# Subdomain inference: the Nginx site file names use a slugged variant
# of the app id. The mapping is the same one used by the seed script.
declare -A SUBDOMAIN_MAP=(
    [open-tv]=opentv
    [pitv]=pitv
    [iptvnator]=iptvnator
    [smart-iptv-web]=smartiptv
    [nuvioweb]=nuvio
    [react-iptv]=reactiptv
    [neptune-tv]=neptune
)

SUBDOMAIN="${SUBDOMAIN_MAP[$APP_ID]:-}"
if [[ -z "$SUBDOMAIN" ]]; then
    echo "cloud-deploy-app: no subdomain mapping for '$APP_ID'." >&2
    echo "  add it to SUBDOMAIN_MAP in $0, OR rename the apps/ directory." >&2
    exit 1
fi

SITE_FILE="$ROOT/upstream/nginx/$SUBDOMAIN.daveai.tech.conf.example"
if [[ ! -f "$SITE_FILE" ]]; then
    echo "cloud-deploy-app: $SITE_FILE not found" >&2
    exit 1
fi

echo "cloud-deploy-app: deploying $APP_ID → $SUBDOMAIN.daveai.tech"

# ── Push compose + site file ───────────────────────────────────────────────

ssh -o BatchMode=yes "$VPS" \
    "install -d -m 0755 /opt/iptv-hub/apps/$APP_ID \
                          /opt/iptv-hub/user-data/$APP_ID"

scp -q -o BatchMode=yes "$COMPOSE_FILE" \
    "$VPS:/opt/iptv-hub/apps/$APP_ID/docker-compose.yml"

scp -q -o BatchMode=yes "$SITE_FILE" \
    "$VPS:/etc/nginx/sites-available/$SUBDOMAIN.daveai.tech.conf"

# ── Bring it up ────────────────────────────────────────────────────────────

ssh -o BatchMode=yes "$VPS" bash <<REMOTE
set -euo pipefail
cd /opt/iptv-hub/apps/$APP_ID
docker compose pull
docker compose up -d --remove-orphans

# Wait for the container to be healthy (or up if no healthcheck).
deadline=\$((SECONDS + 60))
while (( SECONDS < deadline )); do
    state=\$(docker compose ps --format json | jq -r '.[0].Health // .[0].State')
    case "\$state" in
        healthy|running)  echo "container \$state"; break ;;
        unhealthy|exited) echo "container \$state — aborting"; exit 1 ;;
    esac
    sleep 2
done

# Enable the site (idempotent symlink).
ln -sfn /etc/nginx/sites-available/$SUBDOMAIN.daveai.tech.conf \
        /etc/nginx/sites-enabled/$SUBDOMAIN.daveai.tech.conf

nginx -t
nginx -s reload
echo "deploy: $SUBDOMAIN.daveai.tech ready"
REMOTE

# ── Smoke test from the operator laptop ───────────────────────────────────

echo "cloud-deploy-app: smoke testing https://$SUBDOMAIN.daveai.tech …"
code=$(curl -sIo /dev/null -w '%{http_code}' "https://$SUBDOMAIN.daveai.tech")
case "$code" in
    302|401)
        echo "  ✓ auth gate active (HTTP $code)"
        ;;
    200)
        echo "  ✗ HTTP 200 — auth gate is NOT active. Check that"
        echo "    upstream/nginx/$SUBDOMAIN.daveai.tech.conf.example contains"
        echo "    'include /etc/nginx/auth-gate.conf;' and that the include exists."
        exit 1
        ;;
    *)
        echo "  ? unexpected HTTP $code — check Nginx error log on the VPS"
        exit 1
        ;;
esac

echo "cloud-deploy-app: $APP_ID deployed."
