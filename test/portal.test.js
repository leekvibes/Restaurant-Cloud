'use strict';

// The staff portal, both ends of it.
//
// Two things here are worth more than the rest. The first is that the shape of
// somebody's portal follows their position — a cook must never be asked for
// sales they did not take, and hiding the button is not enough, the route
// behind it has to refuse as well. The second is that what a person is shown
// about their own money is the same figure the manager sees on the shift
// sheet: it comes from the engine, not from a second calculation that can
// drift.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3993;
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-portal-'));
const DB = path.join(dir, 'portal.db');
let child;
let Database;
let db;

const { isoDate, startOfToday } = require('../src/dates');
const today = () => isoDate(startOfToday());

const form = async (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ ...body, _csrf: await __token((headers || {}).cookie) }).toString(),
});

/** PIN in, portal cookie out — the same door staff use. */
async function signIn(pin) {
  const res = await form('/tips/start', { pin });
  assert.strictEqual(res.status, 302, `PIN ${pin} is accepted`);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^zwin_portal=/, 'and comes back with who it is');
  return cookie;
}
const asStaff = (p, cookie) => fetch(BASE + p, { headers: { cookie } });
/** The report form itself — what the hub's Start button opens. */
const tipForm = async (cookie) => (await form('/portal/tips', {}, { cookie })).text();

test.before(async () => {
  Database = require('better-sqlite3');
  // The live history cutoff is a business decision that moves; these tests are
  // about the machinery, so they open the window all the way and the one test
  // that is about the cutoff sets its own.
  const env = { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '',
    ZWIN_SKIP_BACKFILL: '1', PORTAL_HISTORY_FROM: '2000-01-01' };
  const boot = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...env, PORT: String(PORT + 40) }, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`http://127.0.0.1:${PORT + 40}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  boot.kill();
  await new Promise((r) => setTimeout(r, 300));

  const w = new Database(DB);
  const emp = w.prepare('INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES (?,?,?,1,?)');
  emp.run('Bella Reyes', 'server', 900, '1111');
  emp.run('Marco Diaz', 'kitchen', 1800, '2222');
  emp.run('Ana Ortiz', 'barista', 1500, '3333');
  // A training position: on the shift, paid hourly, and on the receiving end
  // of nothing. The engine still lists them among support, with zeroes.
  emp.run('Nico Vance', 'training', 1600, '4444');

  // A sent shift with real figures, so the earnings page has the engine's own
  // numbers to show rather than a fixture of its own.
  const sh = w.prepare("INSERT INTO shifts (date, daypart, status, created_at) VALUES ('2026-07-22','cafe','emailed',datetime('now'))").run().lastInsertRowid;
  const ids = Object.fromEntries(w.prepare('SELECT name, id FROM employees').all().map((e) => [e.name, e.id]));
  // Bella covers the bar as well as the floor. Somebody has to, or the
  // two-jobs half of the position step goes untested.
  w.prepare('INSERT INTO employee_roles (employee_id, role, wage_cents) VALUES (?,?,?)')
    .run(ids['Bella Reyes'], 'barista', 1500);

  const work = w.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)');
  work.run(sh, ids['Bella Reyes'], 'server', 7.5);
  work.run(sh, ids['Marco Diaz'], 'kitchen', 8);
  work.run(sh, ids['Nico Vance'], 'training', 4);
  w.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents)
    VALUES (?,?,?,?,0,?,?)`).run(sh, ids['Bella Reyes'], 185075, 12050, 29999, 6400);
  w.prepare("INSERT INTO products (name, category, unit) VALUES ('Oat milk','Dairy','case')").run();
  w.close();

  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  db = new Database(DB);
});

test.after(() => { if (child) child.kill(); if (db) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// The shape of a portal follows the position.
// ---------------------------------------------------------------------------

test('the way in reads the same whoever opens it', async () => {
  // One name for the task on every phone. Staff describe this screen to each
  // other; when a server says "did you do Submit sales or tips", a barista has
  // to be looking at those same words. What differs is inside, not on the door.
  const server = await (await asStaff('/portal', await signIn('1111'))).text();
  const barista = await (await asStaff('/portal', await signIn('3333'))).text();
  for (const [html, who] of [[server, 'a server'], [barista, 'a barista']]) {
    assert.match(html, /Submit sales or tips/, `${who} sees the shared name`);
    assert.ok(!/Submit your cash tips|Submit tips &amp; sales/.test(html),
      `and ${who} never sees a name written for one role`);
  }
  assert.match(server, /Bella/, 'still greeted by name');
});

test('a server is asked for sales, a barista is not', async () => {
  // The distinction survives the shared wording — it just lives where it
  // belongs, in the form rather than on the button. And it is in the HTML as
  // sent: a barista who is slow to run the script must not see a flash of
  // sales fields and start filling them in.
  const server = await tipForm(await signIn('1111'));
  const barista = await tipForm(await signIn('3333'));
  assert.match(server, /id="server-sales"(?!\s*hidden)/, 'a server opens on the sales section');
  assert.match(barista, /id="server-sales" hidden/, 'a barista opens with it already gone');
  assert.match(barista, /id="row-sales" hidden/, 'and it is out of their running total too');
});

test('one job goes straight through, two get a choice', async () => {
  // Nobody should have to answer "what did you work" when there is only one
  // answer, and nobody with two jobs should have it guessed for them — how
  // they are paid hangs on it.
  const one = await tipForm(await signIn('3333'));
  assert.match(one, /<input type="hidden" name="position" id="tip-position" value="barista"/,
    'a barista is simply a barista');
  assert.ok(!/<select name="position"/.test(one), 'and is asked nothing');

  const both = await tipForm(await signIn('1111'));
  assert.match(both, /<select name="position" id="tip-position"/, 'two jobs, so she picks');
  for (const r of ['server', 'barista']) {
    assert.match(both, new RegExp(`<option value="${r}"`), `${r} is on the menu`);
  }
});

test('the report has a way back to the hub', async () => {
  // Steps two and three have always had Back. Step one had only "Not you?",
  // which signs you out — so anyone who opened the form to look at it had to
  // end their session to leave.
  const html = await tipForm(await signIn('1111'));
  assert.match(html, /href="\/portal"/, 'step one gets you home');
  assert.match(html, /class="tp-back" data-goto="1"/, 'the later steps keep theirs');
});


test('every role gets the same home, minus what does not apply', async () => {
  // One layout, not three. Submitting is a row among the others now — a staff
  // member could not find it as a headline block — so the difference between a
  // server and a cook is just whether that one row is present. Everything else
  // is the same list in the same order.
  const cook = await (await asStaff('/portal', await signIn('2222'))).text();
  const server = await (await asStaff('/portal', await signIn('1111'))).text();

  assert.ok(!/Submit sales or tips/.test(cook), 'a cook is not offered the submission row');
  assert.ok(!/pt-row-do/.test(cook), 'not even a disabled one');
  assert.match(server, /pt-row-do/, 'while a server gets it');
  assert.match(server, /Submit sales or tips/, 'named the same for everyone who does');

  // The three rows every role shares, in the same order, both with a working
  // door behind them.
  const cookie = await signIn('2222');
  for (const [href, what] of [['/portal/earnings', 'their own hours and pay'],
    ['/portal/specials', 'the board'], ['/portal/stock', 'reporting stock']]) {
    assert.ok(cook.includes(href), `a cook still gets ${what}`);
    assert.ok(server.includes(href), `and so does a server`);
    assert.strictEqual((await asStaff(href, cookie)).status, 200, `and ${href} opens`);
  }
});

test('hiding the tip form is not the same as refusing it', async () => {
  // A hidden button is a decoration. The route has to say no too, or anybody
  // who kept the URL can post sales they never took.
  const cookie = await signIn('2222');
  const res = await fetch(`${BASE}/portal/tips`, { method: 'POST', redirect: 'manual', headers: { cookie } });
  assert.strictEqual(res.status, 302, 'the cook is turned away at the route');
  assert.match(res.headers.get('location') || '', /\/portal/, 'back to their hub');
});

test('who gets asked is a setting, not a list of role names in the code', async () => {
  // The manager flips it; the portal changes shape on the next load. A
  // restaurant that tips its cooks directly should not need a code change.
  const pos = db.prepare("SELECT id FROM positions WHERE slug = 'kitchen'").get();
  await form(`/staff-portal/position/${pos.id}/tips`, { on: '1' });
  const on = await (await asStaff('/portal', await signIn('2222'))).text();
  assert.match(on, /Submit sales or tips/, 'a cook who is asked, is asked');

  await form(`/staff-portal/position/${pos.id}/tips`, { on: '0' });
  const off = await (await asStaff('/portal', await signIn('2222'))).text();
  assert.ok(!/pt-task/.test(off), 'and turning it back off takes the section away again');
});

// ---------------------------------------------------------------------------
// Money. The same figures the manager sees, never a second calculation.
// ---------------------------------------------------------------------------

test('the money on a server\'s screen reconciles the way the engine defines it', async () => {
  // Deliberately not a string-match against the shift sheet: the two pages
  // aggregate and format differently, so that comparison fails on presentation
  // rather than on arithmetic, and a test that breaks for the wrong reason
  // gets deleted. What is checked instead is the identity the engine itself
  // holds to — if the portal ever grew its own sums, these stop adding up.
  const html = await (await asStaff('/portal/earnings', await signIn('1111'))).text();
  const num = (v) => Math.round(Number(String(v).replace(/[$,−-]/g, '')) * 100);
  const grab = (label) => {
    const m = html.match(new RegExp(label + '[\\s\\S]{0,140}?(−?\\$[\\d,]+\\.\\d{2})'));
    return m ? num(m[1]) : null;
  };
  // Read by the labels the email uses, because the portal now uses them too —
  // the whole point of that change is that the two describe the same money in
  // the same words.
  const kept = grab('You kept');
  const collected = grab('Total tips collected');
  const tippedOut = grab('Total tip-out') || 0;
  const cash = grab('Cash you took home');
  const cheque = grab('(?:Added to|Adjusted from) your next paycheck');

  assert.ok(kept && collected && cash !== null && cheque !== null,
    `all five figures render: ${JSON.stringify({ kept, collected, tippedOut, cash, cheque })}`);
  assert.ok(tippedOut > 0, 'she tipped out — otherwise this proves less than it looks');
  assert.strictEqual(collected - tippedOut, kept, 'what she collected, less the tip-out, is what she kept');
  assert.strictEqual(cash + cheque, kept, 'and it arrives as cash plus paycheck, nothing lost between');
});

test('any past shift opens to its own full breakdown', async () => {
  // The history is a list of links now, not just a row of figures — a staff
  // member can tap any night and see exactly how it broke down, the same lines
  // the last-shift hero shows.
  const cookie = await signIn('1111');
  // The home screen's last-shift block links straight into that shift; the
  // history list links into each of the rest the same way.
  const home = await (await asStaff('/portal', cookie)).text();
  const id = (home.match(/\/portal\/earnings\/(\d+)/) || [])[1];
  assert.ok(id, 'the last shift links into its own breakdown');

  const one = await (await asStaff(`/portal/earnings/${id}`, cookie)).text();
  assert.match(one, /You kept|You worked/, 'the shift opens to its breakdown');
  assert.match(one, /Hours worked|Your rate|salaried/, 'with the hours side of it');
  assert.match(one, /All earnings/, 'and a way back to the list');

  // A shift id that is not theirs (or not real) does not 404 or leak — it just
  // returns them to their own list.
  const bogus = await fetch(`${BASE}/portal/earnings/99999`, { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(bogus.status, 302, 'an unknown shift redirects');
  assert.match(bogus.headers.get('location') || '', /\/portal\/earnings$/, 'back to all earnings');
});

test('the submit row opens the form on a plain tap', async () => {
  // The row is a link, so it must open with a GET — a staff member tapping it
  // is not posting anything yet.
  const cookie = await signIn('1111');
  const res = await fetch(`${BASE}/portal/tips`, { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(res.status, 200, 'GET opens the form');
  assert.match(await res.text(), /End-of-shift report/, 'which is the report');
});

test('a cook is shown what they received, without a tip-out they never paid', async () => {
  // Kitchen does not hand tips in, but it does receive a share of the pot —
  // so the honest screen for a cook is what came to them, not a blank. What it
  // must not show is "tipped out to support", which is money leaving, and a
  // cook is the support it leaves towards.
  const html = await (await asStaff('/portal/earnings', await signIn('2222'))).text();
  // "Total tips", the way their own email heads it — a cook does not "keep"
  // tips after a tip-out, they receive a share, and the two screens describing
  // that money now use one word for it.
  assert.match(html, /Total tips|You worked|Nothing recorded/, 'it says what they got');
  assert.ok(!/Nothing to submit/.test(html), 'without repeating what they are not asked for');
  assert.ok(!/Total tip-out/.test(html),
    'and never bills them for a tip-out they are on the receiving end of');
  // The support breakdown names its three sources, the way their email does.
  assert.match(html, /Server tip-out \(card\)|To-go card tips/,
    'it says which side the tip-out reached them from');
});

test('a finished shift is one the app has actually finished', async () => {
  // This shipped blank. The portal asked for shifts with status 'sent', and
  // this app has never written that status — a shift becomes 'emailed' when
  // the sheet goes out. So the query matched nothing, every staff member's
  // pay screen said "Nothing recorded yet", and it looked like an empty
  // restaurant rather than a typo.
  const statuses = db.prepare('SELECT DISTINCT status FROM shifts').all().map((r) => r.status);
  assert.ok(!statuses.includes('sent'), `the app writes ${statuses.join('/')} — never 'sent'`);

  const html = await (await asStaff('/portal/earnings', await signIn('1111'))).text();
  assert.ok(!/Nothing recorded yet/.test(html), 'a server who worked a finished shift sees it');
  assert.match(html, /You kept/, 'with what they kept');
});

test('history starts where the manager says it starts', async () => {
  // The database carries months of services imported from before ZWIN kept
  // the record. Those are not figures to put in front of somebody as their
  // pay, so the window has a floor — and it has to actually hold.
  const older = db.prepare(`INSERT INTO shifts (date, daypart, status, created_at)
    VALUES ('2026-06-02','dinner','emailed',datetime('now'))`).run().lastInsertRowid;
  const bella = db.prepare("SELECT id FROM employees WHERE name = 'Bella Reyes'").get().id;
  db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)')
    .run(older, bella, 'server', 6);

  // This suite runs with the floor wide open, so the old shift shows.
  const wide = await (await asStaff('/portal/earnings', await signIn('1111'))).text();
  assert.match(wide, /Jun 2/, 'with no floor, June is in the history');

  // A server booted with a floor must not show it. Same database, same person.
  // A literal, not PORT + 7 — that arithmetic landed on 4000, which is the
  // app's own default port, so this test failed for anybody who happened to
  // have the dev server running. It read as a flake for weeks.
  const port = 3995;
  const child2 = require('node:child_process').spawn(
    process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '',
      ZWIN_SKIP_BACKFILL: '1', PORT: String(port), PORTAL_HISTORY_FROM: '2026-07-18' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 90; i++) {
      try { await fetch(`http://127.0.0.1:${port}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const start = await fetch(`http://127.0.0.1:${port}/tips/start`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin: '1111' }).toString(),
    });
    const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
    const cut = await (await fetch(`http://127.0.0.1:${port}/portal/earnings`, { headers: { cookie } })).text();
    assert.ok(!/Jun 2/.test(cut), 'the June shift is behind the floor');
    assert.match(cut, /Jul 22/, 'and July is still there');
  } finally {
    child2.kill();
    db.prepare('DELETE FROM work WHERE shift_id = ?').run(older);
    db.prepare('DELETE FROM shifts WHERE id = ?').run(older);
  }
});

test('a shift shows the hours and the rate it was worked at', async () => {
  // "What did I make" is two questions for anybody paid hourly, and the
  // portal only ever answered the tips half.
  db.prepare('UPDATE employees SET hourly_rate_cents = 1650 WHERE name = ?').run('Marco Diaz');
  const html = await (await asStaff('/portal/earnings', await signIn('2222'))).text();
  assert.match(html, /8 hrs/, 'the hours they worked');
  assert.match(html, /\$16\.50\/hr/, 'the rate behind them');
  assert.match(html, /\$132\.00/, 'and what those hours came to');
});

test('somebody who received nothing is shown their hours, not a zero', async () => {
  // The engine lists everyone who worked on the support side of a shift,
  // including positions no tip-out ever reaches. Leading with "You kept $0.00"
  // answers a question they did not ask and buries the one they did — and on a
  // screen about pay, a zero reads like a statement about their pay.
  const html = await (await asStaff('/portal/earnings', await signIn('4444'))).text();
  assert.match(html, /You worked/, 'the headline is what they did');
  assert.match(html, /4 hrs/, 'and it is their actual hours from the shift');
  assert.ok(!/\$0\.00/.test(html), 'no zero anywhere on it');
  // They do get an all-time panel — hours are a record worth keeping even when
  // no tip ever reached them. What it must not carry is money columns that
  // could only ever read zero.
  assert.match(html, /All time/, 'their hours still add up to something');
  assert.ok(!/kept total|avg tips/.test(html), 'without money columns that can only be zero');

  // The rule is "nothing arrived", not "this position does not hand tips in".
  // A busser hands nothing in and still gets a share every service, so keying
  // it on that setting would hide real money from the person who earned it.
  const cook = await (await asStaff('/portal/earnings', await signIn('2222'))).text();
  assert.match(cook, /Total tips/, 'a cook who receives a share still sees it');
  assert.ok(!/You worked/.test(cook), 'and is not demoted to an hours line');
});

// ---------------------------------------------------------------------------
// The manager's page: four jobs, four tabs.
// ---------------------------------------------------------------------------

test('each tab renders only its own job', async () => {
  // The page was one scroll of four jobs, and you passed three to reach the
  // fourth. Only one renders now — which is worth asserting, because a tab
  // that renders everything and hides the rest with CSS looks identical from
  // the outside and still ships the whole page down the wire.
  const marks = {
    reports: 'Everything staff reported from the floor',
    board: 'Add a special',
    notes: 'Post a note',
    positions: 'still sees the board, reports stock',
  };
  for (const [tab, mine] of Object.entries(marks)) {
    const html = await (await fetch(`${BASE}/staff-portal?tab=${tab}`)).text();
    assert.match(html, new RegExp(mine), `${tab} renders its own body`);
    for (const [other, theirs] of Object.entries(marks)) {
      if (other === tab) continue;
      assert.ok(!new RegExp(theirs).test(html), `${tab} does not also render ${other}`);
    }
    // The strip above the tabs belongs to all four.
    assert.match(html, /Floor reports/, `${tab} keeps the overview strip`);
  }
});

test('the default tab is the one with someone waiting on it', async () => {
  const html = await (await fetch(`${BASE}/staff-portal`)).text();
  assert.match(html, /Everything staff reported from the floor/, 'floor reports open first');
  // And a tab nobody asked for does not throw the page away.
  const junk = await fetch(`${BASE}/staff-portal?tab=../../etc/passwd`);
  assert.strictEqual(junk.status, 200, 'an unknown tab still renders');
  assert.match(await junk.text(), /Everything staff reported from the floor/, 'falling back to the first');
});

test('an action puts you back on the tab you did it from', async () => {
  // Otherwise every 86 dropped you on Floor reports and you navigated back to
  // the board to do the next one.
  const d = today();
  await form('/staff-portal/special', { d, name: 'Qqz Tab Test', price: '9.00' });
  const dish = db.prepare("SELECT id FROM portal_specials WHERE name = 'Qqz Tab Test'").get();

  const off = await form(`/staff-portal/special/${dish.id}/86`, { d, note: '' });
  const where = off.headers.get('location') || '';
  assert.match(where, /tab=board/, 'back to the board');
  assert.match(where, new RegExp(`d=${d}`), 'and to the day you were looking at');

  const note = await form('/staff-portal/note', { title: 'Qqz note', tone: 'fyi', starts_on: d, ends_on: d });
  assert.match(note.headers.get('location') || '', /tab=notes/, 'notes go back to notes');

  const pos = db.prepare("SELECT id FROM positions WHERE slug = 'barista'").get();
  const tog = await form(`/staff-portal/position/${pos.id}/tips`, { on: '0' });
  assert.match(tog.headers.get('location') || '', /tab=positions/, 'and the switch stays put');
  await form(`/staff-portal/position/${pos.id}/tips`, { on: '1' });

  db.prepare('DELETE FROM portal_specials WHERE id = ?').run(dish.id);
  db.prepare("DELETE FROM portal_notes WHERE title = 'Qqz note'").run();
});

// ---------------------------------------------------------------------------
// The board, and what travels back.
// ---------------------------------------------------------------------------

test("a manager's 86 reaches the floor", async () => {
  const d = today();
  await form('/staff-portal/special', { d, name: 'Qqx Branzino', price: '31.00', description: 'Whole fish.' });
  const dish = db.prepare("SELECT id FROM portal_specials WHERE name = 'Qqx Branzino'").get();
  assert.ok(dish, 'it is on the board');

  const cookie = await signIn('1111');
  const before = await (await asStaff('/portal/specials', cookie)).text();
  assert.match(before, /Running ·/, 'and running');

  await form(`/staff-portal/special/${dish.id}/86`, { note: '' });
  const after = await (await asStaff('/portal/specials', cookie)).text();
  assert.match(after, /86'd — don't offer/, 'the 86 section appears');
  // The time is the point — it tells a server whether it went before or after
  // they last looked.
  const row = db.prepare('SELECT * FROM portal_specials WHERE id = ?').get(dish.id);
  assert.ok(row.eighty_sixed_at, 'stamped when');
  assert.match(row.sold_out_note, /86'D \d+(AM|PM)/, `and says so: ${row.sold_out_note}`);
});

test('a special can be edited after it is posted', async () => {
  const d = today();
  await form('/staff-portal/special', { d, name: 'Qqx Editable', price: '12.00', description: 'First.' });
  const dish = db.prepare("SELECT id FROM portal_specials WHERE name = 'Qqx Editable'").get();

  // The edit composer is reached by ?edit=id and pre-fills the current values.
  const editForm = await (await fetch(`${BASE}/staff-portal?tab=board&d=${d}&edit=${dish.id}`)).text();
  assert.match(editForm, /value="Qqx Editable"/, 'the form opens pre-filled');
  assert.match(editForm, /Save changes/, 'as an edit, not a new one');

  await form(`/staff-portal/special/${dish.id}/edit`, { d, name: 'Qqx Edited', price: '18.50', description: 'Changed.' });
  const row = db.prepare('SELECT * FROM portal_specials WHERE id = ?').get(dish.id);
  assert.strictEqual(row.name, 'Qqx Edited', 'the name changed');
  assert.strictEqual(row.price_cents, 1850, 'and the price');
  assert.strictEqual(row.description, 'Changed.', 'and the description');
});

test('any item can be 86’d, not only a running special', async () => {
  // The manager types anything they are out of; it lands on the 86 list struck
  // through, without ever having been a running special.
  const d = today();
  await form('/staff-portal/special/86-item', { d, name: 'Qqx Fresh oysters', note: 'back tomorrow' });
  const row = db.prepare("SELECT * FROM portal_specials WHERE name = 'Qqx Fresh oysters'").get();
  assert.ok(row, 'it was created');
  assert.ok(row.eighty_sixed_at, 'already 86’d, not running');
  assert.strictEqual(row.sold_out_note, 'back tomorrow', 'with the note the manager typed');
  assert.strictEqual(row.price_cents, null, 'and no price — it was never a special');

  const floor = await (await asStaff('/portal/specials', await signIn('1111'))).text();
  assert.match(floor, /Qqx Fresh oysters/, 'and the floor sees it on the 86 board');
});

test('the board is evergreen — a special stays up until it is deleted', async () => {
  // A special posted eight days ago must still be on the board today: it comes
  // off when the manager takes it down, not when the date rolls over.
  const old = isoDate(new Date(startOfToday().getTime() - 8 * 86400000));
  db.prepare(`INSERT INTO portal_specials (service_date, name, price_cents, sort)
    VALUES (?, 'Qqx Evergreen lamb', 2600, 5)`).run(old);

  const floor = await (await asStaff('/portal/specials', await signIn('1111'))).text();
  assert.match(floor, /Qqx Evergreen lamb/, 'an 8-day-old special still shows on the floor');

  const mgr = await (await fetch(`${BASE}/staff-portal?tab=board`)).text();
  assert.match(mgr, /Qqx Evergreen lamb/, 'and on the manager board');

  // Deleting is what takes it down.
  const dish = db.prepare("SELECT id FROM portal_specials WHERE name = 'Qqx Evergreen lamb'").get();
  await form(`/staff-portal/special/${dish.id}/delete`, {});
  const gone = db.prepare('SELECT id FROM portal_specials WHERE id = ?').get(dish.id);
  assert.ok(!gone, 'and only deleting removes it');
});

test('a note stops showing the day after it expires', async () => {
  const yesterday = isoDate(new Date(startOfToday().getTime() - 86400000));
  await form('/staff-portal/note', { title: 'Qqx Stale notice', body: 'Old news.', tone: 'fyi',
    starts_on: yesterday, ends_on: yesterday });
  await form('/staff-portal/note', { title: 'Qqx Live notice', body: 'Today only.', tone: 'urgent',
    starts_on: today(), ends_on: today() });

  const html = await (await asStaff('/portal', await signIn('1111'))).text();
  assert.match(html, /Qqx Live notice/, 'today\'s note shows');
  assert.ok(!/Qqx Stale notice/.test(html),
    'and yesterday\'s does not — a board that keeps stale notices is one nobody reads');
});

test('a report from the floor is what the person typed, never matched to a product', async () => {
  // Staff type free text and the manager reads exactly that. The report is
  // never silently linked to a catalogue product, even when the words happen
  // to match one — there is no picker, and there is no guessing behind it.
  const cookie = await signIn('1111');
  const res = await form('/portal/stock', {
    items: JSON.stringify([
      { item: 'Oat milk', status: 'out', note: 'Going through 3 a day' },
      { item: 'Qqx Nothing We Buy', status: 'low', note: '' },
    ]),
  }, { cookie });
  assert.strictEqual(res.status, 302);

  const rows = db.prepare("SELECT * FROM portal_stock WHERE item IN ('Oat milk','Qqx Nothing We Buy') ORDER BY item").all();
  assert.strictEqual(rows.length, 2, 'both were filed');
  const oat = rows.find((r) => r.item === 'Oat milk');
  const other = rows.find((r) => r.item !== 'Oat milk');
  // 'Oat milk' is seeded as a product, so the old behaviour would have linked
  // it. It must not now.
  assert.strictEqual(oat.product_id, null, 'a name we happen to buy is still left as the words typed');
  assert.strictEqual(other.product_id, null, 'and one we do not is too');
  assert.strictEqual(oat.reported_by, 'Bella Reyes', 'with who said so');
  assert.strictEqual(oat.batch, other.batch, 'and both in one batch — she pressed send once');

  const admin = await (await fetch(`${BASE}/staff-portal`)).text();
  assert.match(admin, /Oat milk/, 'the manager sees exactly what was reported');
});

test('the stock report has no product picker to choose from', async () => {
  // The manager asked for free text, not a dropdown of the catalogue — so the
  // page must not ship one, however staff type.
  const html = await (await asStaff('/portal/stock', await signIn('1111'))).text();
  assert.ok(!/<datalist/.test(html), 'no datalist of products');
  assert.ok(!/list="stock-products"/.test(html), 'and the field is not wired to one');
});

test('resolving a report takes it off the list without deleting it', async () => {
  const open = db.prepare('SELECT id FROM portal_stock WHERE resolved_at IS NULL LIMIT 1').get();
  assert.ok(open, 'something is open');
  await form(`/staff-portal/stock/${open.id}/resolve`, { resolution: 'ordered' });

  const row = db.prepare('SELECT * FROM portal_stock WHERE id = ?').get(open.id);
  assert.strictEqual(row.resolution, 'ordered');
  assert.ok(row.resolved_at, 'and when');
  assert.ok(row.item, 'the report is still there — the history is the point');

  // And the person who reported it can see it was dealt with.
  const mine = await (await asStaff('/portal/stock', await signIn('1111'))).text();
  assert.match(mine, /Recently sent/, 'their own screen closes the loop');
});

// ---------------------------------------------------------------------------
// The doors.
// ---------------------------------------------------------------------------

test('the portal is shut to anyone without a live PIN session', async () => {
  for (const p of ['/portal', '/portal/earnings', '/portal/specials', '/portal/stock']) {
    const res = await fetch(BASE + p, { redirect: 'manual' });
    assert.strictEqual(res.status, 302, `${p} is not open to the world`);
    assert.match(res.headers.get('location') || '', /\/tips/, 'it asks for a PIN');
  }
});

test('the PIN screen still names nobody', async () => {
  // Unchanged and load-bearing: an open link that listed the roster would
  // publish it to anyone who found the URL.
  const html = await (await fetch(`${BASE}/tips`)).text();
  for (const name of ['Bella', 'Marco', 'Ana', 'Reyes']) {
    assert.ok(!html.includes(name), `${name} is not on the sign-in page`);
  }
});

test('signing out of the portal actually ends it', async () => {
  const cookie = await signIn('1111');
  assert.strictEqual((await asStaff('/portal', cookie)).status, 200, 'in');
  const out = await fetch(`${BASE}/portal/out`, { redirect: 'manual', headers: { cookie } });
  assert.match(out.headers.get('set-cookie') || '', /zwin_portal=;/, 'the cookie is cleared');
});

test("the floor gets a What's-new heads-up when a special is posted", async () => {
  const cookie = await signIn('1111');
  // First visit sets their baseline — a returning user, not brand-new, is the
  // one who should be told about something posted *after* they last looked.
  await (await asStaff('/portal', cookie)).text();
  await form('/staff-portal/special', { name: 'Qqx Heads-up branzino', price: '30.00' });
  const first = await (await asStaff('/portal', cookie)).text();
  assert.match(first, /What's new/, "the What's-new block shows");
  assert.match(first, /Qqx Heads-up branzino/, 'naming the special');
  // Opening the hub is reading it — it does not nag on the next load.
  const second = await (await asStaff('/portal', cookie)).text();
  assert.ok(!/Qqx Heads-up branzino/.test(second), 'and clears once seen');
});

test('an earnings notification reaches only the person it is for', async () => {
  const me = db.prepare('SELECT id FROM employees WHERE pin = ?').get('1111');
  assert.ok(me, 'the test employee exists');
  const cookie = await signIn('1111');
  // Establish their baseline first, so the two events posted after it both count
  // as new (a returning user, not a first-time one with a clean slate).
  await (await asStaff('/portal', cookie)).text();
  db.prepare(`INSERT INTO portal_events (kind, title, employee_id, href)
    VALUES ('earnings', 'Qqx Your pay is ready', ?, '/portal/earnings')`).run(me.id);
  db.prepare(`INSERT INTO portal_events (kind, title, employee_id, href)
    VALUES ('earnings', 'Qqx Someone elses pay', ?, '/portal/earnings')`).run(me.id + 100000);

  const html = await (await asStaff('/portal', cookie)).text();
  assert.match(html, /Qqx Your pay is ready/, 'their own earnings event shows');
  assert.ok(!/Qqx Someone elses pay/.test(html), "but not another person's");
});

test('a device can turn on push, and it is stored against the person', async () => {
  const cookie = await signIn('1111');
  const hub = await (await asStaff('/portal', cookie)).text();
  assert.match(hub, /id="ptpush"/, 'the turn-on control is on the hub');
  assert.match(hub, /data-vapid="/, 'with a public key to subscribe against');

  const sub = { endpoint: 'https://example.com/push/qqx-1', keys: { p256dh: 'x', auth: 'y' } };
  const r = await fetch(BASE + '/portal/push/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(sub),
  });
  const j = await r.json();
  assert.ok(j.ok, 'the subscribe endpoint accepts it');
  const me = db.prepare('SELECT id FROM employees WHERE pin = ?').get('1111');
  const row = db.prepare('SELECT * FROM portal_push WHERE endpoint = ?').get(sub.endpoint);
  assert.ok(row, 'the subscription is stored');
  assert.strictEqual(row.employee_id, me.id, 'against the signed-in person');

  // And turning it off removes that device.
  await fetch(BASE + '/portal/push/unsubscribe', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  assert.ok(!db.prepare('SELECT 1 FROM portal_push WHERE endpoint = ?').get(sub.endpoint), 'unsubscribe removes it');
});

// --- admin (back-office) notifications -------------------------------------
// A parallel feed for the owner and managers, in its own admin_* tables. Two
// things matter: the office is told when operational milestones happen, and
// none of it can disturb the staff portal's own notifications. (These run in
// open mode — APP_PASSWORD is blank — so the admin routes need no cookie.)

test('a floor report always notifies the back office', async () => {
  const cookie = await signIn('1111'); // Bella, a server
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='floor'").get().n;
  await fetch(BASE + '/portal/stock', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ items: JSON.stringify([{ item: 'oat milk', status: 'out' }]) }).toString(),
  });
  const after = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='floor'").get().n;
  assert.strictEqual(after, before + 1, 'the report writes exactly one admin event');
  const ev = db.prepare("SELECT * FROM admin_events WHERE kind='floor' ORDER BY id DESC LIMIT 1").get();
  assert.match(ev.title, /reported/, 'it names who reported');
  assert.strictEqual(ev.href, '/staff-portal', 'and clicks through to the board where reports clear');
});

test('filing an incident notifies the office, and links to the incident', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='incident'").get().n;
  await form('/c/incidents', { type: 'Guest complaint', description: 'A guest slipped near the bar.', logged_by: 'Owner' });
  const after = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='incident'").get().n;
  assert.strictEqual(after, before + 1, 'one incident logged, one admin event');
  const ev = db.prepare("SELECT * FROM admin_events WHERE kind='incident' ORDER BY id DESC LIMIT 1").get();
  assert.match(ev.href, /^\/c\/incidents\/\d+$/, 'the click opens that incident');
});

test('the notifications page shows what is new, then marks it seen', async () => {
  db.prepare("INSERT INTO admin_events (kind, title, href) VALUES ('payroll','Payroll sent — unit test','/payroll')").run();
  const maxId = db.prepare('SELECT MAX(id) m FROM admin_events').get().m;
  const html = await (await fetch(BASE + '/notifications')).text();
  assert.match(html, /Payroll sent — unit test/, 'the event is on the page');
  assert.match(html, /Turn on/, 'and the turn-on-push control is offered');
  const seen = db.prepare("SELECT seen_id FROM admin_seen WHERE uid='m'").get();
  assert.ok(seen && seen.seen_id >= maxId, 'opening the page marks everything up to now as seen');
});

test('admin push is its own list — turning it on never touches staff push', async () => {
  const staffBefore = db.prepare('SELECT COUNT(*) n FROM portal_push').get().n;
  const sub = { endpoint: 'https://example.com/admin-endpoint-1', keys: { p256dh: 'k', auth: 'a' } };
  const r = await fetch(BASE + '/notifications/push/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub),
  });
  assert.ok((await r.json()).ok, 'the admin subscribe endpoint accepts it');
  assert.ok(db.prepare('SELECT 1 FROM admin_push WHERE endpoint = ?').get(sub.endpoint), 'stored in admin_push');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM portal_push').get().n, staffBefore, 'and the staff push list is untouched');

  await fetch(BASE + '/notifications/push/unsubscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  assert.ok(!db.prepare('SELECT 1 FROM admin_push WHERE endpoint = ?').get(sub.endpoint), 'unsubscribe removes it');
});

// --- more admin notifications: events + the daily sweep --------------------

test('an expense someone fronted themselves notifies the office (a card buy does not)', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='expense'").get().n;
  await form('/c/expenses', { spent_on: today(), name: 'ice bags', amount_cents: '18.00',
    paid_by: 'Rosa', paid_with: 'Their own money' });
  const after = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='expense'").get().n;
  assert.strictEqual(after, before + 1, 'their-own-money raises one event');
  const ev = db.prepare("SELECT * FROM admin_events WHERE kind='expense' ORDER BY id DESC LIMIT 1").get();
  assert.match(ev.title, /Rosa is owed/, 'it names who is owed');
  assert.match(ev.href, /^\/c\/expenses\/\d+$/, 'and links to the expense');

  // A company-card buy is already paid — no one is owed, so nothing fires.
  await form('/c/expenses', { spent_on: today(), name: 'napkins', amount_cents: '12.00',
    paid_by: 'Rosa', paid_with: 'Company card' });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='expense'").get().n, after,
    'a company-card expense raises nothing');
});

test('creating a back-office user notifies the office', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='user'").get().n;
  const email = 'sam-manager@test.local';
  await form('/users', { name: 'Sam Manager', email, password: 'longenough1', role: 'editor' });
  const after = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='user'").get().n;
  assert.strictEqual(after, before + 1, 'one new user, one event');
  const ev = db.prepare("SELECT * FROM admin_events WHERE kind='user' ORDER BY id DESC LIMIT 1").get();
  assert.match(ev.title, /New user: Sam Manager/, 'it names the account');
});

test('the daily sweep raises overdue invoices, stale floor reports and document deadlines — once', async () => {
  // Seed the three conditions the sweep looks for.
  db.prepare(`INSERT INTO m_invoices (invoice_date, due_date, invoice_number, amount_cents, status, category)
    VALUES (date('now','-10 days'), date('now','-3 days'), 'SW-OVERDUE-1', 42000, 'Unpaid', 'Other')`).run();
  db.prepare(`INSERT INTO portal_stock (item, status, reported_by, reported_at)
    VALUES ('sweep test milk', 'out', 'Rosa', datetime('now','-2 days'))`).run();
  db.prepare(`INSERT INTO m_documents (title, category, expires_on, file)
    VALUES ('Sweep Test Permit', 'Permit', date('now','+10 days'), 'x.pdf')`).run();

  const serverPath = path.join(__dirname, '..', 'src', 'server.js');
  const sweepOnce = async (port) => {
    const s = spawn(process.execPath, [serverPath], {
      env: { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '',
        ZWIN_SKIP_BACKFILL: '1', ZWIN_SWEEP_NOW: '1', PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 90; i++) {
      try { await fetch(`http://127.0.0.1:${port}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await new Promise((r) => setTimeout(r, 400)); // let the synchronous boot sweep land
    s.kill();
    await new Promise((r) => setTimeout(r, 200));
  };

  await sweepOnce(PORT + 61);
  assert.ok(db.prepare("SELECT 1 FROM admin_events WHERE kind='invoice' AND title LIKE '%overdue%'").get(), 'overdue invoice raised');
  assert.ok(db.prepare("SELECT 1 FROM admin_events WHERE kind='floor' AND title LIKE '%sweep test milk%'").get(), 'stale floor report raised');
  assert.ok(db.prepare("SELECT 1 FROM admin_events WHERE kind='document' AND title LIKE '%Sweep Test Permit%'").get(), 'document deadline raised');

  // Run it again: the same situations must not be announced twice.
  const invBefore = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='invoice'").get().n;
  await sweepOnce(PORT + 62);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='invoice'").get().n, invBefore,
    'a second sweep re-announces nothing');
});

test('when the last person submits, the office hears the shift is ready to close', async () => {
  const bella = db.prepare("SELECT id FROM employees WHERE pin = '1111'").get().id;
  const date = '2025-11-11';  // a date no other test touches, so Bella is the only one on it
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind = 'shift_ready'").get().n;
  await form('/tips', { employee_id: String(bella), pin: '1111', date, daypart: 'cafe',
    position: 'server', cash_tips: '40', food: '', coffee: '', alcohol: '' });
  const after = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind = 'shift_ready'").get().n;
  assert.strictEqual(after, before + 1, 'the one-and-only submission completes the shift and raises it');
  const ev = db.prepare("SELECT * FROM admin_events WHERE kind = 'shift_ready' ORDER BY id DESC LIMIT 1").get();
  assert.match(ev.href, /^\/shifts\/\d+$/, 'and links to the shift to review and send');

  // A correction (a second submission by the same person) must not raise it again.
  await form('/tips', { employee_id: String(bella), pin: '1111', date, daypart: 'cafe',
    position: 'server', cash_tips: '45', food: '', coffee: '', alcohol: '' });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind = 'shift_ready'").get().n, after,
    'a resubmission does not re-announce it');
});

test('overriding a duplicate-invoice warning notifies the office', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind = 'invoice_dup'").get().n;
  await form('/c/invoices', { dup_ok: '1', amount: '99.00', invoice_number: 'DUP-TEST-1',
    invoice_date: today(), status: 'Unpaid', category: 'Other' });
  const after = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind = 'invoice_dup'").get().n;
  assert.strictEqual(after, before + 1, 'saving over the warning raises one event');
  const ev = db.prepare("SELECT * FROM admin_events WHERE kind = 'invoice_dup' ORDER BY id DESC LIMIT 1").get();
  assert.match(ev.href, /^\/c\/invoices#inv-\d+$/, 'and links to the invoice that was filed');
});

test('a brand-new user starts clean — no backlog, only what arrives after them', async () => {
  db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Fresh Newbie','server',900,1,'9090')").run();
  // Posted before they ever sign in — the backlog a new arrival must NOT be shown.
  await form('/staff-portal/special', { name: 'Zzq Before-you-arrived special', price: '20.00' });
  const cookie = await signIn('9090');
  const first = await (await asStaff('/portal', cookie)).text();
  assert.ok(!/Zzq Before-you-arrived special/.test(first), 'the pre-existing backlog is not shown as new');
  // But anything posted after their first visit still reaches them.
  await form('/staff-portal/special', { name: 'Zzq After-you-arrived special', price: '22.00' });
  const second = await (await asStaff('/portal', cookie)).text();
  assert.match(second, /Zzq After-you-arrived special/, 'genuinely new notifications still show');
});

test("the portal breaks a shift down the way that night's email does", async () => {
  // The ask, in the owner's words: the same breakdown on the portal as in the
  // email people get, matching whatever position they are. The portal used to
  // show one line called "Tipped out to support" — a single number covering
  // every role it went to — and nothing at all about the sales that earned the
  // tips or the split between card and cash. So the two accounts of the same
  // money differed by exactly the part somebody would ask about.
  //
  // Both are rendered from the same engine result now. This checks the sections
  // are actually there and that the itemised tip-out adds up to the total it
  // used to show alone, which is the arithmetic that would break first if the
  // portal ever grew its own.
  const html = await (await asStaff('/portal/earnings', await signIn('1111'))).text();

  for (const section of ['Your sales', 'Your tips', 'Tip-out', 'How it reaches you']) {
    assert.match(html, new RegExp(section), `the ${section} section is on the page`);
  }
  for (const label of ['Card tips', 'Cash tips', 'Total tips collected', 'Tips you keep']) {
    assert.match(html, new RegExp(label), `${label} is broken out, as the email breaks it out`);
  }

  const num = (v) => Math.round(Number(String(v).replace(/[$,−-]/g, '')) * 100);
  const grab = (label) => {
    const m = html.match(new RegExp(label + '[\\s\\S]{0,140}?(−?\\$[\\d,]+\\.\\d{2})'));
    return m ? num(m[1]) : null;
  };
  // The tip-out is itemised by position now, not one lump. Every line between
  // the "Tip-out" heading and its total is a role that actually received money.
  const block = html.slice(html.indexOf('Tip-out'), html.indexOf('Total tip-out'));
  const parts = [...block.matchAll(/−(\$[\d,]+\.\d{2})/g)].map((m) => num(m[1]));
  assert.ok(parts.length >= 1, 'the tip-out names at least one position it went to');
  assert.strictEqual(parts.reduce((a, b) => a + b, 0), grab('Total tip-out'),
    'and the named pieces add up to the total — the same number the old single line showed');

  // Card and cash are what collected is made of, which is the identity the
  // email states line by line.
  assert.strictEqual(grab('Card tips') + grab('Cash tips'), grab('Total tips collected'),
    'card plus cash is what was collected');
});
