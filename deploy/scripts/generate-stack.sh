#!/usr/bin/env bash
# IPTV Hub — generates the runtime stack from policy + inventory.
#
# Inputs:
#   deploy/.env                                  — operator env (DEPLOY_DOMAIN, ROUTING_SCHEME, …)
#   deploy/ports.json                            — port allocation policy (binding)
#   deploy/inventory-status.json                 — which catalogue entries have real, web-deployable sources
#   deploy/nginx/iptv-hub-site.conf.template     — per-app nginx fragment template
#   deploy/apps/<id>/docker-compose.service.yml  — per-app service fragments (committed, one per real app)
#
# Outputs (gitignored, under deploy/build/):
#   deploy/build/nginx/iptv-hub-<id>.conf        — one rendered nginx fragment per deployable app
#   deploy/docker-compose.apps.yml               — merged per-app services
#
# Exits 0 on clean generation, 1 on any error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORTS_JSON="$DEPLOY_DIR/ports.json"
INVENTORY_JSON="$DEPLOY_DIR/inventory-status.json"
TEMPLATE="$DEPLOY_DIR/nginx/iptv-hub-site.conf.template"
ENV_FILE="$DEPLOY_DIR/.env"
OUT_NGINX_DIR="$DEPLOY_DIR/build/nginx"
OUT_APPS="$DEPLOY_DIR/docker-compose.apps.yml"

for f in "$PORTS_JSON" "$TEMPLATE"; do
  [ -f "$f" ] || { echo "generate-stack: missing $f" >&2; exit 1; }
done

[ -f "$ENV_FILE" ] || {
  echo "generate-stack: $ENV_FILE missing — copy .env.example and fill it in" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || { echo "generate-stack: 'jq' not on PATH" >&2; exit 1; }

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-}"
ROUTING_SCHEME="${ROUTING_SCHEME:-subdomain}"
CLIENT_MAX_MB="${CLIENT_MAX_MB:-64}"
VPS_INSTALL_ROOT="${VPS_INSTALL_ROOT:-/opt/iptv-hub}"

[ -n "$DEPLOY_DOMAIN" ] || {
  echo "generate-stack: DEPLOY_DOMAIN must be set in .env" >&2; exit 1
}

mkdir -p "$OUT_NGINX_DIR"
# Wipe stale fragments first so a removed app is also removed from the bundle.
rm -f "$OUT_NGINX_DIR"/iptv-hub-*.conf

# Deployable ids: web_deployable in {yes-pure-web, yes-with-adaptation}.
# `tr -d '\r'` strips Windows-style line endings that jq emits on win32 builds
# even when the source JSON is LF — without this, `read app_id` would keep the
# trailing CR and the subsequent `select(.id == $id)` against ports.json (LF)
# would never match.
if [ -f "$INVENTORY_JSON" ]; then
  DEPLOYABLE_IDS=$(
    jq -r '
      .apps
      | map(select(.web_deployable == "yes-pure-web" or .web_deployable == "yes-with-adaptation"))
      | map(.id) | .[]
    ' "$INVENTORY_JSON" | tr -d '\r'
  )
else
  echo "generate-stack: $INVENTORY_JSON not yet present — generating shell with no app blocks (run the URL audit first)" >&2
  DEPLOYABLE_IDS=''
fi

template_text=$(cat "$TEMPLATE")
FRAGMENT_PATHS=()
rendered_count=0

while IFS= read -r app_id; do
  [ -z "$app_id" ] && continue

  port=$(jq -r --arg id "$app_id" '.apps[] | select(.id == $id) | .http' "$PORTS_JSON" | tr -d '\r')
  if [ -z "$port" ] || [ "$port" = "null" ]; then
    echo "generate-stack: no port allocation for app id '$app_id'" >&2; exit 1
  fi

  if [ "$ROUTING_SCHEME" = "path" ]; then
    server_name="$DEPLOY_DOMAIN"
    routing_prefix="/$app_id"
  else
    server_name="${app_id}.${DEPLOY_DOMAIN}"
    routing_prefix=""
  fi

  access_log_path="${VPS_INSTALL_ROOT}/logs/nginx/${app_id}.access.log"

  # Substitute placeholders. APP_ID is also used so the file can self-identify.
  rendered="$template_text"
  rendered="${rendered//\$\{APP_ID\}/$app_id}"
  rendered="${rendered//\$\{APP_PORT\}/$port}"
  rendered="${rendered//\$\{SERVER_NAME\}/$server_name}"
  rendered="${rendered//\$\{ROUTING_PREFIX\}/$routing_prefix}"
  rendered="${rendered//\$\{CLIENT_MAX_MB\}/$CLIENT_MAX_MB}"
  rendered="${rendered//\$\{ACCESS_LOG_PATH\}/$access_log_path}"

  out_file="$OUT_NGINX_DIR/iptv-hub-${app_id}.conf"
  printf '%s' "$rendered" > "$out_file"
  rendered_count=$((rendered_count + 1))
  echo "generate-stack: wrote $out_file"

  # Per-app docker-compose service fragment — collected for the Python merger
  # below. Bash concatenation cannot handle fragments that declare top-level
  # keys other than `services:` (e.g. named `volumes:`), so we use a YAML-aware
  # merger instead.
  frag="$DEPLOY_DIR/apps/${app_id}/docker-compose.service.yml"
  if [ -f "$frag" ]; then
    FRAGMENT_PATHS+=("$frag")
  else
    echo "generate-stack: WARN no compose service fragment at $frag (nginx fragment will be in place but no container will start)" >&2
  fi
done <<< "$DEPLOYABLE_IDS"

# Pick a Python interpreter that has PyYAML. The same interpreter resolution
# logic is used by `deploy/scripts/deploy.py`.
PYTHON_BIN=""
for candidate in /c/Python313/python.exe /c/Python312/python.exe /c/Python311/python.exe python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
    PYTHON_BIN="$candidate"
    break
  fi
done
[ -n "$PYTHON_BIN" ] || {
  echo "generate-stack: no Python 3 interpreter found (needed for YAML merge)" >&2
  exit 1
}
"$PYTHON_BIN" -c "import yaml" 2>/dev/null || {
  echo "generate-stack: PyYAML not installed for $PYTHON_BIN — install with: $PYTHON_BIN -m pip install pyyaml" >&2
  exit 1
}

# Merge per-app fragments via the Python helper. It validates each fragment,
# fails on duplicate service/volume names, and emits a single valid compose.
if [ "${#FRAGMENT_PATHS[@]}" -eq 0 ]; then
  "$PYTHON_BIN" "$SCRIPT_DIR/_merge_compose_fragments.py" > "$OUT_APPS"
else
  "$PYTHON_BIN" "$SCRIPT_DIR/_merge_compose_fragments.py" "${FRAGMENT_PATHS[@]}" > "$OUT_APPS"
fi

echo "generate-stack: wrote $OUT_APPS"

echo "generate-stack: $rendered_count nginx fragment(s) written."
echo "generate-stack: done."
