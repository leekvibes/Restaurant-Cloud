'use strict';

// THE BAR IS ONE TILL, NOT TWO PEOPLE.
//
// The owner's rule, in his words: "bartender tips are pooled and then split
// between them. So all the money coming from the servers tip out and there
// direct tips are always pooled and then split."
//
// Half of that was already true. The servers' 9% of alcohol goes into the
// bartender POT, and a role pot has always been split by hours — two bartenders
// on, each gets their share of it. The other half was not: what a guest handed
// across the bar, or tipped on a bar tab, stayed with whoever happened to ring
// it. On a Friday with two behind the bar that is the difference between a fair
// night and an argument, and no policy could say otherwise, because there was
// nothing in the rule vocabulary that could.
//
// So there is now a third kind of rule — `share` — and these are what it means:
//
//   · the crew's kept tips are added up and split by hours worked
//   · cash is pooled SEPARATELY on the same weights, so the paycheck half and
//     the hand-it-over half both stay true
//   · with one bartender on, nothing happens at all
//   · every penny in still leaves as a penny out
//
// And one consequence that matters more than it looks: a policy that says the
// bartenders pool is a policy that says they were KEEPING their tips, which is
// what makes the staff form ask a bartender for their own sales. A bartender
// with no box to type their bar sales into cannot be charged the barback's 3%,
// and that is exactly what happened on the first real evening service.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-pool-'));
process.env.DB_PATH = path.join(dir, 'pool.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';
process.env.APP_PASSWORD = '';

const { runShift } = require('../src/engine');
// The tables these own are created by the modules themselves, not by db.js:
// policy_versions by policy.js, services and employee_services by services.js.
// A test that seeds them without requiring these gets "no such table".
require('../src/policy');
require('../src/services');

// The evening policy as the owner wrote it, with the pooling rule on the end.
const EVENING = [
  { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'bartender', percent: 9, base: 'alcohol', split: 'hours', paidBy: ['server'] },
  { type: 'tipout', recipient: 'barback', percent: 3, base: 'total_sales', split: 'hours', paidBy: ['bartender'] },
  { type: 'share', role: 'bartender', split: 'hours' },
];

const bt = (id, hours, over) => ({ employeeId: id, name: id, role: 'bartender', hours,
  food: 0, coffee: 0, alcohol: 0, cardTips: 0, cashTips: 0, ...over });
const server = (over) => ({ employeeId: 'SV', name: 'Sara', role: 'server', hours: 5,
  food: 2000, coffee: 0, alcohol: 1000, cardTips: 600, cashTips: 0, ...over });

/** One evening: a server, two bartenders on unequal hours, a busser, a barback. */
const night = (rules = EVENING) => runShift({
  servers: [
    server(),
    bt('BT1', 6, { food: 100, alcohol: 900, cardTips: 300, cashTips: 60 }),
    bt('BT2', 3, { alcohol: 500, cardTips: 100 }),
  ],
  support: [
    { employeeId: 'BT1', name: 'BT1', role: 'bartender', hours: 6 },
    { employeeId: 'BT2', name: 'BT2', role: 'bartender', hours: 3 },
    { employeeId: 'BU', name: 'Busser', role: 'busser', hours: 5 },
    { employeeId: 'BB', name: 'Barback', role: 'barback', hours: 6 },
  ],
  pool: {},
}, rules);

const who = (r, id) => r.servers.find((p) => p.employeeId === id);

test('two bartenders: their own kept tips are pooled and split by hours', () => {
  const r = night();
  // What each of them rang and paid out, before the pool:
  //   BT1  $360 in tips, 3% of $1,000 of bar sales = $30 to the barback → $330
  //   BT2  $100 in tips, 3% of   $500             = $15 to the barback → $85
  // $415 between them, 6 hours against 3.
  const a = who(r, 'BT1');
  const b = who(r, 'BT2');
  assert.strictEqual(a.tipsKept + b.tipsKept, 41500, 'the pot is the two of them added up');
  assert.strictEqual(a.tipsKept, 27667, 'two thirds of it, to the penny');
  assert.strictEqual(b.tipsKept, 13833, 'and one third');
  assert.strictEqual(a.pooled.potKept, 41500);
  assert.strictEqual(a.pooled.people, 2);
  assert.strictEqual(a.pooled.split, 'hours');
});

test('cash is pooled on the same weights, and says who owes whom', () => {
  // BT1 was handed $60 in cash and BT2 none. The money is pooled, so $40 of it
  // is BT1's and $20 is BT2's — and BT1 is standing there holding all of it.
  const r = night();
  const a = who(r, 'BT1');
  const b = who(r, 'BT2');
  assert.strictEqual(a.cashTips, 4000, 'their share of the cash');
  assert.strictEqual(b.cashTips, 2000, 'and theirs');
  assert.strictEqual(a.cashTips + b.cashTips, 6000, 'all of it, nothing invented');
  assert.strictEqual(a.pooled.cashRung, 6000, 'what they actually took in');
  assert.strictEqual(a.pooled.cashOwed, 2000, 'so $20 goes across the bar');
  assert.strictEqual(b.pooled.cashOwed, -2000, 'to the one who is owed it');
  assert.strictEqual(a.pooled.cashOwed + b.pooled.cashOwed, 0, 'and it balances');
});

test('the pot from the servers was already split by hours — both halves now are', () => {
  const r = night();
  // 9% of the server's $1,000 of alcohol.
  assert.strictEqual(r.pots.bartender, 9000);
  const share = (id) => r.support.find((p) => p.employeeId === id).tipShare;
  assert.strictEqual(share('BT1'), 6000, 'six hours of nine');
  assert.strictEqual(share('BT2'), 3000, 'three of nine');
  // Which is the owner's sentence, finished: the tip-out and their own tips
  // both land on the same 2:1.
  assert.strictEqual(who(r, 'BT1').tipsKept + share('BT1'), 33667);
  assert.strictEqual(who(r, 'BT2').tipsKept + share('BT2'), 16833);
});

test('nothing is created or destroyed: the shift still reconciles', () => {
  const r = night();
  assert.ok(r.reconciliation.balanced, 'tips in equal tips out');
  assert.strictEqual(r.sharePools.length, 1);
  assert.strictEqual(r.sharePools[0].role, 'bartender');
  assert.strictEqual(r.sharePools[0].kept, 41500);
  assert.strictEqual(r.sharePools[0].cash, 6000);
});

test('one bartender on: the rule changes nothing', () => {
  // The common case, and the one where a pooling bug would be invisible. With
  // nobody to pool with, they keep exactly what the arithmetic gave them.
  const r = runShift({
    servers: [server(), bt('BT1', 6, { food: 100, alcohol: 900, cardTips: 300, cashTips: 60 })],
    support: [{ employeeId: 'BT1', name: 'BT1', role: 'bartender', hours: 6 },
      { employeeId: 'BB', name: 'Barback', role: 'barback', hours: 6 },
      { employeeId: 'BU', name: 'Busser', role: 'busser', hours: 5 }],
    pool: {},
  }, EVENING);
  const a = who(r, 'BT1');
  assert.strictEqual(a.tipsKept, 33000, '$360 less the barback $30');
  assert.strictEqual(a.cashTips, 6000, 'their cash is their cash');
  assert.strictEqual(a.pooled, undefined, 'and nothing says it was pooled');
  assert.strictEqual(r.sharePools.length, 0);
});

test('the servers are not touched by a rule about the bar', () => {
  const r = night();
  const sv = who(r, 'SV');
  // $3,000 of sales: 2% busser = $60, 9% of $1,000 alcohol = $90. $600 - $150.
  assert.strictEqual(sv.tipouts.busser, 6000);
  assert.strictEqual(sv.tipouts.bartender, 9000);
  assert.strictEqual(sv.tipsKept, 45000);
  assert.strictEqual(sv.pooled, undefined);
});

test('an even split is available and means what it says', () => {
  const r = night(EVENING.map((x) => (x.type === 'share' ? { ...x, split: 'even' } : x)));
  assert.strictEqual(who(r, 'BT1').tipsKept, 20750);
  assert.strictEqual(who(r, 'BT2').tipsKept, 20750);
  assert.strictEqual(who(r, 'BT1').cashTips, 3000);
  assert.ok(r.reconciliation.balanced);
});

test('a bar that tipped out more than it took in still divides exactly', () => {
  // Possible on a quiet night with a big tab and no tip on it: the barback's 3%
  // of sales is charged whatever the tips were, so kept can go negative. Split
  // the wrong way round, the leftover penny would be handed to the person who
  // owes the most rather than taken from them.
  const r = runShift({
    servers: [bt('BT1', 5, { alcohol: 1000, cardTips: 0 }), bt('BT2', 5, { alcohol: 1001, cardTips: 0 })],
    support: [{ employeeId: 'BB', name: 'Barback', role: 'barback', hours: 5 }],
    pool: {},
  }, EVENING);
  const a = who(r, 'BT1');
  const b = who(r, 'BT2');
  assert.ok(a.tipsKept < 0 && b.tipsKept < 0, 'both are in the red');
  assert.strictEqual(a.tipsKept + b.tipsKept, -6003, '3% of $2,001, all of it');
  assert.strictEqual(Math.abs(a.tipsKept - b.tipsKept) <= 1, true, 'to within the penny');
});

test('a share rule with nobody in it does nothing at all', () => {
  const r = runShift({
    servers: [server()],
    support: [{ employeeId: 'BU', name: 'Busser', role: 'busser', hours: 5 }],
    pool: {},
  }, EVENING);
  assert.strictEqual(r.sharePools.length, 0);
  assert.ok(r.reconciliation.balanced);
});

// --- what the rest of the app makes of it ----------------------------------

test('a policy that pools is a policy where bartenders keep their own tips', () => {
  // This is the part that turns the staff form on. `newModel` is what decides
  // whether a bartender is a direct earner, and a share rule alone — no paidBy
  // anywhere — has to be enough to say so, or the policy would pool tips the
  // engine had already taken off them.
  const { newModel, keepsOwnCash } = require('../src/db');
  const ONLY_SHARE = [{ type: 'share', role: 'bartender', split: 'hours' }];
  assert.strictEqual(newModel(ONLY_SHARE), true);
  assert.strictEqual(keepsOwnCash('bartender', ONLY_SHARE), true);
  assert.strictEqual(keepsOwnCash('busser', ONLY_SHARE), false);
  const P = require('../src/policy');
  assert.strictEqual(P.isNewModel(ONLY_SHARE), true, 'the policy page calls it new');
  assert.strictEqual(P.needsNewEngine(ONLY_SHARE), true, 'and it needs the new engine');
});

test('end to end: two bartenders file, the service pools what they filed', () => {
  // Through the database this time — the classification, the pinned policy and
  // the engine together, which is the path a real service takes.
  const { db, shiftInputs } = require('../src/db');
  const { policyForShift } = require('../src/policy');
  const mk = (name, role) => Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
    VALUES (?, ?, 1500, 1)`).run(name, role).lastInsertRowid);
  const one = mk('Pool One', 'bartender');
  const two = mk('Pool Two', 'bartender');
  const bb = mk('Pool Back', 'barback');
  const pid = Number(db.prepare(`INSERT INTO policy_versions (daypart, rules_json, note, staged)
    VALUES ('dinner', ?, 'pooling', 1)`).run(JSON.stringify(EVENING)).lastInsertRowid);
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status, policy_id)
    VALUES ('2099-03-04', 'dinner', 'open', ?)`).run(pid).lastInsertRowid);
  const work = db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)');
  work.run(sh, one, 'bartender', 6);
  work.run(sh, two, 'bartender', 3);
  work.run(sh, bb, 'barback', 6);
  const sales = db.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents,
    alcohol_cents, card_tips_cents, cash_tips_cents) VALUES (?,?,?,0,?,?,?)`);
  sales.run(sh, one, 10000, 90000, 30000, 6000);
  sales.run(sh, two, 0, 50000, 10000, 0);

  const inp = shiftInputs(sh);
  assert.strictEqual(inp.servers.length, 2, 'both bartenders earn directly');
  const r = runShift(inp, policyForShift(db.prepare('SELECT * FROM shifts WHERE id = ?').get(sh)));
  const a = r.servers.find((p) => p.employeeId === one);
  const b = r.servers.find((p) => p.employeeId === two);
  assert.strictEqual(a.tipsKept + b.tipsKept, 41500, 'pooled');
  assert.strictEqual(a.tipsKept, 27667);
  assert.strictEqual(b.tipsKept, 13833);
  assert.strictEqual(a.cashTips, 4000, 'and the cash with it');
  assert.ok(r.reconciliation.balanced);
});

// --- the form they file on --------------------------------------------------
//
// A service nobody clocked into is reported through the manual door: date,
// service, figures. That door never knew which service it was until after the
// figures had been typed, so it hid the sales boxes from the one job that most
// needs them. Which service decides which figures the math reads, so the answer
// now travels with the form.

const PORT = 4009;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

test.before(async () => {
  const { db } = require('../src/db');
  // LIVE, not staged: the manual form has no shift to read a pinned policy
  // from, so what it asks for comes from what is live for the service picked.
  db.prepare("INSERT INTO policy_versions (daypart, rules_json, note) VALUES ('dinner', ?, 'live pooling')")
    .run(JSON.stringify(EVENING));
  db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
    VALUES ('Bar Filer', 'bartender', 1600, 1, '7788')`).run();
  db.exec(`INSERT OR IGNORE INTO employee_services (employee_id, service_slug)
           SELECT e.id, s.slug FROM employees e, services s`);
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: process.env.DB_PATH,
      PORTAL_HISTORY_FROM: '2000-01-01' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 90; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
test.after(() => { if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const labels = (html) => (html.match(/class="st-lab"[^>]*>([^<]*)/g) || [])
  .map((x) => x.replace(/.*>/, '').trim());

async function bartenderPage(qs) {
  const start = await fetch(`${BASE}/tips/start`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pin: '7788' }).toString(),
  });
  assert.strictEqual(start.status, 302, 'the PIN is accepted');
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  return (await fetch(`${BASE}/portal/tips?${qs}`, { headers: { cookie } })).text();
}

test('reporting a shift with no clock-in: picking the service asks for the sales', async () => {
  const html = await bartenderPage('manual=1&position=bartender&daypart=dinner');
  const ls = labels(html);
  assert.ok(ls.some((l) => /Bar alcohol sales/.test(l)), 'the bar alcohol box is there');
  assert.ok(ls.some((l) => /Bar food sales/.test(l)), 'and the bar food');
  assert.ok(ls.some((l) => /Card tips/.test(l)), 'with the tips as before');
});

test('and the service they picked comes back with the form it reloaded', async () => {
  const html = await bartenderPage('manual=1&position=bartender&daypart=dinner&date=2026-09-14');
  assert.match(html, /data-st-svc/, 'the service select drives the reload');
  assert.match(html, /value="dinner" selected/, 'and comes back chosen');
  assert.match(html, /value="2026-09-14"/, 'with the date they typed still in it');
});

test('before a service is picked, nothing is asked for on spec', async () => {
  const html = await bartenderPage('manual=1&position=bartender');
  assert.ok(!labels(html).some((l) => /sales/i.test(l)), 'no sales boxes yet');
  assert.ok(labels(html).some((l) => /Card tips/.test(l)), 'tips are asked for regardless');
});

test('a made-up service in the URL is not treated as an answer', async () => {
  const html = await bartenderPage('manual=1&position=bartender&daypart=../../etc&date=nonsense');
  assert.ok(!labels(html).some((l) => /sales/i.test(l)), 'still no sales boxes');
  assert.ok(!/nonsense/.test(html), 'and the date is dropped rather than echoed');
});

test('drawing the form never decides which policy the night is worked out under', async () => {
  // policyForShift STAMPS the version it resolves. The form used to call it
  // plainly, so whoever opened the page first pinned the service to whatever
  // was live at that moment — from the one page a whole crew opens, at the one
  // time of day a policy change goes in.
  const { db } = require('../src/db');
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status)
    VALUES ('2099-03-05', 'dinner', 'open')`).run().lastInsertRowid);
  const emp = db.prepare("SELECT id FROM employees WHERE name = 'Bar Filer'").get().id;
  db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,6)').run(sh, emp, 'bartender');
  await bartenderPage(`shift=${sh}&position=bartender`);
  const after = db.prepare('SELECT policy_id FROM shifts WHERE id = ?').get(sh);
  assert.strictEqual(after.policy_id, null, 'the service is still unstamped');
});

// --- what they are told about it --------------------------------------------
//
// A pooled figure that appears with no explanation is worse than no figure: the
// person reads their own tips, does the subtraction, and it does not come out.
// Both places they see it - tonight's email and their own earnings page - say
// what the bar took in, what their share is, and which way the cash moves.

test('the nightly email shows the pool, not a number that will not add up', () => {
  const { serverEmail } = require('../src/email');
  const r = night();
  const p = r.servers.find((x) => x.employeeId === 'BT1');
  const { html } = serverEmail(p, { date: '2026-09-15', daypart: 'dinner',
    email: 'bar@example.com', hourlyRate: 16, skipped: [] });
  assert.match(html, /Pooled at the bar/, 'the pool is named');
  assert.match(html, /Everyone at the bar kept/);
  assert.match(html, /\$415\.00/, 'what the bar kept between them');
  assert.match(html, /Your share, by hours worked/);
  assert.match(html, /\$276\.67/, 'and their share of it');
  // What they rang, so card + cash still adds to the total on the next line.
  assert.match(html, /\$60\.00/, 'the cash they were handed');
  assert.match(html, /so you hand over/, 'and which way it moves');
  assert.match(html, /\$20\.00/, 'how much of it');
});

test('the one owed the cash is told it is coming to them', () => {
  const { serverEmail } = require('../src/email');
  const r = night();
  const p = r.servers.find((x) => x.employeeId === 'BT2');
  const { html } = serverEmail(p, { date: '2026-09-15', daypart: 'dinner',
    email: 'bar2@example.com', hourlyRate: 16, skipped: [] });
  assert.match(html, /the bar owes you/);
  assert.match(html, /\$20\.00/);
});

test('a bartender who pooled reads the same story on their own earnings page', async () => {
  const { db } = require('../src/db');
  const { isoDate, startOfToday } = require('../src/dates');
  const day = isoDate(new Date(startOfToday().getTime() - 864e5));
  const pid = Number(db.prepare(`INSERT INTO policy_versions (daypart, rules_json, note, staged)
    VALUES ('dinner', ?, 'pooling, sent', 1)`).run(JSON.stringify(EVENING)).lastInsertRowid);
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status, policy_id)
    VALUES (?, 'dinner', 'emailed', ?)`).run(day, pid).lastInsertRowid);
  const filer = db.prepare("SELECT id FROM employees WHERE name = 'Bar Filer'").get().id;
  const mate = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
    VALUES ('Bar Mate', 'bartender', 1600, 1)`).run().lastInsertRowid);
  const work = db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)');
  work.run(sh, filer, 'bartender', 6);
  work.run(sh, mate, 'bartender', 3);
  const sales = db.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents,
    alcohol_cents, card_tips_cents, cash_tips_cents) VALUES (?,?,?,0,?,?,?)`);
  sales.run(sh, filer, 10000, 90000, 30000, 6000);
  sales.run(sh, mate, 0, 50000, 10000, 0);

  const start = await fetch(`${BASE}/tips/start`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pin: '7788' }).toString(),
  });
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  const html = await (await fetch(`${BASE}/portal/earnings/${sh}`, { headers: { cookie } })).text();
  assert.match(html, /Pooled at the bar/, 'the section is there');
  assert.match(html, /Everyone at the bar kept/);
  assert.match(html, /Your share, by hours worked/);
  assert.match(html, /so you hand over/, 'and the cash they are holding for the others');
});

test('the cash question tells a pooled bar the truth about their cash', async () => {
  // "It stays yours" is what this said, and on a pooled bar it is half true:
  // they keep it rather than the house taking it, and the bar still adds it up
  // and splits it by hours. Somebody holding $60 of a $40 share needs the form
  // to have said so before they read it on their payslip.
  const html = await bartenderPage('manual=1&position=bartender&daypart=dinner');
  assert.match(html, /The bar pools its cash and splits it by the hours/);
  assert.ok(!/It stays yours/.test(html), 'and not the sentence that was wrong');
});

// --- a service that never had a policy to be stamped with -------------------
//
// The stamp on a shift is what stops a policy change reaching backwards, and a
// service only gets one if a policy existed for its schedule when something
// touched it. A schedule added from the picker starts with none: Evening
// Service ran for weeks on the built-in defaults with an empty History and
// nothing stamped on any of its nights. Payroll re-runs the engine every time
// it is opened, so the day somebody finally saved an Evening policy, every one
// of those nights - sent, emailed and paid - would have been re-priced by it.

test('a sent service with nothing stamped is not re-priced by a new policy', () => {
  const { db } = require('../src/db');
  const P = require('../src/policy');
  const shiftRow = (id) => db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  // A schedule of its own, with no policy anywhere.
  const sent = Number(db.prepare(`INSERT INTO shifts (date, daypart, status)
    VALUES ('2026-09-02', 'late-night', 'emailed')`).run().lastInsertRowid);
  const open = Number(db.prepare(`INSERT INTO shifts (date, daypart, status)
    VALUES ('2026-09-03', 'late-night', 'open')`).run().lastInsertRowid);
  const before = JSON.stringify(P.policyForShift(shiftRow(sent), { peek: true }));

  // Somebody sets the policy, weeks later.
  db.prepare("INSERT INTO policy_versions (daypart, rules_json, note) VALUES ('late-night', ?, 'at last')")
    .run(JSON.stringify(EVENING));

  assert.strictEqual(JSON.stringify(P.policyForShift(shiftRow(sent))), before,
    'the night that went out is worked out exactly as it was');
  assert.strictEqual(shiftRow(sent).policy_id, null,
    'and it is not stamped now either - that row is history, not a decision');
  // The service still open is the whole point of setting a policy.
  const after = P.policyForShift(shiftRow(open));
  assert.ok(after.some((r) => r.type === 'share'), 'an open service takes the new rules');
  assert.ok(shiftRow(open).policy_id, 'and is stamped with them');
});

test('an ordinary unstamped service still locks on, sent or not', () => {
  // The boundary. A night worked when a policy already existed is not the case
  // above: it is a backfilled service, or a fixture, and it locks onto the
  // policy in force for it exactly as it always did. Only a service that had
  // nothing to be priced by is frozen on the defaults.
  const { db } = require('../src/db');
  const P = require('../src/policy');
  db.prepare("INSERT INTO policy_versions (daypart, rules_json, note) VALUES ('supper-club', ?, 'in force')")
    .run(JSON.stringify(EVENING));
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status)
    VALUES ('2099-01-01', 'supper-club', 'emailed')`).run().lastInsertRowid);
  const rules = P.policyForShift(db.prepare('SELECT * FROM shifts WHERE id = ?').get(sh));
  assert.ok(rules.some((r) => r.type === 'share'), 'the policy that was in force for it');
  assert.ok(db.prepare('SELECT policy_id p FROM shifts WHERE id = ?').get(sh).p, 'and it is stamped');
});

test('and a sent service that WAS stamped still keeps its own version', () => {
  const { db } = require('../src/db');
  const P = require('../src/policy');
  const pid = Number(db.prepare(`INSERT INTO policy_versions (daypart, rules_json, note, staged)
    VALUES ('late-night', ?, 'the one it was priced under', 1)`)
    .run(JSON.stringify([{ type: 'tipout', recipient: 'busser', percent: 7, base: 'food', split: 'hours' }]))
    .lastInsertRowid);
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status, policy_id)
    VALUES ('2026-09-04', 'late-night', 'emailed', ?)`).run(pid).lastInsertRowid);
  const rules = P.policyForShift(db.prepare('SELECT * FROM shifts WHERE id = ?').get(sh));
  assert.strictEqual(rules[0].percent, 7, 'its own version, not the live one');
});

test('the policy page says when a service has no policy of its own', async () => {
  // The only sign used to be an empty History table two screens down, while the
  // defaults were rendered in the same numbered list a chosen policy gets. A
  // schedule added from the picker is exactly how a service ends up here.
  const SERVICES = require('../src/services');
  SERVICES.create({ slug: 'weekend-brunch', name: 'Weekend Brunch' });
  const bare = await (await fetch(`${BASE}/policy?daypart=weekend-brunch`)).text();
  assert.match(bare, /No policy set/, 'said plainly when there is none');
  assert.match(bare, /built-in defaults/, 'and what is on screen instead');
  assert.match(bare, /stay exactly as they went out/, 'and that what has gone out cannot move');

  const { db } = require('../src/db');
  db.prepare("INSERT INTO policy_versions (daypart, rules_json, note) VALUES ('weekend-brunch', ?, 'set')")
    .run(JSON.stringify(EVENING));
  const after = await (await fetch(`${BASE}/policy?daypart=weekend-brunch`)).text();
  assert.ok(!/No policy set/.test(after), 'and gone the moment one is saved');
});

// --- editing a service that is already open -----------------------------------

test('fixing a bartender\'s figures on the service page keeps them a bartender', async () => {
  // Everybody who rings their own till is edited on the same form, and saving it
  // wrote role 'server' over whoever it was. A bartender whose bar sales were
  // corrected became a server: paying the servers' percentages, out of the
  // bartender pot, with nothing on screen to say it had happened.
  const { db } = require('../src/db');
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status)
    VALUES ('2099-05-01', 'dinner', 'open')`).run().lastInsertRowid);
  const mk = (name, role) => Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
    VALUES (?, ?, 1500, 1)`).run(name, role).lastInsertRowid);
  const bar = mk('Edit Bartender', 'bartender');
  const bus = mk('Edit Busser', 'busser');
  const fresh = mk('Edit Newcomer', 'server');
  db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,6)').run(sh, bar, 'bartender');
  db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,5)').run(sh, bus, 'busser');

  const save = (emp, fields) => fetch(`${BASE}/shifts/${sh}/server`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ employee_id: String(emp), ...fields }).toString(),
  });
  const roleOf = (emp) => db.prepare('SELECT role FROM work WHERE shift_id = ? AND employee_id = ?').get(sh, emp).role;

  const res = await save(bar, { food: '120', alcohol: '900', card_tips: '300' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(roleOf(bar), 'bartender', 'still behind the bar');
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /Bartender saved/, 'and the page says who was saved');
  const sales = db.prepare('SELECT alcohol_cents FROM server_sales WHERE shift_id = ? AND employee_id = ?').get(sh, bar);
  assert.strictEqual(sales.alcohol_cents, 90000, 'with the corrected figure');

  // What the Server tab has always done, it still does.
  await save(fresh, { food: '50' });
  assert.strictEqual(roleOf(fresh), 'server', 'somebody new goes on as a server');
  await save(bus, { food: '10' });
  assert.strictEqual(roleOf(bus), 'server', 'and support chosen from the Server tab is moved on purpose');
});

test('a bartender is asked for their tips once, on the row that shows them', async () => {
  // Two rows for one person: what they rang, and what the pots owe them. The
  // second offered a Card tips box that saved and then showed a dash, because a
  // direct earner's own tips are not carried on the receiving side. $45 typed
  // there, $45 stored, the row still reading "—".
  const { db } = require('../src/db');
  const pid = Number(db.prepare(`INSERT INTO policy_versions (daypart, rules_json, note, staged)
    VALUES ('dinner', ?, 'pooling', 1)`).run(JSON.stringify(EVENING)).lastInsertRowid);
  const sh = Number(db.prepare(`INSERT INTO shifts (date, daypart, status, policy_id)
    VALUES ('2099-07-07', 'dinner', 'open', ?)`).run(pid).lastInsertRowid);
  const mk = (name, role) => Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active)
    VALUES (?, ?, 1500, 1)`).run(name, role).lastInsertRowid);
  const bar = mk('Row Bartender', 'bartender');
  const bus = mk('Row Busser', 'busser');
  const work = db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,6)');
  work.run(sh, bar, 'bartender');
  work.run(sh, bus, 'busser');

  const html = await (await fetch(`${BASE}/shifts/${sh}`)).text();
  // Each row on its own, cut at its closing tag: splitting alone leaves every
  // chunk carrying the whole rest of the page, and then every row "contains"
  // every name.
  const cells = html.split('<details class="bs-srow"').slice(1).map((c) => c.split('</details>')[0]);
  const rowFor = (name) => cells.filter((r) => ((r.match(/class="bs-sr-n">([^<]*)/) || [])[1] || '').trim() === name);
  const barRows = rowFor('Row Bartender');
  assert.strictEqual(barRows.length, 2, 'the bar is on the sheet twice: what they rang, what they are owed');
  const [direct, support] = barRows;
  assert.ok(/name="card_tips"/.test(direct), 'their tips are asked for on the row that rang them');
  assert.ok(!/name="card_tips"/.test(support), 'and not on the row that cannot show them');
  assert.ok(!/name="cash_tips"/.test(support), 'cash neither');
  assert.match(support, /paid out of the pots/, 'the row says what it is');
  assert.match(support, /row above/, 'and where the tips go instead');

  // A busser has one row, and it still takes the tips they were handed.
  const [busRow] = rowFor('Row Busser');
  assert.ok(/name="card_tips"/.test(busRow), 'support who only receive still have the boxes');
  assert.match(busRow, /go into the shared pool/, 'with the wording they always had');
});
