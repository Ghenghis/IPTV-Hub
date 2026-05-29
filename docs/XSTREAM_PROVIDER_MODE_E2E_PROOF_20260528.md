# XStream Provider Mode E2E Proof - 2026-05-28

Status: ACCEPTED.

Live app:

```text
https://xstream-player.daveai.tech
```

## Proof Artifacts

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-combined-only-20260528T200111\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-separated-only-20260528T200704\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-live-playback-strict-20260528T202536\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-movie-playback-20260528T201124\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-series-playback-20260528T211000\summary.json
```

## What Passed

- Apollo Group TV and XtremeHD remain separate in single-provider mode.
- Combined Tagged mode stores provider-aware composite IDs and does not leak
  provider credentials to browser storage.
- Live, movie, and series cards populate for both providers with stable card
  dimensions and artwork where upstream art exists.
- Live playback passed for both providers with moving video, unmuted volume, and
  decoded audio bytes.
- Movie playback passed for both providers through browser-safe provider-vault
  playback/transcode routes.
- Series episode playback passed for both providers after the app exposed
  explicit `Play episode ...` controls and the proof clicked those controls.

## Important Corrections

- The older series proof was not a real playback proof because it did not
  reliably click an episode. That is fixed in
  `scripts/xstream-provider-mode-e2e-proof.mjs`.
- Provider IDs are now preserved through combined-mode route IDs such as
  `apollo:series:*` and decoded before database lookup or playback.
- The Next standalone deploy path now copies `.next/static` into the standalone
  runtime tree to avoid stale chunk-load failures.
