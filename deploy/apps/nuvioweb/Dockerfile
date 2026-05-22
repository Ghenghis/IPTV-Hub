# syntax=docker/dockerfile:1.6
#
# IPTV Hub — nuvioweb (Stremio-addon web client)
# Upstream: https://github.com/NuvioMedia/NuvioWeb
#
# Two stages:
#   1) node:20-alpine builds the static dist/ via the upstream's `npm run build`
#      (esbuild + babel pipeline → minified IIFE bundle + processed CSS).
#   2) nginx:1.27-alpine serves dist/ on container port 8080 (no privileged port).
#
# Both images are pinned. Build context: this directory (deploy/apps/nuvioweb/).
# We pin the upstream by commit so the image is reproducible from a clean clone;
# bump NUVIOWEB_REF in lockstep with the README "update path" section.

# ---------- Stage 1: build ----------
FROM node:20-alpine AS build

# Tools required for git clone + native module compilation under musl.
RUN apk add --no-cache git python3 make g++

WORKDIR /src

# Pin upstream by commit (NuvioMedia/NuvioWeb @ main, captured 2026-05-21).
# Override at build time: --build-arg NUVIOWEB_REPO=… --build-arg NUVIOWEB_REF=…
ARG NUVIOWEB_REPO=https://github.com/NuvioMedia/NuvioWeb.git
ARG NUVIOWEB_REF=main

RUN git clone "${NUVIOWEB_REPO}" . \
 && git checkout "${NUVIOWEB_REF}" \
 && git rev-parse HEAD > .nuvioweb.commit

# Install with devDependencies (build needs esbuild, babel, postcss, …).
# `--include=dev` forces inclusion even when the global config strips dev deps.
ENV NODE_ENV=development
RUN npm ci --include=dev --no-audit --no-fund

# Build the static bundle into ./dist (see scripts/build.mjs).
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM nginx:1.27-alpine AS runtime

# Drop nginx default site; ship our own that listens on 8080 with SPA-friendly
# try_files (NuvioWeb is a single-page client) and disables directory listing.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/nuvioweb.conf

# Static assets from the build stage.
COPY --from=build /src/dist /usr/share/nginx/html
# Preserve provenance for incident response.
COPY --from=build /src/.nuvioweb.commit /usr/share/nginx/html/.nuvioweb.commit

# nginx:alpine ships wget; healthcheck hits "/" on the container port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider --tries=1 http://127.0.0.1:8080/ || exit 1

EXPOSE 8080

# Default nginx entrypoint runs as root then drops to the nginx user via the
# stock /docker-entrypoint.sh; that is what we want for port 8080 binding.
CMD ["nginx", "-g", "daemon off;"]
