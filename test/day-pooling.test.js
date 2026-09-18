'use strict';

// DAY SERVICE: THE BARISTAS POOL, LIKE THE BAR.
//
// "If a barista enters tips from themselves it should be split between the
// baristas on shift by hours. Everything else can stay the same — don't mess
// with evening, this is just for day."

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-daypool-'));
process.env.DB_PATH = path.join(dir, 'day.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
require('../src/services');
const P = require('../src/policy');
const { runShift } = require('../src/engine');
const { serverEmail, poolWords } = require('../src/email');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// The Palm day policy as it was agreed, before this change.
const PALM_DAY = [
  { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'bartender', percent: 9, base: 'alcohol', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'barista', percent: 1.5, base: 'coffee', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'busser', percent: 1.5, base: 'total_sales', split: 'hours', paidBy: ['bartender'] },
];
const POOLED_DAY = PALM_DAY.concat([
  { type: 'share', role: 'bartender', split: 'hours' },
  { type: 'share', role: 'barista', split: 'hours' },
]);
const evening = () => db.prepare("SELECT id, staged, rules_json FROM policy_versions WHERE daypart <> 'cafe' ORDER BY id").all();

// --- the pool itself ------------------------------------------------------------

const person = (id, role, hours, over) => ({ employeeId: id, name: id, role, hours,
  food: 0, coffee: 0, alcohol: 0, cardTips: 0, cashTips: 0, ...over });

/** A day: a server, two baristas on unequal hours, a busser. */
const day = (rules = POOLED_DAY) => runShift({
  servers: [
    person('SV', 'server', 6, { food: 1500, coffee: 400, cardTips: 300 }),
    person('BA1', 'barista', 6, { food: 100, coffee: 500, cardTips: 90, cashTips: 30 }),
    person('BA2', 'barista', 3, { coffee: 200, cardTips: 30 }),
  ],
  support: [
    { employeeId: 'BA1', name: 'BA1', role: 'barista', hours: 6 },
    { employeeId: 'BA2', name: 'BA2', role: 'barista', hours: 3 },
    { employeeId: 'BU', name: 'Busser', role: 'busser', hours: 6 },
  ],
  pool: {},
}, rules);
const who = (r, id) => r.servers.find((p) => p.employeeId === id);

test('what a barista enters from their own guests is split between the baristas by hours', () => {
  const r = day();
  // Their own tips: $120 and $30. Baristas pay nothing on the day policy.
  // $150 between them, six hours against three.
  assert.strictEqual(who(r, 'BA1').tipsKept + who(r, 'BA2').tipsKept, 15000, 'every penny of it');
  assert.strictEqual(who(r, 'BA1').tipsKept, 10000, 'two thirds');
  assert.strictEqual(who(r, 'BA2').tipsKept, 5000, 'one third');
  // The $30 cash is pooled on the same hours: $20 and $10.
  assert.strictEqual(who(r, 'BA1').cashTips, 2000);
  assert.strictEqual(who(r, 'BA2').cashTips, 1000);
  assert.strictEqual(who(r, 'BA1').pooled.cashOwed, 1000, 'BA1 hands $10 across the counter');
  assert.ok(r.reconciliation.balanced, 'tips in, tips out');
});

test('the servers\' 1.5% of coffee is still split between the baristas by hours', () => {
  const r = day();
  // 1.5% of the server's $400 of coffee = $6.00; 2:1.
  assert.strictEqual(r.pots.barista, 600);
  const share = (id) => r.support.find((p) => p.employeeId === id).tipShare;
  assert.strictEqual(share('BA1'), 400);
  assert.strictEqual(share('BA2'), 200);
});

test('everything else on the day is exactly as it was', () => {
  const before = day(PALM_DAY);
  const after = day(POOLED_DAY);
  const sv = (r) => who(r, 'SV');
  assert.deepStrictEqual(sv(after).tipouts, sv(before).tipouts, "the server's tip-outs do not move");
  assert.strictEqual(sv(after).tipsKept, sv(before).tipsKept, 'nor what the server keeps');
  assert.deepStrictEqual(after.pots, before.pots, 'nor any pot');
  // Between the baristas, only who holds what changes — never the total.
  const baristas = (r) => who(r, 'BA1').tipsKept + who(r, 'BA2').tipsKept;
  assert.strictEqual(baristas(after), baristas(before));
});

// --- the policy it arrives as ---------------------------------------------------

test('on the live shape — Palm day waiting as a draft — the draft gains the pools and nothing else', () => {
  const eveningBefore = evening();
  P.stageRules('cafe', PALM_DAY, 'Palm day policy: every penny moves by percentage.');
  const liveBefore = P.currentForDaypart('cafe');

  const r = P.stageDayPooling();
  assert.match(r.why, /staged: bartender \+ barista pooling on the waiting draft/);
  const draft = P.stagedForDaypart('cafe');
  assert.deepStrictEqual(draft.rules, POOLED_DAY, 'every rule kept, in order, with the two pools after');
  assert.match(draft.note, /baristas each pool their own tips/);
  assert.doesNotMatch(draft.note, /stay with whoever earned them/, 'and the note does not contradict it');
  assert.strictEqual(P.currentForDaypart('cafe').id, liveBefore.id, 'nothing went live');
  assert.deepStrictEqual(evening(), eveningBefore, 'and evening was not touched');
});

test('run again, it does nothing', () => {
  const draftId = P.stagedForDaypart('cafe').id;
  assert.strictEqual(P.stageDayPooling().why, 'already pooled');
  assert.strictEqual(P.stagedForDaypart('cafe').id, draftId);
});

test('if Palm day went live and the bar was pooled by hand, only the baristas are added', () => {
  const eveningBefore = evening();
  const withBar = PALM_DAY.concat([{ type: 'share', role: 'bartender', split: 'hours' }]);
  P.activateStaged(P.stagedForDaypart('cafe').id);
  P.saveRules('cafe', withBar, 'made live, bar pooled by hand');
  assert.strictEqual(P.stagedForDaypart('cafe'), null, 'no draft waiting');

  const r = P.stageDayPooling();
  assert.match(r.why, /staged: barista pooling on the live policy/);
  assert.deepStrictEqual(P.stagedForDaypart('cafe').rules,
    withBar.concat([{ type: 'share', role: 'barista', split: 'hours' }]));
  assert.deepStrictEqual(P.currentForDaypart('cafe').rules, withBar, 'the live one is unchanged');
  assert.deepStrictEqual(evening(), eveningBefore, 'evening untouched');
});

test('an older kind of day policy is left alone, rather than quietly turned into a new one', () => {
  P.discardStaged(P.stagedForDaypart('cafe').id);
  P.saveRules('cafe', [{ type: 'tipout', recipient: 'busser', percent: 13, base: 'remaining', split: 'hours' }], 'old day');
  const r = P.stageDayPooling();
  assert.match(r.why, /older kind/);
  assert.strictEqual(P.stagedForDaypart('cafe'), null, 'nothing staged');
});

// --- what the baristas read -------------------------------------------------------

test('a barista is told about the baristas, not the bar', () => {
  const r = day();
  const { html } = serverEmail(who(r, 'BA1'), { date: '2026-09-18', daypart: 'cafe',
    email: 'ba@example.com', hourlyRate: 15, skipped: [] });
  assert.match(html, /Pooled with the baristas/);
  assert.match(html, /All the baristas on shift kept/);
  // Whole words: "the baristas" begins with "the bar".
  assert.doesNotMatch(html, /\bthe bar\b/i, 'no bar anywhere in a barista\'s pool');
  const w = poolWords('barista');
  assert.match(w.cashHint, /The baristas pool their cash/);
});

test('and the bar keeps its words exactly', () => {
  assert.strictEqual(poolWords('bartender').heading, 'Pooled at the bar');
  assert.strictEqual(poolWords('bartender').owesYou, 'so the bar owes you');
});
