'use strict';

// The sales trend and the range guard. Both are pure functions, and both had
// bugs that only showed as a shape on a chart or a dead server — which is
// exactly the kind of thing an end-to-end assertion misses.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-trend-')), 't.db');
const CH = require('../src/charts');
const MX = require('../src/metrics');

const pointsOf = (svg) => [...svg.matchAll(/<polyline points="([^"]+)"/g)].flatMap((m) => m[1].split(' '));
const circlesOf = (svg) => (svg.match(/<circle[^>]*r="2\.75"/g) || []).length;

// --- gaps in a line ---------------------------------------------------------

test('a null point breaks the line rather than dropping it to the axis', () => {
  // A day with no service, or a service whose sales have not been entered, is
  // not a day that took nothing. Drawn at zero it reads as a catastrophe.
  const v = [{ x: '1', y: 100 }, { x: '2', y: 150 }, { x: '3', y: null }, { x: '4', y: 300 }, { x: '5', y: 280 }];
  const svg = CH.lineChart([{ label: 'Sales', values: v, area: true }], { height: 200 });
  assert.strictEqual((svg.match(/<polyline/g) || []).length, 2, 'two segments, not one');
  assert.strictEqual((svg.match(/<polygon/g) || []).length, 2, 'and the fill breaks with it');
});

test('the gap is not drawn anywhere, least of all on the zero line', () => {
  const v = [{ x: '1', y: 100 }, { x: '2', y: null }, { x: '3', y: 100 }];
  const svg = CH.lineChart([{ label: 'Sales', values: v }], { height: 200 });
  const baseline = 200 - 22;
  const onAxis = pointsOf(svg).concat(
    [...svg.matchAll(/<circle[^>]*cy="([\d.]+)"[^>]*r="2\.75"/g)].map((m) => `0,${m[1]}`),
  ).filter((p) => Math.abs(Number(p.split(',')[1]) - baseline) < 0.6);
  assert.strictEqual(onAxis.length, 0, `nothing sits at zero, found ${onAxis.length}`);
});

test('a point with gaps either side is a dot, because a line needs two', () => {
  const v = [{ x: '1', y: null }, { x: '2', y: 500 }, { x: '3', y: null }];
  const svg = CH.lineChart([{ label: 'Sales', values: v }], { height: 200 });
  assert.strictEqual((svg.match(/<polyline/g) || []).length, 0, 'no line to draw');
  assert.strictEqual(circlesOf(svg), 1, 'so the day is a dot instead of invisible');
});

test('a real zero is still drawn — it is a different fact from no data', () => {
  // A service that opened and genuinely sold nothing is a zero and should look
  // like one. Only null means "we do not know".
  const svg = CH.lineChart([{ label: 'Sales', values: [{ x: '1', y: 100 }, { x: '2', y: 0 }, { x: '3', y: 90 }] }], { height: 200 });
  assert.strictEqual((svg.match(/<polyline/g) || []).length, 1, 'one unbroken line');
  const baseline = 200 - 22;
  assert.ok(pointsOf(svg).some((p) => Math.abs(Number(p.split(',')[1]) - baseline) < 0.6), 'and it touches zero');
});

test('the hover readout says "no service" instead of $0.00', () => {
  const svg = CH.lineChart([{ label: 'Sales', values: [{ x: 'Mon', y: 100 }, { x: 'Tue', y: null }] }], { height: 200 });
  assert.match(svg, /Sales: no service/);
  assert.ok(!/Tue — Sales: \$0\.00/.test(svg), 'a closed Tuesday is not a $0 Tuesday');
});

// --- the range guard --------------------------------------------------------

test('a custom range must be two real dates', () => {
  const today = '2026-07-21';
  const bad = [
    ['bad', 'worse'],                 // 'bad' <= 'worse' is true as strings
    ['2026-02-30', '2026-03-01'],     // shaped like a date, is not one
    ['2026-13-01', '2026-13-05'],
    ['2026-07-01', '2026-06-01'],     // backwards
    ['', ''],
    [null, undefined],
  ];
  for (const [from, to] of bad) {
    const r = MX.range('custom', today, { from, to });
    assert.strictEqual(r.label, 'Last 30 days', `${from}..${to} falls back`);
    assert.ok(MX.isDate(r.from) && MX.isDate(r.to), 'to a range that is safe to iterate');
  }
  const good = MX.range('custom', today, { from: '2026-05-01', to: '2026-07-21' });
  assert.deepStrictEqual([good.from, good.to, good.label], ['2026-05-01', '2026-07-21', 'Custom']);
});

test('days() refuses to iterate a range it cannot finish', () => {
  // Independently of the guard above, because two things preventing the same
  // crash means neither of them is tested by "the page still loads".
  assert.deepStrictEqual(MX.days('bad', 'worse'), []);
  assert.deepStrictEqual(MX.days('2026-07-05', '2026-07-01'), [], 'backwards is empty, not infinite');
  assert.strictEqual(MX.days('2026-07-01', '2026-07-07').length, 7);
  // A decade is the most it will ever build, whatever it is asked for.
  assert.ok(MX.days('1900-01-01', '2099-01-01').length <= 3661);
});

test('a day with no service is marked as such, not as a zero-sales day', () => {
  const d = MX.days('2026-07-01', '2026-07-03');
  assert.strictEqual(d.length, 3);
  for (const x of d) {
    assert.strictEqual(x.had, false, 'no shifts exist in this empty database');
    assert.strictEqual(x.sales, 0, 'sales read zero, but `had` is what says whether that means anything');
  }
});

// --- the withheld percentage ----------------------------------------------------
//
// The dashboard has a `hasCogs` guard, but the rule is enforced one level
// down in metrics: a mutation to the guard is unobservable because this is
// what actually holds the line. So this is where it gets tested.

test('a percentage of nothing is null, never zero', () => {
  const p = MX.period('2026-07-01', '2026-07-07');   // empty database
  assert.strictEqual(p.sales, 0, 'no sales in this fixture');
  assert.strictEqual(p.cogs, 0, 'and no invoices');
  // 0/0 is not 0%. It is unanswerable, and printing 0% food cost reads as
  // extraordinarily good news.
  assert.strictEqual(p.laborPct, null, 'labor is withheld');
  assert.strictEqual(p.foodPct, null, 'food is withheld');
  assert.strictEqual(p.primePct, null, 'prime is withheld');
});

test('a real zero is still a zero — the rule is about missing data', () => {
  // Sales with no invoices: food cost is unknown, not free. Labor IS knowable.
  const rows = [{ sales: 100000, wages: 20000, hours: 10, tips: 0, food: 100000, coffee: 0, alcohol: 0, other: 0, server_sales: 0, date: '2026-07-02', daypart: 'cafe' }];
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  assert.strictEqual(pct(20000, 100000), 20, 'labor computes when sales exist');
  assert.strictEqual(pct(0, 0), null, 'and withholds when they do not');
  assert.ok(rows.length);
});
