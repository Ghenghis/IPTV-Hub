#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo 'Building release…'
(cd frontend && npm ci && npm run build)
cargo tauri build
echo 'Done. Artifacts under src-tauri/target/release/bundle/'
