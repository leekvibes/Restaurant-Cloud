'use strict';

// Clocked minutes becoming the shift's hours.
//
// This file exists because the change it covers moves money twice over:
// work.hours is what payroll pays on AND the weight every tip pool is split by.
// A figure that is right at clock-out and wrong an hour later is worse than no
// figure at all, so most of what follows is about the second half — corrections
// approved the next morning, breaks edited, punches moved to another service.
//
// The rule underneath all of it: the clock owns a row until somebody types over
// it, and then it never touches that row again until it is handed back.

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3983;                     // unique across the suite
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ch-'));
const DB = path.join(dir, 'ch.db');
const SECRET = 'test-webhook-secret';
// Point the modules this file requires at the SAME database the server uses.
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
let child, Database, db;

const post = (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});
const text = async (p, headers = {}) => (await fetch(BASE + p, { headers })).text();

async function signIn(pin) {
  const res = await post('/tips/start', { pin });
  assert.strictEqual(res.status, 302, `PIN ${pin} is accepted`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

// One person per concern, so no test can be broken by another's leftovers.
const E = {
  both: 101,      // tips first, then the clock
  clockOnly: 102, // never submits tips
  split: 103,     // two punches on one service
  corrected: 104, // a correction that moves the hours
  overridden: 105,// a manager types over the clock
  broken: 106,    // breaks added and removed
  sent: 107,      // a shift already emailed
  pos: 108,       // the POS batch
  long: 109,      // forgot to clock out
};
const PIN = (id) => String(4000 + id - 100);

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '', WEBHOOK_SECRET: SECRET },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new Database(DB);
  const ins = db.prepare(
    'INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,?,?,?,1)');
  for (const [k, id] of Object.entries(E)) ins.run(id, `Case ${k}`, 'server', PIN(id), 1500);
});

test.after(() => { if (child) child.kill(); try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

// --- helpers ---------------------------------------------------------------

const workOf = (shiftId, empId) =>
  db.prepare('SELECT * FROM work WHERE shift_id = ? AND employee_id = ?').get(shiftId, empId);
const shiftOn = (date, daypart) =>
  db.prepare('SELECT * FROM shifts WHERE date = ? AND daypart = ?').get(date, daypart);
const entriesOf = (empId) =>
  db.prepare('SELECT * FROM time_entries WHERE employee_id = ? ORDER BY id').all(empId);

/** Add a finished punch the way a manager does, through the real route. */
async function punch(empId, date, from, to, daypart = 'dinner', position = 'server') {
  const res = await post('/timeclock/new', {
    employee_id: String(empId), position, daypart,
    in: `${date}T${from}`, out: to ? `${date}T${to}` : '',
    reason: 'seeded by the test',
  });
  assert.strictEqual(res.status, 302, 'the punch was accepted');
  return entriesOf(empId).slice(-1)[0];
}

/** Clock in and out through the portal, the way staff do. */
async function clockThrough(empId, backdateHours) {
  const cookie = await signIn(PIN(empId));
  await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });
  const e = db.prepare("SELECT * FROM time_entries WHERE employee_id = ? AND status = 'active'").get(empId);
  assert.ok(e, 'they are on the clock');
  if (backdateHours) {
    const t = new Date(Date.parse(e.clock_in_at.replace(' ', 'T') + 'Z') - backdateHours * 3600 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('UPDATE time_entries SET clock_in_at = ? WHERE id = ?').run(t, e.id);
  }
  await post('/portal/clock/out', {}, { cookie });
  return db.prepare('SELECT * FROM time_entries WHERE id = ?').get(e.id);
}

// ===========================================================================
// The two orderings the owner actually asked about.
// ===========================================================================

test('tips first, then the clock: one shift, one row, carrying both', async () => {
  const T = require('../src/timeclock');
  const day = T.businessDateOf(T.nowUtc(), T.settings().cutoffHour);
  const before = db.prepare('SELECT COUNT(*) n FROM shifts').get().n;

  // Step one: they file their tips before anyone has opened the close.
  await post('/tips', { employee_id: String(E.both), pin: PIN(E.both),
    date: day, daypart: 'dinner', position: 'server', cash_tips: '80', card_tips: '120', food: '900' });
  const sh = shiftOn(day, 'dinner');
  assert.ok(sh, 'the submission started the shift');
  assert.strictEqual(Number(workOf(sh.id, E.both).hours), 0, 'with no hours on it yet');

  // Step two: the same night's punch arrives.
  const e = await clockThrough(E.both, 6.5);
  assert.strictEqual(e.shift_id, sh.id, 'the punch joined the very shift the tips created');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shifts').get().n, before + 1,
    'and made no second shift for the same service');

  const row = workOf(sh.id, E.both);
  assert.strictEqual(Number(row.hours), Math.round((e.payable_minutes / 60) * 1000) / 1000,
    'the hours are on the shift, without anybody typing them');
  assert.strictEqual(row.hours_source, 'clock');
  const sales = db.prepare('SELECT * FROM server_sales WHERE shift_id = ? AND employee_id = ?').get(sh.id, E.both);
  assert.strictEqual(sales.cash_tips_cents, 8000, 'and the money is on the same row as the hours');
});

test('no tips at all: clocking in starts the shift, clocking out fills the hours', async () => {
  const e = await clockThrough(E.clockOnly, 7.25);
  assert.ok(e.shift_id, 'clocking in put them on a shift');
  const row = workOf(e.shift_id, E.clockOnly);
  assert.strictEqual(Number(row.hours), 7.25, 'and clocking out paid it in full');
  assert.strictEqual(row.hours_source, 'clock');
  assert.strictEqual(row.hours_set_by, `Case clockOnly`, 'stamped with who closed it');
});

// ===========================================================================
// The arithmetic.
// ===========================================================================

test('two punches on one service are summed, not overwritten — and summed before rounding', async () => {
  // 211 + 241 minutes. Rounding each first gives 7.54; summing first gives
  // 7.533, which is the true figure. At $15/hr the difference is small and
  // relentless — it is wrong on every split shift, every period.
  await punch(E.split, '2026-03-04', '09:00', '12:31');   // 211
  await punch(E.split, '2026-03-04', '13:00', '17:01');   // 241
  const sh = shiftOn('2026-03-04', 'dinner');
  const es = entriesOf(E.split);
  assert.strictEqual(es.length, 2, 'both punches stand — the second did not replace the first');
  assert.strictEqual(es[0].payable_minutes + es[1].payable_minutes, 452);
  assert.strictEqual(Number(workOf(sh.id, E.split).hours), 7.533, 'summed, then converted once');
});

test('an unpaid break comes off the hours, and putting it back restores them', async () => {
  const e = await punch(E.broken, '2026-03-05', '09:00', '17:00');   // 8h
  const sh = shiftOn('2026-03-05', 'dinner');
  assert.strictEqual(Number(workOf(sh.id, E.broken).hours), 8, 'eight hours to start');

  await post(`/timeclock/${e.id}/break`, {
    start: '2026-03-05T12:00', end: '2026-03-05T12:30', paid: '0', reason: 'lunch',
  });
  assert.strictEqual(Number(workOf(sh.id, E.broken).hours), 7.5, 'the half hour came off the shift too');

  const b = db.prepare('SELECT * FROM time_breaks WHERE time_entry_id = ?').get(e.id);
  await post(`/timeclock/break/${b.id}/delete`, { reason: 'logged twice' });
  assert.strictEqual(Number(workOf(sh.id, E.broken).hours), 8, 'and removing it put them back');
});

// ===========================================================================
// Drift — the half that only shows up the next morning.
// ===========================================================================

test('a punch moved to another service takes its hours with it — both ends', async () => {
  const e = await punch(E.corrected, '2026-03-06', '17:00', '22:00', 'dinner');   // 5h
  const from = shiftOn('2026-03-06', 'dinner');
  assert.strictEqual(Number(workOf(from.id, E.corrected).hours), 5, 'five hours on dinner');

  // The manager moves it to the cafe service.
  await post(`/timeclock/${e.id}/edit`, {
    in: '2026-03-06T17:00', out: '2026-03-06T22:00',
    position: 'server', daypart: 'cafe', reason: 'wrong service',
  });

  const to = shiftOn('2026-03-06', 'cafe');
  assert.strictEqual(Number(workOf(to.id, E.corrected).hours), 5, 'the cafe gained them');
  assert.strictEqual(Number(workOf(from.id, E.corrected).hours), 0,
    'and dinner gave them up — otherwise the same five hours are paid twice');
});

test('an approved correction reaches the shift, not just the punch', async () => {
  const T = require('../src/timeclock');
  // A punch with no clock-out: nothing to pay yet.
  const e = await punch(E.corrected, '2026-03-07', '09:00', null, 'dinner');
  const sh = shiftOn('2026-03-07', 'dinner');
  assert.strictEqual(Number(workOf(sh.id, E.corrected).hours), 0, 'an open punch pays nothing');

  const cookie = await signIn(PIN(E.corrected));
  await post('/portal/clock/fix', {
    entry_id: String(e.id), kind: 'missing_out',
    at_out: '2026-03-07T15:00', reason: 'forgot to clock out', pin: PIN(E.corrected),
  }, { cookie });
  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(e.id);
  assert.ok(c, 'the request exists');

  await post(`/timeclock/correction/${c.id}`, { decision: 'approved', note: 'checked the rota' });
  assert.strictEqual(Number(workOf(sh.id, E.corrected).hours), 6,
    'approving it put the six hours on the shift — an approved fix that never reaches payroll pays nothing');
  assert.strictEqual(T.clockedMinutesOn(sh.id, E.corrected), 360, 'and the clock agrees');
});

test('a punch nobody closed for a day is left out of the hours, and the shift stays flagged', async () => {
  // 23 hours. Paying it silently is far worse than paying nothing: $0 plus a
  // red flag gets fixed, a wrong number gets banked.
  await punch(E.long, '2026-03-08', '08:00', null, 'dinner');
  const e = entriesOf(E.long).slice(-1)[0];
  db.prepare("UPDATE time_entries SET clock_out_at = ?, status = 'complete' WHERE id = ?")
    .run('2026-03-09 12:00:00', e.id);
  // Nudge a recompute through the real route.
  await post(`/timeclock/${e.id}/edit`, {
    in: '2026-03-08T08:00', out: '2026-03-09T07:00',
    position: 'server', daypart: 'dinner', reason: 'still open from yesterday',
  });
  const sh = shiftOn('2026-03-08', 'dinner');
  const row = workOf(sh.id, E.long);
  assert.strictEqual(Number(row.hours), 0, 'a 23-hour punch writes nothing');
  const list = await text('/shifts');
  assert.match(list, /Needs review/, 'and the shift is still asking to be looked at');
});

// ===========================================================================
// The override, and the way back.
// ===========================================================================

test('a typed number wins, and no later clock activity moves it', async () => {
  const e = await punch(E.overridden, '2026-03-10', '09:00', '14:00');   // 5h
  const sh = shiftOn('2026-03-10', 'dinner');
  assert.strictEqual(Number(workOf(sh.id, E.overridden).hours), 5, 'the clock filled it');

  await post(`/shifts/${sh.id}/server`, { employee_id: String(E.overridden), hours: '8' });
  let row = workOf(sh.id, E.overridden);
  assert.strictEqual(Number(row.hours), 8, 'the manager typed 8');
  assert.strictEqual(row.hours_source, 'manager', 'and the row is theirs now');

  // A break would normally drop the hours. It must not touch this row.
  await post(`/timeclock/${e.id}/break`, {
    start: '2026-03-10T12:00', end: '2026-03-10T12:30', paid: '0', reason: 'lunch',
  });
  assert.strictEqual(Number(workOf(sh.id, E.overridden).hours), 8,
    'the clock recomputed and left the typed number exactly where it was');
});

test('saving the row with the hours field blank leaves the typed number alone', async () => {
  const sh = shiftOn('2026-03-10', 'dinner');
  // A manager fixing SALES posts an empty hours input. parseHours('') is 0, so
  // before this rule that save silently zeroed the hours.
  await post(`/shifts/${sh.id}/server`, { employee_id: String(E.overridden), hours: '', food: '250' });
  assert.strictEqual(Number(workOf(sh.id, E.overridden).hours), 8, 'still eight');
});

test('a clock-owned row is not claimed by a save that never mentioned hours', async () => {
  const sh = shiftOn('2026-03-05', 'dinner');   // E.broken, clock-owned at 8h
  await post(`/shifts/${sh.id}/server`, { employee_id: String(E.broken), hours: '', card_tips: '40' });
  const row = workOf(sh.id, E.broken);
  assert.strictEqual(row.hours_source, 'clock', 'the clock still owns it');
  assert.strictEqual(Number(row.hours), 8, 'and the figure is untouched');
});

test('handing the row back puts the clock in charge again', async () => {
  const sh = shiftOn('2026-03-10', 'dinner');
  const page = await text(`/shifts/${sh.id}`);
  assert.match(page, /Use the clocked hours/, 'the way back is offered on the sheet');

  await post(`/shifts/${sh.id}/hours-reset`, { employee_id: String(E.overridden) });
  const row = workOf(sh.id, E.overridden);
  assert.strictEqual(row.hours_source, 'clock', 'the clock has it back');
  assert.strictEqual(Number(row.hours), 4.5, 'and its own figure returned — 5h less the half-hour break');
});

// ===========================================================================
// Things that must not be allowed to destroy the record.
// ===========================================================================

test('taking somebody off a shift takes their punches with it, and says so first', async () => {
  // This used to refuse outright whenever somebody had clocked time. Once the
  // clock is running that is EVERY real person, so the button only worked for
  // staff who were never there — a control that fails in the normal case is not
  // protecting anything. It does the whole job now, and warns before it does.
  const sh = shiftOn('2026-03-05', 'dinner');
  const page = await text(`/shifts/${sh.id}`);
  assert.match(page, /This also deletes 1 punch/, 'the dialog names what goes with them');

  const before = db.prepare('SELECT COUNT(*) n FROM time_entries WHERE shift_id = ? AND employee_id = ?')
    .get(sh.id, E.broken).n;
  assert.ok(before > 0, 'they have a punch to lose');

  const res = await post(`/shifts/${sh.id}/remove`, { employee_id: String(E.broken) });
  assert.strictEqual(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /punch/, 'and the result says what went');
  assert.ok(!workOf(sh.id, E.broken), 'they are off the shift');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE shift_id = ? AND employee_id = ?')
    .get(sh.id, E.broken).n, 0, 'and the punches went too');
  // Nothing vanishes untraceably — that was the whole point of the old refusal.
  const ev = db.prepare("SELECT * FROM time_events WHERE action='deleted' AND reason='taken off the shift'").get();
  assert.ok(ev, 'the deletion is on the record');
  assert.match(ev.before_val || '', /→/, 'with the times it destroyed');
});

test('somebody still on the clock cannot be taken off mid-shift', async () => {
  // The one case still worth refusing: deleting a running punch strands a person
  // with no record of when they started, and they cannot clock out of a row that
  // is gone.
  const cookie = await signIn(PIN(E.clockOnly));
  await post('/portal/clock/in', { daypart: 'dinner' }, { cookie });
  const live = db.prepare("SELECT * FROM time_entries WHERE employee_id = ? AND status = 'active'").get(E.clockOnly);
  assert.ok(live, 'they are on the clock');

  const res = await post(`/shifts/${live.shift_id}/remove`, { employee_id: String(E.clockOnly) });
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /on the clock right now/, 'refused, with the reason');
  assert.ok(workOf(live.shift_id, E.clockOnly), 'and they are still on the shift');
  await post('/portal/clock/out', {}, { cookie });   // leave the fixture clean
});

test('a single punch can be deleted on its own, with a reason', async () => {
  // For a punch that should not exist at all — the wrong service, somebody
  // else's PIN — without taking the person off the shift they did work.
  const emp = E.corrected;
  const e = await punch(emp, '2026-05-06', '09:00', '13:00');
  const sh = shiftOn('2026-05-06', 'dinner');
  assert.strictEqual(Number(workOf(sh.id, emp).hours), 4, 'four hours on the shift');

  // A punch is a payroll record, not a stray row.
  await post(`/timeclock/${e.id}/delete`, { reason: '' });
  assert.ok(db.prepare('SELECT 1 FROM time_entries WHERE id = ?').get(e.id), 'no reason, no deletion');

  await post(`/timeclock/${e.id}/delete`, { reason: 'clocked in on the wrong service' });
  assert.ok(!db.prepare('SELECT 1 FROM time_entries WHERE id = ?').get(e.id), 'the punch is gone');
  assert.strictEqual(Number(workOf(sh.id, emp).hours), 0, 'and its hours came off the shift with it');
  const ev = db.prepare("SELECT * FROM time_events WHERE entity='entry' AND entity_id=? AND action='deleted'").get(e.id);
  assert.ok(ev, 'the deletion is on the record even though the punch is not');
  assert.match(ev.before_val || '', /09:00|13:00|2026-05-06/, 'with what it destroyed');
});

test('a shift with punches on it cannot be deleted out from under them', async () => {
  // Its own punch: the remove test above deliberately clears the ones it uses.
  await punch(E.broken, '2026-05-20', '09:00', '17:00');
  const sh = shiftOn('2026-05-20', 'dinner');
  const res = await post(`/shifts/${sh.id}/delete`, {});
  assert.strictEqual(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /clocked time/, 'refused, with a reason');
  assert.ok(db.prepare('SELECT 1 FROM shifts WHERE id = ?').get(sh.id), 'the shift survives');
  assert.ok(db.prepare('SELECT 1 FROM time_entries WHERE shift_id = ?').get(sh.id),
    'and so do the punches — the foreign key would have NULLed them silently');
});

test('a shift already emailed keeps the hours it was sent with', async () => {
  const e = await punch(E.sent, '2026-03-11', '09:00', '14:00');
  const sh = shiftOn('2026-03-11', 'dinner');
  assert.strictEqual(Number(workOf(sh.id, E.sent).hours), 5);
  db.prepare("UPDATE shifts SET status = 'emailed' WHERE id = ?").run(sh.id);

  await post(`/timeclock/${e.id}/edit`, {
    in: '2026-03-11T09:00', out: '2026-03-11T18:00',
    position: 'server', daypart: 'dinner', reason: 'they stayed late',
  });
  assert.strictEqual(Number(workOf(sh.id, E.sent).hours), 5,
    'the figure the emails were built on stands');
  const held = db.prepare("SELECT * FROM time_events WHERE entity='shift' AND entity_id=? AND action='hours_held_sent'").get(sh.id);
  assert.ok(held, 'and the app says out loud that it held one back');
});

// ===========================================================================
// The POS, which reports service rather than attendance.
// ===========================================================================

test('the POS fills in hours for somebody with no punch, and defers to everybody else', async () => {
  const body = (rows) => JSON.stringify({ date: '2026-03-12', daypart: 'dinner', servers: rows });
  const send = (rows) => fetch(`${BASE}/webhook/benugin`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET }, body: body(rows),
  });

  // Nobody punched: the POS figure is the only one there is, so it is used.
  let res = await send([{ name: 'Case pos', hours: '6' }]);
  assert.strictEqual(res.status, 200);
  const sh = shiftOn('2026-03-12', 'dinner');
  let row = workOf(sh.id, E.pos);
  assert.strictEqual(Number(row.hours), 6, 'the POS filled the blank');
  assert.strictEqual(row.hours_source, 'pos');

  // Now they punch. The clock is the restaurant's own record and outranks it.
  await punch(E.pos, '2026-03-12', '17:00', '23:00');
  assert.strictEqual(workOf(sh.id, E.pos).hours_source, 'pos',
    'the clock does not seize a row the POS already answered for');

  // And a second batch cannot overwrite a person who has punched.
  await post(`/shifts/${sh.id}/hours-reset`, { employee_id: String(E.pos) });
  assert.strictEqual(workOf(sh.id, E.pos).hours_source, 'clock', 'handed to the clock');
  res = await send([{ name: 'Case pos', hours: '99' }]);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(Number(workOf(sh.id, E.pos).hours), 6,
    'the batch left the clocked figure alone — it usually lands after close, so it would win by accident');
});

test('a malformed batch date is refused rather than minting a junk shift', async () => {
  const res = await fetch(`${BASE}/webhook/benugin`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    body: JSON.stringify({ date: 'yesterday', daypart: 'dinner', servers: [] }),
  });
  assert.strictEqual(res.status, 400, 'rejected');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date = 'yesterday'").get().n, 0);
});

// ===========================================================================
// Payroll, and the migration that has to run on the owner's real database.
// ===========================================================================

test('the hours reach payroll without anybody typing them', async () => {
  const html = await text('/payroll');
  assert.match(html, /Payroll/);
  // E.clockOnly worked 7.25h at $15 and never went near a form.
  const sh = db.prepare('SELECT shift_id FROM work WHERE employee_id = ? AND hours > 0').get(E.clockOnly);
  assert.ok(sh, 'their hours are on a shift');
  assert.strictEqual(Number(workOf(sh.shift_id, E.clockOnly).hours), 7.25);
});

test('the shift sheet marks which numbers are the clock\'s', async () => {
  const sh = shiftOn('2026-03-04', 'dinner');   // E.split, clock-owned
  const html = await text(`/shifts/${sh.id}`);
  assert.match(html, /bs-sr-src/, 'clock-derived hours carry their source');
  assert.match(html, /from the clock/, 'and the input says so rather than pre-filling');
});

// ===========================================================================
// The record refusing to be corrupted, and figures refusing to be invented.
// ===========================================================================

test('no timesheet can be opened for a span that is not a pay period', () => {
  const T = require('../src/timeclock');
  const P = require('../src/periods');
  const per = P.recentPeriods(2)[1];
  const before = db.prepare('SELECT COUNT(*) n FROM timesheets').get().n;

  // Starts on a real period start, ends a week early — the dangerous one,
  // because it would silently load and speak for the whole real fortnight.
  assert.throws(() => T.sheetFor(E.both, { start: per.start, end: '2026-07-10' }, { create: true }),
    /not a pay period/, 'a truncated span is refused');
  // Starts nowhere in particular — this one would mint an unreachable orphan.
  assert.throws(() => T.sheetFor(E.both, { start: '2026-07-08', end: '2026-07-14' }, { create: true }),
    /not a pay period/, 'an arbitrary span is refused');

  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM timesheets').get().n, before,
    'and neither wrote a row');
  // Reading an arbitrary range stays perfectly fine.
  const v = T.sheetFor(E.both, { start: '2026-07-08', end: '2026-07-14' });
  assert.strictEqual(v.id, null, 'a read of a non-period returns a virtual sheet, not a record');
});

test('the missing-punch filter finds punches that ended without a clock-out', async () => {
  // TC.alerts deep-links here. The status it named is never written by any path,
  // so the link used to land on an empty page — the one screen telling you
  // somebody forgot to clock out pointing at a page that said nothing was wrong.
  await punch(E.long, '2026-04-02', '09:00', null, 'dinner');
  const e = entriesOf(E.long).slice(-1)[0];
  db.prepare("UPDATE time_entries SET status = 'complete' WHERE id = ?").run(e.id);

  const html = await text('/timeclock?st=missing_punch&from=2026-04-01&to=2026-04-03');
  assert.match(html, new RegExp(`/timeclock/${e.id}"`), 'the entry with no clock-out is listed');
  const clean = await text('/timeclock?st=missing_punch&from=2026-03-04&to=2026-03-04');
  assert.doesNotMatch(clean, /tcm-row/, 'and a day of finished punches lists none');
});

test('a difference is only called an override when somebody actually typed one', async () => {
  // hours_source 'legacy' covers every figure that predates the clock — on a
  // real database, almost all of them. Calling that gap an override would put a
  // confident red number on nearly every historical shift for an edit nobody
  // made. The two sides are not even built the same way.
  const sh = shiftOn('2026-03-04', 'dinner');       // E.split, clock-owned, 7.533h
  db.prepare("UPDATE work SET hours = 9, hours_source = 'legacy' WHERE shift_id = ? AND employee_id = ?")
    .run(sh.id, E.split);
  const e = entriesOf(E.split)[0];
  const legacy = await text(`/timeclock/${e.id}`);
  assert.doesNotMatch(legacy, /Override/, 'a legacy figure is not an override');

  db.prepare("UPDATE work SET hours_source = 'manager' WHERE shift_id = ? AND employee_id = ?")
    .run(sh.id, E.split);
  const typed = await text(`/timeclock/${e.id}`);
  assert.match(typed, /Override/, 'a typed one is');
});

test('the long-shift threshold on the page is the one in settings', async () => {
  const before = await text('/timeclock');
  assert.doesNotMatch(before, /past 16h/, 'nothing is hardcoded to 16 once a setting exists');
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '10', pin_fix: '1', require_service: '1', alerts: '1' });
  const T = require('../src/timeclock');
  assert.strictEqual(T.settings().longShift, 10, 'the setting took');
  // Restore, so later assertions read the documented defaults.
  await post('/timeclock/settings', { cutoff: '4', dinner: '16', long: '16', pin_fix: '1', require_service: '1', alerts: '1' });
});

test('an absurd date range is shortened rather than served', async () => {
  // Node is single-threaded and the page is built synchronously into one
  // string, so a range nobody meant to ask for used to block every other
  // request for about two seconds — including a staff phone trying to clock in.
  const html = await text('/timeclock?from=1900-01-01&to=2099-12-31');
  assert.match(html, /Shortened/, 'it says the range was cut, rather than quietly returning less');
  assert.match(html, /name="from" value="2099-/, 'and the form shows the span actually used');
});

test('a range typed backwards is read the way it was meant', async () => {
  const html = await text('/timeclock?from=2026-07-01&to=2026-06-01');
  assert.match(html, /name="from" value="2026-06-01"/, 'the earlier date is the start');
  assert.match(html, /name="to" value="2026-07-01"/, 'and the later one is the end');
});

// ===========================================================================
// Who may change a punch, and when.
// ===========================================================================

test('an approved timesheet freezes the punches underneath it', async () => {
  const P = require('../src/periods');
  const emp = E.corrected;
  const day = P.recentPeriods(2)[1].start;
  const per = P.periodFor(day);
  const e = await punch(emp, day, '09:00', '17:00');
  const sh = shiftOn(day, 'dinner');
  assert.strictEqual(Number(workOf(sh.id, emp).hours), 8, 'eight hours to start');

  // Sign for it. A signature is a statement about a set of hours; the hours
  // stop being editable in place, or the signature quietly stops describing
  // what it signed.
  db.prepare(`INSERT INTO timesheets (employee_id, period_start, period_end, status)
    VALUES (?,?,?,'approved')
    ON CONFLICT(employee_id, period_start) DO UPDATE SET status='approved'`)
    .run(emp, per.start, per.end);

  const blocked = await post(`/timeclock/${e.id}/edit`, {
    in: `${day}T09:00`, out: `${day}T19:00`, position: 'server', daypart: 'dinner', reason: 'stayed late',
  });
  assert.match(decodeURIComponent(blocked.headers.get('location') || ''), /already approved/,
    'the edit is refused, and says why');
  assert.strictEqual(db.prepare('SELECT clock_out_at FROM time_entries WHERE id = ?').get(e.id).clock_out_at.slice(11, 16),
    '21:00', 'and the punch is untouched');
  assert.strictEqual(Number(workOf(sh.id, emp).hours), 8, 'so the shift still carries what was signed for');

  // Every other way in is refused too, not just the one somebody tested.
  const br = await post(`/timeclock/${e.id}/break`, {
    start: `${day}T12:00`, end: `${day}T12:30`, paid: '0', reason: 'lunch' });
  assert.match(decodeURIComponent(br.headers.get('location') || ''), /already approved/, 'adding a break too');
  const del = await post(`/timeclock/${e.id}/delete`, { reason: 'nope' });
  assert.match(decodeURIComponent(del.headers.get('location') || ''), /already approved/, 'and deleting it');
  assert.ok(db.prepare('SELECT 1 FROM time_entries WHERE id = ?').get(e.id), 'the punch survives');

  // Reopening is the deliberate act that withdraws the signature.
  db.prepare("UPDATE timesheets SET status='open' WHERE employee_id = ? AND period_start = ?").run(emp, per.start);
  const ok = await post(`/timeclock/${e.id}/edit`, {
    in: `${day}T09:00`, out: `${day}T19:00`, position: 'server', daypart: 'dinner', reason: 'stayed late',
  });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(Number(workOf(sh.id, emp).hours), 10, 'and now the correction lands');
});

// ===========================================================================
// The Today tab.
// ===========================================================================

test('Today shows today, and says so when it is showing something else', async () => {
  const T = require('../src/timeclock');
  const today = T.businessDateOf(T.nowUtc(), T.settings().cutoffHour);
  const html = await text('/timeclock');
  assert.match(html, new RegExp(`name="from" value="${today}"`), 'it opens on today, not a trailing fortnight');
  assert.doesNotMatch(html, /Back to today/, 'and does not offer a way back it does not need');

  const wider = await text('/timeclock?from=2026-03-01&to=2026-03-31');
  assert.match(wider, /Showing 2026-03-01 to 2026-03-31/, 'a wider range says what it is showing');
  assert.match(wider, /Back to today/, 'with the way back');
});

test('a punch nobody closed is counted and listed however old it is', async () => {
  // Scoped to the visible range, this count read zero for the one case it
  // exists to catch: somebody who forgot to clock out on a day that is no
  // longer on screen.
  const old = await punch(E.long, '2026-02-10', '09:00', null, 'dinner');
  db.prepare("UPDATE time_entries SET status = 'complete' WHERE id = ?").run(old.id);

  const html = await text('/timeclock');            // today, which 2026-02-10 is not
  assert.match(html, /Never clocked out/, 'the panel is there');
  assert.match(html, new RegExp(`/timeclock/${old.id}"`), 'and the punch is in it');
  const strip = (html.match(/Missing a punch<\/span><span class="bs-stat[^>]*>(\d+)/) || [])[1];
  assert.ok(Number(strip) >= 1, 'and the count sees it too');
});

test('payable-so-far deducts a running unpaid break as it runs', () => {
  const T = require('../src/timeclock');
  const e = db.prepare('SELECT * FROM time_entries WHERE clock_out_at IS NOT NULL LIMIT 1').get();
  assert.strictEqual(T.payableSoFar(e), e.payable_minutes, 'a finished punch is just its payable minutes');

  // The naive version — elapsed minus breakTotals().unpaid — climbs through an
  // unpaid break, because breakTotals counts an OPEN break as zero on purpose,
  // and then drops the moment they clock back on. A figure that goes backwards
  // is one nobody trusts again.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'timeclock.js'), 'utf8');
  const fn = src.slice(src.indexOf('function payableSoFar'), src.indexOf('function payableSoFar') + 600);
  assert.match(fn, /openBreak/, 'it looks at the break that is running');
  assert.match(fn, /!open\.paid/, 'and only deducts it when it is unpaid');
});

test('the live panel obeys the same filter as the ledger', async () => {
  const all = await text('/timeclock');
  const onlyOne = await text('/timeclock?emp=999999');   // nobody
  assert.match(onlyOne, /Nobody on the clock matches that filter|Nobody is clocked in right now/,
    'narrowing to one person does not leave the whole floor showing above the results');
  assert.ok(all.length > 0);
});

// ===========================================================================
// The employee-by-day grid.
// ===========================================================================

/** The most recent FINISHED period. */
const gridPeriod = () => require('../src/periods').recentPeriods(2)[1];
const plusDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);

// The grid only draws when the period has somebody in it, so these tests put
// punches there themselves rather than depending on another test's leftovers.
let gridReady = false;
async function seedGridPeriod() {
  if (gridReady) return;
  const per = gridPeriod();
  await punch(E.split, per.start, '09:00', '16:30');            // 7.5h, first day
  await punch(E.split, plusDays(per.start, 3), '10:00', '15:00');  // 5h, a gap either side
  await punch(E.both, per.end, '12:00', '20:00');               // the LAST day
  gridReady = true;
}

test('the grid draws every date in the period, including the ones nobody worked', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const html = await text(`/payroll/timesheets?p=${per.start}`);
  assert.match(html, /Hours by day/, 'the grid is on the page');

  const heads = html.match(/class="tsg-dh/g) || [];
  const days = Math.round((Date.parse(per.end) - Date.parse(per.start)) / 864e5) + 1;
  assert.strictEqual(heads.length, days, `one column per date (${days})`);
  // The last date is the off-by-one this will actually get wrong.
  assert.match(html, new RegExp(`data-d="${per.end}"`), 'the final day of the period is drawn');
  assert.match(html, new RegExp(`data-d="${per.start}"`), 'and the first');
});

test('the column count follows the period rather than a hardcoded fortnight', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const html = await text(`/payroll/timesheets?p=${per.start}`);
  const cols = (html.match(/--tsg-cols:(\d+)/) || [])[1];
  const days = Math.round((Date.parse(per.end) - Date.parse(per.start)) / 864e5) + 1;
  assert.strictEqual(Number(cols), days, 'the CSS column count is derived from the period');
});

test('week separators fall on real Mondays, not every seventh cell', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const html = await text(`/payroll/timesheets?p=${per.start}`);
  // Count the Mondays in the period, excluding the first day — the spine starts
  // there, so it needs no separator before it.
  let mondays = 0;
  for (let i = 1; ; i++) {
    const d = new Date(Date.parse(per.start) + i * 864e5);
    if (d.toISOString().slice(0, 10) > per.end) break;
    if (d.getUTCDay() === 1) mondays++;
  }
  const heads = (html.match(/class="tsg-dh tsg-wk"/g) || []).length;
  assert.strictEqual(heads, mondays, `${mondays} separator(s) in the header, on the Mondays`);
});

test('a day off, a day worked and a day still running all look different', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const html = await text(`/payroll/timesheets?p=${per.start}`);
  assert.match(html, /class="tsg-c tsg-none/, 'a day with nothing on it is drawn quiet');
  assert.match(html, /data-h="/, 'a worked day carries its hours');
  // An open punch must never render as a number, and never as the same nothing
  // an empty day gets — otherwise somebody on shift right now reads as absent.
  const open = html.match(/class="tsg-c tsg-open[^"]*"[^>]*>/);
  if (open) assert.ok(!/data-h=/.test(open[0]), 'a running punch shows no total yet');
});

test('the row total is the sum of its own cells', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const html = await text(`/payroll/timesheets?p=${per.start}`);
  const row = (html.match(/<a class="tsg-row"[\s\S]*?<\/a>/) || [])[0];
  assert.ok(row, 'there is at least one row');
  const cells = [...row.matchAll(/data-h="([\d.]+)"/g)].map((m) => Number(m[1]));
  const shown = Number((row.match(/class="tsg-tot"><b>([\d.]+)</) || [])[1]);
  const summed = Math.round(cells.reduce((a, b) => a + b, 0) * 100) / 100;
  assert.ok(Math.abs(summed - shown) < 0.05, `total ${shown} matches the cells ${summed}`);
});

test('the frozen columns are actually frozen', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  // The selector must be the WHOLE selector. A plain indexOf finds '.tsg-tot {'
  // inside the grouped rule '.tsg-emp, .tsg-tot {' and reads the wrong
  // declarations — which is exactly what this test caught on its first run.
  const rule = (sel) => {
    const m = css.match(new RegExp('(?:^|\\})\\s*' + sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}', 'm'));
    assert.ok(m, `${sel} has a rule of its own`);
    return m[1];
  };
  assert.match(rule('.tsg-scroll'), /overflow-x:\s*auto/, 'the grid owns its scroll container');
  assert.match(rule('.tsg-emp'), /position:\s*sticky/);
  assert.match(rule('.tsg-emp'), /left:\s*0/, 'the name stays put');
  assert.match(rule('.tsg-tot'), /right:\s*0/, 'and so does the period total');
  assert.match(rule('.tsg-dh'), /top:\s*0/, 'the dates stay put vertically');
});

test('somebody who left mid-period is still in the grid', async () => {
  const per = gridPeriod();
  const gone = 140;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,?,?,?,0)")
    .run(gone, 'Departed Soul', 'server', '4999', 1500);
  db.prepare("UPDATE employees SET active = 0 WHERE id = ?").run(gone);
  await punch(gone, per.start, '09:00', '17:00');
  // Deactivating somebody does not un-work their shifts. Dropping them here is
  // how hours end up never approved and never transferred, with nothing saying so.
  const html = await text(`/payroll/timesheets?p=${per.start}`);
  assert.match(html, /Departed Soul/, 'they still have a row');
  assert.match(html, /· left/, 'marked as gone rather than silently dropped');
});

// ===========================================================================
// The controls around the grid.
// ===========================================================================

test('a custom range shows hours and refuses to imply a decision', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const before = db.prepare('SELECT COUNT(*) n FROM timesheets').get().n;

  // Deliberately starts ON a real period start and ends early — the dangerous
  // shape, because a sheet is keyed on its start date alone, so a careless read
  // would load the whole fortnight's record and hang it above one week.
  const html = await text(`/payroll/timesheets?from=${per.start}&to=${plusDays(per.start, 6)}`);
  assert.match(html, /Read-only report/, 'it says what it is, in those words');
  assert.match(html, /Overtime is only calculated for official pay periods/,
    'and explains the overtime rule rather than implying figures went missing');
  assert.doesNotMatch(html, /ready to approve/i, 'no bulk approval on a span nobody can sign');
  assert.doesNotMatch(html, /Approve all/, 'none at all');
  // The strip used to keep saying "Awaiting approval" and "Ready to transfer"
  // over a range where neither is possible.
  assert.doesNotMatch(html, /Awaiting approval/, 'no approval stat');
  assert.doesNotMatch(html, /Ready to transfer/, 'and nothing claiming it is ready for payroll');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM timesheets').get().n, before,
    'and reading a range writes no record');
});

test('a real period is not mistaken for a custom range', async () => {
  const per = gridPeriod();
  const html = await text(`/payroll/timesheets?from=${per.start}&to=${per.end}`);
  assert.doesNotMatch(html, /Read-only report/, 'the exact span of a period is that period');
  assert.match(html, /Awaiting approval/, 'and keeps its approval controls');
});

test('the export carries the filters the page is showing', async () => {
  const all = await text('/timeclock/export?kind=punches&from=2026-01-01&to=2026-12-31');
  const one = await text(`/timeclock/export?kind=punches&from=2026-01-01&to=2026-12-31&emp=${E.split}`);
  const lines = (s) => s.trim().split('\n').length;
  assert.ok(lines(all) > lines(one),
    'narrowing to one person and exporting no longer hands back the whole floor');
  assert.ok(lines(one) > 1, 'and still returns their rows');
});

test('walking to the next employee keeps the filter as well as the period', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const html = await text(`/payroll/timesheets/${E.split}?p=${per.start}&st=open&iss=1`);
  const arrows = [...html.matchAll(/class="tsx-arrow[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  const real = arrows.filter((h) => h !== '#');
  if (!real.length) return;                      // only one person in the period
  for (const href of real) {
    assert.match(href, /st=open/, 'the filter travels with the arrow');
    assert.match(href, /iss=1/, 'all of it');
    assert.match(href, new RegExp(`p=${per.start}`), 'and so does the period');
  }
});

test('the status filter narrows the grid and says how far', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const all = await text(`/payroll/timesheets?p=${per.start}`);
  const rows = (all.match(/class="tsg-row"/g) || []).length;
  assert.ok(rows > 0, 'there are rows to narrow');

  const none = await text(`/payroll/timesheets?p=${per.start}&st=approved`);
  assert.match(none, /shown|No timesheets|nothing/i, 'a filter that matches nobody says so');
  assert.strictEqual((none.match(/class="tsg-row"/g) || []).length, 0, 'and shows no rows');
});

test('the employee walker carries the period and stops at the ends', async () => {
  await seedGridPeriod();
  const per = gridPeriod();
  const html = await text(`/payroll/timesheets?p=${per.start}`);
  const ids = [...html.matchAll(/\/payroll\/timesheets\/(\d+)\?p=/g)].map((m) => Number(m[1]));
  const uniq = [...new Set(ids)];
  if (uniq.length < 2) return;                       // needs two people to walk between

  const first = await text(`/payroll/timesheets/${uniq[0]}?p=${per.start}`);
  assert.match(first, /class="tsw-at">1 of/, 'it says where you are');
  assert.match(first, new RegExp(`/payroll/timesheets/\\d+\\?p=${per.start}`), 'and the arrow keeps the period');
  assert.match(first, /tsx-arrow off/, 'the arrow at the end is disabled, not wrapped');
});

test('the migration stamps existing hours as legacy and leaves never-set rows to the clock', () => {
  // The rule that protects the owner's live database: anything already carrying
  // a figure was typed, pushed by the POS or imported, and none of them can be
  // told apart afterwards — so all of them outrank the clock.
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mig-'));
  const old = path.join(d2, 'old.db');
  const D = new Database(old);
  D.exec(`
    CREATE TABLE shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, daypart TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(date, daypart));
    CREATE TABLE employees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL,
      email TEXT, pin TEXT, hourly_rate_cents INTEGER DEFAULT 0, pos_id TEXT, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE work (shift_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, role TEXT NOT NULL,
      hours REAL NOT NULL DEFAULT 0, PRIMARY KEY (shift_id, employee_id));
    INSERT INTO employees (id, name, role) VALUES (1, 'Typed', 'server'), (2, 'Never', 'busser');
    INSERT INTO shifts (id, date, daypart) VALUES (1, '2020-01-01', 'dinner');
    INSERT INTO work VALUES (1, 1, 'server', 8), (1, 2, 'busser', 0);`);
  D.close();

  const r = spawnSync(process.execPath, ['-e', "require('./src/timeclock');"],
    { env: { ...process.env, DB_PATH: old, TZ: 'America/New_York' },
      cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `the app opens the old database cleanly: ${r.stderr}`);

  const after = new Database(old, { readonly: true });
  const typed = after.prepare('SELECT * FROM work WHERE employee_id = 1').get();
  const never = after.prepare('SELECT * FROM work WHERE employee_id = 2').get();
  assert.strictEqual(typed.hours, 8, 'the existing figure is untouched');
  assert.strictEqual(typed.hours_source, 'legacy', 'and is marked as outranking the clock');
  assert.strictEqual(never.hours_source, null, 'a row nobody ever set stays claimable');
  after.close();
  fs.rmSync(d2, { recursive: true, force: true });
});
