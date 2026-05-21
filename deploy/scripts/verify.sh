#!/usr/bin/env bash
# IPTV Hub — verify every deployed service is actually serving traffic.
#
# For each service in the running compose stack:
#   1. Check container is up (docker inspect).
#   2. Hit the in-container healthcheck endpoint via Caddy (the public URL).
#   3. Record status into deploy/healthcheck/html/status.json so the dashboard
#      reflects current state.
#
# Exit 0 if every app passes. Exit 1 if any app fails (the caller decides
# whether to roll back).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

PORTS_JSON="$DEPLOY_DIR/ports.json"
INV_JSON="$DEPLOY_DIR/inventory-status.json"
STATUS_OUT="$DEPLOY_DIR/healthcheck/html/status.json"

[ -f .env ] || { echo "verify: .env missing" >&2; exit 1; }
set -a; . ./.env; set +a

command -v jq >/dev/null || { echo "verify: jq required" >&2; exit 1; }
command -v curl >/dev/null || { echo "verify: curl required" >&2; exit 1; }

# Determine deployable app ids the same way generate-stack.sh does.
if [ -f "$INV_JSON" ]; then
  DEPLOYABLE_IDS=$(
    jq -r '
      .apps
      | map(select(.web_deployable == "yes-pure-web" or .web_deployable == "yes-with-adaptation"))
      | map(.id) | .[]
    ' "$INV_JSON"
  )
else
  DEPLOYABLE_IDS=''
fi

results='[]'
failures=0
checked=0
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

while IFS= read -r app_id; do
  [ -z "$app_id" ] && continue
  checked=$((checked + 1))

  port=$(jq -r --arg id "$app_id" '.apps[] | select(.id == $id) | .http' "$PORTS_JSON")

  # Container running?
  container_state=$(docker inspect -f '{{.State.Status}}' "${COMPOSE_PROJECT_NAME:-iptv-hub}_${app_id}_1" 2>/dev/null \
    || docker inspect -f '{{.State.Status}}' "${COMPOSE_PROJECT_NAME:-iptv-hub}-${app_id}-1" 2>/dev/null \
    || echo 'absent')

  # Through-the-proxy HTTP check.
  url="https://${app_id}.${DEPLOY_DOMAIN}/"
  http_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --connect-timeout 5 "$url" || echo "000")

  ok='false'
  if [ "$container_state" = "running" ] && [ "$http_status" -ge 200 ] && [ "$http_status" -lt 500 ]; then
    ok='true'
  else
    failures=$((failures + 1))
  fi

  results=$(jq -c \
    --arg id "$app_id" \
    --arg port "$port" \
    --arg state "$container_state" \
    --arg url "$url" \
    --arg http "$http_status" \
    --arg ok "$ok" \
    '. + [{id:$id, port:($port|tonumber), container:$state, url:$url, http_status:($http|tonumber), healthy:($ok=="true")}]' \
    <<< "$results")

  printf '  %-22s container=%-8s http=%-3s ok=%s\n' "$app_id" "$container_state" "$http_status" "$ok"
done <<< "$DEPLOYABLE_IDS"

# Write the dashboard status file atomically.
tmp=$(mktemp)
jq -n \
  --arg t "$now" \
  --arg checked "$checked" \
  --arg failed "$failures" \
  --argjson results "$results" \
  '{generated_at:$t, checked:($checked|tonumber), failed:($failed|tonumber), results:$results}' \
  > "$tmp"
mv "$tmp" "$STATUS_OUT"

if [ "$failures" -gt 0 ]; then
  echo "verify: $failures/$checked apps failed" >&2
  exit 1
fi

echo "verify: $checked/$checked apps healthy"
exit 0
