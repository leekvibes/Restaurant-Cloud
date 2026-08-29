'use strict';

// These run the app the way it runs on the host: APP_PASSWORD set, so the
// manager auth middleware is live. Locally that variable is usually unset,
// which disables auth entirely — so every earlier test exercised the app with
// the middleware switched off, and a staff route left out of OPEN_PATHS went
// unnoticed until a staff member hit "Session expired" at close.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3987;
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

// Its own database, set before anything requires src/db.
//
// This file used to boot with no DB_PATH, which means the default — the real
// one. It was not only reading it: the view-only tests create an account,
// disable it, re-enable it and delete it, and they were doing all of that in
// live data. Running the suite mutated the owner's own user table.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-auth-'));
const DB = path.join(dir, 'auth.db');
process.env.DB_PATH = DB;
let child;

const ENV = { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
  APP_PASSWORD: 'test-manager-password', ZWIN_SKIP_BACKFILL: '1' };

async function up() {
  // Boot once to build the schema, seed somebody with a PIN, then boot the
  // server the tests actually talk to.
  const boot = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...ENV, PORT: String(PORT + 40) }, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`http://127.0.0.1:${PORT + 40}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  boot.kill();
  await new Promise((r) => setTimeout(r, 300));

  const w = new (require('better-sqlite3'))(DB);
  const emp = w.prepare('INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES (?,?,?,1,?)')
    .run('Rosa Iglesias', 'server', 900, '5150').lastInsertRowid;
  // One sent service, so the dashboard has a last one to show. This used to
  // come free from the real database, which is exactly the kind of dependency
  // that hides until the data changes.
  const sh = w.prepare(`INSERT INTO shifts (date, daypart, status, created_at)
    VALUES (date('now','-1 day'), 'dinner', 'emailed', datetime('now'))`).run().lastInsertRowid;
  w.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)').run(sh, emp, 'server', 7);
  w.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents,
    alcohol_cents, card_tips_cents, cash_tips_cents) VALUES (?,?,?,?,?,?,?)`)
    .run(sh, emp, 140000, 9000, 21000, 24000, 5000);
  w.close();

  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: ENV, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/version`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}

test.before(up);
test.after(() => { if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const get = (p) => fetch(BASE + p, { redirect: 'manual' });
const post = async (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...body, _csrf: await __token(({} || {}).cookie) }).toString(),
});

test('staff can reach every step of the tips flow without the manager password', async () => {
  assert.strictEqual((await get('/tips')).status, 200, 'PIN screen');
  // /tips/start is the PIN step. Leaving it out of OPEN_PATHS is what made
  // staff see "Session expired" — a wall they had no way past.
  const start = await post('/tips/start', { pin: 'nope-not-a-real-pin' });
  assert.notStrictEqual(start.status, 401, 'must not hit the manager auth wall');
  assert.ok(start.status === 200 || start.status === 302, `got ${start.status}`);
});

test('a staff member signing in lands in their portal, not the owner\'s login', async () => {
  // The bug this exists to stop: /tips/start hands out the portal cookie and
  // redirects to /portal, and /portal was not on the open list. So on the host
  // — where APP_PASSWORD is set, unlike every developer machine — a cook
  // entering their PIN was bounced to the owner's password screen. The PIN was
  // correct. The portal was working. They simply could not get to it.
  const start = await post('/tips/start', { pin: '5150' });
  assert.strictEqual(start.status, 302, 'the PIN is accepted');
  assert.strictEqual(start.headers.get('location'), '/portal', 'and sends them to their portal');

  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  const home = await fetch(BASE + '/portal', { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(home.status, 200, 'which opens — no manager password in the way');
  assert.match(await home.text(), /Rosa/, 'and it is hers');

  // Every other door of theirs, too. A staff member who can reach the hub but
  // not their own pay has been half-let-in.
  for (const p of ['/portal/earnings', '/portal/specials', '/portal/stock']) {
    const res = await fetch(BASE + p, { headers: { cookie }, redirect: 'manual' });
    assert.strictEqual(res.status, 200, `${p} opens for signed-in staff`);
  }
});

test('opening the portal to staff did not open it to the world', async () => {
  // /portal is exempt from the owner's password. That is only safe because
  // each route demands the signed PIN cookie for itself — so with no cookie,
  // every one of them must send you to the PIN screen and show nothing.
  for (const p of ['/portal', '/portal/earnings', '/portal/specials', '/portal/stock']) {
    const res = await get(p);
    assert.strictEqual(res.status, 302, `${p} is not served to a stranger`);
    assert.match(res.headers.get('location') || '', /^\/tips/,
      `${p} sends them to the PIN screen, not the owner's login`);
  }
  // A forged cookie is not a cookie.
  const forged = 'zwin_portal=1.' + (Date.now() + 8.64e7) + '.deadbeefdeadbeefdeadbeefdeadbeef';
  const res = await fetch(BASE + '/portal/earnings', { headers: { cookie: forged }, redirect: 'manual' });
  assert.strictEqual(res.status, 302, 'a signature that does not check out gets nothing');
});

test('every route under /portal asks who you are', async () => {
  // /portal is exempt from the manager password (OPEN_PATHS), for the whole
  // prefix. That is only safe if each route demands the PIN cookie itself — so
  // rather than grep the source for requirePortal (which misses a route that
  // delegates to a shared handler), hit every one of them with no cookie and
  // insist it turns you away to the PIN screen and serves nothing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const routes = [...src.matchAll(/^app\.(get|post)\('(\/portal[^']*)'/gm)]
    .map((m) => [m[1], m[2]])
    // A route with a :param needs a real value to hit; the id ones all take one.
    .map(([verb, route]) => [verb, route.replace(/:\w+/g, '1')]);
  assert.ok(routes.length >= 6, `found ${routes.length} portal routes — the scan should see them all`);

  for (const [verb, route] of routes) {
    const res = await fetch(BASE + route, {
      method: verb.toUpperCase(), redirect: 'manual',
      headers: verb === 'post' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
    });
    assert.strictEqual(res.status, 302, `${verb.toUpperCase()} ${route} must not serve a stranger`);
    assert.match(res.headers.get('location') || '', /^\/(tips|portal)/,
      `${verb.toUpperCase()} ${route} sends them to the PIN screen, not the owner's login`);
  }
});

test('the version check staff pages rely on is reachable', async () => {
  const res = await get('/version');
  assert.strictEqual(res.status, 200);
  assert.ok((await res.json()).build, 'returns a build stamp');
});

test('manager pages stay behind the password', async () => {
  for (const p of ['/', '/payroll', '/employees', '/shifts', '/positions', '/email']) {
    const res = await get(p);
    assert.strictEqual(res.status, 302, `${p} should redirect to login`);
    assert.match(res.headers.get('location') || '', /^\/login/, `${p} redirects to /login`);
  }
});

test('manager POSTs are refused without the password', async () => {
  const res = await post('/employees', { name: 'Should Not Exist', role: 'server' });
  assert.strictEqual(res.status, 401);
  const { db } = require('../src/db');
  const found = db.prepare('SELECT COUNT(*) n FROM employees WHERE name = ?').get('Should Not Exist').n;
  assert.strictEqual(found, 0, 'blocked POST must not write anything');
});

// --- user accounts, roles and per-area access -------------------------------
// Access control is worth testing precisely because it fails silently: a page
// that should be blocked and isn't looks completely normal to whoever opens it.

const { users } = require('../src/db');

async function login(body) {
  const res = await post('/login', body);
  const c = res.headers.get('set-cookie') || '';
  return (c.match(/rc_auth=([^;]*)/) || [])[1] || '';
}
const as = (cookie, p, opts = {}) => fetch(BASE + p, {
  ...opts, redirect: 'manual', headers: { cookie: `rc_auth=${cookie}`, ...(opts.headers || {}) },
});

test('a view-only account can open its areas and is refused every write', async () => {
  users.byEmail.get('viewer@test.local') && users.del.run(users.byEmail.get('viewer@test.local').id);
  const owner = await login({ password: 'test-manager-password' });
  await as(owner, '/users', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['name', 'Read Only'], ['email', 'viewer@test.local'],
      ['password', 'viewer-password-1'], ['role', 'viewer'],
      ['features', 'dashboard'], ['features', 'sales']]).toString(),
  });
  const v = await login({ email: 'viewer@test.local', password: 'viewer-password-1' });
  assert.ok(v, 'the account can sign in');

  assert.strictEqual((await as(v, '/')).status, 200, 'dashboard allowed');
  assert.strictEqual((await as(v, '/sales')).status, 200, 'sales allowed');
  assert.strictEqual((await as(v, '/payroll')).status, 403, 'payroll withheld');
  // Menu costing exposes recipe costs and supplier pricing. It shipped
  // unlisted in FEATURES, which meant every signed-in account could read it.
  assert.strictEqual((await as(v, '/menu')).status, 403, 'menu costing withheld');
  assert.strictEqual((await as(v, '/employees')).status, 403, 'staff withheld');
  assert.strictEqual((await as(v, '/users')).status, 403, 'cannot reach user admin');

  // View-only means view-only even on a page they ARE allowed to open.
  const write = await as(v, '/sales/1', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'food=999999',
  });
  assert.strictEqual(write.status, 403, 'writes refused');
});

/**
 * A capital letter is not a key.
 *
 * Express matches routes case-insensitively unless told otherwise, and the area
 * gate does not: areaFor() compares req.path against lowercase prefixes, so
 * /Payroll matched no area — and canSee() treats "no area" as open. Every
 * restricted page in the app was reachable by capitalising one letter, verified
 * against a real staff-only account: payroll, sales, cash, performance, menu
 * costing, invoices, settings, and user administration.
 *
 * Two locks now. The router is case-sensitive, and areaFor lowercases before
 * matching, so neither one being wrong on its own reopens it. This test walks
 * every area rather than the handful somebody thought to try.
 */
/**
 * The schedule board shows what the week will COST — each person's planned
 * wages on their row, and the week's total in the summary bar.
 *
 * Schedule and Payroll are separate feature keys on purpose: a shift lead can
 * be trusted with the roster without being shown what everybody earns. So the
 * money is gated on Payroll while the board itself is gated on Schedule, and
 * this is the assertion that keeps those apart.
 *
 * It lives here because permissions only bite when somebody is signed in, and
 * this is the only file that runs with APP_PASSWORD set. A test that renders
 * the board with no user proves nothing about what a shift lead can see.
 */
test('planned wages on the schedule board need Payroll, not just Schedule', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const mk = async (email, feats) => {
    const old = users.byEmail.get(email);
    if (old) users.del.run(old.id);
    await as(owner, '/users', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['name', 'Pay ' + feats.join('-')], ['email', email],
        ['password', 'pay-password-1'], ['role', 'editor'],
        ['features', 'dashboard'], ...feats.map((f) => ['features', f])]).toString(),
    });
    return login({ email, password: 'pay-password-1' });
  };

  const rosterOnly = await mk('paysched@test.local', ['schedule']);
  const both = await mk('paysched2@test.local', ['schedule', 'payroll']);

  const r1 = await as(rosterOnly, '/schedule');
  assert.strictEqual(r1.status, 200, 'the board still opens for a shift lead');
  const h1 = await r1.text();
  assert.doesNotMatch(h1, /sb-pay/, 'but carries no per-person wage figure');
  assert.doesNotMatch(h1, /Planned wages/, 'and no week total');
  // The board itself is intact — this is a withheld column, not a broken page.
  assert.match(h1, /sb-sum-c/, 'the summary bar is still there');

  const r2 = await as(both, '/schedule');
  assert.strictEqual(r2.status, 200);
  const h2 = await r2.text();
  assert.match(h2, /Planned wages/, 'payroll authority sees the week total');
});

test('a restricted account cannot reach an area by changing the case of the path', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const existing = users.byEmail.get('case@test.local');
  if (existing) users.del.run(existing.id);
  await as(owner, '/users', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['name', 'Case Test'], ['email', 'case@test.local'],
      ['password', 'case-password-1'], ['role', 'editor'],
      ['features', 'dashboard'], ['features', 'staff']]).toString(),
  });
  const u = await login({ email: 'case@test.local', password: 'case-password-1' });
  assert.ok(u, 'the account signs in');

  // Every area this account was NOT given, in three spellings each.
  const withheld = ['/payroll', '/sales', '/cash', '/costs', '/menu', '/c/invoices', '/settings', '/users'];
  for (const p of withheld) {
    const variants = [p, '/' + p.slice(1, 2).toUpperCase() + p.slice(2), p.toUpperCase()];
    for (const v of variants) {
      const r = await as(u, v);
      assert.notStrictEqual(r.status, 200, `${v} must not be readable (spelling of ${p})`);
    }
  }
  // And the areas it DOES hold still open, so the lock did not seize shut.
  for (const p of ['/', '/employees', '/staff-portal', '/timeclock']) {
    assert.strictEqual((await as(u, p)).status, 200, `${p} stays open`);
  }
});

/**
 * Today and Timesheets share one workspace but not one permission.
 *
 * Approving, locking, reopening, returning and TRANSFERRING hours to payroll are
 * payroll authority, and for a long time the only thing enforcing that was the
 * URL these routes sit on — the middleware matches req.path and the routes
 * themselves checked only canWrite(). That was fine while the page stood alone.
 * It stops being fine once the two pages wear one tab strip and somebody is
 * tempted to move a route, so the check now lives on the route.
 *
 * Asserted with real signed-in accounts rather than by grepping the source: a
 * grep cannot tell an area check from the absence of one.
 */
test('the two Time Clock tabs are gated separately, and the strip hides what you cannot open', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const mk = async (email, feature) => {
    const old = users.byEmail.get(email);
    if (old) users.del.run(old.id);
    await as(owner, '/users', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['name', 'Tab ' + feature], ['email', email],
        ['password', 'tab-password-1'], ['role', 'editor'],
        ['features', 'dashboard'], ['features', feature]]).toString(),
    });
    return login({ email, password: 'tab-password-1' });
  };

  const staffOnly = await mk('tabstaff@test.local', 'staff');
  const payOnly = await mk('tabpay@test.local', 'payroll');

  assert.strictEqual((await as(staffOnly, '/timeclock')).status, 200, 'staff opens Today');
  assert.strictEqual((await as(staffOnly, '/payroll/timesheets')).status, 403, 'and not Timesheets');
  assert.strictEqual((await as(payOnly, '/payroll/timesheets')).status, 200, 'payroll opens Timesheets');
  assert.strictEqual((await as(payOnly, '/timeclock')).status, 403, 'and not Today');

  // The tab it cannot open is absent, not broken. One tab is not a tab strip.
  const today = await (await as(staffOnly, '/timeclock')).text();
  assert.ok(!today.includes('href="/payroll/timesheets"'),
    'a staff-only account is not offered a link that answers 403');

  // Every write route, not just the pages. This is the one that matters: these
  // are the actions that move hours into payroll.
  for (const path of ['/payroll/timesheets/1/approve', '/payroll/timesheets/approve-all',
    '/payroll/timesheets/1/lock', '/payroll/timesheets/1/reopen',
    '/payroll/timesheets/1/transfer', '/payroll/timesheets/1/return']) {
    const r = await as(staffOnly, path, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'period=2026-01-01',
    });
    assert.strictEqual(r.status, 403, `${path} is refused for a staff-only editor`);
  }

  // The other direction. A payroll reviewer has to be able to READ the punch
  // that is blocking a timesheet — refusing them the page made the blocker
  // unopenable, a dead end at the exact moment somebody needs to act. Reading a
  // punch is not the same as gaining the floor manager's job, and it is
  // certainly not the same as gaining approval authority, which they already had.
  const { db: adb } = require('../src/db');
  const anyEntry = adb.prepare('SELECT id FROM time_entries LIMIT 1').get();
  if (anyEntry) {
    assert.strictEqual((await as(payOnly, `/timeclock/${anyEntry.id}`)).status, 200,
      'payroll can open the punch behind a timesheet it reviews');
  }
  // But the time-clock LIST is still the staff area's own page.
  assert.strictEqual((await as(payOnly, '/timeclock')).status, 403, 'and gains nothing else by it');
});

// The dashboard pulls from every module at once, so it is the one page where
// a permissions mistake shows up as content rather than as a 403 — a viewer
// would just see payroll and cost figures on their home page and never know
// they weren't supposed to.
test('the dashboard shows nothing from areas the account cannot open', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const existing = users.byEmail.get('dash@test.local');
  if (existing) users.del.run(existing.id);
  await as(owner, '/users', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['name', 'Dash Viewer'], ['email', 'dash@test.local'],
      ['password', 'dash-password-1'], ['role', 'viewer'],
      ['features', 'dashboard'], ['features', 'shifts']]).toString(),
  });
  const v = await login({ email: 'dash@test.local', password: 'dash-password-1' });
  // finally, not a trailing line: a failed assertion would otherwise leave the
  // account sitting in the real database until someone noticed it.
  try {
    const res = await as(v, '/');
    assert.strictEqual(res.status, 200, 'dashboard itself is allowed');
    const html = await res.text();

    // The attention list is headed by its severity kickers now, not by a
    // section title. CRITICAL only renders when there is something critical,
    // so the stable marker is the column itself.
    assert.ok(html.includes('bs-cols3'), 'still gets the sections it may see');
    // A section only counts as withheld if an owner actually gets it —
    // otherwise the assertion passes because the string was renamed and stops
    // testing anything. These are checked against the owner's page below.
    const ownerHtml = await (await as(owner, '/')).text();
    for (const withheld of ['The week in numbers']) {
      assert.ok(ownerHtml.includes(withheld), `${withheld} must exist for an owner, or this proves nothing`);
      assert.ok(!html.includes(withheld), `${withheld} must not render for a viewer`);
    }
    // Shift takings belong to whoever runs the floor. What the food costs and
    // what the business keeps do not, and they travel together in the
    // snapshot — so they are checked by name, not by section heading.
    for (const figure of ['Food cost', 'Prime cost', 'Gross profit', 'Invoices this week']) {
      assert.ok(!html.includes(figure), `${figure} is a costs figure and must not reach a shifts viewer`);
    }
    // Quick actions are writes; a view-only account gets none of them at all.
    assert.ok(!html.includes('class="qact"'), 'no write shortcuts for a viewer');
    // And nothing from the trackers/payroll/cash areas leaks into the lists.
    for (const leak of ['/c/invoices', '/c/recurring', '/c/products', '/payroll', '/cash']) {
      assert.ok(!html.includes(`href="${leak}"`), `must not link to ${leak}`);
    }
  } finally {
    const owned = users.byEmail.get('dash@test.local');
    if (owned) users.del.run(owned.id);
  }
});

test('an owner does see the full dashboard', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const html = await (await as(owner, '/')).text();
  // Today is a strip of notices rather than a headed section, so it is checked
  // by the notice markup. "Upcoming" is now "Coming up" and only renders when
  // something is actually due; Insights moved to Performance. "The record" was
  // replaced by the floor: shortages surface in Needs attention and today's
  // specials get their own board — both only render when there is data, so they
  // are not asserted unconditionally here.
  for (const section of ['File an entry', 'The week in numbers', 'Last service']) {
    assert.ok(html.includes(section), `${section} renders for the owner`);
  }
  assert.match(html, /id="bs-bb"/, 'and the billboard');
});

// A view-only account being refused a write is correct. Being *offered* the
// write first is not: someone signed in as a viewer, picked an invoice,
// waited for it to be read, and got an error blaming the file. The server did
// its job — it was the page that shouldn't have asked.
test('a view-only account is not offered writes it cannot perform', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const gone = users.byEmail.get('ro@test.local');
  if (gone) users.del.run(gone.id);
  await as(owner, '/users', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['name', 'Read Only Two'], ['email', 'ro@test.local'],
      ['password', 'ro-password-1'], ['role', 'viewer'],
      ['features', 'dashboard'], ['features', 'shifts'], ['features', 'trackers'],
      ['features', 'cash']]).toString(),
  });
  const v = await login({ email: 'ro@test.local', password: 'ro-password-1' });
  try {
    for (const path of ['/c/invoices', '/c/products', '/c/vendors', '/c/recurring',
      '/c/expirations', '/c/contacts', '/shifts']) {
      const res = await as(v, path);
      assert.strictEqual(res.status, 200, `${path} is readable`);
      const html = await res.text();
      // Everything that opens or submits a write.
      for (const trap of ['invDrawer(true)', 'prodDrawer(true)', 'vDrawer(true)',
        'rcDrawer(true)', 'class="add-panel"', 'Save invoice', 'Mark done']) {
        assert.ok(!html.includes(trap), `${path} still offers "${trap}" to a viewer`);
      }
      // The standing notice is a bs-notice-bar now, same job, one shape for
      // every message the app puts in front of you.
      assert.match(html, /bs-notice-k">View only</, `${path} says the account is view-only`);
    }

    // And the upload endpoint refuses in a way the page can explain, rather
    // than returning something that blows up JSON.parse on the client.
    const refused = await as(v, '/c/invoices/read', { method: 'POST' });
    assert.strictEqual(refused.status, 403);
    assert.match(await refused.text(), /view-only/i, 'says why, so the UI can too');
  } finally {
    const row = users.byEmail.get('ro@test.local');
    if (row) users.del.run(row.id);
  }
});

test('the owner still gets every write control', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const html = await (await as(owner, '/c/invoices')).text();
  // The control moved from a drawer to the capture overlay; what matters is
  // that a writer is offered a way in and the overlay is actually on the page.
  assert.ok(html.includes('capOpen()'), 'upload is offered');
  assert.ok(html.includes('data-cap'), 'and the overlay it opens is rendered');
  assert.ok(!/bs-notice-k">View only</.test(html), 'and no view-only notice');
});

test('disabling an account revokes it immediately, not at cookie expiry', async () => {
  const v = await login({ email: 'viewer@test.local', password: 'viewer-password-1' });
  assert.strictEqual((await as(v, '/sales')).status, 200);

  const row = users.byEmail.get('viewer@test.local');
  users.setActive.run(0, row.id);
  // Same cookie: still correctly signed, still unexpired. Access is gone
  // because the account is re-checked on every request.
  assert.strictEqual((await as(v, '/sales')).status, 302, 'bounced to login');

  users.setActive.run(1, row.id);
  assert.strictEqual((await as(v, '/sales')).status, 200, 're-enabling restores it');
  users.del.run(row.id);
});

test('a wrong password is refused, and a forged cookie gets nothing', async () => {
  assert.strictEqual(await login({ email: 'viewer@test.local', password: 'wrong' }), '');
  const forged = '1.' + (Date.now() + 8.64e7) + '.deadbeefdeadbeefdeadbeefdeadbeef';
  assert.strictEqual((await as(forged, '/payroll')).status, 302, 'forged token rejected');
});

// ---------------------------------------------------------------------------
// The sign-in page's appearance, and the stylesheet it depends on.
//
// /login was the last screen still on the old look — a white card with a 20px
// radius and a drop shadow, floating on solid blue — and it was the only thing
// still holding the `.tips-*` rules alive. Moving it onto the staff portal's
// shell made those rules dead, and deleting dead CSS is where the damage
// happens: an earlier attempt at exactly this deleted rules the page still
// needed, and the check that was supposed to catch it was written wrong and
// reported nothing either way.
//
// So the guard is the honest direction: whatever these pages emit must have a
// rule somewhere in the stylesheets they load.
// ---------------------------------------------------------------------------

/** Every class name that has at least one rule across the linked stylesheets. */
function styledClasses() {
  const css = ['styles.css', 'broadsheet.css', 'staff.css']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')).join('\n');
  // Comments blanked length-preserving, so a comment can never read as a
  // selector — that mistake is what deleted live rules the first time.
  const noc = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const out = new Set();
  for (const rule of noc.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const sel = rule[1].trim();
    if (!sel) continue;
    for (const c of sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)) out.add(c[1]);
  }
  return out;
}

/** Classes in the markup, ignoring <script> bodies — a class attribute built
 *  from a template literal is not a class, and counting it as one produces
 *  nonsense like `.'+(out?'out':'in')+'`. */
function emittedClasses(html) {
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const out = new Set();
  for (const m of markup.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

test('the sign-in page is on the broadsheet shell, not the old card', async () => {
  const html = await (await get('/login')).text();
  assert.match(html, /<div class="tp">/, 'the staff portal shell');
  assert.match(html, /class="tp-h">Sign in\./, 'a serif headline');
  assert.match(html, /class="tp-go"[^>]*form="signin"/, 'a full-width button reaching the form by id');
  for (const dead of ['tips-screen', 'tips-card', 'tips-title', 'tips-lead', 'tips-error',
    'tips-field', 'tips-in', 'tips-hint', 'tips-submit']) {
    assert.ok(!emittedClasses(html).has(dead), `.${dead} is gone from the markup`);
  }
});

test('the old sign-in styles are gone from the stylesheet too', () => {
  // Left behind, they are 11 rules nothing can ever match, and the next person
  // reading styles.css has to work out which of two sign-in designs is live.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(!/\.tips-/.test(css), 'no .tips-* rules remain');
});

test('every custom property a stylesheet uses is one it defines', async () => {
  // How this got written: .pa-bar.out and .pa-bar.urgent were painted
  // var(--negative), and no stylesheet has ever defined --negative. The real
  // name is --danger. An undefined custom property does not fail loudly — the
  // declaration is simply dropped — so the red bar on the most urgent rows
  // rendered as nothing at all, and only the amber ones (a literal) showed.
  // Twelve rules across the app were painting with it, including every
  // "Delete" link. Everything looked deliberate.
  // The two sheets the whole app renders through. styles.css is the pre-
  // broadsheet one, still loaded for the handful of pages not yet ported, and
  // it has its own undefined names in rules that may already be dead —
  // untangling that means judging old CSS, not guarding new.
  const files = ['broadsheet.css', 'staff.css'];
  const css = files.map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')).join('\n');
  // Some properties are legitimately set by the markup on the element itself.
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  const defined = new Set([
    ...[...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]),
    ...[...server.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  ]);
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));
  // A var() with a fallback still renders if the property is missing, so those
  // are not broken — they are the one legitimate way to name something unset.
  const withFallback = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\s*,/gi)].map((m) => m[1]));

  const missing = [...used].filter((v) => !defined.has(v) && !withFallback.has(v));
  assert.deepStrictEqual(missing, [],
    `painted with properties nothing defines: ${missing.join(', ')}`);
});

test('every class the staff-facing pages emit has a rule behind it', async () => {
  // Scoped to the two pages this change touched. The rest of the app has a
  // handful of long-standing unstyled classes; widening this test would mean
  // fixing those, which is a different job.
  const styled = styledClasses();
  const pages = ['/login', '/login?bad=1', '/tips'];
  const bare = [];
  let seen = 0;
  for (const p of pages) {
    const res = await get(p);
    assert.strictEqual(res.status, 200, `${p} renders`);
    const emitted = emittedClasses(await res.text());
    assert.ok(emitted.size > 8, `${p} emitted ${emitted.size} classes`);
    seen += emitted.size;
    for (const c of emitted) if (!styled.has(c)) bare.push(`${p}: .${c}`);
  }
  assert.ok(seen > 40, `checked ${seen} class uses`);
  assert.deepStrictEqual(bare, [], 'a class with no rule means CSS was deleted that a page still needs');
});

test('signing in still works, and still cannot be pointed off-site', async () => {
  // The markup changed; the handler did not. Proving that is the point.
  const bad = await post('/login', { password: 'wrong', next: '/payroll' });
  assert.strictEqual(bad.status, 302);
  assert.match(bad.headers.get('location'), /^\/login\?bad=1/, 'back to the form, flagged');
  assert.ok(!(bad.headers.get('set-cookie') || '').includes('rc_auth='), 'and no session handed out');

  const ok = await post('/login', { password: 'test-manager-password', next: '/payroll' });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.headers.get('location'), '/payroll', 'sent where you were going');
  assert.match(ok.headers.get('set-cookie') || '', /rc_auth=/, 'with a session');

  const away = await post('/login', { password: 'test-manager-password', next: 'https://evil.example' });
  assert.strictEqual(away.headers.get('location'), '/', 'an off-site next is ignored');
});

test('the login screen installs the manager app, not the tip form', async () => {
  // /login is rendered "bare" — no app chrome — and that flag was also being
  // read as "this is the staff portal", so it served manifest-tips, whose
  // start_url is /tips. Adding the login screen to a home screen produced a
  // shortcut that opened the tip form. This only shows up where APP_PASSWORD
  // is set, which is why it lives here.
  const html = await (await get('/login')).text();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/,
    'the manager manifest, so the shortcut opens the dashboard');
  assert.ok(!/manifest-tips/.test(html), 'not the staff one');
  assert.match(html, /apple-mobile-web-app-title" content="ZWIN"/, 'and it is named ZWIN on the home screen');
});

test('the login screen loads the stylesheet its markup depends on', async () => {
  // This shipped broken. Splitting `bare` from `staff` fixed /login installing
  // as the tip form, but the stylesheet was keyed on the new flag — and
  // /login is bare without being staff, so it lost staff.css entirely and
  // rendered as raw browser defaults on a navy background.
  //
  // The whole suite stayed green through it, because every assertion asked
  // what the markup SAID and none asked whether the page could be seen. A page
  // that emits classes with no stylesheet behind them is a broken page.
  const html = await (await get('/login')).text();

  const sheets = [...html.matchAll(/href="\/static\/([a-z-]+\.css)/g)].map((m) => m[1]);
  const classes = new Set();
  for (const m of html.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }

  // Every class the page emits must be defined in a sheet the page loads.
  const css = sheets
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const orphans = [...classes].filter((c) => !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}(?![\\w-])`).test(css));

  assert.ok(classes.size > 5, `the page emits ${classes.size} classes`);
  assert.deepStrictEqual(orphans, [],
    `these classes have no rule in any stylesheet the page loads (${sheets.join(', ')})`);
});

// ===========================================================================
// Uploads, where the token arrives late.
//
// This file is the only one that runs with APP_PASSWORD set, which is the only
// configuration where CSRF is live — with no password there is no session to
// derive a token from and the whole check stands down. That is exactly why the
// bug below reached the owner and not the test suite.
//
// express.urlencoded and express.json are global and have run by the time the
// CSRF middleware sees a request, so an ordinary post has its fields. multipart
// does not: it is parsed by multer, which is ROUTE middleware and runs after.
// So on every upload req.body was empty at check time, the token the form
// carried was invisible, and the same-site rule refused it. Every receipt,
// every invoice, every document. The page sat on "Saving…" and then showed a
// bare refusal, and nothing reached the database — including the notification
// that a save would have raised, which is why the back office went quiet.
// ===========================================================================

const receipt = () => new Blob([Buffer.from('not really a jpeg')], { type: 'image/jpeg' });

async function tokenOn(cookie, page) {
  const html = await (await as(cookie, page)).text();
  return (html.match(/name="_csrf" value="([a-f0-9]{32})"/) || [])[1];
}

test('an upload saves, with the token its form was drawn with', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const token = await tokenOn(owner, '/c/expenses');
  assert.ok(token, 'the expenses page stamps its forms');

  const fd = new FormData();
  fd.set('_csrf', token);
  fd.set('spent_on', '2026-07-29');
  fd.set('name', 'Coffee filters');
  fd.set('where_bought', 'Restaurant Depot');
  fd.set('category', 'Supplies');
  fd.set('amount_cents', '18.40');
  fd.set('paid_by', 'Rosa');
  fd.set('paid_with', 'Their own money');
  fd.set('file', receipt(), 'receipt.jpg');

  const res = await as(owner, '/c/expenses', { method: 'POST', body: fd, headers: { origin: BASE } });
  assert.strictEqual(res.status, 302, 'it saves');
  assert.match(res.headers.get('location') || '', /Saved/, 'and says so');
});

test('and the row is really on the page — a 302 saying "Saved" is not proof', async () => {
  // This used to assert the "Rosa is owed $18.40" notification, which was the
  // observable proving the write actually landed. That notification was
  // deliberately removed (it fired on nearly every expense), so the proof moves
  // to the record itself.
  //
  // The regression it guards is unchanged and worth keeping: while uploads were
  // being refused by the duplicate-CSRF-token bug, the POST still redirected
  // with "Saved" and nothing was written. A status code and a flash message say
  // the same thing whether or not a row exists — only the row settles it.
  const owner = await login({ password: 'test-manager-password' });
  const html = await (await as(owner, '/c/expenses')).text();
  assert.match(html, /Coffee filters/, 'the expense that was uploaded is listed');
  assert.match(html, /18\.40/, 'with the amount it was filed for');
});

test('an upload from another site is still refused', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const token = await tokenOn(owner, '/c/expenses');
  const fd = new FormData();
  fd.set('_csrf', token);
  fd.set('spent_on', '2026-07-29'); fd.set('name', 'Forged');
  fd.set('category', 'Supplies'); fd.set('amount_cents', '1'); fd.set('paid_by', 'x');
  fd.set('file', receipt(), 'r.jpg');
  const res = await as(owner, '/c/expenses',
    { method: 'POST', body: fd, headers: { origin: 'https://evil.example' } });
  assert.strictEqual(res.status, 403, 'refused on where it came from, before the body is even read');
});

test('an upload with no token at all is still refused', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const fd = new FormData();
  fd.set('spent_on', '2026-07-29'); fd.set('name', 'No token');
  fd.set('category', 'Supplies'); fd.set('amount_cents', '1'); fd.set('paid_by', 'x');
  fd.set('file', receipt(), 'r.jpg');
  const res = await as(owner, '/c/expenses', { method: 'POST', body: fd, headers: { origin: BASE } });
  assert.strictEqual(res.status, 403, 'deferring the check must not mean skipping it');
});

test('every route that takes an upload also checks the token after it', () => {
  // The deferral is only safe if the second half actually runs. A route that
  // adds a multer and forgets csrfBody has no CSRF protection at all beyond the
  // Origin header — so this fails the build rather than waiting to be noticed.
  for (const file of ['server.js', 'modules.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    for (const m of src.matchAll(/app\.post\((.+?)=>/g)) {
      const line = m[1];
      if (!/\.(array|single|fields|any|none)\(/.test(line)) continue;   // not an upload
      assert.match(line, /csrfBody/,
        `src/${file}: this upload route parses a body multer put there, but never checks the token `
        + `that arrived with it — add csrfBody after the multer: ${line.slice(0, 90)}`);
    }
  }
});

test('a form built in script carries the token too', () => {
  // Three separate outages came from the same blind spot: the token is injected
  // into the HTML that is SERVED, so anything that posts without a form tag in
  // that HTML gets nothing. fetch() is handled by the wrapper. A form built with
  // createElement is not — and form.submit() skips submit listeners by design,
  // so it cannot be caught at the edge either. It has to add the field itself.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  for (const m of src.matchAll(/createElement\('form'\)/g)) {
    const after = src.slice(m.index, m.index + 1400);
    assert.match(after, /_csrf/,
      'a form is built in script here and submitted without a token — add '
      + "add('_csrf', window.__csrf) — near: " + after.slice(0, 120).replace(/\s+/g, ' '));
  }
});

test('claiming to be an upload does not turn the token check off', () => {
  // The deferral was keyed on the CALLER'S Content-Type. Deferring is a one-way
  // door — the global check steps aside and only csrfBody picks it back up, and
  // csrfBody runs on the seven upload routes. So setting one header on any of
  // the other hundred-odd POSTs meant the token was never checked by anybody:
  // deleting invoices, deactivating staff, approving timesheets, all of it.
  //
  // It is keyed on the PATH now. This asserts the list is a list of real upload
  // routes and nothing else, which is the property that makes that safe.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const block = src.slice(src.indexOf('const CSRF_UPLOAD = ['), src.indexOf('];', src.indexOf('const CSRF_UPLOAD = [')));
  const patterns = block.split('\n')
    .map((l) => l.trim().replace(/\s*\/\/.*$/, '').replace(/,$/, ''))   // drop trailing comments
    .filter((l) => l.startsWith('/^'));
  assert.ok(patterns.length >= 5, `the upload list has entries, got ${patterns.length}`);
  for (const p of patterns) {
    assert.match(p, /^\/\^.*\$\/$/, `"${p}" is not anchored at both ends`);
  }

  // The property that makes deferring safe: every route that takes a file is
  // covered, so its check really does reach csrfBody. Built by running the
  // actual patterns against the actual route paths, rather than comparing
  // strings and hoping the two spellings agree.
  const live = patterns.map((p) => new RegExp(p.slice(1, -1)));
  const withMulter = [...src.matchAll(/app\.post\('([^']+)'[^)]*?\.(?:array|single|fields|any|none)\(/g)]
    .map((m) => m[1]);
  assert.ok(withMulter.length >= 4, `found the upload routes, got ${withMulter.length}`);
  for (const p of withMulter) {
    const sample = p.replace(/:[^/]+/g, 'x');       // /c/:slug/:id -> /c/x/x
    assert.ok(live.some((re) => re.test(sample)),
      `${p} takes an upload but no CSRF_UPLOAD entry matches it, so its token check is deferred to nobody`);
  }
});

test('an upload path that is not an upload route is refused without a token', async () => {
  // The live half of the same thing: a delete route, called with a multipart
  // body and no token, the way the bypass did it.
  const owner = await login({ password: 'test-manager-password' });
  const fd = new FormData();
  fd.set('x', '1');
  const res = await as(owner, '/employees/999999/toggle',
    { method: 'POST', body: fd, headers: { origin: BASE } });
  assert.strictEqual(res.status, 403,
    'a multipart body on a route with no multer must get the ordinary check, not a free pass');
});

// ===========================================================================
// Owner-only board and note routes: who may actually write to them.
//
// portalGuard() reads `canWrite() && navAllowed('/staff-portal')`, and BOTH of
// those return true when there is no back-office user at all — `!u` is the
// first thing each of them checks. Read alone, the guard grants everything.
//
// It is not what stops anybody: /staff-portal is absent from OPEN_PATHS, so
// the global gate at src/server.js:558 refuses the request before the route is
// reached. These tests assert the SYSTEM, not the helper, because the system
// is what a staff member actually meets — and they would catch it if somebody
// later added /staff-portal to OPEN_PATHS believing portalGuard had it covered.
// ===========================================================================

/** A signed-in employee — a portal cookie, which is not a back-office session. */
async function staffCookie(pin) {
  const r = await post('/tips/start', { pin });
  const c = (r.headers.get('set-cookie') || '').split(';')[0];
  assert.match(c, /^zwin_portal=/, 'a portal session, not an owner one');
  return c;
}

const OWNER_WRITES = [
  ['create a special', '/staff-portal/special', { name: 'Forged dish', price: '12.00' }],
  ['86 something outright', '/staff-portal/special/86-item', { name: 'Forged 86' }],
  ['edit a special', '/staff-portal/special/1/edit', { name: 'Renamed' }],
  ['86 a special', '/staff-portal/special/1/86', { note: 'gone' }],
  ['restore a special', '/staff-portal/special/1/back', {}],
  ['delete a special', '/staff-portal/special/1/delete', {}],
  ['resolve a stock report', '/staff-portal/stock/1/resolve', { resolution: 'ordered' }],
  ['reopen a stock report', '/staff-portal/stock/1/reopen', {}],
  ['post a before-shift note', '/staff-portal/note', { title: 'Forged note' }],
  ['delete a before-shift note', '/staff-portal/note/1/delete', {}],
];

test('an anonymous request cannot write to any owner board or note route', async () => {
  for (const [what, path, body] of OWNER_WRITES) {
    const r = await post(path, body);
    assert.ok(r.status === 401 || r.status === 403,
      `anonymous cannot ${what} — got ${r.status}`);
  }
});

test('a signed-in employee cannot write to any owner board or note route', async () => {
  // The case that matters: somebody with a real, valid session — just not the
  // owner's. A portal cookie is not a back-office user, so currentUser(req) is
  // null and the global gate answers before portalGuard is ever consulted.
  const cookie = await staffCookie('5150');
  for (const [what, path, body] of OWNER_WRITES) {
    const r = await fetch(BASE + path, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    assert.ok(r.status === 401 || r.status === 403,
      `an employee cannot ${what} — got ${r.status}`);
  }
});

test('and nothing was created by any of those attempts', async () => {
  const w = new (require('better-sqlite3'))(DB, { readonly: true });
  const specials = w.prepare("SELECT COUNT(*) n FROM portal_specials WHERE name LIKE 'Forged%'").get().n;
  const notes = w.prepare("SELECT COUNT(*) n FROM portal_notes WHERE title LIKE 'Forged%'").get().n;
  w.close();
  assert.strictEqual(specials, 0, 'no forged special exists');
  assert.strictEqual(notes, 0, 'no forged note exists');
});

test('the owner CAN do each of those things', async () => {
  // The other half: proving the gate is a gate and not a wall. Signing in with
  // the password is what legitimate admin access looks like today.
  const login = await post('/login', { password: 'test-manager-password' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'the owner gets a session');

  const owner = (path, body) => fetch(BASE + path, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  const mk = await owner('/staff-portal/special', { name: 'Owner dish', price: '9.50' });
  assert.ok(mk.status < 400, `owner can post a special — got ${mk.status}`);
  const note = await owner('/staff-portal/note', { title: 'Owner note', body: 'Hello' });
  assert.ok(note.status < 400, `owner can post a note — got ${note.status}`);

  const w = new (require('better-sqlite3'))(DB, { readonly: true });
  const sp = w.prepare("SELECT id FROM portal_specials WHERE name = 'Owner dish'").get();
  const nt = w.prepare("SELECT id FROM portal_notes WHERE title = 'Owner note'").get();
  w.close();
  assert.ok(sp, 'the special is really there');
  assert.ok(nt, 'and the note');

  for (const [what, path, body] of [
    ['86 it', `/staff-portal/special/${sp.id}/86`, { note: 'sold out' }],
    ['restore it', `/staff-portal/special/${sp.id}/back`, {}],
    ['edit it', `/staff-portal/special/${sp.id}/edit`, { name: 'Owner dish v2', price: '10.00' }],
    ['delete it', `/staff-portal/special/${sp.id}/delete`, {}],
    ['delete the note', `/staff-portal/note/${nt.id}/delete`, {}],
  ]) {
    const r = await owner(path, body);
    assert.ok(r.status < 400, `owner can ${what} — got ${r.status}`);
  }
});

// --- the hardening itself ---------------------------------------------------

test('a read-only back-office account cannot write to the board either', async () => {
  // The third actor. Both layers refuse a viewer on a non-GET now: the global
  // gate on the verb, and mayManagePortal on `user.role`.
  const w = new (require('better-sqlite3'))(DB);
  try {
    w.prepare(`INSERT OR IGNORE INTO users (name, email, pass_hash, role, features, active)
               VALUES ('Vera Viewer','viewer@test','x','viewer','',1)`).run();
  } catch { /* schema may name the columns differently; the assertion below still holds */ }
  w.close();
  // Without a viewer session we cannot sign in as one here, so this asserts the
  // rule that is reachable: a session that is not the owner's gets nothing.
  const r = await post('/staff-portal/special', { name: 'Viewer dish' });
  assert.ok(r.status === 401 || r.status === 403, `viewer/anonymous refused — got ${r.status}`);
  const rw = new (require('better-sqlite3'))(DB, { readonly: true });
  assert.strictEqual(rw.prepare("SELECT COUNT(*) n FROM portal_specials WHERE name='Viewer dish'").get().n, 0);
  rw.close();
});

test('the guard is a guard now, not a comment', async () => {
  // What this can and cannot prove, stated plainly.
  //
  // CAN: with APP_PASSWORD set, every unauthenticated write to the board and
  // the notes is refused and leaves nothing behind — asserted above, three
  // actors, ten routes.
  //
  // CANNOT: which of the two layers answered. /staff-portal is not in
  // OPEN_PATHS, so the global gate replies 401 before the route runs, and no
  // HTTP request can reach portalGuard while that is true. Isolating it would
  // mean exporting the predicate or adding a test-only bypass, and inventing a
  // hole to prove a hole is closed is a bad trade.
  //
  // So the depth is asserted where it is observable: the guard's own input.
  // mayManagePortal reads req.user, which a staff-portal cookie never sets —
  // if OPEN_PATHS ever changed, that check is what would still be standing.
  const cookie = await staffCookie('5150');
  const me = await fetch(`${BASE}/portal`, { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(me.status, 200, 'the portal session is real and working');
  const them = await fetch(`${BASE}/staff-portal`, { headers: { cookie }, redirect: 'manual' });
  assert.ok(them.status === 302 || them.status === 401 || them.status === 403,
    'and it buys nothing on the owner side');
  assert.ok(!/Post it|86 an item/.test(await them.text()),
    'not even the read view of the board manager');
});

// ===========================================================================
// ONE TOKEN PER FORM
// ===========================================================================
//
// This file is the only one that runs with APP_PASSWORD set, which is why the
// defect below lived here and nowhere else: with no password csrfFor() returns
// '' and the entire CSRF layer stands down, so a thousand green tests on a
// developer machine said nothing about it.
//
// A response-level stamper adds a hidden _csrf to every post form. Forms that
// already wrote their own therefore carried TWO — and express parses a repeated
// field as an ARRAY, so the check compared ['tok','tok'] against 'tok', which is
// never equal. Every one of those forms answered "that form came from somewhere
// else" on submit, in production only. The schedule drawer was one of them: you
// could not create a shift at all.

test('no post form is ever stamped with two CSRF tokens', async () => {
  for (const path of ['/login', '/tips']) {
    const html = await (await fetch(BASE + path)).text();
    const forms = [...html.matchAll(/<form\b[^>]*method\s*=\s*["']?post[^>]*>[\s\S]*?<\/form>/gi)];
    for (const [f] of forms) {
      const n = (f.match(/name="_csrf"/g) || []).length;
      assert.ok(n <= 1, `a form on ${path} carries ${n} tokens — express reads that as an array`);
    }
  }
});

test('a repeated token is read as one, not compared as an array', async () => {
  // Belt and braces on top of the stamper fix: if a duplicate ever returns, it
  // must not silently refuse every submit again.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /function csrfGiven\(req\)/, 'one place reads the submitted token');
  assert.match(src, /Array\.isArray\(raw\) \? String\(raw\[0\] \|\| ''\) : String\(raw\)/,
    'and it takes the first value rather than comparing an array to a string');
  // Both gates use it — the ordinary path and the upload path.
  assert.strictEqual((src.match(/csrfGiven\(req\)/g) || []).length, 3,
    'the definition plus both call sites');
});

test('the stamper leaves a form that already has a token alone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = src.indexOf('const hidden = `<input type="hidden" name="${CSRF_FIELD}"');
  const region = src.slice(i, i + 900);
  assert.match(region, /inner\.indexOf\(`name="\$\{CSRF_FIELD\}"`\) !== -1\) return m/,
    'a form carrying its own token is returned untouched');
});

// ===========================================================================
// Deleting a shift from the timesheet, WITH A PASSWORD SET.
//
// This is the only file that runs that way, and it is the only mode in which
// the bug existed. The first version of that dialog built its form in script
// and read the token off the page — but the timesheet renders none, and the
// response-level stamper only sees forms already in the HTML. With CSRF stood
// down it worked; with a password set the POST was refused and, from the
// manager's side, clicking Delete simply did nothing.
// ===========================================================================

test('the timesheet delete dialog carries a token the server will accept', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const db2 = require('../src/db').db;
  const emp = db2.prepare('SELECT id FROM employees WHERE active = 1 LIMIT 1').get();
  const P2 = require('../src/periods');
  const period = P2.recentPeriods(2)[1];

  const html = await (await as(owner, `/payroll/timesheets/${emp.id}?p=${period.start}`)).text();
  // The dialog is in the markup, so csrfFor() filled it in server-side.
  const at = html.indexOf('id="tsx-f"');
  assert.ok(at > -1, 'the confirmation form is rendered');
  const token = (html.slice(at, at + 400).match(/name="_csrf" value="([a-f0-9]{32})"/) || [])[1];
  assert.ok(token, 'and it carries a real token — this is what was missing');
});

test('a delete posted with that token is accepted, and without one is refused', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const TC2 = require('../src/timeclock');
  const db2 = require('../src/db').db;
  const P2 = require('../src/periods');
  const emp = db2.prepare('SELECT id FROM employees WHERE active = 1 LIMIT 1').get();
  const period = P2.recentPeriods(2)[1];
  const day = require('../src/dates').addDays(period.start, 3);

  const mk = () => {
    db2.prepare('INSERT OR IGNORE INTO shifts (date, daypart) VALUES (?, ?)').run(day, 'cafe');
    const sh = db2.prepare('SELECT id FROM shifts WHERE date = ? AND daypart = ?').get(day, 'cafe');
    return TC2.createEntry({ employee_id: emp.id, shift_id: sh.id, business_date: day,
      daypart: 'cafe', position: 'server',
      clock_in_at: TC2.localInputToUtc(`${day} 09:00`), clock_out_at: TC2.localInputToUtc(`${day} 15:00`),
      source: 'manager', created_by: 'auth-test' });
  };

  // Without a token: refused, and the punch survives. This is what the manager
  // was hitting — a click that did nothing.
  const doomed = mk();
  const body = new URLSearchParams({ reason: 'no token', back: '/payroll/timesheets' });
  const bad = await as(owner, `/timeclock/${doomed}/delete`,
    { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE } });
  assert.notStrictEqual(bad.status, 302, 'a tokenless delete does not go through');
  assert.ok(db2.prepare('SELECT 1 FROM time_entries WHERE id = ?').get(doomed),
    'and the shift is still there');

  // With the token the dialog actually carries: it works.
  const html = await (await as(owner, `/payroll/timesheets/${emp.id}?p=${period.start}`)).text();
  const at = html.indexOf('id="tsx-f"');
  const token = (html.slice(at, at + 400).match(/name="_csrf" value="([a-f0-9]{32})"/) || [])[1];
  const ok = await as(owner, `/timeclock/${doomed}/delete`, {
    method: 'POST',
    body: new URLSearchParams({ reason: 'wrong service', back: '/payroll/timesheets', _csrf: token }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
  });
  assert.strictEqual(ok.status, 302, 'the real dialog posts through');
  assert.ok(!db2.prepare('SELECT 1 FROM time_entries WHERE id = ?').get(doomed), 'and the shift is gone');
});
