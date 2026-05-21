#!/usr/bin/env bash
# Fast pre-commit gate: format check, forbid-stubs, frontend lint check.
# Heavier checks (compile, clippy, test) run on pre-push and in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

echo '== forbid-stubs =='
bash scripts/forbid-stubs.sh

echo '== rust: fmt check =='
cargo fmt --all -- --check

if [ -d frontend/node_modules ]; then
  echo '== frontend: prettier check =='
  (cd frontend && npm run format:check)
  echo '== frontend: eslint =='
  (cd frontend && npm run lint)
else
  echo 'frontend/node_modules not present; skipping prettier/eslint (run `npm install` once).'
fi

echo
echo 'pre-commit: clean.'
