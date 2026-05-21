// <iptv-update-modal> — the update preview modal from Screenshot_15.
//
// Renders a typed UpdatePlan (shape defined in src-tauri/src/sources/mod.rs). The frontend
// never invents text in this view — it only renders the shape returned by the core.
//
// Dispatched events:
//   - "iptv-modal-apply"   ({ appId })
//   - "iptv-modal-cancel"  ({ appId })

interface KeyValue { key: string; value: string }
type PlanTag = "safe" | "time_estimate" | "risky";
interface PlanStep { title: string; detail: string | null; tag: PlanTag }
type IncomingItem =
  | { kind: "commit"; sha: string; message: string; author: string }
  | { kind: "release_note"; version: string; markdown: string }
  | { kind: "installer_change"; summary: string }
  | { kind: "ipk_change"; version: string; notes: string };

export interface UpdatePlan {
  app_id: string;
  source_type: string;
  from_label: string;
  to_label: string;
  from_meta: KeyValue[];
  to_meta: KeyValue[];
  incoming: IncomingItem[];
  steps: PlanStep[];
  rollback_retention_days: number;
}

export class UpdateModalElement extends HTMLElement {
  #plan: UpdatePlan | null = null;
  #appName = "";

  set state(value: { plan: UpdatePlan; appName: string }) {
    this.#plan = value.plan;
    this.#appName = value.appName;
    this.render();
  }

  connectedCallback(): void {
    this.classList.add("modal-backdrop");
    this.render();
  }

  private render(): void {
    if (!this.#plan) {
      this.replaceChildren();
      return;
    }
    const plan = this.#plan;

    this.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Update ${this.esc(this.#appName)}">
        <header class="modal__header">
          <div class="modal__title">Update ${this.esc(this.#appName)}</div>
          <button class="btn-ghost modal__close" data-action="cancel" aria-label="Close">✕</button>
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

          ${plan.incoming.length > 0 ? `
            <section>
              <div class="section-label">Incoming</div>
              <ul class="incoming-list">
                ${plan.incoming.map((it) => this.incomingRow(it)).join("")}
              </ul>
            </section>
          ` : ""}

          <section>
            <div class="section-label">What will happen</div>
            <ol class="plan-list">
              ${plan.steps.map((s, i) => `
                <li>
                  <span class="num">${i + 1}</span>
                  <div>
                    <div class="title">${this.esc(s.title)} ${this.tagPill(s.tag)}</div>
                    ${s.detail ? `<div class="detail">${this.esc(s.detail)}</div>` : ""}
                  </div>
                </li>
              `).join("")}
            </ol>
          </section>
        </div>

        <footer class="modal__footer">
          <span class="hint">Rollback retained for ${plan.rollback_retention_days} days · safe to cancel anytime</span>
          <button class="btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn-primary" data-action="apply">Apply update</button>
        </footer>
      </div>
    `;

    this.bindHandlers();
  }

  private metaHtml(meta: KeyValue[]): string {
    return meta.map((kv) => {
      const isAccent = /^\+/.test(kv.value);
      return `<span>${this.esc(kv.key)}: ${isAccent ? `<strong>${this.esc(kv.value)}</strong>` : this.esc(kv.value)}</span>`;
    }).join("");
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
        return `<li><span class="sha">∆</span><span>${this.esc(it.summary)}</span><span class="author">vendor</span></li>`;
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
      case "safe":          return `<span class="pill pill--safe">SAFE</span>`;
      case "time_estimate": return `<span class="pill pill--time">3–5 MIN</span>`;
      case "risky":         return `<span class="pill pill--risky">RISKY</span>`;
    }
  }

  private bindHandlers(): void {
    this.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const plan = this.#plan;
        if (!plan) return;
        const action = btn.dataset["action"];
        if (action === "apply") {
          this.dispatchEvent(new CustomEvent("iptv-modal-apply", { detail: { appId: plan.app_id }, bubbles: true }));
        } else if (action === "cancel") {
          this.dispatchEvent(new CustomEvent("iptv-modal-cancel", { detail: { appId: plan.app_id }, bubbles: true }));
        }
      });
    });
    // Clicking the backdrop (but not the modal itself) cancels.
    this.addEventListener("click", (ev) => {
      if (ev.target === this) {
        this.dispatchEvent(new CustomEvent("iptv-modal-cancel", { detail: { appId: this.#plan?.app_id }, bubbles: true }));
      }
    });
  }

  private esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" :
      c === "<" ? "&lt;" :
      c === ">" ? "&gt;" :
      c === '"' ? "&quot;" : "&#39;",
    );
  }
}

customElements.define("iptv-update-modal", UpdateModalElement);
