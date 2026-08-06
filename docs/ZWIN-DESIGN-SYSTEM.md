# ZWIN Design System

Foundation for the redesign. Written 2026-08-04, before any feature page is
touched.

> **Visual target: the approved mockup, received and sampled.**
> Every colour below was read off the image with a dominant-colour sampler
> rather than guessed. Implemented in `public/broadsheet.css` (`:root`) and
> `public/staff.css` (`.pt`) — Phase 0/1 shipped.

Phases 0 and 1 are implemented: tokens, the two owner shells and the portal
shell. Everything under Components is still the contract the feature-page work
will be built against.

---

## 1. Design principles

1. **The screen must never disagree with the pay.** Any figure shown is
   computed by the same function that produces the money. This is a design
   constraint, not only an engineering one: if two components can show the same
   number, they share a source.
2. **Zeros are not information on a pay screen.** A cook shown "Card tips
   $0.00" reads it as a statement about their pay. Omit rather than render.
3. **Absence is not an answer.** A panel that disappears when empty makes
   "nothing here" and "this is broken" identical. Empty states are screens.
4. **Owner density and staff clarity are different products.** Never reuse an
   owner table in the portal.
5. **One primary action per screen.** Especially in the portal.

---

## 2. Colour tokens

Token *names* are kept from the previous stylesheet, so the migration was a
value change and not a rename — no feature page had to be touched to move the
whole app onto the new palette.

### Neutrals — the ground  · **implemented**

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#f6f7f9` | `#14181e` | App background (off-white) |
| `--surface` | `#ffffff` | `#1b2027` | Cards, panels, tables |
| `--surface-2` | `#f9fafb` | `#222831` | Table headers, recessed rows |
| `--surface-3` | `#f1f3f5` | `#2a313b` | Hover, pressed |
| `--rule` | `#e3e7ec` | `#2d343e` | Panel borders |
| `--rule-light` | `#edf0f4` | `#262c35` | Row dividers |
| `--field-border` | `#d5dae1` | `#333b45` | Inputs |

### Ink

| Token | Light | Dark |
|---|---|---|
| `--headline` | `#0f172a` | `#f2f5f9` |
| `--ink` | `#16202c` | `#e4e9ef` |
| `--body` | `#3d4653` | `#c0c8d2` |
| `--muted` | `#667085` | `#8b95a3` |
| `--faint` | `#98a2b3` | `#69727f` |

### The sidebar — one scale, dark in BOTH themes

Sampled from the mockup: the sidebar ground is `#1B2732`, the active pill
`#343E49`.

**Colour only.** The sidebar's structure, placement, open and closed states,
expand/collapse, active-item shape, dimensions, spacing, icons, labels,
animation, account placement and navigation organisation are unchanged from
before the redesign. The change is implemented as a token re-map scoped to
`.bs-side` — it declares no geometry, so none can move:

```css
.bs-side {
  --band-bg: var(--nav-bg);  --band-hover: var(--nav-bg-2);
  --band-line: var(--nav-rule);  --band-div: var(--nav-rule);
  --band-label: var(--nav-muted);  --secondary: var(--nav-muted);
  --muted: var(--nav-muted);  --faint: var(--nav-muted);  --ink: var(--nav-ink);
}
```

`--ac` (the per-module accent that colours the 3px active bar) is deliberately
NOT remapped: it is module identity, and it already reads on a dark ground.
The account stays in the masthead.

| Token | Value |
|---|---|
| `--nav-bg` | `#1b2733` |
| `--nav-bg-2` | `#28323f` (active pill, hover) |
| `--nav-ink` | `#eef2f7` |
| `--nav-muted` | `#93a1b3` |
| `--nav-rule` | `#26313e` |
| `--nav-on` | `#4b8bf5` (3px active bar) |

### Semantic — sampled from the mockup's own controls

| Token | Light | Dark | Sampled from |
|---|---|---|---|
| `--accent` | `#0b57d0` | `#6f9dfa` | "Add time" / "Clock out" — `#0151D2` / `#034FCE` |
| `--accent-hover` | `#08429e` | `#93b6fc` | — |
| `--primary-soft` | `#e8f0fb` | `#182640` | selected table row — `#E3EEF8` |
| `--ok` / `--positive` | `#16863a` | `#46b76a` | Approve button — `#199A2C` |
| `--ok-soft` | `#dcf3e1` | `#112617` | Approved badge — `#DBF2DE` |
| `--warning` | `#b25a09` | `#dd9a4a` | On-break / End-break — `#EE7F04` |
| `--warning-soft` | `#fdeadb` | `#2c2011` | Needs-review badge — `#FCE6DA` |
| `--danger` | `#b3261e` | `#e5776c` | blocking only |
| `--danger-soft` | `#fdeceb` | `#2b1614` | |

**Rule:** red is for *blocking* only. Amber carries everything that merely
needs a look.

### Portal tokens (`.pt`) — implemented in `staff.css`

`--pt-page #f6f7f9` · `--pt-field #ffffff` · `--pt-ink #0f172a` ·
`--pt-body #3d4653` · `--pt-muted #667085` · `--pt-blue #0b57d0` ·
`--pt-green #16863a` · `--pt-amber #b25a09` · `--pt-red #b3261e` ·
`--pt-line #e3e7ec` · `--pt-hair #edf0f4` · `--pt-r 12px` · `--pt-tap 48px`
Plus the three state tints from the mockup's status banners:
`--pt-ok-soft #e9f7ec` (Working) · `--pt-warn-soft #fdf3e2` (On break) ·
`--pt-info-soft #e8f0fb`.

### Radius, shadow, spacing, touch — implemented

`--r-sm 4px` · `--r-md 8px` · `--r-lg 12px` · `--r-full 999px`
`--sh-sm 0 1px 2px rgba(16,24,40,.05)` · `--sh-md 0 4px 12px rgba(16,24,40,.08)`
· `--sh-lg 0 12px 32px rgba(16,24,40,.14)`
`--s-1 4px` … `--s-8 40px` · `--tap 44px` (owner mobile) · `--tap-lg 48px` (portal)

### Typography — implemented

Headlines moved from serif to `--sans`: `.bs-headline` 24px/600/−.01em,
portal `.pt-hi` 27px/650 and `.pt-title`/`.tc-h` 25px/650. Figures keep
`--mono` with tabular numerals.

### Accents (module identity, already in `nav.js`)

Sidebar item accents stay as they are — they are per-module wayfinding, not
semantics. They must never be used for status.

---

## 3. Typography

| Role | Family | Size | Weight | Tracking |
|---|---|---|---|---|
| Display | `--sans` | 28 / 32px | 600 | −0.02em |
| Page title | `--sans` | 22 / 24px | 600 | −0.01em |
| Section title | `--sans` | 16px | 600 | 0 |
| Kicker / label | `--mono` | 10.5px | 500 | 0.1em, uppercase |
| Body | `--sans` | 14px | 400 | 0 |
| Body small | `--sans` | 13px | 400 | 0 |
| Fine print | `--sans` | 12px | 400 | 0 |
| **Figure** | `--mono` | 15px | 500 | 0, `tabular-nums` |
| **Hero figure** | `--mono` | 30 / 34px | 600 | −0.01em, `tabular-nums` |

- `--sans`: the existing Geist stack.
- `--mono`: the existing Geist Mono stack.
- **Every number that can be compared down a column uses `--mono` with
  `font-variant-numeric: tabular-nums`.** Money, hours, counts, times.
- Prose never uses mono. Kickers do, because they are labels, not sentences.

---

## 4. Spacing, radius, borders, shadow

**Spacing scale (4px base):** `2 · 4 · 6 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56`

Tokens: `--s-1: 4px` … `--s-8: 40px`. Nothing outside the scale.

**Radius**

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 4px | Badges, chips, inputs |
| `--r-md` | 8px | Cards, panels, buttons |
| `--r-lg` | 12px | Dialogs, sheets |
| `--r-full` | 999px | Pills, avatars |

**Borders** — `1px solid var(--rule)` for panels, `1px solid var(--rule-light)`
for internal dividers. Never both on the same edge.

**Shadow** — sparing, and never on a resting table row.

| Token | Value | Use |
|---|---|---|
| `--sh-sm` | `0 1px 2px rgba(16,24,40,.05)` | Cards |
| `--sh-md` | `0 4px 12px rgba(16,24,40,.08)` | Popovers, menus |
| `--sh-lg` | `0 12px 32px rgba(16,24,40,.14)` | Dialogs, sheets |
| `--sh-nav` | `0 0 0 1px rgba(0,0,0,.04)` | Sidebar edge |

**Icons** — 16px inline, 20px in nav and buttons, 24px in empty states.
`stroke-width: 1.8`, `currentColor`, never filled. **The emoji in
`modules.js` module definitions must be replaced with the SVG set.**

---

## 5. Components

### Buttons

| Variant | Use | Spec |
|---|---|---|
| Primary | The one action of the screen | `--primary` fill, white ink, `--r-md`, 9px/16px, 14px/600 |
| Secondary | Alternative actions | `--surface` fill, `--rule` border, `--ink` |
| Quiet | Tertiary | No fill, no border, `--body` |
| Danger | Destructive, always confirmed | `--danger` fill, white ink |
| Success | Approve | `--ok` fill, white ink |
| Small | Toolbars | 7px/12px, 13px |
| Pill | Requests-style counters | `--r-full`, optional count badge |

**One primary per screen.** Where two actions are equal (Approve / Decline),
use Success + Danger, not two primaries.

### Form controls

- Height 38px desktop, **44px minimum on mobile**.
- `--surface` fill, `1px solid var(--rule)`, `--r-sm`.
- Focus: `2px` `--primary` outline, `2px` offset. Never remove focus rings.
- Label above, 13px `--muted`. Help text below, 12px `--faint`.
- Error: `--danger` border + a message below, never colour alone.
- **Time and date use native `<input type="time">` / `type="date"`.** Proven
  in the portal edit sheet; the phone's own picker is the control everybody
  already knows.

### Tables / data ledger

One convention replaces the current three.

```
.ledger            grid container, column template declared once
.ledger-head       --surface-2, mono kicker labels, sticky on scroll
.ledger-row        --surface, 1px --rule-light bottom, hover --surface-3
.ledger-row.on     --primary-soft, 3px --primary left bar
.ledger-num        --mono, tabular-nums, right-aligned
.ledger-total      heavier top rule, 600 weight
```

**Invariant:** header cell count must equal the declared
`grid-template-columns` count in every responsive shape. There is already a
test asserting this on the payroll roster; it should extend to every ledger.

Responsive: columns fold at named breakpoints by hiding `nth-child`, never by
wrapping. The name and the take-home figure survive to the narrowest width.

### Status badges

`--r-full`, 11.5px/600, tinted background + strong ink:

| State | Token pair |
|---|---|
| Approved · Sent · Complete | `--ok` on `--ok-soft` |
| Pending · Submitted · Needs a look | `--warning` on `--warning-soft` |
| Declined · Blocked · Missing | `--danger` on `--danger-soft` |
| Draft · Open · Neutral | `--muted` on `--surface-2` |

Never colour alone — always a word.

### Metric card

```
[ KICKER LABEL          ]   mono 10.5 uppercase --muted
[ 36:27                 ]   mono 30 600 tabular --headline
[ sub-line context      ]   13px --muted
```
In a `--surface` card, `--r-md`, `--sh-sm`. A row of them shares one grid;
they never wrap mid-row on desktop.

### Page header

```
‹ Back (when the page has a parent)
PAGE TITLE                              [ actions ]
one-line subtitle / context
[ tab strip if the page has sub-views ]
```
Consistent across every owner page. The current app has at least four header
shapes (`bs-head`, `bs-headwrap`, `inc-rec-head`, `tsx-top`).

### Period selector

One component, used by Payroll, Timesheets, the portal timesheet and the
portal pay card — currently four separate implementations (`.tsm-per`,
`.tsx-per`, `.pp-nav`, the payroll chip row).

```
[ ‹ ]  Jul 18 – Jul 31  [ › ]   [ Today ]   [ custom range ]
```

### Filter bar

Search · chips · dropdowns · date range · right-aligned actions. Chips are
`--r-full`, selected = `--primary-soft` + `--primary` ink.

### Menus, dialogs, drawers, sheets

- **Action menu** — anchored popover, `--sh-md`, `--r-md`. Replaces the
  37 ad-hoc `<details>` elements.
- **Dialog** — centred, max 520px, `--r-lg`, `--sh-lg`, scrim
  `rgba(9,12,17,.45)`. Title, body, right-aligned actions.
- **Drawer** — right side, 480px, full height. Owner desktop only.
- **Bottom sheet** — the portal's `.pes-*` pattern is the reference and should
  be generalised: slides from the bottom, `--r-lg` top corners, max 92vh,
  scrim, back chevron top-left, one primary at the foot.
- **Confirmation flow** — destructive actions get a dialog naming what will
  happen, not a browser `confirm()`. (Payroll send currently uses `confirm()`.)

### Loading, empty, error

- **Loading** — skeleton rows matching the ledger's shape. Buttons that submit
  get a disabled + spinner state. *The app currently has none of this.*
- **Empty** — icon (24px, `--faint`), one line of what would appear here, and
  the action that creates the first one. Never a bare "No results".
- **Error** — inline in the affected panel, `--danger-soft`, with the reason
  and what to do. Full-page only for 403/404.
- **Permission** — "Not your area" with what the account can open instead.
- **Flash** — replace the `?msg=` redirect banner with a toast: `--sh-md`,
  4s auto-dismiss, `--ok` / `--danger` accent. Keep the querystring contract so
  no route changes.

---

## 6. Application shells

### 6.1 Owner desktop (≥ 1024px)

```
┌──────────┬──────────────────────────────────────────────┐
│          │  masthead: search · date · theme · bell · me │
│ sidebar  ├──────────────────────────────────────────────┤
│ (navy)   │  page header: title · actions · tabs         │
│  240px   ├──────────────────────────────────────────────┤
│          │  content — max 1440px, --s-6 gutter          │
│          │                                              │
└──────────┴──────────────────────────────────────────────┘
```

- Sidebar `--nav-bg`, 210px, collapsible to 48px with state in
  `localStorage.rc_nav` — all exactly as it already was. Only the colours moved.
- **Retire the band nav (`.bs-band`).** Sidebar + bottom bar is enough; the
  band is a third system for the middle widths and its group panel duplicates
  the sidebar's.

### 6.2 Owner mobile (< 900px)

```
┌──────────────────────────────┐
│ ‹  Page title         ⋯      │  contextual header, sticky
├──────────────────────────────┤
│ content, single column       │
│ cards not tables             │
├──────────────────────────────┤
│  ⌂     ≡     $     ▦    ⋯    │  bottom nav, safe-area inset
└──────────────────────────────┘
```

- No sidebar. Bottom nav keeps the current five slots
  (Home · Shifts · Sales · Invoices · Index).
- Detail pages are full-screen with a back chevron, not modals.
- Tables become stacked cards. Filters move into a sheet.
- Everything tappable ≥ 44px.

### 6.3 Employee Staff Portal (mobile-first, all widths)

```
┌──────────────────────────────┐
│ ‹ Back            SECTION    │  portalTop — already built, keep
├──────────────────────────────┤
│ Big page title               │
│                              │
│ one card / one list          │
│ minimal per screen           │
│                              │
│ [   ONE PRIMARY ACTION   ]   │
└──────────────────────────────┘
```

- Max width 460px, centred on desktop.
- No sidebar, no bottom nav, no masthead. The hub is the navigation.
- Type one step larger than the owner workspace: body 15–16px, titles 26–30px.
- Touch targets ≥ 48px.
- Bottom sheets for anything that would be a dialog.
- **No owner tables.** Day rows, fact rows, breakdown lines — never a grid
  the user must scroll sideways.
- The portal currently has **no dark theme**; either build one or pin it to
  light. Do not ship a half-dark portal.

---

## 7. Responsive breakpoints

Replace all 14 current values with four:

| Name | Width | Shift |
|---|---|---|
| `--bp-sm` | 640px | Stack everything; sheets full-width |
| `--bp-md` | 900px | Owner: sidebar → bottom nav |
| `--bp-lg` | 1200px | Full ledger columns |
| `--bp-xl` | 1440px | Max content width reached |

---

## 8. Component inventory — reuse vs replace

### Keep as-is (recently built, already on-pattern)

| Component | Where | Why |
|---|---|---|
| `portalTop()` + back script | portal, all sub-pages | Solves back-to-where-you-were correctly |
| `.pes-*` bottom sheet | portal edit/add shift | The reference for every future sheet |
| Requests queue two-pane | `/timeclock/requests` | Matches the approved direction already |
| Original-vs-Requested table | request detail | Reusable as a generic diff component |
| Requests pill (2 states) | Today + Timesheets toolbars | Keep the never-disappearing behaviour |
| Pay-period card | `/portal/earnings` | Correct shape; restyle only |
| `reqPill`, `reqDiff`, `pesSheet`, `pesScript` | server.js | Already extracted as helpers |

### Restyle, keep the markup

| Component | Note |
|---|---|
| Payroll roster ledger | Column logic is sound and test-guarded; new tokens only |
| Timesheet day grid `.tsg-*` | Click-to-edit works; needs the new surface + type |
| Portal day rows `.tsd-*` | Right shape for the portal |
| Metric strip `.bs-strip` | Becomes the metric-card row |
| Sidebar `sideNav()` | Structure is right; recolour to navy-charcoal |
| Bottom bar `bottomBar()` | Keep 5 slots, restyle |
| Status pills `.inc-st-*` | Consolidate onto the four semantic pairs |

### Replace

| Current | Replace with | Why |
|---|---|---|
| `.bs-band` band nav | (delete) | Third nav system, duplicates the sidebar |
| `.card`, `.btn-primary`, `.page-head` | New button + card + page header | Legacy `styles.css` primitives, reskinned not rebuilt |
| 37 ad-hoc `<details>` | Action menu component | No consistent anchoring, focus or escape handling |
| `.bs-shead/.bs-dayhead` (sales) | Ledger | Third grid convention |
| `.bs-payhead` (drill-down) | Ledger | Fourth grid convention |
| 4 period selectors | One period selector | They already drift |
| 4 page-header shapes | One page header | |
| `flash()` banner | Toast | Keep the `?msg=` contract |
| Emoji module icons | SVG icon set | Inconsistent with the sidebar |
| `browser confirm()` | Confirmation dialog | Payroll send, shift delete |
| `.cap-*` capture overlay | Full-screen capture flow on the new dialog primitives | 73 bespoke rules |

### Build new

App shell · Desktop sidebar · Mobile bottom nav · Page header · Period
selector · Filter bar · Search control · Status badge · Metric card · Data
ledger · Timesheet grid · Employee row · Detail panel · Action menu · Dialog ·
Bottom sheet · Time picker · Empty state · Issue panel · Confirmation flow ·
Toast · Skeleton loader · Diff table (original vs requested).

---

## 9. Recommended redesign order

### Phase 0 — foundation (no visible change)
Tokens, type scale, spacing, four breakpoints. Ship alongside the current
values so nothing moves yet. **Guard:** the existing custom-property test
already fails on an undefined token — extend it to reject values outside the
scale.

### Phase 1 — shells
Owner desktop shell, owner mobile shell, portal shell. Retire the band nav.
Every page inherits the new frame before any page is itself redesigned.
**Why first:** the shell decides the content width and header, so a page
redesigned before it will be redone.

### Phase 2 — Employee Portal Time Clock
`/portal/clock`, `/portal/clock/entry/:id`, the edit and add sheets.
**Why here:** smallest surface, most recently rebuilt, highest daily use, and
it exercises the sheet, the time picker, the confirmation flow and the empty
state — every portal primitive, on one screen, with the least risk.

### Phase 3 — Employee Portal remainder
Hub, timesheet, day, earnings + pay card, notifications, requests, tips
wizard. **Depends on** Phase 2's sheet and time picker.

### Phase 4 — Owner Time Clock + Timesheets
Today, ledger, entry detail, requests queue, timesheet grid, employee
timesheet. **Why before payroll:** timesheets feed payroll; the ledger and
the grid built here are what payroll then reuses. The requests queue is
already close to the target and will validate the ledger + detail-panel pair.

### Phase 5 — Owner Payroll
Roster, drill-down, summary, send flow. **Depends on** the ledger from
Phase 4 and the confirmation dialog. **Highest risk** — every figure is money
and the roster grid has a column-count invariant.

### Phase 6 — Owner Dashboard
**Deliberately after** the modules it links into, because it is composed of
their components. Redesigning it first would mean inventing card shapes twice.

### Phase 7 — Shifts, Sales, Cash, Performance

### Phase 8 — Trackers (10 modules on one generic engine — one change, ten pages)

### Phase 9 — Settings, Staff, Positions, Policy, Users, Menu costing

### Dependencies that fix this order

- Shell before pages — content width and header come from the shell.
- Ledger before Payroll — payroll is the heaviest ledger consumer.
- Timesheets before Payroll — approval feeds transfer.
- Sheet + time picker before the rest of the portal.
- Dashboard after its modules — it is a composition of them.
- Trackers last — one generic engine, so the whole group moves at once and
  benefits from every primitive settled earlier.

---

## 10. Non-negotiables during the redesign

1. No route added, renamed or removed.
2. No database change.
3. `/timeclock/requests` stays declared **before** `/timeclock/:id`.
4. The ledger header cell count must equal the declared grid columns in every
   responsive shape — the existing test stays green.
5. Every figure keeps its current source function. No component recomputes
   money.
6. Permission gates (`canWrite`, `payrollArea`, `tcCanEdit`, `requirePortal`,
   area checks) are untouched by styling work.
7. CSRF: forms keep server-side token injection; `window.fetch` stays wrapped.
8. `<script>` inside `innerHTML` never executes — any scripted component must
   be emitted on the host page, not injected into a fragment.
9. The 759-test suite stays green at every step.

---

## 11. Phase 2B components (shipped)

Portal only. All in `public/staff.css`, all token-driven.

### The status card — `.tcc`

One shape, four tones. Never a different layout per state.

```
.tcc              card shell (radius, hairline, 4px left rule)
  .tcc-top          dot + status word
  .tcc-clock        the live figure, tabular mono, 46px (38px under 360px)
  .tcc-cap          the caption under it
  .tcc-facts        ruled rows — borders, not background gaps, so it works
    .tcc-f          on a tinted card as well as a white one
  .tcc-note         explanatory line (.tcc-note-warn for amber)
  .tcc-acts         stacked full-width actions, primary first
  .tcc-form         the clock-in form (.tcc-field per asked question)
```

Tones: `.tcc-on` green · `.tcc-break` amber + `--pt-warn-soft` · `.tcc-warn`
amber rule only · `.tcc-blocked` red · `.tcc-off` neutral · `.tcc-done` green +
`--pt-ok-soft`.

**Red is reserved.** Only `.tcc-blocked` — no assigned position — is red. A
shift left open past the threshold is amber, because they are not blocked: they
can still clock out from that card.

### Bottom sheet additions — `.pes-*`

`.pes` was already the one sheet pattern. Phase 2B added:

- `.pes-panel-sm` — read-and-confirm sheets that size to content
- `.pes-rows` / `.pes-line` — label/value rows
- `.pes-acts` — Cancel + primary, `1fr 1.4fr`
- `.pes-more` — the "More changes" disclosure, with a rotating chevron
- `.pes-brk` — a break row: two `type="time"` faces, and a hidden pair carrying
  the full datetime that `pesScript` fastens the day onto at submit

`count()` in `pesScript` returns `0` for a sheet with no time fields, which is
what lets the submit-timesheet sheet share the shell.

### Shift detail — `.tcd-*`

`.tcd-tot` (payable, first) and `.tcd-st` (`-pending` amber, `-approved` green,
`-rejected` red).

### Feedback

Success is a toast (`.pt-toasts` / `.pt-toast.ok`, removed after 3.6s); failure
is `.tcc-alert` and keeps its place on the page. The URL keeps its `?ok=` either
way, so a reload still tells the truth.

---

## 12. Phase 2C components (shipped)

### One period selector — `.tsp`

Arrows step, the middle jumps. A native `<select>` listing a year of periods by
`labelFor()`, navigating on change.

```
.tsp          flex row
  .tsp-arrow    44px circular step control (.off when there is nowhere to go)
  .tsp-sel      full-width native select, 44px tall
```

### Filter chips — `.tc-chips` / `.tc-chip`

Pill row, count on the chip (`<i>`), `.on` for the selected one. The count is
the point: an empty queue is visible without selecting it.

### Original beside requested — `.tc-diff`

Two columns from `reqDiff()`, rows filtered to `changed`. Old value struck
through in muted, new value in ink. Same data the manager's queue reads.

```
.tc-diff        bordered block
  .tc-diff-h      "Was" / "Asked for" heads
  .tc-diff-r      label (full width) + old + new
```

### Day rows

Plain `.tc-row`, plus `.tc-row-bad` (red left rule) when the day carries a
blocking issue. Never a numeric grid — that was the owner-style table the
employee timesheet is explicitly not.

### Where overtime may appear

Period card and week header **only**. Not on a day row, not on a shift. A daily
overtime figure is an artefact of the order days were summed in; `splitWeeks`
can produce one, and the employee-facing screens deliberately do not show it.
