# ZWIN SCHEDULER — PHASE 0 ARCHITECTURE AUDIT

Read-only audit against roadmap v4. **No code, no migration, no UI written.**
Every claim below cites the file and line it came from.

---

# PART 1 — WHAT EXISTS

## 1.1 The two objects called "shift"

```sql
-- src/db.js:23
CREATE TABLE shifts (
  id, date, daypart, status, policy_id,
  pool_jar_cents, pool_togo_cents, created_at,
  UNIQUE(date, daypart)          -- ← one row per service, restaurant-wide
);

-- src/db.js:35
CREATE TABLE work (
  shift_id, employee_id, role, hours, hourly_rate_cents,
  hours_source, hours_set_by, hours_set_at,
  PRIMARY KEY (shift_id, employee_id)
);
```

A `shifts` row is **a service the restaurant runs** — Tuesday dinner, one row,
everyone attaches via `work`. It is what the tip engine pools against, what
`policy_id` versions, what `server_sales` hangs off, and what `aggregatePayroll`
reads.

A scheduled shift is one employee with arbitrary times, many per day. **These
cannot share a table.** Confirms roadmap §I.15.

## 1.2 The scheduled-vs-actual seam already exists

The most consequential finding of this audit:

```sql
-- src/timeclock.js:57-59
-- Left for scheduling, which is a later phase. Nullable and unread today.
scheduled_shift_id INTEGER, scheduled_start_at TEXT, scheduled_end_at TEXT,
scheduled_position TEXT,
```

Four columns on `time_entries`, reserved by an earlier phase and **read by
nothing** — I grepped `src/` and `test/`; the schema definition is the only
reference. The join between a punch and the shift it was planned as is already
carved out and costs no migration.

This answers roadmap Phase 0 question **D** almost entirely.

## 1.3 Qualification — already built

```sql
-- src/db.js:82
CREATE TABLE employee_roles (employee_id, role, wage_cents,
                             PRIMARY KEY (employee_id, role));
-- src/db.js:115
CREATE TABLE positions (id, slug, name, kind, sort, active);  -- + takes_tips
```

`heldPositions(emp)` (server.js:4534) already answers *"what may this person
do"*, deliberately strictly — it does **not** fall back to all roles the way
`rolesForEmployee` does. That strictness is exactly what a scheduler needs.

**Verdict on question C: sufficient. No second Jobs system needed.**

Note two different `active` flags: `positions.active` (is this job in use) and
`employees.active` (is this person employed). Both matter and they are not the
same question.

## 1.4 Business date — one authority, reusable

```js
// src/timeclock.js:421  cutoffHour: Number(setting('tc_day_cutoff')) || 0
// src/timeclock.js:433  clamped 0–12, default 4
// src/timeclock.js:457
function businessDateOf(utc, cutoffHour) { … }
```

Stored in the shared `settings` key/value table. **Question B: confirmed, reuse
directly.** No scheduler cutoff.

## 1.5 Breaks — and why planned breaks cannot live in `time_breaks`

```sql
-- src/timeclock.js:75
CREATE TABLE time_breaks (
  time_entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE, …
);
```

`time_entry_id` is **NOT NULL**. A planned break has no punch, so it cannot be
represented here at all — the schema refuses it before any trigger fires. On
top of that, twelve triggers guard this data, including `trg_tb_inside_ins`
(a break must sit inside its punch) and `trg_te_breaks_fit_upd` (a punch update
may not leave a break outside).

**Question F: confirmed by the schema itself, not merely by policy.** Planned
breaks need their own representation on the scheduled shift.

## 1.6 The request/approval pattern already exists

```sql
-- src/timeclock.js:210
CREATE TABLE time_corrections (
  id, time_entry_id, employee_id, kind, field,
  original_value, proposed_value, reason,
  requested_by, requested_at,
  decision TEXT DEFAULT 'pending',   -- pending | approved | rejected | applied
  decided_by, decided_at, decision_note
);
```

Time off, claims and replacements are all *request → decision → apply*. This is
the shape to follow rather than invent — same lifecycle vocabulary, same
`pending/approved/rejected/applied` states, so the owner's Requests queue reads
consistently.

## 1.7 Settings — no migration needed

`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)` is
declared defensively by **six** modules (backfill, cash, overtime, periods,
products, timeclock) so any of them can boot alone. Scheduler settings are new
rows, not new schema.

## 1.8 What does not exist

**No availability. No work preferences. No time off.** Nothing in the schema
resembles them. Roadmap Phase 6 is entirely net-new — confirmed for question G.

## 1.9 Auth

- **Employee:** `requirePortal` → `portalUser` → signed `zwin_portal` cookie.
- **Owner:** global gate at server.js:558 — `/staff-portal` is absent from
  `OPEN_PATHS`, so anonymous non-GET is 401, `viewer` non-GET is 403, then
  `canSee(user, featureFor(path))`.
- **Defence in depth:** `mayManagePortal(user)` (commit `9816d67`).

A Scheduler page needs an `AREAS` entry, which becomes its permission key.

## 1.10 The employee Schedule tab is locked and tested

```js
// src/server.js — PORTAL_NAV
{ key: 'schedule', availability: 'locked', href: null,
  lockedMessage: 'Employee scheduling is coming soon…' }
```

Guarded by `2D-1: Schedule is present, locked, and never the current tab`,
which asserts it is a `<button>`, carries `pt-tab-locked`, and has no `href`.
Phase 3 flips all three. Known, not a surprise.

---

# PART 2 — CONFLICTS AND RISKS FOUND

## 🔴 R1 — Daypart is a hard-coded binary, not a configurable service model

```js
// src/views.js:57
const dp = (d) => (d === 'cafe' ? 'Café' : 'Dinner');
// src/server.js:425
const DAYPARTS = ['cafe', 'dinner'];
```

`dp()` has **no third branch** — any future service renders as "Dinner", silently
and everywhere. `DAYPARTS` is a code constant, not a settings row. `daypart`
appears **263 times** across the codebase (192 in `server.js`, 71 elsewhere).

Roadmap §I.4 says "café, dinner, **future services if added later**." That
sentence is not currently true, and making it true is a real piece of work
touching tips, payroll, the tips workspace and the Services page.

**Decision needed.** My recommendation: **scope the scheduler to the two
services that exist.** Stamp `cafe | dinner` on scheduled shifts, and treat "a
third service" as its own future project across the whole app rather than
something the scheduler introduces alone. Introducing a third service *through*
the scheduler means the schedule could reference a service Payroll cannot cost.

## 🟠 R2 — Salaried employees have no hourly rate, so planned labor is $0

```js
// src/db.js shiftInputs()
const salaried = row.pay_type === 'salary';
let rateCents = 0;
if (!salaried) { …per-shift override → role wage → employee default… }
```

`employees` carries `pay_type`, `salary_cents` and `ot_exempt`. For a salaried
employee the engine deliberately resolves an hourly rate of **zero** — correct
for tip-out maths, misleading on a labour-planning screen where a scheduled
manager would contribute $0.00 to planned cost.

Roadmap §Phase 10 documents *"planned labor resolves via position/role wage →
employee default"* but does not address salaried staff.

**Decision needed at Phase 10, flagged now so the schema carries what it needs.**
Options: exclude salaried from planned labour with a visible note; amortise
`salary_cents` across scheduled hours; or show headcount without cost for them.

## 🟠 R3 — Renaming the `shifts` AREA key would break account permissions

```js
// src/nav.js:23
{ key: 'shifts', label: 'Shifts & tip-outs', paths: ['/shifts'] },
// src/nav.js:25 — comment on the adjacent 'costs' entry
// Renamed from "Cost %" in the UI. The key stays put: it is written into
// every account's feature list.
```

There is precedent for exactly this: `costs` was relabelled *Performance* while
the key stayed. Feature keys are persisted per user account.

**Answer to question J:** rename **labels, headings, nav text and copy only**.
Keep `key: 'shifts'`, keep `paths: ['/shifts']`, keep the `shifts` table name.
Product language separates; identifiers do not move. Zero migration, zero
permission risk.

## 🟡 R4 — `dp()` lives in `views.js`, shared by owner and portal

Any change to service naming affects both shells simultaneously. Not a blocker,
but it means service-window work cannot be scoped to the scheduler alone.

## 🟡 R5 — `time_entries.daypart` is nullable

A punch may exist with no service recorded. Scheduled-vs-actual comparison must
tolerate a null on the actual side rather than assuming both are stamped.

---

# PART 3 — ANSWERS TO THE PHASE 0 QUESTIONS

All ten are settled. Decisions taken with the owner are marked **[decided]**.

| | Question | Answer |
|---|---|---|
| **A** | Daypart / cross-service | **[decided]** Manager selects; time-window is the default — see 3.1 |
| **B** | Business date | ✅ Reuse `tc_day_cutoff` + `businessDateOf()` directly |
| **C** | Positions sufficient | ✅ Yes. `heldPositions()` + `employee_roles`. No second system |
| **D** | Scheduled vs actual | ✅ Seam exists — 4 reserved columns on `time_entries` |
| **E** | Employee lifecycle | ✅ Create-time guard; deactivate hides, reactivate returns future only |
| **F** | Planned breaks | **[decided]** Minutes required, planned start optional — see 3.4 |
| **G** | Time off | ✅ Nothing exists. Build in Phase 6, following `time_corrections` |
| **H** | Planned labor wage | ⚠️ Path confirmed; **salaried unresolved (R2)**, decide at Phase 10 |
| **I** | Query window | **[decided]** Rolling −7 / +90 days — see 3.3 |
| **J** | Naming scope | ✅ Labels only. Keys, paths and table names stay (R3) |

## 3.1 Service model **[decided]**

**Two services only: `cafe` and `dinner`.** The scheduler does not introduce a
third. Adding one is a project across the whole app — `dp()` has no third
branch and `daypart` appears 263 times — and a schedule must never reference a
service Payroll cannot cost.

**Scheduling:** the manager selects the service. The time window supplies the
default so the common case needs no thought.

**No spanning.** A shift belongs to exactly one service. A genuine
café-through-dinner shift is created as two shifts, which also keeps Day view
honest about coverage.

**Stamped at creation, never re-derived.** Changing a window later does not
rewrite existing shifts — the same discipline as `shifts.policy_id`.

## 3.2 Service windows are a setting, and they must touch **[decided]**

Stored as settings rows, editable by the owner:

```
svc_cafe_start   06:00      svc_dinner_start  16:00
svc_cafe_end     16:00      svc_dinner_end    05:00   (crosses midnight)
```

**The windows abut with no gap.** The earlier proposal left 4–5 PM and 5–6 AM
uncovered, which would have made derivation fail for a 4:30 PM dinner-prep
clock-in. Dinner now begins at 16:00 — *"4–5 PM counts as dinner, it's late
enough in the day"* — and the owner can move the boundary.

Validation the settings screen must enforce: **no gap and no overlap.** One
boundary value, not two independent ones.

## 3.3 The employee schedule window **[decided]**

`business_date` from **current − 7 days** through **current + 90 days**.

A rolling tail rather than a calendar week, because "current week" has a cliff
every Monday that erases Sunday night — the shift somebody most wants to check
when wondering whether they were paid for it.

Checked against the three existing portal date behaviours before adding a
fourth: Pay uses a floor plus pagination (`HISTORY_FROM`, `PAY_PAGE = 20`);
Timesheet uses one pay period (`?p=`); Sales & tips uses recent owned shifts
(`LIMIT 40`). None uses a calendar week.

Noted for later: making the tail *the current pay period* would let My Schedule
and Timesheet describe the same window, so *"was I paid for that shift"* becomes
answerable by switching tabs. More complex; revisit after Phase 7.

## 3.4 Planned breaks **[decided]**

**Minutes required. Planned start optional.**

Duration-only makes Day view lie — "30 minutes somewhere between 4 and 10"
cannot tell you whether 7 PM is covered, which is the question Day view exists
to answer. But a scheduled break *time* is usually fiction: restaurant breaks
are taken when service allows.

Both are stored, so Day view draws a real gap when the time is known and
annotates the bar when it isn't — *"5 on the floor · 30 min break to absorb"*.
No migration when you later decide you want times.

## 3.5 Clock-in service assignment — **DEFERRED, not a Phase 1 change**

The earlier draft of this document proposed deriving a punch's service from the
time window. **That is out of Phase 1 scope.** Scheduler Phase 1 owns planned
work, not actual clock behaviour.

It fails the equivalence test outright. Today the employee **picks**, and the
clock refuses without an answer:

```js
// server.js:6595
const daypart = DAYPARTS.includes(req.body.daypart) ? req.body.daypart : null;
if (!daypart) return back('Choose which service you are working.');
```

Deriving instead of asking removes a question the employee currently answers.
That changes what gets stamped on real punches — which feed `work.hours`, the
tip engine and Payroll. It is a behaviour change to live timekeeping, not a
refactor, so it cannot ride along inside a scheduling release.

**Phase 1 therefore leaves Time Clock exactly as it is.** No change to
`timeclock.js`, no change to the clock-in route, no change to how any punch is
stamped.

### The seam, documented for a future phase

The shared semantics are approved in principle — one definition of "which
service is this", not two. What Phase 1 builds toward that:

* `serviceFor(at)` lives in `src/scheduler.js` and is used **only** to supply
  the scheduler's default service when a manager creates a shift.
* The service windows are stored as settings and are the single source those
  semantics would read from.

A future Time Clock phase can then adopt `serviceFor()` as its own default,
with its own audit, its own product decision about whether the employee keeps
the ability to override, and its own before/after proof on real punches.

**Recorded rule for that phase:** the service is stamped at clock-in, clocking
out never changes it, and a manager can still correct it afterwards
(`timeclock.js:1205, 1281`). That behaviour exists today and must survive.

## 3.6 Multi-schedule / multi-location — **architectural note only**

**No column is added in Phase 1.** A nullable `schedule_id` that nothing writes
and nothing reads is a guess about semantics that do not exist yet, and a wrong
guess is more expensive than the migration it was meant to avoid. The real
relationship gets added by the multi-location project, once that project knows
what a location *is*.

The note that must survive:

**If a multi-schedule dimension is ever built, it means LOCATION or SITE — never
a second service model.** Multiple schedules were originally described as
*"different parts of the day **or** multiple locations."* Those are different
axes, and the first collides with daypart: a "café schedule" and a "dinner
schedule" are just the two services, and building both concepts creates two ways
to say one thing that will eventually disagree.

Service stays the daypart it already is everywhere else in the app. The same
applies to "multiple time clocks", which is also a location-scope idea.

---

# PART 4 — PROPOSED ARCHITECTURE

## 4.1 Three tables

```sql
-- The manager's working copy. Edited freely; employees never read it.
CREATE TABLE scheduled_shifts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id       INTEGER REFERENCES employees(id) ON DELETE CASCADE,
                    -- NULL = open/unassigned shift (Phase 8 uses the same row)
  position          TEXT NOT NULL,        -- slug, validated against held positions
  business_date     TEXT NOT NULL,        -- via businessDateOf(); the query key
  starts_at         TEXT NOT NULL,        -- UTC 'YYYY-MM-DD HH:MM:SS'
  ends_at           TEXT NOT NULL,        -- UTC; may cross midnight
  timezone          TEXT NOT NULL,
  daypart           TEXT NOT NULL,        -- STAMPED at creation, never re-derived
  status            TEXT NOT NULL DEFAULT 'draft',   -- draft | published | cancelled
  changed_after_publish INTEGER NOT NULL DEFAULT 0,  -- a MANAGER HINT only
  note              TEXT,                 -- employee-visible
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_by        TEXT,
  updated_at        TEXT
);

-- What employees see. Written ONLY by publish(). One write path.
CREATE TABLE published_schedule (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_shift_id INTEGER NOT NULL REFERENCES scheduled_shifts(id) ON DELETE CASCADE,
  employee_id        INTEGER NOT NULL,
  position           TEXT NOT NULL,
  business_date      TEXT NOT NULL,
  starts_at          TEXT NOT NULL,
  ends_at            TEXT NOT NULL,
  daypart            TEXT NOT NULL,
  note               TEXT,
  breaks_json        TEXT,                -- frozen copy of the planned breaks
  published_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scheduled_shift_id)
);
CREATE INDEX idx_pub_emp ON published_schedule (employee_id, business_date);

CREATE TABLE scheduled_breaks (
  id, scheduled_shift_id REFERENCES scheduled_shifts(id) ON DELETE CASCADE,
  minutes INTEGER NOT NULL,
  planned_start_at TEXT,                  -- NULL = "somewhere in the shift"
  paid INTEGER NOT NULL DEFAULT 0, note TEXT
);
```

### Why `published_schedule` is a separate table

The single-row `status + changed_after_publish` model **fails** the required
invariant. Traced:

| | `scheduled_shifts` row | `publishedFor(Esther)` |
|---|---|---|
| publish Fri 4–10 | `16:00–22:00, published` | **4–10** ✅ |
| edit to 5–11, no republish | `17:00–23:00, published, changed=1` | **5–11** ❌ |

The edit overwrites the only copy of the times. `changed_after_publish` records
*that* something changed, never *what it was*.

With a separate table, `publishedFor()` reads `published_schedule` and nothing
else. It is **structurally incapable** of returning a draft. The invariant is
not maintained by care — there is nowhere for an unpublished edit to leak from.

Rejected alternatives: **snapshot columns** on the same row (every
employee-visible field gets a twin, and someone eventually adds a field and
forgets the twin — this codebase has already been bitten by that shape);
**version rows** (the audit-history machinery v4 §I.12 rules out).

`changed_after_publish` survives, demoted to a manager hint. It is never
consulted for what an employee sees.

## 4.2 Service layer — `src/scheduler.js`

New module, following `timeclock.js`: owns its schema, exports operations,
never lets a route write a row directly.

```
create(input)            validate → derive+stamp daypart → business date → insert
edit(id, patch)          revalidate; set changed_after_publish on material change
cancel(id)               status = cancelled; publish() then removes it downstream
publish(ids)             THE ONLY WRITER of published_schedule; notifies
weekFor(dates)           manager board: drafts + published, merged
publishedFor(emp, win)   employee My Schedule; reads published_schedule ONLY
copyWeek(from, to)       drafts only, current rules, active employees only
serviceFor(at)           the scheduler's default service for a start time
```

`serviceFor()` is the single definition of "which service is this", but in
Phase 1 it has exactly one caller: the scheduler's own create/edit path. Time
Clock keeps its current behaviour untouched (§3.5) and may adopt this function
in a later, separately audited phase.

## 4.3 The invariants, as tests

Asserted against the database, not described in prose — the precedent set by
Phase 2F's manual-report proofs.

1. Creating a scheduled shift creates **no** `time_entries`, `time_breaks`,
   `work`, `server_sales` or Payroll row.
2. **Deleting or cancelling a scheduled shift touches no punch, no `work` row
   and no `shifts` row.**
3. **The published-schedule invariant:** publish 4–10 → edit to 5–11 without
   republishing → `publishedFor()` still returns **4–10**. Republish → 5–11.
4. A stamped `daypart` does not change when service windows change.
5. An inactive employee cannot receive a new assignment.
6. Service windows abut: `serviceFor()` returns a service for **every** minute
   of the day, and never two.
7. **Time Clock is untouched.** Clock-in still asks for the service and still
   refuses without one; a punch is stamped exactly as it is today.
8. `aggregatePayroll` output is byte-identical before and after a week of
   scheduled shifts exists.

Invariants 3, 7 and 8 run on every scheduler commit.

## 4.4 Build sequence for Phase 1

schema + module → `serviceFor()` and the window settings → create/edit/cancel →
daypart stamping → business-date handling → `publish()` and
`published_schedule` → query layer → **Services rename, labels only** →
invariant tests.

**Explicitly not in Phase 1:** any change to Time Clock, to clock-in service
assignment, or to how a punch is stamped (§3.5).

---

# PART 5 — OPEN ITEMS

Nothing blocks Phase 1.

One item deferred by agreement:

**R2 — salaried staff in planned labour.** `pay_type = 'salary'` resolves to
$0/hour in `shiftInputs()`, correct for tip-out and misleading on a labour
screen. **Decide at Phase 10**, not now. Flagged here so the schema is designed
knowing it.

---

# APPENDIX — FILES A SCHEDULER WILL TOUCH

| File | Why |
|---|---|
| `src/scheduler.js` | **new** — domain module, owns its schema |
| `src/nav.js` | `AREAS` + `SECTIONS` entry; label-only rename (R3) |
| `src/server.js` | routes, week board, drawer; `PORTAL_NAV` unlock at Phase 3 |
| `public/broadsheet.css` | owner week board |
| `public/staff.css` | employee My Schedule |
| `test/scheduler.test.js` | **new** — invariants first |

**Not touched by Phase 1:** `timeclock.js` · `engine.js` · `reports.js` ·
`policy.js` · `overtime.js` · `money.js` · `portal.js` · `db.js` ·
`test/timeclock.test.js`.

Time Clock is deliberately on that list. Phase 1 reads its business-date helper
and nothing else.
