// <iptv-app-card> — the dense control-panel row from the mockup.
//
// This is a real Web Component, no framework. It exposes one `app` property of type
// AppView (api.ts) and renders the three-row card layout defined in UI_SPEC.md §5:
//
//   row 1: status dot · icon tile · name · source-type pill · favorite star
//   row 2: current version · update diff (if any) · "checked Nm ago"
//   row 3: Launch / Update / More buttons
//
// Custom events emitted (per UI_SPEC §5.4):
//   - "iptv-launch"          ({ appId })
//   - "iptv-update-requested"({ appId })
//   - "iptv-more"            ({ appId })
//   - "iptv-favorite-toggle" ({ appId, favorite })

import type { AppView } from "../lib/api";
import { pillForSource, relativeAge, statusToDot } from "../lib/format";

export class AppCardElement extends HTMLElement {
  #app: AppView | null = null;

  static get observedAttributes(): string[] {
    return [];
  }

  set app(value: AppView) {
    this.#app = value;
    this.render();
  }

  get app(): AppView | null {
    return this.#app;
  }

  connectedCallback(): void {
    this.classList.add("app-card");
    this.render();
  }

  private render(): void {
    const app = this.#app;
    if (!app) {
      this.replaceChildren();
      return;
    }
    const pill = pillForSource(app.source_type);
    const dotKind = statusToDot(app.status);
    const iconText = app.icon_value ?? app.id.slice(0, 2).toUpperCase();
    const updateDiff = this.computeUpdateLine(app);
    const versionLabel = app.current_sha ?? app.current_version ?? "—";

    this.innerHTML = `
      <div class="app-card__row1">
        <div class="app-card__icon" aria-hidden="true">${this.escape(iconText)}</div>
        <div>
          <div class="app-card__title">
            <span class="dot dot--${dotKind}" aria-hidden="true"></span>
            <span>${this.escape(app.name)}</span>
            <span class="pill ${pill.cls}">${pill.label}</span>
          </div>
          <div class="app-card__sub">${this.escape(app.sub_label)}</div>
        </div>
        <button class="btn-ghost" data-action="favorite"
                aria-label="${app.favorite ? "Unfavorite" : "Favorite"}"
                aria-pressed="${app.favorite}">
          ${app.favorite ? "★" : "☆"}
        </button>
      </div>

      <div class="app-card__row2">
        <span class="app-card__version">${this.escape(versionLabel)}</span>
        ${updateDiff ? `<span class="app-card__diff">${updateDiff}</span>` : ""}
        <span class="app-card__age">${this.escape(relativeAge(app.last_poll_at))}</span>
      </div>

      <div class="app-card__row3">
        <button class="btn-primary" data-action="launch" ${app.enabled ? "" : "disabled"}>Launch</button>
        ${
          app.status === "update-available" || app.status === "update_available"
            ? `<button class="btn-secondary" data-action="update">Update</button>`
            : `<button class="btn-secondary" data-action="check">Check</button>`
        }
        <button class="btn-ghost" data-action="more" aria-label="More">⋯</button>
      </div>
    `;

    this.bindHandlers();
  }

  private computeUpdateLine(app: AppView): string {
    if (app.status !== "update-available" && app.status !== "update_available") return "";
    if (!app.status_message) return "→ update available";
    // Status messages from the core look like "a3f2c1d -> 9b1e4f8"; we render the arrow softly.
    const m = /^([a-z0-9.]+)\s*(?:->|→)\s*([a-z0-9.]+)$/i.exec(app.status_message);
    if (m && m[1] && m[2]) {
      return `→ <strong>${this.escape(m[2])}</strong> (was ${this.escape(m[1])})`;
    }
    return `→ ${this.escape(app.status_message)}`;
  }

  private bindHandlers(): void {
    this.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const action = btn.dataset["action"];
        const app = this.#app;
        if (!app || !action) return;
        switch (action) {
          case "launch":
            this.dispatchEvent(new CustomEvent("iptv-launch", { detail: { appId: app.id }, bubbles: true }));
            break;
          case "update":
            this.dispatchEvent(new CustomEvent("iptv-update-requested", { detail: { appId: app.id }, bubbles: true }));
            break;
          case "check":
            this.dispatchEvent(new CustomEvent("iptv-check-requested", { detail: { appId: app.id }, bubbles: true }));
            break;
          case "more":
            this.dispatchEvent(new CustomEvent("iptv-more", { detail: { appId: app.id }, bubbles: true }));
            break;
          case "favorite":
            this.dispatchEvent(
              new CustomEvent("iptv-favorite-toggle", {
                detail: { appId: app.id, favorite: !app.favorite },
                bubbles: true,
              }),
            );
            break;
          default:
            break;
        }
      });
    });
  }

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" :
      c === "<" ? "&lt;" :
      c === ">" ? "&gt;" :
      c === '"' ? "&quot;" : "&#39;",
    );
  }
}

customElements.define("iptv-app-card", AppCardElement);
