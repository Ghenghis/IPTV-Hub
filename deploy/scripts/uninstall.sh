#!/usr/bin/env bash
# IPTV Hub — tear down the stack.
#
# Default: stops and removes containers + networks (keeps volumes).
# With --purge: ALSO removes volumes (Caddy certs, app data).
#
# Requires explicit `--yes` to proceed — by design.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

PURGE=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes)   ASSUME_YES=1 ;;
    -h|--help)
      cat <<USAGE
Usage: $(basename "$0") [--purge] --yes

  (no flags)   Refuses to run; tells you to add --yes.
  --yes        Stops + removes containers and networks (keeps volumes).
  --purge --yes  Also removes volumes (DESTRUCTIVE — wipes certs and data).
USAGE
      exit 0
      ;;
    *) echo "uninstall: unknown arg '$arg'" >&2; exit 2 ;;
  esac
done

if [ "$ASSUME_YES" -ne 1 ]; then
  echo "uninstall: refusing to run without --yes (safety guard)" >&2
  echo "  add --yes to remove containers, or --purge --yes to also wipe volumes" >&2
  exit 2
fi

if [ ! -f .env ]; then
  echo "uninstall: .env missing — nothing to do" >&2; exit 0
fi
set -a; . ./.env; set +a

COMPOSE_ARGS=(--env-file .env -f docker-compose.yml)
[ -f docker-compose.apps.yml ] && COMPOSE_ARGS+=(-f docker-compose.apps.yml)

if [ "$PURGE" -eq 1 ]; then
  echo "uninstall: --purge — stopping stack AND wiping volumes"
  docker compose "${COMPOSE_ARGS[@]}" down --volumes --remove-orphans
else
  echo "uninstall: stopping stack (volumes preserved)"
  docker compose "${COMPOSE_ARGS[@]}" down --remove-orphans
fi

echo "uninstall: done."
