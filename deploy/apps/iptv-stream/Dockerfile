# syntax=docker/dockerfile:1.7
#
# IPTV Hub — iptv-stream (RickyRLD/iptv-player)
#
# Upstream:  https://github.com/RickyRLD/iptv-player
# Pinned at: 441eba81c620bea77e22d8e2d5dcf889b0d569a9 (2026-03-22 "docs: add professional README")
# Stack:     Python 3.10+ standard library only (zero pip deps per upstream README).
# Server:    http.server.HTTPServer on port 8765, HTML/JS embedded inline in iptv_player.py.
#
# Container hardening:
#   - Pinned base (python:3.12-slim, Debian bookworm-slim base).
#   - Pinned apt packages (git for the clone, curl for the healthcheck).
#   - Non-root runtime UID/GID.
#   - Bind host overridable via IPTV_BIND_HOST (default 0.0.0.0 inside the container).
#   - Port overridable via IPTV_PORT (default 8765 — matches deploy/ports.json slot 9700→8765).
#   - M3U source and EPG URL overridable; defaults preserve upstream behaviour.

ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG IPTV_PLAYER_REPO=https://github.com/RickyRLD/iptv-player.git
ARG IPTV_PLAYER_SHA=441eba81c620bea77e22d8e2d5dcf889b0d569a9

# ── Stage 1: fetch ────────────────────────────────────────────────────────────
FROM ${PYTHON_IMAGE} AS fetch

ARG IPTV_PLAYER_REPO
ARG IPTV_PLAYER_SHA

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        git=1:2.* \
        ca-certificates; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN set -eux; \
    git init iptv-player; \
    cd iptv-player; \
    git remote add origin "${IPTV_PLAYER_REPO}"; \
    git fetch --depth=1 origin "${IPTV_PLAYER_SHA}"; \
    git checkout FETCH_HEAD; \
    actual="$(git rev-parse HEAD)"; \
    test "${actual}" = "${IPTV_PLAYER_SHA}" || { \
        echo "sha mismatch: expected ${IPTV_PLAYER_SHA}, got ${actual}" >&2; exit 1; \
    }; \
    rm -rf .git agent-harness

# Patch iptv_player.py so the bind host, port, M3U path, and EPG URL all come
# from env. Defaults preserve upstream behaviour byte-for-byte; only the bind
# host changes (127.0.0.1 → 0.0.0.0) so the container is reachable from the
# Docker bridge / loopback-published port.
# Inline patch script — written to a file first so the heredoc body does not
# share a Dockerfile instruction with line-continuation backslashes (mixing the
# two is fragile across parser versions). The patch is deterministic: each of
# the four literals must appear exactly once or the build fails.
COPY patch_iptv_player.py /tmp/patch_iptv_player.py
RUN set -eux; \
    cd /src/iptv-player; \
    python3 /tmp/patch_iptv_player.py iptv_player.py; \
    rm /tmp/patch_iptv_player.py

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM ${PYTHON_IMAGE} AS runtime

LABEL org.opencontainers.image.title="iptv-stream" \
      org.opencontainers.image.source="https://github.com/RickyRLD/iptv-player" \
      org.opencontainers.image.description="IPTV Player (Python stdlib HTTP server, EPG + HLS) — packaged for IPTV Hub." \
      org.opencontainers.image.licenses="MIT" \
      iptv-hub.app-id="iptv-stream" \
      iptv-hub.host-port="9700" \
      iptv-hub.container-port="8765"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl=7.88.* \
        ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 1000 iptv; \
    useradd  --system --uid 1000 --gid 1000 --home-dir /app --shell /usr/sbin/nologin iptv; \
    install -d -o iptv -g iptv -m 0755 /app /app/data

WORKDIR /app
COPY --from=fetch --chown=iptv:iptv /src/iptv-player/ /app/

# Drop into the data dir layout the script understands. The script reads its
# M3U from $IPTV_M3U_FILE; we point it at /app/data/rpl.m3u so an operator
# can bind-mount their playlist over the empty file without rebuilding.
RUN set -eux; \
    install -o iptv -g iptv -m 0644 /dev/null /app/data/rpl.m3u

USER iptv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    IPTV_BIND_HOST=0.0.0.0 \
    IPTV_PORT=8765 \
    IPTV_M3U_FILE=/app/data/rpl.m3u \
    IPTV_EPG_URL=http://list.plusx.tv/pl10.gz

EXPOSE 8765

# /api/epg/status is always-on (returns the loader state JSON whether or not
# the EPG fetch has completed). Use it as the liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent --show-error --max-time 4 \
        "http://127.0.0.1:${IPTV_PORT}/api/epg/status" >/dev/null \
  || exit 1

ENTRYPOINT ["python3", "/app/iptv_player.py"]
