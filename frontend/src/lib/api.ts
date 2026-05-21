// Typed wrappers around the Tauri command surface. As agents land new command slices,
// they extend this file. Until a command exists in the Rust handler, calling it throws
// — no fake/mock responses ever.

import { invoke } from "@tauri-apps/api/core";

export type SourceType = "git" | "release-binary" | "installer" | "web" | "tizen-ipk";
export type AppStatus = "idle" | "checking" | "ok" | "update-available" | "updating" | "error" | "running";

export interface AppView {
  id: string;
  name: string;
  source_type: SourceType;
  favorite: boolean;
  enabled: boolean;
  status: AppStatus | string;
  status_message: string | null;
  current_version: string | null;
  current_sha: string | null;
  last_poll_at: string | null;
  last_success_at: string | null;
  icon_kind: string | null;
  icon_value: string | null;
  sub_label: string;
}

export const api = {
  apps: {
    list: (): Promise<AppView[]> => invoke<AppView[]>("list_apps"),
    get: (id: string): Promise<AppView> => invoke<AppView>("get_app", { id }),
    setFavorite: (id: string, favorite: boolean): Promise<void> =>
      invoke("set_favorite", { id, favorite }),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      invoke("set_enabled", { id, enabled }),
    remove: (id: string): Promise<void> => invoke("remove_app", { id }),
  },
} as const;
