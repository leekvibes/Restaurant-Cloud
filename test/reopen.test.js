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
