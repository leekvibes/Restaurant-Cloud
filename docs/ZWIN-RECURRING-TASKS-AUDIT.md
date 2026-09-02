# ZWIN — Recurring Tasks

A complete description of `/c/recurring` as it exists today: data, behaviour,
UI, and the decisions baked into it. Written to be read cold by someone with no
other context.

Audited at `d7e7004`. Nothing in this document is a proposal — it is what the
code does.

---

## 1. What it is for

The tasks a restaurant must repeat on a cycle and that hurt when forgotten:
hood cleaning, grease trap service, pest control visits, deep cleans,
compliance checks. Each one has a rhythm ("quarterly"), a person responsible,
and a next-due date that moves forward every time the job is done.

It is a **tracker**, not a workflow. There is no assignment, no completion
evidence, no approval, no history beyond "when was it last done".

---

## 2. Where it lives

| | |
|---|---|
| Nav | Sidebar → **Tasks & logs** → Recurring tasks |
| Route | `/c/recurring` |
| Table | `m_recurring` |
| Access | Owner/manager side only. Not in the staff portal. Employees never see it |
| Permission | The `c` / trackers feature area, same as the other ten `/c/*` modules |

It is one of eleven modules under `/c/` (invoices, expenses, vendors, products,
expirations, equipment, documents, contacts, recurring, incidents, notes). Most
of those share a **generic** implementation. Recurring tasks is one of the few
with a large custom page on top of it.

---

## 3. Data model

```sql
CREATE TABLE m_recurring (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  name        TEXT,          -- "Hood cleaning"
  frequency   TEXT,          -- 'Weekly' | 'Monthly' | 'Quarterly' | 'Annual'
  next_due    TEXT,          -- 'YYYY-MM-DD', nullable
  last_done   TEXT,          -- 'YYYY-MM-DD', nullable
  responsible TEXT,          -- free text name, NOT a foreign key to employees
  notes       TEXT,
  category    TEXT           -- one of six, added later by migration
)
```

**Seven rows in the live dev database.** Examples: Grease trap service
(Quarterly, Malek), Pest control visit (Monthly, Kevin), Hood cleaning
(Quarterly, Malek).

### Things worth knowing about the schema

- **`responsible` is free text, not an employee id.** Renaming or deactivating
  an employee does not touch it. Deliberate — the responsible party is often a
  vendor or an outside contractor, not somebody on the payroll.
- **Dates are calendar dates, not business dates.** Correct: a grease trap
  service is paperwork, not a service shift. It does not roll at the 4am cutoff.
- **No completion history.** `last_done` holds only the most recent date. There
  is no log of every past completion — doing a task twice overwrites the first.
- **No foreign keys, no unique constraints, no indexes** beyond the primary key.
  At seven rows that is fine.
- `category` was added after the table existed (`ALTER TABLE`), so old rows can
  hold `NULL` and every read falls back to `'Other'`.

---

## 4. The four statuses

Computed on every render by `statusOf(row)` — **derived, never stored**:

| Status | Condition | Label | Colour |
|---|---|---|---|
| `done` | `last_done` is today | "Complete" | green |
| `over` | `next_due` is in the past | "3 days late" | red |
| `soon` | due today, or within 7 days | "Due today" / "Due in 4 days" | amber |
| `sched` | more than 7 days out | "In 21 days" | blue |
| `none` | `next_due` is NULL | "No date" | grey |

Note the ordering: **"done today" wins over everything.** A task completed this
morning shows green even if its old due date was last week.

The comment in the source explains the colour split: overdue and due-soon are
different signals, and merging them into one colour would lose both.

---

## 5. Frequency and how "done" advances the date

`advanceDate(iso, frequency)`:

| Frequency | Adds |
|---|---|
| Weekly | 7 days |
| Monthly | 1 month |
| Quarterly | 3 months |
| Annual | 1 year |
| anything else | 1 month (fallback) |

**Marking done advances from TODAY, not from the old due date.** A quarterly
task that was two weeks late becomes due three months from today, not three
months from when it was originally due. This means lateness does not compound —
but it also means the original cadence drifts.

### The undo, and why it exists

`POST /c/recurring/:id/done` writes `last_done = today` and
`next_due = advanceDate(today, frequency)`, then redirects with an **undo link**
carrying the previous two dates in the querystring:

```
/c/recurring/12/undo?d=<old next_due>&l=<old last_done>
```

The source comment gives the reason plainly: *"this advances by the frequency,
so a mis-tap on a quarterly task pushes it three months out with no way back by
hand."*

`POST /c/recurring/:id/undo` restores both dates from those parameters.

**Weaknesses of the undo, stated honestly:**
- It is a **GET-style querystring on a POST** — the old values travel in the URL
- It is **not time-limited or single-use**. The link works forever if kept
- It **does not verify** the values are the ones that were actually replaced, so
  a hand-edited URL can set any dates
- The undo is only offered in the flash message. Navigate away and it is gone

---

## 6. Routes

| Method | Route | What it does |
|---|---|---|
| GET | `/c/recurring` | The page. `?view=calendar` switches view, `?m=YYYY-MM` picks the month |
| POST | `/c/recurring` | Create. Custom route — validates category and frequency against allow-lists |
| POST | `/c/recurring/:id/done` | Mark done, advance the date, offer undo |
| POST | `/c/recurring/:id/undo` | Restore the two dates from the querystring |
| GET | `/c/:slug/:id` | **Generic** detail page |
| GET | `/c/:slug/:id/edit` | **Generic** edit form |
| POST | `/c/:slug/:id` | **Generic** update |
| POST | `/c/:slug/:id/delete` | **Generic** delete |

The last four come from `src/modules.js`, shared with all eleven trackers. So
recurring tasks has a **custom list page and custom create**, but **generic
edit, detail and delete**.

### Input validation on create

```js
category:  CATEGORIES[req.body.category] ? req.body.category : 'Other'
frequency: FREQ.includes(req.body.frequency) ? req.body.frequency : 'Monthly'
next_due:  String(req.body.next_due || '').slice(0, 10) || null
```

Both enums are allow-listed server-side — a forged category or frequency falls
back to a safe default rather than being stored. `name` is required and the
route refuses an empty one.

---

## 7. The page

### Summary cards (four, across the top)

| Card | Tone | Number | Subtitle |
|---|---|---|---|
| Overdue | red | count of `over` | the first one's name, "+N more" |
| Due this week | amber | count of `soon` | first name, or "Clear this week" |
| Active tasks | blue | total rows | "N categories" |
| Done this month | green | rows whose `last_done` is in the current month | "Next: <name>" |

### Toolbar

- **Search box** — client-side, filters on a `data-search` attribute holding
  name + category + responsible + frequency, lowercased. No server round-trip
- **Category chips** — one per category actually in use, each with a count, plus
  an "All" chip. Client-side filter
- **List / Calendar toggle** — a link pair, so the view is in the URL

### List view (`recurBoard`)

Grouped into sections, and **empty groups are omitted**:

1. Overdue
2. This week
3. Scheduled
4. Completed today
5. No date set

Each task renders as a card carrying its category colour, a category icon, the
task name (linking to the detail page), the category, the status pill, and a
"mark done" action.

### Calendar view (`recurCalendar`)

A month grid. For each task it walks forward from `next_due`, repeatedly
applying the frequency, and drops an entry on every date that lands inside the
month.

**Projected occurrences are marked** (`projected: !first`) — the first is the
real next-due date, the rest are forecasts of where the cycle will land.

There is a `guard++ < 500` loop limit, so a bad frequency cannot hang the page.

Month navigation is prev/next links carrying `?m=YYYY-MM`.

### Empty state

If there are no tasks at all: an icon, "No recurring tasks yet", and the line
*"Add the ones that bite when they're forgotten — hood cleaning, grease trap,
pest control."* The New button only renders if the account can write.

---

## 8. Categories

Six, hardcoded, each with a colour, a tint and an icon:

| Category | Colour | Icon |
|---|---|---|
| Cleaning | blue `#2563eb` | cleaning |
| Maintenance | orange `#ea580c` | equipment |
| Safety | red `#dc2626` | incidents |
| Pest Control | green `#059669` | pest |
| Compliance | violet `#7c3aed` | policy |
| Other | slate `#64748b` | recurring |

Unknown or NULL falls back to Other. **This is a separate palette from the
Scheduler's ten position colours** — the two are unrelated and should not be
merged.

---

## 9. Integration with the rest of the app

- **Dashboard alert.** Overdue tasks raise an alert: *"3 tasks are overdue."*
  (`src/server.js:1214`)
- **Global search.** Recurring tasks are searchable from the masthead
- **No notifications.** Nothing is pushed or emailed. No admin notification when
  a task falls overdue — the dashboard alert is the only surfacing
- **No staff portal presence.** Employees cannot see or complete tasks, even
  when they are the named `responsible` party

---

## 10. What it deliberately does not do

- No per-completion history or audit trail
- No attachments or proof of completion
- No assignment to an actual employee account
- No reminders, email, or push
- No escalation when something is badly overdue
- No cost tracking, no vendor link
- No pause/skip for a cycle
- No "due on the 1st of every month" — only interval-from-last-done

---

## 11. Honest weaknesses

Ranked by how much they would matter in practice.

**Medium**

1. **Cadence drift.** Advancing from *today* rather than from the *due date*
   means a task done three weeks late has its whole future schedule shifted
   three weeks. Over a year a monthly task can lose a cycle. This is a real
   product decision, not a bug — but it is a decision, and nobody has confirmed
   it is the wanted one.
2. **No completion history.** `last_done` is a single field. There is no way to
   answer "when were the last four hood cleanings", which is exactly the
   question a health inspector asks.
3. **The undo link is unguarded.** It carries the restore values in the URL,
   never expires, and can be replayed or hand-edited to set arbitrary dates.
   Low impact (it only moves two dates on one row) but it is unvalidated input.

**Low**

4. `responsible` is free text, so it cannot be filtered by employee or rolled up
   per person reliably (typos create new "people").
5. No index on `next_due` — irrelevant at seven rows, would matter at thousands.
6. The calendar projects forward but never backward, so past occurrences do not
   appear in an earlier month.
7. No test coverage specific to this page. `pages.test.js` loads the route and
   asserts a 200; nothing tests `advanceDate`, `statusOf`, done, or undo.

---

## 12. Files

| File | Lines | What |
|---|---|---|
| `src/server.js` | 13540–13875 | Everything custom: constants, `advanceDate`, `statusOf`, `recurQ`, the page, both views, all four custom routes |
| `src/modules.js` | 251–267 | The module registry entry: fields, list columns, ordering, the "mark done" row action |
| `src/modules.js` | 679–890 | The generic CRUD all trackers share |
| `public/broadsheet.css` | — | `.mcard*`, `.tcard*`, `.tgroup*`, `.fchip*`, `.cal-*`, `.toolbar2`, `.seg-view` |

The schema is **generated from the field config** in `modules.js`, which is the
single source of truth for the columns.
