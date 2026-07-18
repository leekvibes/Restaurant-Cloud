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
