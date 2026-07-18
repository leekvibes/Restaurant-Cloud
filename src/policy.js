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

module.exports = { currentForDaypart, byId, historyForDaypart, policyForShift, saveRules, revertTo };
