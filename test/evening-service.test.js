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
const HOOK = 'eve-pos-secret';         // the POS webhook's shared secret, for this server only

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
// And for the Sep 22 pass over the places that still knew only the original pair.
const MORE = { prune: 521, plan: 522, report: 523, clock: 524, pos: 525, avail: 526 };
const PIN = (id) => String(6000 + id - 500);

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '', WEBHOOK_SECRET: HOOK },
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
  for (const [k, id] of Object.entries(MORE)) {
    ins.run(id, `More ${k}`, PIN(id));
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

// ===========================================================================
// Sep 22 — the rest of the places that still knew only the original pair
//
// Each one checked on the same live shape: Day renamed, 'dinner' archived as
// "Evening Service", evening-service added. Where a place misfiled work, the
// test fails against the code before the fix; where it was already right, the
// test says so and pins it.
// ===========================================================================

// --- approving a request that moves a shift to another service --------------

test('approving a move to Evening takes the person off the Day sheet, instead of leaving them there at 0h', async () => {
  // The drawer, the grid's Service cell and the clock's Move button all take
  // somebody off the service their punch left. Approving the same move asked
  // for from the phone re-synced the hours to zero and stopped there: they
  // stayed on the Day sheet asking for hours that never existed, and the Day
  // clock then listed them under "no punch here" — with a button to move the
  // punch straight back to Day.
  const day = '2026-09-19';
  const id = MORE.prune;
  const daySh = onSheet(id, day, 'cafe', {});
  const utc = (local) => TC.localInputToUtc(`${day}T${local}`);
  const eid = Number(db.prepare(`INSERT INTO time_entries
      (employee_id, shift_id, business_date, daypart, position, clock_in_at, clock_out_at, status, source, created_by)
      VALUES (?, ?, ?, 'cafe', 'server', ?, ?, 'complete', 'portal', 'test')`)
    .run(id, daySh, day, utc('16:30'), utc('22:30')).lastInsertRowid);
  TC.recompute(TC.q.byId.get(eid));
  TC.syncShiftHours(daySh, id, 'test');
  const hoursOn = (sh) => (db.prepare('SELECT hours FROM work WHERE shift_id = ? AND employee_id = ?').get(sh, id) || {}).hours;
  assert.strictEqual(Number(hoursOn(daySh)), 6, 'set up: the clock put six hours on Day');

  const cookie = await signIn(id);
  await post('/portal/clock/fix', { entry_id: String(eid), pin: PIN(id), kind: 'shift_times',
    at_in: '', at_out: '', daypart: 'evening-service', reason: 'I worked the evening' }, cookie);
  const c = db.prepare('SELECT * FROM time_corrections WHERE time_entry_id = ? ORDER BY id DESC').get(eid);
  assert.ok(c, 'the request was filed');
  const res = await post(`/timeclock/correction/${c.id}`, { decision: 'approved' });
  assert.doesNotMatch(msgOf(res), /Not applied/, `approved (${msgOf(res)})`);

  const eveSh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'evening-service'").get(day).id;
  assert.strictEqual(TC.q.byId.get(eid).shift_id, eveSh, 'the punch is on Evening');
  assert.strictEqual(Number(hoursOn(eveSh)), 6, 'with its six hours');
  assert.strictEqual(hoursOn(daySh), undefined, 'and they are off the Day sheet, not left on it at 0h');
  const dayClock = await page(`/timeclock/cafe/today?from=${day}&to=${day}`);
  assert.strictEqual(gapLine(dayClock, 'More prune'), '',
    'so the Day clock does not offer to move the punch straight back');
});

// --- the schedule -------------------------------------------------------------

/** Planned shifts for one person on one day, cancelled ones aside. */
const plansOn = (empId, date) => db.prepare(`SELECT * FROM scheduled_shifts
  WHERE employee_id = ? AND business_date = ? AND status <> 'cancelled' ORDER BY id`).all(empId, date);

test('a template saved on the old Evening board, applied on Evening, lands on the Evening Service people work', async () => {
  // Saved before the restaurant replaced its evening service, a template row
  // carries 'dinner'. The scheduler counted the built-in pair as running
  // whatever its state, so applying it made drafts on the archived evening,
  // and told the manager on the Evening board that they were "on Evening
  // Service — not this board".
  const t = Number(db.prepare("INSERT INTO schedule_templates (name, kind) VALUES ('Eve old Friday', 'day')")
    .run().lastInsertRowid);
  db.prepare(`INSERT INTO schedule_template_rows (template_id, day_offset, employee_id, position, start_min, end_min, daypart)
    VALUES (?, 0, ?, 'server', ?, ?, 'dinner')`).run(t, MORE.plan, 17 * 60, 23 * 60);
  const day = '2026-10-02';
  const res = await post('/schedule/apply-template', { id: String(t), to: day, svc: 'evening-service', w: day });
  assert.strictEqual(res.status, 302);
  const made = plansOn(MORE.plan, day);
  assert.strictEqual(made.length, 1, `one draft made (${msgOf(res)})`);
  assert.strictEqual(made[0].daypart, 'evening-service', 'on the Evening Service people work, not the archived one');
  assert.doesNotMatch(msgOf(res), /not this board/, 'and nothing says it went somewhere else');
});

test('copying a day from the all-schedules board leaves a shift on the archived evening behind, and says so', async () => {
  const from = '2026-10-05'; const to = '2026-10-12';
  // A plan made while 'dinner' still ran.
  db.prepare(`INSERT INTO scheduled_shifts (employee_id, position, business_date, starts_at, ends_at, daypart, status)
    VALUES (?, 'server', ?, ?, ?, 'dinner', 'draft')`)
    .run(MORE.plan, from, TC.localInputToUtc(`${from}T17:00`), TC.localInputToUtc(`${from}T23:00`));
  const res = await post('/schedule/copy-day', { from, to, svc: 'all', w: from });
  assert.strictEqual(res.status, 302);
  assert.deepStrictEqual(plansOn(MORE.plan, to).map((r) => r.daypart), [],
    'nothing copied onto a board nobody can open');
  assert.match(msgOf(res), /could not be copied \(it is on the archived Evening Service\)/,
    `and the message names it as the archived one (${msgOf(res)})`);
});

test('a shift posted with no schedule, or naming the archived one, lands on a schedule that runs', async () => {
  // The drawer always sends a running schedule. A hand-made or very old page
  // need not. With none named the scheduler guesses from the clock, and the
  // guess answers in the original pair — 'dinner' from 4pm — so an evening
  // shift posted that way went onto the archived evening. Naming the archived
  // one outright was taken as given.
  const d1 = '2026-10-06'; const d2 = '2026-10-07';
  await post('/schedule/shift', { employee_id: String(MORE.plan), position: 'server',
    date: d1, start: '17:00', end: '23:00', svc: 'all', w: d1 });
  assert.deepStrictEqual(plansOn(MORE.plan, d1).map((r) => r.daypart), ['evening-service'],
    'with no schedule named, a 5pm shift goes on the running Evening Service');
  // A schedule that no longer runs is read as no schedule named, so the board
  // it came from answers — before the clock, as it always has. From the Evening
  // board at 10am the two disagree, which is what makes this say something.
  await post('/schedule/shift', { employee_id: String(MORE.plan), position: 'server',
    date: d2, start: '10:00', end: '16:00', daypart: 'dinner', svc: 'evening-service', w: d2 });
  assert.deepStrictEqual(plansOn(MORE.plan, d2).map((r) => r.daypart), ['evening-service'],
    'naming the archived evening from the Evening board, it goes on the Evening board');
});

test('the scheduler itself never stamps new work on the archived evening, or moves a shift onto it', () => {
  // Beneath the routes, for whatever calls it next: every caller today already
  // hands it a running schedule, so only a direct call can reach this.
  const SCH = require('../src/scheduler');
  const day = '2026-10-09';
  const made = SCH.create({ employeeId: MORE.plan, position: 'server',
    startsAt: `${day} 10:00`, endsAt: `${day} 16:00`, daypart: 'dinner', createdBy: 'test' });
  assert.strictEqual(made.daypart, 'cafe', 'named and archived, it is guessed from the clock like no name at all');
  const late = SCH.create({ employeeId: MORE.plan, position: 'server',
    startsAt: `${day} 17:00`, endsAt: `${day} 23:00`, createdBy: 'test' });
  assert.strictEqual(late.daypart, 'evening-service', 'and the evening guess is the running Evening Service');
  assert.strictEqual(SCH.serviceFor(TC.localInputToUtc(`${day}T17:00`)), 'dinner',
    'while the clock boundary itself still answers in the original pair, as INV6 requires');
  SCH.edit(made.id, { daypart: 'dinner' });
  assert.strictEqual(SCH.byId(made.id).daypart, 'cafe', 'an edit naming the archived evening leaves the shift where it is');
  SCH.edit(made.id, { daypart: 'evening-service' });
  assert.strictEqual(SCH.byId(made.id).daypart, 'evening-service', 'while a running one still moves it');
});

// --- doors where a person opens new work ------------------------------------

test('a report from an old page naming the archived evening is sent back to choose, and opens no second Evening sheet', async () => {
  // The report form lists running services only. A phone still holding a page
  // from before the evening service was replaced posts 'dinner' — and that was
  // taken: it opened the archived evening's sheet for the night, under the name
  // "Evening Service", and filed the person's sales and tips there, apart from
  // the sheet the tip-out runs on.
  const day = '2026-09-20';
  const body = { employee_id: String(MORE.report), pin: PIN(MORE.report), mode: 'manual', position: 'server',
    date: day, food: '120.00', card_tips: '20.00' };
  const res = await post('/tips', { ...body, daypart: 'dinner' });
  assert.strictEqual(res.status, 200, 'the form comes back rather than saving');
  const back = await res.text();
  assert.match(back, /Choose which service you worked/, 'asking which service');
  // And the form it comes back as must not hand the same answer straight back.
  // Its list keeps whatever was posted, which for the archived evening meant a
  // second "Evening Service", already selected — send again, refused again.
  const sel = back.match(/<select id="st-dp" name="daypart"[\s\S]*?<\/select>/);
  assert.ok(sel, 'the service question is on the returned form');
  const again0 = submitted(sel[0]);
  assert.ok(!again0.values.includes('dinner'), `the archived evening is not offered back (${again0.values})`);
  assert.strictEqual(again0.value, '', 'and nothing is chosen for them');
  const reload = await page(`/portal/tips?manual=1&date=${day}&daypart=dinner`, await signIn(MORE.report));
  const sel2 = reload.match(/<select id="st-dp" name="daypart"[\s\S]*?<\/select>/);
  assert.ok(sel2 && !submitted(sel2[0]).values.includes('dinner'),
    'nor by the reload that keeps a picked date and service');
  assert.ok(!db.prepare("SELECT 1 FROM shifts WHERE date = ? AND daypart = 'dinner'").get(day),
    'and no archived-evening sheet was opened for the night');
  assert.ok(!db.prepare('SELECT 1 FROM server_sales WHERE employee_id = ?').get(MORE.report), 'nothing was filed');

  const again = await post('/tips', { ...body, daypart: 'evening-service' });
  assert.strictEqual(again.status, 302, 'picked from the running ones, it goes through');
  const sh = db.prepare("SELECT id FROM shifts WHERE date = ? AND daypart = 'evening-service'").get(day);
  assert.strictEqual(db.prepare('SELECT food_cents FROM server_sales WHERE shift_id = ? AND employee_id = ?')
    .get(sh.id, MORE.report).food_cents, 12000, 'onto the Evening Service sheet');
});

test('Log a service will not open the archived evening', async () => {
  const day = '2026-09-23';
  const res = await post('/shifts', { date: day, daypart: 'dinner' });
  assert.strictEqual(res.status, 302);
  assert.match(String(res.headers.get('location')), /^\/shifts\/new\?err=1/, 'sent back to pick a service');
  assert.ok(!db.prepare("SELECT 1 FROM shifts WHERE date = ? AND daypart = 'dinner'").get(day),
    'and no sheet was opened on it');
  const ok = await post('/shifts', { date: day, daypart: 'evening-service' });
  assert.match(String(ok.headers.get('location')), /^\/shifts\/\d+$/, 'the running Evening Service opens as always');
});

test('a clock-in naming the archived evening is asked which service, not told they are not set up for Evening', async () => {
  // Refused before as well — by the gate that asks whether this person works
  // that service — but in words that told somebody on the running Evening
  // Service that they were "not set up for Evening Service".
  const cookie = await signIn(MORE.clock);
  const res = await post('/portal/clock/in', { daypart: 'dinner', position: 'server' }, cookie);
  assert.strictEqual(res.status, 302);
  const where = decodeURIComponent(String(res.headers.get('location')));
  assert.match(where, /Choose which service you are working/, `asked to choose (${where})`);
  assert.ok(!db.prepare('SELECT 1 FROM time_entries WHERE employee_id = ?').get(MORE.clock), 'and nothing was punched');
});

test('the POS feed still takes an evening batch sent as "dinner", as its contract spells it', async () => {
  // A guard, not a fix. The README handed to Benugin's developer spells the
  // evening batch "daypart": "dinner". Every door where a PERSON files work now
  // refuses the archived evening; this one must not, or a night's figures are
  // dropped. Which sheet such a batch belongs on is the owner's call, so this
  // pins only that it is taken and kept.
  const hook = (daypart) => fetch(`${BASE}/webhook/benugin`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': HOOK },
    body: JSON.stringify({ date: '2026-09-24', daypart, servers: [{ name: 'More pos', food: 150, card_tips: 30 }] }),
  });
  for (const d of ['dinner', 'evening-service', 'cafe']) {
    const r = await hook(d);
    const out = await r.json();
    assert.strictEqual(r.status, 200, `a "${d}" batch is accepted (${JSON.stringify(out)})`);
    assert.deepStrictEqual(out.matched, ['More pos'], 'and matched to the person');
    assert.ok(db.prepare('SELECT 1 FROM server_sales WHERE shift_id = ? AND employee_id = ?').get(out.shift_id, MORE.pos),
      'with their figures kept on the sheet it names');
  }
});

// --- availability -------------------------------------------------------------

test('availability reaches the Evening Service the restaurant added: no service asked, and the Evening board warns', async () => {
  // Checked and already right. The sheets were handed the hard-coded pair and
  // never read it; availability is a stretch of the wall clock, not a service
  // (Phase 6 §38-39), and the check runs against each planned shift's own
  // hours — so it reaches the added Evening Service exactly as it reaches Day.
  const day = '2026-10-08';
  const cookie = await signIn(MORE.avail);
  const tab = await page('/portal/schedule?v=avail', cookie);
  const form = (tab.match(/<form class="myav-panel" method="post" action="\/portal\/availability"[\s\S]*?<\/form>/) || [''])[0];
  assert.ok(form, 'the availability sheet is on the page');
  assert.doesNotMatch(form, /name="daypart"|name="svc"/, 'and asks for no service');

  const said = await post('/portal/availability', { kind: 'unavailable', on_date: day, weekday: '', all_day: '1', note: '' }, cookie);
  assert.match(msgOf(said), /^Saved/, `their unavailability is saved (${msgOf(said)})`);
  const res = await post('/schedule/shift', { employee_id: String(MORE.avail), position: 'server',
    date: day, start: '17:00', end: '23:00', svc: 'evening-service', w: day });
  assert.match(msgOf(res), /More avail said they cannot work then/, 'saving an Evening shift over it warns');
  const board = await page(`/schedule?svc=evening-service&w=${day}`);
  assert.match(board, /More avail said they cannot work then/, 'and the Evening board carries it as an issue');
});
