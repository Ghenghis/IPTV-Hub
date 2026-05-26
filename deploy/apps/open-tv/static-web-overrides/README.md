# Open TV DaveAI overrides

Copy these files over the upstream `open-tv` source before building the hosted
DaveTV static web version.

The overlay adds:

- DaveTV provider-vault catalog loading for Apollo Group TV and XtremeHD;
- browser-safe fallback when Tauri APIs are unavailable;
- HLS.js HTML5 playback overlay for hosted streams; and
- larger HLS buffer settings for steadier playback.

No provider credentials are stored in this repo or bundled into the browser.
