# IPTV Hub — Database

SQLite, via `sqlx` with compile-time-checked queries. Single file at
`<install-dir>/iptv-hub.db` with the migration tool maintaining a `_sqlx_migrations` table.

## Schema (v1)

### `apps`

Runtime state mirror for every entry in `apps.json`. Joined with the manifest at read
time to build the `AppView` returned to the frontend.

```sql
CREATE TABLE apps (
    id                  TEXT PRIMARY KEY,        -- matches manifest .id
    name                TEXT NOT NULL,
    source_type         TEXT NOT NULL,           -- git | release-binary | installer | web | tizen-ipk
    current_version     TEXT,                    -- semver or other display version
    current_sha         TEXT,                    -- for git/web sources
    status              TEXT NOT NULL DEFAULT 'idle', -- idle | ok | update_available | error | updating | running
    status_message      TEXT,                    -- short message if status = error
    last_poll_at        TEXT,                    -- ISO 8601 UTC
    last_success_at     TEXT,
    last_failure_at     TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    backoff_until       TEXT,
    favorite            INTEGER NOT NULL DEFAULT 0,
    enabled             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_apps_status     ON apps(status);
CREATE INDEX idx_apps_last_poll  ON apps(last_poll_at);
CREATE INDEX idx_apps_favorite   ON apps(favorite) WHERE favorite = 1;
```

### `update_history`

One row per applied or rolled-back update. Used by the "Update history" view in a card's
detail panel.

```sql
CREATE TABLE update_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    outcome         TEXT NOT NULL,               -- applied | failed | rolled_back | cancelled
    from_version    TEXT,
    to_version      TEXT,
    snapshot_id     TEXT,                        -- foreign key into snapshots
    error_message   TEXT,
    plan_json       TEXT NOT NULL                -- the full UpdatePlan as serialized JSON
);

CREATE INDEX idx_update_history_app ON update_history(app_id, started_at DESC);
```

### `snapshots`

Rollback snapshot index. The actual files live under `cache/rollback/<app_id>/<snapshot_id>.tar.zst`.

```sql
CREATE TABLE snapshots (
    id          TEXT PRIMARY KEY,                -- ULID
    app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,                   -- absolute path to the snapshot file
    size_bytes  INTEGER NOT NULL,
    sha256      TEXT NOT NULL,                   -- of the tar.zst itself
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL                    -- auto-purge daily
);

CREATE INDEX idx_snapshots_app     ON snapshots(app_id, created_at DESC);
CREATE INDEX idx_snapshots_expires ON snapshots(expires_at);
```

### `activity_log`

Append-only log shown in the Recent Activity panel and in the full activity page.

```sql
CREATE TABLE activity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,                  -- ISO 8601 UTC
    app_id       TEXT REFERENCES apps(id) ON DELETE SET NULL,
    correlation  TEXT,                           -- groups rows from one operation
    action       TEXT NOT NULL,                  -- poll | check | plan | apply | rollback | smoke | launch | stop | error | seed
    level        TEXT NOT NULL DEFAULT 'info',   -- info | warn | error
    message      TEXT NOT NULL,
    details_json TEXT
);

CREATE INDEX idx_activity_at      ON activity_log(at DESC);
CREATE INDEX idx_activity_app     ON activity_log(app_id, at DESC);
CREATE INDEX idx_activity_corr    ON activity_log(correlation);
```

The Recent Activity panel runs:

```sql
SELECT at, app_id, action, level, message
FROM activity_log
ORDER BY at DESC
LIMIT 4;
```

The status bar runs:

```sql
SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status = 'update_available' THEN 1 ELSE 0 END) AS updates,
    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
    SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) AS favorites
FROM apps
WHERE enabled = 1;
```

### `settings`

Key-value bag for things that don't deserve a column. All values are strings; consumers
parse.

```sql
CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
```

Seeded keys:

- `next_auto_sync_at` — ISO 8601 timestamp.
- `last_seed_at` — ISO 8601.
- `theme` — `system` | `dark` | `light`.

## Migrations

- `src-tauri/migrations/001_initial.sql` — the schema above.
- Future migrations are additive only; column renames go through `add new, dual-write,
  backfill, drop old` in separate migrations.
- `sqlx migrate run` is wrapped in `db::init` and runs on every app launch.

## Retention

- `activity_log`: keep last **10,000 rows** or **30 days**, whichever is more. A daily
  sweep deletes the excess.
- `snapshots`: deleted when `expires_at < now()`; the corresponding tar.zst file is also
  removed from disk. A daily sweep handles this. Snapshots referenced by an
  `update_history` row whose outcome is `failed` or `rolled_back` are retained until the
  row itself is purged (30-day floor).
- `update_history`: never auto-deleted in v1. A manual purge action is available in
  settings.

## Backup

- The DB file is included in the user's backup flow (a settings → "Export everything"
  button bundles `apps.json`, `iptv-hub.db`, and `cache/icons/` into a single zip).
- On every app launch, the previous DB file is copied to `iptv-hub.db.bak` before
  migrations run, so a broken migration can be reverted by swapping the files.
