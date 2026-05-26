# IPTV Restream DaveAI overrides

These files are copied over the pinned upstream React frontend during the
`frontend-builder` Docker stage.

The overlay keeps the upstream restream/watch2gether app intact, but changes the
default channel source for DaveTV:

- load Apollo Group TV and XtremeHD channel catalogs through the DaveTV
  provider-vault API;
- use safe same-origin `/api/provider-vault/stream` URLs for playback;
- hide upstream demo channels when provider-vault catalogs are available;
- keep provider-vault channels read-only inside this UI; and
- increase HLS buffer windows for steadier playback.

No provider credentials are stored in this repo or bundled into the browser.
