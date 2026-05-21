# IPTV Hub — Product Specification

## 1. The user

A single power user with 25–30 IPTV / streaming projects on a Windows 11 box, mixing:

- Git source projects in active development (cinexa, iptvnator, open-tv, orbiscast,
  IPTV-Restream, MaxVideoPlayer, NuvioWeb, react-iptv, stalker-ui, wizju-iptv-player,
  xstream-player, ynotv, TVapp, neptune-tv, iptv-stream, free-tv-iptv, IPTauriV,
  HarmonyIPTV, Extreme-InfiniTV, clubtivi-windows, AuthoIPTV, iptv, iptvnator, smart-IPTV-Web,
  PiTV).
- Release-tracked apps with vendor binaries (Stremio, Fred.TV).
- Vendor MSIs they want to keep current (AuthoIPTV.msi, iptv-desktop, Fred.TV.msi).
- Tizen `.ipk` packages they push to a Samsung TV (Crunchyroll Tizen, etc.).

The user is not a full-time developer; they want outcomes. They run all of these
side-by-side and the current pain is: every one of them updates differently, breaks
differently, and stores config differently. They want one launcher that knows how to
launch and update each one safely.

## 2. Problem statement

> Across 28 mixed-stack apps, I cannot tell at a glance which are out of date, I lose
> hours to broken updates, and a careless `git pull` once wiped my playlist database. I
> need a single dashboard that:
>
> 1. Shows every app, its source type, current version, and update status.
> 2. Lets me launch any of them with one click.
> 3. Knows how to update each one safely (different mechanism per type).
> 4. Never touches my user data when it updates an app.
> 5. Backs up before changing anything and lets me roll back in one click.

## 3. Success criteria (measurable)

For the first tagged release (v0.1.0):

1. **Inventory.** On first launch, IPTV Hub scans the configured `apps-root` and lists
   ≥ 25 apps with correct source-type detection and a working **Launch** action for each.
2. **Detection.** Background poller correctly identifies updates for at least three of
   each source type (git, release, installer). Web and tizen, at least one each.
3. **Apply (git).** Applying an update to a real git source completes in <60 s for a
   small repo and the smoke test passes.
4. **Apply (release).** Applying a release update for a known-good app
   (e.g. iptv-desktop) downloads, verifies, and installs in <120 s.
5. **Rollback.** On a deliberately-failed update (test fixture), the app is left in its
   pre-update state and the activity log records the rollback.
6. **Crash-safety.** Killing the Tauri process mid-update at any of the six plan steps
   leaves the system in a recoverable state (next launch detects the in-flight update and
   either resumes or rolls back).
7. **No data loss.** User-data symlinks are intact after every update operation, verified
   by an integration test that writes a sentinel file before update and checks it
   afterwards.
8. **UI matches mockups.** The two approved screens (main grid, update modal) render
   pixel-equivalent to the mockups against the tokens in [`UI_SPEC.md`](./UI_SPEC.md).

## 4. Non-goals (v1)

These are intentionally out of scope. Putting them in the contract now to prevent scope
creep:

- Multi-user support / shared cloud manifest.
- Mobile companion app.
- Built-in IPTV playback. IPTV Hub launches IPTV apps; it does not play streams itself.
- Cross-platform builds. Windows 11 only in v1. macOS/Linux are tracked but
  not committed.
- Telemetry / analytics.
- Auto-update of IPTV Hub itself. Manual MSI for v1; in-app updater post v0.3.
- Code signing. Tracked, post v0.3.
- AppImage / Flatpak / Snap. Out of scope.

## 5. Personas (one)

There is one user. Spec to that one user. No "we should also support…" without their
explicit input.

## 6. Workflows the product must support

### W1 — First-run inventory

1. Install MSI, launch IPTV Hub.
2. Settings page prompts for `apps-root` (default `C:\IPTV\`).
3. Run **Seed from folder**.
4. IPTV Hub scans the folder, recognises subdirectories as candidate apps, classifies
   each (git repo → `git` source; folder with `package.json` and no `.git` → `web`
   source pinned to current state; folder under `Program Files` → `installer`).
5. User reviews the proposed manifest, edits as needed, saves.

### W2 — Daily check-in

1. Launch app, see the main grid.
2. "Updates: N" chip shows count; click to filter.
3. Click **Update** on a row; review the preview modal; click **Apply**.
4. Watch the activity log scroll. Done.

### W3 — Launch and use

1. Launch app, search by name.
2. Click **Launch** on the matching card.
3. IPTV Hub spawns the underlying app, marks its status as `running`, tails its output
   to the activity log (debug mode only).

### W4 — Recover from a bad update

1. Open the app's details (`...` menu → "Update history").
2. Pick a snapshot from the rollback list.
3. Click **Roll back**.
4. The opposite of the apply step runs; the smoke test re-runs.

### W5 — Add a new app from scratch

1. Settings → **Add app** → paste a GitHub URL or pick a folder.
2. IPTV Hub auto-fills the manifest entry from the URL or from sniffing the folder.
3. User edits launch command, icon, favorite flag.
4. Save → first poll runs immediately.

### W6 — Deploy a Tizen IPK to the TV

1. Open the tizen app's card.
2. Click **Deploy to TV**.
3. IPTV Hub checks `sdb devices`. If no TV is connected, prompts the user with setup
   instructions.
4. If connected, runs `sdb install <ipk>` and tails the output.

## 7. Out-of-band failure modes the spec must handle

- GitHub rate limits (60/hr unauth, 5000/hr authed).
- Network drop mid-download. Resumable when possible.
- Disk full. Detected before snapshot; refused with a clear message.
- Lockfile drift after a pull (e.g. `npm ci` fails). Treated as update failure; rollback.
- Vendor installer hangs or returns non-zero. Treated as update failure; rollback or
  manual recovery instructions.
- A source is removed upstream (404). Marked `Error`, surfaced in the UI, kept in the
  manifest until the user removes it.

## 8. Versioning of IPTV Hub itself

SemVer. The manifest schema also versions: every `apps.json` carries a `schema_version`
integer. Migrations run on first load if the version is behind. Migration code lives in
`src-tauri/src/manifest/migrations/`.

## 9. Release cadence

- **v0.1.0** — first usable build. Git + release + installer source types complete. Web
  and tizen behind a feature flag.
- **v0.2.0** — web and tizen complete. System tray. Settings polish.
- **v0.3.0** — code-signed installer, in-app updater for IPTV Hub itself.

Beyond v0.3, the project is in maintenance unless the user requests more.
