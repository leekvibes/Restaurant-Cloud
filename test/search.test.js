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
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: 'owner-pw' },
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
