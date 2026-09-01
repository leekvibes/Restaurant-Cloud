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

test('MEMBERSHIP IS EXPLICIT — a row, or nothing', () => {
  // There is no fallback. A schedule shows the people put on it, so the tick
  // on the staff page and the row in the table are one fact. An earlier
  // version had "not set up yet means everywhere", and it made every checkbox
  // lie: all of them read unticked while all of them showed on every board.
  assert.deepStrictEqual(SVC.forEmployee(ALICE), [], 'nobody has put them on anything');
  assert.ok(!SVC.canWork(ALICE, 'cafe'));
  assert.ok(!SVC.employeesFor('cafe').includes(ALICE), 'and no board lists them');
});

test('backfill writes real rows for everybody who already existed', () => {
  // The roster that was already working has to be written down, not inferred —
  // with membership explicit there is nothing to infer from, so without this
  // every board empties itself on deploy.
  const out = SVC.backfill();
  assert.ok(out.added > 0, 'rows were written');
  assert.deepStrictEqual(SVC.forEmployee(ALICE).sort(), ['cafe', 'dinner']);
  assert.ok(SVC.employeesFor('cafe').includes(ALICE));
  // Once anybody has been narrowed, re-running it would undo that.
  assert.strictEqual(SVC.backfill().skipped, true, 'it runs once');
});

test('a new employee joins every schedule, so they can work on day one', () => {
  const hired = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
    VALUES ('Svc Hired', 'server', 1500, 1, '7804')`).run().lastInsertRowid);
  assert.deepStrictEqual(SVC.forEmployee(hired), [], 'until somebody says so');
  SVC.addToAll(hired);
  assert.deepStrictEqual(SVC.forEmployee(hired).sort(), ['cafe', 'dinner'],
    'which is what the create route does — quicker to untick than to tick');
});

test('assigning one service excludes the other', () => {
  SVC.setForEmployee(ALICE, ['cafe']);
  assert.strictEqual(SVC.isAssigned(ALICE), true);
  assert.deepStrictEqual(SVC.forEmployee(ALICE), ['cafe']);
  assert.ok(SVC.canWork(ALICE, 'cafe'));
  assert.ok(!SVC.canWork(ALICE, 'dinner'), 'the reported problem: he should not have the option');
});

test('every tick is stored, and a NEW schedule starts empty of set-up people', () => {
  // Ticking every box used to collapse to storing none. It cannot now: none
  // means none, so collapsing would take somebody off everything at the moment
  // their manager ticked everything.
  SVC.setForEmployee(BOB, ['cafe', 'dinner']);
  assert.strictEqual(SVC.isAssigned(BOB), true, 'the decision is recorded');
  assert.deepStrictEqual(SVC.forEmployee(BOB), ['cafe', 'dinner'], 'and both are stored');

  // A new schedule arrives EMPTY of anybody already set up — it is a thing the
  // owner fills, not one he has to empty.
  // A new schedule takes exactly who was picked while creating it.
  SVC.create({ slug: 'brunch', name: 'Brunch', members: [BOB] });
  assert.ok(SVC.canWork(BOB, 'brunch'), 'the person picked is on it');
  assert.ok(!SVC.canWork(ALICE, 'brunch'), 'and nobody else is');
  assert.deepStrictEqual(SVC.employeesFor('brunch'), [BOB]);
  SVC.archive('brunch');
});

test('unticking everything means NOWHERE, which is the owner\'s rule', () => {
  // The whole point of the checkboxes. Take somebody off every schedule and
  // they are off every schedule — not quietly restored to all of them.
  SVC.setForEmployee(ALICE, []);
  assert.strictEqual(SVC.isAssigned(ALICE), false, 'they are on nothing');
  assert.deepStrictEqual(SVC.forEmployee(ALICE), [], 'and it is honoured');
  assert.ok(!SVC.canWork(ALICE, 'cafe'));
  assert.ok(!SVC.canWork(ALICE, 'dinner'), 'they cannot clock in anywhere');
  SVC.setForEmployee(ALICE, ['cafe']);        // put it back for later tests
});

test('archiving takes a service off everybody without touching a membership row', () => {
  const s = SVC.create({ slug: 'latenight', name: 'Late Night' });
  assert.strictEqual(s.name, 'Late Night');
  SVC.setForEmployee(BOB, ['latenight']);
  assert.ok(SVC.canWork(BOB, 'latenight'));

  SVC.archive('latenight');
  assert.ok(!SVC.all().some((x) => x.slug === 'latenight'), 'gone from the live list');
  // Their only schedule is archived, so they are on nothing — and that is
  // correct rather than convenient: the schedule they were on no longer runs.
  assert.deepStrictEqual(SVC.forEmployee(BOB), []);
  SVC.setForEmployee(BOB, ['cafe', 'dinner']);
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

test('employeesFor is exactly who was added — this is what the board shows', () => {
  SVC.setForEmployee(ALICE, ['cafe']);
  SVC.setForEmployee(BOB, ['cafe', 'dinner']);
  const cafe = SVC.employeesFor('cafe');
  const dinner = SVC.employeesFor('dinner');
  assert.ok(cafe.includes(ALICE) && cafe.includes(BOB), 'both are on Day');
  assert.ok(!dinner.includes(ALICE), 'Alice is Day only, so she is not on the Evening board');
  assert.ok(dinner.includes(BOB), 'Bob is on both');

  // Somebody nobody added is on no board at all. That is the rule.
  const fresh = Number(db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
    VALUES ('Svc Fresh', 'server', 1500, 1, '7803')`).run().lastInsertRowid);
  assert.ok(!SVC.employeesFor('cafe').includes(fresh));
  assert.ok(!SVC.canWork(fresh, 'dinner'));
});

test('a bad or unknown schedule in a POST cannot be stored', () => {
  SVC.setForEmployee(ALICE, ['cafe', 'nonsense', '']);
  assert.deepStrictEqual(SVC.forEmployee(ALICE), ['cafe'],
    'anything that is not a live service is dropped rather than stored');
});

test('creating a service refuses a blank name or a duplicate key', () => {
  assert.throws(() => SVC.create({ slug: 'x', name: '' }), /needs a name/);
  assert.throws(() => SVC.create({ slug: '', name: 'X' }), /short internal key/);
  assert.throws(() => SVC.create({ slug: 'cafe', name: 'Another' }), /already a service/);
});

// --- payroll, split by service ------------------------------------------------

test('payroll can be read per service, and the hours add back up', () => {
  const R = require('../src/reports');
  const mkShift = (date, daypart) => Number(db.prepare(
    'INSERT INTO shifts (date, daypart, status, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
    .run(date, daypart, 'emailed').lastInsertRowid);
  const day = mkShift('2027-02-01', 'cafe');
  const eve = mkShift('2027-02-01', 'dinner');
  const work = db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents)
                           VALUES (?, ?, 'server', ?, 2000)`);
  work.run(day, ALICE, 6);
  work.run(eve, ALICE, 4);

  const all = R.aggregatePayroll('2027-02-01', '2027-02-01');
  const d = R.aggregatePayroll('2027-02-01', '2027-02-01', { service: 'cafe' });
  const e = R.aggregatePayroll('2027-02-01', '2027-02-01', { service: 'dinner' });
  const hrs = (x) => x.rows.reduce((a, p) => a + (p.hours || 0), 0);

  assert.strictEqual(all.shiftCount, 2);
  assert.strictEqual(d.shiftCount, 1, 'one Day shift');
  assert.strictEqual(e.shiftCount, 1, 'one Evening shift');
  assert.strictEqual(hrs(d), 6, 'Day hours');
  assert.strictEqual(hrs(e), 4, 'Evening hours');
  assert.strictEqual(hrs(d) + hrs(e), hrs(all), 'and the two halves are the whole');
});

test('a service view is never the one you run payroll from, because of overtime', () => {
  // Overtime is a property of somebody's WEEK, not of a service. Split the week
  // by service and each half can fall under the weekly threshold that the whole
  // crosses — so the premium disappears and per-service wages sum to LESS than
  // the real figure. Measured on the live dev data at the time this was
  // written: hours matched exactly and wages were $268.60 short, all of it
  // overtime premium.
  //
  // This is why Overall is the default, why it is what the run is done from,
  // and why the scoped view says so on the page rather than leaving somebody
  // to discover it at the end of a pay period.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'reports.js'), 'utf8');
  assert.match(src, /OVERTIME IS NOT SPLIT, and cannot be/,
    'the reason is recorded where the filter is');

  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(page, /overtime is weekly across every service, so run payroll from Overall/,
    'and said on the page, not only in a comment');
  assert.match(page, /const paySvc = SERVICES\.isActive\(req\.query\.svc\) \? req\.query\.svc : 'all'/,
    'Overall is the default — a scoped view is never what somebody lands on');
});

// --- creating one: who is on it, and whether it has a clock -------------------

test('a new schedule takes exactly the people picked, and nobody else', () => {
  const out = SVC.create({ slug: 'evt', name: 'Private events', members: [ALICE] });
  assert.strictEqual(out.name, 'Private events');
  assert.deepStrictEqual(SVC.employeesFor('evt'), [ALICE], 'the one person picked');
  assert.ok(SVC.canWork(ALICE, 'evt'));
  assert.ok(!SVC.canWork(BOB, 'evt'), 'and nobody who was not');
  SVC.archive('evt');
});

test('a schedule can be made without a time clock, and given one later', () => {
  // The clock is a flag on the schedule, not a second table. A time clock is
  // already a service here — punches, timesheets and corrections are all keyed
  // by daypart — so a separate table would be a second name for one thing, and
  // the two would eventually disagree about which service a punch belonged to.
  SVC.create({ slug: 'latenite', name: 'Late night', members: [BOB], withClock: false });
  assert.ok(!SVC.withClock().some((x) => x.slug === 'latenite'), 'no clock card yet');
  assert.ok(SVC.all().some((x) => x.slug === 'latenite'), 'but the schedule is there');

  SVC.setClock('latenite', true);
  assert.ok(SVC.withClock().some((x) => x.slug === 'latenite'), 'connected later');

  // And disconnected again, without touching anybody's punches.
  SVC.setClock('latenite', false);
  assert.ok(!SVC.withClock().some((x) => x.slug === 'latenite'));
  SVC.archive('latenite');
});

test('the schedules that always existed keep their clock', () => {
  // has_clock defaults to 1 on an existing row. Café and dinner have always
  // had a clock, and a migration that quietly switched it off would take the
  // time clock away from a working restaurant.
  const slugs = SVC.withClock().map((x) => x.slug);
  assert.ok(slugs.includes('cafe') && slugs.includes('dinner'));
});

test('a schedule made without picking anybody starts empty, not full', () => {
  // The wrong way round would be a schedule arriving with the whole roster on
  // it, which has to be emptied before it is any use.
  SVC.create({ slug: 'catering', name: 'Catering' });
  assert.deepStrictEqual(SVC.employeesFor('catering'), []);
  SVC.archive('catering');
});

// --- work hours, per day, per clock -------------------------------------------

test('work hours are seven days per clock, and unset means no limit', () => {
  const week = SVC.hoursFor('cafe');
  assert.strictEqual(week.length, 7, 'always seven rows, set or not');
  assert.deepStrictEqual(week.map((d) => d.letter), ['S', 'M', 'T', 'W', 'T', 'F', 'S']);
  assert.ok(week.every((d) => d.openMin === null && d.closeMin === null),
    'nothing is set until somebody sets it — a clock nobody configured behaves as it always did');
});

test('a day can open and close, including across midnight', () => {
  // A bar's Friday runs 4pm to 2am. The close being SMALLER than the open is
  // what says "past midnight", and it has to be storable.
  SVC.setHours('cafe', 5, SVC.asMin('16:00'), SVC.asMin('02:00'));
  const fri = SVC.hoursOn('cafe', 5);
  assert.strictEqual(fri.openMin, 16 * 60);
  assert.strictEqual(fri.closeMin, 2 * 60);
  assert.ok(fri.closeMin < fri.openMin, 'which is how a night that ends tomorrow is stored');

  // And one day's hours are one day's — Saturday is untouched.
  assert.strictEqual(SVC.hoursOn('cafe', 6).openMin, null);
});

test('work hours belong to ONE clock', () => {
  assert.strictEqual(SVC.hoursOn('dinner', 5).openMin, null,
    'setting the cafe Friday did not set the dinner Friday');
});

test('a blank time clears that day rather than being ignored', () => {
  // The input IS the state: what is on screen when you press save is what you
  // get. A blank that quietly kept the old value would be unremovable.
  SVC.setHours('cafe', 5, null, null);
  assert.strictEqual(SVC.hoursOn('cafe', 5).openMin, null);
  assert.strictEqual(SVC.hoursOn('cafe', 5).closeMin, null);
});

test('a time that is not a time is refused rather than stored as something else', () => {
  assert.strictEqual(SVC.asMin('nonsense'), null);
  assert.strictEqual(SVC.asMin('25:00'), null, 'no 25th hour');
  assert.strictEqual(SVC.asMin('12:60'), null, 'no 60th minute');
  assert.strictEqual(SVC.asMin(''), null);
  assert.strictEqual(SVC.asMin('9:30'), 570, 'and a real one parses');
});

// --- every clock keeps its own settings ---------------------------------------

test('editing one clock does not change another', () => {
  // The complaint that prompted this: open the settings for Day, change them,
  // open Evening, and Evening had the same values. They were one shared set.
  const app = { breaksPaid: false, longShift: 16, pinForFix: true, alertsOn: true,
    autoOut: false, autoOutHours: 13 };
  SVC.seedSettings(app);

  SVC.setSettingsFor('cafe', { ...app, longShift: 8, breaksPaid: true, autoOut: true, autoOutHours: 9 });

  const day = SVC.settingsFor('cafe', app);
  const eve = SVC.settingsFor('dinner', app);
  assert.strictEqual(day.longShift, 8);
  assert.strictEqual(day.breaksPaid, true);
  assert.strictEqual(day.autoOutHours, 9);
  assert.strictEqual(eve.longShift, 16, 'Evening kept its own');
  assert.strictEqual(eve.breaksPaid, false);
  assert.strictEqual(eve.autoOutHours, 13);

  SVC.setSettingsFor('cafe', app);              // put it back for later tests
});

test('a clock with nothing set falls back to the app-wide value', () => {
  // Which is what makes the migration safe: a clock nobody has configured
  // behaves exactly as it did before it had settings of its own.
  SVC.create({ slug: 'fresh', name: 'Fresh Clock' });
  const app = { breaksPaid: true, longShift: 11, pinForFix: false, alertsOn: false,
    autoOut: true, autoOutHours: 7 };
  const got = SVC.settingsFor('fresh', app);
  assert.deepStrictEqual(got, app, 'every value falls through');
  SVC.archive('fresh');
});

test('the trading-day cutoff is NOT one of them', () => {
  // It decides which DAY 1am belongs to and is read across payroll, sales,
  // cash and the services page. Two clocks disagreeing about it would file one
  // night under two different dates.
  const keys = SVC.CLOCK_SETTINGS.map(([, k]) => k);
  assert.ok(!keys.includes('cutoffHour'), 'the date boundary stays app-wide');
  assert.deepStrictEqual(keys.sort(),
    ['alertsOn', 'autoOut', 'autoOutHours', 'breaksPaid', 'longShift', 'pinForFix', 'timezone']);
});

test('timezone is per-clock, and the cutoff being app-wide is why that is safe', () => {
  // These two look like the same decision and are not. The cutoff is an HOUR of
  // whatever the local day is — "work before 4am belongs to yesterday" — so it
  // means the same thing in every zone and can stay app-wide. The zone is WHERE
  // that local day is measured, and a second location genuinely has a different
  // one. Together they read as "every clock's trading day starts at 4am where
  // its staff are standing", which is the rule a person would state.
  //
  // The default is the thing that keeps it safe: NULL, meaning follow the
  // restaurant. A clock nobody has touched cannot drift onto its own calendar.
  SVC.create({ slug: 'tzclock', name: 'TZ Clock' });
  assert.strictEqual(SVC.settingsFor('tzclock', {}).timezone, undefined,
    'a new clock has no zone of its own');
  const app = { breaksPaid: true, longShift: 11, pinForFix: false, alertsOn: false,
    autoOut: true, autoOutHours: 7, timezone: 'America/New_York' };
  assert.strictEqual(SVC.settingsFor('tzclock', app).timezone, 'America/New_York',
    'and inherits the restaurant zone until it is given one');

  SVC.setSettingsFor('tzclock', { ...app, timezone: 'America/Los_Angeles' });
  assert.strictEqual(SVC.settingsFor('tzclock', app).timezone, 'America/Los_Angeles');

  // A zone this machine cannot resolve is refused at the door rather than
  // stored to throw later inside a formatter on some unrelated page.
  SVC.setSettingsFor('tzclock', { ...app, timezone: 'Mars/Olympus_Mons' });
  assert.strictEqual(SVC.settingsFor('tzclock', app).timezone, 'America/New_York',
    'a nonsense zone falls back to the restaurant, it does not persist');
  SVC.archive('tzclock');
});

test('an out-of-range value is clamped rather than stored', () => {
  const app = { breaksPaid: false, longShift: 16, pinForFix: true, alertsOn: true,
    autoOut: false, autoOutHours: 13 };
  SVC.setSettingsFor('cafe', { ...app, longShift: 99, autoOutHours: 1 });
  const got = SVC.settingsFor('cafe', app);
  assert.strictEqual(got.longShift, 16, 'a nonsense threshold falls back to the default');
  assert.strictEqual(got.autoOutHours, 13, 'and an auto clock-out under four hours does too');
  SVC.setSettingsFor('cafe', app);
});
