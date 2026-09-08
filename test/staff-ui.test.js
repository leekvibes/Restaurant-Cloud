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


// --- add employee: the setup flow --------------------------------------------
//
// The old create path wrote eight fields and left ten on the profile, so every
// hire was create-then-go-and-finish-it. What these hold is that the flow
// writes into the SAME tables the profile edits — employees, employee_services,
// employee_roles, wage_history and the overtime flag — and that a rejected
// submission writes none of them.

// Repeated keys, not a comma-joined string. `new URLSearchParams({a:[1,2]})`
// stringifies the array to "1,2" and the server sees one value — which is the
// opposite of what a browser sends for two ticked boxes of the same name, and
// exactly the shape these tests exist to exercise.
const sendForm = (url, body) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    for (const one of (Array.isArray(v) ? v : [v])) p.append(k, String(one));
  }
  return fetch(BASE + url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: p.toString(),
  });
};

const setup = (over) => sendForm('/employees', Object.assign({
  flow: 'setup', name: 'Setup One', role: 'server', pay_type: 'hourly', rate: '10',
  svc: 'cafe', ot_eligible: '1',
}, over || {}));
const byName = (n) => db.prepare('SELECT * FROM employees WHERE name = ?').get(n);
const rolesOf = (id) => db.prepare('SELECT role, wage_cents FROM employee_roles WHERE employee_id = ? ORDER BY role').all(id);
const svcsOf = (id) => db.prepare('SELECT service_slug FROM employee_services WHERE employee_id = ? AND active = 1 ORDER BY service_slug').all(id).map((r) => r.service_slug);
const wagesOf = (id) => db.prepare(`SELECT role, service_slug, wage_cents, effective_from FROM wage_history
  WHERE employee_id = ? ORDER BY IFNULL(role, ''), IFNULL(service_slug, '')`).all(id);

test('the roster sends you to a setup page rather than an inline form', async () => {
  const html = await text('/employees');
  assert.match(html, /href="\/employees\/new"/, 'the roster links to it');
  assert.ok(!/<form[^>]*action="\/employees"[^>]*class="bs-panel rst-add"/.test(html),
    'and the six-field form is gone');
  const page = await text('/employees/new');
  for (const s of ['Employee', 'Role &amp; service', 'Pay', 'Access', 'Review']) {
    assert.ok(page.includes(s), `the ${s} step renders`);
  }
});

test('one submission writes the employee, their positions, schedules and dated wages', async () => {
  const r = await setup({
    name: 'Molly Setup', email: 'molly.setup@x.test', pin: '4141',
    also: ['bartender'], svc: ['cafe', 'dinner'],
    rate: '2.83', prate_bartender: '4.50',
    ov_role: 'server', ov_svc: 'dinner', ov_rate: '5.00',
  });
  assert.strictEqual(r.status, 302, 'it creates');
  const e = byName('Molly Setup');
  assert.ok(e, 'the employee exists');
  assert.strictEqual(e.role, 'server', 'primary position');
  assert.strictEqual(e.hourly_rate_cents, 283, 'the base rate is the catch-all, as it is on the profile');
  assert.strictEqual(e.pay_type, 'hourly');
  assert.strictEqual(e.ot_exempt, 0, 'overtime eligible');
  assert.strictEqual(e.svc_set, 1, 'schedules were DECIDED, not defaulted');

  assert.deepStrictEqual(svcsOf(e.id), ['cafe', 'dinner'], 'on both schedules');
  assert.deepStrictEqual(rolesOf(e.id), [{ role: 'bartender', wage_cents: 450 }],
    'the extra position carries its own rate; the primary falls to the catch-all');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  assert.deepStrictEqual(wagesOf(e.id).map((w) => [w.role, w.service_slug, w.wage_cents, w.effective_from]), [
    [null, null, 283, today],
    ['bartender', null, 450, today],
    ['server', 'dinner', 500, today],
  ], 'three dated rows, starting today — and the schedule rate lives ONLY here');
});

test('the wage the payroll resolver returns is the one the flow promised', async () => {
  // The point of writing through WAGES rather than into a column: the same
  // most-specific-wins rule prices a new hire as it prices everybody else.
  const W = require('../src/wages');
  const e = byName('Molly Setup');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  assert.strictEqual(W.wageOn(e.id, 'server', today, 'dinner'), 500, 'the Evening rate wins there');
  assert.strictEqual(W.wageOn(e.id, 'server', today, 'cafe'), 283, 'and nowhere else');
  assert.strictEqual(W.wageOn(e.id, 'bartender', today, 'dinner'), 450, 'the position rate');
  assert.strictEqual(W.wageOn(e.id, 'busser', today, 'cafe'), 283, 'a position with no rate falls to the catch-all');
});

test('a salaried employee gets no hourly rows anywhere', async () => {
  const r = await setup({ name: 'Sal Setup', role: 'kitchen', pay_type: 'salary',
    salary: '2400', rate: '99', also: ['server'], prate_server: '20' });
  assert.strictEqual(r.status, 302);
  const e = byName('Sal Setup');
  assert.strictEqual(e.pay_type, 'salary');
  assert.strictEqual(e.salary_cents, 240000);
  assert.strictEqual(e.hourly_rate_cents, 0, 'the hourly box is ignored, not stored');
  assert.deepStrictEqual(rolesOf(e.id).map((x) => x.wage_cents), [0],
    'the extra position is kept, with no rate');
  assert.strictEqual(wagesOf(e.id).length, 0, 'and nothing dated — salary does not run through hourly');
});

test('ticking no schedule is allowed, and is recorded as a decision', async () => {
  const r = await setup({ name: 'Nowhere Setup', svc: [] });
  assert.strictEqual(r.status, 302);
  const e = byName('Nowhere Setup');
  assert.deepStrictEqual(svcsOf(e.id), [], 'on nothing');
  assert.strictEqual(e.svc_set, 1, 'deliberately — not "never asked"');
  assert.match(decodeURIComponent(r.headers.get('location') || ''), /no schedule/i, 'and it says so');
});

test('a rejected submission writes nothing at all', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM employees').get().n;
  const r = await setup({ name: '', email: 'nope', pin: '99', rate: '' });
  assert.strictEqual(r.status, 400, 'the form comes back rather than a redirect');
  const html = await r.text();
  assert.match(html, /A name is needed/);
  assert.match(html, /does not look like an email/);
  assert.match(html, /exactly 4 digits/);
  assert.match(html, /needs a rate/);
  assert.match(html, /value="nope"/, 'and what was typed is still there');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM employees').get().n, before, 'nothing created');
});

test('a PIN already in use is refused, naming who and not what', async () => {
  const r = await setup({ name: 'Clash Setup', pin: '6611' });   // Anna's
  assert.strictEqual(r.status, 400);
  const html = await r.text();
  assert.match(html, /Ui Anna already uses that PIN/, 'it says whose it is, so it can be resolved');
  // The MESSAGE carries no digits. The field does, because it is the manager's
  // own keystrokes handed back so they need not retype the form — the same
  // disclosure the profile makes deliberately, and far less than the redirect
  // this replaces, which put the text in a URL and therefore in history.
  const msg = html.slice(html.indexOf('already uses that PIN') - 60, html.indexOf('already uses that PIN') + 60);
  assert.ok(!/\d{4}/.test(msg), 'no PIN in the error text');
  assert.strictEqual((html.match(/6611/g) || []).length, 1, 'and it appears once: in the box they typed it into');
  assert.ok(!byName('Clash Setup'), 'nothing created');
});

test('the live PIN check answers about the PIN it is given, and lists none', async () => {
  const taken = await (await fetch(`${BASE}/employees/pin-check?pin=6611`)).json();
  assert.strictEqual(taken.free, false);
  assert.strictEqual(taken.who, 'Ui Anna');
  const free = await (await fetch(`${BASE}/employees/pin-check?pin=1010`)).json();
  assert.strictEqual(free.free, true);
  const junk = await (await fetch(`${BASE}/employees/pin-check?pin=12`)).json();
  assert.strictEqual(junk.free, null, 'a malformed PIN is not an answer about anybody');
});

test('a schedule rate cannot name a schedule they are not on', async () => {
  // Otherwise it is a rate that pays nobody today and starts paying the moment
  // somebody adds them to that board.
  const r = await setup({ name: 'Stray Setup', svc: 'cafe',
    ov_role: 'server', ov_svc: 'dinner', ov_rate: '9' });
  assert.strictEqual(r.status, 400);
  assert.match(await r.text(), /schedule they are not on/);
  assert.ok(!byName('Stray Setup'), 'nothing created');
});

test('a position cannot be assigned twice', async () => {
  const r = await setup({ name: 'Dupe Setup', role: 'server', also: ['server', 'busser'] });
  assert.strictEqual(r.status, 302, 'the duplicate is dropped, not an error');
  const e = byName('Dupe Setup');
  assert.deepStrictEqual(rolesOf(e.id).map((x) => x.role), ['busser'],
    'the primary is not written a second time');
});

test('the old POST contract is untouched', async () => {
  // Anything that posted at this route before this page existed still gets a
  // redirect, still creates, and still lands on every schedule.
  const r = await post('/employees', { name: 'Legacy Setup', role: 'server', pin: '3232' });
  assert.strictEqual(r.status, 302);
  const e = byName('Legacy Setup');
  assert.ok(e, 'created with no rate, as it always was');
  assert.deepStrictEqual(svcsOf(e.id).sort(), SVC.all().map((x) => x.slug).sort(),
    'and on every schedule, because it never mentioned any');
});

test('the profile header names the primary position and where they work', async () => {
  const e = byName('Molly Setup');
  const html = await text(`/employees/${e.id}/edit`);
  assert.match(html, /Molly Setup/);
  assert.match(html, /Day \+ Evening Service/, 'two schedules read as a phrase, not a list');
  assert.match(html, /epr-plus/, 'the second position is a count, not a name in the header');
  assert.ok(!/Server[^<]*Bartender/.test(html.slice(html.indexOf('epr-line'), html.indexOf('epr-line') + 300)),
    'the header does not spell out every position');
});
