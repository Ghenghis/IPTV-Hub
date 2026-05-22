# IPTV Hub — iptv-restream
# Upstream: https://github.com/antebrl/IPTV-Restream
# Pinned to commit d9705451cece0141201d97c76c545b112e675587 (release v2.2).
#
# Upstream ships three docker-compose services that we collapse into a single
# container for the IPTV-Hub stack model:
#   1. frontend  — Vite/React SPA built and served by nginx on internal :80
#   2. backend   — Node.js + ffmpeg API/WebSocket server on internal :5000
#   3. edge      — nginx reverse proxy on :80 routing / -> frontend and
#                  /api/ /socket.io/ /proxy/ /streams/ -> backend.
# All three are real upstream code paths from the cloned repo; only the
# inter-service hostnames in the upstream nginx.conf are rewritten to
# 127.0.0.1 because everything now lives in one container.
#
# Internal exposed port: 80. The compose fragment maps host 127.0.0.1:9690 -> 80.

ARG NODE_VERSION=20
ARG UPSTREAM_REF=d9705451cece0141201d97c76c545b112e675587

# -----------------------------------------------------------------------------
# Stage 1: fetch upstream source at the pinned commit.
# We use git fetch + checkout against the commit SHA to make this build
# reproducible even if the repo's main branch advances.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS source
ARG UPSTREAM_REF
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . \
 && git remote add origin https://github.com/antebrl/IPTV-Restream.git \
 && git fetch --depth 1 origin "${UPSTREAM_REF}" \
 && git checkout -q FETCH_HEAD

# -----------------------------------------------------------------------------
# Stage 2: build the Vite frontend with the exact same VITE_* args the
# upstream docker-compose.yml passes.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS frontend-builder
WORKDIR /app
COPY --from=source /src/frontend/package.json /src/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --from=source /src/frontend/ ./
ARG VITE_BACKEND_URL=""
ARG VITE_STREAM_DELAY=18
ARG VITE_STREAM_PROXY_DELAY=30
ARG VITE_SYNCHRONIZATION_TOLERANCE=""
ARG VITE_SYNCHRONIZATION_MAX_DEVIATION=""
ARG VITE_SYNCHRONIZATION_ADJUSTMENT=""
ARG VITE_SYNCHRONIZATION_MAX_ADJUSTMENT=""
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL} \
    VITE_STREAM_DELAY=${VITE_STREAM_DELAY} \
    VITE_STREAM_PROXY_DELAY=${VITE_STREAM_PROXY_DELAY} \
    VITE_SYNCHRONIZATION_TOLERANCE=${VITE_SYNCHRONIZATION_TOLERANCE} \
    VITE_SYNCHRONIZATION_MAX_DEVIATION=${VITE_SYNCHRONIZATION_MAX_DEVIATION} \
    VITE_SYNCHRONIZATION_ADJUSTMENT=${VITE_SYNCHRONIZATION_ADJUSTMENT} \
    VITE_SYNCHRONIZATION_MAX_ADJUSTMENT=${VITE_SYNCHRONIZATION_MAX_ADJUSTMENT}
RUN npm run build
# /app/dist now contains the static SPA bundle.

# -----------------------------------------------------------------------------
# Stage 3: install backend production dependencies (no build step required —
# the backend is plain CommonJS Node + ffmpeg at runtime).
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS backend-deps
WORKDIR /app
COPY --from=source /src/backend/package.json /src/backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=source /src/backend/ ./

# -----------------------------------------------------------------------------
# Stage 4: final runtime — debian-slim with nginx + node + ffmpeg + supervisord.
# Runs three processes: edge nginx (:80), Node backend (:5000), and serves
# the static frontend bundle from the same edge nginx (skipping the upstream
# "frontend nginx" container — it added no behaviour beyond serving /app/dist).
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG UPSTREAM_REF
ENV STORAGE_PATH=/streams/ \
    NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive

# System deps: nginx (edge), ffmpeg (restream), supervisor (process tree),
# wget (healthcheck), tini (pid 1 signal handling).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        nginx \
        ffmpeg \
        supervisor \
        wget \
        tini \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /streams /channels /var/log/supervisor /run/nginx \
 && rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default

# Backend code + node_modules at /opt/iptv-restream/backend.
WORKDIR /opt/iptv-restream/backend
COPY --from=backend-deps /app/ ./

# Static frontend bundle served by the edge nginx.
COPY --from=frontend-builder /app/dist/ /usr/share/nginx/html/

# Edge nginx config — adapted from
# https://github.com/antebrl/IPTV-Restream/blob/${UPSTREAM_REF}/deployment/nginx/nginx.conf
# Differences from upstream:
#   * frontend assets are served from /usr/share/nginx/html instead of
#     proxied to a separate frontend container.
#   * backend proxy_pass targets are 127.0.0.1:5000 since the Node backend
#     runs in the same container under supervisord.
COPY nginx.conf /etc/nginx/nginx.conf

# supervisord config that runs nginx (foreground) and the Node backend.
COPY supervisord.conf /etc/supervisor/conf.d/iptv-restream.conf

LABEL org.opencontainers.image.source="https://github.com/antebrl/IPTV-Restream" \
      org.opencontainers.image.revision="${UPSTREAM_REF}" \
      org.opencontainers.image.title="iptv-restream" \
      org.opencontainers.image.description="IPTV restream + watch2gether (antebrl/IPTV-Restream) bundled for IPTV-Hub VPS deploy."

EXPOSE 80
VOLUME ["/streams", "/channels"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
