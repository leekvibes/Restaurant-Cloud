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
// The BUSINESS date, not the calendar one. Home asks portal_notes for notes
// live on the business date — so between midnight and the 4am cutoff, "today"
// is still last night. A test that used the calendar date passed for twenty
// hours a day and failed for four, which is how this was found.
const today = () => {
  const TC = require('../src/timeclock');
  return TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);
};

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

/**
 * The shift breakdown moved to its own page in Phase 2E.
 *
 * Pay shows one pay period at a time; the itemisation of a single shift is at
 * /portal/earnings/:id. These assertions are about the breakdown, so they
 * follow it rather than being deleted.
 */
const shiftPage = async (cookie, name, date = '2026-07-22') => {
  // The seeded shift, by date. "Newest" would drift as other tests add shifts,
  // and these assertions are about the figures on THIS one.
  const id = db.prepare(`SELECT sh.id FROM shifts sh JOIN work w ON w.shift_id = sh.id
    JOIN employees e ON e.id = w.employee_id
    WHERE e.name = ? AND sh.date = ? AND sh.status = 'emailed'
    ORDER BY sh.id DESC LIMIT 1`).get(name, date).id;
  return (await asStaff(`/portal/earnings/${id}`, cookie)).text();
};
/** The report form itself — what the hub's Start button opens. */
const tipForm = async (cookie) => (await form('/portal/tips', {}, { cookie })).text();

test.before(async () => {
  Database = require('better-sqlite3');
  // The live history cutoff is a business decision that moves; these tests are
  // about the machinery, so they open the window all the way and the one test
  // that is about the cutoff sets its own.
  const env = { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '',
    ZWIN_SKIP_BACKFILL: '1', PORTAL_HISTORY_FROM: '2000-01-01',
    // A real key pair, so push is genuinely configured here. The control is
    // only offered when the server can actually send — an unconfigured server
    // shows nothing rather than a card about a setup staff cannot do.
    VAPID_PRIVATE_KEY: '2VteNg65QI6QGatN58AyPwmQvU0HOYCA5P4HwvrpyIg' };
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
  // One job, and it is a tipped one. Bella has two now, so she is no longer
  // the right subject for "opens straight onto the sales section".
  emp.run('Solo Server', 'server', 900, '5555');

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
  // 2F: the sales categories feed tip POOLS, and the engine reads them from
  // server rows only (shiftInputs branches on role === 'server'). A barista's
  // sales columns are never read by any calculation, so asking for them
  // collects a number that goes nowhere. The fields are absent from the HTML
  // as sent — not hidden by a script a slow phone has yet to run.
  const server = await tipForm(await signIn('5555'));      // one job, and it is server
  const barista = await tipForm(await signIn('3333'));
  for (const f of ['st-food', 'st-coffee', 'st-alcohol']) {
    assert.match(server, new RegExp(`id="${f}"`), `a server is asked for ${f}`);
    assert.ok(!barista.includes(`id="${f}"`), `a barista is not asked for ${f}`);
  }
  // And cash is a DIFFERENT question for each, because the one column means
  // opposite things: kept by the server, pooled by the barista.
  assert.match(server, /already took home/, 'the server is asked what they kept');
  assert.ok(!/already took home/.test(barista), 'the barista is not');
  assert.match(barista, /Pooled cash tips/, 'the barista is asked what the pool collected');
  assert.ok(!/Pooled cash tips/.test(server), 'the server is not');

  // Two eligible jobs means nothing is assumed, including this.
  const both = await tipForm(await signIn('1111'));
  assert.ok(!both.includes('id="st-food"'), 'somebody with a choice to make is asked for neither');
});
test('one job goes straight through, two get a choice', async () => {
  // Nobody should have to answer "what did you work" when there is only one
  // answer, and nobody with two jobs should have it guessed for them — how
  // they are paid hangs on it.
  const one = await tipForm(await signIn('3333'));
  assert.match(one, /<input type="hidden" name="position" value="barista">/,
    'a barista is simply a barista');
  assert.ok(!/<select id="st-pos"/.test(one), 'and is asked nothing');

  const both = await tipForm(await signIn('1111'));
  assert.match(both, /<select id="st-pos" name="position"/, 'two jobs, so she picks');
  for (const r of ['server', 'barista']) {
    assert.match(both, new RegExp(`<option value="${r}"`), `${r} is on the menu`);
  }
  // And genuinely picks: no preselection, because which job she worked decides
  // whether the cash is hers or the pool's.
  assert.ok(!/<option value="(server|barista)"[^>]*selected/.test(both), 'nothing is chosen for her');
  assert.match(both, /<option value="">Choose the job you worked<\/option>/, 'she is asked outright');
});

test('the workspace has no hidden steps left to tab into', async () => {
  // 2F replaced a three-step wizard whose later steps sat in the markup the
  // whole time. A panel that is off-screen but still focusable is a trap for a
  // keyboard or a screen reader, and there is no longer one to fall into.
  const html = await tipForm(await signIn('1111'));
  for (const id of ['step1', 'step2', 'step3']) {
    assert.ok(!html.includes(`id="${id}"`), `${id} is gone, not merely hidden`);
  }
  // Only the form itself — the shared nav sheet below it is legitimately
  // hidden until somebody opens it, and it is not part of this workflow.
  const formPart = (html.split('<form')[1] || '').split('</form>')[0];
  assert.ok(!/\shidden(?![-\w=])/.test(formPart), 'nothing inside the form is hidden at all');
});
test('the report has a way back to the hub', async () => {
  // Anyone who opened the form to look at it must be able to leave without
  // ending their session. The old step one offered only "Not you?", which
  // signs you out.
  const html = await tipForm(await signIn('1111'));
  assert.match(html, /href="\/portal"/, 'there is a way home');
  assert.ok(!/Not you\?/.test(html), 'and leaving does not mean signing out');
});
test('every role gets the same home, minus what does not apply', async () => {
  // One layout, not three. Submitting is a row among the others now — a staff
  // member could not find it as a headline block — so the difference between a
  // server and a cook is just whether that one row is present. Everything else
  // is the same list in the same order.
  const cook = await (await asStaff('/portal', await signIn('2222'))).text();
  const server = await (await asStaff('/portal', await signIn('1111'))).text();

  assert.ok(!/Submit sales or tips/.test(cook), 'a cook is not offered the submission row');
  assert.match(server, /Submit sales or tips/, 'while a server gets it');

  // What Home keeps is what the bottom tabs do NOT already carry. Pay,
  // Timesheet, Time clock and Requests are tabs or attention rows; Specials
  // lives in More. Repeating them here was most of what made Home a second
  // copy of the navigation.
  const cookie = await signIn('2222');
  assert.ok(cook.includes('/portal/stock'), 'reporting stock is a Home row for everyone');
  assert.strictEqual((await asStaff('/portal/stock', cookie)).status, 200, 'and it opens');
  // Checked by the row TITLES, not by href: a notification about your pay
  // legitimately links to /portal/earnings, and that is a destination rather
  // than a shortcut. What must be gone is the shortcut row.
  // Scoped to Home's own body. The More menu is persistent chrome rendered on
  // every portal screen and carries Specials — that is navigation, not a Home
  // shortcut competing with it.
  const body = (cook.match(/<main class="pt-body tc-body hb"[\s\S]*?(?=<nav class="pt-tabs)/) || [cook])[0];
  for (const gone of ['Your hours &amp; pay']) {
    assert.ok(!body.includes(gone), `"${gone}" is no longer a Home shortcut row`);
  }
  // Specials reaches Home as CONTENT — the dishes, part of the briefing — and
  // must still never appear as a navigation row duplicating the More sheet.
  assert.ok(!/>Specials &amp; 86 board</.test(body),
    'Specials is briefing content on Home, not a shortcut row');
  for (const href of ['/portal/earnings', '/portal/specials', '/portal/timesheet']) {
    assert.strictEqual((await asStaff(href, cookie)).status, 200, `${href} still opens from its tab`);
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
  const html = await shiftPage(await signIn('1111'), 'Bella Reyes');
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
  // Home no longer keeps a last-shift card — Pay is a bottom tab, and Home is
  // not a second copy of the navigation. Past shifts live on the Pay page.
  // Taken from the shift itself. Home no longer carries a last-shift card —
  // Pay is a bottom tab — and with a single sent shift the Pay page has no
  // "past shifts" list either, so there is no link to scrape. The page under
  // test is the breakdown, and it is reached by its own id.
  const id = db.prepare("SELECT id FROM shifts WHERE status = 'emailed' ORDER BY id DESC LIMIT 1").get().id;

  const one = await (await asStaff(`/portal/earnings/${id}`, cookie)).text();
  assert.match(one, /You kept|You worked/, 'the shift opens to its breakdown');
  assert.match(one, /Hours worked|Your rate|salaried/, 'with the hours side of it');
  // The way back is the header's back link now, not a right-hand "All earnings"
  // link — same destination, same place on every screen.
  assert.match(one, /<a class="pt-back" href="\/portal\/earnings"/, 'and a way back to the list');

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
  assert.match(await res.text(), /Submit sales &amp; tips/, 'which is the workspace');
});

test('a cook is shown what they received, without a tip-out they never paid', async () => {
  // Kitchen does not hand tips in, but it does receive a share of the pot —
  // so the honest screen for a cook is what came to them, not a blank. What it
  // must not show is "tipped out to support", which is money leaving, and a
  // cook is the support it leaves towards.
  const html = await shiftPage(await signIn('2222'), 'Marco Diaz');
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

  const html = await shiftPage(await signIn('1111'), 'Bella Reyes');
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
  // 4002, and unique across the whole suite — boot.test.js now proves that.
  //
  // This was 3995, which is schedule-board.test.js's own port. Run alone the
  // test passed; run in the parallel suite the two servers raced for the
  // socket, this fetch reached whichever won, and when that was the board's
  // server — which has no PORTAL_HISTORY_FROM — the floor was never applied and
  // June appeared. The comment below already records this test being moved off
  // one collision; it landed on another.
  const port = 4002;
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
    // Checked on the archive: Pay shows one pay period, and the floor is a
    // statement about history, which is the page history lives on now.
    const cut = await (await fetch(`http://127.0.0.1:${port}/portal/earnings/shifts`, { headers: { cookie } })).text();
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
  const html = await shiftPage(await signIn('2222'), 'Marco Diaz');
  assert.match(html, /8 hrs/, 'the hours they worked');
  assert.match(html, /\$16\.50\/hr/, 'the rate behind them');
  assert.match(html, /\$132\.00/, 'and what those hours came to');
});

test('somebody who received nothing is shown their hours, not a zero', async () => {
  // The engine lists everyone who worked on the support side of a shift,
  // including positions no tip-out ever reaches. Leading with "You kept $0.00"
  // answers a question they did not ask and buries the one they did — and on a
  // screen about pay, a zero reads like a statement about their pay.
  const html = await shiftPage(await signIn('4444'), 'Nico Vance');
  assert.match(html, /You worked/, 'the headline is what they did');
  assert.match(html, /4 hrs/, 'and it is their actual hours from the shift');
  assert.ok(!/\$0\.00/.test(html), 'no zero anywhere on it');

  // The rule is "nothing arrived", not "this position does not hand tips in".
  // A busser hands nothing in and still gets a share every service, so keying
  // it on that setting would hide real money from the person who earned it.
  const cook = await shiftPage(await signIn('2222'), 'Marco Diaz');
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

test('the admin portal survives an OPEN shift with people on it', async () => {
  // The regression this exists for: the "handed in tonight" block reads a
  // takesTips Map that Phase 2D-1 (50a08aa) deleted. The other caller was
  // updated, this one was not, and it lives inside a template literal — so it
  // only evaluated when `openShift` was truthy AND somebody was on it.
  //
  // Which means the page 500'd DURING SERVICE and looked perfectly fine every
  // other hour of the day. Every existing test here ran without an open shift,
  // so all of them passed while the owner could not open the page.
  //
  // The condition, not the symptom, is what is pinned here.
  // The BUSINESS date, because that is what the route asks shifts for.
  //
  // This line used to be the calendar date, matching a defect on that page: it
  // looked up tonight's shift by the calendar day, so between midnight and the
  // 4am cutoff it asked for tomorrow, found nothing, and rendered "who still
  // owes a floor report" as nobody. That is fixed, and this fixture follows the
  // route rather than the wall clock — otherwise it goes red every night
  // between midnight and four, which is exactly when it did.
  const d = today();
  const w = new Database(DB);
  const sid = w.prepare("INSERT INTO shifts (date, daypart, status, created_at) VALUES (?, 'dinner', 'open', datetime('now'))")
    .run(d).lastInsertRowid;
  const who = w.prepare('SELECT id, role FROM employees ORDER BY id LIMIT 3').all();
  const ins = w.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,6)');
  for (const p of who) ins.run(sid, p.id, p.role);
  w.close();

  try {
    for (const tab of ['reports', 'board', 'notes', 'positions']) {
      const res = await fetch(`${BASE}/staff-portal?tab=${tab}`);
      assert.strictEqual(res.status, 200, `${tab} renders mid-service, not a 500`);
    }
    const html = await (await fetch(`${BASE}/staff-portal?tab=reports`)).text();
    assert.match(html, /Handed in tonight/, 'the block that crashed is actually on the page');
    // Everybody on the shift is listed, each with a verdict rather than a gap.
    for (const p of who) {
      const emp = new Database(DB).prepare('SELECT name FROM employees WHERE id = ?').get(p.id);
      assert.ok(html.includes(emp.name), `${emp.name} is listed`);
    }
    assert.match(html, /nothing to hand in|waiting|sent/,
      'and the eligibility question was answered, not skipped');
  } finally {
    const c = new Database(DB);
    c.prepare('DELETE FROM work WHERE shift_id = ?').run(sid);
    c.prepare('DELETE FROM shifts WHERE id = ?').run(sid);
    c.close();
  }
});

test('who owes a submission is asked ONCE, by the same rule in both places', async () => {
  // The strip counts them and the list names them. They used to be two
  // different expressions — the count from canSubmitSalesTips, the list from a
  // Map — which is how one of them could go stale without the other noticing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf("app.get('/staff-portal'"), src.indexOf("app.post('/staff-portal/stock"));
  const asks = (route.match(/canSubmitSalesTips\(/g) || []).length;
  assert.ok(asks >= 2, `both the count and the list ask the same function (found ${asks})`);
  // Comments stripped first, or this matches the note explaining the fix and
  // fails on the very change that made it true.
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\btakesTips\b/.test(code), 'and no CODE reads the Map that no longer exists');
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
  // Yesterday relative to the BUSINESS date, since that is what the note
  // window is measured against.
  const yesterday = require('../src/dates').addDays(today(), -1);
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

test("the floor gets an Updates heads-up when a special is posted", async () => {
  // The section is called Updates now and it is secondary — before-shift notes
  // come straight from portal_notes and no longer depend on this feed. What it
  // still has to do is unchanged: show what arrived since you last looked,
  // mark it unread once, and stop marking it after you have seen it.
  const cookie = await signIn('1111');
  await (await asStaff('/portal', cookie)).text();
  await form('/staff-portal/special', { name: 'Qqx Heads-up branzino', price: '30.00' });
  const first = await (await asStaff('/portal', cookie)).text();
  assert.match(first, /Updates/, 'the secondary feed shows');
  assert.match(first, /Qqx Heads-up branzino/, 'naming the special');
  assert.match(first, /pt-new-dot/, 'marked unread the first time');
  assert.match(first, /Unread/, 'with a word for anybody who cannot see the dot');
  const second = await (await asStaff('/portal', cookie)).text();
  assert.match(second, /Qqx Heads-up branzino/, 'it is still recent, so it is still shown');
  assert.ok(!/pt-new-dot/.test(second), 'but no longer flagged as new');
  assert.match(second, /See all notifications/, 'with the whole feed one tap away');
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
  // The control moved off Home to /portal/notifications, reached from More:
  // turning push on is a once-per-phone setting, and a pre-shift briefing is
  // read every shift. Everything about the subscription itself is unchanged.
  const cookie = await signIn('1111');
  const home = await (await asStaff('/portal', cookie)).text();
  assert.ok(!/id="ptpush"/.test(home), 'device settings are not on Home any more');
  const settings = await (await asStaff('/portal/notifications', cookie)).text();
  assert.match(settings, /id="ptpush"/, 'the turn-on control is where notifications live');
  assert.match(settings, /data-vapid="/, 'with a public key to subscribe against');

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

test('filing an expense notifies nobody — however it was paid for', async () => {
  // This used to raise "Rosa is owed $18.40" whenever somebody fronted the
  // money themselves. In practice almost every expense is fronted by a person,
  // so it fired on nearly every save and the owner turned it off. What is owed
  // still leads the Expenses page, which is where somebody settling up looks.
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='expense'").get().n;
  await form('/c/expenses', { spent_on: today(), name: 'ice bags', amount_cents: '18.00',
    paid_by: 'Rosa', paid_with: 'Their own money' });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='expense'").get().n, before,
    'their-own-money raises nothing');

  // The expense itself still lands, and still records that a person is owed —
  // only the announcement went.
  const row = db.prepare('SELECT * FROM m_expenses ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(row.name, 'ice bags', 'the expense is filed');
  assert.strictEqual(row.paid_with, 'Their own money', 'and who fronted it is still recorded');

  await form('/c/expenses', { spent_on: today(), name: 'napkins', amount_cents: '12.00',
    paid_by: 'Rosa', paid_with: 'Company card' });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='expense'").get().n, before,
    'and a company-card expense raises nothing either');
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

test('the daily sweep raises stale floor reports and document deadlines — once, and never invoices', async () => {
  // Seed three conditions. Only two of them are still swept: invoices were
  // dropped because a backlog of open bills produced one alert each on the
  // same morning. The overdue invoice below is seeded precisely to prove it
  // stays quiet.
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
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='invoice'").get().n, 0,
    'the overdue invoice is NOT announced — due and overdue live on the dashboard, not in the bell');
  assert.ok(db.prepare("SELECT 1 FROM admin_events WHERE kind='floor' AND title LIKE '%sweep test milk%'").get(), 'stale floor report raised');
  assert.ok(db.prepare("SELECT 1 FROM admin_events WHERE kind='document' AND title LIKE '%Sweep Test Permit%'").get(), 'document deadline raised');

  // Run it again: the same situations must not be announced twice.
  const docBefore = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='document'").get().n;
  await sweepOnce(PORT + 62);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='document'").get().n, docBefore,
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

test('overriding a duplicate-invoice warning files it and notifies nobody', async () => {
  // The override used to be announced, on the reasoning that it is the classic
  // path to paying a vendor twice. It fired on essentially every upload —
  // because the reader misreads the invoice number on real invoices, genuine
  // deliveries flag as duplicates and the warning is overridden every time.
  // The on-screen warning is untouched; only the notification went.
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind = 'invoice_dup'").get().n;
  await form('/c/invoices', { dup_ok: '1', amount: '99.00', invoice_number: 'DUP-TEST-1',
    invoice_date: today(), status: 'Unpaid', category: 'Other' });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind = 'invoice_dup'").get().n, before,
    'the override raises nothing');
  const inv = db.prepare('SELECT * FROM m_invoices ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(inv.invoice_number, 'DUP-TEST-1', 'but the invoice is filed');
});

test('a brand-new user starts clean — no backlog, only what arrives after them', async () => {
  db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active, pin) VALUES ('Fresh Newbie','server',900,1,'9090')").run();
  await form('/staff-portal/special', { name: 'Zzq Before-you-arrived special', price: '20.00' });
  const cookie = await signIn('9090');
  const first = await (await asStaff('/portal', cookie)).text();
  // The rule is about the NOTIFICATION backlog, and it still holds: a new
  // arrival is not handed a history of announcements posted before they were
  // hired. The board is a different thing — a special that is still running is
  // still running, and somebody starting today needs to know about it. So the
  // assertion is scoped to the Updates feed rather than to the whole page.
  const updates = (first.split('>Updates<')[1] || '').split('</section>')[0];
  assert.ok(!/Zzq Before-you-arrived special/.test(updates),
    'the pre-existing backlog is not shown as new');
  await form('/staff-portal/special', { name: 'Zzq After-you-arrived special', price: '22.00' });
  const second = await (await asStaff('/portal', cookie)).text();
  const updates2 = (second.split('>Updates<')[1] || '').split('</section>')[0];
  assert.match(updates2, /Zzq After-you-arrived special/, 'genuinely new notifications still show');
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
  const html = await shiftPage(await signIn('1111'), 'Bella Reyes');

  for (const section of ['Your sales', 'Your tips', 'Tip-out', 'How it reaches you']) {
    assert.match(html, new RegExp(section), `the ${section} section is on the page`);
  }
  for (const label of ['Card tips', 'Cash tips', 'Total tips collected', 'Tips you keep']) {
    assert.match(html, new RegExp(label), `${label} is broken out, as the email breaks it out`);
  }

  const num = (v) => Math.round(Number(String(v).replace(/[$,−-]/g, '')) * 100);
  // Scoped to the shift breakdown. The page now opens with a pay-PERIOD card
  // that has its own Card tips line, and a page-wide scrape would compare the
  // fortnight's figures against the night's.
  // The whole page is the shift now — there is no "Your last shift" section to
  // slice from, because Pay no longer carries one shift's breakdown inline.
  const shiftHtml = html;
  const grab = (label) => {
    const m = shiftHtml.match(new RegExp(label + '[\\s\\S]{0,140}?(−?\\$[\\d,]+\\.\\d{2})'));
    return m ? num(m[1]) : null;
  };
  // The tip-out is itemised by position now, not one lump. Every line between
  // the "Tip-out" heading and its total is a role that actually received money.
  const block = shiftHtml.slice(shiftHtml.indexOf('Tip-out'), shiftHtml.indexOf('Total tip-out'));
  const parts = [...block.matchAll(/−(\$[\d,]+\.\d{2})/g)].map((m) => num(m[1]));
  assert.ok(parts.length >= 1, 'the tip-out names at least one position it went to');
  assert.strictEqual(parts.reduce((a, b) => a + b, 0), grab('Total tip-out'),
    'and the named pieces add up to the total — the same number the old single line showed');

  // Card and cash are what collected is made of, which is the identity the
  // email states line by line.
  assert.strictEqual(grab('Card tips') + grab('Cash tips'), grab('Total tips collected'),
    'card plus cash is what was collected');
});

test('when a period ends, the people who owe a timesheet are told — twice at most', async () => {
  // The submit button is hidden while a period is running, so the one moment it
  // appears is a Sunday night when nobody is looking. Payroll then spends
  // Monday chasing signatures by text. This is the thing that stops that.
  const P2 = require('../src/periods');
  const D2 = require('../src/dates');
  const per = P2.recentPeriods(2)[1];              // the one that has just ended
  const day = D2.addDays(per.start, 2);

  const owes = db.prepare("SELECT id FROM employees WHERE pin = '1111'").get().id;   // Bella
  db.prepare(`INSERT INTO time_entries
    (employee_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, raw_minutes, payable_minutes)
    VALUES (?,?,'dinner','server',?,?, 'complete','manager',480,480)`)
    .run(owes, day, `${day} 17:00:00`, `${D2.addDays(day, 1)} 01:00:00`);

  const serverPath = path.join(__dirname, '..', 'src', 'server.js');
  const sweepOnce = async (port) => {
    const s = spawn(process.execPath, [serverPath], {
      env: { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '',
        ZWIN_SKIP_BACKFILL: '1', ZWIN_SWEEP_NOW: '1', PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 90; i++) {
      try { await fetch(`http://127.0.0.1:${port}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await new Promise((r) => setTimeout(r, 400));
    s.kill();
    await new Promise((r) => setTimeout(r, 200));
  };
  const remindersFor = (id) => db.prepare(
    "SELECT * FROM portal_events WHERE kind='timesheet' AND employee_id = ? ORDER BY id").all(id);

  await sweepOnce(PORT + 63);
  const first = remindersFor(owes);
  assert.strictEqual(first.length, 1, 'one reminder, to the person who owes one');
  assert.match(first[0].title, /ready to submit/i, 'saying what to do');
  assert.match(first[0].href, /^\/portal\/timesheet\?p=/, 'and linking to the page with the button');
  assert.match(first[0].body, /\d/, 'with the hours in it');

  // Addressed to that person, not broadcast to the floor. Somebody else's
  // hours are nobody else's business.
  assert.ok(!db.prepare("SELECT 1 FROM portal_events WHERE kind='timesheet' AND employee_id IS NULL").get(),
    'nothing went to everyone');

  // The sweep re-checks the same state every day by design. A reminder that
  // fires every time is a reason to turn notifications off.
  await sweepOnce(PORT + 64);
  assert.strictEqual(remindersFor(owes).length, 1, 'a second sweep the same day says nothing new');

  // Two days on, still unsigned: one more, and only one. Backdate the record of
  // the first message rather than the period, because that is what the spacing
  // is measured from — a deploy that delayed the first must not bunch them up.
  db.prepare("UPDATE staff_notified SET created_at = datetime('now','-3 days') WHERE key LIKE 'ts_remind:%'").run();
  await sweepOnce(PORT + 67);
  const second = remindersFor(owes);
  assert.strictEqual(second.length, 2, 'a follow-up, once it has been sitting there');
  assert.match(second[1].title, /still unsigned/i, 'and it says so plainly');

  // Never a third, however long it sits.
  db.prepare("UPDATE staff_notified SET created_at = datetime('now','-30 days')").run();
  await sweepOnce(PORT + 68);
  assert.strictEqual(remindersFor(owes).length, 2, 'two is the most anybody gets');

  // And once it is signed, it stops — even with every record of having been
  // told wiped, which is the strongest form of the claim: it is the SHEET that
  // makes it quiet, not the memory of having sent something.
  const beforeSigning = remindersFor(owes).length;
  db.prepare(`INSERT INTO timesheets (employee_id, period_start, period_end, status, submitted_at)
    VALUES (?,?,?,'submitted', datetime('now'))
    ON CONFLICT(employee_id, period_start) DO UPDATE SET status='submitted'`)
    .run(owes, per.start, per.end);
  db.prepare('DELETE FROM staff_notified').run();          // as if nothing had been sent
  await sweepOnce(PORT + 65);
  assert.strictEqual(remindersFor(owes).length, beforeSigning, 'a submitted sheet is not chased');
});

test('somebody who worked none of the period is not asked to submit one', async () => {
  // The reminder reads periodToSign, the same function the portal banner uses,
  // so it is quiet for anyone with no hours — being told to sign an empty
  // timesheet is how people learn to ignore the notification.
  const P2 = require('../src/periods');
  const per = P2.recentPeriods(2)[1];
  const idle = db.prepare("INSERT INTO employees (name, role, pin, hourly_rate_cents, active) VALUES ('Idle Hands','server','7742',1500,1)").run().lastInsertRowid;
  assert.strictEqual(db.prepare(
    'SELECT COUNT(*) n FROM time_entries WHERE employee_id = ? AND business_date BETWEEN ? AND ?')
    .get(idle, per.start, per.end).n, 0, 'they worked nothing');

  const serverPath = path.join(__dirname, '..', 'src', 'server.js');
  const s = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '',
      ZWIN_SKIP_BACKFILL: '1', ZWIN_SWEEP_NOW: '1', PORT: String(PORT + 66) }, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`http://127.0.0.1:${PORT + 66}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  await new Promise((r) => setTimeout(r, 400));
  s.kill();
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(!db.prepare("SELECT 1 FROM portal_events WHERE kind='timesheet' AND employee_id = ?").get(idle),
    'and were not asked to sign for them');
});

// ── One header, and a way back from everywhere ───────────────────────────────
// Screens had grown their own chrome: most said "← Home" whatever the trail,
// the timesheet had a different header entirely, and the tips receipt had a
// deliberate blank where a back button goes — so people were closing the app
// and reopening it to reach the time clock.

test('every portal sub-page wears the same header, with a way back', async () => {
  const cookie = await signIn('1111');
  const D2 = require('../src/dates');
  const today = D2.isoDate(new Date());

  // Every screen a person can reach by tapping. The hub is deliberately absent
  // — it is where back GOES, so it is the one page without one.
  // Pay joined the hub as a page without a back link: it is a bottom tab, so
  // it is a destination rather than somewhere you drilled into. Its own
  // sub-pages (shift history, shift detail) do carry one, and are checked here.
  const pages = [
    '/portal/earnings/shifts', '/portal/specials', '/portal/stock', '/portal/clock',
    '/portal/clock/history', '/portal/requests', '/portal/timesheet',
    `/portal/timesheet/day/${today}`,
  ];

  const missing = [];
  for (const p of pages) {
    const res = await asStaff(p, cookie);
    assert.strictEqual(res.status, 200, `${p} renders`);
    const html = await res.text();
    const crumb = (html.match(/<div class="pt-crumb">([\s\S]*?)<\/div>/) || [])[1];
    if (!crumb) { missing.push(`${p}: no crumb at all`); continue; }
    // The back link, and it is the FIRST thing in the header — a back button
    // somewhere else on the bar is not the one a thumb reaches for.
    const back = crumb.match(/^\s*<a class="pt-back" href="([^"]+)"[^>]*>\s*‹\s*([^<]+)</);
    if (!back) { missing.push(`${p}: no leading back link`); continue; }
    if (!/^\/(portal|tips)/.test(back[1])) missing.push(`${p}: back goes off the portal (${back[1]})`);
    if (back[1] === p) missing.push(`${p}: back points at itself`);
    // And the page names itself in the corner.
    if (!/class="pt-who">/.test(crumb)) missing.push(`${p}: no page name`);
    // The link works, rather than 404ing on a path somebody mistyped.
    const target = await asStaff(back[1], cookie);
    if (target.status !== 200) missing.push(`${p}: back → ${back[1]} answers ${target.status}`);
  }
  assert.deepStrictEqual(missing, [], 'every sub-page has a working back link and a name');

  // The hub itself has no crumb — it is the destination, not a stop.
  const hub = await (await asStaff('/portal', cookie)).text();
  assert.match(hub, /class="pt-crumb"/, 'the hub wears the same header as everything else');
  assert.ok(!/class="pt-back"/.test(hub), 'but needs no way back to itself');

  // And nothing is still wearing the old timesheet-only header.
  for (const p of pages) {
    const html = await (await asStaff(p, cookie)).text();
    assert.ok(!/class="tsx-back"/.test(html), `${p} does not use the old header`);
  }
});

test('the back link follows the trail, not just the parent', async () => {
  // A shift is reachable from the timesheet, from a day, and from time history.
  // A static parent is right for a cold open and wrong for all three, so the
  // page ships the parent as a real href and upgrades it from history — and
  // relabels itself when the two disagree, because a button that says "Time
  // clock" and lands on the timesheet is worse than one that says Back.
  const cookie = await signIn('1111');
  const html = await (await asStaff('/portal/clock', cookie)).text();
  assert.match(html, /data-pt-back/, 'the back link is marked for the script');
  assert.match(html, /history\.back\(\)/, 'and the script is on the page');
  assert.match(html, /document\.referrer/, 'gated on where they came from');
  assert.match(html, /history\.length <= 1/, 'and on there being any history');
  // A cold open has neither, so the plain href has to stand on its own.
  assert.match(html, /<a class="pt-back" href="\/portal"/, 'the href is a real destination');

  // The hub has no back link, so it must not carry the script either.
  const hub = await (await asStaff('/portal', cookie)).text();
  assert.ok(!/history\.back\(\)/.test(hub), 'and the hub ships no back script');
});

test('the legacy receipt URL shows no money taken from the URL', async () => {
  // 2F: this screen used to build every figure on it out of the query string.
  // Anyone could retype the numbers in the address bar and be shown them back
  // as though the restaurant had recorded them. It shows no amounts at all
  // now — the real receipt reads the stored row, behind a session that proves
  // whose it is.
  const html = await (await fetch(`${BASE}/tips?done=1&cash=40.00&card=25.50&sales=999.99`)).text();
  assert.match(html, /ecorded/, 'it still confirms the report');
  for (const n of ['40.00', '25.50', '999.99']) {
    assert.ok(!html.includes(n), `${n} came off the URL and is not shown back`);
  }
  assert.match(html, /href="\/portal"/, 'and there is a way out');
});
// ===========================================================================
// PHASE 2E-1 — proving the Pay archive rather than asserting it.
// ===========================================================================

/** 105 finished shifts for one person, with deliberate same-date collisions. */
function seedBigHistory() {
  const w = new Database(DB);
  w.prepare("INSERT OR IGNORE INTO employees (id, name, role, hourly_rate_cents, active, pin) VALUES (900,'Archive Amy','server',1500,1,'9001')").run();
  w.prepare("INSERT OR IGNORE INTO employees (id, name, role, hourly_rate_cents, active, pin) VALUES (901,'Other Owen','server',1500,1,'9002')").run();
  const mkShift = w.prepare("INSERT INTO shifts (date, daypart, status, created_at) VALUES (?,?,'emailed',datetime('now'))");
  const mkWork = w.prepare('INSERT OR IGNORE INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)');
  const D = require('../src/dates');
  const ids = [];
  // (date, daypart) is unique, so 53 days x 2 services. Two shifts share every
  // date — which is the case an unstable sort quietly gets wrong between pages.
  for (let d = 0; d < 53 && ids.length < 105; d += 1) {
    const date = D.addDays('2025-06-01', -d);
    for (const part of ['cafe', 'dinner']) {
      if (ids.length >= 105) break;
      const id = mkShift.run(date, part).lastInsertRowid;
      mkWork.run(id, 900, 'server', 6);
      ids.push({ id, date });
    }
  }
  // One shift belonging to somebody else, on a date of its own.
  const foreign = mkShift.run(D.addDays('2025-06-01', -60), 'dinner').lastInsertRowid;
  mkWork.run(foreign, 901, 'server', 6);
  w.close();
  return { ids, foreign };
}

test('2E-1: 105 shifts page cleanly — every row exactly once, newest first', async () => {
  const { ids, foreign } = seedBigHistory();
  assert.strictEqual(ids.length, 105, 'the fixture really is 105 shifts');
  const cookie = await signIn('9001');

  const first = await (await asStaff('/portal/earnings/shifts', cookie)).text();
  const pages = Number((first.match(/Page 1 of (\d+)/) || [])[1]);
  assert.strictEqual(pages, 6, '105 over 20 is six pages');
  assert.match(first, /105 shifts recorded/, 'and the count is the population');

  const idsOn = (html) => [...html.matchAll(/href="\/portal\/earnings\/(\d+)\?from=shifts/g)]
    .map((m) => Number(m[1]));

  const seen = [];
  const sizes = [];
  for (let p = 1; p <= pages; p += 1) {
    const html = await (await asStaff(`/portal/earnings/shifts?page=${p}`, cookie)).text();
    const got = idsOn(html);
    sizes.push(got.length);
    seen.push(...got);
    assert.ok(!got.includes(foreign), `page ${p} never shows another employee's shift`);
  }
  assert.deepStrictEqual(sizes, [20, 20, 20, 20, 20, 5],
    'twenty a page, and the remainder on the last');

  // The whole set, exactly once each — not "next and previous links exist".
  assert.strictEqual(seen.length, 105, '105 rows across the archive');
  assert.strictEqual(new Set(seen).size, 105, 'no id appears twice');
  const expected = new Set(ids.map((x) => x.id));
  for (const id of seen) assert.ok(expected.has(id), `${id} is one of Amy's`);
  for (const id of expected) assert.ok(seen.includes(id), `${id} is not missing`);

  // Global ordering: date DESC, then id DESC as the tie-break.
  const byId = new Map(ids.map((x) => [x.id, x.date]));
  for (let i = 1; i < seen.length; i += 1) {
    const a = { id: seen[i - 1], date: byId.get(seen[i - 1]) };
    const b = { id: seen[i], date: byId.get(seen[i]) };
    assert.ok(a.date > b.date || (a.date === b.date && a.id > b.id),
      `${a.date}#${a.id} sorts before ${b.date}#${b.id}`);
  }
});

test('2E-1: only page-sized work is done, however long the history', async () => {
  const cookie = await signIn('9001');
  // Bounded by construction: pages 1 and 2 are disjoint 20-row windows of a
  // 105-row history, which an in-memory slice of the whole archive could also
  // produce — so the real evidence is that the row query carries LIMIT/OFFSET
  // and the engine runs once per returned row.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function earningsFor('), src.indexOf('\n}', src.indexOf('function earningsFor(')));
  assert.match(fn, /LIMIT \? OFFSET \?/, 'the row query pages in SQL');
  assert.match(fn, /\.all\(empId, HISTORY_FROM, limit, offset\)/, 'bound to the request');
  assert.strictEqual((fn.match(/runShift\(/g) || []).length, 1,
    'the engine is invoked once per returned row and nowhere else');
  const count = src.slice(src.indexOf('const earningsCount'), src.indexOf('function earningsFor('));
  assert.match(count, /SELECT COUNT\(\*\)/, 'the total is a COUNT, not a load');
  assert.ok(!/runShift/.test(count), 'and costs nothing');

  // And the main Pay page does not reach for the archive.
  const pay = src.slice(src.indexOf("app.get('/portal/earnings', (req, res)"),
    src.indexOf("app.get('/portal/earnings/shifts'"));
  const call = (pay.match(/earningsFor\(emp\.id, (\d+)\)/) || [])[1];
  assert.ok(Number(call) <= 60, `Pay costs a bounded window, not the archive (saw ${call})`);
  const t0 = Date.now();
  await asStaff('/portal/earnings/shifts', cookie);
  const t1 = Date.now();
  await asStaff('/portal/earnings/shifts?page=5', cookie);
  const t2 = Date.now();
  // No threshold — a late page must simply not cost more than an early one,
  // which is what loading-everything-then-slicing would show.
  assert.ok((t2 - t1) < (t1 - t0) * 4 + 500,
    `page 5 is not dramatically dearer than page 1 (${t1 - t0}ms vs ${t2 - t1}ms)`);
});

test('2E-1: a page value out of range lands somewhere real', async () => {
  const cookie = await signIn('9001');
  const at = async (q) => {
    const html = await (await asStaff(`/portal/earnings/shifts${q}`, cookie)).text();
    return Number((html.match(/Page (\d+) of/) || [])[1]);
  };
  assert.strictEqual(await at(''), 1, 'no page is page 1');
  assert.strictEqual(await at('?page=1'), 1, 'page 1');
  assert.strictEqual(await at('?page=3'), 3, 'a middle page');
  assert.strictEqual(await at('?page=6'), 6, 'the last page');
  // Clamped, not errored and not empty — an archive is somewhere you browse.
  assert.strictEqual(await at('?page=999'), 6, 'beyond the end clamps to the last');
  assert.strictEqual(await at('?page=0'), 1, 'zero');
  assert.strictEqual(await at('?page=-4'), 1, 'negative');
  assert.strictEqual(await at('?page=2.7'), 2, 'a decimal floors');
  assert.strictEqual(await at('?page=banana'), 1, 'nonsense');
  assert.strictEqual(await at('?page=2&page=5'), 1, 'a repeated value is not trusted');
  // And it never bounces: the URL asked for is the URL served.
  const res = await fetch(`${BASE}/portal/earnings/shifts?page=999`, { headers: { cookie }, redirect: 'manual' });
  assert.strictEqual(res.status, 200, 'no redirect loop');
});

test('2E-1: the archive is only ever your own shifts', async () => {
  const amy = await signIn('9001');
  const owen = await signIn('9002');
  const owenHtml = await (await asStaff('/portal/earnings/shifts', owen)).text();
  assert.match(owenHtml, /1 shift recorded/, "Owen's archive counts only Owen's");
  const owenIds = [...owenHtml.matchAll(/earnings\/(\d+)\?from=shifts/g)].map((m) => Number(m[1]));
  assert.strictEqual(owenIds.length, 1);

  // Amy cannot open it by typing the id, and is not told it exists.
  const res = await fetch(`${BASE}/portal/earnings/${owenIds[0]}`, { headers: { cookie: amy }, redirect: 'manual' });
  assert.strictEqual(res.status, 302, 'a foreign id is turned away');
  assert.strictEqual(res.headers.get('location'), '/portal/earnings', 'to her own Pay page');
  const body = await res.text();
  assert.ok(!/Owen/.test(body), 'and nothing about whose it was');
  // A shift that does not exist behaves identically — no oracle either way.
  const missing = await fetch(`${BASE}/portal/earnings/99999999`, { headers: { cookie: amy }, redirect: 'manual' });
  assert.strictEqual(missing.status, 302);
  assert.strictEqual(missing.headers.get('location'), '/portal/earnings',
    'missing and foreign are indistinguishable from outside');
});

test('2E-1: Back from a shift returns to the page it was opened from', async () => {
  const cookie = await signIn('9001');
  const html = await (await asStaff('/portal/earnings/shifts?page=3', cookie)).text();
  const id = Number((html.match(/earnings\/(\d+)\?from=shifts/) || [])[1]);
  assert.ok(html.includes(`?from=shifts&amp;page=3`) || html.includes('?from=shifts&page=3'),
    'rows carry the page they were listed on');

  const back = async (q) => {
    const d = await (await asStaff(`/portal/earnings/${id}${q}`, cookie)).text();
    return (d.match(/class="pt-back" href="([^"]+)"/) || [])[1];
  };
  assert.strictEqual(await back('?from=shifts&page=3'), '/portal/earnings/shifts?page=3',
    'back to the archive, on the page they were on');
  assert.strictEqual(await back('?from=shifts'), '/portal/earnings/shifts', 'or its first page');
  assert.strictEqual(await back(''), '/portal/earnings', 'and Pay by default');

  // Nothing from the query string can become the destination.
  for (const evil of ['?from=https://evil.test', '?from=//evil.test', '?from=javascript:alert(1)',
    '?from=%2F%2Fevil.test', '?from=/portal/out', '?from=shifts&page=javascript:1',
    '?from=shifts&page=-1', '?from=shifts&page=%2F%2Fevil']) {
    const href = await back(evil);
    assert.ok(href === '/portal/earnings' || href === '/portal/earnings/shifts',
      `"${evil}" cannot steer Back (got ${href})`);
    assert.ok(!/evil|javascript|\/\//.test(href.replace('/portal', '')), `${evil} is not reflected`);
  }
});

// ===========================================================================
// PHASE 2E-2 — the money has to add up, on the page, in cents.
//
// These read the RENDERED page and reconcile it against itself. That is the
// property that matters to somebody holding the phone: whatever the engine
// produced, the rows they can see must sum to the figure they are being shown.
// A test that recomputed the engine's answer and compared it with itself would
// pass while the page quietly displayed something else.
// ===========================================================================

/** Every "$x.yz" in a fragment, as integer cents. No float arithmetic. */
const centsIn = (html) => [...html.matchAll(/(−?)\$([\d,]+)\.(\d{2})/g)]
  .map((m) => (m[1] ? -1 : 1) * (Number(m[2].replace(/,/g, '')) * 100 + Number(m[3])));
const oneCents = (html) => { const c = centsIn(html); return c.length ? c[0] : null; };
/** The markup between one section heading and the next. */
const sectionOf = (html, heading) => {
  const i = html.indexOf(heading);
  if (i < 0) return '';
  const j = html.indexOf('tc-kick-sec', i + heading.length);
  return html.slice(i, j < 0 ? html.length : j);
};

/** A period with awkward cents: $17.33/hr over 6.25h is 10831.25 -> 10831. */
function seedMoneyPeriod() {
  const P2 = require('../src/periods');
  const D2 = require('../src/dates');
  const per = P2.recentPeriods(2)[1];
  const w = new Database(DB);
  w.prepare("INSERT OR IGNORE INTO employees (id, name, role, hourly_rate_cents, active, pin) VALUES (910,'Cents Carla','server',1733,1,'9101')").run();
  const mk = w.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status, created_at) VALUES (?,?,'emailed',datetime('now'))");
  const find = w.prepare('SELECT id FROM shifts WHERE date = ? AND daypart = ?');
  const work = w.prepare(`INSERT INTO work (shift_id, employee_id, role, hours)
    VALUES (?,?,'server',?) ON CONFLICT(shift_id, employee_id) DO UPDATE SET hours = excluded.hours`);
  const sales = w.prepare(`INSERT INTO server_sales
      (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(shift_id, employee_id) DO UPDATE SET
      card_tips_cents = excluded.card_tips_cents, cash_tips_cents = excluded.cash_tips_cents`);
  const days = [];
  // One in each payroll week, so week 1 / week 2 both carry hours.
  for (const [off, card, cash] of [[1, 8737, 4319], [9, 6151, 2783]]) {
    const date = D2.addDays(per.start, off);
    mk.run(date, 'dinner');
    const sh = find.get(date, 'dinner').id;
    work.run(sh, 910, 6.25);
    sales.run(sh, 910, 41133, 0, 17777, card, cash);
    days.push({ date, sh });
  }
  w.close();
  return { per, days };
}

test('2E-2: the rows on the pay page sum exactly to the Gross pay shown', async () => {
  const { per } = seedMoneyPeriod();
  const cookie = await signIn('9101');
  const html = await (await asStaff(`/portal/earnings?p=${per.start}`, cookie)).text();

  // The headline figure, off the status card.
  const card = html.slice(html.indexOf('class="tcc tcc-'), html.indexOf('</section>', html.indexOf('class="tcc tcc-')));
  const gross = oneCents(card);
  assert.ok(gross !== null && gross > 0, `a gross figure is shown (${gross})`);

  // "On this payment" — its component rows, and its own total.
  const pay = sectionOf(html, 'On this payment');
  assert.ok(pay, 'the payment breakdown is on the page');
  const all = centsIn(pay);
  assert.ok(all.length >= 2, 'it has components and a total');
  const total = all[all.length - 1];
  const components = all.slice(0, -1);
  assert.strictEqual(total, gross, 'the breakdown total IS the headline figure');
  assert.strictEqual(components.reduce((a, b) => a + b, 0), gross,
    `components ${components.join('+')} sum to ${gross}`);
  // Integer cents throughout — never a float rendered into the page.
  assert.ok(!/\$\d+\.\d{3,}/.test(html), 'no over-precise amount anywhere');
  assert.ok(!/\d\.\d{10,}/.test(html), 'and no floating-point leakage');
});

test('2E-2: cash is shown once, separately, and never inside Gross pay', async () => {
  const { per } = seedMoneyPeriod();
  const cookie = await signIn('9101');
  const html = await (await asStaff(`/portal/earnings?p=${per.start}`, cookie)).text();

  const already = sectionOf(html, 'Already received');
  assert.ok(already, 'the separately-received section is there');
  const cash = oneCents(already);
  assert.ok(cash > 0, `cash tips are shown (${cash})`);
  assert.match(already, /paid separately and is not included/, 'and said once');
  assert.strictEqual((html.match(/paid separately and is not included/g) || []).length, 1,
    'exactly once — the old page said it three times');

  // It is not a component of the payment, and it is not a deduction.
  const pay = sectionOf(html, 'On this payment');
  assert.ok(!centsIn(pay).includes(cash), 'the cash figure is not in the payment breakdown');
  // Scoped to the section it is in: "Before tax and deductions" legitimately
  // appears on the gross-pay note, and that is a different sentence about a
  // different thing.
  assert.ok(!/deduct/i.test(already), 'cash is never described as a deduction');

  // Gross + cash is never presented as one number.
  const card = html.slice(html.indexOf('class="tcc tcc-'), html.indexOf('</section>', html.indexOf('class="tcc tcc-')));
  const gross = oneCents(card);
  assert.ok(!centsIn(html).includes(gross + cash), 'their sum appears nowhere');
});

test('2E-2: a shift reconciles by source and by delivery', async () => {
  const { days } = seedMoneyPeriod();
  const cookie = await signIn('9101');
  const html = await (await asStaff(`/portal/earnings/${days[0].sh}`, cookie)).text();
  const grab = (label) => {
    const m = html.match(new RegExp(label + '[\\s\\S]{0,160}?(−?\\$[\\d,]+\\.\\d{2})'));
    return m ? centsIn(m[1])[0] : null;
  };
  // Where the tips came from.
  const card = grab('Card tips'), cash = grab('Cash tips'), collected = grab('Total tips collected');
  assert.ok(card !== null && cash !== null && collected !== null, 'the sources are itemised');
  assert.strictEqual(card + cash, collected, 'card plus cash is what was collected');

  // How they reached her: what she walked out with, plus what payroll carries.
  const kept = grab('Tips you keep');
  const out = grab('Total tip-out');
  assert.ok(kept !== null, 'what she keeps is shown');
  if (out !== null) {
    assert.strictEqual(collected + out, kept,
      'collected less the tip-out is what she keeps (tip-out renders negative)');
  }
  // Hours pay follows the resolved rate, in whole cents.
  const wage = grab('Hours pay') ?? grab('hours pay');
  if (wage !== null) {
    assert.strictEqual(wage, Math.round(1733 * 6.25), 'rate x hours, rounded once, to the cent');
  }
});

test('2E-2: a shift that cannot be costed is kept, not dropped', async () => {
  // The contract, proved where it is decided rather than by manufacturing a
  // corruption that the schema keeps refusing to hold.
  //
  // What made rows disappear was a `continue` in the costing loop while the
  // COUNT beside it counted the same row. Two things have to be true and both
  // are checked here: the list and the count read the SAME population, and the
  // loop no longer has a path that skips a row.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function earningsFor('), src.indexOf('\n}', src.indexOf('function earningsFor(')));
  const cnt = src.slice(src.indexOf('const earningsCount'), src.indexOf('function earningsFor('));

  // Same WHERE on both, so the count can never describe a different set.
  for (const clause of ["w.employee_id = ?", "sh.status = '${SHIFT_DONE}'", 'sh.date >= ?']) {
    assert.ok(fn.includes(clause), `the row query filters on ${clause}`);
    assert.ok(cnt.includes(clause), `and so does the count`);
  }
  // The catch keeps the row.
  const cat = fn.slice(fn.indexOf('catch (e)'), fn.indexOf('const asServer'));
  assert.match(cat, /out\.push\(/, 'a costing failure still pushes a row');
  assert.match(cat, /unavailable: true/, 'flagged as unavailable');
  assert.match(cat, /kept: null/, 'with null rather than zero');
  assert.ok(!/kept: 0|wage: 0,/.test(cat), 'never a fabricated zero');
  assert.match(cat, /sh\.worked_hours/, 'and hours from the authoritative work row');
  assert.match(cat, /console\.error/, 'the failure is logged');
  // The only `continue` left is the one AFTER the row has been pushed.
  const pushAt = cat.indexOf('out.push(');
  assert.ok(pushAt > -1 && cat.indexOf('continue', pushAt) > pushAt,
    'the row is recorded before the loop moves on');

  // And the page states it in words a person can act on, with nothing internal.
  assert.match(src, /Earnings unavailable/, 'the state has a name');
  assert.match(src, /couldn.t calculate this shift.s earnings/i, 'and a plain explanation');
});

// ===========================================================================
// HOME — the pre-shift briefing.
// ===========================================================================

const noteRows = () => db.prepare('SELECT * FROM portal_notes ORDER BY id').all();
const homeOf = async (cookie) => (await asStaff('/portal', cookie)).text();
/** Home's own body — the shell's nav carries links that are not Home's. */
const briefing = (html) =>
  (html.match(/<main class="pt-body tc-body hb"[\s\S]*?(?=<nav class="pt-tabs)/) || [html])[0];

test('Home reads before-shift notes from the note table, not the news feed', async () => {
  const cookie = await signIn('1111');
  await form('/staff-portal/note', { title: 'Qn Live note', body: 'Line one.\r\n\r\nLine two.', tone: 'urgent' });
  const html = briefing(await homeOf(cookie));
  assert.match(html, /Qn Live note/, 'the note is on Home');
  assert.match(html, /Line one\./, 'with its body');
  assert.match(html, /Line two\./, 'all of it');
  // Tone in words as well as colour.
  assert.match(html, /class="hb-note hb-urgent"/, 'toned');
  assert.match(html, /Urgent/, 'and said in words, not only in red');
  // Newlines survive as newlines, and the stylesheet is what renders them.
  assert.match(html, /Line one\.\n\nLine two\./, 'paragraphs preserved');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  assert.match(css, /\.hb-note-b[^}]*white-space:\s*pre-wrap/, 'rendered as written');
  assert.match(css, /\.hb-note-b[^}]*overflow-wrap:\s*anywhere/, 'and a long word cannot push the page sideways');
});

test('a note scheduled for later appears later, and an expired one stops', async () => {
  const cookie = await signIn('1111');
  const D = require('../src/dates');
  const today = D.isoDate(D.startOfToday());
  await form('/staff-portal/note', { title: 'Qn Future note', starts_on: D.addDays(today, 3) });
  await form('/staff-portal/note', { title: 'Qn Past note',
    starts_on: D.addDays(today, -5), ends_on: D.addDays(today, -2) });
  const html = briefing(await homeOf(cookie));
  assert.ok(!/Qn Future note/.test(html), 'not yet');
  assert.ok(!/Qn Past note/.test(html), 'and not any more');
  // Both are still real rows — nothing was deleted to hide them.
  assert.ok(noteRows().some((n) => n.title === 'Qn Future note'), 'the future note is stored');
  assert.ok(noteRows().some((n) => n.title === 'Qn Past note'), 'so is the expired one');
});

test('a long note is stored whole, and an over-long one is refused outright', async () => {
  const long = 'A busy Friday. '.repeat(600);            // ~9 KB, comfortably legal
  const r = await form('/staff-portal/note', { title: 'Qn Long note', body: long });
  assert.ok(r.status < 400, 'accepted');
  const stored = noteRows().find((n) => n.title === 'Qn Long note');
  assert.strictEqual(stored.body.length, long.trim().length, 'stored whole — not sliced at 240');

  // And what the push preview carries is a separate, shorter thing.
  const ev = db.prepare("SELECT * FROM portal_events WHERE kind='note' AND title='Qn Long note'").get();
  if (ev) {
    assert.ok(ev.body.length <= 160, 'the preview is short');
    assert.ok(stored.body.length > ev.body.length, 'and the stored note is not');
  }

  const before = noteRows().length;
  const tooBig = 'x'.repeat(16385);
  const bad = await form('/staff-portal/note', { title: 'Qn Too big', body: tooBig });
  assert.strictEqual(noteRows().length, before, 'nothing was written');
  const where = decodeURIComponent(bad.headers.get('location') || '');
  assert.match(where, /16,384|limit is/, 'and the owner is told the limit');
  assert.match(where, /err=1/, 'as a refusal, not a success');
});

test('a note is escaped, not executed', async () => {
  const cookie = await signIn('1111');
  await form('/staff-portal/note', { title: 'Qn <script>alert(1)</script>', body: '<b>bold</b> & co' });
  const html = briefing(await homeOf(cookie));
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html), 'no live script');
  assert.match(html, /&lt;script&gt;/, 'shown as text');
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt; &amp; co/, 'and so is the body');
});

test('editing a note changes that note — it does not make a second one', async () => {
  const cookie = await signIn('1111');
  await form('/staff-portal/note', { title: 'Qn Edit me', body: 'First wording.' });
  const mine = noteRows().filter((n) => n.title === 'Qn Edit me');
  assert.strictEqual(mine.length, 1, 'one row to start with');
  const id = mine[0].id;

  await form(`/staff-portal/note/${id}/edit`, { title: 'Qn Edited', body: 'Second wording.', tone: 'caution' });
  const after = noteRows().filter((n) => n.id === id);
  assert.strictEqual(after.length, 1, 'still one row');
  assert.strictEqual(after[0].title, 'Qn Edited', 'with the new heading');
  assert.strictEqual(after[0].body, 'Second wording.', 'and the new body');
  assert.strictEqual(after[0].tone, 'caution', 'and the new tone');
  assert.strictEqual(noteRows().filter((n) => n.title === 'Qn Edit me').length, 0,
    'the old wording is gone, not sitting alongside it');

  const html = briefing(await homeOf(cookie));
  assert.strictEqual((html.match(/Qn Edited/g) || []).length, 1, 'and it renders once');
});

test('two separate notes may say exactly the same thing', async () => {
  const cookie = await signIn('1111');
  const same = { title: 'Qn Same words', body: 'Private event tonight.' };
  await form('/staff-portal/note', same);
  await form('/staff-portal/note', same);
  const both = noteRows().filter((n) => n.title === 'Qn Same words');
  assert.strictEqual(both.length, 2, 'two records, because they are two records');
  assert.notStrictEqual(both[0].id, both[1].id, 'with their own identities');
  const html = briefing(await homeOf(cookie));
  assert.strictEqual((html.match(/Qn Same words/g) || []).length, 2,
    'and Home shows both — matching text is not evidence of a duplicate');
});

test('one note record cannot be multiplied by the news feed', async () => {
  // The old failure mode: a note reaching Home twice, once from portal_notes
  // and once as the notification the posting raised.
  const cookie = await signIn('1111');
  await form('/staff-portal/note', { title: 'Qn Once only', body: 'Just the once.' });
  const html = briefing(await homeOf(cookie));
  assert.strictEqual((html.match(/Qn Once only/g) || []).length, 1, 'exactly one appearance');
});

test('Home shows the board and keeps the full one a tap away', async () => {
  const cookie = await signIn('1111');
  for (let i = 1; i <= 6; i += 1) {
    await form('/staff-portal/special', { name: `Qb Dish ${i}`, price: '10.00' });
  }
  const html = briefing(await homeOf(cookie));
  // Specials and 86'd are two halves of ONE service board module now, so the
  // section is the board and Specials is a labelled part inside it.
  assert.match(html, /id="hb-board-h">Service board/, 'the service board module');
  assert.match(html, /class="hb-lab">Specials/, 'with a Specials part inside it');
  // Capped, and honest about being capped. Counted by rendered rows rather
  // than by dish name: which four appear depends on the board's own order, and
  // the invariant is that Home stays short — not which dishes win.
  const total = db.prepare('SELECT COUNT(*) n FROM portal_specials WHERE eighty_sixed_at IS NULL').get().n;
  assert.ok(total > 4, `the board has more than fits (${total})`);
  const rows = (html.match(/class="hb-dish"/g) || []).length;
  assert.ok(rows > 0, 'with dishes on it');
  assert.ok(rows <= 4, `Home stays compact — rendered ${rows}`);
  assert.match(html, /more on the board/, 'and says there are more');
  assert.match(html, /href="\/portal\/specials"/, 'with the full board one tap away');
  assert.strictEqual((await asStaff('/portal/specials', cookie)).status, 200, 'which still opens');
});

test("86'd reads as 86'd without relying on the colour", async () => {
  const cookie = await signIn('1111');
  await form('/staff-portal/special', { name: 'Qb Gone dish', price: '18.00' });
  const sp = db.prepare("SELECT id FROM portal_specials WHERE name='Qb Gone dish'").get();
  await form(`/staff-portal/special/${sp.id}/86`, { note: 'last one went at 7' });
  const html = briefing(await homeOf(cookie));
  assert.match(html, /86&rsquo;d &mdash; don&rsquo;t offer/, 'its own heading');
  assert.match(html, /<s>Qb Gone dish<\/s>/, 'struck through, which survives greyscale');
  assert.match(html, /class="hb-off-k">86&rsquo;d</, 'and labelled in words');
  assert.match(html, /last one went at 7/, 'with the note the manager left');
});

test('an employee stock report stays private and never becomes an official 86', async () => {
  const mine = await signIn('1111');
  const theirs = await signIn('2222');
  const before = db.prepare('SELECT COUNT(*) n FROM portal_specials').get().n;
  const r = await fetch(BASE + '/portal/stock', {
    method: 'POST', redirect: 'manual',
    headers: { cookie: mine, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ items: JSON.stringify([{ item: 'Qs Secret shortage', status: 'out' }]) }).toString(),
  });
  assert.strictEqual(r.status, 302, 'it files');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM portal_specials').get().n, before,
    'and creates no official board row');

  const other = briefing(await homeOf(theirs));
  assert.ok(!/Qs Secret shortage/.test(other), 'another employee never sees it');
  assert.ok(!/Qs Secret shortage/.test(await (await asStaff('/portal/specials', theirs)).text()),
    'not on the board either');
});

test('a real stock report confirms once; a typed URL confirms never', async () => {
  const cookie = await signIn('1111');
  // Forged first: the parameter that used to be the whole mechanism.
  const forged = briefing(await (await asStaff('/portal?sent=3', cookie)).text());
  assert.ok(!/with your manager/.test(forged), 'a query parameter fabricates nothing');

  const r = await fetch(BASE + '/portal/stock', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ items: JSON.stringify([{ item: 'Qs Real shortage', status: 'out' }]) }).toString(),
  });
  const set = r.headers.get('set-cookie') || '';
  assert.match(set, /zwin_sent=/, 'the successful POST is what sets it');
  const sentCookie = `${cookie}; ${set.split(';')[0]}`;
  const first = briefing(await (await fetch(BASE + '/portal', { headers: { cookie: sentCookie } })).text());
  assert.match(first, /with your manager/, 'and the next page confirms it');
  // Once. A refresh without the cookie — which is what a refresh is, because
  // reading it cleared it — says nothing.
  const second = briefing(await homeOf(cookie));
  assert.ok(!/with your manager/.test(second), 'a refresh does not replay it');
});

test('Home has no clock card and no clock action', async () => {
  const cookie = await signIn('1111');
  const html = briefing(await homeOf(cookie));
  assert.ok(!/class="tcc tcc-/.test(html), 'the card is gone');
  assert.ok(!/>Clock in</.test(html), 'and so is the action');
  assert.ok(!/data-since/.test(html), 'nothing ticking');
  assert.ok(!/Clocked out/.test(html), 'and no block replaced it');
});

// ===========================================================================
// Home cannot lose its sections again.
//
// The briefing and the service board are structural: they are on the page
// whether or not their tables have rows. A section that disappears when its
// data is empty makes Home a different page every shift, and it is how a
// perfectly working Home came to look like a regression.
// ===========================================================================

test('Home keeps every section, in order, whatever the data says', async () => {
  const cookie = await signIn('1111');
  const html = briefing(await homeOf(cookie));
  const order = ['hb-mod-brief', 'hb-board-h', 'hb-at-h', 'hb-up-h', 'hb-do-h']
    .map((id) => ({ id, at: html.indexOf(id) })).filter((x) => x.at > -1);
  // Whichever of the optional ones are present, they are in the approved order.
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i].at > order[i - 1].at,
      `${order[i].id} comes after ${order[i - 1].id}`);
  }
  // These two are never optional.
  assert.match(html, /hb-mod-brief/, 'the briefing is structural');
  assert.match(html, /id="hb-board-h"/, 'and so is the service board');
  assert.match(html, /View all specials/, 'with its link');
});

test('an empty board still shows both halves and both quiet lines', async () => {
  // A fresh database has no notes and no dishes. That is exactly the state
  // this regression test exists for.
  const w = new Database(DB);
  w.prepare('DELETE FROM portal_specials').run();
  w.prepare('DELETE FROM portal_notes').run();
  w.close();
  const cookie = await signIn('1111');
  const html = briefing(await homeOf(cookie));
  assert.match(html, /hb-mod-brief/, 'briefing surface present');
  assert.match(html, /No new briefing notes\./, 'with a quiet line');
  assert.match(html, /Specials/, 'the Specials half is labelled');
  assert.match(html, /No current specials\./, 'and says it is empty');
  assert.match(html, /86&rsquo;d &mdash; don&rsquo;t offer/, "the 86'd half is labelled");
  assert.match(html, /Nothing is 86&rsquo;d right now\./, 'and says it is empty');
  // Restrained: a quiet line, not a giant empty card.
  assert.ok(!/tc-empty/.test(html), 'no oversized empty block');
});

test('a populated Home carries the briefing, both board halves and the rest', async () => {
  const cookie = await signIn('1111');
  await form('/staff-portal/note', { title: 'Qz Note one', body: 'First message.', tone: 'caution' });
  await form('/staff-portal/note', { title: 'Qz Note two', body: 'Second message.', tone: 'fyi' });
  await form('/staff-portal/special', { name: 'Qz Running dish', price: '21.00' });
  await form('/staff-portal/special', { name: 'Qz Gone dish', price: '19.00' });
  const gone = db.prepare("SELECT id FROM portal_specials WHERE name='Qz Gone dish'").get();
  await form(`/staff-portal/special/${gone.id}/86`, { note: 'walked at six' });

  const html = briefing(await homeOf(cookie));
  // Both notes, inside ONE briefing surface.
  assert.strictEqual((html.match(/hb-mod-brief/g) || []).length, 1, 'one briefing surface');
  assert.match(html, /Qz Note one/); assert.match(html, /First message\./);
  assert.match(html, /Qz Note two/); assert.match(html, /Second message\./);
  assert.ok(!/hb-none/.test(html.split('id="hb-board-h"')[0]), 'and no quiet line while notes exist');
  // The board, with both states in one module.
  assert.match(html, /Qz Running dish/, 'the special is on the board');
  assert.match(html, /<s>Qz Gone dish<\/s>/, "and the 86'd one is struck through");
  assert.match(html, /86&rsquo;d</, 'and labelled in words');
  assert.match(html, /walked at six/, 'with the sold-out note');
  // The note must not also appear in Updates.
  const upd = (html.split('id="hb-up-h"')[1] || '').split('</section>')[0];
  assert.ok(!/Qz Note one/.test(upd), 'the note is not duplicated into Updates');
  // Secondary actions survive.
  assert.match(html, /Report out of stock/, 'the secondary actions are there');
});

test('an employee stock report never reaches the Home board', async () => {
  const mine = await signIn('1111');
  const theirs = await signIn('2222');
  await fetch(BASE + '/portal/stock', {
    method: 'POST', redirect: 'manual',
    headers: { cookie: mine, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ items: JSON.stringify([{ item: 'Qz Private shortage', status: 'out' }]) }).toString(),
  });
  const board = briefing(await homeOf(theirs));
  assert.ok(!/Qz Private shortage/.test(board), 'not on another employee\'s Home');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM portal_specials WHERE name='Qz Private shortage'").get().n,
    0, 'and it created no official 86');
});

// ===========================================================================
// A SHIFT IS NOT 45 MINUTES LONG
// ===========================================================================
//
// The reported bug, and it produced the worst possible symptom: staff insisting
// they had clocked out, and the record showing them still on.
//
// Somebody clocks in at 4pm. The portal session is 45 minutes — right for the
// tips form on a shared phone, wrong for a shift. The phone goes in an apron.
// At 11pm they wake it on the still-rendered clock screen and tap Confirm. The
// POST arrives with a dead cookie, requirePortal bounces it to the PIN screen,
// and the body is gone — no punch, no error they would recognise as failure.
// The message even said "Nothing you sent was lost", which is true of a GET and
// a lie about a POST. They entered their PIN, landed on the portal home, and
// walked out still on the clock believing they had finished.

const crypto = require('node:crypto');

/** A validly signed portal cookie with an expiry in the past. */
const agedCookie = (empId, ageMs) => {
  const exp = Date.now() - ageMs;
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'insecure-dev-secret')
    .update(`tips:${empId}:${exp}`).digest('hex').slice(0, 32);
  return `zwin_portal=${empId}.${exp}.${sig}`;
};

test('a clock-out still lands when the session died mid-shift', async () => {
  const w = new Database(DB);
  const id = w.prepare(`INSERT INTO employees (name, role, pin, hourly_rate_cents, active)
    VALUES ('Long Shift', 'server', '7401', 1500, 1)`).run().lastInsertRowid;
  const cookie = await signIn('7401');
  await form('/portal/clock/in', { position: 'server', daypart: 'dinner' }, { cookie });
  const entry = () => w.prepare('SELECT status, clock_out_at FROM time_entries WHERE employee_id = ?').get(id);
  assert.strictEqual(entry().status, 'active', 'on the clock');

  // Seven hours later, on a session that expired six hours ago.
  const res = await form('/portal/clock/out', {}, { cookie: agedCookie(id, 7 * 3600e3) });
  assert.strictEqual(res.status, 302);
  assert.ok(!/\/tips/.test(res.headers.get('location') || ''),
    'not bounced to the PIN screen');
  assert.strictEqual(entry().status, 'complete', 'the punch closed');
  assert.ok(entry().clock_out_at, 'and it has a clock-out time');
  w.close();
});

test('the grace is only for somebody on the clock, and only for one shift', async () => {
  const w = new Database(DB);
  const on = w.prepare(`INSERT INTO employees (name, role, pin, hourly_rate_cents, active)
    VALUES ('Still On', 'server', '7402', 1500, 1)`).run().lastInsertRowid;
  const off = w.prepare(`INSERT INTO employees (name, role, pin, hourly_rate_cents, active)
    VALUES ('Gone Home', 'server', '7403', 1500, 1)`).run().lastInsertRowid;
  const cookie = await signIn('7402');
  await form('/portal/clock/in', { position: 'server', daypart: 'dinner' }, { cookie });

  const reaches = async (c) => (await fetch(BASE + '/portal/clock',
    { redirect: 'manual', headers: { cookie: c } })).status === 200;

  assert.ok(await reaches(agedCookie(on, 7 * 3600e3)),
    'on the clock, hours past expiry — let through, or the shift cannot be ended');
  assert.ok(!(await reaches(agedCookie(on, 20 * 3600e3))),
    'but not a day later: the window is one long shift, not a permanent session');
  assert.ok(!(await reaches(agedCookie(off, 2 * 3600e3))),
    'and never for somebody who is not on the clock — the 45 minutes still stands');

  // The signature is still the whole basis of the thing.
  const forged = agedCookie(on, 7 * 3600e3).replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  assert.ok(!(await reaches(forged)), 'a tampered token is refused however recent');
  w.close();
});

test('an expired POST is never described as saved', async () => {
  const w = new Database(DB);
  const id = w.prepare(`INSERT INTO employees (name, role, pin, hourly_rate_cents, active)
    VALUES ('Bounced', 'server', '7404', 1500, 1)`).run().lastInsertRowid;
  // Not on the clock, so no grace: this POST genuinely is discarded.
  const res = await form('/portal/clock/out', {}, { cookie: agedCookie(id, 2 * 3600e3) });
  const msg = decodeURIComponent((res.headers.get('location') || '').split('msg=')[1] || '');
  assert.match(msg, /did NOT go through/,
    'a dropped POST says so — "nothing was lost" was the sentence that made staff think it worked');
  assert.doesNotMatch(msg, /Nothing you sent was lost/);
  w.close();
});

test('signing back in mid-shift returns to the clock, not the home', async () => {
  const w = new Database(DB);
  w.prepare(`INSERT INTO employees (name, role, pin, hourly_rate_cents, active)
    VALUES ('Back Again', 'server', '7405', 1500, 1)`).run();
  const cookie = await signIn('7405');
  await form('/portal/clock/in', { position: 'server', daypart: 'dinner' }, { cookie });
  const res = await form('/tips/start', { pin: '7405' });
  const loc = res.headers.get('location') || '';
  assert.match(loc, /^\/portal\/clock/, 'straight back to the clock');
  assert.match(decodeURIComponent(loc), /still on the clock/i,
    'and told plainly that they have not finished');
  w.close();
});

test('the notifications panel explains itself on a phone that cannot subscribe', async () => {
  // iPhone gives web push ONLY to a Home Screen app. In an ordinary Safari tab
  // PushManager is absent, and the panel used to return on that check — so the
  // owner saw no button and no reason, just nothing, and concluded
  // notifications were broken. The page must say the one thing that fixes it.
  const html = await (await fetch(BASE + '/notifications')).text();
  const i = html.indexOf("getElementById('anpush')");
  assert.ok(i > -1, 'the panel is on the page');
  const script = html.slice(i, html.indexOf('</script>', i));

  assert.match(script, /Add ZWIN to your Home Screen first/,
    'it names the actual fix rather than failing silently');
  assert.match(script, /iPad\|iPhone\|iPod/, 'and works out that it is on an iPhone');
  assert.match(script, /display-mode: standalone/,
    'only saying it when NOT already installed, or it would nag the app it is running in');
  assert.match(script, /box\.hidden=false/,
    'the panel is revealed to carry the message — the old code left it hidden');

  // The two states that already worked must not have regressed.
  assert.match(script, /not set up on the server yet/, 'no keys on the server still says so');
  assert.match(script, /Blocked in your settings/, 'a denied permission still says so');
});
