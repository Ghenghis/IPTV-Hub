# IPTV Hub — Manifest Schema

The manifest is the contract between the user's app inventory and the IPTV Hub runtime.
The validatable JSON Schema is at [`schema/apps.schema.json`](../schema/apps.schema.json).

## 1. Top-level shape

```jsonc
{
  "schema_version": 1,
  "apps_root": "C:\\IPTV",
  "user_data_root": "C:\\IPTV\\user-data",
  "cache_root": "C:\\IPTV\\cache",
  "apps": [
    { /* AppEntry */ }
  ]
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema_version` | integer | yes | Bumped on any breaking change. Migrations live in `src-tauri/src/manifest/migrations/`. Currently `1`. |
| `apps_root` | string (absolute path) | yes | Where `upstream/` lives. |
| `user_data_root` | string (absolute path) | yes | Where `user-data/` lives. Often a sibling of `apps_root`. |
| `cache_root` | string (absolute path) | yes | Where rollback snapshots, downloaded installers, icons, and logs live. |
| `apps` | array of `AppEntry` | yes | Inventory. |

## 2. `AppEntry` — common fields

```jsonc
{
  "id": "iptvnator",
  "name": "iptvnator",
  "type": "git",
  "favorite": false,
  "enabled": true,
  "icon": { "kind": "initials", "value": "IN" },
  "polling": { "enabled": true, "interval_minutes": 15 },
  "launch": { /* LaunchSpec */ },
  "health": { /* HealthSpec */ },
  "source": { /* TypeSpecific */ },
  "user_data": { /* UserDataLink */ }
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Stable identifier. Lowercase, kebab or snake. Used in paths, DB keys, manifest cross-references. Cannot change after creation. |
| `name` | string | yes | Display name in the UI. May contain spaces. |
| `type` | string enum | yes | One of `git`, `release-binary`, `installer`, `web`, `tizen-ipk`. |
| `favorite` | boolean | no (default `false`) | Filters into the Favorites chip. |
| `enabled` | boolean | no (default `true`) | If false: not polled, not launchable from the grid. |
| `icon` | `IconSpec` | no | If absent, the launcher generates initials. |
| `polling` | `PollingSpec` | no | Defaults: `enabled=true`, `interval_minutes=15`. |
| `launch` | `LaunchSpec` | yes | How to launch the app. |
| `health` | `HealthSpec` | no | How to smoke-test after launch. |
| `source` | `TypeSpecific` | yes | Shape depends on `type`. |
| `user_data` | `UserDataLink` | no | If present, IPTV Hub symlinks user-data into the upstream tree on each update. |

## 3. `LaunchSpec`

```jsonc
{
  "kind": "executable",          // executable | npm | tauri-dev | exe-shortcut | web-url | tizen-deploy
  "cwd": "upstream/iptvnator",   // relative to apps_root, or absolute
  "command": "node_modules/.bin/electron",
  "args": ["."],
  "env": { "NODE_ENV": "production" },
  "wait_for": { "kind": "port", "value": 4200, "timeout_ms": 30000 }
}
```

`kind` values:

- `executable` — `command` is a path to an .exe (absolute or relative to `cwd`); `args` is
  the literal argv. No shell interpolation.
- `npm` — IPTV Hub runs `npm run <script>` where `command` is the script name. `cwd` is
  required.
- `tauri-dev` — Wrapper for `npx tauri dev` (used for Rust-based source apps).
- `exe-shortcut` — Resolve a `.lnk` file at `command` and launch its target. Used for
  installer-sourced apps to follow the installer's Start Menu shortcut.
- `web-url` — Open the user's default browser at `command` (a URL). Used for pure web apps.
- `tizen-deploy` — Deploy `cache/installers/<id>/<file>.ipk` via `sdb install`. `args`
  may include `--device <serial>` to target a specific TV.

`wait_for` controls how long IPTV Hub considers the app "starting" before flipping it to
`running`. It can be:

- `{ "kind": "port", "value": <int>, "timeout_ms": <int> }` — TCP probe.
- `{ "kind": "process", "value": "<process-name>", "timeout_ms": <int> }` — process exists.
- `{ "kind": "http", "value": "http://localhost:1234/health", "timeout_ms": <int> }` — HTTP 2xx.
- `{ "kind": "none" }` — fire and forget.

## 4. `HealthSpec`

Identical shape to `wait_for` but evaluated **after an update** as the smoke test. If
absent, the launcher's `wait_for` is reused.

## 5. `IconSpec`

```jsonc
// initials (default)
{ "kind": "initials", "value": "IN" }

// or a path under cache/icons/
{ "kind": "file", "value": "cache/icons/iptvnator.png" }

// or a URL to fetch on first poll
{ "kind": "url",  "value": "https://raw.githubusercontent.com/4gray/iptvnator/main/icon.png" }
```

URL icons are fetched, cached under `cache/icons/<id>.<ext>`, and converted to `kind: file`
on save.

## 6. `PollingSpec`

```jsonc
{
  "enabled": true,
  "interval_minutes": 15,
  "jitter_seconds": 30
}
```

`jitter_seconds` prevents all sources from polling at the same instant.

## 7. `UserDataLink`

```jsonc
{
  "path": "user-data/iptvnator",
  "mount_at": "upstream/iptvnator/userData",
  "create_if_missing": true
}
```

On every update, IPTV Hub guarantees:

- `path` exists (creates if `create_if_missing` is true).
- `mount_at` is a symbolic link to `path` (creates or replaces as needed).
- A broken symlink at `mount_at` is repaired without touching `path`.

This is how user data survives updates regardless of what the underlying app does to its
working directory.

## 8. `TypeSpecific` — by `type`

### 8.1 `type: "git"`

```jsonc
{
  "url": "https://github.com/4gray/iptvnator.git",
  "branch": "main",                       // or tag, or sha
  "fetch_strategy": "fast-forward-only",  // fast-forward-only | rebase | reset (the last requires confirmation)
  "post_update": ["npm ci"],              // commands to run after a successful pull, before smoke
  "post_update_cwd": "upstream/iptvnator"
}
```

### 8.2 `type: "release-binary"`

```jsonc
{
  "repo": "Stremio/stremio-shell",        // github "owner/repo"
  "asset_pattern": ".*win.*x64.*\\.exe$", // regex against release asset names
  "version_strategy": "semver",           // semver | timestamp | sha256
  "sha256_required": true,
  "install_dir": "upstream/Stremio",
  "install_strategy": "extract",          // extract | run-installer | copy
  "running_check": { "kind": "process", "value": "stremio.exe" }
}
```

### 8.3 `type: "installer"`

```jsonc
{
  "vendor": "AuthoIPTV Project",
  "product_name": "AuthoIPTV",
  "registry_uninstall_key": "AuthoIPTV",  // GUID or display name match
  "download_url": "https://example.com/releases/latest/AuthoIPTV-Setup-{{version}}-win-x64.exe",
  "version_endpoint": "https://example.com/releases/latest.json",
  "version_json_path": "$.tag_name",
  "sha256_endpoint": "https://example.com/releases/latest.json",
  "sha256_json_path": "$.assets[0].sha256",
  "install_args": ["/S"],                  // silent install switches
  "uninstall_args": ["/S"]
}
```

For installers that store version in the registry, the runtime detects the currently
installed version by reading `Software\Microsoft\Windows\CurrentVersion\Uninstall\<key>\DisplayVersion`
from `HKLM` or `HKCU` (the launcher tries `HKCU` first, falls back to `HKLM`).

### 8.4 `type: "web"`

```jsonc
{
  "url": "https://github.com/owner/repo.git",
  "branch": "main",
  "fetch_strategy": "fast-forward-only",
  "package_manager": "npm",              // npm | yarn | pnpm | bun
  "install_command": "ci",               // → npm ci
  "start_command": "start",              // → npm run start
  "port": 4200
}
```

Resolves to git for the source side and to a launch-time dev server for the run side.

### 8.5 `type: "tizen-ipk"`

```jsonc
{
  "source_kind": "github-release",       // github-release | url
  "repo": "owner/repo",                  // when source_kind = github-release
  "asset_pattern": ".*\\.ipk$",
  "download_url": null,                  // used when source_kind = url
  "device_serial": null,                 // optional, sdb device target
  "version_strategy": "semver"
}
```

## 9. Example: a full entry

```jsonc
{
  "id": "iptvnator",
  "name": "iptvnator",
  "type": "git",
  "favorite": true,
  "enabled": true,
  "icon": { "kind": "initials", "value": "IN" },
  "polling": { "enabled": true, "interval_minutes": 15 },
  "launch": {
    "kind": "npm",
    "cwd": "upstream/iptvnator",
    "command": "start",
    "args": [],
    "env": { "NODE_ENV": "development" },
    "wait_for": { "kind": "port", "value": 4200, "timeout_ms": 30000 }
  },
  "health": { "kind": "port", "value": 4200, "timeout_ms": 30000 },
  "source": {
    "url": "https://github.com/4gray/iptvnator.git",
    "branch": "main",
    "fetch_strategy": "fast-forward-only",
    "post_update": ["npm ci"],
    "post_update_cwd": "upstream/iptvnator"
  },
  "user_data": {
    "path": "user-data/iptvnator",
    "mount_at": "upstream/iptvnator/userData",
    "create_if_missing": true
  }
}
```

## 10. Validation

- On read: parsed and validated against [`schema/apps.schema.json`](../schema/apps.schema.json).
- On write: re-validated; atomic write (temp + rename); previous file kept as
  `apps.json.bak`.
- Schema-version migrations live under `src-tauri/src/manifest/migrations/` and run on
  load if the schema_version is behind.

## 11. Where the manifest lives

`<install-dir>/apps.json`. On Windows, this is usually `%APPDATA%\IPTV-Hub\apps.json`
when launched as a normal user, or `<install-root>\apps.json` for a portable install.

The manifest is **not** part of the layered TOML config because it is the runtime's primary
mutable state. Treat it like a database file, not a config file.
