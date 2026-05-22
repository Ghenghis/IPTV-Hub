#!/usr/bin/env bash
# IPTV Hub — forbid-stubs tripwire.
#
# Scans runtime source files for stub markers, placeholder data, and empty error
# swallowers. CONTRACT.md §2.1 forbids these patterns; this script is the automated
# enforcement that runs in CI and as a pre-commit hook.
#
# A line containing the literal annotation `allow-stub: <reason>` is permitted — this
# is the time-bounded allowlist mechanism from CONTRACT.md §2.4. Reasons should include
# a tracked issue and an expiry date.
#
# Exits with 0 if clean, 1 if any forbidden pattern is found, 2 if the script is
# invoked from outside the repo root.

set -uo pipefail

if [ ! -f Cargo.toml ] || [ ! -d src-tauri ]; then
  echo "forbid-stubs: must run from repo root (no Cargo.toml or src-tauri/)" >&2
  exit 2
fi

# Bare-token patterns. Each is matched as a whole word so that ordinary words like
# "stubby" or "mockingbird" do not trip the gate. Comments and strings are not
# distinguished — runtime files should never contain the literal token in any form.
WORD_PATTERNS=(
  'TODO'
  'FIXME'
  'XXX'
  'HACK'
  'NOT_IMPLEMENTED'
  'NotImplementedException'
  'stub'
  'Stub'
  'STUB'
  'placeholder'
  'Placeholder'
  'PLACEHOLDER'
  'mock'
  'Mock'
  'MOCK'
)

# Substring patterns. These must match literally with spaces, punctuation, or the
# Rust-macro `!()` syntax exactly as written.
SUBSTRING_PATTERNS=(
  'unimplemented!('
  'todo!('
  'not implemented'
  'coming soon'
  'experimental — disabled'
  'experimental -- disabled'
  'will be added later'
  'sample data'
  'fake data'
  'mock data'
)

# Paths we scan. Tests, fixtures, and the agent plan are excluded — they discuss the
# patterns without using them.
SOURCE_GLOBS=(
  'src-tauri/src'
  'frontend/src'
  'scripts'
)

EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=target
  --exclude-dir=dist
  --exclude-dir=tests
  --exclude-dir=fixtures
  --exclude='*.lock'
  --exclude='*.bak'
  --exclude='*.snap'
  --exclude='forbid-stubs.sh'
  --exclude='forbid-stubs.ps1'
)

failures=0

# Word-bounded matches.
# HTML/JSX attribute use of `placeholder` (e.g. <input placeholder="…">) is a web spec
# word, not a stub marker, and is permitted. CSS pseudo-class `:placeholder-shown` and
# `::placeholder` are also exempt.
for pattern in "${WORD_PATTERNS[@]}"; do
  hits=$(
    grep -RIn "${EXCLUDES[@]}" -w -e "$pattern" "${SOURCE_GLOBS[@]}" 2>/dev/null \
      | grep -v 'allow-stub:' \
      | grep -Ev 'placeholder\s*[=:"]' \
      | grep -Ev '::placeholder|:placeholder-shown' \
      || true
  )
  if [ -n "$hits" ]; then
    echo "forbid-stubs: word '$pattern' found:" >&2
    echo "$hits" >&2
    echo >&2
    failures=$((failures + 1))
  fi
done

# Literal substring matches.
for pattern in "${SUBSTRING_PATTERNS[@]}"; do
  hits=$(
    grep -RIn "${EXCLUDES[@]}" -F -e "$pattern" "${SOURCE_GLOBS[@]}" 2>/dev/null \
      | grep -v 'allow-stub:' \
      || true
  )
  if [ -n "$hits" ]; then
    echo "forbid-stubs: substring '$pattern' found:" >&2
    echo "$hits" >&2
    echo >&2
    failures=$((failures + 1))
  fi
done

# Empty match arms — Err(_) => {} and Ok(_) => {} silently discard outcomes.
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
  echo "  // allow-stub: <reason>   (include issue + expiry date)" >&2
  exit 1
fi

echo "forbid-stubs: clean."
exit 0
