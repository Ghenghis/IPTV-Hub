#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo 'cargo clippy -D warnings…'
cargo clippy --workspace --all-targets --locked -- -D warnings
echo 'eslint…'
(cd frontend && npm run lint)
echo 'forbid-stubs…'
bash scripts/forbid-stubs.sh
echo 'Done.'
