# IPTV Player Zero Free Provider Fix - 2026-05-26

Status: `ACCEPTED`

Live URL:

```text
https://apps.daveai.tech/iptv-player-zero/
```

Artifact directory:

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-free-provider-fix-20260526
```

## What Changed

- Removed the hosted paywall behavior for DaveTV: the web build now reports a hosted lifetime/pro license with `purchaseRequired: false`.
- Hid purchase/Stripe/trial wording in the hosted app shell.
- Fixed Apollo Group TV and XtremeHD provider-vault quick-load persistence.
- Normalized provider catalog rows so category/group fields are strings before React renders them.
- Hardened the local store/Tauri shim for hosted web mode so missing desktop-only APIs no longer crash the app.
- Added defensive guards around channel/category/recent/favorite collections to prevent `.map`/iteration crashes while provider data is loading.
- Fixed playback state churn by stabilizing the shared store selector wrapper.
- Disabled unstable tutorial/helper overlays that were causing hosted ResizeObserver/state loops.
- Kept provider credentials server-side; browser-visible playback uses same-origin `/api/provider-vault/*` URLs only.

## Verification

Provider load proof, generated `2026-05-26T22:04:59Z`:

| Provider | Result | Catalog | Live | Movies | Series | Paid Text | Page Errors | Console Errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Apollo Group TV | PASS | 2200 | 1200 | 500 | 500 | 0 | 0 | 0 |
| XtremeHD | PASS | 2200 | 1200 | 500 | 500 | 0 | 0 | 0 |

License proof for both providers:

```text
status=active
plan=lifetime
tier=pro
lifetimeUnlocked=true
premiumActive=true
purchaseRequired=false
source=daveai_hosted_full_free
```

Playback proof, generated `2026-05-26T21:57:44Z`:

| Provider | Result | First Channel | Stream Proxy | Segment Proxy | Video Ready | Credential Leaks |
| --- | --- | --- | --- | --- | ---: | ---: |
| Apollo Group TV | PASS | USA AMC | PASS | PASS | 4 | 0 |
| XtremeHD | PASS | USA AMC | PASS | PASS | 4 | 0 |

Screenshots:

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-free-provider-fix-20260526\ipz-apollo-proof.png
C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-free-provider-fix-20260526\ipz-xtremehd-proof.png
C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-free-provider-fix-20260526\ipz-apollo-playback.png
C:\Users\Admin\Downloads\VPS\_visual_artifacts\ipz-free-provider-fix-20260526\ipz-xtremehd-playback.png
```

## VPS State

Production backup before the repair:

```text
/var/backups/daveai-apps/iptv-player-zero-before-free-provider-fix-20260526T200620Z.tgz
```

Deployment target:

```text
/var/www/davetv/apps/iptv-player-zero/
```

Cloudflare cache was purged after deploy.

## Notes

- The visible `PRO` badge is intentional for this hosted DaveTV build: it means Pro is already unlocked for free, not that payment is required.
- The old `Upgrade to Pro`, Stripe, trial, and price copy is absent from the verified hosted UI.
- Proof auth uses a short-lived DaveTV auth-gate QA session. The auth gate keeps sessions in memory, so it must be restarted after writing a synthetic proof session.
