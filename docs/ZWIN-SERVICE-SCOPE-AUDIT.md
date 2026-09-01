# ZWIN — Scoping Timesheets, and tying a Schedule to its Time Clock

**Status: AUDIT ONLY. Nothing here is built.** Requested 2026-09-01.

Reported: picking Evening Service on Time Clock shows the right people on
*Today*, but clicking *Timesheets* shows everyone from both services under one
list. Wanted: a time clock's timesheets show only that clock's people — and show
them **even when they have not clocked in** for the dates on screen, because
they belong to that clock. Plus a link between a schedule and its time clock in
both directions, and a way to connect one that has neither.

Everything below marked *measured* was run against `data.db` or read out of the
route. Everything marked *inferred* was not.

---

## 1. Why Timesheets shows everyone — three causes, not one

**(a) The tab bar throws the scope away.** *Measured — `server.js:23668`.*

```js
function tcTabs(active) {
  const links = [['/timeclock', 'Today'], ['/payroll/timesheets', 'Timesheets']]
```

Both hrefs are hardcoded with no `?svc=`. Standing on
`/timeclock?svc=dinner` and clicking *Timesheets* navigates to a bare
`/payroll/timesheets`. The scope is not lost in the query — it is never carried.

**(b) Timesheets has no concept of a service at all.** *Measured.*
`svcParam(req)` is called in exactly two routes in the whole file:
`/schedule` (19822) and `/timeclock` (21603). The timesheets ledger (23702) and
the per-person sheet (24442) never read `svc`, never call `employeesFor`, and
have no service filter in their UI. So even a hand-typed `?svc=dinner` would do
nothing there.

**(c) The roster is built from a union of everybody.** *Measured — 23727.*

```js
const staffIds = new Set([
  ...q.allEmployees.all().map((e) => e.id),   // every active employee
  ...TC.gridPeople(period.start, period.end),
  ...TC.sheetPeople(period.start),
  ...shiftOnly.keys(),
]);
```

`/timeclock` already fixed exactly this and Timesheets never got the same
treatment. The working version is two lines (21665):

```js
const onSvc = fSvc ? new Set(SERVICES.employeesFor(fSvc)) : null;
const staff = q.allEmployees.all().filter((e) => !onSvc || onSvc.has(e.id));
```

`/schedule` uses the identical shape at 19901. **The pattern exists twice and
needs applying a third time.** That part is genuinely small.

---

## 2. The finding that matters most: scoping alone will not fix this

*Measured, `data.db`:*

| | |
|---|---|
| active employees | 12 |
| assigned to `cafe` (Day) | **12** |
| assigned to `dinner` (Evening) | **12** |
| assigned to nothing | 0 |

**Every person is on both services.** So once the list is scoped by membership,
Evening Service will still show all twelve — because as far as the data is
concerned, all twelve work evenings. The bug would look unfixed, and the report
would be fair.

This is almost certainly an artefact of `addToAll` seeding, not a decision
anyone made. What worked history suggests instead (*measured*, `work` joined
through `shifts.daypart`):

| Person | Café shifts | Dinner shifts |
|---|---|---|
| Hendy | 58 | 0 |
| Stephanie | 34 | 0 |
| Sebastian | 25 | 0 |
| Eunji | 10 | 0 |
| Esther | 63 | 2 |
| Kevin | 61 | 1 |
| Joseph | 60 | 1 |
| Evendi | 49 | 1 |
| Sandra Moyer | 44 | 1 |
| Ingri | 43 | 1 |
| Arabella | 2 | 1 |

Four people have never worked an evening. The rest have one or two against
forty to sixty days. Whether those ones and twos are real evening work or
mis-stamped café shifts is **not something the data can settle** — and I am not
going to guess who works nights and quietly write it into the table.

**This needs a decision from you (Q1).**

---

## 3. Schedule ↔ Time Clock are already the same object

You asked for a way to connect a schedule to a time clock, and for a prompt when
one is unconnected. The honest finding is that **they cannot be disconnected,
because they are not two things.**

One row in `services` — `cafe`, named "Day Service" — is viewed two ways:

| View | URL |
|---|---|
| its board | `/schedule?svc=cafe` |
| its clock | `/timeclock?svc=cafe` |

There is no schedule id, no clock id, and no join table between them. Creating a
schedule creates the service; its time clock is the same service seen from the
other page. So the cross-link buttons you want are trivial and exact — the
target is the URL you are already on with the path swapped.

The one real "unconnected" state is the `has_clock` flag (*measured*,
`services.js:293, 405`): a service can have its time clock switched **off**, and
`withClock()` filters those out of the clock picker. That is a schedule with no
clock — deliberately, for something planned but never punched. Both your
services currently have `has_clock = 1`, so **nothing is disconnected today.**

So the "connect one" flow has exactly one truthful use: a schedule whose clock is
switched off gets, on its board, *"This schedule has no time clock — turn one
on"*. That is a real and useful control, and much smaller than the brief assumed.

---

## 4. The payroll line I should not cross without you saying so

*Measured — `timesheets` schema:*

```sql
UNIQUE(employee_id, period_start)
```

**One timesheet per person per period, covering every service they worked.**
`status`, `submitted_at`, `approved_at`, `locked_at` and `transfer_state` are all
single columns on that one row. Overtime is weekly across *all* hours
(`aggregatePayroll`), not per service.

That splits cleanly into a safe half and an unsafe half:

- **Scoping who appears in the list — safe.** It changes who you look at, not
  what anything is worth.
- **Scoping what is inside a person's sheet — not safe.** Someone who worked both
  services has one sheet and one Approve button. Showing them "Evening only"
  while that button approves the whole period is a lie that pays a real person
  wrong, and splitting the row would break approval, transfer and weekly OT all
  at once.

**Recommendation:** the scoped list filters the roster; the sheet you open stays
whole, with a visible marker when a person also has hours on another service —
something like *"also worked 12.5h on Day Service this period"*, linking across.
You keep the filtered view you asked for and never approve half a person.

**This needs a decision from you (Q3).**

---

## 5. Same bug, other pages

*Measured — service-aware references in the first 60 lines of each route:*

| Route | Service-aware | Note |
|---|---|---|
| `/timeclock` | yes | already scoped |
| `/schedule` | yes | already scoped |
| `/timeclock/settings` | yes | per-clock, done earlier |
| `/timeclock/export` | partial | takes a filter, not the picker's scope |
| `/payroll/timesheets` | **no** | this report |
| `/payroll/timesheets/:id` | **no** | including its prev/next stepping |
| `/timeclock/reports` | **no** | same class |
| `/timeclock/requests` | **no** | same class |

Fixing only the two Timesheets routes leaves Reports and Requests behaving the
old way from the same tab bar. They should go in the same change.

---

## 6. Zero-activity members

Today the ledger drops anybody with nothing (*measured*, 23742):

```js
if (!entries.length && !corrections.length && !extra.length) return null;
```

You want the opposite when scoped: a member of Evening Service appears at 0.00
even with no punches, because they belong to that clock. That is right for a
roster view and it is a real change to a payroll list — it makes the list longer
and adds rows with nothing to approve. It should apply **only to the scoped
view**, leaving the unscoped ledger as it is. **(Q2.)**

---

## 7. How I would build it

Each step ships alone and is useful alone.

1. **Carry the scope.** `tcTabs(active, svc)` appends `?svc=` to both tabs, and
   the same for Reports and Requests. Nothing else changes; the pages ignore it
   until step 2. *Small.*
2. **Scope the ledger.** `svcParam` in `/payroll/timesheets`, the `onSvc` filter
   copied from 21665, a "Day Service ▾" control in the existing filter bar, and
   `?svc=all` for the everyone view. *Small.*
3. **Zero-activity members** in the scoped view only (Q2).
4. **Scope the sheet's context** — prev/next steps through the scoped roster, the
   sheet itself stays whole, plus the cross-service marker from §4 (Q3).
5. **Cross-links.** *View time clock* on the board, *View schedule* on the clock,
   built from the current `svc`. Hidden when `has_clock = 0`, replaced there by
   *"This schedule has no time clock — turn one on."* (§3)
6. **Membership correction** (Q1) — whatever you decide, plus a line on the
   Services page showing how many people are on each, so this is visible rather
   than buried in Staff.
7. **Reports and Requests** scoped the same way.

**Tests, per the same discipline as the last fix:** the ledger scoped to a
service excludes a non-member *asserted against a real request*, not by reading
source; a member with no punches appears at 0.00; the tab bar preserves `svc`
across all four pages; a person with hours in both services still has exactly one
sheet, and approving it still transfers every hour — asserted by comparing
`aggregatePayroll` totals before and after the change on a copy of the database.

---

## 8. Scalability notes you asked for

- **`employeesFor(slug)` runs a fresh `db.prepare` on every call** (`services.js:518`)
  — it is the one statement in that file not hoisted. At 12 people it is
  invisible; it is called per request per page and should be prepared once.
  *Measured; the fix is one line.*
- **`services.location_id` already exists and is NULL everywhere.** Multi-location
  later means grouping the picker by it, not a migration. Worth not designing it
  away.
- **The picker (`serviceCards`) is already shared** by Schedule and Time Clock
  and takes an `only` list. Reports, Requests and Timesheets can adopt it as-is,
  so a fourth and fifth service cost nothing.
- **`time_entries` carries both `shift_id` and `daypart`** — the one place two
  fields answer the same question, flagged in the services audit. Currently zero
  disagreements. A scoped ledger reads `daypart`, so a drift would now show as a
  person missing from a list rather than a wrong total. Cheap insurance: a check
  that the two agree, run where the nightly close already runs.
- **Nothing here touches the tip-out engine.** `policy_versions.daypart` and
  `shifts.policy_id` are untouched by every step above. *Inferred from the call
  sites, not from a payroll re-run — that re-run is listed in step 2's tests.*

---

## 9. What I need from you

1. **Who actually works evenings?** Options: (a) you tick them on the Staff page
   and I ship the scoping now; (b) I seed Evening from history — everyone with a
   dinner shift, which is 7 of 12 — and you correct it; (c) I seed Evening from
   the four with zero dinner history *excluded*, same thing stated the other way.
   I recommend (a) with the scoping shipped first, so you are ticking against a
   screen that already filters and can see the effect immediately.
2. **Zero-activity members at 0.00 in the scoped list — confirm**, and confirm it
   should not change the unscoped ledger.
3. **One whole sheet per person per period, with a cross-service marker —
   confirm.** The alternative splits approval and I would want that in writing.
4. **Should `?svc=all` stay reachable** as an explicit "everyone" view on
   Timesheets, or should the scoped view be the only one?
