# IPTV Restream Strict Gate - BLOCKED_APP - 2026-05-29

Status: `BLOCKED_APP`

Artifact:

- `C:\Users\Admin\Downloads\VPS\_visual_artifacts\iptv-restream-strict-final-20260528223954\summary.json`

What improved:

- Restream now loads the DaveTV provider-vault channel source instead of only the old local demo channel list.
- Apollo Group TV and XtremeHD remain separate playlist selections.
- Provider catalog requests use `profile=english`.
- Marker rows such as `#### ... ####` are filtered out.
- Provider-vault URLs from both `/stream` and `/aac-hls` are treated as DaveTV stream URLs.
- Channel artwork now uses provider logos when exposed by the vault.
- The strict proof checks unmuted volume, blob playback URL, currentTime movement, decoded audio bytes, provider-vault request counts, and console/page errors.

Proof result:

- Apollo Group TV passed strict playback on `|F |US| FOX 15 HD [ABILENE]`.
- Apollo playback evidence: `readyState: 4`, `currentTime: 5.994231`, `advanced: true`, `videoWidth: 1280`, `videoHeight: 720`, `muted: false`, `volume: 1`, `audioDecodedByteCount: 125084`.
- XtremeHD did not produce a single clean strict pass inside the gate.
- XtremeHD `USA AMC` advanced video to `currentTime: 22.08602` at `1920x1080`, but decoded audio stayed `0`.
- XtremeHD `USA American Heroes*` and `USA Animal Planet East UHD*` decoded audio bytes, but did not advance enough in the proof window.
- Later XtremeHD candidate fetches produced provider-vault `404` responses and browser console errors.

Decision:

Do not mark IPTV Restream accepted yet. It is beyond the current one-pass repair budget because it still needs player-side handling for XtremeHD candidate selection, no-audio rows, and dead upstream rows before it can pass the same strict gate as Zero, Smart IPTV Web, IPTVnator, and XStream.

Next action when this player returns to the front of the queue:

1. Add provider-vault probe-based candidate filtering before click/play.
2. Skip rows that are known no-audio or dead upstream instead of letting the browser emit console 404s.
3. Re-run the same strict proof and require one XtremeHD row with advancing video plus decoded audio bytes.
