# ZWIN — Staff portal sign-in (build spec)

Scope: the **staff portal PIN sign-in screen only** — the first thing staff see on their phone. Replaces today's "Log your tips." screen with the white "Tap to enter your PIN" input box.

Mobile-only in practice (~99%). Design at **390 × 780px** and treat it as a **static, non-scrolling screen** — everything must fit in one viewport with no scroll.

## Screens (in `screens/`)
- `1-signin-empty.png` — resting state (no digits entered)
- `2-signin-filled-error.png` — 4 digits entered, Continue live, wrong-PIN message shown

## What changed from today
1. **Copy** — "Log your tips." → **"Sign in."** The portal is no longer tips-only. Subhead: "Your 4-digit PIN gets you your shift, tips, specials and pay. Ask your manager if you don't have one."
2. **The white PIN box is gone.** Replaced with **four ruled PIN cells** on the cream page — no filled input, no border box, no "Tap to enter your PIN" placeholder.
3. **Keypad is always visible.** No tap-to-summon, so there is never a dead/empty state. It also means the system keyboard is never used.
4. **ZWIN wordmark** added top-right of the header, opposite the Palm Vintage lockup.
5. **Footer removed** — the "PALM VINTAGE · vb26a6c35da" version line is deleted. (If a build id is needed for support, put it behind a long-press on the PV badge, not on screen.)
6. **Fits one screen** — fixed height, keypad + Continue anchored to the bottom via `margin-top:auto`.

## Layout (top → bottom)
1. **Header** — `padding:16px 20px`, `border-bottom:2px solid #1f1d1a`. Left: 40px circular `1.5px` ink-outlined **PV** badge; then a stacked lockup — "PALM VINTAGE" (Geist Mono 500, 10px, `.16em`, `#77705f`) over "Staff portal" (Geist 600, 15px, ink). Right, pushed with `margin-left:auto`: **ZWIN** (Geist 700, 13px, `.16em`, ink).
2. **Title block** — `padding:26px 20px 0`. "Sign in." in Newsreader 500, 32px, `line-height:1.05`, `letter-spacing:-.01em`. Subhead Geist 400, 14.5px/1.5, `#5c5647`, `text-wrap:pretty`.
3. **PIN row** — `padding:30px 20px 0`. Kicker "YOUR PIN" (Geist Mono 600, 10px, `.14em`, `#8b8574`). Below it a 4-column grid, `gap:14px`, each cell 52px tall:
   - **empty:** `border-bottom:2px solid #cabfa4`
   - **active (next to fill):** `border-bottom:3px solid #2451c9` + a 2×26px blue caret centered
   - **filled:** `border-bottom:2px solid #1f1d1a` + a 13px ink dot centered
   - **error state:** below the row, Geist 500 12.5px `#9a2c1d` — "That PIN didn't match — try again." Clear the cells on error.
4. **Keypad + Continue** — bottom group, `margin-top:auto`, `padding:0 20px 22px`. 3-column grid, `gap:10px`, keys 58px tall, `1px solid #cabfa4` border, digit in Geist Mono 500 24px ink. Order 1–9, then `[empty] 0 ⌫`. The ⌫ key has **no border** (Geist 400 20px). **Pressed key:** `1.5px solid #1f1d1a` + `background:#e9dcc4` + weight 600.
5. **Continue button** — full width, `margin-top:18px`, `padding:16px`, Geist 600 15.5px, centered, "Continue →".
   - **disabled (<4 digits):** `background:#d3c6ac`, text `#8b8574`
   - **enabled (4 digits):** `background:#1f1d1a`, text `#f4ead9`

## Tokens
Page `#f4ead9` · ink `#1f1d1a` · body `#5c5647` · muted `#77705f` · faint `#a89f8a` · kicker `#8b8574` · key border `#cabfa4` · pressed key fill `#e9dcc4` · disabled fill `#d3c6ac` · accent blue `#2451c9` · error red `#9a2c1d`.

## Type
Newsreader 500 for "Sign in." only · Geist for UI copy and buttons · Geist Mono for the kicker, wordmark tracking, and keypad digits.

## Rules
- **Border-radius 0** everywhere except the circular PV badge and the round PIN dots. No shadows, no white surfaces, no filled input fields.
- Keys and the Continue button are ≥58px / ≥50px tall — comfortable thumb targets.
- Keypad is the only input path: suppress the system keyboard entirely.
- Auto-submit is optional; if you keep the explicit Continue, it must enable the moment the 4th digit lands.
- Nothing on this screen scrolls. If a shorter device forces it, shrink the keypad key height before allowing scroll.

If a visual detail is ambiguous, read the exact value from the matching screenshot.
