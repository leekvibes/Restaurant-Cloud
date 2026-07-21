'use strict';

// The two months before ZWIN. This is somebody's pay for seventy-two services,
// so the tests are about the things that would quietly get it wrong: running
// twice, splitting one person across two records, converting hours that were
// never in the format we thought, and recomputing settled history under a
// policy that did not exist yet.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bf-'));
process.env.DB_PATH = path.join(dir, 'b.db');
const BF = require('../src/backfill');
const { db, shiftInputs } = require('../src/db');
const { runShift } = require('../src/engine');

const days = BF.loadData();
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// --- the data file ----------------------------------------------------------

test('the committed data covers every day from the first service to the handover', () => {
  assert.ok(days, 'data/backfill-2026.json is present');
  assert.strictEqual(days.length, 72);
  assert.strictEqual(days[0].date, '2026-05-07');
  assert.strictEqual(days[days.length - 1].date, '2026-07-17');
  // ZWIN's own records start on the 18th. One day of overlap would be one day
  // of doubled wages.
  assert.ok(days.every((d) => d.date < '2026-07-18'), 'nothing reaches into ZWIN period');

  const seen = new Set();
  for (const d of days) {
    assert.ok(!seen.has(d.date), `${d.date} appears once`);
    seen.add(d.date);
  }
  // No gaps: 72 consecutive days.
  const span = (new Date('2026-07-17') - new Date('2026-05-07')) / 86400000 + 1;
  assert.strictEqual(days.length, span, 'no missing days');
});

test('the sheet reconciles with itself, which is what makes it checkable', () => {
  // Every pool is a percentage of the day's own totals. If this fails the data
  // file was edited by hand and everything below it is measuring nothing.
  let checked = 0;
  for (const d of days) {
    if (!d.totals || d.totals.total === 0) continue;
    checked++;
    const want = {
      kitchen: Math.round(d.totals.food * 0.015),
      barista: Math.round(d.totals.coffee * 0.015),
      bartender: Math.round(d.totals.alcohol * 0.05),
      busser: d.busser ? Math.round(d.totals.total * 0.02) : 0,
    };
    for (const k of Object.keys(want)) {
      assert.ok(Math.abs((d.pools[k] || 0) - want[k]) <= 1,
        `${d.date} ${k}: file ${d.pools[k]} vs ${want[k]}`);
    }
  }
  assert.strictEqual(checked, 68, '68 trading days');
});

// --- hours ------------------------------------------------------------------

test('h.mm hours become decimal, and only on the tabs that used h.mm', () => {
  // 9.30 out of Connecteam is nine hours thirty, not nine-point-three. Getting
  // this backwards short-changes eight people across a fortnight.
  assert.strictEqual(BF.toDecimalHours(9.30, '2026-05-12'), 9.5);
  assert.strictEqual(BF.toDecimalHours(9.15, '2026-05-12'), 9.25);
  assert.strictEqual(BF.toDecimalHours(10.00, '2026-05-12'), 10);

  // Outside the block the number is already decimal and must not be touched.
  assert.strictEqual(BF.toDecimalHours(9.30, '2026-05-23'), 9.3);
  assert.strictEqual(BF.toDecimalHours(8.60, '2026-06-15'), 8.6);
  assert.strictEqual(BF.toDecimalHours(9.50, '2026-05-08'), 9.5, '05/07 and 05/08 were rebuilt as decimal');
  assert.strictEqual(BF.toDecimalHours(8.60, '2026-05-13'), 8.6, '05/13 was entered decimal by hand');
});

test('an impossible h.mm value stops the import instead of being rounded away', () => {
  // .60 is not a minute count. Silently treating it as decimal would be a
  // guess about how long somebody worked.
  assert.throws(() => BF.toDecimalHours(8.60, '2026-05-12'), /not a valid h\.mm/);
  assert.throws(() => BF.toDecimalHours(7.99, '2026-05-20'), /not a valid h\.mm/);
});

test('no committed h.mm day contains a value that cannot be converted', () => {
  for (const d of days) {
    if (!BF.isHhmm(d.date)) continue;
    for (const s of d.staff) {
      assert.doesNotThrow(() => BF.toDecimalHours(s.hours, d.date), `${d.date} ${s.name} ${s.hours}`);
    }
  }
});

// --- the import -------------------------------------------------------------

test('it imports, and every service reconciles against the sheet', () => {
  const res = BF.run();
  assert.ok(res.ran, `it ran: ${res.why || ''}`);
  assert.strictEqual(res.report.inserted.length, 72);

  const shifts = db.prepare("SELECT id, date FROM shifts WHERE daypart='cafe' ORDER BY date").all();
  assert.strictEqual(shifts.length, 72);

  const byDate = new Map(days.map((d) => [d.date, d]));
  let matched = 0;
  for (const sh of shifts) {
    const sheet = byDate.get(sh.date);
    const inp = shiftInputs(sh.id);
    const out = runShift(inp, BF.HISTORIC_RULES);

    const got = {};
    for (const s of out.servers) for (const [k, v] of Object.entries(s.tipouts || {})) got[k] = (got[k] || 0) + v;
    for (const role of ['kitchen', 'barista', 'bartender', 'busser']) {
      assert.ok(Math.abs((got[role] || 0) - (sheet.pools[role] || 0)) <= 1,
        `${sh.date} ${role}: engine ${got[role] || 0} vs sheet ${sheet.pools[role] || 0}`);
    }
    matched++;
  }
  assert.strictEqual(matched, 72, 'all 72 reconcile through ZWIN\'s own engine');
});

test('every person gets what the sheet says they got, not just the right pool total', () => {
  // The pools reconciling is not enough. A role classified wrongly changes how
  // a pool is SPLIT while leaving its total untouched — which is exactly what
  // happened: `training` was missing from the default positions, `kindOf`
  // falls back to 'support', and four training shifts would have drawn a share
  // their staff never received. Totals matched throughout.
  const byDate = new Map(days.map((d) => [d.date, d]));
  const shifts = db.prepare("SELECT id, date FROM shifts WHERE daypart='cafe' ORDER BY date").all();
  const wrong = [];

  for (const sh of shifts) {
    const sheet = byDate.get(sh.date);
    const inp = shiftInputs(sh.id);
    const out = runShift(inp, BF.HISTORIC_RULES);

    // What the engine gives each support person from the role tip-out pools.
    // `shiftInputs` already returns exactly the shape runShift wants — hand
    // remapping it keyed every lookup on `undefined` and made this test agree
    // with itself instead of with the sheet.
    const got = new Map();
    for (const p of out.support || []) got.set(String(p.name).toLowerCase(), p.tipShare || 0);

    for (const s of sheet.staff) {
      const role = BF.ROLE[String(s.role || '').trim().toLowerCase()] || 'training';
      if (role === 'server') continue;            // servers keep, they do not receive
      const key = (BF.FIXES[BF.canon(s.name)] || BF.canon(s.name)).split(' ')[0];
      const mine = [...got.entries()].find(([n]) => n.split(' ')[0] === key);
      const engine = mine ? mine[1] : 0;
      const diff = Math.abs(engine - (s.tipOutShare || 0));

      // 28 June is the one day the sheet does not balance, and the owner has
      // seen it: Eunji is credited $75.00 out of a busser pool holding $38.10.
      // ZWIN pays what the pool contained. Pinned so the difference cannot
      // change size without somebody noticing.
      if (sh.date === '2026-06-28' && key === 'eunji') {
        assert.strictEqual(engine, 3810, 'the whole busser pool, which is all there was');
        assert.strictEqual(s.tipOutShare, 7500, 'against $75.00 in the sheet');
        continue;
      }

      // On the h.mm tabs the sheet split its pools using hours that were still
      // in h.mm — 9.30 weighted as 9.3 rather than 9.5. The pool TOTALS are
      // unaffected; only how two people in the same role divide one is, by a
      // few cents. ZWIN splits on the corrected hours, so a small difference
      // here is the import being more right than the sheet, not less.
      const tolerance = BF.isHhmm(sh.date) ? 10 : 2;
      if (diff > tolerance) {
        wrong.push(`${sh.date} ${s.name} (${role}): engine ${engine} vs sheet ${s.tipOutShare}`);
      }
    }
  }
  assert.deepStrictEqual(wrong.slice(0, 8), [], `${wrong.length} people paid differently from the sheet`);
});

test('outside the h.mm fortnight, every share matches the sheet to the cent', () => {
  // The tolerance above exists only because of a known defect in the source.
  // Everywhere the input is clean, so is the output — and this is what would
  // catch a role mapping or an hours column quietly going wrong.
  const byDate = new Map(days.map((d) => [d.date, d]));
  let checked = 0;
  for (const sh of db.prepare("SELECT id, date FROM shifts WHERE daypart='cafe' ORDER BY date").all()) {
    if (BF.isHhmm(sh.date) || sh.date === '2026-06-28') continue;
    const sheet = byDate.get(sh.date);
    const out = runShift(shiftInputs(sh.id), BF.HISTORIC_RULES);
    const got = new Map();
    for (const p of out.support || []) got.set(String(p.name).toLowerCase().split(' ')[0], p.tipShare || 0);
    for (const s of sheet.staff) {
      const role = BF.ROLE[String(s.role || '').trim().toLowerCase()] || 'training';
      if (role === 'server') continue;
      const key = (BF.FIXES[BF.canon(s.name)] || BF.canon(s.name)).split(' ')[0];
      assert.ok(Math.abs((got.get(key) || 0) - (s.tipOutShare || 0)) <= 2,
        `${sh.date} ${s.name}: engine ${got.get(key) || 0} vs sheet ${s.tipOutShare}`);
      checked++;
    }
  }
  assert.ok(checked > 250, `checked ${checked} people`);
});

test('a training shift receives nothing from the pools', () => {
  const rows = db.prepare(`SELECT s.date, e.name FROM work w
    JOIN employees e ON e.id = w.employee_id JOIN shifts s ON s.id = w.shift_id
    WHERE w.role = 'training'`).all();
  assert.ok(rows.length, 'there are training shifts');
  for (const r of rows) {
    const d = days.find((x) => x.date === r.date);
    const row = d.staff.find((x) => BF.canon(x.name).split(' ')[0] === BF.canon(r.name).split(' ')[0]);
    assert.strictEqual(row.tipOutShare, 0, `${r.date} ${r.name} took nothing in the sheet`);
  }
  assert.strictEqual(db.prepare("SELECT kind FROM positions WHERE slug='training'").get().kind, 'non_tipped');
});

test('running it again changes nothing', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM shifts').get().n;
  const beforeWork = db.prepare('SELECT COUNT(*) n FROM work').get().n;
  const second = BF.run();
  assert.strictEqual(second.ran, false);
  assert.match(second.why, /already applied/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shifts').get().n, before);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM work').get().n, beforeWork);
});

test('even forced, it will not duplicate a service that already exists', () => {
  // The marker is one guard; this is the other. A duplicated service is a
  // duplicated paycheck, so it does not rely on a settings row alone.
  const before = db.prepare('SELECT COUNT(*) n FROM shifts').get().n;
  const forced = BF.run({ force: true });
  assert.ok(forced.ran);
  assert.strictEqual(forced.report.inserted.length, 0, 'nothing new inserted');
  assert.strictEqual(forced.report.skipped.length, 72, 'all 72 skipped as already present');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shifts').get().n, before);
});

// --- what the import decided ------------------------------------------------

test('history is stamped with the old policy, and today keeps the new one', () => {
  const pol = db.prepare("SELECT id, rules_json FROM policy_versions WHERE note LIKE 'Pre-ZWIN%'").get();
  assert.ok(pol, 'the historic version exists');
  const busser = JSON.parse(pol.rules_json).find((r) => r.recipient === 'busser');
  assert.deepStrictEqual([busser.percent, busser.base], [2, 'total_sales'],
    'the rule that actually ran until 18 July');

  const stamped = db.prepare('SELECT DISTINCT policy_id FROM shifts').all().map((r) => r.policy_id);
  assert.deepStrictEqual(stamped, [pol.id], 'every backfilled service is pinned to it');

  // And it must not have become the current policy — new services still get
  // the 13% rule. `latest` orders by effective_from, which is why this one is
  // dated in the past.
  const latest = db.prepare(
    "SELECT id FROM policy_versions WHERE daypart='cafe' ORDER BY effective_from DESC, id DESC LIMIT 1").get();
  assert.notStrictEqual(latest.id, pol.id, 'the historic policy is not the current one');
});

test('one person is one record, however the sheet spelled them', () => {
  const names = db.prepare('SELECT name FROM employees').all().map((e) => e.name);
  const lower = names.map((n) => n.toLowerCase());
  assert.strictEqual(new Set(lower).size, lower.length, `no case-duplicate staff: ${names.join(', ')}`);

  // 05/24 was typed entirely in lowercase and 05/28 spells her "Stephaine".
  // Both are the same people as every other day.
  const steph = db.prepare("SELECT id FROM employees WHERE LOWER(name) LIKE 'stephanie%'").all();
  assert.strictEqual(steph.length, 1, 'one Stephanie');
  const shifts24 = db.prepare(`SELECT COUNT(*) n FROM work w JOIN shifts s ON s.id = w.shift_id
    WHERE s.date = '2026-05-24'`).get().n;
  assert.ok(shifts24 > 0, 'the lowercase day imported');
});

test('a first name matches an existing full name rather than making a second person', () => {
  // The sheet says "Sandra"; ZWIN holds "Sandra Moyer". Two records would
  // split forty-four shifts of pay across two people who each look half paid.
  //
  // This has to run against a database where she ALREADY exists under her full
  // name — which the fresh one in this file does not, so it never exercised
  // the path it claims to test until it was built its own.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bf3-'));
  const dbp = path.join(tmp, 'd.db');
  const BFP = JSON.stringify(path.join(__dirname, '..', 'src', 'backfill'));
  const run = (code) => require('node:child_process').spawnSync(
    process.execPath, ['-e', `process.env.DB_PATH = ${JSON.stringify(dbp)};\n${code}`],
    { encoding: 'utf8', cwd: path.join(__dirname, '..') });

  // A database that knows her only by her full name.
  const seed = run(`
    require(${BFP});                                   // creates the schema
    const D = require('better-sqlite3');
    const db = new D(process.env.DB_PATH);
    db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active) VALUES ('Sandra Moyer','server',1000,1)").run();
    console.log('SEEDED');
  `);
  assert.match(seed.stdout, /SEEDED/, seed.stdout + seed.stderr);

  const imported = run(`
    const r = require(${BFP}).run();
    console.log('MATCHED=' + JSON.stringify(r.report.matched));
    console.log('CREATED=' + JSON.stringify(r.report.created));
  `);
  assert.match(imported.stdout, /MATCHED=\[".*Sandra.*Sandra Moyer.*"\]/,
    `she was matched, not duplicated: ${imported.stdout}${imported.stderr}`);
  assert.ok(!/CREATED=\[[^\]]*"Sandra"/.test(imported.stdout), 'and no bare "Sandra" was created');

  const after = run(`
    const D = require('better-sqlite3');
    const db = new D(process.env.DB_PATH, { readonly: true });
    const rows = db.prepare("SELECT e.name, COUNT(*) n FROM work w JOIN employees e ON e.id = w.employee_id WHERE LOWER(e.name) LIKE 'sandra%' GROUP BY e.name").all();
    console.log('ROWS=' + JSON.stringify(rows));
  `);
  const rows = JSON.parse(after.stdout.match(/ROWS=(.*)/)[1]);
  assert.strictEqual(rows.length, 1, `one Sandra holds every shift: ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].name, 'Sandra Moyer');
  assert.ok(rows[0].n > 30, `and all of them, got ${rows[0].n}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an ambiguous name stops the import rather than guessing', () => {
  // Two people whose first name matches is a question for the owner. Picking
  // one silently puts somebody else's hours on somebody's paycheck.
  //
  // Built in a child process against its own database rather than by copying
  // this one — the file here is open, and a mid-flight copy of a SQLite
  // database is not a database.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bf2-'));
  const dbp = path.join(tmp, 'c.db');
  const BFP = JSON.stringify(path.join(__dirname, '..', 'src', 'backfill'));
  const run = (code) => require('node:child_process').spawnSync(
    process.execPath, ['-e', `process.env.DB_PATH = ${JSON.stringify(dbp)};\n${code}`],
    { encoding: 'utf8', cwd: path.join(__dirname, '..') });

  // Import once so the schema and the staff exist.
  const first = run(`require(${BFP}).run(); console.log('SEEDED');`);
  assert.match(first.stdout, /SEEDED/, first.stdout + first.stderr);

  // Then clear it back to staff-only and introduce a second Sandra.
  const setup = run(`
    const D = require('better-sqlite3');
    const db = new D(process.env.DB_PATH);
    db.prepare('DELETE FROM work').run();
    db.prepare('DELETE FROM server_sales').run();
    db.prepare('DELETE FROM shifts').run();
    db.prepare("DELETE FROM settings WHERE key = 'backfill_2026_05_07'").run();
    db.prepare("UPDATE employees SET name = 'Sandra Moyer' WHERE LOWER(name) LIKE 'sandra%'").run();
    db.prepare("INSERT INTO employees (name, role, hourly_rate_cents, active) VALUES ('Sandra Quinn','server',1000,1)").run();
    console.log('READY');
  `);
  assert.match(setup.stdout, /READY/, setup.stdout + setup.stderr);

  const out = run(`
    try { require(${BFP}).run({ force: true }); console.log('NO ERROR'); }
    catch (e) { console.log('THREW: ' + e.message); }
  `);
  assert.match(out.stdout, /THREW: "Sandra" matches 2 people \(Sandra Moyer, Sandra Quinn\)/,
    out.stdout + out.stderr);
  assert.match(out.stdout, /Rename them in ZWIN/, 'and says what to do about it');

  const after = run(`
    const D = require('better-sqlite3');
    console.log('SHIFTS=' + new D(process.env.DB_PATH, { readonly: true })
      .prepare('SELECT COUNT(*) n FROM shifts').get().n);
  `);
  assert.match(after.stdout, /SHIFTS=0/, 'and nothing was written');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('per-shift wages are kept, not flattened to one rate per person', () => {
  // Esther is $15 as a barista and $7 on the days she serves. Reading the wage
  // off the employee record instead of the shift would misstate both.
  const esther = db.prepare("SELECT id FROM employees WHERE LOWER(name) = 'esther'").get();
  const rates = db.prepare('SELECT DISTINCT hourly_rate_cents c FROM work WHERE employee_id = ? ORDER BY c').all(esther.id).map((r) => r.c);
  assert.deepStrictEqual(rates, [700, 1500]);
  const server7 = db.prepare("SELECT COUNT(*) n FROM work WHERE employee_id = ? AND role='server' AND hourly_rate_cents=700").get(esther.id).n;
  assert.strictEqual(server7, 6, 'the six server days are the $7 ones');
});

test('training hours are paid but stay out of the tip pools', () => {
  const rows = db.prepare(`SELECT s.date, e.name, w.hours FROM work w
    JOIN employees e ON e.id = w.employee_id JOIN shifts s ON s.id = w.shift_id
    WHERE w.role = 'training' ORDER BY s.date`).all();
  assert.strictEqual(rows.length, 4);
  // 07/07 Arabella had no role in the sheet and was never paid for 4.37 hours.
  const ara = rows.find((r) => r.date === '2026-07-07');
  assert.ok(ara && ara.name.toLowerCase().startsWith('arabella'), 'Arabella 07/07 is in');
  assert.strictEqual(ara.hours, 4.37, 'and gets her hours');

  assert.strictEqual(db.prepare("SELECT kind FROM positions WHERE slug='training'").get().kind,
    'non_tipped', 'training takes no share of the pools');
});

test('a training position that already exists with the wrong kind is corrected', () => {
  // The default seed has no training position at all, so a fresh database gets
  // a correct one and the corrective branch never runs. Production may already
  // have one added through the UI — and if its kind is 'support', four
  // training shifts draw a share of the pools their staff never received.
  // Pool totals still reconcile in that case, so nothing else would notice.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bf4-'));
  const dbp = path.join(tmp, 'e.db');
  const BFP = JSON.stringify(path.join(__dirname, '..', 'src', 'backfill'));
  const run = (code) => require('node:child_process').spawnSync(
    process.execPath, ['-e', `process.env.DB_PATH = ${JSON.stringify(dbp)};\n${code}`],
    { encoding: 'utf8', cwd: path.join(__dirname, '..') });

  const seed = run(`
    require(${BFP});
    const D = require('better-sqlite3');
    const db = new D(process.env.DB_PATH);
    db.prepare("INSERT INTO positions (slug, name, kind, sort, active) VALUES ('training','Training','support',60,1)").run();
    console.log('KIND=' + db.prepare("SELECT kind FROM positions WHERE slug='training'").get().kind);
  `);
  assert.match(seed.stdout, /KIND=support/, seed.stdout + seed.stderr);

  const out = run(`
    const r = require(${BFP}).run();
    const D = require('better-sqlite3');
    const db = new D(process.env.DB_PATH, { readonly: true });
    console.log('ACTION=' + r.report.training);
    console.log('KIND=' + db.prepare("SELECT kind FROM positions WHERE slug='training'").get().kind);
  `);
  assert.match(out.stdout, /ACTION=corrected/, `it noticed and said so: ${out.stdout}${out.stderr}`);
  assert.match(out.stdout, /KIND=non_tipped/, 'and fixed it before importing a single row');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the counter and to-go pools came across', () => {
  const t = db.prepare('SELECT SUM(pool_jar_cents) jar, SUM(pool_togo_card_cents) card FROM shifts').get();
  assert.ok(t.card > 500000, `to-go card tips imported, got ${t.card}`);
  assert.ok(t.jar > 0, 'and the cash jar');
});

test('the four days with no sales still pay their staff', () => {
  // 05/07, 05/08, 05/09 and 05/13 have hours and counter tips but no server
  // sales. They are real shifts somebody worked, not blank rows to drop.
  for (const date of ['2026-05-07', '2026-05-08', '2026-05-09', '2026-05-13']) {
    const sh = db.prepare('SELECT id FROM shifts WHERE date = ?').get(date);
    assert.ok(sh, `${date} exists`);
    const work = db.prepare('SELECT COUNT(*) n FROM work WHERE shift_id = ?').get(sh.id).n;
    assert.ok(work > 0, `${date} has staff`);
    const sales = db.prepare('SELECT COUNT(*) n FROM server_sales WHERE shift_id = ?').get(sh.id).n;
    assert.strictEqual(sales, 0, `${date} has no sales, as in the sheet`);
  }
});

test('restaurant totals are left empty for the owner to enter', () => {
  // The sheet records what SERVERS rang, which is not the whole restaurant —
  // counter and to-go revenue is not in it. Writing server sales into the
  // restaurant total would understate every day and quietly corrupt labour %.
  const t = db.prepare(`SELECT COUNT(*) n FROM shifts
    WHERE total_food_cents + total_coffee_cents + total_alcohol_cents + total_other_cents > 0`).get().n;
  assert.strictEqual(t, 0, 'no service claims a restaurant total it does not have');
  const ss = db.prepare('SELECT COUNT(*) n FROM server_sales').get().n;
  assert.strictEqual(ss, 90, 'while server sales are all there');
});
