# ZWIN — Staff Portal (build spec)

Scope: the **staff-facing mobile portal AFTER PIN login**. The login/PIN screen stays exactly as it is today — do not touch it. This spec covers the Home hub and its four sub-pages. ~99% of use is on a phone — design at 390px first.

Everything is in the ZWIN "Broadsheet" style: cream page, hairline rules, radius 0, no white boxes, serif for headlines only, Geist Mono for every number.

## Screens (in `screens/`)
| File | Screen |
|---|---|
| `1-home-server.png` | Home — Server role |
| `2-home-barista.png` | Home — Barista / bartender (support-with-tips) |
| `3-home-kitchen.png` | Home — Kitchen / busser (no tips) |
| `4-home-before-your-shift.png` | Home with the "Before your shift" announcements section |
| `5-earnings-history.png` | Your hours & pay (earnings + history) |
| `6-specials.png` | Today's specials & 86 board |
| `7-out-of-stock.png` | Report out of stock (multi-item) |

## Home — changes shape by role
Home is NOT one fixed layout. Like the tip submission, it reshapes to the person's role. Three shapes:

- **Server** (`1`): primary task = **Submit tips & sales** (sales + cash + card tips).
- **Barista / bartender** (`2`): primary task = **Submit your cash tips** (no sales fields).
- **Kitchen / busser** (`3`): **no submission** — a quiet "You're clocked on — nothing to submit, hours come from the schedule" line. **Report out of stock** becomes the primary action instead.

Use the same role/permission logic the tip-submission flow already uses to decide the shape — don't build a second role system.

### Every Home, every role, must include (in this order)
1. **Header** — ZWIN wordmark, PALM VINTAGE, Sign out.
2. **Greeting** — "Evening, {first name}." + tonight's shift line (green dot · "On Café tonight · {Role}"). Greeting word follows time of day.
3. **Before your shift** (`4`) — see below. Only renders when there are active notes for today.
4. **Primary task** — the role-shaped block above (or the "nothing to submit" line for kitchen/busser).
5. **Your last shift** teaser — links to Your hours & pay. Server: "you kept $X". Support: "you got $X". Kitchen/busser: hours-based.
6. **Your hours & pay** — **EVERY role gets this row**, linking to screen `5`. Servers/support see tips-kept; hourly staff see shifts + hourly pay. Nobody is left without access to their own hours and pay.
7. Shortcut rows: **Today's specials** (all roles); **Report out of stock** (kitchen/bar; may also show for others if you allow it).

Rows are ruled list items (icon square + title + subtitle + ›) separated by `1px #e3d7bf` hairlines — no white cards. The primary task is a serif headline under a 2px ink bottom-rule with a "DUE TONIGHT" mono tag, not a filled black card.

## Before your shift (announcements)
A **temporary, date-based** section — NOT a permanent message board. Manager posts short notes that each carry an active date/range and auto-expire (e.g. "expires tmrw"). Examples: private event tonight, new allergy step, broken equipment, menu change. Render each as a colored left-bar entry (red = urgent, amber = caution, grey = FYI) with title + one line + optional expiry cue, under a "BEFORE YOUR SHIFT / FOR TODAY" kicker. The whole section disappears when there are no active notes. Needs a manager-side composer with an expiry date (not in this spec — flag it as a dependency).

## Your hours & pay (screen 5) — the reason to open the portal
Today the portal never shows staff what they earned; the payout after tip-out only reaches them by email. This page surfaces data that already exists.
- **Last shift hero:** big green "You kept $X" (server) with the breakdown — tips collected, tipped out to support (−), cash in hand, to your paycheck. Support role shows their cash + tip-out received; hourly roles show hours × wage.
- **All time:** kept total · shifts · avg per shift (since start date).
- **Past shifts:** scannable rows (date · service · amount · ›), "See all N →".
- Footnote: amounts also land in the emailed shift receipt.
Money coming to the person = green `#1a7a3c`; money leaving (tip-out) = red `#9a2c1d`.

## Today's specials & 86 board (screen 6) — read-only for staff
Manager updates it; staff read it before service. Two sections under mono kickers:
- **RUNNING TODAY** — hairline-ruled entries: dish name (serif) · price (mono) · one-line description; optional low flag ("6 left." in amber).
- **86'D — DON'T OFFER** — struck-through names with a red "SOLD OUT" / "86'D {time}" mono tag.
Show "UPDATED {time}" in the header. No white boxes — entries are separated by dotted hairlines.

## Report out of stock (screen 7) — multi-item
Staff build a **list of multiple items** in one report and send them together.
- **Your list** — each item is a row with a colored left status bar + status tag (OUT red / LOW amber / ORDER blue) + optional note + an ✕ to remove. No white boxes; rows separated by dotted hairlines.
- **Add an item** composer under a kicker: item name field (type or pick), a 3-way status toggle (Out / Low / Order — selected uses its color as a 1.5px border), optional underlined note field, "+ Add" ink button. "+ Add another item" repeats it.
- One sticky ink button at the bottom: "Send N items to manager". "Recently sent" line beneath.
Sends straight to the manager (goes to the owner/GM). Needs a manager-side inbox (dependency, not in this spec).

## Tokens (day / paper — default)
Page `#f4ead9` · field surface `#fffdf9` · ink `#1f1d1a` · body `#3a382f` · secondary `#5c5647` · muted `#77705f` · faint `#a89f8a` · accent blue `#2451c9` · amber `#8a4a10` (tags `#c99a12`) · red `#9a2c1d` · green `#1a7a3c` · field border `#cabfa4`/`#d3c6ac` · dotted row rule `1px dotted #cfc2a6` · section-kicker rule `1px solid #1f1d1a`.
Night theme (if a toggle is added later): page `#191815` · surface `#211f1b` · cream ink `#eae6d9` · headings `#f3f0e6` · body `#c8c2b0` · muted `#8f8a7a` · blue `#8fa8ff` · amber `#d9a05b` · green `#5fc389` · hairline `#35332c` / dotted `#403d33`.

## Type & rules
- Newsreader (500) for greetings, task headlines, dish names, page titles — nothing else. Geist for UI. Geist Mono for all money, counts, dates, kickers.
- Radius 0, no shadows, no white cards — structure from hairlines and colored left-bars. Color only for meaning.
- Min 44px tap targets. Everything a staffer submits stays editable until the manager sends the shift.

## Dependencies to flag (not designed here)
- Manager composer for "Before your shift" notes (with expiry date).
- Manager inbox for out-of-stock reports.
- Manager editor for specials / 86 board.

If a visual detail is ambiguous, read the exact value from the matching screenshot.
