'use strict';

// Versioned, rule-based tip-out policy. Each version stores its full rule list
// as JSON. Editing never rewrites the past: a change is a NEW version with its
// own timestamp, and every shift locks the version current when it was created.

const { db, s } = require('./db');
const { defaultRules } = require('./engine');

db.exec(`
CREATE TABLE IF NOT EXISTS policy_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  daypart        TEXT NOT NULL,          -- cafe | dinner
  rules_json     TEXT NOT NULL,
  note           TEXT,
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const Q = {
  latest: db.prepare('SELECT * FROM policy_versions WHERE daypart = ? ORDER BY effective_from DESC, id DESC LIMIT 1'),
  byId: db.prepare('SELECT * FROM policy_versions WHERE id = ?'),
  history: db.prepare('SELECT * FROM policy_versions WHERE daypart = ? ORDER BY effective_from DESC, id DESC'),
  insert: db.prepare('INSERT INTO policy_versions (daypart, rules_json, note) VALUES (@daypart, @rules_json, @note)'),
  count: db.prepare('SELECT COUNT(*) n FROM policy_versions'),
};

// First run of the rule-based system: seed defaults, and reset any old policy
// stamps so shifts re-lock onto the equivalent default rules (same math).
if (Q.count.get().n === 0) {
  for (const daypart of ['cafe', 'dinner']) {
    Q.insert.run({ daypart, rules_json: JSON.stringify(defaultRules()), note: 'Initial policy' });
  }
  try { db.exec('UPDATE shifts SET policy_id = NULL'); } catch { /* shifts table may be empty */ }
}

const parse = (row) => (row ? { ...row, rules: JSON.parse(row.rules_json) } : null);

const currentForDaypart = (daypart) => parse(Q.latest.get(daypart));
const byId = (id) => parse(Q.byId.get(id));
const historyForDaypart = (daypart) => Q.history.all(daypart).map(parse);

/** Lock a policy version onto a shift (if unstamped) and return its rule list. */
function policyForShift(shift) {
  let row = shift.policy_id ? byId(shift.policy_id) : null;
  if (!row) {
    row = currentForDaypart(shift.daypart);
    if (row) s.setPolicy.run(row.id, shift.id);
  }
  return row ? row.rules : defaultRules();
}

/** Save a new version (effective now). rules = array of rule objects. */
function saveRules(daypart, rules, note) {
  Q.insert.run({ daypart, rules_json: JSON.stringify(rules), note: (note || '').trim() || null });
}

/** Revert = re-save an old version's rules as the new current version. */
function revertTo(id, note) {
  const row = byId(id);
  if (!row) return;
  Q.insert.run({ daypart: row.daypart, rules_json: row.rules_json, note: note || `Reverted to the ${row.effective_from} version` });
}

// Older policies pooled the cash jar and to-go CARD tips together and paid the
// whole thing out as weekly cash. To-go card is card money, so it belongs on
// the paycheck; only the jar is handed over by hand. Split any policy still
// using the combined rule into two. Recorded as a normal new version, so it
// shows up in the history and can be reverted from /policy like anything else.
// Idempotent: once split, no rule matches and this does nothing.
function splitJarFromToGoCard() {
  for (const daypart of ['cafe', 'dinner']) {
    const cur = currentForDaypart(daypart);
    if (!cur) continue;
    const combined = cur.rules.filter((r) => r.type === 'pool'
      && (r.source == null || r.source === 'jar_togo')
      && (r.payout || 'weekly_cash') === 'weekly_cash');
    if (!combined.length) continue;

    const rules = cur.rules.filter((r) => !combined.includes(r));
    for (const r of combined) {
      rules.push({ ...r, source: 'jar', payout: 'weekly_cash' });
      rules.push({ ...r, source: 'togo_card', payout: 'paycheck' });
    }
    Q.insert.run({ daypart, rules_json: JSON.stringify(rules),
      note: 'To-go card tips now pay on the paycheck; only the cash jar is handed out' });
  }
}
splitJarFromToGoCard();


// --- one-off adjustments, for the nights the policy does not fit ------------
//
// A rate is a rule about the ordinary night. A busser who arrived at nine, a
// bartender covering someone else's section, a barback sent home early — those
// are Tuesday, and a policy edited to accommodate Tuesday is a policy that no
// longer describes any night.
//
// THE PRINCIPLE THAT MAKES THIS SAFE: an adjustment MOVES money, it never edits
// a number. Reducing the busser's cut hands it back to whoever paid it, so the
// books still balance and the receipt can still explain itself. There is no way
// to express "the busser gets less and nobody gets more", because that money
// would have to come from somewhere and the honest answer is that it does not
// exist.
//
// Scoped to ONE service. It cannot leak into tomorrow, which is the whole
// difference between this and editing the policy.
db.exec(`
CREATE TABLE IF NOT EXISTS shift_tip_adjustments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id    INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  -- Which rule this bends. A rule has no id of its own, so it is named the way
  -- a person would: who it pays and who pays it.
  recipient   TEXT NOT NULL,
  paid_by     TEXT,
  -- 'off'    — do not charge this rule at all tonight
  -- 'amount' — charge exactly this many cents instead of the percentage
  mode        TEXT NOT NULL,
  cents       INTEGER,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT,
  UNIQUE(shift_id, recipient, paid_by)
);
`);

const adjustmentsFor = (shiftId) => db.prepare(
  'SELECT * FROM shift_tip_adjustments WHERE shift_id = ? ORDER BY id').all(shiftId);

function setAdjustment(shiftId, { recipient, paidBy, mode, cents, reason, by }) {
  if (!['off', 'amount'].includes(mode)) throw new Error('An adjustment is either off or an amount.');
  const c = mode === 'amount' ? Math.max(0, Math.round(Number(cents) || 0)) : null;
  db.prepare(`INSERT INTO shift_tip_adjustments
    (shift_id, recipient, paid_by, mode, cents, reason, created_by)
    VALUES (@shift, @recipient, @paidBy, @mode, @cents, @reason, @by)
    ON CONFLICT(shift_id, recipient, paid_by) DO UPDATE SET
      mode = excluded.mode, cents = excluded.cents, reason = excluded.reason,
      created_by = excluded.created_by, created_at = datetime('now')`)
    .run({ shift: shiftId, recipient, paidBy: paidBy || null, mode, cents: c,
      reason: String(reason || '').trim() || null, by: by || null });
}

const clearAdjustment = (shiftId, recipient, paidBy) => db.prepare(
  `DELETE FROM shift_tip_adjustments WHERE shift_id = ? AND recipient = ?
     AND COALESCE(paid_by, '') = COALESCE(?, '')`).run(shiftId, recipient, paidBy || null);

/**
 * A sent service's adjustments are as fixed as its policy version.
 *
 * The money has been allocated and emailed. Changing an adjustment afterwards
 * would move a figure somebody has already been told, with nothing on any
 * screen saying the two no longer agree — the same reason a sent service
 * refuses new sales.
 */
const adjustmentsLocked = (sh) => String(sh && sh.status) === 'emailed';

module.exports = {
  adjustmentsFor, setAdjustment, clearAdjustment, adjustmentsLocked, currentForDaypart, byId, historyForDaypart, policyForShift, saveRules, revertTo };
