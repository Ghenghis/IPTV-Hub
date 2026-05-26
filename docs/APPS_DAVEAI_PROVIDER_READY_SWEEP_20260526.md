# apps.daveai.tech Provider-Ready Visual Sweep — 2026-05-26

Status: `12/12 passed`

## Scope

Authenticated Playwright sweep against the live DaveTV launcher/provider-ready
surface using a short-lived QA auth-gate session. The session was removed after
the sweep and the auth gate was restarted.

Artifact directory:

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\apps-provider-ready-sweep-20260526
```

Summary:

```text
C:\Users\Admin\Downloads\VPS\_visual_artifacts\apps-provider-ready-sweep-20260526\summary.json
```

## Gates

Each app had to satisfy:

- reached the protected app URL with HTTP 200 after auth;
- did not show the login page;
- did not show a client-side exception or application error;
- did not render raw provider credential-shaped URLs; and
- produced no Playwright `pageerror`.

## Passing apps

- `iptv-player-zero`
- `nuvio`
- `iptvnator`
- `extreme-infinitv`
- `wizju-iptv-player`
- `xstream-player`
- `smart-iptv-web`
- `stalker-ui`
- `iptv-stream`
- `iptv-restream`
- `open-tv`
- `ynotv`

## Repairs Made During Sweep

- Switched launcher URLs for root-bundle apps to dedicated subdomains so their
  absolute asset paths resolve from the correct app root:
  `extreme-infinitv`, `wizju-iptv-player`, `stalker-ui`, `open-tv`, `ynotv`.
- Added the Stalker UI hosted `webapis` stub and patched the deployed script
  path from `$WEBAPIS/webapis/webapis.js` to `/webapis/webapis.js`.

## Non-Blocking Console Notes

Some players still log blocked mixed-content poster/image warnings from provider
catalog metadata. Playback and provider-vault URLs remain same-origin and the
visual gates passed. A later polish wave can proxy or sanitize poster URLs.
