# IPTV Hub — xstream-player
#
# Upstream:  https://github.com/jandersonss/xstream-player
# Docker:    https://hub.docker.com/r/jandersonss/xstream-player
#
# We use the upstream-published image rather than rebuilding from source. The
# upstream Dockerfile is a standard Next.js multi-stage build (node:20-alpine
# base, `next build`, standalone output) — there is nothing for us to add by
# rebuilding, and pinning to the upstream digest gives byte-for-byte
# reproducibility.
#
# Pinned tag + sha256 digest (resolved against Docker Hub registry on
# 2026-05-21 from https://hub.docker.com/v2/repositories/jandersonss/xstream-player/tags/1.5.1):
#
#   jandersonss/xstream-player:1.5.1
#   @sha256:a3ef8567318d69130b71b440ffc49c568f114d338f5fb13782b4c68935dcc88f
#   published 2026-05-13T19:39:27Z, full_size 71,910,806 bytes (~71.9 MB compressed)
#
# To update: bump the tag, replace the digest with the new sha256 from
#   curl -s https://hub.docker.com/v2/repositories/jandersonss/xstream-player/tags/<new-tag>
# and rebuild. Never use :latest — the IPTV-Hub deploy contract forbids
# floating tags (CONTRACT.md §2.5: Reproducibility).
FROM jandersonss/xstream-player:1.5.1@sha256:a3ef8567318d69130b71b440ffc49c568f114d338f5fb13782b4c68935dcc88f

# The upstream image already sets:
#   WORKDIR /app
#   ENV NODE_ENV=production
#   ENV NEXT_TELEMETRY_DISABLED=1
#   ENV PORT=3000
#   ENV HOSTNAME=0.0.0.0
#   EXPOSE 3000
#   CMD ["node", "server.js"]
#
# /app/data is the bind target for persistent config (config.json with login
# credentials). The compose fragment in this directory mounts a named volume
# there. Per upstream README the container runs as uid 1001 so the volume
# must be writable by that uid (handled by Docker volume driver).
