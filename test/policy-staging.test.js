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

// ---------------------------------------------------------------------------
// NO MONEY MOVES BY "SUPPORT" ANY MORE.
//
// The old policies pooled the jar across everybody classified as support, and
// a position's `kind` decided who that was. Under the Palm policy every penny
// is a named percentage from a named payer to a named recipient, or a pool that
// names its roles. These hold that line: not that the code CAN express it, but
// that the policy actually in use does not.
// ---------------------------------------------------------------------------

const PALM_DAY = [
  { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'bartender', percent: 9, base: 'alcohol', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'barista', percent: 1.5, base: 'coffee', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'busser', percent: 1.5, base: 'total_sales', split: 'hours', paidBy: ['bartender', 'barista'] },
  { type: 'pool', source: 'togo_card', split: 'hours', among: ['barista', 'bartender'], payout: 'paycheck' },
  { type: 'pool', source: 'jar', split: 'hours', among: ['barista'], payout: 'weekly_cash' },
];
const PALM_EVENING = [
  { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'bartender', percent: 9, base: 'alcohol', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'barback', percent: 3, base: 'total_sales', split: 'hours', paidBy: ['bartender'] },
];

const splitsAcrossSupport = (rules) => rules.filter((r) => r.type === 'pool'
  && !Array.isArray(r.among)
  && (r.among === 'all_support' || r.among === 'foh' || r.among == null)).length;

test('neither Palm policy splits anything across support as a group', () => {
  assert.strictEqual(splitsAcrossSupport(PALM_DAY), 0, 'day');
  assert.strictEqual(splitsAcrossSupport(PALM_EVENING), 0, 'evening');
  // And every recipient is a role somebody named on purpose.
  for (const rules of [PALM_DAY, PALM_EVENING]) {
    for (const r of rules) {
      if (r.type === 'tipout') assert.ok(r.recipient, 'a tip-out names who gets it');
      else assert.ok(Array.isArray(r.among) && r.among.length, 'a pool names its roles');
    }
  }
});

test('nobody outside the named roles can receive a penny', () => {
  const { runShift } = require('../src/engine');
  const r = runShift({
    servers: [
      { employeeId: 'S', name: 'Server', role: 'server', hours: 8, food: 1000, coffee: 100, alcohol: 500, cardTips: 300, cashTips: 0 },
      { employeeId: 'BT', name: 'Bar', role: 'bartender', hours: 8, food: 100, coffee: 0, alcohol: 800, cardTips: 200, cashTips: 0 },
    ],
    // A kitchen line and a host on the clock, in a policy that names neither.
    support: [
      { employeeId: 'BU', name: 'Busser', role: 'busser', hours: 8 },
      { employeeId: 'BB', name: 'Barback', role: 'barback', hours: 8 },
      { employeeId: 'K', name: 'Cook', role: 'kitchen', hours: 8 },
      { employeeId: 'H', name: 'Host', role: 'host', hours: 8 },
    ],
    pool: { jar: 100, togoCard: 50 },
  }, PALM_EVENING);

  const got = (id) => r.support.find((p) => p.employeeId === id);
  for (const id of ['K', 'H']) {
    const p = got(id);
    assert.strictEqual(p.tipShare, 0, `${p.role} gets no tip-out`);
    assert.strictEqual(p.poolCash, 0, `${p.role} gets no cash pool`);
    assert.strictEqual(p.poolCard, 0, `${p.role} gets no card pool`);
    assert.strictEqual(p.cardTotal + p.cashTotal, 0, `${p.role} gets nothing at all`);
  }
  assert.ok(got('BU').tipShare > 0, 'the busser does');
  assert.ok(got('BB').tipShare > 0, 'and the barback does');
  assert.ok(r.reconciliation.balanced, 'and the books balance');
});

test('a kitchen line on the clock does not dilute anybody else', () => {
  const { runShift } = require('../src/engine');
  const shift = (support) => runShift({
    servers: [{ employeeId: 'S', name: 'S', role: 'server', hours: 8, food: 1000, coffee: 0, alcohol: 0, cardTips: 200, cashTips: 0 }],
    support, pool: {},
  }, PALM_EVENING);
  const alone = shift([{ employeeId: 'BU', name: 'B', role: 'busser', hours: 8 }]);
  const crowded = shift([
    { employeeId: 'BU', name: 'B', role: 'busser', hours: 8 },
    { employeeId: 'K', name: 'K', role: 'kitchen', hours: 8 },
    { employeeId: 'H', name: 'H', role: 'host', hours: 8 },
  ]);
  assert.strictEqual(
    alone.support.find((p) => p.employeeId === 'BU').tipShare,
    crowded.support.find((p) => p.employeeId === 'BU').tipShare,
    'the busser gets the same either way — a pot is split by ROLE, not by whoever is standing there');
});

test('the day policy charges the bartender and the barista their own 1.5%', () => {
  // The rule that could not fire until they had somewhere to enter sales.
  const { runShift } = require('../src/engine');
  const r = runShift({
    servers: [
      { employeeId: 'BT', name: 'Bar', role: 'bartender', hours: 6, food: 100, coffee: 0, alcohol: 900, cardTips: 0, cashTips: 0 },
      { employeeId: 'BA', name: 'Counter', role: 'barista', hours: 6, food: 200, coffee: 400, alcohol: 0, cardTips: 0, cashTips: 0 },
    ],
    support: [{ employeeId: 'BU', name: 'Busser', role: 'busser', hours: 6 }],
    pool: {},
  }, PALM_DAY.filter((x) => x.type === 'tipout'));
  assert.strictEqual(r.servers.find((p) => p.employeeId === 'BT').tipouts.busser, 1500, '1.5% of $1000');
  assert.strictEqual(r.servers.find((p) => p.employeeId === 'BA').tipouts.busser, 900, '1.5% of $600');
  assert.strictEqual(r.pots.busser, 2400);
});

// ---------------------------------------------------------------------------
// A SERVICE ALREADY OPEN WHEN YOU FLIP THE SWITCH.
//
// A service locks onto its policy the first time anything touches it — a
// clock-in, a report, opening its page. So one opened this morning and
// switched this afternoon keeps this morning's rules, and tonight quietly
// calculates the old way. Right for anything settled; surprising for tonight.
// ---------------------------------------------------------------------------

test('an open service keeps the policy it was already stamped with', () => {
  const live = P.currentForDaypart('dinner');
  const open = mkShift('2026-11-01', 'dinner', 'open');
  P.policyForShift(db.prepare('SELECT * FROM shifts WHERE id = ?').get(open));
  const stampedWith = db.prepare('SELECT policy_id p FROM shifts WHERE id = ?').get(open).p;
  assert.strictEqual(stampedWith, live.id);

  const draft = P.stageRules('dinner', NEW.concat([
    { type: 'tipout', recipient: 'barista', percent: 1, base: 'coffee', split: 'hours', paidBy: ['server'] },
  ]), 'later');
  P.activateStaged(draft.id);
  assert.strictEqual(db.prepare('SELECT policy_id p FROM shifts WHERE id = ?').get(open).p, stampedWith,
    'still on the earlier one — which is exactly what has to be visible somewhere');
});

test('moving open services forward never reaches one that was sent', () => {
  const live = P.currentForDaypart('dinner');
  const sent = mkShift('2026-11-02', 'dinner', 'emailed');
  const open = mkShift('2026-11-03', 'dinner', 'open');
  // Both stamped with something older than what is live now.
  db.prepare('UPDATE shifts SET policy_id = 1 WHERE id IN (?, ?)').run(sent, open);

  // The restamp, exactly as the route runs it.
  const n = db.prepare(`UPDATE shifts SET policy_id = @id
     WHERE daypart = @dp AND status = 'open' AND policy_id IS NOT NULL AND policy_id <> @id`)
    .run({ id: live.id, dp: 'dinner' }).changes;

  assert.ok(n >= 1, 'it moved something');
  assert.strictEqual(db.prepare('SELECT policy_id p FROM shifts WHERE id = ?').get(open).p, live.id,
    'the open one moved');
  assert.strictEqual(db.prepare('SELECT policy_id p FROM shifts WHERE id = ?').get(sent).p, 1,
    'the sent one did not, and cannot — that money went out in somebody\'s email');
});

test('moving one service type leaves the other where it is', () => {
  const cafeShift = mkShift('2026-11-04', 'cafe', 'open');
  db.prepare('UPDATE shifts SET policy_id = 1 WHERE id = ?').run(cafeShift);
  const live = P.currentForDaypart('dinner');
  db.prepare(`UPDATE shifts SET policy_id = @id
     WHERE daypart = 'dinner' AND status = 'open' AND policy_id IS NOT NULL AND policy_id <> @id`)
    .run({ id: live.id });
  assert.strictEqual(db.prepare('SELECT policy_id p FROM shifts WHERE id = ?').get(cafeShift).p, 1,
    'Day Service untouched');
});

test('the summary names everyone who keeps their own tips, not just servers', () => {
  // It said "Servers" and nothing else, hardcoded from when a server was the
  // only person who kept their own. Under the Palm policy a bartender keeps
  // theirs and pays a percentage out of it — a line naming only servers reads
  // as though a bartender's tips still go somewhere.
  const { positions, keepsOwnCash } = require('../src/db');
  const slugs = positions.active.all().map((p) => p.slug);
  const keepsUnder = (rules) => slugs.filter((sl) => keepsOwnCash(sl, rules));

  assert.deepStrictEqual(keepsUnder(OLD), ['server'],
    'under the old shape only a server keeps their own');
  const palm = keepsUnder(PALM_EVENING);
  for (const who of ['server', 'bartender', 'barista']) {
    assert.ok(palm.includes(who), `${who} keeps their own under the Palm policy`);
  }
  assert.ok(!palm.includes('busser'), 'a busser does not, they are paid a percentage');
  assert.ok(!palm.includes('barback'), 'nor a barback');
});

// ---------------------------------------------------------------------------
// THE POLICY IS DATA, SO IT HAS TO ARRIVE.
//
// Rules are rows in policy_versions, not code. Shipping the switch without
// shipping the policy ships a page with nothing on it — no draft, no card,
// nothing to turn on. So a fresh database gets the Palm policy as a DRAFT.
// ---------------------------------------------------------------------------

test('the Palm policy arrives as a draft, and changes nothing on arrival', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'policy.js'), 'utf8');
  const spec = src.slice(src.indexOf('const PALM_2026_09 = {'), src.indexOf('function seedPalmDraft'));

  // The percentages, as agreed. Written out here so a change to either has to
  // be a change to both, on purpose.
  for (const want of [
    /recipient: 'busser', percent: 2, base: 'total_sales'[^}]*paidBy: \['server'\]/,
    /recipient: 'bartender', percent: 9, base: 'alcohol'[^}]*paidBy: \['server'\]/,
    /recipient: 'barista', percent: 1\.5, base: 'coffee'[^}]*paidBy: \['server'\]/,
    /recipient: 'busser', percent: 1\.5, base: 'total_sales'[^}]*paidBy: \['bartender'\]/,
    /recipient: 'barback', percent: 3, base: 'total_sales'[^}]*paidBy: \['bartender'\]/,
  ]) assert.match(spec, want, `the seeded policy still says ${want}`);
  assert.ok(!/type: 'pool'/.test(spec), 'and pools nothing — every penny moves by percentage');

  // Staged, never live. This is the line that decides whether a deploy is a
  // policy change, and it must never become saveRules.
  assert.match(src, /Q\.insert\.run\(\{ daypart, rules_json: JSON\.stringify\(spec\.rules\), note: spec\.note, staged: 1 \}\);/,
    'seeded as a draft');
  assert.match(src, /if \(Q\.staged\.get\(daypart\)\) continue;/,
    'and never over a draft somebody has already written');
  assert.match(src, /if \(live && needsNewEngine\(JSON\.parse\(live\.rules_json\)\)\) continue;/,
    'nor offered to a service already running it');
  assert.match(src, /palm_draft_2026_09/, 'and once, not on every boot');
});

test('a database that has never seen it ends up with the old rules live', () => {
  // The shape production is in: rules seeded, nothing switched on.
  const P2 = require('../src/policy');
  for (const dp of ['cafe', 'dinner']) {
    const live = P2.currentForDaypart(dp);
    if (!live) continue;
    // Whatever this fixture's live policy is, seeding must not have made a
    // new-shape one current behind anybody's back.
    const draft = P2.stagedForDaypart(dp);
    if (draft) {
      assert.ok(P2.needsNewEngine(draft.rules), `${dp}: the draft is the new shape`);
      assert.notStrictEqual(live.id, draft.id, `${dp}: and it is not what is live`);
    }
  }
});
