# Open TV Strict Provider Accepted - 2026-05-29

## Scope

Open TV was revalidated under the stricter fleet standard after the live proof
showed it was loading Apollo marker/non-English rows first and could click a bad
row.

## Fix

- Provider catalog requests now use `profile=english`.
- Apollo live rows are filtered to English/US rows and marker rows such as
  `####` are removed before display.
- Provider-vault playback detection now accepts every `/api/provider-vault/*`
  route, not only `/stream`.
- Apollo live URLs are normalized to the browser-safe provider-vault HLS route.
- The proof now requires unmuted playback, advancing current time, decoded audio
  bytes, provider-vault responses, no raw credentials, and no console/page
  errors.

## Live Proof

Artifact directory:

`C:\Users\Admin\Downloads\VPS\_visual_artifacts\open-tv-strict-20260529065531`

Proof command:

`node scripts/open-tv-provider-playback-proof.mjs`

Result: `ok: true`

Verified cases:

- Apollo Group TV
  - first row: `|US| NBC 9 HD [ABILENE]`
  - playback readyState `4`, muted `false`, volume `1`
  - currentTime advanced to `7.248`
  - decoded audio bytes: `72267`
  - video dimensions `1280x720`
- XtremeHD
  - selected audible row: `USA American Heroes*`
  - playback readyState `4`, muted `false`, volume `1`
  - currentTime advanced to `4.379`
  - decoded audio bytes: `74500`
  - video dimensions `1280x720`

No page errors, console errors, failed requests, or raw provider credential
leaks were recorded.
