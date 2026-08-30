'use strict';

/**
 * WAGES OVER TIME.
 *
 * A wage used to be one number per person, per position — so raising it
 * restated every shift that person had ever worked. Promote a cook to kitchen
 * lead on the 20th and the payroll page said you owed them lead money for the
 * whole month, back to the day they started.
 *
 * This is the same fix the tip-out already has. `shifts.policy_id` pins the
 * policy version a service was closed under so changing the rules can never
 * restate what somebody was already paid; a wage now carries the date it
 * started, and a shift is priced against the wage that was in force on the day
 * it was worked.
 *
 * WHAT THIS MODULE IS NOT: it is not the current wage. `employees
 * .hourly_rate_cents` and `employee_roles.wage_cents` stay exactly where they
 * are and keep meaning "what they earn now" — every screen that asks that
 * question is unchanged. This adds the history behind those numbers, and one
 * rule for reading it.
 *
 * THE ORDER, which is the whole contract:
 *
 *   1. `work.hourly_rate_cents`, if set. A rate recorded on a shift is what
 *      was actually paid for it. Nothing here overrules that — not a raise,
 *      not a correction. The only thing that changes it is somebody choosing
 *      "apply to all past shifts" and meaning it.
 *   2. The wage in force on the shift's BUSINESS DATE, most specific first:
 *      the one set for the position worked, else the person's default.
 *   3. The current wage, as a fallback, so a row this module has never seen
 *      still prices the way it did before.
 *
 * Seeded so that day one changes nothing: every wage that exists when this
 * first runs is written into history as having been in force since the
 * beginning, which makes every historical lookup return exactly what it
 * returned yesterday. Behaviour only starts to differ when somebody makes a
 * DATED change after that.
 */

const { db } = require('./db');

// Far enough back that it precedes any shift in any database, and readable in
// a table dump as "since forever" rather than as a real date somebody chose.
const EPOCH = '0001-01-01';

db.exec(`
  CREATE TABLE IF NOT EXISTS wage_history (
    id             INTEGER PRIMARY KEY,
    employee_id    INTEGER NOT NULL,
    role           TEXT,
    wage_cents     INTEGER NOT NULL,
    effective_from TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_by     TEXT,
    note           TEXT
  );
  CREATE INDEX IF NOT EXISTS wage_history_lookup
    ON wage_history (employee_id, effective_from);
`);

// One wage per person per position per DAY. A second change on the same day is
// a correction of the first, not a second raise — without this the resolver
// would have to break a tie between two rows that are equally in force, and
// "whichever was inserted last" is not a rule anybody could predict.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS wage_history_one_per_day
    ON wage_history (employee_id, IFNULL(role, ''), effective_from);
`);

/**
 * Write today's wages into history as having always applied.
 *
 * Runs once, and only into an empty table: re-running it after somebody has
 * made a dated change would stamp the CURRENT wage back at the beginning of
 * time and undo exactly the history this module exists to keep.
 */
function seedFromCurrent() {
  const already = db.prepare('SELECT COUNT(*) n FROM wage_history').get().n;
  if (already) return { seeded: 0, skipped: true };

  const ins = db.prepare(`INSERT OR IGNORE INTO wage_history
    (employee_id, role, wage_cents, effective_from, created_by, note)
    VALUES (?, ?, ?, ?, 'migration', 'wage on file when dated wages were added')`);

  let seeded = 0;
  db.transaction(() => {
    // Zero means "not set" everywhere else in this app, so it is not history —
    // seeding it would turn "nobody has said" into "they earned nothing".
    for (const r of db.prepare(
      'SELECT id, hourly_rate_cents FROM employees WHERE COALESCE(hourly_rate_cents, 0) > 0').all()) {
      seeded += ins.run(r.id, null, r.hourly_rate_cents, EPOCH).changes;
    }
    for (const r of db.prepare(
      'SELECT employee_id, role, wage_cents FROM employee_roles WHERE COALESCE(wage_cents, 0) > 0').all()) {
      seeded += ins.run(r.employee_id, r.role, r.wage_cents, EPOCH).changes;
    }
  })();
  return { seeded, skipped: false };
}

/**
 * The wage in force for one person, in one position, on one date.
 *
 * Specificity beats recency, matching the rule the rest of the app already
 * follows: a wage set for the position always outranks the person's default,
 * however old it is. A cook who has been on file as a busser at $11 since 2019
 * is paid $11 for a busser shift even if their default rate rose last week —
 * because that default is what they earn as a cook.
 *
 * Returns 0 for "nothing on file", which every caller already treats as a
 * reason to fall through rather than as a rate of nothing.
 */
const stmtOn = db.prepare(`
  SELECT wage_cents FROM wage_history
   WHERE employee_id = @employee_id
     AND (role = @role OR role IS NULL)
     AND effective_from <= @on
   ORDER BY (role IS NULL) ASC, effective_from DESC
   LIMIT 1`);

function wageOn(employeeId, role, onDate) {
  if (!employeeId || !onDate) return 0;
  const row = stmtOn.get({ employee_id: employeeId, role: role || null, on: onDate });
  return row ? row.wage_cents : 0;
}

/**
 * The same rule as SQL, for the queries that price hundreds of shifts at once.
 *
 * `dateExpr` is the caller's own business-date column — passed in rather than
 * assumed, because getting it wrong prices a shift against the wrong day's
 * wage and nothing on screen would look wrong. Expects `w` (work) in scope.
 *
 * test/engine.test.js pins this against wageOn() so the two cannot drift.
 */
const wageOnSql = (dateExpr) => `(
  SELECT wh.wage_cents FROM wage_history wh
   WHERE wh.employee_id = w.employee_id
     AND (wh.role = w.role OR wh.role IS NULL)
     AND wh.effective_from <= ${dateExpr}
   ORDER BY (wh.role IS NULL) ASC, wh.effective_from DESC
   LIMIT 1)`;

/**
 * Record a wage as starting on a date.
 *
 * Does NOT touch `employees` or `employee_roles` — the caller owns the current
 * wage, because only the caller knows whether this change starts today (so the
 * current wage moves with it) or on some future Monday (so it does not, yet).
 */
const insWage = db.prepare(`INSERT INTO wage_history
  (employee_id, role, wage_cents, effective_from, created_by, note)
  VALUES (@employee_id, @role, @wage_cents, @effective_from, @created_by, @note)
  ON CONFLICT (employee_id, IFNULL(role, ''), effective_from)
  DO UPDATE SET wage_cents = excluded.wage_cents,
                created_by = excluded.created_by,
                note       = excluded.note`);

function setWage(employeeId, role, wageCents, effectiveFrom, opts = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveFrom))) {
    throw new Error('A wage change needs a date it starts on.');
  }
  insWage.run({
    employee_id: employeeId,
    role: role || null,
    wage_cents: Math.max(0, Math.round(Number(wageCents) || 0)),
    effective_from: effectiveFrom,
    created_by: opts.by || null,
    note: opts.note || null,
  });
}

/** Every dated change for one person, newest first — for showing the history. */
function historyFor(employeeId) {
  return db.prepare(`SELECT * FROM wage_history WHERE employee_id = ?
    ORDER BY effective_from DESC, IFNULL(role, '') ASC`).all(employeeId);
}

/**
 * Rewrite the rate recorded on already-worked shifts.
 *
 * This is the ONE thing that overrules a recorded rate, and it exists because
 * a wage that was simply typed wrong should be correctable everywhere rather
 * than leaving a trail of shifts priced from a typo. It is never automatic:
 * a manager has to choose it, having been told what it will change.
 *
 * Scoped to the role as well as the person, so correcting a busser rate does
 * not silently restate the same person's server shifts.
 */
function restamp(employeeId, role, wageCents, fromDate, toDate) {
  const res = db.prepare(`UPDATE work SET hourly_rate_cents = @cents
     WHERE employee_id = @id
       AND (@role IS NULL OR role = @role)
       AND shift_id IN (SELECT id FROM shifts WHERE date >= @from AND date <= @to)`)
    .run({
      id: employeeId, role: role || null, cents: Math.max(0, Math.round(Number(wageCents) || 0)),
      from: fromDate, to: toDate,
    });
  return res.changes;
}

/** How many worked shifts "apply to all past" would rewrite — asked BEFORE. */
function countAffected(employeeId, role, fromDate, toDate) {
  return db.prepare(`SELECT COUNT(*) n FROM work
     WHERE employee_id = @id
       AND (@role IS NULL OR role = @role)
       AND shift_id IN (SELECT id FROM shifts WHERE date >= @from AND date <= @to)`)
    .get({ id: employeeId, role: role || null, from: fromDate, to: toDate }).n;
}

// NOT seeded on load. Importing a module should not write to a database: this
// did, and the first thing it did was write eighteen rows into the developer's
// own data.db from three test files that merely reach this module through
// another one. A migration is a boot step, and server.js calls it as one.
//
// Nothing breaks if it has not run: every resolver falls through to the wage
// on file, which is exactly what it did before this module existed.

module.exports = {
  EPOCH, seedFromCurrent, wageOn, wageOnSql, setWage, historyFor, restamp, countAffected,
};
