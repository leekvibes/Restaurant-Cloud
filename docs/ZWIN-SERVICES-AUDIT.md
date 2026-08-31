# ZWIN — Named Services (Day / Evening / and more)

**Status: AUDIT ONLY. Nothing here is built.** Requested 2026-08-30.

The owner wants Connecteam-style organisation — click Schedule and pick
"Day Service" or "Evening Service" before landing in the board, same for Time
Clock — with employees assigned to services, portal pills for people on more
than one, and strong protection against a double landing entirely on the wrong
service. The brief he pasted also insists there must be ONE canonical service
identity underneath, not competing ids.

That last requirement is the right one, and this audit's headline is that it is
**already satisfied** — and that the cheapest safe route is much smaller than
the brief assumes.

---

## 1. The finding that changes the plan

**A canonical service identity already exists: `shifts.id`, which is
`UNIQUE(date, daypart)`.**

Everything that carries money already points at it:

| Table | How it names its service |
|---|---|
| `work` (payable hours) | `shift_id` |
| `server_sales` | `shift_id` |
| `tip_submissions` | `shift_id` |
| `cash_recon` | `shift_id` + `daypart` |
| `time_entries` | `shift_id` **and** `daypart` |
| `scheduled_shifts` | `daypart` (a plan — no shift exists yet) |
| `published_schedule` | `daypart` (same) |
| `policy_versions` | `daypart` (tip-out rules per service) |

So the nightmare in the brief — *"schedule says Day, time clock says Evening,
shift says Cafe, tip submission says Dinner"* — cannot happen for tips, sales
or hours today, because those three do not independently describe a service.
They inherit it from the shift.

**The one real redundancy is `time_entries`, which carries both `shift_id` and
`daypart`.** Those two can drift. Measured on the dev database: 6 entries, 0
disagreements, 0 unlinked. Small today; it is still the only place where two
fields answer the same question, and it is the one to tighten.

### The second finding: the migration is far smaller than it looks

`daypart` appears **306 times across 14 files**. But splitting them:

- **278** just *pass the value through* — they read it, store it, group by it,
  render it. They do not care what the value is.
- **28** hardcode the literals `'cafe'` / `'dinner'`.

**If the stored values stay as they are, 278 sites keep working untouched.**
Only 28 need attention, spread thinly: server.js (10), backfill.js (4),
email.js (3), policy.js (2), seed.js (2), and one each in scheduler.js,
timeclock.js, views.js, search.js.

That is the argument for the design below.

---

## 2. Recommended architecture

**Make `daypart` the foreign key. Do not introduce a parallel `service_id`.**

```
services
  slug        TEXT PRIMARY KEY     -- 'cafe', 'dinner', later 'brunch', 'events'
  name        TEXT NOT NULL        -- "Day Service"  (what everyone SEES)
  sort        INTEGER NOT NULL
  active      INTEGER NOT NULL DEFAULT 1
  starts_min  INTEGER              -- optional window, for warnings only
  ends_min    INTEGER
  location_id INTEGER              -- NULL today; the column that keeps
                                   -- multi-location from being painful later
```

Seeded with exactly two rows: `cafe` → "Day Service", `dinner` → "Evening
Service". The owner renames them in the UI; the slugs never change.

Why this beats adding `service_id`:

- **Zero data migration.** Every existing row in all 7 tables is already
  correct. No backfill, no dual-write window, no chance of a half-migrated
  payroll figure.
- **278 call sites keep working.** The 28 literal comparisons become lookups.
- **`shifts UNIQUE(date, daypart)` survives unchanged** and keeps meaning "one
  service per kind per day", which is the rule the nightly close is built on.
- **Tip-out policy versioning survives unchanged.** `policy_versions.daypart`
  keeps pinning café and dinner to different rules — confirmed present in the
  data: 4 café versions, 2 dinner.
- **A new service is one INSERT.** "Brunch" gets slug `brunch`, and everything
  that groups by daypart picks it up.

The cost: slugs stay lowercase internal keys forever, and a service cannot be
deleted once used (it must be deactivated). Both are correct anyway — a deleted
service would orphan history.

### Employee assignment

```
employee_services
  employee_id  INTEGER NOT NULL
  service_slug TEXT    NOT NULL
  active       INTEGER NOT NULL DEFAULT 1
  UNIQUE(employee_id, service_slug)
```

Relational, as the brief asks. **No rows means every service** — the same rule
Phase 6 uses for availability ("no rows means available"), so nothing breaks on
day one and nobody has to be bulk-assigned before the feature works.

That default is a decision the owner should confirm; the alternative ("no rows
means none") would lock every employee out of everything the moment it ships.

---

## 3. What happens to `daypart`

It stays, with its current values, in all 7 tables. It is promoted from "a text
convention" to "a foreign key into `services`". Nothing is renamed and no giant
search-and-replace happens — the brief explicitly forbids one, and this design
removes the need.

The 28 literal sites get triaged:

- `timeclock.js:464` `suggestDaypart()` — currently `hour >= dinnerFrom ? 'dinner' : 'cafe'`.
  Becomes a lookup against `services.starts_min/ends_min`. **This is the only
  place the app guesses a service**, and it is now only a default, never a
  decision (the owner already made service selection mandatory at clock-in).
- `policy.js`, `email.js`, `views.js`, `search.js` — display and routing; become
  `services.name` lookups.
- `backfill.js`, `seed.js` — historical importers; leave alone, they describe
  data that already exists.

---

## 4. Schedule and Time Clock: the workspace layer

Both get a **selection screen** in front of the existing UI. Neither engine
changes.

- `/schedule` → cards, one per active service, → `/schedule?svc=cafe`
- `/timeclock` → the same, → `/timeclock?svc=cafe`
- One service configured, or a manager with access to one? Skip the screen and
  go straight in. A chooser with one option is a click that teaches nothing.
- The scope is a **filter on the existing queries**, not a new engine. Same
  board, same drawer, same Issues, same timesheets — with `WHERE daypart = ?`.

This is exactly the Connecteam organisation the owner asked for, and it is a
view, not a system.

---

## 5. Switch Service — and the proof it is safe

The double is the real problem: clock in 9am as Day, forget to clock out, and
13 hours land on Day.

**Design:** while clocked in, an employee eligible for another service sees
"Switch to Evening Service". It closes the current segment and opens the next
**at the same timestamp**, against the other service's shift.

**Verified empirically, not assumed.** The overlap guard is
`clock_in_at < @end AND clock_out_at > @start` — strict inequalities, a
half-open `[start, end)` interval. Two segments that touch at 16:30 were
inserted and the guard was run against them:

```
does the app consider them overlapping?  NO — touching segments are legal
total paid minutes across both:          780  (13h, nothing lost or doubled)
```

So Switch Service needs **no change to the overlap rule**. That was the single
biggest risk to this feature and it is not a risk.

**What must NOT happen:** no automatic split of a punch that already exists.
The invariant is "the punch is the hours"; inventing a boundary invents hours.
A crossover gets *flagged*, and a manager splits it with one click, confirmed.

**Detection, which is missing today:** `tc_long_shift` alerts at 16 hours. A
9am–11pm double is 14 hours and passes silently, stamped Day. A service-window
check would catch it at the moment it crosses, which is hours earlier and while
the person is still in the building.

---

## 6. Tips and submissions — the gap splitting does not close

Splitting a punch does not split tips. `tip_submissions` and `server_sales`
attach to a `shift_id` directly.

Protection, in order:
1. Default to the service of the employee's **current open punch**.
2. Else the service of their **scheduled shift** that day.
3. Else ask — offering only services they are assigned to.
4. Never render a service they are not assigned to, and **re-check
   server-side**. The brief is right that hiding a button is not authorisation.

---

## 7. Risks to existing behaviour

| Risk | Severity | Note |
|---|---|---|
| `shifts UNIQUE(date, daypart)` | **none** under this design | unchanged |
| Tip-out policy per service | **none** | `policy_versions.daypart` untouched |
| Payroll totals | **none** | reads `work.hours`, never a daypart |
| Overtime | **none** | weekly from worked time |
| `time_entries.daypart` vs `shift_id` drift | **low, real** | 0 today; add a check |
| Portal history | **low** | reads shift_id |
| `suggestDaypart` hardcodes 16:00 | **medium** | the one guess; becomes a lookup |
| Employees locked out on day one | **high if defaulted wrong** | "no rows = all services" avoids it |
| Manager cover for one night | **medium** | needs a deliberate answer, see §9 |

---

## 8. Implementation order — each step shippable alone

1. **`services` table + rename in UI.** Two seeded rows. Nothing else changes.
   Everything still says café/dinner internally; the owner sees his names.
2. **`employee_services` + Staff assignment UI.** No enforcement yet — just
   recorded. *This alone solves the reported problem once step 3 lands.*
3. **Enforce at clock-in.** Only offer services the person is assigned to,
   checked server-side. **This is the fix for "he shouldn't even have the
   option."**
4. **Portal pills** on Schedule for multi-service employees.
5. **Admin workspace layer** on Schedule and Time Clock.
6. **Crossover detection** — flag a punch whose span crosses a service window.
7. **Switch Service** in the portal.
8. **Submission defaulting** for tips and sales.

Steps 2–3 are small and solve the actual complaint. Steps 5–7 are the bigger
build. There is no reason to do them in one change.

---

## 9. Decisions the owner still has to make

1. **Default for an employee with no service rows** — every service
   (recommended, nothing breaks on day one) or none?
2. **Block or warn** when someone picks a service they are not assigned to?
   He said "shouldn't even have the option", which reads as block — but a
   one-night cover then needs an explicit path (§9.3).
3. **Cover mechanism** — a temporary dated assignment, or a manager override at
   the moment of clock-in?
4. **Overlapping services.** Café staff stay until 5:00–5:30 and dinner starts
   at 4:00. There is no clean boundary, so crossover detection must warn rather
   than decide. Confirm that.
5. **Does a Switch Service segment need manager approval**, or is it self-serve?

---

## 10. Tests required before each step is considered safe

- **Step 1:** every existing shift, policy version and time entry resolves to a
  service; payroll totals for a closed period are byte-identical before/after.
- **Step 2:** an employee with no rows is eligible everywhere.
- **Step 3:** a POST naming a service the employee is not assigned to is
  refused **server-side**, asserted with a real signed-in portal session — not
  by checking the button is missing.
- **Step 5:** the scoped board shows only that service's shifts, and Publish
  scoped to one service does not publish the other.
- **Step 6:** a 9am–11pm punch is flagged; a 9am–4pm punch is not.
- **Step 7:** switching produces two segments, touching, summing to the
  original span — no lost minute, no doubled minute. Approval/transfer state on
  one segment does not leak to the other.
- **Step 8:** a tip submission cannot name a service the employee is not
  assigned to, asserted server-side.
- **Throughout:** `time_entries.daypart` never disagrees with its shift's.
