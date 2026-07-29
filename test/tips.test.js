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

test('you cannot file yourself as a server to keep the tips', async () => {
  // Ana is a busser. A hand-written POST claiming 'server' would move her from
  // the pool to keeping her own tips.
  //
  // Posted with her name and PIN rather than a portal token, which is what a
  // hand-written POST actually looks like — and is now the only way she could
  // reach this route at all, since a busser is not offered a submission in the
  // portal. The guard being tested is the same one either way: the role is
  // read from what she is assigned, never from what the post claims.
  const res = await form('/tips', {
    employee_id: db.prepare("SELECT id FROM employees WHERE name='Ana Ortiz'").get().id,
    pin: '1357',
    position: 'server', date: '2026-07-19', daypart: 'cafe', cash_tips: '60', food: '900',
  });
  assert.strictEqual(res.status, 302);
  const sh = db.prepare("SELECT id FROM shifts WHERE date='2026-07-19' AND daypart='cafe'").get();
  const ana = db.prepare("SELECT id FROM employees WHERE name='Ana Ortiz'").get();
  const work = db.prepare('SELECT role FROM work WHERE shift_id=? AND employee_id=?').get(sh.id, ana.id);
  assert.strictEqual(work.role, 'busser', 'filed as what she is actually assigned');
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
