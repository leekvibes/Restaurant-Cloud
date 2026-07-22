# ZWIN — Email templates redesign (build spec)

Scope: the **five transactional emails ONLY**, rebuilt from the old blue-and-white look into the current ZWIN "Broadsheet" style (cream, hairline-ruled, radius 0) so the emails match the app. **Keep every piece of information the current emails carry — this is a visual reskin, not a content change.**

The finished, approved HTML is in this folder — treat these files as the source of truth and port them into `src/email.js`:

| File | Who gets it | When |
|---|---|---|
| `1-server-nightly.html` | each server | manager sends a shift |
| `2-support-nightly.html` | kitchen / barista / bartender / busser | same send |
| `3-manager-receipt.html` | the manager | same send — their receipt |
| `4-pay-period.html` | everyone who worked | manager sends a pay period |
| `5-test-email.html` | whoever is testing | Email settings page |
| `index.html` | preview only — do not ship | — |

## What to do
Replace the markup produced by `shell()` (and each email's body) with the structure in these files. The data bindings are unchanged — every value currently interpolated still maps to the same row. Only the surrounding HTML/CSS changes.

## Hard email constraints (unchanged from today — do not regress)
- **Every row is its own two-cell `<table>`.** Gmail/Outlook strip `display:flex`; keep the table-per-row structure exactly as in these files or rows collapse into "Date2026-07-16".
- **No web fonts.** Newsreader / Geist / Geist Mono do NOT render in most clients. The files use graceful fallbacks — keep these exact stacks:
  - Serif (titles/hero words): `Georgia,'Times New Roman',serif`
  - Sans (labels, body): `-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`
  - Mono (all figures + kickers): `'SFMono-Regular',Consolas,Menlo,monospace`
- All styles inline. Outer wrapper is a full-width `<table>` with a centered 520px inner table, `max-width:100%`.
- No `border-radius`, no `box-shadow`, no gradients.

## Style tokens (day / paper)
| Role | Hex |
|---|---|
| Page background | `#f4ead9` |
| Sheet background | `#f7eee0` |
| Sheet border | `#ddd0b8` |
| Masthead rule (2px) / kicker underline / totals rule | `#1f1d1a` |
| Row hairline | `#e5dac2` |
| Ink text / figures | `#1f1d1a` |
| Label text | `#5c5647` |
| Muted / helper text | `#77705f` |
| Faint (e.g. $0.00, "of 7") | `#a89f8a` |
| Money coming to you (green) | `#1a7a3c` |
| Money leaving / failures (red) | `#9a2c1d` |

Meaning of color is preserved from today: green = money to you, red = money leaving or a delivery failure. (The old blue headline figure is now ink or green depending on meaning — no blue in these emails.)

## Anatomy of each email (top to bottom)
1. **Masthead** — mono uppercase "PALM VINTAGE" kicker, serif title, optional muted subline carrying the who/role/date that used to be their own rows (data unchanged, just relocated).
2. **Hero** — mono kicker + one big (44px) mono figure in the meaning color. Divided from body by a `1px #ddd0b8` rule.
3. **Body sections** — each led by a mono UPPERCASE kicker (`.12em` tracking) with a `1px solid #1f1d1a` underline, then table-per-row label/value pairs separated by `1px #e5dac2`. Totals rows are 16px bold in the meaning color.
4. Helper/footnote text in muted `#77705f` (e.g. pay-period's "isn't extra pay" line).

## Info that must remain (checklist — verify after porting)
- **Server:** hours, estimated wage; Your sales (food, coffee); Your tips (card, cash, total collected); Tip-out (kitchen, barista, busser, total, tips you keep); How this reaches you (cash home, added to paycheck).
- **Support:** role, hours, estimated wage; Your tips (cash, to-go card, server tip-out card, total).
- **Manager:** shift, emails delivered (n of m); Did not go out list + helper; Tonight (tips collected, tipped out, shared pool); Servers list (kept); Support list (per person).
- **Pay period:** period, shifts worked, total hours + week split; On your paycheck (wages, card tips, total); Already paid (cash tips) + helper; "isn't extra pay" footnote.
- **Test:** status + connection sentence.

If a value is missing/zero, follow the same show/hide logic the current code uses; these templates only restyle what already renders.
