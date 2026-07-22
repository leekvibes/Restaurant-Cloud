'use strict';

// Every page, with something in it.
//
// /c/invoices threw a ReferenceError for months because the row-rendering path
// only runs when there is at least one row, and every test ran against an
// empty database. The page answered 200 the whole time — with nothing to draw.
//
// So: put a row in each table, then open every page in the navigation. It is a
// shallow test on purpose. It does not check what the pages say; it checks that
// they can say it at all when asked to render real data.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3988;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-pages-'));
const DB = path.join(dir, 'p.db');
let child, db;

const { SECTIONS } = require('../src/nav');

test.before(async () => {
  const Database = require('better-sqlite3');
  // Boot once to build the schema, then seed and boot for real.
  const boot = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT + 40), DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '', ZWIN_SKIP_BACKFILL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`http://127.0.0.1:${PORT + 40}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  boot.kill();
  await new Promise((r) => setTimeout(r, 300));

  db = new Database(DB);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const run = (sql, ...a) => { try { db.prepare(sql).run(...a); } catch (e) { throw new Error(`${sql.slice(0, 60)}… → ${e.message}`); } };

  const emp = db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active) VALUES ('Ada Lovelace','server',1500,1)").run().lastInsertRowid;
  const sh = db.prepare("INSERT INTO shifts (date, daypart, status, total_food_cents, total_coffee_cents) VALUES (?, 'cafe', 'emailed', 90000, 30000)").run(today).lastInsertRowid;
  run('INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents) VALUES (?, ?, ?, ?, ?)', sh, emp, 'server', 8.25, 1500);
  run(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents)
       VALUES (?, ?, 90000, 30000, 0, 14000, 2000)`, sh, emp);

  const ven = db.prepare("INSERT INTO m_vendors (name, category) VALUES ('Sysco Foods','Food')").run().lastInsertRowid;
  // Two invoices, because the bug was in the per-row map inside a month group.
  run(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, category, status, invoice_number, due_date, ai_lines, lines_imported)
       VALUES (?, ?, 124000, 'Food', 'Unpaid', 'INV-2044', ?, ?, 0)`, today, String(ven), today, JSON.stringify([{ name: 'Tomatoes', qty: 4 }]));
  run(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, category, status)
       VALUES (?, NULL, 45000, NULL, 'Paid')`, today);

  run("INSERT INTO m_expirations (name, expires_on) VALUES ('Liquor licence', ?)", today);
  run("INSERT INTO m_equipment (name, warranty_expires) VALUES ('Walk-in cooler', ?)", today);
  run("INSERT INTO m_documents (title) VALUES ('Lease')");
  run("INSERT INTO m_contacts (name) VALUES ('Plumber')");
  run("INSERT INTO m_recurring (name, next_due, responsible) VALUES ('Hood cleaning', ?, 'Kevin')", today);
  run("INSERT INTO m_incidents (type, logged_by) VALUES ('Injury','Malek')");
  run("INSERT INTO m_notes (title) VALUES ('Switched supplier')");
  run(`INSERT INTO cash_recon (date, daypart, float_cents, cash_sales_cents, counted_cents, status, counted_by)
       VALUES (?, 'cafe', 20000, 50000, 70000, 'final', 'Malek')`, today);
  db.close();

  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '', ZWIN_SKIP_BACKFILL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
test.after(() => { if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const paths = SECTIONS.flatMap((s) => s.links.map(([href]) => href));

test('every page in the navigation renders with data in it', async () => {
  const broken = [];
  for (const p of paths) {
    const res = await fetch(BASE + p, { redirect: 'manual' });
    if (res.status !== 200) { broken.push(`${p} → ${res.status}`); continue; }
    const html = await res.text();
    // Express's default error page, and our own.
    if (/ReferenceError|TypeError|SqliteError|Cannot GET/.test(html)) broken.push(`${p} → threw`);
  }
  assert.deepStrictEqual(broken, [], `${broken.length} of ${paths.length} pages broken`);
});

test('the pages that take a range still render at every preset', async () => {
  const broken = [];
  for (const p of ['/sales', '/costs']) {
    for (const r of ['today', '7', '30', '90', 'month', 'lastmonth', 'ytd']) {
      const res = await fetch(`${BASE}${p}?r=${r}`, { redirect: 'manual' });
      if (res.status !== 200) broken.push(`${p}?r=${r} → ${res.status}`);
    }
  }
  assert.deepStrictEqual(broken, []);
});

test('a record opens as well as a list', async () => {
  const Database = require('better-sqlite3');
  const d = new Database(DB, { readonly: true });
  const one = (sql) => { try { return d.prepare(sql).get(); } catch { return null; } };
  const targets = [
    ['/shifts/', one('SELECT id FROM shifts LIMIT 1')],
    ['/sales/', one('SELECT id FROM shifts LIMIT 1')],
    ['/cash/', one('SELECT id FROM cash_recon LIMIT 1')],
    ['/payroll/', one('SELECT id FROM employees LIMIT 1')],
    ['/c/invoices/', one('SELECT id FROM m_invoices LIMIT 1')],
    ['/c/vendors/', one('SELECT id FROM m_vendors LIMIT 1')],
  ];
  d.close();

  const broken = [];
  for (const [prefix, row] of targets) {
    if (!row) continue;
    const res = await fetch(`${BASE}${prefix}${row.id}`, { redirect: 'manual' });
    if (![200, 302].includes(res.status)) broken.push(`${prefix}${row.id} → ${res.status}`);
    else if (res.status === 200) {
      const html = await res.text();
      if (/ReferenceError|TypeError|SqliteError/.test(html)) broken.push(`${prefix}${row.id} → threw`);
    }
  }
  assert.deepStrictEqual(broken, []);
});

test('no two things share a class name and fight over it', async () => {
  // .bs-form belonged to the shift sheet's add-staff forms — a multi-column
  // grid — and the sales entry form reused the name. It silently became a grid
  // too and its rows drew on top of each other. Same shape as .bs-bottom a
  // reaching the Index, and .prow before that.
  //
  // This does not catch every collision. It catches the one that matters: a
  // block-level layout declared twice for two different things.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  const layouts = new Map();
  for (const m of css.matchAll(/(^|\n)(\.[a-z0-9-]+)\s*\{([^}]*)\}/g)) {
    const [, , sel, body] = m;
    const disp = body.match(/display:\s*(grid|flex)/);
    if (!disp) continue;
    if (!layouts.has(sel)) layouts.set(sel, []);
    layouts.get(sel).push(disp[1]);
  }
  const conflicting = [...layouts.entries()]
    .filter(([, kinds]) => new Set(kinds).size > 1)
    .map(([sel, kinds]) => `${sel} declared ${kinds.join(' and ')}`);
  assert.deepStrictEqual(conflicting, [], 'one class, one layout');
});

test('the sales entry form is not the shift sheet form', async () => {
  const res = await fetch(`${BASE}/sales/1`, { redirect: 'manual' });
  if (res.status !== 200) return;                     // no shift 1 in this fixture
  const html = await res.text();
  assert.match(html, /class="bs-entry"/, 'it has its own class');
  assert.ok(!/<form[^>]*class="bs-form"[^>]*action="\/sales/.test(html),
    'and does not borrow the one that lays out in columns');
});
