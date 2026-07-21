'use strict';

// Cash reconciliation. Three amounts that are easy to conflate — what was
// counted, what stays in the register, what gets banked — and a variance that
// is somebody's money if it is wrong.
//
// The HTTP tests matter more than usual here: the form is where paid-outs get
// summed and where a blank deposit turns into a calculated one, and neither
// happens if you call the helpers directly.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3963;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cash-'));
const DB = path.join(dir, 'c.db');
process.env.DB_PATH = DB;
const C = require('../src/cash');
let child, Database;

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const msgOf = (res) => decodeURIComponent((res.headers.get('location') || '').split('msg=')[1] || '');
const idOf = (res) => Number((res.headers.get('location') || '').match(/\/cash\/(\d+)/)?.[1]);

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
test.after(() => { if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const base = (over = {}) => ({
  date: '2026-07-20', daypart: 'cafe', drawer_id: '1',
  float: '200', cash_sales: '333', counted: '533', ending: '200',
  counted_by: 'Malek', status: 'final', ...over,
});

// --- the sums ---------------------------------------------------------------

test('the worked example from the brief', () => {
  const c = C.compute({ float_cents: 20000, cash_sales_cents: 33300, paid_out_cents: 12000,
    cash_added_cents: 0, counted_cents: 43300, ending_float_cents: 20000, actual_deposit_cents: 23300 });
  assert.strictEqual(c.expected, 41300, '$200 + $333 − $120');
  assert.strictEqual(c.variance, 2000, '$20 over');
  assert.strictEqual(c.calcDeposit, 23300, 'counted less what stays in the register');
  assert.strictEqual(c.unaccounted, 0);
});

test('the deposit comes off what was counted, not what was expected', () => {
  // A drawer $20 over banks $20 more. Depositing the expected figure would
  // leave the surplus sitting in the register and hide it.
  const over = C.compute({ float_cents: 20000, cash_sales_cents: 33300, paid_out_cents: 12000, counted_cents: 43300, ending_float_cents: 20000 });
  const short = C.compute({ float_cents: 20000, cash_sales_cents: 33300, paid_out_cents: 12000, counted_cents: 39300, ending_float_cents: 20000 });
  assert.strictEqual(over.calcDeposit, 23300);
  assert.strictEqual(short.calcDeposit, 19300, 'a short drawer banks less');
  assert.strictEqual(over.calcDeposit - short.calcDeposit, over.variance - short.variance);
});

test('cash added raises what the drawer should hold', () => {
  const c = C.compute({ float_cents: 20000, cash_sales_cents: 10000, paid_out_cents: 0, cash_added_cents: 5000, counted_cents: 35000 });
  assert.strictEqual(c.expected, 35000);
  assert.strictEqual(c.variance, 0);
});

test('an exact drawer, an over drawer and a short drawer read differently', () => {
  const at = (counted) => C.status({ status: 'final', float_cents: 20000, cash_sales_cents: 10000, paid_out_cents: 0, counted_cents: counted });
  assert.strictEqual(at(30000).key, 'exact');
  assert.strictEqual(at(30300).key, 'within', '$3 is within tolerance');
  assert.strictEqual(at(31000).key, 'review', '$10 wants a look');
  assert.strictEqual(at(24000).key, 'critical', '$60 short is critical');
  assert.match(at(24000).label, /short/);
  assert.match(at(31000).label, /over/);
});

test('variance is never shown as a bare negative number', () => {
  const s = C.status({ status: 'final', float_cents: 20000, cash_sales_cents: 10000, counted_cents: 22000 });
  assert.match(s.label, /\$80\.00 short/);
  assert.ok(!s.label.includes('-'), `reads as words, not a minus: ${s.label}`);
});

test('under-banking is unaccounted cash, which is a different thing from variance', () => {
  const c = C.compute({ float_cents: 20000, cash_sales_cents: 33300, paid_out_cents: 12000,
    counted_cents: 43300, ending_float_cents: 20000, actual_deposit_cents: 22500 });
  assert.strictEqual(c.variance, 2000, 'the drawer was still $20 over');
  assert.strictEqual(c.unaccounted, 800, 'and $8 of the deposit is missing');
});

// --- the settings -----------------------------------------------------------

test('the opening till defaults to $200 and is a setting, not a constant', () => {
  assert.strictEqual(C.defaultFloat(), 20000);
  C.setSetting('cash_default_float', 25000);
  assert.strictEqual(C.defaultFloat(), 25000, 'a different restaurant can open on a different float');
  C.setSetting('cash_default_float', 20000);
});

// --- through the form -------------------------------------------------------

test('saving through the form stores every figure and itemises the paid-outs', async () => {
  const res = await post('/cash', base({
    counted: '433',
    paid_amt_0: '80', paid_reason_0: 'Store purchase', paid_who_0: 'Kevin',
    paid_amt_1: '40', paid_reason_1: 'Petty cash', paid_who_1: 'Sandra',
    variance_note: 'Found a twenty under the tray',
  }));
  assert.strictEqual(res.status, 302);
  const id = idOf(res);
  assert.ok(id, `saved, got ${res.headers.get('location')}`);

  const db = new Database(DB, { readonly: true });
  const row = db.prepare('SELECT * FROM cash_recon WHERE id = ?').get(id);
  const mv = db.prepare('SELECT * FROM cash_movements WHERE recon_id = ? ORDER BY id').all(id);
  db.close();

  assert.strictEqual(row.paid_out_cents, 12000, 'two paid-outs summed');
  assert.strictEqual(mv.length, 2, 'and both kept individually');
  assert.strictEqual(mv[0].recipient, 'Kevin');
  assert.strictEqual(row.counted_cents, 43300);
  assert.strictEqual(row.ending_float_cents, 20000);
  assert.strictEqual(row.actual_deposit_cents, 23300, 'deposit worked out from the count');
  assert.strictEqual(row.counted_by, 'Malek');
  assert.strictEqual(row.status, 'final');
  assert.ok(row.finalized_at, 'and stamped');
});

test('a blank deposit means "whatever the drawer says"', async () => {
  const id = idOf(await post('/cash', base({ date: '2026-07-11', deposit: '' })));
  assert.ok(id, 'saved');
  const db = new Database(DB, { readonly: true });
  const row = db.prepare('SELECT * FROM cash_recon WHERE id = ?').get(id);
  db.close();
  assert.strictEqual(row.actual_deposit_cents, 33300, '$533 counted less the $200 that stays in the register');
});

test('an optional denomination count is stored and totals the same', async () => {
  const id = idOf(await post('/cash', base({
    date: '2026-07-12', denom_10000: '5', denom_500: '6', denom_100: '3',
  })));
  const db = new Database(DB, { readonly: true });
  const d = db.prepare('SELECT * FROM cash_denoms WHERE recon_id = ? ORDER BY denom_cents DESC').all(id);
  db.close();
  assert.strictEqual(d.length, 3);
  assert.strictEqual(d.reduce((a, x) => a + x.denom_cents * x.qty, 0), 53300, '5×$100 + 6×$5 + 3×$1');
});

test('the guards refuse what should be refused', async () => {
  const cases = [
    [{ cash_sales: '-5' }, /negative/i],
    [{ counted: '' }, /count the drawer/i],
    [{ counted_by: '' }, /who counted/i],
    // With no deposit typed this is caught as a negative deposit, so the case
    // below pins the register guard on its own — otherwise either error
    // satisfies the assertion and the guard could be deleted unnoticed.
    [{ counted: '250', ending: '400' }, /negative/i],
    [{ counted: '250', ending: '400', deposit: '0' }, /more in the register/i],
    [{ counted: '400', variance_note: '' }, /needs a note/i],
    [{ deposit: '100' }, /unaccounted/i],
  ];
  for (const [over, re] of cases) {
    const res = await post('/cash', base({ date: '2026-07-13', ...over }));
    assert.match(msgOf(res), re, `${JSON.stringify(over)} should be refused`);
  }
});

test('a draft may be as incomplete as it likes', async () => {
  const res = await post('/cash', { date: '2026-07-14', daypart: 'cafe', float: '200', status: 'draft' });
  assert.ok(idOf(res), 'saved with no count and no counter');
});

test('zero sales and a drawer holding only the float is fine', async () => {
  const id = idOf(await post('/cash', base({ date: '2026-07-15', cash_sales: '0', counted: '200', ending: '200' })));
  const db = new Database(DB, { readonly: true });
  const row = db.prepare('SELECT * FROM cash_recon WHERE id = ?').get(id);
  db.close();
  const c = C.compute(row);
  assert.strictEqual(c.variance, 0);
  assert.strictEqual(c.calcDeposit, 0, 'nothing to bank');
});

// --- financial safety -------------------------------------------------------

test('a finalised record is voided, never deleted, and voiding needs a reason', async () => {
  const id = idOf(await post('/cash', base({ date: '2026-07-16' })));
  assert.match(msgOf(await post(`/cash/${id}/delete`, {})), /voided, not deleted/i);
  assert.match(msgOf(await post(`/cash/${id}/void`, {})), /needs a reason/i);

  await post(`/cash/${id}/void`, { reason: 'Counted twice by mistake' });
  const db = new Database(DB, { readonly: true });
  const row = db.prepare('SELECT * FROM cash_recon WHERE id = ?').get(id);
  const audit = db.prepare("SELECT * FROM cash_audit WHERE recon_id = ? AND action='void'").all(id);
  db.close();
  assert.strictEqual(row.status, 'void');
  assert.ok(row.voided_at && row.void_reason, 'and says who and why');
  assert.strictEqual(audit.length, 1);
  assert.ok(row.counted_cents, 'the figures survive the void');
});

test('a draft can be deleted outright', async () => {
  const id = idOf(await post('/cash', { date: '2026-07-17', daypart: 'cafe', float: '200', status: 'draft' }));
  await post(`/cash/${id}/delete`, {});
  const db = new Database(DB, { readonly: true });
  const gone = db.prepare('SELECT COUNT(*) n FROM cash_recon WHERE id = ?').get(id).n;
  db.close();
  assert.strictEqual(gone, 0);
});

test('editing a record leaves an audit trail of what changed', async () => {
  const id = idOf(await post('/cash', base({ date: '2026-07-18' })));
  await post(`/cash/${id}`, base({ date: '2026-07-18', cash_sales: '400', counted: '500',
    variance_note: 'Recount after the till roll was found' }));

  const db = new Database(DB, { readonly: true });
  const audit = db.prepare('SELECT * FROM cash_audit WHERE recon_id = ? ORDER BY id').all(id);
  db.close();
  const changed = audit.filter((a) => a.action === 'edit').map((a) => a.field);
  assert.ok(changed.includes('cash_sales_cents'), `sales change recorded: ${changed.join(',')}`);
  assert.ok(changed.includes('counted_cents'), 'and the recount');
  const sales = audit.find((a) => a.field === 'cash_sales_cents' && a.action === 'edit');
  assert.strictEqual(sales.old_value, '33300');
  assert.strictEqual(sales.new_value, '40000', 'old and new both kept');
  assert.ok(audit.some((a) => a.action === 'reopen'), 'and that a finalised record was reopened');
});

// --- what the dashboard is allowed to shout about ---------------------------

test('the alert feed skips drafts and voids and counts cash added', async () => {
  // The old alert had its own copy of the variance sum. It predated cash
  // added, so a drawer topped up with change read as over; and it read every
  // row, so a withdrawn count nagged for a fortnight after being voided.
  const draft = idOf(await post('/cash', { date: '2026-07-19', daypart: 'cafe', float: '200',
    cash_sales: '300', counted: '100', status: 'draft' }));
  const voided = idOf(await post('/cash', base({ date: '2026-07-19', daypart: 'dinner',
    counted: '400', variance_note: 'Recount pending' })));
  await post(`/cash/${voided}/void`, { reason: 'Counted the wrong drawer' });

  const feed = C.q.recent.all().map((r) => r.id);
  assert.ok(!feed.includes(draft), 'a draft is not a finished count');
  assert.ok(!feed.includes(voided), 'and a voided one has been withdrawn');

  // $200 float + $100 sales + $50 put in for change = $350, and that is what
  // was there. Nothing to raise.
  assert.strictEqual(C.status({ status: 'final', float_cents: 20000, cash_sales_cents: 10000,
    cash_added_cents: 5000, counted_cents: 35000 }).key, 'exact');
});

// --- the list ---------------------------------------------------------------

test('the list groups by month and the detail page opens', async () => {
  const html = await (await fetch(`${BASE}/cash?r=ytd`)).text();
  assert.ok(html.includes('data-month'), 'grouped by month');
  assert.ok(html.includes('Cash reconciliation'), 'renamed from Cash count');
  assert.ok(!/theft/i.test(html), 'and does not accuse anyone of theft');

  const db = new Database(DB, { readonly: true });
  const id = db.prepare("SELECT id FROM cash_recon WHERE status='final' ORDER BY id DESC LIMIT 1").get().id;
  db.close();
  const detail = await (await fetch(`${BASE}/cash/${id}`)).text();
  assert.ok(detail.includes('History'), 'with its audit trail');
});

// --- the detail page ------------------------------------------------------------
//
// A summary of how the drawer closed, not a record with a UI on it. It answers
// five questions in order and the order is the point.

test('the detail page answers the five questions in order', async () => {
  const id = idOf(await post('/cash', base({
    date: '2026-07-05', counted: '433',
    paid_amt_0: '80', paid_reason_0: 'Store purchase', paid_who_0: 'Kevin',
    paid_amt_1: '40', paid_reason_1: 'Petty cash', paid_who_1: 'Sandra',
    variance_note: 'Found a twenty under the tray', deposit_destination: 'Safe',
  })));
  const h = await (await fetch(`${BASE}/cash/${id}`)).text();

  const at = (needle) => h.indexOf(needle);
  assert.ok(at('cr-hero') > -1, '1. was it right');
  assert.ok(at('How that was worked out') > -1, '2. how was that reached');
  assert.ok(at('What moved in and out') > -1, '3. what moved');
  assert.ok(at('cr-dep') > -1, '4. what was banked');
  assert.ok(at('cr-by') > -1, '5. who closed it');
  assert.ok(at('cr-hero') < at('How that was worked out'), 'the verdict comes before the arithmetic');
  assert.ok(at('How that was worked out') < at('What moved in and out'));
  assert.ok(at('What moved in and out') < at('cr-by'), 'and the byline is last');

  assert.match(h, /\$20\.00 over/, 'the verdict is in words, not a signed number');
  assert.match(h, /Found a twenty under the tray/, 'with the explanation beside it');
  assert.match(h, /to the safe/, 'and where the money went');
});

test('history, denominations and voiding are collapsed, not on the page', async () => {
  const id = idOf(await post('/cash', base({ date: '2026-07-06', denom_10000: '5', denom_500: '6', denom_100: '3' })));
  const h = await (await fetch(`${BASE}/cash/${id}`)).text();
  // Present and reachable, but folded away — a normal review never opens them.
  for (const [label, what] of [['Counted by denomination', 'denominations'], ['History', 'the audit trail'], ['Void this reconciliation', 'voiding']]) {
    const i = h.indexOf(label);
    assert.ok(i > -1, `${what} is still reachable`);
    const before = h.lastIndexOf('<details', i);
    assert.ok(before > -1 && !h.slice(before, i).includes('</details>'), `${what} sits inside a disclosure`);
  }
});

test('creating a record is one thing that happened, not eleven', async () => {
  const id = idOf(await post('/cash', base({ date: '2026-07-07' })));
  const db2 = new Database(DB, { readonly: true });
  const made = db2.prepare("SELECT * FROM cash_audit WHERE recon_id=? AND action='create'").all(id);
  db2.close();
  // Diffing a new row against nothing logged every populated field separately,
  // so one save read as eleven near-identical lines carrying the same reason.
  assert.strictEqual(made.length, 1, `one create entry, got ${made.length}`);
  assert.strictEqual(made[0].field, null, 'covering the record, not a field');
  assert.strictEqual(made[0].new_value, '53300', 'and noting what the drawer came to');
});

test('an edit is still itemised field by field', async () => {
  const id = idOf(await post('/cash', base({ date: '2026-07-08' })));
  await post(`/cash/${id}`, base({ date: '2026-07-08', cash_sales: '400', counted: '600',
    variance_note: 'Recount' }));
  const db2 = new Database(DB, { readonly: true });
  const edits = db2.prepare("SELECT field FROM cash_audit WHERE recon_id=? AND action='edit'").all(id).map((a) => a.field);
  db2.close();
  assert.ok(edits.includes('cash_sales_cents') && edits.includes('counted_cents'),
    `collapsing create must not collapse edits, got: ${edits.join(',')}`);
});

test('money in the audit trail reads as money', async () => {
  const id = idOf(await post('/cash', base({ date: '2026-07-04' })));
  await post(`/cash/${id}`, base({ date: '2026-07-04', cash_sales: '400', counted: '600', variance_note: 'Recount' }));
  const h = await (await fetch(`${BASE}/cash/${id}`)).text();
  assert.match(h, /\$333\.00 → \$400\.00/, 'not 33300 → 40000');
});

// --- closing at 10:30pm ---------------------------------------------------------
//
// A reconciliation needs two numbers a human has to supply: what the POS rang
// in cash, and what is in the drawer. Everything else is known or derived. The
// form had nineteen fields on it, which is nineteen chances to stall somebody
// who wants to go home.

test('the close asks for two numbers and nothing else', async () => {
  const html = await (await fetch(`${BASE}/cash/new`)).text();
  // The three panels holding the other seventeen fields all start closed.
  for (const id of ['cq-ctxbox', 'cq-money', 'cq-adv']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*\\bhidden\\b`), `${id} starts closed`);
  }
  assert.match(html, /id="cq-varwrap"[^>]*\bhidden\b/, 'and the variance note only appears when owed');
  // What is left standing is the two numbers, and who counted them.
  const two = html.slice(html.indexOf('class="cq-two"'), html.indexOf('id="cq-v"'));
  const fields = two.match(/<(input|select|textarea)\b(?![^>]*type="hidden")/g) || [];
  assert.strictEqual(fields.length, 2, `two numbers, got ${fields.length}`);
  assert.ok(two.includes('name="cash_sales"') && two.includes('name="counted"'));
  assert.match(html, /class="fld cq-who">Counted by\s*\n\s*<input name="counted_by"/,
    'and one field for who counted, outside any panel');
  // Both take a numeric keypad. A manager standing at a register should not
  // get a full qwerty for a dollar amount.
  assert.strictEqual((two.match(/inputmode="decimal"/g) || []).length, 2);
});

test('everything hidden still posts, so a full close is one round trip', async () => {
  // The advanced fields are collapsed, not removed. A reconciliation that uses
  // them must save in the same submit as one that doesn't.
  const res = await post('/cash', base({
    date: '2026-07-09', counted: '433',
    paid_amt_0: '80', paid_reason_0: 'Store purchase', paid_who_0: 'Kevin',
    paid_amt_1: '40', paid_reason_1: 'Petty cash', paid_who_1: 'Sandra',
    variance_note: 'Found a twenty under the tray',
    deposit_destination: 'Bank', deposit_bag: 'B-114', deposit_reference: 'R-9',
    verified_by: 'Houston', note: 'POS was down for ten minutes',
    denom_10000: '4', denom_500: '6', denom_100: '3',
  }));
  const id = idOf(res);
  assert.ok(id, `saved, got ${res.headers.get('location')}`);
  const db2 = new Database(DB, { readonly: true });
  const row = db2.prepare('SELECT * FROM cash_recon WHERE id = ?').get(id);
  const dn = db2.prepare('SELECT COUNT(*) n FROM cash_denoms WHERE recon_id = ?').get(id).n;
  db2.close();
  assert.strictEqual(row.paid_out_cents, 12000);
  assert.strictEqual(row.deposit_destination, 'Bank');
  assert.strictEqual(row.deposit_bag, 'B-114');
  assert.strictEqual(row.verified_by, 'Houston');
  assert.strictEqual(dn, 3, 'denominations survive being behind a disclosure');
});

test('the opening till and the ending float are assumed, not asked for', async () => {
  // Neither appears on the open form. A close that touches neither must still
  // land on $200 in and $200 left, or the deposit is wrong every night.
  const id = idOf(await post('/cash', {
    date: '2026-07-10', daypart: 'cafe', cash_sales: '333', counted: '533',
    counted_by: 'Malek', status: 'final',
  }));
  assert.ok(id, 'saves with neither float supplied');
  const db2 = new Database(DB, { readonly: true });
  const row = db2.prepare('SELECT * FROM cash_recon WHERE id = ?').get(id);
  db2.close();
  assert.strictEqual(row.float_cents, 20000, 'opened on the usual till');
  assert.strictEqual(row.ending_float_cents, 20000, 'and leaves the usual till behind');
  assert.strictEqual(row.actual_deposit_cents, 33300, 'and banked the count less the till');
  assert.strictEqual(C.compute(row).variance, 0, 'which reconciles exactly');
});

test('a new close defaults to the service that actually ran', async () => {
  const w = new Database(DB);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  w.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'cafe', 'open')").run(today);
  w.close();
  const html = await (await fetch(`${BASE}/cash/new`)).text();
  // A café that never serves dinner should not correct this field every night.
  assert.match(html, /<option value="cafe" selected>/, 'picks up today\'s service');
});

// --- money in and out of the drawer ---------------------------------------------
//
// Typing $75 into a row and pressing Add produced a second empty row and no
// sign that anything had registered, so the entry read as lost. It was in fact
// saving correctly the whole time — which is worse, because the manager's only
// options were to retype it or to distrust the page.

test('an entry is committed to a line you can read, and posts what it shows', async () => {
  const html = await (await fetch(`${BASE}/cash/new`)).text();
  // The line you type into carries no name, so a half-finished entry cannot
  // post on its own.
  const draft = html.slice(html.indexOf('data-draft="paid"'), html.indexOf('data-draft="added"'));
  assert.ok(!/name="/.test(draft), `the draft line posts nothing: ${draft.slice(0, 200)}`);
  assert.match(draft, /onclick="cashCommit\('paid'\)"/, 'and has an Add that commits it');
  assert.match(html, /id="paid-total"/, 'with a running total');
});

test('an existing record renders its movements as committed lines', async () => {
  const id = idOf(await post('/cash', base({
    date: '2026-06-05', counted: '433',
    paid_amt_0: '80', paid_reason_0: 'Store purchase', paid_who_0: 'Kevin',
    paid_amt_1: '40', paid_reason_1: 'Petty cash', paid_who_1: 'Sandra',
    variance_note: 'Found a twenty under the tray',
  })));
  const html = await (await fetch(`${BASE}/cash/${id}/edit`)).text();
  assert.strictEqual((html.match(/class="mvi"/g) || []).length, 2, 'two lines');
  // Each carries the fields that post it, numbered from zero without gaps.
  for (const n of ['paid_amt_0', 'paid_reason_0', 'paid_who_0', 'paid_amt_1', 'paid_reason_1', 'paid_who_1']) {
    assert.match(html, new RegExp(`name="${n}"`), `${n} is posted`);
  }
  assert.match(html, /value="80\.00"/);
  assert.match(html, /to Kevin/, 'and reads as a sentence');
});

test('a recipient name is inserted as text, never as markup', async () => {
  // Movement recipients are typed by whoever is closing. The committed line is
  // built in the browser, and building it with innerHTML would run whatever
  // they typed.
  const id = idOf(await post('/cash', base({
    date: '2026-06-06', counted: '433',
    paid_amt_0: '120', paid_reason_0: 'Store purchase',
    paid_who_0: '<img src=x onerror=alert(1)>',
    variance_note: 'Found a twenty under the tray',
  })));
  const html = await (await fetch(`${BASE}/cash/${id}/edit`)).text();
  assert.ok(!html.includes('<img src=x'), 'not rendered as a tag');
  assert.match(html, /&lt;img src=x/, 'escaped instead');

  // The committed line is built in the browser. Neither the reason nor the
  // recipient may be written with innerHTML — both are typed by whoever closed.
  const script = html.slice(html.indexOf('function cashCommit'), html.indexOf('function cashCalc'));
  assert.match(script, /\.mvi-t b'\)\.textContent =/, 'the reason goes in as text');
  assert.match(script, /\.mvi-t i'\)\.textContent =/, 'and so does the recipient');
  assert.ok(!/mvi-t [bi]'\)\.innerHTML/.test(script), 'never innerHTML for a typed value');
});

test('the emitted client scripts survive being written inside a template literal', async () => {
  // cashScript, searchScript and salesScript return their JavaScript from a
  // template literal, so a backslash has to be doubled in the source to reach
  // the browser. `/_amt_\\d+$/` written with one arrived as `/_amt_d+$/`, which
  // matched nothing — every paid-out silently stopped counting towards the
  // expected total, and the variance was wrong on any count that had one.
  //
  // This reads what the browser is actually served. Scanning the source proves
  // nothing: there the escape is still there, whether or not it survives.
  const pages = ['/cash/new', '/sales?r=30', '/'];
  let scanned = 0;

  for (const url of pages) {
    const html = await (await fetch(BASE + url)).text();
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      const body = m[1];
      if (!/function |addEventListener/.test(body)) continue;   // skip config blobs
      scanned++;
      assert.doesNotThrow(() => new (require('node:vm').Script)(body),
        `${url}: a script block does not parse`);
      for (const lit of body.matchAll(/\/[^/\n ]+\//g)) {
        assert.ok(!/[^\\](d\+|w\+|s\+|d\{)/.test(lit[0]),
          `${url}: ${lit[0]} looks like a \\d, \\w or \\s that lost its backslash`);
      }
    }
  }
  assert.ok(scanned >= 2, `scanned ${scanned} script blocks`);
});
