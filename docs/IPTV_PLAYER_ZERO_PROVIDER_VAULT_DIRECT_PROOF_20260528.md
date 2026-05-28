# IPTV Player Zero Provider Vault Direct Proof - 2026-05-28

## Verdict

Accepted for the current Zero Player slice.

Playwright proof:

`C:/Users/Admin/Downloads/VPS/_visual_artifacts/zero-player-full-provider-proof-20260528T110501Z/summary.json`

Screenshots:

- `C:/Users/Admin/Downloads/VPS/_visual_artifacts/zero-player-full-provider-proof-20260528T110501Z/zero-player-apollo-full-provider.png`
- `C:/Users/Admin/Downloads/VPS/_visual_artifacts/zero-player-full-provider-proof-20260528T110501Z/zero-player-xtremehd-full-provider.png`

## What Changed

- Zero Player no longer tries to import giant movie/series catalogs into IndexedDB before becoming usable.
- Live rows are bootstrapped locally for fast channel navigation.
- Movie and series categories/lists now use the server-side DaveAI provider vault Xtream API.
- Provider vault playlists are marked as `xtream` UI sources without exposing raw credentials.
- Playback URL construction now uses `/api/provider-vault/stream` for provider-vault live, movie, and series items.
- Paid/pro/Stripe copy remains suppressed; UI is forced English for the hosted build.
- HLS buffer settings remain enlarged for smoother playback.

## Proof Summary

Apollo Group TV:

- Local live/bootstrap rows: 15,103
- Movie categories: 54
- Movies: 55,727
- 2026 movie samples found
- Movie artwork rows: 55,354
- Series categories: 87
- Series: 32,206
- Series artwork rows: 31,494
- Playback: `readyState=4`, unmuted, volume `1`, provider-vault source, no media error
- Stream responses: 17 HTTP 200s

XtremeHD:

- Local live/bootstrap rows: 16,544
- Movie categories: 80
- Movies: 132,469
- 2026 movie samples found
- Movie artwork rows: 131,131
- Series categories: 87
- Series: 32,207
- Series artwork rows: 31,495
- Playback: `readyState=4`, unmuted, volume `1`, provider-vault source, no media error
- Stream responses: 17 HTTP 200s

Negative checks:

- No fatal `Something went wrong`
- No TypeError
- No paid/pro/Stripe/limited-mode copy
- No non-English UI text in the inspected surface
- No page errors
- No console errors

## Remaining Fleet Work

This proof only accepts Zero Player. The rest of the fleet still needs player-by-player visual and playback gates for:

- Card/poster/channel artwork correctness
- Movie, series, and live data population
- Playback readiness
- Unmuted audio state after user gesture
- English-only UI
- No raw debug/error screens
