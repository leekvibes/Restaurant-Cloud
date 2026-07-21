'use strict';

// ---------------------------------------------------------------------------
// CASH RECONCILIATION.
//
// Three amounts that are easy to confuse and must never be conflated:
//
//   counted    what is physically in the drawer at close, before anything is
//              removed. This is what variance is measured against.
//   ending     what is left in the register for tomorrow. Defaults to the
//              drawer's opening float.
//   deposit    counted - ending. What goes to the safe or the bank.
//
//   expected = opening float + cash sales + cash added - paid outs
//   variance = counted - expected            (negative is short)
//   deposit  = counted - ending float
//
// The deposit comes off what was ACTUALLY counted, not what was expected. A
// drawer that came up $20 over deposits $20 more; that is the point of
// counting it.
//
// Money is integer cents everywhere. The existing table is extended rather
// than replaced: it holds real reconciliations, their ids may be linked from
// elsewhere, and a table swap to gain columns is a risk with no return.
// ---------------------------------------------------------------------------

const { db } = require('./db');
// settings lives in periods.js and products.js declares it too; the tolerance
// and default float are stored there.
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);');

// This module owns the table now, so it creates it. Depending on server.js
// having run first meant cash.js could not be loaded on its own — by a test,
// a script, or any future entry point — which is the same boot-order trap
// that stopped Products deploying.
db.exec(`CREATE TABLE IF NOT EXISTS cash_recon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, daypart TEXT NOT NULL,
  float_cents INTEGER DEFAULT 0, cash_sales_cents INTEGER DEFAULT 0,
  paid_out_cents INTEGER DEFAULT 0, counted_cents INTEGER DEFAULT 0,
  closed_by TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

const cols = () => db.prepare('PRAGMA table_info(cash_recon)').all().map((c) => c.name);
const add = (name, decl) => { if (!cols().includes(name)) db.exec(`ALTER TABLE cash_recon ADD COLUMN ${name} ${decl}`); };

add('location', "TEXT DEFAULT 'Palm Vintage'");
add('drawer_id', 'INTEGER');
add('shift_id', 'INTEGER');
add('cash_added_cents', 'INTEGER NOT NULL DEFAULT 0');
add('ending_float_cents', 'INTEGER');
add('actual_deposit_cents', 'INTEGER');
add('deposit_destination', 'TEXT');
add('deposit_reference', 'TEXT');
add('deposit_bag', 'TEXT');
add('counted_by', 'TEXT');
add('verified_by', 'TEXT');
add('status', "TEXT NOT NULL DEFAULT 'final'");
add('variance_note', 'TEXT');
add('override_reason', 'TEXT');
add('float_override_reason', 'TEXT');
add('finalized_at', 'TEXT');
add('created_by', 'TEXT');
add('voided_at', 'TEXT');
add('voided_by', 'TEXT');
add('void_reason', 'TEXT');
// Rows that pre-date this module. Their counted figure means cash before
// deposit — confirmed against the variances the old page and the dashboard
// were already reporting — but they never recorded an ending float or a
// deposit, so those stay null rather than being invented.
add('legacy', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS cash_drawers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location TEXT NOT NULL DEFAULT 'Palm Vintage',
  name TEXT NOT NULL,
  code TEXT,
  default_float_cents INTEGER NOT NULL DEFAULT 20000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Individual paid-outs and cash added. The reconciliation keeps totals for
-- speed; these are what the totals are made of, so "where did $120 go" has an
-- answer.
CREATE TABLE IF NOT EXISTS cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_id INTEGER NOT NULL REFERENCES cash_recon(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  recipient TEXT,
  notes TEXT,
  attachment TEXT,
  occurred_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cm_recon ON cash_movements (recon_id);

CREATE TABLE IF NOT EXISTS cash_denoms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_id INTEGER NOT NULL REFERENCES cash_recon(id) ON DELETE CASCADE,
  denom_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cd_recon ON cash_denoms (recon_id);

-- Financial records do not get edited quietly.
CREATE TABLE IF NOT EXISTS cash_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_id INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ca_recon ON cash_audit (recon_id, created_at DESC);
`);

// --- settings ---------------------------------------------------------------
const setting = (key, fallback) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
};
const setSetting = (key, value) =>
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));

/** Palm Vintage opens on $200. Configurable, not compiled in. */
const defaultFloat = () => Number(setting('cash_default_float', 20000)) || 20000;
/** Variance bands. A $2 difference is not an incident. */
const tolerance = () => ({
  minor: Number(setting('cash_tol_minor', 500)) || 500,
  critical: Number(setting('cash_tol_critical', 2500)) || 2500,
});

const MOVEMENT_TYPES = [
  ['paid_out', 'Paid out / removed'], ['cash_added', 'Cash added'],
  ['safe_drop', 'Safe drop'], ['transfer_in', 'Transfer in'],
  ['transfer_out', 'Transfer out'], ['adjustment', 'Adjustment'],
];
const PAID_REASONS = ['Employee reimbursement', 'Store purchase', 'Vendor payment', 'Petty cash', 'Safe drop', 'Other'];
const ADDED_REASONS = ['Change added to drawer', 'Cash correction', 'Register transfer', 'Other'];
const DESTINATIONS = ['Safe', 'Bank', 'Other'];
const DENOMS = [10000, 5000, 2000, 1000, 500, 200, 100, 25, 10, 5, 1];
const DENOM_LABEL = { 10000: '$100', 5000: '$50', 2000: '$20', 1000: '$10', 500: '$5', 200: '$2', 100: '$1', 25: '25¢', 10: '10¢', 5: '5¢', 1: '1¢' };

// --- the sums ---------------------------------------------------------------

/**
 * Every derived figure for a reconciliation. Pure — takes a row, returns
 * numbers. Nothing here is stored, so a corrected paid-out changes the
 * variance immediately instead of leaving a stale total behind.
 */
function compute(row) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const opening = n(row.float_cents);
  const sales = n(row.cash_sales_cents);
  const paidOut = n(row.paid_out_cents);
  const added = n(row.cash_added_cents);
  const expected = opening + sales + added - paidOut;

  const counted = row.counted_cents == null ? null : n(row.counted_cents);
  const variance = counted == null ? null : counted - expected;

  const ending = row.ending_float_cents == null ? null : n(row.ending_float_cents);
  const calcDeposit = counted == null || ending == null ? null : counted - ending;
  const actualDeposit = row.actual_deposit_cents == null ? null : n(row.actual_deposit_cents);
  // If someone banked less than the drawer said to, the difference is real
  // money that is unaccounted for. It gets its own number rather than being
  // folded into variance, which is a different question.
  const unaccounted = calcDeposit == null || actualDeposit == null ? null : calcDeposit - actualDeposit;

  return { opening, sales, paidOut, added, expected, counted, variance, ending, calcDeposit, actualDeposit, unaccounted };
}

/** Exact / within tolerance / needs review / critical, and how to say it. */
function status(row) {
  if (row.status === 'void') return { key: 'void', label: 'Voided', cls: 's-none' };
  if (row.status === 'draft') return { key: 'draft', label: 'Draft', cls: 's-none' };
  const c = compute(row);
  if (c.counted == null) return { key: 'draft', label: 'Not counted', cls: 's-none' };
  const t = tolerance();
  const v = c.variance;
  if (v === 0) return { key: 'exact', label: 'Exact', cls: 's-done' };
  const over = v > 0;
  const mag = Math.abs(v);
  if (mag <= t.minor) return { key: 'within', label: `${money(mag)} ${over ? 'over' : 'short'}`, cls: 's-sched' };
  if (mag <= t.critical) return { key: 'review', label: `${money(mag)} ${over ? 'over' : 'short'}`, cls: 's-soon' };
  return { key: 'critical', label: `${money(mag)} ${over ? 'over' : 'short'}`, cls: 's-over' };
}

const money = (cents) => {
  const neg = cents < 0;
  const v = Math.abs(Math.round(cents));
  return (neg ? '-$' : '$') + (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// --- queries ----------------------------------------------------------------
const q = {
  all: db.prepare('SELECT * FROM cash_recon ORDER BY date DESC, id DESC'),
  one: db.prepare('SELECT * FROM cash_recon WHERE id = ?'),
  // For the dashboard alert. Drafts are not finished counts and voids have
  // been withdrawn, so neither should be raising anything.
  recent: db.prepare("SELECT * FROM cash_recon WHERE status = 'final' ORDER BY date DESC, id DESC LIMIT 90"),
  inRange: db.prepare('SELECT * FROM cash_recon WHERE date >= ? AND date <= ? ORDER BY date DESC, id DESC'),
  add: db.prepare(`INSERT INTO cash_recon
    (date, daypart, location, drawer_id, float_cents, cash_sales_cents, paid_out_cents, cash_added_cents,
     counted_cents, ending_float_cents, actual_deposit_cents, deposit_destination, deposit_reference, deposit_bag,
     counted_by, verified_by, closed_by, status, note, variance_note, override_reason, float_override_reason,
     finalized_at, created_by)
    VALUES (@date, @daypart, @location, @drawer_id, @float_cents, @cash_sales_cents, @paid_out_cents, @cash_added_cents,
     @counted_cents, @ending_float_cents, @actual_deposit_cents, @deposit_destination, @deposit_reference, @deposit_bag,
     @counted_by, @verified_by, @closed_by, @status, @note, @variance_note, @override_reason, @float_override_reason,
     @finalized_at, @created_by)`),
  update: db.prepare(`UPDATE cash_recon SET date=@date, daypart=@daypart, location=@location, drawer_id=@drawer_id,
    float_cents=@float_cents, cash_sales_cents=@cash_sales_cents, paid_out_cents=@paid_out_cents,
    cash_added_cents=@cash_added_cents, counted_cents=@counted_cents, ending_float_cents=@ending_float_cents,
    actual_deposit_cents=@actual_deposit_cents, deposit_destination=@deposit_destination,
    deposit_reference=@deposit_reference, deposit_bag=@deposit_bag, counted_by=@counted_by, verified_by=@verified_by,
    closed_by=@closed_by, status=@status, note=@note, variance_note=@variance_note, override_reason=@override_reason,
    float_override_reason=@float_override_reason, finalized_at=@finalized_at WHERE id=@id`),
  del: db.prepare('DELETE FROM cash_recon WHERE id = ?'),
  voidIt: db.prepare("UPDATE cash_recon SET status='void', voided_at=datetime('now'), voided_by=?, void_reason=? WHERE id=?"),

  movements: db.prepare('SELECT * FROM cash_movements WHERE recon_id = ? ORDER BY id'),
  addMovement: db.prepare(`INSERT INTO cash_movements (recon_id, movement_type, amount_cents, reason, recipient, notes, occurred_at, created_by)
    VALUES (@recon_id, @movement_type, @amount_cents, @reason, @recipient, @notes, @occurred_at, @created_by)`),
  clearMovements: db.prepare('DELETE FROM cash_movements WHERE recon_id = ?'),

  denoms: db.prepare('SELECT * FROM cash_denoms WHERE recon_id = ? ORDER BY denom_cents DESC'),
  addDenom: db.prepare('INSERT INTO cash_denoms (recon_id, denom_cents, qty) VALUES (?, ?, ?)'),
  clearDenoms: db.prepare('DELETE FROM cash_denoms WHERE recon_id = ?'),

  audit: db.prepare('SELECT * FROM cash_audit WHERE recon_id = ? ORDER BY id DESC'),
  addAudit: db.prepare(`INSERT INTO cash_audit (recon_id, actor, action, field, old_value, new_value, reason)
    VALUES (@recon_id, @actor, @action, @field, @old_value, @new_value, @reason)`),

  drawers: db.prepare('SELECT * FROM cash_drawers WHERE active = 1 ORDER BY name'),
};

/** Record what changed, field by field, so a finalized record has a history. */
function auditDiff(id, actor, before, after, reason) {
  const watch = ['date', 'daypart', 'float_cents', 'cash_sales_cents', 'paid_out_cents', 'cash_added_cents',
    'counted_cents', 'ending_float_cents', 'actual_deposit_cents', 'counted_by', 'status'];
  for (const f of watch) {
    const a = before ? before[f] : null, b = after[f];
    if (String(a ?? '') === String(b ?? '')) continue;
    q.addAudit.run({ recon_id: id, actor: actor || null, action: before ? 'edit' : 'create',
      field: f, old_value: a == null ? null : String(a), new_value: b == null ? null : String(b), reason: reason || null });
  }
}

// --- validation -------------------------------------------------------------
function validate(row, opts = {}) {
  const errors = [], warnings = [];
  const c = compute(row);
  const neg = (v, label) => { if (Number(v) < 0) errors.push(`${label} cannot be negative.`); };

  if (!row.date) errors.push('A reconciliation needs a date.');
  neg(row.float_cents, 'Opening float');
  neg(row.cash_sales_cents, 'Cash sales');
  neg(row.paid_out_cents, 'Paid outs');
  neg(row.cash_added_cents, 'Cash added');
  if (row.ending_float_cents != null) neg(row.ending_float_cents, 'Ending float');
  if (row.counted_cents != null) neg(row.counted_cents, 'Counted cash');
  if (row.actual_deposit_cents != null) neg(row.actual_deposit_cents, 'Deposit');

  if (row.status === 'final') {
    if (row.counted_cents == null) errors.push('Count the drawer before finalising.');
    if (!String(row.counted_by || '').trim()) errors.push('Record who counted the drawer.');
    if (c.ending != null && c.counted != null && c.ending > c.counted) {
      errors.push('You cannot leave more in the register than was counted in it.');
    }
    if (c.actualDeposit != null && c.counted != null && c.actualDeposit > c.counted) {
      errors.push('The deposit cannot be more than the cash that was counted.');
    }
    const t = tolerance();
    if (c.variance != null && Math.abs(c.variance) > t.minor && !String(row.variance_note || '').trim()) {
      errors.push(`A variance over ${money(t.minor)} needs a note explaining it.`);
    }
    if (c.unaccounted && Math.abs(c.unaccounted) > 0 && !String(row.override_reason || '').trim()) {
      errors.push(`${money(Math.abs(c.unaccounted))} is unaccounted for. Say why, or correct the deposit.`);
    }
    if (row.float_cents !== defaultFloat() && !String(row.float_override_reason || '').trim() && !opts.skipFloatReason) {
      warnings.push(`The opening float is not the usual ${money(defaultFloat())}.`);
    }
  }
  return { errors, warnings, ok: !errors.length };
}

// --- one-time setup ---------------------------------------------------------
const bootstrap = db.transaction(() => {
  if (!db.prepare('SELECT COUNT(*) n FROM cash_drawers').get().n) {
    db.prepare("INSERT INTO cash_drawers (location, name, code, default_float_cents) VALUES ('Palm Vintage','Front register','R1', ?)")
      .run(defaultFloat());
  }
  // Existing rows: their counted figure is cash BEFORE deposit. Confirmed
  // against the variances the old page and the dashboard alert were already
  // showing, so this is not a guess. What they never recorded is an ending
  // float or a deposit, and those stay null — inventing $200 would put a
  // deposit figure on a record nobody ever made one for.
  const drawer = db.prepare('SELECT id FROM cash_drawers ORDER BY id LIMIT 1').get();
  const legacy = db.prepare("SELECT * FROM cash_recon WHERE status IS NULL OR (drawer_id IS NULL AND legacy = 0)").all();
  const mark = db.prepare(`UPDATE cash_recon SET legacy=1, status='final', drawer_id=?, location='Palm Vintage',
    counted_by=COALESCE(counted_by, closed_by), finalized_at=COALESCE(finalized_at, created_at) WHERE id=?`);
  for (const r of legacy) mark.run(drawer ? drawer.id : null, r.id);
  if (legacy.length) console.log(`[cash] carried ${legacy.length} existing reconciliation${legacy.length === 1 ? '' : 's'} forward`);
});
try { bootstrap(); } catch (e) { console.error('[cash] setup skipped:', e.message); }

module.exports = {
  q, compute, status, validate, auditDiff, money,
  defaultFloat, tolerance, setSetting,
  MOVEMENT_TYPES, PAID_REASONS, ADDED_REASONS, DESTINATIONS, DENOMS, DENOM_LABEL,
};
