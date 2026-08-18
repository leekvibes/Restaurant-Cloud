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

---

# PART TWO — AUDIT COMPLETION

Added 2026-08-14, at `f8ccea4`. Completes the two things the gap check found
missing: one table carrying all 34 product decisions, and the four audit areas
that were never written. Still audit only — no production code, no test changes,
no schema.

Research for this part was **measured**: the settings pattern, the portal's
accessibility primitives, the cross-midnight precedent and the qualification
seam were all read from source. Where a recommendation rests on judgement rather
than code, it says so.

---

## B1. The 34 decisions — the approval sheet

Read this table top to bottom. Every row has an answer. **Status** says how much
of a choice it really is:

- **LOCKED** — the roadmap, a prior phase, or migration safety already decided
  it. Changing it means changing something upstream.
- **REC** — a recommendation with clear evidence. Approve or overrule.
- **OPEN** — genuinely ambiguous. Your call, and the recommendation is weaker.

| # | Decision | Recommendation | Status |
|---|---|---|---|
| 1 | Default when an employee has no rules | **Available** | LOCKED |
| 2 | Do availability changes need manager approval? | **No** — only time off does | LOCKED |
| 3 | Is prefer-to-work all-day, timed, or both? | **Both** — same columns as any rule | REC |
| 4 | Do recurring rules need effective dates? | **Yes** — `effective_from` / `effective_until`, both nullable | REC |
| 5 | How are one-off exceptions modelled? | **Same table.** `weekday` set = recurring, `on_date` set = one-off | REC |
| 6 | Time-off statuses | **pending · approved · rejected · withdrawn.** No `applied` | REC |
| 7 | Partial-day time off | **Yes** — same row, `all_day` is a flag | REC |
| 8 | Multi-day requests | **One request**, not one row per day | REC |
| 9 | Can an employee edit a pending request? | **No** — withdraw and resubmit | REC |
| 10 | Can an employee withdraw an *approved* request? | **No** — ask the manager | REC |
| 11 | Is a reason required? | **Optional** | REC |
| 12 | Can managers add private review notes? | **A note, but NOT private** — the employee sees it | OPEN |
| 13 | Does pending time off affect the Scheduler? | **Drawer context only** — not an Issue, not in the count | OPEN |
| 14 | Shift during stated unavailable | **Warn, allow.** Severity `review` | LOCKED |
| 15 | Shift during approved time off | **Warn, allow.** Severity `action` | LOCKED |
| 16 | Do Issues persist after a manager overrides? | **Yes** — no dismissal | LOCKED |
| 17 | Immediate warning on create/edit? | **Yes**, through the same helper the Issues engine uses | REC |
| 18 | Integrate with the Phase 4 Issues drawer? | **Yes** — two new kinds, nothing structural | LOCKED |
| 19 | Notify managers when availability changes? | **No** — weekly per-employee edits would be noise | REC |
| 20 | Notify managers on a time-off request? | **Yes** — on submit and withdraw | REC |
| 21 | Notify the employee on approve/reject? | **Yes** — `reqTell` already does exactly this | REC |
| 22 | Where do managers review requests? | **The existing Time Clock requests queue** | REC |
| 23 | Where do managers see availability while scheduling? | **The create/edit drawer's employee context line** | REC |
| 24 | Does the UI show "Available — all day" by default? | **Yes, as display only** — never stored | REC |
| 25 | Ship prefer-to-work at all? | **Yes, with no issue and no warning** | OPEN |
| 26 | Recurrence model | **weekday 0–6 + start/end minutes.** No RRULE, no generated instances | REC |
| 27 | Overnight availability ranges | **One rule.** `end_min <= start_min` means it ends next day | REC |
| 28 | Availability changed after shifts exist | **Nothing mutates.** The Issue re-derives | LOCKED |
| 29 | Time off approved after shifts exist | **Same** — nothing mutates | LOCKED |
| 30 | Does any of this block Publish? | **No** | LOCKED |
| 31 | Which permission governs manager approval? | **The existing `schedule` area** | REC |
| 32 | What history stays visible? | Rejected/withdrawn stay in the employee's own history; invisible to schedule checks | REC |
| 33 | Employee-wide or per-position availability? | **Employee-wide** | REC |
| 34 | Adopt the reference interaction model? | **Structure yes; calendar grid and "set available" control no** | REC |
| **S1** | **The roadmap's "enable employee availability" setting** | **Ship it, default ON, governing availability only** | **OPEN** |

**S1 is numbered separately** so the brief's 34 keep their numbers. It is a
roadmap requirement (§III) that the first audit missed entirely.

### Impact matrix

`S` schema · `E` employee UI · `M` manager UI · `I` Issues engine ·
`N` notifications · `8` Phase 8 compatibility.

| # | S | E | M | I | N | 8 | # | S | E | M | I | N | 8 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | – | ✓ | ✓ | ✓ | – | **✓** | 18 | – | – | ✓ | ✓ | – | ✓ |
| 2 | – | ✓ | – | – | – | – | 19 | – | – | – | – | ✓ | – |
| 3 | ✓ | ✓ | ✓ | – | – | ✓ | 20 | – | – | ✓ | ✓ | – |
| 4 | ✓ | ✓ | – | ✓ | – | ✓ | 21 | – | ✓ | – | – | ✓ | – |
| 5 | ✓ | ✓ | ✓ | ✓ | – | ✓ | 22 | – | – | ✓ | – | ✓ | – |
| 6 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 23 | – | – | ✓ | – | – | – |
| 7 | ✓ | ✓ | ✓ | ✓ | – | ✓ | 24 | – | ✓ | – | – | – | – |
| 8 | ✓ | ✓ | ✓ | ✓ | – | ✓ | 25 | ✓ | ✓ | ✓ | – | – | ✓ |
| 9 | – | ✓ | – | – | – | – | 26 | ✓ | ✓ | – | ✓ | – | ✓ |
| 10 | – | ✓ | ✓ | – | ✓ | – | 27 | ✓ | ✓ | – | ✓ | – | **✓** |
| 11 | ✓ | ✓ | ✓ | – | – | – | 28 | – | – | ✓ | ✓ | – | – |
| 12 | ✓ | ✓ | ✓ | – | ✓ | – | 29 | – | – | ✓ | ✓ | – | – |
| 13 | – | – | ✓ | **✓** | – | ✓ | 30 | – | – | ✓ | – | – | – |
| 14 | – | – | ✓ | ✓ | – | ✓ | 31 | – | – | ✓ | – | – | ✓ |
| 15 | – | – | ✓ | ✓ | – | ✓ | 32 | – | ✓ | ✓ | – | – | – |
| 16 | – | – | ✓ | ✓ | – | – | 33 | ✓ | ✓ | ✓ | ✓ | – | **✓** |
| 17 | – | – | ✓ | ✓ | – | ✓ | 34 | – | ✓ | – | – | – | – |
| | | | | | | | **S1** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### Evidence and consequence, per decision

**1 — Default available.** *Evidence:* all 84 current employees have zero rows,
because the table does not exist. *Consequence:* any other reading marks the
whole roster unavailable on deploy and lights the board with Issues for a
schedule that was correct yesterday. *Impact:* none — it is the absence of a
rule, which is why "available" is never stored (§6). This is the highest-risk
decision in the phase and the only one where being wrong is immediately visible
to everybody.

**2 — No approval for availability.** *Evidence:* the roadmap says a manager
*"may override with a warning"*, which an approval step contradicts. *Consequence:*
availability takes effect on save; time off remains the reviewed path.

**3 — Prefer-to-work both.** *Evidence:* `all_day` + `start_min` + `end_min`
already serve unavailable; a preference needs no different shape. *Consequence:*
one row type covers all three kinds.

**4 — Effective dates.** *Evidence:* without them, an employee changing their
regular Tuesday retroactively rewrites whether last month's schedule was ever
valid. *Consequence:* history stops moving. *Impact:* two nullable columns and a
date predicate in the resolver. See §B14 for the inclusivity edges.

**5 — One-off in the same table.** *Consequence:* precedence falls out of
specificity rather than needing a rules engine (§21). *Impact:* one table, one
query, a `CHECK` that exactly one of `weekday`/`on_date` is set.

**6 — Four statuses.** *Evidence:* `time_corrections` carries `applied_at`
because a decision and its effect are separate writes there; for time off,
approval *is* the effect. *Consequence:* the Issues engine reads status directly.

**7, 8 — Partial and multi-day.** *Evidence:* a full day is a range too; a
multi-day absence is one conversation. *Consequence:* one row, `all_day` a
display convenience. Daily rows would make withdraw and approve loop.

**9, 10 — Edit and withdrawal.** *Evidence:* the correction precedent has no
employee edit — a pending request can only be decided. *Consequence:* pending is
withdraw-and-resubmit; approved cannot be pulled unilaterally because a manager
has already scheduled around it.

**11 — Reason optional.** *Consequence:* a required reason invites either
fiction or oversharing, and §36 already keeps free text off the board.

**12 — Manager note, not private. OPEN.** *Evidence:* `time_corrections` has
`decision_note` separate from the employee's `reason`, and `reqTell` already
carries an outcome to the employee. *Consequence:* a decline with no stated
reason is the version people escalate about. *Why OPEN:* a note the employee
cannot see is a different feature with a different risk — it would be the first
place in ZWIN storing manager-only text about a named person, on an unencrypted
database. Recommend visible; if you want private notes, that needs its own
decision about who else can read them.

**13 — Pending is context, not an Issue. OPEN.** See §B12.

**14, 15 — Warn, never block.** *Evidence:* Phase 2 overlap, Phase 4
qualification and Phase 5 all warn. *Consequence:* the manager keeps final
responsibility, which the roadmap assigns to them explicitly.

**16 — Issues persist.** *Evidence:* Phase 4 established issues as derived with
no dismissal. *Consequence:* an override flag would be dismissal by another
name. Fix the schedule or the request, and the issue goes.

**17 — One helper, two callers.** *Evidence:* `sbOverlapNote` lived in the route
and so duplicate/copy-week never warned until Phase 4 derived it centrally.
*Consequence:* the create/edit warning and the Issues engine cannot disagree.

**18 — Two new kinds.** `issuesFor()` already returns
`{key, kind, severity, employeeId, businessDate, shiftIds}` and
`ISSUE_SEVERITY` is a plain map at `scheduler.js:1025`. *Impact:* two entries in
that map, two blocks in the loop. Nothing structural.

**19, 20, 21 — Notification direction.** *Evidence:* `PORTAL.adminNotify`,
`PORTAL.notify`, `reqTell` and `notifyOnce` all exist. *Consequence:* the office
hears about requests, not about somebody editing their Tuesday. **Note the fresh
precedent:** three notifications were removed on 2026-08-14 for firing on nearly
every save. A notification per availability edit would have been the fourth.

**22 — The existing queue.** *Evidence:* `/timeclock/requests/all` and
`pendingCorrections` already exist with a review UI. *Consequence:* no new HR
area, and one place a manager looks for "things waiting on me".

**23 — The drawer.** *Evidence:* the employee context line added in `e951f3f`
already says what that person has that day. *Consequence:* availability appears
where the decision is made.

**24 — Displayed, never stored.** *Evidence:* §22. *Consequence:* the line is
rendered from the absence of rules; deleting the last rule returns to it
automatically.

**25 — Prefer-to-work, silent. OPEN.** *Evidence:* the roadmap said *"preferred
working times if they earn their keep"* and never resolved the conditional.
*Recommendation:* ship it with no issue and no warning — it earns its keep by
being visible while scheduling, not by firing. *Why OPEN:* the honest
alternative is to cut it from Phase 6 entirely and see whether anyone asks.

**26 — Weekday plus minutes.** *Evidence considered:* RRULE strings and
generated instances were the alternatives the brief asked about. RRULE brings a
parser and a dependency for recurrence nobody has asked for beyond weekly;
generated instances mean writing rows into the future and deciding how far,
then rewriting them when a rule changes. *Consequence:* a weekday integer and
two minute integers answer every case in the brief's §7 examples, and the
resolver stays a date predicate.

**27 — One overnight rule.** See §B5.

**28, 29 — Nothing auto-edits.** *Evidence:* `issuesFor` re-derives on every
render, so this is already supported. *Consequence:* the manager resolves; the
schedule is never silently rewritten.

**30 — Publish never blocks.** *Evidence:* Publish calls no validation at all
today. *Consequence:* adding a block here would be the first, contradicting
Phases 2, 4 and 5.

**31 — The `schedule` area.** *Evidence:* `nav.js` `AREAS` — `schedule` is a new
key and new keys are closed by default, so a restricted account does not get
approval powers by accident. *Consequence:* no second permission system.

**32 — History stays.** *Consequence:* a rejected request is the record that the
conversation happened. Deleting it makes "you never asked" unanswerable.

**33 — Employee-wide.** *Evidence:* a time range already expresses the real
constraint — *"I can't do dinner"* **is** *"unavailable after 4pm"*.
*Consequence:* avoids multiplying rows and precedence by position. **Phase 8
note:** eligibility still checks position, because qualification is a separate
evaluator (§B7) — employee-wide availability does not weaken it.

**34 — Structure yes, chrome no.** *Evidence:* `.ps-strip`, `.ps-row`,
`.ps-wknav` and the `.pes` sheet already exist and are already tested.
*Consequence:* no new overlay pattern. Simplify away the calendar grid and any
explicit "set available" control, which has no semantic effect once absence
means available.

**S1 — The setting.** See §B2 and §B3.

---

## B2. The Phase 6 enable setting — *storage measured, behaviour recommended*

The roadmap (§III) says Phase 6 introduces **"enable employee availability"**.
The first audit never mentioned it.

### The existing pattern

| Question | Answer, read from source |
|---|---|
| Storage | `settings` — `key TEXT PRIMARY KEY, value TEXT`. Nothing else |
| Generic read | `getSetting(key, fallback)`, `src/periods.js:51` |
| Feature-flag precedent | **`ot_enabled`** — `src/overtime.js:52`, `read('ot_enabled','0') === '1'` |
| How domains read it | Through their **own** rule function (`OT.rule()`), not `getSetting` scattered everywhere |
| How it is written | A domain saver that clamps (`OT.saveRule()`, `overtime.js:59`) |
| Where it is toggled | **`POST /payroll/overtime`** (`server.js:8969`) — on the Payroll page |

**The insertion point is not `/settings`.** `/settings` is a card index —
`nav.js` `SETTINGS_GROUPS` lists Tip-out policy, Positions, Staff, Users, Email,
Cash tips page, each linking to a dedicated page. Overtime, the closest
analogue, is toggled **on the page it governs**. So:

> **Recommendation: the toggle lives on `/schedule`**, in the same place
> scheduling settings would go, not on `/settings`. Follow `OT.rule()` — a
> `SCH.availabilityRule()` reader owned by `scheduler.js`, so no route reads the
> raw key.

### The precedent that matters most

`ot_enabled` is **stamped onto the record** — it is a column on the timesheet
approval and transfer tables (`timeclock.js:293`, `:314`), so a past approval
remembers the rule it was computed under. Same discipline as `shifts.policy_id`
and `scheduled_shifts.daypart`.

**Availability does not need this**, and the difference is worth stating: OT
stamps because the setting changes a **number somebody was paid**. Availability
changes only what warnings a manager sees, and Issues are derived fresh on every
render with no stored result. Nothing to stamp.

### Recommended behaviour

| Question | Recommendation |
|---|---|
| Default for existing restaurants | **ON** |
| Default in a fresh install | **ON** |
| What governs it | **Availability only** — see §B3 |
| `My availability` when disabled | **Stays fully reachable** — the tab also owns Time Off, which the setting does not govern. Availability *controls* are hidden/disabled; the section does not lock. See §B18 |
| Existing data when disabled | **Preserved untouched.** Disabling is not deleting |
| Availability-derived Issues when disabled | **Suppressed.** `availabilityFor()` returns `available` for everyone, so the two new issue kinds never fire |
| Time off when disabled | **Still fully available** — see §B3 |
| Permissions | Unchanged. The toggle sits under the `schedule` area like the surface it governs |
| Migration | One key, absent by default, read as ON. **No migration writes a row** |

**Why default ON, against the `ot_enabled` precedent of defaulting off:** overtime
off is a *legal and financial* default where guessing wrong costs money.
Availability off is a *feature-visibility* default where guessing wrong costs
nothing — zero rules means available, so an enabled feature with no data behaves
exactly like a disabled one. The roadmap's own rule is **"no dead toggles"**, and
shipping a feature switched off is the deadest toggle there is.

**The read must be `!== '0'`, not `=== '1'`.** An absent key must mean ON, and
`getSetting` returns the fallback for a missing row — so the fallback is `'1'`
and the test is negative. Getting this backwards ships Phase 6 invisible.

---

## B3. What the setting governs — availability only

The brief asks explicitly whether "enable employee availability" covers
**A. availability only** or **B. availability + time off**.

> **Recommendation: A — availability only.**

**Rationale.**

1. **They have different owners.** Availability is stated by the employee and
   takes effect immediately (decision 2). Time off is *requested* and a manager
   decides. Switching off a request workflow does not mean the same thing as
   switching off a preference someone recorded.
2. **The roadmap already separates them.** §I.7 and the Phase 6 section treat
   availability as a constraint and time off as *"a real request/approval
   workflow"*, and §III's wording names only availability.
3. **Turning off time off has a victim.** An employee with an approved absence
   for next Friday, whose request surface vanishes, has no way to tell anyone.
   Availability going quiet has no equivalent — nothing was promised.
4. **Approved time off is a commitment already made.** Suppressing the Issue for
   it would let a manager schedule over an absence they personally approved, with
   no warning. That is worse than the noise the toggle exists to prevent.

**If you later want time off switchable too, that is a second key** — not a
widened meaning of this one. A setting whose scope grows is how "disabled" stops
being predictable.

---

## B4. Accessibility and mobile — *primitives measured*

The brief's nineteen items, against what the Staff Portal already ships. **The
finding is that almost nothing needs building.**

| Requirement | Status | Evidence |
|---|---|---|
| 44px+ touch targets | **Already exceeded** | `staff.css:120` `min-height: 48px`; `:513` 48px; `:527` 46px |
| Safe-area handling | **Already everywhere** | `env(safe-area-inset-top)` and `-bottom` at `staff.css:56, 61, 114, 128, 159, 205, 299, 318, 323, 327, 530` |
| Bottom-nav clearance | **Solved** | `.pt-tabs` and footers already pad by `env(safe-area-inset-bottom)` |
| Focus trap in sheets | **Already built** | `server.js:3566–3629` — focus moves in, Tab cycles first↔last, Escape closes, focus **returns to the opener** |
| Screen-reader dialog semantics | **Already built** | `role="dialog" aria-modal="true"` + `aria-labelledby` (`server.js:3541`) |
| Sheet layering | **Tokenised** | `--pt-z-sheet: 90` (`staff.css:282`), `.pes` at `:633` |
| Week/date strip | **Built and tested** | `.ps-strip`, a 7-column grid (`staff.css:1490`) |
| Day rows at narrow widths | **Handled** | `.ps-row` 46px → 38px under the breakpoint (`:1519`, `:1587`) |
| Date inputs | **Use native** | the portal already ships `type="date"` |
| Numeric entry | **Use native** | `inputmode` used throughout the tips flow |

### What Phase 6 genuinely adds, and the rules for it

**Time entry — use `<input type="time">`.** Native, keyboard-accessible, and
screen-reader labelled for free; on iOS and Android it raises the platform time
wheel. **Do not build a custom time picker.** The portal has never built one and
the one control class it does hand-roll (the PIN keypad, `server.js:3185`) is
explicitly `aria-label`ed per key, which shows the cost.

**Date ranges — two `<input type="date">`, not a range widget.** A time-off
request is a start and an end. Two native inputs are two accessible controls; a
custom range calendar is a grid nobody can drive with a keyboard without real
work. §24 already recommends simplifying the calendar grid away.

**Weekday selection — checkboxes in a `<fieldset>` with a `<legend>`.** Seven
toggles that look like chips are still checkboxes underneath. A `<legend>` gives
the group a name, which a bare row of buttons never has.

**All-day vs timed — a real control, not a disclosure.** Recommend a checkbox
that toggles `disabled` on the two time inputs, with `aria-describedby` naming
what changed. A range that silently ignores its own values is the accessibility
failure people actually hit.

**Status not by colour alone.** Pending, approved and rejected each need a word
or a glyph beside the colour. The owner shell already sets this precedent — the
invoice AI badge is *"Check"* / *"AI read"* as text, not a coloured dot.

**Error and decision announcement.** Both belong in a container with
`role="status"` (polite). A decision arriving as a silently repainted chip is
invisible to a screen reader, and this phase's whole point is telling somebody
the answer.

**Long reason text.** A free-text reason has no length ceiling in the schema
proposed at §6. Recommend a `maxlength` on the input and clamped display in the
review queue — and per §36, none of it on the Week Board.

**200% zoom / large text.** `.ps-row`'s fixed 46px date gutter is the one at
risk: at large text the day number can outgrow it. Recommend `min-width` with
content-based growth rather than a fixed track.

**Mobile keyboard overlap.** The `.pes` sheet is bottom-anchored
(`align-items: flex-end`), which is exactly where a raised keyboard lands.
Existing sheets are short enough not to hit it; a time-off form with dates,
times and a reason is taller. Recommend the panel scroll internally with the
submit button reachable — **and verify it in the browser**, because per CLAUDE.md
a green suite has never once caught a layout failure of this kind.

**No custom controls are required for Phase 6.** Every input is a native
element and every container already exists.

---

## B5. Overnight recurring availability — *the precedent is already in the schema*

> *Friday unavailable 10:00pm – 2:00am.*

### The alternatives, and why one wins

| Model | Verdict |
|---|---|
| **One rule, `end_min <= start_min` means it ends next day** | **Recommended** |
| Split into Friday 22:00–24:00 + Saturday 00:00–02:00 | Rejected — two rows for one statement; editing or deleting must find both; `effective_until` on "Friday" now half-applies to a Saturday row |
| Two linked rows with a parent id | Rejected — all the cost above plus a relationship to maintain |
| Store as absolute minutes past week-start | Rejected — cannot express "every Friday" independent of a date |

**The codebase already voted.** `scheduled_shifts.ends_at` carries the comment
*"UTC; may be on the next calendar day"* (`scheduler.js:51`), and the overlap
test is `starts_at < @ends_at AND ends_at > @starts_at` (`scheduler.js:189`) —
**instants, not day labels.** A shift crossing midnight is already normal here.
Availability should be modelled the same way and compared the same way.

The employee enters one rule: a day, a start, an end. **They never learn that
`end_min <= start_min` means anything** — the UI says *"ends 2:00am the next
day"* when the end is earlier than the start, and that is the whole disclosure.

### Locked behaviour

Rule: **every Friday, unavailable 22:00 → 02:00**, resolving to a Friday-anchored
UTC window `[Fri 22:00, Sat 02:00)`.

| Case | Result | Why |
|---|---|---|
| Shift **Friday 23:00 – 01:00** | **Conflict** | Fully inside the window |
| Shift **Saturday 01:00 – 03:00** | **Conflict** | Overlaps 01:00–02:00. Note its business date is *Friday* and its calendar date is *Saturday* — neither label decides it, the instants do |
| Shift **Saturday 02:00 – 05:00** | **No conflict** | Touching, not overlapping. `ends_at > starts_at` is strict, matching `scheduler.js:189` exactly |
| Shift **Saturday 22:00 – 02:00** | **No conflict** | A *Saturday* rule would be needed. The rule is anchored to the day it starts |
| `effective_until` = that same Friday | **Conflict still applies through 02:00 Saturday** | The occurrence is tested by its **start** day. A rule effective through Friday gets its whole Friday occurrence, tail included. Truncating at midnight would silently shorten the last one |

**Anchor rule, stated once:** a recurring rule belongs to the weekday its
**start** falls on, and its window may run past midnight into the next day. One
sentence, and every case above follows from it.

**One-off exceptions inherit it unchanged** — an `on_date` rule of 22:00–02:00
is a window starting on that date and ending the next.

---

## B6 / B7. The Phase 8 seam — resolver and evaluator, kept apart

The roadmap says Phase 8's claims and replacements evaluate *employee active ·
holds the required position · no overlapping assignment · availability · approved
time off*, through one evaluator, and **"Do not duplicate this logic."**

### The architecture already separates qualification — *measured*

`scheduler.js:262` `heldPositions(employeeId)` and `:275` `heldPositionsFor(ids)`
answer position qualification and nothing else. The comment above them
(`:307–309`) is explicit that this is deliberate:

> *heldPositions answers "does this person do that job" and deliberately never
> [claims] schedulable — the qualification rule passed and nothing else looked.*

**So the codebase has already made the call the brief asks about.** Phase 6 must
not undo it by building a resolver that swallows qualification.

> **Recommendation: compose, do not merge.**
>
> - `SCH.availabilityFor(employeeId, startsAt, endsAt)` → **availability facts only**
> - `SCH.heldPositions(employeeId)` → **qualification, unchanged, already exists**
> - `employees.active` + `schedule_visible_from_at` → **lifecycle, already exists**
> - *(Phase 8)* `SCH.eligibilityFor(...)` → **composes all three.** Built in Phase 8, not now

### The contract Phase 6 must ship

Structured facts, never a boolean — a boolean is what forces Phase 8 to re-derive:

```
availabilityFor(employeeId, startsAt, endsAt) -> {
  state:    'available' | 'unavailable' | 'preferred',
  rule:     null | { id, kind, weekday, onDate, allDay, startMin, endMin },
  timeOff:  null | { id, status: 'approved' | 'pending', allDay, startsAt, endsAt },
  reasons:  [ 'unavailable:<ruleId>', 'timeoff:<requestId>', ... ]
}
```

**Why each field earns its place:**

- **`state` is three-valued, not two.** `preferred` is not a weaker `available` —
  Phase 8 will want to rank volunteers, and a boolean throws that away.
- **`timeOff` carries `status`.** Phase 6 treats pending as context and approved
  as a conflict (decision 13/15). Phase 8 will likely *refuse* a claim during
  approved time off while merely warning on pending — different verdicts from the
  same fact, which only works if the status survives.
- **`rule` and `timeOff` return the record, not a flag.** The drawer needs to say
  *which* rule, the Issues engine needs the id for its deterministic key
  (`unavailable:<shiftId>:<ruleId>`), and Phase 8 needs to explain a refusal.
- **`reasons` is a flat list.** More than one thing can be true at once. A single
  reason field would force a priority order into the resolver, where precedence
  (§21) belongs to `state` alone.

**Batch shape too.** `heldPositionsFor(ids)` exists because per-employee calls
across a roster were the wrong shape; `issuesFor` uses it at `scheduler.js:1041`.
Ship **`availabilityForMany(ids, startsAt, endsAt)`** in Phase 6 for the same
reason — Phase 8 scores a whole roster against one open shift, and that is
exactly the query that would otherwise become N round-trips.

**What must not happen:** `availabilityFor` must not take a `position` argument.
Availability is employee-wide (decision 33), and a position parameter would be
the seam where qualification leaks into availability storage.

---

## B8. Naming collisions, and conventions to adopt

Three existing uses of availability-sounding words mean something else:

| Identifier | Where | Actually means |
|---|---|---|
| `PORTAL_NAV.availability` | `server.js:3437` | Whether a nav tab is usable |
| `"Earnings unavailable"` | `server.js:5807`, `:6012` | A pay figure could not be computed |
| **`kind: 'unavailable'`** | `server.js:3747` | **A shift the tip engine could not cost** |

The third is the dangerous one: it is a `kind:` on a pushed object in a derived
list, which is precisely the shape of a scheduler issue, and it belongs to
**money**.

**Do not rename any of them.** They are correct in their own domains and
`PORTAL_NAV.availability` in particular is read by tests. Phase 6 avoids the
collision instead:

| Thing | Convention | Example |
|---|---|---|
| Availability rule kind | Never bare `unavailable` | `avail_kind: 'unavailable' \| 'prefer'` on the row; the column name carries the domain |
| Issue kind | Prefix with the domain, as Phase 4 already does | `timeoff` and `unavailable` are **scoped by `ISSUE_SEVERITY` membership** — keep the key format `unavailable:<shiftId>:<ruleId>` so a grep for the bare word lands on the key, not a pay state |
| Resolver result | Name the field, not the value | `state: 'unavailable'` inside an object named for availability — never a loose `unavailable: true` |
| Tables | Fully qualified | `availability_rules`, `time_off_requests` |

**The rule in one line:** a bare `unavailable` identifier is already taken;
Phase 6 identifiers say what they are unavailable *for*.

---

## B9. Intentional test migrations

### `test/schedule-publish.test.js:682` — "My availability is present and honestly empty"

```js
for (const fake of ['Save', 'Request time off', 'Prefer', 'Unavailable', 'Repeat']) {
  assert.ok(!new RegExp(`>${fake}`, 'i').test(html), `no ${fake} control`);
}
```

**Why it exists:** Phase 3 shipped the tab locked, and the guard stops anyone
adding a control that *looks* live while doing nothing. It is the same discipline
as the `PORTAL_NAV` locked-tab assertions the roadmap called out at Phase 3 —
*"a planned change with known test updates, not a surprise failure."*

**Why it must change:** those five strings are the exact controls Phase 6 ships.
The test fails the moment the feature works.

**Do not delete it.** Its purpose — *the tab never lies about what it can do* —
still applies, inverted. Replacements:

1. **Active only when intended.** With the setting ON the controls render; with
   it OFF the `.ps-soon` panel renders and **none of the five strings appear**.
   That is the original assertion, preserved, now conditional (§B2).
2. **Owned by the authenticated employee.** Rules and requests rendered are only
   the signed-in employee's — asserted by signing in as two employees and
   checking neither sees the other's.
3. **No coworker access.** A forged rule id or request id in a URL returns 404,
   following the `/portal/schedule/shift/:id` precedent (`row.employee_id !== emp.id` → 404).
4. **No leak into Only me / Everyone.** Extend the **existing Phase 3 privacy
   test** (§35) rather than writing a new one — it already asserts over page
   source, which is the right altitude.
5. **The locked-order nav test at `:690` stays untouched.** `['Only me',
   'Everyone', 'My availability']` is still the order, and Phase 6 must not
   reorder it.

---

## B10. Likely files — corrected

| File | Change | New? |
|---|---|---|
| `src/db.js` | Two tables, four indexes, FKs | |
| `src/scheduler.js` | `availabilityFor`, `availabilityForMany`, `availabilityRule()`, two `ISSUE_SEVERITY` entries, two blocks in `issuesFor` | |
| `src/server.js` | Portal availability view, request routes, manager queue rows, drawer context, the setting's toggle route | |
| `src/portal.js` | Notification helpers for submit / withdraw / decide | |
| `public/staff.css` | `.ps-av*` | |
| `public/broadsheet.css` | Manager review + drawer context | |
| `test/schedule-availability.test.js` | Resolver + precedence + overnight | **new** |
| `test/schedule-timeoff.test.js` | Lifecycle, concurrent review, idempotency | **new** |
| `test/schedule-issues.test.js` | The two new kinds | |
| `test/schedule-publish.test.js` | **The locked-tab migration (§B9)** | |
| `test/portal.test.js` | Portal surfaces, ownership, notifications | |
| `test/settings.test.js` *(or wherever `ot_enabled` is covered)* | The setting's default-ON behaviour | verify location first |
| `docs/ZWIN-SCHEDULER-ROADMAP.md` | Record the §29 corrections | |
| `CLAUDE.md` | Phase 6 shipped; the naming conventions of §B8 | |

**Settings files:** there is **no dedicated settings module**. `settings` is a
bare key/value table read through `getSetting` (`periods.js:51`) and written by
domain savers. So the setting's code lives in **`src/scheduler.js`** (the reader)
and **`src/server.js`** (the toggle route) — not in a settings file, because
there is not one.

---

## B11. The default-availability invariant — non-negotiable

**No availability rows = available. Nothing else.**

Consequences, each of which must hold and be tested:

1. **Existing employees are unchanged after migration.** All 84 keep working
   exactly as they do now.
2. **Issue count is zero immediately after migration.** Not "low" — zero.
3. **No seed rows, ever.** Not in `seed.js`, not in a migration, not "available
   all day" defaults written per employee.
4. **Deleting the last rule returns to available**, with no extra write.
5. **"Available — all day" may be displayed without being stored** (decision 24).
   The line is rendered from absence.
6. **Disabling the feature must not reinterpret zero rows.** Off and empty behave
   identically — which is exactly why the toggle can safely default ON (§B2).

**This is asserted by a test, not assumed** (§43). The test boots a database with
the new tables and zero rows and asserts `issuesFor()` returns exactly what it
returned before Phase 6.

---

## B12. Pending time off — context, not an Issue

**Recommendation unchanged.** Nothing found in Part Two weakens it.

**Why:**

- An employee must not be able to put a warning on the manager's board
  unilaterally, simply by asking.
- The manager still needs to see it — scheduling straight over an unanswered
  request is how somebody ends up looking like they ignored it.
- **Approval is the moment it becomes a fact.** Before that it is a question.

**Where pending context appears:**

| Surface | Shows pending? |
|---|---|
| The requests queue | **Yes** — this is where it is answered |
| Create/edit drawer, for that employee and date | **Yes** — plain context line, no severity styling |
| Employee's own My availability | **Yes** — their own request, with status |
| Week Board issue count | **No** |
| Issues drawer | **No** |
| Publish | **No** |

**No contribution to the board's issue count**, which is the whole distinction.

---

## B13. The setting × pending-request interaction

Because the setting governs **availability only** (§B3), the answers are clean:

| When availability is disabled | Behaviour |
|---|---|
| Existing pending time-off requests | **Untouched.** Still pending, still in the queue |
| Manager requests queue | **Unchanged.** Time off still listed and decidable |
| Approved time off | **Still in force** |
| Approved-time-off Issues | **Still raised.** A manager must not schedule over an absence they approved |
| Employee submitting new time off | **Still allowed** |
| Availability rules | Preserved, but **not evaluated** — the resolver returns `available` |
| Unavailable / prefer Issues | **Suppressed** |

**Had the setting governed both (option B), every row above would need an answer
about orphaned commitments** — which is the strongest practical argument for
option A.

---

## B14. Effective-date edges

| Question | Recommendation |
|---|---|
| `effective_from` | **Inclusive.** The rule applies on that date |
| `effective_until` | **Inclusive.** The rule applies on that date |
| Both NULL | Indefinite in that direction |
| An overnight rule whose tail crosses past `effective_until` | **The tail applies** — the occurrence is tested by its start day (§B5) |
| A one-off `on_date` outside the recurrence's effective range | **Applies.** A one-off is not governed by a recurring rule's dates — it is its own row |
| Editing a rule | **Never retroactive.** Close the old row with `effective_until` and insert a new one, rather than updating in place |

That last one is the load-bearing rule. Updating a rule in place rewrites whether
last month's schedule was ever valid. **Same discipline as `policy_versions` and
`shifts.policy_id`** — the codebase already treats "edit" as "supersede" where
history depends on it.

**Inactive employees** (§37) fold in here: deactivation sets `effective_until`
rather than deleting, so reactivation does not resurrect stale availability from
before somebody left.

---

## B15. Edits after scheduling — confirmed locked

**Availability changed after a shift exists:**

- Does **not** mutate the shift
- Does **not** cancel it
- Does **not** unpublish it
- **Does** re-derive the Issue — automatic, because `issuesFor` re-derives on
  every render
- The manager resolves manually

**Approved time off after a shift exists:** identical, at severity `action`
rather than `review`.

**No automatic scheduling action anywhere in Phase 6.** This needs no new
architecture — it is what the engine already does.

---

## B16. What changed from the first audit, and why

| Item | First audit | Now |
|---|---|---|
| "Nothing exists" | Asserted from a **schema** query over 6 terms | **Measured** — repo-wide over 14. Conclusion holds; **three** naming collisions found, not one (§A1) |
| The enable setting | Absent | §B2 — storage measured, behaviour recommended, and §B18 locks it |
| Accessibility | One passing phrase | §B4 — nineteen items against measured primitives. **Finding: no custom control is needed** |
| Overnight rules | Unaddressed | §B5 — one rule, `end_min <= start_min` means next day, with five locked cases |
| Phase 8 seam | Unmentioned | §B6/B7 — structured facts, batch variant, and qualification kept **out** of availability |
| Decisions | 10 tabulated, 24 in prose | §B1 — all 34 in one table, plus S1 |
| `test/schedule-publish.test.js` | Not in the file list | §B9 — a documented migration with five replacement assertions |
| Performance | "I did not measure this" | Still unmeasured. **Now scheduled** — §26 step 2, before any UI |

**One recommendation reversed.** §B2 originally said the `My availability` tab
should render the locked `.ps-soon` panel when the setting is off. That
contradicted §B3's own conclusion that the setting governs availability only: the
tab also owns Time Off, so locking it would have hidden a surface the setting has
no authority over. Corrected in §B2 and locked in §B18.

---

## B17. Genuinely unresolved after Part Two

Three, and they are small:

1. **Decision 12 — is the manager's decision note visible to the employee?**
   Recommended visible. A hidden note would be the first manager-only text about
   a named person in an unencrypted database, which deserves its own decision.
2. **Decision 25 — does prefer-to-work earn its place?** Recommended: ship it,
   silent. The honest alternative is to cut it and see whether anyone asks.
3. **Where the `sch_availability` toggle renders on `/schedule`.** The pattern is
   settled (§B2 — on the page it governs, like overtime); the exact placement is
   a layout call best made against the built page.

Everything else in this audit now carries an answer.

---

# PART THREE — APPROVED DECISIONS (THE IMPLEMENTATION CONTRACT)

**Approved 2026-08-14 by the owner.** All 34 decisions in §B1 and all Part Two
recommendations are approved **as written**, with one override, below. This
section is the contract Phase 6 is built against; where it and anything earlier
disagree, this section wins.

## B18. OVERRIDE — the setting, `sch_availability`

*(§B1 numbered this S1; the owner refers to it as #35. Same decision.)*

**Key name: `sch_availability`.** It governs **employee availability features
only**:

- recurring unavailable
- recurring prefer-to-work
- one-off unavailable
- one-off prefer-to-work

**It does not disable time-off requests, and it does not disable
approved-time-off scheduling conflicts.**

### Locked behaviour at `sch_availability = 0`

| Surface | Behaviour |
|---|---|
| `My availability` tab | **Remains reachable** — it also owns Time Off |
| Availability editing controls | **Hidden / disabled** |
| Creating a new availability rule | **Refused** |
| Existing availability rules | **Remain stored**, untouched |
| Availability warnings / Issues | **Do not contribute** while disabled |
| Time-off request submission | **Remains available** |
| Manager Requests review | **Remains available** |
| Approved-time-off conflicts | **Remain active** |
| Time-off notifications | **Remain active** |

**No second time-off setting in Phase 6.** Time off is unconditionally on.

**Default: ON**, per §B2 — absent key reads as enabled, so the test is
`getSetting('sch_availability','1') !== '0'`. Getting that backwards ships the
feature invisible.

**Server-side, not just UI.** "No new availability rules may be created" is a
route-level refusal, not a hidden button. A disabled control that still accepts a
POST is not disabled.

## B19. Build directives

Carried from the approval, and binding:

1. **Measure resolver performance before building any UI.** §26 step 2. The
   first audit declared this unmeasured; it stops being unmeasured before the
   phase has a screen.
2. **Measure 200% text zoom and mobile keyboard overlap once the real
   `My availability` UI exists** — in the browser, per CLAUDE.md, not by reading
   the CSS. §B4 names both as the two at-risk items.
3. **Local only. Do not push.**
4. **Do not start Phase 7.**

## B20. Build sequence

Per §26, amended for the directives above:

| # | Step | Gate |
|---|---|---|
| 1 | Two tables + migration test proving zero rows changes nothing | §B11 invariant asserted |
| 2 | `availabilityFor` / `availabilityForMany` + domain tests. **No UI** | §B5 overnight cases pass |
| 3 | **Measure resolver performance** | Directive 1 — before any UI |
| 4 | `sch_availability` reader + route-level refusal | §B18 |
| 5 | Employee `My availability` — replace the `.ps-soon` branch | |
| 6 | Time-off submit + withdraw | |
| 7 | Manager review in the existing requests queue | |
| 8 | Issues engine: two new kinds | |
| 9 | Create/edit warning **through the same helper** | §17 |
| 10 | Notifications, both directions | |
| 11 | Privacy test extension for Everyone; locked-tab migration | §B9 |
| 12 | **Measure zoom + keyboard overlap in the browser** | Directive 2 |
