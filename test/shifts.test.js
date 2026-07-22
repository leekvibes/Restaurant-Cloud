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

  // Every row edits in place, and posts to the endpoint for what that person
  // is. Asserted in the TABLE, not merely somewhere on the page.
  const table = h.slice(h.indexOf('bs-srows'), h.indexOf('bs-sheet-note'));
  const onShift = db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id = ?').get(sent).n;
  const forms = (table.match(/class="bs-inline" method="post"/g) || []).length;
  assert.strictEqual(forms, onShift, `one editor per person, got ${forms} of ${onShift}`);
  assert.ok(table.includes(`action="/shifts/${sent}/server"`), 'the server edits as a server');
  assert.ok(table.includes(`action="/shifts/${sent}/support"`), 'and support as support');
  // Each row carries ITS OWN person. Counting the fields is not enough —
  // hardcoding every one to the same id gives the same count and silently
  // posts every edit onto one employee.
  // Per row, matched against the name in that row. Comparing the set of ids
  // across the whole table is not enough: the first seeded employee is id 1,
  // so hardcoding every form to 1 produced the same set and passed.
  const byName = new Map(db.prepare(
    'SELECT e.id, e.name FROM work w JOIN employees e ON e.id = w.employee_id WHERE w.shift_id = ?')
    .all(sent).map((r) => [r.name, r.id]));
  const rows = table.split('<details class="bs-srow"').slice(1);
  assert.strictEqual(rows.length, onShift, `${onShift} rows`);
  for (const r of rows) {
    const name = (r.match(/class="bs-sr-n">([^<]+)</) || [])[1];
    const id = Number((r.match(/name="employee_id" value="(\d+)"/) || [])[1]);
    assert.ok(name && byName.has(name), `the row names somebody real: ${name}`);
    assert.strictEqual(id, byName.get(name), `${name}'s editor posts ${name}'s id, not ${id}`);
  }
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


test('the money fields are typed, not stepped', async () => {
  const { sent } = module.exports;
  const h = await html(`/shifts/${sent}`);
  const table = h.slice(h.indexOf('bs-srows'), h.indexOf('bs-sheet-note'));
  // A number input's spinner arrows are a pixel-hunt on a laptop and useless
  // on a phone, and every value here is money or hours typed in full.
  assert.ok(!/class="bs-inline"[\s\S]*?type="number"/.test(table), 'no spinner inputs');
  assert.match(table, /inputmode="decimal"/, 'but a numeric keypad on a phone');
});

test('kitchen and coffee are broken out per person', async () => {
  const { sent, people } = module.exports;
  const h = await html(`/shifts/${sent}`);
  const head = h.slice(h.indexOf('bs-shead'), h.indexOf('bs-srows'));
  assert.match(head, /Kitchen/, 'kitchen has its own column');
  assert.match(head, /Coffee/, 'and so does coffee');

  // The seed gives Sandra food only. Both figures must come from her own row,
  // not from a combined total.
  const w = new Database(DB);
  w.prepare('UPDATE server_sales SET food_cents = 80000, coffee_cents = 40000 WHERE shift_id = ? AND employee_id = ?')
    .run(sent, people.sandra);
  w.close();
  const h2 = await html(`/shifts/${sent}`);
  // Inside the table. Her name also appears in the tip-pool list, and slicing
  // from the first match reads the wrong part of the page entirely.
  const t2 = h2.slice(h2.indexOf('bs-srows'), h2.indexOf('bs-sheet-note'));
  const start = t2.indexOf('Sandra Moyer');
  assert.ok(start > -1, 'she has a row');
  const row = t2.slice(start, t2.indexOf('</summary>', start));
  assert.match(row, /\$800\.00/, `kitchen shows on its own: ${row.replace(/<[^>]+>/g, ' ').trim()}`);
  assert.match(row, /\$400\.00/, 'and coffee separately');
  assert.ok(!/\$1,200\.00/.test(row), 'not lumped into one total');
});

test('a column nobody uses does not draw', async () => {
  const { sent } = module.exports;
  // Alcohol is $0 on every service. A permanently empty column teaches you to
  // stop reading the row.
  const h = await html(`/shifts/${sent}`);
  const head = h.slice(h.indexOf('bs-shead'), h.indexOf('bs-srows'));
  assert.ok(!/Alcohol/.test(head), 'no alcohol column while nobody rings any');

  const w = new Database(DB);
  w.prepare('UPDATE server_sales SET alcohol_cents = 5000 WHERE shift_id = ?').run(sent);
  w.close();
  try {
    const h2 = await html(`/shifts/${sent}`);
    const head2 = h2.slice(h2.indexOf('bs-shead'), h2.indexOf('bs-srows'));
    assert.match(head2, /Alcohol/, 'and it appears the moment somebody does');
  } finally {
    const w2 = new Database(DB);
    w2.prepare('UPDATE server_sales SET alcohol_cents = 0 WHERE shift_id = ?').run(sent);
    w2.close();
  }
});

test('the ledger groups days into weeks and totals each one', async () => {
  // Spread across three calendar weeks, or one block satisfies "it groups"
  // and the grouping is never actually exercised.
  const w = new Database(DB);
  const made = [9, 16, 23].map((d) => w.prepare(
    "INSERT INTO shifts (date, daypart, status, total_food_cents) VALUES (?, 'cafe', 'emailed', 50000)")
    .run(back(d)).lastInsertRowid);
  w.close();
  try {
    const h = await html('/shifts');
    // Counted WITHIN the newest month. Across the page, one block per month
    // already reaches three, so a version that never split a month passed.
    // From the first month to the second. This used to slice to
    // 'bs-month bs-month-old', a class that no longer exists — indexOf returned
    // -1, the slice ran to the end of the document, and it counted the week
    // blocks of every month on the page.
    const a = h.indexOf('class="bs-month"');
    const b = h.indexOf('class="bs-month"', a + 1);
    const first = h.slice(a, b === -1 ? undefined : b);
    const blocks = (first.match(/class="bs-week"/g) || []).length;

    const monday = (d) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
    const month = new Date().toISOString().slice(0, 7);
    // Every shift in that month. A month renders all of its days now — there
    // is no "earlier days" fold inside one any more.
    const shown = db.prepare("SELECT date FROM shifts WHERE date LIKE ?").all(month + '%');
    const want = new Set(shown.map((r) => monday(r.date))).size;
    assert.strictEqual(blocks, want, `${want} distinct weeks in view, got ${blocks} blocks`);
    assert.strictEqual((first.match(/week of [A-Z][a-z]{2} \d+/g) || []).length, blocks,
      'and each one says which week it is');
    // The subtotal is the point — "how did last week do" had no answer before.
    const wk = h.slice(h.indexOf('bs-week-f'), h.indexOf('bs-week-f') + 300);
    assert.match(wk, /\$[\d,]+\.\d{2}/, 'with its own total');
  } finally {
    const w2 = new Database(DB);
    for (const id of made) w2.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    w2.close();
  }
});

test('every month starts closed, and opening one shows all of its days', async () => {
  const h = await html('/shifts');

  // You arrive looking for a stretch of days, so the page opens as a list of
  // months you can take in at once and you go into the one you want.
  const months = h.match(/<details class="bs-month" data-month[^>]*>/g) || [];
  assert.ok(months.length >= 1, 'months are rendered');
  assert.ok(months.every((m) => !/\bopen\b/.test(m)), `none opens by default: ${months.join(' ')}`);

  // And every one is the same control — the newest used to be a plain section
  // with no way to shut it while the rest were disclosures with "open ▸".
  assert.strictEqual((h.match(/bs-month-go/g) || []).length, months.length,
    'each carries the same affordance');
  assert.ok(!h.includes('bs-month-old'), 'there is one code path, not two');

  // An open month shows everything in it. The inner "N earlier days" fold was
  // a second click to reach what the first one asked for.
  assert.ok(!/earlier day/.test(h), 'no fold inside a month');
});
