'use strict';

// What the Performance figures were missing, besides salary.
//
// The owner, asked what else should be in them: "i want everything being
// included in those numbers. gross profit is after ALL Costs."
//
// Three holes, each verified in the code before it was filled:
//
//   1. OVERTIME. It is switched on in Payroll, which pays the premium — and
//      the report priced every hour at straight time, so the extra half on
//      every hour over forty was in nobody's cost.
//   2. EMPLOYER PAYROLL TAX. Not modelled anywhere. The app cannot know the
//      rate, so it is recorded by the owner and disclosed until it is.
//   3. EVERY OTHER COST. "Gross profit" stopped after labour and food, with
//      rent, utilities, insurance and every out-of-pocket receipt outside it.
//
// And the one that protects all the others: a range can contain services with
// no sales entered, and the page used to report its ratios over them without a
// word. A figure that is quietly built on half a month is worse than no figure.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-rc-'));
process.env.DB_PATH = path.join(dir, 'rc.db');
process.env.TZ = process.env.TZ || 'America/New_York';

const { db } = require('../src/db');
require('../src/modules');
const OT = require('../src/overtime');
const SALARY = require('../src/salary');
const MX = require('../src/metrics');

const EMP = { hank: 911, exempt: 912 };
// A workweek the payroll anchor agrees with: periods run from 2026-07-04 in
// fourteens, so 2026-07-18 starts one and its first half ends on the 24th.
const WEEK = ['2026-07-18', '2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22'];
const RATE = 2000;                                  // $20 an hour
const shiftOn = db.prepare(`INSERT INTO shifts (date, daypart, status, total_food_cents, created_at)
  VALUES (?, 'dinner', 'emailed', ?, datetime('now'))`);

test.before(() => {
  const ins = db.prepare(`INSERT INTO employees (id, name, role, hourly_rate_cents, active, ot_exempt)
    VALUES (?, ?, 'cook', ?, 1, ?)`);
  ins.run(EMP.hank, 'Overtime Hank', RATE, 0);
  ins.run(EMP.exempt, 'Exempt Edna', RATE, 1);
  const work = db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)');
  // 45 hours each across one workweek: five hundred-dollar services, 9h a day.
  for (const d of WEEK) {
    const id = Number(shiftOn.run(d, 100000).lastInsertRowid);
    work.run(id, EMP.hank, 'cook', 9);
    work.run(id, EMP.exempt, 'cook', 9);
  }
});

test.after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });

const week = () => MX.period(WEEK[0], WEEK[WEEK.length - 1]);
const STRAIGHT = 45 * RATE * 2;                     // both people, 45h each at $20

test('with overtime off, nothing is charged for it', () => {
  OT.saveRule({ enabled: false, threshold: 40, multiplier: 1.5 });
  const p = week();
  assert.strictEqual(p.overtime, 0);
  assert.strictEqual(p.overtimeOn, false);
  assert.strictEqual(p.wages, STRAIGHT, 'straight time for every hour, as before');
  assert.strictEqual(p.labor, p.wages, 'and labour is exactly wages');
});

test('with it on, the premium payroll pays is in the cost — and only the premium', () => {
  OT.saveRule({ enabled: true, threshold: 40, multiplier: 1.5 });
  const p = week();
  // Hank: 45h, 5 over the line, at $20 × 0.5 = $50. Edna is exempt.
  assert.strictEqual(p.overtime, 5 * RATE * 0.5, 'five hours of half-rate, for the one person owed it');
  assert.strictEqual(p.overtimeHours, 5);
  assert.strictEqual(p.wages, STRAIGHT, 'the base is untouched, so nothing is counted twice');
  assert.strictEqual(p.labor, p.wages + p.overtime);
});

test('somebody marked exempt is not charged overtime, the way payroll treats them', () => {
  db.prepare('UPDATE employees SET ot_exempt = 0 WHERE id = ?').run(EMP.exempt);
  assert.strictEqual(week().overtime, 2 * (5 * RATE * 0.5), 'both of them now');
  db.prepare('UPDATE employees SET ot_exempt = 1 WHERE id = ?').run(EMP.exempt);
  assert.strictEqual(week().overtime, 5 * RATE * 0.5, 'and back to one');
});

test('a range that cuts a week carries that week’s share, not all of it and not none', () => {
  // Monday to Thursday: 36 of Hank's 45 hours. The whole week is still
  // measured — otherwise he never reaches forty and the premium vanishes —
  // and this range is charged 36/45 of it.
  const part = MX.period(WEEK[0], WEEK[3]);
  assert.strictEqual(part.overtime, Math.round(5 * RATE * 0.5 * (36 / 45)));
  assert.strictEqual(part.overtimeApportioned, true, 'and it says it was apportioned');
  assert.strictEqual(week().overtimeApportioned, false, 'a whole week is not');
});

test('a salaried person is never charged overtime', () => {
  const sal = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pay_type, salary_cents)
    VALUES ('Salary Sam', 'manager', 0, 1, 'salary', 280000)`).run().lastInsertRowid);
  const work = db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)');
  for (const d of WEEK) {
    work.run(db.prepare('SELECT id FROM shifts WHERE date = ?').get(d).id, sal, 'manager', 12);
  }
  assert.strictEqual(week().overtime, 5 * RATE * 0.5, 'sixty hours of salaried manager adds nothing');
  db.prepare('DELETE FROM work WHERE employee_id = ?').run(sal);
  db.prepare('DELETE FROM employees WHERE id = ?').run(sal);
});

test('employer payroll tax is zero until a rate is recorded, and said so', () => {
  const p = week();
  assert.strictEqual(p.payrollTax, 0);
  assert.strictEqual(p.payrollTaxPct, 0, 'which is what the page discloses');
});

test('once a rate is recorded it is charged on all pay, overtime included', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('payroll_tax_pct', '10') "
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();
  SALARY.setSalary({ employeeId: EMP.hank, cents: 0, from: WEEK[0], by: 'test' });   // no salary in play
  const p = week();
  assert.strictEqual(p.payrollTaxPct, 10);
  assert.strictEqual(p.payrollTax, Math.round((p.wages + p.salary + p.overtime) * 0.1));
  assert.strictEqual(p.labor, p.wages + p.salary + p.overtime + p.payrollTax,
    'labour is all four, which is what the ratios are built on');
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'payroll_tax_pct'").run();
});

test('profit is after EVERY cost, not after labour and food', () => {
  // A rent bill and a till-roll receipt: neither is food, so neither was in
  // any profit figure this app produced before.
  db.prepare(`INSERT INTO m_invoices (invoice_date, category, amount_cents, status)
    VALUES (?, 'Rent', 500000, 'unpaid')`).run(WEEK[0]);
  db.prepare(`INSERT INTO m_invoices (invoice_date, category, amount_cents, status)
    VALUES (?, 'Food', 200000, 'unpaid')`).run(WEEK[0]);
  db.prepare('INSERT INTO m_expenses (spent_on, name, category, amount_cents) VALUES (?, ?, ?, ?)')
    .run(WEEK[0], 'till rolls', 'Supplies', 4000);
  const p = week();
  assert.strictEqual(p.cogs, 200000, 'food and drink only, as prime cost needs');
  assert.strictEqual(p.invoiceTotal, 700000, 'every bill, whatever its category');
  assert.strictEqual(p.expenses, 4000);
  assert.strictEqual(p.allCosts, p.labor + p.invoiceTotal + p.expenses);
  assert.strictEqual(p.netProfit, p.sales - p.allCosts, 'after all of it');
  assert.strictEqual(p.grossProfit, p.sales - p.labor - p.cogs, 'and gross profit still means what it meant');
  assert.ok(p.netProfit < p.grossProfit, 'the rent has to cost something');
});

test('a service with no sales entered is named, not silently averaged over', () => {
  const quiet = Number(shiftOn.run('2026-07-23', 0).lastInsertRowid);
  const p = MX.period(WEEK[0], '2026-07-24');
  assert.strictEqual(p.gaps.noFigures.length, 1, 'the range knows it is short one');
  assert.strictEqual(p.gaps.noFigures[0].date, '2026-07-23');
  assert.strictEqual(p.gaps.noFigures[0].id, quiet, 'with a way back to the service itself');
  assert.strictEqual(p.shiftCount, 6, 'it is in the count of services');
  assert.strictEqual(p.completedShifts, 5, 'and out of the ones with figures');
  db.prepare('DELETE FROM shifts WHERE id = ?').run(quiet);
});

test('a service where somebody has no hours is named too, because labour is short', () => {
  const id = db.prepare('SELECT id FROM shifts WHERE date = ?').get(WEEK[0]).id;
  // Their own person: `work` is keyed by (shift, employee), so the somebody
  // who never clocked out has to be somebody not already on the service.
  const nora = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
    VALUES ('No Hours Nora', 'cook', ?, 1)`).run(RATE).lastInsertRowid);
  db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,0)')
    .run(id, nora, 'cook');
  const p = week();
  assert.strictEqual(p.gaps.noHours.length, 1);
  assert.strictEqual(p.gaps.noHours[0].date, WEEK[0]);
  assert.ok(p.gaps.noHours[0].people >= 1, 'and how many people it is');
  db.prepare('DELETE FROM work WHERE shift_id = ? AND hours = 0').run(id);
  db.prepare('DELETE FROM employees WHERE id = ?').run(nora);
  assert.strictEqual(week().gaps.noHours.length, 0, 'and it clears once they have hours');
});
