'use strict';

// Search reads from every table by design, which makes it the obvious way to
// leak. These are mostly about what it must NOT return.
//
// The gate has to run before the query, not after: filtering in the browser
// would still have put payroll names on the wire. So the assertions here are
// on the endpoint's response, over HTTP, as a restricted account.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3965;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-search-'));
const DB = path.join(dir, 's.db');
let child, Database;

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const as = (cookie, p) => fetch(BASE + p, { redirect: 'manual', headers: { cookie: `rc_auth=${cookie}` } });
const login = async (body) => {
  const c = (await post('/login', body)).headers.get('set-cookie') || '';
  return (c.match(/rc_auth=([^;]*)/) || [])[1] || '';
};
const find = async (cookie, q) => {
  const r = await as(cookie, '/search?q=' + encodeURIComponent(q));
  assert.strictEqual(r.status, 200, `search should answer, got ${r.status}`);
  return r.json();
};
const labels = (d) => d.groups.map((g) => g.label);
const titles = (d) => d.groups.flatMap((g) => g.results.map((r) => r.title));

// A distinctive string planted in every table, so one query reaches all of it.
const TAG = 'Zebracorn';

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: 'owner-pw' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const db = new Database(DB);
  const v = db.prepare('INSERT INTO m_vendors (name, category) VALUES (?, ?)').run(`${TAG} Foods`, 'Produce').lastInsertRowid;
  db.prepare('INSERT INTO products (name, unit) VALUES (?, ?)').run(`${TAG} tomatoes`, 'case');
  db.prepare('INSERT INTO m_invoices (invoice_number, vendor_id, amount_cents, invoice_date, status) VALUES (?,?,?,?,?)')
    .run(`${TAG}-991`, String(v), 4510, '2026-07-01', 'Unpaid');
  db.prepare('INSERT INTO employees (name, role, active) VALUES (?, ?, 1)').run(`${TAG} Sandra`, 'server');
  db.prepare("INSERT INTO shifts (date, daypart, status) VALUES ('2026-07-15','dinner','open')").run();
  db.prepare('INSERT INTO menu_items (name, category, status) VALUES (?,?,?)').run(`${TAG} sandwich`, 'Breakfast', 'active');
  db.prepare('INSERT INTO m_recurring (name, next_due) VALUES (?, ?)').run(`${TAG} hood clean`, '2026-08-01');
  db.prepare('INSERT INTO m_expirations (name, expires_on) VALUES (?, ?)').run(`${TAG} licence`, '2026-09-01');
  db.close();
});

test.after(() => { if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

/** Make a restricted account and return its cookie. */
async function viewer(email, features) {
  const owner = await login({ password: 'owner-pw' });
  const body = [['name', 'R ' + email], ['email', email], ['password', 'viewer-pw-123'], ['role', 'viewer']];
  for (const f of features) body.push(['features', f]);
  await fetch(BASE + '/users', {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `rc_auth=${owner}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return login({ email, password: 'viewer-pw-123' });
}

test('the owner finds things across every area', async () => {
  const owner = await login({ password: 'owner-pw' });
  const d = await find(owner, TAG);
  const got = labels(d);
  for (const want of ['Product', 'Menu item', 'Vendor', 'Invoice', 'Staff', 'Recurring task', 'Expiration']) {
    assert.ok(got.includes(want), `owner should see ${want}; got ${got.join(', ')}`);
  }
});

test('an account limited to shifts gets shifts and nothing else', async () => {
  const v = await viewer('shiftsonly@t.local', ['dashboard', 'shifts']);
  const d = await find(v, TAG);
  assert.deepStrictEqual(labels(d), [], `nothing in this account's areas matches "${TAG}"`);

  // It can still find its own area.
  const s = await find(v, '2026-07-15');
  assert.deepStrictEqual(labels(s), ['Shift']);
});

test('staff names do not come back for an account without staff access', async () => {
  const v = await viewer('nostaff@t.local', ['dashboard', 'trackers']);
  const d = await find(v, TAG);
  assert.ok(!labels(d).includes('Staff'), 'no staff group');
  assert.ok(!titles(d).some((t) => /Sandra/.test(t)), `no employee names on the wire: ${titles(d).join(', ')}`);
  // Trackers it does have.
  assert.ok(labels(d).includes('Vendor') && labels(d).includes('Product'));
});

test('menu costing stays out of results for an account without it', async () => {
  const v = await viewer('nomenu@t.local', ['dashboard', 'trackers', 'staff']);
  const d = await find(v, TAG);
  assert.ok(!labels(d).includes('Menu item'), `menu items withheld; got ${labels(d).join(', ')}`);
});

test('users are only searchable by an account that can open settings', async () => {
  const withSettings = await viewer('cansee@t.local', ['dashboard', 'settings']);
  const without = await viewer('cannot@t.local', ['dashboard', 'trackers']);
  assert.ok(labels(await find(withSettings, 'cannot@t.local')).includes('User'), 'settings access finds users');
  assert.deepStrictEqual(labels(await find(without, 'cansee@t.local')), [], 'without it, nothing');
});

test('search needs a signed-in account at all', async () => {
  const r = await fetch(`${BASE}/search?q=${TAG}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302, 'anonymous is bounced to login');
  assert.match(r.headers.get('location') || '', /^\/login/);
});

test('one and two characters are treated differently on purpose', async () => {
  const owner = await login({ password: 'owner-pw' });
  const one = await find(owner, 'Z');
  assert.strictEqual(one.total, 0, 'a single character matches most of the database and answers nothing');
  const two = await find(owner, 'Ze');
  assert.ok(two.total > 0, 'two is enough to start');
});

test('wildcards in the query are matched literally, not as wildcards', async () => {
  const owner = await login({ password: 'owner-pw' });
  // Unescaped, "%" would match every row in every table.
  const pct = await find(owner, '%%');
  assert.strictEqual(pct.total, 0, 'a percent sign is a character, not "everything"');
  const under = await find(owner, '_e');
  assert.strictEqual(under.total, 0, 'and so is an underscore');
});

test('results are capped so one query cannot return the whole database', async () => {
  // Spread across many sources on purpose. Ten of one thing only proves the
  // per-source limit; the overall cap needs more sources than 24 results.
  const db = new Database(DB);
  const many = db.transaction(() => {
    for (let i = 0; i < 8; i++) {
      db.prepare('INSERT INTO products (name, unit) VALUES (?, ?)').run(`Bulkthing p${i}`, 'each');
      db.prepare('INSERT INTO m_vendors (name, category) VALUES (?, ?)').run(`Bulkthing v${i}`, 'Other');
      db.prepare('INSERT INTO employees (name, role, active) VALUES (?, ?, 1)').run(`Bulkthing e${i}`, 'server');
      db.prepare('INSERT INTO menu_items (name, category, status) VALUES (?,?,?)').run(`Bulkthing m${i}`, 'Sides', 'active');
      db.prepare('INSERT INTO m_recurring (name, next_due) VALUES (?, ?)').run(`Bulkthing t${i}`, '2026-08-01');
      db.prepare('INSERT INTO m_contacts (name, role) VALUES (?, ?)').run(`Bulkthing c${i}`, 'plumber');
      db.prepare('INSERT INTO m_equipment (name, location) VALUES (?, ?)').run(`Bulkthing q${i}`, 'kitchen');
    }
  });
  many();
  db.close();

  const owner = await login({ password: 'owner-pw' });
  const d = await find(owner, 'Bulkthing');
  // 7 sources x 8 rows = 56 available; the cap has to bite well below that.
  assert.ok(d.total <= 24, `overall cap, got ${d.total}`);
  assert.ok(d.groups.every((g) => g.results.length <= 5), 'per-source cap too');
  assert.ok(d.truncated, 'and says it was cut short');
});

// The search panel shipped open on every page load: it carried the `hidden`
// attribute, but an author rule setting `display: flex` beats the browser's
// `[hidden] { display: none }`, so the attribute did nothing. Server-rendered
// HTML looked correct — the markup said hidden — which is why this checks the
// stylesheet rather than the page.
test('the results panel cannot render before it has something to show', async () => {
  const owner = await login({ password: 'owner-pw' });
  const html = await (await as(owner, '/')).text();

  const panel = html.match(/<div class="tsearch-pop"[^>]*>/);
  assert.ok(panel, 'the results panel is on the page');
  assert.match(panel[0], /\bhidden\b/, 'and starts hidden');
  assert.ok(!/<div class="pal"/.test(html), 'no full-screen overlay any more');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.tsearch-pop\[hidden\]\s*\{[^}]*display:\s*none/,
    'the hidden attribute must beat whatever display the panel is given');

  // And nothing may set a display on the panel that outranks it.
  const rules = css.match(/^\.tsearch-pop\s*\{[^}]*\}/m);
  if (rules) {
    assert.ok(!/display:\s*(flex|block|grid)/.test(rules[0])
      || /\.tsearch-pop\[hidden\]/.test(css), 'a display rule needs the [hidden] guard beside it');
  }
});

// --- the mobile header ---------------------------------------------------------
//
// Asserted against the stylesheet because that is where both bugs lived: the
// results panel opened on every page load because an author `display` beat
// `[hidden]`, and every sidebar heading vanished on a phone because the mobile
// override restored opacity but not height. Neither is reachable from the
// server's HTML, and both are one careless rule away from coming back.

const CSS = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

test('the collapsing sidebar heading is scoped to the width that has a rail', () => {
  const css = CSS();
  // Below the breakpoint the sidebar is a full-width drawer, never a rail, so
  // nothing should be collapsing its headings to zero height there. The rules
  // that do must sit inside a min-width query.
  const collapse = /html\.no-peek:not\(\.side-pinned\) \.sidebar:hover \.side-group/;
  assert.match(css, collapse, 'the rail collapse rule still exists');

  const idx = css.search(collapse);
  const before = css.slice(0, idx);
  // Walk back to the media query this rule is nested in.
  const opens = [...before.matchAll(/@media\s*\(([^)]*)\)\s*\{/g)];
  const depth = (s) => (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
  const enclosing = opens.reverse().find((m) => depth(before.slice(m.index)) > 0);
  assert.ok(enclosing, 'the rail collapse rule is inside a media query');
  assert.match(enclosing[1], /min-width/,
    `scoped to a min-width, not "${enclosing[1]}" — otherwise it applies on a phone`);
});

test('a sidebar heading has height by default, so a new context shows it', () => {
  const css = CSS();
  // The base rule is what any width that nobody thought about inherits. It
  // read height: 0 / opacity: 0, so the drawer showed one undifferentiated
  // list of links until the mobile override was found to be incomplete.
  const base = css.match(/\n\.side-group \{[^}]*\}/);
  assert.ok(base, '.side-group has a base rule');
  assert.ok(!/height:\s*0[;\s]/.test(base[0]), `visible by default, got: ${base[0].replace(/\s+/g, ' ')}`);
  assert.ok(!/opacity:\s*0[;\s]/.test(base[0]), 'and not transparent by default');
});

test('the phone header collapses the field and centres the mark', () => {
  const css = CSS();
  assert.match(css, /\.topbar\.search-on \.tsearch \{[^}]*width:/, 'expanding is a width change');
  assert.match(css, /\.topbar-brand \{[^}]*left:\s*50%/, 'the mark is centred on the bar, not on the leftover space');
  assert.match(css, /\.topbar\.search-on \.topbar-brand \{[^}]*opacity:\s*0/, 'and fades when the field opens');
});

test('the input becomes focusable the instant the field opens', () => {
  const css = CSS();
  // visibility:hidden is what keeps the collapsed input out of the tab order
  // and away from screen readers. It also makes focus() a no-op, so the open
  // transition must not delay it — that bug opened the field without ever
  // giving it the cursor, and the idle timer then closed it again.
  const open = css.match(/\.topbar\.search-on \.tsearch input \{[^}]*\}/);
  assert.ok(open, 'there is an expanded-input rule');
  assert.match(open[0], /visibility:\s*visible/);
  assert.match(open[0], /visibility\s+0s/, `visibility must flip at once, got: ${open[0].replace(/\s+/g, ' ')}`);
});

test('reduced motion is respected', () => {
  // There is more than one reduced-motion block in the sheet, so this picks
  // the one covering the header rather than whichever comes first.
  const blocks = [...CSS().matchAll(/@media \(prefers-reduced-motion: reduce\)[^{]*\{[\s\S]*?\n\}/g)];
  const block = blocks.map((m) => m[0]).filter((b) => b.includes('.topbar-brand'));
  assert.strictEqual(block.length, 1, 'exactly one reduced-motion block covers the header');
  // Naming the elements is not enough — the block has to actually stop them
  // moving. An earlier version of this test passed on a block that mentioned
  // .topbar-brand only to reposition it.
  assert.match(block[0], /transition-duration:\s*1ms/, `motion is cut, got: ${block[0].replace(/\s+/g, ' ')}`);
  for (const el of ['.topbar-brand', '.tsearch']) {
    assert.ok(block[0].includes(el), `${el} is covered`);
  }
});

test('the stylesheet\'s braces balance', () => {
  // A stray `}` at the top level is recovered from silently by every browser,
  // so it survives indefinitely — and then the first person to wrap a section
  // in a media query finds their rules closing one block too early.
  const css = CSS();
  let depth = 0, line = 1, bad = 0;
  for (const ch of css) {
    if (ch === '\n') line++;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) { bad = line; break; }
  }
  assert.strictEqual(bad, 0, `an unmatched closing brace at line ${bad}`);
  assert.strictEqual(depth, 0, `${Math.abs(depth)} block(s) left ${depth > 0 ? 'open' : 'over'}`);
});

test('the search field is operable by keyboard and announced', async () => {
  const owner = await login({ password: 'owner-pw' });
  const html = await (await as(owner, '/')).text();
  const btn = html.match(/<button[^>]*id="rc-sbtn"[^>]*>/);
  assert.ok(btn, 'the icon is a real button, not a decorative svg');
  assert.match(btn[0], /aria-label="Search"/, 'and is labelled');
  assert.match(btn[0], /aria-expanded="false"/, 'and reports its state');
  assert.match(btn[0], /aria-controls="rc-q"/, 'and says what it opens');
  assert.match(html, /<button[^>]*id="rc-sx"[^>]*aria-label="Clear search"/, 'with a labelled clear button');
});
