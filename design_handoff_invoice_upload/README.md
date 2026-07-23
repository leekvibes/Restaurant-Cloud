# ZWIN — Invoice & Expense upload flow (build spec)

Scope: **how a user adds an invoice or an expense.** Replaces today's cramped right-side drawer with a document-first overlay. The document becomes the hero; ZWIN reads it and the user confirms alongside it. Nothing else on the Invoices/Expenses pages changes.

## Screens (in `screens/`)
- `1-flow-storyboard.png` — the whole flow, 5 frames (read this first)
- `2-dropzone.png` — the capture/dropzone step
- `3-document-review.png` — the document-first review step
- `4-quick-expense-modal.png` — the no-document quick-expense modal

## The flow (invoice WITH a document)
1. On the Invoices list, click **Add invoice** (top right).
2. A **dropzone opens as an OVERLAY over the list** — the list dims behind it and stays loaded (do NOT navigate to a new route/page).
3. User drops a PDF/photo (or Take a photo / Enter manually / forward by email). The document renders immediately and ZWIN reads it — a few-second **"Reading the invoice…"** state; fields fill in as they resolve. Typing is allowed during read and must never overwrite a field the user has touched.
4. The same overlay becomes the **document-first review**: the document on the LEFT (zoom/rotate/replace), the read-back fields on the RIGHT to confirm. Low-confidence fields are flagged amber ("check this"); line items are matched to existing products (matched / new·link); a lines-total-vs-invoice-total check shows green when it reconciles.
5. **Save** closes the overlay → back on the list exactly where they were (scroll + filter intact), new row on top, a "SAVED ✓" toast. **Cancel** closes with no change.

## The flow (expense with NO document)
Skip the big dropzone. Open the compact **centered modal** (`4-quick-expense-modal.png`): fields on the left, a **generous receipt-photo tile** (~186px, drag-or-take) on the right — not the tiny native "Choose File". Same Save/Cancel behavior.

## Why an overlay, not a page
The list stays mounted behind the overlay so Cancel/Save returns the user to their exact scroll and filter with no reload. A full-page route would lose that context.

## Layout specs
**Dropzone (step 2):** centered card over dimmed list. Type toggle at top (Vendor invoice / Expense·receipt). Dashed dropzone `2px dashed #b9a878` on `#faf3e6`, 56px icon square, serif prompt "Drop a PDF or photo here", helper line, three buttons (Choose a file = blue primary; Take a photo / Enter manually = ink outline), format line `PDF · JPG · PNG · HEIC — up to 20MB`. Below: "forward to invoices@…zwin.app" and a "waiting to confirm" queue.

**Document review (step 4):** two columns. LEFT = document viewer on `#e7dcc7`, the doc on white `#fff` with `1px #cabfa4` border; toolbar row (zoom / rotate / replace) in mono. RIGHT = "INVOICE DETAILS" 2×2 field grid, then "LINES READ" table (product ×qty · amount · match status), then lines-total-vs-invoice reconcile row. Header bar spans both: back link, serif title "Reviewing a new invoice", a mono "READ BY ZWIN · CONFIRM EACH FIELD" pill, Cancel, and ink "Save invoice".

**Reading state (step 3):** doc shows on the left; right side shows a spinner + "Reading the invoice…" + skeleton bars + "You can start typing now — it won't overwrite what you touch."

## Field system (reuse the shared ZWIN pattern)
- White field surface `#fffdf9`, border `#d3c6ac`, radius 0.
- Micro-label above each field: mono uppercase, 9.5px, `.1em`, `#8b8574`. Append "✓ read" when auto-filled, or an amber "· CHECK THIS" when low-confidence.
- Values in **Geist Mono**; money gets a faint `$` prefix (`#a89f8a`); empty/derived values sit faint (`#c8bda3`).
- Focused field: `box-shadow: inset 0 0 0 2px #2451c9` + `background:#f5f8ff` + caret. No native number spinners.

## Tokens (day / paper — default)
Page `#f4ead9` · raised `#f9f1e4` · field `#fffdf9` · doc backdrop `#e7dcc7` · dropzone fill `#faf3e6` · dashed border `#b9a878` · panel border `#d3c6ac` / hairline `#f0e7d4` · ink `#1f1d1a` · body `#3a382f` · muted `#77705f` · faint `#a89f8a` · accent blue `#2451c9` · amber (check) `#8a4a10` · positive green `#1a7a3c`.
Night theme: swap to page `#191815`, surface `#211f1b`, doc backdrop `#2a271e`, cream ink `#eae6d9`, body `#c8c2b0`, muted `#8f8a7a`, blue `#8fa8ff`, amber `#d9a05b`, green `#5fc389`, borders `#3d392d`/`#302c22`.

## Type & rules
- Newsreader (500) for the overlay title/prompts only; Geist for UI; Geist Mono for all figures, ids, dates, and kickers.
- Radius 0, no shadows except the overlay card's drop shadow over the dimmed list. Color only for meaning.
- Every read value is editable — clicking any field lets the user override it.
- Accessibility: overlay traps focus, Esc = Cancel, returns focus to the Add-invoice button on close.

## Behavior to preserve
Line items still write to Products; "matched / new·link" mirrors the existing product-matching. Confidence flags and the total-reconcile are display aids over data that already renders — don't change what's stored.

If a visual detail is ambiguous, read the exact value from the matching screenshot.
