'use strict';

// ===========================================================================
// Scheduler — Phase 1 domain.
//
// The invariants come first and the features come second, because the whole
// reason this module is separate from timeclock.js is a set of things it must
// never do. A scheduler that loses a feature is annoying. A scheduler that
// writes a punch, a wage or a Payroll row is a scheduler that has quietly
// changed what somebody gets paid.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-sched-'));
const DB = path.join(dir, 's.db');
process.env.DB_PATH = DB;
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
const S = require('../src/scheduler');
const TC = require('../src/timeclock');
const { addDays, isoDate, startOfToday } = require('../src/dates');

const TODAY = isoDate(startOfToday());
const at = (date, hhmm) => `${date} ${hhmm}`;      // local input, as a form sends it

let SERVER; let BARISTA; let INACTIVE; let SALARIED;

test.before(() => {
  const ins = db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
                          VALUES (?, ?, ?, ?, ?)`);
  SERVER = Number(ins.run('Sched Server', 'server', 1500, 1, '8001').lastInsertRowid);
  BARISTA = Number(ins.run('Sched Barista', 'barista', 1400, 1, '8002').lastInsertRowid);
  INACTIVE = Number(ins.run('Sched Gone', 'server', 1500, 0, '8003').lastInsertRowid);
  SALARIED = Number(ins.run('Sched Boss', 'server', 0, 1, '8004').lastInsertRowid);
  // The server also busses — a second held position, so qualification is a
  // real question rather than a single-answer one.
  db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
    .run(SERVER, 'busser', 1100);
});

/** Every table a scheduler must never touch, counted. */
const footprint = () => ({
  time_entries: db.prepare('SELECT COUNT(*) n FROM time_entries').get().n,
  time_breaks: db.prepare('SELECT COUNT(*) n FROM time_breaks').get().n,
  work: db.prepare('SELECT COUNT(*) n FROM work').get().n,
  shifts: db.prepare('SELECT COUNT(*) n FROM shifts').get().n,
  server_sales: db.prepare('SELECT COUNT(*) n FROM server_sales').get().n,
  tip_submissions: db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n,
  timesheets: db.prepare('SELECT COUNT(*) n FROM timesheets').get().n,
});

// ===========================================================================
// INVARIANT 1 — planning creates no actual anything
// ===========================================================================

test('INV1: creating a scheduled shift writes nothing to time, work or payroll', () => {
  const before = footprint();
  const s = S.create({
    employeeId: SERVER, position: 'server',
    startsAt: at(TODAY, '16:00'), endsAt: at(TODAY, '22:00'),
    breaks: [{ minutes: 30 }],
  });
  assert.ok(s.id, 'the plan exists');
  assert.deepStrictEqual(footprint(), before,
    'and every table that records ACTUAL work is untouched');
});

// ===========================================================================
// INVARIANT 2 — deleting a plan is not an edit to what happened
// ===========================================================================

test('INV2: cancelling a scheduled shift touches no punch, work row or service', () => {
  // Give the employee a real punch and a real service on the same day, so the
  // test would catch a cancel that reached across.
  db.prepare("INSERT OR IGNORE INTO shifts (date, daypart) VALUES (?, 'dinner')").run(TODAY);
  const sh = db.prepare("SELECT id FROM shifts WHERE date=? AND daypart='dinner'").get(TODAY);
  db.prepare(`INSERT OR IGNORE INTO work (shift_id, employee_id, role, hours)
              VALUES (?,?, 'server', 6)`).run(sh.id, SERVER);
  db.prepare(`INSERT INTO time_entries (employee_id, shift_id, business_date, position,
                clock_in_at, clock_out_at, status, source)
              VALUES (?,?,?, 'server', datetime('now','-6 hours'), datetime('now'), 'complete', 'portal')`)
    .run(SERVER, sh.id, TODAY);

  const before = footprint();
  const s = S.create({
    employeeId: SERVER, position: 'server',
    startsAt: at(TODAY, '16:00'), endsAt: at(TODAY, '22:00'),
  });
  S.cancel(s.id);

  assert.deepStrictEqual(footprint(), before, 'nothing that happened was disturbed');
  assert.strictEqual(S.byId(s.id).status, 'cancelled', 'the plan is cancelled');
  assert.ok(S.byId(s.id), 'and kept — a cancelled plan is still a record of what was planned');
});

// ===========================================================================
// INVARIANT 3 — the published schedule survives an unpublished edit
//
// The scenario that broke the first design, kept as a test so it cannot come
// back: what an employee sees must not change until somebody publishes.
// ===========================================================================

test('INV3: an employee keeps the last PUBLISHED schedule while a manager edits', () => {
  const day = addDays(TODAY, 3);
  const s = S.create({
    employeeId: SERVER, position: 'server',
    startsAt: at(day, '16:00'), endsAt: at(day, '22:00'),
  });

  // 1. Nothing published yet — she sees nothing.
  assert.strictEqual(S.publishedFor(SERVER).filter((r) => r.business_date === day).length, 0,
    'a draft is invisible to the employee');

  // 2. Publish 4–10.
  S.publish(s.id);
  let mine = S.publishedFor(SERVER).filter((r) => r.business_date === day);
  assert.strictEqual(mine.length, 1, 'published, so she sees it');
  const published4to10 = mine[0].starts_at;
  assert.match(mine[0].starts_at, /20:00:00$/, '4pm local = 20:00 UTC in August');

  // 3. Manager moves it to 5–11 and does NOT republish.
  S.edit(s.id, { startsAt: at(day, '17:00'), endsAt: at(day, '23:00') });
  assert.strictEqual(S.byId(s.id).changed_after_publish, 1,
    'the manager is told there are unpublished edits');

  // 4. She opens My Schedule. She must still see 4–10.
  mine = S.publishedFor(SERVER).filter((r) => r.business_date === day);
  assert.strictEqual(mine.length, 1, 'still exactly one published shift');
  assert.strictEqual(mine[0].starts_at, published4to10,
    'STILL 4–10 — the unpublished edit did not reach her');
  assert.match(mine[0].ends_at, /02:00:00$/, 'and still ending at 10pm local');

  // 5. Republish. Now she sees 5–11.
  S.publish(s.id);
  mine = S.publishedFor(SERVER).filter((r) => r.business_date === day);
  assert.match(mine[0].starts_at, /21:00:00$/, 'now 5pm local');
  assert.strictEqual(S.byId(s.id).changed_after_publish, 0, 'and the hint is cleared');
});

test('INV3b: a cancelled shift stays on the employee schedule until the cancellation publishes', () => {
  const day = addDays(TODAY, 4);
  const s = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '16:00'), endsAt: at(day, '22:00') });
  S.publish(s.id);
  assert.strictEqual(S.publishedFor(SERVER).filter((r) => r.business_date === day).length, 1);

  S.cancel(s.id);
  assert.strictEqual(S.publishedFor(SERVER).filter((r) => r.business_date === day).length, 1,
    'a cancellation nobody has been told about has not happened yet');

  S.publish(s.id);
  assert.strictEqual(S.publishedFor(SERVER).filter((r) => r.business_date === day).length, 0,
    'published, so it leaves her schedule');
});

test('INV3c: reassigning a published shift leaves the original employee seeing it', () => {
  const day = addDays(TODAY, 5);
  const s = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '16:00'), endsAt: at(day, '22:00') });
  S.publish(s.id);

  S.edit(s.id, { employeeId: BARISTA, position: 'barista' });
  assert.strictEqual(S.publishedFor(SERVER).filter((r) => r.business_date === day).length, 1,
    'the server still sees the shift she was given');
  assert.strictEqual(S.publishedFor(BARISTA).filter((r) => r.business_date === day).length, 0,
    'and the barista has not been told he has it');

  S.publish(s.id);
  assert.strictEqual(S.publishedFor(SERVER).filter((r) => r.business_date === day).length, 0);
  assert.strictEqual(S.publishedFor(BARISTA).filter((r) => r.business_date === day).length, 1);
});

// ===========================================================================
// INVARIANT 4 — the stamped service does not move
// ===========================================================================

test('INV4: changing the service boundary does not rewrite existing shifts', () => {
  const day = addDays(TODAY, 6);
  const before = TC.settings();
  // 3pm, with dinner starting at 16:00 → cafe.
  const s = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '15:00'), endsAt: at(day, '21:00') });
  assert.strictEqual(s.daypart, 'cafe', 'stamped cafe under the current rule');

  // Owner moves dinner earlier, to 14:00. The same 3pm start would now be dinner.
  TC.saveSettings({ ...before, dinnerFrom: 14 });
  assert.strictEqual(S.serviceFor(TC.localInputToUtc(at(day, '15:00'))), 'dinner',
    'a NEW shift at 3pm would now be dinner');
  assert.strictEqual(S.byId(s.id).daypart, 'cafe',
    'but the existing one is untouched — history is not rewritten by a setting');

  // An unrelated edit must not re-stamp it either.
  S.edit(s.id, { note: 'still the same service' });
  assert.strictEqual(S.byId(s.id).daypart, 'cafe', 'and an edit to the note leaves it alone');

  TC.saveSettings(before);
});

test('INV4b: moving the START does re-stamp, because it is a different shift now', () => {
  const day = addDays(TODAY, 7);
  const s = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '09:00'), endsAt: at(day, '15:00') });
  assert.strictEqual(s.daypart, 'cafe');
  S.edit(s.id, { startsAt: at(day, '17:00'), endsAt: at(day, '23:00') });
  assert.strictEqual(S.byId(s.id).daypart, 'dinner', 'a shift moved into dinner IS dinner');
});

// ===========================================================================
// INVARIANT 5 — an inactive employee cannot be scheduled
// ===========================================================================

test('INV5: an inactive employee is refused at creation, not flagged afterwards', () => {
  assert.throws(() => S.create({
    employeeId: INACTIVE, position: 'server',
    startsAt: at(addDays(TODAY, 2), '16:00'), endsAt: at(addDays(TODAY, 2), '22:00'),
  }), /not active/i, 'refused');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) n FROM scheduled_shifts WHERE employee_id = ?').get(INACTIVE).n, 0,
    'and no row was written');
});

// ===========================================================================
// INVARIANT 6 — every minute of the day resolves to exactly one service
// ===========================================================================

test('INV6: serviceFor answers for every minute, and never two things', () => {
  const day = addDays(TODAY, 10);
  const seen = new Set();
  for (let h = 0; h < 24; h += 1) {
    for (const m of ['00', '30']) {
      const svc = S.serviceFor(TC.localInputToUtc(at(day, `${String(h).padStart(2, '0')}:${m}`)));
      assert.ok(S.DAYPARTS.includes(svc), `${h}:${m} resolves to a real service (${svc})`);
      seen.add(svc);
    }
  }
  assert.deepStrictEqual([...seen].sort(), ['cafe', 'dinner'],
    'and both services are reachable — one boundary, no gap, no overlap');
});

// ===========================================================================
// INVARIANT 7 — Time Clock is untouched
// ===========================================================================

test('INV7: the scheduler does not change how a punch is stamped', () => {
  // Phase 1 deliberately leaves clock-in alone: it still asks for the service
  // and still refuses without one. Asserted on the module surface, because the
  // route is not this phase's to change.
  assert.strictEqual(typeof TC.suggestDaypart, 'function', 'the clock keeps its own helper');
  assert.strictEqual(TC.settings().requireService, true,
    'and the setting that makes the clock ask is untouched');
  // The scheduler reads that helper; it does not replace or wrap the clock's use.
  const utc = TC.localInputToUtc(at(TODAY, '18:00'));
  assert.strictEqual(S.serviceFor(utc), TC.suggestDaypart(utc, TC.settings().dinnerFrom),
    'one definition of which service this is, shared rather than duplicated');
});

// ===========================================================================
// INVARIANT 8 — Payroll cannot see any of this
// ===========================================================================

test('INV8: aggregatePayroll is byte-identical before and after a week of scheduled shifts', () => {
  const { aggregatePayroll } = require('../src/reports');
  const period = { start: addDays(TODAY, -13), end: TODAY };
  const before = JSON.stringify(aggregatePayroll(period.start, period.end));

  const made = [];
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(period.start, i);
    made.push(S.create({ employeeId: SERVER, position: 'server',
      startsAt: at(d, '16:00'), endsAt: at(d, '22:00'), breaks: [{ minutes: 30 }] }).id);
  }
  S.publish(made);

  const after = JSON.stringify(aggregatePayroll(period.start, period.end));
  assert.strictEqual(after, before,
    'a fully published week of plans changes not one cent of Payroll');
});

// ===========================================================================
// Behaviour
// ===========================================================================

test('a shift may only be given to somebody who holds the position', () => {
  const day = addDays(TODAY, 11);
  assert.throws(() => S.create({ employeeId: BARISTA, position: 'server',
    startsAt: at(day, '16:00'), endsAt: at(day, '22:00') }), /not assigned to that position/i);
  // The server also busses, so that one is allowed.
  const ok = S.create({ employeeId: SERVER, position: 'busser',
    startsAt: at(day, '16:00'), endsAt: at(day, '22:00') });
  assert.strictEqual(ok.position, 'busser', 'a held second position is schedulable');
});

test('an open shift has no employee, and that is legal', () => {
  const day = addDays(TODAY, 12);
  const open = S.create({ employeeId: null, position: 'server',
    startsAt: at(day, '16:00'), endsAt: at(day, '22:00') });
  assert.strictEqual(open.employee_id, null, 'nobody assigned');
  assert.strictEqual(open.status, 'draft');
  // Publishing it reaches nobody — there is no claim surface until Phase 8.
  const out = S.publish(open.id);
  assert.strictEqual(out[0].action, 'skipped-open', 'and publishing it tells nobody, yet');
});

test('a shift running past midnight belongs to the night it began on', () => {
  const day = addDays(TODAY, 13);
  const s = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '18:00'), endsAt: at(addDays(day, 1), '02:00') });
  assert.strictEqual(s.business_date, S.businessDateFor(TC.localInputToUtc(at(day, '18:00'))),
    'the business date comes from the start, by the clock’s own cutoff');
  assert.strictEqual(s.daypart, 'dinner');
  assert.ok(s.ends_at > s.starts_at, 'and it genuinely ends after it starts');
});

test('nonsense times are refused', () => {
  const day = addDays(TODAY, 14);
  assert.throws(() => S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '22:00'), endsAt: at(day, '16:00') }), /end after it starts/i);
  assert.throws(() => S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '16:00'), endsAt: at(addDays(day, 3), '16:00') }), /longer than a day/i);
});

test('planned breaks keep minutes, and a time only when there is one', () => {
  const day = addDays(TODAY, 15);
  const s = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '16:00'), endsAt: at(day, '22:00'),
    breaks: [{ minutes: 30 }, { minutes: 15, plannedStartAt: at(day, '19:00'), paid: true }] });
  assert.strictEqual(s.breaks.length, 2);
  assert.strictEqual(s.breaks[0].minutes, 30);
  assert.strictEqual(s.breaks[0].planned_start_at, null, 'somewhere in the shift');
  assert.strictEqual(s.breaks[1].minutes, 15);
  assert.ok(s.breaks[1].planned_start_at, 'and this one has a time Day view can draw');
  assert.strictEqual(s.breaks[1].paid, 1);
  // And they are nowhere near time_breaks, which could not hold them anyway.
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE employee_id = ?').get(SERVER).n,
    db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE employee_id = ?').get(SERVER).n);
});

test('overlaps are detectable — the validation engine will need this', () => {
  const day = addDays(TODAY, 16);
  const a = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '16:00'), endsAt: at(day, '22:00') });
  // Creating the clash is allowed — Phase 4 decides how loudly to complain.
  const b = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(day, '20:00'), endsAt: at(day, '23:00') });
  assert.strictEqual(S.overlapsFor(S.byId(b.id)).length, 1, 'the clash is visible');
  assert.strictEqual(S.overlapsFor(S.byId(b.id))[0].id, a.id, 'and names the shift it clashes with');
});

// ===========================================================================
// Copy previous week
// ===========================================================================

test('copying a week produces drafts, never published shifts', () => {
  const from = addDays(TODAY, 21);
  const to = addDays(from, 7);
  const src = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(from, '16:00'), endsAt: at(from, '22:00'), breaks: [{ minutes: 30 }] });
  S.publish(src.id);
  assert.strictEqual(S.byId(src.id).status, 'published', 'the source is published');

  const { made } = S.copyWeek(from, to);
  assert.ok(made.length >= 1, 'something was copied');
  for (const id of made) {
    assert.strictEqual(S.byId(id).status, 'draft', 'every copy is a draft');
  }
  assert.strictEqual(S.publishedFor(SERVER, { from: to, to: addDays(to, 6) }).length, 0,
    'and nothing reached the employee');
  assert.strictEqual(S.byId(made[0]).breaks.length, 1, 'planned breaks come along');
});

test('copying the same week twice does not double the schedule', () => {
  const from = addDays(TODAY, 35);
  const to = addDays(from, 7);
  S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(from, '16:00'), endsAt: at(from, '22:00') });

  const first = S.copyWeek(from, to);
  const second = S.copyWeek(from, to);
  assert.ok(first.made.length >= 1, 'the first copy lands');
  assert.strictEqual(second.made.length, 0, 'the second copies nothing new');
  assert.ok(second.skipped.some((s) => /already/.test(s.why)), 'and says why');
});

test('copying skips anybody who has gone inactive since', () => {
  const from = addDays(TODAY, 49);
  const to = addDays(from, 7);
  S.create({ employeeId: BARISTA, position: 'barista',
    startsAt: at(from, '09:00'), endsAt: at(from, '15:00') });
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(BARISTA);

  const { made, skipped } = S.copyWeek(from, to);
  assert.strictEqual(made.length, 0, 'nothing copied for a person who has left');
  assert.ok(skipped.some((s) => s.why === 'inactive'), 'and it says so');
  db.prepare('UPDATE employees SET active = 1 WHERE id = ?').run(BARISTA);
});

// ===========================================================================
// The employee window
// ===========================================================================

test('the employee window is a rolling tail, not a calendar week', () => {
  // Yesterday's shift is exactly the one somebody checks when they are
  // wondering whether they were paid for it. A "current week" boundary would
  // erase it every Monday morning.
  const yesterday = addDays(TODAY, -1);
  const s = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(yesterday, '16:00'), endsAt: at(yesterday, '22:00') });
  S.publish(s.id);
  assert.strictEqual(S.publishedFor(SERVER).filter((r) => r.business_date === yesterday).length, 1,
    'yesterday is still there this morning');

  // And something long past is not.
  const old = addDays(TODAY, -40);
  const o = S.create({ employeeId: SERVER, position: 'server',
    startsAt: at(old, '16:00'), endsAt: at(old, '22:00') });
  S.publish(o.id);
  assert.strictEqual(S.publishedFor(SERVER).filter((r) => r.business_date === old).length, 0,
    'but a shift from six weeks ago is Pay’s question, not the schedule’s');
});
