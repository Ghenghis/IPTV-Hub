// Typed wrappers around the Tauri command surface. Mirrors every command registered
// in `src-tauri/src/main.rs::tauri::generate_handler!`. Never canned or fabricated
// responses — every call goes through `invoke` to the real Rust handler.

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------- //
// Shared types
// ---------------------------------------------------------------------------- //

export type SourceType = "git" | "release-binary" | "installer" | "web" | "tizen-ipk";

/// Canonical client-side status names. The Rust backend currently emits the
/// snake_case Tauri / sqlx names (`"up_to_date"`, `"update_available"`); older
/// poller code paths still emit the kebab-case names (`"update-available"`).
/// `AppView.status` is typed as plain `string` so callers can compare against
/// any of these without `as` casts; this union is here as a reference.
export type AppStatus =
  | "idle"
  | "checking"
  | "ok"
  | "up_to_date"
  | "update_available"
  | "update-available"
  | "updating"
  | "error"
  | "running";

export interface AppView {
  id: string;
  name: string;
  source_type: SourceType;
  favorite: boolean;
  enabled: boolean;
  status: string;
  status_message: string | null;
  current_version: string | null;
  current_sha: string | null;
  last_poll_at: string | null;
  last_success_at: string | null;
  icon_kind: string | null;
  icon_value: string | null;
  sub_label: string;
}

// Update flow — mirrors `src-tauri/src/sources/mod.rs::UpdateState/UpdatePlan/UpdateOutcome`.

export type UpdateState =
  | { kind: "up_to_date"; current: string }
  | { kind: "update_available"; from: string; to: string; summary: string }
  | { kind: "error"; message: string };

export interface KeyValue {
  key: string;
  value: string;
}

export type IncomingItem =
  | { kind: "commit"; sha: string; message: string; author: string }
  | { kind: "release_note"; version: string; markdown: string }
  | { kind: "installer_change"; summary: string }
  | { kind: "ipk_change"; version: string; notes: string };

export type PlanTag = "safe" | "time_estimate" | "risky";

export interface PlanStep {
  title: string;
  detail: string | null;
  tag: PlanTag;
}

export interface UpdatePlan {
  app_id: string;
  source_type: SourceType;
  from_label: string;
  to_label: string;
  from_meta: KeyValue[];
  to_meta: KeyValue[];
  incoming: IncomingItem[];
  steps: PlanStep[];
  rollback_retention_days: number;
}

export interface UpdateOutcome {
  new_version: string | null;
  new_sha: string | null;
  bytes_downloaded: number;
  elapsed_ms: number;
  messages: string[];
}

// Settings — mirrors `commands::settings::SettingsView`.

export interface SettingsView {
  theme: string;
  poll_concurrency: number;
  default_poll_interval_minutes: number;
  snapshot_retention_days: number;
  activity_log_retention_days: number;
  source_url_allowlist: string[];
  github_token: string | null;
}

// Activity / history / snapshots — mirror `commands::activity::*Entry`.

export interface ActivityEntry {
  id: number;
  at: string;
  app_id: string | null;
  action: string;
  message: string;
  level: string;
}

export interface UpdateHistoryEntry {
  id: number;
  started_at: string;
  app_id: string;
  from_version: string | null;
  to_version: string | null;
  outcome: string;
  error_message: string | null;
}

export interface SnapshotEntry {
  id: string;
  app_id: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

// Seed scanner — mirrors `commands::seed::SeedScanView`.

export interface SeedScanView {
  apps: AppView[];
  unclassified: string[];
}

// AppEntry — the manifest-side shape (richer than AppView). Used by add_app.
// Kept loose (Record<string, unknown>) because the schema has many optional
// branches; the schema lives in Rust and the frontend just round-trips the JSON.
export type AppEntry = Record<string, unknown>;

// ---------------------------------------------------------------------------- //
// Command surface — single source of truth, mirrors generate_handler! in main.rs
// ---------------------------------------------------------------------------- //

export const api = {
  apps: {
    list: (): Promise<AppView[]> => invoke<AppView[]>("list_apps"),
    get: (id: string): Promise<AppView> => invoke<AppView>("get_app", { id }),
    add: (entry: AppEntry): Promise<void> => invoke("add_app", { entry }),
    remove: (id: string): Promise<void> => invoke("remove_app", { id }),
    setFavorite: (id: string, favorite: boolean): Promise<void> => invoke("set_favorite", { id, favorite }),
    setEnabled: (id: string, enabled: boolean): Promise<void> => invoke("set_enabled", { id, enabled }),
  },
  updates: {
    check: (id: string): Promise<UpdateState> => invoke<UpdateState>("check_for_update", { id }),
    plan: (id: string): Promise<UpdatePlan> => invoke<UpdatePlan>("plan_update", { id }),
    apply: (id: string): Promise<UpdateOutcome> => invoke<UpdateOutcome>("apply_update", { id }),
    rollback: (id: string, snapshotId: string): Promise<void> => invoke("rollback", { id, snapshotId }),
  },
  launch: {
    launch: (id: string): Promise<void> => invoke("launch", { id }),
    stop: (id: string): Promise<void> => invoke("stop", { id }),
  },
  settings: {
    get: (): Promise<SettingsView> => invoke<SettingsView>("get_settings"),
    set: (key: string, value: string): Promise<void> => invoke("set_setting", { key, value }),
  },
  activity: {
    list: (limit: number, offset: number): Promise<ActivityEntry[]> =>
      invoke<ActivityEntry[]>("list_activity", { limit, offset }),
    history: (appId: string, limit: number): Promise<UpdateHistoryEntry[]> =>
      invoke<UpdateHistoryEntry[]>("list_update_history", { appId, limit }),
    snapshots: (appId: string): Promise<SnapshotEntry[]> =>
      invoke<SnapshotEntry[]>("list_snapshots", { appId }),
  },
  seed: {
    fromFolder: (path: string): Promise<SeedScanView> => invoke<SeedScanView>("seed_from_folder", { path }),
  },
} as const;
