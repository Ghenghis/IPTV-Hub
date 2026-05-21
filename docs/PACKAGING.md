# IPTV Hub — Packaging & Release

## 1. Local build

```pwsh
.\scripts\build.ps1                       # full release build → dist\
```

The build:

1. Runs the full test gate (matches CI).
2. `cargo build --release --workspace`.
3. `npm run build --workspace=frontend`.
4. `npx tauri build` to produce the MSI bundle.
5. Computes SHA-256 of every artifact and writes `dist/SHA256SUMS.txt`.
6. Writes a build manifest to `dist/build-info.json` with the commit SHA, build time,
   Rust toolchain version, Node version.

Artifacts:

```
dist/
├── iptv-hub-<version>.msi
├── iptv-hub-<version>-portable.zip
├── SHA256SUMS.txt
└── build-info.json
```

## 2. CI build

`.github/workflows/release.yml` runs on tag push (`v*`):

1. Matrix: just Windows (`windows-2022`) for v1. macOS and Linux are listed but skipped
   behind `if: false`, ready for v0.4.
2. Caches the Rust target dir and `node_modules`.
3. Runs the same `scripts/build.ps1`.
4. Verifies the MSI installs on a clean runner by running `scripts/smoke.ps1`.
5. Creates a GitHub release with the artifacts and `SHA256SUMS.txt`.
6. Appends a release note assembled from `CHANGELOG.md`'s top `[Unreleased]` block;
   the workflow then rotates `[Unreleased]` to `[<version>] — <date>` in a follow-up
   commit on `main`.

## 3. Versioning

SemVer. The version is declared once, in `src-tauri/Cargo.toml`. A `scripts/bump-version.{ps1,sh}`
script bumps:

- `src-tauri/Cargo.toml` → `package.version`.
- `frontend/package.json` → `version`.
- `src-tauri/tauri.conf.json` → `package.version`.
- Inserts a fresh `[Unreleased]` heading in `CHANGELOG.md`.

It also fails if `CHANGELOG.md` does not have at least one entry under `[Unreleased]` —
no version bumps with empty changelogs.

## 4. MSI bundle config

Configured in `src-tauri/tauri.conf.json`. Key points:

- App identifier: `com.iptvhub.app`.
- WiX template: default Tauri (override post v0.2 if needed for custom start-menu entries).
- Install scope: per-user (`HKCU`) by default. A `per-machine` MSI variant is built but
  not promoted in v1.
- File associations: none in v1.
- URL schemes: `iptvhub://` reserved, not wired in v1.
- App data location on Windows: `%APPDATA%\IPTV-Hub\` (`apps.json`, `iptv-hub.db`,
  `iptv-hub.db.bak`, `cache/`).

## 5. Code signing

Tracked, not v1. The release pipeline has a conditional `signtool.exe` step that runs
only if `secrets.WINDOWS_SIGNING_CERT_THUMBPRINT` is set, so signing can be enabled
later by adding the secret without changing the workflow.

For unsigned builds, the release notes include the SHA-256 of every artifact and a
verification command.

## 6. Auto-update

Tauri's built-in updater is wired in `src-tauri/src/main.rs` but **disabled by default in
v1** (the `tauri.conf.json` `updater.active` is `false`). The endpoint is reserved at
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`. The release
pipeline writes `latest.json` when the secret `TAURI_PUBLIC_KEY` is set; until then,
v1 users manually download new MSIs.

## 7. Portable build

The portable zip is produced from the same release build by:

1. Bundling `iptv-hub.exe`, `WebView2Loader.dll`, the frontend assets, and a marker file
   `PORTABLE` into a directory.
2. Zipping the directory.

When the binary detects the `PORTABLE` marker on launch, it uses its install directory
as the app-data directory instead of `%APPDATA%`. This lets a user keep the whole thing
on a USB stick.

## 8. Release checklist

For every release:

1. All DoD checks pass on `main`.
2. `scripts/bump-version.ps1 <new-version>` run locally.
3. Commit the bump, tag `v<version>`.
4. Push the tag; CI does the rest.
5. After CI publishes, verify the install on a clean Windows 11 VM (a one-off VM
   snapshot is kept for this).
6. Edit the GitHub release notes if anything from `[Unreleased]` was missed.
7. Announce.
