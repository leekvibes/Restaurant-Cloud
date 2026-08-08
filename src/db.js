'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,          -- server | kitchen | barista | bartender | busser | manager
  email         TEXT,
  pin           TEXT,                   -- 4-digit, for the no-login staff cash-tip page
  hourly_rate_cents INTEGER DEFAULT 0,  -- from Gusto later; used for wage display
  pos_id        TEXT,                   -- Benugin's stable server id, for matching
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,             -- YYYY-MM-DD
  daypart    TEXT NOT NULL,             -- cafe | dinner
  status     TEXT NOT NULL DEFAULT 'open', -- open | emailed
  policy_id  INTEGER,                   -- tip-out policy version locked in at creation
  pool_jar_cents  INTEGER NOT NULL DEFAULT 0,  -- shared tip jar (cash) for the shift
  pool_togo_cents INTEGER NOT NULL DEFAULT 0,  -- to-go tips for the shift
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, daypart)
);

CREATE TABLE IF NOT EXISTS work (
  shift_id    INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,            -- role worked on THIS shift (can differ from default)
  hours       REAL NOT NULL DEFAULT 0,
  hourly_rate_cents INTEGER DEFAULT 0,  -- per-shift wage override; 0 = use employee default
  PRIMARY KEY (shift_id, employee_id)
);

CREATE TABLE IF NOT EXISTS server_sales (
  shift_id      INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  food_cents    INTEGER NOT NULL DEFAULT 0,
  coffee_cents  INTEGER NOT NULL DEFAULT 0,
  alcohol_cents INTEGER NOT NULL DEFAULT 0,
  card_tips_cents INTEGER NOT NULL DEFAULT 0,
  cash_tips_cents INTEGER NOT NULL DEFAULT 0,
  cash_entered_by TEXT,                 -- 'staff' | 'manager' | 'pos', for trust/trace
  PRIMARY KEY (shift_id, employee_id)
);
`);

// Migration: add the per-shift wage column to older databases that predate it.
const workCols = db.prepare('PRAGMA table_info(work)').all().map((c) => c.name);
if (!workCols.includes('hourly_rate_cents')) {
  db.exec('ALTER TABLE work ADD COLUMN hourly_rate_cents INTEGER DEFAULT 0');
}
// Migration: where this number came from. The time clock writes hours now, so
// "who set this" has to be answerable before "what is it" — this column is the
// whole override rule. NULL means nobody has set it and the clock may claim it;
// anything else means a human, the POS or the old importer put it there, and an
// automatic recompute must leave it alone.
//
// hours = 0 could not carry that meaning: insertWorkIfAbsent writes a literal 0
// when someone is merely registered on a shift, so zero is indistinguishable
// from a deliberate zero. NULL is the honest third state.
if (!workCols.includes('hours_source')) {
  db.exec('ALTER TABLE work ADD COLUMN hours_source TEXT');   // clock | manager | pos | legacy
  // One-shot stamp for databases that predate the clock. Every row already
  // carrying a figure was typed, pushed by the POS, or imported — all of them
  // outrank the clock, and none of them can be told apart after the fact, so
  // they are marked 'legacy' rather than dressed up as any one of the three.
  db.exec("UPDATE work SET hours_source = 'legacy' WHERE hours > 0");
}
if (!workCols.includes('hours_set_by')) db.exec('ALTER TABLE work ADD COLUMN hours_set_by TEXT');
if (!workCols.includes('hours_set_at')) db.exec('ALTER TABLE work ADD COLUMN hours_set_at TEXT');
// Per-employee role+wage pairs — a person can be e.g. server @ $11 AND busser @ $13.
db.exec(`CREATE TABLE IF NOT EXISTS employee_roles (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  wage_cents  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, role)
);`);
// Migration: hourly vs salary on employees.
const empCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
if (!empCols.includes('pay_type')) db.exec("ALTER TABLE employees ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'hourly'");
if (!empCols.includes('salary_cents')) db.exec('ALTER TABLE employees ADD COLUMN salary_cents INTEGER NOT NULL DEFAULT 0');
// Migration: the instant a deactivated employee was brought back.
//
// NULL for everybody who has never been through a reactivation, which is
// everybody today — so this column changes nothing until somebody is actually
// reactivated. It exists because "reactivation restores the shifts that were
// still ahead of them AT THAT MOMENT" needs the moment recorded; a business
// date cannot express it, since somebody reactivated at 2pm should get back
// tonight's shift and not this morning's.
if (!empCols.includes('schedule_visible_from_at')) {
  db.exec('ALTER TABLE employees ADD COLUMN schedule_visible_from_at TEXT');
}

// Migration: add the tip-out policy stamp + shared-pool columns to shifts.
const shiftCols = db.prepare('PRAGMA table_info(shifts)').all().map((c) => c.name);
if (!shiftCols.includes('policy_id')) db.exec('ALTER TABLE shifts ADD COLUMN policy_id INTEGER');
// A day the restaurant did not open but staff still came in — a deep clean, a
// private booking that fell through, a holiday with prep work. Their hours and
// wages are real and still count; there simply were no sales. Recording that
// as $0 would drag every average and leave the service nagging to be filled in
// forever, so it is marked rather than zeroed.
if (!shiftCols.includes('closed_at')) db.exec('ALTER TABLE shifts ADD COLUMN closed_at TEXT');
if (!shiftCols.includes('pool_jar_cents')) db.exec('ALTER TABLE shifts ADD COLUMN pool_jar_cents INTEGER NOT NULL DEFAULT 0');
if (!shiftCols.includes('pool_togo_cents')) db.exec('ALTER TABLE shifts ADD COLUMN pool_togo_cents INTEGER NOT NULL DEFAULT 0'); // to-go CASH
if (!shiftCols.includes('pool_togo_card_cents')) db.exec('ALTER TABLE shifts ADD COLUMN pool_togo_card_cents INTEGER NOT NULL DEFAULT 0');

// ---- Positions ----------------------------------------------------------
// Jobs someone can work, as data rather than a hardcoded list, so new ones can
// be added from the app. `kind` is what actually drives the money:
//   server     — keeps their own tips and tips out to the others
//   support    — shares the tip-out pots and the shared pool, split by hours
//   non_tipped — on the clock, paid hourly, in no pool at all (e.g. training)
// non_tipped matters: if a trainee counted as support, their hours would take
// a slice of the pool away from everyone actually earning tips.
db.exec(`
CREATE TABLE IF NOT EXISTS positions (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  slug   TEXT NOT NULL UNIQUE,
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL DEFAULT 'support',
  sort   INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1
);
`);
if (db.prepare('SELECT COUNT(*) n FROM positions').get().n === 0) {
  const ins = db.prepare('INSERT INTO positions (slug, name, kind, sort) VALUES (?, ?, ?, ?)');
  [['server', 'Server', 'server', 10], ['kitchen', 'Kitchen', 'support', 20],
    ['barista', 'Barista', 'support', 30], ['bartender', 'Bartender', 'support', 40],
    ['busser', 'Busser', 'support', 50]].forEach((p) => ins.run(...p));
}

const positions = {
  all: db.prepare('SELECT * FROM positions ORDER BY sort, name'),
  active: db.prepare('SELECT * FROM positions WHERE active = 1 ORDER BY sort, name'),
  bySlug: db.prepare('SELECT * FROM positions WHERE slug = ?'),
  byId: db.prepare('SELECT * FROM positions WHERE id = ?'),
  add: db.prepare('INSERT INTO positions (slug, name, kind, sort) VALUES (@slug, @name, @kind, @sort)'),
  update: db.prepare('UPDATE positions SET name = @name, kind = @kind, sort = @sort WHERE id = @id'),
  setActive: db.prepare('UPDATE positions SET active = ? WHERE id = ?'),
  inUse: db.prepare('SELECT COUNT(*) n FROM work WHERE role = ?'),
};

/** slug -> kind, for the hot paths that just need to classify a role. */
function positionKinds() {
  const map = {};
  for (const p of positions.all.all()) map[p.slug] = p.kind;
  return map;
}
const kindOf = (slug) => positionKinds()[slug] || 'support';
const supportSlugs = () => positions.active.all().filter((p) => p.kind === 'support').map((p) => p.slug);

// Migration: total sales for the whole shift, not just what servers rang up.
// Server sales stay per-person because tip-outs are a percentage of each
// server's OWN sales. But counter, to-go and bar sales never touch a server's
// name, so using server sales as the denominator made labor % read far higher
// than it is. These are the authoritative business numbers.
for (const c of ['total_food_cents', 'total_coffee_cents', 'total_alcohol_cents', 'total_other_cents']) {
  if (!shiftCols.includes(c)) db.exec(`ALTER TABLE shifts ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
}
if (!shiftCols.includes('sales_note')) db.exec('ALTER TABLE shifts ADD COLUMN sales_note TEXT');

// Migration: a free-text note staff can leave when they submit — a thought,
// comment or concern, or an explanation of something odd in their numbers.
const salesCols = db.prepare('PRAGMA table_info(server_sales)').all().map((c) => c.name);
if (!salesCols.includes('note')) db.exec('ALTER TABLE server_sales ADD COLUMN note TEXT');

// ---- Users --------------------------------------------------------------
// People who sign in to the back office. Separate from `employees` on purpose:
// an employee is someone you pay, a user is someone with a login, and an owner
// is usually one without being the other.
//   role     — editor (can change things) | viewer (sees, changes nothing)
//   features — comma list of areas they can open; empty means everything
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL COLLATE NOCASE,
  pass_hash  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer',
  features   TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email COLLATE NOCASE);
`);

const users = {
  all: db.prepare('SELECT * FROM users ORDER BY active DESC, name'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  add: db.prepare(`INSERT INTO users (name, email, pass_hash, role, features)
                   VALUES (@name, @email, @pass_hash, @role, @features)`),
  update: db.prepare('UPDATE users SET name=@name, email=@email, role=@role, features=@features WHERE id=@id'),
  setPass: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
  setActive: db.prepare('UPDATE users SET active = ? WHERE id = ?'),
  seen: db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?"),
  del: db.prepare('DELETE FROM users WHERE id = ?'),
};

// ---- Tip submissions ----------------------------------------------------
// Append-only record of every submission and manager edit. The work and
// server_sales rows only ever hold the CURRENT figures — someone resubmitting
// to fix a typo overwrote what they first said, and there was no way to see
// that a correction had even happened, let alone what changed.
db.exec(`
CREATE TABLE IF NOT EXISTS tip_submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id     INTEGER NOT NULL,
  employee_id  INTEGER NOT NULL,
  role         TEXT,
  cash_tips_cents INTEGER,
  card_tips_cents INTEGER,
  food_cents      INTEGER,
  coffee_cents    INTEGER,
  alcohol_cents   INTEGER,
  note         TEXT,
  source       TEXT NOT NULL DEFAULT 'staff',   -- staff | manager
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tip_sub_shift ON tip_submissions (shift_id, created_at DESC);
`);

const submissions = {
  add: db.prepare(`INSERT INTO tip_submissions
    (shift_id, employee_id, role, cash_tips_cents, card_tips_cents, food_cents, coffee_cents, alcohol_cents, note, source)
    VALUES (@shift_id, @employee_id, @role, @cash_tips_cents, @card_tips_cents, @food_cents, @coffee_cents, @alcohol_cents, @note, @source)`),
  forShift: db.prepare(`SELECT ts.*, e.name FROM tip_submissions ts
                        JOIN employees e ON e.id = ts.employee_id
                        WHERE ts.shift_id = ? ORDER BY ts.created_at DESC, ts.id DESC`),
  countForShift: db.prepare('SELECT COUNT(*) n FROM tip_submissions WHERE shift_id = ?'),
};

// One-time backfill. Logging started partway through, so shifts closed before
// it have nothing to show. server_sales holds each person's CURRENT figures,
// which is all that survives — the versions they replaced were overwritten and
// are genuinely gone. These are marked 'imported' rather than dressed up as
// real submissions with invented timestamps.
db.transaction(() => {
  const rows = db.prepare(`
    SELECT ss.*, sh.date FROM server_sales ss
    JOIN shifts sh ON sh.id = ss.shift_id
    WHERE (ss.cash_tips_cents > 0 OR ss.card_tips_cents > 0
        OR ss.food_cents > 0 OR ss.coffee_cents > 0 OR ss.alcohol_cents > 0)
      AND NOT EXISTS (SELECT 1 FROM tip_submissions ts
                      WHERE ts.shift_id = ss.shift_id AND ts.employee_id = ss.employee_id)
  `).all();
  if (!rows.length) return;
  const roleOf = db.prepare('SELECT role FROM work WHERE shift_id = ? AND employee_id = ?');
  const ins = db.prepare(`INSERT INTO tip_submissions
    (shift_id, employee_id, role, cash_tips_cents, card_tips_cents, food_cents, coffee_cents, alcohol_cents, note, source, created_at)
    VALUES (@shift_id, @employee_id, @role, @cash, @card, @food, @coffee, @alcohol, @note, 'imported', @at)`);
  for (const r of rows) {
    const w = roleOf.get(r.shift_id, r.employee_id);
    ins.run({
      shift_id: r.shift_id, employee_id: r.employee_id, role: w ? w.role : null,
      cash: r.cash_tips_cents || null, card: r.card_tips_cents || null,
      food: r.food_cents || null, coffee: r.coffee_cents || null, alcohol: r.alcohol_cents || null,
      note: r.note || null,
      at: `${r.date} 00:00`,   // the shift's own date; no clock time is known
    });
  }
})();

// ---- Employees ----------------------------------------------------------
const q = {
  allEmployees: db.prepare('SELECT * FROM employees WHERE active = 1 ORDER BY role, name'),
  employee: db.prepare('SELECT * FROM employees WHERE id = ?'),
  serversList: db.prepare("SELECT * FROM employees WHERE active = 1 AND role = 'server' ORDER BY name"),
  addEmployee: db.prepare(
    `INSERT INTO employees (name, role, email, pin, hourly_rate_cents, pos_id, pay_type, salary_cents)
     VALUES (@name, @role, @email, @pin, @hourly_rate_cents, @pos_id, @pay_type, @salary_cents)`
  ),
  // active = 1 to match the name fallback beside it. Without it a POS id left
  // on somebody who has since left matches, and their batch lands on a person
  // who is not there.
  employeeByPosId: db.prepare('SELECT * FROM employees WHERE pos_id = ? AND active = 1'),
  // The PIN is how staff identify themselves on the tips page, so it has to
  // point at exactly one active person. Second arg excludes the person being
  // edited (pass 0 when adding).
  employeeByPin: db.prepare('SELECT * FROM employees WHERE pin = ? AND active = 1 AND id <> ?'),
  // Sign-in lookup for the tips page. Returns every match so a duplicate PIN
  // fails loudly instead of silently picking one of them.
  staffByPin: db.prepare("SELECT * FROM employees WHERE pin = ? AND active = 1 AND role <> 'manager'"),
  // Per-role wages
  roleWage: db.prepare('SELECT wage_cents FROM employee_roles WHERE employee_id = ? AND role = ?'),
  rolesForEmployee: db.prepare('SELECT role, wage_cents FROM employee_roles WHERE employee_id = ? ORDER BY role'),
  setRole: db.prepare(`INSERT INTO employee_roles (employee_id, role, wage_cents) VALUES (@employee_id, @role, @wage_cents)
     ON CONFLICT(employee_id, role) DO UPDATE SET wage_cents = excluded.wage_cents`),
  deleteRole: db.prepare('DELETE FROM employee_roles WHERE employee_id = ? AND role = ?'),
  // Anyone who can be scheduled on a shift (any role except manager) — a person
  // can work a different position on a given day, so both close dropdowns use this.
  nonManagerList: db.prepare("SELECT * FROM employees WHERE active = 1 AND role != 'manager' ORDER BY name"),
  updateEmployee: db.prepare(
    `UPDATE employees SET name=@name, role=@role, email=@email, pin=@pin,
       hourly_rate_cents=@hourly_rate_cents, pos_id=@pos_id, pay_type=@pay_type, salary_cents=@salary_cents WHERE id=@id`
  ),
  // The ONE place employees.active is written, and it stamps the reactivation
  // instant itself rather than trusting a caller to remember. Audited: this is
  // the only write path in the app — updateEmployee never touches `active`, and
  // there is no other statement that does — so the threshold cannot be set by
  // one route and bypassed by another.
  //
  // Stamped only on the inactive -> active edge. Re-saving an already-active
  // employee must not move the boundary, or every save would quietly hide more
  // of their history.
  setActive: {
    run(p) {
      const on = Number(p.active) === 1;
      const cur = db.prepare('SELECT active FROM employees WHERE id = ?').get(p.id);
      const waking = on && cur && Number(cur.active) === 0;
      return db.transaction(() => {
        if (waking) {
          db.prepare("UPDATE employees SET active = 1, schedule_visible_from_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = @id")
            .run({ id: p.id });
        } else {
          db.prepare('UPDATE employees SET active = @active WHERE id = @id')
            .run({ id: p.id, active: on ? 1 : 0 });
        }
      })();
    },
  },
};

// ---- Shifts -------------------------------------------------------------
const s = {
  createShift: db.prepare('INSERT INTO shifts (date, daypart) VALUES (?, ?)'),
  getOrIgnore: db.prepare('INSERT OR IGNORE INTO shifts (date, daypart) VALUES (?, ?)'),
  findShift: db.prepare('SELECT * FROM shifts WHERE date = ? AND daypart = ?'),
  shiftById: db.prepare('SELECT * FROM shifts WHERE id = ?'),
  recentShifts: db.prepare('SELECT * FROM shifts ORDER BY date DESC, daypart DESC LIMIT ?'),
  allShifts: db.prepare('SELECT * FROM shifts ORDER BY date DESC, daypart DESC'),
  shiftsInRange: db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date, daypart'),
  markEmailed: db.prepare("UPDATE shifts SET status = 'emailed' WHERE id = ?"),
  setPolicy: db.prepare('UPDATE shifts SET policy_id = ? WHERE id = ?'),
  setPool: db.prepare('UPDATE shifts SET pool_jar_cents = @jar, pool_togo_card_cents = @togo_card WHERE id = @id'),
  setTotalSales: db.prepare(`UPDATE shifts SET
     total_food_cents = @food, total_coffee_cents = @coffee,
     total_alcohol_cents = @alcohol, total_other_cents = @other, sales_note = @note
   WHERE id = @id`),
};

// Wipe a shift and everything hanging off it. Wrapped in a transaction so a
// half-deleted shift can't survive a crash mid-way.
const deleteShiftTx = db.transaction((shiftId) => {
  db.prepare('DELETE FROM server_sales WHERE shift_id = ?').run(shiftId);
  db.prepare('DELETE FROM work WHERE shift_id = ?').run(shiftId);
  // The submission log has no foreign key (it deliberately outlives edits to
  // work/server_sales), so it has to be cleared explicitly or a deleted shift
  // leaves its history orphaned behind it.
  db.prepare('DELETE FROM tip_submissions WHERE shift_id = ?').run(shiftId);
  db.prepare('DELETE FROM shifts WHERE id = ?').run(shiftId);
});
s.deleteShift = deleteShiftTx;

// ---- Work / sales -------------------------------------------------------
const w = {
  // The manager's own hand. @hours may be NULL, meaning "the hours field was
  // left blank, so leave the figure alone" — somebody correcting a server's
  // sales must not silently zero hours the clock derived, which is what an
  // unconditional write does now that parseHours('') returns 0.
  //
  // Passing a number is a deliberate override, and it stamps the row so no
  // later recompute can quietly undo it. Same shape as writeTipsIfGiven, whose
  // comment already reads "blank means leave it alone".
  upsertWork: db.prepare(
    `INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents,
                       hours_source, hours_set_by, hours_set_at)
     VALUES (@shift_id, @employee_id, @role, COALESCE(@hours, 0), @hourly_rate_cents,
             CASE WHEN @hours IS NULL THEN NULL ELSE 'manager' END,
             CASE WHEN @hours IS NULL THEN NULL ELSE @by END,
             CASE WHEN @hours IS NULL THEN NULL ELSE datetime('now') END)
     ON CONFLICT(shift_id, employee_id) DO UPDATE SET
       role = excluded.role,
       hourly_rate_cents = excluded.hourly_rate_cents,
       hours        = COALESCE(@hours, work.hours),
       hours_source = CASE WHEN @hours IS NULL THEN work.hours_source ELSE 'manager' END,
       hours_set_by = CASE WHEN @hours IS NULL THEN work.hours_set_by ELSE @by END,
       hours_set_at = CASE WHEN @hours IS NULL THEN work.hours_set_at ELSE datetime('now') END`
  ),
  // Register someone on a shift WITHOUT touching hours/role if they're already
  // there — used by the cash-tip page, the time clock and the POS webhook.
  // hours_source is left NULL, which is what frees the clock to fill the figure
  // in when they punch out.
  insertWorkIfAbsent: db.prepare(
    `INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents)
     VALUES (@shift_id, @employee_id, @role, 0, 0)
     ON CONFLICT(shift_id, employee_id) DO NOTHING`
  ),
  // The clock's write. The WHERE on the conflict branch IS the override rule,
  // held in the database rather than in every caller's memory: a row somebody
  // stamped by hand is never rewritten by an automatic recompute. When it does
  // not fire, `changes` comes back 0 — that is how the caller learns a manager
  // owns this number.
  setClockHours: db.prepare(
    `INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents,
                       hours_source, hours_set_by, hours_set_at)
     VALUES (@shift_id, @employee_id, @role, @hours, 0, 'clock', @by, datetime('now'))
     ON CONFLICT(shift_id, employee_id) DO UPDATE SET
       hours        = excluded.hours,
       hours_source = 'clock',
       hours_set_by = excluded.hours_set_by,
       hours_set_at = excluded.hours_set_at
     WHERE work.hours_source IS NULL OR work.hours_source = 'clock'`
  ),
  // Same rule, but never creates a row: for when the last punch leaves a shift
  // and the hours it put there have to go with it.
  clearClockHours: db.prepare(
    `UPDATE work SET hours = 0, hours_set_by = @by, hours_set_at = datetime('now')
      WHERE shift_id = @shift_id AND employee_id = @employee_id
        AND (hours_source IS NULL OR hours_source = 'clock')`
  ),
  // Hand a row back to the clock after an override. Without this, one mistyped
  // number is permanent.
  releaseHours: db.prepare(
    `UPDATE work SET hours_source = NULL, hours_set_by = NULL, hours_set_at = NULL
      WHERE shift_id = @shift_id AND employee_id = @employee_id`
  ),
  // The POS reports service, not attendance. It defers to a manager and to the
  // clock — the caller additionally skips anyone who actually punched, which
  // cannot be expressed here because time_entries does not exist yet when this
  // file loads.
  setPosHours: db.prepare(
    `UPDATE work SET hours = @hours, hours_source = 'pos', hours_set_by = 'pos',
                     hours_set_at = datetime('now')
      WHERE shift_id = @shift_id AND employee_id = @employee_id
        AND (hours_source IS NULL OR hours_source = 'pos')`
  ),
  deleteWork: db.prepare('DELETE FROM work WHERE shift_id = ? AND employee_id = ?'),
  workRow: db.prepare('SELECT * FROM work WHERE shift_id = ? AND employee_id = ?'),
  workForShift: db.prepare(
    `SELECT w.role, w.hours, w.employee_id, w.hours_source,
            w.hourly_rate_cents AS shift_rate_cents,
            e.name, e.email, e.hourly_rate_cents AS default_rate_cents, e.pay_type
     FROM work w JOIN employees e ON e.id = w.employee_id WHERE w.shift_id = ?`
  ),
  // Sales only. Card tips used to ride along here and were written on every
  // save, so an empty card field cleared a figure to zero while an empty cash
  // field — which goes through setCardTips/setCashTips, and those only write
  // when a value was actually supplied — left its figure alone. Two tip fields
  // side by side in the same form, behaving oppositely.
  //
  // COALESCE keeps whatever is already there when nothing is passed, so the
  // one place that owns tips is writeTipsIfGiven.
  upsertSales: db.prepare(
    `INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents)
     VALUES (@shift_id, @employee_id, @food_cents, @coffee_cents, @alcohol_cents)
     ON CONFLICT(shift_id, employee_id) DO UPDATE SET
       food_cents = excluded.food_cents, coffee_cents = excluded.coffee_cents,
       alcohol_cents = excluded.alcohol_cents`
  ),
  setCashTips: db.prepare(
    `INSERT INTO server_sales (shift_id, employee_id, cash_tips_cents, cash_entered_by)
     VALUES (@shift_id, @employee_id, @cash_tips_cents, @by)
     ON CONFLICT(shift_id, employee_id) DO UPDATE SET
       cash_tips_cents = excluded.cash_tips_cents, cash_entered_by = excluded.cash_entered_by`
  ),
  // Server-reported sales from the tips page (doesn't touch tip columns).
  setSales: db.prepare(
    `INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents)
     VALUES (@shift_id, @employee_id, @food_cents, @coffee_cents, @alcohol_cents)
     ON CONFLICT(shift_id, employee_id) DO UPDATE SET
       food_cents = excluded.food_cents, coffee_cents = excluded.coffee_cents, alcohol_cents = excluded.alcohol_cents`
  ),
  // Staff-reported card tips (doesn't touch sales columns).
  setCardTips: db.prepare(
    `INSERT INTO server_sales (shift_id, employee_id, card_tips_cents)
     VALUES (@shift_id, @employee_id, @card_tips_cents)
     ON CONFLICT(shift_id, employee_id) DO UPDATE SET card_tips_cents = excluded.card_tips_cents`
  ),
  // A note staff left with their submission (doesn't touch any figures).
  setNote: db.prepare(
    `INSERT INTO server_sales (shift_id, employee_id, note)
     VALUES (@shift_id, @employee_id, @note)
     ON CONFLICT(shift_id, employee_id) DO UPDATE SET note = excluded.note`
  ),
  notesForShift: db.prepare(
    `SELECT ss.employee_id, ss.note, e.name, w.role
       FROM server_sales ss
       JOIN employees e ON e.id = ss.employee_id
       LEFT JOIN work w ON w.shift_id = ss.shift_id AND w.employee_id = ss.employee_id
      WHERE ss.shift_id = ? AND ss.note IS NOT NULL AND TRIM(ss.note) <> ''
      ORDER BY e.name`
  ),
  salesForShift: db.prepare('SELECT * FROM server_sales WHERE shift_id = ?'),
  salesRow: db.prepare('SELECT * FROM server_sales WHERE shift_id = ? AND employee_id = ?'),
};

/** Assemble the exact input shape engine.runShift() expects, in DOLLARS. */
function shiftInputs(shiftId) {
  const workRows = w.workForShift.all(shiftId);
  const sales = new Map(w.salesForShift.all(shiftId).map((r) => [r.employee_id, r]));
  const servers = [];
  const support = [];
  const kinds = positionKinds();
  for (const row of workRows) {
    // Wage resolution: salaried → no hourly wage; else per-shift override →
    // the wage set for THIS role → the employee's default rate.
    const salaried = row.pay_type === 'salary';
    let rateCents = 0;
    if (!salaried) {
      if (row.shift_rate_cents > 0) {
        rateCents = row.shift_rate_cents;
      } else {
        const rw = q.roleWage.get(row.employee_id, row.role);
        rateCents = rw && rw.wage_cents ? rw.wage_cents : (row.default_rate_cents || 0);
      }
    }
    if (row.role === 'server') {
      const sr = sales.get(row.employee_id) || {};
      servers.push({
        employeeId: row.employee_id,
        name: row.name,
        email: row.email,
        hours: row.hours,
        hourlyRate: rateCents / 100,
        salaried,
        food: (sr.food_cents || 0) / 100,
        coffee: (sr.coffee_cents || 0) / 100,
        alcohol: (sr.alcohol_cents || 0) / 100,
        cardTips: (sr.card_tips_cents || 0) / 100,
        cashTips: (sr.cash_tips_cents || 0) / 100,
        cashEnteredBy: sr.cash_entered_by || null,
        hoursSource: row.hours_source || null,
      });
    } else {
      // Support staff can report tips too (a barista ringing people up, a
      // busser handed cash). Those get pooled — see the engine.
      const sr = sales.get(row.employee_id) || {};
      support.push({
        employeeId: row.employee_id,
        name: row.name,
        email: row.email,
        role: row.role,
        hours: row.hours,
        hourlyRate: rateCents / 100,
        salaried,
        cashTips: (sr.cash_tips_cents || 0) / 100,
        cardTips: (sr.card_tips_cents || 0) / 100,
        // A trainee is on the clock but out of every pool — their hours must
        // not dilute the split for the people actually earning tips.
        tipEligible: kinds[row.role] !== 'non_tipped',
        hoursSource: row.hours_source || null,
      });
    }
  }
  const sh = s.shiftById.get(shiftId) || {};
  // The jar holds all cash tips; to-go card tips are tracked separately.
  const pool = {
    jar: (sh.pool_jar_cents || 0) / 100,
    togoCash: (sh.pool_togo_cents || 0) / 100, // legacy column, folds into cash
    togoCard: (sh.pool_togo_card_cents || 0) / 100,
  };
  return { servers, support, pool };
}

module.exports = { db, q, s, w, users, submissions, positions, positionKinds, kindOf, supportSlugs, shiftInputs, DB_PATH };
