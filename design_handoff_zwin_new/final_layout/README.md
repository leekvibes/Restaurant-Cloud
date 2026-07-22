# ZWIN — Final Layout (Broadsheet, plain)

The **single approved layout** for the ZWIN redesign. Build to match these six screenshots. Ignore all other mockups — this supersedes them.

## Screenshots (this folder)
| File | Screen | Theme | Source option |
|---|---|---|---|
| `dashboard-day.png` | Dashboard | Day | 6a |
| `dashboard-night.png` | Dashboard | Night | 6b |
| `shifts-index-day.png` | Shifts index | Day | 4a |
| `shifts-index-night.png` | Shifts index | Night | 6c |
| `shift-sheet-day.png` | Shift detail sheet | Day | 4a (4b) |
| `shift-sheet-night.png` | Shift detail sheet | Night | 12a |

Day and Night are the **same layout** — only color tokens change. Implement both as one CSS-variable layer; toggle with the ☾/☀ button in the masthead (default Day, persist per user).

> **Note on the day background:** the dashboard (6a) sits on warm cream `#f7eee0`; the shifts index/sheet (4a) currently sit on paper-white `#fcfbf7`. Pick ONE for consistency — recommended: use cream `#f7eee0` everywhere in day mode.

## Style — plain broadsheet
Flat, hairline-ruled, editorial. Structure from ruled lines and columns only: **no card containers, no drop shadows, border-radius 0**. Serif headlines, monospace figures, one blue accent. (This is the plain look in the screenshots — not a heavily surface-layered variant.)

## Day theme tokens
| Role | Hex |
|---|---|
| Page background | `#f7eee0` (cream) — or `#fcfbf7` on shifts, unify to cream |
| Surface (inputs, search) | `#fffdf8` |
| Ink (text, 2px rules, ink button) | `#1f1d1a` |
| Body text | `#443f33` |
| Secondary | `#5c5647` |
| Muted (labels, meta) | `#77705f` |
| Faint (timestamps, em-dash) | `#a89f8a` |
| Accent · blue (links, actions, active tab) | `#2451c9` |
| Warning · amber (money at risk) | `#9a5b12` |
| Critical · red | `#9a2c1d` |
| Positive · green | `#1a7a3c` |
| Hairline light / lighter | `#ddd0b8` / `#e5dac2` |
| Dotted row rule | `1px dotted #cfc2a6` |

## Night theme tokens
| Role | Hex |
|---|---|
| Page background | `#191815` |
| Surface (inputs) | `#211f1b` |
| Cream ink (text, 2px rules, inverted button bg) | `#eae6d9` |
| Headlines / values | `#f3f0e6` |
| Body text | `#c8c2b0` |
| Secondary / muted | `#8f8a7a` |
| Faint (timestamps, em-dash) | `#6f6a5c` |
| Accent · blue | `#8fa8ff` |
| Warning · amber | `#d9a05b` |
| Positive · green | `#5fc389` |
| Hairline / dotted | `#35332c` · `#2e2c25` · dotted `#403d33` |

## Type
- **Newsreader** (serif, 500) — headline verdicts only.
- **Geist** — all UI, labels, buttons, nav (400/500/600).
- **Geist Mono** — every number, %, count, timestamp, and UPPERCASE section kicker (.14em).

## Content & behavior rules (keep)
- Masthead → nav row → serif verdict headline → ruled columns. Each KPI appears once.
- Dashboard: status-line variants, notices strip (open shift + submission progress bar + red warn line), triage CRITICAL never folds / WARNING 2+fold / INFO collapsed, Last service band, This week (Food/Prime show "—" not 0% when no invoices), Coming up (max 6), writer-only entry chips, The Record = 5 grouped rows.
- Shifts: open-shifts block, all 5 lifecycle states (Open beats Nobody-on-it), month header with "N not sent / all sent", search + chips, stat strip excludes open shifts ("today is never a measurement").
- Shift sheet: verdict headline, 4-stat strip, staff table (per-row Edit), shared tip pool with split-by-hours.
- Color only for meaning. Radius 0, no shadows. Numbers always mono; serif only on headlines.

If a visual detail is ambiguous, read the exact value from the matching screenshot rather than guessing.
