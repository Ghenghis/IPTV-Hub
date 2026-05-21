#!/usr/bin/env bash
# Full test gate. Mirrors .github/workflows/ci.yml exactly.
set -euo pipefail
cd "$(dirname "$0")/.."

echo '== forbid-stubs =='
bash scripts/forbid-stubs.sh

echo '== rust: fmt check =='
cargo fmt --all -- --check

echo '== rust: clippy (warnings as errors) =='
cargo clippy --workspace --all-targets --locked -- -D warnings

echo '== rust: build =='
cargo build --workspace --locked

echo '== rust: test =='
cargo test --workspace --locked

echo '== frontend: install =='
(cd frontend && npm ci)

echo '== frontend: tsc =='
(cd frontend && npm run build)

echo '== frontend: prettier =='
(cd frontend && npm run format:check)

echo
echo 'All gates passed.'
