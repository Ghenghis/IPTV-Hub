#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# One-time install of cargo-tauri-cli on a fresh machine. Idempotent — the
# `cargo tauri --version` probe short-circuits when the binary is already on
# PATH. Pinned to ^2.0 to track the Tauri 2 ABI declared in Cargo.toml.
if ! cargo tauri --version >/dev/null 2>&1; then
  echo 'installing cargo-tauri-cli (one-time)…'
  cargo install tauri-cli --locked --version '^2.0'
fi

echo 'Building release…'
(cd frontend && npm ci && npm run build)
cargo tauri build
echo 'Done. Artifacts under src-tauri/target/release/bundle/'
