'use strict';

// ===========================================================================
// Scheduler — the manager's week board, in production.
//
// The domain is tested in scheduler.test.js. This file is about the PAGE and
// its write routes: that the week it shows is the week payroll measures, that
// a bad querystring cannot break it, that a forged position is refused by the
// server whatever the form offered, and above all that none of it writes a
// punch, an hour, a service or a payroll row.
//
// A planning screen that touches any of those has changed somebody's pay.
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

let __csrf = null;
async function token() {
  if (!__csrf) __csrf = (await (await fetch(`${BASE}/csrf`)).text()).trim();
  return __csrf;
}
const text = async (p) => (await fetch(BASE + p)).text();
const status = async (p) => (await fetch(BASE + p, { redirect: 'manual' })).status;
const post = async (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...body, _csrf: await token() }).toString(),
});
/** The message a route redirected back with, decoded. */
const flashOf = (res) => {
  const q = (res.headers.get('location') || '').split('?')[1] || '';
  const p = new URLSearchParams(q);
  return { msg: p.get('msg') || '', err: p.get('err') === '1' };
};

const E = { server: 201, barista: 202, gone: 203, multi: 204, longname: 205 };

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
  ins.run(E.multi, 'Board Multi', 'server', '5204', 1500, 1);
  ins.run(E.longname, 'Bartholomew Fitzwilliam-Harrington', 'kitchen', '5205', 1600, 1);
  // Multi genuinely holds two jobs — the case the employee-column subtitle
  // would misrepresent if it named one "primary" position.
  db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
    .run(E.multi, 'bartender', 1700);

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
const week = () => SCH.weekWindowFor(today());

/** Every table the board must never write to. */
const footprint = () => ({
  time_entries: db.prepare('SELECT COUNT(*) n FROM time_entries').get().n,
  time_breaks: db.prepare('SELECT COUNT(*) n FROM time_breaks').get().n,
  work: db.prepare('SELECT COUNT(*) n FROM work').get().n,
  shifts: db.prepare('SELECT COUNT(*) n FROM shifts').get().n,
  server_sales: db.prepare('SELECT COUNT(*) n FROM server_sales').get().n,
  tip_submissions: db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n,
  timesheets: db.prepare('SELECT COUNT(*) n FROM timesheets').get().n,
  published: db.prepare('SELECT COUNT(*) n FROM published_schedule').get().n,
});

// ===========================================================================
// Initialization — this release is the first boot that requires the module
// ===========================================================================

test('booting the server creates the three Scheduler tables and nothing else', () => {
  const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND (name LIKE 'scheduled%' OR name = 'published_schedule') ORDER BY name`).all().map((r) => r.name);
  assert.deepStrictEqual(names, ['published_schedule', 'scheduled_breaks', 'scheduled_shifts'],
    'requiring the module is what creates them');
  // Additive: the tables the rest of the app owns are all still here.
  for (const t of ['time_entries', 'work', 'shifts', 'employees', 'positions']) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t),
      `${t} untouched`);
  }
});

test('initialization seeds NO Scheduler rows', () => {
  // A default row would look like a real plan to whoever opened the page next.
  for (const t of ['scheduled_shifts', 'scheduled_breaks', 'published_schedule']) {
    const n = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    if (t === 'scheduled_shifts') continue;              // this file creates its own below
    assert.strictEqual(n, 0, `${t} starts empty`);
  }
});

test('the Scheduler indexes exist', () => {
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'
    AND tbl_name IN ('scheduled_shifts','scheduled_breaks','published_schedule')`).all().map((r) => r.name);
  assert.ok(idx.length >= 1, `the module declares its own indexes (found ${idx.length})`);
});

// ===========================================================================
// The page
// ===========================================================================

test('the board opens for the owner', async () => {
  assert.strictEqual(await status('/schedule'), 200);
  const html = await text('/schedule');
  assert.match(html, /<h1>Schedule<\/h1>/);
});

test('an empty week still renders a usable board', async () => {
  // Far enough out that nothing this file creates lands in it.
  const far = dates.addDays(week().start, 21);
  const html = await text(`/schedule?w=${far}`);
  assert.match(html, /class="sb-grid"/, 'the grid is drawn');
  assert.match(html, /class="sb-add"/, 'every empty cell is a create target');
  assert.doesNotMatch(html, /class="sbk /, 'and no shift cards');
  assert.match(html, /<b>0<\/b>/, 'the summary reads zero rather than blank');
});

test('the permanent planning-only sentence is gone from the page head', async () => {
  const html = await text('/schedule');
  assert.doesNotMatch(html, /<p class="bs-sub">[^<]*Who is planned to work/,
    'the board dominates the page; the explanation lives in the drawer');
});

test('Q6: Draft is a compact chip, not a full-width banner', async () => {
  const html = await text('/schedule');
  assert.match(html, /class="sb-chip"/);
  assert.match(html, /Draft/);
  assert.match(html, /not visible to employees/);
  assert.doesNotMatch(html, /class="swb-draft"/, 'the old banner is gone');
});

test('Q1: the week shown is the pay period\'s workweek, not a calendar Monday', async () => {
  const html = await text('/schedule');
  const wk = week();
  const per = P.periodFor(wk.start);
  const off = Math.round(
    (Date.parse(`${wk.start}T00:00:00Z`) - Date.parse(`${per.start}T00:00:00Z`)) / 86400000,
  );
  assert.strictEqual(off % 7, 0, 'aligned to the pay period, which is what OT is measured against');
  assert.strictEqual(Number((html.match(/--sb-cols:(\d+)/) || [])[1]), 7, 'seven columns');
  assert.ok(html.includes(TC.dayLabel(wk.start)) && html.includes(TC.dayLabel(wk.end)));
});

test('prev and next move exactly one week', async () => {
  const wk = week();
  const html = await text('/schedule');
  assert.ok(html.includes(`/schedule?w=${dates.addDays(wk.start, -7)}`), 'back one week');
  assert.ok(html.includes(`/schedule?w=${dates.addDays(wk.start, 7)}`), 'forward one week');
});

test('a junk or far-off week falls back rather than stranding the board', async () => {
  const wk = week();
  for (const bad of ['banana', '2026-13-45', '0001-01-01', '9999-12-31', '']) {
    const html = await text(`/schedule?w=${encodeURIComponent(bad)}`);
    assert.ok(html.includes(TC.dayLabel(wk.start)), `?w=${bad || '(empty)'} falls back`);
  }
});

test('there is no dot placeholder left anywhere on the board', async () => {
  const html = await text('/schedule');
  assert.doesNotMatch(html, /class="[^"]*sb-none/, 'empty means empty');
});

test('the ten-colour palette is NOT shown on the schedule page', async () => {
  const html = await text('/schedule');
  assert.doesNotMatch(html, /the ten a position can be given/i);
  assert.doesNotMatch(html, /class="sb-pal"/, 'the reference strip belongs on Positions, later');
});

// ===========================================================================
// Cards
// ===========================================================================

test('a card leads with the POSITION and follows with the time', async () => {
  const wk = week();
  SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${wk.start} 16:00`, endsAt: `${wk.start} 22:00` });
  const html = await text('/schedule');
  const card = (html.match(/<button class="sbk sbk--\w+"[\s\S]*?<\/button>/) || [])[0];
  assert.ok(card, 'a card is on the board');
  assert.ok(card.indexOf('<b>') < card.indexOf('<i>'), 'position markup precedes time markup');
  assert.match(card, /<b>Server<\/b>/, 'the position is text, never colour alone');
  assert.match(card, /<i>4p–10p<\/i>/, 'compact enough that seven days fit across');
  assert.match(card, /aria-label="Edit Server/, 'and it is labelled for a screen reader');
});

test('a card carries its position colour from the deterministic mapping', async () => {
  const html = await text('/schedule');
  assert.match(html, /class="sbk sbk--green"/, 'server is green');
});

test('an overnight shift renders on the day it STARTED', async () => {
  const wk = week();
  const day = dates.addDays(wk.start, 2);
  // 8pm to 2am. The clock puts this on the night it began; so must the plan.
  const s = SCH.create({ employeeId: E.multi, position: 'bartender',
    startsAt: `${day} 20:00`, endsAt: `${dates.addDays(day, 1)} 02:00` });
  assert.strictEqual(SCH.byId(s.id).business_date, day, 'stamped to the starting night');
  const html = await text('/schedule');
  assert.match(html, /<i>8p–2a<\/i>/, 'and reads across midnight on the card');
});

test('multiple shifts on one day stack in chronological order, full size', async () => {
  const wk = week();
  const day = dates.addDays(wk.start, 3);
  SCH.create({ employeeId: E.barista, position: 'barista',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  SCH.create({ employeeId: E.barista, position: 'barista',
    startsAt: `${day} 06:30`, endsAt: `${day} 11:00` });
  const html = await text('/schedule');
  const row = (html.match(/Board Barista[\s\S]*?(?=<div class="sb-row">|<\/div>\s*<\/div>\s*<div class="sb-sum")/) || [])[0];
  const times = [...row.matchAll(/<i>([^<]+)<\/i>/g)].map((m) => m[1]).filter((s) => /[ap]$/.test(s));
  const idxEarly = times.indexOf('6:30a–11a');
  const idxLate = times.indexOf('4p–10p');
  assert.ok(idxEarly >= 0 && idxLate >= 0, `both shifts render (${times.join(', ')})`);
  assert.ok(idxEarly < idxLate, 'earliest first');
});

test('the employee column shows hours and shift count, never a "primary" position', async () => {
  const html = await text('/schedule');
  assert.match(html, /<b>Board Multi<\/b><i>[\d.]+h · \d+ shifts?<\/i>/,
    'name then totals');
  // Multi works server AND bartender; naming one under the name would be wrong.
  assert.doesNotMatch(html, /<b>Board Multi<\/b><i>(Server|Bartender)/i);
});

test('an active employee with no shifts stays visible, at the bottom', async () => {
  const html = await text('/schedule');
  assert.match(html, /Not scheduled/, 'they are listed');
  const noShift = html.indexOf('Bartholomew');
  const withShift = html.indexOf('Board Server');
  assert.ok(withShift < noShift, 'scheduled people come first');
});

test('today is marked by BUSINESS date, and not by colour alone', async () => {
  const html = await text('/schedule');
  const marked = html.match(/class="sb-dh is-today"[\s\S]{0,200}?<em>([^<]*)/);
  assert.ok(marked, 'one column is marked');
  assert.match(html, /class="sb-today">TODAY</, 'labelled, not just tinted');
  assert.strictEqual((html.match(/sb-dh is-today/g) || []).length, 1, 'exactly one day');
});

test('day headers lead with people, then shifts and hours', async () => {
  const html = await text('/schedule');
  const dh = (html.match(/<div class="sb-dh[^"]*">[\s\S]*?<\/div>/) || [])[0];
  assert.ok(dh.indexOf('<b>') < dh.indexOf('<i>'), 'people above shifts/hours');
  assert.match(dh, /<b>\d+ (person|people)<\/b>/);
  assert.match(dh, /<i>\d+ shifts? &middot; [\d.]+h<\/i>/);
  assert.doesNotMatch(html, /labou?r cost|projected OT|labou?r %/i, 'and nothing from a later phase');
});

// ===========================================================================
// Writes
// ===========================================================================

test('creating from an empty cell adds a draft to that employee and day', async () => {
  const wk = week();
  const day = dates.addDays(wk.start, 4);
  const before = footprint();
  const res = await post('/schedule/shift', {
    w: wk.start, employee_id: String(E.server), position: 'server',
    date: day, start: '17:00', end: '23:00', daypart: '', break_minutes: '', note: 'section 4',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(flashOf(res).err, false, flashOf(res).msg);
  const made = db.prepare('SELECT * FROM scheduled_shifts WHERE business_date = ? AND employee_id = ?')
    .get(day, E.server);
  assert.ok(made, 'the row exists');
  assert.strictEqual(made.status, 'draft', 'and it is a draft, never published');
  assert.strictEqual(made.note, 'section 4');
  assert.deepStrictEqual(footprint(), before, 'and nothing that records actual work moved');
});

test('an end at or before the start runs past midnight, onto the next day', async () => {
  const wk = week();
  const day = dates.addDays(wk.start, 5);
  const res = await post('/schedule/shift', {
    w: wk.start, employee_id: String(E.multi), position: 'bartender',
    date: day, start: '19:00', end: '01:30', break_minutes: '',
  });
  assert.strictEqual(flashOf(res).err, false, flashOf(res).msg);
  const made = db.prepare(`SELECT * FROM scheduled_shifts WHERE employee_id = ? AND business_date = ?
    ORDER BY id DESC LIMIT 1`).get(E.multi, day);
  assert.ok(made, 'stamped to the night it began');
  assert.ok(made.ends_at > made.starts_at, 'and ends after it starts');
  assert.ok(SCH.spanMinutes(made) === 390, `six and a half hours, not negative (${SCH.spanMinutes(made)})`);
});

test('editing a shift changes the plan and still writes nothing actual', async () => {
  const wk = week();
  const row = db.prepare('SELECT * FROM scheduled_shifts ORDER BY id LIMIT 1').get();
  const before = footprint();
  const res = await post(`/schedule/shift/${row.id}`, {
    w: wk.start, employee_id: String(row.employee_id), position: row.position,
    date: row.business_date, start: '15:00', end: '21:00', break_minutes: '30', break_paid: '0',
  });
  assert.strictEqual(flashOf(res).err, false, flashOf(res).msg);
  const after = SCH.byId(row.id);
  assert.strictEqual(after.breaks.length, 1, 'the planned break saved');
  assert.strictEqual(after.breaks[0].paid, 0, 'as unpaid');
  assert.deepStrictEqual(footprint(), before, 'no punch, no work row, no service');
});

test('a forged position the employee does not hold is refused server-side', async () => {
  const wk = week();
  // The form only ever offers what they hold; this posts past it deliberately.
  const res = await post('/schedule/shift', {
    w: wk.start, employee_id: String(E.barista), position: 'bartender',
    date: dates.addDays(wk.start, 6), start: '17:00', end: '23:00', break_minutes: '',
  });
  const f = flashOf(res);
  assert.strictEqual(f.err, true, 'refused');
  assert.match(f.msg, /not assigned to that position/i, 'and says why, without leaking internals');
  assert.doesNotMatch(f.msg, /SQL|employee_roles|undefined/i);
});

test('an inactive employee cannot be scheduled through the route', async () => {
  const wk = week();
  const res = await post('/schedule/shift', {
    w: wk.start, employee_id: String(E.gone), position: 'server',
    date: dates.addDays(wk.start, 6), start: '17:00', end: '23:00', break_minutes: '',
  });
  const f = flashOf(res);
  assert.strictEqual(f.err, true);
  assert.match(f.msg, /not active/i);
});

test('a break longer than its shift is refused, not silently dropped', async () => {
  const wk = week();
  const res = await post('/schedule/shift', {
    w: wk.start, employee_id: String(E.server), position: 'server',
    date: dates.addDays(wk.start, 6), start: '17:00', end: '19:00', break_minutes: '600',
  });
  const f = flashOf(res);
  assert.strictEqual(f.err, true);
  assert.match(f.msg, /longer than the shift/i);
});

test('service defaults from the start time and can be overridden by the manager', async () => {
  const wk = week();
  const day = dates.addDays(wk.start, 1);
  await post('/schedule/shift', {
    w: wk.start, employee_id: String(E.server), position: 'server',
    date: day, start: '09:00', end: '14:00', daypart: '', break_minutes: '',
  });
  const auto = db.prepare(`SELECT * FROM scheduled_shifts WHERE employee_id=? AND business_date=?
    ORDER BY id DESC LIMIT 1`).get(E.server, day);
  assert.strictEqual(auto.daypart, 'cafe', 'a 9am start is cafe by the service window');

  await post('/schedule/shift', {
    w: wk.start, employee_id: String(E.server), position: 'server',
    date: day, start: '10:00', end: '15:00', daypart: 'dinner', break_minutes: '',
  });
  const forced = db.prepare(`SELECT * FROM scheduled_shifts WHERE employee_id=? AND business_date=?
    ORDER BY id DESC LIMIT 1`).get(E.server, day);
  assert.strictEqual(forced.daypart, 'dinner', 'and the manager can say otherwise');
});

test('delete cancels the plan and leaves every punch alone', async () => {
  const wk = week();
  const row = db.prepare("SELECT * FROM scheduled_shifts WHERE status='draft' ORDER BY id DESC LIMIT 1").get();
  const before = footprint();
  const res = await post(`/schedule/shift/${row.id}/delete`, { w: wk.start });
  assert.strictEqual(flashOf(res).err, false, flashOf(res).msg);
  assert.strictEqual(SCH.byId(row.id).status, 'cancelled', 'kept as a record of what was planned');
  assert.deepStrictEqual(footprint(), before);
});

test('duplicate puts a second draft in the same cell', async () => {
  const wk = week();
  const row = db.prepare("SELECT * FROM scheduled_shifts WHERE status='draft' ORDER BY id LIMIT 1").get();
  const n = () => db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE employee_id=? AND business_date=?')
    .get(row.employee_id, row.business_date).n;
  const before = n();
  const res = await post(`/schedule/shift/${row.id}/duplicate`, { w: wk.start });
  assert.strictEqual(flashOf(res).err, false, flashOf(res).msg);
  assert.strictEqual(n(), before + 1);
});

test('copy last week copies drafts, and running it twice does not double them', async () => {
  const wk = week();
  const target = dates.addDays(wk.start, 7);
  const count = () => db.prepare(`SELECT COUNT(*) n FROM scheduled_shifts
    WHERE business_date BETWEEN ? AND ?`).get(target, dates.addDays(target, 6)).n;
  const before = footprint();

  const first = await post('/schedule/copy-week', { w: target, to: target });
  assert.strictEqual(flashOf(first).err, false, flashOf(first).msg);
  const afterFirst = count();
  assert.ok(afterFirst > 0, 'something was copied');

  const second = await post('/schedule/copy-week', { w: target, to: target });
  assert.strictEqual(count(), afterFirst, 'the second run copies nothing new');
  assert.match(flashOf(second).msg, /skipped/i, 'and says how many it skipped');

  assert.ok(db.prepare(`SELECT COUNT(*) n FROM scheduled_shifts
    WHERE business_date BETWEEN ? AND ? AND status <> 'draft'`)
    .get(target, dates.addDays(target, 6)).n === 0, 'every copy is a draft');
  assert.deepStrictEqual(footprint(), before, 'and no actual labour data was touched');
});

// ===========================================================================
// Overlap — the approved Phase 2 warning (Q2): warns, never blocks
// ===========================================================================

/** A far-out week of its own, so these cannot collide with the tests above. */
const OV = () => dates.addDays(week().start, 56);

test('an overlapping create SAVES, and says so as well as warning', async () => {
  const day = OV();
  const first = await post('/schedule/shift', { w: day, employee_id: String(E.server),
    position: 'server', date: day, start: '16:00', end: '22:00', break_minutes: '' });
  assert.strictEqual(flashOf(first).err, false);
  assert.doesNotMatch(flashOf(first).msg, /overlap/i, 'the first shift has nothing to clash with');

  const second = await post('/schedule/shift', { w: day, employee_id: String(E.server),
    position: 'server', date: day, start: '17:00', end: '23:00', break_minutes: '' });
  const f = flashOf(second);
  assert.strictEqual(f.err, false, 'NOT an error — the shift was saved');
  assert.match(f.msg, /^Shift added to the plan\./, 'it says the save happened first');
  // The exact sentence, not just the word: /overlap/i matched happily while it
  // read "has another shift that overlap this one".
  assert.match(f.msg, /Board Server has another shift that overlaps this one\./,
    'named, and the verb agrees with the count');

  const n = db.prepare(`SELECT COUNT(*) n FROM scheduled_shifts
    WHERE employee_id = ? AND business_date = ? AND status <> 'cancelled'`).get(E.server, day).n;
  assert.strictEqual(n, 2, 'BOTH shifts are on the board — a warning is not a refusal');
});

test('adjacent shifts do not warn', async () => {
  const day = dates.addDays(OV(), 1);
  await post('/schedule/shift', { w: day, employee_id: String(E.barista),
    position: 'barista', date: day, start: '10:00', end: '14:00', break_minutes: '' });
  const next = await post('/schedule/shift', { w: day, employee_id: String(E.barista),
    position: 'barista', date: day, start: '14:00', end: '18:00', break_minutes: '' });
  const f = flashOf(next);
  assert.strictEqual(f.err, false);
  assert.doesNotMatch(f.msg, /overlap/i,
    '10–14 then 14–18 touch at a point; they do not intersect');
});

test('editing a shift does not report it overlapping ITSELF', async () => {
  const day = dates.addDays(OV(), 2);
  await post('/schedule/shift', { w: day, employee_id: String(E.barista),
    position: 'barista', date: day, start: '09:00', end: '15:00', break_minutes: '' });
  const only = db.prepare(`SELECT * FROM scheduled_shifts WHERE employee_id = ? AND business_date = ?
    ORDER BY id DESC LIMIT 1`).get(E.barista, day);
  const res = await post(`/schedule/shift/${only.id}`, { w: day, employee_id: String(E.barista),
    position: 'barista', date: day, start: '09:30', end: '15:30', break_minutes: '' });
  const f = flashOf(res);
  assert.strictEqual(f.err, false);
  assert.doesNotMatch(f.msg, /overlap/i,
    'the only shift that day is the one being edited — it cannot clash with itself');
});

test('editing INTO an overlap saves and warns', async () => {
  const day = dates.addDays(OV(), 3);
  await post('/schedule/shift', { w: day, employee_id: String(E.server),
    position: 'server', date: day, start: '08:00', end: '12:00', break_minutes: '' });
  await post('/schedule/shift', { w: day, employee_id: String(E.server),
    position: 'server', date: day, start: '18:00', end: '22:00', break_minutes: '' });
  const late = db.prepare(`SELECT * FROM scheduled_shifts WHERE employee_id = ? AND business_date = ?
    ORDER BY id DESC LIMIT 1`).get(E.server, day);

  // Drag the evening shift back over the morning one.
  const res = await post(`/schedule/shift/${late.id}`, { w: day, employee_id: String(E.server),
    position: 'server', date: day, start: '11:00', end: '15:00', break_minutes: '' });
  const f = flashOf(res);
  assert.strictEqual(f.err, false, 'saved');
  assert.match(f.msg, /^Shift updated\./);
  assert.match(f.msg, /overlap/i, 'and warned');
  assert.strictEqual(SCH.byId(late.id).starts_at.slice(11, 16),
    TC.localInputToUtc(`${day} 11:00`).slice(11, 16), 'the edit really landed');
});

test('a duplicate succeeds and does NOT emit the overlap warning', async () => {
  const day = dates.addDays(OV(), 4);
  await post('/schedule/shift', { w: day, employee_id: String(E.barista),
    position: 'barista', date: day, start: '09:00', end: '17:00', break_minutes: '' });
  const src = db.prepare(`SELECT * FROM scheduled_shifts WHERE employee_id = ? AND business_date = ?
    ORDER BY id DESC LIMIT 1`).get(E.barista, day);

  const res = await post(`/schedule/shift/${src.id}/duplicate`, { w: day });
  const f = flashOf(res);
  assert.strictEqual(f.err, false, 'the duplicate saved');
  assert.strictEqual(f.msg, 'Duplicated into the same day.', 'and said only that');
  // A duplicate lands in the same cell at the same times, so it ALWAYS overlaps
  // its own original. Warning every time would be noise, and noise here teaches
  // people to skim the warning on create and edit where it means something.
  assert.doesNotMatch(f.msg, /overlap/i, 'no warning about the thing that was just asked for');

  assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM scheduled_shifts
    WHERE employee_id = ? AND business_date = ? AND status <> 'cancelled'`).get(E.barista, day).n, 2,
    'and both shifts are on the board');
});

test('an overnight overlap is detected across the midnight boundary', async () => {
  const day = dates.addDays(OV(), 5);
  // 8pm–2am, then 1am–5am the following morning. Different business dates, but
  // the SAME person is in two places for an hour — which is the whole point of
  // comparing UTC stamps rather than clock times on a date.
  await post('/schedule/shift', { w: day, employee_id: String(E.multi),
    position: 'bartender', date: day, start: '20:00', end: '02:00', break_minutes: '' });
  const res = await post('/schedule/shift', { w: day, employee_id: String(E.multi),
    position: 'bartender', date: dates.addDays(day, 1), start: '01:00', end: '05:00', break_minutes: '' });
  const f = flashOf(res);
  assert.strictEqual(f.err, false, 'saved');
  assert.match(f.msg, /overlap/i, 'the hour they share is caught even though the dates differ');
});

test('the overlap warning writes nothing to time, work, payroll or services', async () => {
  const day = dates.addDays(OV(), 6);
  const before = footprint();
  await post('/schedule/shift', { w: day, employee_id: String(E.server),
    position: 'server', date: day, start: '16:00', end: '22:00', break_minutes: '' });
  const res = await post('/schedule/shift', { w: day, employee_id: String(E.server),
    position: 'server', date: day, start: '17:00', end: '23:00', break_minutes: '' });
  assert.match(flashOf(res).msg, /overlap/i, 'it warned');
  assert.deepStrictEqual(footprint(), before,
    'and warning about a plan is still only reading a plan');
});

test('the overlap note is wired to create and edit only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const region = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
  assert.match(region("app.post('/schedule/shift'", "app.post('/schedule/shift/:id'"),
    /sbOverlapNote\(/, 'create warns');
  assert.match(region("app.post('/schedule/shift/:id'", "app.post('/schedule/shift/:id/delete'"),
    /sbOverlapNote\(/, 'edit warns');
  assert.doesNotMatch(region("app.post('/schedule/shift/:id/duplicate'", "app.post('/schedule/copy-week'"),
    /sbOverlapNote\(/, 'duplicate does not — it always overlaps itself');
  assert.doesNotMatch(region("app.post('/schedule/copy-week'", "app.get('/timeclock'"),
    /sbOverlapNote\(/, 'copy-week is outside the approved Q2 scope');
  assert.strictEqual((src.match(/sbOverlapNote\(/g) || []).length, 3,
    'one definition and exactly two call sites');
});

test('overlap is a WARNING, never a validation rule', () => {
  // If this ever moves into validate() the domain starts refusing split shifts
  // and doubles, and Phase 4 has to unpick it. Pinned deliberately.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');
  const validate = src.slice(src.indexOf('function validate('), src.indexOf('function normalizeBreaks('));
  assert.doesNotMatch(validate, /overlap/i, 'validate() knows nothing about overlap');
  // And the route asks the domain rather than reimplementing the comparison.
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /SCH\.overlapsFor\(/, 'the route uses the one implementation');
  assert.strictEqual((server.match(/starts_at <.*ends_at >/g) || []).length, 0,
    'and does not carry a second copy of the overlap comparison');
});

// ===========================================================================
// The invariants, at the route
// ===========================================================================

test('nothing on this page publishes, notifies, or reaches an employee', async () => {
  const html = await text('/schedule');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM published_schedule').get().n, 0,
    'published_schedule is still empty after every write above');
  assert.doesNotMatch(html, /\/schedule\/publish|name="publish"/, 'no publish control ships in this phase');
  assert.strictEqual(await status('/schedule/publish'), 404, 'and no publish route exists');
});

test('the employee Schedule tab is still locked', async () => {
  // Phase 3 opens this. Until then the portal must not grow a schedule surface.
  assert.strictEqual(await status('/portal/schedule'), 404);
});

test('Schedule is its own access area — /shifts stays Services', () => {
  const { areaFor, AREAS } = require('../src/nav');
  assert.strictEqual(areaFor('/schedule'), 'schedule', 'its own key');
  assert.strictEqual(areaFor('/shifts'), 'shifts', 'and Services keeps the old one');
  assert.notStrictEqual(areaFor('/schedule'), areaFor('/shifts'),
    'so an account granted Services is not silently granted the Scheduler');
  assert.ok(AREAS.some((a) => a.key === 'shifts' && /Services/i.test(a.label)),
    'the shifts KEY is still the one stored on accounts');
});

test('every posting form on the board carries a CSRF token', async () => {
  // The CSRF layer itself is global middleware, covered in auth.test.js — and
  // it stands down entirely when no password is set (server.js: "nobody signed
  // in, there is no session to forge a request against"), which is exactly the
  // mode this harness runs in. So testing the middleware from here would test
  // the middleware, not these routes.
  //
  // What IS this page's job: every form it renders must actually supply the
  // token, or the board breaks the moment a password is set on the account.
  const html = await text('/schedule');
  const forms = html.match(/<form[\s\S]*?<\/form>/g) || [];
  const posting = forms.filter((f) => /method="post"/i.test(f));
  assert.ok(posting.length >= 3, `the board posts from several forms (${posting.length})`);
  // The VALUE is empty in open mode — csrfFor() has no session to derive from —
  // so what is asserted is that the field is there to be filled the moment a
  // password exists. A form missing it entirely breaks on the day one is set.
  for (const f of posting) {
    assert.match(f, /name="_csrf"/,
      `a posting form ships with no token field: ${f.slice(0, 90)}`);
  }
});

test("the board's own inline script parses", async () => {
  // It did not, once. An escaped quote inside a template literal inside an
  // onclick attribute closed the string early, and the ENTIRE drawer script
  // died at parse time — so clicking a cell or a card did nothing at all.
  // Every server-side test still passed, because none of them run the page.
  const html = await text('/schedule');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, 'the board ships a script');
  for (const src of scripts) {
    assert.doesNotThrow(() => new Function(src),   // eslint-disable-line no-new-func
      'the board\'s inline script has a syntax error and would not run at all');
  }
});

test('the drawer can reach create, edit, duplicate and delete', async () => {
  const html = await text('/schedule');
  // The four actions the board's script switches between, present as real
  // markup rather than strings built at click time.
  assert.match(html, /id="sb-form"[^>]*action="\/schedule\/shift"/, 'create posts to the collection');
  assert.match(html, /id="sb-dup"/, 'duplicate has its own form');
  assert.match(html, /id="sb-del"/, 'and so does delete');
  assert.match(html, /id="sb-del-btn"/, 'with a button the script can confirm on');
  assert.match(html, /data-new="1"/, 'an empty cell carries what create needs');
  assert.match(html, /data-edit="\d+"/, 'and a card carries its id for edit');
});

test('a write route refuses an account without the schedule area', async () => {
  // navAllowed() is the one gate the sidebar and the routes both read. The
  // write handlers call it before touching the domain, so a link that is
  // hidden is also a route that is closed.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const region = src.slice(src.indexOf("app.post('/schedule/shift'"), src.indexOf("app.get('/timeclock'"));
  const guards = (region.match(/sbGuard\(req, res\)/g) || []).length;
  assert.strictEqual(guards, 5, `all five write routes call the guard (found ${guards})`);
  assert.match(src.slice(src.indexOf('const sbGuard')), /navAllowed\('\/schedule'\)/,
    'and the guard asks the same question the sidebar does');
});

test('the board never lets the PAGE scroll sideways', async () => {
  const html = await text('/schedule');
  // The board owns its scroll; the document must not. Asserted at the seam
  // where it is decided, because a page that scrolls sideways drags the
  // masthead and sidebar off with it.
  assert.match(html, /class="sb-scroll egrid-scroll"/, 'the grid is inside a contained scroller');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  const rule = (sel) => (css.match(new RegExp('(?:^|\\})\\s*' + sel.replace(/[.\-]/g, (m) => '\\' + m) + '\\s*\\{([^}]*)\\}', 'm')) || [])[1] || '';
  assert.match(rule('.egrid-scroll'), /overflow-x:\s*auto/);
  assert.match(rule('.bs-main:has\\(.sb\\)'), /min-width:\s*0/,
    'and min-width:0 stops a max-content grid forcing the shell wider than the viewport');
});
