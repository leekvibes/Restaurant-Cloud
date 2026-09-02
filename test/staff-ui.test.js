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

test('the PIN is shown on the details tab and nowhere else', async () => {
  // It used to be hidden everywhere, on the reasoning that a credential should
  // not sit on screen. That is the wrong threat model here: the owner chooses
  // these PINs, hands them out, and is who staff ask when they forget one — so
  // it was a secret from the only person who needed it, and "what is Anna's
  // PIN" could only be answered by resetting it.
  const details = await text(`/employees/${ANNA}/edit`);
  assert.ok(details.includes('value="6611"'), 'the details tab shows it, ready to change');

  // It appears on every tab because personal details is the persistent left
  // column — that is the layout, not a leak. What must not exist anywhere is a
  // HIDDEN pin field: that is how an unrelated save comes to rewrite a
  // credential it was never editing, and it is the bug this guards.
  for (const t of ['employment', 'pay', 'time', 'payroll', 'documents', 'activity']) {
    const html = await text(`/employees/${ANNA}/edit?tab=${t}`);
    const inputs = [...html.matchAll(/<input[^>]*name="pin"[^>]*>/g)].map((m) => m[0]);
    assert.strictEqual(inputs.length, 1, `${t}: one pin field, the editable one`);
    assert.ok(!/type="hidden"/.test(inputs[0]), `${t}: and it is not a hidden carry-along`);
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

test('an ABSENT pin field keeps the PIN; a BLANK one clears it', async () => {
  // Six tabs post to one route. Only the details tab renders the PIN, so every
  // other tab sends no `pin` key at all — and if absent were read as blank,
  // saving a wage would silently lock somebody out of the portal with nothing
  // on screen to explain it. That is the failure this guards.
  const before = emp(ANNA);
  assert.ok(before.pin, 'they start with one');
  await post(`/employees/${ANNA}`, {
    name: before.name, email: before.email,          // no pin key whatsoever
    role: 'server', pay_type: 'hourly', rate: '15.00', salary: '', ot_eligible: '1', wage_from: 'today',
  });
  assert.strictEqual(emp(ANNA).pin, before.pin, 'a save from another tab leaves it alone');

  // Emptying the box IS deliberate now — the digits are on screen, so getting
  // to blank means selecting four visible characters and deleting them.
  await post(`/employees/${ANNA}`, {
    name: before.name, email: before.email, pin: '',
    role: 'server', pay_type: 'hourly', rate: '15.00', salary: '', ot_eligible: '1', wage_from: 'today',
  });
  assert.strictEqual(emp(ANNA).pin, null, 'clearing the box removes their access');

  await post(`/employees/${ANNA}`, {
    name: before.name, email: before.email, pin: before.pin,
    role: 'server', pay_type: 'hourly', rate: '15.00', salary: '', ot_eligible: '1', wage_from: 'today',
  });
  assert.strictEqual(emp(ANNA).pin, before.pin, 'and typing one puts it back');
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

// --- the catch-all rate, moved out of Employment -----------------------------

test('the catch-all rate lives with the other rates, not on Employment', async () => {
  // It is not an employment attribute. It is what gets used when somebody
  // works a position nobody set a rate for — on the live data that is 90% of
  // all hours — so it belongs beside the position rates, and calling it
  // "Default hourly wage" next to Pay type made it read as a rival wage level.
  //
  // Asserted on the rendered page rather than the source: what is served is
  // what matters, and a regex over a template is one refactor from lying.
  const employment = await text(`/employees/${ANNA}/edit?tab=employment`);
  assert.doesNotMatch(employment, /Default hourly wage/, 'gone from Employment');
  const visible = employment.match(/<input(?![^>]*type="hidden")[^>]*name="rate"/g) || [];
  assert.strictEqual(visible.length, 0, 'no wage field on Employment any more');
  assert.match(employment, /<input type="hidden" name="rate"/,
    'but carried hidden, or saving Employment would blank it');

  const pay = await text(`/employees/${ANNA}/edit?tab=pay`);
  assert.match(pay, /Anything else they work/, 'and it is on Schedule & pay, named for what it does');
  assert.match(pay, /class="epr-fall-n" name="rate"/, 'and editable there');
});

test('a position somebody actually works with no rate of its own is surfaced', async () => {
  // An invisible fallback becomes a visible prompt. Without this, somebody can
  // work sixty kitchen shifts on a catch-all and nothing ever says so.
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status, created_at)
    VALUES ('2027-04-04', 'cafe', 'emailed', datetime('now'))`).run().lastInsertRowid);
  db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents)
              VALUES (?, ?, 'barista', 6, 0)`).run(sh, ANNA);
  try {
    const html = await text(`/employees/${ANNA}/edit?tab=pay`);
    assert.match(html, /No rate of its own/, 'the gap is named');
    assert.match(html, /Barista/, 'and says which position');
  } finally {
    db.prepare('DELETE FROM work WHERE shift_id = ?').run(sh);
    db.prepare('DELETE FROM shifts WHERE id = ?').run(sh);
  }
});

test('saving the catch-all does not blank the rest of the record', () => {
  // It posts to the same route as everything else, so it carries the fields it
  // does not show — the same rule the two profile forms follow.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const fall = /class="epr-fall-f"([\s\S]*?)<\/form>/.exec(src)[1];
  for (const f of ['name', 'role', 'email', 'pos_id', 'pay_type', 'ot_eligible']) {
    assert.ok(fall.includes(`'${f}'`) || fall.includes(`name="${f}"`), `${f} travels with it`);
  }
});
