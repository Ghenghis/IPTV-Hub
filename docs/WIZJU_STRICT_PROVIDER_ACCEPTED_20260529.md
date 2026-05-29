# Wizju Strict Provider Accepted - 2026-05-29

## Scope

Wizju IPTV Player was revalidated under the stricter fleet standard:
provider separation, English-curated provider rows, provider-vault URLs only,
catalog/card population, and real playback with unmuted video.

## Fix

- Provider vault catalog requests now use the shared `profile=english` filter.
- Apollo live URLs are normalized to the browser-safe provider-vault HLS route.
- Marker rows such as `####` are dropped before they reach the UI.
- The proof checks safe provider-vault URLs, no raw credential leaks, and
  unmuted playback with advancing current time.

## Live Proof

Artifact directory:

`C:\Users\Admin\Downloads\VPS\_visual_artifacts\wizju-strict-20260529T055341`

Proof command:

`node scripts/wizju-provider-playback-proof.mjs`

Result: `ok: true`

Verified cases:

- Apollo Group TV
  - 3,800 provider-vault items persisted
  - first rows are English/US curated, for example `|US| NBC 9 HD [ABILENE]`
  - playback readyState `4`, muted `false`, volume `1`
  - currentTime advanced to `6.009`
  - video dimensions `1280x720`
- XtremeHD
  - 3,800 provider-vault items persisted
  - first rows include `USA AMC`
  - playback readyState `4`, muted `false`, volume `1`
  - currentTime advanced to `31.369`
  - video dimensions `1920x1080`

No page errors, console errors, bad provider responses, or raw provider
credential leaks were recorded.
