# ZWIN Scheduler — Phase 4 Targeted Audit

**Issues / Validation Engine**

Audited at `265bd3e`, 2026-08-09. Phases 0–3 complete and deployed.
**Nothing implemented. No files changed by this audit.**

---

## 1. Current warning / validation architecture

Two layers, and only one of them warns.

**Domain layer — `src/scheduler.js`.** All hard rules live in `validate()`
(line 302) and `normalizeBreaks()` (line 340), reached from `create()` and
`edit()`. Every one throws `ScheduleError(message, code)`. Routes catch it and
re-render the message as a `?err=1` flash. There is no "collect and continue"
path anywhere — the first failure aborts the write.

**Route layer — `src/server.js`.** Exactly **one** advisory exists in the whole
scheduler: `sbOverlapNote()` (line 17848). It runs *after* a successful write on
create and edit only, and appends a sentence to the success flash.

That is the entire warning architecture. There is no issue store, no severity
model, no aggregation, and nothing persists between requests.

---

## 2. Hard validation vs advisory — full matrix

### Hard (blocks the write, domain-level, reusable)

| Rule | Code | Line | Data validity or schedule quality |
|---|---|---|---|
| Unparseable / missing date-time | `time` | 298 | validity |
| No position chosen | `position` | 303 | validity |
| Employee does not exist | `employee` | 309 | validity |
| Employee is inactive | `inactive` | 314 | validity |
| Position not held by employee | `qualification` | 317 | **quality, enforced as validity** |
| End at or before start | `time` | 322 | validity |
| Shift longer than 24h | `time` | 327 | validity |
| Break with no / non-positive minutes | `break` | 356 | validity |
| Breaks total exceeds shift span | `break` | 360 | validity |
| Break starts before shift | `break` | 374 | validity |
| Break runs past shift end | `break` | 377 | validity |

### Hard (state guards, not data validation)

| Rule | Code | Where |
|---|---|---|
| Shift no longer exists | `missing` | `edit` 445, `cancel` 521, `unpublish` 747, `duplicate` 820 |
| Shift was cancelled | `cancelled` | `edit` 446, `duplicate` 821 |
| Copy-week source = destination | `range` | `copyWeek` 870 |

### Advisory (warns, never blocks)

| Rule | Where | Surfaces on |
|---|---|---|
| Employee has an overlapping shift | `sbOverlapNote()`, route-level | create, edit **only** |

**Nothing else warns.** Not duplicate, not copy-week, not publish, not
publish-week. Confirmed by tracing every `sbOverlapNote` call site: only
`POST /schedule/shift` (18313) and `POST /schedule/shift/:id` (18342).

**The one rule that is miscategorised today:** *position not held* is schedule
quality being enforced as data validity. That is correct at create time and is
the reason §3 below matters — the same condition can arise later, when blocking
is no longer available as a response.

---

## 3. Reusable domain helpers — what an engine can build on today

| Helper | Signature | Reusable as-is? |
|---|---|---|
| `overlapsFor(shift)` | shift → array of clashing rows | **Yes.** Pure read, no side effects |
| `heldPositions(id)` | id → `[slug]` | **Yes** |
| `heldPositionsFor(ids)` | ids → `{id: [slug]}` | **Yes.** Batched, 2 queries total |
| `weekTotals(shifts)` | shifts → by employee / date / cell | **Yes.** Already gives raw daily and weekly minutes |
| `spanMinutes` / `paidMinutes` | shift → minutes | Yes |
| `inRange(from,to)` | board query, hides cancelled | Yes |
| `q.inRangeAll(from,to)` | includes cancelled | Yes — added in Phase 3 |
| `q.pubInRange(from,to)` | published rows in a week | Yes |
| `q.pubById(id)` | one published row | Yes |
| `publishedFingerprint(emp,from,to)` | employee-visible state as a string | Yes |
| `validate()` | — | **No.** Throws on first failure; an engine needs all failures. Would need a non-throwing sibling that returns a list |

The domain is in good shape for this. Nine of ten helpers an engine needs
already exist and are already exported.

---

## 4. Overlap findings (§2 of the brief)

```sql
SELECT * FROM scheduled_shifts
WHERE employee_id = @employee_id AND status <> 'cancelled' AND id <> @id
  AND starts_at < @ends_at AND ends_at > @starts_at
```

| Question | Answer |
|---|---|
| Interval semantics | **Half-open.** A shift ending 22:00 and one starting 22:00 do **not** overlap. Correct — back-to-back is legal |
| Cross-midnight | **Free.** Compares UTC stamps, never `business_date`. No special case needed |
| Self-exclusion | Yes, `id <> @id` |
| Cancelled | Excluded |
| Open shifts | `overlapsFor` returns `[]` when `employee_id` is null. An open shift can never overlap-check |
| Business-date assumption | **None** — this is the only scheduler query with no date-key dependency |
| Scope | **Unbounded.** Scans all of that employee's shifts, not just the week |
| Index | `idx_sched_emp (employee_id, business_date)` — the `employee_id` prefix is used; the timestamp predicate is a scan within it |

**Symmetry note.** Overlap is a property of a *pair*, but the query is asked
from one side. Deriving a week naively reports each clash twice — once from A,
once from B. An engine must decide whether an issue is one item or two (see
§21 identity).

### To expose overlap at each level

| Level | What is needed |
|---|---|
| Per shift | Nothing new. `overlapsFor(s)` per shift |
| Per employee | Group derived pairs by `employee_id`. No new query |
| Board count | Count deduped pairs. No new query |
| Week panel | Needs employee names — `sbEmpName` or the board's existing `byId` map already has them |

**Locked rule preserved: overlap warns, never blocks.** Nothing in this audit
proposes changing that.

---

## 5. Qualification and inactive findings (§3, §4)

### Stale-invalid assignments are possible today. Three routes create them.

| Route | Effect on existing shifts | Checked against the schedule? |
|---|---|---|
| `POST /employees/:id/roles/delete` (8629) | Removes a held role. Shifts scheduled into it become unqualified | **No check at all** |
| `POST /employees/:id` (employee edit) | Rewrites the primary `role`. If it was the only qualification, every shift in the old position becomes unqualified | **No check** |
| `POST /positions/:id/active` (11490) | Deactivates a position | **No effect** — see below |

**`heldPositions()` ignores `positions.active`.** It reads
`employees.role` + `employee_roles.role`, filters out `manager`, and never joins
`positions`. Two consequences:

1. Deactivating a position does **not** invalidate existing shifts. Arguably
   correct — the plan survives.
2. You can still *create* a shift in a deactivated position. The drawer's
   picker offers it, because `held[]` comes from `heldPositionsFor` and
   `posNames` comes from `positions.all` (which includes inactive rows).
   **This is a real gap, and it is a create-time gap, not an issue-engine one.**

**Position rename is safe.** `positions.update` changes `name` and never
`slug`; shifts store the slug. Renaming propagates to every display.
**Position delete does not exist** — no `DELETE FROM positions` anywhere.

### Inactive employees

| Surface | Behaviour with an inactive employee holding shifts |
|---|---|
| Create / edit | Blocked at `validate()` — `'That employee is not active.'` |
| Existing drafts | **Remain.** Nothing cascades on deactivate |
| Existing published rows | **Remain in `published_schedule`** |
| Manager board | **Visible, deliberately.** `/schedule` re-adds anybody holding a shift this week even after deactivation — "a row that vanishes is a plan nobody can find to cancel" |
| Employee portal | Unreachable. `staffByPin` requires `active = 1`, so they cannot sign in |
| Reactivation | `schedule_visible_from_at` restores only shifts starting after the moment they returned |

**Roadmap §I.9 [v4] explicitly removed "inactive employee" from the Phase 4 rule
list** on the grounds that it would flag something invisible. That reasoning is
now **partly out of date**: the board *does* show these shifts. Whether that
makes it issue-worthy is decision D5 below.

---

## 6. Publication-state findings (§5)

The board already computes all of this, in `/schedule` (~17945):

```js
const stateCounts = shifts.reduce((a,s) => { a[pubOf(s)] = (a[pubOf(s)]||0)+1; return a }, {})
const pendingCancel = SCH.q.inRangeAll.all(week.start, week.end)
  .filter((s) => s.status === 'cancelled' && SCH.q.pubById.get(s.id)).length
const stale = (stateCounts.changed||0) + (stateCounts.draft||0) + pendingCancel
```

| State | Computable now? | Publication state, issue, or both |
|---|---|---|
| Never published | **Yes** — `stateCounts.draft` | Publication state only |
| Published | **Yes** | Publication state only |
| Unpublished changes | **Yes** — `stateCounts.changed` | **Both.** It is the one publication state that means "the floor is looking at something wrong" |
| Individually unpublished | **No — indistinguishable by design.** `pubOf()` collapses never-published and unpublished-then-draft into `'draft'`, because to an employee both mean "nothing to see" | Would need a new column to separate |
| Cancelled awaiting publish | **Yes** — `pendingCancel` | **Both.** An employee is still being shown a shift that is off |

**Do not duplicate Phase 3's chip.** The toolbar chip already reports
`N unpublished changes · not on the employee schedule yet`. If Issues also
counts these, the same fact is stated twice in the same toolbar. This is
decision D4.

---

## 7. Schedule-quality rules — what the data supports today (§6)

| Candidate rule | Data supports? | Already prevented? | Already warned? | Phase 4 issue? | Needs new policy? |
|---|---|---|---|---|---|
| Overlapping shifts | **Yes** | No | Yes (create/edit only) | **Yes — core** | No |
| Two positions at once | Yes — same as overlap | No | Same warning | Same issue as overlap | No |
| Scheduled while inactive | **Yes** | At create | No | Candidate (D5) | No |
| Position no longer held | **Yes** | At create only | No | **Yes — strong** | No |
| Position inactive | **Yes** | **No — not even at create** | No | Candidate (D7) | No |
| Zero / negative duration | Yes | **Yes**, hard | — | No — impossible | No |
| Break longer than shift | Yes | **Yes**, hard | — | No — impossible | No |
| Duplicate identical shift | Yes | No — duplicate is a feature | No | Surfaces as overlap | No |
| Excessive daily hours | **Yes** — `weekTotals.byCell` | No | No | Needs a threshold | **Yes** |
| Excessive weekly hours | **Yes** — `weekTotals.byEmployee` | No | No | Needs a threshold | **Yes** |
| Insufficient rest between shifts | **Yes** — derivable from stamps | No | No | Needs a threshold | **Yes** |
| Outside business-date expectations | Partly | Guarded by the 24h rule | No | No | No |
| Service / daypart mismatch | Yes — `suggestDaypart` exists | No | No | Weak. Daypart is stamped once by design | Probably |
| Open shift without employee | Yes | No — intentional | No | See §9 | Yes |

**No thresholds invented.** Every "excessive" rule is marked as requiring a
product decision because the codebase contains no scheduling threshold of any
kind.

---

## 8. Overtime boundary (§7)

**Safe to show — already computed, no new maths:**

- raw scheduled **weekly** minutes per employee (`weekTotals.byEmployee`)
- raw scheduled **daily** minutes per employee (`weekTotals.byCell`)
- both in span and paid-minutes form, break-aware

**Must not be shown** — would cross into projected OT, which roadmap §I.13
removed on purpose:

- "will go into overtime"
- overtime cost or premium
- salaried vs hourly conclusions

**The trap.** `ot_enabled`, `ot_threshold` (40) and `ot_multiplier` (1.5) exist
in settings, and `employees.ot_exempt` exists. It would be four lines to compare
scheduled hours to `ot_threshold`. **That is exactly the projection the roadmap
forbids** — actual OT comes from worked time in `aggregatePayroll`, and a second
approximate path is what §I.13 was written to prevent.

If a scheduled-hours warning ships, it needs its **own** threshold with its own
name, deliberately not `ot_threshold`, or the two will be conflated within a
month.

---

## 9. Availability, time off, open shifts — future hooks only (§8, §9)

**No availability or time-off model exists.** Verified against the live schema:
zero tables matching `avail|time_off|pto|request|prefer`. Phase 6 owns this.

**Phase 4 hook requirement — exactly one thing:** issues must be produced by a
function that takes a week and returns a *list*, not by code inlined into the
board template. If Phase 6 can add a rule by adding one entry, the extensibility
requirement is met. No schema, no placeholders, no dormant flags.

**Open shifts.** The domain supports `employee_id IS NULL`; `publish()` returns
`skipped-open` and never publishes them. An open shift is **not obviously a
problem** — it may be deliberate, and Phase 8 gives it a claim surface. Product
options:

- (a) never an issue — silent until Phase 8
- (b) informational only, no severity
- (c) an issue only when it is within N days of today — needs a threshold

Recommendation: **(a)**, deferring to Phase 8, unless the manager asks otherwise.

---

## 10. Derived vs persisted (§10)

**Recommendation: derive on read. No table, no cache.** Measured, not assumed:

| Week size | Derive time (min of 5) | Overlap rows found |
|---|---|---|
| 10 employees / 50 shifts | **0.25 ms** | 0 |
| 50 employees / 300 shifts | **1.30 ms** | 0 |
| 50 employees / 600 shifts | **4.01 ms** | 500 |

That is `inRange` + `overlapsFor` per shift + `weekTotals`, against a copy of
the production database. A pathological week — 600 shifts with 500 overlapping
pairs — derives in **4ms**. Your real weeks are the first row.

| | Derived | Persisted |
|---|---|---|
| Correctness | Always current by construction | Needs invalidation on 10+ mutation points |
| Staleness | Impossible | The whole risk |
| Performance | 0.25ms at your size | Faster in theory, irrelevant here |
| Simplicity | No schema, no migration, no cleanup | New table, new writes, new failure modes |
| Phase 6 fit | Add a rule function | Add a rule *and* every invalidation path that could change it |

**The only argument for persistence is dismissal** (§22). Do not add a table to
support a feature nobody has asked for.

**N+1 note.** `overlapsFor` per shift *is* technically N+1 — 600 queries in the
worst row above. It does not matter at 4ms, and a single self-join could replace
it if it ever did. Recorded, not optimised.

---

## 11. UI insertion points (§11)

The board's anatomy, unchanged:

```
.sb-frame
  .sb-bar        week nav · Copy last week · Publish week · .sb-chip  <- toolbar
  .sb-grid       WHO column + 7 day columns
    .sbk         a shift card: .sbk--<colour> .sbk--<pubstate>, contains <s>
  .sb-sum        Shifts / People footer
```

**Three visual channels, and all three are already spoken for:**

| Channel | Currently carries | Free for issues? |
|---|---|---|
| Card **fill colour** | Position (10-colour palette) | **No — locked.** Position colour is dominant |
| Card `<s>` **shape marker** | Publication state — hollow ring = draft, filled = changed, hidden = published | **No** |
| Card **text** | Position name + times | No |

So an issue marker needs a **fourth** channel. The options that do not collide:

- a **border or outline** on the card (unused today)
- a small **corner glyph** in the opposite corner from `<s>`
- a **left edge rule** on the card

Recommendation: **outline**, because it reads at a glance without adding a
second small shape competing with `<s>` — and because `.bs *` forces
`border-radius: 0` inside the shell, so an outline stays crisp.

**Toolbar.** `.sb-chip` already sits at the end of `.sb-bar` and already carries
a derived tone (`--idle` / `--ok` / `--warn`). An Issues count belongs **beside**
it as a second chip, not inside it — the publication chip answers "can the floor
see this week", the issues chip answers "is this week sound". Different
questions.

**Per-employee marker.** The WHO column already renders `12h · 2 shifts` per
person. An issue count fits there with no layout change.

---

## 12. Panel pattern (§12)

Existing patterns, in order of fit:

| Pattern | Where | Fit |
|---|---|---|
| `.drawer` + `.drawer-scrim` + `body.drawer-open` | the shift drawer, right side | **Best.** Already on this page, already keyboard-dismissible, already has the Escape handler |
| `.bs-side` aside | generic side panel | Same machinery |
| `.tsr-*` review sheet | timesheet review | Bottom-up sheet, wrong axis for a list |
| `.bs-notice-bar` | flash | Single message only |

**Recommendation: a second drawer**, using the same primitives as the shift
drawer. Clicking an issue should focus the offending shift.

**Can the board support scroll-to / highlight / open-drawer without new state
machinery?** Yes, and cheaply:

- every card already carries `data-edit="<id>"` — a selector is enough
- the drawer already opens from a click handler keyed on that attribute
- `scrollIntoView()` needs no state
- highlight is one class toggle

No drag/drop, no new state machine, no framework.

---

## 13. Severity model (§13)

**Conventions already exist. Do not invent colours.**

| Token | Value (light) | CSS comment says |
|---|---|---|
| `--danger` | `#b3261e` | **"blocking only"** |
| `--warning` / `--warn` | `#b25a09` | attention — amber |
| `--positive` | `#16863a` | success — green |

Applied patterns: `.bs-notice-bar.crit` / `.ok`, `.sb-chip--idle/ok/warn`,
`.bs-sec-h.warn`, `.s-done / .s-soon / .s-none / .s-ready`.

So the three-level model Phase 4 needs is **already tokenised**:

| Phase 4 level | Existing token | Meaning |
|---|---|---|
| Blocking invalidity | `--danger` | Reserve strictly. Nothing in the proposed scope is blocking |
| Advisory warning | `--warning` | overlap, stale qualification |
| Informational | `--muted` / existing chip idle | publication state |

**Note:** the CSS comment on `--danger` says *blocking only*. If no Phase 4
issue blocks (recommended), then **no Phase 4 issue should use `--danger`**, or
the convention degrades.

---

## 14. Publish interaction (§14)

**Can any current hard rule make a week fundamentally unpublishable?**
**No.** Every hard rule fires at create/edit time. `publish()` and
`publishWeek()` call no validation whatsoever — they reconcile and upsert. A week
that exists is a week that can be published.

**Therefore:** Publish remains allowed, and no blocking modal is needed.
Consistent with the locked rule.

**What would be required to surface an issue summary around publish:** nothing
structural. `sbBack()` already carries a message; the publish routes already
count outcomes (`told`, `open`, `live`, `gone`). Appending "3 issues remain in
this week" to the existing flash is a one-line change and does not pretend the
schedule is conflict-free.

**Recommendation:** report **after** publish in the existing flash. A
pre-publish interstitial is a blocking confirmation modal by another name, and
the brief says not yet.

---

## 15. Duplicate and copy-week (§15)

Phase 2 deliberately suppressed the immediate overlap warning on `duplicate` and
`copyWeek` because it was noisy. Confirmed: `sbOverlapNote` has exactly two call
sites, neither of them these.

**A derived engine fixes this for free.** Because issues are computed from the
week's current state on every board load, a conflict introduced by duplicate,
copy-week, or any later edit appears the moment the board renders — with **no
route-specific warning code at all**. Neither route needs to change.

This is the single strongest argument for derivation over persistence: the
noisy-at-write / visible-at-review split falls out of the architecture rather
than being engineered.

---

## 16. Freshness (§16)

If derived on page load, "when does it recalculate" has one answer: **every
time the board is rendered**. No invalidation matrix, no stale states, and none
of these mutation points need to know the engine exists:

create · edit · cancel · duplicate · copy-week · publish · unpublish ·
employee deactivate/reactivate · role add/remove · position edit/deactivate

**The only staleness risk** is two managers on the board at once — one fixes an
overlap, the other still sees it until reload. That is the same staleness the
board already has for shifts themselves, and it is acceptable. No websockets.

---

## 17. Permissions and privacy (§19, §20)

**Permissions.** `sbGuard(req, res)` is called by all **8** schedule write
routes (pinned by an existing test), and resolves `navAllowed('/schedule')` —
the same question the sidebar asks. An Issues route or panel inherits this by
living on `/schedule`. **No new permission tier needed.**

**Privacy — the risk is real and specific.** An issue like *"Kevin overlaps
with his 4pm"* names an employee and their hours. Three checks:

| Check | Status |
|---|---|
| Employee portal reads only `published_schedule` | **Safe by construction.** Drafts are not in the table the portal queries |
| Portal page source contains no coworker data on "Only me" | **Already tested** — Phase 3 test asserts it against the whole page source, not just rendered text |
| Manager issue metadata must never enter `/portal/*` | **Requirement for Phase 4.** No portal route may import the issues module |

**Leakage risk: LOW, with one caveat.** The `Everyone` portal view already shows
coworker names, positions and times — that is its approved purpose. Issues must
not be added to it. The Phase 3 privacy test should be extended to assert the
issues payload never appears in any `/portal/*` response.

---

## 18. Issue identity (§21)

**Recommendation: deterministic derived keys. No DB-generated IDs.**

| Issue | Key |
|---|---|
| Overlap | `overlap:<minId>:<maxId>` — sorted, so the pair yields one key from either side |
| Stale qualification | `qualification:<shiftId>` |
| Inactive employee | `inactive:<shiftId>` |
| Unpublished change | `unpublished:<shiftId>` |

Sorting the overlap pair is what makes the count stable and solves the symmetry
problem in §4 — otherwise one clash counts as two issues.

Deterministic keys give deep-linking for free (`/schedule?issue=overlap:41:52`)
and stay stable across reloads as long as the underlying shifts do. DB IDs would
require persistence, which §10 argues against.

**Dismissal / acknowledgement (§22):** the roadmap does not lock it, and it is
the only feature that would force a table. Options:

- (a) **no dismissal** — issues persist until fixed. Simplest, and honest
- (b) session-scoped hide — no schema, forgotten on reload, probably useless
- (c) persisted acknowledgement — needs a table keyed on the derived key, and
  needs a rule for what happens when the shift changes underneath it

Recommendation: **(a)**. An unresolved warning that can be permanently silenced
is a warning that will be silenced and forgotten.

---

## 19. Scenario matrix A–P (§24)

| | Scenario | Detectable now? | Blocked? | Warned? | Phase 4 issue? | Severity |
|---|---|---|---|---|---|---|
| A | Same employee, overlapping shifts | **Yes** | No | Yes (create/edit) | **Yes — core** | warning |
| B | Adjacent shifts, no overlap | Yes — correctly *not* an overlap | No | No | **No** | — |
| C | Duplicate creates exact overlap | **Yes** | No | **No** — suppressed | **Yes** | warning |
| D | Copy-week creates overlap | **Yes** | No | **No** — suppressed | **Yes** | warning |
| E | Employee loses held position after scheduling | **Yes** | Create only | No | **Yes — strong** | warning (D6) |
| F | Position becomes inactive after scheduling | **Yes** | **No, not even at create** | No | Candidate (D7) | info |
| G | Employee inactive, future **drafts** exist | **Yes** | Create only | No | Candidate (D5) | warning |
| H | Employee inactive, **published** shifts exist | **Yes** | Create only | No | Candidate (D5) — worse than G, the floor still sees it | warning |
| I | Published shift has unpublished changes | **Yes** — `changed_after_publish` | No | Chip only | **Both** (D4) | info or warning |
| J | Cancelled draft still in published truth | **Yes** — `pendingCancel` | No | Counted in chip | **Yes** — the floor sees a cancelled shift | warning |
| K | Individually unpublished shift remains a draft | **No — indistinguishable** from never-published by design | No | No | Needs a column first | — |
| L | Open shift exists | Yes | No | No | Probably not (§9) | info at most |
| M | Break exceeds shift | Yes | **Yes, hard** | — | **No — impossible to reach** | — |
| N | Service / daypart changed | Yes | No | No | No — stamped once by design | — |
| O | Note changed | Yes | No | No | **No** — deliberately non-material in Phase 3 | — |
| P | Many scheduled hours, no OT policy | **Yes** — raw minutes available | No | No | Only with a new threshold (D9) | warning |

---

## 20. Smallest useful Phase 4 (§23)

### Build now — every one from existing truth, no new schema

1. **Overlap** (A, C, D) — the core, and the one that already has a proven helper
2. **Stale qualification** (E) — a shift in a position the person no longer holds
3. **Cancelled but still published** (J) — the floor is looking at a shift that is off

Three rules. All derived. No table, no migration, no new permission, no
threshold, no product policy that does not already exist.

### Must wait

| Wants | Blocked by |
|---|---|
| Availability conflict | Phase 6 — no data model |
| Time-off conflict | Phase 6 — no data model |
| Open-shift urgency | Phase 8, and a threshold |
| Individually-unpublished (K) | A new column to distinguish it |
| Excessive hours (P) | A product decision on the threshold (D9) |

### Deliberately excluded

Inactive-employee issues (G/H) and inactive-position (F) are **candidates, not
recommendations** — they are D5 and D7 below, and both are cheap to add later.

---

## 21. Product decisions requiring approval (§25)

Nothing below has been decided.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Which issue types ship | The three in §20 |
| D2 | Derived or persisted | **Derived.** 0.25ms measured |
| D3 | Does any issue block publish | **No.** Keeps the locked rule |
| D4 | Do unpublished changes belong in Issues | **No** — the chip already says it. Avoid saying it twice |
| D5 | Inactive employee with future shifts | Warning for **published** (H) only; drafts (G) are the manager's own private plan |
| D6 | Stale held-position — warning or error | **Warning.** It was valid when made; the manager may re-add the role |
| D7 | Inactive positions create issues | **No** for existing shifts — but **fix the create-time gap** separately (§5) |
| D8 | Open shifts count as issues | **No.** Defer to Phase 8 |
| D9 | Raw high scheduled hours warning | **Not in Phase 4.** Needs its own threshold, deliberately not `ot_threshold` |
| D10 | Dismissal / acknowledgement | **No.** It is the only thing forcing a table |
| D11 | Issue count in the toolbar | **Yes** — second chip beside the publication chip |
| D12 | Per-card issue markers | **Yes** — as an outline, the only free visual channel |
| D13 | Clicking an issue opens the drawer | **Yes** — `data-edit` already makes it nearly free |
| D14 | Duplicate/copy conflicts: immediate or persistent | **Persistent only.** Keeps Phase 2's noise decision and needs no route changes |

---

## 22. Recommended sequence (not implemented)

1. A non-throwing `issuesFor(weekStart)` in `scheduler.js` returning
   `[{key, kind, severity, shiftIds, employeeId, message}]`
2. Tests for the three rules against the domain, before any UI
3. Toolbar count chip
4. Per-card outline marker
5. Issues drawer, reusing the shift drawer's primitives
6. Click-through to the shift
7. Publish flash mentions remaining issues
8. Privacy test: no issues payload in any `/portal/*` response

Each step is independently shippable and reversible.

**Likely files:** `src/scheduler.js` (the engine + one query),
`src/server.js` (`/schedule` render, chip, drawer, click handler),
`public/broadsheet.css` (`.sb-issue*`, the outline),
`test/scheduler.test.js`, `test/schedule-board.test.js`, and a new
`test/schedule-issues.test.js`.

---

## 23. Risks

**High**
- **Visual collision.** Three states on one card — position colour, publication
  marker, issue marker. Get this wrong and the board becomes unreadable, which
  is the exact failure the Phase 2 redesign was commissioned to fix
- **Threshold creep.** "Excessive hours" is one small step from projected OT,
  which §I.13 removed on purpose

**Medium**
- **Double-counting overlap** if pairs are not sorted into a single key
- **Restating publication state** in two places in one toolbar (D4)
- **Privacy** — issues name employees; nothing may reach `/portal/*`

**Low**
- Performance. Measured at 0.25ms for a real week
- Staleness between two concurrent managers

---

## 24. Roadmap corrections (§21 of the deliverable)

Three things in `ZWIN-SCHEDULER-ROADMAP.md` are not true of the current code:

1. **Phase 2 claims the drawer shows "held positions · current scheduled hours ·
   same-day assignments" as employee picker context.** Held positions landed
   only yesterday (`297dcc8`). **Scheduled hours and same-day assignments in the
   drawer still do not exist.** The roadmap describes Phase 2 as having
   delivered something it did not.

2. **Phase 4's rule list says "excessive scheduled hours *if any rule already
   exists*".** No such rule exists, anywhere. The conditional reads as though it
   might.

3. **§I.9 [v4] justifies excluding inactive employees from validation because
   their shifts are hidden from the manager.** They are **not** hidden — the
   board explicitly re-adds anybody holding a shift in the visible week, by
   design and with a comment saying why. The exclusion may still be right, but
   the stated reason is factually wrong.

One further gap found during this audit, outside Phase 4's scope:

4. **A shift can be created in a deactivated position.** `heldPositions()` never
   joins `positions`, so `active = 0` has no effect on scheduling. This is a
   create-time validation gap, not an issues-engine question, and should be
   fixed on its own.
