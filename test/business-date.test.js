'use strict';

// Which "today" a page means.
//
// ZWIN carries two, and they disagree for four hours a night:
//
//   the CALENDAR date   right for paperwork — an invoice, an expense, a
//                       recurring task, the month a row groups under
//   the BUSINESS date   right for anything about a service — which shift is
//                       running, who still owes a floor report, whether the pay
//                       period has finished. Rolls at the 4am cutoff, because a
//                       Friday night does not end at midnight
//
// Five pages asked the calendar and meant the service, so between midnight and
// 4am they were quietly looking at TOMORROW — exactly the hour a manager is
// closing out and reading them.
//
// TESTING A BUG THAT ONLY EXISTS AT 1AM
//
// A test written at noon passes against the broken code, which is how this
// survived. Rather than move the clock, these move the CUTOFF: written straight
// into settings as 24, every hour of the day is "before the cutoff", so the
// business date is always the previous calendar day and the gap is reproducible
// at 3pm. businessDateOf compares local.getHours() < cutoffHour, and hours only
// reach 23 — so 24 makes the divergence permanent while the test runs.
//
// Each assertion is written against businessDateOf's own answer rather than a
// hardcoded date, so a run that straddles midnight cannot go red on its own.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4001;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-bizdate-'));
const DB = path.join(dir, 'test.db');

let child; let db; let Database; let TC; let dates;

const text = async (p) => (await fetch(BASE + p)).text();

// The cutoff the app is running under while a test body executes.
const setCutoff = (h) => db.prepare(
  "INSERT INTO settings (key, value) VALUES ('tc_day_cutoff', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(String(h));

const calendarToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const businessToday = () => TC.businessDateOf(TC.nowUtc(), Number(
  db.prepare("SELECT value FROM settings WHERE key = 'tc_day_cutoff'").get().value));

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new Database(DB);
  TC = require('../src/timeclock');
  dates = require('../src/dates');
});

test.after(() => {
  if (child) child.kill();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test.afterEach(() => { setCutoff(4); });

test('the cutoff trick actually produces the midnight gap', () => {
  // If this fails everything below is meaningless — it would be asserting
  // against two dates that happen to agree.
  setCutoff(24);
  assert.notStrictEqual(businessToday(), calendarToday(),
    'with a cutoff of 24 the business date must be the previous calendar day');
  assert.strictEqual(businessToday(), dates.addDays(calendarToday(), -1));
  setCutoff(4);
});

test('Services calls tonight\'s shift Open, not finished', async () => {
  setCutoff(24);
  const biz = businessToday();
  // A service on the floor right now, dated the way the clock dates it.
  const id = db.prepare("INSERT INTO shifts (date, daypart, status, created_at) VALUES (?, 'dinner', 'open', datetime('now'))")
    .run(biz).lastInsertRowid;
  try {
    const html = await text('/shifts');
    // shiftState labels a service Open only when its date === today, and the
    // row prints it as "<service> · <status>" lowercased. On the calendar date
    // this fell through to "ready to send" — the page telling a manager the
    // night was over while people were still working it.
    assert.match(html, /Dinner · open/, 'the running service reads as open');
    assert.doesNotMatch(html, /Dinner · ready to send/, 'and not as finished');
  } finally {
    db.prepare('DELETE FROM shifts WHERE id = ?').run(id);
  }
});

test('the admin Portal finds tonight\'s shift, and who still owes a report', async () => {
  setCutoff(24);
  const biz = businessToday();
  const sid = db.prepare("INSERT INTO shifts (date, daypart, status, created_at) VALUES (?, 'dinner', 'open', datetime('now'))")
    .run(biz).lastInsertRowid;
  const eid = db.prepare("INSERT INTO employees (name, role, pin, hourly_rate_cents, active) VALUES ('Late Server','server','7311',1500,1)")
    .run().lastInsertRowid;
  db.prepare("INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?, 'server', 6)").run(sid, eid);
  try {
    const html = await text('/staff-portal');
    // The defect this sweep started from: no open shift found means the whole
    // "who has handed in tonight" block renders as nobody — silently, and only
    // between midnight and the cutoff.
    assert.match(html, /Late Server/,
      'the person on tonight\'s floor is listed as still owing');
  } finally {
    db.prepare('DELETE FROM work WHERE shift_id = ?').run(sid);
    db.prepare('DELETE FROM shifts WHERE id = ?').run(sid);
    db.prepare('DELETE FROM employees WHERE id = ?').run(eid);
  }
});

test('a cash count is filed under the service it belongs to', async () => {
  setCutoff(24);
  const biz = businessToday();
  const html = await text('/cash/new');
  // The date the form arrives pre-filled with is the date the count gets
  // stamped with. On the calendar date, counting the drawer at 1am filed it
  // under tomorrow — and found no shift to read the daypart from.
  assert.match(html, new RegExp(`value="${biz}"`),
    'the new count defaults to tonight, not to tomorrow');
  assert.doesNotMatch(html, new RegExp(`value="${calendarToday()}"[^>]*name="date"|name="date"[^>]*value="${calendarToday()}"`),
    'and never to the calendar date');
});

test('Payroll does not call a period finished while it is still running', async () => {
  setCutoff(24);
  const biz = businessToday();
  // The range has to reach past tonight for the two dates to disagree about it:
  // the calendar date is already tomorrow, so `to > today` went false and the
  // page announced the period was over. The business date is tonight, so it is
  // still running — which it is.
  const from = dates.addDays(biz, -12);
  const to = dates.addDays(biz, 1);
  // And it needs hours in the range, or the verdict short-circuits to
  // "nothing logged" before it ever asks whether the period has finished.
  const sid = db.prepare("INSERT INTO shifts (date, daypart, status, created_at) VALUES (?, 'dinner', 'open', datetime('now'))")
    .run(biz).lastInsertRowid;
  const eid = db.prepare("INSERT INTO employees (name, role, pin, hourly_rate_cents, active) VALUES ('Period Worker','server','7313',1500,1)")
    .run().lastInsertRowid;
  db.prepare("INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?, 'server', 6)").run(sid, eid);
  try {
    const html = await text(`/payroll?from=${from}&to=${to}`);
    assert.match(html, /still running/,
      'the period reads as still running while tonight is still being worked');
  } finally {
    db.prepare('DELETE FROM work WHERE shift_id = ?').run(sid);
    db.prepare('DELETE FROM shifts WHERE id = ?').run(sid);
    db.prepare('DELETE FROM employees WHERE id = ?').run(eid);
  }
});

test('the specials board is dated tonight for the staff reading it', async () => {
  setCutoff(24);
  // Only the printed date, but a server reading the board at 1am should see
  // tonight on it.
  const biz = businessToday();
  const cookie = await (async () => {
    const eid = db.prepare("INSERT INTO employees (name, role, pin, hourly_rate_cents, active) VALUES ('Board Reader','server','7312',1500,1)")
      .run().lastInsertRowid;
    const r = await fetch(`${BASE}/tips/start`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin: '7312' }),
    });
    assert.strictEqual(r.status, 302, 'the PIN is accepted');
    const c = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.match(c, /^zwin_portal=/, 'and comes back signed in');
    return { cookie: c, eid };
  })();
  try {
    const r = await fetch(`${BASE}/portal/specials`, { headers: { cookie: cookie.cookie } });
    const html = await r.text();
    // niceDate is { month: 'short', day: 'numeric' }, printed uppercased.
    const nice = (d) => new Date(`${d}T00:00:00`)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    assert.ok(html.includes(nice(biz)),
      `the board is dated ${nice(biz)}, the service the reader is standing in`);
    assert.ok(!html.includes(nice(calendarToday())),
      `and not ${nice(calendarToday())}, which has not started yet`);
  } finally {
    db.prepare('DELETE FROM employees WHERE id = ?').run(cookie.eid);
  }
});

test('paperwork pages still use the CALENDAR date, deliberately', async () => {
  setCutoff(24);
  // The other half of the sweep. An invoice, an expense and a recurring task
  // are dated by the calendar — a bill received after midnight belongs to the
  // new day. Changing these would have been the same mistake in reverse.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const at = (marker) => {
    const i = src.indexOf(marker);
    assert.ok(i > -1, `found ${marker}`);
    return src.slice(i, i + 900);
  };
  for (const [route, marker] of [
    ['invoices', "app.get('/c/invoices'"],
    ['expenses', "app.get('/c/expenses'"],
    ['recurring', "app.get('/c/recurring'"],
  ]) {
    assert.match(at(marker), /const today = isoDate\(startOfToday\(\)\)/,
      `${route} groups by calendar month and stays on the calendar date`);
  }
});
