# Stalker UI Card Artwork Repair - 2026-05-29

Status: `LIVE_AND_MOVIE_ARTWORK_REPAIRED`

Change:

- Provider-vault artwork is now normalized to same-origin `/api/provider-vault/image` URLs before Stalker cards render it.
- Playback routing was not changed.

Live playback proof:

- Artifact: `C:\Users\Admin\Downloads\VPS\_visual_artifacts\stalker-artwork-proof-20260529084327\summary.json`
- Apollo Group TV: `readyState=4`, `muted=false`, `volume=1`, `audioDecodedByteCount=6912`, `image200=1009`.
- XtremeHD: `readyState=4`, `muted=false`, `volume=1`, `audioDecodedByteCount=217207`, `image200=1015`.
- No console errors, page errors, or failed requests.

Movie card proof:

- Artifact: `C:\Users\Admin\Downloads\VPS\_visual_artifacts\stalker-movie-card-artwork-deep2-20260529084930\summary.json`
- Apollo movie grid loaded English movie cards.
- `imageCount=29`, `loadedImages=29`, `proxyImages=28`, `brokenImages=0`.
- Screenshot: `C:\Users\Admin\Downloads\VPS\_visual_artifacts\stalker-movie-card-artwork-deep2-20260529084930\stalker-movies-deep2.png`

Remaining truth:

- This repair directly addresses the reported Stalker card artwork issue and rechecks live playback.
- A separate series-card/episode proof is still needed before marking Stalker UI fully fleet-accepted under the all-surfaces standard.
