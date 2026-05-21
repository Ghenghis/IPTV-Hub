// <iptv-title-bar> — the dense top bar from the mockup.
//
// Renders the title-bar row defined in UI_SPEC §3.1:
//   [ logo "IPTV Hub" ]  [ search input ]  [ settings ]  [ sync now ]
//
// The component is intentionally light-DOM (no shadow root) so the existing
// `.title-bar`, `.btn-primary`, `.btn-secondary` and input styles in
// `frontend/src/styles/components.css` apply unchanged. This matches the
// approach used by `app-card.ts`.
//
// Inputs:
//   - attribute / property `search`   — current query text (string).
//   - attribute / property `app-name` — branding string shown on the left.
//
// Events emitted on the element, bubbling and composed so the host
// document can listen with a single `addEventListener` at the root.
//
//   "iptv:search"  detail: { query: string }       — fired on every input.
//   "iptv:sync"    detail: undefined               — fired on the sync button.
//   "iptv:settings" detail: undefined              — fired on the settings button.
//
// Accessibility:
//   - The search input is `type="search"` with an `aria-label`.
//   - Both action buttons have explicit text content so no extra label is needed.
//   - All three controls are reachable in document order (Tab cycles
//     search -> settings -> sync).

export class IptvTitleBarElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["search", "app-name"];
  }

  #search = "";
  #appName = "IPTV Hub";
  #rendered = false;

  set search(value: string) {
    const next = value ?? "";
    if (next === this.#search) return;
    this.#search = next;
    this.syncSearchInput();
  }

  get search(): string {
    return this.#search;
  }

  set appName(value: string) {
    const next = (value ?? "").trim() === "" ? "IPTV Hub" : value;
    if (next === this.#appName) return;
    this.#appName = next;
    if (this.#rendered) this.render();
  }

  get appName(): string {
    return this.#appName;
  }

  connectedCallback(): void {
    this.classList.add("title-bar");
    const initialSearch = this.getAttribute("search");
    if (initialSearch !== null) this.#search = initialSearch;
    const initialName = this.getAttribute("app-name");
    if (initialName !== null && initialName.trim() !== "") this.#appName = initialName;
    this.render();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === "search") {
      this.search = value ?? "";
    } else if (name === "app-name") {
      this.appName = value ?? "IPTV Hub";
    }
  }

  private render(): void {
    this.#rendered = true;
    this.innerHTML = `
      <div class="title-bar__logo">${this.escape(this.#appName)}</div>
      <div class="title-bar__search">
        <input
          id="iptv-title-bar-search"
          type="search"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search apps"
          placeholder="Search apps…"
          value="${this.escape(this.#search)}"
        />
      </div>
      <div class="title-bar__actions">
        <button class="btn-secondary" type="button" data-action="settings">Settings</button>
        <button class="btn-primary" type="button" data-action="sync">Sync now</button>
      </div>
    `;
    this.bindHandlers();
  }

  private syncSearchInput(): void {
    if (!this.#rendered) return;
    const input = this.querySelector<HTMLInputElement>("#iptv-title-bar-search");
    if (input && input.value !== this.#search) {
      input.value = this.#search;
    }
  }

  private bindHandlers(): void {
    const input = this.querySelector<HTMLInputElement>("#iptv-title-bar-search");
    if (input) {
      input.addEventListener("input", () => {
        this.#search = input.value;
        this.dispatchEvent(
          new CustomEvent<{ query: string }>("iptv:search", {
            detail: { query: input.value },
            bubbles: true,
            composed: true,
          }),
        );
      });
    }

    this.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const action = btn.dataset["action"];
        if (action === "sync") {
          this.dispatchEvent(new CustomEvent("iptv:sync", { bubbles: true, composed: true }));
        } else if (action === "settings") {
          this.dispatchEvent(new CustomEvent("iptv:settings", { bubbles: true, composed: true }));
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

customElements.define("iptv-title-bar", IptvTitleBarElement);

declare global {
  interface HTMLElementTagNameMap {
    "iptv-title-bar": IptvTitleBarElement;
  }
}
