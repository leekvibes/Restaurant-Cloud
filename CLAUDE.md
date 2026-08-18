# ZWIN

Back-office for one restaurant, run by its owner (Malek) from a laptop and a
phone. Node + Express + better-sqlite3, server-rendered HTML from template
literals. No build step, no framework.

**`git push origin main` deploys to production on Render.** There is no staging.
Ask before pushing unless told otherwise in the same conversation.

---

## Running it

```bash
npm test          # the whole suite, ~1100 tests, all of it must stay green
npm start         # http://localhost:3000
```

Use the Browser pane (`preview_start` with the `zwin` launch config) rather than
Bash for the dev server. The CSS cache-busting hash is computed at boot, so
**restart the server after editing CSS** or the browser keeps the old file.

`data.db` is the local dev database — real-ish data, safe to edit, separate from
production. `DB_PATH` overrides it.

---

## What ZWIN actually is

Eleven areas. The scheduler is one of them, and it is the newest — do not let
the volume of scheduler docs suggest it is the centre of the app. The nightly
close and payroll are older, more used, and closer to money.

| Area | Route | What it does |
|---|---|---|
| Dashboard | `/` | What needs attention today |
| **Services & tip-outs** | `/shifts` | The nightly close. A *service* (café/dinner), who worked it, their sales, and the tip-out split. **The oldest and most money-critical flow** |
| Schedule | `/schedule` | Planned shifts, publishing, Issues. Phases 0–5 shipped |
| Sales | `/sales` | Daily sales, POS webhook from Benugin |
| Performance | `/costs` | Cost ratios over a range |
| Cash | `/cash` | Drawer counts, denominations, reconciliation |
| **Payroll** | `/payroll` | Period roll-up, overtime, take-home, emailed summaries |
| Trackers & logs | `/c/*` | Invoices · expenses · vendors · products + par · expirations · equipment · documents · contacts · recurring tasks · incidents · notes |
| Menu costing | `/menu` | Recipe cost from product prices. Beta |
| Staff | `/employees` `/timeclock` `/staff-portal` `/positions` `/policy` | People, punches, the portal's admin side, tip-out policy versions |
| Settings & users | `/settings` `/users` `/email` | Config, accounts, mail |

**The staff portal** (`/portal/*`, sign-in at `/tips`) is a separate product on
the same server: employees clock in/out, submit sales and tips, read the
specials and 86 board, report low stock, see their pay and their schedule.
Mobile-first, PIN sign-in, its own stylesheet.

## Files

| File | What it owns |
|---|---|
| `src/server.js` | Every route and page. ~34k lines. Pages are template literals |
| `src/db.js` | Schema, migrations, prepared statements. One SQLite connection |
| `src/timeclock.js` | Punches, breaks, business dates. **The clock's truth** |
| `src/scheduler.js` | Planned shifts, publishing, Issues. **Plans only** |
| `src/portal.js` | Staff portal data + notifications (in-app and web push) |
| `src/reports.js` | Payroll aggregation, overtime |
| `src/engine.js` `src/policy.js` | **Tip-out calculation and its versioned policy** |
| `src/modules.js` | The `/c/*` trackers — declarative registry, one shape per module |
| `src/menu.js` `src/products.js` | Menu costing, products, par levels |
| `src/cash.js` | Drawer counts |
| `src/reader.js` | AI extraction from invoice and receipt photos |
| `src/dupes.js` | Duplicate detection for expenses and documents |
| `src/metrics.js` `src/charts.js` | Ranges, comparisons, chart data |
| `src/nav.js` `src/views.js` | Nav model, layout shell, permission gate |
| `src/guard.js` | Rate limiting, sign-in attempts |
| `public/broadsheet.css` | Owner UI |
| `public/staff.css` | Employee portal |

Docs are in `docs/`. They skew heavily to the scheduler because that is what was
built most recently — `TIME-CLOCK-PLAN.md` and `SPEC-dashboard-and-shifts.md`
cover older ground, and for everything else the code comments are the record.

## Invariants — breaking these corrupts real money or real trust

**Schedule is a plan. Time Clock is what happened.** `scheduler.js` never writes
a punch, an hour, a `work` row or a payroll figure. Never imply attendance from a
schedule — no "Now", "In progress", "Late", "Clocked in" on a scheduled shift.

**The business date is the authority, not the calendar date.**
`TC.businessDateOf(utc, cutoffHour)` with `tc_day_cutoff` (4am). Friday night
ends at 4am Saturday. A page about a *service* uses `serviceToday()`; a page
about *paperwork* (an invoice, an expense) uses the calendar date. Five pages
were once wrong about this and only between midnight and 4am.

**Employees read `published_schedule`, never `scheduled_shifts`.** Not because
the queries are careful — because drafts are not in the table the portal queries.
Keep it that way.

**The punch is the hours.** `syncShiftHours` propagates a punch edit to
`work.hours`, which payroll reads. If that call is ever dropped, nothing appears
to break and somebody gets paid wrong.

**Money is integer cents. Clock time is integer minutes.** `work.hours` is
decimal hours — the one exception, and it is the payroll boundary.

**A tip-out is calculated against a POLICY VERSION, not today's settings.**
`shifts.policy_id` pins the version a service was closed under. Changing the
tip-out rules must never retroactively restate what somebody was already paid.
Same discipline as `scheduled_shifts.daypart` being stamped once.

**An invoice is matched by its number, never by its file.** Two photographs of
the same invoice are different bytes; the same PDF re-saved is different bytes
again. `duplicateInvoice()` warns and allows — a vendor really can bill the same
amount twice on one day, so a hard block would leave the second unfileable.

**Overtime is weekly and comes from worked time.** `aggregatePayroll` splits it
on the pay-period workweek. Never project OT from a schedule.

---

## Traps that have each cost real time

**`.bs *` sets `box-shadow: none !important`** (broadsheet.css:194). A shadow
inside the owner shell silently does nothing. Use `outline` or `border`. A
Phase 3 marker shipped invisible this way and nobody noticed for weeks.

**CSRF stands down when `APP_PASSWORD` is unset.** Every dev machine and almost
every test runs that way, so CSRF bugs are invisible locally and fatal in
production. `test/auth.test.js` is the only file that runs with a password set —
put CSRF assertions there.

**Hand-write `_csrf` in every posting form.** This entry used to say the
opposite — that a response-level stamper adds one and two tokens parse as an
array — and following it literally now produces the very bug it warned about.
The stamper skips any form that already carries the field (`server.js`, the
`inner.indexOf` guard), so a duplicate is impossible; and the stamper only runs
when `APP_PASSWORD` is set, which no dev machine and almost no test does. A form
leaning on the stamper therefore ships with **no token field at all** in the mode
we develop in, and breaks the day a password exists.
`test/schedule-board.test.js` asserts this per page.

**A green suite is not a working feature.** Assertions over source text pass
while the rendered or computed reality is broken. Measure in the browser —
`getComputedStyle`, `getBoundingClientRect`, actually click the thing. This has
caught a dead drawer script, an unpainted palette, a card that opened nothing,
and a board that clipped every shift on a phone.

**And a screenshot sometimes corrects the measurement.** Transitions can be
paused in the headless pane; a rect read mid-flight lies. When the two disagree,
look again before reporting a defect.

**Backticks inside a template literal** end the string early. This has broken
SQL and inline browser scripts. Prefer plain quotes in comments inside templates.

**Time-dependent tests.** A test written at noon can pass against broken code.
To exercise the midnight/cutoff gap at any hour, move the *cutoff* rather than
the clock — see `test/business-date.test.js`.

**Every test file that spawns a server needs its own port.** `test/boot.test.js`
enforces it, including servers started inside a test body.

---

## How the owner works

Malek reads carefully and asks direct questions. He wants the real answer, not a
reassuring one — including when something is not done, not verified, or was
broken by the last change. Say which findings were measured and which were
inferred.

Long specs often arrive pasted from another model. When one says "audit only",
it means audit only, and the product decisions in it get surfaced rather than
taken. Audits go in `docs/` as committed documents so the next session can read
them cold.

Commit messages here are long and explain the reasoning, including mistakes made
along the way. Match that.

---

## Deliberately not built

No projected overtime from the schedule (actual OT in payroll is authoritative).
No staffing targets. No auto-scheduling. No drag/drop. No PTO balances or leave
accounting. No multi-tenancy yet — see `docs/ZWIN-MULTI-TENANCY.md`, which also
records that a fresh install currently seeds this restaurant's real staff and
history, and must not be handed to anyone else until that is fixed.

Scheduler phases 0–6 are shipped. Phase 6 (Availability + Time Off) was built
against `docs/ZWIN-SCHEDULER-PHASE-6-AUDIT.md`, whose Part Three is the approved
decision contract — read that before changing any of its behaviour.

**Phase 6 invariants**, each with a test behind it: no availability rows means
**available**, and "available" is never stored; `sch_availability` governs stated
availability only and never time off, and an absent key means ON; a **pending**
request is drawer context and never an Issue; availability warns and never
blocks, including Publish; the reason an employee gives renders in exactly two
places — their own page and the gated manager queue.
