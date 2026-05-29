# XStream Timebar Sync Accepted - 2026-05-29

## Defect

User-reported XStream VOD playback could show an impossible control-bar clock,
for example `00:18 / 00:10`, where current playback time exceeded total
duration. The same bad duration could also poison watch-progress percentages.

## Fix

- `VideoPlayer` now prefers known movie/episode metadata duration when present.
- Provider-vault HLS/transcode rolling-manifest durations are treated as
  unreliable instead of being shown as a false VOD total.
- Provider media timestamps are normalized to viewer elapsed time. Some
  provider-vault HLS/transcode streams expose a non-zero source PTS as
  `HTMLMediaElement.currentTime`; XStream now subtracts that source offset for
  the clock, progress bar, skip, and seek controls.
- Watch-progress persistence normalizes clocks so `duration >= progress`.
- Movie and series watch pages save known movie/episode duration with progress
  so stale short transcode windows cannot poison resume rows.
- Playwright proof mode (`codexProof=1`) starts playback from `0` and does not
  write watch-progress rows. This prevents verification runs from polluting the
  real user continue-watching state.

## Follow-up Correction

The earlier accepted proof was not enough. A later Avatar episode repro showed
the player could still begin around source timestamp `31:17` while the viewer
had just clicked episode 1. Production also contained proof-created progress
rows for the sampled movie and series IDs. Those rows were removed from the
active VPS data store, and the proof now has a guard that prevents creating new
rows.

## Live Proof

Artifact directory:

`C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-timebar-offset-proof-20260529081032`

Proof command:

`node scripts/xstream-timebar-sync-proof.mjs`

Result: `ok: true`

Verified cases:

- Apollo movie `/dashboard/watch/movie/8479`
  - UI clock: `00:10/2:30:02`
  - displayed duration: `9002`
  - progress percent: `0.12`
  - video readyState `4`, muted `false`, volume `1`, decoded audio present
- XtremeHD movie `/dashboard/watch/movie/2016459`
  - UI clock: `00:13/1:41:00`
  - displayed duration: `6060`
  - progress percent: `0.22`
  - video readyState `4`, muted `false`, volume `1`, decoded audio present
- Apollo series `/dashboard/watch/series/10553`
  - UI clock: `00:13/1:03:51`
  - displayed duration: `3831`
  - progress percent: `0.36`
  - video readyState `4`, muted `false`, volume `1`, decoded audio present

No page errors or console errors were recorded.

Post-proof VPS state check:

- `watch-progress.json` contained no proof keys for `8479`, `2016459`, `10553`,
  or episode `251543`.
- `movie-8479.json`, `movie-2016459.json`, and `series-10553.json` were absent
  from the active standalone data directory after the proof.
