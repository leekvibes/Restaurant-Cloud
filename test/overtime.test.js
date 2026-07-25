'use strict';

// Overtime, the whole way down: the pure premium math, the settings and the
// per-person exemption, and that with it off payroll is exactly what it was.
//
// The rule is federal — over the weekly threshold at the multiplier, measured
// per workweek. The two things worth more than the rest: that a week at or
// under the line earns nothing extra, and that turning it off (or exempting a
// person) leaves the straight-time wage untouched to the penny.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ot-'));
process.env.DB_PATH = path.join(dir, 'ot.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

// Requiring these builds the schema and runs the migrations against the temp
// database named above.
const { db } = require('../src/db');
const OT = require('../src/overtime');
const { aggregatePayroll } = require('../src/reports');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The premium math, on its own.
// ---------------------------------------------------------------------------
const RULE = { threshold: 40, multiplier: 1.5 };

test('a week under the line earns no overtime', () => {
  assert.deepStrictEqual(OT.overtimeFor([{ hours: 35, wage: 35000 }], RULE), { otHours: 0, otPay: 0 });
  assert.deepStrictEqual(OT.overtimeFor([{ hours: 40, wage: 40000 }], RULE), { otHours: 0, otPay: 0 },
    'exactly the threshold is not over it');
});

test('a week over the line earns the premium on the hours above it', () => {
  // 45h at $10: 5 OT hours; straight time already paid all 45, so the premium
  // is the extra half on those 5 — 5 × $10 × 0.5 = $25.
  assert.deepStrictEqual(OT.overtimeFor([{ hours: 45, wage: 45000 }], RULE), { otHours: 5, otPay: 2500 });
});

test('overtime is measured per week, not across the fortnight', () => {
  // 38 + 38 = 76 hours over two weeks, but neither week crosses 40, so no OT —
  // proving it is not summed across the period.
  assert.deepStrictEqual(OT.overtimeFor([{ hours: 38, wage: 38000 }, { hours: 38, wage: 38000 }], RULE),
    { otHours: 0, otPay: 0 });
  // 45 + 38: only week one earns it.
  assert.deepStrictEqual(OT.overtimeFor([{ hours: 45, wage: 45000 }, { hours: 38, wage: 38000 }], RULE),
    { otHours: 5, otPay: 2500 });
});

test('the regular rate is the weighted average when the week had two rates', () => {
  // 30h @ $10 + 20h @ $20 = 50h, $700 straight. Regular rate = $14/hr; 10 OT
  // hours × $14 × 0.5 = $70. Not $10 or $20 — the blended rate FLSA requires.
  assert.deepStrictEqual(OT.overtimeFor([{ hours: 50, wage: 70000 }], RULE), { otHours: 10, otPay: 7000 });
});

test('a different threshold and multiplier are honoured', () => {
  // Over 35 at 2×: 45h → 10 OT hours × $10 × 1.0 = $100.
  assert.deepStrictEqual(OT.overtimeFor([{ hours: 45, wage: 45000 }], { threshold: 35, multiplier: 2 }),
    { otHours: 10, otPay: 10000 });
});

// ---------------------------------------------------------------------------
// Settings and exemption.
// ---------------------------------------------------------------------------
test('the rule persists and clamps nonsense', () => {
  OT.saveRule({ enabled: true, threshold: 45, multiplier: 2 });
  let r = OT.rule();
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.threshold, 45);
  assert.strictEqual(r.multiplier, 2);

  // A 0-hour threshold or 0× multiplier would turn a run to nonsense; clamped.
  OT.saveRule({ enabled: false, threshold: 0, multiplier: 0 });
  r = OT.rule();
  assert.strictEqual(r.enabled, false);
  assert.ok(r.threshold >= 1, 'threshold clamped up from 0');
  assert.ok(r.multiplier >= 1, 'multiplier clamped up from 0');
});

// ---------------------------------------------------------------------------
// End to end through aggregatePayroll, on seeded shifts.
// ---------------------------------------------------------------------------
// One server, $10/hr, 45 hours inside a single workweek — so off pays $450 flat
// and on pays $475 ($25 premium).
const FROM = '2026-03-02';   // a Monday; wk1 is the seven days from here
const empId = db.prepare('INSERT INTO employees (name, role, hourly_rate_cents, active) VALUES (?,?,?,1)')
  .run('Otto Vertime', 'server', 1000).lastInsertRowid;
const shiftId = db.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'dinner', 'emailed')")
  .run('2026-03-03').lastInsertRowid;
db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)').run(shiftId, empId, 'server', 45);
db.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents)
  VALUES (?,?,0,0,0,0,0)`).run(shiftId, empId);

test('with overtime off, wages are straight time to the penny', () => {
  OT.saveRule({ enabled: false, threshold: 40, multiplier: 1.5 });
  const { rows } = aggregatePayroll(FROM, '2026-03-15');
  const otto = rows.find((r) => r.employeeId === empId);
  assert.strictEqual(otto.wage, 45000, '45h × $10 = $450, no premium');
  assert.strictEqual(otto.otHours, 0);
  assert.strictEqual(otto.otPay, 0);
});

test('with overtime on, the premium lands and take-home rises by exactly it', () => {
  OT.saveRule({ enabled: true, threshold: 40, multiplier: 1.5 });
  const { rows, totals } = aggregatePayroll(FROM, '2026-03-15');
  const otto = rows.find((r) => r.employeeId === empId);
  assert.strictEqual(otto.otHours, 5, '5 hours over 40');
  assert.strictEqual(otto.otPay, 2500, '5 × $10 × 0.5 = $25');
  assert.strictEqual(otto.wage, 47500, 'straight $450 + $25 premium');
  // The one invariant that catches a double-count: the whole wage increase over
  // straight time IS the overtime pay, nothing more.
  assert.strictEqual(otto.wage - 45000, otto.otPay, 'the increase is exactly the premium');
  assert.strictEqual(totals.otPay, 2500, 'and it reaches the totals');
});

test('an exempt person gets no overtime even while it is on', () => {
  OT.saveRule({ enabled: true, threshold: 40, multiplier: 1.5 });
  OT.setExempt(empId, true);
  const { rows } = aggregatePayroll(FROM, '2026-03-15');
  const otto = rows.find((r) => r.employeeId === empId);
  assert.strictEqual(otto.otPay, 0, 'no premium');
  assert.strictEqual(otto.wage, 45000, 'back to straight time');
  OT.setExempt(empId, false);
});
