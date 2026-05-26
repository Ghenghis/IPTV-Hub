# ynotv DaveAI overrides

Copy these files over the upstream `ynotv` source before building the hosted
DaveTV static web version.

The overlay adds:

- a hosted `ProviderVaultWebMode` for Apollo Group TV and XtremeHD;
- browser-safe DaveTV catalog and stream URLs;
- English hosted-player chrome;
- HLS.js playback with larger buffers for steadier live/movie playback; and
- a `VITE_DAVETV_HOSTED=1` build path that excludes desktop/Tauri chunks from
  the deployed web artifact.

No provider credentials are stored in this repo or bundled into the browser.
