// <iptv-chip-bar> — the filter chip row from the mockup.
//
// Renders the eight canonical chips from UI_SPEC §3.2:
//   All · Updates · Favorites · Git · Web · Installer · Release · Tizen
//
// Per UI_SPEC §3.2 the Updates chip is only displayed when its count is > 0,
// so the element shows up to eight chips but at minimum seven (the "7 canonical
// chips" reference). The other seven are always rendered, even with a count of
// zero, so the layout stays stable.
//
// The component is light-DOM (no shadow root) so the existing chip styles in
// `frontend/src/styles/components.css` apply. Source-type chips are coloured
// using the locked `--pill-*-fg/--pill-*-bg` tokens from `tokens.css` — no
// hex is hard-coded.
//
// Inputs:
//   - property `apps` (`AppView[]`) — assign the current app list; chip counts
//     recompute on assignment. Not exposed as an attribute (would require
//     serialising a JSON array, which is exactly what the task forbids).
//   - attribute / property `active` — the active filter key. Defaults to
//     `"all"` when not set.
//
// Event emitted:
//   "iptv:filter"  detail: ChipKey  — fired when the user clicks or activates
//                                    a chip with Enter/Space.
//
// Accessibility:
//   - The root element exposes `role="tablist"` with `aria-label="Filter apps"`.
//   - Each chip is a `<button role="tab">` so it is reachable in document
//     order via Tab.
//   - Enter and Space on a focused chip activate it (native button semantics);
//     the keydown handler additionally maps Enter explicitly so screen reader
//     virtual-cursor activations also dispatch the filter event.

import type { AppView } from "../lib/api";

export type ChipKey = "all" | "updates" | "favorites" | "git" | "web" | "installer" | "release" | "tizen";

interface ChipDef {
  key: ChipKey;
  label: string;
  /** Colour class on the chip count badge — references --pill-*-fg/--pill-*-bg
   *  tokens already defined in `components.css`. Falls back to the default
   *  badge style when undefined. */
  pillClass?: "pill--git" | "pill--web" | "pill--installer" | "pill--release" | "pill--tizen";
  /** When true the chip is only rendered when its count > 0 (UI_SPEC §3.2). */
  hideWhenZero?: boolean;
}

/** Canonical chip order — locked by UI_SPEC §3.2 and the task brief. */
const CHIP_ORDER: readonly ChipDef[] = [
  { key: "all", label: "All" },
  { key: "updates", label: "Updates", hideWhenZero: true },
  { key: "favorites", label: "Favorites" },
  { key: "git", label: "Git", pillClass: "pill--git" },
  { key: "web", label: "Web", pillClass: "pill--web" },
  { key: "installer", label: "Installer", pillClass: "pill--installer" },
  { key: "release", label: "Release", pillClass: "pill--release" },
  { key: "tizen", label: "Tizen", pillClass: "pill--tizen" },
];

export class IptvChipBarElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["active"];
  }

  #apps: AppView[] = [];
  #counts: Record<ChipKey, number> = emptyCounts();
  #active: ChipKey = "all";
  #rendered = false;

  set apps(value: AppView[]) {
    this.#apps = Array.isArray(value) ? value : [];
    this.#counts = computeCounts(this.#apps);
    if (this.#rendered) this.render();
  }

  get apps(): AppView[] {
    return this.#apps;
  }

  set active(value: ChipKey) {
    if (!isChipKey(value)) return;
    if (value === this.#active) return;
    this.#active = value;
    if (this.#rendered) this.render();
  }

  get active(): ChipKey {
    return this.#active;
  }

  connectedCallback(): void {
    this.classList.add("filter-bar");
    this.setAttribute("role", "tablist");
    this.setAttribute("aria-label", "Filter apps");
    const initialActive = this.getAttribute("active");
    if (initialActive !== null && isChipKey(initialActive)) {
      this.#active = initialActive;
    }
    this.render();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === "active" && value !== null && isChipKey(value)) {
      this.active = value;
    }
  }

  private render(): void {
    this.#rendered = true;
    const counts = this.#counts;
    const active = this.#active;

    const chips = CHIP_ORDER.flatMap((chip) => {
      const count = counts[chip.key];
      if (chip.hideWhenZero && count === 0) return [];
      const isActive = chip.key === active;
      const countBadge = `<span class="chip__count${chip.pillClass ? " " + chip.pillClass : ""}">${count}</span>`;
      return [
        `<button
          type="button"
          class="chip${isActive ? " chip--active" : ""}"
          role="tab"
          data-filter="${chip.key}"
          aria-pressed="${isActive}"
          aria-selected="${isActive}"
          tabindex="0"
        >${this.escape(chip.label)} ${countBadge}</button>`,
      ];
    }).join("");

    this.innerHTML = chips;
    this.bindHandlers();
  }

  private bindHandlers(): void {
    this.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.activate(btn);
      });
      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this.activate(btn);
        }
      });
    });
  }

  private activate(btn: HTMLButtonElement): void {
    const raw = btn.dataset["filter"];
    if (raw === undefined || !isChipKey(raw)) return;
    if (raw === this.#active) return;
    this.#active = raw;
    this.render();
    this.dispatchEvent(
      new CustomEvent<ChipKey>("iptv:filter", {
        detail: raw,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
  }
}

customElements.define("iptv-chip-bar", IptvChipBarElement);

declare global {
  interface HTMLElementTagNameMap {
    "iptv-chip-bar": IptvChipBarElement;
  }
}

// ---------------------------------------------------------------------------- //
// Internal helpers
// ---------------------------------------------------------------------------- //

function emptyCounts(): Record<ChipKey, number> {
  return {
    all: 0,
    updates: 0,
    favorites: 0,
    git: 0,
    web: 0,
    installer: 0,
    release: 0,
    tizen: 0,
  };
}

/** Maps `AppView.source_type` to a `ChipKey`. The wire-level source types
 *  use the long forms `release-binary` and `tizen-ipk`; chips expose the
 *  short forms `release` and `tizen` per the task brief. */
function sourceTypeToChipKey(source: string): ChipKey | null {
  switch (source) {
    case "git":
      return "git";
    case "web":
      return "web";
    case "installer":
      return "installer";
    case "release-binary":
    case "release":
      return "release";
    case "tizen-ipk":
    case "tizen":
      return "tizen";
    default:
      return null;
  }
}

function computeCounts(apps: AppView[]): Record<ChipKey, number> {
  const counts = emptyCounts();
  counts.all = apps.length;
  for (const app of apps) {
    if (app.status === "update-available" || app.status === "update_available") {
      counts.updates += 1;
    }
    if (app.favorite) counts.favorites += 1;
    const key = sourceTypeToChipKey(app.source_type);
    if (key !== null) counts[key] += 1;
  }
  return counts;
}

function isChipKey(value: string): value is ChipKey {
  return (
    value === "all" ||
    value === "updates" ||
    value === "favorites" ||
    value === "git" ||
    value === "web" ||
    value === "installer" ||
    value === "release" ||
    value === "tizen"
  );
}
