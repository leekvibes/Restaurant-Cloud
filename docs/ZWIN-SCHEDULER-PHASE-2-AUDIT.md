# ZWIN SCHEDULER — PHASE 2 TARGETED AUDIT

Manager Week Board + Create/Edit Drawer + Copy Previous Week.

**Audit only. Nothing implemented, no file modified, no production table created.**
Every claim cites the file and line it came from.

Production at time of audit: `8d095ec`, build `28c2b9a3cf`, 928 tests, healthy.
`src/scheduler.js` ships but **nothing requires it**, so production has no
scheduler tables. Phase 2 is the release that changes that.

---

# 1. THE PHASE 1 DOMAIN AS ACTUALLY BUILT

Read from `src/scheduler.js`, not from the Phase 0 document.

## 1.1 Exported API

```
create(input)             → row + breaks; always status='draft'
edit(id, patch)           → row; sets changed_after_publish on material change
cancel(id)                → status='cancelled'; row kept
publish(ids)              → FULLY IMPLEMENTED (line 390); only writer of
                            published_schedule
byId(id)                  → row + breaks
inRange(from, to)         → manager board query, excludes cancelled
weekFor(anyDate)          → { start, end, shifts }, Monday-anchored
publishedFor(emp, opts)   → employee view; reads published_schedule only
overlapsFor(shift)        → clashes for the same employee
copyWeek(from, to, opts)  → { made, skipped }
serviceFor(utc)           → TC.suggestDaypart wrapper
businessDateFor(utc)      → TC.businessDateOf wrapper
heldPositions(employeeId) → strict; employee.role + employee_roles
q, DAYPARTS, STATUSES, ScheduleError, WINDOW_BACK(7), WINDOW_FORWARD(90)
```

## 1.2 Semantics that matter for the UI

**Status** is `draft | published | cancelled`. `create()` always produces
`draft` — there is no way to create anything else.

**`edit()` material change** = employee, position, start, end, daypart, or
breaks. Note alone is not material. Sets `changed_after_publish = 1` only when
the row is already `published`.

**`cancel()`** keeps the row and sets status. It never deletes. A published row
being cancelled also sets `changed_after_publish = 1`, so the cancellation is
itself something to publish.

**Daypart** is stamped at create from the *start* time and re-stamped on edit
**only when the start actually moves** (line ~347). A settings change never
reaches an existing row.

**Business date** likewise comes from the start, via `TC.businessDateOf` with
the clock's own `tc_day_cutoff`.

**Validation** (`validate()`, line ~270) enforces: position required · employee
exists · employee active · employee holds the position · end after start ·
duration ≤ 24h. Open shifts (`employee_id = null`) skip the employee checks by
design.

**Timezone**: input is local `YYYY-MM-DD HH:MM`, converted by
`TC.localInputToUtc()` which probes across DST rather than assuming an offset.
Storage is UTC.

## 1.3 🔴 Four defects in my own Phase 1 code

**D1 — `inRange()` is an N+1.** Line 435 calls `q.breaksFor.all(r.id)` once per
row. A week of 40 shifts is 41 queries per board render. Must be a single
`WHERE scheduled_shift_id IN (…)` before the board ships.

**D2 — Monday is hard-coded.** Line 441, `(d.getDay() + 6) % 7`. There is no
week-start setting anywhere. §5 below turns this into a decision.

**D3 — `weekFor()` parses in server-local time.** Line 440,
`new Date(\`${anyDate}T00:00:00\`)`. Every other date path in the module goes
through `TC.localInputToUtc` precisely to avoid this. It is correct today only
because the server is `America/New_York` — which is exactly why it would
survive review.

**D4 — no hours arithmetic exists.** Nothing in the domain computes scheduled
hours. §13's unpaid-break question is a decision to make, not behaviour to
document.

## 1.4 What Phase 2 needs that the domain does not expose

* a **batch** breaks fetch (D1)
* **week totals** — hours per employee, per day (D4)
* **`duplicate(id, patch)`** — currently the UI would have to read then create
* **`heldPositions` for many employees at once** — the drawer needs every
  employee's positions to switch without a round trip

None require schema change. All are additive functions.

---

# 2. FIRST SERVER `require()` — WHAT ACTUALLY HAPPENS

## 2.1 On load, `src/scheduler.js` executes exactly one `db.exec`

Creates, all `IF NOT EXISTS`:

| Object | |
|---|---|
| `scheduled_shifts` | + `idx_sched_date`, `idx_sched_emp`, `idx_sched_open` |
| `published_schedule` | + `idx_pub_emp`, `UNIQUE(scheduled_shift_id)` |
| `scheduled_breaks` | + `idx_sbreak_shift` |

**No triggers. No settings writes. No data writes. No `ALTER`, `DROP` or
`DELETE` at module scope** — verified by grep, 0 matches.

Settings are read lazily inside `serviceFor()` / `businessDateFor()`, never at
load, so requiring the module touches no settings row.

## 2.2 Order

`scheduler.js` requires `./db` and `./timeclock`. Both already load before it
in `server.js`, and both are idempotent. Requiring scheduler **after** them is
safe; requiring it first would also work, since `db.js` self-initialises. No
ordering constraint.

## 2.3 Failure behaviour

`db.exec` throws on failure, at require time, which means **the server would
fail to boot** rather than start half-initialised. That is the right failure
mode — a scheduler with three tables and no fourth is worse than a server that
refuses to start — but it means a schema error is a hard outage, not a
degraded page. See §20.

## 2.4 ⚠️ Stated plainly

**Phase 2 is the release in which scheduler tables first appear in the
production database.** Empty, additive, three tables and five indexes. Nothing
else in the schema is touched.

---

# 3. OWNER ROUTE, NAV AND PERMISSIONS

## 3.1 How the gate works

```js
// server.js:558  the global gate
if (!APP_PASSWORD) return next();                  // dev, open
if (OPEN_PATHS.some(re => re.test(req.path))) return next();
if (!user) → 302 /login (GET) or 401 (write)
if (user.role === 'viewer' && req.method !== 'GET') → 403   // server.js:572
if (!canSee(user, featureFor(req.path))) → 403
```

`canSee = (user, key) => !user ? false : (user.master || !user.features.length || !key || user.features.includes(key))`

So: **master sees everything; an account with an empty feature list sees
everything; otherwise the key must be listed.**

## 3.2 Recommendation

| | |
|---|---|
| Route | **`/schedule`** — short, unclaimed (0 handlers today), reads as the product name |
| Feature key | **`schedule`** — its own identity; `shifts` stays with Services, untouched |
| `AREAS` entry | `{ key: 'schedule', label: 'Schedule', paths: ['/schedule'] }` |
| `SECTIONS` | Operations group, directly after Services |
| Viewer | **read-only board, no writes** — comes free from the verb gate at :572 |
| Owner/master | full |

**Why viewer gets read access:** it costs nothing (the gate already blocks
their writes), and a view-only manager who can see next week's roster is a
real, useful role. The alternative — excluding `schedule` from their features —
remains available per account without any code.

⚠️ **Consequence of a new key:** accounts with a *non-empty* feature list will
NOT see Schedule until `schedule` is added to them. Accounts with an empty list
(the common case) get it automatically. This needs saying out loud before ship.

---

# 4. WEEK BOARD LAYOUT — THE GRID ALREADY EXISTS

## 4.1 The find

**The hardest UI problem in Phase 2 is already solved once in this codebase.**
The Timesheets employee-by-day grid (`.tsg-*`, broadsheet.css:4250+) is an
employee × day grid with:

```css
.tsg-scroll { overflow-x: auto; max-width: 100%; min-width: 0; }
.tsg { display: grid;
       grid-template-columns: 132px repeat(var(--tsg-cols), minmax(46px,1fr)) 96px;
       width: max-content; min-width: 100%; }
.tsg-dh  { position: sticky; top: 0;  z-index: 2; }   /* day headers */
.tsg-emp { position: sticky; left: 0; z-index: 3; }   /* frozen employee column */
.tsg-tot { position: sticky; right: 0; z-index: 3; }  /* frozen week total */
.tsg-corner { z-index: 4; }
```

And its own comment already states the responsive decision:

> *"A phone scrolls this sideways rather than reflowing it into cards. That is
> deliberate… Name and period total stay frozen at both edges so the two figures
> that matter are never off-screen."*

The z-index note is equally load-bearing: **at or below 20, so the grid never
draws over the sidebar (40), nav (55) or masthead (60).**

**Recommendation: extend this pattern, do not invent a second grid.** A
`.swb-*` family modelled on `.tsg-*`, or `.tsg-*` generalised. Either way the
frozen-column, contained-scroll, z-index-capped decisions are inherited rather
than re-derived.

## 4.2 Shell constraints

Breakpoints in use: 560 · 620 · 640 · 700 · 760 · 820 · 860 · 900 · 1000 ·
1100 · 1180. Content is **not** globally max-width capped — `.bs .wrap
{ max-width: none }` (line 727) — so a wide board is allowed. Sticky offsets:
masthead 61px, nav `top: var(--mast-h)`.

## 4.3 What must not happen

The board scrolls **inside `.swb-scroll`**, never the page. Cards do not shrink
below readable — the column has a `minmax()` floor and the container scrolls
instead. The sidebar keeps its z-index. At 320–430 the page must not overflow
horizontally even though the board does, internally.

---

# 5. WEEK AND DATE SEMANTICS

| Question | Recommendation |
|---|---|
| Default week | the week containing **today's business date**, via `businessDateFor(nowUtc())` — not the calendar date |
| Week start | **Monday** (already hard-coded, D2) — see decision Q1 |
| Prev / next | ±7 days on the start date |
| Today | jump to the current business week |
| Jump | `<input type="date">`, snapped to that date's week |
| Column heading | **business date**, because that is what a shift is filed under and what the clock agrees with |
| Overnight | belongs to the column its **start** falls in — a Friday 6pm–2am shift is a Friday cell |
| URL | **`/schedule?w=YYYY-MM-DD`** (the week start), so a week is linkable and bookmarkable |

**D3 must be fixed first.** `weekFor()` currently derives the weekday in
server-local time; it should use the same helper path as everything else.

---

# 6. EMPLOYEE ROWS

Available: `q.allEmployees` (`WHERE active = 1 ORDER BY role, name`, db.js:266)
and `S.heldPositions(id)`.

**Row order recommendation: position sort, then name.** `positions.sort` already
exists and is drag-orderable by the owner (Job list), so the board would follow
an order the owner has already expressed. `q.allEmployees` orders by `role`
alphabetically, which is arbitrary — a new query is warranted.

| Case | Behaviour |
|---|---|
| Active, no positions | **row shown**, but the drawer refuses — `validate()` throws `qualification`. The row must say why, not fail silently on click. |
| Active, no shifts this week | **row shown, empty.** An empty row is how you schedule somebody. |
| Multiple positions | one row; position lives on the card, not the row |
| Goes inactive while the page is open | the write fails with `not active` (`ScheduleError` code `inactive`) — the drawer must surface it, not swallow it |
| Inactive with historical shifts | **not shown in Phase 2.** Locked in Phase 0 §I.9. |

**No wage information on the board.** Phase 10 owns labour.

---

# 7. SHIFT CARDS

## 7.1 Card content for Phase 2

Needed now: **time range** · **position** · **planned-break indicator** ·
**note indicator**.

Deliberately *not* now:

* **service/daypart** — every shift has one and it is derived from the time
  already shown. Adding it to a small card is noise. Show it in the drawer.
* **draft/published state** — in Phase 2 *everything is a draft* (§9), so a
  badge that is always the same value is decoration.
* issue indicators — Phase 4.

## 7.2 Cell behaviour

| Case | |
|---|---|
| Zero shifts | empty, clickable, keyboard-focusable — this is the create affordance |
| One / many | stacked, **ordered by `starts_at`** (already the `inRange` order) |
| Overnight | rendered in its start column, with the end time shown as `2:00a` so it reads as next-day |
| Cancelled | **absent** — `inRange` already filters `status <> 'cancelled'` |
| Open (`employee_id` null) | ⚠️ **has no row to live in.** See decision Q4. |

## 7.3 Query shape

`inRange()` already joins `employees` for name and active flag — no N+1 there.
**But breaks are N+1 (D1)** and must be batched before this ships.

---

# 8. CREATE / EDIT DRAWER

## 8.1 Existing pattern

`.bs-sheet` is the owner drawer primitive (`.bs-sheet`, `.bs-sheet-acts`,
`.bs-sheet-note`). Reuse it. Do not introduce a modal system.

## 8.2 Fields and behaviour

employee · position · date · start · end · service · planned break · note.

* **Employee change → position**: keep the position if the new employee holds
  it, otherwise clear it and re-populate the list. (Not an audit question — the
  obvious answer.)
* **Start change → service**: re-suggest via `serviceFor()`, but **only if the
  manager has not overridden it**. Track "touched" in the form.
* **Cross-midnight**: end time earlier than start means next day. Show the
  computed span — *"Fri 6:00 PM → Sat 2:00 AM · 8h"* — rather than asking for
  an end *date*. The domain accepts any span up to 24h.
* **Position list**: only held positions, and **the server revalidates** —
  `validate()` already throws on a forged slug.

---

# 9. PLANNED BREAKS

Schema as built: `minutes` NOT NULL · `planned_start_at` nullable · `paid`
0/1 · `note`. `writeBreaks()` replaces the whole set on edit and silently drops
any entry with `minutes <= 0`.

**Phase 2 UX recommendation: one optional break, minutes only.**

* optional — no break is the common case
* a small minutes control (0 / 15 / 30 / 45 / 60)
* **no planned start in Phase 2** — the schema keeps the column for Phase 9's
  Day view; asking for a time nobody will keep is fake precision
* **no paid/unpaid toggle in Phase 2** — see decision Q3; it only matters once
  hours are computed
* card shows a small `·30m` marker

⚠️ **The domain does not validate a break against the shift interval.** A 90
minute break on a 60 minute shift is currently accepted. See §12.

---

# 10. STATUS, DELETE, DUPLICATE

## 10.1 Status in Phase 2

`create()` can only produce a draft, so **everything Phase 2 writes is a
draft**, automatically, with no UI decision. **No publish control ships in
Phase 2** — Phase 3 owns it. `changed_after_publish` cannot be set, because
nothing is published.

**Consequence worth stating: nothing a manager does in Phase 2 is visible to
any employee.** That is the correct and safe outcome — but the board should say
so, or a manager will assume their week went out. A single line — *"Nothing here
is visible to staff yet"* — prevents a real misunderstanding.

## 10.2 Delete vs cancel

The domain has only `cancel()`, which keeps the row.

**Phase 2 recommendation: one word, "Delete", for every state**, because in
Phase 2 every shift is an unpublished draft that nobody has seen. "Cancel" is
the right word only once employees have been told — which is Phase 3. Calling a
draft's removal a "cancellation" implies somebody is being cancelled *on*.

Behaviour is `cancel()` either way — the row is kept, and no punch, `work` row,
Service or Payroll record is touched (invariant 2).

## 10.3 Duplicate

**Recommendation: duplicate into the same cell, same employee, same day.** The
copy lands directly under the original, as a draft, and the drawer does *not*
open. One click, immediately visible, trivially undone by deleting it.

Rejected: duplicate-to-another-day (that is drag, Phase 11) and
duplicate-opens-drawer (that is just create-prefilled, which the empty cell
already does).

Needs a small `duplicate(id)` in the domain so the UI does not read-then-create.

---

# 11. COPY PREVIOUS WEEK

## 11.1 What it actually does today

Read from `copyWeek()` (line ~478) and its three tests.

| | Current behaviour |
|---|---|
| Source | `inRange(fromStart, +6)` — drafts **and** published, **excludes cancelled** |
| Target | new rows, always `status='draft'` |
| Inactive employees | **skipped**, reported in `skipped[]` with `why: 'inactive'` |
| Positions | copied as-is; **not** revalidated against current held positions |
| Service | **re-derived** under current settings, not the source stamp (line ~505) |
| Business date | recomputed from the shifted start |
| Breaks | copied, including `planned_start_at`, shifted by the same offset |
| Notes | copied |
| `changed_after_publish` | not copied — a copy is a fresh draft |
| Collision | skipped when `employee|starts_at|position` already exists in target |
| Second run | **idempotent** — makes 0, reports `why: 'already there'` |
| Same-week copy | refused (`offset === 0`) |

## 11.2 Product decisions this forces

**Partial target week: "copy only what is missing" is what is built**, and it is
the right default — it is non-destructive, and running it twice is safe. **No
silent replacement.** The UI must report both numbers: *"14 copied, 3 already
there, 1 skipped (Dana is no longer active)."* A silent count of 14 hides the
other four.

**Service re-derivation is a real consequence.** If the owner moves the dinner
boundary between weeks, a 3pm shift copied forward can land on a *different
service* from its source. This is deliberate — a copy is a new plan under
current rules — but it must be said, because tips and Payroll key on daypart.

⚠️ **Positions are not revalidated on copy.** If somebody's `barista` role was
removed since last week, `copyWeek` still creates a barista shift for them,
bypassing the check `create()` enforces. **This is a real gap** — see decision
Q5.

## 11.3 Date arithmetic

`shiftUtcByDays()` adds whole days to the UTC instant. Month and year
boundaries are handled by `Date` correctly. **DST is the exception**: adding 7×24
hours across a US DST change shifts the *local* clock time by an hour, so a
4:00 PM shift copied across the November transition becomes 3:00 PM. Two
transitions a year, and the board would show it — but it should be tested and
decided, not discovered.

---

# 12. WRITE VALIDATION (PHASE 2) VS ISSUES (PHASE 4)

**Hard, at the write, now** — already in `validate()`: employee exists · active
· holds the position · end after start · ≤ 24h · position required. Plus, to be
added: **break minutes must fit inside the shift** (§9 gap).

**Advisory, Phase 4**: overlapping shifts · excessive weekly hours ·
availability · time off.

**The one to decide now: overlap.** `overlapsFor()` exists but nothing calls it.
Double-booking somebody is a manager mistake, not a data-integrity violation,
and Phase 4 owns warnings — but the board will make it easy to do accidentally.
See decision Q2.

---

# 13. WEEK TOTALS

Nothing in the domain computes hours (D4). Safe to add, no Payroll contact:

* **employee week hours** — Σ (ends_at − starts_at)
* **day hours** — same, per column
* **shift count** and **people scheduled** per day

**Not now:** projected OT, planned labour dollars, staffing targets.

⚠️ **Unpaid breaks are an open decision (Q3).** `paid` exists on
`scheduled_breaks` and nothing reads it. Deducting unpaid break minutes is more
truthful, but it makes the board's hours a *different number* from the naive
span — and Phase 10 will have to match whatever is chosen here.

---

# 14. CONCURRENCY AND STALE EDITS

**Current risk: last write wins, silently, with no detection.** `edit()` reads
the row, validates, and overwrites. Manager A opening a shift, B changing it,
then A saving, discards B's change with no signal.

Documented as a known limitation for the *published* schedule in Phase 0. For
the *board* it is new, because Phase 2 is the first time two people edit the
same record through a UI.

**Recommendation: the smallest thing that detects it.** `updated_at` already
exists on `scheduled_shifts`. Put it in the drawer as a hidden field; on submit,
refuse if it no longer matches, with *"Somebody else changed this shift. Reopen
it to see the current version."*

One column already present, one comparison, one message. No locking, no
versioning table. Cheaper than the bug it prevents.

---

# 15. SECURITY AND FORGED REQUESTS

## 15.1 Conventions to follow

* **CSRF exists**: `_csrf` body field or `x-csrf-token` header, `csrfFor(req)` /
  `csrfDerive(req)` (server.js:100–110), auto-attached to `fetch` by an inline
  script (server.js:367). Every Phase 2 POST must carry it.
* **Auth**: global gate; `viewer` blocked on all non-GET at server.js:572.
* **Pattern**: POST → redirect with `?msg=` / `?err=1`, rendered by `flash(req)`.

## 15.2 Forged input — what the domain already does

| Forged | Result |
|---|---|
| employee id (nonexistent) | `ScheduleError` *"That employee no longer exists"* |
| employee id (inactive) | `ScheduleError` *"not active"* |
| position not held | `ScheduleError` *"not assigned to that position"* |
| end before start | `ScheduleError` *"end after it starts"* |
| shift id (missing/other) | `edit`/`cancel` throw *"no longer there"* |
| service | ⚠️ **silently falls back** to `serviceFor()` — `DAYPARTS.includes()` fails and derives instead of refusing |

The service fallback is defensible (it cannot produce an invalid value) but it
means a forged daypart is ignored rather than reported. Acceptable; worth
knowing.

**No route may rely on picker filtering.** The domain already re-checks
everything the picker filters — that is why `validate()` runs inside `create`
and `edit` rather than in the route.

---

# 16. ACCESSIBILITY

Drag/drop is deferred, which makes keyboard access the *primary* interaction,
not a fallback.

* Every cell is a **`<button>`**, not a div with a click handler — empty cells
  included, since that is the create affordance
* Each shift card is its own button, labelled *"Edit Dana Wu, Server, Friday
  4:00 PM to 10:00 PM"* — not *"Edit"*
* Drawer: focus moves in on open, returns to the invoking button on close, Esc
  closes, focus is trapped while open (`.bs-sheet` conventions)
* Time inputs get visible `<label>`s
* **Service and status never by colour alone** — a word, as with `86'D`
* Grid semantics: `role="grid"` with `rowheader` on the employee column, or a
  plain list per cell. **Decide during design**, but the frozen column must be
  a `rowheader` either way
* 44px minimum targets; **no hover-only actions** — duplicate and delete must be
  reachable by keyboard, which means inside the drawer or as real buttons

---

# 17. RESPONSIVE — THE PHASE 2 BAR, STATED

The brief asks for 320–430 verification while being desktop-first. Resolving
that explicitly:

| Width | Phase 2 requirement |
|---|---|
| 320 / 360 / 390 / 430 | **no horizontal page overflow**; the board scrolls inside its own container; the frozen employee column stays put; the shell stays navigable; nothing clipped. **Scheduling a full week here is not a Phase 2 goal.** |
| Tablet portrait (768) | usable — fewer visible columns, scroll for the rest |
| Tablet landscape (1024) | comfortable |
| Laptop (1280–1440) | the target: all seven days visible |
| Wide (1920) | no absurd stretch |

**Explicitly Phase 5, not Phase 2:** a phone-shaped manager surface for
handling a call-out. Phase 2's phone behaviour is *"legible and not broken"*,
not *"the way you schedule."*

---

# 18. IMPLEMENTATION TOUCH-MAP

| File | Change |
|---|---|
| `src/scheduler.js` | fix D1–D3; add `duplicate()`, week totals, batch `heldPositions`, break-fits validation |
| `src/server.js` | **first `require('./scheduler')`**; `/schedule` GET; POST create/edit/delete/duplicate/copy-week |
| `src/nav.js` | `AREAS` + `SECTIONS` entry, key `schedule` |
| `public/broadsheet.css` | `.swb-*` board, modelled on `.tsg-*` |
| `test/scheduler.test.js` | domain additions |
| `test/schedule-board.test.js` | **new** — routes, auth, board, drawer, copy |
| `docs/ZWIN-SCHEDULER-ROADMAP.md` | record the Phase 2 decisions |

**Not touched:** `engine.js` · `reports.js` · `policy.js` · `overtime.js` ·
`money.js` · `db.js` · `portal.js` · `timeclock.js`.

---

# 19. TEST PLAN

**Auth/route** — anonymous 302 · viewer GET 200 · viewer POST 403 · owner full ·
account with a feature list lacking `schedule` gets 403 · CSRF absent → refused.

**Init** — first require creates exactly 3 tables + 5 indexes · idempotent ·
no rows · existing tables unchanged.

**Board** — empty week · populated · multiple shifts per day ordered by start ·
overnight in its start column · active-with-no-shifts row present ·
active-with-no-positions row present · inactive absent · cancelled absent ·
**no N+1** (query count bounded).

**Drawer** — create from empty cell prefilled · edit existing · invalid employee ·
inactive employee · forged position · forged shift id · service default ·
service override survives an end-time change · break minutes must fit ·
note escaped · cross-midnight.

**Copy week** — drafts only · partial target copies only missing · reports
skipped counts · inactive skipped · idempotent · month boundary · year boundary ·
**DST transition** · service re-derivation when the boundary moved.

**Concurrency** — stale `updated_at` refused with a readable message.

**Permanent invariants** — all eight from Phase 1 stay green, especially
INV8 (`aggregatePayroll` byte-identical) and INV2 (no punch/`work`/Service
mutation). Plus: **no employee notification is created** and **the Schedule tab
stays locked**.

**Responsive** — at 320/390/1280: no page overflow, board scrolls internally,
frozen column intact, no target under 44px.

---

# 20. FIRST-SCHEMA DEPLOYMENT RISK

**Risk: low. Not zero.**

* Additive only: 3 tables, 5 indexes, no `ALTER`, no data
* `db.exec` is atomic per statement; SQLite DDL is transactional, so partial
  creation of a single table cannot occur. A failure *between* statements could
  leave some tables created — harmless, since every statement is
  `IF NOT EXISTS` and a retry completes it
* **Failure mode is boot failure, not corruption** (§2.3)
* **Rolling back the app while leaving empty tables is safe.** Three unused
  tables sit inert; the previous build does not know they exist

**Recommendation:** take a production database snapshot before this deploy —
not because the change is risky, but because it is the **first schema change to
production in this project's scheduler work**, and the cost of a snapshot is
minutes. Verify after boot with row counts of exactly 0 on all three.

---

# 21. DECISIONS NEEDED BEFORE IMPLEMENTATION

## Q1 — Week start day

* **A. Monday** (already coded). Standard for rostering; the week reads Mon→Sun.
* **B. Sunday.** Common in US restaurants; matches many payroll weeks.
* **C. Settings-driven.**

### Evidence — I checked the OT week, and it is not a weekday at all

```js
// reports.js:120-123
// Split the period into week 1 / week 2 (Gusto runs a two-week cycle). These
// two halves are the workweeks overtime is measured against.
const midDate = shiftDate(from, 7);
const weekKey = (date) => (date < midDate ? 'wk1' : 'wk2');
```

The overtime workweek is **the pay period start and start + 7** — whatever
weekday that lands on. Measured against live data:

```
current pay period : 2026-08-01 → 2026-08-14
period starts on a : SATURDAY
OT week 2 begins   : 2026-08-08  (also a Saturday)
```

So overtime today is measured **Saturday → Friday**, and the board as coded
would show **Monday → Sunday**. A manager reading "38 hours this week" on the
board would be reading a different seven days from the one that decides whether
hour 41 is paid at 1.5×.

**Revised recommendation: D — anchor the board's week to the pay period,
Saturday-based today, derived from `periods.periodFor()` rather than hard-coded.**

That makes the board's week the same seven days as the OT week, for free, and it
follows the anchor if the owner ever changes it. `periods.js:8` already warns
about exactly this class of error: *"a start date that's off by one silently
moves hours into the wrong week."*

**Consequence of keeping Monday (A):** the board's weekly hours and Payroll's OT
week describe different periods, and nobody notices until somebody is paid
overtime they were not expecting — or is not paid overtime they earned. This is
the single most expensive decision in Phase 2.

## Q2 — Overlap: warn, block, or silent in Phase 2?

* **A. Silent** — Phase 4 owns warnings. Board makes double-booking easy.
* **B. Warn on save**, non-blocking, one line in the drawer.
* **C. Block.** Wrong — a split shift with a gap is legitimate, and managers
  sometimes genuinely double-book while rearranging.

**Recommendation: B.** `overlapsFor()` already exists and is tested; surfacing
it is a few lines and prevents the most common scheduling mistake from shipping
unnoticed for two phases. It is not the Issues engine — one check, one message.

## Q3 — Do unpaid planned breaks reduce scheduled hours?

* **A. No** — hours are the span. Simple, and the card's times add up.
* **B. Yes** — deduct unpaid minutes. More truthful about labour.

Evidence: `scheduled_breaks.paid` exists and **nothing reads it**; no hours
arithmetic exists anywhere yet (D4); Phase 10 will have to match this choice.

**Recommendation: A for Phase 2, with the break shown separately on the card.**
Deducting invites comparison with Payroll, which computes payable minutes from
*actual* punches with its own paid/unpaid rules — and a planned number that
looks like a payroll number is the failure mode this project keeps avoiding.
**Consequence of B:** the board's hours and the times on the cards stop
agreeing, and somebody will report it as a bug.

## Q4 — Open/unassigned shifts on the board

The domain allows `employee_id = null`. Phase 8 owns claims. But a null-employee
shift **has no row to render in**.

* **A. Do not create them in Phase 2.** The drawer always requires an employee.
* **B. Add an "Unassigned" row** at the top of the board now.

**Recommendation: A.** The roadmap explicitly warns against exposing unfinished
open-shift concepts just because the column is nullable. The capability stays in
the domain, unreachable from the UI, until Phase 8 gives it a claim surface.

## Q5 — `copyWeek` does not revalidate positions

If somebody's position was removed since the source week, the copy creates a
shift they are no longer qualified for — bypassing the check `create()`
enforces.

* **A. Leave it.** Phase 4's issue engine will flag it later.
* **B. Skip and report**, like inactive employees: *"1 skipped — Dana no longer
  works Barista."*
* **C. Copy but mark.**

**Recommendation: B.** It matches the inactive-employee handling already there,
it is a few lines, and it closes a hole where the copy path is weaker than the
create path — which is exactly the kind of asymmetry that turns into a bug
report about a schedule nobody can explain.

## Q6 — Should the board warn that nothing is visible to staff?

In Phase 2 everything is a draft and no employee can see any of it.

**Recommendation: yes, one line.** Without it a manager builds a week, leaves,
and assumes it went out. Cheap insurance against a real operational
misunderstanding.

---

# APPENDIX — DEFECTS TO FIX BEFORE THE BOARD SHIPS

| | | Where |
|---|---|---|
| D1 | `inRange()` N+1 on breaks | `scheduler.js:435` |
| D2 | Monday hard-coded, no setting | `scheduler.js:441` |
| D3 | `weekFor()` parses server-local | `scheduler.js:440` |
| D4 | no hours arithmetic exists | — |
| D5 | break not validated against shift span | `writeBreaks()` |
| D6 | `copyWeek` skips the position check | `copyWeek()` |

D1 and D3 are correctness. D2 and D4 are decisions. D5 and D6 are gaps where a
path is weaker than the equivalent one beside it.
