# IPTV Stream Strict Provider Proof - 2026-05-29

Status: `ACCEPTED`

## Target

- Hosted app: `https://iptv-stream.daveai.tech/`
- Proof script: `scripts/iptv-stream-provider-playback-proof.mjs`
- Artifact directory:
  `C:\Users\Admin\Downloads\VPS\_visual_artifacts\iptv-stream-strict-20260529071220`

## What Changed

- The strict proof now seeds IPTV Stream with the DaveTV provider-vault
  `profile=english` catalog instead of the raw Apollo/XtremeHD upstream order.
- The proof now requires real playback state, not only a rendered page:
  `readyState >= 2`, nonzero dimensions, advancing `currentTime`,
  `muted=false`, `volume=1`, and decoded audio bytes.
- The Apollo first row is now English/US-curated instead of raw international
  marker rows.

## Live Proof

Apollo Group TV:

- First visible row: `|US| NBC 9 HD [ABILENE]`
- Catalog: `1789 VAULT STREAMS INDEXED`
- Playback: `readyState=4`, `currentTime=4.255454`, `1280x720`
- Audio: `muted=false`, `volume=1`, `audioDecodedBytes=94799`
- Media: same-origin `/api/provider-vault/aac-hls`

XtremeHD:

- First visible row: `USA AMC`
- Catalog: `1791 VAULT STREAMS INDEXED`
- Playback: `readyState=4`, `currentTime=9.538914`, `1920x1080`
- Audio: `muted=false`, `volume=1`, `audioDecodedBytes=77898`
- Media: same-origin `/api/provider-vault/aac-hls`

Both providers:

- `0` page errors
- `0` console errors
- `0` blocking failed requests
- No raw provider host/user/password text exposed in the browser

## Notes

IPTV Stream is a lightweight StreamOS-style live TV player. Its current
accepted surface is provider-separated live playback through seeded
provider-vault sources. It does not expose full movie/series browsing like
XStream or Zero Player, so this acceptance covers its live-player capability
rather than claiming a VOD catalog surface the app does not have.
