'use strict';

// REOPENING A SENT SERVICE.
//
// "I just want to be able to reopen it on services and make my changes right
// there if I need." A sent service is one people have been paid from, so opening
// it again has to be a status change and nothing more: no recalculation, no
// quiet move onto a newer policy, nobody emailed. Everything that follows is a
// decision the owner makes on the page — correct a figure, move the night onto
// the current policy, send it again or close it without emailing anyone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-reopen-'));
process.env.DB_PATH = path.join(dir, 'reopen.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';
process.env.APP_PASSWORD = '';

const { db } = require('../src/db');
const P = require('../src/policy');
require('../src/services');
require('../src/portal');

const PORT = 4012;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

const EVENING = [
  { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'bartender', percent: 9, base: 'alcohol', split: 'hours', paidBy: ['server'] },
  { type: 'share', role: 'bartender', split: 'hours' },
];

const row = (id) => db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
const post = (p, body = {}) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const msgOf = (res) => decodeURIComponent(res.headers.get('location') || '');

/** A night that went out on a schedule with no policy of its own — Evening's story. */
function sentOnDefaults(date) {
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status, sent_fingerprint)
    VALUES (?, 'late-bar', 'emailed', 'as-sent')`).run(date).lastInsertRowid);
  const emp = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
    VALUES (?, 'server', 900, 1)`).run(`Server ${date}`).lastInsertRowid);
  db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,6)').run(sh, emp, 'server');
  db.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents,
    card_tips_cents, cash_tips_cents) VALUES (?,?,100000,0,20000,15000,0)`).run(sh, emp);
  return { sh, emp };
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
test.after(() => { if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('reopening opens the service and does nothing else', async () => {
  const { sh } = sentOnDefaults('2026-09-12');
  const events = () => db.prepare('SELECT COUNT(*) n FROM portal_events').get().n;
  const before = events();

  const res = await post(`/shifts/${sh}/reopen`);
  assert.strictEqual(res.status, 302);
  assert.match(msgOf(res), /Reopened/);
  const r = row(sh);
  assert.strictEqual(r.status, 'open', 'open again');
  assert.ok(r.reopened_at, 'and it says when');
  assert.strictEqual(r.sent_fingerprint, 'as-sent', 'what was sent is still on record');
  assert.strictEqual(r.policy_id, null, 'no policy stamped on the way past');
  assert.strictEqual(events(), before, 'and nobody was notified of anything');
  assert.strictEqual(P.adjustmentsLocked(r), false, 'the one-off overrides are open to it again');
});

test('a night that went out on the defaults stays on them while it is open again', async () => {
  // The owner writes the policy that should always have been there, then opens
  // an old night to fix one server's tips. The tips get fixed; the whole night
  // must not quietly re-price itself on rules that did not exist when it ran.
  const { sh } = sentOnDefaults('2026-09-13');
  db.prepare("INSERT INTO policy_versions (daypart, rules_json, note) VALUES ('late-bar', ?, 'written later')")
    .run(JSON.stringify(EVENING));
  await post(`/shifts/${sh}/reopen`);

  const rules = P.policyForShift(row(sh));
  assert.deepStrictEqual(rules, require('../src/engine').defaultRules(), 'still the defaults');
  assert.strictEqual(row(sh).policy_id, null, 'and still unstamped');

  const page = await (await fetch(`${BASE}/shifts/${sh}`)).text();
  assert.match(page, /REOPENED/, 'the page says it is reopened');
  assert.match(page, /built-in default rules/, 'and what it is worked out on');
  assert.match(page, /Use the current [^<]* policy/, 'with the button to change that on purpose');
});

test('moving it onto the current policy is one deliberate button', async () => {
  const { sh } = sentOnDefaults('2026-09-14');
  const refused = await post(`/shifts/${sh}/use-current-policy`);
  assert.match(msgOf(refused), /Reopen the service first/, 'not on a service that is still sent');
  assert.strictEqual(row(sh).policy_id, null);

  await post(`/shifts/${sh}/reopen`);
  const moved = await post(`/shifts/${sh}/use-current-policy`);
  assert.match(msgOf(moved), /now worked out on the current/);
  const cur = P.currentForDaypart('late-bar');
  assert.strictEqual(row(sh).policy_id, cur.id, 'stamped with the policy in force');
  assert.ok(P.policyForShift(row(sh)).some((r) => r.type === 'share'), 'and priced by it');
});

test('closing it again emails nobody and says the emails are out of date', async () => {
  const { sh, emp } = sentOnDefaults('2026-09-15');
  await post(`/shifts/${sh}/reopen`);
  // The correction the owner came to make.
  db.prepare('UPDATE server_sales SET card_tips_cents = 16000 WHERE shift_id = ? AND employee_id = ?').run(sh, emp);
  const events = db.prepare('SELECT COUNT(*) n FROM portal_events').get().n;

  const res = await post(`/shifts/${sh}/close`);
  assert.strictEqual(row(sh).status, 'emailed', 'sent again, as far as the books go');
  assert.match(msgOf(res), /Closed without emailing/);
  assert.match(msgOf(res), /still show the figures from before/, 'and honest about the emails');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM portal_events').get().n, events, 'nobody notified');
  assert.strictEqual(row(sh).sent_fingerprint, 'as-sent', 'the record of what was sent is untouched');
  const w = db.prepare('SELECT settled_rate_cents FROM work WHERE shift_id = ? AND employee_id = ?').get(sh, emp);
  assert.strictEqual(w.settled_rate_cents, 900, 'and settled, as a send would have');
});

test('the service page offers Reopen on a sent service, and its dialog opens', async () => {
  const { sh } = sentOnDefaults('2026-09-16');
  const page = await (await fetch(`${BASE}/shifts/${sh}`)).text();
  assert.match(page, /Reopen this service/);
  // The dialog text crosses a line break. Written as a raw newline inside the
  // quoted string, the browser refuses to compile the handler and the button
  // submits with no question asked. It has to reach the page as backslash-n.
  const handler = (page.match(/action="\/shifts\/\d+\/reopen"\s+onsubmit="([^"]*)"/) || [])[1] || '';
  assert.ok(handler.includes('\\n\\n'), 'the line break is escaped');
  assert.ok(!/\n/.test(handler), 'with no raw newline inside the string');
});

test('every "are you sure" on the policy page actually asks', async () => {
  // Two of them had a raw line break inside the quoted question — "Make this
  // live" and "Move them onto the current policy", the two buttons a policy
  // change turns on. The browser refused to compile the handler, so each button
  // went straight through with no question asked. Every inline handler on the
  // page has to compile.
  const cur = P.currentForDaypart('dinner');
  const open = Number(db.prepare(`INSERT INTO shifts (date, daypart, status, policy_id)
    VALUES ('2099-06-01', 'dinner', 'open', ?)`).run(cur.id).lastInsertRowid);
  P.saveRules('dinner', cur.rules, 'a newer one, so the open service is on an earlier policy');
  assert.ok(P.stagedForDaypart('dinner') || P.stageRules('dinner', cur.rules, 'a draft to turn on'));

  const html = await (await fetch(`${BASE}/policy?daypart=dinner`)).text();
  const decode = (x) => x.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const handlers = [...html.matchAll(/on(?:submit|click)="([^"]*)"/g)].map((m) => decode(m[1]));
  assert.ok(handlers.some((h) => /Make this the/.test(h)), 'the make-live question is on the page');
  assert.ok(handlers.some((h) => /onto the current policy\?/.test(h)), 'and the move question');
  for (const h of handlers) {
    assert.doesNotThrow(() => new Function(h), `compiles: ${h.slice(0, 60)}`);
  }
  db.prepare('DELETE FROM shifts WHERE id = ?').run(open);
});

// ===========================================================================
// FINISHING A SERVICE WITHOUT TELLING ANYBODY
//
// "I want to send out a bunch of services I've had open for a while silently
// without giving a bunch of notifications, and turn it on when there's like one
// left." Sending a service emails everybody on it and puts "your pay is ready"
// on each of their phones; doing that to a fortnight of nights at once is the
// burst this avoids. The quiet finish existed already for a service that had
// been sent and reopened — these are the same move on a night that never went
// out at all, and the backlog version of it.
// ===========================================================================

/** A night nobody has ever been told about: people, hours, figures, not sent. */
function readyNeverSent(date, daypart = 'late-bar') {
  const sh = Number(db.prepare('INSERT INTO shifts (date, daypart, status) VALUES (?, ?, ?)')
    .run(date, daypart, 'open').lastInsertRowid);
  const emp = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
    VALUES (?, 'server', 1100, 1)`).run(`Quiet ${date}`).lastInsertRowid);
  db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,6)').run(sh, emp, 'server');
  db.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents,
    card_tips_cents, cash_tips_cents) VALUES (?,?,80000,0,10000,12000,0)`).run(sh, emp);
  return { sh, emp };
}
const events = () => db.prepare('SELECT COUNT(*) n FROM portal_events').get().n;

test('a night that never went out can be finished without emailing anyone', async () => {
  const { sh, emp } = readyNeverSent('2026-09-17');
  const before = events();

  const res = await post(`/shifts/${sh}/close`);
  assert.strictEqual(res.status, 302);
  assert.match(msgOf(res), /Finished without emailing/);
  assert.match(msgOf(res), /Nobody was told/);

  const r = row(sh);
  assert.strictEqual(r.status, 'emailed', 'finished, as every count and payroll read means it');
  assert.strictEqual(r.finished_quietly, 1, 'and marked as one nobody was emailed about');
  assert.strictEqual(events(), before, 'nobody was notified');
  assert.ok(r.sent_fingerprint, 'the figures are fingerprinted, so a later edit still shows up');
  const w = db.prepare('SELECT settled_rate_cents FROM work WHERE shift_id = ? AND employee_id = ?').get(sh, emp);
  assert.strictEqual(w.settled_rate_cents, 1100, 'and settled, exactly as a send settles it');
});

test('the page says Finished, never that emails went out', async () => {
  const { sh } = readyNeverSent('2026-09-18');
  await post(`/shifts/${sh}/close`);
  const page = await (await fetch(`${BASE}/shifts/${sh}`)).text();
  assert.match(page, /FINISHED · NO EMAILS/, 'the status word is honest');
  assert.doesNotMatch(page, /EMAILS SENT/, 'and never claims an email exists');
  assert.match(page, /Finished without emailing\. Need to correct something\?/, 'the way back in says it too');

  // And once it is changed afterwards, it must not tell the owner that people
  // hold an email showing the old figures. They hold nothing.
  db.prepare('UPDATE server_sales SET card_tips_cents = 20000 WHERE shift_id = ?').run(sh);
  const after = await (await fetch(`${BASE}/shifts/${sh}`)).text();
  assert.match(after, /Nobody has ever been emailed about this service/);
  assert.doesNotMatch(after, /the emails people got show the figures from before/);
});

test('sending it later is still a real send, and the quiet mark goes', async () => {
  const { sh, emp } = readyNeverSent('2026-09-19');
  db.prepare('UPDATE employees SET email = ? WHERE id = ?').run('quiet19@example.com', emp);
  await post(`/shifts/${sh}/close`);
  assert.strictEqual(row(sh).finished_quietly, 1);

  await post(`/shifts/${sh}/reopen`);
  const before = events();
  await post(`/shifts/${sh}/send`);
  const r = row(sh);
  assert.strictEqual(r.status, 'emailed');
  assert.strictEqual(r.finished_quietly, 0, 'it really has been sent now');
  assert.ok(events() > before, 'and this time the people on it were told');
  const page = await (await fetch(`${BASE}/shifts/${sh}`)).text();
  assert.match(page, /EMAILS SENT/, 'the page says so');
});

test('the backlog button finishes the ready ones and leaves the rest alone', async () => {
  const { sh: ready } = readyNeverSent('2026-09-20');
  // Needs review: somebody on it with no hours.
  const { sh: review } = readyNeverSent('2026-09-21');
  const noHours = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
    VALUES ('Quiet nohours', 'busser', 1000, 1)`).run().lastInsertRowid);
  db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,0)').run(review, noHours, 'busser');
  // Today's service, still running.
  const TC = require('../src/timeclock');
  const today = TC.businessDateOf(TC.nowUtc(), TC.settings().cutoffHour);
  const { sh: open } = readyNeverSent(today);
  const before = events();

  const res = await post('/shifts/finish-quiet');
  assert.strictEqual(res.status, 302);
  assert.match(msgOf(res), /finished without emailing/i);
  assert.match(msgOf(res), /left alone/);

  assert.strictEqual(row(ready).status, 'emailed', 'the ready one is finished');
  assert.strictEqual(row(ready).finished_quietly, 1);
  assert.strictEqual(row(review).status, 'open', 'the one missing hours is not touched');
  assert.strictEqual(row(open).status, 'open', 'and neither is tonight');
  assert.strictEqual(events(), before, 'and nobody, anywhere, was notified');
});

test('the Services page offers it only while something is ready, and asks first', async () => {
  const { sh } = readyNeverSent('2026-09-23');
  const page = await (await fetch(`${BASE}/shifts`)).text();
  const form = (page.match(/<form[^>]*action="\/shifts\/finish-quiet"[\s\S]*?<\/form>/) || [''])[0];
  assert.ok(form, 'the button is there while nights are waiting');
  assert.match(form, /name="_csrf"/, 'with its own token, hand-written');
  const handler = (page.match(/action="\/shifts\/finish-quiet"[^>]*onsubmit="([^"]*)"/) || [])[1] || '';
  assert.ok(handler.includes('\\n\\n'), 'the line break in the question is escaped');
  assert.ok(!/\n/.test(handler), 'with no raw newline that would stop it compiling');
  assert.doesNotThrow(() => new Function(handler.replace(/&#39;/g, "'").replace(/&quot;/g, '"')),
    'and the question compiles, so it actually asks');

  // Nothing waiting, nothing offered: a button that finishes nothing is a
  // button somebody presses to find out what it does.
  await post(`/shifts/${sh}/close`);
  const after = await (await fetch(`${BASE}/shifts`)).text();
  assert.doesNotMatch(after, /action="\/shifts\/finish-quiet"/, 'gone once the backlog is clear');
});

test('a sent service is never quietly finished out from under itself', async () => {
  const { sh } = sentOnDefaults('2026-09-22');
  const was = row(sh);
  const res = await post(`/shifts/${sh}/close`);
  assert.strictEqual(res.status, 302);
  const now = row(sh);
  assert.strictEqual(now.status, 'emailed');
  assert.strictEqual(now.finished_quietly, 0, 'it was emailed for real, and still says so');
  assert.strictEqual(now.sent_fingerprint, was.sent_fingerprint, 'and what was sent is untouched');
});
