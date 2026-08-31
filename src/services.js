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
 * MEMBERSHIP IS EXPLICIT. A schedule shows the people who were put on it, and
 * nobody else. There is no fallback, no "not set up yet means everywhere" —
 * the checkbox on the staff page and the row in this table are the same fact,
 * so what a manager sees ticked is exactly who appears on that board.
 *
 * An earlier version had a fallback for people nobody had touched, to stop a
 * roster emptying itself on deploy. That made the checkboxes lie: every box
 * read unticked while every person showed on every board. The fallback is gone
 * and the rows are written instead — by backfill() for everyone who already
 * existed, and by the create flows for everyone after:
 *
 *   NEW EMPLOYEE  -> put on every schedule, then narrowed. They can work their
 *                    first shift, and their boxes say so.
 *   NEW SCHEDULE  -> starts with whoever was picked while creating it, and
 *                    nobody else. Their boxes say that too.
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

  -- A schedule's time clock is a FLAG on the schedule, not a second table.
  -- A time clock is already a service here: punches, timesheets and
  -- corrections are all keyed by daypart, so a separate time_clocks table
  -- would be a second name for one thing, and the two would eventually
  -- disagree about which service a punch belonged to. The flag only controls
  -- whether the clock is offered separately -- its own card in the admin
  -- picker, and later its own card on the portal before somebody clocks in.

  -- One row, one job: remembering that the one-time backfill has run. Its own
  -- table rather than the shared settings one, which is created by timeclock.js
  -- and therefore absent from any database that has not loaded it — a
  -- dependency this module has no reason to have, and one that made backfill()
  -- throw in a test that required nothing but src/db.
  CREATE TABLE IF NOT EXISTS service_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
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

function create({ slug, name, sort, startsMin, endsMin, members, withClock: wc }) {
  const key = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!key) throw new Error('A service needs a short internal key.');
  if (!String(name || '').trim()) throw new Error('A service needs a name.');
  if (bySlug(key)) throw new Error(`There is already a service keyed "${key}".`);
  const next = (db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM services').get().m || 0) + 1;
  db.prepare(`INSERT INTO services (slug, name, sort, active, starts_min, ends_min, has_clock)
              VALUES (?, ?, ?, 1, ?, ?, ?)`)
    .run(key, String(name).trim(), Number.isFinite(sort) ? sort : next,
      Number.isFinite(startsMin) ? startsMin : null, Number.isFinite(endsMin) ? endsMin : null,
      wc === false ? 0 : 1);
  // Whoever was picked while creating it, and nobody else. A schedule that
  // arrived with the whole roster on it would have to be emptied before it was
  // any use, which is the wrong way round.
  if (Array.isArray(members) && members.length) {
    const ins = db.prepare(`INSERT OR IGNORE INTO employee_services (employee_id, service_slug)
                            VALUES (?, ?)`);
    db.transaction(() => { for (const m of members) ins.run(Number(m), key); })();
  }
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

// Whether this schedule has a time clock of its own — that is, whether it is
// offered as its own card in the Time clocks picker (and later on the portal,
// before somebody clocks in). Existing schedules default to 1: café and dinner
// have always had a clock, and a migration that quietly switched it off would
// take the time clock away from a working restaurant.
try {
  const cols = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  if (!cols.includes('has_clock')) {
    db.exec('ALTER TABLE services ADD COLUMN has_clock INTEGER NOT NULL DEFAULT 1');
  }
} catch { /* older engine */ }

/**
 * EVERY CLOCK ITS OWN SETTINGS.
 *
 * Breaks, the long-shift flag, auto clock-out and the rest used to be one value
 * shared by every clock, so editing them on Day changed them on Evening too —
 * which is not what "a separate time clock" means to anybody who has just made
 * two of them.
 *
 * Each column is NULLABLE and NULL means "not set here, use the app-wide
 * value". seedSettings() then copies the app-wide values in ONCE, so every
 * clock starts life behaving exactly as it did the day before and diverges
 * only when somebody edits one of them.
 *
 * The business-date cutoff is deliberately NOT here. It answers "which DAY does
 * 1am belong to" and is read in thirty-three places across payroll, sales, cash
 * and the services page. Two clocks disagreeing about it would file one night
 * under two different dates.
 */
const CLOCK_SETTINGS = [
  ['break_paid', 'breaksPaid', 'flag'],
  ['long_shift', 'longShift', 'num'],
  ['pin_fix', 'pinForFix', 'flag'],
  ['alerts', 'alertsOn', 'flag'],
  ['auto_out', 'autoOut', 'flag'],
  ['auto_out_hours', 'autoOutHours', 'num'],
];

try {
  const cols = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  for (const [col] of CLOCK_SETTINGS) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE services ADD COLUMN ${col} INTEGER`);
  }
} catch { /* older engine */ }

/**
 * Copy the app-wide values onto every clock, once.
 *
 * Called at boot after the time clock's own defaults exist. Runs only where a
 * clock has nothing set, so a clock somebody has already configured is never
 * overwritten by a later boot.
 */
function seedSettings(appWide) {
  if (!appWide) return { seeded: 0 };
  let seeded = 0;
  const upd = db.prepare(`UPDATE services SET break_paid = @break_paid, long_shift = @long_shift,
    pin_fix = @pin_fix, alerts = @alerts, auto_out = @auto_out, auto_out_hours = @auto_out_hours
    WHERE slug = @slug AND break_paid IS NULL AND long_shift IS NULL`);
  db.transaction(() => {
    for (const sv of all({ includeArchived: true })) {
      seeded += upd.run({
        slug: sv.slug,
        break_paid: appWide.breaksPaid ? 1 : 0,
        long_shift: Number(appWide.longShift) || 16,
        pin_fix: appWide.pinForFix ? 1 : 0,
        alerts: appWide.alertsOn ? 1 : 0,
        auto_out: appWide.autoOut ? 1 : 0,
        auto_out_hours: Number(appWide.autoOutHours) || 13,
      }).changes;
    }
  })();
  return { seeded };
}

/**
 * One clock's settings, falling back to the app-wide value for anything unset.
 *
 * `appWide` is passed in rather than read here, because reading it would mean
 * this module requiring timeclock.js, which requires this one.
 */
function settingsFor(slug, appWide = {}) {
  const sv = bySlug(slug) || {};
  const out = {};
  for (const [col, key, kind] of CLOCK_SETTINGS) {
    const v = sv[col];
    if (v == null) out[key] = appWide[key];
    else out[key] = kind === 'flag' ? v === 1 : Number(v);
  }
  return out;
}

/** Save one clock's settings. Values are clamped the way the app-wide ones are. */
function setSettingsFor(slug, v) {
  const clamp = (x, lo, hi, d) => {
    const n = Math.round(Number(x));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  };
  db.prepare(`UPDATE services SET break_paid = @break_paid, long_shift = @long_shift,
    pin_fix = @pin_fix, alerts = @alerts, auto_out = @auto_out, auto_out_hours = @auto_out_hours
    WHERE slug = @slug`).run({
    slug,
    break_paid: v.breaksPaid ? 1 : 0,
    long_shift: clamp(v.longShift, 4, 24, 16),
    pin_fix: v.pinForFix ? 1 : 0,
    alerts: v.alertsOn ? 1 : 0,
    auto_out: v.autoOut ? 1 : 0,
    // Floored at 4 hours: anything shorter closes real shifts in progress, and
    // this exists to catch a punch nobody came back to.
    auto_out_hours: clamp(v.autoOutHours, 4, 24, 13),
  });
}

/** Schedules that carry their own time clock. */
const withClock = () => all().filter((x) => x.has_clock !== 0);

/**
 * WHEN somebody may clock into this schedule.
 *
 * Off by default and off for every existing schedule, because switching it on
 * can stop a real person starting a real shift. Three states:
 *
 *   off        anybody assigned to the schedule may clock in, any time
 *   scheduled  only while they have a shift on this schedule
 *   early      as above, plus N minutes before it starts
 *
 * Stored on the schedule rather than globally: a café that opens on the dot and
 * a dinner service people drift into are different rules, and one number for
 * both is the wrong number for one of them.
 */
try {
  const cols = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  if (!cols.includes('clock_limit')) {
    db.exec("ALTER TABLE services ADD COLUMN clock_limit TEXT NOT NULL DEFAULT 'off'");
  }
  if (!cols.includes('clock_early_min')) {
    db.exec('ALTER TABLE services ADD COLUMN clock_early_min INTEGER NOT NULL DEFAULT 5');
  }
} catch { /* older engine */ }

/**
 * WORK HOURS — per day, per time clock.
 *
 * When this clock opens for punching, and when it closes people out. A row per
 * weekday because a bar's Friday is not its Monday, and one pair of times for
 * the week is the wrong pair on at least one day.
 *
 * NOT the business-date cutoff, which is a different question and stays where
 * it is: the cutoff answers "which DAY does 1am belong to" and is read in forty
 * places across payroll, sales, cash and the services page. These answer "is
 * this clock open right now". Both exist; neither is the other.
 *
 * NULL means unset, and unset means no limit for that day — the safe direction,
 * so a clock nobody has configured behaves exactly as it does today.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS service_hours (
    service_slug TEXT    NOT NULL,
    weekday      INTEGER NOT NULL,   -- 0 = Sunday, matching Date#getDay
    open_min     INTEGER,            -- clock-in available from, minutes past midnight
    close_min    INTEGER,            -- auto clock out at
    UNIQUE(service_slug, weekday)
  );
`);

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** All seven days for one clock, always seven rows, unset ones included. */
function hoursFor(slug) {
  let rows = [];
  try {
    rows = db.prepare('SELECT weekday, open_min, close_min FROM service_hours WHERE service_slug = ?').all(slug);
  } catch { rows = []; }
  const by = new Map(rows.map((r) => [r.weekday, r]));
  return DAY_LETTERS.map((letter, d) => ({
    weekday: d, letter, name: DAY_NAMES[d],
    openMin: by.has(d) ? by.get(d).open_min : null,
    closeMin: by.has(d) ? by.get(d).close_min : null,
  }));
}

/** One day, for the clock-in check. */
function hoursOn(slug, weekday) {
  return hoursFor(slug)[weekday] || { openMin: null, closeMin: null };
}

const asMin = (v) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
};

function setHours(slug, weekday, openMin, closeMin) {
  const o = openMin == null ? null : Math.max(0, Math.min(1439, Math.round(openMin)));
  const c = closeMin == null ? null : Math.max(0, Math.min(1439, Math.round(closeMin)));
  db.prepare(`INSERT INTO service_hours (service_slug, weekday, open_min, close_min)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(service_slug, weekday)
              DO UPDATE SET open_min = excluded.open_min, close_min = excluded.close_min`)
    .run(slug, weekday, o, c);
}

const LIMITS = ['off', 'scheduled', 'early'];

function limitOf(slug) {
  const sv = bySlug(slug);
  if (!sv) return { mode: 'off', earlyMin: 5 };
  return {
    mode: LIMITS.includes(sv.clock_limit) ? sv.clock_limit : 'off',
    // Clamped on read as well as on write: a value that arrived by some other
    // route must not become a negative window nobody can clock into.
    earlyMin: Math.max(0, Math.min(240, Number(sv.clock_early_min) || 0)),
  };
}

function setLimit(slug, mode, earlyMin) {
  const m = LIMITS.includes(mode) ? mode : 'off';
  const n = Math.max(0, Math.min(240, Math.round(Number(earlyMin))|| 0));
  db.prepare('UPDATE services SET clock_limit = ?, clock_early_min = ? WHERE slug = ?').run(m, n, slug);
}

/** Connect or disconnect a schedule's clock, later, without recreating it. */
function setClock(slug, on) {
  db.prepare('UPDATE services SET has_clock = ? WHERE slug = ?').run(on ? 1 : 0, slug);
}

// svc_set is kept as a column so an existing database does not have to be
// rewritten, but nothing reads it any more: membership is the rows now.
try {
  const cols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
  if (!cols.includes('svc_set')) {
    db.exec('ALTER TABLE employees ADD COLUMN svc_set INTEGER NOT NULL DEFAULT 0');
  }
} catch { /* older engine */ }

const qMine = db.prepare('SELECT service_slug FROM employee_services WHERE employee_id = ? AND active = 1');

/**
 * The schedules this person is on. No rows means none.
 *
 * Filtered against the live list, so archiving a schedule takes it off
 * everybody without having to touch a membership row.
 */
function forEmployee(employeeId) {
  if (!employeeId) return [];
  let rows = [];
  try { rows = qMine.all(employeeId).map((r) => r.service_slug); } catch { rows = []; }
  const live = new Set(all().map((s) => s.slug));
  return rows.filter((r) => live.has(r));
}

/** Is this person on any schedule at all? */
const isAssigned = (employeeId) => forEmployee(employeeId).length > 0;

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
 * Put every existing employee on every existing schedule, once.
 *
 * Real rows, not a fallback. With membership explicit there is nothing to fall
 * back to, so the roster that was already working has to be written down or it
 * disappears from every board on deploy. Runs only into an empty table: after
 * anybody has been deliberately narrowed, re-running it would undo that.
 */
function backfill() {
  // Guarded on a FLAG, not on the table being empty. "Empty" is the wrong
  // question: a single stray row — one person added by hand, one left by a
  // test — makes the table non-empty and strands everybody else off every
  // board with no error anywhere. Seen exactly that on the dev database.
  //
  // The flag also says what happened, which "the table has rows in it" never
  // could: it separates "already run" from "somebody has been narrowed".
  const done = !!db.prepare("SELECT value FROM service_meta WHERE key = 'backfilled'").get();
  if (done) return { added: 0, skipped: true };

  const slugs = all().map((x) => x.slug);
  const ins = db.prepare(`INSERT OR IGNORE INTO employee_services (employee_id, service_slug)
                          VALUES (?, ?)`);
  let added = 0;
  db.transaction(() => {
    for (const e of db.prepare('SELECT id FROM employees WHERE active = 1').all()) {
      for (const sl of slugs) added += ins.run(e.id, sl).changes;
    }
    db.prepare(`INSERT INTO service_meta (key, value) VALUES ('backfilled', '1')
                ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
  })();
  return { added, skipped: false };
}

/**
 * A new employee joins every schedule. Their manager unticks what does not
 * apply — which is quicker than ticking what does, and means somebody hired on
 * a Tuesday can clock in on the Tuesday.
 */
function addToAll(employeeId) {
  const ins = db.prepare(`INSERT OR IGNORE INTO employee_services (employee_id, service_slug)
                          VALUES (?, ?)`);
  let n = 0;
  db.transaction(() => { for (const sv of all()) n += ins.run(employeeId, sv.slug).changes; })();
  return n;
}

/**
 * Everybody on a schedule: those added to it, plus anybody nobody has set up
 * yet. A new hire appears on every board until their manager narrows them,
 * rather than being invisible on the day they start.
 */
function employeesFor(slug) {
  return db.prepare(`SELECT es.employee_id FROM employee_services es
                     JOIN employees e ON e.id = es.employee_id
                     WHERE es.service_slug = ? AND es.active = 1 AND e.active = 1`)
    .all(slug).map((r) => r.employee_id);
}

module.exports = {
  BUILT_IN, seed, backfill, addToAll, all, withClock, setClock, LIMITS, limitOf, setLimit,
  DAY_LETTERS, DAY_NAMES, hoursFor, hoursOn, setHours, asMin, bySlug,
  CLOCK_SETTINGS, seedSettings, settingsFor, setSettingsFor, nameOf, isActive, create, rename, archive, unarchive,
  forEmployee, isAssigned, canWork, setForEmployee, employeesFor,
};
