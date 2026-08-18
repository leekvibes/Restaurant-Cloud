'use strict';

// ===========================================================================
// Scheduler — Phase 6 domain: availability and time off.
//
// THE MIGRATION INVARIANT COMES FIRST, because it is the one mistake in this
// phase that would be visible to every employee on the day it shipped: no rows
// must mean AVAILABLE. Every existing employee has zero rows the moment these
// tables arrive, and the opposite reading marks the whole roster unavailable
// and lights the board with issues for a schedule that was correct yesterday.
//
// Then the overnight cases, because a restaurant rule that ends after midnight
// is the normal case rather than the edge one, and every label available
// (calendar date, business date, weekday) disagrees about where it belongs.
// Only the instants agree.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-avail-'));
const DB = path.join(dir, 'a.db');
process.env.DB_PATH = DB;
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
const S = require('../src/scheduler');
const P = require('../src/periods');
const TC = require('../src/timeclock');

// A fixed Friday, so the weekday arithmetic is readable rather than relative.
const FRI = '2026-08-21';
const SAT = '2026-08-22';
const SUN = '2026-08-23';
const utc = (local) => TC.localInputToUtc(local);

let EMP; let OTHER;

test.before(() => {
  const ins = db.prepare('INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES (?,?,?,?,?)');
  EMP = Number(ins.run('Avail One', 'server', 1500, 1, '8701').lastInsertRowid);
  OTHER = Number(ins.run('Avail Two', 'server', 1500, 1, '8702').lastInsertRowid);
});

const clean = () => {
  db.prepare('DELETE FROM availability_rules').run();
  db.prepare('DELETE FROM time_off_requests').run();
  P.setSetting('sch_availability', '1');
};
const rule = (o) => db.prepare(`INSERT INTO availability_rules
  (employee_id, avail_kind, weekday, on_date, all_day, start_min, end_min, effective_from, effective_until)
  VALUES (@employee_id,@avail_kind,@weekday,@on_date,@all_day,@start_min,@end_min,@effective_from,@effective_until)`)
  .run({ employee_id: EMP, avail_kind: 'unavailable', weekday: null, on_date: null,
    all_day: 0, start_min: null, end_min: null, effective_from: null, effective_until: null, ...o }).lastInsertRowid;
const timeOff = (o) => db.prepare(`INSERT INTO time_off_requests
  (employee_id, starts_at, ends_at, all_day, status) VALUES (@employee_id,@starts_at,@ends_at,@all_day,@status)`)
  .run({ employee_id: EMP, all_day: 1, status: 'approved', ...o }).lastInsertRowid;
const state = (a, b, who = EMP) => S.availabilityFor(who, utc(a), utc(b)).state;

// --- the invariant -------------------------------------------------------

test('MIGRATION: no rows means available, for everybody', () => {
  clean();
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM availability_rules').get().c, 0, 'nothing seeded');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM time_off_requests').get().c, 0, 'nothing seeded');
  for (const who of [EMP, OTHER]) {
    const r = S.availabilityFor(who, utc(`${FRI} 16:00`), utc(`${FRI} 22:00`));
    assert.strictEqual(r.state, 'available', 'an employee who has stated nothing is available');
    assert.strictEqual(r.rule, null, 'and no rule is invented for them');
    assert.strictEqual(r.timeOff, null);
    assert.deepStrictEqual(r.reasons, [], 'nothing to explain');
  }
});

test('MIGRATION: deleting the last rule returns to available, with no extra write', () => {
  clean();
  const id = rule({ weekday: 5, all_day: 1 });
  assert.strictEqual(state(`${FRI} 16:00`, `${FRI} 22:00`), 'unavailable');
  db.prepare('DELETE FROM availability_rules WHERE id = ?').run(id);
  assert.strictEqual(state(`${FRI} 16:00`, `${FRI} 22:00`), 'available', 'absence is the default again');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM availability_rules').get().c, 0,
    'and returning to the default stored nothing');
});

// --- overnight, the five locked cases ------------------------------------

test('an overnight rule is ONE rule, anchored to the day it starts', () => {
  clean();
  rule({ weekday: 5, start_min: 22 * 60, end_min: 2 * 60 });   // Friday 22:00 -> 02:00

  assert.strictEqual(state(`${FRI} 23:00`, `${SAT} 01:00`), 'unavailable', 'a shift fully inside it');
  assert.strictEqual(state(`${SAT} 01:00`, `${SAT} 03:00`), 'unavailable', 'a Saturday shift overlapping the tail');
  assert.strictEqual(state(`${SAT} 02:00`, `${SAT} 05:00`), 'available', 'touching the end is not overlapping it');
  assert.strictEqual(state(`${FRI} 18:00`, `${FRI} 21:00`), 'available', 'before it starts');
  assert.strictEqual(state(`${SAT} 22:00`, `${SUN} 02:00`), 'available',
    'the same clock times a day later belong to a SATURDAY rule, which does not exist');
});

test('the tail of an overnight rule survives its own effective_until', () => {
  clean();
  // Effective through Friday. The occurrence STARTS on Friday, so it keeps the
  // whole of itself — truncating at midnight would silently shorten the last
  // one somebody ever stated.
  rule({ weekday: 5, start_min: 22 * 60, end_min: 2 * 60, effective_until: FRI });
  assert.strictEqual(state(`${SAT} 01:00`, `${SAT} 03:00`), 'unavailable', 'the Saturday tail still applies');
  assert.strictEqual(state('2026-08-28 23:00', '2026-08-29 01:00'), 'available', 'the next Friday does not');
});

// --- precedence ----------------------------------------------------------

test('a one-off beats the recurring rule for that day, in both directions', () => {
  clean();
  rule({ weekday: 5, all_day: 1 });                                    // every Friday: off
  rule({ on_date: FRI, avail_kind: 'prefer', all_day: 1 });            // but this Friday: keen
  assert.strictEqual(state(`${FRI} 16:00`, `${FRI} 22:00`), 'preferred',
    'the specific statement wins over the standing one');
  assert.strictEqual(state('2026-08-28 16:00', '2026-08-28 22:00'), 'unavailable',
    'and the standing one still governs every other Friday');
});

test('within a tier, unavailable beats prefer', () => {
  clean();
  rule({ weekday: 5, avail_kind: 'prefer', all_day: 1 });
  rule({ weekday: 5, avail_kind: 'unavailable', start_min: 16 * 60, end_min: 20 * 60 });
  assert.strictEqual(state(`${FRI} 17:00`, `${FRI} 19:00`), 'unavailable', 'a hard no outranks a preference');
  assert.strictEqual(state(`${FRI} 21:00`, `${FRI} 23:00`), 'preferred', 'outside it, the preference stands');
});

test('effective dates are inclusive at both ends', () => {
  clean();
  rule({ weekday: 5, all_day: 1, effective_from: FRI, effective_until: '2026-09-04' });
  assert.strictEqual(state(`${FRI} 16:00`, `${FRI} 22:00`), 'unavailable', 'effective_from is inclusive');
  assert.strictEqual(state('2026-09-04 16:00', '2026-09-04 22:00'), 'unavailable', 'effective_until is inclusive');
  assert.strictEqual(state('2026-08-14 16:00', '2026-08-14 22:00'), 'available', 'before it, nothing');
  assert.strictEqual(state('2026-09-11 16:00', '2026-09-11 22:00'), 'available', 'after it, nothing');
});

// --- time off ------------------------------------------------------------

test('approved time off beats everything, including a prefer rule', () => {
  clean();
  rule({ weekday: 5, avail_kind: 'prefer', all_day: 1 });
  const id = timeOff({ starts_at: utc(`${FRI} 00:00`), ends_at: utc(`${SAT} 00:00`) });
  const r = S.availabilityFor(EMP, utc(`${FRI} 16:00`), utc(`${FRI} 22:00`));
  assert.strictEqual(r.state, 'unavailable', 'an approved absence is not a preference');
  assert.strictEqual(r.timeOff.status, 'approved');
  assert.ok(r.reasons.includes(`timeoff:${id}`), 'and it says which request');
});

test('a PENDING request is context and never changes the answer', () => {
  clean();
  const id = timeOff({ starts_at: utc(`${FRI} 00:00`), ends_at: utc(`${SAT} 00:00`), status: 'pending' });
  const r = S.availabilityFor(EMP, utc(`${FRI} 16:00`), utc(`${FRI} 22:00`));
  assert.strictEqual(r.state, 'available',
    'asking for a day off must not let an employee put a warning on the board');
  assert.strictEqual(r.timeOff.id, id, 'but the manager can still be shown it');
  assert.strictEqual(r.timeOff.status, 'pending');
  assert.deepStrictEqual(r.reasons, [], 'it is not a reason for anything yet');
});

test('rejected and withdrawn requests are invisible to schedule checks', () => {
  clean();
  for (const status of ['rejected', 'withdrawn']) {
    db.prepare('DELETE FROM time_off_requests').run();
    timeOff({ starts_at: utc(`${FRI} 00:00`), ends_at: utc(`${SAT} 00:00`), status });
    const r = S.availabilityFor(EMP, utc(`${FRI} 16:00`), utc(`${FRI} 22:00`));
    assert.strictEqual(r.state, 'available', `${status} does not constrain anything`);
    assert.strictEqual(r.timeOff, null, `and ${status} is not reported as context either`);
  }
});

test('the dedupe index stops a retry without stopping the lifecycle', () => {
  // The index is UNIQUE (employee_id, starts_at, ends_at) WHERE status='pending'.
  // Scoped to pending on purpose: its job is idempotency — a double-tapped
  // submit or a retried POST — and NOT policing whether asking again is
  // reasonable. Every terminal status must leave the employee able to ask again,
  // because a request that ends 'rejected' and can never be re-raised is a
  // conversation the schema has decided is over.
  clean();
  const args = { starts_at: utc(`${FRI} 00:00`), ends_at: utc(`${SAT} 00:00`), status: 'pending' };
  timeOff(args);
  assert.throws(() => timeOff(args), /UNIQUE|constraint/i,
    'a double-tapped submit is refused by the schema, not by a disabled button');

  for (const terminal of ['rejected', 'withdrawn', 'approved']) {
    db.prepare("UPDATE time_off_requests SET status = ? WHERE status = 'pending'").run(terminal);
    assert.doesNotThrow(() => timeOff(args), `asking again after ${terminal} is allowed by the schema`);
  }
  // Note the last one: a fresh request over an ALREADY-APPROVED window is
  // allowed here deliberately. It is redundant rather than corrupt, and the
  // place to refuse it is the submit route with a sentence a person can read —
  // a raw UNIQUE violation surfaces as a database error, not an explanation.
});

// --- timezone and DST ----------------------------------------------------
//
// The resolver memoises local<->UTC conversion because it measured at ~104us a
// call and dominated everything. These tests exist so that speed can never be
// bought with a wrong hour.

test('memoised conversion agrees with the direct one, including on DST days', () => {
  const cases = [
    ['2026-03-08', 60, 240, 'spring forward'],
    ['2026-11-01', 60, 240, 'fall back'],
    ['2026-08-21', 22 * 60, 2 * 60, 'ordinary summer, overnight'],
    ['2026-01-15', 22 * 60, 2 * 60, 'ordinary winter, overnight'],
  ];
  for (const [date, sm, em, label] of cases) {
    const first = S.ruleWindowOn({ all_day: 0, start_min: sm, end_min: em }, date);
    const second = S.ruleWindowOn({ all_day: 0, start_min: sm, end_min: em }, date);
    assert.deepStrictEqual(second, first, `${label}: a cache hit equals the miss that filled it`);
    const hh = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const endDate = em <= sm ? require('../src/dates').addDays(date, 1) : date;
    assert.strictEqual(first.start, TC.localInputToUtc(`${date} ${hh(sm)}`), `${label}: start matches TC`);
    assert.strictEqual(first.end, TC.localInputToUtc(`${endDate} ${hh(em)}`), `${label}: end matches TC`);
  }
});

test('DST is really applied, not flattened by the cache', () => {
  const span = (date) => {
    const w = S.ruleWindowOn({ all_day: 0, start_min: 60, end_min: 240 }, date);   // 01:00 -> 04:00 local
    return (new Date(w.end.replace(' ', 'T') + 'Z') - new Date(w.start.replace(' ', 'T') + 'Z')) / 3600000;
  };
  assert.strictEqual(span('2026-08-21'), 3, 'an ordinary day: three local hours are three real hours');
  assert.strictEqual(span('2026-03-08'), 2, 'spring forward: the 2am hour does not exist, so it is two');
  assert.strictEqual(span('2026-11-01'), 4, 'fall back: the 1am hour happens twice, so it is four');
});

test('the cache is keyed by ZONE, so it cannot serve another timezone answer', () => {
  // timeclock.js reads the zone per call — `const TZ = () => process.env.TZ ...`
  // — so a local string does not name one instant, it names one per zone. A
  // cache keyed on the string alone would answer a London question with a New
  // York instant once the string had been seen.
  const was = process.env.TZ;
  const win = () => S.ruleWindowOn({ all_day: 0, start_min: 22 * 60, end_min: 2 * 60 }, FRI).start;
  try {
    const ny = win();                      // fills the cache under New York
    process.env.TZ = 'Europe/London';
    const ldn = win();                     // same key text, different zone
    assert.notStrictEqual(ldn, ny, 'the zone change is honoured on an already-cached string');
    process.env.TZ = was;
    assert.strictEqual(win(), ny, 'and switching back restores the original answer');
  } finally { process.env.TZ = was; }
});

// --- the setting ---------------------------------------------------------

test('the setting is ON when nobody has ever touched it', () => {
  clean();
  db.prepare("DELETE FROM settings WHERE key = 'sch_availability'").run();
  assert.strictEqual(S.availabilityEnabled(), true,
    'an absent key reads as enabled — shipping it dark would be the dead toggle the roadmap forbids');
});

test('sch_availability=0 silences RULES and leaves TIME OFF completely alone', () => {
  clean();
  rule({ weekday: 5, all_day: 1 });
  const off = timeOff({ starts_at: utc(`${SAT} 00:00`), ends_at: utc(`${SUN} 00:00`) });
  P.setSetting('sch_availability', '0');

  assert.strictEqual(state(`${FRI} 16:00`, `${FRI} 22:00`), 'available',
    'the rule is not consulted while the feature is off');
  const sat = S.availabilityFor(EMP, utc(`${SAT} 16:00`), utc(`${SAT} 22:00`));
  assert.strictEqual(sat.state, 'unavailable',
    'but an absence a manager personally approved still conflicts');
  assert.strictEqual(sat.timeOff.id, off);

  // Disabling is not deleting.
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM availability_rules').get().c, 1,
    'the rule is preserved, not dropped');
  P.setSetting('sch_availability', '1');
  assert.strictEqual(state(`${FRI} 16:00`, `${FRI} 22:00`), 'unavailable', 'and it comes straight back');
});

// --- the batch form ------------------------------------------------------

test('the batch answers per employee and never bleeds between them', () => {
  clean();
  rule({ employee_id: EMP, weekday: 5, all_day: 1 });
  const many = S.availabilityForMany([EMP, OTHER], utc(`${FRI} 16:00`), utc(`${FRI} 22:00`));
  assert.strictEqual(many.get(EMP).state, 'unavailable');
  assert.strictEqual(many.get(OTHER).state, 'available', "one person's rule is not another's");
  assert.strictEqual(many.size, 2);
});

test('a context resolves the same answers as the one-shot form', () => {
  clean();
  rule({ weekday: 5, start_min: 22 * 60, end_min: 2 * 60 });
  const ctx = S.availabilityContext([EMP], utc(`${FRI} 00:00`), utc(`${SUN} 00:00`));
  for (const [a, b] of [[`${FRI} 23:00`, `${SAT} 01:00`], [`${SAT} 02:00`, `${SAT} 05:00`]]) {
    assert.strictEqual(S.resolveAvailability(ctx, EMP, utc(a), utc(b)).state,
      S.availabilityFor(EMP, utc(a), utc(b)).state, `${a} agrees both ways`);
  }
});

// --- the boundary that matters most --------------------------------------

test('resolving availability writes nothing, anywhere', () => {
  clean();
  rule({ weekday: 5, all_day: 1 });
  timeOff({ starts_at: utc(`${SAT} 00:00`), ends_at: utc(`${SUN} 00:00`) });
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const before = ['time_entries', 'work', 'time_breaks', 'scheduled_shifts',
    'availability_rules', 'time_off_requests'].map(count);
  for (let i = 0; i < 5; i++) S.availabilityFor(EMP, utc(`${FRI} 16:00`), utc(`${FRI} 22:00`));
  S.availabilityForMany([EMP, OTHER], utc(`${SAT} 16:00`), utc(`${SAT} 22:00`));
  const after = ['time_entries', 'work', 'time_breaks', 'scheduled_shifts',
    'availability_rules', 'time_off_requests'].map(count);
  assert.deepStrictEqual(after, before, 'a question is not a write');
});
