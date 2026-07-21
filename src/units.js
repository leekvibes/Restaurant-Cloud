'use strict';

// ---------------------------------------------------------------------------
// UNITS — what a case actually contains, and what that makes one ounce cost.
//
// An invoice prices a purchase unit: $45.10 a case. A recipe uses something
// else: 4 oz. Nothing connects the two without knowing what is in the case,
// which is why this file exists and why it refuses to guess.
//
// Three kinds of unit, and the difference is the whole point:
//
//   measured    g, kg, lb, oz, ml, l, cup, tbsp...  convert freely inside
//               their own dimension, never across it
//   counted     each, piece, dozen                  a dozen is twelve
//   conceptual  case, loaf, slice, serving, bag...  mean nothing on their own
//
// A loaf is not eight ounces and a slice is not one each. Those need someone
// to say how many slices are in the loaf. Until they do, the honest answer is
// "I don't know", not a number that looks fine on a menu-costing report.
//
// Money here is in MICRO-DOLLARS — millionths of a dollar, as integers. Cost
// per usable unit is routinely sub-cent ($45.10 over 400 oz is $0.11275 an
// ounce), and rounding that to whole cents on every recipe line then summing
// eight lines puts a menu item several cents out. Which shows, because food
// cost is quoted to a tenth of a percent. Work in micro-dollars, round once,
// at the end.
// ---------------------------------------------------------------------------

const MICROS_PER_DOLLAR = 1e6;
const MICROS_PER_CENT = 1e4;

const dollarsToMicros = (d) => Math.round(Number(d || 0) * MICROS_PER_DOLLAR);
const centsToMicros = (c) => Math.round(Number(c || 0) * MICROS_PER_CENT);
/** Micro-dollars to whole cents. The single rounding point. */
const microsToCents = (m) => Math.round(Number(m || 0) / MICROS_PER_CENT);

// --- the unit table --------------------------------------------------------
// `per` is how many base units one of these is. Base units: g, ml, each.
const MASS = 'mass', VOLUME = 'volume', COUNT = 'count', CONCEPT = 'concept';

const UNITS = {
  // mass
  g:     { label: 'g',          dim: MASS,   per: 1 },
  kg:    { label: 'kg',         dim: MASS,   per: 1000 },
  oz:    { label: 'oz',         dim: MASS,   per: 28.349523125 },
  lb:    { label: 'lb',         dim: MASS,   per: 453.59237 },
  // volume
  ml:    { label: 'ml',         dim: VOLUME, per: 1 },
  l:     { label: 'liter',      dim: VOLUME, per: 1000 },
  floz:  { label: 'fl oz',      dim: VOLUME, per: 29.5735295625 },
  tsp:   { label: 'tsp',        dim: VOLUME, per: 4.92892159375 },
  tbsp:  { label: 'tbsp',       dim: VOLUME, per: 14.78676478125 },
  cup:   { label: 'cup',        dim: VOLUME, per: 236.5882365 },
  pint:  { label: 'pint',       dim: VOLUME, per: 473.176473 },
  quart: { label: 'quart',      dim: VOLUME, per: 946.352946 },
  gal:   { label: 'gallon',     dim: VOLUME, per: 3785.411784 },
  // counted — a dozen really is twelve, so this one conversion is safe
  each:  { label: 'each',       dim: COUNT,  per: 1 },
  piece: { label: 'piece',      dim: COUNT,  per: 1 },
  dozen: { label: 'dozen',      dim: COUNT,  per: 12 },
  // conceptual — no intrinsic size. Only a stated yield relates them.
  slice:   { label: 'slice',    dim: CONCEPT },
  serving: { label: 'serving',  dim: CONCEPT },
  case:    { label: 'case',     dim: CONCEPT },
  loaf:    { label: 'loaf',     dim: CONCEPT },
  bag:     { label: 'bag',      dim: CONCEPT },
  box:     { label: 'box',      dim: CONCEPT },
  sack:    { label: 'sack',     dim: CONCEPT },
  package: { label: 'package',  dim: CONCEPT },
  bottle:  { label: 'bottle',   dim: CONCEPT },
  can:     { label: 'can',      dim: CONCEPT },
  tray:    { label: 'tray',     dim: CONCEPT },
  bunch:   { label: 'bunch',    dim: CONCEPT },
  head:    { label: 'head',     dim: CONCEPT },
  jar:     { label: 'jar',      dim: CONCEPT },
  tub:     { label: 'tub',      dim: CONCEPT },
};

// How invoices and people actually write them.
const ALIASES = {
  gram: 'g', grams: 'g', gm: 'g',
  kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ounce: 'oz', ounces: 'oz', ozs: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb', '#': 'lb',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', mls: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l', lt: 'l',
  'fl oz': 'floz', floz: 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz', 'fl. oz': 'floz',
  teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp',
  cups: 'cup', pints: 'pint', pt: 'pint', quarts: 'quart', qt: 'quart',
  gallon: 'gal', gallons: 'gal',
  ea: 'each', ct: 'each', count: 'each', unit: 'each', units: 'each', pcs: 'piece', pieces: 'piece',
  dz: 'dozen', doz: 'dozen', dozens: 'dozen',
  slices: 'slice', servings: 'serving', portions: 'serving', portion: 'serving',
  cases: 'case', cs: 'case', loaves: 'loaf', bags: 'bag', boxes: 'box', bx: 'box',
  sacks: 'sack', packages: 'package', pkg: 'package', pack: 'package', packs: 'package',
  bottles: 'bottle', btl: 'bottle', cans: 'can', trays: 'tray',
  bunches: 'bunch', heads: 'head', jars: 'jar', tubs: 'tub',
};

/** Free text to a unit slug, or null if it isn't one we know. */
function normalizeUnit(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim().replace(/\.$/, '').replace(/\s+/g, ' ');
  if (UNITS[t]) return t;
  if (ALIASES[t]) return ALIASES[t];
  const bare = t.replace(/[^a-z# ]/g, '');
  return UNITS[bare] ? bare : (ALIASES[bare] || null);
}

const unitLabel = (u) => (UNITS[u] ? UNITS[u].label : u || '');
const dimOf = (u) => (UNITS[u] ? UNITS[u].dim : null);
const isConceptual = (u) => dimOf(u) === CONCEPT;

/**
 * Convert a quantity between units, or null when that isn't a real conversion.
 * Refuses across dimensions — mass is not volume, and a slice is not an each.
 */
function convert(qty, from, to) {
  const f = normalizeUnit(from), t = normalizeUnit(to);
  if (!f || !t || !Number.isFinite(Number(qty))) return null;
  if (f === t) return Number(qty);
  const F = UNITS[f], T = UNITS[t];
  if (!F || !T || F.dim !== T.dim) return null;
  if (F.dim === CONCEPT) return null;         // same dim, but "slice"≠"serving"
  return (Number(qty) * F.per) / T.per;
}

// --- reading a pack size off an invoice ------------------------------------
// The reader already captures pack size as printed: "25 LB", "4/3 L",
// "12 count", "6/#10", "10/100". Parsing it is the difference between menu
// costing working on the products you already have and a data-entry evening.

/**
 * @returns {{qty:number, unit:string, text:string, note:string}|null}
 *   qty+unit = what ONE purchase unit contains. Null when it can't be read,
 *   which is a prompt to ask, never a reason to assume.
 */
function parsePack(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const s = raw.toLowerCase().replace(/[×✕]/g, 'x').replace(/\s+/g, ' ');

  // "6/#10" — six #10 cans. The can size is a trade term, not a measure, so
  // this gives a count of cans and nothing about what's in them.
  let m = s.match(/^(\d+(?:\.\d+)?)\s*[/x]\s*#\s*(\d+)$/);
  if (m) return { qty: Number(m[1]), unit: 'can', text: raw, note: `${m[1]} × #${m[2]} cans` };

  // "4/3 L", "12/16 oz", "10/100" — outer × inner. Multiply out when the
  // inner carries a unit; when it doesn't ("10/100") it's a count of counts.
  m = s.match(/^(\d+(?:\.\d+)?)\s*[/x]\s*(\d+(?:\.\d+)?)\s*([a-z# ]*)$/);
  if (m) {
    const outer = Number(m[1]), inner = Number(m[2]);
    const u = normalizeUnit(m[3]);
    if (u) return { qty: outer * inner, unit: u, text: raw, note: `${outer} × ${inner} ${unitLabel(u)}` };
    return { qty: outer * inner, unit: 'each', text: raw, note: `${outer} × ${inner}` };
  }

  // "25 LB", "12 count", "1000 ct", "5lb", "3 L"
  m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z#][a-z# ]*)$/);
  if (m) {
    const u = normalizeUnit(m[2]);
    if (u) return { qty: Number(m[1]), unit: u, text: raw, note: `${m[1]} ${unitLabel(u)}` };
  }

  // "LB" / "each" on its own — a unit with no number means one of them.
  const only = normalizeUnit(s);
  if (only) return { qty: 1, unit: only, text: raw, note: `1 ${unitLabel(only)}` };

  return null;
}

// --- what one usable unit costs --------------------------------------------

/**
 * Cost of one `usageUnit`, in micro-dollars.
 *
 * @param p {{ priceMicros, purchaseUnit, packQty, packUnit, yieldPct }}
 *   priceMicros  what was paid for ONE purchase unit
 *   purchaseUnit what that price is per ("case", "lb")
 *   packQty/packUnit  what one purchase unit contains (25, "lb") — optional
 *                     when the purchase unit is itself measurable
 *   yieldPct     usable fraction after trim, 0-100. Optional, defaults to 100.
 * @returns {{ok:boolean, micros:number|null, reason:string|null, basis:string}}
 *
 * Every failure names itself. A menu costed from silent zeroes is worse than
 * one that admits it doesn't know — the first quietly prices a dish wrong.
 */
function costPerUnit(p, usageUnit) {
  const use = normalizeUnit(usageUnit);
  if (!use) return fail(`"${usageUnit}" isn't a unit I know`);

  const price = Number(p && p.priceMicros);
  if (!Number.isFinite(price) || price <= 0) return fail('no price on this product yet');

  const purchase = normalizeUnit(p.purchaseUnit);
  const packUnit = normalizeUnit(p.packUnit);
  const packQty = Number(p.packQty);
  const hasPack = packUnit && Number.isFinite(packQty) && packQty > 0;

  const yieldPct = p.yieldPct === undefined || p.yieldPct === null ? 100 : Number(p.yieldPct);
  if (!Number.isFinite(yieldPct) || yieldPct <= 0 || yieldPct > 100) return fail('usable yield must be between 1 and 100%');

  // Route 1: the pack tells us what a purchase unit holds. Price per pack
  // unit, then convert into the usage unit.
  if (hasPack) {
    const perPack = price / packQty;                    // µ$ per packUnit
    const qty = convert(1, use, packUnit);              // usage units -> pack units
    if (qty !== null) {
      const micros = (perPack * qty) / (yieldPct / 100);
      return ok(micros, `${fmtQty(packQty)} ${unitLabel(packUnit)} per ${unitLabel(purchase || 'unit')}`);
    }
    if (isConceptual(packUnit) || isConceptual(use)) {
      return fail(`can't turn ${unitLabel(packUnit)} into ${unitLabel(use)} — say how many ${unitLabel(use)} are in one ${unitLabel(packUnit)}`);
    }
    return fail(`${unitLabel(packUnit)} and ${unitLabel(use)} don't convert — one is ${dimOf(packUnit)}, the other ${dimOf(use)}`);
  }

  // Route 2: no pack, but the purchase unit is itself a real measure. Buying
  // by the pound and cooking by the ounce needs nothing else.
  if (purchase && !isConceptual(purchase)) {
    const qty = convert(1, use, purchase);
    if (qty !== null) {
      const micros = (price * qty) / (yieldPct / 100);
      return ok(micros, `priced by the ${unitLabel(purchase)}`);
    }
    return fail(`${unitLabel(purchase)} and ${unitLabel(use)} don't convert — one is ${dimOf(purchase)}, the other ${dimOf(use)}`);
  }

  // Route 3: bought by the case/bag/loaf and nobody has said what's inside.
  return fail(purchase
    ? `say what one ${unitLabel(purchase)} contains before this can be costed`
    : 'say what this is bought by, and what one of them contains');

  function ok(micros, basis) { return { ok: true, micros, reason: null, basis }; }
  function fail(reason) { return { ok: false, micros: null, reason, basis: null }; }
}

/** Trim trailing zeroes: 25 not 25.00, 0.5 not 0.50. */
const fmtQty = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 1000) / 1000);
};

/** Units offered in the recipe-line dropdown, grouped. */
const UNIT_GROUPS = [
  { label: 'Count', units: ['each', 'piece', 'slice', 'serving', 'dozen'] },
  { label: 'Weight', units: ['oz', 'lb', 'g', 'kg'] },
  { label: 'Volume', units: ['floz', 'cup', 'tbsp', 'tsp', 'pint', 'quart', 'gal', 'ml', 'l'] },
  { label: 'Whole packs', units: ['case', 'package', 'bag', 'box', 'loaf', 'can', 'bottle', 'jar', 'tub', 'tray', 'bunch', 'head', 'sack'] },
];

module.exports = {
  UNITS, UNIT_GROUPS, MASS, VOLUME, COUNT, CONCEPT,
  MICROS_PER_DOLLAR, MICROS_PER_CENT,
  dollarsToMicros, centsToMicros, microsToCents,
  normalizeUnit, unitLabel, dimOf, isConceptual, convert,
  parsePack, costPerUnit, fmtQty,
};
