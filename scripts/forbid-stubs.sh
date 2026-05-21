#!/usr/bin/env bash
# IPTV Hub — forbid-stubs tripwire.
#
# Scans runtime source files for stub markers, placeholder data, and empty error
# swallowers. CONTRACT.md §3.1 forbids these patterns; this script is the automated
# enforcement that runs in CI and as a pre-commit hook.
#
# A "marker hit" inside a comment block specifically tagged `// allow-stub: <reason>`
# is permitted; this is the time-bounded allowlist mechanism from CONTRACT.md §3.3.
#
# Exits with 0 if clean, 1 if any forbidden pattern is found, 2 if the script is
# invoked from outside the repo root.

set -uo pipefail

if [ ! -f Cargo.toml ] || [ ! -d src-tauri ]; then
  echo "forbid-stubs: must run from repo root (no Cargo.toml or src-tauri/)" >&2
  exit 2
fi

# Patterns that must not appear in runtime source. Order matters only for readability;
# every pattern is independently grepped.
PATTERNS=(
  'TODO: implement'
  'TODO:implement'
  'FIXME'
  'NOT_IMPLEMENTED'
  'unimplemented!'
  'todo!'
  '"stub"'
  '"placeholder"'
  '"sample data"'
  '"mock data"'
  '"fake data"'
  'coming soon'
  'will be added later'
)

# Paths we scan. Test files and the agent plan are excluded — they discuss these patterns
# without using them.
SOURCE_GLOBS=(
  'src-tauri/src'
  'frontend/src'
  'scripts'
)

EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=target
  --exclude-dir=dist
  --exclude='*.lock'
  --exclude='*.bak'
  --exclude='*.snap'
  --exclude='forbid-stubs.sh'
)

failures=0
for pattern in "${PATTERNS[@]}"; do
  # The literal `// allow-stub:` annotation exempts a single line — we strip those out
  # before grepping for the forbidden pattern.
  hits=$(
    grep -RIn "${EXCLUDES[@]}" -F -e "$pattern" "${SOURCE_GLOBS[@]}" 2>/dev/null \
      | grep -v 'allow-stub:' \
      || true
  )
  if [ -n "$hits" ]; then
    echo "forbid-stubs: pattern '$pattern' found:" >&2
    echo "$hits" >&2
    echo >&2
    failures=$((failures + 1))
  fi
done

# Empty catch / empty Err handling — Rust-specific. We grep for the literal idiom
# `Err(_) => {}` and `Ok(_) => {}` which silently discard errors.
empty_err=$(
  grep -RIn "${EXCLUDES[@]}" -E '^\s*(Err|Ok)\(_\)\s*=>\s*\{\s*\}\s*,?\s*$' src-tauri/src 2>/dev/null \
    | grep -v 'allow-stub:' \
    || true
)
if [ -n "$empty_err" ]; then
  echo "forbid-stubs: empty match arm (silent error swallow):" >&2
  echo "$empty_err" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "forbid-stubs: $failures forbidden pattern(s) found." >&2
  echo "fix by replacing the pattern with real code, OR mark the line with" >&2
  echo "  // allow-stub: <reason> (e.g. 'awaiting upstream API spec, expires 2026-04-01')" >&2
  exit 1
fi

echo "forbid-stubs: clean."
exit 0
