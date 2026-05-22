// IPTV Hub — shell smoke E2E.
//
// What this exercises
// -------------------
// Drives the real Vite-served frontend at http://127.0.0.1:5173 with a real
// Chromium browser via Playwright. The shell renders the four custom
// elements (`<iptv-title-bar>`, `<iptv-chip-bar>`, `<iptv-activity-log>`,
// `<iptv-status-bar>`) and an `#overlay-root` host for the Settings page.
// The frontend's `load()` invokes `api.apps.list()`, which calls Tauri's
// `invoke()`. When this test runs against the Vite dev server (no Tauri
// runtime), that call rejects and the shell renders its error path: the
// app grid stays empty and a banner string is set in module state. No
// IPC responses are mocked or canned. That error path is itself a real
// code path being exercised.
//
// Why not drive `cargo tauri dev`?
// --------------------------------
// `cargo tauri dev` opens a native window whose webview is owned by the
// OS, not by Chromium. Playwright cannot drive it without `tauri-driver`
// (a WebDriver bridge for Tauri). That integration is tracked as a
// Wave-4 follow-up; the present test covers the shell-rendering and
// shell-interaction contract that the frontend owns end-to-end.
//
// Local one-time setup
// --------------------
//   cd frontend
//   npm install
//   npx playwright install chromium
//
// Then `npm run test:e2e` runs this file. CI does the same install via the
// `scripts/test.{sh,ps1}` gate.
//
// Documented limitation
// ---------------------
// The shell currently has no Esc-to-close or click-outside-to-close handler
// on `#overlay-root` (see `frontend/src/main.ts::closeOverlay`, called only
// from `openOverlay`). The test therefore asserts that the overlay opens
// and renders its Settings content; the closing semantics will be added in
// a follow-up slice (and this test extended) once the shell exposes a
// public close action.

import { expect, test } from "@playwright/test";

test.describe("IPTV Hub shell", () => {
  test("renders title bar, drives chip filters, opens settings overlay", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        // Filter the expected `invoke()` rejection from the no-Tauri-runtime
        // load path; everything else is a genuine failure we want to see.
        const text = msg.text();
        if (
          !text.includes("__TAURI_INTERNALS__") &&
          !text.includes("__TAURI_IPC__") &&
          !text.includes("window.__TAURI") &&
          !text.includes("Failed to fetch") &&
          !text.includes("not a function")
        ) {
          consoleErrors.push(`console.error: ${text}`);
        }
      }
    });

    // Step 1 — load the dev-served shell.
    await page.goto("/");

    // Step 2 — wait for the title bar custom element to attach and render.
    // The element renders synchronously in connectedCallback; we still wait
    // for the `.title-bar__logo` child to be present which is what the user
    // would observe.
    const titleBar = page.locator("iptv-title-bar");
    await expect(titleBar).toBeVisible();
    await expect(titleBar.locator(".title-bar__logo")).toHaveText("IPTV Hub");

    // Step 3 — assert the chip bar is present and rendered. The chip-bar
    // computes counts from the (empty) apps list and always renders the
    // seven non-Updates chips (Updates is hidden when its count is zero,
    // per UI_SPEC §3.2).
    const chipBar = page.locator("iptv-chip-bar");
    await expect(chipBar).toBeVisible();
    const allChip = chipBar.locator('[data-filter="all"]');
    await expect(allChip).toBeVisible();
    await expect(allChip).toHaveAttribute("aria-pressed", "true");

    // Step 4 — click each non-default chip and assert it becomes active.
    // We skip the Updates chip because it is hidden when its count is 0.
    const chipKeys = ["favorites", "git", "web", "installer", "release", "tizen"];
    for (const key of chipKeys) {
      const chip = chipBar.locator(`[data-filter="${key}"]`);
      await expect(chip).toBeVisible();
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(chip).toHaveClass(/chip--active/);
    }

    // Reset to the All chip so the overlay opens against a known state.
    await allChip.click();
    await expect(allChip).toHaveAttribute("aria-pressed", "true");

    // Step 5 — click the Settings button; assert the overlay opens.
    const overlay = page.locator("#overlay-root");
    await expect(overlay).toHaveAttribute("hidden", "");
    const settingsBtn = titleBar.locator('[data-action="settings"]');
    await settingsBtn.click();
    await expect(overlay).not.toHaveAttribute("hidden", "");
    // Settings page mounts its own header inside the overlay.
    await expect(overlay.locator(".settings__title")).toHaveText("Settings");

    // No console-level errors other than the Tauri-bridge absence noted above.
    expect(consoleErrors, `unexpected page errors observed:\n${consoleErrors.join("\n")}`).toEqual([]);
  });
});
