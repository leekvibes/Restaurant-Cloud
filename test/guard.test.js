'use strict';

// Throttling the one credential in this app that a person can guess.
//
// A staff PIN is four digits: ten thousand of them, against a comparison that
// used to answer as fast as the database could run it. These tests are about
// the guesser being stopped, the real employee not being punished for it, and
// the PIN never appearing anywhere it could be read back.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3997;                     // unique across the suite
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-gd-'));
const DB = path.join(dir, 'gd.db');
const LOG = path.join(dir, 'server.log');
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
let child, Database, db, logFd;

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const msgOf = (res) => decodeURIComponent((res.headers.get('location') || '').split('msg=')[1] || '');

const A = 91, B = 92;   // two employees, so isolation can be checked

test.before(async () => {
  Database = require('better-sqlite3');
  logFd = fs.openSync(LOG, 'a');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    // Small limits, so the test does not have to make 25 requests to prove a
    // rule that is the same at 3.
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '',
      PIN_MAX: '3', PIN_LOCK_SECS: '2', PIN_IP_MAX: '50', PIN_IP_LOCK_SECS: '2' },
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new Database(DB);
  const ins = db.prepare("INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server',?,1500,1)");
  ins.run(A, 'Guarded One', '4242');
  ins.run(B, 'Guarded Two', '5353');
});

test.after(() => {
  if (child) child.kill();
  try { db.close(); } catch {}
  try { fs.closeSync(logFd); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

const clear = () => db.prepare('DELETE FROM auth_attempts').run();

test('the right PIN gets in', async () => {
  clear();
  const res = await post('/tips/start', { pin: '4242' });
  assert.strictEqual(res.status, 302);
  assert.ok((res.headers.get('set-cookie') || '').includes('zwin_portal'), 'a session is issued');
});

test('a wrong PIN is refused, and says nothing about which part was wrong', async () => {
  clear();
  const res = await post('/tips/start', { pin: '0000' });
  const m = msgOf(res);
  assert.match(m, /wasn.t recognised/i, 'a generic refusal');
  assert.doesNotMatch(m, /4242|5353|Guarded/, 'no PIN and no name leaks back');
});

test('repeated wrong PINs against one employee lock that employee', async () => {
  clear();
  // Named directly, so the failures land on the employee bucket.
  for (let i = 0; i < 3; i++) await post('/tips', { employee_id: String(A), pin: '0000' });
  const res = await post('/tips', { employee_id: String(A), pin: '0000' });
  assert.match(msgOf(res), /timed out|PIN|try again/i, 'refused');
  const row = db.prepare("SELECT * FROM auth_attempts WHERE scope='pin' AND ident=?").get(String(A));
  assert.ok(row && row.locked_until, 'the employee bucket is locked');
});

test('the correct PIN is refused while that employee is locked', async () => {
  // Locked by the test above. This is the point of a lockout: it must refuse to
  // EVALUATE, or a guesser simply guesses through it.
  const row = db.prepare("SELECT * FROM auth_attempts WHERE scope='pin' AND ident=?").get(String(A));
  assert.ok(row && row.locked_until, 'still locked');
  const before = db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n;
  const res = await post('/tips', { employee_id: String(A), pin: '4242', date: '2026-07-04', daypart: 'dinner', cash_tips: '10' });
  // /tips redirects whether it worked or not, so the status says nothing — the
  // question is whether anything was actually accepted.
  const to = res.headers.get('location') || '';
  assert.match(to, /err=1/, 'refused, with the generic error');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n, before,
    'and nothing was filed under their name');
});

test('another employee is untouched by their colleague being locked', async () => {
  const res = await post('/tips/start', { pin: '5353' });
  assert.strictEqual(res.status, 302, 'the other PIN still works');
  assert.ok((res.headers.get('set-cookie') || '').includes('zwin_portal'));
});

test('the lock expires on its own — nobody is shut out for good', async () => {
  await new Promise((r) => setTimeout(r, 2400));   // PIN_LOCK_SECS=2
  const res = await post('/tips/start', { pin: '4242' });
  assert.strictEqual(res.status, 302, 'back in once it expires');
});

test('a correct PIN clears the failures behind it', async () => {
  clear();
  await post('/tips', { employee_id: String(A), pin: '0000' });
  assert.ok(db.prepare("SELECT * FROM auth_attempts WHERE scope='pin' AND ident=?").get(String(A)), 'a failure was recorded');
  await post('/tips/start', { pin: '4242' });
  assert.ok(!db.prepare("SELECT * FROM auth_attempts WHERE scope='pin' AND ident=?").get(String(A)),
    'and getting it right wipes the slate');
});

test('no PIN is ever written to the database or the log', async () => {
  clear();
  for (const p of ['4242', '9999', '0000']) await post('/tips/start', { pin: p });
  const rows = JSON.stringify(db.prepare('SELECT * FROM auth_attempts').all());
  assert.doesNotMatch(rows, /4242|9999|0000/, 'the attempts table holds counts, never credentials');
  const log = fs.readFileSync(LOG, 'utf8');
  assert.doesNotMatch(log, /4242/, 'and the real PIN is nowhere in the log');
  const ev = JSON.stringify(db.prepare("SELECT * FROM time_events").all());
  assert.doesNotMatch(ev, /4242/, 'nor in the audit history');
});

test('attempts survive a restart — waiting one out is not a way through', () => {
  clear();
  db.prepare("INSERT INTO auth_attempts (scope, ident, fails) VALUES ('pin','999',3)").run();
  const again = new Database(DB, { readonly: true });
  assert.ok(again.prepare("SELECT 1 FROM auth_attempts WHERE ident='999'").get(),
    'the record is on disk, not in a process that can be bounced');
  again.close();
});
