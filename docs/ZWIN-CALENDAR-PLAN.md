# ZWIN Calendar — architecture and build plan

Turning `/c/recurring` into ZWIN's calendar. Written against the code at
`0b87aec`, after the Recurring Tasks audit.

**Nothing here is implemented yet.** This is the design the build follows.

---

## 1. The one decision everything else follows from

**Occurrences are derived, never stored.**

A series holds a *rule*. The calendar expands that rule across the visible
range on every render. No table of generated occurrences, ever.

This is not a new idea here — it is exactly how Phase 4 Scheduler Issues works,
and that decision has held up: a week of issues derives in 0.25ms, there is no
invalidation matrix, and nothing can go stale. The same argument applies with
more force to a calendar, because the alternative is generating years of rows
for a rule the user may edit tomorrow.

It also answers the density requirement directly. Expansion cost is bounded by
*what is on screen*, not by how much history exists. A month view expands one
month regardless of whether the restaurant has 7 obligations or 7,000.

**The corollary, and the fix for cadence drift:** if occurrences come from the
rule, completing one cannot move the next. Schedule and completion stop being
the same field. That is the architectural change the whole redesign rests on.

---

## 2. Route and identity

| | |
|---|---|
| Canonical | `/calendar` |
| Default view | Month |
| Old route | `/c/recurring` → **302 to `/calendar`**, kept indefinitely. Bookmarks, the audit doc, and anything else pointing there keep working |
| Nav label | **Calendar** |
| Nav position | Stays under **Tasks & logs** for now |

**On nav position:** promoting Calendar to its own group is a global sidebar
change, and the brief says not to redesign the sidebar. Under Tasks & logs it
sits beside Incident log and Decisions log, which is honest company — they are
all "things the business must record". Revisit once it has earned it.

**Decoupling from the generic tracker.** `/c/:slug/*` CRUD in `modules.js` is
shared by ten other trackers and must not change. Calendar gets its own detail,
create, edit and delete. The `MODULES` entry for `recurring` is **removed** so
the generic routes stop answering for it — that is the "one source of truth"
requirement. The other ten modules are untouched.

---

## 3. Data model

Four tables. Names chosen to sit beside the existing `m_*` trackers without
pretending to be one.

### `cal_items` — a series, or a one-time item

```
id
kind              'event' | 'task'
title
category          Cleaning | Maintenance | Safety | Pest Control | Compliance | Other
notes
responsible       free text, preserved
responsible_kind  NULL | 'employee' | 'vendor'   -- set when it resolved to one
responsible_id    NULL | the id it resolved to   -- display still uses the text
starts_on         'YYYY-MM-DD'   the first (or only) occurrence
ends_on           'YYYY-MM-DD'   NULL unless multi-day
all_day           0 | 1
start_min         minutes past midnight, NULL when all_day
end_min           minutes past midnight, NULL when all_day
rrule_freq        NULL | 'daily' | 'weekly' | 'monthly' | 'yearly'
rrule_interval    1, 2, 3 …
rrule_byday       'MO,TH'  weekly, and "first Monday" monthly
rrule_bymonthday  1..31, or -1 for last day
rrule_bysetpos    1..4, -1   "first"/"last" <weekday> of the month
rrule_until       'YYYY-MM-DD' | NULL
rrule_count       n | NULL
archived_at
created_at  updated_at
```

`rrule_freq IS NULL` **is** "does not repeat". One column answers the question
the UI asks first, and a one-time item costs no extra table.

### `cal_exceptions` — one occurrence that differs

```
id  item_id
occurs_on          the occurrence being modified, by its ORIGINAL date
status             'skipped' | 'moved'
moved_to_date  moved_start_min  moved_end_min
title_override  notes_override
```

"This and following" is **not** an exception — it is a **split**: close the old
series with `rrule_until = the day before`, create a new series from that date.
That keeps history literally correct rather than reinterpreting it, which is the
requirement.

### `cal_completions` — the history that does not exist today

```
id  item_id
occurs_on          which occurrence was completed
completed_at       timestamp
completed_by       actor name
notes
```

One row per completion. *"When were the last four hood cleanings"* becomes a
query. Undo deletes a known row by id — no dates in a querystring.

### `cal_reminders`

```
id  item_id
offset_min         minutes BEFORE the occurrence. 0 = at the time
channel            'inapp'   (only honest value today — see §7)
```

Multiple rows per item, so "1 day before" and "15 minutes before" coexist.

**Indexes:** `cal_items(starts_on)`, `cal_items(rrule_freq)` (recurring vs
one-time is the hot split), `cal_exceptions(item_id, occurs_on)`,
`cal_completions(item_id, occurs_on)`, `cal_reminders(item_id)`.

---

## 4. Recurrence: structured columns, no library

**Not** an RRULE string, **not** a dependency.

- A string has to be parsed on every read and cannot be indexed or grepped.
  This codebase's habit is columns you can see in `sqlite3` — `scheduled_shifts`
  and `time_entries` both work that way.
- `rrule.js` is ~40KB for a fraction we would use. The app currently has
  **seven** runtime dependencies. Adding one for this is not justified.
- The columns above are deliberately an **RRULE subset with RRULE's names**, so
  if a real library is ever needed the mapping is mechanical.

What it supports, which covers every example in the brief:

| Wanted | Stored as |
|---|---|
| Every 2 weeks | `weekly`, interval 2 |
| Every Monday | `weekly`, byday `MO` |
| Every Monday + Thursday | `weekly`, byday `MO,TH` |
| Every weekday | `weekly`, byday `MO,TU,WE,TH,FR` |
| Every 3 months | `monthly`, interval 3 |
| Monthly on the 1st | `monthly`, bymonthday 1 |
| Monthly on the last day | `monthly`, bymonthday -1 |
| First Monday monthly | `monthly`, byday `MO`, bysetpos 1 |
| Every year | `yearly` |
| Ends after 10 | `rrule_count = 10` |
| Ends on a date | `rrule_until` |

**The expander** — one function, the calendar's equivalent of `issuesFor()`:

```
expand(item, from, to) -> [{ date, startMin, endMin, exception, completion }]
```

Rules: never generate outside `[from, to]`; hard cap per item per call (say 400)
so a malformed rule cannot hang a render — the existing calendar view already
uses `guard++ < 500` for the same reason; apply exceptions and completions
during expansion so callers get one resolved list.

Month boundaries are where calendars break. "Monthly on the 31st" in February
**skips** rather than clamping to the 28th — clamping silently invents a date
the user did not ask for. Leap day yearly behaves the same way. Both get tests.

---

## 5. Kind decides behaviour

| | `event` | `task` |
|---|---|---|
| Can be completed | no | yes |
| Can be overdue | **no** | yes |
| Status shown | none | overdue / due soon / complete / scheduled |

This is the fix for the brief's own example: a vendor meeting that happened
yesterday is not overdue, it simply happened. The existing four-status logic
survives, scoped to `kind = 'task'`.

Migrated recurring tasks are all `kind = 'task'`. Anything created through
"+ New" defaults to `event` unless a category or an explicit toggle says task —
final call in §11.

---

## 6. Migration

Additive, reversible, and it keeps the old table.

1. Create the four tables.
2. For each `m_recurring` row → one `cal_items`:
   - `kind = 'task'`, `all_day = 1`, title/category/notes/responsible carried
   - `category` NULL → `'Other'`, matching today's read-time fallback
   - `starts_on = next_due`, or `created_at`'s date when `next_due` is NULL
   - Weekly → `weekly`/1 · Monthly → `monthly`/1 · **Quarterly → `monthly`/3** ·
     Annual → `yearly`/1. Nothing else is inferred
3. `last_done` (when set) → one `cal_completions` row, `occurs_on = last_done`,
   `completed_at = last_done`, `completed_by = NULL`. **No earlier completions
   are invented** — one real record is the truth we have.
4. `m_recurring` is **left in place, unread**. If the migration is wrong we can
   see the original. Dropped a release later, deliberately.

**Verification the migration must satisfy:** seven rows in, seven series out;
every name, category, responsible and note identical; every non-null `last_done`
present as exactly one completion; and each series' next occurrence on or after
today equals what `/c/recurring` shows today. That last one is the real test —
it says the calendar agrees with the page it replaces.

---

## 7. Reminders — what is honest today

ZWIN already has real notification infrastructure, and it is worth being precise
about what it can and cannot do, because the brief rightly forbids fake UI.

**Exists and works:** `PORTAL.adminNotify()` writes `admin_events`, which drives
the masthead bell; `adminNotifyOnce(key, …)` gives idempotency through
`admin_notified`; web push reaches subscribed devices **when `VAPID_PRIVATE_KEY`
is set** (it now is); a daily sweep already raises operational alerts through
exactly this path.

**The boundary:** the sweep is **daily**. So

- "1 day before", "1 week before", "on the day" — **deliverable now**, real
- "15 minutes before", "1 hour before" — **need a finer tick than exists**

**Therefore:** store every offset the user picks (the data layer is complete
either way), and in the first release **only offer day-granularity options**.
Sub-day offsets ship when a minute-level tick exists. No control appears that
does not do something.

Reminder firing is `adminNotifyOnce` with key `cal:<item>:<date>:<offset>` —
deterministic, so a re-run cannot double-notify. Same pattern as the scheduler's
publish notifications.

---

## 8. Views

**Month (default).** Seven columns, leading/trailing days de-emphasised, today
marked with a filled date circle rather than a tinted cell. Items as compact
rows with a category-colour accent — a 3px left rule, not a filled block, so a
busy month does not become a rainbow. `+N more` opens the day. Clicking
whitespace starts a quick create on that date.

**Week.** A real time grid: an all-day strip above, hour rows below, timed items
positioned by their range, current-time indicator on the current week. Built so
drag-to-create can be added later — the grid maps pixels to minutes from the
start, even though the first release only handles clicks. Not hacked in after.

**Day.** The same grid, one column, more room for metadata.

**Agenda.** Chronological, grouped by date, "Today"/"Tomorrow"/weekday headings.
This is where the existing task-card work is reused, and it is the primary
mobile view.

**Mobile.** Month stays available and compact; tapping a day reveals that day's
items beneath the grid. Week is *not* seven columns on a phone — mobile gets
Month and Agenda, with Day reachable. Creation is a bottom sheet, not a
shrunken popover, with the Save action clear of the keyboard.

---

## 9. Creating and editing

**Quick create** — popover on desktop, bottom sheet on mobile. Title, date,
all-day, Repeat (defaulting to "Does not repeat"), Reminder, Category, and a
**More options** link. One field is enough to save.

**Full editor** — a right-side sheet, matching the drawer pattern the Scheduler
and every `/c` module already use. Progressive: times, end date, responsible,
location, notes, completion behaviour.

**Detail first, never straight to a form.** Clicking an item shows a popover:
title, category, recurrence in words, when, responsible, reminders, notes, then
**Mark complete**, **Edit**, and an overflow with Duplicate / Skip this
occurrence / Delete.

**Series semantics.** Editing or deleting an occurrence of a series asks:
*This occurrence · This and following · All occurrences*. Implemented as §3
describes — exception row, series split, or item update. Never client-side
hiding.

---

## 10. Integration

**Dashboard.** The overdue alert repoints at the new domain: count `task` items
whose next occurrence is past with no completion. Wording stays in the existing
alert table. `m_recurring` stops being read the moment the migration lands.

**Global search.** `src/search.js:91` currently selects from `m_recurring` and
links to `/c/recurring`. It becomes a `cal_items` query linking to
`/calendar?item=<id>`, which opens the calendar with that item's detail showing.
Title, responsible, category and notes all become searchable — more than today.

**Permissions.** Unchanged. Owner/manager only, same feature gate. Employees do
not see Calendar, and nothing in this build changes that.

**Business date.** Calendar dates are **calendar dates**. A September 1
inspection does not roll at the 4am cutoff. This is deliberate and matches the
rule already written in `CLAUDE.md`: services use the business date, paperwork
uses the calendar date. Timed items store minutes-past-midnight in restaurant
local time, which sidesteps `new Date('YYYY-MM-DD')` parsing entirely.

---

## 11. Decisions needing your answer

1. **Does "+ New" default to Event or Task?** Event is the calendar convention;
   Task matches what this module has always been for. *Recommend: Event, with
   Task one click away — most new entries will be meetings and appointments.*
2. **Week start — Sunday or Monday?** *Recommend Sunday, US convention, and a
   setting later.*
3. **Sub-day reminders:** ship day-granularity only now (§7), or hold reminders
   entirely until a minute tick exists? *Recommend ship what works.*
4. **Left rail** (mini month, category filters): the ZWIN sidebar is already
   wide. *Recommend no rail in v1 — category filters go in a compact popover
   above the grid, and revisit once the month view is real on a laptop screen.*
5. **Attention row** (Overdue 3 · Due today 2 · This week 7): a single compact
   line above the grid, or nothing in v1? *Recommend the line — it is one row,
   and it preserves what the four KPI cards were genuinely useful for.*

---

## 12. Build order

Each stage ships green and is independently reviewable.

| Stage | What | Why this order |
|---|---|---|
| **A** | Four tables, the expander, the migration, completion + undo. **No UI.** Full domain tests | A wrong data model is cheap to change now and expensive after four views sit on it |
| **B** | `/calendar` route, Month view, Agenda, detail popover, quick create. `/c/recurring` redirect. Dashboard + search repointed | The product becomes real and usable. Recurring tasks stop having two homes |
| **C** | Week and Day time grids, series edit/delete semantics, `+N more`, click-to-create on a time slot | The heavier interaction work, on a proven domain |
| **D** | Reminders delivery on the existing sweep, mobile bottom sheets, keyboard shortcuts, accessibility pass | Polish and the parts that need the rest to exist first |

**Stage A is the one to do first and review before anything else.** Everything
above depends on the expander being right, and on the migration proving it
agrees with the page it replaces.

---

## 13. Risks

**High**
- **Recurrence edge cases.** Month-end, leap years, DST, "last Monday". Every
  one gets a test before any view renders it
- **Migration correctness.** Seven real records. The verification in §6 is the
  gate, not a spot check

**Medium**
- **Two systems alive at once.** Mitigated by removing the `MODULES` entry in
  Stage B, so `/c/recurring` cannot answer independently
- **Expansion performance** at 1,000+ items. Bounded by visible range and capped
  per item; measure at Stage A rather than assuming, as Phase 4 did

**Low**
- Scope creep into employee scheduling. Calendar and Schedule stay separate
  domains; nothing here touches `scheduled_shifts`
