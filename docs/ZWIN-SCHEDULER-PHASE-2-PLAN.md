# ZWIN SCHEDULER — PHASE 2 IMPLEMENTATION PLAN

Manager Week Board + Create/Edit Drawer + Copy Previous Week.

Decisions Q1–Q6 approved. **This document is the plan, not the work.** Nothing
implemented; no file modified beyond this one.

---

# I. THE DECISIONS, AS THEY LAND IN CODE

## Q1 — The week is the pay-period workweek, derived in one place

The board's week must be the same seven days overtime is measured against.
Verified from `reports.js:120–123`: the OT workweeks are the pay-period start
and start + 7 — **currently a Saturday**, not a Monday.

**One function, `weekWindowFor(businessDate)`, becomes the only definition of
"which week is this" in the scheduler:**

```js
// src/scheduler.js — replaces the Monday arithmetic entirely
function weekWindowFor(businessDate) {
  const p = P.periodFor(businessDate);              // periods.js owns the anchor
  const offset = daysBetween(p.start, businessDate);
  const start = addDays(p.start, Math.floor(offset / 7) * 7);
  return { start, end: addDays(start, 6) };
}
```

Properties that matter:

* **No `getDay()`, no `new Date(str)`** — pure ISO-date arithmetic. This is what
  fixes **D2 and D3 together**, rather than as two patches.
* **Follows the anchor.** `periods.js` already owns `anchor()` and
  `periodLength()`. If the owner moves either, the board moves with them and no
  scheduler code changes — which is the "replaceable centrally" requirement.
* Verified across boundaries:

```
2026-08-07  period 08-01→08-14   week 08-01→08-07
2026-08-08  period 08-01→08-14   week 08-08→08-14
2026-08-15  period 08-15→08-28   week 08-15→08-21
2026-12-31  period 12-19→01-01   week 12-26→01-01   ← year boundary
```

⚠️ **One thing to flag now:** this generalises only while the period length is
a multiple of 7. `periodLength()` is configurable. If it is ever set to, say,
10 days, the last "week" of a period is a 3-day stub. I will make
`weekWindowFor` handle that explicitly (a short final week rather than one that
runs past the period end) and note it rather than pretend it cannot happen.

**Prev/next** is ±7 days from the current week start, which stays aligned to
period boundaries by construction.

## Q2 — Overlap warns, never blocks, and stays separable

`overlapsFor()` already exists and is tested. Phase 2 adds one call site and one
message. It is deliberately **not** wired into `validate()` — that would make it
a hard rule and Phase 4 would then have to unpick it.

```
create/edit route
  → domain write (validate() = hard rules only)
  → S.overlapsFor(saved)  ← advisory, after the write
  → redirect with ?warn=overlap
```

Phase 4 replaces the single call with the conflict engine; nothing else moves.

## Q3 — Two hour figures, and breaks validated first

**Span and paid hours are different numbers and both are kept.**

```
spanMinutes  = ends_at − starts_at
paidMinutes  = spanMinutes − Σ(unpaid break minutes)
```

Paid breaks do not reduce paid hours. The board shows **paid** hours; the drawer
shows both when they differ, so a manager can see why 8h became 7.5h.

**Break validation (D5) lands before any of this is trusted:**

| Break shape | Rule |
|---|---|
| duration only (`planned_start_at` NULL) | `0 < minutes ≤ spanMinutes` |
| with a planned start | start ≥ shift start **and** start + minutes ≤ shift end |
| any | `minutes` must be a positive integer |

⚠️ **Reading I need confirmed.** Q3 says every break must *"have a valid
start/end"*. Phase 0 locked planned start as **optional** — a manager usually
knows somebody gets half an hour and not when. I have read this as *"a break
that has a start must have a valid one"*, keeping duration-only breaks legal.
If you meant planned start becomes **required**, say so — it is a one-line
change but it reverses a Phase 0 decision.

Today `writeBreaks()` **silently drops** any entry with `minutes <= 0`. That
becomes a refusal, not a silent drop.

## Q4 — No open shifts

The drawer requires an employee. No null-employee row is creatable from any
Phase 2 surface. The domain keeps the capability, unreachable, until the full
claim workflow.

**One consequence to state:** `publish()` currently returns
`action: 'skipped-open'` for a null-employee row. That path becomes unreachable
in Phase 2 and stays as-is — removing it would be scope creep into Phase 8.

## Q5 — One eligibility rule, called from both paths

The defect: `copyWeek()` inserts directly via `q.insert`, bypassing `validate()`.

**Fix by extraction, not duplication.** `validate()` already holds the rule;
`copyWeek` will call the same function, catch `ScheduleError`, and skip with the
error's own message:

```js
try { validate({ employeeId, position, startsAt, endsAt }); }
catch (e) { skipped.push({ id: s.id, why: e.message, code: e.code }); continue; }
```

Result: one rule, two callers, and every skip reports **why** in words a manager
can read — *"Dana is not assigned to Barista"*, not a code.

## Q6 — The draft banner

**`Draft schedule · Not visible to employees`** — persistent on the board, not a
dismissible toast. No publish control ships in Phase 2.

## Additional decisions

* **"Delete"**, not "Cancel". Calls `cancel()` underneath; the row is kept.
* **Duplicate** creates in the same employee/day cell, no drawer.
* **Grid: extract shared primitives**, do not fork `.tsg-*` and do not couple
  Schedule to Timesheets-only CSS. See §III.

---

# II. THE SIX DEFECTS

| | Fix |
|---|---|
| **D1** N+1 breaks | `q.breaksForMany` — one `WHERE scheduled_shift_id IN (…)`, grouped in memory. **Batch, not cache.** A test asserts the query count is bounded regardless of shift count. |
| **D2** Monday hard-coded | gone — `weekWindowFor()` derives from the period anchor (Q1) |
| **D3** server-local parsing | gone — no `new Date(str)` anywhere in the week path; ISO-date arithmetic only |
| **D4** no hours arithmetic | `spanMinutes` / `paidMinutes` per shift; `weekTotals()` aggregates (Q3) |
| **D5** break not validated | rules table above; silent drop becomes refusal |
| **D6** copyWeek eligibility | shared `validate()` (Q5) |

---

# III. THE GRID — EXTRACT, DON'T FORK

`.tsg-*` (broadsheet.css:4250+) is a proven employee × day grid: frozen employee
column, contained horizontal scroll, sticky day headers, z-index capped below
the sidebar. Its own comment records the responsive decision.

**Plan: extract the structural half into `.egrid-*`**, leave the
Timesheets-specific half where it is.

| Extracted to `.egrid-*` (shared) | Stays `.tsg-*` (Timesheets only) |
|---|---|
| `overflow-x: auto` scroll container | hour figures, `·` empty marker |
| grid template with a column-count variable | period-total right column |
| sticky day headers | week-boundary rule |
| sticky left employee column | open-shift green |
| corner cell stacking, z-index ceiling | row hover tied to those cells |

Timesheets keeps working by composing `.egrid-* .tsg-*`. **Its tests must stay
green unchanged** — that is the proof the extraction was faithful.

Schedule then adds `.swb-*` for cards, drawer trigger, totals row.

---

# IV. EXACT FILES AND DATA PATHS

## Files touched

| File | Change |
|---|---|
| `src/scheduler.js` | `weekWindowFor()`, `weekTotals()`, `duplicate()`, `q.breaksForMany`, `heldPositionsFor(ids)`, break validation, `copyWeek` → `validate()`, span/paid minutes |
| `src/server.js` | **first `require('./scheduler')`**; `GET /schedule`; `POST /schedule/shift`, `/schedule/shift/:id`, `/schedule/shift/:id/delete`, `/schedule/shift/:id/duplicate`, `/schedule/copy-week` |
| `src/nav.js` | `AREAS` `{ key: 'schedule', label: 'Schedule', paths: ['/schedule'] }`; `SECTIONS` under Operations after Services |
| `public/broadsheet.css` | extract `.egrid-*`; add `.swb-*` |
| `test/scheduler.test.js` | domain additions; the eight invariants stay |
| `test/schedule-board.test.js` | **new** — routes, auth, board, drawer, copy |
| `docs/ZWIN-SCHEDULER-ROADMAP.md` | record Q1–Q6 |

**Not touched:** `engine.js` · `reports.js` · `policy.js` · `overtime.js` ·
`money.js` · `db.js` · `portal.js` · `timeclock.js` · `periods.js`

`periods.js` is **read, never written** — `periodFor()` only.

## Data paths

**Read:** `scheduled_shifts` · `scheduled_breaks` · `employees` (active) ·
`employee_roles` · `positions` · `settings` (`tc_day_cutoff`, `tc_dinner_from`,
period anchor/length via `periods.js`)

**Written:** `scheduled_shifts` · `scheduled_breaks` — **and nothing else.**

**Never touched by any Phase 2 path:** `time_entries` · `time_breaks` · `work` ·
`shifts` · `server_sales` · `tip_submissions` · `timesheets` ·
`published_schedule` (no publish control) · `portal_events` (no notifications)

## Routes

| Method | Path | Auth |
|---|---|---|
| GET | `/schedule?w=YYYY-MM-DD` | owner + viewer (read) |
| POST | `/schedule/shift` | owner; viewer 403 at :572 |
| POST | `/schedule/shift/:id` | owner |
| POST | `/schedule/shift/:id/delete` | owner |
| POST | `/schedule/shift/:id/duplicate` | owner |
| POST | `/schedule/copy-week` | owner |

Every POST carries `_csrf`; success and refusal both redirect with `?msg=` /
`?err=1`, rendered by the existing `flash(req)`.

---

# V. BUILD ORDER

1. **Domain first** — D1–D6, `weekWindowFor`, `weekTotals`, `duplicate`, break
   validation, `copyWeek` eligibility. Tests before any UI.
2. **CSS extraction** — `.egrid-*`, with Timesheets tests green **unchanged**.
3. **Wire the module** — first `require('./scheduler')` in `server.js`, nav
   entry, `GET /schedule` read-only.
4. **Drawer and writes** — create, edit, delete, duplicate.
5. **Copy previous week**, with the skip report.
6. **Overlap warning** (Q2).
7. **Totals and the draft banner** (Q3, Q6).
8. Responsive and accessibility verification, then measure.

Steps 1–2 change no behaviour. Step 3 is the first production schema release.

---

# VI. WHAT I WILL NOT DO IN THIS PHASE

publish controls · employee Schedule tab · notifications · open shifts ·
availability · time off · templates · recurrence · drag and drop · Day or Month
view · labour cost · projected overtime · staffing targets · the Phase 4
conflict engine beyond the single overlap warning.

---

# VII. OPEN — ONE ITEM

**Q3's "valid start/end" wording.** I have read it as *a break that has a
planned start must have a valid one*, keeping duration-only breaks legal per
Phase 0. If you meant planned start becomes required, that reverses a Phase 0
decision and I would rather change it deliberately than by inference.

Everything else is settled. Say go and I start at V.1.
