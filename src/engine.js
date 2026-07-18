'use strict';

const { toCents, pctOf, allocateByWeight, fmt } = require('./money');

// ---------------------------------------------------------------------------
// RULE-DRIVEN TIP-OUT ENGINE
// A policy is a LIST OF RULES (stored as data, editable in the UI). Two types:
//
//  tipout: a server gives `percent` of a `base` to a recipient role.
//    base ∈ food | coffee | alcohol | total_tips | remaining
//    (remaining = the server's tips left after all the non-remaining tip-outs)
//    Each recipient role's collected tip-outs are pooled and split among the
//    people working that role by `split` (hours | even).  → paid on paycheck.
//
//  pool: a shared pot (tip jar and/or to-go tips, entered per shift) split
//    `split` (hours | even) among `among` (all_support | kitchen | foh),
//    `payout` (weekly_cash | paycheck | nightly_cash).
// ---------------------------------------------------------------------------

const TIPOUT_ROLES = ['kitchen', 'barista', 'bartender', 'busser'];

/** Malek's current policy, as the default rule list. */
function defaultRules() {
  return [
    { type: 'tipout', recipient: 'kitchen', percent: 1.5, base: 'food', split: 'hours' },
    { type: 'tipout', recipient: 'barista', percent: 1.5, base: 'coffee', split: 'hours' },
    { type: 'tipout', recipient: 'bartender', percent: 5, base: 'alcohol', split: 'hours' },
    { type: 'tipout', recipient: 'busser', percent: 13, base: 'remaining', split: 'hours' },
    // Cash out of the jar is the only thing handed over by hand. To-go CARD
    // tips are card money, so they ride payroll like every other card tip.
    { type: 'pool', source: 'jar', split: 'hours', among: 'all_support', payout: 'weekly_cash' },
    { type: 'pool', source: 'togo_card', split: 'hours', among: 'all_support', payout: 'paycheck' },
  ];
}

function baseValue(server, base) {
  if (base === 'food') return server.food;
  if (base === 'coffee') return server.coffee;
  if (base === 'alcohol') return server.alcohol;
  if (base === 'total_tips') return server.cardTips + server.cashTips;
  return 0; // 'remaining' handled separately
}

function poolRecipients(support, among) {
  if (among === 'kitchen') return support.filter((p) => p.role === 'kitchen');
  if (among === 'foh') return support.filter((p) => ['busser', 'barista'].includes(p.role));
  return support.slice(); // all_support
}

/**
 * @param shift  { servers:[...], support:[...], pool:{ jar, togo } }  (dollars)
 * @param rules  rule list (defaults to defaultRules())
 */
function runShift(shift, rules) {
  rules = Array.isArray(rules) && rules.length ? rules : defaultRules();
  const tipoutRules = rules.filter((r) => r.type === 'tipout');
  const poolRules = rules.filter((r) => r.type === 'pool');

  const servers = (shift.servers || []).map((s) => ({
    employeeId: s.employeeId, name: s.name, hours: Number(s.hours) || 0,
    food: toCents(s.food), coffee: toCents(s.coffee), alcohol: toCents(s.alcohol),
    cardTips: toCents(s.cardTips), cashTips: toCents(s.cashTips),
  }));
  const support = (shift.support || []).map((p) => ({
    employeeId: p.employeeId, name: p.name, role: p.role, hours: Number(p.hours) || 0,
    // Tips a support person reported under their own name — pooled, not kept.
    cashTips: toCents(p.cashTips), cardTips: toCents(p.cardTips),
  }));

  // A tip-out is only charged when somebody actually worked the role that night.
  // Short a busser? There's nobody to hand that 13% to, so the server keeps it —
  // the alternative is docking a server for a coworker who was never there and
  // letting the money sit unassigned.
  const staffedRoles = new Set(support.map((p) => p.role));

  const rolePools = {}; // role -> cents
  const roleSplit = {}; // role -> split method
  const skippedPots = {}; // role -> cents servers kept because nobody worked it
  const serverPayouts = [];

  for (const s of servers) {
    const totalTips = s.cardTips + s.cashTips;
    const tipouts = {}; // role -> cents (this server)
    let directSum = 0;

    const charge = (role, amt) => {
      if (staffedRoles.has(role)) {
        tipouts[role] = (tipouts[role] || 0) + amt;
        return true;
      }
      skippedPots[role] = (skippedPots[role] || 0) + amt;
      return false;
    };

    for (const r of tipoutRules) {
      if (r.base === 'remaining') continue;
      const amt = pctOf(baseValue(s, r.base), r.percent);
      if (charge(r.recipient, amt)) directSum += amt;
      roleSplit[r.recipient] = r.split;
    }
    // Note the ordering: an unstaffed role leaves more in `remaining`, so a
    // busser correctly takes 13% of the larger pot on a night with no barista.
    const remaining = totalTips - directSum;
    for (const r of tipoutRules) {
      if (r.base !== 'remaining') continue;
      charge(r.recipient, pctOf(Math.max(remaining, 0), r.percent));
      roleSplit[r.recipient] = r.split;
    }

    const tipoutTotal = Object.values(tipouts).reduce((a, b) => a + b, 0);
    for (const role of Object.keys(tipouts)) rolePools[role] = (rolePools[role] || 0) + tipouts[role];

    serverPayouts.push({
      employeeId: s.employeeId, name: s.name, role: 'server', hours: s.hours,
      sales: { food: s.food, coffee: s.coffee, alcohol: s.alcohol },
      cardTips: s.cardTips, cashTips: s.cashTips, totalTips,
      tipouts, tipoutTotal, tipsKept: totalTips - tipoutTotal,
    });
  }

  // Distribute each role's pool among the people working that role.
  const roleShare = new Map(); // employeeId -> cents (paycheck)
  const orphanedPots = [];
  for (const role of Object.keys(rolePools)) {
    if (rolePools[role] === 0) continue;
    const people = support.filter((p) => p.role === role);
    if (!people.length) { orphanedPots.push({ role, cents: rolePools[role] }); continue; }
    const split = roleSplit[role] || 'hours';
    const alloc = allocateByWeight(rolePools[role], people.map((p) => ({ id: p.employeeId, weight: split === 'even' ? 1 : p.hours })));
    for (const [id, c] of alloc) roleShare.set(id, (roleShare.get(id) || 0) + c);
  }

  // Two buckets per shift: the CASH tip jar (all cash tips go in the jar) and
  // TO-GO CARD tips. A rule targets one or both. (`togoCash`/`togo` in old data
  // just folds into the cash jar.)
  // Pool money comes from two places: what the manager counts (jar / to-go
  // card) and what support staff reported under their own names. Both land in
  // the same buckets, then get split by hours — nobody keeps their own.
  const pool = shift.pool || {};
  const legacyCash = pool.togoCash != null ? pool.togoCash : pool.togo;
  const staffCash = support.reduce((a, p) => a + p.cashTips, 0);
  const staffCard = support.reduce((a, p) => a + p.cardTips, 0);
  const cash = toCents(pool.jar) + toCents(legacyCash) + staffCash;
  const togoCard = toCents(pool.togoCard) + staffCard;
  // Allocate each bucket SEPARATELY even when one rule covers both, so we can
  // tell someone "$X of this was card, $Y was cash out of the jar". Splitting
  // the allocation keeps it penny-exact either way.
  // 'togo' / 'togo_cash' are old names for jar money — cash, not card. Letting
  // them fall through to "both buckets" made a policy with a separate
  // togo_card rule pay the card money out twice.
  const sourceBuckets = (src) => {
    if (src === 'togo_card') return [['card', togoCard]];
    if (src === 'jar' || src === 'cash' || src === 'togo' || src === 'togo_cash') return [['cash', cash]];
    return [['cash', cash], ['card', togoCard]]; // 'jar_togo' / unset
  };
  const poolShareMap = new Map();  // employeeId -> { <payout>: cents }
  const poolSourceMap = new Map(); // employeeId -> { cash: cents, card: cents }
  const claimed = new Set();       // a bucket may only be paid out once
  const poolConflicts = [];
  let poolTotal = 0;
  for (const r of poolRules) {
    const recips = poolRecipients(support, r.among);
    const split = r.split || 'hours';
    const payout = r.payout || 'weekly_cash';
    for (const [source, amount] of sourceBuckets(r.source)) {
      // Two rules claiming the same pot would invent money out of nothing.
      // Pay it once and tell the manager the policy is contradicting itself.
      if (claimed.has(source)) { poolConflicts.push({ source, rule: r.source || 'jar_togo' }); continue; }
      claimed.add(source);
      if (amount === 0) continue;
      if (!recips.length) { orphanedPots.push({ role: 'shared pool', cents: amount }); continue; }
      poolTotal += amount;
      const alloc = allocateByWeight(amount, recips.map((p) => ({ id: p.employeeId, weight: split === 'even' ? 1 : p.hours })));
      for (const [id, c] of alloc) {
        const byPayout = poolShareMap.get(id) || {};
        byPayout[payout] = (byPayout[payout] || 0) + c;
        poolShareMap.set(id, byPayout);
        const bySource = poolSourceMap.get(id) || {};
        bySource[source] = (bySource[source] || 0) + c;
        poolSourceMap.set(id, bySource);
      }
    }
  }

  const supportResult = support.map((p) => {
    const shares = poolShareMap.get(p.employeeId) || {}; // { weekly_cash, paycheck, ... }
    const bySource = poolSourceMap.get(p.employeeId) || {};
    const poolShare = Object.values(shares).reduce((a, b) => a + b, 0);
    const tipShare = roleShare.get(p.employeeId) || 0;
    return {
      employeeId: p.employeeId, name: p.name, role: p.role, hours: p.hours,
      tipShare,                                      // role tip-out → paycheck
      poolShare,                                     // total across the shared pool(s)
      poolShares: shares,                            // broken down by payout method
      poolCash: bySource.cash || 0,                  // their cut of the cash jar
      poolCard: bySource.card || 0,                  // their cut of to-go card tips
      // What they earned tonight, grouped the way they get asked about it:
      // card money rides payroll, jar cash is handed over in person.
      cardTotal: tipShare + (bySource.card || 0),
      cashTotal: bySource.cash || 0,
    };
  });

  const totalTipsCollected = serverPayouts.reduce((a, x) => a + x.totalTips, 0);
  const totalKept = serverPayouts.reduce((a, x) => a + x.tipsKept, 0);
  const totalPots = Object.values(rolePools).reduce((a, b) => a + b, 0);

  return {
    servers: serverPayouts, support: supportResult,
    pots: rolePools, pool: { cash, togoCard, total: poolTotal }, orphanedPots, poolConflicts,
    skippedPots: Object.entries(skippedPots).filter(([, c]) => c > 0).map(([role, cents]) => ({ role, cents })),
    reconciliation: { totalTipsCollected, totalKept, totalPots, balanced: totalTipsCollected === totalKept + totalPots },
  };
}

module.exports = { runShift, defaultRules, TIPOUT_ROLES, fmt };
