# ZWIN — Replacing the Anthropic reader with Google Cloud Document AI

**Targeted audit. Nothing implemented. No production file changed.**

Audited at `85253ef`, 2026-08-13. 1101 tests green before and after (nothing
was touched).

> **Confidence note.** Everything in §1–§5 about ZWIN's own code was **measured** —
> read from source, grepped for call sites, traced to the database column. Everything
> in §6 about what Document AI can and cannot do is **inferred from prior knowledge,
> not tested against the live API**, and my knowledge has a cutoff. §11 lists exactly
> what to verify before committing to this.

---

## 1. The headline

`src/reader.js` is not one reader. **It is four**, and they are not equally
replaceable.

| Reader | Reads | Document AI fit |
|---|---|---|
| `readInvoice` | Supplier invoices | **Good** — there is a purpose-built processor |
| `readExpense` | Till receipts | **Good** — likewise |
| `readDocument` | Leases, 941s, permits, insurance certs | **Poor** — no processor does this job |
| `readReport` | The end-of-day POS sales report | **Poor** — bespoke document, needs judgement |

CLAUDE.md currently describes `reader.js` as *"AI extraction from invoice and
receipt photos."* That is half of it. The line should be corrected regardless of
what happens with this change.

**A full swap is not available.** A partial swap is, and it is defensible.

---

## 2. The seam — the good news, and it is genuinely good

The module boundary is clean enough that the provider is swappable *in principle*
without touching a single workflow.

All four functions have the identical signature:

```js
async function readX(files /* Array<{buffer: Buffer, mimetype: string}> */)
  -> Promise<PlainObject>
```

`src/server.js:29` is the **only** import in the entire application:

```js
const { readReport, readInvoice, readDocument, readExpense } = require('./reader');
```

Four call sites, no others:

| Route | Line | Reader |
|---|---|---|
| `POST /shifts/:id/read-report` | `server.js:2715` | `readReport` |
| `POST /c/expenses/read` | `server.js:12544` | `readExpense` |
| `POST /c/documents/read` | `server.js:12557` | `readDocument` |
| `POST /c/invoices/read` | `server.js:14976` | `readInvoice` |

Nothing else in 34k lines calls the API, constructs a prompt, or knows the
provider's name. **If a replacement returns the same object shape, no route, no
form, no template and no database write changes.**

That is the whole test of "without breaking workflows," and it is a real
constraint the code already satisfies — the output object *is* the contract.

---

## 3. The output contract, field by field — *measured*

This is what a replacement must produce. These field names are not internal:
they are read directly by the browser (`fill(d)` at `server.js:13314`), mapped
onto form inputs by name, and several are persisted.

### `readInvoice` → the capture drawer + `m_invoices`

```
vendor_name · invoice_number · invoice_date · due_date
subtotal · tax · total · is_credit · category · notes · confidence
line_items[] { description, code, brand, pack_size, qty, unit, unit_price, total }
```

- `total` → the `amount` form field → `amount_cents`
- `category` → a **`<select>` of exactly 8 options** (`server.js:12612`)
- `confidence` → **persisted as `m_invoices.ai_confidence`** (`server.js:12299`)
  and drives the list badge: `low`/`medium` render a **"Check"** chip,
  everything else an **"AI read"** chip (`server.js:12421`)
- `line_items` → `reviewRows()` in `products.js:434` → the product-matching
  pipeline, the `tally` counts in the drawer, and eventually Products

### `readExpense` → the capture drawer + `m_expenses`

```
name · where_bought · total · spent_on · category · paid_with · confidence · notes
```

- `name` is **a written phrase, not a field on the receipt** — *"Bag of ice",
  "Cleaning supplies"*. It is a summary of the basket.
- `category` → `<select>` of 11 options
- `paid_with` → `<select>` of 6, deliberately blank unless the receipt says

### `readDocument` → the capture drawer + `m_documents`

```
title · issuer · category · doc_date · period_start · period_end
expires_on · action_by · reference · summary · confidence
```

- `title` is **what a person would write on a folder tab**, not a printed field
- `summary` is **one written sentence**
- `expires_on` / `action_by` drive `docState()` (`server.js:12526`) — the
  Filed / Today / N days / Expired / Overdue badge, and the dashboard's
  expiring-soon attention panel

### `readReport` → pre-fills the nightly close

```
servers[] { name, food, coffee, alcohol, card_tips } · reported_total_tips
```

Then at `server.js:2719`: names are matched against staff (exact, then first
name), and matched rows **write to `work` and `sales`** via `insertWorkIfAbsent`,
`upsertSales`, `setCardTips`.

**This is the one reader that writes money-adjacent rows.** It feeds the tip-out
engine. Per CLAUDE.md, the nightly close is the oldest and most money-critical
flow in the app.

---

## 4. What the current implementation does beyond "extract text" — *measured*

This is the part a provider swap has to carry, and it is easy to underestimate.
These are not incidental prompt decorations; each one exists because it was got
wrong once.

**Instruction-following that changes which number is picked.** From
`INVOICE_PROMPT`:

> *"If the document shows a previous balance or account balance, ignore it — we
> want this invoice only. If 'amount due' and 'invoice total' differ, use the
> invoice total."*

The comment above the schema (`reader.js:101`) records why: an invoice shows
several plausible totals, and **a wrong total looks exactly as reasonable as a
right one.**

**Classification into ZWIN's own taxonomy.** Food / Coffee / Beverage / Alcohol /
Supplies / Repairs / Services / Other — with mapping rules in the prompt
(*"Coffee beans → Coffee. Paper goods, cleaning, to-go containers → Supplies"*).
This is a business-specific judgement, not a field on the paper.

**Privacy instruction plus a code backstop.** `DOC_PROMPT` forbids returning
SSN/EIN/bank/card numbers in any field, and `scrubIdentifiers()`
(`reader.js:372`) regex-strips four identifier shapes as belt-and-braces. The
comment at `reader.js:294` explains the reasoning: the database is unencrypted
SQLite on a hosted disk behind one shared password, so lifting an SSN out of a
PDF into it copies the worst content somewhere weaker for no benefit.

**Two-call schema splitting.** `reader.js:108` documents that a combined
header + line-items schema **took three minutes and then failed** with "Schema is
too complex," and that the split is also the safer shape — a line-item failure
must never sink invoice entry. `test/reader-schema.test.js` (65 lines) exists
solely to keep them apart, with a weight budget as a tripwire.

**Credit-memo sign flipping.** `reader.js:274` — `is_credit` negates subtotal,
tax, total *and every line total*, because returning a case of tomatoes would
otherwise read as buying one more and push the average price the wrong way.

**Error translation.** `invoiceError()` maps API status codes to sentences a
restaurant manager can act on, including one that explicitly says *"This is a
bug, not your file."*

**A 90-second timeout** (`READER_TIMEOUT_MS`), added because a request once sat
for three minutes with no feedback.

---

## 5. Failure behaviour that must survive — *measured, and asserted by tests*

The reader is treated throughout as **a convenience over a form that works
without it.** Three tests enforce this:

- `test/documents.test.js:212` — the read endpoint returns `200` with a
  printable `error` string when there is no key, *not* a 500. The comment notes
  this is the same shape as a key expiring in production.
- `test/documents.test.js:224` — the capture overlay files a document **with the
  reader switched off entirely**; the panel behind it is a plain form that posts
  on its own.
- `test/expenses.test.js:265` — same contract for receipts.

**The whole suite runs with no `ANTHROPIC_API_KEY`.** That means today's tests
prove the *degraded* path and never exercise a real read. A replacement inherits
exactly the same blind spot unless something is added — see §10.

There is also UI gating at `server.js:2307-2309`: without a key the photo input
and button render `disabled` with *"Needs an ANTHROPIC_API_KEY in .env first."*
Three strings that would need to change or generalise.

---

## 6. What Document AI actually offers — *inferred, verify before relying*

Document AI is a different kind of product from a vision model. The relevant
differences:

| | Claude vision (today) | Document AI |
|---|---|---|
| Output shape | **You define the JSON schema per call** | **Fixed per processor.** You get that processor's entity set |
| Instructions | Natural language, per call | **None.** No prompt |
| Confidence | Self-reported enum, prompted for | **Numeric, per entity** — genuine model confidence |
| Summarisation / naming | Yes | **No** |
| Classification into your taxonomy | Yes, by prompt | **No**, unless you train a custom processor |
| Pricing model | Per token | **Per page** |

Processors that matter here: **Invoice Parser**, **Expense (receipt) Parser**,
**Form Parser** (generic key/value + tables), **Document OCR** (text + layout),
and **Custom Extractor** (you train it on your own labelled examples).

**The numeric per-entity confidence is a real upgrade** over a self-reported
enum, and maps onto `ai_confidence` cleanly with a threshold.

**Per-page pricing is likely cheaper at volume**, but I am not quoting figures —
see §11.

---

## 7. Fit, reader by reader

### 7.1 `readInvoice` — good fit, with gaps

Invoice Parser natively returns supplier name, invoice ID, invoice date, due
date, net amount, total tax, total amount, and **line items** with description,
quantity, unit price and amount.

**Maps well:** `vendor_name`, `invoice_number`, `invoice_date`, `due_date`,
`subtotal`, `tax`, `total`, and most of `line_items`.

**Does not map:**

| Field | Why | Consequence |
|---|---|---|
| `category` | Not an invoice concept. Your 8-way taxonomy is a business rule | The `<select>` falls back to its `Food` default — **silently wrong**, and it feeds Performance |
| `is_credit` | No credit-memo flag | Credit memos would file as positive charges. This is a **ledger correctness** issue |
| `notes` | Nothing to write it | Loses the "mixed invoice, chose the largest share" explanation |
| `code` / `brand` / `pack_size` | Not standard Invoice Parser entities | Weakens product matching in `reviewRows()` |
| *"ignore previous balance"* | No instruction channel | On invoices carrying an account balance, **the wrong total may be picked** |

### 7.2 `readExpense` — good fit, with a bigger hole

Expense Parser returns merchant name, transaction date, total, tax, and often
line items.

**Maps well:** `where_bought`, `spent_on`, `total`.

**Does not map:** `name` (the written phrase — *"Cleaning supplies"* — which is
a **required** field on the form), `category` (11-way taxonomy), `paid_with`,
`notes`.

`name` is the one that hurts: it is a summarisation of the basket, and
summarisation is exactly what Document AI does not do. A fallback of "merchant
name" would file every Costco run as *"Costco"*, which is the shop, not the
purchase — and the field's own placeholder says *"Bag of ice, Costco run."*

### 7.3 `readDocument` — **poor fit. This one does not move.**

The job is: *identify an arbitrary business document, name it as a person would,
sort it into 11 categories, find the period it covers, find its expiry, find any
deadline, and write one sentence about it.*

There is no processor for "arbitrary business document." Options are:

- **Form Parser** → key/value pairs. You would be writing heuristics over
  arbitrary lease and permit layouts. Brittle, and it cannot produce `title` or
  `summary` at all.
- **Custom Extractor** → needs labelled training examples per document type. You
  do not have a labelled corpus, and it still will not write a summary.

`title`, `summary` and `category` are structurally unavailable. Those are three
of the four *required* fields in `DOC_SCHEMA`, and `expires_on` / `action_by`
drive the dashboard's attention panel.

**Recommendation: leave `readDocument` on Claude.**

### 7.4 `readReport` — **poor fit, and the riskiest to touch**

A POS end-of-day report is not a standard document type. Form Parser could
likely recover the table, but the prompt is doing real judgement work:

> *"Only include real servers/employees — do NOT include category subtotals,
> section headers, or the grand total row as a 'server'."*

Mapping arbitrary column headings onto `food` / `coffee` / `alcohol` /
`card_tips` is your business's schema, not the document's. And this is the
reader whose output **writes to `work` and `sales`** and flows into the tip-out
engine.

A misread here does not produce a bad filing — it produces **a wrong tip-out**,
which is money, and the manager reviews on the close screen but is reviewing
pre-filled numbers rather than blank ones.

**Recommendation: leave `readReport` on Claude.** The upside is small and the
downside is the most sensitive flow in the app.

---

## 8. The shape I would actually build

**Not a replacement. A provider seam, plus two migrated readers.**

```
src/reader.js          unchanged public API — the four functions
  ├── providers/anthropic.js    what exists today, moved
  └── providers/docai.js        new
```

Each reader picks a provider by env var, defaulting to today's behaviour:

```
READER_INVOICE_PROVIDER = anthropic | docai     (default: anthropic)
READER_EXPENSE_PROVIDER = anthropic | docai     (default: anthropic)
```

`readDocument` and `readReport` take no such switch — they stay on Claude, and
that is a documented decision rather than an omission.

**Why this shape:**

1. **Nothing changes until an env var says so.** The default path is byte-for-byte
   today's behaviour, so "without breaking workflows" is the *default state*, not
   something to be verified.
2. **Instant rollback** — unset the variable. No deploy, no revert.
3. **Both providers can be run against the same invoice** and compared, which is
   the only honest way to find out whether Document AI is actually better on
   *your* vendors' paperwork.
4. The gaps in §7.1/§7.2 get filled **in our code, not the provider's** — a
   category mapper from vendor name plus line-item keywords, credit detection
   from a negative total or a "CREDIT MEMO" string in the OCR text. That logic is
   testable offline and is worth having regardless of provider.

**The Anthropic dependency does not leave `package.json` either way.** Two
readers keep using it.

---

## 9. What this touches

| File | Change |
|---|---|
| `src/reader.js` | Split into a dispatcher + two providers. Public API unchanged |
| `src/reader/providers/docai.js` | **New** |
| `package.json` | Add `@google-cloud/documentai`. `@anthropic-ai/sdk` **stays** |
| `.env.example` | GCP vars + the two provider switches |
| `src/server.js:2307-2309` | Three strings naming `ANTHROPIC_API_KEY` in the UI |
| `test/reader-*.test.js` | New: field-contract tests, category mapping, credit detection |
| `CLAUDE.md` | Correct the `reader.js` one-liner; record the provider split |
| **Nothing else** | No route, no form, no template, no schema, no migration |

**No database migration.** No column changes. `ai_confidence` keeps taking the
same three strings; the numeric confidence is thresholded into them.

---

## 10. The verification problem — and it is the real risk

Per CLAUDE.md: *"A green suite is not a working feature."* This change is an
unusually sharp instance.

**The suite runs with no API key and therefore never performs a read.** 1101
tests can stay green through a swap that returns garbage on every real invoice.
There is no fixture, no recorded response, no golden file.

What is needed before this can be called done:

1. **A fixture corpus** — a handful of your real invoices and receipts, ideally
   including one credit memo, one with a previous-balance line, and one mixed
   delivery. This is the single most valuable thing you can produce, and I cannot
   produce it.
2. **A side-by-side harness** — a script that runs both providers over the corpus
   and prints a field-by-field diff. Not a test; a tool for the decision.
3. **Contract tests** that assert the adapter's output shape matches §3 exactly,
   with a recorded Document AI response as a fixture. Those *can* run in CI.
4. **A manual pass in the browser**, per CLAUDE.md — actually upload a real
   invoice through the drawer and watch the fields fill.

Until step 1 exists, any claim that Document AI is better or worse for ZWIN is
an opinion. Mine included.

---

## 11. What I need from you

### Decisions

| # | Decision | My recommendation |
|---|---|---|
| 1 | Scope | **Invoices + receipts only.** Documents and the POS report stay on Claude |
| 2 | Replace or add a seam | **Seam**, defaulting to Anthropic. Rollback is an env var |
| 3 | What drove this — cost, accuracy, or vendor preference? | *Genuinely need this.* It changes the recommendation |
| 4 | Missing `category` | Map it ourselves from vendor + line keywords |
| 5 | Missing expense `name` | Derive from the top line items, fall back to merchant |
| 6 | Credit memos | Detect from negative total / OCR text, keep the sign-flip logic |

**#3 matters most.** If this is about cost, the honest first move may be
`READER_MODEL=claude-haiku-4-5`, which is a one-line change with no provider
work at all. If it is about accuracy on invoices specifically, Document AI's
Invoice Parser is a reasonable bet and worth the corpus test. If it is because
you are consolidating onto Google Cloud, that is a fine reason on its own and
changes the calculus.

### From the Google side

You would need to do these — they need your billing account and I should not be
creating cloud resources or handling keys:

1. A **GCP project** with **billing enabled**
2. **Document AI API** enabled on it
3. Two **processors** created — *Invoice Parser* and *Expense Parser* — each
   giving you a **processor ID**; note the **region** (`us` or `eu`)
4. A **service account** with the Document AI API User role, and a **JSON key**
5. The key placed on disk and referenced by path — never pasted into chat, never
   committed. On Render it goes in a secret file or an env var.

Then `.env` gains roughly:

```
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
DOCAI_PROJECT_ID=...
DOCAI_LOCATION=us
DOCAI_INVOICE_PROCESSOR_ID=...
DOCAI_EXPENSE_PROCESSOR_ID=...
READER_INVOICE_PROVIDER=docai
```

### To verify before building

Because §6 and §7 are inferred, not measured:

- Current **per-page pricing** for Invoice and Expense Parser
- The **exact entity list** each processor returns today
- Whether Invoice Parser now exposes anything for **credit memos**
- Whether line items include **SKU / vendor item code** — `reviewRows()` matching
  is meaningfully better with it

The fastest way to settle all four is to create the processors and run three of
your real invoices through the console by hand, before any code is written.

---

## 12. Risks

**High — silent category default.** If `category` is absent the form keeps its
default (`Food` for invoices). Nothing looks broken; Performance quietly drifts.
Any adapter must return an explicit *unknown* and the drawer must mark it
unfilled, rather than letting a default masquerade as a read.

**High — no real-read test coverage.** §10. The suite cannot catch a bad swap.

**Medium — credit memos filing as charges.** Loses the sign-flip. Ledger-visible.

**Medium — the wrong total on invoices carrying a previous balance.** The current
prompt handles this explicitly; Document AI has no instruction channel.

**Low — `ai_confidence` semantics shifting.** Numeric → enum needs a threshold,
and picking it wrong makes every invoice say "Check" (noise) or none (false calm).

**Low — plumbing.** The seam is clean; this part is genuinely easy.

---

## 13. Recommendation

Do **#3 above** first — tell me what problem this solves. Then, if it still makes
sense:

1. You create the two processors and run three real invoices through the console
2. We look at the output together against §3's field list
3. If it holds up, build the seam with Anthropic as the default
4. Migrate invoices first, alone, behind its env var
5. Receipts second, only once invoices have run on real paperwork for a week
6. Documents and the POS report stay on Claude, recorded in CLAUDE.md as a
   deliberate choice

Steps 1 and 2 cost an hour and are the only ones that can tell us whether steps
3–5 are worth doing at all.
