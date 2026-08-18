'use strict';

// Phase 4 — the Issues engine, at the domain level.
//
// Four conditions, derived on read. Two severities. Nothing blocks anything.
//
// The rule that gives the list its shape: PREVENT what is new, FLAG what became
// invalid later. Every issue here is a state that was legal when it was made
// and stopped being legal afterwards — which is why none of them can be caught
// at the write, and why an engine has to exist at all.

const test = require('node:test');
const assert = require('node:assert');

const { db, positions } = require('../src/db');
const S = require('../src/scheduler');
const { addDays, isoDate, startOfToday } = require('../src/dates');

const TODAY = isoDate(startOfToday());
const at = (d, hhmm) => `${d} ${hhmm}`;

let ANNA; let BEN;
// Far enough out that nothing else in the suite is scheduling here.
const DAY = addDays(TODAY, 63);
const WEEK = () => S.weekWindowFor(DAY);

const issues = () => S.issuesFor(DAY).issues;
const kinds = () => issues().map((i) => i.kind);
const only = (kind) => issues().filter((i) => i.kind === kind);

test.before(() => {
  const ins = db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
                          VALUES (?, ?, ?, ?, ?)`);
  ANNA = Number(ins.run('Issue Anna', 'server', 1500, 1, '8801').lastInsertRowid);
  BEN = Number(ins.run('Issue Ben', 'kitchen', 1600, 1, '8802').lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
    .run(ANNA, 'busser', 1100);
});

/** Every shift this file made, gone, so each test starts from a clean week. */
const wipe = () => {
  const w = WEEK();
  for (const r of S.q.inRangeAll.all(w.start, w.end)) {
    db.prepare('DELETE FROM published_schedule WHERE scheduled_shift_id = ?').run(r.id);
    db.prepare('DELETE FROM scheduled_breaks WHERE scheduled_shift_id = ?').run(r.id);
    db.prepare('DELETE FROM scheduled_shifts WHERE id = ?').run(r.id);
  }
};
test.beforeEach(wipe);
test.after(wipe);

// ---------------------------------------------------------------------------
// A clean week
// ---------------------------------------------------------------------------

test('a sound week has no issues', () => {
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '10:00'), endsAt: at(DAY, '14:00') });
  S.create({ employeeId: BEN, position: 'kitchen', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  assert.deepStrictEqual(issues(), [], 'nothing to report');
});

test('back-to-back shifts are not an overlap', () => {
  // The boundary case. overlapsFor uses a half-open interval, so a shift ending
  // at 14:00 and one starting at 14:00 do not clash — which is the whole point,
  // because that is an ordinary double.
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '10:00'), endsAt: at(DAY, '14:00') });
  S.create({ employeeId: ANNA, position: 'busser', startsAt: at(DAY, '14:00'), endsAt: at(DAY, '18:00') });
  assert.deepStrictEqual(issues(), [], 'adjacent is not overlapping');
});

// ---------------------------------------------------------------------------
// Overlap — severity review
// ---------------------------------------------------------------------------

test('one overlap is ONE issue, not two', () => {
  // The symmetry trap. overlapsFor asks from a single side, so the pair reports
  // itself twice — once from each shift. If the key were per-shift the toolbar
  // would say 2 for one clash, and every count after it would be wrong.
  const a = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  const b = S.create({ employeeId: ANNA, position: 'busser', startsAt: at(DAY, '17:00'), endsAt: at(DAY, '23:00') });

  const found = only('overlap');
  assert.strictEqual(found.length, 1, 'one clash, one issue');
  assert.deepStrictEqual(found[0].shiftIds.sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y),
    'and it names both shifts');
  assert.strictEqual(found[0].severity, 'review', 'overlap is review, not action');
});

test('the overlap key is stable whichever shift is asked first', () => {
  const a = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  const b = S.create({ employeeId: ANNA, position: 'busser', startsAt: at(DAY, '17:00'), endsAt: at(DAY, '23:00') });
  const [lo, hi] = [a.id, b.id].sort((x, y) => x - y);
  assert.strictEqual(only('overlap')[0].key, `overlap:${lo}:${hi}`,
    'sorted ids, so the key survives a reload and can be deep-linked');
});

test('three shifts stacked on one person are three distinct clashes', () => {
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '23:00') });
  S.create({ employeeId: ANNA, position: 'busser', startsAt: at(DAY, '17:00'), endsAt: at(DAY, '22:00') });
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '18:00'), endsAt: at(DAY, '21:00') });
  assert.strictEqual(only('overlap').length, 3, 'A-B, A-C and B-C');
});

test('two people at the same time is not an overlap', () => {
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  S.create({ employeeId: BEN, position: 'kitchen', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  assert.deepStrictEqual(only('overlap'), [], 'overlap is about one person, not the floor');
});

test('a cancelled shift stops overlapping', () => {
  const a = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  S.create({ employeeId: ANNA, position: 'busser', startsAt: at(DAY, '17:00'), endsAt: at(DAY, '23:00') });
  assert.strictEqual(only('overlap').length, 1);
  S.cancel(a.id);
  assert.strictEqual(only('overlap').length, 0, 'calling one off resolves the clash');
});

test('an overlap created by DUPLICATE is caught, though the route never warned', () => {
  // Phase 2 deliberately suppressed the immediate warning here because warning
  // mid-bulk-action is noise. This is the other half of that decision: the
  // conflict still has to become visible, just later and in one place.
  const a = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  assert.deepStrictEqual(issues(), [], 'nothing wrong yet');
  S.duplicate(a.id);
  assert.strictEqual(only('overlap').length, 1, 'the duplicate lands on top of the original');
});

test('an overlap created by COPY WEEK is caught, with no route-specific code', () => {
  const w = WEEK();
  const src = S.weekWindowFor(addDays(w.start, -7));
  const made = S.create({ employeeId: ANNA, position: 'server',
    startsAt: at(src.start, '16:00'), endsAt: at(src.start, '22:00') });
  try {
    // Something already in the destination week that the copy will land on.
    S.create({ employeeId: ANNA, position: 'busser', startsAt: at(w.start, '17:00'), endsAt: at(w.start, '23:00') });
    S.copyWeek(src.start, w.start);
    assert.ok(only('overlap').length >= 1, 'the copied shift clashes and says so');
  } finally {
    db.prepare('DELETE FROM scheduled_shifts WHERE id = ?').run(made.id);
  }
});

// ---------------------------------------------------------------------------
// Stale qualification — severity action
// ---------------------------------------------------------------------------

test('losing a held position flags the shifts already scheduled into it', () => {
  const s = S.create({ employeeId: ANNA, position: 'busser', startsAt: at(DAY, '10:00'), endsAt: at(DAY, '14:00') });
  assert.deepStrictEqual(issues(), [], 'legal when it was made');

  // The role goes away. Nothing looks at the schedule — which is the point.
  db.prepare('DELETE FROM employee_roles WHERE employee_id = ? AND role = ?').run(ANNA, 'busser');
  try {
    const found = only('qualification');
    assert.strictEqual(found.length, 1, 'the shift is now unqualified');
    assert.deepStrictEqual(found[0].shiftIds, [s.id]);
    assert.strictEqual(found[0].severity, 'action', 'stronger than an overlap');
    assert.strictEqual(found[0].position, 'busser');
  } finally {
    db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
      .run(ANNA, 'busser', 1100);
  }
  assert.deepStrictEqual(only('qualification'), [], 'and giving the role back resolves it');
});

test('rewriting the primary role flags shifts in the old one', () => {
  const s = S.create({ employeeId: BEN, position: 'kitchen', startsAt: at(DAY, '10:00'), endsAt: at(DAY, '14:00') });
  db.prepare('UPDATE employees SET role = ? WHERE id = ?').run('server', BEN);
  try {
    const found = only('qualification');
    assert.strictEqual(found.length, 1, 'the employee edit form can do this, and does not look');
    assert.deepStrictEqual(found[0].shiftIds, [s.id]);
  } finally {
    db.prepare('UPDATE employees SET role = ? WHERE id = ?').run('kitchen', BEN);
  }
});

// ---------------------------------------------------------------------------
// Retired position — severity action
// ---------------------------------------------------------------------------

test('a position retired underneath an existing shift is flagged', () => {
  const SLUG = 'issue-retired';
  db.prepare("INSERT OR IGNORE INTO positions (slug, name, kind, sort, active) VALUES (?, 'Issue Retired', 'support', 901, 1)").run(SLUG);
  const pos = positions.bySlug.get(SLUG);
  db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)').run(ANNA, SLUG, 1200);
  const s = S.create({ employeeId: ANNA, position: SLUG, startsAt: at(DAY, '10:00'), endsAt: at(DAY, '14:00') });
  assert.deepStrictEqual(issues(), [], 'fine while the position runs');

  positions.setActive.run(0, pos.id);
  try {
    const found = only('position-retired');
    assert.strictEqual(found.length, 1, 'the existing shift is flagged');
    assert.deepStrictEqual(found[0].shiftIds, [s.id]);
    assert.strictEqual(found[0].severity, 'action');
    // The write-time guard is what keeps this list finite — no NEW shift can
    // join it. That rule is proven in scheduler.test.js; this only checks the
    // engine sees the ones that were already there.
    assert.throws(() => S.create({ employeeId: ANNA, position: SLUG,
      startsAt: at(DAY, '16:00'), endsAt: at(DAY, '20:00') }),
    (e) => e.code === 'position-inactive');
  } finally {
    positions.setActive.run(1, pos.id);
  }
  assert.deepStrictEqual(only('position-retired'), [], 'bringing the position back resolves it');
});

// ---------------------------------------------------------------------------
// Cancelled but still published — severity action
// ---------------------------------------------------------------------------

test('a cancelled shift the floor can still see is flagged until published', () => {
  const s = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  S.publish(s.id);
  assert.deepStrictEqual(issues(), [], 'published and matching');

  S.cancel(s.id);
  const found = only('cancelled-live');
  assert.strictEqual(found.length, 1, 'the manager called it off; Anna is still looking at it');
  assert.deepStrictEqual(found[0].shiftIds, [s.id]);
  assert.strictEqual(found[0].severity, 'action');

  // No resolve workflow: publishing the cancellation is the fix.
  S.publishWeek(DAY);
  assert.deepStrictEqual(only('cancelled-live'), [], 'publishing the cancellation resolves it');
});

test('a cancelled shift that was never published is not an issue', () => {
  const s = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  S.cancel(s.id);
  assert.deepStrictEqual(issues(), [], 'nobody ever saw it, so there is nothing to reconcile');
});

// ---------------------------------------------------------------------------
// Scope — what Phase 4 deliberately does NOT report
// ---------------------------------------------------------------------------

test('publication state alone is never an issue', () => {
  // Locked decision D4: the toolbar chip already says this. Saying it twice in
  // one toolbar is how "issue" comes to mean "anything noteworthy".
  const s = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  assert.deepStrictEqual(issues(), [], 'an unpublished draft is not an issue');
  S.publish(s.id);
  S.edit(s.id, { endsAt: at(DAY, '23:00') });
  assert.strictEqual(S.byId(s.id).changed_after_publish, 1, 'it really is materially changed');
  assert.deepStrictEqual(issues(), [], 'and unpublished CHANGES are still not an issue');
});

test('an open shift is not an issue', () => {
  S.create({ employeeId: null, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  assert.deepStrictEqual(issues(), [], 'an open shift may be entirely deliberate');
});

test('high scheduled hours are not an issue', () => {
  // Deliberately excluded: a threshold here is one step from projected
  // overtime, which the roadmap removed on purpose.
  for (let i = 0; i < 6; i++) {
    const d = addDays(WEEK().start, i);
    S.create({ employeeId: BEN, position: 'kitchen', startsAt: at(d, '08:00'), endsAt: at(d, '22:00') });
  }
  assert.deepStrictEqual(issues(), [], '84 scheduled hours and not a word about it');
});

test('an inactive employee holding shifts is not an issue this phase', () => {
  const s = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(ANNA);
  try {
    assert.deepStrictEqual(only('inactive'), [], 'no such issue kind exists yet');
    assert.ok(S.q.inRangeAll.all(WEEK().start, WEEK().end).some((r) => r.id === s.id),
      'the shift is still there for the manager to deal with');
  } finally {
    db.prepare('UPDATE employees SET active = 1 WHERE id = ?').run(ANNA);
  }
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('issues are ordered action first, then by day', () => {
  const d2 = addDays(WEEK().start, 2);
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(d2, '16:00'), endsAt: at(d2, '22:00') });
  S.create({ employeeId: ANNA, position: 'busser', startsAt: at(d2, '17:00'), endsAt: at(d2, '23:00') });
  const s = S.create({ employeeId: ANNA, position: 'busser', startsAt: at(DAY, '10:00'), endsAt: at(DAY, '14:00') });
  db.prepare('DELETE FROM employee_roles WHERE employee_id = ? AND role = ?').run(ANNA, 'busser');
  try {
    const list = issues();
    assert.strictEqual(list[0].severity, 'action', 'what is wrong comes before what is worth a look');
    assert.ok(list.some((i) => i.kind === 'overlap'), 'and the overlap is still there');
    assert.ok(list.every((i) => i.key && i.kind && i.severity && Array.isArray(i.shiftIds)),
      'every issue carries a key, a kind, a severity and its shifts');
    assert.ok(s.id > 0);
  } finally {
    db.prepare('INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
      .run(ANNA, 'busser', 1100);
  }
});

test('issuesFor only ever reads — it writes nothing', () => {
  const count = () => ({
    shifts: db.prepare('SELECT COUNT(*) n FROM scheduled_shifts').get().n,
    pub: db.prepare('SELECT COUNT(*) n FROM published_schedule').get().n,
    work: db.prepare('SELECT COUNT(*) n FROM work').get().n,
    entries: db.prepare('SELECT COUNT(*) n FROM time_entries').get().n,
  });
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  S.create({ employeeId: ANNA, position: 'busser', startsAt: at(DAY, '17:00'), endsAt: at(DAY, '23:00') });
  const before = count();
  issues(); issues(); issues();
  assert.deepStrictEqual(count(), before, 'derived means derived');
});

// ===========================================================================
// Phase 6 — two new kinds, and the pending request that is deliberately not one.
// ===========================================================================

const P6 = require('../src/periods');
const TC6 = require('../src/timeclock');

const avRule = (empId, o) => db.prepare(`INSERT INTO availability_rules
  (employee_id, avail_kind, weekday, on_date, all_day, start_min, end_min)
  VALUES (@employee_id,@avail_kind,@weekday,@on_date,@all_day,@start_min,@end_min)`)
  .run({ employee_id: empId, avail_kind: 'unavailable', weekday: null, on_date: null,
    all_day: 1, start_min: null, end_min: null, ...o }).lastInsertRowid;
const avOff = (empId, from, to, status = 'approved') => db.prepare(
  `INSERT INTO time_off_requests (employee_id, starts_at, ends_at, all_day, status)
   VALUES (?,?,?,1,?)`).run(empId, TC6.localInputToUtc(from + ' 00:00'),
  TC6.localInputToUtc(to + ' 00:00'), status).lastInsertRowid;
const cleanP6 = () => {
  db.prepare('DELETE FROM availability_rules').run();
  db.prepare('DELETE FROM time_off_requests').run();
  P6.setSetting('sch_availability', '1');
};

test('a shift during approved time off is an ACTION issue', () => {
  cleanP6();
  const s = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  const id = avOff(ANNA, DAY, addDays(DAY, 1));
  const found = only('timeoff');
  assert.strictEqual(found.length, 1, 'exactly one');
  assert.strictEqual(found[0].severity, 'action', 'a manager approved it and then scheduled over it');
  assert.strictEqual(found[0].key, `timeoff:${s.id}:${id}`, 'the key is deterministic');
  assert.deepStrictEqual(found[0].shiftIds, [s.id]);
  cleanP6();
});

test('a shift during stated unavailability is a REVIEW issue', () => {
  cleanP6();
  const s = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  const rid = avRule(ANNA, { on_date: DAY });
  const found = only('unavailable');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'review', 'the manager may override a stated constraint');
  assert.strictEqual(found[0].key, `unavailable:${s.id}:${rid}`);
  cleanP6();
});

test('a PENDING request raises no issue at all', () => {
  cleanP6();
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  avOff(ANNA, DAY, addDays(DAY, 1), 'pending');
  assert.strictEqual(only('timeoff').length + only('unavailable').length, 0,
    'asking for a day off must not let an employee put a count on the manager\'s board');
  cleanP6();
});

test('approved time off outranks a stated rule — one issue, not two', () => {
  cleanP6();
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  avRule(ANNA, { on_date: DAY });
  avOff(ANNA, DAY, addDays(DAY, 1));
  assert.strictEqual(only('unavailable').length, 0, 'the stated rule stands down');
  assert.strictEqual(only('timeoff').length, 1, 'and the approved absence is the one that speaks');
  cleanP6();
});

test('the switch silences stated rules but never an approved absence', () => {
  cleanP6();
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  avRule(ANNA, { on_date: DAY });
  try {
    P6.setSetting('sch_availability', '0');
    assert.strictEqual(only('unavailable').length, 0,
      'a stated rule is not consulted while collecting is off');
    avOff(ANNA, DAY, addDays(DAY, 1));
    assert.strictEqual(only('timeoff').length, 1,
      'but an absence the manager approved still warns them');
  } finally { P6.setSetting('sch_availability', '1'); cleanP6(); }
});

test('the issue is derived — fixing the request clears it, with no dismissal', () => {
  cleanP6();
  S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  const id = avOff(ANNA, DAY, addDays(DAY, 1));
  assert.strictEqual(only('timeoff').length, 1);
  db.prepare("UPDATE time_off_requests SET status='rejected' WHERE id = ?").run(id);
  assert.strictEqual(only('timeoff').length, 0,
    'no dismissal anywhere — fix the request and the issue is simply gone');
  cleanP6();
});

test('availability never blocks: the shift still saves, and Publish is untouched', () => {
  cleanP6();
  avRule(ANNA, { on_date: DAY });
  const s = S.create({ employeeId: ANNA, position: 'server', startsAt: at(DAY, '16:00'), endsAt: at(DAY, '22:00') });
  assert.ok(s && s.id, 'creating over a stated constraint is allowed');
  assert.strictEqual(only('unavailable').length, 1, 'and reported rather than refused');
  assert.doesNotThrow(() => S.publishWeek(DAY), 'a week with an availability issue still publishes');
  cleanP6();
});
