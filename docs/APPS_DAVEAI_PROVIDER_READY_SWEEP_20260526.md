# apps.daveai.tech Provider-Ready Visual Sweep — 2026-05-26

Status: `13/13 passed` (`2026-05-27T01:08:16.007Z`)

## Scope

Authenticated Playwright sweep against the live DaveTV launcher/provider-ready
surface using a short-lived QA auth-gate session. The session was removed after
the sweep and the auth gate was restarted.

Artifact directory:

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\apps-provider-ready-sweep-20260526
```

Latest summary:

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\apps-provider-ready-sweep-20260526\summary.json
```

## Gates

Each app had to satisfy:

- reached the protected app URL with HTTP 200 after auth;
- did not show the login page;
- did not show a client-side exception or application error;
- did not render raw provider credential-shaped URLs; and
- produced no Playwright `pageerror`.

## Passing apps

- `iptv-player-zero`
- `nuvio`
- `iptvnator`
- `extreme-infinitv`
- `wizju-iptv-player`
- `xstream-player`
- `smart-iptv-web`
- `stalker-ui`
- `iptv-stream`
- `iptv-restream`
- `open-tv`
- `ynotv`
- `tvapp`

## Repairs Made During Sweep

- Switched launcher URLs for root-bundle apps to dedicated subdomains so their
  absolute asset paths resolve from the correct app root:
  `extreme-infinitv`, `wizju-iptv-player`, `stalker-ui`, `open-tv`, `ynotv`.
- Added the Stalker UI hosted `webapis` stub and patched the deployed script
  path from `$WEBAPIS/webapis/webapis.js` to `/webapis/webapis.js`.
- Hardened NuvioWeb for DaveAI hosting:
  - forced English first-run state;
  - cleaned stale `apps.daveai.tech` provider-vault addon URLs from
    `installedAddonUrls`;
  - rewrote legacy cross-origin provider-vault requests to same-origin
    `/api/provider-vault/*`;
  - stubbed the optional hosted avatar RPC with a local empty catalog so the
    web build no longer logs a Supabase-style `405`.
- Repaired NuvioWeb live playback after deep Playwright audit:
  - provider-vault live-channel metadata now includes a playable one-episode
    `videos` entry, which is what the upstream Nuvio `type: tv` route requires
    before its Play action requests streams;
  - Apollo Group TV and XtremeHD both play USA AMC through same-origin
    `/api/provider-vault/stream` plus segment proxy requests;
  - both providers reached `video.readyState=4` with zero page/console errors;
  - live playback duration now shows `Live` instead of `Infinity:NaN:NaN`;
  - proof: `deploy/apps/nuvioweb/PROOF-20260526.md`.
- Updated YnoTV to trust provider-vault `item.url` values before rebuilding
  stream URLs, fixing empty-id stream requests against Apollo/XtremeHD rows.
- Added the provider-vault image proxy in Smart IPTV Web so apps that render
  provider logos use safe same-origin `/api/provider-vault/image?src=...`
  URLs instead of browser-blocked mixed-content HTTP poster URLs.
- Added TVapp as a provider-ready hosted player with Apollo/XtremeHD catalog
  tabs, provider-vault stream playback, and a fresh 13-app launcher sweep.
- Repaired IPTVnator after the sweep:
  - deep links now use root assets via `<base href="/">`;
  - runtime config pins `BACKEND_URL` to same-origin `/api`;
  - stale direct Apollo/XtremeHD Xtream workspaces migrate to safe DaveAI vault
    playlists;
  - stale direct Xtream rows are cleaned from both localStorage and IndexedDB;
  - hosted service-worker caches are cleared with the Angular safety worker so
    older browsers stop serving the broken app shell;
  - provider-vault rows now include playlist identity and recent-history guards
    so playback has zero console errors;
  - XtremeHD playback proof loaded `2600 channels` and played the first stream
    with no console or page errors.
- Repaired IPTVnator again after user review:
  - bumped the DaveAI bootstrap to `20260526-v5` so stale browsers fetch the
    newest provider-vault handoff;
  - hardened stale `/workspace/xtreams/...` routes so XtremeHD direct portal
    pages redirect to the safe vault playlist before Angular renders
    `Portal unavailable`;
  - guarded legacy IndexedDB cleanup so DaveAI vault playlists are never
    deleted as old direct Xtream profiles;
  - verified Apollo Group TV and XtremeHD playback with
    `video.readyState=4`, same-origin `/api/provider-vault/stream` responses,
    no console/page errors, and no credential-shaped browser text;
  - proof: `deploy/apps/iptvnator/PROOF-20260526.md`.
- Repaired IPTV Player Zero after user review:
  - hosted DaveTV build now runs as free/pro unlocked with lifetime features
    active and no payment/Stripe/trial copy;
  - Apollo Group TV and XtremeHD provider buttons load through
    provider-vault, each with `2200` catalog rows (`1200` live, `500` movies,
    `500` series);
  - fixed hosted web Tauri/store gaps and defensive data guards that caused
    `.map`/iteration crashes while provider catalogs loaded;
  - playback proof loaded USA AMC for both Apollo and XtremeHD through
    same-origin `/api/provider-vault/stream` plus segment proxy URLs;
  - proof: `docs/IPTV_PLAYER_ZERO_FREE_PROVIDER_FIX_20260526.md`.
- Re-verified and polished xstream-player after user review:
  - English login/dashboard surface remains intact (`Welcome`, provider buttons,
    manual Xtream fallback);
  - Apollo Group TV and XtremeHD both load through provider-vault with client
    auth storing only `providerId`, not raw host/user/password;
  - both providers expose live/VOD/series categories (`334`/`54`/`87`) and
    catalog totals (`14035` live, `55719` movies, `32199` series);
  - live playback for both providers reaches `video.readyState=4` through
    `/api/provider-vault/stream` and `/api/provider-vault/segment`;
  - provider artwork now uses same-origin `/api/provider-vault/image?src=...`
    so Chrome no longer blocks mixed-content HTTP poster images;
  - proof:
    `deploy/apps/xstream-player/PROOF-20260526.md`.
- Re-verified and polished Smart IPTV Web after user review:
  - Apollo Group TV and XtremeHD both load through provider-vault with client
    storage containing only `providerId`, not raw provider host/user/password;
  - both providers load `1200` live, `500` movies, and `500` series rows;
  - live playback selected USA AMC for both providers and reached
    `video.readyState=4` through same-origin `/api/provider-vault/stream` plus
    segment proxy requests;
  - player buffering controls now drive the actual HLS/MPEG-TS engines:
    `300s` default buffer target, `256MB` default buffer size, low-latency mode
    off for smoother long-buffer playback, and MPEG-TS stash buffering enabled;
  - proof:
    `deploy/apps/smart-iptv-web/PROOF-20260526.md`.
- Repaired IPTV Restream after deep provider playback audit:
  - provider-vault rows now preserve the vault-supplied safe stream URL before
    trying to synthesize a stream URL from item ids;
  - empty `id=` stream calls are gone for Apollo Group TV and XtremeHD;
  - provider-vault artwork is rendered as local initials badges to avoid noisy
    broken external image/proxy fetches in the compact horizontal channel list;
  - Apollo Group TV and XtremeHD both reached `video.readyState=4` at
    `1920x1080` through same-origin `/api/provider-vault/stream` requests with
    non-empty ids and HTTP `200` responses;
  - proof:
    `deploy/apps/iptv-restream/PROOF-20260526.md`.

## Latest Sweep Notes

The latest sweep was rerun after the IPTV Player Zero, IPTVnator, and
xstream-player repairs. It passed all `13` launcher apps with:

- `0` login-page regressions;
- `0` client-side exception/application-error screens;
- `0` provider credential-shaped text leaks;
- `0` Playwright `pageerror` events.

It was rerun again after the xstream-player artwork/proof polish and still
passed all `13` launcher apps with `0` login regressions, `0` client-side
exception/application-error screens, `0` provider credential-shaped text leaks,
`0` Playwright `pageerror` events, and `0` captured console errors.

It was rerun again after the IPTVnator v5 stale-XtremeHD repair and passed all
`13` launcher apps with the same zero-regression result.

It was rerun again after the IPTV Player Zero v14 free/pro + provider playback
proof and passed all `13` launcher apps with the same zero-regression result.

It was rerun again after the NuvioWeb live-playback repair and passed all
`13` launcher apps with the same zero-regression result.

It was rerun again after the IPTV Restream empty-id/provider-artwork repair and
passed all `13` launcher apps with the same zero-regression result.

## Console Notes

The latest sweep recorded zero `pageerror` events and zero captured console
errors across all 13 apps. The previous `iptv-restream` resource-load console
noise was cleared during that player's deep pass.
