# Extreme InfiniTV — IPTV Hub deploy slice

| | |
| --- | --- |
| Catalogue id | `extreme-infinitv` |
| Slot (policy) | **9630** (see [`deploy/PORTS.md`](../../PORTS.md) §3) |
| Host bind | `127.0.0.1:9630` → container `80` |
| Upstream | <https://github.com/infinitel8p/Extreme-InfiniTV> |
| Upstream stack | Astro 6 + Svelte 5 + Tauri 2 (desktop) — pnpm-managed |
| Image | `iptv-hub/extreme-infinitv:1.6.0` (tracks upstream `package.json:version`) |
| Build context | `deploy/apps/extreme-infinitv/` (this directory) |
| Sources | `upstream/` git submodule-style clone of `infinitel8p/Extreme-InfiniTV` |

## What this is — and what it is not

> **This Docker image is the web-preview mode of a desktop-first app.**

Extreme InfiniTV is, primarily, a **Tauri desktop app** that ships through the
Microsoft Store, Google Play, and direct downloads (`.exe` / `.dmg` / `.deb` /
`.rpm` / `.AppImage`) for Windows, macOS, Linux, and Android. Those builds get
the full feature set: in-app Tauri auto-updater, OS-keychain credential
storage, native filesystem access, picture-in-picture, native notifications,
download manager, tray icon, and so on.

This image **does not ship any of that**. It is the mode the upstream README
documents under "Install" as:

> *Web preview — Build with `pnpm build` and serve `dist/` (no auto-update, no
> native features)*

What you get behind the hub's reverse proxy at `https://extreme-infinitv.<your-domain>`:

- The full Astro/Svelte UI — Live TV, Movies, Series, EPG grid, Favorites,
  Recently added, Search, Downloads page, Settings.
- DaveAI provider-vault entries for Apollo Group TV and XtremeHD. The browser
  stores only `davetv-vault://<provider>` playlist references; provider
  credentials remain server-side and catalog/stream calls go through
  `/api/provider-vault/*`.
- Manual Xtream Codes login (host / port / user / pass) and direct `.m3u` /
  `.m3u8` URL playlists remain available for user-supplied providers.
- The HLS / MPEG-TS / Video.js player.
- Spatial-focus navigation for keyboard / D-pad use.

What you do **not** get vs. the native build:

- No in-app Tauri auto-updater. Updates require a host-side rebuild of this
  image against a newer `upstream/` commit. (`upstream/` is a plain clone, so
  `git -C upstream pull && docker compose build extreme-infinitv` is the path.)
- No OS-keychain integration. Xtream credentials live in the browser's
  `localStorage`, not in the OS keychain — losing the browser profile or
  clearing site data wipes them.
- No native filesystem access. The "Downloads" page UI is present but its
  download backend (which on Tauri uses `tauri-plugin-fs` and
  `tauri-plugin-android-fs-api`) is no-op on the web. Offline playback does not
  work.
- No native notifications, tray icon, or window-state persistence.
- No general CORS bypass for arbitrary manually-entered providers. DaveAI's
  built-in Apollo Group TV and XtremeHD entries use the same-origin
  `/api/provider-vault/*` backend proxy and do not expose provider credentials
  in browser storage or URLs.

If any of those gaps are deal-breakers, deploy the native build from
<https://github.com/infinitel8p/Extreme-InfiniTV/releases/latest> on each
client and use this image only as an "anywhere I can reach a browser" fallback.

## Files in this directory

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage build: `node:20-alpine` (with pnpm 10.31.0) compiles `pnpm build` → `dist/`; `nginx:1.27-alpine` serves `dist/` on port 80. |
| `nginx.conf` | SPA fallback (`try_files`) for Astro's client-side router, long-lived caching for `/_astro/`, no-cache on `index.html`. |
| `.dockerignore` | Excludes `upstream/src-tauri/`, `upstream/tests/`, `upstream/docs/`, `upstream/.git`, etc. from the build context so Cargo never enters the picture. |
| `docker-compose.service.yml` | Service fragment merged by `deploy/scripts/generate-stack.sh` into `docker-compose.apps.yml`. Binds host `127.0.0.1:9630` → container `80`. |
| `upstream/` | A plain `git clone --depth=1 https://github.com/infinitel8p/Extreme-InfiniTV.git`. Not a submodule — re-fetch with `git -C upstream pull` to update. |
| `overrides/` | DaveAI-hosted web overlay copied on top of `upstream/` during image build. Adds provider-vault entries/proxy calls and browser-safe version text without mutating the vendored upstream clone. |
| `README.md` | This file. |

## Build pinning rationale

| Pin | Value | Why |
| --- | --- | --- |
| Builder image | `node:22-alpine` | Current Astro requires Node >=22.12.0; alpine is small and the build does not need glibc. |
| pnpm | `10.31.0` (env `PNPM_VERSION`) | Exact value of the `packageManager` field in `upstream/package.json` for v1.6.0. Activated via `corepack prepare`. |
| Runtime image | `nginx:1.27-alpine` | Matches the hub's healthcheck container in `deploy/docker-compose.yml`. |
| Image tag | `1.6.0` | Tracks `upstream/package.json:version`. Bump when re-cloning a newer upstream. |

## Update path

1. `git -C upstream pull --ff-only` (or re-clone to a specific tag).
2. Confirm `upstream/package.json:packageManager` still says `pnpm@10.31.0`; if
   it bumped, update `PNPM_VERSION` in the `Dockerfile` to match.
3. Update the `image:` tag and `iptv-hub.upstream` label to the new version.
4. `docker compose -f ../../docker-compose.yml -f ../../docker-compose.apps.yml build extreme-infinitv`.
5. `docker compose ... up -d extreme-infinitv` to roll the running container.

## Environment variables

None are baked into the image. Runtime configuration (Xtream credentials,
playlist URLs, theme, font scale) is supplied by the user in the browser UI and
persisted to `localStorage`. There are no server-side secrets to provision.
DaveAI-hosted provider-vault entries are the exception: those entries are
available automatically and keep the actual provider credentials in the DaveTV
provider vault rather than in this static app.

## DaveAI provider-vault proof

Verified 2026-05-26:

- `dist/_astro` and the VPS-served bundle contain `davetv-vault://` playlist
  entries for Apollo Group TV and XtremeHD.
- Browser proof against the static build confirmed English UI labels, automatic
  Apollo selection, same-origin `/api/provider-vault/catalog` calls, and no raw
  provider credentials in browser storage.
- Visual artifact:
  `C:/Users/Admin/Downloads/VPS/_visual_artifacts/extreme-infinitv-provider-vault-proof-20260526/`.

Deep playback verified 2026-05-27:

- Live TV now treats same-origin `/api/provider-vault/stream` URLs as
  browser-playable HLS instead of rejecting them as external protocols.
- Provider-vault live-channel order is preserved so the known-good `USA AMC`
  rows are first for Apollo Group TV and XtremeHD.
- Apollo Group TV and XtremeHD both reached `video.readyState=4` at
  `1920x1080` through same-origin `/api/provider-vault/stream` and
  `/api/provider-vault/segment` requests.
- Playwright proof:
  [`PROOF-20260526.md`](./PROOF-20260526.md).

## Health

The image's `HEALTHCHECK` and the compose service's healthcheck both `wget`
`http://127.0.0.1/` inside the container. A healthy state means nginx has
served `dist/index.html` — it does **not** assert that the IPTV provider the
user logs into is reachable.

## Operator caveat — repeat

This is the **web-preview mode of a desktop-first app**. Auto-update and
native features are absent in this Docker deploy. The full app is the
[GitHub Release downloads](https://github.com/infinitel8p/Extreme-InfiniTV/releases/latest)
or the Microsoft Store / Google Play listings linked from the upstream README.
