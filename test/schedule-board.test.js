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
  assert.match(html, /class="sb-chip sb-chip--/, 'the chip carries a derived tone');
  assert.doesNotMatch(html, /class="swb-draft"/, 'the old banner is gone');
  // Phase 3: the chip is DERIVED. It used to say "Draft" unconditionally, even
  // after a week had gone out — the one thing on the page a manager would most
  // reasonably trust. The states it can now report are asserted below.
  assert.match(html, /Nothing planned|unpublished change|Published/,
    'and says one of the states it can actually be in');
});

test('Q1: the week shown runs Monday to Sunday, like a calendar', async () => {
  // Was the reverse: the board followed the pay period so its seven days were
  // the seven overtime is measured over. The anchor is a Saturday and nobody
  // reads a schedule Saturday-first, so the owner changed it. The cost — the
  // board week is no longer the OT workweek — is pinned in scheduler.test.js.
  const html = await text('/schedule');
  const wk = week();
  const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  assert.strictEqual(dow(wk.start), 1, 'the first column is a Monday');
  assert.strictEqual(dow(wk.end), 0, 'the last is a Sunday');
  assert.strictEqual(Number((html.match(/--sb-cols:(\d+)/) || [])[1]), 7, 'seven columns');
  assert.ok(html.includes(TC.dayLabel(wk.start)) && html.includes(TC.dayLabel(wk.end)));
});

test('Q1: next and previous land on the next and previous Monday', async () => {
  // "the next 7 dates", as asked for — not a jump that re-derives from anything.
  const wk = week();
  const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const next = dates.addDays(wk.start, 7);
  const prev = dates.addDays(wk.start, -7);
  assert.strictEqual(dow(next), 1, 'forward a week is still a Monday');
  assert.strictEqual(dow(prev), 1, 'and so is back a week');
  const html = await text(`/schedule?w=${next}`);
  assert.ok(html.includes(TC.dayLabel(next)), 'the board opens on that Monday');
  assert.ok(html.includes(TC.dayLabel(dates.addDays(next, 6))), 'through the Sunday after it');
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
  const card = (html.match(/<button class="sbk sbk--[\w-]+ sbk--\w+"[\s\S]*?<\/button>/) || [])[0];
  assert.ok(card, 'a card is on the board');
  assert.ok(card.indexOf('<b>') < card.indexOf('<i>'), 'position markup precedes time markup');
  assert.match(card, /<b>Server<\/b>/, 'the position is text, never colour alone');
  assert.match(card, /<i>4:00p–10:00p<\/i>/, 'minutes always, so a column of times scans');
  assert.match(card, /aria-label="Edit Server/, 'and it is labelled for a screen reader');
});

test('a card carries its position colour from the deterministic mapping', async () => {
  const html = await text('/schedule');
  assert.match(html, /class="sbk sbk--green sbk--\w+"/, 'server is green, plus its publication state');
});

test('an overnight shift renders on the day it STARTED', async () => {
  const wk = week();
  const day = dates.addDays(wk.start, 2);
  // 8pm to 2am. The clock puts this on the night it began; so must the plan.
  const s = SCH.create({ employeeId: E.multi, position: 'bartender',
    startsAt: `${day} 20:00`, endsAt: `${dates.addDays(day, 1)} 02:00` });
  assert.strictEqual(SCH.byId(s.id).business_date, day, 'stamped to the starting night');
  const html = await text('/schedule');
  assert.match(html, /<i>8:00p–2:00a<\/i>/, 'and reads across midnight on the card');
});

test('multiple shifts on one day stack in chronological order, full size', async () => {
  const wk = week();
  const day = dates.addDays(wk.start, 3);
  SCH.create({ employeeId: E.barista, position: 'barista',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  SCH.create({ employeeId: E.barista, position: 'barista',
    startsAt: `${day} 06:30`, endsAt: `${day} 11:00` });
  const html = await text('/schedule');
  // Scope to the DESKTOP board before matching. /schedule renders the Phase 5
  // mobile Today/Upcoming surface (.sbm-*) FIRST, and its cards carry the same
  // employee name — so anchoring on the name alone finds whichever surface
  // happens to mention them first. That silently became the mobile one as soon
  // as these shifts fell inside the Upcoming window, which depends on the wall
  // clock rather than on anything the test controls.
  const board = html.slice(html.indexOf('<div class="sb">'));
  const row = (board.match(/Board Barista[\s\S]*?(?=<div class="sb-row">|<\/div>\s*<\/div>\s*<div class="sb-sum")/) || [])[0];
  const times = [...row.matchAll(/<i>([^<]+)<\/i>/g)].map((m) => m[1]).filter((s) => /[ap]$/.test(s));
  const idxEarly = times.indexOf('6:30a–11:00a');
  const idxLate = times.indexOf('4:00p–10:00p');
  assert.ok(idxEarly >= 0 && idxLate >= 0, `both shifts render (${times.join(', ')})`);
  assert.ok(idxEarly < idxLate, 'earliest first');
});

test('the employee column shows hours and shift count, never a "primary" position', async () => {
  const html = await text('/schedule');
  // The planned-wage figure now sits on the name line, between the two, so
  // this allows anything that is not another element opening a new line. The
  // point of the test is unchanged: totals under the name, never a position.
  assert.match(html, /<b>Board Multi<\/b>[^<]*(<u[^>]*>[^<]*<\/u>)?[^<]*<\/span>\s*<i>[\d.]+h · \d+ shifts?<\/i>/,
    'name then totals');
  // Multi works server AND bartender; naming one under the name would be wrong.
  assert.doesNotMatch(html, /<b>Board Multi<\/b>[\s\S]{0,120}?<i>(Server|Bartender)/i);
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
  const marked = html.match(/class="sb-dh is-today[^"]*"[\s\S]{0,200}?<em>([^<]*)/);
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

// ---------------------------------------------------------------------------
// The position picker follows the person
// ---------------------------------------------------------------------------

test('the picker offers only the positions that person can actually work', async () => {
  const html = await text('/schedule');
  const m = /var held = (\{.*?\});/.exec(html);
  assert.ok(m, 'the board carries a held-positions map for the drawer');
  const held = JSON.parse(m[1]);

  // The bug this replaces: the list was the same for everybody and opened on
  // whichever position sits first in the positions table, so every employee who
  // was not that one thing got "They are not assigned to that position." on the
  // first Save. A barista must be offered barista.
  assert.deepStrictEqual(held[E.barista], ['barista'],
    'a barista is offered barista, not the first row of the table');
  assert.deepStrictEqual([...held[E.multi]].sort(), ['bartender', 'server'],
    'somebody holding two jobs is offered both');

  // Same source as the server's own qualification check, so the picker and the
  // validator cannot drift apart and start disagreeing about the same person.
  const domain = SCH.heldPositionsFor([E.barista, E.multi]);
  assert.deepStrictEqual(held[E.barista], domain[E.barista]);
  assert.deepStrictEqual([...held[E.multi]].sort(), [...domain[E.multi]].sort());
});

test('the refusal the picker prevents is still enforced on the server', async () => {
  // The picker narrows what can be asked for; it is not what makes the rule
  // true. A hand-rolled post still has to be refused.
  const day = dates.addDays(week().start, 60);
  const res = await post('/schedule/shift', { w: day, employee_id: String(E.barista),
    position: 'server', date: day, start: '10:00', end: '14:00', break_minutes: '' });
  const f = flashOf(res);
  assert.strictEqual(f.err, true, 'refused');
  assert.match(f.msg, /not assigned to that position/i);
});

test('changing WHO re-asks what they can work, and never carries a stale position', async () => {
  // Run the page's own picker, not a copy of it. The first version of this
  // passed the previous selection through as the keep argument, which forces an
  // option into the list — so switching from a barista to a cook offered, and
  // selected, barista, and the server refused the save. A source-text assertion
  // about the handler passed happily while that was true.
  const html = await text('/schedule');
  // From `var shifts` — the context line reads that array, so a slice that
  // starts below it runs against a name that does not exist yet.
  const from = html.indexOf('var shifts =');
  // Ends at the shared click handler — a stable marker that does not move when
  // the grid selector is used elsewhere.
  const src = html.slice(from, html.indexOf('var sbTargets', from));
  assert.ok(from > -1 && src.includes('function sbPositions'), 'found the picker in the page');

  const el = (id) => ({
    id, value: '', options: [], listeners: {},
    set innerHTML(_) { this.options = []; },
    appendChild(o) { this.options.push(o); this.firstChild = this.options[0]; },
    addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); },
    fire(k) { (this.listeners[k] || []).forEach((f) => f()); },
  });
  const nodes = { 'sb-pos': el('sb-pos'), 'sb-emp': el('sb-emp'),
    'sb-ctx': el('sb-ctx'), 'sb-date': el('sb-date'),
    'sb-form': Object.assign(el('sb-form'), { getAttribute: () => '/schedule/shift' }) };
  const sandbox = {
    // querySelector answers null: the slice also carries the Issues panel
    // wiring, which is absent from this fake page and must simply not throw.
    document: { getElementById: (id) => nodes[id] || null, querySelector: () => null,
      body: { classList: { toggle() {} } } },
    Option: function Option(label, value) { return { label, value, disabled: false }; },
  };
  // The slice carries the drawer helper along with the picker; it only needs
  // somewhere to hang itself, not a real window.
  // eslint-disable-next-line no-new-func
  new Function('document', 'Option', 'window', src)(sandbox.document, sandbox.Option, {});

  const offered = () => nodes['sb-pos'].options.map((o) => o.value);
  const switchTo = (id) => { nodes['sb-emp'].value = String(id); nodes['sb-emp'].fire('change'); };

  nodes['sb-emp'].value = String(E.multi);          // server + bartender
  switchTo(E.multi);
  assert.deepStrictEqual(offered().sort(), ['bartender', 'server']);

  nodes['sb-pos'].value = 'bartender';
  switchTo(E.barista);                              // holds barista only
  assert.deepStrictEqual(offered(), ['barista'], 'only what the cook can work');
  assert.strictEqual(nodes['sb-pos'].value, 'barista',
    'and bartender did not ride along — that is the refusal all over again');

  nodes['sb-pos'].value = 'server';
  switchTo(E.multi);
  assert.strictEqual(nodes['sb-pos'].value, 'server', 'a shared position survives the switch');
});

test('creating offers Save Draft and Publish; editing offers one Save', async () => {
  const html = await text('/schedule');
  assert.match(html, /name="publish" value="1"/, 'Publish posts a flag, not a second route');
  assert.match(html, /id="sb-savepub"[^>]*hidden/, 'and is hidden until a create opens it');
  assert.match(html, /id="sb-new"[^>]*hidden/, 'as is the draft explanation');
  assert.match(html, /nobody\s+sees it until the week is published/,
    'which says what saving actually does');

  // The two branches of the drawer, each rebuilding the picker for its person.
  const add = html.slice(html.indexOf("closest('.sb-add')"), html.indexOf("closest('.sbk, .sbm-k')"));
  assert.match(add, /sbPositions\(add\.dataset\.emp, null\)/, 'create asks for that employee');
  assert.match(add, /'Save Draft'/, 'and leads with the draft');
  const edit = html.slice(html.indexOf("closest('.sbk, .sbm-k')"));
  assert.match(edit, /sbPositions\(s\.e, s\.p\)/,
    'edit keeps the position the shift already has, even if they no longer hold it');
  assert.match(edit, /sb-savepub'\)\.hidden = true/, 'and drops the create-only pair');
});

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
  // Phase 3 follow-up: create says what it DID, which is save a draft. "Added
  // to the plan" left a manager guessing whether the floor had been told.
  assert.match(f.msg, /^Saved as a draft — employees cannot see it yet\./,
    'it says the save happened, and that it reached nobody');
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

test('the overlap note is wired to the three routes that place a shift', () => {
  // Create, edit, and now MOVE. A drag is an edit performed with a mouse — it
  // lands somebody on a day, and landing them on a day they already work is
  // exactly when a manager wants telling. Duplicate and copy-week stay silent
  // for their own reasons, recorded below.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const routeBody = (name) => {
    const at = src.indexOf(`app.post('${name}'`);
    assert.ok(at > 0, `${name} exists`);
    return src.slice(at, src.indexOf('\napp.', at + 10));
  };
  assert.match(routeBody('/schedule/shift'), /sbOverlapNote\(/, 'create warns');
  assert.match(routeBody('/schedule/shift/:id'), /sbOverlapNote\(/, 'edit warns');
  assert.match(routeBody('/schedule/shift/:id/move'), /sbOverlapNote\(/, 'and a drop warns');
  assert.doesNotMatch(routeBody('/schedule/shift/:id/duplicate'), /sbOverlapNote\(/,
    'duplicate does not — it always overlaps itself');
  assert.doesNotMatch(routeBody('/schedule/copy-week'), /sbOverlapNote\(/,
    'copy-week is outside the approved Q2 scope');
  assert.strictEqual((src.match(/sbOverlapNote\(/g) || []).length, 4,
    'one definition and exactly three call sites');
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
  // Phase 3 opens publishing deliberately. What must stay shut is the EMPLOYEE
  // side reading drafts, which the tests below cover.
  assert.match(html, /\/schedule\/publish-week/, 'the manager can publish');
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
  // Phase 3 added three: publish-week, publish, unpublish. Phase 7 added two
  // more: saving a shift template and deleting one. Every route that can change
  // a draft, a saved shape, OR what an employee sees asks the same question the
  // sidebar does, so a hidden link is also a closed door.
  //
  // The COUNT is the point. It is deliberately brittle: adding a write route
  // without a guard is exactly the mistake this catches, and it caught the two
  // above while they were being written.
  assert.strictEqual(guards, 16, `all sixteen write routes call the guard (found ${guards})`);
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

// ===========================================================================
// PHASE 4 — the Issues surface on the board
// ===========================================================================

const ISS = () => dates.addDays(week().start, 0);

test('no issues means no Issues chip at all', async () => {
  const html = await text('/schedule');
  // Zero does not deserve permanent furniture in the toolbar.
  if (!/sb-chip--iss/.test(html)) {
    assert.doesNotMatch(html, /id="sb-iss"/, 'and no panel either');
    return;
  }
  // The board is shared with earlier tests; if something in this week is
  // genuinely wrong the chip is correct to be there.
  assert.match(html, /Issues <b>\d+<\/b>/, 'and when it is there it carries a count');
});

test('an overlap puts a count in the toolbar and one row in the panel', async () => {
  const day = dates.addDays(week().start, 3);
  const a = await post('/schedule/shift', { w: day, employee_id: String(E.multi),
    position: 'server', date: day, start: '16:00', end: '22:00', break_minutes: '' });
  const b = await post('/schedule/shift', { w: day, employee_id: String(E.multi),
    position: 'bartender', date: day, start: '17:00', end: '23:00', break_minutes: '' });
  assert.strictEqual(flashOf(a).err, false);
  assert.strictEqual(flashOf(b).err, false);

  const html = await text('/schedule');
  assert.match(html, /sb-chip--iss/, 'the chip appears');
  const panel = html.slice(html.indexOf('id="sb-iss"'), html.indexOf('class="drawer-scrim"'));
  assert.match(panel, /Overlap/, 'the panel names the kind');
  assert.match(panel, /Board Multi/, 'and who it is about');
  assert.match(panel, /overlaps/, 'and says what clashes with what');
  assert.match(panel, /REVIEW|Review/, 'overlap is Review, not Action needed');

  // ONE row for THIS clash, not one per card. Asserted on the pair's own key
  // rather than the panel's total, because this board is shared with every
  // other test in the file and may legitimately hold other issues.
  const mine = db.prepare(`SELECT id FROM scheduled_shifts
    WHERE employee_id = ? AND business_date = ? AND status <> 'cancelled' ORDER BY id`).all(E.multi, day);
  assert.strictEqual(mine.length, 2, 'both shifts saved');
  const [lo, hi] = mine.map((r) => r.id);
  const keyed = (panel.match(new RegExp(`data-key="overlap:${lo}:${hi}"`, 'g')) || []).length;
  assert.strictEqual(keyed, 1, 'a single clash is a single row, keyed on the sorted pair');
  assert.ok(!panel.includes(`data-key="overlap:${hi}:${lo}"`),
    'and never the same pair the other way round');

  // Both cards carry the outline even though the issue is one.
  for (const id of [lo, hi]) {
    const card = (html.match(new RegExp(`<button class="sbk[^"]*"[^>]*data-edit="${id}"`)) || [])[0];
    assert.ok(card && /sbk--iss-review/.test(card), `shift ${id} is outlined`);
  }
});

test('the panel lets a manager reach the shift, and says there is nothing to tick off', async () => {
  const html = await text('/schedule');
  const panel = html.slice(html.indexOf('id="sb-iss"'), html.indexOf('class="drawer-scrim"'));
  assert.match(panel, /data-goto="\d+"/, 'each row points at a shift');
  assert.match(panel, /nothing here to tick off/i, 'and there is no resolve workflow');
  // The click handler finds the card by the attribute the board already uses.
  assert.match(html, /\.sbk\[data-edit="' \+ row\.dataset\.goto \+ '"\]/,
    'click-through reuses data-edit rather than new state');
});

test('none of it blocks publishing', async () => {
  const html = await text('/schedule');
  assert.match(html, /sb-chip--iss/, 'issues are present');
  assert.match(html, /\/schedule\/publish-week/, 'and Publish week is still there');
  const day = dates.addDays(week().start, 3);
  const res = await post('/schedule/publish-week', { w: day });
  assert.strictEqual(flashOf(res).err, false, 'publishing a week with issues is allowed');
});

test('the issue outline never replaces the position colour or the publish marker', async () => {
  const html = await text('/schedule');
  const card = (html.match(/<button class="sbk sbk--\w+ sbk--[\w-]+ sbk--iss-\w+"[\s\S]*?<\/button>/) || [])[0];
  assert.ok(card, 'a card carries all three');
  assert.match(card, /sbk--(green|plum|amber|brick|blue|teal|indigo|rose|orange|slate)/,
    'position colour survives');
  assert.match(card, /sbk--(draft|changed|published)/, 'publication state survives');
  assert.match(card, /<s aria-hidden="true">/, 'and the publication dot is still drawn');
});

test('no Issues data reaches the employee portal', async () => {
  // Issues name coworkers and their hours. The portal must never carry any of
  // it, in rendered text or in page source.
  const cookie = await (async () => {
    const r = await fetch(`${BASE}/tips/start`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin: '5204' }),
    });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  })();
  for (const p of ['/portal/schedule', '/portal/schedule?v=all', '/portal']) {
    const html = await (await fetch(BASE + p, { headers: { cookie } })).text();
    for (const leak of ['sb-iss', 'Action needed', 'overlaps', 'no longer one of',
      'issuesFor', 'sbk--iss']) {
      assert.ok(!html.includes(leak), `${p} does not leak "${leak}"`);
    }
  }
});

test('the drawer says what that person already has — hours, and that same day', async () => {
  // Phase 2 specified three things beside the picker: held positions, current
  // scheduled hours, same-day assignments. Only the first was built, so the
  // drawer asked you to place a shift while hiding the two facts that decide
  // whether you should.
  const day = dates.addDays(week().start, 5);
  const a = await post('/schedule/shift', { w: day, employee_id: String(E.barista),
    position: 'barista', date: day, start: '09:00', end: '15:00', break_minutes: '' });
  assert.strictEqual(flashOf(a).err, false);

  const html = await text('/schedule');
  // The drawer's data moved into a #sb-data block so a no-reload refresh can
  // re-read it. Same numbers, same server, one parse instead of two.
  assert.match(html, /id="sb-data"/, 'the week minutes reach the page');
  assert.match(html, /id="sb-ctx"/, 'and there is somewhere to say it');

  // Same source as the row, so the drawer and the grid cannot disagree.
  const blob = /id="sb-data" hidden>([\s\S]*?)<\/div>/.exec(html)[1];
  const mins = JSON.parse(blob.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')).mins;
  const t = SCH.weekTotals(SCH.inRange(week().start, week().end));
  assert.strictEqual(mins[E.barista], t.byEmployee[String(E.barista)].paidMinutes,
    'the figure is weekTotals, not a second count');

  const src = html.slice(html.indexOf('function sbContext'));
  assert.match(src, /already on that day/, 'it names the other shifts on that date');
  assert.match(src, /exceptId && String\(s\.id\) === String\(exceptId\)/,
    'and never reports the shift being edited as clashing with itself');
});

// ===========================================================================
// PHASE 5 — the manager's phone
// ===========================================================================

test('P5: both views ship in the page, and ?v= picks one', async () => {
  const auto = await text('/schedule');
  assert.match(auto, /class="sb-view sb-view--auto"/, 'no ?v= leaves the viewport to decide');
  assert.match(auto, /class="sbm"/, 'the Today list is present');
  assert.match(auto, /class="sb-grid"/, 'and so is the Week grid');

  const t = await text('/schedule?v=today');
  assert.match(t, /class="sb-view sb-view--today"/);
  assert.match(t, /aria-current="page"[^>]*>Today|Today<\/a>/, 'Today reads as current');
  const w = await text('/schedule?v=week');
  assert.match(w, /class="sb-view sb-view--week"/);
  assert.match(w, /href="\/schedule\?v=week[^"]*"\s+aria-current="page"/,
    'Week exposes the accessible selected state');
});

test('P5: Today is the business date, not the calendar date', async () => {
  const html = await text('/schedule?v=today');
  const biz = TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);
  assert.match(html, new RegExp(TC.dayLabel(biz).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the header names the business date');
  // Between midnight and the cutoff that is YESTERDAY's calendar date, which is
  // the whole reason this is not `new Date()`.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = src.indexOf('const mToday = serviceToday()');
  assert.ok(i > -1, 'Today comes from serviceToday(), the one business-date authority');
});

test('P5: Today is chronological and Upcoming groups by date', async () => {
  const biz = TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);
  const later = dates.addDays(biz, 2);
  await post('/schedule/shift', { w: biz, employee_id: String(E.server),
    position: 'server', date: biz, start: '18:00', end: '23:00', break_minutes: '' });
  await post('/schedule/shift', { w: biz, employee_id: String(E.barista),
    position: 'barista', date: biz, start: '08:00', end: '12:00', break_minutes: '' });
  await post('/schedule/shift', { w: later, employee_id: String(E.multi),
    position: 'server', date: later, start: '16:00', end: '22:00', break_minutes: '' });

  const html = await text('/schedule?v=today');
  const sbm = html.slice(html.indexOf('class="sbm"'), html.indexOf('class="sb "') > -1
    ? html.indexOf('class="sb "') : html.indexOf('<div class="sb">'));
  const today = sbm.slice(0, sbm.indexOf('Upcoming'));
  assert.ok(today.indexOf('8:00a') < today.indexOf('6:00p'),
    'the earlier shift is listed first — chronological, not by employee');
  assert.match(sbm, /class="sbm-h">Upcoming/, 'Upcoming exists');
  assert.match(sbm.slice(sbm.indexOf('Upcoming')), /class="sbm-day"><h3>/,
    'and is grouped under a date heading');
});

test('P5: no attendance language anywhere in the mobile surface', async () => {
  // Schedule is the plan. Only the Time Clock knows who actually turned up, and
  // a manager reading "Now" on a plan will hear attendance.
  const html = await text('/schedule?v=today');
  const sbm = html.slice(html.indexOf('class="sbm"'), html.indexOf('<div class="sb">'));
  for (const claim of ['In progress', 'Clocked in', 'No-show', 'Late', 'On break', '>Now<']) {
    assert.ok(!sbm.includes(claim), `the plan never claims "${claim}"`);
  }
});

test('P5: Add shift prefills the current business date', async () => {
  const html = await text('/schedule?v=today');
  const biz = TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);
  assert.match(html, new RegExp(`id="sbm-add"[^>]*data-d="${biz}"`),
    'the Add button carries today, so the drawer opens on the right day');
});

test('P5: the mobile list opens the same drawer through the same handler', async () => {
  const html = await text('/schedule?v=today');
  assert.match(html, /var sbTargets = \[document\.querySelector\('\.sb-grid'\), document\.querySelector\('\.sbm'\)\]/,
    'one handler for both views — they cannot drift apart');
  // And it must MATCH both card shapes. Binding to both roots was not enough:
  // the selector still said .sbk only, so a tap in Today did nothing at all,
  // and this test passed anyway because it only checked the binding existed.
  assert.match(html, /closest\('\.sbk, \.sbm-k'\)/,
    'the grid card AND the mobile card both open the drawer');
  assert.match(html, /class="sbm-k[^"]*"[\s\S]{0,200}?data-edit="\d+"/,
    'and a mobile card carries the same data-edit the grid uses');
});

test('P5: cancelling names the shift', async () => {
  const html = await text('/schedule');
  assert.match(html, /var q = sbDelWhat \? 'Cancel ' \+ sbDelWhat/,
    'the confirmation identifies who and when, not just "this shift"');
  assert.match(html, /removes the plan, not any hours worked/,
    'and still says what cancelling does not touch');
});

test('P5: position colours come from the one palette, not a second one', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  assert.match(css, /\.sb, \.sbm \{\s*\n?\s*--c-green:/,
    'the mobile list shares the board declaration — it rendered unpainted as a sibling');
  const pal = ['green', 'plum', 'amber', 'brick', 'blue', 'teal', 'indigo', 'rose', 'orange', 'slate'];
  for (const c of pal) {
    // One declaration now serves both the fill and the outline, and both views.
    assert.match(css, new RegExp(`\\.sbk--${c},\\.sbm-k--${c}\\{--pc:var\\(--c-${c}\\)`),
      `${c} declares the approved variable rather than a new value`);
  }
});

test('P5: the Week grid can actually overflow its scroller on a narrow screen', async () => {
  // The Phase 5 blocker. The board already had .sb-scroll.egrid-scroll with
  // overflow-x:auto; it never scrolled because .sb-grid is width:100%,
  // min-width:0 and so shrank to the wrapper instead of overflowing it.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  assert.match(css, /\.sb-scroll \.sb-grid \{ width:max-content; min-width:100%; \}/,
    'the grid keeps its natural width inside the scroller');
  assert.match(css, /@media \(max-width:900px\)\{\s*\n?\s*\.sb \{ --sb-lead:112px; --sb-col:132px; \}/,
    'and the columns stop being fractional, so they cannot shrink to fit');
  const html = await text('/schedule?v=week');
  assert.strictEqual((html.match(/class="sb-scroll/g) || []).length, 1,
    'exactly ONE scroller — a nested second one is what made every measurement read the wrong box');
});

test('P5: desktop Week is unchanged', async () => {
  const html = await text('/schedule?v=week');
  assert.match(html, /class="sb-grid" style="--sb-cols:7"/, 'seven day columns');
  assert.match(html, /\/schedule\/publish-week/, 'Publish week still lives in Week mode');
  const sbm = html.slice(html.indexOf('class="sbm"'), html.indexOf('<div class="sb">'));
  assert.ok(!sbm.includes('publish-week'), 'and never appears in the Today surface');
});

// ===========================================================================
// PUBLICATION STATE READS OFF THE CARD
// ===========================================================================
//
// Published and draft were both solid position-colour cards with an 8px dot
// between them, so a manager scanning the week could not tell what employees
// were actually looking at. Fill now carries it: solid = the floor sees this,
// outlined = it does not. The hue never changes — position stays dominant and
// the same ten colours do both jobs.

test('published is solid, draft is outlined, and the hue is the same', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');

  // One declaration sets the hue for BOTH states — that is what makes a
  // published and an unpublished Server unmistakably the same job.
  assert.match(css, /\.sbk--green,\.sbm-k--green\{--pc:var\(--c-green\);--pt:var\(--t-green\)\}/,
    'the colour class declares a variable rather than painting a background');
  assert.match(css, /\.sbk, \.sbm-k \{ border:3px solid var\(--pc\); background:var\(--pc\); color:var\(--pt\); \}/,
    'the default is solid — published needs no extra rule');
  assert.match(css, /\.sbk--draft, \.sbk--changed,[\s\S]{0,120}\{\s*\n?\s*background:var\(--paper\)/,
    'draft and changed drop the fill and keep the 3px coloured border');

  // No second palette anywhere.
  for (const c of ['green', 'plum', 'amber', 'brick', 'blue', 'teal', 'indigo', 'rose', 'orange', 'slate']) {
    assert.ok(!new RegExp(`--c-${c}-draft|--c-${c}-pub`).test(css), `no separate draft hue for ${c}`);
  }
});

test('the three publication states are each distinguishable', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  // published: solid, no dot. draft: outlined + hollow ring.
  // changed: outlined + FILLED dot, so "published then edited" never reads as
  // "never sent" — they share the outline but not the marker.
  assert.match(css, /\.sbk--published > s, \.sbm-k\.sbk--published > s \{ display:none; \}/);
  assert.match(css, /\.sbk--draft > s[^{]*\{ outline:1\.5px solid var\(--pc\)/);
  assert.match(css, /\.sbk--changed > s[^{]*\{ background:var\(--pc\); outline:0; \}/);
});

test('publication state is spoken, not only coloured', async () => {
  const html = await text('/schedule?v=week');
  // Fill vs outline cannot be the only signal.
  // The words the renderer can produce, whatever this week happens to hold.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /STATE_WORD = \{ published: 'published', changed: 'changed since publishing', draft: 'not published' \}/,
    'each publication state has a word, not only a fill');
  const card = (html.match(/<button class="sbk[^"]*"[^>]*aria-label="[^"]*"/) || [])[0] || '';
  assert.match(card, /aria-label="Edit [^"]+ to [^"]+, (published|not published|changed since publishing)/,
    'every card names its state in words');
});

test('Week and Today map publication state the same way', async () => {
  const html = await text('/schedule');
  // Both surfaces use the SAME sbk--<state> class, so one cannot drift solid
  // while the other is outlined for the same shift.
  assert.match(html, /class="sbm-k sbm-k--\w+ sbk--(published|draft|changed)/,
    'the mobile card carries the board\'s own state class');
});

test('card times always carry minutes', async () => {
  const biz = TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);
  const day = dates.addDays(week().start, 6);
  await post('/schedule/shift', { w: day, employee_id: String(E.longname),
    position: 'kitchen', date: day, start: '07:00', end: '22:00', break_minutes: '' });
  await post('/schedule/shift', { w: day, employee_id: String(E.barista),
    position: 'barista', date: day, start: '16:00', end: '22:30', break_minutes: '' });
  const html = await text('/schedule?v=week');

  assert.match(html, /7:00a<\/i>|7:00a/, 'a whole hour still prints :00');
  assert.match(html, /10:30p/, 'and a half hour is unchanged');
  // The old formatter stripped :00, so a board mixed "7a" with "10:30p" and the
  // eye had to work out they were the same kind of value.
  assert.ok(!/>\s*7a\s*[–-]/.test(html), 'never the bare hour form');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /const sbTimeFull = /,
    'manager cards have their own formatter');
  assert.match(src, /const sbTime = \(utc\) => TC\.clockFace\(utc\)\s*\n\s*\.replace\(\/:00/,
    'and sbTime is UNCHANGED — the employee portal shares it and was out of scope');
  assert.ok(biz);
});

test('the day header reads DATE, then people, then shifts', async () => {
  // The hierarchy was inverted: the date was 12px and the people count 13px, so
  // the eye landed on "0 people" before it found which day that was, and a week
  // of quiet days read louder than the week itself.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  const size = (sel) => {
    const i = css.indexOf(sel + ' {');
    const m = /font-size:([\d.]+)px/.exec(css.slice(i, css.indexOf('}', i)));
    return m ? Number(m[1]) : null;
  };
  const date = size('.sb-dh em'), people = size('.sb-dh b'), metrics = size('.sb-dh i');
  assert.ok(date > people, `the date (${date}px) leads the people count (${people}px)`);
  assert.ok(people > metrics, `and people (${people}px) leads shifts/hours (${metrics}px)`);
  // The range was 17-19px, set when the fix was making the date READ FIRST.
  // The owner later asked for a far denser board — that header cost roughly two
  // employee rows of vertical space per screen. The hierarchy above is the part
  // that mattered and it still holds; the absolute size was never the point.
  assert.ok(date >= 13 && date <= 15, `date is ${date}px, in the agreed range`);

  // A day with nobody on it must not shout just because the number is bold.
  assert.match(css, /\.sb-dh--none b \{ font-weight:500; color:var\(--muted\); \}/,
    'an empty day steps back rather than reading as an alert');
  // Asserted on the template, not on the board's incidental state: by the time
  // this runs the shared week may have somebody on every day, and then there is
  // no empty column to find.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /\$\{s\.p \? '' : ' sb-dh--none'\}/,
    'the class is emitted exactly when the people count is zero');
  assert.match(css, /font-variant-numeric:tabular-nums/, 'metrics line up column to column');
});

// ===========================================================================
// Phase 6 checkpoint 1 — the sch_availability setting.
//
// It governs employee-stated availability ONLY. Time off is unconditional,
// because an absence a manager personally approved has to keep warning them
// however this is set. That asymmetry is the whole decision, so it is asserted
// here rather than described.
// ===========================================================================

test('the schedule page carries an availability switch, on by default', async () => {
  const P = require('../src/periods');
  db.prepare("DELETE FROM settings WHERE key = 'sch_availability'").run();
  const html = await text('/schedule');
  assert.match(html, /action="\/schedule\/availability"/, 'the control posts somewhere real');
  assert.match(html, /Availability on/, 'and an untouched install reads as ON');
  assert.match(html, /aria-pressed="true"/, 'with the state exposed to assistive tech');
  // State is never carried by colour alone.
  assert.match(html, />Availability (on|off)</, 'the word is in the label');
  assert.strictEqual(P.getSetting('sch_availability', '1'), '1', 'and reading it did not write it');
});

test('the switch turns it off and back on, and says what that means', async () => {
  const P = require('../src/periods');
  const off = await post('/schedule/availability', { on: '0' });
  assert.strictEqual(off.status, 302, 'it redirects');
  assert.strictEqual(P.getSetting('sch_availability', '1'), '0', 'and the setting moved');
  assert.match(flashOf(off).msg, /nothing stated has been deleted/i,
    'the message says what was NOT done, because "off" reads like "deleted"');
  assert.match(flashOf(off).msg, /time off is unaffected/i, 'and that time off still works');

  const html = await text('/schedule');
  assert.match(html, /Availability off/, 'the switch reflects it');
  assert.match(html, /aria-pressed="false"/);

  const on = await post('/schedule/availability', { on: '1' });
  assert.strictEqual(P.getSetting('sch_availability', '1'), '1', 'and back on again');
  assert.match(flashOf(on).msg, /staff can say when they cannot work/i);
});

test('turning it off preserves the rules and still honours approved time off', async () => {
  const P = require('../src/periods');
  const TCm = require('../src/timeclock');
  const day = dates.addDays(today(), 21);
  db.prepare(`INSERT INTO availability_rules (employee_id, avail_kind, on_date, all_day)
              VALUES (?, 'unavailable', ?, 1)`).run(E.barista, day);
  db.prepare(`INSERT INTO time_off_requests (employee_id, starts_at, ends_at, all_day, status)
              VALUES (?, ?, ?, 1, 'approved')`)
    .run(E.barista, TCm.localInputToUtc(`${dates.addDays(day, 1)} 00:00`),
      TCm.localInputToUtc(`${dates.addDays(day, 2)} 00:00`));

  await post('/schedule/availability', { on: '0' });
  const ruled = SCH.availabilityFor(E.barista,
    TCm.localInputToUtc(`${day} 16:00`), TCm.localInputToUtc(`${day} 22:00`));
  assert.strictEqual(ruled.state, 'available', 'the rule is not consulted while it is off');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM availability_rules').get().c, 1,
    'but it is still there — off is not deleted');

  const offDay = dates.addDays(day, 1);
  const holiday = SCH.availabilityFor(E.barista,
    TCm.localInputToUtc(`${offDay} 16:00`), TCm.localInputToUtc(`${offDay} 22:00`));
  assert.strictEqual(holiday.state, 'unavailable',
    'approved time off is a commitment, and the switch has no authority over it');

  await post('/schedule/availability', { on: '1' });
  db.prepare('DELETE FROM availability_rules').run();
  db.prepare('DELETE FROM time_off_requests').run();
});

test('the switch is refused to an account without the schedule area', async () => {
  // Same gate as every other schedule route. A capability toggle is a scheduling
  // decision, so it lives under the permission that already governs planning
  // rather than growing a tier of its own.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const at = src.indexOf("app.post('/schedule/availability'");
  const body = src.slice(at, src.indexOf('});', at));
  assert.match(body, /navAllowed\('\/schedule'\)/, 'the route checks the area server-side');
  assert.match(body, /403/, 'and refuses rather than redirecting somewhere friendly');
});

// ===========================================================================
// Phase 7 — repeat. One shift, forward.
//
// The property that matters most is that running it twice does not double the
// month. create() deliberately does NOT refuse a duplicate — split shifts and
// doubles are real, and Phase 2 settled that overlaps warn rather than block —
// which is right for one shift made on purpose and wrong for a series, because
// a manager unsure whether the repeat worked will simply run it again.
// ===========================================================================

test('a repeat makes drafts on the right days, and never publishes', async () => {
  const start = dates.addDays(today(), 70);           // clear of every other test's week
  const res = await post('/schedule/shift', {
    employee_id: String(E.barista), position: 'barista', date: start,
    start: '16:00', end: '22:00',
    repeat: '1', repeat_every: '1', repeat_weeks: '3',
  });
  assert.strictEqual(res.status, 302);
  assert.match(flashOf(res).msg, /4 shifts added as drafts/, 'the original plus three');
  assert.match(flashOf(res).msg, /cannot see them yet/i, 'and it says nobody has been told');

  const rows = db.prepare(`SELECT business_date, status FROM scheduled_shifts
    WHERE employee_id = ? AND business_date >= ? ORDER BY business_date`).all(E.barista, start);
  assert.deepStrictEqual(rows.map((r) => r.business_date),
    [start, dates.addDays(start, 7), dates.addDays(start, 14), dates.addDays(start, 21)]);
  assert.ok(rows.every((r) => r.status === 'draft'), 'every one is a draft');
  assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM published_schedule ps
    JOIN scheduled_shifts s ON s.id = ps.scheduled_shift_id WHERE s.business_date >= ?`).get(start).n,
  0, 'and not one of them reached an employee');
});

test('running the same repeat again does not double the month', async () => {
  const start = dates.addDays(today(), 70);
  const before = db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE business_date >= ?').get(start).n;
  const res = await post('/schedule/shift', {
    employee_id: String(E.barista), position: 'barista', date: start,
    start: '16:00', end: '22:00',
    repeat: '1', repeat_every: '1', repeat_weeks: '3',
  });
  assert.match(flashOf(res).msg, /already on the schedule/i, 'it says what it skipped');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE business_date >= ?').get(start).n,
    before, 'and the board is unchanged');
});

test('selected weekdays put one shift on each, from the first week onward', async () => {
  const monday = (() => { let d = dates.addDays(today(), 100);
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = dates.addDays(d, 1); return d; })();
  // Built by hand: a browser sends repeat_days three times, and URLSearchParams
  // would comma-join an array into one value that looks nothing like it.
  const body = new URLSearchParams({
    employee_id: String(E.server), position: 'server', date: monday,
    start: '16:00', end: '22:00',
    repeat: '1', repeat_every: '1', repeat_weeks: '1', _csrf: await token(),
  });
  for (const d of ['1', '3', '5']) body.append('repeat_days', d);
  await fetch(`${BASE}/schedule/shift`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const got = db.prepare(`SELECT business_date FROM scheduled_shifts
    WHERE employee_id = ? AND business_date >= ? ORDER BY business_date`).all(E.server, monday)
    .map((r) => r.business_date);
  // This Mon/Wed/Fri and next Mon/Wed/Fri.
  assert.deepStrictEqual(got, [monday, dates.addDays(monday, 2), dates.addDays(monday, 4),
    dates.addDays(monday, 7), dates.addDays(monday, 9), dates.addDays(monday, 11)]);
});

test('an end date stops the series, and a repeat cannot publish even if asked', async () => {
  const start = dates.addDays(today(), 130);
  const res = await post('/schedule/shift', {
    employee_id: String(E.barista), position: 'barista', date: start,
    start: '10:00', end: '14:00',
    repeat: '1', repeat_every: '1', repeat_until: dates.addDays(start, 15),
    publish: '1',                       // deliberately asking for it
  });
  const rows = db.prepare(`SELECT business_date, status FROM scheduled_shifts
    WHERE employee_id = ? AND business_date >= ? ORDER BY business_date`).all(E.barista, start);
  assert.deepStrictEqual(rows.map((r) => r.business_date),
    [start, dates.addDays(start, 7), dates.addDays(start, 14)], 'it stops at the end date');
  assert.ok(rows.every((r) => r.status === 'draft'),
    'and a series is never published in the same click, however the box was ticked');
});

test('the repeat control exists on the board and only offers whole weeks', async () => {
  const html = await text('/schedule');
  assert.match(html, /id="sb-rep"/, 'the control is there');
  assert.match(html, /name="repeat_days"/, 'with per-weekday selection');
  assert.match(html, /Every one is made as a draft/, 'and says what it will do before you use it');
});

// ===========================================================================
// Phase 7 — shift templates. A saved SHAPE, not a saved shift.
// ===========================================================================

test('a template saves the position and times, and never a person or a day', async () => {
  const res = await post('/schedule/template', {
    name: 'Server Dinner', position: 'server', start: '16:00', end: '22:00',
    break_minutes: '30', break_paid: '0',
  });
  assert.match(flashOf(res).msg, /Saved "Server Dinner"/);
  const t = db.prepare("SELECT * FROM shift_templates WHERE name = 'Server Dinner'").get();
  assert.strictEqual(t.position, 'server');
  assert.strictEqual(t.start_min, 960, '16:00 as minutes from midnight');
  assert.strictEqual(t.end_min, 1320, '22:00');
  assert.strictEqual(t.break_minutes, 30);
  // The two things it must NOT know.
  const cols = db.prepare('PRAGMA table_info(shift_templates)').all().map((c) => c.name);
  assert.ok(!cols.includes('employee_id'), 'a template has no person');
  assert.ok(!cols.some((c) => /date|business_date/.test(c)), 'and no day');
});

test('a close that runs past midnight is one template, not two', async () => {
  await post('/schedule/template', { name: 'Kitchen Close', position: 'kitchen', start: '17:00', end: '01:00' });
  const t = db.prepare("SELECT * FROM shift_templates WHERE name = 'Kitchen Close'").get();
  assert.strictEqual(t.start_min, 1020);
  assert.strictEqual(t.end_min, 60);
  assert.ok(t.end_min <= t.start_min, 'the end being the smaller number IS the overnight case');
});

test('re-saving a name replaces it rather than making a second one', async () => {
  await post('/schedule/template', { name: 'server dinner', position: 'server', start: '16:30', end: '22:00' });
  const rows = db.prepare("SELECT * FROM shift_templates WHERE name = 'Server Dinner' COLLATE NOCASE").all();
  assert.strictEqual(rows.length, 1, 'one name, one shape — two called Dinner is a way to pick the wrong one');
  assert.strictEqual(rows[0].start_min, 990, 'and it is the corrected time');
});

test('a template with no name, or a zero-length shift, is refused with a reason', async () => {
  for (const [body, why] of [
    [{ name: '', position: 'server', start: '16:00', end: '22:00' }, /name/i],
    [{ name: 'Nope', position: 'server', start: '16:00', end: '16:00' }, /same/i],
  ]) {
    const res = await post('/schedule/template', body);
    assert.ok(flashOf(res).err, 'refused');
    assert.match(flashOf(res).msg, why, 'and says which thing was wrong');
  }
});

test('the drawer offers saved templates, and deleting one leaves its shifts alone', async () => {
  const html = await text('/schedule');
  assert.match(html, /id="sb-tmpl"/, 'the picker is there once templates exist');
  assert.match(html, /Server Dinner/, 'and lists them by name');
  assert.match(html, /Save these times as a template/, 'with a way to add another');

  const t = db.prepare("SELECT id FROM shift_templates WHERE name = 'Kitchen Close'").get();
  const shiftsBefore = db.prepare('SELECT COUNT(*) n FROM scheduled_shifts').get().n;
  const res = await post(`/schedule/template/${t.id}/delete`, {});
  assert.match(flashOf(res).msg, /Shifts already made from it are untouched/i);
  assert.ok(!db.prepare('SELECT 1 FROM shift_templates WHERE id = ?').get(t.id), 'the template is gone');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM scheduled_shifts').get().n, shiftsBefore,
    'and not one shift went with it');
});

// ===========================================================================
// Phase 7 — copy a day. copyWeek's smaller sibling, same rules.
// ===========================================================================

test('copying a day reproduces its staffing as drafts on the next one', async () => {
  const from = dates.addDays(today(), 200);
  const to = dates.addDays(from, 1);
  SCH.create({ employeeId: E.server, position: 'server', startsAt: `${from} 16:00`, endsAt: `${from} 22:00` });
  SCH.create({ employeeId: E.barista, position: 'barista', startsAt: `${from} 07:00`, endsAt: `${from} 15:00` });

  const res = await post('/schedule/copy-day', { from, to });
  assert.match(flashOf(res).msg, /2 shifts copied as drafts/);
  assert.match(flashOf(res).msg, /cannot see them yet/i, 'and nobody has been told');
  const rows = db.prepare(`SELECT employee_id, status FROM scheduled_shifts
    WHERE business_date = ? ORDER BY employee_id`).all(to);
  assert.strictEqual(rows.length, 2, 'both people came across');
  assert.ok(rows.every((r) => r.status === 'draft'), 'as drafts');
});

test('copying the same day again adds nothing', async () => {
  const from = dates.addDays(today(), 200);
  const to = dates.addDays(from, 1);
  const before = db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE business_date = ?').get(to).n;
  const res = await post('/schedule/copy-day', { from, to });
  assert.match(flashOf(res).msg, /already there/i);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE business_date = ?').get(to).n,
    before, 'the target day is unchanged');
});

test('copying a day onto itself is refused rather than duplicating it', async () => {
  const d = dates.addDays(today(), 200);
  const before = db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE business_date = ?').get(d).n;
  const res = await post('/schedule/copy-day', { from: d, to: d });
  assert.ok(flashOf(res).err);
  assert.match(flashOf(res).msg, /different day/i);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE business_date = ?').get(d).n, before);
});

test('an overnight shift copies as one piece, keeping its own end', async () => {
  const from = dates.addDays(today(), 210);
  const to = dates.addDays(from, 1);
  // Explicit dates: create() takes what it is given, and it is the ROUTE that
  // rolls an end earlier than its start onto the next day.
  SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${from} 20:00`, endsAt: `${dates.addDays(from, 1)} 02:00` });
  await post('/schedule/copy-day', { from, to });
  const copied = db.prepare(`SELECT starts_at, ends_at, business_date FROM scheduled_shifts
    WHERE business_date = ? AND employee_id = ?`).get(to, E.server);
  assert.ok(copied, 'it came across');
  assert.ok(copied.ends_at > copied.starts_at, 'and its end still follows its start');
  // The night stays in one piece: business date is the day it STARTED.
  assert.strictEqual(copied.business_date, to);
});

test('the day header offers the copy, and never on the last column', async () => {
  const html = await text('/schedule');
  assert.match(html, /action="\/schedule\/copy-day"/, 'the control exists');
  const headers = html.match(/<div class="sb-dh[^"]*">[\s\S]*?<\/div>\s*<\/div>/g) || [];
  assert.ok(headers.length >= 1, 'day headers render');
  // Nothing to copy INTO past the end of the visible week.
  const forms = (html.match(/action="\/schedule\/copy-day"/g) || []).length;
  assert.ok(forms <= 6, `at most six of seven days offer it (found ${forms})`);
});

// ===========================================================================
// Phase 7 — DAY AND WEEK TEMPLATES: a saved staffing configuration.
//
// These hold PEOPLE and shift templates deliberately do not. The audit found
// the roadmap never resolved it — it says copy-week "reproduces the prior
// week's assignments" and calls these a "staffing pattern" — and the owner
// settled it: a shift with no employee IS an open shift, and an open shift
// cannot be claimed until Phase 8, so a structure-only template would produce a
// board of cards nobody can act on.
// ===========================================================================

const P7 = { A: null, B: null, C: null };
const p7wipe = () => {
  db.prepare('DELETE FROM schedule_templates').run();
  for (const r of db.prepare("SELECT id FROM scheduled_shifts WHERE created_by LIKE 'p7%' OR business_date >= ?")
    .all(dates.addDays(today(), 250))) {
    db.prepare('DELETE FROM published_schedule WHERE scheduled_shift_id = ?').run(r.id);
    db.prepare('DELETE FROM scheduled_breaks WHERE scheduled_shift_id = ?').run(r.id);
    db.prepare('DELETE FROM scheduled_shifts WHERE id = ?').run(r.id);
  }
};

test('P7 setup: three people with real positions', () => {
  const ins = db.prepare("INSERT INTO employees (name,role,hourly_rate_cents,active,pin) VALUES (?,?,1500,1,?)");
  P7.A = Number(ins.run('P7 Ann', 'server', '6101').lastInsertRowid);
  P7.B = Number(ins.run('P7 Ben', 'barista', '6102').lastInsertRowid);
  P7.C = Number(ins.run('P7 Cal', 'server', '6103').lastInsertRowid);
  const role = db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,1500)');
  role.run(P7.A, 'server'); role.run(P7.B, 'barista'); role.run(P7.C, 'server');
  assert.ok(P7.A && P7.B && P7.C);
});

test('a DAY template saves who works, with no calendar date anywhere in it', async () => {
  p7wipe();
  const src = dates.addDays(today(), 260);
  SCH.create({ employeeId: P7.A, position: 'server', startsAt: `${src} 16:00`, endsAt: `${src} 22:00` });
  SCH.create({ employeeId: P7.B, position: 'barista', startsAt: `${src} 07:00`, endsAt: `${src} 15:00` });

  const res = await post('/schedule/save-day-template', { name: 'Typical Friday', from: src });
  assert.match(flashOf(res).msg, /Saved "Typical Friday"/);
  assert.match(flashOf(res).msg, /with who works them/i, 'and it says people are included');

  const t = db.prepare("SELECT * FROM schedule_templates WHERE name='Typical Friday'").get();
  assert.strictEqual(t.kind, 'day');
  const rows = db.prepare('SELECT * FROM schedule_template_rows WHERE template_id = ?').all(t.id);
  assert.strictEqual(rows.length, 2, 'both shifts saved');
  assert.deepStrictEqual(rows.map((r) => r.employee_id).sort(), [P7.A, P7.B].sort(),
    'ASSIGNMENTS PRESERVED — this is the whole decision');
  assert.ok(rows.every((r) => r.day_offset === 0), 'a day template is all one day');

  // Relative, never a stored source date.
  const cols = db.prepare('PRAGMA table_info(schedule_template_rows)').all().map((c) => c.name);
  assert.ok(!cols.some((c) => /^(business_)?date$|starts_at|ends_at/.test(c)),
    'no calendar date and no instant is stored');
  assert.ok(cols.includes('day_offset'), 'only a relative offset');
});

test('a WEEK template stores seven relative days, not the source week', async () => {
  const wkStart = SCH.weekWindowFor(dates.addDays(today(), 260)).start;
  const third = dates.addDays(wkStart, 3);
  SCH.create({ employeeId: P7.C, position: 'server', startsAt: `${third} 20:00`, endsAt: `${dates.addDays(third, 1)} 02:00` });

  const res = await post('/schedule/save-week-template', { name: 'Normal Week', from: wkStart });
  assert.match(flashOf(res).msg, /Saved "Normal Week"/);
  const t = db.prepare("SELECT * FROM schedule_templates WHERE name='Normal Week'").get();
  const rows = db.prepare('SELECT * FROM schedule_template_rows WHERE template_id = ? ORDER BY day_offset').all(t.id);
  assert.ok(rows.length >= 3, 'the whole week came across');
  assert.ok(rows.every((r) => r.day_offset >= 0 && r.day_offset <= 6), 'offsets are 0-6');
  assert.ok(rows.some((r) => r.day_offset > 0), 'and they really are relative to the week start');
});

test('applying a template creates DRAFTS, tells nobody, and touches nothing actual', async () => {
  const t = db.prepare("SELECT id FROM schedule_templates WHERE name='Normal Week'").get();
  const target = SCH.weekWindowFor(dates.addDays(today(), 300)).start;
  const before = {
    published: db.prepare('SELECT COUNT(*) n FROM published_schedule').get().n,
    portalEvents: db.prepare('SELECT COUNT(*) n FROM portal_events').get().n,
    entries: db.prepare('SELECT COUNT(*) n FROM time_entries').get().n,
    work: db.prepare('SELECT COUNT(*) n FROM work').get().n,
    services: db.prepare('SELECT COUNT(*) n FROM shifts').get().n,
  };
  const res = await post('/schedule/apply-template', { id: String(t.id), to: target });
  assert.match(flashOf(res).msg, /added as drafts/);
  assert.match(flashOf(res).msg, /cannot see them yet/i);

  const made = db.prepare('SELECT * FROM scheduled_shifts WHERE business_date >= ?').all(target);
  assert.ok(made.length >= 3, 'shifts landed');
  assert.ok(made.every((r) => r.status === 'draft'), 'every one a draft');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM published_schedule').get().n, before.published,
    'nothing published');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM portal_events').get().n, before.portalEvents,
    'nobody notified');
  for (const [k, v] of Object.entries(before)) {
    if (k === 'published' || k === 'portalEvents') continue;
    assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM ${k === 'services' ? 'shifts' : k === 'entries' ? 'time_entries' : k}`).get().n,
      v, `${k} untouched — a plan never writes what happened`);
  }
});

test('the same people come back, on the right relative days', async () => {
  const target = SCH.weekWindowFor(dates.addDays(today(), 300)).start;
  const rows = db.prepare(`SELECT employee_id, business_date, position FROM scheduled_shifts
    WHERE business_date >= ? ORDER BY business_date`).all(target);
  assert.ok(rows.some((r) => r.employee_id === P7.A), 'Ann came back');
  assert.ok(rows.some((r) => r.employee_id === P7.B), 'Ben came back');
  const cal = rows.find((r) => r.employee_id === P7.C);
  assert.ok(cal, 'Cal came back');
  assert.strictEqual(cal.business_date, dates.addDays(target, 3),
    'and on the same RELATIVE day, three into the new week');
});

test('applying the same template again adds nothing', async () => {
  const t = db.prepare("SELECT id FROM schedule_templates WHERE name='Normal Week'").get();
  const target = SCH.weekWindowFor(dates.addDays(today(), 300)).start;
  const before = db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE business_date >= ?').get(target).n;
  const res = await post('/schedule/apply-template', { id: String(t.id), to: target });
  assert.match(flashOf(res).msg, /already there/i, 'it says what it skipped');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE business_date >= ?').get(target).n,
    before, 'and the week is unchanged');
});

test('a leaver and a lost position are skipped by NAME; everyone else still lands', async () => {
  const t = db.prepare("SELECT id FROM schedule_templates WHERE name='Normal Week'").get();
  const target = SCH.weekWindowFor(dates.addDays(today(), 340)).start;
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(P7.A);
  db.prepare('DELETE FROM employee_roles WHERE employee_id = ? AND role = ?').run(P7.C, 'server');
  db.prepare("UPDATE employees SET role = 'busser' WHERE id = ?").run(P7.C);
  try {
    const res = await post('/schedule/apply-template', { id: String(t.id), to: target });
    const msg = flashOf(res).msg;
    assert.match(msg, /P7 Ann \(no longer active\)/, 'the leaver is named, not counted');
    assert.match(msg, /P7 Cal \(no longer works server\)/, 'and so is the lost position');
    assert.match(msg, /Nobody was put in their place/i, 'NO SUBSTITUTION, and it says so');

    const landed = db.prepare('SELECT * FROM scheduled_shifts WHERE business_date >= ?').all(target);
    assert.ok(landed.length >= 1, 'one stale row did not sink the rest');
    assert.ok(landed.some((r) => r.employee_id === P7.B), 'Ben still applied');
    assert.ok(!landed.some((r) => r.employee_id === P7.A || r.employee_id === P7.C), 'the two stale ones did not');
    assert.strictEqual(landed.filter((r) => r.employee_id == null).length, 0,
      'NO OPEN-SHIFT FALLBACK — an unassignable card is worse than an honest gap');
  } finally {
    db.prepare('UPDATE employees SET active = 1 WHERE id = ?').run(P7.A);
    db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,1500)').run(P7.C, 'server');
  }
});

test('the board is dense on a mouse without shrinking a finger target', () => {
  // The owner asked for a much more compact board: the toolbar was wrapping to
  // two rows and only nine of a 150-person roster fit on a laptop screen. The
  // space was going to two 44px touch targets — .sb-btn's height and .sb-add's
  // min-height — plus two day-header buttons that were opacity:0 but still in
  // flow, reserving ~44px per column for something invisible.
  //
  // 44px is CORRECT on a phone. The whole compaction is therefore guarded on a
  // fine pointer, and that guard is the part worth pinning: drop it and the
  // board silently becomes untappable on the device half the staff use.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');

  assert.match(css, /\.sb-btn \{[^}]*height:44px/,
    'the unguarded button keeps the 44px touch target');
  assert.match(css, /\.sb-add \{[^}]*min-height:44px/,
    'and so does the add-shift cell');

  const guard = /@media \(min-width:900px\) and \(pointer:fine\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(guard, 'the compaction lives behind a fine-pointer guard');
  assert.match(guard[1], /\.sb-bar \.sb-btn \{[^}]*height:30px/,
    'which is where the smaller button belongs');
  assert.match(guard[1], /\.sb-add \{[^}]*min-height:28px/,
    'and the smaller add target');

  // Out of flow, so an invisible control costs no height.
  assert.match(css, /\.sb-dh-acts \{[^}]*position: absolute/,
    'the hover actions do not reserve space in the day header');
  // And .sb-dh must NOT be given position:relative to host them: it is already
  // sticky, and a later `position` declaration un-sticks the date row. That
  // shipped once and only showed up on scroll.
  const dhRules = css.split('\n').filter((l) => /^\.sb-dh \{/.test(l)).join('');
  assert.doesNotMatch(dhRules, /position: ?relative/,
    'the day header stays sticky');
});

test('the two kinds of template stay different objects', async () => {
  // A shift template is a SHAPE with nobody in it. A day/week template is a
  // CONFIGURATION OF PEOPLE. Keeping them apart is the product decision.
  const shape = db.prepare('PRAGMA table_info(shift_templates)').all().map((c) => c.name);
  const config = db.prepare('PRAGMA table_info(schedule_template_rows)').all().map((c) => c.name);
  assert.ok(!shape.includes('employee_id'), 'a shift template holds no person');
  assert.ok(config.includes('employee_id'), 'a day/week template does');
  const html = await text('/schedule');
  // The WEEK save button was taken off the toolbar at the owner's request (it
  // crowded Copy last week and Publish week for a once-a-month job). The route
  // still works — tested above — so this pins the removal rather than the loss
  // of the capability. Saving a DAY is still offered, on each day header.
  assert.doesNotMatch(html, /Save week as pattern/, 'the week-save button is off the toolbar');
  assert.match(html, /Save as pattern/, 'saving a day still is');
  assert.match(html, /Apply a pattern/, 'and applying one');
});

// ===========================================================================
// Phase 11 — drag a shift to another day.
//
// The rule the roadmap sets for this phase is the one worth testing: every drop
// runs the same domain command and validation as an ordinary edit, and DOM
// position is never the source of truth. So these tests never simulate a drag —
// they post what a drop posts, which is a DAY, and check the domain behaved.
// ===========================================================================

test('a drop moves the shift to that day, keeping its times and its length', async () => {
  const from = dates.addDays(today(), 400);
  const to = dates.addDays(from, 2);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${from} 16:00`, endsAt: `${from} 22:00` });
  const res = await post(`/schedule/shift/${s.id}/move`, { to_date: to });
  assert.strictEqual(res.status, 302);
  assert.match(flashOf(res).msg, /Moved/i);

  const moved = SCH.byId(s.id);
  assert.strictEqual(moved.business_date, to, 'it is on the new day');
  assert.strictEqual(moved.starts_at.slice(11), s.starts_at.slice(11), 'same clock time');
  assert.strictEqual(
    Date.parse(moved.ends_at.replace(' ', 'T') + 'Z') - Date.parse(moved.starts_at.replace(' ', 'T') + 'Z'),
    Date.parse(s.ends_at.replace(' ', 'T') + 'Z') - Date.parse(s.starts_at.replace(' ', 'T') + 'Z'),
    'and exactly as long as it was');
});

test('an overnight shift keeps its own end when dragged', async () => {
  const from = dates.addDays(today(), 410);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${from} 20:00`, endsAt: `${dates.addDays(from, 1)} 02:00` });
  const to = dates.addDays(from, 3);
  await post(`/schedule/shift/${s.id}/move`, { to_date: to });
  const moved = SCH.byId(s.id);
  assert.strictEqual(moved.business_date, to);
  assert.ok(moved.ends_at > moved.starts_at, 'the end still follows the start');
  assert.strictEqual(moved.ends_at.slice(0, 10), dates.addDays(to, 1),
    'and still lands on the following morning — the night moved in one piece');
});

test('a drop onto the cell it came from writes nothing at all', async () => {
  // Not an error, and not an edit either: an edit here would stamp
  // changed_after_publish and tell the floor a published shift moved.
  const day = dates.addDays(today(), 420);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  const before = SCH.byId(s.id);
  const res = await post(`/schedule/shift/${s.id}/move`, { to_date: day });
  assert.strictEqual(res.status, 302, 'it answers');
  assert.ok(!flashOf(res).err, 'and does not complain');
  assert.deepStrictEqual(SCH.byId(s.id), before, 'the row is byte-for-byte what it was');
});

test('a drop runs the SAME validation as an ordinary edit', async () => {
  // The whole roadmap rule for this phase. A drag that could place a shift an
  // ordinary edit would refuse is a hole, and a silent one.
  const day = dates.addDays(today(), 430);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  const before = SCH.byId(s.id);

  // Deactivate them, then try to drag their shift.
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(E.server);
  try {
    const res = await post(`/schedule/shift/${s.id}/move`, { to_date: dates.addDays(day, 1) });
    assert.ok(flashOf(res).err, 'refused');
    assert.match(flashOf(res).msg, /Not moved/i, 'and it says nothing happened');
    assert.deepStrictEqual(SCH.byId(s.id), before,
      'the shift did not move — the card is where it was because nothing changed');
  } finally {
    db.prepare('UPDATE employees SET active = 1 WHERE id = ?').run(E.server);
  }
});

test('a drop never writes a punch, an hour or a service', async () => {
  const day = dates.addDays(today(), 440);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const before = ['time_entries', 'time_breaks', 'work', 'shifts'].map(count);
  await post(`/schedule/shift/${s.id}/move`, { to_date: dates.addDays(day, 1) });
  assert.deepStrictEqual(['time_entries', 'time_breaks', 'work', 'shifts'].map(count), before,
    'moving a plan touches nothing that actually happened');
});

test('the board makes cards draggable and cells droppable, and still opens the drawer', async () => {
  const html = await text('/schedule');
  assert.match(html, /draggable="true" data-drag="\d+"/, 'cards can be picked up');
  assert.match(html, /data-cell="1" data-emp="\d+" data-d="\d{4}-\d{2}-\d{2}"/,
    'and every cell knows which person and day it is');
  // Dragging is a shortcut, never the only way in. The click path is the
  // keyboard and screen-reader path and has to survive.
  assert.match(html, /data-edit="\d+"/, 'the card still opens the drawer on click');
  // The drop builds its form in script, so what is asserted is the script.
  assert.match(html, /\/schedule\/shift\/' \+ dragId \+ '\/move/,
    'and the drop posts to a real route rather than moving anything locally');
});

// --- Phase 11, the rest: dragging to another person -------------------------

test('dragging down a column reassigns the shift, keeping its day and times', async () => {
  const day = dates.addDays(today(), 460);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  // E.multi holds server as well, so this is a legal reassignment.
  const res = await post(`/schedule/shift/${s.id}/move`, { to_date: day, to_employee: String(E.multi) });
  assert.ok(!flashOf(res).err, `it moved: ${flashOf(res).msg}`);
  assert.match(flashOf(res).msg, /Moved to/i, 'and says who it went to');

  const moved = SCH.byId(s.id);
  assert.strictEqual(moved.employee_id, E.multi, 'the new person owns it');
  assert.strictEqual(moved.business_date, day, 'the day did not change');
  assert.strictEqual(moved.starts_at, s.starts_at, 'nor the times');
  assert.strictEqual(moved.position, s.position, 'nor the position');
});

test('a diagonal drag changes the person AND the day in one move', async () => {
  const day = dates.addDays(today(), 470);
  const to = dates.addDays(day, 3);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  const res = await post(`/schedule/shift/${s.id}/move`, { to_date: to, to_employee: String(E.multi) });
  assert.ok(!flashOf(res).err);
  // The message names both, because saying only one reads like half of it failed.
  assert.match(flashOf(res).msg, /Moved to/i);
  const moved = SCH.byId(s.id);
  assert.strictEqual(moved.employee_id, E.multi);
  assert.strictEqual(moved.business_date, to);
});

test('dropping on somebody who does not hold the position is refused, and nothing moves', async () => {
  // The same rule the drawer enforces. A drag that could place a shift an
  // ordinary edit would refuse is a hole, and a silent one.
  const day = dates.addDays(today(), 480);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  const before = SCH.byId(s.id);
  const res = await post(`/schedule/shift/${s.id}/move`,
    { to_date: day, to_employee: String(E.barista) });   // barista does not do server
  assert.ok(flashOf(res).err, 'refused');
  assert.match(flashOf(res).msg, /Not moved/i);
  assert.deepStrictEqual(SCH.byId(s.id), before, 'and the shift is exactly where it was');
});

test('dropping on an inactive employee is refused', async () => {
  const day = dates.addDays(today(), 490);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  const before = SCH.byId(s.id);
  const res = await post(`/schedule/shift/${s.id}/move`, { to_date: day, to_employee: String(E.gone) });
  assert.ok(flashOf(res).err, 'refused');
  assert.deepStrictEqual(SCH.byId(s.id), before, 'nothing moved');
});

test('a reassignment onto an overlapping shift warns but still moves', async () => {
  // Warn, never block — the rule every phase before this settled on.
  const day = dates.addDays(today(), 500);
  SCH.create({ employeeId: E.multi, position: 'server',
    startsAt: `${day} 17:00`, endsAt: `${day} 21:00` });
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  const res = await post(`/schedule/shift/${s.id}/move`, { to_date: day, to_employee: String(E.multi) });
  assert.ok(!flashOf(res).err, 'it still moves');
  assert.match(flashOf(res).msg, /overlaps/i, 'and the manager is told');
  assert.strictEqual(SCH.byId(s.id).employee_id, E.multi);
});

// ===========================================================================
// The "..." menu on a card, and the no-reload write path.
//
// Four actions live behind one trigger: Duplicate, Multi duplicate, Unpublish,
// Delete. Every one of them posts to a route that already existed and already
// had tests — what is new is the trigger, the count, and the fact that none of
// them reload the document. So these test the parts that are genuinely new,
// and lean on the existing route tests for the rest.
// ===========================================================================

test('every card carries an actions trigger, and it is not nested in the card button', async () => {
  const day = dates.addDays(week().start, 2);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  const html = await text('/schedule');
  assert.match(html, new RegExp(`data-dots="${s.id}"`), 'the shift has a trigger');
  // A <button> inside a <button> is not a thing browsers agree on, so the
  // trigger is a SIBLING inside .sbk-w. If that ever collapses back into the
  // card, dragging from the dots starts a drag and the menu stops opening.
  assert.match(html, /<div class="sbk-w">\s*<button class="sbk /,
    'the card and its trigger are siblings in a wrapper');
  // Asserted as "the card CLOSES before the trigger opens". A doesNotMatch on
  // the two appearing in sequence passes whatever the nesting is, because the
  // sibling layout puts them in sequence too — it proved nothing.
  assert.match(html, /<button class="sbk [\s\S]*?<\/button>\s*<button class="sbk-dots/,
    'the trigger is never inside the card button');
});

test('the menu offers exactly the four actions, and sits outside the scrolling box', async () => {
  const html = await text('/schedule');
  for (const act of ['duplicate', 'multi', 'unpublish', 'delete']) {
    assert.match(html, new RegExp(`data-act="${act}"`), `the menu offers ${act}`);
  }
  // Nothing else. The reference this was built from carries Select, Assign,
  // Allocate and Start chat as well; the owner asked for four, and a menu that
  // grows on its own is how a two-click action becomes a five-click one.
  const acts = [...html.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(acts)].sort(),
    ['delete', 'duplicate', 'multi', 'multi-go', 'unpublish'],
    'and nothing beyond them (multi-go is the submenu button)');

  // Inside .sb-scroll it would be clipped by overflow:auto at the right-hand
  // edge of the week — the classic way this control ships half-drawn.
  const menuAt = html.indexOf('id="sb-menu"');
  const scrollAt = html.indexOf('class="sb-scroll');
  assert.ok(menuAt > -1 && scrollAt > -1 && menuAt < scrollAt,
    'the menu is rendered before the scrolling box, not inside it');
});

test('multi duplicate makes exactly the number asked for, and refuses to be told a silly one', async () => {
  // A day of its own. Sharing one with another test makes the counts below
  // depend on the order the file happens to run in.
  const day = dates.addDays(week().start, 271);
  const mk = () => SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 09:00`, endsAt: `${day} 13:00` });
  const count = () => SCH.inRange(day, day).filter((r) => r.status !== 'cancelled').length;

  const a = mk();
  assert.strictEqual(count(), 1);
  await post(`/schedule/shift/${a.id}/duplicate`, { count: '3', w: week().start });
  assert.strictEqual(count(), 4, 'three copies joined the original');

  // The field is a text box on a menu. A slip of the keyboard should cost a
  // wasted click, not two hundred drafts to undo one at a time.
  const b = mk();
  const before = count();
  await post(`/schedule/shift/${b.id}/duplicate`, { count: '500', w: week().start });
  assert.strictEqual(count(), before + 20, 'clamped to twenty, not five hundred');

  // Junk and absence both mean "once", which is what the plain Duplicate item
  // posts and what every caller before this change relied on.
  const c = mk();
  const was = count();
  await post(`/schedule/shift/${c.id}/duplicate`, { count: 'lots', w: week().start });
  assert.strictEqual(count(), was + 1, 'nonsense means once');
  const d = mk();
  const was2 = count();
  await post(`/schedule/shift/${d.id}/duplicate`, { w: week().start });
  assert.strictEqual(count(), was2 + 1, 'and so does saying nothing');

  const e = mk();
  const was3 = count();
  await post(`/schedule/shift/${e.id}/duplicate`, { count: '0', w: week().start });
  assert.strictEqual(count(), was3 + 1, 'zero is not a way to make nothing happen quietly');
});

test('a board action posts with fetch and swaps regions, rather than reloading', async () => {
  const html = await text('/schedule');
  // The whole point of the change: the drop and the menu stopped submitting
  // forms. If this reverts to f.submit() the page blinks again and the scroll
  // position goes with it.
  assert.match(html, /function sbPost\(/, 'there is one write path');
  assert.match(html, /fetch\(action, \{/, 'and it posts with fetch');
  assert.match(html, /SB_REGIONS = \['\.sb-bar', '\.sb-grid', '\.sb-sum', '#sb-data', '#sb-flash'\]/,
    'swapping the regions the server just re-rendered');
  // The elements themselves survive, which is what keeps the delegated
  // listeners bound and the scroll box scrolled.
  assert.match(html, /to\.innerHTML = from\.innerHTML/, 'by innerHTML, so the elements stay');
  // Scroll is restored explicitly, because an empty grid clamps it to zero
  // mid-swap. Measured: 120px became 72px on a box that could hold 295.
  assert.match(html, /void sc\.scrollHeight;/, 'after forcing the pending layout');
  assert.match(html, /sc\.scrollTop = top;/, 'the scroll position is put back');
});

test('the drop carries the target person as well as the target day', async () => {
  const html = await text('/schedule');
  // The drop posts through sbPost now instead of building a form, so these
  // are object keys rather than array pairs. What is asserted is unchanged:
  // BOTH fields travel on every drop, and moveShift ignores whichever did not
  // change — that is what keeps a row-drag, a column-drag and a diagonal one
  // from each needing their own special case.
  assert.match(html, /to_employee: cell\.getAttribute\('data-emp'\)/,
    'so dragging down a column is a reassignment, with no special case');
  assert.match(html, /to_date: cell\.getAttribute\('data-d'\)/,
    'and dragging along a row is a day move');
});

// ===========================================================================
// Unavailability where a manager can see it, and a board that stays legible
// while you scroll it.
// ===========================================================================

test('a day somebody cannot work says so IN THE CELL, with the times', async () => {
  // Far enough out that no other test in this file has put a shift there — a
  // cell with a card in it renders the card, not the Add button.
  // Anchored to the START of a week, not to an offset from today. Both rules
  // have to land in the ONE week this test renders, and "today + 602" only
  // does that on six days in seven: when today is a Sunday that date is the
  // last column of its week, so day+1 belongs to the next week and never
  // appears. The Monday-start change made a Sunday the end of a week rather
  // than the beginning, which turned a passing test into one that fails one
  // day a week — and it did, the first Sunday after it shipped.
  const week602 = SCH.weekWindowFor(dates.addDays(today(), 602));
  const day = week602.start;
  const timed = dates.addDays(day, 1);
  db.prepare(`INSERT INTO availability_rules (employee_id, avail_kind, on_date, all_day)
              VALUES (?, 'unavailable', ?, 1)`).run(E.server, day);
  db.prepare(`INSERT INTO availability_rules (employee_id, avail_kind, on_date, all_day, start_min, end_min)
              VALUES (?, 'unavailable', ?, 0, ?, ?)`).run(E.server, timed, 17 * 60, 22 * 60);
  try {
    const html = await text(`/schedule?w=${SCH.weekWindowFor(day).start}`);
    assert.match(html, /class="sb-un sb-un--cannot"/, 'the cell carries a block of its own');
    assert.match(html, /<b>Unavailable<\/b><i>All day<\/i>/, 'an all-day rule says all day');
    assert.match(html, /<b>Unavailable<\/b><i>5p – 10p<\/i>/,
      'and a timed one says WHEN — "Unavailable" over a day somebody is only out '
      + 'for the evening tells a manager to leave the whole day alone');
    assert.match(html, /class="sb-cell[^"]*sb-cell--un/, 'and the cell itself is marked');
  } finally { db.prepare('DELETE FROM availability_rules').run(); }
});

test('the cell still offers Add — availability warns, it never blocks', async () => {
  const day = dates.addDays(today(), 602);
  db.prepare(`INSERT INTO availability_rules (employee_id, avail_kind, on_date, all_day)
              VALUES (?, 'unavailable', ?, 1)`).run(E.server, day);
  try {
    const html = await text(`/schedule?w=${SCH.weekWindowFor(day).start}`);
    // The Add button for that person on that day, found by its own label rather
    // than by slicing the cell out of the markup.
    assert.match(html, new RegExp(`data-new="1" data-emp="${E.server}" data-d="${day}"`),
      'a manager may still place a shift there');
    assert.match(html, /who said they cannot work/,
      'and the button says so, so it is not a silent override');
  } finally { db.prepare('DELETE FROM availability_rules').run(); }
});

test('a shift on a day they cannot work is flagged on the card itself', async () => {
  const day = dates.addDays(today(), 610);
  const s = SCH.create({ employeeId: E.server, position: 'server',
    startsAt: `${day} 16:00`, endsAt: `${day} 22:00` });
  db.prepare(`INSERT INTO availability_rules (employee_id, avail_kind, on_date, all_day)
              VALUES (?, 'unavailable', ?, 1)`).run(E.server, day);
  try {
    const html = await text(`/schedule?w=${SCH.weekWindowFor(day).start}`);
    assert.match(html, new RegExp(`sbk--iss-review[^"]*"[^>]*data-drag="${s.id}"`),
      'the card carries the issue marker');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
    const rule = css.slice(css.indexOf('.sbk--iss-action, .sbk--iss-review'));
    assert.match(rule.slice(0, 400), /border:\s*1\.5px solid var\(--danger\)/, 'a red edge');
    assert.match(rule.slice(0, 700), /content:\s*'!'/, 'and a corner flag, not colour alone');
  } finally { db.prepare('DELETE FROM availability_rules').run(); }
});

test('the grid scrolls, and everything you navigate by holds still', () => {
  // Before this the PAGE scrolled, so the week range, Publish week and the day
  // headers all left the screen — checking which day a column was meant
  // scrolling back to the top. .sb-dh already said position:sticky and it did
  // nothing, because nothing above it scrolled in the Y axis.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  const at = css.indexOf('@media (min-width: 900px)');
  assert.ok(at > -1, 'the wide-screen block exists');
  const block = css.slice(at, at + 1400);
  assert.match(block, /\.sb-scroll \{ overflow:auto/, 'the grid is its own scroller');
  assert.match(block, /max-height:calc\(100vh/, 'bounded by the viewport, not a fixed guess');
  // Stacking, which was measured wrong once: names painted over the headers.
  assert.match(block, /\.sb-dh \{ z-index:5; \}/, 'headers outrank the names column');
  assert.match(block, /\.sb-corner \{ position:sticky; top:0; left:0; z-index:6; \}/,
    'and the corner outranks both — it is the one cell holding against two axes');
});
