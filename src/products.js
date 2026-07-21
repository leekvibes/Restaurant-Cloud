'use strict';

// ---------------------------------------------------------------------------
// PRODUCTS — what the restaurant buys, what it costs, and whether that's
// moving. This replaces the par-level tracker.
//
// The deliberate choice here is that nothing about price or spend is stored.
// Last price, average, high, low, trend, monthly spend — all of it is derived
// from product_purchases on read. A restaurant without POS ingredient
// depletion can't know what's on the shelf, but it knows exactly what it paid,
// because there's an invoice for it. Stored rollups would be one more thing to
// keep in sync and one more way to be quietly wrong after an invoice is
// edited or deleted.
//
// The par/on-hand columns are carried over and kept, unused by today's UI, so
// that inventory features can be added later without a second migration.
// ---------------------------------------------------------------------------

const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  name        TEXT NOT NULL,
  category    TEXT,
  vendor_id   INTEGER,
  unit        TEXT,
  pack_size   TEXT,
  sku         TEXT,
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  -- Carried from par levels. Not shown today; here so inventory can arrive
  -- later without migrating this table again.
  par_level     REAL,
  reorder_point REAL,
  on_hand       REAL
);
CREATE TABLE IF NOT EXISTS product_purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  invoice_id  INTEGER,
  vendor_id   INTEGER,
  purchased_on TEXT NOT NULL,
  qty         REAL,
  unit        TEXT,
  unit_price_cents INTEGER,
  total_cents INTEGER NOT NULL DEFAULT 0,
  raw_text    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pp_product ON product_purchases (product_id, purchased_on DESC);
CREATE INDEX IF NOT EXISTS idx_pp_invoice ON product_purchases (invoice_id);
CREATE INDEX IF NOT EXISTS idx_pp_date    ON product_purchases (purchased_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_name ON products (LOWER(name));
`);

// Invoices carry the AI's raw line-item read until someone reviews it. Kept on
// the invoice rather than written straight into purchases because an import is
// a decision — matching "TOM RMA 6x6" to "Tomatoes" is a guess until a human
// agrees with it.
const invCols = db.prepare('PRAGMA table_info(m_invoices)').all().map((c) => c.name);
if (!invCols.includes('ai_lines')) db.exec('ALTER TABLE m_invoices ADD COLUMN ai_lines TEXT');
if (!invCols.includes('lines_imported')) db.exec("ALTER TABLE m_invoices ADD COLUMN lines_imported TEXT");

// --- one-time migration from the par-level tracker --------------------------
// m_par is left on disk untouched. It is small, it is the only copy of what
// was there, and a migration that reads well in testing can still meet a row
// it didn't expect.
const migrateFromPar = db.transaction(() => {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'products_migrated'").get();
  if (done) return 0;
  let n = 0;
  const has = db.prepare('SELECT id FROM products WHERE LOWER(name) = LOWER(?)');
  const ins = db.prepare(`INSERT INTO products (name, vendor_id, unit, notes, par_level, reorder_point, on_hand, created_at)
    VALUES (@name, @vendor_id, @unit, @notes, @par_level, @reorder_point, @on_hand, @created_at)`);
  for (const r of db.prepare('SELECT * FROM m_par').all()) {
    const name = (r.item || '').trim();
    if (!name || has.get(name)) continue;
    ins.run({
      name,
      vendor_id: r.vendor_id == null || r.vendor_id === '' ? null : Math.round(Number(r.vendor_id)),
      unit: r.unit || null,
      notes: r.notes || null,
      par_level: r.par_level, reorder_point: r.reorder_point, on_hand: r.on_hand,
      created_at: r.created_at || new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    n++;
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('products_migrated', ?)").run(String(n));
  return n;
});
try { migrateFromPar(); } catch (e) { console.error('[products] par migration skipped:', e.message); }

const CATEGORIES = ['Produce', 'Meat', 'Seafood', 'Dairy', 'Dry goods', 'Bakery', 'Coffee', 'Beverage', 'Alcohol', 'Supplies', 'Cleaning', 'Other'];

/** Comparison key for matching a printed invoice line to a product we know. */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Everything the list and detail pages show, derived per product. `window` is
// an ISO date: purchases on or after it count toward `spend_window`.
const ROLLUP = `
  SELECT p.*,
    (SELECT COUNT(*)            FROM product_purchases x WHERE x.product_id = p.id) AS buys,
    (SELECT COALESCE(SUM(x.total_cents), 0) FROM product_purchases x WHERE x.product_id = p.id) AS spend_all,
    (SELECT COALESCE(SUM(x.total_cents), 0) FROM product_purchases x
       WHERE x.product_id = p.id AND x.purchased_on >= @from_month) AS spend_month,
    (SELECT COALESCE(SUM(x.total_cents), 0) FROM product_purchases x
       WHERE x.product_id = p.id AND x.purchased_on >= @from_year) AS spend_year,
    (SELECT MAX(x.purchased_on) FROM product_purchases x WHERE x.product_id = p.id) AS last_on,
    (SELECT MIN(x.purchased_on) FROM product_purchases x WHERE x.product_id = p.id) AS first_on,
    (SELECT MIN(x.unit_price_cents) FROM product_purchases x WHERE x.product_id = p.id AND x.unit_price_cents > 0) AS low_price,
    (SELECT MAX(x.unit_price_cents) FROM product_purchases x WHERE x.product_id = p.id AND x.unit_price_cents > 0) AS high_price,
    (SELECT ROUND(AVG(x.unit_price_cents)) FROM product_purchases x WHERE x.product_id = p.id AND x.unit_price_cents > 0) AS avg_price,
    -- Newest priced purchase, and the average of everything before it. The
    -- trend is one against the other, so a single delivery at an odd price
    -- doesn't read as a trend on its own.
    (SELECT x.unit_price_cents FROM product_purchases x
       WHERE x.product_id = p.id AND x.unit_price_cents > 0
       ORDER BY x.purchased_on DESC, x.id DESC LIMIT 1) AS last_price,
    (SELECT ROUND(AVG(y.unit_price_cents)) FROM product_purchases y
       WHERE y.product_id = p.id AND y.unit_price_cents > 0
         AND y.id <> (SELECT x.id FROM product_purchases x
                        WHERE x.product_id = p.id AND x.unit_price_cents > 0
                        ORDER BY x.purchased_on DESC, x.id DESC LIMIT 1)) AS prior_price,
    (SELECT v.name FROM m_vendors v WHERE v.id = p.vendor_id) AS vendor_name
  FROM products p`;

const q = {
  all: db.prepare(`${ROLLUP} ORDER BY p.name COLLATE NOCASE`),
  one: db.prepare(`${ROLLUP} WHERE p.id = @id`),
  byName: db.prepare('SELECT * FROM products WHERE LOWER(name) = LOWER(?)'),
  plain: db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE'),
  add: db.prepare(`INSERT INTO products (name, category, vendor_id, unit, pack_size, sku, notes)
    VALUES (@name, @category, @vendor_id, @unit, @pack_size, @sku, @notes)`),
  update: db.prepare(`UPDATE products SET name=@name, category=@category, vendor_id=@vendor_id,
    unit=@unit, pack_size=@pack_size, sku=@sku, notes=@notes WHERE id=@id`),
  del: db.prepare('DELETE FROM products WHERE id = ?'),
  history: db.prepare(`SELECT pp.*, v.name AS vendor_name, i.invoice_number, i.file AS invoice_file
    FROM product_purchases pp
    LEFT JOIN m_vendors v ON v.id = pp.vendor_id
    LEFT JOIN m_invoices i ON i.id = pp.invoice_id
    WHERE pp.product_id = ? ORDER BY pp.purchased_on DESC, pp.id DESC`),
  addPurchase: db.prepare(`INSERT INTO product_purchases
    (product_id, invoice_id, vendor_id, purchased_on, qty, unit, unit_price_cents, total_cents, raw_text)
    VALUES (@product_id, @invoice_id, @vendor_id, @purchased_on, @qty, @unit, @unit_price_cents, @total_cents, @raw_text)`),
  delPurchase: db.prepare('DELETE FROM product_purchases WHERE id = ?'),
  purchasesForInvoice: db.prepare(`SELECT pp.*, p.name FROM product_purchases pp
    JOIN products p ON p.id = pp.product_id WHERE pp.invoice_id = ? ORDER BY pp.id`),
  clearInvoice: db.prepare('DELETE FROM product_purchases WHERE invoice_id = ?'),
  // Vendor share of spend, for the insight about who supplies most of it.
  vendorShare: db.prepare(`SELECT pp.vendor_id, v.name, SUM(pp.total_cents) c
    FROM product_purchases pp LEFT JOIN m_vendors v ON v.id = pp.vendor_id
    WHERE pp.purchased_on >= ? GROUP BY pp.vendor_id ORDER BY c DESC`),
  categorySpend: db.prepare(`SELECT COALESCE(p.category,'Uncategorised') cat, SUM(pp.total_cents) c
    FROM product_purchases pp JOIN products p ON p.id = pp.product_id
    WHERE pp.purchased_on >= ? GROUP BY cat ORDER BY c DESC`),
  spendSince: db.prepare('SELECT COALESCE(SUM(total_cents),0) c FROM product_purchases WHERE purchased_on >= ?'),
};

/** Percent change of the newest price against what it used to average. */
function trendOf(p) {
  if (!p.last_price || !p.prior_price) return null;
  return Math.round(((p.last_price - p.prior_price) / p.prior_price) * 100);
}

/**
 * Match a printed invoice line to a product we already buy: exact name, then
 * one containing the other. Returns the product row or null.
 *
 * Kept deliberately conservative — a wrong match writes a price into the
 * history of a product nobody bought, which is worse than asking.
 */
function matchProduct(desc, products) {
  const n = norm(desc);
  if (!n) return null;
  const list = products || q.plain.all();
  let best = null;
  for (const p of list) {
    const pn = norm(p.name);
    if (!pn) continue;
    if (pn === n) return p;
    if (n.includes(pn) || pn.includes(n)) {
      // Prefer the longest overlap, so "tomato" doesn't beat "tomato paste"
      // for a line reading "TOMATO PASTE #10".
      if (!best || pn.length > norm(best.name).length) best = p;
    }
  }
  return best;
}

// Charges that ride along on an invoice but are not things you buy. The
// reader is told to leave them out; this is the backstop for when it doesn't,
// so a "Fuel surcharge" doesn't quietly become a product with a price history.
// They still appear on the review screen — defaulted to skip, not hidden,
// because deciding for someone silently is how you lose a real product.
const NOT_A_PRODUCT = /\b(deliver(y|ies)|freight|shipping|fuel|surcharge|charge|fee|fees|deposit|credit|discount|adjustment|subtotal|sales tax|tax|gratuity|tip|invoice total|balance)\b/i;

/**
 * Turn the AI's line array into review rows: each carries the raw line, the
 * product we think it is, and whether that's a match or a new product.
 */
function reviewRows(lines, products) {
  const list = products || q.plain.all();
  return (lines || []).map((l, i) => {
    const desc = String(l.description || '').trim();
    const m = desc ? matchProduct(desc, list) : null;
    const fee = !m && NOT_A_PRODUCT.test(desc);
    const total = Math.round(Number(l.total || 0) * 100);
    const qty = Number(l.qty) > 0 ? Number(l.qty) : null;
    const unitPrice = Number(l.unit_price) > 0 ? Math.round(Number(l.unit_price) * 100)
      : qty && total ? Math.round(total / qty) : null;
    return {
      i, desc, qty, unit: (l.unit || '').trim() || null,
      total_cents: total, unit_price_cents: unitPrice,
      match: m, fee, action: m ? 'match' : fee || !desc ? 'skip' : 'create',
    };
  });
}

module.exports = { q, CATEGORIES, norm, trendOf, matchProduct, reviewRows };
