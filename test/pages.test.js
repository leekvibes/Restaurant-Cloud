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

// ---------------------------------------------------------------------------
// Ruled grids: the heading and the row have to agree.
//
// Every ledger on the site is a CSS grid where one element is the heading and
// another is the row, and the two are kept in step only by both declaring the
// same `grid-template-columns`. When a breakpoint folds a column away it has
// to fold it away in BOTH, at the same position, or the headings stop naming
// the figures underneath them.
//
// Three of the five grids were wrong at once. All three were written as
// `.some-class:nth-of-type(n)` — which counts sibling ELEMENTS and disregards
// the class written in front of it. Every cell in these grids is a <span>, so
// `.bs-sr-f:nth-of-type(2)` asks for "the 2nd span, if it happens to be an
// .bs-sr-f" and quietly matches nothing when it is not. The heading dropped to
// five columns and the row kept seven, on the phone, on pages used nightly.
// ---------------------------------------------------------------------------

/** Direct element children of the outermost tag in a fragment. */
function directChildren(html) {
  const inner = html.replace(/^<[^>]+>/, '').replace(/<\/[a-z]+>\s*$/i, '');
  let depth = 0, n = 0;
  for (const m of inner.matchAll(/<(\/?)([a-z]+)\b[^>]*?(\/?)>/gi)) {
    const [, close, tag, selfClose] = m;
    if (/^(input|img|br|hr|meta|link)$/i.test(tag)) { if (depth === 0 && !close) n++; continue; }
    if (close) depth--;
    else { if (depth === 0) n++; if (!selfClose) depth++; }
  }
  return n;
}

/** The stylesheet with /* comments *\/ removed, so prose about a mistake is
    not mistaken for the mistake. Line numbers are preserved. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

test('no ruled grid uses :nth-of-type to fold a column', () => {
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  const offenders = [];
  css.split('\n').forEach((line, i) => {
    if (/:(nth|first|last)-of-type/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(offenders, [],
    'position a grid cell with :nth-child — :nth-of-type ignores the class beside it');
});

test('every ledger heading has as many cells as its rows', async () => {
  // Rendered, not read out of the source: the whole point is what the browser
  // is handed. A grid whose heading and rows disagree is misaligned at every
  // width, before any breakpoint gets involved.
  //
  // The ranges are explicit and wide. Asked for its default period, /payroll
  // shows the fortnight that just ended — which holds none of the fixture's
  // shifts, so the page rendered no rows, this test compared nothing, and it
  // passed while a deliberately broken row went by untouched. Hence the
  // `checked` count at the bottom: a test that can quietly examine nothing is
  // not a test.
  const d = new (require('better-sqlite3'))(DB, { readonly: true });
  const span = (() => { try { return d.prepare('SELECT MIN(date) a, MAX(date) b FROM shifts').get(); } catch { return null; } })();
  const emp = (() => { try { return d.prepare('SELECT id FROM employees LIMIT 1').get(); } catch { return null; } })();
  d.close();
  assert.ok(span && span.a, 'the fixture has shifts to render');

  const range = `from=${span.a}&to=${span.b}`;
  const pairs = [
    [`/payroll?${range}`, 'the payroll roster', /<div class="bs-lhead bs-rhead">[\s\S]*?<\/div>/,
      /<a class="bs-lr bs-rrow" href[\s\S]*?<\/a>/g],
    [`/sales?r=custom&${range}`, 'the sales day ledger', /<div class="bs-shead bs-dayhead">[\s\S]*?<\/div>/,
      /<summary class="bs-sr">[\s\S]*?<\/summary>/g],
  ];
  if (emp) pairs.push([`/payroll/${emp.id}?${range}`, 'the payroll drill-down',
    /<div class="bs-lhead bs-payhead">[\s\S]*?<\/div>/, /<a class="bs-lr bs-payrow" href[\s\S]*?<\/a>/g]);

  const wrong = [];
  let checked = 0;
  for (const [url, what, headRe, rowRe] of pairs) {
    const res = await fetch(`${BASE}${url}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 200, `${url} renders`);
    const html = await res.text();
    const head = html.match(headRe);
    const rows = [...html.matchAll(rowRe)].map((m) => m[0]);
    assert.ok(head, `${what}: a heading was rendered`);
    assert.ok(rows.length, `${what}: rows were rendered`);
    const want = directChildren(head[0]);
    for (const r of rows) {
      checked++;
      const got = directChildren(r);
      if (got !== want) { wrong.push(`${what}: heading has ${want} cells, a row has ${got}`); break; }
    }
  }
  assert.deepStrictEqual(wrong, []);
  assert.ok(checked >= pairs.length, `compared ${checked} rows, not zero`);
});

test('folding a column folds it in the heading and the row alike', () => {
  // Read the stylesheet the way the browser does: inside each media block,
  // find what gets display:none, and check the heading and its row lose the
  // same positions. This is what actually broke — the heading folded two
  // columns and the row folded none.
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  // Most specific first. A selector is attributed to the first pair whose
  // heading or row class it names, so `.bs-dayrow > .bs-sr` counts as the day
  // ledger's row and not as the shift sheet's, which it also literally names.
  const PAIRS = [
    ['bs-dayhead', 'bs-dayrow'], ['bs-payhead', 'bs-payrow'], ['bs-rhead', 'bs-rrow'],
    ['bs-shifthead', 'bs-shiftrow'], ['bs-staffhead', 'bs-staffrow'],
  ];
  // Exact class tokens — `.bs-lr-n` must not read as `.bs-lr`.
  const classesIn = (sel) => new Set([...sel.matchAll(/\.([a-z0-9-]+)/g)].map((m) => m[1]));

  const problems = [];
  for (const block of css.matchAll(/@media[^{]*\{([\s\S]*?)\n\}/g)) {
    const body = block[1];
    const at = (block.input.slice(0, block.index).match(/\n/g) || []).length + 1;
    for (const rule of body.matchAll(/([^{}]+)\{([^}]*display:\s*none[^}]*)\}/g)) {
      const selectors = rule[1].split(',').map((x) => x.trim()).filter(Boolean);
      // Attribute each selector to exactly one pair and one side of it.
      const folds = new Map();   // pairIndex -> {head:Set, row:Set}
      for (const sel of selectors) {
        const cls = classesIn(sel);
        const i = PAIRS.findIndex(([h, r]) => cls.has(h) || cls.has(r));
        if (i < 0) continue;
        const pos = (sel.match(/:nth-child\((\d+)\)/) || [])[1];
        if (!pos) continue;                       // folded by class, not position
        if (!folds.has(i)) folds.set(i, { head: new Set(), row: new Set() });
        folds.get(i)[cls.has(PAIRS[i][0]) ? 'head' : 'row'].add(pos);
      }
      for (const [i, { head, row }] of folds) {
        const same = head.size === row.size && [...head].every((p) => row.has(p));
        if (!same) problems.push(`line ~${at}: .${PAIRS[i][0]} folds {${[...head]}} but .${PAIRS[i][1]} folds {${[...row]}}`);
      }
    }
  }
  assert.deepStrictEqual(problems, []);
});

test('Export to Excel is not swallowed by the drill-down route', async () => {
  // /payroll/:employeeId is declared before /payroll/export, so without a
  // digits-only constraint on the parameter Express hands "export" to the
  // drill-down, Number('export') is NaN, no employee matches, and the only way
  // to get the numbers into Gusto answers 404 "No such person".
  const res = await fetch(`${BASE}/payroll/export?from=2026-07-04&to=2026-07-17`, { redirect: 'manual' });
  assert.strictEqual(res.status, 200, 'the export renders');
  assert.match(res.headers.get('content-type') || '', /spreadsheet/, 'and it is a workbook, not a web page');
});

test('every inline script the server emits actually parses', async () => {
  // Client JS is built inside template literals, so a backslash that is not
  // doubled is eaten on the way out. `/^#s\d+$/` has shipped as `/^#sd+$/`
  // three times. Parsing does not catch that particular one — a mangled regex
  // is still valid JS — but it catches everything that breaks outright, and
  // the guard it replaced is now a plain string compare for the same reason.
  const broken = [];
  let scripts = 0;
  for (const p of ['/', '/shifts', '/sales', '/payroll', '/cash', '/costs']) {
    const res = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    if (res.status !== 200) continue;
    const html = await res.text();
    for (const [, body] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      if (!body.trim()) continue;
      scripts++;
      try { new Function(body); } catch (e) { broken.push(`${p}: ${e.message}`); }
    }
  }
  assert.ok(scripts > 5, `found ${scripts} inline scripts to check`);
  assert.deepStrictEqual(broken, []);
});

test('saving a row sends you back to that row', async () => {
  // Both ledgers redirect to an anchor so the page can put you back where you
  // were. Without it you land at the top and hunt for your place after every
  // save — which on a seven-person shift is seven times a night.
  const d = new (require('better-sqlite3'))(DB, { readonly: true });
  const sh = d.prepare('SELECT id FROM shifts LIMIT 1').get();
  const emp = d.prepare('SELECT id FROM employees LIMIT 1').get();
  d.close();
  assert.ok(sh && emp, 'the fixture has a shift and a person');

  const post = (url, form) => fetch(`${BASE}${url}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

  const staff = await post(`/shifts/${sh.id}/support`,
    { employee_id: String(emp.id), role: 'kitchen', hours: '6', wage: '18' });
  assert.strictEqual(staff.status, 302, 'the staff save redirects');
  assert.match(staff.headers.get('location'), new RegExp(`#edit-${emp.id}$`),
    'back to the person whose row you edited');

  // The range rides in the form body, the way the page's own hidden input
  // sends it — not on the query string, which the handler never reads.
  const sale = await post(`/sales/${sh.id}`,
    { r: '30', food: '100', coffee: '50', alcohol: '0', other: '0' });
  assert.strictEqual(sale.status, 302, 'the sales save redirects');
  const loc = sale.headers.get('location');
  assert.match(loc, new RegExp(`#s${sh.id}$`), 'back to the day you entered');
  assert.match(loc, /r=30/, 'and to the range you were filtering by');
});
