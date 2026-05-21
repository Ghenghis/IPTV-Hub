#!/usr/bin/env bash
# scripts/sync-secrets.sh
#
# Lane: lane-cloud-pack. Solves the "git-ignored .env is not getting onto the
# VPS" deploy blocker.
#
# This script is the ONLY authorised path for moving secrets from the
# operator laptop to the VPS. Git never sees these files; they live under
# ~/.iptv-hub-secrets/ on the laptop and /opt/iptv-hub/secrets/ on the VPS.
#
# Run from the operator laptop. SSH key auth is assumed (Hostinger panel
# uploaded it under "SSH key — Manage").
#
# Exit codes:
#   0 success
#   1 missing local secrets directory
#   2 missing required secret files
#   3 ssh/scp failure

set -euo pipefail

VPS="${IPTV_HUB_VPS:-root@187.77.30.206}"
LOCAL_DIR="${IPTV_HUB_SECRETS:-${HOME}/.iptv-hub-secrets}"
REMOTE_DIR="/opt/iptv-hub/secrets"

REQUIRED_FILES=(
    authentik.env
    cloudflare.env
    smtp.env
)

# ── Preflight ──────────────────────────────────────────────────────────────

if [[ ! -d "$LOCAL_DIR" ]]; then
    cat >&2 <<EOF
sync-secrets: local secrets dir not found: $LOCAL_DIR

create it with:
    mkdir -p "$LOCAL_DIR"
    chmod 700 "$LOCAL_DIR"

then copy the .env.example files from authentik/, cloudflare/, smtp/ into
"$LOCAL_DIR" and fill in the real values. See docs/54_IPTV_HUB_CLOUD_DEPLOYMENT.md
"Secrets layout" for what each file contains.
EOF
    exit 1
fi

missing=()
for f in "${REQUIRED_FILES[@]}"; do
    if [[ ! -f "$LOCAL_DIR/$f" ]]; then
        missing+=("$f")
    fi
done
if (( ${#missing[@]} > 0 )); then
    echo "sync-secrets: missing required files in $LOCAL_DIR:" >&2
    for f in "${missing[@]}"; do
        echo "  - $f" >&2
    done
    exit 2
fi

# Local hygiene: refuse to sync if any secret file is world-readable.
for f in "${REQUIRED_FILES[@]}"; do
    perms=$(stat -c '%a' "$LOCAL_DIR/$f" 2>/dev/null || stat -f '%A' "$LOCAL_DIR/$f")
    if [[ "$perms" != "600" && "$perms" != "0600" ]]; then
        echo "sync-secrets: fixing local perms on $f ($perms → 0600)" >&2
        chmod 600 "$LOCAL_DIR/$f"
    fi
done

# ── Transfer ───────────────────────────────────────────────────────────────

echo "sync-secrets: ensuring $REMOTE_DIR exists on $VPS …"
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$VPS" \
        "mkdir -p $REMOTE_DIR && chmod 700 $REMOTE_DIR && chown root:root $REMOTE_DIR"; then
    echo "sync-secrets: ssh failed — is the key uploaded? is the VPS reachable?" >&2
    exit 3
fi

echo "sync-secrets: copying ${#REQUIRED_FILES[@]} files …"
for f in "${REQUIRED_FILES[@]}"; do
    scp -q -o BatchMode=yes "$LOCAL_DIR/$f" "$VPS:$REMOTE_DIR/$f.new"
    ssh -o BatchMode=yes "$VPS" \
        "chmod 600 $REMOTE_DIR/$f.new && \
         chown root:root $REMOTE_DIR/$f.new && \
         mv -f $REMOTE_DIR/$f.new $REMOTE_DIR/$f"
    echo "  ✓ $f"
done

# ── Verify ─────────────────────────────────────────────────────────────────

echo "sync-secrets: verifying on $VPS …"
ssh -o BatchMode=yes "$VPS" "ls -la $REMOTE_DIR/" >&2

echo
echo "sync-secrets: done. Next step:"
echo "  ssh $VPS 'cd /opt/iptv-hub/authentik && docker compose up -d'"
