// Entry point for `frontend/preview.html`. Mounts every Web Component in every
// documented state side-by-side so a Playwright `toHaveScreenshot()` test can
// pin the visual contract from UI_SPEC.md and AGENT_PLAN.md §Agent 02.
//
// The preview page renders without any Tauri runtime. Every component either:
//   - is fully self-contained (title bar, chip bar, app card, update modal,
//     status bar — they take data via attributes / properties), or
//   - exposes a `data-source="manual"` opt-out plus a `setRows()` seeding API
//     (activity log — see frontend/src/components/activity-log.ts).
//
// No `__TAURI_INTERNALS__` shim, no mocked IPC, no fabricated command
// responses. This file ships as a dev-build entry only; Vite emits it as
// `dist/preview.html` alongside `dist/index.html`.

import "../components/activity-log";
import "../components/app-card";
import "../components/chip-bar";
import "../components/status-bar";
import "../components/title-bar";
import "../components/update-modal";

import type { ActivityLogElement } from "../components/activity-log";
import type { AppCardElement } from "../components/app-card";
import type { StatusBarElement } from "../components/status-bar";
import type { UpdateModalElement } from "../components/update-modal";

import {
  activityRows,
  appCardVariants,
  chipBarEmpty,
  chipBarMixed,
  statusBarApps,
  STATUS_BAR_NEXT_SYNC_ISO,
  updateModalAppName,
  updatePlanFixture,
} from "./preview-fixtures";

// ---------------------------------------------------------------------------- //
// DOM construction
// ---------------------------------------------------------------------------- //

interface VariantCase {
  caption: string;
  build: () => HTMLElement;
}

function appendSection(root: HTMLElement, heading: string, cases: ReadonlyArray<VariantCase>): void {
  const section = document.createElement("section");
  section.className = "preview-section";
  const h2 = document.createElement("h2");
  h2.className = "preview-section__title";
  h2.textContent = heading;
  section.appendChild(h2);

  for (const c of cases) {
    const card = document.createElement("div");
    card.className = "preview-card";
    const h3 = document.createElement("h3");
    h3.className = "preview-card__caption";
    h3.textContent = c.caption;
    card.appendChild(h3);
    const body = document.createElement("div");
    body.className = "preview-card__body";
    body.appendChild(c.build());
    card.appendChild(body);
    section.appendChild(card);
  }

  root.appendChild(section);
}

function mount(): void {
  const root = document.getElementById("preview-root");
  if (root === null) {
    throw new Error("preview-entry: #preview-root element is missing from preview.html");
  }

  // Section 1 — Title bar
  appendSection(root, "1. Title bar", [
    {
      caption: "default state",
      build: () => {
        const el = document.createElement("iptv-title-bar");
        el.setAttribute("app-name", "IPTV Hub");
        el.setAttribute("search", "");
        return el;
      },
    },
  ]);

  // Section 2 — Chip bar
  appendSection(root, "2. Chip bar", [
    {
      caption: "all counts at 0 (no apps)",
      build: () => {
        const el = document.createElement("iptv-chip-bar");
        el.setAttribute("active", "all");
        el.apps = [...chipBarEmpty];
        return el;
      },
    },
    {
      caption: "mixed counts: 3 total, 1 update, 2 fav, 1 git, 1 web, 1 installer",
      build: () => {
        const el = document.createElement("iptv-chip-bar");
        el.setAttribute("active", "all");
        el.apps = [...chipBarMixed];
        return el;
      },
    },
  ]);

  // Section 3 — App card (4 status variants)
  const cardCases: VariantCase[] = appCardVariants.map((variant) => ({
    caption: variant.label,
    build: (): HTMLElement => {
      const el = document.createElement("iptv-app-card") as AppCardElement;
      el.app = variant.app;
      return el;
    },
  }));
  appendSection(root, "3. App card — status variants", cardCases);

  // Section 4 — Update modal (open inline with a git plan)
  appendSection(root, "4. Update modal — git plan (2 commits, 3 steps)", [
    {
      caption: "open with representative UpdatePlan",
      build: () => {
        // Wrap the modal in a relatively-positioned host so the fixed-position
        // backdrop renders inside the section card during the screenshot run.
        // The production styles position `.modal-backdrop` `position: fixed`;
        // the host containment override is scoped to the preview page only.
        const host = document.createElement("div");
        host.className = "preview-modal-host";
        const modal = document.createElement("iptv-update-modal") as UpdateModalElement;
        host.appendChild(modal);
        // `customElements.whenDefined` returns once the class is registered.
        // The component's open() flips internal state to render the body.
        void customElements.whenDefined("iptv-update-modal").then(() => {
          modal.open(updatePlanFixture, updateModalAppName);
        });
        return host;
      },
    },
  ]);

  // Section 5 — Activity log (4 fixture rows, one per level).
  // Opt out of the IPC-driven hydration + live subscription via
  // `data-source="manual"`, then call `setRows([...])` once the element is
  // connected so the visible DOM is purely fixture-driven. No mocked IPC.
  appendSection(root, "5. Activity log — 4 levels (info / warn / error / ok)", [
    {
      caption: 'seeded via setRows() — data-source="manual"',
      build: () => {
        const el = document.createElement("iptv-activity-log") as ActivityLogElement;
        el.dataset["source"] = "manual";
        queueMicrotask(() => {
          el.setRows([...activityRows]);
        });
        return el;
      },
    },
  ]);

  // Section 6 — Status bar (fixed next-sync)
  appendSection(root, "6. Status bar — 4 apps, next-sync = 10:30Z", [
    {
      caption: "4 apps · 1 update · 1 error · 2 favorites",
      build: () => {
        const el = document.createElement("iptv-status-bar") as StatusBarElement;
        el.setAttribute("next-sync", STATUS_BAR_NEXT_SYNC_ISO);
        el.apps = [...statusBarApps];
        return el;
      },
    },
  ]);
}

// DOMContentLoaded is already past by the time this module evaluates (Vite
// emits `<script type="module">` with `defer` semantics), but we still gate
// on document.readyState for predictability across browsers.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
