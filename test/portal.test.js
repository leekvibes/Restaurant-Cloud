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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-portal-'));
const DB = path.join(dir, 'portal.db');
let child;
let Database;
let db;

const { isoDate, startOfToday } = require('../src/dates');
const today = () => isoDate(startOfToday());

const form = (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
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
  const env = { ...process.env, DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: '', ZWIN_SKIP_BACKFILL: '1' };
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
  const sh = w.prepare("INSERT INTO shifts (date, daypart, status, created_at) VALUES ('2026-07-22','cafe','sent',datetime('now'))").run().lastInsertRowid;
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

/**
 * The sections a home is built from, named, in the order they appear.
 *
 * By their headings rather than their class, because a section's kicker is
 * part of the section — counting bare classes cannot tell which heading
 * belongs to the block that was left out.
 */
const shapeOf = (html) => [...html.matchAll(/class="pt-kick"><span>([^<]+)</g)].map((m) => m[1].trim());

test('every role gets the same home, minus what does not apply', async () => {
  // One layout, not three. A cook should recognise the screen a server
  // describes to them — same sections, same order — with the submission simply
  // absent rather than replaced by something else in its place.
  const cook = await (await asStaff('/portal', await signIn('2222'))).text();
  const server = await (await asStaff('/portal', await signIn('1111'))).text();

  assert.ok(!/Submit sales or tips/.test(cook), 'a cook is not asked to hand anything in');
  assert.ok(!/pt-task/.test(cook), 'and gets no task block at all — not a different one');
  assert.match(server, /pt-task/, 'while a server does');

  // Everything else is the same furniture in the same order.
  const serverSections = shapeOf(server);
  const cookSections = shapeOf(cook);
  assert.ok(serverSections.includes('End of your shift'), 'the server has the submission section');
  assert.deepStrictEqual(cookSections, serverSections.filter((x) => x !== 'End of your shift'),
    `a cook's home is the server's home minus the submission: [${cookSections.join(' | ')}] vs [${serverSections.join(' | ')}]`);

  // And every other door is open to them.
  const cookie = await signIn('2222');
  for (const [href, what] of [['/portal/earnings', 'their own hours and pay'],
    ['/portal/specials', 'the board'], ['/portal/stock', 'reporting stock']]) {
    assert.ok(cook.includes(href), `a cook still gets ${what}`);
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
  const kept = grab('You kept');
  const collected = grab('Tips collected');
  const tippedOut = grab('Tipped out to support') || 0;
  const cash = grab('Cash in hand');
  const cheque = grab('To your paycheck');

  assert.ok(kept && collected && cash !== null && cheque !== null,
    `all five figures render: ${JSON.stringify({ kept, collected, tippedOut, cash, cheque })}`);
  assert.ok(tippedOut > 0, 'she tipped out — otherwise this proves less than it looks');
  assert.strictEqual(collected - tippedOut, kept, 'what she collected, less the tip-out, is what she kept');
  assert.strictEqual(cash + cheque, kept, 'and it arrives as cash plus paycheck, nothing lost between');
});

test('a cook is shown what they received, without a tip-out they never paid', async () => {
  // Kitchen does not hand tips in, but it does receive a share of the pot —
  // so the honest screen for a cook is what came to them, not a blank. What it
  // must not show is "tipped out to support", which is money leaving, and a
  // cook is the support it leaves towards.
  const html = await (await asStaff('/portal/earnings', await signIn('2222'))).text();
  assert.match(html, /You kept|You worked|Nothing recorded/, 'it says what they got');
  assert.ok(!/Nothing to submit/.test(html), 'without repeating what they are not asked for');
  assert.ok(!/Tipped out to support/.test(html),
    'and never bills them for a tip-out they are on the receiving end of');
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
  assert.ok(!/All time/.test(html), 'and no all-time panel of three zeros');

  // The rule is "nothing arrived", not "this position does not hand tips in".
  // A busser hands nothing in and still gets a share every service, so keying
  // it on that setting would hide real money from the person who earned it.
  const cook = await (await asStaff('/portal/earnings', await signIn('2222'))).text();
  assert.match(cook, /You kept/, 'a cook who receives a share still sees it');
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
  assert.match(before, /Running today/, 'and running');

  await form(`/staff-portal/special/${dish.id}/86`, { note: '' });
  const after = await (await asStaff('/portal/specials', cookie)).text();
  assert.match(after, /86'd — don't offer/, 'the 86 section appears');
  // The time is the point — it tells a server whether it went before or after
  // they last looked.
  const row = db.prepare('SELECT * FROM portal_specials WHERE id = ?').get(dish.id);
  assert.ok(row.eighty_sixed_at, 'stamped when');
  assert.match(row.sold_out_note, /86'D \d+(AM|PM)/, `and says so: ${row.sold_out_note}`);
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

test('a report from the floor arrives on the manager page, linked to the product', async () => {
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
  assert.ok(oat.product_id, 'a name we already buy links to the product, so the vendor is one join away');
  assert.strictEqual(other.product_id, null, 'and one we do not buy is kept as words rather than guessed at');
  assert.strictEqual(oat.reported_by, 'Bella Reyes', 'with who said so');
  assert.strictEqual(oat.batch, other.batch, 'and both in one batch — she pressed send once');

  const admin = await (await fetch(`${BASE}/staff-portal`)).text();
  assert.match(admin, /Oat milk/, 'the manager sees it');
  assert.match(admin, /in Products/i, 'and that it is something already bought');
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
