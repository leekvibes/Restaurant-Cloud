# Staff redesign — dependency audit and implementation plan

**Status: PLAN ONLY. Nothing has been built.** Written 2026-08-31.
Baseline before any change: **1287 tests, 0 failures.**

The brief: make the Staff area a modern employee-management profile system,
without touching payroll, wage history, service assignment, time clock,
tip-outs, permissions, the portal, or historical data.

This document is the audit that has to come first, and the plan that follows
from it. Where the design would require a behaviour change, it is flagged for
approval rather than built.

---

## PART ONE — THE AUDIT

### 1. The surface being redesigned

Fourteen routes. Everything under `/employees` and `/positions`.

| Route | What it does |
|---|---|
| `GET /employees` | The roster |
| `POST /employees` | Create |
| `GET /employees/:id/edit` | The one big form |
| `POST /employees/:id` | Update identity, pay type, default wage, OT eligibility |
| `POST /employees/:id/services` | Which schedules they are on |
| `POST /employees/:id/roles` | Add a position + wage (general or per-schedule) |
| `POST /employees/:id/roles/delete` | Remove a position, or one schedule override |
| `POST /employees/:id/deactivate` | `active = 0` |
| `POST /employees/:id/reactivate` | `active = 1` |
| `GET/POST /positions*` (5 routes) | The jobs themselves |

Both pages are ~48KB of rendered HTML. The edit page is two `card form grid`
blocks and a table — a long scroll with no hierarchy, which is the thing the
brief is reacting to.

### 2. What the rest of the app needs from an employee

Nine modules read employee rows. What each one actually uses:

| Module | Fields it depends on |
|---|---|
| `reports.js` (payroll) | `name`, `email`, `role`, `hourly_rate_cents` |
| `engine.js` (tip-out) | `name`, `role` |
| `timeclock.js` | `name`, `role`, `active`, `ot_exempt` |
| `scheduler.js` | `name`, `role`, `active` |
| `metrics.js` (Performance) | `name`, `role`, `pay_type` |
| `overtime.js` | `name` |
| `portal.js` | `name` |
| `email.js` (summaries) | `name`, `email`, `role` |
| `services.js`, `wages.js` | `id`, `active`, `hourly_rate_cents`, `pay_type` |

**Consequence:** the columns are a public API with nine consumers. The redesign
may re-arrange how they are *presented* and *edited*; it must not rename,
retype or drop one.

### 3. The data underneath

**21 tables key on `employee_id`.** Live counts in dev:

`work` 459 · `tip_submissions` 98 · `server_sales` 95 · `employee_services` 24 ·
`wage_history` 18 · `portal_events` 23 · `time_entries` 6 · `employee_roles` 5 ·
`time_breaks` 2 · `portal_seen` 2 · `time_corrections` 1 · and ten more at zero
(schedules, availability, time off, timesheets, approvals, transfers, push).

**Nine of them CASCADE DELETE on `employees`:**
`work`, `server_sales`, `employee_roles`, `time_entries`, `timesheets`,
`scheduled_shifts`, `availability_rules`, `time_off_requests`,
`schedule_template_rows`.

> **This is the most dangerous fact in the area.** Deleting one employee row
> would silently take 459 work rows, every punch, every sale and every schedule
> with it. The app is safe today only because **nothing ever deletes an
> employee** — deactivation writes `active = 0`. The redesign must not
> introduce a delete, and "Remove employee" must never appear in the Options
> menu the brief describes.

### 4. Permissions — and the biggest risk in this project

There are **no route-level permission checks** on the core staff routes. They
are protected by **path-based middleware** (`server.js` ~line 593):

```
featureFor(req.path) → canSee(user, key) → 403
```

Verified resolution:

| Path | Area |
|---|---|
| `/employees` | `staff` |
| `/employees/1/edit` | `staff` |
| `/employees/1/roles` | `staff` |
| `/positions` | `settings` |
| **`/staff/1`** | **null — UNGATED** |
| **`/staff/1/pay`** | **null — UNGATED** |

**A redesign that moves the profile to a nicer URL like `/staff/:id` would
silently make it readable by every signed-in account, including view-only
ones.** No error, no test failure — wages and PINs simply become visible to
people who should not see them.

There is precedent: the existing audit records that `navAllowed('/staff-portal')`
returned true for everybody for a long time, for exactly this reason.

**Therefore: every new page stays under `/employees/`.** Any new path must be
added to `nav.js`'s mapping in the same commit, with a test that a
staff-less account is refused.

Also live: viewers are blocked from every non-GET request globally.

### 5. Business logic that must survive untouched

Each of these is already load-bearing and already tested:

- **Wage resolution order** — recorded rate on the shift → wage in force on
  that date for (person, role, schedule) → most specific wins, then most
  recent → current role wage → default rate.
- **The three effective-date modes** — today / a date / all shifts. Only the
  third rewrites worked shifts, and it reports how many first.
- **Service membership is explicit** — a row, no fallback. It governs which
  board someone appears on and which clock they can punch into, enforced
  server-side on the POST.
- **Tip-out pins a policy version** per closed service.
- **Salaried people have no hourly wage**; OT eligibility is its own column.
- **PIN rules** — exactly 4 digits or none; duplicates refused, naming who
  holds it; digits never rendered.
- **Deactivation preserves everything** and restores only future shifts.

### 6. What is already verified about payroll and tips

An earlier audit ran payroll and the tip-out engine at a pre-change commit and
at HEAD against byte-identical copies of the dev database. Tip-out was
identical across all 76 services; payroll differed by 25 cents on one person
from one stale wage-history row, fully explained. **That comparison is the
regression harness for this project too** — it is re-runnable and is the only
way to prove "payroll results before vs after redesign".

---

## PART TWO — THE PLAN

### What is NOT touched

- Every table, column, index and constraint. **No migration.**
- `reports.js`, `engine.js`, `policy.js`, `metrics.js`, `overtime.js`,
  `timeclock.js`, `scheduler.js`, `portal.js`, `email.js` — not opened.
- `wages.js` and `services.js` logic — read from, not changed.
- All nine POST handlers keep their paths, their fields and their validation.
  The forms move; what they submit does not.
- The portal, in any respect.

### What changes

**Presentation only, in `server.js`'s render functions and `broadsheet.css`.**

**Step 1 — Roster**, following the reference layout:

```
Staff                          [Permissions]  [+ Add employee]
─────────────────────────────────────────────────────────────
 Active (12)   Managers (1)   Inactive (2)
 [ search            ]  [filter]
─────────────────────────────────────────────────────────────
 ▢  (SM)  Name        Positions   Services   Pay    Status   ⋯
```

Tabs carry **counts**, as the reference does. Search and a filter control sit
beneath them, the primary action sits top-right. Row actions appear on hover
rather than as a permanent `edit` link. PIN becomes an **access warning state**,
never digits. Reuses the avatar helper written for the schedule picker.

**Step 2 — Profile shell, two columns.** This is the part the reference changes
from my first sketch: it is not full-width tabs. It is a header bar, then a
**persistent left column** and a **tabbed right column**.

```
(SM)  Esther            Barista · Day Service · Active   [Options ▾] [Edit]
──────────────────────────────────────────────────────────────────────────
┌───────────────────┐  ┌──────────────────────────────────────────────────┐
│ Personal details  │  │ Employment │ Schedule & Pay │ Time │ Payroll │ … │
│  Name             │  ├──────────────────────────────────────────────────┤
│  Email            │  │  Compensation                                    │
│  PIN  [reset]     │  │   ┌────────────────────────────────────────────┐ │
│  Portal access    │  │   │ Pay type            [ Hourly        ▾ ]    │ │
│                   │  │   │ Overtime eligible   [ Yes           ▾ ]    │ │
│                   │  │   │ POS / Benugin ID    [ ____________   ]     │ │
└───────────────────┘  │   └────────────────────────────────────────────┘ │
                       └──────────────────────────────────────────────────┘
```

The left column holds identity and access — the things you want visible
whichever tab you are on. The right column holds everything operational,
grouped into labelled cards with one control per row, which is what makes the
reference scannable: a **label on the left, its control on the right**, rather
than a grid of inputs.

Tab content is server-rendered per `?tab=`, so there is no client state to get
wrong, every tab is linkable, and the URL stays under `/employees/` — which is
what keeps the permission gate (§4) intact.

**On mobile** the two columns stack: header, then the tab strip scrolling
horizontally, then the active tab, with personal details as the first card
rather than a sidebar.

**Step 3 — Tabs, in order of value:**

Personal details live in the **left column**, not a tab — so the tab set is:

| Tab | Content | New backend? |
|---|---|---|
| Employment | Primary position, status, pay type, OT eligibility, POS ID | none |
| Schedule & Pay | Assigned services; positions with their rates grouped beneath | none |
| Time | Existing timesheet data for this person | read-only reuse |
| Payroll | Existing payroll figures, filtered to this person | read-only reuse |
| Documents | **not built** — see below | — |
| Activity | Wage history, service changes, creation | read-only reuse |

**Step 4 — Wage editing moves into a contained panel** with the three modes,
and the historical-correction option escalated in red with its shift count and
a deliberate confirm. Same fields, same route, same server-side clamping.

**Step 5 — Deactivation moves into an Options menu** with a proper explanation
of what is and is not affected.

**Step 6 — Responsive pass**, measured in the browser at 375px and 1280px.

### Routes

**No new paths, and no removed paths.** Tabs are `?tab=` on the existing edit
URL. This is a deliberate constraint, for the permission reason in §4.

The only route I would *add* is `POST /employees/:id/pin` if resetting a PIN
should be its own action rather than part of the profile form — that stays
under `/employees/`, so it inherits the gate.

### Database

**None.** Every field the brief asks for already exists. Hire date, department,
manager and location do **not** exist, so per the brief they are not rendered.

### Risks, and what each is worth

| Risk | Severity | Handling |
|---|---|---|
| A new path escapes the permission gate | **HIGH** | Nothing leaves `/employees/`. Test with a staff-less account |
| A cascade delete is introduced | **HIGH** | No delete anywhere. Deactivate only |
| A form loses a field and silently stops saving it | **HIGH** | Diff submitted field names before/after per form |
| Wage editing changes which mode is default | **HIGH** | "From today" stays preselected; unknown values fall back to it |
| Payroll or tip-out figures move | **HIGH** | Re-run the before/after comparison harness |
| Test helpers hide a whole screen | MEDIUM | Every new screen gets its own test, as the pickers did |
| PIN digits rendered somewhere new | MEDIUM | Assert the roster and profile never contain the digits |
| Mobile regression | MEDIUM | Measured, not eyeballed |

### Testing

1. Full suite before (**1287 / 0**) and after.
2. Re-run the payroll and tip-out comparison against byte-identical database
   copies. **Payroll and every tip-out must be identical**, and this time there
   is no stale-row excuse available.
3. New tests for: each tab renders; a staff-less account is refused every new
   screen; PIN digits appear nowhere; the wage panel defaults to "from today";
   historical correction still reports its count and still requires confirming;
   deactivation still preserves rows; the roster tabs filter correctly.
4. Browser measurement at 375px and 1280px: long names, many positions, many
   service overrides, empty states.

### Order

Roster → profile shell (two columns + header) → Schedule & Pay → Employment →
Time → Payroll → Activity → wage panel → deactivation → responsive pass.

Each is independently shippable with the suite green. Documents last, and only
its empty structure.

---

## PART THREE — DECISIONS I NEED FROM YOU

**0. The reference layout.** Your screenshots show a two-column profile —
persistent personal details on the left, tabs on the right — and a roster with
counts in the tabs and hover actions on the row. I have planned to that rather
than to full-width tabs. Say if you would rather the profile be tabs across the
whole width; it is a different shape and worth settling before I build it.

**1. Documents tab.** No backend exists — no table, no upload, no signatures.
The brief says not to build a fake one. I propose **not rendering the tab at
all** until it is built, rather than showing an empty tab that looks broken.
Confirm.

**2. New employees currently join every schedule.** The brief says do not
silently change this. I am not changing it. Flagging it as the brief asks:
today a new hire is added to every schedule on creation and narrowed from
there. The alternative is picking services during creation. **No change unless
you say so.**

**3. Activity tab depth.** Real audit data exists for wage changes
(`wage_history` carries who, when, what was chosen) and service membership
(`employee_services.created_at`). There is no recorded history for position
adds or profile edits. So Activity would be honest but thin — wage changes,
service additions, creation date. **Fine, or wait until there is more?**

**4. Positions page.** `/positions` is in the `settings` area, not `staff`.
The brief lists positions under the redesign. Moving it would change its
permission area — a real behaviour change. I propose **leaving it where it
is** and linking to it from the Employment tab. Confirm.

**5. The 25-cent wage-history row.** Esther's stored default ($25) disagrees
with her wage history ($15). Until that is resolved, any before/after payroll
comparison carries that difference. **Best fixed before the redesign starts**,
from her staff page, so the regression harness compares clean numbers.
