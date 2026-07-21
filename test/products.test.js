'use strict';

// Products derives every figure it shows — last price, average, high, low,
// trend, spend — from the purchase rows on read. That's the right call, but it
// means a wrong query is a wrong number on the page with nothing to compare it
// against, so the arithmetic is pinned here against hand-worked examples.
//
// The matching tests matter for a different reason: a wrong match writes a
// price into the history of a product nobody bought, and the resulting trend
// looks perfectly plausible.

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const { q, matchProduct, reviewRows, trendOf } = require('../src/products');

/** Runs fn against scratch rows and always rolls them back. */
function scratch(fn) {
  db.exec('BEGIN');
  try { return fn(); } finally { db.exec('ROLLBACK'); }
}

const ARGS = { from_month: '2026-07-01', from_year: '2026-01-01' };

function makeProduct(name) {
  return q.add.run({ name, category: null, vendor_id: null, unit: null, pack_size: null, sku: null, brand: null, notes: null }).lastInsertRowid;
}
function buy(productId, on, unitCents, qty = 1) {
  q.addPurchase.run({
    product_id: productId, invoice_id: null, vendor_id: null, purchased_on: on,
    qty, unit: null, unit_price_cents: unitCents, total_cents: unitCents * qty, raw_text: null,
  });
}

test('the derived figures match the purchases they come from', () => {
  scratch(() => {
    const id = makeProduct('__test widget__');
    buy(id, '2026-05-01', 1000, 2);   // $20.00
    buy(id, '2026-06-01', 1400, 1);   // $14.00
    buy(id, '2026-07-05', 1200, 3);   // $36.00
    const p = q.one.get({ ...ARGS, id });

    assert.strictEqual(p.buys, 3);
    assert.strictEqual(p.spend_all, 2000 + 1400 + 3600);
    assert.strictEqual(p.low_price, 1000);
    assert.strictEqual(p.high_price, 1400);
    assert.strictEqual(p.avg_price, 1200, '(1000+1400+1200)/3');
    assert.strictEqual(p.last_price, 1200, 'newest purchase, not the biggest');
    assert.strictEqual(p.prior_price, 1200, '(1000+1400)/2 — everything before the newest');
    assert.strictEqual(p.last_on, '2026-07-05');
    assert.strictEqual(p.first_on, '2026-05-01');
    assert.strictEqual(p.spend_month, 3600, 'July only');
    assert.strictEqual(p.spend_year, 7000, 'all three are 2026');
  });
});

test('the trend compares the newest price against the average before it', () => {
  scratch(() => {
    const id = makeProduct('__test oil__');
    buy(id, '2026-04-01', 1000);
    buy(id, '2026-05-01', 1000);
    buy(id, '2026-06-01', 1200);      // newest: 20% over the 1000 average
    assert.strictEqual(trendOf(q.one.get({ ...ARGS, id })), 20);
  });
});

test('one purchase has no trend — there is nothing to compare it to', () => {
  scratch(() => {
    const id = makeProduct('__test once__');
    buy(id, '2026-06-01', 5000);
    const p = q.one.get({ ...ARGS, id });
    assert.strictEqual(p.last_price, 5000);
    assert.strictEqual(p.prior_price, null);
    assert.strictEqual(trendOf(p), null, 'no invented trend from a single price');
  });
});

test('a product never bought reports zeros, not nulls that break the page', () => {
  scratch(() => {
    const p = q.one.get({ ...ARGS, id: makeProduct('__test unbought__') });
    assert.strictEqual(p.buys, 0);
    assert.strictEqual(p.spend_all, 0);
    assert.strictEqual(p.spend_month, 0);
    assert.strictEqual(p.last_price, null);
    assert.strictEqual(trendOf(p), null);
  });
});

test('purchases with no unit price are left out of the price figures', () => {
  scratch(() => {
    const id = makeProduct('__test mixed__');
    buy(id, '2026-06-01', 1000);
    q.addPurchase.run({                       // a manual entry with a total only
      product_id: id, invoice_id: null, vendor_id: null, purchased_on: '2026-06-15',
      qty: null, unit: null, unit_price_cents: null, total_cents: 9999, raw_text: null,
    });
    const p = q.one.get({ ...ARGS, id });
    assert.strictEqual(p.buys, 2, 'still counts as a purchase');
    assert.strictEqual(p.spend_all, 1000 + 9999, 'and still counts toward spend');
    assert.strictEqual(p.avg_price, 1000, 'but cannot drag the average price');
    assert.strictEqual(p.last_price, 1000);
  });
});

// --- matching printed invoice lines to products we know ---------------------

const CATALOG = [
  { id: 1, name: 'Tomatoes' }, { id: 2, name: 'Tomato paste' },
  { id: 3, name: 'Ribeye' },
  // The generic name is listed FIRST on purpose. If it came second, taking the
  // first hit and taking the longest hit would agree, and the tiebreak below
  // would be tested by a case that cannot fail.
  { id: 5, name: 'Olive oil' },
  { id: 4, name: 'Extra virgin olive oil' },
];

test('a line matches its product regardless of case and punctuation', () => {
  assert.strictEqual(matchProduct('RIBEYE', CATALOG).id, 3);
  assert.strictEqual(matchProduct('  ribeye  ', CATALOG).id, 3);
  assert.strictEqual(matchProduct('Extra-Virgin Olive Oil', CATALOG).id, 4);
});

test('the longest overlap wins, so a specific line beats a generic product', () => {
  assert.strictEqual(matchProduct('TOMATO PASTE #10', CATALOG).id, 2, 'not plain Tomatoes');
  // The real tiebreak: this line contains BOTH "olive oil" and "extra virgin
  // olive oil", and the generic one is earlier in the list. Taking the first
  // hit would file a $110 case of EVOO under plain olive oil, and both
  // products' price trends would move for reasons nobody could see.
  assert.strictEqual(matchProduct('EXTRA VIRGIN OLIVE OIL 4/3L', CATALOG).id, 4);
  // And it works the other way round — a plain line still finds the plain one.
  assert.strictEqual(matchProduct('OLIVE OIL', CATALOG).id, 5);
});

test('an unfamiliar line is not forced onto the nearest product', () => {
  assert.strictEqual(matchProduct('Yellow onions 50lb', CATALOG), null);
  assert.strictEqual(matchProduct('', CATALOG), null);
  assert.strictEqual(matchProduct('   ', CATALOG), null);
});

test('charges that are not products default to skip', () => {
  const rows = reviewRows([
    { description: 'Ribeye', qty: 2, unit: 'lb', unit_price: 30, total: 60 },
    { description: 'Delivery charge', qty: 0, unit: '', unit_price: 0, total: 12 },
    { description: 'Fuel surcharge', total: 8 },
    { description: 'Sales tax', total: 4.2 },
    { description: 'Yellow onions', qty: 1, total: 28.5 },
  ], CATALOG);

  assert.deepStrictEqual(rows.map((r) => r.action), ['match', 'skip', 'skip', 'skip', 'create']);
  assert.strictEqual(rows[0].match.id, 3);
  assert.ok(rows[1].fee && rows[2].fee && rows[3].fee, 'flagged as charges, not hidden');
  assert.strictEqual(rows[4].action, 'create', 'a real product we do not know yet');
});

test('a missing unit price is worked out from the quantity, not left blank', () => {
  const [r] = reviewRows([{ description: 'Yellow onions', qty: 4, total: 30 }], CATALOG);
  assert.strictEqual(r.total_cents, 3000);
  assert.strictEqual(r.unit_price_cents, 750, '$30 over 4 = $7.50 each');
});

test('money crosses from the reader in dollars and lands in cents', () => {
  const [r] = reviewRows([{ description: 'Ribeye', qty: 1, unit_price: 32.4, total: 32.4 }], CATALOG);
  assert.strictEqual(r.total_cents, 3240, 'not 32.4, and not 3239.9999');
  assert.strictEqual(r.unit_price_cents, 3240);
});

// --- matching on more than the name -----------------------------------------
// A name alone can't tell two suppliers' tomatoes apart, or a bottle of oil
// from a case of it. These pin each signal separately, because a scoring
// function that happens to give the right answer for the wrong reason is a
// scoring function that will give the wrong answer as soon as the data shifts.

const { matchLine, scoreMatch, learnAlias, mergeProducts, likelyDuplicates, HIGH, MED } = require('../src/products');

const SYSCO = 3, BALDOR = 5;
const NO_ALIASES = new Map();
const line = (o) => ({ desc: '', code: '', brand: '', pack_size: '', unit: '', vendor_id: null, ...o });
const prod = (o) => ({ id: 1, name: '', category: null, vendor_id: null, unit: null, pack_size: null, sku: null, brand: null, ...o });

test('the same vendor raises confidence, a different one lowers it', () => {
  const p = prod({ name: 'Roma tomatoes', vendor_id: BALDOR });
  const same = scoreMatch(line({ desc: 'Roma tomatoes', vendor_id: BALDOR }), p).score;
  const other = scoreMatch(line({ desc: 'Roma tomatoes', vendor_id: SYSCO }), p).score;
  const unknown = scoreMatch(line({ desc: 'Roma tomatoes' }), p).score;

  // Asserted against the no-vendor baseline in BOTH directions. Comparing the
  // two vendor cases to each other only proves that one of the bonus and the
  // penalty exists — delete either and the ordering still holds.
  assert.ok(same > unknown, 'a matching vendor is worth something on its own');
  assert.ok(other < unknown, 'a conflicting vendor costs something on its own');

  assert.ok(same >= HIGH, 'same name from the same vendor is a confident match');
  // Buying the same thing from a second supplier is normal, so a different
  // vendor must not rule the match out — only make it worth a glance. This is
  // the decision that matters, so it is what gets asserted.
  assert.ok(other >= MED && other < HIGH, `cross-vendor should ask, not auto-match (got ${other})`);
});

test('a different pack size pulls a same-name line out of confident territory', () => {
  const p = prod({ name: 'Olive oil', vendor_id: SYSCO, pack_size: '4/3 L' });
  const same = scoreMatch(line({ desc: 'Olive oil', vendor_id: SYSCO, pack_size: '4/3L' }), p).score;
  const diff = scoreMatch(line({ desc: 'Olive oil', vendor_id: SYSCO, pack_size: '1 L' }), p).score;
  assert.ok(same >= HIGH, 'punctuation in a pack size is noise: 4/3 L is 4/3L');
  assert.ok(diff < same, 'a real pack difference costs it');
  assert.ok(diff < HIGH, 'and stops it matching on its own');
});

test('a case is not a pound — a unit mismatch costs the match', () => {
  const p = prod({ name: 'Tomatoes', vendor_id: BALDOR, unit: 'case' });
  const same = scoreMatch(line({ desc: 'Tomatoes', vendor_id: BALDOR, unit: 'case' }), p).score;
  const diff = scoreMatch(line({ desc: 'Tomatoes', vendor_id: BALDOR, unit: 'lb' }), p).score;
  assert.ok(diff < same);
  assert.ok(diff < HIGH, 'billed by the pound is not the same product as billed by the case');
});

test('brand agreement helps and brand conflict hurts', () => {
  const p = prod({ name: 'Olive oil', brand: 'Colavita' });
  const same = scoreMatch(line({ desc: 'Olive oil', brand: 'Colavita' }), p).score;
  const diff = scoreMatch(line({ desc: 'Olive oil', brand: 'Pompeian' }), p).score;
  const none = scoreMatch(line({ desc: 'Olive oil' }), p).score;   // no brand printed
  // Both sides measured against the silent case, so removing either the bonus
  // or the penalty fails here rather than hiding behind the other.
  assert.ok(same > none, 'a matching brand adds confidence');
  assert.ok(diff < none, 'a conflicting brand removes it');
});

test("a vendor's item code matches outright, whatever the line says", () => {
  // Invoices abbreviate past recognition. The code is the one thing a supplier
  // is consistent about, so once it's known it beats the wording entirely.
  const p = prod({ id: 7, name: 'Roma tomatoes', vendor_id: BALDOR });
  const aliases = new Map([[7, [{ product_id: 7, vendor_id: BALDOR, code: 'BLD-4412', alias: null }]]]);
  const r = matchLine(line({ desc: 'TOM RMA 6/6 XFCY', code: 'BLD-4412', vendor_id: BALDOR }), [p], aliases);
  assert.strictEqual(r.product.id, 7);
  assert.strictEqual(r.confidence, 'high');
  assert.strictEqual(r.score, 100);
});

test('an item code is not trusted across vendors', () => {
  const p = prod({ id: 7, name: 'Roma tomatoes', vendor_id: BALDOR });
  const aliases = new Map([[7, [{ product_id: 7, vendor_id: BALDOR, code: '4412', alias: null }]]]);
  // Sysco's 4412 is some other product entirely. Two suppliers' numbering
  // schemes have nothing to do with each other.
  const r = matchLine(line({ desc: 'PAPER TOWEL', code: '4412', vendor_id: SYSCO }), [p], aliases);
  assert.notStrictEqual(r.score, 100);
  assert.strictEqual(r.confidence, 'low', 'nothing else about the line looks like tomatoes');
});

test('a line confirmed once is recognised outright the next time', () => {
  scratch(() => {
    const id = makeProduct('__test roma__');
    const l = line({ desc: 'TOM RMA 6/6 XFCY', code: 'B-991', vendor_id: BALDOR });
    const cold = matchLine(l, [{ ...prod({ id, name: '__test roma__' }) }], new Map());
    assert.strictEqual(cold.confidence, 'low', 'no way to know that abbreviation cold');

    learnAlias(id, BALDOR, 'B-991', 'TOM RMA 6/6 XFCY');
    const { aliasIndex } = require('../src/products');
    const warm = matchLine(l, [{ ...prod({ id, name: '__test roma__' }) }], aliasIndex());
    assert.strictEqual(warm.confidence, 'high', 'confirming it once teaches it');
    assert.strictEqual(warm.product.id, id);
  });
});

test('confidence decides what happens: match, ask, or create', () => {
  const catalog = [
    prod({ id: 1, name: 'Roma tomatoes', vendor_id: BALDOR, unit: 'case' }),
    prod({ id: 2, name: 'Ribeye', vendor_id: SYSCO, unit: 'lb' }),
  ];
  const rows = reviewRows([
    { description: 'Roma tomatoes', unit: 'case', qty: 1, total: 40 },   // exact + same vendor
    { description: 'Ribeye', unit: 'case', qty: 1, total: 40 },          // name hit, wrong vendor AND unit
    { description: 'Sourdough loaves', qty: 6, total: 30 },              // nothing like it
  ], catalog, BALDOR);

  assert.strictEqual(rows[0].confidence, 'high');
  assert.strictEqual(rows[0].action, 'match', 'high confidence imports on its own');

  assert.strictEqual(rows[1].confidence, 'medium');
  assert.strictEqual(rows[1].action, '', 'medium leaves the choice empty so the form cannot be submitted blind');
  assert.ok(rows[1].match, 'but it still offers the candidate');
  assert.ok(rows[1].why.length, 'and says why it thinks so');

  assert.strictEqual(rows[2].confidence, 'low');
  assert.strictEqual(rows[2].action, 'create');
  assert.strictEqual(rows[2].match, null);
});

// --- merging duplicates -----------------------------------------------------

test('merging moves every purchase and loses no history', () => {
  scratch(() => {
    const keep = makeProduct('__test tomatoes__');
    const dupe = makeProduct('__test tomatos__');
    buy(keep, '2026-05-01', 3000, 1);
    buy(dupe, '2026-06-01', 3200, 2);
    buy(dupe, '2026-07-01', 3400, 1);
    learnAlias(dupe, BALDOR, 'B-77', 'TOMATOS RMA');

    const before = q.one.get({ ...ARGS, id: keep });
    const { moved, name } = mergeProducts(dupe, keep);

    assert.strictEqual(moved, 2, 'both of the duplicate\'s purchases moved');
    assert.strictEqual(name, '__test tomatos__');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM products WHERE id = ?').get(dupe).n, 0, 'duplicate removed');

    const after = q.one.get({ ...ARGS, id: keep });
    assert.strictEqual(after.buys, before.buys + 2);
    assert.strictEqual(after.spend_all, 3000 + 6400 + 3400, 'every line still counted');
    assert.strictEqual(after.last_on, '2026-07-01', 'and the newest is now the merged one');
    assert.strictEqual(after.last_price, 3400);

    // The alias survives, so invoices that used the duplicate's wording still
    // land on the surviving product.
    const aliases = q.aliases.all(keep);
    assert.ok(aliases.some((a) => a.code === 'B-77'), 'vendor code carried across');
    assert.ok(aliases.some((a) => (a.alias || '').includes('test tomatos')), 'the old name is kept as an alias');
  });
});

test('merging fills blanks on the survivor but overwrites nothing', () => {
  scratch(() => {
    const keep = makeProduct('__test keep__');
    const dupe = makeProduct('__test dupe__');
    q.update.run({ id: keep, name: '__test keep__', category: 'Produce', vendor_id: null,
      unit: 'case', pack_size: null, sku: null, brand: null, notes: null });
    q.update.run({ id: dupe, name: '__test dupe__', category: 'Meat', vendor_id: SYSCO,
      unit: 'lb', pack_size: '25 LB', sku: 'S-1', brand: 'Acme', notes: null });

    mergeProducts(dupe, keep);
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(keep);
    assert.strictEqual(p.category, 'Produce', 'a value already set is left alone');
    assert.strictEqual(p.unit, 'case', 'likewise');
    assert.strictEqual(p.vendor_id, SYSCO, 'a blank is filled from the duplicate');
    assert.strictEqual(p.pack_size, '25 LB');
    assert.strictEqual(p.brand, 'Acme');
  });
});

test('a product cannot be merged into itself', () => {
  scratch(() => {
    const id = makeProduct('__test solo__');
    assert.throws(() => mergeProducts(id, id), /itself/);
  });
});

test('likely duplicates are found with the same engine used on invoices', () => {
  scratch(() => {
    const a = makeProduct('__test olive oil__');
    const b = makeProduct('__test olive oil extra virgin__');
    makeProduct('__test paper towels__');
    const all = q.plain.all();
    const hits = likelyDuplicates(all.find((x) => x.id === a), all).map((h) => h.product.id);
    assert.ok(hits.includes(b), 'the near-identical name is suggested');
    assert.ok(!hits.some((id) => (all.find((x) => x.id === id) || {}).name === '__test paper towels__'),
      'and something unrelated is not');
  });
});
