'use strict';

// Expenses: money that leaves without an invoice behind it.
//
// The whole point of the section is the one figure an invoice never has — what
// the restaurant owes somebody who used their own money. Everything here is
// driven through the real form, including the receipt upload, because the
// upload is the part with moving pieces: multipart parsing, a file written to
// disk, and a filename stored on the row.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3977;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-exp-'));
const DB = path.join(dir, 'exp.db');
const UPLOADS = path.join(dir, 'uploads');
let child;
let Database;

test.before(async () => {
  Database = require('better-sqlite3');
  fs.mkdirSync(UPLOADS, { recursive: true });
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '', UPLOAD_DIR: UPLOADS,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The drawer's own form: multipart, because it carries a receipt. */
async function logExpense(fields, receipt) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (receipt) fd.set('file', new Blob([receipt.bytes], { type: receipt.type }), receipt.name);
  return fetch(`${BASE}/c/expenses`, { method: 'POST', body: fd, redirect: 'manual' });
}

const rows = () => {
  const db = new Database(DB, { readonly: true });
  const out = db.prepare('SELECT * FROM m_expenses ORDER BY id').all();
  db.close();
  return out;
};

test('the page stands on its own before anything is logged', async () => {
  const res = await fetch(`${BASE}/c/expenses`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Expenses — nothing logged yet/, 'it says what it is');
  assert.match(html, /Costco run, a bag of ice/, 'and what it is for');
  // The empty page is the only place to explain the difference from Invoices.
  assert.match(html, /Log the first expense/, 'with a way in');
  // Scripts only: the shared theme toggle legitimately compares to `undefined`,
  // and scanning the whole document caught that instead of anything rendered.
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(!/\$NaN|undefined|Infinity|\bnull\b/.test(visible),
    'no arithmetic on an empty set leaks into the page');
});

test('a bag of ice, paid for out of somebody pocket, with the receipt', async () => {
  // A real PNG header, so the file written to disk is a file and the row's
  // extension is one the page will render as an image.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const res = await logExpense({
    name: 'Two bags of ice', where_bought: 'Costco', category: 'Ice',
    amount_cents: '12.48', spent_on: '2026-07-20',
    paid_by: 'Rosa Diaz', paid_with: 'Their own money', notes: 'Machine was down',
  }, { bytes: png, name: 'receipt.png', type: 'image/png' });
  assert.strictEqual(res.status, 302);

  const [r] = rows();
  assert.ok(r, 'the expense was stored');
  assert.strictEqual(r.name, 'Two bags of ice');
  assert.strictEqual(r.where_bought, 'Costco');
  assert.strictEqual(r.paid_by, 'Rosa Diaz');
  assert.strictEqual(r.spent_on, '2026-07-20');
  // Money is integer cents everywhere in this app, and the form types dollars.
  assert.strictEqual(r.amount_cents, 1248, 'dollars typed in, cents stored');
  assert.strictEqual(r.reimbursed_on, null, 'nobody has paid her back yet');

  assert.ok(r.file, 'the receipt filename is on the row');
  const onDisk = path.join(UPLOADS, r.file);
  assert.ok(fs.existsSync(onDisk), `the receipt is on disk at ${onDisk}`);
  assert.deepStrictEqual(fs.readFileSync(onDisk), png, 'and it is the bytes that were sent');

  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  assert.match(html, /Two bags of ice/, 'it is on the page');
  assert.match(html, /\$12\.48/, 'at what it cost');
  assert.match(html, new RegExp(`/uploads/${r.file}`), 'and the receipt is reachable from it');
});

test('what the restaurant owes is only what somebody fronted', async () => {
  // Same money, three ways of paying it. Only one of them leaves a person out
  // of pocket, and the headline figure has to know the difference — otherwise
  // it is just a second copy of total spend.
  await logExpense({ name: 'Sanitiser', amount_cents: '40.00', spent_on: '2026-07-21',
    paid_by: 'Ana Ortiz', paid_with: 'Company card', category: 'Cleaning' });
  await logExpense({ name: 'Tap washer', amount_cents: '7.52', spent_on: '2026-07-21',
    paid_by: 'Joseph', paid_with: 'Their own money', category: 'Repairs' });
  await logExpense({ name: 'Bin bags', amount_cents: '18.00', spent_on: '2026-07-21',
    paid_by: 'Ana Ortiz', paid_with: 'Drawer cash', category: 'Supplies' });

  const all = rows();
  const spent = all.reduce((a, r) => a + r.amount_cents, 0);
  const owed = all.filter((r) => r.paid_with === 'Their own money' && !r.reimbursed_on)
    .reduce((a, r) => a + r.amount_cents, 0);
  assert.strictEqual(spent, 7800, 'four expenses, $78.00 spent');
  assert.strictEqual(owed, 2000, 'but only the two paid personally are owed back');

  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  assert.match(html, /\$20\.00 owed back/, 'the headline names what is owed, not what was spent');
  assert.ok(!/\$78\.00 owed back/.test(html), 'company money is not a debt to anybody');
  // The name you settle up with first.
  assert.match(html, /most to (Rosa Diaz|Joseph)/, 'and says who is owed the most');
});

test('marking one paid back settles that one and no other', async () => {
  const before = rows().filter((r) => r.paid_with === 'Their own money' && !r.reimbursed_on);
  assert.strictEqual(before.length, 2, 'two people are out of pocket — the precondition');
  const target = before[0];

  const res = await fetch(`${BASE}/c/expenses/${target.id}/reimburse`, { method: 'POST', redirect: 'manual' });
  assert.strictEqual(res.status, 302);

  const after = rows();
  const settled = after.find((r) => r.id === target.id);
  assert.ok(settled.reimbursed_on, 'it carries the date it was settled, not just a yes');
  assert.match(settled.reimbursed_on, /^\d{4}-\d{2}-\d{2}$/, 'as a date');
  assert.strictEqual(settled.amount_cents, target.amount_cents, 'and settling did not touch the money');

  const stillOwed = after.filter((r) => r.paid_with === 'Their own money' && !r.reimbursed_on);
  assert.strictEqual(stillOwed.length, 1, 'the other person is still owed');
  assert.notStrictEqual(stillOwed[0].id, target.id);

  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  const owed = after.filter((r) => r.paid_with === 'Their own money' && !r.reimbursed_on)
    .reduce((a, r) => a + r.amount_cents, 0);
  assert.match(html, new RegExp(`\\$${(owed / 100).toFixed(2)} owed back`),
    'and the headline came down by exactly the one that was settled');
});

test('settling can be taken back', async () => {
  const settled = rows().find((r) => r.reimbursed_on);
  assert.ok(settled, 'something is settled — the precondition');

  const fd = new URLSearchParams({ undo: '1' });
  await fetch(`${BASE}/c/expenses/${settled.id}/reimburse`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fd.toString(),
  });
  const after = rows().find((r) => r.id === settled.id);
  assert.strictEqual(after.reimbursed_on, null, 'it is owed again');
});

test('an expense is not an invoice, and does not turn up as one', async () => {
  // Two tables, two pages, and no leakage: an invoice on the expenses page (or
  // the reverse) would double-count everything the restaurant spends.
  const db = new Database(DB, { readonly: true });
  const invoices = db.prepare('SELECT COUNT(*) n FROM m_invoices').get().n;
  db.close();
  assert.strictEqual(invoices, 0, 'nothing was written to invoices');

  const inv = await (await fetch(`${BASE}/c/invoices`)).text();
  assert.ok(!/Two bags of ice/.test(inv), 'and no expense appears on the invoice ledger');
});

test('the receipt column says which ones still need photographing', async () => {
  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  const withFile = rows().filter((r) => r.file).length;
  const without = rows().length - withFile;
  assert.ok(without > 0 && withFile > 0, 'there is one of each — the precondition');
  assert.match(html, new RegExp(`No receipt</span><span class="bs-stat[^"]*">${without}<`),
    'the strip counts the ones with no photo');
  assert.strictEqual((html.match(/bs-pip none/g) || []).length, without, 'and marks each of them');
  assert.strictEqual((html.match(/bs-pip has/g) || []).length, withFile, 'and the ones that have one');
});

test('a receipt too long for one photo is kept as every photo', async () => {
  // A Costco receipt is a metre long. It gets photographed in three, and all
  // three are the receipt — keeping the first was keeping the top third.
  const fd = new FormData();
  Object.entries({ name: 'Monthly Costco run', where_bought: 'Costco', category: 'Supplies',
    amount_cents: '412.60', spent_on: '2026-07-22', paid_by: 'Ana Ortiz', paid_with: 'Company card' })
    .forEach(([k, v]) => fd.set(k, v));
  for (let i = 0; i < 3; i++) {
    fd.append('file', new Blob([Buffer.from(`shot ${i + 1}`)], { type: 'image/jpeg' }), `r${i + 1}.jpg`);
  }
  const res = await fetch(`${BASE}/c/expenses`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.strictEqual(res.status, 302);

  const { pagesOf } = require('../src/modules');
  const r = rows().find((x) => x.name === 'Monthly Costco run');
  const pages = pagesOf(r);
  assert.strictEqual(pages.length, 3, 'all three photos are kept');
  assert.strictEqual(pages[0], r.file, 'the first is the one the row shows');
  pages.forEach((f, i) => {
    assert.strictEqual(fs.readFileSync(path.join(UPLOADS, f)).toString(), `shot ${i + 1}`,
      `photo ${i + 1} is photo ${i + 1}, in the order they were taken`);
  });

  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  const at = html.indexOf('Monthly Costco run');
  const block = html.slice(html.lastIndexOf('<details', at), html.indexOf('</details>', at));
  assert.match(block, /3 pages/, 'and the row says there are three');
});

test('the one-photo receipt is exactly as it was', async () => {
  const one = rows().find((x) => x.name === 'Two bags of ice');
  assert.ok(one && one.file, 'the ice receipt is one photo — the precondition');
  assert.strictEqual(one.pages, null, 'it stores no page list');
  const { pagesOf } = require('../src/modules');
  assert.deepStrictEqual(pagesOf(one), [one.file], 'and reads as its single file');
});

// ---------------------------------------------------------------------------
// Reading the receipt.
//
// The reader itself is not called here — that would need a key, a network and
// somebody's bill. What is asserted is the wiring around it: that the endpoint
// exists and answers rather than throwing, that the modal which takes a photo
// is the modal that sends it to be read, and that every field the reader fills
// has somewhere to say it was read.
// ---------------------------------------------------------------------------

test('the receipt reader answers rather than throwing when there is no key', async () => {
  // The suite runs without ANTHROPIC_API_KEY, which is the same shape as a key
  // that expired in production. It has to come back as a sentence the modal
  // can print, not a 500 that leaves a spinner turning.
  const fd = new FormData();
  fd.set('scan', new Blob([Buffer.from('%PDF-1.4 receipt')], { type: 'application/pdf' }), 'r.pdf');
  const res = await fetch(`${BASE}/c/expenses/read`, { method: 'POST', body: fd });
  assert.strictEqual(res.status, 200, 'it answers');
  const j = await res.json();
  assert.ok(j.error, 'with an error the modal can show');
  assert.match(j.error, /ANTHROPIC_API_KEY|Could not read/, `and says what went wrong: ${j.error}`);
});

test('the modal that takes a receipt is the one that sends it to be read', async () => {
  // Attaching a photo and having nothing happen was the complaint. The photo
  // tile and the read call have to be in the same place.
  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  assert.match(html, /id="qx-file"/, 'the quick modal takes a photo');
  assert.match(html, /'\/c\/expenses\/read'/, 'and the page posts one to be read');
  // Every field the reader fills needs a mark to report into, or a read lands
  // silently and looks like the fields were always that way.
  for (const f of ['name', 'amount_cents', 'spent_on', 'where_bought', 'category']) {
    assert.match(html, new RegExp(`class="cap-mark" data-for="${f}"`), `${f} can say it was read`);
  }
  // Defined is not called. The original complaint was a photo tile that
  // accepted a receipt and did nothing with it, and a reader that exists but
  // is never invoked looks identical from the outside.
  assert.match(html, /function read\(\)/, 'a read function exists');
  assert.match(html, /\bread\(\);/, 'and something actually calls it');
  assert.match(html, /file\.addEventListener\('change', shown\)/, 'when a photo is attached');
});

test('a read never takes back a field somebody typed', async () => {
  // The promise made on screen is "keep typing, it will not overwrite what you
  // touch". Both the modal and the scan overlay have to keep it.
  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  const guards = html.match(/if \(touched\[name\]\) return;/g) || [];
  assert.strictEqual(guards.length, 2,
    `both the quick modal and the capture overlay guard typed fields (found ${guards.length})`);
  assert.match(html, /touched\[e\.target\.name\] = true/, 'and both record what was touched');
});

test('who paid is never guessed from a receipt', async () => {
  // A card receipt does not say whose card it is. Filling it in would invent a
  // debt to a named person, which is the one field on this page that decides
  // whether the restaurant owes somebody money.
  const { EXPENSE_SCHEMA } = require('../src/reader');
  assert.ok(!EXPENSE_SCHEMA.properties.paid_by, 'the reader is not even asked who paid');
  assert.match(EXPENSE_SCHEMA.properties.paid_with.description, /guessing it wrong creates a debt/i,
    'and paid_with says why it stays empty unless printed');
  assert.ok(EXPENSE_SCHEMA.properties.paid_with.enum.includes(''), 'so "" is a valid answer');
});

// ---------------------------------------------------------------------------
// What a row is called.
//
// A ledger is scanned for where the money went — Costco, Mighty Bread, Home
// Depot — and what was in the bag is the detail you open the row for. The row
// used to lead with the description and trail the shop in faint type, which is
// the wrong way round for scanning a column of spend.
// ---------------------------------------------------------------------------

/** The whole <details> block for one expense row. */
function rowOf(html, needle) {
  const at = html.indexOf(needle);
  if (at === -1) return '';
  const from = html.lastIndexOf('<details', at);
  return html.slice(from, html.indexOf('</details>', at));
}
/** Just its summary line — the row as it reads before you open it. */
function summaryOf(html, needle) {
  const block = rowOf(html, needle);
  return block.slice(0, block.indexOf('</summary>'));
}

test('the row is headed by the shop, and the description is inside it', async () => {
  await logExpense({ name: 'Baguettes, croissants and pastries', where_bought: 'Mighty Bread Grab & Go',
    category: 'Groceries', amount_cents: '45.64', spent_on: '2026-08-01',
    paid_by: 'Ana Ortiz', paid_with: 'Company card' });

  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  const summary = summaryOf(html, 'Mighty Bread Grab &amp; Go');
  assert.ok(summary, 'the row is on the page');
  assert.match(summary, /class="bs-xr-w">Mighty Bread Grab &amp; Go</,
    'the shop is what the row is called');
  assert.ok(!/Baguettes, croissants and pastries/.test(summary),
    'and the description is not competing with it on the summary line');

  // It is not lost — it is one click away, labelled.
  assert.match(rowOf(html, 'Mighty Bread Grab &amp; Go'),
    /What was bought<\/span><b>Baguettes, croissants and pastries<\/b>/,
    'the detail says what was actually bought');
});

test('an expense with no shop still has a name on the row', async () => {
  // Where is optional — a parking meter has no merchant. Leading with a blank
  // row would be worse than leading with the description.
  await logExpense({ name: 'Parking for the produce run', category: 'Travel',
    amount_cents: '18.00', spent_on: '2026-08-02', paid_by: 'Rosa Diaz', paid_with: 'Their own money' });

  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  const summary = summaryOf(html, 'Parking for the produce run');
  assert.match(summary, /class="bs-xr-w">Parking for the produce run</,
    'it falls back to the description rather than rendering an empty row');
});

test('moving the description off the row does not make it unsearchable', async () => {
  // The row no longer shows what was bought, so the search index is the only
  // thing keeping "croissants" able to find it.
  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  const summary = summaryOf(html, 'Mighty Bread Grab &amp; Go');
  const search = (summary.match(/data-search="([^"]*)"/) || [])[1] || '';
  assert.match(search, /baguettes, croissants and pastries/, 'the description is still searchable');
  assert.match(search, /mighty bread/, 'and so is the shop');
});
