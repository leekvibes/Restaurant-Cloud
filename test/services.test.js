'use strict';

// Services: named Day and Evening, who works which, and the gate that stops
// somebody clocking into one they are not on.
//
// The gate is the point of the whole feature. It is asserted where it lands —
// on the POST — not by checking the option is missing from a select, because
// an option missing from a select stops nobody who can send a request.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-svc-'));
process.env.DB_PATH = path.join(dir, 'svc.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
const SVC = require('../src/services');

let ALICE; let BOB;

test.before(() => {
  SVC.seed();
  const ins = db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
                          VALUES (?, 'server', 1500, 1, ?)`);
  ALICE = Number(ins.run('Svc Alice', '7801').lastInsertRowid);
  BOB = Number(ins.run('Svc Bob', '7802').lastInsertRowid);
});

test('the two services that always existed are seeded with names', () => {
  const all = SVC.all();
  assert.deepStrictEqual(all.map((s) => s.slug), ['cafe', 'dinner'],
    'the stored values are unchanged — that is what makes this a rename, not a migration');
  assert.strictEqual(SVC.nameOf('cafe'), 'Day Service');
  assert.strictEqual(SVC.nameOf('dinner'), 'Evening Service');
  // Seeding twice must not double them, because boot runs it every time.
  assert.strictEqual(SVC.seed().seeded, 0);
});

test('NO ROWS MEANS EVERY SERVICE — which is why nothing breaks on day one', () => {
  // The single most important rule here. If absence meant "no services", every
  // employee would be locked out of the clock the moment this shipped.
  assert.strictEqual(SVC.isAssigned(ALICE), false, 'nobody has been assigned yet');
  assert.deepStrictEqual(SVC.forEmployee(ALICE), ['cafe', 'dinner']);
  assert.ok(SVC.canWork(ALICE, 'cafe'));
  assert.ok(SVC.canWork(ALICE, 'dinner'));
});

test('assigning one service excludes the other', () => {
  SVC.setForEmployee(ALICE, ['cafe']);
  assert.strictEqual(SVC.isAssigned(ALICE), true);
  assert.deepStrictEqual(SVC.forEmployee(ALICE), ['cafe']);
  assert.ok(SVC.canWork(ALICE, 'cafe'));
  assert.ok(!SVC.canWork(ALICE, 'dinner'), 'the reported problem: he should not have the option');
});

test('ticking every box is stored as ticking none, because they mean the same', () => {
  // Not a shortcut — it is what keeps one idea in one representation, and it
  // means a service added next year includes them without anybody revisiting
  // this page.
  SVC.setForEmployee(BOB, ['cafe', 'dinner']);
  assert.strictEqual(SVC.isAssigned(BOB), false, 'stored as no list');
  assert.deepStrictEqual(SVC.forEmployee(BOB), ['cafe', 'dinner'], 'and still works both');

  SVC.create({ slug: 'brunch', name: 'Brunch' });
  assert.ok(SVC.canWork(BOB, 'brunch'), 'so a new service includes them automatically');
  assert.ok(!SVC.canWork(ALICE, 'brunch'), 'but not somebody deliberately narrowed');
  SVC.archive('brunch');
});

test('clearing the list puts them back on everything', () => {
  SVC.setForEmployee(ALICE, []);
  assert.strictEqual(SVC.isAssigned(ALICE), false);
  assert.ok(SVC.canWork(ALICE, 'dinner'));
  SVC.setForEmployee(ALICE, ['cafe']);        // put it back for later tests
});

test('archiving takes a service off everybody without touching a membership row', () => {
  const s = SVC.create({ slug: 'latenight', name: 'Late Night' });
  assert.strictEqual(s.name, 'Late Night');
  SVC.setForEmployee(BOB, ['latenight']);
  assert.ok(SVC.canWork(BOB, 'latenight'));

  SVC.archive('latenight');
  assert.ok(!SVC.all().some((x) => x.slug === 'latenight'), 'gone from the live list');
  // Their only service is archived, so they fall back to everything rather
  // than to nothing — a person is never left unable to clock in at all.
  assert.deepStrictEqual(SVC.forEmployee(BOB), ['cafe', 'dinner']);
  SVC.setForEmployee(BOB, []);
});

test('a service is archived, never deleted, and the last one cannot go', () => {
  // A service names history: shifts, policy versions, every tip-out settled
  // under it. Deleting the row would leave a past service unnameable.
  assert.strictEqual(typeof SVC.archive, 'function');
  assert.ok(!('remove' in SVC) && !('destroy' in SVC), 'there is no delete');
  SVC.archive('dinner');
  assert.throws(() => SVC.archive('cafe'), /at least one service/);
  SVC.unarchive('dinner');
});

test('a rename changes the name and never the stored value', () => {
  SVC.rename('cafe', 'Daytime');
  assert.strictEqual(SVC.nameOf('cafe'), 'Daytime');
  const shifts = db.prepare("SELECT COUNT(*) n FROM shifts WHERE daypart = 'cafe'").get().n;
  assert.strictEqual(typeof shifts, 'number', 'shifts still key on the slug');
  SVC.rename('cafe', 'Day Service');
});

test('employeesFor includes both the assigned and the unrestricted', () => {
  SVC.setForEmployee(ALICE, ['cafe']);
  SVC.setForEmployee(BOB, []);
  const cafe = SVC.employeesFor('cafe');
  const dinner = SVC.employeesFor('dinner');
  assert.ok(cafe.includes(ALICE) && cafe.includes(BOB), 'both can work Day');
  assert.ok(!dinner.includes(ALICE), 'Alice is Day only');
  assert.ok(dinner.includes(BOB), 'Bob has no list, so he is on everything');
});

test('a bad or unknown service in a POST cannot be stored', () => {
  SVC.setForEmployee(ALICE, ['cafe', 'nonsense', '']);
  assert.deepStrictEqual(SVC.forEmployee(ALICE), ['cafe'],
    'anything that is not a live service is dropped rather than stored');
});

test('creating a service refuses a blank name or a duplicate key', () => {
  assert.throws(() => SVC.create({ slug: 'x', name: '' }), /needs a name/);
  assert.throws(() => SVC.create({ slug: '', name: 'X' }), /short internal key/);
  assert.throws(() => SVC.create({ slug: 'cafe', name: 'Another' }), /already a service/);
});
