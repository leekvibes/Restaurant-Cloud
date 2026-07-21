'use strict';

// Menu costing through the actual HTTP routes, on a throwaway database.
//
// The unit tests call the costing helpers directly. This one posts forms, so
// it covers the part in between — field parsing, line numbering, validation,
// snapshots on save — which is where a recipe quietly loses a component or a
// unit arrives as a string the converter doesn't recognise.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3967;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-menu-'));
const DB = path.join(dir, 'menu.db');
// Set before anything under src/ is required: the server child gets DB_PATH
// from the environment, and this process has to open the same file or the
// recalculation below would run against the real database and find nothing.
process.env.DB_PATH = DB;
const M = require('../src/menu');
let child, Database;

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const json = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
const open = (p) => fetch(BASE + p).then((r) => r.text());

/** Ids of products created in setup, by name. */
const PID = {};

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const db = new Database(DB);
  const add = (name, unit, packQty, packUnit, priceCents, invoiceBacked) => {
    const id = db.prepare('INSERT INTO products (name, unit, pack_qty, pack_unit, pack_source) VALUES (?,?,?,?,?)')
      .run(name, unit, packQty, packUnit, 'manual').lastInsertRowid;
    if (invoiceBacked) {
      db.prepare(`INSERT INTO product_purchases (product_id, invoice_id, purchased_on, qty, unit, unit_price_cents, total_cents)
        VALUES (?, 1, '2026-07-01', 1, ?, ?, ?)`).run(id, unit, priceCents, priceCents);
    } else {
      db.prepare('UPDATE products SET manual_price_cents=?, manual_price_on=? WHERE id=?').run(priceCents, '2026-07-01', id);
    }
    PID[name] = id;
    return id;
  };
  add('Croissants', 'package', 12, 'each', 1499, true);      // invoice-backed
  add('Eggs', 'case', 12, 'each', 288, true);                // invoice-backed
  add('Sandwich wrap', 'case', 1000, 'each', 18000, false);  // manual
  add('Mystery loaf', 'loaf', null, null, 600, false);       // no pack info on purpose
  // Priced by the slice, and only by the slice — a line that forgets its unit
  // and falls back to "each" cannot cost this, which is the point.
  add('Lamb bacon', 'package', 40, 'slice', 2360, true);
  db.close();
});

test.after(() => { if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const db = () => new Database(DB, { readonly: true });
const lastItem = () => { const d = db(); const r = d.prepare('SELECT * FROM menu_items ORDER BY id DESC LIMIT 1').get(); d.close(); return r; };

/** Form body for a menu item with N lines. */
function form(fields, lines) {
  const body = { count: String(lines.length), ...fields };
  lines.forEach((l, i) => {
    body[`ref_${i}`] = l.ref;
    body[`type_${i}`] = l.type || 'ingredient';
    body[`qty_${i}`] = String(l.qty);
    body[`unit_${i}`] = l.unit;
    body[`group_${i}`] = l.group || '';
    if (l.waste != null) body[`waste_${i}`] = String(l.waste);
  });
  return body;
}

test('creating a menu item through the form costs it and records a snapshot', async () => {
  const res = await post('/menu', form(
    { name: 'PV Breakfast Sandwich', category: 'Breakfast', price: '14.00', target: '28', status: 'active' },
    [
      { ref: 'p' + PID.Croissants, qty: 1, unit: 'each', group: 'Main build' },
      { ref: 'p' + PID.Eggs, qty: 1, unit: 'each', group: 'Main build' },
      { ref: 'p' + PID['Sandwich wrap'], qty: 1, unit: 'each', type: 'packaging', group: 'Packaging' },
    ],
  ));
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location') || '', /^\/menu\/\d+/);

  const m = lastItem();
  assert.strictEqual(m.name, 'PV Breakfast Sandwich');
  assert.strictEqual(m.selling_price_cents, 1400);
  assert.strictEqual(m.status, 'active');

  const d = db();
  const comps = d.prepare('SELECT * FROM menu_components WHERE menu_item_id = ? ORDER BY sort_order').all(m.id);
  const snap = d.prepare('SELECT * FROM menu_snapshots WHERE menu_item_id = ?').all(m.id);
  d.close();

  assert.strictEqual(comps.length, 3, 'every line survived the round trip');
  // Components reference products by id and hold no price of their own.
  assert.ok(comps.every((c) => c.product_id && !('price' in c)), 'lines reference product ids');
  assert.strictEqual(comps[2].component_type, 'packaging');

  // 1.2492 + 0.24 + 0.18 = 1.6692 -> 167c
  assert.strictEqual(snap.length, 1, 'one snapshot on create');
  assert.strictEqual(snap[0].total_micros, 1669166 + 1, 'held at full precision');
  assert.strictEqual(snap[0].unresolved, 0);
});

test('the detail page shows the costed recipe', async () => {
  const m = lastItem();
  const html = await open(`/menu/${m.id}`);
  assert.ok(html.includes('PV Breakfast Sandwich'));
  assert.ok(html.includes('$1.67'), 'the total');
  assert.ok(html.includes('Croissants') && html.includes('Sandwich wrap'));
  assert.ok(html.includes('BETA'), 'flagged as beta');
});

test('the usage unit on a line is used, not assumed', async () => {
  // 2 slices of a $23.60 package of 40 is $1.18. Ask for "each" instead and
  // there is no answer, because a slice is not an each.
  const bySlice = await json('/menu/cost', {
    price: 12, target: 30,
    lines: [{ ref: 'p' + PID['Lamb bacon'], qty: 2, unit: 'slice', type: 'ingredient' }],
  });
  assert.strictEqual(bySlice.unresolved, 0);
  assert.strictEqual(bySlice.totalCents, 118);

  const byEach = await json('/menu/cost', {
    price: 12, target: 30,
    lines: [{ ref: 'p' + PID['Lamb bacon'], qty: 2, unit: 'each', type: 'ingredient' }],
  });
  assert.strictEqual(byEach.unresolved, 1, 'the wrong unit is refused, not approximated');
  assert.strictEqual(byEach.totalCents, 0);
});

test('a saved recipe keeps the unit each line was built with', async () => {
  const res = await post('/menu', form(
    { name: 'Bacon plate', status: 'active', price: '9.00', target: '30' },
    [{ ref: 'p' + PID['Lamb bacon'], qty: 3, unit: 'slice' }],
  ));
  assert.strictEqual(res.status, 302);
  const m = lastItemNamed('Bacon plate');
  const d = db();
  const c = d.prepare('SELECT * FROM menu_components WHERE menu_item_id = ?').get(m.id);
  const snap = d.prepare('SELECT * FROM menu_snapshots WHERE menu_item_id = ?').get(m.id);
  d.close();
  assert.strictEqual(c.usage_unit, 'slice', 'stored as slices');
  assert.strictEqual(snap.unresolved, 0, 'and it costs');
  assert.strictEqual(Math.round(snap.total_micros / 1e4), 177, '3 slices at 59c');
});

test('the live cost preview matches what saving produces', async () => {
  const d = await json('/menu/cost', {
    price: 14, target: 28,
    lines: [
      { ref: 'p' + PID.Croissants, qty: 1, unit: 'each', type: 'ingredient' },
      { ref: 'p' + PID.Eggs, qty: 1, unit: 'each', type: 'ingredient' },
      { ref: 'p' + PID['Sandwich wrap'], qty: 1, unit: 'each', type: 'packaging' },
    ],
  });
  assert.strictEqual(d.totalCents, 167);
  assert.strictEqual(d.packaging, 18);
  assert.strictEqual(d.unresolved, 0);
  assert.ok(Math.abs(d.foodCostPct - 11.93) < 0.05);
  assert.strictEqual(d.status.key, 'on');
  // The preview must not leave anything behind — it costs inside a rollback.
  const dd = db();
  const stray = dd.prepare("SELECT COUNT(*) n FROM menu_items WHERE name = '__preview__'").get().n;
  dd.close();
  assert.strictEqual(stray, 0, 'the preview row was rolled back');
});

test('a component that cannot be costed is reported, not counted as free', async () => {
  const d = await json('/menu/cost', {
    price: 10, target: 30,
    lines: [
      { ref: 'p' + PID.Eggs, qty: 1, unit: 'each', type: 'ingredient' },
      { ref: 'p' + PID['Mystery loaf'], qty: 1, unit: 'slice', type: 'ingredient' },
    ],
  });
  assert.strictEqual(d.unresolved, 1);
  assert.strictEqual(d.totalCents, 24, 'only the egg');
  assert.strictEqual(d.lines[1].ok, false);
  assert.match(d.lines[1].reason, /contains/i);
  assert.strictEqual(d.status.key, 'missing');
});

test('an active item with no components is refused; a draft is allowed', async () => {
  const bad = await post('/menu', form({ name: 'Empty active', status: 'active', price: '5.00' }, []));
  assert.strictEqual(bad.status, 302);
  assert.match(decodeURIComponent(bad.headers.get('location') || ''), /at least one recipe component/i);

  const ok = await post('/menu', form({ name: 'Empty draft', status: 'draft' }, []));
  assert.match(ok.headers.get('location') || '', /^\/menu\/\d+/);
  assert.strictEqual(lastItem().name, 'Empty draft');
});

test('negative prices and quantities are refused at the route', async () => {
  const neg = await post('/menu', form({ name: 'Bad price', status: 'draft', price: '-4' }, []));
  assert.match(decodeURIComponent(neg.headers.get('location') || ''), /negative/i);

  const qty = await post('/menu', form({ name: 'Bad qty', status: 'draft' },
    [{ ref: 'p' + PID.Eggs, qty: -3, unit: 'each' }]));
  assert.match(decodeURIComponent(qty.headers.get('location') || ''), /negative quantity/i);
});

test('creating a product mid-recipe returns it as JSON so the recipe survives', async () => {
  const res = await fetch(`${BASE}/c/products?json=1`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      name: 'Costco Croissants', unit: 'package', price: '14.99', pack_qty: '12', pack_unit: 'each',
    }).toString(),
  });
  const out = await res.json();
  assert.ok(out.id, 'the new product comes back');
  assert.strictEqual(out.name, 'Costco Croissants');
  assert.ok(out.units.includes('each'), 'and says which units it can be costed in');
  assert.match(out.price, /1\.25|14\.99/, `priced immediately: ${out.price}`);

  // It costs out straight away — the point of asking for pack info up front.
  const d = await json('/menu/cost', { price: 8, target: 30, lines: [{ ref: 'p' + out.id, qty: 1, unit: 'each' }] });
  assert.strictEqual(d.unresolved, 0);
  assert.strictEqual(d.totalCents, 125, '$14.99 over 12 is $1.25');
});

test('a product price change moves every dish using it, and says which', async () => {
  const before = lastItemNamed('PV Breakfast Sandwich');
  const w = new Database(DB);
  w.prepare(`INSERT INTO product_purchases (product_id, invoice_id, purchased_on, qty, unit, unit_price_cents, total_cents)
    VALUES (?, 2, '2026-07-20', 1, 'package', 1799, 1799)`).run(PID.Croissants);
  w.close();

  // Same call the invoice import makes.
  const r = M.recalcForProducts([PID.Croissants], 'invoice');
  assert.ok(r.ids.includes(before.id), 'the sandwich was recalculated');

  const d = db();
  const snaps = d.prepare('SELECT * FROM menu_snapshots WHERE menu_item_id = ? ORDER BY id DESC').all(before.id);
  d.close();
  assert.ok(snaps.length >= 2, 'history kept, not overwritten');
  assert.ok(snaps[0].total_micros > snaps[1].total_micros, 'and the cost went up');
  const drivers = M.drivers(snaps[0], snaps[1]);
  assert.strictEqual(drivers[0].label, 'Croissants', 'names what moved');
});

test('duplicating copies the recipe but not the name or the history', async () => {
  const src = lastItemNamed('PV Breakfast Sandwich');
  const res = await post(`/menu/${src.id}/duplicate`, {});
  assert.strictEqual(res.status, 302);

  const d = db();
  const copy = d.prepare("SELECT * FROM menu_items WHERE name LIKE 'PV Breakfast Sandwich (copy)%'").get();
  const copyLines = d.prepare('SELECT * FROM menu_components WHERE menu_item_id = ?').all(copy.id);
  const srcLines = d.prepare('SELECT * FROM menu_components WHERE menu_item_id = ?').all(src.id);
  const copySnaps = d.prepare('SELECT * FROM menu_snapshots WHERE menu_item_id = ?').all(copy.id);
  const srcSnaps = d.prepare('SELECT * FROM menu_snapshots WHERE menu_item_id = ?').all(src.id);
  d.close();

  assert.notStrictEqual(copy.name, src.name, 'a new name');
  assert.strictEqual(copy.status, 'draft', 'a copy starts as a draft');
  assert.strictEqual(copyLines.length, srcLines.length, 'the whole recipe came across');
  assert.deepStrictEqual(copyLines.map((l) => l.product_id).sort(), srcLines.map((l) => l.product_id).sort());
  assert.strictEqual(copySnaps.length, 1, 'its own first snapshot only');
  assert.ok(srcSnaps.length > 1, "and it did not inherit the original's history");
});

test('archiving keeps the item and its history', async () => {
  const m = lastItemNamed('PV Breakfast Sandwich');
  await post(`/menu/${m.id}/status`, { status: 'archived' });
  const d = db();
  const after = d.prepare('SELECT * FROM menu_items WHERE id = ?').get(m.id);
  const snaps = d.prepare('SELECT COUNT(*) n FROM menu_snapshots WHERE menu_item_id = ?').get(m.id).n;
  d.close();
  assert.strictEqual(after.status, 'archived');
  assert.ok(after.archived_at, 'and stamped');
  assert.ok(snaps > 1, 'history intact');

  const list = await open('/menu');
  assert.ok(list.includes('Archived'), 'the list can still show it');
});

function lastItemNamed(name) {
  const d = db();
  const r = d.prepare('SELECT * FROM menu_items WHERE name = ?').get(name);
  d.close();
  return r;
}
