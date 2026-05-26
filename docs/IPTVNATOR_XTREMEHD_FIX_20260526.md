# IPTVnator XtremeHD Fix - 2026-05-26

## Summary

`https://iptvnator.daveai.tech/` was failing on deep Xtream workspace URLs because the hosted static build used a relative base href. A direct route such as `/workspace/xtreams/.../vod` loaded module scripts from the nested route path, so nginx returned HTML for JavaScript files and Chromium rejected them.

The hosted app also had an empty runtime config, allowing the PWA to fall back to its upstream backend URL instead of DaveAI's same-origin `/api` proxy.

## Applied Fix

- Forced the hosted base href to `/` so deep links load root assets.
- Added a runtime `assets/app-config.js` override with `BACKEND_URL: '/api'`.
- Cache-busted `assets/app-config.js` and the DaveAI provider bootstrap in the Docker image and live static file.
- Upgraded the DaveAI provider bootstrap to `20260526-v4`.
- Migrated stale direct Apollo/XtremeHD Xtream rows out of localStorage and into a backup key.
- Migrated stale direct Apollo/XtremeHD Xtream rows out of IndexedDB playlist storage as well.
- Redirected stale `/workspace/xtreams/...` provider routes to the safe DaveAI vault playlist route.
- Preempted stale Xtream routes before Angular initializes so the broken workspace path does not flash `Portal unavailable`.
- Disabled the hosted Angular service worker cache path by deploying the Angular safety worker as `ngsw-worker.js`; this clears stale `ngsw:` caches for browsers that had already cached the older app shell.
- Added a provider-vault row `playlistId` and guarded IPTVnator's recent-history IndexedDB update so playback cannot throw on a missing playlist-meta row.
- Kept provider credentials server-side; browser rows use only `/api/provider-vault/*` URLs.

## Proof

Artifacts:

- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\iptvnator-xtremehd-fix-20260526\iptvnator-repro-summary.json`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\iptvnator-xtremehd-fix-20260526\iptvnator-repro.png`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\iptvnator-xtremehd-fix-20260526\iptvnator-playback-summary.json`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\iptvnator-xtremehd-fix-20260526\iptvnator-xtremehd-playback.png`

Verifier result:

- Stale Xtream URL redirects to `/workspace/playlists/daveai-provider-vault-xtremehd/all`.
- XtremeHD vault playlist loads with `2600 channels`.
- Apollo and XtremeHD catalogs both return 200.
- No `Portal unavailable`.
- No page errors.
- No console errors in repro, playback, or stale-state migration proofs.
- Playback proof clicked the first XtremeHD channel and received a `/api/provider-vault/stream` response.
- Video element reached `readyState: 4`, `paused: false`, and had no media error.
- Stale localStorage `xtream-playlists` becomes `[]`.
- Stale IndexedDB direct Xtream row is removed.
- New seed marker is `20260526-v4`.

## Follow-up v5 Repair

After user review, a browser with stale direct Xtream workspace state could
still land on `/workspace/xtreams/.../vod` and show `Portal unavailable`.
The live bootstrap was bumped to `20260526-v5` and now performs a hard handoff
from stale Xtream routes to the DaveAI provider-vault playlist route before
Angular renders the old portal workspace.

The v5 cleanup also excludes rows whose id/source/build marker identify them as
DaveAI provider-vault playlists, so `Apollo Group TV - DaveAI Vault` and
`XtremeHD - DaveAI Vault` are never deleted as legacy direct Xtream profiles.

Latest v5 proof:

- artifact directory:
  `C:\Users\Admin\Downloads\VPS\_visual_artifacts\iptvnator-provider-proof-20260526`;
- stale XtremeHD URL redirects to
  `/workspace/playlists/daveai-provider-vault-xtremehd/all`;
- `BUILD_ID` and seed marker are `20260526-v5`;
- XtremeHD and Apollo Group TV both have `2600` provider-vault rows;
- XtremeHD and Apollo Group TV playback both reached `video.readyState=4`;
- two same-origin `/api/provider-vault/stream` responses returned `200`;
- no `Portal unavailable`, no console/page errors, and no credential-shaped
  browser text.

The full DaveTV launcher sweep was rerun after v5 and passed `13/13` apps.

Latest proof set:

- `iptvnator-repro-summary.json`: `ok=true`, `consoleErrorCount=0`, `pageErrorCount=0`.
- `iptvnator-playback-summary.json`: `ok=true`, `streamResponseCount=1`, `video.readyState=4`, `consoleErrorCount=0`.
- `iptvnator-v3-stale-migration-proof.json`: `ok=true`, `seeded=20260526-v4`, stale row removed, `consoleBad=0`.

## Rollback

Live backup before deployment:

- `/var/backups/daveai-apps/iptvnator-before-xtremehd-fix-20260526T202149Z.tgz`
