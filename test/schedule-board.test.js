'use strict';

// ===========================================================================
// Scheduler — the manager's week board.
//
// The domain is tested in scheduler.test.js. This file is about the PAGE: that
// the week it shows is the week payroll measures, that a bad querystring
// cannot break it, that the frame it draws is the shared one, and above all
// that opening it writes nothing. A planning screen that touches a punch is
// a planning screen that has changed somebody's pay.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3995;                     // unique across the suite — boot.test.js guards this
const BASE = `http://127.0.0.1:${PORT}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sb-'));
const DB = path.join(dir, 'sb.db');
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
let child; let Database; let db; let SCH; let TC; let P; let dates;

const text = async (p, headers = {}) => (await fetch(BASE + p, { headers })).text();
const status = async (p, headers = {}) => (await fetch(BASE + p, { headers, redirect: 'manual' })).status;

const E = { server: 201, barista: 202, gone: 203 };

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new Database(DB);
  const ins = db.prepare(
    'INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,?,?,?,?)');
  ins.run(E.server, 'Board Server', 'server', '5201', 1500, 1);
  ins.run(E.barista, 'Board Barista', 'barista', '5202', 1400, 1);
  ins.run(E.gone, 'Board Departed', 'server', '5203', 1500, 0);

  SCH = require('../src/scheduler');
  TC = require('../src/timeclock');
  P = require('../src/periods');
  dates = require('../src/dates');
});

test.after(() => {
  if (child) child.kill();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const today = () => TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);

/** Every table the board must never write to. */
const footprint = () => ({
  time_entries: db.prepare('SELECT COUNT(*) n FROM time_entries').get().n,
  time_breaks: db.prepare('SELECT COUNT(*) n FROM time_breaks').get().n,
  work: db.prepare('SELECT COUNT(*) n FROM work').get().n,
  shifts: db.prepare('SELECT COUNT(*) n FROM shifts').get().n,
  server_sales: db.prepare('SELECT COUNT(*) n FROM server_sales').get().n,
  tip_submissions: db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n,
  published: db.prepare('SELECT COUNT(*) n FROM published_schedule').get().n,
});

// ===========================================================================

test('the board opens, and says it is a plan rather than a record', async () => {
  const html = await text('/schedule');
  assert.match(html, /<h1>Schedule<\/h1>/);
  assert.match(html, /writes no hours and changes no pay/i,
    'the page states what it is, where somebody would otherwise assume');
});

test('Q6: the draft banner is on the page, not a message that fades', async () => {
  const html = await text('/schedule');
  assert.match(html, /class="swb-draft"/, 'the banner is part of the page');
  assert.match(html, /Draft schedule/);
  assert.match(html, /Not visible to employees/);
  assert.doesNotMatch(html, /class="swb-draft"[^>]*data-dismiss/, 'and cannot be dismissed');
});

test('Q1: the week shown is the pay period\'s workweek, not a calendar Monday', async () => {
  const html = await text('/schedule');
  const start = (html.match(/\/schedule\?w=(\d{4}-\d{2}-\d{2})/) || [])[1];
  assert.ok(start, 'the page links to another week');

  // Whatever week is on screen, its start must be a whole number of weeks from
  // the pay-period anchor — the same split reports.js uses for overtime.
  const wk = SCH.weekWindowFor(today());
  const per = P.periodFor(wk.start);
  const off = Math.round(
    (Date.parse(`${wk.start}T00:00:00Z`) - Date.parse(`${per.start}T00:00:00Z`)) / 86400000,
  );
  assert.strictEqual(off % 7, 0, 'the board week is aligned to the pay period');

  // Seven columns, and the header names the first and last day of THAT window.
  const cols = (html.match(/--egrid-cols:(\d+)/) || [])[1];
  assert.strictEqual(Number(cols), 7, 'a week is seven columns');
  assert.ok(html.includes(TC.dayLabel(wk.start)) && html.includes(TC.dayLabel(wk.end)),
    `the range reads ${TC.dayLabel(wk.start)} – ${TC.dayLabel(wk.end)}`);
});

test('prev and next move exactly one week, and stay period-aligned', async () => {
  const wk = SCH.weekWindowFor(today());
  const html = await text('/schedule');
  assert.ok(html.includes(`/schedule?w=${dates.addDays(wk.start, -7)}`), 'back one week');
  assert.ok(html.includes(`/schedule?w=${dates.addDays(wk.start, 7)}`), 'forward one week');

  const next = await text(`/schedule?w=${dates.addDays(wk.start, 7)}`);
  const nw = SCH.weekWindowFor(dates.addDays(wk.start, 7));
  assert.ok(next.includes(TC.dayLabel(nw.start)), 'and the next page shows that week');
});

test('a junk or far-off week falls back rather than showing an empty decade', async () => {
  const wk = SCH.weekWindowFor(today());
  for (const bad of ['banana', '2026-13-45', '0001-01-01', '9999-12-31', '']) {
    const html = await text(`/schedule?w=${encodeURIComponent(bad)}`);
    assert.ok(html.includes(TC.dayLabel(wk.start)),
      `?w=${bad || '(empty)'} falls back to this week instead of stranding the board`);
  }
});

test('a planned shift shows as a card, with its time and its position', async () => {
  const wk = SCH.weekWindowFor(today());
  SCH.create({
    employeeId: E.server, position: 'server',
    startsAt: `${wk.start} 16:00`, endsAt: `${wk.start} 22:00`,
  });
  const html = await text('/schedule');
  assert.match(html, /class="swb-card"/, 'the shift is on the board');
  assert.match(html, /4p–10p/, 'compact enough that seven days fit across');
  assert.match(html, /Board Server/, 'on the right person\'s row');
});

test('Q3: the week total is PAID hours — an unpaid break comes off it', async () => {
  const wk = SCH.weekWindowFor(today());
  const day = dates.addDays(wk.start, 3);
  SCH.create({
    employeeId: E.barista, position: 'barista',
    startsAt: `${day} 09:00`, endsAt: `${day} 17:00`, breaks: [{ minutes: 30 }],
  });
  const html = await text('/schedule');
  const row = (html.match(/Board Barista[\s\S]*?class="swb-tot egrid-tail"><b>([\d.]+)</) || [])[1];
  assert.strictEqual(Number(row), 7.5,
    'eight hours on the clock face, seven and a half paid — the board shows what it costs');
});

test('somebody who left is still shown while they have a shift on the board', async () => {
  const wk = SCH.weekWindowFor(today());
  // Placed while active, then deactivated — the plan outlives the roster change
  // and must stay findable, or nobody can cancel it.
  db.prepare('UPDATE employees SET active = 1 WHERE id = ?').run(E.gone);
  SCH.create({ employeeId: E.gone, position: 'server',
    startsAt: `${dates.addDays(wk.start, 2)} 10:00`, endsAt: `${dates.addDays(wk.start, 2)} 14:00` });
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(E.gone);

  const html = await text('/schedule');
  assert.match(html, /Board Departed/, 'the row is still there');
  assert.match(html, /Board Departed[\s\S]{0,200}· left/, 'and says why it looks unusual');
});

test('the board composes the shared grid frame rather than its own', async () => {
  const html = await text('/schedule');
  assert.match(html, /class="swb-scroll egrid-scroll"/, 'the scroll container is the shared one');
  assert.match(html, /class="swb egrid"/, 'and so is the grid');
  assert.match(html, /class="swb-emp egrid-lead"/, 'the name column is frozen by the primitive');
  assert.match(html, /class="swb-tot egrid-tail"/, 'and so is the week total');
  assert.match(html, /class="swb-c egrid-c/, 'the cells take the shared padding');
});

test('today is marked on the board, by BUSINESS date', async () => {
  const html = await text('/schedule');
  const marked = html.match(/class="swb-dh egrid-dh swb-today"[\s\S]{0,120}?<b>(\d+)<\/b>/);
  assert.ok(marked, 'one column is marked as today');
  assert.strictEqual(Number(marked[1]), Number(today().slice(8)),
    'and it is the business date, not the calendar one — at 1am they differ');
  assert.strictEqual((html.match(/swb-today/g) || []).length, 1, 'exactly one day is today');
});

// ===========================================================================
// The invariant, at the route
// ===========================================================================

test('opening the board writes nothing to time, work, payroll or the published schedule', async () => {
  const before = footprint();
  await text('/schedule');
  await text(`/schedule?w=${dates.addDays(SCH.weekWindowFor(today()).start, 7)}`);
  await text('/schedule?w=nonsense');
  assert.deepStrictEqual(footprint(), before,
    'reading a plan is reading, and publishes nothing to the floor either');
});

test('the board is a GET-only surface in this phase', async () => {
  // No write route exists yet. If one appears without a test, this catches it.
  const res = await fetch(`${BASE}/schedule`, { method: 'POST', redirect: 'manual' });
  assert.ok(res.status === 404 || res.status === 405,
    `POST /schedule is not a route yet (got ${res.status})`);
});

test('Schedule is its own access area, so it is not opened by an unrelated grant', async () => {
  const { areaFor } = require('../src/nav');
  assert.strictEqual(areaFor('/schedule'), 'schedule',
    'the page belongs to an area of its own');
  assert.notStrictEqual(areaFor('/schedule'), areaFor('/shifts'),
    'and not to Services, which many accounts already have');
  assert.strictEqual(await status('/schedule'), 200, 'the owner can open it');
});
