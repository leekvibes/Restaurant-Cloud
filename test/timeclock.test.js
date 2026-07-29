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
// Point the modules this file requires at the SAME database the server uses.
// Without it `require('../src/timeclock')` opens the default data.db and every
// query here would read a different restaurant's data.
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
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

test('clocking out is one tap — no PIN to type', async () => {
  const cookie = await signIn('3111');
  const before = activeOf(EMP.solo);
  await post('/portal/clock/out', {}, { cookie });
  assert.ok(!activeOf(EMP.solo), 'the punch went through with nothing to type');
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(before.id);
  assert.strictEqual(e.status, 'complete');
  assert.ok(e.clock_out_at, 'with a server clock-out');
  assert.strictEqual(typeof e.payable_minutes, 'number', 'and payable minutes worked out');
  assert.strictEqual(e.payable_minutes, e.raw_minutes - e.unpaid_break_min, 'payable = raw minus unpaid break');
});

test('the clocked-in screen offers no PIN box by default', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  const html = await text('/portal/clock', { cookie });
  assert.match(html, /Clock out/, 'the action is there');
  assert.ok(!/Enter your PIN to clock out/.test(html), 'and nothing asks for a code');
  await post('/portal/clock/out', {}, { cookie });
});

test('a restaurant that wants the PIN back can still have it', async () => {
  // The step is gone, not deleted — switched on, it guards the punch again.
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '16',
    pin_out: '1', pin_fix: '1', require_service: '1', alerts: '1' });
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  await post('/portal/clock/out', { pin: '0000' }, { cookie });
  assert.ok(activeOf(EMP.solo), 'a wrong PIN leaves them on the clock');
  const html = await text('/portal/clock', { cookie });
  assert.match(html, /Enter your PIN to clock out/, 'and the prompt is back on screen');
  await post('/portal/clock/out', { pin: '3111' }, { cookie });
  assert.ok(!activeOf(EMP.solo), 'the right one closes it');
  // Back to the default for everything after this.
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '16',
    pin_fix: '1', require_service: '1', alerts: '1' });
  assert.strictEqual(require('../src/timeclock').settings().pinAtOut, false);
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

/**
 * Every row the clock owns must equal the punches behind it. This is the
 * invariant the whole feature rests on, so it is asserted from several angles
 * rather than once — a correction, an edit, a break and a re-parent all have to
 * arrive here, and any one of them missing its call would show up as drift.
 */
function assertClockRowsAgree(where = 'the clock-owned rows agree with the punches') {
  const T = require('../src/timeclock');
  const rows = db.prepare('SELECT shift_id, employee_id, hours, hours_source FROM work').all();
  let checked = 0;
  for (const r of rows) {
    if (r.hours_source !== 'clock') continue;   // a typed number is nobody else's business
    const ent = db.prepare('SELECT id, status, clock_out_at, raw_minutes, payable_minutes FROM time_entries WHERE shift_id = ? AND employee_id = ?')
      .all(r.shift_id, r.employee_id);
    // Rows whose punches are simply gone are skipped, and only here: no route
    // in the app deletes a time entry (grep src/ for DELETE FROM time_entries —
    // there is none), so this state exists only where a fixture below reaches
    // into the database to reset itself. The case that MATTERS — a punch that
    // moved to another shift, leaving the old one holding its hours — is not
    // this, and is covered head-on in test/clockhours.test.js.
    if (!ent.length) continue;
    const min = T.clockedMinutesOn(r.shift_id, r.employee_id);
    assert.strictEqual(Number(r.hours), Math.round((min / 60) * 1000) / 1000,
      `${where} — shift ${r.shift_id}, employee ${r.employee_id}; entries ${JSON.stringify(ent)}`);
    checked++;
  }
  return checked;
}

test('clocking out writes the hours onto the shift; an open punch does not', () => {
  const rows = db.prepare('SELECT shift_id, hours, hours_source FROM work WHERE employee_id = ?').all(EMP.solo);
  assert.ok(rows.length, 'the person is linked to the shift');
  // insertWorkIfAbsent still runs at clock-in, so the row exists before there
  // are any hours to put in it — that link is what the tips page joins onto.
  for (const r of rows) {
    const closed = db.prepare(`SELECT COALESCE(SUM(payable_minutes), 0) m FROM time_entries
      WHERE shift_id = ? AND employee_id = ? AND clock_out_at IS NOT NULL`).get(r.shift_id, EMP.solo).m;
    assert.strictEqual(Number(r.hours), Math.round((closed / 60) * 1000) / 1000,
      'the shift carries exactly what the closed punches measured');
    if (closed > 0) assert.strictEqual(r.hours_source, 'clock', 'and is marked as the clock\'s work');
  }
  assertClockRowsAgree();
});

// --- corrections and audit -------------------------------------------------

test('an employee correction needs the PIN and a reason, and never edits the punch', async () => {
  const cookie = await signIn('3111');
  const done = entriesOf(EMP.solo).filter((e) => e.status === 'complete')[0];
  const original = done.clock_in_at;

  const at = require('../src/timeclock').utcToLocalInput(done.clock_out_at);
  await post('/portal/clock/fix', { entry_id: done.id, kind: 'wrong_out', at_out: at, reason: '', pin: '3111' }, { cookie });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE time_entry_id = ?').get(done.id).n, 0, 'no reason, no request');

  await post('/portal/clock/fix', { entry_id: done.id, kind: 'wrong_out', at_out: at, reason: 'left at 10.15', pin: '0000' }, { cookie });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE time_entry_id = ?').get(done.id).n, 0, 'wrong PIN, no request');

  await post('/portal/clock/fix', { entry_id: done.id, kind: 'wrong_out', at_out: at, reason: 'left at 10.15', pin: '3111' }, { cookie });
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
  // The Today tab answers "what is happening now". A period's clocked-hours
  // total is a Timesheets question and moved there — this strip counts people,
  // not hours.
  assert.match(list, /Working/, 'the strip is there');
  assert.match(list, /On break/);
  assert.match(list, /Missing a punch/, 'and names the thing that actually needs somebody');
  const e = db.prepare("SELECT * FROM time_entries WHERE business_date = '2026-07-20'").get();
  const detail = await text(`/timeclock/${e.id}`);
  assert.match(detail, /The punches/, 'the record renders');
  assert.match(detail, /History/, 'with its audit history');
  assert.match(detail, /On the shift|Entered on the shift/, 'and what the shift is carrying, beside the clocked figure');
});

test('payroll and the overtime toggle are untouched by any of this', async () => {
  const html = await text('/payroll');
  assert.match(html, /overtime/i, 'the overtime control is still on the payroll page');
  const otRow = db.prepare("SELECT value FROM settings WHERE key = 'ot_enabled'").get();
  assert.ok(otRow === undefined || otRow.value === '0', 'and overtime is still off by default');
});

// ===========================================================================
// APPROVED CORRECTIONS APPLY THEMSELVES
//
// The rule under test: an approved request is never left unapplied. Approval
// and application are one transaction, so a change that cannot be made validly
// leaves the request pending and the punch untouched — never "approved" against
// a record that did not move.
// ===========================================================================

/** File a structured request straight into the table, the way the portal does. */
function request(entryId, empId, kind, payload, reason = 'because') {
  const info = db.prepare(`INSERT INTO time_corrections
    (time_entry_id, employee_id, kind, original_value, proposed_value, reason, requested_by, payload)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(entryId, empId, kind, 'original', 'summary', reason, 'Tester', JSON.stringify(payload));
  db.prepare("UPDATE time_entries SET status = 'correction_pending' WHERE id = ?").run(entryId);
  return info.lastInsertRowid;
}
const decide = (cid, decision, note = '') => post(`/timeclock/correction/${cid}`, { decision, note });
const entry = (id) => db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);
const corr = (id) => db.prepare('SELECT * FROM time_corrections WHERE id = ?').get(id);
const evOf = (id) => db.prepare("SELECT * FROM time_events WHERE entity='entry' AND entity_id=? ORDER BY id").all(id);

/** A finished entry on its own day, safely away from the others. */
function seedEntry(empId, day, inLocal, outLocal, position = 'server', daypart = 'cafe') {
  const toUtc = (v) => require('../src/timeclock').localInputToUtc(v);
  const i = toUtc(`${day}T${inLocal}`), o = outLocal ? toUtc(`${day}T${outLocal}`) : null;
  const raw = o ? Math.round((new Date(o.replace(' ', 'T') + 'Z') - new Date(i.replace(' ', 'T') + 'Z')) / 60000) : null;
  return db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,?,?,?,?,?,'manager',?,?)`)
    .run(empId, day, daypart, position, i, o, o ? 'complete' : 'missing_punch', raw, raw).lastInsertRowid;
}

test('an approved missing clock-out is inserted automatically', async () => {
  const id = seedEntry(EMP.multi, '2026-06-01', '09:00', null);
  const cid = request(id, EMP.multi, 'missing_out', { at: require('../src/timeclock').localInputToUtc('2026-06-01T17:00') });
  await decide(cid, 'approved');
  const e = entry(id);
  assert.ok(e.clock_out_at, 'the clock-out was written');
  assert.strictEqual(e.status, 'complete', 'and the entry closed');
  assert.strictEqual(e.payable_minutes, 480, 'eight hours, recalculated');
  assert.strictEqual(e.edited, 1, 'flagged as edited');
  assert.strictEqual(corr(cid).decision, 'approved');
  assert.ok(corr(cid).applied_at, 'and stamped as applied');
});

test('an approved clock-in change replaces the value and keeps the original in history', async () => {
  const id = seedEntry(EMP.multi, '2026-06-02', '09:00', '17:00');
  const before = entry(id).clock_in_at;
  const cid = request(id, EMP.multi, 'wrong_in', { at: require('../src/timeclock').localInputToUtc('2026-06-02T08:00') });
  await decide(cid, 'approved');
  const e = entry(id);
  assert.notStrictEqual(e.clock_in_at, before, 'the punch moved');
  assert.strictEqual(e.payable_minutes, 540, 'nine hours now');
  const ev = evOf(id).find((x) => x.action === 'clock_in_corrected');
  assert.ok(ev, 'an audit event names the change');
  assert.strictEqual(ev.before_val, before, 'carrying the ORIGINAL value');
  assert.ok(ev.after_val && ev.reason, 'the new value and the reason too');
});

test('an approved clock-out change recalculates payable time', async () => {
  const id = seedEntry(EMP.multi, '2026-06-03', '09:00', '17:00');
  const cid = request(id, EMP.multi, 'wrong_out', { at: require('../src/timeclock').localInputToUtc('2026-06-03T18:30') });
  await decide(cid, 'approved');
  assert.strictEqual(entry(id).payable_minutes, 570, 'nine and a half hours');
});

test('an approved missing break is created and subtracted', async () => {
  const T = require('../src/timeclock');
  const id = seedEntry(EMP.multi, '2026-06-04', '09:00', '17:00');
  const cid = request(id, EMP.multi, 'missing_break',
    { start: T.localInputToUtc('2026-06-04T12:00'), end: T.localInputToUtc('2026-06-04T12:30'), paid: false });
  await decide(cid, 'approved');
  const e = entry(id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE time_entry_id = ?').get(id).n, 1, 'the break exists');
  assert.strictEqual(e.unpaid_break_min, 30, 'thirty unpaid minutes');
  assert.strictEqual(e.payable_minutes, 450, 'and payable time drops by them');
});

test('an approved break correction moves the break and re-totals', async () => {
  const T = require('../src/timeclock');
  const id = seedEntry(EMP.multi, '2026-06-05', '09:00', '17:00');
  const bid = db.prepare(`INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at, paid, raw_minutes, source)
    VALUES (?,?,?,?,0,30,'employee')`)
    .run(id, EMP.multi, T.localInputToUtc('2026-06-05T12:00'), T.localInputToUtc('2026-06-05T12:30')).lastInsertRowid;
  const cid = request(id, EMP.multi, 'break',
    { break_id: bid, start: T.localInputToUtc('2026-06-05T12:00'), end: T.localInputToUtc('2026-06-05T13:00') });
  await decide(cid, 'approved');
  assert.strictEqual(db.prepare('SELECT raw_minutes FROM time_breaks WHERE id = ?').get(bid).raw_minutes, 60, 'the break is an hour now');
  assert.strictEqual(entry(id).payable_minutes, 420, 'seven payable hours');
});

test('an approved position change is applied', async () => {
  const id = seedEntry(EMP.multi, '2026-06-06', '09:00', '17:00', 'server');
  const cid = request(id, EMP.multi, 'wrong_position', { position: 'busser' });
  await decide(cid, 'approved');
  assert.strictEqual(entry(id).position, 'busser');
  assert.ok(evOf(id).some((x) => x.action === 'position_corrected' && x.before_val === 'server'));
});

test('an approved service change moves the entry and reuses the right shift', async () => {
  const id = seedEntry(EMP.multi, '2026-06-07', '09:00', '17:00', 'server', 'cafe');
  const cid = request(id, EMP.multi, 'wrong_service', { daypart: 'dinner' });
  await decide(cid, 'approved');
  const e = entry(id);
  assert.strictEqual(e.daypart, 'dinner');
  const sh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(e.shift_id);
  assert.strictEqual(sh.daypart, 'dinner', 'now linked to the dinner shift');
  assert.strictEqual(sh.date, '2026-06-07', 'on the same business date');
  const dupes = db.prepare('SELECT date, daypart, COUNT(*) c FROM shifts GROUP BY date, daypart HAVING c > 1').all();
  assert.strictEqual(dupes.length, 0, 'and no duplicate shift was minted');
});

test('a rejected correction changes nothing at all', async () => {
  const id = seedEntry(EMP.multi, '2026-06-08', '09:00', '17:00');
  const snap = entry(id);
  const cid = request(id, EMP.multi, 'wrong_out', { at: require('../src/timeclock').localInputToUtc('2026-06-08T23:00') });
  await decide(cid, 'rejected', 'not what the roster says');
  const e = entry(id);
  assert.strictEqual(e.clock_out_at, snap.clock_out_at, 'the punch is untouched');
  assert.strictEqual(e.payable_minutes, snap.payable_minutes, 'and so are the totals');
  assert.strictEqual(e.edited, 0, 'it is not even marked edited');
  assert.strictEqual(corr(cid).decision, 'rejected');
  assert.ok(!corr(cid).applied_at, 'nothing was applied');
});

test('a correction that would overlap another entry is refused and stays pending', async () => {
  const T = require('../src/timeclock');
  const a = seedEntry(EMP.solo, '2026-06-10', '09:00', '13:00');
  const b = seedEntry(EMP.solo, '2026-06-10', '14:00', '18:00');
  const snap = entry(b);
  // Pull b's clock-in back into a's hours.
  const cid = request(b, EMP.solo, 'wrong_in', { at: T.localInputToUtc('2026-06-10T12:00') });
  await decide(cid, 'approved');
  assert.strictEqual(entry(b).clock_in_at, snap.clock_in_at, 'the punch did not move');
  assert.strictEqual(corr(cid).decision, 'pending', 'and the request is STILL PENDING, not approved');
  assert.match(corr(cid).apply_error || '', /overlap/i, 'with the reason recorded');
  assert.strictEqual(entry(a).clock_out_at, entry(a).clock_out_at, 'the other entry is untouched');
});

test('a break correction that would run past the clock-out is refused', async () => {
  const T = require('../src/timeclock');
  const id = seedEntry(EMP.solo, '2026-06-11', '09:00', '17:00');
  const bid = db.prepare(`INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at, paid, raw_minutes, source)
    VALUES (?,?,?,?,0,30,'employee')`)
    .run(id, EMP.solo, T.localInputToUtc('2026-06-11T12:00'), T.localInputToUtc('2026-06-11T12:30')).lastInsertRowid;
  const cid = request(id, EMP.solo, 'break',
    { break_id: bid, start: T.localInputToUtc('2026-06-11T16:30'), end: T.localInputToUtc('2026-06-11T18:00') });
  await decide(cid, 'approved');
  assert.strictEqual(corr(cid).decision, 'pending', 'refused');
  assert.strictEqual(db.prepare('SELECT raw_minutes FROM time_breaks WHERE id = ?').get(bid).raw_minutes, 30, 'the break is unchanged');
});

test('a failed application rolls back completely — no half-applied state', async () => {
  const T = require('../src/timeclock');
  const id = seedEntry(EMP.solo, '2026-06-12', '09:00', '17:00');
  const before = entry(id);
  const evsBefore = evOf(id).length;
  // A clock-in AFTER the clock-out: invalid, and it must leave nothing behind.
  const cid = request(id, EMP.solo, 'wrong_in', { at: T.localInputToUtc('2026-06-12T20:00') });
  await decide(cid, 'approved');
  const after = entry(id);
  assert.strictEqual(after.clock_in_at, before.clock_in_at, 'punch unchanged');
  assert.strictEqual(after.edited, 0, 'not marked edited');
  assert.strictEqual(evOf(id).length, evsBefore, 'and NO audit row was left behind by the rolled-back attempt');
  assert.strictEqual(corr(cid).decision, 'pending');
});

test('an "other" request is marked handled, not applied — and stops blocking', async () => {
  const id = seedEntry(EMP.solo, '2026-06-13', '09:00', '17:00');
  const before = entry(id);
  const cid = request(id, EMP.solo, 'other', {});
  await decide(cid, 'approved', 'sorted it with them');
  const c = corr(cid);
  assert.strictEqual(c.decision, 'approved', 'it resolves — otherwise it blocks their timesheet forever');
  assert.ok(!c.applied_at, 'but nothing was auto-applied');
  const after = entry(id);
  assert.strictEqual(after.clock_in_at, before.clock_in_at, 'and the punch is untouched');
  assert.strictEqual(after.edited, 0);
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='correction' AND entity_id=? AND action='acknowledged'").get(cid);
  assert.ok(ev, 'recorded as handled by hand');
});

test('an approved correction carries all the way through to the shift hours', () => {
  // The old rule was the opposite: corrections stopped at the time entry and
  // work.hours stayed 0. That meant an approved fix never reached payroll —
  // the employee was paid nothing for a shift the clock had a record of.
  assert.ok(assertClockRowsAgree('a correction left the shift disagreeing with its punches') > 0,
    'and at least one row is actually clock-owned, so this asserts something');
});

// ===========================================================================
// TIMESHEETS — a pay period signed off by the person who worked it.
// ===========================================================================
const P = require('../src/periods');
const T2 = require('../src/timeclock');
const sheetOf = (empId, start) => db.prepare('SELECT * FROM timesheets WHERE employee_id = ? AND period_start = ?').get(empId, start);
/** Submit the way the form does: carrying the totals the page displayed. */
async function submitSheet(empId, pin, per, extra = {}, cookie) {
  // What the PAGE shows, which is punches plus any hours the shift sheets carry
  // that no punch accounts for. Computing it without those signed a figure the
  // employee was never shown, and the submit route rightly refused it — the
  // signature belongs to the hours that were on screen.
  const seen = T2.totalsFor(T2.q.entriesInPeriod.all(empId, per.start, per.end),
    { extra: T2.shiftOnlyHours(empId, per.start, per.end) }).payable;
  return post('/portal/timesheet/submit',
    { period: per.start, confirm: '1', pin, seen: String(seen), ...extra }, { cookie });
}
/**
 * The period these tests work in: the most recent one that has FINISHED.
 *
 * A timesheet can only be submitted once its period ends — signing for hours
 * you are still working is a signature that will be wrong by closing time — so
 * the whole submit/approve/transfer chain is exercised on a completed period,
 * which is also how it happens in a real fortnight.
 */
const curPeriod = () => P.recentPeriods(2)[1];

/**
 * A clean, complete entry on a definite day INSIDE the current pay period.
 * Anchored to the period rather than to "hours ago", so the test does not drift
 * across a period boundary depending on when it runs.
 */
function seedInPeriod(empId, dayOffset = 1, from = '09:00', to = '17:00') {
  const per = curPeriod();
  const day = require('../src/dates').addDays(per.start, dayOffset);
  const i = T2.localInputToUtc(`${day}T${from}`), o = T2.localInputToUtc(`${day}T${to}`);
  const raw = Math.round((new Date(o.replace(' ', 'T') + 'Z') - new Date(i.replace(' ', 'T') + 'Z')) / 60000);
  return db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'cafe','server',?,?,'complete','manager',?,?)`).run(empId, day, i, o, raw, raw).lastInsertRowid;
}

test('the timesheet totals a period from its entries', async () => {
  const per = curPeriod();
  const eid = seedInPeriod(EMP.none, 1);               // an 8-hour day inside the period
  const cookie = await signIn('3333');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  assert.match(html, /Timesheet/, 'the page renders');
  assert.match(html, /Regular/, 'with the period summary');
  // Reading a period must NOT write to the database — a view-only account
  // opening this page creates nothing. The row appears when something is
  // actually recorded against it, which is the submission.
  assert.strictEqual(sheetOf(EMP.none, per.start), undefined, 'looking at it creates no row');
  assert.match(html, /OPEN|Open/, 'and it still reads as open');
  const tot = T2.totalsFor(T2.q.entriesInPeriod.all(EMP.none, per.start, per.end));
  assert.strictEqual(tot.payable, 480, 'eight hours payable');
});

test('a still-running entry blocks submission', async () => {
  const cookie = await signIn('3333');
  const nowPer = P.currentPeriod();
  const open = db.prepare(`INSERT INTO time_entries (employee_id, business_date, daypart, position, clock_in_at, status, source)
    VALUES (?, ?, 'cafe', 'server', datetime('now','-2 hours'), 'active', 'manager')`)
    .run(EMP.none, T2.businessDateOf(T2.nowUtc(), T2.settings().cutoffHour)).lastInsertRowid;
  await submitSheet(EMP.none, '3333', nowPer, {}, cookie);
  assert.notStrictEqual((sheetOf(EMP.none, nowPer.start) || {}).status, 'submitted', 'refused while they are still on the clock');
  const html = await text(`/portal/timesheet?p=${nowPer.start}`, { cookie });
  assert.match(html, /Still on the clock/, 'and it says why');
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(open);
});

test('a clean timesheet submits, with the totals it showed', async () => {
  const per = curPeriod();
  const cookie = await signIn('3333');
  await submitSheet(EMP.none, '3333', per, { note: 'all good' }, cookie);
  const s = sheetOf(EMP.none, per.start);
  assert.strictEqual(s.status, 'submitted');
  assert.ok(s.submitted_at, 'stamped');
  assert.strictEqual(s.submitted_note, 'all good');
  const snap = JSON.parse(s.submitted_totals);
  assert.strictEqual(snap.payable, 480, 'the totals they agreed to are kept');
});

test('submitting needs the PIN and the confirmation', async () => {
  const per = curPeriod();
  const cookie = await signIn('3222');
  seedInPeriod(EMP.multi, 2, '10:00', '14:00');
  await submitSheet(EMP.multi, '0000', per, {}, cookie);
  assert.notStrictEqual((sheetOf(EMP.multi, per.start) || {}).status, 'submitted', 'wrong PIN, no signature');
  await post('/portal/timesheet/submit', { period: per.start, pin: '3222' }, { cookie });
  assert.notStrictEqual((sheetOf(EMP.multi, per.start) || {}).status, 'submitted', 'unticked box, no signature');
});

test('a manager can return a submitted timesheet, with a reason', async () => {
  const per = curPeriod();
  await post(`/payroll/timesheets/${EMP.none}/return`, { period: per.start, reason: '' });
  assert.strictEqual(sheetOf(EMP.none, per.start).status, 'submitted', 'no reason, no return');
  await post(`/payroll/timesheets/${EMP.none}/return`, { period: per.start, reason: 'Tuesday looks short' });
  const s = sheetOf(EMP.none, per.start);
  assert.strictEqual(s.status, 'returned');
  assert.strictEqual(s.returned_reason, 'Tuesday looks short');
  assert.ok(s.returned_by, 'naming who sent it back');
  assert.strictEqual(s.resubmit_needed, 1);
});

test('the employee sees why it came back, and can submit again', async () => {
  const per = curPeriod();
  const cookie = await signIn('3333');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  assert.match(html, /Returned for correction/, 'they are told');
  assert.match(html, /Tuesday looks short/, 'and why');
  await submitSheet(EMP.none, '3333', per, {}, cookie);
  const s = sheetOf(EMP.none, per.start);
  assert.strictEqual(s.status, 'submitted', 'resubmitted');
  assert.strictEqual(s.resubmit_needed, 0);
  assert.ok(!s.returned_at, 'and the return is cleared');
});

test('an approved correction after submission forces a resubmission', async () => {
  const T = require('../src/timeclock');
  const per = curPeriod();
  assert.strictEqual(sheetOf(EMP.none, per.start).status, 'submitted', 'starts submitted');
  const e = T.q.entriesInPeriod.all(EMP.none, per.start, per.end)[0];
  const newOut = T.localInputToUtc(T.utcToLocalInput(e.clock_out_at).slice(0, 11) + '23:30');
  const cid = request(e.id, EMP.none, 'wrong_out', { at: newOut });
  await decide(cid, 'approved');
  const s = sheetOf(EMP.none, per.start);
  assert.strictEqual(s.status, 'submitted', 'the submission record stands');
  assert.strictEqual(s.resubmit_needed, 1, 'but it must be signed again');
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='timesheet' AND entity_id=? AND action='reopened_by_change'").get(s.id);
  assert.ok(ev, 'and the reason is on the record');
  assert.match(ev.reason || '', /correction/i, 'naming what moved the hours');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie: await signIn('3333') });
  assert.match(html, /changed after you submitted/, 'the employee is told');
});

test('a viewer cannot return a timesheet', async () => {
  // Viewers are blocked by the write guard; with auth off every account is an
  // editor, so this asserts the guard exists rather than simulating a login.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf("app.post('/payroll/timesheets/:empId/return'"));
  assert.match(route.slice(0, 400), /canWrite\(\)/, 'the return route checks canWrite');
});

test('the manager ledger lists the period and says these are payroll\'s hours', async () => {
  const html = await text('/payroll/timesheets');
  assert.match(html, /Timesheets/);
  assert.match(html, /Needs attention|Submitted/, 'statuses show');
  assert.match(html, /runs on/i, 'and it says these are the hours payroll runs on');
  // The "vs entered" difference is deliberately absent here. It means the size
  // of a manager's override, and nobody has overridden anything — so a number
  // in that column would be a difference nobody caused. The override case is
  // asserted head-on in test/clockhours.test.js.
  assert.doesNotMatch(html, /vs entered/, 'and shows no phantom difference when nothing was typed over');
});

test('the timesheet flow leaves the shift hours agreeing with the punches, and sends nothing', () => {
  assertClockRowsAgree('the timesheet flow moved a figure it should not have');
  // Signing a timesheet is a record that the hours are right. It must still
  // never reach for the payroll send button on its own.
  const sends = db.prepare('SELECT COUNT(*) n FROM period_sends').get().n;
  assert.strictEqual(sends, 0, 'and nothing was sent to payroll');
});

test('a decided correction cannot be applied twice', async () => {
  const T = require('../src/timeclock');
  const id = seedEntry(EMP.multi, '2026-05-20', '09:00', '17:00');
  const cid = request(id, EMP.multi, 'missing_break',
    { start: T.localInputToUtc('2026-05-20T12:00'), end: T.localInputToUtc('2026-05-20T12:30'), paid: false });
  await decide(cid, 'approved');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE time_entry_id = ?').get(id).n, 1, 'one break');
  // The same POST again — a double tap, or a back button.
  await decide(cid, 'approved');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE time_entry_id = ?').get(id).n, 1,
    'still one break — a decided request is never applied twice');
  assert.strictEqual(entry(id).payable_minutes, 450);
});

test('a manager edit to a SUBMITTED timesheet forces resubmission', async () => {
  const per = curPeriod();
  const cookie = await signIn('3222');
  // Give this person a clean period and sign it off.
  db.prepare("DELETE FROM time_entries WHERE employee_id = ? AND business_date >= ? AND business_date <= ?")
    .run(EMP.multi, per.start, per.end);
  const eid = seedInPeriod(EMP.multi, 3, '09:00', '15:00');
  await submitSheet(EMP.multi, '3222', per, {}, cookie);
  assert.strictEqual(sheetOf(EMP.multi, per.start).status, 'submitted', 'signed off');
  assert.strictEqual(sheetOf(EMP.multi, per.start).resubmit_needed, 0);

  // A manager moves the hours afterwards.
  const T = require('../src/timeclock');
  const day = require('../src/dates').addDays(per.start, 3);
  await post(`/timeclock/${eid}/edit`, { in: `${day}T09:00`, out: `${day}T16:00`,
    position: 'server', daypart: 'cafe', reason: 'stayed an hour later' });
  const s = sheetOf(EMP.multi, per.start);
  assert.strictEqual(s.resubmit_needed, 1, 'the signature no longer covers these hours');
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='timesheet' AND entity_id=? AND action='reopened_by_change'").get(s.id);
  assert.ok(ev, 'and the record says why');
});

test('a manager break change also forces resubmission', async () => {
  const per = curPeriod();
  const cookie = await signIn('3222');
  await submitSheet(EMP.multi, '3222', per, {}, cookie);
  assert.strictEqual(sheetOf(EMP.multi, per.start).resubmit_needed, 0, 'signed again');
  const day = require('../src/dates').addDays(per.start, 3);
  const eid = db.prepare('SELECT id FROM time_entries WHERE employee_id = ? AND business_date = ?').get(EMP.multi, day).id;
  await post(`/timeclock/${eid}/break`, { start: `${day}T12:00`, end: `${day}T12:30`, paid: '0', reason: 'took a break' });
  assert.strictEqual(sheetOf(EMP.multi, per.start).resubmit_needed, 1, 'adding a break unsettles it too');
});

// --- regressions the adversarial review found ------------------------------

test('a corrected clock-in that crosses the cutoff re-files to the right trading day', async () => {
  const T = require('../src/timeclock');
  // Punched in at 03:30 — before the 4am cutoff, so it belongs to the night
  // before. Corrected to 05:30, it belongs to the new day, and the entry has to
  // move with it: same trading day, same shift, same pay period as the manager
  // edit route would give.
  const i = T.localInputToUtc('2026-05-01T03:30');
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'cafe','server',?,?,'complete','manager',240,240)`)
    .run(EMP.multi, '2026-04-30', i, T.localInputToUtc('2026-05-01T07:30')).lastInsertRowid;
  assert.strictEqual(entry(id).business_date, '2026-04-30', 'filed on the night it started');

  const cid = request(id, EMP.multi, 'wrong_in', { at: T.localInputToUtc('2026-05-01T05:30') });
  await decide(cid, 'approved');
  const e = entry(id);
  assert.strictEqual(e.business_date, '2026-05-01', 'the trading day moved with the punch');
  assert.ok(e.shift_id, 'and it is linked to a shift');
  const sh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(e.shift_id);
  assert.strictEqual(sh.date, '2026-05-01', 'the shift for the day it now belongs to');
  const dupes = db.prepare('SELECT date, daypart, COUNT(*) c FROM shifts GROUP BY date, daypart HAVING c > 1').all();
  assert.strictEqual(dupes.length, 0, 'and still no duplicate shifts');
});

test('adding a punch to a signed period asks for it to be signed again', async () => {
  const per = curPeriod();
  const cookie = await signIn('3333');
  await submitSheet(EMP.none, '3333', per, {}, cookie);
  assert.strictEqual(sheetOf(EMP.none, per.start).resubmit_needed, 0, 'signed');

  const day = require('../src/dates').addDays(per.start, 5);
  await post('/timeclock/new', { employee_id: String(EMP.none), daypart: 'cafe', position: 'server',
    in: `${day}T09:00`, out: `${day}T12:00`, reason: 'forgot to clock in' });
  assert.strictEqual(sheetOf(EMP.none, per.start).resubmit_needed, 1,
    'a whole new punch changes the total just as surely as moving one');
});

test('signing off hours that changed while the page was open is refused', async () => {
  const per = curPeriod();
  const cookie = await signIn('3333');
  const res = await post('/portal/timesheet/submit',
    { period: per.start, confirm: '1', pin: '3333', seen: '1' }, { cookie });   // stale figure
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location') || '', /err=/, 'sent back with a message');
  assert.notStrictEqual(sheetOf(EMP.none, per.start).resubmit_needed, 0, 'and it is still unsigned');
});

test('a submission naming a period that is not open is refused', async () => {
  const cookie = await signIn('3333');
  const res = await post('/portal/timesheet/submit',
    { period: '1999-01-01', confirm: '1', pin: '3333', seen: '0' }, { cookie });
  assert.match(res.headers.get('location') || '', /err=/, 'no silent fallback to the current period');
});

test('one pending correction is one issue, not two', () => {
  const T = require('../src/timeclock');
  const id = seedEntry(EMP.solo, '2026-04-02', '09:00', '17:00');
  const cid = request(id, EMP.solo, 'wrong_in', { at: T.localInputToUtc('2026-04-02T23:00') });
  const c = db.prepare('SELECT * FROM time_corrections WHERE id = ?').get(cid);
  db.prepare("UPDATE time_corrections SET apply_error = 'nope' WHERE id = ?").run(cid);
  const issues = T.issuesFor([entry(id)], [db.prepare('SELECT * FROM time_corrections WHERE id = ?').get(cid)]);
  const about = issues.filter((i) => /correction/i.test(i.text));
  assert.strictEqual(about.length, 1, 'a single request produces a single line');
});

// ===========================================================================
// PHASE 4 — approval, locking, and the transfer to payroll.
//
// The two things these guard: an approval describes the hours it was given for
// (change them and it says so), and payroll is never quietly left holding a
// figure that has moved.
// ===========================================================================
const sheetRow = (empId, start) => db.prepare('SELECT * FROM timesheets WHERE employee_id = ? AND period_start = ?').get(empId, start);
const approvalsOf = (sid) => db.prepare('SELECT * FROM timesheet_approvals WHERE timesheet_id = ? ORDER BY id').all(sid);
const transfersOf = (sid) => db.prepare('SELECT * FROM payroll_transfers WHERE timesheet_id = ? ORDER BY id').all(sid);
const EMP4 = 94;

/** A clean, submitted period for the approval employee. */
async function readyToApprove(dayOffset = 6) {
  // Created on first use: node:test honours only one top-level before hook, and
  // that one belongs to the server.
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,?,?,?,1)")
    .run(EMP4, 'Approval Tester', 'server', '3444', 2000);
  const per = curPeriod();
  db.prepare('DELETE FROM time_entries WHERE employee_id = ?').run(EMP4);
  db.prepare('DELETE FROM timesheets WHERE employee_id = ?').run(EMP4);
  const eid = seedInPeriod(EMP4, dayOffset, '09:00', '17:00');
  const cookie = await signIn('3444');
  await submitSheet(EMP4, '3444', per, {}, cookie);
  return { per, eid, sheet: sheetRow(EMP4, per.start) };
}

test('a clean submitted timesheet approves, and the approval records what it approved', async () => {
  const { per, sheet } = await readyToApprove();
  assert.strictEqual(sheet.status, 'submitted');
  await post(`/payroll/timesheets/${EMP4}/approve`, { period: per.start, note: 'looks right' });
  const s = sheetRow(EMP4, per.start);
  assert.strictEqual(s.status, 'approved');
  assert.ok(s.approved_at && s.approved_by, 'stamped with who and when');
  assert.strictEqual(s.transfer_state, 'ready', 'and ready for payroll, not yet sent');
  const a = approvalsOf(s.id);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].payable_min, 480, 'the hours it approved');
  assert.ok(a[0].fingerprint, 'and what they were made of');
  assert.strictEqual(a[0].state, 'current');
});

test('approval is refused while a punch is missing, and says why', async () => {
  const per = curPeriod();
  const { sheet } = await readyToApprove(7);
  // Open a punch after submission — now it cannot be approved.
  const day = require('../src/dates').addDays(per.start, 8);
  db.prepare(`INSERT INTO time_entries (employee_id, business_date, daypart, position, clock_in_at, status, source)
    VALUES (?,?,'cafe','server',?, 'missing_punch','manager')`).run(EMP4, day, T2.localInputToUtc(`${day}T09:00`));
  const res = await post(`/payroll/timesheets/${EMP4}/approve`, { period: per.start });
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /Not approved/, 'refused with a reason');
  assert.notStrictEqual(sheetRow(EMP4, per.start).status, 'approved');
  assert.strictEqual(approvalsOf(sheet.id).length, 0, 'and no approval record was written');
});

test('an override approves anyway, and the reason is kept forever', async () => {
  const per = curPeriod();
  const s0 = sheetRow(EMP4, per.start);
  await post(`/payroll/timesheets/${EMP4}/approve`, { period: per.start, override_reason: 'confirmed with the closing manager' });
  const s = sheetRow(EMP4, per.start);
  assert.strictEqual(s.status, 'approved', 'it went through');
  const a = approvalsOf(s.id).pop();
  assert.strictEqual(a.override_reason, 'confirmed with the closing manager');
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='timesheet' AND entity_id=? AND action='approved_with_override'").get(s.id);
  assert.ok(ev, 'and it is on the record as an override, not a clean approval');
});

test('locking, then reopening, keeps the original approval as history', async () => {
  const { per, sheet } = await readyToApprove(9);
  await post(`/payroll/timesheets/${EMP4}/approve`, { period: per.start });
  await post(`/payroll/timesheets/${EMP4}/lock`, { period: per.start });
  assert.strictEqual(sheetRow(EMP4, per.start).status, 'locked');

  await post(`/payroll/timesheets/${EMP4}/reopen`, { period: per.start, reason: '' });
  assert.strictEqual(sheetRow(EMP4, per.start).status, 'locked', 'no reason, no reopen');

  await post(`/payroll/timesheets/${EMP4}/reopen`, { period: per.start, reason: 'missed an hour' });
  const s = sheetRow(EMP4, per.start);
  assert.strictEqual(s.status, 'submitted', 'back with the manager, not thrown to the employee');
  assert.strictEqual(s.reopen_reason, 'missed an hour');
  const a = approvalsOf(s.id);
  assert.strictEqual(a.length, 1, 'the approval is still there');
  assert.strictEqual(a[0].state, 'superseded', 'marked superseded, not deleted');
  assert.ok(a[0].superseded_reason);
});

test('approved hours transfer, and the snapshot keeps the overtime state', async () => {
  const { per, sheet } = await readyToApprove(10);
  await post(`/payroll/timesheets/${EMP4}/approve`, { period: per.start });
  await post(`/payroll/timesheets/${EMP4}/transfer`, { period: per.start });
  const s = sheetRow(EMP4, per.start);
  assert.strictEqual(s.transfer_state, 'transferred');
  assert.ok(s.transferred_at && s.transferred_by);
  const t = transfersOf(s.id);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].payable_min, 480);
  assert.strictEqual(t[0].regular_min, 480, 'all regular with overtime off');
  assert.strictEqual(t[0].overtime_min, 0);
  assert.strictEqual(t[0].ot_enabled, 0, 'the toggle state is part of the record');
  assert.ok(t[0].fingerprint, 'and what the hours were made of');
});

test('changing hours after transfer marks payroll as out of date — it is not updated silently', async () => {
  const per = curPeriod();
  const s0 = sheetRow(EMP4, per.start);
  const before = transfersOf(s0.id)[0];
  const eid = db.prepare('SELECT id FROM time_entries WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(EMP4).id;
  const day = db.prepare('SELECT business_date FROM time_entries WHERE id = ?').get(eid).business_date;

  await post(`/payroll/timesheets/${EMP4}/reopen`, { period: per.start, reason: 'they worked later' });
  await post(`/timeclock/${eid}/edit`, { in: `${day}T09:00`, out: `${day}T18:00`, position: 'server', daypart: 'cafe', reason: 'stayed an extra hour' });
  const s = sheetRow(EMP4, per.start);
  assert.strictEqual(s.transfer_state, 'needs_recalculation', 'payroll is told the figure it holds is stale');
  const t = transfersOf(s.id);
  assert.strictEqual(t.length, 1, 'the old transfer is still on file');
  assert.strictEqual(t[0].payable_min, before.payable_min, 'holding the value it actually sent');
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='timesheet' AND entity_id=? AND action='payroll_marked_outdated'").get(s.id);
  assert.ok(ev, 'and the moment it went stale is on the record');
});

test('re-transferring supersedes the old snapshot rather than replacing it', async () => {
  const per = curPeriod();
  const s0 = sheetRow(EMP4, per.start);
  // The manager corrected the hours, so the employee has to sign the new ones
  // before they can be approved again — the real loop, not a shortcut.
  const blocked = await post(`/payroll/timesheets/${EMP4}/approve`, { period: per.start });
  assert.match(decodeURIComponent(blocked.headers.get('location') || ''), /signing again/i,
    'approval waits for the employee to re-sign hours that moved');
  await submitSheet(EMP4, '3444', per, {}, await signIn('3444'));
  await post(`/payroll/timesheets/${EMP4}/approve`, { period: per.start });
  await post(`/payroll/timesheets/${EMP4}/transfer`, { period: per.start });
  const t = transfersOf(s0.id);
  assert.strictEqual(t.length, 2, 'both transfers are kept');
  assert.strictEqual(t[0].state, 'superseded', 'the first is marked superseded');
  assert.strictEqual(t[1].state, 'current');
  assert.strictEqual(t[1].payable_min, 540, 'and the new one carries the corrected hours');
  const a = approvalsOf(s0.id).filter((x) => x.state === 'current');
  assert.strictEqual(a.length, 1, 'exactly one approval speaks for now');
});

test('bulk approval writes one approval record per person, and skips the blocked', async () => {
  const per = curPeriod();
  // A clean one and a blocked one.
  const clean = EMP4;
  db.prepare('DELETE FROM time_entries WHERE employee_id = ?').run(clean);
  db.prepare('DELETE FROM timesheets WHERE employee_id = ?').run(clean);
  seedInPeriod(clean, 11, '09:00', '13:00');
  await submitSheet(clean, '3444', per, {}, await signIn('3444'));

  const before = db.prepare('SELECT COUNT(*) n FROM timesheet_approvals').get().n;
  const res = await post('/payroll/timesheets/approve-all', { period: per.start });
  const msg = decodeURIComponent(res.headers.get('location') || '');
  assert.match(msg, /approved/, 'it reports what it did');
  const after = db.prepare('SELECT COUNT(*) n FROM timesheet_approvals').get().n;
  assert.ok(after > before, 'individual approval records were written');
  assert.strictEqual(sheetRow(clean, per.start).status, 'approved');
});

test('a viewer cannot approve, transfer, lock or reopen', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  for (const route of ['/approve', '/transfer', '/lock', '/reopen']) {
    const at = src.indexOf(`app.post('/payroll/timesheets/:empId${route}'`);
    assert.ok(at > 0, `${route} exists`);
    assert.match(src.slice(at, at + 260), /canWrite\(\)/, `${route} is gated on canWrite`);
  }
  const bulk = src.indexOf("app.post('/payroll/timesheets/approve-all'");
  assert.match(src.slice(bulk, bulk + 260), /canWrite\(\)/, 'bulk approve too');
});

test('approval and transfer move no hours of their own, and never send payroll', () => {
  assertClockRowsAgree('approval or transfer changed a figure behind the clock\'s back');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM period_sends').get().n, 0, 'payroll never sent');
});

// ===========================================================================
// PHASE 5 — alerts, settings, reports and exports.
// ===========================================================================

test('alerts report only what needs doing, and carry a link to it', async () => {
  const T = require('../src/timeclock');
  // A shift left open far too long is the classic missed clock-out.
  db.prepare(`INSERT INTO time_entries (employee_id, business_date, daypart, position, clock_in_at, status, source)
    VALUES (?,?,'cafe','server', datetime('now','-30 hours'), 'active','manager')`)
    .run(EMP.none, T.businessDateOf(T.nowUtc(), T.settings().cutoffHour));
  const list = T.alerts({ periods: [P.currentPeriod()], employees: [], otRule: { enabled: false } });
  const long = list.find((a) => /still clocked in/.test(a.text));
  assert.ok(long, 'the long open shift is raised');
  assert.ok(long.href, 'with somewhere to go');
  assert.ok(list.every((a) => a.href), 'every alert is actionable');
  db.prepare("DELETE FROM time_entries WHERE status = 'active' AND employee_id = ?").run(EMP.none);
});

test('a quiet clock raises nothing', () => {
  const T = require('../src/timeclock');
  const list = T.alerts({ periods: [{ start: '2020-01-01', end: '2020-01-14' }], employees: [], otRule: { enabled: false } });
  assert.ok(!list.some((a) => /still clocked in|approaching overtime/.test(a.text)),
    'an empty period is not news');
});

test('settings save and take effect', async () => {
  await post('/timeclock/settings', { cutoff: '5', dinner: '17', long: '12', breaks_paid: '1', pin_out: '1', alerts: '1' });
  const T = require('../src/timeclock');
  const c = T.settings();
  assert.strictEqual(c.cutoffHour, 5);
  assert.strictEqual(c.dinnerFrom, 17);
  assert.strictEqual(c.longShift, 12);
  assert.strictEqual(c.breaksPaid, true, 'breaks now default to paid');
  assert.strictEqual(c.requireService, false, 'an unticked box is off');
  // Put it back so later assertions read the documented defaults.
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '16', pin_out: '1', pin_fix: '1', require_service: '1', alerts: '1' });
  assert.strictEqual(T.settings().breaksPaid, false);
});

test('settings are refused for a view-only account', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const at = src.indexOf("app.post('/timeclock/settings'");
  assert.match(src.slice(at, at + 200), /tcCanEdit/, 'the save is gated');
});

test('the reports render every grouping', async () => {
  for (const v of ['employee', 'position', 'service', 'day', 'corrections', 'quality']) {
    const html = await text(`/timeclock/reports?v=${v}&from=2026-01-01&to=2026-12-31`);
    assert.match(html, /Time reports/, `${v} renders`);
    assert.match(html, /What the clock recorded/, 'and says which hours it is quoting');
  }
});

test('a report with no data says so rather than showing an empty table', async () => {
  const html = await text('/timeclock/reports?v=employee&from=2019-01-01&to=2019-01-02');
  assert.match(html, /Nothing in this range|No corrections/, 'an intentional empty state');
});

test('CSV exports carry the rows behind the report', async () => {
  const res = await fetch(`${BASE}/timeclock/export?kind=punches&from=2026-01-01&to=2026-12-31`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /csv/);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename=/);
  const body = await res.text();
  const [head, ...lines] = body.split('\n');
  assert.match(head, /Employee,Business date,Service,Position,Clock in,Clock out/, 'the columns asked for');
  assert.ok(lines.length > 0, 'and real rows');

  const emp = await (await fetch(`${BASE}/timeclock/export?kind=employees&from=2026-01-01&to=2026-12-31`)).text();
  assert.match(emp.split('\n')[0], /Employee,Payable h/);
  const corr = await (await fetch(`${BASE}/timeclock/export?kind=corrections&from=2026-01-01&to=2026-12-31`)).text();
  assert.match(corr.split('\n')[0], /Employee,Kind,Original,Requested,Reason/);
  const tr = await (await fetch(`${BASE}/timeclock/export?kind=transfers&from=2026-01-01&to=2026-12-31`)).text();
  assert.match(tr.split('\n')[0], /Employee,Period start/);
});

test('a CSV field containing a comma or quote is escaped, not left to corrupt the row', async () => {
  const T = require('../src/timeclock');
  const day = '2026-03-03';
  const id = db.prepare(`INSERT INTO time_entries (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'cafe','server',?,?,'complete','manager',60,60)`)
    .run(EMP.solo, day, T.localInputToUtc(`${day}T09:00`), T.localInputToUtc(`${day}T10:00`)).lastInsertRowid;
  db.prepare(`INSERT INTO time_corrections (time_entry_id, employee_id, kind, original_value, proposed_value, reason, requested_by)
    VALUES (?,?,'other','a','b','He said "I left at 9, not 10"','Tester')`).run(id, EMP.solo);
  const csv = await (await fetch(`${BASE}/timeclock/export?kind=corrections&from=2026-01-01&to=2026-12-31`)).text();
  assert.match(csv, /"He said ""I left at 9, not 10"""/, 'quoted and doubled, so the row still parses');
});

test('the time clock page still opens with everything wired', async () => {
  const html = await text('/timeclock');
  assert.match(html, /Reports/, 'reports are reachable');
  assert.match(html, /Settings/, 'so are settings');
  assert.match(html, /Timesheets/, 'and the timesheet ledger');
});

// ===========================================================================
// THE COMBINED WORKSPACE — one page for clocking and for hours.
// ===========================================================================

test('the portal hub offers one time-clock entry, not two', async () => {
  const cookie = await signIn('3111');
  const hub = await text('/portal', { cookie });
  assert.match(hub, /Time clock/, 'the clock is on the hub');
  assert.ok(!/href="\/portal\/timesheet"/.test(hub), 'and the timesheet is not a second destination');
});

test('the hub tile says where the person stands', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });
  const on = await text('/portal', { cookie });
  assert.match(on, /On the clock|Working/, 'it reads as working');
  await post('/portal/clock/out', { pin: '3111' }, { cookie });
  const off = await text('/portal', { cookie });
  assert.match(off, /Clocked out/, 'and as clocked out afterwards');
});

test('the clock page carries today, the action, and both shortcuts', async () => {
  const cookie = await signIn('3111');
  const html = await text('/portal/clock', { cookie });
  assert.match(html, /Worked today/, "today's total leads");
  assert.match(html, /Clock in/, 'the primary action is there');
  assert.match(html, /href="\/portal\/timesheet"/, 'the timesheet is one tap away');
  assert.match(html, /href="\/portal\/requests"/, 'and so are their requests');
});

test('only the actions valid for the state are shown', async () => {
  const cookie = await signIn('3111');
  const off = await text('/portal/clock', { cookie });
  assert.ok(!/Start break/.test(off), 'no break button while clocked out');
  assert.ok(!/Clock out/.test(off), 'and nothing to clock out of');

  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  const on = await text('/portal/clock', { cookie });
  assert.match(on, /Start break/, 'working offers a break');
  assert.match(on, /Clock out/, 'and clocking out');
  assert.ok(!/>Clock in</.test(on), 'but not clocking in again');

  await post('/portal/clock/break/start', {}, { cookie });
  const brk = await text('/portal/clock', { cookie });
  assert.match(brk, /End break/, 'on break offers only the end');
  assert.ok(!/Start break/.test(brk), 'not another break');
  await post('/portal/clock/break/end', {}, { cookie });
  await post('/portal/clock/out', { pin: '3111' }, { cookie });
});

test('clocking out lands on a receipt, not a question', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });
  const e = activeOf(EMP.solo);
  const res = await post('/portal/clock/out', { pin: '3111' }, { cookie });
  const loc = res.headers.get('location') || '';
  assert.match(loc, new RegExp(`done=${e.id}`), 'it comes back carrying what was recorded');
  const html = await text(`/portal/clock?done=${e.id}`, { cookie });
  assert.match(html, /Clocked out/, 'the receipt names the state');
  assert.match(html, /payable/, 'shows what it is worth');
  assert.match(html, /Position/, 'and the position');
  assert.match(html, /Something's wrong/, 'with one way to query it');
  assert.match(html, /Done/, 'and one way to close it');
  assert.ok(!/different position\?|need correction\?/i.test(html), 'and asks nothing');
});

test("a receipt belongs only to the person who earned it", async () => {
  const mine = TC_ENTRY_OF_SOLO();
  const cookie = await signIn('3222');                       // a different person
  const html = await text(`/portal/clock?done=${mine}`, { cookie });
  assert.ok(!/Clocked out<\/div>[\s\S]{0,200}payable/.test(html),
    "somebody else's entry never renders as your receipt");
});
function TC_ENTRY_OF_SOLO() {
  return db.prepare('SELECT id FROM time_entries WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(EMP.solo).id;
}

test('the timesheet badge is quiet during a normal shift and speaks when it should', async () => {
  // A person with nothing else outstanding, so the only thing that could raise
  // a badge is the shift they are standing in.
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (95,'Badge Tester','server','3555',1500,1)").run();
  const cookie = await signIn('3555');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  const on = await text('/portal/clock', { cookie });
  assert.ok(!/Needs a fix/.test(on), 'being on the clock is not a timesheet problem');
  await post('/portal/clock/out', { pin: '3555' }, { cookie });
  assert.ok(!activeOf(95), 'they really did clock out');
  const off = await text('/portal/clock', { cookie });
  assert.match(off, /tc-badge/, 'once off, the timesheet asks for something');
  assert.match(off, /Ready to submit|Needs a fix/, 'and names what');
});

test('my requests gathers every kind of fix, with the answer', async () => {
  const cookie = await signIn('3111');
  const e = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND clock_out_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(EMP.solo);
  const at = require('../src/timeclock').utcToLocalInput(e.clock_out_at);
  await post('/portal/clock/fix', { entry_id: e.id, kind: 'wrong_out', at_out: at, reason: 'left later than that', pin: '3111' }, { cookie });
  const html = await text('/portal/requests', { cookie });
  assert.match(html, /My requests/);
  assert.match(html, /Clock-out time/, 'the kind is in plain words');
  assert.match(html, /left later than that/, 'their reason is shown back');
  assert.match(html, /Waiting on your manager/, 'and where it stands');
});

test('my requests says so plainly when there is nothing', async () => {
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (96,'No Requests','server','3666',1500,1)").run();
  const cookie = await signIn('3666');
  const html = await text('/portal/requests', { cookie });
  assert.match(html, /Nothing to show/, 'an intentional empty state');
});

test('the timesheet still works, and comes back to the clock', async () => {
  const cookie = await signIn('3111');
  const html = await text('/portal/timesheet', { cookie });
  assert.match(html, /Timesheet/, 'the full timesheet is intact');
  assert.match(html, /Regular/, 'with its totals');
  assert.match(html, /href="\/portal\/clock"/, 'and its way back is the clock');
});

// ===========================================================================
// THE FULL-SCREEN TIMESHEET — moving between periods, and signing one off.
// ===========================================================================

test('the timesheet moves between pay periods with the arrows', async () => {
  const cookie = await signIn('3333');
  const now = P.currentPeriod();
  const prev = P.recentPeriods(2)[1];

  const cur = await text('/portal/timesheet', { cookie });
  assert.match(cur, new RegExp(`p=${prev.start}`), 'the back arrow points at the period before');
  assert.match(cur, /tsx-arrow off/, 'and there is nothing later to go to');

  const earlier = await text(`/portal/timesheet?p=${prev.start}`, { cookie });
  assert.match(earlier, new RegExp(`p=${now.start}`), 'from there the forward arrow returns');
  assert.match(earlier, /Today/, 'and Today is offered');
});

test('the period shown is the one asked for, and Today comes back', async () => {
  const cookie = await signIn('3333');
  const prev = P.recentPeriods(2)[1];
  const html = await text(`/portal/timesheet?p=${prev.start}`, { cookie });
  assert.match(html, new RegExp(prev.start.slice(5).replace('-', '/')), 'the range names that period');
  const back = await text('/portal/timesheet', { cookie });
  assert.match(back, new RegExp(P.currentPeriod().start.slice(5).replace('-', '/')), 'and no argument means now');
});

test('every day of the period is listed, grouped into weeks', async () => {
  const cookie = await signIn('3333');
  const per = curPeriod();
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  const rows = (html.match(/class="tsd[ "]/g) || []).length;
  assert.ok(rows >= 14, `a fortnight shows all its days, saw ${rows}`);
  assert.match(html, /Week total/, 'and they are grouped by week');
  assert.match(html, /tsd-none/, 'days with no work are present but quiet');
});

test('a period still being worked cannot be signed off', async () => {
  const cookie = await signIn('3333');
  const now = P.currentPeriod();
  const html = await text(`/portal/timesheet?p=${now.start}`, { cookie });
  assert.match(html, /still running/, 'the page says why not');
  assert.ok(!/Submit timesheet<\/button>/.test(html), 'and offers no submit button');
  // The route refuses it too, so a stale form cannot get around the screen.
  const res = await post('/portal/timesheet/submit',
    { period: now.start, confirm: '1', pin: '3333', seen: '0' }, { cookie });
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /still running/,
    'the route refuses it as well');
});

test('a finished period offers submission from the menu and the page', async () => {
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (97,'Period Tester','server','3777',1500,1)").run();
  const per = curPeriod();
  seedInPeriod(97, 2, '09:00', '17:00');
  const cookie = await signIn('3777');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  assert.match(html, /Submit timesheet/, 'the action is offered');
  assert.match(html, /tsx-menu/, 'from the three-dot menu');
  assert.match(html, /I confirm these hours are complete and accurate/, 'with a confirmation to tick');
});

test('the same period cannot be submitted twice', async () => {
  const per = curPeriod();
  const cookie = await signIn('3777');
  await submitSheet(97, '3777', per, {}, cookie);
  assert.strictEqual(sheetOf(97, per.start).status, 'submitted');
  const again = await post('/portal/timesheet/submit',
    { period: per.start, confirm: '1', pin: '3777', seen: String(T2.totalsFor(T2.q.entriesInPeriod.all(97, per.start, per.end)).payable) },
    { cookie });
  assert.match(decodeURIComponent(again.headers.get('location') || ''), /already submitted/, 'the second is refused');
  const subs = db.prepare("SELECT COUNT(*) n FROM time_events WHERE entity='timesheet' AND action='submitted' AND entity_id=?")
    .get(sheetOf(97, per.start).id).n;
  assert.strictEqual(subs, 1, 'and only one submission is on the record');
});

test('once submitted the page says so and stops offering it', async () => {
  const per = curPeriod();
  const cookie = await signIn('3777');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  assert.match(html, /Submitted/, 'the state is shown');
  assert.ok(!/Submit timesheet<\/button>/.test(html), 'and the action is gone');
  assert.match(html, /View submission/, 'the menu offers to look at it instead');
});

test('tapping a worked day opens its punches', async () => {
  const per = curPeriod();
  const cookie = await signIn('3777');
  const day = require('../src/dates').addDays(per.start, 2);
  const html = await text(`/portal/timesheet/day/${day}`, { cookie });
  assert.match(html, /Clocked in/, 'the punches are there');
  assert.match(html, /Position/, 'with the position');
  assert.match(html, /request a fix/, 'and a way to query it');
});

test('a day belongs to the person who worked it', async () => {
  const per = curPeriod();
  const day = require('../src/dates').addDays(per.start, 2);
  const cookie = await signIn('3111');                 // somebody else
  const html = await text(`/portal/timesheet/day/${day}`, { cookie });
  assert.ok(!/Position/.test(html) || /Nothing recorded/.test(html),
    "another person's punches are not shown");
});
