# ynotv

`ynotv` is a feature-rich React/Tauri IPTV player with strong live/VOD UI, but
the upstream hosted build tries to use native Tauri/mpv paths and desktop
Xtream URL construction. The DaveTV hosted version uses the files in
`static-web-overrides/` to render a browser-safe provider-vault mode.

## DaveAI provider-vault integration

- Apollo Group TV and XtremeHD load from `/api/provider-vault/catalog`.
- Live channels and movies use safe same-origin `/api/provider-vault/stream`
  URLs.
- Apollo Group TV and XtremeHD rows are interleaved so both providers are
  visible and playable at the top of the catalog.
- Clicking the active card retries playback, which recovers browsers that
  buffered the auto-selected first channel but blocked autoplay.
- The browser build bypasses Tauri/native source setup when running on
  `apps.daveai.tech`.
- Playback uses HTML5 video plus HLS.js with larger buffers:
  `maxBufferLength=180`, `maxMaxBufferLength=600`, `backBufferLength=90`.
- The production hosted artifact is built with `VITE_DAVETV_HOSTED=1` so
  desktop Xtream URL-building chunks are not emitted.

## Rebuild notes

Apply `static-web-overrides/` over the upstream `ynotv` source, then run:

```sh
pnpm install --prod=false --force --config.confirmModulesPurge=false
VITE_DAVETV_HOSTED=1 pnpm --filter @ynotv/ui exec vite build
```

The static output is `packages/ui/dist`.
