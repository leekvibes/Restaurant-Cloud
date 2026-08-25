# ZWIN Scheduler — Phase 8 Targeted Audit

**Open Shifts + Claims + Replacements**

Audited at `0478af6`, 2026-08-19. Phases 0–7 complete and pushed.
**Nothing implemented. No production file changed by this audit.**

> **Confidence note.** Findings marked *verified* were read from the live schema
> or from source at a cited line. Findings marked *plan* are quoted from the
> committed planning documents. Where the two disagree it is called a
> **contradiction** and reported rather than resolved.

The roadmap names this one of two concentrated-risk phases and requires this
audit before implementation. It is also the first phase in which an **employee
initiates a change to published truth**.

---

# PART A — WHAT THE PLANS ALREADY LOCK

## A1. The roadmap's Phase 8, quoted in full — *plan*

> **Shared eligibility engine — built once.** Both claims and replacements use
> one evaluator: employee active · holds the required position · no overlapping
> assignment · availability · approved time off · any applicable scheduler
> restriction. **Do not duplicate this logic.**
>
> **Open shifts.** Manager creates: date · time · position · service · number of
> spots if supported · note. Employees see eligible open shifts.
>
> **Claims.** Employee claims. If approval is required, the manager approves one
> eligible claimant, and the assignment updates and publishes per the lifecycle.
>
> **Replacements.** Employee opens a published shift → *Request replacement*.
> Eligible coworkers may volunteer or accept. Optional manager approval. **No
> silent mutation.** Notifications reach affected people.
>
> **Settings introduced here:** enable open-shift claims · claims require
> manager approval · enable replacement requests · replacements require manager
> approval.
>
> **Done when:** coverage changes stop happening in group texts.

### What that locks, read strictly

| # | Locked | Evidence |
|---|---|---|
| L1 | **One evaluator for both** claims and replacements | *"built once… Do not duplicate this logic"* |
| L2 | The evaluator's inputs are exactly: active · holds position · no overlapping assignment · availability · approved time off | the list is enumerated |
| L3 | Manager creates open shifts with date · time · position · service · note | enumerated |
| L4 | Employees see **eligible** open shifts | *"Employees see eligible open shifts"* |
| L5 | Approval is **optional**, not mandatory | *"If approval is required"* + two settings |
| L6 | On approval the assignment **updates and publishes** | *"the assignment updates and publishes per the lifecycle"* |
| L7 | Replacement is initiated by the **assigned employee** from a **published** shift | *"Employee opens a published shift → Request replacement"* |
| L8 | Replacement supports **both** volunteering and accepting | *"Eligible coworkers may volunteer or accept"* |
| L9 | **No silent mutation** anywhere in replacements | stated outright |
| L10 | **Four settings**, named | enumerated |
| L11 | Claims and replacements have **separate enable and approval settings** | four settings, two per feature |

### What the roadmap does NOT say — and therefore is not locked

- **Swaps are never mentioned.** Not in Phase 8, not in §IV, not in §V. See §A5.
- No claim **status vocabulary** for Phase 8 specifically (Phase 0 supplies one — §A2).
- No statement on whether a pending claim **reserves** the shift.
- No statement on **where** Open Shifts lives in the Staff Portal.
- No statement on whether open shifts enter `published_schedule`.
- No statement on **losing applicants**.
- No statement on claims **after a shift starts**.

## A2. Phase 0 locks the lifecycle vocabulary — *plan*

`docs/ZWIN-SCHEDULER-PHASE-0.md:117`:

> Time off, **claims and replacements** are all *request → decision → apply*.
> This is the shape to follow rather than invent — same lifecycle vocabulary,
> same `pending/approved/rejected/applied` states, so the owner's Requests queue
> reads consistently.

**This is the strongest single instruction for Phase 8's data model**, and it
names claims and replacements explicitly.

**Note the `applied` state, and note that Phase 6 dropped it.** The Phase 6
audit removed `applied` on the reasoning that *"approval IS the effect; there is
no second write."* For a claim that reasoning **inverts**: approving a claim
assigns the shift and republishes it, which genuinely is a second write that can
fail. `applied` is meaningful again here, and Phase 6's precedent must not be
copied blindly. See §D3.

## A3. Phase 0 locks that an open shift is the SAME ROW — *plan*

`docs/ZWIN-SCHEDULER-PHASE-0.md:388`, in the proposed schema:

```sql
employee_id  INTEGER REFERENCES employees(id) ON DELETE CASCADE,
             -- NULL = open/unassigned shift (Phase 8 uses the same row)
```

**This answers §27 outright.** A claim is `employee_id NULL → X` on the existing
row. It does not create a second shift. Shipped code matches: `scheduled_shifts`
carries the same comment.

## A4. Phase 2 and Phase 4 deliberately deferred everything to here — *plan*

| Doc | What it deferred |
|---|---|
| Phase 2 plan Q4 | *"The drawer requires an employee. No null-employee row is creatable from any Phase 2 surface. The domain keeps the capability, unreachable, until the full claim workflow."* And: `skipped-open` *"becomes unreachable in Phase 2 and stays as-is — removing it would be scope creep into Phase 8."* |
| Phase 2 audit Q4 | *"a null-employee shift **has no row to render in**"* — the board is employee rows. Recommendation A: do not create them in Phase 2 |
| Phase 4 audit §9 + D8 | An open shift is *"not obviously a problem — it may be deliberate"*. **D8: open shifts count as issues — "No. Defer to Phase 8."** Options (a) never an issue, (b) informational, (c) issue within N days |

So the question *"is an open shift an Issue"* is **explicitly handed to this
phase with three options and a leaning toward (a)**.

## A5. Swaps — *plan, and the answer is no*

Searched every document for `swap` and `trade`. **Zero hits in any scheduler
plan.** The only occurrences are in the unrelated reader audit.

> **Finding: shift swaps are NOT in Phase 8.** A reciprocal two-shift trade is a
> different object with a different lifecycle (two shifts, two employees, two
> consents). The roadmap says *replacements*, and §63 must keep it that way.

---

# PART B — WHAT THE CODE ALREADY SUPPORTS

## B1. Open shifts in the domain — *verified*

| Operation | Current behaviour with `employee_id IS NULL` | Line |
|---|---|---|
| `create` | **Allowed.** `employeeId` coerces `''`/null to null | `scheduler.js:782` |
| `edit` | **Allowed.** Can set or clear the employee | `:826` |
| `publish` | **REFUSED** — returns `action: 'skipped-open'`, never writes | `:931` |
| `unpublish` | No special case (nothing was published) | — |
| `cancel` | No special case | — |
| `duplicate` | No special case — copies the null through | — |
| `copyWeek` | Copies them (no employee filter) | `:1000` |
| `copyDay` | **Skips and counts** them | `:1266` |
| `createSeries` (Repeat) | Inherits `create` — would allow, but the drawer cannot make one | `:1231` |
| Day/week templates | **Skips at save** (`employee_id != null`); `employee_id NOT NULL` on rows | `:378` |
| `overlapsFor` | **Returns `[]`** — an open shift can never overlap-check | `:1103` |
| `issuesFor` | Skipped by every rule (`s.employee_id != null` guards) | `:1586`, `:1608` |
| `weekTotals` | **Counted, under the key `'open'`** | `:1069` |

## B2. Where open shifts render today — *verified, and asymmetric*

| Surface | Renders an open shift? | Why |
|---|---|---|
| Manager **Week Board** (desktop grid) | **NO** | The grid is `staff.map(row)` — one row per employee. **A null-employee shift has no row to render in.** Confirmed by the Phase 2 audit and still true |
| Manager **Today / Upcoming** (Phase 5 mobile) | **YES, already** | `mCard` renders `who = 'Open shift'` (`server.js:18673`) — a flat time-ordered list has somewhere to put it |
| Create/edit drawer | **Cannot create one** — `employee_id` is `required` (`server.js:18883`) | Phase 2 plan Q4 |
| Employee **Only me** | No — reads `published_schedule`, which cannot hold one | §B3 |
| Employee **Everyone** | No — same |
| Issues | No — every rule guards on non-null | |

**This asymmetry is a real Phase 8 finding.** The mobile manager view is already
open-shift-capable; the desktop board structurally is not.

## B3. THE HARD BLOCKER — *verified*

```sql
CREATE TABLE published_schedule (
  scheduled_shift_id INTEGER NOT NULL REFERENCES scheduled_shifts(id) ON DELETE CASCADE,
  employee_id        INTEGER NOT NULL,      -- <<<< THIS
  ...
  UNIQUE(scheduled_shift_id)
)
```

**`published_schedule.employee_id` is `NOT NULL`.** An open shift cannot be
represented in the employee-facing table at all. This is not a query that needs
care — it is a constraint that refuses the row.

Every Phase 8 architecture option lives or dies on how this is resolved. See §C.

## B4. The Phase 6 shared seam, as actually implemented — *verified*

Built in Phase 6 explicitly anticipating this phase.

```
availabilityContext(employeeIds, fromUtc, toUtc)        -> { ids, enabled, rules, requests }
resolveAvailability(ctx, employeeId, startsAt, endsAt)  -> { state, rule, timeOff, reasons }
availabilityFor(employeeId, startsAt, endsAt)           -> same, one-shot
availabilityForMany(employeeIds, startsAt, endsAt)      -> Map(id -> facts)
approvedTimeOffOverlapping(employeeId, startsAt, endsAt)-> row | null
heldPositions(employeeId)                               -> [slug]
heldPositionsFor(ids)                                   -> { id: [slug] }
overlapsFor(shift)                                      -> [shift]   (empty for open)
```

`resolveAvailability` returns **structured facts, not a boolean**:

- `state`: `'available' | 'unavailable' | 'preferred'` — three-valued, so
  preferred survives for ranking
- `timeOff`: `null | { id, status: 'approved'|'pending', allDay, startsAt, endsAt }`
  — **status survives**, which is what lets Phase 8 treat approved and pending
  differently from the same call
- `rule`: the record, not a flag
- `reasons`: a flat list, because more than one thing can be true

**It has no `position` argument, deliberately** — availability is employee-wide
and qualification is a separate evaluator.

> **Verdict: the seam is sufficient.** Phase 8 composes rather than extends.
> Every input the roadmap's evaluator names (L2) is already available:
> active (`employees.active`), position (`heldPositionsFor`), overlap
> (`overlapsFor`), availability + approved time off (`resolveAvailability`).

**What Phase 8 must add and the seam does NOT cover:** position *active* state
(`positions.active` — a retired position), and the reactivation boundary
(`schedule_visible_from_at`).

## B5. Request-lifecycle precedents available — *verified*

| Precedent | What to copy |
|---|---|
| `time_off_requests` (Phase 6) | Conditional transition `WHERE status = 'pending'`; partial unique index for idempotency; decided_by/at/note |
| `time_corrections` | The original request→decision shape, with `applied_at` / `apply_error` |
| `PORTAL.notifyOnce(key, …)` | Employee-direction dedupe on a stable key |
| `PORTAL.adminNotify` | Manager direction |
| `/timeclock/requests` | A queue that already carries two request shapes side by side |
| `sch_availability` | The settings precedent: absent means ON, read `!== '0'`, toggled on the page it governs |

---

# PART C — CONTRADICTIONS BETWEEN PLANS AND CODE

## C1. "Number of spots" has nowhere to live — *contradiction*

The roadmap says the manager creates an open shift with *"number of spots if
supported"*. `scheduled_shifts` is **one row, one `employee_id`**. Three spots
is three rows, or a `spots` column plus a claim-count, and the second breaks
Phase 0's *"Phase 8 uses the same row"* and every `UNIQUE(scheduled_shift_id)`
assumption in `published_schedule`.

**The roadmap's own hedge — "if supported" — is the escape.** Recommend: **one
row is one spot.** A manager wanting three servers creates three open shifts.
Recorded as decision #41.

## C2. Phase 0's `applied` state vs Phase 6's removal of it — *contradiction to resolve, not a fault*

Phase 0 locks `pending/approved/rejected/applied` for claims. Phase 6 removed
`applied` because approval *was* the effect. For claims it is not: approving
assigns the shift **and** republishes, which is a second write that can fail
(e.g. the shift was cancelled meanwhile). Phase 6's precedent must not be copied
here without thinking. See §D3.

## C3. "Employees see eligible open shifts" vs Phase 4's soft-warning model — *tension*

L4 says **eligible**. Phases 2/4/6 all settled on *warn, never block* for
managers. But a manager overriding their own warning and an **employee
self-selecting past one** are different acts. The roadmap does not resolve it.
See §D6 — this is the sharpest product decision in the phase.

## C4. Nothing else in the plans is factually wrong

Every other Phase 8 statement in the roadmap and the Phase 0/2/4/6 documents
matches the shipped code. Notably: `skipped-open` still exists and still behaves
as Phase 2 said it would; the drawer still refuses a null employee; open shifts
still are not Issues.

---

# PART D — ARCHITECTURE OPTIONS AND PRODUCT DECISIONS

## D1. Publishing an open shift — the phase's central decision

`published_schedule.employee_id` is `NOT NULL` (§B3). Four ways out:

| | Option | Cost | Consequence |
|---|---|---|---|
| **1** | **Make `employee_id` nullable** and publish open shifts into the same table | One migration; every reader must handle null | The employee schedule table stops meaning "shifts belonging to somebody". `pubForWeek` filters by employee id, so open rows would be invisible to Only me anyway and need a separate query. **Weakens the table's meaning for one row type** |
| **2** | **A second table**, `published_open_shifts` | One new table; no change to existing readers | Two publish paths, two snapshots to keep consistent when a claim converts one to the other. The conversion becomes a cross-table move |
| **3** | **Do not publish open shifts at all.** Employees read *draft-status* open shifts through a dedicated, narrow query | No migration | **Breaks the Phase 3 invariant** — "employees read `published_schedule`, never `scheduled_shifts`". CLAUDE.md lists this as a hard invariant |
| **4** | **Publish-as-offer:** open shifts get a `published` *status* on `scheduled_shifts` but no `published_schedule` row; the portal's Open Shifts view reads `scheduled_shifts WHERE employee_id IS NULL AND status='published'` | No migration; one narrow query | Employees read `scheduled_shifts` for **this one view** — a documented, deliberate exception rather than a silent one |

**Recommendation: option 1**, with the nullable column and an explicit
`published_open` concept — *but this is genuinely a decision*, and options 2 and
4 are defensible.

**Why 1 over 4:** the invariant that protects employees is *"drafts are not in
the table the portal queries"*. Option 4 keeps drafts and offers in the **same**
table and defends the boundary with a `status` predicate — exactly the kind of
"the queries are careful" reasoning CLAUDE.md warns against. Option 1 keeps the
structural guarantee: if it is in `published_schedule`, it is published.

**Why not 2:** the claim conversion is the single most concurrency-sensitive
operation in the phase, and making it a cross-table move adds a failure mode for
no gain.

**What option 1 requires:** `pubForWeek`/`pubInRange` keep their employee filter
so Only me and Everyone are unchanged; a new `pubOpenInRange` serves Open Shifts;
and a claim becomes `UPDATE published_schedule SET employee_id = ?` on the same
row — atomic, one statement, one table.

## D2. Hard vs soft eligibility — the matrix

Roadmap evidence: L2 enumerates the evaluator's inputs but **does not grade
them**. Phases 2/4/6 all warn rather than block, but that was for *managers*.

| Condition | Recommended for **self-claim** | Why |
|---|---|---|
| Employee inactive | **HARD** | They are not staff. Nothing to weigh |
| Does not hold the position | **HARD** | `create()` already refuses this server-side; a claim that bypassed it would be a hole, not a feature |
| Position retired | **HARD** | Same — `create()` refuses it |
| Shift is cancelled / no longer open / already assigned | **HARD** | Not a judgement, a fact |
| Employee already owns this shift | **HARD** | Nonsensical |
| Shift already started | **HARD** — see #19 | |
| **Approved time off** | **SOFT — warn, allow request** | It is *their own* approved absence. Letting them say "actually I'll work it" is reasonable; silently letting it through is not |
| **Stated unavailable** | **SOFT — warn, allow** | Same reasoning, weaker still: they stated it, they may override it |
| **Overlapping scheduled shift** | **SOFT if approval ON, HARD if approval OFF** | See §D6. An immediate claim that creates a double-booking has no human in the loop |
| Pending time off | **Context only** — never blocks | Phase 6 precedent |
| Prefer-to-work | Never a restriction | Phase 6: a preference met is not an issue |

**The sharp one is overlap under immediate claim.** With approval ON a manager
sees the conflict and decides. With approval OFF nobody does, and the employee
has just double-booked themselves — which then becomes a Phase 4 overlap Issue
on the manager's board that they did not create. Recommend making overlap
**hard when approval is off**, and recording it as decision #13.

## D3. Claim lifecycle

Phase 0 locks `pending/approved/rejected/applied` vocabulary (§A2).

**Recommended minimum:** `pending · approved · rejected · withdrawn · applied`.

- `withdrawn` — Phase 6 added it for time off and it is needed here too (#9)
- `applied` — **kept**, unlike Phase 6, because approval and assignment are two
  writes (§C2). `applied_at` / `apply_error` mirror `time_corrections`, so a
  manager approving a claim for a shift that was cancelled a second earlier gets
  a recorded failure rather than a silent one

**With approval OFF there is no pending state at all** — the claim either
succeeds atomically or is refused with a reason. Storing a row that is born
`applied` is still worth doing for history (#33).

## D4. Concurrency — the invariant and how to guarantee it

> **At most one employee may end up assigned to one open shift.**

better-sqlite3 is synchronous and the whole app is one process with one
connection, which removes most of the usual difficulty — but not the logical
race across two HTTP requests.

**The guarantee is a conditional UPDATE, not a read-then-write:**

```sql
UPDATE scheduled_shifts SET employee_id = @emp
 WHERE id = @id AND employee_id IS NULL AND status <> 'cancelled'
```

`changes === 0` means somebody else got it, and the second employee is told so.
This is the same compare-and-set discipline Phase 6 used for
`WHERE status = 'pending'`, and it is the whole safeguard needed — wrapped with
the `published_schedule` update in one `db.transaction()`.

**Eligibility must be re-checked inside that transaction**, not before it (§D5).

## D5. Revalidation at approval — required

An employee may request a shift and then lose the position, go inactive, gain
approved time off, or have the shift edited underneath them.

> **Approval must re-run the full evaluator against current state, not against
> the state at request time.** The stored request is a record of what was asked,
> never a licence to assign.

Same for immediate claims: the eligibility check happens **inside** the
transaction that assigns, not in the route before it.

## D6. Approval settings — four, exactly as named

| Setting | Recommended default | Note |
|---|---|---|
| `sch_open_claims` | **ON** | Absent means on, `!== '0'`, following `sch_availability` |
| `sch_claims_approval` | **ON** | The safe default: a human sees it. Turning it off is an explicit choice to trust the evaluator |
| `sch_replacements` | **ON** | |
| `sch_replacements_approval` | **ON** | |

**Placement:** the Phase 6 audit already recommended a `/schedule/settings` page
partly *because Phase 8 needs four toggles* and building it once was cheaper.
Phase 6 shipped its single toggle in the board toolbar instead. **Four more
toggles do not belong in a toolbar** — this is the phase that should create the
settings page and move `sch_availability` into it.

**Changing a setting must not retroactively decide pending requests.** Turning
approval OFF while three claims are pending should leave them pending, not
auto-approve them. Decision #5.

## D7. Employee Open Shifts placement

`SB_VIEWS = ['me', 'all', 'avail']` — three bottom-nav items today. The Phase 3
tests assert that exact order.

| Option | Verdict |
|---|---|
| **Fourth bottom-nav item** | Four items is still comfortable on a phone; it is discoverable; it matches "Employees see eligible open shifts" being a first-class activity. **Recommended** |
| Section inside Everyone | Everyone is *"who is on the floor"* — a browse view. Burying an action in it is worse |
| Section inside Only me | Only me is *their* shifts. An open shift is not theirs yet |
| Banner above the schedule | Fine as an *additional* nudge when something is claimable; not as the home |

**Recommend a fourth tab, plus a count badge when something is claimable.** The
locked-order test at `schedule-publish.test.js` becomes a planned migration, the
same way Phase 6's locked-tab guard did.

## D8. Replacements — definition and model

The roadmap: *"Employee opens a published shift → Request replacement. Eligible
coworkers may volunteer or accept."*

**"Volunteer or accept" locks BOTH models** (L8):

- **Open replacement** — offered to all eligible coworkers, who *volunteer*
- **Direct replacement** — offered to one named coworker, who *accepts*

**Recommend shipping open replacement first** and direct as the deferrable half,
because open replacement reuses the claim surface almost exactly: an offered
shift behaves like an open shift that already has an owner.

**Not a swap** (§A5). The original employee gives up a shift; nobody gives one
back.

**Published truth during a pending replacement (§33):** the original employee
**remains the published assignee** until approval. This is what *"no silent
mutation"* means in practice, and it is also the only safe reading — a shift
with no confirmed owner is a shift nobody turns up for.

## D9. Issues — what actually is one

Phase 4 D8 deferred this here with three options.

| State | Recommended |
|---|---|
| Open shift exists | **Not an issue.** It may be entirely deliberate — the roadmap omits staffing targets on purpose, so ZWIN cannot know an unfilled shift is wrong |
| Open shift with **no eligible employee at all** | **Informational at most.** It is real information, but it is also the normal state of a shift nobody can work, and the manager created it |
| Pending claim | **Not an issue** — it is work waiting in the queue, like a pending time-off request |
| Pending replacement | **Not an issue**, same reasoning |
| Approved claim that conflicts with availability | **Yes — the existing Phase 6 issue fires automatically** once the shift has an employee. No new kind needed |

> **Recommendation: Phase 8 adds NO new Issue kinds.** Everything it produces is
> either a queue item or, once assigned, already covered by Phase 4/6 rules.
> This is worth stating because "add a badge for every state" is the easy wrong
> answer.

## D10. Data model — one table or two

| | Option | Verdict |
|---|---|---|
| A | **One `shift_requests` table with a `kind` column** (`claim`/`replacement`) | **Recommended.** Both are request→decision→apply against one `scheduled_shift_id` by one employee. The lifecycle, the queue, the notifications and the concurrency guard are identical. Phase 0 says so outright: *"claims and replacements are all request → decision → apply"* |
| B | Two tables | Duplicates the lifecycle, the queue query, the dedupe index and the review UI for one differing column |

**Minimum shape:**

```
shift_requests
  id · scheduled_shift_id · kind ('claim'|'replacement')
  employee_id            -- the CLAIMANT, or the volunteer
  offered_by             -- replacement only: whose shift it was. NULL for a claim
  status                 -- pending | approved | rejected | withdrawn | applied
  requested_at · decided_by · decided_at · decision_note
  applied_at · apply_error
```

**Indexes:** `(scheduled_shift_id, status)`, `(employee_id, status)`, and a
**partial unique index** on `(scheduled_shift_id, employee_id, kind) WHERE status = 'pending'`
— the Phase 6 idempotency precedent, so a double-tap cannot raise two requests.

## D11. Performance

Phase 4 derives a real week's issues in **0.25 ms**. Phase 6's availability
resolver, after the memoisation fix, does a 50-shift week in **0.46 ms**.

The Phase 8 shape to avoid is obvious and it is an N+1: evaluating each employee
against each open shift with a fresh context. **Use `availabilityContext` once
per list render**, exactly as `issuesFor` does — the batch seam exists for this.

For a restaurant (tens of employees, tens of open shifts) synchronous evaluation
is comfortable. **Not measured** — there is no data to measure yet — but the
order of magnitude follows directly from the two figures above, and the
measurement should happen before the UI, as it did in Phase 6.

---

# PART E — SCENARIO MATRIX A–Z

`Sup?` supported today · `Sch?` needs schema · `Hard` hard-ineligible ·
`Soft` soft conflict · `Appr` approval required · `Notify` who hears ·
`Txn` concurrency/idempotency concern.

| | Scenario | Sup? | Sch? | Employee sees | Manager sees | Hard | Soft | Appr | Notify | Txn |
|---|---|---|---|---|---|---|---|---|---|---|
| A | Manager creates open **draft** shift | domain yes, **UI no** | no | nothing | board card | — | — | — | none | — |
| B | Manager **publishes** open shift | **NO — `skipped-open`** | **YES** §D1 | it appears | published marker | — | — | — | none | — |
| C | Qualified employee sees it | no | — | in Open Shifts | — | — | — | — | — | — |
| D | Unqualified employee attempts claim | no | — | **not offered**; refused server-side | — | **✓** | — | — | — | — |
| E | Employee unavailable during it | no | — | shown, warned | warned at review | — | **✓** | — | — | — |
| F | Employee on approved time off | no | — | shown, warned | warned at review | — | **✓** | — | — | — |
| G | Already has an overlapping shift | no | — | shown, warned | warned | **if approval OFF** | if ON | — | — | ✓ |
| H | Employee prefers that time | Phase 6 fact exists | — | no change | context only | — | — | — | — | — |
| I | Approval **OFF** → immediate claim | no | yes | assigned at once | appears assigned | — | — | no | employee + manager | **✓✓** |
| J | Approval **ON** → pending request | no | yes | "Requested" | queue item | — | — | yes | manager | ✓ |
| K | Two employees request same shift | no | yes | both "Requested" | **two applicants** | — | — | yes | manager once each | ✓ |
| L | Two employees immediate-claim at once | no | yes | one wins, one told | one assignee | — | — | no | winner + manager | **✓✓✓** conditional UPDATE |
| M | Manager approves one of several | no | yes | winner assigned | applicants list | — | — | — | winner | ✓ revalidate §D5 |
| N | Losing applicants | no | — | **"No longer available"** | — | — | — | — | **yes, once** | ✓ dedupe |
| O | Employee withdraws pending claim | no | status | gone from their list | queue clears | — | — | — | manager | ✓ |
| P | Manager **edits** shift with pending claims | no | — | status unchanged | applicants shown | — | — | — | **applicants told it changed** | ✓ |
| Q | Manager **cancels** shift with pending claims | no | — | request closed | queue clears | — | — | — | applicants told | ✓ |
| R | Open shift starts before claim resolved | no | — | no longer claimable | request auto-closes | **✓** #19 | — | — | — | ✓ |
| S | Assigned employee asks for replacement | no | yes | "Replacement requested" | queue item | — | — | per setting | manager | ✓ |
| T | Specific candidate accepts | no | yes | "Pending approval" | queue item | — | — | per setting | original + manager | ✓ |
| U | Candidate becomes unavailable before approval | no | — | — | **warned at approval** | — | ✓ | — | — | ✓ revalidate |
| V | Manager approves replacement | no | — | both told | reassigned | — | — | — | **both employees** | **✓✓** atomic swap of one field |
| W | Original employee withdraws request | no | status | back to theirs | queue clears | — | — | — | candidates told | ✓ |
| X | Manager directly reassigns while replacement pending | **partly** | — | request closed | normal edit | — | — | — | requester told | ✓ §D12 |
| Y | Employee tries to claim a **draft** shift | n/a | — | **404** | — | **✓** | — | — | — | — |
| Z | Retry / double-submit after success | no | index | "already yours" | nothing new | — | — | — | **not resent** | **✓✓** partial unique index |

---

# PART F — THE 40 PRODUCT DECISIONS

**LOCKED** = the plans already decide it. **REC** = recommendation with
evidence. **OPEN** = genuinely your call.

| # | Decision | Recommendation | Status |
|---|---|---|---|
| 1 | Where Open Shifts lives in the portal | **Fourth bottom-nav tab** | REC |
| 2 | Only published open shifts employee-visible | **Yes** | LOCKED (Phase 3 invariant) |
| 3 | Open shifts in `published_schedule` | **Yes — make `employee_id` nullable** | **OPEN** §D1 |
| 4 | Claim = immediate / request / configurable | **Configurable** | LOCKED (L5) |
| 5 | Claim-approval setting + default | `sch_claims_approval`, default **ON**; changing it never re-decides pending requests | REC |
| 6 | May multiple employees request one shift | **Yes** | LOCKED (L5 "approves one eligible claimant") |
| 7 | Does a pending request reserve the shift | **No** — it stays open until a decision | REC |
| 8 | Losing requests after approval | **Auto-closed as `rejected`, told once** | REC |
| 9 | May employee withdraw a pending claim | **Yes** | REC (Phase 6 precedent) |
| 10 | Do wrong-position employees see the shift | **No** — not listed at all | REC |
| 11 | Do unavailable employees see it | **Yes, with a warning** | **OPEN** §D2 |
| 12 | Do approved-time-off employees see it | **Yes, with a warning** | **OPEN** §D2 |
| 13 | Does overlap block a claim | **Hard when approval OFF, soft when ON** | **OPEN** §D2 — sharpest |
| 14 | Availability/time-off hard or soft for self-claim | **Soft** | **OPEN** |
| 15 | May manager override a soft conflict | **Yes** | LOCKED (Phase 2/4/6 warn-never-block) |
| 16 | Does prefer-to-work affect ordering | **Context only, no ranking** | REC |
| 17 | Does a claim update published truth automatically | **Yes** | LOCKED (L6 "updates and publishes") |
| 18 | Is a manager republish ever required after a claim | **No** | LOCKED (L6) |
| 19 | Claims after the shift starts | **No.** No grace period | REC |
| 20 | Where managers review applicants | **The existing `/timeclock/requests` queue** | REC |
| 21 | Reuse the Phase 6 Requests panel | **Yes** — a third section beside corrections and time off | REC |
| 22 | One table for claim + replacement | **Yes**, `kind` column | REC §D10 |
| 23 | Replacement definition | Assigned employee gives up a published shift; **not a swap** | LOCKED (§A5) |
| 24 | Who initiates a replacement | **The assigned employee** | LOCKED (L7) |
| 25 | Open vs direct replacement | **Both**; ship open first | LOCKED (L8) / REC |
| 26 | Does replacement need approval | **Configurable**, own setting | LOCKED (L10) |
| 27 | Does replacement use the claim setting | **No — its own** | LOCKED (four settings) |
| 28 | May employee withdraw a replacement request | **Yes**, while pending | REC |
| 29 | Must the candidate accept | **Yes** for direct; volunteering *is* acceptance for open | LOCKED (L8) |
| 30 | Published truth before/after approval | **Original keeps it until approval**, then atomic transfer | LOCKED (L9 "no silent mutation") |
| 31 | Manager edits/cancels a shift with requests | Requests **close**, requesters **told** | REC |
| 32 | Notification recipients | Manager on submit/withdraw; employee on decision; losers once | REC |
| 33 | History retention | **Keep everything.** No hard delete | REC |
| 34 | Is an open shift an Issue | **No** | LOCKED-ish (Phase 4 D8 recommended (a)) |
| 35 | Is a pending claim an Issue | **No** | REC §D9 |
| 36 | Eligibility explanation UX | Hard → not listed. Soft → listed, warned, claimable | REC |
| 37 | Bottom-nav / IA change | Four tabs | REC |
| 38 | Phase 8 settings | The four named, on a new `/schedule/settings` | LOCKED (L10) / REC placement |
| 39 | Direct manager reassignment cleanup | Pending requests on that shift **auto-close**; requesters told | REC §D12 |
| 40 | Phase 7 behaviour changes | **None** | REC §D13 |
| **41** | **"Number of spots"** | **One row is one spot** | **OPEN** §C1 — outside the 40, raised by the contradiction |

## D12. Manager direct reassignment — §58

Managers can already reassign a shift through the ordinary edit flow, and
**Phase 8 must not force them through a workflow**. If a manager simply assigns
somebody to an open shift with three pending claims, those claims are now about
a shift that is no longer open.

> **Required cleanup:** any pending request whose shift stops being claimable —
> assigned, cancelled, or started — is closed as `rejected` with a system note,
> and its requesters are told once. Leaving them pending would show applicants a
> queue item they can never win.

## D13. Phase 7 interactions — §59

| Phase 7 behaviour | Phase 8 effect |
|---|---|
| `copyDay` skips open shifts and counts them | **Unchanged.** The comment already says "when Phase 8 gives it a way to be claimed" — that is a *future* extension, not something Phase 8 must do |
| Day/week templates preserve assignments, `employee_id NOT NULL` | **Unchanged.** A template holding an open slot is a different feature |
| Repeat / `createSeries` | **Unchanged** — the drawer still requires an employee |
| Structure-only templates | Becomes *possible* once open shifts are claimable, but the roadmap does not ask for it |

> **Recommendation: change nothing in Phase 7.** Record "copy an open shift
> forward" and "structure-only templates" as natural extensions for later.

---

# PART G — TESTS, SCOPE, SEQUENCE, RISKS

## G1. Tests that deliberately lock Phase 8 out — *exact*

| File | Test | Why it must change |
|---|---|---|
| `test/scheduler.test.js:301` | *"an open shift has no employee, and that is legal"* | Asserts `action === 'skipped-open'` at `:309` and *"publishing it tells nobody, **yet**"*. Phase 8 changes publish |
| `test/schedule-issues.test.js:249` | *"an open shift is not an issue"* | **Keep as-is** — §D9 says Phase 8 adds no Issue kinds. It becomes a *guard*, not a migration |
| `test/schedule-publish.test.js` | the locked three-tab order `['Only me','Everyone','My availability']` | Becomes four tabs (#1). Planned migration, like Phase 6's locked-tab guard |
| `test/schedule-board.test.js` | the exact write-route count (currently **15**) | Every Phase 8 route trips it. That is the point |
| `test/schedule-board.test.js` (Phase 7 block) | comments asserting no open-shift fallback | **Keep** — §D13 |

## G2. New test groups Phase 8 needs

open-shift publication · employee visibility filtering · qualification (hard) ·
availability & time off (soft) · overlap semantics under both settings ·
immediate claim atomicity · approval-based claim lifecycle · **two-employee
race** · idempotent retry · multiple applicants and losers · manager approval +
revalidation · rejection/withdrawal · replacement open + direct · published-truth
transfer atomicity · notifications both directions + dedupe · **privacy/IDOR**
(claim as another employee, replacement for another's shift, draft shift,
cancelled shift, applicant-list leakage) · mobile/a11y.

## G3. Smallest coherent Phase 8

**Ship:** publishable open shifts · a fourth Open Shifts tab · one shared
evaluator composing the Phase 6 seam with qualification and active state ·
claims with the approval setting · manager review in the existing queue ·
notifications both directions · **open** replacements · the four settings on a
new `/schedule/settings`.

**Defer:** direct (named-coworker) replacements · multiple spots per open shift ·
applicant ranking · open-shift Issues · copying open shifts forward ·
structure-only templates.

**Refuse:** swaps (§A5) · auto-assignment · staffing targets · SMS · public links
· rich activity logs.

## G4. Recommended sequence

1. Resolve decisions **#3, #11–14, #41** — nothing else can start
2. `published_schedule.employee_id` nullable + migration test proving Only me and Everyone are unchanged
3. `publish()` learns open shifts; `skipped-open` retires
4. The shared evaluator + domain tests, **no UI**
5. **Measure it** before any UI, as Phase 6 did
6. `/schedule/settings` + the four toggles (move `sch_availability` there)
7. Drawer can create an open shift; board grows an Unassigned row
8. Employee Open Shifts tab, read-only
9. Immediate claim — the conditional UPDATE and its race test first
10. Approval-based claim + manager review
11. Notifications + dedupe
12. Replacements (open)
13. Privacy/IDOR pass
14. Mobile + a11y measured in the browser

## G5. Likely files

`src/db.js` (published_schedule migration) · `src/scheduler.js` (evaluator,
publish, claim/replacement domain) · `src/server.js` (portal tab, claim routes,
manager review, drawer, settings page) · `src/portal.js` (notifications) ·
`public/staff.css` · `public/broadsheet.css` · `test/schedule-claims.test.js`
(new) · `test/schedule-replacements.test.js` (new) · `test/scheduler.test.js` ·
`test/schedule-publish.test.js` · `test/schedule-board.test.js` · `CLAUDE.md`.

## G6. Risks

**HIGH — the `published_schedule` migration (§D1).** It changes the meaning of
the one table employees read. Getting it wrong is a privacy or a
missing-shift bug, and both are invisible to a green suite.

**HIGH — the claim race (§D4).** Two employees, one shift. The conditional
UPDATE is simple; *forgetting* it is easy, and the failure only appears under
real simultaneous use.

**HIGH — revalidation at approval (§D5).** A stale request that assigns somebody
who is now inactive or unqualified is exactly the hole `create()`'s guards exist
to close.

**MEDIUM — overlap under immediate claim (#13).** Too loose and employees
double-book themselves into a manager's Issues list.

**MEDIUM — applicant privacy (§52).** The manager review surface must show
scheduling facts and not Phase 6 time-off reasons or manager-private notes.

**MEDIUM — losing-applicant notifications.** Easy to send none, or to send one
per rejection to everybody. Both are wrong.

**LOW — performance** (the batch seam exists) · **permissions** (inherits
`schedule` and `requirePortal`) · **the settings page** (one page, four rows).

## G7. What is factually wrong in the plans

1. **"Number of spots if supported"** (§C1) — no schema supports it and the
   obvious implementation contradicts Phase 0's "same row".
2. **Phase 0's `applied` state** (§C2) — correct for claims, but Phase 6
   removed it on reasoning that does not transfer. Both documents are right
   about their own phase; a reader taking Phase 6 as the precedent would be
   wrong here.
3. **The Phase 6 audit predicted `/schedule/settings` would be built for Phase
   6's toggle "because Phase 7 and Phase 8 both need it".** Phase 7 needed no
   setting and Phase 6 shipped its toggle in the toolbar, so the page still does
   not exist. The prediction was wrong about Phase 7 and right about Phase 8.

Everything else in the plans matches the code.

---

## Stop point

Audit only. No table, no route, no schema change, no test modified. The five
decisions in §G4 step 1 are what unblock the build.
