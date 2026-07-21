'use strict';

// Menu costing arithmetic, on scratch rows that are always rolled back.
//
// The thing worth defending here is that a missing cost never becomes zero. A
// dish costed from holes reports a flattering food cost, which is the number
// somebody prices a menu from.

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const P = require('../src/products');
const M = require('../src/menu');
const U = require('../src/units');

function scratch(fn) {
  db.exec('BEGIN');
  try { return fn(); } finally { db.exec('ROLLBACK'); }
}

let seq = 0;
/** A product with a price and, optionally, what one purchase unit holds. */
function product(opts = {}) {
  const name = opts.name || `__t${++seq}__`;
  const id = P.q.add.run({
    name, category: null, vendor_id: null, unit: opts.unit || 'each',
    pack_size: null, sku: null, brand: null, notes: null,
  }).lastInsertRowid;
  db.prepare('UPDATE products SET pack_qty=?, pack_unit=?, yield_pct=?, manual_price_cents=?, manual_price_on=? WHERE id=?')
    .run(opts.packQty ?? null, opts.packUnit ?? null, opts.yieldPct ?? null,
      opts.price == null ? null : Math.round(opts.price * 100), '2026-07-01', id);
  return id;
}

function item(opts = {}) {
  return M.q.add.run({
    name: opts.name || `__dish${++seq}__`, category: opts.category || 'Sandwiches',
    description: null, notes: null,
    selling_price_cents: opts.sell == null ? null : Math.round(opts.sell * 100),
    target_food_cost_pct: opts.target ?? 28,
    status: opts.status || 'draft',
    is_prep: opts.isPrep ? 1 : 0,
    prep_yield_qty: opts.yieldQty ?? null, prep_yield_unit: opts.yieldUnit ?? null,
  }).lastInsertRowid;
}

function line(itemId, opts) {
  return M.q.addComponent.run({
    menu_item_id: itemId, product_id: opts.product ?? null, ref_item_id: opts.ref ?? null,
    component_type: opts.type || 'ingredient', qty: opts.qty, usage_unit: opts.unit,
    prep_note: null, waste_pct: opts.waste ?? null, group_name: opts.group ?? null,
    sort_order: opts.sort ?? 0,
  }).lastInsertRowid;
}

const dollars = (micros) => Math.round(micros) / 1e6;

// --- the worked example ----------------------------------------------------

test('the sandwich from the brief costs out to the cent', () => {
  scratch(() => {
    const croissant = product({ price: 14.99, unit: 'package', packQty: 12, packUnit: 'each' });
    const bacon = product({ price: 23.60, unit: 'package', packQty: 40, packUnit: 'slice' });
    const egg = product({ price: 2.88, unit: 'case', packQty: 12, packUnit: 'each' });
    const cheese = product({ price: 15.20, unit: 'case', packQty: 80, packUnit: 'slice' });
    const arugula = product({ price: 45.10, unit: 'case', packQty: 25, packUnit: 'lb' });
    const wrap = product({ price: 180.00, unit: 'case', packQty: 1000, packUnit: 'each' });

    const dish = item({ name: '__PV Breakfast__', sell: 14.00, target: 28 });
    line(dish, { product: croissant, qty: 1, unit: 'each', group: 'Main build', sort: 1 });
    line(dish, { product: bacon, qty: 2, unit: 'slice', group: 'Main build', sort: 2 });
    line(dish, { product: egg, qty: 1, unit: 'each', group: 'Main build', sort: 3 });
    line(dish, { product: cheese, qty: 1, unit: 'slice', group: 'Main build', sort: 4 });
    line(dish, { product: arugula, qty: 0.5, unit: 'oz', group: 'Main build', sort: 5 });
    line(dish, { product: wrap, qty: 1, unit: 'each', type: 'packaging', group: 'Packaging', sort: 6 });

    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 0, 'every line costs');
    // 1.2492 + 1.18 + 0.24 + 0.19 + 0.05638 + 0.18
    assert.ok(Math.abs(dollars(c.totalMicros) - 3.09554) < 1e-4, `got ${dollars(c.totalMicros)}`);
    assert.strictEqual(c.totalCents, 310);
    assert.strictEqual(U.microsToCents(c.byType.packaging), 18, 'packaging is split out');
    assert.strictEqual(U.microsToCents(c.byType.ingredient), 292);
    assert.ok(Math.abs(c.foodCostPct - 22.14) < 0.05, `food cost ${c.foodCostPct}`);
    assert.strictEqual(c.grossProfit, 1400 - 310);
    assert.strictEqual(c.status.key, 'on', 'under a 28% target');
  });
});

test('food cost, gross profit and margin follow the formulas', () => {
  scratch(() => {
    const p = product({ price: 4.00, unit: 'each' });
    const dish = item({ sell: 16.00, target: 25 });
    line(dish, { product: p, qty: 1, unit: 'each' });
    const c = M.costItem(dish);
    assert.strictEqual(c.totalCents, 400);
    assert.strictEqual(c.foodCostPct, 25);
    assert.strictEqual(c.grossProfit, 1200);
    assert.strictEqual(c.grossMarginPct, 75);
    assert.strictEqual(c.status.key, 'on', 'exactly on target counts as on target');
  });
});

test('suggested price divides by the target as a fraction, not the number', () => {
  scratch(() => {
    const p = product({ price: 3.61, unit: 'each' });
    const dish = item({ sell: 14.00, target: 28 });
    line(dish, { product: p, qty: 1, unit: 'each' });
    const c = M.costItem(dish);
    // The brief says cost / target, which would be $3.61/28 = $0.13.
    assert.strictEqual(c.suggestedCents, Math.round(361 / 0.28));
    assert.ok(c.suggestedCents > 1200 && c.suggestedCents < 1400, `got ${c.suggestedCents}`);
  });
});

// --- missing costs ---------------------------------------------------------

test('a component with no price is unresolved, never zero', () => {
  scratch(() => {
    const priced = product({ price: 2.00, unit: 'each' });
    const unpriced = product({ unit: 'each' });                    // no price at all
    const dish = item({ sell: 10.00 });
    line(dish, { product: priced, qty: 1, unit: 'each' });
    line(dish, { product: unpriced, qty: 1, unit: 'each' });

    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 1);
    assert.strictEqual(c.totalCents, 200, 'only what is actually known');
    const bad = c.lines.find((l) => !l.ok);
    assert.strictEqual(bad.lineMicros, null, 'no number on the line');
    assert.match(bad.reason, /price/i);
    assert.strictEqual(c.status.key, 'missing', 'and the dish says so');
  });
});

test('a conceptual purchase unit with no pack info is unresolved', () => {
  scratch(() => {
    const loaf = product({ price: 6.00, unit: 'loaf' });            // no slices stated
    const dish = item({ sell: 9.00 });
    line(dish, { product: loaf, qty: 1, unit: 'slice' });
    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 1);
    assert.strictEqual(c.totalCents, 0);
    assert.match(c.lines[0].reason, /contains/i);
  });
});

test('an impossible conversion is unresolved rather than approximated', () => {
  scratch(() => {
    const oil = product({ price: 110.00, unit: 'case', packQty: 12, packUnit: 'l' });
    const dish = item({ sell: 12.00 });
    line(dish, { product: oil, qty: 4, unit: 'oz' });               // mass from volume
    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 1);
    assert.match(c.lines[0].reason, /don't convert/);
  });
});

test('a line with no quantity does not silently cost nothing', () => {
  scratch(() => {
    const p = product({ price: 5.00, unit: 'each' });
    const dish = item({ sell: 10.00 });
    line(dish, { product: p, qty: 0, unit: 'each' });
    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 1);
    assert.match(c.lines[0].reason, /quantity/i);
  });
});

test('a product in a recipe cannot be deleted out from under it', () => {
  scratch(() => {
    const p = product({ price: 5.00, unit: 'each' });
    const dish = item({ sell: 10.00 });
    line(dish, { product: p, qty: 1, unit: 'each' });
    // The foreign key refuses, which is the point — a recipe line pointing at
    // nothing is worse than a product that outlives its usefulness.
    assert.throws(() => db.prepare('DELETE FROM products WHERE id = ?').run(p), /FOREIGN KEY/i);
    assert.deepStrictEqual(M.usedBy(p).map((x) => x.id), [dish], 'and we can say what is using it');
  });
});

test('food cost is unanswerable without a selling price, not zero or infinite', () => {
  scratch(() => {
    const p = product({ price: 3.00, unit: 'each' });
    const dish = item({ sell: null });
    line(dish, { product: p, qty: 1, unit: 'each' });
    const c = M.costItem(dish);
    assert.strictEqual(c.foodCostPct, null);
    assert.strictEqual(c.grossProfit, null);
    assert.strictEqual(c.grossMarginPct, null);
    assert.strictEqual(c.status.key, 'noprice');
  });
});

// --- yield and waste -------------------------------------------------------

test('product yield and line waste both apply, and only once each', () => {
  scratch(() => {
    // 90% usable after trimming, then 20% of what is prepped is lost.
    const toms = product({ price: 20.00, unit: 'lb', yieldPct: 90 });
    const dish = item({ sell: 10.00 });
    line(dish, { product: toms, qty: 1, unit: 'lb', waste: 20 });
    const c = M.costItem(dish);
    const expected = (20 / 0.9) * 1 * (1 / 0.8);
    assert.ok(Math.abs(dollars(c.totalMicros) - expected) < 1e-4, `got ${dollars(c.totalMicros)}, want ${expected}`);
  });
});

test('waste of 100% is refused rather than dividing by zero', () => {
  scratch(() => {
    const p = product({ price: 10.00, unit: 'lb' });
    const dish = item({ sell: 10.00 });
    line(dish, { product: p, qty: 1, unit: 'lb', waste: 100 });
    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 1);
    assert.match(c.lines[0].reason, /nothing/i);
  });
});

// --- preps -----------------------------------------------------------------

test('a house prep costs from its own ingredients, spread over its yield', () => {
  scratch(() => {
    const mayo = product({ price: 8.00, unit: 'case', packQty: 128, packUnit: 'floz' });
    const sriracha = product({ price: 6.40, unit: 'bottle', packQty: 17, packUnit: 'floz' });

    // A batch: 30 fl oz mayo + 2 fl oz sriracha, makes 32 fl oz.
    const prep = item({ name: '__Spicy mayo__', isPrep: true, yieldQty: 32, yieldUnit: 'floz', sell: null });
    line(prep, { product: mayo, qty: 30, unit: 'floz' });
    line(prep, { product: sriracha, qty: 2, unit: 'floz' });

    const batch = M.costItem(prep);
    const expected = (8 / 128) * 30 + (6.40 / 17) * 2;
    assert.ok(Math.abs(dollars(batch.totalMicros) - expected) < 1e-4);

    const dish = item({ sell: 12.00 });
    line(dish, { ref: prep, qty: 0.4, unit: 'floz', type: 'condiment' });
    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 0);
    assert.ok(Math.abs(dollars(c.totalMicros) - (expected / 32) * 0.4) < 1e-4);
    assert.ok(c.lines[0].isPrep);
  });
});

test('a prep gets more expensive when its ingredients do — the point of preps', () => {
  scratch(() => {
    const mayo = product({ price: 8.00, unit: 'case', packQty: 128, packUnit: 'floz' });
    const prep = item({ isPrep: true, yieldQty: 32, yieldUnit: 'floz' });
    line(prep, { product: mayo, qty: 32, unit: 'floz' });
    const dish = item({ sell: 12.00 });
    line(dish, { ref: prep, qty: 1, unit: 'floz', type: 'condiment' });

    const before = M.costItem(dish).totalMicros;
    db.prepare('UPDATE products SET manual_price_cents = ? WHERE id = ?').run(1600, mayo);
    const after = M.costItem(dish).totalMicros;
    assert.ok(after > before * 1.9, 'doubling the mayo roughly doubles the dish line');
  });
});

test('a prep with no stated yield is unresolved', () => {
  scratch(() => {
    const p = product({ price: 5.00, unit: 'floz' });
    const prep = item({ isPrep: true });                 // no yield
    line(prep, { product: p, qty: 4, unit: 'floz' });
    const dish = item({ sell: 10.00 });
    line(dish, { ref: prep, qty: 1, unit: 'floz' });
    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 1);
    assert.match(c.lines[0].reason, /makes/i);
  });
});

test('a prep whose own ingredients are unpriced does not pretend to a cost', () => {
  scratch(() => {
    const unpriced = product({ unit: 'floz' });
    const prep = item({ isPrep: true, yieldQty: 16, yieldUnit: 'floz' });
    line(prep, { product: unpriced, qty: 16, unit: 'floz' });
    const dish = item({ sell: 10.00 });
    line(dish, { ref: prep, qty: 1, unit: 'floz' });
    const c = M.costItem(dish);
    assert.strictEqual(c.unresolved, 1);
    assert.strictEqual(c.totalCents, 0);
  });
});

test('a prep that ends up using itself stops instead of recursing forever', () => {
  scratch(() => {
    const a = item({ name: '__loop a__', isPrep: true, yieldQty: 10, yieldUnit: 'floz' });
    const b = item({ name: '__loop b__', isPrep: true, yieldQty: 10, yieldUnit: 'floz' });
    line(a, { ref: b, qty: 1, unit: 'floz' });
    line(b, { ref: a, qty: 1, unit: 'floz' });
    const c = M.costItem(a);                      // must return, not blow the stack
    assert.ok(c.unresolved >= 1);
  });
});

// --- snapshots -------------------------------------------------------------

test('a snapshot is written when the cost moves and skipped when it does not', () => {
  scratch(() => {
    const p = product({ price: 2.00, unit: 'each' });
    const dish = item({ sell: 10.00 });
    line(dish, { product: p, qty: 1, unit: 'each' });

    assert.ok(M.snapshot(dish, 'save'), 'first one is always new');
    assert.strictEqual(M.snapshot(dish, 'save'), null, 'nothing changed, nothing recorded');

    db.prepare('UPDATE products SET manual_price_cents = 250 WHERE id = ?').run(p);
    assert.ok(M.snapshot(dish, 'invoice'), 'a price move is recorded');
    assert.strictEqual(M.q.snapshots.all(dish).length, 2);
  });
});

test('a price change recalculates every dish using that product', () => {
  scratch(() => {
    const p = product({ price: 1.00, unit: 'each' });
    const a = item({ sell: 10.00 }); line(a, { product: p, qty: 1, unit: 'each' });
    const b = item({ sell: 12.00 }); line(b, { product: p, qty: 2, unit: 'each' });
    const other = item({ sell: 9.00 });
    M.snapshot(a, 'save'); M.snapshot(b, 'save'); M.snapshot(other, 'save');

    db.prepare('UPDATE products SET manual_price_cents = 150 WHERE id = ?').run(p);
    const r = M.recalcForProducts([p], 'invoice');
    assert.strictEqual(r.checked, 2, 'only the dishes that use it');
    assert.strictEqual(r.changed, 2);
    assert.strictEqual(M.q.snapshots.all(other).length, 1, 'the unrelated dish is untouched');
  });
});

test('a price change reaches dishes through a prep', () => {
  scratch(() => {
    const p = product({ price: 1.00, unit: 'floz' });
    const prep = item({ isPrep: true, yieldQty: 10, yieldUnit: 'floz' });
    line(prep, { product: p, qty: 10, unit: 'floz' });
    const dish = item({ sell: 10.00 });
    line(dish, { ref: prep, qty: 1, unit: 'floz' });
    M.snapshot(dish, 'save');

    db.prepare('UPDATE products SET manual_price_cents = 200 WHERE id = ?').run(p);
    const r = M.recalcForProducts([p], 'invoice');
    assert.ok(r.ids.includes(dish), 'the dish two steps away was recalculated');
  });
});

test('cost history names which ingredient moved', () => {
  scratch(() => {
    const a = product({ name: '__croissant__', price: 12.00, unit: 'package', packQty: 12, packUnit: 'each' });
    const b = product({ name: '__bacon__', price: 20.00, unit: 'package', packQty: 40, packUnit: 'slice' });
    const dish = item({ sell: 14.00 });
    line(dish, { product: a, qty: 1, unit: 'each' });
    line(dish, { product: b, qty: 2, unit: 'slice' });
    M.snapshot(dish, 'save');

    db.prepare('UPDATE products SET manual_price_cents = 1400 WHERE id = ?').run(a);
    M.snapshot(dish, 'invoice');

    const [newer, older] = M.q.snapshots.all(dish);
    const d = M.drivers(newer, older);
    assert.strictEqual(d.length, 1, 'only the one that moved');
    assert.strictEqual(d[0].label, '__croissant__');
    assert.ok(d[0].delta > 0);
  });
});

// --- validation ------------------------------------------------------------

test('a draft may be incomplete but an active item may not', () => {
  const base = { name: 'X', status: 'draft', selling_price_cents: 1000, target_food_cost_pct: 28 };
  assert.ok(M.validate(base, []).ok, 'an empty draft is fine');

  const active = M.validate({ ...base, status: 'active' }, []);
  assert.strictEqual(active.ok, false);
  assert.match(active.errors.join(' '), /at least one recipe component/i);

  const holes = M.validate({ ...base, status: 'active' }, [{ label: 'A', ok: false }]);
  assert.ok(holes.ok, 'unresolved costs warn rather than block');
  assert.match(holes.warnings.join(' '), /incomplete/i);
});

test('impossible numbers are refused', () => {
  const base = { name: 'X', status: 'draft' };
  assert.match(M.validate({ ...base, selling_price_cents: -1 }, []).errors.join(' '), /negative/i);
  assert.match(M.validate({ ...base, target_food_cost_pct: 0 }, []).errors.join(' '), /target/i);
  assert.match(M.validate({ ...base, target_food_cost_pct: 140 }, []).errors.join(' '), /target/i);
  assert.match(M.validate({ ...base, name: '  ' }, []).errors.join(' '), /name/i);
  assert.match(M.validate(base, [{ label: 'A', qty: -2 }]).errors.join(' '), /negative quantity/i);
  assert.match(M.validate(base, [{ label: 'A', qty: 1, wastePct: 100 }]).errors.join(' '), /waste/i);
  assert.match(M.validate({ ...base, is_prep: 1 }, []).errors.join(' '), /batch/i);
});
