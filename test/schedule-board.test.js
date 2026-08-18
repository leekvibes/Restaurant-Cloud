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
  // Phase 3 added three: publish-week, publish, unpublish. Every route that can
  // change a draft OR what an employee sees asks the same question the sidebar
  // does, so a hidden link is also a closed door.
  assert.strictEqual(guards, 8, `all eight write routes call the guard (found ${guards})`);
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
  assert.match(html, /var wkMins = \{/, 'the week minutes reach the page');
  assert.match(html, /id="sb-ctx"/, 'and there is somewhere to say it');

  // Same source as the row, so the drawer and the grid cannot disagree.
  const mins = JSON.parse(/var wkMins = (\{.*?\});/.exec(html)[1]);
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
  assert.ok(date >= 17 && date <= 19, `date is ${date}px, in the agreed range`);

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
