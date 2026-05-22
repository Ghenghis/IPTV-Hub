// IPTV Hub — Seed-from-folder wizard page (Agent 24).
//
// Mount with `mountSeedPage(root)`. The page is a full-shell takeover:
//   1. Operator types or pastes an apps-root path.
//   2. Pressing "Scan" hits `api.seed.fromFolder(path)` — the Rust backend
//      walks the folder, classifies each sub-directory, and returns proposed
//      AppEntry rows + a list of un-classifiable directories.
//   3. Each proposed row is rendered as an editable table line (id, name,
//      source type, launch kind, enabled toggle, favorite toggle).
//   4. Un-classifiable directories sit in a separate "Skipped" panel; the
//      operator can claim one manually — it turns into an editable row with
//      `installer` defaults.
//   5. "Apply" calls `api.apps.add(entry)` once per enabled row, displays
//      per-row success / error, and leaves failed rows on screen so the
//      operator can correct and retry without losing the whole batch.
//
// Per AGENT_PLAN §24 + MANIFEST_SCHEMA §2/§3, the entry payload is the full
// AppEntry shape Rust expects in `add_app` — including the kebab-case `type`
// rename, the source-specific `source` block, and the LaunchSpec.
//
// `@tauri-apps/plugin-dialog`'s `open` would be used for a native folder
// picker; it is not declared in `frontend/package.json`, so we fall back to a
// plain text input with an explicit pasted-path hint. The Tauri Rust side
// still ships `tauri-plugin-dialog`, so a future package add can wire the
// picker in without changing this file's contract.

import { api, type AppEntry, type SeedScanView, type SourceType } from "../lib/api";

/// Launch kinds known to the manifest schema (mirrors
/// `src-tauri/src/manifest/types.rs::LaunchKind`). The wizard exposes the
/// full set so the operator can fix a misclassified launch without
/// re-running the scan.
const LAUNCH_KINDS = ["executable", "npm", "tauri-dev", "exe-shortcut", "web-url", "tizen-deploy"] as const;
type LaunchKind = (typeof LAUNCH_KINDS)[number];

/// Source types known to the manifest schema. Same source of truth as
/// `lib/api.ts::SourceType`.
const SOURCE_TYPES: readonly SourceType[] = [
  "git",
  "release-binary",
  "installer",
  "web",
  "tizen-ipk",
] as const;

interface SeedRowState {
  /// Stable key — generated client-side so React-style identity survives
  /// edits to the visible `id`.
  rowKey: string;
  entry: AppEntry;
  /// Mirrors of `entry`'s editable fields. Kept in a typed shape so the
  /// renderer doesn't have to `as`-cast through `Record<string, unknown>`.
  id: string;
  name: string;
  sourceType: SourceType;
  launchKind: LaunchKind;
  favorite: boolean;
  enabled: boolean;
  /// Result of the last `api.apps.add(entry)` for this row.
  applyStatus: "idle" | "inflight" | "ok" | "error";
  applyMessage: string;
}

interface SkippedRowState {
  rowKey: string;
  path: string;
  claimed: boolean;
}

interface PageState {
  folderPath: string;
  scanInflight: boolean;
  scanError: string | null;
  applyInflight: boolean;
  rows: SeedRowState[];
  skipped: SkippedRowState[];
  /// Counter so re-scans never collide with leftover keys from previous runs.
  keyCounter: number;
}

const initialState: PageState = {
  folderPath: "",
  scanInflight: false,
  scanError: null,
  applyInflight: false,
  rows: [],
  skipped: [],
  keyCounter: 0,
};

// ---------------------------------------------------------------------------- //
// Utilities
// ---------------------------------------------------------------------------- //

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/// Pull a string field out of an unknown record without `any`. Returns the
/// default when the field is missing or not a string.
function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function readBool(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function readSourceType(record: Record<string, unknown>): SourceType {
  const value = record["type"];
  if (typeof value === "string" && (SOURCE_TYPES as readonly string[]).includes(value)) {
    return value as SourceType;
  }
  return "git";
}

function readLaunchKind(record: Record<string, unknown>): LaunchKind {
  const launch = record["launch"];
  if (launch !== null && typeof launch === "object") {
    const kindValue = (launch as Record<string, unknown>)["kind"];
    if (typeof kindValue === "string" && (LAUNCH_KINDS as readonly string[]).includes(kindValue)) {
      return kindValue as LaunchKind;
    }
  }
  return "executable";
}

/// Convert an arbitrary folder name into a kebab-case id. Mirrors the Rust
/// `crate::seed::to_kebab_case` helper.
function toKebabCase(input: string): string {
  let out = "";
  let lastDash = true;
  for (const ch of input) {
    if (/[a-z0-9]/i.test(ch)) {
      out += ch.toLowerCase();
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out;
}

// ---------------------------------------------------------------------------- //
// Row state derivation
// ---------------------------------------------------------------------------- //

function buildRowState(entry: AppEntry, keyCounter: { value: number }): SeedRowState {
  keyCounter.value += 1;
  return {
    rowKey: `seed-row-${String(keyCounter.value)}`,
    entry,
    id: readString(entry, "id", ""),
    name: readString(entry, "name", ""),
    sourceType: readSourceType(entry),
    launchKind: readLaunchKind(entry),
    favorite: readBool(entry, "favorite", false),
    enabled: readBool(entry, "enabled", true),
    applyStatus: "idle",
    applyMessage: "",
  };
}

function buildSkippedState(path: string, keyCounter: { value: number }): SkippedRowState {
  keyCounter.value += 1;
  return {
    rowKey: `seed-skipped-${String(keyCounter.value)}`,
    path,
    claimed: false,
  };
}

/// Build an installer-shaped AppEntry from a raw folder path so that a
/// "claimed" skipped row joins the main table with sensible defaults.
function entryFromClaimedPath(path: string): AppEntry {
  // Pull the last path segment as the folder name on either separator.
  const lastSep = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const folderName = lastSep >= 0 ? path.slice(lastSep + 1) : path;
  const id = toKebabCase(folderName) || "new-app";
  return {
    id,
    name: folderName || id,
    type: "installer",
    favorite: false,
    enabled: true,
    icon: { kind: "initials", value: id.slice(0, 2).toUpperCase() },
    launch: {
      kind: "exe-shortcut",
      command: "",
      args: [],
      env: {},
    },
    source: {
      vendor: folderName,
      product_name: folderName,
      registry_uninstall_key: "",
      download_url: "",
      install_args: ["/S"],
    },
  };
}

/// Serialise the editable form fields back into the underlying AppEntry so
/// `api.apps.add` receives the up-to-date payload the operator just typed.
function syncRowToEntry(row: SeedRowState): AppEntry {
  const merged: Record<string, unknown> = { ...row.entry };
  merged["id"] = row.id;
  merged["name"] = row.name;
  merged["type"] = row.sourceType;
  merged["favorite"] = row.favorite;
  merged["enabled"] = row.enabled;

  const existingLaunch = row.entry["launch"];
  const launchRecord: Record<string, unknown> =
    existingLaunch !== null && typeof existingLaunch === "object"
      ? { ...(existingLaunch as Record<string, unknown>) }
      : { args: [], env: {} };
  launchRecord["kind"] = row.launchKind;
  merged["launch"] = launchRecord;

  return merged;
}

// ---------------------------------------------------------------------------- //
// Rendering
// ---------------------------------------------------------------------------- //

function renderShell(state: PageState): string {
  const apps = state.rows.length;
  const skipped = state.skipped.filter((s) => !s.claimed).length;
  const claimed = state.skipped.filter((s) => s.claimed).length;
  const enabled = state.rows.filter((r) => r.enabled).length;

  return `
    <div class="seed-page">
      <header class="seed-page__header">
        <span class="seed-page__title">Seed from folder</span>
        <span class="seed-page__subtitle">Scan an apps-root directory, edit the proposal, save into apps.json.</span>
        <div class="seed-page__header-actions">
          <button class="btn-secondary" id="seed-reset" ${
            state.rows.length === 0 && state.skipped.length === 0 ? "disabled" : ""
          }>Reset</button>
          <button class="btn-primary" id="seed-apply" ${
            enabled === 0 || state.applyInflight ? "disabled" : ""
          }>${state.applyInflight ? "Applying…" : `Apply ${String(enabled)} enabled`}</button>
        </div>
      </header>

      <div class="seed-page__body" id="seed-body">
        ${renderScanPanel(state)}
        ${state.rows.length > 0 ? renderAppsSection(state) : ""}
        ${state.skipped.length > 0 ? renderSkippedSection(state) : ""}
        ${state.rows.length === 0 && state.skipped.length === 0 && !state.scanInflight && state.scanError === null ? `<div class="seed-empty">No scan run yet. Enter a folder path above and press Scan.</div>` : ""}
      </div>

      <footer class="seed-page__footer">
        <span>${String(apps)} apps proposed</span>
        <span class="seed-page__footer-sep">·</span>
        <span>${String(enabled)} enabled</span>
        <span class="seed-page__footer-sep">·</span>
        <span>${String(skipped)} skipped</span>
        ${claimed > 0 ? `<span class="seed-page__footer-sep">·</span><span>${String(claimed)} claimed</span>` : ""}
      </footer>
    </div>
  `;
}

function renderScanPanel(state: PageState): string {
  const value = escapeHtml(state.folderPath);
  const scanLabel = state.scanInflight ? "Scanning…" : "Scan";
  return `
    <section class="seed-scan-panel" aria-labelledby="seed-scan-title">
      <h2 id="seed-scan-title" class="seed-section__title">1 · Choose folder</h2>
      <div class="seed-scan-panel__row">
        <input
          id="seed-folder-input"
          type="text"
          placeholder="C:\\IPTV\\upstream"
          value="${value}"
          spellcheck="false"
          autocomplete="off"
          aria-label="Apps root folder path"
        />
        <button class="btn-primary" id="seed-scan-btn" ${state.scanInflight ? "disabled" : ""}>
          ${scanLabel}
        </button>
      </div>
      <div class="seed-scan-panel__hint">
        Paste an absolute Windows path (e.g. <code>C:\\IPTV\\upstream</code>). The scanner walks every
        immediate sub-directory and classifies it as git, web, installer, tizen-ipk, or skipped.
      </div>
      ${state.scanError !== null ? `<div class="seed-scan-panel__error">scan failed: ${escapeHtml(state.scanError)}</div>` : ""}
    </section>
  `;
}

function statusCell(row: SeedRowState): string {
  switch (row.applyStatus) {
    case "idle":
      return `<span class="seed-status--idle">idle</span>`;
    case "inflight":
      return `<span class="seed-status--inflight">adding…</span>`;
    case "ok":
      return `<span class="seed-status--ok">added</span>`;
    case "error":
      return `<span class="seed-status--err" title="${escapeHtml(row.applyMessage)}">error</span>`;
    default: {
      // Exhaustive fallthrough guard — `applyStatus` is a closed union so this
      // is unreachable; we still emit a deterministic cell so a future variant
      // doesn't produce a blank cell.
      const exhaustive: never = row.applyStatus;
      return escapeHtml(String(exhaustive));
    }
  }
}

function rowClass(row: SeedRowState): string {
  const classes: string[] = [];
  if (!row.enabled) classes.push("seed-row--disabled");
  if (row.applyStatus === "ok") classes.push("seed-row--success");
  if (row.applyStatus === "error") classes.push("seed-row--error");
  return classes.join(" ");
}

function renderAppsSection(state: PageState): string {
  const headers = `
    <thead>
      <tr>
        <th style="width: 56px;">enabled</th>
        <th style="width: 56px;">fav</th>
        <th>id</th>
        <th>name</th>
        <th>source type</th>
        <th>launch kind</th>
        <th>status</th>
      </tr>
    </thead>
  `;

  const body = state.rows
    .map((row) => {
      return `
        <tr class="${rowClass(row)}" data-row-key="${row.rowKey}">
          <td class="seed-cell--toggle">
            <input type="checkbox" data-field="enabled" ${row.enabled ? "checked" : ""} />
          </td>
          <td class="seed-cell--toggle">
            <input type="checkbox" data-field="favorite" ${row.favorite ? "checked" : ""} />
          </td>
          <td>
            <input type="text" data-field="id" value="${escapeHtml(row.id)}" spellcheck="false" />
          </td>
          <td>
            <input type="text" data-field="name" value="${escapeHtml(row.name)}" spellcheck="false" />
          </td>
          <td>
            <select data-field="sourceType">
              ${SOURCE_TYPES.map(
                (t) => `<option value="${t}" ${row.sourceType === t ? "selected" : ""}>${t}</option>`,
              ).join("")}
            </select>
          </td>
          <td>
            <select data-field="launchKind">
              ${LAUNCH_KINDS.map(
                (k) => `<option value="${k}" ${row.launchKind === k ? "selected" : ""}>${k}</option>`,
              ).join("")}
            </select>
          </td>
          <td class="seed-cell--status">${statusCell(row)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <section class="seed-section" aria-labelledby="seed-apps-title">
      <div class="seed-section__header">
        <h2 id="seed-apps-title" class="seed-section__title">2 · Proposed apps<span class="seed-section__count">${String(state.rows.length)} row(s)</span></h2>
      </div>
      <table class="seed-table">
        ${headers}
        <tbody>${body}</tbody>
      </table>
    </section>
  `;
}

function renderSkippedSection(state: PageState): string {
  const list = state.skipped
    .map((s) => {
      const cls = s.claimed ? "seed-skipped__row seed-skipped__row--claimed" : "seed-skipped__row";
      return `
        <li class="${cls}" data-row-key="${s.rowKey}">
          <span class="seed-skipped__path">${escapeHtml(s.path)}</span>
          <button class="seed-btn-small" data-action="claim" ${s.claimed ? "disabled" : ""}>
            ${s.claimed ? "claimed" : "classify manually"}
          </button>
        </li>
      `;
    })
    .join("");

  return `
    <section class="seed-section seed-skipped" aria-labelledby="seed-skipped-title">
      <div class="seed-section__header">
        <h2 id="seed-skipped-title" class="seed-section__title">3 · Skipped<span class="seed-section__count">${String(state.skipped.length)} entry(ies)</span></h2>
      </div>
      <ul class="seed-skipped__list">${list}</ul>
    </section>
  `;
}

// ---------------------------------------------------------------------------- //
// Mount
// ---------------------------------------------------------------------------- //

export function mountSeedPage(root: HTMLElement): void {
  const state: PageState = { ...initialState, rows: [], skipped: [] };
  const keyCounter = { value: state.keyCounter };

  const draw = (): void => {
    root.innerHTML = renderShell(state);
    bindEvents();
  };

  const bindEvents = (): void => {
    const folderInput = document.getElementById("seed-folder-input");
    if (folderInput instanceof HTMLInputElement) {
      folderInput.addEventListener("input", () => {
        state.folderPath = folderInput.value;
      });
      folderInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          void runScan();
        }
      });
    }

    document.getElementById("seed-scan-btn")?.addEventListener("click", () => {
      void runScan();
    });
    document.getElementById("seed-apply")?.addEventListener("click", () => {
      void runApply();
    });
    document.getElementById("seed-reset")?.addEventListener("click", () => {
      state.rows = [];
      state.skipped = [];
      state.scanError = null;
      state.applyInflight = false;
      draw();
    });

    // Wire every row's editable controls.
    document.querySelectorAll<HTMLElement>("[data-row-key]").forEach((el) => {
      const key = el.dataset["rowKey"];
      if (key === undefined) return;
      bindRow(el, key);
    });
  };

  const bindRow = (rowEl: HTMLElement, rowKey: string): void => {
    rowEl.querySelectorAll<HTMLElement>("[data-field]").forEach((field) => {
      const name = field.dataset["field"];
      if (name === undefined) return;
      const update = (): void => {
        const row = state.rows.find((r) => r.rowKey === rowKey);
        if (row === undefined) return;
        applyFieldEdit(row, name, field);
        // Edits in disabled/error/success-coloured rows reset the apply
        // status so the operator sees their edit acknowledged.
        if (row.applyStatus === "error") {
          row.applyStatus = "idle";
          row.applyMessage = "";
        }
        // Toggle changes affect coloured row class + footer counters → repaint.
        if (name === "enabled" || name === "favorite" || name === "sourceType" || name === "launchKind") {
          draw();
        }
      };
      const eventName =
        field instanceof HTMLInputElement && field.type === "checkbox"
          ? "change"
          : field instanceof HTMLSelectElement
            ? "change"
            : "input";
      field.addEventListener(eventName, update);
    });

    // Skipped-panel claim button.
    rowEl.querySelectorAll<HTMLButtonElement>("button[data-action='claim']").forEach((btn) => {
      btn.addEventListener("click", () => {
        const skip = state.skipped.find((s) => s.rowKey === rowKey);
        if (skip === undefined || skip.claimed) return;
        skip.claimed = true;
        const entry = entryFromClaimedPath(skip.path);
        state.rows.push(buildRowState(entry, keyCounter));
        draw();
      });
    });
  };

  const applyFieldEdit = (row: SeedRowState, field: string, el: HTMLElement): void => {
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox") {
        if (field === "enabled") row.enabled = el.checked;
        else if (field === "favorite") row.favorite = el.checked;
        return;
      }
      if (field === "id") row.id = el.value;
      else if (field === "name") row.name = el.value;
      return;
    }
    if (el instanceof HTMLSelectElement) {
      if (field === "sourceType") {
        const v = el.value;
        if ((SOURCE_TYPES as readonly string[]).includes(v)) {
          row.sourceType = v as SourceType;
        }
      } else if (field === "launchKind") {
        const v = el.value;
        if ((LAUNCH_KINDS as readonly string[]).includes(v)) {
          row.launchKind = v as LaunchKind;
        }
      }
    }
  };

  const runScan = async (): Promise<void> => {
    const path = state.folderPath.trim();
    if (path.length === 0) {
      state.scanError = "folder path is empty";
      draw();
      return;
    }
    state.scanInflight = true;
    state.scanError = null;
    state.rows = [];
    state.skipped = [];
    draw();
    try {
      const view: SeedScanView = await api.seed.fromFolder(path);
      // The backend returns AppView shapes (with snake_case `source_type`) for
      // the `apps` field; for `add_app` we need the manifest's AppEntry shape
      // (with kebab-case `type`). Translate by copying `source_type` →
      // `type` and dropping the view-only fields. Other fields from the scan
      // already match the manifest shape so they round-trip untouched.
      const entries: AppEntry[] = view.apps.map((appView) => {
        const view: Record<string, unknown> = { ...(appView as unknown as Record<string, unknown>) };
        // Be defensive: the scanner currently returns the full AppEntry
        // (Rust types alias `apps: Vec<AppEntry>` for SeedScanView), so a
        // `type` key already exists. If a future change starts returning
        // AppView-shaped rows, translate snake_case to the schema's rename.
        if (view["type"] === undefined && typeof view["source_type"] === "string") {
          view["type"] = view["source_type"];
        }
        delete view["source_type"];
        delete view["status"];
        delete view["status_message"];
        delete view["sub_label"];
        delete view["current_version"];
        delete view["current_sha"];
        delete view["last_poll_at"];
        delete view["last_success_at"];
        delete view["icon_kind"];
        delete view["icon_value"];
        return view;
      });
      state.rows = entries.map((e) => buildRowState(e, keyCounter));
      state.skipped = view.unclassified.map((p) => buildSkippedState(p, keyCounter));
    } catch (err) {
      state.scanError = errorMessage(err);
    } finally {
      state.scanInflight = false;
      draw();
    }
  };

  const runApply = async (): Promise<void> => {
    if (state.applyInflight) return;
    state.applyInflight = true;
    draw();
    try {
      // Sequential: each `add_app` mutates the manifest and the next call
      // needs the previous one's row to be persisted to detect duplicate ids.
      for (const row of state.rows) {
        if (!row.enabled) continue;
        if (row.applyStatus === "ok") continue;
        row.applyStatus = "inflight";
        row.applyMessage = "";
        draw();
        try {
          const entry = syncRowToEntry(row);
          await api.apps.add(entry);
          row.applyStatus = "ok";
          row.applyMessage = "added";
        } catch (err) {
          row.applyStatus = "error";
          row.applyMessage = errorMessage(err);
        }
        draw();
      }
    } finally {
      state.applyInflight = false;
      draw();
    }
  };

  draw();
}
