# iptv-player-zero

Clean static DaveTV deployment package for IPTV Player Zero 1.7.99.

## Live DaveAI / DaveTV State

- Live URL: `https://apps.daveai.tech/iptv-player-zero/`
- VPS app path: `/var/www/davetv/apps/iptv-player-zero`
- Launcher symlink: `/var/www/davetv/launcher/iptv-player-zero`
- Launcher catalog: `/var/www/davetv/launcher/apps.json`
- Provider proxy route: `https://apps.daveai.tech/api/iptv-proxy`

The live app is served by the DaveTV launcher/auth layer, not by the IPTV-Hub
container orchestrator. This package intentionally does not add a persistent
host-port compose fragment because the `9600-9879` app port band is already
allocated and `9880-9899` is reserved infrastructure.

## What Is Included

- `static/` is the cleaned browser bundle currently deployed to
  `apps.daveai.tech`.
- `provider-proxy/route.ts` is the Next.js proxy route used by the DaveTV
  Smart IPTV service to support Apollo Group TV, XtremeHD, and other Xtream /
  M3U / XMLTV providers through the authenticated DaveTV edge.
- `Dockerfile` can serve the static bundle locally or in a future orchestrated
  slot, but it is not the current production path.

## Provider Support

The browser shim supports:

- Xtream Codes API auth through `player_api.php`.
- M3U generation through `get.php?type=m3u_plus`.
- XMLTV EPG through `xmltv.php`.
- Live, VOD, series, and catch-up URL builders.
- M3U parsing with EPG headers, catch-up metadata, VLC-style user-agent and
  referrer hints.
- Browser playback through `/api/iptv-proxy` so provider media and playlists
  are fetched server-side behind DaveTV auth.
- DaveAI provider-vault quickstart for Apollo Group TV and XtremeHD. When Dave
  is signed into `apps.daveai.tech`, a compact provider panel can import a safe
  starter catalog into IndexedDB. Imported rows contain only DaveAI
  `/api/provider-vault/stream` URLs; raw provider usernames/passwords stay
  server-side.

No provider credentials are committed here. Users must enter their own provider
host, username, and password in the app for manual accounts, or use the DaveAI
provider-vault buttons for configured managed accounts.

## Compliance Notes

- The old `unlock.js` bypass script is not included.
- The hosted DaveTV browser license shim reports an active lifetime/pro state
  with `purchaseRequired: false`; all payment/Stripe/trial copy is removed from
  the hosted build.
- The active app and proxy keep provider credentials redacted in errors.
- The active proxy rewrites HLS/M3U playlist media lines back through
  `/api/iptv-proxy`, but leaves XMLTV content untouched.

## Verification

Latest Codex proof from the live VPS deployment:

- apps route unauthenticated: `302` behind DaveTV auth.
- proxy route unauthenticated: `302` behind DaveTV auth.
- active app scan: no `/api/upload-image`, no `unlock.js`.
- proxy direct authenticated smoke: M3U rewrite, binary stream pass-through,
  XMLTV pass-through.
- visual proof: desktop and mobile screenshots clean, no clipping, only benign
  console info logs.
- provider-vault quickstart/playback proof: live authenticated Playwright check
  imports Apollo Group TV and XtremeHD, verifies `2200` safe catalog rows per
  provider, clicks `USA AMC`, confirms same-origin provider-vault stream and
  segment responses, and waits for the browser video element to reach
  `readyState=4`.

Proof archive:

- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-shim-polish-proof-2026-05-26T1553\summary.json`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-provider-vault-proof-20260526\summary.json`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-provider-vault-proof-20260526\import-smoke.json`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-provider-vault-proof-20260526\ipz-provider-quickstart.png`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-provider-vault-proof-20260526\ipz-provider-import-smoke.png`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\zero-player-provider-proof-20260526\summary.json`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\zero-player-provider-proof-20260526\zero-player-apollo-playback.png`
- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\zero-player-provider-proof-20260526\zero-player-xtremehd-playback.png`
- `C:\Users\Admin\Downloads\VPS\staging\iptv-player-zero-clean-web-final-20260526T1553.zip`
- VPS backup: `/var/backups/daveai-apps/iptv-player-zero-provider-compat-final-20260526T154233Z.tgz`
- VPS backup: `/var/backups/daveai-apps/iptv-player-zero-before-provider-vault-20260526T1746Z.tgz`
- VPS backup: `/var/backups/daveai-apps/iptv-player-zero-before-provider14-20260527T000508Z.tgz`

## Local Static Build

```sh
docker build -t iptv-hub-iptv-player-zero:static ./deploy/apps/iptv-player-zero
docker run --rm -p 8080:8080 iptv-hub-iptv-player-zero:static
```

Then open `http://127.0.0.1:8080/`.
