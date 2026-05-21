-- IPTV Hub initial schema (v1).
-- See docs/DATABASE.md for the rationale and retention policy.

CREATE TABLE IF NOT EXISTS apps (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    source_type           TEXT NOT NULL,
    current_version       TEXT,
    current_sha           TEXT,
    status                TEXT NOT NULL DEFAULT 'idle',
    status_message        TEXT,
    last_poll_at          TEXT,
    last_success_at       TEXT,
    last_failure_at       TEXT,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    backoff_until         TEXT,
    favorite              INTEGER NOT NULL DEFAULT 0,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_apps_status    ON apps(status);
CREATE INDEX IF NOT EXISTS idx_apps_last_poll ON apps(last_poll_at);
CREATE INDEX IF NOT EXISTS idx_apps_favorite  ON apps(favorite) WHERE favorite = 1;

CREATE TABLE IF NOT EXISTS update_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    outcome       TEXT NOT NULL,
    from_version  TEXT,
    to_version    TEXT,
    snapshot_id   TEXT,
    error_message TEXT,
    plan_json     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_update_history_app ON update_history(app_id, started_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
    id          TEXT PRIMARY KEY,
    app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_app     ON snapshots(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_expires ON snapshots(expires_at);

CREATE TABLE IF NOT EXISTS activity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,
    app_id       TEXT REFERENCES apps(id) ON DELETE SET NULL,
    correlation  TEXT,
    action       TEXT NOT NULL,
    level        TEXT NOT NULL DEFAULT 'info',
    message      TEXT NOT NULL,
    details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_at   ON activity_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_app  ON activity_log(app_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_corr ON activity_log(correlation);

CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

-- Seed the settings the runtime expects to exist.
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('theme', 'system'),
    ('next_auto_sync_at', ''),
    ('last_seed_at', '');
