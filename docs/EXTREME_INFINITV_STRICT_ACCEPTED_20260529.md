# Extreme InfiniTV Strict Gate Accepted - 2026-05-29

## Result

`ACCEPTED`

Extreme InfiniTV now passes the stricter DaveTV player gate against the live public host:

- Provider separation: Apollo Group TV and XtremeHD are seeded and played as separate provider-vault playlists.
- English profile: first visible Apollo rows are `|US| ...`; XtremeHD rows are `USA ...`.
- No raw upstream marker rows: no `####`, `|AR|`, or `|MULTI|` in the proof body.
- Playback: both providers reached `readyState=4`, unmuted playback, nonzero volume, advancing `currentTime`, and real provider-vault media bytes.
- Console/page/request cleanliness: zero console errors, zero page errors, zero unignored failed requests.
- Credentials: only provider-vault playlist references are used; no provider credentials are exposed by the proof.

## Live Proof

Artifact directory:

`C:\Users\Admin\Downloads\VPS\_visual_artifacts\extreme-infinitv-proof-final-20260529T053621`

Key summary:

| Provider | Selected stream | Video state | Media bytes |
| --- | --- | --- | --- |
| Apollo Group TV | `|US| NBC 9 HD [ABILENE]` | `readyState=4`, `1280x720`, `currentTime=11.6`, `muted=false`, `volume=1` | `3347172` |
| XtremeHD | `USA AMC` | `readyState=4`, `1920x1080`, `currentTime=28.7`, `muted=false`, `volume=1` | `7712831` |

## Fixes

- Forced DaveTV provider catalog requests through `profile=english`.
- Added a one-time `xt_cache` migration sentinel so stale raw Apollo rows are not reused.
- Preserved provider logos where the vault supplies them and filtered raw marker rows.
- Normalized Apollo live `/api/provider-vault/aac-hls` URLs so they advertise as browser HLS:
  `ext=m3u8&sourceExt=ts&video=h264&segment=ts`.
- Hardened the Playwright proof so IndexedDB cleanup cannot hang forever and lazy image aborts during provider switching are treated as navigation artifacts, not stream failures.

## Deploy Evidence

Static bundle deployed to the VPS:

`C:\Users\Admin\Downloads\VPS\_visual_artifacts\extreme-infinitv-dist-20260529T052053.tgz`

VPS backup before deploy:

`/opt/davetv/backups/extreme-infinitv/extreme-infinitv-before-20260529T052053`
