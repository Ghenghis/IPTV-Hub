# syntax=docker/dockerfile:1.7
#
# IPTV Hub — smart-iptv-web (upstream: https://github.com/Web-IPTV/iptv)
#
# Upstream does NOT ship a Dockerfile. This file authors a faithful multi-stage
# image set:
#
#   1. fetch     — clones the upstream repo pinned to a known commit SHA.
#   2. ui        — nginx:1.27-alpine serving the static UI (index.html,
#                  web-iptv.html, assets/, samples/, *.js) on container port
#                  8080. This is the PRIMARY service.
#   3. epg       — node:20-alpine running epg-server.js (Express) on container
#                  port 3001. Optional sidecar; honours EPG_PORT, EPG_SCRIPT_PATH,
#                  CACHE_DURATION_MINUTES from env.example.
#
# Build either target explicitly:
#   docker build --target ui  -f Dockerfile -t iptv-hub-smart-iptv-web-ui:test  .
#   docker build --target epg -f Dockerfile -t iptv-hub-smart-iptv-web-epg:test .
#
# Default (no --target) yields the ui image, which is the primary deployable.
# The companion docker-compose.service.yml wires both targets as separate
# services on policy ports 9780 (ui) and 9781 (epg).

# -----------------------------------------------------------------------------
# Stage 1: fetch upstream sources at a pinned commit.
# -----------------------------------------------------------------------------
FROM alpine/git:2.45.2 AS fetch

# Pinned upstream commit — bump deliberately during update path (see README).
ARG UPSTREAM_REPO=https://github.com/Web-IPTV/iptv.git
ARG UPSTREAM_REF=46b6b677d5eeef0c91c18d45ac00a2fa9daf0a32

WORKDIR /src
RUN git clone "${UPSTREAM_REPO}" upstream \
 && cd upstream \
 && git checkout "${UPSTREAM_REF}" \
 && git rev-parse HEAD > /src/UPSTREAM_SHA

# -----------------------------------------------------------------------------
# Stage 2: ui — nginx serving the static IPTV web player.
# -----------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS ui

USER root

# nginx config: listen on 8080 (matches the upstream `python3 -m http.server 8080`
# convention and the INVENTORY.md "Internal port (primary): 8080" requirement).
# Root `/` serves index.html (landing page) which links to web-iptv.html (player).
COPY --chown=nginx:nginx <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 8080;
    listen [::]:8080;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # Long timeouts for HLS / MPEG-TS playback proxying through this origin.
    keepalive_timeout 120s;

    # Standard static-site routing.
    location / {
        try_files $uri $uri/ =404;
    }

    # Health probe used by deploy/scripts/verify.py.
    location = /__iptv_hub_probe {
        access_log off;
        add_header Content-Type text/plain;
        return 200 "ok\n";
    }

    # Disable directory listing for everything except the samples/ playlists,
    # which are useful to expose so the player can autoload them.
    autoindex off;
    location /samples/ {
        autoindex on;
    }
}
EOF

# Copy only the static-server-relevant files from the upstream clone. We
# deliberately skip Electron, build scripts, ngrok shims, and node_modules.
COPY --from=fetch --chown=nginx:nginx /src/upstream/index.html        /usr/share/nginx/html/index.html
COPY --from=fetch --chown=nginx:nginx /src/upstream/web-iptv.html     /usr/share/nginx/html/web-iptv.html
COPY --from=fetch --chown=nginx:nginx /src/upstream/http-redirect.html /usr/share/nginx/html/http-redirect.html
COPY --from=fetch --chown=nginx:nginx /src/upstream/config-loader.js  /usr/share/nginx/html/config-loader.js
COPY --from=fetch --chown=nginx:nginx /src/upstream/github-pages-config.js /usr/share/nginx/html/github-pages-config.js
COPY --from=fetch --chown=nginx:nginx /src/upstream/main.js           /usr/share/nginx/html/main.js
COPY --from=fetch --chown=nginx:nginx /src/upstream/assets            /usr/share/nginx/html/assets
COPY --from=fetch --chown=nginx:nginx /src/upstream/samples           /usr/share/nginx/html/samples
COPY --from=fetch --chown=nginx:nginx /src/upstream/CONFIGURATION.md  /usr/share/nginx/html/CONFIGURATION.md
COPY --from=fetch --chown=nginx:nginx /src/upstream/README.md         /usr/share/nginx/html/UPSTREAM_README.md
COPY --from=fetch --chown=nginx:nginx /src/UPSTREAM_SHA               /usr/share/nginx/html/UPSTREAM_SHA

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:8080/__iptv_hub_probe || exit 1

# nginx-unprivileged image already sets CMD ["nginx", "-g", "daemon off;"].

# -----------------------------------------------------------------------------
# Stage 3: epg — Node.js EPG cache/proxy server.
# -----------------------------------------------------------------------------
# epg-server.js depends only on: express, cors, dotenv (per upstream
# package.json). It also `spawn`s python3 against EPG_SCRIPT_PATH at request
# time; that path is NOT shipped by the upstream repo and is operator-supplied
# via volume mount or by leaving the EPG endpoints unused. The /api/health,
# /api/cache/status, and /api/cache (DELETE) endpoints work without any python
# script — they manage the in-process cache only.
# -----------------------------------------------------------------------------
FROM node:20.18-alpine AS epg

# python3 is required only when an operator mounts a real epg_fetch.py and
# starts hitting /api/epg/:channelId. Adding it here keeps the image faithful
# to the upstream design without forcing a second image.
RUN apk add --no-cache python3 dumb-init \
 && addgroup -S -g 1001 iptv \
 && adduser  -S -u 1001 -G iptv iptv

WORKDIR /app

# Install only the runtime deps named by upstream's package.json (express,
# cors, dotenv). We deliberately avoid `npm ci` against the upstream
# package-lock because it pulls Electron (~250 MB devDep) which the EPG
# service does not need.
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error \
        express@5.1.0 \
        cors@2.8.5 \
        dotenv@17.2.2 \
 && npm cache clean --force

COPY --from=fetch --chown=iptv:iptv /src/upstream/epg-server.js /app/epg-server.js
COPY --from=fetch --chown=iptv:iptv /src/upstream/env.example   /app/env.example
COPY --from=fetch --chown=iptv:iptv /src/UPSTREAM_SHA           /app/UPSTREAM_SHA

# Writable dir for epg-cache.json (the server writes to CWD per upstream code).
RUN mkdir -p /app/cache && chown -R iptv:iptv /app

USER iptv

EXPOSE 3001

ENV NODE_ENV=production \
    EPG_PORT=3001 \
    CACHE_DURATION_MINUTES=30

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3001/api/health || exit 1

WORKDIR /app/cache
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "/app/epg-server.js"]
