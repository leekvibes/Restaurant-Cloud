'use strict';

// Payroll roll-up + Excel export. The per-shift records are the ledger; this
// just sums them across a date range. Nothing is recomputed differently —
// each shift is run with the exact policy version it was stamped with.

const ExcelJS = require('exceljs');
const { db, s, shiftInputs } = require('./db');
const { runShift } = require('./engine');
const { policyForShift } = require('./policy');
const { toCents, toDollars } = require('./money');
const { addDays } = require('./dates');

// COGS categories from the invoices module (what you buy to sell food & drink).
const COGS_CATEGORIES = ['Food', 'Coffee', 'Beverage', 'Alcohol'];

/** Sales (food+coffee+alcohol) and labor (wages) for a date range, in cents. */
function salesAndLabor(from, to) {
  let sales = 0, labor = 0;
  for (const sh of s.shiftsInRange.all(from, to)) {
    const inp = shiftInputs(sh.id);
    const r = runShift(inp, policyForShift(sh));
    for (const p of r.servers) sales += p.sales.food + p.sales.coffee + p.sales.alcohol;
    for (const p of [...inp.servers, ...inp.support]) labor += Math.round(toCents(p.hourlyRate || 0) * (p.hours || 0));
  }
  return { sales, labor };
}

function shiftDate(d, days) {
  return addDays(d, days);
}

/**
 * The numbers you check, not just the raw data: labor %, food cost %, prime
 * cost %, and sales vs. the previous equal-length period. Money in cents.
 */
function aggregateCosts(from, to) {
  const { sales, labor } = salesAndLabor(from, to);

  // Cost of goods sold = invoices in the COGS categories over the range.
  const cogsRow = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) c FROM m_invoices
     WHERE invoice_date >= ? AND invoice_date <= ? AND category IN (${COGS_CATEGORIES.map(() => '?').join(',')})`
  ).get(from, to, ...COGS_CATEGORIES);
  const cogs = cogsRow.c;
  const prime = labor + cogs;

  // Sales vs. the immediately preceding period of equal length.
  const spanDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const prev = salesAndLabor(shiftDate(from, -spanDays), shiftDate(from, -1));
  const wow = prev.sales ? Math.round(((sales - prev.sales) / prev.sales) * 100) : null;

  const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
  return {
    sales, labor, cogs, prime, prevSales: prev.sales, wow,
    laborPct: pct(labor, sales),
    foodPct: pct(cogs, sales),
    primePct: pct(prime, sales),
  };
}

/**
 * Aggregate everyone's pay for [from, to] (inclusive, YYYY-MM-DD).
 * Returns { rows, totals, shifts } — all money in CENTS.
 *   paycheckTips = what to pay on the Gusto check (EXCLUDES cash taken home)
 *   cashHome     = cash the server already took home (for reference)
 *   tipsEarned   = total net tips the person actually earned
 */
function aggregatePayroll(from, to) {
  const shifts = s.shiftsInRange.all(from, to);
  const people = new Map(); // employeeId -> record

  const bump = (id, name) => {
    if (!people.has(id)) {
      people.set(id, { employeeId: id, name, roles: new Set(), hours: 0, wage: 0, paycheckTips: 0,
        cashHome: 0, weeklyCash: 0, tipsEarned: 0, shifts: 0, wk1Hours: 0, wk2Hours: 0 });
    }
    return people.get(id);
  };

  // Split the period into week 1 / week 2 (Gusto runs a two-week cycle).
  const midDate = shiftDate(from, 7); // first day of week 2
  const weekKey = (date) => (date < midDate ? 'wk1Hours' : 'wk2Hours');

  const detail = []; // per-shift, per-person rows for the "Shift detail" sheet

  for (const sh of shifts) {
    const inp = shiftInputs(sh.id);
    const rateMap = new Map([...inp.servers, ...inp.support].map((p) => [p.employeeId, p.hourlyRate || 0]));
    const r = runShift(inp, policyForShift(sh));
    const wk = weekKey(sh.date);

    for (const p of r.servers) {
      const rec = bump(p.employeeId, p.name);
      const wage = Math.round(toCents(rateMap.get(p.employeeId) || 0) * p.hours);
      const paycheck = p.tipsKept - p.cashTips;
      rec.roles.add('server'); rec.hours += p.hours; rec.wage += wage; rec[wk] += p.hours;
      rec.paycheckTips += paycheck; rec.cashHome += p.cashTips; rec.tipsEarned += p.tipsKept; rec.shifts += 1;
      detail.push({ date: sh.date, daypart: sh.daypart, name: p.name, role: 'server', hours: p.hours,
        wage, cardTips: p.cardTips, cashTips: p.cashTips, tipout: p.tipoutTotal, tipsKept: p.tipsKept, paycheck });
    }
    for (const p of r.support) {
      const rec = bump(p.employeeId, p.name);
      const wage = Math.round(toCents(rateMap.get(p.employeeId) || 0) * p.hours);
      const shares = p.poolShares || {};
      const poolPaycheck = shares.paycheck || 0;                          // e.g. to-go card
      const poolCash = (shares.weekly_cash || 0) + (shares.nightly_cash || 0); // jar + to-go cash
      rec.roles.add(p.role); rec.hours += p.hours; rec.wage += wage; rec[wk] += p.hours;
      rec.paycheckTips += p.tipShare + poolPaycheck;   // role tip-out + card pool → paycheck
      rec.weeklyCash += poolCash;                      // jar + to-go cash → handed out
      rec.tipsEarned += p.tipShare + (p.poolShare || 0); rec.shifts += 1;
      detail.push({ date: sh.date, daypart: sh.daypart, name: p.name, role: p.role, hours: p.hours,
        wage, cardTips: 0, cashTips: 0, tipout: 0, tipsKept: p.tipShare + (p.poolShare || 0), paycheck: p.tipShare + poolPaycheck });
    }
  }

  // Derived per-person columns for running payroll.
  const rows = [...people.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => {
    const cashTips = r.cashHome + r.weeklyCash;   // shown for reference only
    // Take-home = what actually lands on the paycheck. Cash is excluded
    // because they already walked out with it.
    return { ...r, roles: [...r.roles].join(', '), cashTips, takeHome: r.wage + r.paycheckTips };
  });
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
  const totals = {
    shifts: sum('shifts'), hours: sum('hours'), wage: sum('wage'), paycheckTips: sum('paycheckTips'),
    cashHome: sum('cashHome'), weeklyCash: sum('weeklyCash'), cashTips: sum('cashTips'),
    takeHome: sum('takeHome'), tipsEarned: sum('tipsEarned'), wk1Hours: sum('wk1Hours'), wk2Hours: sum('wk2Hours'),
  };

  return { rows, totals, detail, shiftCount: shifts.length, midDate };
}

const MONEY_FMT = '$#,##0.00';

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } }; });
}

/** Build a formatted .xlsx workbook for the range. Returns an ExcelJS workbook. */
async function buildWorkbook(from, to, restaurant) {
  const { rows, totals, detail } = aggregatePayroll(from, to);
  const wb = new ExcelJS.Workbook();
  wb.creator = restaurant || 'Restaurant Ops';

  // --- Payroll sheet (per employee) ---
  const pay = wb.addWorksheet('Payroll');
  pay.mergeCells('A1:G1');
  pay.getCell('A1').value = `${restaurant || 'Restaurant'} — Payroll  ${from} to ${to}`;
  pay.getCell('A1').font = { bold: true, size: 14 };
  pay.addRow([]);
  const payHead = pay.addRow(['Employee', 'Role(s)', 'Shifts', 'Total hours', 'Wage earning', 'Cash tips', 'Card tip payout', 'Total take-home', 'Wk 1 hours', 'Wk 2 hours']);
  styleHeader(payHead);
  for (const r of rows) {
    pay.addRow([r.name, r.roles, r.shifts, r.hours, toDollars(r.wage), toDollars(r.cashTips), toDollars(r.paycheckTips), toDollars(r.takeHome), r.wk1Hours, r.wk2Hours]);
  }
  const totalRow = pay.addRow(['TOTAL', '', totals.shifts, totals.hours, toDollars(totals.wage), toDollars(totals.cashTips), toDollars(totals.paycheckTips), toDollars(totals.takeHome), totals.wk1Hours, totals.wk2Hours]);
  totalRow.font = { bold: true };
  pay.columns = [{ width: 20 }, { width: 16 }, { width: 8 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 11 }, { width: 11 }];
  [5, 6, 7, 8].forEach((i) => pay.getColumn(i).numFmt = MONEY_FMT);
  pay.getCell('A' + (pay.rowCount + 2)).value = 'Card tip payout = what to enter into Gusto (tips owed on the check). Total take-home = wages + card tip payout (what lands on the check). Cash tips = cash taken home + weekly jar/to-go — reference only, NOT included in take-home since they already received it.';

  // --- Shift detail sheet ---
  const det = wb.addWorksheet('Shift detail');
  const detHead = det.addRow(['Date', 'Service', 'Name', 'Role', 'Hours', 'Wage', 'Card tips', 'Cash tips', 'Tip-out', 'Net tips', 'On check']);
  styleHeader(detHead);
  for (const d of detail) {
    det.addRow([d.date, d.daypart, d.name, d.role, d.hours, toDollars(d.wage), toDollars(d.cardTips), toDollars(d.cashTips), toDollars(d.tipout), toDollars(d.tipsKept), toDollars(d.paycheck)]);
  }
  det.columns = [{ width: 12 }, { width: 9 }, { width: 18 }, { width: 10 }, { width: 7 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 10 }, { width: 10 }, { width: 10 }];
  [6, 7, 8, 9, 10, 11].forEach((i) => det.getColumn(i).numFmt = MONEY_FMT);

  return wb;
}

module.exports = { aggregatePayroll, buildWorkbook, aggregateCosts };
