// <iptv-update-modal> — the update preview modal from UI_SPEC §3.4.
//
// Renders a typed UpdatePlan (shape defined in src-tauri/src/sources/mod.rs and
// re-exported from frontend/src/lib/api.ts). The frontend never invents text in this
// view — it only renders the shape returned by the core.
//
// Public API (per AGENT_PLAN §18):
//   - open(plan, appName)  — set state and show.
//   - close()              — hide without emitting.
//   - set state(...)       — DEPRECATED, kept for backward compat with older callers.
//
// Dispatched events:
//   - "iptv:apply"   ({ appId })
//   - "iptv:cancel"  ({ appId })
//
// Keyboard:
//   - Esc dismisses the modal and emits "iptv:cancel" (UI_SPEC §3.4, AGENT_PLAN §18).

import type { IncomingItem, KeyValue, PlanStep, PlanTag, SourceType, UpdatePlan } from "../lib/api";

// Re-export so legacy importers `import type { UpdatePlan } from "./components/update-modal"`
// keep working without touching their files.
export type { UpdatePlan } from "../lib/api";

export class UpdateModalElement extends HTMLElement {
  #plan: UpdatePlan | null = null;
  #appName = "";
  #open = false;
  #keydownHandler: ((ev: KeyboardEvent) => void) | null = null;

  /**
   * Open the modal with a plan and app name. Sets state, shows the backdrop, and
   * begins listening for Esc.
   */
  open(plan: UpdatePlan, appName: string): void {
    this.#plan = plan;
    this.#appName = appName;
    this.#open = true;
    this.hidden = false;
    this.render();
    this.attachKeyHandler();
  }

  /**
   * Close the modal without emitting any event. Idempotent.
   */
  close(): void {
    this.#open = false;
    this.hidden = true;
    this.#plan = null;
    this.#appName = "";
    this.detachKeyHandler();
    this.replaceChildren();
  }

  /**
   * @deprecated Use {@link open} instead. Retained for backward compatibility with
   * earlier callers that assigned `modal.state = { plan, appName }`.
   */
  set state(value: { plan: UpdatePlan; appName: string }) {
    this.open(value.plan, value.appName);
  }

  connectedCallback(): void {
    this.classList.add("modal-backdrop");
    if (!this.#open) {
      this.hidden = true;
    } else {
      this.render();
      this.attachKeyHandler();
    }
  }

  disconnectedCallback(): void {
    this.detachKeyHandler();
  }

  private attachKeyHandler(): void {
    if (this.#keydownHandler) return;
    const handler = (ev: KeyboardEvent): void => {
      if (!this.#open) return;
      if (ev.key === "Escape" || ev.key === "Esc") {
        ev.preventDefault();
        ev.stopPropagation();
        this.emitCancel();
      }
    };
    this.#keydownHandler = handler;
    document.addEventListener("keydown", handler, true);
  }

  private detachKeyHandler(): void {
    if (this.#keydownHandler) {
      document.removeEventListener("keydown", this.#keydownHandler, true);
      this.#keydownHandler = null;
    }
  }

  private emitApply(): void {
    const appId = this.#plan?.app_id;
    if (typeof appId !== "string") return;
    this.dispatchEvent(new CustomEvent("iptv:apply", { detail: { appId }, bubbles: true }));
  }

  private emitCancel(): void {
    const appId = this.#plan?.app_id;
    this.dispatchEvent(
      new CustomEvent("iptv:cancel", {
        detail: { appId: appId ?? "" },
        bubbles: true,
      }),
    );
  }

  private render(): void {
    if (!this.#plan) {
      this.replaceChildren();
      return;
    }
    const plan = this.#plan;
    const sourceClass = this.sourceTypeClass(plan.source_type);
    const initials = this.initials(this.#appName, plan.app_id);
    const subtitle = this.subtitleHtml(plan.from_meta);

    this.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Update ${this.esc(this.#appName)}">
        <header class="modal__header">
          <span
            class="pill pill--${sourceClass}"
            aria-hidden="true"
            style="
              width: 36px;
              height: 36px;
              border-radius: var(--r-md);
              display: inline-flex;
              align-items: center;
              justify-content: center;
              font-family: var(--font-mono);
              font-size: var(--text-sm);
              font-weight: var(--fw-medium);
              flex-shrink: 0;
            "
          >${this.esc(initials)}</span>
          <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
            <div class="modal__title">Update ${this.esc(this.#appName)}</div>
            ${
              subtitle
                ? `<div
                    class="modal__subtitle"
                    style="
                      font-family: var(--font-mono);
                      font-size: var(--text-sm);
                      color: var(--fg-tertiary);
                      margin-top: 2px;
                      overflow: hidden;
                      text-overflow: ellipsis;
                      white-space: nowrap;
                    "
                  >${subtitle}</div>`
                : ""
            }
          </div>
          <button class="btn-ghost modal__close" data-action="cancel" aria-label="Close">&#10005;</button>
        </header>

        <div class="modal__body">
          <div class="diff-cards">
            <div class="diff-card">
              <div class="diff-card__label">Current</div>
              <div class="diff-card__value">${this.esc(plan.from_label)}</div>
              <div class="diff-card__meta">${this.metaHtml(plan.from_meta)}</div>
            </div>
            <div class="diff-card">
              <div class="diff-card__label">Target</div>
              <div class="diff-card__value">${this.esc(plan.to_label)}</div>
              <div class="diff-card__meta">${this.metaHtml(plan.to_meta)}</div>
            </div>
          </div>

          ${
            plan.incoming.length > 0
              ? `
            <section>
              <div class="section-label">Incoming</div>
              <ul class="incoming-list">
                ${plan.incoming.map((it) => this.incomingRow(it)).join("")}
              </ul>
            </section>
          `
              : ""
          }

          <section>
            <div class="section-label">What will happen</div>
            <ol class="plan-list">
              ${plan.steps
                .map(
                  (s: PlanStep, i: number) => `
                <li>
                  <span class="num">${i + 1}</span>
                  <div>
                    <div class="title">${this.esc(s.title)} ${this.tagPill(s.tag)}</div>
                    ${s.detail !== null ? `<div class="detail">${this.esc(s.detail)}</div>` : ""}
                  </div>
                </li>
              `,
                )
                .join("")}
            </ol>
          </section>
        </div>

        <footer class="modal__footer">
          <span class="hint">Rollback retained for ${plan.rollback_retention_days} days &middot; safe to cancel anytime</span>
          <button class="btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn-primary" data-action="apply">Apply update</button>
        </footer>
      </div>
    `;

    this.bindHandlers();
  }

  private subtitleHtml(meta: KeyValue[]): string {
    // UI_SPEC §3.4: "full source URL · branch/tag/release info" — render whatever
    // from_meta provides, joined by " · ", as a mono subtitle. The plan owns the text.
    if (meta.length === 0) return "";
    return meta.map((kv) => `${this.esc(kv.key)}: ${this.esc(kv.value)}`).join(" &middot; ");
  }

  private metaHtml(meta: KeyValue[]): string {
    return meta
      .map((kv) => {
        const isAccent = /^\+/.test(kv.value);
        return `<span>${this.esc(kv.key)}: ${
          isAccent ? `<strong>${this.esc(kv.value)}</strong>` : this.esc(kv.value)
        }</span>`;
      })
      .join("");
  }

  private incomingRow(it: IncomingItem): string {
    switch (it.kind) {
      case "commit":
        return `<li>
          <span class="sha">${this.esc(it.sha)}</span>
          <span>${this.esc(it.message)}</span>
          <span class="author">${this.esc(it.author)}</span>
        </li>`;
      case "release_note":
        return `<li>
          <span class="sha">${this.esc(it.version)}</span>
          <span>${this.esc(it.markdown.slice(0, 200))}</span>
          <span class="author">release</span>
        </li>`;
      case "installer_change":
        return `<li><span class="sha">&Delta;</span><span>${this.esc(it.summary)}</span><span class="author">vendor</span></li>`;
      case "ipk_change":
        return `<li>
          <span class="sha">${this.esc(it.version)}</span>
          <span>${this.esc(it.notes)}</span>
          <span class="author">ipk</span>
        </li>`;
    }
  }

  private tagPill(tag: PlanTag): string {
    switch (tag) {
      case "safe":
        return `<span class="pill pill--safe">SAFE</span>`;
      case "time_estimate":
        return `<span class="pill pill--time">3&ndash;5 MIN</span>`;
      case "risky":
        return `<span class="pill pill--risky">RISKY</span>`;
    }
  }

  private sourceTypeClass(source: SourceType): string {
    switch (source) {
      case "git":
        return "git";
      case "release-binary":
        return "release";
      case "installer":
        return "installer";
      case "web":
        return "web";
      case "tizen-ipk":
        return "tizen";
    }
  }

  private initials(name: string, fallbackId: string): string {
    const src = name.trim() !== "" ? name.trim() : fallbackId;
    // Strip whitespace and dashes, take the first two alphanumeric chars, uppercase.
    const cleaned = src.replace(/[^A-Za-z0-9]/g, "");
    if (cleaned.length === 0) return "??";
    return cleaned.slice(0, 2).toUpperCase();
  }

  private bindHandlers(): void {
    this.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!this.#plan) return;
        const action = btn.dataset["action"];
        if (action === "apply") {
          this.emitApply();
        } else if (action === "cancel") {
          this.emitCancel();
        }
      });
    });
    // Clicking the backdrop (but not the modal itself) cancels.
    this.addEventListener("click", (ev) => {
      if (ev.target === this) {
        this.emitCancel();
      }
    });
  }

  private esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
  }
}

customElements.define("iptv-update-modal", UpdateModalElement);
