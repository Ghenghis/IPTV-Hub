# Nuvio Strict Gate Blocked - 2026-05-29

Status: BLOCKED_APP.

Live app:

```text
https://nuvio.daveai.tech
```

## Repairs Applied

- Provider-vault catalog requests now use `profile=english`.
- Category marker rows such as `#### DAZN Canada ####` are filtered out before
  they become Nuvio cards.
- The strict proof no longer assumes Apollo and XtremeHD have the same first
  live row.
- The strict proof uses Nuvio's actual direct `Play` button instead of waiting
  for a stream-card picker that this app does not expose.
- Stream URL validation now accepts same-origin `/api/provider-vault/*` routes,
  not only `/api/provider-vault/stream`.

## Current Blocker

Nuvio now reaches a real Apollo live detail page, but clicking `Play` creates a
video element with no `currentSrc`, `readyState: 0`, `videoWidth: 0`, and no
provider-vault stream request. That means the app is not asking the virtual
Stremio addon for the stream after the direct Play action.

This is an app integration blocker, not a provider catalog blocker.

## Evidence

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\nuvio-strict-cachebust-20260528T212700\nuvio-apollo-detail.png
C:\Users\Admin\Downloads\VPS\_visual_artifacts\nuvio-play-debug-20260529Tnow\state.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\nuvio-play-debug-20260529Tnow\apollo-after-play.png
```

The debug state after Play:

```json
{
  "src": "",
  "readyState": 0,
  "paused": false,
  "muted": false,
  "volume": 1,
  "currentTime": 0,
  "width": 0,
  "height": 0,
  "audio": 0
}
```

## Next Move

Do not loop on Nuvio now. Continue the fleet pass and return later with a
focused Nuvio Stremio-addon stream dispatch repair.
