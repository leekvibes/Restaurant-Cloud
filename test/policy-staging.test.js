// ---------------------------------------------------------------------------
// STAGED POLICIES — written down, not yet in force.
//
// A policy change and the day it starts applying are two decisions, and making
// them one is how a new policy goes live on the deploy that happened to carry
// it. These hold the boundary: a staged version is invisible to every service,
// turning it on moves nothing that already happened, and it moves one service.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-policy-'));
process.env.DB_PATH = path.join(dir, 'p.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db, s } = require('../src/db');
const P = require('../src/policy');

const OLD = [{ type: 'tipout', recipient: 'busser', percent: 10, base: 'total_sales', split: 'hours' }];
const NEW = [
  { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'barback', percent: 3, base: 'total_sales', split: 'hours', paidBy: ['bartender'] },
];
const mkShift = (date, daypart, status) => Number(db.prepare(
  'INSERT INTO shifts (date, daypart, status) VALUES (?, ?, ?)').run(date, daypart, status || 'open').lastInsertRowid);

test.before(() => { P.saveRules('dinner', OLD, 'the policy in force'); });

test('a staged policy is invisible to every service', () => {
  const before = P.currentForDaypart('dinner');
  const draft = P.stageRules('dinner', NEW, 'the new one, not live');
  assert.ok(draft && draft.id, 'it was written down');

  assert.strictEqual(P.currentForDaypart('dinner').id, before.id,
    'the live policy did not move');
  assert.ok(!P.historyForDaypart('dinner').some((h) => h.id === draft.id),
    'and it is not in the history, which is a list of what has been in force');

  // The real test: a service created now must not lock onto it.
  const sh = mkShift('2026-09-20', 'dinner');
  const rules = P.policyForShift(db.prepare('SELECT * FROM shifts WHERE id = ?').get(sh));
  assert.deepStrictEqual(rules, OLD, 'a new service is priced by the LIVE policy');
  assert.strictEqual(db.prepare('SELECT policy_id p FROM shifts WHERE id = ?').get(sh).p, before.id);
});

test('one draft per service — saving again replaces it', () => {
  const first = P.stagedForDaypart('dinner');
  const second = P.stageRules('dinner', NEW.slice(0, 1), 'changed my mind');
  assert.notStrictEqual(second.id, first.id);
  assert.strictEqual(P.stagedForDaypart('dinner').id, second.id, 'the newest is THE draft');
  assert.strictEqual(P.byId(first.id), null, 'and the one it replaced is gone, not lurking');
});

test('turning it on moves nothing that already happened', () => {
  const draft = P.stageRules('dinner', NEW, 'the new one');
  // Two services already stamped with the old policy — one closed, one open.
  const closed = mkShift('2026-09-18', 'dinner', 'emailed');
  const open = mkShift('2026-09-19', 'dinner', 'open');
  for (const id of [closed, open]) P.policyForShift(db.prepare('SELECT * FROM shifts WHERE id = ?').get(id));
  const stamped = (id) => db.prepare('SELECT policy_id p FROM shifts WHERE id = ?').get(id).p;
  const wasClosed = stamped(closed); const wasOpen = stamped(open);

  const live = P.activateStaged(draft.id);
  assert.ok(live, 'it went live');
  assert.strictEqual(P.currentForDaypart('dinner').id, draft.id, 'and it is now the live one');

  assert.strictEqual(stamped(closed), wasClosed, 'a closed service keeps its policy');
  assert.strictEqual(stamped(open), wasOpen, 'and so does one still open');
  assert.deepStrictEqual(
    P.policyForShift(db.prepare('SELECT * FROM shifts WHERE id = ?').get(closed)), OLD,
    'it is still priced the old way — the whole point');

  // Only the NEXT service is affected.
  const next = mkShift('2026-09-21', 'dinner');
  assert.deepStrictEqual(P.policyForShift(db.prepare('SELECT * FROM shifts WHERE id = ?').get(next)), NEW);
  assert.strictEqual(P.stagedForDaypart('dinner'), null, 'and no stale draft is left behind');
});

test('turning one service on leaves the other alone', () => {
  P.saveRules('cafe', OLD, 'day policy in force');
  const cafeWas = P.currentForDaypart('cafe').id;
  const draft = P.stageRules('dinner', NEW, 'evening only');
  P.activateStaged(draft.id);
  assert.strictEqual(P.currentForDaypart('cafe').id, cafeWas, 'Day Service did not move');
  assert.notStrictEqual(P.currentForDaypart('dinner').id, cafeWas);
});

test('a live version cannot be discarded, and a draft can', () => {
  const live = P.currentForDaypart('dinner');
  assert.strictEqual(P.discardStaged(live.id), false, 'the live policy is not deletable');
  assert.ok(P.byId(live.id), 'and it is still there');

  const draft = P.stageRules('dinner', NEW, 'throwaway');
  assert.strictEqual(P.discardStaged(draft.id), true);
  assert.strictEqual(P.stagedForDaypart('dinner'), null);
  assert.strictEqual(P.currentForDaypart('dinner').id, live.id, 'discarding did not touch the live one');
});

test('activating something already live does nothing rather than something odd', () => {
  const live = P.currentForDaypart('dinner');
  assert.strictEqual(P.activateStaged(live.id), null);
  assert.strictEqual(P.currentForDaypart('dinner').id, live.id);
});

test('the engine test for the new shape agrees with the migration guard', () => {
  // needsNewEngine decides what gets put back into draft on deploy. If it
  // disagrees with what the engine actually needs, a policy the running code
  // cannot work out goes live on a deploy nobody thought was a policy change.
  assert.strictEqual(P.needsNewEngine(OLD), false, 'the old shape runs anywhere');
  assert.strictEqual(P.needsNewEngine(NEW), true, 'paidBy needs this release');
  assert.strictEqual(P.needsNewEngine([{ type: 'tipout', recipient: 'barback', percent: 3, from: 'bartender' }]), true,
    'so does one pot funding another');
  assert.strictEqual(P.needsNewEngine([{ type: 'pool', source: 'jar', among: ['barista', 'bartender'] }]), true,
    'so does a pool naming its roles');
  assert.strictEqual(P.needsNewEngine([{ type: 'pool', source: 'jar', among: 'all_support' }]), false,
    'but the old open-ended pool does not');
});

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
