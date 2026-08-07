# ZWIN SCHEDULER — CANONICAL ROADMAP v4

**Purpose:** build an advanced restaurant scheduling system from the correct
architecture upward, reaching the important functional quality of Connecteam
without copying unnecessary generic-workforce complexity.

Connecteam's scheduler is strong because the calendar sits on top of coherent
systems — draft/publish, qualifications, availability/time off, open shifts,
replacement workflows, validation, templates, labor information, notifications.
Zwin builds the same kind of underlying strength, around its existing
restaurant concepts.

*v4 changes from v3 are marked **[v4]**. They are: the inactive-employee
contradiction, the Shifts→Services rename, the Schedule tab unlock, the
published-schedule query window, and the two acknowledged risk concentrations.*

---

# I. LOCKED PRODUCT MODEL

## 1. Scheduled work and actual work are different truths

A scheduled shift is **the plan**. It may contain:

* employee
* position
* calendar date
* business date
* start
* end
* timezone
* service/daypart
* status
* publish state
* note
* planned break information
* open/unassigned state where applicable

It does **not** create:

* punches
* `work` rows
* worked hours
* approved Timesheet data
* wages
* Payroll entries

Example:

```
Schedule: Friday 4:00 PM – 10:00 PM
Actual:   Friday 4:07 PM – 10:32 PM
```

Payroll and timekeeping use actual. Scheduler remains the plan. Future
schedule-vs-actual analysis compares them without merging them.

## 2. Week board

The main manager scheduler is **one employee per row × seven days
horizontally**. An employee may have zero, one, or several shifts in a day.

This mirrors the strongest part of Connecteam's Week experience, where
employees are rows and day cells hold stacked shift cards.

## 3. Positions / qualifications

Use Zwin's existing positions, held positions and active-employee state as the
scheduling qualification source, unless the Phase 0 audit proves that cannot
safely work. **No duplicate Scheduler "Jobs" system without approval.**

## 4. Daypart / service is first-class

Scheduler must understand Zwin's restaurant service model (café, dinner, future
services). Service windows are configurable, for example:

```
Café    7:00 AM – 3:00 PM
Dinner  3:00 PM – close
```

Those are examples, not hard-coded values.

### Stamp, don't continuously derive

When a scheduled shift is created, its service/daypart is determined by the
authoritative service rules **at that moment** and stamped onto the row.
Changing a service-window setting later must never silently rewrite existing
scheduled shifts.

> A shift created when Dinner began at 3 PM stays `dinner`. If Dinner later
> moves to 4 PM, that shift is unchanged; new shifts use the new rule.

This follows the precedent already in the codebase: `shifts.policy_id` locks
the tip-out policy version at creation so a later settings change cannot
retroactively rewrite history.

### Shifts crossing service windows

Example: 11 AM – 9 PM. **Phase 0 settles this.** Candidates: manager chooses a
primary service; automatic primary service; explicit spanning. Whichever rule
is chosen, the result is stamped at creation. Do not implement a guess.

## 5. Business date

Scheduler gets **no independent business-day cutoff**. It reuses Zwin's
existing `tc_day_cutoff` and the authoritative `businessDateOf()` behaviour.

One restaurant, one business-date interpretation. A Friday-night close must
never be Friday in Scheduler and Saturday in Time Clock.

## 6. Timezone

Store enough information for reliable timezone behaviour; keep the manager UI
simple. They see `Fri · 6 PM – 2 AM`, not timezone machinery.

## 7. Availability

Availability is normally a **warning, not a block**. A manager may schedule an
employee who marked themselves unavailable, but the conflict must be obvious
before publishing. Final responsibility is the manager's.

## 8. Publishing

Draft work is private to management. Employees see published shifts and are
notified when shifts are published to them. Draft edits do not notify anyone.

**Material edits** to published assignments require an explicit
republish/change flow. Material changes include at least:

* employee
* date
* start
* end
* position
* cancellation / removal
* meaningful planned-break change
* assigned ↔ open

## 9. Employee deactivation / reactivation

**Deactivate:** their shifts disappear from normal active scheduler
experiences. The records are not destroyed.

**Reactivate:** only their still-future applicable scheduled shifts return.
Past hidden shifts do not reappear.

```
Deactivate Tuesday. Employee had Wed, Thu, Sat shifts.
Reactivate Friday.
  Wednesday → stays hidden
  Thursday  → stays hidden
  Saturday  → returns
```

No phantom past schedules.

**[v4] Assignment to an inactive employee is prevented at creation, not
flagged afterwards.** See §Phase 0 question *E* and §Phase 4 — v3 listed
"inactive employee" as a validation rule, which would have flagged a shift the
manager cannot see. Phase 0 resolves this as a create-time guard.

## 10. Planned breaks ≠ actual Time Clock breaks

A **scheduled break** means "the manager plans for this employee to have a
break during this shift." An **actual break** (`time_breaks`) means "this break
really happened during worked time."

Scheduler must not create or directly reuse `time_breaks` records merely
because a planned break exists. The existing break database triggers
(`trg_te_breaks_fit_upd` and siblings) continue to protect actual punch data
and must never be handed planned data to validate.

Later we can compare planned vs actual break without conflating them.

## 11. Time Clock future integration

No scheduled clock restrictions in the initial build. Architecture must allow
Time Clock to eventually query: current scheduled shift, next scheduled shift,
scheduled start, scheduled position.

Future settings may allow: show upcoming shift, "Start scheduled shift", clock
in at start only / 5 min early / 10 min early, warn or block unscheduled
clock-in. **Do not build these now.**

## 12. No detailed shift audit system

No Connecteam-style field-by-field Shift Activity product. Keep useful
metadata — created, modified, published — without building an audit subsystem.

## 13. Projected overtime removed

No scheduled OT projection in this roadmap. Actual OT remains authoritative in
the existing OT/Payroll system. Scheduled OT planning, if ever needed, gets its
own deliberate design rather than an approximate second calculation path.

## 14. Coverage targets deliberately omitted

We are aware of the future question *"how many servers should Friday dinner
have?"* The scheduler will show actual scheduled coverage but will not define
target staffing. Without meaningful historical schedule/labor/sales data,
targets would be arbitrary configuration. **A known omission, not a forgotten
feature.**

## 15. [v4] Naming: the owner "Shifts" page becomes "Services"

Zwin already has a `shifts` table meaning *a service the restaurant runs* —
one row per `(date, daypart)`, UNIQUE on that pair, which everything from tip
pooling to Payroll hangs off. A scheduled shift is a different object: one
employee, arbitrary times, many per day.

Shipping both under the word "shift" guarantees confusion in conversation, in
code review and in every future prompt.

**Rename the existing owner Shifts page and its navigation to Services**
before any scheduler code exists to inherit the ambiguity. The underlying table
name may stay `shifts` if renaming it is not worth the migration risk — Phase 0
decides — but the *product* language separates immediately:

| Object | Product name | Meaning |
|---|---|---|
| `shifts` row | **Service** | Tuesday dinner, restaurant-wide, one row |
| scheduled shift | **Shift** | Esther, Server, Fri 4–10, one employee |

Delivered as a small explicit task at the end of Phase 0 / start of Phase 1.

---

# II. EXECUTION PHILOSOPHY

Eleven real phases. Each produces something independently understandable and
testable.

**Safety comes from auditing before a build and measuring after it — not from
the number of gates.** The process per phase:

> Audit → Product decisions → Architecture → Implement → Test → Measure →
> Responsive verification → Deploy verification

Some phases need only a small targeted audit because Phase 0 established the
foundations.

## [v4] Two phases carry concentrated risk

**Phase 2** (week board + create/edit drawer + copy previous week) and
**Phase 8** (open shifts + claims + replacements + shared eligibility engine)
are each roughly three phases of work.

The merges are deliberate — a board you cannot create in, and claims without
replacements, are not independently judgeable. But if anything slips, it will
be these two.

**Therefore: when a phase is large, the audit at its front gets bigger, not
skipped.** Phase 2 and Phase 8 each require their own targeted audit before
implementation, even though Phase 0 covered the foundations. That is the one
place merging phases could quietly cost us, and it is the rule that prevents it.

---

# PHASE 0 — Complete Scheduler Architecture Audit

**No implementation. No migration. No scheduler UI.**

## Claude audits

employees · `employees.active` · positions · held positions · position wage
architecture · Time Clock · `tc_day_cutoff` · `businessDateOf()` · café/dinner
daypart architecture · existing shared `shifts` · punches · `work` ·
`time_breaks` · break DB constraints and triggers · Timesheets · Payroll ·
overtime (awareness only) · notifications · the locked Staff Portal Schedule
tab · requests infrastructure · availability infrastructure · time-off
infrastructure or its absence · owner/admin auth · employee Portal auth ·
settings architecture · DB schema · owner design shell · Staff Portal shell ·
reusable UI primitives

## Phase 0 must answer

**A. Daypart.** How is a scheduled shift assigned a service? How should a shift
crossing multiple service windows behave? How is service stamped so future
settings changes cannot rewrite existing schedule data?

**B. Business date.** Confirm direct reuse of the current Time Clock
business-date system.

**C. Positions.** Confirm held positions are sufficient qualification data. If
not, explain exactly why *before* proposing another model.

**D. Scheduled vs actual.** Define the hard data boundary and the future
joining mechanism.

**E. [v4] Employee lifecycle — including the inactive contradiction.** Confirm
deactivate → hidden, reactivate → future shifts only. **And resolve how
inactive employees are handled by validation:** since their shifts are hidden,
"inactive employee" cannot be a validator over existing shifts. Determine
whether it is a create-time guard, a visible-but-flagged state, or both — and
state which.

**F. Planned breaks.** Design a Scheduler-specific planned-break concept
entirely separate from `time_breaks` and its triggers.

**G. Time off.** Determine what Zwin has and what Scheduler needs. Assume it
needs building.

**H. Planned labor wage source.** Document now: a scheduled shift has no `work`
row, so planned labor cannot use an actual per-work wage override. Planned
labor resolves through the authoritative *position/role wage → employee
default* path. **Planned and actual labor may therefore differ legitimately
even when hours match** — this must be explicit so nobody reports it as a bug.

**I. [v4] Published-schedule query window.** "Query published employee
schedule" needs a boundary. Recommended: **future plus a short tail** (the
current week), because *"what did I work"* is Pay and Timesheet's question, not
the schedule's — and Zwin has already spent real effort making sure two screens
never answer the same question differently. Also settle: **how far ahead may a
manager schedule?** It bounds copy-week and recurrence.

**J. [v4] Naming.** Confirm the Shifts→Services rename scope: which routes,
navigation entries, page titles and copy change, and whether the `shifts` table
itself is renamed or only the product language.

## Phase 0 deliverable

A written architecture document containing: proposed entities · field semantics
· relationships · state lifecycle · daypart strategy · business-date reuse ·
planned-break model · employee lifecycle · position qualification · time-off
model · auth/permissions · routes and service-layer boundaries · migrations ·
test architecture · specific risks · final build sequence.

**Approved before any code.**

---

# PHASE 1 — Scheduler Domain Foundation

Build the scheduling backend. Not the calendar.

## Capability

create scheduled assignment · edit · cancel/delete per lifecycle rules · query
by employee · query by date/week · query published schedule (within the §Phase 0
*I* window) · business date · timezone · stamp daypart/service · planned break ·
notes · draft state · future open/unassigned capability · inactive-employee
filtering

## Individual assignment model

Even bulk creation ultimately produces independently addressable scheduled
assignments, so each can be separately edited, published, claimed, swapped and
validated.

## Service layer

UI must not mutate arbitrary rows. Scheduler-domain operations only.

## Hard invariants — tested, not merely stated

Following the precedent set by Phase 2F's manual reports, these are asserted in
tests rather than described in prose:

* creating a scheduled shift creates **no** punch, `work` row, worked hours,
  wage or Payroll entry
* **deleting a scheduled shift never touches punches, `work`, or the Services
  page** — the schedule is strictly a plan
* a scheduled shift's daypart is stamped and does not change when service
  windows change

## [v4] Also in this phase

The **Shifts → Services** rename (§I.15), delivered as its own small change so
scheduler code is written against unambiguous language from line one.

## Done when

The scheduling domain is heavily unit- and integration-tested with no
dependency on a visual board.

---

# PHASE 2 — Manager Week Board + Create/Edit + Copy Previous Week

*Merged: a Week board that cannot create or edit shifts is not meaningfully
evaluable.* **[v4] Requires its own targeted audit before implementation.**

## Week board

Employee rows × seven days.

**Left column:** employee · relevant position context · total scheduled weekly
hours.
**Day headers:** date · useful daily totals.
**Cells:** zero, one, or several shifts.

**Shift cards:** position · start/end · service identity where useful ·
draft/published distinction (Phase 3) · issue indicator (Phase 4).

## Create / Edit drawer

Click empty cell → create. Click shift → edit.

**Fields:** employee · position · date · start · end · duration ·
daypart/service · cross-midnight clarity · planned break · employee-visible
note when applicable.

**Employee picker context:** held positions · current scheduled hours ·
same-day assignments. Availability appears once Phase 6 exists.

## Core actions

create · edit · duplicate · delete/cancel · reassign · multiple same-day shifts

## Copy previous week — ships here

Restaurant scheduling is repetitive enough that this is foundational
productivity, not a convenience. Copying:

* reproduces the prior week's assignments
* creates **drafts**
* never publishes
* respects current employee active state
* does not silently duplicate into an already-built target week
* applies current domain rules when creating the copies

## No drag/drop yet

Deliberately deferred to Phase 11. Click-to-create and click-to-edit is enough
to ship a complete, reliable board.

## Done when

A manager can genuinely build next week's schedule efficiently on desktop.

---

# PHASE 3 — Draft / Publish + Employee My Schedule

*Merged: publishing something an employee cannot view is not a workflow.*

## Manager side

drafts · publish individual shift · publish week · pending unpublished-change
indicators · material published-change handling · employee notification on
publish.

Ten draft edits → **zero** employee notifications. Publish → the employee
receives the schedule.

## Employee Staff Portal

**[v4] This phase unlocks a tab that is currently locked on purpose.**
`PORTAL_NAV` carries:

```js
{ key: 'schedule', availability: 'locked',
  lockedMessage: 'Employee scheduling is coming soon…' }
```

with tests asserting it is a `<button>`, carries `pt-tab-locked`, and has no
`href`. Phase 3 flips all of that — a planned change with known test updates,
not a surprise failure.

**My Schedule**, published shifts only, mobile-first: upcoming shifts ·
week/list navigation · date · time · position · service where useful · note ·
clear overnight handling. Click a shift → detail.

## Notification integrity

A publish notification must lead to a working destination. No dead or locked
link.

## Done when

The whole story works: manager builds → publishes → employee is notified →
employee opens it and sees it.

---

# PHASE 4 — Scheduler Issues / Validation Engine

A centralized validator, not warnings sprinkled through UI code.

## Initial rules

* overlapping scheduled shifts
* employee doesn't hold position
* unassigned shift
* unpublished / materially changed schedule
* excessive scheduled hours
* availability conflict *(dormant until Phase 6)*
* approved time-off conflict *(dormant until Phase 6)*

**[v4] "Inactive employee" is not in this list.** Per §I.9 and §Phase 0 *E*,
inactive employees' shifts are hidden, so a validator over existing shifts
would flag something invisible. Assignment to an inactive employee is prevented
at creation instead.

## Severity

info · warning · block only where genuinely justified. Availability stays a
warning. **No projected OT.**

## Surfaces

shift card · relevant day/cell · employee row/week · overall issues summary.

## Done when

Managers can identify bad schedules before they reach employees.

---

# PHASE 5 — Fast Manager Mobile Controls

Do not squeeze a seven-column grid onto a phone. Build a purpose-specific
manager surface: **Today / Upcoming**, compact shift rows, fast actions.

Manager can: view today · view upcoming · open a shift · edit · change employee
· adjust start/end · unassign · cancel/remove · republish the change.

Open-shift actions plug into this surface later.

## Done when

A Saturday call-out can be handled from the restaurant floor without a laptop.

---

# PHASE 6 — Availability + Time Off

Shipped together because both inform whether someone should work; kept distinct
because they are different domains.

## Availability

Employee enters: unavailable all day · unavailable partial day · recurring
weekly unavailability · preferred working times if they earn their keep.

Manager sees it in scheduler context and may override with a warning.

## Time Off

A real request/approval workflow. Employee: date or range · full or partial day
· note. Manager: approve or deny. Approved time off becomes a scheduling
conflict.

## The distinction

**Availability** is recurring/general constraint. **Time off** is a specific
requested absence. Do not merge them into one table just because both block
working.

## Done when

Scheduler understands availability and approved absences end to end.

---

# PHASE 7 — Templates + Recurrence + Advanced Copying

**Shift templates** — Server Dinner 4–10 · Café Open 7–3 · Kitchen Close.
**Day templates** — Typical Friday Dinner, with its staffing pattern.
**Week templates** — a reusable whole-week structure.
**Copying** — copy day · copy employee · save/load week structure (copy
previous week already shipped in Phase 2).
**Recurrence** — weekly · every N weeks · selected weekdays · ending after a
date or an occurrence count.

**Rule: template and recurrence generation creates drafts. Never silently
publishes.**

## Done when

Managers stop recreating recurring restaurant patterns by hand.

---

# PHASE 8 — Open Shifts + Claims + Replacements

*Merged: these share nearly all their eligibility machinery.* **[v4] Requires
its own targeted audit before implementation.**

## Shared eligibility engine — built once

Both claims and replacements use one evaluator: employee active · holds the
required position · no overlapping assignment · availability · approved time
off · any applicable scheduler restriction. **Do not duplicate this logic.**

## Open shifts

Manager creates: date · time · position · service · number of spots if
supported · note. Employees see eligible open shifts.

## Claims

Employee claims. If approval is required, the manager approves one eligible
claimant, and the assignment updates and publishes per the lifecycle.

## Replacements

Employee opens a published shift → *Request replacement*. Eligible coworkers
may volunteer or accept. Optional manager approval. No silent mutation.
Notifications reach affected people.

## Settings introduced here

enable open-shift claims · claims require manager approval · enable replacement
requests · replacements require manager approval.

## Done when

Coverage changes stop happening in group texts.

---

# PHASE 9 — Day View

**No Month view** unless real demand appears.

Timeline/Gantt: employees vertically, clock horizontally, shifts positioned
across time. Eventually shows: who is working at any moment · café/dinner
boundaries · overlapping employees · availability and time off · scheduled
headcount through the day · unfilled or open shifts.

This is where the stamped service/daypart architecture pays off.

**Known deliberate omission:** Day view can say *"five servers at 7 PM."* It
will not say *"you need six."* Coverage targets remain a documented future
opportunity (§I.14).

## Done when

A manager can see real floor coverage across the service day.

---

# PHASE 10 — Labor Intelligence

Only things we can calculate defensibly.

**Planned:** scheduled hours · scheduled headcount · hours by position ·
planned labor cost.
**Actual, after work happens:** actual hours · actual labor · scheduled vs
actual hours · planned vs actual labor.

## Wage semantics — stated in the UI, not just the docs

A scheduled shift has no `work` row, so planned labor cannot use an actual
per-shift wage override. Planned labor resolves through *position/role wage →
employee default*. Actual labor continues to use real Payroll logic.

**Planned and actual labor may legitimately differ even when hours match.** The
interface says **Planned labor** and never pretends to be Payroll.

**Not included:** projected OT · invented staffing targets.
**Later only if trustworthy:** sales · labor % · sales per labor hour ·
service-level comparison.

## Done when

Scheduler is useful for labor planning without ever disagreeing with Payroll
about actual money.

---

# PHASE 11 — Advanced Manager Productivity

## Drag and drop — here, not earlier

Move to another employee · move to another day · time manipulation where the
UX is reliable. **Every drop runs the same domain command and validation as an
ordinary edit. DOM position is never the source of truth.**

## Other candidates

multi-select · bulk reassign · bulk delete/cancel · multi-duplicate · richer
filters · grouping · keyboard shortcuts · print/export · undo of recent
operations where practical.

## Done when

Manager scheduling has the speed and polish expected of mature workforce
software.

---

# III. SETTINGS ROADMAP

Settings appear only when the dependent capability exists.

**Early:** week starts on · timezone · default shift length/time if genuinely
helpful · service windows.

**No duplicate business-day setting.** `tc_day_cutoff` remains authoritative.

**Service-window changes** affect only newly created shifts. They never
retroactively rewrite stamped historical scheduled shifts.

**Phase 6:** enable employee availability; advance-notice limits later if
needed. Keep time-off settings minimal until usage shows what is necessary.

**Phase 8:** open-shift claims enabled · claims require approval · replacements
enabled · replacements require approval.

**Future Time Clock settings — documented, not built:** show scheduled shift on
the clock · use schedule for clock-in guardrails · unscheduled clock-in
behaviour · earliest clock-in (at start / 5 min / 10 min / configurable). **No
dead toggles.**

---

# IV. WHAT WE HAVE AT THE END

**Manager:** Week scheduler · Day timeline · employee rows · multiple shifts
per day · create/edit workflow · copy previous week · draft/publish · publish
notifications · position qualification · stamped service/daypart · unified
business date · planned breaks · issues engine · availability · time off ·
templates · recurrence · open shifts · claims · replacements · mobile emergency
controls · labor planning · safe drag/drop · bulk productivity tools.

**Employee:** My Schedule · published assignments · shift detail ·
notifications · availability · time-off requests · open shifts · claims ·
replacement requests.

**Integration:** existing employee records · active/inactive lifecycle ·
positions and held positions · café/dinner service model · existing
`tc_day_cutoff` · Time Clock-compatible future seam · actual worked time ·
existing Payroll authority · Zwin notifications.

---

# V. DELIBERATELY NOT BUILDING NOW

Preserved with the roadmap so these are never mistaken for omissions:

Month calendar · projected overtime · staffing/coverage targets · AI-generated
schedules · auto-assign · Excel import · shift tasks · shift layers ·
GPS-per-status · SMS infrastructure · shareable public schedule links ·
field-level shift activity history.

---

# VI. THE RULE FOR EVERY PHASE

> Audit → understand the current system → product decisions → architecture →
> implementation → tests → responsive/mobile verification → production
> verification.

Claude does **not** independently invent major scheduler behaviour. If an audit
finds that existing Zwin architecture conflicts with this roadmap, Claude
reports it and **we decide** before the plan changes.

**Large phases get larger audits, never smaller ones.** (§II)

---

# NEXT: Phase 0 Scheduler Architecture Audit

**No code.**

It must settle: the daypart/service-window design including the cross-service
case · `tc_day_cutoff` reuse · positions/qualification reuse · the planned-break
model kept clear of `time_breaks` and its triggers · the inactive-employee
validation contradiction · time-off architecture from zero · planned-labor wage
semantics · the published-schedule query window and scheduling horizon · the
Shifts→Services rename scope.
