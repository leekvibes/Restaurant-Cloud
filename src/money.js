'use strict';

// All money math runs in integer CENTS to avoid floating-point drift, then
// converts to dollars only for display. A restaurant payroll tool must never
// lose or invent a penny, so we're strict about this everywhere.

/** Dollars (number or numeric string) -> integer cents. */
function toCents(dollars) {
  if (dollars === null || dollars === undefined || dollars === '') return 0;
  const n = typeof dollars === 'string' ? parseFloat(dollars) : dollars;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Integer cents -> dollars number (2 decimals). */
function toDollars(cents) {
  return Math.round(cents) / 100;
}

/** Integer cents -> "$1,234.56" for display. */
function fmt(cents) {
  const neg = cents < 0;
  const v = Math.abs(Math.round(cents));
  const s = (v / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (neg ? '-$' : '$') + s;
}

/** Percent of a cents amount, rounded to nearest cent. e.g. pctOf(300000, 1.5) */
function pctOf(cents, percent) {
  return Math.round((cents * percent) / 100);
}

/**
 * Split a pot of `cents` among weighted recipients using the largest-remainder
 * method so the parts sum EXACTLY to the pot (no penny drift, no penny invented).
 *
 * @param {number} cents  total pot in cents
 * @param {Array<{id:*, weight:number}>} recipients  weights (e.g. hours worked)
 * @returns {Map<*, number>} id -> cents
 */
function allocateByWeight(cents, recipients) {
  const result = new Map();
  const totalWeight = recipients.reduce((s, r) => s + r.weight, 0);
  if (recipients.length === 0) return result;

  // Degenerate case: no weights (e.g. nobody logged hours) -> split evenly.
  if (totalWeight <= 0) {
    const base = Math.floor(cents / recipients.length);
    let remainder = cents - base * recipients.length;
    for (const r of recipients) {
      result.set(r.id, base + (remainder-- > 0 ? 1 : 0));
    }
    return result;
  }

  const shares = recipients.map((r) => {
    const exact = (cents * r.weight) / totalWeight;
    const floor = Math.floor(exact);
    return { id: r.id, floor, frac: exact - floor };
  });

  let distributed = shares.reduce((s, x) => s + x.floor, 0);
  let leftover = cents - distributed; // pennies to hand out, one each

  // Hand leftover pennies to the largest fractional remainders first.
  shares.sort((a, b) => b.frac - a.frac);
  for (const x of shares) {
    result.set(x.id, x.floor + (leftover > 0 ? 1 : 0));
    if (leftover > 0) leftover--;
  }
  return result;
}

module.exports = { toCents, toDollars, fmt, pctOf, allocateByWeight };
