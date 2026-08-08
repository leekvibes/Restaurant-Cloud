'use strict';

// ===========================================================================
// Scheduler Phase 3 — publish, and what an employee can see.
//
// One invariant runs through all of it: an employee never reads mutable draft
// state. Not because the queries are careful — because drafts are not in the
// table the employee queries read. These tests try to break that from both
// ends: the manager edits without publishing, and the employee asks for
// somebody else's schedule.
//
// The second theme is notification honesty. Ten draft edits must reach nobody.
// One publish must reach each affected person exactly once, and a retry must
// reach nobody at all.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3998;                     // unique across the suite — boot.test.js guards this
const BASE = `http://127.0.0.1:${PORT}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-pub-'));
const DB = path.join(dir, 'pub.db');
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
let child; let Database; let db; let SCH; let TC; let dates;

const text = async (p, headers = {}) => (await fetch(BASE + p, { headers })).text();
const status = async (p, headers = {}) => (await fetch(BASE + p, { headers, redirect: 'manual' })).status;
const post = async (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});
const flashOf = (res) => {
  const q = new URLSearchParams((res.headers.get('location') || '').split('?')[1] || '');
  return { msg: q.get('msg') || '', err: q.get('err') === '1' };
};
async function signIn(pin) {
  const res = await post('/tips/start', { pin });
  assert.strictEqual(res.status, 302, `PIN ${pin} is accepted`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const E = { esther: 401, eunji: 402, kevin: 403 };
const PIN = { esther: '6401', eunji: '6402', kevin: '6403' };

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new Database(DB);
  const ins = db.prepare(
    'INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,?,?,?,1)');
  ins.run(E.esther, 'Esther Pub', 'server', PIN.esther, 1500);
  ins.run(E.eunji, 'Eunji Pub', 'server', PIN.eunji, 1500);
  ins.run(E.kevin, 'Kevin Pub', 'kitchen', PIN.kevin, 1600);

  SCH = require('../src/scheduler');
  TC = require('../src/timeclock');
  dates = require('../src/dates');
});

test.after(() => {
  if (child) child.kill();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const today = () => TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);

/** A fresh week per test group, so no two groups can collide. */
let weekCursor = 0;
const freshWeek = () => SCH.weekWindowFor(dates.addDays(today(), 14 + (weekCursor += 7)));

const mk = (empId, day, start, end, extra = {}) => SCH.create({
  employeeId: empId, position: empId === E.kevin ? 'kitchen' : 'server',
  startsAt: `${day} ${start}`, endsAt: `${day} ${end}`, ...extra,
});
const pubRows = (empId, w) => db.prepare(`SELECT * FROM published_schedule
  WHERE employee_id = ? AND business_date BETWEEN ? AND ? ORDER BY starts_at`).all(empId, w.start, w.end);
const events = (empId) => db.prepare(
  "SELECT * FROM portal_events WHERE kind = 'schedule' AND employee_id = ? ORDER BY id").all(empId);

// ===========================================================================
// Published truth survives the draft
// ===========================================================================

test('A: first publish puts the shift on the employee schedule', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  assert.strictEqual(pubRows(E.esther, w).length, 0, 'a draft reaches nobody');

  const res = await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  assert.strictEqual(flashOf(res).err, false, flashOf(res).msg);
  const rows = pubRows(E.esther, w);
  assert.strictEqual(rows.length, 1, 'now she has it');
  assert.strictEqual(rows[0].starts_at, s.starts_at);
});

test('B: a draft edit does NOT change what the employee sees', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  const published = pubRows(E.esther, w)[0].starts_at;

  SCH.edit(s.id, { startsAt: `${w.start} 17:00`, endsAt: `${w.start} 23:00` });
  assert.strictEqual(pubRows(E.esther, w)[0].starts_at, published,
    'she is still looking at 4pm while the manager holds 5pm');
  assert.strictEqual(SCH.byId(s.id).changed_after_publish, 1, 'and the manager is told it is stale');
});

test('C: republishing moves the employee to the new truth', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  SCH.edit(s.id, { startsAt: `${w.start} 17:00`, endsAt: `${w.start} 23:00` });
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });

  assert.strictEqual(pubRows(E.esther, w)[0].starts_at, SCH.byId(s.id).starts_at, 'she sees 5pm now');
  assert.strictEqual(SCH.byId(s.id).changed_after_publish, 0, 'and nothing is stale');
});

test('D/E: a cancellation reaches the employee only when it is published', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });

  SCH.cancel(s.id);
  assert.strictEqual(pubRows(E.esther, w).length, 1,
    'cancelled in draft — she still sees the shift she was given');

  await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(pubRows(E.esther, w).length, 0, 'published — it is gone');
  // §13: no employee-visible cancelled-history row.
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM published_schedule WHERE scheduled_shift_id = ?')
    .get(s.id).n, 0, 'and it leaves no tombstone behind');
});

test('F/G: reassignment moves atomically, and only on publish', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });

  SCH.edit(s.id, { employeeId: E.eunji });
  assert.strictEqual(pubRows(E.esther, w).length, 1, 'Esther still owns the published truth');
  assert.strictEqual(pubRows(E.eunji, w).length, 0, 'and Eunji has nothing yet');

  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  assert.strictEqual(pubRows(E.esther, w).length, 0, 'Esther loses it');
  assert.strictEqual(pubRows(E.eunji, w).length, 1, 'Eunji gains it');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM published_schedule WHERE scheduled_shift_id = ?')
    .get(s.id).n, 1, 'one row moved rather than two rows existing');
});

test('a cross-week move updates the one shift rather than leaving two', async () => {
  const w = freshWeek();
  const s = mk(E.kevin, w.start, '09:00', '15:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  const next = SCH.weekWindowFor(dates.addDays(w.start, 7));

  SCH.edit(s.id, { startsAt: `${next.start} 09:00`, endsAt: `${next.start} 15:00` });
  await post('/schedule/publish-week', { w: next.start });

  assert.strictEqual(pubRows(E.kevin, w).length, 0, 'the old week is empty');
  assert.strictEqual(pubRows(E.kevin, next).length, 1, 'the new week has it');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM published_schedule WHERE scheduled_shift_id = ?')
    .get(s.id).n, 1, 'and there is still exactly one of it');
});

// ===========================================================================
// Unpublish — not cancel, not delete
// ===========================================================================

test('unpublish takes it off the employee schedule and KEEPS the draft', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  assert.strictEqual(pubRows(E.esther, w).length, 1);

  const res = await post(`/schedule/shift/${s.id}/unpublish`, { w: w.start });
  assert.strictEqual(flashOf(res).err, false, flashOf(res).msg);
  assert.strictEqual(pubRows(E.esther, w).length, 0, 'she cannot see it');

  const draft = SCH.byId(s.id);
  assert.ok(draft, 'the shift is still there');
  assert.strictEqual(draft.status, 'draft', 'as a draft');
  assert.notStrictEqual(draft.status, 'cancelled', 'NOT cancelled');
  assert.strictEqual(draft.starts_at, s.starts_at, 'unchanged');

  // And it can go back out.
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  assert.strictEqual(pubRows(E.esther, w).length, 1, 'republished');
});

test('there is no hard-delete path in the Scheduler', async () => {
  // §14 — a shift that has ever been published must never be hard-deleted by
  // normal workflow, because published_schedule cascades from it. Cancellation
  // is the removal workflow, and it keeps the row.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');
  assert.doesNotMatch(src, /DELETE FROM scheduled_shifts/,
    'the domain never deletes a scheduled shift');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const region = server.slice(server.indexOf("app.post('/schedule/shift'"),
    server.indexOf("app.get('/timeclock'"));
  assert.doesNotMatch(region, /DELETE FROM scheduled_shifts/, 'and no route does either');
  assert.match(region, /SCH\.cancel\(/, 'removal goes through cancel()');
});

// ===========================================================================
// Material change — only what an employee can see
// ===========================================================================

test('a note-only edit does NOT mark the week stale', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  SCH.edit(s.id, { note: 'section 4 tonight' });
  assert.strictEqual(SCH.byId(s.id).changed_after_publish, 0,
    'employees never see the note, so nothing they see went stale');
});

test('a service-only edit does NOT mark the week stale', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  SCH.edit(s.id, { daypart: 'cafe' });
  assert.strictEqual(SCH.byId(s.id).daypart, 'cafe', 'the stamp still moved');
  assert.strictEqual(SCH.byId(s.id).changed_after_publish, 0,
    'but employees are never shown the service');
});

test('an identical breaks patch does NOT mark the week stale', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00', { breaks: [{ minutes: 30 }] });
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  SCH.edit(s.id, { breaks: [{ minutes: 30 }] });          // same thing, re-saved
  assert.strictEqual(SCH.byId(s.id).changed_after_publish, 0,
    're-saving the drawer without changing the break asks for no republish');
});

test('a real break change DOES mark the week stale and republishes', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00', { breaks: [{ minutes: 30 }] });
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  const before = JSON.parse(pubRows(E.esther, w)[0].breaks_json)[0].minutes;

  SCH.edit(s.id, { breaks: [{ minutes: 45 }] });
  assert.strictEqual(SCH.byId(s.id).changed_after_publish, 1, 'the manager is told');
  assert.strictEqual(JSON.parse(pubRows(E.esther, w)[0].breaks_json)[0].minutes, before,
    'and she still sees the old break until it is published');

  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  assert.strictEqual(JSON.parse(pubRows(E.esther, w)[0].breaks_json)[0].minutes, 45);
});

test('overlaps never block publishing', async () => {
  const w = freshWeek();
  const a = mk(E.esther, w.start, '16:00', '22:00');
  const b = mk(E.esther, w.start, '17:00', '23:00');
  const res = await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(flashOf(res).err, false, 'published anyway');
  assert.strictEqual(pubRows(E.esther, w).length, 2, 'both overlapping shifts went out');
  assert.ok(a.id && b.id);
});

// ===========================================================================
// Notifications
// ===========================================================================

test('ten draft edits notify nobody', async () => {
  const w = freshWeek();
  const s = mk(E.kevin, w.start, '09:00', '15:00');
  const before = events(E.kevin).length;
  for (let i = 0; i < 10; i++) SCH.edit(s.id, { note: `pass ${i}` });
  assert.strictEqual(events(E.kevin).length, before, 'nothing published, so nothing said');
});

test('one week publish sends one notification per affected employee', async () => {
  const w = freshWeek();
  // Esther gets three shifts; Kevin one; Eunji none.
  mk(E.esther, w.start, '16:00', '22:00');
  mk(E.esther, dates.addDays(w.start, 1), '16:00', '22:00');
  mk(E.esther, dates.addDays(w.start, 2), '16:00', '22:00');
  mk(E.kevin, w.start, '09:00', '15:00');
  const before = { e: events(E.esther).length, k: events(E.kevin).length, u: events(E.eunji).length };

  await post('/schedule/publish-week', { w: w.start });

  assert.strictEqual(events(E.esther).length - before.e, 1,
    'three shifts, one message — not one per shift');
  assert.strictEqual(events(E.kevin).length - before.k, 1);
  assert.strictEqual(events(E.eunji).length - before.u, 0, 'and nobody unaffected is disturbed');
});

test('the exact same publish, retried, notifies nobody again', async () => {
  const w = freshWeek();
  mk(E.esther, w.start, '16:00', '22:00');
  await post('/schedule/publish-week', { w: w.start });
  const after = events(E.esther).length;

  await post('/schedule/publish-week', { w: w.start });
  await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(events(E.esther).length, after,
    'a double click, a refresh, a retried request — the result is the same, so the message is not repeated');
});

test('a genuine later change DOES notify again', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post('/schedule/publish-week', { w: w.start });
  const after = events(E.esther).length;

  SCH.edit(s.id, { startsAt: `${w.start} 15:00`, endsAt: `${w.start} 21:00` });
  await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(events(E.esther).length, after + 1, 'a different outcome is a new message');
});

test('the first message says ready, the next says updated', async () => {
  const w = freshWeek();
  const s = mk(E.eunji, w.start, '16:00', '22:00');
  await post('/schedule/publish-week', { w: w.start });
  const first = events(E.eunji).slice(-1)[0];
  assert.match(first.title, /is ready\./, 'the first time they get a week, it is ready');

  SCH.edit(s.id, { startsAt: `${w.start} 15:00`, endsAt: `${w.start} 21:00` });
  await post('/schedule/publish-week', { w: w.start });
  const second = events(E.eunji).slice(-1)[0];
  assert.match(second.title, /was updated\./, 'after that it is an update');
});

test('unpublishing tells the person who lost the shift', async () => {
  const w = freshWeek();
  const s = mk(E.kevin, w.start, '09:00', '15:00');
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });
  const before = events(E.kevin).length;
  await post(`/schedule/shift/${s.id}/unpublish`, { w: w.start });
  assert.strictEqual(events(E.kevin).length, before + 1, 'losing a shift is a schedule change too');
});

test('a reassignment tells both the old and the new employee', async () => {
  const w = freshWeek();
  const s = mk(E.esther, w.start, '16:00', '22:00');
  await post('/schedule/publish-week', { w: w.start });
  const before = { e: events(E.esther).length, u: events(E.eunji).length };

  SCH.edit(s.id, { employeeId: E.eunji });
  await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(events(E.esther).length - before.e, 1, 'Esther is told she lost it');
  assert.strictEqual(events(E.eunji).length - before.u, 1, 'Eunji is told she has it');
});

test('a notification carries a week and a verb, and nothing private', async () => {
  const w = freshWeek();
  mk(E.esther, w.start, '16:00', '22:00', { note: 'SECRET manager note' });
  mk(E.kevin, w.start, '09:00', '15:00');
  await post('/schedule/publish-week', { w: w.start });

  for (const ev of events(E.esther).slice(-1)) {
    const all = `${ev.title} ${ev.body || ''}`;
    assert.doesNotMatch(all, /SECRET/i, 'no note');
    assert.doesNotMatch(all, /Kevin/i, 'no coworker');
    assert.doesNotMatch(all, /server|kitchen/i, 'no position');
    assert.doesNotMatch(all, /\d{1,2}(:\d{2})?\s*[ap]m?\b/i, 'no times');
    assert.strictEqual(ev.employee_id, E.esther, 'and it is addressed to one person');
    assert.strictEqual(ev.href, '/portal/schedule', 'pointing at a page that exists');
  }
});

// ===========================================================================
// The employee's own pages
// ===========================================================================

test('Only me shows published shifts and no draft', async () => {
  const w = freshWeek();
  const shown = mk(E.esther, w.start, '16:00', '22:00');
  const hidden = mk(E.esther, dates.addDays(w.start, 1), '11:00', '15:00');
  await post(`/schedule/shift/${shown.id}/publish`, { w: w.start });

  const cookie = await signIn(PIN.esther);
  const html = await text('/portal/schedule', { cookie });
  assert.match(html, /4p – 10p/, 'the published shift is there');
  assert.doesNotMatch(html, /11a – 3p/, 'the unpublished one is not');
  assert.ok(hidden.id);
});

test('Only me never contains a coworker, anywhere in the page source', async () => {
  const w = freshWeek();
  const mine = mk(E.esther, w.start, '16:00', '22:00');
  const theirs = mk(E.kevin, w.start, '09:00', '15:00');
  await post('/schedule/publish-week', { w: w.start });

  const cookie = await signIn(PIN.esther);
  const html = await text('/portal/schedule?v=me', { cookie });
  assert.doesNotMatch(html, /Kevin Pub/, 'not rendered, and not hiding in the markup either');
  assert.ok(mine.id && theirs.id);
});

test('Everyone shows published coworkers, and still no drafts or private fields', async () => {
  const w = freshWeek();
  mk(E.esther, w.start, '16:00', '22:00', { note: 'SECRET note' });
  const draft = mk(E.kevin, dates.addDays(w.start, 1), '09:00', '15:00');
  await post(`/schedule/publish-week`, { w: w.start });
  // Now add one more that is NOT published.
  const unpublished = mk(E.kevin, dates.addDays(w.start, 2), '06:00', '10:00');

  const cookie = await signIn(PIN.esther);
  const html = await text('/portal/schedule?v=all', { cookie });
  assert.match(html, /Kevin Pub/, 'coworkers are visible on the floor schedule');
  assert.doesNotMatch(html, /6a – 10a/, 'but only what was published');
  assert.doesNotMatch(html, /SECRET/, 'no notes');
  assert.doesNotMatch(html, /Planned break/, 'and no coworker break detail');
  assert.doesNotMatch(html, /cafe|dinner/i, 'no service');
  assert.ok(draft.id && unpublished.id);
});

test('an employee cannot read another employee\'s shift detail', async () => {
  const w = freshWeek();
  const hers = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${hers.id}/publish`, { w: w.start });

  const asKevin = await signIn(PIN.kevin);
  assert.strictEqual(await status(`/portal/schedule/shift/${hers.id}`, { cookie: asKevin }), 404,
    'somebody else\'s shift is not found, which is also all a guesser learns');

  const asEsther = await signIn(PIN.esther);
  assert.strictEqual(await status(`/portal/schedule/shift/${hers.id}`, { cookie: asEsther }), 200,
    'her own opens');
});

test('a forged employee id in the querystring changes nothing', async () => {
  const w = freshWeek();
  mk(E.kevin, w.start, '09:00', '15:00');
  await post('/schedule/publish-week', { w: w.start });

  const cookie = await signIn(PIN.esther);
  // Every shape somebody might try. The route reads the SESSION, never a param.
  for (const q of [`?employee=${E.kevin}`, `?emp=${E.kevin}`, `?employee_id=${E.kevin}`,
    `?v=me&employee=${E.kevin}`]) {
    const html = await text(`/portal/schedule${q}`, { cookie });
    assert.doesNotMatch(html, /Kevin Pub/, `${q} does not hand over somebody else's schedule`);
  }
});

test('the employee schedule reads published_schedule and nothing mutable', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const region = src.slice(src.indexOf("app.get('/portal/schedule'"),
    src.indexOf("app.get('/portal/specials'"));
  assert.doesNotMatch(region, /scheduled_shifts|SCH\.inRange\(|SCH\.q\.inRangeAll/,
    'no draft table, no draft query');
  assert.match(region, /pubInRange|pubForWeek|pubById/, 'only the published ones');
});

test('My availability is present and honestly empty', async () => {
  const cookie = await signIn(PIN.esther);
  const html = await text('/portal/schedule?v=avail', { cookie });
  assert.match(html, /My availability/, 'the section exists');
  assert.match(html, /coming later/i, 'and says so');
  // Phase 6 owns the real thing. Nothing here may imply it works.
  for (const fake of ['Save', 'Request time off', 'Prefer', 'Unavailable', 'Repeat']) {
    assert.ok(!new RegExp(`>${fake}`, 'i').test(html), `no ${fake} control`);
  }
});

test('the three Schedule sections are present, in the locked order', async () => {
  const cookie = await signIn(PIN.esther);
  const html = await text('/portal/schedule', { cookie });
  const nav = (html.match(/<nav class="ps-tabs"[\s\S]*?<\/nav>/) || [''])[0];
  assert.ok(nav, 'the section nav rendered');
  const labels = [...nav.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepStrictEqual(labels, ['Only me', 'Everyone', 'My availability']);
  assert.match(nav, /class="ps-t on"[^>]*href="\/portal\/schedule\?v=me"/, 'Only me is the default');
});

test('publishing writes nothing to time, work, payroll or services', async () => {
  const w = freshWeek();
  const before = {
    time_entries: db.prepare('SELECT COUNT(*) n FROM time_entries').get().n,
    time_breaks: db.prepare('SELECT COUNT(*) n FROM time_breaks').get().n,
    work: db.prepare('SELECT COUNT(*) n FROM work').get().n,
    shifts: db.prepare('SELECT COUNT(*) n FROM shifts').get().n,
    tip_submissions: db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n,
  };
  const s = mk(E.esther, w.start, '16:00', '22:00', { breaks: [{ minutes: 30 }] });
  await post('/schedule/publish-week', { w: w.start });
  await post(`/schedule/shift/${s.id}/unpublish`, { w: w.start });
  await post(`/schedule/shift/${s.id}/publish`, { w: w.start });

  const after = {
    time_entries: db.prepare('SELECT COUNT(*) n FROM time_entries').get().n,
    time_breaks: db.prepare('SELECT COUNT(*) n FROM time_breaks').get().n,
    work: db.prepare('SELECT COUNT(*) n FROM work').get().n,
    shifts: db.prepare('SELECT COUNT(*) n FROM shifts').get().n,
    tip_submissions: db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n,
  };
  assert.deepStrictEqual(after, before,
    'publishing a plan is still only publishing a plan');
});
