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
// products joins m_vendors and alters m_invoices, and both are created by
// modules.js at require time. Declaring the dependency here means this file
// can be loaded on its own — by a test, a script, or a future entry point —
// instead of only working because server.js happens to require them first.
// modules.js does not require this file, so there is no cycle.
require('./modules');

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
-- What a vendor calls this product. Written on every import, so the second
-- invoice from a supplier recognises its own item codes and printed
-- descriptions outright instead of guessing at the wording again.
CREATE TABLE IF NOT EXISTS product_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  vendor_id  INTEGER,
  code       TEXT,
  alias      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alias_product ON product_aliases (product_id);
CREATE INDEX IF NOT EXISTS idx_alias_code    ON product_aliases (vendor_id, code);
CREATE INDEX IF NOT EXISTS idx_alias_alias   ON product_aliases (vendor_id, alias);
-- Declared here too, not just in periods.js. The migration below records that
-- it has run in this table, and depending on another module having been
-- required first meant the migration quietly skipped itself on a cold start —
-- caught only because the log line said so.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// Invoices carry the AI's raw line-item read until someone reviews it. Kept on
// the invoice rather than written straight into purchases because an import is
// a decision — matching "TOM RMA 6x6" to "Tomatoes" is a guess until a human
// agrees with it.
const prodCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!prodCols.includes('brand')) db.exec('ALTER TABLE products ADD COLUMN brand TEXT');
// What one purchase unit actually contains — 25 lb in a case, 12 in a package,
// 20 slices in a loaf. Menu costing is impossible without it: an invoice
// prices a case and a recipe uses an ounce. Parsed from the pack size the
// reader already captures where that can be done, asked for where it can't.
if (!prodCols.includes('pack_qty')) db.exec('ALTER TABLE products ADD COLUMN pack_qty REAL');
if (!prodCols.includes('pack_unit')) db.exec('ALTER TABLE products ADD COLUMN pack_unit TEXT');
// 'parsed' means we read it off the pack size and nobody has confirmed it;
// 'manual' means a person set it. Kept apart so a parse can be corrected and
// never silently overwrite what someone typed.
if (!prodCols.includes('pack_source')) db.exec('ALTER TABLE products ADD COLUMN pack_source TEXT');
// Usable fraction after trimming. Null means 100% and is the normal case.
if (!prodCols.includes('yield_pct')) db.exec('ALTER TABLE products ADD COLUMN yield_pct REAL');
// A price for products nobody invoices — set by hand, in cents, per purchase
// unit. Invoice-backed products ignore this: their price comes from what was
// actually paid, which is the whole point of deriving it.
if (!prodCols.includes('manual_price_cents')) db.exec('ALTER TABLE products ADD COLUMN manual_price_cents INTEGER');
if (!prodCols.includes('manual_price_on')) db.exec('ALTER TABLE products ADD COLUMN manual_price_on TEXT');

const invCols = db.prepare('PRAGMA table_info(m_invoices)').all().map((c) => c.name);
if (!invCols.includes('ai_lines')) db.exec('ALTER TABLE m_invoices ADD COLUMN ai_lines TEXT');
if (!invCols.includes('lines_imported')) db.exec("ALTER TABLE m_invoices ADD COLUMN lines_imported TEXT");
// Which line indexes have been imported, as JSON. Indexes rather than the
// printed text: one invoice can list the same description twice with
// different pack sizes, and keying on the words would silently hide the
// second one once the first had gone in.
if (!invCols.includes('imported_idx')) db.exec('ALTER TABLE m_invoices ADD COLUMN imported_idx TEXT');

// --- one-time migration from the par-level tracker --------------------------
// m_par is left on disk untouched. It is small, it is the only copy of what
// was there, and a migration that reads well in testing can still meet a row
// it didn't expect.
const migrateFromPar = db.transaction(() => {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'products_migrated'").get();
  if (done) return 0;
  // A database created after par levels was removed never had the table —
  // that's nothing to migrate, not a failure worth logging as one.
  const had = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='m_par'").get();
  if (!had) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('products_migrated', '0')").run();
    return 0;
  }
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
  add: db.prepare(`INSERT INTO products (name, category, vendor_id, unit, pack_size, sku, brand, notes)
    VALUES (@name, @category, @vendor_id, @unit, @pack_size, @sku, @brand, @notes)`),
  update: db.prepare(`UPDATE products SET name=@name, category=@category, vendor_id=@vendor_id,
    unit=@unit, pack_size=@pack_size, sku=@sku, brand=@brand, notes=@notes WHERE id=@id`),
  aliases: db.prepare(`SELECT a.*, v.name AS vendor_name FROM product_aliases a
    LEFT JOIN m_vendors v ON v.id = a.vendor_id WHERE a.product_id = ? ORDER BY a.id`),
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

// ---------------------------------------------------------------------------
// MATCHING
//
// A name on its own is not enough to recognise a product. "TOMATO 6/6" from
// two suppliers is two different products at two different prices, and
// "OLIVE OIL 3L" and "OLIVE OIL 4/3L" are a bottle and a case. So a line is
// scored across every signal the invoice gives us — vendor item code, learned
// alias, name, brand, pack size, unit, vendor — and the score decides what
// happens next rather than a yes/no.
//
//   high    (>= HIGH)   matched outright
//   medium  (>= MED)    offered, but somebody has to say yes
//   low                 treated as something new
//
// The asymmetry is deliberate. A missed match costs a duplicate product,
// which merge fixes in two clicks. A wrong match writes a price into the
// history of a product nobody bought, where it is invisible and moves a trend
// that someone may act on.
// ---------------------------------------------------------------------------
const HIGH = 85;
const MED = 60;

/** "6/#10" and "6 #10" and "6/10" all mean the same shelf. */
const normPack = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Item codes differ only by punctuation across printings. */
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const tokens = (s) => norm(s).split(' ').filter((t) => t && t.length > 1);

/** Share of the shorter token set that both descriptions have in common. */
function tokenOverlap(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

/**
 * Score one line against one product, 0-100, with the reasons.
 *
 * @param line    {desc, code, brand, pack_size, unit, vendor_id}
 * @param p       a product row
 * @param aliases rows from product_aliases for this product
 */
function scoreMatch(line, p, aliases = []) {
  const why = [];
  const n = norm(line.desc);
  const pn = norm(p.name);
  const code = normCode(line.code);
  const sameVendor = line.vendor_id != null && p.vendor_id != null
    && Number(line.vendor_id) === Number(p.vendor_id);

  // --- identity signals: this vendor has called this exact thing this before
  for (const a of aliases) {
    const aliasVendorMatches = a.vendor_id == null || line.vendor_id == null
      || Number(a.vendor_id) === Number(line.vendor_id);
    if (code && normCode(a.code) === code && aliasVendorMatches) {
      return { score: 100, why: ['same item code as last time'] };
    }
    if (n && norm(a.alias) === n && aliasVendorMatches) {
      return { score: 97, why: ['same line as a previous invoice'] };
    }
  }
  // A code we recorded on the product itself, from any vendor.
  if (code && normCode(p.sku) === code) return { score: 92, why: ['matches the SKU on file'] };

  // --- name
  let base = 0;
  if (n && pn && n === pn) { base = 88; why.push('name matches exactly'); }
  else if (n && pn && (n.includes(pn) || pn.includes(n))) {
    // Longer overlap is stronger: "extra virgin olive oil" inside the line
    // tells you more than "olive oil" does.
    base = 62 + Math.min(16, Math.round((pn.length / Math.max(n.length, 1)) * 16));
    why.push('name appears in the line');
  } else {
    const ov = tokenOverlap(line.desc, p.name);
    if (ov >= 0.5) { base = Math.round(38 + ov * 26); why.push(`${Math.round(ov * 100)}% of the words match`); }
  }
  if (!base) return { score: 0, why: [] };

  // --- corroboration
  let s = base;
  if (sameVendor) { s += 8; why.push('same vendor'); }
  else if (line.vendor_id != null && p.vendor_id != null) { s -= 10; why.push('different vendor'); }

  if (line.brand && p.brand) {
    if (norm(line.brand) === norm(p.brand)) { s += 6; why.push('same brand'); }
    // Heavy enough to be decisive. At -8 a conflicting brand could never pull
    // an exact-name, same-vendor line out of auto-match territory, which made
    // brand decorative in exactly the case it matters: Colavita and Pompeian
    // olive oil are different products at different prices.
    else { s -= 18; why.push('different brand'); }
  }
  if (line.pack_size && p.pack_size) {
    if (normPack(line.pack_size) === normPack(p.pack_size)) { s += 7; why.push('same pack size'); }
    else { s -= 14; why.push('different pack size'); }
  }
  if (line.unit && p.unit) {
    if (norm(line.unit) === norm(p.unit)) { s += 5; why.push('same unit'); }
    // A case is not a pound. Same words, different thing on the shelf.
    else { s -= 12; why.push('different unit'); }
  }
  return { score: Math.max(0, Math.min(100, Math.round(s))), why };
}

/**
 * Best product for a line, with how sure we are.
 * @returns {{product, score, confidence:'high'|'medium'|'low', why:string[]}}
 */
function matchLine(line, products, aliasesByProduct) {
  const list = products || q.plain.all();
  const aliases = aliasesByProduct || aliasIndex();
  let best = null;
  for (const p of list) {
    const r = scoreMatch(line, p, aliases.get(p.id) || []);
    if (!best || r.score > best.score) best = { product: p, ...r };
  }
  if (!best || best.score < MED) {
    return { product: null, score: best ? best.score : 0, confidence: 'low', why: best ? best.why : [] };
  }
  return { ...best, confidence: best.score >= HIGH ? 'high' : 'medium' };
}

/** product_id -> alias rows, for scoring a whole invoice in one pass. */
function aliasIndex() {
  const m = new Map();
  for (const a of db.prepare('SELECT * FROM product_aliases').all()) {
    if (!m.has(a.product_id)) m.set(a.product_id, []);
    m.get(a.product_id).push(a);
  }
  return m;
}

/** Remember what this vendor calls this product, so next time is definitive. */
function learnAlias(productId, vendorId, code, desc) {
  const c = (code || '').trim() || null;
  const a = norm(desc) || null;
  if (!c && !a) return;
  const dupe = db.prepare(`SELECT 1 FROM product_aliases WHERE product_id = ?
    AND IFNULL(vendor_id, -1) = IFNULL(?, -1) AND IFNULL(code,'') = IFNULL(?,'') AND IFNULL(alias,'') = IFNULL(?,'')`)
    .get(productId, vendorId ?? null, c, a);
  if (dupe) return;
  db.prepare('INSERT INTO product_aliases (product_id, vendor_id, code, alias) VALUES (?, ?, ?, ?)')
    .run(productId, vendorId ?? null, c, a);
}

/** Name-only match. Kept for callers that have nothing but a description. */
function matchProduct(desc, products) {
  return matchLine({ desc }, products, new Map()).product;
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
function reviewRows(lines, products, vendorId) {
  const list = products || q.plain.all();
  const aliases = aliasIndex();
  return (lines || []).map((l, i) => {
    const desc = String(l.description || '').trim();
    const code = String(l.code || '').trim();
    const brand = String(l.brand || '').trim();
    const pack = String(l.pack_size || '').trim();
    const unit = String(l.unit || '').trim();
    const r = desc || code
      ? matchLine({ desc, code, brand, pack_size: pack, unit, vendor_id: vendorId ?? null }, list, aliases)
      : { product: null, score: 0, confidence: 'low', why: [] };
    const fee = !r.product && NOT_A_PRODUCT.test(desc);
    const total = Math.round(Number(l.total || 0) * 100);
    const qty = Number(l.qty) > 0 ? Number(l.qty) : null;
    const unitPrice = Number(l.unit_price) > 0 ? Math.round(Number(l.unit_price) * 100)
      : qty && total ? Math.round(total / qty) : null;

    // High matches outright. Medium is offered with an empty selection, so the
    // form cannot be submitted until somebody has actually looked at it.
    const action = r.confidence === 'high' ? 'match'
      : r.confidence === 'medium' ? ''
      : fee || !desc ? 'skip' : 'create';

    return {
      i, desc, code: code || null, brand: brand || null, pack_size: pack || null,
      qty, unit: unit || null,
      total_cents: total, unit_price_cents: unitPrice,
      match: r.product, score: r.score, confidence: r.confidence, why: r.why,
      fee, action,
    };
  });
}

/**
 * Sort review rows into the buckets an operator actually works in.
 *
 * Classification only — it re-scores nothing and decides nothing. The `action`
 * each row carries is exactly what reviewRows() set, so what the form submits
 * is unchanged.
 */
function groupRows(rows) {
  const out = { review: [], likelyNew: [], charges: [] };
  for (const r of rows || []) {
    if (r.fee && !r.match) out.charges.push(r);
    else if (r.confidence === 'medium') out.review.push(r);
    else out.likelyNew.push(r);
  }
  return out;
}

/**
 * How many lines on this invoice still want a person.
 *
 * One definition, because there were two and they disagreed. The invoice list
 * called an invoice unfinished whenever a line had ever been read; the import
 * screen called it finished once nothing was left to decide. An invoice of
 * nothing but delivery fees sat in both states at once — permanently flagged
 * for review by the list, and answered with "nothing left to decide" the
 * moment you followed the flag.
 *
 * A charge is not work: it imports nothing and defaults to skip. Everything
 * else is — including a confident line that somehow has not been imported.
 * Auto-import puts those in when the invoice is saved, so one surviving here
 * means something went wrong, and the safe reading of "went wrong" is that a
 * person should look rather than that the invoice is done.
 */
function pendingCount(rows, done) {
  const seen = done || new Set();
  return (rows || []).filter((r) => !seen.has(r.i) && !r.fee).length;
}

/**
 * Products close enough to a line to be worth a second look, but not close
 * enough for the matcher to offer them.
 *
 * A line scoring below MED is treated as new, which is the conservative call
 * and stays that way — this does not change it. It only says so out loud: at
 * 40-59 there is often an existing product with a different pack size or a
 * missing brand, and creating a second record for it is the duplicate the
 * merge tool exists to clean up. Cheaper to notice before it is made.
 */
const WARN = 40;
function nearMisses(line, products, aliasesByProduct, limit = 3) {
  const list = products || q.plain.all();
  const aliases = aliasesByProduct || aliasIndex();
  return list
    .map((p) => ({ product: p, ...scoreMatch(line, p, aliases.get(p.id) || []) }))
    .filter((r) => r.score >= WARN && r.score < MED)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// MERGE — two records for one product, joined without losing a single line.
//
// Duplicates are the expected cost of matching conservatively: when the app
// isn't sure, it makes a new product rather than guess. This is the other half
// of that bargain, so being careful never means being stuck with the mess.
// ---------------------------------------------------------------------------
const mergeProducts = db.transaction((fromId, intoId) => {
  if (fromId === intoId) throw new Error('A product cannot be merged into itself.');
  const from = db.prepare('SELECT * FROM products WHERE id = ?').get(fromId);
  const into = db.prepare('SELECT * FROM products WHERE id = ?').get(intoId);
  if (!from || !into) throw new Error('One of those products no longer exists.');

  const moved = db.prepare('UPDATE product_purchases SET product_id = ? WHERE product_id = ?').run(intoId, fromId).changes;
  db.prepare('UPDATE product_aliases SET product_id = ? WHERE product_id = ?').run(intoId, fromId);
  // What the loser was called is worth keeping: it's how an invoice printed it,
  // which is the whole point of the alias table.
  learnAlias(intoId, from.vendor_id, from.sku, from.name);

  // Fill blanks on the survivor rather than overwrite anything already set.
  const fill = {};
  for (const k of ['category', 'vendor_id', 'unit', 'pack_size', 'sku', 'brand', 'notes',
    'par_level', 'reorder_point', 'on_hand']) {
    if ((into[k] === null || into[k] === '' || into[k] === undefined) && from[k] != null && from[k] !== '') fill[k] = from[k];
  }
  if (Object.keys(fill).length) {
    db.prepare(`UPDATE products SET ${Object.keys(fill).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...fill, id: intoId });
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(fromId);
  return { moved, name: from.name };
});

/**
 * Products that look like the same thing, for the merge picker. Scored with
 * the same engine, so what it suggests is what matching would have done.
 */
function likelyDuplicates(p, products) {
  const list = (products || q.plain.all()).filter((x) => x.id !== p.id);
  const aliases = aliasIndex();
  return list
    .map((x) => ({
      product: x,
      ...scoreMatch({ desc: p.name, code: p.sku, brand: p.brand, pack_size: p.pack_size, unit: p.unit, vendor_id: p.vendor_id },
        x, aliases.get(x.id) || []),
    }))
    .filter((r) => r.score >= MED)
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// COST PER USABLE UNIT — what menu costing actually asks of a product.
//
// The price still comes from purchases, never from a stored field: that is
// what keeps it honest when a new invoice lands. What products gained is
// STRUCTURE — what one purchase unit holds — because a price per case cannot
// be turned into a price per ounce without it.
// ---------------------------------------------------------------------------
const units = require('./units');

/**
 * The price to cost from, and where it came from.
 * Invoice-backed wins: it is what was actually paid. A manual price is the
 * fallback for things nobody invoices, and for products bought before the
 * app existed.
 */
function priceOf(p) {
  const last = db.prepare(`SELECT unit_price_cents, unit, purchased_on, invoice_id
    FROM product_purchases WHERE product_id = ? AND unit_price_cents > 0
    ORDER BY purchased_on DESC, id DESC LIMIT 1`).get(p.id);
  if (last) {
    return {
      micros: units.centsToMicros(last.unit_price_cents),
      unit: last.unit || p.unit,
      source: last.invoice_id ? 'invoice' : 'manual',
      on: last.purchased_on,
    };
  }
  if (p.manual_price_cents > 0) {
    return { micros: units.centsToMicros(p.manual_price_cents), unit: p.unit, source: 'manual', on: p.manual_price_on };
  }
  return null;
}

/**
 * Cost of one `usageUnit` of this product, in micro-dollars.
 * @returns {{ok, micros, reason, basis, price}} — never a silent zero.
 */
function costFor(p, usageUnit) {
  const price = priceOf(p);
  if (!price) {
    return { ok: false, micros: null, price: null,
      reason: 'no price yet — import an invoice for it or set one by hand', basis: null };
  }
  const r = units.costPerUnit({
    priceMicros: price.micros,
    purchaseUnit: price.unit,
    packQty: p.pack_qty,
    packUnit: p.pack_unit,
    yieldPct: p.yield_pct,
  }, usageUnit);
  return { ...r, price };
}

/** Units this product can currently be costed in — for the recipe dropdown. */
function costableUnits(p) {
  const out = [];
  for (const g of units.UNIT_GROUPS) {
    for (const u of g.units) if (costFor(p, u).ok) out.push(u);
  }
  return out;
}

// --- one-time backfill: read the pack sizes we already have -----------------
// Auto-parsing is the difference between menu costing working on the products
// already on file and an evening of data entry. Anything parsed is marked as
// such so it can be shown as a suggestion to confirm rather than as fact.
const backfillPacks = db.transaction(() => {
  let n = 0;
  const upd = db.prepare("UPDATE products SET pack_qty=?, pack_unit=?, pack_source='parsed' WHERE id=?");
  for (const p of db.prepare('SELECT id, pack_size, unit FROM products WHERE pack_qty IS NULL').all()) {
    const parsed = units.parsePack(p.pack_size);
    if (!parsed) continue;
    // A pack that just restates the purchase unit ("LB" on something sold by
    // the pound) adds nothing and would look like confirmed data.
    if (units.normalizeUnit(p.unit) === parsed.unit && parsed.qty === 1) continue;
    upd.run(parsed.qty, parsed.unit, p.id);
    n++;
  }
  return n;
});
try {
  const n = backfillPacks();
  if (n) console.log(`[products] read pack sizes for ${n} product${n === 1 ? '' : 's'}`);
} catch (e) { console.error('[products] pack backfill skipped:', e.message); }

/** Products that cannot be costed yet, so setup is a visible finite task. */
const needsPackInfo = () => q.plain.all().filter((p) => {
  if (!priceOf(p)) return false;                    // no price is a different problem
  return !costableUnits(p).length;
});

module.exports = {
  q, CATEGORIES, norm, trendOf, reviewRows,
  matchProduct, matchLine, scoreMatch, aliasIndex, learnAlias,
  mergeProducts, likelyDuplicates, groupRows, nearMisses, pendingCount, HIGH, MED, WARN,
  priceOf, costFor, costableUnits, needsPackInfo,
};
