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

// A browser gets its CSRF token injected into every form it loads. These tests
// post straight at the routes, so they ask for one the same way the service
// worker does, and cache it per session.
const __csrf = new Map();
async function __token(cookie) {
  const key = cookie || '';
  if (!__csrf.has(key)) {
    const r = await fetch(BASE + '/csrf', { headers: key ? { cookie: key } : {} });
    __csrf.set(key, (await r.text()).trim());
  }
  return __csrf.get(key);
}

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

  // An expense, so the expenses ledger renders a month group. Without one that
  // page draws no groups at all and any sweep over the ledgers passes it
  // silently — which is exactly how an auto-open regression there went
  // uncaught until a mutation run pointed at it.
  run(`INSERT INTO m_expenses (spent_on, name, where_bought, category, amount_cents, paid_by, paid_with)
    VALUES (?, 'Bag of ice', 'Costco', 'Ice', 1248, 'Malek', 'Company card')`, today);
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

test('equipment uses the broadsheet treatment rather than the old admin table shell', async () => {
  const res = await fetch(`${BASE}/c/equipment`, { redirect: 'manual' });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /class="bs-page eq-page"/, 'equipment list uses the broadsheet page shell');
  assert.match(html, /class="bs-panel bs-strip eq-strip"/, 'equipment gets the summary strip');
  assert.match(html, /class="bs-lr eq-row"/, 'equipment rows render as ledger rows, not only a table');
});

test('equipment detail follows the same page language after opening a row', async () => {
  const res = await fetch(`${BASE}/c/equipment/1`, { redirect: 'manual' });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /class="bs-page eq-page eq-detail"/, 'detail view keeps the broadsheet shell');
  assert.match(html, /class="eq-facts"/, 'detail facts are grouped into a dedicated section');
  assert.match(html, /Edit<\/a>/, 'the existing edit workflow is still present');
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
    [`/payroll?${range}`, 'the payroll roster', /<div class="bs-lhead bs-rhead[^"]*">[\s\S]*?<\/div>/,
      /<a class="bs-lr bs-rrow[^"]*" href[\s\S]*?<\/a>/g],
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
    // The day grid and the live floor ledger fold their columns at the same
    // breakpoints their headings do, or the labels stop describing what is
    // under them.
    ['tsg-head', 'tsg-row'], ['tcl-h', 'tcl-r'],
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
  // The list is the point. A syntax error in an inline script kills every
  // handler on that page and shows nothing in the UI — the page simply stops
  // responding — so a page missing from here is a page where that ships. The
  // timesheet review was missing, and a '\n' inside a server-side template
  // literal reached the browser as a real newline, ended a string mid-line,
  // and took the whole click-to-edit grid down with it.
  const pages = ['/', '/shifts', '/sales', '/payroll', '/cash', '/costs',
    '/timeclock', '/payroll/timesheets', '/c/invoices', '/c/expenses'];
  // Plus one employee's review, which is where most of the client code lives.
  {
    const d2 = new (require('better-sqlite3'))(DB, { readonly: true });
    const e2 = d2.prepare('SELECT id FROM employees LIMIT 1').get();
    d2.close();
    if (e2) pages.push(`/payroll/timesheets/${e2.id}`);
  }
  for (const p of pages) {
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

test('nothing outranks the headline for the headline font', () => {
  // `.bs h1` scores a class AND an element, which beats the single class of
  // `.bs-headline` — so the one line per page the design reserves for
  // Newsreader came out in Geist on every page, for as long as the shell has
  // existed. The fix is :where(), which contributes no specificity.
  //
  // So: inside .bs, a bare element selector may not set a font. If it wants to
  // be the default for that element it has to say so with :where().
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  const offenders = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, sel, body] = rule;
    if (!/font-family/.test(body)) continue;
    for (const one of sel.split(',').map((x) => x.trim())) {
      // `.bs h1` — a class, whitespace, then a bare element with no class of
      // its own. `:where(.bs) h1` is the same thing declawed, and fine.
      if (/(^|\s)\.bs\s+[a-z][a-z0-9]*\s*$/.test(one) && !one.includes(':where')) {
        offenders.push(one);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'wrap it in :where() so a component class can still win');
});

test('every page opens with a title in the headline treatment', async () => {
  // Three treatments were in play: a serif headline on the redesigned pages, a
  // 23px sans <h1> on the ones still to be rebuilt, and on two pages the page
  // name only appeared in an 11px kicker. Whatever a page emits, it has to be
  // something the stylesheet gives the headline treatment to.
  const titled = /<h1[^>]*class="[^"]*bs-headline/;
  const aliased = /class="(?:page-head|phead-t)"[\s\S]{0,400}?<h1/;
  const missing = [];
  for (const p of ['/', '/shifts', '/sales', '/costs', '/cash', '/payroll',
    '/c/invoices', '/c/vendors', '/c/products', '/menu', '/employees', '/positions']) {
    const res = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    if (res.status !== 200) continue;
    const html = await res.text();
    if (!titled.test(html) && !aliased.test(html)) missing.push(p);
  }
  assert.deepStrictEqual(missing, []);
});

test('page titles carry no emoji', async () => {
  // Colour and shape carry meaning on these pages; a graduation cap does not.
  // ☀ ☾ ✕ ✓ ★ → are design glyphs and stay.
  const EMOJI = /[\u{1F300}-\u{1FAFF}]/u;
  const found = [];
  for (const p of ['/shifts', '/sales', '/costs', '/cash', '/payroll',
    '/c/invoices', '/c/vendors', '/c/products', '/menu', '/employees', '/positions']) {
    const res = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    if (res.status !== 200) continue;
    const html = await res.text();
    for (const [, inner] of html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)) {
      if (EMOJI.test(inner)) found.push(`${p}: ${inner.replace(/<[^>]+>/g, '').trim().slice(0, 40)}`);
    }
  }
  assert.deepStrictEqual(found, []);
});

test('the row stripe never covers a row that is saying something', () => {
  // Alternating tint on the ledgers is the quietest state a row has. A row you
  // are pointing at, one you have opened, and one you have just saved all have
  // something to say, and each says it with a background — so the stripe has
  // to lose to every one of them.
  //
  // It does that by scoring lower, not by being written first: source order
  // only decides ties. :where() contributes nothing, so the stripe selectors
  // score a single pseudo-class while .bs-lr:hover and .bs-srow[open] score
  // two. Wrap the stripe in a plain class instead and it starts winning, and
  // hover silently stops working on every other row.
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));

  // a, b, c — ids, then classes/attributes/pseudo-classes, then elements.
  // :where() contributes nothing; :not()/:is() contribute their argument.
  const specificity = (sel) => {
    const s = sel.replace(/:where\([^)]*\)/g, '');
    const a = (s.match(/#[\w-]+/g) || []).length;
    const b = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!not\b|is\b)[\w-]+(?:\([^)]*\))?/g) || []).length;
    return a * 100 + b;
  };

  const ruleFor = (needle) => {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].includes(needle) && /background/.test(m[2])) return m[1];
    }
    return null;
  };

  const stripe = ruleFor('nth-child(even)');
  assert.ok(stripe, 'the stripe rule exists');
  const worst = Math.max(...stripe.split(',').map((s) => specificity(s.trim())));

  for (const louder of ['.bs-lr:hover', '.bs-srow[open]']) {
    const rule = ruleFor(louder);
    assert.ok(rule, `${louder} still sets a background`);
    const best = Math.min(...rule.split(',').map((s) => specificity(s.trim())));
    assert.ok(best > worst,
      `${louder} scores ${best} and the stripe scores ${worst} — the stripe would win and hide it`);
  }
});

test('both themes give the stripe its own colour', () => {
  // A stripe that falls back to the day colour in night mode is a pale band
  // across a dark page — worse than no stripe at all.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  const day = css.match(/:root,\s*:root\[data-theme="day"\][\s\S]*?\}/);
  const night = css.match(/:root\[data-theme="night"\][\s\S]*?\}/);
  assert.ok(day && /--stripe:/.test(day[0]), 'day defines --stripe');
  assert.ok(night && /--stripe:/.test(night[0]), 'night defines --stripe');
  const val = (block) => (block.match(/--stripe:\s*([^;]+);/) || [])[1].trim();
  assert.notStrictEqual(val(day[0]), val(night[0]), 'and they are not the same colour');
});

// ---------------------------------------------------------------------------
// Section framing.
//
// The rules the handoff is explicit about are the ones easy to erode later:
// one panel per section, urgency as a hairline rather than a fill, and hover
// as an enhancement the layout does not depend on.
// ---------------------------------------------------------------------------

// The dashboard came back out: framing it flattened the one page whose job is
// reading at a glance, and it now runs the ruled three-column layout it had
// before. Shifts, Sales and Payroll keep the pattern.
// The two Time Clock tabs are here deliberately: they carry the newest and
// densest markup in the app, and until they were listed they were the only
// panelled pages exempt from the no-nested-panels and one-heading-per-panel
// rules the rest of the app is held to.
const PANEL_PAGES = ['/shifts', '/sales', '/payroll', '/timeclock', '/payroll/timesheets'];

/** Outermost-first list of panel fragments on a page, with nesting depth. */
function panelsWithDepth(html) {
  const out = [];
  const open = /<section[^>]*class="[^"]*\bbs-panel\b[^"]*"[^>]*>/g;
  // Walk section tags, tracking depth, so a panel inside a panel is visible.
  const tags = [...html.matchAll(/<section\b[^>]*>|<\/section>/g)];
  let depth = 0;
  const stack = [];
  for (const t of tags) {
    if (t[0].startsWith('</')) { const s = stack.pop(); if (s) out.push(s); depth--; continue; }
    const isPanel = /class="[^"]*\bbs-panel\b/.test(t[0]);
    depth++;
    if (isPanel) stack.push({ depth, start: t.index, tag: t[0] });
    else stack.push(null);
  }
  void open;
  return out.filter(Boolean);
}

test('every framed page has panels, and none of them nest', async () => {
  // "Don't nest panels. If a section contains sub-groups, separate them with
  // dotted rules inside the one panel."
  const bad = [];
  let total = 0;
  for (const p of PANEL_PAGES) {
    const res = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 200, `${p} renders`);
    const html = await res.text();
    const panels = panelsWithDepth(html);
    assert.ok(panels.length > 0, `${p} has at least one framed section`);
    total += panels.length;

    // A panel whose opening tag appears inside another panel's span is nested.
    const spans = [];
    for (const m of html.matchAll(/<section[^>]*class="[^"]*\bbs-panel\b[^"]*"[^>]*>/g)) spans.push(m.index);
    for (const start of spans) {
      const before = html.slice(0, start);
      const opens = (before.match(/<section\b/g) || []).length;
      const closes = (before.match(/<\/section>/g) || []).length;
      // depth > 0 means this <section> opens while another is still open.
      // Only a panel inside a panel is a problem, so check the enclosing one.
      if (opens - closes > 0) {
        const enclosing = before.lastIndexOf('<section');
        if (/class="[^"]*\bbs-panel\b/.test(html.slice(enclosing, enclosing + 200))) {
          bad.push(`${p}: a panel opens inside another panel`);
        }
      }
    }
  }
  assert.ok(total >= 10, `found ${total} panels across the four pages`);
  assert.deepStrictEqual(bad, []);
});

test('a panel carries at most one section heading', async () => {
  // One panel per section. Two section headings inside one frame means two
  // sections were wrapped together.
  //
  // A SECTION heading is a .bs-kicker inside a .bs-sec-h. The class is also
  // used for sub-group labels — the month bars inside the sales ledger — and
  // those are explicitly fine: "if a section contains sub-groups, separate
  // them with dotted rules inside the one panel". Counting every .bs-kicker
  // flags the ledger, which is one section with twelve months in it.
  const bad = [];
  let checked = 0;
  for (const p of PANEL_PAGES) {
    const html = await (await fetch(`${BASE}${p}`, { redirect: 'manual' })).text();
    for (const m of html.matchAll(/<section[^>]*class="[^"]*\bbs-panel\b[^"]*"[^>]*>([\s\S]*?)<\/section>/g)) {
      checked++;
      const headings = (m[1].match(/class="bs-sec-h[^"]*"/g) || []).length;
      if (headings > 1) bad.push(`${p}: one panel holds ${headings} section headings`);
    }
  }
  assert.ok(checked >= 10, `inspected ${checked} panels`);
  assert.deepStrictEqual(bad, []);
});

test('urgency is a hairline, never a fill', () => {
  // "A section that needs attention gets a single 3px left border in the
  // meaning colour — and nothing else changes. The panel plane stays the
  // same tint." A background on the warn variant is the failure this catches.
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  for (const cls of ['bs-panel-warn', 'bs-panel-crit']) {
    let body = null;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].includes('.' + cls)) body = m[2];
    }
    assert.ok(body, `.${cls} exists`);
    assert.match(body, /border-left:\s*3px solid/, `.${cls} is a 3px left hairline`);
    assert.ok(!/background/.test(body), `.${cls} must not fill — urgency is a line, not a plane`);
  }
});

test('the panel rests flat and only lifts where hover is real', () => {
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));

  // Resting state: no shadow, radius 0. The frame alone has to carry the
  // separation on touch and in print.
  // EVERY rule whose selector is exactly .bs-panel, joined — there is more
  // than one (the second re-anchors --stripe for ledgers inside a frame), and
  // keeping only the last checked the wrong block: a resting shadow added to
  // the first one sailed straight through.
  const rest = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].trim() === '.bs-panel').map((m) => m[2]).join(';');
  assert.ok(rest.length, '.bs-panel exists');
  // Drop the transition value before looking: it names box-shadow so the lift
  // animates, which is not the same as having one at rest.
  const decls = rest.replace(/transition\s*:[^;]*;?/g, '');
  assert.ok(!/box-shadow\s*:/.test(decls), 'no shadow at rest');
  assert.ok(!/border-radius:\s*[1-9]/.test(rest), 'radius stays 0');

  // The lift lives behind a hover query, or a tap latches it on a phone.
  // translateY, not just `transform` — the reduced-motion block also names
  // .bs-panel:hover, to switch the movement off.
  const hoverBlocks = [...css.matchAll(/@media([^{]*)\{([\s\S]*?)\n\}/g)]
    .filter((m) => m[2].includes('.bs-panel:hover') && /translateY/.test(m[2]));
  assert.strictEqual(hoverBlocks.length, 1, 'exactly one place lifts the panel');
  assert.match(hoverBlocks[0][1], /hover:\s*hover/, 'gated on a real hover device');
});

test('both themes define every panel token', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  const day = css.match(/:root,\s*:root\[data-theme="day"\][\s\S]*?\n\}/)[0];
  const night = css.match(/:root\[data-theme="night"\][\s\S]*?\n\}/)[0];
  for (const t of ['--panel', '--panel-line', '--panel-up', '--panel-up-line', '--panel-lift']) {
    assert.ok(day.includes(t + ':'), `day defines ${t}`);
    assert.ok(night.includes(t + ':'), `night defines ${t}`);
  }
});

// ---------------------------------------------------------------------------
// The sidebar replaced the top nav band: a primary rail of sections and a
// contextual panel of the section's pages. These guard the same invariants the
// band tests did — every section reachable, exactly one active marker, hidden
// on a phone, in flow rather than floating.
// ---------------------------------------------------------------------------
const cssRuleFor = (css, sel) => {
  let body = null;
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1].trim() === sel) body = (body || '') + m[2];
  return body;
};

test('the sidebar lists every section and its pages', async () => {
  const html = await (await fetch(`${BASE}/`, { redirect: 'manual' })).text();
  assert.match(html, /<aside class="bs-side"/, 'the sidebar exists');
  const side = html.slice(html.indexOf('<aside class="bs-side"'), html.indexOf('</aside>'));

  // Every section shows its title, and every day-to-day page sits under one.
  const titles = [...side.matchAll(/class="bs-side-h">([^<]+)</g)].map((m) => m[1]);
  assert.ok(titles.length >= 4, `found ${titles.length} section titles`);
  const links = [...side.matchAll(/class="bs-side-i[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of ['/shifts', '/sales', '/costs', '/cash', '/payroll', '/c/invoices', '/c/vendors', '/employees']) {
    assert.ok(links.some((h) => h === href || h.startsWith(href)), `${href} is in the sidebar`);
  }
});

test('exactly one page is marked active', async () => {
  for (const p of ['/shifts', '/payroll', '/c/invoices']) {
    const html = await (await fetch(`${BASE}${p}`, { redirect: 'manual' })).text();
    const side = html.slice(html.indexOf('<aside class="bs-side"'), html.indexOf('</aside>'));
    const on = (side.match(/class="bs-side-i on"/g) || []).length;
    assert.strictEqual(on, 1, `${p}: exactly one page active, got ${on}`);
  }
});

test('the active page is drawn, not just classed', () => {
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  // A fill/weight and an accent bar, so where-you-are reads at a glance.
  assert.match(cssRuleFor(css, '.bs-side-i.on') || '', /font-weight:\s*6\d\d|background:/, 'the active page is filled or weighted');
  assert.match(cssRuleFor(css, '.bs-side-i.on::before') || '', /background:/, 'and carries an accent bar');
});

test('the sidebar sits in flow and sticks — it never floats over content', () => {
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  assert.match(cssRuleFor(css, '.bs-shell') || '', /display:\s*flex/, 'the shell lays the sidebar beside the content');
  const side = cssRuleFor(css, '.bs-side') || '';
  assert.match(side, /position:\s*sticky/, 'the sidebar sticks, holding its column');
  assert.ok(!/position:\s*fixed/.test(side), 'never fixed over the page');
});

test('collapse is remembered, painted before first paint', () => {
  const views = fs.readFileSync(path.join(__dirname, '..', 'src', 'views.js'), 'utf8');
  // Read up front so a collapsed sidebar never expands-then-snaps on load.
  assert.match(views, /localStorage\.getItem\('rc_nav'\)\s*===\s*'collapsed'/, 'the stored collapse state is read before paint');
  assert.match(views, /classList\.add\('rc-collapsed'\)/, 'and applied as a class');
  assert.match(views, /localStorage\.setItem\('rc_nav'/, 'toggling collapse is remembered');
});

test('collapsed is a skinny rail of section icons, each opening a flyout', () => {
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  const shell = cssRuleFor(css, '.bs-shell') || '';
  const wc = parseFloat((shell.match(/--side-wc:\s*([\d.]+)px/) || [])[1]);
  assert.ok(wc && wc <= 56, `the collapsed rail is skinny, got ${wc}px`);
  // Collapsed: each section bunches into its icon, which is shown; the pages
  // fold into a flyout that opens beside it.
  assert.match(css, /html\.rc-collapsed[^{]*\.bs-side-gi\s*\{[^}]*opacity:\s*1/, 'the section icon shows when collapsed');
  assert.match(css, /html\.rc-collapsed[^{]*\.bs-side-list\s*\{[^}]*position:\s*absolute/, 'the pages become a flyout');
  assert.match(css, /html\.rc-collapsed[^{]*\.bs-side-grp:hover[^{]*\.bs-side-list/, 'hovering a section opens its flyout');
});

test('a phone gets no sidebar — the bottom bar takes over', () => {
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  const mob = [...css.matchAll(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('');
  assert.match(mob, /\.bs-side\s*\{[^}]*display:\s*none/, 'the sidebar is hidden on a phone');
  assert.match(mob, /\.bs-shell\s*\{[^}]*display:\s*block/, 'and the shell stops being two columns so content fills the screen');
});

test('the section labels are legible, not fine print', () => {
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  const body = cssRuleFor(css, '.bs-side-h');
  assert.ok(body, '.bs-side-h exists');
  const size = parseFloat((body.match(/font-size:\s*([\d.]+)px/) || [])[1]);
  assert.ok(size >= 10, `section labels are readable, got ${size}px`);
});

test('the shift button is gone from the bar, not just hidden', async () => {
  // It lived in the masthead as a global action for one page's verb. The
  // handoff removes it; the Shifts page and ⌘K still have it.
  const html = await (await fetch(`${BASE}/shifts`, { redirect: 'manual' })).text();
  const bar = html.slice(html.indexOf('class="bs-masthead"'), html.indexOf('</header>'));
  assert.ok(!/Log a shift/.test(bar), 'not in the top bar');
  assert.match(html, /Log a shift/, 'still on the page it belongs to');
});

test('the mobile dashboard leads with attention and drops the sales figures', () => {
  // Order on a phone: last service, needs attention (which carries the floor's
  // out-of-stock reports), today's specials, then what's coming up. The week's
  // sales figures are hidden — they live on Sales and Performance. The columns
  // become display:contents so the blocks themselves are the grid items.
  const css = stripComments(fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8'));
  const stacked = [...css.matchAll(/@media \(max-width: 1180px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('');
  assert.match(stacked, /\.bs-cols3 > \.bs-col \{[^}]*display:\s*contents/,
    'the columns stop being boxes so their blocks can be reordered');

  const ruleOf = (cls) => {
    const m = new RegExp(`\\.bs-dblk-${cls}\\s*\\{([^}]*)\\}`).exec(stacked);
    assert.ok(m, `.bs-dblk-${cls} is present in the stack`);
    return m[1];
  };
  const num = (rule) => Number(/order:\s*(\d+)/.exec(rule)[1]);
  assert.deepStrictEqual(
    [num(ruleOf('last')), num(ruleOf('attn')), num(ruleOf('specials')), num(ruleOf('coming'))],
    [1, 2, 3, 4],
    'last service · attention · today\'s specials · coming up',
  );
  // The week's sales figures are dropped on the phone, not merely reordered.
  assert.match(ruleOf('week'), /display:\s*none/, 'the week in numbers is hidden on mobile');
});

test('the staff portal starts below the phone status bar', async () => {
  // viewport-fit=cover lets the page paint the full screen, including the
  // strip the clock and battery sit in. The footer reserved the bottom inset
  // from the start; the top never did, so the restaurant name and "Not you?"
  // drew underneath the clock on every iPhone.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  for (const bar of ['.tp-top', '.tp-navbar', '.si-top']) {
    const m = new RegExp(`\\${bar}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `${bar} exists`);
    assert.match(m[1], /padding:\s*calc\([^)]*env\(safe-area-inset-top\)/,
      `${bar} reserves the status bar`);
  }
  // The sign-in has its own header bar; it reserves the inset too.
  const signin = await (await fetch(`${BASE}/tips`, { redirect: 'manual' })).text();
  assert.match(signin, /class="si-top"/, 'the PIN screen uses the inset bar');
});

test('payroll opens on the period running now', async () => {
  // It used to open on the period that just ended, so every visit landed a
  // fortnight behind and had to be clicked forward.
  const { currentPeriod, labelFor } = require('../src/periods');
  const cur = currentPeriod();
  const html = await (await fetch(`${BASE}/payroll`, { redirect: 'manual' })).text();
  const sub = html.match(/class="bs-subline">([\s\S]*?)<\/p>/);
  assert.ok(sub, 'the page states its period');
  assert.ok(sub[1].includes(labelFor(cur)),
    `expected ${labelFor(cur)}, got ${sub[1].replace(/\s+/g, ' ').trim().slice(0, 60)}`);
});

test('payroll keeps every column on the web, shows take-home on mobile', async () => {
  // The web roster is unchanged — all its columns are there. What changed is
  // the phone: it used to fold down to card payout, and now folds to
  // take-home. That is a CSS choice, so the columns stay in the markup and the
  // narrow breakpoint hides card payout and keeps the take-home cell.
  const P = require('../src/periods');
  const cur = P.currentPeriod();
  const html = await (await fetch(`${BASE}/payroll?from=${cur.start}&to=${cur.end}`, { redirect: 'manual' })).text();
  const head = (html.match(/class="bs-lhead bs-rhead[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '';
  assert.match(head, /Cash tips/, 'the web keeps the cash-tips column');
  assert.match(head, /Card payout/, 'and card payout');
  assert.match(head, /On the check/, 'and the take-home column');
  assert.match(html, /class="bs-lr-n strong bs-takehome"/, 'take-home is tagged for the phone to promote');

  // Week 1 and Week 2 are columns whether or not overtime is switched on. The
  // fixture runs with it off, so this is the case that used to hide them behind
  // a cramped "40 + 32" under the Hours figure.
  assert.match(head, /Wk 1/, 'the week split is a column');
  assert.match(head, /Wk 2/, 'both halves of it');
  assert.ok(!/>OT</.test(head), 'and no OT column while overtime is off');
  assert.match(html, /class="bs-lhead bs-rhead has-wk"/, 'the layout says which shape it is');

  // At the phone breakpoint everything between the name and the take-home
  // folds away — the week columns included, since they are a web reading.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  assert.match(css, /\.bs-rrow\.has-wk:not\(\.has-ot\) > :nth-child\(7\)[^}]*display: none/,
    'card payout folds away on a phone');
  assert.match(css, /\.bs-rrow \.bs-takehome \{[^}]*font-size/, 'and take-home is promoted there');

  // The how-it-works explainer is still gone.
  assert.ok(!/is what goes into Gusto — card tips net of tip-out/.test(html), 'the explainer stays removed');
});

test('the payroll summary shows each person and the total, printable', async () => {
  const P = require('../src/periods');
  const cur = P.currentPeriod();
  const res = await fetch(`${BASE}/payroll/summary?from=${cur.start}&to=${cur.end}`, { redirect: 'manual' });
  assert.strictEqual(res.status, 200, 'the summary opens');
  const html = await res.text();
  assert.match(html, /Payroll summary/, 'it is the summary');
  assert.match(html, /What each person takes home/i, 'listing take-home per person');
  assert.match(html, /window\.print\(\)/, 'with a print action');
  assert.match(html, /Total on the checks/, 'and a total');
});

test('a skipped period stops the dashboard asking, without looking sent', async () => {
  const P = require('../src/periods');
  const { start, end } = P.recentPeriods(2)[1];
  const post = (u, b) => fetch(BASE + u, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(b).toString(),
  });
  const nags = async () => ((await (await fetch(`${BASE}/`, { redirect: 'manual' })).text())
    .match(/Payroll ready/g) || []).length;

  // The precondition IS the test. Checking "no nag after skipping" proves
  // nothing if there was no nag to begin with — which is how the first version
  // of this passed while the guard it was meant to cover had been deleted.
  const before = await nags();
  assert.ok(before > 0, `the dashboard is asking about ${start} to begin with, got ${before}`);

  await post('/payroll/skip', { from: start, to: end });
  assert.strictEqual(await nags(), 0, 'skipping silences it');

  const page = await (await fetch(`${BASE}/payroll?from=${start}&to=${end}`, { redirect: 'manual' })).text();
  assert.match(page, /marked as not running/, 'and the page says why');
  // A skip must never read as a send — they are separate tables for this reason.
  assert.ok(!/Already sent/.test(page), 'without claiming anything went out');

  await post('/payroll/unskip', { from: start, to: end });
  assert.strictEqual(await nags(), before, 'and unskipping brings it back');
});

test('a closed service is answered, not outstanding', async () => {
  // Staff worked, the room never opened. Typing zeros would make it a $0 day
  // that drags the averages and sits in "needs sales entry" for ever.
  //
  // The fixture's only service HAS sales, so an earlier version of this test
  // closed it and asserted the nag was absent — which it always was. A service
  // with genuinely no sales has to exist for the assertion to mean anything.
  const Database = require('better-sqlite3');
  const rw = new Database(DB);
  const date = '2026-03-11';                       // clear of every other fixture row
  rw.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'dinner', 'open')").run(date);
  const id = rw.prepare('SELECT id FROM shifts WHERE date = ?').get(date).id;
  rw.close();

  const post = (u, b) => fetch(BASE + u, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(b).toString(),
  });
  const range = `r=custom&from=${date}&to=${date}`;
  const page = async () => (await fetch(`${BASE}/sales?${range}`, { redirect: 'manual' })).text();

  const before = await page();
  assert.match(before, /Needs sales entry/, 'it is asking for sales to begin with');

  await post(`/sales/${id}/closed`, { r: 'custom', from: date, to: date });
  const closed = await page();
  assert.ok(!/Needs sales entry/.test(closed), 'closing stops it asking');
  assert.match(closed, /bs-tag">closed/, 'and says why');
  assert.match(closed, /all entered/, 'the month no longer counts it as unfinished');

  await post(`/sales/${id}/open`, { r: 'custom', from: date, to: date });
  assert.match(await page(), /Needs sales entry/, 'reopening puts it back');
});

test('both apps launch on the cream the logo sits on', () => {
  // Asserted on the bytes, not a filename: a PNG that is not the declared size
  // would sail past a check that only looked for the file.
  const buf = fs.readFileSync(path.join(__dirname, '..', 'public', 'icon-512.png'));
  assert.strictEqual(buf.slice(1, 4).toString(), 'PNG', 'it is a PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  assert.deepStrictEqual([w, h], [512, 512], 'at the declared size');

  // Both apps' launch ground is the cream the branded splash paints onto, so
  // the OS launch screen continues into the logo splash without a colour flash.
  for (const f of ['manifest.webmanifest', 'manifest-tips.webmanifest']) {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'));
    assert.strictEqual(m.background_color, '#f4ead9', `${f}: launches on the splash cream`);
    assert.ok(m.icons.some((i) => i.purpose === 'maskable'), `${f}: has a maskable icon`);
  }
});

test('the launch splash is the logo, shown only for an installed app', () => {
  const views = fs.readFileSync(path.join(__dirname, '..', 'src', 'views.js'), 'utf8');
  // The mark is painted, gated on standalone display mode, once per launch.
  assert.match(views, /id="rc-splash"[\s\S]*?palm-icon-512\.png/, 'the splash shows the logo');
  assert.match(views, /display-mode:\s*standalone/, 'only when opened as an installed app');
  assert.match(views, /sessionStorage\.(get|set)Item\('rc_splashed'/, 'once per launch, not every navigation');
});

test('the manager app and the staff portal are two separate installs', async () => {
  // Adding the login screen to a home screen produced a shortcut that opened
  // the tip form. One `bare` flag was answering two questions — "no app
  // chrome" and "this is the staff portal" — and /login is the first without
  // being the second, so it served the tips manifest, whose start_url is
  // /tips.
  const manifestOf = (html) => (html.match(/rel="manifest" href="([^"]+)"/) || [])[1];
  const touchIconOf = (html) => (html.match(/rel="apple-touch-icon" href="([^"?]+)/) || [])[1];

  // The dashboard stands in for the login screen here: /login only renders
  // when APP_PASSWORD is set, and this fixture runs open. The login screen
  // itself is asserted in auth.test.js, which does set one.
  const dash = await (await fetch(`${BASE}/`, { redirect: 'manual' })).text();
  const tips = await (await fetch(`${BASE}/tips`, { redirect: 'manual' })).text();
  const login = dash;

  assert.strictEqual(manifestOf(dash), '/manifest.webmanifest',
    'a manager page installs the manager app');
  assert.strictEqual(manifestOf(tips), '/manifest-tips.webmanifest',
    'and the tip form installs the staff portal');

  // iOS takes the home-screen icon from the page rather than the manifest, so
  // sharing one here is what would make the two indistinguishable on a phone.
  assert.notStrictEqual(touchIconOf(login), touchIconOf(tips),
    'the two installs do not share an icon');

  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'));
  const mgr = read('manifest.webmanifest');
  const staff = read('manifest-tips.webmanifest');
  assert.strictEqual(mgr.start_url, '/', 'the manager app opens on the dashboard');
  assert.strictEqual(staff.start_url, '/portal', 'the staff portal opens on the hub');
  // Scope covers the whole app, not just /tips: staff move from the PIN screen
  // at /tips to the hub at /portal, and a scope of /tips would drop them out of
  // the installed app — into Safari with a URL bar — the moment they signed in.
  assert.strictEqual(staff.scope, '/', 'the portal stays in-app across /tips and /portal');
  assert.notStrictEqual(mgr.name, staff.name, 'and they are named apart');
  const srcs = (m) => m.icons.map((i) => i.src).sort().join();
  assert.notStrictEqual(srcs(mgr), srcs(staff), 'with their own icon sets');
});

// ---------------------------------------------------------------------------
// Compression.
//
// Nothing was compressed: a year of the invoice ledger went out as 640KB of
// HTML and the stylesheets as another 290KB. These pin the two things that
// make compression safe rather than merely small — that what arrives is
// byte-for-byte what was sent, and that it still arrives labelled as a page.
//
// The second one is not hypothetical. The first version of this gzipped the
// body correctly and let Express label the Buffer application/octet-stream,
// which every browser downloads instead of rendering. curl could not see it.
// ---------------------------------------------------------------------------

const zlib = require('node:zlib');

test('a compressed page decodes to exactly the page that was sent', async () => {
  for (const p of ['/c/invoices', '/shifts', '/']) {
    const plain = await (await fetch(BASE + p, { headers: { 'accept-encoding': 'identity' } })).text();
    const res = await fetch(BASE + p, { headers: { 'accept-encoding': 'gzip' } });
    const buf = Buffer.from(await res.arrayBuffer());
    // fetch may decode transparently; handle both so the test is about the
    // bytes rather than about which client ran it.
    const got = res.headers.get('content-encoding') === 'gzip' && buf[0] === 0x1f && buf[1] === 0x8b
      ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    assert.strictEqual(got, plain, `${p}: what arrives is what was sent`);
  }
});

test('a compressed page is still labelled as a page', async () => {
  // res.send's default Content-Type for a Buffer is application/octet-stream.
  // Gzipping turns the body into a Buffer, so the type has to be pinned first
  // or every page becomes a download.
  const res = await fetch(BASE + '/c/invoices', { headers: { 'accept-encoding': 'gzip' } });
  assert.match(res.headers.get('content-type') || '', /^text\/html/,
    'HTML stays HTML after being compressed');
  assert.ok(!/octet-stream/.test(res.headers.get('content-type') || ''),
    'and never becomes a file the browser saves instead of showing');
  assert.match(res.headers.get('vary') || '', /accept-encoding/i,
    'and says it varies, so a cache cannot serve gzip to a client that cannot read it');
});

test('a client that cannot decompress still gets the page', async () => {
  const res = await fetch(BASE + '/c/invoices', { headers: { 'accept-encoding': 'identity' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-encoding'), null, 'nothing is encoded for it');
  assert.match(await res.text(), /^<!doctype html>/i, 'and it is a readable page');
});

test('JSON keeps its own content type through compression', async () => {
  // The reader endpoints answer JSON that the drawer parses. Mislabelled, it
  // would parse as text and the drawer would report a failed read.
  const res = await fetch(`${BASE}/c/expenses/read`, { method: 'POST', headers: { 'accept-encoding': 'gzip' } });
  assert.match(res.headers.get('content-type') || '', /^application\/json/);
  assert.ok(await res.json(), 'and it still parses');
});

test('a stylesheet arrives as a stylesheet', async () => {
  const res = await fetch(`${BASE}/static/broadsheet.css`, { headers: { 'accept-encoding': 'gzip' } });
  assert.match(res.headers.get('content-type') || '', /^text\/css/,
    'or the browser refuses it and the app renders unstyled');
  const css = await res.text();
  assert.match(css, /\.bs-page|\.bs-srow/, 'and it is the real stylesheet');
});

// ---------------------------------------------------------------------------
// No ledger opens itself.
//
// A month ledger that expands its newest group decides for you which month you
// came for, and on a busy year that is sixty rows to scroll past before you
// reach the one you wanted. Every month starts shut; the totals on the header
// line still answer "what did we spend" without opening anything.
//
// Written as a sweep over the pages rather than one test each, so a ledger
// added later is covered the day it ships.
// ---------------------------------------------------------------------------

test('no month group is expanded on arrival, on any ledger', async () => {
  // Named per page, because "no group was open" is also true of a page that
  // drew no groups — a sweep that cannot tell those apart reports a pass for a
  // ledger it never looked at.
  // Shifts and Invoices moved to a month browser (a list + one panel, not an
  // accordion); each is exercised in its own file (shifts.test.js,
  // invoice-flow.test.js). The accordion ledgers stay here.
  const ledgers = ['/sales', '/c/expenses'];
  const covered = {};
  for (const p of ledgers) {
    const html = await (await fetch(BASE + p)).text();
    // Only the rendered container, not the JS that opens groups on filter.
    const groups = html.match(/<details class="(?:bs-month|mgroup)"[^>]*>/g) || [];
    covered[p] = groups.length;
    for (const g of groups) {
      assert.ok(!/\bopen\b/.test(g), `${p}: a month is expanded on arrival — ${g}`);
    }
  }
  for (const p of ledgers) {
    assert.ok(covered[p] > 0,
      `${p} rendered no month groups, so it was not actually checked — seed it. ${JSON.stringify(covered)}`);
  }
});

test('a closed ledger still shows what each month came to', async () => {
  // Closing them only works because the header carries the figures. If the
  // total moved inside the group, shutting it would hide the answer. Invoices
  // is a month browser now — its panel headers carry the totals, covered in
  // invoice-flow.test.js; Expenses is the accordion this still guards.
  const html = await (await fetch(`${BASE}/c/expenses`)).text();
  const heads = html.match(/<summary class="bs-month-h">[\s\S]*?<\/summary>/g) || [];
  assert.ok(heads.length, 'the expense ledger has month headers');
  for (const h of heads) {
    assert.match(h, /bs-month-tot/, 'each closed month still states its total');
    assert.match(h, /bs-month-meta/, 'and how many rows are inside it');
  }
});

test('the grid editor lives on the pages that host a grid, not in the fragment', async () => {
  // A <script> inside HTML assigned with innerHTML NEVER runs. The review grid
  // arrives two ways — with the full page, and as a fragment dropped into the
  // sheet — and the editing script started life inside that fragment. So
  // clicking a cell worked perfectly on the page and did nothing at all from
  // the Timesheets list, which is the way anybody actually opens it.
  const d = new (require('better-sqlite3'))(DB, { readonly: true });
  const emp = d.prepare('SELECT id FROM employees LIMIT 1').get();
  d.close();
  const marker = 'Click a cell, type, done';

  const frag = await (await fetch(`${BASE}/payroll/timesheets/${emp.id}?frag=1`)).text();
  assert.ok(!frag.includes(marker),
    'the fragment must not carry the editor — a script in it could never run');
  assert.match(frag, /data-positions="/,
    'so what the editor needs rides on the markup, which does survive innerHTML');

  for (const host of ['/payroll/timesheets', `/payroll/timesheets/${emp.id}`]) {
    const html = await (await fetch(BASE + host)).text();
    assert.ok(html.includes(marker), `${host} hosts a grid, so it must carry the editor`);
  }
});

test('the roster grid declares exactly as many columns as it renders cells', async () => {
  // The failure this exists to catch is silent and ugly: add a column to the
  // markup, forget the grid-template-columns, and every cell after it slides
  // one place left — Wages under "Cash tips", a real number under the wrong
  // heading, on the page somebody pays people from.
  //
  // Two shapes to keep honest, because Week 1 and Week 2 are columns whether
  // or not overtime is on, and OT adds a tenth on top of that.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'broadsheet.css'), 'utf8');
  const declared = (selector) => {
    const re = new RegExp(String.raw`\.bs-rhead${selector}[^{]*\{\s*\n?\s*grid-template-columns:([^;]+);`);
    const m = css.match(re);
    assert.ok(m, `${selector || '(base)'} declares a column template`);
    return m[1].trim().split(/\s+(?![^(]*\))/).length;
  };

  const P = require('../src/periods');
  const cur = P.currentPeriod();
  const html = await (await fetch(`${BASE}/payroll?from=${cur.start}&to=${cur.end}`, { redirect: 'manual' })).text();
  const head = (html.match(/class="bs-lhead bs-rhead[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '';
  const rendered = directChildren(head);
  assert.ok(rendered > 1, 'the header rendered cells to count');

  // The fixture runs with overtime off, so what is on screen is the has-wk shape.
  assert.strictEqual(rendered, declared('\\.has-wk:not\\(\\.has-ot\\)'),
    'the weeks-without-overtime grid matches its cells');
  // And the OT shape is one wider — the same header plus the OT column.
  assert.strictEqual(rendered + 1, declared('\\.has-ot'),
    'and the overtime grid is exactly one column wider');
});
