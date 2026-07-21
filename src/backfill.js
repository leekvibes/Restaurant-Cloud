'use strict';

// ---------------------------------------------------------------------------
// BACKFILL — the two months before ZWIN.
//
// 05/07/2026 to 07/17/2026, from the Google Sheet that ran the restaurant
// until ZWIN took over on the 18th. Everything before that date used a
// different busser rule (2% of gross sales, not 13% of remaining tips), so the
// history is stamped with a policy version that says so and is never
// recomputed under today's rules.
//
// Three properties this has to hold, in order of how much they would hurt:
//
//   1. It never runs twice. Guarded by a marker, and it skips any date that
//      already exists — a duplicated service is a duplicated paycheck.
//   2. It is all-or-nothing. One transaction; a failure leaves no trace.
//   3. It cannot take the site down. If it throws, it rolls back, logs, and
//      lets the app boot. A missing backfill is recoverable; a server that
//      will not start is not.
//
// The data file it reads was produced by scripts/parse-tipsheet.js and checked
// against the sheet's own Section B arithmetic on all 68 trading days before
// it was committed.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');
// Declare what this needs rather than relying on load order. policy.js owns
// policy_versions, modules.js owns the invoice tables metrics reads, and
// `settings` is created by whichever module happens to boot first — which is
// nothing at all when this file is loaded on its own.
require('./modules');
require('./policy');
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);');

const MARKER = 'backfill_2026_05_07';
const DATA = path.join(__dirname, '..', 'data', 'backfill-2026.json');

// The rules that ran until 18 July 2026. Kitchen, barista and bartender match
// today's; the busser is the difference and the whole reason this exists.
const HISTORIC_RULES = [
  { type: 'tipout', recipient: 'kitchen', percent: 1.5, base: 'food', split: 'hours' },
  { type: 'tipout', recipient: 'barista', percent: 1.5, base: 'coffee', split: 'hours' },
  { type: 'tipout', recipient: 'bartender', percent: 5, base: 'alcohol', split: 'hours' },
  { type: 'tipout', recipient: 'busser', percent: 2, base: 'total_sales', split: 'hours' },
  { type: 'pool', source: 'jar_togo', split: 'hours', among: 'all_support', payout: 'weekly_cash' },
];
const POLICY_FROM = '2026-05-07 00:00:00';

const ROLE = {
  'server': 'server',
  'kitchen': 'kitchen',
  'barista': 'barista',
  'bartender': 'bartender',
  'busser/dishwasher': 'busser',
  'busser': 'busser',
  'training': 'training',
};

// The workbook was typed by several people over two months. "hendy", "Hendy"
// and "Stephaine" are all one person, and matching on the raw string would
// create three staff records and split somebody's pay across them.
const canon = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
const FIXES = { stephaine: 'stephanie' };

// Hours on these tabs came out of Connecteam as h.mm — 9.30 means nine hours
// and thirty minutes, not 9.3 hours. Everything from 05/23 carries a header
// that says "Hours (decimal)" and is already right. 05/13 was entered decimal
// by hand despite sitting inside the block, confirmed by the owner.
const HHMM_FROM = '2026-05-09';
const HHMM_TO = '2026-05-22';
const HHMM_EXCEPT = new Set(['2026-05-13']);
const isHhmm = (date) => date >= HHMM_FROM && date <= HHMM_TO && !HHMM_EXCEPT.has(date);

function toDecimalHours(value, date) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (!isHhmm(date)) return Math.round(n * 100) / 100;
  const h = Math.floor(n);
  const mins = Math.round((n - h) * 100);
  if (mins > 59) throw new Error(`${date}: ${n} is not a valid h.mm value`);
  return Math.round((h + mins / 60) * 100) / 100;
}

const money = (c) => '$' + (Math.round(c) / 100).toFixed(2);

/** Has it already run? */
const done = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MARKER);
  return !!(row && row.value);
};

function loadData() {
  if (!fs.existsSync(DATA)) return null;
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}

/**
 * Training must exist and must be non-tipped before a single row is written.
 *
 * `kindOf` falls back to 'support' for a slug it does not know, and the
 * default seed has no training position — so on a database where nobody had
 * added one, four training shifts would have been classified as tipped
 * support and taken a share of the pools their staff never received. The pool
 * TOTALS still reconcile in that case, which is why this was invisible until
 * the per-person figures were checked.
 */
function ensureTrainingPosition() {
  const row = db.prepare("SELECT id, kind FROM positions WHERE slug = 'training'").get();
  if (!row) {
    db.prepare("INSERT INTO positions (slug, name, kind, sort, active) VALUES ('training','Training','non_tipped',60,1)").run();
    return 'created';
  }
  if (row.kind !== 'non_tipped') {
    db.prepare("UPDATE positions SET kind = 'non_tipped' WHERE id = ?").run(row.id);
    return 'corrected';
  }
  return 'ok';
}

/** The policy version the backfilled services are stamped with. */
function historicPolicy() {
  const found = db.prepare(
    "SELECT id FROM policy_versions WHERE daypart='cafe' AND note = 'Pre-ZWIN policy (busser 2% of gross sales)'").get();
  if (found) return found.id;
  // effective_from is set in the past deliberately: `latest` orders by it, so
  // inserting this must NOT make it the current policy. Today's 13% rule has
  // to stay the one new services are stamped with.
  return db.prepare(`INSERT INTO policy_versions (daypart, rules_json, note, effective_from)
    VALUES ('cafe', ?, 'Pre-ZWIN policy (busser 2% of gross sales)', ?)`)
    .run(JSON.stringify(HISTORIC_RULES), POLICY_FROM).lastInsertRowid;
}

/**
 * Find a person, or make one. Wages live per shift, so nothing is written to
 * the employee record beyond a starting rate.
 *
 * The sheet uses first names; ZWIN may hold full ones. "Sandra" and "Sandra
 * Moyer" are one person, and importing them as two splits sixty shifts of pay
 * across two records that each look half right. So an exact match is tried
 * first, then a first-name match — but ONLY when it is unambiguous. Two people
 * called Sandra is a question for the owner, not something to guess at.
 */
function employeeFor(name, roleSlug, wageCents, cache, report) {
  const key = FIXES[canon(name)] || canon(name);
  if (cache.has(key)) return cache.get(key);

  const rows = db.prepare('SELECT id, name FROM employees').all();
  const keyOf = (n) => FIXES[canon(n)] || canon(n);

  const exact = rows.find((r) => keyOf(r.name) === key);
  if (exact) { cache.set(key, exact.id); return exact.id; }

  const first = key.split(' ')[0];
  const byFirst = rows.filter((r) => keyOf(r.name).split(' ')[0] === first);
  if (byFirst.length === 1) {
    if (report) report.matched.push(`"${name}" -> existing "${byFirst[0].name}"`);
    cache.set(key, byFirst[0].id);
    return byFirst[0].id;
  }
  if (byFirst.length > 1) {
    throw new Error(`"${name}" matches ${byFirst.length} people (${byFirst.map((r) => r.name).join(', ')}). `
      + 'Rename them in ZWIN so the sheet can be matched to exactly one, then re-run.');
  }

  const pretty = key.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const id = db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pay_type)
    VALUES (?, ?, ?, 1, 'hourly')`).run(pretty, roleSlug || 'server', wageCents || 0).lastInsertRowid;
  if (report) report.created.push(pretty);
  cache.set(key, id);
  return id;
}

/**
 * Write every day. Returns a report; throws to abort the whole thing.
 * `dryRun` rolls back at the end so the same code path is what gets verified.
 */
function apply(days, opts = {}) {
  const training = ensureTrainingPosition();
  const policyId = historicPolicy();
  const cache = new Map();
  const report = { inserted: [], skipped: [], staff: 0, servers: 0, created: [], matched: [], training };

  const existing = new Set(db.prepare("SELECT date, daypart FROM shifts").all().map((r) => r.date + '|' + r.daypart));

  const insShift = db.prepare(`INSERT INTO shifts
    (date, daypart, status, policy_id, pool_jar_cents, pool_togo_card_cents,
     total_food_cents, total_coffee_cents, total_alcohol_cents, total_other_cents)
    VALUES (@date, 'cafe', @status, @policy_id, @jar, @togo_card, 0, 0, 0, 0)`);
  const insWork = db.prepare(`INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents)
    VALUES (?, ?, ?, ?, ?)`);
  const insSales = db.prepare(`INSERT INTO server_sales
    (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  for (const d of days) {
    if (existing.has(`${d.date}|cafe`)) { report.skipped.push({ date: d.date, why: 'a service already exists' }); continue; }

    const shiftId = insShift.run({
      date: d.date,
      // These are historical and settled. "emailed" is what a finished service
      // looks like; it keeps them out of the dashboard's needs-attention list.
      status: 'emailed',
      policy_id: policyId,
      jar: (d.counter && d.counter.jar) || 0,
      togo_card: (d.counter && d.counter.card) || 0,
    }).lastInsertRowid;

    const seen = new Set();
    for (const s of d.staff) {
      const slug = ROLE[String(s.role || '').trim().toLowerCase()];
      // 07/07 Arabella has no role and was never paid for 4.37 hours. The
      // owner confirmed she was training that day.
      const role = slug || 'training';
      const empId = employeeFor(s.name, role, s.wage, cache, report);
      if (seen.has(empId)) { report.skipped.push({ date: d.date, why: `${s.name} listed twice` }); continue; }
      seen.add(empId);
      insWork.run(shiftId, empId, role, toDecimalHours(s.hours, d.date), s.wage || 0);
      report.staff++;
    }

    for (const sv of d.servers) {
      const empId = employeeFor(sv.name, 'server', null, cache, report);
      insSales.run(shiftId, empId, sv.food || 0, sv.coffee || 0, sv.alcohol || 0,
        sv.cardTips || 0, sv.cashTips || 0);
      report.servers++;
    }

    report.inserted.push({ date: d.date, id: shiftId, staff: d.staff.length, servers: d.servers.length });
  }

  if (opts.dryRun) throw { rollback: true, report };
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(MARKER, new Date().toISOString());
  return report;
}

/** Run inside one transaction. Nothing partial ever lands. */
function run(opts = {}) {
  const days = loadData();
  if (!days) return { ran: false, why: 'no data file' };
  if (!opts.force && done()) return { ran: false, why: 'already applied' };

  const tx = db.transaction((d, o) => apply(d, o));
  try {
    const report = tx(days, opts);
    return { ran: true, report };
  } catch (e) {
    if (e && e.rollback) return { ran: false, why: 'dry run', report: e.report };
    throw e;
  }
}

module.exports = { run, apply, ensureTrainingPosition, toDecimalHours, canon, FIXES, ROLE, HISTORIC_RULES, MARKER, done, loadData, money, isHhmm };
