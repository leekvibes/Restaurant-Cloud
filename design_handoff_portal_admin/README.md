# ZWIN — Manager Portal Admin (build spec)

Scope: the **manager-side control page for the staff portal** — where the owner/GM reviews what staff sent in and controls what staff see. Replaces today's single endless-scroll page. The staff-facing portal is a separate spec; this is the admin side only.

## The problem being fixed
Today everything is one long scroll: stats → floor reports → specials form → before-shift composer → positions list. You scroll past three jobs to reach the fourth. Reorganized into **a live overview strip + four tabs**.

## Screens (in `screens/`)
- `1-overview-floor-reports.png` — overview strip + Floor reports tab (default)
- `2-specials-86.png` — Specials & 86 tab
- `3-who-submits-tips.png` — Who submits tips tab
(The 4th tab, **Before-shift notes**, is the note composer from today's page — same fields: Note, One line, How urgent (grey/amber/red), Show from / Until dates, Post it — restyled to match: no white boxes, underline fields.)

## Layout
- **Header:** serif "Staff portal" title + one-line description + "Open the staff view →" link (right).
- **Overview strip:** four live figures under mono kickers, separated by vertical hairlines, sitting on cream between a 2px top ink rule and a 1px bottom rule — NOT boxed cards. Each shows a number in its meaning color + a plain-language tail: Floor reports "2 need a look" (red when >0), On the board "3 + 2 86'd", Notes live "3 showing today", Still to hand in "3 · Café open" (amber).
- **Tabs:** four, under a 1px ink rule. Active = filled ink chip (`#1f1d1a`, cream text). Floor reports carries a count badge. Only the active tab's body renders below.

### Tab 1 — Floor reports (the stock inbox)
Everything staff reported from `Report out of stock`. Hairline-ruled rows (1px ink top rule, dotted `#cfc2a6` between rows) on cream, each with a colored left status bar (OUT red / LOW amber / ORDER blue): item name + who·time (mono) · note · status tag · actions **Add to order** (ink button) + **Clear** (quiet). Cleared rows drop off. Empty line when none outstanding.

### Tab 2 — Specials & 86 (two columns)
- **Left — On the board today:** dotted-ruled entries (dish serif + mono price + description), a low flag ("6 left"), and per-row **86 it** (red) / **restore** actions. 86'd items show struck-through with an "86'D" tag.
- **Right — Add a special:** compact form, **underline-only fields on cream** (no white boxes): Dish, Price ($), Description, Low note (optional) + ink "Add to the board" button.

### Tab 3 — Who submits tips (positions)
One clean column of position rows (dotted-ruled on cream, 1px ink top rule): position name (bold) + type ("sales and tips" / "cash tips" / "support") on the left; on the right a status word (ASKED green / NOT ASKED grey/faint) + a real pill **toggle** (green filled + knob-right = asked; grey + knob-left = not). Helper line above: "A position that's not asked still sees the board, reports stock, and gets their own hours & pay — they're just never shown a tip form."

### Tab 4 — Before-shift notes
The announcement composer, restyled: Note field, One-line field, How urgent select (For information–grey / caution–amber / urgent–red), Show from + Until date fields, "Post it" ink button. Above it, the list of live notes ("N showing today") as dotted-ruled rows with a colored left bar; each note auto-expires at its Until date. Underline-only fields on cream.

## Style rules (important — matches the rest of the app)
- **No white boxes anywhere** — no `#fffdf9` fills, no bordered card wrappers on lists or stat cards. Everything sits on the cream page `#f4ead9`.
- Structure comes from **hairline rules** (2px ink section rules, 1px `#ddd0b8`, dotted `1px #cfc2a6` between rows) and **colored 3px left bars** for status.
- Form inputs are **underline-only** (`border-bottom:1px solid #b9a878`) on cream, not filled boxes.
- Radius 0, no shadows. Numbers in Geist Mono; serif (Newsreader 500) only for the page title and dish names; Geist for everything else.

## Tokens (day / paper)
Page `#f4ead9` · ink `#1f1d1a` · body `#3a382f`/`#5c5647` · muted `#77705f` · faint `#a89f8a` · kicker grey `#8b8574` · accent blue `#2451c9` · amber `#8a4a10` (tag `#c99a12`) · red `#9a2c1d` · green `#1a7a3c` · section rule `#1f1d1a` · hairline `#ddd0b8`/`#e3d7bf` · dotted row `#cfc2a6` · field underline `#b9a878`.
Night (if added later): page `#191815` · ink→cream `#eae6d9` · body `#c8c2b0` · muted `#8f8a7a` · blue `#8fa8ff` · amber `#d9a05b` · green `#5fc389` · rules `#35332c`/dotted `#403d33`.

## Behavior notes
- Floor-report actions ("Add to order", "Clear") and the specials/86 toggles write to the same data the staff portal reads — this is the manager end of those features.
- Positions toggle = whether that role is shown a tip form; it must not gate board/stock/pay access.
- Notes are date-bounded and auto-expire; they drive the staff "Before your shift" section.

If a visual detail is ambiguous, read the exact value from the matching screenshot.
