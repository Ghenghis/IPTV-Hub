#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "IPTV Hub — dev mode"
if [ ! -d frontend/node_modules ]; then
  echo "installing frontend deps…"
  (cd frontend && npm ci)
fi
exec cargo tauri dev
