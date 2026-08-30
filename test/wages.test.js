'use strict';

// A raise used to restate history. Promote a cook to kitchen lead on the 20th
// and every shift they had ever worked was suddenly priced at lead money, so
// the payroll page said you owed them for weeks you had already paid.
//
// These are the rules that stop that, and the one deliberate exception.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-wages-'));
process.env.DB_PATH = path.join(dir, 'wages.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db, shiftInputs } = require('../src/db');
const W = require('../src/wages');
const { WAGE_RATE_SQL } = require('../src/reports');

let COOK; let SHIFT_MAR; let SHIFT_MAY;

test.before(() => {
  COOK = Number(db.prepare(
    `INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
     VALUES ('Wage Cook', 'kitchen', 1600, 1, '7701')`).run().lastInsertRowid);

  const mk = (date) => Number(db.prepare(
    `INSERT INTO shifts (date, daypart, status, created_at)
     VALUES (?, 'dinner', 'emailed', datetime('now'))`).run(date).lastInsertRowid);
  SHIFT_MAR = mk('2026-03-10');
  SHIFT_MAY = mk('2026-05-10');

  // No rate on the row: these are the shifts whose price is resolved rather
  // than recorded, which is where a raise used to leak backwards.
  const work = db.prepare(
    `INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents)
     VALUES (?, ?, 'kitchen', 8, 0)`);
  work.run(SHIFT_MAR, COOK);
  work.run(SHIFT_MAY, COOK);
});

// --- the seed: day one changes nothing ---------------------------------------

test('seeding writes every wage on file as having always applied', () => {
  const out = W.seedFromCurrent();
  assert.ok(out.seeded > 0, 'it wrote the wages that existed');
  assert.strictEqual(W.wageOn(COOK, 'kitchen', '2026-03-10'), 1600,
    'and a shift from before anybody had heard of wage history still prices the same');
  assert.strictEqual(W.wageOn(COOK, 'kitchen', '1999-01-01'), 1600,
    'at any date at all, because the seed is effective from the beginning');

  // Running it again after a real dated change would stamp today's wage back
  // at the start of time and erase the history this whole module exists for.
  const again = W.seedFromCurrent();
  assert.strictEqual(again.skipped, true, 'a second seed refuses');
  assert.strictEqual(again.seeded, 0);
});

// --- the point of the whole thing --------------------------------------------

test('a raise applies from its date forward and leaves earlier shifts alone', () => {
  W.setWage(COOK, 'kitchen', 2100, '2026-04-01', { by: 'test', note: 'promoted to lead' });

  assert.strictEqual(W.wageOn(COOK, 'kitchen', '2026-03-10'), 1600, 'March is untouched');
  assert.strictEqual(W.wageOn(COOK, 'kitchen', '2026-03-31'), 1600, 'right up to the day before');
  assert.strictEqual(W.wageOn(COOK, 'kitchen', '2026-04-01'), 2100, 'and applies on the day itself');
  assert.strictEqual(W.wageOn(COOK, 'kitchen', '2026-05-10'), 2100, 'and after');
});

test('payroll prices each shift at the wage in force on the day it was worked', () => {
  // shiftInputs is what payroll and the tip-out both read. This is the
  // assertion that the raise did not reach backwards into money already paid.
  const march = shiftInputs(SHIFT_MAR);
  const may = shiftInputs(SHIFT_MAY);
  const rateOf = (inp) => [...inp.servers, ...inp.support]
    .find((p) => p.employeeId === COOK).hourlyRate;

  assert.strictEqual(rateOf(march), 16, 'the March shift is still $16');
  assert.strictEqual(rateOf(may), 21, 'the May shift is $21');
});

test('the SQL resolver agrees with the JS one, per shift', () => {
  // Two implementations of one rule is a chance to disagree. engine.test.js
  // pins them against each other on live data; this pins them across a DATE
  // BOUNDARY, which is the case that did not exist before.
  const q = db.prepare(`SELECT ${WAGE_RATE_SQL} AS cents
      FROM work w JOIN employees e ON e.id = w.employee_id
      JOIN shifts sh ON sh.id = w.shift_id
      LEFT JOIN employee_roles er ON er.employee_id = w.employee_id AND er.role = w.role
     WHERE w.shift_id = ? AND w.employee_id = ?`);
  assert.strictEqual(q.get(SHIFT_MAR, COOK).cents, 1600, 'March, in SQL');
  assert.strictEqual(q.get(SHIFT_MAY, COOK).cents, 2100, 'May, in SQL');
});

// --- the exception, and its limits -------------------------------------------

test('a rate recorded on a shift outranks the wage history', () => {
  // What was actually paid for a shift is a fact about that shift. A later
  // raise, or a later correction, does not get to restate it.
  db.prepare('UPDATE work SET hourly_rate_cents = 1750 WHERE shift_id = ? AND employee_id = ?')
    .run(SHIFT_MAY, COOK);
  const rate = [...shiftInputs(SHIFT_MAY).support, ...shiftInputs(SHIFT_MAY).servers]
    .find((p) => p.employeeId === COOK).hourlyRate;
  assert.strictEqual(rate, 17.5, 'the recorded rate wins over the $21 in force that day');
  db.prepare('UPDATE work SET hourly_rate_cents = 0 WHERE shift_id = ? AND employee_id = ?')
    .run(SHIFT_MAY, COOK);
});

test('restamp is the one thing that overrules a recorded rate, and it is counted first', () => {
  // "Apply to all past shifts" exists for a wage that was simply typed wrong.
  // It is never automatic: the manager is told how many shifts it will rewrite
  // before it rewrites them.
  const n = W.countAffected(COOK, 'kitchen', '2026-01-01', '2026-12-31');
  assert.strictEqual(n, 2, 'both shifts are in range and would be rewritten');

  const changed = W.restamp(COOK, 'kitchen', 1900, '2026-01-01', '2026-12-31');
  assert.strictEqual(changed, 2);
  const rate = [...shiftInputs(SHIFT_MAR).support, ...shiftInputs(SHIFT_MAR).servers]
    .find((p) => p.employeeId === COOK).hourlyRate;
  assert.strictEqual(rate, 19, 'March now reads the corrected rate');

  db.prepare('UPDATE work SET hourly_rate_cents = 0 WHERE employee_id = ?').run(COOK);
});

test('restamp stays inside the role it was asked about', () => {
  // Correcting a busser rate must not restate the same person's cook shifts.
  const n = W.countAffected(COOK, 'busser', '2026-01-01', '2026-12-31');
  assert.strictEqual(n, 0, 'they never worked a busser shift');
  assert.strictEqual(W.restamp(COOK, 'busser', 9999, '2026-01-01', '2026-12-31'), 0);
});

// --- the ordering rule --------------------------------------------------------

test('a wage set for the position beats the default, however old it is', () => {
  // The rule the rest of the app already follows, kept under dating: a busser
  // wage from years ago still wins for a busser shift over a default rate
  // raised last week, because the default is what they earn in their own job.
  W.setWage(COOK, 'busser', 1100, '2020-01-01');
  W.setWage(COOK, null, 3000, '2026-06-01');
  assert.strictEqual(W.wageOn(COOK, 'busser', '2026-07-01'), 1100, 'specificity beats recency');
  assert.strictEqual(W.wageOn(COOK, 'dishwasher', '2026-07-01'), 3000,
    'a position with no wage of its own falls to the default in force that day');
});

test('two changes on one day are a correction, not two raises', () => {
  W.setWage(COOK, 'kitchen', 2200, '2026-09-01');
  W.setWage(COOK, 'kitchen', 2300, '2026-09-01');
  const rows = W.historyFor(COOK).filter((r) => r.role === 'kitchen' && r.effective_from === '2026-09-01');
  assert.strictEqual(rows.length, 1, 'one row for one day');
  assert.strictEqual(rows[0].wage_cents, 2300, 'the later value wins');
});

test('a wage change needs a date, and says so rather than guessing one', () => {
  assert.throws(() => W.setWage(COOK, 'kitchen', 2000, ''), /needs a date/);
  assert.throws(() => W.setWage(COOK, 'kitchen', 2000, 'next tuesday'), /needs a date/);
});

test('nothing on file reads as nothing on file, not as a wage of zero', () => {
  const nobody = Number(db.prepare(
    `INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
     VALUES ('Wage Nobody', 'server', 0, 1, '7702')`).run().lastInsertRowid);
  assert.strictEqual(W.wageOn(nobody, 'server', '2026-05-01'), 0,
    'zero here means "fall through and look elsewhere", which every caller does');
});

// --- the choice a manager actually makes -------------------------------------
//
// The mechanism above is only half of it. The other half is that the person
// changing a wage is ASKED what they mean, with the safe answer as the default
// and the destructive one labelled with what it will destroy.

test('the wage form offers three answers, and the safe one is the default', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const block = /function wageWhenFields\(([\s\S]*?)\n}/.exec(src)[1];

  for (const v of ['"today"', '"date"', '"all"']) {
    assert.ok(block.includes(`value=${v}`), `the form offers ${v}`);
  }
  // "From today" is right almost every time, so it is what happens if nobody
  // reads the fieldset at all.
  assert.match(block, /value="today" checked/, 'from today is preselected');
  // The count is printed into the label, not reported after the fact: "all
  // shifts" on somebody with four hundred shifts should say so out loud.
  assert.match(block, /countAffected/, 'the destructive option counts first');
});

test('an unrecognised or missing choice falls back to "from today"', () => {
  // A hand-made POST, an old cached form, a bad value: none of them may end up
  // rewriting history. Anything that is not one of the three known answers is
  // treated as the safe one.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const fn = /function applyWageChange\(([\s\S]*?)\n}/.exec(src)[1];
  assert.match(fn, /\['today', 'date', 'all'\]\.includes\(body\.wage_from\)/,
    'the mode is validated against a list');
  assert.match(fn, /: 'today'/, 'and anything else becomes today');
  // EPOCH is reachable only through the explicit "all" answer.
  assert.match(fn, /mode === 'all' \? WAGES\.EPOCH/,
    'nothing but an explicit "all" back-dates a wage to the beginning');
  assert.match(fn, /mode === 'all'\) \{[\s\S]*?restamp/,
    'and nothing but "all" rewrites a recorded rate');
});
