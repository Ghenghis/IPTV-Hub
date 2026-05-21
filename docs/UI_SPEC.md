# IPTV Hub — UI Specification

> This document is the **visual contract** between the agent swarm and the project owner.
> The tokens, components, and behaviours below were approved on the mockups. Any deviation
> is a UI bug.

## 1. Design philosophy

- **Dense control-panel feel.** No hero whitespace. Information per square inch is the
  optimization target.
- **Flat surfaces only.** No gradients, no drop shadows, no glow, no neon. Borders are
  hairline (0.5 px) and use the system border tokens.
- **Monospace for data.** Versions, SHAs, timestamps, file paths, byte counts, port
  numbers, and config keys are mono. Everything else is sans.
- **Dark by default with light mode parity.** Every token must work in both modes.
- **Sentence case everywhere.** No Title Case for buttons, headings, or labels except for
  proper nouns and pill labels (`GIT`, `REL`, `MSI`, `WEB`, `TIZEN`) which are uppercase
  by convention.
- **Two type weights only.** 400 (regular) and 500 (medium). No 600/700.

## 2. Design tokens

These tokens are the **only** colors and sizes allowed in the UI. They live in
[`frontend/src/styles/tokens.css`](../frontend/src/styles/tokens.css) and must be referenced
via CSS custom properties, never hard-coded.

### 2.1 Color tokens — dark mode (default)

```css
--bg-app:        #1a1a1a;   /* outermost background */
--bg-surface:    #232323;   /* cards, panels */
--bg-elevated:   #2a2a2a;   /* modals, popovers */
--bg-input:      #1f1f1f;   /* form inputs */
--bg-button:     #2d2d2d;   /* default buttons */
--bg-button-hover: #353535;

--fg-primary:    #e8e8e8;   /* primary text */
--fg-secondary:  #a8a8a8;   /* secondary text */
--fg-tertiary:   #6a6a6a;   /* tertiary, hints, timestamps */
--fg-muted:      #4a4a4a;   /* disabled */

--border-hairline: rgba(255,255,255,0.08);
--border-default:  rgba(255,255,255,0.14);
--border-strong:   rgba(255,255,255,0.22);
```

### 2.2 Color tokens — light mode

```css
--bg-app:        #fafaf8;
--bg-surface:    #ffffff;
--bg-elevated:   #ffffff;
--bg-input:      #f6f6f4;
--bg-button:     #f0f0ee;
--bg-button-hover: #e6e6e3;

--fg-primary:    #1a1a1a;
--fg-secondary:  #5a5a5a;
--fg-tertiary:   #8a8a8a;
--fg-muted:      #b8b8b6;

--border-hairline: rgba(0,0,0,0.06);
--border-default:  rgba(0,0,0,0.12);
--border-strong:   rgba(0,0,0,0.20);
```

### 2.3 Source-type pills (locked)

These five pills appear on every app card. The background/text pairs are part of the
visual contract and are intentionally low-saturation so they don't fight for attention.

| Pill | Background | Text | Used for |
| --- | --- | --- | --- |
| `GIT` | `#1a3a52` (dark) / `#E6F1FB` (light) | `#9ec5f0` (dark) / `#0C447C` (light) | Source repos tracked by git. |
| `REL` | `#3a2f5a` (dark) / `#EEEDFE` (light) | `#c9c0f0` (dark) / `#3C3489` (light) | GitHub releases / binary distributions. |
| `MSI` | `#5a4319` (dark) / `#FAEEDA` (light) | `#f0c98a` (dark) / `#633806` (light) | Windows installers (MSI/EXE). |
| `WEB` | `#1a4a3a` (dark) / `#E1F5EE` (light) | `#7ed4b2` (dark) / `#085041` (light) | Web/dev-server projects. |
| `TIZEN` | `#5a2a1f` (dark) / `#FAECE7` (light) | `#f0a890` (dark) / `#712B13` (light) | Samsung TV `.ipk` packages. |

### 2.4 Status indicators (locked)

```css
--status-ok:    #639922;   /* up to date, healthy */
--status-warn:  #BA7517;   /* update available, attention */
--status-err:   #E24B4A;   /* error, unreachable, failed */
--status-idle:  #B4B2A9;   /* never polled, paused */
```

Status is communicated as a 7 px solid dot to the right of the app name in cards, and as
text colour on numeric badges in the status bar.

### 2.5 Typography

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
--font-mono: "JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace;

--text-xs:   10px;     /* timestamps, sublabels */
--text-sm:   11px;     /* card meta, pill text */
--text-base: 12px;     /* default body */
--text-md:   13px;     /* card names, primary labels */
--text-lg:   14px;     /* section headers */
--text-xl:   16px;     /* main page heading */
--text-2xl:  18px;     /* big numbers (e.g. current SHA in update modal) */

--weight-regular: 400;
--weight-medium:  500;
```

Card name and primary labels use `--weight-medium`; everything else `--weight-regular`.

### 2.6 Spacing

```css
--space-1: 4px;
--space-2: 6px;
--space-3: 8px;
--space-4: 10px;
--space-5: 12px;
--space-6: 14px;
--space-7: 16px;
--space-8: 20px;
```

### 2.7 Radii

```css
--radius-sm: 4px;     /* pills, small chips */
--radius-md: 6px;     /* buttons, inputs */
--radius-lg: 8px;     /* cards, panels */
--radius-xl: 12px;    /* outer modal frame */
```

### 2.8 Layout

- Main window minimum: **920 × 600**.
- Default opening size: **1080 × 760**.
- Two-column app grid with a floor of **360 px per column**. Below 720 px window width
  collapse to one column.
- 1 px hairline gutters between cards (this is the divider; cards have no individual border).
- Page horizontal padding: **0** (the title bar and footer span edge to edge).

## 3. Components (locked specs)

### 3.1 Title bar

Top of the window, 44 px tall, `--bg-surface` background, bottom border `--border-hairline`.

- Left: app icon (`ti-device-tv`, 16 px), the literal string **"IPTV Hub"** at `--text-md`
  weight 500, then the version string in mono at `--text-sm` color `--fg-tertiary`.
- Right: search input (180 px wide, 28 px tall, `ti-search` leading icon), the
  **Sync now** button (info pill), and a settings icon button (26 × 26 with `ti-settings`).

The search input filters the visible app list client-side using a case-insensitive
substring match against the `name`, `id`, and the four mono-formatted version fields.

### 3.2 Chip bar

Below the title bar, 36 px tall, `--bg-surface` background, bottom border `--border-hairline`.

Chips have:

- Background `--bg-button`.
- Border `0.5px solid --border-hairline`.
- Border radius `999px` (full pill).
- Font `--text-sm`.
- Optional leading icon at 11 px.
- Optional trailing count in mono at `--text-xs`, opacity 0.6.

The **active** chip uses background `--bg-elevated`, font weight 500, border
`--border-default`.

Order:

1. **All** (always first, always shows total count).
2. **Updates** with `ti-bell` (only shown if count > 0).
3. **Web / dev** — sources where `manifest.launch.kind` is `web-server`.
4. **Windows** — sources where `manifest.type` is `installer` or `release-binary`.
5. **Electron** — apps whose launch command starts an Electron binary (detected at seed time).
6. **Tizen** — sources where `manifest.type` is `tizen-ipk`.
7. **Favorites** with `ti-star` — apps with `manifest.favorite: true`.

### 3.3 App card

The repeating unit in the main grid. Spec extracted from the approved mockup.

- Background `--bg-surface`.
- Padding `--space-4` `--space-5` (10 px vertical, 12 px horizontal).
- No border on the card itself; the 1 px gutters in the grid do the visual separation.
- Layout: three rows stacked with `--space-2` (6 px) between rows.

**Row 1 — header.** Flexbox, 9 px gap, items vertically centered to the top:

- **Icon** (30 × 30, `--radius-md`, mono initials at `--text-sm` weight 500). The
  background is the pill colour for the source type at half opacity; the text uses the
  pill text colour. Fallback initials are first two consonants of the `id`, uppercase.
- **Identifier block** (`min-width: 0; flex: 1`):
  - Name: `--text-md`, weight 500, line height 1.2, single line with ellipsis.
  - Sub: mono `--text-xs` color `--fg-tertiary`. For source-type git/web/tizen, this is
    the relative path under `upstream/`. For installer/release, it is `installed · <install dir>`
    or `release · <vendor/repo>`.
- **Status dot** (7 × 7 circle, color from §2.4, 4 px top margin to align with the first
  line of text).

**Row 2 — meta.** Flexbox, 6 px gap, wrap:

- **Source pill** (see §2.3).
- **Version** — for git: short SHA, optionally `→ <new sha>` if update available. For
  release/installer: semver, optionally `→ <new>`. For tizen: same. Mono `--text-sm`.
- **Age** (right-aligned via `margin-left: auto`): relative time of last successful poll,
  mono `--text-xs` color `--fg-tertiary`. Format: `just now`, `2m ago`, `14h ago`,
  `2d ago`, then absolute `2026-05-18`.

**Row 3 — actions.** Flexbox, 4 px gap. Three children, all 28 px tall:

- **Launch** — primary button (background `--fg-primary`, text `--bg-surface`). Leading
  icon `ti-player-play` at 12 px, label "Launch". Disabled if the app has never
  successfully smoke-tested or the launch command is missing.
- **Update** / **Up to date** — the second button shape-shifts based on status:
  - `UpdateAvailable`: warning style (background `#FAEEDA`/`#5a4319`, text `#633806`/`#f0c98a`,
    border `#EF9F27`). Leading icon `ti-download`, label "Update".
  - `UpToDate`: default button style. Leading icon `ti-check`, label "Up to date". Disabled.
  - `Error`: default button style. Leading icon `ti-refresh`, label "Retry".
- **More** — a 28 × 28 ghost icon button with `ti-dots`, opens the per-app menu (rename,
  open folder, copy launch command, view source, deploy to TV for tizen, disable polling,
  remove from manifest).

### 3.4 Update preview modal

The modal that appears when the user clicks **Update** on a card. Spec extracted from the
approved mockup.

- Outer frame: `--bg-surface`, `--radius-xl`, no shadow, `--border-default` 1 px.
- Width: 90 % of window, max 720 px.
- Six sections, divided by `--border-hairline` hairlines.

**Section 1 — header** (12 × 14 px padding):

- 36 × 36 icon (same source-type colour as the card).
- Title: "Update `<app-name>`".
- Subtitle: full source URL `·` branch/tag/release info, mono `--text-sm` color
  `--fg-tertiary`.
- Close button (26 × 26, `ti-x`).

**Section 2 — version diff** (two columns separated by a 1 px hairline):

- **Current** column (left): heading "CURRENT" with `ti-git-commit` icon, then big SHA
  (mono `--text-2xl`) + age tag, then "tag `<v>`" and "pulled `<timestamp>`" in mono
  `--text-sm`.
- **Target** column (right): heading "TARGET" with `ti-git-pull-request`, then big SHA
  in mono `--text-2xl` color `--status-ok`, then "N commits · +X / −Y lines" and "M files
  changed" in `--text-sm`.

For release sources, replace SHAs with version strings. For installer sources, show MSI
product version.

**Section 3 — incoming commits** (only for git/web sources):

- Heading "INCOMING COMMITS" at `--text-xs` color `--fg-tertiary` uppercase.
- Each row is a 3-column grid: SHA (64 px, mono, color `#185FA5` light / `#9ec5f0` dark),
  message (truncated to one line), author (right-aligned mono `--fg-tertiary`).
- Dashed hairline divider between rows.

For release sources, replace with release notes (rendered markdown, max 200 lines visible
with a "show more").

For installer sources, replace with the MSI changelog if `manifest.changelog_url` is set,
otherwise a one-line "Vendor MSI — no changelog metadata available".

**Section 4 — "what will happen"** (the plan steps):

Each step is a 3-column grid: number bubble (18 × 18, mono `--text-xs`), label block, tag.

The label block has a bold first line and an optional second line in mono `--text-xs`
color `--fg-tertiary`. Inline file paths get a mono pill background.

Tags use:

- `safe` — teal pill (`--bg` `#E1F5EE`/`#1a4a3a`, `--fg` `#085041`/`#7ed4b2`).
- `3–5 min` (time estimate) — amber pill (`--bg` `#FAEEDA`/`#5a4319`, `--fg` `#633806`/`#f0c98a`).
- `risky` (rare — e.g. installer reinstall that can't be cleanly rolled back without admin) —
  red pill (`--bg` `#FCEBEB`/`#5a1f1f`, `--fg` `#A32D2D`/`#f09595`).

The plan content is generated by `Source::plan()` and is **never hand-written in the
frontend**. The frontend just renders the structured plan.

**Section 5 — footer** (10 × 14 px padding):

- Left: hint text with `ti-shield-check` — "rollback retained for `<N>` days".
- Right: two buttons — **Cancel** (default style) and **Apply update** (warning style,
  with `ti-download` icon).

### 3.5 Activity log row

In the bottom panel of the main view.

- 4-column grid: time (56 px mono `--text-sm` color `--fg-tertiary`), action (70 px mono
  `--text-sm` color `--fg-secondary`), message (1fr, mono `--text-sm` color `--fg-primary`,
  ellipsis), status (60 px mono `--text-sm` right-aligned, colour by status).
- Dashed `--border-hairline` between rows.
- Initial display: 4 most-recent rows. "Show all" button at the bottom opens a full-page
  activity view.

### 3.6 Status bar

Sticks to the bottom of the window. 30 px tall, `--bg-surface`, top border `--border-hairline`.

- Left: stat counts in mono `--text-sm` — "N apps", "N updates" (color `--status-warn` if > 0),
  "N error" (color `--status-err` if > 0), "N favorites".
- Right: "Next auto-sync · `<HH:MM>` (`<N>`m)" mono `--text-sm` color `--fg-secondary`.

## 4. Component file layout (frontend)

```
frontend/src/components/
├── app-card.ts           # <iptv-app-card> — owns row 1, row 2, row 3 of an app card
├── chip-bar.ts           # <iptv-chip-bar> — filter chip row
├── activity-log.ts       # <iptv-activity-log> — bottom activity panel
├── update-modal.ts       # <iptv-update-modal> — the update preview modal
├── status-bar.ts         # <iptv-status-bar> — bottom bar
├── title-bar.ts          # <iptv-title-bar> — top bar with search and sync
└── icon.ts               # <iptv-icon name="..."> — Tabler icon wrapper
```

Each component is a Web Component (Lit-free, vanilla `HTMLElement`) so the frontend has
zero runtime framework dependencies.

## 5. CSS file layout

```
frontend/src/styles/
├── tokens.css            # the tokens above
├── reset.css             # tiny reset (box-sizing, line-height, no scrollbar gutter shift)
├── base.css              # body, root, dark/light switching, font loading
└── components.css        # all component CSS, scoped via class prefixes
```

Tokens are applied at `:root`; dark/light switching is via `@media (prefers-color-scheme: dark)`
and a manual override stored in localStorage (key: `iptv-hub-theme`, values: `system`,
`dark`, `light`).

## 6. Iconography

Tabler outline icons via the webfont. Already covered: ti-device-tv, ti-search, ti-refresh,
ti-settings, ti-bell, ti-star, ti-player-play, ti-download, ti-check, ti-dots, ti-x,
ti-git-commit, ti-git-pull-request, ti-list, ti-list-check, ti-shield-check, ti-history.

Adding a new icon requires:

- Verifying the name exists in Tabler outline.
- Adding it to the icon registry in `frontend/src/components/icon.ts`.
- Updating this document.

## 7. Accessibility

- Every interactive element has a focus ring (2 px `--border-strong`).
- Every icon-only button has an `aria-label`.
- Decorative icons get `aria-hidden="true"`.
- Status is communicated by both colour and shape/text — colour is never the only signal.
  The status dot is paired with the second-button label change (`Up to date` vs `Update`
  vs `Retry`).
- The chip bar uses `role="tablist"` and chips are keyboard-navigable.

## 8. Test coverage (UI)

- One Playwright/WebdriverIO test per component must verify it renders with real data
  from a fixture manifest.
- One end-to-end test must drive the full flow: launch app → click chip → click update on
  a card with a flagged update → confirm in modal → see activity row appear → see card
  status flip to ok.

See [`docs/TESTING.md`](./docs/TESTING.md) for the testing details.
