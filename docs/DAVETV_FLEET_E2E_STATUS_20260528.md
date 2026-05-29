# DaveTV Fleet E2E Status - 2026-05-28

This file replaces the older 2026-05-27 fleet proof as the working truth for
the stricter player-by-player repair pass.

## Acceptance Standard

A player is not `ACCEPTED` until Playwright proves all of these against the live
hosted app:

- Apollo Group TV and XtremeHD are separate providers, not one merged stale list.
- If combined browsing exists, every row/card is tagged with provider identity.
- Live, movie, and series catalog data populate with names, categories, counts,
  and usable artwork or controlled fallbacks.
- At least one live stream, one movie, and one series episode play through the
  provider vault with `paused=false`, `muted=false`, `volume>0`, advancing
  `currentTime`, and decoded audio bytes where Chromium exposes them.
- Dead upstream streams show a friendly unavailable state, not raw demuxer,
  chunk-load, format, or JavaScript errors.
- The UI stays English-only and does not expose provider credentials.
- Screenshots and JSON summaries are saved under
  `C:\Users\Admin\Downloads\VPS\_visual_artifacts\...`.

## Current Matrix

| Player | Current status | Strict proof | Notes |
| --- | --- | --- | --- |
| IPTV Player Zero | `ACCEPTED` | `zero-player-autoload-direct31-20260528T232800`; `zero-player-full-direct31-20260528T234000`; `zero-player-combined-direct31-20260528T233500` | Separate Apollo/XtremeHD plus explicit combined tagged mode, free/unlocked UI, stale fatal recovery, fast provider import, live playback with unmuted video. |
| xstream-player | `ACCEPTED` | `xstream-combined-only-20260528T200111`; `xstream-separated-only-20260528T200704`; `xstream-live-playback-strict-20260528T202536`; `xstream-movie-playback-20260528T201124`; `xstream-series-playback-20260528T211000`; `xstream-timebar-offset-proof-20260529081032` | Separate Apollo/XtremeHD, combined tagged browsing, live/movie/series cards, live/movie/series playback with decoded audio, route/chunk repairs, source-timestamp-normalized VOD controls, and proof-mode guard against verification-run watch-progress pollution. |
| IPTVnator | `ACCEPTED` | `iptvnator-strict-v15-*` | Separate Apollo/XtremeHD, English profile, safe Apollo HLS-shaped fallback, XtremeHD route fixed, unmuted UI playback proof. |
| Smart IPTV Web | `ACCEPTED` | `smart-iptv-web-strict-20260528T152122` | Apollo/XtremeHD/Combined Tagged modes, English profile, HLS route classification fixed, live playback readyState 4 unmuted. |
| Nuvio | `BLOCKED_APP` | `nuvio-play-debug-20260529Tnow` | English catalog and marker filtering repaired, but Nuvio direct Play creates a video element without requesting the provider-vault stream. See `docs/NUVIO_STRICT_GATE_BLOCKED_20260529.md`. |
| IPTV Restream | `BLOCKED_APP` | `iptv-restream-strict-final-20260528223954` | Apollo passes strict playback/audio. XtremeHD loads provider rows but did not produce one clean row with advancing video plus decoded audio, and later candidates emitted provider-vault 404 console errors. See `docs/IPTV_RESTREAM_STRICT_GATE_BLOCKED_20260529.md`. |
| Stalker UI | `BLOCKED_APP` | `stalker-ui-strict-after7-20260528231701` | English catalog/profile and Apollo playback repaired, but XtremeHD strict audio failed and provider switching/autoplay remains brittle. See `docs/STALKER_UI_STRICT_GATE_BLOCKED_20260529.md`. |
| Extreme InfiniTV | `ACCEPTED` | `extreme-infinitv-proof-final-20260529T053621` | English Apollo/XtremeHD catalogs, marker filtering, Apollo HLS-shaped fallback, and live playback proof for both providers with unmuted video. |
| Wizju IPTV Player | `ACCEPTED` | `wizju-strict-20260529T055341` | English Apollo/XtremeHD catalogs, provider-vault URL normalization, marker filtering, 3,800 persisted rows per provider, and live playback proof for both providers with unmuted video. |
| Open TV | `ACCEPTED` | `open-tv-strict-20260529065531` | Combined tagged Apollo/XtremeHD grid, English provider profile, marker filtering, provider-vault HLS normalization, and unmuted playback proof with decoded audio for both providers. |
| IPTV Stream | `ACCEPTED` | `iptv-stream-strict-20260529071220` | Provider-separated live player seeded with English Apollo/XtremeHD catalogs, same-origin provider-vault HLS playback, unmuted video, and decoded audio proof. See `docs/IPTV_STREAM_STRICT_PROVIDER_ACCEPTED_20260529.md`. |
| TVapp | `REVALIDATE` | Pending stricter rerun | Needs full data/artwork/audio proof under stricter standard. |
| YnoTV | `REVALIDATE` | Pending stricter rerun | Needs full data/artwork/audio proof under stricter standard. |

## Provider Feature Target

Each player should support as much of this as its architecture allows:

- Separate provider mode: Apollo-only and XtremeHD-only refresh the catalog from
  that provider.
- Combined mode: show both providers in one catalog, with provider badges on
  cards/rows and no stale cross-provider cache.
- Quality tags: infer and display HD/FHD/UHD/4K/HEVC/H265/720p/1080p/1440p/2K
  from names and metadata when provider data exposes it.
- Catalog exports: provider-specific and combined downloads in M3U, M3U8, JSON,
  and CSV where feasible.
- Playback polish: same-origin provider-vault URLs, browser-safe live wrappers
  for Apollo when needed, large but sane buffers, fast start, unmuted playback,
  and friendly unavailable states for dead upstream media.

## Next Order

1. Re-run TVapp/YnoTV under the
   stricter data/artwork/audio test standard.
2. Apply one focused repair pass per player. If the player still fails, mark it
   `BLOCKED_APP` or `BLOCKED_UPSTREAM` with artifact paths and move to the next
   player instead of looping.
3. Add combined tagged browsing and catalog export features only after the
   player passes separated provider playback.
