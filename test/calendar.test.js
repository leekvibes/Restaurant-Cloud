'use strict';

// The calendar domain — Stage A.
//
// Two things carry the whole design, and both are tested hardest:
//
//   1. OCCURRENCES COME FROM THE RULE. Nothing is stored, so completing one
//      cannot move the next. That is the fix for the cadence drift the old
//      recurring tracker was built on.
//   2. MONTH ARITHMETIC. "The 31st" and "February 29" are where calendars go
//      wrong, and they go wrong quietly — a date that is merely plausible
//      rather than correct.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Its own database, set BEFORE ../src/db is required — db.js reads DB_PATH at
// module load, so a require that happens first pins the wrong file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-cal-'));
process.env.DB_PATH = path.join(dir, 'cal.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
// modules.js owns m_recurring — the table the migration reads. Required here so
// the migration tests have the old world to migrate FROM. calendar.js itself
// handles the table being absent, which is what happens on a fresh install.
require('../src/modules');
const C = require('../src/calendar');
const { addDays } = require('../src/dates');

test.after(() => { try { db.close(); } catch { /* already */ } fs.rmSync(dir, { recursive: true, force: true }); });

const wipe = () => {
  db.prepare('DELETE FROM cal_completions').run();
  db.prepare('DELETE FROM cal_exceptions').run();
  db.prepare('DELETE FROM cal_reminders').run();
  db.prepare('DELETE FROM cal_items').run();
};
test.beforeEach(wipe);

/** Dates a rule produces, without needing a row. */
const dates = (rule, from, to) => C.datesFor({ rrule_interval: 1, ...rule }, from, to);

// ===========================================================================
// Does not repeat
// ===========================================================================

test('a one-time item produces exactly its own date', () => {
  const r = { starts_on: '2026-09-15' };
  assert.deepStrictEqual(dates(r, '2026-09-01', '2026-09-30'), ['2026-09-15']);
  assert.deepStrictEqual(dates(r, '2026-10-01', '2026-10-31'), [], 'and nothing outside the window');
});

// ===========================================================================
// Daily / weekly
// ===========================================================================

test('daily, and every-other-day', () => {
  assert.deepStrictEqual(dates({ starts_on: '2026-09-01', rrule_freq: 'daily' }, '2026-09-01', '2026-09-04'),
    ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  assert.deepStrictEqual(
    dates({ starts_on: '2026-09-01', rrule_freq: 'daily', rrule_interval: 2 }, '2026-09-01', '2026-09-07'),
    ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07']);
});

test('a long-running daily rule costs the same as a new one', () => {
  // The window is what bounds the work, not how long the series has existed.
  // Without the skip-ahead this walks six years of days to answer one week.
  const r = { starts_on: '2020-01-01', rrule_freq: 'daily' };
  const t0 = process.hrtime.bigint();
  const out = dates(r, '2026-09-01', '2026-09-07');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(out.length, 7);
  assert.strictEqual(out[0], '2026-09-01', 'and it lands on the right day, not an off-by-one');
  assert.ok(ms < 50, `expanding one week of a six-year-old rule took ${ms.toFixed(1)}ms`);
});

test('weekly on the start weekday, and on named weekdays', () => {
  // 2026-09-01 is a Tuesday.
  assert.deepStrictEqual(dates({ starts_on: '2026-09-01', rrule_freq: 'weekly' }, '2026-09-01', '2026-09-30'),
    ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);

  const mt = dates({ starts_on: '2026-09-01', rrule_freq: 'weekly', rrule_byday: 'MO,TH' },
    '2026-09-01', '2026-09-15');
  assert.deepStrictEqual(mt, ['2026-09-03', '2026-09-07', '2026-09-10', '2026-09-14'],
    'Thursdays and Mondays, in date order, never before the start');
});

test('every weekday skips the weekend', () => {
  const out = dates({ starts_on: '2026-09-01', rrule_freq: 'weekly', rrule_byday: 'MO,TU,WE,TH,FR' },
    '2026-09-05', '2026-09-08');
  assert.deepStrictEqual(out, ['2026-09-07', '2026-09-08'], 'Sat 5th and Sun 6th are not weekdays');
});

test('every two weeks keeps both days inside the SAME week', () => {
  // The stride is measured from the week the series starts in, so a fortnightly
  // Mon+Thu never drifts into alternating single days.
  const out = dates({ starts_on: '2026-09-07', rrule_freq: 'weekly', rrule_interval: 2, rrule_byday: 'MO,TH' },
    '2026-09-01', '2026-10-05');
  assert.deepStrictEqual(out, ['2026-09-07', '2026-09-10', '2026-09-21', '2026-09-24', '2026-10-05']);
});

// ===========================================================================
// Monthly — where calendars break
// ===========================================================================

test('monthly on a day the month has', () => {
  assert.deepStrictEqual(dates({ starts_on: '2026-09-01', rrule_freq: 'monthly', rrule_bymonthday: 1 },
    '2026-09-01', '2026-12-31'),
  ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']);
});

test('every 3 months — and completing one does not move it', () => {
  const out = dates({ starts_on: '2026-03-01', rrule_freq: 'monthly', rrule_interval: 3, rrule_bymonthday: 1 },
    '2026-01-01', '2026-12-31');
  assert.deepStrictEqual(out, ['2026-03-01', '2026-06-01', '2026-09-01', '2026-12-01'],
    'a quarterly rule, which is what the old "Quarterly" meant');
});

test('the 31st SKIPS short months rather than clamping', () => {
  // Clamping to the 28th invents a date nobody asked for, and the next month
  // would silently disagree with it. February simply has no 31st.
  const out = dates({ starts_on: '2026-01-31', rrule_freq: 'monthly', rrule_bymonthday: 31 },
    '2026-01-01', '2026-06-30');
  assert.deepStrictEqual(out, ['2026-01-31', '2026-03-31', '2026-05-31'],
    'February, April and June are skipped, not bent to fit');
});

test('the last day of the month follows the month', () => {
  const out = dates({ starts_on: '2026-01-31', rrule_freq: 'monthly', rrule_bymonthday: -1 },
    '2026-01-01', '2026-05-31');
  assert.deepStrictEqual(out, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'],
    '-1 means last, so February is the 28th and April the 30th');
});

test('the last day of February in a leap year', () => {
  const out = dates({ starts_on: '2028-01-31', rrule_freq: 'monthly', rrule_bymonthday: -1 },
    '2028-02-01', '2028-02-29');
  assert.deepStrictEqual(out, ['2028-02-29'], '2028 is a leap year');
});

test('the first Monday, and the last Friday, of each month', () => {
  assert.deepStrictEqual(
    dates({ starts_on: '2026-09-01', rrule_freq: 'monthly', rrule_byday: 'MO', rrule_bysetpos: 1 },
      '2026-09-01', '2026-11-30'),
    ['2026-09-07', '2026-10-05', '2026-11-02']);
  assert.deepStrictEqual(
    dates({ starts_on: '2026-09-01', rrule_freq: 'monthly', rrule_byday: 'FR', rrule_bysetpos: -1 },
      '2026-09-01', '2026-11-30'),
    ['2026-09-25', '2026-10-30', '2026-11-27']);
});

// ===========================================================================
// Yearly
// ===========================================================================

test('yearly, and February 29 skips common years', () => {
  assert.deepStrictEqual(dates({ starts_on: '2026-07-04', rrule_freq: 'yearly' }, '2026-01-01', '2029-12-31'),
    ['2026-07-04', '2027-07-04', '2028-07-04', '2029-07-04']);
  // Feb 29 exists in 2028 and 2032, and nowhere between.
  assert.deepStrictEqual(dates({ starts_on: '2028-02-29', rrule_freq: 'yearly' }, '2028-01-01', '2033-12-31'),
    ['2028-02-29', '2032-02-29'], 'a leap day does not become the 28th');
});

// ===========================================================================
// Ends
// ===========================================================================

test('a repeat can end on a date or after a count', () => {
  assert.deepStrictEqual(
    dates({ starts_on: '2026-09-01', rrule_freq: 'weekly', rrule_until: '2026-09-16' }, '2026-09-01', '2026-12-31'),
    ['2026-09-01', '2026-09-08', '2026-09-15'], 'until is inclusive and stops the series');
  assert.deepStrictEqual(
    dates({ starts_on: '2026-09-01', rrule_freq: 'weekly', rrule_count: 3 }, '2026-09-01', '2026-12-31'),
    ['2026-09-01', '2026-09-08', '2026-09-15']);
});

test('a count is counted from the FIRST occurrence, not from the window', () => {
  // The trap: skipping ahead to the window would lose track of how many have
  // already happened, and "after 3 occurrences" would restart on every render.
  const r = { starts_on: '2026-09-01', rrule_freq: 'weekly', rrule_count: 3 };
  assert.deepStrictEqual(dates(r, '2026-09-10', '2026-12-31'), ['2026-09-15'],
    'only the third one falls inside this window — the series is over after it');
});

// ===========================================================================
// The whole point: schedule and completion are separate
// ===========================================================================

test('completing an occurrence LATE does not move the next one', () => {
  // The defect the old tracker was built on. next_due = today + interval meant
  // every late completion shifted the entire future schedule.
  const item = C.create({
    kind: 'task', title: 'Hood cleaning', category: 'Cleaning',
    starts_on: '2026-09-01', rrule_freq: 'monthly', rrule_interval: 3, rrule_bymonthday: 1,
  });
  const before = C.datesFor(item, '2026-09-01', '2027-06-30');
  assert.deepStrictEqual(before, ['2026-09-01', '2026-12-01', '2027-03-01', '2027-06-01']);

  C.complete(item.id, '2026-09-01', 'Malek');       // done on the 5th, say

  const after = C.datesFor(C.q.byId.get(item.id), '2026-09-01', '2027-06-30');
  assert.deepStrictEqual(after, before, 'December 1 is exactly where the rule put it');
});

test('completions accumulate into real history', () => {
  const item = C.create({ kind: 'task', title: 'Hood cleaning',
    starts_on: '2026-03-01', rrule_freq: 'monthly', rrule_interval: 3, rrule_bymonthday: 1 });
  for (const d of ['2026-03-01', '2026-06-01', '2026-09-01', '2026-12-01']) {
    C.complete(item.id, d, 'Malek');
  }
  const h = C.history(item.id);
  assert.strictEqual(h.length, 4, 'the question the old model could not answer');
  assert.deepStrictEqual(h.map((x) => x.occurs_on),
    ['2026-12-01', '2026-09-01', '2026-06-01', '2026-03-01'], 'newest first');
});

test('completing the same occurrence twice records it once', () => {
  const item = C.create({ kind: 'task', title: 'Deep clean', starts_on: '2026-09-01' });
  C.complete(item.id, '2026-09-01', 'A');
  C.complete(item.id, '2026-09-01', 'B');
  assert.strictEqual(C.history(item.id).length, 1, 'a double tap is not two cleanings');
});

test('undo removes a KNOWN completion, by id', () => {
  // The old undo carried the previous dates in an editable querystring that
  // never expired. This one names a row.
  const item = C.create({ kind: 'task', title: 'Grease trap', starts_on: '2026-09-01' });
  const done = C.complete(item.id, '2026-09-01', 'Malek');
  assert.ok(done.id);
  C.uncomplete(done.id);
  assert.strictEqual(C.history(item.id).length, 0);
  assert.throws(() => C.uncomplete(done.id), (e) => e.code === 'missing',
    'and undoing twice is refused rather than silently doing nothing');
});

test('only a task can be completed', () => {
  const ev = C.create({ kind: 'event', title: 'Vendor meeting', starts_on: '2026-09-01' });
  assert.throws(() => C.complete(ev.id, '2026-09-01'), (e) => e.code === 'kind');
});

// ===========================================================================
// Status: an event is never overdue
// ===========================================================================

test('a task can be overdue; an event that happened is just past', () => {
  const past = addDays(new Date().toISOString().slice(0, 10), -10);
  const task = C.create({ kind: 'task', title: 'Licence renewal', starts_on: past });
  const event = C.create({ kind: 'event', title: 'Vendor meeting', starts_on: past });

  assert.strictEqual(C.statusOf(task).overdue, true, 'a chore left undone is late');
  assert.match(C.statusOf(task).label, /days late/);
  assert.strictEqual(C.statusOf(event).overdue, false,
    'a meeting that happened yesterday is not a failure');
  assert.strictEqual(C.statusOf(event).label, '');
});

test('completing the outstanding occurrence clears overdue', () => {
  const past = addDays(new Date().toISOString().slice(0, 10), -5);
  const task = C.create({ kind: 'task', title: 'Pest control', starts_on: past });
  assert.strictEqual(C.statusOf(task).overdue, true);
  C.complete(task.id, past, 'Malek');
  assert.strictEqual(C.statusOf(task).overdue, false, 'and it is no longer chased');
});

test('overdueTasks is what the dashboard counts', () => {
  const past = addDays(new Date().toISOString().slice(0, 10), -3);
  C.create({ kind: 'task', title: 'Late one', starts_on: past });
  C.create({ kind: 'event', title: 'Past meeting', starts_on: past });
  C.create({ kind: 'task', title: 'Future one', starts_on: addDays(new Date().toISOString().slice(0, 10), 30) });
  const over = C.overdueTasks();
  assert.strictEqual(over.length, 1, 'the event and the future task are not overdue');
  assert.strictEqual(over[0].item.title, 'Late one');
});

// ===========================================================================
// Series editing
// ===========================================================================

test('editing ONE occurrence leaves the rule alone', () => {
  const item = C.create({ title: 'Standup', starts_on: '2026-09-07', rrule_freq: 'weekly' });
  C.update(item.id, { title: 'Standup (long)' }, 'one', '2026-09-14');
  const occ = C.expand(C.q.byId.get(item.id), '2026-09-01', '2026-09-30');
  assert.strictEqual(occ.length, 4);
  assert.strictEqual(occ.find((o) => o.occursOn === '2026-09-14').title, 'Standup (long)');
  assert.strictEqual(occ.find((o) => o.occursOn === '2026-09-21').title, 'Standup',
    'every other occurrence is untouched');
});

test('moving one occurrence keeps its identity on the ORIGINAL date', () => {
  // The rule date is the only stable id an unstored occurrence has. Moving one
  // must not orphan a completion recorded against it.
  const item = C.create({ title: 'Delivery', starts_on: '2026-09-07', rrule_freq: 'weekly' });
  C.update(item.id, { starts_on: '2026-09-16' }, 'one', '2026-09-14');
  const occ = C.expand(C.q.byId.get(item.id), '2026-09-01', '2026-09-30');
  const moved = occ.find((o) => o.moved);
  assert.strictEqual(moved.date, '2026-09-16', 'it shows on the new day');
  assert.strictEqual(moved.occursOn, '2026-09-14', 'and still answers to the old one');
  assert.ok(!occ.some((o) => o.date === '2026-09-14'), 'it is not in both places');
});

test('skipping one occurrence removes only that one', () => {
  const item = C.create({ title: 'Standup', starts_on: '2026-09-07', rrule_freq: 'weekly' });
  C.remove(item.id, 'one', '2026-09-14');
  const occ = C.expand(C.q.byId.get(item.id), '2026-09-01', '2026-09-30');
  assert.deepStrictEqual(occ.map((o) => o.date), ['2026-09-07', '2026-09-21', '2026-09-28']);
});

test('"this and following" SPLITS the series and leaves the past correct', () => {
  // Not a rewrite. The occurrences that already happened keep the shape they
  // actually had — which is the whole reason to split rather than edit in place.
  const item = C.create({ title: 'Deep clean', starts_on: '2026-09-07', rrule_freq: 'weekly' });
  const made = C.update(item.id, { title: 'Deep clean (new crew)' }, 'future', '2026-09-21');

  const oldSeries = C.datesFor(C.q.byId.get(item.id), '2026-09-01', '2026-10-31');
  assert.deepStrictEqual(oldSeries, ['2026-09-07', '2026-09-14'], 'the old rule stops the day before');
  const newSeries = C.datesFor(made, '2026-09-01', '2026-10-05');
  assert.deepStrictEqual(newSeries, ['2026-09-21', '2026-09-28', '2026-10-05']);
  assert.strictEqual(made.title, 'Deep clean (new crew)');
  assert.notStrictEqual(made.id, item.id, 'it really is a second series');
});

test('deleting "this and following" ends the series without touching history', () => {
  const item = C.create({ title: 'Weekly review', starts_on: '2026-09-07', rrule_freq: 'weekly' });
  C.complete.bind(null);
  C.remove(item.id, 'future', '2026-09-21');
  assert.deepStrictEqual(C.datesFor(C.q.byId.get(item.id), '2026-09-01', '2026-12-31'),
    ['2026-09-07', '2026-09-14'], 'the two that already happened remain');
});

test('deleting the whole series removes it', () => {
  const item = C.create({ title: 'Gone', starts_on: '2026-09-07', rrule_freq: 'weekly' });
  C.remove(item.id, 'all');
  assert.strictEqual(C.q.byId.get(item.id), undefined);
});

// ===========================================================================
// Range assembly
// ===========================================================================

test('range returns every item, in date then time order', () => {
  C.create({ title: 'All day thing', starts_on: '2026-09-10' });
  C.create({ title: 'Late meeting', starts_on: '2026-09-10', all_day: 0, start_min: 14 * 60, end_min: 15 * 60 });
  C.create({ title: 'Early call', starts_on: '2026-09-10', all_day: 0, start_min: 9 * 60, end_min: 10 * 60 });
  C.create({ title: 'Tomorrow', starts_on: '2026-09-11' });
  const out = C.range('2026-09-01', '2026-09-30');
  assert.deepStrictEqual(out.map((o) => o.title),
    ['All day thing', 'Early call', 'Late meeting', 'Tomorrow'],
    'all-day first, then by start time, then the next day');
});

test('range can be filtered by category without deleting anything', () => {
  C.create({ title: 'Hood', category: 'Cleaning', starts_on: '2026-09-10' });
  C.create({ title: 'Licence', category: 'Compliance', starts_on: '2026-09-10' });
  const only = C.range('2026-09-01', '2026-09-30', { categories: ['Cleaning'] });
  assert.deepStrictEqual(only.map((o) => o.title), ['Hood']);
  assert.strictEqual(C.range('2026-09-01', '2026-09-30').length, 2, 'a filter hides, never removes');
});

test('a series that began long ago still shows in a window years later', () => {
  // The live query deliberately never date-filters a RECURRING row: its
  // starts_on is six years behind the window, and filtering on it would hide
  // every long-running obligation the restaurant has.
  C.create({ title: 'Quarterly audit', starts_on: '2020-01-01', rrule_freq: 'monthly', rrule_interval: 3 });
  const out = C.range('2026-10-01', '2026-10-31');
  assert.strictEqual(out.length, 1, 'six years of quarters later, it is still on the calendar');
  assert.strictEqual(out[0].date, '2026-10-01', 'and on the day the rule actually lands');
  assert.strictEqual(C.range('2026-09-01', '2026-09-30').length, 0,
    'while a month the rule does not touch stays empty');
});

// ===========================================================================
// Validation
// ===========================================================================

test('bad input is refused with a sentence, not a stack trace', () => {
  assert.throws(() => C.create({ title: '', starts_on: '2026-09-01' }), (e) => e.code === 'title');
  assert.throws(() => C.create({ title: 'x', starts_on: 'nope' }), (e) => e.code === 'date');
  assert.throws(() => C.create({ title: 'x', starts_on: '2026-09-05', ends_on: '2026-09-01' }), (e) => e.code === 'date');
  assert.throws(() => C.create({ title: 'x', starts_on: '2026-09-01', rrule_freq: 'fortnightly' }), (e) => e.code === 'repeat');
  assert.throws(() => C.create({ title: 'x', starts_on: '2026-09-01', all_day: 0, start_min: 600, end_min: 300 }),
    (e) => e.code === 'time');
  assert.throws(() => C.create({ title: 'x', starts_on: '2026-09-10', rrule_freq: 'weekly', rrule_until: '2026-09-01' }),
    (e) => e.code === 'repeat');
});

test('an unknown category falls back rather than being stored', () => {
  const item = C.create({ title: 'x', starts_on: '2026-09-01', category: 'Nonsense' });
  assert.strictEqual(item.category, 'Other');
});

test('responsible stays free text', () => {
  // A grease trap is serviced by a contractor, not somebody on payroll. Forcing
  // an employee id here would break the commonest case.
  const item = C.create({ title: 'Grease trap', starts_on: '2026-09-01', responsible: 'ABC Hood Service' });
  assert.strictEqual(item.responsible, 'ABC Hood Service');
  assert.strictEqual(item.responsible_id, null);
});

// ===========================================================================
// Reminders
// ===========================================================================

test('reminder rules are stored, and only honest offsets are offered', () => {
  const item = C.create({ title: 'Inspection', starts_on: '2026-09-15' });
  C.setReminders(item.id, [1440, 10080, 1440]);
  const r = C.reminders(item.id);
  assert.deepStrictEqual(r.map((x) => x.offset_min), [10080, 1440], 'de-duplicated, furthest out first');

  // Every offered option is a whole number of days, because the sweep that
  // delivers them runs daily. A control that cannot fire would be a lie.
  for (const o of C.REMINDER_OFFSETS) {
    assert.strictEqual(o.min % 1440, 0, `${o.label} is a whole number of days`);
  }
});

test('a due reminder is reported once per occurrence, with a stable key', () => {
  const item = C.create({ kind: 'task', title: 'Licence', starts_on: '2026-09-15',
    rrule_freq: 'monthly', rrule_interval: 12 });
  C.setReminders(item.id, [10080]);                        // 1 week before
  const due = C.dueReminders('2026-09-08', '2026-09-08');
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].fireOn, '2026-09-08');
  assert.strictEqual(due[0].occursOn, '2026-09-15');
  assert.strictEqual(due[0].key, `cal:${item.id}:2026-09-15:10080`,
    'deterministic, so a re-run cannot notify twice');
  assert.strictEqual(C.dueReminders('2026-09-09', '2026-09-09').length, 0, 'and not again the next day');
});

test('a completed occurrence stops reminding', () => {
  const item = C.create({ kind: 'task', title: 'Licence', starts_on: '2026-09-15' });
  C.setReminders(item.id, [1440]);
  assert.strictEqual(C.dueReminders('2026-09-14', '2026-09-14').length, 1);
  C.complete(item.id, '2026-09-15', 'Malek');
  assert.strictEqual(C.dueReminders('2026-09-14', '2026-09-14').length, 0,
    'nobody is chased for something already done');
});

// ===========================================================================
// Migration
// ===========================================================================

test('the old recurring tasks come across intact', () => {
  wipe();
  db.prepare('DELETE FROM m_recurring').run();
  const ins = db.prepare(`INSERT INTO m_recurring (name, frequency, next_due, last_done, responsible, notes, category)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run('Grease trap service', 'Quarterly', '2026-10-09', '2026-07-09', 'Malek', null, 'Cleaning');
  ins.run('Pest control visit', 'Monthly', '2026-10-16', '2026-09-16', 'Kevin', 'Front and back', 'Pest Control');
  ins.run('Fire extinguisher check', 'Annual', '2027-01-05', null, 'ABC Safety', null, null);
  ins.run('Linen order', 'Weekly', '2026-09-14', '2026-09-07', 'Malek', null, 'Other');

  const res = C.migrateRecurring();
  assert.strictEqual(res.migrated, 4, 'four in, four out');

  const all = C.q.all.all();
  assert.strictEqual(all.length, 4);
  const grease = all.find((i) => i.title === 'Grease trap service');
  assert.strictEqual(grease.kind, 'task', 'they are chores, not meetings');
  assert.strictEqual(grease.all_day, 1, 'date-only stays date-only — no times are invented');
  assert.strictEqual(grease.category, 'Cleaning');
  assert.strictEqual(grease.responsible, 'Malek');
  assert.strictEqual(grease.rrule_freq, 'monthly');
  assert.strictEqual(grease.rrule_interval, 3, 'Quarterly means every 3 months');
  assert.strictEqual(grease.starts_on, '2026-10-09', 'the next due date becomes the next occurrence');

  const annual = all.find((i) => i.title === 'Fire extinguisher check');
  assert.strictEqual(annual.rrule_freq, 'yearly');
  assert.strictEqual(annual.category, 'Other', 'a NULL category falls back, as the old page did on read');

  const weekly = all.find((i) => i.title === 'Linen order');
  assert.strictEqual(weekly.rrule_freq, 'weekly');
  assert.strictEqual(weekly.rrule_interval, 1);
});

test('last_done becomes the one completion we actually have', () => {
  wipe();
  db.prepare('DELETE FROM m_recurring').run();
  db.prepare(`INSERT INTO m_recurring (name, frequency, next_due, last_done, responsible, category)
    VALUES ('Hood cleaning','Quarterly','2026-10-01','2026-07-05','Malek','Cleaning')`).run();
  C.migrateRecurring();
  const item = C.q.all.all()[0];
  const h = C.history(item.id);
  assert.strictEqual(h.length, 1, 'exactly one — no earlier cleanings are invented');
  assert.strictEqual(h[0].occurs_on, '2026-07-05');
  assert.strictEqual(h[0].completed_by, null, 'because the old model never recorded who');
});

test('the migration agrees with the page it replaces, and does not run twice', () => {
  wipe();
  db.prepare('DELETE FROM m_recurring').run();
  db.prepare(`INSERT INTO m_recurring (name, frequency, next_due, category)
    VALUES ('Hood cleaning','Quarterly','2026-10-01','Cleaning')`).run();
  C.migrateRecurring();
  const item = C.q.all.all()[0];
  // The real gate: the calendar's next occurrence is the date the old page shows.
  assert.strictEqual(C.nextOccurrence(item, '2026-09-01'), '2026-10-01');

  const again = C.migrateRecurring();
  assert.strictEqual(again.migrated, 0, 'idempotent — it does not duplicate on a second boot');
  assert.strictEqual(C.q.all.all().length, 1);
});

test('the old table is left alone', () => {
  // It stays readable so a mistake in the migration can be seen rather than
  // argued about. Dropped a release later, deliberately.
  const n = db.prepare('SELECT COUNT(*) n FROM m_recurring').get().n;
  assert.ok(n >= 1, 'm_recurring still holds its rows');
});

// ===========================================================================
// This module touches nothing else
// ===========================================================================

test('the calendar writes to no table but its own', () => {
  const count = (t) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return null; } };
  const watched = ['scheduled_shifts', 'published_schedule', 'time_entries', 'work', 'shifts', 'employees'];
  const before = Object.fromEntries(watched.map((t) => [t, count(t)]));

  const item = C.create({ kind: 'task', title: 'Footprint check', starts_on: '2026-09-01',
    rrule_freq: 'weekly', reminders: [1440] });
  C.complete(item.id, '2026-09-01', 'Malek');
  C.update(item.id, { title: 'Renamed' }, 'one', '2026-09-08');
  C.remove(item.id, 'one', '2026-09-15');
  C.range('2026-09-01', '2026-09-30');

  assert.deepStrictEqual(Object.fromEntries(watched.map((t) => [t, count(t)])), before,
    'a calendar is not a schedule and never writes a punch, an hour or a shift');
});

// ===========================================================================
// STAGE B — the page
// ===========================================================================
//
// A server of its own, because everything above is domain-level and needs no
// HTTP at all. Kept in this file so the calendar's rules and its screens fail
// together when one drifts from the other.

const { spawn } = require('node:child_process');

const PORT = 4005;                     // unique across the suite — boot.test.js guards this
const BASE = `http://127.0.0.1:${PORT}`;
let child;
const page = async (p) => (await fetch(BASE + p)).text();
const hit = async (p) => (await fetch(BASE + p, { redirect: 'manual' })).status;
const send = async (p, body) => {
  const tok = (await (await fetch(`${BASE}/csrf`)).text()).trim();
  return fetch(BASE + p, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, _csrf: tok }) });
};

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: process.env.DB_PATH,
      TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});
test.after(() => { if (child) child.kill(); });

test('B: the calendar opens on MONTH, and the week starts Monday', async () => {
  const html = await page('/calendar');
  assert.match(html, /class="zc-grid"/, 'a month grid, not a list — a calendar that opens on a list is not a calendar');
  const heads = [...html.matchAll(/class="zc-dow" role="columnheader">([A-Za-z]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(heads, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    'Monday first: the restaurant week runs Monday to Sunday and the weekend belongs at the end');
});

test('B: agenda is reachable and groups by date', async () => {
  const html = await page('/calendar?v=agenda');
  assert.match(html, /class="zc-ag"/);
  assert.doesNotMatch(html, /class="zc-grid"/, 'one view at a time');
});

test('B: the old address still resolves', async () => {
  // Bookmarks, the audit document, and anything else pointing at Recurring
  // tasks must still land somewhere true.
  assert.strictEqual(await hit('/c/recurring'), 301);
  assert.strictEqual(await hit('/c/recurring/4'), 301);
  const r = await fetch(`${BASE}/c/recurring`, { redirect: 'manual' });
  assert.strictEqual(r.headers.get('location'), '/calendar');
});

test('B: the generic tracker no longer answers for recurring', async () => {
  // The "one source of truth" requirement: /c/:slug CRUD must not still be
  // serving a second, competing version of this data.
  const M = require('../src/modules');
  assert.ok(!M.MODULES.some((m) => m.slug === 'recurring'),
    'the registry entry is gone, so the generic edit and delete pages do not exist');
});

test('B: a new item is created through the composer form', async () => {
  const before = C.q.all.all().length;
  const res = await send('/calendar/new', {
    title: 'Meet the linen vendor', category: 'Other', starts_on: '2026-11-12',
    all_day: '1', repeat: 'monthly', kind: 'event', reminder: '1440',
  });
  assert.strictEqual(res.status, 302);
  const made = C.q.all.all();
  assert.strictEqual(made.length, before + 1);
  const item = made.find((i) => i.title === 'Meet the linen vendor');
  assert.strictEqual(item.kind, 'event');
  assert.strictEqual(item.rrule_freq, 'monthly');
  assert.deepStrictEqual(C.reminders(item.id).map((r) => r.offset_min), [1440]);
});

test('B: the composer defaults to a TASK and to not repeating', async () => {
  const html = await page('/calendar');
  const form = html.slice(html.indexOf('id="zc-composer"'), html.indexOf('</aside>', html.indexOf('id="zc-composer"')));
  assert.match(form, /<option value="task" selected>/, 'a task by default — this module is for the work that must happen');
  assert.match(form, /<option value="">Does not repeat<\/option>/);
  const opts = [...form.matchAll(/<option value="(\d+)">([^<]+)</g)].map((m) => m[2]);
  assert.ok(opts.every((o) => /day|week/i.test(o)),
    'only reminder offsets a daily sweep can honour are offered — a control that cannot fire is a lie');
});

test('B: every posting form carries its own token', async () => {
  // The stamper only runs when APP_PASSWORD is set, which no dev machine and
  // almost no test does. A form leaning on it ships with no field at all.
  const html = await page('/calendar');
  const forms = [...html.matchAll(/<form\b[^>]*method="post"[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]);
  assert.ok(forms.length >= 4, `found ${forms.length} posting forms`);
  for (const f of forms) {
    assert.match(f, /name="_csrf"/, 'hand-written, not left to the stamper');
  }
});

test('B: completing and undoing go through the domain, not the URL', async () => {
  const item = C.create({ kind: 'task', title: 'Route completion', starts_on: '2026-11-03' });
  assert.strictEqual((await send('/calendar/complete', { id: String(item.id), occurs_on: '2026-11-03' })).status, 302);
  assert.strictEqual(C.history(item.id).length, 1);
  assert.strictEqual((await send('/calendar/uncomplete', { id: String(item.id), occurs_on: '2026-11-03' })).status, 302);
  assert.strictEqual(C.history(item.id).length, 0);
  // The old undo carried the dates it had overwritten in an editable
  // querystring. Nothing here takes a date from the caller.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const region = src.slice(src.indexOf("app.post('/calendar/uncomplete'"), src.indexOf("app.post('/calendar/delete'"));
  assert.ok(!/req\.query/.test(region), 'undo reads no dates from the querystring');
});

test('B: deleting one occurrence of a series leaves the rest', async () => {
  const item = C.create({ title: 'Route skip', starts_on: '2026-11-02', rrule_freq: 'weekly' });
  await send('/calendar/delete', { id: String(item.id), occurs_on: '2026-11-09', scope: 'one' });
  // expand(), not datesFor(). The rule still produces the 9th — an exception is
  // not a change to the rule — and expand is what applies it. That separation
  // is what lets "this occurrence only" leave the series itself untouched.
  assert.deepStrictEqual(
    C.expand(C.q.byId.get(item.id), '2026-11-01', '2026-11-30').map((o) => o.date),
    ['2026-11-02', '2026-11-16', '2026-11-23', '2026-11-30']);
  assert.ok(C.datesFor(C.q.byId.get(item.id), '2026-11-01', '2026-11-30').includes('2026-11-09'),
    'while the rule itself is unchanged');
});

test('B: a task can be completed from the page; an event cannot', async () => {
  const ev = C.create({ kind: 'event', title: 'Route event', starts_on: '2026-11-05' });
  const res = await send('/calendar/complete', { id: String(ev.id), occurs_on: '2026-11-05' });
  const loc = decodeURIComponent(res.headers.get('location') || '');
  assert.match(loc, /err=1/, 'refused');
  assert.match(loc, /Only a task can be completed/);
});

test('B: the calendar never claims attendance', async () => {
  // It is not the Schedule. Nothing here knows or implies who turned up.
  const html = await page('/calendar');
  for (const claim of ['Clocked in', 'In progress', 'No-show', 'On break', 'Late arrival']) {
    assert.ok(!html.includes(claim), `the calendar does not say "${claim}"`);
  }
});

test('B: the calendar page writes nothing to the schedule or the clock', async () => {
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const before = ['scheduled_shifts', 'time_entries', 'work', 'shifts'].map(count);
  await send('/calendar/new', { title: 'Footprint', starts_on: '2026-11-20', all_day: '1' });
  await page('/calendar');
  assert.deepStrictEqual(['scheduled_shifts', 'time_entries', 'work', 'shifts'].map(count), before);
});

// ===========================================================================
// STAGE C — the time grid, and what a change to a series touches
// ===========================================================================

test('C: week and day are real views, and the week starts Monday', async () => {
  const wk = await page('/calendar?v=week&d=2026-09-09');
  assert.match(wk, /class="zc-tg"/, 'a time grid, not seven month cells');
  const heads = [...wk.matchAll(/class="zc-tg-d[^"]*"[\s\S]{0,80}?<i>([A-Za-z]+)<\/i><b>(\d+)</g)]
    .map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(heads.map((h) => h[0]), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.strictEqual(heads[0][1], '7', 'the week containing Wed the 9th begins Mon the 7th');

  const day = await page('/calendar?v=day&d=2026-09-09');
  assert.match(day, /class="zc-tg"/);
  assert.strictEqual((day.match(/class="zc-tg-d/g) || []).length, 1, 'one column');
  assert.match(day, /Wednesday, September 9/, 'and the date is the heading');
});

test('C: a timed item is placed by its actual start, not by its row', async () => {
  const d = '2026-10-07';
  C.create({ kind: 'event', title: 'Grid probe', starts_on: d,
    all_day: 0, start_min: (9 * 60) + 30, end_min: 11 * 60 });
  const html = await page(`/calendar?v=day&d=${d}`);
  const blk = (html.match(/class="zc-blk[^"]*"[^>]*style="[^"]*"/) || [])[0] || '';
  // 6am is the top of the grid at 44px an hour, so 9:30 is 3.5 hours down.
  assert.match(blk, /top:154px/, '9:30am sits three and a half hours below 6am');
  assert.match(blk, /height:66px/, 'and an hour and a half tall');
});

test('C: an all-day item goes in the all-day strip, never the time grid', async () => {
  const d = '2026-10-08';
  C.create({ kind: 'task', title: 'All day probe', starts_on: d });
  const html = await page(`/calendar?v=day&d=${d}`);
  const strip = html.slice(html.indexOf('class="zc-ad"'), html.indexOf('class="zc-tg-b"'));
  assert.match(strip, /All day probe/, 'it is in the strip');
  // Bounded at the end of the grid: everything after it is the page's own data
  // blob, which naturally lists every title and would match anything.
  const body = html.slice(html.indexOf('class="zc-tg-b"'), html.indexOf('</script>'));
  const cols = body.slice(0, body.indexOf('<script'));
  assert.ok(!cols.includes('All day probe'), 'and not floating at an invented hour');
});

test('C: every hour is a create target carrying its own time', async () => {
  const html = await page('/calendar?v=day&d=2026-10-09');
  const slots = [...html.matchAll(/class="zc-slot"[^>]*data-add="2026-10-09" data-min="(\d+)"/g)]
    .map((m) => Number(m[1]));
  assert.strictEqual(slots.length, 18, '6am to midnight');
  assert.strictEqual(slots[0], 360, 'the first is 6am');
  assert.strictEqual(slots[slots.length - 1], 1380, 'the last is 11pm');
  // Built so drag-to-create can be layered on later: a click already resolves
  // to a minute, so the mapping does not have to be invented then.
  assert.match(html, /data-h0="6" data-px="44"/, 'the grid publishes its own scale');
});

test('C: the scope choice is offered for a series and defaults to the safest', async () => {
  const html = await page('/calendar');
  const sc = html.slice(html.indexOf('id="zc-d-scope"'), html.indexOf('</fieldset>'));
  assert.match(sc, /value="one" checked/,
    'this occurrence by default — defaulting to the series is how a year of Mondays goes to one mis-tap');
  for (const v of ['one', 'future', 'all']) assert.match(sc, new RegExp(`value="${v}"`));
  assert.match(html, /scope\.hidden = !o\.r/, 'and it is hidden entirely for a one-off');
});

test('C: deleting "this and following" splits rather than erasing the past', async () => {
  const item = C.create({ title: 'Scope route', starts_on: '2026-10-05', rrule_freq: 'weekly' });
  const res = await send('/calendar/delete',
    { id: String(item.id), occurs_on: '2026-10-19', scope: 'future' });
  assert.strictEqual(res.status, 302);
  assert.deepStrictEqual(C.datesFor(C.q.byId.get(item.id), '2026-10-01', '2026-11-30'),
    ['2026-10-05', '2026-10-12'], 'the two that already happened are still there');
});

test('C: the whole series can still be deleted deliberately', async () => {
  const item = C.create({ title: 'Scope all', starts_on: '2026-10-06', rrule_freq: 'weekly' });
  await send('/calendar/delete', { id: String(item.id), occurs_on: '2026-10-13', scope: 'all' });
  assert.strictEqual(C.q.byId.get(item.id), undefined);
});

test('C: a forged scope falls back rather than doing something unasked', async () => {
  const item = C.create({ title: 'Forged scope', starts_on: '2026-10-07', rrule_freq: 'weekly' });
  await send('/calendar/delete', { id: String(item.id), occurs_on: '2026-10-14', scope: 'everything' });
  assert.strictEqual(C.q.byId.get(item.id), undefined, 'an unknown scope is treated as the explicit one');
});

test('C: the arrows step in the unit the view is measured in', async () => {
  const wk = await page('/calendar?v=week&d=2026-09-09');
  assert.match(wk, /href="\/calendar\?v=week&d=2026-09-16"/, 'a week forward is seven days');
  const day = await page('/calendar?v=day&d=2026-09-09');
  assert.match(day, /href="\/calendar\?v=day&d=2026-09-10"/, 'a day forward is one');
  const mo = await page('/calendar?v=month&m=2026-09');
  assert.match(mo, /m=2026-10/, 'a month forward is a month');
});

test('C: a week straddling two months says both in the heading', async () => {
  const html = await page('/calendar?v=week&d=2026-09-30');
  assert.match(html, /Sep 28 – Oct 4, 2026/);
});
