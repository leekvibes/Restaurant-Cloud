# ZWIN — Section framing pattern

A **cross-cutting UI pattern**, not a page. It applies to every content page in the app (Dashboard, Shifts, Sales, Payroll, Cash, Invoices, etc.). Goal: make each section on a page read as its own distinct block of data — without loud colored boxes that fight the Broadsheet style. The page still reads as one calm document at rest; the section you're pointing at gently lifts.

See `examples/dashboard-sections.png` and `examples/payroll-sections.png`.

## The pattern

Wrap each logical section (a group of related data with its own kicker heading) in a **framed panel**:

**At rest — barely there:**
- Background: `#f8f0e2` (a whisper warmer than the `#f4ead9` page — the difference is intentional and small)
- Border: `1px solid #e2d6bd` (soft hairline, in-palette)
- Padding: `14–18px`
- The section's kicker heading sits at the top with a `1px solid #e2d6bd` bottom rule under it (mono, UPPERCASE, `.14em` tracking, color `#8b8574`).
- Rows inside stay separated by `1px dotted #d8cbb0` as before.

**On hover — it pops:**
```css
transition: all .15s ease;
/* :hover */
background: #fffdf8;                       /* lifts to paper-white */
border-color: #c7ba9e;                     /* hairline darkens slightly */
box-shadow: 0 4px 16px rgba(31,29,26,.09); /* soft shadow */
transform: translateY(-2px);               /* nudges up 2px */
```

That's the whole effect. No color-filled headers, no heavy black boxes, no changing the page background.

## Rules — when and how to apply it

- **One panel per section.** A section = a kicker heading + its related content (e.g. "NEEDS ATTENTION", "THIS WEEK", "THE RECORD", "SEND THE SUMMARY"). Do **not** wrap individual rows or single stats in their own panel.
- **Keep the resting tint subtle.** `#f8f0e2` on `#f4ead9` is deliberate. Never raise the resting contrast to make sections "obvious" — obviousness comes from hover, not fill.
- **Flag urgency with a hairline, not a fill.** A section that needs attention (e.g. Payroll's "CHECK BEFORE SENDING") gets a single `3px` left border in the meaning color — amber `#8a4a10`, red `#9a2c1d` — and nothing else changes. The panel plane stays the same tint.
- **Border radius 0. No drop shadow at rest** — the shadow only appears on hover.
- **Don't nest panels.** If a section contains sub-groups, separate them with dotted rules inside the one panel, not with more framed panels.
- **Static / print:** the hover lift is progressive enhancement. On touch/print the resting frame alone is enough separation — don't rely on hover to make the layout legible.
- Grid/stat panels (like the 4-up totals row) are a single panel with internal `1px solid #e2d6bd` cell dividers — hover lifts the whole panel, not individual cells.

## Tokens used by this pattern (Day / paper)
| Role | Hex |
|---|---|
| Page background | `#f4ead9` |
| Panel rest background | `#f8f0e2` |
| Panel rest border | `#e2d6bd` |
| Panel hover background | `#fffdf8` |
| Panel hover border | `#c7ba9e` |
| Panel hover shadow | `rgba(31,29,26,.09)` |
| Kicker rule / cell divider | `#e2d6bd` |
| Dotted row rule | `#d8cbb0` |
| Kicker text | `#8b8574` |
| Urgency accent (left border) | amber `#8a4a10` · red `#9a2c1d` |

### Night theme equivalent (same pattern, swap tokens)
| Role | Hex |
|---|---|
| Page background | `#191815` |
| Panel rest background | `#211f1b` |
| Panel rest border | `#35332c` |
| Panel hover background | `#26241d` |
| Panel hover border | `#4a4636` |
| Panel hover shadow | `rgba(0,0,0,.35)` |
| Kicker text | `#8f8a7a` |
| Urgency accent | amber `#d9a05b` · red `#e88a72` |

## Reference implementation
```html
<section class="zwin-panel">
  <div class="zwin-kicker">THIS WEEK</div>
  … rows …
</section>

<style>
.zwin-panel{
  background:#f8f0e2; border:1px solid #e2d6bd; padding:16px 18px;
  border-radius:0; transition:all .15s ease;
}
.zwin-panel:hover{
  background:#fffdf8; border-color:#c7ba9e;
  box-shadow:0 4px 16px rgba(31,29,26,.09); transform:translateY(-2px);
}
.zwin-panel--warn{ border-left:3px solid #8a4a10; }   /* urgency, no fill */
.zwin-panel--critical{ border-left:3px solid #9a2c1d; }
.zwin-kicker{
  font:600 10.5px/1 'Geist Mono',monospace; letter-spacing:.14em;
  text-transform:uppercase; color:#8b8574;
  border-bottom:1px solid #e2d6bd; padding-bottom:8px;
}
</style>
```

Everything else on the page (type, figures in Geist Mono, serif headline, blue accent for actions, meaning-only color) stays exactly as the existing Broadsheet style. This pattern only governs section separation.
