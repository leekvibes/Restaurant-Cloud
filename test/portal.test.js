'use strict';

// The staff portal, both ends of it.
//
// Two things here are worth more than the rest. The first is that the shape of
// somebody's portal follows their position — a cook must never be asked for
// sales they did not take, and hiding the button is not enough, the route
// behind it has to refuse as well. The second is that what a person is shown
// about their own money is the same figure the manager sees on the shift
// sheet: it comes from the engine, not from a second calculation that can
// drift.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-portal-'));
const DB = path.join(dir, 'portal.db');
let child;
let Database;
let db;

const { isoDate, startOfToday } = require('../src/dates');
const today = () => isoDate(startOfToday());

const form = (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});

/** PIN in, portal cookie out — the same door staff use. */
async function signIn(pin) {
  const res = await form('/tips/start', { pin });
  assert.strictEqual(res.status, 302, `PIN ${pin} is accepted`);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^zwin_portal=/, 'and comes back with who it is');
  return cookie;
}
const asStaff = (p, cookie) => fetch(BASE + p, { headers: { cookie } });

test.before(async () => {
  Database = require('better-sqlite3');
  const env = { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '', ZWIN_SKIP_BACKFILL: '1' };
  const boot = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...env, PORT: String(PORT + 40) }, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`http://127.0.0.1:${PORT + 40}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  boot.kill();
  await new Promise((r) => setTimeout(r, 300));

  const w = new Database(DB);
  const emp = w.prepare('INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES (?,?,?,1,?)');
  emp.run('Bella Reyes', 'server', 900, '1111');
  emp.run('Marco Diaz', 'kitchen', 1800, '2222');
  emp.run('Ana Ortiz', 'barista', 1500, '3333');

  // A sent shift with real figures, so the earnings page has the engine's own
  // numbers to show rather than a fixture of its own.
  const sh = w.prepare("INSERT INTO shifts (date, daypart, status, created_at) VALUES ('2026-07-22','cafe','sent',datetime('now'))").run().lastInsertRowid;
  const ids = Object.fromEntries(w.prepare('SELECT name, id FROM employees').all().map((e) => [e.name, e.id]));
  const work = w.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)');
  work.run(sh, ids['Bella Reyes'], 'server', 7.5);
  work.run(sh, ids['Marco Diaz'], 'kitchen', 8);
  w.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents)
    VALUES (?,?,?,?,0,?,?)`).run(sh, ids['Bella Reyes'], 185075, 12050, 29999, 6400);
  w.prepare("INSERT INTO products (name, category, unit) VALUES ('Oat milk','Dairy','case')").run();
  w.close();

  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  db = new Database(DB);
});

test.after(() => { if (child) child.kill(); if (db) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// The shape of a portal follows the position.
// ---------------------------------------------------------------------------

test('a server is asked for sales and tips', async () => {
  const html = await (await asStaff('/portal', await signIn('1111'))).text();
  assert.match(html, /Submit tips &amp; sales/, 'the task names both');
  assert.match(html, /Bella/, 'and greets her by name');
});

test('a barista is asked for tips but not sales', async () => {
  const html = await (await asStaff('/portal', await signIn('3333'))).text();
  assert.match(html, /Submit your cash tips/, 'tips only');
  assert.ok(!/Submit tips &amp; sales/.test(html), 'never sales — a barista rings none');
});

test('a cook is asked for nothing, and still gets everything else', async () => {
  const cookie = await signIn('2222');
  const html = await (await asStaff('/portal', cookie)).text();
  assert.match(html, /Nothing to submit/, 'no form is put in front of them');
  assert.ok(!/Submit tips|Submit your cash/.test(html), 'not even a tips one');
  // The point of the whole exercise: they lose the submission and nothing else.
  for (const [href, what] of [['/portal/earnings', 'their own hours and pay'],
    ['/portal/specials', 'the board'], ['/portal/stock', 'reporting stock']]) {
    assert.ok(html.includes(href), `a cook still gets ${what}`);
    assert.strictEqual((await asStaff(href, cookie)).status, 200, `and ${href} opens`);
  }
});

test('hiding the tip form is not the same as refusing it', async () => {
  // A hidden button is a decoration. The route has to say no too, or anybody
  // who kept the URL can post sales they never took.
  const cookie = await signIn('2222');
  const res = await fetch(`${BASE}/portal/tips`, { method: 'POST', redirect: 'manual', headers: { cookie } });
  assert.strictEqual(res.status, 302, 'the cook is turned away at the route');
  assert.match(res.headers.get('location') || '', /\/portal/, 'back to their hub');
});

test('who gets asked is a setting, not a list of role names in the code', async () => {
  // The manager flips it; the portal changes shape on the next load. A
  // restaurant that tips its cooks directly should not need a code change.
  const pos = db.prepare("SELECT id FROM positions WHERE slug = 'kitchen'").get();
  await form(`/staff-portal/position/${pos.id}/tips`, { on: '1' });
  const on = await (await asStaff('/portal', await signIn('2222'))).text();
  assert.match(on, /Submit your cash tips/, 'a cook who is asked, is asked');

  await form(`/staff-portal/position/${pos.id}/tips`, { on: '0' });
  const off = await (await asStaff('/portal', await signIn('2222'))).text();
  assert.match(off, /Nothing to submit/, 'and turning it back off restores the quiet line');
});

// ---------------------------------------------------------------------------
// Money. The same figures the manager sees, never a second calculation.
// ---------------------------------------------------------------------------

test('the money on a server\'s screen reconciles the way the engine defines it', async () => {
  // Deliberately not a string-match against the shift sheet: the two pages
  // aggregate and format differently, so that comparison fails on presentation
  // rather than on arithmetic, and a test that breaks for the wrong reason
  // gets deleted. What is checked instead is the identity the engine itself
  // holds to — if the portal ever grew its own sums, these stop adding up.
  const html = await (await asStaff('/portal/earnings', await signIn('1111'))).text();
  const num = (v) => Math.round(Number(String(v).replace(/[$,−-]/g, '')) * 100);
  const grab = (label) => {
    const m = html.match(new RegExp(label + '[\\s\\S]{0,140}?(−?\\$[\\d,]+\\.\\d{2})'));
    return m ? num(m[1]) : null;
  };
  const kept = grab('You kept');
  const collected = grab('Tips collected');
  const tippedOut = grab('Tipped out to support') || 0;
  const cash = grab('Cash in hand');
  const cheque = grab('To your paycheck');

  assert.ok(kept && collected && cash !== null && cheque !== null,
    `all five figures render: ${JSON.stringify({ kept, collected, tippedOut, cash, cheque })}`);
  assert.ok(tippedOut > 0, 'she tipped out — otherwise this proves less than it looks');
  assert.strictEqual(collected - tippedOut, kept, 'what she collected, less the tip-out, is what she kept');
  assert.strictEqual(cash + cheque, kept, 'and it arrives as cash plus paycheck, nothing lost between');
});

test('a cook is shown what they received, without a tip-out they never paid', async () => {
  // Kitchen does not hand tips in, but it does receive a share of the pot —
  // so the honest screen for a cook is what came to them, not a blank. What it
  // must not show is "tipped out to support", which is money leaving, and a
  // cook is the support it leaves towards.
  const html = await (await asStaff('/portal/earnings', await signIn('2222'))).text();
  assert.match(html, /You kept|You worked|Nothing recorded/, 'it says what they got');
  assert.ok(!/Tipped out to support/.test(html),
    'and never bills them for a tip-out they are on the receiving end of');
});

// ---------------------------------------------------------------------------
// The board, and what travels back.
// ---------------------------------------------------------------------------

test("a manager's 86 reaches the floor", async () => {
  const d = today();
  await form('/staff-portal/special', { d, name: 'Qqx Branzino', price: '31.00', description: 'Whole fish.' });
  const dish = db.prepare("SELECT id FROM portal_specials WHERE name = 'Qqx Branzino'").get();
  assert.ok(dish, 'it is on the board');

  const cookie = await signIn('1111');
  const before = await (await asStaff('/portal/specials', cookie)).text();
  assert.match(before, /Running today/, 'and running');

  await form(`/staff-portal/special/${dish.id}/86`, { note: '' });
  const after = await (await asStaff('/portal/specials', cookie)).text();
  assert.match(after, /86'd — don't offer/, 'the 86 section appears');
  // The time is the point — it tells a server whether it went before or after
  // they last looked.
  const row = db.prepare('SELECT * FROM portal_specials WHERE id = ?').get(dish.id);
  assert.ok(row.eighty_sixed_at, 'stamped when');
  assert.match(row.sold_out_note, /86'D \d+(AM|PM)/, `and says so: ${row.sold_out_note}`);
});

test('a note stops showing the day after it expires', async () => {
  const yesterday = isoDate(new Date(startOfToday().getTime() - 86400000));
  await form('/staff-portal/note', { title: 'Qqx Stale notice', body: 'Old news.', tone: 'fyi',
    starts_on: yesterday, ends_on: yesterday });
  await form('/staff-portal/note', { title: 'Qqx Live notice', body: 'Today only.', tone: 'urgent',
    starts_on: today(), ends_on: today() });

  const html = await (await asStaff('/portal', await signIn('1111'))).text();
  assert.match(html, /Qqx Live notice/, 'today\'s note shows');
  assert.ok(!/Qqx Stale notice/.test(html),
    'and yesterday\'s does not — a board that keeps stale notices is one nobody reads');
});

test('a report from the floor arrives on the manager page, linked to the product', async () => {
  const cookie = await signIn('1111');
  const res = await form('/portal/stock', {
    items: JSON.stringify([
      { item: 'Oat milk', status: 'out', note: 'Going through 3 a day' },
      { item: 'Qqx Nothing We Buy', status: 'low', note: '' },
    ]),
  }, { cookie });
  assert.strictEqual(res.status, 302);

  const rows = db.prepare("SELECT * FROM portal_stock WHERE item IN ('Oat milk','Qqx Nothing We Buy') ORDER BY item").all();
  assert.strictEqual(rows.length, 2, 'both were filed');
  const oat = rows.find((r) => r.item === 'Oat milk');
  const other = rows.find((r) => r.item !== 'Oat milk');
  assert.ok(oat.product_id, 'a name we already buy links to the product, so the vendor is one join away');
  assert.strictEqual(other.product_id, null, 'and one we do not buy is kept as words rather than guessed at');
  assert.strictEqual(oat.reported_by, 'Bella Reyes', 'with who said so');
  assert.strictEqual(oat.batch, other.batch, 'and both in one batch — she pressed send once');

  const admin = await (await fetch(`${BASE}/staff-portal`)).text();
  assert.match(admin, /Oat milk/, 'the manager sees it');
  assert.match(admin, /in Products/i, 'and that it is something already bought');
});

test('resolving a report takes it off the list without deleting it', async () => {
  const open = db.prepare('SELECT id FROM portal_stock WHERE resolved_at IS NULL LIMIT 1').get();
  assert.ok(open, 'something is open');
  await form(`/staff-portal/stock/${open.id}/resolve`, { resolution: 'ordered' });

  const row = db.prepare('SELECT * FROM portal_stock WHERE id = ?').get(open.id);
  assert.strictEqual(row.resolution, 'ordered');
  assert.ok(row.resolved_at, 'and when');
  assert.ok(row.item, 'the report is still there — the history is the point');

  // And the person who reported it can see it was dealt with.
  const mine = await (await asStaff('/portal/stock', await signIn('1111'))).text();
  assert.match(mine, /Recently sent/, 'their own screen closes the loop');
});

// ---------------------------------------------------------------------------
// The doors.
// ---------------------------------------------------------------------------

test('the portal is shut to anyone without a live PIN session', async () => {
  for (const p of ['/portal', '/portal/earnings', '/portal/specials', '/portal/stock']) {
    const res = await fetch(BASE + p, { redirect: 'manual' });
    assert.strictEqual(res.status, 302, `${p} is not open to the world`);
    assert.match(res.headers.get('location') || '', /\/tips/, 'it asks for a PIN');
  }
});

test('the PIN screen still names nobody', async () => {
  // Unchanged and load-bearing: an open link that listed the roster would
  // publish it to anyone who found the URL.
  const html = await (await fetch(`${BASE}/tips`)).text();
  for (const name of ['Bella', 'Marco', 'Ana', 'Reyes']) {
    assert.ok(!html.includes(name), `${name} is not on the sign-in page`);
  }
});

test('signing out of the portal actually ends it', async () => {
  const cookie = await signIn('1111');
  assert.strictEqual((await asStaff('/portal', cookie)).status, 200, 'in');
  const out = await fetch(`${BASE}/portal/out`, { redirect: 'manual', headers: { cookie } });
  assert.match(out.headers.get('set-cookie') || '', /zwin_portal=;/, 'the cookie is cleared');
});
