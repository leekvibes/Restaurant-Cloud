'use strict';

// The upload flow end to end: save an invoice, and the confident product lines
// should already be in by the time the page reloads.
//
// This exists because the unit tests all fed the matcher line objects directly,
// and the real path doesn't. The route re-serialises what the reader returned
// before storing it, and that step was quietly dropping the item code, brand
// and pack size — so matching in production was name-only while every test
// said otherwise. A test that skips the transport skips the bug.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3969;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-inv-'));
const DB = path.join(dir, 'inv.db');
let child;
let Database;

const VENDOR = 1;

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  // A vendor, and two products we already buy.
  const db = new Database(DB);
  db.prepare('INSERT INTO m_vendors (id, name, category) VALUES (?, ?, ?)').run(VENDOR, 'Baldor', 'Produce');
  db.prepare(`INSERT INTO products (name, category, vendor_id, unit, pack_size, brand)
    VALUES ('Roma tomatoes','Produce',?,'case','25 LB',NULL)`).run(VENDOR);
  db.prepare(`INSERT INTO products (name, category, vendor_id, unit, pack_size, brand)
    VALUES ('Olive oil','Dry goods',?,'case','4/3 L','Colavita')`).run(VENDOR);
  db.close();
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

const LINES = [
  // exact name, same vendor, same pack and unit, with the vendor's own code
  { description: 'Roma tomatoes', code: 'BLD-4412', pack_size: '25 LB', unit: 'case', qty: 3, unit_price: 45.10, total: 135.30 },
  // exact name, same vendor, brand and pack agree
  { description: 'Olive oil', brand: 'Colavita', pack_size: '4/3 L', unit: 'case', qty: 2, unit_price: 110, total: 220 },
  // the case the brief calls out: must NOT silently become "Olive oil"
  { description: 'Extra Virgin Olive Oil 4/3L', brand: 'Pompeian', pack_size: '4/3 L', unit: 'case', qty: 1, unit_price: 98, total: 98 },
  // Same name, same vendor — only the pack size differs. Without pack size
  // surviving the round trip this reads as a certain match and imports itself,
  // filing a 1 L bottle against the price history of a 4/3 L case.
  { description: 'Olive oil', pack_size: '1 L', qty: 6, unit_price: 12.40, total: 74.40 },
  // Same again for brand: identical name and vendor, different label. Aimed at
  // Olive oil because that is the product carrying a brand — a conflict needs
  // something on both sides to conflict with.
  { description: 'Olive oil', brand: 'Pompeian', qty: 1, unit_price: 39, total: 39 },
  // never a product
  { description: 'Fuel surcharge', total: 14.50 },
];

test('saving an invoice imports the confident lines and leaves the rest', async () => {
  const res = await post('/c/invoices', {
    amount: '467.80', subtotal: '453.30', tax: '14.50', vendor_id: String(VENDOR),
    invoice_date: '2026-07-19', invoice_number: 'BLD-55231', category: 'Food',
    status: 'Unpaid', payment_method: 'ACH', ai_status: 'ai', ai_confidence: 'high',
    ai_lines: JSON.stringify(LINES),
  });
  assert.strictEqual(res.status, 302);
  const to = res.headers.get('location') || '';
  assert.match(to, /\/import/, 'sends you to decide the leftovers');
  assert.match(decodeURIComponent(to), /2 products imported/, 'and says what already went in');

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare('SELECT * FROM m_invoices ORDER BY id DESC LIMIT 1').get();
  const bought = db.prepare(`SELECT p.name, pp.total_cents, pp.qty, pp.raw_text
    FROM product_purchases pp JOIN products p ON p.id = pp.product_id
    WHERE pp.invoice_id = ? ORDER BY p.name`).all(inv.id);
  const aliases = db.prepare('SELECT * FROM product_aliases').all();
  const products = db.prepare('SELECT name FROM products ORDER BY name').all().map((r) => r.name);
  db.close();

  assert.strictEqual(inv.payment_method, 'ACH', 'payment method is stored');

  assert.deepStrictEqual(bought.map((b) => b.name), ['Olive oil', 'Roma tomatoes'],
    'only the two certain lines went in');
  assert.strictEqual(bought.find((b) => b.name === 'Roma tomatoes').total_cents, 13530);
  // Each certain line imported once: the pack-size and brand variants share a
  // name with a product we buy and must not have been swept in with it.
  assert.strictEqual(bought.length, 2, `expected 2 purchases, got ${JSON.stringify(bought)}`);

  // The bug this file exists for: the code has to survive the round trip
  // through the form, or the next invoice from this vendor starts from scratch.
  const coded = aliases.find((a) => a.code === 'BLD-4412');
  assert.ok(coded, `the vendor item code was not learned — aliases: ${JSON.stringify(aliases)}`);

  // Neither uncertain line may create anything on its own.
  assert.ok(!products.includes('Extra Virgin Olive Oil 4/3L'), 'an uncertain match is not auto-created');
  assert.ok(!products.includes('Fuel surcharge'), 'a charge is never a product');
  assert.strictEqual(products.length, 2, 'still just the two products we started with');
});

test('the import screen offers only what still needs deciding', async () => {
  const db = new Database(DB, { readonly: true });
  const id = db.prepare('SELECT id FROM m_invoices ORDER BY id DESC LIMIT 1').get().id;
  db.close();

  const html = await (await fetch(`${BASE}/c/invoices/${id}/import`)).text();
  assert.ok(html.includes('Extra Virgin Olive Oil 4/3L'), 'the uncertain line is offered');
  assert.ok(html.includes('imported automatically'), 'and it says what already went in');
  // Asking again about a line that is already in would be asking twice.
  const shown = [...html.matchAll(/iline-d">(.*?)<\/div>/g)].map((m) => m[1]);
  assert.ok(!shown.includes('Roma tomatoes'), 'an imported line is not shown again');
  assert.ok(!shown.includes('Fuel surcharge'), 'and a charge is never offered');
});

test('re-saving does not double-count a delivery', async () => {
  const db0 = new Database(DB, { readonly: true });
  const id = db0.prepare('SELECT id FROM m_invoices ORDER BY id DESC LIMIT 1').get().id;
  const before = db0.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(id).n;
  db0.close();

  // Submitting the leftovers must not re-add the lines that went in on save.
  // Deliberately re-submit an already-imported line as a match, which is what
  // a stale tab or a double-click does. Skipping it would never reach the
  // guard that makes this safe.
  const db1 = new Database(DB, { readonly: true });
  const pid = db1.prepare("SELECT id FROM products WHERE name = 'Roma tomatoes'").get().id;
  db1.close();
  await post(`/c/invoices/${id}/import`, {
    count: '1', action_0: 'match', product_0: String(pid),
    desc_0: 'Roma tomatoes', qty_0: '3', unit_0: 'case', total_0: '13530', price_0: '4510',
  });

  const db = new Database(DB, { readonly: true });
  const after = db.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(id).n;
  db.close();
  assert.strictEqual(after, before, 'no duplicate purchase rows');
});
