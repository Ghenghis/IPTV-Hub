# open-tv

Open TV is a strong Angular/Tauri IPTV player with good Xtream/M3U UX, but the
upstream app expects native Tauri commands and mpv playback. The hosted
DaveTV build uses the files in `static-web-overrides/` to make it browser-safe.

## DaveAI provider-vault integration

- Apollo Group TV and XtremeHD load from `/api/provider-vault/catalog`.
- Live channels and movies use safe same-origin `/api/provider-vault/stream`
  URLs.
- Vault-provided stream URLs are trusted first so rows with provider-safe URLs
  do not get rebuilt into empty-id playback requests.
- Apollo Group TV and XtremeHD rows are interleaved so both providers are
  visible and playable at the top of the catalog.
- The browser build bypasses native Tauri source setup when running without
  `window.__TAURI_INTERNALS__`.
- Playback opens in an HTML5/HLS.js overlay instead of calling native `mpv`.
- HLS.js is configured with larger buffers:
  `maxBufferLength=180`, `maxMaxBufferLength=600`, `backBufferLength=90`.

## Rebuild notes

Apply `static-web-overrides/` over the upstream `open-tv` source, run:

```sh
npm install --include=dev --legacy-peer-deps
npx ng build
```

The static output is `dist/open-tv/browser`.
