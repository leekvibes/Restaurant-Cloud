# ZWIN Scheduler — Phase 5 Targeted Audit

**Fast Manager Mobile Controls**

Audited at `e951f3f`, 2026-08-13. Phases 0–4 complete.
**Nothing implemented. No production file changed by this audit.**

---

## 0. The headline, measured

The Week Board on a phone is not "awkward". **It is unusable, and it lies.**

At 390×844, with four shifts on the board:

| Measured | Value |
|---|---|
| Grid natural width | **960px** |
| Window available to it | **360px** |
| Grid scrollable? | **No** |
| Any scrollable ancestor? | **No** — `.sb-frame` is `overflow-x: hidden`, `.sb-grid` is `visible` |
| Shift cards reachable | **0 of 4** |
| Days reachable | **2 of 7** (Sat, Sun) |
| Toolbar height | **231px** — 27% of the screen before any schedule |

Confirmed by screenshot, not only by measurement. The employee column reads
`Esther 6h · 1 shift`, `Kevin 7h · 1 shift` — so the page **tells** the manager
those shifts exist and gives no way to see or tap any of them. The two visible
days both say "0 people".

This reframes Phase 5. It is not a convenience layer over a working surface; the
manager currently has **no mobile access to the schedule at all**, and the page
does not admit it.

**Contained-scroll status:** the page itself does not scroll sideways
(`documentElement.scrollWidth === innerWidth`), so the earlier horizontal-scroll
work holds. The clipping is the cost of that containment — the overflow was hidden
rather than made pannable.

---

## 1–2. Reusable routes and domain APIs

Phase 5 needs **no new domain behaviour**. Everything exists:

| Need | Existing |
|---|---|
| Week read | `SCH.inRange(from,to)`, `q.inRangeAll` |
| Shift read | `SCH.byId(id)`, `q.pubById` |
| Create | `POST /schedule/shift` |
| Edit | `POST /schedule/shift/:id` |
| Cancel | `POST /schedule/shift/:id/delete` |
| Duplicate | `POST /schedule/shift/:id/duplicate` |
| Publish shift | `POST /schedule/shift/:id/publish` |
| Unpublish | `POST /schedule/shift/:id/unpublish` |
| Publish week | `POST /schedule/publish-week` |
| All four issue types | `SCH.issuesFor(anyDate)` |
| Hours/totals | `SCH.weekTotals(shifts)` |
| Held positions | `SCH.heldPositionsFor(ids)` |

Every write route already calls `sbGuard`. **Phase 5 is presentation and routing
only.** No mobile-specific business rule is required, and none should be added.

One gap: `issuesFor` takes a *week*. A day-scoped view either filters that
result in memory (cheap — see §23) or gains a thin wrapper. Filtering is
preferred: one code path, one definition of an issue.

---

## 3. "Today" — already settled, do not re-decide

`TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour)`, cutoff 4. This is
the app's one authority and five pages were just corrected to use it (`265bd3e`).

Behaviour that follows for free, because `business_date` is stamped at creation
from the shift's start:

| Case | Result |
|---|---|
| Starts 8pm, ends 2am | Belongs to the **start** day. Appears once, on that day |
| Now is 1am, before cutoff | Today is still **yesterday's** date — last night's shifts are still "today" |
| Starts 2am (after midnight, before cutoff) | Business date is the **previous** day |
| Cancelled | `inRange` hides it; `inRangeAll` sees it. Mobile should use `inRange` |
| Draft vs published | `pubOf(s)` already derives `draft / changed / published` |
| Unpublished changes | `changed_after_publish` |

**No decision needed here.** Any calendar-date definition would be a regression.

---

## 4. "Upcoming" range — decision required (D3)

| Option | For | Against |
|---|---|---|
| Rest of today + next 7 days | Matches how a manager thinks; bounded | Crosses the week boundary, so it is not "the week" |
| Next 7 business dates | Simple, predictable | Same |
| Current week only | Reuses the exact week query and the totals already computed | Thursday shows only 2 days ahead — thins out exactly when you need it |
| Next N shifts | Always populated | Unbounded in time; a quiet week shows next month |

**Recommendation: rest of today + next 7 days.** It answers "what's coming" at
any point in the week. Cost: one extra `inRange` call spanning the boundary, or
one call over the 8-day span.

**Do not** load the −7/+90 employee window. That is the employee product.

---

## 5. Information hierarchy — decision required (D7, D8, D9)

**In the list** (what a manager scans):
time · duration · **who** · position (colour + text) · publication state · issue marker

**In the detail** (one tap):
planned break · service/daypart · note · the issue text itself · every action

**Hidden unless editing**: break note, created/updated metadata.

Rationale: the list answers *who is on and when*. Break and daypart are planning
detail; putting them on a card doubles its height and halves how many fit.

---

## 6. Grouping — decision required (D5, D6)

**Today: by time.** A manager at 4pm wants "who is on now and who comes next",
which is chronological. Grouping by employee scatters that. Grouping by daypart
is tempting but the board already stamps daypart at creation and a shift can
straddle the boundary — so it would need a second rule to place them.

**Upcoming: by date**, each day a section header. Grouping by employee across
days answers a different question ("what does Kevin's week look like"), which is
a filter, not the default.

---

## 7–8. Navigation — decision required (D1, D2, D19)

| Option | Verdict |
|---|---|
| Auto-render mobile at `/schedule` | No shareable URL for either view; hard to test; a tablet at 800px is ambiguous |
| **Segmented Today / Week inside `/schedule`** | One URL, one permission, both views testable via a query param; Week stays reachable at any width |
| `/schedule/today` | Clean URL, but a second route to guard, and it collides conceptually with Phase 9 Day View |
| `/schedule/mobile` | Viewport in a URL — wrong axis; a desktop user cannot use it deliberately |

**Recommendation: a `Today / Week` segmented control inside `/schedule`**,
defaulting to **Today below ~760px** and **Week above**, with the choice carried
in the querystring (`?v=today`) so it is linkable, back-button-correct, testable,
and overridable in both directions.

This also protects Phase 9: `/schedule/day` stays free for the Day View Gantt,
and Phase 5 never claims that name.

**Week Board stays reachable on a phone** via the segmented control. It will
still be clipped — §0 — which is a separate defect worth fixing on its own
(make the grid pannable), independent of Phase 5.

---

## 9–11. Actions — decisions required (D10, D11, D12, D14)

**Primary, on the shift detail:** Edit times · Reassign · Publish (or Publish
changes) · Cancel.
**Secondary:** Unpublish · Duplicate · View issue.
**Full form only:** planned break, service, note.

**Reassignment (D11).** Today: open drawer → change Who → the position list
re-filters to that person's held positions → Save. That is already 3 taps and
correct. A dedicated "Reassign" adds a fourth surface for the same two fields.
**Recommendation: no separate action** — but the employee select must be the
first field in the mobile detail so it is reachable without scrolling.

**Cancel (D12).** Desktop cancel posts its own form with no confirmation. On a
phone, Cancel would sit inches from Publish, and cancelling a *published* shift
is visible to the employee immediately as an Issue. **Recommendation: confirm on
mobile**, once, naming the person and time. This is new UX, not new semantics.

**Publish week (D13).** It acts on a week. On a Today list it would be a
week-wide action fired from a day-shaped screen. **Recommendation: Week mode
only.**

---

## 12–13. Issues on mobile — decision required (D15, D18)

Phase 4 put issues in a right-side drawer 430px wide. On a 390px phone that is
full-screen already, so the pattern survives — but the app's phone-native
pattern is the portal's bottom sheet (`.pes`), and the manager shell has
`.drawer`.

**Recommendation: reuse the Phase 4 drawer** (it is already full-width under
720px and already keyboard-dismissible) rather than introduce a third overlay
pattern. Count in the Today header; per-card outline exactly as on the board.

---

## 14. Colour

Unchanged. Position colour stays the dominant fill; publication state stays the
`<s>` marker; issues stay the amber outline. **No new palette.** Mobile cards
are wider than board cards, so the same fill reads better, not worse.

---

## 15–16. "Working now" — a product risk to name

The schedule can say a shift is *scheduled* to be in progress. It cannot say
anybody is *there*. `time_entries` knows that, and it is deliberately a
different system.

**Recommendation: no "Now" or "In progress" badge in Phase 5.** A manager
glancing at "Kevin — Now" will read it as attendance, and the one time it is
wrong is the one time it matters (a no-show). If a temporal cue is wanted, the
honest wording is *"scheduled 4p–10p"* with the list ordered by time, which
conveys the same thing without the claim.

Clocked-in / late / no-show data **is** available and must stay out. Preserve:
schedule = plan, Time Clock = actual.

---

## 17. Today header — decision required (D18)

Smallest useful: **people · shifts · planned hours**, plus the issue count and
unpublished-changes count only when non-zero. All four already computed
(`weekTotals`, `issuesFor`, `stateCounts`).

Excluded, per roadmap: labor cost, projected OT, staffing targets, attendance.

---

## 18. Empty states

| State | Wording |
|---|---|
| No shifts today | "Nothing scheduled today." + Add shift |
| No upcoming | "Nothing scheduled in the next 7 days." + Add shift |
| No issues | Nothing at all — absence is the message (as the Phase 4 chip already does) |
| Nothing published | "None of this is on the employee schedule yet." + Publish week |
| All cancelled | "Everything today was cancelled." — do **not** render as empty |

No invented suggestions.

---

## 19–20. Create and date navigation — decisions required (D4, D16)

**Add shift.** The board's model is "tap the empty cell for that person and
day", which does not exist in a list. Mobile needs an explicit Add that opens
the same drawer pre-filled with the day in view. **Recommendation: one Add in
the Today header** (not a floating button — no FAB precedent in this app).

**Date navigation.** The employee portal already ships a 7-day strip
(`.ps-strip`) that is tested, accessible and understood. **Recommendation: reuse
that pattern** for the manager's Today, plus a "Today" reset. Not a date picker
— too many taps for the one case that matters.

---

## 21. Shell constraints Phase 5 must respect

- Masthead is hidden on mobile; the bottom tab bar is fixed at **60px + safe-area**
- Any fixed footer must sit above it: `bottom: calc(60px + env(safe-area-inset-bottom))` — the `.ps-tabs` precedent
- `.bs *` forbids `border-radius` and `box-shadow` inside the shell; use `outline` (learned in Phase 4)
- The page must not scroll sideways — the constraint that produced §0
- Keyboard overlap: the drawer's time inputs must stay reachable; the portal edit sheet already solves this

---

## 22. Accessibility

- Touch targets ≥44px. Board cards currently measure **50px** — fine; day-strip chips are 44px in the portal
- Never swipe-only. Every action needs a visible control
- Position colour is never the only identifier — position text always present (already true)
- Focus must return to the triggering control when a drawer closes (the Phase 4 drawer does not yet do this — worth fixing)
- Screen-reader order: day → time → who → position → state

---

## 23. Performance

A day is a subset of a week, and a week derives in **0.25 ms** (measured in the
Phase 4 audit; 4ms for a pathological 600-shift week). Today and Upcoming can
both be filtered in memory from one `inRange` + one `issuesFor` call.

**No N+1.** Do not call `issuesFor` per shift.

---

## 24. Permissions and security

Same `/schedule` path, same `navAllowed('/schedule')`, same `sbGuard` on every
write. A query-param view switch inherits all of it — which is a further
argument for it over a new route. Forged employee/position ids are already
refused by `validate()` (`e9e95ec` closed the last hole).

Employees reach none of this: the portal reads `published_schedule` only.

---

## 25–26. Phase boundaries

**Phase 6 (Availability) extension point:** issues arrive as a list from one
function. An availability conflict becomes one more entry with one more
severity. Nothing in Phase 5 should assume the current four kinds are all there
will be — render from the array, never from a hardcoded switch.

**Phase 9 (Day View) boundary — the real risk.** Phase 5 is an **operational
list**: what is on, in time order, tap to act. Phase 9 is a **spatial Gantt**:
overlapping bars on a time axis, coverage gaps visible by shape.

Deliberately deferred to Phase 9: any time-axis rendering, any visual
representation of concurrency, any coverage-gap display, any drag-to-move. If
Phase 5 starts drawing a timeline, it is building a disposable Day View.

---

## 27. Scenario matrix A–P

| | Scenario | Possible now on mobile? | Awkward/broken? | Needs Phase 5 UI? | New domain? | Pattern |
|---|---|---|---|---|---|---|
| A | Who is scheduled today | **No — clipped** | broken | Yes | No | Today list |
| B | Tomorrow's shifts | **No** | broken | Yes | No | Upcoming |
| C | Open one shift | **No** — cards unreachable | broken | Yes | No | Tap row → detail |
| D | Change its time | No | broken | Yes | No | Detail → Edit |
| E | Change position | No | broken | Yes | No | Detail, held-filtered |
| F | Reassign | No | broken | Yes | No | Detail, employee first field |
| G | Publish changed shift | No | broken | Yes | No | Primary action |
| H | Unpublish | No | broken | Yes | No | Secondary |
| I | Cancel published shift | No | broken | Yes | No | Secondary + confirm (D12) |
| J | Cancelled-but-published issue | No | broken | Yes | No | Issue row → shift |
| K | Overlap issue | No | broken | Yes | No | Same |
| L | Add shift today | No | broken | Yes | No | Header Add |
| M | Add later this week | No | broken | Yes | No | Add, date prefilled |
| N | Zero shifts today | n/a | — | Yes | No | Empty state |
| O | Overnight across cutoff | Data correct already | — | Display only | **No** | Shows on start day |
| P | Full Week Board from phone | **No — clipped** | broken | Yes | No | Segmented Week + make grid pannable |

Fifteen of sixteen are broken on a phone today, all for the same reason.

---

## 28. Decisions requiring approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | Mobile default | **Today** below ~760px |
| D2 | Route model | Segmented control in `/schedule`, `?v=today` |
| D3 | Upcoming range | Rest of today + next 7 days |
| D4 | Date navigation | 7-day strip (portal pattern) + Today reset |
| D5 | Today grouping | By time |
| D6 | Upcoming grouping | By date |
| D7 | Card hierarchy | time · duration · who · position · state · issue |
| D8 | Breaks in list? | **Detail only** |
| D9 | Daypart in list? | **Detail only** |
| D10 | Duplicate in quick actions? | Secondary, not primary |
| D11 | Dedicated Reassign? | **No** — employee first field instead |
| D12 | Cancel confirmation | **Yes on mobile** |
| D13 | Publish week location | **Week mode only** |
| D14 | Individual publish/unpublish | Publish primary, Unpublish secondary |
| D15 | Issues surface | Reuse the Phase 4 drawer (full-width under 720px) |
| D16 | Add shift location | Today header |
| D17 | Empty days in Upcoming? | **Hide** — consistent with the employee schedule |
| D18 | Counts in Today header | people · shifts · hours; issues/unpublished only when non-zero |
| D19 | Week access | Segmented control, both directions, any width |
| D20 | Deferred to Phase 9 | Time axis, concurrency, coverage gaps, drag |

---

## 29. Smallest useful Phase 5

1. Today list — by time, with the day strip and a header summary
2. Shift detail sheet — the fields, and Edit / Reassign / Publish / Cancel
3. Upcoming — same card, grouped by date
4. Segmented Today / Week, defaulting by viewport, carried in the URL
5. Add shift from the Today header
6. Issue count + per-card outline, reusing Phase 4

Everything else waits.

---

## 30. Sequence, files, risks

**Sequence:** view resolver + `?v=` → Today list read-only → detail sheet →
actions wired to existing routes → Upcoming → Add → Issues → empty states →
a11y pass.

**Files:** `src/server.js` (`/schedule` render + view switch),
`public/broadsheet.css` (`.sbm-*`), `test/schedule-mobile.test.js` (new),
`test/schedule-board.test.js` (the desktop path must be proven unchanged).

**Risks**

*High* — regressing the desktop board while adding a second view from the same
route. Mitigation: the view switch must be the only branch, and every existing
board test must pass untouched.

*High* — implying attendance. See §15.

*Medium* — building a miniature Day View (§26).

*Medium* — the clipped grid (§0) is a real defect that Phase 5's Today view will
*hide* rather than fix. If a manager switches to Week on a phone, it is still
broken. Fix it separately.

*Low* — performance; permissions.

---

## 31. Roadmap corrections

1. **Phase 5's premise is understated.** The roadmap says "do not squeeze a
   seven-column grid onto a phone", implying the grid currently works badly on a
   phone. It does not work at all — it is clipped, and 0 of 4 shifts were
   reachable at 390px.

2. **Phase 2's "contained horizontal scrolling"** is recorded as delivered. The
   containment is real; the *scrolling* is not — nothing pans, so the content is
   simply cut off.
