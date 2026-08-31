# ZWIN — The Staff area, in full

**Written 2026-08-31 for design work.** This describes what exists today: every
screen, every control, what each one does, and the rules behind them. It is a
description, not a proposal. Nothing here is aspirational.

ZWIN is a back-office web app for one restaurant, run by its owner from a laptop
and a phone. Server-rendered HTML, no client framework. Two stylesheets:
`broadsheet.css` (owner side) and `staff.css` (employee portal).

---

## 1. Where Staff sits

The left sidebar has sections. Under **RESTAURANT** sits the Staff group, whose
nav key covers three paths: `/employees`, `/staff-portal`, `/timeclock`. Its
sidebar entry is labelled **Staff**, blue (`#2563eb`), described as
"People, roles, wages and PINs."

Five screens make up the people side of the app:

| Screen | Path | What it is |
|---|---|---|
| **Staff** | `/employees` | The roster. Add people, see roles/wages/PINs at a glance |
| **Edit staff** | `/employees/:id/edit` | One person: everything about them |
| **Positions** | `/positions` | The jobs somebody can be put on a shift as |
| **Tip-out policy** | `/policy` | How tips are shared, per service, versioned |
| **Staff portal (admin)** | `/staff-portal` | The manager's side of what employees see |
| **Time clock** | `/timeclock` | Punches and timesheets (its own audit) |

---

## 2. `/employees` — the roster

### Layout, top to bottom

1. **Flash bar** — appears after any action. Green "Saved" or red "Refused",
   with the message and sometimes an Undo button.
2. **Page head** — `Staff` as an H1, and a subline reading
   *"N on the team · N servers · open anyone to set roles & wages."*
   Right-aligned: a primary button **＋ Add staff**, which jumps to `#add`
   further down the same page (it is an anchor, not a modal or a new page).
3. **PIN warning banner** — amber, only when there is something wrong. Two
   possible bullets, both shown if both apply:
   - **Same PIN** — names the people sharing one, and says neither can sign in
     until each has their own.
   - **No PIN yet** — names everyone without one, and says they cannot log tips.
   This exists because staff sign in to the tips page with a PIN alone, so a
   duplicate silently files one person's tips under another.
4. **Search box** — only rendered when there are more than 8 staff. Filters the
   table rows live, client-side, on any text in the row.
5. **The table** — columns: Name, Role, Wage, Email, PIN, and an unlabelled
   actions column.
   - **Name** — a coloured circular avatar with up to two initials, then the
     full name.
   - **Role** — a blue pill with their main role. If they hold extra roles, a
     small grey `+N` follows it.
   - **Wage** — `$15.00/h`, or a grey `salary` pill, or an em dash if unset.
   - **Email** — or an em dash.
   - **PIN** — masked as `••••`, or an em dash. The digits are never shown.
   - **Actions** — a single `edit` link to that person's page.
   - Empty state: *"No staff yet — add your first below."*
6. **Add staff** — an H2 anchor target, then a card containing a grid form:
   Name (required), Main role (select), Email, 4-digit PIN, Pay type
   (Hourly/Salary), Hourly wage, Benugin ID, and an **Add** button.
7. **Closing note** — *"Add the person first, then open them to set multiple
   roles & wages (e.g. server $11, busser $13) or mark them salaried."*

### Rules enforced on Add

- Name and role are required; missing either is refused with a red flash.
- A PIN is exactly 4 digits or nothing at all. Not truncated — refused, because
  the staff keypad submits when its cells fill, so a 5-digit PIN would lock the
  person out with no explanation.
- A PIN already in use is refused, naming who has it.
- A new employee is **added to every schedule** on creation. They can work
  their first shift, and their checkboxes say so; the manager narrows from there.

### Roles available

Every active position slug, plus `manager`. A `manager` is treated differently
in three places: excluded from the PIN warnings, cannot sign in to the portal,
and is who the daily summary email goes to.

---

## 3. `/employees/:id/edit` — one person

The densest screen in the area. Six sections down the page.

### 3.1 Back link and title
`← Staff` then `Edit <name>` as an H1.

### 3.2 The main card — a grid form posting to `/employees/:id`

| Field | Type | Notes |
|---|---|---|
| Name | text, required | |
| Main role | select | every active position + `manager` |
| Email | email | used for their pay summary |
| 4-digit PIN | numeric, 4 chars | pattern-enforced in the browser AND server-side |
| Pay type | select | Hourly / Salary |
| Default hourly wage | number | their rate when no role-specific one applies |
| **When does this wage start?** | fieldset | only shown for hourly staff — see 3.3 |
| Salary (if salaried) | number | per pay period |
| Benugin ID | text | ties them to the POS |
| Eligible for weekly overtime | checkbox | full-width row with an explanation; unticked = exempt. Only applies when weekly OT is on in Payroll |
| **Save changes** | primary button | |

### 3.3 The wage-start fieldset — the most designed control here

A bordered fieldset titled *"When does this wage start?"* with three radio
options, each a row of a bold label and a grey explanation:

1. **From today** *(preselected)* — "Shifts already worked keep the wage they
   were paid at."
2. **From a date** — "A raise that starts on a particular day — back-dated or
   ahead." A date input sits inline on the right of this row.
3. **All shifts, including past** — rendered in **red**. Its explanation counts
   the damage before it is chosen: *"Rewrites the rate on 62 worked shifts. For
   a wage that was typed wrong, not for a raise."* If they have no worked
   shifts it says so instead.

Behaviour: from-today and from-a-date leave history alone. A future date does
not move their current wage until it arrives. "All shifts" is the only option
that overwrites the rate recorded on shifts already worked.

### 3.4 Services — which schedules they are on

H2 **Services**, a grey explanation, then a row of **pill-shaped checkboxes**,
one per schedule ("Day Service", "Evening Service", …). A ticked pill takes a
dark border and heavier text. Beneath: a status line — *"Currently limited to
Day Service."* or *"Currently on every service."*

Membership is explicit. Only people ticked here appear on that schedule's board
and can clock into it. Unticking everything means they are on nothing.

### 3.5 Roles & wages

H2, a grey explanation, then a table:

| Column | Contents |
|---|---|
| Role | the position slug |
| Schedule | grey "Every schedule", or a **bold** schedule name for an override |
| Wage | `$15.00/h`, the override in bold |
| (actions) | a red `remove` link |

Override rows sit directly beneath the general row for the same role, so a
reader sees "server, every schedule, $15" then "server, Evening Service, $19".

Beneath, a card form: **Role** (select), **Schedule** (select: "Every schedule"
or "<name> only"), **Wage/hr**, the same when-does-this-start fieldset, and
**Add role & wage**.

Removing a schedule override removes only that override — the role and its
general wage stay, and no worked shift is repriced.

### 3.6 Wage changes — the audit trail

Only rendered if there have been dated changes. H2, an explanation, then:

| Effective from | Role | Wage | Option chosen | Changed | By |
|---|---|---|---|---|---|
| 2026-08-30 | default | $18.00/h | from today | 2026-08-31 03:54:21 | Owner |

A future date is marked `(upcoming)`. "Option chosen" records which radio was
selected. "Changed" is when the edit was made, which is a different fact from
when it takes effect.

### 3.7 Deactivate

A lone red link at the bottom: **Deactivate this person**, behind a browser
confirm reading *"Remove <name> from active staff? Their past shifts stay
intact."* Reactivation exists as a route but has no button on this page.

---

## 4. `/positions` — the jobs

Table: Position, Tips, What that means, Shifts used, and actions.

Three **kinds**, each with a fixed meaning that drives the tip-out engine:

| Kind | Pill | Meaning |
|---|---|---|
| Server | blue | Keeps their own tips and tips out to everyone else |
| Support | blue | Shares the tip-out pots and the shared pool, split by hours |
| Not tipped | amber | Hourly only — in no pool at all. Use for training |

Actions per row: `edit`, and `retire` (red) or `restore`. Retired rows render
muted with an `inactive` pill. Retiring keeps past shifts intact; it only stops
the position being offered for new ones.

Below the table: *"Retiring a position keeps past shifts intact — it just stops
appearing when you add someone new."* Then a collapsible **＋ Add a position**
panel.

---

## 5. `/policy` — tip-out policy

H1 **Tip-out policy**, then one section per service (e.g. "Dinner — how tips are
shared"), then **History**.

The critical rule: a tip-out is calculated against a **policy version**, not
today's settings. Each closed service pins the version it was settled under, so
changing the rules never restates what somebody was already paid. History lists
past versions; there is a revert.

---

## 6. `/staff-portal` — the manager's side of the employee app

Four tabs across the top:

1. **Floor reports** — out-of-stock reports from staff, with resolve/reopen.
2. **Specials & 86** — post a special, 86 an item, edit, put back, delete.
3. **Before-shift notes** — post/edit/delete a note staff see before a shift.
4. **Who submits tips** — per position, whether that position hands tips in.

The default tab is whichever has someone waiting on it.

---

## 7. What the employee sees (the other end of Staff)

The portal is a separate product on the same server, at `/portal/*`, signed into
at `/tips` with a 4-digit PIN on a keypad. Mobile-first, its own stylesheet, a
bottom tab bar: **Home · Time clock · Schedule · Pay · More**.

Staff data reaches them as:

- **PIN** → how they sign in at all.
- **Services** → which schedules they can see and clock into. On more than one,
  Schedule opens on a card picker first; on one, it opens straight in.
- **Roles & wages** → the rate on their own pay screen and shift breakdowns.
- **Positions** → what they can clock in as.
- **Email** → their pay summary.

---

## 8. Cross-cutting rules a designer should know

- **The PIN is the identity.** No PIN, no portal. A duplicate locks out both.
- **Money is integer cents; clock time is integer minutes.** `work.hours` is
  decimal hours and is the payroll boundary.
- **Deactivating never deletes.** Past shifts, punches and tip-outs stay exactly
  as they were. Reactivating restores only shifts still ahead of them.
- **A wage is (person, role, schedule, date).** Most specific wins, then most
  recent — a rate set for "server at Evening" beats "server anywhere" however
  old it is.
- **A rate recorded on a worked shift is what was paid.** Nothing overrules it
  except a deliberate "apply to all past shifts".
- **Schedule is a plan; Time Clock is what happened.** Nothing on the schedule
  ever implies attendance.
- **Permissions are per-area and enforced server-side.** Hiding a control is
  never the protection. A view-only account sees the pages and is refused every
  write.

---

## 9. Visual vocabulary used across these screens

- **Avatar** — a coloured circle with up to two initials.
- **Pill** — a rounded label. Blue for a role or a tipped position, amber for
  non-tipped, grey for a state like `salary` or `inactive`.
- **Card** — a bordered, rounded container; forms live in these.
- **Panel** (`.bs-panel`) — the house framed section. Panels never nest.
- **Flash bar** — green "Saved" / red "Refused" at the top of the page.
- **Table** — the roster, positions, roles and wage history all use one style,
  with `.num` for right-aligned figures and `.muted` for absent values.
- **Red is reserved** for a thing that cannot be undone or a state somebody must
  act on. `.bs *` sets `box-shadow: none !important`, so elevation on the owner
  side is drawn with borders and outlines, never shadows.
