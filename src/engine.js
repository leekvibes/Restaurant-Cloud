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
    { type: 'pool', source: 'jar_togo', split: 'hours', among: 'all_support', payout: 'weekly_cash' },
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
  }));

  const rolePools = {}; // role -> cents
  const roleSplit = {}; // role -> split method
  const serverPayouts = [];

  for (const s of servers) {
    const totalTips = s.cardTips + s.cashTips;
    const tipouts = {}; // role -> cents (this server)
    let directSum = 0;

    for (const r of tipoutRules) {
      if (r.base === 'remaining') continue;
      const amt = pctOf(baseValue(s, r.base), r.percent);
      tipouts[r.recipient] = (tipouts[r.recipient] || 0) + amt;
      directSum += amt;
      roleSplit[r.recipient] = r.split;
    }
    const remaining = totalTips - directSum;
    for (const r of tipoutRules) {
      if (r.base !== 'remaining') continue;
      const amt = pctOf(Math.max(remaining, 0), r.percent);
      tipouts[r.recipient] = (tipouts[r.recipient] || 0) + amt;
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
  const pool = shift.pool || {};
  const legacyCash = pool.togoCash != null ? pool.togoCash : pool.togo;
  const cash = toCents(pool.jar) + toCents(legacyCash);
  const togoCard = toCents(pool.togoCard);
  const sourceAmount = (src) => {
    if (src === 'togo_card') return togoCard;
    if (src === 'jar' || src === 'cash') return cash;
    return cash + togoCard; // 'jar_togo' / everything (and any legacy source)
  };
  const poolShareMap = new Map(); // employeeId -> { <payout>: cents }
  let poolTotal = 0;
  for (const r of poolRules) {
    const amount = sourceAmount(r.source);
    if (amount === 0) continue;
    const recips = poolRecipients(support, r.among);
    if (!recips.length) { orphanedPots.push({ role: 'shared pool', cents: amount }); continue; }
    poolTotal += amount;
    const split = r.split || 'hours';
    const payout = r.payout || 'weekly_cash';
    const alloc = allocateByWeight(amount, recips.map((p) => ({ id: p.employeeId, weight: split === 'even' ? 1 : p.hours })));
    for (const [id, c] of alloc) {
      const cur = poolShareMap.get(id) || {};
      cur[payout] = (cur[payout] || 0) + c;
      poolShareMap.set(id, cur);
    }
  }

  const supportResult = support.map((p) => {
    const shares = poolShareMap.get(p.employeeId) || {}; // { weekly_cash, paycheck, ... }
    const poolShare = Object.values(shares).reduce((a, b) => a + b, 0);
    return {
      employeeId: p.employeeId, name: p.name, role: p.role, hours: p.hours,
      tipShare: roleShare.get(p.employeeId) || 0,   // role tip-out → paycheck
      poolShare,                                     // total across the shared pool(s)
      poolShares: shares,                            // broken down by payout method
    };
  });

  const totalTipsCollected = serverPayouts.reduce((a, x) => a + x.totalTips, 0);
  const totalKept = serverPayouts.reduce((a, x) => a + x.tipsKept, 0);
  const totalPots = Object.values(rolePools).reduce((a, b) => a + b, 0);

  return {
    servers: serverPayouts, support: supportResult,
    pots: rolePools, pool: { cash, togoCard, total: poolTotal }, orphanedPots,
    reconciliation: { totalTipsCollected, totalKept, totalPots, balanced: totalTipsCollected === totalKept + totalPots },
  };
}

module.exports = { runShift, defaultRules, TIPOUT_ROLES, fmt };
