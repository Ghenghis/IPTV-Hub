// IPTV Hub — visual-regression smoke against preview.html (Agent 02 acceptance).
//
// preview.html (built by the Phase 4 preview agent) renders every Web Component
// in every documented state side-by-side. This spec drives Chromium against it
// and asserts the full-page screenshot matches a committed baseline at
// `frontend/tests/e2e/preview.spec.ts-snapshots/`.
//
// First run: `npx playwright test preview.spec.ts --update-snapshots` to write
// the baseline; commit the resulting PNGs.
// Subsequent runs: `npx playwright test preview.spec.ts` compares pixel-for-
// pixel with `maxDiffPixels` tolerance to absorb sub-pixel renderer variance.
//
// CI must run on the same OS the baseline was captured on (Playwright
// auto-suffixes snapshots with the OS), so the workflow uses `ubuntu-latest`
// for both the test job and the snapshot update job.

import { test, expect } from "@playwright/test";

// Disabled until baselines are committed. To enable:
//   1. Run `npx playwright test preview.spec.ts --update-snapshots` on the OS
//      whose snapshots you want to pin (Playwright keeps per-OS variants
//      side-by-side; CI runs on Linux).
//   2. Commit the generated PNGs under
//      `tests/e2e/preview.spec.ts-snapshots/`.
//   3. Set `IPTV_HUB_VISUAL_REGRESSION=1` in the runner so this test stops
//      skipping. Add it to the `playwright-e2e` job in
//      `.github/workflows/ci.yml` after baselines land in `main`.
const visualEnabled = process.env["IPTV_HUB_VISUAL_REGRESSION"] === "1";

test.describe("preview.html visual regression", () => {
  test.skip(!visualEnabled, "no committed baseline yet; set IPTV_HUB_VISUAL_REGRESSION=1 to enable");

  test("renders every component state matching the committed baseline", async ({ page }) => {
    // Suppress the expected "no __TAURI_INTERNALS__" log noise we tolerate in
    // shell.spec.ts — preview.html installs its own shim before mount, so we
    // expect zero console errors here.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/preview.html");

    // Wait for every custom element to upgrade. `customElements.whenDefined`
    // resolves synchronously after the tag is registered, so we test for the
    // presence of the rendered host content instead.
    await expect(page.locator("iptv-title-bar")).toBeVisible();
    await expect(page.locator("iptv-chip-bar").first()).toBeVisible();
    await expect(page.locator("iptv-app-card").first()).toBeVisible();
    await expect(page.locator("iptv-update-modal")).toBeAttached();
    await expect(page.locator("iptv-activity-log")).toBeVisible();
    await expect(page.locator("iptv-status-bar")).toBeVisible();

    // Give the preview-only IPC shim a tick to seed activity rows.
    await page.waitForTimeout(150);

    // Full-page screenshot. `maxDiffPixels` absorbs anti-aliasing differences
    // between rendering passes; `fullPage` captures everything below the fold
    // so changes to any component variant are detected.
    await expect(page).toHaveScreenshot("preview.png", {
      fullPage: true,
      maxDiffPixels: 200,
    });

    expect(consoleErrors, "preview.html must not log console errors").toEqual([]);
  });
});
