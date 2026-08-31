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
 * NO ROWS MEANS EVERY SERVICE. The same shape Phase 6 uses for availability:
 * absence is not a restriction. It is what keeps the day this ships uneventful
 * — nobody has to be bulk-assigned before the clock works — and it is the
 * owner's stated choice.
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

const qMine = db.prepare('SELECT service_slug FROM employee_services WHERE employee_id = ? AND active = 1');

/**
 * The services this person may work.
 *
 * NO ROWS MEANS EVERY ACTIVE SERVICE. Absence is not a restriction — the same
 * rule availability follows, and the reason nothing breaks the day this ships.
 */
function forEmployee(employeeId) {
  if (!employeeId) return all().map((s) => s.slug);
  let rows = [];
  try { rows = qMine.all(employeeId).map((r) => r.service_slug); } catch { rows = []; }
  if (!rows.length) return all().map((s) => s.slug);
  // Filtered against active services, so archiving one takes it off everybody
  // without having to touch a membership row.
  const live = new Set(all().map((s) => s.slug));
  const kept = rows.filter((r) => live.has(r));
  return kept.length ? kept : all().map((s) => s.slug);
}

/** Has this person been given an explicit list, or are they on everything? */
function isAssigned(employeeId) {
  try { return qMine.all(employeeId).length > 0; } catch { return false; }
}

/**
 * THE GATE. Server-side, and the only thing any route should ask.
 *
 * Hiding a button is not authorisation — a POST naming another service has to
 * be refused here, not merely made hard to reach in the browser.
 */
const canWork = (employeeId, slug) => forEmployee(employeeId).includes(slug);

/** Replace somebody's whole list. An empty list means "every service" again. */
function setForEmployee(employeeId, slugs) {
  const live = new Set(all().map((s) => s.slug));
  const want = [...new Set((slugs || []).filter((s) => live.has(s)))];
  db.transaction(() => {
    db.prepare('DELETE FROM employee_services WHERE employee_id = ?').run(employeeId);
    const ins = db.prepare(`INSERT OR IGNORE INTO employee_services (employee_id, service_slug)
                            VALUES (?, ?)`);
    // All of them selected is the same fact as none selected — both mean "works
    // everything" — and storing it as none means adding a service later
    // includes them automatically, which is what somebody ticking every box
    // meant. It also keeps one representation of one idea.
    if (want.length && want.length < live.size) for (const s of want) ins.run(employeeId, s);
  })();
}

/** Everybody who may work a service — for scoping a board or a roster. */
function employeesFor(slug) {
  const explicit = db.prepare(`SELECT employee_id FROM employee_services
                               WHERE service_slug = ? AND active = 1`).all(slug).map((r) => r.employee_id);
  const assigned = new Set(db.prepare(`SELECT DISTINCT employee_id FROM employee_services
                                       WHERE active = 1`).all().map((r) => r.employee_id));
  const everyone = db.prepare('SELECT id FROM employees WHERE active = 1').all().map((r) => r.id);
  // Anybody with no list at all works everything, so they belong to every slug.
  return everyone.filter((id) => !assigned.has(id) || explicit.includes(id));
}

module.exports = {
  BUILT_IN, seed, all, bySlug, nameOf, isActive, create, rename, archive, unarchive,
  forEmployee, isAssigned, canWork, setForEmployee, employeesFor,
};
