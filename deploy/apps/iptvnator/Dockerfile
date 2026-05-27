# IPTV Hub — iptvnator (4gray/iptvnator) self-hosted PWA build.
#
# Upstream:           https://github.com/4gray/iptvnator
# Upstream SHA pin:   b2909a11863cc46de250d13a0c5180dc49b997c6
# Upstream version:   0.22.0 (package.json)
# Upstream license:   MIT (see LICENSE in upstream repo)
# Upstream Dockerfile reference: docker/Dockerfile at the pinned SHA.
#
# This Dockerfile is functionally equivalent to running the upstream
# `docker/Dockerfile` against a checkout of 4gray/iptvnator at the pinned SHA.
# We add a "fetch" stage so the build is fully self-contained (no submodule,
# no out-of-band SCP of the upstream tree) and reproducible from the SHA
# alone. All build steps after fetch are the upstream's verbatim build
# recipe with attribution.
#
# Container exposes port 80 (matches upstream EXPOSE). The host-side mapping
# to 9680 is performed by docker-compose.service.yml in this directory.

# --- Fetch stage: pull pinned upstream source -------------------------------
# alpine/git is digest-pinned to lock the toolchain.
# Digest verified 2026-05-21 against registry-1.docker.io/v2/alpine/git for
# tag v2.49.0 (multi-arch OCI index).
FROM alpine/git:v2.49.0@sha256:b0f8f1fe681f50e35fd4e80052035d04e0c5908fda57a11b08e645aeaaebfc62 AS fetch

ARG IPTVNATOR_SHA=b2909a11863cc46de250d13a0c5180dc49b997c6

WORKDIR /src
RUN git init . \
 && git remote add origin https://github.com/4gray/iptvnator.git \
 && git fetch --depth 1 origin "${IPTVNATOR_SHA}" \
 && git checkout FETCH_HEAD \
 && echo "iptvnator pinned commit:" && git rev-parse HEAD \
 && test "$(git rev-parse HEAD)" = "${IPTVNATOR_SHA}" \
 && rm -rf .git

# --- Build stage: upstream docker/Dockerfile verbatim (attribution above) ---
# node:22-alpine — pinned by digest for reproducibility.
# Digest verified 2026-05-21 against registry-1.docker.io/v2/library/node for
# tag 22-alpine (multi-arch OCI index, last pushed 2026-05-14).
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS build

RUN apk add --no-cache python3 make g++ git

WORKDIR /usr/src/app

# Stage the upstream tree in. Order matches upstream Dockerfile so the
# layer cache behaves identically.
COPY --from=fetch /src/.npmrc ./
COPY --from=fetch /src/package.json /src/pnpm-lock.yaml ./
COPY --from=fetch /src/patches ./patches

RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts

COPY --from=fetch /src/. ./

RUN pnpm nx build web --configuration=pwa
RUN pnpm nx build web-backend

# --- Runtime stage: upstream runtime image verbatim -------------------------
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920

RUN apk add --no-cache gettext nginx wget

WORKDIR /opt/iptvnator

ENV PORT=3000
ENV BACKEND_URL=/api
# CLIENT_URL is the public origin the PWA will be served from. For the
# IPTV-Hub VPS this becomes https://iptvnator.<DEPLOY_DOMAIN>; defaulted
# to the host-bind URL so a bare `docker run` still works.
ENV CLIENT_URL=http://localhost:9680

COPY --from=build /usr/src/app/dist/apps/web /usr/share/nginx/html
COPY --from=build /usr/src/app/dist/apps/web-backend ./web-backend
COPY overrides/iptvnator-daveai-vault-bootstrap.js /usr/share/nginx/html/iptvnator-daveai-vault-bootstrap.js
COPY overrides/app-config.js /usr/share/nginx/html/assets/app-config.js
COPY --from=fetch /src/docker/nginx.conf /etc/nginx/http.d/default.conf.template
COPY --from=fetch /src/docker/docker-entrypoint.sh /usr/local/bin/iptvnator-entrypoint

RUN sed -i 's#assets/app-config.js"#assets/app-config.js?v=20260527-v6"#' /usr/share/nginx/html/index.html \
 && sed -i 's#<script src="polyfills#<script src="iptvnator-daveai-vault-bootstrap.js?v=20260527-v6"></script><script src="polyfills#' /usr/share/nginx/html/index.html \
 && sed -i 's#<base href="./">#<base href="/">#' /usr/share/nginx/html/index.html \
 && cp /usr/share/nginx/html/safety-worker.js /usr/share/nginx/html/ngsw-worker.js \
 && node -e 'const fs=require("node:fs"); const root="/usr/share/nginx/html"; const oldText="addPlaylistRecentlyViewed(e,n){if(!e)throw new Error(\"Playlist ID is required\");return this.getPlaylistById(e).pipe(De(i=>{let o=new Date().toISOString(),s=Array.isArray(i.recentlyViewed)?i.recentlyViewed:[]"; const newText="addPlaylistRecentlyViewed(e,n){if(!e)throw new Error(\"Playlist ID is required\");return this.getPlaylistById(e).pipe(De(i=>{if(!i)return K([]);let o=new Date().toISOString(),s=Array.isArray(i.recentlyViewed)?i.recentlyViewed:[]"; let patched=0; for (const name of fs.readdirSync(root)) { if (!/^chunk-.*\\.js$/.test(name)) continue; const file=root+"/"+name; const source=fs.readFileSync(file,"utf8"); if (!source.includes(oldText)) continue; fs.writeFileSync(file, source.replace(oldText,newText)); patched += 1; } if (patched !== 1) throw new Error("Expected to patch 1 IPTVnator recent-history bundle, patched "+patched);' \
 && node -e 'const fs=require("node:fs"); const root="/usr/share/nginx/html"; const oldText="let a=jn(o,Un(kn.readwrite,e,c=>i.error(c))).objectStore(e),l=a.put(n);l.onsuccess=c=>m(this,null,function*(){let d=c.target.result,p=a.get(d);p.onsuccess=v=>{i.next(v.target.result),i.complete()}})}).catch(o=>i.error(o))})}bulkPut"; const newText="let a=jn(o,Un(kn.readwrite,e,c=>i.error(c))).objectStore(e);if(e===\\\"playlists\\\"&&(!n||!n._id)){i.next(n),i.complete();return}let l=a.put(n);l.onsuccess=c=>m(this,null,function*(){let d=c.target.result,p=a.get(d);p.onsuccess=v=>{i.next(v.target.result),i.complete()}})}).catch(o=>i.error(o))})}bulkPut"; let patched=0; for (const name of fs.readdirSync(root)) { if (!/^chunk-.*\\.js$/.test(name)) continue; const file=root+"/"+name; const source=fs.readFileSync(file,"utf8"); if (!source.includes(oldText)) continue; fs.writeFileSync(file, source.replace(oldText,newText)); patched += 1; } if (patched !== 1) throw new Error("Expected to patch 1 IPTVnator IndexedDB update bundle, patched "+patched);' \
 && grep -q 'iptvnator-daveai-vault-bootstrap.js' /usr/share/nginx/html/index.html \
 && grep -q '<base href="/">' /usr/share/nginx/html/index.html \
 && chmod +x /usr/local/bin/iptvnator-entrypoint

# Upstream EXPOSEs 80; we keep the same so the upstream entrypoint and
# nginx config Just Work. The 80 -> 9680 mapping is in compose, not here.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://127.0.0.1/api/health >/dev/null || exit 1

CMD ["iptvnator-entrypoint"]
