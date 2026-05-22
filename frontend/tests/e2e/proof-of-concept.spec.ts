// IPTV Hub — proof-of-concept screenshot capture for the GitHub project page.
//
// This spec drives the Vite-served frontend and saves PNG screenshots of six
// canonical UI states. The PNGs land under `artifacts/screenshots/` at the
// repo root (the `artifacts/` directory is `.gitignore`d; CI will upload them
// as a workflow artifact, and `docs/PROOF_OF_CONCEPT.md` references them by
// relative path).
//
// Why a separate spec from `shell.spec.ts`?
//   - `shell.spec.ts` is an assertion-driven smoke test (does the shell
//     behave correctly?). It only takes screenshots on failure.
//   - This spec is *evidence-driven* (here is what the app looks like, for
//     human review and for the README). It always saves PNGs.
//
// Determinism:
//   - Animations and transitions are disabled at the page level before each
//     screenshot via a `data-e2e-snapshot` attribute on `<html>`. The frontend
//     CSS in tokens.css (and per-component sheets) carries a rule that turns
//     off all `animation` and `transition` properties when that attribute is
//     present (added in this PR alongside the spec).
//   - Viewport is fixed to 1280×720 via the Chromium project's `Desktop
//     Chrome` device descriptor.
//   - We do NOT seed live data; the "no Tauri runtime" path is the same one
//     CI exercises in `shell.spec.ts`, so the app-grid will be empty. For
//     screens that need rich content (app cards, activity rows), we drive
//     the `preview.html` route instead — that page mounts each component
//     with fixture data baked into the bundle.

import { expect, test } from "@playwright/test";

// Resolved at test time so the screenshots land at the repo root, not under
// `frontend/test-results/`. Playwright runs from `frontend/`, so `../` is the
// repo root. `artifacts/screenshots/` is already in `.gitignore`.
const SCREENSHOT_DIR = "../artifacts/screenshots";

// Disable animations and transitions for the page before each screenshot. The
// rule targets the `data-e2e-snapshot` attribute on `<html>`; the matching CSS
// override is in `frontend/src/main.css`.
async function freezeAnimations(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-e2e-snapshot", "");
  });
  // Wait one rAF tick so any in-flight transitions complete the trip to their
  // final state before we snap.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

test.describe("IPTV Hub — proof-of-concept screenshots", () => {
  test.beforeEach(({ page }) => {
    // Silence the expected no-Tauri-bridge console.error noise so the report
    // doesn't flag it as a failure on the screenshot specs.
    // Synchronous: only registering a listener; no awaitable work.
    page.on("console", () => {
      /* deliberately ignore for screenshot-only specs */
    });
  });

  test("01-shell-baseline — empty shell, all chip active", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("iptv-title-bar .title-bar__logo")).toHaveText("IPTV Hub");
    await freezeAnimations(page);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-shell-baseline.png`,
      fullPage: true,
    });
  });

  test("02-chip-filter-git — clicking the Git chip activates it", async ({ page }) => {
    await page.goto("/");
    const chipBar = page.locator("iptv-chip-bar");
    await expect(chipBar).toBeVisible();
    const gitChip = chipBar.locator('[data-filter="git"]');
    await gitChip.click();
    await expect(gitChip).toHaveAttribute("aria-pressed", "true");
    await freezeAnimations(page);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-chip-filter-git.png`,
      fullPage: true,
    });
  });

  test("03-settings-overlay — Settings overlay open on top of shell", async ({ page }) => {
    await page.goto("/");
    const titleBar = page.locator("iptv-title-bar");
    await expect(titleBar).toBeVisible();
    await titleBar.locator('[data-action="settings"]').click();
    const overlay = page.locator("#overlay-root");
    await expect(overlay).not.toHaveAttribute("hidden", "");
    await expect(overlay.locator(".settings__title")).toHaveText("Settings");
    await freezeAnimations(page);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-settings-overlay.png`,
      fullPage: true,
    });
  });

  test("04-search-bound — typing into the search input updates the title bar", async ({ page }) => {
    await page.goto("/");
    const titleBar = page.locator("iptv-title-bar");
    const searchInput = titleBar.locator('input[type="search"], input[data-role="search"]').first();
    if ((await searchInput.count()) > 0) {
      await searchInput.fill("iptv");
    }
    await freezeAnimations(page);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-search-bound.png`,
      fullPage: true,
    });
  });

  test("05-preview-gallery — preview.html renders every component with fixtures", async ({ page }) => {
    await page.goto("/preview.html");
    // preview-entry.ts mounts each component with seeded variants; wait for at
    // least the title-bar and an app-card to attach so the snap is meaningful.
    await expect(page.locator("iptv-title-bar").first()).toBeVisible();
    await expect(page.locator("iptv-app-card").first()).toBeVisible();
    await freezeAnimations(page);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-preview-gallery.png`,
      fullPage: true,
    });
  });

  test("06-preview-update-modal — preview's update-modal section in isolation", async ({ page }) => {
    await page.goto("/preview.html");
    // Scroll to the update-modal preview section. preview-entry.ts gives each
    // section a stable id like `section-update-modal` — fall back to locating
    // the first `<iptv-update-modal>` if the anchor is not present.
    const modal = page.locator("iptv-update-modal").first();
    if ((await modal.count()) > 0) {
      await modal.scrollIntoViewIfNeeded();
    }
    await freezeAnimations(page);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-preview-update-modal.png`,
      fullPage: true,
    });
  });
});
