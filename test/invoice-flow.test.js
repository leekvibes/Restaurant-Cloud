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
  const SAFE = { review: 'match', charges: 'skip' };
  const bulks = [...html.matchAll(/data-group="([a-z]+)" data-set="([a-z]+)"/g)];
  assert.ok(bulks.length, 'the bulk buttons declare what they set');
  for (const [, group, set] of bulks) {
    assert.strictEqual(set, SAFE[group], `the ${group} bulk action sets ${SAFE[group]}, not ${set}`);
  }
  // The new-products button is a tick-box toggle, so it carries no data-set and
  // the loop above skips it — which is how it quietly stopped being covered at
  // all when it changed. Its own shape is asserted here instead.
  assert.ok(!/data-group="new" data-set=/.test(html), 'the new-products button no longer sets a menu');
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

// ---------------------------------------------------------------------------
// Choosing which new products to create.
//
// Every line the matcher could not place arrived pre-set to "Create new
// product" in a menu, and the only bulk action was Create all. Wanting one of
// seven meant hunting down six menus and changing each. And a second menu sat
// on every row listing the whole product catalogue — on these rows "Add to
// existing" is rendered disabled, so it was a question that could not be
// answered and did not apply.
// ---------------------------------------------------------------------------

/** The markup for one line on the import screen. */
function lineBlock(html, i) {
  const at = html.indexOf(`data-row="${i}"`);
  if (at === -1) return '';
  const from = html.lastIndexOf('<div class="iline', at);
  const next = html.indexOf('data-row="', at + 10);
  // The last row has no row after it — bounded by the end of its group, or it
  // swallows the rest of the page and every assertion below reads the wrong
  // markup.
  const end = next === -1 ? html.indexOf('</section>', at) : html.lastIndexOf('<div class="iline', next);
  return html.slice(from, end === -1 ? undefined : end);
}

async function newLinesInvoice(num, descs) {
  const db = new Database(DB);
  const vend = db.prepare('SELECT id FROM m_vendors LIMIT 1').get();
  const id = db.prepare(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, status, invoice_number, ai_lines)
    VALUES ('2026-08-08', ?, 7000, 'Unpaid', ?, ?)`).run(String(vend.id), num,
    JSON.stringify(descs.map((d, n) => ({ description: d, qty: 1, unit_price: 10 + n, total: 10 + n }))))
    .lastInsertRowid;
  db.close();
  return { id, html: await (await fetch(`${BASE}/c/invoices/${id}/import`)).text() };
}

const LOUISA = ['Zzq Amber Tumbler', 'Zzq Basil Crate', 'Zzq Copper Ladle',
  'Zzq Dune Napkin', 'Zzq Ember Tongs', 'Zzq Flint Whisk', 'Zzq Gilt Straw'];

test('a new product is a tick box, and nothing is ticked to begin with', async () => {
  const { html } = await newLinesInvoice('BLD-PICK-1', LOUISA);

  // Precondition: these have to be the unmatched kind, or the tick box is not
  // what would render and this test proves nothing.
  assert.match(html, /Likely new products/, 'they read as new products');

  for (let i = 0; i < LOUISA.length; i++) {
    const row = lineBlock(html, i);
    assert.ok(row, `line ${i} is on the screen`);
    assert.match(row, new RegExp(`type="checkbox" name="action_${i}" value="create"`),
      `line ${i} is a tick box`);
    // The tag itself, not the row: a row may also hold the "create it as new
    // anyway" radio, which is checked on purpose.
    const box = (row.match(/<input type="checkbox"[^>]*>/) || [''])[0];
    assert.ok(!/checked/.test(box),
      `line ${i} starts unticked — the whole complaint was seven arriving already chosen`);
    assert.ok(!new RegExp(`select name="product_${i}"`).test(row),
      `line ${i} has no product menu: it has no match, so "Add to existing" is disabled and the menu answers nothing`);
  }

  // Unticked boxes post nothing at all, and a missing action is already read
  // as skip — which is why none of this needed the import handler to change.
  assert.match(html, /id="impbtn">Import 0 lines</, 'so the button opens at nothing selected');
  assert.match(html, /data-group="new" data-toggle="1"/, 'with one button to take all seven');
});

test('ticking one line of seven creates exactly that one', async () => {
  const { id, html } = await newLinesInvoice('BLD-PICK-2', LOUISA);
  const idx = (html.match(/name="idx" value="([^"]*)"/) || [])[1];
  assert.strictEqual(idx, '0,1,2,3,4,5,6', 'the form carries all seven lines');

  const before = new Database(DB, { readonly: true });
  const had = before.prepare('SELECT COUNT(*) n FROM products').get().n;
  before.close();

  // Exactly what a browser posts when one box of seven is ticked: the six
  // unticked ones contribute no action field whatsoever.
  const body = new URLSearchParams({ count: '7', idx });
  for (let i = 0; i < LOUISA.length; i++) {
    body.set(`desc_${i}`, LOUISA[i]);
    body.set(`total_${i}`, String(1000 + i * 100));
    body.set(`qty_${i}`, '1');
  }
  body.set('action_2', 'create');            // Copper Ladle, and nothing else

  const res = await fetch(`${BASE}/c/invoices/${id}/import`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.strictEqual(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /Imported 1 line, 1 new product\./,
    'and it says so');

  const db = new Database(DB, { readonly: true });
  const now = db.prepare('SELECT name FROM products').all().map((r) => r.name);
  const bought = db.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(id).n;
  db.close();

  assert.ok(now.includes('Zzq Copper Ladle'), 'the one that was ticked exists');
  for (const other of LOUISA.filter((d) => d !== 'Zzq Copper Ladle')) {
    assert.ok(!now.includes(other), `${other} was not ticked and must not have been created`);
  }
  assert.strictEqual(now.length, had + 1, 'exactly one product came out of seven lines');
  assert.strictEqual(bought, 1, 'and one purchase, not seven');
});

test('the product menu appears only where there is a product to choose', async () => {
  // The uncertain group is the one place picking a product means anything:
  // there, a match exists and you may want a different one.
  const db = new Database(DB, { readonly: true });
  const id = db.prepare("SELECT id FROM m_invoices WHERE invoice_number = 'BLD-COUNT-1'").get().id;
  db.close();
  const html = await (await fetch(`${BASE}/c/invoices/${id}/import`)).text();

  assert.match(html, /Needs your decision/, 'this invoice has uncertain lines — the precondition');
  assert.match(html, /class="minisel iline-prod"/, 'which do get a product menu');

  // Every product menu on the page belongs to a row that has a match to change.
  for (const [, i] of html.matchAll(/select name="product_(\d+)"/g)) {
    assert.match(lineBlock(html, i), /Looks like <b>/,
      `line ${i} offers a product menu, so it must have a suggested match to change`);
  }
});

test('the import screen has a visible way to submit', async () => {
  // This screen shipped with no usable Import button. The button was in the
  // markup the whole time — a blanket `.bs .stickybar { display: none }`,
  // written to stop the shift sheet repeating its header action at the foot,
  // hid it. The shift sheet had a second copy to fall back on. This screen did
  // not, so its only way to submit was invisible and no test noticed, because
  // the element was present and every assertion was about markup.
  const { id } = await newLinesInvoice('BLD-SUBMIT-1', ['Zzq Kiln Mitt']);
  const html = await (await fetch(`${BASE}/c/invoices/${id}/import`)).text();

  const bar = html.slice(html.indexOf('class="stickybar'), html.indexOf('</form>'));
  assert.ok(bar, 'there is an action bar');
  assert.match(bar, /type="submit"/, 'with a submit button in it');
  assert.match(bar, /id="impbtn">Import/, 'that says what it will do');

  // Present is not the same as visible. The bar has to carry the class that
  // opts it out of the hiding, and the stylesheet has to still honour it.
  assert.match(bar, /class="stickybar stickybar-keep"/,
    'and the bar opts out of the blanket hide — without this it is invisible');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  assert.match(css, /\.bs\s+\.stickybar\.stickybar-keep\s*\{[^}]*display:\s*block/,
    'the stylesheet still un-hides an opted-out bar');
});

// ---------------------------------------------------------------------------
// Two copies of one invoice, and the way out.
//
// The same invoice was uploaded twice and there was no way to remove either.
// Both halves of that matter: catching it at the door, and — because it has
// already happened — being able to delete one without leaving its purchases
// behind, still counting toward what you appear to spend.
// ---------------------------------------------------------------------------

const INV = {
  amount: '210.00', vendor_id: String(VENDOR), invoice_date: '2026-09-09',
  invoice_number: 'BLD-DUP-1', category: 'Food', status: 'Unpaid', ai_status: 'manual',
};

test('the same invoice number from the same vendor is stopped and questioned', async () => {
  const first = await post('/c/invoices', INV);
  assert.strictEqual(first.status, 302, 'the first one files without comment');

  const second = await post('/c/invoices', INV);
  assert.strictEqual(second.status, 200, 'the second one does not just save');
  const html = await second.text();
  assert.match(html, /You already have this invoice/, 'it says so plainly');
  assert.match(html, /invoice number BLD-DUP-1/, 'and what it matched on');
  assert.match(html, /Save it anyway/, 'without refusing — a number can be reused by mistake');

  const db = new Database(DB, { readonly: true });
  const n = db.prepare("SELECT COUNT(*) n FROM m_invoices WHERE invoice_number = 'BLD-DUP-1'").get().n;
  db.close();
  assert.strictEqual(n, 1, 'and nothing was written while the question was open');
});

test('answering "save it anyway" files it, because sometimes it really is two', async () => {
  const res = await post('/c/invoices', { ...INV, dup_ok: '1' });
  assert.strictEqual(res.status, 302);
  const db = new Database(DB, { readonly: true });
  const n = db.prepare("SELECT COUNT(*) n FROM m_invoices WHERE invoice_number = 'BLD-DUP-1'").get().n;
  db.close();
  assert.strictEqual(n, 2, 'the operator overruled it and that was honoured');
});

test('with no invoice number, the same vendor day and total is only a maybe', async () => {
  const noNum = { amount: '64.00', vendor_id: String(VENDOR), invoice_date: '2026-09-10',
    category: 'Food', status: 'Unpaid', ai_status: 'manual' };
  assert.strictEqual((await post('/c/invoices', noNum)).status, 302);

  const again = await post('/c/invoices', noNum);
  assert.strictEqual(again.status, 200, 'the second is questioned');
  const html = await again.text();
  assert.match(html, /looks like one you already have/i, 'but hedged, not asserted');
  assert.ok(!/You already have this invoice\./.test(html), 'because two identical deliveries in a day do happen');
  assert.match(html, /same vendor, day and total/, 'and it says what it went on');
});

test('a different day, or a different total, is not a duplicate', async () => {
  const base = { amount: '64.00', vendor_id: String(VENDOR), invoice_date: '2026-09-10',
    category: 'Food', status: 'Unpaid', ai_status: 'manual' };
  // This is the assertion that keeps the check from being useless by being
  // eager: if everything looks like a duplicate, nobody can file anything.
  assert.strictEqual((await post('/c/invoices', { ...base, invoice_date: '2026-09-11' })).status, 302,
    'same total, next day — files without a question');
  assert.strictEqual((await post('/c/invoices', { ...base, amount: '64.01' })).status, 302,
    'same day, a cent apart — files without a question');
});

test('the list can find the duplicates already filed', async () => {
  const html = await (await fetch(`${BASE}/c/invoices?y=2026`)).text();
  assert.match(html, /Possible duplicates/, 'there is a way to filter to them');
  const flagged = [...html.matchAll(/data-dupe="1"/g)].length;
  // Exactly the two BLD-DUP-1 rows. The no-number pair above never became a
  // pair: its second copy was questioned and not saved, which is the check
  // doing its job — counting it here would have been counting a bug.
  const db = new Database(DB, { readonly: true });
  const copies = db.prepare("SELECT COUNT(*) n FROM m_invoices WHERE invoice_number = 'BLD-DUP-1'").get().n;
  const total = db.prepare("SELECT COUNT(*) n FROM m_invoices WHERE invoice_date LIKE '2026-%'").get().n;
  db.close();
  assert.strictEqual(copies, 2, 'there are two copies on file — the precondition');
  assert.ok(total > copies, 'alongside invoices that are not duplicates of anything');
  assert.strictEqual(flagged, 2, `both copies are marked, and nothing else is (found ${flagged})`);
  assert.match(html, /Possible duplicates <b>2<\/b>/, 'and the chip counts them');
});

test('deleting an invoice takes its purchases out of the product history', async () => {
  // The generic delete removes the row and nothing else. For an invoice that
  // is not the whole story: importing its lines wrote purchase records, and
  // those are what last-paid, average and trend are built from. Left behind,
  // the duplicate you deleted goes on inflating what you appear to spend.
  const res = await post('/c/invoices', {
    amount: '135.30', vendor_id: String(VENDOR), invoice_date: '2026-09-14',
    invoice_number: 'BLD-DEL-1', category: 'Food', status: 'Unpaid', ai_status: 'ai',
    ai_lines: JSON.stringify([LINES[0]]),
  });
  assert.strictEqual(res.status, 302);

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'BLD-DEL-1'").get();
  const bought = db.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(inv.id).n;
  const totalBefore = db.prepare('SELECT COUNT(*) n FROM product_purchases').get().n;
  db.close();
  assert.strictEqual(bought, 1, 'its line imported on save — the precondition');

  const del = await post(`/c/invoices/${inv.id}/delete`, {});
  assert.strictEqual(del.status, 302);
  assert.match(decodeURIComponent(del.headers.get('location') || ''), /1 purchase.*removed/,
    'and it says what went with it');

  const after = new Database(DB, { readonly: true });
  const gone = after.prepare('SELECT COUNT(*) n FROM m_invoices WHERE id = ?').get(inv.id).n;
  const orphans = after.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(inv.id).n;
  const totalAfter = after.prepare('SELECT COUNT(*) n FROM product_purchases').get().n;
  const products = after.prepare("SELECT COUNT(*) n FROM products WHERE name = 'Roma tomatoes'").get().n;
  after.close();

  assert.strictEqual(gone, 0, 'the invoice is deleted');
  assert.strictEqual(orphans, 0, 'and nothing of it is left pointing at an invoice that does not exist');
  assert.strictEqual(totalAfter, totalBefore - 1, 'exactly its own purchases went, and no others');
  assert.strictEqual(products, 1, 'the product itself stays — it is bought from other invoices too');
});

test('the panel offers the delete, and says what it will take', async () => {
  const db = new Database(DB, { readonly: true });
  const withLines = db.prepare(`SELECT i.id FROM m_invoices i
    WHERE (SELECT COUNT(*) FROM product_purchases p WHERE p.invoice_id = i.id) > 0 LIMIT 1`).get();
  db.close();
  assert.ok(withLines, 'an invoice with purchases exists — the precondition');

  const panel = await (await fetch(`${BASE}/c/invoices/${withLines.id}/panel`)).text();
  assert.match(panel, /action="\/c\/invoices\/\d+\/delete"/, 'the panel can delete');
  assert.match(panel, /purchase.? will be removed from your product history/,
    'and the confirm says so before you agree to it');
  assert.match(panel, /uploaded file is kept/, 'and that the original is not destroyed');
});

test('an invoice photographed front and back files as both', async () => {
  // The reader was always handed every page. The save kept the first, so a
  // two-page invoice was filed as its front and the back was gone.
  const fd = new FormData();
  Object.entries({ amount: '88.00', vendor_id: String(VENDOR), invoice_date: '2026-10-02',
    invoice_number: 'BLD-PAGES-1', category: 'Food', status: 'Unpaid', ai_status: 'manual' })
    .forEach(([k, v]) => fd.set(k, v));
  for (const n of ['front', 'back']) {
    fd.append('file', new Blob([Buffer.from(n)], { type: 'image/jpeg' }), `${n}.jpg`);
  }
  const res = await fetch(`${BASE}/c/invoices`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.strictEqual(res.status, 302);

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'BLD-PAGES-1'").get();
  db.close();

  const { pagesOf } = require('../src/modules');
  const pages = pagesOf(inv);
  assert.strictEqual(pages.length, 2, 'both sides are on the invoice');
  assert.strictEqual(pages[0], inv.file, 'and the front is still `file`');

  const panel = await (await fetch(`${BASE}/c/invoices/${inv.id}/panel`)).text();
  assert.match(panel, /2 pages/, 'the panel says there are two');
  const links = [...panel.matchAll(/href="\/uploads\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pages.every((p) => links.includes(p)), 'and both are reachable, not just the front');
});

test('a duplicate question does not cost you the pages while you answer it', async () => {
  // The confirm step re-posts the form. It carries the files it already has by
  // name — and it has to carry all of them, or saying "save it anyway" quietly
  // reduces a two-page invoice to page one.
  const fd = new FormData();
  Object.entries({ amount: '88.00', vendor_id: String(VENDOR), invoice_date: '2026-10-02',
    invoice_number: 'BLD-PAGES-1', category: 'Food', status: 'Unpaid', ai_status: 'manual' })
    .forEach(([k, v]) => fd.set(k, v));
  for (const n of ['front2', 'back2']) {
    fd.append('file', new Blob([Buffer.from(n)], { type: 'image/jpeg' }), `${n}.jpg`);
  }
  const asked = await fetch(`${BASE}/c/invoices`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.strictEqual(asked.status, 200, 'it is questioned as a duplicate — the precondition');
  const html = await asked.text();

  const kept = (html.match(/name="kept_pages" value="([^"]*)"/) || [])[1];
  assert.ok(kept, 'the form carries the pages it already has');
  assert.strictEqual(kept.split(',').filter(Boolean).length, 2,
    `both pages are carried, not just the first (${kept})`);

  // Answer it the way the page does.
  const body = new URLSearchParams();
  for (const [, k, v] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(k, v);
  body.set('dup_ok', '1');
  const saved = await fetch(`${BASE}/c/invoices`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  assert.strictEqual(saved.status, 302);

  const db = new Database(DB, { readonly: true });
  const all = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'BLD-PAGES-1' ORDER BY id").all();
  db.close();
  const { pagesOf } = require('../src/modules');
  assert.strictEqual(all.length, 2, 'the override filed it');
  assert.strictEqual(pagesOf(all[1]).length, 2, 'with both its pages intact');
});

// ---------------------------------------------------------------------------
// The capture overlay.
//
// The drawer became an overlay over the list: drop the paper, watch it read,
// confirm it against the paper. The tests here are about the contract the
// overlay posts under, not its looks — the layout is verified in a browser,
// but what must never drift is that it still posts the same form the server
// has always taken.
// ---------------------------------------------------------------------------

test('the overlay posts the same forms the server already takes', async () => {
  const html = await (await fetch(`${BASE}/c/invoices`)).text();
  assert.match(html, /data-cap/, 'the overlay is on the page, not a route away');
  assert.match(html, /action="\/c\/invoices"[^>]*enctype="multipart\/form-data"/, 'invoices post to invoices');
  assert.match(html, /action="\/c\/expenses"[^>]*enctype="multipart\/form-data"/,
    'and an expense can be added from here too, to its own endpoint');
  // Every field the invoice route reads has somewhere to come from.
  for (const f of ['amount', 'invoice_date', 'due_date', 'invoice_number', 'category',
    'subtotal', 'tax', 'ai_status', 'ai_lines', 'file']) {
    assert.match(html, new RegExp(`name="${f}"`), `${f} is posted`);
  }
  assert.match(html, /name="file"[^>]*multiple/, 'and every page of it');
});

test('a vendor typed on the paper becomes the vendor on the invoice', async () => {
  // The overlay types a vendor instead of picking an id — a name read off the
  // paper is what it has. Filed against nobody, an invoice drops out of vendor
  // totals, out of the duplicate check and out of alias matching.
  const db0 = new Database(DB, { readonly: true });
  const before = db0.prepare('SELECT COUNT(*) n FROM m_vendors').get().n;
  const known = db0.prepare('SELECT name FROM m_vendors LIMIT 1').get().name;
  db0.close();
  assert.ok(known, 'there is a vendor already on file — the precondition');

  // Loosely typed: different case and spacing from what is stored.
  const messy = known.toUpperCase().replace(/ /g, '  ');
  assert.notStrictEqual(messy, known, 'and it is genuinely typed differently');
  const res = await post('/c/invoices', {
    amount: '12.00', vendor_name: messy, invoice_date: '2026-11-01',
    invoice_number: 'CAP-V1', category: 'Food', ai_status: 'manual',
  });
  assert.strictEqual(res.status, 302);

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'CAP-V1'").get();
  const after = db.prepare('SELECT COUNT(*) n FROM m_vendors').get().n;
  const vendor = db.prepare('SELECT name FROM m_vendors WHERE id = ?').get(Number(inv.vendor_id));
  db.close();
  assert.ok(inv.vendor_id, 'the invoice has a vendor');
  assert.strictEqual(vendor.name, known, 'the one already on file, matched through the mess');
  assert.strictEqual(after, before, 'and no duplicate vendor was created for it');
});

test('a vendor nobody has billed from before is created, not dropped', async () => {
  const db0 = new Database(DB, { readonly: true });
  const before = db0.prepare('SELECT COUNT(*) n FROM m_vendors').get().n;
  db0.close();

  const res = await post('/c/invoices', {
    amount: '18.00', vendor_name: 'Qqx Brand New Supplier', invoice_date: '2026-11-02',
    invoice_number: 'CAP-V2', category: 'Food', ai_status: 'manual',
  });
  assert.strictEqual(res.status, 302);

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'CAP-V2'").get();
  const after = db.prepare('SELECT COUNT(*) n FROM m_vendors').get().n;
  const vendor = db.prepare('SELECT name FROM m_vendors WHERE id = ?').get(Number(inv.vendor_id));
  db.close();
  assert.strictEqual(after, before + 1, 'exactly one vendor was added');
  assert.strictEqual(vendor.name, 'Qqx Brand New Supplier', 'named as it was typed');
  assert.ok(inv.vendor_id, 'and the invoice is filed against it');
});

test('the duplicate check sees the typed vendor, not a blank one', async () => {
  // Resolving the vendor after the duplicate check would have meant every
  // typed-vendor invoice comparing as "no vendor" — so two invoices from
  // different suppliers on the same day for the same amount would collide,
  // and two from the SAME supplier would not be caught by number.
  const first = await post('/c/invoices', {
    amount: '77.00', vendor_name: 'Qqx Brand New Supplier', invoice_date: '2026-11-03',
    invoice_number: 'CAP-DUP-X', category: 'Food', ai_status: 'manual',
  });
  assert.strictEqual(first.status, 302);
  const again = await post('/c/invoices', {
    amount: '77.00', vendor_name: 'Qqx Brand New Supplier', invoice_date: '2026-11-03',
    invoice_number: 'CAP-DUP-X', category: 'Food', ai_status: 'manual',
  });
  assert.strictEqual(again.status, 200, 'the second is questioned');
  assert.match(await again.text(), /already have this invoice/i, 'as the same paper twice');
});

// ---------------------------------------------------------------------------
// What the capture overlay must carry.
//
// Two regressions happened here at once when the drawer became an overlay, and
// neither was visible from the server: the read filled nothing, and three
// fields quietly stopped existing. Both are shaped like "the page still looks
// right", which is why they are pinned rather than eyeballed.
// ---------------------------------------------------------------------------

test('the overlay offers every field the save handler reads', async () => {
  // Dropping one loses information that cannot be recovered from the paper
  // later — status decides whether an invoice ever shows as owed, payment
  // method is how the books reconcile it, notes is where "short two cases,
  // credit promised" goes.
  const html = await (await fetch(`${BASE}/c/invoices`)).text();
  const needed = ['amount', 'subtotal', 'tax', 'invoice_date', 'due_date', 'invoice_number',
    'category', 'status', 'payment_method', 'notes', 'vendor_name', 'vendor_id',
    'ai_status', 'ai_confidence', 'ai_lines', 'ai_snapshot', 'file'];
  for (const f of needed) {
    assert.match(html, new RegExp(`name="${f}"`), `${f} can be sent from the overlay`);
  }
  // And exactly one control per name, or the server receives an array.
  for (const f of ['status', 'amount', 'notes']) {
    const n = (html.match(new RegExp(`name="${f}"`, 'g')) || []).length;
    assert.strictEqual(n, 1, `${f} is posted once, not ${n} times`);
  }
});

test('the reader fill accepts the shape the invoice endpoint actually returns', async () => {
  // /c/invoices/read predates the documents and expenses readers and answers
  // its fields flat, alongside its vendor match. The newer two answer
  // {ok, data}. Reading only j.data meant every invoice read filled nothing
  // while still showing "read by ZWIN" — the failure looked like a success.
  const html = await (await fetch(`${BASE}/c/invoices`)).text();
  assert.match(html, /j\.data \|\| j/, 'both shapes are handled');
  assert.match(html, /matched_vendor \|\| d\.vendor_name/,
    'and the vendor already matched on the server is preferred over the raw read');
});

test('an invoice saved with every field keeps every field', async () => {
  const res = await post('/c/invoices', {
    amount: '36.88', subtotal: '36.88', tax: '0', vendor_name: 'Qqx Overlay Bakery',
    invoice_number: 'OV-1', invoice_date: '2026-12-01', due_date: '2026-12-31',
    category: 'Food', status: 'Paid', payment_method: 'ACH',
    notes: 'Short two cases, credit promised', ai_status: 'manual',
  });
  assert.strictEqual(res.status, 302);
  const db = new Database(DB, { readonly: true });
  const inv = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'OV-1'").get();
  db.close();
  assert.strictEqual(inv.status, 'Paid', 'a paid invoice files as paid, not as owed');
  assert.strictEqual(inv.payment_method, 'ACH');
  assert.strictEqual(inv.notes, 'Short two cases, credit promised');
  assert.strictEqual(inv.subtotal_cents, 3688);
});

test('the snapshot is what tells a corrected read from an untouched one', async () => {
  // The save handler re-joins the posted figures and compares them against
  // ai_snapshot to choose between "read by AI" and "read, then corrected".
  // With no snapshot posted that comparison silently always says unchanged.
  const same = await post('/c/invoices', {
    amount: '50.00', subtotal: '50.00', tax: '', vendor_name: 'Qqx Snapshot Co',
    invoice_number: 'SNAP-1', invoice_date: '2026-12-02', category: 'Food',
    ai_status: 'ai', ai_snapshot: '50.00|50.00|||Food',
  });
  assert.strictEqual(same.status, 302);

  const edited = await post('/c/invoices', {
    amount: '61.00', subtotal: '50.00', tax: '', vendor_name: 'Qqx Snapshot Co',
    invoice_number: 'SNAP-2', invoice_date: '2026-12-03', category: 'Food',
    ai_status: 'ai', ai_snapshot: '50.00|50.00|||Food',
  });
  assert.strictEqual(edited.status, 302);

  const db = new Database(DB, { readonly: true });
  const a = db.prepare("SELECT ai_status FROM m_invoices WHERE invoice_number = 'SNAP-1'").get();
  const b = db.prepare("SELECT ai_status FROM m_invoices WHERE invoice_number = 'SNAP-2'").get();
  db.close();
  assert.strictEqual(a.ai_status, 'ai', 'untouched stays "read by AI"');
  assert.strictEqual(b.ai_status, 'ai_edited', 'a changed total is "read, then corrected"');

  // The half above only proves the server compares correctly. The overlay has
  // to actually stamp what was read, in the same five fields and the same
  // order the handler re-joins — a snapshot of empty strings compares equal to
  // nothing and every read would report itself untouched.
  const html = await (await fetch(`${BASE}/c/invoices`)).text();
  const built = html.match(/snap\.value = \[([^\]]+)\]/);
  assert.ok(built, 'the overlay builds a snapshot');
  for (const part of ['d.total', 'd.subtotal', 'd.tax', 'd.vendor_id', 'd.category']) {
    assert.ok(built[1].includes(part), `it is built from ${part}, as the handler expects`);
  }
});

test('an invoice read with lines still lands on the import screen', async () => {
  // The whole point of reading the lines. If the overlay stops carrying
  // ai_lines, the save succeeds, the products never import, and nothing says so.
  const res = await post('/c/invoices', {
    amount: '36.88', vendor_name: 'Qqx Overlay Bakery', invoice_number: 'OV-LINES',
    invoice_date: '2026-12-04', category: 'Food', status: 'Unpaid', ai_status: 'ai',
    ai_lines: JSON.stringify([
      { description: 'Qqx Ciabatta Roll', qty: 1, unit_price: 8.99, total: 8.99 },
      { description: 'Qqx Rosemary Focaccia', qty: 1, unit_price: 10.6, total: 10.6 },
    ]),
  });
  assert.strictEqual(res.status, 302);
  const to = decodeURIComponent(res.headers.get('location') || '');
  assert.match(to, /\/import/, 'it goes to the import screen');
  assert.match(to, /2 lines need a decision/, 'and says how much is waiting');
});

// ---------------------------------------------------------------------------
// "None of these" — leaving the product list alone.
//
// Some invoices are an accounting record and nothing more; the operator does
// not track the items on them. Before this there was no way to say so: the
// uncertain lines carry a `required` select, so the form would not submit
// until each was set to Skip by hand, and the invoice sat on the list saying
// "review" with no plain way to clear it.
// ---------------------------------------------------------------------------

test('skip-all marks an invoice reviewed and imports nothing', async () => {
  const db0 = new Database(DB);
  const vend = db0.prepare('SELECT id FROM m_vendors LIMIT 1').get();
  // A medium line (required select) and a new line — the exact shape that
  // blocked a plain submit.
  const id = db0.prepare(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, status, invoice_number, ai_lines)
    VALUES ('2026-11-20', ?, 4200, 'Unpaid', 'SKIPALL-1', ?)`)
    .run(String(vend.id), JSON.stringify([
      { description: 'Roma tomatoes', pack_size: '1 L', qty: 1, unit_price: 10, total: 10 },
      { description: 'Qqx Brand New Line', qty: 1, unit_price: 32, total: 32 },
    ])).lastInsertRowid;
  const before = db0.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(id).n;
  db0.close();

  // The screen shows the button, and it opts out of validation and posts the flag.
  const screen = await (await fetch(`${BASE}/c/invoices/${id}/import`)).text();
  assert.match(screen, /name="skip_all" value="1"[^>]*formnovalidate|formnovalidate[^>]*name="skip_all"/,
    'the skip button bypasses the required selects and posts skip_all');

  const res = await post(`/c/invoices/${id}/import`, { skip_all: '1' });
  assert.strictEqual(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /nothing added to products/i,
    'and says nothing was imported');

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare('SELECT * FROM m_invoices WHERE id = ?').get(id);
  const after = db.prepare('SELECT COUNT(*) n FROM product_purchases WHERE invoice_id = ?').get(id).n;
  db.close();
  assert.ok(inv.lines_imported, 'the invoice is marked reviewed, so the list stops asking');
  assert.strictEqual(after, before, 'and not one purchase was written');
});

test('an invoice cleared by skip-all no longer shows a review action', async () => {
  const db = new Database(DB, { readonly: true });
  const inv = db.prepare("SELECT * FROM m_invoices WHERE invoice_number = 'SKIPALL-1'").get();
  db.close();
  // The list flag: ai_lines present, not empty, and lines_imported set → done.
  const flagged = !!inv.ai_lines && inv.ai_lines !== '[]' && !inv.lines_imported;
  assert.ok(!flagged, 'the list no longer flags it for review');

  const panel = await (await fetch(`${BASE}/c/invoices/${inv.id}/panel`)).text();
  assert.ok(!/Review \d+ product line/.test(panel), 'and the panel offers no review it cannot complete');
});

test('skip-all does not disturb what was already imported', async () => {
  // It marks the invoice reviewed without touching imported_idx, so a later
  // "undo" still knows exactly what auto-import put in.
  const db0 = new Database(DB);
  const vend = db0.prepare('SELECT id FROM m_vendors LIMIT 1').get();
  const id = db0.prepare(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, status, invoice_number, ai_lines, imported_idx)
    VALUES ('2026-11-21', ?, 5000, 'Unpaid', 'SKIPALL-2', ?, ?)`)
    .run(String(vend.id), JSON.stringify([{ description: 'Whatever', qty: 1, unit_price: 50, total: 50 }]),
      JSON.stringify([0])).lastInsertRowid;
  db0.close();

  await post(`/c/invoices/${id}/import`, { skip_all: '1' });

  const db = new Database(DB, { readonly: true });
  const inv = db.prepare('SELECT imported_idx, lines_imported FROM m_invoices WHERE id = ?').get(id);
  db.close();
  assert.strictEqual(inv.imported_idx, '[0]', 'the record of what was imported is left intact');
  assert.ok(inv.lines_imported, 'while the review flag is cleared');
});

test('the overlay names the products step when a read carries line items', async () => {
  // The step was always there — save an invoice with lines and you land on the
  // import screen. The button now says so, so the option to do it right away is
  // visible rather than a redirect that arrives unannounced.
  const html = await (await fetch(`${BASE}/c/invoices`)).text();
  assert.match(html, /sv\.textContent = 'Save & add products'/,
    'the save button becomes "Save & add products" once lines are read');
  // And only then — a read with no items leaves the plain label.
  assert.match(html, /if \(d\.line_items && d\.line_items\.length\)/,
    'gated on the read actually having produced line items');
});
