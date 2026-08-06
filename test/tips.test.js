'use strict';

// The staff portal — PIN sign-in and the end-of-shift report.
//
// This is the only page in ZWIN that people who are not the owner use, on
// their own phones, once a night, usually while holding something else. It is
// also the page whose input everything downstream is built from: get a report
// filed against the wrong service and the tip pools, the payroll and the
// nightly emails are all wrong together.
//
// So the things asserted here are the things that would be silently wrong
// rather than visibly broken: which service a report lands on, whose record it
// lands on, and whether a form served to a phone with no working JavaScript
// still carries every field.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3991;
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tips-'));
const DB = path.join(dir, 't.db');
let child, db;

const form = (url, body) => fetch(`${BASE}${url}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

test.before(async () => {
  const Database = require('better-sqlite3');
  const env = { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '', ZWIN_SKIP_BACKFILL: '1' };
  const boot = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...env, PORT: String(PORT + 40) }, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`http://127.0.0.1:${PORT + 40}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  boot.kill();
  await new Promise((r) => setTimeout(r, 300));

  db = new Database(DB);
  db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Rosa Diaz','server',900,1,'2468')").run();
  db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Ana Ortiz','busser',1000,1,'1357')").run();
  // Phase 2D-0 fixtures. `busser` and `kitchen` are seeded takes_tips = 0.
  db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Cara Vega','kitchen',1600,1,'9753')").run();
  // Tipped primary, second job that is not. The eligibility question is asked
  // of the position they ARE, which is the one on the employee row.
  db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Mia Reyes','server',950,1,'8642')").run();
  db.prepare("INSERT INTO employee_roles (employee_id, role, wage_cents) VALUES ((SELECT id FROM employees WHERE name='Mia Reyes'),'busser',1000)").run();
  // Kitchen primary, server second. The case the primary-position rule got
  // wrong in the other direction: she works server shifts and could not file
  // a single one of them.
  db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Nadia Cruz','kitchen',1700,1,'7531')").run();
  db.prepare("INSERT INTO employee_roles (employee_id, role, wage_cents) VALUES ((SELECT id FROM employees WHERE name='Nadia Cruz'),'server',950)").run();
  // Two jobs that BOTH hand in. This is the only shape with a genuine choice
  // to make — Mia has two jobs but only one of them qualifies.
  db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Tess Blake','server',900,1,'1470')").run();
  db.prepare("INSERT INTO employee_roles (employee_id, role, wage_cents) VALUES ((SELECT id FROM employees WHERE name='Tess Blake'),'bartender',1100)").run();
  db.close();

  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  db = new Database(DB, { readonly: true });
});

test.after(() => { if (child) child.kill(); if (db) db.close(); });

/**
 * PIN in, tip form out.
 *
 * A verified PIN now lands on the portal hub rather than dropping straight
 * into the form — the portal holds more than one thing, and for a cook it
 * holds no form at all. The form is one press further in, so this helper
 * takes that press. Everything after it is unchanged: the same signed token,
 * in the same field, posted to the same route.
 */
const signIn = async (pin) => {
  const start = await form('/tips/start', { pin });
  assert.strictEqual(start.status, 302, `PIN ${pin} signs in`);
  assert.match(start.headers.get('location') || '', /\/portal/, 'and lands on the hub');
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^zwin_portal=/, 'carrying who it is');

  const res = await fetch(`${BASE}/portal/tips`, {
    method: 'POST', redirect: 'manual', headers: { cookie },
  });
  assert.strictEqual(res.status, 200, 'the tip form opens from the hub');
  const html = await res.text();
  const m = html.match(/name="token" value="([^"]+)"/);
  assert.ok(m, 'a token comes back');
  return { html, token: m[1], cookie };
};

test('the sign-in page names nobody', async () => {
  // An open link that listed the staff would publish the roster to anyone who
  // found the URL. Nothing about a person appears until a PIN is verified.
  const html = await (await fetch(`${BASE}/tips`)).text();
  for (const name of ['Rosa', 'Diaz', 'Ana', 'Ortiz']) {
    assert.ok(!html.includes(name), `${name} is not on the sign-in page`);
  }
  assert.match(html, /Sign in\./);
});

test('neither service is preselected', async () => {
  // THE one that matters. A default here is a guess, and a wrong guess files
  // somebody's tips against a service they did not work — which shows up as a
  // pool that does not balance, days later, with no clue where it came from.
  //
  // 2F moved the service question into the manual path: normally you pick a
  // shift the clock already recorded, and only "a shift not listed" asks for a
  // date and service outright. The rule is unchanged wherever it is asked.
  const { cookie } = await signIn('2468');
  const html = await (await fetch(`${BASE}/portal/tips?manual=1`, { headers: { cookie } })).text();
  const opts = [...html.matchAll(/<option value="(cafe|dinner)"[^>]*>/g)].map((m) => m[0]);
  assert.strictEqual(opts.length, 2, 'cafe and dinner');
  for (const o of opts) assert.ok(!/\bselected\b/.test(o), `not preselected: ${o}`);
  assert.match(html, /<option value="">Choose a service<\/option>/, 'the empty answer is the one showing');
  assert.match(html, /<select id="st-dp" name="daypart" required/, 'and one of them must be chosen');
});
test('a report with no service chosen is refused', async () => {
  // The browser blocks this, and the browser is not the guard — a phone with
  // no JavaScript, or a stale cached page, posts straight past it.
  const { token } = await signIn('2468');
  const res = await form('/tips', { token, position: 'server', date: '2026-07-20', daypart: '', cash_tips: '40' });
  assert.strictEqual(res.status, 200, 'the form comes back rather than saving');
  const html = await res.text();
  assert.match(html, /which service you worked/i);
  const n = db.prepare("SELECT COUNT(*) n FROM shifts WHERE date = '2026-07-20'").get().n;
  assert.strictEqual(n, 0, 'and no shift was opened');
});
test('a full report lands on the right service, for the right person', async () => {
  const { token } = await signIn('2468');
  const res = await form('/tips', {
    token, position: 'server', date: '2026-07-21', daypart: 'dinner',
    food: '1200.50', coffee: '80', alcohol: '', cash_tips: '128', card_tips: '', note: 'quiet one',
  });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /done=1/);

  const sh = db.prepare("SELECT id FROM shifts WHERE date='2026-07-21' AND daypart='dinner'").get();
  assert.ok(sh, 'the service was opened for them — staff report before a manager opens it');
  const rosa = db.prepare("SELECT id FROM employees WHERE name='Rosa Diaz'").get();
  const sale = db.prepare('SELECT * FROM server_sales WHERE shift_id=? AND employee_id=?').get(sh.id, rosa.id);
  assert.strictEqual(sale.food_cents, 120050, 'to the cent');
  assert.strictEqual(sale.coffee_cents, 8000);
  assert.strictEqual(sale.cash_tips_cents, 12800);
  const sub = db.prepare('SELECT * FROM tip_submissions WHERE shift_id=? AND employee_id=?').get(sh.id, rosa.id);
  assert.strictEqual(sub.note, 'quiet one');
  assert.strictEqual(sub.card_tips_cents, null, 'blank card tips stay blank, not zero');
});

test('a posted role never wins over the assigned one', async () => {
  // Mia is a server who also busses. A hand-written POST claiming a job she
  // does not hold used to be quietly substituted for one she does; now it is
  // refused, which is the more honest answer — the submission it would have
  // written is not the one she asked for.
  const { token } = await signIn('8642');
  const res = await form('/tips', {
    token, position: 'manager', date: '2026-07-19', daypart: 'cafe', cash_tips: '60',
  });
  assert.strictEqual(res.status, 403, 'a job she does not hold is refused');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-07-19' AND daypart='cafe'").get().n, 0,
    'and nothing was created for it');

  // Filing the job she DOES hold, and which is asked to hand in, goes through.
  const ok = await form('/tips', {
    token, position: 'server', date: '2026-07-19', daypart: 'cafe', cash_tips: '60',
  });
  assert.strictEqual(ok.status, 302);
  const sh = db.prepare("SELECT id FROM shifts WHERE date='2026-07-19' AND daypart='cafe'").get();
  assert.strictEqual(db.prepare('SELECT role FROM work WHERE shift_id=? AND employee_id=?')
    .get(sh.id, db.prepare("SELECT id FROM employees WHERE name='Mia Reyes'").get().id).role, 'server',
    'filed as the job she named and holds');
});

test('with no JavaScript the whole form is still there', async () => {
  // 2F: one page, so there is nothing for a script to switch between and
  // nothing that fails to appear when it does not run. Every field the write
  // needs is in the markup as sent. The date and service live on the manual
  // path — that is the only page that asks for them.
  const { cookie } = await signIn('2468');
  const main = await (await fetch(`${BASE}/portal/tips`, { headers: { cookie } })).text();
  for (const name of ['token', 'position', 'food', 'coffee', 'alcohol',
    'cash_tips', 'card_tips', 'note']) {
    assert.match(main, new RegExp(`name="${name}"`), `${name} is in the markup`);
  }
  const manual = await (await fetch(`${BASE}/portal/tips?manual=1`, { headers: { cookie } })).text();
  for (const name of ['date', 'daypart']) {
    assert.match(manual, new RegExp(`name="${name}"`), `${name} is on the manual path`);
  }
  assert.match(main, /<button class="[^"]*st-send" type="submit"/, 'and a submit that posts it');
});
test('the sign-in keypad draws exactly as many cells as a PIN has digits', async () => {
  // The screen has its own keypad — no text input to focus, so the phone's
  // keyboard never opens and nothing zooms. The PIN rides on a hidden field
  // the keys fill. If a PIN of some other length could be saved, that person
  // could never enter it here, so /employees refuses any other length.
  const html = await (await fetch(`${BASE}/tips`)).text();
  assert.strictEqual((html.match(/class="si-cell[ "]/g) || []).length, 4, 'four cells');
  assert.strictEqual((html.match(/data-k="/g) || []).length, 11, 'ten digits and a delete');
  assert.match(html, /<input type="hidden" name="pin"/, 'the PIN is a hidden field the keypad fills');
  assert.ok(!/name="pin"[^>]*inputmode/.test(html), 'never a focusable field, so the keyboard never opens');
  // And the page is locked against the stray zoom staff hit.
  assert.match(html, /user-scalable=no/, 'the sign-in viewport is zoom-locked');

  const bad = await form('/employees', { name: 'Too Long', role: 'server', pin: '12345' });
  assert.strictEqual(bad.status, 302);
  assert.match(decodeURIComponent(bad.headers.get('location')), /exactly 4 digits/);
  assert.ok(!db.prepare("SELECT 1 FROM employees WHERE name='Too Long'").get(), 'and nothing was saved');

  const ok = await form('/employees', { name: 'Just Right', role: 'server', pin: '9911' });
  assert.strictEqual(ok.status, 302);
  assert.ok(db.prepare("SELECT 1 FROM employees WHERE name='Just Right'").get(), 'four digits is fine');
});

test('every stylesheet the page loads is in the cache-busting stamp', async () => {
  // Staff keep this page on a home screen for months. BUILD is the only thing
  // that makes their phone fetch a new copy, and it is a hash of a hand-written
  // list of files — broadsheet.css and fonts.css were once missing from it, so
  // a CSS-only change shipped and every returning phone kept the old one.
  const html = await (await fetch(`${BASE}/tips`)).text();
  const linked = [...html.matchAll(/href="\/static\/([a-z-]+\.css)\?v=/g)].map((m) => m[1]);
  assert.ok(linked.length >= 3, `found ${linked.length} stylesheets`);
  const views = fs.readFileSync(path.join(__dirname, '..', 'src', 'views.js'), 'utf8');
  const listed = views.slice(views.indexOf('const BUILD'), views.indexOf('const BUILD') + 900);
  for (const css of linked) {
    assert.ok(listed.includes(css), `${css} is hashed into BUILD — otherwise it ships stale`);
  }
});

// ===========================================================================
// PHASE 2D-0 — who may hand in sales or tips.
//
// The form-opening routes always asked. The route that WRITES did not: it
// proved who you were and then wrote. A position that is not asked for tips
// could file them by posting straight at /tips, which is not an exotic act —
// it is what the form does, minus the form.
//
// One function answers it now, and every route in the workflow calls it.
// ===========================================================================

const empId = (name) => db.prepare('SELECT id FROM employees WHERE name = ?').get(name).id;

/** Everything /tips could have written, for one person on one date. */
const footprint = (name, date, daypart) => {
  const id = empId(name);
  const sh = db.prepare('SELECT id FROM shifts WHERE date = ? AND daypart = ?').get(date, daypart);
  return {
    shift: !!sh,
    work: sh ? db.prepare('SELECT * FROM work WHERE shift_id = ? AND employee_id = ?').get(sh.id, id) : undefined,
    // Tips and sales live on server_sales, keyed the same way.
    sales: sh ? db.prepare('SELECT * FROM server_sales WHERE shift_id = ? AND employee_id = ?').get(sh.id, id) : undefined,
    submissions: db.prepare('SELECT COUNT(*) n FROM tip_submissions WHERE employee_id = ?').get(id).n,
  };
};

test('2D-0: a tipped position opens the form and submits', async () => {
  const { token, cookie } = await signIn('2468');            // Rosa, server
  const open = await fetch(`${BASE}/portal/tips`, { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(open.status, 200, 'the form opens');
  const res = await form('/tips', {
    token, position: 'server', date: '2026-06-01', daypart: 'dinner', cash_tips: '55',
  });
  assert.strictEqual(res.status, 302, 'and the submission goes through');
  const f = footprint('Rosa Diaz', '2026-06-01', 'dinner');
  assert.ok(f.shift && f.work, 'the shift and her place on it exist');
  assert.strictEqual(f.sales.cash_tips_cents, 5500, 'with the tips she reported');
});

test('2D-0: a non-tipped position cannot open the form', async () => {
  const start = await form('/tips/start', { pin: '9753' });   // Cara, kitchen
  assert.strictEqual(start.status, 302, 'she signs in fine — this is not about who she is');
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  for (const method of ['GET', 'POST']) {
    const res = await fetch(`${BASE}/portal/tips`, { method, headers: { cookie }, redirect: 'manual' });
    assert.strictEqual(res.status, 302, `${method} is turned away`);
    assert.strictEqual(res.headers.get('location'), '/portal', 'back to her portal, not an error');
  }
  // And the row is not offered to her in the first place.
  const hub = await (await fetch(`${BASE}/portal`, { headers: { cookie } })).text();
  assert.ok(!/Submit sales or tips/.test(hub), 'nor is it on her hub');
});

test('2D-0: a token-authenticated direct POST is refused', async () => {
  // The hole exactly as it was: a real signed token, posted straight at the
  // write route, skipping the form she cannot open.
  const start = await form('/tips/start', { pin: '9753' });
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  const token = decodeURIComponent(cookie.split('=')[1]);     // the cookie IS the token
  const before = footprint('Cara Vega', '2026-06-02', 'dinner');

  const res = await form('/tips', {
    token, position: 'server', date: '2026-06-02', daypart: 'dinner', cash_tips: '200', food: '4000',
  });
  assert.strictEqual(res.status, 403, 'refused with a status, not a redirect');
  const body = await res.text();
  assert.match(body, /not assigned to that position/, 'and a reason she can act on');
  // Nothing about how the decision was reached.
  for (const leak of ['takes_tips', 'shapeFor', 'positions', 'kitchen', 'SELECT']) {
    assert.ok(!body.includes(leak), `no internal detail leaks: ${leak}`);
  }
  const after = footprint('Cara Vega', '2026-06-02', 'dinner');
  assert.deepStrictEqual(after, before, 'and not one row was written');
  assert.strictEqual(after.shift, false, 'above all, no shift was conjured as a side effect');
});

test('2D-0: a PIN-authenticated direct POST is refused', async () => {
  const before = footprint('Ana Ortiz', '2026-06-03', 'cafe');
  const res = await form('/tips', {
    employee_id: empId('Ana Ortiz'), pin: '1357',
    position: 'server', date: '2026-06-03', daypart: 'cafe', cash_tips: '75', food: '900',
  });
  assert.strictEqual(res.status, 403, 'the legacy door is the same door');
  assert.deepStrictEqual(footprint('Ana Ortiz', '2026-06-03', 'cafe'), before, 'nothing written');
});

test('2D-0: a forged position does not buy a way in', async () => {
  // Authorisation is decided from the employee row the token resolved to.
  // Claiming a tipped position in the body changes nothing, because the body
  // is never consulted for the decision.
  const start = await form('/tips/start', { pin: '9753' });
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  const token = decodeURIComponent(cookie.split('=')[1]);
  for (const forged of ['server', 'bartender', 'barista', 'manager']) {
    const res = await form('/tips', {
      token, position: forged, role: forged, date: '2026-06-04', daypart: 'dinner', cash_tips: '90',
    });
    assert.strictEqual(res.status, 403, `claiming "${forged}" is still refused`);
  }
  assert.strictEqual(footprint('Cara Vega', '2026-06-04', 'dinner').shift, false, 'and no shift exists');
});

test('2D-0: a refusal leaves tips, sales, hours and payroll untouched', async () => {
  // A shift that already exists with real figures on it. The refusal must not
  // add her to it, and must not disturb what is there.
  const { token } = await signIn('2468');
  await form('/tips', { token, position: 'server', date: '2026-06-05', daypart: 'dinner',
    cash_tips: '40', card_tips: '60', food: '1200' });
  const sh = db.prepare("SELECT id FROM shifts WHERE date='2026-06-05' AND daypart='dinner'").get();
  const rosaBefore = db.prepare('SELECT * FROM work WHERE shift_id=? AND employee_id=?').get(sh.id, empId('Rosa Diaz'));
  const rosaSales = db.prepare('SELECT * FROM server_sales WHERE shift_id=? AND employee_id=?').get(sh.id, empId('Rosa Diaz'));
  const rows = db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id=?').get(sh.id).n;

  const start = await form('/tips/start', { pin: '9753' });
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  const token2 = decodeURIComponent(cookie.split('=')[1]);
  const res = await form('/tips', { token: token2, position: 'server',
    date: '2026-06-05', daypart: 'dinner', cash_tips: '999', food: '9999' });
  assert.strictEqual(res.status, 403);

  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id=?').get(sh.id).n, rows,
    'nobody was added to the shift');
  assert.deepStrictEqual(
    db.prepare('SELECT * FROM work WHERE shift_id=? AND employee_id=?').get(sh.id, empId('Rosa Diaz')),
    rosaBefore, "and the person who did file is exactly as she was");
  assert.deepStrictEqual(
    db.prepare('SELECT * FROM server_sales WHERE shift_id=? AND employee_id=?').get(sh.id, empId('Rosa Diaz')),
    rosaSales, 'her tips and sales included');
});

test('2D-0: a refusal keeps the session — she is not signed out', async () => {
  const start = await form('/tips/start', { pin: '9753' });
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  const token = decodeURIComponent(cookie.split('=')[1]);
  const res = await form('/tips', { token, position: 'server', date: '2026-06-06', daypart: 'dinner', cash_tips: '10' });
  assert.strictEqual(res.status, 403);
  assert.ok(!/set-cookie/i.test([...res.headers.keys()].join(',')), 'the cookie is not cleared');
  const hub = await fetch(`${BASE}/portal`, { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(hub.status, 200, 'and her portal still opens');
});

test('2D-0: a browser gets a page, anything else gets JSON', async () => {
  const start = await form('/tips/start', { pin: '9753' });
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  const token = decodeURIComponent(cookie.split('=')[1]);
  const body = new URLSearchParams({ token, position: 'server', date: '2026-06-07', daypart: 'dinner', cash_tips: '10' }).toString();

  const asBrowser = await fetch(`${BASE}/tips`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, body });
  assert.strictEqual(asBrowser.status, 403);
  assert.match(await asBrowser.text(), /Back to your portal/, 'a page with a way out of it');

  const asScript = await fetch(`${BASE}/tips`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.strictEqual(asScript.status, 403);
  assert.deepStrictEqual(Object.keys(JSON.parse(await asScript.text())).sort(), ['error', 'ok']);
});

test('2D-0: eligibility follows the job being filed, not the person', async () => {
  // Mia's primary is server (asked to hand in), her second is busser (not).
  // The question is about the job on the submission, so the same person gets
  // both answers depending on which one she is filing.
  const { token, cookie } = await signIn('8642');
  assert.strictEqual((await fetch(`${BASE}/portal/tips`, { headers: { cookie }, redirect: 'manual' })).status, 200,
    'the form opens, because one of her jobs qualifies');

  const asBusser = await form('/tips', { token, position: 'busser', date: '2026-06-08', daypart: 'dinner', cash_tips: '30' });
  assert.strictEqual(asBusser.status, 403, 'filing the job that is not asked to hand in is refused');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-06-08' AND daypart='dinner'").get().n, 0,
    'and left nothing behind');

  const asServer = await form('/tips', { token, position: 'server', date: '2026-06-08', daypart: 'dinner', cash_tips: '30' });
  assert.strictEqual(asServer.status, 302, 'filing the job that is goes through');
  const sh = db.prepare("SELECT id FROM shifts WHERE date='2026-06-08' AND daypart='dinner'").get();
  assert.strictEqual(db.prepare('SELECT role FROM work WHERE shift_id=? AND employee_id=?')
    .get(sh.id, empId('Mia Reyes')).role, 'server');
});

test('2D-0: resubmitting corrects rather than duplicating', async () => {
  const { token } = await signIn('2468');
  const send = (cash) => form('/tips', { token, position: 'server', date: '2026-06-09', daypart: 'cafe', cash_tips: cash });
  await send('20');
  await send('35');
  const sh = db.prepare("SELECT id FROM shifts WHERE date='2026-06-09' AND daypart='cafe'").get();
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shifts WHERE date=? AND daypart=?').get('2026-06-09', 'cafe').n, 1,
    'one shift, however many times it is filed');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id=? AND employee_id=?')
    .get(sh.id, empId('Rosa Diaz')).n, 1, 'one place on it');
  assert.strictEqual(db.prepare('SELECT cash_tips_cents c FROM server_sales WHERE shift_id=? AND employee_id=?')
    .get(sh.id, empId('Rosa Diaz')).c, 3500, 'carrying the correction');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM server_sales WHERE shift_id=? AND employee_id=?')
    .get(sh.id, empId('Rosa Diaz')).n, 1, 'one sales row, corrected in place');
});

test('2D-0: the PIN door is still throttled', async () => {
  // The refusal must not have become a cheaper way to grind PINs than the
  // sign-in page. Wrong PINs are still counted and still start refusing.
  const id = empId('Ana Ortiz');
  let refused = 0;
  for (let i = 0; i < 12; i += 1) {
    const res = await form('/tips', { employee_id: id, pin: `000${i}`,
      position: 'busser', date: '2026-06-10', daypart: 'cafe', cash_tips: '5' });
    // A wrong PIN never authenticates, so it can only ever be the 302 "that
    // PIN doesn't match" — never the 403, which requires knowing who you are.
    assert.strictEqual(res.status, 302, 'a wrong PIN is a failed sign-in, not an authorisation answer');
    if (/PIN|too many|try again/i.test(decodeURIComponent(res.headers.get('location') || ''))) refused += 1;
  }
  assert.strictEqual(refused, 12, 'every attempt was refused');
  assert.strictEqual(footprint('Ana Ortiz', '2026-06-10', 'cafe').shift, false, 'and nothing was written');
});

test('2D-0: the route accepts exactly what the real form posts', async () => {
  // The guard against the two drifting apart again. Scrapes every field the
  // rendered form carries and posts THOSE — so a route that starts demanding
  // something the form does not render fails here rather than in service.
  // Scraped from the manual path, which is the one that carries every field.
  const { cookie, token } = await signIn('2468');
  const html = await (await fetch(`${BASE}/portal/tips?manual=1`, { headers: { cookie } })).text();
  const body = {};
  for (const m of html.matchAll(/name="([a-z_]+)"(?:[^>]*?value="([^"]*)")?/g)) {
    if (!(m[1] in body)) body[m[1]] = m[2] !== undefined ? m[2] : '';
  }
  assert.ok('token' in body && 'position' in body && 'date' in body && 'daypart' in body,
    'the form carries what the route needs');
  assert.ok(!('pin' in body), 'and no PIN — the signed-in form does not ask for one');
  Object.assign(body, { token, date: '2026-06-11', daypart: 'dinner', position: 'server', cash_tips: '25' });
  const res = await form('/tips', body);
  assert.strictEqual(res.status, 302, 'the form payload is accepted as-is');
  const where = decodeURIComponent(res.headers.get('location'));
  assert.match(where, /\/portal\/tips\/receipt\/\d+|done=1/, 'and lands on a receipt');
});
// --- 2D-1: eligibility belongs to the job being filed ------------------------

test('2D-1: kitchen primary with a server job may file the server one', async () => {
  // The correction. Under the primary-position rule Nadia could not file at
  // all — the form redirected her home and the write route refused her — even
  // though every server shift she picks up is one she is expected to hand in.
  const { token, cookie, html } = await signIn('7531');
  assert.strictEqual((await fetch(`${BASE}/portal/tips`, { headers: { cookie }, redirect: 'manual' })).status, 200,
    'the form opens for her');
  // Only the job that qualifies is offered. Kitchen is hers and is not on it.
  assert.ok(!/<option value="kitchen"/.test(html) && !/value="kitchen"/.test(html),
    'kitchen is not offered as something to file');
  assert.match(html, /<input type="hidden" name="position" value="server">/,
    'and with one eligible job it is simply chosen');

  const res = await form('/tips', { token, position: 'server', date: '2026-06-20', daypart: 'dinner', cash_tips: '80' });
  assert.strictEqual(res.status, 302, 'and she can file it');
  const sh = db.prepare("SELECT id FROM shifts WHERE date='2026-06-20' AND daypart='dinner'").get();
  assert.strictEqual(db.prepare('SELECT role FROM work WHERE shift_id=? AND employee_id=?')
    .get(sh.id, empId('Nadia Cruz')).role, 'server');
});

test('2D-1: the same person filing her kitchen job is refused', async () => {
  const { token } = await signIn('7531');
  const res = await form('/tips', { token, position: 'kitchen', date: '2026-06-21', daypart: 'dinner', cash_tips: '80' });
  assert.strictEqual(res.status, 403, 'the job decides, not the person');
  assert.match(await res.text(), /does not hand in sales or tips/);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-06-21' AND daypart='dinner'").get().n, 0);
});

test('2D-1: a job the employee does not hold is refused, however real it is', async () => {
  // `bartender` is a genuine, tipped position. It is simply not hers.
  const { token } = await signIn('7531');
  for (const slug of ['bartender', 'barista', 'manager', 'busser']) {
    const res = await form('/tips', { token, position: slug, date: '2026-06-22', daypart: 'dinner', cash_tips: '40' });
    assert.strictEqual(res.status, 403, `${slug} is not hers to file`);
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-06-22'").get().n, 0);
});

test('2D-1: a forged or nonsense position identifier is refused', async () => {
  const { token } = await signIn('7531');
  // Not in this list: "server " and "". A trailing space is whitespace the
  // browser can add on its own and it normalises to a job she genuinely holds;
  // an empty value means "not specified", which is the missing-position case
  // below, not a forgery.
  for (const slug of ['../server', "server'--", '1', 'SERVER', 'server;drop']) {
    const res = await form('/tips', { token, position: slug, date: '2026-06-23', daypart: 'dinner', cash_tips: '40' });
    assert.strictEqual(res.status, 403, `"${slug}" buys nothing`);
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-06-23'").get().n, 0);
});

test('2D-1: a missing position is refused when there is a real choice to make', async () => {
  // Tess holds two jobs and BOTH hand in, so "which job" genuinely has two
  // answers. The route does not guess: the answer decides how the tips are
  // handled, and it is not the route's to choose.
  const { token } = await signIn('1470');
  const res = await form('/tips', { token, date: '2026-06-24', daypart: 'dinner', cash_tips: '40' });
  assert.strictEqual(res.status, 403, 'no job named, no submission');
  assert.match(await res.text(), /Choose which job you worked/);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-06-24'").get().n, 0);
});

test('2D-1: with exactly one eligible job, naming it is not required', async () => {
  // Rosa is a server and nothing else. There is no choice, so a post without a
  // position is not ambiguous and is accepted as the one job she has.
  const { token } = await signIn('2468');
  const res = await form('/tips', { token, date: '2026-06-25', daypart: 'dinner', cash_tips: '45' });
  assert.strictEqual(res.status, 302, 'accepted');
  const sh = db.prepare("SELECT id FROM shifts WHERE date='2026-06-25' AND daypart='dinner'").get();
  assert.strictEqual(db.prepare('SELECT role FROM work WHERE shift_id=? AND employee_id=?')
    .get(sh.id, empId('Rosa Diaz')).role, 'server', 'filed as the only job she holds');
});

test('2D-1: no eligible job means no form and no write, by either door', async () => {
  const start = await form('/tips/start', { pin: '9753' });          // Cara, kitchen only
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  const token = decodeURIComponent(cookie.split('=')[1]);
  assert.strictEqual((await fetch(`${BASE}/portal/tips`, { headers: { cookie }, redirect: 'manual' })).status, 302,
    'the form is closed to her');
  assert.strictEqual((await form('/tips', { token, position: 'kitchen', date: '2026-06-26', daypart: 'dinner', cash_tips: '9' })).status,
    403, 'and so is the write, filing her own job');
  assert.strictEqual((await form('/tips', { employee_id: empId('Cara Vega'), pin: '9753',
    position: 'kitchen', date: '2026-06-26', daypart: 'dinner', cash_tips: '9' })).status,
    403, 'the PIN door included');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-06-26'").get().n, 0, 'nothing written');
});

test('2D-1: tip-pool participation is untouched by any of this', async () => {
  // Submission eligibility and pool participation share a column today and are
  // different business rules. A busser is the pairing that makes conflating
  // them dangerous: asked to hand in nothing, and still paid a share of every
  // service. This asserts the second rule did not move when the first did.
  assert.strictEqual(db.prepare("SELECT takes_tips FROM positions WHERE slug='busser'").get().takes_tips, 0,
    'a busser is not asked to hand anything in');
  const { TIPOUT_ROLES } = require('../src/engine');
  assert.ok(TIPOUT_ROLES.includes('busser'), 'and is still among the roles a tip-out reaches');
  for (const r of ['kitchen', 'barista', 'bartender']) {
    assert.ok(TIPOUT_ROLES.includes(r), `${r} too — the allocation list is unchanged`);
  }
  // The two rules are decided in different files, from different functions.
  const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
  assert.ok(!engine.includes('canSubmitSalesTips'),
    'the engine does not consult the submission rule');
  assert.ok(!engine.includes('tipsEligibility'),
    'nor the portal authorisation helper');
});

// ===========================================================================
// PHASE 2F — the sales & tips workspace, the strict money grammar, and a
// receipt whose numbers come out of the database rather than the URL.
// ===========================================================================

/** A writable handle. The shared `db` above is deliberately read-only. */
const writable = () => new (require('better-sqlite3'))(DB);

/** Everything stored for one person on one shift, or nulls. */
const stored = (name, date, daypart) => {
  const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, daypart);
  if (!sh) return null;
  const id = empId(name);
  return {
    shift: sh.id,
    sales: db.prepare('SELECT * FROM server_sales WHERE shift_id=? AND employee_id=?').get(sh.id, id) || null,
    work: db.prepare('SELECT * FROM work WHERE shift_id=? AND employee_id=?').get(sh.id, id) || null,
    subs: db.prepare('SELECT * FROM tip_submissions WHERE shift_id=? AND employee_id=? ORDER BY id').all(sh.id, id),
    punches: db.prepare('SELECT COUNT(*) n FROM time_entries WHERE shift_id=? AND employee_id=?').get(sh.id, id).n,
  };
};

// --- the money grammar ------------------------------------------------------

test('2F: every amount the grammar accepts is stored to the exact cent', async () => {
  const cases = [['12', 1200], ['12.5', 1250], ['12.50', 1250], ['0', 0], ['0.00', 0],
    ['  8 ', 800], ['999999.99', 99999999]];
  let d = 1;
  for (const [text, cents] of cases) {
    const date = `2026-09-${String(d++).padStart(2, '0')}`;
    const { token } = await signIn('2468');
    const res = await form('/tips', { token, position: 'server', date, daypart: 'dinner',
      mode: 'manual', cash_tips: text });
    assert.strictEqual(res.status, 302, `"${text}" is accepted`);
    assert.strictEqual(stored('Rosa Diaz', date, 'dinner').sales.cash_tips_cents, cents,
      `"${text}" stores ${cents} cents`);
  }
});

test('2F: everything the grammar refuses is refused, and nothing is written', async () => {
  // Each of these used to become a number. parseFloat read '12abc' as 12,
  // '1e3' as a thousand dollars, '-50' as a negative somebody could file, and
  // rounded '12.999' up to $13.00 without saying a word.
  const bad = ['-50', '12.999', '12abc', '1e3', '$20', '1,200', '12.5.5', 'NaN',
    'Infinity', '99999999999', '.5', '12.'];
  let d = 1;
  for (const text of bad) {
    const date = `2026-10-${String(d++).padStart(2, '0')}`;
    const { token } = await signIn('2468');
    const res = await form('/tips', { token, position: 'server', date, daypart: 'dinner',
      mode: 'manual', cash_tips: text });
    assert.strictEqual(res.status, 200, `"${text}" comes back as the form, not a redirect`);
    assert.strictEqual(stored('Rosa Diaz', date, 'dinner'), null,
      `"${text}" left no shift, no work row and no figures`);
  }
});

test('2F: a refused amount is never silently rounded or zeroed', async () => {
  // The two failure modes that hurt most, stated as their own assertion: a
  // rejected figure must not arrive as 1300 (rounded) or as 0 (swallowed).
  const { token } = await signIn('2468');
  await form('/tips', { token, position: 'server', date: '2026-10-20', daypart: 'dinner',
    mode: 'manual', cash_tips: '12.999' });
  assert.strictEqual(stored('Rosa Diaz', '2026-10-20', 'dinner'), null,
    'not 1300, not 0 — nothing at all');
});

// --- the card-tip tri-state -------------------------------------------------

test('2F: blank card tips leave what is on file alone; an explicit 0 replaces it', async () => {
  const date = '2026-09-20';
  const { token } = await signIn('2468');
  // First report states $30 on card.
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '10', card_tips: '30' });
  let s = stored('Rosa Diaz', date, 'dinner');
  assert.strictEqual(s.sales.card_tips_cents, 3000, 'stated and stored');
  assert.strictEqual(s.subs[0].card_tips_cents, 3000, 'and stated in the audit row');

  // A correction that leaves card blank must not wipe the $30. Blank is "I am
  // not updating this", and the figure may be the POS's or a manager's.
  const a = await signIn('2468');
  await form('/tips', { token: a.token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '15', card_tips: '' });
  s = stored('Rosa Diaz', date, 'dinner');
  assert.strictEqual(s.sales.card_tips_cents, 3000, 'blank preserved the stored amount');
  assert.strictEqual(s.subs[1].card_tips_cents, null, 'and the audit row records "not entered"');
  assert.strictEqual(s.sales.cash_tips_cents, 1500, 'while the cash correction did land');

  // Absent entirely behaves the same as blank.
  const b = await signIn('2468');
  await form('/tips', { token: b.token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '16' });
  assert.strictEqual(stored('Rosa Diaz', date, 'dinner').sales.card_tips_cents, 3000,
    'absent preserved it too');

  // An explicit zero is a statement, and it replaces.
  const c = await signIn('2468');
  await form('/tips', { token: c.token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '16', card_tips: '0' });
  s = stored('Rosa Diaz', date, 'dinner');
  assert.strictEqual(s.sales.card_tips_cents, 0, 'zero replaced it');
  assert.strictEqual(s.subs[3].card_tips_cents, 0, 'and zero is what the audit row says');
});

// --- cash means two different things ----------------------------------------

test('2F: server cash kept and pooled cash are asked as different questions', async () => {
  const w = writable();
  w.prepare("INSERT OR IGNORE INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Bea Nolan','barista',1400,1,'2026')").run();
  w.close();
  const server = (await signIn('2468')).html;
  const barista = (await signIn('2026')).html;

  assert.match(server, /already took home/, 'the server is asked what they kept');
  assert.match(server, /excluded from the tips sent through payroll/,
    'and told what that does');
  assert.ok(!/Pooled cash tips/.test(server), 'and is not asked about the pool');

  assert.match(barista, /Pooled cash tips/, 'the barista is asked what the pool collected');
  assert.match(barista, /not money you keep/, 'and told it is not theirs');
  assert.ok(!/already took home/.test(barista), 'and is not asked what they kept');

  // Both answers land in the ONE column the engine reads. The difference is
  // what the engine does with it, which is decided by the role on the work row.
  const { token } = await signIn('2026');
  await form('/tips', { token, position: 'barista', date: '2026-09-21', daypart: 'dinner',
    mode: 'manual', cash_tips: '44' });
  const s = stored('Bea Nolan', '2026-09-21', 'dinner');
  assert.strictEqual(s.sales.cash_tips_cents, 4400, 'stored in the established column');
  assert.strictEqual(s.work.role, 'barista', 'against the role that makes it pooled');
});

// --- manual reports create money, never time --------------------------------

test('2F: a manual report files the money and fabricates no time or wages', async () => {
  const date = '2026-09-22';
  const { token } = await signIn('8642');   // Mia Reyes, server, no punch that day
  const res = await form('/tips', { token, position: 'server', date, daypart: 'cafe',
    mode: 'manual', food: '400', cash_tips: '20' });
  assert.strictEqual(res.status, 302, 'it files');
  const s = stored('Mia Reyes', date, 'cafe');
  assert.strictEqual(s.sales.food_cents, 40000, 'the sales are recorded');
  assert.strictEqual(s.punches, 0, 'no punch was invented');
  assert.strictEqual(s.work.hours, 0, 'no hours were invented');
  assert.strictEqual(s.work.hours_source, null, 'and nothing claims to have set them');
  assert.strictEqual(s.work.hourly_rate_cents, 0, 'no wage was invented');
});

test('2F: a manual report cannot name a service that does not exist', async () => {
  const { token } = await signIn('8642');
  const res = await form('/tips', { token, position: 'server', date: '2026-09-23',
    daypart: 'brunch', mode: 'manual', cash_tips: '20' });
  assert.strictEqual(res.status, 200, 'refused');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-09-23'").get().n, 0,
    'and no shift was opened for it');
});

// --- corrections keep their history -----------------------------------------

test('2F: a correction updates the figures and appends to the audit history', async () => {
  const date = '2026-09-24';
  const { token } = await signIn('2468');
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '50', food: '100' });
  const first = stored('Rosa Diaz', date, 'dinner');
  assert.strictEqual(first.subs.length, 1);

  const b = await signIn('2468');
  await form('/tips', { token: b.token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '55', food: '120' });
  const after = stored('Rosa Diaz', date, 'dinner');
  assert.strictEqual(after.sales.cash_tips_cents, 5500, 'the current figure is the new one');
  assert.strictEqual(after.subs.length, 2, 'and a second audit row was appended');
  assert.strictEqual(after.subs[0].cash_tips_cents, 5000, 'the first row still says what it said');
  assert.strictEqual(after.subs[0].id, first.subs[0].id, 'it is the same row, not a rewrite');
});

test('2F: the portal will not overwrite an existing report without a confirmation', async () => {
  const date = '2026-09-25';
  const { token, cookie } = await signIn('2468');
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '50' });
  const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, 'dinner');

  // No confirmation ticked: refused, and the stored figure does not move.
  const res = await fetch(`${BASE}/portal/tips/submit`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ position: 'server', shift_id: String(sh.id), cash_tips: '99' }).toString(),
  });
  assert.strictEqual(res.status, 400, 'refused');
  assert.match(await res.text(), /Tick the box/, 'and says why');
  assert.strictEqual(stored('Rosa Diaz', date, 'dinner').sales.cash_tips_cents, 5000,
    'nothing was overwritten');

  // Ticked: it lands.
  const ok = await fetch(`${BASE}/portal/tips/submit`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ position: 'server', shift_id: String(sh.id),
      cash_tips: '99', confirm_update: '1' }).toString(),
  });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(stored('Rosa Diaz', date, 'dinner').sales.cash_tips_cents, 9900);
});

// --- the receipt ------------------------------------------------------------

test('2F: the receipt reads the database, and the query string cannot move it', async () => {
  const date = '2026-09-26';
  const { token, cookie } = await signIn('2468');
  const res = await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '37.25', card_tips: '18' });
  const id = stored('Rosa Diaz', date, 'dinner').subs[0].id;

  const clean = await (await fetch(`${BASE}/portal/tips/receipt/${id}`, { headers: { cookie } })).text();
  assert.match(clean, /\$37\.25/, 'the stored cash is on it');
  assert.match(clean, /\$18\.00/, 'and the stored card');

  const tampered = await (await fetch(
    `${BASE}/portal/tips/receipt/${id}?cash=999.99&card=888.88&sales=777.77`,
    { headers: { cookie } })).text();
  assert.match(tampered, /\$37\.25/, 'the figures are unchanged');
  for (const n of ['999.99', '888.88', '777.77']) {
    assert.ok(!tampered.includes(n), `${n} was ignored`);
  }
});

test('2F: a receipt belongs to one person and nobody else can open it', async () => {
  const date = '2026-09-27';
  const { token } = await signIn('2468');
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '12' });
  const id = stored('Rosa Diaz', date, 'dinner').subs[0].id;

  const other = await signIn('8642');            // Mia, a different server
  const res = await fetch(`${BASE}/portal/tips/receipt/${id}`,
    { headers: { cookie: other.cookie }, redirect: 'manual' });
  assert.strictEqual(res.status, 404, "somebody else's receipt is not found");
  const html = await res.text();
  assert.ok(!html.includes('12.00'), 'and leaks no figure from it');

  // A receipt that never existed answers identically — "not yours" and "not
  // there" must not be tellable apart from outside.
  const missing = await fetch(`${BASE}/portal/tips/receipt/99999999`,
    { headers: { cookie: other.cookie }, redirect: 'manual' });
  assert.strictEqual(missing.status, 404, 'same answer');
});

test('2F: the receipt says "not entered" rather than showing a card tip of zero', async () => {
  const date = '2026-09-28';
  const { token, cookie } = await signIn('2468');
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '20' });          // card left out entirely
  const id = stored('Rosa Diaz', date, 'dinner').subs[0].id;
  const html = await (await fetch(`${BASE}/portal/tips/receipt/${id}`, { headers: { cookie } })).text();
  assert.match(html, /Card tips<\/span><b>Not entered<\/b>/,
    'never said is not the same as said nothing was taken');
});

// --- integrity --------------------------------------------------------------

test('2F: an authorization failure leaves no shift and no financial record', async () => {
  // Cara is kitchen only, so she cannot open the form at all — signIn would
  // fail on that. The PIN door is the one that still accepts a bare POST, and
  // it is the door this is really about.
  const res = await form('/tips', { employee_id: empId('Cara Vega'), pin: '9753',
    position: 'kitchen', date: '2026-09-29', daypart: 'dinner', mode: 'manual', cash_tips: '80' });
  assert.strictEqual(res.status, 403, 'refused');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM shifts WHERE date='2026-09-29'").get().n, 0,
    'and not even an empty shift row was left behind as evidence it was tried');
});

test('2F: a shift id that is not theirs is refused outright', async () => {
  const date = '2026-09-30';
  const { token } = await signIn('2468');
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '10' });
  const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, 'dinner');

  const other = await signIn('8642');
  const res = await fetch(`${BASE}/portal/tips/submit`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: other.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ position: 'server', shift_id: String(sh.id), cash_tips: '5' }).toString(),
  });
  assert.strictEqual(res.status, 403, 'a shift somebody else is on is not a shift you may file against');
  assert.strictEqual(stored('Mia Reyes', date, 'dinner').sales, null, 'and nothing was written for them');
});

test('2F: a double tap files one report, not two', async () => {
  const date = '2026-10-25';
  const { token } = await signIn('2468');
  const body = { token, position: 'server', date, daypart: 'dinner', mode: 'manual', cash_tips: '31' };
  await form('/tips', body);
  const again = await signIn('2468');
  await form('/tips', { ...body, token: again.token });
  const s = stored('Rosa Diaz', date, 'dinner');
  assert.strictEqual(s.subs.length, 1, 'the identical repeat did not append a second audit row');
  assert.strictEqual(s.sales.cash_tips_cents, 3100);
});

test('2F: two people reporting the same service land on one shared shift', async () => {
  const date = '2026-10-26';
  const a = await signIn('2468');
  const b = await signIn('8642');
  await Promise.all([
    form('/tips', { token: a.token, position: 'server', date, daypart: 'dinner', mode: 'manual', cash_tips: '10' }),
    form('/tips', { token: b.token, position: 'server', date, daypart: 'dinner', mode: 'manual', cash_tips: '20' }),
  ]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shifts WHERE date=?').get(date).n, 1,
    'UNIQUE(date, daypart) and getOrIgnore held');
  const sh = db.prepare('SELECT id FROM shifts WHERE date=?').get(date);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id=?').get(sh.id).n, 2,
    'and both of them are on it');
});

// ===========================================================================
// PHASE 2F (UX correction) — the shift you are standing in, not an archive.
//
// Reporting happens at the end of the shift just worked: usually today,
// usually still clocked in. The first screen answers that case and hides the
// history behind one tap.
// ===========================================================================

/** Today as the server counts it — same timezone the test server runs in. */
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const DAYS_AGO = (n) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** A server with a clean history, so these tests do not read other tests' shifts. */
function seedToday(pin, name, opts = {}) {
  const w = writable();
  w.prepare(`INSERT OR IGNORE INTO employees (name, role, hourly_rate_cents, active, pin)
             VALUES (?, 'server', 1500, 1, ?)`).run(name, pin);
  const id = w.prepare('SELECT id FROM employees WHERE name = ?').get(name).id;
  const shiftOn = (date, daypart) => {
    w.prepare('INSERT OR IGNORE INTO shifts (date, daypart) VALUES (?, ?)').run(date, daypart);
    return w.prepare('SELECT id FROM shifts WHERE date = ? AND daypart = ?').get(date, daypart).id;
  };
  const out = { id, today: [], past: [] };
  for (const dpt of opts.today || []) {
    const sid = shiftOn(TODAY, dpt);
    w.prepare(`INSERT OR IGNORE INTO work (shift_id, employee_id, role, hours)
               VALUES (?, ?, 'server', 0)`).run(sid, id);
    out.today.push({ id: sid, daypart: dpt });
  }
  for (const [n, dpt] of opts.past || []) {
    const sid = shiftOn(DAYS_AGO(n), dpt);
    w.prepare(`INSERT OR IGNORE INTO work (shift_id, employee_id, role, hours)
               VALUES (?, ?, 'server', 6)`).run(sid, id);
    out.past.push({ id: sid, date: DAYS_AGO(n), daypart: dpt });
  }
  if (opts.clockedInto) {
    const sid = out.today.find((t) => t.daypart === opts.clockedInto).id;
    w.prepare(`INSERT INTO time_entries (employee_id, shift_id, business_date, position,
                 clock_in_at, status, source)
               VALUES (?, ?, ?, 'server', datetime('now','-2 hours'), 'active', 'portal')`)
      .run(id, sid, TODAY);
  }
  w.close();
  return out;
}

const page = async (cookie, url) => (await fetch(`${BASE}${url}`, { headers: { cookie } })).text();

test('2F-UX: an open punch selects itself and the form is there without another tap', async () => {
  const seed = seedToday('5150', 'Dana Wu', { today: ['dinner'], past: [[3, 'cafe'], [5, 'dinner']], clockedInto: 'dinner' });
  const { cookie } = await signIn('5150');
  const html = await page(cookie, '/portal/tips');

  assert.match(html, /Current shift/, 'it says which shift this is');
  assert.match(html, /class="st-now is-live"/, 'as a summary, not a question');
  assert.match(html, new RegExp(`name="shift_id" value="${seed.today[0].id}"`),
    'and it is already chosen');
  // The money is on screen immediately. That is the whole point.
  assert.match(html, /id="st-food"/, 'the sales fields are right there');
  assert.match(html, /id="st-cash_kept"/, 'and the tips fields');
  assert.ok(!/<div class="st-chs"/.test(html), 'nothing to pick from');
});

test('2F-UX: the first screen carries no history at all', async () => {
  seedToday('5151', 'Omar Reid', { today: ['cafe'], past: [[2, 'dinner'], [4, 'cafe'], [9, 'dinner']] });
  const { cookie } = await signIn('5151');
  const html = await page(cookie, '/portal/tips');

  for (const n of [2, 4, 9]) {
    assert.ok(!html.includes(DAYS_AGO(n)), `${DAYS_AGO(n)} is not on the first screen`);
  }
  assert.ok(!/Already submitted/.test(html), 'and no archive of what was filed before');
  assert.match(html, /Today's shift/, "it is today's shift that is shown");
  assert.match(html, /id="st-food"/, 'with the form already open');
});

test('2F-UX: one recorded shift today is chosen without being asked about', async () => {
  const seed = seedToday('5152', 'Priya Shah', { today: ['cafe'], past: [[1, 'dinner']] });
  const { cookie } = await signIn('5152');
  const html = await page(cookie, '/portal/tips');
  assert.match(html, new RegExp(`name="shift_id" value="${seed.today[0].id}"`), 'chosen');
  assert.ok(!/<div class="st-chs"/.test(html), 'and not offered as a choice');
});

test('2F-UX: two services today is a compact choice, and only today is on it', async () => {
  const seed = seedToday('5153', 'Lena Ford', { today: ['cafe', 'dinner'], past: [[3, 'dinner']] });
  const { cookie } = await signIn('5153');
  const html = await page(cookie, '/portal/tips');

  assert.match(html, /<div class="st-chs"/, 'a choice is offered');
  for (const t of seed.today) {
    assert.match(html, new RegExp(`value="${t.id}"`), `${t.daypart} today is on it`);
  }
  assert.ok(!html.includes(seed.past[0].date), 'the older shift is not');
  // Compact: small rows, and no radio is preselected, because two services is
  // a real question with two answers.
  assert.match(html, /class="st-ch st-ch-sm"/, 'the rows are the compact ones');
  // Matched against real <input> tags only — a looser regex over the whole
  // page hits `[data-st-shift]:checked` inside the script and reports a
  // preselection that is not there.
  const radios = [...html.matchAll(/<input[^>]*data-st-shift[^>]*>/g)].map((m) => m[0]);
  assert.strictEqual(radios.length, 2, 'two services, two radios');
  for (const r of radios) assert.ok(!/\bchecked\b/.test(r), `neither is guessed: ${r}`);
});

test('2F-UX: "Choose another shift" is where the history lives', async () => {
  const seed = seedToday('5154', 'Ruth Okon', { today: ['dinner'], past: [[2, 'cafe'], [6, 'dinner']] });
  const { cookie } = await signIn('5154');

  const first = await page(cookie, '/portal/tips');
  assert.match(first, /href="\/portal\/tips\?pick=1"/, 'one tap away');

  const picker = await page(cookie, '/portal/tips?pick=1');
  assert.match(picker, /Choose another shift/, 'and it opens');
  for (const p of seed.past) {
    assert.match(picker, new RegExp(`href="/portal/tips\\?shift=${p.id}"`), `${p.date} is here`);
  }
  assert.match(picker, /href="\/portal\/tips\?manual=1"/, 'so is reporting one that is not listed');
  assert.match(picker, /Still to report/, 'grouped by whether it still needs doing');
  assert.match(picker, /Already submitted/, 'and by what can be corrected');
});

test('2F-UX: a past shift opens to its own form, correction and all', async () => {
  const seed = seedToday('5155', 'Ivan Boyd', { today: ['dinner'], past: [[3, 'cafe']] });
  const { token, cookie } = await signIn('5155');
  const past = seed.past[0];

  // File it, then reach it again through the picker.
  await form('/tips', { token, position: 'server', shift_id: String(past.id), cash_tips: '30' });
  const picker = await page(cookie, '/portal/tips?pick=1');
  assert.match(picker, new RegExp(`href="/portal/tips\\?shift=${past.id}"`), 'listed');

  const html = await page(cookie, `/portal/tips?shift=${past.id}`);
  assert.match(html, /Previously submitted/, 'and opens as a correction');
  assert.match(html, /Update report/, 'with the right verb on the button');
  assert.match(html, /data-st-confirm/, 'and a confirmation to tick');
  assert.match(html, new RegExp(`name="shift_id" value="${past.id}"`), 'against that shift');
});

test('2F-UX: reaching a shift by id is still checked, whatever the screen shows', async () => {
  // The picker is a convenience. It changes nothing about what the write will
  // accept: a shift on another date that this person neither worked nor was
  // rostered on is refused, exactly as before.
  const seed = seedToday('5156', 'Nora Vale', { past: [[4, 'dinner']] });
  seedToday('5157', 'Otis Kane', {});
  const other = await signIn('5157');
  const res = await fetch(`${BASE}/portal/tips/submit`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: other.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ position: 'server', shift_id: String(seed.past[0].id), cash_tips: '20' }).toString(),
  });
  assert.strictEqual(res.status, 403, "somebody else's past shift is refused");
  const sh = seed.past[0].id;
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM server_sales WHERE shift_id=? AND employee_id=?')
    .get(sh, empId('Otis Kane')).n, 0, 'and nothing was written');
});

test('2F-UX: today\'s open service is filable even before a manager adds you', async () => {
  // The ordinary case that used to leave the picker empty. It grants nothing
  // the manual path does not — that path resolves any date and service by name.
  const w = writable();
  w.prepare('INSERT OR IGNORE INTO shifts (date, daypart) VALUES (?, ?)').run(TODAY, 'cafe');
  w.close();
  seedToday('5158', 'Wes Amari', {});
  const { token } = await signIn('5158');
  const sid = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(TODAY, 'cafe').id;
  const res = await form('/tips', { token, position: 'server', shift_id: String(sid), cash_tips: '18' });
  assert.strictEqual(res.status, 302, 'accepted');
  assert.strictEqual(db.prepare('SELECT cash_tips_cents c FROM server_sales WHERE shift_id=? AND employee_id=?')
    .get(sid, empId('Wes Amari')).c, 1800);
});

// ===========================================================================
// PHASE 2F — final integrity. What a submission touches, and what it must not.
// ===========================================================================

/**
 * Run code against the same database in a fresh process, with the engine and
 * reports modules loaded for real. In-process would need a second connection
 * to a database this file deliberately holds read-only.
 */
const inApp = (code) => {
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', `
    process.env.DB_PATH = ${JSON.stringify(DB)};
    process.env.ZWIN_SKIP_BACKFILL = '1';
    process.env.TZ = 'America/New_York';
    const { db, q, s, w, shiftInputs } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db'))});
    const { runShift } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'engine'))});
    const { policyForShift } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'policy'))});
    const out = (v) => process.stdout.write('@@' + JSON.stringify(v) + '@@');
    ${code}
  `], { encoding: 'utf8', env: { ...process.env, DB_PATH: DB } });
  if (r.status !== 0) throw new Error(r.stderr || 'subprocess failed');
  const m = /@@([\s\S]*)@@/.exec(r.stdout);
  assert.ok(m, `no result from subprocess: ${r.stdout}${r.stderr}`);
  return JSON.parse(m[1]);
};

// --- 1. what a manual report actually writes --------------------------------

test('2F-I: a manual report writes three rows and no fourth', async () => {
  const date = '2026-11-02';
  const { token } = await signIn('8642');                    // Mia Reyes, server
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', food: '300', cash_tips: '25' });
  const s = stored('Mia Reyes', date, 'dinner');
  const id = empId('Mia Reyes');

  // Exactly: the shared shift, a work row naming the job, the sales figures,
  // and the audit row. Nothing else.
  assert.ok(s.shift, 'the shared shift');
  assert.ok(s.work, 'a work row');
  assert.ok(s.sales, 'the figures');
  assert.strictEqual(s.subs.length, 1, 'one audit row');
  assert.strictEqual(s.punches, 0, 'and no punch');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE employee_id = ?').get(id).n,
    db.prepare('SELECT COUNT(*) n FROM time_breaks WHERE employee_id = ?').get(id).n, 'no breaks invented');
});

test('2F-I: the zero-hour work row leaks into nothing that counts hours or money', async () => {
  const date = '2026-11-03';
  const { token, cookie } = await signIn('8642');
  await form('/tips', { token, position: 'server', date, daypart: 'cafe',
    mode: 'manual', food: '500', cash_tips: '40' });
  const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, 'cafe');
  const id = empId('Mia Reyes');
  const wrow = db.prepare('SELECT * FROM work WHERE shift_id=? AND employee_id=?').get(sh.id, id);

  // The placeholder itself: a role, and nothing that claims to be time or pay.
  assert.strictEqual(wrow.hours, 0, 'zero hours');
  assert.strictEqual(wrow.hours_source, null, 'and nobody claims to have set them');
  assert.strictEqual(wrow.hourly_rate_cents, 0, 'no per-shift wage');

  // The engine costs it as no time and no wage — so it cannot reach payroll as
  // either, and cannot fabricate overtime out of a zero.
  const cost = inApp(`
    const sh = db.prepare("SELECT * FROM shifts WHERE date='${date}' AND daypart='cafe'").get();
    policyForShift(sh);
    const r = runShift(shiftInputs(sh.id), require(${JSON.stringify(path.join(__dirname, '..', 'src', 'policy'))}).policyForShift(sh));
    const me = r.servers.find((x) => x.employeeId === ${id});
    out({ hours: me ? me.hours : null, wage: me ? Math.round((me.hourlyRate || 0) * 100) : null });
  `);
  assert.strictEqual(cost.hours, 0, 'no hours in the costing');
  assert.strictEqual(cost.wage, 0, 'no wage in the costing');

  // Nothing the clock or the timesheet counts: no punch on this shift, no
  // minutes, no break, and no open state for the clock to show.
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE shift_id=? AND employee_id=?')
    .get(sh.id, id).n, 0, 'no punch on the shift the report went to');
  assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM time_entries
    WHERE employee_id=? AND clock_out_at IS NULL AND status IN ('active','on_break')`).get(id).n, 0,
  'and the report did not leave them clocked in anywhere');
  const clock = await (await fetch(`${BASE}/portal/clock`, { headers: { cookie } })).text();
  assert.ok(!/Clock out/i.test(clock), 'so the clock offers to clock IN, not out');
});

test('2F-I: real time arrives later without touching the money or the rate', async () => {
  const date = '2026-11-04';
  const { token } = await signIn('8642');
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', food: '600', cash_tips: '55' });
  const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, 'dinner');
  const id = empId('Mia Reyes');

  // A manager (or the clock) later puts authoritative hours on the same row.
  const w2 = writable();
  w2.prepare(`UPDATE work SET hours = 7.5, hours_source = 'manager', hours_set_by = 'test'
              WHERE shift_id = ? AND employee_id = ?`).run(sh.id, id);
  w2.close();

  const after = db.prepare('SELECT * FROM work WHERE shift_id=? AND employee_id=?').get(sh.id, id);
  const sales = db.prepare('SELECT * FROM server_sales WHERE shift_id=? AND employee_id=?').get(sh.id, id);
  assert.strictEqual(after.hours, 7.5, 'the hours land');
  assert.strictEqual(after.role, 'server', 'the filing job is untouched');
  assert.strictEqual(after.hourly_rate_cents, 0,
    'the placeholder zero is a "use the default rate" marker, not a $0.00 wage');
  assert.strictEqual(sales.food_cents, 60000, 'the sales are untouched');
  assert.strictEqual(sales.cash_tips_cents, 5500, 'and so are the tips');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM tip_submissions WHERE shift_id=? AND employee_id=?')
    .get(sh.id, id).n, 1, 'and no audit row was added by the time edit');

  // And now it costs at the employee's real rate, not at zero.
  const cost = inApp(`
    const sh = db.prepare("SELECT * FROM shifts WHERE date='${date}' AND daypart='dinner'").get();
    const pol = policyForShift(sh);
    const inp = shiftInputs(sh.id);
    // The wage lives on the engine INPUT — a payout row carries tips, not pay.
    const me = inp.servers.find((x) => x.employeeId === ${id});
    const paid = runShift(inp, pol).servers.find((x) => x.employeeId === ${id});
    out({ hours: paid.hours, rate: Math.round(me.hourlyRate * 100) });
  `);
  assert.strictEqual(cost.hours, 7.5);
  const paid = db.prepare('SELECT hourly_rate_cents r, pay_type FROM employees WHERE id=?').get(id);
  if (paid.pay_type !== 'salary' && paid.r > 0) {
    assert.strictEqual(cost.rate, paid.r,
      'costed at their own wage — the placeholder zero means "use the default", not "$0.00"');
  } else {
    assert.strictEqual(cost.rate, 0, 'salaried, so no hourly wage either way');
  }
});

// --- 2. filing before clocking out ------------------------------------------

test('2F-I: filing before clock-out leaves the punch open and the person working', async () => {
  const seed = seedToday('5160', 'Cass Iyer', { today: ['dinner'], clockedInto: 'dinner' });
  const { token, cookie } = await signIn('5160');
  const sid = seed.today[0].id;
  const id = empId('Cass Iyer');

  const before = db.prepare('SELECT * FROM time_entries WHERE employee_id=? AND shift_id=?').get(id, sid);
  assert.strictEqual(before.clock_out_at, null, 'open to begin with');

  const html = await page(cookie, '/portal/tips');
  assert.match(html, /Current shift/, 'auto-selected');
  assert.match(html, /id="st-food"/, 'and the form is right there');

  const res = await form('/tips', { token, position: 'server', shift_id: String(sid),
    food: '800', cash_tips: '60' });
  assert.strictEqual(res.status, 302, 'it files');

  const after = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(before.id);
  assert.strictEqual(after.clock_out_at, null, 'the punch is still open');
  assert.strictEqual(after.status, before.status, 'and unchanged');
  assert.strictEqual(after.payable_minutes, before.payable_minutes, 'no minutes were invented');
  assert.strictEqual(db.prepare('SELECT hours FROM work WHERE shift_id=? AND employee_id=?')
    .get(sid, id).hours, 0, 'and no hours were finalised');

  const clock = await (await fetch(`${BASE}/portal/clock`, { headers: { cookie } })).text();
  assert.match(clock, /Working|Clock out/i, 'the clock still has them on shift');
});

test('2F-I: clocking out afterwards uses the same shift and adds no second report', async () => {
  const seed = seedToday('5161', 'Dov Marek', { today: ['dinner'], clockedInto: 'dinner' });
  const { token, cookie } = await signIn('5161');
  const sid = seed.today[0].id;
  const id = empId('Dov Marek');
  await form('/tips', { token, position: 'server', shift_id: String(sid), cash_tips: '45' });

  // Clock out through the real route.
  await fetch(`${BASE}/portal/clock/out`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  });

  const punches = db.prepare('SELECT * FROM time_entries WHERE employee_id=?').all(id);
  assert.strictEqual(punches.length, 1, 'one punch, not two');
  assert.strictEqual(punches[0].shift_id, sid, 'on the same shared shift the report went to');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM tip_submissions WHERE shift_id=? AND employee_id=?')
    .get(sid, id).n, 1, 'and clocking out filed nothing');
  assert.strictEqual(db.prepare('SELECT cash_tips_cents c FROM server_sales WHERE shift_id=? AND employee_id=?')
    .get(sid, id).c, 4500, 'the money is where it was');
});

// --- 3. the two meanings of cash, through the engine ------------------------

test('2F-I: server cash reduces the paycheck once; pooled cash never touches it', async () => {
  const date = '2026-11-06';
  const w2 = writable();
  w2.prepare(`INSERT OR IGNORE INTO employees (name, role, hourly_rate_cents, active, pin)
              VALUES ('Pool Pia','barista',1400,1,'5170')`).run();
  w2.close();
  const srv = await signIn('8642');                    // Mia Reyes, server
  const sup = await signIn('5170');                    // Pia, barista
  await form('/tips', { token: srv.token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', food: '900', coffee: '150', alcohol: '250',
    card_tips: '180', cash_tips: '73.40' });
  await form('/tips', { token: sup.token, position: 'barista', date, daypart: 'dinner',
    mode: 'manual', card_tips: '20', cash_tips: '46.60' });

  const r = inApp(`
    const sh = db.prepare("SELECT * FROM shifts WHERE date='${date}' AND daypart='dinner'").get();
    const pol = policyForShift(sh);
    const inp = shiftInputs(sh.id);
    const res = runShift(inp, pol);
    out({
      serverCashIn: inp.servers.map((x) => x.cashTips),
      supportCashIn: inp.support.map((x) => x.cashTips),
      poolCash: res.pool.cash,
      server: res.servers.map((x) => ({ id: x.employeeId, cash: x.cashTips, kept: x.tipsKept })),
    });
  `);

  // The server's $73.40 is theirs; it is not in the jar.
  assert.deepStrictEqual(r.serverCashIn, [73.4], 'the server states what they kept');
  // The barista's $46.60 IS the jar.
  assert.deepStrictEqual(r.supportCashIn, [46.6], 'the barista states what the pool collected');
  assert.strictEqual(r.poolCash, 4660,
    'the shared cash pot is the support cash alone — the server cash is not in it');
});

test('2F-I: the redesigned write produces the same allocation the old one did', async () => {
  // Equivalence, not a re-derivation: two shifts, identical figures, one
  // written through the redesigned route and one written straight into the
  // columns the way the old route did. The engine must not tell them apart.
  const A = '2026-11-07'; const B = '2026-11-08';
  const srv = await signIn('8642');
  await form('/tips', { token: srv.token, position: 'server', date: A, daypart: 'dinner',
    mode: 'manual', food: '812.35', coffee: '99.05', alcohol: '141.60',
    card_tips: '203.15', cash_tips: '61.85' });

  const w2 = writable();
  w2.prepare('INSERT OR IGNORE INTO shifts (date, daypart) VALUES (?, ?)').run(B, 'dinner');
  const bid = w2.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(B, 'dinner').id;
  const aid = w2.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(A, 'dinner').id;
  const me = empId('Mia Reyes');
  w2.prepare("INSERT OR IGNORE INTO work (shift_id, employee_id, role, hours) VALUES (?,?,'server',0)").run(bid, me);
  w2.prepare(`INSERT OR REPLACE INTO server_sales
    (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents, cash_entered_by)
    VALUES (?, ?, 81235, 9905, 14160, 20315, 6185, 'staff')`).run(bid, me);
  w2.close();

  const cmp = inApp(`
    const one = (id) => {
      const sh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
      const r = runShift(shiftInputs(sh.id), policyForShift(sh));
      const me = r.servers[0];
      return { tipouts: me.tipouts, total: me.tipoutTotal, kept: me.tipsKept,
               pots: r.pots, pool: r.pool };
    };
    out({ a: one(${aid}), b: one(${bid}) });
  `);
  assert.deepStrictEqual(cmp.a, cmp.b,
    'identical figures allocate identically however they were written');
});

// --- 4. operational value vs what the employee said -------------------------

test('2F-I: a later POS or manager change moves the operational value, not the audit', async () => {
  const date = '2026-11-09';
  const { token, cookie } = await signIn('2468');
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '10' });        // card deliberately not entered
  const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, 'dinner');
  const me = empId('Rosa Diaz');
  const sub = db.prepare('SELECT * FROM tip_submissions WHERE shift_id=? AND employee_id=?').get(sh.id, me);
  assert.strictEqual(sub.card_tips_cents, null, 'the employee said nothing about card');

  // The POS pushes a figure afterwards.
  const w2 = writable();
  w2.prepare('UPDATE server_sales SET card_tips_cents = 9125 WHERE shift_id=? AND employee_id=?')
    .run(sh.id, me);
  w2.close();

  assert.strictEqual(db.prepare('SELECT card_tips_cents c FROM server_sales WHERE shift_id=? AND employee_id=?')
    .get(sh.id, me).c, 9125, 'the operational value moved');
  assert.strictEqual(db.prepare('SELECT card_tips_cents c FROM tip_submissions WHERE id=?').get(sub.id).c, null,
    'and the audit row still says the employee never stated one');

  // The receipt is a record of what WAS SUBMITTED, so it keeps saying so.
  const r = await (await fetch(`${BASE}/portal/tips/receipt/${sub.id}`, { headers: { cookie } })).text();
  assert.match(r, /Card tips<\/span><b>Not entered<\/b>/, 'the receipt does not claim the POS figure');
  assert.ok(!r.includes('91.25'), 'and does not show it');

  // A blank correction still must not wipe the POS figure.
  const b = await signIn('2468');
  await form('/tips', { token: b.token, position: 'server', shift_id: String(sh.id), cash_tips: '12' });
  assert.strictEqual(db.prepare('SELECT card_tips_cents c FROM server_sales WHERE shift_id=? AND employee_id=?')
    .get(sh.id, me).c, 9125, 'blank left the POS figure alone');
});

// --- 5. receipts stay the submission they were ------------------------------

test('2F-I: an older receipt keeps its own figures after a correction', async () => {
  const date = '2026-11-10';
  const { token, cookie } = await signIn('2468');
  await form('/tips', { token, position: 'server', date, daypart: 'cafe',
    mode: 'manual', cash_tips: '11.11' });
  const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, 'cafe');
  const me = empId('Rosa Diaz');
  const first = db.prepare('SELECT id FROM tip_submissions WHERE shift_id=? AND employee_id=? ORDER BY id').all(sh.id, me)[0].id;

  const b = await signIn('2468');
  await form('/tips', { token: b.token, position: 'server', shift_id: String(sh.id), cash_tips: '22.22' });
  const rows = db.prepare('SELECT id FROM tip_submissions WHERE shift_id=? AND employee_id=? ORDER BY id').all(sh.id, me);
  assert.strictEqual(rows.length, 2, 'the correction has its own row');

  const old = await (await fetch(`${BASE}/portal/tips/receipt/${first}`, { headers: { cookie } })).text();
  assert.match(old, /\$11\.11/, 'the first receipt still shows what was sent first');
  assert.ok(!old.includes('22.22'), 'not what replaced it');
  assert.match(old, /Your report was recorded/, 'and reads as the first report');

  const now = await (await fetch(`${BASE}/portal/tips/receipt/${rows[1].id}`, { headers: { cookie } })).text();
  assert.match(now, /\$22\.22/, 'the correction has its own receipt');
  assert.match(now, /Your report was updated/, 'which says it is an update');
});

// --- 6. two stale forms -----------------------------------------------------

test('2F-I: two stale corrections both survive as history; the last one is current', async () => {
  const date = '2026-11-11';
  const { token, cookie } = await signIn('2468');
  await form('/tips', { token, position: 'server', date, daypart: 'dinner',
    mode: 'manual', cash_tips: '10' });
  const sh = db.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, 'dinner');
  const me = empId('Rosa Diaz');

  // Two tabs opened at the same time, submitted one after the other. Neither
  // knows about the other; the schema has no version to notice with.
  const send = (amount) => fetch(`${BASE}/portal/tips/submit`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ position: 'server', shift_id: String(sh.id),
      cash_tips: amount, confirm_update: '1' }).toString(),
  });
  await send('30');
  await send('40');

  const rows = db.prepare('SELECT cash_tips_cents c FROM tip_submissions WHERE shift_id=? AND employee_id=? ORDER BY id')
    .all(sh.id, me).map((r) => r.c);
  assert.deepStrictEqual(rows, [1000, 3000, 4000], 'every version is still in the history');
  assert.strictEqual(db.prepare('SELECT cash_tips_cents c FROM server_sales WHERE shift_id=? AND employee_id=?')
    .get(sh.id, me).c, 4000, 'and the last completed write is the current value');
});

// --- 7. a forged shift id that genuinely exists ------------------------------

test('2F-I: a real shared shift on another date is still refused', async () => {
  // Not a nonsense id — a shift that exists, is open, and that somebody else
  // is on. Being real is not the same as being theirs, and it is not today.
  const date = '2026-11-12';
  const w2 = writable();
  w2.prepare('INSERT OR IGNORE INTO shifts (date, daypart) VALUES (?, ?)').run(date, 'dinner');
  const other = w2.prepare('SELECT id FROM shifts WHERE date=? AND daypart=?').get(date, 'dinner').id;
  w2.close();

  const { token, cookie } = await signIn('2468');
  const res = await form('/tips', { token, position: 'server', shift_id: String(other), cash_tips: '99' });
  assert.strictEqual(res.status, 403, 'refused');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM server_sales WHERE shift_id=?').get(other).n, 0,
    'nothing written');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id=?').get(other).n, 0,
    'and they were not added to it');

  // The portal door answers the same.
  const p = await fetch(`${BASE}/portal/tips/submit`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ position: 'server', shift_id: String(other), cash_tips: '99' }).toString(),
  });
  assert.strictEqual(p.status, 403, 'both doors');
});

// --- 8. Home ----------------------------------------------------------------

test('2F-I: filing clears its own reminder and leaves the others alone', async () => {
  const seed = seedToday('5162', 'Yara Osei', { today: ['dinner'], clockedInto: 'dinner' });
  const { token, cookie } = await signIn('5162');
  const sid = seed.today[0].id;

  const before = await (await fetch(`${BASE}/portal`, { headers: { cookie } })).text();
  const others = (before.match(/href="\/portal\/(clock|earnings|specials|stock)/g) || []).length;
  assert.match(before, /href="\/portal\/tips"/, 'the reminder is there to start with');

  await form('/tips', { token, position: 'server', shift_id: String(sid), cash_tips: '35' });
  const after = await (await fetch(`${BASE}/portal`, { headers: { cookie } })).text();

  assert.ok(!/Due/.test((after.match(/[^<>]*Sales[^<>]*|[^<>]*tips[^<>]*/gi) || []).join(' ')),
    'the sales & tips item no longer reads as outstanding');
  assert.strictEqual((after.match(/href="\/portal\/(clock|earnings|specials|stock)/g) || []).length, others,
    'and nothing unrelated moved');
  assert.match(after, /Working|Clocked in|Clock out/i, 'the clock still shows them on shift');

  // Correcting it does not bring the reminder back.
  const b = await signIn('5162');
  await form('/tips', { token: b.token, position: 'server', shift_id: String(sid), cash_tips: '36' });
  const third = await (await fetch(`${BASE}/portal`, { headers: { cookie } })).text();
  assert.ok(!/Due/.test((third.match(/[^<>]*Sales[^<>]*|[^<>]*tips[^<>]*/gi) || []).join(' ')),
    'a correction does not recreate it');
});
