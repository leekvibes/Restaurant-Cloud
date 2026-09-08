# The new tip-out model, and what it costs to build

**Status: PLAN ONLY. Nothing here is built.** Written 2026-09-07 against the
spec Malek supplied, for a dinner service opening on the 15th.

Everything marked *measured* was read out of the code or the database.

---

## The dates this has to survive

| | |
|---|---|
| **Sep 11** | Friends & family — nobody paying |
| **Sep 14** | Media night — nobody really paying |
| **Sep 15** | **First real dinner service** |
| **Sep 16** | Grand opening, dinner |
| **Sep 17** | **First daytime bartender** |

Two different deadlines hide in that list, and they want different things
built. The 15th needs correct percentages and the direct-service model. The
17th is the first day a bar and a coffee counter run *at the same time on the
same service*, which is when time-of-day eligibility starts to matter.

The 11th and 14th are genuinely useful: real staff, real clock-ins, real
tip-out arithmetic, and no money riding on the answer. That is a rehearsal you
cannot buy, and it argues for shipping early enough to use it.

---

## Part 1 — What already works

**Percentages and recipients are data, not code.** Rules live in
`policy_versions.rules_json`, one current version per service, edited as JSON.
Changing them needs no deploy. *Measured.*

**A settled service can never be restated.** `shifts.policy_id` pins the version
when the service opens. Historical services are safe by construction — the
"preserve finalized shifts exactly" requirement is already met and needs no
work. *Measured: the two closed dinner services still carry policy 2 and 5.*

**A tip-out is only charged if somebody worked the role.** `staffedRoles` is
built from the people actually on the service, and an unstaffed role's money
stays with the earner rather than being redirected. That is the spec's
"if no eligible recipient exists, leave it with the direct-service employee",
already true. *Measured.*

**Pot-to-pot tip-outs exist** as of 2026-09-05, which is how bartender→barback
works.

---

## Part 2 — What has to change

### 2.1 The percentages — trivial

Busser 2% of total sales · Bartender 10% of alcohol · Barista 1.5% of coffee ·
Kitchen 0%. Two JSON documents, one per service. **No code.** Ten minutes.

Note this deliberately removes: kitchen 1.5% of food, busser 13% of remaining,
and (café) barista 1.5% of coffee at the old rate. Café's current busser rule is
2% of gross sales, which already matches the new number.

### 2.2 Direct-service earners — the real structural change

**This is the one that changes the engine's shape.**

Today `shiftInputs()` decides who pays and who receives with a hardcoded string:

```js
if (row.role === 'server') { servers.push(...) } else { support.push(...) }
```

*Measured, `db.js:566`.* So a barista with $500 of sales and $100 of tips lands
in `support[]`, and their tips are **pooled with the whole house** — precisely
the behaviour the spec removes. A bartender working the bar is the same.

What is needed: **direct-service** becomes a property of the position, not the
literal string `server`. A barista or bartender who personally serves guests
keeps their tips after tip-outs, exactly as a server does.

The cleanest expression, given positions already carry `kind`:

- `kind = 'server'` → rename in meaning to **direct service** (keeps own tips,
  pays tip-outs). Server, bartender, barista become this.
- `kind = 'support'` → receives tip-outs, does not earn direct tips. Busser,
  barback.
- `kind = 'non_tipped'` → unchanged. Kitchen moves here.

The engine already handles multiple direct-service earners correctly — it loops
`servers[]`. What it cannot yet do is have the same person be a direct earner
*and* a tip-out recipient, which is exactly the bartender's position: they take
10% from servers **and** keep their own bar-seat tips. That is a real change to
`runShift`, not a rename.

### 2.3 The to-go / register pool

Two pools already exist — the cash jar and to-go card — and both currently pay
`all_support`. The spec wants a register pool shared by **barista and bartender
only**, excluding kitchen, servers and bussers.

`poolRecipients` gained named-role groups on 2026-09-05, so `among: 'bartender'`
works. What is missing is a **group of two roles**, e.g.
`among: ['barista', 'bartender']`. Small, contained.

### 2.4 Keeping the four money types apart

The spec is explicit: direct-service tips, support tip-outs, bartender pool
tips and register-pool tips must stay separately identifiable, in the data model
and on screen.

The engine already returns them separately — `tipShare`, `poolShares`,
`poolCash`, `poolCard`. What flattens them is the **presentation**: the emails
and the shift sheet mostly show a total. That is display work across the
preview/send screens, employee breakdowns and payroll summaries.

---

## Part 3 — Time-aware eligibility

This is the largest item by a wide margin, and it is the one to be honest about.

### The blocker

**A sale carries no time.** `server_sales` is
`PRIMARY KEY (shift_id, employee_id)` — one row per person per service, with
food/coffee/alcohol/tips as totals and no timestamp anywhere. *Measured.*

**The POS does not help.** The Benugin webhook accepts
`{ date, daypart, servers: [...] }` — per-person totals for a whole service. No
transactions, no times. *Measured.* Option 1 in the spec ("use transaction
timestamps") is not available without a change on Benugin's side, which is not a
ZWIN change and cannot be scheduled from here.

**Clock times, by contrast, are already there and are good.** `time_entries`
has real clock-in and clock-out per person per service, and hours are derived
from punches. The employee half of "who was working at 10:15" is solved. The
sales half does not exist.

### What it would take

A sale has to become divisible in time. The smallest honest design:

```
sales_segments
  shift_id, employee_id, starts_at, ends_at,
  food_cents, coffee_cents, alcohol_cents,
  card_tips_cents, cash_tips_cents
```

with `server_sales` kept as the total (and as the whole history), and a segment
table used when present. Tip-outs then run per segment against the people whose
punches overlap it, and pool splits weight by **overlapping** minutes rather
than shift hours.

That is a real build: a new table, a submission UI that asks for periods without
becoming tedious, an engine that loops segments, and pool maths that weights by
overlap. Plus the display work to explain a figure that now has a derivation
behind it.

### The recommendation

**Do not build this before the 15th.** Three reasons.

1. **Dinner barely needs it.** A dinner service starts together. The staggered
   case in the spec — barista opens at 8, busser arrives at 10 — is a *day*
   service shape. The first day both a bar and a coffee counter run together is
   the **17th**, which is when this genuinely starts to bite.
2. **It is the change most likely to be wrong.** Everything else is percentages
   and routing, verifiable by arithmetic. This one invents a data model under
   time pressure, and the failure mode is somebody paid wrong on opening week.
3. **There is a cheap 80% available.** Charging a tip-out only when the role was
   worked at all is already true. The gap is *partial* attendance. For dinner,
   partial attendance is rare; for day, it is the norm.

**Phase it:**

- **By Sep 11** — percentages, direct-service model, kitchen removed, register
  pool. Rehearse it on friends & family and media night with real punches and
  no money at stake.
- **Sep 15–16** — run it. Watch it. Change nothing.
- **After the 16th, before day service gets a bartender in earnest** — build
  time segments.

If the 17th cannot wait, the honest interim is a **manual override**: let the
manager set a busser's or bartender's eligible window on the service sheet, and
charge tip-outs only against sales inside it. Cruder than segments, an hour of
work, and it makes the common case right without inventing a schema in a week.

---

## Part 4 — Migration and safety

1. **Historical services need no migration.** Pinned policy versions mean old
   services keep calculating exactly as they did. Nothing to move, nothing to
   re-run.
2. **Positions change kind.** Bartender and barista move support → direct
   service; kitchen moves support → non-tipped. This is prospective: it changes
   how *future* services are computed. Any open service must be checked before
   the switch.
3. **The new policies are new versions**, so the change is dated and reversible
   from the policy history that already exists.
4. **The check that matters**, before and after: run every closed service
   through the engine on both versions of the code and diff. Byte-identical, or
   it does not ship. That harness already exists and was used on 2026-09-05.

---

## Part 5 — What is needed from Malek

1. **Does a bartender's own bar-seat sale get charged the busser 2%?** They are
   a direct-service earner under the new model, so by the letter of the spec
   yes. Worth confirming, because it is the bartender paying the busser out of
   bar sales.
2. **Does a bartender pay the barista 1.5% on coffee they ring?** Same question,
   other direction. The spec says "servers/bartenders" for the barista tip-out,
   which reads as yes.
3. **Barback 3%** — currently on alcohol sales, paid from the bartender's pot.
   Does the new model keep it? It is not mentioned in the new policy.
4. **"Total bar sales"** is still being read as alcohol sales. If the bar rings
   food, say so.
5. **Register/to-go tips have no separate input today.** The jar and to-go card
   figures exist; is "register tips" the same as the existing to-go card, or a
   third thing to capture?

---

## Part 6 — Decisions, 2026-09-07

Answers to Part 5, from Malek, verbatim in substance:

1. **A bartender does NOT pay the busser 2%.** They tip out the barback only,
   based on bar sales.
2. **A bartender DOES pay the barista 1.5% of coffee sales.**
3. **The barback keeps 3%.**
4. **"Bar sales" means that bartender's own sales for the day — not just
   alcohol.** Food and coffee rung at the bar count.
5. **The register pool is to-go card AND to-go cash from the jar.**
6. **All tip-outs are to be based on clock times.**

### What those answers change

**Rules now need to know WHO PAYS them.** This is the structural consequence and
it is easy to miss. Today every rule is charged to every direct earner. After
these answers the matrix is:

| Rule | Server pays | Bartender pays | Barista pays |
|---|---|---|---|
| Busser 2% of total sales | yes | **no** | yes |
| Bartender 10% of alcohol | yes | — | yes |
| Barista 1.5% of coffee | yes | **yes** | — |
| Barback 3% of bar sales | no | **yes** | no |

A rule therefore needs a `paidBy` alongside its recipient. The engine has no
such concept — it loops earners and applies every rule to each.

**The barback tip-out is not a pot transfer after all.** It is 3% of the
bartender's OWN sales, so the bartender pays it the way a server pays theirs.
The `from:` mechanism built on 2026-09-05 is not what this needs. It stays
useful, but this rule does not use it.

**A bartender is a payer and a recipient in the same service.** They receive 10%
of servers' alcohol and pay out to the barback and the barista. Nothing in the
engine or the emails is shaped for somebody on both sides of the ledger.

---

## Part 7 — How to build the time-aware half

**Status: DESIGN. Not built.** Written 2026-09-07 after Malek confirmed
time-awareness is essential for day service.

### The idea

**Do not ask anybody to invent time periods. The punches already contain them.**

Every moment a tip-out recipient clocks in or out is a boundary. Between two
boundaries the set of people an earner owes is constant, so that span is one
block and needs one number. Nothing else is a boundary — a second barista
arriving changes nothing about who the first barista owes.

That filter is what makes this usable. *Measured on a realistic day service —
Barista A 07:00–15:00, Barista B 08:00–14:00, Busser 10:00–16:00, Bartender
11:00–19:00:*

| | |
|---|---|
| Every punch boundary | **7 blocks** — unusable |
| Boundaries that change who Barista A owes | **3 blocks** — 07:00–10:00 (owes nobody), 10:00–11:00 (busser), 11:00–15:00 (busser + bartender) |

And the case that matters most for the opening:

| | |
|---|---|
| Dinner, everyone clocked in together | **1 block — no question asked at all** |

A service where everybody starts together behaves exactly as it does today. The
form does not change, nothing extra is typed, and the arithmetic is identical.
Only a genuinely staggered service asks, and then two or three times.

### The one real choice: ask, or compute

Sales could be apportioned automatically by time overlap and never ask anyone.
It costs nothing and is sometimes badly wrong. *Measured — barista rings $700
across 07:00–15:00, busser present for 62.5% of that:*

| Shape of the day | Automatic | Actual | Gap |
|---|---|---|---|
| Even | $8.75 | $8.00 | $0.75 |
| Morning rush | $8.75 | $4.00 | **$4.75** |
| Slow start | $8.75 | $11.60 | $2.85 |
| Everything late | $8.75 | $13.00 | **$4.25** |
| **Dinner, all together** | — | — | **$0.00, always** |

A café morning IS lopsided — that is the shape of the business — so automatic
allocation is wrong in exactly the case day service will hit every day.

**So: pre-fill automatically, let it be corrected.** The blocks arrive filled in
by time proportion and must sum to the total. Accepting the pre-fill is
defensible; fixing a lopsided morning is one edit. The lazy path is reasonable
rather than silently wrong, which is the failure this design exists to avoid.

### What gets built

**One new table.** `server_sales` stays exactly as it is — it remains the total
and the whole of history. Segments are additive:

```
sales_segments
  shift_id, employee_id, seq,
  starts_at, ends_at,
  food_cents, coffee_cents, alcohol_cents,
  card_tips_cents, cash_tips_cents
```

No segments for a service means the old behaviour, unchanged. That is what makes
every historical service safe without a migration, and what lets this ship on a
Wednesday without touching Tuesday.

**The engine loops segments.** For each earner: for each segment, work out who
was on during it from the punches, and charge only those rules. Sum the charges.
Everything downstream — pools, reconciliation, emails — works on the totals it
already works on.

**Pool splits weight by overlapping minutes**, not shift hours. Two bartenders,
one on at 11:00 and one at 13:00, sharing a pool earned 13:00–16:00, split it
3h against 3h — not 5h against 3h.

### The rule matrix, which is the other half

Independent of time, and needed first. A rule gains `paidBy`:

```json
{ "type":"tipout", "recipient":"busser",    "percent":2,   "base":"total_sales",
  "paidBy":["server","barista"] }
{ "type":"tipout", "recipient":"bartender", "percent":10,  "base":"alcohol",
  "paidBy":["server","barista"] }
{ "type":"tipout", "recipient":"barista",   "percent":1.5, "base":"coffee",
  "paidBy":["server","bartender"] }
{ "type":"tipout", "recipient":"barback",   "percent":3,   "base":"total_sales",
  "paidBy":["bartender"] }
```

Omitting `paidBy` means everybody, so every existing policy keeps its meaning
and no stored rule needs rewriting.

### Order of work, against the dates

| By | What | Why then |
|---|---|---|
| **Sep 11** | Rule matrix, direct-service earners, kitchen out, register pool | Friends & family is a live rehearsal with real punches and no money at stake |
| **Sep 14** | Fixes from what the 11th showed | Media night is the second free rehearsal |
| **Sep 15–16** | **Change nothing.** Run it. | First real service and grand opening |
| **Sep 17** | Time blocks | The first day a bar and a coffee counter run together — the first day time-awareness changes a number |

Dinner needs the rule matrix and does not need time blocks: everyone clocks in
together, so every service is one block and the two designs agree to the penny.
Day service needs both, and its deadline is six days later. The order falls out
of the operation rather than being imposed on it.

### What has to be visible, or it will not be trusted

A busser receiving $8.00 instead of $14.00 because they clocked in at 10:00 is
correct and looks like a bug. Every tip-out figure needs its derivation on the
screen next to it — *2% of $400 rung between 10:00 and 15:00, while you were
on* — or the first week will be spent re-checking arithmetic by hand.
