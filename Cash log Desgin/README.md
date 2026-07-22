# ZWIN — Staff Tip Submission (mobile) — build spec

Scope: the **staff-facing PIN sign-in + end-of-shift tip submission flow ONLY**. This is the screen staff use on their phones to enter their PIN and report sales/tips at the end of a shift. Nothing about the manager dashboard is in scope here.

Redesigns the current version (blue background + white floating card) into the ZWIN "Broadsheet" style, mobile-first. **~99% of use is on a phone** — design and test at 390px wide first; desktop is a wider centered column, not a priority.

## Screens (in `screens/`)
1. `1-signin-day.png` — PIN sign-in with on-screen numeric keypad
2. `2-submission-step1-day.png` — submission, step 1: who / when / sales
3. `3-submission-step2-day.png` — submission, step 2: tips + note + totals summary + submit

## The flow
`PIN sign-in → Step 1 (role, date, shift, sales) → Step 2 (cash tips, card tips, note, review totals) → Submit → (success)`

Break the current single long-scroll form into **2 steps with a progress bar** (the mock shows "STEP 1 OF 3 / 2 OF 3" — a 3rd step is reserved for a review/success screen; wire it as 3 so future report types slot in). Keep it editable after submit until the manager sends the shift.

### Sign in
- Four ruled PIN cells; the active cell has a 3px blue underline. Filled cells show a large mono dot.
- Custom on-screen numeric keypad (1–9, 0, ⌫) — do NOT rely on the system keyboard; big 58px keys.
- "Continue →" full-width primary button. Small mono version tag centered at the bottom.

### Step 1 — who & when
- **What you worked**: shows the staff member's default role (e.g. "Server") as a ruled read-only row + helper "worked something else? tell your manager."
- **Date you worked**: mono date, "change" link.
- **Which shift**: two-up toggle (Café / Dinner); selected = 1.5px blue border, `#eef2fc` fill, blue text, ✓.
- **Your sales tonight**: Kitchen/food, Coffee/beverage, Alcohol (blank = none). Each is a 56px $ field with mono figures and up/down steppers.
- Sticky "Next: your tips →" bar.

### Step 2 — tips & note
- **Cash tips you took home** (emphasized: 1.5px ink border), **Card tips** (helper: "From your closeout slip. Leave blank if you don't have it."), **Note** (optional textarea).
- **Running totals panel** ("TONIGHT'S TOTALS — WHAT YOUR MANAGER SEES"): sales rung, cash tips, card tips, bold total tips. Updates live as they type — this is the trust feature; keep it.
- Sticky "Submit report" bar + reassurance line "You can edit until your manager sends the shift."

## Design tokens (Day / paper — default)
| Role | Hex |
|---|---|
| Page background | `#f7eee0` (cream) |
| Field / key surface | `#fffdf8` |
| Ink (text, 2px header rule, emphasized field border) | `#1f1d1a` |
| Body text | `#5c5647` |
| Muted (labels, helper) | `#77705f` |
| Placeholder / faint | `#a89f8a` |
| Accent · blue (buttons, active, links) | `#2451c9` |
| Selected fill (toggle) | `#eef2fc` |
| Summary panel fill | `#efe6d6` |
| Field border | `#cabfa4` |
| Hairline under field rows | `#e5dac2` |
| Section-kicker rule | `1px solid #1f1d1a` |

### Night theme (if you add a dark mode toggle later — same layout, swap tokens)
Page `#191815` · surface `#211f1b` · cream ink `#eae6d9` · headings `#f3f0e6` · body `#c8c2b0` · muted `#8f8a7a` · faint `#6f6a5c` · accent blue `#8fa8ff` · hairline `#35332c` / dotted `#403d33`.

## Type
- **Newsreader** (serif, weight 500) — the page headline only ("Log your tips.", "End-of-shift report.").
- **Geist** — labels, buttons, helper text, toggles (400/500/600/700).
- **Geist Mono** — every number: PIN dots, $ amounts, date, totals, version tag, and UPPERCASE section kickers (.14em tracking).

Google Fonts: `Geist`, `Geist Mono`, `Newsreader`.

## Rules
- Border-radius **0**; no drop shadows; no floating card — the form lives directly on the cream page. Structure comes from ruled hairlines and section kickers.
- Minimum 56px tap targets on all inputs, keys, toggles, and buttons.
- Numbers are always Geist Mono; serif only on the headline.
- Color only for meaning: blue = action/active, ink = content, amber/red reserved (not used on this happy-path flow).
- Currency inputs: `$` prefix inside the field, mono, with stepper affordance; placeholder `0.00` in faint.
- Built to grow: the step model and the section-kicker + ruled-row pattern should let new report types (incidents, counts) be added as steps or a future tab without redesign.

If a visual detail is ambiguous, read the exact value from the matching screenshot rather than guessing.
