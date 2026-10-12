'use strict';

// Salaried labour, counted.
//
// ZWIN left salaried people out of every cost figure it produced: metrics.js
// dropped their work rows from wages, so Labor % and Prime Cost on Performance
// were hourly-only numbers presented as whole ones, and the Employment tab said
// so in as many words. For a restaurant with one salaried manager that is a
// five-figure hole in a year of ratios, found the week an accountant asked.
//
// What is tested here is the arithmetic an accountant would check by hand: a
// salary is charged from the day it started and not a day earlier, a raise
// splits the range at its own date, ending one stops it, and the figures each
// page shows add up to the figure beside them. The last test is the one that
// matters most — nothing changes at all until somebody records a start date,
// because the alternative was to invent one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sal-'));
process.env.DB_PATH = path.join(dir, 'salary.db');
process.env.TZ = process.env.TZ || 'America/New_York';

const { db } = require('../src/db');
const SALARY = require('../src/salary');
const MX = require('../src/metrics');

const EMP = { boss: 901, cook: 902 };
const PERIOD = 14;                       // days in a pay period, the app's default
const SALARY_CENTS = 280000;             // $2,800 a period
const PER_DAY = SALARY_CENTS / PERIOD;   // $200 a day

test.before(() => {
  const ins = db.prepare(`INSERT INTO employees (id, name, role, hourly_rate_cents, active, pay_type, salary_cents)
    VALUES (?, ?, ?, ?, 1, ?, ?)`);
  ins.run(EMP.boss, 'Jimmy Salaried', 'manager', 0, 'salary', SALARY_CENTS);
  ins.run(EMP.cook, 'Hourly Hank', 'cook', 2000, 'hourly', 0);
  // One service a day for a fortnight, with sales and one hourly cook on it.
  const sh = db.prepare(`INSERT INTO shifts (date, daypart, status, total_food_cents, created_at)
    VALUES (?, 'dinner', 'emailed', 100000, datetime('now'))`);
  const work = db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)');
  for (let d = 1; d <= 14; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    const id = Number(sh.run(date).lastInsertRowid);
    work.run(id, EMP.cook, 'cook', 5);           // 5h × $20 = $100 a day
    work.run(id, EMP.boss, 'manager', 8);        // salaried: no hourly cost
  }
});

test.after(() => { try { db.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); });

const period = () => MX.period('2026-09-01', '2026-09-14');

test('with no start date on record, nothing changes and the gap is named', () => {
  // The whole safety of this feature. Jimmy is salaried, with an amount on his
  // record — and until somebody says when it started, he costs nothing here,
  // because the only other option is to guess a date and put it in a report.
  const p = period();
  assert.strictEqual(p.salary, 0, 'no salary is charged');
  assert.strictEqual(p.labor, p.wages, 'labour is exactly what it was before');
  assert.strictEqual(p.wages, 140000, '14 days × 5h × $20 of hourly cook');
  assert.strictEqual(p.laborPct, 10, '$1,400 of $14,000');
  // And it is DISCLOSED, rather than read as a zero.
  assert.deepStrictEqual(p.salaryUndated.map((u) => u.name), ['Jimmy Salaried']);
});

test('a salary is charged from the day it starts, and not a day earlier', () => {
  // Backdated to the 8th: seven days of the fortnight, not fourteen.
  SALARY.setSalary({ employeeId: EMP.boss, cents: SALARY_CENTS, from: '2026-09-08', by: 'test' });
  const p = period();
  assert.strictEqual(p.salary, PER_DAY * 7, 'seven days at $200');
  assert.strictEqual(p.labor, 140000 + PER_DAY * 7, 'labour is hourly plus salary');
  assert.strictEqual(p.wages, 140000, 'and hourly wages are untouched by it');
  assert.strictEqual(p.salaryUndated.length, 0, 'nothing is missing any more');
  assert.deepStrictEqual(p.salaryPeople.map((x) => [x.name, x.cents]), [['Jimmy Salaried', PER_DAY * 7]],
    'and the total says whose it is');
});

test('the percentages are the ones an accountant would get', () => {
  const p = period();
  // $14,000 sales; $1,400 hourly + $1,400 salary = $2,800 labour.
  assert.strictEqual(p.sales, 1400000);
  assert.strictEqual(p.labor, 280000);
  assert.strictEqual(p.laborPct, 20, 'was 10% while half of labour was missing');
  assert.strictEqual(p.grossProfit, 1400000 - 280000, 'profit is after ALL of labour');
});

test('a raise splits the range at its own date', () => {
  // Doubled from the 11th: 3 days at $200, then 4 at $400.
  SALARY.setSalary({ employeeId: EMP.boss, cents: SALARY_CENTS * 2, from: '2026-09-11', by: 'test' });
  assert.strictEqual(period().salary, PER_DAY * 3 + PER_DAY * 2 * 4);
  // And the earlier month it was never in force in stays empty.
  assert.strictEqual(MX.period('2026-08-01', '2026-08-31').salary, 0, 'August never had him');
  SALARY.setSalary({ employeeId: EMP.boss, cents: SALARY_CENTS, from: '2026-09-11', by: 'test' });
  assert.strictEqual(period().salary, PER_DAY * 7, 'a correction on the same day replaces it');
});

test('ending a salary stops the charge, and the days before it keep theirs', () => {
  SALARY.setSalary({ employeeId: EMP.boss, cents: 0, from: '2026-09-12', by: 'test', note: 'left' });
  assert.strictEqual(period().salary, PER_DAY * 4, 'the 8th to the 11th only');
  // A range entirely after they left costs nothing.
  assert.strictEqual(MX.period('2026-09-13', '2026-09-14').salary, 0);
  SALARY.setSalary({ employeeId: EMP.boss, cents: SALARY_CENTS, from: '2026-09-12', by: 'test' });
  assert.strictEqual(period().salary, PER_DAY * 7, 'put back for the rest of the file');
});

test('the daily series carries it too, so the charts agree with the tiles', () => {
  const days = MX.days('2026-09-01', '2026-09-14');
  assert.strictEqual(days.length, 14);
  assert.strictEqual(days[0].salary, 0, 'the 1st is before it started');
  assert.strictEqual(days[7].salary, PER_DAY, 'the 8th is the first day charged');
  assert.strictEqual(days[7].labor, days[7].wages + PER_DAY);
  const summed = days.reduce((a, d) => a + d.salary, 0);
  assert.strictEqual(summed, period().salary, 'the days add up to the period');
});

test('a salary is not charged to a service', () => {
  // The per-service figure is hourly cost and has to stay that way: a salary
  // belongs to a fortnight, not to Tuesday dinner, and spreading it over
  // services would invent a cost for each one — and make the same salary look
  // different in a busy fortnight than a quiet one.
  const p = period();
  for (const row of p.rows) {
    assert.strictEqual(row.wages, 10000, 'every service costs its $100 of cook, and nothing else');
  }
  assert.strictEqual(p.rows.reduce((a, r) => a + r.wages, 0), p.wages,
    'the services still add up to hourly wages exactly');
});

test('somebody moved off salary still cost one while they were on it', () => {
  // The lookup is the dated history, never today's pay type — otherwise a
  // manager moved onto an hourly rate in October would empty out September.
  db.prepare("UPDATE employees SET pay_type = 'hourly', salary_cents = 0 WHERE id = ?").run(EMP.boss);
  assert.strictEqual(period().salary, PER_DAY * 7, 'September is unchanged by an October decision');
  db.prepare("UPDATE employees SET pay_type = 'salary', salary_cents = ? WHERE id = ?")
    .run(SALARY_CENTS, EMP.boss);
});

test('the money is whole cents, however the arithmetic falls', () => {
  // $1,000 a period over 14 days is 7142.857… cents a day. Nothing may hand a
  // fraction of a cent to a figure that gets printed as money.
  SALARY.setSalary({ employeeId: EMP.cook, cents: 100000, from: '2026-09-01', by: 'test' });
  const p = period();
  assert.ok(Number.isInteger(p.salary), `salary came out as ${p.salary}`);
  assert.ok(Number.isInteger(p.labor) && Number.isInteger(p.grossProfit));
  for (const x of p.salaryPeople) assert.ok(Number.isInteger(x.cents), `${x.name}: ${x.cents}`);
  assert.strictEqual(SALARY.costFor(EMP.cook, '2026-09-01', '2026-09-14'), 100000,
    'a whole pay period of it is the amount itself, exactly');
  SALARY.setSalary({ employeeId: EMP.cook, cents: 0, from: '2026-09-01', by: 'test' });
});

test('a dated amount whose person is gone charges nothing', () => {
  // Deleting somebody is rare — the app deactivates instead — but a salary row
  // left behind by one would otherwise cost the business money every month
  // forever, against a name no page could print. Found by accident: a scratch
  // database showed $6,399 of salary belonging to "#356", who did not exist.
  const ghost = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pay_type, salary_cents)
    VALUES ('Gone Greg', 'manager', 0, 1, 'salary', 280000)`).run().lastInsertRowid);
  SALARY.setSalary({ employeeId: ghost, cents: 280000, from: '2026-09-01', by: 'test' });
  const withThem = period().salary;
  assert.ok(withThem > PER_DAY * 7, 'they cost something while they exist');
  db.prepare('DELETE FROM employees WHERE id = ?').run(ghost);
  assert.strictEqual(period().salary, PER_DAY * 7, 'and nothing once the person is gone');
  assert.ok(!period().salaryPeople.some((x) => /^#/.test(x.name)), 'nothing is charged to a number');
  db.prepare('DELETE FROM salary_history WHERE employee_id = ?').run(ghost);
});
