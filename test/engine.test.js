'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runShift, defaultRules } = require('../src/engine');
const { toCents } = require('../src/money');

const one = (over) => ({ employeeId: 'A', name: 'A', hours: 5, food: 0, coffee: 0, alcohol: 0, cardTips: 0, cashTips: 0, ...over });

test('worked example: single server tip-out matches to the penny', () => {
  const r = runShift({ servers: [one({ food: 3000, coffee: 400, alcohol: 1200, cardTips: 800 })],
    support: [{ employeeId: 'K', name: 'K', role: 'kitchen', hours: 1 }, { employeeId: 'BA', name: 'BA', role: 'barista', hours: 1 },
      { employeeId: 'BT', name: 'BT', role: 'bartender', hours: 1 }, { employeeId: 'BU', name: 'BU', role: 'busser', hours: 1 }] });
  const s = r.servers[0];
  assert.strictEqual(s.tipouts.kitchen, toCents(45));
  assert.strictEqual(s.tipouts.barista, toCents(6));
  assert.strictEqual(s.tipouts.bartender, toCents(60));
  assert.strictEqual(s.tipouts.busser, toCents(89.57)); // 13% of 689
  assert.strictEqual(s.tipsKept, toCents(599.43));
});

test('per-server, no pool: two servers each tip out on their own sales; pots split by hours', () => {
  const r = runShift({
    servers: [
      one({ employeeId: 'A', name: 'Ana', hours: 4, food: 2000, coffee: 200, cardTips: 450 }),
      one({ employeeId: 'B', name: 'Ben', hours: 6, food: 1500, coffee: 100, cardTips: 300 }),
    ],
    support: [{ employeeId: 'K1', name: 'Cook', role: 'kitchen', hours: 8 },
      { employeeId: 'BU', name: 'Busser', role: 'busser', hours: 6 },
      { employeeId: 'BA', name: 'Barista', role: 'barista', hours: 5 }],
  });
  assert.strictEqual(r.servers.find((s) => s.employeeId === 'A').tipsKept, toCents(362.79));
  assert.strictEqual(r.servers.find((s) => s.employeeId === 'B').tipsKept, toCents(240.12));
  assert.strictEqual(r.pots.kitchen, toCents(52.5));
  assert.strictEqual(r.pots.busser, toCents(90.09));
  assert.strictEqual(r.support.find((s) => s.employeeId === 'BU').tipShare, toCents(90.09));
});

test('role pool splits between two people strictly by hours, no penny drift', () => {
  const r = runShift({ servers: [one({ food: 1000, cardTips: 100 })],
    support: [{ employeeId: 'K1', name: 'a', role: 'kitchen', hours: 5 }, { employeeId: 'K2', name: 'b', role: 'kitchen', hours: 3 }] });
  const a = r.support.find((s) => s.employeeId === 'K1').tipShare;
  const b = r.support.find((s) => s.employeeId === 'K2').tipShare;
  assert.strictEqual(a + b, r.pots.kitchen);
  assert.ok(a > b);
});

test('shared pool (jar + to-go) splits by hours across ALL support, tagged weekly cash', () => {
  const r = runShift({
    servers: [one({ food: 1000, cardTips: 50 })],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 6 },
      { employeeId: 'BU', name: 'bu', role: 'busser', hours: 4 }],
    pool: { jar: 60, togo: 40 }, // $100 pool
  });
  const k = r.support.find((s) => s.employeeId === 'K');
  const bu = r.support.find((s) => s.employeeId === 'BU');
  assert.strictEqual(k.poolShare + bu.poolShare, toCents(100), 'pool fully distributed');
  assert.strictEqual(k.poolShare, toCents(60)); // 6/10 of 100
  assert.strictEqual(bu.poolShare, toCents(40)); // 4/10 of 100
  assert.strictEqual(k.poolShares.weekly_cash, toCents(60)); // default policy pays weekly cash
});

test('two buckets: cash jar pays weekly cash, to-go card pays on paycheck', () => {
  const rules = [
    { type: 'pool', source: 'jar', split: 'hours', among: 'all_support', payout: 'weekly_cash' },
    { type: 'pool', source: 'togo_card', split: 'hours', among: 'all_support', payout: 'paycheck' },
  ];
  const r = runShift({
    servers: [one({ food: 1000, cardTips: 20 })],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 6 }, { employeeId: 'BU', name: 'b', role: 'busser', hours: 6 }],
    pool: { jar: 80, togoCard: 40 }, // cash jar = 80 (weekly), to-go card = 40 (paycheck)
  }, rules);
  const k = r.support.find((s) => s.employeeId === 'K');
  assert.strictEqual(k.poolShares.weekly_cash, toCents(40)); // half of 80
  assert.strictEqual(k.poolShares.paycheck, toCents(20));    // half of 40
  assert.strictEqual(k.poolShare, toCents(60));
});

test('support-reported tips are pooled by hours, not kept by the reporter', () => {
  const rules = [
    { type: 'pool', source: 'jar', split: 'hours', among: 'all_support', payout: 'weekly_cash' },
    { type: 'pool', source: 'togo_card', split: 'hours', among: 'all_support', payout: 'paycheck' },
  ];
  const r = runShift({
    servers: [],
    support: [
      // The barista reported everything; the busser reported nothing...
      { employeeId: 'BA', name: 'barista', role: 'barista', hours: 5, cashTips: 60, cardTips: 40 },
      { employeeId: 'BU', name: 'busser', role: 'busser', hours: 5, cashTips: 0, cardTips: 0 },
    ],
  }, rules);
  const ba = r.support.find((s) => s.employeeId === 'BA');
  const bu = r.support.find((s) => s.employeeId === 'BU');
  // ...but equal hours means an equal split of both buckets.
  assert.strictEqual(ba.poolShares.weekly_cash, toCents(30));
  assert.strictEqual(bu.poolShares.weekly_cash, toCents(30));
  assert.strictEqual(ba.poolShares.paycheck, toCents(20));
  assert.strictEqual(bu.poolShares.paycheck, toCents(20));
  assert.strictEqual(ba.poolShare + bu.poolShare, toCents(100), 'nothing lost');
});

test('manager-counted jar and staff-reported tips land in the same pool', () => {
  const rules = [{ type: 'pool', source: 'jar', split: 'hours', among: 'all_support', payout: 'weekly_cash' }];
  const r = runShift({
    servers: [],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 4, cashTips: 25, cardTips: 0 }],
    pool: { jar: 75 }, // manager counted $75 in the jar, barista reported $25
  }, rules);
  assert.strictEqual(r.support[0].poolShares.weekly_cash, toCents(100));
});

test('cash + card tips both count toward the tip-out base', () => {
  const split = runShift({ servers: [one({ cardTips: 50, cashTips: 50, food: 100 })], support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 1 }] });
  const allCard = runShift({ servers: [one({ cardTips: 100, food: 100 })], support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 1 }] });
  assert.strictEqual(split.servers[0].tipsKept, allCard.servers[0].tipsKept);
});

test('everything reconciles: tips collected == kept + all role pools', () => {
  const r = runShift({
    servers: [
      one({ employeeId: 'A', hours: 5, food: 1234.56, coffee: 78.9, cardTips: 211.11, cashTips: 63.5 }),
      one({ employeeId: 'B', hours: 7, food: 999.99, cardTips: 180.25, cashTips: 40 }),
      one({ employeeId: 'C', hours: 6, food: 640.4, coffee: 12.35, cardTips: 95.8, cashTips: 22.15 }),
    ],
    support: [{ employeeId: 'K1', name: 'a', role: 'kitchen', hours: 8 }, { employeeId: 'BU', name: 'b', role: 'busser', hours: 7 },
      { employeeId: 'BA', name: 'c', role: 'barista', hours: 4 }],
    pool: { jar: 88.5, togo: 130.25 },
  });
  assert.ok(r.reconciliation.balanced);
});

test('custom rules: an added food-runner rule is applied', () => {
  const rules = [...defaultRules(), { type: 'tipout', recipient: 'busser', percent: 2, base: 'food', split: 'hours' }];
  // (recipient reused as a stand-in role that exists in support)
  const r = runShift({ servers: [one({ food: 1000, cardTips: 100 })],
    support: [{ employeeId: 'BU', name: 'b', role: 'busser', hours: 5 }] }, rules);
  // busser now gets 13% of remaining PLUS 2% of food ($20) → pool bigger than default.
  const rDefault = runShift({ servers: [one({ food: 1000, cardTips: 100 })], support: [{ employeeId: 'BU', name: 'b', role: 'busser', hours: 5 }] });
  assert.ok(r.pots.busser > rDefault.pots.busser);
});

// --- short-staffed nights -------------------------------------------------
// Running without a busser is normal here. Nobody is there to receive that
// 13%, so it must never be docked from the server and left unassigned.

test('no busser on shift: the busser tip-out is not charged and the server keeps it', () => {
  const crew = [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 8 }];
  const full = runShift({ servers: [one({ food: 2000, cardTips: 300, cashTips: 100 })],
    support: [...crew, { employeeId: 'BU', name: 'b', role: 'busser', hours: 5 }] });
  const short = runShift({ servers: [one({ food: 2000, cardTips: 300, cashTips: 100 })], support: crew });

  assert.strictEqual(short.servers[0].tipouts.busser, undefined);   // never charged
  assert.strictEqual(short.pots.busser, undefined);                 // no pot created
  assert.strictEqual(short.orphanedPots.length, 0);                 // nothing unassigned
  // The server keeps exactly what the busser would have received.
  assert.strictEqual(short.servers[0].tipsKept, full.servers[0].tipsKept + full.pots.busser);
  assert.deepStrictEqual(short.skippedPots, [{ role: 'busser', cents: full.pots.busser }]);
  // Kitchen is unaffected.
  assert.strictEqual(short.pots.kitchen, full.pots.kitchen);
});

test('short-staffed night still reconciles and hands out every cent charged', () => {
  const r = runShift({
    servers: [one({ employeeId: 'A', hours: 6, food: 1850.75, coffee: 120.5, cardTips: 305.4, cashTips: 95 }),
      one({ employeeId: 'B', hours: 5, food: 940.2, cardTips: 188.65, cashTips: 41.25 })],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 8 }],   // no busser, no barista
  });
  assert.ok(r.reconciliation.balanced);
  const charged = r.servers.reduce((a, s) => a + s.tipoutTotal, 0);
  const received = r.support.reduce((a, p) => a + p.tipShare, 0);
  assert.strictEqual(charged, received);          // not a penny stranded
  assert.strictEqual(r.orphanedPots.length, 0);
});

test('an unstaffed role leaves more in `remaining`, so the busser takes 13% of the larger pot', () => {
  const withCook = runShift({ servers: [one({ food: 2000, cardTips: 400 })],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 8 }, { employeeId: 'BU', name: 'b', role: 'busser', hours: 5 }] });
  const noCook = runShift({ servers: [one({ food: 2000, cardTips: 400 })],
    support: [{ employeeId: 'BU', name: 'b', role: 'busser', hours: 5 }] });
  assert.strictEqual(withCook.pots.busser, toCents(48.10));  // 13% of ($400 - $30)
  assert.strictEqual(noCook.pots.busser, toCents(52.00));    // 13% of the full $400
});

test('a busser listed with no hours yet still counts as on shift', () => {
  const r = runShift({ servers: [one({ food: 2000, cardTips: 300, cashTips: 100 })],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 8 }, { employeeId: 'BU', name: 'b', role: 'busser', hours: 0 }] });
  assert.ok(r.pots.busser > 0);            // charged, not skipped
  assert.strictEqual(r.skippedPots.length, 0);
  const busser = r.support.find((p) => p.role === 'busser');
  assert.strictEqual(busser.tipShare, r.pots.busser);   // sole busser gets all of it
});

// --- support staff see card vs cash, not rule internals --------------------

test('pool splits by source: cash jar and to-go card are tracked separately', () => {
  const r = runShift({
    servers: [one({ food: 1000, cardTips: 100 })],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 6 },
      { employeeId: 'BU', name: 'b', role: 'busser', hours: 2 }],
    pool: { jar: 80, togoCard: 40 },
  });
  const k = r.support.find((p) => p.role === 'kitchen');
  const b = r.support.find((p) => p.role === 'busser');
  // 6h vs 2h → 3:1 on each bucket independently.
  assert.strictEqual(k.poolCash, toCents(60));
  assert.strictEqual(b.poolCash, toCents(20));
  assert.strictEqual(k.poolCard, toCents(30));
  assert.strictEqual(b.poolCard, toCents(10));
  // Every cent of each bucket is handed out.
  assert.strictEqual(k.poolCash + b.poolCash, toCents(80));
  assert.strictEqual(k.poolCard + b.poolCard, toCents(40));
});

test('card total = server tip-out + to-go card; cash total = the jar only', () => {
  const r = runShift({
    servers: [one({ food: 2000, cardTips: 300, cashTips: 100 })],
    support: [{ employeeId: 'BU', name: 'b', role: 'busser', hours: 5 }],
    pool: { jar: 50, togoCard: 25 },
  });
  const b = r.support[0];
  assert.strictEqual(b.cardTotal, b.tipShare + b.poolCard);
  assert.strictEqual(b.cashTotal, b.poolCash);
  assert.strictEqual(b.poolCash, toCents(50));   // sole recipient takes the jar
  assert.strictEqual(b.poolCard, toCents(25));
  assert.strictEqual(b.cardTotal + b.cashTotal, b.tipShare + b.poolShare);
});

test('splitting the pool by source stays penny-exact on awkward amounts', () => {
  const r = runShift({
    servers: [one({ cardTips: 0 })],
    support: [{ employeeId: 'a', name: 'A', role: 'kitchen', hours: 7 },
      { employeeId: 'b', name: 'B', role: 'busser', hours: 5 },
      { employeeId: 'c', name: 'C', role: 'barista', hours: 3 }],
    pool: { jar: 100.01, togoCard: 33.33 },
  });
  assert.strictEqual(r.support.reduce((a, p) => a + p.poolCash, 0), toCents(100.01));
  assert.strictEqual(r.support.reduce((a, p) => a + p.poolCard, 0), toCents(33.33));
});

test('a support person with no tips at all reports zeros, not undefined', () => {
  const r = runShift({ servers: [one({ cardTips: 0 })],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 6 }] });
  const k = r.support[0];
  assert.strictEqual(k.cardTotal, 0);
  assert.strictEqual(k.cashTotal, 0);
  assert.strictEqual(k.poolCash, 0);
  assert.strictEqual(k.poolCard, 0);
});

// --- a pot may only be paid out once --------------------------------------

test('legacy "togo" is jar cash, not card, so it cannot double-pay to-go card', () => {
  // This exact shape existed in a live cafe policy and paid $160 out as $220.
  const rules = [
    { type: 'pool', source: 'togo', split: 'hours', among: 'all_support', payout: 'weekly_cash' },
    { type: 'pool', source: 'togo_card', split: 'hours', among: 'all_support', payout: 'paycheck' },
  ];
  const r = runShift({
    servers: [],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 5 },
      { employeeId: 'B', name: 'b', role: 'busser', hours: 5 }],
    pool: { jar: 100, togoCard: 60 },
  }, rules);
  const paid = r.support.reduce((a, p) => a + p.poolShare, 0);
  assert.strictEqual(paid, toCents(160), 'pays out exactly what went in');
  assert.strictEqual(r.support.reduce((a, p) => a + p.poolCard, 0), toCents(60));
  assert.strictEqual(r.support.reduce((a, p) => a + p.poolCash, 0), toCents(100));
});

test('two rules claiming the same pot pay it once and report the conflict', () => {
  const rules = [
    { type: 'pool', source: 'jar', split: 'hours', among: 'all_support', payout: 'weekly_cash' },
    { type: 'pool', source: 'jar_togo', split: 'hours', among: 'all_support', payout: 'paycheck' },
  ];
  const r = runShift({
    servers: [],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 5 }],
    pool: { jar: 100, togoCard: 40 },
  }, rules);
  // Jar was claimed first; the second rule may only take the card bucket.
  assert.strictEqual(r.support[0].poolCash, toCents(100));
  assert.strictEqual(r.support[0].poolCard, toCents(40));
  assert.strictEqual(r.support[0].poolShare, toCents(140), 'never more than went in');
  assert.strictEqual(r.poolConflicts.length, 1);
  assert.strictEqual(r.poolConflicts[0].source, 'cash');
});

test('default policy: jar pays weekly cash, to-go card pays on the paycheck', () => {
  const r = runShift({
    servers: [],
    support: [{ employeeId: 'K', name: 'k', role: 'kitchen', hours: 5 }],
    pool: { jar: 90, togoCard: 60 },
  });
  assert.strictEqual(r.support[0].poolShares.weekly_cash, toCents(90));
  assert.strictEqual(r.support[0].poolShares.paycheck, toCents(60));
  assert.strictEqual(r.poolConflicts.length, 0);
});

test('decimal hours split the pool exactly, not just quarter hours', () => {
  const r = runShift({
    servers: [one({ cardTips: 0 })],
    support: [{ employeeId: 'a', name: 'A', role: 'kitchen', hours: 7.33 },
      { employeeId: 'b', name: 'B', role: 'busser', hours: 4.87 },
      { employeeId: 'c', name: 'C', role: 'barista', hours: 3.05 }],
    pool: { jar: 100.01, togoCard: 57.77 },
  });
  assert.strictEqual(r.support.reduce((a, p) => a + p.poolCash, 0), toCents(100.01));
  assert.strictEqual(r.support.reduce((a, p) => a + p.poolCard, 0), toCents(57.77));
  assert.ok(r.support[0].poolCash > r.support[1].poolCash); // more hours, bigger share
});
