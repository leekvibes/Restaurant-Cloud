'use strict';

// Pay periods as a real thing rather than a date range you retype each time.
//
// The payroll page used to default to "the last 14 days ending today", which is
// never actually a pay period — on 07/18 that's 07/05–07/18, while the period
// that just ended was 07/04–07/17. Worse, the week-1/week-2 split is computed
// as start + 7 days, so a start date that's off by one silently moves hours
// into the wrong week. Anchoring to a known period start fixes both.

const { db } = require('./db');
const { isoDate, startOfToday, addDays } = require('./dates');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS period_sends (
  period_start TEXT PRIMARY KEY,
  period_end   TEXT NOT NULL,
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_count   INTEGER NOT NULL DEFAULT 0
);
`);

const Q = {
  get: db.prepare('SELECT value FROM settings WHERE key = ?'),
  set: db.prepare('INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  sendFor: db.prepare('SELECT * FROM period_sends WHERE period_start = ?'),
  markSent: db.prepare(`INSERT INTO period_sends (period_start, period_end, sent_count, sent_at)
    VALUES (@start, @end, @count, datetime('now'))
    ON CONFLICT(period_start) DO UPDATE SET sent_count = excluded.sent_count, sent_at = excluded.sent_at`),
};

const getSetting = (k, fallback = null) => {
  const row = Q.get.get(k);
  return row && row.value != null ? row.value : fallback;
};
const setSetting = (key, value) => Q.set.run({ key, value: String(value) });

const DEFAULT_ANCHOR = '2026-07-04'; // Malek's period start
const DEFAULT_LENGTH = 14;

const anchor = () => getSetting('period_anchor', DEFAULT_ANCHOR);
const periodLength = () => Number(getSetting('period_length', DEFAULT_LENGTH)) || DEFAULT_LENGTH;

const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

/** The period containing `date`, as {start, end}. */
function periodFor(date) {
  const a = anchor();
  const len = periodLength();
  // Floor division so dates before the anchor still land on a whole period.
  const idx = Math.floor(daysBetween(a, date) / len);
  const start = addDays(a, idx * len);
  return { start, end: addDays(start, len - 1) };
}

const currentPeriod = () => periodFor(isoDate(startOfToday()));

/** Recent periods, newest first — current, then the ones before it. */
function recentPeriods(count = 8) {
  const len = periodLength();
  const cur = currentPeriod();
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = addDays(cur.start, -i * len);
    out.push({ start, end: addDays(start, len - 1) });
  }
  return out;
}

const fmtRange = (p) => `${p.start} → ${p.end}`;

/** Human label: "Jul 4 – Jul 17". */
function labelFor(p) {
  const m = (d) => {
    const [, mo, da] = d.split('-').map(Number);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1] + ' ' + da;
  };
  return `${m(p.start)} – ${m(p.end)}`;
}

/** Is this range exactly one of our periods? Custom ranges skip period features. */
function isPeriod(from, to) {
  const p = periodFor(from);
  return p.start === from && p.end === to;
}

const sendRecord = (start) => Q.sendFor.get(start) || null;
const markSent = (start, end, count) => Q.markSent.run({ start, end, count });

module.exports = {
  getSetting, setSetting, anchor, periodLength, periodFor, currentPeriod,
  recentPeriods, labelFor, fmtRange, isPeriod, sendRecord, markSent,
};
