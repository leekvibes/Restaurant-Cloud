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
const { WAGE_RATE_SQL } = require('./reports');
const { addDays } = require('./dates');

// Sales for a shift: what was rung overall, or what servers rang if the
// totals were never entered. Matches the shifts list exactly.
const SALES_SQL = `(COALESCE(sh.total_food_cents,0) + COALESCE(sh.total_coffee_cents,0)
  + COALESCE(sh.total_alcohol_cents,0) + COALESCE(sh.total_other_cents,0))`;
const SERVER_SALES_SQL = `(SELECT COALESCE(SUM(ss.food_cents + ss.coffee_cents + ss.alcohol_cents), 0)
  FROM server_sales ss WHERE ss.shift_id = sh.id)`;

const shiftRows = db.prepare(`
  SELECT sh.id, sh.date, sh.daypart, sh.status,
    COALESCE(sh.total_food_cents,0) AS food, COALESCE(sh.total_coffee_cents,0) AS coffee,
    COALESCE(sh.total_alcohol_cents,0) AS alcohol, COALESCE(sh.total_other_cents,0) AS other,
    ${SERVER_SALES_SQL} AS server_sales,
    CASE WHEN ${SALES_SQL} > 0 THEN ${SALES_SQL} ELSE ${SERVER_SALES_SQL} END AS sales,
    (SELECT COALESCE(SUM(ss.card_tips_cents + ss.cash_tips_cents), 0) FROM server_sales ss WHERE ss.shift_id = sh.id) AS tips,
    (SELECT COALESCE(SUM(w.hours), 0) FROM work w WHERE w.shift_id = sh.id) AS hours,
    (SELECT COUNT(DISTINCT w.employee_id) FROM work w WHERE w.shift_id = sh.id) AS people,
    (SELECT COALESCE(ROUND(SUM(w.hours * ${WAGE_RATE_SQL})), 0)
       FROM work w JOIN employees e ON e.id = w.employee_id
       LEFT JOIN employee_roles er ON er.employee_id = w.employee_id AND er.role = w.role
      WHERE w.shift_id = sh.id AND COALESCE(e.pay_type,'hourly') <> 'salary') AS wages
  FROM shifts sh
  WHERE sh.date >= ? AND sh.date <= ?
  ORDER BY sh.date, sh.daypart`);

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
  const hours = sum((r) => r.hours);
  const tips = sum((r) => r.tips);
  const cogs = inv.filter((i) => COGS_CATEGORIES.includes(i.category)).reduce((a, i) => a + i.cents, 0);
  const invoiceTotal = inv.reduce((a, i) => a + i.cents, 0);

  // A percentage of nothing is not zero, it is unanswerable.
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  const dayCount = new Set(rows.filter((r) => r.sales > 0).map((r) => r.date)).size;

  return {
    from, to, rows, invoices: inv,
    sales, wages, hours, tips, cogs, invoiceTotal,
    shiftCount: rows.length,
    completedShifts: rows.filter((r) => r.sales > 0).length,
    dayCount,
    laborPct: pct(wages, sales),
    foodPct: cogs > 0 ? pct(cogs, sales) : null,
    primePct: cogs > 0 ? pct(wages + cogs, sales) : null,
    grossProfit: sales - wages - cogs,
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
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(byDate.get(d) || { date: d, sales: 0, wages: 0, hours: 0, tips: 0, shifts: 0, had: false });
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
    case 'custom':
      if (custom && custom.from && custom.to && custom.from <= custom.to) {
        return { from: custom.from, to: custom.to, label: 'Custom' };
      }
      return { from: addDays(today, -29), to: today, label: 'Last 30 days' };
    default: return { from: addDays(today, -29), to: today, label: 'Last 30 days' };
  }
}

const RANGES = [
  ['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'],
  ['month', 'This month'], ['lastmonth', 'Last month'], ['ytd', 'Year to date'],
];

module.exports = { shifts, period, previous, days, invoiceWeeks, range, RANGES, COGS_CATEGORIES };
