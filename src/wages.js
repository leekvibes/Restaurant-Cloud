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

/**
 * A wage can also be specific to ONE SCHEDULE.
 *
 * Somebody can serve at Day for one rate and at Evening for another, which the
 * app could not say before: a wage was (person, role) and nothing else, so six
 * people already working the same role in both services were all paid one rate
 * whichever service they worked.
 *
 * NULL means "any schedule", which is what every existing row is — so adding
 * this column changed no wage anywhere. A row naming a schedule outranks one
 * that does not, on the same specificity principle the role already follows.
 *
 * It lives here rather than on employee_roles because that table's primary key
 * is (employee_id, role) and SQLite cannot alter a primary key — widening it
 * means rebuilding the table every payroll figure is read through, which is not
 * a thing to do for a feature that can be added beside it.
 */
try {
  const cols = db.prepare('PRAGMA table_info(wage_history)').all().map((c) => c.name);
  if (!cols.includes('service_slug')) {
    db.exec('ALTER TABLE wage_history ADD COLUMN service_slug TEXT');
  }
} catch { /* table is created above; a failure here means an older engine */ }

// One wage per person per position per SCHEDULE per DAY. A second change on the
// same day is a correction of the first, not a second raise — without this the
// resolver would have to break a tie between two rows equally in force, and
// "whichever was inserted last" is not a rule anybody could predict.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS wage_history_one_per_day_svc
    ON wage_history (employee_id, IFNULL(role, ''), IFNULL(service_slug, ''), effective_from);
`);
// The old index keyed without the schedule, so it would refuse a Day rate and
// an Evening rate for the same role on the same day — exactly what this is for.
try { db.exec('DROP INDEX IF EXISTS wage_history_one_per_day'); } catch { /* never existed */ }

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
     AND (service_slug = @svc OR service_slug IS NULL)
     AND effective_from <= @on
   ORDER BY (role IS NULL) ASC, (service_slug IS NULL) ASC, effective_from DESC
   LIMIT 1`);

/**
 * The wage in force for one person, in one position, on one schedule, on a date.
 *
 * MOST SPECIFIC WINS, then most recent — and the order of those two matters.
 * A rate set for "server at Evening" beats one set for "server anywhere",
 * however old it is, because the more specific row is a statement about
 * exactly this situation and the general one is a fallback. Reversing them
 * would mean a routine raise to the general rate silently overrode a
 * deliberate Evening rate, which is the kind of wrong nobody notices until a
 * payslip.
 */
function wageOn(employeeId, role, onDate, service) {
  if (!employeeId || !onDate) return 0;
  const row = stmtOn.get({
    employee_id: employeeId, role: role || null, svc: service || null, on: onDate,
  });
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
const wageOnSql = (dateExpr, svcExpr) => `(
  SELECT wh.wage_cents FROM wage_history wh
   WHERE wh.employee_id = w.employee_id
     AND (wh.role = w.role OR wh.role IS NULL)
     AND (wh.service_slug = ${svcExpr || 'NULL'} OR wh.service_slug IS NULL)
     AND wh.effective_from <= ${dateExpr}
   ORDER BY (wh.role IS NULL) ASC, (wh.service_slug IS NULL) ASC, wh.effective_from DESC
   LIMIT 1)`;

/**
 * Record a wage as starting on a date.
 *
 * Does NOT touch `employees` or `employee_roles` — the caller owns the current
 * wage, because only the caller knows whether this change starts today (so the
 * current wage moves with it) or on some future Monday (so it does not, yet).
 */
const insWage = db.prepare(`INSERT INTO wage_history
  (employee_id, role, service_slug, wage_cents, effective_from, created_by, note)
  VALUES (@employee_id, @role, @service_slug, @wage_cents, @effective_from, @created_by, @note)
  ON CONFLICT (employee_id, IFNULL(role, ''), IFNULL(service_slug, ''), effective_from)
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
    // NULL means every schedule, which is what a wage meant before schedules
    // could carry their own.
    service_slug: opts.service || null,
    wage_cents: Math.max(0, Math.round(Number(wageCents) || 0)),
    effective_from: effectiveFrom,
    created_by: opts.by || null,
    note: opts.note || null,
  });
}

/** Every dated change for one person, newest first — for showing the history. */
function historyFor(employeeId) {
  return db.prepare(`SELECT * FROM wage_history WHERE employee_id = ?
    ORDER BY effective_from DESC, IFNULL(role, '') ASC, IFNULL(service_slug, '') ASC`).all(employeeId);
}

/**
 * What somebody earns right now, per role and schedule — for showing a table
 * of what is actually in force rather than a list of changes.
 */
function currentFor(employeeId, onDate) {
  const rows = db.prepare(`SELECT role, service_slug, wage_cents, effective_from
    FROM wage_history WHERE employee_id = ? AND effective_from <= ?
    ORDER BY effective_from DESC`).all(employeeId, onDate);
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.role || ''}|${r.service_slug || ''}`;
    if (!seen.has(k)) seen.set(k, r);      // rows are newest-first, so the first wins
  }
  return [...seen.values()];
}

/**
 * Remove a schedule-specific rate, leaving the general one alone.
 *
 * History is not rewritten: shifts already worked keep whatever they were
 * priced at, and only shifts from here on fall back to the general wage. That
 * is the same rule every other wage change follows.
 */
function dropServiceWage(employeeId, role, service) {
  if (!service) throw new Error('That would remove the general wage, not a schedule rate.');
  return db.prepare(`DELETE FROM wage_history
    WHERE employee_id = ? AND IFNULL(role, '') = ? AND service_slug = ?
      AND effective_from >= ?`)
    .run(employeeId, role || '', service, EPOCH).changes;
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
  EPOCH, seedFromCurrent, wageOn, wageOnSql, setWage, historyFor, currentFor, dropServiceWage, restamp, countAffected,
};
