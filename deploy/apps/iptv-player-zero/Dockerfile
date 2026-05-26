# syntax=docker/dockerfile:1.7
#
# Static-only package for the cleaned IPTV Player Zero browser bundle.
# Current production is served from the DaveTV launcher at apps.daveai.tech;
# this Dockerfile is for local verification or a future approved orchestrator
# slot.

FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY --chown=nginx:nginx static/ /usr/share/nginx/html/
COPY --chown=nginx:nginx static/ /usr/share/nginx/html/iptv-player-zero/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
