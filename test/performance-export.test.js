'use strict';

// THE PERFORMANCE WORKBOOK.
//
// The owner: "my boss is asking for sales for X amount of time and costs, so
// like invoices payroll etc. I need to be able to get him a detailed excel ...
// when I click download excel it does all the data for me for the date range
// I selected."
//
// So the thing being tested is not "a file downloads". It is that the file
// holds the period that was on screen, that its figures are the same ones the
// Performance page shows, and that every cost the app knows about is in it —
// because the person reading it cannot open the app to check.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ExcelJS = require('exceljs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-perf-'));
process.env.DB_PATH = path.join(dir, 'perf.db');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';
process.env.APP_PASSWORD = '';

const { db } = require('./../src/db');
require('../src/services');
require('../src/policy');
const MX = require('../src/metrics');
const { buildPerformanceWorkbook } = require('../src/reports');

const PORT = 4017;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

// A fortnight: two services a day on three days, bills, and one expense.
const FROM = '2026-06-01';
const TO = '2026-06-14';

function money(x) { return Math.round(x * 100); }

test.before(async () => {
  const emp = db.prepare(`INSERT INTO employees (name, role, hourly_rate_cents, active, pin)
    VALUES (?, ?, ?, 1, ?)`);
  const server = Number(emp.run('Perf Server', 'server', 1000, '9101').lastInsertRowid);
  const busser = Number(emp.run('Perf Busser', 'busser', 1300, '9102').lastInsertRowid);

  const mkShift = (date, daypart, food, coffee, alcohol, cardTips) => {
    db.prepare(`INSERT INTO shifts (date, daypart, status, total_food_cents, total_coffee_cents,
      total_alcohol_cents, total_other_cents) VALUES (?, ?, 'emailed', ?, ?, ?, 0)`)
      .run(date, daypart, money(food), money(coffee), money(alcohol));
    const id = db.prepare('SELECT id FROM shifts WHERE date = ? AND daypart = ?').get(date, daypart).id;
    db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)').run(id, server, 'server', 8);
    db.prepare('INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?,?,?,?)').run(id, busser, 'busser', 5);
    db.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents,
      card_tips_cents, cash_tips_cents) VALUES (?,?,?,?,?,?,0)`)
      .run(id, server, money(food), money(coffee), money(alcohol), money(cardTips));
    return id;
  };
  mkShift('2026-06-02', 'cafe', 1000, 200, 0, 150);
  mkShift('2026-06-02', 'dinner', 1500, 0, 500, 300);
  mkShift('2026-06-03', 'cafe', 900, 100, 0, 120);
  mkShift('2026-06-10', 'cafe', 1100, 150, 0, 160);
  // Outside the range on both sides: neither may appear in the workbook.
  mkShift('2026-05-28', 'cafe', 9999, 0, 0, 0);
  mkShift('2026-06-20', 'cafe', 8888, 0, 0, 0);

  db.prepare("INSERT INTO m_vendors (name) VALUES ('Perf Produce')").run();
  db.prepare("INSERT INTO m_vendors (name) VALUES ('Perf Linen')").run();
  const v = db.prepare('SELECT id, name FROM m_vendors').all();
  const vid = (n) => v.find((x) => x.name === n).id;
  const bill = db.prepare(`INSERT INTO m_invoices (invoice_date, vendor_id, amount_cents, category, status, invoice_number)
    VALUES (?,?,?,?,?,?)`);
  bill.run('2026-06-02', vid('Perf Produce'), money(400), 'Food', 'paid', 'PP-1');
  bill.run('2026-06-09', vid('Perf Produce'), money(250), 'Food', 'unpaid', 'PP-2');
  bill.run('2026-06-09', vid('Perf Linen'), money(100), 'Linen', 'paid', 'PL-1');
  bill.run('2026-05-20', vid('Perf Produce'), money(7777), 'Food', 'paid', 'OLD');   // before the range
  db.prepare(`INSERT INTO m_expenses (spent_on, name, where_bought, category, amount_cents, paid_by)
    VALUES ('2026-06-05', 'Ice machine part', 'Hardware store', 'Maintenance', ?, 'Malek')`).run(money(60));

  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.after(() => { if (child) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

/** The workbook the route returns, parsed back into sheets. */
async function download(qs) {
  const res = await fetch(`${BASE}/costs/export?${qs}`);
  assert.strictEqual(res.status, 200, 'the export answers');
  assert.match(res.headers.get('content-type') || '', /spreadsheet/, 'as a workbook, not a web page');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  return { wb, disposition: res.headers.get('content-disposition') || '' };
}

/** Every cell of a sheet as plain strings, so a test can look for a figure. */
const cells = (ws) => {
  const out = [];
  ws.eachRow((row) => out.push(row.values.slice(1).map((v) => (v == null ? '' : String(v)))));
  return out;
};
const flat = (ws) => cells(ws).map((r) => r.join(' | ')).join('\n');
/** The value in the column after a label, on the row that starts with it. */
const valueFor = (ws, label, col = 2) => {
  let found = null;
  ws.eachRow((row) => { if (String(row.getCell(1).value || '').startsWith(label)) found = row.getCell(col).value; });
  return found;
};

test('the file holds the range that was on screen, and says so in its name', async () => {
  const { wb, disposition } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  assert.match(disposition, new RegExp(`performance_${FROM}_to_${TO}\\.xlsx`), 'named for the period');
  const sum = wb.getWorksheet('Summary');
  assert.match(String(sum.getCell('A2').value), /Jun 1, 2026 to Jun 14, 2026/, 'and dated for it inside');
  assert.match(String(sum.getCell('A2').value), /against/, 'with the comparison period named');
});

test('every sheet a boss would ask for is there, in reading order', async () => {
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name),
    ['Summary', 'Daily sales', 'Services', 'Labour', 'Costs summary', 'Invoices', 'Expenses']);
});

test('the summary totals are the same figures the Performance page shows', async () => {
  const page = MX.period(FROM, TO);
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  const sum = wb.getWorksheet('Summary');

  assert.strictEqual(valueFor(sum, 'Total sales'), page.sales / 100, 'sales match the page');
  assert.strictEqual(valueFor(sum, '— Food'), page.mix.food / 100);
  assert.strictEqual(valueFor(sum, '— Alcohol'), page.mix.alcohol / 100);
  assert.strictEqual(valueFor(sum, 'Labour (wages)'), page.wages / 100, 'wages match');
  assert.strictEqual(valueFor(sum, 'Food & drink invoices'), page.cogs / 100, 'and the food cost');
  assert.strictEqual(valueFor(sum, 'Labour % of sales'), page.laborPct);
  assert.strictEqual(valueFor(sum, 'Prime cost % of sales'), page.primePct);
  assert.strictEqual(valueFor(sum, 'Gross profit'), page.grossProfit / 100);

  // Costs are the three kinds added up, not just the invoices.
  assert.strictEqual(valueFor(sum, 'Total costs recorded'),
    (page.wages + page.invoiceTotal + 6000) / 100, 'wages + every bill + out-of-pocket');
});

test('nothing outside the range gets in', async () => {
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  for (const name of ['Daily sales', 'Services', 'Invoices', 'Costs summary']) {
    const text = flat(wb.getWorksheet(name));
    assert.ok(!text.includes('9999'), `${name} leaves out the service before the range`);
    assert.ok(!text.includes('8888'), `${name} leaves out the one after it`);
    assert.ok(!text.includes('7777'), `${name} leaves out the bill before the range`);
  }
  const days = cells(wb.getWorksheet('Daily sales')).filter((r) => /^2026-06-\d\d$/.test(r[0]));
  assert.strictEqual(days.length, 14, 'a row for every day of the period, quiet days included');
  assert.strictEqual(days[0][0], '2026-06-01');
  assert.strictEqual(days[days.length - 1][0], '2026-06-14');
});

test('the services sheet names the service the way the restaurant does', async () => {
  const SVC = require('../src/services');
  SVC.rename('cafe', 'Day Service');
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  const text = flat(wb.getWorksheet('Services'));
  assert.ok(text.includes('Day Service'), 'the owner’s name for it, not "cafe"');
  assert.ok(!/\bcafe\b/.test(text), 'and never the internal key');
});

test('the bills and the out-of-pocket spend are both there, and both add up', async () => {
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  const inv = flat(wb.getWorksheet('Invoices'));
  assert.ok(inv.includes('Perf Produce') && inv.includes('PP-1'), 'invoices name the vendor and the bill');
  assert.ok(inv.includes('Perf Linen'), 'including the ones that are not food');
  const invTotal = valueFor(wb.getWorksheet('Invoices'), 'TOTAL', 8);
  assert.strictEqual(invTotal, 750, '$400 + $250 + $100, and not the $7,777 from May');

  const exp = flat(wb.getWorksheet('Expenses'));
  assert.ok(exp.includes('Ice machine part') && exp.includes('Hardware store'));
  assert.strictEqual(valueFor(wb.getWorksheet('Expenses'), 'TOTAL', 8), 60);

  // The costs summary splits the same money three ways and keeps the totals.
  const cost = flat(wb.getWorksheet('Costs summary'));
  assert.ok(/INVOICES BY CATEGORY/.test(cost) && /INVOICES BY VENDOR/.test(cost)
    && /OUT-OF-POCKET EXPENSES/.test(cost), 'all three blocks');
  assert.ok(cost.includes('Linen'), 'a non-food category is named rather than lumped in');
});

test('the labour sheet is per person and only wages count as the cost', async () => {
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  const lab = wb.getWorksheet('Labour');
  const text = flat(lab);
  assert.ok(text.includes('Perf Server') && text.includes('Perf Busser'), 'everybody who worked');
  assert.match(text, /Wages are the only figure that counts as a cost/, 'and it says what is a cost and what is not');
  const sum = wb.getWorksheet('Summary');
  assert.strictEqual(valueFor(lab, 'TOTAL', 5), valueFor(sum, 'Labour (wages)'),
    'the labour total is the same number the summary calls labour');
});

test('a named range works the same as a custom one, and a bad one does not crash it', async () => {
  const { disposition } = await download('r=30&c=prev');
  assert.match(disposition, /performance_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.xlsx/, 'last 30 days exports');
  const junk = await download('r=nonsense&from=not-a-date&to=also-not&c=rubbish');
  assert.match(junk.disposition, /performance_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.xlsx/,
    'nonsense falls back to the default period rather than failing');
});

test('with no comparison chosen, the file carries no empty comparison columns', async () => {
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=none`);
  const sum = wb.getWorksheet('Summary');
  assert.doesNotMatch(String(sum.getCell('A2').value || ''), /against/, 'the heading does not promise one');
  let head = null;
  sum.eachRow((row) => { if (String(row.getCell(2).value || '') === 'This period') head = row; });
  assert.ok(head, 'the figures are still there');
  assert.strictEqual(head.getCell(3).value || '', '', 'and the Previous column is left blank');
});

test('the Performance page offers the download, carrying the range you are looking at', async () => {
  const html = await (await fetch(`${BASE}/costs?r=custom&from=${FROM}&to=${TO}&c=prev`)).text();
  const link = (html.match(/href="\/costs\/export\?([^"]*)"/) || [])[1];
  assert.ok(link, 'the button is on the page');
  const got = new URLSearchParams(link.replace(/&amp;/g, '&'));
  assert.strictEqual(got.get('r'), 'custom');
  assert.strictEqual(got.get('from'), FROM, 'with the dates on screen');
  assert.strictEqual(got.get('to'), TO);
  assert.strictEqual(got.get('c'), 'prev', 'and the comparison on screen');
});

test('a figure that went down reads as down, and never with a minus sign', async () => {
  // The owner, shown a draft that printed "-23.8 pts": "I just don't want it to
  // be a negative symbol." A column with minuses scattered through it reads to
  // somebody skimming as though the report itself is broken, and the direction
  // is what they were looking for anyway. So the cell keeps the real signed
  // number — it still sorts, charts and sums — and only the way Excel paints it
  // changes. Excel's format is positive;negative;zero, and the negative part
  // shows the absolute value unless you ask for the sign.
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  const sum = wb.getWorksheet('Summary');
  let fell = 0;
  sum.eachRow((row) => {
    const label = String(row.getCell(1).value || '');
    [4, 5].forEach((i) => {
      const cell = row.getCell(i);
      if (typeof cell.value !== 'number' || cell.value >= 0) return;
      const parts = String(cell.numFmt || '').split(';');
      assert.ok(parts.length >= 2, `"${label}" has no negative format at all: ${cell.numFmt}`);
      assert.doesNotMatch(parts[1], /-/, `"${label}" would print a minus sign: ${cell.numFmt}`);
      assert.match(parts[1], /\u25bc/, `"${label}" does not say which way it moved: ${cell.numFmt}`);
      fell += 1;
    });
  });
  // Sales fell against the previous fortnight in this fixture, so if nothing
  // came back negative the test stopped proving anything.
  assert.ok(fell >= 3, `the fixture should contain figures that fell (found ${fell})`);
});

test('a rise is marked too, so the arrow means direction and not trouble', async () => {
  const { wb } = await download(`r=custom&from=${FROM}&to=${TO}&c=prev`);
  const sum = wb.getWorksheet('Summary');
  let rose = 0;
  sum.eachRow((row) => {
    const cell = row.getCell(4);
    if (typeof cell.value !== 'number' || cell.value <= 0) return;
    assert.match(String(cell.numFmt || '').split(';')[0], /\u25b2/,
      `"${row.getCell(1).value}" rose but is not marked as up: ${cell.numFmt}`);
    rose += 1;
  });
  assert.ok(rose >= 1, `the fixture should contain figures that rose (found ${rose})`);
});
