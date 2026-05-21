// IPTV Hub frontend entry.
//
// Mounts the application shell into #root and wires it to the typed API surface in
// lib/api.ts. The shell is built imperatively from a single render() call — no template
// engine, no framework. State is local to this module; component-internal state lives
// in the Web Components themselves.

import "./components/app-card";
import "./components/update-modal";
import { api, type AppView } from "./lib/api";
import type { AppCardElement } from "./components/app-card";

interface ViewState {
  apps: AppView[];
  filter: "all" | "updates" | "favorites" | "git" | "web" | "installer" | "release-binary" | "tizen-ipk";
  search: string;
  loading: boolean;
  errorBanner: string | null;
}

const state: ViewState = {
  apps: [],
  filter: "all",
  search: "",
  loading: true,
  errorBanner: null,
};

const root = document.getElementById("root") as HTMLElement;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;",
  );
}

function counts(apps: AppView[]): Record<ViewState["filter"], number> {
  const c: Record<ViewState["filter"], number> = {
    all: apps.length,
    updates: 0,
    favorites: 0,
    git: 0,
    web: 0,
    installer: 0,
    "release-binary": 0,
    "tizen-ipk": 0,
  };
  for (const a of apps) {
    if (a.status === "update-available" || a.status === "update_available") c.updates += 1;
    if (a.favorite) c.favorites += 1;
    const key = a.source_type as ViewState["filter"];
    if (key in c) c[key] += 1;
  }
  return c;
}

function applyFilter(apps: AppView[]): AppView[] {
  const q = state.search.trim().toLowerCase();
  return apps.filter((a) => {
    if (state.filter === "updates" && !(a.status === "update-available" || a.status === "update_available")) return false;
    if (state.filter === "favorites" && !a.favorite) return false;
    if (["git", "web", "installer", "release-binary", "tizen-ipk"].includes(state.filter) && a.source_type !== state.filter) return false;
    if (q && !a.name.toLowerCase().includes(q) && !a.id.toLowerCase().includes(q)) return false;
    return true;
  });
}

function shell(): string {
  const c = counts(state.apps);
  const chip = (key: ViewState["filter"], label: string): string => `
    <button class="chip" data-filter="${key}" aria-pressed="${state.filter === key}">
      ${label} <span class="chip__count">${c[key]}</span>
    </button>`;

  return `
    <div class="app-shell">
      <header class="title-bar">
        <div class="title-bar__logo">IPTV Hub</div>
        <div class="title-bar__search">
          <input id="search" type="search" placeholder="Search apps…" value="${escapeHtml(state.search)}" />
        </div>
        <div class="title-bar__actions">
          <button class="btn-secondary" id="settings">Settings</button>
          <button class="btn-primary" id="sync">Sync now</button>
        </div>
      </header>

      <nav class="filter-bar" aria-label="Filter apps">
        ${chip("all", "All")}
        ${chip("updates", "Updates")}
        ${chip("favorites", "Favorites")}
        ${chip("git", "Git")}
        ${chip("web", "Web")}
        ${chip("installer", "Installer")}
        ${chip("release-binary", "Release")}
        ${chip("tizen-ipk", "Tizen")}
      </nav>

      <main class="main">
        <section class="app-grid" id="app-grid" aria-live="polite"></section>
        <aside class="activity-rail" aria-label="Recent activity">
          <div class="activity-rail__header">
            <span>Recent activity</span>
            <button class="btn-ghost" id="clear-activity">Clear</button>
          </div>
          <div class="activity-rail__list" id="activity-list"></div>
        </aside>
      </main>

      <footer class="status-bar">
        <span id="status-apps">${state.apps.length} apps</span>
        <span class="status-bar__sep">·</span>
        <span id="status-poll">poller idle</span>
        <span class="status-bar__sep">·</span>
        <span id="status-msg">${state.errorBanner ? escapeHtml(state.errorBanner) : "ready"}</span>
      </footer>
    </div>
  `;
}

function renderCards(): void {
  const grid = document.getElementById("app-grid");
  if (!grid) return;
  const visible = applyFilter(state.apps);
  grid.replaceChildren();

  if (state.loading) {
    grid.innerHTML = `<div style="color: var(--fg-muted); padding: var(--s-4);">Loading apps…</div>`;
    return;
  }
  if (visible.length === 0) {
    grid.innerHTML = `<div style="color: var(--fg-muted); padding: var(--s-4);">No apps match the current filter.</div>`;
    return;
  }
  for (const app of visible) {
    const card = document.createElement("iptv-app-card") as AppCardElement;
    card.app = app;
    grid.appendChild(card);
  }
}

function render(): void {
  root.innerHTML = shell();
  document.getElementById("search")?.addEventListener("input", (ev) => {
    state.search = (ev.target as HTMLInputElement).value;
    renderCards();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filter = btn.dataset["filter"] as ViewState["filter"];
      render();
    });
  });
  document.getElementById("sync")?.addEventListener("click", () => {
    // The `Sync now` button triggers a manual poll. The Tauri command lands with
    // Agent 14's `commands::updates::check_for_update` slice; until then, refresh
    // the list from the manifest as the visible response.
    void load();
  });
  renderCards();
}

async function load(): Promise<void> {
  state.loading = true;
  render();
  try {
    state.apps = await api.apps.list();
    state.errorBanner = null;
  } catch (err) {
    state.apps = [];
    state.errorBanner = `failed to load apps: ${(err as Error).message ?? String(err)}`;
  } finally {
    state.loading = false;
    render();
  }
}

// Card events — wire to the API.
document.addEventListener("iptv-favorite-toggle", (ev) => {
  const detail = (ev as CustomEvent<{ appId: string; favorite: boolean }>).detail;
  void api.apps.setFavorite(detail.appId, detail.favorite).then(load).catch((e: Error) => {
    state.errorBanner = `favorite toggle failed: ${e.message}`;
    render();
  });
});

document.addEventListener("iptv-launch", (ev) => {
  const { appId } = (ev as CustomEvent<{ appId: string }>).detail;
  // The `launch` command lands with Agent 13's slice. Until it's wired, surface
  // a clear status to the user rather than silently doing nothing.
  state.errorBanner = `launch '${appId}' — command not yet registered (Agent 13 slice)`;
  render();
});

document.addEventListener("iptv-update-requested", (ev) => {
  const { appId } = (ev as CustomEvent<{ appId: string }>).detail;
  state.errorBanner = `update '${appId}' — command not yet registered (Agent 14 slice)`;
  render();
});

void load();
