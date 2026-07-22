# ZWIN — Top bar + navigation (build spec)

Scope: the **global top bar and tab navigation ONLY** — the strip at the very top of every content page. This replaces the current single crowded row. See `example-banded-nav.png`.

Design chosen: **Expanding banded nav (16a rest → 16c on hover).** Two stacked strips so navigation reads as one distinct object; the tab band expands from a tidy single row into labeled groups when the cursor is on it.

## The interaction (read this first)
The tab band (Tier 2) has **two states**:
- **Rest / collapsed** = the single-row 16a layout (`state-collapsed.png`). This is what shows when the cursor is NOT on the band.
- **Hovered / expanded** = the 16c labeled-group layout (`state-expanded.png`). Tabs reflow into four clusters under tiny mono group labels (Overview / Operations / Purchasing / Restaurant).

When the user moves the cursor onto the tan band, it smoothly grows to reveal the grouped layout; when they move off, it collapses back to the single row. **The band pushes page content down while open and pulls it back on collapse — it must not overlap or float over content.**

### How to build the expand/collapse
Put both layouts inside one hover container and animate `max-height`/`opacity` (cheap, no layout thrash, degrades fine):
```html
<div class="nav-band">        <!-- background:#efe4d1; border-bottom:1px solid #ddd0b8 -->
  <div class="nav-collapsed"> …single-row 16a tabs… </div>
  <div class="nav-expanded">  …16c labeled groups…    </div>
</div>
```
```css
.nav-band .nav-expanded { max-height:0; opacity:0; overflow:hidden;
  transition:max-height .28s ease, opacity .18s ease; }
.nav-band .nav-collapsed { max-height:80px; opacity:1; overflow:hidden;
  transition:max-height .28s ease, opacity .18s ease; }
.nav-band:hover .nav-expanded  { max-height:180px; opacity:1; }
.nav-band:hover .nav-collapsed { max-height:0; opacity:0; }
```
Notes for the real build:
- Trigger on the **whole band**, not individual tabs, so the cursor never falls into a dead gap that collapses it.
- Add a small **open delay (~120ms) and a close delay (~200ms)** so a quick pass-through doesn't flicker it open, and a diagonal move to a far group doesn't snap it shut.
- **Keyboard/touch:** hover is enhancement only. On focus-within (tabbing in) keep it open; on touch devices, treat a tap on the band as toggle-open (there's no hover). The collapsed single row must be fully usable on its own.
- Respect `prefers-reduced-motion` — drop the transition, just swap states.
- Active tab stays the filled ink chip in BOTH states.

## Structure (two tiers)

### Tier 1 — Utility bar (`background:#f9f1e4`, `border-bottom:1px solid #ddd0b8`, padding `12px 26px`)
Left → right:
- **Wordmark** `ZWIN` — Geist 700, 17px, letter-spacing `.16em`, ink `#1f1d1a`.
- Vertical hairline divider (`1px × 18px`, `#d3c6ac`).
- **Location switcher** — "Palm Vintage ▾", Geist 500 12.5px `#443f33`, chevron `#a89f8a`. Opens the restaurant/location menu.
- **Search** — `max-width:440px`, `1px solid #cabfa4` border, `#fffdf9` fill, `⌕` glyph + placeholder "Search products, invoices, vendors, staff…" + `⌘K` hint chip on the right. Grows to fill available space.
- **Date stamp** (right-aligned, pushed by `margin-left:auto`) — mono 12px `#77705f`, uppercase, e.g. "WED, JULY 22 — EVENING".
- **Theme toggle** — 32px square, `1px solid #cabfa4`, `#fffdf9`, glyph `☾` (day) / `☀` (night).
- **Account chip** — see below.

> The old **"+ Log a shift" button is removed** from the top bar entirely. That action lives on the Shifts page and in the ⌘K command menu. Do not reintroduce it here.

### Tier 2 — Tab band (`background:#efe4d1`, `border-bottom:1px solid #ddd0b8`)
Reads as "this is the navigation." Two states (see interaction section above).

**Collapsed row** (padding `8px 26px`): a single horizontal row, all tabs.
- Tabs: Geist 500 13px, `#5c5647`, padding `6px 12px` each, `gap:2px`.
- **Active tab:** filled ink chip — `background:#1f1d1a`, text `#f4ead9`, weight 600. (No underline; the fill is the active state.)
- **Hover (inactive tab):** `#efe4d1`→`#e6d9c2` tint, text darkens to `#1f1d1a`.
- **Group dividers:** vertical hairline (`1px × 14px`, `#cdbfa2`) between the logical groups.
- **Overflow:** a right-aligned "More ▾" holds anything that doesn't fit at the current width. "Menu costing" keeps its small `BETA` mono tag.

**Expanded groups** (padding `12px 26px 16px`): four clusters, `gap:40px`, each a column with a tiny mono group **label** on top (`font:600 9.5px Geist Mono`, letter-spacing `.16em`, uppercase, `#b0a58c`) and its tabs in a row beneath (padding `5px 11px`):
  - `OVERVIEW` → Front page
  - `OPERATIONS` → Shifts · Sales · Performance · Cash · Payroll
  - `PURCHASING` → Invoices · Vendors · Products · Menu costing
  - `RESTAURANT` → Expirations · Equipment · Documents · Team
  No "More ▾" needed here — everything is visible once expanded.

## Account chip + dropdown (replaces the small "O")
Chip (in the utility bar): `1px solid #cabfa4`, `#fffdf9`, padding `5px 10px 5px 6px`, containing a 24px ink circle avatar with the initial (`#1f1d1a` bg, `#f4ead9` letter), the first name (Geist 600 12.5px), and a `▾`.

On click, a dropdown opens flush to the chip's right edge:
- Panel: `#fffdf9`, `1.5px solid #1f1d1a`, `box-shadow:0 8px 24px rgba(31,29,26,.14)`, width ~230px, radius 0.
- Header block: full name (Geist 600 13.5px) + role · email (Geist 400 12px `#77705f`), `border-bottom:1px solid #e5dac2`.
- Items (Geist 500 13px `#443f33`, padding `9px 14px`, separated by `1px #efe4d1`): **Settings · Users & access · Billing & usage · Email settings**, then **Sign out** in red `#9a2c1d`.
- Row hover: `#f4ead9` tint.

## Tokens
| Role | Hex |
|---|---|
| Utility bar bg | `#f9f1e4` |
| Tab band bg | `#efe4d1` |
| Strip borders | `#ddd0b8` |
| Field / chip / toggle border | `#cabfa4` |
| Field / chip fill | `#fffdf9` |
| Group divider | `#cdbfa2` / `#d3c6ac` |
| Ink (wordmark, active chip, avatar) | `#1f1d1a` |
| Tab text (inactive) | `#5c5647` |
| Muted (date, chevrons, placeholder) | `#77705f` / `#a89f8a` |
| Dropdown shadow | `rgba(31,29,26,.14)` |
| Sign out | `#9a2c1d` |
| Cream (text on ink) | `#f4ead9` |

Night theme (same layout): utility `#211e17`, tab band `#26241d`, borders `#46422f`/`#3d392d`, ink→cream `#f0ecdf`, text `#b8b2a0`, avatar cream bg + dark letter, dropdown `#221f18` on `1.5px #f0ecdf`.

## Type & rules
- Wordmark & tabs: Geist. Date stamp, `⌘K` hint, `BETA` tag, group labels: Geist Mono, uppercase, wide tracking.
- Border-radius 0 everywhere; no shadows except the account dropdown.
- Active tab = filled ink chip (one at a time). Keyboard: `⌘K` focuses search.
- Don't change page content below the bars — this spec governs the two nav strips and the account menu only.

## Screenshots
- `state-collapsed.png` — rest state (single row); also shows the full top bar and account chip
- `state-expanded.png` — hovered state (labeled groups)

If a visual detail is ambiguous, read the exact value from these screenshots.
