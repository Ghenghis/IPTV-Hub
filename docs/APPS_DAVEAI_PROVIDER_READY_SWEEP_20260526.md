# apps.daveai.tech Provider-Ready Visual Sweep — 2026-05-26

Status: `13/13 passed` (`2026-05-26T20:00:13.611Z`)

## Scope

Authenticated Playwright sweep against the live DaveTV launcher/provider-ready
surface using a short-lived QA auth-gate session. The session was removed after
the sweep and the auth gate was restarted.

Artifact directory:

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\apps-provider-ready-sweep-20260526
```

Summary:

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
  - XtremeHD playback proof loaded `2600 channels` and played the first stream
    with no console or page errors.

## Console Notes

The latest sweep recorded zero `pageerror` events and zero captured console
errors across all 12 apps, including `nuvio`, `iptv-restream`, and `open-tv`.
