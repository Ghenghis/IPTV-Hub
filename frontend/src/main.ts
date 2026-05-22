// IPTV Hub frontend entry.
//
// Mounts the application shell into #root and wires the four shell-level Web
// Components (`<iptv-title-bar>`, `<iptv-chip-bar>`, `<iptv-activity-log>`,
// `<iptv-status-bar>`) to the typed API surface in lib/api.ts. State is local
// to this module; component-internal state lives in the components themselves.

import "./components/app-card";
import "./components/update-modal";
import "./components/title-bar";
import "./components/chip-bar";
import "./components/activity-log";
import "./components/status-bar";

import type { AppCardElement } from "./components/app-card";
import type { ChipKey, IptvChipBarElement } from "./components/chip-bar";
import type { StatusBarElement } from "./components/status-bar";
import { api, type AppView, type SourceType } from "./lib/api";
import { mountSettingsPage } from "./pages/settings";
import { mountSeedPage } from "./pages/seed";

type ViewFilter = ChipKey;
type Route = "home" | "settings" | "seed";

interface ViewState {
  apps: AppView[];
  filter: ViewFilter;
  search: string;
  loading: boolean;
  errorBanner: string | null;
  route: Route;
}

const state: ViewState = {
  apps: [],
  filter: "all",
  search: "",
  loading: true,
  errorBanner: null,
  route: "home",
};

const root = document.getElementById("root") as HTMLElement;
let overlayUnmount: (() => void) | null = null;

// Map AppView.source_type ("release-binary" / "tizen-ipk") to the simplified
// chip keys ("release" / "tizen") used in the chip bar contract.
function sourceTypeToChipKey(t: SourceType): ChipKey {
  switch (t) {
    case "release-binary":
      return "release";
    case "tizen-ipk":
      return "tizen";
    default:
      return t;
  }
}

function applyFilter(apps: AppView[]): AppView[] {
  const q = state.search.trim().toLowerCase();
  return apps.filter((a) => {
    if (state.filter === "updates" && !(a.status === "update-available" || a.status === "update_available")) {
      return false;
    }
    if (state.filter === "favorites" && !a.favorite) return false;
    const sourceChips: ChipKey[] = ["git", "web", "installer", "release", "tizen"];
    if (sourceChips.includes(state.filter)) {
      if (sourceTypeToChipKey(a.source_type) !== state.filter) return false;
    }
    if (q && !a.name.toLowerCase().includes(q) && !a.id.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

// SECURITY: NEVER interpolate `state.search` / `state.filter` (or any other
// user-controllable string) into this template — they would land in an HTML
// attribute context and a value like `"><script>...` would close the
// attribute and inject markup. Both values are bound below via
// `setAttribute()`, which treats them as text and is safe by construction.
function shell(): string {
  return `
    <div class="app-shell">
      <iptv-title-bar id="title-bar" app-name="IPTV Hub"></iptv-title-bar>
      <iptv-chip-bar id="chip-bar"></iptv-chip-bar>

      <main class="main">
        <section class="app-grid" id="app-grid" aria-live="polite"></section>
        <iptv-activity-log id="activity-log"></iptv-activity-log>
      </main>

      <iptv-status-bar id="status-bar"></iptv-status-bar>

      <div id="overlay-root" class="overlay-root" hidden></div>
    </div>
  `;
}

function renderCards(): void {
  const grid = document.getElementById("app-grid");
  if (!grid) return;
  const visible = applyFilter(state.apps);
  grid.replaceChildren();

  if (state.loading) {
    const loading = document.createElement("div");
    loading.style.color = "var(--fg-muted)";
    loading.style.padding = "var(--s-4)";
    loading.textContent = "Loading apps…";
    grid.appendChild(loading);
    return;
  }
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "var(--fg-muted)";
    empty.style.padding = "var(--s-4)";
    empty.textContent = "No apps match the current filter.";
    grid.appendChild(empty);
    return;
  }
  for (const app of visible) {
    const card = document.createElement("iptv-app-card") as AppCardElement;
    card.app = app;
    grid.appendChild(card);
  }
}

function refreshAuxiliaryComponents(): void {
  // SECURITY: pass `state.search` / `state.filter` through `setAttribute()`
  // rather than HTML interpolation; the DOM treats attribute values as text
  // and cannot inject markup even if the values contain `"`, `<`, or `>`.
  const titleBar = document.getElementById("title-bar");
  if (titleBar) titleBar.setAttribute("search", state.search);
  const chipBar = document.getElementById("chip-bar") as IptvChipBarElement | null;
  if (chipBar) {
    chipBar.setAttribute("active", state.filter);
    chipBar.apps = state.apps;
  }
  const statusBar = document.getElementById("status-bar") as StatusBarElement | null;
  if (statusBar) statusBar.apps = state.apps;
}

function closeOverlay(): void {
  if (overlayUnmount) {
    overlayUnmount();
    overlayUnmount = null;
  }
  const overlay = document.getElementById("overlay-root");
  if (overlay) {
    overlay.hidden = true;
    overlay.replaceChildren();
  }
  state.route = "home";
}

function openOverlay(route: Exclude<Route, "home">): void {
  const overlay = document.getElementById("overlay-root");
  if (!overlay) return;
  closeOverlay();
  overlay.hidden = false;
  overlay.replaceChildren();
  state.route = route;
  if (route === "settings") {
    overlayUnmount = mountSettingsPage(overlay);
  } else {
    // mountSeedPage doesn't return an unmount fn; we just clear the DOM on close.
    mountSeedPage(overlay);
    overlayUnmount = () => {
      /* seed page has no listeners outside the overlay subtree */
    };
  }
}

function render(): void {
  root.innerHTML = shell();
  refreshAuxiliaryComponents();
  renderCards();
}

async function load(): Promise<void> {
  state.loading = true;
  refreshAuxiliaryComponents();
  renderCards();
  try {
    state.apps = await api.apps.list();
    state.errorBanner = null;
  } catch (err) {
    state.apps = [];
    state.errorBanner = `failed to load apps: ${(err as Error).message ?? String(err)}`;
  } finally {
    state.loading = false;
    refreshAuxiliaryComponents();
    renderCards();
  }
}

// Shell-component events.
document.addEventListener("iptv:search", (ev) => {
  const { query } = (ev as CustomEvent<{ query: string }>).detail;
  state.search = query;
  renderCards();
});
document.addEventListener("iptv:sync", () => {
  void load();
});
document.addEventListener("iptv:filter", (ev) => {
  state.filter = (ev as CustomEvent<ChipKey>).detail;
  renderCards();
});
document.addEventListener("iptv:settings", () => {
  openOverlay("settings");
});
document.addEventListener("iptv:activity-show-all", () => {
  openOverlay("settings");
});
document.addEventListener("iptv:status-request", () => {
  refreshAuxiliaryComponents();
});

// App-card events — wired to the real Tauri commands now that Phase 3a has landed.
document.addEventListener("iptv:favorite", (ev) => {
  const detail = (ev as CustomEvent<{ appId: string; favorite: boolean }>).detail;
  void api.apps
    .setFavorite(detail.appId, detail.favorite)
    .then(load)
    .catch((e: Error) => {
      state.errorBanner = `favorite toggle failed: ${e.message}`;
      render();
    });
});

document.addEventListener("iptv:launch", (ev) => {
  const { appId } = (ev as CustomEvent<{ appId: string }>).detail;
  void api.launch.launch(appId).catch((e: Error) => {
    state.errorBanner = `launch '${appId}' failed: ${e.message}`;
    render();
  });
});

document.addEventListener("iptv:update", (ev) => {
  const detail = (ev as CustomEvent<{ appId: string; action?: "apply" | "check" }>).detail;
  const action = detail.action ?? "check";
  if (action === "apply") {
    void api.updates
      .apply(detail.appId)
      .then(load)
      .catch((e: Error) => {
        state.errorBanner = `apply update '${detail.appId}' failed: ${e.message}`;
        render();
      });
  } else {
    void api.updates
      .check(detail.appId)
      .then(load)
      .catch((e: Error) => {
        state.errorBanner = `check update '${detail.appId}' failed: ${e.message}`;
        render();
      });
  }
});

document.addEventListener("iptv:menu", (ev) => {
  const { appId } = (ev as CustomEvent<{ appId: string }>).detail;
  // App context menu — currently surfaces stop + rollback. Routed to a small
  // inline menu rather than a separate component to keep the shell flat.
  if (window.confirm(`Stop '${appId}'?`)) {
    void api.launch.stop(appId).catch((e: Error) => {
      state.errorBanner = `stop '${appId}' failed: ${e.message}`;
      render();
    });
  }
});

// Mount the shell immediately so refreshAuxiliaryComponents()/renderCards() inside
// load() have the host elements (#chip-bar, #status-bar, #app-grid) to write into.
render();
void load();
