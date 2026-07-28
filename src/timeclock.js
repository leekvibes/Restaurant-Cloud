'use strict';

// ---------------------------------------------------------------------------
// TIME CLOCK — punches, breaks, corrections, and the audit behind them.
//
// The rules this file exists to hold:
//
//   The server owns every timestamp. A punch is `datetime('now')` on this box,
//   never a time the phone reported — a device clock is a suggestion, and a
//   payroll record built on one is not evidence of anything.
//
//   Nothing is ever silently overwritten. A correction writes the new value AND
//   an event carrying the old one, the reason, and who did it. The original
//   punch stays readable forever.
//
//   Impossible states are impossible in the DATABASE, not just in the route.
//   Two partial unique indexes do the work an `if` would otherwise be trusted
//   with: one active entry per person, one open break per entry. A double tap,
//   two phones, or two racing requests hit a constraint, not a second punch.
//
//   Clocked hours ARE the shift's hours. syncShiftHours writes work.hours from
//   the punches, and every path that can change a punch calls it — clock-out is
//   only the most obvious one. A number a manager typed still outranks the
//   clock, and that rule lives in the SQL (work.hours_source) rather than in
//   each caller's memory, so it cannot be forgotten at a new call site.
//
// Minutes are integers throughout, the way money is cents. Hours are derived at
// the display edge, never stored as a float that drifts.
// ---------------------------------------------------------------------------

const { db, w } = require('./db');
const { isoDate, addDays } = require('./dates');

// --- schema ----------------------------------------------------------------
// Created idempotently at load, the same convention modules.js and the incident
// log use. Nothing here alters an existing table.
db.exec(`
  CREATE TABLE IF NOT EXISTS time_entries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    shift_id       INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    business_date  TEXT NOT NULL,              -- YYYY-MM-DD, the trading day
    daypart        TEXT,                       -- cafe | dinner (the service)
    position       TEXT NOT NULL,              -- position slug worked
    clock_in_at    TEXT NOT NULL,              -- UTC 'YYYY-MM-DD HH:MM:SS'
    clock_out_at   TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    source         TEXT NOT NULL DEFAULT 'portal',   -- portal | manager
    raw_minutes        INTEGER,
    paid_break_min     INTEGER NOT NULL DEFAULT 0,
    unpaid_break_min   INTEGER NOT NULL DEFAULT 0,
    payable_minutes    INTEGER,
    edited         INTEGER NOT NULL DEFAULT 0,
    note           TEXT,
    -- Left for scheduling, which is a later phase. Nullable and unread today.
    scheduled_shift_id INTEGER, scheduled_start_at TEXT, scheduled_end_at TEXT,
    scheduled_position TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_by     TEXT,
    updated_at     TEXT,
    updated_by     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_te_emp_date ON time_entries (employee_id, business_date);
  CREATE INDEX IF NOT EXISTS idx_te_shift ON time_entries (shift_id);
  CREATE INDEX IF NOT EXISTS idx_te_status ON time_entries (status);
  CREATE INDEX IF NOT EXISTS idx_te_date ON time_entries (business_date);

  -- One person cannot be on the clock twice. Enforced here so a double tap or
  -- two devices race into a constraint rather than a second punch.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_te_one_active
    ON time_entries (employee_id) WHERE status IN ('active', 'on_break');

  CREATE TABLE IF NOT EXISTS time_breaks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    time_entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
    employee_id   INTEGER NOT NULL,
    start_at      TEXT NOT NULL,
    end_at        TEXT,
    paid          INTEGER NOT NULL DEFAULT 0,
    raw_minutes   INTEGER,
    source        TEXT NOT NULL DEFAULT 'employee',  -- employee | manager
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    created_by    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tb_entry ON time_breaks (time_entry_id);
  -- One open break per entry, for the same reason as above.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tb_one_open
    ON time_breaks (time_entry_id) WHERE end_at IS NULL;

  CREATE TABLE IF NOT EXISTS time_corrections (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE CASCADE,
    employee_id   INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    field         TEXT,
    original_value TEXT,
    proposed_value TEXT,
    reason        TEXT NOT NULL,
    requested_by  TEXT NOT NULL,
    requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
    decision      TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | applied
    decided_by    TEXT, decided_at TEXT, decision_note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tc_entry ON time_corrections (time_entry_id);
  CREATE INDEX IF NOT EXISTS idx_tc_open ON time_corrections (decision);
  CREATE INDEX IF NOT EXISTS idx_tc_emp ON time_corrections (employee_id);

  -- Append-only. Every mutation lands here with before/after and a reason.
  CREATE TABLE IF NOT EXISTS time_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity     TEXT NOT NULL,          -- entry | break | correction
    entity_id  INTEGER NOT NULL,
    action     TEXT NOT NULL,
    actor      TEXT,
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    before_val TEXT, after_val TEXT, reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tev ON time_events (entity, entity_id, id);
`);

// A correction has to be machine-applicable, not prose. `payload` carries the
// structured request — the exact timestamps, position or service being asked
// for — so approving it can act rather than just agree with it. The older
// free-text `proposed_value` stays as the human-readable summary.
(function addPayload() {
  const cols = db.prepare('PRAGMA table_info(time_corrections)').all().map((c) => c.name);
  if (!cols.includes('payload')) db.exec('ALTER TABLE time_corrections ADD COLUMN payload TEXT');
  if (!cols.includes('applied_at')) db.exec('ALTER TABLE time_corrections ADD COLUMN applied_at TEXT');
  if (!cols.includes('apply_error')) db.exec('ALTER TABLE time_corrections ADD COLUMN apply_error TEXT');
})();

// A timesheet is a pay period's worth of one person's time, plus the fact of
// their submitting it. It deliberately stores NO punches: the entries are the
// source of truth and a copy here would be a second version to drift. What it
// does keep is the totals as they stood at submission, because "what did I
// agree to" has to survive a later correction.
db.exec(`
  CREATE TABLE IF NOT EXISTS timesheets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    period_start  TEXT NOT NULL,
    period_end    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    submitted_at  TEXT, submitted_note TEXT, submitted_totals TEXT,
    returned_at   TEXT, returned_by TEXT, returned_reason TEXT,
    resubmit_needed INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(employee_id, period_start)
  );
  CREATE INDEX IF NOT EXISTS idx_ts_period ON timesheets (period_start);
  CREATE INDEX IF NOT EXISTS idx_ts_emp ON timesheets (employee_id, period_start);
`);

// Approval and transfer are two different facts and get two different tables.
// A sheet can be approved and not yet transferred; a transfer can go stale
// while the approval behind it still stands. Neither record is ever deleted —
// a later approval SUPERSEDES an earlier one, so "what did we approve, and what
// did we send" stays answerable months afterwards.
db.exec(`
  CREATE TABLE IF NOT EXISTS timesheet_approvals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timesheet_id  INTEGER NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
    employee_id   INTEGER NOT NULL,
    period_start  TEXT NOT NULL, period_end TEXT NOT NULL,
    approved_by   TEXT NOT NULL,
    approved_at   TEXT NOT NULL DEFAULT (datetime('now')),
    note          TEXT,
    regular_min   INTEGER NOT NULL DEFAULT 0,
    overtime_min  INTEGER NOT NULL DEFAULT 0,
    payable_min   INTEGER NOT NULL DEFAULT 0,
    paid_break_min INTEGER NOT NULL DEFAULT 0,
    unpaid_break_min INTEGER NOT NULL DEFAULT 0,
    ot_enabled    INTEGER NOT NULL DEFAULT 0,
    ot_exempt     INTEGER NOT NULL DEFAULT 0,
    -- What the hours were made of when they were approved. If this changes, the
    -- approval no longer describes the time it was given for.
    fingerprint   TEXT,
    override_reason TEXT,
    state         TEXT NOT NULL DEFAULT 'current',   -- current | superseded
    superseded_at TEXT, superseded_by TEXT, superseded_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ta_sheet ON timesheet_approvals (timesheet_id, id);
  CREATE INDEX IF NOT EXISTS idx_ta_period ON timesheet_approvals (period_start, state);

  CREATE TABLE IF NOT EXISTS payroll_transfers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id   INTEGER REFERENCES timesheet_approvals(id) ON DELETE SET NULL,
    timesheet_id  INTEGER NOT NULL,
    employee_id   INTEGER NOT NULL,
    period_start  TEXT NOT NULL, period_end TEXT NOT NULL,
    regular_min   INTEGER NOT NULL DEFAULT 0,
    overtime_min  INTEGER NOT NULL DEFAULT 0,
    payable_min   INTEGER NOT NULL DEFAULT 0,
    ot_enabled    INTEGER NOT NULL DEFAULT 0,
    wage_rate_cents INTEGER,
    est_gross_cents INTEGER,
    fingerprint   TEXT,
    transferred_by TEXT NOT NULL,
    transferred_at TEXT NOT NULL DEFAULT (datetime('now')),
    state         TEXT NOT NULL DEFAULT 'current',   -- current | superseded
    superseded_at TEXT, superseded_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pt_sheet ON payroll_transfers (timesheet_id, id);
  CREATE INDEX IF NOT EXISTS idx_pt_period ON payroll_transfers (period_start, state);
`);
(function addSheetCols() {
  const cols = db.prepare('PRAGMA table_info(timesheets)').all().map((c) => c.name);
  const add = (n, t) => { if (!cols.includes(n)) db.exec(`ALTER TABLE timesheets ADD COLUMN ${n} ${t}`); };
  add('approved_at', 'TEXT'); add('approved_by', 'TEXT');
  add('locked_at', 'TEXT'); add('locked_by', 'TEXT');
  add('reopened_at', 'TEXT'); add('reopened_by', 'TEXT'); add('reopen_reason', 'TEXT');
  // Transfer is tracked apart from approval on purpose.
  add('transfer_state', "TEXT NOT NULL DEFAULT 'not_ready'");
  add('transferred_at', 'TEXT'); add('transferred_by', 'TEXT');
})();

// --- settings --------------------------------------------------------------
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
const sq = {
  get: db.prepare('SELECT value FROM settings WHERE key = ?'),
  set: db.prepare(`INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};
const DEFAULTS = {
  // Before this hour, work still belongs to yesterday's trading day — which is
  // how a bartender who clocks out at 1am stays on the night they worked.
  tc_day_cutoff: '4',
  // Where café ends and dinner begins, for suggesting a service. Only ever a
  // suggestion: the employee confirms it, because guessing wrong files someone
  // against the wrong service.
  tc_dinner_from: '16',
  tc_break_paid: '0',        // breaks unpaid by default
  tc_long_shift: '16',       // hours before an open shift is worth flagging
  // Off. Somebody clocking out is holding the phone they just signed into, and
  // asking them to type the PIN again buys nothing — the punch is already
  // theirs. Available for anybody who wants a second confirmation.
  tc_pin_out: '0',
  tc_pin_fix: '1',           // and for a correction request
  tc_require_service: '1',   // must choose café or dinner at clock-in
  tc_alerts: '1',            // surface time-clock items on the dashboard
};
const setting = (k) => { const r = sq.get.get(k); return r === undefined ? DEFAULTS[k] : r.value; };
const settings = () => ({
  cutoffHour: Number(setting('tc_day_cutoff')) || 0,
  dinnerFrom: Number(setting('tc_dinner_from')) || 16,
  breaksPaid: setting('tc_break_paid') === '1',
  longShift: Number(setting('tc_long_shift')) || 16,
  pinAtOut: setting('tc_pin_out') === '1',
  pinForFix: setting('tc_pin_fix') === '1',
  requireService: setting('tc_require_service') === '1',
  alertsOn: setting('tc_alerts') === '1',
});
const saveSettings = (v) => {
  const clamp = (x, lo, hi, d) => { const n = Math.round(Number(x)); return isFinite(n) && n >= lo && n <= hi ? n : d; };
  const flag = (x) => (x ? '1' : '0');
  sq.set.run({ key: 'tc_day_cutoff', value: String(clamp(v.cutoffHour, 0, 12, 4)) });
  sq.set.run({ key: 'tc_dinner_from', value: String(clamp(v.dinnerFrom, 0, 23, 16)) });
  sq.set.run({ key: 'tc_long_shift', value: String(clamp(v.longShift, 4, 24, 16)) });
  sq.set.run({ key: 'tc_break_paid', value: flag(v.breaksPaid) });
  sq.set.run({ key: 'tc_pin_out', value: flag(v.pinAtOut) });
  sq.set.run({ key: 'tc_pin_fix', value: flag(v.pinForFix) });
  sq.set.run({ key: 'tc_require_service', value: flag(v.requireService) });
  sq.set.run({ key: 'tc_alerts', value: flag(v.alertsOn) });
};

// --- time helpers ----------------------------------------------------------
/** Now, as the server sees it, in the shape SQLite stores. Never the client's. */
const nowUtc = () => db.prepare("SELECT datetime('now') AS t").get().t;
/** A stored UTC stamp as a JS Date. */
const toDate = (utc) => (utc ? new Date(String(utc).replace(' ', 'T') + 'Z') : null);
/** Whole minutes between two stored stamps. */
function minutesBetween(a, b) {
  const A = toDate(a), B = toDate(b);
  if (!A || !B) return null;
  return Math.max(0, Math.round((B - A) / 60000));
}
/**
 * The trading day a moment belongs to. Local time, with an early-morning
 * cutoff so a shift that runs past midnight stays on the day it started.
 */
function businessDateOf(utc, cutoffHour) {
  const d = toDate(utc) || new Date();
  const local = new Date(d.toLocaleString('en-US', { timeZone: process.env.TZ || 'America/New_York' }));
  const iso = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  return local.getHours() < (cutoffHour || 0) ? addDays(iso, -1) : iso;
}
/** Which service a moment falls in — a suggestion the employee confirms. */
const suggestDaypart = (utc, dinnerFrom) => {
  const d = toDate(utc) || new Date();
  const local = new Date(d.toLocaleString('en-US', { timeZone: process.env.TZ || 'America/New_York' }));
  return local.getHours() >= (dinnerFrom || 16) ? 'dinner' : 'cafe';
};
// Formatters built ONCE, not per call.
//
// Passing an options object to toLocaleTimeString makes V8 resolve a fresh
// Intl.DateTimeFormat every time — measured at 23µs a call against 1.4µs for a
// cached one producing the identical string. That is invisible on a detail page
// and ruinous on a ledger: rebuilding one shipped row builder over 7,300 entries
// took 2.4 seconds this way and 125ms cached.
//
// process.env.TZ does not change while the server is up, so module scope is
// safe. The || fallback matches every other timezone read in this file.
// Named LOCAL_TZ, not TZ: there is already a TZ() below, used by the
// wall-clock-to-UTC conversion, and it is a function rather than a string.
const LOCAL_TZ = process.env.TZ || 'America/New_York';
const FMT_TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: LOCAL_TZ });
const FMT_STAMP = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: LOCAL_TZ });
const FMT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Local clock face for a stored stamp: "5:42 PM". */
const clockFace = (utc) => (utc ? FMT_TIME.format(toDate(utc)) : '—');
/**
 * A stored UTC stamp as local date and time: "Jul 28, 2:55 AM".
 * Audit rows have to read in the same timezone as the punches beside them, or
 * a manager comparing the two sees a four-hour gap that is not there.
 */
const stamp = (utc) => (utc ? FMT_STAMP.format(toDate(utc)) : '—');
/**
 * A business date as "Mon, Jul 28". Formatted in UTC deliberately: a business
 * date is already a plain calendar day with no time in it, so re-interpreting
 * it in a western timezone would step it back to the day before.
 */
const dayLabel = (isoDay) => (isoDay ? FMT_DAY.format(new Date(isoDay + 'T12:00:00Z')) : '—');

/** Minutes as "6h 12m" / "48m". */
function hm(min) {
  if (min == null) return '—';
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
/** Minutes as decimal hours, the unit the rest of Zwin speaks. */
const toHours = (min) => (min == null ? null : Math.round((min / 60) * 100) / 100);

// A manager types local wall-clock time; the DB keeps UTC. These two are the
// only place that conversion happens, so a correction cannot drift by an hour
// because one screen forgot the timezone.
const TZ = () => process.env.TZ || 'America/New_York';
/** '2026-07-27T17:30' (local) → '2026-07-27 21:30:00' (UTC, as stored). */
function localInputToUtc(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi] = m.map(Number);
  // Find the UTC instant whose local rendering equals what was typed. Doing it
  // by probe rather than by a fixed offset keeps it right across DST.
  let guess = Date.UTC(Y, Mo - 1, D, H, Mi);
  for (let i = 0; i < 3; i++) {
    const shown = new Date(new Date(guess).toLocaleString('en-US', { timeZone: TZ() }));
    const want = new Date(Y, Mo - 1, D, H, Mi);
    const drift = want - shown;
    if (!drift) break;
    guess += drift;
  }
  const d = new Date(guess);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
}
/** Stored UTC → the value a datetime-local input wants, in local time. */
function utcToLocalInput(utc) {
  const d = toDate(utc);
  if (!d) return '';
  const l = new Date(d.toLocaleString('en-US', { timeZone: TZ() }));
  const p = (n) => String(n).padStart(2, '0');
  return `${l.getFullYear()}-${p(l.getMonth() + 1)}-${p(l.getDate())}T${p(l.getHours())}:${p(l.getMinutes())}`;
}

// --- queries ---------------------------------------------------------------
const q = {
  active: db.prepare("SELECT * FROM time_entries WHERE employee_id = ? AND status IN ('active','on_break')"),
  byId: db.prepare('SELECT * FROM time_entries WHERE id = ?'),
  forEmployeeSince: db.prepare(`SELECT * FROM time_entries WHERE employee_id = ? AND business_date >= ?
    ORDER BY business_date DESC, clock_in_at DESC`),
  forDate: db.prepare('SELECT * FROM time_entries WHERE business_date = ? ORDER BY clock_in_at'),
  inRange: db.prepare(`SELECT * FROM time_entries WHERE business_date >= ? AND business_date <= ?
    ORDER BY business_date DESC, clock_in_at DESC`),
  allActive: db.prepare("SELECT * FROM time_entries WHERE status IN ('active','on_break') ORDER BY clock_in_at"),
  openEntry: db.prepare(`INSERT INTO time_entries
    (employee_id, shift_id, business_date, daypart, position, clock_in_at, status, source, created_by)
    VALUES (@employee_id, @shift_id, @business_date, @daypart, @position, @clock_in_at, 'active', @source, @created_by)`),
  // A back-dated punch that is already finished goes straight in as complete.
  // Inserting it as 'active' first would collide with the one-active-entry
  // index for anybody who happens to be on the clock right now — which is
  // exactly when a manager is most likely to be fixing yesterday.
  addClosedEntry: db.prepare(`INSERT INTO time_entries
    (employee_id, shift_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source,
     raw_minutes, paid_break_min, unpaid_break_min, payable_minutes, created_by, updated_at, updated_by)
    VALUES (@employee_id, @shift_id, @business_date, @daypart, @position, @clock_in_at, @clock_out_at,
     'complete', @source, @raw, 0, 0, @payable, @created_by, datetime('now'), @created_by)`),
  closeEntry: db.prepare(`UPDATE time_entries SET clock_out_at = @out, status = 'complete',
    raw_minutes = @raw, paid_break_min = @paid, unpaid_break_min = @unpaid, payable_minutes = @payable,
    updated_at = datetime('now'), updated_by = @by WHERE id = @id`),
  setStatus: db.prepare("UPDATE time_entries SET status = @status, updated_at = datetime('now'), updated_by = @by WHERE id = @id"),
  setShift: db.prepare('UPDATE time_entries SET shift_id = @shift_id WHERE id = @id'),
  editEntry: db.prepare(`UPDATE time_entries SET clock_in_at = @in, clock_out_at = @out,
    daypart = @daypart, position = @position, edited = 1,
    updated_at = datetime('now'), updated_by = @by WHERE id = @id`),
  recompute: db.prepare(`UPDATE time_entries SET raw_minutes = @raw, paid_break_min = @paid,
    unpaid_break_min = @unpaid, payable_minutes = @payable WHERE id = @id`),

  breaks: db.prepare('SELECT * FROM time_breaks WHERE time_entry_id = ? ORDER BY start_at'),
  openBreak: db.prepare('SELECT * FROM time_breaks WHERE time_entry_id = ? AND end_at IS NULL'),
  startBreak: db.prepare(`INSERT INTO time_breaks (time_entry_id, employee_id, start_at, paid, source, created_by)
    VALUES (@time_entry_id, @employee_id, @start_at, @paid, @source, @created_by)`),
  endBreak: db.prepare('UPDATE time_breaks SET end_at = @end_at, raw_minutes = @raw WHERE id = @id'),
  breakById: db.prepare('SELECT * FROM time_breaks WHERE id = ?'),
  editBreak: db.prepare('UPDATE time_breaks SET start_at = @start_at, end_at = @end_at, paid = @paid, raw_minutes = @raw WHERE id = @id'),
  delBreak: db.prepare('DELETE FROM time_breaks WHERE id = ?'),

  addCorrection: db.prepare(`INSERT INTO time_corrections
    (time_entry_id, employee_id, kind, field, original_value, proposed_value, reason, requested_by)
    VALUES (@time_entry_id, @employee_id, @kind, @field, @original_value, @proposed_value, @reason, @requested_by)`),
  correctionsFor: db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id'),
  pendingCorrections: db.prepare("SELECT * FROM time_corrections WHERE decision = 'pending' ORDER BY id DESC"),
  decideCorrection: db.prepare(`UPDATE time_corrections SET decision = @decision, decided_by = @by,
    decided_at = datetime('now'), decision_note = @note WHERE id = @id`),
  correctionById: db.prepare('SELECT * FROM time_corrections WHERE id = ?'),

  addEvent: db.prepare(`INSERT INTO time_events (entity, entity_id, action, actor, before_val, after_val, reason)
    VALUES (@entity, @entity_id, @action, @actor, @before_val, @after_val, @reason)`),
  eventsFor: db.prepare('SELECT * FROM time_events WHERE entity = ? AND entity_id = ? ORDER BY id'),
};

/** Write one audit row. Every mutation calls this; nothing is silent. */
const logEvent = (entity, entity_id, action, actor, opts = {}) =>
  q.addEvent.run({ entity, entity_id, action, actor: actor || null,
    before_val: opts.before == null ? null : String(opts.before),
    after_val: opts.after == null ? null : String(opts.after),
    reason: opts.reason || null });

// --- derived figures -------------------------------------------------------
/**
 * Break minutes for an entry, split paid vs unpaid. An open break counts as
 * nothing until it ends — guessing at a running break would put a number on
 * the screen that changes when nobody did anything.
 */
function breakTotals(entryId) {
  let paid = 0, unpaid = 0, open = 0;
  for (const b of q.breaks.all(entryId)) {
    if (!b.end_at) { open++; continue; }
    const m = b.raw_minutes != null ? b.raw_minutes : minutesBetween(b.start_at, b.end_at);
    if (b.paid) paid += m; else unpaid += m;
  }
  return { paid, unpaid, open };
}

/**
 * Break minutes for an entry, without a query where one is not needed.
 *
 * recompute denormalizes both figures onto the row at clock-out, so a finished
 * entry already carries its own answer. The query is only genuinely required
 * while an entry is still running, where those columns have not been written
 * yet. On a ledger that is one query per row against none — measured at 164ms
 * versus 3ms over 7,300 entries.
 *
 * Takes the whole entry rather than an id, precisely so it can tell the two
 * cases apart.
 */
const breaksOn = (e) => (e && e.clock_out_at
  ? { paid: e.paid_break_min || 0, unpaid: e.unpaid_break_min || 0, open: 0 }
  : breakTotals(e.id));

/** Recompute an entry's minutes from its punches and breaks. */
function recompute(entry) {
  if (!entry.clock_out_at) return entry;
  const raw = minutesBetween(entry.clock_in_at, entry.clock_out_at);
  const { paid, unpaid } = breakTotals(entry.id);
  const payable = Math.max(0, raw - unpaid);
  q.recompute.run({ id: entry.id, raw, paid, unpaid, payable });
  return { ...entry, raw_minutes: raw, paid_break_min: paid, unpaid_break_min: unpaid, payable_minutes: payable };
}

/** Live minutes for an entry still running, so the page can show elapsed time. */
const elapsedMinutes = (entry) => minutesBetween(entry.clock_in_at, nowUtc());

// --- the shift's hours -----------------------------------------------------
// Clocked minutes ARE the shift's hours. syncShiftHours is the only thing that
// writes them, and every path that can change a punch calls it — not just
// clock-out. A missed punch fixed the next morning has to reach payroll too,
// and hooking only the one obvious place is how somebody gets paid nothing.
//
// It SUMS rather than taking one entry's figure. The unique index covers only
// OPEN entries, so nothing stops a person having several finished ones on a
// single service, and a split shift is exactly that.
//
// A punch longer than the long-shift threshold is left OUT of the sum. Somebody
// who forgot to clock out and was fixed a day later reads as 23 hours, and
// paying that silently is far worse than paying nothing: zero plus a red flag
// gets noticed and corrected, a wrong number does not.
const sumForShift = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN COALESCE(raw_minutes, 0) <= @long_min
                           THEN payable_minutes ELSE 0 END), 0) AS payable_min,
         COUNT(*)                                               AS entries,
         COALESCE(SUM(CASE WHEN COALESCE(raw_minutes, 0) > @long_min
                           THEN 1 ELSE 0 END), 0)               AS implausible,
         COUNT(DISTINCT position)                               AS positions,
         MAX(position)                                          AS a_position
    FROM time_entries
   WHERE shift_id        = @shift_id
     AND employee_id     = @employee_id
     AND clock_out_at    IS NOT NULL
     AND payable_minutes IS NOT NULL
     AND status NOT IN ('active', 'on_break')`);

const shiftRow = db.prepare('SELECT id, status FROM shifts WHERE id = ?');
const countPunches = db.prepare('SELECT COUNT(*) n FROM time_entries WHERE shift_id = ? AND employee_id = ?');
const countShiftPunches = db.prepare('SELECT COUNT(*) n FROM time_entries WHERE shift_id = ?');

/**
 * What the clock says this person worked on this shift, in minutes. Read-only,
 * and the same sum syncShiftHours writes — so any page comparing "clocked" with
 * "on the shift" compares like with like. Comparing ONE entry against work.hours
 * invented a difference for everybody who clocked out and back in.
 */
function clockedMinutesOn(shiftId, employeeId) {
  if (!shiftId || !employeeId) return null;
  const longMin = (Number(setting('tc_long_shift')) || 16) * 60;
  return sumForShift.get({ shift_id: shiftId, employee_id: employeeId, long_min: longMin }).payable_min;
}

const lastClosedFor = db.prepare(`
  SELECT * FROM time_entries
   WHERE employee_id = ? AND clock_out_at IS NOT NULL AND shift_id IS NOT NULL
   ORDER BY clock_out_at DESC LIMIT 1`);

/**
 * The punch a tip submission belongs to — the one they are still on, or the one
 * they have just come off.
 *
 * Tips are filed at the end of the shift just worked, so a punch inside the
 * window is the same night by definition. Anything older is somebody filing a
 * missed report days later, and there the date they picked is the better
 * answer than a punch that has nothing to do with it.
 */
function anchorEntryFor(employeeId, withinHours = 8) {
  const open = q.active.get(employeeId);
  if (open && open.shift_id) return open;
  const last = lastClosedFor.get(employeeId);
  if (!last) return null;
  const age = minutesBetween(last.clock_out_at, nowUtc());
  return age != null && age <= withinHours * 60 ? last : null;
}

/** Has this person any punch at all on this shift? Guards the destructive routes. */
const hasPunch = (shiftId, employeeId) => countPunches.get(shiftId, employeeId).n > 0;
/** Has anybody? Guards deleting the shift out from under its own time entries. */
const shiftHasPunches = (shiftId) => countShiftPunches.get(shiftId).n > 0;

/**
 * Re-derive one person's hours on one shift from their punches.
 *
 * Call it inside the caller's transaction — it never opens its own, so an
 * approved correction and the hours it implies land together or not at all.
 *
 * Returns { written, hours, entries, implausible, positions }. `written: false`
 * with no reason means a manager's number is sitting in that row and outranks
 * the clock; that is the override rule, and it is enforced in the SQL rather
 * than here so no caller can forget it.
 */
function syncShiftHours(shiftId, employeeId, by, opts = {}) {
  if (!shiftId || !employeeId) return { written: false, reason: 'no_shift' };
  const sh = shiftRow.get(shiftId);
  if (!sh) return { written: false, reason: 'no_shift' };

  const longMin = (Number(setting('tc_long_shift')) || 16) * 60;
  const r = sumForShift.get({ shift_id: shiftId, employee_id: employeeId, long_min: longMin });
  // Sum integer minutes, divide once. Rounding each entry and then adding drifts
  // — 211 + 241 minutes comes to 7.54h that way and 7.533h this way, and the
  // difference is multiplied by a wage. Three decimals, not two, so the figure
  // can still round-trip against the minutes the timesheet shows.
  const hours = Math.round((r.payable_min / 60) * 1000) / 1000;

  // A shift that has been emailed had its money worked out and handed over on
  // the numbers it had at the time. Nothing is snapshotted — every view
  // recomputes live — so rewriting one now would make the app quietly disagree
  // with mail already in people's inboxes. Hold, and leave a note saying so.
  if (sh.status === 'emailed') {
    logEvent('shift', shiftId, 'hours_held_sent', by, {
      after: `${hours}h clocked`,
      reason: 'shift already emailed — the hours it was sent with stand',
    });
    return { written: false, reason: 'shift_sent', hours, ...r };
  }

  if (r.entries === 0) {
    // The last punch left this shift. The hours it put here go with it.
    const gone = w.clearClockHours.run({ shift_id: shiftId, employee_id: employeeId, by });
    return { written: gone.changes > 0, hours: 0, ...r };
  }

  const info = w.setClockHours.run({
    shift_id: shiftId, employee_id: employeeId,
    role: opts.role || r.a_position || 'server', hours, by,
  });
  return { written: info.changes > 0, hours, ...r };
}

// --- the state machine -----------------------------------------------------
// Valid transitions, stated once so a route cannot invent a new one:
//   (none) --clock_in--> active
//   active --start_break--> on_break --end_break--> active
//   active --clock_out--> complete
//   complete --correct--> complete (edited)
const STATUSES = ['active', 'on_break', 'complete', 'missing_punch', 'correction_pending', 'locked'];
const isOpen = (e) => e && (e.status === 'active' || e.status === 'on_break');

/** A friendly error the routes turn into a message rather than a 500. */
class ClockError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 'invalid'; }
}

// --- overlap guards --------------------------------------------------------
// Two punches for one person cannot cover the same minute, and neither can two
// breaks on one entry. Checked before any correction lands, because an approved
// change that creates an overlap is a payroll figure counted twice.
q.overlapping = db.prepare(`SELECT * FROM time_entries
  WHERE employee_id = @employee_id AND id <> @id
    AND clock_in_at < @end
    AND (clock_out_at IS NULL OR clock_out_at > @start)`);
q.breaksOther = db.prepare('SELECT * FROM time_breaks WHERE time_entry_id = ? AND id <> ?');

/** Throws if [start,end) would collide with another entry for the same person. */
function assertNoEntryOverlap(entry, start, end) {
  const clash = q.overlapping.all({ employee_id: entry.employee_id, id: entry.id, start, end: end || '9999-12-31 23:59:59' });
  if (clash.length) {
    throw new ClockError(`That would overlap another time entry (#${clash[0].id}, `
      + `${clockFace(clash[0].clock_in_at)}–${clash[0].clock_out_at ? clockFace(clash[0].clock_out_at) : 'still open'}).`);
  }
}

/** Throws if a break would fall outside its entry or collide with another. */
function assertBreakFits(entry, breakId, start, end) {
  if (!(start < end)) throw new ClockError('A break has to end after it starts.');
  if (start < entry.clock_in_at) throw new ClockError('A break cannot start before the clock-in.');
  if (entry.clock_out_at && end > entry.clock_out_at) throw new ClockError('A break cannot end after the clock-out.');
  for (const b of q.breaksOther.all(entry.id, breakId || 0)) {
    const bEnd = b.end_at || '9999-12-31 23:59:59';
    if (start < bEnd && end > b.start_at) {
      throw new ClockError(`That would overlap another break (${clockFace(b.start_at)}–${b.end_at ? clockFace(b.end_at) : 'still running'}).`);
    }
  }
}

// --- applying an approved correction ---------------------------------------
/**
 * Carry out what a correction asked for.
 *
 * The rule this exists to enforce: an approved request is never left unapplied.
 * Approval and application happen together or not at all — the caller runs this
 * inside the same transaction that records the decision, so a change that fails
 * validation leaves the request pending with a message rather than approved and
 * quietly ignored.
 *
 * Every path writes the original value into the audit before overwriting it, so
 * the punch as first recorded is readable forever.
 *
 * @param opts.validPositions  slugs the entry may be moved to
 * @param opts.validDayparts   services the entry may be moved to
 * @param opts.relink          (entry, businessDate, daypart, position) → shiftId
 */
function applyCorrection(c, actor, opts = {}) {
  const entry = q.byId.get(c.time_entry_id);
  if (!entry) throw new ClockError('That time entry no longer exists.');
  if (entry.status === 'locked') throw new ClockError('That entry is locked — reopen it first.');
  let payload = {};
  try { payload = JSON.parse(c.payload || '{}') || {}; } catch { payload = {}; }

  const note = (action, before, after) => {
    logEvent('entry', entry.id, action, actor, { before, after, reason: `approved correction #${c.id}: ${c.reason}` });
  };
  const finish = (summary) => {
    const fresh = q.byId.get(entry.id);
    if (fresh.clock_out_at) recompute(fresh);
    db.prepare("UPDATE time_entries SET edited = 1, updated_at = datetime('now'), updated_by = @by WHERE id = @id")
      .run({ id: entry.id, by: actor });
    return summary;
  };

  switch (c.kind) {
    case 'missing_in':
    case 'wrong_in': {
      const at = payload.at;
      if (!at) throw new ClockError('That request did not include a time to set.');
      if (entry.clock_out_at && at >= entry.clock_out_at) throw new ClockError('The clock-in has to be before the clock-out.');
      assertNoEntryOverlap(entry, at, entry.clock_out_at);
      // Breaks must still sit inside the shift after the punch moves.
      for (const b of q.breaks.all(entry.id)) {
        if (b.start_at < at) throw new ClockError('A recorded break would fall before that clock-in — fix the break first.');
      }
      note('clock_in_corrected', entry.clock_in_at, at);
      db.prepare('UPDATE time_entries SET clock_in_at = ? WHERE id = ?').run(at, entry.id);
      // The trading day comes from the clock-in, so moving it can move the day —
      // a punch corrected across the early-morning cutoff belongs to the other
      // night, and to the other pay period. Re-file it exactly as the manager
      // edit route does, or the same correction gives two different records
      // depending on who made it.
      if (opts.relink) opts.relink(q.byId.get(entry.id));
      return finish(`clock-in ${clockFace(entry.clock_in_at)} → ${clockFace(at)}`);
    }
    case 'missing_out':
    case 'wrong_out': {
      const at = payload.at;
      if (!at) throw new ClockError('That request did not include a time to set.');
      if (at <= entry.clock_in_at) throw new ClockError('The clock-out has to be after the clock-in.');
      assertNoEntryOverlap(entry, entry.clock_in_at, at);
      for (const b of q.breaks.all(entry.id)) {
        if (b.end_at && b.end_at > at) throw new ClockError('A recorded break would run past that clock-out — fix the break first.');
        if (!b.end_at) throw new ClockError('A break is still open on this entry — close it first.');
      }
      note('clock_out_corrected', entry.clock_out_at || 'open', at);
      db.prepare("UPDATE time_entries SET clock_out_at = ?, status = 'complete' WHERE id = ?").run(at, entry.id);
      return finish(`clock-out ${entry.clock_out_at ? clockFace(entry.clock_out_at) : 'missing'} → ${clockFace(at)}`);
    }
    case 'missing_break': {
      const { start, end } = payload;
      if (!start || !end) throw new ClockError('That request did not include the break times.');
      assertBreakFits(entry, null, start, end);
      const paid = payload.paid ? 1 : 0;
      const info = q.startBreak.run({ time_entry_id: entry.id, employee_id: entry.employee_id,
        start_at: start, paid, source: 'manager', created_by: actor });
      q.endBreak.run({ id: info.lastInsertRowid, end_at: end, raw: minutesBetween(start, end) });
      note('break_added', null, `${clockFace(start)}–${clockFace(end)}`);
      return finish(`break added ${clockFace(start)}–${clockFace(end)}`);
    }
    case 'break': {
      const { break_id: bid, start, end } = payload;
      const b = bid ? q.breakById.get(Number(bid)) : q.breaks.all(entry.id)[0];
      if (!b || b.time_entry_id !== entry.id) throw new ClockError('That break is not on this entry.');
      if (!start || !end) throw new ClockError('That request did not include the break times.');
      assertBreakFits(entry, b.id, start, end);
      const paid = payload.paid == null ? b.paid : (payload.paid ? 1 : 0);
      note('break_corrected', `${clockFace(b.start_at)}–${b.end_at ? clockFace(b.end_at) : 'open'}`, `${clockFace(start)}–${clockFace(end)}`);
      q.editBreak.run({ id: b.id, start_at: start, end_at: end, paid, raw: minutesBetween(start, end) });
      // Correcting the break somebody was on leaves them working, not stranded.
      if (entry.status === 'on_break') q.setStatus.run({ id: entry.id, status: entry.clock_out_at ? 'complete' : 'active', by: actor });
      return finish(`break ${clockFace(start)}–${clockFace(end)}`);
    }
    case 'wrong_position': {
      const pos = payload.position;
      if (!pos || !(opts.validPositions || []).includes(pos)) throw new ClockError('That is not a position this person can work.');
      note('position_corrected', entry.position, pos);
      db.prepare('UPDATE time_entries SET position = ? WHERE id = ?').run(pos, entry.id);
      if (opts.relink) opts.relink(q.byId.get(entry.id));
      return finish(`position ${entry.position} → ${pos}`);
    }
    case 'wrong_service': {
      const dp2 = payload.daypart;
      if (!dp2 || !(opts.validDayparts || []).includes(dp2)) throw new ClockError('That is not a service that exists.');
      note('service_corrected', entry.daypart || 'none', dp2);
      db.prepare('UPDATE time_entries SET daypart = ? WHERE id = ?').run(dp2, entry.id);
      // Moving the service moves which shift this belongs to. Re-linked through
      // the same find-or-create every path uses, so no duplicate is minted.
      if (opts.relink) opts.relink(q.byId.get(entry.id));
      return finish(`service ${entry.daypart || 'none'} → ${dp2}`);
    }
    default:
      // 'other' has nothing structured to act on. Say so plainly rather than
      // marking it approved and changing nothing.
      throw new ClockError('This request has no specific change to apply — correct the entry by hand, then reject the request with a note.');
  }
}

// ===========================================================================
// TIMESHEETS — a pay period, read from the entries rather than copied from them.
// ===========================================================================
q.sheet = db.prepare('SELECT * FROM timesheets WHERE employee_id = ? AND period_start = ?');
q.sheetById = db.prepare('SELECT * FROM timesheets WHERE id = ?');
q.sheetsForPeriod = db.prepare('SELECT * FROM timesheets WHERE period_start = ?');
q.sheetsForEmployee = db.prepare('SELECT * FROM timesheets WHERE employee_id = ? ORDER BY period_start DESC');
q.makeSheet = db.prepare(`INSERT OR IGNORE INTO timesheets (employee_id, period_start, period_end)
  VALUES (@employee_id, @period_start, @period_end)`);
q.submitSheet = db.prepare(`UPDATE timesheets SET status = 'submitted', submitted_at = datetime('now'),
  submitted_note = @note, submitted_totals = @totals, resubmit_needed = 0, returned_at = NULL,
  returned_by = NULL, returned_reason = NULL WHERE id = @id`);
q.returnSheet = db.prepare(`UPDATE timesheets SET status = 'returned', returned_at = datetime('now'),
  returned_by = @by, returned_reason = @reason, resubmit_needed = 1 WHERE id = @id`);
q.markResubmit = db.prepare("UPDATE timesheets SET resubmit_needed = 1 WHERE id = @id AND status = 'submitted'");
q.entriesInPeriod = db.prepare(`SELECT * FROM time_entries WHERE employee_id = ?
  AND business_date >= ? AND business_date <= ? ORDER BY business_date, clock_in_at`);
q.pendingForEmployee = db.prepare(`SELECT c.* FROM time_corrections c
  WHERE c.employee_id = ? AND c.decision = 'pending'`);

/**
 * The row for a person and period.
 *
 * Reading does NOT create it: a view-only account opening a page must not write
 * to the database, and an untouched period needs no row to be described. The
 * row appears the moment something is actually recorded against it.
 */
function sheetFor(employeeId, period, opts = {}) {
  const found = q.sheet.get(employeeId, period.start);
  if (found) return found;
  if (!opts.create) {
    return { id: null, employee_id: employeeId, period_start: period.start, period_end: period.end,
      status: 'open', submitted_at: null, submitted_note: null, submitted_totals: null,
      returned_at: null, returned_by: null, returned_reason: null, resubmit_needed: 0, virtual: true };
  }
  q.makeSheet.run({ employee_id: employeeId, period_start: period.start, period_end: period.end });
  return q.sheet.get(employeeId, period.start);
}

/**
 * Everything wrong with a period's time, each tied to the entry it came from.
 *
 * Blocking issues stop a submission — you cannot sign off hours that are still
 * running or contradict each other. The rest are worth saying but not worth
 * refusing over.
 */
/**
 * Every break on every entry in a span, in one query.
 *
 * issuesFor and fingerprintOf each want a per-entry break list, and the ledger
 * calls both for every employee — so once a period has been transferred, each
 * entry's breaks are fetched twice on every page load. Hand either one of these
 * maps and they stop asking.
 */
const breaksInSpanQ = db.prepare(`SELECT b.* FROM time_breaks b
    JOIN time_entries t ON t.id = b.time_entry_id
   WHERE t.business_date >= ? AND t.business_date <= ?
   ORDER BY b.start_at`);
function breaksInSpan(from, to) {
  const map = new Map();
  for (const b of breaksInSpanQ.all(from, to)) {
    const list = map.get(b.time_entry_id);
    if (list) list.push(b); else map.set(b.time_entry_id, [b]);
  }
  return map;
}
/** The pre-fetched list for an entry, or the query when no map was supplied. */
const breaksVia = (map, entryId) => (map ? (map.get(entryId) || []) : q.breaks.all(entryId));

function issuesFor(entries, corrections, breakMap) {
  const out = [];
  const add = (blocking, text, entryId) => out.push({ blocking, text, entryId });
  const sorted = entries.slice().sort((a, b) => a.clock_in_at.localeCompare(b.clock_in_at));

  for (const e of entries) {
    if (e.status === 'active' || e.status === 'on_break') {
      add(true, `Still on the clock from ${clockFace(e.clock_in_at)} on ${e.business_date}`, e.id);
    } else if (!e.clock_out_at) {
      add(true, `No clock-out on ${e.business_date}`, e.id);
    }
    if (!e.position) add(true, `No position recorded on ${e.business_date}`, e.id);
    if (!e.daypart) add(false, `No service recorded on ${e.business_date}`, e.id);
    if (e.clock_out_at && e.clock_out_at <= e.clock_in_at) add(true, `The times on ${e.business_date} do not make sense`, e.id);
    if (e.raw_minutes != null && e.raw_minutes < 0) add(true, `Negative duration on ${e.business_date}`, e.id);
    const brs = breaksVia(breakMap, e.id);
    for (const b of brs) if (!b.end_at) add(true, `A break is still open on ${e.business_date}`, e.id);
    // Breaks that cover the same minute twice.
    const done = brs.filter((b) => b.end_at).sort((a, b) => a.start_at.localeCompare(b.start_at));
    for (let i = 1; i < done.length; i++) {
      if (done[i].start_at < done[i - 1].end_at) add(true, `Two breaks overlap on ${e.business_date}`, e.id);
    }
  }
  // Entries that cover the same minute twice.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.clock_out_at && sorted[i].clock_in_at < prev.clock_out_at) {
      add(true, `Two entries overlap on ${sorted[i].business_date}`, sorted[i].id);
    }
  }
  for (const c of corrections) {
    if (c.decision !== 'pending') continue;
    if (c.apply_error) add(true, `A correction could not be applied: ${c.apply_error}`, c.time_entry_id);
    else add(true, `A correction is still waiting on your manager (${String(c.kind).replace(/_/g, ' ')})`, c.time_entry_id);
  }
  return out;
}

/**
 * A period's totals for one person. Overtime is computed for DISPLAY only, and
 * only when the owner has overtime switched on — the payroll toggle stays the
 * authority and nothing here is pushed into pay.
 */
function totalsFor(entries, opts = {}) {
  let raw = 0, paid = 0, unpaid = 0, payable = 0;
  for (const e of entries) {
    if (!e.clock_out_at) continue;              // still running: not countable yet
    raw += e.raw_minutes || 0;
    paid += e.paid_break_min || 0;
    unpaid += e.unpaid_break_min || 0;
    payable += e.payable_minutes || 0;
  }
  // Weekly overtime, measured per workweek the way payroll does it — never
  // per period, never per day.
  let overtime = 0;
  if (opts.otEnabled && !opts.otExempt && opts.periodStart) {
    const week = new Map();
    for (const e of entries) {
      if (!e.clock_out_at) continue;
      const days = Math.floor((new Date(e.business_date) - new Date(opts.periodStart)) / 86400000);
      const wk = days < 7 ? 0 : 1;
      week.set(wk, (week.get(wk) || 0) + (e.payable_minutes || 0));
    }
    const threshold = (opts.otThreshold || 40) * 60;
    for (const mins of week.values()) if (mins > threshold) overtime += mins - threshold;
  }
  return { raw, paid, unpaid, payable, overtime, regular: Math.max(0, payable - overtime) };
}

/** Group a period's entries by business date, newest first. */
function byDay(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!m.has(e.business_date)) m.set(e.business_date, []);
    m.get(e.business_date).push(e);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

/** What a timesheet's status should read as right now. */
function sheetStatus(sheet, issues) {
  // Approved and locked are decisions, not derivations — they stand until
  // somebody reopens them.
  if (sheet.status === 'approved' || sheet.status === 'locked' || sheet.status === 'finalized') return sheet.status;
  if (sheet.status === 'returned') return 'returned';
  if (sheet.status === 'submitted') return sheet.resubmit_needed ? 'needs_attention' : 'submitted';
  return issues.some((i) => i.blocking) ? 'needs_attention' : 'open';
}
const SHEET_LABEL = {
  open: 'Open', needs_attention: 'Needs attention', submitted: 'Submitted',
  returned: 'Returned', approved: 'Approved', locked: 'Locked', transferred: 'Transferred',
  finalized: 'Finalized',
};

// --- approval and transfer -------------------------------------------------
q.addApproval = db.prepare(`INSERT INTO timesheet_approvals
  (timesheet_id, employee_id, period_start, period_end, approved_by, note,
   regular_min, overtime_min, payable_min, paid_break_min, unpaid_break_min,
   ot_enabled, ot_exempt, fingerprint, override_reason)
  VALUES (@timesheet_id, @employee_id, @period_start, @period_end, @approved_by, @note,
   @regular_min, @overtime_min, @payable_min, @paid_break_min, @unpaid_break_min,
   @ot_enabled, @ot_exempt, @fingerprint, @override_reason)`);
q.approvalsFor = db.prepare('SELECT * FROM timesheet_approvals WHERE timesheet_id = ? ORDER BY id DESC');
q.currentApproval = db.prepare("SELECT * FROM timesheet_approvals WHERE timesheet_id = ? AND state = 'current' ORDER BY id DESC LIMIT 1");
q.supersedeApprovals = db.prepare(`UPDATE timesheet_approvals SET state = 'superseded',
  superseded_at = datetime('now'), superseded_by = @by, superseded_reason = @reason
  WHERE timesheet_id = @timesheet_id AND state = 'current'`);
q.addTransfer = db.prepare(`INSERT INTO payroll_transfers
  (approval_id, timesheet_id, employee_id, period_start, period_end, regular_min, overtime_min,
   payable_min, ot_enabled, wage_rate_cents, est_gross_cents, fingerprint, transferred_by)
  VALUES (@approval_id, @timesheet_id, @employee_id, @period_start, @period_end, @regular_min,
   @overtime_min, @payable_min, @ot_enabled, @wage_rate_cents, @est_gross_cents, @fingerprint, @transferred_by)`);
q.transfersFor = db.prepare('SELECT * FROM payroll_transfers WHERE timesheet_id = ? ORDER BY id DESC');
q.currentTransfer = db.prepare("SELECT * FROM payroll_transfers WHERE timesheet_id = ? AND state = 'current' ORDER BY id DESC LIMIT 1");
q.supersedeTransfers = db.prepare(`UPDATE payroll_transfers SET state = 'superseded',
  superseded_at = datetime('now'), superseded_by = @by WHERE timesheet_id = @timesheet_id AND state = 'current'`);
q.transfersInPeriod = db.prepare("SELECT * FROM payroll_transfers WHERE period_start = ? AND state = 'current'");
q.setSheetApproved = db.prepare(`UPDATE timesheets SET status = 'approved', approved_at = datetime('now'),
  approved_by = @by, resubmit_needed = 0 WHERE id = @id`);
q.setSheetLocked = db.prepare("UPDATE timesheets SET status = 'locked', locked_at = datetime('now'), locked_by = @by WHERE id = @id");
q.reopenSheet = db.prepare(`UPDATE timesheets SET status = @status, reopened_at = datetime('now'),
  reopened_by = @by, reopen_reason = @reason, approved_at = NULL, approved_by = NULL,
  locked_at = NULL, locked_by = NULL WHERE id = @id`);
q.setTransferState = db.prepare('UPDATE timesheets SET transfer_state = @state WHERE id = @id');
q.markTransferred = db.prepare(`UPDATE timesheets SET transfer_state = 'transferred',
  transferred_at = datetime('now'), transferred_by = @by WHERE id = @id`);

/**
 * What the approved hours are MADE OF, as one short string.
 *
 * Comparing this to the value stored on an approval answers "has anything moved
 * since?" exactly — a punch edited, a break added, an entry deleted — without
 * having to diff the whole period. It is the mechanism behind
 * "changed after transfer".
 */
function fingerprintOf(entries, breakMap) {
  const parts = entries.slice().sort((a, b) => a.id - b.id).map((e) => {
    const brs = breaksVia(breakMap, e.id).map((b) => `${b.start_at}~${b.end_at || ''}~${b.paid}`).join(',');
    return `${e.id}:${e.clock_in_at}:${e.clock_out_at || ''}:${e.position}:${e.daypart || ''}:${brs}`;
  });
  return require('crypto').createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * Why a timesheet cannot be approved yet. Empty means it can.
 *
 * Approval is a statement that these hours are right, so it is refused while
 * anything is still moving or contradicts itself. An editor may push past a
 * non-structural objection, but only by naming a reason that is recorded.
 */
function approvalBlockers(sheet, issues) {
  const out = [];
  if (!sheet || sheet.id == null) out.push('The employee has not submitted this timesheet.');
  else if (sheet.status === 'approved') out.push('Already approved.');
  else if (sheet.status === 'locked') out.push('Locked — reopen it first.');
  else if (sheet.status !== 'submitted') out.push('The employee has not submitted this timesheet.');
  else if (sheet.resubmit_needed) out.push('The hours changed after it was submitted — it needs signing again.');
  for (const i of issues) if (i.blocking) out.push(i.text);
  return out;
}

/** Has anything moved since this approval was given? */
const approvalStale = (approval, entries, breakMap) =>
  !!approval && approval.fingerprint !== fingerprintOf(entries, breakMap);

/** The transfer state a sheet should be showing, given what has happened. */
function transferStateOf(sheet, approval, transfer, entries, breakMap) {
  if (!sheet || sheet.id == null) return 'not_ready';
  if (sheet.status === 'finalized') return 'finalized';
  if (!transfer) return (sheet.status === 'approved' || sheet.status === 'locked') ? 'ready' : 'not_ready';
  // Transferred, then something moved: payroll is working from stale hours.
  if (transfer.fingerprint !== fingerprintOf(entries, breakMap)) return 'changed_after_transfer';
  // Reopening supersedes every approval on the sheet, so a transferred sheet
  // with NO current approval is one that was reopened after being sent. The
  // guard used to be `approval && …`, which is false in exactly that case — so
  // the function fell through and painted a green "sent" tag, while the
  // dashboard alert, which reads the stored column instead, was saying the same
  // sheet needed recalculating. Two screens, one sheet, opposite answers.
  if (!approval || transfer.approval_id !== approval.id) return 'needs_recalculation';
  // The stored column wins where it is the more pessimistic of the two: it is
  // written by the routes that know something happened.
  if (sheet.transfer_state === 'needs_recalculation') return 'needs_recalculation';
  return 'transferred';
}
const TRANSFER_LABEL = {
  not_ready: 'Not ready', ready: 'Ready to transfer', transferred: 'Transferred',
  changed_after_transfer: 'Changed after transfer', needs_recalculation: 'Needs recalculation',
  finalized: 'Finalized',
};

/**
 * What needs a person's hands right now, and nothing else.
 *
 * Deliberately not a feed of everything that happened: a clock-in is not news,
 * and a dashboard that reports normal work teaches people to ignore it. Only
 * states somebody has to DO something about appear here, each already carrying
 * the link to the thing that fixes it.
 */
function alerts({ periods, employees, otRule } = {}) {
  const out = [];
  const cfg = settings();
  const now = nowUtc();
  const push = (severity, text, href, detail) => out.push({ severity, text, href, detail });

  // Still on the clock long past any believable shift.
  const open = q.allActive.all();
  const longHours = Number(setting('tc_long_shift')) || 16;
  const stale = open.filter((e) => minutesBetween(e.clock_in_at, now) > longHours * 60);
  if (stale.length) {
    push('bad', `${stale.length} ${stale.length === 1 ? 'person is' : 'people are'} still clocked in past ${longHours} hours`,
      '/timeclock', stale.map((e) => e.id).join(','));
  }
  const onBreak = open.filter((e) => e.status === 'on_break'
    && (q.openBreak.get(e.id) ? minutesBetween(q.openBreak.get(e.id).start_at, now) > 90 : false));
  if (onBreak.length) push('warn', `${onBreak.length} break${onBreak.length === 1 ? '' : 's'} left running over 90 minutes`, '/timeclock');

  // Punches that cannot be paid as they stand.
  const missing = db.prepare(`SELECT COUNT(*) n FROM time_entries
    WHERE status = 'missing_punch' OR (clock_out_at IS NULL AND status NOT IN ('active','on_break'))`).get().n;
  if (missing) push('warn', `${missing} time ${missing === 1 ? 'entry is' : 'entries are'} missing a punch`, '/timeclock?st=missing_punch');

  const pending = q.pendingCorrections.all();
  if (pending.length) push('warn', `${pending.length} correction request${pending.length === 1 ? '' : 's'} to review`,
    pending.length === 1 ? `/timeclock/${pending[0].time_entry_id}` : '/timeclock');

  // The pay-period picture: only the parts waiting on somebody.
  const per = (periods && periods[0]) || null;
  if (per) {
    const sheets = q.sheetsForPeriod.all(per.start);
    const submitted = sheets.filter((s) => s.status === 'submitted' && !s.resubmit_needed).length;
    const returned = sheets.filter((s) => s.status === 'returned').length;
    const readyToSend = sheets.filter((s) => ['approved', 'locked'].includes(s.status) && s.transfer_state === 'ready').length;
    const stale2 = sheets.filter((s) => ['changed_after_transfer', 'needs_recalculation'].includes(s.transfer_state)).length;
    if (stale2) push('bad', `${stale2} payroll ${stale2 === 1 ? 'record needs' : 'records need'} recalculating`, `/payroll/timesheets?p=${per.start}`);
    if (submitted) push('warn', `${submitted} timesheet${submitted === 1 ? '' : 's'} awaiting approval`, `/payroll/timesheets?p=${per.start}`);
    if (readyToSend) push('info', `${readyToSend} approved timesheet${readyToSend === 1 ? '' : 's'} ready for payroll`, `/payroll/timesheets?p=${per.start}`);
    if (returned) push('info', `${returned} timesheet${returned === 1 ? '' : 's'} sent back and not yet resubmitted`, `/payroll/timesheets?p=${per.start}`);

    // Approaching overtime, but only when overtime is actually switched on —
    // a warning about a rule you do not use is noise.
    if (otRule && otRule.enabled) {
      const near = [];
      for (const emp of employees || []) {
        if (emp.ot_exempt) continue;
        const t = totalsFor(q.entriesInPeriod.all(emp.id, per.start, per.end), {});
        const weekMin = t.payable;                       // period-to-date
        const threshold = (otRule.threshold || 40) * 60;
        if (weekMin >= threshold * 0.9 && weekMin < threshold * 2) near.push(`${emp.name} ${toHours(weekMin)}h`);
      }
      if (near.length) push('warn', `${near.length} approaching overtime`, '/payroll/timesheets', near.join(' · '));
    }
  }
  return out;
}

// --- one-shot backfill -----------------------------------------------------
// Rows nobody ever set, on shifts not yet sent, where the clock does have a
// finished punch. These are precisely the case this change exists to remove:
// the clock recorded the hours, no one typed them, and the person is being paid
// $0 and carrying no weight in any tip pool.
//
// It goes through syncShiftHours rather than one bulk UPDATE, so the two rules
// that matter apply here as everywhere else — a number somebody typed is never
// touched, and a shift already emailed is left exactly as it was sent.
//
// The `hours_source IS NULL` join is the whole safety rule: the migration
// stamped every pre-existing figure 'legacy', so only genuinely-unset rows are
// even considered.
function backfillShiftHours() {
  if (setting('tc_hours_backfilled') === '1') return { pairs: 0, done: 0, held: 0 };
  const pairs = db.prepare(`
    SELECT DISTINCT te.shift_id, te.employee_id
      FROM time_entries te
      JOIN work wk ON wk.shift_id = te.shift_id AND wk.employee_id = te.employee_id
     WHERE te.shift_id     IS NOT NULL
       AND te.clock_out_at IS NOT NULL
       AND wk.hours_source IS NULL`).all();
  let done = 0, held = 0;
  db.transaction(() => {
    for (const p of pairs) {
      if (syncShiftHours(p.shift_id, p.employee_id, 'backfill').written) done++; else held++;
    }
    sq.set.run({ key: 'tc_hours_backfilled', value: '1' });
  })();
  return { pairs: pairs.length, done, held };
}

const backfilled = backfillShiftHours();
if (backfilled.done) {
  console.log(`[timeclock] filled hours on ${backfilled.done} shift row${backfilled.done === 1 ? '' : 's'} from existing punches`
    + (backfilled.held ? `; ${backfilled.held} left alone (already sent, or set by hand)` : ''));
}

module.exports = {
  sheetFor, issuesFor, totalsFor, byDay, sheetStatus, SHEET_LABEL, alerts, setting,
  fingerprintOf, approvalBlockers, approvalStale, transferStateOf, TRANSFER_LABEL,
  q, settings, saveSettings, nowUtc, toDate, minutesBetween, businessDateOf, suggestDaypart,
  clockFace, stamp, dayLabel, hm, toHours, breakTotals, breaksOn, recompute, elapsedMinutes, logEvent,
  localInputToUtc, utcToLocalInput,
  STATUSES, isOpen, ClockError, DEFAULTS,
  applyCorrection, assertNoEntryOverlap, assertBreakFits,
  syncShiftHours, hasPunch, shiftHasPunches, anchorEntryFor, clockedMinutesOn,
  backfillShiftHours,
};
