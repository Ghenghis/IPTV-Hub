# XStream Timebar Sync Accepted - 2026-05-29

## Defect

User-reported XStream VOD playback could show an impossible control-bar clock,
for example `00:18 / 00:10`, where current playback time exceeded total
duration. The same bad duration could also poison watch-progress percentages.

## Fix

- `VideoPlayer` now prefers known movie/episode metadata duration when present.
- Provider-vault HLS/transcode rolling-manifest durations are treated as
  unreliable instead of being shown as a false VOD total.
- Seek/progress UI is clamped so the red bar and range input cannot exceed
  100%.
- Watch-progress persistence normalizes clocks so `duration >= progress`.
- Movie and series watch pages pass known duration into the player.

## Live Proof

Artifact directory:

`C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-timebar-sync-20260529T033505`

Proof command:

`node scripts/xstream-timebar-sync-proof.mjs`

Result: `ok: true`

Verified cases:

- Apollo movie `/dashboard/watch/movie/817595`
  - UI: `08:43 / 1:41:00`
  - `data-current-time`: `523.896`
  - `data-duration`: `6060`
  - progress percent: `8.65`
  - video readyState `4`, muted `false`, volume `1`, decoded audio present
- Apollo series `/dashboard/watch/series/10553`
  - UI: `00:12 / 1:03:51`
  - `data-current-time`: `12.739`
  - `data-duration`: `3831`
  - progress percent: `0.33`
  - video readyState `4`, muted `false`, volume `1`, decoded audio present

No page errors, console errors, or failed requests were recorded after filtering
known non-playback background sync aborts.
