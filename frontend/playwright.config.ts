// Playwright configuration for the IPTV Hub frontend E2E smoke test.
//
// Strategy:
//   This config boots the Vite dev server (npm run dev) on port 5173 and
//   drives Chromium against it. The frontend's `load()` call will issue an
//   `invoke()` to the Tauri backend; without a Tauri runtime present, that
//   call throws and the shell renders its error banner / empty grid. That is
//   itself a real code path — no fake responses are injected. The test then
//   exercises the UI shell (title bar, chip bar, settings overlay) which
//   does not depend on backend data.
//
// Why not boot `cargo tauri dev` here?
//   `cargo tauri dev` opens a native desktop window and binds the webview to
//   the OS message loop; Playwright cannot connect to that webview without
//   `tauri-driver` (a WebDriver bridge). Integrating `tauri-driver` is a
//   future Wave-4 task documented in docs/AGENT_PLAN.md. The Vite-only
//   approach below covers shell-level interactions and is what CI runs
//   today.
//
// Local prerequisite (one-time): `npx playwright install chromium`.

import { defineConfig, devices } from "@playwright/test";

// The Vite dev server is normally on 5173 (see vite.config.ts), but a
// developer may have another project occupying that port. We allow an
// env-var override (IPTV_HUB_E2E_PORT) so the same config works in both
// CI (clean machine, port 5173 free) and a busy dev workstation. The
// vite-side override is supplied via the `--port` CLI flag below.
const port = Number(process.env["IPTV_HUB_E2E_PORT"] ?? "5173");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // `--strictPort=false` lets Vite fall back if its compiled-in port is
    // taken (the override env var here points us at the *actual* port).
    command: `npm run dev -- --port ${port} --strictPort`,
    url: baseURL,
    // Always start a fresh Vite for E2E. Reusing an existing server is risky
    // when another project on the same machine is also bound to the same
    // port; Vite's strictPort will fail loudly if the port is occupied,
    // which is the desired behaviour.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
