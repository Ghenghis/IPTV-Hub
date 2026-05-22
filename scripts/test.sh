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

echo '== frontend: e2e (playwright) =='
# Run the Playwright shell smoke if a browser has been installed locally.
# CI installs it via `npx playwright install --with-deps chromium`; locally
# the gate is skipped with a clear note so a clean clone doesn't fail here.
if (cd frontend && npx --no-install playwright --version >/dev/null 2>&1); then
  # Default browser cache paths: Linux ~/.cache/ms-playwright,
  # macOS ~/Library/Caches/ms-playwright, Windows %LOCALAPPDATA%/ms-playwright.
  # PLAYWRIGHT_BROWSERS_PATH overrides all three.
  browser_cache="${PLAYWRIGHT_BROWSERS_PATH:-}"
  if [ -z "${browser_cache}" ]; then
    case "$(uname -s)" in
      Linux*)   browser_cache="${HOME}/.cache/ms-playwright" ;;
      Darwin*)  browser_cache="${HOME}/Library/Caches/ms-playwright" ;;
      MINGW*|MSYS*|CYGWIN*) browser_cache="${LOCALAPPDATA:-${HOME}/AppData/Local}/ms-playwright" ;;
      *)        browser_cache="${HOME}/.cache/ms-playwright" ;;
    esac
  fi
  if [ -d "${browser_cache}" ] && ls "${browser_cache}"/chromium-* >/dev/null 2>&1; then
    (cd frontend && npm run test:e2e)
  else
    echo "playwright is installed but no chromium browser was found at ${browser_cache};"
    echo '  cd frontend && npx playwright install chromium'
    echo 'to enable the e2e gate. Skipping.'
  fi
else
  echo 'playwright not installed; run `cd frontend && npm install` then'
  echo '`npx playwright install chromium` to enable the e2e gate. Skipping.'
fi

echo
echo 'All gates passed.'
