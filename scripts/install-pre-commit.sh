#!/usr/bin/env bash
# Install via: bash scripts/install-pre-commit.sh
# Sets up .git/hooks/pre-commit to run format check, lint, and forbid-stubs.
set -euo pipefail
cd "$(dirname "$0")/.."
hook=".git/hooks/pre-commit"
if [ ! -d ".git" ]; then
  echo "no .git directory found — run from inside a git checkout" >&2
  exit 1
fi
cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
# IPTV Hub pre-commit hook
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bash scripts/forbid-stubs.sh
cargo fmt --all -- --check
HOOK
chmod +x "$hook"
echo "installed $hook"
