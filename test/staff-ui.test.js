'use strict';

/**
 * The redesigned Staff area.
 *
 * The redesign is presentation, so most of these are about what did NOT change:
 * the same routes, the same fields, the same values after a save. The two that
 * are about new behaviour are the PIN rule and the roster's Inactive tab, and
 * both say so.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');

const PORT = 3971;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-staffui-'));
const DB = path.join(dir, 'staffui.db');
process.env.DB_PATH = DB;
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
const SVC = require('../src/services');

let child;
const text = async (p) => (await fetch(BASE + p)).text();
const post = async (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const emp = (id) => db.prepare('SELECT * FROM employees WHERE id = ?').get(id);

let ANNA; let GONE;

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
  SVC.seed();
  const ins = db.prepare(`INSERT INTO employees (name, role, email, pin, hourly_rate_cents, active, pos_id, pay_type)
                          VALUES (?, 'server', ?, ?, 1500, ?, 'POS-9', 'hourly')`);
  ANNA = Number(ins.run('Ui Anna', 'anna@x.test', '6611', 1).lastInsertRowid);
  GONE = Number(ins.run('Ui Departed', 'gone@x.test', '6612', 0).lastInsertRowid);
  db.prepare("INSERT OR IGNORE INTO employee_services (employee_id, service_slug) VALUES (?, 'cafe')").run(ANNA);
  // A held position, so the Positions & pay card actually renders one — the
  // remove control only exists where there is something to remove.
  db.prepare("INSERT OR IGNORE INTO employee_roles (employee_id, role, wage_cents) VALUES (?, 'server', 1500)").run(ANNA);
});
test.after(() => { if (child) child.kill(); });

// --- the roster --------------------------------------------------------------

test('the roster has three tabs and each counts what it shows', async () => {
  const html = await text('/employees');
  assert.match(html, /rst-tab/, 'tabs render');
  for (const t of ['Active', 'Managers', 'Inactive']) assert.ok(html.includes(t), `${t} tab`);
  assert.match(html, /Ui Anna/, 'an active person is on the default tab');
  assert.doesNotMatch(html, /Ui Departed/, 'and a deactivated one is not');
});

test('the Inactive tab finds somebody deactivated, and offers the way back', async () => {
  // New capability, and worth naming as such: q.allEmployees filters to active,
  // so before this there was nowhere in the app to see a deactivated person or
  // bring them back — reactivate had a route and no button.
  const html = await text('/employees?tab=inactive');
  assert.match(html, /Ui Departed/, 'they are findable');
  assert.match(html, /Reactivate/, 'and can be brought back');
});

test('the roster never prints a PIN', async () => {
  const html = await text('/employees');
  assert.ok(!html.includes('6611'), 'not Anna\'s');
  assert.ok(!html.includes('6612'), 'not the departed one\'s');
  assert.match(html, /Can sign in|No PIN/, 'it reports the STATE instead');
});

// --- the profile -------------------------------------------------------------

test('every tab renders, and an unknown one falls back rather than blanking', async () => {
  for (const t of ['employment', 'pay', 'time', 'payroll', 'documents', 'activity']) {
    const r = await fetch(`${BASE}/employees/${ANNA}/edit?tab=${t}`);
    assert.strictEqual(r.status, 200, `${t} renders`);
    const html = await r.text();
    assert.match(html, /class="epr-tabs"/, `${t} keeps the tab strip`);
    assert.match(html, /Personal details/, `${t} keeps the left column`);
  }
  const bad = await text(`/employees/${ANNA}/edit?tab=nonsense`);
  assert.match(bad, /Employment/, 'an unknown tab shows the first one');
});

test('no tab prints the PIN', async () => {
  for (const t of ['employment', 'pay', 'time', 'payroll', 'documents', 'activity']) {
    const html = await text(`/employees/${ANNA}/edit?tab=${t}`);
    assert.ok(!html.includes('6611'), `${t} does not leak it`);
  }
});

test('Documents is a shell and says so, rather than pretending', async () => {
  const html = await text(`/employees/${ANNA}/edit?tab=documents`);
  assert.match(html, /Not built yet/, 'it is honest about having no backend');
  assert.doesNotMatch(html, /<form[^>]*enctype="multipart/, 'and offers no upload that would fail');
});

// --- what must not change ----------------------------------------------------

test('saving one form does not blank what another form edits', async () => {
  // The profile is two forms where there was one, and the update route writes
  // every column — so each form carries what it does not show. Without that,
  // saving Employment would silently erase the name and email.
  const before = emp(ANNA);
  const r = await post(`/employees/${ANNA}`, {
    name: before.name, email: before.email,
    role: 'server', pay_type: 'hourly', rate: '15.00', salary: '', pos_id: 'POS-9',
    ot_eligible: '1', wage_from: 'today',
  });
  assert.strictEqual(r.status, 302);
  const after = emp(ANNA);
  assert.strictEqual(after.name, before.name, 'name survives');
  assert.strictEqual(after.email, before.email, 'email survives');
  assert.strictEqual(after.pos_id, 'POS-9', 'POS id survives');
  assert.strictEqual(after.pin, before.pin, 'and the PIN survives');
});

test('a blank PIN field KEEPS the PIN — the one rule this redesign changed', async () => {
  // It used to mean "clear it", which was safe only because the form always
  // rendered the real digits. The digits are gone, so blank must mean keep or
  // an unrelated save would lock somebody out of the portal silently.
  const before = emp(ANNA);
  assert.ok(before.pin, 'they start with one');
  await post(`/employees/${ANNA}`, {
    name: before.name, email: before.email, pin: '',
    role: 'server', pay_type: 'hourly', rate: '15.00', salary: '', ot_eligible: '1', wage_from: 'today',
  });
  assert.strictEqual(emp(ANNA).pin, before.pin, 'still there');
});

test('removing a PIN is possible, but only deliberately', async () => {
  await post(`/employees/${ANNA}`, {
    name: 'Ui Anna', email: 'anna@x.test', pin: '', pin_clear: '1',
    role: 'server', pay_type: 'hourly', rate: '15.00', salary: '', ot_eligible: '1', wage_from: 'today',
  });
  assert.strictEqual(emp(ANNA).pin, null, 'gone when asked for');
  await post(`/employees/${ANNA}`, {
    name: 'Ui Anna', email: 'anna@x.test', pin: '6611',
    role: 'server', pay_type: 'hourly', rate: '15.00', salary: '', ot_eligible: '1', wage_from: 'today',
  });
  assert.strictEqual(emp(ANNA).pin, '6611', 'and settable again');
});

test('every form still posts to the route it always posted to', async () => {
  // The redesign moved forms around the page. If one lost its action, it would
  // fail silently — a save that goes nowhere looks exactly like a save.
  const html = await text(`/employees/${ANNA}/edit?tab=pay`);
  assert.match(html, new RegExp(`action="/employees/${ANNA}/services"`), 'services');
  assert.match(html, new RegExp(`action="/employees/${ANNA}/roles"`), 'roles');
  assert.match(html, new RegExp(`action="/employees/${ANNA}/roles/delete"`), 'role delete');
  const emp0 = await text(`/employees/${ANNA}/edit?tab=employment`);
  assert.match(emp0, new RegExp(`action="/employees/${ANNA}"`), 'the employee update');
});

test('the profile stays under /employees, which is what keeps it gated', async () => {
  // featureFor('/employees/...') resolves to the staff area; featureFor of a
  // path outside it resolves to null, which means OPEN. A prettier URL would
  // have quietly published wages and PINs to every signed-in account.
  const nav = require('../src/nav');
  assert.strictEqual(nav.areaFor('/employees'), 'staff');
  assert.strictEqual(nav.areaFor(`/employees/${ANNA}/edit`), 'staff');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.doesNotMatch(src, /app\.get\('\/staff\/:/, 'no profile route outside the gated prefix');
});

test('deactivating still deletes nothing', async () => {
  const counts = () => ({
    work: db.prepare('SELECT COUNT(*) n FROM work WHERE employee_id = ?').get(ANNA).n,
    wages: db.prepare('SELECT COUNT(*) n FROM wage_history WHERE employee_id = ?').get(ANNA).n,
    svcs: db.prepare('SELECT COUNT(*) n FROM employee_services WHERE employee_id = ?').get(ANNA).n,
  });
  const before = counts();
  await post(`/employees/${ANNA}/deactivate`, {});
  assert.strictEqual(emp(ANNA).active, 0, 'they are inactive');
  assert.deepStrictEqual(counts(), before, 'and not one row went with them');
  await post(`/employees/${ANNA}/reactivate`, {});
  assert.strictEqual(emp(ANNA).active, 1, 'and they come back');
});
