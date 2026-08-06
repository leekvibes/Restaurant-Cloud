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
  // Matched against real <input> tags only: a looser regex over the whole page
  // hits `input[name="daypart"]:checked` inside the step script and reports a
  // preselection that is not there.
  const { html } = await signIn('2468');
  const radios = [...html.matchAll(/<input[^>]*name="daypart"[^>]*>/g)].map((m) => m[0]);
  assert.strictEqual(radios.length, 2, 'café and dinner');
  for (const r of radios) assert.ok(!/\bchecked\b/.test(r), `not preselected: ${r}`);
  assert.ok(radios.every((r) => /\brequired\b/.test(r)), 'and one of them must be chosen');
});

test('a report with no service chosen is refused', async () => {
  // The browser blocks this, and the browser is not the guard — a phone with
  // no JavaScript, or a stale cached page, posts straight past it.
  const { token } = await signIn('2468');
  const res = await form('/tips', { token, position: 'server', date: '2026-07-20', daypart: '', cash_tips: '40' });
  assert.strictEqual(res.status, 200, 'the form comes back rather than saving');
  const html = await res.text();
  assert.match(html, /choose the date and which shift/i);
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
  // The two steps are one form that a script switches between. If that script
  // never runs — old phone, blocked, cached wrong — the page has to degrade to
  // the single long form it replaced, with every field still posting.
  const { html } = await signIn('2468');
  for (const name of ['token', 'position', 'date', 'daypart', 'food', 'coffee', 'alcohol',
    'cash_tips', 'card_tips', 'note']) {
    assert.match(html, new RegExp(`name="${name}"`), `${name} is in the markup`);
  }
  // Nothing is hidden by an attribute in the markup — only by script, later.
  for (const id of ['step1', 'step2']) {
    const m = html.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(m, `${id} exists`);
    assert.ok(!/\bhidden\b/.test(m[0]), `${id} is not hidden in the markup, only by script`);
  }
  assert.match(html, /type="submit" form="report"/, 'and a submit that posts it');
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
  const { html, token } = await signIn('2468');
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
  assert.match(decodeURIComponent(res.headers.get('location')), /done=1/, 'and lands on the receipt');
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
  assert.match(html, /name="position" id="tip-position" value="server"/,
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
