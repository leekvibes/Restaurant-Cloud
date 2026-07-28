'use strict';

// The comparison windows Performance leans on. The one rule that matters here:
// every comparison is LENGTH-MATCHED to the current range, so a partial or
// short month is never weighed against a longer one — that would invent
// movement out of the calendar rather than the trade.

const test = require('node:test');
const assert = require('node:assert');
const MX = require('../src/metrics');

const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000) + 1;

test('every comparison mode is length-matched to the current range', () => {
  const cases = [
    ['2026-06-28', '2026-07-27', 30], // 30-day window
    ['2026-07-01', '2026-07-27', 27], // month-to-date
    ['2026-03-01', '2026-03-31', 31], // a full 31-day month
    ['2026-07-21', '2026-07-27', 7],  // a week
  ];
  for (const [from, to, span] of cases) {
    for (const mode of ['prev', 'week', 'month']) {
      const c = MX.compare(from, to, mode);
      assert.strictEqual(days(c.from, c.to), span,
        `${mode} of a ${span}-day range must also be ${span} days, got ${days(c.from, c.to)}`);
    }
  }
});

test('month-to-date compares to the same days of the previous month', () => {
  const c = MX.compare('2026-07-01', '2026-07-27', 'month');
  assert.strictEqual(c.from, '2026-06-01', 'starts the 1st of the prior month');
  assert.strictEqual(c.to, '2026-06-27', 'and runs to the same day-of-month');
});

test('a 31-day month is NOT measured against 28 days of February', () => {
  // The bug this guards: monthBack on both ends gave Feb 1–28 for March 1–31,
  // a 28-day window, so an identical daily rate read as +10.7%.
  const c = MX.compare('2026-03-01', '2026-03-31', 'month');
  assert.strictEqual(days(c.from, c.to), 31, 'the comparison window is a full 31 days');
});

test('same days last week shifts the whole window back exactly seven days', () => {
  const c = MX.compare('2026-07-21', '2026-07-27', 'week');
  assert.strictEqual(c.from, '2026-07-14');
  assert.strictEqual(c.to, '2026-07-20');
});

test('no comparison means no window', () => {
  assert.strictEqual(MX.compare('2026-07-01', '2026-07-27', 'none'), null);
});

test('monthBack clamps to a real day when the prior month is shorter', () => {
  assert.strictEqual(MX.monthBack('2026-03-31'), '2026-02-28', 'Feb has no 31st');
  assert.strictEqual(MX.monthBack('2026-01-15'), '2025-12-15', 'and it rolls the year back');
});
