# IPTV Hub — Update Flows

Every source type follows the **same nine-step flow** so the UI, rollback, and activity
log can be generic. What changes per type is the implementation of each step.

```
plan → confirm → snapshot → fetch → verify → swap → relink → smoke → commit | rollback
```

## 1. Universal flow

| Step | Owner | Failure handling |
| --- | --- | --- |
| **1. plan** | `Source::plan(&app)` | Network failure: surface error, no state change. |
| **2. confirm** | UI (the update modal) | User cancels: discard plan. |
| **3. snapshot** | `rollback::take(&app)` | Disk full / IO error: abort with clear message. |
| **4. fetch** | `Source::apply` step 1 | Network failure: retry with backoff, then abort + rollback. |
| **5. verify** | `Source::apply` step 2 | Hash mismatch: abort + rollback. |
| **6. swap** | `Source::apply` step 3 | IO error: abort + rollback. |
| **7. relink** | `manifest::link_user_data` | Symlink failure: abort + rollback. |
| **8. smoke** | `smoke_test::run` | Smoke fails: rollback automatically, mark app `error`. |
| **9. commit \| rollback** | `db::record_outcome` | This step itself never fails (idempotent). |

The same nine steps are written to the activity log with a per-app correlation id, so the
UI can show a step-by-step progress indicator for in-flight updates.

## 2. `git` source

**check_for_update:** `git ls-remote <url> <branch>` → compare returned SHA to
`apps.current_sha` in DB. Returns `UpToDate` or `UpdateAvailable { from, to, summary }`.

**plan:** runs `git fetch` and `git log --stat <current_sha>..<target_sha>` to produce:

- `from_sha`, `to_sha`, count of commits, +/- lines, file count.
- Up to 50 incoming commit entries (sha, message subject, author).
- Whether `package-lock.json`, `Cargo.lock`, `pnpm-lock.yaml`, `bun.lockb` changed
  (drives whether `post_update` commands will run).
- A 4–6 item "what will happen" list with `safe` / time-estimate tags.

**apply:**

1. **snapshot** — tar.zst the entire upstream directory excluding `node_modules/`,
   `target/`, `dist/`, and the user-data mount point. Snapshot lands in
   `cache/rollback/<id>/<sha>-<timestamp>.tar.zst`.
2. **stash local changes** — `git stash push -u -m "IPTV Hub auto-stash <timestamp>"`.
   If no local changes, no-op.
3. **fetch** — `git fetch origin <branch>` with a 60 s timeout.
4. **verify** — confirm fetched ref is a direct descendant of HEAD. If not
   (history rewritten), abort and surface a "history rewritten" error to the UI; user can
   choose `reset` strategy explicitly.
5. **swap** — `git merge --ff-only <target_sha>` (fast-forward-only). Refuses non-FF.
6. **post_update** — if lockfiles changed and `post_update` is configured, run each command
   in `post_update_cwd` with output streamed to the activity log. Any non-zero exit code
   aborts and triggers rollback.
7. **relink** — re-create the `user_data.mount_at` symlink if it was removed by the post_update step
   (some `npm ci` runs delete `userData`).
8. **smoke** — run `Source::smoke_test` (defaults to the `health` spec from manifest).
9. **commit** — write the new SHA to `apps.current_sha`, record `update_history` row with
   the snapshot id; activity log line: `applied · <id>: <from> → <to>`.

**rollback (manual or auto):**

- Restore the tar.zst into a sibling directory.
- Atomically rename the live dir to `<id>.failed.<timestamp>` and the restored dir into place.
- Re-link user data.
- Re-run smoke test. If smoke now passes, log "rolled back to <sha>"; if not, leave both
  dirs in place and emit a "manual recovery required" event.

## 3. `release-binary` source

**check_for_update:** `GET https://api.github.com/repos/<repo>/releases/latest`. Parse the
tag. Compare to `apps.current_version` per `version_strategy`.

For non-GitHub vendors with `version_endpoint`: fetch JSON, JSONPath the version.

**plan:**

- Current version, target version.
- Asset URL matched by `asset_pattern`.
- Asset size (from the response headers).
- SHA-256 from the release body (or `sha256_endpoint`/`sha256_json_path`) if available;
  otherwise mark as `verified: false`.
- Release notes from the API response, rendered as Markdown.

**apply:**

1. **snapshot** — tar.zst the install_dir.
2. **fetch** — stream the asset to `cache/installers/<id>/<filename>.partial`. Resume
   supported via `Range` header. Default 60 s connect timeout, no overall timeout (large
   binaries). Bandwidth is tracked and shown in the activity log.
3. **verify** — SHA-256 check. If `sha256_required: true` and no expected hash available,
   the apply fails before any swap.
4. **swap** — depending on `install_strategy`:
   - `extract` — extract the archive into install_dir (replacing contents atomically).
   - `run-installer` — execute the downloaded `.exe` with `install_args`. Wait up to 5 min.
   - `copy` — copy the file as-is to install_dir/<filename>.
5. **relink** — re-create user_data symlink (most release apps store user data outside
   the install_dir, so this is often a no-op).
6. **smoke** — run smoke test.
7. **commit** — write new version, record history.

## 4. `installer` source

**check_for_update:** identical to `release-binary` for the version probe. For the
installed version, read the Windows registry uninstall key.

**plan:**

- Currently installed version (from registry).
- New version, asset URL, SHA-256 if available.
- Estimated install time tag (`3–5 min` default; vendor-overridable via
  `manifest.estimated_install_minutes`).
- Whether running app instances will be terminated.

**apply:**

1. **snapshot** — registry export of the uninstall key, plus a copy of the install dir
   if `manifest.snapshot_install_dir: true` (off by default for size).
2. **fetch** — download MSI/EXE to `cache/installers/<id>/<file>`.
3. **verify** — SHA-256.
4. **swap** — execute the installer with `install_args`. On failure, immediately attempt
   to re-install the prior version from a cached installer if one exists; otherwise log
   the failure with the path to the installer for manual recovery.
5. **relink** — n/a for typical installers.
6. **smoke** — process probe or shortcut launch.
7. **commit** — re-read the registry to confirm version, record history.

## 5. `web` source

**check_for_update:** git ls-remote against the configured `url` and `branch`.

**plan:** same content as the git plan. Additionally:

- If `package.json` changed in incoming commits, flag `npm <install_command>` as a step.
- Estimate based on whether `node_modules/` exists (clean install vs cache hit).

**apply:** same as git, plus an additional step before smoke:

7a. **install deps** — run `<package_manager> <install_command>` in the source dir. Output
to activity log. Failure → rollback.

The launch path for web sources runs the dev server and shows the **port** in the card's
sub line (`localhost:<port>`).

## 6. `tizen-ipk` source

This is a manual-deploy flow because the IPK needs to be pushed to a real Samsung TV.

**check_for_update:** GitHub releases (or URL HEAD with ETag/Last-Modified) → compare
to `apps.current_version`.

**plan:**

- Current version, new version, asset URL, SHA-256 if available.
- A reminder that this only **fetches** the IPK; pushing to the TV requires
  **Deploy to TV** from the card menu.

**apply (fetch step):**

1. **snapshot** — keep the previous IPK at `cache/installers/<id>/<old-file>.bak`.
2. **fetch** — download new IPK to `cache/installers/<id>/<file>`.
3. **verify** — SHA-256.
4. **swap** — point the manifest's "current asset path" at the new file.
5. **commit** — record history. Status becomes "ready to deploy".

**deploy (separate user action):**

1. **probe** — `sdb devices` to confirm a TV is paired.
2. **install** — `sdb install <ipk>` (or `--device <serial>`).
3. **smoke** — `sdb shell <vendor-launch-command>` if specified.
4. **commit** — record deploy outcome in history (separate row from the fetch).

## 7. Rollback (universal)

`rollback::restore(app, snapshot_id)`:

1. Stop the app if running (`launcher::stop(app)`).
2. Move the live install dir to `<id>.preroll.<timestamp>` (kept until the rollback succeeds).
3. Extract the snapshot into the live install dir.
4. Re-link user-data.
5. Re-run smoke.
6. On success: delete `<id>.preroll.<timestamp>`. On failure: restore `<id>.preroll.<timestamp>`
   back into the live position and surface a manual-recovery message.

## 8. Concurrency rules

- The poller is bounded by `--poll-concurrency` (default 4).
- At most **one** apply runs per app at any time, enforced by an in-memory `tokio::Mutex`
  keyed on app id.
- The poller automatically backs off an app for 1 hour after 3 consecutive `Error`s.
- The "Sync now" button overrides the back-off for a single round.

## 9. Errors that must surface verbatim

Some failures are user-actionable; the UI must surface them with the original text:

- `network: timeout after Ns` — user can retry.
- `git: history rewritten; refusing non-fast-forward` — user can choose `reset` strategy.
- `release: no asset matching <pattern>` — user must fix the asset pattern.
- `installer: registry version key not found` — user must edit `registry_uninstall_key`.
- `tizen: no device paired (sdb returned empty list)` — user must pair the TV.
- `smoke: failed within <timeout>` — user can view logs and re-run smoke from the card menu.

## 10. Sequence diagrams

See:

- [`docs/diagrams/git-update-flow.mmd`](./diagrams/git-update-flow.mmd)
- [`docs/diagrams/release-update-flow.mmd`](./diagrams/release-update-flow.mmd)
- [`docs/diagrams/installer-update-flow.mmd`](./diagrams/installer-update-flow.mmd)
- [`docs/diagrams/update-state-machine.mmd`](./diagrams/update-state-machine.mmd)
