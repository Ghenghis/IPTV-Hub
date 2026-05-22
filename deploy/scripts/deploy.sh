#!/usr/bin/env bash
# IPTV Hub — operator-side deploy entrypoint.
#
# Thin wrapper around scripts/deploy.py (Paramiko). The Python script does the
# real work: regenerates artifacts, SCPs them, runs nginx -t + systemctl reload,
# brings the compose stack up, verifies. This wrapper just locates the right
# Python interpreter and forwards the call.
#
# Credentials live in $IPTV_HUB_VPS_ENV_PATH (default: G:\private\.env.deploy
# on Windows). They are never echoed by this script or the Python child.

set -euo pipefail
cd "$(dirname "$0")/.."

# Locate Python — Windows installs typically aren't on the bash PATH, but the
# project memory pins the canonical interpreter.
PYTHON_BIN=""
for candidate in /c/Python313/python.exe /c/Python312/python.exe /c/Python311/python.exe /usr/bin/python3 python3; do
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
    PYTHON_BIN="$candidate"
    break
  fi
done

[ -n "$PYTHON_BIN" ] || {
  echo "deploy: no Python 3 interpreter found" >&2
  echo "  install Python 3.11+ and ensure paramiko is available, OR set IPTV_HUB_PYTHON env var" >&2
  exit 2
}

# Sanity-check paramiko is importable.
"$PYTHON_BIN" -c "import paramiko" 2>/dev/null || {
  echo "deploy: paramiko not installed for $PYTHON_BIN" >&2
  echo "  install with: $PYTHON_BIN -m pip install paramiko" >&2
  exit 2
}

exec "$PYTHON_BIN" scripts/deploy.py
