#!/usr/bin/env bash
# IPTV Hub — VPS-side port preflight.
#
# Reads deploy/ports.json (must be available next to this script's project root)
# and verifies that every port the stack will bind is currently free on 127.0.0.1.
#
# Exits 0 if clean, 1 if any port is already in use, 2 on script-internal errors.
#
# Designed to run as the deploy user over SSH:
#   ssh <vps> "cd /opt/iptv-hub && bash deploy/scripts/preflight.sh"

set -euo pipefail

# Locate the repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORTS_JSON="$REPO_ROOT/deploy/ports.json"

if [ ! -f "$PORTS_JSON" ]; then
  echo "preflight: missing $PORTS_JSON" >&2
  exit 2
fi

# jq is the only hard dep. ss is part of iproute2 (default on every modern Linux).
for bin in jq ss; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "preflight: required binary '$bin' not on PATH" >&2
    exit 2
  fi
done

# Collect every port we plan to bind: reverse_proxy + infra + per-app http/ws/metrics.
PORTS=$(
  jq -r '
    [
      .reverse_proxy.http,
      .reverse_proxy.https,
      .reverse_proxy.admin_api,
      (.infra | to_entries[] | .value),
      (.apps[] | select(.web_deployable != false) | (.http, .ws, .metrics))
    ]
    | map(select(. != null and . != 0))
    | unique
    | .[]
  ' "$PORTS_JSON"
)

if [ -z "$PORTS" ]; then
  echo "preflight: ports.json produced an empty port set" >&2
  exit 2
fi

# Pull the listen table once; faster than calling ss per-port.
LISTEN=$(ss -ltnH 2>/dev/null || true)
if [ -z "$LISTEN" ]; then
  # ss returned nothing — either no listeners (clean) or ss failed.
  # Re-run with diagnostics on stderr; if it actually failed, abort.
  if ! ss -ltn >/dev/null 2>&1; then
    echo "preflight: 'ss -ltn' failed; cannot determine listener state" >&2
    exit 2
  fi
fi

failures=0
checked=0
echo "preflight: checking $(echo "$PORTS" | wc -l | tr -d ' ') ports against listener table"

# For each port, grep the ss output for ":<port> " in the local-address column.
# Awk pulls column 4 ("Local Address:Port") and splits on the last colon.
for port in $PORTS; do
  checked=$((checked + 1))
  hit=$(printf '%s\n' "$LISTEN" | awk -v p=":$port$" '
    { n = split($4, parts, ":"); if (parts[n] == ENVIRON["AWK_PORT"]) print }
  ' AWK_PORT="$port" || true)
  if [ -n "$hit" ]; then
    echo "preflight: PORT $port IS IN USE" >&2
    echo "  $hit" >&2
    failures=$((failures + 1))
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "preflight: $failures port(s) in use — cannot deploy until they are freed" >&2
  exit 1
fi

echo "preflight: $checked ports clean."
exit 0
