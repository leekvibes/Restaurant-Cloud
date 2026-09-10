'use strict';

const { toCents, pctOf, allocateByWeight, fmt } = require('./money');

// ---------------------------------------------------------------------------
// RULE-DRIVEN TIP-OUT ENGINE
// A policy is a LIST OF RULES (stored as data, editable in the UI). Two types:
//
//  tipout: a server gives `percent` of a `base` to a recipient role.
//    base ∈ food | coffee | alcohol | total_sales | total_tips | remaining
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
  // Every category a server rang. The busser rule that ran until 18 Jul 2026
  // was 2% of gross sales rather than a share of tips, and the engine had no
  // way to say that — which meant the two months before ZWIN could not be
  // reproduced inside it at all.
  if (base === 'total_sales') return server.food + server.coffee + server.alcohol;
  if (base === 'total_tips') return server.cardTips + server.cashTips;
  return 0; // 'remaining' handled separately
}

/**
 * Who shares a pool. Anyone flagged tipEligible:false is on the clock but out
 * of the tip system entirely (a trainee, say) — including them would hand them
 * a share AND shrink everyone else's, since the split is weighted by hours.
 */
/**
 * Which money buckets a pool rule's `source` names. 'togo'/'togo_cash' are old
 * names for jar money -- cash, not card; letting them fall through to "both"
 * made a policy with a separate togo_card rule pay the card money out twice.
 */
function bucketsOf(src) {
  if (src === 'togo_card') return ['card'];
  if (src === 'jar' || src === 'cash' || src === 'togo' || src === 'togo_cash') return ['cash'];
  return ['cash', 'card']; // 'jar_togo' / unset
}

function poolRecipients(support, among) {
  const eligible = support.filter((p) => p.tipEligible !== false);
  if (among === 'kitchen') return eligible.filter((p) => p.role === 'kitchen');
  if (among === 'foh') return eligible.filter((p) => ['busser', 'barista'].includes(p.role));
  // Named roles — one, or a list. "Bartenders pool their own tips together",
  // and "the register pot is shared by whoever was working the bar or the
  // counter", neither of which the three fixed groups above could express.
  //
  // An empty result is returned as empty rather than falling back to everybody:
  // a pot for baristas on a night with no barista must go to the orphan list
  // for somebody to decide about, not quietly to the whole house — least of all
  // to the busser, who is paid by a percentage precisely so they are not in it.
  if (among && among !== 'all_support') {
    const want = new Set(Array.isArray(among) ? among : [among]);
    return eligible.filter((p) => want.has(p.role));
  }
  return eligible; // all_support
}

/**
 * @param shift  { servers:[...], support:[...], pool:{ jar, togo } }  (dollars)
 * @param rules  rule list (defaults to defaultRules())
 */
function runShift(shift, rules) {
  rules = Array.isArray(rules) && rules.length ? rules : defaultRules();
  const tipoutRules = rules.filter((r) => r.type === 'tipout');
  const poolRules = rules.filter((r) => r.type === 'pool');

  // `servers` is every DIRECT-SERVICE earner — somebody who serves guests,
  // keeps what they are tipped, and pays the tip-outs their role owes. It is
  // no longer only the position called 'server': a bartender working the bar
  // and a barista working the counter are the same shape of thing, and calling
  // them support was what pooled their tips with the house.
  const servers = (shift.servers || []).map((s) => ({
    employeeId: s.employeeId, name: s.name, role: s.role || 'server',
    hours: Number(s.hours) || 0,
    food: toCents(s.food), coffee: toCents(s.coffee), alcohol: toCents(s.alcohol),
    cardTips: toCents(s.cardTips), cashTips: toCents(s.cashTips),
  }));
  const support = (shift.support || []).map((p) => ({
    employeeId: p.employeeId, name: p.name, role: p.role, hours: Number(p.hours) || 0,
    // Tips a support person reported under their own name — pooled, not kept.
    cashTips: toCents(p.cashTips), cardTips: toCents(p.cardTips),
    tipEligible: p.tipEligible !== false,
  }));

  // A tip-out is only charged when somebody actually worked the role that night.
  // Short a busser? There's nobody to hand that 13% to, so the server keeps it —
  // the alternative is docking a server for a coworker who was never there and
  // letting the money sit unassigned.
  const staffedRoles = new Set(support.filter((p) => p.tipEligible).map((p) => p.role));

  const rolePools = {}; // role -> cents
  const roleSplit = {}; // role -> split method
  const skippedPots = {}; // role -> cents servers kept because nobody worked it
  const transfers = [];   // pot -> pot movements, for the receipt to explain
  const potFrom = {};     // role -> [{ kind, employeeId|role, cents }] — who funded it
  const serverPayouts = [];

  /**
   * Does this earner pay this rule?
   *
   * A rule with no `paidBy` is paid by everybody, which is what every policy
   * written before today means and why none of them had to be rewritten.
   *
   * Naming payers is what the Palm policy needs: a server pays the busser 2%
   * and a bartender does not; a bartender pays the barback and a server does
   * not. Before this, a rule was charged to every direct earner alike and the
   * two could not be told apart.
   */
  // What the manager changed about tonight, keyed the way the table names a
  // rule: who it pays, and who pays it.
  const adjustments = shift.adjustments || [];
  //
  // A PERSON row is not a rule row, and must not be read as one. Both name a
  // recipient, so "Joseph, $80" matched the busser rule here and charged the
  // whole busser POT $80 — which split across both bussers and then got
  // adjusted a second time further down. One row, applied twice, two different
  // ways. A row that names somebody is theirs alone.
  const adjustmentFor = (earner, r) => adjustments.find((a) => a.employee_id == null
    && a.recipient === r.recipient
    && (!a.paid_by || a.paid_by === (earner.role || 'server'))) || null;
  // An amount is what the RECIPIENT should end up with, so when several people
  // pay the same rule it is shared between them rather than charged to each in
  // full — otherwise "give the busser $40" takes $40 from every server.
  //
  // Split by running total rather than by dividing and rounding: $40 across
  // three servers is 13.33 each, which rounds to $39.99 and hands the busser a
  // penny less than the figure that was typed. The differences of the running
  // total always sum to exactly the amount.
  const payersOf = (r) => {
    const who = r.paidBy ? (Array.isArray(r.paidBy) ? r.paidBy : [r.paidBy]) : null;
    return servers.filter((e) => !who || who.includes(e.role || 'server'));
  };
  const exactShare = (total, i, n) => (n <= 1 ? total
    : Math.round((total * (i + 1)) / n) - Math.round((total * i) / n));
  const adjusted = [];

  const paysThis = (earner, r) => {
    if (!r.paidBy) return true;
    const who = Array.isArray(r.paidBy) ? r.paidBy : [r.paidBy];
    return who.includes(earner.role || 'server');
  };

  for (const s of servers) {
    const totalTips = s.cardTips + s.cashTips;
    const tipouts = {}; // role -> cents (this server)
    let directSum = 0;

    const charge = (role, amt) => {
      if (staffedRoles.has(role)) {
        tipouts[role] = (tipouts[role] || 0) + amt;
        // WHERE THIS POT'S MONEY CAME FROM, recorded as it arrives.
        //
        // Handing money back needs to know who handed it over. Without this the
        // engine knows a busser pot holds $189.60 and not that $72.60 of it is
        // Sandra's, so "give him $80 instead of $100" has nowhere honest to put
        // the $20 and it either vanishes or lands on whoever is convenient.
        (potFrom[role] || (potFrom[role] = []))
          .push({ kind: 'earner', employeeId: s.employeeId, cents: amt });
        return true;
      }
      skippedPots[role] = (skippedPots[role] || 0) + amt;
      return false;
    };

    for (const r of tipoutRules) {
      if (r.from) continue;              // paid out of another role's pot, not by an earner
      if (!paysThis(s, r)) continue;     // not this earner's rule
      // Never to yourself. A bartender pays the barback, and a rule that also
      // named bartenders as recipients would otherwise have them tipping
      // themselves — money round in a circle, and a pot that cannot be split.
      if (r.recipient === (s.role || 'server')) continue;
      if (r.base === 'remaining') continue;
      const adj = adjustmentFor(s, r);
      // Off means the rule is not charged, and the earner keeps it — the same
      // thing that happens when nobody worked the role. Not "the recipient gets
      // nothing and the money vanishes", which is not a thing money does.
      if (adj && adj.mode === 'off') { adjusted.push({ role: r.recipient, by: s.role || 'server', mode: 'off' }); continue; }
      let amt;
      if (adj && adj.mode === 'amount') {
        const payers = payersOf(r);
        const idx = Math.max(0, payers.findIndex((e) => e.employeeId === s.employeeId));
        amt = Math.max(0, exactShare(Math.max(0, Math.round(adj.cents)), idx, payers.length || 1));
      } else {
        amt = pctOf(baseValue(s, r.base), r.percent);
      }
      if (charge(r.recipient, amt)) directSum += amt;
      roleSplit[r.recipient] = r.split;
    }
    // Note the ordering: an unstaffed role leaves more in `remaining`, so a
    // busser correctly takes 13% of the larger pot on a night with no barista.
    const remaining = totalTips - directSum;
    for (const r of tipoutRules) {
      if (r.from) continue;
      if (!paysThis(s, r)) continue;
      if (r.recipient === (s.role || 'server')) continue;
      if (r.base !== 'remaining') continue;
      charge(r.recipient, pctOf(Math.max(remaining, 0), r.percent));
      roleSplit[r.recipient] = r.split;
    }

    const tipoutTotal = Object.values(tipouts).reduce((a, b) => a + b, 0);
    for (const role of Object.keys(tipouts)) rolePools[role] = (rolePools[role] || 0) + tipouts[role];

    serverPayouts.push({
      employeeId: s.employeeId, name: s.name, role: s.role || 'server', hours: s.hours,
      sales: { food: s.food, coffee: s.coffee, alcohol: s.alcohol },
      cardTips: s.cardTips, cashTips: s.cashTips, totalTips,
      tipouts, tipoutTotal, tipsKept: totalTips - tipoutTotal,
    });
  }

  // A TIP-OUT THAT COMES OUT OF ANOTHER ROLE'S POT.
  //
  // "Bartenders tip out barbacks 3% of bar sales" is not the servers paying the
  // barback — it is the bartender paying them, out of the 10% the servers
  // already handed over. The distinction is invisible on a night when both
  // roles are worked and decides the money on a night when one is not:
  //
  //   split into two server-paid rules (7% + 3%)  →  no barback, and the
  //     SERVERS keep the 3%. The bartender is docked for somebody who never
  //     came in.
  //   taken from the bartender's pot (this)       →  no barback, and the
  //     bartender keeps the whole 10%, which is what the policy says.
  //
  // Servers pay the same either way. This only decides where it lands.
  //
  // Applied AFTER the server tip-outs, because it moves money that only exists
  // once those have been charged, and clamped to what is actually in the pot —
  // a transfer can redistribute a pot, never invent one.
  for (const r of tipoutRules) {
    if (!r.from) continue;
    if (!staffedRoles.has(r.recipient)) continue;   // nobody to hand it to: it stays put
    const available = rolePools[r.from] || 0;
    if (available <= 0) continue;
    const base = r.base === 'pot'
      ? available                                    // a share of what they were tipped
      : servers.reduce((a, sv) => a + pctOf(baseValue(sv, r.base), r.percent), 0);
    const amt = Math.min(r.base === 'pot' ? pctOf(available, r.percent) : base, available);
    if (amt <= 0) continue;
    rolePools[r.from] -= amt;
    rolePools[r.recipient] = (rolePools[r.recipient] || 0) + amt;
    roleSplit[r.recipient] = r.split || 'hours';
    transfers.push({ from: r.from, to: r.recipient, cents: amt });
    // The barback's pot was funded by the bartenders' pot, so money handed back
    // out of it goes there and not to the servers, who already paid it once.
    (potFrom[r.recipient] || (potFrom[r.recipient] = []))
      .push({ kind: 'pot', role: r.from, cents: amt });
  }

  // Distribute each role's pool among the people working that role.
  const roleShare = new Map(); // employeeId -> cents (paycheck)
  const orphanedPots = [];
  for (const role of Object.keys(rolePools)) {
    if (rolePools[role] === 0) continue;
    const people = support.filter((p) => p.role === role && p.tipEligible);
    if (!people.length) { orphanedPots.push({ role, cents: rolePools[role] }); continue; }
    const split = roleSplit[role] || 'hours';
    const alloc = allocateByWeight(rolePools[role], people.map((p) => ({ id: p.employeeId, weight: split === 'even' ? 1 : p.hours })));
    for (const [id, c] of alloc) roleShare.set(id, (roleShare.get(id) || 0) + c);
  }

  // ---------------------------------------------------------------------
  // ONE PERSON'S TAKE, SET BY HAND — and the difference goes home.
  //
  // A rate is a rule about the ordinary night. Some nights one person's share
  // is simply wrong: they came in at nine, they covered two sections, they
  // agreed something with the manager. The figure is theirs to set.
  //
  // WHAT MAKES IT SAFE is that this MOVES money and never edits a number. Take
  // $20 off a busser and it goes back to the servers who paid it, in the
  // proportion they paid it — not to the other busser, who earned theirs, and
  // not nowhere, which is what "just change the number" means. Give a busser
  // $20 more and it comes off those same servers. Either direction, the service
  // still adds up to exactly what was collected.
  //
  // Money that came from another POT goes back to that pot: the barback's share
  // was funded by the bartenders, so handing it back hands it to them, not to
  // the servers who had already paid it once.
  // ---------------------------------------------------------------------
  const refundEarner = new Map();  // employeeId -> cents back to what they keep
  const refundPot = new Map();     // role -> cents back into that pot
  const personSet = [];            // what was set, for the page to explain
  const keptOf = new Map(serverPayouts.map((p) => [p.employeeId, p.tipsKept]));

  for (const a of adjustments) {
    if (a.employee_id == null || a.mode !== 'amount') continue;
    const p = support.find((x) => x.employeeId === a.employee_id && x.tipEligible !== false);
    if (!p) continue;
    const current = roleShare.get(p.employeeId) || 0;
    const target = Math.max(0, Math.round(a.cents || 0));
    let delta = current - target;                 // positive: hand money back
    if (!delta) continue;

    const src = (potFrom[p.role] || []).filter((x) => x.cents > 0);
    const totalSrc = src.reduce((x, y) => x + y.cents, 0);
    if (totalSrc <= 0) continue;                  // nothing funded it; nothing to unwind

    // Each source's share of the difference: proportional to what it PUT IN,
    // which is the only defensible answer to "whose money was that".
    const parts = new Array(src.length).fill(0);
    let handed = 0;
    src.forEach((x, i) => {
      const part = i === src.length - 1 ? delta - handed : Math.round((delta * x.cents) / totalSrc);
      handed += part;
      parts[i] = part;
    });

    // TAKING MORE THAN A PAYER HAS IS NOT A THING MONEY DOES.
    //
    // Raising somebody is capped at what the people funding them still hold,
    // and PER PERSON rather than in total: capping only the sum let the biggest
    // payer absorb a share larger than everything they had and finish the night
    // owing money. Whatever one payer cannot cover is offered to the others who
    // still have room, and if nobody does, the figure lands at what could
    // actually be moved. A number the books cannot support is not a figure.
    if (delta < 0) {
      const roomOf = (x) => (x.kind === 'earner'
        ? Math.max(0, keptOf.get(x.employeeId) || 0)
        : Math.max(0, rolePools[x.role] || 0));
      const room = src.map(roomOf);
      let short = 0;
      src.forEach((x, i) => {
        const want = -parts[i];                       // positive: taking this much
        if (want > room[i]) { short += want - room[i]; parts[i] = -room[i]; room[i] = 0; }
        else room[i] -= want;
      });
      // Spread the shortfall over whoever is left, until it is placed or there
      // is nowhere left to place it.
      for (let pass = 0; pass < src.length && short > 0; pass++) {
        const open = src.map((x, i) => i).filter((i) => room[i] > 0);
        if (!open.length) break;
        const each = Math.ceil(short / open.length);
        for (const i of open) {
          if (short <= 0) break;
          const take = Math.min(each, room[i], short);
          parts[i] -= take; room[i] -= take; short -= take;
        }
      }
      delta = parts.reduce((a, b) => a + b, 0);       // what could really be moved
    }
    if (!delta) continue;

    src.forEach((x, i) => {
      const part = parts[i];
      if (!part) return;
      // Keyed by person AND the pot it came out of. Keyed by person alone, a
      // night where somebody was adjusted for two different roles put both
      // differences on whichever tip-out happened to be listed first — the
      // totals still added up and the breakdown said something untrue.
      if (x.kind === 'earner') {
        const k = `${x.employeeId}|${p.role}`;
        refundEarner.set(k, (refundEarner.get(k) || 0) + part);
      } else refundPot.set(x.role, (refundPot.get(x.role) || 0) + part);
    });

    roleShare.set(p.employeeId, current - delta);
    rolePools[p.role] = (rolePools[p.role] || 0) - delta;
    personSet.push({ employeeId: p.employeeId, name: p.name, role: p.role,
      from: current, to: current - delta, reason: a.reason || null });
  }

  // Back to the people who paid it. A refund raises what a server keeps and
  // lowers what they are recorded as having tipped out, because those are the
  // same fact said twice.
  for (const [key, cents] of refundEarner) {
    const [idPart, role] = key.split('|');
    const sp = serverPayouts.find((x) => String(x.employeeId) === idPart);
    if (!sp) continue;
    sp.tipsKept += cents;
    sp.tipoutTotal -= cents;
    sp.tipouts[role] = Math.max(0, (sp.tipouts[role] || 0) - cents);
  }
  // Back into a pot, then straight out again to the people working that role —
  // by the same weights the pot is always split by.
  for (const [role, cents] of refundPot) {
    rolePools[role] = (rolePools[role] || 0) + cents;
    const people = support.filter((x) => x.role === role && x.tipEligible);
    if (!people.length) { orphanedPots.push({ role, cents }); continue; }
    const split = roleSplit[role] || 'hours';
    // Split the SIZE and put the sign back afterwards. allocateByWeight floors
    // and hands out leftover pennies upward, which is right for sharing money
    // out and silently wrong for taking it back — a negative total came out as
    // nothing moving at all.
    const sign = cents < 0 ? -1 : 1;
    for (const [id, c] of allocateByWeight(Math.abs(cents), people.map((x) => ({ id: x.employeeId, weight: split === 'even' ? 1 : x.hours })))) {
      roleShare.set(id, (roleShare.get(id) || 0) + sign * c);
    }
  }

  // Two buckets per shift: the CASH tip jar (all cash tips go in the jar) and
  // TO-GO CARD tips. A rule targets one or both. (`togoCash`/`togo` in old data
  // just folds into the cash jar.)
  // Pool money comes from two places: what the manager counts (jar / to-go
  // card) and what support staff reported under their own names. Both land in
  // the same buckets, then get split by hours — nobody keeps their own.
  const pool = shift.pool || {};
  const legacyCash = pool.togoCash != null ? pool.togoCash : pool.togo;
  // A PERSON'S REPORTED TIPS ARE SWEPT ONLY INTO A POT THEY COULD BE PAID FROM.
  //
  // Two ways that went wrong, and they are the same mistake. A trainee is
  // explicitly out of every pool, precisely so their hours do not dilute it —
  // yet cash they were handed was taken off them and given to somebody else,
  // with no way to get a penny back. And the evening policy has no pool rule at
  // all (there is no cash tip jar at night; every penny moves by percentage) —
  // yet a busser's reported cash was still swept into "the pool", where the
  // payout loop below never runs, so it left their total and arrived nowhere.
  // Contributing to a pot you cannot be paid from is not a rule anybody wrote
  // down; it was the absence of one. What is not swept stays theirs, below.
  const pooled = new Set();
  for (const r of poolRules) for (const b of bucketsOf(r.source)) pooled.add(b);
  const staffCash = pooled.has('cash')
    ? support.reduce((a, p) => a + (p.tipEligible === false ? 0 : p.cashTips), 0) : 0;
  const staffCard = pooled.has('card')
    ? support.reduce((a, p) => a + (p.tipEligible === false ? 0 : p.cardTips), 0) : 0;
  // Money the manager counted stays on the books either way -- if it is sitting
  // in a bucket no rule pays out, the sheet should say so, not swallow it.
  const cash = toCents(pool.jar) + toCents(legacyCash) + staffCash;
  const togoCard = toCents(pool.togoCard) + staffCard;
  // Allocate each bucket SEPARATELY even when one rule covers both, so we can
  // tell someone "$X of this was card, $Y was cash out of the jar". Splitting
  // the allocation keeps it penny-exact either way.
  const sourceBuckets = (src) => bucketsOf(src).map((b) => [b, b === 'card' ? togoCard : cash]);
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
    // Tips they reported that no pool rule claimed — see the sweep above.
    const keptCash = pooled.has('cash') && p.tipEligible ? 0 : p.cashTips;
    const keptCard = pooled.has('card') && p.tipEligible ? 0 : p.cardTips;
    return {
      employeeId: p.employeeId, name: p.name, role: p.role, hours: p.hours,
      tipShare,                                      // role tip-out → paycheck
      poolShare,                                     // total across the shared pool(s)
      poolShares: shares,                            // broken down by payout method
      poolCash: bySource.cash || 0,                  // their cut of the cash jar
      poolCard: bySource.card || 0,                  // their cut of to-go card tips
      keptCash,                                      // reported cash nothing pooled
      keptCard,                                      // reported card nothing pooled
      // What they earned tonight, grouped the way they get asked about it:
      // card money rides payroll, jar cash is handed over in person.
      cardTotal: tipShare + (bySource.card || 0) + keptCard,
      cashTotal: (bySource.cash || 0) + keptCash,
    };
  });

  const totalTipsCollected = serverPayouts.reduce((a, x) => a + x.totalTips, 0);
  const totalKept = serverPayouts.reduce((a, x) => a + x.tipsKept, 0);
  const totalPots = Object.values(rolePools).reduce((a, b) => a + b, 0);

  return {
    servers: serverPayouts, support: supportResult,
    pots: rolePools, transfers, adjusted, personSet, potFrom, pool: { cash, togoCard, total: poolTotal }, orphanedPots, poolConflicts,
    skippedPots: Object.entries(skippedPots).filter(([, c]) => c > 0).map(([role, cents]) => ({ role, cents })),
    reconciliation: { totalTipsCollected, totalKept, totalPots, balanced: totalTipsCollected === totalKept + totalPots },
  };
}

module.exports = { runShift, defaultRules, TIPOUT_ROLES, fmt, bucketsOf };
