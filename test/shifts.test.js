'use strict';

// The shifts index and the shift sheet, after the broadsheet rewrite.
//
// These two screens had no tests at all, which is how three mutations against
// them survived: dropping every server from the sheet, dropping every support
// person, and letting the stat strip count open shifts. Each of those is a
// visible, wrong page that the suite was happy with.
//
// The contract this file holds is "nothing was taken away". A redesign is
// allowed to move a control; it is not allowed to lose one.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3981;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-shifts-'));
const DB = path.join(dir, 's.db');
let child, Database, db;

const get = (p) => fetch(BASE + p, { redirect: 'manual' });
const html = async (p) => {
  const r = await get(p);
  assert.strictEqual(r.status, 200, `${p} must render`);
  return r.text();
};
const iso = (d) => d.toISOString().slice(0, 10);
const back = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '', ZWIN_SKIP_BACKFILL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  db = new Database(DB);

  const emp = (name, role, rate) => db.prepare(
    'INSERT INTO employees (name, role, hourly_rate_cents, active, pay_type) VALUES (?, ?, ?, 1, \'hourly\')')
    .run(name, role, rate).lastInsertRowid;
  const people = {
    sandra: emp('Sandra Moyer', 'server', 1000),
    kevin: emp('Kevin Korah', 'kitchen', 1400),
    joseph: emp('Joseph Yanzaguano', 'busser', 1300),
  };

  const shift = (date, daypart, status) => db.prepare(
    'INSERT INTO shifts (date, daypart, status) VALUES (?, ?, ?)').run(date, daypart, status).lastInsertRowid;
  const work = (sh, e, role, hours) => db.prepare(
    'INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?, ?, ?, ?)').run(sh, e, role, hours);
  const sales = (sh, e, food, tips) => db.prepare(
    `INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents)
     VALUES (?, ?, ?, 0, 0, ?, 0)`).run(sh, e, food, tips);

  // One of each lifecycle state, so every branch renders somewhere.
  const sent = shift(back(4), 'cafe', 'emailed');
  work(sent, people.sandra, 'server', 8); sales(sent, people.sandra, 120000, 20000);
  work(sent, people.kevin, 'kitchen', 7);

  const ready = shift(back(3), 'cafe', 'open');
  work(ready, people.sandra, 'server', 8); sales(ready, people.sandra, 100000, 18000);
  work(ready, people.joseph, 'busser', 6);

  const review = shift(back(2), 'dinner', 'open');
  work(review, people.sandra, 'server', 0); sales(review, people.sandra, 90000, 15000);

  shift(back(1), 'cafe', 'open');                    // nobody on it

  const open = shift(iso(new Date()), 'cafe', 'open');   // today
  work(open, people.kevin, 'kitchen', 4);

  Object.assign(module.exports, { people, sent, ready, review, open });
});
test.after(() => { if (db) db.close(); if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

// --- the index ------------------------------------------------------------------

test('every lifecycle state has somewhere to appear', async () => {
  const h = await html('/shifts');
  // Sent, Open, Needs review, Ready to send and Nobody on it are five distinct
  // answers to "what is left to do here". Losing one loses a whole category.
  for (const label of ['SENT', 'OPEN', 'NEEDS REVIEW', 'READY TO SEND', 'NOBODY ON IT']) {
    assert.ok(h.includes(label), `${label} renders`);
  }
});

test('the stat strip excludes open shifts', async () => {
  const h = await html('/shifts');
  assert.match(h, /open shifts excluded/, 'and says so on the page');

  // Today's shift has hours and no sales. Counting it would drag the average
  // down — today is never a measurement.
  const strip = h.slice(h.indexOf('bs-strip'), h.indexOf('bs-filter'));
  const completed = Number((strip.match(/(\d+) completed shift/) || [])[1]);
  const all = db.prepare("SELECT COUNT(*) n FROM shifts WHERE date LIKE ?").get(back(0).slice(0, 7) + '%').n;
  assert.ok(completed > 0, 'something is counted');
  assert.ok(completed < all, `${completed} counted out of ${all} — the empty ones are excluded`);
});

test('months are grouped, newest expanded, the rest one line', async () => {
  const h = await html('/shifts');
  assert.match(h, /class="bs-month"/, 'the newest month is a ledger');
  const heads = [...h.matchAll(/bs-kicker">([A-Z][a-z]+ \d{4})</g)].map((m) => m[1]);
  assert.ok(heads.length >= 1, `grouped by month, got ${heads.join(', ')}`);
});

test('every shift in range is reachable from the ledger', async () => {
  const h = await html('/shifts');
  const ids = db.prepare("SELECT id FROM shifts WHERE date >= ?").all(back(30)).map((r) => r.id);
  for (const id of ids) {
    assert.ok(h.includes(`href="/shifts/${id}"`), `shift ${id} has a link`);
  }
});

test('the filters and the search survive the redesign', async () => {
  const h = await html('/shifts');
  for (const f of ['cafe', 'dinner', 'open', 'review', 'ready', 'sent']) {
    assert.ok(h.includes(`data-v="${f}"`), `the ${f} filter is present`);
  }
  assert.match(h, /id="ssearch"/, 'and the search box');
  assert.match(h, /data-search=/, 'with something to search against');
});

// --- the sheet ------------------------------------------------------------------

test('everyone on the shift is in the table', async () => {
  const { sent } = module.exports;
  const h = await html(`/shifts/${sent}`);
  // Scoped to the table. Asserting the name appears anywhere on the page is
  // no assertion at all — the tip-pool list names the same people, so
  // deleting every support row from the table still passed.
  const table = h.slice(h.indexOf('bs-srows'), h.indexOf('bs-sheet-note'));
  assert.match(table, /class="bs-sr-n">Sandra Moyer</, 'the server has a row');
  assert.match(table, /class="bs-sr-n">Kevin Korah</, 'and so does the kitchen');
  const rows = (table.match(/class="bs-sr[ "]/g) || []).length;
  const onShift = db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id = ?').get(sent).n;
  assert.strictEqual(rows, onShift, `one row each for ${onShift} people, got ${rows}`);
});

test('the sheet keeps every form the workspace had', async () => {
  const { sent } = module.exports;
  const h = await html(`/shifts/${sent}`);
  // Moving a control is fine. Losing one is not — each of these is the only
  // route to something the app can do.
  const endpoints = [
    [`/shifts/${sent}/server`, 'add or edit a server'],
    [`/shifts/${sent}/support`, 'add or edit support'],
    [`/shifts/${sent}/pool`, 'record what you counted'],
    [`/shifts/${sent}/read-report`, 'read a report photo'],
    [`/shifts/${sent}/delete`, 'delete the shift'],
  ];
  for (const [action, what] of endpoints) {
    assert.ok(h.includes(`action="${action}"`), `${what} is still reachable`);
  }
  assert.match(h, new RegExp(`href="/shifts/${sent}/results"`), 'and preview & send');
  // In the ROW, not merely somewhere on the page — the function's own
  // definition contains its name, so a page with no Edit buttons still had it.
  const table = h.slice(h.indexOf('bs-srows'), h.indexOf('bs-sheet-note'));
  const edits = (table.match(/onclick="startEdit\(/g) || []).length;
  const onShift = db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id = ?').get(sent).n;
  assert.strictEqual(edits, onShift, `every row can be edited, got ${edits} of ${onShift}`);
});

test('the shared pool shows what it holds and who it splits to', async () => {
  const { ready } = module.exports;
  const w = new Database(DB);
  w.prepare('UPDATE shifts SET pool_jar_cents = 4000, pool_togo_card_cents = 6000 WHERE id = ?').run(ready);
  w.close();
  const h = await html(`/shifts/${ready}`);
  assert.match(h, /Shared tip pool/);
  assert.match(h, /Cash pool[\s\S]{0,120}\$40\.00/);
  assert.match(h, /To-go card[\s\S]{0,160}\$60\.00/);
  assert.match(h, /Split by hours/i, 'and how it divides');
  // The rule that makes the pool make sense.
  assert.match(h, /not kept by whoever reported them/);
});

test('a person with no hours is flagged on their own row', async () => {
  const { review } = module.exports;
  const h = await html(`/shifts/${review}`);
  assert.match(h, /bs-sr-f miss/, 'the missing hours are marked on the row');
  assert.match(h, /missing/, 'and named');
});

test('a sent shift is still fully editable', async () => {
  const { sent } = module.exports;
  const h = await html(`/shifts/${sent}`);
  // status = emailed locks nothing. Every edit, delete and re-send works
  // after emailing, and the page must not pretend otherwise.
  assert.ok(h.includes(`action="/shifts/${sent}/server"`), 'still editable');
  assert.ok(h.includes(`action="/shifts/${sent}/delete"`), 'still deletable');
  assert.match(h, /Emails sent/i, 'while saying it has gone out');
});
