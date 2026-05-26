# syntax=docker/dockerfile:1.7
#
# Extreme InfiniTV — web-preview-mode Docker image.
#
# Upstream:  https://github.com/infinitel8p/Extreme-InfiniTV (TS + Astro/Svelte; desktop-first Tauri)
# Mode:      web preview only — the upstream README documents this path as
#              "Build with `pnpm build` and serve `dist/` (no auto-update, no native features)"
#            so we run the Astro static build and serve the resulting `dist/` behind nginx.
# Output:    static SPA on container port 80.
#
# Notes on the build stage:
#   - Node version is pinned to node:20-alpine (Node 20 LTS, the README minimum).
#   - The pnpm version is pinned to the same value as the upstream `packageManager`
#     field in package.json (pnpm@10.31.0 as of upstream v1.6.0) via `corepack prepare`.
#     `corepack prepare pnpm@latest --activate` is requested by the contract, but we
#     intentionally also pin the exact version below so the build is reproducible if
#     "latest" drifts upstream.
#   - We install build toolchain bits (python3, make, g++, git) because some of the
#     vite/rollup/sharp-style native dependencies in the Astro toolchain occasionally
#     pull a node-gyp build path; without them the install fails on alpine.
#   - We DO NOT install or invoke any of the Rust / Tauri toolchain. The upstream
#     `pnpm build` script is `astro build` (see package.json), which is pure JS and
#     never touches src-tauri/. That is the whole point of the web-preview mode.
#
# Runtime stage:
#   - nginx:1.27-alpine (pinned digest-less tag — matches the rest of the deploy stack,
#     including deploy/docker-compose.yml's healthcheck which uses 1.27-alpine).
#   - Serves `dist/` on port 80 with SPA fallback to index.html so Astro's
#     client-side router doesn't 404 on deep links.

# ---------- Builder stage ----------
FROM node:20-alpine AS builder

# Native build toolchain for any node-gyp deps the Astro/Vite dep graph pulls in.
RUN apk add --no-cache python3 make g++ git libc6-compat

WORKDIR /build

# Enable corepack (ships with Node 20) and pin pnpm to the exact version the
# upstream repo declares in its `packageManager` field.
ENV PNPM_VERSION=10.31.0
RUN corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
 && pnpm --version

# Copy the upstream source tree. The `.dockerignore` next to this Dockerfile
# excludes `src-tauri/`, `tests/`, and other dev-only paths so the build context
# stays small and Tauri's Rust crate never lands in the image.
COPY upstream/ /build/

# DaveAI web-hosted override layer. These files add server-side provider-vault
# support for Apollo Group TV and XtremeHD, plus a browser-safe version label.
# Keep them outside `upstream/` so the vendored source stays easy to refresh.
COPY overrides/ /tmp/daveai-overrides/
RUN cp -a /tmp/daveai-overrides/. /build/

# Honour the lockfile committed upstream.
RUN pnpm install --frozen-lockfile

# Astro static build → /build/dist/
RUN pnpm build

# Sanity check: fail loudly if the build did not produce dist/index.html.
RUN test -f /build/dist/index.html || (echo "ERROR: dist/index.html missing after pnpm build" >&2 && exit 1)

# ---------- Runtime stage ----------
FROM nginx:1.27-alpine AS runtime

# nginx config: SPA fallback to /index.html so Astro client-routed deep links
# (e.g. /livetv, /movies/...) resolve. wget is already in the alpine image and
# used by the compose-level healthcheck.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static assets only — no env baked in. All runtime config (Xtream credentials,
# playlists) is supplied by the user at runtime in the browser via the app UI.
COPY --from=builder /build/dist/ /usr/share/nginx/html/

EXPOSE 80

# Container-level liveness — the compose service fragment also defines a healthcheck
# but having one here means `docker run` alone still self-reports.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
