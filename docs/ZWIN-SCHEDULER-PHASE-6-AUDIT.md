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

---

# ADDENDUM — gap check against the original 51-point brief

Added 2026-08-13, at `85253ef`. The brief that commissioned this audit was
re-read section by section against what the audit actually delivered. Still
audit only; nothing implemented.

## A1. The foundational claim re-verified — *measured, and it holds*

§1 concluded *"there is no availability or time-off data model of any kind"* on
the strength of a **schema** query for six terms. The brief asked for a
**repo-wide** search across fourteen. That search has now been run over `src/`
and `test/`:

| Term | Hits | What they are |
|---|---|---|
| `availability` | 20 | `PORTAL_NAV.availability` — nav tab state |
| `unavailable` | 16 | **A second and third collision** — see below |
| `prefer` / `preference` | 22 | Unrelated (`preferred` in prose, CSS) |
| `time off` | 7 | The locked panel's own copy, and one test |
| `PTO` · `leave` · `absence` | 186 | All false positives — `leave` as a verb, `absence` in comments |
| `timeoff` · `time_off` · `schedule preference` | 0 | — |

**The conclusion survives: zero availability or time-off data model.** But there
are **three** naming collisions, not one. §1 listed only the first:

1. `PORTAL_NAV.availability` — whether a nav tab is usable (`server.js:3437`)
2. **"Earnings unavailable"** — a Time Clock/portal pay state (`server.js:5807`, `6012`)
3. **`kind: 'unavailable'`** — a shift the tip engine could not cost
   (`server.js:3747`). This one is the most dangerous of the three, because it is
   an `out.push({ kind: ... })` on a derived list and reads exactly like a
   scheduler issue kind. It is about **money, not availability.**

Anyone grepping for prior art will hit all three.

## A2. A test Phase 6 will break — *not in §27's file list*

`test/schedule-publish.test.js:682`, **"My availability is present and honestly
empty"**, asserts the locked tab contains no control named:

```
Save · Request time off · Prefer · Unavailable · Repeat
```

Those are the exact five controls Phase 6 ships. **This test fails the moment
the feature works.** That is correct and deliberate — it is the same guard
pattern the roadmap praised at Phase 3 — but §27 lists
`test/schedule-availability.test.js`, `test/schedule-issues.test.js` and
`test/portal.test.js` and **not this file**. It must be a planned edit, not a
surprise red suite.

Incidentally the five names are a strong hint at the intended UI, and
**`Repeat`** confirms recurring rules were anticipated in the interaction design.

## A3. Missed entirely

| # | Gap | Why it matters |
|---|---|---|
| 1 | **The Phase 6 setting.** The roadmap's §III says Phase 6 introduces *"enable employee availability."* The audit contains the word "setting" **zero times** | A whole surface — and the roadmap's own rule is *"settings appear only when the dependent capability exists"* and *"no dead toggles"* |
| 2 | **Accessibility and mobile** (brief §46). The brief asked for nine specifics — touch targets, time pickers, recurring controls, status badges, review drawer, date-range picker, keyboard/focus, high text zoom, bottom-nav clearance. The audit has one passing phrase (*"`.ps-strip` — built, tested, accessible"*) and no a11y step in its §26 sequence | Phase 5's audit ended with an explicit a11y pass. This one dropped it, on the phase that adds the most new employee-facing controls |
| 3 | **Overnight availability ranges** (decision #27). Never addressed | *"Unavailable 10pm–2am"* either splits across two weekday rows or stores `end_min < start_min`. §5 settles the business-date question for time **off**; it does not settle a recurring rule that crosses midnight — in a restaurant, the common case |
| 4 | **Phase 8's shared eligibility engine.** The roadmap says claims and replacements consume *"availability · approved time off"* through one evaluator and **"Do not duplicate this logic."** The audit mentions Phase 8 zero times | §41's `availabilityFor()` is the right shape, but its stated consumers stop at Day View. If its signature does not suit Phase 8, Phase 8 duplicates it — the exact outcome the roadmap forbids |

## A4. Answered, but not in the form the brief asked for

- **§7 recurrence** — the brief asked to *compare* weekday+range, date-specific
  rows, recurrence-rule strings and generated instances. The audit picks
  weekday/`on_date` with good reasoning but never puts RRULE or generated
  instances on the page. *"Do not choose silently"* is only half-satisfied.
- **§8 one-off exceptions** — same shape: three options requested, one delivered.
- **§49 decisions** — the brief listed **34**. The audit tabulates **10** and
  says the other 24 are *"answered inline above."* They mostly are, but a
  decision document you have to hunt through is not a decision document. #3
  (prefer-to-work timed or all-day), #12 (are manager notes private from the
  employee?), #24, #27 and #32 all require a reader to reconstruct the answer
  from prose.
- **§12 lifecycle** — edit, withdraw-pending and withdraw-approved are covered.
  **Overlapping requests** — asking for the 14th, then also the 12th–16th — is
  not, and the brief asked for it.
- **§45 security** — of the seven conceptual tests, cross-employee request
  **enumeration** and **hidden draft data leakage** are not explicitly addressed.

## A5. Honestly declared, still open

**§42 performance.** The audit states plainly: *"I did not measure this — there
is no data to measure yet."* That is the correct answer and the right way to say
it. The brief nonetheless asked for a figure at 10 employees / 50 shifts /
recurring rules / one-off exceptions / several requests. It stays **unmeasured**
until the tables exist, and should be measured at step 2 of §26's sequence
rather than after the UI is built.

## A6. What this changes

Nothing in the audit is **wrong**. The model, the two tables, the precedence
order, the default-availability finding and the scenario matrix all stand, and
the foundational "nothing exists" claim is now measured rather than asserted.

What is missing is **four things to add before the build starts** (A3), one test
file to add to the plan (A2), and a decision table that should be completed to
all 34 rather than 10 (A4).

---
---

# PART II — AUDIT COMPLETION

Added 2026-08-13 at `85253ef`. Closes A3 and A4. **Still audit only — no
production file, no test, and no schema changed.** Everything marked *measured*
was read from the running schema or from source with a line reference;
everything marked *inferred* was reasoned and is flagged as such.

---

## B1. The complete decision table — all 34, plus one

**How to read `Touches`:** `S` schema · `E` employee UI · `M` manager UI ·
`I` Issues engine · `N` notifications · `8` Phase 8 seam. A dash means none.

**Status:** `Locked` = already settled by the roadmap or by a safety fact, not
really yours to change. `Rec` = my recommendation, change it freely.
`Open` = genuinely ambiguous, I am not confident either way.

| # | Decision | Recommendation | Status | Evidence & consequence | Touches |
|---|---|---|---|---|---|
| 1 | Default when no rules exist | **Available** | Locked | Every one of 84 employees has zero rows. Any other reading marks the whole roster unavailable on deploy and lights up the board for a schedule that was correct yesterday | S E I 8 |
| 2 | Do availability changes need approval? | **No** — time off only | Locked | Roadmap: availability is a constraint the manager *"may override with a warning."* An approval step contradicts the override model | E M N |
| 3 | Is prefer-to-work all-day, timed, or both? | **Both** | Rec | Same row shape as unavailable (`all_day` + `start_min`/`end_min`), so supporting both costs one flag. *"I'd rather work Saturday days"* is as real as *"all day Saturday"* | S E |
| 4 | Do recurring rules need effective dates? | **Yes** — `effective_from` / `effective_until`, both nullable | Rec | Without them, changing your regular Tuesday retroactively rewrites whether last month's schedule was ever valid. History must not move | S E M |
| 5 | One-off exceptions model | **Same table.** `weekday` set = recurring, `on_date` set = one-off | Rec | One row shape, one query, and precedence falls out of specificity (#21). Alternatives in B5a | S E |
| 6 | Time-off statuses | **pending · approved · rejected · withdrawn** | Rec | Four. `applied` is meaningful for a correction (a punch gets rewritten) but not here — approval *is* the effect and `issuesFor` reads status directly | S M N |
| 7 | Partial-day time off | **Yes** — same row, `all_day` is a flag | Rec | A full day is a range too. Refusing partial days means a 2-hour appointment costs a whole shift | S E M |
| 8 | Multi-day requests | **One request**, not one row per day | Rec | A five-day holiday is one conversation and one decision. Daily rows means five approvals and five notifications | S E M N |
| 9 | Can an employee edit a pending request? | **No — withdraw and resubmit** | Rec | The `time_corrections` precedent has no employee edit; a pending request can only be decided. Editing under a manager mid-review is the race nobody needs | E M |
| 10 | Can an employee withdraw an *approved* request? | **No** — ask the manager | Rec | A manager has already scheduled around it. Unilateral withdrawal silently invalidates a week that was planned correctly | E M |
| 11 | Is the employee's reason required? | **Optional** | Rec | Requiring a reason to ask for a day off is a policy choice this app should not make for you. Ask for it, do not gate on it | S E |
| 12 | Can managers add *private* review notes? | **No — one note, and the employee sees it** | Rec | **Measured:** `decision_note` already renders in two employee-facing routes — `/portal/clock/entry/:id` (`server.js:7482`) and `/portal/requests` (`server.js:7839`). A private field sitting next to a visible one in the same table is a leak waiting for one careless `SELECT *` | S E M |
| 13 | Does *pending* time off affect the Scheduler? | **Context in the drawer, not an Issue** | Rec | Too strong and an employee manufactures warnings on your board by asking. Too weak and you schedule over an unanswered request. See B12 | M |
| 14 | Unavailable conflict — warn or block? | **Warn, never block** | Locked | Phases 2, 4 and 5 all settled warn-never-block. `validate()` refuses only on qualification/inactive/time (`scheduler.js:301`); availability must not join that list | I M |
| 15 | Approved time-off conflict — warn or block? | **Warn, never block** — `action` severity | Locked | Same. A Saturday call-out sometimes *means* scheduling someone who asked to be off | I M |
| 16 | Do Issues persist after a manager overrides? | **Yes — no dismissal** | Locked | Phase 4 established issues are derived, with no dismissal state. An override flag is dismissal by another name. Fix the schedule or the request and it goes | I |
| 17 | Immediate warning on create/edit? | **Yes — through the same helper** | Locked | `sbOverlapNote` lived in the route, so duplicate and copy-week never warned. Phase 4 fixed it by deriving centrally. Do not repeat it | I M |
| 18 | Do availability issues join the Phase 4 Issues drawer? | **Yes** — two new kinds, nothing structural | Locked | `issuesFor()` already returns `{key, kind, severity, employeeId, businessDate, shiftIds}` (`scheduler.js:1032`). Add `timeoff:` and `unavailable:` | I M |
| 19 | Notify the manager on an availability change? | **No** | Rec | A per-employee weekly edit. Notifying on each turns the bell into noise and trains you to ignore it | N |
| 20 | Notify the manager on a time-off request? | **Yes** — on submit and on withdraw | Rec | `PORTAL.adminNotify` exists. A request nobody sees is worse than no request | N |
| 21 | Notify the employee on approve/reject? | **Yes** | Locked | `reqTell()` already does exactly this for corrections, with a link to the record | N |
| 22 | Where does the manager review requests? | **The existing requests queue** — `/timeclock/requests/all` | Rec | Built, tested, and already where you look for staff requests. A second HR area splits your attention for no gain | M |
| 23 | Where does the manager see availability while scheduling? | **The create/edit drawer's employee context line** (added `e951f3f`) | Rec | It already says what that person has that day. Availability is the same kind of fact, in the same place, at the moment of the decision | M |
| 24 | Does the UI show "Available — all day" explicitly? | **Yes, as display only — never a stored row** | Rec | The reassurance is worth it; the row is not. Storing "available" makes the default ambiguous the moment someone deletes one (#1) | E |
| 25 | Support prefer-to-work at all? | **Yes — but with no issue and no warning** | Rec | The roadmap hedged: *"if they earn their keep."* It earns its keep by being visible while you schedule, not by firing. A preference met is not a problem | S E M |
| 26 | Weekday-based recurrence? | **Yes** — `weekday` 0–6 | Rec | Restaurant availability is weekly. RRULE strings and generated instances are both heavier — see B5a | S |
| 27 | Overnight availability ranges | **One rule. `end_min <= start_min` means it ends the next day** | Rec | The restaurant case, not the edge case. Full analysis and locked behaviours in **B5** | S E I 8 |
| 28 | Availability changes after shifts exist | **Nothing mutates. The Issue re-derives** | Locked | `issuesFor` recomputes on every render, so this is already supported. No auto-cancel, no auto-unpublish | I |
| 29 | Time off approved after shifts exist | **Same — nothing mutates** | Locked | Ditto. The manager resolves it | I |
| 30 | Does any of this block Publish? | **No** | Locked | Phase 4 confirmed no hard rule makes a week unpublishable, and Publish calls no validation at all. This would be the first | — |
| 31 | Which permission governs approval? | **The existing `schedule` area** | Rec | It is a scheduling decision made by whoever plans the week. `nav.js` AREAS already carries `schedule`, and new keys are closed by default | M |
| 32 | What request history stays visible? | **Rejected and withdrawn stay in the employee's own history; invisible to schedule checks** | Rec | A rejected request is a record that the conversation happened. Deleting it invites *"I definitely asked."* | E M |
| 33 | Employee-wide or per-position availability? | **Employee-wide** | Locked | A time range already expresses the real constraint. *"I can't do dinner"* **is** *"unavailable after 4pm."* Per-position multiplies rows and the precedence table for a case nobody has asked for | S |
| 34 | Adopt the reference "My availability" interaction model? | **Structure yes, controls simplified** | Rec | Reuse `.ps-strip`, `.ps-row`, `.ps-wknav`, `.pes` sheet. Drop the calendar grid and any explicit "set available" control — it has no semantic effect (#1, #24) | E |
| **35** | **`enable employee availability` setting** *(roadmap-required, outside the original 34)* | **Ship it. Default ON for this restaurant, OFF for a fresh install. Governs both halves** | Rec | The roadmap §III names it. Full audit in **B2** and **B3** | S E M I N |

**Count: 34 + 1.** Locked 13 · Recommended 21 · Genuinely open 0 — see **B17**
for the three I would still call soft.

---

## B2. The Phase 6 enable setting — *settings architecture measured*

### B2a. How settings actually work here

**Storage — one table, measured:**

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)
```

Eight rows live today: `ot_enabled`, `ot_threshold`, `ot_multiplier`,
`hours_format`, plus four migration markers.

**There are two accessor patterns, and Phase 6 should copy the second:**

| Pattern | Where | Shape |
|---|---|---|
| Generic | `periods.js:51` — `getSetting(k, fallback)` / `setSetting(k, v)` | Caller supplies the default at every call site |
| **Module-owned** | `timeclock.js:401` — a `DEFAULTS` map + `setting()` + `settings()` + `saveSettings()` | **The default lives in one place**, an absent key resolves through it, and one typed object is exported |

The Time Clock pattern is the right precedent: `DEFAULTS` at `timeclock.js:404`
holds eight keys including `tc_day_cutoff: '4'` and booleans as `'1'`/`'0'`
(`tc_break_paid`, `tc_require_service`, `tc_alerts`). `setting(k)` returns
`DEFAULTS[k]` when the row is absent — which is exactly the behaviour a feature
flag needs, because **no row must mean the sane default, not `undefined`.**

**Recommendation:** `scheduler.js` gains its own `DEFAULTS` + `settings()` +
`saveSettings()` in the same shape. Key name: **`sch_availability`**, values
`'1'`/`'0'`, matching the `tc_*` prefix convention.

### B2b. Where it goes in the owner UI

**Measured, and this is a real finding:** `/settings` (`server.js:17621`) is
**not a page of toggles.** It is a card index built from `SETTINGS_GROUPS` in
`nav.js:142`, where each card links to a dedicated page. Three groups exist —
Restaurant, Account, Staff-facing — and **there is no Schedule card and no Time
Clock card in it at all.** Time Clock settings are reached from inside Time
Clock, not from `/settings`.

So there is no existing toggle page to append a checkbox to. Two options:

| Option | Cost | Verdict |
|---|---|---|
| A new `/schedule/settings` page, plus a **Schedule** card in `SETTINGS_GROUPS` | One route, one small page, one nav entry | **Recommended.** Phase 7 (templates) and Phase 8 (four claim/replacement toggles) both need this page to exist. Building it once, now, for one toggle is cheaper than building it in Phase 8 for five |
| Hang the toggle off the existing Time Clock settings surface | Nearly free | **No.** It is not a Time Clock concept, and it buries a scheduling setting where nobody scheduling will look |

### B2c. Default value

| Install | Default | Why |
|---|---|---|
| **This restaurant** | **ON** | You are about to ask staff to use it. Shipping it off means the feature exists and does nothing until you find the switch |
| **A fresh install** | **OFF** | A new restaurant should not have employees submitting availability before the owner has decided that is how they want to run. Note this interacts with `docs/ZWIN-MULTI-TENANCY.md` — a fresh install is not yet actually fresh |

Implemented as `DEFAULTS.sch_availability = '1'` plus a **one-time migration
that writes `'0'` only when the database has no employees** — i.e. a genuinely
new install. *Inferred:* I have not tested that predicate; "no employees" is the
cheapest available proxy for "fresh" and should be asserted by the same test
that covers B11.

### B2d. What each surface does when it is OFF

The brief's warning — *avoid a dead toggle* — cuts both ways. Off must be
coherent, not just hidden.

| Surface | When OFF |
|---|---|
| Employee "My availability" tab | Reverts to the **existing `.ps-soon` locked panel**, with copy that says the restaurant has not turned it on — not "coming soon", which would be a lie once it exists |
| Employee submitting availability or time off | Routes **refuse server-side**, not merely hidden in the UI. A hidden control is not a permission |
| Stored rules and requests | **Preserved, untouched.** Turning a feature off must never delete data. Turning it back on restores exactly what was there |
| Scheduler Issues (`unavailable:`, `timeoff:`) | **Suppressed.** Warnings derived from data the manager cannot see or act on are unactionable noise |
| Manager requests queue | Existing pending time-off requests **stay visible and remain decidable**. See B13 |
| Drawer availability context line | Hidden |
| Phase 8 (later) | The eligibility evaluator treats availability as *"not stated"* rather than *"available"* — a distinction B6 preserves deliberately |

---

## B3. Does the setting govern availability only, or both halves?

**Recommendation: both — one switch for the whole of Phase 6.**

The roadmap's wording is *"enable employee availability."* Read literally that is
option A. I recommend **B** anyway, and the reason is not convenience:

1. **They ship on the same screen.** Both live in the "My availability" tab, on
   the same day rows, behind the same `.pes` sheet. Option A leaves the tab
   half-alive — a screen whose three actions are *Mark unavailable* (dead),
   *Prefer to work* (dead) and *Request time off* (live). That is a worse
   experience than either fully-on or fully-off.
2. **A "Phase 6 is on" flag is the thing that is actually true.** Two flags
   invite the incoherent state where staff can request time off but cannot say
   they are unavailable, which no restaurant wants and which doubles the
   suppression matrix in B2d.
3. **Splitting later is cheap.** Adding `sch_timeoff` when someone asks for it is
   one key in the same `DEFAULTS` map. Merging two flags after they ship is not.

**This is a genuine deviation from the roadmap's literal wording**, and per §VI
it is reported rather than taken silently. If you prefer literal availability-only
scope, say so and B2d's table splits in two.

---

## B4. Accessibility and mobile — *measured against the existing portal*

The headline: **the portal's primitives are already good, and Phase 6's job is to
use them rather than invent controls.** Evidence from `public/staff.css`:

| Requirement | Status today | Phase 6 action |
|---|---|---|
| **44px+ touch targets** | **Already exceeded** — `min-height: 48px` (`staff.css:120`, `:513`), `56px` (`:433`), `58px` (`:208`), `50px` at the small breakpoint (`:229`) | Reuse those classes. Do not introduce a smaller control |
| **Safe-area handling** | **Comprehensive** — `env(safe-area-inset-top)` and `-bottom` at `:61`, `:114`, `:128`, `:159`, `:205`, `:299`, `:318`, `:323`, `:327` | Any new sheet must carry `calc(x + env(safe-area-inset-bottom))` on its footer |
| **Bottom-nav clearance** | Handled by the same pattern | The availability day list must not end flush against the tab bar |
| **Tap latency / double-tap zoom** | `touch-action: manipulation` + `-webkit-tap-highlight-color: transparent` (`:148`, `:210`, `:221`) | Carry onto every new button |
| **Reduced motion** | `@media (prefers-reduced-motion: reduce)` on the sheet (`:643`) | The availability sheet inherits `.pes`, so this is free — provided it *is* `.pes` |
| **Focus-visible** | `.ps-t:focus-visible { outline: 2px solid }` (`:1584`) | Reuse. Note the `.bs *` box-shadow trap is **broadsheet-only** — shadows work in the portal, but the manager-side drawer context is broadsheet and must use `outline`/`border` |
| **Focus trap + return** | **Exists** — a real trap at `server.js:3628` (Shift+Tab and Tab wrap), and focus return at `:3603` | The availability sheet must adopt it. This is the one place a new sheet silently regresses |
| **Time and date inputs** | **Native already** — `.pes-row input[type="date"]`, `input[type="time"]` (`:658`, `:659`) with width caps | **Use native pickers.** A custom time control is the single most likely accessibility regression in this phase |
| **Screen-reader labels** | 168 `aria-*` attributes; 65 `aria-label`, 8 `aria-labelledby`, 8 `aria-current`, 6 `aria-pressed`, 5 `aria-modal` | `aria-pressed` is the right primitive for the all-day/timed toggle; `aria-current` for the selected day in the strip |
| **Error / decision announcement** | `aria-live="polite"` used sparingly — 3 sites, plus a `.pt-sr` visually-hidden class (`server.js:5050`) and a `role="status"` pattern (`:12726`) | Announce submit success and approval outcome through `role="status"`, **not** by making the day list itself live |
| **A caution already learned here** | `server.js:6585` records that a card was **de-**`aria-live`'d because a ticking value announced constantly | Do not make anything that updates on a timer a live region |
| **Status not by colour alone** | Portal chips carry text (`Earnings unavailable`, `tc-chip warn`) | Pending / approved / rejected must each carry a **word**, not just a colour |
| **High text zoom (200%)** | Partially evidenced — `.pes-row` wraps at a breakpoint (`:661`), `.ps-row` narrows its date column 46px → 38px (`:1587`) | **Not verified at 200%.** Must be measured in the browser per CLAUDE.md, not asserted from CSS |
| **Mobile keyboard overlap** | No evidence found either way | **Open risk.** A reason textarea at the bottom of a bottom-sheet is the classic case. Measure it |
| **Long employee reason text** | No existing precedent | Clamp in the queue, full text in the detail view. Never on the Week Board (§36) |

**Controls that would need building from scratch — and the recommendation for each:**

| Control | Verdict |
|---|---|
| Weekday multi-select (recurring rules) | Build from checkboxes/`aria-pressed` buttons at 48px. **Not** a custom widget |
| Date-range picker (multi-day time off) | **Two native `input[type="date"]` fields.** A custom range calendar is the highest-risk control in the phase and buys nothing on a phone |
| Time range | Two native `input[type="time"]`, already styled |
| Effective from/until | Two native `input[type="date"]`, optional, collapsed behind "Advanced" |

**Nothing in Phase 6 requires a custom calendar or a custom time control.** That
is the single most useful sentence in this section.

---

## B5. Overnight recurring availability

**The case:** *Friday unavailable 10:00pm – 2:00am.* In a restaurant this is
ordinary, not exotic.

### B5a. The four candidate models

| Model | Employee mental model | Query cost | Effective dates | One-off exceptions | Phase 8 reuse | Verdict |
|---|---|---|---|---|---|---|
| **A. One row, `end_min <= start_min` means next day** | One rule, exactly as stated | One extra branch in the overlap test | Clean — one rule, one `effective_from` | Clean — one `on_date` row, same convention | Clean | **Recommended** |
| B. Split into Fri 22:00–24:00 + Sat 00:00–02:00 | Enters one rule, sees two. Deleting one leaves an orphan half | Simplest query | **Breaks** — two rows to keep in step | Breaks — an exception must cancel both halves | Fine | No |
| C. Two linked rows with a parent id | Same as B, plus a join | Worse | Worse | Worse | Worse | No |
| D. RRULE strings | Opaque; needs a parser | Needs a library or a hand-rolled parser | Encoded in the string | Awkward | Awkward | No — far too heavy for weekday+range |

**A wins because the employee enters one logical rule and stores one row.** The
convention is a single documented sentence: *if the end minute is less than or
equal to the start minute, the range ends on the following day.*

`start_min == end_min` is the one genuinely ambiguous input (a zero-length range,
or a full 24 hours?). **Recommendation: reject it at entry** — an all-day rule is
what `all_day` is for.

### B5b. Locked expected behaviours

Given a recurring rule **Friday unavailable 22:00 → 02:00**, resolving to the
UTC instants `Fri 22:00` → `Sat 02:00` for each occurrence:

| Case | Expected |
|---|---|
| Shift **Fri 23:00 – 01:00** | **Conflict.** Fully inside the window |
| Shift **Sat 01:00 – 03:00** | **Conflict.** Overlaps 01:00–02:00. Note the rule is stamped *Friday* and the shift's business date is *Friday* too (4am cutoff) — but the comparison must not rely on that agreeing |
| Shift **Sat 02:00 – 04:00** | **No conflict.** Ranges are half-open: end is exclusive, so a 02:00 start touches but does not overlap |
| Shift **Sat 22:00 – 23:00** | **No conflict.** The rule is Friday's, and Saturday's occurrence is a different instant window |
| `effective_until = Friday` on the recurrence | **The tail still applies.** The occurrence *starts* on the last effective Friday, so it runs to Saturday 02:00. Effective dates bound **when a rule starts**, not where its window lands |

That last row is the one that gets implemented wrong. It is why the model must
compare **instants, not day labels** — the same conclusion §5 reached for time
off, now applied to recurring rules.

### B5c. Why this is not the business-date question

`TC.businessDateOf` answers *"which trading day does this belong to."* Overnight
availability asks *"does this instant fall inside a stated window."* They agree
most of the time and disagree between midnight and 4am — exactly the gap
CLAUDE.md records as having broken five pages once. **Do not route availability
through the business date.** Resolve both sides to UTC instants and overlap them,
as `overlapsFor` already does for shifts.

---

## B6. The Phase 8 shared seam

The roadmap is explicit: claims and replacements use **one** evaluator over
*employee active · holds the required position · no overlapping assignment ·
availability · approved time off*, and **"Do not duplicate this logic."**

### B6a. What already exists — *measured*

| Concern | Where it lives today | Reusable? |
|---|---|---|
| Holds the position | `heldPositions(id)` / `heldPositionsFor(ids)` — `scheduler.js:262`, `:275`. Exported | **Yes, as-is** |
| Employee active | `emp.byId` + the create guard at `scheduler.js:330` | Yes |
| Position still active | `positions.bySlug` + `scheduler.js:322` | Yes |
| Overlapping assignment | `overlapsFor(shift)` | Yes |
| Availability / time off | **Does not exist.** Phase 6 builds it | — |

**The critical asymmetry, measured:** `validate()` (`scheduler.js:301`)
**refuses** on qualification, inactive employee, retired position and impossible
times — it throws `ScheduleError`. But `issuesFor()` (`:1032`) **warns** on
qualification for shifts that were valid when created. So qualification is a hard
block at create time *and* a soft issue afterwards.

Availability is **only ever soft**. If Phase 6 returns a boolean, Phase 8 cannot
tell "refuse this claim, they don't hold the position" from "allow this claim but
warn, they said they were unavailable" — and will rebuild the distinction itself.
That is the duplication the roadmap forbids, and a boolean is what causes it.

### B6b. The recommended contract

**Phase 6 builds only the availability half, and returns facts, not a verdict:**

```
availabilityFor(employeeId, startsAtUtc, endsAtUtc) -> {
  state:   'available' | 'unavailable' | 'preferred',   // 'available' = nothing stated
  stated:  boolean,        // false when no rule applies — NOT the same as available
  rules:   [{ id, kind, source: 'recurring' | 'one-off' }],
  timeOff: null | { id, status: 'pending' | 'approved', allDay },
}
```

Three properties that make it reusable:

1. **`stated` is separate from `state`.** "No rule" and "explicitly available"
   read identically to a caller that only sees `state`. Phase 8 wants to know the
   difference (B2d relies on it too, when the setting is off).
2. **`timeOff` carries `status`**, so pending and approved are one call, and the
   caller decides what each means. #13 becomes a policy at the call site, not a
   fact baked into storage.
3. **It returns `rules`**, so the drawer can say *which* rule conflicts without a
   second query.

**A batch form is required, not optional:** `availabilityForMany(ids, start, end)`.
`issuesFor` already batches positions through `heldPositionsFor` for exactly this
reason — a per-employee call inside the week loop is the shape that turns 0.25 ms
into something worth measuring.

---

## B7. Resolver vs evaluator — do not build a monolith

**Recommendation: three layers, and Phase 6 builds only the middle one.**

```
qualification   heldPositions() / positions.bySlug / emp.active   ← EXISTS
availability    availabilityFor()                                  ← PHASE 6
eligibility     canClaim() = compose(qualification, availability,  ← PHASE 8
                              overlapsFor, active state)
```

**This is better than making Phase 6's resolver own eligibility, for three
reasons:**

1. **Different lifetimes.** Qualification is a hard refusal; availability is a
   soft warning. One function returning one verdict has to flatten that, and the
   flattening is where the meaning is lost (B6a).
2. **Different storage.** Qualification lives in `employees` / `employee_roles`.
   Merging it into an availability table would duplicate the roster into the
   scheduling domain — the exact anti-pattern §38 refuses for positions.
3. **The roadmap asks for shared logic, not one function.** Composition satisfies
   *"do not duplicate"* while keeping each piece independently testable.

**Phase 6 must not create `canClaim()`.** Building the Phase 8 evaluator now
means designing against imagined requirements. What Phase 6 owes Phase 8 is a
signature that does not have to change — which B6b provides.

---

## B8. Naming collisions, and the convention that avoids the next one

**Three existing meanings of "availability"/"unavailable" — all measured:**

| Existing name | Where | Means |
|---|---|---|
| `PORTAL_NAV.availability` | `server.js:3437` | Whether a nav tab is usable |
| `Earnings unavailable` | `server.js:5807`, `:6012` | A pay figure could not be computed |
| **`kind: 'unavailable'`** | **`server.js:3747`** | **A shift the tip engine could not cost** |

The third is the dangerous one. It is a `kind:` on a pushed object in a derived
list — structurally identical to a scheduler issue kind — and it is about
**money**. A future reader who greps `kind: 'unavailable'` will find a tip-engine
failure state and reasonably believe they have found Phase 6's issue kind.

**Recommended conventions — prefixed, never bare:**

| Thing | Convention | Example |
|---|---|---|
| Availability rule type | `avail_*` | `avail_unavailable`, `avail_prefer` |
| Issue kinds | Keep the Phase 4 `kind:id:id` key shape, with domain-qualified kinds | `unavailable:<shiftId>:<ruleId>` → **`avail_conflict:<shiftId>:<ruleId>`**, and `timeoff:<shiftId>:<requestId>` |
| Resolver result | `state` values stay bare (`available`/`unavailable`/`preferred`) because they are scoped inside a documented return type, never pushed onto a shared list | — |
| Setting key | `sch_*`, matching `tc_*` | `sch_availability` |
| Tables | `availability_rules`, `time_off_requests` | — |

**This changes one recommendation from §16-17**: the audit proposed the issue kind
`unavailable:<shiftId>:<ruleId>`. That collides head-on with `server.js:3747`.
**Use `avail_conflict:` instead.** Do not rename the existing tip-engine code.

---

## B9. The intentional test migration

**The test — measured, `test/schedule-publish.test.js:682`:**

```js
test('My availability is present and honestly empty', async () => {
  const html = await text('/portal/schedule?v=avail', { cookie });
  assert.match(html, /My availability/);
  assert.match(html, /coming later/i);
  // Phase 6 owns the real thing. Nothing here may imply it works.
  for (const fake of ['Save', 'Request time off', 'Prefer', 'Unavailable', 'Repeat']) {
    assert.ok(!new RegExp(`>${fake}`, 'i').test(html), `no ${fake} control`);
  }
});
```

**Why it exists:** a locked tab that *looks* functional is worse than one that
says nothing. It guards against a placeholder shipping controls that do not work.

**Why it must change:** those five strings are the exact controls Phase 6 ships.
The test fails the moment the feature works — by design, in the same way Phase 3
knowingly flipped `PORTAL_NAV`'s locked assertions.

**Do not delete the guard. Replace its purpose.** Five assertions inherit the
intent:

1. **The tab is active only when intended** — with `sch_availability` off, the
   locked panel renders and none of the five controls appear. *(The original
   assertion, preserved, now conditioned on the setting.)*
2. **Controls belong to the authenticated employee only** — every rendered rule
   and request id resolves to `who.emp.id`.
3. **No coworker access** — a forged request or rule id belonging to another
   employee returns 404, not 403 and not the row. Mirrors
   `/portal/schedule/shift/:id`.
4. **Nothing leaks into Only me / Everyone** — extend the existing Phase 3
   *source-text* assertion to the new fields rather than writing a new test.
5. **Writes are refused server-side when the setting is off** — not merely hidden.

---

## B10. Updated likely-files list

Superseding §27. **Files confirmed to exist unless marked new.**

| File | Why |
|---|---|
| `src/db.js` | Two tables + four indexes |
| `src/scheduler.js` | `availabilityFor`, `availabilityForMany`, two issue kinds in `issuesFor`, **plus the new `DEFAULTS`/`settings()`/`saveSettings()` trio** (B2a) |
| `src/server.js` | Portal availability view, request routes, manager queue rows, drawer context, **the new `/schedule/settings` page** |
| `src/nav.js` | **A Schedule card in `SETTINGS_GROUPS`** (`nav.js:142`) |
| `public/staff.css` | `.ps-av*` — reusing `.pes`, `.ps-strip`, `.ps-row` |
| `public/broadsheet.css` | Drawer context line. **`outline`/`border` only** — `.bs *` kills box-shadow |
| `test/schedule-availability.test.js` | **New** — resolver, precedence, overnight (B5b), migration invariant (B11) |
| `test/schedule-issues.test.js` | Two new kinds |
| `test/portal.test.js` | The employee surface |
| **`test/schedule-publish.test.js`** | **The B9 migration. Was missing from §27** |
| `test/settings.test.js` *(or nearest existing)* | The setting's off-state behaviour — **filename not verified; check the repo before assuming** |

---

## B11. The default-availability invariant — non-negotiable

**No availability rows = available. This is the highest-risk item in the phase**
and it must be asserted by tests, not assumed.

Every consequence, each individually testable:

1. **Migration changes no existing employee.** All 84 have zero rows; the board
   after deploy is identical to the board before.
2. **Issue count is zero immediately after migration.** Not "low" — zero.
3. **No seed rows, ever.** Not for new employees, not for existing ones, not in
   `seed.js`, not in `backfill.js`.
4. **Deleting the last rule returns to available.** Not to "unknown", not to a
   blocked state.
5. **"Available — all day" may be displayed without persisting anything** (#24).
   The display is derived from the absence of a rule.
6. **The setting being OFF must not reinterpret zero rows.** Off means *not
   stated*; it never means unavailable. B6b's `stated` flag exists for this.

---

## B12. Pending time off — placement

Recommendation unchanged: **manager context, not a Scheduler Issue.**

- An employee must not be able to put a warning on your board unilaterally, just
  by asking.
- You still need to see it, or you look like you ignored the request.
- **Approval is the moment it becomes a real scheduling conflict.**

**Where pending context appears:**

| Surface | Shows pending? |
|---|---|
| Manager requests queue | **Yes** — this is where it is answered |
| Create/edit drawer, for that employee on that date | **Yes** — a context line, at the moment of the decision |
| Employee's own availability detail | **Yes** — their own status |
| Week Board issue count | **No** |
| Issues drawer | **No** |
| Publish | **No** |

---

## B13. The setting × pending-request interaction

Because B3 recommends the setting governs **both** halves, "off" must not
abandon work already in flight:

| Thing | When the setting is turned OFF |
|---|---|
| Existing pending requests | **Preserved and still decidable.** They stay in the manager queue. Turning a feature off must not silently deny someone's holiday |
| Manager requests queue | Keeps showing them, with a note that availability is switched off, until the backlog is cleared |
| Approved future time off | **Preserved.** Never deleted |
| Approved-time-off Issues | **Suppressed**, consistent with B2d — the manager cannot act on availability data that is switched off |
| Employee submitting *new* time off | **Refused server-side.** The tab shows the locked panel |

The asymmetry is deliberate: **stop new input, honour existing commitments.**
Anything else means flipping a switch can quietly revoke a day off somebody was
already promised.

---

## B14. Effective-date edge cases

| Question | Answer | Why |
|---|---|---|
| Is `effective_from` inclusive? | **Yes** | "From the 1st" means the 1st |
| Is `effective_until` inclusive? | **Yes** | "Until the 30th" means the 30th is still covered. An exclusive end is the off-by-one everyone writes |
| Overnight rule whose window crosses past `effective_until` | **The tail applies.** Bounds gate when an occurrence *starts* | B5b, row 5 |
| One-off exception outside the recurrence's effective range | **It still applies.** A one-off is not a modifier on a recurring rule; it is its own row, ranked above it by specificity (#21) | Otherwise deleting a recurrence would silently void unrelated exceptions |
| Editing a rule | **Never retroactive.** Close the old row with `effective_until` and insert a new one | Same discipline as `shifts.policy_id` and `scheduled_shifts.daypart`: history does not move |

---

## B15. Availability edits after scheduling — confirmed locked

No change from §32–34. Restated because the brief asked for confirmation:

- Availability changes **do not** mutate an existing shift
- **Do not** cancel it
- **Do not** unpublish it
- The derived Issue **recomputes** on the next render — already supported, since
  `issuesFor` re-derives every time
- The **manager resolves it manually**

Approved time off follows the identical rule. **Nothing in Phase 6 auto-edits a
schedule.**

---

## B16. Recommendations that changed from Part I

| # | Was | Now | Why |
|---|---|---|---|
| Issue kind | `unavailable:<shiftId>:<ruleId>` | **`avail_conflict:<shiftId>:<ruleId>`** | Direct collision with the tip engine's `kind: 'unavailable'` (`server.js:3747`) — B8 |
| Resolver signature | `-> { state, timeOff }` | **Adds `stated` and `rules`, plus a batch form** | A boolean-ish result forces Phase 8 to rebuild the hard/soft distinction — B6 |
| Likely files | 6 files | **11**, adding `schedule-publish.test.js`, `nav.js`, and the settings surfaces | B9, B10 |
| Setting | Not mentioned at all | **A full decision (#35) with default, scope and off-state behaviour** | Roadmap §III requires it |
| Overnight rules | Not addressed | **One row, `end_min <= start_min` means next day**, with five locked behaviours | B5 |
| A11y | One passing phrase | **A full section**, and the finding that no custom control is needed | B4 |

**Nothing in Part I was found to be wrong.** Every change above is an addition
or a rename, not a reversal.

---

## B17. What is still genuinely unresolved

Three, and I would not call any of them blockers:

1. **The setting's scope (B3)** — I recommend it governs both halves, which
   deviates from the roadmap's literal *"enable employee availability."* This is
   the one place I have knowingly gone past the wording, and it is yours to
   overrule.
2. **200% text zoom, and mobile-keyboard overlap on the reason field (B4)** —
   there is no existing evidence either way in the codebase. Per CLAUDE.md these
   must be **measured in the browser**, and they cannot be measured until the
   screen exists. They belong at the end of the build sequence, not the start.
3. **Performance (§42)** — still unmeasured, and still honestly so. It should be
   measured at step 2 of the sequence, right after the resolver exists and
   before any UI is built on top of it.

Everything else in the 34 has a recommendation with evidence behind it.
