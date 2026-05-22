# syntax=docker/dockerfile:1.7
#
# wizju-iptv-player — multi-stage build for the IPTV Hub stack.
#
# Upstream: https://github.com/j2jstudio/wizju-iptv-player
# Stack:    TypeScript + Vue 3 + Vite (web mode via vite.config.web.ts)
# Build:    `pnpm build:web` (run-p type-check + build-only:web) -> dist-web/
# Runtime:  nginx serves the static SPA on container port 80.
#
# Notes:
# - The upstream ships pnpm-lock.yaml (not package-lock.json), so we cannot use
#   `npm ci`. We use corepack to pin the exact pnpm version declared by the
#   repo (or fall back to the bundled one) and `pnpm install --frozen-lockfile`
#   for reproducibility — same intent as `npm ci`.
# - Default `pnpm build` targets the Chrome Extension; we use `pnpm build:web`
#   which writes to `dist-web/` per vite.config.web.ts.
# - The host port mapping (9820:80) lives in docker-compose.service.yml, not
#   here — this image is port-agnostic and just exposes nginx on 80.

###############################################################################
# Stage 1 — build the Vue 3 / Vite web bundle.
###############################################################################
FROM node:20-alpine AS build

WORKDIR /src

# Enable corepack so we get the pnpm version the repo expects. pnpm is required
# because the lockfile is pnpm-lock.yaml; using npm would ignore it and break
# the reproducibility guarantee in CONTRACT.md §2.5.
RUN corepack enable

# Copy manifests first so the install layer caches independently of the source.
COPY package.json pnpm-lock.yaml ./

# Frozen lockfile = the pnpm equivalent of `npm ci`.
RUN pnpm install --frozen-lockfile

# Copy the rest of the source tree.
COPY . .

# Produce the web bundle. This runs `run-p type-check build-only:web`, which
# fails the build on any TS error per CONTRACT.md §2.4 (zero-warning default).
RUN pnpm run build:web

###############################################################################
# Stage 2 — minimal static server. nginx:1.27-alpine is pinned per the
# project's pinned-image policy.
###############################################################################
FROM nginx:1.27-alpine AS runtime

# Replace the default site config with one that:
#   - serves the SPA from /usr/share/nginx/html
#   - rewrites unknown paths to /index.html so Vue Router (history mode) works
#   - disables the default access log noise but keeps errors
RUN rm /etc/nginx/conf.d/default.conf
COPY <<'NGINX_CONF' /etc/nginx/conf.d/default.conf
server {
    listen 80;
    listen [::]:80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # Long cache for hashed assets (Vite emits content-hashed filenames).
    location /assets/ {
        access_log off;
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # SPA fallback — every non-file path resolves to index.html.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Basic security headers. The app fetches arbitrary playlist URLs from the
    # browser, so we cannot lock CSP down here without breaking it; that's the
    # operator's call at the edge (Cloudflare / nginx fronting Caddy).
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINX_CONF

# Copy the built bundle. vite.config.web.ts -> outDir 'dist-web'.
COPY --from=build /src/dist-web /usr/share/nginx/html

EXPOSE 80

# Default nginx CMD from the base image is already
#   ["nginx", "-g", "daemon off;"]
# so we don't override it.
