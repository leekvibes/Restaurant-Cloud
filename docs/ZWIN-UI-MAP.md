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
| Portal day detail | `/portal/timesheet/day/:date` | Tapping a day row |
| Portal earnings detail | `/portal/earnings/:id` | Tapping a past shift |
| Portal notifications | `/portal/notifications` | "See all", or the hub line when nothing is new |
| Portal requests | `/portal/requests` | Timesheet ••• menu |
| Portal time history | `/portal/clock/history` | Timesheet ••• menu |
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
| Submit-timesheet sheet | `#ts-sheet` | Portal timesheet |
| Account menu | `.bs-acct` / `.bs-pop` | Masthead |
| Timesheet actions menu | `.tsx-menu` | Portal timesheet ••• |
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
