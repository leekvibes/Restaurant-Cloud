# ZWIN — Complete UI & Navigation Map

Audit date: 2026-08-04 · Source: `src/server.js` (19k lines), `src/modules.js`,
`src/nav.js`, `src/views.js`, `src/portal.js`, `public/broadsheet.css`,
`public/staff.css`.

**204 routes** across two products: **197 in `server.js`** plus **7 generic
module routes in `modules.js`**. This document maps all of them.

Nothing here proposes a change. It records what exists so a redesign can
proceed page by page without losing a screen.

---

## 0. The two products

| | Owner workspace | Employee Staff Portal |
|---|---|---|
| Audience | Owner, managers, back-office users | Floor staff |
| Auth | Email + password session (`/login`), or open when `APP_PASSWORD` is unset | 4–8 digit PIN (`/tips/start`), cookie `zwin_portal` |
| Shell | `layout()` — masthead + sidebar + content | `portalPage()` — bare, `body.bare`, no masthead |
| Stylesheet | `broadsheet.css` (+ legacy `styles.css`) | `staff.css` (+ both of the above, loaded but mostly unused) |
| Density | Dense operational tables | One thing per screen |
| Primary device | Desktop, with mobile fallbacks | Phone, installed as a PWA |
| Manifest | `/manifest.webmanifest` | `/manifest-tips.webmanifest` |

They share the server, the database and the `layout()` function, but not the
chrome: `portalPage()` calls `layout(..., { bare: true, staff: true })`, which
suppresses the masthead, sidebar and bottom bar entirely.

### Roles and access

Three concepts, often confused:

1. **Role** — `viewer` | `editor`. A `viewer` is refused on any non-GET
   (`server.js:572`). The owner account (`MASTER`) is always `editor`.
2. **Area** — `nav.js` `AREAS`: `dashboard, shifts, sales, costs, cash,
   payroll, trackers, menu, staff, settings`. Each owns URL prefixes. A user
   holds a list of area keys. **Area keys are stored on accounts — renaming one
   revokes access.**
3. **Page-level gates** — `canWrite()`, `punchReadable()`, `tcCanEdit()`,
   `payrollArea()`, `requirePortal()`. Payroll powers (approve, lock, reopen,
   return, transfer) are gated on `payrollArea()` *in the route*, not by URL
   prefix.

`areaFor()` uses longest-prefix matching and is lowercased before matching.
An unlisted path returns `null`, and **null means open** — `nav.js` throws at
boot if a nav link names no area, which is the guard that catches it.

---

## 1. OWNER WORKSPACE

### 1.1 Global chrome

| Element | Where | Notes |
|---|---|---|
| Masthead | `views.js` | Wordmark, restaurant name, global search (`⌘K`), date+daypart, theme toggle, notification bell with unread count, account menu |
| Account menu | `<details class="bs-acct">` | Settings · Users & access · Billing · Email settings · Sign out |
| Sidebar | `views.js` `sideNav()` | Grouped, collapsible, pinnable; state in `localStorage.rc_nav` |
| Sub-nav | `views.js` `subNav()` | Only drawn when a group has ≥2 pages |
| Band nav | `views.js` | Horizontal nav for mid widths, with a hover-expand group panel |
| Bottom bar | `views.js:608` `bottomBar()` | **Mobile only, under 900px.** Home · Shifts · Sales · Invoices · "Index" (⋯) overflow |
| Create button | `nav.js` `CREATE_ACTIONS` | Shift · Invoice · Vendor · Product · Menu item · Incident · Cash count · Employee — each filtered by area |
| Global search | `GET /search` | Products, invoices, vendors, staff |
| Flash | `flash(req)` | `?msg=` + `?err=1` querystring convention, used by **every** POST redirect |
| Theme | `data-theme` on `<html>` | `day` / `night`, set pre-paint from `localStorage.zwin_theme`. **12 night-theme blocks exist in `broadsheet.css`.** |
| Version poller | inline script | Polls `/version`, reloads once per new build if no unsaved input |
| Splash | inline | Only in standalone PWA, once per launch |

### 1.2 Navigation tree — the authoritative source is `src/nav.js` `SECTIONS`

```
Dashboard  /                                        [area: dashboard]

Operations
├── Shifts        /shifts                           [shifts]
├── Sales         /sales                            [sales]
├── Performance   /costs                            [costs]   (key is 'costs', label moved)
├── Cash          /cash                             [cash]
└── Payroll       /payroll                          [payroll]

Purchasing
├── Invoices      /c/invoices                       [trackers]
├── Expenses      /c/expenses                       [trackers]
├── Vendors       /c/vendors                        [trackers]
├── Products      /c/products                       [trackers]
└── Menu costing  /menu                    BETA     [menu]

Restaurant
├── Expirations   /c/expirations                    [trackers]
├── Equipment     /c/equipment                      [trackers]
├── Documents     /c/documents                      [trackers]
└── Contacts      /c/contacts                       [trackers]

Tasks & logs
├── Recurring tasks /c/recurring                    [trackers]
├── Incident log    /c/incidents                    [trackers]
└── Decisions log   /c/notes                        [trackers]

Team
├── Time clock    /timeclock                        [staff]
├── Portal        /staff-portal                     [staff]
├── Staff         /employees                        [staff]
├── Positions     /positions                        [settings]
└── Tip-out policy /policy                          [settings]

Not in the sidebar — reached from the account menu or by link only:
├── Settings      /settings                         [settings]
├── Users & access /users                           [settings]
├── Email         /email                            [settings]
├── Notifications /notifications                    (no area — open to any signed-in account)
└── Cash tips page /tips                            (staff-facing, listed in SETTINGS_GROUPS)
```

---

### 1.3 Module by module

---

#### DASHBOARD — `/`

**For:** what needs attention today. **Who:** owner, managers.

```
Dashboard  /
├── Attention panel → deep links into every module
├── Floor reports (out-of-stock from the portal)
├── Specials / 86 board summary
├── Drop record (cash)
└── Period / payroll readiness
```

- **Data:** open shifts, unsent payroll, overdue invoices, stale floor reports,
  document deadlines, pending correction requests, missing punches.
- **Actions:** none of its own — every tile is a link.
- **Dependencies:** reads Shifts, Cash, Payroll, Trackers, Time clock, Portal.
- **UI problems:** the densest page in the app and the least structured; tiles
  are heterogeneous; no consistent card shape.

---

#### SHIFTS — `/shifts`  [area: shifts]

**For:** the nightly service record and the tip-out engine. **Who:** managers.

```
Shifts  /shifts
├── New shift              GET/POST /shifts/new, /shifts
├── Shift detail           GET  /shifts/:id
│   ├── Add server          POST /shifts/:id/server
│   ├── Add support         POST /shifts/:id/support
│   ├── Remove person       POST /shifts/:id/remove
│   ├── Reset hours         POST /shifts/:id/hours-reset
│   ├── Pool settings       POST /shifts/:id/pool
│   ├── Read floor report   POST /shifts/:id/read-report   (AI reader)
│   ├── Delete shift        POST /shifts/:id/delete
│   └── Hours format toggle POST /shifts/hours-format
├── Results / review       GET  /shifts/:id/results
│   ├── Preview one email  GET  /shifts/:id/email/:employeeId
│   ├── Send to one        POST /shifts/:id/send-one
│   └── Send to all        POST /shifts/:id/send        ← fires per-person portal
│                                                          notification + push
└── (filter chips: status)
```

- **Data:** date, daypart, servers with sales + card/cash tips, support staff,
  hours, tip-out pots, pool, reconciliation.
- **Business rules:** one shift per (date, daypart) — `getOrIgnore` +
  `findShift` is the only find-or-create path. `work.hours` is **both** the
  payroll basis and the tip-split weight. Sending marks `markEmailed`.
- **Mobile:** list becomes stacked cards; detail becomes stacked person cards.
- **UI problems:** the review/send screen carries blockers, per-person emails
  and a bulk send in one column; hours-format is a global toggle living on a
  shift page.

---

#### SALES — `/sales`  [area: sales]

```
Sales  /sales
├── Day detail       GET  /sales/:id
│   ├── Save         POST /sales/:id
│   ├── Mark closed  POST /sales/:id/closed
│   └── Reopen       POST /sales/:id/open
└── Range picker (r=custom&from=&to=)
```

- **Data:** per-day revenue by category, covers, notes.
- **UI problems:** the day ledger uses `.bs-shead/.bs-dayhead` — a *third*
  ledger grid convention alongside `.bs-lhead/.bs-rhead` and `.bs-payhead`.

---

#### PERFORMANCE — `/costs` (and `/performance`)  [area: costs]

```
Performance  /costs
├── Targets dialog   POST /costs/targets   (labor %, food %, prime %)
└── /performance     GET  (separate route, same area)
```

- **Data:** labor %, food cost %, prime cost, trends vs target.
- **UI problems:** two routes for one concept.

---

#### CASH — `/cash`  [area: cash]

```
Cash  /cash
├── New count        GET/POST /cash/new, /cash
├── Count detail     GET  /cash/:id
├── Edit             GET/POST /cash/:id/edit, /cash/:id
├── Void             POST /cash/:id/void
└── Delete           POST /cash/:id/delete
```

- **Business rules:** void is not delete — a voided count stays in the record.
- **UI problems:** flagged in an earlier pass as a "legacy page reskin" —
  still uses `.card` / `.btn-primary` primitives rather than broadsheet ones.

---

#### PAYROLL — `/payroll`  [area: payroll]

The largest owner surface, and two distinct tabs.

```
Payroll  /payroll
├── Period selector (Aug 1–14 · Jul 18–31 · … · Custom range)
├── Roster (one row per person)
│   └── Person drill-down     GET /payroll/:employeeId(\d+)
│       └── ranges: this period · last period · all time
├── View summary              GET /payroll/summary        (printable)
├── Export to Excel           GET /payroll/export
├── Support tips              GET /payroll/support-tips
├── Overtime rule             POST /payroll/overtime
├── Send the summary          POST /payroll/send          ← emails + portal
│                                                            notifications
├── Not running this period   POST /payroll/skip
└── Put it back on the list   POST /payroll/unskip

Timesheets  /payroll/timesheets              (tab strip: Today | Timesheets)
├── Period nav + custom range + status filter + Requests pill
├── Employee timesheet        GET  /payroll/timesheets/:empId
│   ├── Day grid (click any cell to edit)   POST /timeclock/:id/cell
│   │                                       POST /timeclock/day-cell
│   ├── Approve               POST /payroll/timesheets/:empId/approve
│   ├── Return                POST /payroll/timesheets/:empId/return
│   ├── Lock                  POST /payroll/timesheets/:empId/lock
│   ├── Reopen                POST /payroll/timesheets/:empId/reopen
│   ├── Transfer to payroll   POST /payroll/timesheets/:empId/transfer
│   └── Prev / next employee
└── Approve all               POST /payroll/timesheets/approve-all
```

- **Permissions:** every timesheet decision is behind `payrollArea()` **and**
  `canWrite()`. Holding the time-clock area does not grant these.
- **Business rules:**
  - Approving writes an immutable approval row with a fingerprint of the
    entries; a later approval supersedes rather than overwrites.
  - Hard blockers (open punch, already approved, locked) can never be
    overridden. Soft blockers pass with a recorded `override_reason`.
  - Approving a sheet that was already transferred sets
    `needs_recalculation`, not `ready`.
  - Editing an approved period reopens it on first edit.
  - `markSent` only records a **real** send; previews do not count.
- **Filters:** period, custom range, status (`?st=`).
- **UI problems:** the roster grid has three responsive shapes
  (`has-wk`, `has-wk.has-ot`, base) that must stay in sync with the header
  cell count — there is a test guarding exactly this. The Timesheets tab has
  its own period nav (`.tsm-per`) distinct from the portal's (`.tsx-per`).

---

#### TIME CLOCK — `/timeclock`  [area: staff]

```
Time clock  /timeclock                  (tab strip: Today | Timesheets)
├── Live panel (who is on now, on break, missing a punch)
├── Stat strip (Working · On break · Missing a punch · Needs a look)
├── Ledger (filtered by date range, employee, service, position, status)
├── Correction requests pointer → /timeclock/requests
├── Requests pill  ← always present: "View requests" (0) / "3 Requests" (n)
├── Add a punch            GET/POST /timeclock/new
├── Entry detail           GET  /timeclock/:id
│   ├── Edit punch          POST /timeclock/:id/edit
│   ├── Edit one cell       POST /timeclock/:id/cell     (409 → needs_reopen)
│   ├── Add break           POST /timeclock/:id/break
│   ├── Delete break        POST /timeclock/break/:bid/delete
│   ├── Delete entry        POST /timeclock/:id/delete
│   └── Audit history (time_events)
├── Requests               GET  /timeclock/requests
│   ├── Pending (n) | History
│   ├── Request detail: Original vs Requested + Approve / Decline
│   │                    POST /timeclock/correction/:id
│   ├── Approve all        POST /timeclock/requests/all
│   └── /timeclock/request/:id → 302 redirect into the queue
├── Reports                GET  /timeclock/reports
│   └── views: By employee | By position | By service | By day |
│              Corrections | Attendance quality
├── Export CSV             GET  /timeclock/export?kind=punches|corrections
└── Settings               GET/POST /timeclock/settings
```

- **Business rules:** four "doors" write punches — `createEntry`,
  `editEntryChecked`, `addBreak`, `startOpenBreak` — and every one validates
  overlap first. An open punch is capped at 24h for overlap purposes.
  `FROZEN_SHEET = ['approved','locked','finalized']` blocks edits.
  `decideCorrection()` is the single function both the one-at-a-time and
  the bulk decision call.
- **UI problems:** `/timeclock/requests` **must stay declared before
  `/timeclock/:id`** or Express reads "requests" as an id. The day grid is a
  bespoke CSS grid (`.tsg-*`) unlike any other table in the app.

---

#### PORTAL (manager side) — `/staff-portal`  [area: staff]

```
Portal  /staff-portal            (?tab=board)
├── Out-of-stock reports
│   ├── Resolve       POST /staff-portal/stock/:id/resolve
│   └── Reopen        POST /staff-portal/stock/:id/reopen
├── Specials composer POST /staff-portal/special
│   ├── Edit          POST /staff-portal/special/:id/edit
│   ├── 86 it         POST /staff-portal/special/:id/86
│   ├── Back on       POST /staff-portal/special/:id/back
│   └── Delete        POST /staff-portal/special/:id/delete
├── 86 an item        POST /staff-portal/special/86-item
├── Before-shift note POST /staff-portal/note
│   └── Delete        POST /staff-portal/note/:id/delete
└── Position tips     POST /staff-portal/position/:id/tips
```

---

#### TRACKERS — `/c/*`  [area: trackers]

Ten modules share one generic CRUD engine in `modules.js`
(`GET/POST /c/:slug`, `/c/:slug/:id`, `/c/:slug/:id/edit`, `/c/:slug/:id/delete`),
with bespoke routes layered on top for the richer ones.

```
Invoices  /c/invoices
├── Expanded panel        GET  /c/invoices/:id/panel      ← fragment, not a page
├── Add invoice drawer    POST /c/invoices
├── AI read               POST /c/invoices/read           ← capture overlay
├── Status change         POST /c/invoices/:id/status
├── Delete (+ purchases)  POST /c/invoices/:id/delete
└── Import product lines  GET/POST /c/invoices/:id/import
    └── Undo import       POST /c/invoices/:id/import/undo

Expenses  /c/expenses
├── AI read               POST /c/expenses/read
└── Mark reimbursed       POST /c/expenses/:id/reimburse

Vendors  /c/vendors
├── Vendor detail         GET  /c/vendors/:id
├── Edit                  GET/POST /c/vendors/:id/edit, /c/vendors/:id
├── Quick add             POST /c/vendors/quick
├── Favourite             POST /c/vendors/:id/favorite
└── Deactivate            POST /c/vendors/:id/inactive

Products  /c/products
├── Product detail        GET  /c/products/:id
├── Save                  POST /c/products/:id
├── Delete                POST /c/products/:id/delete
├── Record purchase       POST /c/products/:id/purchase
├── Delete purchase       POST /c/products/purchase/:pid/delete
├── Merge products        POST /c/products/:id/merge
└── Par levels            GET  /c/par

Documents  /c/documents
└── AI read               POST /c/documents/read

Incidents  /c/incidents
├── New                   GET/POST /c/incidents/new, /c/incidents
├── Detail                GET  /c/incidents/:id
└── Follow-up             POST /c/incidents/:id/followup

Recurring tasks  /c/recurring   (?view=calendar)
├── Mark done             POST /c/recurring/:id/done
└── Undo                  POST /c/recurring/:id/undo

Expirations  /c/expirations  ·  Equipment  /c/equipment
Contacts     /c/contacts     ·  Decisions log  /c/notes
   └── all four use the generic list / detail / edit / delete only
```

- **Business rules:** duplicate detection on invoice/expense/document upload,
  keyed on **invoice number** first (`src/dupes.js`).
- **UI problems:** the AI capture overlay (`.cap-*`, 73 CSS rules) is a
  full-screen surface unlike anything else. The expanded invoice panel is a
  fragment endpoint, so it has no standalone design.

---

#### MENU COSTING — `/menu`  [area: menu] · BETA

```
Menu costing  /menu
├── New item        GET/POST /menu/new, /menu
├── Item detail     GET  /menu/:id
├── Edit            GET/POST /menu/:id/edit, /menu/:id
├── Live costing    POST /menu/cost        ← JSON, used while editing
├── Status          POST /menu/:id/status
├── Duplicate       POST /menu/:id/duplicate
└── Delete          POST /menu/:id/delete
```

---

#### STAFF, POSITIONS, POLICY, USERS  [areas: staff / settings]

```
Staff  /employees
├── Add                POST /employees
├── Edit               GET/POST /employees/:id/edit, /employees/:id
├── Add role           POST /employees/:id/roles
├── Remove role        POST /employees/:id/roles/delete
└── Deactivate         POST /employees/:id/deactivate

Positions  /positions
├── Add                POST /positions
├── Edit               GET/POST /positions/:id/edit, /positions/:id
└── Activate/deactivate POST /positions/:id/active

Tip-out policy  /policy
├── Save (new version) POST /policy/save
└── Revert             POST /policy/revert

Users & access  /users
├── Add                POST /users
├── Edit               GET/POST /users/:id/edit, /users/:id
├── Reset password     POST /users/:id/password
├── Activate           POST /users/:id/active
└── Delete             POST /users/:id/delete
```

- **Business rules:** tip-out policy is **versioned** — `policyForShift()`
  resolves the policy in force on that shift's date, so old shifts keep the
  rates they were run under.

---

#### SETTINGS, EMAIL, NOTIFICATIONS

```
Settings  /settings          (hub — SETTINGS_GROUPS in nav.js)
├── Restaurant: Tip-out policy · Positions · Staff
├── Account: Users & access · Email
└── Staff-facing: Cash tips page

Email  /email
└── Send test        POST /email/test

Notifications  /notifications        ← no area; any signed-in account
├── Subscribe        POST /notifications/push/subscribe
├── Unsubscribe      POST /notifications/push/unsubscribe
└── Send test        POST /notifications/push/test
```

---

## 2. EMPLOYEE STAFF PORTAL

### 2.1 Shell

- `portalPage(title, body)` → `layout(..., { bare: true, staff: true })`.
- **No masthead, no sidebar, no bottom bar.**
- Every sub-page renders `portalTop(back, title)` — a back link on the left,
  the page name in the corner — plus `portalBackScript()`, which upgrades the
  back link to `history.back()` when the referrer is same-origin, and relabels
  itself "Back" when the trail differs from the static parent.
- The hub (`/portal`) is the only page **without** a crumb, because it is
  where back goes.

### 2.2 Navigation tree

```
Sign in  /tips  (PIN)  →  POST /tips/start
│
Hub  /portal
├── What's new (unseen events, CLEARS ON READ) → See all
├── Time clock            /portal/clock
│   ├── Clock in           POST /portal/clock/in
│   ├── Start break        POST /portal/clock/break/start
│   ├── End break          POST /portal/clock/break/end
│   ├── Clock out          POST /portal/clock/out
│   ├── Heartbeat          POST /portal/clock/ping
│   ├── Shift detail       GET  /portal/clock/entry/:id
│   │   └── Edit shift sheet (bottom sheet, .pes-*)
│   │       └── Send for approval   POST /portal/clock/fix
│   ├── Time history       GET  /portal/clock/history
│   └── My requests        GET  /portal/requests
├── Submit sales or tips  /portal/tips  →  the 3-step wizard at /tips
│   └── POST /tips  →  receipt at /tips?done=1
│       ├── Go to the time clock
│       └── Log another shift
├── Your hours & pay      /portal/earnings
│   ├── PAY PERIOD card (‹ › across 8 periods)   ?p=YYYY-MM-DD
│   ├── Last shift breakdown
│   ├── All-time stats
│   └── Shift detail      GET /portal/earnings/:id
├── Timesheet             /portal/timesheet        ?p=
│   ├── Period nav + actions menu (•••)
│   ├── Day rows → day detail  GET /portal/timesheet/day/:date
│   │   ├── Edit shift sheet (per shift)
│   │   └── Add a shift sheet   POST /portal/clock/add
│   └── Submit timesheet  POST /portal/timesheet/submit
├── Notifications         /portal/notifications    ← kept, grouped by day
├── Specials & 86 board   /portal/specials
├── Report out of stock   /portal/stock  → POST /portal/stock
├── Push controls         POST /portal/push/subscribe | unsubscribe | test
└── Sign out              /portal/out
```

### 2.3 Business rules that shape the portal

- **Employees never write the record.** Every change is a *request*
  (`time_corrections`), applied only on manager approval.
- A request carries `was` — the shift as it stood when asked — so history
  shows the original, not the approved value.
- `new_shift` requests have `time_entry_id = NULL` until approved.
- A signed-off period still accepts requests; they queue.
- PIN is required to send any request or submit a timesheet.
- Submission is refused if the period is still running, already submitted,
  has blocking issues, or the hours changed while the page was open
  (`seen` vs `totals.payable`).
- Hours come from **punches and shift-sheet hours** — a person whose hours
  were entered by a manager has no `time_entries` at all.

---

## 3. HIDDEN / EASILY MISSED SCREENS

These are not in any sidebar. Several are reachable only by clicking a row,
a status, a pill, or by typing the URL.

| Screen | Route | Reached by |
|---|---|---|
| Requests queue | `/timeclock/requests` | The amber pill on Today **and** Timesheets |
| Single request (legacy) | `/timeclock/request/:id` | Old notification links → redirects |
| Time entry detail | `/timeclock/:id` | Clicking a ledger row or a live-panel row |
| Time clock reports | `/timeclock/reports` | A button in the Today toolbar only |
| Time clock settings | `/timeclock/settings` | A button in the Today toolbar only |
| Payroll person drill-down | `/payroll/:employeeId` | Clicking a roster row |
| Payroll summary | `/payroll/summary` | "View summary" button |
| Support tips | `/payroll/support-tips` | Link from payroll only |
| Employee timesheet | `/payroll/timesheets/:empId` | Clicking a row in the Timesheets tab |
| Shift results / send | `/shifts/:id/results` | A button on the shift detail |
| One person's email preview | `/shifts/:id/email/:employeeId` | Link on the results page |
| Invoice expanded panel | `/c/invoices/:id/panel` | **Fragment** — no standalone page |
| Product line import | `/c/invoices/:id/import` | Button on an invoice |
| Vendor detail / edit | `/c/vendors/:id`, `/edit` | Row click |
| Product detail | `/c/products/:id` | Row click |
| Par levels | `/c/par` | Link from Products |
| Incident detail | `/c/incidents/:id` | Row click |
| Recurring calendar view | `/c/recurring?view=calendar` | Toggle |
| Generic module detail | `/c/:slug/:id`, `/c/:slug/:id/edit` | Row click, all 10 modules |
| Settings hub | `/settings` | Account menu |
| Users & access | `/users` | Account menu / Settings |
| Email settings | `/email` | Account menu / Settings |
| Notifications feed | `/notifications` | The bell |
| Cash tips PIN page | `/tips` | Settings → Staff-facing |
| Portal shift detail | `/portal/clock/entry/:id` | Tapping a shift in history or a day |
| Portal day detail | `/portal/timesheet/day/:date` | Tapping a day row (worked days only since Phase 2C) |
| Portal earnings detail | `/portal/earnings/:id` | Tapping a past shift |
| Portal notifications | `/portal/notifications` | "See all", or the hub line when nothing is new |
| Portal requests | `/portal/requests` | Clock shortcut row, More menu, timesheet footer link |
| ~~Portal time history~~ | `/portal/clock/history` | **Retired in Phase 2C** — 301s to `/portal/timesheet`. No nav entry anywhere |
| Tips receipt | `/tips?done=1&…` | Only after submitting |
| CSV / Excel exports | `/timeclock/export`, `/payroll/export` | Buttons |
| CSRF token | `/csrf` | Service worker / fetch wrapper |
| Version | `/version` | Build poller |
| POS webhook | `POST /webhook/benugin` | External |
| Uploads | `/uploads/*` | Static — **no area gate** |

### Overlays with no URL at all

These have no route and are invisible to a route-based audit:

| Overlay | CSS prefix | Where |
|---|---|---|
| AI capture overlay | `.cap-*` (73 rules) | Invoices, Expenses, Documents |
| Timesheet bottom sheet | `.tso-*` | Owner timesheet grid |
| Portal edit-shift sheet | `.pes-*` (22 rules) | Portal shift detail + day |
| Portal add-shift sheet | `.pes-*` | Portal day screen |
| Submit-timesheet sheet | `.pes[data-pes="submit"]` | Portal timesheet — was `#ts-sheet` until Phase 2B |
| Account menu | `.bs-acct` / `.bs-pop` | Masthead |
| Index overflow menu | `.bs-bottom` `<details>` | Mobile bottom bar |
| Band group panel | `.bs-band-x` | Mid-width nav |
| Search results popover | `.tsearch-pop` | Masthead |
| Year/period popover | `.bs-yr-pop` | Date pickers |
| **37 `<details>` elements** | — | Used throughout as ad-hoc disclosure |

---

## 4. CURRENT UI PROBLEMS (facts, not opinions)

1. **Three ledger grid conventions** — `.bs-lhead/.bs-rhead` (payroll),
   `.bs-shead/.bs-dayhead` (sales), `.bs-payhead` (drill-down). Plus the
   bespoke `.tsg-*` timesheet grid and `.tsd-*` portal day rows.
2. **14 distinct breakpoints** across the stylesheets: 359, 360, 380, 560,
   620, 640, 700, 760, 820, 860, 900, 1000, 1100, 1180px. No scale.
3. **Two nav systems for one product** — sidebar (`sideNav`) and band
   (`bs-band`), each with its own group rendering, plus `subNav` and
   `bottomBar`. Four navigation components.
4. **Colour tokens are warm/paper-themed** (`--paper: #f7eee0`,
   `--surface: #fffdf8`) — the approved direction is off-white + white +
   navy-charcoal, so the token *values* change but the token *names* can
   largely stay.
5. **Legacy primitives survive** — `.card`, `.btn-primary`, `.page-head` are
   reskinned rather than replaced; Cash is the most visible offender.
6. **Emoji icons** still exist in `modules.js` module definitions
   (`icon: '🧾'`) while the sidebar uses SVG line icons.
7. **The portal loads three stylesheets** (`styles.css`, `broadsheet.css`,
   `staff.css`) and uses almost none of the first two.
8. **`flash()` is the only feedback mechanism** — every POST redirects with
   `?msg=`. There is no toast, no inline success state.
9. **No loading states anywhere.** Every page is a full server render.
10. **Night theme is partial** — 12 blocks in `broadsheet.css`, nothing in
    `staff.css`. The portal has no dark mode.

---

## 5. DEPENDENCY MAP

```
policy (versioned)  ──→  shifts  ──→  engine (tip-out)  ──→  emails
                              │
time clock ──→ work.hours ────┤       work.hours is BOTH the payroll basis
                              │       AND the tip-split weight
                              ↓
                          payroll  ──→  timesheets ──→ approvals ──→ transfer
                              │
                              ↓
                    portal earnings + pay period
```

- **`work.hours` is the single most load-bearing value in the product.**
  The clock writes it (`syncShiftHours`), the tip engine weights by it, and
  payroll pays on it.
- **Periods** (`src/periods.js`) drive payroll, timesheets, the portal pay
  card, the reminder sweep and the send record.
- **`time_corrections`** is shared by the portal (files them), the requests
  queue (decides them) and the audit trail.
- **`portal_events`** backs the hub feed, `/portal/notifications` and push.
- **`aggregatePayroll`** is called by: the payroll roster, the drill-down,
  the Excel export, the emails, and now the portal pay card. One function,
  five surfaces — this is why they cannot disagree.


---

## 6. PHASE 2A AUDIT — Employee Portal Time Clock

Added 2026-08-05. Read-only audit of everything reachable from `/portal/clock`.
No code, CSS or schema changed.

### 6.1 Screens and their states

| # | Screen | Route | Reached by |
|---|---|---|---|
| 1 | Time clock home | `/portal/clock` | Hub row · bottom-nav tab · after every punch |
| 2 | Clock-out receipt | `/portal/clock?done=:id` | Redirect after clock-out only |
| 3 | Shift detail | `/portal/clock/entry/:id` | "Earlier today" row · history row · day card · issue link · notification |
| 4 | Edit-shift sheet | *(no route)* | "Edit shift" on #3 or #7 |
| 5 | Add-shift sheet | *(no route)* | "Add a shift" on #7 |
| 6 | Timesheet | `/portal/timesheet?p=` | Clock shortcut · bottom-nav tab |
| 7 | Day detail | `/portal/timesheet/day/:date` | Tapping any day row on #6 |
| 8 | Submit sheet | *(no route)* | ••• menu → Submit timesheet |
| 9 | My requests | `/portal/requests` | Clock shortcut · ••• menu · More |
| 10 | Time history | `/portal/clock/history` | "Your time history ›" · ••• menu · More |
| 11 | Clock-out PIN sheet | *(no route)* | Clock out, when `pinAtOut` is on |

**Time clock home — six card states**, all from `clockStatus(emp)`:

| State | Condition | Shows | Actions |
|---|---|---|---|
| Clocked out | no active entry, ≥1 position | date, "You are clocked out", position + service pickers | Clock in |
| Working | active, `status != on_break` | live counter (server-anchored), in-time, position · service, unpaid break so far | Start break · Clock out |
| Still clocked in | active and over `tc_long_shift` | as above + `.tc-stale` warning | as above |
| On break | `status = on_break` | live break counter, break start + paid/unpaid, secondary on-the-clock counter | End break |
| No position | `clockPositionsFor(emp)` empty | "No position is assigned to you" | none — blocked |
| Receipt | `?done=:id` | payable, in/out/break/position/service | "Something's wrong" · "Done" |

One position → hidden input + a read-only `.tc-fixed` row. Two or more → a
`<select>`. Service is always a `<select>`, defaulted by `suggestDaypart()`.

**Always below the card:** Worked today (live, minute-resolution) · Timesheet
shortcut with a badge (`Sent back` / `Submit again` / `Needs a fix` /
`Ready to submit`) · My requests shortcut with a count · Earlier today rows ·
Your time history link.

### 6.2 What each flow requires

| Flow | PIN | Note | Confirm | Result |
|---|---|---|---|---|
| Clock in | no | — | — | writes immediately |
| Start / end break | no | — | — | writes immediately |
| Clock out | **only if `pinAtOut`** | — | — | writes, then receipt |
| Edit shift | **yes** | optional | — | `shift_times` request, queued |
| Add shift | **yes** | optional | — | `new_shift` request, queued |
| Submit timesheet | **route demands it, sheet does not collect it** | optional | required checkbox | **fails — see 6.4** |

### 6.3 Validation already enforced

- Clock in: position must be theirs (`clockPositionsFor`), service must be in
  `DAYPARTS`, refused if already active, overlap-checked via `TC.createEntry`.
- Edit: inverted times refused at the route *and* blocked client-side
  ("check the times"); overlap refused on approval; frozen period queues.
- Add: both times required, end after start, own position only, service valid,
  overlap refused at filing *and* again on approval.
- Submit: refused while the period is still running, if already submitted, if
  any blocking issue exists, or if the hours changed while the page was open
  (`seen` vs `totals.payable`).

### 6.4 BLOCKING DEFECT — timesheet submission cannot succeed

`POST /portal/timesheet/submit` calls `pinCheck(req, emp, req.body.pin)`.
The submit sheet (`#ts-sheet`) posts only `period`, `seen`, `confirm`, `note`
— **there is no PIN input in it.** `pinMatches(emp, undefined)` is false, so
every submission is rejected with *"That PIN did not match."* and no
`timesheets` row is written.

Reproduced against a genuinely submittable period: the sheet renders, the POST
redirects to `?err=That PIN did not match.`, and no row lands.

Second-order harm: `pinCheck` calls `GUARD.failed()` on mismatch, so each
attempt counts against that employee's PIN rate-limit bucket. Somebody trying
a few times can lock themselves out of the portal.

Origin: the PIN check arrived with the "Staff PINs stop being guessable"
hardening; the sheet never had the field. Pre-existing, not introduced by the
redesign.

**Consequence:** no employee has ever been able to sign a timesheet from the
portal, and the end-of-period reminders ask them to do something impossible.

### 6.5 Other findings

1. **Two ways to reach the same shift, styled differently** — `.tc-row`
   (clock home, history) and `.tsx-daycard` (day detail) show the same entry.
2. **Shift detail lists raw request kinds** — `c.kind.replace(/_/g,' ')` prints
   "shift times", not "Changed shift times". The manager's queue has a proper
   label map (`REQ_KIND`); the employee's screen does not.
3. **No audit history for the employee.** `Edited: yes — see the history with
   your manager` is a dead end: `time_events` exists for the entry but is never
   shown to them.
4. **Break editing is unreachable from the portal.** `break` and
   `missing_break` correction kinds exist and `applyCorrection` handles them,
   but no portal screen files one — the edit sheet only carries the two times.
5. **Position and service cannot be corrected from the portal.**
   `wrong_position` / `wrong_service` kinds exist server-side with no UI.
6. **The timesheet has its own header** (`.tsx-top` + `•••`) while every other
   portal screen uses `portalTop`.
7. **Actions are buried in a `•••` menu** — Submit, Review issues, View
   submission, Time history, My requests all live behind it.
8. **Two period selectors in one product** — `.tsx-per` (timesheet) and
   `.pp-nav` (pay card) do the same job differently.
9. **No loading state anywhere.** Every action is a full form POST + redirect.
10. **Success is a querystring banner** (`?ok=`), which survives a refresh and
    can be shared or re-triggered.
11. **The clock-out PIN sheet is a plain `hidden` div**, not the `.pes` bottom
    sheet the edit/add flows use — two sheet idioms in one screen.
12. **Receipt hides the card.** After clocking out the whole clock state is
    replaced; "Done" is a link back to the same URL without the query.

---

## 7. PHASE 2B — Employee Portal Time Clock, redesigned

Shipped. Seven screens and overlays; the rest of the portal is untouched.

### 7.1 What changed on each screen

| # | Screen | Was | Is |
|---|--------|-----|-----|
| 1 | `/portal/clock` | Four states, four different layouts | One `.tcc` card, four tones. Status word → live figure → facts → actions, always in that order |
| 2 | Clock-out receipt | Its own layout, replacing the page | The same card, tinted green, laid over the page it belongs to. Rows and shortcuts stay |
| 3 | `/portal/clock/entry/:id` | Payable buried in a fact grid; `edited: yes — see the history with your manager` | Payable first; real audit history in plain English; request state as a word |
| 4 | Edit-shift sheet | Two times only | Two times + `More changes` (position, service, breaks), all in ONE request |
| 5 | Add-shift sheet | No break | Optional break, folded away; validated at the door |
| 6 | Submit-timesheet sheet | Bespoke overlay, inline `onclick`, float `seen` | Shared `.pes` bottom sheet; `seen` is a 16-hex digest |
| 7 | Clock-out confirmation | A PIN prompt, behind a setting | Figures + Cancel/Confirm. No PIN, and no setting that can bring one back |

### 7.2 Routes: no additions, no removals, no renames

Every route in §2 is unchanged. `/portal/clock/fix` accepts more fields on the
`shift_times` kind; `/portal/clock/add` accepts an optional break. Both are
additive — an older payload still posts and still works.

### 7.3 Retired

- **`tc_pin_out`** — the setting, its checkbox on `/timeclock/settings`, its
  branch in `/portal/clock/out`, and the `#tc-outsheet` PIN sheet. Posting
  `pin_out=1` now does nothing. `TC.settings().pinAtOut` is `undefined`.
- **`.pt.has-tabs > :last-child`** — the tab-bar reservation hung off whichever
  element happened to be last, so any page that appended a sheet, a toast or a
  `<script>` after its body lost its bottom spacing. Now on `.pt.has-tabs`.

### 7.4 Still Phase 2C

Timesheet (`/portal/timesheet`), Day detail (`/portal/timesheet/day/:date`),
Requests (`/portal/requests`), Time history (`/portal/clock/history`). The edit
and add sheets already appear on the day-detail page and were upgraded there
too — the sheets are Phase 2B, the pages around them are not.

---

## 8. PHASE 2C — Timesheet, Day detail, Requests

Shipped. Time history is retired.

### 8.1 What changed

| Page | Was | Is |
|---|---|---|
| Timesheet | 14 day rows × 5 numeric columns, ••• menu, bespoke period nav | Worked days only as shift rows; `.tcc` status card; one period selector reaching a year back; every action visible |
| Day detail | Cards, no total, explainer repeated per card | Day total first, one explainer under all shift-sheet cards |
| Requests | Own label map missing the two kinds the portal files; no original; empty quotes | Shared label map, Was/Asked-for via `reqDiff`, filter chips with counts |
| Time history | A second, punch-only answer to "what have I worked" | **Gone.** `301 → /portal/timesheet` |

### 8.2 Four correctness fixes

1. **History vs Timesheet disagreed.** History read `time_entries` alone, so a
   person whose hours arrive on shift sheets saw 8 minutes beside a timesheet
   reporting 101 hours. Retiring the page removes the second answer.
2. **Per-day overtime was fake.** The OT cell was hardcoded `--` and Regular
   equalled Total, under a header claiming 21:09 of OT. Overtime is a weekly
   threshold, so it now appears on the week (from `splitWeeks`) and on the
   period, and nowhere else.
3. **Raw kinds reached employees.** `shift_times` and `new_shift` — the only two
   the portal can file — were missing from the page's private label map.
4. **A request with no note rendered `“”`.**

Also: duplicate `id="ts-issues"`, and a dead `applied_at ? 'approved' : 'approved'` ternary.

### 8.3 Two period lists, deliberately

`tsPeriodsFor()` (8) governs **submission** and the ready-to-sign badge —
unchanged, because widening what may be signed is a business-rule change.
`tsViewPeriods()` (26) governs **viewing** and the selector, because Timesheet
is now the only history there is. `canSubmit` requires membership of the short
list, so the screen never offers a button the route would refuse.

### 8.4 Retired markup

`.tsx-menu` and its panel, the three in-page anchors, the `.tsd` day grid, the
bespoke `.tsx-per` nav, `.tsx-sum*`, `.tsx-status`, `.tsx-week`, `.tsx-wtot`,
`.tsx-body`, `.tsx-top/title`, plus twelve `.ts-*` blocks already dead before
this phase — **68 CSS rules**, each verified unreferenced across `src/` first.
`.tsx-arrow` / `.tsx-today` stay: the owner payroll timesheet still uses them.

---

## 9. PHASE 2D AUDIT — the rest of the Employee Portal (read-only)

Audited 2026-08-05 against `158310e`. No code, CSS, routes, schema or behaviour
changed. Covers everything Phases 2B/2C did not.

### 9.1 Screens

| Screen | Route | Reached by | Gate |
|---|---|---|---|
| Home / hub | `GET /portal` | Tab 1, every "Home" crumb | any employee |
| Sign-in | `GET /tips`, `POST /tips/start` | cold open, sign-out, session timeout | public |
| Tips receipt | `GET /tips?done=1&…` | only after `POST /tips` | querystring only |
| Submit sales or tips | `GET|POST /portal/tips` → `tipsFormPage` | Home row, More menu | `shape.tips` |
| Submit (write) | `POST /tips` | the form's own action | **token or PIN — no shape check** |
| Earnings | `GET /portal/earnings` | Tab 4 "Pay", Home row, hub last-shift card | any |
| Shift pay detail | `GET /portal/earnings/:id` | tapping a past shift | any (own shifts only) |
| Specials & 86 | `GET /portal/specials` | Home row, More menu | any |
| Report out of stock | `GET|POST /portal/stock` | Home row, More menu | any |
| Notifications | `GET /portal/notifications` | "See all", hub line, More menu | any |
| Sign out | `GET /portal/out` | Home foot, More menu | any |
| Push subscribe/unsub/test | `POST /portal/push/*` | the hub's own control | any (JSON) |

### 9.2 Does not exist in the portal

**Documents, Account/profile, Policies, Help, PIN change.** No routes, no pages,
no menu entries. Documents exist owner-side only (`/c/documents`). An employee
cannot see their own position, wage, PIN or contact details anywhere.

### 9.3 Shape gates

`shapeFor(position)` returns exactly four flags: `tips` (= `position.takes_tips
!== 0`), and `earnings` / `specials` / `stock`, all hard-coded `true`. So there
is **one** real gate in the whole portal, and it controls one row plus the
form-opening routes. `portalShape` is a module-level variable set by
`requirePortal` so `portalPage()` can filter the More menu.

### 9.4 Overlays with no route

`.tp` three-step wizard (`data-when="1|2|3"`), the stock composer (client-side
list, posts as JSON in one field), the push control, the More `<details>`.

### 9.5 Findings

1. **`POST /tips` has no shape gate.** `openTips` redirects a non-tipped
   position away from the form, and a comment there states "hiding the row is
   not a permission, the route saying no is" — but the route that *writes* is
   `POST /tips`, and it checks only the token/PIN. Self-only and fully audited,
   so this is data hygiene rather than privilege escalation.
2. **Two period selectors.** Earnings uses `.pp-nav` / `payPeriodsFor()` (8);
   Timesheet uses `.tsp` / `tsViewPeriods()` (26). Different markup, different
   depth, same concept.
3. **Home duplicates the tab bar.** Time clock, Pay and Submit are rows on the
   hub *and* tabs at the foot; Specials and Stock are rows *and* More entries.
4. **`/portal/earnings` runs `aggregatePayroll` for the whole roster** and then
   filters to one person (`periodPayFor`). Correct, and the reason the figure
   can never disagree with payroll — but it is the roster's work for one row.
5. **Legacy `.pt-*` styling throughout.** Home, Earnings, Specials, Stock,
   Notifications and the tips wizard predate the Phase 2B/2C components and use
   `.pt-row`, `.pt-line`, `.pt-stat`, `.pt-kick`, `.tp-*` instead of `.tcc`,
   `.tc-row`, `.pes`, `.tc-chip`.
6. **Three "what happened" surfaces**: hub "What's new" (clears on read),
   `/portal/notifications` (kept), and `/portal/requests` (decisions). A
   timesheet decision appears in two of them.
7. **The tips receipt is querystring-driven** (`/tips?done=1&name=…&cash=…`),
   so its figures are re-displayable and editable from the URL. Display only —
   nothing is read back from it — but it is the one portal screen whose numbers
   do not come from the database.
8. `legacyAuth` **is** throttled through `pinCheck`, same as every other PIN
   door. Not a finding; recorded because it looks like one.

---

## 10. Recommended future setting — Staff Portal → Sales & tips

**Not implemented.** Recorded so the shape of `tipsEligibility()` is understood
as deliberate rather than accidental.

Phase 2D-0 put one function between every route in the tips workflow and the
decision to accept a submission:

```js
tipsEligibility(emp) → { ok, msg, shape, position }
```

Today it asks `shapeFor(position).tips` and nothing else. Everything below
belongs **inside that function**, so adding it later touches one place instead
of the three routes that call it. Nothing about the routes hard-codes the
current rule.

Proposed home: **Owner workspace → Settings → Staff Portal → Sales & tips**.

| Control | Shape of the answer | Notes |
|---|---|---|
| Enable employee sales/tip submission | one flag | off ⇒ `tipsEligibility` refuses everyone; the hub row and More entry disappear with it, because both already read the same function |
| Eligible positions | a set of position slugs | would replace `takes_tips` as the source for *this* question. `takes_tips` also drives pooling, so the two must not be silently merged |
| Sales entry required | flag, per position | validated in the route, not the browser — today "servers report sales" is inferred from the filing role |
| Cash tips allowed / Card tips allowed | two flags | the route already treats a blank card figure as "not stated" rather than zero; a disallowed field must be refused, not ignored |
| Corrections allowed | flag | today resubmission always corrects in place. Turning this off needs a rule for what happens to the second submission, which `tip_submissions` already records append-only |
| Manager approval required | flag | the largest of these. It needs a pending state, a queue, and a decision path — the correction-request machinery in `time_corrections` is the closest existing model |

**One caution for whoever builds it.** `takes_tips` currently answers two
different questions — who hands tips in, and who receives from the pool. A
busser is `takes_tips = 0` and still takes a share every service. Splitting the
first into a portal setting must not disturb the second. The two are already
named apart in code: `canSubmitSalesTips()` in `server.js` decides submission,
and `TIPOUT_ROLES` / `poolShareMap` in `engine.js` decide allocation. Nothing
imports across that line, and a test asserts it stays that way.

**Eligibility is per filing position** (Phase 2D-1), not per employee. A
kitchen-primary who also works server shifts may file the server ones and not
the kitchen ones. `tipsEligibility(emp, requestedPosition)` resolves the slug
against what the person actually holds, then asks `canSubmitSalesTips` of the
resolved row. The form offers only eligible held positions; one is chosen
automatically, several must be picked, none closes the door.

---

## 11. PHASE 2D-1 — navigation, and the Schedule placeholder

### 11.1 Bottom tabs

`Home · Time clock · Schedule · Pay · More`. Timesheet gave up its tab; it is a
visible action row on `/portal/clock` and every timesheet route still lights the
**Time clock** tab, so nothing is orphaned.

Defined once, in `PORTAL_NAV`. An item carries `key, label, icon, href,
availability, lockedTitle, lockedMessage, accessibilityLabel, badge`.
`availability` is `available | locked | hidden`.

Route→tab lives in `PORTAL_AREA` + `portalTabForRoute(pathname)`, longest prefix
wins:

| Route | Tab |
|---|---|
| `/portal` | Home |
| `/portal/clock*`, `/portal/timesheet*`, `/portal/requests*` | Time clock |
| `/portal/earnings*` | Pay |
| anything else under `/portal` | More (no `aria-current` — More is a button) |

### 11.2 Layer scale

Declared on `.pt` and read by every fixed surface:

```
--pt-z-tabs: 60   the bottom bar
--pt-z-nav: 70    More, and locked-destination sheets
--pt-z-sheet: 90  .pes form sheets
--pt-z-toast: 120 feedback
```

**The tab bar renders inside `.pt`.** It used to be a sibling, which meant it
inherited none of the portal custom properties: `background: var(--pt-field)`
resolved to nothing and painted transparent, and `z-index: var(--pt-z-tabs)`
came out `auto`. That was the "too transparent, moves strangely while
scrolling" bar.

### 11.3 Schedule — locked, and deliberately empty

No route, no table, no API, no data. The tab is a `<button>` (never `disabled`,
so it can open the sheet that explains itself), labelled `Schedule, coming
soon`, and never takes `aria-current`. Tapping it opens a shared dialog and
changes nothing else — no navigation, no history entry, no write.

**Turning it on later:** set `availability: 'available'`, give it an `href`, and
add its routes to `PORTAL_AREA`. No page changes.

**Future home: Owner workspace → Scheduling.** Scope recorded, not built:
weekly builder · publish/unpublish · employee shift view · availability ·
time-off requests · open shifts · shift offers · swap and cover · position and
location eligibility · schedule notifications · publish acknowledgements ·
manager change audit · conflict detection · labour and overtime warnings.

**Future settings: Owner workspace → Settings → Scheduling.** Also not built:
scheduling enabled · week start · availability enabled · time-off enabled ·
swaps enabled · open-shift claiming · approval rules · publish notifications ·
minimum-rest warnings · overtime warnings · how far ahead staff can see ·
whether unpublished shifts are hidden · change-cutoff rules.

### 11.4 Home deduplication

An attention item may carry `dedup`, a domain key. A notification's key is
parsed from its **href** — `timesheet:<period>`, `entry:<id>`, `shift:<id>` —
never from its title. A notification whose key matches a rendered attention item
is hidden **on Home only**: it stays stored, stays unread, and stays on
`/portal/notifications`. No key means never suppressed, which is the right
answer for a notification that merely mentions a module.

---

## 12. PHASE 2E — Pay, in three views

| View | Route | Notes |
|---|---|---|
| Pay period | `GET /portal/earnings` | One period. `.tsp` selector, `?p=<start>` survives refresh |
| Shift archive | `GET /portal/earnings/shifts` | Paginated, 20/page, `?page=N` |
| Shift receipt | `GET /portal/earnings/:id` | Registered **last** — otherwise `shifts` is read as an id |

All three activate the **Pay** tab via `portalTabForRoute()`.

### 12.1 What the money means

**`Gross pay` = wages + overtime premium + tips delivered through payroll**
(`aggregatePayroll`'s `takeHome`). Supporting line: *"Before tax and deductions.
What reaches your bank will be less."*

This app models **no** taxes, deductions, benefits, withholding, net pay or bank
deposits. Forbidden until data proves them: *Take-home*, *Net pay*, *On this
check*, *Paid*, *Deposited*.

**`Already received`** — cash tips and any other separately delivered money.
Shown apart, never added to gross pay, never described as a deduction.

### 12.2 Period status

| Status | Proven by |
|---|---|
| `Sent to payroll` | a `sendRecord` for the period start — the owner sent it. **Not proof of payment** |
| `Still running` | today is on or before `period.end` |
| `Not sent yet` | the period has ended and no send record exists |

There is no `Paid`. Every unsettled state says the totals may still change.

### 12.3 Pagination

20 rows. One bounded row query (`LIMIT ? OFFSET ?`) and one `COUNT(*)`; the tip
engine runs once per returned row. Ordering `date DESC, id DESC` — the id is the
tie-break, so a row cannot swap pages. Page normalisation: missing/zero/negative/
non-numeric/repeated → 1; decimals floor; **beyond the end clamps to the last
page**, served at the URL asked for with no redirect.

### 12.4 When a shift will not cost

`runShift` can throw. It used to `continue`, which deleted the row from the list
while the `COUNT` still counted it — the totals stopped matching and every later
row slid onto the wrong page.

Now the row survives as `Earnings unavailable`: date, position, service, and
hours from the **work row** (manager-authoritative, independent of the engine).
No `$0.00`, no invented figures, no exception text. The detail page shows the
same state rather than a not-found. Diagnostics go to the server log with the
shift and employee id; none of it reaches the page.

A shift that does not exist and one belonging to somebody else behave
**identically** — both redirect to `/portal/earnings`, so neither confirms the
other's existence.

### 12.5 Return destination

`?from=shifts[&page=N]` selects one of two known destinations **by name**. `page`
is parsed as an integer and re-rendered. Nothing from the query string is ever
used as a URL, so absolute, protocol-relative, `javascript:`, encoded-external
and unrelated-portal values all fall through to `/portal/earnings`.

### 12.6 One rate per shift — a limitation, not a feature

`earningsFor` resolves **one** wage rate per shift through `WAGE_RATE_SQL`
(per-shift override → role wage → default). When one authoritative rate exists it
is shown; salaried or no meaningful rate uses the non-hourly label. **`Rate
varies` is never shown, because the data cannot prove it.**

> The current earnings model resolves one wage rate per shift. True multi-rate
> shifts require a future allocation model that records time or earnings by rate
> segment.

Future requirements, for the Payroll/time model and **not** display logic:
effective-dated wage assignments · position-specific rates · intra-shift position
changes · rate segments with start/end boundaries · overtime allocation across
rates · manager override history · payroll export reconciliation · immutable
historical rate snapshots.

### 12.7 Index review — no schema change made

Query plan for the archive row query:

```
SEARCH sh USING INDEX sqlite_autoindex_shifts_1 (date>?)
SEARCH w  USING COVERING INDEX sqlite_autoindex_work_1 (shift_id=? AND employee_id=?)
USE TEMP B-TREE FOR LAST TERM OF ORDER BY
```

Employee filtering and the join are covered by `work`'s primary key; date
ordering is covered by `shifts`' unique `(date, daypart)`. The temp B-tree sorts
only the `id DESC` tie-break **within equal dates** — at most a couple of rows.

**Reported, not acted on:** the plan drives from `shifts` by date and probes
`work`, so an employee with few shifts in a long company history scans more
shift rows than they own. An index on `work(employee_id, shift_id)` would let it
drive from the employee. That is a schema change and belongs to a migration
decision, not to this phase.

### 12.8 Future — Owner workspace → Settings → Staff Portal → Pay visibility

Not implemented: show finalized pay only · show preliminary earnings · show
employee wage rates · historical pay-period visibility · historical shift
visibility · tip-source detail visibility · cash-versus-payroll delivery
visibility · pay-statement availability · pay-finalized notifications.

**No visibility setting may ever substitute for server-side employee isolation.**

Taxes, deductions, benefits, downloadable pay statements and net pay require a
future Payroll/pay-statement model. They are not display rows to be handcrafted.

---

## §13 — Phase 2F: Employee Sales & Tips submission

### Routes

| Route | What it is |
|---|---|
| `GET /portal/tips` | The submission workspace. One page. `?shift=<id>` selects a shift, `?position=<slug>` a filing job, `?manual=1` the manual path. |
| `POST /portal/tips` | Same handler — an old page in somebody's pocket lands somewhere sensible. |
| `POST /portal/tips/submit` | The write, session-authenticated. Requires a confirmation to overwrite. |
| `GET /portal/tips/receipt/:id` | The durable receipt. `:id` is a `tip_submissions.id`. Registered before any generic parameter route. |
| `POST /tips` | The legacy PIN door. Same write core, no confirmation (it has no correction UI to confirm with). |
| `GET /tips?done=1` | Compatibility only. Shows **no amounts**. Redirects a signed-in employee to their real receipt. |

### The rule that shapes everything

`server_sales.cash_tips_cents` means **two opposite things** depending on the
job on the `work` row, and `engine.js` is where that is decided:

- `role === 'server'` → `servers[]`, and `cashTips` is **subtracted** from what
  reaches the paycheck. Money already in their pocket.
- anything else → `support[]`, and `cashTips` is **summed into `staffCash`**,
  lands in the shared cash jar and is split by hours. *"nobody keeps their own."*

So the workspace asks two different questions and stores the answer in the one
column the engine already reads. **No new field was added** — a nicer label is
not a reason to add a column the engine would then have to learn.

### Filing-position capability matrix

Derived from the single discriminator the engine itself uses (`shiftInputs`
branches on `role === 'server'`), not from a second list that could drift.

| Capability | server | any other eligible position |
|---|---|---|
| `reports_food_sales` | yes | **no** — support sales columns are never read by any calculation |
| `reports_coffee_sales` | yes | no |
| `reports_alcohol_sales` | yes (optional) | no |
| `reports_card_tips` | yes | yes |
| `reports_server_cash_kept` | yes | no |
| `reports_pooled_cash` | no | yes |
| `requires_sales` | no — a blank form never wipes a stored figure | no |
| `can_correct_submission` | yes | yes |

### Sales categories

`food` → *Kitchen / food sales*, `coffee` → *Coffee & beverage sales*,
`alcohol` → *Alcohol sales* (optional). These are **tip-allocation categories,
not payment methods** — alcohol drives the bar pot, coffee the barista pot.
They are never renamed to cash/card sales and never combined.

### Card-tip tri-state

| Posted | Meaning | Stored |
|---|---|---|
| absent | not stated | `server_sales` untouched; audit row records `NULL` |
| blank | not stated | as above |
| `0` | the employee states there were none | `0` written; audit row `0` |
| positive | a stated amount | written; audit row carries it |

The tri-state survives **only in `tip_submissions`** — `server_sales.card_tips_cents`
is `NOT NULL DEFAULT 0`, so once a row exists a stored `0` cannot be told apart
from "never said". The workspace, review and receipt all read the state from the
latest audit row and print **"Not entered"** rather than `$0.00`.

### Shift-reporting modes

1. **Current active shift** — an open punch. Shown first, labelled `Current shift · …`.
   Submitting does **not** clock anybody out, modify the punch, guess an end
   time, finalise hours, calculate wages, or complete a Timesheet.
2. **Recorded past shift** — an employee-owned punch or work row. Date and
   daypart come from the **row**, never from the body.
3. **Manual** — *"Report a shift not listed"*. Validated date + established
   daypart + held-and-eligible position. Resolves or creates the shared shift
   via `getOrIgnore()`. **Creates no punch, no hours, no wage, no overtime and
   no Timesheet completion** — proven by test, which asserts
   `punches = 0`, `hours = 0`, `hours_source = NULL`, `hourly_rate_cents = 0`.
4. **Correction** — see below.

Priority order: current → recorded and unreported → manual → already submitted.
Preselected only when there is exactly one obvious answer.

### Strict money grammar

One parser, `parseMoney()`, replacing `parseFloat` for this workflow. Four
outcomes: `absent`, `blank`, `ok` (exact integer cents, 0 included), `invalid`.

Accepted: `0`, `0.00`, `12`, `12.5`, `12.50`, surrounding whitespace.
Rejected: negatives, `12.999`, `12abc`, `1e3`, `$20`, `1,200`, `12.5.5`, `.5`,
`12.`, `NaN`, `Infinity`, anything over $1,000,000.

A rejected figure is **refused, never rounded, truncated or turned into zero**,
and refusal happens *before* the shift is resolved — so a typo leaves no shift
row behind as evidence it was attempted.

Cents are computed as `whole * 100 + frac` on the two string halves, so no
binary floating-point value ever touches stored money.

### Correction and audit

Existing behaviour preserved exactly: the current `server_sales`/`work` values
are updated and a **new `tip_submissions` row is appended**; earlier rows are
never deleted or mutated. The workspace makes it explicit — `Previously
submitted`, the values on file, an `Update report` button, and a required
confirmation reading *"This replaces the current values. Your earlier
submission stays in the audit history."*

The server decides new-vs-correction by re-reading the database. A posted
`isCorrection` flag is never trusted.

**Stale-edit limitation, documented not fixed:** the schema carries no version
or updated-at on `server_sales`, so two people editing the same row cannot be
told apart and last-write wins. No optimistic-locking column was added. The
audit history means nothing is lost, only that the *current* value is the last
one written.

### Concurrency and idempotency

- `UNIQUE(date, daypart)` plus `getOrIgnore()` remain the idempotency boundary;
  two people reporting the same service concurrently resolve to one shift
  (proven by test).
- An **identical** repeat within 60 seconds returns the existing receipt rather
  than appending a second audit row. Genuine corrections differ in at least one
  figure and are never swallowed.
- The write runs in one `db.transaction`.
- Authorization failure and validation failure both write nothing at all.

### Receipt authority

Every figure on `/portal/tips/receipt/:id` is read back out of the stored row.
Changing any query parameter changes nothing (proven by test). A receipt
belongs to one employee; a foreign id and a missing id return the **same** 404,
so "not yours" and "not there" cannot be told apart from outside.

### Reporting window

**There is no write-time cutoff, and this phase deliberately keeps it that way.**
Two separate things, not to be conflated:

- Home reminder window: **7 days**
- Write eligibility: **unlimited**

### Future settings — Owner workspace → Settings → Staff Portal → Sales & tips

Not implemented. Everything below belongs inside `tipsEligibility()` /
`filingCapabilities()` so adding it touches one place rather than every route:
submission enabled; eligible filing positions; reporting window; required
categories by position; card-tip reporting; server cash reporting; pooled cash
reporting; correction availability; all-zero report policy; late-report
behaviour; high-value warnings; receipt visibility; manager approval if ever added.

### Deviation from the brief

The legacy PIN form (`tipsFormPage`, the old three-step wizard) and its `.tp-*`
CSS are **still present**, because `GET /tips` is still the PIN door — an
authentication surface the brief requires preserving. The wizard is gone from
the portal workflow; removing the markup entirely would retire the PIN door
with it. Its write now goes through the same core, so the money grammar,
authorization and audit behaviour cannot differ between the two doors.
