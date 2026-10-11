'use strict';

// Taking the portal away from somebody, without taking them off the roster.
//
// The owner: "can you make a way for me to remove access to the portal for
// someone — I don't want to kick them out, but from the admin side I want to
// be able to remove access, and if they try to log in on the portal it gives
// them an access denied message."
//
// So this is not deactivation, and it is not clearing their PIN (the only ways
// that existed): they keep the PIN they know, their jobs, their schedule and
// their pay, and every portal door answers the same sentence. The doors are
// the thing worth testing — there are four of them, and a door nobody tested
// is how somebody still gets in.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4019;                     // unique across the suite
const BASE = `http://127.0.0.1:${PORT}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-pa-'));
const DB = path.join(dir, 'pa.db');
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
let child, db;

const __csrf = new Map();
async function token(cookie) {
  const key = cookie || '';
  if (!__csrf.has(key)) {
    const r = await fetch(BASE + '/csrf', { headers: key ? { cookie: key } : {} });
    __csrf.set(key, (await r.text()).trim());
  }
  return __csrf.get(key);
}
const post = async (p, body, cookie) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams({ ...body, _csrf: await token(cookie) }).toString(),
});
const page = async (p, cookie) => (await fetch(BASE + p, { headers: cookie ? { cookie } : {} })).text();
const hop = async (p, cookie) => fetch(BASE + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const msgOf = (res) => decodeURIComponent((String(res.headers.get('location') || '').split('msg=')[1] || '')
  .split('#')[0].split('&')[0]).replace(/\+/g, ' ');
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

const EMP = { out: 601, stays: 602 };
const PIN = (id) => String(7000 + id - 600);
const rowOf = (id) => db.prepare('SELECT * FROM employees WHERE id = ?').get(id);

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new (require('better-sqlite3'))(DB);
  const ins = db.prepare(
    "INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?, ?, 'server', ?, 1500, 1)");
  ins.run(EMP.out, 'Shut Out', PIN(EMP.out));
  ins.run(EMP.stays, 'Still In', PIN(EMP.stays));
  const SVC = require('../src/services');
  for (const id of Object.values(EMP)) SVC.setForEmployee(id, SVC.all().map((s) => s.slug));
});

test.after(() => {
  if (child) child.kill();
  try { db.close(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const signIn = (id) => post('/tips/start', { pin: PIN(id) });

test('everybody can sign in before anything is taken away', async () => {
  const res = await signIn(EMP.out);
  assert.strictEqual(res.status, 302);
  assert.ok(cookieOf(res).startsWith('zwin_portal='), 'a session is handed out');
  assert.strictEqual(rowOf(EMP.out).portal_access, 1, 'and access is on by default for everyone');
});

test('a manager removes access, and the record says who, when and why', async () => {
  const res = await post(`/employees/${EMP.out}/portal-access`, { access: 'off', note: 'on leave until November' });
  assert.strictEqual(res.status, 302);
  assert.match(msgOf(res), /can no longer sign in to the portal/);
  assert.match(msgOf(res), /still on the roster, the schedule and payroll/, 'and says what is NOT affected');
  const row = rowOf(EMP.out);
  assert.strictEqual(row.portal_access, 0);
  assert.ok(row.portal_access_at, 'stamped with when');
  assert.ok(row.portal_access_by, 'and by whom');
  assert.strictEqual(row.portal_access_note, 'on leave until November');
  assert.strictEqual(row.active, 1, 'they are NOT deactivated');
  assert.strictEqual(String(row.pin), PIN(EMP.out), 'and they keep the PIN they know');
});

test('the PIN door answers access denied — and does not open', async () => {
  const res = await signIn(EMP.out);
  assert.strictEqual(res.status, 302);
  assert.match(msgOf(res), /^Access denied/, 'the words the owner asked for');
  assert.match(msgOf(res), /Ask your manager/);
  assert.match(msgOf(res), /hours and pay are not affected/);
  assert.ok(!cookieOf(res).startsWith('zwin_portal='), 'and no session is handed out');
});

test('a session made before access was taken away dies at its next tap, saying why', async () => {
  // Signed in first, then shut out underneath them — the real sequence.
  const live = cookieOf(await signIn(EMP.stays));
  await post(`/employees/${EMP.stays}/portal-access`, { access: 'off' });
  const res = await hop('/portal', live);
  assert.strictEqual(res.status, 302);
  assert.match(String(res.headers.get('location')), /^\/tips\?/);
  assert.match(msgOf(res), /^Access denied/, 'not "that timed out", which would send them hunting for a typo');
  assert.match(String(res.headers.get('set-cookie') || ''), /zwin_portal=;/, 'and the session is cleared');
  await post(`/employees/${EMP.stays}/portal-access`, { access: 'on' });
});

test('the clock is shut too — they cannot clock in or out', async () => {
  const live = cookieOf(await signIn(EMP.stays));
  await post(`/employees/${EMP.stays}/portal-access`, { access: 'off' });
  const res = await post('/portal/clock/in', { daypart: 'dinner', position: 'server' }, live);
  assert.strictEqual(res.status, 302);
  assert.match(msgOf(res), /^Access denied/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE employee_id = ?').get(EMP.stays).n, 0,
    'and no punch was made');
  await post(`/employees/${EMP.stays}/portal-access`, { access: 'on' });
});

test('the old name-and-PIN tip form is a portal door, and shuts with the rest', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM tip_submissions WHERE employee_id = ?').get(EMP.out).n;
  const res = await post('/tips', { employee_id: String(EMP.out), pin: PIN(EMP.out),
    date: '2026-10-09', daypart: 'dinner', position: 'server', card_tips: '80', food: '400' });
  assert.strictEqual(res.status, 302);
  assert.match(msgOf(res), /^Access denied/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM tip_submissions WHERE employee_id = ?').get(EMP.out).n, before,
    'nothing was filed');
});

test('posting somebody else’s name with a wrong PIN is never told whose access is off', async () => {
  const res = await post('/tips', { employee_id: String(EMP.out), pin: '9999',
    date: '2026-10-09', daypart: 'dinner', position: 'server', card_tips: '10' });
  assert.doesNotMatch(msgOf(res), /Access denied/, 'a stranger learns nothing about them');
  assert.match(msgOf(res), /PIN/, 'just that the PIN is wrong');
});

test('the manager still has them: schedule, punches and pay all work', async () => {
  // A punch typed in by a manager, for somebody who cannot open the portal.
  const day = '2026-10-09';
  const added = await post('/timeclock/new', { employee_id: String(EMP.out), daypart: 'dinner', position: 'server',
    date: day, in_time: '17:00', out_time: '22:00', reason: 'they cannot clock in themselves' });
  assert.strictEqual(added.status, 302);
  const e = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? ORDER BY id DESC').get(EMP.out);
  assert.ok(e, 'the manager can still add their hours');
  assert.strictEqual(e.payable_minutes, 300);
  const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'dinner'").get(day).id;
  assert.strictEqual(Number(db.prepare('SELECT hours FROM work WHERE shift_id = ? AND employee_id = ?')
    .get(sh, EMP.out).hours), 5, 'and the service carries them');
  const { aggregatePayroll } = require('../src/reports');
  const pay = aggregatePayroll(day, day).rows.find((r) => r.employeeId === EMP.out);
  assert.ok(pay && Number(pay.hours) === 5, 'payroll pays them as usual');
});

test('the staff page and the staff list both say it, with the reason for the manager only', async () => {
  const one = await page(`/employees/${EMP.out}/edit`);
  assert.match(one, /Access removed/, 'the person’s own page leads with it');
  assert.match(one, /on leave until November/, 'with the note, which only a manager sees');
  assert.match(one, /Give access back/, 'and the way back');
  const list = await page('/employees');
  assert.match(list, /Access removed/, 'the roster shows it at a glance');
});

test('giving access back opens the same door with the same PIN', async () => {
  const res = await post(`/employees/${EMP.out}/portal-access`, { access: 'on' });
  assert.match(msgOf(res), /can sign in to the portal again, with the same PIN/);
  const row = rowOf(EMP.out);
  assert.strictEqual(row.portal_access, 1);
  assert.strictEqual(row.portal_access_note, null, 'the old reason does not linger');
  const back = await signIn(EMP.out);
  assert.ok(cookieOf(back).startsWith('zwin_portal='), 'and the portal opens');
  assert.match(await page('/portal', cookieOf(back)), /Shut Out/, 'on their own hub');
});

test('a phone belonging to somebody shut out is not sent portal notifications', async () => {
  // The banner would open a door that answers "access denied".
  db.prepare(`INSERT OR REPLACE INTO portal_push (endpoint, employee_id, sub)
    VALUES ('https://push.test/shut', ?, '{}')`).run(EMP.out);
  db.prepare(`INSERT OR REPLACE INTO portal_push (endpoint, employee_id, sub)
    VALUES ('https://push.test/in', ?, '{}')`).run(EMP.stays);
  await post(`/employees/${EMP.out}/portal-access`, { access: 'off' });
  const PORTAL = require('../src/portal');
  const reach = (id) => db.prepare(`SELECT COUNT(*) n FROM portal_push p
    LEFT JOIN employees e ON e.id = p.employee_id
    WHERE p.employee_id = ? AND COALESCE(e.portal_access, 1) = 1`).get(id).n;
  assert.strictEqual(reach(EMP.out), 0, 'their device is out of every send');
  assert.strictEqual(reach(EMP.stays), 1, 'everybody else still gets theirs');
  assert.strictEqual(typeof PORTAL.notify, 'function', 'and the sender is the one that reads this list');
});
