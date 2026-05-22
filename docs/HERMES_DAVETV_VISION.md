# Hermes + DaveTV — long-term vision

> **Status: vision-only.** This document is a long-term reference, not a
> replacement for any current plan. The source of truth for what we are
> actively building is unchanged:
>
> - [`VPS_ORCHESTRATOR.md`](VPS_ORCHESTRATOR.md) — VPS control-plane architecture
> - [`VPS_IMPLEMENTATION_PLAN.md`](VPS_IMPLEMENTATION_PLAN.md) — golden-path execution order (next 8 PRs)
> - [`PROVIDER_VAULT.md`](PROVIDER_VAULT.md) — credential storage design
> - [`BRANDING_AUDIT.md`](BRANDING_AUDIT.md) — IPTV-Hub vs DaveTV naming policy
>
> Nothing in this vision doc is allowed to introduce premature
> dependencies. Phases 1–3 below are already partially shipped (designs
> merged via PRs #19, #25, #26). **Phases 4–6 are deliberately later** —
> the VPS golden path (`wizju-iptv-player` end-to-end) must work first.

## Principles extracted as immediately useful

These are the long-term references the operator wants us to honour while
working on the current plan. Each principle is *one rule* with one
sentence of why and a one-line application to today's work.

| Principle | Why | Applied today |
|---|---|---|
| **PWA / web on VPS first** | A browser-served PWA reaches every device class (desktop, tablet, mobile, Samsung TV browser) with one build. Native Tizen comes later, not first. | The orchestrator's golden path serves `wizju-iptv-player` as a static PWA via nginx; no Tizen build path is in scope for phase 1. |
| **Samsung / Tizen WGT later** | Tizen `.wgt` packaging needs the Samsung Studio toolchain + per-TV signing + AVPlay shims; getting that wrong is a multi-week rabbit hole. The PWA satisfies most TV browsers (the Samsung 2018+ browser is Chromium-based). | Documented as **phase 5** below. `crunchyroll-tizen` in the catalogue is already labelled `no-tizen-tv` in `deploy/INVENTORY.md`; that stays accurate. |
| **Remote / D-pad UX** | TV users navigate with a 4-way remote, not a mouse. Hover-only controls are unreachable on a TV. Focus indicators must be visible at ~3 m away. | Every new component shipped from the vps-orchestrator UI work must pass `Tab` / arrow-key navigation in Playwright + show a visible focus ring at 1920×1080. Tracked as a gate in **phase 2**. |
| **Provider policy** | The user owns their subscriptions; IPTV-Hub never ships, brokers, or interprets a provider's terms. Credentials live in the OS keychain only. | Already locked in [`PROVIDER_VAULT.md`](PROVIDER_VAULT.md). No code change here. |
| **Proof gates** | Every claim ("works", "fast", "secure") needs a command output, log, screenshot, or CI link. Fixtures count only for unit tests, never for final E2E. | Already locked in `CONTRACT.md` and reinforced by `docs/PROOF_BUNDLE.md`. No code change here. |
| **Hermes typed-command bridge — later** | A typed, schema-versioned command layer between frontend ↔ orchestrator ↔ TV would replace today's ad-hoc HTTP + Tauri IPC and let one schema generate types for both ends. But it is **infrastructure that pays off after the product works**, not before. | Documented as **phase 4** below. Today's `frontend/src/lib/api.ts` keeps using hand-written TypeScript interfaces against axum HTTP routes; we do not introduce a code-generator yet. |

## Phases (long-term, in order)

Phase numbers below refer to the **broader product roadmap**, not the
P1–P8 phases inside `VPS_IMPLEMENTATION_PLAN.md` (those are the
implementation steps **inside** phase 1 here).

### Phase 1 — IPTV-Hub VPS orchestrator
**Status: in progress.** Architecture merged via PR [#25](https://github.com/Ghenghis/IPTV-Hub/pull/25); execution order merged via PR [#26](https://github.com/Ghenghis/IPTV-Hub/pull/26). The actual code lands in the eight P1–P8 PRs listed in `VPS_IMPLEMENTATION_PLAN.md`. Golden-path app: `wizju-iptv-player`.

Exit criterion: a real VPS run of the orchestrator builds, healthchecks, atomically promotes, and launches `wizju-iptv-player`; the failure path keeps the last known-good live; Playwright captures all four states; `docs/VPS_E2E_REPORT.md` exists.

### Phase 2 — TV-friendly DaveTV web GUI
**Status: starts after phase 1's P6 (web UI at `vps.html`) lands.** The orchestrator UI written for desktop in phase 1 is then extended with remote / D-pad UX so the same code serves a TV browser without forking.

Adds:
- focusable elements only (no hover-only buttons, no tiny click targets);
- visible 4-px focus ring per design tokens at 1920×1080;
- arrow-key / D-pad navigation across app cards (left/right within a row, up/down across rows);
- explicit "Enter" / "OK" remote-key handler routed to the same handler as click;
- safe-area padding so TV overscan does not crop the focused card;
- Playwright spec runs the navigation flow at the Samsung TV viewport (1920×1080) and asserts focus path.

Exit criterion: Playwright capture set under `docs/screenshots/` includes the dashboard navigated to each of: app-grid initial state, second-row focus via D-pad, settings panel open, all at 1920×1080. No clicks used in those captures — only keyboard events.

### Phase 3 — Provider Vault + per-app adapters
**Status: design merged via PR [#19](https://github.com/Ghenghis/IPTV-Hub/pull/19); implementation deferred to its own follow-up phase.** Six implementation phases (schema → backend → frontend paste-URI → QR scanner → launcher integration → catalogue adapters) listed at the foot of `PROVIDER_VAULT.md`.

The VPS orchestrator's Provider Vault integration adds a **launcher-page protocol** for `LocalStorageSeed` adapter kinds — the orchestrator runs server-side and cannot write to a remote browser's localStorage directly. The launcher-page protocol is documented in `VPS_ORCHESTRATOR.md` under "API surface (10 components)" entry 10 and the "Launcher-page protocol" section.

Exit criterion: a user enters one provider once (Xtream Codes / M3U / Stalker), and every DaveTV web app that declares a matching adapter receives the credentials at launch time without re-entry; no credential ever appears in a URL query parameter, a log line, or a screenshot.

### Phase 4 — Hermes typed-command bridge
**Status: not started, not in scope until phases 1–3 are done.** Hermes is the long-term replacement for the current pair of hand-written contracts: (a) the Tauri IPC interface in `frontend/src/lib/api.ts` ↔ `src-tauri/src/commands/*`, and (b) the VPS orchestrator's HTTP routes ↔ frontend client. Today these are correct only because we drift-check them by hand (and got that wrong once — see PR #21's IPC-drift false positive in the audit ledger).

Scope sketch (subject to change when the phase actually starts):
- one schema file (`schema/hermes.toml` or similar) declaring every typed command + event;
- generators for Rust types (consumed by orchestrator + Tauri backend) and TypeScript types (consumed by frontend);
- a transport layer that abstracts Tauri's `invoke` and the orchestrator's HTTP/SSE;
- versioning so the orchestrator can refuse a frontend talking an older schema, rather than mis-deserialise and silently drop fields (the bug pattern we saw with `UpdateOutcome.messages`).

Hermes is **not** a microservice mesh, **not** a code-generation framework with plugins, and **not** a runtime container. It is one schema file plus two `gen-types` invocations in the build. Anything more is over-engineering and rejected for this phase.

Exit criterion: every existing IPC command and orchestrator HTTP route is generated from one schema; a drift check runs in CI; the audit ledger no longer needs the "IPC drift" entry because the language can't allow the drift.

### Phase 5 — Tizen / WGT + AVPlay proof
**Status: not started, far future.** Native Samsung Tizen packaging on top of the same source tree as the PWA. Targets the older / locked-down Samsung TVs whose browser cannot render the PWA acceptably (Tizen 5.0 and earlier; 6.0+ browsers usually work as a plain PWA).

Adds:
- a `wgt:build` script that packages the existing Vite-built static bundle into a Tizen `.wgt`;
- AVPlay shim (`window.tizen.tvinputdevice.registerKey`, `window.webapis.avplay.*`) wrapped behind the same player abstraction the web build uses, so application code does not branch on platform;
- per-TV signing instructions for the operator;
- a verification that the same DaveTV app routes (the orchestrator's HTTP launch URL) work inside the Tizen WebView.

Exit criterion: one of the 10 web-deployable DaveTV apps boots as a `.wgt` on a real Samsung TV and plays one user-supplied stream; the WGT does not embed any provider credentials.

### Phase 6 — Agentic UI polish / proof runner
**Status: not started, far future.** Once phases 1–5 ship a working system, an agentic layer audits it continuously: Playwright runs across viewports, screenshots diff against committed baselines, broken-link / 404 / 502 alarms, performance budgets (TTFB, LCP), accessibility checks (focus ring contrast, keyboard reachability).

The "proof runner" is the same agent dispatcher we already use for code review (the wave-1 / wave-2 audit agents in this session) but pointed at the running system, not the source tree.

Exit criterion: the `docs/PROOF_BUNDLE.md` artifact regenerates on every release nightly (or on each merge to master), producing a self-updating snapshot of "what currently works" with timestamps and CI links.

## What this vision doc does NOT do

- Does not restructure the repo into a new monorepo. Hermes lands as additional files inside `schema/` and a code-gen step; the source layout does not need to change first.
- Does not add a Hermes runtime / framework / container. Hermes is a schema + two code-generators when it eventually ships.
- Does not bring forward Tizen / WGT work. The PWA serves Samsung 6.0+ browsers natively; older TVs are explicitly deferred.
- Does not promise that all 28 catalogue entries will be web-deployable. The 18 desktop/Tizen/static-playlist entries are documented as not-web in `deploy/INVENTORY.md` and remain so.
- Does not change the branding policy. "IPTV-Hub for DaveTV web apps" is the canonical phrase; product identity stays IPTV-Hub on every shell, login, installer, and title.

## How a future phase gets started

When the operator says "go phase 4" (or any later phase), the next session:
1. Reads this doc + the current phase's exit criterion.
2. Verifies the **prior** phase's exit criterion is met (no skipping).
3. Cuts a `feat/phase-N-<topic>` branch.
4. Writes a `docs/PHASE_<N>_<TOPIC>_PLAN.md` analogous to `VPS_IMPLEMENTATION_PLAN.md` with sub-phases and acceptance proof.
5. Opens a docs-only PR for the phase plan, same shape as PR [#25](https://github.com/Ghenghis/IPTV-Hub/pull/25) / [#26](https://github.com/Ghenghis/IPTV-Hub/pull/26).
6. Only after that lands do the implementation sub-phase PRs start.

This keeps each phase reviewable as a single planning step before any code lands, which is the discipline that's already produced PR #19 / #25 / #26 cleanly.
