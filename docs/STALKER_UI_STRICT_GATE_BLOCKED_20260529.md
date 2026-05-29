# Stalker UI Strict Gate - BLOCKED_APP - 2026-05-29

Status: `BLOCKED_APP`

Primary artifact:

- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\stalker-ui-strict-after7-20260528231701\summary.json`

What improved:

- Catalog requests now use `profile=english`.
- Raw upstream marker rows such as `#### DAZN Canada ####` are filtered.
- Provider-vault URL detection now accepts all `/api/provider-vault/*` playback routes, not only `/stream`.
- Apollo `/api/provider-vault/aac-hls` URLs are no longer incorrectly wrapped as legacy `live.m3u8?cmd=...` URLs.
- The hosted build now uses an inline browser-safe `webapis/tizen` stub instead of requesting a missing/protected `$WEBAPIS/webapis/webapis.js`.

Proof result:

- Apollo Group TV now reaches real playback with audio:
  - Channel: `|US| NBC 9 HD [ABILENE]`
  - `readyState: 4`
  - `currentTime: 16.066199`
  - `videoWidth: 1280`
  - `videoHeight: 720`
  - `muted: false`
  - `volume: 1`
  - `audioDecodedByteCount: 318415`
- XtremeHD did not pass strict audio:
  - Channel: `USA AMC`
  - `readyState: 4`
  - `currentTime: 82.107935`
  - `videoWidth: 1920`
  - `videoHeight: 1080`
  - `muted: false`
  - `volume: 1`
  - `audioDecodedByteCount: 0`

Decision:

Do not mark Stalker UI accepted. It is repaired enough to show English provider rows and Apollo playback, but it still needs player-side provider/channel selection improvements and XtremeHD audio-positive row handling before it can meet the fleet acceptance standard.

Next action when this player returns to the front of the queue:

1. Add provider mode controls or deterministic provider/category selection so Apollo and XtremeHD are not mixed under autoplay.
2. Probe/filter XtremeHD rows before playback and skip no-audio channels.
3. Re-run live plus VOD/series card/artwork gates after provider switching is stable.
