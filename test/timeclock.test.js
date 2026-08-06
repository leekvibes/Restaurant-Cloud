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

// A browser gets its CSRF token injected into every form it loads. These tests
// post straight at the routes, so they ask for one the same way the service
// worker does, and cache it per session.
const __csrf = new Map();
async function __token(cookie) {
  const key = cookie || '';
  if (!__csrf.has(key)) {
    const r = await fetch(BASE + '/csrf', { headers: key ? { cookie: key } : {} });
    __csrf.set(key, (await r.text()).trim());
  }
  return __csrf.get(key);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tc-'));
const DB = path.join(dir, 'tc.db');
// Point the modules this file requires at the SAME database the server uses.
// Without it `require('../src/timeclock')` opens the default data.db and every
// query here would read a different restaurant's data.
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
let child, Database, db;

const post = async (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ ...body, _csrf: await __token((headers || {}).cookie) }).toString(),
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

test('clocking out never asks for a PIN, and nothing can turn that back on', async () => {
  // The setting used to exist and default to off. Phase 2B retired it, so this
  // asserts the retirement rather than the switch: posting the old field name
  // must not resurrect the prompt, and a wrong PIN must not stop the punch,
  // because nothing is reading one.
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '16',
    pin_out: '1', pin_fix: '1', require_service: '1', alerts: '1' });
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  const html = await text('/portal/clock', { cookie });
  assert.doesNotMatch(html, /Enter your PIN to clock out/, 'no PIN prompt on the clock screen');
  assert.doesNotMatch(html, /name="pin"/, 'and no PIN field anywhere on it');
  // The confirmation sheet is what makes it deliberate, and it carries the
  // figures rather than a challenge.
  assert.match(html, /data-pes="clockout"/, 'the confirmation sheet is there');
  assert.match(html, /Confirm clock out/, 'with the action spelled out');
  await post('/portal/clock/out', { pin: '0000' }, { cookie });
  assert.ok(!activeOf(EMP.solo), 'a wrong PIN is simply ignored — the punch closes');
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '16',
    pin_fix: '1', require_service: '1', alerts: '1' });
  assert.strictEqual(require('../src/timeclock').settings().pinAtOut, undefined,
    'the setting is gone, not merely off');
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
  assert.match(page, /<select name="position"/, 'they are asked');
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

test('an employee correction needs the PIN, and never edits the punch', async () => {
  const cookie = await signIn('3111');
  const done = entriesOf(EMP.solo).filter((e) => e.status === 'complete')[0];
  const original = done.clock_in_at;

  // The note is optional now. On the sheet somebody actually uses it reads
  // "attach a note to your request" — somewhere to say something useful, not a
  // field standing between them and sending it. What identifies the request is
  // the time they are asking for, and that is still required.
  const at = require('../src/timeclock').utcToLocalInput(done.clock_out_at);

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

test('a manager can add a forgotten punch without justifying it', async () => {
  // A manager is never asked to type a reason. The record still says who added
  // it and when and what it holds — which is what anybody reviewing it later
  // needs. The sentence was friction on the person fixing somebody else's
  // mistake, and it is the thing that made this flow feel like paperwork.
  await post('/timeclock/new', { employee_id: String(EMP.multi), daypart: 'cafe', position: 'server',
    in: '2026-07-20T09:00', out: '2026-07-20T14:00' });
  const e = db.prepare("SELECT * FROM time_entries WHERE business_date = '2026-07-20'").get();
  assert.ok(e, 'the entry is added');
  assert.strictEqual(e.source, 'manager');
  assert.strictEqual(e.status, 'complete');
  assert.strictEqual(e.payable_minutes, 300, 'five hours');
  assert.ok(e.shift_id, 'and linked to that day\'s café shift');
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='entry' AND entity_id=? AND action='manager_added'").get(e.id);
  assert.ok(ev, 'and the audit records that a manager added it');
  assert.ok(ev.actor, 'naming who');
  assert.ok(ev.at, 'and when');
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
// `pin` is accepted and ignored — the route no longer asks for one, and the
// argument is left in place so the twelve call sites below did not all have to
// change. Nothing here sends it: the whole point is that these tests now post
// what the sheet posts.
async function submitSheet(empId, pin, per, extra = {}, cookie) {
  // The staleness token is READ OFF THE PAGE, not recomputed here.
  //
  // This used to recompute the figure the server would compare against, which
  // meant every submit test agreed with the server by construction and none of
  // them proved the form carries what the route wants. That is exactly how a
  // route asking for a PIN the sheet never rendered survived twelve tests. Now
  // the helper opens the timesheet, takes the value out of the rendered form,
  // and posts that — so if the sheet and the route ever disagree again, all of
  // these fail rather than none.
  //
  // A sheet that is not there yields no token, and that is correct: those
  // cases are refused by an earlier check than staleness anyway.
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  const seen = (html.match(/name="seen" value="([^"]*)"/) || [])[1] || '';
  return post('/portal/timesheet/submit',
    { period: per.start, confirm: '1', seen, ...extra }, { cookie });
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
  // Claim the day first.
  //
  // The offset is counted from the start of the CURRENT pay period, so which
  // calendar date it lands on moves as the real date does — and on the days
  // where it lands on one an earlier test already punched, the two punches
  // overlap and the database refuses the second. That is the overlap rule doing
  // its job on a fixture that was quietly assuming an empty day; it stayed
  // invisible until the date rolled far enough for the two to meet. Every
  // caller uses its own (employee, offset), so clearing is safe and makes the
  // seed mean the same thing whatever day the suite is run on.
  db.prepare('DELETE FROM time_breaks WHERE time_entry_id IN (SELECT id FROM time_entries WHERE employee_id = ? AND business_date = ?)')
    .run(empId, day);
  db.prepare('DELETE FROM time_entries WHERE employee_id = ? AND business_date = ?').run(empId, day);
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
  assert.match(html, /Days worked/, 'with the period summary');
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

test('submitting needs the confirmation, and no PIN', async () => {
  // The PIN was dropped by decision. It had never worked: the route demanded
  // one and the sheet has no field for it, so every submission from the portal
  // was refused with "That PIN did not match." and nothing was written — and
  // each attempt counted against that person's PIN rate-limit bucket.
  //
  // The cookie already proves who this is. The tick box is what makes it a
  // signature rather than a save, so that is what stays.
  const per = curPeriod();
  const cookie = await signIn('3222');
  seedInPeriod(EMP.multi, 2, '10:00', '14:00');

  // No PIN in the payload at all — exactly what the sheet sends.
  await post('/portal/timesheet/submit', { period: per.start, seen: '0' }, { cookie });
  assert.notStrictEqual((sheetOf(EMP.multi, per.start) || {}).status, 'submitted',
    'unticked box, no signature');

  await submitSheet(EMP.multi, null, per, {}, cookie);
  assert.strictEqual((sheetOf(EMP.multi, per.start) || {}).status, 'submitted',
    'and with the box ticked it goes through, PIN or no PIN');
});

test('the submit sheet posts everything the route needs', async () => {
  // The guard that was missing. Every submit test passed a `pin` the sheet
  // does not have, so they all exercised a payload the UI never sends and the
  // real one was broken for as long as the PIN check existed.
  //
  // This reads the fields out of the rendered form and posts THOSE — so a route
  // that starts asking for something the sheet does not carry fails here.
  const emp = 219;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3219',1500,1)")
    .run(emp, 'Form Payload');
  const per = curPeriod();
  seedInPeriod(emp, 3, '09:00', '17:00');
  const cookie = await signIn('3219');

  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  const sheet = (html.match(/data-pes="submit"[\s\S]*?<\/form>/) || [''])[0];
  assert.ok(sheet, 'the submit sheet is on the page');

  // Every name=value the form carries, as a browser would send it.
  const body = {};
  for (const m of sheet.matchAll(/name="([a-z_]+)"(?:\s+value="([^"]*)")?/g)) {
    body[m[1]] = m[2] !== undefined ? m[2] : '';
  }
  assert.ok('period' in body && 'seen' in body, 'it carries the period and the figure it was drawn with');
  assert.ok(!('pin' in body), 'and no PIN — the route must not ask for one');
  body.confirm = '1';                       // the one thing the person does
  delete body._csrf;                        // supplied by post()

  const res = await post('/portal/timesheet/submit', body, { cookie });
  assert.strictEqual(res.status, 302);
  const where = decodeURIComponent(res.headers.get('location'));
  assert.ok(!/err=/.test(where), `the form's own fields are enough (got ${where})`);
  assert.strictEqual((sheetOf(emp, per.start) || {}).status, 'submitted', 'and the signature landed');
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
  // Scoped to the hub's own action rows. The shell's bottom nav carries a
  // Timesheet tab on every screen — that is persistent chrome, not a second
  // destination competing with the clock in the list of things to do here.
  // Home summarises the clock and hands off to it — one status card, one
  // action, and that action opens /portal/clock. The bottom nav's Timesheet
  // tab is persistent chrome on every screen, not a second destination
  // competing with the clock in a list of things to do here.
  const body = (hub.match(/<div class="pt-body tc-body">[\s\S]*?(?=<nav class="pt-tabs)/) || [hub])[0];
  assert.match(body, /class="tcc tcc-/, 'the status card is the clock entry');
  assert.strictEqual((body.match(/href="\/portal\/clock"/g) || []).length, 1,
    'exactly one way into the clock from Home, and it is the card');
  assert.ok(!/class="tc-row" href="\/portal\/timesheet"/.test(body),
    'and the timesheet is not a Home row');
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
  // The tile carries the period it is talking about, so tapping the badge lands
  // on the screen the badge means rather than on whatever is running today.
  assert.match(html, /href="\/portal\/timesheet(\?p=[^"]*)?"/, 'the timesheet is one tap away');
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
  assert.match(html, /Waiting/, 'and where it stands');
  assert.match(html, /class="tc-diff"/, 'with the original beside what they asked for');
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
  assert.match(html, /Days worked/, 'with its totals');
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
  assert.match(cur, /tsp-arrow off/, 'and there is nothing later to go to');

  const earlier = await text(`/portal/timesheet?p=${prev.start}`, { cookie });
  assert.match(earlier, new RegExp(`p=${now.start}`), 'from there the forward arrow returns');
  // And the selector jumps, so a year back is one gesture rather than 26 taps.
  assert.match(earlier, /<select class="tsp-sel"/, 'the period selector is there');
  assert.ok((earlier.match(/<option value="20/g) || []).length >= 26,
    'listing a year of periods, which is what retiring Time history has to replace');
});

test('the period shown is the one asked for, and Today comes back', async () => {
  const cookie = await signIn('3333');
  const prev = P.recentPeriods(2)[1];
  const html = await text(`/portal/timesheet?p=${prev.start}`, { cookie });
  assert.ok(html.includes(`<option value="${prev.start}" selected`), 'the selector names that period');
  const back = await text('/portal/timesheet', { cookie });
  assert.ok(back.includes(`<option value="${P.currentPeriod().start}" selected`), 'and no argument means now');
});

test('the timesheet lists the days worked, grouped into weeks', async () => {
  // Worked days only. Fourteen rows with ten of them "--" was a period
  // pretending to be a spreadsheet — the empty days carried no information and
  // buried the ones that did.
  const cookie = await signIn('3333');
  const per = curPeriod();
  const worked = new Set(T2.q.entriesInPeriod.all(EMP.none, per.start, per.end).map((e) => e.business_date));
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  const rows = (html.match(/href="\/portal\/timesheet\/day\//g) || []).length;
  assert.strictEqual(rows, worked.size, `one row per day worked, saw ${rows} for ${worked.size} days`);
  assert.ok(rows < 14, 'and not one per calendar day');
  assert.match(html, /Week of /, 'grouped by week');
  assert.ok(!/tsd-none/.test(html), 'no empty-day rows at all');
  // The way to reach a day nobody worked is the action, not a row.
  assert.match(html, /Add a day you worked/, 'with a way in for a day that has none');
  assert.match(html, /data-pes="new-/, 'which opens the same add sheet the day screen uses');
});

test('weekly overtime is shown on the week, never on the day', async () => {
  // The approved rule: overtime is a weekly threshold, so a per-day overtime
  // figure is an artefact of the order the days were added up in. It belongs on
  // the week and on the period, where the calculation is truthful.
  const emp = 240;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3240',1500,1)")
    .run(emp, 'Overtime Week');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ot_enabled','1')").run();
  const per = curPeriod();
  for (let d = 0; d < 6; d += 1) seedInPeriod(emp, d, '09:00', '18:00');   // 6 x 9h = 54h in week one
  const cookie = await signIn('3240');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  assert.match(html, /<span>Overtime<\/span>/, 'the period card names overtime');
  assert.match(html, /OT<\/b>|OT<\/i>| OT</, 'and the week header carries it');
  // No day row claims any overtime of its own.
  const dayRows = html.match(/<a class="tc-row[^"]*" href="\/portal\/timesheet\/day\/[\s\S]*?<\/a>/g) || [];
  assert.ok(dayRows.length, 'there are day rows');
  for (const r of dayRows) assert.ok(!/OT/.test(r), 'and none of them mentions overtime');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ot_enabled','0')").run();
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
  assert.ok(!/tsx-menu/.test(html), 'on the card, not hidden in a three-dot menu');
  assert.match(html, /data-pes-open="submit"/, 'and it opens the shared sheet');
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
  assert.match(html, /class="tcc tcc-done"/, 'the card carries the state itself');
  assert.match(html, /submitted /, 'with when it was signed');
});

test('tapping a worked day opens its punches', async () => {
  const per = curPeriod();
  const cookie = await signIn('3777');
  const day = require('../src/dates').addDays(per.start, 2);
  const html = await text(`/portal/timesheet/day/${day}`, { cookie });
  assert.match(html, /Clocked in/, 'the punches are there');
  assert.match(html, /Position/, 'with the position');
  // The way to query it is the edit itself, on the shift, not a link to a
  // third screen. (It used to read "Open or request a fix ›".)
  assert.match(html, /data-pes-open="/, 'and a way to change it, right there');
});

test('a day belongs to the person who worked it', async () => {
  const per = curPeriod();
  const day = require('../src/dates').addDays(per.start, 2);
  const cookie = await signIn('3111');                 // somebody else
  const html = await text(`/portal/timesheet/day/${day}`, { cookie });
  assert.ok(!/Position/.test(html) || /Nothing recorded/.test(html),
    "another person's punches are not shown");
});

test('a finished period is submittable, and the portal says where', async () => {
  // The bug: "Ready to submit" on the hub, and a timesheet page with no submit
  // button anywhere on it. Two different answers to "can this be submitted" —
  // the hub's ignored whether the period had ended, and the page's did not. So
  // mid-period the badge sent people to a screen where the button is correctly
  // hidden, and the moment the period ended the hub moved on to the new empty
  // one, so the sheet that did need signing never got a badge at all. There was
  // no point in a period's life where both agreed.
  //
  // Its own id and PIN: 91 to 97 are all spoken for in this file, and an
  // INSERT OR IGNORE onto a taken id leaves signIn holding somebody else's PIN
  // and the whole test asserting against the wrong person's portal.
  const emp = 186;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3186',1500,1)")
    .run(emp, 'Submit Case');
  const D2 = require('../src/dates');
  const done = P.recentPeriods(2)[1];            // the period before this one — finished
  const day = D2.addDays(done.start, 1);
  db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',480,480)`)
    .run(emp, day, `${day} 17:00:00`, `${D2.addDays(day, 1)} 01:00:00`);

  const cookie = await signIn('3186');

  // Landing on the period they are working still shows that period — somebody
  // checking today's hours must not have the ground moved under them — but it
  // now says the finished one is waiting, and links straight to it.
  const running = await text('/portal/timesheet', { cookie });
  assert.match(running, /is ready to submit/i, 'the running period points at the one that is waiting');
  assert.match(running, new RegExp(`/portal/timesheet\\?p=${done.start}`), 'and links to it');

  // And on that period, the button actually exists.
  const finished = await text(`/portal/timesheet?p=${done.start}`, { cookie });
  assert.match(finished, /Submit timesheet/, 'the submit button is there');
  assert.match(finished, /action="\/portal\/timesheet\/submit"/, 'with the form behind it');

  // Which is the whole point: it goes through. Sending what the form carries,
  // including the hours it was drawn with — the route compares them against the
  // live total so a signature can never land on figures that moved while the
  // page was open.
  const seen = (finished.match(/name="seen" value="([^"]+)"/) || [])[1];
  assert.ok(seen, 'the form carries the hours being signed for');
  assert.match(seen, /^[0-9a-f]{16}$/, 'as a fixed-width digest, not a float');
  const res = await post('/portal/timesheet/submit',
    { period: done.start, pin: '3186', confirm: '1', seen }, { cookie });
  assert.strictEqual(res.status, 302);
  const sheet = db.prepare('SELECT * FROM timesheets WHERE employee_id = ? AND period_start = ?').get(emp, done.start);
  assert.strictEqual(sheet.status, 'submitted', 'and the timesheet is signed');
});

test('reopening writes its own line rather than demanding one', async () => {
  // A manager is never asked to justify a correction. Reopening a signed period
  // is the sharpest case of that — it used to refuse outright without a typed
  // sentence, which is the moment the flow stopped feeling like fixing a
  // timesheet and started feeling like filing a form. The act is the statement:
  // somebody with the authority to reopen did, and it is stamped with their
  // name and the moment.
  const emp = 187;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3187',1500,1)")
    .run(emp, 'Reopen Case');
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const day = D2.addDays(per.start, 2);
  db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',480,480)`)
    .run(emp, day, `${day} 17:00:00`, `${D2.addDays(day, 1)} 01:00:00`);
  db.prepare(`INSERT INTO timesheets (employee_id, period_start, period_end, status)
    VALUES (?,?,?,'submitted') ON CONFLICT(employee_id, period_start) DO UPDATE SET status='submitted'`)
    .run(emp, per.start, per.end);

  await post(`/payroll/timesheets/${emp}/approve`, { period: per.start, override: 'approved for the test' });
  assert.strictEqual(sheetRow(emp, per.start).status, 'approved', 'signed off');

  await post(`/payroll/timesheets/${emp}/reopen`, { period: per.start });      // no reason at all
  const s = sheetRow(emp, per.start);
  assert.strictEqual(s.status, 'submitted', 'it reopens anyway');
  assert.match(s.reopen_reason, /to correct the timesheet/, 'having written its own line');
  assert.match(s.reopen_reason, /Reopen Case|reopened by/, 'that names who did it');
});

test('one request carries both ends of a shift, and lands together', async () => {
  // Every other correction kind changes exactly one thing, which is why fixing
  // a shift meant choosing a field first and filing twice when both were wrong.
  // This carries whichever ends were changed and applies them in one move — so
  // the shift is never briefly half-corrected, and the manager approves one
  // thing rather than two halves of one thing.
  const emp = 188;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3188',1500,1)")
    .run(emp, 'Both Ends');
  const day = '2026-05-04';
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',300,300)`)
    .run(emp, day, `${day} 21:00:00`, `${day} 02:00:00`.replace(day, '2026-05-05')).lastInsertRowid;

  const cookie = await signIn('3188');
  const res = await post('/portal/clock/fix', {
    entry_id: String(id), kind: 'shift_times', pin: '3188',
    at_in: `${day}T16:30`, at_out: `${day}T23:15`,          // both ends, no note
  }, { cookie });
  assert.strictEqual(res.status, 302);

  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(id);
  assert.ok(c, 'a request was filed');
  assert.strictEqual(c.kind, 'shift_times');
  assert.ok(!c.reason, 'and the note really was optional');
  const payload = JSON.parse(c.payload);
  assert.ok(payload.in && payload.out, 'carrying both ends');

  // Approving applies both, in one transaction.
  await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);
  assert.strictEqual(e.clock_in_at, payload.in, 'the start moved');
  assert.strictEqual(e.clock_out_at, payload.out, 'and the end moved with it');
  assert.strictEqual(e.payable_minutes, 405, 'six and three quarter hours, recalculated');

  // Both halves are in the history, not one.
  const acts = db.prepare("SELECT action FROM time_events WHERE entity='entry' AND entity_id=?").all(id).map((x) => x.action);
  assert.ok(acts.includes('clock_in_corrected'), 'the start is in the audit');
  assert.ok(acts.includes('clock_out_corrected'), 'and so is the end');
});

test('a request can move just one end, and leaves the other alone', async () => {
  const emp = 189;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3189',1500,1)")
    .run(emp, 'One End');
  const day = '2026-05-06';
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',300,300)`)
    .run(emp, day, `${day} 21:00:00`, `${day} 23:00:00`).lastInsertRowid;
  const was = db.prepare('SELECT clock_in_at FROM time_entries WHERE id = ?').get(id).clock_in_at;

  const cookie = await signIn('3189');
  await post('/portal/clock/fix', { entry_id: String(id), kind: 'shift_times', pin: '3189',
    at_out: `${day}T20:30`, note: 'stayed late' }, { cookie });   // end only
  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(id);
  // `was` is provenance — the shift as it stood when they asked — and rides
  // alongside. What was REQUESTED is still just the end.
  const asked = Object.keys(JSON.parse(c.payload)).filter((k) => k !== 'was');
  assert.deepStrictEqual(asked, ['out'], 'only the end travelled');

  await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);
  assert.strictEqual(e.clock_in_at, was, 'the start is untouched');
  assert.strictEqual(e.clock_out_at.slice(11, 16), '00:30', 'and the end moved');
});

// ── The employee's own screen ────────────────────────────────────────────────
// The route tests above prove the request works. These prove the SHEET works —
// that the thing a person actually taps offers both times, shows a total that
// agrees with the pay, and is offered on every shift they can see rather than
// only the one they just left.

test('the edit sheet offers both ends, dated, with a total that nets the break', async () => {
  const emp = 190;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3190',1500,1)")
    .run(emp, 'Sheet Reader');
  const day = '2026-05-07';
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, unpaid_break_min, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',455,30,425)`)
    .run(emp, day, `${day} 20:45:00`, '2026-05-08 04:20:00').lastInsertRowid;
  db.prepare(`INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at, paid, raw_minutes)
    VALUES (?,?,?,?,0,30)`).run(id, emp, `${day} 23:00:00`, `${day} 23:30:00`);

  const cookie = await signIn('3190');
  const html = await text(`/portal/clock/entry/${id}`, { cookie });

  // Four controls, because a shift that ends after midnight cannot be said with
  // two times alone. The dates carry the "next day" without a word of copy.
  for (const f of ['data-pes-ind', 'data-pes-int', 'data-pes-outd', 'data-pes-outt']) {
    assert.ok(html.includes(f), `the sheet has ${f}`);
  }
  // The button must NAME the shift it opens. Merely having the attribute is
  // what a valueless data-pes-open had, and it opened nothing at all.
  assert.ok(html.includes(`data-pes-open="${id}"`), 'the button names its shift');
  assert.ok(html.includes(`data-pes="${id}"`), 'and a sheet answers to that name');
  assert.match(html, /name="kind" value="shift_times"/, 'one kind, not a menu of seven');
  assert.match(html, /name="pin"/, 'the PIN is still asked for');
  assert.match(html, /Send for approval/, 'and the button says what it does');

  // The end is dated the NEXT day, unprompted — 8:45pm to 4:20am UTC is an
  // evening shift that finished after midnight.
  assert.match(html, /data-pes-outd value="2026-05-08"/, 'the end carries its own date');

  // The total the sheet will show must be the total the shift pays. It reads
  // the break rows, so a 30-minute unpaid break comes off before it is shown.
  assert.match(html, /data-unpaid="30"/, 'the unpaid break reaches the arithmetic');
});

test('the sheet is offered on an approved shift, and the request queues', async () => {
  // "Employees never directly modify approved records; they send a request."
  // The screen has to stay open on a signed-off period for that to mean
  // anything — otherwise the only way to fix a mistake payroll already passed
  // is to find a manager, which is the thing this replaces.
  const emp = 191;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3191',1500,1)")
    .run(emp, 'Locked Period');
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const day = D2.addDays(per.start, 3);
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',300,300)`)
    .run(emp, day, `${day} 21:00:00`, `${day} 23:00:00`).lastInsertRowid;
  db.prepare(`INSERT INTO timesheets (employee_id, period_start, period_end, status)
    VALUES (?,?,?,'approved') ON CONFLICT(employee_id, period_start) DO UPDATE SET status='approved'`)
    .run(emp, per.start, per.end);

  const cookie = await signIn('3191');
  const html = await text(`/portal/clock/entry/${id}`, { cookie });
  assert.ok(html.includes(`data-pes-open="${id}"`), 'the sheet is still offered');

  const before = db.prepare('SELECT clock_in_at FROM time_entries WHERE id = ?').get(id).clock_in_at;
  const res = await post('/portal/clock/fix', { entry_id: String(id), kind: 'shift_times',
    pin: '3191', at_in: `${day}T16:00`, note: 'started earlier' }, { cookie });
  assert.strictEqual(res.status, 302, 'the request is taken');

  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(id);
  assert.strictEqual(c.decision, 'pending', 'and it waits');
  assert.strictEqual(db.prepare('SELECT clock_in_at FROM time_entries WHERE id = ?').get(id).clock_in_at,
    before, 'the approved record did not move an inch');
});

test('the sheet is withheld while the shift is still running', async () => {
  const emp = 192;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3192',1500,1)")
    .run(emp, 'Still On');
  const day = '2026-05-09';
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, status, source)
    VALUES (?,?,'dinner','server',?, 'active','employee')`)
    .run(emp, day, `${day} 21:00:00`).lastInsertRowid;

  const cookie = await signIn('3192');
  const html = await text(`/portal/clock/entry/${id}`, { cookie });
  assert.ok(!/data-pes-open/.test(html), 'no edit button on a shift in progress');
  assert.match(html, /clock out first/i, 'and it says why');
});

test('a request cannot invert a shift, or land on top of another one', async () => {
  const emp = 193;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3193',1500,1)")
    .run(emp, 'Bad Times');
  const day = '2026-05-10';
  const mk = (a, b) => db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',120,120)`).run(emp, day, a, b).lastInsertRowid;
  const first = mk(`${day} 15:00:00`, `${day} 17:00:00`);
  const second = mk(`${day} 21:00:00`, `${day} 23:00:00`);

  const cookie = await signIn('3193');

  // End before start. Refused where it is typed, so nothing is ever filed for a
  // manager to read, puzzle over and reject. (The sheet's own arithmetic says
  // "check the times" and will not submit either — this is the second layer,
  // for anything that reaches the route without going through the screen.)
  const bad = await post('/portal/clock/fix', { entry_id: String(second), kind: 'shift_times',
    pin: '3193', at_in: `${day}T18:00`, at_out: `${day}T16:00` }, { cookie });
  assert.strictEqual(bad.status, 302);
  assert.match(decodeURIComponent(bad.headers.get('location')), /end has to be after the start/i,
    'and it says which way round they go');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE time_entry_id = ?')
    .get(second).n, 0, 'nothing was filed');

  // Dragged back over the afternoon shift.
  await post('/portal/clock/fix', { entry_id: String(second), kind: 'shift_times', pin: '3193',
    at_in: `${day}T11:30`, at_out: `${day}T14:00` }, { cookie });
  let d = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(second);
  await post(`/timeclock/correction/${d.id}`, { decision: 'approved' });
  d = db.prepare('SELECT * FROM time_corrections WHERE id = ?').get(d.id);
  assert.ok(d.apply_error, 'the overlap was refused too');
  assert.match(d.apply_error, /overlap/i, 'naming the reason');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE employee_id = ? AND business_date = ?')
    .get(emp, day).n, 2, 'and both shifts survive, unmerged');
  assert.ok(first, 'the afternoon shift is still there');
});

test('every shift on a day carries its own sheet, and they do not collide', async () => {
  // Coming from the timesheet, a day is where you land — and a double is two
  // shifts on it. The sheet is per-shift for that reason: scoped handles, not
  // ids, so the second sheet's arithmetic is wired to the second shift rather
  // than silently to the first.
  const emp = 194;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3194',1500,1)")
    .run(emp, 'Double Day');
  const day = '2026-05-11';
  const mk = (a, b, brk, bs, be) => {
    const id = db.prepare(`INSERT INTO time_entries
      (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, unpaid_break_min, payable_minutes)
      VALUES (?,?,'dinner','server',?,?, 'complete','manager',240,?,?)`)
      .run(emp, day, a, b, brk, 240 - brk).lastInsertRowid;
    if (brk) {
      db.prepare(`INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at, paid, raw_minutes)
        VALUES (?,?,?,?,0,?)`).run(id, emp, bs, be, brk);
    }
    return id;
  };
  const lunch = mk(`${day} 15:00:00`, `${day} 19:00:00`, 0);
  const dinner = mk(`${day} 22:00:00`, '2026-05-12 02:00:00', 30, `${day} 23:00:00`, `${day} 23:30:00`);

  const cookie = await signIn('3194');
  const html = await text(`/portal/timesheet/day/${day}`, { cookie });

  // One button and one sheet per shift, each naming its own entry.
  for (const id of [lunch, dinner]) {
    assert.ok(html.includes(`data-pes-open="${id}"`), `shift ${id} has its own button`);
    assert.ok(html.includes(`data-pes="${id}"`), `and its own sheet`);
  }
  // Handles are scoped, never ids — two of any id on one page is a broken page.
  assert.ok(!/id="pes-/.test(html), 'no global ids to collide');
  // The break belongs to the shift that took it, not to the day.
  assert.match(html, new RegExp(`data-pes="${dinner}"[\\s\\S]*?data-unpaid="30"`), 'the dinner sheet knows its break');
  assert.match(html, new RegExp(`data-pes="${lunch}"[\\s\\S]*?data-unpaid="0"`), 'the lunch sheet has none');
  // Two edit buttons, plus the one that adds another shift to the same day.
  assert.strictEqual((html.match(/data-pes-open="/g) || []).length, 3, 'two edits and an add');
  assert.strictEqual((html.match(/data-pes-open="new-/g) || []).length, 1, 'one of which adds');
  // One script for the page however many sheets are on it.
  assert.strictEqual((html.match(/function count\(lay\)/g) || []).length, 1, 'one script');

  // A request from the day view lands on the shift it was opened from, and the
  // other shift on that day does not move.
  const wasLunch = db.prepare('SELECT clock_in_at FROM time_entries WHERE id = ?').get(lunch).clock_in_at;
  await post('/portal/clock/fix', { entry_id: String(dinner), kind: 'shift_times', pin: '3194',
    at_in: `${day}T17:00`, note: 'from the timesheet' }, { cookie });
  const c = db.prepare('SELECT * FROM time_corrections ORDER BY id DESC').get();
  assert.strictEqual(c.time_entry_id, dinner, 'filed against the right shift');
  assert.strictEqual(db.prepare('SELECT clock_in_at FROM time_entries WHERE id = ?').get(lunch).clock_in_at,
    wasLunch, 'and the other shift on that day is untouched');
});

test('a day with nothing on it offers the add sheet, and nothing to edit', async () => {
  const emp = 195;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3195',1500,1)")
    .run(emp, 'Day Off');
  const cookie = await signIn('3195');
  const day = '2026-05-12';
  const html = await text(`/portal/timesheet/day/${day}`, { cookie });
  assert.match(html, /Nothing recorded on this day/);
  // Exactly one button, and it is the one that asks for a shift. There is
  // nothing to edit on a day with no punches — an edit sheet here would be a
  // sheet wired to a shift that does not exist.
  assert.strictEqual((html.match(/data-pes-open="/g) || []).length, 1, 'one button');
  assert.ok(html.includes(`data-pes-open="new-${day}"`), 'and it adds');
});

// ── A shift nobody clocked ───────────────────────────────────────────────────
// Forgot to punch in, tablet was down, called in and nobody set it up. Every
// other request kind edits a punch; this one asks for the punch itself. What
// must stay true is that it is still a REQUEST — nothing reaches the clock
// until a manager approves, and approving goes through the same door as a
// manager typing it in by hand.

test('asking for a shift writes nothing, and approving it makes one', async () => {
  const emp = 196;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3196',1500,1)")
    .run(emp, 'Never Clocked');
  const day = '2026-05-13';
  const cookie = await signIn('3196');

  const res = await post('/portal/clock/add', { pin: '3196', position: 'server', daypart: 'dinner',
    at_in: `${day}T17:00`, at_out: `${day}T23:30`, note: 'tablet was down' }, { cookie });
  assert.strictEqual(res.status, 302);

  const c = db.prepare("SELECT * FROM time_corrections WHERE employee_id = ? AND kind = 'new_shift'").get(emp);
  assert.ok(c, 'a request was filed');
  assert.strictEqual(c.time_entry_id, null, 'against no entry, because there is none');
  assert.strictEqual(c.decision, 'pending');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE employee_id = ?').get(emp).n, 0,
    'and the clock is untouched — this is a request, not an edit');

  await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  const e = db.prepare('SELECT * FROM time_entries WHERE employee_id = ?').get(emp);
  assert.ok(e, 'now there is a punch');
  assert.strictEqual(e.raw_minutes, 390, 'six and a half hours');
  assert.strictEqual(e.payable_minutes, 390);
  assert.strictEqual(e.business_date, day);
  assert.strictEqual(e.position, 'server');
  assert.ok(e.shift_id, 'landed on the service, not floating free');

  // The hours reached the shift row — which is the payroll basis AND the
  // tip-split weight. An entry that never gets there pays nobody.
  const wr = db.prepare('SELECT hours, hours_source FROM work WHERE shift_id = ? AND employee_id = ?').get(e.shift_id, emp);
  assert.ok(wr, 'the person is on the shift');
  assert.strictEqual(wr.hours, 6.5, 'with the hours');
  assert.strictEqual(wr.hours_source, 'clock');

  // The request now points at what it made, and the history says where it came from.
  assert.strictEqual(db.prepare('SELECT time_entry_id FROM time_corrections WHERE id = ?').get(c.id).time_entry_id, e.id);
  const acts = db.prepare("SELECT action FROM time_events WHERE entity='entry' AND entity_id=?").all(e.id).map((x) => x.action);
  assert.ok(acts.includes('created_from_request'), 'the entry knows it came from a request');
});

test('rejecting a shift request creates nothing at all', async () => {
  const emp = 197;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3197',1500,1)")
    .run(emp, 'Turned Down');
  const cookie = await signIn('3197');
  await post('/portal/clock/add', { pin: '3197', position: 'server', daypart: 'dinner',
    at_in: '2026-05-14T17:00', at_out: '2026-05-14T22:00' }, { cookie });
  const c = db.prepare("SELECT * FROM time_corrections WHERE employee_id = ? AND kind='new_shift'").get(emp);

  await post(`/timeclock/correction/${c.id}`, { decision: 'rejected', note: 'you were not in' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE employee_id = ?').get(emp).n, 0,
    'no punch was made');
  const after = db.prepare('SELECT decision, time_entry_id FROM time_corrections WHERE id = ?').get(c.id);
  assert.strictEqual(after.decision, 'rejected');
  assert.strictEqual(after.time_entry_id, null, 'and nothing to link it to');
});

test('a shift request that would double-count is refused, twice over', async () => {
  const emp = 198;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3198',1500,1)")
    .run(emp, 'Already There');
  const day = '2026-05-15';
  db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',240,240)`)
    .run(emp, day, `${day} 21:00:00`, `${day} 23:00:00`);

  const cookie = await signIn('3198');
  // Refused where it is typed, so it never becomes a manager's problem.
  const res = await post('/portal/clock/add', { pin: '3198', position: 'server', daypart: 'dinner',
    at_in: `${day}T16:30`, at_out: `${day}T20:00` }, { cookie });
  assert.match(decodeURIComponent(res.headers.get('location')), /overlap/i, 'it says why');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM time_corrections WHERE employee_id=? AND kind='new_shift'").get(emp).n, 0,
    'and nothing was filed');

  // And refused again on approval, for anything that got filed before the
  // clashing punch existed. Filed clean, then the punch moves under it.
  const other = '2026-05-16';
  await post('/portal/clock/add', { pin: '3198', position: 'server', daypart: 'dinner',
    at_in: `${other}T17:00`, at_out: `${other}T22:00` }, { cookie });
  const c = db.prepare("SELECT * FROM time_corrections WHERE employee_id=? AND kind='new_shift'").get(emp);
  assert.ok(c, 'that one was taken');
  db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',120,120)`)
    .run(emp, other, `${other} 22:00:00`, `${other} 23:59:00`);   // now it clashes

  await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  const after = db.prepare('SELECT decision, apply_error, time_entry_id FROM time_corrections WHERE id = ?').get(c.id);
  assert.ok(after.apply_error, 'the approval refused it');
  assert.match(after.apply_error, /overlap/i);
  assert.strictEqual(after.time_entry_id, null, 'and made no punch');
});

test('a shift cannot be added into a period payroll has signed', async () => {
  // The widest way into a signed period would be adding hours rather than
  // moving them. Adding five next to the eight on a signed sheet moves the
  // total exactly as much as editing the eight.
  const emp = 199;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3199',1500,1)")
    .run(emp, 'Signed Off');
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const day = D2.addDays(per.start, 4);
  const cookie = await signIn('3199');
  await post('/portal/clock/add', { pin: '3199', position: 'server', daypart: 'dinner',
    at_in: `${day}T17:00`, at_out: `${day}T22:00` }, { cookie });
  const c = db.prepare("SELECT * FROM time_corrections WHERE employee_id=? AND kind='new_shift'").get(emp);
  assert.ok(c, 'the request is taken — a signed period is still requestable');

  db.prepare(`INSERT INTO timesheets (employee_id, period_start, period_end, status)
    VALUES (?,?,?,'approved') ON CONFLICT(employee_id, period_start) DO UPDATE SET status='approved'`)
    .run(emp, per.start, per.end);

  await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE employee_id = ?').get(emp).n, 0,
    'but approving it does not slip a shift into a signed period');
  assert.strictEqual(db.prepare('SELECT decision FROM time_corrections WHERE id = ?').get(c.id).decision, 'pending',
    'it stays pending until the period is reopened');
});

test('a shift request can only name a position that person actually works', async () => {
  const emp = 200;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3200',1500,1)")
    .run(emp, 'Not A Chef');
  const cookie = await signIn('3200');
  const res = await post('/portal/clock/add', { pin: '3200', position: 'manager', daypart: 'dinner',
    at_in: '2026-05-17T17:00', at_out: '2026-05-17T22:00' }, { cookie });
  assert.match(decodeURIComponent(res.headers.get('location')), /position/i, 'refused, by name');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM time_corrections WHERE employee_id=?").get(emp).n, 0);
});

test('an empty day is reachable from the timesheet, and offers the add sheet', async () => {
  const emp = 201;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3201',1500,1)")
    .run(emp, 'Blank Day');
  const cookie = await signIn('3201');
  const day = '2026-05-18';
  const html = await text(`/portal/timesheet/day/${day}`, { cookie });
  assert.match(html, /Nothing recorded on this day/);
  assert.ok(html.includes(`data-pes-open="new-${day}"`), 'with a way to add one');
  assert.ok(html.includes(`data-pes="new-${day}"`), 'and a sheet behind it');
  assert.match(html, /name="position"/, 'asking which position');
  assert.match(html, /name="daypart"/, 'and which service');

  // The timesheet no longer lists empty days at all — it offers the action
  // instead, and that action opens the SAME add sheet, with the date editable.
  // This person has worked nothing, so their timesheet has no day rows and the
  // add sheet is the only way in. It has to be there.
  const ts = await text('/portal/timesheet', { cookie });
  assert.ok(!/href="#"[^>]*aria-disabled/.test(ts), 'no dead day rows');
  assert.ok(!/href="\/portal\/timesheet\/day\//.test(ts), 'and no rows for days nobody worked');
  assert.match(ts, /Add a day you worked/, 'the way in is the action');
  assert.match(ts, /data-pes="new-/, 'which opens the add sheet');
  assert.match(ts, /No hours in this period/, 'with an intentional empty state');
});

// ── Hours that live on the shift sheets, not on a punch ──────────────────────
// Anyone whose hours a manager entered on the shift rather than clocking has no
// time_entries at all. The period total counted those hours; everything else on
// the timesheet asked only about punches. The result was a full period total
// above fourteen rows of "--", no submit button, and days that opened onto
// "Nothing recorded".

test('shift-sheet hours show on the day they were worked, not just in the total', async () => {
  const emp = 202;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3202',1500,1)")
    .run(emp, 'Sheet Hours');
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const days = [0, 1, 2].map((i) => D2.addDays(per.start, i));
  for (const day of days) {
    db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?,'dinner','open')").run(day);
    const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'dinner'").get(day);
    db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hours_source)
      VALUES (?,?,'server',8,'manager')
      ON CONFLICT(shift_id, employee_id) DO UPDATE SET hours = 8, hours_source = 'manager'`).run(sh.id, emp);
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE employee_id = ?').get(emp).n, 0,
    'not a single punch — the whole point');

  const cookie = await signIn('3202');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });

  // Twenty-four hours, and they are on three days rather than nowhere.
  assert.match(html, /24h 0m/, 'the period total is there');
  const dayTotals = [...html.matchAll(/href="\/portal\/timesheet\/day\/[\s\S]*?<span class="tc-row-r"><b>([^<]+)<\/b>/g)]
    .map((m) => m[1]);
  assert.strictEqual(dayTotals.length, 3, `three day rows, one per day worked (got ${dayTotals.length})`);
  assert.deepStrictEqual([...new Set(dayTotals)], ['8h 0m'], 'eight hours each');
  assert.match(html, /on the shift sheet/, 'and each says where the hours came from');
  assert.ok(!/No time recorded in this period/.test(html), 'and it does not claim there is nothing');

  // The button. Requiring a punch meant a person whose whole period was typed
  // in by a manager could never sign it — which is what "I tried to submit and
  // nothing happened" was.
  assert.match(html, /Submit timesheet/, 'and they can actually submit it');

  // Opening the day shows the hours rather than "Nothing recorded on this day",
  // which would be the page calling its own total a lie.
  const day = await text(`/portal/timesheet/day/${days[0]}`, { cookie });
  assert.match(day, /8h 0m/, 'the day shows what it carries');
  assert.match(day, /No clock-in was recorded/, 'and says why there are no times');
  assert.ok(!/Nothing recorded on this day/.test(day), 'not "nothing recorded"');
});

test('decimal shift hours never print as a run-on decimal', async () => {
  // work.hours is decimal and decimal hours times 60 is rarely a whole number
  // of minutes: 99.56 hours is 5973.6 minutes, and 5973.6 % 60 is
  // 33.600000000000364. The timesheet's own hm() did not round before
  // formatting, so somebody's period total read "99:33.600000000000364".
  const emp = 203;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3203',1500,1)")
    .run(emp, 'Odd Decimal');
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  for (const i of [0, 1, 2]) {
    const day = D2.addDays(per.start, i);
    db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?,'dinner','open')").run(day);
    const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'dinner'").get(day);
    db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hours_source)
      VALUES (?,?,'server',7.33,'manager')
      ON CONFLICT(shift_id, employee_id) DO UPDATE SET hours = 7.33`).run(sh.id, emp);
  }
  const cookie = await signIn('3203');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });

  // Nowhere on the page: a clock figure with a fractional minute after it.
  const runOn = html.match(/\d+:\d\d\.\d+/g);
  assert.strictEqual(runOn, null, `no run-on decimals (found ${runOn && runOn.join(', ')})`);
  // Nor an "h m" one. TC.hm rounds before it divides, everywhere on the page.
  assert.strictEqual(html.match(/\d+h \d+\.\d+m/g), null, 'nor in the h/m form');
  // 7.33h is 439.8 minutes, which rounds to 7h 20m rather than 7h 19.8m.
  assert.match(html, /7h 20m/, 'rounded to the nearest minute');
});

test('a period with hours on the sheets is one the portal asks you to sign', async () => {
  // periodToSign drives the "ready to submit" banner AND the reminder that goes
  // out when a period ends. Asking only about punches meant the people most
  // likely to forget were the ones never told.
  const emp = 204;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3204',1500,1)")
    .run(emp, 'Ask Me');
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const day = D2.addDays(per.start, 1);
  db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?,'cafe','open')").run(day);
  const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'cafe'").get(day);
  db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hours_source)
    VALUES (?,?,'server',6,'manager')
    ON CONFLICT(shift_id, employee_id) DO UPDATE SET hours = 6`).run(sh.id, emp);

  const cookie = await signIn('3204');
  const html = await text('/portal/timesheet', { cookie });
  assert.match(html, /ready to submit/i, 'the portal says the period wants signing');
});

// ── The requests queue ───────────────────────────────────────────────────────
// They used to live nowhere: a panel on the Today tab that vanished when the
// queue was empty, every row a link away to one person's entry. So "are there
// any?" had no answer you could go and read, and working three of them meant
// three different screens.

test('the way in never disappears — "View requests" at zero, a count above it', async () => {
  db.prepare("UPDATE time_corrections SET decision = 'approved' WHERE decision = 'pending'").run();
  let html = await text('/timeclock');
  assert.match(html, /class="bs-req-pill"[^>]*>View requests</,
    'with nothing waiting it still offers a way to look');
  assert.ok(!/bs-req-pill on/.test(html), 'and is not shouting');

  // A panel that is simply absent makes "nothing waiting" and "the page is
  // broken" look identical, which is the whole reason this exists.
  const emp = 205;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3205',1500,1)")
    .run(emp, 'Queue One');
  const day = '2026-05-20';
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',300,300)`)
    .run(emp, day, `${day} 21:00:00`, `${day} 23:00:00`).lastInsertRowid;
  const cookie = await signIn('3205');
  await post('/portal/clock/fix', { entry_id: String(id), kind: 'shift_times', pin: '3205',
    at_in: `${day}T16:00`, note: 'started earlier' }, { cookie });

  html = await text('/timeclock');
  assert.match(html, /class="bs-req-pill on"[^>]*><b>1<\/b> Request</, 'one waiting, and it says so');
  // On the timesheets toolbar too — where somebody is when they notice.
  assert.match(await text('/payroll/timesheets'), /class="bs-req-pill on"/, 'both toolbars carry it');
});

test('the queue shows the shift now against the shift as asked for', async () => {
  const emp = 206;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3206',1500,1)")
    .run(emp, 'Side By Side');
  const day = '2026-05-21';
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',240,240)`)
    .run(emp, day, `${day} 21:00:00`, `${day} 01:00:00`.replace(day, '2026-05-22')).lastInsertRowid;
  const cookie = await signIn('3206');
  await post('/portal/clock/fix', { entry_id: String(id), kind: 'shift_times', pin: '3206',
    at_in: `${day}T16:00`, at_out: `${day}T23:30`, note: 'in early, out late' }, { cookie });
  const c = db.prepare("SELECT * FROM time_corrections WHERE employee_id = ? AND decision='pending'").get(emp);

  const html = await text(`/timeclock/requests?id=${c.id}`);
  // Both columns, and a header that says which is which — the point is that a
  // manager can see what the shift BECOMES, not just what moved.
  assert.match(html, /<span>Original<\/span><span>Requested<\/span>/, 'two columns, labelled');
  assert.match(html, /bs-req-cr moved/, 'and the rows that changed are marked');
  assert.match(html, /Clock in/, 'the clock-in is compared');
  assert.match(html, /Clock out/, 'and the clock-out');
  // The total, worked out BOTH ways: 4:00pm–11:30pm is 7h30m against the 4h
  // that is on the clock now. This is the figure a manager is really deciding
  // about, and it was not on the old screen at all.
  assert.match(html, /Total hours/, 'and what it will pay');
  assert.match(html, /4h 0m[\s\S]*?7h 30m/, 'before and after');
  assert.match(html, /Decline[\s\S]*?Approve/, 'decided from here, without opening the entry');
});

test('an added shift is the same two columns with an empty left', async () => {
  const emp = 207;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3207',1500,1)")
    .run(emp, 'Nothing Yet');
  const cookie = await signIn('3207');
  await post('/portal/clock/add', { pin: '3207', position: 'server', daypart: 'dinner',
    at_in: '2026-05-23T17:00', at_out: '2026-05-23T23:00', note: 'tablet down' }, { cookie });
  const c = db.prepare("SELECT * FROM time_corrections WHERE employee_id = ? AND kind='new_shift'").get(emp);

  const html = await text(`/timeclock/requests?id=${c.id}`);
  assert.match(html, /Added a shift/, 'named for what it is');
  assert.match(html, /<span>Original<\/span><span>Requested<\/span>/, 'the same shape as an edit');
  assert.match(html, /6h 0m/, 'with the hours it would add');
  // There is no shift yet, so the left column is empty rather than absent —
  // which is what "Original times 00:00" means on the reference.
  const cmp = (html.match(/<div class="bs-req-cmp">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  assert.ok((cmp.match(/class="bs-req-cn">—</g) || []).length >= 4, 'an empty Now column, not a missing one');
});

test('the empty queue is a screen you can read, and history keeps what was decided', async () => {
  db.prepare("UPDATE time_corrections SET decision = 'approved', decided_by = 'Owner', decided_at = datetime('now') WHERE decision = 'pending'").run();
  const html = await text('/timeclock/requests');
  assert.match(html, /Pending \(0\)/, 'the count is zero and still shown');
  assert.match(html, /No requests/, 'and says so rather than rendering nothing');
  assert.match(html, /bs-req-tick/, 'with the same tick the reference uses');

  const hist = await text('/timeclock/requests?tab=history');
  assert.match(hist, /bs-req-r/, 'history has what was decided');
  assert.match(hist, /bs-req-st approved/, 'and how it went');
});

test('approving the whole queue clears the same bars as approving one', async () => {
  // The risk of a bulk action is that it becomes a quieter way in. Every one
  // goes through decideCorrection, the same function a single Approve calls,
  // so the freeze and the overlap guard apply — and anything refused stays
  // pending WITH its reason, because silently skipping the two that failed is
  // how a manager comes to believe a queue is clear when it is not.
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const mk = (id, pin, name, day, frozen) => {
    db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server',?,1500,1)")
      .run(id, name, pin);
    const eid = db.prepare(`INSERT INTO time_entries
      (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
      VALUES (?,?,'dinner','server',?,?, 'complete','manager',240,240)`)
      .run(id, day, `${day} 21:00:00`, `${day} 23:00:00`).lastInsertRowid;
    if (frozen) {
      db.prepare(`INSERT INTO timesheets (employee_id, period_start, period_end, status)
        VALUES (?,?,?,'approved') ON CONFLICT(employee_id, period_start) DO UPDATE SET status='approved'`)
        .run(id, per.start, per.end);
    }
    return eid;
  };
  db.prepare("UPDATE time_corrections SET decision='approved' WHERE decision='pending'").run();

  const okDay = '2026-05-25';
  const freeDay = D2.addDays(per.start, 5);
  const eOk = mk(208, '3208', 'Bulk Fine', okDay, false);
  const eNo = mk(209, '3209', 'Bulk Frozen', freeDay, true);

  for (const [pin, eid, day] of [['3208', eOk, okDay], ['3209', eNo, freeDay]]) {
    const ck = await signIn(pin);
    await post('/portal/clock/fix', { entry_id: String(eid), kind: 'shift_times', pin,
      at_in: `${day}T16:00`, note: 'earlier' }, { ck: 1, cookie: ck });
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM time_corrections WHERE decision='pending'").get().n, 2,
    'two waiting, one of them on a signed period');

  const res = await post('/timeclock/requests/all', { decision: 'approved' });
  assert.strictEqual(res.status, 302);
  const msg = decodeURIComponent(res.headers.get('location'));
  assert.match(msg, /1 done/, 'the clean one went through');
  assert.match(msg, /could not be/i, 'and the blocked one is reported, not swallowed');
  assert.match(msg, /Bulk Frozen/, 'by name');

  assert.strictEqual(db.prepare('SELECT clock_in_at FROM time_entries WHERE id = ?').get(eOk).clock_in_at.slice(11, 16),
    '20:00', 'the clean punch moved');
  assert.strictEqual(db.prepare('SELECT clock_in_at FROM time_entries WHERE id = ?').get(eNo).clock_in_at.slice(11, 16),
    '21:00', 'the signed one did not');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM time_corrections WHERE decision='pending'").get().n, 1,
    'and it is still in the queue to be dealt with');
});

test('the old one-request URL still lands somewhere real', async () => {
  const res = await get('/timeclock/request/7');
  assert.strictEqual(res.status, 302, 'it redirects');
  assert.match(res.headers.get('location'), /\/timeclock\/requests\?id=7/, 'into the queue, on that request');
});

test('history keeps the original, not the shift the approval made', async () => {
  // The bug this exists to stop: the "before" column read the LIVE entry, so
  // the moment a request was approved the entry HELD the requested times and
  // both columns showed the same figures. What somebody actually asked to
  // change was gone from the record the instant it was granted — which is the
  // one moment you most want it kept.
  const emp = 210;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3210',1500,1)")
    .run(emp, 'Kept Record');
  const day = '2026-05-27';
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',240,240)`)
    .run(emp, day, `${day} 21:00:00`, `${day} 23:00:00`).lastInsertRowid;

  const cookie = await signIn('3210');
  await post('/portal/clock/fix', { entry_id: String(id), kind: 'shift_times', pin: '3210',
    at_in: `${day}T16:00`, at_out: `${day}T22:00`, note: 'forgot to clock out' }, { cookie });
  const c = db.prepare("SELECT * FROM time_corrections WHERE employee_id = ? AND decision='pending'").get(emp);

  // The original is kept WITH the request, not inferred from the entry later.
  const was = JSON.parse(c.payload).was;
  assert.strictEqual(was.in, `${day} 21:00:00`, 'the shift as it stood is on the request');
  assert.strictEqual(was.out, `${day} 23:00:00`);

  await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  const after = db.prepare('SELECT clock_in_at, clock_out_at FROM time_entries WHERE id = ?').get(id);
  assert.strictEqual(after.clock_in_at, `${day} 20:00:00`, 'the entry took the requested times');

  // And the history STILL shows what it was against what was asked for.
  const html = await text(`/timeclock/requests?tab=history&id=${c.id}`);
  assert.match(html, /<span>Original<\/span><span>Requested<\/span>/, 'the column says Original, not Now');
  assert.match(html, /5:00 PM/, 'the original clock-in is still there');
  assert.match(html, /4:00 PM/, 'and the requested one');
  assert.match(html, /bs-req-cr moved/, 'still marked as a change');
  // The two columns must not have collapsed into the same figures.
  const cmp = (html.match(/<div class="bs-req-cmp">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  const inRow = (cmp.match(/Clock in<\/span>\s*<span class="bs-req-cn">([^<]+)<\/span>\s*<span class="bs-req-cw">([^<]+)</) || []);
  assert.ok(inRow[1] && inRow[2] && inRow[1] !== inRow[2],
    `the columns still differ (got ${inRow[1]} vs ${inRow[2]})`);
  // Totals too: 2h before, 6h asked for.
  assert.match(html, /2h 0m[\s\S]*?6h 0m/, 'and what it paid before against what it will pay');
});

test('a request whose shift moved under it says so before you approve', async () => {
  const emp = 211;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3211',1500,1)")
    .run(emp, 'Moved Under');
  const day = '2026-05-28';
  const id = db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',240,240)`)
    .run(emp, day, `${day} 21:00:00`, `${day} 23:00:00`).lastInsertRowid;
  const cookie = await signIn('3211');
  await post('/portal/clock/fix', { entry_id: String(id), kind: 'shift_times', pin: '3211',
    at_out: `${day}T20:30`, note: 'stayed later' }, { cookie });
  const c = db.prepare("SELECT * FROM time_corrections WHERE employee_id = ? AND decision='pending'").get(emp);

  // Quiet while it still matches.
  assert.ok(!/changed since this was asked/.test(await text(`/timeclock/requests?id=${c.id}`)),
    'nothing to say while the shift is as they left it');

  // A manager moves the punch while the request waits. Approving lands on the
  // entry as it stands NOW, so that is worth knowing first.
  db.prepare("UPDATE time_entries SET clock_in_at = ? WHERE id = ?").run(`${day} 19:30:00`, id);
  const html = await text(`/timeclock/requests?id=${c.id}`);
  assert.match(html, /changed since this was asked/i, 'it warns');
  assert.match(html, /3:30 PM/, 'and says what it reads now');
});

// ── Being told ───────────────────────────────────────────────────────────────
// Everything a manager decided about somebody's time used to reach them by
// email or not at all: approving a timesheet, declining a request and sending
// payroll all wrote an audit line and nothing else.

test('a decided request tells the person who asked — either way', async () => {
  const emp = 212;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3212',1500,1)")
    .run(emp, 'Told Either Way');
  const day = '2026-05-30';
  const mk = (d) => db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',120,120)`)
    .run(emp, d, `${d} 21:00:00`, `${d} 23:00:00`).lastInsertRowid;
  const yes = mk(day);
  const no = mk('2026-05-31');

  const cookie = await signIn('3212');
  const before = db.prepare("SELECT COUNT(*) n FROM portal_events WHERE employee_id = ?").get(emp).n;
  await post('/portal/clock/fix', { entry_id: String(yes), kind: 'shift_times', pin: '3212',
    at_in: `${day}T16:00`, note: 'in early' }, { cookie });
  await post('/portal/clock/fix', { entry_id: String(no), kind: 'shift_times', pin: '3212',
    at_out: '2026-05-31T20:30', note: 'stayed late' }, { cookie });
  const [a, b] = db.prepare("SELECT * FROM time_corrections WHERE employee_id = ? AND decision='pending' ORDER BY id").all(emp);

  await post(`/timeclock/correction/${a.id}`, { decision: 'approved' });
  await post(`/timeclock/correction/${b.id}`, { decision: 'rejected', note: 'You left at the usual time.' });

  const events = db.prepare(
    "SELECT * FROM portal_events WHERE employee_id = ? AND kind='timeclock' ORDER BY id").all(emp);
  assert.strictEqual(events.length, 2, 'both decisions were passed on');
  assert.match(events[0].title, /approved/i, 'the granted one');
  assert.match(events[1].title, /declined/i, 'and the refused one');
  // A refusal without the reason is a message that helps nobody — they are the
  // one who still has to do something about it.
  assert.match(events[1].body, /You left at the usual time/, 'carrying why');
  assert.ok(events.every((e) => e.employee_id === emp), 'addressed to them, not the floor');
  assert.ok(before <= db.prepare("SELECT COUNT(*) n FROM portal_events WHERE employee_id = ?").get(emp).n);
});

test('approving a timesheet tells them, and so does sending it back', async () => {
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const mk = (id, pin, name) => {
    db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server',?,1500,1)")
      .run(id, name, pin);
    const day = D2.addDays(per.start, 3);
    db.prepare(`INSERT INTO time_entries
      (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
      VALUES (?,?,'dinner','server',?,?, 'complete','manager',300,300)`)
      .run(id, day, `${day} 21:00:00`, `${day} 23:00:00`);
    db.prepare(`INSERT INTO timesheets (employee_id, period_start, period_end, status, submitted_at)
      VALUES (?,?,?,'submitted', datetime('now'))
      ON CONFLICT(employee_id, period_start) DO UPDATE SET status='submitted', submitted_at=datetime('now')`)
      .run(id, per.start, per.end);
  };
  mk(213, '3213', 'Signed Off Told');
  mk(214, '3214', 'Sent Back Told');

  await post('/payroll/timesheets/213/approve', { period: per.start, override_reason: 'checked by hand' });
  await post('/payroll/timesheets/214/return', { period: per.start, reason: 'Friday is short — check your clock-out.' });

  const ok = db.prepare("SELECT * FROM portal_events WHERE employee_id=213 AND kind='timesheet' ORDER BY id DESC").get();
  assert.ok(ok, 'the approval reached them');
  assert.match(ok.title, /approved/i);
  assert.match(ok.body, /approved by/, 'and says who');
  assert.match(ok.href, /\/portal\/timesheet\?p=/, 'linking to the sheet');

  const back = db.prepare("SELECT * FROM portal_events WHERE employee_id=214 AND kind='timesheet' ORDER BY id DESC").get();
  assert.ok(back, 'so did the return');
  assert.match(back.title, /another look/i, 'without saying "rejected" at somebody');
  assert.match(back.body, /check your clock-out/, 'and carries the reason they need');
});

test('everything sent to a person is kept, not cleared on a glance', async () => {
  // The hub's "What's new" clears the moment it is read — right for an 86,
  // wrong for "your timesheet was declined". Somebody who glanced at the hub
  // on the way in had no way back to it.
  const emp = 215;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3215',1500,1)")
    .run(emp, 'Kept For Me');
  db.prepare(`INSERT INTO portal_events (kind, title, body, employee_id, href)
    VALUES ('timesheet','Your timesheet was approved','8h by Owner',?,'/portal/timesheet')`).run(emp);
  const cookie = await signIn('3215');

  // Reading the hub clears the UNREAD mark. The item itself stays in the
  // preview — Home shows what recently happened rather than a queue that
  // empties — which is the merge Phase 2D made: one source, one feed.
  await text('/portal', { cookie });
  const hub = await text('/portal', { cookie });
  assert.match(hub, /Your timesheet was approved/, 'it is still recent, so it is still previewed');
  assert.ok(!/pt-new-dot/.test(hub), 'but no longer flagged unread');

  // ...and the list still has it.
  const list = await text('/portal/notifications', { cookie });
  assert.match(list, /Your timesheet was approved/, 'the notification is still findable');
  assert.match(list, /8h by Owner/, 'with its detail');
  // And the hub points at it even with nothing new.
  assert.match(hub, /href="\/portal\/notifications"/, 'and the hub says where to look');
});

test('sending payroll tells everybody it was built for, email or not', async () => {
  const emp = 216;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3216',1500,1)")
    .run(emp, 'No Address');
  db.prepare('UPDATE employees SET email = NULL WHERE id = ?').run(emp);
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const day = D2.addDays(per.start, 6);
  db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?,'dinner','open')").run(day);
  const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'dinner'").get(day);
  db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hours_source)
    VALUES (?,?,'server',7,'manager') ON CONFLICT(shift_id, employee_id) DO UPDATE SET hours = 7`).run(sh.id, emp);

  // The notification loop runs over the emails that were BUILT, not over the
  // people who have an address — which is the whole point, since somebody with
  // no address is exactly who hears nothing otherwise. Asserted on the builder
  // because the harness has no mail account, and a send that only wrote
  // previews deliberately tells nobody anything.
  const { aggregatePayroll } = require('../src/reports');
  const { buildPeriodEmails } = require('../src/email');
  const { rows } = aggregatePayroll(per.start, per.end);
  const built = buildPeriodEmails(rows, { from: per.start, to: per.end },
    new Map(rows.map((r) => [r.employeeId, { email: r.email }])));

  const mine = built.find((e) => e.employeeId === emp);
  assert.ok(mine, 'they are in the set the notification loop walks');
  assert.ok(!mine.to, 'with no address to send to');
  assert.ok(built.every((e) => e.employeeId), 'and every entry carries who it is for');
});

test('the pay period on their own page is the one the email states', async () => {
  const emp = 217;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3217',2000,1)")
    .run(emp, 'Reads It Back');
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  for (const i of [1, 2]) {
    const day = D2.addDays(per.start, i);
    db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?,'dinner','open')").run(day);
    const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'dinner'").get(day);
    db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hours_source)
      VALUES (?,?,'server',5,'manager') ON CONFLICT(shift_id, employee_id) DO UPDATE SET hours = 5`).run(sh.id, emp);
  }
  const cookie = await signIn('3217');
  const html = await text(`/portal/earnings?p=${per.start}`, { cookie });

  assert.match(html, /Pay period/i, 'the period is on the page');
  assert.match(html, /On this check/, 'with the figure they came for');
  assert.match(html, /Shifts worked/, 'and what makes it up');
  assert.match(html, /Total on this check/);
  // 10 hours at $20 is $200 — the same arithmetic aggregatePayroll does for the
  // email, because it IS aggregatePayroll.
  assert.match(html, /\$200\.00/, 'the figure matches the aggregation the email uses');
  // The arrows reach earlier periods rather than stranding them on one.
  assert.match(html, /class="pp-arrow[^"]*" *\n? *href="\/portal\/earnings\?p=/, 'and they can look back');
});

test('a preview run is not a send — nothing is recorded and nobody is told', async () => {
  // Mail is not configured in the test harness, so /payroll/send writes preview
  // files. That used to be recorded as a send: the period was marked, the panel
  // then read "Already sent to N people", and the daily sweep's "Payroll not
  // sent" alert went quiet — for a fortnight nobody had been told about. The
  // flash said "previews were written instead", but that is a sentence you see
  // once against a record that contradicts it forever.
  const emp = 218;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3218',1500,1)")
    .run(emp, 'Preview Only');
  const D2 = require('../src/dates');
  const per = P.recentPeriods(2)[1];
  const day = D2.addDays(per.start, 7);
  db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?,'dinner','open')").run(day);
  const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'dinner'").get(day);
  db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hours_source)
    VALUES (?,?,'server',8,'manager') ON CONFLICT(shift_id, employee_id) DO UPDATE SET hours = 8`).run(sh.id, emp);

  db.prepare('DELETE FROM period_sends WHERE period_start = ?').run(per.start);
  const before = db.prepare("SELECT COUNT(*) n FROM portal_events WHERE employee_id = ?").get(emp).n;

  const res = await post('/payroll/send', { from: per.start, to: per.end });
  assert.strictEqual(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')), /previews were written/i,
    'it says what it actually did');

  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM period_sends WHERE period_start = ?').get(per.start).n, 0,
    'and records no send, because there was none');
  // Nor tells anybody their summary is ready when it has not gone anywhere.
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM portal_events WHERE employee_id = ?").get(emp).n,
    before, 'and nobody was told');

  // The page says so before you press it, rather than after.
  const html = await text(`/payroll?from=${per.start}&to=${per.end}`);
  assert.match(html, /Mail is not connected/, 'the panel warns first');
  assert.match(html, /stays marked as not sent/, 'and says what that means');
  assert.ok(!/Already sent/.test(html), 'and does not claim otherwise');
});

// ===========================================================================
// PHASE 2B — the employee time clock, redesigned.
//
// One status card with four states, a clock-out that asks for confirmation
// rather than a PIN, an edit sheet that carries the whole shift in one
// request, and a submit token that is a digest rather than a float.
//
// These are deliberately assertions about the RENDERED page and the payload it
// posts, not about internal helpers. The bug that started this phase — a route
// demanding a field the sheet never drew — was invisible to every test that
// built its own payload, and that is the class of bug this block exists to
// catch.
// ===========================================================================

const lastCorr = () => db.prepare('SELECT * FROM time_corrections ORDER BY id DESC').get();
const payloadOf = (c) => JSON.parse(c.payload || '{}');

test('2B: clocked out — the card says so and asks only what it must', async () => {
  const cookie = await signIn('3111');           // one position, service not required
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '16',
    pin_fix: '1', alerts: '1' });                // require_service off
  const html = await text('/portal/clock', { cookie });
  assert.match(html, /class="tcc tcc-off"/, 'the neutral state');
  assert.match(html, /Clocked out</, 'named');
  assert.ok(!/<select name="position"/.test(html), 'one position is not a question');
  assert.ok(!/<select name="daypart"/.test(html), 'and neither is the service when it is not required');
  assert.match(html, /name="position" value="server"/, 'both travel as hidden fields');
  assert.match(html, /name="daypart" value="/, 'so the route still gets what it validates');
  assert.match(html, />Clock in</, 'one primary action');
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '16',
    pin_fix: '1', require_service: '1', alerts: '1' });
});

test('2B: working — live counter, the facts, and both actions in the open', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  const html = await text('/portal/clock', { cookie });
  assert.match(html, /class="tcc tcc-on"/, 'the green state');
  assert.match(html, />Working</, 'named');
  assert.match(html, /class="tcc-clock" data-since="\d+" data-now="\d+"/,
    'the counter is anchored to the server clock, not the phone');
  assert.match(html, /Position<\/span><b>Server/, 'position on the card');
  assert.match(html, /Service<\/span><b>/, 'service on the card');
  assert.match(html, /data-pes-open="clockout"[^>]*>Clock out/, 'clock out is primary');
  assert.match(html, /tc-btn-quiet[^>]*>Start break/, 'start break is the quiet one');
  assert.ok(!/tsx-menu/.test(html), 'and nothing important hides in a three-dot menu');
});

test('2B: the clock-out sheet shows what is being recorded, and asks for no PIN', async () => {
  const cookie = await signIn('3111');           // still on the clock from above
  const html = await text('/portal/clock', { cookie });
  const sheet = (html.match(/data-pes="clockout"[\s\S]*?<\/form>/) || [''])[0];
  assert.ok(sheet, 'the sheet is on the page');
  for (const label of ['Clocked in', 'Clocking out', 'Break', 'Position', 'Service', 'Payable']) {
    assert.ok(sheet.includes(`<span>${label}</span>`), `it shows ${label}`);
  }
  assert.match(sheet, />Cancel</, 'cancel');
  assert.match(sheet, />Confirm clock out</, 'and confirm');
  assert.ok(!/name="pin"/.test(sheet), 'and no PIN field');
  // The two figures that would go stale are computed at look-time, not at
  // render-time — the sheet can sit unopened for an hour.
  assert.match(sheet, /data-live-face/, 'the clock-out time is live');
  assert.match(sheet, /data-live-mins data-base="-?\d+"/, 'and so is the payable total');
  await post('/portal/clock/out', {}, { cookie });
  assert.ok(!activeOf(EMP.solo), 'and it closes the punch with no PIN at all');
});

test('2B: clocking out twice does not open or close anything a second time', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  const before = entriesOf(EMP.solo).length;
  const r1 = await post('/portal/clock/out', {}, { cookie });
  const r2 = await post('/portal/clock/out', {}, { cookie });
  assert.strictEqual(r1.status, 302);
  assert.strictEqual(r2.status, 302);
  assert.match(decodeURIComponent(r2.headers.get('location')), /already clocked out/,
    'the second is answered plainly, not with an error');
  assert.strictEqual(entriesOf(EMP.solo).length, before, 'and no extra entry exists');
});

test('2B: a shift left open past the threshold is amber, and still clocks out', async () => {
  // Its own employee: back-dating a punch twenty hours across somebody else's
  // day is exactly what the overlap trigger exists to refuse.
  const emp = 239;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3239',1500,1)")
    .run(emp, 'Forgot To Leave');
  const cookie = await signIn('3239');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  // Back-dated past the long-shift threshold, the way a forgotten clock-out is.
  const a = activeOf(emp);
  db.prepare("UPDATE time_entries SET clock_in_at = datetime('now','-20 hours') WHERE id = ?").run(a.id);
  const html = await text('/portal/clock', { cookie });
  assert.match(html, /class="tcc tcc-warn"/, 'amber, not red — they are not blocked');
  assert.match(html, />Still clocked in</, 'named for what it is');
  assert.match(html, /over 16 hours/, 'with the threshold spelled out');
  assert.match(html, /data-pes-open="clockout"/, 'and clocking out is still right there');
  await post('/portal/clock/out', {}, { cookie });
  assert.ok(!activeOf(emp), 'it closes');
});

test('2B: on break — break duration ticks, payable is quoted as of the break', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  await post('/portal/clock/break/start', {}, { cookie });
  const html = await text('/portal/clock', { cookie });
  assert.match(html, /class="tcc tcc-break"/, 'the amber state');
  assert.match(html, />On break</, 'named');
  assert.match(html, /class="tcc-clock" data-since=/, 'the break duration is the live figure');
  assert.match(html, /Payable so far<\/span>/, 'payable so far is shown');
  assert.match(html, /paused while you are on an unpaid break/,
    'and it says why that figure is not moving');
  assert.match(html, />End break</, 'one primary action');
  await post('/portal/clock/break/end', {}, { cookie });
  await post('/portal/clock/out', {}, { cookie });
});

test('2B: the receipt is a receipt — the same page, with what was recorded', async () => {
  const cookie = await signIn('3111');
  await post('/portal/clock/in', { daypart: 'cafe' }, { cookie });
  const res = await post('/portal/clock/out', {}, { cookie });
  const id = (decodeURIComponent(res.headers.get('location')).match(/done=(\d+)/) || [])[1];
  assert.ok(id, 'the clock-out lands on the receipt');
  const html = await text(`/portal/clock?done=${id}`, { cookie });
  assert.match(html, /class="tcc tcc-done"/, 'the receipt uses the same card');
  for (const label of ['Clocked in', 'Clocked out', 'Break', 'Position', 'Service']) {
    assert.ok(html.includes(`<div class="tcc-f"><span>${label}</span>`), `it shows ${label}`);
  }
  assert.match(html, />Done</, 'done');
  assert.match(html, new RegExp(`href="/portal/clock/entry/${id}">Something's wrong`),
    "and Something's wrong goes straight to the shift, not to a form");
  assert.match(html, /class="tc-shorts"/, 'the rest of the page is still there');
});

// --- shift detail ----------------------------------------------------------

test('2B: shift detail shows the shift, and its history in plain English', async () => {
  const emp = 220;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3220',1500,1)")
    .run(emp, 'Detail Reader');
  const eid = seedInPeriod(emp, 4, '10:00', '18:00');
  T2.logEvent('entry', eid, 'clock_in', 'Detail Reader', { after: 'x' });
  T2.logEvent('entry', eid, 'clock_out_corrected', 'Boss',
    { before: T2.localInputToUtc('2026-01-01T17:00'), after: T2.localInputToUtc('2026-01-01T18:00') });
  const cookie = await signIn('3220');
  const html = await text(`/portal/clock/entry/${eid}`, { cookie });
  assert.match(html, /class="tcd-tot"><b>8h 0m<\/b>/, 'the payable total, first');
  for (const label of ['Clocked in', 'Clocked out', 'Breaks', 'Position', 'Service']) {
    assert.ok(html.includes(`<div class="tc-fact"><span>${label}</span>`), `it shows ${label}`);
  }
  assert.match(html, />History</, 'the history section exists');
  assert.match(html, />Clocked in</, 'with events named for people');
  assert.match(html, />Clock-out changed</, 'not clock_out_corrected');
  assert.ok(!/clock_out_corrected/.test(html), 'the raw action never reaches the page');
  assert.ok(!/see the history with your manager/.test(html),
    'and the page no longer tells them to go and ask someone');
  assert.match(html, /data-pes-open="\d+"/, 'and Edit shift is there');
});

test('2B: a request on the shift reads as a state, not a database value', async () => {
  const emp = 221;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3221',1500,1)")
    .run(emp, 'State Reader');
  const eid = seedInPeriod(emp, 5, '10:00', '18:00');
  const cookie = await signIn('3221');
  const day = db.prepare('SELECT business_date FROM time_entries WHERE id = ?').get(eid).business_date;
  await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', at_out: `${day}T19:00`, pin: '3221' }, { cookie });
  const html = await text(`/portal/clock/entry/${eid}`, { cookie });
  assert.match(html, />Changed shift times</, 'the kind, in words');
  assert.match(html, /tcd-st-pending">Waiting</, 'and the decision, in words');
  assert.ok(!/shift_times/.test(html.replace(/name="kind" value="shift_times"/g, '')),
    'the raw kind is not printed anywhere it is read');
});

// --- the edit sheet: one request, whatever moved --------------------------

/** Post an edit exactly as the sheet does, and hand back the request it made. */
async function edit(cookie, eid, fields, pin) {
  const r = await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', pin, ...fields }, { cookie });
  return { res: r, corr: lastCorr() };
}

test('2B: the edit sheet renders both ends, More changes, and the PIN', async () => {
  const emp = 222;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3222x',1500,1)")
    .run(emp, 'Sheet Reader');
  db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
    .run(emp, 'busser', 1400);
  const eid = seedInPeriod(emp, 6, '10:00', '18:00');
  const d6 = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  db.prepare(`INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at, paid, raw_minutes, created_by)
    VALUES (?,?,?,?,0,30,'test')`)
    .run(eid, emp, T2.localInputToUtc(`${d6}T13:00`), T2.localInputToUtc(`${d6}T13:30`));
  const cookie = await signIn('3222x');
  const html = await text(`/portal/clock/entry/${eid}`, { cookie });
  const sheet = (html.match(/data-pes="\d+"[\s\S]*?<\/form>/) || [''])[0];
  assert.ok(sheet, 'the sheet is rendered');
  // The default view: two times and a total. No "what kind of problem is this?"
  assert.match(sheet, /data-pes-ind/, 'start date');
  assert.match(sheet, /data-pes-int/, 'start time');
  assert.match(sheet, /data-pes-outd/, 'end date');
  assert.match(sheet, /data-pes-outt/, 'end time');
  assert.match(sheet, /data-pes-tot/, 'the recalculated total');
  assert.ok(!/name="kind"[^>]*>\s*<option/.test(sheet), 'no correction-type picker');
  assert.match(sheet, /name="kind" value="shift_times"/, 'the kind is fixed, not chosen');
  // The fold.
  assert.match(sheet, /<details class="pes-more">/, 'More changes exists');
  assert.match(sheet, /More changes/, 'and is named for what it holds');
  assert.match(sheet, /<select name="position"/, 'position, for somebody who has two');
  assert.match(sheet, /<select name="daypart"/, 'service');
  assert.match(sheet, /name="brk_id" value="\d+"/, 'the break already on the shift');
  assert.match(sheet, /name="brk_id" value=""/, 'and a row to add one');
  assert.match(sheet, /name="pin"/, 'editing still asks for the PIN');
  assert.match(sheet, />Send for approval</, 'and it is a request, not a save');
});

test('2B: editing the start only files one request that moves only the start', async () => {
  const emp = 223;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3223',1500,1)")
    .run(emp, 'Start Only');
  const eid = seedInPeriod(emp, 7, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3223');
  const { corr } = await edit(cookie, eid, { at_in: `${day}T09:00` }, '3223');
  const p = payloadOf(corr);
  assert.strictEqual(corr.kind, 'shift_times');
  assert.ok(p.in, 'the start travels');
  assert.strictEqual(p.out, undefined, 'the untouched end does not');
  await decide(corr.id, 'approved');
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(eid);
  assert.strictEqual(T2.clockFace(e.clock_in_at), '9:00 AM', 'the start moved');
  assert.strictEqual(T2.clockFace(e.clock_out_at), '6:00 PM', 'the end did not');
  assert.strictEqual(e.payable_minutes, 540, 'and the hours are recomputed');
});

test('2B: editing the end only does the mirror of that', async () => {
  const emp = 224;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3224',1500,1)")
    .run(emp, 'End Only');
  const eid = seedInPeriod(emp, 8, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3224');
  const { corr } = await edit(cookie, eid, { at_out: `${day}T19:30` }, '3224');
  const p = payloadOf(corr);
  assert.strictEqual(p.in, undefined, 'the untouched start does not travel');
  assert.ok(p.out, 'the end does');
  await decide(corr.id, 'approved');
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(eid);
  assert.strictEqual(T2.clockFace(e.clock_in_at), '10:00 AM');
  assert.strictEqual(T2.clockFace(e.clock_out_at), '7:30 PM');
  assert.strictEqual(e.payable_minutes, 570);
});

test('2B: both ends in ONE request, applied together', async () => {
  const emp = 225;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3225',1500,1)")
    .run(emp, 'Both Ends');
  const eid = seedInPeriod(emp, 9, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3225');
  const before = db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n;
  const { corr } = await edit(cookie, eid, { at_in: `${day}T09:00`, at_out: `${day}T19:00` }, '3225');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n,
    before + 1, 'one request, not two');
  await decide(corr.id, 'approved');
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(eid);
  assert.strictEqual(T2.clockFace(e.clock_in_at), '9:00 AM');
  assert.strictEqual(T2.clockFace(e.clock_out_at), '7:00 PM');
  assert.strictEqual(e.payable_minutes, 600, 'ten hours, in one move');
});

test('2B: More changes — position, service and a break ride in the same request', async () => {
  const emp = 226;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3226',1500,1)")
    .run(emp, 'Everything At Once');
  db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
    .run(emp, 'busser', 1400);
  const eid = seedInPeriod(emp, 10, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3226');
  const before = db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n;
  const { corr } = await edit(cookie, eid, {
    at_out: `${day}T19:00`,
    position: 'busser', daypart: 'dinner',
    brk_id: '', brk_start: `${day}T13:00`, brk_end: `${day}T13:30`,
  }, '3226');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n,
    before + 1, 'four changes, one request — this is the whole point of the fold');
  const p = payloadOf(corr);
  assert.ok(p.out && p.position === 'busser' && p.daypart === 'dinner' && p.breaks.length === 1,
    'and the envelope carries all four');
  await decide(corr.id, 'approved');
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(eid);
  assert.strictEqual(T2.clockFace(e.clock_out_at), '7:00 PM', 'the end moved');
  assert.strictEqual(e.position, 'busser', 'the position changed');
  assert.strictEqual(e.daypart, 'dinner', 'the service changed');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE time_entry_id = ?').get(eid).n, 1,
    'the break was added');
  assert.strictEqual(e.payable_minutes, 510, 'nine hours less the thirty-minute unpaid break');
});

test('2B: correcting an existing break changes it rather than adding another', async () => {
  const emp = 227;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3227',1500,1)")
    .run(emp, 'Break Fixer');
  const eid = seedInPeriod(emp, 11, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const bid = db.prepare(`INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at, paid, raw_minutes, created_by)
    VALUES (?,?,?,?,0,60,'test')`).run(eid, emp, T2.localInputToUtc(`${day}T13:00`), T2.localInputToUtc(`${day}T14:00`)).lastInsertRowid;
  T2.recompute(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(eid));
  const cookie = await signIn('3227');
  const { corr } = await edit(cookie, eid,
    { brk_id: String(bid), brk_start: `${day}T13:00`, brk_end: `${day}T13:30` }, '3227');
  assert.strictEqual(payloadOf(corr).breaks[0].id, bid, 'it names the break it means');
  await decide(corr.id, 'approved');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE time_entry_id = ?').get(eid).n, 1,
    'still one break');
  const b = db.prepare('SELECT * FROM time_breaks WHERE id = ?').get(bid);
  assert.strictEqual(b.raw_minutes, 30, 'and it is the shorter one');
  assert.strictEqual(db.prepare('SELECT payable_minutes p FROM time_entries WHERE id = ?').get(eid).p, 450,
    'the half hour they got back is paid');
});

test('2B: a shift and its break moving together is not refused', async () => {
  // The combined edit that a single-field request could never express: somebody
  // clocked in an hour late and took their break an hour late with it. Checking
  // the stored break against the new punch would refuse this.
  const emp = 228;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3228',1500,1)")
    .run(emp, 'Moved Together');
  const eid = seedInPeriod(emp, 12, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const bid = db.prepare(`INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at, paid, raw_minutes, created_by)
    VALUES (?,?,?,?,0,30,'test')`).run(eid, emp, T2.localInputToUtc(`${day}T10:30`), T2.localInputToUtc(`${day}T11:00`)).lastInsertRowid;
  T2.recompute(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(eid));
  const cookie = await signIn('3228');
  const { corr } = await edit(cookie, eid, {
    at_in: `${day}T12:00`,                        // the break at 10:30 now precedes the punch
    brk_id: String(bid), brk_start: `${day}T14:30`, brk_end: `${day}T15:00`,
  }, '3228');
  const r = await decide(corr.id, 'approved');
  assert.strictEqual(r.status, 302);
  const fresh = db.prepare('SELECT * FROM time_corrections WHERE id = ?').get(corr.id);
  assert.strictEqual(fresh.decision, 'approved', 'the request was granted, not blocked');
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(eid);
  assert.strictEqual(T2.clockFace(e.clock_in_at), '12:00 PM');
  assert.strictEqual(e.payable_minutes, 330, 'six hours less the half-hour break');
});

test('2B: an edit that changes nothing is refused before it becomes a request', async () => {
  const emp = 229;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3229',1500,1)")
    .run(emp, 'No Change');
  const eid = seedInPeriod(emp, 13, '10:00', '18:00');
  const cookie = await signIn('3229');
  const before = db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n;
  const r = await post('/portal/clock/fix', { entry_id: eid, kind: 'shift_times', pin: '3229' }, { cookie });
  assert.match(decodeURIComponent(r.headers.get('location')), /Change something before sending it/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n,
    before, 'and no empty request lands in the manager queue');
});

test('2B: an end before the start is refused, and so is a backwards break', async () => {
  const emp = 230;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3230',1500,1)")
    .run(emp, 'Bad Times');
  const eid = seedInPeriod(emp, 8, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3230');
  const r1 = await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', at_in: `${day}T18:00`, at_out: `${day}T10:00`, pin: '3230' }, { cookie });
  assert.match(decodeURIComponent(r1.headers.get('location')), /end has to be after the start/);
  const r2 = await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', brk_id: '', brk_start: `${day}T14:00`, brk_end: `${day}T13:00`, pin: '3230' }, { cookie });
  assert.match(decodeURIComponent(r2.headers.get('location')), /break has to end after it starts/);
  const r3 = await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', brk_id: '', brk_start: `${day}T14:00`, brk_end: '', pin: '3230' }, { cookie });
  assert.match(decodeURIComponent(r3.headers.get('location')), /needs both a start and an end/);
});

test('2B: editing a shift still requires the PIN', async () => {
  const emp = 231;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3231',1500,1)")
    .run(emp, 'Pin Kept');
  const eid = seedInPeriod(emp, 9, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3231');
  const before = db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n;
  const r = await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', at_out: `${day}T19:00`, pin: '0000' }, { cookie });
  assert.match(decodeURIComponent(r.headers.get('location')), /PIN/, 'a wrong PIN is refused');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n,
    before, 'and nothing was filed');
});

// --- the add sheet ---------------------------------------------------------

test('2B: adding a shift files a request, writes no punch, and can carry a break', async () => {
  const emp = 232;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3232',1500,1)")
    .run(emp, 'Never Clocked');
  const per = curPeriod();
  const day = require('../src/dates').addDays(per.start, 2);
  const cookie = await signIn('3232');

  const page = await text(`/portal/timesheet/day/${day}`, { cookie });
  assert.match(page, /data-pes="new-/, 'the add sheet is on the day');
  assert.match(page, /Took a break\?/, 'with the optional break folded away');
  assert.match(page, /name="pin"/, 'adding still asks for the PIN');

  const before = entriesOf(emp).length;
  await post('/portal/clock/add', {
    at_in: `${day}T17:00`, at_out: `${day}T23:00`, position: 'server', daypart: 'dinner',
    brk_start: `${day}T19:00`, brk_end: `${day}T19:30`, pin: '3232', note: 'tablet was down',
  }, { cookie });
  assert.strictEqual(entriesOf(emp).length, before, 'nothing is written to the clock yet');
  const corr = lastCorr();
  assert.strictEqual(corr.kind, 'new_shift');
  assert.strictEqual(corr.time_entry_id, null, 'there is no punch for it to point at');
  assert.strictEqual(payloadOf(corr).breaks.length, 1, 'the break travels with it');

  await decide(corr.id, 'approved');
  assert.strictEqual(entriesOf(emp).length, before + 1, 'approval makes the punch');
  const e = entriesOf(emp).slice(-1)[0];
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE time_entry_id = ?').get(e.id).n, 1,
    'and the break with it');
  assert.strictEqual(e.payable_minutes, 330, 'six hours less the half hour');
});

test('2B: adding a shift over one that exists is refused at the door', async () => {
  const emp = 233;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3233',1500,1)")
    .run(emp, 'Overlapper');
  const eid = seedInPeriod(emp, 10, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3233');
  const before = db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n;
  const r = await post('/portal/clock/add', {
    at_in: `${day}T14:00`, at_out: `${day}T20:00`, position: 'server', daypart: 'dinner', pin: '3233',
  }, { cookie });
  assert.match(decodeURIComponent(r.headers.get('location')), /err=/, 'refused');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n,
    before, 'and no request that could never be granted was filed');
});

test('2B: a break outside the shift is refused when adding', async () => {
  const emp = 234;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3234',1500,1)")
    .run(emp, 'Stray Break');
  const per = curPeriod();
  const day = require('../src/dates').addDays(per.start, 3);
  const cookie = await signIn('3234');
  const r = await post('/portal/clock/add', {
    at_in: `${day}T17:00`, at_out: `${day}T23:00`, position: 'server', daypart: 'dinner',
    brk_start: `${day}T15:00`, brk_end: `${day}T15:30`, pin: '3234',
  }, { cookie });
  assert.match(decodeURIComponent(r.headers.get('location')), /break has to sit inside the shift/);
});

test('2B: adding a shift still requires the PIN', async () => {
  const emp = 235;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3235',1500,1)")
    .run(emp, 'Add Pin Kept');
  const per = curPeriod();
  const day = require('../src/dates').addDays(per.start, 4);
  const cookie = await signIn('3235');
  const before = db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n;
  const r = await post('/portal/clock/add', {
    at_in: `${day}T17:00`, at_out: `${day}T23:00`, position: 'server', daypart: 'dinner', pin: '0000',
  }, { cookie });
  assert.match(decodeURIComponent(r.headers.get('location')), /PIN/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_corrections WHERE employee_id = ?').get(emp).n, before);
});

// --- the submit sheet and its token ---------------------------------------

test('2B: the staleness token is a digest, and it moves when the hours do', async () => {
  const emp = 236;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3236',1500,1)")
    .run(emp, 'Token Holder');
  const per = curPeriod();
  const eid = seedInPeriod(emp, 11, '09:00', '17:00');
  const cookie = await signIn('3236');
  const tokenOf = async () => ((await text(`/portal/timesheet?p=${per.start}`, { cookie }))
    .match(/name="seen" value="([^"]*)"/) || [])[1];

  const t1 = await tokenOf();
  assert.match(t1, /^[0-9a-f]{16}$/, 'opaque and fixed-width, not a float');
  assert.ok(!/\./.test(t1), 'nothing that can be reformatted differently by anything');
  assert.strictEqual(await tokenOf(), t1, 'stable across renders when nothing changed');

  // A shift whose total is IDENTICAL but whose punches moved. The bare figure
  // this replaced could not see this at all.
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  db.prepare('UPDATE time_entries SET clock_in_at = ?, clock_out_at = ? WHERE id = ?')
    .run(T2.localInputToUtc(`${day}T10:00`), T2.localInputToUtc(`${day}T18:00`), eid);
  const t2 = await tokenOf();
  assert.notStrictEqual(t2, t1, 'the same eight hours at different times is a different timesheet');

  // And a signature given for the old figures is refused.
  const r = await post('/portal/timesheet/submit',
    { period: per.start, confirm: '1', seen: t1 }, { cookie });
  assert.match(decodeURIComponent(r.headers.get('location')), /hours changed while this was open/);
  const r2 = await post('/portal/timesheet/submit',
    { period: per.start, confirm: '1', seen: t2 }, { cookie });
  assert.ok(!/err=/.test(decodeURIComponent(r2.headers.get('location'))), 'the current one goes through');
});

test('2B: the submit sheet shows the period and its hours, and asks for no PIN', async () => {
  const emp = 237;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3237',1500,1)")
    .run(emp, 'Sheet Signer');
  const per = curPeriod();
  seedInPeriod(emp, 12, '09:00', '17:00');
  const cookie = await signIn('3237');
  const html = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  const sheet = (html.match(/data-pes="submit"[\s\S]*?<\/form>/) || [''])[0];
  assert.ok(sheet, 'it uses the shared bottom sheet, like every other one');
  assert.match(sheet, /<span>Pay period<\/span>/, 'the period');
  assert.match(sheet, /<span>Days worked<\/span>/, 'how many days it covers');
  assert.match(sheet, /Total hours/, 'the total');
  assert.match(sheet, /name="confirm"/, 'the confirmation');
  assert.match(sheet, /name="note"/, 'an optional note');
  assert.ok(!/name="pin"/.test(sheet), 'and no PIN');
});

// --- shell, navigation, and the mobile hooks ------------------------------

test('2B: every redesigned screen carries one crumb and a way back', async () => {
  const emp = 238;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3238',1500,1)")
    .run(emp, 'Navigator');
  const per = curPeriod();
  const eid = seedInPeriod(emp, 13, '09:00', '17:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3238');
  for (const [path, back] of [
    ['/portal/clock', '/portal'],
    [`/portal/clock/entry/${eid}`, '/portal/clock'],
    [`/portal/timesheet?p=${per.start}`, '/portal/clock'],
    [`/portal/timesheet/day/${day}`, `/portal/timesheet?p=${per.start}`],
  ]) {
    const html = await text(path, { cookie });
    assert.match(html, /class="pt-crumb"/, `${path} has the one header`);
    assert.ok(html.includes(`class="pt-back" href="${back}"`), `${path} goes back to ${back}`);
    assert.match(html, /data-pt-back/, `${path} prefers real history when there is some`);
  }
});

test('2B: the clock screen is built for a phone', async () => {
  const cookie = await signIn('3111');
  const html = await text('/portal/clock', { cookie });
  assert.match(html, /viewport-fit=cover/, 'it opts into the safe area');
  assert.match(html, /class="pt has-tabs"/, 'and reserves room for the tab bar');
  assert.ok(!/<table/.test(html), 'no table on the primary employee screen');
  // Every class the redesigned card uses must actually be defined, or the page
  // renders as unstyled boxes on a phone and nobody finds out until service.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  for (const cls of ['tcc', 'tcc-top', 'tcc-dot', 'tcc-state', 'tcc-clock', 'tcc-cap',
    'tcc-facts', 'tcc-f', 'tcc-note', 'tcc-acts', 'tcc-form', 'tcc-field', 'tcc-alert',
    'tcc-on', 'tcc-break', 'tcc-warn', 'tcc-blocked', 'tcc-off', 'tcc-done',
    'pes-more', 'pes-more-b', 'pes-line', 'pes-rows', 'pes-acts', 'pes-panel-sm',
    'tcd-tot', 'tcd-st']) {
    assert.ok(css.includes(`.${cls}`), `staff.css defines .${cls}`);
  }
});

// ===========================================================================
// PHASE 2C — Timesheet absorbs history, requests speak English, overtime is
// weekly.
// ===========================================================================

test('2C: Time history is retired, and its old links still land', async () => {
  const cookie = await signIn('3111');
  const res = await get('/portal/clock/history', { cookie });
  assert.strictEqual(res.status, 301, 'permanently moved, so bookmarks update themselves');
  assert.strictEqual(res.headers.get('location'), '/portal/timesheet', 'onto the page that carries it now');
  // And nothing still advertises it as a place to go.
  const clock = await text('/portal/clock', { cookie });
  assert.ok(!/Time history/.test(clock), 'the clock screen no longer offers it');
  assert.match(clock, /every shift you have worked/, 'the timesheet row says it holds that now');
});

test('2C: every correction kind the portal can file has a human label', async () => {
  // The old requests page kept its own map and it was missing exactly the two
  // kinds the Phase 2B sheets create — so everyone who used them saw a card
  // headed "shift_times" or "new_shift".
  const emp = 241;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3241',1500,1)")
    .run(emp, 'Label Reader');
  const eid = seedInPeriod(emp, 3, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3241');

  await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', at_out: `${day}T19:00`, pin: '3241' }, { cookie });
  await post('/portal/clock/add', {
    at_in: `${day}T02:00`, at_out: `${day}T05:00`, position: 'server', daypart: 'cafe', pin: '3241',
  }, { cookie });

  const html = await text('/portal/requests', { cookie });
  assert.match(html, /Changed shift times/, 'the edit kind reads as English');
  assert.match(html, /Added a shift/, 'and so does the add kind');
  // No raw database value anywhere the eye lands.
  for (const raw of ['shift_times', 'new_shift', 'wrong_out', 'missing_in', 'wrong_position']) {
    assert.ok(!new RegExp(`>${raw}<`).test(html), `the raw kind "${raw}" is never printed`);
  }
});

test('2C: a request shows the original beside what was asked for', async () => {
  const emp = 242;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3242',1500,1)")
    .run(emp, 'Diff Reader');
  const eid = seedInPeriod(emp, 4, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3242');
  await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', at_out: `${day}T19:00`, note: 'closed up', pin: '3242' }, { cookie });

  const html = await text('/portal/requests', { cookie });
  assert.match(html, /class="tc-diff"/, 'the two columns are there');
  assert.match(html, /<span>Was<\/span><span>Asked for<\/span>/, 'headed Was and Asked for');
  assert.match(html, /6:00 PM/, 'the original end');
  assert.match(html, /7:00 PM/, 'and the requested one');
  assert.match(html, /Total hours/, 'with what it does to the pay');

  // The original must survive the decision. Before this, the "before" column
  // read the live entry, so approving a request made both columns identical
  // and what they asked to change vanished from the record.
  const c = lastCorr();
  await decide(c.id, 'approved');
  const after = await text('/portal/requests', { cookie });
  assert.match(after, /6:00 PM/, 'the original is still on the record after approval');
  assert.match(after, /Approved/, 'alongside the answer');
});

test('2C: a request with no note shows no note, not empty quotes', async () => {
  // The note went optional with the Phase 2B sheet, and this rendered a bare
  // pair of quotation marks for every request without one — now most of them.
  const emp = 243;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3243',1500,1)")
    .run(emp, 'No Note');
  const eid = seedInPeriod(emp, 5, '10:00', '18:00');
  const day = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(eid).d;
  const cookie = await signIn('3243');
  await post('/portal/clock/fix',
    { entry_id: eid, kind: 'shift_times', at_out: `${day}T19:00`, pin: '3243' }, { cookie });
  const html = await text('/portal/requests', { cookie });
  assert.ok(!/“”/.test(html), 'no empty quotation marks');
  assert.ok(!/class="tc-req-r">\s*<\/div>/.test(html), 'and no empty note row either');
});

test('2C: the requests filter selects, and counts without being selected', async () => {
  const emp = 244;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3244',1500,1)")
    .run(emp, 'Filter User');
  const a = seedInPeriod(emp, 6, '10:00', '18:00');
  const b = seedInPeriod(emp, 7, '10:00', '18:00');
  const dayA = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(a).d;
  const dayB = db.prepare('SELECT business_date d FROM time_entries WHERE id=?').get(b).d;
  const cookie = await signIn('3244');
  await post('/portal/clock/fix', { entry_id: a, kind: 'shift_times', at_out: `${dayA}T19:00`, pin: '3244' }, { cookie });
  const first = lastCorr();
  await post('/portal/clock/fix', { entry_id: b, kind: 'shift_times', at_out: `${dayB}T19:00`, pin: '3244' }, { cookie });
  await decide(first.id, 'rejected', 'roster says otherwise');

  const all = await text('/portal/requests', { cookie });
  assert.match(all, /Waiting<i>1<\/i>/, 'the waiting count rides on the chip');
  assert.match(all, /Answered<i>1<\/i>/, 'and so does the answered one');
  assert.strictEqual((all.match(/class="tc-req /g) || []).length, 2, 'All shows both');

  const waiting = await text('/portal/requests?f=pending', { cookie });
  assert.strictEqual((waiting.match(/class="tc-req /g) || []).length, 1, 'Waiting shows one');
  assert.match(waiting, /class="tc-chip on"/, 'and the chip reads as selected');

  const answered = await text('/portal/requests?f=answered', { cookie });
  assert.strictEqual((answered.match(/class="tc-req /g) || []).length, 1, 'Answered shows the other');
  assert.match(answered, /Not approved/, 'with the manager’s decision');
  assert.match(answered, /roster says otherwise/, 'and their reason');
});

test('2C: the timesheet reaches a year back, and only the recent ones may be signed', async () => {
  const cookie = await signIn('3111');
  const html = await text('/portal/timesheet', { cookie });
  const opts = html.match(/<option value="20\d\d-\d\d-\d\d"/g) || [];
  assert.ok(opts.length >= 26, `a year of periods in the selector, saw ${opts.length}`);
  // Viewing reaches further than signing. An old period renders, and does NOT
  // offer a button the route would refuse.
  const old = P.recentPeriods(20)[19];
  const page = await text(`/portal/timesheet?p=${old.start}`, { cookie });
  assert.ok(page.includes(`<option value="${old.start}" selected`), 'the old period renders');
  assert.ok(!/data-pes-open="submit"/.test(page), 'with no submit button');
  const res = await post('/portal/timesheet/submit', { period: old.start, confirm: '1', seen: 'x' }, { cookie });
  assert.match(decodeURIComponent(res.headers.get('location')), /not open for submission/,
    'and the route agrees with the screen');
});

test('2C: the day page answers with the day total it was opened for', async () => {
  const emp = 245;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3245',1500,1)")
    .run(emp, 'Two Shifts');
  const per = curPeriod();
  const day = require('../src/dates').addDays(per.start, 8);
  db.prepare('DELETE FROM time_entries WHERE employee_id = ? AND business_date = ?').run(emp, day);
  seedEntry(emp, day, '09:00', '13:00');
  seedEntry(emp, day, '17:00', '21:00');
  const cookie = await signIn('3245');

  const ts = await text(`/portal/timesheet?p=${per.start}`, { cookie });
  const rowTotal = (ts.match(new RegExp(`day/${day}[\\s\\S]*?<span class="tc-row-r"><b>([^<]+)</b>`)) || [])[1];
  assert.strictEqual(rowTotal, '8h 0m', 'the timesheet row adds both shifts');

  const page = await text(`/portal/timesheet/day/${day}`, { cookie });
  assert.match(page, /class="tcd-tot">\s*<b>8h 0m<\/b>/, 'and the day page opens with the same figure');
  assert.match(page, /2 shifts/, 'saying how many shifts that is');
  assert.strictEqual((page.match(/data-pes-open="\d+"/g) || []).length, 2, 'each with its own edit sheet');
});

// ===========================================================================
// PHASE 2D — Portal Home as status and attention.
//
// Home answers four questions: where do I stand, is anything waiting on me,
// what changed, and is there a job-specific thing to do that the tabs do not
// already carry. Everything else it used to hold was a second copy of the
// navigation.
// ===========================================================================

/** Home's own body — the tab bar is chrome on every screen, not Home content. */
const homeBody = (html) =>
  (html.match(/<div class="pt-body tc-body">[\s\S]*?(?=<nav class="pt-tabs)/) || [html])[0];

test('2D: Home reads clocked out, working and on break from the clock itself', async () => {
  const emp = 250;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3250',1500,1)")
    .run(emp, 'Home States');
  const cookie = await signIn('3250');

  const out = homeBody(await text('/portal', { cookie }));
  assert.match(out, /class="tcc tcc-off"/, 'clocked out is the neutral card');
  assert.match(out, />Clocked out</, 'named');
  assert.match(out, /href="\/portal\/clock">Clock in</, 'with one action');
  assert.ok(!/data-since/.test(out), 'and nothing ticking');

  await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });
  const on = homeBody(await text('/portal', { cookie }));
  assert.match(on, /class="tcc tcc-on"/, 'working is green');
  assert.match(on, />Working</, 'named');
  assert.match(on, /class="tcc-clock" aria-hidden="true"\s+data-since="\d+" data-now="\d+"/,
    'the live figure is server-anchored and hidden from screen readers');
  assert.match(on, /Position<\/span><b>Server/, 'position');
  assert.match(on, /Open time clock/, 'and Home hands off rather than duplicating the controls');
  assert.ok(!/Start break|Clock out/.test(on), 'no clock controls on Home');

  await post('/portal/clock/break/start', {}, { cookie });
  const brk = homeBody(await text('/portal', { cookie }));
  assert.match(brk, /class="tcc tcc-break"/, 'on break is amber');
  assert.match(brk, />On break</, 'named');
  assert.match(brk, /Open time clock/, 'one action');
  await post('/portal/clock/break/end', {}, { cookie });
  await post('/portal/clock/out', {}, { cookie });
});

test('2D: a shift left open past the threshold reads as a warning on Home', async () => {
  const emp = 251;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3251',1500,1)")
    .run(emp, 'Home Stale');
  const cookie = await signIn('3251');
  await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });
  db.prepare("UPDATE time_entries SET clock_in_at = datetime('now','-20 hours') WHERE id = ?")
    .run(activeOf(emp).id);
  const html = homeBody(await text('/portal', { cookie }));
  assert.match(html, /class="tcc tcc-warn"/, 'amber, not red — they are not blocked');
  assert.match(html, />Still clocked in</, 'named for what it is');
  assert.match(html, /over 16 hours/, 'with the threshold');
  await post('/portal/clock/out', {}, { cookie });
});

test('2D: no position at all is the only red state, and it is not actionable here', async () => {
  const emp = 252;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'',?,1500,1)")
    .run(emp, 'Home No Position', '3252');
  const cookie = await signIn('3252');
  const html = homeBody(await text('/portal', { cookie }));
  assert.match(html, /class="tcc tcc-blocked"/, 'red');
  assert.match(html, /No position is assigned to you/, 'said plainly');
  assert.ok(!/tc-btn-go/.test(html.split('tcc-facts')[0] || html), 'with no action they cannot complete');
});

test('2D: nothing waiting is a finished screen, not an empty one', async () => {
  const emp = 253;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3253',1500,1)")
    .run(emp, 'Home Quiet');
  const cookie = await signIn('3253');
  await text('/portal', { cookie });                    // first visit sets the baseline
  const html = homeBody(await text('/portal', { cookie }));
  assert.match(html, /You&rsquo;re all caught up|You’re all caught up/, 'the calm state');
  assert.ok(!/Needs your attention/.test(html), 'no attention section');
  assert.ok(!/\$\d/.test(html), 'and no invented statistics');
});

test('2D: attention items are ordered by urgency, not by module', async () => {
  const emp = 254;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3254',1500,1)")
    .run(emp, 'Home Urgent');
  const per = curPeriod();
  const eid = seedInPeriod(emp, 2, '09:00', '17:00');
  // A blocking problem on a PAST shift: a punch with no clock-out that is not
  // the one they are standing on. (Status stays complete — an 'active' row
  // would be their current punch, and Home deliberately does not scold
  // somebody for being on the clock right now.)
  db.prepare("UPDATE time_entries SET clock_out_at = NULL WHERE id = ?").run(eid);
  // And an answered request, which is real but less urgent.
  db.prepare(`INSERT INTO time_corrections (time_entry_id, employee_id, kind, original_value,
      proposed_value, reason, requested_by, decision, decided_by, decided_at)
    VALUES (?,?,'shift_times','x','y','',?,'approved','Owner',datetime('now'))`)
    .run(eid, emp, 'Home Urgent');
  const cookie = await signIn('3254');
  const html = homeBody(await text('/portal', { cookie }));

  assert.match(html, /Needs your attention/, 'the section is there');
  const first = html.indexOf('A shift needs fixing');
  const later = html.indexOf('Changed shift times');
  assert.ok(first > -1 && later > -1, 'both items rendered');
  assert.ok(first < later, 'the blocking problem comes before the answered request');
  assert.match(html, /class="tc-chip bad">Fix</, 'with a chip that says what to do');
  assert.ok(!/<details/.test(html), 'and nothing actionable is hidden behind a disclosure');
  db.prepare("UPDATE time_entries SET clock_out_at = datetime(clock_in_at, '+8 hours'), status='complete' WHERE id=?").run(eid);
});

test('2D: the tips reminder follows the worked position, not the primary one', async () => {
  // A server-primary who also busses. The busser shift is not a hand-in and
  // must not be nagged about; the server shift is.
  const emp = 255;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','3255',1500,1)")
    .run(emp, 'Home Two Jobs');
  db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
    .run(emp, 'busser', 1100);
  const D = require('../src/dates');
  const today = T2.businessDateOf(T2.nowUtc(), T2.settings().cutoffHour);
  const mk = (date, daypart, role) => {
    db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?,?,'open')").run(date, daypart);
    const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, daypart);
    db.prepare('INSERT OR IGNORE INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)')
      .run(sh.id, emp, role, 6);
    return sh.id;
  };
  const bus = mk(D.addDays(today, -2), 'cafe', 'busser');
  const cookie = await signIn('3255');
  let html = homeBody(await text('/portal', { cookie }));
  assert.ok(!/shift report/i.test(html), 'a busser shift is not something to hand in');

  const srv = mk(D.addDays(today, -1), 'dinner', 'server');
  html = homeBody(await text('/portal', { cookie }));
  assert.match(html, /Hand in your shift report/, 'the server shift is');
  assert.match(html, /class="tc-chip warn">Due</, 'with an urgency chip');
  assert.match(html, /href="\/portal\/tips"/, 'and a destination');

  // Two of them reads as two, truthfully.
  const srv2 = mk(today, 'dinner', 'server');
  html = homeBody(await text('/portal', { cookie }));
  assert.match(html, /2 shift reports need attention/, 'counted, not guessed');

  // Filing one removes it from the count.
  db.prepare(`INSERT INTO tip_submissions (shift_id, employee_id, role, cash_tips_cents, source)
    VALUES (?,?,'server',1000,'staff')`).run(srv2, emp);
  html = homeBody(await text('/portal', { cookie }));
  assert.match(html, /Hand in your shift report/, 'one left');
  assert.ok(!/2 shift reports/.test(html), 'and the count came down');
  assert.ok(!/Submit sales or tips/.test(html), 'the shortcut row stands down while one is owed');
});

test('2D: an ineligible position is never reminded, however many shifts it works', async () => {
  const emp = 256;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'busser','3256',1400,1)")
    .run(emp, 'Home Busser');
  const D = require('../src/dates');
  const today = T2.businessDateOf(T2.nowUtc(), T2.settings().cutoffHour);
  const d = D.addDays(today, -1);
  db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?,'dinner','open')").run(d);
  const sh = db.prepare("SELECT id FROM shifts WHERE date=? AND daypart='dinner'").get(d);
  db.prepare('INSERT OR IGNORE INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)')
    .run(sh.id, emp, 'busser', 8);
  const cookie = await signIn('3256');
  const html = homeBody(await text('/portal', { cookie }));
  assert.ok(!/shift report/i.test(html), 'no reminder');
  assert.ok(!/Submit sales or tips/.test(html), 'and no shortcut either');
  assert.match(html, /Report out of stock/, 'but the tools that DO apply are there');
});

test('2D: Home is not a second copy of the bottom navigation', async () => {
  const cookie = await signIn('3111');
  const html = await text('/portal', { cookie });
  const body = homeBody(html);
  for (const gone of ['Your hours &amp; pay', 'Specials &amp; 86 board', 'Your time history']) {
    assert.ok(!body.includes(gone), `"${gone}" is not a Home row — it is a tab or in More`);
  }
  // The tab bar itself is untouched: five tabs, same order, same routes.
  const tabs = (html.match(/<nav class="pt-tabs"[\s\S]*?<\/nav>/) || [''])[0];
  assert.ok(tabs, 'the tab bar rendered');
  for (const [href, label] of [['/portal', 'Home'], ['/portal/clock', 'Time clock'],
    ['/portal/timesheet', 'Timesheet'], ['/portal/earnings', 'Pay']]) {
    assert.ok(tabs.includes(`href="${href}"`) && tabs.includes(`>${label}<`), `${label} tab intact`);
  }
  assert.match(tabs, /<summary><span class="pt-tab-g" aria-hidden="true">⋯<\/span><span>More<\/span><\/summary>/,
    'and More is unchanged');
});

test('2D: Home is reachable, accessible and fits a phone', async () => {
  const cookie = await signIn('3111');
  const html = await text('/portal', { cookie });
  assert.match(html, /class="pt-crumb"/, 'the shared header');
  assert.ok(!/class="pt-back"/.test(html), 'with no way back to itself');
  assert.match(html, /<h1 class="tc-h">/, 'one h1');
  assert.strictEqual((html.match(/<h1 /g) || []).length, 1, 'and only one');
  assert.match(html, /<h2 class="tcc-top">/, 'the status card is a heading, not a div');
  assert.match(html, /viewport-fit=cover/, 'safe area');
  assert.match(html, /class="pt has-tabs"/, 'room reserved for the tab bar');
  assert.ok(!/<table/.test(html), 'no table on a phone screen');
  // Every class Home uses has to exist, or it renders as unstyled boxes.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  for (const c of ['tcc', 'tc-row', 'tc-rows', 'tc-chip', 'tc-kick-sec', 'tc-empty',
    'tc-more', 'pt-sr', 'pt-new-dot', 'pt-push-row']) {
    assert.ok(css.includes(`.${c}`), `staff.css defines .${c}`);
  }
});

test('2D: Home never shows a raw label or anything owner-only', async () => {
  const cookie = await signIn('3254');
  const body = homeBody(await text('/portal', { cookie }));
  for (const raw of ['shift_times', 'new_shift', 'wrong_out', 'needs_attention',
    'correction_pending', 'takes_tips', 'employee_id']) {
    assert.ok(!body.includes(raw), `no raw value: ${raw}`);
  }
  for (const owner of ['hourly_rate', '/payroll', '/timeclock/', 'aggregatePayroll', 'takeHome']) {
    assert.ok(!body.includes(owner), `nothing owner-only: ${owner}`);
  }
});
