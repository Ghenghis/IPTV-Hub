// Preview-only fixtures for `frontend/preview.html`.
//
// These objects are *not* runtime test doubles in the CONTRACT.md §2.1 sense;
// they are the canned, deterministic inputs that the visual-regression page
// feeds into the real production Web Components so a Playwright
// `toHaveScreenshot()` test can pin the component states pixel-for-pixel.
//
// Rules followed when authoring the fixtures (CONTRACT §2.1):
//   - No URLs are fabricated. `AppEntry.source.url` (the manifest field) carries
//     an empty string; the operator fills it post-seed. Fixtures here use the
//     `AppView` *projection*, which never exposes a URL — so this is naturally
//     a non-issue. Where a card needs a source-identity hint it shows up as
//     `sub_label`, which is intentionally a short human-readable string.
//   - All `current_sha` values are real-looking lowercase hex of the canonical
//     length (40-char SHA-1). The poller emits the same shape in production.
//   - All `current_version` values match the SemVer pattern produced by the
//     `release-binary` and `installer` sources.
//   - All ISO timestamps are anchored at 2026-05-21 (the project owner's "today")
//     so the relative-age helper renders deterministic strings during a
//     `toHaveScreenshot()` comparison.

import type { ActivityEntry, AppView, IncomingItem, PlanStep, UpdatePlan } from "../lib/api";

// Anchor timestamps so `relativeAge()` produces stable output for screenshots.
// 2026-05-21T10:00:00Z is "now" for the preview page.
export const PREVIEW_NOW_ISO = "2026-05-21T10:00:00Z";

// Helper: ISO timestamp N minutes / hours / days before PREVIEW_NOW_ISO.
function isoOffset(offsetMs: number): string {
  return new Date(Date.parse(PREVIEW_NOW_ISO) - offsetMs).toISOString();
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------- //
// App-card fixtures
// ---------------------------------------------------------------------------- //

// 1. ok — current_version + sha, status "up_to_date".
const appOk: AppView = {
  id: "iptvnator",
  name: "IPTVnator",
  source_type: "release-binary",
  favorite: true,
  enabled: true,
  status: "up_to_date",
  status_message: null,
  current_version: "v0.18.1",
  current_sha: null,
  last_poll_at: isoOffset(12 * MIN),
  last_success_at: isoOffset(12 * MIN),
  icon_kind: "letters",
  icon_value: "IN",
  sub_label: "release-binary",
};

// 2. update_available — from→to versions visible, "Update" button active.
const appUpdate: AppView = {
  id: "stremio",
  name: "Stremio",
  source_type: "git",
  favorite: false,
  enabled: true,
  status: "update_available",
  status_message: "a3f2c1d -> 9b1e4f8",
  current_version: null,
  current_sha: "a3f2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  last_poll_at: isoOffset(2 * MIN),
  last_success_at: isoOffset(2 * MIN),
  icon_kind: "letters",
  icon_value: "ST",
  sub_label: "git · main",
};

// 3. error — status_message populated, "Retry" button visible.
const appError: AppView = {
  id: "wizju-iptv-player",
  name: "Wizju IPTV Player",
  source_type: "web",
  favorite: false,
  enabled: true,
  status: "error",
  status_message: "fetch failed: connect ETIMEDOUT after 30000ms",
  current_version: null,
  current_sha: "7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c",
  last_poll_at: isoOffset(45 * MIN),
  last_success_at: isoOffset(2 * DAY),
  icon_kind: "letters",
  icon_value: "WJ",
  sub_label: "web · npm",
};

// 4. idle — never polled, "Check" button visible.
const appIdle: AppView = {
  id: "harmony-iptv",
  name: "HarmonyIPTV",
  source_type: "installer",
  favorite: false,
  enabled: true,
  status: "idle",
  status_message: null,
  current_version: "2.4.0",
  current_sha: null,
  last_poll_at: null,
  last_success_at: null,
  icon_kind: "letters",
  icon_value: "HM",
  sub_label: "installer · MSI",
};

export const appCardVariants: ReadonlyArray<{ label: string; app: AppView }> = [
  { label: "ok — up to date", app: appOk },
  { label: "update_available — git diff", app: appUpdate },
  { label: "error — fetch failed", app: appError },
  { label: "idle — never polled", app: appIdle },
];

// ---------------------------------------------------------------------------- //
// Chip-bar fixtures
// ---------------------------------------------------------------------------- //

// Zero-count variant: empty app list, counts all 0.
export const chipBarEmpty: ReadonlyArray<AppView> = [];

// Mixed variant: 3 total, 1 update_available, 2 favorites, 1 git, 1 web, 1 installer.
const chipBarMixedApps: AppView[] = [
  // git, favorite, update_available — contributes: all+1, updates+1, favorites+1, git+1
  {
    ...appUpdate,
    favorite: true,
  },
  // web, favorite, ok — contributes: all+1, favorites+1, web+1
  {
    id: "open-tv",
    name: "Open TV",
    source_type: "web",
    favorite: true,
    enabled: true,
    status: "up_to_date",
    status_message: null,
    current_version: null,
    current_sha: "c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3",
    last_poll_at: isoOffset(35 * MIN),
    last_success_at: isoOffset(35 * MIN),
    icon_kind: "letters",
    icon_value: "OT",
    sub_label: "web · pnpm",
  },
  // installer, not-favorite, ok — contributes: all+1, installer+1
  appIdle,
];
export const chipBarMixed: ReadonlyArray<AppView> = chipBarMixedApps;

// ---------------------------------------------------------------------------- //
// Status-bar fixtures
// ---------------------------------------------------------------------------- //

// 4 apps with a mix of favourites / updates / errors so every status_bar counter
// renders a non-trivial number — matches what the production status bar shows
// on a typical day.
export const statusBarApps: ReadonlyArray<AppView> = [appOk, appUpdate, appError, appIdle];
export const STATUS_BAR_NEXT_SYNC_ISO = "2026-05-21T10:30:00Z";

// ---------------------------------------------------------------------------- //
// Activity-log fixtures (one row per level)
// ---------------------------------------------------------------------------- //
//
// The component subscribes to `iptv-hub://activity` via `events.onActivity(...)`
// and seeds itself from `api.activity.list(20, 0)`. In the preview page the
// IPC shim (see preview-entry.ts) returns these four rows from `list_activity`,
// so the component renders them through its real code path with zero changes.

export const activityRows: ReadonlyArray<ActivityEntry> = [
  {
    id: 4,
    at: isoOffset(2 * MIN),
    app_id: "iptvnator",
    action: "poll",
    message: "up to date at v0.18.1",
    level: "ok",
  },
  {
    id: 3,
    at: isoOffset(8 * MIN),
    app_id: "stremio",
    action: "update_available",
    message: "git main: 2 incoming commits, a3f2c1d -> 9b1e4f8",
    level: "info",
  },
  {
    id: 2,
    at: isoOffset(22 * MIN),
    app_id: "wizju-iptv-player",
    action: "poll",
    message: "fetch failed: connect ETIMEDOUT after 30000ms",
    level: "error",
  },
  {
    id: 1,
    at: isoOffset(1 * HOUR + 15 * MIN),
    app_id: "harmony-iptv",
    action: "registry_lookup",
    message: "installer 2.4.0 still current, registry uninstall key found",
    level: "warn",
  },
];

// ---------------------------------------------------------------------------- //
// Update-modal fixtures
// ---------------------------------------------------------------------------- //
//
// A representative git plan: 2 incoming commits, 3 plan steps with one of each
// tag (safe / time_estimate / risky). The modal renders this verbatim — no
// frontend-side copy invention (UI_SPEC §3.4).

const incomingCommits: IncomingItem[] = [
  {
    kind: "commit",
    sha: "9b1e4f8",
    message: "fix(epg): respect tz offset when grouping channels",
    author: "alice@example",
  },
  {
    kind: "commit",
    sha: "c0ffee1",
    message: "refactor(player): extract HLS source buffer into worker",
    author: "bob@example",
  },
];

const planSteps: PlanStep[] = [
  {
    title: "Fetch and verify upstream",
    detail: "git fetch origin main; verify SHA-1 chain matches local history",
    tag: "safe",
  },
  {
    title: "Reinstall npm dependencies",
    detail: "package-lock.json changed; npm ci will re-resolve the dependency tree",
    tag: "time_estimate",
  },
  {
    title: "Apply with fast-forward merge",
    detail: "git merge --ff-only 9b1e4f8 (refuses if upstream was force-pushed)",
    tag: "risky",
  },
];

export const updatePlanFixture: UpdatePlan = {
  app_id: "stremio",
  source_type: "git",
  from_label: "a3f2c1d",
  to_label: "9b1e4f8",
  from_meta: [
    { key: "branch", value: "main" },
    { key: "behind", value: "+2 commits" },
  ],
  to_meta: [
    { key: "branch", value: "main" },
    { key: "ahead", value: "+2 commits" },
  ],
  incoming: incomingCommits,
  steps: planSteps,
  rollback_retention_days: 7,
};

export const updateModalAppName = "Stremio";
