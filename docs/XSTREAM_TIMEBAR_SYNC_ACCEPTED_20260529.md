# XStream Timebar Sync Accepted - 2026-05-29

## Defect

User-reported XStream VOD playback could show an impossible control-bar clock,
for example `00:18 / 00:10`, where current playback time exceeded total
duration. The same bad duration could also poison watch-progress percentages.

## Fix

- `VideoPlayer` now prefers known movie/episode metadata duration when present.
- Provider-vault HLS/transcode rolling-manifest durations are treated as
  unreliable instead of being shown as a false VOD total.
- Watch-progress persistence normalizes clocks so `duration >= progress`.
- Movie and series watch pages save known movie/episode duration with progress
  so stale short transcode windows cannot poison resume rows.

## Live Proof

Artifact directory:

`C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-timebar-sync-20260529062732`

Proof command:

`node scripts/xstream-timebar-sync-proof.mjs`

Result: `ok: true`

Verified cases:

- Apollo movie `/dashboard/watch/movie/8479`
  - UI did not show fake `/ 00:10`
  - video currentTime: `31.930`
  - range max: `9002`
  - progress percent: `0.35`
  - video readyState `4`, muted `false`, volume `1`, decoded audio present
- XtremeHD movie `/dashboard/watch/movie/2016459`
  - UI did not show fake `/ 00:10`
  - video currentTime: `13.710`
  - range max: `6060`
  - progress percent: `0.22`
  - video readyState `4`, muted `false`, volume `1`, decoded audio present
- Apollo series `/dashboard/watch/series/10553`
  - UI did not show fake `/ 00:10`
  - video currentTime: `13.635`
  - range max: `3831`
  - progress percent: `0.35`
  - video readyState `4`, muted `false`, volume `1`, decoded audio present

No page errors or console errors were recorded.
