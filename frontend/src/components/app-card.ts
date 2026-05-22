// <iptv-app-card> — the dense control-panel row from the mockup.
//
// This is a real Web Component, no framework. It exposes one `app` property of type
// AppView (api.ts) and renders the three-row card layout defined in UI_SPEC.md §3.3:
//
//   row 1: icon tile · name · status dot · sub-label · favorite star
//   row 2: source pill · current version · update diff (if any) · age
//   row 3: Launch / Update|Up to date|Retry|Check / More buttons
//
// Two ways to feed an `AppView` in:
//   1. JS property:    cardEl.app = appView;
//   2. HTML attribute: cardEl.setAttribute("app", JSON.stringify(appView));
//
// The component observes the `app` attribute and re-renders on change.
//
// Custom events emitted (per UI_SPEC §3.3 and AGENT_PLAN.md §Agent 17):
//   - "iptv:launch"   ({ appId })
//   - "iptv:update"   ({ appId, action: "apply" | "check" })
//       action="apply" — user clicked "Update" on an update-available card.
//       action="check" — user clicked "Check" (idle/unknown) or "Retry" (error).
//   - "iptv:menu"     ({ appId })
//   - "iptv:favorite" ({ appId, favorite })

import type { AppView } from "../lib/api";
import { pillForSource, relativeAge, statusToDot } from "../lib/format";

type SecondaryButtonState =
  | { kind: "update"; label: "Update"; action: "apply"; disabled: false }
  | { kind: "up_to_date"; label: "Up to date"; action: "check"; disabled: true }
  | { kind: "retry"; label: "Retry"; action: "check"; disabled: false }
  | { kind: "check"; label: "Check"; action: "check"; disabled: false };

export class AppCardElement extends HTMLElement {
  #app: AppView | null = null;

  static get observedAttributes(): string[] {
    return ["app"];
  }

  set app(value: AppView) {
    this.#app = value;
    this.render();
  }

  get app(): AppView | null {
    return this.#app;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== "app") return;
    if (oldValue === newValue) return;
    if (newValue === null) {
      this.#app = null;
      this.render();
      return;
    }
    try {
      const parsed = JSON.parse(newValue) as AppView;
      this.#app = parsed;
      this.render();
    } catch (err) {
      // Bad JSON in the attribute is a programmer error, not a runtime expectation.
      // Surface it so the developer fixes the call site rather than silently rendering nothing.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`<iptv-app-card> attribute 'app' is not valid JSON: ${message}`);
      this.#app = null;
      this.render();
    }
  }

  connectedCallback(): void {
    this.classList.add("app-card");
    // If the attribute was set before connection, attributeChangedCallback already ran
    // and #app is populated. If only the property was set, #app is populated too.
    // Either way, render now so the markup exists once the element is in the DOM.
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
    const secondary = this.secondaryButtonState(app);

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
        <button class="btn-secondary"
                data-action="secondary"
                data-secondary-kind="${secondary.kind}"
                data-secondary-sub-action="${secondary.action}"
                ${secondary.disabled ? "disabled" : ""}>${secondary.label}</button>
        <button class="btn-ghost" data-action="more" aria-label="More">⋯</button>
      </div>
    `;

    this.bindHandlers();
  }

  private secondaryButtonState(app: AppView): SecondaryButtonState {
    // Per UI_SPEC §3.3 the second button is the only one that shape-shifts by status.
    // - ok       → "Up to date" (disabled, no-op).
    // - error    → "Retry"      (re-runs the check; emits action="check").
    // - update_* → "Update"     (kicks off the update flow; emits action="apply").
    // - anything else (idle/checking/updating/running/unknown) → "Check"
    //              (request a poll; emits action="check"). This keeps the card
    //              useful in the idle and unknown states until the poller catches up.
    switch (app.status) {
      case "ok":
      case "up_to_date":
        return { kind: "up_to_date", label: "Up to date", action: "check", disabled: true };
      case "error":
        return { kind: "retry", label: "Retry", action: "check", disabled: false };
      case "update-available":
      case "update_available":
        return { kind: "update", label: "Update", action: "apply", disabled: false };
      default:
        return { kind: "check", label: "Check", action: "check", disabled: false };
    }
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
            this.dispatchEvent(
              new CustomEvent("iptv:launch", {
                detail: { appId: app.id },
                bubbles: true,
              }),
            );
            break;
          case "secondary": {
            // The secondary button is "Update" / "Retry" / "Check" / "Up to date".
            // "Up to date" is rendered disabled — clicks never reach here. The other
            // three all emit `iptv:update`; only the `detail.action` differentiates
            // an apply-the-update request from a re-check request.
            const subAction = btn.dataset["secondarySubAction"];
            if (subAction !== "apply" && subAction !== "check") return;
            this.dispatchEvent(
              new CustomEvent("iptv:update", {
                detail: { appId: app.id, action: subAction },
                bubbles: true,
              }),
            );
            break;
          }
          case "more":
            this.dispatchEvent(
              new CustomEvent("iptv:menu", {
                detail: { appId: app.id },
                bubbles: true,
              }),
            );
            break;
          case "favorite":
            this.dispatchEvent(
              new CustomEvent("iptv:favorite", {
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
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
  }
}

customElements.define("iptv-app-card", AppCardElement);
