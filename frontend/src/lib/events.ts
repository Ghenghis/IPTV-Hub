// Typed wrappers around the Tauri event surface. The backend emits these via
// `app_handle.emit(...)`; this module hands subscribers a typed handler and an
// unsubscribe function.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";

import type { ActivityEntry } from "./api";

/// `iptv-hub://progress` — emitted from `commands::updates::apply_update` and
/// from each `Source::apply` while a download / install is in flight.
export interface ProgressEvent {
  app_id: string;
  step: string;
  message: string;
  bytes_done: number | null;
  bytes_total: number | null;
}

/// `iptv-hub://activity` — emitted whenever a new `activity_log` row is inserted.
/// The payload is the same shape as `ActivityEntry` from `api.ts`.
export type ActivityNewEvent = ActivityEntry;

/// `iptv-hub://status` — emitted by the poller / launcher when an app's
/// status / version / sha changes.
export interface StatusChangedEvent {
  app_id: string;
  status: string;
  status_message: string | null;
  current_version: string | null;
  current_sha: string | null;
}

const EVT_PROGRESS = "iptv-hub://progress";
const EVT_ACTIVITY = "iptv-hub://activity";
const EVT_STATUS = "iptv-hub://status";

export const events = {
  onProgress: (handler: (e: ProgressEvent) => void): Promise<UnlistenFn> =>
    listen<ProgressEvent>(EVT_PROGRESS, (msg) => handler(msg.payload)),
  onActivity: (handler: (e: ActivityNewEvent) => void): Promise<UnlistenFn> =>
    listen<ActivityNewEvent>(EVT_ACTIVITY, (msg) => handler(msg.payload)),
  onStatusChanged: (handler: (e: StatusChangedEvent) => void): Promise<UnlistenFn> =>
    listen<StatusChangedEvent>(EVT_STATUS, (msg) => handler(msg.payload)),
} as const;
