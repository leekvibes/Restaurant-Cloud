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

// STAGED: WRITTEN DOWN, NOT YET IN FORCE.
//
// A policy change and the day it starts applying are two different decisions,
// and until now saving one made the other. That is fine for a percentage
// tweak and wrong for a whole new policy: the rules have to be entered,
// checked against a real service and slept on before a single shift is priced
// by them. Without somewhere to put a policy that is finished but not live,
// the only options were to keep it out of the system entirely or to make it
// binding the moment it was typed.
//
// A staged version is a full version in every respect except that
// currentForDaypart cannot see it, so no new shift can lock onto it. Making it
// live is one deliberate act, on one service, dated when it happens.
const polCols = db.prepare('PRAGMA table_info(policy_versions)').all().map((c) => c.name);
if (!polCols.includes('staged')) {
  db.exec('ALTER TABLE policy_versions ADD COLUMN staged INTEGER NOT NULL DEFAULT 0');
}

const Q = {
  latest: db.prepare('SELECT * FROM policy_versions WHERE daypart = ? AND staged = 0 ORDER BY effective_from DESC, id DESC LIMIT 1'),
  staged: db.prepare('SELECT * FROM policy_versions WHERE daypart = ? AND staged = 1 ORDER BY id DESC LIMIT 1'),
  byId: db.prepare('SELECT * FROM policy_versions WHERE id = ?'),
  history: db.prepare('SELECT * FROM policy_versions WHERE daypart = ? AND staged = 0 ORDER BY effective_from DESC, id DESC'),
  insert: db.prepare('INSERT INTO policy_versions (daypart, rules_json, note, staged) VALUES (@daypart, @rules_json, @note, @staged)'),
  count: db.prepare('SELECT COUNT(*) n FROM policy_versions'),
  golive: db.prepare("UPDATE policy_versions SET staged = 0, effective_from = datetime('now') WHERE id = ? AND staged = 1"),
  drop: db.prepare('DELETE FROM policy_versions WHERE id = ? AND staged = 1'),
};

// First run of the rule-based system: seed defaults, and reset any old policy
// stamps so shifts re-lock onto the equivalent default rules (same math).
if (Q.count.get().n === 0) {
  for (const daypart of ['cafe', 'dinner']) {
    Q.insert.run({ daypart, rules_json: JSON.stringify(defaultRules()), note: 'Initial policy', staged: 0 });
  }
  try { db.exec('UPDATE shifts SET policy_id = NULL'); } catch { /* shifts table may be empty */ }
}

const parse = (row) => (row ? { ...row, rules: JSON.parse(row.rules_json) } : null);

const currentForDaypart = (daypart) => parse(Q.latest.get(daypart));
const byId = (id) => parse(Q.byId.get(id));
const historyForDaypart = (daypart) => Q.history.all(daypart).map(parse);

/**
 * Is this the NEW-SHAPE policy — the one where a rule names who pays it, and a
 * pool names who shares it?
 *
 * The same test db.js uses to decide how a service's people are classified.
 * Kept here, in one place, because three screens and a migration all need the
 * answer and three copies of it is how they come to disagree.
 */
function isNewModel(rules) {
  if (!Array.isArray(rules)) return false;
  return rules.some((r) => (r.type === 'tipout' && r.paidBy)
    || (r.type === 'pool' && Array.isArray(r.among)));
}

/** The policy written down for this service but not yet in force, if any. */
const stagedForDaypart = (daypart) => parse(Q.staged.get(daypart));

/**
 * Put a policy live, on ONE service, now.
 *
 * It keeps its identity rather than being copied to a new row, so the history
 * reads as one version that was drafted and then started — which is what
 * happened — instead of two that look like a change nobody made.
 *
 * Shifts already stamped with another version are not touched and cannot be:
 * policyForShift reads the id ON THE SHIFT. This decides what the NEXT service
 * locks onto, and nothing else.
 */
function activateStaged(id) {
  const row = Q.byId.get(id);
  if (!row || row.staged !== 1) return null;
  Q.golive.run(id);
  return parse(Q.byId.get(id));
}

/** Throw away a draft. Only ever a draft — a live version cannot be deleted. */
function discardStaged(id) {
  const row = Q.byId.get(id);
  if (!row || row.staged !== 1) return false;
  return Q.drop.run(id).changes > 0;
}

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
  Q.insert.run({ daypart, rules_json: JSON.stringify(rules), note: (note || '').trim() || null, staged: 0 });
}

/**
 * Save a policy WITHOUT putting it in force. One draft per service: saving
 * again replaces it, because two competing drafts is not a state anybody could
 * reason about from a page.
 */
function stageRules(daypart, rules, note) {
  const had = Q.staged.get(daypart);
  if (had) Q.drop.run(had.id);
  Q.insert.run({ daypart, rules_json: JSON.stringify(rules), note: (note || '').trim() || null, staged: 1 });
  return parse(Q.staged.get(daypart));
}

/** Revert = re-save an old version's rules as the new current version. */
function revertTo(id, note) {
  const row = byId(id);
  if (!row) return;
  Q.insert.run({ daypart: row.daypart, rules_json: row.rules_json, staged: 0,
    note: note || `Reverted to the ${row.effective_from} version` });
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
    Q.insert.run({ daypart, rules_json: JSON.stringify(rules), staged: 0,
      note: 'To-go card tips now pay on the paycheck; only the cash jar is handed out' });
  }
}
splitJarFromToGoCard();

/**
 * A POLICY THE RUNNING ENGINE CANNOT EVALUATE MUST NOT BE LIVE.
 *
 * The Palm policy was entered and saved during the build, which under the old
 * rules made it current the moment it was typed. Deploying would then have
 * switched both services onto it on the way past, with nobody deciding to —
 * and it uses three rule features (who pays a rule, one pot funding another, a
 * pool naming its roles) that an engine without this release simply ignores.
 * A policy silently half-applied is worse than either policy.
 *
 * So the test is not "is this new" but "can what is running actually work this
 * out". Anything using those features is put back into draft; everything else
 * is left exactly as it is. Two guards on top of that:
 *
 *   - a version a SETTLED service was priced under is never touched, whatever
 *     it contains — somebody has been paid under it and that is now history;
 *   - it runs once, so turning a policy on and redeploying does not turn it
 *     back off.
 *
 * A service still stamped with a staged version keeps it. policyForShift reads
 * the id on the shift and does not care whether it is staged.
 */
function needsNewEngine(rules) {
  if (!Array.isArray(rules)) return false;
  return rules.some((r) => r.paidBy || r.from || (r.type === 'pool' && Array.isArray(r.among)));
}

function stageUnactivatedNewPolicy() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'policy_staging_2026_09'").get();
  if (done) return;
  const settled = db.prepare("SELECT COUNT(*) n FROM shifts WHERE policy_id = ? AND status <> 'open'");
  for (const row of db.prepare('SELECT id, rules_json FROM policy_versions WHERE staged = 0').all()) {
    let rules;
    try { rules = JSON.parse(row.rules_json); } catch { continue; }
    if (!needsNewEngine(rules)) continue;
    if (settled.get(row.id).n > 0) continue;
    db.prepare('UPDATE policy_versions SET staged = 1 WHERE id = ?').run(row.id);
  }
  // ONE DRAFT PER SERVICE. The policy was arrived at over several saves, so
  // staging leaves a stack of superseded attempts behind the newest — and the
  // moment the newest goes live the one under it surfaces as "a new policy is
  // waiting", which is a draft nobody wrote pretending to be the next
  // decision. The superseded ones are removed, and only where nothing at all
  // points at them: a service stamped with one keeps it, and keeps the row.
  for (const daypart of ['cafe', 'dinner']) {
    const drafts = db.prepare(`SELECT id FROM policy_versions
      WHERE daypart = ? AND staged = 1 ORDER BY id DESC`).all(daypart);
    for (const old of drafts.slice(1)) {
      const used = db.prepare('SELECT COUNT(*) n FROM shifts WHERE policy_id = ?').get(old.id).n;
      if (used === 0) db.prepare('DELETE FROM policy_versions WHERE id = ? AND staged = 1').run(old.id);
    }
  }
  db.prepare(`INSERT INTO settings (key, value) VALUES ('policy_staging_2026_09', '1')
              ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
}
/**
 * THE PALM POLICY, WRITTEN DOWN AND NOT IN FORCE.
 *
 * A policy is rows in this table, not code — so shipping the switch without
 * this ships a page with nothing on it: no draft, no card, nothing to turn on.
 * The rules were agreed against the signed PDF and checked line by line; what
 * is missing on a fresh database is only that somebody has typed them in.
 *
 * STAGED, so it changes not one penny on arrival. What is live stays live,
 * every closed service keeps the version it was closed under, and the next
 * service carries on being priced exactly as the last one was. It appears on
 * the tip-out policy page as "Ready · not live", and it is a person clicking
 * the button that starts it — on one service at a time.
 *
 * Skipped wherever a draft already exists, so a manager who has edited theirs
 * does not find it replaced on the next deploy. Runs once besides.
 */
const PALM_2026_09 = {
  cafe: {
    note: 'Palm day policy: every penny moves by percentage. Card and cash stay with whoever earned them.',
    rules: [
      { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] },
      { type: 'tipout', recipient: 'bartender', percent: 9, base: 'alcohol', split: 'hours', paidBy: ['server'] },
      { type: 'tipout', recipient: 'barista', percent: 1.5, base: 'coffee', split: 'hours', paidBy: ['server'] },
      { type: 'tipout', recipient: 'busser', percent: 1.5, base: 'total_sales', split: 'hours', paidBy: ['bartender'] },
    ],
  },
  dinner: {
    note: 'Palm evening policy: no cash tip jar at night, so no pool rule at all — every penny moves by percentage.',
    rules: [
      { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] },
      { type: 'tipout', recipient: 'bartender', percent: 9, base: 'alcohol', split: 'hours', paidBy: ['server'] },
      { type: 'tipout', recipient: 'barback', percent: 3, base: 'total_sales', split: 'hours', paidBy: ['bartender'] },
    ],
  },
};

function seedPalmDraft() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'palm_draft_2026_09'").get();
  if (done) return;
  for (const [daypart, spec] of Object.entries(PALM_2026_09)) {
    if (Q.staged.get(daypart)) continue;                 // theirs, not ours, to replace
    const live = Q.latest.get(daypart);
    // Already running it — there is nothing to offer.
    if (live && needsNewEngine(JSON.parse(live.rules_json))) continue;
    Q.insert.run({ daypart, rules_json: JSON.stringify(spec.rules), note: spec.note, staged: 1 });
  }
  db.prepare(`INSERT INTO settings (key, value) VALUES ('palm_draft_2026_09', '1')
              ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
}

try {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  stageUnactivatedNewPolicy();
  seedPalmDraft();
} catch { /* settings table not ready on a bare boot; nothing is staged, nothing breaks */ }



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

// PER PERSON, not per rule.
//
// It bent a RULE — "charge the busser pot $80 tonight" — which is a sentence
// about a percentage and not about anybody. What a manager actually needs to
// change is one person's take: Joseph got $105.33 and for tonight he gets $80.
// The rule stays exactly as written and the other busser keeps hers.
//
// Nullable, because the rule-level rows already written keep their meaning.
const adjCols = db.prepare('PRAGMA table_info(shift_tip_adjustments)').all().map((c) => c.name);
if (!adjCols.includes('employee_id')) {
  db.exec('ALTER TABLE shift_tip_adjustments ADD COLUMN employee_id INTEGER');
}
// One per person per service. UNIQUE(shift, recipient, paid_by) cannot express
// that — two people in the same role would collide on it — so the person rows
// carry their own index.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS shift_tip_adj_person
  ON shift_tip_adjustments (shift_id, employee_id) WHERE employee_id IS NOT NULL`);

const adjustmentsFor = (shiftId) => db.prepare(
  'SELECT * FROM shift_tip_adjustments WHERE shift_id = ? ORDER BY id').all(shiftId);

/** What one person is set to tonight, or null if the policy rate stands. */
const personAdjustment = (shiftId, employeeId) => db.prepare(
  'SELECT * FROM shift_tip_adjustments WHERE shift_id = ? AND employee_id = ?')
  .get(shiftId, employeeId) || null;

/**
 * Set one person's take for one service.
 *
 * Stores the figure, nothing else. Where the difference goes is the engine's
 * business, and it is the same answer every time: back to whoever paid it.
 */
function setPersonAmount(shiftId, employeeId, { cents, recipient, reason, by }) {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  db.prepare(`INSERT INTO shift_tip_adjustments
    (shift_id, employee_id, recipient, paid_by, mode, cents, reason, created_by)
    VALUES (@shift, @emp, @recipient, NULL, 'amount', @cents, @reason, @by)
    ON CONFLICT(shift_id, employee_id) WHERE employee_id IS NOT NULL DO UPDATE SET
      cents = excluded.cents, reason = excluded.reason,
      created_by = excluded.created_by, created_at = datetime('now')`)
    .run({ shift: shiftId, emp: employeeId, recipient: recipient || '', cents: c,
      reason: String(reason || '').trim() || null, by: by || null });
}

const clearPersonAmount = (shiftId, employeeId) => db.prepare(
  'DELETE FROM shift_tip_adjustments WHERE shift_id = ? AND employee_id = ?')
  .run(shiftId, employeeId);

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
  adjustmentsFor, setAdjustment, clearAdjustment, adjustmentsLocked,
  personAdjustment, setPersonAmount, clearPersonAmount,
  currentForDaypart, byId, historyForDaypart, policyForShift, saveRules, revertTo,
  stagedForDaypart, stageRules, activateStaged, discardStaged, isNewModel, needsNewEngine };
