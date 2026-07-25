'use strict';

// ---------------------------------------------------------------------------
// OVERTIME
//
// Federal rule (FLSA): a non-exempt hourly employee is paid the multiplier
// (1.5×) on hours worked over the threshold (40) in a workweek. Per WEEK, not
// per pay period and not per day — so a fortnight is two independent weeks, and
// the payroll page already splits the period into wk1 / wk2 at day seven, which
// are the two workweeks OT is measured against.
//
// It is off until switched on. While off, payroll is byte-for-byte what it was
// before this file existed: overtimeFor() is simply never called, and a person
// marked exempt is skipped even when it is on.
//
// The premium, not the whole OT wage, is what this returns. Straight time for
// every hour (including the overtime hours) is already in `wage`; overtime adds
// only the extra half on the hours above the line. So the math never
// double-counts the base, and turning it off leaves the base exactly as it was.
// ---------------------------------------------------------------------------

const { db } = require('./db');

// Reuse the shared key/value settings table other modules already made.
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');

// Whether a given employee is left out of overtime — salaried-exempt staff, or
// anyone the manager flips off by hand. A column rather than a list in code:
// the set is the owner's to change.
const empCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
if (!empCols.includes('ot_exempt')) {
  db.exec('ALTER TABLE employees ADD COLUMN ot_exempt INTEGER NOT NULL DEFAULT 0');
}

const q = {
  get: db.prepare('SELECT value FROM settings WHERE key = ?'),
  set: db.prepare(`INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  exempt: db.prepare('SELECT id FROM employees WHERE ot_exempt = 1'),
  setExempt: db.prepare('UPDATE employees SET ot_exempt = @v WHERE id = @id'),
};

const DEFAULTS = { enabled: false, threshold: 40, multiplier: 1.5 };

/** The rule as it stands: on/off, the weekly threshold, and the multiplier. */
function rule() {
  const read = (k, d) => {
    const row = q.get.get(k);
    return row === undefined ? d : row.value;
  };
  return {
    enabled: read('ot_enabled', '0') === '1',
    threshold: Number(read('ot_threshold', String(DEFAULTS.threshold))) || DEFAULTS.threshold,
    multiplier: Number(read('ot_multiplier', String(DEFAULTS.multiplier))) || DEFAULTS.multiplier,
  };
}

/** Save the rule. Values are clamped to sane bounds so a stray entry cannot
 *  turn a payroll run into nonsense — a 0-hour threshold or a 0× multiplier. */
function saveRule({ enabled, threshold, multiplier }) {
  q.set.run({ key: 'ot_enabled', value: enabled ? '1' : '0' });
  const t = Math.min(168, Math.max(1, Number(threshold) || DEFAULTS.threshold));
  const m = Math.min(3, Math.max(1, Number(multiplier) || DEFAULTS.multiplier));
  q.set.run({ key: 'ot_threshold', value: String(t) });
  q.set.run({ key: 'ot_multiplier', value: String(m) });
}

/** The set of employee ids that do NOT get overtime. */
const exemptSet = () => new Set(q.exempt.all().map((r) => r.id));
const setExempt = (id, on) => q.setExempt.run({ id: Number(id), v: on ? 1 : 0 });

/**
 * The overtime PREMIUM to add on top of straight-time wage, and the overtime
 * hours it was earned on.
 *
 * @param weeks  [{ hours, wage }] straight-time per workweek (wage in cents)
 * @param r      { threshold, multiplier }
 * @returns      { otHours, otPay }  otPay in cents, already rounded
 *
 * The regular rate for a week is the weighted average — that week's straight
 * wage over its hours — which is FLSA-correct when someone worked more than one
 * pay rate in the week and reduces to the single rate when they did not.
 */
function overtimeFor(weeks, r) {
  let otHours = 0;
  let otPay = 0;
  for (const wk of weeks) {
    if (!(wk.hours > r.threshold) || !(wk.wage > 0)) continue;
    const over = wk.hours - r.threshold;
    const regRate = wk.wage / wk.hours;                 // cents per hour, weighted
    otHours += over;
    otPay += over * regRate * (r.multiplier - 1);        // the extra, e.g. 0.5×
  }
  return { otHours: Math.round(otHours * 100) / 100, otPay: Math.round(otPay) };
}

module.exports = { rule, saveRule, exemptSet, setExempt, overtimeFor, DEFAULTS };
