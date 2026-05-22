#!/usr/bin/env bash
# scripts/seed-apps.sh — heuristic seeder for `apps.json`.
#
# Wraps `iptv-hub-seed` (the CLI binary under `src-tauri/src/bin/`) so the
# operator can scan an "apps root" directory from the shell without firing
# up the Tauri UI. Prints the proposed manifest as JSON on stdout; the
# operator pipes that into `apps.json` after review.
#
# Usage:
#   bash scripts/seed-apps.sh <path>
#   bash scripts/seed-apps.sh <path> > apps-proposal.json
#
# The binary is built under `src-tauri/target/debug/` on first run; further
# invocations are fast (cargo incremental). For a release-quality run pass
# `IPTV_HUB_SEED_RELEASE=1` and the script builds with `--release` instead.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -lt 1 ]; then
  echo "usage: bash scripts/seed-apps.sh <path>" >&2
  echo "  scans <path> and prints the proposed manifest as JSON" >&2
  exit 1
fi

if [ "${IPTV_HUB_SEED_RELEASE:-}" = "1" ]; then
  cargo run --release --quiet --bin iptv-hub-seed -- "$@"
else
  cargo run --quiet --bin iptv-hub-seed -- "$@"
fi
