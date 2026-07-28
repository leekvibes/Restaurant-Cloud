# Zwin Time Clock, Timesheets & Payroll Approval — Phase 1 Plan

**Status:** planning only. No code, no migrations, no implementation.
**Excluded by instruction:** geofencing/GPS/auto-clock-out, scheduling (design for it, don't build it).

Everything marked **[C]** was confirmed by reading the code; **[A]** is an assumption a
reviewer should sanity-check before we build.

---

## 1. Current architecture summary

Single Express app, server-rendered HTML template literals, `better-sqlite3`, integer
cents, `TZ=America/New_York`. Bulk of routes in `src/server.js` (~13k lines) with
subsystems in `src/*.js`.

| File | Owns |
|---|---|
| `src/db.js` | schema + prepared statements (`s.*` shifts, `w.*` work/sales, `q.*` employees) **[C]** |
| `src/engine.js` | tip-out engine (`runShift`) — money split per shift **[C]** |
| `src/reports.js` | `aggregatePayroll`, `salesAndLabor`, `WAGE_RATE_SQL`, XLSX export **[C]** |
| `src/overtime.js` | OT rule store + `overtimeFor()` premium calc **[C]** |
| `src/periods.js` | pay periods, `getSetting`/`setSetting`, `period_sends` **[C]** |
| `src/metrics.js` | shared sales/labor/COGS metrics for Dashboard, Sales, Performance **[C]** |
| `src/portal.js` | staff portal data + `adminNotify` back-office notifications **[C]** |
| `src/modules.js` | config-driven collections (invoices, expenses, incidents…) **[C]** |

### Tables that matter here **[C]**

```sql
employees(id, name, role, email, pin, hourly_rate_cents, pos_id,
          active, pay_type, salary_cents, ot_exempt)
positions(id, slug, name, kind, sort, active, takes_tips)
employee_roles(employee_id, role, wage_cents)          -- extra allowed positions + per-role wage

shifts(id, date, daypart, status, created_at, policy_id,
       pool_*_cents, total_*_cents, sales_note, closed_at,
       UNIQUE(date, daypart))                          -- ← the dedup key
work(shift_id, employee_id, role, hours, hourly_rate_cents,
     PRIMARY KEY(shift_id, employee_id))               -- ← where hours live today
server_sales(shift_id, employee_id, food/coffee/alcohol_cents,
             card_tips_cents, cash_tips_cents, cash_entered_by, note,
             PRIMARY KEY(shift_id, employee_id))
settings(key TEXT PRIMARY KEY, value TEXT)
```

**The single most important fact for this feature:** a shift is uniquely
`(date, daypart)` — enforced by a DB constraint — and every creation path already
funnels through `s.getOrIgnore(date, daypart)` then `s.findShift(date, daypart)`. **[C]**

---

## 2. Existing workflow map

### Shift creation — three paths, one rule **[C]**

| Path | Where | Behavior |
|---|---|---|
| Manual | `POST /shifts` (`server.js:1483`) | `findShift`, else create |
| **Tip submission** | `POST /tips` (`server.js:3892`) | `getOrIgnore` → `findShift` → `insertWorkIfAbsent` |
| POS webhook | `POST /webhook/benugin` (`server.js:7254`) | same lookup |

The tip path is the model to copy:

```js
s.getOrIgnore.run(date, daypart);          // INSERT OR IGNORE — idempotent
const sh = s.findShift.get(date, daypart); // always resolves to one row
policyForShift(sh);                        // pins the tip-out policy version
w.insertWorkIfAbsent.run({ shift_id, employee_id, role: position });
```

Because of `UNIQUE(date, daypart)` + `INSERT OR IGNORE`, concurrent clock-ins and tip
submissions **cannot** create duplicate shifts. The time clock must reuse this exact
sequence — that is what makes "clock-in and tip submission land on the same shift"
correct by construction rather than by a matching heuristic. **[C]**

### Position resolution **[C]**

`rolesForEmployee(emp)` (`server.js:~3948`) = `[emp.role, ...employee_roles.role]`,
deduped, `manager` filtered out; falls back to all roles if empty.
The tip form already validates the posted position against this list.

### Wage resolution **[C]**

```
WAGE_RATE_SQL = COALESCE(NULLIF(work.hourly_rate_cents,0),
                         NULLIF(employee_roles.wage_cents,0),
                         employees.hourly_rate_cents, 0)
```
Per-shift override → per-role rate → employee default. A time entry must not bypass this.

### Payroll & overtime **[C]**

- `aggregatePayroll(from,to)` reads `work` rows joined to employees, splits the period
  into **week 1 / week 2 at day seven** — those are the FLSA workweeks.
- `src/overtime.js`: settings `ot_enabled` (default **off**), `ot_threshold` (40),
  `ot_multiplier` (1.5). `employees.ot_exempt` excludes an individual.
- `overtimeFor()` returns **only the premium** (the extra ½), because straight time for
  every hour is already in `wage`. Off ⇒ never called ⇒ payroll is byte-identical to
  pre-OT behavior.
- Two-level control: **global toggle** (`/payroll/overtime`, `server.js:4370`) **and**
  **per-employee** `ot_exempt` ("Eligible for overtime" checkbox, `server.js:4094`).
- Finalization: `period_sends` + `markSent` record that a period was sent. **[C]**

### Portal **[C]**

Staff authenticate by **PIN → signed identity cookie** (`requirePortal`); routes under
`/portal` (`home, tips, earnings, specials, stock, out`). Cookie `zwin_portal` is a
stateless HMAC token, **TTL 45 minutes** (`TIPS_TTL`), re-checking `employees.active` on
every request. Managers are structurally excluded from the PIN portal
(`staffByPin` filters `role <> 'manager'`).

**Two identity systems that never join** **[C]**: `employees` (people you pay, PIN, no
back-office login) vs `users` (people who log in, no PIN). There is **no FK between them**.

**Permissions — the plan's biggest correction** **[C]**: there are only **two user roles,
`editor` and `viewer`**. There is no `owner` or `manager` user role (`manager` is an
*employees.role* value — a different system). `canWrite()` = `role !== 'viewer'`, enforced
for real by a middleware verb-block (viewer + non-GET → refuse), with page-level
`canWrite()` only hiding controls. `navAllowed()` gates 11 **areas** in `src/nav.js` which
double as the feature keys — a new `/timeclock` page must be assigned to one.

Portal earnings are bounded to `sh.status = 'emailed'` **[C]** — staff only see money for
shifts already sent. **Timesheets must not inherit that gate**, or an employee would see
an empty timesheet until payroll emails go out.

### Audit-log patterns available to reuse **[C]**

- `incident_events` — append-only timeline (actor, note, before/after) — **the model for
  correction history**.
- `submissions` — append-only tip submissions (resubmission keeps both rows).
- `cash_audit` — field-level before/after with actor.
- `adminNotify(kind,title,{body,href})` → back-office feed + push.
- Activity feed = a `UNION` over tables in `server.js:~480`.

### Migration convention **[C]**

No migration framework. Idempotent at boot: `CREATE TABLE IF NOT EXISTS`,
`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`. New tables
follow the incident-log IIFE pattern.

---

## 3. Recommended data model

Five new tables. **Deliberately not** `clock_in`/`clock_out` columns on `employees`.

### `time_entries` — one work session for one employee
```
id, employee_id, position (role slug), business_date,
shift_id            → shifts(id), nullable until matched
clock_in_at         UTC ISO, server-generated
clock_out_at        UTC ISO, nullable while active
status              active | on_break | complete | missing_punch | correction_pending | locked
source              portal | manager | import | webhook
raw_minutes         computed on close (clock_out - clock_in)
unpaid_break_min, paid_break_min
payable_minutes     raw - unpaid_break
notes
-- future scheduling (nullable, unused in v1)
scheduled_shift_id, scheduled_start_at, scheduled_end_at, scheduled_position
created_at, created_by, updated_at, updated_by
```
Indexes: `(employee_id, business_date)`, `(shift_id)`, `(status)`,
**partial unique** `(employee_id) WHERE status IN ('active','on_break')` ← the DB-level
guarantee against double clock-in. Uniqueness by constraint, not by application check.

### `time_breaks`
```
id, time_entry_id → time_entries(id) ON DELETE CASCADE,
start_at, end_at (nullable while running), paid (0/1),
raw_minutes, source (employee|manager|auto), created_by, created_at
```
Index `(time_entry_id)`; partial unique `(time_entry_id) WHERE end_at IS NULL` ← one open
break at a time.

### `timesheets` — one per employee per pay period
```
id, employee_id, period_start, period_end,
status  open | needs_attention | submitted | returned | approved | locked | transferred,
submitted_at, submitted_note, returned_at, returned_reason,
approved_by, approved_at,
transferred_at, payroll_stale (0/1),
regular_minutes, overtime_minutes, payable_minutes,  -- snapshot at approval
UNIQUE(employee_id, period_start)
```
Note: timesheet **days** are derived from `time_entries` by `business_date` — no separate
`timesheet_days` table in v1 (it would be a denormalized copy that can drift). Revisit
only if day-level notes/locking is needed. **[A]**

### `time_corrections` — request/decision record, append-only
```
id, time_entry_id (nullable — "forgot to clock in" has no entry yet),
break_id (nullable), employee_id, kind (missing_in|missing_out|wrong_in|wrong_out|
  break|missing_break|wrong_position|other),
field, original_value, proposed_value, reason,
requested_by, requested_at,
decision (pending|approved|rejected), decided_by, decided_at, decision_note
```

### `time_events` — append-only audit for everything
```
id, entity (time_entry|break|timesheet|correction), entity_id,
action, actor, at, before_json, after_json, reason
```
Every mutation writes one row. Nothing is ever silently overwritten.

**Settings** (existing `settings` table): `tc_enabled`, `tc_break_default_paid`,
`tc_missing_punch_hours`, `tc_business_day_cutoff` (default `04:00` for overnight).

---

## 4. Shift creation & matching rules

**Rule: the time clock never invents its own matching. It calls the same
`getOrIgnore(business_date, daypart)` the tip form calls.**

Business date = local date of the clock-in, except before the cutoff (default 04:00),
which belongs to the **previous** business date — this is how overnight work stays on one
day. **[A]** (cutoff configurable; default matches restaurant convention)

Daypart selection at clock-in:
1. If exactly one shift exists for the business date → join it.
2. If both café and dinner exist → employee picks (they're already picking a position).
3. If none exists → derive from clock-in time against a configurable café/dinner boundary,
   and **let the employee confirm**. Never silently guess. **[A]**

| Edge case | Resolution |
|---|---|
| Café + dinner same date | Two shift rows already (unique on `date+daypart`); entry points at one |
| Multiple services same type/date | **Not representable today** — `UNIQUE(date,daypart)` forbids it. v1 keeps that; a second dinner service would need a schema change. Flagged as a known limit. **[C]** |
| Overnight | Business-date cutoff assigns it to the starting day |
| Clock-in before tip submission | Clock-in creates shift; tip `getOrIgnore` finds it |
| Tip submission before clock-in | Tip created shift; clock-in finds it |
| Shift created manually | Both find it |
| Many employees, one service | One shift row, many `work` rows, many `time_entries` |
| Duplicate shifts | Impossible — DB constraint |

**Four distinct records, never conflated:**
`shifts` = the shared service · `time_entries` = one person's session ·
`server_sales`/`submissions` = tips · `timesheets` = the pay-period record.

### Writing hours back to `work`

On clock-out (and on any approved correction), the write would be
`w.insertWorkIfAbsent` then `w.setHours({shift_id, employee_id, hours})`.

⚠️ **Risk (highest in this plan):** `work.hours` is manager-entered today and feeds
payroll, the tip engine, metrics and Performance. Overwriting it from the clock could
silently change money.

Two hard contracts to respect **[C]**:
- **"Manager's numbers win."** `insertWorkIfAbsent` is `ON CONFLICT DO NOTHING` — it
  writes `hours = 0` and sets the role *only when the person isn't on the shift yet*.
  Every existing path (tips, POS webhook) honors this. A clock write path must too.
- **`work.hours` is decimal hours (REAL), one row per `(shift_id, employee_id)`** —
  not a punch series. Clock timestamps must aggregate into that single decimal, and
  hours stay the unit (money stays integer cents).

**Mitigation:** setting `tc_writes_hours`, default **off**. v1 runs parallel — the
timesheet shows clock hours *beside* manager hours — and write-back is enabled
deliberately in a later phase, never overwriting a manager value without an explicit
override + audit row. **[A]**

### Shift deletion **[C]**

`tip_submissions` has **no FK** and is deleted explicitly inside `deleteShiftTx`. Any new
per-shift child table must either carry a cascading FK or be added to that transaction —
otherwise deleting a shift orphans time entries. `time_entries.shift_id` is nullable, so
the safer choice is **`ON DELETE SET NULL`** (keep the punch record, drop the link) rather
than cascade-deleting someone's worked time. **[A]**

---

## 5. Position-selection rules

- 0 allowed positions → block clock-in with "ask your manager to assign your position".
- 1 → auto-select, show it, no prompt.
- 2+ → **must** choose before clock-in; only their own positions listed
  (`rolesForEmployee`), server-validated exactly like the tip form does today.
- Position is stored on the entry and **never re-asked at clock-out**.
- Manager may correct it later → `time_corrections` + `time_events` (reason required).
- Two positions in one day = two separate time entries.
- Later, scheduling can preselect via `scheduled_position` (nullable now).

---

## 6. Clock state machine

```
        ┌────────── clock_in ──────────┐
clocked_out                         active ──── start_break ───→ on_break
        ↑                             │  ↑                          │
        └──── clock_out ──────────────┘  └──── end_break ───────────┘
                     │
                     ↓
                 complete ──(auto, >N hrs open)──→ missing_punch
                     │                                   │
              correction_pending ←──── request ──────────┘
                     │
                  locked (timesheet approved)
```

Server-generated timestamps only (`datetime('now')`) — the device clock is never trusted.
Guards, enforced by DB constraint where possible:
no second active entry · no break without an active entry · no second open break ·
no clock-out without an active entry · no overlapping entries for one employee.

Screens: **Clocked out** (position, service, Clock in) · **Working** (start, live elapsed,
position, service, Start break, Clock out) · **On break** (break start, live duration, End
break) · **Missing punch** (what's missing, add/request, explanation).

---

## 7. Correction workflow

| Entry state | Employee may | Manager may |
|---|---|---|
| open / unsubmitted | edit directly (audited) | edit directly + reason |
| submitted / approved / transferred | **request** correction only | edit + reason; may reopen |

Every correction retains original value, proposed value, reason, requested-by/at,
decided-by/at, decision note. Approval applies the change **and** writes `time_events`.
Original punches are never overwritten in place.

---

## 8. Employee timesheet workflow

`/portal/timesheet` — defaults to current pay period, past periods viewable.
Per day: date · service · position · in · breaks · out · regular · OT · payable · status.
Period totals: regular, OT, paid/unpaid break, payable, estimated gross **[A]** (label it
an estimate — tips and adjustments are separate).

**Statuses (deduped to seven):** `open` · `needs_attention` (missing punch or unresolved
correction) · `submitted` · `returned` · `approved` · `locked` · `transferred`.

Submission blocked while: an entry is still active, a punch is missing, a break is open,
entries overlap, corrections are unresolved, or a duration is implausible.
Requires an explicit accuracy confirmation; stores employee, period, timestamp,
confirmation, optional note. After submitting: no silent edits — request corrections, or
manager returns it for resubmission.

---

## 9. Owner/manager surfaces

**`/timeclock`** — who is working now, and what needs attention: currently in · on break ·
missing clock-outs · open breaks · overlaps · pending corrections · timesheets awaiting
submission · awaiting approval · approaching OT (only when OT is on).
Compact filters behind one control (the Invoices/Incidents filter-sheet pattern), not a
wall of pills.

**`/payroll/timesheets`** — per-period employee ledger: employee · regular · OT · payable ·
missing punches · corrections · submitted? · approved? · transferred? · estimated wages.
Actions: open, review by day, add/correct punch, add/correct break, correct position,
approve/reject corrections, return, approve, bulk-approve clean sheets, lock, reopen
(reason required).

**Permission model — decided by the audit, not assumed** **[C]**: there is **no manager
user role**. Zwin has exactly `editor` and `viewer`. So timesheet approval = **any
`editor`** (i.e. `canWrite()`), enforced by the existing middleware verb-block. If you
want approval restricted to fewer people than "anyone who can edit", that is a **new
role tier** and a separate decision — I would not invent one inside this feature.
Add the pages to an existing nav **area** (`payroll` for the ledger, `staff` or `shifts`
for the live view) so feature-gating works with no new plumbing. **[A]**

---

## 10. Payroll transfer

Approved timesheet → snapshot regular/OT/payable minutes onto the timesheet row →
supply hours to `aggregatePayroll`. Approved timesheets become the source of truth for
worked hours **once transferred**.

Four visible states, never blurred:
`approved` → `transferred` → `payroll_stale` (approved sheet changed after transfer) →
`finalized` (`period_sends`).

Reopen flow: reopen → reason → correct → re-approve → mark `payroll_stale` → regenerate.
Payroll is **never** silently modified.

---

## 11. Overtime-toggle integration

The existing control stays exactly as-is, both levels:

- **Global** `ot_enabled` (`/payroll/overtime`) — default off.
- **Per-employee** `employees.ot_exempt` — "Eligible for overtime" checkbox.

Behavior with the time clock:
- OT **off** → payroll unchanged, byte-for-byte. The clock still shows accurate total
  hours; it just doesn't split them for pay.
- OT **on** → eligible employees' hours over `ot_threshold` per **workweek** get the
  premium via the existing `overtimeFor()`; exempt employees skip it.
- The clock **never** changes eligibility from hours worked.
- Owner keeps the ability to flip it before finalizing.

Time entries store minutes; the OT split stays a payroll-time calculation so a toggle
change before finalizing re-derives correctly. Raw punches are never destroyed.

---

## 12. Payable-hours model

Store all of: raw worked minutes · unpaid break · paid break · payable minutes ·
regular minutes · OT minutes · final payroll minutes after overrides. Rounding rule
should be an explicit setting (default: none / exact minutes). **[A]**
No universal OT policy hard-coded; daily-OT and location rules remain future-friendly.

---

## 13. Migration & historical data

- New tables only; **no changes to `shifts`, `work`, `server_sales`, `employees`** beyond
  possible additive nullable columns.
- No backfill of historical punches — history has no clock data, and inventing it would be
  a lie. Timesheets exist only from go-live forward.
- Manager-entered `work.hours` remain authoritative for past periods.
- Feature flag `tc_enabled` (default off) so the clock can ship dark and be switched on.

---

## 14. Risks

1. **`work.hours` write-back** (highest) — mitigated by default-off + no silent overwrite,
   respecting the `insertWorkIfAbsent` "manager's numbers win" contract.
2. **⚠️ The 45-minute portal session vs an 8-hour shift** **[C]** — `zwin_portal` expires
   after 45 min (`TIPS_TTL`), which is fine for submitting tips but **breaks a time clock**:
   a staffer who clocks in at 5pm cannot clock out at 11pm without re-entering their PIN.
   Options: (a) re-enter PIN at clock-out — most auditable, arguably *correct* for a punch;
   (b) longer TTL for clock routes only; (c) sliding refresh while an entry is active.
   **Recommend (a) + (c)**: PIN is the signature on a punch, and the token refreshes while
   they're on the clock. **This needs your decision — it changes the flow.** **[A]**
3. **Multiple same-type services per date** — impossible under `UNIQUE(date,daypart)`;
   accept as a v1 limit, revisit before scheduling.
4. **Business-date cutoff** for overnight — must be explicit, configurable, and shown.
5. **Portal earnings gate** — existing earnings only show `status='emailed'` shifts;
   timesheets must **not** copy that or they'd read empty all period. **[C]**
6. **No payroll snapshot exists today** — `period_sends` records only *that* a period was
   sent (count + timestamp), **not the hours/wages**. **[C]** So "transferred" and
   "payroll needs recalculation" are genuinely new state, not derivable from history.
7. **Two wage resolvers must stay in sync** — `db.js shiftInputs()` and
   `reports.js WAGE_RATE_SQL`, pinned by `test/engine.test.js`; they already diverge on
   salaried staff (SQL ignores `pay_type`). Don't add a third. **[C]**
8. **Pay-period boundary** — an entry spanning midnight of the last day belongs to the
   period containing its **business date**. **[A]**
9. **Terminated mid-period** — `active` is re-checked every portal request, so
   deactivating someone instantly kills clock access; their open period must still be
   payable and visible to managers. **[C]**
10. **Clock drift / offline** — server timestamps only; the PWA must not lose a punch on a
    failed request.

---

## 15. Phased implementation

| Phase | Scope | Ships |
|---|---|---|
| **2** | Data model + settings; tables, indexes, constraints, audit hooks. No UI. | Nothing user-visible |
| **3** | Portal clock: in/out/breaks, position rules, shift matching (read-only vs `work.hours`) | Staff can clock |
| **4** | Owner `/timeclock` live view + manual punch/correction with audit | Managers can fix |
| **5** | Timesheets: employee view, validation, submission | Employees submit |
| **6** | Manager review/approve/return/lock + corrections queue | Approval loop |
| **7** | Payroll transfer + stale/finalized states + OT integration | Hours → payroll |
| **8** | Optional `work.hours` write-back, enabled deliberately | Single source of truth |
| later | Scheduling; then geofencing | — |

Each phase: tests in the existing spawn-server pattern (unique port), full suite green
before the next.

---

## Open questions for Malek

1. **⚠️ Clock-out re-authentication.** The portal session dies after 45 minutes, so
   someone clocking out at the end of a shift will be signed out. Re-enter PIN to punch
   (my recommendation — the PIN *is* the signature), or keep them signed in all shift?
2. **Café/dinner boundary time** for suggesting the service at clock-in?
3. **Business-day cutoff** — is 04:00 right for overnight work?
4. **Breaks paid or unpaid by default**, and do you want that choice in v1 at all?
5. **Should the clock eventually own `work.hours`**, or stay a parallel record you
   reconcile? (Recommend: parallel first, write-back later.)
6. **Rounding** — exact minutes, or round punches to the nearest 5/15?
7. ~~Who may approve timesheets~~ — **answered by the audit**: only `editor`/`viewer`
   exist, so approval = any editor unless you want a brand-new role tier.

---

## Appendix — confirmed invariants the build must not break **[C]**

- One shift row per `(date, daypart)`; every create-or-locate goes through
  `getOrIgnore` + `findShift`.
- `work` PK `(shift_id, employee_id)`; `hours` is one decimal, not a punch series.
- `insertWorkIfAbsent` never clobbers manager-entered hours/role.
- Money in integer cents; hours in decimal hours; rounding only at the totals layer.
- Wage order: per-shift override → `employee_roles.wage_cents` → employee default;
  `0` means "not set"; salaried excluded in the JS resolver.
- OT adds **only the premium** on top of straight time; global off *or* `ot_exempt`
  must yield byte-identical payroll; OT is weekly, split at `from + 7`, using the FLSA
  weighted-average rate.
- Shift status is only `open → emailed`; `closed_at` is an orthogonal marker.
- Every `/portal` route must call `requirePortal()` — enforced by `test/auth.test.js`.
- `tip_submissions` is append-only with no FK and is cleaned up in `deleteShiftTx`.
