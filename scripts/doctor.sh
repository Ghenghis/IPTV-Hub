#!/usr/bin/env bash
# IPTV Hub — doctor (Bash). Mirrors scripts/doctor.ps1 for WSL and CI environments.
set -uo pipefail

failures=0
check() {
  local name="$1"; shift
  printf '  %-32s ' "$name"
  if "$@" >/dev/null 2>&1; then
    printf '\033[32mPASS\033[0m\n'
  else
    printf '\033[31mFAIL\033[0m\n'
    failures=$((failures + 1))
  fi
}

echo "IPTV Hub — doctor"
echo

check 'rustc available' rustc --version
check 'cargo available' cargo --version

check 'rust 1.82+' bash -c '
  v=$(rustc --version | sed -E "s/^rustc ([0-9]+)\.([0-9]+).*/\1.\2/")
  major=${v%%.*}; minor=${v##*.}
  [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -ge 82 ]; }
'

check 'node 20+ available' bash -c '
  v=$(node --version 2>/dev/null | sed -E "s/^v([0-9]+).*/\1/")
  [ -n "$v" ] && [ "$v" -ge 20 ]
'

check 'npm available' npm --version

check 'cargo workspace parses' bash -c '
  cd "$(dirname "$0")/.."
  cargo metadata --format-version=1 --offline >/dev/null 2>&1
'

echo
if [ "$failures" -gt 0 ]; then
  echo -e "\033[31m$failures check(s) failed.\033[0m"
  exit 1
else
  echo -e "\033[32mAll checks passed.\033[0m"
  exit 0
fi
