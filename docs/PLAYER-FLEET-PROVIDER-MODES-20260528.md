# DaveTV Player Provider Modes - 2026-05-28

This note records the provider-mode contract now being applied player by
player across the DaveTV app fleet.

## Provider Contract

Players must support three operator-safe modes when the app can be wired to
DaveTV provider-vault data:

| Mode | Behavior |
| --- | --- |
| Apollo Group TV | Load only Apollo provider-vault catalog/session data. |
| XtremeHD | Load only XtremeHD provider-vault catalog/session data. |
| Combined Tagged | Load both providers together while preserving provider identity in listing metadata. |

Combined mode must not merge credentials or pretend both providers are the same
server. Items may be listed together, but group/title metadata must show which
provider the stream came from, for example `Apollo Group TV / USA Entertainment`
or `XtremeHD / USA Entertainment`.

## Security Contract

- Browser storage must not contain provider host, username, or password.
- Public browser URLs must route through DaveTV provider-vault/proxy endpoints.
- Provider selection should persist as provider IDs and display names only.

## Smart IPTV Web Status

Status: ACCEPTED for the strict 2026-05-28 provider proof.

Live URL:

```text
https://smart-iptv-web.daveai.tech
```

Proof:

```text
deploy/apps/smart-iptv-web/PROOF-20260528.md
C:\Users\Admin\Downloads\VPS\_visual_artifacts\smart-iptv-web-strict-20260528T152122\summary.json
```

Results:

- Apollo Group TV separate mode: catalog loaded, movies/series cards populated
  with artwork, live playback readyState `4`, unmuted, volume `1`.
- XtremeHD separate mode: catalog loaded, live/movie/series cards populated,
  live playback readyState `4`, unmuted, volume `1`.
- Combined Tagged mode: both providers loaded together, localStorage contains
  provider IDs only, listing metadata includes provider tags.

Implementation notes:

- `SmartHomeClient.tsx` fetches provider-vault catalogs with
  `profile=english`.
- `ChannelGrid.tsx` strips provider prefixes for category parsing while keeping
  the provider tag visible in group metadata.
- `VideoPlayer.tsx` forces `/api/provider-vault/aac-hls` through HLS.js so a
  source `ext=ts` does not get misrouted into `mpegts.js`.

## IPTV Player Zero Status

Status: ACCEPTED for the 2026-05-28 direct31 provider repair.

Live URL:

```text
https://apps.daveai.tech/iptv-player-zero/
```

Proof:

```text
deploy/apps/iptv-player-zero/PROOF-20260528.md
C:\Users\Admin\Downloads\VPS\_visual_artifacts\zero-player-autoload-direct31-20260528T232800\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\zero-player-full-direct31-20260528T234000\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\zero-player-combined-direct31-20260528T233500\summary.json
```

Results:

- Separated mode is the default: Apollo and XtremeHD are different playlists
  with different provider IDs, names, groups, and stream URLs.
- Combined Tagged mode is explicit: rows are prefixed with `[Apollo Group TV]`
  or `[XtremeHD]`, grouped as `Provider / Category`, and keep quality metadata
  when it is present.
- Fast UI import loads 4,200 rows per provider so first load is usable. Full
  catalogs are still available through Apollo/XtremeHD/Combined M3U8 export
  links and provider-vault API data.
- Apollo playback passed on `|UK| Syfy HD` via `/api/provider-vault/aac-hls`,
  readyState `4`, unmuted, volume `1`, 1024x576.
- XtremeHD playback passed on `USA AMC` via `/api/provider-vault/stream`,
  readyState `4`, unmuted, volume `1`, 1920x1080.
- No fatal screen, no paid/pro/Stripe copy, no non-English UI text, no
  console/page errors in the accepted proofs.

## XStream Player Status

Status: ACCEPTED for the 2026-05-28 provider-mode and playback repair.

Live URL:

```text
https://xstream-player.daveai.tech
```

Proof:

```text
docs/XSTREAM_PROVIDER_MODE_E2E_PROOF_20260528.md
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-combined-only-20260528T200111\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-separated-only-20260528T200704\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-live-playback-strict-20260528T202536\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-movie-playback-20260528T201124\summary.json
C:\Users\Admin\Downloads\VPS\_visual_artifacts\xstream-series-playback-20260528T211000\summary.json
```

Results:

- Apollo Group TV and XtremeHD separate modes each populate live, movie, and
  series cards without credential leakage.
- Combined Tagged mode loads both providers in one catalog using composite IDs
  such as `apollo:live:*` and `xtremehd:movie:*`; routes decode those IDs before
  querying IndexedDB or playback endpoints.
- Live playback passed for both providers with visible video, unmuted volume
  `1`, and decoded audio bytes. The strict gate skips known-dead or no-audio
  provider rows instead of falsely accepting them.
- Movie playback passed for both providers with blob HLS/transcode playback,
  decoded audio, and no console/page errors.
- Series episode playback passed for both providers after episode rows were
  made explicit `Play episode ...` controls. Apollo played `|EN| Villainous`;
  XtremeHD played `Aarya (2020)`.
- Card audits passed for live/movie/series. Provider artwork is used where it
  exists, and controlled fallbacks are used for logo-less live rows.

## Fleet Carry-Forward

Every remaining player repair should use this gate before being marked working:

1. Apollo separate catalog loads live, movies, and series.
2. XtremeHD separate catalog loads live, movies, and series.
3. Combined Tagged mode either works or is explicitly documented as not
   supported for that player.
4. Movie and series cards show title text and artwork when upstream art exists.
5. Live cards show title/category and either real logo artwork or a stable
   fallback when upstream logos are absent.
6. Random live playback reaches readyState `>= 2`, is unmuted, volume is above
   zero, and no media error is present.
7. Random VOD/series playback is tested when the provider stream is browser
   playable; known codec/source failures must be reported separately from UI
   catalog failures.
