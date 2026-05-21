#!/usr/bin/env bash
# Installs git hooks via lefthook (CONTRACT §9, AGENT_PLAN Agent 21).
#
# Usage:
#   bash scripts/install-pre-commit.sh
#
# The lefthook config lives in lefthook.yml at the repo root. This script picks
# the locally-available lefthook binary in this order:
#   1. `lefthook` on PATH
#   2. `npx --no-install lefthook` if a previous `npm install` resolved it
#   3. `npx --yes lefthook@latest` as a last-resort one-shot fetch
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d ".git" ]; then
  echo "install-pre-commit: no .git directory — run from inside a git checkout" >&2
  exit 1
fi

if [ ! -f "lefthook.yml" ]; then
  echo "install-pre-commit: lefthook.yml missing at repo root" >&2
  exit 1
fi

if command -v lefthook >/dev/null 2>&1; then
  lefthook install
elif command -v npx >/dev/null 2>&1; then
  if npx --no-install lefthook install 2>/dev/null; then
    :
  else
    npx --yes lefthook@latest install
  fi
else
  echo "install-pre-commit: neither lefthook nor npx is on PATH" >&2
  echo "  install lefthook: https://github.com/evilmartians/lefthook" >&2
  exit 1
fi

echo "install-pre-commit: lefthook hooks installed (pre-commit, pre-push)."
