'use strict';

// A SERVICE THAT HAS GONE OUT NEVER MOVES.
//
// The owner's rule: nothing changed later — a policy, a setting, a wage, a fix
// to the arithmetic — may change a service that has been sent, or the payroll
// for its dates. The policy and a job's tip handling were already locked onto
// each service. These are the rest: a sent service keeps each person's rate
// and whether they were salaried (db.js, settleShift), and a pay period whose
// payroll went out keeps the overtime rule it went out under (periods.js,
// stampOvertime). Deliberate edits to the service itself still apply; that is
// tested where the service page is.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-settle-'));
process.env.DB_PATH = path.join(dir, 'settle.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const D = require('../src/db');
const { db } = D;
const W = require('../src/wages');
const OT = require('../src/overtime');
const PER = require('../src/periods');
const { addDays } = require('../src/dates');
const { aggregatePayroll } = require('../src/reports');

const mkEmp = (name, cents) => Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
  VALUES (?, 'kitchen', ?, 1)`).run(name, cents).lastInsertRowid);
const mkShift = (date, status) => Number(db.prepare(`INSERT INTO shifts (date, daypart, status)
  VALUES (?, 'dinner', ?)`).run(date, status).lastInsertRowid);
const work = (sid, emp, hours) => db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours)
  VALUES (?, ?, 'kitchen', ?)`).run(sid, emp, hours);
const payOn = (day, emp) => aggregatePayroll(day, day).rows.find((r) => r.employeeId === emp) || {};

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a sent service keeps the wage it was sent with, whatever is changed later', () => {
  const cook = mkEmp('Settle Cook', 1500);
  const sent = mkShift('2026-06-02', 'open');
  work(sent, cook, 4);
  const open = mkShift('2026-06-03', 'open');
  work(open, cook, 4);
  db.prepare("UPDATE shifts SET status = 'emailed' WHERE id = ?").run(sent);
  D.settleShift(sent);
  assert.strictEqual(payOn('2026-06-02', cook).wage, 6000, '4h at $15 when it went out');

  W.setWage(cook, null, 3000, '2000-01-01', { note: 'backdated to the beginning' });
  assert.strictEqual(payOn('2026-06-02', cook).wage, 6000, 'a raise backdated to the beginning does not reach it');
  assert.strictEqual(payOn('2026-06-03', cook).wage, 12000, 'it does reach the service not sent yet');

  assert.strictEqual(W.countAffected(cook, null, '0001-01-01', '2026-12-31'), 1,
    '"all shifts, including past" counts only the unsent one');
  W.restamp(cook, null, 4000, '0001-01-01', '2026-12-31');
  assert.strictEqual(payOn('2026-06-02', cook).wage, 6000, 'and rewrites only that one');
  assert.strictEqual(payOn('2026-06-03', cook).wage, 16000);

  db.prepare("UPDATE employees SET pay_type = 'salary' WHERE id = ?").run(cook);
  assert.strictEqual(payOn('2026-06-02', cook).wage, 6000, 'switching them to salary does not zero a night already paid');
  db.prepare("UPDATE employees SET pay_type = 'hourly' WHERE id = ?").run(cook);

  // Settling twice changes nothing: the first settlement stands.
  D.settleShift(sent);
  assert.strictEqual(payOn('2026-06-02', cook).wage, 6000);
});

test('somebody settled as salaried stays salaried on that service', () => {
  const mgr = mkEmp('Settle Salaried', 0);
  db.prepare("UPDATE employees SET pay_type = 'salary' WHERE id = ?").run(mgr);
  const sh = mkShift('2026-06-09', 'emailed');
  work(sh, mgr, 8);
  D.settleShift(sh);
  db.prepare("UPDATE employees SET pay_type = 'hourly', hourly_rate_cents = 2000 WHERE id = ?").run(mgr);
  assert.strictEqual(payOn('2026-06-09', mgr).wage, 0,
    'made hourly later, the night they worked on salary still carries no hourly wage');
});

test('a sent pay period keeps the overtime rule it went out under', () => {
  const was = OT.rule();
  try {
    OT.saveRule({ enabled: true, threshold: 40, multiplier: 1.5 });
    const emp = mkEmp('Settle Overtime', 2000);
    const start = '2026-07-06';
    for (let d = 0; d < 5; d += 1) work(mkShift(addDays(start, d), 'emailed'), emp, 10);   // 50h in week 1
    const end = addDays(start, 13);
    const before = aggregatePayroll(start, end).rows.find((r) => r.employeeId === emp);
    assert.ok(before.otPay > 0, 'there is overtime on the period');

    PER.markSent(start, end, 1);
    PER.stampOvertime(start, OT.rule(), [...OT.exemptSet()]);

    OT.saveRule({ enabled: false });
    assert.strictEqual(aggregatePayroll(start, end).rows.find((r) => r.employeeId === emp).otPay, before.otPay,
      'turning overtime off later does not take it back from a period already sent');
    OT.saveRule({ enabled: true, threshold: 40, multiplier: 1.5 });
    OT.setExempt(emp, true);
    assert.strictEqual(aggregatePayroll(start, end).rows.find((r) => r.employeeId === emp).otPay, before.otPay,
      'nor does making them exempt');

    // Sent again, it keeps the rule it FIRST went out under.
    PER.stampOvertime(start, { enabled: false }, []);
    assert.strictEqual(aggregatePayroll(start, end).rows.find((r) => r.employeeId === emp).otPay, before.otPay);
    OT.setExempt(emp, false);
  } finally {
    OT.saveRule(was);
  }
});
