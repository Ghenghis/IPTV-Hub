# syntax=docker/dockerfile:1.7
#
# IPTV Hub — stalker-ui (upstream: kidpoleon/stalkerhek).
#
# This Dockerfile mirrors the upstream Dockerfile at
#   https://github.com/kidpoleon/stalkerhek/blob/main/Dockerfile
# pinned to commit 0fdc13f8ed33137a54d96420edc387951a54c9f5 (Tue May 19 2026).
#
# Differences from upstream:
#   - Build context is this directory; source is vendored under ./upstream/
#     instead of being the context root. All COPY paths are prefixed.
#   - Multi-stage and pinned base images (golang:1.24-alpine + alpine:3.20)
#     are kept verbatim — they are what upstream tests and ships.
#
# Upstream licence: GPL-3.0 (see ./upstream/LICENSE). Re-using their Dockerfile
# layout inside this repository for deployment is permitted by GPL-3.0; the
# stalkerhek binary built here remains under GPL-3.0 and the source is preserved
# under ./upstream/.

# --- stage 1: build the stalkerhek binary ----------------------------------
FROM golang:1.24-alpine AS build

WORKDIR /src

RUN apk add --no-cache git ca-certificates

# go.mod / go.sum first for layer caching.
COPY upstream/go.mod upstream/go.sum ./
RUN go mod download

# Bring in the full source tree.
COPY upstream/ ./

RUN CGO_ENABLED=0 GOOS=linux go build \
        -trimpath \
        -ldflags="-s -w" \
        -o /out/stalkerhek \
        ./cmd/stalkerhek

# --- stage 2: minimal runtime ---------------------------------------------
FROM alpine:3.20

# ca-certificates: HTTPS to Stalker portals.
# tzdata:          correct timestamps in logs / EPG.
# ffmpeg:          stalkerhek diagnostics + future transcode hooks.
# curl:            HEALTHCHECK probe.
# wget:            second-choice HEALTHCHECK probe; tiny and useful for ops.
RUN apk add --no-cache \
        ca-certificates \
        tzdata \
        ffmpeg \
        curl \
        wget \
    && addgroup -S stalker \
    && adduser  -S -G stalker -h /app stalker \
    && mkdir -p /data \
    && chown -R stalker:stalker /app /data

WORKDIR /app

COPY --from=build --chown=stalker:stalker /out/stalkerhek /app/stalkerhek
COPY --from=build --chown=stalker:stalker /src/graphic/  /app/graphic/

# STALKERHEK_ROOT tells stalkerhek where to find graphic/ at runtime.
ENV STALKERHEK_ROOT=/app

# Default profile / auth / filter file locations expected by the upstream
# docker-compose; honoured by webui/persist.go, webui/auth.go,
# webui/filters_persist.go. Operators mount /data from the host.
ENV STALKERHEK_PROFILES_FILE=/data/profiles.json
ENV STALKERHEK_AUTH_FILE=/data/auth.json
ENV STALKERHEK_FILTERS_FILE=/data/filters.json

# Upstream binds the WebUI on ":4400" (0.0.0.0:4400) — see
# upstream/webui/webui.go: srv := &http.Server{Addr: ":4400", ...}.
# That is reachable across the docker bridge, so a plain `-p host:4400`
# mapping works.
EXPOSE 4400

# Match upstream's HEALTHCHECK against the unauthenticated /health endpoint
# (RegisterHealthHandlers in upstream/webui/health.go).
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:4400/health || exit 1

USER stalker

ENTRYPOINT ["/app/stalkerhek"]
