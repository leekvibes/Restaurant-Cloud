'use strict';

// ---------------------------------------------------------------------------
// MENU COSTING — what a dish costs to put on a plate, and what that leaves.
//
// Recipe lines hold a product ID and a quantity. They never hold a price. The
// cost is worked out on read from whatever that product last cost, so a new
// invoice moves every dish that uses it without anything being rewritten.
// Snapshots are the exception, and they are meant to be: a snapshot is a
// record of what a dish cost on a day, kept so the history survives the next
// price change.
//
// A component can point at a product OR at another menu item marked as a prep
// — spicy mayo is made in-house, so costing it as a fixed manual price would
// go stale the moment mayonnaise moved, which is the exact problem this module
// exists to solve.
//
// All arithmetic is in micro-dollars (see units.js) and rounds once, at the
// end. Missing costs are never zero.
// ---------------------------------------------------------------------------

const { db } = require('./db');
const U = require('./units');
const P = require('./products');

db.exec(`
CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category    TEXT,
  description TEXT,
  notes       TEXT,
  selling_price_cents INTEGER,
  target_food_cost_pct REAL,
  status      TEXT NOT NULL DEFAULT 'draft',
  image       TEXT,
  -- A prep is a menu item other menu items can use as an ingredient: it makes
  -- a yield (32 fl oz of spicy mayo) that recipe lines draw from.
  is_prep     INTEGER NOT NULL DEFAULT 0,
  prep_yield_qty  REAL,
  prep_yield_unit TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS menu_components (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  -- exactly one of these two
  product_id   INTEGER REFERENCES products(id),
  ref_item_id  INTEGER REFERENCES menu_items(id),
  component_type TEXT NOT NULL DEFAULT 'ingredient',
  qty          REAL NOT NULL DEFAULT 0,
  usage_unit   TEXT,
  prep_note    TEXT,
  waste_pct    REAL,
  group_name   TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mc_item    ON menu_components (menu_item_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_mc_product ON menu_components (product_id);
CREATE INDEX IF NOT EXISTS idx_mc_ref     ON menu_components (ref_item_id);

CREATE TABLE IF NOT EXISTS menu_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  selling_price_cents INTEGER,
  ingredient_micros INTEGER NOT NULL DEFAULT 0,
  packaging_micros  INTEGER NOT NULL DEFAULT 0,
  other_micros      INTEGER NOT NULL DEFAULT 0,
  total_micros      INTEGER NOT NULL DEFAULT 0,
  food_cost_pct     REAL,
  gross_profit_cents INTEGER,
  gross_margin_pct   REAL,
  unresolved   INTEGER NOT NULL DEFAULT 0,
  trigger      TEXT,
  lines_json   TEXT,
  calculated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ms_item ON menu_snapshots (menu_item_id, calculated_at DESC);
`);

const CATEGORIES = ['Breakfast', 'Sandwiches', 'Bowls', 'Salads', 'Sides', 'Desserts', 'Beverages', 'Cocktails', 'Other'];
const TYPES = ['ingredient', 'packaging', 'garnish', 'condiment', 'other'];
const TYPE_LABEL = { ingredient: 'Ingredient', packaging: 'Packaging', garnish: 'Garnish', condiment: 'Condiment', other: 'Other' };
const STATUSES = ['draft', 'active', 'archived'];
const DEFAULT_TARGET = 28;
/** Recipe sections. Free text in the data; these are just the offered ones. */
const GROUPS = ['Main build', 'Sauces', 'Garnish', 'Packaging'];

const q = {
  all: db.prepare('SELECT * FROM menu_items ORDER BY name COLLATE NOCASE'),
  one: db.prepare('SELECT * FROM menu_items WHERE id = ?'),
  preps: db.prepare("SELECT * FROM menu_items WHERE is_prep = 1 AND status <> 'archived' ORDER BY name COLLATE NOCASE"),
  add: db.prepare(`INSERT INTO menu_items
    (name, category, description, notes, selling_price_cents, target_food_cost_pct, status, is_prep, prep_yield_qty, prep_yield_unit)
    VALUES (@name, @category, @description, @notes, @selling_price_cents, @target_food_cost_pct, @status, @is_prep, @prep_yield_qty, @prep_yield_unit)`),
  update: db.prepare(`UPDATE menu_items SET name=@name, category=@category, description=@description,
    notes=@notes, selling_price_cents=@selling_price_cents, target_food_cost_pct=@target_food_cost_pct,
    status=@status, is_prep=@is_prep, prep_yield_qty=@prep_yield_qty, prep_yield_unit=@prep_yield_unit,
    updated_at=datetime('now') WHERE id=@id`),
  setStatus: db.prepare("UPDATE menu_items SET status=?, archived_at=CASE WHEN ?='archived' THEN datetime('now') ELSE NULL END, updated_at=datetime('now') WHERE id=?"),
  del: db.prepare('DELETE FROM menu_items WHERE id = ?'),

  components: db.prepare(`SELECT c.*, p.name AS product_name, p.brand, p.pack_size, p.unit AS product_unit,
      v.name AS vendor_name, r.name AS ref_name, r.is_prep AS ref_is_prep
    FROM menu_components c
    LEFT JOIN products p ON p.id = c.product_id
    LEFT JOIN m_vendors v ON v.id = p.vendor_id
    LEFT JOIN menu_items r ON r.id = c.ref_item_id
    WHERE c.menu_item_id = ? ORDER BY c.sort_order, c.id`),
  addComponent: db.prepare(`INSERT INTO menu_components
    (menu_item_id, product_id, ref_item_id, component_type, qty, usage_unit, prep_note, waste_pct, group_name, sort_order)
    VALUES (@menu_item_id, @product_id, @ref_item_id, @component_type, @qty, @usage_unit, @prep_note, @waste_pct, @group_name, @sort_order)`),
  clearComponents: db.prepare('DELETE FROM menu_components WHERE menu_item_id = ?'),
  usingProduct: db.prepare('SELECT DISTINCT menu_item_id FROM menu_components WHERE product_id = ?'),
  usingItem: db.prepare('SELECT DISTINCT menu_item_id FROM menu_components WHERE ref_item_id = ?'),

  snapshots: db.prepare('SELECT * FROM menu_snapshots WHERE menu_item_id = ? ORDER BY calculated_at DESC, id DESC'),
  lastSnapshot: db.prepare('SELECT * FROM menu_snapshots WHERE menu_item_id = ? ORDER BY calculated_at DESC, id DESC LIMIT 1'),
  addSnapshot: db.prepare(`INSERT INTO menu_snapshots
    (menu_item_id, selling_price_cents, ingredient_micros, packaging_micros, other_micros, total_micros,
     food_cost_pct, gross_profit_cents, gross_margin_pct, unresolved, trigger, lines_json)
    VALUES (@menu_item_id, @selling_price_cents, @ingredient_micros, @packaging_micros, @other_micros, @total_micros,
     @food_cost_pct, @gross_profit_cents, @gross_margin_pct, @unresolved, @trigger, @lines_json)`),
};

// --- costing ---------------------------------------------------------------

/** Waste on a line means you must start with more to end up with the recipe
 *  quantity. 20% waste on 1 oz means buying 1.25 oz. */
function wasteFactor(pct) {
  const w = Number(pct);
  if (!Number.isFinite(w) || w <= 0) return 1;
  if (w >= 100) return null;                 // nothing survives — nonsense
  return 1 / (1 - w / 100);
}

/**
 * What one usage-unit of a prep costs: the prep's own total cost spread over
 * what it yields. A batch of spicy mayo costing $6.40 that makes 32 fl oz is
 * $0.20 a fluid ounce, and it moves when mayonnaise does.
 */
function prepUnitCost(item, usageUnit, seen) {
  if (!item.prep_yield_qty || !item.prep_yield_unit) {
    return { ok: false, micros: null, reason: `${item.name} needs to say how much a batch makes`, basis: null };
  }
  const per = convertYield(item, usageUnit);
  if (per === null) {
    return { ok: false, micros: null,
      reason: `${item.name} is made in ${U.unitLabel(item.prep_yield_unit)}, which doesn't convert to ${U.unitLabel(usageUnit)}`, basis: null };
  }
  const inner = costItem(item.id, seen);
  if (inner.unresolved) {
    return { ok: false, micros: null, reason: `${item.name} has ${inner.unresolved} component${inner.unresolved === 1 ? '' : 's'} without a cost`, basis: null };
  }
  const batch = Number(item.prep_yield_qty);
  if (!(batch > 0)) return { ok: false, micros: null, reason: `${item.name} has no batch yield`, basis: null };
  return { ok: true, micros: (inner.totalMicros / batch) * per, reason: null,
    basis: `batch of ${U.fmtQty(batch)} ${U.unitLabel(item.prep_yield_unit)}` };
}

/** How many of the prep's yield units are in one usage unit. */
function convertYield(item, usageUnit) {
  const from = U.normalizeUnit(usageUnit), to = U.normalizeUnit(item.prep_yield_unit);
  if (!from || !to) return null;
  if (from === to) return 1;
  return U.convert(1, from, to);
}

/**
 * Cost a menu item. Pure read — writes nothing.
 *
 * @param seen  ids already being costed, so a prep that (however it happened)
 *              ends up referring back to itself stops instead of recursing
 *              until the stack gives out.
 */
function costItem(id, seen = new Set()) {
  const item = q.one.get(id);
  const empty = { item: null, lines: [], byType: {}, totalMicros: 0, knownMicros: 0, unresolved: 0 };
  if (!item) return empty;
  if (seen.has(id)) {
    return { ...empty, item, unresolved: 1, cycle: true,
      lines: [{ ok: false, reason: `${item.name} ends up using itself`, cycle: true }] };
  }
  const nested = new Set(seen).add(id);

  const lines = [];
  const byType = { ingredient: 0, packaging: 0, garnish: 0, condiment: 0, other: 0 };
  let total = 0, unresolved = 0;

  for (const c of q.components.all(id)) {
    const type = TYPES.includes(c.component_type) ? c.component_type : 'other';
    const label = c.product_name || c.ref_name || 'Missing item';
    const wf = wasteFactor(c.waste_pct);

    let r;
    if (c.ref_item_id) {
      const prep = q.one.get(c.ref_item_id);
      r = prep ? prepUnitCost(prep, c.usage_unit, nested)
        : { ok: false, micros: null, reason: 'that prep has been deleted', basis: null };
    } else if (c.product_id) {
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(c.product_id);
      r = prod ? P.costFor(prod, c.usage_unit)
        : { ok: false, micros: null, reason: 'that product has been deleted', basis: null };
    } else {
      r = { ok: false, micros: null, reason: 'nothing selected on this line', basis: null };
    }

    const qty = Number(c.qty) || 0;
    let lineMicros = null, ok = r.ok && qty > 0 && wf !== null;
    let reason = r.reason;
    if (r.ok && wf === null) { ok = false; reason = 'waste of 100% leaves nothing'; }
    else if (r.ok && qty <= 0) { ok = false; reason = 'no quantity on this line'; }
    else if (ok) lineMicros = r.micros * qty * wf;

    if (ok) { total += lineMicros; byType[type] += lineMicros; } else unresolved++;

    lines.push({
      id: c.id, label, type, qty, unit: c.usage_unit,
      productId: c.product_id, refItemId: c.ref_item_id,
      brand: c.brand, vendor: c.vendor_name, packSize: c.pack_size,
      group: c.group_name || null, note: c.prep_note || null, wastePct: c.waste_pct || null,
      isPrep: !!c.ref_item_id,
      ok, unitMicros: r.ok ? r.micros : null, lineMicros, reason: ok ? null : reason,
      basis: r.basis || null, priceSource: r.price ? r.price.source : (c.ref_item_id ? 'prep' : null),
      priceOn: r.price ? r.price.on : null,
    });
  }

  const sell = Number(item.selling_price_cents) || 0;
  const totalCents = U.microsToCents(total);
  const target = item.target_food_cost_pct == null ? DEFAULT_TARGET : Number(item.target_food_cost_pct);
  // Food cost against a zero price is not 0% or infinity, it is unanswerable.
  const foodCostPct = sell > 0 ? (totalCents / sell) * 100 : null;
  const grossProfit = sell > 0 ? sell - totalCents : null;
  const grossMarginPct = sell > 0 ? ((sell - totalCents) / sell) * 100 : null;
  // Suggested price from the target. The brief's formula divides by the
  // percentage itself, which gives $0.13 for a $3.61 dish; it needs the
  // fraction.
  const suggested = target > 0 ? Math.round(totalCents / (target / 100)) : null;

  return {
    item, lines, byType, unresolved,
    totalMicros: total, totalCents, knownMicros: total,
    sellCents: sell, target,
    foodCostPct, grossProfit, grossMarginPct, suggestedCents: suggested,
    status: costStatus({ unresolved, sell, foodCostPct, target, lines }),
  };
}

/** On target / near / above / incomplete — the badge everything keys off. */
function costStatus({ unresolved, sell, foodCostPct, target, lines }) {
  if (!lines.length) return { key: 'empty', label: 'No recipe', cls: 's-none' };
  if (unresolved) return { key: 'missing', label: 'Cost incomplete', cls: 's-over' };
  if (!sell) return { key: 'noprice', label: 'No selling price', cls: 's-soon' };
  if (foodCostPct <= target) return { key: 'on', label: 'On target', cls: 's-done' };
  if (foodCostPct <= target + 3) return { key: 'near', label: 'Near target', cls: 's-soon' };
  return { key: 'over', label: 'Above target', cls: 's-over' };
}

// --- snapshots -------------------------------------------------------------

/**
 * Record what this dish costs now, if that differs from the last record.
 * Skipping identical snapshots keeps the history readable — an invoice import
 * touching fifty products shouldn't write fifty identical rows.
 */
function snapshot(id, trigger) {
  const c = costItem(id);
  if (!c.item) return null;
  const row = {
    menu_item_id: id,
    selling_price_cents: c.sellCents || null,
    ingredient_micros: Math.round(c.byType.ingredient || 0),
    packaging_micros: Math.round(c.byType.packaging || 0),
    other_micros: Math.round((c.byType.garnish || 0) + (c.byType.condiment || 0) + (c.byType.other || 0)),
    total_micros: Math.round(c.totalMicros),
    food_cost_pct: c.foodCostPct == null ? null : Math.round(c.foodCostPct * 100) / 100,
    gross_profit_cents: c.grossProfit,
    gross_margin_pct: c.grossMarginPct == null ? null : Math.round(c.grossMarginPct * 100) / 100,
    unresolved: c.unresolved,
    trigger: trigger || 'manual',
    lines_json: JSON.stringify(c.lines.map((l) => ({
      label: l.label, productId: l.productId, refItemId: l.refItemId, type: l.type,
      qty: l.qty, unit: l.unit, unitMicros: l.unitMicros, lineMicros: l.lineMicros, ok: l.ok,
    }))),
  };
  const prev = q.lastSnapshot.get(id);
  if (prev && prev.total_micros === row.total_micros
    && (prev.selling_price_cents || null) === row.selling_price_cents
    && prev.unresolved === row.unresolved) return null;
  q.addSnapshot.run(row);
  return row;
}

/**
 * What moved between two snapshots, per ingredient. This is the answer to
 * "why did this dish get more expensive", which is the only reason to keep
 * history at all.
 */
function drivers(newer, older) {
  if (!newer || !older) return [];
  let a = [], b = [];
  try { a = JSON.parse(newer.lines_json || '[]'); b = JSON.parse(older.lines_json || '[]'); } catch { return []; }
  const key = (l) => (l.refItemId ? 'i' + l.refItemId : 'p' + l.productId);
  const was = new Map(b.map((l) => [key(l), l]));
  const out = [];
  for (const l of a) {
    const o = was.get(key(l));
    const now = l.lineMicros || 0, then = o ? o.lineMicros || 0 : 0;
    if (Math.abs(now - then) >= 100) out.push({ label: l.label, delta: now - then, added: !o });
  }
  for (const l of b) if (!a.some((x) => key(x) === key(l))) out.push({ label: l.label, delta: -(l.lineMicros || 0), removed: true });
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/**
 * Re-snapshot every dish affected by a set of products changing price.
 * Called once at the end of an invoice import rather than per line, so one
 * delivery produces one snapshot per dish instead of a wall of them.
 */
function recalcForProducts(productIds, trigger = 'invoice') {
  const ids = new Set();
  const queue = [];
  for (const pid of productIds || []) for (const r of q.usingProduct.all(pid)) queue.push(r.menu_item_id);
  // A prep changing changes everything built on it, so walk upward too.
  while (queue.length) {
    const id = queue.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const r of q.usingItem.all(id)) queue.push(r.menu_item_id);
  }
  const out = [];
  const run = db.transaction(() => {
    for (const id of ids) { const s = snapshot(id, trigger); if (s) out.push(id); }
  });
  run();
  return { checked: ids.size, changed: out.length, ids: out };
}

// --- validation ------------------------------------------------------------

/**
 * Problems worth blocking on, and warnings worth showing. A draft may be
 * half-finished; an active dish on the menu should not be costed from holes.
 */
function validate(item, lines) {
  const errors = [], warnings = [];
  if (!String(item.name || '').trim()) errors.push('A menu item needs a name.');
  if (item.selling_price_cents != null && item.selling_price_cents < 0) errors.push('Selling price cannot be negative.');
  if (item.target_food_cost_pct != null
    && (item.target_food_cost_pct <= 0 || item.target_food_cost_pct > 100)) errors.push('Target food cost must be between 1 and 100%.');
  if (!STATUSES.includes(item.status)) errors.push('Unknown status.');
  if (item.is_prep && (!item.prep_yield_qty || item.prep_yield_qty <= 0)) errors.push('A prep needs to say how much one batch makes.');

  for (const l of lines || []) {
    if (Number(l.qty) < 0) errors.push(`${l.label || 'A line'} has a negative quantity.`);
    if (l.wastePct != null && (l.wastePct < 0 || l.wastePct >= 100)) errors.push(`${l.label || 'A line'} has an impossible waste percentage.`);
  }

  if (item.status === 'active') {
    if (!lines || !lines.length) errors.push('An active menu item needs at least one recipe component.');
    const bad = (lines || []).filter((l) => !l.ok).length;
    if (bad) warnings.push(`${bad} component${bad === 1 ? ' has' : 's have'} no reliable cost, so the food cost below is incomplete.`);
    if (!item.selling_price_cents) warnings.push('No selling price, so food cost and margin cannot be worked out.');
  }
  return { errors, warnings, ok: !errors.length };
}

/** Menu items a product appears in — for "why can't I delete this". */
const usedBy = (productId) => db.prepare(`SELECT DISTINCT m.id, m.name, m.status
  FROM menu_components c JOIN menu_items m ON m.id = c.menu_item_id
  WHERE c.product_id = ? ORDER BY m.name COLLATE NOCASE`).all(productId);

/**
 * How many active items cost more than they are meant to, read off the latest
 * snapshot per item rather than by costing them all again.
 *
 * The dashboard asks this on every load. Costing every item walks its whole
 * component tree, so doing it live would put the entire recipe book on the
 * critical path of the page every account opens. Snapshots are written
 * whenever a cost actually moves, which is exactly when this answer changes.
 */
function overTargetCount() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM menu_items mi
    JOIN menu_snapshots s ON s.id = (
      SELECT id FROM menu_snapshots WHERE menu_item_id = mi.id ORDER BY id DESC LIMIT 1)
    WHERE mi.status = 'active'
      AND s.food_cost_pct IS NOT NULL
      AND s.food_cost_pct > COALESCE(mi.target_food_cost_pct, ?)`).get(DEFAULT_TARGET).n;
}

module.exports = {
  usedBy, overTargetCount,
  q, CATEGORIES, TYPES, TYPE_LABEL, STATUSES, GROUPS, DEFAULT_TARGET,
  costItem, costStatus, snapshot, drivers, recalcForProducts, validate,
  wasteFactor, prepUnitCost,
};
