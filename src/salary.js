'use strict';

/**
 * SALARY AS A COST, OVER TIME.
 *
 * A salaried person had an amount on their record and nothing else: no date it
 * started, no history behind it. That was enough for "what does Jimmy earn",
 * which is the only question the staff page asked — and not enough for any
 * question with a date in it, which is every question a report asks.
 *
 * So salaried labour was simply left out of cost. `metrics.js` dropped their
 * work rows from wages, the Employment tab said so in as many words, and Labor
 * % and Prime Cost were therefore hourly-only figures presented as whole ones.
 * Over thirty days that is the difference between a ratio you can hand an
 * accountant and one you have to explain.
 *
 * This is the same fix `wages.js` is for hourly pay, and deliberately the same
 * shape: an amount carries the date it started, a report asks what was in force
 * on each day it covers, and changing the amount today cannot restate a month
 * that has already been reported.
 *
 * WHAT IT IS NOT: it is not what anybody is PAID. Nothing here writes a
 * paycheck, reaches payroll, or appears in a staff member's own portal. Salary
 * is paid where it has always been paid. This records what it COSTS the
 * business and when, so the ratios are true.
 *
 * THE AMOUNT IS PER PAY PERIOD, because that is what the staff page has always
 * meant by it ("Per pay period, as payroll runs it"), and reusing the number
 * the owner already types beats inventing a second one that can disagree with
 * it. A day costs `amount / days in a pay period`, and a range costs the sum
 * over its days. Fourteen-day periods, from the payroll setting, so the two
 * cannot drift apart.
 *
 * NOT SEEDED. `wages.js` writes every existing wage into history as having
 * applied since the beginning of time, which is right there: those wages were
 * already being charged to every past shift, so seeding changes nothing. Here
 * the opposite is true — salary has never been counted — so seeding would
 * invent a cost for every day in the database, back to the first one, out of a
 * number typed today. Nobody can audit that. A salary therefore costs nothing
 * until somebody says when it started, and the reports say plainly when
 * somebody is missing that date rather than quietly reading zero as a fact.
 */

const { db } = require('./db');
const PERIODS = require('./periods');

db.exec(`
  CREATE TABLE IF NOT EXISTS salary_history (
    id             INTEGER PRIMARY KEY,
    employee_id    INTEGER NOT NULL,
    cents          INTEGER NOT NULL,
    effective_from TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_by     TEXT,
    note           TEXT
  );
  CREATE INDEX IF NOT EXISTS salary_history_lookup
    ON salary_history (employee_id, effective_from);
`);

// One amount per person per day. A second change on the same day is a
// correction of the first, not a second raise — the same rule wage_history
// follows, and for the same reason: otherwise two rows are equally in force and
// "whichever was inserted last" is not a rule anybody could predict.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS salary_history_one_per_day
    ON salary_history (employee_id, effective_from);
`);

const Q = {
  on: db.prepare(`SELECT cents FROM salary_history
    WHERE employee_id = ? AND effective_from <= ?
    ORDER BY effective_from DESC, id DESC LIMIT 1`),
  set: db.prepare(`INSERT INTO salary_history (employee_id, cents, effective_from, created_by, note)
    VALUES (@employeeId, @cents, @from, @by, @note)
    ON CONFLICT(employee_id, effective_from)
      DO UPDATE SET cents = excluded.cents, created_by = excluded.created_by,
                    note = excluded.note, created_at = datetime('now')`),
  history: db.prepare(`SELECT * FROM salary_history WHERE employee_id = ?
    ORDER BY effective_from DESC, id DESC`),
  del: db.prepare('DELETE FROM salary_history WHERE id = ? AND employee_id = ?'),
  // Everybody who has ever had a salary recorded, whatever they are paid now:
  // somebody moved off salary in March still cost the business a salary in
  // February, and a report covering February has to say so.
  everHad: db.prepare('SELECT DISTINCT employee_id FROM salary_history'),
  rowsFor: db.prepare(`SELECT cents, effective_from FROM salary_history
    WHERE employee_id = ? ORDER BY effective_from, id`),
  // Salaried right now with nothing on record — the state the reports have to
  // disclose rather than read as zero.
  undated: db.prepare(`SELECT e.id, e.name, e.salary_cents FROM employees e
    WHERE COALESCE(e.pay_type, 'hourly') = 'salary' AND COALESCE(e.salary_cents, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM salary_history h WHERE h.employee_id = e.id)
    ORDER BY e.name`),
};

/** Days in a pay period, from the payroll setting. Never zero. */
const periodDays = () => Math.max(1, Number(PERIODS.periodLength()) || 14);

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const dayCount = (from, to) => Math.round(
  (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;

/**
 * What one person's salary was, per pay period, on one date.
 *
 * 0 means "nothing on record then" — which every caller treats as a reason not
 * to charge anything, never as a salary of nothing.
 */
function salaryOn(employeeId, date) {
  if (!employeeId || !isDate(date)) return 0;
  const row = Q.on.get(Number(employeeId), date);
  return row ? Number(row.cents) || 0 : 0;
}

/**
 * Record what somebody's salary is, and the day it started.
 *
 * `cents` of 0 is meaningful and is the way a salary ENDS: somebody who leaves,
 * or moves onto an hourly rate, costs nothing from that date on, and the row
 * saying so is what stops the accrual. Deleting rows is for correcting a
 * mistake, not for ending a salary.
 */
function setSalary({ employeeId, cents, from, by = null, note = null }) {
  if (!employeeId || !isDate(from)) return null;
  Q.set.run({ employeeId: Number(employeeId), cents: Math.max(0, Math.round(Number(cents) || 0)),
    from, by, note });
  return { employeeId: Number(employeeId), cents, from };
}

/** Every dated amount for one person, newest first. */
const historyFor = (employeeId) => Q.history.all(Number(employeeId));

/** Remove one dated amount. Correcting a typo, not ending a salary. */
const dropEntry = (id, employeeId) => Q.del.run(Number(id), Number(employeeId)).changes > 0;

/**
 * What one person's salary cost between two dates, inclusive.
 *
 * Walks their dated amounts and charges each day at the rate in force that day,
 * so a raise mid-range costs the old amount up to it and the new one after.
 * Rounded ONCE, at the end: rounding a daily figure and multiplying it by
 * ninety turns a rounding error into a visible number.
 */
function costFor(employeeId, from, to) {
  if (!isDate(from) || !isDate(to) || from > to) return 0;
  const rows = Q.rowsFor.all(Number(employeeId));
  if (!rows.length) return 0;
  const perDay = periodDays();
  let cents = 0;
  for (let i = 0; i < rows.length; i++) {
    const amount = Number(rows[i].cents) || 0;
    if (!amount) continue;
    // This amount applies from its own date until the next one starts.
    const segFrom = rows[i].effective_from > from ? rows[i].effective_from : from;
    const next = rows[i + 1] ? rows[i + 1].effective_from : null;
    const segTo = next && next <= to ? addDay(next, -1) : to;
    if (segFrom > segTo) continue;
    cents += (amount * dayCount(segFrom, segTo)) / perDay;
  }
  return Math.round(cents);
}

/** One day either side of an ISO date, without pulling in the dates module. */
function addDay(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Salaried cost for a whole range: the total, who it belongs to, and who is
 * missing from it.
 *
 * `undated` is the honest part. Somebody salaried with no start date on record
 * contributes nothing — the alternative is to guess a date, and a guessed date
 * in a cost report is worse than a gap that says it is one.
 */
function costBetween(from, to) {
  if (!isDate(from) || !isDate(to) || from > to) {
    return { cents: 0, people: [], undated: [], perPeriodDays: periodDays() };
  }
  const people = [];
  for (const { employee_id: id } of Q.everHad.all()) {
    const cents = costFor(id, from, to);
    if (cents > 0) {
      const who = db.prepare('SELECT name FROM employees WHERE id = ?').get(id);
      people.push({ employeeId: id, name: who ? who.name : `#${id}`, cents });
    }
  }
  people.sort((a, b) => b.cents - a.cents);
  return {
    cents: people.reduce((a, p) => a + p.cents, 0),
    people,
    undated: Q.undated.all().map((r) => ({ employeeId: r.id, name: r.name, salaryCents: r.salary_cents })),
    perPeriodDays: periodDays(),
  };
}

/**
 * Salaried cost per calendar day across a range, as a Map of date → cents.
 *
 * One pass over the dated amounts rather than a lookup per person per day: the
 * charts ask for ninety days at a time, and asking the database ninety times
 * for an answer that never changes mid-range is how a page gets slow quietly.
 */
function dailyBetween(from, to) {
  const out = new Map();
  if (!isDate(from) || !isDate(to) || from > to) return out;
  const perDay = periodDays();
  const people = Q.everHad.all().map(({ employee_id: id }) => Q.rowsFor.all(id));
  for (let d = from, guard = 0; d <= to && guard <= 3660; d = addDay(d, 1), guard++) {
    let cents = 0;
    for (const rows of people) {
      // The last amount that had started by this day.
      let amount = 0;
      for (const r of rows) { if (r.effective_from <= d) amount = Number(r.cents) || 0; else break; }
      cents += amount / perDay;
    }
    out.set(d, Math.round(cents));
  }
  return out;
}

module.exports = { salaryOn, setSalary, historyFor, dropEntry, costFor, costBetween, dailyBetween, periodDays };
