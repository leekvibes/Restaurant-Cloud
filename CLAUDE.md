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

## The shape of it

| File | What it owns |
|---|---|
| `src/server.js` | Every route and every page. ~34k lines. Pages are template literals |
| `src/db.js` | Schema, migrations, prepared statements. One SQLite connection |
| `src/timeclock.js` | Punches, breaks, business dates. **The clock's truth** |
| `src/scheduler.js` | Planned shifts, publishing, the Issues engine. **Plans only** |
| `src/portal.js` | Staff portal data + notifications (in-app and web push) |
| `src/reports.js` | Payroll aggregation, overtime |
| `public/broadsheet.css` | Owner UI |
| `public/staff.css` | Employee portal |

Docs live in `docs/`. Start with `ZWIN-SCHEDULER-ROADMAP.md` for the scheduler,
and the phase audits for anything scheduler-adjacent. `ZWIN-DESIGN-SYSTEM.md`
and `ZWIN-UI-MAP.md` cover the look and the page inventory.

---

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

---

## Traps that have each cost real time

**`.bs *` sets `box-shadow: none !important`** (broadsheet.css:194). A shadow
inside the owner shell silently does nothing. Use `outline` or `border`. A
Phase 3 marker shipped invisible this way and nobody noticed for weeks.

**CSRF stands down when `APP_PASSWORD` is unset.** Every dev machine and almost
every test runs that way, so CSRF bugs are invisible locally and fatal in
production. `test/auth.test.js` is the only file that runs with a password set —
put CSRF assertions there. Forms must not carry a hand-written `_csrf`; a
response-level stamper adds one, and two tokens parse as an array and refuse
every submit.

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

Scheduler phases 0–5 are shipped. Phase 6 (Availability + Time Off) is audited
and awaiting product decisions — `docs/ZWIN-SCHEDULER-PHASE-6-AUDIT.md` §49.
