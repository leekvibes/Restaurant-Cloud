'use strict';

// ---------------------------------------------------------------------------
// RECONCILE — does ZWIN's engine reproduce the spreadsheet, to the cent?
//
// The workbook checks its own arithmetic on every one of its 72 days, and all
// but one reconcile to $0.00. That gives a free, exact test of the import: run
// each imported service through ZWIN's tip engine and compare the pools it
// produces against Section B of the sheet.
//
// A day that does not match is not imported blind — it is reported and the
// owner decides. Run against a COPY of the database.
//
//   DB_PATH=/tmp/check.db node scripts/reconcile-backfill.js
// ---------------------------------------------------------------------------

const path = require('node:path');
const BF = require('../src/backfill');
const { db, shiftInputs } = require('../src/db');
const { runShift } = require('../src/engine');

const money = (c) => '$' + (Math.round(c) / 100).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);

const days = BF.loadData();
if (!days) { console.error('no data/backfill-2026.json'); process.exit(1); }

console.log(`Importing ${days.length} days into ${process.env.DB_PATH}\n`);
const res = BF.run({ force: true });
if (!res.ran) { console.error('import did not run:', res.why); process.exit(1); }

const r = res.report;
console.log(`inserted ${r.inserted.length} services · ${r.staff} staff rows · ${r.servers} server-sales rows`);
if (r.created.length) console.log(`created staff : ${[...new Set(r.created)].join(', ')}`);
if (r.matched.length) console.log(`matched staff : ${[...new Set(r.matched)].join(' | ')}`);
if (r.skipped.length) console.log(`skipped: ${JSON.stringify(r.skipped)}`);
console.log();

// --- now check every one of them against the sheet --------------------------
const byDate = new Map(days.map((d) => [d.date, d]));
const shifts = db.prepare("SELECT id, date, policy_id FROM shifts WHERE daypart='cafe' ORDER BY date").all();

let ok = 0;
const bad = [];
let totalHours = 0, totalWages = 0;

for (const sh of shifts) {
  const sheet = byDate.get(sh.date);
  if (!sheet) continue;

  const inp = shiftInputs(sh.id);
  const out = runShift(inp, BF.HISTORIC_RULES);

  const got = {};
  for (const s of out.servers) for (const [k, v] of Object.entries(s.tipouts || {})) got[k] = (got[k] || 0) + v;

  const want = {
    kitchen: sheet.pools.kitchen || 0,
    barista: sheet.pools.barista || 0,
    bartender: sheet.pools.bartender || 0,
    busser: sheet.pools.busser || 0,
  };

  const diffs = [];
  for (const role of Object.keys(want)) {
    const g = got[role] || 0;
    // A cent of drift is rounding, and the sheet rounds per-pool while the
    // engine rounds per-server. More than that is a real disagreement.
    if (Math.abs(g - want[role]) > 1) diffs.push(`${role}: engine ${money(g)} vs sheet ${money(want[role])}`);
  }

  for (const w of db.prepare('SELECT hours, hourly_rate_cents FROM work WHERE shift_id=?').all(sh.id)) {
    totalHours += w.hours; totalWages += Math.round(w.hours * w.hourly_rate_cents);
  }

  if (diffs.length) bad.push({ date: sh.date, diffs });
  else ok++;
}

console.log('RECONCILIATION');
// Only the days that came from the sheet are comparable; anything ZWIN
// recorded itself is skipped above and must not read as a failure.
const fromSheet = shifts.filter((s) => byDate.has(s.date)).length;
console.log('  matched to the cent : ' + ok + ' / ' + fromSheet + ' from the sheet');
console.log('  left untouched      : ' + (shifts.length - fromSheet) + ' ZWIN services');
console.log('  disagreements       : ' + bad.length);
if (bad.length) {
  console.log();
  for (const b of bad) console.log('  ' + pad(b.date, 12) + b.diffs.join(' · '));
}

console.log();
console.log('TOTALS IMPORTED');
console.log('  services      : ' + shifts.length);
console.log('  hours         : ' + totalHours.toFixed(2));
console.log('  wages         : ' + money(totalWages));
const sales = db.prepare('SELECT COALESCE(SUM(food_cents+coffee_cents+alcohol_cents),0) s, COALESCE(SUM(card_tips_cents+cash_tips_cents),0) t FROM server_sales').get();
console.log('  server sales  : ' + money(sales.s));
console.log('  tips          : ' + money(sales.t));
const staff = db.prepare('SELECT COUNT(DISTINCT employee_id) n FROM work').get().n;
console.log('  people        : ' + staff);

process.exit(bad.length ? 1 : 0);
