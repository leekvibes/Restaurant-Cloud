'use strict';

// NOTHING IN THE STAFF PORTAL ZOOMS BY ITSELF.
//
// An iPhone zooms the whole page in when a typing box under 16px takes the
// cursor, and leaves it zoomed after the box has gone. The document sheet's
// name and date boxes had no size of their own, so every signature opened with
// the screen lurching in; the owner's rule since is that signing, dating, any
// step holds still. What decides it is the stylesheet, so this reads
// staff.css. It was measured in a phone-sized browser when this was written;
// what a reading of the file catches is a box quietly set back to 15px.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
// Comments blanked but their line breaks kept, so a line number still points
// at the rule it names.
const flat = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const rules = [];
for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim();
  rules.push({ sel: sel.replace(/\s+/g, ' '), body: m[2],
    line: flat.slice(0, m.index + m[0].indexOf(sel)).split('\n').length });
}
const sizeOf = (body) => {
  const m = /font-size:\s*([\d.]+)px/.exec(body) || /(?:^|;)\s*font:[^;]*?([\d.]+)px/.exec(body);
  return m ? parseFloat(m[1]) : null;
};
// A selector that names a typing box: by element, or by one of the classes the
// portal puts straight onto a select or an input, whose rules name no element.
const BOX = /(^|[\s>+~,(])(input|select|textarea)(?=$|[\s.#:\[>+~,)])/;
const BOX_CLASSES = /\.(tsp-sel|pt-underline|pes-sel)\b/;
const namesBox = (sel) => sel.split(',')
  .some((s) => (BOX.test(s) && !/checkbox|radio/.test(s)) || BOX_CLASSES.test(s));

test('no rule in the staff stylesheet sizes a typing box under 16px', () => {
  const small = rules.filter((r) => namesBox(r.sel) && sizeOf(r.body) != null && sizeOf(r.body) < 16)
    .map((r) => `staff.css:${r.line} ${r.sel} (${sizeOf(r.body)}px)`);
  assert.deepStrictEqual(small, [], 'an iPhone zooms the page in when any of these takes the cursor');
});

test('a portal box with no size of its own still gets 16px', () => {
  // The document boxes had no rule at all, and nothing above can see a box
  // that has none. This is what catches the next one.
  const floor = rules.find((r) => r.sel === '.pt :where(input, select, textarea)');
  assert.ok(floor, 'the floor rule is there');
  assert.ok(sizeOf(floor.body) >= 16, 'and it is at least 16px');
});

test('the document signing boxes state their own size, 16px or more', () => {
  const r = rules.find((x) => x.sel === '.pdv-f input');
  assert.ok(r, 'the signing sheet styles its boxes');
  assert.ok(sizeOf(r.body) >= 16, `.pdv-f input is ${sizeOf(r.body)}px`);
});

test('the document sheets sit above the tab bar, so Cancel and Back can be tapped', () => {
  // They were on the tab bar's own layer, 60, and the bar is drawn after them,
  // so on a phone it covered the bottom of every sheet: the Cancel on the
  // signature, the Back on the submit sheet. Measured, not supposed: the tab
  // bar was the element under the middle of both buttons.
  const r = rules.find((x) => x.sel === '.pdv-sheet' && /z-index/.test(x.body));
  assert.ok(r, '.pdv-sheet sets a layer');
  assert.match(r.body, /z-index:\s*var\(--pt-z-sheet\)/, 'the sheet layer, the one every other portal sheet uses');
});

test('every sheet capped by height states the one a phone can really show', () => {
  // vh on iPhone Safari is the TALL height, the one with the address bar
  // hidden. A sheet capped in vh alone therefore hangs past the bottom of the
  // screen somebody can see, and because the panel believes it fits, there is
  // nothing to scroll: on the shift sheet that put the PIN and "Send for
  // approval" out of reach entirely, which is what "it will not let me edit the
  // shift" turned out to be. dvh is the visible height; the pair is what .tp
  // and .pt have used since they hit the same thing.
  const bare = [...flat.matchAll(/max-height:\s*(\d+)vh\s*;(?!\s*max-height:\s*\d+dvh)/g)]
    .map((m) => m[0].trim());
  assert.deepStrictEqual(bare, [], 'each of these needs a dvh companion straight after it');
});

test('a double tap never zooms the portal, and a pinch still can', () => {
  const r = rules.find((x) => x.sel === '.pt' && /touch-action/.test(x.body));
  assert.ok(r, '.pt sets touch-action');
  assert.match(r.body, /touch-action:\s*manipulation/,
    'manipulation: scroll and pinch still work; only the double-tap zoom is gone');
});
