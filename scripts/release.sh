#!/usr/bin/env bash
# Cuts a release: verify clean tree, run full test gate, bump version, tag, build MSI.
#
# Usage:
#   scripts/release.sh <new-version>
#
# Example:
#   scripts/release.sh 0.2.0
#
# What it does:
#   1. Refuses if the working tree is dirty.
#   2. Refuses if the current branch is not master/main.
#   3. Runs scripts/test.sh end-to-end.
#   4. Updates the version in Cargo.toml, frontend/package.json, and
#      src-tauri/tauri.conf.json.
#   5. Rotates CHANGELOG.md [Unreleased] to [<version>] — <date>.
#   6. Commits with message "release: v<version>".
#   7. Tags v<version> (annotated, signed if signing is configured).
#   8. Builds the release MSI via scripts/build.sh.
#
# Does NOT push or upload — the human owner runs `git push --follow-tags` after
# reviewing the release commit. The publish workflow then handles GitHub release
# creation per .github/workflows/release.yml.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ne 1 ]; then
  echo "usage: scripts/release.sh <new-version>" >&2
  exit 2
fi

NEW_VERSION="$1"

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "release: version '$NEW_VERSION' is not semver" >&2
  exit 2
fi

# 1. Clean tree.
if [ -n "$(git status --porcelain)" ]; then
  echo "release: working tree is dirty — commit or stash first" >&2
  git status --short
  exit 1
fi

# 2. Correct branch.
CURRENT_BRANCH=$(git symbolic-ref --short HEAD)
if [ "$CURRENT_BRANCH" != "master" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  echo "release: must run on master or main (you are on '$CURRENT_BRANCH')" >&2
  exit 1
fi

# 3. Full gate.
echo '== full test gate =='
bash scripts/test.sh

# 4. Version bumps.
echo "== bumping versions to $NEW_VERSION =="

# Cargo workspace version.
python3 - <<PY "$NEW_VERSION"
import re, sys, pathlib
new = sys.argv[1]
p = pathlib.Path("Cargo.toml")
text = p.read_text()
text = re.sub(r'^version\s*=\s*"[^"]+"', f'version       = "{new}"', text, count=1, flags=re.MULTILINE)
p.write_text(text)
PY

# Frontend package.json.
python3 - <<PY "$NEW_VERSION"
import json, sys, pathlib
new = sys.argv[1]
p = pathlib.Path("frontend/package.json")
data = json.loads(p.read_text())
data["version"] = new
p.write_text(json.dumps(data, indent=2) + "\n")
PY

# Tauri conf.
python3 - <<PY "$NEW_VERSION"
import json, sys, pathlib
new = sys.argv[1]
p = pathlib.Path("src-tauri/tauri.conf.json")
data = json.loads(p.read_text())
data["version"] = new
p.write_text(json.dumps(data, indent=2) + "\n")
PY

# 5. CHANGELOG rotation.
TODAY=$(date -u +%Y-%m-%d)
python3 - <<PY "$NEW_VERSION" "$TODAY"
import re, sys, pathlib
new, today = sys.argv[1], sys.argv[2]
p = pathlib.Path("CHANGELOG.md")
text = p.read_text()
# Replace the first "## [Unreleased]" with "## [Unreleased]\n\n## [<new>] — <today>"
new_text, n = re.subn(
    r'^## \[Unreleased\]',
    f'## [Unreleased]\n\n## [{new}] — {today}',
    text, count=1, flags=re.MULTILINE,
)
if n == 0:
    raise SystemExit("CHANGELOG.md has no '## [Unreleased]' header")
p.write_text(new_text)
PY

# 6. Commit.
git add Cargo.toml frontend/package.json src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "release: v$NEW_VERSION"

# 7. Tag.
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

# 8. Build MSI.
echo '== building release MSI =='
bash scripts/build.sh

echo
echo "release: v$NEW_VERSION tagged. push with: git push --follow-tags"
