# ZWIN Scheduler — Phase 6 Targeted Audit

**Availability + Time Off**

Audited at `347e28b`, 2026-08-13. Phases 0–5 complete and deployed.
**Nothing implemented. No production file changed by this audit.**

> **Confidence note.** The findings below marked *verified* were checked against
> the live schema or the running app. Items marked *inferred* were reasoned from
> code I read but did not execute. This is stated per section rather than left
> for the reader to guess.

---

## 1. What already exists — *verified*

**Nothing. There is no availability or time-off data model of any kind.**

Queried the live schema for `avail | time_off | leave | pto | absence | prefer`:
**zero tables**.

The word `availability` does appear ~8 times in `src/server.js`, and it is a
**naming collision, not the feature**: `PORTAL_NAV` uses `availability:
'available' | 'locked' | 'hidden'` to describe whether a *nav tab* is usable.
Anyone searching for prior art will hit this first and should not mistake it for
a head start.

| Thing | Where | Reusable for Phase 6 |
|---|---|---|
| `PORTAL_NAV.availability` | `server.js:3437` | **No** — unrelated concept, same word |
| "My availability" locked panel | `server.js:6214` (`.ps-soon`) | **Yes** — the tab, route and copy already exist |
| `time_corrections` | live table | **Yes — the strongest precedent.** See §3 |
| `PORTAL.notifyOnce` / `reqTell` | `portal.js`, `server.js` | Yes |
| `SCH.issuesFor()` | `scheduler.js` | Yes — one more issue kind |
| `serviceToday()` / `TC.businessDateOf` | `server.js`, `timeclock.js` | Yes |

---

## 2. The "My availability" tab — *verified*

Already a real, routed, tested view. `/portal/schedule?v=avail` is one of three
sections (`SB_VIEWS = ['me','all','avail']`), shares the page's nav and
bottom-tab treatment, and renders a locked panel:

> **My availability is coming later** — "You will be able to tell your manager
> which days and times you can work, and request time off, from here."

**Activating it needs no routing work and no change to Only me / Everyone.**
The view branch already exists; today it renders `.ps-soon` instead of content.
That is the cleanest possible seam — replace one branch.

---

## 3. Request lifecycle precedent — *verified, and it is strong*

`time_corrections` is the model to copy. Columns:

```
id · time_entry_id · employee_id · kind · field
original_value · proposed_value · reason
requested_by · requested_at
decision · decided_by · decided_at · decision_note
payload · applied_at · apply_error
```

What it already gets right, and what Phase 6 should inherit rather than reinvent:

- **Actor attribution on both sides** — `requested_by` and `decided_by`
- **Timestamps on both sides** — `requested_at`, `decided_at`
- **A manager note separate from the employee's reason** (`decision_note` vs `reason`)
- **Decision guarded against re-decision** — `decideCorrection` returns
  *"That request was already decided."* if `decision !== 'pending'`. That is the
  §31 concurrent-review safeguard, already written and already tested
- **Employee is told the outcome** — `reqTell()` fires on approved / declined /
  handled, through `PORTAL.notify` with a link to the affected record
- **Separation of decision from application** — `applied_at` / `apply_error`
  record that a decision was made *and* whether the change actually landed

**Do not build a generic workflow engine.** Copy this table's shape into a
`time_off_requests` table with the same discipline. `applied_at` is probably
unnecessary for time off (approval *is* the effect; there is no second write),
which is a §11 decision.

---

## 4. Employee identity — *verified*

`requirePortal(req,res)` resolves the employee from a **signed cookie**
(`readTipsToken`). The employee id is never taken from client input on portal
routes. Ownership rules for Phase 6 follow directly:

- Every availability and request write must key on `who.emp.id`, **never** on a
  body or query field
- Every read must filter by the same, so a forged request id returns nothing
  rather than someone else's row — the pattern `/portal/schedule/shift/:id`
  already uses (`row.employee_id !== emp.id` → 404, not 403)
- The **16-hour clock grace** (`CLOCK_GRACE`, added in `caadbc2`) extends an
  expired session only while on the clock. Availability writes should use the
  ordinary session, not the grace
- Managers who are also employees hold both identities: the owner session and
  the portal session are separate cookies. A manager editing their *own*
  availability does it as an employee

---

## 5. Date and time authority — *verified*

One model already exists and must not be duplicated:

| Concept | Use |
|---|---|
| Which service a shift belongs to | **business date** — `TC.businessDateOf(utc, cutoffHour)` |
| A time-off *day* | **calendar date** — a person asking for the 14th off means the 14th |
| An availability *time range* | **local wall clock**, stored as minutes-from-midnight or `HH:MM` |
| A one-off exception's day | calendar date |
| Any instant | **UTC** `YYYY-MM-DD HH:MM:SS`, as `scheduled_shifts` already does |

**The tension to decide (§49-27):** a shift's business date and a time-off
calendar date disagree between midnight and 4am. Someone off on the 14th who is
scheduled 8pm–2am on the 13th is *working during the 14th* by wall clock but the
shift belongs to the 13th. Recommendation: **compare instants, not day labels** —
overlap the shift's `starts_at`/`ends_at` against the request's resolved
UTC window, exactly as `overlapsFor` already does for shifts.

---

## 6–8. Model shape — three concepts, two tables

The roadmap already locks this: *"Do not merge them into one table just because
both block working."* Agreed, and the reason is lifecycle, not storage:
availability is **stated**, time off is **requested and reviewed**.

**Recommended: two tables.**

**`availability_rules`** — employee-stated, no approval
```
employee_id · kind ('unavailable' | 'prefer')
weekday (0-6, NULL for one-off) · on_date (NULL for recurring)
all_day · start_min · end_min
effective_from · effective_until (both nullable)
created_at
```

One table serves recurring and one-off: **`weekday` set = recurring,
`on_date` set = one-off.** A single row shape, one query, and precedence falls
out of specificity (§21).

**`time_off_requests`** — reviewed, modelled on `time_corrections`
```
employee_id · starts_at · ends_at · all_day
reason · status · requested_at
decided_by · decided_at · decision_note
```

**"Available" is not stored.** See §22 — absence of a rule *is* availability.
Storing "available all day Monday" would make the default ambiguous the moment
someone deletes a row.

---

## 9–12. Time-off findings

**Required:** employee, start, end, all-day flag, status, requested_at.
**Optional:** reason (employee), decision_note (manager), decided_by/at.
**Should not exist yet:** PTO balance, leave type, accrual, attachment, approver
chain. The roadmap scopes this to *scheduling unavailability, not paid-leave
accounting* — that boundary is worth defending, because balances drag in
carry-over rules, prorating and payroll integration.

**Partial-day is supported by the same columns** — `all_day` is a display and
comparison convenience, not a different entity. A full day is a range too.

**Statuses (§11, §49-6):** `pending · approved · rejected · withdrawn`. Four.
`applied` is unnecessary — for a correction, "applied" means a punch was
rewritten; for time off, approval *is* the effect and the Issues engine reads
the status directly.

**Editing/withdrawal (§12):** the correction precedent has no employee edit —
a pending request can only be decided. Simplest coherent rule: **a pending
request may be withdrawn but not edited** (withdraw and resubmit), and an
**approved** one cannot be withdrawn unilaterally, because a manager has already
scheduled around it. Both are §49 decisions.

---

## 13–14. Manager review surface and approval

**Time off needs approval. Availability does not.**

Evidence: the roadmap says availability is *"a recurring/general constraint"*
the manager *"may override with a warning"* — an approval step would contradict
the override model. Time off is explicitly *"a real request/approval workflow."*

**Where managers review:** there is already a **requests queue** in Time Clock
(`/timeclock/requests/all`, `pendingCorrections`) and a notification path.
Smallest coherent Phase 6 surface: **time-off requests join that existing queue**
rather than a new HR area, with availability visible where scheduling happens
(the drawer's employee context line, added in `e951f3f`).

**Do not put free-text reasons on the Week Board** (§36). The board is a
seven-column grid read at a glance; a reason belongs in the review surface.

---

## 15–19. Warnings, and the semantics to lock

**Everything warns. Nothing blocks.** Consistent with Phase 2 overlap and Phase 4
Issues, and with the roadmap's explicit *"may override with a warning."*

| Condition | Recommended | Severity |
|---|---|---|
| Shift during **approved** time off | **warn, allow** | action |
| Shift during stated **unavailable** | **warn, allow** | review |
| Shift during **pending** request | **informational, or nothing** | see below |
| Shift **outside** any stated availability | nothing — see §22 | — |
| Shift **inside** prefer-to-work | **nothing** — a preference met is not an issue | — |

**Pending (§19) is the sharp one.** A pending request is not yet a fact; treating
it as a conflict lets an employee create scheduling warnings unilaterally. But
scheduling straight over an unanswered request is exactly how a manager ends up
looking like they ignored it. Recommendation: **informational context in the
drawer, not an Issue** — the manager sees it when placing the shift, and it does
not enter the count.

**Override persistence (§15):** do not persist. Phase 4 established that issues
are derived and there is no dismissal; an override flag would be dismissal by
another name. Fix the schedule or the request, and the issue goes.

---

## 16–17. Issues-engine hooks — *verified shape*

`issuesFor(anyDate)` already returns a list of
`{key, kind, severity, employeeId, businessDate, shiftIds}`. Phase 6 adds two
kinds and nothing structural:

```
timeoff:<shiftId>:<requestId>     action
unavailable:<shiftId>:<ruleId>    review
```

Deterministic keys, same as Phase 4. **The immediate create/edit warning should
call the same helper**, not a route-local copy — that is precisely the mistake
`sbOverlapNote` made by living in the route, which is why duplicate/copy-week
never warned until Phase 4 derived it centrally.

---

## 20–23. Lifecycle, precedence, defaults

**Rejected/withdrawn (§20):** remain visible in the employee's own history,
invisible to schedule checks. No deletion — a rejected request is a record that
the conversation happened.

**Precedence (§21)** — deterministic, no rules engine:
```
1. approved time off        beats everything
2. one-off rule (on_date)   beats a recurring rule for that day
3. recurring rule (weekday)
4. nothing stated           = available
```
Within a tier, `unavailable` beats `prefer`.

**Default (§22, §43) — the most important migration decision.**
**No rows must mean "available, nothing stated."** Every current employee has
zero rows. Any other reading would mark the entire roster unavailable the moment
the table ships, and the board would light up with issues for a schedule that
was correct yesterday. This is also why "available" is never stored (§6).

**Effective dates (§23):** `effective_from` / `effective_until`, both nullable.
Without them, an employee changing their regular Tuesday retroactively rewrites
whether last month's schedule was ever valid. History should not move.

---

## 24–27. Employee UI — *inferred from the existing portal*

The reference model maps cleanly onto what already ships:

| Reference concept | ZWIN equivalent | Carry over? |
|---|---|---|
| Weekly day strip | `.ps-strip` — built, tested, accessible | **Yes, reuse** |
| Day rows | `.ps-row` | Yes |
| "Available — all day" default line | new copy only | Yes |
| Per-day action button | `.pes` bottom sheet (portal's own pattern) | **Yes** — no new overlay pattern |
| Mark unavailable / prefer / request time off | three actions in that sheet | Yes |
| Week nav + summary | `.ps-wknav`, `.ps-wk` | Yes |

**Simplify away:** anything resembling a calendar grid, and any explicit
"set available" control — it has no semantic effect when absence already means
available (§25).

**History (§27), smallest useful:** upcoming approved time off, pending
requests, and the last few decided ones. Not an archive.

---

## 28–31. Notifications and correctness — *verified infrastructure*

Everything needed exists: `PORTAL.adminNotify` (manager direction),
`PORTAL.notify` / `reqTell` (employee direction), `notifyOnce` for dedupe,
and `portal_events` / `admin_events` with unseen counts.

- **Manager notified:** on time-off submit and withdraw. **Not** on every
  availability change — that is a per-employee weekly edit and would become noise
- **Employee notified:** on approve / reject, exactly as `reqTell` already does
- **Idempotency (§30):** a `notifyOnce` key of `timeoff:<id>:<status>` makes a
  retry a no-op, and a **unique index** on the request prevents a double submit.
  Do not rely on a disabled button
- **Concurrent review (§31):** the correction precedent already refuses a second
  decision — *"That request was already decided."* Copy it. That is a
  conditional transition, not last-write-wins, and it is the whole safeguard
  needed

---

## 32–34. After-the-fact conflicts

All three follow one rule already established by the architecture: **nothing
auto-edits a schedule.**

- Time off approved after shifts exist → shifts remain, Issues detects it,
  manager resolves. *Supported today* — `issuesFor` re-derives on every render
- Availability changed after shifts exist → same
- **Publish is never blocked** (§34). Phase 4 confirmed no hard rule can make a
  week unpublishable, and Publish calls no validation at all. Adding a block here
  would be the first, and would contradict the override model

---

## 35–37, 44–45. Privacy, permissions, inactive

**Everyone-view leakage (§35) is the highest privacy risk in this phase.** The
portal's `Everyone` view already renders coworker names, positions and times.
Availability, preferences, reasons and request status must never join it. The
existing Phase 3 test asserts *page source*, not rendered text — extend that same
test to the new fields rather than writing a new one.

**Permissions (§44):** approval belongs under the existing **`schedule`** area —
it is a scheduling decision, made by whoever plans the week. Do not add a
permission tier.

**Inactive employees (§37):** records remain for history, excluded from active
schedule checks. Note the interaction with `schedule_visible_from_at`
(the reactivation boundary from `f5ce454`): a reactivated employee should not
suddenly resurface stale availability from before they left. Recommend rules
carry `effective_until` set on deactivation rather than being deleted.

---

## 38–39. Scope traps to refuse

**Per-position availability: no.** **Per-daypart availability: no.**

A time range already expresses the real constraint. "I can't do dinner" *is*
"unavailable after 4pm". Adding a position or daypart dimension multiplies the
rows and the precedence table for a case nobody has asked for, and the roadmap
explicitly warns against duplicating concepts.

---

## 40–42. Storage and performance

**Two tables, four indexes** — `(employee_id, weekday)`, `(employee_id, on_date)`,
`(employee_id, starts_at)`, `(status)`. Foreign keys to `employees` with the
same cascade discipline the scheduler tables use.

**Performance — *inferred from a measured baseline*.** Phase 4's issue derivation
for a real week measured **0.25 ms** (4 ms for a pathological 600-shift week).
Availability adds two small per-employee reads over a week's roster. It should
stay comfortably synchronous and derived, with no caching. **I did not measure
this** — there is no data to measure yet — but the order of magnitude is not in
doubt.

**One reusable resolver (§41)** is the right shape:

```
availabilityFor(employeeId, startsAt, endsAt)
  -> { state: 'available' | 'unavailable' | 'preferred',
       timeOff: null | { id, status } }
```

Used by the Issues engine, the create/edit warning, the drawer's context line
and, later, Day View. One answer, one definition.

---

## 43. Migration

Additive tables only. Zero rows for every existing employee, and zero rows means
**available**. No employee's schedule changes on deploy. This must be asserted
by a test, not assumed.

---

## 48. Scenario matrix A–T

| | Scenario | Current arch? | New schema? | Employee sees | Manager sees | Issue? | Blocks publish? |
|---|---|---|---|---|---|---|---|
| A | Available all day Monday | n/a | **No row** — the default | nothing | nothing | no | no |
| B | Unavailable Mon 4–10pm | no | yes | own rule | in drawer + Issues | **review** | no |
| C | Prefers Sat 9–3 | no | yes | own rule | in drawer | **no** | no |
| D | One-off unavailable Thu | no | yes (`on_date`) | own rule | same as B | review | no |
| E | Recurring + one-off exception | no | same table | both | resolved by §21 | per result | no |
| F | Full-day time off | no | yes | status | queue | on conflict | no |
| G | Partial-day time off | no | same row | status | queue | on conflict | no |
| H | Multi-day time off | no | **one row**, not daily rows | status | queue | on conflict | no |
| I | Manager approves | precedent exists | — | notified | queue | conflicts appear | no |
| J | Manager rejects | precedent exists | — | notified | queue | none | no |
| K | Employee withdraws pending | no | status | own history | queue clears | none | no |
| L | Unavailable after being scheduled | **yes** — derived | — | own rule | **Issue appears** | review | no |
| M | Time off approved after scheduled | **yes** — derived | — | approved | **Issue appears** | action | no |
| N | Schedules during unavailable | no | — | nothing | warn on save + Issue | review | no |
| O | Schedules during approved time off | no | — | nothing | warn on save + Issue | action | no |
| P | Publishes despite the issue | **yes** | — | gets the shift | Issue persists | stays | **no** |
| Q | Pending overlaps shift | no | — | nothing | **drawer context only** | **no** | no |
| R | Deactivated with future time off | partial | `effective_until` | — | excluded from checks | no | no |
| S | Reactivated later | **boundary exists** | — | — | see §37 | no | no |
| T | Coworker opens Everyone | **yes** | — | **nothing new** | — | — | — |

---

## 49. Decisions requiring approval

The 34 asked for, with a recommendation each. The ten that actually shape the
build:

| # | Decision | Recommendation |
|---|---|---|
| 1 | Default with no rules | **Available.** Anything else breaks every existing employee |
| 2 | Availability needs approval? | **No** — only time off |
| 6 | Statuses | pending · approved · rejected · withdrawn. No `applied` |
| 7 | Partial-day time off | **Yes** — same row, `all_day` is a flag |
| 8 | Multi-day | **One request**, not daily rows |
| 13 | Pending affects Scheduler? | **Context in the drawer, not an Issue** |
| 14/15 | Unavailable / approved conflicts | **Warn, never block** |
| 16 | Issues persist after override | **Yes** — no dismissal, consistent with Phase 4 |
| 30 | Blocks Publish | **No** |
| 33 | Employee-wide or per-position | **Employee-wide** |

The remaining 24 are answered inline above (§6, §11, §12, §20–23, §27–31, §36–39)
and each carries a recommendation rather than a silent choice.

---

## 25/47. Smallest useful Phase 6

**Ship:** recurring weekly unavailability · one-off exceptions · prefer-to-work ·
time-off request + approve/reject · the two derived issue kinds · employee
notification on decision · manager sees availability where they schedule.

**Defer:** PTO balances, leave types, accruals, attachments, override reasons,
availability templates, blackout policies, multi-level approval, SMS/email.

---

## 26. Sequence

1. Two tables + migration test proving zero rows changes nothing
2. `availabilityFor()` resolver + domain tests, no UI
3. Employee "My availability" — replace the `.ps-soon` branch
4. Time-off submit + withdraw
5. Manager review in the existing requests queue
6. Issues engine: two new kinds
7. Create/edit immediate warning **through the same helper**
8. Notifications both directions
9. Privacy test extension for Everyone

---

## 27. Likely files

`src/db.js` (two tables), `src/scheduler.js` (`availabilityFor`, `issuesFor`),
`src/server.js` (portal availability view, request routes, manager queue,
drawer context), `public/staff.css` (`.ps-av*`), `public/broadsheet.css`,
`test/schedule-availability.test.js` (new), `test/schedule-issues.test.js`,
`test/portal.test.js`.

---

## 28. Risks

**High** — the default-availability migration (§43). Getting it backwards marks
the whole roster unavailable on deploy.
**High** — Everyone-view leakage (§35). Coworker availability and time-off
reasons are the most sensitive data this phase creates.
**Medium** — pending-request semantics (§19). Too strong and employees can
manufacture warnings; too weak and requests get scheduled over.
**Medium** — scope creep into HR. Balances and leave types are one decision away.
**Low** — performance; permissions (both inherit existing patterns).

---

## 29. Roadmap corrections

1. **Phase 6 says "preferred working times *if they earn their keep*."** That
   conditional was never resolved. This audit recommends shipping prefer-to-work
   but deliberately giving it **no issue and no warning** — it is context for the
   manager, not a rule. If it earns its keep it does so by being visible while
   scheduling, not by firing.

2. **"Approved time off becomes a scheduling conflict"** is right, but the
   roadmap does not say conflict *of what severity* or whether it blocks. Phases
   2, 4 and 5 all settled on warn-never-block; this should be stated in the
   roadmap rather than re-derived each phase.

3. Nothing else in the Phase 6 section contradicts the code — unusually, because
   it describes a feature that does not exist yet. The corrections in the Phase 4
   and Phase 5 audits (Phase 2's picker context, the "contained scrolling" claim)
   remain the outstanding ones.
