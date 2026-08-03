'use strict';

// One person cannot work the same minute twice.
//
// The guards for this existed and were correct, but only one caller used them:
// the correction-request path. A manager typing the identical times straight
// into "add a punch" walked past them, and so did the edit form, and so did the
// break form. The same change made two ways gave two different answers, and the
// wrong one puts the same hour on the sheet twice — hours are what payroll pays
// on and what every tip pool is split by, so it is paid twice as well.
//
// These tests go at the helpers directly, in process. The routes are covered in
// timeclock.test.js; what is checked here is that the door itself refuses, so
// that a route added next year cannot quietly reintroduce the hole.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ov-'));
process.env.DB_PATH = path.join(dir, 'ov.db');
process.env.TZ = process.env.TZ || 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
const TC = require('../src/timeclock');

const EMP = 71;
const D = '2026-03-04';
const D2 = '2026-03-05';                        // the small hours of the same night
const at = (hhmm) => `${D} ${hhmm}:00`;
const nextDay = (hhmm) => `${D2} ${hhmm}:00`;

test.before(() => {
  db.prepare("INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','7171',1500,1)")
    .run(EMP, 'Overlap Test');
});

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const wipe = () => {
  db.prepare('DELETE FROM time_breaks WHERE employee_id = ?').run(EMP);
  db.prepare('DELETE FROM time_entries WHERE employee_id = ?').run(EMP);
};

const punch = (from, to) => TC.createEntry({
  employee_id: EMP, shift_id: null, business_date: D, daypart: 'dinner', position: 'server',
  clock_in_at: at(from), clock_out_at: to ? at(to) : null, source: 'manager', created_by: 'test',
});

const refuses = (fn, what) => {
  assert.throws(fn, (e) => e instanceof TC.ClockError, what);
};

// --- entries ---------------------------------------------------------------

test('a punch that overlaps an existing one is refused', () => {
  wipe();
  punch('17:00', '23:00');
  refuses(() => punch('20:00', '22:00'), 'wholly inside');
  refuses(() => punch('16:00', '18:00'), 'overlapping the start');
  refuses(() => TC.createEntry({ employee_id: EMP, shift_id: null, business_date: D, daypart: 'dinner',
    position: 'server', clock_in_at: at('22:00'), clock_out_at: nextDay('01:00'), source: 'manager', created_by: 'test' }),
    'overlapping the end and running past midnight');
  refuses(() => punch('16:00', '23:30'), 'swallowing it whole');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE employee_id = ?').get(EMP).n, 1,
    'and none of them landed');
});

test('a punch that merely touches another is allowed', () => {
  wipe();
  punch('17:00', '23:00');
  // 23:00 to 02:00 the next morning starts exactly when the other ends. Nobody
  // is paid twice for a boundary, and a close-down shift really looks like this.
  assert.ok(TC.createEntry({ employee_id: EMP, shift_id: null, business_date: D, daypart: 'dinner',
    position: 'server', clock_in_at: at('23:00'), clock_out_at: nextDay('02:00'), source: 'manager', created_by: 'test' }),
    'back to back is a real thing');
});

test('an open punch blocks the rest of its own day', () => {
  wipe();
  punch('17:00', null);
  refuses(() => punch('19:00', '23:00'), 'inside the open-ended stretch');
  // Before it is fine — a punch for the afternoon is not affected by somebody
  // still being on the clock this evening.
  assert.ok(punch('09:00', '12:00'), 'earlier and finished is untouched');
});

test('a punch somebody forgot to close does not block them next week', () => {
  // The whole reason an open punch expires. Read as "covers everything after
  // this", one forgotten Monday clock-out would refuse Tuesday's clock-in, and
  // Wednesday's, until a manager went back and fixed last week — with the
  // employee standing at the door unable to start their shift.
  wipe();
  // How a forgotten clock-out is actually held: open-ended, but not active —
  // an active one is already refused by the one-active-entry index, which is
  // the "you are already clocked in" message and is meant to be there.
  const forgotten = punch('17:00', null);
  TC.q.setStatus.run({ id: forgotten, status: 'missing_punch', by: 'test' });
  const later = TC.createEntry({ employee_id: EMP, shift_id: null, business_date: '2026-03-11',
    daypart: 'dinner', position: 'server', clock_in_at: '2026-03-11 17:00:00',
    source: 'portal', created_by: 'test' });
  assert.ok(later, 'a week later they clock in as normal');
  // And the hole is still a hole on its own day.
  refuses(() => punch('19:00', '23:00'), 'the same evening is still covered');
});

// --- the same rules one layer down -----------------------------------------

test('the database refuses by hand what the code refuses through the door', () => {
  // The doors are the enforcement; these triggers are what is left when
  // somebody opens the database directly or a migration script runs.
  wipe();
  punch('17:00', '23:00');
  const raw = (sql, ...args) => db.prepare(sql).run(...args);
  const insert = (inAt, outAt, status = 'complete') => raw(
    `INSERT INTO time_entries (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source)
     VALUES (?,?,'dinner','server',?,?,?,'manager')`, EMP, D, inAt, outAt, status);

  assert.throws(() => insert(at('20:00'), at('22:00')), /overlaps another/, 'overlapping');
  assert.throws(() => insert(at('23:00'), at('22:00')), /end before it starts/, 'backwards');
  assert.throws(() => insert(at('09:00'), at('12:00'), 'nonsense'), /unknown time entry status/, 'unknown status');
  assert.throws(() => raw(
    `INSERT INTO time_entries (employee_id, business_date, daypart, position, clock_in_at, status, source, raw_minutes)
     VALUES (?,?,'dinner','server',?, 'complete','manager',-5)`, EMP, D, at('09:00')),
    /minutes cannot be negative/, 'negative minutes');

  const e = TC.q.byId.get(db.prepare('SELECT id FROM time_entries WHERE employee_id = ?').get(EMP).id);
  assert.throws(() => raw('INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at) VALUES (?,?,?,?)',
    e.id, EMP, at('16:00'), at('16:30')), /inside its own shift/, 'break outside its shift');
  raw('INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at) VALUES (?,?,?,?)',
    e.id, EMP, at('19:00'), at('19:30'));
  assert.throws(() => raw('INSERT INTO time_breaks (time_entry_id, employee_id, start_at, end_at) VALUES (?,?,?,?)',
    e.id, EMP, at('19:15'), at('19:45')), /overlaps another/, 'overlapping breaks');
});

test('a punch that opens and closes in the same second is allowed', () => {
  // Timestamps here have second precision, so a double tap really does produce
  // one. Zero minutes is not backwards, and refusing it would refuse the clock.
  wipe();
  const id = TC.q.openEntry.run({ employee_id: EMP, shift_id: null, business_date: D, daypart: 'dinner',
    position: 'server', clock_in_at: at('17:00'), source: 'portal', created_by: 'test' }).lastInsertRowid;
  db.prepare("UPDATE time_entries SET clock_out_at = ?, status = 'complete' WHERE id = ?").run(at('17:00'), id);
  assert.strictEqual(TC.q.byId.get(id).clock_out_at, at('17:00'), 'closed, at zero minutes');
});

test('the boot scan reads clean on data the rules accept', () => {
  wipe();
  punch('09:00', '12:00');
  punch('17:00', '23:00');
  const r = TC.punchIntegrity();
  for (const [k, rows] of Object.entries(r)) {
    assert.strictEqual(rows.length, 0, `${k} should be empty on data built through the doors`);
  }
});

test('a punch for somebody else is never in the way', () => {
  wipe();
  const other = 72;
  db.prepare("INSERT OR IGNORE INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server','7272',1500,1)")
    .run(other, 'Overlap Other');
  punch('17:00', '23:00');
  assert.ok(TC.createEntry({ employee_id: other, shift_id: null, business_date: D, daypart: 'dinner',
    position: 'server', clock_in_at: at('17:00'), clock_out_at: at('23:00'), source: 'manager', created_by: 'test' }),
    'two people work the same dinner — that is the whole point of a restaurant');
});

test('a punch that ends before it starts is refused', () => {
  wipe();
  refuses(() => punch('23:00', '17:00'), 'backwards');
});

// --- edits -----------------------------------------------------------------

test('an edit cannot drag a punch on top of another', () => {
  wipe();
  punch('09:00', '12:00');
  const id = punch('17:00', '23:00');
  const e = TC.q.byId.get(id);
  refuses(() => TC.editEntryChecked(e, { in: at('11:00'), out: at('23:00'), daypart: 'dinner', position: 'server', by: 'test' }),
    'dragged back over the lunch punch');
  assert.strictEqual(TC.q.byId.get(id).clock_in_at, at('17:00'), 'and the punch did not move');
});

test('an edit can move a punch anywhere free', () => {
  wipe();
  const id = punch('17:00', '23:00');
  TC.editEntryChecked(TC.q.byId.get(id), { in: at('18:00'), out: at('23:30'), daypart: 'dinner', position: 'server', by: 'test' });
  assert.strictEqual(TC.q.byId.get(id).clock_in_at, at('18:00'), 'moved');
});

test('an edit cannot leave a recorded break outside the shift', () => {
  wipe();
  const id = punch('17:00', '23:00');
  const e = TC.q.byId.get(id);
  TC.addBreak(e, { start: at('19:00'), end: at('19:30'), paid: 0, by: 'test' });
  refuses(() => TC.editEntryChecked(TC.q.byId.get(id), { in: at('20:00'), out: at('23:00'), daypart: 'dinner', position: 'server', by: 'test' }),
    'clock-in dragged past the break');
  refuses(() => TC.editEntryChecked(TC.q.byId.get(id), { in: at('17:00'), out: at('18:00'), daypart: 'dinner', position: 'server', by: 'test' }),
    'clock-out dragged before the break');
});

test('a locked entry refuses to be edited at all', () => {
  wipe();
  const id = punch('17:00', '23:00');
  TC.q.setStatus.run({ id, status: 'locked', by: 'test' });
  refuses(() => TC.editEntryChecked(TC.q.byId.get(id), { in: at('18:00'), out: at('23:00'), daypart: 'dinner', position: 'server', by: 'test' }),
    'locked');
});

// --- breaks ----------------------------------------------------------------

test('a break has to sit inside its own shift', () => {
  wipe();
  const e = TC.q.byId.get(punch('17:00', '23:00'));
  refuses(() => TC.addBreak(e, { start: at('16:00'), end: at('16:30'), paid: 0, by: 'test' }), 'before the clock-in');
  refuses(() => TC.addBreak(e, { start: at('23:30'), end: at('23:45'), paid: 0, by: 'test' }), 'after the clock-out');
  refuses(() => TC.addBreak(e, { start: at('19:30'), end: at('19:00'), paid: 0, by: 'test' }), 'backwards');
});

test('two breaks on one shift cannot overlap', () => {
  wipe();
  const e = TC.q.byId.get(punch('17:00', '23:00'));
  TC.addBreak(e, { start: at('19:00'), end: at('19:30'), paid: 0, by: 'test' });
  refuses(() => TC.addBreak(e, { start: at('19:15'), end: at('19:45'), paid: 0, by: 'test' }), 'overlapping');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE time_entry_id = ?').get(e.id).n, 1,
    'and the second one did not land');
  assert.ok(TC.addBreak(e, { start: at('19:30'), end: at('19:45'), paid: 0, by: 'test' }),
    'but one starting exactly when the other ends is fine');
});

test('a break starting now cannot land inside one already recorded', () => {
  wipe();
  const e = TC.q.byId.get(punch('17:00', '23:00'));
  TC.addBreak(e, { start: at('19:00'), end: at('19:30'), paid: 0, by: 'test' });
  refuses(() => TC.startOpenBreak(e, { at: at('19:10'), paid: 0, by: 'test' }), 'inside the recorded one');
  refuses(() => TC.startOpenBreak(e, { at: at('16:00'), paid: 0, by: 'test' }), 'before the clock-in');
  assert.ok(TC.startOpenBreak(e, { at: at('21:00'), paid: 0, by: 'test' }), 'clear ground is fine');
});

// --- and the reason all of the above is worth having ------------------------

test('no write path outside the helpers touches the punch tables', () => {
  // The guards are only worth what the narrowest door is worth. If a route
  // reaches for the raw INSERT again, this is the test that says so.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const raw = ['q.openEntry.run', 'q.addClosedEntry.run', 'q.startBreak.run', 'q.editEntry.run'];
  for (const r of raw) {
    assert.ok(!src.includes(r),
      `server.js calls ${r} directly — go through TC.createEntry / editEntryChecked / addBreak / startOpenBreak instead, `
      + 'or the overlap rules apply to some punches and not others.');
  }
});

// --- the overtime split, a row at a time -----------------------------------

test('the day that crosses the weekly threshold is the one that splits', () => {
  // What a reviewer sees on the grid, and the thing that makes a weekly
  // threshold comprehensible: the early days of a week are regular, and the day
  // that tips it over comes back part regular and part overtime.
  const start = '2026-03-01';
  const mk = (date, mins) => ({ business_date: date, clock_out_at: `${date} 23:00:00`, payable_minutes: mins });
  const entries = [
    mk('2026-03-02', 600), mk('2026-03-03', 600), mk('2026-03-04', 600),
    mk('2026-03-05', 600), mk('2026-03-06', 600),          // 50 hours across five days
  ];
  const [week] = TC.splitWeeks(entries, { otEnabled: true, otThreshold: 40, periodStart: start });
  assert.strictEqual(week.payable, 3000, 'fifty hours in the week');
  assert.strictEqual(week.overtime, 600, 'ten of them over the forty');

  const byDate = Object.fromEntries(week.days.map((d) => [d.date, d]));
  assert.strictEqual(byDate['2026-03-02'].overtime, 0, 'Monday is all regular');
  assert.strictEqual(byDate['2026-03-05'].overtime, 0, 'and so is Thursday, at exactly forty');
  assert.strictEqual(byDate['2026-03-06'].regular, 0, 'Friday is the day that tipped it');
  assert.strictEqual(byDate['2026-03-06'].overtime, 600, 'so Friday carries all ten hours of it');
});

test('adding a day earlier in the week re-splits the days after it', () => {
  // The behaviour to get right: a shift added on the Wednesday changes what
  // Friday reads, because the week crossed the threshold sooner. A grid that
  // only recalculated the row being edited would quietly disagree with payroll.
  const start = '2026-03-01';
  const mk = (date, mins) => ({ business_date: date, clock_out_at: `${date} 23:00:00`, payable_minutes: mins });
  const opts = { otEnabled: true, otThreshold: 40, periodStart: start };

  const before = TC.splitWeeks([mk('2026-03-02', 600), mk('2026-03-03', 600),
    mk('2026-03-05', 600), mk('2026-03-06', 600)], opts)[0];
  const fridayBefore = before.days.find((d) => d.date === '2026-03-06');
  assert.strictEqual(fridayBefore.overtime, 0, 'forty hours exactly — no overtime yet');

  const after = TC.splitWeeks([mk('2026-03-02', 600), mk('2026-03-03', 600),
    mk('2026-03-04', 300), mk('2026-03-05', 600), mk('2026-03-06', 600)], opts)[0];
  const fridayAfter = after.days.find((d) => d.date === '2026-03-06');
  assert.strictEqual(fridayAfter.overtime, 300, 'the added Wednesday pushed five hours of Friday into overtime');
  assert.strictEqual(fridayAfter.regular, 300, 'and left the other five regular');
});

test('with overtime switched off, nothing is ever split', () => {
  const mk = (date, mins) => ({ business_date: date, clock_out_at: `${date} 23:00:00`, payable_minutes: mins });
  const [week] = TC.splitWeeks([mk('2026-03-02', 900), mk('2026-03-03', 900)],
    { otEnabled: false, otThreshold: 40, periodStart: '2026-03-01' });
  assert.strictEqual(week.overtime, 0, 'thirty hours over the threshold, and none of it overtime');
  assert.strictEqual(week.regular, week.payable, 'it is all regular');
});
