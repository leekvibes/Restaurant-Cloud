'use strict';

/**
 * SERVICES — what the owner calls "Day Service" and "Evening Service".
 *
 * A service was already the spine of this app: `shifts` is UNIQUE(date,
 * daypart), and work, server_sales and tip_submissions all name their service
 * by pointing at a shift rather than by describing one themselves. So there is
 * already exactly one answer to "which service is this", and nothing here
 * introduces a second.
 *
 * This module adds two things on top of that spine:
 *
 *   1. NAMES. `daypart` keeps its stored values — 'cafe' and 'dinner' — and
 *      becomes a key into a row that carries a display name the owner chooses.
 *      That is why this is a slug table and not a new `service_id` column:
 *      306 places read daypart, only 28 hardcode the two literals, and leaving
 *      the values alone means the other 278 keep working with no migration, no
 *      dual-write window, and no chance of a half-moved payroll figure.
 *      See docs/ZWIN-SERVICES-AUDIT.md.
 *
 *   2. MEMBERSHIP. Which services a person works, relationally, so somebody
 *      can be on one, both, or a third we add later.
 *
 * UNTICKED MEANS NOWHERE — once somebody has been set up. That is the owner's
 * rule, and it is what makes the checkboxes mean anything: take a person off
 * Evening and they are off Evening, on the board and at the clock.
 *
 * But "nobody has decided yet" is a different fact from "decided: none", and
 * conflating them is how a new hire ends up unable to clock in anywhere on
 * their first shift while their manager wonders what is broken. So the two are
 * stored apart: `employees.svc_set` records that a human has been through this
 * form, and until they have, the person is on every schedule.
 *
 * The result reads the way somebody would expect it to:
 *   new employee, never touched  -> on every schedule, can work
 *   ticked Day only              -> Day only
 *   ticked nothing at all        -> nowhere, deliberately
 *   NEW SCHEDULE                 -> starts empty of the already-set-up; they
 *                                   appear as unticked boxes to be added
 */

const { db } = require('./db');

// The two that have always existed. Kept as a constant so a reader still works
// if the table has somehow not been seeded — a schedule that renders nothing
// because a migration did not run is worse than one showing the old names.
const BUILT_IN = [
  { slug: 'cafe', name: 'Day Service', sort: 1, active: 1, starts_min: null, ends_min: null },
  { slug: 'dinner', name: 'Evening Service', sort: 2, active: 1, starts_min: null, ends_min: null },
];

db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort        INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1,
    starts_min  INTEGER,
    ends_min    INTEGER,
    -- NULL everywhere today. Present so that a second location later is a
    -- backfill rather than a table rewrite; see ZWIN-MULTI-TENANCY.md.
    location_id INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT
  );

  CREATE TABLE IF NOT EXISTS employee_services (
    employee_id  INTEGER NOT NULL,
    service_slug TEXT    NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(employee_id, service_slug)
  );
  CREATE INDEX IF NOT EXISTS employee_services_by_emp
    ON employee_services (employee_id) WHERE active = 1;
`);

/**
 * Write the two built-in services if the table is empty.
 *
 * Called at boot from server.js, never on import. An import that writes reaches
 * into whatever database the importer happened to open — that mistake put
 * eighteen wage rows into the dev database last week.
 */
function seed() {
  const n = db.prepare('SELECT COUNT(*) n FROM services').get().n;
  if (n) return { seeded: 0 };
  const ins = db.prepare(`INSERT OR IGNORE INTO services (slug, name, sort, active)
                          VALUES (@slug, @name, @sort, @active)`);
  let seeded = 0;
  db.transaction(() => { for (const s of BUILT_IN) seeded += ins.run(s).changes; })();
  return { seeded };
}

/** Every service, in the owner's order. Falls back to the built-ins. */
function all(opts = {}) {
  let rows;
  try {
    rows = db.prepare(`SELECT * FROM services ${opts.includeArchived ? '' : 'WHERE active = 1'}
                       ORDER BY sort, slug`).all();
  } catch { rows = []; }
  return rows.length ? rows : BUILT_IN.slice();
}

const bySlug = (slug) => all({ includeArchived: true }).find((s) => s.slug === slug) || null;

/** The display name, falling back to the slug so nothing ever renders blank. */
function nameOf(slug) {
  if (!slug) return '';
  const s = bySlug(slug);
  return s ? s.name : String(slug);
}

/** Is this a service anybody can be scheduled or clocked into right now? */
const isActive = (slug) => all().some((s) => s.slug === slug);

function create({ slug, name, sort, startsMin, endsMin }) {
  const key = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!key) throw new Error('A service needs a short internal key.');
  if (!String(name || '').trim()) throw new Error('A service needs a name.');
  if (bySlug(key)) throw new Error(`There is already a service keyed "${key}".`);
  const next = (db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM services').get().m || 0) + 1;
  db.prepare(`INSERT INTO services (slug, name, sort, active, starts_min, ends_min)
              VALUES (?, ?, ?, 1, ?, ?)`)
    .run(key, String(name).trim(), Number.isFinite(sort) ? sort : next,
      Number.isFinite(startsMin) ? startsMin : null, Number.isFinite(endsMin) ? endsMin : null);
  return bySlug(key);
}

function rename(slug, name) {
  if (!String(name || '').trim()) throw new Error('A service needs a name.');
  db.prepare('UPDATE services SET name = ? WHERE slug = ?').run(String(name).trim(), slug);
}

/**
 * Archive rather than delete, always.
 *
 * A service names history — shifts, policy versions, published schedules, every
 * tip-out ever settled under it. Deleting the row would orphan all of it and
 * leave a payroll page unable to say what a past service was called.
 */
function archive(slug) {
  if (all().length <= 1) throw new Error('There has to be at least one service.');
  db.prepare("UPDATE services SET active = 0, archived_at = datetime('now') WHERE slug = ?").run(slug);
}
function unarchive(slug) {
  db.prepare('UPDATE services SET active = 1, archived_at = NULL WHERE slug = ?').run(slug);
}

// --- who works what ---------------------------------------------------------

// Marks that somebody has actually been through the Services form. Without it
// there is no way to tell "decided: none" from "nobody has looked yet", and
// those two have to behave differently — see the note at the top.
try {
  const cols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
  if (!cols.includes('svc_set')) {
    db.exec('ALTER TABLE employees ADD COLUMN svc_set INTEGER NOT NULL DEFAULT 0');
  }
} catch { /* older engine; forEmployee falls back to every schedule */ }

const qSet = db.prepare('SELECT COALESCE(svc_set, 0) v FROM employees WHERE id = ?');
function wasSetUp(employeeId) {
  try { const r = qSet.get(employeeId); return !!(r && r.v); } catch { return false; }
}

const qMine = db.prepare('SELECT service_slug FROM employee_services WHERE employee_id = ? AND active = 1');

/**
 * The schedules this person is on. No rows means none.
 *
 * Filtered against the live list, so archiving a schedule takes it off
 * everybody without having to touch a membership row.
 */
function forEmployee(employeeId) {
  if (!employeeId) return [];
  // Never set up: on everything, so a new hire can work their first shift.
  if (!wasSetUp(employeeId)) return all().map((x) => x.slug);
  let rows = [];
  try { rows = qMine.all(employeeId).map((r) => r.service_slug); } catch { rows = []; }
  const live = new Set(all().map((s) => s.slug));
  return rows.filter((r) => live.has(r));
}

/** Has a human been through this person's Services form? */
const isAssigned = (employeeId) => wasSetUp(employeeId);

/**
 * THE GATE. Server-side, and the only thing any route should ask.
 *
 * Hiding a button is not authorisation — a POST naming another service has to
 * be refused here, not merely made hard to reach in the browser.
 */
const canWork = (employeeId, slug) => forEmployee(employeeId).includes(slug);

/**
 * Replace somebody's whole list. Every tick is stored, including all of them.
 *
 * An earlier version collapsed "all ticked" to no rows on the reasoning that
 * they mean the same thing. They no longer do: no rows now means none, so
 * collapsing would have silently taken somebody off every schedule at the
 * moment their manager ticked every box.
 */
function setForEmployee(employeeId, slugs) {
  const live = new Set(all().map((s) => s.slug));
  const want = [...new Set((slugs || []).filter((s) => live.has(s)))];
  db.transaction(() => {
    db.prepare('DELETE FROM employee_services WHERE employee_id = ?').run(employeeId);
    const ins = db.prepare(`INSERT OR IGNORE INTO employee_services (employee_id, service_slug)
                            VALUES (?, ?)`);
    for (const s of want) ins.run(employeeId, s);
    // Saving the form IS the decision, including a decision of none. From here
    // on, unticked means nowhere for this person.
    try { db.prepare('UPDATE employees SET svc_set = 1 WHERE id = ?').run(employeeId); } catch { /* older engine */ }
  })();
}

/**
 * No migration is needed, and that is the point of svc_set.
 *
 * Every existing employee has svc_set = 0, so they are on every schedule until
 * somebody says otherwise — nothing empties itself on deploy, and no rows had
 * to be written to make that true. Kept as a named no-op because "why is there
 * no backfill" is a fair question to ask of a change like this.
 */
function backfill() { return { added: 0, skipped: true }; }

/**
 * Everybody on a schedule: those added to it, plus anybody nobody has set up
 * yet. A new hire appears on every board until their manager narrows them,
 * rather than being invisible on the day they start.
 */
function employeesFor(slug) {
  const added = db.prepare(`SELECT es.employee_id FROM employee_services es
                     JOIN employees e ON e.id = es.employee_id
                     WHERE es.service_slug = ? AND es.active = 1 AND e.active = 1`)
    .all(slug).map((r) => r.employee_id);
  let untouched = [];
  try {
    untouched = db.prepare(`SELECT id FROM employees
      WHERE active = 1 AND COALESCE(svc_set, 0) = 0`).all().map((r) => r.id);
  } catch { untouched = []; }
  return [...new Set([...added, ...untouched])];
}

module.exports = {
  BUILT_IN, seed, backfill, all, bySlug, nameOf, isActive, create, rename, archive, unarchive,
  forEmployee, isAssigned, canWork, setForEmployee, employeesFor,
};
