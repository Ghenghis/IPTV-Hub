// <iptv-activity-log> — recent activity panel from UI_SPEC.md §3.5.
//
// Renders the 4 most-recent rows of the global activity log in a dense, 4-column
// grid: time (relative, mono), action (short verb, mono), message (1fr, mono with
// ellipsis), status (right-aligned colour-coded label).
//
// Data sources
//   - Initial: fetched via `api.activity.list(20, 0)` then sliced to the top 4
//     (we fetch a slightly larger window so a missing/duplicate row still leaves
//     four rows on-screen after de-duplication by `id`).
//   - Live: `events.onActivity(...)` is the only subscription. The unlisten fn
//     returned by `listen(...)` is stored and called from `disconnectedCallback`
//     so attaching the element to a different host (or unloading the page) does
//     not leak the Tauri event handler.
//
// Custom events emitted (bubbles, composed=false — these are intra-renderer):
//   - `iptv:activity-show-all` — fired when the user clicks the "Show all" link;
//     the host (main.ts) routes this to the full-page activity view.

import type { UnlistenFn } from "@tauri-apps/api/event";

import { api, type ActivityEntry } from "../lib/api";
import { events } from "../lib/events";
import { relativeAge } from "../lib/format";

const MAX_ROWS = 4;
const INITIAL_FETCH_LIMIT = 20;

export class ActivityLogElement extends HTMLElement {
  #rows: ActivityEntry[] = [];
  #unlisten: UnlistenFn | null = null;
  #disposed = false;

  connectedCallback(): void {
    this.classList.add("activity-log");
    this.#disposed = false;
    this.render();
    // Fire-and-forget the async setup. Both methods are internally guarded by
    // `#disposed` so a late `disconnectedCallback` cannot cause state writes
    // after teardown. `void` satisfies @typescript-eslint/no-floating-promises.
    //
    // `data-source="manual"` opts out of the IPC-driven hydration + live
    // subscription. Preview / SSR / unit-test callers set the attribute, call
    // `setRows([...])`, and own the data. Production callers omit the attribute
    // and the component pulls its own data from the backend.
    if (this.dataset["source"] !== "manual") {
      void this.loadInitial();
      void this.subscribe();
    }
  }

  disconnectedCallback(): void {
    this.#disposed = true;
    if (this.#unlisten) {
      this.#unlisten();
      this.#unlisten = null;
    }
  }

  /** Manually inject rows (used by tests and by the host for hydration). */
  setRows(rows: ActivityEntry[]): void {
    this.#rows = rows.slice(0, MAX_ROWS);
    this.render();
  }

  /** Read-only view of the rows currently rendered. */
  get rows(): readonly ActivityEntry[] {
    return this.#rows;
  }

  private async loadInitial(): Promise<void> {
    try {
      const entries = await api.activity.list(INITIAL_FETCH_LIMIT, 0);
      if (this.#disposed) return;
      this.#rows = entries.slice(0, MAX_ROWS);
      this.render();
    } catch (err) {
      if (this.#disposed) return;
      this.renderError(err);
    }
  }

  private async subscribe(): Promise<void> {
    try {
      const unlisten = await events.onActivity((entry) => this.onNewEntry(entry));
      if (this.#disposed) {
        // Element was detached between subscribe-start and the await resolving.
        // Tear down the subscription immediately so we don't leak it.
        unlisten();
        return;
      }
      this.#unlisten = unlisten;
    } catch (err) {
      if (this.#disposed) return;
      this.renderError(err);
    }
  }

  private onNewEntry(entry: ActivityEntry): void {
    // Prepend, dedupe by id, slice to MAX_ROWS.
    const next: ActivityEntry[] = [entry];
    for (const r of this.#rows) {
      if (r.id === entry.id) continue;
      next.push(r);
      if (next.length >= MAX_ROWS) break;
    }
    this.#rows = next;
    this.render();
  }

  private render(): void {
    const header = `
      <div class="activity-log__header">
        <span class="activity-log__title">Recent activity</span>
        <a href="#" class="activity-log__show-all" data-action="show-all" role="button">Show all</a>
      </div>`;

    if (this.#rows.length === 0) {
      this.innerHTML = `
        ${header}
        <div class="activity-log__empty">No activity yet.</div>
      `;
      this.bindHandlers();
      return;
    }

    const rows = this.#rows.map((row) => this.renderRow(row)).join("");
    this.innerHTML = `
      ${header}
      <ol class="activity-log__list" role="list">${rows}</ol>
    `;
    this.bindHandlers();
  }

  private renderRow(row: ActivityEntry): string {
    const levelClass = this.levelToClass(row.level);
    const levelLabel = row.level || "info";
    return `
      <li class="activity-log__row" data-id="${this.esc(String(row.id))}">
        <span class="activity-log__time" title="${this.esc(row.at)}">${this.esc(relativeAge(row.at))}</span>
        <span class="activity-log__action">${this.esc(row.action)}</span>
        <span class="activity-log__message" title="${this.esc(row.message)}">${this.esc(row.message)}</span>
        <span class="activity-log__status ${levelClass}">${this.esc(levelLabel)}</span>
      </li>
    `;
  }

  private renderError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.innerHTML = `
      <div class="activity-log__header">
        <span class="activity-log__title">Recent activity</span>
      </div>
      <div class="activity-log__empty activity-log__empty--error" role="alert">
        Failed to load activity: ${this.esc(message)}
      </div>
    `;
  }

  private bindHandlers(): void {
    const link = this.querySelector<HTMLAnchorElement>('[data-action="show-all"]');
    if (link) {
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent("iptv:activity-show-all", { detail: {}, bubbles: true }));
      });
    }
  }

  /** Map a backend `level` string (info/warn/error/...) to a status colour class. */
  private levelToClass(level: string): string {
    switch (level.toLowerCase()) {
      case "error":
      case "err":
      case "fail":
      case "failed":
        return "activity-log__status--err";
      case "warn":
      case "warning":
        return "activity-log__status--warn";
      case "ok":
      case "success":
      case "done":
        return "activity-log__status--ok";
      default:
        return "activity-log__status--idle";
    }
  }

  private esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
  }
}

customElements.define("iptv-activity-log", ActivityLogElement);
