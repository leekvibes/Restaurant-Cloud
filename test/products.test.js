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
  return q.add.run({ name, category: null, vendor_id: null, unit: null, pack_size: null, sku: null, notes: null }).lastInsertRowid;
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
