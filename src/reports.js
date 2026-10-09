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
const OT = require('./overtime');

// COGS categories from the invoices module (what you buy to sell food & drink).
const COGS_CATEGORIES = ['Food', 'Coffee', 'Beverage', 'Alcohol'];

/**
 * One person's hourly rate on one shift, in cents, as SQL — the same rule
 * shiftInputs() applies in JS: the rate recorded on the shift wins, then the
 * wage that was IN FORCE ON sh.date for the role they actually worked, then
 * the wage on file now. A rate of 0 anywhere means "not set", so it falls
 * through rather than paying nothing.
 *
 * The dated step is why every query using this must have `sh` (shifts) in
 * scope. All of them already did — it is the shift being priced — but the
 * requirement is now load-bearing rather than incidental: without it a raise
 * restates every shift the person has ever worked, which is the bug this
 * fragment was changed to fix.
 *
 * It exists as a fragment because the shifts list needs wage cost for every
 * shift at once, and running the tip engine per shift to get it costs ~1ms
 * each — half a second at five hundred shifts. Expects `w` (work), `e`
 * (employees) and `er` (employee_roles, LEFT JOINed on employee_id + role).
 */
// The rate typed on the service first, then the rate the service was SETTLED
// at when it was sent (db.js, settleShift), and only then anything live.
const WAGE_RATE_SQL =
  `COALESCE(NULLIF(w.hourly_rate_cents, 0), w.settled_rate_cents, ${require('./wages').wageOnSql('sh.date', 'sh.daypart')},`
  + ' NULLIF(er.wage_cents, 0), e.hourly_rate_cents, 0)';

/** Sales (food+coffee+alcohol) and labor (wages) for a date range, in cents. */
/** Everything a shift rang, if you've entered it. 0 means not entered yet. */
function shiftTotalSales(sh) {
  return (sh.total_food_cents || 0) + (sh.total_coffee_cents || 0)
    + (sh.total_alcohol_cents || 0) + (sh.total_other_cents || 0);
}

/**
 * Sales for the business metrics. Prefers the shift's total — counter, to-go
 * and bar sales never carry a server's name, so server sales alone understate
 * the denominator and make labor % look far worse than it is. Falls back to
 * server sales for shifts entered before totals existed, so history still
 * reads sensibly instead of dropping to zero.
 */
function salesAndLabor(from, to) {
  let sales = 0, labor = 0, serverSales = 0, shiftsWithTotal = 0, shiftsWithout = 0;
  for (const sh of s.shiftsInRange.all(from, to)) {
    const inp = shiftInputs(sh.id);
    const r = runShift(inp, policyForShift(sh));
    const rung = r.servers.reduce((a, p) => a + p.sales.food + p.sales.coffee + p.sales.alcohol, 0);
    const total = shiftTotalSales(sh);
    serverSales += rung;
    if (total > 0) { sales += total; shiftsWithTotal++; } else { sales += rung; shiftsWithout++; }
    for (const p of inp.people) labor += Math.round(toCents(p.hourlyRate || 0) * (p.hours || 0));
  }
  return { sales, labor, serverSales, shiftsWithTotal, shiftsWithout };
}

function shiftDate(d, days) {
  return addDays(d, days);
}

/**
 * The numbers you check, not just the raw data: labor %, food cost %, prime
 * cost %, and sales vs. the previous equal-length period. Money in cents.
 */
function aggregateCosts(from, to) {
  const { sales, labor, serverSales, shiftsWithout } = salesAndLabor(from, to);

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
    serverSales, shiftsWithout,   // for "servers rang X of Y" and the missing-totals nudge
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
function aggregatePayroll(from, to, opts = {}) {
  // Optionally one service only. A filter on the shifts this already reads —
  // hours, wages and tips all hang off a shift, so scoping here scopes all
  // three at once and none of them can disagree about which service they are.
  //
  // OVERTIME IS NOT SPLIT, and cannot be: it is a property of somebody's whole
  // week, not of a service. A per-service view therefore reports that service's
  // hours and money, and the caller keeps overtime on the unscoped view. Adding
  // two services' OT together would overstate it, and splitting one week's OT
  // between them would be an invention.
  const svc = opts.service && opts.service !== 'all' ? opts.service : null;
  const shifts = s.shiftsInRange.all(from, to).filter((sh) => !svc || sh.daypart === svc);
  const people = new Map(); // employeeId -> record

  // Email travels with the record so callers can mail a period summary without
  // re-querying staff and re-matching by name.
  const emails = new Map();
  const bump = (id, name) => {
    if (!people.has(id)) {
      people.set(id, { employeeId: id, name, email: emails.get(id) || null, roles: new Set(),
        hours: 0, wage: 0, paycheckTips: 0,
        cashHome: 0, weeklyCash: 0, tipsEarned: 0, shifts: 0,
        wk1Hours: 0, wk2Hours: 0, wk1Wage: 0, wk2Wage: 0 });
    }
    const rec = people.get(id);
    if (!rec.email && emails.get(id)) rec.email = emails.get(id);
    return rec;
  };

  // Split the period into week 1 / week 2 (Gusto runs a two-week cycle). These
  // two halves are the workweeks overtime is measured against.
  const midDate = shiftDate(from, 7); // first day of week 2
  const weekKey = (date) => (date < midDate ? 'wk1' : 'wk2');

  const detail = []; // per-shift, per-person rows for the "Shift detail" sheet
  const { countsKeptTips } = require('./db');

  for (const sh of shifts) {
    const inp = shiftInputs(sh.id);
    const rateMap = new Map(inp.people.map((p) => [p.employeeId, p.hourlyRate || 0]));
    for (const p of inp.people) if (p.email) emails.set(p.employeeId, p.email);
    const r = runShift(inp, policyForShift(sh));
    const wk = weekKey(sh.date);

    // HOURS AND WAGE ONCE PER PERSON PER SERVICE, WHATEVER SIDE THEY ARE ON.
    //
    // Under the new policies a bartender and a barista are in BOTH lists: they
    // earn directly and they are tipped out. Both loops below paid them for
    // their hours, so an eight-hour bartender came out of payroll with sixteen
    // hours and twice the wage — $128 of work paid as $256. It is invisible on
    // the old policies, where nobody is in both lists, and would have gone live
    // with the new one.
    //
    // TIPS still come from both sides, because those are genuinely two
    // different pieces of money: what their own guests left them, and their
    // share of what the servers handed over. Only the hours are one fact.
    const paidHours = new Set();
    const hoursOnce = (p) => {
      if (paidHours.has(p.employeeId)) return { hours: 0, wage: 0, counted: false };
      paidHours.add(p.employeeId);
      return { hours: p.hours, wage: Math.round(toCents(rateMap.get(p.employeeId) || 0) * p.hours), counted: true };
    };

    for (const p of r.servers) {
      const rec = bump(p.employeeId, p.name);
      const h = hoursOnce(p);
      const wage = h.wage;
      const paycheck = p.tipsKept - p.cashTips;
      rec.roles.add('server'); rec.hours += h.hours; rec.wage += wage;
      rec[wk + 'Hours'] += h.hours; rec[wk + 'Wage'] += wage;
      rec.paycheckTips += paycheck; rec.cashHome += p.cashTips; rec.tipsEarned += p.tipsKept;
      // A SHIFT WORKED has hours or money on it. Somebody left on a service at
      // 0 hours with nothing rung and nothing tipped, a deleted punch being
      // the usual way, was counted anyway: the portal said "Shifts worked 2"
      // for one shift of work. Hours, wages and tips were already right.
      if (h.counted && (h.hours > 0 || p.food || p.coffee || p.alcohol || p.cardTips || p.cashTips)) rec.shifts += 1;
      detail.push({ employeeId: p.employeeId, shiftId: sh.id, date: sh.date, daypart: sh.daypart, name: p.name, role: 'server', hours: h.hours,
        wage, cardTips: p.cardTips, cashTips: p.cashTips, tipout: p.tipoutTotal, tipsKept: p.tipsKept, paycheck });
    }
    for (const p of r.support) {
      const rec = bump(p.employeeId, p.name);
      const h = hoursOnce(p);
      const wage = h.wage;
      const shares = p.poolShares || {};
      const poolPaycheck = shares.paycheck || 0;                          // e.g. to-go card
      const poolCash = (shares.weekly_cash || 0) + (shares.nightly_cash || 0); // jar + to-go cash
      rec.roles.add(p.role); rec.hours += h.hours; rec.wage += wage;
      rec[wk + 'Hours'] += h.hours; rec[wk + 'Wage'] += wage;
      // TIPS THEY WERE GIVEN THAT NO POT TAKES. Under a policy with no shared
      // pot (Palm: "card and cash stay with whoever earned them") these are the
      // person's own money. The tip engine kept them for them and payroll never
      // looked: the card half never reached the check, the cash half was never
      // counted as in hand. Counted from pay-math revision 2; a service settled
      // before that keeps what it was settled with (db.js, pay_math).
      const kept = countsKeptTips(sh);
      const keptCard = kept ? (p.keptCard || 0) : 0;
      const keptCash = kept ? (p.keptCash || 0) : 0;
      rec.paycheckTips += p.tipShare + poolPaycheck + keptCard;   // tip-out + card pool + own card → paycheck
      rec.weeklyCash += poolCash;                                // jar + to-go cash → handed out
      rec.cashHome += keptCash;                                  // their own cash, already in hand
      rec.tipsEarned += p.tipShare + (p.poolShare || 0) + keptCard + keptCash;
      if (h.counted && (h.hours > 0 || p.tipShare || p.poolShare || keptCard || keptCash)) rec.shifts += 1;
      detail.push({ employeeId: p.employeeId, shiftId: sh.id, date: sh.date, daypart: sh.daypart, name: p.name, role: p.role, hours: h.hours,
        wage, cardTips: keptCard, cashTips: keptCash, tipout: 0,
        tipsKept: p.tipShare + (p.poolShare || 0) + keptCard + keptCash, paycheck: p.tipShare + poolPaycheck + keptCard });
    }
  }

  // Derived per-person columns for running payroll.
  // Hours are the one figure here that is not an integer. Adding 9.02 + 9.15
  // + 9.4 in binary floating point lands on 106.55000000000001, and a payroll
  // page that reports somebody's fortnight to fourteen decimal places is a
  // payroll page nobody trusts. Rounded once, where the totals are built.
  const hrs = (n) => Math.round(n * 100) / 100;

  // Overtime, only if it is switched on. Off (the default) or exempt, otPay is
  // 0 and wage is exactly the straight-time total it always was — nothing about
  // this branch changes a figure until the owner turns it on.
  // A pay period whose payroll has gone out keeps the overtime rule and the
  // exempt list it went out under (periods.js, stampOvertime), so turning
  // overtime off, moving the threshold or exempting somebody later cannot
  // restate a period already paid. Any other range uses the rule as it is.
  let frozen = null;
  try {
    const sentP = require('./periods').sendRecord(from);
    if (sentP && sentP.period_end === to && sentP.ot_rule) {
      frozen = { rule: JSON.parse(sentP.ot_rule), exempt: new Set(JSON.parse(sentP.ot_exempt || '[]')) };
    }
  } catch { frozen = null; }
  const otRule = frozen ? frozen.rule : OT.rule();
  const exempt = otRule.enabled ? (frozen ? frozen.exempt : OT.exemptSet()) : null;

  const rows = [...people.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => {
    const cashTips = r.cashHome + r.weeklyCash;   // shown for reference only
    let otHours = 0;
    let otPay = 0;
    if (otRule.enabled && !exempt.has(r.employeeId)) {
      const ot = OT.overtimeFor(
        [{ hours: r.wk1Hours, wage: r.wk1Wage }, { hours: r.wk2Hours, wage: r.wk2Wage }],
        otRule);
      otHours = ot.otHours;
      otPay = ot.otPay;
    }
    const wage = r.wage + otPay;   // straight time + the overtime premium
    // Take-home = what actually lands on the paycheck. Cash is excluded
    // because they already walked out with it.
    return { ...r, roles: [...r.roles].join(', '), cashTips, wage, otHours, otPay,
      takeHome: wage + r.paycheckTips,
      hours: hrs(r.hours), wk1Hours: hrs(r.wk1Hours), wk2Hours: hrs(r.wk2Hours) };
  });
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
  const totals = {
    shifts: sum('shifts'), hours: hrs(sum('hours')), wage: sum('wage'), paycheckTips: sum('paycheckTips'),
    cashHome: sum('cashHome'), weeklyCash: sum('weeklyCash'), cashTips: sum('cashTips'),
    takeHome: sum('takeHome'), tipsEarned: sum('tipsEarned'),
    otHours: hrs(sum('otHours')), otPay: sum('otPay'),
    wk1Hours: hrs(sum('wk1Hours')), wk2Hours: hrs(sum('wk2Hours')),
  };

  return { rows, totals, detail, shiftCount: shifts.length, midDate, ot: otRule };
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
  pay.mergeCells('A1:K1');
  pay.getCell('A1').value = `${restaurant || 'Restaurant'} — Payroll  ${from} to ${to}`;
  pay.getCell('A1').font = { bold: true, size: 14 };
  pay.addRow([]);
  const payHead = pay.addRow(['Employee', 'Role(s)', 'Shifts', 'Total hours', 'Wk 1 hours', 'Wk 2 hours', 'OT hours', 'Wage earning', 'Cash tips', 'Card tip payout', 'Total take-home']);
  styleHeader(payHead);
  for (const r of rows) {
    pay.addRow([r.name, r.roles, r.shifts, r.hours, r.wk1Hours, r.wk2Hours, r.otHours || 0, toDollars(r.wage), toDollars(r.cashTips), toDollars(r.paycheckTips), toDollars(r.takeHome)]);
  }
  const totalRow = pay.addRow(['TOTAL', '', totals.shifts, totals.hours, totals.wk1Hours, totals.wk2Hours, totals.otHours || 0, toDollars(totals.wage), toDollars(totals.cashTips), toDollars(totals.paycheckTips), toDollars(totals.takeHome)]);
  totalRow.font = { bold: true };
  pay.columns = [{ width: 20 }, { width: 16 }, { width: 8 }, { width: 12 }, { width: 11 }, { width: 11 }, { width: 10 }, { width: 14 }, { width: 12 }, { width: 16 }, { width: 16 }];
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


// ---------------------------------------------------------------------------
// PERFORMANCE EXPORT — sales and what they cost, for somebody who does not use
// the app.
//
// The owner: "my boss is asking for sales for X amount of time and costs, so
// like invoices payroll etc." That reader opens one file, reads the top sheet,
// and asks questions from it — so the first sheet answers "how did the period
// do, against the period before it" in full sentences, and the sheets behind
// it are the evidence for every figure on it, in the order somebody would ask.
//
// Every figure here comes from the same functions the Performance page draws,
// so the spreadsheet and the screen cannot disagree. Money is cents until the
// moment it is written.
// ---------------------------------------------------------------------------

/**
 * PREPARED ON FIRST USE, NOT AT LOAD.
 *
 * These name tables that src/modules.js creates — m_invoices, m_vendors,
 * m_expenses. This file is required by metrics.js and by tests that want
 * nothing but payroll, so preparing at module scope dies on any database that
 * has not loaded modules.js yet, which is every fresh one. metrics.js answers
 * the same problem by requiring ./modules outright; this file stays clear of
 * the upload machinery and simply waits until somebody asks for a workbook.
 * Measured the hard way: it took out ten unrelated tests.
 */
let invSt = null;
const invoiceDetail = (from, to) => {
  if (!invSt) {
    invSt = db.prepare(`SELECT i.invoice_date AS date,
        COALESCE(v.name, 'Unknown vendor') AS vendor, COALESCE(i.category, 'Uncategorised') AS category,
        COALESCE(i.invoice_number, '') AS number, COALESCE(i.status, '') AS status,
        COALESCE(i.payment_method, '') AS method, i.due_date AS due,
        COALESCE(i.amount_cents, 0) AS cents
      FROM m_invoices i LEFT JOIN m_vendors v ON CAST(v.id AS REAL) = CAST(i.vendor_id AS REAL)
      WHERE i.invoice_date >= ? AND i.invoice_date <= ?
      ORDER BY i.invoice_date, v.name`);
  }
  return invSt.all(from, to);
};

let expSt = null;
const expenseDetail = (from, to) => {
  if (!expSt) {
    expSt = db.prepare(`SELECT spent_on AS date, COALESCE(name, '') AS name,
        COALESCE(where_bought, '') AS vendor, COALESCE(category, 'Uncategorised') AS category,
        COALESCE(paid_by, '') AS paidBy, COALESCE(paid_with, '') AS paidWith,
        reimbursed_on AS reimbursed, COALESCE(amount_cents, 0) AS cents
      FROM m_expenses WHERE spent_on >= ? AND spent_on <= ?
      ORDER BY spent_on, name`);
  }
  return expSt.all(from, to);
};

const PCT_FMT = '0.0"%"';
// NO MINUS SIGNS ON THIS SHEET.
//
// The owner: "I just don't want it to be a negative symbol." A column of
// figures with minuses in it reads to somebody skimming as though something is
// broken, and the direction is the thing they actually want anyway. Excel's
// number format has three parts — positive; negative; zero — and the negative
// part formats the absolute value unless you ask for the sign, so these show
// the movement with an arrow and no minus, while the cell still holds the real
// signed number underneath for sorting, charting and anybody's own sums.
const UP_DOWN_MONEY = '"▲ "$#,##0.00;"▼ "$#,##0.00;"no change"';
const UP_DOWN_NUM = '"▲ "#,##0.##;"▼ "#,##0.##;"no change"';
const PTS_FMT = '"▲ "0.0" pts";"▼ "0.0" pts";"no change"';
const UP_DOWN_PCT = '"▲ "0.0"%";"▼ "0.0"%";"flat"';
// A level, not a movement. A loss is a real thing and must not be dressed up
// as a gain, so it goes in brackets the way an accountant writes it.
const MONEY_LEVEL = '$#,##0.00;($#,##0.00)';
/** 'emailed' is how the database says it, not how anybody reads it. */
const statusWord = (st) => (String(st) === 'emailed' ? 'Sent' : 'Not sent yet');
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dowOf = (iso) => DOW[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const niceDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US',
  { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

/** A band of column headers, dark, frozen above the rows it names. */
function sheetHead(ws, cells, widths) {
  const row = ws.addRow(cells);
  styleHeader(row);
  if (widths) ws.columns = widths.map((width) => ({ width }));
  ws.views = [{ state: 'frozen', ySplit: row.number }];
  return row;
}

/** A section title inside a sheet — grey, bold, its own line. */
function sectionRow(ws, label, span) {
  const row = ws.addRow([label]);
  row.font = { bold: true, size: 11 };
  row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; });
  if (span) ws.mergeCells(row.number, 1, row.number, span);
  return row;
}

/**
 * Build the Performance workbook for [from, to].
 *
 * @param {object} opts  { restaurant, compare: { from, to, label } | null }
 */
async function buildPerformanceWorkbook(from, to, opts = {}) {
  // Required HERE, not at the top: metrics.js requires this file for
  // WAGE_RATE_SQL, so importing it at module scope is a cycle, and the half
  // of it that loaded first wins. By the time anybody calls this, both are up.
  const MX = require('./metrics');
  // Same reason, and so a service added later is named by the restaurant's own
  // word for it rather than its internal key.
  const SERVICES = require('./services');
  const serviceName = (slug) => SERVICES.nameOf(slug) || slug;
  const restaurant = opts.restaurant || 'Restaurant';
  const cmp = opts.compare && opts.compare.from ? opts.compare : null;

  const cur = MX.period(from, to);
  const prev = cmp ? MX.period(cmp.from, cmp.to) : null;
  const expenses = expenseDetail(from, to);
  const prevExpenses = cmp ? expenseDetail(cmp.from, cmp.to) : [];
  const expTotal = expenses.reduce((a, e) => a + e.cents, 0);
  const prevExpTotal = prevExpenses.reduce((a, e) => a + e.cents, 0);

  const wb = new ExcelJS.Workbook();
  wb.creator = restaurant;
  wb.created = new Date();

  // =========================================================================
  // 1. Summary — the sheet somebody actually reads
  // =========================================================================
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 34 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 12 }];
  sum.mergeCells('A1:E1');
  sum.getCell('A1').value = `${restaurant} — Performance`;
  sum.getCell('A1').font = { bold: true, size: 16 };
  sum.mergeCells('A2:E2');
  sum.getCell('A2').value = `${niceDay(from)} to ${niceDay(to)}`
    + (cmp ? `, against ${cmp.label} (${niceDay(cmp.from)} to ${niceDay(cmp.to)})` : '');
  sum.getCell('A2').font = { size: 11, color: { argb: 'FF4B5563' } };
  sum.mergeCells('A3:E3');
  sum.getCell('A3').value = `Prepared ${niceDay(new Date().toISOString().slice(0, 10))}`;
  sum.getCell('A3').font = { size: 10, color: { argb: 'FF6B7280' } };
  sum.addRow([]);

  const headCells = ['', 'This period', cmp ? 'Previous' : '', cmp ? 'Change' : '', cmp ? 'Change %' : ''];
  const sumHead = sum.addRow(headCells);
  styleHeader(sumHead);
  sum.views = [{ state: 'frozen', ySplit: sumHead.number }];

  /** One line: the figure, the same figure before, and the movement. */
  const line = (label, now, before, kind) => {
    const fmt = kind === 'money' ? MONEY_FMT : kind === 'pct' ? PCT_FMT : null;
    const val = (v) => (v === null || v === undefined ? null : kind === 'money' ? toDollars(v) : v);
    const row = sum.addRow([label, val(now), cmp ? val(before) : null, null, null]);
    if (cmp && now !== null && before !== null && before !== undefined) {
      row.getCell(4).value = val(now - before);
      if (kind !== 'pct' && before) row.getCell(5).value = ((now - before) / Math.abs(before)) * 100;
    }
    // Levels in their own format; the movement in an arrow format.
    const levelFmt = kind === 'money' ? MONEY_LEVEL : kind === 'pct' ? PCT_FMT : null;
    if (levelFmt) [2, 3].forEach((i) => { row.getCell(i).numFmt = levelFmt; });
    // A percentage that moves does not move by a percentage, it moves by
    // POINTS. Labour going from 66.3% to 42.5% is 23.8 points, and writing
    // "23.8%" there invites the reader to take 23.8% off 66.3 and get 50.5.
    row.getCell(4).numFmt = kind === 'pct' ? PTS_FMT
      : kind === 'money' ? UP_DOWN_MONEY : UP_DOWN_NUM;
    if (row.getCell(5).value !== null) row.getCell(5).numFmt = UP_DOWN_PCT;
    return row;
  };

  sectionRow(sum, 'SALES', 5);
  line('Total sales', cur.sales, prev && prev.sales, 'money');
  line('— Food', cur.mix.food, prev && prev.mix.food, 'money');
  line('— Coffee', cur.mix.coffee, prev && prev.mix.coffee, 'money');
  line('— Alcohol', cur.mix.alcohol, prev && prev.mix.alcohol, 'money');
  line('— Other', cur.mix.other, prev && prev.mix.other, 'money');
  if (cur.mix.unsplit || (prev && prev.mix.unsplit)) {
    line('— Not split by category', cur.mix.unsplit, prev && prev.mix.unsplit, 'money');
  }
  // Services WITH SALES, said so: the Services sheet lists every service in the
  // range, and a reader who counts its rows must not find a different number
  // here and wonder which one is the lie.
  line('Services with sales', cur.completedShifts, prev && prev.completedShifts, 'number');
  line('Services in the period', cur.shiftCount, prev && prev.shiftCount, 'number');
  line('Days with sales', cur.dayCount, prev && prev.dayCount, 'number');
  line('Average sales a day', cur.avgDaily, prev && prev.avgDaily, 'money');
  line('Average sales a service', cur.avgShift, prev && prev.avgShift, 'money');
  line('Sales per labour hour', cur.salesPerHour, prev && prev.salesPerHour, 'money');
  sum.addRow([]);

  sectionRow(sum, 'COSTS', 5);
  line('Labour (wages)', cur.wages, prev && prev.wages, 'money');
  line('Labour hours', Math.round(cur.hours * 100) / 100, prev && Math.round(prev.hours * 100) / 100, 'number');
  line('Food & drink invoices', cur.cogs, prev && prev.cogs, 'money');
  line('Other invoices', cur.invoiceTotal - cur.cogs, prev && (prev.invoiceTotal - prev.cogs), 'money');
  line('Out-of-pocket expenses', expTotal, prevExpTotal, 'money');
  const totalCost = cur.wages + cur.invoiceTotal + expTotal;
  const prevTotalCost = prev ? prev.wages + prev.invoiceTotal + prevExpTotal : null;
  const costRow = line('Total costs recorded', totalCost, prevTotalCost, 'money');
  costRow.font = { bold: true };
  sum.addRow([]);

  sectionRow(sum, 'RATIOS AND PROFIT', 5);
  line('Labour % of sales', cur.laborPct, prev && prev.laborPct, 'pct');
  line('Food cost % of sales', cur.foodPct, prev && prev.foodPct, 'pct');
  line('Prime cost % of sales', cur.primePct, prev && prev.primePct, 'pct');
  const gp = line('Gross profit (sales − labour − food)', cur.grossProfit, prev && prev.grossProfit, 'money');
  gp.font = { bold: true };
  const margin = cur.sales ? Math.round((cur.grossProfit / cur.sales) * 1000) / 10 : null;
  const prevMargin = prev && prev.sales ? Math.round((prev.grossProfit / prev.sales) * 1000) / 10 : null;
  line('Gross margin %', margin, prevMargin, 'pct');
  sum.addRow([]);

  const note = sum.addRow(['Sales are what the services recorded. Labour is wages only — no tips, no payroll taxes. '
    + 'Food cost counts invoices dated in the range in the Food, Coffee, Beverage and Alcohol categories. '
    + 'Tips are not a cost to the business and are not counted here; they are on the Labour sheet for reference.']);
  note.font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
  sum.mergeCells(note.number, 1, note.number, 5);
  note.alignment = { wrapText: true, vertical: 'top' };
  sum.getRow(note.number).height = 42;

  // =========================================================================
  // 2. Daily sales
  // =========================================================================
  const daily = wb.addWorksheet('Daily sales');
  sheetHead(daily, ['Date', 'Day', 'Services', 'Sales', 'Tips', 'Labour hours', 'Wages', 'Labour % of sales'],
    [12, 11, 9, 14, 12, 13, 14, 17]);
  for (const d of MX.days(from, to)) {
    const row = daily.addRow([d.date, dowOf(d.date), d.shifts, toDollars(d.sales), toDollars(d.tips),
      Math.round(d.hours * 100) / 100, toDollars(d.wages),
      d.sales ? Math.round((d.wages / d.sales) * 1000) / 10 : null]);
    [4, 5, 7].forEach((i) => { row.getCell(i).numFmt = MONEY_FMT; });
    row.getCell(8).numFmt = PCT_FMT;
  }
  const dTot = daily.addRow(['TOTAL', '', cur.shiftCount, toDollars(cur.sales), toDollars(cur.tips),
    Math.round(cur.hours * 100) / 100, toDollars(cur.wages), cur.laborPct]);
  dTot.font = { bold: true };
  [4, 5, 7].forEach((i) => { dTot.getCell(i).numFmt = MONEY_FMT; });
  dTot.getCell(8).numFmt = PCT_FMT;

  // =========================================================================
  // 3. Services — one line per service, the grain everything else sums from
  // =========================================================================
  const svc = wb.addWorksheet('Services');
  sheetHead(svc, ['Date', 'Day', 'Service', 'Status', 'Food', 'Coffee', 'Alcohol', 'Other',
    'Total sales', 'Tips', 'People', 'Hours', 'Wages', 'Labour %'],
  [12, 11, 16, 13, 12, 12, 12, 12, 14, 12, 8, 9, 13, 10]);
  for (const r of cur.rows) {
    const row = svc.addRow([r.date, dowOf(r.date), serviceName(r.daypart), statusWord(r.status),
      toDollars(r.food), toDollars(r.coffee), toDollars(r.alcohol), toDollars(r.other),
      toDollars(r.sales), toDollars(r.tips), r.people, Math.round(r.hours * 100) / 100,
      toDollars(r.wages), r.sales ? Math.round((r.wages / r.sales) * 1000) / 10 : null]);
    [5, 6, 7, 8, 9, 10, 13].forEach((i) => { row.getCell(i).numFmt = MONEY_FMT; });
    row.getCell(14).numFmt = PCT_FMT;
  }
  const sTot = svc.addRow(['TOTAL', '', '', '', toDollars(cur.mix.food), toDollars(cur.mix.coffee),
    toDollars(cur.mix.alcohol), toDollars(cur.mix.other), toDollars(cur.sales), toDollars(cur.tips),
    '', Math.round(cur.hours * 100) / 100, toDollars(cur.wages), cur.laborPct]);
  sTot.font = { bold: true };
  [5, 6, 7, 8, 9, 10, 13].forEach((i) => { sTot.getCell(i).numFmt = MONEY_FMT; });
  sTot.getCell(14).numFmt = PCT_FMT;

  // =========================================================================
  // 4. Labour — the same figures payroll reports, for the same range
  // =========================================================================
  const lab = wb.addWorksheet('Labour');
  const pay = aggregatePayroll(from, to);
  sheetHead(lab, ['Person', 'Role(s)', 'Shifts', 'Hours', 'Wages', 'Card tips', 'Cash tips', 'On the check'],
    [22, 20, 8, 10, 13, 13, 13, 14]);
  for (const r of pay.rows) {
    const row = lab.addRow([r.name, r.roles, r.shifts, r.hours, toDollars(r.wage),
      toDollars(r.paycheckTips), toDollars(r.cashTips), toDollars(r.takeHome)]);
    [5, 6, 7, 8].forEach((i) => { row.getCell(i).numFmt = MONEY_FMT; });
  }
  const lTot = lab.addRow(['TOTAL', '', pay.totals.shifts, pay.totals.hours, toDollars(pay.totals.wage),
    toDollars(pay.totals.paycheckTips), toDollars(pay.totals.cashTips), toDollars(pay.totals.takeHome)]);
  lTot.font = { bold: true };
  [5, 6, 7, 8].forEach((i) => { lTot.getCell(i).numFmt = MONEY_FMT; });
  const labNote = lab.addRow(['Wages are the only figure that counts as a cost on the Summary sheet. '
    + 'Card tips are money guests left that rides the paycheck; cash tips were already taken home.']);
  labNote.font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  // =========================================================================
  // 5. Costs summary — where the money went, three ways
  // =========================================================================
  const cost = wb.addWorksheet('Costs summary');
  cost.columns = [{ width: 30 }, { width: 10 }, { width: 15 }, { width: 15 }, { width: 13 }];
  sectionRow(cost, 'INVOICES BY CATEGORY', 5);
  const catHead = cost.addRow(['Category', 'Bills', 'Total', '% of invoices', '% of sales']);
  styleHeader(catHead);
  const byCat = [...MX.spendByCategory(from, to).entries()].sort((a, b) => b[1] - a[1]);
  const invCount = {};
  for (const i of invoiceDetail(from, to)) invCount[i.category] = (invCount[i.category] || 0) + 1;
  for (const [cat, cents] of byCat) {
    const row = cost.addRow([cat, invCount[cat] || 0, toDollars(cents),
      cur.invoiceTotal ? Math.round((cents / cur.invoiceTotal) * 1000) / 10 : null,
      cur.sales ? Math.round((cents / cur.sales) * 1000) / 10 : null]);
    row.getCell(3).numFmt = MONEY_FMT;
    [4, 5].forEach((i) => { row.getCell(i).numFmt = PCT_FMT; });
  }
  const catTot = cost.addRow(['All invoices', Object.values(invCount).reduce((a, b) => a + b, 0),
    toDollars(cur.invoiceTotal), null, cur.sales ? Math.round((cur.invoiceTotal / cur.sales) * 1000) / 10 : null]);
  catTot.font = { bold: true };
  catTot.getCell(3).numFmt = MONEY_FMT;
  catTot.getCell(5).numFmt = PCT_FMT;
  cost.addRow([]);

  sectionRow(cost, 'INVOICES BY VENDOR', 5);
  const venHead = cost.addRow(['Vendor', 'Bills', 'Total', 'Largest bill', '% of invoices']);
  styleHeader(venHead);
  for (const v of MX.spendByVendor(from, to)) {
    const row = cost.addRow([v.name, v.count, toDollars(v.cents), toDollars(v.max),
      cur.invoiceTotal ? Math.round((v.cents / cur.invoiceTotal) * 1000) / 10 : null]);
    [3, 4].forEach((i) => { row.getCell(i).numFmt = MONEY_FMT; });
    row.getCell(5).numFmt = PCT_FMT;
  }
  cost.addRow([]);

  sectionRow(cost, 'OUT-OF-POCKET EXPENSES BY CATEGORY', 5);
  const expHead = cost.addRow(['Category', 'Items', 'Total', '', '']);
  styleHeader(expHead);
  const expByCat = new Map();
  for (const e of expenses) {
    const was = expByCat.get(e.category) || { n: 0, cents: 0 };
    was.n++; was.cents += e.cents; expByCat.set(e.category, was);
  }
  for (const [cat, v] of [...expByCat.entries()].sort((a, b) => b[1].cents - a[1].cents)) {
    const row = cost.addRow([cat, v.n, toDollars(v.cents)]);
    row.getCell(3).numFmt = MONEY_FMT;
  }
  const expTotRow = cost.addRow(['All expenses', expenses.length, toDollars(expTotal)]);
  expTotRow.font = { bold: true };
  expTotRow.getCell(3).numFmt = MONEY_FMT;

  // =========================================================================
  // 6 & 7. The bills themselves
  // =========================================================================
  const inv = wb.addWorksheet('Invoices');
  sheetHead(inv, ['Date', 'Vendor', 'Category', 'Invoice no.', 'Status', 'Paid with', 'Due', 'Amount'],
    [12, 26, 16, 16, 12, 14, 12, 14]);
  for (const i of invoiceDetail(from, to)) {
    const row = inv.addRow([i.date, i.vendor, i.category, i.number, i.status, i.method, i.due || '', toDollars(i.cents)]);
    row.getCell(8).numFmt = MONEY_FMT;
  }
  const iTot = inv.addRow(['TOTAL', '', '', '', '', '', '', toDollars(cur.invoiceTotal)]);
  iTot.font = { bold: true };
  iTot.getCell(8).numFmt = MONEY_FMT;

  const exp = wb.addWorksheet('Expenses');
  sheetHead(exp, ['Date', 'What', 'Where', 'Category', 'Paid by', 'Paid with', 'Reimbursed', 'Amount'],
    [12, 26, 20, 16, 16, 14, 13, 14]);
  for (const e of expenses) {
    const row = exp.addRow([e.date, e.name, e.vendor, e.category, e.paidBy, e.paidWith, e.reimbursed || '', toDollars(e.cents)]);
    row.getCell(8).numFmt = MONEY_FMT;
  }
  const eTot = exp.addRow(['TOTAL', '', '', '', '', '', '', toDollars(expTotal)]);
  eTot.font = { bold: true };
  eTot.getCell(8).numFmt = MONEY_FMT;

  return wb;
}

module.exports = { shiftTotalSales, salesAndLabor, aggregatePayroll, buildWorkbook, aggregateCosts,
  buildPerformanceWorkbook, WAGE_RATE_SQL };
