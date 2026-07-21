'use strict';

// Every number in menu costing is downstream of this file. A wrong conversion
// here doesn't look wrong — it produces a confident food-cost percentage that
// happens to be false, which is worse than no number at all. So the awkward
// cases are the point: mass against volume, a loaf against a slice, and the
// sub-cent arithmetic that whole-cent rounding destroys.

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeUnit, convert, parsePack, costPerUnit,
  dollarsToMicros, microsToCents, isConceptual,
} = require('../src/units');

const $ = dollarsToMicros;
/** Cost per usable unit, in dollars, for readable assertions. */
const perUnit = (p, unit) => {
  const r = costPerUnit(p, unit);
  return r.ok ? r.micros / 1e6 : r;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

// --- reading units off an invoice ------------------------------------------

test('units are recognised however the invoice spells them', () => {
  for (const [text, slug] of [['LB', 'lb'], ['lbs', 'lb'], ['Pounds', 'lb'], ['#', 'lb'],
    ['oz.', 'oz'], ['Ounces', 'oz'], ['ct', 'each'], ['COUNT', 'each'], ['ea', 'each'],
    ['fl oz', 'floz'], ['Liters', 'l'], ['gal', 'gal'], ['cs', 'case'], ['pkg', 'package']]) {
    assert.strictEqual(normalizeUnit(text), slug, `${text} -> ${slug}`);
  }
  assert.strictEqual(normalizeUnit('sploops'), null, 'and an unknown word stays unknown');
});

// --- conversion, and refusing to convert -----------------------------------

test('measures convert inside their own dimension', () => {
  assert.ok(near(convert(1, 'lb', 'oz'), 16));
  assert.ok(near(convert(1, 'kg', 'g'), 1000));
  assert.ok(near(convert(1, 'gal', 'floz'), 128));
  assert.ok(near(convert(1, 'cup', 'tbsp'), 16));
  assert.ok(near(convert(1, 'dozen', 'each'), 12), 'a dozen really is twelve');
});

test('mass and volume never convert into each other', () => {
  // The classic kitchen trap: an ounce of flour is not a fluid ounce of milk.
  assert.strictEqual(convert(8, 'oz', 'floz'), null);
  assert.strictEqual(convert(1, 'lb', 'cup'), null);
  assert.strictEqual(convert(1, 'l', 'kg'), null);
});

test('conceptual units convert to nothing, including each other', () => {
  // A loaf is not eight ounces. A slice is not one each. Somebody has to say.
  assert.strictEqual(convert(1, 'loaf', 'slice'), null);
  assert.strictEqual(convert(1, 'case', 'each'), null);
  assert.strictEqual(convert(1, 'slice', 'each'), null);
  assert.strictEqual(convert(1, 'slice', 'serving'), null, 'same dimension, still not the same thing');
  assert.ok(isConceptual('case') && isConceptual('slice') && !isConceptual('lb'));
});

// --- pack sizes, as they actually print ------------------------------------

test('pack sizes are read off the invoice text', () => {
  assert.deepStrictEqual(pick(parsePack('25 LB')), { qty: 25, unit: 'lb' });
  assert.deepStrictEqual(pick(parsePack('5lb')), { qty: 5, unit: 'lb' });
  assert.deepStrictEqual(pick(parsePack('12 count')), { qty: 12, unit: 'each' });
  assert.deepStrictEqual(pick(parsePack('1000 ct')), { qty: 1000, unit: 'each' });
  assert.deepStrictEqual(pick(parsePack('3 L')), { qty: 3, unit: 'l' });
  // outer x inner multiplies out: four 3-litre jugs is twelve litres
  assert.deepStrictEqual(pick(parsePack('4/3 L')), { qty: 12, unit: 'l' });
  assert.deepStrictEqual(pick(parsePack('12/16 oz')), { qty: 192, unit: 'oz' });
  // no inner unit: ten boxes of a hundred is a thousand of them
  assert.deepStrictEqual(pick(parsePack('10/100')), { qty: 1000, unit: 'each' });
  // a #10 is a trade size, not a measure — count the cans, claim nothing more
  assert.deepStrictEqual(pick(parsePack('6/#10')), { qty: 6, unit: 'can' });
  assert.deepStrictEqual(pick(parsePack('LB')), { qty: 1, unit: 'lb' });
});

test('an unreadable pack size returns nothing rather than a guess', () => {
  for (const junk of ['', null, 'assorted', 'see label', 'XL']) {
    assert.strictEqual(parsePack(junk), null, `${JSON.stringify(junk)} is not a pack size`);
  }
});

function pick(r) { return r && { qty: r.qty, unit: r.unit }; }

// --- cost per usable unit --------------------------------------------------

test('bought by the pound, used by the ounce', () => {
  const ribeye = { priceMicros: $(26.50), purchaseUnit: 'lb' };
  assert.ok(near(perUnit(ribeye, 'oz'), 26.50 / 16));
  assert.ok(near(perUnit(ribeye, 'lb'), 26.50));
});

test('bought by the case, used by the ounce', () => {
  // $45.10 a case, 25 lb in a case -> $0.11275 an ounce. Sub-cent, and the
  // reason this whole file works in micro-dollars.
  const toms = { priceMicros: $(45.10), purchaseUnit: 'case', packQty: 25, packUnit: 'lb' };
  const per = perUnit(toms, 'oz');
  assert.ok(near(per, 45.10 / 400), `got ${per}`);
  assert.ok(per < 0.12 && per > 0.11, 'a shade over eleven cents');
  // Rounded to whole cents this line would be 11c — 2.4% adrift on its own,
  // and it compounds across a recipe.
  assert.notStrictEqual(microsToCents(costPerUnit(toms, 'oz').micros) / 100, per);
});

test('the loaf and slice case: yield stated, so it works', () => {
  const bread = { priceMicros: $(6.00), purchaseUnit: 'loaf', packQty: 20, packUnit: 'slice' };
  assert.ok(near(perUnit(bread, 'slice'), 0.30), 'twenty slices from a six dollar loaf');
});

test('the loaf and slice case: yield not stated, so it refuses', () => {
  const bread = { priceMicros: $(6.00), purchaseUnit: 'loaf' };
  const r = costPerUnit(bread, 'slice');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.micros, null, 'no number, not a zero');
  assert.match(r.reason, /contains/i, `says what to do: "${r.reason}"`);
});

test('cheese by the case, sliced: needs slices per case, not pounds', () => {
  // 5 lb of cheese in the case, but the recipe wants slices. Pounds do not
  // become slices on their own however hard you squint.
  const byWeight = { priceMicros: $(24.00), purchaseUnit: 'case', packQty: 5, packUnit: 'lb' };
  const r = costPerUnit(byWeight, 'slice');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /slice/i);
  // Say the case holds 80 slices and it costs out.
  const bySlice = { priceMicros: $(24.00), purchaseUnit: 'case', packQty: 80, packUnit: 'slice' };
  assert.ok(near(perUnit(bySlice, 'slice'), 0.30));
});

test('eggs: a case of twelve, used by the each', () => {
  const eggs = { priceMicros: $(2.88), purchaseUnit: 'case', packQty: 12, packUnit: 'each' };
  assert.ok(near(perUnit(eggs, 'each'), 0.24));
});

test('the croissant example from the brief', () => {
  const c = { priceMicros: $(14.99), purchaseUnit: 'package', packQty: 12, packUnit: 'each' };
  assert.ok(near(perUnit(c, 'each'), 14.99 / 12));
  assert.strictEqual(microsToCents(costPerUnit(c, 'each').micros), 125, '$1.25 once rounded');
});

test('mass against volume is refused with a reason, not costed', () => {
  const oil = { priceMicros: $(110.00), purchaseUnit: 'case', packQty: 12, packUnit: 'l' };
  const r = costPerUnit(oil, 'lb');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /don't convert/);
  // but fluid ounces are fine — same dimension
  assert.ok(near(perUnit(oil, 'floz'), 110 / (12000 / 29.5735295625)));
});

// --- yield -----------------------------------------------------------------

test('usable yield raises the cost of what survives trimming', () => {
  // 10 lb of tomatoes at 90% usable: you paid for 10, you cook with 9.
  const whole = { priceMicros: $(20.00), purchaseUnit: 'lb' };
  const trimmed = { priceMicros: $(20.00), purchaseUnit: 'lb', yieldPct: 90 };
  assert.ok(near(perUnit(whole, 'lb'), 20));
  assert.ok(near(perUnit(trimmed, 'lb'), 20 / 0.9), 'the waste is paid for by what is left');
  assert.ok(perUnit(trimmed, 'lb') > perUnit(whole, 'lb'));
});

test('a nonsense yield is rejected rather than applied', () => {
  for (const y of [0, -10, 140]) {
    const r = costPerUnit({ priceMicros: $(20), purchaseUnit: 'lb', yieldPct: y }, 'lb');
    assert.strictEqual(r.ok, false, `${y}% should be refused`);
    assert.match(r.reason, /yield/i);
  }
});

// --- refusing, loudly ------------------------------------------------------

test('no price means no cost, never a zero', () => {
  for (const price of [0, null, undefined, -5]) {
    const r = costPerUnit({ priceMicros: price, purchaseUnit: 'lb' }, 'oz');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.micros, null, 'a missing price must not read as free');
    assert.match(r.reason, /price/i);
  }
});

test('an unknown usage unit is refused', () => {
  const r = costPerUnit({ priceMicros: $(10), purchaseUnit: 'lb' }, 'smidgen');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /isn't a unit/);
});

test('every refusal explains itself and offers no number', () => {
  const bad = [
    [{ priceMicros: $(6), purchaseUnit: 'case' }, 'oz'],
    [{ priceMicros: $(6), purchaseUnit: 'loaf' }, 'slice'],
    [{ priceMicros: 0, purchaseUnit: 'lb' }, 'oz'],
    [{ priceMicros: $(6), purchaseUnit: 'case', packQty: 4, packUnit: 'l' }, 'lb'],
  ];
  for (const [p, u] of bad) {
    const r = costPerUnit(p, u);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.micros, null);
    assert.ok(r.reason && r.reason.length > 12, `a usable reason, got "${r.reason}"`);
  }
});

// --- precision -------------------------------------------------------------

test('per-line rounding is wrong often enough that we never do it', () => {
  // $1.15 for ten, so 11.5c each — the fraction that rounding always mangles.
  // Six of them is exactly 69c. Round each line first and every one gains half
  // a cent, so the sandwich costs 72c. Three cents on one ingredient, and it
  // compounds across a recipe and then across a menu.
  const p = { priceMicros: $(1.15), purchaseUnit: 'package', packQty: 10, packUnit: 'each' };
  const per = costPerUnit(p, 'each');
  assert.strictEqual(per.micros, 115000, '11.5 cents, held exactly');

  const exact = microsToCents(per.micros * 6);
  const perLine = microsToCents(per.micros) * 6;
  assert.strictEqual(exact, 69, 'six at 11.5c is 69c');
  assert.strictEqual(perLine, 72, 'rounding first inflates it');
  assert.notStrictEqual(exact, perLine);
});

test('a whole recipe totals from exact line costs', () => {
  // The brief's sandwich. Whether per-line rounding happens to agree here is
  // luck of the fractions; the total below is the one that is always right.
  const lines = [
    [{ priceMicros: $(14.99), purchaseUnit: 'package', packQty: 12, packUnit: 'each' }, 'each', 1],
    [{ priceMicros: $(23.60), purchaseUnit: 'package', packQty: 40, packUnit: 'slice' }, 'slice', 2],
    [{ priceMicros: $(2.88), purchaseUnit: 'case', packQty: 12, packUnit: 'each' }, 'each', 1],
    [{ priceMicros: $(15.20), purchaseUnit: 'case', packQty: 80, packUnit: 'slice' }, 'slice', 1],
    [{ priceMicros: $(45.10), purchaseUnit: 'case', packQty: 25, packUnit: 'lb' }, 'oz', 0.5],
  ];
  let exact = 0;
  for (const [p, unit, qty] of lines) {
    const r = costPerUnit(p, unit);
    assert.ok(r.ok, r.reason);
    exact += r.micros * qty;
  }
  // 1.2492 + 1.18 + 0.24 + 0.19 + 0.05638 = 2.9155
  assert.ok(near(exact / 1e6, 2.91554, 1e-4), `got ${exact / 1e6}`);
  assert.strictEqual(microsToCents(exact), 292);
});

test('micro-dollars round to cents only at the end', () => {
  assert.strictEqual(microsToCents($(1.25)), 125);
  assert.strictEqual(microsToCents(112750), 11, '$0.11275 is eleven cents once');
  assert.strictEqual(microsToCents(112750 * 4), 45, 'four of them is 45c, not 44');
});
