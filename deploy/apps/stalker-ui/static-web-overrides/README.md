# Stalker UI static web overrides

The tracked `deploy/apps/stalker-ui/upstream/` tree is the legacy Go
`stalkerhek` service slice. The live `apps.daveai.tech/stalker-ui/` player is
the React/Vite static build from:

`G:\Github\IPTV-web\stalker-ui`

This directory records the source files applied to that React build so the
hosted DaveAI version remains reproducible from IPTV-Hub.

## Files

- `src/services/providerVault.ts` — DaveTV provider-vault adapter for Apollo
  Group TV and XtremeHD catalog + safe stream URLs.
- `src/services/api.ts` — same-origin API base for hosted deployment.
- `src/services/services.ts` — provider-vault first, legacy Stalker API fallback,
  and empty EPG shim when provider-vault mode is active.
- `src/hooks/useAppNavigation.ts` — provider-vault stream URL passthrough for
  VOD, series, and live TV playback.
- `src/components/organisms/TvChannelList.tsx` — defaults live TV to
  `All Channels` so provider channels are visible immediately instead of hiding
  under an empty `Recent Channels` group.

## Contract

Browser-visible data must stay credential-free. The React app may call:

- `/api/provider-vault/providers`
- `/api/provider-vault/catalog?provider=<apollo|xtremehd>&...`
- `/api/provider-vault/stream?provider=<apollo|xtremehd>&kind=<...>&id=<...>`

It must not store or render raw provider host, username, password, MAC, portal
URL, Xtream URL, or M3U URL values.
