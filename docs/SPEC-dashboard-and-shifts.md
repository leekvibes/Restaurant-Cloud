# ZWIN — Dashboard & Shifts: functional specification

**Purpose of this document.** A complete inventory of what these two screens do, written so a redesign can change how they look without dropping a feature, breaking a permission, or losing a business rule. Every user-facing string is quoted verbatim. Every figure has its computation rule.

Generated from `src/server.js` at commit `784f743`. If the code moves, re-generate rather than trusting this.

---

## How to use this with a designer

Three kinds of statement appear below, and they carry different weight:

- **Business rules** — quoted from code comments. These encode decisions that cost something to learn. Changing one is a product decision, not a design one. Example: *"Averages divide by shifts that HAVE figures. Counting a shift that was logged but never filled in halves the average and makes every service look worse than it was."*
- **Behaviour** — what the screen does. Safe to re-present, not safe to drop.
- **Strings** — exact copy. Rewording is fine; losing the distinction a string is making is not. `Nobody on it` and `Needs review` are different states for a reason.

**Things that were deliberately removed and must not come back.** The dashboard used to carry a recent-services table, a sales-and-labor chart, an invoice-spend chart, and an insights panel. All four were removed because each one *was* another page — they are on `/shifts`, `/costs` and `/c/invoices`. `test/dashboard.test.js` asserts their absence. Re-adding them re-creates the problem where the same number has two homes and can disagree with itself.

---

## Five bugs found while writing this

These are live in production right now. A redesign should fix or consciously keep each — they are not features.

| # | Bug | Where | Effect |
|---|---|---|---|
| 1 | **`/activity` has no route** | `server.js:808` | The `View all →` link under Recent activity 404s. Verified: no route in `src/`. |
| 2 | **Invoices due soon never reach "Coming up"** | `server.js:469` | The branch tests `st.key === 'soon'`; `invStatus` returns `'due'`. Dead code — an invoice due in three days raises nothing until it is overdue. |
| 3 | **The shift progress bar is invisible** | `server.js:598`, `styles.css:1311` | `<div class="bar tn-bar"><span style="width:60%">` has no CSS. The only `.bar` rule is an SVG `fill` for chart bars. The "4 of 6 submitted" bar renders as nothing. |
| 4 | **An unreachable empty state** | `server.js:712` vs `806` | `Nothing due in the next week.` can never render — the section is only emitted when there IS something due. |
| 5 | **`dp()` defaults to `Dinner`** | `views.js:57` | Any null daypart reads as `Dinner`. In the activity feed a submission with no daypart says `submitted for Dinner`. |

---

# PART ONE — THE DASHBOARD

**Route:** `app.get('/')` — `src/server.js:379–811`. **Area key:** `dashboard`.

## 1. Purpose and permissions

### What the page is for

From the header comment (`server.js:354–378`), it answers four questions in order:

1. *What needs my attention?* — Needs attention, grouped by severity
2. *How is the business doing?* — the two figure bands
3. *What changed?* — Recent activity
4. *What should I do next?* — Today, Coming up, Quick actions

Two invariants every figure follows, quoted:

> "Today is not a measurement. A shift that is halfway through has half its sales and none of its tips, so the headline numbers use COMPLETED shifts over a trailing window. Today gets its own strip, where 'in progress' is the point rather than a distortion."

> "A percentage of nothing is withheld, not printed as zero. With no invoices logged, food cost isn't 0% — it's unknown, and printing 0% reads as extraordinarily good news."

### The permission model

```js
const may = (key) => !me || me.master || !me.features || !me.features.length || me.features.includes(key);
const canWrite = !me || me.role !== 'viewer';
const seeShifts = may('shifts') || may('sales');
const seeCosts  = may('costs');
```

`may(key)` is true when: no signed-in user (only when `APP_PASSWORD` is unset), OR the master session, OR **the account has an empty feature list** (that means unrestricted, not restricted), OR the key is listed.

Feature keys come from `src/nav.js` and are stored on user rows — **renaming one revokes access for everyone who had it.** `costs` still keys the page now labelled "Performance".

Keys this page consults: `shifts`, `sales`, `costs`, `cash`, `payroll`, `trackers`, `menu`.

Why shifts and costs are separate permissions, quoted:

> "Two different permissions, deliberately not one. Shift takings and what a service costs in wages belong to whoever runs the floor; what the food costs and what the business keeps is the costs area. Lumping them into one 'can see money' flag handed a shift supervisor the P&L."

Gated queries are **skipped entirely**, not filtered after the fact — no cost, no leakage.

### What a viewer loses

- **Quick actions** — the whole section, heading included
- The `Log today's shift` CTA on the no-shift notice (the notice still shows, without the link)
- The **Cash reconciliation due** notice entirely
- Plus a standing banner: `View only. You can see everything here and change nothing. Ask the owner if you need to edit.`
- Any non-GET returns 403 `Your account is view-only.`

Everything else is identical to an owner with the same features.

## 2. Data inputs and their rules

### Date anchors

All dates are **business** dates in restaurant-local time. `TZ=America/New_York` must be set on the host — a UTC host "would roll the date over mid-dinner-service and file a Thursday close under Friday."

| Name | Value |
|---|---|
| `today` / `toStr` | local midnight, `YYYY-MM-DD` |
| `from7` | 7 days back, **inclusive of today** |
| `from30` | 30 days back |
| `from56` | 56 days = 8 weeks, for the sparkline |

### The metric rules that matter

| Rule | Where | What it says |
|---|---|---|
| **Shift sales** | `metrics.js:41` | Category totals if entered, else the sum of what servers rang: `CASE WHEN (food+coffee+alcohol+other) > 0 THEN that ELSE server_sales END` |
| **Wages** | `metrics.js:49` | `hours × rate`, where rate resolves per-shift override → wage for *that role* → employee default. **Salaried staff excluded** — "their pay doesn't move with the shift, so folding it in would make a quiet Tuesday look as expensive as a full Saturday" |
| **COGS** | `metrics.js:57` | Only invoice categories `Food`, `Coffee`, `Beverage`, `Alcohol` |
| **Percentages** | `metrics.js:80` | `d > 0 ? round(n/d*1000)/10 : null` — *"A percentage of nothing is not zero, it is unanswerable."* One decimal |
| **Averages** | `server.js:605` | *"Averages divide by shifts that HAVE figures. Counting a shift that was logged but never filled in halves the average and makes every service look worse than it was."* |
| **Summary money** | `server.js:618` | `brief()` drops the cents above $1,000 for glance figures and carries the exact number in the `title`. **Display only — nothing that reconciles uses it** |

### Dead computation to drop, not port

`daily`, `shiftSeries`, `avgWage`, and five of six derived fields on each `weekly` bucket are computed and never used.

## 3. Sections in DOM order

```
flash(req)                    ← ?msg= banner, with optional Undo
<header class="dhead">        ← greeting, date, status line
[.tnotices]                   ← Today strip (outside .dash)
<div class="dash">            ← 2-col grid, 1 col ≤1100px
  Needs attention
  Last service
  This week
  Coming up
  Quick actions
  Recent activity
</div>
```

`sec(title, body, …)` returns `''` when body is falsy — **an empty body removes its heading too.**

### 3.1 Header

- **`<h1>`** — `Good morning` / `Good afternoon` (<17h) / `Good evening`, plus `, {FirstName}` for a named account. The master session shows no name.
- **Date** — `Tuesday, July 21`
- **Status pill** — coloured dot + status line. Class `live` if a shift is open (dot pulses), `warn` if any red item, else `calm`.

### 3.2 Today notices — `.tnotices`

Rationale: *"on a real evening there is more than one thing true at once: a service running, a drawer waiting, payroll ready to go."*

Emitted in this DOM order. Tones here are a **separate vocabulary** from the attention tones: `live`, `idle`, `done`, `todo`.

| # | Condition | Tone | Title | Subtitle | CTA → |
|---|---|---|---|---|---|
| A | one per open shift today | `live` | `Café · open` / `Dinner · open` | `6 on · 24.5 hrs · $412.00 tips — 4 of 6 submitted` | `Open shift →` → `/shifts/{id}` |
| B | no shift today | `idle` | `No shift started today` | `Start one and staff can submit their tips from their phones.` | `Log today's shift →` → `/shifts/new` **(writers only)** |
| C | all today's shifts sent | `done` | `Today is closed out` | `2 services sent · $4,120.00 rung` | `All shifts →` → `/shifts` |
| D | a shift sold cash, no count yet | `todo` | `Cash reconciliation due · Café and Dinner` | `The drawer has not been counted for today yet.` | `Count the drawer →` → `/cash/new` |
| F | last period ended, nothing sent | `todo` | `Payroll ready to send` | `Jul 4 – Jul 17` | `Review payroll →` → `/payroll` |
| E | invoices read but not imported | `todo` | `3 invoices awaiting review` | `Lines have been read but the product costs have not been updated.` | `Review lines →` → `/c/invoices/{id}` or `/c/invoices` |

Notice A also carries a **progress bar** (`pct` = submitters ÷ people) and a red **warn** line: `2 still have no hours` or `A note from staff to read`.

⚠️ **The progress bar has no CSS and renders invisibly.** See bug #3.

B and C are mutually exclusive with each other and with A. D silently requires `shifts` as well as `cash`, because it filters today's shifts.

**When there are no notices the entire strip is absent.** There is no empty state.

### 3.3 Needs attention

Design rule, quoted: **"Every entry names the specific thing and links to it. A count with no route attached is a nag, not a to-do."**

- Heading `Needs attention` + a red count pill
- Grouped `Critical` (red) / `Warning` (amber) / `For information` (blue); an empty group emits nothing
- Sorted worst-first: *"so a drawer that came up short is never buried under six expiry reminders"*
- **Collapse rule** — *"Critical is never folded — an alert that needs a tap to be seen is not an alert."*
  - red: all shown, never collapsed, **no cap**
  - amber: 2 shown, rest behind `<details>` reading `{n} more`
  - blue: 0 shown, all behind `<details>`
- Empty: `✓ Nothing needs your attention right now.`

**All 13 alerts:**

| Tone | Title | Subtitle | → | Trigger | Gate |
|---|---|---|---|---|---|
| red | `Jul 19 Dinner — hours missing` | `1 person has no hours entered` | `/shifts/{id}` | a past unsent shift with `no_hours` | `shifts` |
| blue | `Jul 19 Dinner — ready to send` | `Everything is in; staff are waiting on it` | `/shifts/{id}` | past, unsent, staffed, hours complete | `shifts` |
| blue | `Jul 19 Dinner — 2 notes from staff` | `Read it before you close the shift` | `/shifts/{id}` | `notes > 0` (**can co-occur with the two above**) | `shifts` |
| red | `Grease trap — 3 days late` | responsible person, or `Recurring task` | `/c/recurring` | recurring task overdue | `trackers` |
| amber | `Hood cleaning — due today` | as above | `/c/recurring` | due today | `trackers` |
| red | `Invoice INV-2044 — 3 days overdue` | `$1,240.00` | `/c/invoices` | past due date, unpaid | `trackers` |
| blue | `Invoice INV-2044 — lines not imported` | `$1,240.00 read but product costs unchanged` | `/c/invoices/{id}/import` | AI read the lines, nobody confirmed | `trackers` |
| red | `Liquor licence — expired` | `Expires Jul 25` | `/c/expirations/{id}` | `d < 0` | `trackers` |
| amber | `Liquor licence — expires today` | as above | as above | `d === 0` | `trackers` |
| amber | `Liquor licence — 5 days left` | as above | as above | `1 ≤ d ≤ 7` | `trackers` |
| red | `Jul 19 Dinner — $32.10 short` | `Counted by Malek` or `Nobody recorded as counting it` | `/cash/{id}` | variance > $25 (setting), last 14 days | `cash` |
| amber | same form | same | `/cash/{id}` | variance $5–$25 (setting) | `cash` |
| amber | `Jul 19 Dinner — drawer never counted` | `$1,840.00 rung and no reconciliation` | `/cash/new` | sold cash in the last 6 days, no final count | `cash`+`shifts` |
| blue | `Payroll ready — Jul 4 – Jul 17` | `The period has ended and nothing has gone out` | `/payroll` | period ended, nothing sent | `payroll` |

Rationale for the drawer alert: *"A service that sold cash and was never counted is not a variance — it is a drawer nobody looked at, which is the one nobody notices."*

**Deliberately removed, do not resurrect:** the "at reorder point" alert. *"It counted on an on-hand number nobody could keep true without POS depletion, and Products deliberately doesn't show one — so the alert had no page left to send you to."*

**Two alerts are duplicated as Today notices** — unimported invoices, and payroll-ready. Each appears twice on the page.

### 3.4 Last service — `.dstrip`

Renders only when a shift in the last 30 days has sales > 0.

- Heading `Last service`; header link `Jul 19 Dinner →` → `/shifts/{id}` (a `sales`-only account gets plain text, no link)
- Four cells: `Sales` · `Tips` · `Hours` · `Staff`. Money uses `brief()` with the exact figure in the `title`. Missing values read `—`

Rationale for what was cut: *"Three of the four cards here were 'average per service', 'wage cost per service' and 'sales per labor hour' — which are the questions the Sales and Performance pages exist to answer. On a dashboard they were 262px of numbers nobody acts on before breakfast."*

### 3.5 This week — `.dstrip`

Requires `costs`. A shifts-only account never sees it.

- Heading `This week`; link `Performance →` → `/costs`
- Four cells:

| Label | Value | Sub |
|---|---|---|
| `Sales` | `brief(p7.sales)` | delta chip vs the previous 7 days |
| `Labor` | `12.4%` or `—` | `of sales`, or `no sales` |
| `Food` | `28.1%` or `—` | `of sales`, or `no invoices` |
| `Prime` | `40.5%` or `—` | `labor + goods`, or `needs invoices` |

- Delta chip: `no prior period` / `flat` (<0.5%) / `▲ 8.2%` green / `▼ 4.0%` red. **Up is good here** (not inverted)
- Sparkline: 8–9 weekly points, 54px. **A null breaks the line rather than diving to zero** — *"a closed Monday drawn at zero reads as a catastrophic Monday"*

### 3.6 Coming up

Only emitted when there is something due. Max **6 items, silently truncated**.

| Title | Sub | → | Trigger |
|---|---|---|---|
| `Grease trap` | `due in 3 days` | `/c/recurring` | 1–7 days out |
| `Liquor licence` | `expires in 20 days` | `/c/expirations/{id}` | 8–30 days out |
| `Walk-in cooler` | `warranty ends in 15 days` | `/c/equipment/{id}` | 8–30 days out |
| `Payroll — Jul 18 – Jul 31` | `period ends in 4 days` | `/payroll` | 0–7 days out |
| ~~`Invoice INV-2044`~~ | ~~`Due in 3 days · $1,240`~~ | — | **dead code, see bug #2** |

### 3.7 Quick actions

Writers only. Grid, 2 columns on mobile with the icon above the label.

| Label | Tooltip | → | Gate |
|---|---|---|---|
| `Log a shift` | `Hours, sales and tips for a service` | `/shifts/new` | `shifts` |
| `Count the drawer` | `Reconcile cash and record the deposit` | `/cash/new` | `cash` |
| `Upload an invoice` | `Read the lines and update product costs` | `/c/invoices` | `trackers` |
| `Cost a menu item` | `Build a recipe and see its margin` | `/menu/new` | `menu` |
| `Add a vendor` | `Contacts, terms and where the login lives` | `/c/vendors` | `trackers` |
| `Log an incident` | `Write it down while it is fresh` | `/c/incidents` | `trackers` |

The blurb is the tooltip only: *"The blurb explained what 'Log a shift' means to somebody who has logged four hundred of them, and cost 70px a row to do it."*

### 3.8 Recent activity

- Heading `Recent activity`; link `View all →` → `/activity` — ⚠️ **404s, see bug #1**
- **5 rows.** *"Five. Ten was a log, and the page already has somewhere to read the log."*
- Empty: `Nothing has happened yet.`

**Grouping rule**, quoted: *"A busy close puts one line per person per submission into the log, which is right for the audit trail and useless as a feed — seven of eight rows become 'someone submitted' and everything else falls off the bottom. All the submissions for a shift collapse into one entry naming who."*

| Kind | Text | → |
|---|---|---|
| shift | `**Sandra** submitted for Dinner` / `**Sandra** and **Kevin** submitted…` / `**Sandra** and 3 others submitted…` | `/shifts/{id}` |
| invoice | `Invoice added from **Sysco** · INV-2044` | `/c/invoices` |
| vendor | `**Sysco Foods** added to vendors` | `/c/vendors` |
| incident | `Incident logged · Injury` | `/c/incidents` |
| note | `Decision logged · Switched coffee supplier` | `/c/notes` |
| cash | `Drawer reconciled · Dinner by **Malek**` | `/cash` |
| payroll | `Payroll sent · period from 2026-07-04` | `/payroll` |

Timestamps: `just now` / `4m ago` / `3h ago` / `yesterday` / `4 days ago` / `Jul 19`.

### 3.9 Status line

Four variants, in precedence order:

1. `Your Café and Dinner shifts are open. 3 things need your attention.` — when a shift is open
2. `2 things need sorting out, 5 more can wait.` — when any red item exists
3. `4 things to look at, nothing urgent.` — amber/blue only
4. `Everything is running smoothly today.`

## 4. Interactivity

**The page ships no page-specific JavaScript.** All server-rendered HTML + CSS.

Native behaviour only: `<details>` collapse on the attention overflow (summary appends ` — hide` when open); SVG `<title>` tooltips on the sparkline; `title` tooltips on quick actions and on money values that dropped their cents; CSS hover transforms; a pulsing dot when a shift is live.

**There is no way to dismiss, snooze or acknowledge an attention item.** It disappears only when the underlying condition resolves. That is a deliberate design position worth re-deciding consciously.

## 5. Empty states

| Section | Brand new account |
|---|---|
| Header | renders; status `Everything is running smoothly today.` |
| Today | only `No shift started today`; strip absent entirely without `shifts` |
| Needs attention | `✓ Nothing needs your attention right now.` |
| Last service | **absent** |
| This week | renders with `$0.00`, `—`, `no invoices`, `needs invoices`, `no prior period` |
| Coming up | **absent** |
| Quick actions | renders for any writer |
| Recent activity | `Nothing has happened yet.` |

---


# PART TWO — THE SHIFTS MODULE

## 1. The shift lifecycle

### 1.1 The state function (server.js:836–842, quoted verbatim)

```js
function shiftState(x, today) {
  if (x.status === 'emailed') return { key: 'sent', label: 'Sent', cls: 's-done' };
  if (x.date === today) return { key: 'open', label: 'Open', cls: 's-sched' };
  if (!x.people) return { key: 'empty', label: 'Nobody on it', cls: 's-none' };
  if (x.no_hours) return { key: 'review', label: 'Needs review', cls: 's-soon' };
  return { key: 'ready', label: 'Ready to send', cls: 's-ready' };
}
```

The branches are evaluated **in order and the first match wins**. This is load-bearing: a shift dated today that has nobody on it reads `Open`, not `Nobody on it`; an emailed shift reads `Sent` even if it is incomplete.

| key | label (verbatim) | CSS class | Meaning | Entered when |
|---|---|---|---|---|
| `sent` | `Sent` | `s-done` | `shifts.status = 'emailed'` | `POST /shifts/:id/send` runs `s.markEmailed` (server.js:1804). **Always** runs — even in preview mode, even if every email failed. Nothing ever moves it back. |
| `open` | `Open` | `s-sched` | The shift's date is today's local business date | Automatic, purely date-driven. Ages out at local midnight. |
| `empty` | `Nobody on it` | `s-none` | Past date, no `work` rows | The default for a shift created with `GET/POST /shifts/new` and never populated. |
| `review` | `Needs review` | `s-soon` | Past date, has people, ≥1 person with `hours IS NULL OR hours = 0` | Anyone added by the staff tips page, the AI photo import, or the POS webhook lands with `hours = 0`. |
| `ready` | `Ready to send` | `s-ready` | Past date, has people, everyone has hours | Manager fills the last person's hours. |

`today` = `isoDate(startOfToday())` — **local** timezone, never UTC (`src/dates.js:9`, deliberate; hosts must set `TZ`).

### 1.2 Status CSS — note for the designer

`.tstatus` (styles.css:668) supplies the pill shape. The colour rules are `.tstatus.s-over / .s-soon / .s-sched / .s-done / .s-none` (669–673) — **but `s-ready` is defined as a bare `.s-ready` at styles.css:1220**, in the shift-list block, not as `.tstatus.s-ready`. Different specificity, same visual result today. Preserve both selectors or normalise them deliberately.

### 1.3 There is no lock

`status = 'emailed'` gates nothing. Every edit route, the delete route, and the send routes work identically on a sent shift. Re-sending re-runs the engine against current data and re-marks it emailed.

### 1.4 Policy version stamping

`policyForShift(shift)` (policy.js:45–52) is the second lifecycle axis:

- If `shifts.policy_id` is set and the row still exists → returns that version's rules.
- Otherwise → looks up the current version for the shift's `daypart` and **writes the stamp** (`s.setPolicy`).
- If no policy version exists at all → returns `defaultRules()` and stamps nothing.

It is called from `POST /shifts` (1086), `GET /shifts/:id` (1169), `GET /shifts/:id/results` (1680), `GET /shifts/:id/email/:employeeId` (1764), `POST /shifts/:id/send-one` (1784), `POST /shifts/:id/send` (1801). **Merely opening the workspace on an unstamped shift performs a write.** That is intended (a shift is frozen against the policy in force when first touched), but it means a GET is not side-effect-free.

---

## 2. `GET /shifts` — the list page (server.js:844–1064)

### 2.1 Data

One query, `shiftRollup` (829–830): `SELECT sh.*, <SHIFT_ROLLUP_COLS> FROM shifts sh ORDER BY sh.date DESC, sh.daypart DESC`. Note `daypart DESC` puts `dinner` before `cafe` within a day.

`SHIFT_ROLLUP_COLS` (241–272) computes per shift:

| Column | Rule |
|---|---|
| `hours` | `SUM(work.hours)`, 0 if none |
| `people` | `COUNT(*)` of `work` rows |
| `no_hours` | count of `work` rows with `hours IS NULL OR hours = 0` — **includes salaried people** |
| `server_sales` | `SUM(food_cents + coffee_cents + alcohol_cents)` over `server_sales` |
| `tips` | `SUM(card_tips_cents + cash_tips_cents)` over `server_sales` (servers **and** support) |
| `notes` | count of `server_sales` rows with a non-blank `note` |
| `subs` | count of `tip_submissions` rows |
| `submitters` | `COUNT(DISTINCT employee_id)` in `tip_submissions` |
| `wage_cents` | `ROUND(SUM(hours × rate))` joined to employees, **excluding `pay_type = 'salary'`**. Rate = `COALESCE(NULLIF(work.hourly_rate_cents,0), NULLIF(employee_roles.wage_cents,0), employees.hourly_rate_cents, 0)` (reports.js:28–29) |
| `no_wage` | count of non-salaried people with `hours > 0` whose resolved rate is 0 |

`shiftSales(x)` (833–834): `(total_food + total_coffee + total_alcohol + total_other) || server_sales`. Shift-level totals (entered on the Sales screen) win; if all four are zero it falls back to the sum of per-server sales.

### 2.2 DOM order

1. `flash(req)` (views.js:507–519) — rendered only when `?msg=` is present. `<div class="flash flash-ok">` or `flash-err` when `?err=1`. An optional `?undo=<same-site path>` renders an `Undo` submit button; not used by any shift route.
2. **`.phead`** — `<h1>Shifts</h1>`, subtitle, and (write-gated) primary button.
3. **KPI cards** `.mcards.mcards-4` — only when `all.length > 0`.
4. **Today block** `<section class="today">` — only when there are non-emailed shifts dated today.
5. **Attention block** `<section class="attn">`.
6. **Body**: either the year bar + toolbar + month groups + hidden empty-state, or the first-run hero.
7. `<script>` — the search/filter behaviour.

### 2.3 Page head (1023–1027)

- `<h1>Shifts</h1>`
- Subtitle, two variants:
  - with shifts: `` `${all.length} logged. Staff submissions start a shift on their own.` ``
  - with none: `Where every service gets closed out.`
- `＋ Log a shift` → `/shifts/new`, **rendered only when `canWrite()`** (1026). This is the only `canWrite()` call in the entire Shifts module.

### 2.4 KPI cards (884–897)

**These always describe the current calendar month (`thisMonth = today.slice(0,7)`), regardless of which year tab is selected.** They are computed from `monthRows`, not from the year-filtered `rows`. Do not let a redesign imply they follow the tab.

Denominators (862–876):
- `n` = shifts in this month.
- `counted` = those with `hours > 0 || shiftSales(x) > 0`; `k = counted.length`. Averages divide by `k`, so tonight's empty shift does not drag the average down.
- `per(total, by)` = `by ? money(round(total/by)) : '—'`.
- `laborPct` = `round(monthWages / monthSales × 100)`, or `null` when either is 0.
- `skipped = n - k`.

| Tone | Icon | Label | Value | Sub-line |
|---|---|---|---|---|
| `blue` | `sales` | `Sales this month` | `money(monthSales)` | `` `across ${n} shift(s)` `` — or `nothing logged yet` when `n === 0` |
| `green` | `cash` | `Avg sales a shift` | `per(monthSales, k)` | `salesSub`: `nothing to average yet` (k=0) / `` `÷ ${k} shift(s) with figures` `` (skipped>0) / `total sales ÷ shifts` |
| `amber` | `payroll` | `Avg wage cost a shift` | `per(monthWages, k)` | `wageSub`: `no wages logged yet` (k=0) / `` `${monthNoWage} without a wage set` `` / `` `${laborPct}% of sales · no tips` `` / `wages only, no tips` |
| `violet` | `costs` | `Sales per labor hour` | `per(monthSales, monthHours)` | `` `sales ÷ ${round(monthHours*10)/10} hrs worked` `` — or `no hours logged` |

`.mcard-sub` is a single ellipsised line; the code comments (879–880) record that anything past ~24 characters is cut off mid-word at 375px.

### 2.5 Today block (900–917)

Filter: `x.date === today && x.status !== 'emailed'`. One `<a class="tcard-open" href="/shifts/{id}">` per shift.

- Left: `.tco-ico` with the `shifts` icon; `.tco-t` = `` `Today · ${dp(daypart)}` `` (`Café` / `Dinner`, views.js:57); `.tco-s` = `` `${people} on shift · ${people - no_hours}/${people} hours in` `` plus `` ` · ${notes} note(s)` `` when `notes > 0`.
- Right: `<span class="tstatus {cls}">{label}</span>` and `<span class="tco-go">Continue →</span>`.

### 2.6 Attention block (919–938)

Source: `openOnes` = every shift in **any year** whose state key is `open`, `review` or `ready`, capped at the first 12 (`slice(0, 12)`). One shift can emit **two** list items.

`when` = `` `Today ${dp(daypart)}` `` if today, else `` `${niceDate(date)} ${dp(daypart)}` `` where `niceDate` is `en-US` `{month:'short', day:'numeric'}` — e.g. `Jul 19 Dinner`.

Per shift, in order:
- `!people` → `` `${when} — nobody on it yet` `` (bad), then `continue` (no note line).
- `no_hours` → `` `${when} — ${no_hours} ${no_hours === 1 ? 'person has' : 'people have'} no hours entered` `` (bad).
- else if state is `ready` → `` `${when} — everything's in, ready to send` `` (not bad).
- `notes` → `` `${when} — ${notes} note(s) from staff` `` (not bad).

Rendering:
- Any items: `<section class="attn">`, plus class `attn-soft` when **no** item is bad. Header icon `incidents` if any bad, else `expirations`. Header text: `` `${badCount} thing(s) to sort out` `` when badCount > 0, otherwise `Worth knowing`. Items are `<li class="attn-bad">` / `<li class="attn-note">`, each wrapping `<a href="/shifts/{id}">`.
- No items but shifts exist: `<section class="attn attn-ok">`, icon `policy`, `Everything's closed out`, paragraph `No open shifts and nothing waiting on you.`
- No shifts at all: nothing.

### 2.7 Year tabs (996–998)

`years` = distinct `date.slice(0,4)` across all shifts, sorted ascending then reversed → newest first. Selected year = `?y=` when it is a real year in the list, else `years[0]`, else the current year. Tab: `<a class="ytab[ on]" href="/shifts?y={y}">{y}</a>`. Only shifts in the selected year appear in the month groups.

### 2.8 Toolbar (999–1011)

- `.searchbox`: `search` icon + `<input id="ssearch" type="search" placeholder="Search a date, month or service…" autocomplete="off">`.
- `.fchips`: seven **mutually exclusive** buttons (single-select). Each carries `data-f` (filter mode) and `data-v` (value) and inline `--c` / `--ct` custom properties.

| Label | `data-f` | `data-v` | `--c` | `--ct` | Extras |
|---|---|---|---|---|---|
| `All` | `all` | `` | `var(--ink-2)` | `var(--surface-3)` | starts `.on`; carries `<span class="fcount">{rows.length}</span>` — the count of shifts **in the selected year**, static |
| `Café` | `service` | `cafe` | `#0891b2` | `#ecfeff` | `<i class="fdot">` |
| `Dinner` | `service` | `dinner` | `#4f46e5` | `#eef2ff` | `<i class="fdot">` |
| `Open` | `status` | `open` | `#2563eb` | `#eff6ff` | `<i class="fdot">` |
| `Needs review` | `status` | `review` | `#d97706` | `#fffbeb` | `<i class="fdot">` |
| `Ready` | `status` | `ready` | `#7c3aed` | `#f5f3ff` | `<i class="fdot">` |
| `Sent` | `status` | `sent` | `#059669` | `#ecfdf5` | `<i class="fdot">` |

There is **no chip for the `empty` state** (`Nobody on it`). Those rows are reachable only via `All` or search.

### 2.9 Month grouping (941–993)

Groups built from the year-filtered rows, keyed on `date.slice(0,7)`, sorted descending. **`idx === 0` gets the `open` attribute** — only the newest month in the selected year is expanded on load.

`<details class="mgroup" data-month>` → `<summary class="mgroup-h">`:
- `<span class="mgroup-chev">▸</span>` (rotated 90° by CSS when open)
- `<span class="mgroup-name">` = `` `${MONTH_NAMES[month-1]} ${year}` `` — full month name, e.g. `July 2026`
- `<span class="mgroup-stats">` in this order:
  1. `` `${list.length} shift(s)` ``
  2. `<span class="mg-total">` = `money(Σ shiftSales)`
  3. `` `${money(Σ tips)} tips` ``
  4. `` `${Math.round(Σ hours)} hrs` `` (whole hours here)
  5. either `<span class="mg-out">{open} not sent</span>` where `open` = count of rows whose state key ≠ `sent`, or `<span class="mg-paid">all sent</span>`

### 2.10 Shift row (957–975)

`<a class="srow" href="/shifts/{id}" data-shift data-status="{state.key}" data-service="{daypart}" data-search="{search}">`

`data-search` = `[date, dp(daypart), state.label, monthLabel].join(' ').toLowerCase()` — e.g. `2026-07-19 dinner ready to send july 2026`. Note it is lowercased and `Café` becomes `café` (accented), so typing `cafe` will **not** match the service word — it matches the `data-service` chip only.

Columns, in DOM order:

| Element | Content | Rule |
|---|---|---|
| `.srow-date` | `<b>` day-of-month, `<i>` weekday | `Number(date.slice(8,10))`; weekday from `new Date(date + 'T00:00:00')` `en-US` `{weekday:'short'}` |
| `.srow-svc.svc-{daypart}` | `Café` / `Dinner` | `dp(daypart)` |
| `.tstatus.{cls}.srow-st` | state label | `shiftState` |
| `.srow-figs` → 4 `<span>` each `<i>label</i>value` | `Sales` `money(shiftSales(x))`; `Tips` `money(x.tips)`; `Hours` `Math.round(x.hours*10)/10` (one decimal, raw number, no unit); `Staff` `x.people` | |
| `.srow-go` | `→` | |

### 2.11 Empty states (verbatim)

**No rows match the live filter** — always in the DOM, `style="display:none"` until needed (1013):
```html
<div class="empty2" id="snone">
  <div class="empty2-t">Nothing matches</div>
  <div class="empty2-s">Try a different search or filter.</div>
</div>
```

**No shifts in the database at all** (1014–1019), replaces the whole body:
- `.uh-ico` = the `shifts` icon
- `.uh-t`: `No shifts logged yet`
- `.uh-s`: `A shift starts itself the moment a staff member submits their tips — or start one here and enter it yourself.`
- `<a class="btn btn-primary btn-lg" href="/shifts/new">＋ Log a shift</a>` — **not** wrapped in `canWrite()`, unlike the header button.

---

## 3. `GET /shifts/new` and `GET /shifts/:id`

### 3.1 `GET /shifts/new` (1066–1079)

No `flash()`. No `canWrite()` gate — a viewer sees the whole form and gets a plain-text 403 on submit.

- `<a class="back" href="/shifts">← Shifts</a>`
- `<h1>Log a shift</h1>`
- `<p class="sub">Pick the day and which service (café or dinner). You'll enter sales, tips &amp; hours next.</p>`
- `<form method="post" action="/shifts" class="card form">`
  - `<label>Date <input type="date" name="date" required></label>` — no default, no min/max.
  - `<label>Service <select name="daypart">` — options from `DAYPARTS = ['cafe','dinner']` (server.js:48), labelled `Café` / `Dinner`. Not `required`; `cafe` is the implicit default.
  - `<button class="btn btn-primary" type="submit">Start</button>`

### 3.2 `GET /shifts/:id` — the workspace (1165–1503)

404 → `res.status(404).send(layout('Not found', '<h1>Shift not found</h1>'))`.

Setup: `inp = shiftInputs(sh.id)` (db.js:372–435, all figures in **dollars**), `r = runShift(inp, policyForShift(sh))`, `{warn, notes} = shiftWarnings(sh, inp, r)`, `staff = q.nonManagerList.all()` (active, `role != 'manager'`, ordered by name).

`shiftInputs` splits `work` rows on `role === 'server'` → `inp.servers`, everything else → `inp.support`. Wage resolution per person: salaried → 0; else `work.hourly_rate_cents` if > 0; else `employee_roles.wage_cents` for **that role**; else `employees.hourly_rate_cents`. `tipEligible` = `positionKinds()[role] !== 'non_tipped'`.

#### 3.2.1 Per-person state — `stateOf` (1177–1190)

`miss` is built in this order:
1. `hours` — when `!Number(p.hours) && !p.salaried`
2. server only: `cash tips` — when `!p.cashEnteredBy` (the *column*, not the amount: a genuine $0 entered by staff or manager clears this)
3. server only: `sales` — when `cardTips + cashTips > 0` and `food + coffee + alcohol === 0`
4. `email` — when `!p.email`

Result:
- `miss` empty → `{key:'ok', label:'Ready', cls:'s-done'}`
- `miss` contains `hours` → `{key:'blocked', label:'Needs hours', cls:'s-over'}`
- otherwise → `{key:'check', label:'Needs ' + miss[0], cls:'s-soon'}` → renders as `Needs cash tips`, `Needs sales` or `Needs email`.

Derived: `ready` = count of `ok`; `withHours` = `people.filter(p => Number(p.hours) || p.salaried).length`.

> Inconsistency to preserve or fix deliberately: `stateOf` exempts salaried staff from the hours requirement, but the list page's `no_hours` SQL does not. A shift with only a salaried person at 0 hours shows `Needs review` in the list and `Ready` on the card.

#### 3.2.2 Panel order

| # | Panel | Lines |
|---|---|---|
| 1 | `flash(req)` | 1347 |
| 2 | `← Shifts` back link | 1348 |
| 3 | `.shead` header + progress | 1350–1362 |
| 4 | Attention section | 1215–1227 / 1364 |
| 5 | `.mcards` — 4 KPIs | 1366–1371 |
| 6 | **Servers** section | 1373–1398 |
| 7 | **Support** section | 1400–1415 |
| 8 | **Notes from staff** (conditional) | 1286–1300 / 1417 |
| 9 | **Shared tip pool** | 1304–1344 / 1418 |
| 10 | **Submissions** | 1420–1423 |
| 11 | `.danger-zone` | 1425–1432 |
| 12 | `.stickybar` | 1434–1442 |
| 13 | `<script>` | 1444–1501 |

#### 3.2.3 Header (1350–1362)

- `.shead-day` = `shifts` icon.
- `<h1>{sh.date} · {dp(daypart)}</h1>` — the raw ISO date, e.g. `2026-07-19 · Dinner`.
- `.shead-s`: `statusPill`, then `` `${people.length} on shift` ``, then `` `${ready} of ${people.length} ready` ``.
- `statusPill` (1205–1207) is computed **independently of `shiftState`**:
  - `status === 'emailed'` → `<span class="tstatus s-done">Emails sent</span>`
  - else `warn.length` → `<span class="tstatus s-soon">Needs review</span>`
  - else → `<span class="tstatus s-sched">Ready to send</span>`
  
  Note the label `Emails sent` here vs `Sent` on the list, and `Ready to send` here carrying `s-sched` (blue) vs `s-ready` (violet) on the list.
- `.shead-prog` with `title="{withHours} of {people.length} have hours entered"`, a `.prog > .prog-fill` at `width: {pct}%` where `pct = people.length ? round(withHours/people.length*100) : 0`, and the caption `` `${withHours}/${people.length} hours in` ``.

#### 3.2.4 Attention section (1215–1227)

Identical structure to the list's, fed by `shiftWarnings`:
- Warnings and/or notes present → `<section class="attn">` (plus `attn-soft` when there are no warnings), icon `incidents`/`expirations`, header `` `${warn.length} thing(s) to sort out` `` or `Worth knowing`, then `<li class="attn-bad">` for each warning and `<li class="attn-note">` for each note. **Not links here** (unlike the list page).
- Neither → `<section class="attn attn-ok">`, icon `policy`, `Everything checks out`, paragraph `Hours are in for everyone, tips reconcile, and nobody is missing an email. This shift is ready to send.`

Full warning catalogue — `shiftWarnings` (1634–1674), in generation order:

| Condition | Text |
|---|---|
| `!r.reconciliation.balanced` | `Tip totals do not reconcile — check the numbers.` |
| each orphaned pot | `` `${money(cents)} is owed to “${role}” but nobody worked that role. Add them or the money is unassigned.` `` |
| each pool conflict | `` `Your tip-out policy has two rules paying out the same ${card?'to-go card':'cash jar'} money (the “${rule}” rule). It was only paid once — fix the duplicate on the tip-out policy page.` `` |
| skipped pot, role = `busser` | **note**, not warning: `` `No busser worked this shift, so the busser tip-out wasn’t charged — servers kept ${money}.` `` |
| skipped pot, any other role | warning: same sentence **plus** `` ` If ${role} was actually working, add them below and the tip-out will apply.` `` |
| support with no hours | `` `No hours entered for: ${names} — the pool is split by hours, so they get $0 until you add them.` `` |
| non-salaried servers with no hours | `` `No hours entered for: ${names} — their tips are correct, but their wage and payroll hours will be $0.` `` |
| anyone with no email | `` `No email on file for: ${names}. Add it under Staff.` `` |
| servers with `!cashEnteredBy` | `` `Cash tips not entered yet for: ${names}. They can add them on the cash-tip page.` `` |
| servers with tips > 0 and sales = 0 | `` `No sales recorded for: ${names} — their tip-out will calculate as $0. Add their sales below.` `` |

(Note the curly apostrophe in `wasn’t` and the curly quotes around the role name — they are literal in the source.)

#### 3.2.5 KPI cards (1366–1371) — `.mcards`, no `-4` modifier

| Tone | Icon | Label | Value | Sub |
|---|---|---|---|---|
| `blue` | `sales` | `Server sales` | `money(totalSales)` where `totalSales = Σ over servers of toCents(food)+toCents(coffee)+toCents(alcohol)` (1198) | `` `${inp.servers.length} server(s)` `` |
| `green` | `tips` | `Tips collected` | `money(r.reconciliation.totalTipsCollected)` = **servers' card + cash only**; support-reported tips are excluded | `card + cash` |
| `amber` | `cash` | `Shared pool` | `money(poolCash + poolCard)` | `` `${money(poolCash)} cash · ${money(poolCard)} card` `` |
| `red`/`green` | `incidents`/`policy` | `To sort out` | `String(warn.length)` | `see above` / `nothing outstanding` |

`poolCash = r.pool.cash` = counted jar + legacy `pool_togo_cents` + Σ support cash tips.
`poolCard = r.pool.togoCard` = counted to-go card + Σ support card tips. (engine.js:151–156)

#### 3.2.6 Servers section (1373–1398)

- `.sect-h`: `<h2>{staff icon} Servers</h2>` + `<span class="sect-n">{inp.servers.length}</span>`
- **Photo import panel** — `<details class="add-panel">`, summary `📸 Read from a report photo`. See §5.
- Person cards `.pgrid`, or empty state: `No servers on this shift yet. They appear here when they submit, or add one below.`
- **Add panel** — `<details class="add-panel">`, summary `＋ Add a server / edit their numbers`, form `#server-form` → `POST /shifts/:id/server`:

| name | type | attrs | default | validation |
|---|---|---|---|---|
| `employee_id` | `<select id="server-emp">` | `required` | first option (`staffOptions` order = active non-manager staff by name); options carry `data-role` and `data-rate` | HTML `required`; server does `Number(...)` with no check |
| `food` | `number` | `step="0.01" min="0"` `placeholder="0.00"` | empty | none server-side; blank → 0 |
| `coffee` | `number` | same | empty | same |
| `alcohol` | `number` | same | empty | same |
| `card_tips` | `number` | same | empty | same |
| `hours` | `number` | `step="0.01" min="0"` `placeholder="0"` | empty | blank → 0 |
| `wage` | `number` | `step="0.01" min="0"` `placeholder="staff default"` | empty | blank → 0, meaning "fall back to role/employee rate" |

Submit: `Save server`. There is **no `cash_tips` field** on this form — by design, so it cannot wipe what staff reported (comment at 1512–1514).

> Behaviour that must survive a redesign: `POST /shifts/:id/server` always writes food/coffee/alcohol/card_tips/hours/wage from the body. A blank field writes **0**, not "unchanged". The client-side prefill (§9) is the only thing that stops the add panel from clearing existing figures.

#### 3.2.7 Support section (1400–1415)

- `.sect-h`: `<h2>{positions icon} Support</h2>` + count.
- `<p class="sect-s">Tips they logged go into the shared pool and split by hours — not kept by whoever reported them.</p>`
- Cards, or empty state: `Nobody yet. Kitchen, baristas and bussers appear here when they submit, or add them below.`
- Add panel summary: `＋ Add support staff / edit their numbers`, form `#support-form` → `POST /shifts/:id/support`:

| name | type | attrs | default | validation |
|---|---|---|---|---|
| `employee_id` | `<select id="support-emp">` | `required` | same options as servers | HTML `required` |
| `role` | `<select id="support-role">` | — | options = `shiftRoles()` = **active positions with `kind !== 'server'`** (server.js:52), labelled with `posName(slug)`; no option pre-selected by the server, so the first wins until the JS syncs it | none server-side; the string is written to `work.role` as-is |
| `hours` | `number` | `step="0.01" min="0"` `placeholder="0"` **`required`** | empty | HTML `required` (servers' hours field is not) |
| `wage` | `number` | `step="0.01" min="0"` `placeholder="staff default"` | empty | blank → 0 |

Submit: `Save support`.

#### 3.2.8 Person card (1235–1267)

`<article class="pcard {st.cls}" data-emp="{employeeId}" data-kind="server|support" style="--c:{#4f46e5 server | #0d9488 support}">`

- `.pcard-top`: `<span class="pavatar">` = initials — first letter of each space-separated word, first 2, uppercased (1230); `.pcard-name`; `.pcard-role` = literal `server` for servers, `p.role` (raw slug) for support, plus ` · salaried` when salaried; `<span class="tstatus {cls}">{st.label}</span>`.
- `.pfigs` — each figure is `<div class="pfig" data-edit="{key}" data-step="0.01" data-ph="{placeholder}"><span>{label}</span><b>{value}</b></div>`.

**Server figures, in order:**

| Label | Value | `data-edit` | `data-ph` |
|---|---|---|---|
| `Food` | `money(toCents(p.food))` | `food` | — |
| `Coffee` | `money(toCents(p.coffee))` | `coffee` | — |
| `Card tips` | `money(toCents(p.cardTips))` | `card_tips` | — |
| `Cash tips` | `money(...)` if `p.cashEnteredBy`, else `<i class="unset">not in</i>` | `cash_tips` | `not entered` |
| `Hours` | `p.hours` if truthy, else `<i class="unset">—</i>` | `hours` | `0` |
| `Wage` | `money(rate) + '/h'` if rate, else `<i class="unset">default</i>` | `wage` | `default` |

**Alcohol is deliberately not shown on the card.** It is preserved through edits by a hidden field (§9).

**Support figures, in order:**

| Label | Value | `data-edit` | `data-ph` |
|---|---|---|---|
| `Cash tips` | `money(...)` if non-zero, else `<i class="unset">none</i>` | `cash_tips` | `none` |
| `To-go card` | `money(...)` if non-zero, else `<i class="unset">none</i>` | `card_tips` | `none` |
| `Hours` | as above | `hours` | `0` |
| `Wage` | as above | `wage` | `default` |

- `.pcard-act.row-actions`:
  - `<button type="button" class="btn btn-sm" onclick="startEdit({id},'{kind}')">Edit</button>`
  - `<form method="post" action="/shifts/{id}/remove" onsubmit="return confirm('Take {name} off this shift?')">` with hidden `employee_id` and `<button class="btn btn-sm btn-ghost">Remove</button>`.

#### 3.2.9 Notes from staff (1286–1300)

Rendered only when `w.notesForShift` returns rows (`server_sales.note` non-blank, ordered by employee name).

`<section class="sect">` → `<h2>{notes icon} Notes from staff</h2>` + `<span class="sect-n">{count}</span>` → `.msgs` → per note `.msg` with `.pavatar.msg-av` initials, `<b>{name}</b>`, optional `<span class="msg-role">{role}</span>`, `.msg-t` = the note text.

(The alternative renderer `notesBlock()` at 1094–1106, with heading `Notes from staff` and blurb `Thoughts, comments or concerns left with their tip submission.`, is **not called** from these routes.)

#### 3.2.10 Shared tip pool (1304–1344)

`<h2>{cash icon} Shared tip pool</h2>`, then `.pool` split into `.pool-side` and `.pool-dist`.

**`.pool-side`:**
- `.pool-box.pool-cash`: `.pool-lbl` `Cash pool`; `.pool-amt` `money(poolCash)`; `.pool-parts` two spans — `` `You counted <b>${money(toCents(inp.pool.jar))}</b>` `` and `` `Staff reported <b>${money(poolCash - toCents(inp.pool.jar))}</b>` ``. (The second silently folds in the legacy `pool_togo_cents` column, which is not staff-reported. Harmless on new data, which is always 0.)
- `.pool-box.pool-card`: `To-go card pool`, `money(poolCard)`, same two spans against `inp.pool.togoCard`.
- `.pool-form` → `POST /shifts/:id/pool`:

| name | label | type | attrs | value | placeholder |
|---|---|---|---|---|---|
| `jar` | `Cash you counted` | `number` | `step="0.01" min="0"` | `(pool_jar_cents/100).toFixed(2)` when non-zero, else empty | `0.00` |
| `togo_card` | `To-go card you counted` | `number` | `step="0.01" min="0"` | `(pool_togo_card_cents/100).toFixed(2)` when non-zero, else empty | `0.00` |

Submit: `Save pool`. **Both fields are always written**, so submitting with one blank sets that column to 0.
- `<p class="pool-hint">Enter only what <b>you</b> counted — anything staff reported on the tips page is already added above.</p>`

**`.pool-dist`:**
- `.pool-lbl` = `Where it goes`, plus `` ` · split by hours across ${eligible.length}` `` when there is anyone.
- `eligible = r.support.filter(p => p.tipEligible !== false)`. **The engine's support result objects carry no `tipEligible` field** (engine.js:202–213), so this predicate is always true and the list includes `non_tipped` people, who will show `$0.00`. Preserve the visible behaviour or fix it explicitly; do not change it by accident.
- Per person `.dist-row`: `.dist-who` = name + `<i>{role} · {hours}h</i>`; `.dist-amt` = `money(p.poolCash + p.poolCard)`.
- Empty: `Nobody eligible on this shift yet — add support staff and the pool will split across them.` in `.panel-empty`.
- If pool > 0 and nobody eligible: `<div class="dist-warn">{money(poolCash+poolCard)} in the pool with nobody to receive it.</div>`

#### 3.2.11 Submissions (1420–1423 + `submissionsPanel`, 1114–1163)

The section wrapper emits `<h2>{recurring icon} Submissions</h2>`, and `submissionsPanel()` then emits **a second `<h2>Submissions …</h2>`**. The heading is currently duplicated. Decide deliberately.

Rows: `submissions.forShift` = every `tip_submissions` row for the shift, `ORDER BY created_at DESC, id DESC`.

**Empty:** `<h2>Submissions</h2>` + `<p class="muted">Nothing submitted yet. Every entry staff make on the tips page — and every change you make here — is recorded, so a corrected figure never hides what it replaced.</p>`

**Populated:** `<h2>Submissions <span class="sec-n">{rows.length}</span></h2>` then `<p class="muted">Newest first. …</p>` where the tail is either `` `<b>${dupes}</b> ${dupes===1?'entry was':'entries were'} later replaced — open one to see what it said.` `` or `Nothing has been resubmitted.` (`dupes` = non-imported rows minus distinct non-imported employees.)

Each row: `<details class="sub[ sub-old]">` — `sub-old` on every row after the first for that employee.
- `.sub-dot` with `sub-imp` / `sub-mgr` / `sub-staff` by `source`.
- `.sub-who` name, `.sub-role` role (may be blank).
- `.sub-tag`: `on file before logging started` (imported) / `you edited` (manager) / `submitted` (staff).
- `.sub-cur` `current` for the newest per employee, else `.sub-sup` `superseded`.
- `.sub-when`: imported rows show `created_at.slice(0,10)` (date only, since the timestamp is synthetic); others `created_at.replace('T',' ').slice(0,16)`.
- Body: `.sub-figs` of the non-null figures among `Cash`, `Card`, `Food`, `Coffee`, `Alcohol`; or `<div class="panel-empty">No figures in this entry.</div>`. Then the note if any. Then, for imported rows: `Reconstructed from what this shift currently holds. Anything it replaced was overwritten before submissions were logged and can't be recovered.`

#### 3.2.12 Danger zone (1425–1432)

- `<b>Delete this shift</b>`
- `<p class="muted">Removes the shift and everyone's hours, sales and tips on it. Emails already sent can't be recalled.</p>`
- Form → `POST /shifts/:id/delete`, `onsubmit` confirm: `` `Delete the ${sh.date} ${dp(daypart)} shift and all ${Object.keys(entries).length} entries on it? This cannot be undone.` `` — the count is the number of `work` rows.
- `<button class="btn btn-danger" type="submit">Delete shift</button>`

#### 3.2.13 Sticky bar (1434–1442)

`position: sticky; bottom: 0` (styles.css:1114). Contents:
- `<b>{sh.date} · {dp(daypart)}</b>`
- `<span>` = `` `${warn.length} to sort out` `` or `Nothing outstanding`, then ` · `, then `` `${withHours}/${people.length} hours in` ``
- `<a class="btn btn-primary" href="/shifts/{id}/results">Preview &amp; send →</a>`

---

## 4. Every POST route

**Every one of these is gated only by the global middleware (server.js:153–179).** None contains a `canWrite()` check of its own. See §7.

### 4.1 `POST /shifts` (1081–1088)

- **Accepts:** `date`, `daypart`.
- **Validates:** `!date || !DAYPARTS.includes(daypart)` → redirect `/shifts/new?err=1&msg=Pick%20a%20date%20and%20service.` The date string itself is never parsed or range-checked.
- **Writes:** `INSERT OR IGNORE INTO shifts (date, daypart)` — an existing shift is silently reused, no error, no duplicate (`UNIQUE(date, daypart)`). Then `policyForShift(sh)` stamps the current policy version.
- **Redirects:** `/shifts/{id}`.
- **Flash:** none on success; `Pick a date and service.` with `err=1` on failure.

### 4.2 `POST /shifts/:id/delete` (1505–1510)

- **Accepts:** nothing but the id.
- **Validates:** shift exists, else `404` with an empty body.
- **Writes:** `s.deleteShift` — a transaction (db.js:292–300) deleting `server_sales`, `work`, `tip_submissions`, then the `shifts` row. `tip_submissions` has no FK, so it is deleted explicitly.
- **Redirects:** `/shifts`.
- **Flash:** `` `Deleted the ${sh.date} ${dp(daypart)} shift and everything on it.` ``

### 4.3 `POST /shifts/:id/server` (1544–1557)

- **Accepts:** `employee_id`, `food`, `coffee`, `alcohol`, `card_tips`, `hours`, `wage`, and (only from the in-card editor) `cash_tips`.
- **Validates:** shift exists, else `404`. Nothing else. `employee_id` goes through `Number()` with no check.
- **Writes:**
  1. `w.upsertWork` with `role: 'server'` (hard-coded — this route always files the person as a server), `hours: Number(hours) || 0`, `hourly_rate_cents: toCents(wage)`. Upsert on `(shift_id, employee_id)` overwriting role, hours, rate.
  2. `w.upsertSales` with food/coffee/alcohol/card_tips, each `toCents(...)` → **blank becomes 0**.
  3. `writeTipsIfGiven` (1515–1523): only when the key is present **and** non-blank after trim. `cash_tips` → `w.setCashTips` with `cash_entered_by = 'manager'`; `card_tips` → `w.setCardTips` (a second write of the same value). An explicit `0` **does** write.
  4. `logManagerEdit` (1530–1542): appends a `tip_submissions` row with `source: 'manager'` and `note: null`, but only if at least one of `cash_tips`, `card_tips`, `food`, `coffee`, `alcohol` was supplied non-blank. Unsupplied figures are stored as `NULL`.
- **Redirects:** `/shifts/{id}?msg=Server%20saved.`
- **Flash:** `Server saved.`

### 4.4 `POST /shifts/:id/support` (1559–1570)

- **Accepts:** `employee_id`, `role`, `hours`, `wage`, and (from the in-card editor) `cash_tips`, `card_tips`.
- **Validates:** shift exists, else `404`. `role` is **not validated against `shiftRoles()`** — whatever string arrives is written to `work.role` (NOT NULL, so a missing `role` raises a DB error → unhandled 500).
- **Writes:** `w.upsertWork` (role from body), then `writeTipsIfGiven`, then `logManagerEdit` with the body's role.
- **Redirects:** `/shifts/{id}?msg=Support%20saved.`
- **Flash:** `Support saved.`

### 4.5 `POST /shifts/:id/remove` (1572–1575)

- **Accepts:** `employee_id`.
- **Validates:** nothing. **Does not check that the shift exists** and uses `req.params.id` as a raw string.
- **Writes:** `DELETE FROM work WHERE shift_id = ? AND employee_id = ?`. `server_sales` and `tip_submissions` for that person are **left behind** — their sales/tips rows survive and are re-attached if they are added back.
- **Redirects:** `/shifts/{id}?msg=Removed.`
- **Flash:** `Removed.`

### 4.6 `POST /shifts/:id/pool` (1577–1580)

- **Accepts:** `jar`, `togo_card`.
- **Validates:** nothing; no existence check.
- **Writes:** `UPDATE shifts SET pool_jar_cents = @jar, pool_togo_card_cents = @togo_card WHERE id = @id`. Both always written; blank → 0. The legacy `pool_togo_cents` column is never touched here.
- **Redirects:** `/shifts/{id}?msg=Tip%20pool%20saved.`
- **Flash:** `Tip pool saved.`

### 4.7 `POST /shifts/:id/read-report` — see §5.

### 4.8 `POST /shifts/:id/send-one` and `POST /shifts/:id/send` — see §6.

---

## 5. The AI photo import — `POST /shifts/:id/read-report` (1583–1619)

### 5.1 The control (1375–1382)

Inside the Servers section, above the person cards: `<details class="add-panel">` with summary `📸 Read from a report photo`.

Blurb: `Snap the end-of-day report (several photos OK). It fills in each server's sales + card tips below for you to check.` — when `process.env.ANTHROPIC_API_KEY` is unset, ` <b>Needs an ANTHROPIC_API_KEY in .env first.</b>` is appended and **both the file input and the submit button get `disabled`**.

Form: `enctype="multipart/form-data"`, class `card form photo-form`.
- `<label>Photo(s) <input type="file" name="photos" accept="image/*" multiple></label>`
- `<button class="btn" type="submit">Read photo</button>`

### 5.2 Upload limits

`reportUpload = multer({ storage: memoryStorage, limits: { fileSize: 20 * 1024 * 1024 } })` (server.js:34), applied as `.array('photos', 12)`. So: **max 12 files, max 20 MB each, held in memory** (never written to disk). Exceeding either limit throws a `MulterError`; **there is no Express error-handling middleware in this app**, so it surfaces as the default 500 stack page, not a flash.

### 5.3 What it does

1. 404 if the shift is missing.
2. `if (!files.length) return back('Attach at least one photo.', true)`.
3. `readReport(files)` (reader.js:48–96): one Anthropic `messages.create` call, model `process.env.READER_MODEL || 'claude-opus-4-8'`, `max_tokens: 4096`, `output_config.format` = a JSON schema requiring `servers[]` of `{name, food, coffee, alcohol, card_tips}` plus optional `reported_total_tips`. Images are base64-inlined; MIME is passed through for png/webp/gif, everything else is sent as `image/jpeg`. The prompt tells the model to exclude subtotal/header/grand-total rows and to merge multiple images as pages of one report. **No timeout is set on this call** (unlike the invoice reader).
4. Name matching (1598–1613) against `q.nonManagerList` (active, non-manager): exact case-insensitive full-name match first, then first-word-of-name match (requiring the extracted name to be non-empty).
5. For each match:
   - `w.insertWorkIfAbsent` with `role: 'server'`, `hours: 0`, `rate: 0` — `ON CONFLICT DO NOTHING`, so **an existing person's role and hours are never clobbered**.
   - `w.upsertSales` with food/coffee/alcohol/card_tips — this **does overwrite** existing sales and card tips.
   - Cash tips are never touched. No `tip_submissions` row is written (this is not logged as a manager edit).

### 5.4 What the user sees

All feedback is a single flash on `/shifts/{id}`:

- Matches found: `` `Read ${n} server(s): ${names.join(', ')}. Check the numbers below, then send.` ``
- No matches: `No servers could be matched from the photo.`
- Any unmatched names appended: `` ` Couldn't match: ${names.join(', ')} (add them under Staff or fix the spelling).` `` — unnamed rows appear as `(unnamed)`.
- `err=1` is set when `matched.length === 0`.

### 5.5 Failure surfaces

`readReport` throws → `` `Could not read the photo — ${e.message}` `` with `err=1`. Messages come from reader.js:79–83 and 90–94:
- `No ANTHROPIC_API_KEY set — add one to .env to enable photo reading.`
- 401 → `the API key was rejected. Check ANTHROPIC_API_KEY.`
- 400 mentioning "model" → `` `the model "${MODEL}" rejected the request (${detail}). Try removing READER_MODEL to use the default.` ``
- 429 → `rate limited — wait a moment and try again.`
- 413 / "too large" → `the photo is too large. Try one page at a time.`
- unparseable JSON → `The model did not return readable numbers — try a clearer photo.`
- anything else → the raw API detail string.

There is **no progress indicator** — the request blocks until the model answers, then redirects.

---

## 6. Email and sending

### 6.1 `GET /shifts/:id/results` (1676–1757)

404 → `layout('Not found', '<h1>Shift not found</h1>')`.

DOM order:
1. `flash(req)`
2. `<a class="back" href="/shifts/{id}">← Back to entry</a>`
3. `.page-head`: `<h1>{date} · {dp(daypart)}</h1>`, `<p class="sub">Tip-out results — review, then send everyone their email.</p>`, and a `POST /shifts/:id/send` form whose button reads `✉ Send emails to all` when `mailStatus().ready`, else `✉ Generate previews`.
4. Warnings, if any: `<div class="flash flash-warn"><b>Before you send:</b><ul>…</ul></div>`.
5. Notes, if any: `<div class="flash flash-info"><ul>…</ul></div>`.
6. `.stats` tiles: `Total tips collected` = `money(r.reconciliation.totalTipsCollected)`; then one tile per role pot with a non-zero balance, labelled `` `${role} pool` `` (raw slug, lowercase); then `Jar + to-go pool` = `money(r.pool.total)` when non-zero.
   - Note `r.pool.total` counts only buckets actually paid out to somebody; an unclaimed bucket is reported through `orphanedPots` instead.
   - Lines 1732–1734 build `potTiles` and `poolTile` variables that are **never used** — the stats block recomputes them inline. Dead code.
7. `<h2>Servers</h2>` → `.cards`, or `<p class="muted">None.</p>`
8. `<h2>Support</h2>` → `.cards`, or `<p class="muted">None.</p>`
9. `.send-bar`: the same send form (button `Send emails to all staff` / `Generate email previews`) plus `<span class="muted">` reading `Sends now to everyone with an email.` or `No mail configured yet — this writes preview files you can open.`

**Server card:** `.card-head` with name and `<span class="pill">server · {hours}h</span>`; `Total tips` = `money(p.totalTips)`; `.kv.sub` `tip-out` = `-{money(p.tipoutTotal)}`; `.kv.total` `Keeps` = `money(p.tipsKept)` in `.pos`; then the send row.

**Support card:** name and `<span class="pill">{role} · {hours}h</span>`; `Tip-out (paycheck)` = `money(p.tipShare)` only when non-zero; one line per non-zero payout bucket using `poolLbl` — `weekly_cash` → `Pool (weekly cash)`, `paycheck` → `Pool (paycheck)`, `nightly_cash` → `Pool (cash tonight)`, unknown → `Pool`; `.kv.total` `Total` = `money(p.tipShare + p.poolShare)`; then the send row.

**Send row** (1688–1707), two variants:
- No email on file: `<div class="card-send card-send-none">` with `<span title="Add an address under Staff">No email on file</span>` and `<a class="btn btn-sm" href="/employees">Add it</a>`.
- Has email: `.send-to` showing the address (also as `title`), then `<a class="link" href="/shifts/{id}/email/{empId}" target="_blank">Preview</a>` and a `POST /shifts/:id/send-one` form with hidden `employee_id` and a `<button class="link">Send</button>`, confirm text `` `Send ${name} their summary again?` ``.

### 6.2 `GET /shifts/:id/email/:employeeId` (1760–1769)

Renders the **real email HTML** raw into the browser — no app chrome, no layout. Runs the engine, builds every email, picks the one whose `employeeId` matches (string comparison). 404 plain text `Shift not found` or `No email for that person on this shift`. This is a pure read (apart from the policy stamp).

### 6.3 What an email contains

`buildEmails(results, {date, daypart}, peopleMap)` (email.js:265–277) produces **one email for every server and every support person in the engine output**, whether or not they have an address. `peopleMap` (1624–1628) supplies `email`, `hourlyRate`, `salaried`.

**Server email** (`serverEmail`, email.js:68–117): subject `` `${RESTAURANT}: your ${date} ${daypart} summary — ${fmt(tipsKept)} in tips` ``; hero `Tips you keep`; rows `Date`, `Hours worked`, then `Pay`/`Salaried` or `Estimated wage`; sections `Your sales` (Food always, Coffee/Alcohol only when non-zero), `Your tips` (Card, Cash, `Total tips collected`), `Tip-out` (one line per role charged, or `No tip-out`; a hint sentence naming roles that were not staffed; `Tips you keep`), and `How this reaches you` (`Cash you took home tonight`, then `Added to your next paycheck` or `Adjusted from your next paycheck` with an explanatory paragraph when the adjustment is negative).

**Support email** (`supportEmail`, email.js:120–144): subject `` `${RESTAURANT}: your ${date} ${daypart} summary — ${fmt(total)} in tips` ``; hero `Total tips`; rows `Date`, `Role`, `Hours worked`, wage; section `Your tips` with `Cash tips`, `To-go card tips`, `Server tip-out (card)`, `Total tips`.

Both share `shell()` with the footer `This is a summary, not a pay stub — final amounts are set in payroll.`

### 6.4 `sendEmails` (email.js:373–412)

Returns `{sent, previewed, files, errors, recipients}`.

- **No transport** (`mailStatus().ready === false`): writes `previews/{name-slugified}.html` for every email, increments `previewed`, records the recipient. Nothing is sent. Note the filename is derived from the person's **name**, so two staff with the same slugified name overwrite each other.
- **Transport present**: `t.verify()` first — a failure pushes **one** friendly error and returns immediately with `sent: 0` (deliberate, so a bad password does not produce eight identical errors). Otherwise per email: missing `to` → `errors.push('{name}: no email on file')`; send failure → `errors.push('{name}: {friendly message}')`.

`mailStatus()` (email.js:288–306) resolves Gmail first (`GMAIL_USER` + a whitespace-stripped `GMAIL_APP_PASSWORD`), then SMTP (`SMTP_HOST` + `SMTP_USER` + `SMTP_PASS`), else `{ready:false, mode:'none'}`.

### 6.5 `POST /shifts/:id/send-one` (1777–1795)

- **Accepts:** `employee_id`. 404 if the shift is missing.
- Runs the engine, builds all emails, picks the match.
- **Does not change shift status.**
- **Redirects:** `/shifts/{id}/results` with a flash:

| Case | Message | `err` |
|---|---|---|
| not on the shift | `That person is not on this shift.` | yes |
| no address | `` `${name} has no email address. Add one under Staff, then send again.` `` | yes |
| send failed | `` `Could not send to ${name}: ${errors[0]}` `` | yes |
| sent | `` `Sent ${name}'s summary to ${to}.` `` | no |
| preview mode | `` `Mail isn't connected, so ${name}'s email was written as a preview file instead.` `` | **yes** (`!out.sent`) |

### 6.6 `POST /shifts/:id/send` (1797–1824)

- **Accepts:** nothing. 404 if the shift is missing.
- Runs the engine, builds every email, calls `sendEmails`.
- **`s.markEmailed.run(sh.id)` runs unconditionally** (1804) — before the manager copy, regardless of errors, and even in preview mode. This is the only state transition into `Sent`.
- Manager receipt: `managerEmail()` (1772–1775) = the first **active** employee with `role = 'manager'` and a non-null email (ordered by role then name), else `MAIL_FROM`, else `GMAIL_USER`, else `null`. If found, `managerShiftEmail(...)` builds a receipt (shift, delivered count, a `Did not go out` section, `Tonight` totals, per-server and per-support lines, and a `Worth checking` section carrying the same warnings from the results page) and sends it as a separate `sendEmails([...])` call, wrapped in `try { } catch { }` so a failure here can never affect the staff send.
- **Redirects:** `/shifts/{id}/results` with:
  - `result.sent > 0`: `` `Sent ${sent} emails.` `` + `` ` ${n} failed.` `` if any + `` ` A copy went to ${to}.` `` if there is a manager address.
  - otherwise: `` `Wrote ${previewed} preview files to /previews (open them to see each email).` ``
  - `&err=1` when `result.errors.length`.
  - **Edge case:** a configured transport whose `verify()` fails yields `sent: 0, previewed: 0`, so the flash reads `Wrote 0 preview files to /previews (open them to see each email).` with `err=1` — misleading, and worth fixing in a redesign.

---

## 7. Permissions

### 7.1 The gate (server.js:153–179)

Applied to every request:

1. If `APP_PASSWORD` is unset → **everything is open**, no user, and every page carries the `openWarning()` banner: `⚠️ **No password set.** Anyone with this link can see payroll and staff data. Set `APP_PASSWORD` to lock it down.` (views.js:330–331). `canWrite()` returns `true` for a null user, so this is the local-development default.
2. `OPEN_PATHS` (150–151) does **not** include `/shifts`.
3. No user + GET → redirect `/login?next=…`. No user + non-GET → `401` plain text `Session expired — reload and sign in again.`
4. **`if (user.role === 'viewer' && req.method !== 'GET') return res.status(403).send('Your account is view-only.')`** — a raw text response, no layout, no flash, no redirect back.
5. Feature gate: `/shifts*` resolves to the area key **`shifts`** (nav.js:23). An account with a non-empty `features` list that omits `shifts` gets, on GET, a 403 page — `You don't have access to this area` / `` `Ask ${RESTAURANT} to turn it on for your account.` `` / `Back to the dashboard` — and on non-GET, plain text `Not available on your account.` The master/owner account and any account with an empty feature list bypass this.

### 7.2 What a viewer sees and cannot do

`canWrite()` (views.js:73–76) returns `false` only for `user.role === 'viewer'`.

Rendered for viewers on every page: `viewerNote()` (views.js:334–335) — `**View only.** You can see everything here and change nothing. Ask the owner if you need to edit.` — plus the top bar's `＋ New` menu is hidden (views.js:122).

**The only Shifts-specific `canWrite()` check is at server.js:1026**, hiding the `＋ Log a shift` button in the list header.

A viewer therefore **sees, fully rendered and enabled**:

- The empty-state hero's `＋ Log a shift` button (1018)
- The whole of `GET /shifts/new` including the `Start` button
- Every `Edit` and `Remove` button on every person card
- Both add panels (`Save server`, `Save support`)
- The photo-import panel and `Read photo` button
- The pool form and `Save pool`
- `Delete shift` in the danger zone
- The results page's `✉ Send emails to all`, per-person `Send`, and `Send emails to all staff`

Every one of those, on submit, produces the bare 403 text page `Your account is view-only.` with no way back except the browser's back button. **If the redesign is meant to keep the current behaviour, note it explicitly; if it is meant to fix it, `canWrite()` needs to wrap all of the above and each POST route needs its own guard.**

A viewer **can** do: read the list, all filters and search (client-side only), the workspace, the results page, and open individual email previews at `/shifts/:id/email/:employeeId`. Note that a viewer opening an unstamped shift still causes the policy stamp write (§1.4), because that happens inside a GET.

---

## 8. Every user-facing string, by screen

### 8.1 `GET /shifts`

Headings and copy: `Shifts` · `` `${n} logged. Staff submissions start a shift on their own.` `` · `Where every service gets closed out.`

Buttons and controls: `＋ Log a shift` · `Search a date, month or service…` · `All` · `Café` · `Dinner` · `Open` · `Needs review` · `Ready` · `Sent` · `Continue →` · `→`

KPI labels: `Sales this month` · `Avg sales a shift` · `Avg wage cost a shift` · `Sales per labor hour`

KPI sub-lines: `` `across ${n} shift(s)` `` · `nothing logged yet` · `nothing to average yet` · `` `÷ ${k} shift(s) with figures` `` · `total sales ÷ shifts` · `no wages logged yet` · `` `${n} without a wage set` `` · `` `${p}% of sales · no tips` `` · `wages only, no tips` · `` `sales ÷ ${h} hrs worked` `` · `no hours logged`

Status labels: `Sent` · `Open` · `Nobody on it` · `Needs review` · `Ready to send`

Today card: `` `Today · ${service}` `` · `` `${n} on shift · ${a}/${b} hours in` `` · `` ` · ${n} note(s)` ``

Attention: `` `${n} thing(s) to sort out` `` · `Worth knowing` · `Everything's closed out` · `No open shifts and nothing waiting on you.` · `` `${when} — nobody on it yet` `` · `` `${when} — ${n} person has|people have no hours entered` `` · `` `${when} — everything's in, ready to send` `` · `` `${when} — ${n} note(s) from staff` ``

Month header: `` `${n} shift(s)` `` · `` `${money} tips` `` · `` `${n} hrs` `` · `` `${n} not sent` `` · `all sent`

Row labels: `Sales` · `Tips` · `Hours` · `Staff`

Empty states: `Nothing matches` / `Try a different search or filter.` — `No shifts logged yet` / `A shift starts itself the moment a staff member submits their tips — or start one here and enter it yourself.`

### 8.2 `GET /shifts/new`

`← Shifts` · `Log a shift` · `Pick the day and which service (café or dinner). You'll enter sales, tips & hours next.` · `Date` · `Service` · `Café` · `Dinner` · `Start`

Flash: `Pick a date and service.`

### 8.3 `GET /shifts/:id`

Chrome: `← Shifts` · `Shift not found` · `` `${date} · ${service}` ``

Status: `Emails sent` · `Needs review` · `Ready to send` · `` `${n} on shift` `` · `` `${r} of ${n} ready` `` · `` `${a}/${b} hours in` `` · `` `${a} of ${b} have hours entered` `` (tooltip)

Attention: `` `${n} thing(s) to sort out` `` · `Worth knowing` · `Everything checks out` · `Hours are in for everyone, tips reconcile, and nobody is missing an email. This shift is ready to send.` — plus every warning in the table at §3.2.4.

KPIs: `Server sales` · `` `${n} server(s)` `` · `Tips collected` · `card + cash` · `Shared pool` · `` `${money} cash · ${money} card` `` · `To sort out` · `see above` · `nothing outstanding`

Sections: `Servers` · `Support` · `Tips they logged go into the shared pool and split by hours — not kept by whoever reported them.` · `Notes from staff` · `Shared tip pool` · `Submissions`

Person-card states: `Ready` · `Needs hours` · `Needs cash tips` · `Needs sales` · `Needs email`

Person-card figures: `Food` · `Coffee` · `Card tips` · `Cash tips` · `To-go card` · `Hours` · `Wage` · `not in` · `none` · `—` · `default` · ` · salaried` · `server`

Person-card actions: `Edit` · `Remove` · `Save` · `Cancel` · confirm `` `Take ${name} off this shift?` ``

Panels: `📸 Read from a report photo` · `Snap the end-of-day report (several photos OK). It fills in each server's sales + card tips below for you to check.` · `Needs an ANTHROPIC_API_KEY in .env first.` · `Photo(s)` · `Read photo` · `＋ Add a server / edit their numbers` · `Server` · `Food sales` · `Coffee sales` · `Alcohol sales` · `Card tips` · `Hours` · `Wage/hr` · `staff default` (placeholder) · `Save server` · `＋ Add support staff / edit their numbers` · `Employee` · `Role` · `Save support`

Empty states: `No servers on this shift yet. They appear here when they submit, or add one below.` · `Nobody yet. Kitchen, baristas and bussers appear here when they submit, or add them below.`

Pool: `Cash pool` · `To-go card pool` · `You counted` · `Staff reported` · `Cash you counted` · `To-go card you counted` · `Save pool` · `Enter only what **you** counted — anything staff reported on the tips page is already added above.` · `Where it goes` · `` ` · split by hours across ${n}` `` · `Nobody eligible on this shift yet — add support staff and the pool will split across them.` · `` `${money} in the pool with nobody to receive it.` ``

Submissions: `Submissions` · `Nothing submitted yet. Every entry staff make on the tips page — and every change you make here — is recorded, so a corrected figure never hides what it replaced.` · `Newest first.` · `` `${n} entry was|entries were later replaced — open one to see what it said.` `` · `Nothing has been resubmitted.` · `on file before logging started` · `you edited` · `submitted` · `current` · `superseded` · `Cash` · `Card` · `Food` · `Coffee` · `Alcohol` · `No figures in this entry.` · `Reconstructed from what this shift currently holds. Anything it replaced was overwritten before submissions were logged and can't be recovered.`

Danger zone: `Delete this shift` · `Removes the shift and everyone's hours, sales and tips on it. Emails already sent can't be recalled.` · `Delete shift` · confirm `` `Delete the ${date} ${service} shift and all ${n} entries on it? This cannot be undone.` ``

Sticky bar: `` `${n} to sort out` `` · `Nothing outstanding` · `Preview & send →`

Flashes: `Server saved.` · `Support saved.` · `Removed.` · `Tip pool saved.` · `Attach at least one photo.` · `` `Could not read the photo — ${detail}` `` · `` `Read ${n} server(s): ${names}. Check the numbers below, then send.` `` · `No servers could be matched from the photo.` · `` ` Couldn't match: ${names} (add them under Staff or fix the spelling).` `` · `(unnamed)`

### 8.4 `GET /shifts/:id/results`

`← Back to entry` · `Shift not found` · `` `${date} · ${service}` `` · `Tip-out results — review, then send everyone their email.` · `✉ Send emails to all` · `✉ Generate previews` · `Before you send:` · `Total tips collected` · `` `${role} pool` `` · `Jar + to-go pool` · `Servers` · `Support` · `None.` · `` `server · ${h}h` `` · `Total tips` · `tip-out` · `Keeps` · `Tip-out (paycheck)` · `Pool (weekly cash)` · `Pool (paycheck)` · `Pool (cash tonight)` · `Pool` · `Total` · `No email on file` · `Add an address under Staff` (tooltip) · `Add it` · `Preview` · `Send` · confirm `` `Send ${name} their summary again?` `` · `Send emails to all staff` · `Generate email previews` · `Sends now to everyone with an email.` · `No mail configured yet — this writes preview files you can open.`

Flashes: see §6.5 and §6.6.

### 8.5 `GET /shifts/:id/email/:employeeId`

Plain-text 404s: `Shift not found` · `No email for that person on this shift`

---

## 9. Interactive behaviour (client-side JS)

### 9.1 List page (1032–1062)

An IIFE holding three variables: `q` (lowercased search text), `mode` (`'all' | 'service' | 'status'`), `val`.

`apply()`:
- Walks every `[data-month]` group, and inside it every `[data-shift]` row.
- Match rule: `mode === 'all'` → true; `mode === 'service'` → `data-service === val`; otherwise `data-status === val`. Then, if matched **and** `q` is non-empty, additionally requires `data-search.indexOf(q) !== -1` (substring, not fuzzy, not word-boundary).
- Sets `el.style.display = ok ? '' : 'none'` and counts.
- Hides a whole group when it has zero visible rows.
- **Force-opens** a group (`g.open = true`) when it has visible rows **and** a search or non-`all` filter is active. It never re-closes groups when the filter is cleared — a group opened by a search stays open.
- Toggles `#snone` (`Nothing matches`) on the total visible count.

Bindings: `input` on `#ssearch` (fires on every keystroke, no debounce); `click` on every `.fchip` — removes `.on` from all chips, adds it to the clicked one (strictly single-select), then re-applies.

The year tabs are **not** client-side; each is a full navigation to `/shifts?y=…`.

Nothing here is persisted — reloading resets to `All` with an empty search and only the newest month expanded.

### 9.2 Workspace (1444–1501)

**`ENTRIES`** — a JSON object injected inline, keyed by `employee_id`, built from `w.workForShift` joined to `w.salesForShift` (1270–1280). Each value: `{role, hours, wage, food, coffee, alcohol, card_tips, cash_tips}`. Money fields are dollar strings via `d(c) = c ? (c/100).toFixed(2) : ''` — **a genuine zero serialises as `''`, indistinguishable from unset.** `hours` is `row.hours || ''`.

**Add-a-server prefill** (1447–1455): on `change` of `#server-emp`, and once on load, copies `food`, `coffee`, `alcohol`, `card_tips`, `hours`, `wage` from `ENTRIES[selected]` into `#server-form`, clearing any field the entry lacks. This is what makes "re-adding = editing" work and what protects existing figures from being zeroed by the always-writes POST.

**Add-support prefill** (1456–1466): on `change` of `#support-emp`, and once on load, sets `#support-role` to `ENTRIES[id].role`, else the option's `data-role` attribute, else leaves it; then copies `hours` and `wage`. It does **not** touch cash/card tips (there are no such fields on that form). The `data-rate` attribute emitted on every option (1281) is never read by any script — dead markup.

**`startEdit(emp, kind)`** (1471–1487):
- Finds `.pcard[data-emp][data-kind]`, adds class `pcard-editing` (a 2px primary ring, styles.css:1055).
- Replaces the inner HTML of **every `[data-edit]` cell** on that card with the original `<span>` label plus `<input class="cell-in" data-f="{key}" type="number" step="{data-step}" min="0" placeholder="{data-ph}" value="{ENTRIES[emp][key] ?? ''}">`.
- Replaces `.pcard-act` with `Save` (primary) and `Cancel`. **Cancel is `location.reload()`** — a full page reload, discarding any other card mid-edit and any unsaved add-panel input.
- Focuses the first `.cell-in`.
- Multiple cards can be put into edit mode at once; only the one whose `Save` is pressed is submitted.

**`saveEdit(emp, kind)`** (1488–1500):
- Builds a detached `<form method="post">` targeting `/shifts/{id}/server` or `/shifts/{id}/support`.
- Adds `employee_id`, then one hidden field per `.cell-in` named by its `data-f`.
- For a **server**: additionally adds `alcohol` = `ENTRIES[emp].alcohol || 0` — because alcohol is not shown on the card and `upsertSales` would otherwise zero it. Note this means the value posted is the string `"0"` when alcohol was blank, which is non-blank, which means `logManagerEdit` **always** fires for a server card edit.
- For **support**: additionally adds `role` = `ENTRIES[emp].role`, preserving the role that `upsertWork` would otherwise overwrite. If the person somehow has no ENTRIES record, this posts an empty role and the NOT NULL constraint fires.
- Appends the form to `<body>` and submits — a full navigation, not fetch. Nothing recalculates live; every figure on the page is server-rendered and only updates after the round trip.

**There is no live recalculation anywhere in this module.** The pool split, the KPIs, the tip-out results and the person states are all computed server-side per request.

**Confirm dialogs** are native `confirm()` on three controls: Remove (per person), Delete shift, and per-person Send on the results page. Note the escaping at 1261 and 1701: `esc(name).replace(/'/g, "\\'")` — a name containing a single quote is handled; a name containing a backslash is not.

---

## 10. Edge cases

**No staff on file.** `staffOptions` is empty, producing `<select required>` with zero options in both add panels. The browser blocks submission (value `""` fails `required`), so the forms are dead ends with no explanatory message. If a submit does get through (scripted, or `required` stripped), `Number('')` is `NaN`, which SQLite binds as NULL against a NOT NULL foreign key → unhandled 500. The photo import likewise matches nobody and flashes `No servers could be matched from the photo.` with `err=1`.

**No sales entered.** `shiftSales` falls back to `server_sales` and then to 0. Tip-out bases evaluate to 0, so servers keep everything and `shiftWarnings` emits `` `No sales recorded for: …` `` for anyone who has tips but no sales. The list KPI averages exclude the shift entirely (it is not in `counted`), and `Sales per labor hour` shows `—` if no hours exist either. The results page still renders every card, all at `$0.00`.

**A shift already sent.** State is `Sent`/`s-done` unconditionally. It disappears from the today block (`status !== 'emailed'`), from `openOnes`, and therefore from the attention panel; it counts toward `all sent` in its month header. The workspace remains fully editable and the delete button remains live — there is **no warning anywhere that you are editing a shift whose emails have gone out**. Pressing send again re-runs the engine on current data, re-sends to everyone, sends a second manager receipt, and re-marks the shift emailed. The workspace pill reads `Emails sent` but the sticky bar still reads `Preview & send →`.

**A shift with a policy version stamped.** The stamp is permanent for that shift and immune to later policy edits — that is the entire point of `policy_versions` (policy.js:3–5). Consequences a designer must not paper over: two shifts on the same day can compute under different rules; a shift stamped before the `splitJarFromToGoCard()` migration (policy.js:72–89) pays to-go card money as weekly cash rather than on the paycheck, which changes the `Pool (weekly cash)` vs `Pool (paycheck)` lines on the results page. If the stamped version row has been deleted, `policyForShift` silently re-stamps with the current version — the shift's math changes with no notice. **There is no UI anywhere in these routes showing which policy version a shift is on.**

**Deleting a shift with data.** One transaction wipes `server_sales`, `work`, `tip_submissions`, and the `shifts` row (db.js:292–300). The confirm dialog reports the number of `work` rows only — it does not mention submissions or sent emails, though the panel copy above it does (`Emails already sent can't be recalled.`). There is no undo (`flash()` supports `?undo=` but the delete route does not pass one). Preview files already written to `/previews` are left on disk.

**Other edges worth carrying forward:**

- **Removing a person leaves their money behind.** `POST /shifts/:id/remove` deletes only the `work` row; their `server_sales` row and `tip_submissions` history survive. Re-adding them restores their old sales and tips silently. Meanwhile the list's `tips` rollup — which sums `server_sales` without joining `work` — keeps counting a removed person's tips, so the row figure and the workspace disagree.
- **The `empty` state has no filter chip**, so `Nobody on it` shifts can only be found via `All` or search.
- **A shift with more than 12 open items** shows only the first 12 in the attention panel, with no "and N more" affordance.
- **A day with a lone salaried worker at 0 hours** reads `Needs review` on the list and `Ready` on the card (§3.2.1).
- **Non-tipped staff appear in the pool distribution list** at `$0.00` and are counted in `split by hours across N` (§3.2.10).
- **The list KPI row is always the current calendar month**, never the selected year (§2.4).
- **`GET` requests write.** Opening the workspace, the results page, or an email preview on an unstamped shift performs a `UPDATE shifts SET policy_id`. Any caching or prefetching added in a redesign must account for this.agentId: ac21ed9af41acad69 (use SendMessage with to: 'ac21ed9af41acad69', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 160430
tool_uses: 28
duration_ms: 479652</usage>