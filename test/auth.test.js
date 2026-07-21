'use strict';

// These run the app the way it runs on the host: APP_PASSWORD set, so the
// manager auth middleware is live. Locally that variable is usually unset,
// which disables auth entirely — so every earlier test exercised the app with
// the middleware switched off, and a staff route left out of OPEN_PATHS went
// unnoticed until a staff member hit "Session expired" at close.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

async function up() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), APP_PASSWORD: 'test-manager-password' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/version`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}

test.before(up);
test.after(() => child && child.kill());

const get = (p) => fetch(BASE + p, { redirect: 'manual' });
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

test('staff can reach every step of the tips flow without the manager password', async () => {
  assert.strictEqual((await get('/tips')).status, 200, 'PIN screen');
  // /tips/start is the PIN step. Leaving it out of OPEN_PATHS is what made
  // staff see "Session expired" — a wall they had no way past.
  const start = await post('/tips/start', { pin: 'nope-not-a-real-pin' });
  assert.notStrictEqual(start.status, 401, 'must not hit the manager auth wall');
  assert.ok(start.status === 200 || start.status === 302, `got ${start.status}`);
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
  assert.strictEqual((await as(v, '/employees')).status, 403, 'staff withheld');
  assert.strictEqual((await as(v, '/users')).status, 403, 'cannot reach user admin');

  // View-only means view-only even on a page they ARE allowed to open.
  const write = await as(v, '/sales/1', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'food=999999',
  });
  assert.strictEqual(write.status, 403, 'writes refused');
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

    assert.ok(html.includes('Needs attention'), 'still gets the sections it may see');
    for (const withheld of ['Business health', 'Quick actions']) {
      assert.ok(!html.includes(withheld), `${withheld} must not render`);
    }
    // Quick actions are writes; a view-only account gets none of them at all.
    assert.ok(!html.includes('class="qact"'), 'no write shortcuts for a viewer');
    // And nothing from the trackers/payroll/cash areas leaks into the lists.
    for (const leak of ['/c/invoices', '/c/recurring', '/c/par', '/payroll', '/cash']) {
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
  for (const section of ['Today', 'Needs attention', 'Quick actions', 'Business health', 'Recent activity']) {
    assert.ok(html.includes(section), `${section} renders for the owner`);
  }
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
