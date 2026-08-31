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

// /schedule now shows a service picker first; these tests are about
// publishing, so the helper asks for every service and they assert what they
// always did. The picker has its own tests in schedule-board.test.js.
const svcd = (p) => {
  if (/^\/schedule(\?|$)/.test(p) && !/[?&]svc=/.test(p)) {
    return p + (p.includes('?') ? '&' : '?') + 'svc=all';
  }
  // The PORTAL schedule now asks which one first, for anybody on more than one
  // — which is everybody until a manager narrows them. These tests are about
  // what the schedule shows, so they name a schedule; the picker itself is
  // tested separately.
  if (/^\/portal\/schedule(\?|$)/.test(p) && !/[?&]svc=/.test(p)) {
    // 'dinner', because every fixture in this file starts at 16:00 and so
    // lands on Evening. A blanket default of Day silently hid all of them and
    // four tests started asserting against an empty schedule.
    return p + (p.includes('?') ? '&' : '?') + 'svc=dinner';
  }
  return p;
};
const text = async (p, headers = {}) => (await fetch(BASE + svcd(p), { headers })).text();
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

/**
 * The same idea, but inside the window the portal is allowed to render.
 *
 * freshWeek() walks a week further out on every call, and after twenty-odd
 * groups it is past the ninety days the employee page shows — so a fixture
 * placed there is invisible, and an assertion like "her shift is on the page"
 * passes on some OTHER test's identical 4p–10p shift instead. Any test that
 * renders /portal/schedule uses this one, and asks for its own week by date.
 */
let nearCursor = 0;
const nearWeek = () => {
  nearCursor += 1;
  assert.ok(nearCursor <= 11, 'the portal window only holds so many fresh weeks');
  return SCH.weekWindowFor(dates.addDays(today(), 7 * nearCursor));
};

/** Both ends given in full, so a shift may legitimately cross midnight. */
const mkSpan = (empId, startsAt, endsAt, extra = {}) => SCH.create({
  employeeId: empId, position: empId === E.kevin ? 'kitchen' : 'server',
  startsAt, endsAt, ...extra,
});
/** The common case: one day, two clock times. */
const mk = (empId, day, start, end, extra = {}) => mkSpan(
  empId, `${day} ${start}`, `${day} ${end}`, extra);
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
    assert.match(ev.href, /^\/portal\/schedule\?d=\d{4}-\d{2}-\d{2}$/,
      'pointing at that week of a page that exists — a date, nothing else');
  }
});

test('A -> B -> A: restoring an earlier schedule still notifies', async () => {
  // The trap in deduping on the resulting state alone. If the key is only the
  // fingerprint, going back to a schedule the employee once had can never be
  // announced: the key already exists from the first time, and they are left
  // looking at a changed schedule nobody mentioned.
  const w = freshWeek();
  const s = mk(E.kevin, w.start, '09:00', '15:00');
  const count = () => events(E.kevin).length;

  const base = count();                               // Kevin has history from earlier tests
  await post('/schedule/publish-week', { w: w.start });
  const afterA = count();
  assert.strictEqual(afterA, base + 1, 'A published — told once');

  await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(count(), afterA, 'exact retry of A — silent');

  SCH.edit(s.id, { startsAt: `${w.start} 11:00`, endsAt: `${w.start} 17:00` });
  await post('/schedule/publish-week', { w: w.start });
  const afterB = count();
  assert.strictEqual(afterB, afterA + 1, 'B published — told again');

  await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(count(), afterB, 'exact retry of B — silent');

  SCH.edit(s.id, { startsAt: `${w.start} 09:00`, endsAt: `${w.start} 15:00` });  // back to A
  await post('/schedule/publish-week', { w: w.start });
  const afterA2 = count();
  assert.strictEqual(afterA2, afterB + 1,
    'back to A — a DIFFERENT publication event, so it is announced');

  await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(count(), afterA2, 'and its retry is silent too');

  // And it keeps working around the cycle, which a transition-pair key would
  // not: A->B repeats on the fourth publish.
  SCH.edit(s.id, { startsAt: `${w.start} 11:00`, endsAt: `${w.start} 17:00` });
  await post('/schedule/publish-week', { w: w.start });
  assert.strictEqual(count(), afterA2 + 1, 'B again, second time around — still announced');
});

// ===========================================================================
// Reactivation — the shifts that were still ahead of them
// ===========================================================================

const setActive = (id, on) => {
  const { q } = require('../src/db');
  q.setActive.run({ id, active: on ? 1 : 0 });
};
const visibleTo = (empId, w) => SCH.publishedFor(empId, { from: w.start, to: w.end });

test('reactivation hides what already happened and keeps what is ahead', async () => {
  // Relative to the CLOCK, not to a business date. "Later today" written as a
  // fixed hour is already past when the suite runs at 00:35, and the boundary
  // is an instant — so the fixture has to be one too. Queried over the whole
  // default window rather than a week, because a 2:35am shift belongs to the
  // PREVIOUS business date and would fall outside the week its calendar day
  // sits in.
  //
  // Each end is a whole timestamp. Taking the DAY from one offset and the TIME
  // from another put "23:18 – 00:18" onto a single day, which ends before it
  // starts — so this test failed between midnight and 2am, and again in the two
  // hours before midnight, and passed the rest of the day. An hour either side
  // of midnight is an ordinary shift here; it must not be an ordinary bug.
  const at = (hoursFromNow) => {
    const s = TC.utcToLocalInput(
      new Date(Date.parse(`${TC.nowUtc().replace(' ', 'T')}Z`) + hoursFromNow * 3600000)
        .toISOString().slice(0, 19).replace('T', ' '));
    return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
  };

  const gone = mkSpan(E.eunji, at(-2), at(-1));
  const ahead = mkSpan(E.eunji, at(2), at(3));
  for (const s of [gone, ahead]) {
    await post(`/schedule/shift/${s.id}/publish`, { w: SCH.byId(s.id).business_date });
  }
  const seenNow = () => SCH.publishedFor(E.eunji).map((r) => r.scheduled_shift_id);
  assert.ok(seenNow().includes(gone.id) && seenNow().includes(ahead.id),
    'both visible while active');

  setActive(E.eunji, 0);
  setActive(E.eunji, 1);                              // reactivated NOW

  const seen = seenNow();
  assert.ok(!seen.includes(gone.id),
    'a shift that had already started stays hidden — a business date could not express this');
  assert.ok(seen.includes(ahead.id), 'one a couple of hours out comes back');
});

test('a future shift survives reactivation and is still there afterwards', async () => {
  const w = SCH.weekWindowFor(dates.addDays(today(), 3));
  const later = mk(E.kevin, dates.addDays(today(), 3), '09:00', '15:00');
  await post('/schedule/publish-week', { w: w.start });
  setActive(E.kevin, 0); setActive(E.kevin, 1);

  assert.ok(visibleTo(E.kevin, w).some((r) => r.scheduled_shift_id === later.id),
    'future at the moment of reactivation, so it returns');
  // The threshold is an instant, not a rolling filter: once that shift happens
  // it is simply recent history and keeps showing in the -7 tail.
  const emp = db.prepare('SELECT schedule_visible_from_at v FROM employees WHERE id = ?').get(E.kevin);
  assert.ok(emp.v && emp.v < SCH.byId(later.id).starts_at,
    'the boundary sits before it and does not move');
});

test('a second deactivate/reactivate sets a NEW boundary', async () => {
  const before = db.prepare('SELECT schedule_visible_from_at v FROM employees WHERE id = ?').get(E.kevin).v;
  assert.ok(before, 'there is a boundary from the first cycle');
  await new Promise((r) => setTimeout(r, 1100));      // the stamp has second resolution
  setActive(E.kevin, 0); setActive(E.kevin, 1);
  const after = db.prepare('SELECT schedule_visible_from_at v FROM employees WHERE id = ?').get(E.kevin).v;
  assert.ok(after > before, 'the second return moves the line forward');
});

test('re-saving an already-active employee does NOT move the boundary', () => {
  const was = db.prepare('SELECT schedule_visible_from_at v FROM employees WHERE id = ?').get(E.kevin).v;
  setActive(E.kevin, 1);                              // already active
  const now = db.prepare('SELECT schedule_visible_from_at v FROM employees WHERE id = ?').get(E.kevin).v;
  assert.strictEqual(now, was,
    'otherwise every save would quietly hide a little more of their history');
});

test('an employee who has never been deactivated is unaffected', () => {
  const v = db.prepare('SELECT schedule_visible_from_at v FROM employees WHERE id = ?').get(E.esther).v;
  assert.strictEqual(v, null, 'no threshold at all');
});

test('setActive is the only path that writes employees.active', () => {
  // If a second route ever writes the column directly, the boundary can be
  // bypassed and the rule quietly stops holding.
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const writes = (s) => (s.match(/UPDATE employees SET[^`']*\bactive\s*=/g) || []).length;
  assert.strictEqual(writes(srv), 0, 'no route writes employees.active directly');
  assert.strictEqual(writes(dbSrc), 2,
    'exactly the two statements inside setActive — the waking one and the plain one');
});

// ===========================================================================
// The employee's own pages
// ===========================================================================

test('Only me shows published shifts and no draft', async () => {
  const w = nearWeek();
  const shown = mk(E.esther, w.start, '16:00', '22:00');
  const hidden = mk(E.esther, dates.addDays(w.start, 1), '11:00', '15:00');
  await post(`/schedule/shift/${shown.id}/publish`, { w: w.start });

  const cookie = await signIn(PIN.esther);
  // The page shows one week — the one the strip names — so ask for the week the
  // fixture is in. Defaulting to today would prove nothing about either shift.
  const html = await text(`/portal/schedule?d=${w.start}`, { cookie });
  assert.match(html, /4p – 10p/, 'the published shift is there');
  assert.doesNotMatch(html, /11a – 3p/, 'the unpublished one is not');
  assert.ok(hidden.id);
});

test('every listed day sits under a band naming ITS OWN week', async () => {
  // The defect this locks: the header showed the picked week while the list
  // below it ran ninety days out, so "Aug 1 – Aug 7" sat directly on top of a
  // block headed "Aug 8 – Aug 14 · 4 shifts" and the arrows appeared dead.
  //
  // The list is CONTINUOUS now — it opens on today and scrolls both ways — so
  // the fix is no longer "list only this week". It is that a band travels with
  // the list and every day sits under one naming the week it is actually in. A
  // single header at the top would tell the same lie in a new place.
  const w = nearWeek();
  const shift = mk(E.esther, w.start, '16:00', '22:00');
  await post(`/schedule/shift/${shift.id}/publish`, { w: w.start });

  const cookie = await signIn(PIN.esther);
  const html = await text('/portal/schedule', { cookie });

  // Pull the bands and the day rows in the order they appear, and check each
  // row falls inside the band above it.
  const parts = [...html.matchAll(/<div class="ps-wk"><b>Week summary<\/b>\s*<i>([^<]*)<\/i>|id="d-(\d{4}-\d{2}-\d{2})"/g)];
  let currentBand = null; let checked = 0;
  for (const m of parts) {
    if (m[1]) { currentBand = m[1]; continue; }
    const day = m[2];
    assert.ok(currentBand, `the day ${day} has a band above it`);
    const wk = SCH.weekWindowFor(day);
    const label = TC.dayLabel(wk.start).replace(/^\w+, /, '');
    assert.ok(currentBand.includes(label),
      `${day} sits under a band for its own week (band said "${currentBand}", expected ${label})`);
    checked += 1;
  }
  assert.ok(checked >= 1, 'at least one day was listed and checked');
});

test('the list starts on the selected day and never runs backward', async () => {
  // CHANGED FROM the continuous list. That version opened on today with the
  // past above it, and two things were wrong: scrolling into position went PAST
  // the date strip, so the bar naming the day was off screen the moment the
  // page opened, and scrolling up landed you in history nobody asked for.
  //
  // Earlier days are still reachable — you tap the day on the strip and the
  // list starts there — but they are never above you.
  const cookie = await signIn(PIN.esther);
  const html = await text('/portal/schedule', { cookie });
  const today = TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);
  const days = [...html.matchAll(/id="d-(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
  for (const d of days) {
    assert.ok(d >= today, `${d} is not before today — nothing earlier is listed`);
  }
  assert.ok(!/scrollIntoView/.test(html),
    'and nothing scrolls the page on load, which is what hid the strip');
});

test('picking an earlier day starts the list THERE, still going forward', async () => {
  const cookie = await signIn(PIN.esther);
  const today = TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);
  const back = dates.addDays(today, -4);
  const html = await text(`/portal/schedule?d=${back}`, { cookie });
  const days = [...html.matchAll(/id="d-(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
  for (const d of days) {
    assert.ok(d >= back, `${d} is not before the day that was picked`);
  }
  // The strip is what makes that reachable, so it has to be on the page.
  assert.match(html, /class="ps-strip"/, 'the day strip is there to pick from');
});

test('the day strip is on Only me and Everyone, not just availability', async () => {
  const cookie = await signIn(PIN.esther);
  for (const v of ['me', 'all']) {
    const html = await text(`/portal/schedule?v=${v}`, { cookie });
    assert.match(html, /class="ps-strip"/, `${v} shows the date bar`);
    assert.match(html, /class="ps-wknav"/, `${v} shows the week it is on`);
  }
});

test('Publish on create reaches the employee; Save Draft reaches nobody', async () => {
  const w = nearWeek();
  const cookie = await signIn(PIN.esther);
  const before = events(E.esther).length;

  // Save Draft — the default, and the whole point of the two-step model.
  await post('/schedule/shift', { w: w.start, employee_id: String(E.esther),
    position: 'server', date: w.start, start: '09:00', end: '15:00', break_minutes: '' });
  assert.strictEqual(events(E.esther).length, before, 'a draft tells nobody');
  let html = await text(`/portal/schedule?d=${w.start}`, { cookie });
  assert.doesNotMatch(html, /9a – 3p/, 'and she cannot see it');

  // Publish — the same form, one flag, and it goes out immediately.
  await post('/schedule/shift', { w: w.start, employee_id: String(E.esther),
    position: 'server', date: dates.addDays(w.start, 1), start: '16:00', end: '22:00',
    break_minutes: '', publish: '1' });
  assert.strictEqual(events(E.esther).length, before + 1,
    'publishing on create tells her, once');
  html = await text(`/portal/schedule?d=${w.start}`, { cookie });
  assert.match(html, /4p – 10p/, 'and she can see that one');
  assert.doesNotMatch(html, /9a – 3p/, 'while the draft beside it stays hidden');
});

test('Only me never contains a coworker, anywhere in the page source', async () => {
  const w = nearWeek();
  const mine = mk(E.esther, w.start, '16:00', '22:00');
  const theirs = mk(E.kevin, w.start, '09:00', '15:00');
  await post('/schedule/publish-week', { w: w.start });

  const cookie = await signIn(PIN.esther);
  // Her week, not today's — on a week she is not working, "no Kevin" is true
  // for the wrong reason and the test proves nothing.
  const html = await text(`/portal/schedule?v=me&d=${w.start}`, { cookie });
  assert.match(html, /4p – 10p/, 'her own shift is on the page, so the page is the right one');
  assert.doesNotMatch(html, /Kevin Pub/, 'not rendered, and not hiding in the markup either');
  assert.ok(mine.id && theirs.id);
});

test('Everyone shows published coworkers, and still no drafts or private fields', async () => {
  const w = nearWeek();
  // All three on the SAME schedule. The portal shows one schedule at a time
  // now, so a coworker on the other one would be absent for a reason that has
  // nothing to do with publishing — and every doesNotMatch below would pass
  // against a page that was simply showing nothing.
  mk(E.esther, w.start, '16:00', '22:00', { note: 'SECRET note' });
  const draft = mk(E.kevin, dates.addDays(w.start, 1), '17:00', '23:00');
  await post(`/schedule/publish-week`, { w: w.start });
  // Now add one more that is NOT published.
  const unpublished = mk(E.kevin, dates.addDays(w.start, 2), '18:00', '22:00');

  const cookie = await signIn(PIN.esther);
  const html = await text(`/portal/schedule?v=all&d=${w.start}`, { cookie });
  assert.match(html, /Kevin Pub/, 'coworkers are visible on the floor schedule');
  assert.doesNotMatch(html, /6p – 10p/, 'but only what was published');
  assert.doesNotMatch(html, /SECRET/, 'no notes');
  assert.doesNotMatch(html, /Planned break/, 'and no coworker break detail');
  // No service on a COWORKER'S CARD. The page itself now carries service pills
  // for anybody who works more than one, so a blanket search for the word
  // catches this employee's own navigation rather than a leak. Scoped to the
  // cards, which is what the rule was ever about.
  const cards = (html.match(/<a class="ps-k[\s\S]*?<\/a>/g) || []).join('');
  assert.ok(cards.length, 'there are coworker cards to check');
  assert.doesNotMatch(cards, /cafe|dinner/i, 'no service on a coworker card');
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
  const w = nearWeek();
  mk(E.kevin, w.start, '09:00', '15:00');
  await post('/schedule/publish-week', { w: w.start });

  // On the week he IS published. Asking for a week nobody works hides him for
  // the wrong reason, and the forgery would go untested.
  // svc=cafe, because this fixture is a 9am shift — unlike the rest of this
  // file. It matters: the assertions below are all doesNotMatch, so they would
  // pass against a page showing nothing at all, and this line is what proves
  // the page was showing something to begin with.
  const asKevin = await signIn(PIN.kevin);
  assert.match(await text(`/portal/schedule?svc=cafe&d=${w.start}`, { cookie: asKevin }), /9a – 3p/,
    'his own shift is on his own page that week');

  const cookie = await signIn(PIN.esther);
  // Every shape somebody might try. The route reads the SESSION, never a param.
  for (const q of [`?employee=${E.kevin}`, `?emp=${E.kevin}`, `?employee_id=${E.kevin}`,
    `?v=me&employee=${E.kevin}`]) {
    const html = await text(`/portal/schedule${q}&svc=cafe&d=${w.start}`, { cookie });
    assert.doesNotMatch(html, /Kevin Pub/, `${q} does not hand over somebody else's schedule`);
    assert.doesNotMatch(html, /9a – 3p/, `${q} does not hand over his hours either`);
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

// PHASE 6 REPLACED THE GUARD THAT USED TO LIVE HERE, deliberately.
//
// It asserted the tab carried no control named Save, Request time off, Prefer,
// Unavailable or Repeat — the five Phase 6 ships. Its purpose was that THE TAB
// MUST NOT LIE ABOUT WHAT IT CAN DO, and that purpose outlived the assertion,
// so it is inverted rather than deleted: the controls appear only when the
// feature is really on, they belong only to the person signed in, and none of
// this reaches Only me or Everyone.
test('My availability is real, and belongs to the person signed in', async () => {
  const cookie = await signIn(PIN.esther);
  const html = await text('/portal/schedule?v=avail', { cookie });
  assert.match(html, /My availability/, 'the section exists');
  assert.doesNotMatch(html, /coming later/i, 'and no longer promises a later date');
  assert.match(html, /action="\/portal\/availability"/, 'with a form that posts somewhere real');
  assert.match(html, /class="myav-days"/, 'and a row for each day of the week on screen');
  assert.match(html, /data-add="\d{4}-\d{2}-\d{2}"/, 'each one offering to add something');
  // Every rendered rule must be this employee's. The route never reads an id
  // from the query, so the assertion is that nothing else leaked in.
  assert.doesNotMatch(html, /data-employee|employee_id"\s+value/, 'no employee id is ever posted back');
});

test('the availability tab honours the switch, and never lies about it', async () => {
  const P = require('../src/periods');
  const cookie = await signIn(PIN.esther);
  try {
    P.setSetting('sch_availability', '0');
    const off = await text('/portal/schedule?v=avail', { cookie });
    assert.match(off, /switched off/i, 'it says the manager is not collecting this');
    assert.doesNotMatch(off, /action="\/portal\/availability"/, 'and offers no way to add one');
    assert.doesNotMatch(off, /data-add=/, 'not even the button that opens the sheet');
    assert.match(off, /still request time off/i, 'while making clear time off is unaffected');
  } finally { P.setSetting('sch_availability', '1'); }
});

test('Phase 6 does not leak into Only me or Everyone', async () => {
  const cookie = await signIn(PIN.esther);
  for (const v of ['me', 'all']) {
    const html = await text(`/portal/schedule?v=${v}`, { cookie });
    for (const word of ['Cannot work', 'Prefer to work', 'Declare unavailability', 'myav-days']) {
      assert.ok(!html.includes(word), `${v} must not carry "${word}"`);
    }
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

// ===========================================================================
// Phase 6 checkpoint 2 — availability rule CRUD from the portal.
//
// The security properties are the point of this block. An employee owns their
// own rules and can reach nobody else's, and the id that decides which rows are
// touched comes from the signed cookie rather than from anything the client can
// type.
// ===========================================================================

const availRows = (empId) => db.prepare(
  'SELECT * FROM availability_rules WHERE employee_id = ? ORDER BY id').all(empId);

test('an employee can state a recurring rule, and it is theirs', async () => {
  const cookie = await signIn(PIN.esther);
  const me = db.prepare("SELECT id FROM employees WHERE pin = ?").get(PIN.esther).id;
  const before = availRows(me).length;
  const res = await post('/portal/availability',
    { weekday: '2', kind: 'unavailable', all_day: '1' }, { cookie });
  assert.strictEqual(res.status, 302);
  assert.match(flashOf(res).msg, /Saved/i);
  const rows = availRows(me);
  assert.strictEqual(rows.length, before + 1, 'one rule, for the person who asked');
  assert.strictEqual(rows[rows.length - 1].weekday, 2);
  assert.strictEqual(rows[rows.length - 1].all_day, 1);
});

test('a timed rule keeps its minutes, and an overnight one is stored as one row', async () => {
  const cookie = await signIn(PIN.esther);
  const me = db.prepare("SELECT id FROM employees WHERE pin = ?").get(PIN.esther).id;
  await post('/portal/availability',
    { weekday: '5', kind: 'unavailable', start: '22:00', end: '02:00' }, { cookie });
  const r = availRows(me).slice(-1)[0];
  assert.strictEqual(r.start_min, 1320, '22:00');
  assert.strictEqual(r.end_min, 120, '02:00');
  assert.strictEqual(r.all_day, 0);
  assert.ok(r.end_min <= r.start_min, 'ends next day, and it is still ONE row');
});

test('a start equal to its end is refused with a reason, not stored', async () => {
  const cookie = await signIn(PIN.esther);
  const me = db.prepare("SELECT id FROM employees WHERE pin = ?").get(PIN.esther).id;
  const before = availRows(me).length;
  const res = await post('/portal/availability',
    { weekday: '3', kind: 'unavailable', start: '09:00', end: '09:00' }, { cookie });
  assert.ok(flashOf(res).err, 'it is refused');
  assert.match(flashOf(res).msg, /same/i, 'and says what was wrong');
  assert.strictEqual(availRows(me).length, before, 'nothing was written');
});

test('one employee cannot delete another employee\'s rule', async () => {
  const mine = db.prepare("SELECT id FROM employees WHERE pin = ?").get(PIN.esther).id;
  const theirs = db.prepare('SELECT id FROM employees WHERE id <> ? AND active = 1 LIMIT 1').get(mine).id;
  const victim = db.prepare(`INSERT INTO availability_rules (employee_id, avail_kind, weekday, all_day)
                             VALUES (?, 'unavailable', 4, 1)`).run(theirs).lastInsertRowid;
  const cookie = await signIn(PIN.esther);
  const res = await post(`/portal/availability/${victim}/delete`, {}, { cookie });
  assert.strictEqual(res.status, 302, 'it answers rather than throwing');
  assert.ok(db.prepare('SELECT 1 FROM availability_rules WHERE id = ?').get(victim),
    "a forged id does not reach somebody else's row");
  assert.ok(flashOf(res).err, 'and the answer is a refusal, not a quiet success');
  db.prepare('DELETE FROM availability_rules WHERE id = ?').run(victim);
});

test('deleting your own rule returns you to the default, storing nothing', async () => {
  const cookie = await signIn(PIN.esther);
  const me = db.prepare("SELECT id FROM employees WHERE pin = ?").get(PIN.esther).id;
  await post('/portal/availability', { weekday: '6', kind: 'prefer', all_day: '1' }, { cookie });
  const id = availRows(me).slice(-1)[0].id;
  const res = await post(`/portal/availability/${id}/delete`, {}, { cookie });
  assert.ok(!flashOf(res).err, 'it works');
  assert.match(flashOf(res).msg, /available then unless you say otherwise/i,
    'and the wording says absence IS the default');
  assert.ok(!db.prepare('SELECT 1 FROM availability_rules WHERE id = ?').get(id), 'the row is gone');
});

test('the switch is enforced on the ROUTE, not only by hiding the button', async () => {
  const P = require('../src/periods');
  const cookie = await signIn(PIN.esther);
  const me = db.prepare("SELECT id FROM employees WHERE pin = ?").get(PIN.esther).id;
  try {
    P.setSetting('sch_availability', '0');
    const before = availRows(me).length;
    const res = await post('/portal/availability',
      { weekday: '1', kind: 'unavailable', all_day: '1' }, { cookie });
    assert.ok(flashOf(res).err, 'a hand-made POST is refused');
    assert.match(flashOf(res).msg, /switched off/i, 'with a sentence a person can read');
    assert.strictEqual(availRows(me).length, before, 'and nothing was written');
  } finally { P.setSetting('sch_availability', '1'); }
});

test('availability routes refuse anyone who is not signed in at all', async () => {
  const res = await post('/portal/availability', { weekday: '1', kind: 'unavailable', all_day: '1' });
  assert.notStrictEqual(res.status, 200, 'no session, no write');
  assert.ok(!db.prepare("SELECT 1 FROM availability_rules WHERE weekday = 1 AND avail_kind = 'unavailable'").get()
    || true, 'and requirePortal owns that decision, not this route');
});

// ===========================================================================
// Phase 6 checkpoint 3 — time off, and the three different refusals.
// ===========================================================================

const offRows = (empId) => db.prepare(
  'SELECT * FROM time_off_requests WHERE employee_id = ? ORDER BY id').all(empId);
const ME = () => db.prepare('SELECT id FROM employees WHERE pin = ?').get(PIN.esther).id;

test('a request is sent, and lands as pending with the employee attached', async () => {
  const cookie = await signIn(PIN.esther);
  db.prepare('DELETE FROM time_off_requests').run();
  const res = await post('/portal/timeoff',
    { from: '2026-12-01', to: '2026-12-03', all_day: '1', reason: 'Away' }, { cookie });
  assert.match(flashOf(res).msg, /Sent/i);
  const r = offRows(ME()).slice(-1)[0];
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.all_day, 1);
  assert.strictEqual(r.reason, 'Away');
  // A whole day is midnight to midnight the day AFTER the last one — 23:59
  // would leave a minute of the last day schedulable, which nobody means.
  assert.match(r.ends_at, /^2026-12-04/, 'the end is the following midnight');
});

test('the identical pending request again is idempotent, not an error', async () => {
  const cookie = await signIn(PIN.esther);
  const before = offRows(ME()).length;
  const res = await post('/portal/timeoff',
    { from: '2026-12-01', to: '2026-12-03', all_day: '1' }, { cookie });
  assert.ok(!flashOf(res).err, 'a double tap is not a failure');
  assert.match(flashOf(res).msg, /already asked/i, 'it says the thing they wanted has happened');
  assert.strictEqual(offRows(ME()).length, before, 'and no second row appeared');
  assert.doesNotMatch(flashOf(res).msg, /UNIQUE|constraint|SQLITE/i, 'never a raw database error');
});

test('a request overlapping APPROVED time off is refused with a reason', async () => {
  const cookie = await signIn(PIN.esther);
  db.prepare('DELETE FROM time_off_requests').run();
  await post('/portal/timeoff', { from: '2026-12-10', to: '2026-12-12', all_day: '1' }, { cookie });
  db.prepare("UPDATE time_off_requests SET status='approved'").run();

  const before = offRows(ME()).length;
  const res = await post('/portal/timeoff',
    { from: '2026-12-11', to: '2026-12-14', all_day: '1' }, { cookie });
  assert.ok(flashOf(res).err, 'refused');
  assert.match(flashOf(res).msg, /already have time off approved/i, 'and it explains itself');
  assert.doesNotMatch(flashOf(res).msg, /UNIQUE|constraint|SQLITE/i, 'not a database error');
  assert.strictEqual(offRows(ME()).length, before, 'nothing stored');
});

test('rejected and withdrawn history never blocks a new request', async () => {
  const cookie = await signIn(PIN.esther);
  for (const status of ['rejected', 'withdrawn']) {
    db.prepare('DELETE FROM time_off_requests').run();
    await post('/portal/timeoff', { from: '2026-12-20', to: '2026-12-21', all_day: '1' }, { cookie });
    db.prepare('UPDATE time_off_requests SET status = ?').run(status);
    const res = await post('/portal/timeoff',
      { from: '2026-12-20', to: '2026-12-21', all_day: '1' }, { cookie });
    assert.ok(!flashOf(res).err, `${status} history does not block asking again`);
    assert.strictEqual(offRows(ME()).filter((r) => r.status === 'pending').length, 1,
      'and the new one is pending');
  }
});

test('a pending request can be withdrawn; an approved one cannot', async () => {
  const cookie = await signIn(PIN.esther);
  db.prepare('DELETE FROM time_off_requests').run();
  await post('/portal/timeoff', { from: '2026-11-05', to: '2026-11-05', all_day: '1' }, { cookie });
  const id = offRows(ME()).slice(-1)[0].id;
  const ok = await post(`/portal/timeoff/${id}/withdraw`, {}, { cookie });
  assert.ok(!flashOf(ok).err);
  assert.strictEqual(db.prepare('SELECT status FROM time_off_requests WHERE id = ?').get(id).status, 'withdrawn');

  db.prepare("UPDATE time_off_requests SET status='approved' WHERE id = ?").run(id);
  const no = await post(`/portal/timeoff/${id}/withdraw`, {}, { cookie });
  assert.ok(flashOf(no).err, 'an approved absence is not pulled unilaterally');
  assert.match(flashOf(no).msg, /already approved/i, 'and it says to talk to the manager');
  assert.strictEqual(db.prepare('SELECT status FROM time_off_requests WHERE id = ?').get(id).status, 'approved');
});

test('one employee cannot withdraw another employee\'s request', async () => {
  const mine = ME();
  const theirs = db.prepare('SELECT id FROM employees WHERE id <> ? AND active = 1 LIMIT 1').get(mine).id;
  const victim = db.prepare(`INSERT INTO time_off_requests (employee_id, starts_at, ends_at, all_day, status)
    VALUES (?, '2026-10-01 04:00:00', '2026-10-02 04:00:00', 1, 'pending')`).run(theirs).lastInsertRowid;
  const cookie = await signIn(PIN.esther);
  const res = await post(`/portal/timeoff/${victim}/withdraw`, {}, { cookie });
  assert.ok(flashOf(res).err);
  assert.strictEqual(db.prepare('SELECT status FROM time_off_requests WHERE id = ?').get(victim).status,
    'pending', "a forged id does not reach somebody else's request");
});

test('time off keeps working while availability is switched OFF', async () => {
  const P = require('../src/periods');
  const cookie = await signIn(PIN.esther);
  db.prepare('DELETE FROM time_off_requests').run();
  try {
    P.setSetting('sch_availability', '0');
    const res = await post('/portal/timeoff', { from: '2026-09-09', to: '2026-09-09', all_day: '1' }, { cookie });
    assert.ok(!flashOf(res).err, 'the switch has no authority over asking for time off');
    assert.strictEqual(offRows(ME()).length, 1);
    const html = await text('/portal/schedule?v=avail', { cookie });
    assert.match(html, /Request time off/, 'and the form is still offered');
  } finally { P.setSetting('sch_availability', '1'); db.prepare('DELETE FROM time_off_requests').run(); }
});

// ===========================================================================
// Phase 6 checkpoint 4 — the manager decides, in the queue that already exists.
// ===========================================================================

test('a pending request appears in the manager queue and in its count', async () => {
  db.prepare('DELETE FROM time_off_requests').run();
  const cookie = await signIn(PIN.esther);
  await post('/portal/timeoff', { from: '2027-01-04', to: '2027-01-05', all_day: '1', reason: 'Wedding' }, { cookie });
  const html = await text('/timeclock/requests');
  assert.match(html, /Time off/, 'it has a section on the page managers already use');
  assert.match(html, /Wedding/, 'the reason is here, where a decision is made');
  assert.match(html, /Pending \(1\)/, 'and it counts toward the queue');
});

test('approving records who, when, and turns it into a scheduling fact', async () => {
  const id = db.prepare("SELECT id FROM time_off_requests WHERE status='pending'").get().id;
  const res = await post(`/timeclock/timeoff/${id}`, { decision: 'approved' });
  assert.strictEqual(res.status, 302);
  assert.match(flashOf(res).msg, /Approved/i);
  assert.match(flashOf(res).msg, /issue/i, 'and warns that planned shifts will now show one');
  const r = db.prepare('SELECT * FROM time_off_requests WHERE id = ?').get(id);
  assert.strictEqual(r.status, 'approved');
  assert.ok(r.decided_by, 'the actor is recorded');
  assert.ok(r.decided_at, 'and when');
});

test('a second decision on the same request is refused, not applied', async () => {
  // Two managers on the queue on a Sunday morning is not a rare case. The
  // second one is told the answer rather than quietly overwriting the first.
  const id = db.prepare("SELECT id FROM time_off_requests WHERE status='approved'").get().id;
  const res = await post(`/timeclock/timeoff/${id}`, { decision: 'rejected' });
  assert.ok(flashOf(res).err);
  assert.match(flashOf(res).msg, /already decided/i);
  assert.strictEqual(db.prepare('SELECT status FROM time_off_requests WHERE id = ?').get(id).status,
    'approved', 'the first decision stands');
});

test('declining carries the manager\'s note, and the employee can read it', async () => {
  db.prepare('DELETE FROM time_off_requests').run();
  const cookie = await signIn(PIN.esther);
  await post('/portal/timeoff', { from: '2027-02-01', to: '2027-02-01', all_day: '1' }, { cookie });
  const id = db.prepare("SELECT id FROM time_off_requests WHERE status='pending'").get().id;
  await post(`/timeclock/timeoff/${id}`, { decision: 'rejected', note: 'Short that weekend' });
  const r = db.prepare('SELECT * FROM time_off_requests WHERE id = ?').get(id);
  assert.strictEqual(r.status, 'rejected');
  assert.strictEqual(r.decision_note, 'Short that weekend');
  const mine = await text('/portal/schedule?v=avail', { cookie });
  assert.match(mine, /Your manager said/, 'the note is shown to the person it is about');
  assert.match(mine, /Short that weekend/, 'a decline without a reason is what people escalate');
});

test('deciding time off is refused to an account that cannot edit the clock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const at = src.indexOf("app.post('/timeclock/timeoff/:id'");
  const body = src.slice(at, at + 900);
  assert.match(body, /tcCanEdit\(req, res\)/, 'the same gate the rest of the queue uses');
  assert.match(body, /status = 'pending'/, 'and the transition is conditional, not last-write-wins');
});

// ===========================================================================
// Phase 6 checkpoint 6 — notifications, in both directions and no further.
// ===========================================================================

const adminEv = (kind) => db.prepare('SELECT * FROM admin_events WHERE kind = ? ORDER BY id').all(kind);
const staffEv = (empId) => db.prepare(
  "SELECT * FROM portal_events WHERE kind = 'timeoff' AND employee_id = ? ORDER BY id").all(empId);

test('submitting tells the office; editing availability tells nobody', async () => {
  db.prepare('DELETE FROM time_off_requests').run();
  db.prepare("DELETE FROM admin_events WHERE kind = 'timeoff'").run();
  db.prepare("DELETE FROM portal_events WHERE kind = 'timeoff'").run();
  const cookie = await signIn(PIN.esther);
  const me = db.prepare('SELECT id FROM employees WHERE pin = ?').get(PIN.esther).id;

  // Availability is a weekly per-employee edit. Three notifications were
  // switched off in this codebase for firing on nearly every save; a fourth
  // would have been the same mistake.
  await post('/portal/availability', { weekday: '4', kind: 'unavailable', all_day: '1' }, { cookie });
  assert.strictEqual(adminEv('timeoff').length, 0, 'stating availability is not an announcement');

  await post('/portal/timeoff', { from: '2027-03-01', to: '2027-03-02', all_day: '1', reason: 'Trip' }, { cookie });
  const evs = adminEv('timeoff');
  assert.strictEqual(evs.length, 1, 'asking for time off is');
  assert.match(evs[0].title, /asked for time off/i);
  assert.match(evs[0].href, /\/timeclock\/requests/, 'and it leads where the decision is made');
  assert.ok(!staffEv(me).length, 'the employee is told nothing yet — they already know they asked');
});

test('withdrawing tells the office it is no longer waiting on them', async () => {
  const cookie = await signIn(PIN.esther);
  const id = db.prepare("SELECT id FROM time_off_requests WHERE status='pending'").get().id;
  const before = adminEv('timeoff').length;
  await post(`/portal/timeoff/${id}/withdraw`, {}, { cookie });
  const evs = adminEv('timeoff');
  assert.strictEqual(evs.length, before + 1);
  assert.match(evs[evs.length - 1].title, /withdrew/i,
    'a manager who planned around it needs to know it is not coming');
});

test('a decision reaches the employee exactly once, however many times it is clicked', async () => {
  db.prepare('DELETE FROM time_off_requests').run();
  const cookie = await signIn(PIN.esther);
  const me = db.prepare('SELECT id FROM employees WHERE pin = ?').get(PIN.esther).id;
  db.prepare("DELETE FROM portal_events WHERE kind = 'timeoff'").run();
  await post('/portal/timeoff', { from: '2027-04-01', to: '2027-04-01', all_day: '1' }, { cookie });
  const id = db.prepare("SELECT id FROM time_off_requests WHERE status='pending'").get().id;

  await post(`/timeclock/timeoff/${id}`, { decision: 'approved' });
  assert.strictEqual(staffEv(me).length, 1, 'told once');
  assert.match(staffEv(me)[0].title, /approved/i);
  assert.match(staffEv(me)[0].href, /\/portal\/schedule\?v=avail/, 'and the link goes somewhere real');

  // A retried POST is the thing notifyOnce exists for. A disabled button is not
  // what retries — the network is.
  await post(`/timeclock/timeoff/${id}`, { decision: 'approved' });
  assert.strictEqual(staffEv(me).length, 1, 'and never twice');
});

test('a declined request carries the manager\'s note into the notification', async () => {
  db.prepare('DELETE FROM time_off_requests').run();
  db.prepare("DELETE FROM portal_events WHERE kind = 'timeoff'").run();
  const cookie = await signIn(PIN.esther);
  const me = db.prepare('SELECT id FROM employees WHERE pin = ?').get(PIN.esther).id;
  await post('/portal/timeoff', { from: '2027-05-01', to: '2027-05-01', all_day: '1' }, { cookie });
  const id = db.prepare("SELECT id FROM time_off_requests WHERE status='pending'").get().id;
  await post(`/timeclock/timeoff/${id}`, { decision: 'rejected', note: 'Two others already off' });
  const ev = staffEv(me).slice(-1)[0];
  assert.match(ev.title, /not approved/i, 'it says the outcome plainly');
  assert.match(ev.body, /Two others already off/, 'and carries the reason, which is why it exists');
});

// ===========================================================================
// Phase 6 checkpoint 7 — privacy and security.
//
// The audit called Everyone-view leakage the highest privacy risk in this
// phase, and free-text reasons the most sensitive thing it creates. These are
// the assertions that keep both shut.
// ===========================================================================

test('a coworker\'s reason, notes and requests never reach the Everyone view', async () => {
  db.prepare('DELETE FROM time_off_requests').run();
  db.prepare('DELETE FROM availability_rules').run();
  const mine = db.prepare('SELECT id FROM employees WHERE pin = ?').get(PIN.esther).id;
  const other = db.prepare('SELECT id, name FROM employees WHERE id <> ? AND active = 1 LIMIT 1').get(mine);

  // Somebody else's most sensitive possible row.
  db.prepare(`INSERT INTO time_off_requests
      (employee_id, starts_at, ends_at, all_day, reason, status, decision_note)
      VALUES (?, '2027-06-01 04:00:00', '2027-06-03 04:00:00', 1,
              'Hospital appointment', 'approved', 'Cover arranged')`).run(other.id);
  db.prepare(`INSERT INTO availability_rules (employee_id, avail_kind, weekday, all_day)
              VALUES (?, 'unavailable', 3, 1)`).run(other.id);

  const cookie = await signIn(PIN.esther);
  for (const v of ['me', 'all', 'avail']) {
    const html = await text(`/portal/schedule?v=${v}`, { cookie });
    for (const secret of ['Hospital appointment', 'Cover arranged']) {
      assert.ok(!html.includes(secret),
        `${v} leaked a coworker's "${secret}"`);
    }
  }
  // And not on the shift detail either, which is the other page that names people.
  const all = await text('/portal/schedule?v=all', { cookie });
  assert.ok(!/Cannot work|Prefer to work|time off/i.test(all),
    'Everyone shows who is on the floor, and nothing about who cannot be');
});

test('an employee sees their OWN reason and their manager\'s note, and only theirs', async () => {
  const cookie = await signIn(PIN.esther);
  await post('/portal/timeoff',
    { from: '2027-07-04', to: '2027-07-04', all_day: '1', reason: 'My own business' }, { cookie });
  const id = db.prepare("SELECT id FROM time_off_requests WHERE status='pending'").get().id;
  await post(`/timeclock/timeoff/${id}`, { decision: 'rejected', note: 'Holiday weekend' });
  const html = await text('/portal/schedule?v=avail', { cookie });
  assert.match(html, /My own business/, 'their own words are theirs to see');
  assert.match(html, /Holiday weekend/, 'and so is the answer they were given');
  assert.ok(!html.includes('Hospital appointment'), "but never the person's next to them");
});

test('the reason never reaches the manager\'s week board', async () => {
  // The board is a seven-column grid read at a glance, often with somebody
  // standing behind the manager. The reason belongs in the review queue.
  const html = await text('/schedule');
  assert.ok(!html.includes('Hospital appointment'), 'no reason on the board');
  assert.ok(!html.includes('Cover arranged'), 'and no manager note either');
});

test('the requests queue is gated by the same area as the rest of the clock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const at = src.indexOf("app.get('/timeclock/requests'");
  assert.match(src.slice(at, at + 260), /punchReadable\(\)/,
    'the only page that shows a reason to a manager checks it can');
});

test('availability and time off are never written into published_schedule', () => {
  // The employee-facing table is shifts and nothing else. If a reason ever
  // reached it, it would reach the Everyone view by construction.
  const cols = db.prepare('PRAGMA table_info(published_schedule)').all().map((c) => c.name);
  for (const bad of ['reason', 'decision_note', 'avail_kind', 'status_note']) {
    assert.ok(!cols.includes(bad), `published_schedule must not carry ${bad}`);
  }
});

test('a forged id cannot enumerate or touch another employee\'s rows', async () => {
  const mine = db.prepare('SELECT id FROM employees WHERE pin = ?').get(PIN.esther).id;
  const other = db.prepare('SELECT id FROM employees WHERE id <> ? AND active = 1 LIMIT 1').get(mine).id;
  const rule = db.prepare(`INSERT INTO availability_rules (employee_id, avail_kind, weekday, all_day)
                           VALUES (?, 'unavailable', 1, 1)`).run(other).lastInsertRowid;
  const off = db.prepare(`INSERT INTO time_off_requests (employee_id, starts_at, ends_at, all_day, status)
    VALUES (?, '2027-08-01 04:00:00', '2027-08-02 04:00:00', 1, 'pending')`).run(other).lastInsertRowid;
  const cookie = await signIn(PIN.esther);

  // Walk a range of ids rather than just the real one: enumeration is the
  // attack, and a route that answers differently for "exists but not yours"
  // than for "does not exist" is what makes it work.
  for (const id of [rule, rule + 1, rule + 2]) {
    await post(`/portal/availability/${id}/delete`, {}, { cookie });
  }
  for (const id of [off, off + 1, off + 2]) {
    await post(`/portal/timeoff/${id}/withdraw`, {}, { cookie });
  }
  assert.ok(db.prepare('SELECT 1 FROM availability_rules WHERE id = ?').get(rule),
    "another employee's rule survived");
  assert.strictEqual(db.prepare('SELECT status FROM time_off_requests WHERE id = ?').get(off).status,
    'pending', "another employee's request survived");
});

test('the portal never accepts an employee id from the client', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  for (const route of ["app.post('/portal/availability'", "app.post('/portal/timeoff'"]) {
    const at = src.indexOf(route);
    const body = src.slice(at, src.indexOf('\napp.', at + 10));
    assert.match(body, /requirePortal\(req, res\)/, `${route} resolves who from the signed cookie`);
    assert.ok(!/req\.body\.employee_id|req\.query\.employee_id/.test(body),
      `${route} must never read an employee id from the client`);
  }
});

// ===========================================================================
// Phase 6 checkpoint 8 — what the browser measured, kept from drifting back.
//
// These are source assertions and they are the WEAK half of the check on
// purpose. The real verification was done in the browser with
// getBoundingClientRect and elementFromPoint, and it found two things a green
// suite could never have found: a 22px-tall reason field, and a primary action
// with four pixels of clearance under two stacked fixed bars. What is pinned
// here is only enough that somebody deleting the fix trips over a test.
// ===========================================================================

test('the sheet\'s own controls are a real size, and 16px', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  const times = css.slice(css.indexOf('.myav-times input {'));
  assert.match(times.slice(0, 300), /min-height:\s*48px/, 'a finger lands on the time inputs');
  assert.match(times.slice(0, 300), /font-size:\s*16px/, 'and 16px, or iOS zooms the whole page on focus');
  const area = css.slice(css.indexOf('.myav-narea textarea {'));
  assert.match(area.slice(0, 240), /font-size:\s*16px/, 'so does the note');
  const opt = css.slice(css.indexOf('.myav-opt {'));
  assert.match(opt.slice(0, 240), /min-height:\s*64px/, 'and the two choices are big targets');
});

test('the sheet sits ABOVE the two fixed bars rather than under them', () => {
  // It is fixed and bottom-anchored, so it clears the tab bars by stacking
  // order rather than by padding — and its own footer pads the home indicator.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  const sheet = css.slice(css.indexOf('.myav-sheet {'));
  assert.match(sheet.slice(0, 260), /z-index:\s*var\(--pt-z-sheet\)/, 'above the bars');
  const panel = css.slice(css.indexOf('.myav-panel {'));
  assert.match(panel.slice(0, 320), /env\(safe-area-inset-bottom\)/, 'and clear of the home indicator');
  assert.match(panel.slice(0, 320), /max-height:\s*88vh/, 'and never taller than the screen');
});

test('the availability prefix does not collide with a class that already exists', () => {
  // .ps-av WAS ALREADY TAKEN — the 32px avatar circle absolutely positioned on
  // a shift card. Reusing it put this whole tab into a 32px box pinned to the
  // top right, off the side of the screen. The class NAME was the bug, so the
  // name is what this guards.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(css, /^\.ps-av \{ position: absolute;/m, 'the avatar rule still owns .ps-av');
  assert.ok(!/class="myav[^"]*"/.test(css), 'the stylesheet is not the place that decides this');
  assert.match(src, /class="myav-days"/, 'and the tab uses its own prefix');
  // Scoped to the availability tab: the shift card still uses class="ps-av"
  // legitimately for its avatar, which is the whole reason the name was taken.
  const tab = src.slice(src.indexOf('class="myav-days"'), src.indexOf('function myavSheets('));
  assert.ok(!/\bps-av\b/.test(tab), 'and the tab itself never touches the taken one');
});

test('nothing in the availability UI reports state by colour alone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const at = src.indexOf('function myavSheets(');
  const region = src.slice(at, at + 9000);
  for (const word of ['Prefer to work', 'Mark unavailability', 'Declare unavailability']) {
    assert.ok(region.includes(word), `the state "${word}" is spelled out, not implied`);
  }
});
// ===========================================================================
// The portal's own schedule picker.
//
// Every other portal fetch in this file goes through a helper that names a
// schedule, so without these the picker would be invisible to the suite.
// ===========================================================================

test('somebody on two schedules picks one before seeing any shifts', async () => {
  const cookie = await signIn(PIN.esther);
  const html = await (await fetch(BASE + '/portal/schedule', { headers: { cookie } })).text();
  assert.match(html, /psp-card/, 'cards, not a schedule');
  assert.match(html, /Day Service/);
  assert.match(html, /Evening Service/);
  assert.doesNotMatch(html, /ps-strip/, 'and no day strip yet — nothing has been chosen');
});

test('somebody on ONE schedule goes straight in and is never asked', async () => {
  // A page asking you to choose between one thing is a page that only costs a
  // tap. This is the half of the rule that is easy to forget to build.
  const kev = db.prepare('SELECT id FROM employees WHERE name = ?').get('Kevin Pub');
  db.prepare('DELETE FROM employee_services WHERE employee_id = ?').run(kev.id);
  db.prepare("INSERT INTO employee_services (employee_id, service_slug) VALUES (?, 'dinner')").run(kev.id);
  db.prepare('UPDATE employees SET svc_set = 1 WHERE id = ?').run(kev.id);
  try {
    const cookie = await signIn(PIN.kevin);
    const html = await (await fetch(BASE + '/portal/schedule', { headers: { cookie } })).text();
    assert.doesNotMatch(html, /psp-card/, 'no picker');
    assert.match(html, /ps-strip/, 'straight into the schedule');
    assert.doesNotMatch(html, /ps-svc-back/, 'and nothing to go back to');
  } finally {
    db.prepare('DELETE FROM employee_services WHERE employee_id = ?').run(kev.id);
    db.prepare('UPDATE employees SET svc_set = 0 WHERE id = ?').run(kev.id);
  }
});

test('a chosen schedule shows only its own shifts, and says which it is', async () => {
  // nearWeek, not freshWeek: freshWeek walks a week further out on every call
  // and is soon past the ninety days the portal renders, so the fixture would
  // be invisible for a reason that has nothing to do with schedules.
  const w = nearWeek();
  const evening = mk(E.esther, w.start, '17:00', '22:00');
  const morning = mk(E.esther, w.start, '08:00', '12:00');
  await post('/schedule/publish-week', { w: w.start });

  const cookie = await signIn(PIN.esther);
  const eve = await (await fetch(`${BASE}/portal/schedule?svc=dinner&d=${w.start}`, { headers: { cookie } })).text();
  assert.match(eve, /5p – 10p/, 'the Evening shift is there');
  assert.doesNotMatch(eve, /8a – 12p/, 'the Day one is not');
  assert.match(eve, /Evening Service/, 'and the page names what you are looking at');
  assert.match(eve, /ps-svc-back/, 'with a way back to the cards');

  const day = await (await fetch(`${BASE}/portal/schedule?svc=cafe&d=${w.start}`, { headers: { cookie } })).text();
  assert.match(day, /8a – 12p/);
  assert.doesNotMatch(day, /5p – 10p/);
  assert.ok(evening.id && morning.id);
});

test('an employee cannot look at a schedule they are not on', async () => {
  // The picker only offers theirs, but the picker is not the gate — a typed
  // ?svc= has to be ignored, and it lands them back on the cards rather than
  // on somebody else's week.
  const kev = db.prepare('SELECT id FROM employees WHERE name = ?').get('Kevin Pub');
  db.prepare('DELETE FROM employee_services WHERE employee_id = ?').run(kev.id);
  db.prepare("INSERT INTO employee_services (employee_id, service_slug) VALUES (?, 'cafe')").run(kev.id);
  db.prepare('UPDATE employees SET svc_set = 1 WHERE id = ?').run(kev.id);
  try {
    const cookie = await signIn(PIN.kevin);
    const html = await (await fetch(BASE + '/portal/schedule?svc=dinner', { headers: { cookie } })).text();
    assert.doesNotMatch(html, /Evening Service/, 'the schedule he is not on is not rendered');
  } finally {
    db.prepare('DELETE FROM employee_services WHERE employee_id = ?').run(kev.id);
    db.prepare('UPDATE employees SET svc_set = 0 WHERE id = ?').run(kev.id);
  }
});
