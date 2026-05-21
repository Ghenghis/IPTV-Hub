#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo 'cargo fmt…'
cargo fmt --all
echo 'prettier…'
(cd frontend && npm run format)
echo 'Done.'
