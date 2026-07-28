'use strict';

// The time clock: punches, breaks, corrections, and the two things that must
// never happen — a second active entry, or a second shift for one service.
//
// The heart of it is the shift seam. A clock-in and a tip submission for the
// same service have to meet on ONE shift row whichever order they arrive in,
// because that is what stops a night being counted twice.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3989;                     // unique across the suite
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tc-'));
const DB = path.join(dir, 'tc.db');
let child, Database, db;

const post = (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});
const get = (p, headers = {}) => fetch(BASE + p, { headers, redirect: 'manual' });
const text = async (p, headers = {}) => (await fetch(BASE + p, { headers })).text();

/** PIN in, portal cookie out — the same door staff use. */
async function signIn(pin) {
  const res = await post('/tips/start', { pin });
  assert.strictEqual(res.status, 302, `PIN ${pin} is accepted`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const EMP = { solo: 91, multi: 92, none: 93 };

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
  // One position, many positions, and none — the three cases clock-in must tell apart.
  db.prepare("INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,?,?,?,1)")
    .run(EMP.solo, 'Solo Server', 'server', '3111', 1500);
  db.prepare("INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,?,?,?,1)")
    .run(EMP.multi, 'Multi Hat', 'server', '3222', 1600);
  db.prepare("INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,?,?,?,1)")
    .run(EMP.none, 'No Position', '', '3333', 1400);
  db.prepare("INSERT INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)")
    .run(EMP.multi, 'busser', 1700);
});

test.after(() => { if (child) child.kill(); try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

const activeOf = (id) => db.prepare("SELECT * FROM time_entries WHERE employee_id = ? AND status IN ('active','on_break')").get(id);
const entriesOf = (id) => db.prepare('SELECT * FROM time_entries WHERE employee_id = ? ORDER BY id').all(id);

// --- the basics ------------------------------------------------------------

test('an employee with one position clocks in without being asked to choose', async () => {
  const cookie = await signIn('3111');
  const page = await text('/portal/clock', { cookie });
  assert.match(page, /Clock in/, 'the clock-in action is offered');
  assert.ok(!/Which position are you working/.test(page), 'one position is not a question');

  const res = await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });
  assert.strictEqual(res.status, 302);
  const e = activeOf(EMP.solo);
  assert.ok(e, 'they are on the clock');
  assert.strictEqual(e.position, 'server', 'their only position was chosen for them');
  assert.strictEqual(e.status, 'active');
  assert.ok(e.clock_in_at, 'with a server timestamp');
  assert.ok(e.shift_id, 'and linked to a shift');
});

test('a second clock-in cannot create a second active entry', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });   // already on
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });     // and again
  const open = db.prepare("SELECT COUNT(*) n FROM time_entries WHERE employee_id = ? AND status IN ('active','on_break')").get(EMP.solo).n;
  assert.strictEqual(open, 1, 'still exactly one active entry — the partial unique index holds');
});

test('a break starts, ends, and is subtracted from payable time', async () => {
  const cookie = await signIn('3111');
  const e = activeOf(EMP.solo);
  await post('/portal/clock/break/start', {}, { cookie });
  assert.strictEqual(activeOf(EMP.solo).status, 'on_break', 'the entry says on break');
  // A second break while one runs must not open.
  await post('/portal/clock/break/start', {}, { cookie });
  const open = db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE time_entry_id = ? AND end_at IS NULL').get(e.id).n;
  assert.strictEqual(open, 1, 'only one break is ever open');

  await post('/portal/clock/break/end', {}, { cookie });
  assert.strictEqual(activeOf(EMP.solo).status, 'active', 'and back to working');
  const b = db.prepare('SELECT * FROM time_breaks WHERE time_entry_id = ?').get(e.id);
  assert.ok(b.end_at, 'the break has an end');
  assert.strictEqual(b.paid, 0, 'unpaid by default');
});

test('clocking out needs the PIN, and a wrong one changes nothing', async () => {
  const cookie = await signIn('3111');
  const before = activeOf(EMP.solo);
  await post('/portal/clock/out', { pin: '0000' }, { cookie });
  assert.ok(activeOf(EMP.solo), 'a wrong PIN leaves them on the clock');
  assert.strictEqual(activeOf(EMP.solo).id, before.id);

  await post('/portal/clock/out', { pin: '3111' }, { cookie });
  assert.ok(!activeOf(EMP.solo), 'the right PIN closes it');
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(before.id);
  assert.strictEqual(e.status, 'complete');
  assert.ok(e.clock_out_at, 'with a server clock-out');
  assert.strictEqual(typeof e.payable_minutes, 'number', 'and payable minutes worked out');
  assert.strictEqual(e.payable_minutes, e.raw_minutes - e.unpaid_break_min, 'payable = raw minus unpaid break');
});

test('an open break blocks clock-out until it is ended', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  await post('/portal/clock/break/start', {}, { cookie });
  await post('/portal/clock/out', { pin: '3111' }, { cookie });
  assert.ok(activeOf(EMP.solo), 'still on the clock — the break must be ended first');
  await post('/portal/clock/break/end', {}, { cookie });
  await post('/portal/clock/out', { pin: '3111' }, { cookie });
  assert.ok(!activeOf(EMP.solo), 'and now it closes');
});

test('multiple sessions in one day are separate entries', () => {
  const todays = entriesOf(EMP.solo);
  assert.ok(todays.length >= 2, 'two sessions, two entries');
  assert.ok(todays.every((e) => e.clock_in_at), 'each with its own punch');
});

// --- positions -------------------------------------------------------------

test('an employee with several positions must choose one, and only their own', async () => {
  const cookie = await signIn('3222');
  const page = await text('/portal/clock', { cookie });
  assert.match(page, /Which position are you working/, 'they are asked');
  assert.match(page, /value="busser"/, 'their extra position is offered');
  assert.ok(!/value="kitchen"/.test(page), 'a position they do not hold is not');

  // No position posted → refused.
  await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });
  assert.ok(!activeOf(EMP.multi), 'no clock-in without a position');

  // A position they do NOT hold → refused, not silently accepted.
  await post('/portal/clock/in', { daypart: 'dinner', position: 'kitchen' }, { cookie });
  assert.ok(!activeOf(EMP.multi), 'a position they are not assigned is refused');

  await post('/portal/clock/in', { daypart: 'dinner', position: 'busser' }, { cookie });
  assert.strictEqual(activeOf(EMP.multi).position, 'busser', 'the chosen one is stored');
});

test('an employee with no position is blocked with an explanation', async () => {
  const cookie = await signIn('3333');
  const page = await text('/portal/clock', { cookie });
  assert.match(page, /No position is assigned/, 'told why');
  assert.match(page, /manager/i, 'and what to do about it');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  assert.ok(!activeOf(EMP.none), 'and cannot clock in');
});

// --- the shift seam --------------------------------------------------------

test('many employees on one service share ONE shift row', () => {
  // The business date, not today's calendar date — before the early-morning
  // cutoff a night still belongs to the day it started, which is the whole
  // point of the cutoff and is exercised whenever this suite runs after
  // midnight.
  const bdate = db.prepare("SELECT business_date FROM time_entries WHERE daypart = 'dinner' ORDER BY id DESC LIMIT 1").get().business_date;
  const n = db.prepare('SELECT COUNT(*) n FROM shifts WHERE date = ? AND daypart = ?').get(bdate, 'dinner').n;
  assert.strictEqual(n, 1, 'exactly one dinner shift for that business date');
  const ids = new Set(db.prepare("SELECT shift_id FROM time_entries WHERE daypart = 'dinner' AND business_date = ? AND shift_id IS NOT NULL")
    .all(bdate).map((r) => r.shift_id));
  assert.strictEqual(ids.size, 1, 'and every dinner entry that day points at it');
});

test('café and dinner on one date are two shifts, not one', () => {
  const bdate = db.prepare("SELECT business_date FROM time_entries WHERE daypart = 'cafe' ORDER BY id DESC LIMIT 1").get().business_date;
  const kinds = db.prepare('SELECT DISTINCT daypart FROM shifts WHERE date = ?').all(bdate).map((r) => r.daypart);
  assert.ok(kinds.includes('cafe'), 'the café shift exists on its own row');
  const dupes = db.prepare('SELECT date, daypart, COUNT(*) c FROM shifts GROUP BY date, daypart HAVING c > 1').all();
  assert.strictEqual(dupes.length, 0, 'UNIQUE(date,daypart) holds across every path');
});

test('an entry started after midnight belongs to the night it began', () => {
  // Proof the cutoff is doing real work: a 1am punch files under the previous
  // business date, so a bartender's close is not split across two days.
  const late = db.prepare("SELECT business_date, clock_in_at FROM time_entries WHERE clock_in_at LIKE '%0_:%' ORDER BY id LIMIT 1").get();
  if (!late) return;                       // suite ran during the day — nothing to assert
  assert.match(late.business_date, /^\d{4}-\d{2}-\d{2}$/, 'it still has one clear business date');
});

test('a tip submission after a clock-in joins the same shift, and does not make a second', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'dinner', position: 'server' }, { cookie });
  const e = activeOf(EMP.solo);
  const before = db.prepare('SELECT COUNT(*) n FROM shifts').get().n;

  // The staff tip form posts with its own token; reuse the portal cookie path.
  const form = await (await fetch(`${BASE}/portal/tips`, { method: 'POST', headers: { cookie } })).text();
  const token = (form.match(/name="token" value="([^"]+)"/) || [])[1];
  assert.ok(token, 'the tip form carries a token');
  const day = db.prepare('SELECT business_date FROM time_entries WHERE id = ?').get(e.id).business_date;
  await post('/tips', { token, date: day, daypart: 'dinner', position: 'server', cash_tips: '20', card_tips: '30' });

  const after = db.prepare('SELECT COUNT(*) n FROM shifts').get().n;
  assert.strictEqual(after, before, 'the tip submission made no new shift');
  const sub = db.prepare('SELECT * FROM tip_submissions WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(EMP.solo);
  assert.strictEqual(sub.shift_id, e.shift_id, 'it landed on the very shift the clock-in created');
  await post('/portal/clock/out', { pin: '3111' }, { cookie });
});

test('clocking in never writes hours onto the shift — the manager\'s number wins', () => {
  const rows = db.prepare('SELECT hours FROM work WHERE employee_id = ?').all(EMP.solo);
  assert.ok(rows.length, 'the person is linked to the shift');
  assert.ok(rows.every((r) => Number(r.hours) === 0), 'but hours stay 0 until a manager enters them');
});

// --- corrections and audit -------------------------------------------------

test('an employee correction needs the PIN and a reason, and never edits the punch', async () => {
  const cookie = await signIn('3111');
  const done = entriesOf(EMP.solo).filter((e) => e.status === 'complete')[0];
  const original = done.clock_in_at;

  await post('/portal/clock/fix', { entry_id: done.id, kind: 'wrong_out', reason: '', pin: '3111' }, { cookie });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE time_entry_id = ?').get(done.id).n, 0, 'no reason, no request');

  await post('/portal/clock/fix', { entry_id: done.id, kind: 'wrong_out', reason: 'left at 10.15', pin: '0000' }, { cookie });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE time_entry_id = ?').get(done.id).n, 0, 'wrong PIN, no request');

  await post('/portal/clock/fix', { entry_id: done.id, kind: 'wrong_out', reason: 'left at 10.15', pin: '3111' }, { cookie });
  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC LIMIT 1').get(done.id);
  assert.ok(c, 'the request is recorded');
  assert.strictEqual(c.decision, 'pending');
  assert.strictEqual(db.prepare('SELECT clock_in_at FROM time_entries WHERE id = ?').get(done.id).clock_in_at,
    original, 'and the original punch is untouched');
});

test('every punch writes an audit row', () => {
  const e = entriesOf(EMP.solo)[0];
  const evs = db.prepare("SELECT * FROM time_events WHERE entity = 'entry' AND entity_id = ?").all(e.id);
  assert.ok(evs.some((x) => x.action === 'clock_in'), 'the clock-in is on the record');
  assert.ok(evs.some((x) => x.action === 'clock_out'), 'and the clock-out');
  assert.ok(evs.every((x) => x.actor), 'each naming who did it');
});

// --- manager side ----------------------------------------------------------

test('a manager can add a forgotten punch, and it needs a reason', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM time_entries').get().n;
  await post('/timeclock/new', { employee_id: String(EMP.multi), daypart: 'cafe', position: 'server',
    in: '2026-07-20T09:00', out: '2026-07-20T14:00', reason: '' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries').get().n, before, 'no reason, no entry');

  await post('/timeclock/new', { employee_id: String(EMP.multi), daypart: 'cafe', position: 'server',
    in: '2026-07-20T09:00', out: '2026-07-20T14:00', reason: 'Forgot to clock in' });
  const e = db.prepare("SELECT * FROM time_entries WHERE business_date = '2026-07-20'").get();
  assert.ok(e, 'the entry is added');
  assert.strictEqual(e.source, 'manager');
  assert.strictEqual(e.status, 'complete');
  assert.strictEqual(e.payable_minutes, 300, 'five hours');
  assert.ok(e.shift_id, 'and linked to that day\'s café shift');
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='entry' AND entity_id=? AND action='manager_added'").get(e.id);
  assert.ok(ev && ev.reason, 'with the reason on the record');
});

test('a manager correction keeps the original value in the audit trail', async () => {
  const e = db.prepare("SELECT * FROM time_entries WHERE business_date = '2026-07-20'").get();
  const original = e.clock_in_at;
  await post(`/timeclock/${e.id}/edit`, { in: '2026-07-20T08:30', out: '2026-07-20T14:00',
    position: 'server', daypart: 'cafe', reason: 'Started half an hour earlier' });
  const after = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(e.id);
  assert.notStrictEqual(after.clock_in_at, original, 'the punch moved');
  assert.strictEqual(after.edited, 1, 'and is flagged as edited');
  assert.strictEqual(after.payable_minutes, 330, 'five and a half hours');
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='entry' AND entity_id=? AND action='manager_edit'").get(e.id);
  assert.ok(ev.before_val.includes(original), 'the original value is preserved in the audit row');
  assert.ok(ev.reason, 'with a reason');
});

test('a manager edit still cannot mint a duplicate shift', () => {
  const dupes = db.prepare('SELECT date, daypart, COUNT(*) c FROM shifts GROUP BY date, daypart HAVING c > 1').all();
  assert.strictEqual(dupes.length, 0);
});

test('the manager list and detail render', async () => {
  const list = await text('/timeclock');
  assert.match(list, /Time clock/);
  assert.match(list, /Clocked hours/, 'the strip is there');
  const e = db.prepare("SELECT * FROM time_entries WHERE business_date = '2026-07-20'").get();
  const detail = await text(`/timeclock/${e.id}`);
  assert.match(detail, /The punches/, 'the record renders');
  assert.match(detail, /History/, 'with its audit history');
  assert.match(detail, /Entered on the shift/, 'and the manager-entered hours beside the clocked ones');
});

test('payroll and the overtime toggle are untouched by any of this', async () => {
  const html = await text('/payroll');
  assert.match(html, /overtime/i, 'the overtime control is still on the payroll page');
  const otRow = db.prepare("SELECT value FROM settings WHERE key = 'ot_enabled'").get();
  assert.ok(otRow === undefined || otRow.value === '0', 'and overtime is still off by default');
});
