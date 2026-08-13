# ZWIN — Multi-tenancy readiness

**Written:** 2026-08-08, at `dc4e938`, after Scheduler Phase 3.
**Status:** assessment only. Nothing in this document has been implemented.
**Trigger to act:** before restaurant #2 has a login. Not before.

---

## The question

> "Make sure the foundation is moving toward **User → Organization → Location → Data**
> rather than **User → your restaurant's data**. That's probably the most important
> architectural step between the ZWIN you use today and something you can sell to
> thousands of restaurants."

Is ZWIN heading for a painful restructure, or is it on a good path?

## The verdict

**Good path — provided we take Door 1 below.** The tenancy assumption is *absent*,
not *wrong*, and absent is a day of routing work. Wrong is the rewrite.

The one thing that genuinely blocks "hand a fresh copy to another restaurant"
today is not the schema. It's that a fresh install isn't fresh — see
[Blocker: the fresh install isn't fresh](#blocker-the-fresh-install-isnt-fresh).

---

## What the code actually says

Measured on 2026-08-08. Re-run the commands in
[Re-verifying this](#re-verifying-this) before trusting any number here — facts rot.

### The bad news, stated plainly

**58 tables. Zero tenancy columns.** Not one `tenant_id`, `org_id`, `location_id`
or `restaurant_id` anywhere in the schema. Every query assumes one restaurant.

### The good news, which matters more

The assumption lives in exactly **one line**:

```js
// src/db.js:7
const db = new Database(DB_PATH);
```

One connection, one file, path from an env var. Fifty-eight tables and ~500
queries inherit "which restaurant" from that line **by never mentioning it**.

That is the opposite of the usual disaster. The expensive case is a tenant
assumption scattered through the schema *as values* and through the queries *as
predicates*. Here there is nothing to unpick — there is something to add, once,
in one place.

Three more things already pointing the right way:

| What | Where | Why it matters |
|---|---|---|
| `APP_NAME` (the software) is separate from `RESTAURANT` (whoever runs on it), and `RESTAURANT` reads from an env var with a deliberately neutral default | `src/brand.js` | Somebody was already thinking "this runs for *somebody*." No restaurant identity is compiled in. |
| Business rules are **data, not code**: positions (6 configurable rows), tip-out policies (3), policy versions (6), OT threshold/multiplier in `settings` | `positions`, `tipout_policies`, `policy_versions`, `settings` | Restaurant #2 with different roles and a different tip-out needs no code change. |
| Modules are a **declarative registry**, not hand-built pages — each declares slug, table, title, fields | `src/modules.js:35` (`MODULES`) | "Copy/paste a feature" is already partly true for this class of feature. |
| Uploads path is an env var (`UPLOAD_DIR`), filenames are UUIDs | `src/server.js:14832` | Per-tenant file storage is a config change, not a code change. |

---

## Two doors

### Door 1 — one database per restaurant (recommended)

Resolve the SQLite file by subdomain or hostname. **The schema does not change.
No query changes. No business logic changes.**

The only real work: **329 statements are prepared at module load**, bound to the
connection that existed at `require()` time. The `q = { … db.prepare() … }`
objects in 18 modules would need to become per-connection (a factory, or a cache
keyed by tenant).

That is mechanical — one shape repeated — and it touches no WHERE clause and no
data. Estimate: days, not weeks.

**Cheaper still, available today with zero code change:** one Render service per
restaurant, with `DB_PATH` and `RESTAURANT_NAME` set per service. Viable to
roughly 20–50 customers before ops cost bites, and it lets us sell while we
re-plumb. This is the recommended first move.

### Door 2 — shared database with `tenant_id` everywhere

This is what the advice above literally describes, and here it is the expensive
door: 58 tables need a column, ~500 queries need a predicate, and **every one
missed is a cross-restaurant data leak.**

Concrete collisions already in the schema that Door 2 would have to solve first:

- `products` is `UNIQUE (LOWER(name))` — two restaurants cannot both sell a "Ribeye"
- `users` is `UNIQUE (email COLLATE NOCASE)` — an owner of two restaurants cannot reuse one login
- `employees.pin` has **no** unique index, and `q.staffByPin` resolves a portal
  login **by PIN alone** (`src/db.js:294`). In a shared database, two restaurants
  that each have a "1234" would sign into each other.

Door 2 also effectively implies Postgres — see [The real ceiling](#the-real-ceiling-sqlite-not-tenant_id).

---

## The goal: "copy/paste the whole site for someone fresh"

> "Eventually the goal should be I can basically copy and paste any feature / the
> whole site for someone to use fresh with no issues, just as the data populates,
> take some features away depending on the plan."

Two separable things. One is nearly free. One is a real blocker today.

### Blocker: the fresh install isn't fresh

Booting the app against a brand-new empty database does **not** produce an empty
restaurant. `src/backfill.js` auto-imports `data/backfill-2026.json` — 113 KB of
**our real service history, committed to the repo** — on first boot:

```
Backfill: 72 services imported, 447 staff rows, 90 server-sales rows.
Backfill: created Hendy, Esther, Ingri, Stephanie, Kevin, Joseph, Evendi,
          Sandra, Sebastian, Eunji, Arabella.
```

So a copy handed to another restaurant today arrives pre-populated with **our
staff's names and our historical shift data.** That is the single thing standing
between the code as it is and the stated goal — and it is a privacy problem, not
just an annoyance, the moment an instance goes to someone else.

There is already an escape hatch: `ZWIN_SKIP_BACKFILL=1` (used by the test
suite). The fix is to make importing history an explicit, opt-in, per-install
action rather than something that happens automatically on first boot.

**Everything else about a fresh install already works.** Verified on an empty
database with `RESTAURANT_NAME="Test Diner"` — every main page returns 200:
`/`, `/schedule`, `/timeclock`, `/employees`, `/payroll`, `/c/invoices`,
`/c/products`, `/cash`, and `/portal` correctly redirects to sign-in. No crashes,
no empty-state failures. That is genuinely good and worth protecting with a test.

### Plan-based feature gating: half-built, keyed to the wrong noun

The gate exists:

```js
// src/server.js:526
const canSee = (user, key) => !user ? false
  : (user.master || !user.features.length || !key || user.features.includes(key));
```

`users.features` is a per-**user** allow-list, already enforced app-wide in the
auth middleware (`src/server.js:564`) for both GET and non-GET.

For plans we need the same predicate keyed to the **tenant**, not the user:
*this restaurant is on Starter, so Invoices is off for everybody here* — then
intersected with the per-user list that already exists. That is a small change
to one function plus a place to store the plan, and it does **not** require
touching the 58 tables. Worth doing at the same time as Door 1.

---

## What I'd push back on

`User → Organization → Location → Data` is four levels for a problem we have zero
instances of.

- **Location** we will certainly need — that's one restaurant, one database.
- **Organization** is a billing-and-permissions concept, and we cannot honestly
  design it yet. Multi-location groups differ enormously in whether they share
  staff pools, inventory, or consolidated payroll, and we have no customer data
  on which kind we'll get.

The saving grace: Organization lives *above* the tenant, in a separate directory
database. Adding it later touches **none** of these 58 tables. Building it now
means designing against a guess.

---

## The real ceiling: SQLite, not `tenant_id`

One file, one writer. Perfect for one restaurant; perfect for a hundred separate
files. It stops being perfect the moment we want:

- cross-tenant reporting or a single admin dashboard over all customers
- Door 2 (a shared database)
- more write concurrency than one process can serialize

At that point we're migrating to Postgres, and **that** is the big migration
hiding behind the original advice — not the tenant columns.

**Trigger to watch for:** the first time someone says *"I want one dashboard
across all our customers' data."* That's a Postgres decision, not a schema-column
decision, and it's worth knowing in advance.

---

## The plan, cheapest first

Nothing here is urgent. Ordered so each step is useful on its own and none
blocks Schedule.

1. **Keep the discipline we already have.** Never hardcode the restaurant's
   identity — it's env-configured today. Applies to anything new.
2. **Treat module-load `db.prepare()` as a tax.** Every new one is another line
   to convert at Door 1. Preparing inside the function is free and just as fast.
3. **Make the backfill opt-in.** Removes the one hard blocker to handing someone
   a fresh copy. Small, self-contained, and worth a test that boots an empty
   database and asserts zero employees.
4. **Add a fresh-install smoke test.** Boot on an empty DB, assert every main
   page returns 200. Protects the property the whole goal depends on. Cheap now,
   expensive to retrofit after it breaks.
5. **Before customer #2:** decide the routing story (subdomain → database file).
   Start with one Render service per restaurant — zero code change.
6. **When ops cost bites (~20–50 customers):** Door 1 proper — per-connection
   statement factories, one process serving many tenants.
7. **Only if cross-tenant reporting becomes a requirement:** Postgres, and then
   Door 2 becomes reasonable.

**Do not** add `org_id` / `location_id` columns now. They'd be designed against
imagined requirements, and Door 1 doesn't need them.

---

## Re-verifying this

These numbers were measured, not estimated. Re-run before trusting them.

```bash
# tenancy columns anywhere in the schema (expect: none)
node -e "
const db=require('./src/db').db;
const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").all().map(r=>r.name);
console.log(t.length,'tables');
for(const n of t) for(const c of db.prepare('PRAGMA table_info('+n+')').all())
  if(/tenant|org_|location_id|restaurant/i.test(c.name)) console.log(n+'.'+c.name);
"
```

```bash
# statements bound to one connection at require() time (was: 329)
node -e "
const D=require('better-sqlite3'); const real=D.prototype.prepare; let n=0;
D.prototype.prepare=function(...a){n++;return real.apply(this,a)};
for (const m of ['db','timeclock','portal','scheduler','products','cash','menu',
                 'periods','policy','overtime','modules','search','guard']) require('./src/'+m);
console.log('prepared at module load:', n);
"
```

```bash
# does a fresh install come up clean, and come up EMPTY?
rm -f /tmp/fresh.db*
DB_PATH=/tmp/fresh.db PORT=3311 RESTAURANT_NAME="Test Diner" node src/server.js &
sleep 4
for p in / /schedule /timeclock /employees /payroll /c/invoices /c/products /cash /portal; do
  printf "  %s  %s\n" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3311$p)" "$p"
done
node -e "console.log('employees seeded:', new (require('better-sqlite3'))('/tmp/fresh.db',{readonly:true}).prepare('SELECT COUNT(*) c FROM employees').get().c)"
```

---

## One-line summary

The foundation is fine; the ceiling is SQLite. The tenancy is missing rather
than wrong, which is the cheap kind of missing — but a fresh copy currently
ships with our staff in it, and that's the part to fix first.
