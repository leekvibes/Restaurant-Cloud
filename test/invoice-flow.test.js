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
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
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

  // Charges ARE now listed, in their own group. This used to assert they were
  // hidden. Hiding them meant a delivery fee the reader mistook for a line
  // item — or a real product it mistook for a fee — was invisible and could
  // not be corrected. What matters is not that they are unseen but that they
  // stay OUT of the import unless somebody says otherwise, so that is what is
  // asserted now: shown, grouped, and defaulted to skip.
  assert.ok(shown.includes('Fuel surcharge'), 'a charge is visible');
  assert.match(html, /Charges and fees/, 'in its own group');
  const feeRow = html.slice(html.indexOf('Fuel surcharge'));
  const sel = feeRow.slice(feeRow.indexOf('<select'), feeRow.indexOf('</select>'));
  assert.match(sel, /value="skip" selected/, 'and it defaults to skip, so nothing imports by itself');
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

test('a decision on a late line is not silently dropped', async () => {
  // The bug this covers shipped and was live.
  //
  // Field names carry the line's index in the WHOLE invoice — action_3,
  // action_7 — because that is what the imported-index set is keyed on. The
  // handler looped 0..count-1, where count was the number of rows ON SCREEN.
  // Those only coincide when the reviewable lines are the first ones. In the
  // ordinary case — early lines auto-imported, later ones needing a decision —
  // the operator chose, pressed Import, and the choice was read as undefined
  // and thrown away.
  const db = new Database(DB);
  const vend = db.prepare('SELECT id FROM m_vendors LIMIT 1').get();
  // Two lines the matcher cannot place, at indexes 1 and 2, behind one it can.
  const lines = [
    { description: 'Roma tomatoes', qty: 1, unit_price: 10, total: 10 },
    { description: 'Qqx Zeta Widget', qty: 1, unit_price: 11, total: 11 },
    { description: 'Qqx Omega Widget', qty: 1, unit_price: 12, total: 12 },
  ];
  const id = db.prepare(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, status, ai_lines)
    VALUES ('2026-02-02', ?, 3300, 'Unpaid', ?)`).run(String(vend.id), JSON.stringify(lines)).lastInsertRowid;
  db.close();

  const html = await (await fetch(`${BASE}/c/invoices/${id}/import`)).text();
  const idx = (html.match(/name="idx" value="([^"]*)"/) || [])[1];
  assert.ok(idx, 'the form states which lines it carries');
  const carried = idx.split(',').map(Number);
  assert.ok(Math.max(...carried) >= carried.length,
    `this only proves anything when an index runs past the row count: ${idx}`);

  // Decide on every line the form offered, exactly as the screen would post.
  const body = new URLSearchParams({ count: String(carried.length), idx });
  for (const i of carried) {
    body.set(`action_${i}`, 'create');
    body.set(`desc_${i}`, lines[i].description);
    body.set(`total_${i}`, String(Math.round(lines[i].total * 100)));
    body.set(`qty_${i}`, String(lines[i].qty));
  }
  const res = await fetch(`${BASE}/c/invoices/${id}/import`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.strictEqual(res.status, 302);

  const after = new Database(DB, { readonly: true });
  const got = after.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(id).n;
  after.close();
  assert.strictEqual(got, carried.length,
    `every decision was recorded, not just the ones at a low index (got ${got} of ${carried.length})`);
});

test('the import screen groups the work and shows why a line is uncertain', async () => {
  const db = new Database(DB, { readonly: true });
  const id = db.prepare("SELECT id FROM m_invoices WHERE ai_lines LIKE '%Olive Oil%' ORDER BY id DESC LIMIT 1").get().id;
  db.close();
  const html = await (await fetch(`${BASE}/c/invoices/${id}/import`)).text();

  // Groups only render when they have something in it — this invoice's
  // leftovers are all uncertain matches, so "likely new" correctly does not
  // appear here. Asserting it did was asserting a group can never be empty.
  assert.match(html, /Needs your decision/, 'uncertain lines have their own group');

  // The invoice made by the previous test is all unmatchable lines, so that
  // is where the "new" group has to show up.
  const db2 = new Database(DB, { readonly: true });
  const newish = db2.prepare("SELECT id FROM m_invoices WHERE ai_lines LIKE '%Qqx%' ORDER BY id DESC LIMIT 1").get();
  db2.close();
  if (newish) {
    const h2 = await (await fetch(`${BASE}/c/invoices/${newish.id}/import`)).text();
    // It may already be imported by the test above, in which case there is
    // nothing left to group — only assert when rows are actually offered.
    if (/class="iline/.test(h2)) assert.match(h2, /Likely new products/, 'new lines get their own group');
  }
  // The reasons were already computed and were being flattened into truncated
  // prose. They are the answer to "why is this uncertain".
  assert.match(html, /class="why/, 'the matcher\'s reasons are on the row');

  // Bulk actions must only ever set a control a person could set by hand.
  assert.match(html, /class="btn btn-sm btn-ghost ibulk"/, 'there are bulk actions');
  assert.ok(!/name="bulk/.test(html), 'and they post no field of their own');

  // A bulk button does what its label says. "Skip all" wired to `create`
  // would import every delivery fee on the invoice with one click, and the
  // label would still read Skip — the mistake nobody would look for.
  const SAFE = { review: 'match', new: 'create', charges: 'skip' };
  const bulks = [...html.matchAll(/data-group="([a-z]+)" data-set="([a-z]+)"/g)];
  assert.ok(bulks.length, 'the bulk buttons declare what they set');
  for (const [, group, set] of bulks) {
    assert.strictEqual(set, SAFE[group], `the ${group} bulk action sets ${SAFE[group]}, not ${set}`);
  }
});

test('creating a new product warns when something close already exists', () => {
  // Below the match threshold the app treats a line as new — the conservative
  // call, and unchanged. This only says so out loud, because that is exactly
  // where duplicates get made.
  const P = require('../src/products');
  const products = P.q.plain.all();
  const target = products.find((p) => /olive oil/i.test(p.name)) || products[0];
  assert.ok(target, 'there is a product to be close to');

  const near = P.nearMisses({ desc: target.name + ' 12/1L', code: null, brand: null,
    pack_size: '12/1L', unit: 'case', vendor_id: null }, products);
  assert.ok(Array.isArray(near), 'it returns candidates');
  for (const n of near) {
    assert.ok(n.score >= P.WARN && n.score < P.MED,
      `a warning is only for the gap between "new" and "offered": ${n.score}`);
    assert.ok(Array.isArray(n.why), 'and says why it is close');
  }
});

// ---------------------------------------------------------------------------
// The review queue.
//
// "Needs product review" was asked in two places that disagreed. The list
// asked whether any line had ever been read; the import screen asked whether
// anything was still undecided. An invoice of nothing but delivery fees
// answered yes to the first and no to the second, so it sat in the queue for
// good and the screen it sent you to said there was nothing to do.
// ---------------------------------------------------------------------------

/** The <details> block for one invoice on the list page. */
function invRow(html, id) {
  const at = html.indexOf(`data-id="${id}"`);
  return at === -1 ? '' : html.slice(html.lastIndexOf('<details', at), html.indexOf('</summary>', at));
}

test('an invoice of nothing but charges is not queued for review', async () => {
  const res = await post('/c/invoices', {
    amount: '18.75', vendor_id: String(VENDOR), invoice_date: '2026-03-03',
    invoice_number: 'BLD-FEE-1', category: 'Food', status: 'Unpaid', ai_status: 'ai',
    ai_lines: JSON.stringify([
      { description: 'Fuel surcharge', total: 14.50 },
      { description: 'Delivery charge', total: 4.25 },
    ]),
  });
  assert.strictEqual(res.status, 302);
  assert.ok(!/\/import/.test(res.headers.get('location') || ''),
    'nothing needs deciding, so it must not open the review screen');

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'BLD-FEE-1'").get();
  const bought = db.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(inv.id).n;
  db.close();

  // The precondition. Without this the rest passes for an invoice that simply
  // never stored any lines, which is a different thing entirely.
  assert.ok(inv.ai_lines && inv.ai_lines !== '[]', 'the reader did find lines on it');
  assert.strictEqual(bought, 0, 'and none of them were importable');
  assert.ok(inv.lines_imported, 'an invoice with no product work left is marked resolved');

  const list = await (await fetch(`${BASE}/c/invoices?y=2026`)).text();
  assert.match(invRow(list, inv.id), /data-review="0"/, 'so the list does not flag it');

  const panel = await (await fetch(`${BASE}/c/invoices/${inv.id}/panel`)).text();
  assert.match(panel, /No products to import/, 'and says so plainly rather than claiming an import');
  assert.ok(!/Review \d+ product line/.test(panel), 'it offers no review it cannot fulfil');

  // The two ends of the same question now give the same answer.
  const screen = await (await fetch(`${BASE}/c/invoices/${inv.id}/import`)).text();
  assert.match(screen, /Nothing left to decide/, 'and the screen it links to agrees');
});

test('an invoice the reader found no lines on is not queued either', async () => {
  // '[]' is a read that came back empty. It is a non-empty string, so asking
  // whether ai_lines is truthy called it unfinished for good — and nothing
  // could ever finish it, because there was nothing there to decide.
  const db = new Database(DB);
  const id = db.prepare(`INSERT INTO m_invoices (invoice_date, amount_cents, status, invoice_number, ai_lines)
    VALUES ('2026-06-07', 900, 'Unpaid', 'BLD-EMPTY-1', '[]')`).run().lastInsertRowid;
  assert.strictEqual(db.prepare('SELECT ai_lines FROM m_invoices WHERE id = ?').get(id).ai_lines, '[]',
    'stored as an empty read, not as NULL — that is the case under test');
  db.close();

  assert.match(invRow(await (await fetch(`${BASE}/c/invoices?y=2026`)).text(), id), /data-review="0"/,
    'an empty read is not product work');
  const panel = await (await fetch(`${BASE}/c/invoices/${id}/panel`)).text();
  assert.ok(!/Review \d+ product line/.test(panel), 'and offers no review');
});

test('the review button counts what is left, not everything that was read', async () => {
  // Six lines: two the matcher is sure of, three it is not, one charge. The
  // certain two import on save and the charge imports nothing, so three lines
  // want a person. The button used to offer all six.
  const res = await post('/c/invoices', {
    amount: '467.80', vendor_id: String(VENDOR), invoice_date: '2026-04-04',
    invoice_number: 'BLD-COUNT-1', category: 'Food', status: 'Unpaid', ai_status: 'ai',
    ai_lines: JSON.stringify(LINES),
  });
  assert.strictEqual(res.status, 302);

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'BLD-COUNT-1'").get();
  const stored = JSON.parse(inv.ai_lines).length;
  const bought = db.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(inv.id).n;
  db.close();

  // Derived, not hardcoded. Earlier tests in this file confirm matches, and a
  // confirmed match is an alias learned — so how many of these six the matcher
  // is now sure of depends on what has run before it. Pinning it to a number
  // makes this test fail for being right. What must hold is the relationship:
  // everything already imported, and the one charge, are not review work.
  const CHARGES = 1; // 'Fuel surcharge'
  const expect = stored - bought - CHARGES;

  // Preconditions, or the arithmetic below proves nothing.
  assert.strictEqual(stored, 6, 'six lines were read');
  assert.ok(bought >= 1, `at least one line imported on save, or there is no gap to measure (got ${bought})`);
  assert.ok(expect >= 1 && expect < stored, `and something is genuinely left to decide (${expect} of ${stored})`);

  const panel = await (await fetch(`${BASE}/c/invoices/${inv.id}/panel`)).text();
  const said = Number((panel.match(/Review (\d+) product line/) || [])[1]);
  assert.strictEqual(said, expect,
    `the button counts only the undecided lines: ${bought} imported and ${CHARGES} charge are not work`);
  assert.notStrictEqual(said, stored, 'not every line ever read');
  assert.match(invRow(await (await fetch(`${BASE}/c/invoices?y=2026`)).text(), inv.id),
    /data-review="1"/, 'and this one really is in the queue');
});

test('an invoice finished by skipping stays finished', async () => {
  // Skipping resolves a line without importing anything, so a re-match still
  // sees it as outstanding. The stored flag is what says the invoice is done,
  // and the count must not talk over it — or the button asks about a line the
  // operator has already answered, every time, for good.
  const db = new Database(DB);
  const vend = db.prepare('SELECT id FROM m_vendors LIMIT 1').get();
  const id = db.prepare(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, status, invoice_number, ai_lines)
    VALUES ('2026-05-05', ?, 1200, 'Unpaid', 'BLD-SKIP-1', ?)`)
    .run(String(vend.id), JSON.stringify([{ description: 'Qqx Skipped Thing', qty: 1, unit_price: 12, total: 12 }]))
    .lastInsertRowid;
  db.close();

  const before = await (await fetch(`${BASE}/c/invoices/${id}/panel`)).text();
  assert.match(before, /Review 1 product line</, 'it starts out wanting a decision');

  await post(`/c/invoices/${id}/import`, { count: '1', idx: '0', action_0: 'skip', desc_0: 'Qqx Skipped Thing' });

  const db2 = new Database(DB, { readonly: true });
  const row = db2.prepare('SELECT * FROM m_invoices WHERE id = ?').get(id);
  const bought = db2.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(id).n;
  db2.close();
  assert.strictEqual(bought, 0, 'skipping imported nothing — which is why a re-match would still flag it');
  assert.ok(row.lines_imported, 'but the invoice is answered');

  const after = await (await fetch(`${BASE}/c/invoices/${id}/panel`)).text();
  assert.ok(!/Review \d+ product line/.test(after), 'so it is not put back in the queue');
  assert.match(invRow(await (await fetch(`${BASE}/c/invoices?y=2026`)).text(), id), /data-review="0"/,
    'and the list agrees');
});

test('invoices stamped under the old rule are repaired on boot', async () => {
  // Everything above fixes invoices read from now on. These are already on
  // disk, will never be re-read, and nothing else would ever correct them.
  const db = new Database(DB);
  const vend = db.prepare('SELECT id FROM m_vendors LIMIT 1').get();
  const mk = (num, lines) => db.prepare(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, status, invoice_number, ai_lines)
    VALUES ('2026-06-06', ?, 1000, 'Unpaid', ?, ?)`).run(String(vend.id), num, JSON.stringify(lines)).lastInsertRowid;
  // Left exactly as the old rule left them: lines read, flag never stamped.
  const feeOnly = mk('BLD-LEGACY-FEE', [{ description: 'Freight charge', total: 10 }]);
  const realWork = mk('BLD-LEGACY-WORK', [{ description: 'Qqx Legacy Widget', qty: 1, unit_price: 10, total: 10 }]);
  db.prepare("DELETE FROM settings WHERE key = 'invoice_review_flag_repaired'").run();
  const pre = db.prepare('SELECT COUNT(*) n FROM product_purchases').get().n;
  db.close();

  // The repair runs at boot, so it takes a boot to observe.
  const port = PORT + 1;
  const second = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: DB, TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${port}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const after = new Database(DB, { readonly: true });
    const fee = after.prepare('SELECT * FROM m_invoices WHERE id = ?').get(feeOnly);
    const work = after.prepare('SELECT * FROM m_invoices WHERE id = ?').get(realWork);
    const post2 = after.prepare('SELECT COUNT(*) n FROM product_purchases').get().n;
    const mark = after.prepare("SELECT value FROM settings WHERE key = 'invoice_review_flag_repaired'").get();
    after.close();

    assert.ok(fee.lines_imported, 'an invoice with only charges is released from the queue');
    assert.ok(!work.lines_imported, 'one with a line still to decide is left alone');
    assert.strictEqual(post2, pre, 'and the repair moved a flag, not a single purchase');
    assert.ok(mark, 'it records that it ran, so it is not a cost on every boot');
  } finally {
    second.kill();
  }
});
