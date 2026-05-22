// <iptv-status-bar> — bottom status bar from UI_SPEC.md §3.6.
//
// Layout
//   Left:  counts in mono `--text-sm` — "N apps", "N updates", "N error",
//          "N favorites". The updates/error counts are coloured with
//          --status-warn / --status-err when their count is greater than zero.
//   Right: "Next auto-sync · <HH:MM> (<N>m)" in mono `--text-sm`, dimmed.
//
// Data model
//   - `apps: AppView[]` (settable property) — the host (main.ts) holds the
//     canonical list and re-sets this on every change. We never serialise it
//     into an HTML attribute because attributes are strings and AppView is a
//     structured object.
//   - `nextSync` (settable attribute *and* property) — ISO-8601 timestamp string
//     for the next scheduled poll, or null when no sync is scheduled.
//
// Live update protocol for `iptv-hub://status`
//   When the backend pushes a status change, the bar needs the *new* AppView
//   list to recompute counts. Two valid strategies:
//     (a) re-query `api.apps.list()` directly from here, OR
//     (b) dispatch a typed CustomEvent on `this` (`iptv:status-request`) and let
//         the host re-set `apps` with whatever it already has in memory.
//   We use (b) — it avoids a Tauri round-trip when the host already has fresh
//   data, and it keeps the bar agnostic about *how* the host loads apps. The
//   host listens for `iptv:status-request` and calls `bar.apps = …` in response.
//
// Custom events emitted (bubbles=true, composed=false):
//   - `iptv:status-request` — fired when a backend `iptv-hub://status` event
//     fires; the host should respond by re-setting `apps`.

import type { UnlistenFn } from "@tauri-apps/api/event";

import type { AppView } from "../lib/api";
import { events } from "../lib/events";

const NEXT_SYNC_ATTR = "next-sync";

interface Counts {
  total: number;
  updates: number;
  errors: number;
  favorites: number;
}

export class StatusBarElement extends HTMLElement {
  #apps: AppView[] = [];
  #nextSync: string | null = null;
  #unlisten: UnlistenFn | null = null;
  #disposed = false;

  static get observedAttributes(): string[] {
    return [NEXT_SYNC_ATTR];
  }

  set apps(value: AppView[]) {
    this.#apps = Array.isArray(value) ? value : [];
    this.render();
  }

  get apps(): readonly AppView[] {
    return this.#apps;
  }

  set nextSync(value: string | null) {
    this.#nextSync = value && value.length > 0 ? value : null;
    this.render();
  }

  get nextSync(): string | null {
    return this.#nextSync;
  }

  connectedCallback(): void {
    this.classList.add("status-bar");
    this.#disposed = false;
    // Honour an initial `next-sync` attribute if the host set one declaratively.
    const initialAttr = this.getAttribute(NEXT_SYNC_ATTR);
    if (initialAttr !== null && this.#nextSync === null) {
      this.#nextSync = initialAttr.length > 0 ? initialAttr : null;
    }
    this.render();
    // Fire-and-forget the async subscription. Guarded by #disposed internally.
    // `void` satisfies @typescript-eslint/no-floating-promises.
    void this.subscribe();
  }

  disconnectedCallback(): void {
    this.#disposed = true;
    if (this.#unlisten) {
      this.#unlisten();
      this.#unlisten = null;
    }
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === NEXT_SYNC_ATTR) {
      this.#nextSync = newValue && newValue.length > 0 ? newValue : null;
      this.render();
    }
  }

  private async subscribe(): Promise<void> {
    try {
      const unlisten = await events.onStatusChanged(() => this.onStatusChanged());
      if (this.#disposed) {
        unlisten();
        return;
      }
      this.#unlisten = unlisten;
    } catch (err) {
      if (this.#disposed) return;
      // Render an inline error state — the bar is non-critical so we keep
      // the layout intact and show the message on the right-hand slot.
      this.renderError(err);
    }
  }

  private onStatusChanged(): void {
    // Ask the host to give us a fresh `apps` list. The host responds by
    // assigning to `bar.apps`, which triggers a re-render via the setter.
    this.dispatchEvent(new CustomEvent("iptv:status-request", { detail: {}, bubbles: true }));
  }

  private computeCounts(): Counts {
    let updates = 0;
    let errors = 0;
    let favorites = 0;
    for (const a of this.#apps) {
      if (a.favorite) favorites += 1;
      if (a.status === "update-available" || a.status === "update_available") {
        updates += 1;
      }
      if (a.status === "error") {
        errors += 1;
      }
    }
    return { total: this.#apps.length, updates, errors, favorites };
  }

  private render(): void {
    const c = this.computeCounts();
    const updatesCls = c.updates > 0 ? "status-bar__stat--warn" : "";
    const errorsCls = c.errors > 0 ? "status-bar__stat--err" : "";
    const nextSync = this.formatNextSync(this.#nextSync);

    this.innerHTML = `
      <div class="status-bar__left" role="group" aria-label="Counts">
        <span class="status-bar__stat" data-stat="apps">
          <span class="status-bar__count">${c.total}</span>
          <span class="status-bar__label">${c.total === 1 ? "app" : "apps"}</span>
        </span>
        <span class="status-bar__stat ${updatesCls}" data-stat="updates">
          <span class="status-bar__count">${c.updates}</span>
          <span class="status-bar__label">${c.updates === 1 ? "update" : "updates"}</span>
        </span>
        <span class="status-bar__stat ${errorsCls}" data-stat="errors">
          <span class="status-bar__count">${c.errors}</span>
          <span class="status-bar__label">${c.errors === 1 ? "error" : "errors"}</span>
        </span>
        <span class="status-bar__stat" data-stat="favorites">
          <span class="status-bar__count">${c.favorites}</span>
          <span class="status-bar__label">${c.favorites === 1 ? "favorite" : "favorites"}</span>
        </span>
      </div>
      <div class="status-bar__right" role="group" aria-label="Next auto-sync">
        ${nextSync}
      </div>
    `;
  }

  private renderError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const c = this.computeCounts();
    this.innerHTML = `
      <div class="status-bar__left" role="group" aria-label="Counts">
        <span class="status-bar__stat" data-stat="apps">
          <span class="status-bar__count">${c.total}</span>
          <span class="status-bar__label">${c.total === 1 ? "app" : "apps"}</span>
        </span>
      </div>
      <div class="status-bar__right status-bar__right--error" role="alert">
        Status feed error: ${this.esc(message)}
      </div>
    `;
  }

  /**
   * Format the next-sync ISO string per UI_SPEC §3.6:
   *   "Next auto-sync · <HH:MM> (<N>m)"
   * If the timestamp is in the past or unparseable, render "—".
   * If null, render "Next auto-sync · off".
   */
  private formatNextSync(iso: string | null): string {
    if (iso === null) {
      return `<span class="status-bar__next-sync">Next auto-sync · off</span>`;
    }
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
      return `<span class="status-bar__next-sync">Next auto-sync · —</span>`;
    }
    const date = new Date(t);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const diffMs = t - Date.now();
    const diffMin = Math.max(0, Math.round(diffMs / 60000));
    return `<span class="status-bar__next-sync">Next auto-sync · ${hh}:${mm} (${diffMin}m)</span>`;
  }

  private esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
  }
}

customElements.define("iptv-status-bar", StatusBarElement);
