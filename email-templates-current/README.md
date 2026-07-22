# ZWIN — the five emails as they are today

Reference for a redesign. Rendered from the live code (after the charset fix and footer removal) with real figures from
the 2026-07-16 dinner service and the Jul 4–17 pay period, so every row that
can appear does. Open the .html files in a browser to inspect the markup.

| File | Who gets it | When |
|---|---|---|
| `1-server-nightly.html` | each server | when the manager sends a shift |
| `2-support-nightly.html` | kitchen, barista, bartender, busser | same send |
| `3-manager-receipt.html` | the manager | same send — their receipt |
| `4-pay-period.html` | everyone who worked | when the manager sends a pay period |
| `5-test-email.html` | whoever is testing | from the Email settings page |

## What they share

All five come from one `shell()` in `src/email.js`: a 520px white card with a
16px radius and a soft shadow, on `#f4f7fc`; a blue gradient header carrying the
restaurant name and a title; an optional centred hero figure in 42px blue; then
label/value rows; then a grey footer line.

Every row is its own two-cell `<table>`. That is deliberate — Gmail and Outlook
strip `display:flex`, which once collapsed every row into "Date2026-07-16".
Whatever the redesign does, it has to hold up under that constraint.

Colour carries meaning: green `#059669` for money coming to you, red `#dc2626`
for money leaving, blue `#2563eb` for the headline figure.

## Notes for the redesign

- This is the **only** part of ZWIN still on the old blue-and-white look. The
  app is now cream, hairline-ruled, radius 0, Newsreader/Geist/Geist Mono.
  These emails and the manager app no longer look like the same product.
- The grey footer ("This is a summary, not a pay stub") has been removed. The
  pay-period email keeps its own line saying the money is not additional,
  because that point was previously split across the two.
- Custom web fonts do not work in most email clients. Newsreader and Geist Mono
  will not render in Gmail or Outlook; a redesign has to fall back gracefully.
