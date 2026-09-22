'use strict';

// Evening shifts filed under Day.
//
// Found on the live site on Sep 21: five evening shifts sitting on Day
// Service, every one moved there by the staff member's own "fix my shift"
// request, approved by the owner. The restaurant's evening service is one it
// ADDED — keyed evening-service — and the original "dinner" is archived under
// the same name. The phone's edit sheet built its service list from a
// hard-coded pair, cafe and dinner, so an evening punch matched no option, the
// browser showed the first one, and every clock-out fix went in as "move this
// shift to Day Service". The approve button checked services against the same
// pair, so the one move it could never make was back to Evening.
//
// The owner's words: "their clock in and out will go to day service even
// though it's supposed to be evening — when they submit it goes to the right
// place but when they clock out it goes to the wrong one."
//
// This file sets the restaurant up exactly that way and walks it through the
// real routes, reading each form the way a browser would submit it.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4015;                     // unique across the suite
const BASE = `http://127.0.0.1:${PORT}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-eve-'));
const DB = path.join(dir, 'eve.db');
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
let child, db, SVC, TC;

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
const json = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const page = async (p, cookie) => (await fetch(BASE + p, { headers: cookie ? { cookie } : {} })).text();
const msgOf = (res) => decodeURIComponent((String(res.headers.get('location') || '').split('msg=')[1] || '')
  .split('#')[0].split('&')[0]).replace(/\+/g, ' ');

/** What a browser submits for a <select>: the selected option, else the first. */
function submitted(selectHtml) {
  const opts = [...selectHtml.matchAll(/<option\b([^>]*)>/g)].map((m) => ({
    value: (m[1].match(/value="([^"]*)"/) || [])[1],
    selected: /\bselected\b/.test(m[1]),
  }));
  const pick = opts.find((o) => o.selected) || opts[0];
  return { value: pick ? pick.value : undefined, values: opts.map((o) => o.value) };
}

const EMP = { eve: 501, adder: 502, empty: 503, sheet: 504, moved: 505 };
// People for the time clock tests further down.
const HELP = { typed: 511, wrong: 512, fresh: 513 };
const PIN = (id) => String(6000 + id - 500);

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
  SVC = require('../src/services');
  TC = require('../src/timeclock');

  // The live restaurant, as found: Day is the original café under a new name,
  // the original dinner is archived under the name "Evening Service", and the
  // evening service people actually clock into is one that was added later.
  SVC.rename('cafe', 'Day Service');
  SVC.rename('dinner', 'Evening Service');
  SVC.create({ slug: 'evening-service', name: 'Evening Service' });
  SVC.archive('dinner');

  const ins = db.prepare(
    "INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?, ?, 'server', ?, 1500, 1)");
  for (const [k, id] of Object.entries(EMP)) {
    ins.run(id, `Eve ${k}`, PIN(id));
    SVC.setForEmployee(id, ['cafe', 'evening-service']);
  }
  for (const [k, id] of Object.entries(HELP)) {
    ins.run(id, `Help ${k}`, String(7000 + id));
    SVC.setForEmployee(id, ['cafe', 'evening-service']);
  }
});

test.after(() => {
  if (child) child.kill();
  try { db.close(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A finished evening punch, the way the portal clock leaves one. */
function eveningPunch(empId, date, fromLocal, toLocal) {
  const utc = (local) => TC.localInputToUtc(`${date}T${local}`);
  db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?, 'evening-service', 'open')").run(date);
  const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'evening-service'").get(date).id;
  db.prepare("INSERT OR IGNORE INTO work (shift_id, employee_id, role, hours) VALUES (?, ?, 'server', 0)").run(sh, empId);
  const id = Number(db.prepare(`INSERT INTO time_entries
      (employee_id, shift_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, created_by)
      VALUES (?, ?, ?, 'evening-service', 'server', ?, ?, 'complete', 'portal', 'test')`)
    .run(empId, sh, date, utc(fromLocal), utc(toLocal)).lastInsertRowid);
  TC.recompute(TC.q.byId.get(id));
  return TC.q.byId.get(id);
}

async function signIn(empId) {
  const res = await post('/tips/start', { pin: PIN(empId) });
  assert.strictEqual(res.status, 302, 'the PIN is accepted');
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

/** The service select inside one punch's edit sheet on the phone. */
function sheetService(html, entryId) {
  const at = html.indexOf(`data-pes="${entryId}"`);
  assert.ok(at >= 0, 'the edit sheet for that shift is on the page');
  const form = html.slice(at, html.indexOf('</form>', at));
  const sel = form.match(/<select name="daypart"[\s\S]*?<\/select>/);
  assert.ok(sel, 'the sheet offers the service');
  return submitted(sel[0]);
}

// ===========================================================================
// The staff edit sheet
// ===========================================================================

test('the phone’s edit sheet starts on the shift’s own service, even one the restaurant added', async () => {
  const e = eveningPunch(EMP.eve, '2026-09-10', '16:30', '16:31');
  const cookie = await signIn(EMP.eve);
  const html = await page('/portal/timesheet/day/2026-09-10', cookie);
  const svc = sheetService(html, e.id);
  assert.strictEqual(svc.value, 'evening-service',
    'left alone, the sheet sends Evening Service back — not Day, which is what went wrong on the live site');
  assert.ok(!svc.values.includes('dinner'), 'and the archived evening is not offered as a second "Evening Service"');
});

test('fixing a forgotten clock-out does not move the shift to Day, and approving it keeps it on Evening', async () => {
  const e = eveningPunch(EMP.moved, '2026-09-11', '16:30', '16:31');
  const cookie = await signIn(EMP.moved);
  const html = await page('/portal/timesheet/day/2026-09-11', cookie);
  const svc = sheetService(html, e.id);

  // Exactly what the phone posts when somebody only changes the end time.
  const res = await post('/portal/clock/fix', {
    entry_id: String(e.id), pin: PIN(EMP.moved), kind: 'shift_times',
    at_in: '', at_out: '2026-09-11T19:51', daypart: svc.value, reason: '',
  }, cookie);
  assert.strictEqual(res.status, 302);
  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(e.id);
  assert.ok(c, 'the request was filed');
  assert.doesNotMatch(String(c.proposed_value), /service/i,
    `the request only asks for the new end (it said: "${c.proposed_value}")`);

  const ok = await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  assert.strictEqual(ok.status, 302);
  const after = TC.q.byId.get(e.id);
  assert.strictEqual(after.daypart, 'evening-service', 'approved, and still on Evening Service');
  assert.strictEqual(TC.utcToLocalInput(after.clock_out_at), '2026-09-11T19:51', 'with the end they asked for');
});

test('a request to move a shift to the restaurant’s Evening Service can be approved', async () => {
  // The reverse of the bug, and the reason it could not be fixed from the phone:
  // approval checked against the hard-coded pair and refused this as "not a
  // service that exists".
  const e = eveningPunch(EMP.sheet, '2026-09-12', '16:15', '21:48');
  db.prepare("UPDATE time_entries SET daypart = 'cafe' WHERE id = ?").run(e.id);
  const cookie = await signIn(EMP.sheet);
  await post('/portal/clock/fix', {
    entry_id: String(e.id), pin: PIN(EMP.sheet), kind: 'shift_times',
    at_in: '', at_out: '', daypart: 'evening-service', reason: 'I worked the evening',
  }, cookie);
  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(e.id);
  assert.match(String(c.proposed_value), /service Evening Service/);
  const res = await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  assert.doesNotMatch(msgOf(res), /Not applied/, `approval went through (${msgOf(res)})`);
  assert.strictEqual(TC.q.byId.get(e.id).daypart, 'evening-service', 'and the shift is on Evening Service');
});

test('a request can never move a shift onto an archived service', async () => {
  const e = eveningPunch(EMP.sheet, '2026-09-13', '16:15', '21:48');
  const cookie = await signIn(EMP.sheet);
  await post('/portal/clock/fix', {
    entry_id: String(e.id), pin: PIN(EMP.sheet), kind: 'shift_times',
    at_in: '', at_out: '2026-09-13T22:00', daypart: 'dinner', reason: '',
  }, cookie);
  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(e.id);
  assert.ok(!c || !/service/i.test(String(c.proposed_value)),
    'a hand-made post naming the archived evening is not filed as a service change');
  assert.strictEqual(TC.q.byId.get(e.id).daypart, 'evening-service');
});

test('the add-a-shift sheet offers the real services and makes them choose', async () => {
  const cookie = await signIn(EMP.adder);
  const html = await page('/portal/timesheet/day/2026-09-14', cookie);
  const at = html.indexOf('action="/portal/clock/add"');
  assert.ok(at >= 0, 'the add-a-shift sheet is on the page');
  const form = html.slice(at, html.indexOf('</form>', at));
  const sel = form.match(/<select name="daypart"[\s\S]*?<\/select>/);
  assert.ok(sel, 'it asks for the service');
  const svc = submitted(sel[0]);
  assert.ok(svc.values.includes('evening-service'), 'Evening Service — the real one — is a choice');
  assert.ok(!svc.values.includes('dinner'), 'the archived one is not');
  assert.strictEqual(svc.value, '', 'and nothing is chosen for them: an untouched box cannot quietly mean Day');
});

// ===========================================================================
// Hours typed onto an empty day, on the manager's grid
// ===========================================================================

test('an evening start typed on an empty day lands on the restaurant’s Evening Service', async () => {
  const res = await json('/timeclock/day-cell', { employee_id: EMP.empty, date: '2026-09-15', field: 'in', value: '18:00' });
  assert.strictEqual(res.status, 200);
  const e = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? ORDER BY id DESC').get(EMP.empty);
  assert.strictEqual(e.daypart, 'evening-service', 'not the archived dinner, which nobody can see on the time clock');
});

// ===========================================================================
// The time clock shows everybody on the service, and puts each one right
//
// "I need a way to edit any shift on the time clock and add any shift, evening
// or day — right now people's shifts aren't popping up with every shift on the
// time clock and Services." Eunji, on the live site: on the Evening sheet with
// her sales, tips and hours, and nowhere on the Evening clock, because she had
// no punch. Joseph: on the Evening sheet with no hours, his evening punch on Day.
// ===========================================================================

/** The "no punch here" panel on a clock page, and one person's line in it. */
const gapPanel = (html) => (html.match(/<section class="bs-panel tcm-gaps">[\s\S]*?<\/section>/) || [''])[0];
const gapLine = (html, name) => gapPanel(html).split('<div class="tcm-gap">').find((x) => x.includes(name)) || '';

/** Put somebody on a service's sheet the way the Services page does. */
function onSheet(empId, date, svc, { hours = 0, source = null, role = 'server', food = 0 } = {}) {
  db.prepare("INSERT OR IGNORE INTO shifts (date, daypart, status) VALUES (?, ?, 'open')").run(date, svc);
  const sh = db.prepare('SELECT id FROM shifts WHERE date = ? AND daypart = ?').get(date, svc).id;
  db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hours_source) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shift_id, employee_id) DO UPDATE SET hours = excluded.hours, hours_source = excluded.hours_source`)
    .run(sh, empId, role, hours, source);
  if (food) {
    db.prepare(`INSERT OR REPLACE INTO server_sales (shift_id, employee_id, food_cents, card_tips_cents)
      VALUES (?, ?, ?, 0)`).run(sh, empId, food);
  }
  return sh;
}


test('somebody on the Evening sheet with no punch is on the Evening clock, with a way to add their times', async () => {
  const day = '2026-09-16';
  onSheet(HELP.typed, day, 'evening-service', { hours: 6.62, source: 'manager', food: 13100 });
  const html = await page(`/timeclock/evening-service/today?from=${day}&to=${day}`);
  assert.match(gapPanel(html), /On Evening Service with no punch here/, 'the clock has a place for them');
  const line = gapLine(html, 'Help typed');
  assert.ok(line, 'and they are in it');
  assert.match(line, /typed on the service/, 'saying their hours were typed, not clocked');
  const add = line.match(/href="(\/timeclock\/new\?[^"]+)"/);
  assert.ok(add, 'with an Add their times link');
  const u = new URL(add[1].replace(/&amp;/g, '&'), BASE);
  assert.strictEqual(u.searchParams.get('emp'), String(HELP.typed));
  assert.strictEqual(u.searchParams.get('svc'), 'evening-service', 'for Evening, the service they are on');
  assert.strictEqual(u.searchParams.get('date'), day);
});

test('adding their times from there lands on Evening, and the punch replaces the hours typed by hand', async () => {
  const day = '2026-09-16';
  const form = await page(`/timeclock/new?emp=${HELP.typed}&svc=evening-service&date=${day}&pos=server`);
  const sel = form.match(/<select name="daypart"[\s\S]*?<\/select>/)[0];
  assert.strictEqual(submitted(sel).value, 'evening-service', 'the form opens on Evening Service');
  assert.match(form, /This punch replaces that number/, 'and says the punch will replace the typed hours');
  assert.match(form, /6\.62|6:37|6h 37/, 'naming the figure it replaces');

  const res = await post('/timeclock/new', { employee_id: String(HELP.typed), daypart: 'evening-service',
    position: 'server', date: day, in_time: '16:30', out_time: '23:07', reason: 'forgot to clock in' });
  assert.strictEqual(res.status, 302);
  const e = db.prepare('SELECT * FROM time_entries WHERE employee_id = ?').get(HELP.typed);
  assert.ok(e, 'the punch was made');
  assert.strictEqual(e.daypart, 'evening-service');
  assert.strictEqual(e.payable_minutes, 397, '4:30pm to 11:07pm');
  const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'evening-service'").get(day).id;
  const w = db.prepare('SELECT hours, hours_source FROM work WHERE shift_id = ? AND employee_id = ?').get(sh, HELP.typed);
  assert.strictEqual(w.hours_source, 'clock', 'the punch is the hours now');
  assert.strictEqual(Number(w.hours), Math.round((397 / 60) * 1000) / 1000);
  const again = await page(`/timeclock/evening-service/today?from=${day}&to=${day}`);
  assert.strictEqual(gapLine(again, 'Help typed'), '', 'and they are no longer listed as missing a punch');
  assert.match(again, /Help typed/, 'because they are on the clock itself now');
});

test('a punch that went to Day is shown on the Evening clock and moved there in one click', async () => {
  const day = '2026-09-17';
  // Clocked into Evening, then a phone fix filed it under Day — the live shape.
  onSheet(HELP.wrong, day, 'evening-service', { role: 'server', food: 9900 });
  const e = eveningPunch(HELP.wrong, day, '16:30', '22:30');
  const daySh = onSheet(HELP.wrong, day, 'cafe', {});
  db.prepare("UPDATE time_entries SET daypart = 'cafe', shift_id = ? WHERE id = ?").run(daySh, e.id);
  db.prepare("UPDATE work SET hours = 6, hours_source = 'clock' WHERE shift_id = ? AND employee_id = ?").run(daySh, HELP.wrong);

  const html = await page(`/timeclock/evening-service/today?from=${day}&to=${day}`);
  const chunk = gapLine(html, 'Help wrong');
  assert.ok(chunk, 'they are on the Evening clock after all');
  assert.match(chunk, /Punched into <b>Day Service<\/b>/, 'showing where the punch actually is');
  assert.match(chunk, new RegExp(`action="/timeclock/${e.id}/service"`), 'with a button to move it');

  const res = await post(`/timeclock/${e.id}/service`, { daypart: 'evening-service',
    back: `/timeclock/evening-service/today?from=${day}&to=${day}` });
  assert.strictEqual(res.status, 302);
  assert.match(String(res.headers.get('location')), /^\/timeclock\/evening-service\/today/, 'back where they were');
  assert.match(msgOf(res), /to Evening Service/);
  const after = TC.q.byId.get(e.id);
  assert.strictEqual(after.daypart, 'evening-service', 'the punch is on Evening');
  assert.strictEqual(after.clock_in_at, e.clock_in_at, 'its times untouched, to the second');
  const eveSh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'evening-service'").get(day).id;
  assert.strictEqual(after.shift_id, eveSh);
  assert.strictEqual(Number(db.prepare('SELECT hours FROM work WHERE shift_id = ? AND employee_id = ?').get(eveSh, HELP.wrong).hours), 6,
    'the six hours are on Evening now');
  assert.ok(!db.prepare('SELECT 1 FROM work WHERE shift_id = ? AND employee_id = ?').get(daySh, HELP.wrong),
    'and they are off Day, not left on it at 0h');
});

test('the add form never quietly means Day: bare, it asks; from a clock, it is that clock', async () => {
  const bare = await page('/timeclock/new');
  const s1 = submitted(bare.match(/<select name="daypart"[\s\S]*?<\/select>/)[0]);
  assert.strictEqual(s1.value, '', 'opened with nothing, the service is a question');
  assert.ok(s1.values.includes('evening-service') && !s1.values.includes('dinner'),
    'and the choices are the services that run');
  const eve = await page('/timeclock/new?svc=evening-service');
  assert.strictEqual(submitted(eve.match(/<select name="daypart"[\s\S]*?<\/select>/)[0]).value, 'evening-service',
    'opened from the Evening clock, it is Evening');
});

test('a day and two times, where an end before the start is after midnight', async () => {
  const res = await post('/timeclock/new', { employee_id: String(HELP.fresh), daypart: 'evening-service',
    position: 'server', date: '2026-09-18', in_time: '18:00', out_time: '01:30', reason: 'bar close' });
  assert.strictEqual(res.status, 302);
  const e = db.prepare('SELECT * FROM time_entries WHERE employee_id = ?').get(HELP.fresh);
  assert.strictEqual(e.business_date, '2026-09-18', 'on the night it started');
  assert.strictEqual(e.payable_minutes, 450, 'seven and a half hours, into the next morning');
  assert.match(msgOf(res), /Help fresh, Evening Service/, 'and the message says who and where');
});
