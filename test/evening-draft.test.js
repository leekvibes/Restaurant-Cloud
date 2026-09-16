'use strict';

// THE EVENING POLICY, ONE BUTTON FROM LIVE.
//
// The owner, looking at Day Service's "Ready · not live" card: "can you set the
// policy like this for the evening one, so I can just click make live". The live
// Evening Service is a schedule created in the app with a key of its own, so the
// evening draft written for the built-in 'dinner' never reached it. These pin
// down that the draft lands on the right schedule, only there, never live — and
// what pressing the button then does to the services still open, because the
// owner's plan rests on it: "the ones I still have open will fall under the new
// policy, today's day service and yesterday's and today's evening service".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-evedraft-'));
process.env.DB_PATH = path.join(dir, 'eve.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
const SERVICES = require('../src/services');
const P = require('../src/policy');
const { defaultRules } = require('../src/engine');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const row = (id) => db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
const mkShift = (date, daypart, status) => Number(db.prepare(
  'INSERT INTO shifts (date, daypart, status) VALUES (?, ?, ?)').run(date, daypart, status).lastInsertRowid);

/** The live site's shape: the built-in evening schedule switched off, a created one in use. */
function liveShape() {
  db.prepare("UPDATE services SET active = 0 WHERE slug = 'dinner'").run();
  if (!SERVICES.bySlug('evening-service')) SERVICES.create({ slug: 'evening-service', name: 'Evening Service' });
}

test('a fresh install stages nothing: the built-in evening schedule already has a policy', () => {
  // 'dinner' is named Evening Service too, and it has history from the first run.
  const r = P.stageEveningDraft();
  assert.strictEqual(r.why, 'none', 'no schedule without a policy to put it on');
});

test('on the live shape it lands on Evening Service, waiting, and nowhere else', () => {
  liveShape();
  const r = P.stageEveningDraft();
  assert.strictEqual(r.why, 'staged: evening-service');
  const draft = P.stagedForDaypart('evening-service');
  assert.ok(draft, 'a policy is waiting');
  assert.deepStrictEqual(draft.rules, P.PALM_EVENING_POOLED.rules, 'the agreed rules, with the bar pooling');
  assert.strictEqual(P.currentForDaypart('evening-service'), null, 'and it is NOT live');
  assert.ok(draft.rules.some((x) => x.type === 'share' && x.role === 'bartender'), 'bartenders pool');
  assert.ok(draft.rules.some((x) => x.recipient === 'barback' && x.paidBy[0] === 'bartender'),
    'and the barback is paid by the bar');
});

test('it never stages twice, and never over a policy that exists', () => {
  const before = db.prepare("SELECT COUNT(*) n FROM policy_versions WHERE daypart = 'evening-service'").get().n;
  assert.strictEqual(P.stageEveningDraft().why, 'none', 'Evening Service has a draft now');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM policy_versions WHERE daypart = 'evening-service'").get().n,
    before, 'still exactly one');
});

test('two schedules it could belong on means it picks neither', () => {
  SERVICES.create({ slug: 'evening-a', name: 'Evening A' });
  SERVICES.create({ slug: 'evening-b', name: 'Evening B' });
  assert.match(P.stageEveningDraft().why, /ambiguous/);
  assert.strictEqual(P.stagedForDaypart('evening-a'), null);
  assert.strictEqual(P.stagedForDaypart('evening-b'), null);
  db.prepare("UPDATE services SET active = 0 WHERE slug IN ('evening-a', 'evening-b')").run();
});

test('the boot runs it once, so a draft thrown away stays thrown away', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('evening_draft_2026_09_16', 'staged: evening-service') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.strictEqual(P.seedEveningDraft(), null, 'already done');
});

// --- pressing the button --------------------------------------------------------

test('open evening services fall under the new policy the moment it is live', () => {
  // Yesterday's and today's Evening Service, still open. Evening never had a
  // policy, so nothing is stamped on either and there is nothing to move.
  const yesterday = mkShift('2026-09-15', 'evening-service', 'open');
  const today = mkShift('2026-09-16', 'evening-service', 'open');
  // Touched before the button: still unstamped, because there was nothing to stamp.
  P.policyForShift(row(yesterday));
  assert.strictEqual(row(yesterday).policy_id, null);

  const live = P.activateStaged(P.stagedForDaypart('evening-service').id);
  assert.ok(live, 'made live');
  for (const id of [yesterday, today]) {
    const rules = P.policyForShift(row(id));
    assert.ok(rules.some((x) => x.type === 'share'), 'worked out on the new policy');
    assert.strictEqual(row(id).policy_id, live.id, 'and locked onto it');
  }
});

test('a sent evening service does not move when the policy goes live', () => {
  const sent = mkShift('2026-09-13', 'evening-service', 'emailed');
  assert.deepStrictEqual(P.policyForShift(row(sent)), defaultRules(), 'what it went out on');
  assert.strictEqual(row(sent).policy_id, null);
});

test('an open Day Service already on the old policy needs the move button', () => {
  // The part of the owner's plan that is NOT automatic. Day has a policy in force,
  // so today's Day Service locked onto it when the first person clocked in.
  // Making the draft live leaves it there; the policy page's "Move it onto the
  // current policy" is what brings it across.
  P.saveRules('cafe', [{ type: 'tipout', recipient: 'busser', percent: 13, base: 'remaining', split: 'hours' }], 'old day');
  const todayDay = mkShift('2026-09-16', 'cafe', 'open');
  const oldId = P.currentForDaypart('cafe').id;
  P.policyForShift(row(todayDay));
  assert.strictEqual(row(todayDay).policy_id, oldId, 'locked onto the old Day policy at first touch');

  const draft = P.stageRules('cafe', [{ type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] }], 'palm day');
  const live = P.activateStaged(draft.id);
  assert.strictEqual(row(todayDay).policy_id, oldId, 'still on the old one after the button');

  // What the page's button runs.
  db.prepare(`UPDATE shifts SET policy_id = @id
     WHERE daypart = @dp AND status = 'open' AND policy_id IS NOT NULL AND policy_id <> @id`)
    .run({ id: live.id, dp: 'cafe' });
  assert.strictEqual(row(todayDay).policy_id, live.id, 'and moved by it');
});
