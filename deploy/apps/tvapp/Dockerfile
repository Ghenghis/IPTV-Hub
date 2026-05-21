# IPTV Hub — tvapp (TVApp2)
#
# Upstream:        https://github.com/TheBinaryNinja/tvapp2
# Upstream tag:    1.5.9
# Registry:        ghcr.io/thebinaryninja/tvapp2 (multi-arch: linux/amd64, linux/arm64)
# Manifest list:   sha256:934d578925c0e560dca4e009b0b82d7dfa93ffb56c64ec36ef134ba8d4d335c6
#
# This is a pure pass-through: TheBinaryNinja already publishes a multi-arch
# image to GHCR and Docker Hub. Rebuilding locally would add no value and would
# diverge from upstream's signed/published artefacts. We pin both the tag (1.5.9)
# AND the manifest-list digest, so the operator gets:
#
#   - deterministic pulls (digest is immutable; `:latest` is not allowed),
#   - automatic architecture selection (amd64 on x86_64 VPSes, arm64 on RasPi),
#   - one-line operator updates (bump the tag+digest below; `docker compose pull`).
#
# To upgrade:
#   1. Pick a new tag from https://github.com/TheBinaryNinja/tvapp2/releases
#   2. Run: docker buildx imagetools inspect ghcr.io/thebinaryninja/tvapp2:<new-tag> \
#          --format '{{.Manifest.Digest}}'
#   3. Update the FROM line below AND the image line in docker-compose.service.yml
#      with the new tag + digest. Never use `latest`.
#
# Compressed size (amd64, per registry manifest, 12 layers): ~46.4 MiB.

FROM ghcr.io/thebinaryninja/tvapp2:1.5.9@sha256:934d578925c0e560dca4e009b0b82d7dfa93ffb56c64ec36ef134ba8d4d335c6
