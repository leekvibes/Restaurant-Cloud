'use strict';

// ---------------------------------------------------------------------------
// METRICS — the numbers Performance, Sales and the Dashboard all quote.
//
// One implementation, because three pages showing three different answers for
// "sales this week" is worse than any of them being slightly wrong.
//
// Everything comes from one SQL pass rather than running the tip engine per
// shift. The engine costs ~1ms each and is only needed for who-owes-whom;
// sales, wages and hours are plain sums, and a 90-day daily series is 180
// shifts, which is the difference between a page that opens and one that
// stalls.
//
// Money is integer cents throughout. A day with no shift is absent from the
// data, not a zero — see `days()`.
// ---------------------------------------------------------------------------

const { db } = require('./db');
// m_invoices is created by modules.js, and the statements below are prepared at
// require time. Declaring the dependency here means this file can be loaded on
// its own — by a test, a script, or a future entry point — rather than only
// working because server.js happens to require modules first. The same
// boot-order trap stopped Products deploying once already.
require('./modules');
const { WAGE_RATE_SQL } = require('./reports');
const { addDays } = require('./dates');
// Overtime is a weekly rule and a real cost; the workweeks it is measured
// against are the payroll period's own halves, so both come from their owners
// rather than being re-derived here.
const OT = require('./overtime');
const PERIODS = require('./periods');

// Sales for a shift: what was rung overall, or what servers rang if the
// totals were never entered. Matches the shifts list exactly.
const SALES_SQL = `(COALESCE(sh.total_food_cents,0) + COALESCE(sh.total_coffee_cents,0)
  + COALESCE(sh.total_alcohol_cents,0) + COALESCE(sh.total_other_cents,0))`;
const SERVER_SALES_SQL = `(SELECT COALESCE(SUM(ss.food_cents + ss.coffee_cents + ss.alcohol_cents), 0)
  FROM server_sales ss WHERE ss.shift_id = sh.id)`;

// Salaried cost is dated history of its own, not a column on a work row.
const SALARY = require('./salary');

const shiftRows = db.prepare(`
  SELECT sh.id, sh.date, sh.daypart, sh.status,
    (sh.closed_at IS NOT NULL) AS closed,
    COALESCE(sh.total_food_cents,0) AS food, COALESCE(sh.total_coffee_cents,0) AS coffee,
    COALESCE(sh.total_alcohol_cents,0) AS alcohol, COALESCE(sh.total_other_cents,0) AS other,
    ${SERVER_SALES_SQL} AS server_sales,
    CASE WHEN ${SALES_SQL} > 0 THEN ${SALES_SQL} ELSE ${SERVER_SALES_SQL} END AS sales,
    (SELECT COALESCE(SUM(ss.card_tips_cents + ss.cash_tips_cents), 0) FROM server_sales ss WHERE ss.shift_id = sh.id) AS tips,
    (SELECT COALESCE(SUM(w.hours), 0) FROM work w WHERE w.shift_id = sh.id) AS hours,
    (SELECT COUNT(DISTINCT w.employee_id) FROM work w WHERE w.shift_id = sh.id) AS people,
    -- Needed so shiftState can be shared rather than reimplemented. A second
    -- copy of is-this-shift-ready is how two pages come to disagree about the
    -- same service.
    (SELECT COUNT(*) FROM work w WHERE w.shift_id = sh.id AND (w.hours IS NULL OR w.hours = 0)) AS no_hours,
    (SELECT COALESCE(ROUND(SUM(w.hours * ${WAGE_RATE_SQL})), 0)
       FROM work w JOIN employees e ON e.id = w.employee_id
       LEFT JOIN employee_roles er ON er.employee_id = w.employee_id AND er.role = w.role
      WHERE w.shift_id = sh.id
        -- Salaried as the service was settled when it was sent (db.js,
        -- settleShift), so a later switch to salary cannot move a past night.
        AND COALESCE(w.settled_salaried, COALESCE(e.pay_type, 'hourly') = 'salary') = 0) AS wages
  FROM shifts sh
  WHERE sh.date >= ? AND sh.date <= ?
  ORDER BY sh.date, sh.daypart`);

/**
 * Employer payroll taxes as a percentage of pay — the owner's share of FICA,
 * unemployment and the rest.
 *
 * The app cannot know this: it depends on the state, the year and the filing.
 * So it is a number the owner records, and until they do it is 0 and every
 * page says plainly that tax is not in the figure. A guessed 9% in a report an
 * accountant reads is worse than a stated gap.
 */
const payrollTaxPct = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('payroll_tax_pct');
  const v = row ? Number(row.value) : 0;
  return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 0;
};

const COGS_CATEGORIES = ['Food', 'Coffee', 'Beverage', 'Alcohol'];
const invoiceRows = db.prepare(`SELECT invoice_date AS date, category, COALESCE(amount_cents,0) AS cents
  FROM m_invoices WHERE invoice_date >= ? AND invoice_date <= ?`);

/** Raw shift rows for a range. */
const shifts = (from, to) => shiftRows.all(from, to);

/**
 * Totals for a period, plus the same figures for the period immediately
 * before it so anything can be compared without a second call.
 */
function period(from, to) {
  const rows = shifts(from, to);
  const inv = invoiceRows.all(from, to);
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);

  const sales = sum((r) => r.sales);
  const wages = sum((r) => r.wages);
  // SALARIED LABOUR, which used to be missing from every ratio on this page.
  //
  // It is NOT added to `wages` and never will be: wages is hourly cost built
  // out of work rows, one per person per service, and the per-service figures
  // are read straight off it. A salary belongs to a fortnight, not to Tuesday
  // dinner, so spreading it over services would invent a cost for each one.
  // It is a separate number that joins in at `labor`, which is what the
  // percentages are asked about.
  const sal = SALARY.costBetween(from, to);
  const salary = sal.cents;
  // The overtime premium payroll pays. `wages` is straight time for every
  // hour, so this is only the extra half on the hours above the weekly line.
  const ot = overtimePremium(from, to);
  // Employer payroll taxes, at the rate the owner has recorded. 0 until they
  // set one, and the page says so rather than implying labour is complete.
  const taxPct = payrollTaxPct();
  const payrollTax = Math.round(((wages + salary + ot.cents) * taxPct) / 100);
  const labor = wages + salary + ot.cents + payrollTax;
  const hours = sum((r) => r.hours);
  const tips = sum((r) => r.tips);
  const cogs = inv.filter((i) => COGS_CATEGORIES.includes(i.category)).reduce((a, i) => a + i.cents, 0);
  const invoiceTotal = inv.reduce((a, i) => a + i.cents, 0);
  // Money spent out of pocket, which lived only on the Performance page's cost
  // chart and in the export — never in a profit figure, so "profit" stopped
  // before a whole category of real spending.
  const expenses = expenseRows.all(from, to).reduce((a, e) => a + e.cents, 0);
  // EVERY cost the app holds for the range: labour of all kinds, every bill
  // whatever its category, and out-of-pocket spending. Not only the food and
  // drink that prime cost is built from.
  const allCosts = labor + invoiceTotal + expenses;

  // A percentage of nothing is not zero, it is unanswerable.
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  const dayCount = new Set(rows.filter((r) => r.sales > 0).map((r) => r.date)).size;

  return {
    from, to, rows, invoices: inv,
    sales, wages, hours, tips, cogs, invoiceTotal,
    // What labour actually cost, and every part of it kept apart so a report
    // can show its working rather than asking to be believed.
    salary, labor, salaryPeople: sal.people, salaryUndated: sal.undated,
    overtime: ot.cents, overtimeHours: ot.hours, overtimeOn: ot.enabled,
    overtimeApportioned: ot.apportioned,
    payrollTax, payrollTaxPct: taxPct,
    // Every cost the app knows about, and what is left after them. Gross
    // profit stops after labour and goods; this does not stop.
    expenses, allCosts, netProfit: sales - allCosts,
    // Services inside the range that cannot be adding up — the ratios above
    // are only as complete as what was entered, and until now nothing said so.
    gaps: {
      noFigures: rows.filter((r) => !r.sales).map((r) => ({ id: r.id, date: r.date, daypart: r.daypart })),
      noHours: rows.filter((r) => r.sales > 0 && r.no_hours > 0)
        .map((r) => ({ id: r.id, date: r.date, daypart: r.daypart, people: r.no_hours })),
    },
    shiftCount: rows.length,
    completedShifts: rows.filter((r) => r.sales > 0).length,
    dayCount,
    laborPct: pct(labor, sales),
    foodPct: cogs > 0 ? pct(cogs, sales) : null,
    primePct: cogs > 0 ? pct(labor + cogs, sales) : null,
    grossProfit: sales - labor - cogs,
    avgDaily: dayCount ? Math.round(sales / dayCount) : null,
    avgShift: rows.filter((r) => r.sales > 0).length ? Math.round(sales / rows.filter((r) => r.sales > 0).length) : null,
    salesPerHour: hours > 0 ? Math.round(sales / hours) : null,
    mix: {
      food: sum((r) => r.food), coffee: sum((r) => r.coffee),
      alcohol: sum((r) => r.alcohol), other: sum((r) => r.other),
      // Shifts entered before category totals existed only have a server
      // figure, which cannot be split. Kept separate rather than dumped into
      // "other", which would be a category claim we can't support.
      unsplit: sum((r) => (r.food + r.coffee + r.alcohol + r.other > 0 ? 0 : r.server_sales)),
    },
  };
}

/**
 * The workweek a date belongs to: the pay period's first or second half.
 *
 * The same split payroll uses (periods.js anchors it, reports.js divides the
 * fortnight at day seven), because an overtime figure measured against a
 * different week to the one payroll pays on is not a cost, it is a second
 * opinion.
 */
function weekStartOf(date) {
  const { start } = PERIODS.periodFor(date);
  return date < addDays(start, 7) ? start : addDays(start, 7);
}

const otRows = db.prepare(`
  SELECT w.employee_id AS id, sh.date AS date, COALESCE(w.hours, 0) AS hours,
    COALESCE(w.hours, 0) * ${WAGE_RATE_SQL} AS wage
  FROM work w
  JOIN shifts sh ON sh.id = w.shift_id
  JOIN employees e ON e.id = w.employee_id
  LEFT JOIN employee_roles er ON er.employee_id = w.employee_id AND er.role = w.role
  WHERE sh.date >= ? AND sh.date <= ?
    AND COALESCE(w.hours, 0) > 0
    AND COALESCE(w.settled_salaried, COALESCE(e.pay_type, 'hourly') = 'salary') = 0
    AND COALESCE(e.ot_exempt, 0) = 0`);

/**
 * The overtime premium earned in a range — the half-rate on hours over the
 * weekly threshold, which payroll pays and this report never counted.
 *
 * Straight time for every hour, overtime hours included, is already in
 * `wages`; this is only the extra, exactly as overtime.js computes it for
 * payroll, so nothing is counted twice.
 *
 * APPORTIONED, because overtime is earned in a WEEK and a report range can cut
 * one in half. The whole workweek is measured — including days outside the
 * range, or a Monday-to-Wednesday range would show somebody as never reaching
 * forty hours — and the range is charged the share of that week's hours that
 * fall inside it. Charging a whole week's premium to a range holding two of its
 * days would be the opposite error.
 */
function overtimePremium(from, to) {
  const rule = OT.rule();
  const empty = { cents: 0, hours: 0, apportioned: false, enabled: rule.enabled };
  if (!rule.enabled || !isDate(from) || !isDate(to) || from > to) return empty;

  // Whole workweeks, so a week the range only clips is still measured in full.
  const first = weekStartOf(from);
  const last = addDays(weekStartOf(to), 6);
  const weeks = new Map();                       // `${id}|${weekStart}` → totals
  for (const r of otRows.all(first, last)) {
    const key = `${r.id}|${weekStartOf(r.date)}`;
    const wk = weeks.get(key) || { hours: 0, wage: 0, inHours: 0 };
    wk.hours += r.hours;
    wk.wage += r.wage;
    if (r.date >= from && r.date <= to) wk.inHours += r.hours;
    weeks.set(key, wk);
  }
  let cents = 0;
  let hours = 0;
  let apportioned = false;
  for (const wk of weeks.values()) {
    if (!wk.inHours) continue;
    const ot = OT.overtimeFor([{ hours: wk.hours, wage: wk.wage }], rule);
    if (!ot.otPay) continue;
    const share = wk.inHours / wk.hours;
    if (share < 1) apportioned = true;
    cents += ot.otPay * share;
    hours += ot.otHours * share;
  }
  return { cents: Math.round(cents), hours: Math.round(hours * 100) / 100, apportioned, enabled: true };
}

/** The period of equal length immediately before this one. */
function previous(from, to) {
  const span = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  return period(addDays(from, -span), addDays(from, -1));
}

/**
 * One entry per calendar day in the range, including days with no shift.
 * Those carry sales: 0 and `had: false` — the caller decides whether a closed
 * Monday is a zero on the chart or a gap in the average.
 */
function days(from, to) {
  const rows = shifts(from, to);
  const byDate = new Map();
  for (const r of rows) {
    const d = byDate.get(r.date) || { date: r.date, sales: 0, wages: 0, hours: 0, tips: 0, shifts: 0, had: true };
    d.sales += r.sales; d.wages += r.wages; d.hours += r.hours; d.tips += r.tips; d.shifts++;
    byDate.set(r.date, d);
  }
  // Belt and braces: the range helper validates its input, but a bad date
  // reaching here would loop forever rather than throw, and an infinite loop
  // is a much worse failure than a wrong answer.
  if (!isDate(from) || !isDate(to) || from > to) return [];
  // A salary is owed on a Monday the place was shut, so it is charged to every
  // calendar day in the range, not only to the days that traded. Each day is
  // rounded on its own, which can leave the summed days a cent or two off the
  // range total in `period()` — a cent cannot move a figure printed to 0.1 of
  // a percentage point, and the alternative is spreading remainders across
  // days, which makes two days differ for no reason anybody could explain.
  const salaryByDay = SALARY.dailyBetween(from, to);
  const out = [];
  for (let d = from; d <= to && out.length <= 3660; d = addDays(d, 1)) {
    const day = byDate.get(d) || { date: d, sales: 0, wages: 0, hours: 0, tips: 0, shifts: 0, had: false };
    day.salary = salaryByDay.get(d) || 0;
    day.labor = day.wages + day.salary;
    out.push(day);
  }
  return out;
}

/** Invoice spend bucketed by ISO week start (Monday). */
function invoiceWeeks(from, to) {
  const inv = invoiceRows.all(from, to);
  const weeks = new Map();
  for (const i of inv) {
    if (!i.date) continue;
    const d = new Date(i.date + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7;                 // Monday = 0
    const start = addDays(i.date, -dow);
    weeks.set(start, (weeks.get(start) || 0) + i.cents);
  }
  return [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, cents]) => ({ week, cents }));
}

/** A real YYYY-MM-DD, not just something shaped like one. */
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '')
  && !Number.isNaN(new Date(v + 'T00:00:00Z').getTime())
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

/** Named ranges the date pickers offer. `today` is the caller's business day. */
function range(key, today, custom) {
  const startOfMonth = (d) => d.slice(0, 8) + '01';
  switch (key) {
    case 'today': return { from: today, to: today, label: 'Today' };
    case '7': return { from: addDays(today, -6), to: today, label: 'Last 7 days' };
    case '90': return { from: addDays(today, -89), to: today, label: 'Last 90 days' };
    case 'month': return { from: startOfMonth(today), to: today, label: 'This month' };
    case 'lastmonth': {
      const firstThis = startOfMonth(today);
      const endLast = addDays(firstThis, -1);
      return { from: startOfMonth(endLast), to: endLast, label: 'Last month' };
    }
    case 'ytd': return { from: today.slice(0, 4) + '-01-01', to: today, label: 'Year to date' };
    case 'custom': {
      // Both ends must be real dates. "from=bad&to=worse" used to pass this
      // guard — 'bad' <= 'worse' is true when you compare them as strings —
      // and `days()` then counted from an Invalid Date towards a target it
      // could never reach, allocating until the process died. Any visitor
      // could take the site down with a URL.
      if (custom && isDate(custom.from) && isDate(custom.to) && custom.from <= custom.to) {
        return { from: custom.from, to: custom.to, label: 'Custom' };
      }
      return { from: addDays(today, -29), to: today, label: 'Last 30 days' };
    }
    default: return { from: addDays(today, -29), to: today, label: 'Last 30 days' };
  }
}

const RANGES = [
  ['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'],
  ['month', 'This month'], ['lastmonth', 'Last month'], ['ytd', 'Year to date'],
];

// --- comparison modes ------------------------------------------------------
// Every comparison is LENGTH-MATCHED against the current range, which is the
// whole point: a partial current week (Mon–Wed) must never be measured against
// a full prior week. "Same days last week" and "previous month" shift the range
// wholesale, so they stay the same shape — Mon–Wed vs Mon–Wed, the 1st–15th vs
// the 1st–15th — rather than comparing a piece against a whole.
const COMPARE_MODES = [
  ['prev', 'Previous period'],
  ['week', 'Same days last week'],
  ['month', 'Previous month'],
  ['none', 'No comparison'],
];

/** Same day-of-month one month earlier, clamped to that month's length. */
function monthBack(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) - 1;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * The comparison window for a mode, or null for "no comparison". Length-matched
 * to the current range in every case, so nothing partial is ever weighed
 * against something whole. The label names the comparison in plain words.
 */
function compare(from, to, mode) {
  if (mode === 'none') return null;
  const span = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  if (mode === 'week') return { from: addDays(from, -7), to: addDays(to, -7), label: 'the same days last week' };
  // A month back, but the SAME number of days — a 31-day month must not be
  // measured against a 28-day February, which would invent ~11% of "movement"
  // out of the calendar. Anchored to the same day a month earlier, then run for
  // the current window's length, so 1st–15th compares to 1st–15th.
  if (mode === 'month') { const f = monthBack(from); return { from: f, to: addDays(f, span - 1), label: 'the previous month' }; }
  return { from: addDays(from, -span), to: addDays(from, -1), label: 'the previous period' };
}

// Invoice rows carrying the vendor, for the vendor-movement and cost-driver
// sections. Vendor id is TEXT holding "1"/"1.0", so the join casts to REAL —
// the same fix the rest of the app uses.
const invoiceVendorRows = db.prepare(`SELECT i.vendor_id AS vendor_id, COALESCE(v.name,'Unknown vendor') AS name,
  COALESCE(i.amount_cents,0) AS cents, i.invoice_date AS date, i.category AS category, i.id AS id
  FROM m_invoices i LEFT JOIN m_vendors v ON CAST(v.id AS REAL) = CAST(i.vendor_id AS REAL)
  WHERE i.invoice_date >= ? AND i.invoice_date <= ?`);
const expenseRows = db.prepare(`SELECT COALESCE(amount_cents,0) AS cents, category, spent_on AS date
  FROM m_expenses WHERE spent_on >= ? AND spent_on <= ?`);

/** Invoice spend grouped by its own category (every category, not just COGS). */
function spendByCategory(from, to) {
  const m = new Map();
  for (const i of invoiceRows.all(from, to)) m.set(i.category || 'Other', (m.get(i.category || 'Other') || 0) + i.cents);
  return m;
}

/** Invoice spend grouped by vendor, largest first, with count and biggest bill. */
function spendByVendor(from, to) {
  const m = new Map();
  for (const r of invoiceVendorRows.all(from, to)) {
    const k = String(r.vendor_id || '0');
    const e = m.get(k) || { id: r.vendor_id, name: r.name, cents: 0, count: 0, max: 0 };
    e.cents += r.cents; e.count++; if (r.cents > e.max) e.max = r.cents;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.cents - a.cents);
}

module.exports = {
  shifts, period, previous, days, invoiceWeeks, range, RANGES, COGS_CATEGORIES, isDate,
  compare, COMPARE_MODES, monthBack, spendByCategory, spendByVendor,
  invoiceVendorRows, expenseRows,
};
