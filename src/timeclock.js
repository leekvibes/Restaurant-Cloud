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
//   Clocked hours run PARALLEL to work.hours. The manager's number stays the
//   manager's number (see insertWorkIfAbsent, "manager's numbers win"); clocking
//   in only links the person to the shift. Nothing here writes payroll hours.
//
// Minutes are integers throughout, the way money is cents. Hours are derived at
// the display edge, never stored as a float that drifts.
// ---------------------------------------------------------------------------

const { db } = require('./db');
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
};
const setting = (k) => { const r = sq.get.get(k); return r === undefined ? DEFAULTS[k] : r.value; };
const settings = () => ({
  cutoffHour: Number(setting('tc_day_cutoff')) || 0,
  dinnerFrom: Number(setting('tc_dinner_from')) || 16,
  breaksPaid: setting('tc_break_paid') === '1',
});
const saveSettings = ({ cutoffHour, dinnerFrom, breaksPaid }) => {
  const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return isFinite(n) && n >= lo && n <= hi ? n : d; };
  sq.set.run({ key: 'tc_day_cutoff', value: String(clamp(cutoffHour, 0, 12, 4)) });
  sq.set.run({ key: 'tc_dinner_from', value: String(clamp(dinnerFrom, 0, 23, 16)) });
  sq.set.run({ key: 'tc_break_paid', value: breaksPaid ? '1' : '0' });
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
/** Local clock face for a stored stamp: "5:42 PM". */
const clockFace = (utc) => (utc
  ? toDate(utc).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: process.env.TZ || 'America/New_York' })
  : '—');
/**
 * A stored UTC stamp as local date and time: "Jul 28, 2:55 AM".
 * Audit rows have to read in the same timezone as the punches beside them, or
 * a manager comparing the two sees a four-hour gap that is not there.
 */
const stamp = (utc) => (utc
  ? toDate(utc).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: process.env.TZ || 'America/New_York' })
  : '—');

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

module.exports = {
  q, settings, saveSettings, nowUtc, toDate, minutesBetween, businessDateOf, suggestDaypart,
  clockFace, stamp, hm, toHours, breakTotals, recompute, elapsedMinutes, logEvent,
  localInputToUtc, utcToLocalInput,
  STATUSES, isOpen, ClockError, DEFAULTS,
};
