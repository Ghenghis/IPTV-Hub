// Settings page — three-tab control surface (Agent 23 slice).
//
// Tabs:
//   1. General        — theme, poll interval, retention windows, GitHub token (masked).
//                       Reads via `api.settings.get()`, writes per-key via
//                       `api.settings.set(key, value)`.
//   2. Sources        — full CRUD on every manifest entry. Lists apps via
//                       `api.apps.list()`. Add via `api.apps.add(entry)` from a JSON
//                       dialog. Remove via `api.apps.remove(id)`. Inline toggles call
//                       `api.apps.setFavorite` / `api.apps.setEnabled`.
//   3. Update history — global view. Lazy-fetches per-app history via
//                       `api.activity.history(appId, 50)` for every app on first tab
//                       activation, merges, sorts newest-first.
//
// The page is light DOM, vanilla TS, no framework. The host (main.ts) decides when
// to call `mountSettingsPage(root)`. Returns an unmount function that releases the
// `iptv-hub://status` event subscription so the page can be re-mounted cleanly.

import { api, type AppEntry, type AppView, type SettingsView, type UpdateHistoryEntry } from "../lib/api";
import { events, type StatusChangedEvent } from "../lib/events";

// ─────────────────────────────────────────────────────────────────────────────
// Internal state — module-local so a re-mount starts from a clean slate.
// ─────────────────────────────────────────────────────────────────────────────

type TabId = "general" | "sources" | "history";

interface State {
  root: HTMLElement | null;
  tab: TabId;
  settings: SettingsView | null;
  apps: AppView[];
  history: UpdateHistoryEntry[];
  historyLoaded: boolean;
  historyError: string | null;
  appsError: string | null;
  generalError: string | null;
  showToken: boolean;
}

const state: State = {
  root: null,
  tab: "general",
  settings: null,
  apps: [],
  history: [],
  historyLoaded: false,
  historyError: null,
  appsError: null,
  generalError: null,
  showToken: false,
};

let unlistenStatus: (() => void) | null = null;
// True between `unmountSettingsPage()` and the next `mountSettingsPage()`. The
// async subscribe to `events.onStatusChanged()` may resolve after unmount; if
// that happens with `disposed=true` we immediately call the freshly-returned
// `unlisten` instead of stashing it, which would otherwise leak the listener.
let disposed = false;

// ─────────────────────────────────────────────────────────────────────────────
// HTML escape — used everywhere we interpolate untrusted data into innerHTML.
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point — host wires this when the user opens the settings page.
// ─────────────────────────────────────────────────────────────────────────────

export function mountSettingsPage(root: HTMLElement): () => void {
  state.root = root;
  state.tab = "general";
  state.settings = null;
  state.apps = [];
  state.history = [];
  state.historyLoaded = false;
  state.historyError = null;
  state.appsError = null;
  state.generalError = null;
  state.showToken = false;

  root.classList.add("settings-page");
  // Reset disposed for this mount cycle; without this, a remount after unmount
  // would inherit the previous tear-down state and immediately throw away the
  // next subscription.
  disposed = false;
  render();

  // Subscribe to status changes from the poller / launcher so the Sources tab
  // reflects live updates (status / version / sha). The unlisten function is
  // returned from `events.onStatusChanged` and we save it for the unmount call.
  //
  // Race fix: the `.then((unlisten) => ...)` may resolve AFTER the user already
  // navigated away (unmountSettingsPage ran). Without the `disposed` guard the
  // listener would be silently stashed, never freed, and continue forwarding
  // events into the now-detached component. Check the flag and free immediately
  // on the late path.
  void events
    .onStatusChanged((evt: StatusChangedEvent) => {
      if (disposed) return;
      const idx = state.apps.findIndex((a) => a.id === evt.app_id);
      if (idx < 0) return;
      const prev = state.apps[idx];
      if (!prev) return;
      state.apps[idx] = {
        ...prev,
        status: evt.status,
        status_message: evt.status_message,
        current_version: evt.current_version,
        current_sha: evt.current_sha,
      };
      if (state.tab === "sources") renderTabBody();
    })
    .then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlistenStatus = unlisten;
    })
    .catch((err: unknown) => {
      if (disposed) return;
      // Surface the subscription failure in the Sources tab; it is non-fatal.
      state.appsError = `live status updates unavailable: ${describeError(err)}`;
      if (state.tab === "sources") renderTabBody();
    });

  void loadGeneral();
  void loadApps();

  return unmountSettingsPage;
}

function unmountSettingsPage(): void {
  // Mark disposed FIRST so any still-in-flight subscribe promise observes the
  // flag inside its `.then` handler and frees its listener instead of stashing
  // it. Order matters: flipping `disposed` after calling `unlistenStatus()`
  // would still race the in-flight promise.
  disposed = true;
  if (unlistenStatus) {
    unlistenStatus();
    unlistenStatus = null;
  }
  const root = state.root;
  if (root) {
    root.replaceChildren();
    root.classList.remove("settings-page");
  }
  state.root = null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────

async function loadGeneral(): Promise<void> {
  try {
    state.settings = await api.settings.get();
    state.generalError = null;
  } catch (err) {
    state.settings = null;
    state.generalError = `failed to load settings: ${describeError(err)}`;
  }
  if (state.tab === "general") renderTabBody();
}

async function loadApps(): Promise<void> {
  try {
    state.apps = await api.apps.list();
    state.appsError = null;
  } catch (err) {
    state.apps = [];
    state.appsError = `failed to load apps: ${describeError(err)}`;
  }
  if (state.tab === "sources") renderTabBody();
  // History is computed from `apps` so invalidate the cache when apps reload.
  if (state.historyLoaded) {
    state.historyLoaded = false;
    state.history = [];
    if (state.tab === "history") void loadHistory();
  }
}

async function loadHistory(): Promise<void> {
  state.historyLoaded = false;
  state.historyError = null;
  state.history = [];
  if (state.tab === "history") renderTabBody();

  if (state.apps.length === 0) {
    try {
      state.apps = await api.apps.list();
    } catch (err) {
      state.historyError = `failed to load apps for history: ${describeError(err)}`;
      state.historyLoaded = true;
      if (state.tab === "history") renderTabBody();
      return;
    }
  }

  try {
    const perApp = await Promise.all(
      state.apps.map((a) =>
        api.activity.history(a.id, 50).catch((err: unknown): UpdateHistoryEntry[] => {
          // One app's history failing should not poison the whole view. Emit a
          // synthetic row with the error so the operator can see it.
          return [
            {
              id: -1,
              started_at: new Date().toISOString(),
              app_id: a.id,
              from_version: null,
              to_version: null,
              outcome: "error",
              error_message: `history fetch failed: ${describeError(err)}`,
            },
          ];
        }),
      ),
    );
    const merged = perApp.flat();
    merged.sort((a, b) => {
      const ta = Date.parse(a.started_at);
      const tb = Date.parse(b.started_at);
      const safeA = Number.isNaN(ta) ? 0 : ta;
      const safeB = Number.isNaN(tb) ? 0 : tb;
      return safeB - safeA;
    });
    state.history = merged;
    state.historyError = null;
  } catch (err) {
    state.historyError = `failed to load update history: ${describeError(err)}`;
  } finally {
    state.historyLoaded = true;
    if (state.tab === "history") renderTabBody();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function render(): void {
  const root = state.root;
  if (!root) return;

  root.innerHTML = `
    <section class="settings">
      <header class="settings__header">
        <h1 class="settings__title">Settings</h1>
      </header>
      <div class="settings__tablist" role="tablist" aria-label="Settings sections">
        ${tabButton("general", "General")}
        ${tabButton("sources", "Sources")}
        ${tabButton("history", "Update history")}
      </div>
      <div class="settings__body" id="settings-body" role="tabpanel"
           aria-labelledby="settings-tab-${state.tab}"></div>
    </section>
  `;

  root.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset["settingsTab"] as TabId | undefined;
      if (!next || next === state.tab) return;
      state.tab = next;
      render();
      if (next === "history" && !state.historyLoaded) {
        void loadHistory();
      }
    });
  });

  renderTabBody();
}

function tabButton(id: TabId, label: string): string {
  const selected = state.tab === id;
  return `
    <button id="settings-tab-${id}"
            data-settings-tab="${id}"
            class="settings__tab"
            role="tab"
            aria-selected="${selected}"
            tabindex="${selected ? 0 : -1}">
      ${escapeHtml(label)}
    </button>`;
}

function renderTabBody(): void {
  const root = state.root;
  if (!root) return;
  const body = root.querySelector<HTMLDivElement>("#settings-body");
  if (!body) return;

  switch (state.tab) {
    case "general":
      renderGeneral(body);
      break;
    case "sources":
      renderSources(body);
      break;
    case "history":
      renderHistory(body);
      break;
  }
}

// ─── General tab ─────────────────────────────────────────────────────────────

function renderGeneral(body: HTMLDivElement): void {
  const s = state.settings;
  if (!s) {
    body.innerHTML = state.generalError
      ? `<div class="settings__error">${escapeHtml(state.generalError)}</div>`
      : `<div class="settings__loading">Loading settings…</div>`;
    return;
  }

  body.innerHTML = `
    <div class="settings__panel">
      ${state.generalError ? `<div class="settings__error">${escapeHtml(state.generalError)}</div>` : ""}

      <div class="settings__field">
        <label class="settings__label" for="set-theme">Theme</label>
        <select id="set-theme" class="settings__input" data-setting-key="theme">
          <option value="system" ${s.theme === "system" ? "selected" : ""}>System</option>
          <option value="dark" ${s.theme === "dark" ? "selected" : ""}>Dark</option>
          <option value="light" ${s.theme === "light" ? "selected" : ""}>Light</option>
        </select>
        <span class="settings__hint" data-result-for="theme"></span>
      </div>

      <div class="settings__field">
        <label class="settings__label" for="set-poll-interval">Default poll interval (minutes)</label>
        <input id="set-poll-interval"
               class="settings__input"
               type="number"
               min="1"
               max="1440"
               value="${escapeHtml(String(s.default_poll_interval_minutes))}"
               data-setting-key="default_poll_interval_minutes" />
        <span class="settings__hint" data-result-for="default_poll_interval_minutes"></span>
      </div>

      <div class="settings__field">
        <label class="settings__label" for="set-poll-concurrency">Poll concurrency</label>
        <input id="set-poll-concurrency"
               class="settings__input"
               type="number"
               min="1"
               max="16"
               value="${escapeHtml(String(s.poll_concurrency))}"
               data-setting-key="poll_concurrency" />
        <span class="settings__hint" data-result-for="poll_concurrency"></span>
      </div>

      <div class="settings__field">
        <label class="settings__label" for="set-snap-retention">Snapshot retention (days)</label>
        <input id="set-snap-retention"
               class="settings__input"
               type="number"
               min="0"
               max="365"
               value="${escapeHtml(String(s.snapshot_retention_days))}"
               data-setting-key="snapshot_retention_days" />
        <span class="settings__hint" data-result-for="snapshot_retention_days"></span>
      </div>

      <div class="settings__field">
        <label class="settings__label" for="set-activity-retention">Activity log retention (days)</label>
        <input id="set-activity-retention"
               class="settings__input"
               type="number"
               min="0"
               max="365"
               value="${escapeHtml(String(s.activity_log_retention_days))}"
               data-setting-key="activity_log_retention_days" />
        <span class="settings__hint" data-result-for="activity_log_retention_days"></span>
      </div>

      <div class="settings__field">
        <label class="settings__label" for="set-github-token">GitHub token</label>
        <div class="settings__token-row">
          <input id="set-github-token"
                 class="settings__input settings__input--token"
                 type="${state.showToken ? "text" : "password"}"
                 autocomplete="off"
                 spellcheck="false"
                 value="${escapeHtml(s.github_token ?? "")}"
                 placeholder="ghp_…" />
          <button type="button" class="settings__token-toggle" id="set-github-token-toggle"
                  aria-pressed="${state.showToken}">
            ${state.showToken ? "Hide" : "Show"}
          </button>
          <button type="button" class="settings__button" id="set-github-token-save">Save</button>
          <button type="button" class="settings__button settings__button--ghost" id="set-github-token-clear">
            Clear
          </button>
        </div>
        <span class="settings__hint" data-result-for="github_token"></span>
        <p class="settings__help">
          Used to raise GitHub API rate limits for release / git sources. Stored via the OS
          keychain; saving an empty value clears the stored token.
        </p>
      </div>
    </div>
  `;

  // Wire generic inputs with `data-setting-key` so a blur or change writes the
  // value back via `api.settings.set`. Each call shows a small success/error
  // indicator next to the input.
  body.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-setting-key]").forEach((el) => {
    const key = el.dataset["settingKey"] ?? "";
    if (!key) return;
    const eventName = el.tagName === "SELECT" ? "change" : "blur";
    el.addEventListener(eventName, () => {
      const value = el.value.trim();
      void saveSetting(key, value, body);
    });
  });

  // GitHub token has dedicated controls because of show/hide and explicit save.
  const tokenInput = body.querySelector<HTMLInputElement>("#set-github-token");
  const toggleBtn = body.querySelector<HTMLButtonElement>("#set-github-token-toggle");
  const saveBtn = body.querySelector<HTMLButtonElement>("#set-github-token-save");
  const clearBtn = body.querySelector<HTMLButtonElement>("#set-github-token-clear");

  toggleBtn?.addEventListener("click", () => {
    state.showToken = !state.showToken;
    if (tokenInput) tokenInput.type = state.showToken ? "text" : "password";
    if (toggleBtn) {
      toggleBtn.textContent = state.showToken ? "Hide" : "Show";
      toggleBtn.setAttribute("aria-pressed", state.showToken ? "true" : "false");
    }
  });

  saveBtn?.addEventListener("click", () => {
    const value = tokenInput?.value ?? "";
    void saveSetting("github_token", value, body);
  });

  clearBtn?.addEventListener("click", () => {
    if (tokenInput) tokenInput.value = "";
    void saveSetting("github_token", "", body);
  });
}

async function saveSetting(key: string, value: string, body: HTMLDivElement): Promise<void> {
  const hint = body.querySelector<HTMLSpanElement>(`[data-result-for="${cssEscape(key)}"]`);
  if (hint) {
    hint.textContent = "Saving…";
    hint.className = "settings__hint settings__hint--pending";
  }
  try {
    await api.settings.set(key, value);
    // Mirror the change into the local cache so subsequent renders show the
    // freshly-saved value instead of reverting to the original.
    if (state.settings) {
      state.settings = mergeSettings(state.settings, key, value);
    }
    if (hint) {
      hint.textContent = key === "github_token" && value === "" ? "Cleared" : "Saved";
      hint.className = "settings__hint settings__hint--ok";
    }
  } catch (err) {
    if (hint) {
      hint.textContent = `Save failed: ${describeError(err)}`;
      hint.className = "settings__hint settings__hint--err";
    }
  }
}

function mergeSettings(current: SettingsView, key: string, value: string): SettingsView {
  const next: SettingsView = { ...current };
  const num = Number.parseInt(value, 10);
  switch (key) {
    case "theme":
      next.theme = value;
      break;
    case "default_poll_interval_minutes":
      if (!Number.isNaN(num)) next.default_poll_interval_minutes = num;
      break;
    case "poll_concurrency":
      if (!Number.isNaN(num)) next.poll_concurrency = num;
      break;
    case "snapshot_retention_days":
      if (!Number.isNaN(num)) next.snapshot_retention_days = num;
      break;
    case "activity_log_retention_days":
      if (!Number.isNaN(num)) next.activity_log_retention_days = num;
      break;
    case "github_token":
      next.github_token = value === "" ? null : value;
      break;
    default:
      break;
  }
  return next;
}

// CSS.escape polyfill — older WebKit lacks it. Used for attribute selectors.
function cssEscape(s: string): string {
  if (typeof (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape === "function") {
    const cssNs = (globalThis as { CSS: { escape: (v: string) => string } }).CSS;
    return cssNs.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// ─── Sources tab ─────────────────────────────────────────────────────────────

function renderSources(body: HTMLDivElement): void {
  const apps = state.apps;
  const error = state.appsError;

  body.innerHTML = `
    <div class="settings__panel">
      <div class="settings__sources-toolbar">
        <button type="button" class="settings__button settings__button--primary" id="sources-add">
          Add source
        </button>
        <button type="button" class="settings__button settings__button--ghost" id="sources-refresh">
          Refresh
        </button>
        <span class="settings__hint" id="sources-result"></span>
      </div>
      ${error ? `<div class="settings__error">${escapeHtml(error)}</div>` : ""}
      <ul class="settings__source-list" id="settings-source-list" role="list"></ul>
    </div>
  `;

  const list = body.querySelector<HTMLUListElement>("#settings-source-list");
  if (list) {
    if (apps.length === 0 && !error) {
      list.innerHTML = `<li class="settings__source-empty">No sources configured.</li>`;
    } else {
      for (const app of apps) {
        list.appendChild(sourceRow(app));
      }
    }
  }

  body.querySelector<HTMLButtonElement>("#sources-add")?.addEventListener("click", () => {
    openAddDialog(body);
  });
  body.querySelector<HTMLButtonElement>("#sources-refresh")?.addEventListener("click", () => {
    void loadApps();
  });
}

function sourceRow(app: AppView): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "settings__source-row";
  li.dataset["appId"] = app.id;

  const sourceLabel = sourceTypeLabel(app.source_type);
  const versionLabel = app.current_sha ?? app.current_version ?? "—";

  li.innerHTML = `
    <div class="settings__source-main">
      <div class="settings__source-title">
        <span class="settings__source-name">${escapeHtml(app.name)}</span>
        <span class="settings__source-pill settings__source-pill--${escapeHtml(sourceLabel.cls)}">
          ${escapeHtml(sourceLabel.label)}
        </span>
      </div>
      <div class="settings__source-sub">
        <code>${escapeHtml(app.id)}</code>
        <span>${escapeHtml(versionLabel)}</span>
        <span>${escapeHtml(app.status)}</span>
      </div>
    </div>
    <div class="settings__source-controls">
      <label class="settings__toggle">
        <input type="checkbox" data-source-action="favorite" ${app.favorite ? "checked" : ""} />
        <span>Favorite</span>
      </label>
      <label class="settings__toggle">
        <input type="checkbox" data-source-action="enabled" ${app.enabled ? "checked" : ""} />
        <span>Enabled</span>
      </label>
      <button type="button" class="settings__button settings__button--ghost"
              data-source-action="remove">
        Remove
      </button>
      <span class="settings__hint" data-row-result></span>
    </div>
  `;

  li.querySelectorAll<HTMLInputElement | HTMLButtonElement>("[data-source-action]").forEach((el) => {
    const action = el.dataset["sourceAction"] ?? "";
    el.addEventListener("click", (ev) => {
      handleSourceAction(app, action, el, li, ev);
    });
  });

  return li;
}

function handleSourceAction(
  app: AppView,
  action: string,
  control: HTMLInputElement | HTMLButtonElement,
  row: HTMLLIElement,
  ev: Event,
): void {
  const hint = row.querySelector<HTMLSpanElement>("[data-row-result]");
  const setHint = (cls: string, text: string): void => {
    if (!hint) return;
    hint.className = `settings__hint ${cls}`;
    hint.textContent = text;
  };

  switch (action) {
    case "favorite": {
      const input = control as HTMLInputElement;
      const next = input.checked;
      setHint("settings__hint--pending", "Saving…");
      void api.apps
        .setFavorite(app.id, next)
        .then(() => {
          app.favorite = next;
          setHint("settings__hint--ok", "Saved");
        })
        .catch((err: unknown) => {
          input.checked = !next;
          setHint("settings__hint--err", `Save failed: ${describeError(err)}`);
        });
      break;
    }
    case "enabled": {
      const input = control as HTMLInputElement;
      const next = input.checked;
      setHint("settings__hint--pending", "Saving…");
      void api.apps
        .setEnabled(app.id, next)
        .then(() => {
          app.enabled = next;
          setHint("settings__hint--ok", "Saved");
        })
        .catch((err: unknown) => {
          input.checked = !next;
          setHint("settings__hint--err", `Save failed: ${describeError(err)}`);
        });
      break;
    }
    case "remove": {
      ev.preventDefault();
      const ok = window.confirm(
        `Remove source "${app.name}" (${app.id})? This deletes the manifest entry only; on-disk files are untouched.`,
      );
      if (!ok) return;
      setHint("settings__hint--pending", "Removing…");
      void api.apps
        .remove(app.id)
        .then(() => {
          state.apps = state.apps.filter((a) => a.id !== app.id);
          renderTabBody();
        })
        .catch((err: unknown) => {
          setHint("settings__hint--err", `Remove failed: ${describeError(err)}`);
        });
      break;
    }
    default:
      break;
  }
}

function sourceTypeLabel(type: string): { label: string; cls: string } {
  switch (type) {
    case "git":
      return { label: "GIT", cls: "git" };
    case "release-binary":
      return { label: "REL", cls: "release" };
    case "installer":
      return { label: "MSI", cls: "installer" };
    case "web":
      return { label: "WEB", cls: "web" };
    case "tizen-ipk":
      return { label: "TIZEN", cls: "tizen" };
    default:
      return { label: "SRC", cls: "git" };
  }
}

function openAddDialog(body: HTMLDivElement): void {
  // Remove any prior dialog so re-opening starts fresh.
  body.querySelector(".settings__dialog-backdrop")?.remove();

  const sample: AppEntry = {
    id: "example-app",
    name: "Example App",
    type: "git",
    favorite: false,
    enabled: true,
    source: {
      url: "https://github.com/owner/repo.git",
      branch: "main",
    },
    launch: {
      kind: "executable",
      command: "C:/path/to/app.exe",
    },
  };
  const sampleText = JSON.stringify(sample, null, 2);

  const dialog = document.createElement("div");
  dialog.className = "settings__dialog-backdrop";
  dialog.innerHTML = `
    <div class="settings__dialog" role="dialog" aria-modal="true" aria-label="Add source">
      <header class="settings__dialog-header">
        <h2>Add source</h2>
        <button type="button" class="settings__button settings__button--ghost" id="settings-dialog-close">
          Close
        </button>
      </header>
      <p class="settings__help">
        Paste a manifest entry as JSON. The full schema is documented in
        <code>docs/MANIFEST_SCHEMA.md</code>. The backend validates and rejects malformed
        entries.
      </p>
      <textarea id="settings-dialog-json"
                class="settings__dialog-textarea"
                spellcheck="false"
                rows="18"
                aria-label="Manifest entry JSON">${escapeHtml(sampleText)}</textarea>
      <div class="settings__dialog-footer">
        <span class="settings__hint" id="settings-dialog-result"></span>
        <button type="button" class="settings__button settings__button--ghost" id="settings-dialog-cancel">
          Cancel
        </button>
        <button type="button" class="settings__button settings__button--primary" id="settings-dialog-save">
          Add source
        </button>
      </div>
    </div>
  `;
  body.appendChild(dialog);

  const close = (): void => dialog.remove();
  dialog.querySelector<HTMLButtonElement>("#settings-dialog-close")?.addEventListener("click", close);
  dialog.querySelector<HTMLButtonElement>("#settings-dialog-cancel")?.addEventListener("click", close);
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) close();
  });

  const save = dialog.querySelector<HTMLButtonElement>("#settings-dialog-save");
  const text = dialog.querySelector<HTMLTextAreaElement>("#settings-dialog-json");
  const result = dialog.querySelector<HTMLSpanElement>("#settings-dialog-result");

  save?.addEventListener("click", () => {
    if (!text || !result) return;
    const raw = text.value.trim();
    if (raw === "") {
      result.className = "settings__hint settings__hint--err";
      result.textContent = "Entry cannot be empty";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      result.className = "settings__hint settings__hint--err";
      result.textContent = `JSON parse error: ${describeError(err)}`;
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      result.className = "settings__hint settings__hint--err";
      result.textContent = "Entry must be a JSON object";
      return;
    }
    const entry = parsed as AppEntry;
    result.className = "settings__hint settings__hint--pending";
    result.textContent = "Adding…";
    save.disabled = true;
    api.apps
      .add(entry)
      .then(() => {
        close();
        void loadApps();
      })
      .catch((err: unknown) => {
        save.disabled = false;
        result.className = "settings__hint settings__hint--err";
        result.textContent = `Add failed: ${describeError(err)}`;
      });
  });
}

// ─── Update history tab ──────────────────────────────────────────────────────

function renderHistory(body: HTMLDivElement): void {
  if (!state.historyLoaded) {
    body.innerHTML = `
      <div class="settings__panel">
        <div class="settings__loading">Loading update history…</div>
      </div>
    `;
    return;
  }

  const error = state.historyError;
  const entries = state.history;
  const appsById = new Map<string, AppView>();
  for (const a of state.apps) appsById.set(a.id, a);

  body.innerHTML = `
    <div class="settings__panel">
      <div class="settings__history-toolbar">
        <button type="button" class="settings__button settings__button--ghost" id="history-refresh">
          Refresh
        </button>
        <span class="settings__hint">${escapeHtml(`${entries.length} entries`)}</span>
      </div>
      ${error ? `<div class="settings__error">${escapeHtml(error)}</div>` : ""}
      ${
        entries.length === 0 && !error
          ? `<div class="settings__source-empty">No update history yet.</div>`
          : `
        <table class="settings__history-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">App</th>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Outcome</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            ${entries.map((e) => historyRow(e, appsById.get(e.app_id))).join("")}
          </tbody>
        </table>
      `
      }
    </div>
  `;

  body.querySelector<HTMLButtonElement>("#history-refresh")?.addEventListener("click", () => {
    void loadHistory();
  });
}

function historyRow(entry: UpdateHistoryEntry, app: AppView | undefined): string {
  const outcomeCls = outcomeClass(entry.outcome);
  const when = formatTimestamp(entry.started_at);
  const appLabel = app ? app.name : entry.app_id;
  return `
    <tr>
      <td class="settings__history-when">${escapeHtml(when)}</td>
      <td>
        <div class="settings__history-app">${escapeHtml(appLabel)}</div>
        <code class="settings__history-id">${escapeHtml(entry.app_id)}</code>
      </td>
      <td class="settings__history-ver">${escapeHtml(entry.from_version ?? "—")}</td>
      <td class="settings__history-ver">${escapeHtml(entry.to_version ?? "—")}</td>
      <td><span class="settings__history-outcome ${outcomeCls}">${escapeHtml(entry.outcome)}</span></td>
      <td class="settings__history-msg">${escapeHtml(entry.error_message ?? "")}</td>
    </tr>
  `;
}

function outcomeClass(outcome: string): string {
  const norm = outcome.toLowerCase();
  if (norm === "success" || norm === "ok" || norm === "up_to_date") {
    return "settings__history-outcome--ok";
  }
  if (norm === "error" || norm === "failed" || norm === "failure") {
    return "settings__history-outcome--err";
  }
  return "settings__history-outcome--idle";
}
