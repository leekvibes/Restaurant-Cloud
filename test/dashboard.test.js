'use strict';

// The dashboard is the one page that reads from every module at once, which
// makes it two things: the place a permissions mistake shows up as content
// rather than as a 403, and the place where "sales this week" has to agree
// with what Sales and Performance say or all three lose their credibility.
//
// The figures are asserted over HTTP against seeded shifts and invoices,
// because the arithmetic that matters happens between the query and the
// markup — averages that must divide by services with figures, percentages
// that must be withheld rather than printed as zero.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Each test file that spawns a server needs its own port: the suite runs
// files in parallel, and two of them binding 3967 fails whichever loses the
// race, not the one with the bug. This file uses PORT and PORT + 1.
const PORT = 3975;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-dash-'));
const DB = path.join(dir, 'd.db');
let child, Database, db;

const post = (p, body, cookie) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie: `rc_auth=${cookie}` } : {}) },
  body: new URLSearchParams(body).toString(),
});
const as = (cookie, p) => fetch(BASE + p, { redirect: 'manual', headers: { cookie: `rc_auth=${cookie}` } });
const login = async (body) => {
  const c = (await post('/login', body)).headers.get('set-cookie') || '';
  return (c.match(/rc_auth=([^;]*)/) || [])[1] || '';
};
const page = async (cookie) => {
  const r = await as(cookie, '/');
  assert.strictEqual(r.status, 200, 'the dashboard must render');
  return r.text();
};

// Today is fixed relative to the server's clock, so the seed is written
// backwards from it rather than to literal dates that would age out.
const iso = (d) => d.toISOString().slice(0, 10);
const back = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

test.before(async () => {
  Database = require('better-sqlite3');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: 'dash-owner-pw' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  db = new Database(DB);
  const emp = db.prepare('INSERT INTO employees (name, role, active, hourly_rate_cents) VALUES (?,?,1,?)');
  const cook = emp.run('Dash Cook', 'kitchen', 2000).lastInsertRowid;
  const shift = db.prepare(`INSERT INTO shifts (date, daypart, status, total_food_cents, total_coffee_cents)
    VALUES (?,?,?,?,0)`);
  const work = db.prepare('INSERT INTO work (shift_id, employee_id, role, hours, hourly_rate_cents) VALUES (?,?,?,?,?)');
  const inv = db.prepare(`INSERT INTO m_invoices (invoice_number, amount_cents, invoice_date, category, status)
    VALUES (?,?,?,?,'Paid')`);

  // Two weeks that differ enough for the week-on-week comparisons to have
  // something to say: last week sold more and ran leaner.
  //  days 8..14 -> $1,000 a service on 10 hours   (labor 20%)
  //  days 1..7  -> $1,500 a service on 10 hours   (labor ~13%)
  for (let d = 14; d >= 1; d--) {
    const sales = d > 7 ? 100000 : 150000;
    const id = shift.run(back(d), 'dinner', 'emailed', sales).lastInsertRowid;
    work.run(id, cook, 'kitchen', 10, 2000);
  }
  // Invoices in both weeks, so food cost and prime cost are answerable.
  inv.run('DASH-1', 30000, back(10), 'Food');
  inv.run('DASH-2', 30000, back(3), 'Food');
  db.close();
  db = new Database(DB, { readonly: true });
});
test.after(() => { if (child) child.kill(); if (db) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** An account with a role and an explicit feature list. */
async function account(email, role, features) {
  const owner = await login({ password: 'dash-owner-pw' });
  const body = [['name', 'A ' + email], ['email', email], ['password', 'acct-pw-1234'], ['role', role]];
  for (const f of features) body.push(['features', f]);
  await post('/users', body, owner);
  return login({ email, password: 'acct-pw-1234' });
}

// --- the figures ------------------------------------------------------------

// These three moved to /sales and /costs with the pages they belong to — a
// dashboard answers "what needs me today", and an average per service is a
// question about a period, not about this morning. The arithmetic they guard
// is unchanged, so they follow the numbers rather than being deleted with the
// cards that used to show them.

test('per-service figures come from completed services, not from today', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const sales = await (await as(owner, '/sales?r=30')).text();
  const perf = await (await as(owner, '/costs?r=30')).text();

  // Every seeded service is closed and today has none, so an average that
  // included today would be diluted by an empty service.
  assert.match(sales, /Per service[\s\S]{0,260}\$1,250/,
    'seven at $1,000 and seven at $1,500 average $1,250');
  assert.match(perf, /Sales per labor hour[\s\S]{0,260}\$125\.00/, '$1,250 over 10 hours');
});

test('an unfilled service does not drag the average down', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const before = await (await as(owner, '/sales?r=30')).text();
  assert.match(before, /Per service[\s\S]{0,260}\$1,250/);

  // A service logged but never filled in. It is a real row, and counting it
  // as a $0 service would report every night as worse than it was.
  const w = new Database(DB);
  w.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'cafe', 'open')").run(back(2));
  w.close();

  const after = await (await as(owner, '/sales?r=30')).text();
  assert.match(after, /Per service[\s\S]{0,260}\$1,250/, 'the average is unchanged');

  const back2 = new Database(DB);
  back2.prepare("DELETE FROM shifts WHERE daypart = 'cafe' AND status = 'open'").run();
  back2.close();
});

test('the dashboard does not restate what Sales and Performance are for', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await page(owner);
  // Four blocks came off this page because each one WAS another page: recent
  // services (/shifts), the sales-and-labor chart and the insight list
  // (/costs), invoice spend (/c/invoices). Keeping them here meant every
  // number had two homes and could disagree with itself.
  for (const gone of ['Average per service', 'Wage cost per service', 'Sales per labor hour',
    'Sales and labor', 'Recent services', 'Invoice spend by week']) {
    assert.ok(!html.includes(gone), `"${gone}" belongs to another page`);
  }
  // What it does answer: what needs doing, how the last service went, the week.
  // The attention column is headed by severity kickers, so the marker for
  // "the page still answers what needs doing" is the column, not a title.
  assert.match(html, /class="bs-col"/);
  assert.match(html, /Last service/);
  assert.match(html, /The week in numbers/);
});

test('this week and last week are compared, and the direction is right', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await page(owner);
  // "This week" is the seven days ending today, and today has no service, so
  // it holds days 1-6: six at $1,500. The window before it is days 7-13, which
  // catches the last $1,500 night plus six at $1,000.
  assert.match(html, /The week in numbers[\s\S]{0,400}\$9,000/, 'six services at $1,500');
  assert.match(html, /dl-up[^>]*>▲ 20\.0%/, '$9,000 against $7,500, and up is up');
  // The written-out version of the same comparison lives on Performance, which
  // is the page that exists to explain why a number moved.
  const perf = await (await as(owner, '/costs?r=7')).text();
  assert.match(perf, /Sales up 20\.0%/, 'and Performance says it in words');
});

test('a percentage of nothing is withheld, not printed as zero', async () => {
  // A fresh account with no invoices at all: food cost is unknown, not 0%,
  // and a prime cost that is really only labor would read as a good week.
  const port = PORT + 1;
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-dash2-'));
  const db2 = path.join(d2, 'e.db');
  const kid = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: db2, TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${port}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /Food[\s\S]{0,220}withheld, not 0%/, 'says why, rather than showing 0%');
    assert.ok(!/Food cost[\s\S]{0,120}0(\.0)?%/.test(html), 'and never prints 0%');
    assert.match(html, /Prime[\s\S]{0,200}needs food cost/);
  } finally {
    kid.kill();
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

// --- what each account is allowed to see -------------------------------------

test('cost figures do not reach an account without the costs area', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const ownerHtml = await page(owner);
  // The assertions below only prove something if the owner actually gets
  // these, so that is checked first rather than assumed.
  assert.match(ownerHtml, /Labor.{0,400}%/s, 'the owner sees a labor percentage');
  assert.match(ownerHtml, /Prime/, 'and a prime cost');

  const floor = await account('floor@dash.test', 'viewer', ['dashboard', 'shifts']);
  const html = await page(floor);
  assert.match(html, /Last service/, 'still gets its own service figures');
  for (const figure of ['Food cost', 'Gross profit', 'Invoices this week', 'The week in numbers']) {
    assert.ok(!html.includes(figure), `${figure} must not reach a shifts-only account`);
  }
  assert.ok(!/Labor (rose|fell) to/.test(html), 'nor a labor insight');
  assert.ok(!/Prime cost (up|improved)/.test(html), 'nor a prime cost insight');
});

test('quick actions offer only what the account can actually reach', async () => {
  // An editor, not a viewer: writes are allowed, so this is the feature list
  // being respected rather than the write check doing the work.
  const mgr = await account('kitchen@dash.test', 'editor', ['dashboard', 'shifts']);
  const html = await page(mgr);
  assert.match(html, /bs-foot-file/, 'an editor does get the file-an-entry row');
  assert.match(html, /href="\/shifts\/new"/, 'including the one for its own area');
  for (const gone of ['/cash/new', '/c/invoices', '/c/vendors', '/menu/new', '/c/incidents']) {
    assert.ok(!html.includes(`href="${gone}"`), `must not offer ${gone}`);
  }
});

test('a view-only account is offered no quick actions at all', async () => {
  const ro = await account('ro@dash.test', 'viewer', ['dashboard', 'shifts', 'cash', 'trackers']);
  const html = await page(ro);
  assert.ok(!html.includes('bs-foot-file'), 'no write shortcuts');
  assert.ok(!html.includes('File an entry'), 'and not an empty row either');
});

// --- attention and today ------------------------------------------------------

test('attention items are grouped by severity, worst first', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await page(owner);
  const groups = [...html.matchAll(/class="ngrp-dot (red|amber|blue)"/g)].map((m) => m[1]);
  const rank = { red: 0, amber: 1, blue: 2 };
  const sorted = [...groups].sort((a, b) => rank[a] - rank[b]);
  assert.deepStrictEqual(groups, sorted, `severity order: ${groups.join(', ')}`);
});

test('a service that sold cash and was never counted is raised', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await page(owner);
  // Every seeded service rang money and none was reconciled. A variance is
  // caught by the cash page; a drawer nobody looked at is only ever caught
  // here, which is what makes it the one that goes unnoticed.
  assert.match(html, /drawer never counted/, 'the uncounted drawer is surfaced');
});

test('today gets a notice even when nothing has been logged', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await page(owner);
  assert.match(html, /class="bs-notices"/);
  assert.match(html, /No shift started today/, 'says so rather than showing an empty card');
});

// --- sales entry --------------------------------------------------------------
//
// The Sales redesign turned the page into a report and dropped the table that
// linked to the entry form, so there was no way to record what the POS rang.
// The figures were never lost — every page that reads them was just reading
// zero. These pin the entry path itself, not the analytics on top of it.

test('the sales page links to the form for entering what the POS rang', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await (await as(owner, '/sales?r=30')).text();
  // Every service in the ledger can reach the form that records its figures.
  assert.match(html, /href="\/sales\/\d+">(Enter|Edit) sales</, 'services link to the entry form');
});

test('a service with no sales entered is listed, not hidden', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const w = new Database(DB);
  const id = w.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'cafe', 'open')")
    .run(back(3)).lastInsertRowid;
  w.close();
  try {
    const html = await (await as(owner, '/sales?r=30')).text();
    // The whole point of the page is entering these. Listing only services
    // that already have figures hid the one row worth clicking.
    assert.ok(html.includes(`href="/sales/${id}"`), 'the empty service is on the page');
    assert.match(html, /lrow-todo/, 'and is marked in the ledger');
    assert.match(html, /Needs sales entry/, 'and called out above it');

  } finally {
    const w2 = new Database(DB);
    w2.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    w2.close();
  }
});

test('sales entered through the form are stored and read back', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const w = new Database(DB);
  const id = w.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'cafe', 'open')")
    .run(back(4)).lastInsertRowid;
  w.close();
  try {
    const res = await post(`/sales/${id}`, { food: '1200.50', coffee: '300.25', alcohol: '0', other: '10' }, owner);
    assert.strictEqual(res.status, 302, 'the form saves');

    const row = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    assert.strictEqual(row.total_food_cents, 120050, 'stored as integer cents');
    assert.strictEqual(row.total_coffee_cents, 30025);
    assert.strictEqual(row.total_other_cents, 1000);

    const html = await (await as(owner, `/sales/${id}`)).text();
    assert.match(html, /value="1200\.50"/, 'and comes back into the form to be corrected');
  } finally {
    const w2 = new Database(DB);
    w2.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    w2.close();
  }
});

test('the closing manager does not type their own name', async () => {
  // Who counted the drawer is required, and the app already knows who is
  // signed in. Asking is one more field between a tired manager and going
  // home — and a typed name is a name that gets typed differently each night.
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await (await as(owner, '/cash/new')).text();
  const field = html.match(/<input name="counted_by"[^>]*>/);
  assert.ok(field, 'the field is on the form');
  assert.match(field[0], /value="[^"]+"/, `prefilled from the session, got: ${field[0]}`);
});


// Every plotted y in a chart: polyline vertices AND the lone dots that a point
// with gaps either side turns into. Scanning polylines alone misses the one
// case that matters here — a single unentered day between two closed ones.
const plottedYs = (svg) => [
  ...[...svg.matchAll(/<polyline points="([^"]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/)).filter(Boolean).map((p) => Number(p.split(',')[1])),
  ...[...svg.matchAll(/<circle[^>]*cy="([\d.]+)"[^>]*r="2\.75"/g)].map((m) => Number(m[1])),
];
const zeroLineOf = (svg) => Number(svg.match(/viewBox="0 0 \d+ (\d+)"/)[1]) - 22;

// --- the sales trend ------------------------------------------------------------

test('a day with no service is a gap in the trend, not a zero', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  // The seed has no service today, so today is a day the chart must not claim
  // took $0. A closed Monday drawn at the axis reads as a catastrophic Monday.
  const html = await (await as(owner, '/sales?r=7')).text();
  const svg = html.slice(html.indexOf('sp-chart'), html.indexOf('id="sp-point"'));
  assert.match(svg, /viewBox=/, 'the chart rendered');
  const zero = zeroLineOf(svg);
  const onAxis = plottedYs(svg).filter((y) => Math.abs(y - zero) < 0.6);
  assert.strictEqual(onAxis.length, 0, `no point sits at the zero line, found ${onAxis.length}`);
});

test('an unentered service is a gap too, and is not counted as a $0 day', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  // The day has to have NO sales at all, and the seed already puts a service
  // on every recent date — adding an empty one beside it leaves the day's
  // total positive, so the chart has nothing to get wrong. This empties a real
  // day instead, which is what an unentered service actually looks like.
  const w = new Database(DB);
  const day = back(3);
  const saved = w.prepare('SELECT id, total_food_cents, total_coffee_cents, total_alcohol_cents, total_other_cents FROM shifts WHERE date = ?').all(day);
  assert.ok(saved.length, 'the seed put a service on this day');
  w.prepare('UPDATE shifts SET total_food_cents=0, total_coffee_cents=0, total_alcohol_cents=0, total_other_cents=0 WHERE date = ?').run(day);
  w.prepare('DELETE FROM server_sales WHERE shift_id IN (SELECT id FROM shifts WHERE date = ?)').run(day);
  const id = saved[0].id;
  w.close();
  try {
    const html = await (await as(owner, '/sales?r=7')).text();
    const days = JSON.parse(html.match(/window\.SP_DAYS = (\{[\s\S]*?\});<\/script>/)[1]);
    // It is in the day map (the ledger and the todo list need it) but the
    // service has no sales, so the trend has nothing to draw for it.
    const svg = html.slice(html.indexOf('sp-chart'), html.indexOf('id="sp-point"'));
    const zero = zeroLineOf(svg);
    const onAxis = plottedYs(svg).filter((y) => Math.abs(y - zero) < 0.6);
    assert.strictEqual(onAxis.length, 0,
      `an unfinished service is not drawn as a day that sold nothing, found ${onAxis.length}`);
    assert.ok(Object.keys(days).length, 'though the day map still carries it for the ledger');
  } finally {
    const w2 = new Database(DB);
    for (const r of saved) {
      w2.prepare('UPDATE shifts SET total_food_cents=?, total_coffee_cents=?, total_alcohol_cents=?, total_other_cents=? WHERE id=?')
        .run(r.total_food_cents, r.total_coffee_cents, r.total_alcohol_cents, r.total_other_cents, r.id);
    }
    w2.close();
  }
});

test('a nonsense custom range cannot hang the server', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  // "from=bad&to=worse" passed the old guard, because 'bad' <= 'worse' is true
  // when you compare them as strings. `days()` then counted from an Invalid
  // Date towards a target it could never reach and allocated until the process
  // died — any visitor could take the site down with a URL.
  for (const q of ['from=bad&to=worse', 'from=2026-02-30&to=2026-03-01', 'from=2026-07-01&to=2026-06-01', 'from=&to=']) {
    const res = await as(owner, `/sales?r=custom&${q}`);
    assert.strictEqual(res.status, 200, `${q} falls back instead of hanging`);
  }
  const still = await as(owner, '/sales');
  assert.strictEqual(still.status, 200, 'and the server is still up afterwards');
});

test('the ledger groups by month and every service can be reached', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  // The seed spans a fortnight, which can sit inside one month and make a
  // grouping assertion pass without grouping anything. These reach back far
  // enough to guarantee three.
  const w = new Database(DB);
  const extra = [40, 75].map((n) => w.prepare(
    "INSERT INTO shifts (date, daypart, status, total_food_cents) VALUES (?, 'cafe', 'emailed', 100000)")
    .run(back(n)).lastInsertRowid);
  w.close();
  try {
  const html = await (await as(owner, '/sales?r=90')).text();
  const months = [...html.matchAll(/class="lm-n">([^<]+)</g)].map((m) => m[1]);
  assert.ok(months.length >= 3, `grouped by month, got ${months.length}`);
  // Compared as dates, not as strings — "July" sorts before "June".
  const asDate = months.map((m) => new Date(m + ' 1').getTime());
  assert.deepStrictEqual(asDate, [...asDate].sort((a, b) => b - a), `newest month first, got ${months.join(', ')}`);
  // Only the first month is expanded; the rest are one tap away. Ninety days
  // of services rendered flat is the thing this replaced.
  assert.strictEqual((html.match(/class="lmonth" open/g) || []).length, 1,
    'only the newest month is expanded — ninety days rendered flat is what this replaced');
  // `class="lrow` also matches the `lrows` container, which is one more than
  // there are rows.
  const rows = (html.match(/class="lrow[" ]/g) || []).length;
  const links = (html.match(/href="\/shifts\/\d+">Open the shift/g) || []).length;
  assert.ok(rows > 0, 'the ledger has rows');
  assert.strictEqual(links, rows, 'every row keeps its link to the shift');
  assert.ok((html.match(/href="\/sales\/\d+">(Enter|Edit) sales</g) || []).length >= rows,
    'and its link to the sales form');
  } finally {
    const w2 = new Database(DB);
    for (const id of extra) w2.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    w2.close();
  }
});

test('history older than the range is offered, not silently hidden', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const w = new Database(DB);
  // A service well outside the default thirty-day window.
  const old = w.prepare("INSERT INTO shifts (date, daypart, status, total_food_cents) VALUES (?, 'cafe', 'emailed', 90000)")
    .run(back(75)).lastInsertRowid;
  w.close();
  try {
    const html = await (await as(owner, '/sales?r=30')).text();
    // Two months of records behind a thirty-day default is two months nobody
    // finds — the page reported its own window and gave no sign of the rest.
    assert.match(html, /class="sp-more"/, 'the older history is offered');
    assert.match(html, /services? outside this range/, 'and says how many');
    const link = html.match(/class="sp-more" href="([^"]+)"/)[1];
    const wide = await (await as(owner, link.replace(/&amp;/g, '&'))).text();
    assert.ok(wide.includes(`href="/sales/${old}"`), 'and following it reaches the old service');
    assert.ok(!/class="sp-more"/.test(wide), 'with nothing left outside');
  } finally {
    const w2 = new Database(DB);
    w2.prepare('DELETE FROM shifts WHERE id = ?').run(old);
    w2.close();
  }
});

test('a day standing on server sales says so, rather than looking final', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const w = new Database(DB);
  const day = back(4);
  // A backfilled service: what the servers rang, and no POS total. The figure
  // is a floor — counter and to-go revenue is in neither — so the page must
  // not present it as the day's takings.
  const id = w.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'cafe', 'emailed')").run(day).lastInsertRowid;
  const emp = w.prepare('SELECT id FROM employees LIMIT 1').get().id;
  w.prepare(`INSERT INTO server_sales (shift_id, employee_id, food_cents, coffee_cents, alcohol_cents, card_tips_cents, cash_tips_cents)
    VALUES (?, ?, 80000, 30000, 0, 12000, 0)`).run(id, emp);
  w.close();
  try {
    const html = await (await as(owner, '/sales?r=30')).text();
    assert.match(html, /class="sp-note"/, 'the page says how many are estimates');
    assert.match(html, /show what servers rang, not a POS total/);
    assert.match(html, /server sales only/, 'and the row is tagged');
    assert.ok(html.includes(`href="/sales/${id}"`), 'and can be opened to fix');
  } finally {
    const w2 = new Database(DB);
    w2.prepare('DELETE FROM server_sales WHERE shift_id = ?').run(id);
    w2.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    w2.close();
  }
});


// --- the rules the redesign exists to preserve ----------------------------------
//
// Each of these survived a mutation after the broadsheet rewrite: the markup
// assertions were updated and the behaviour underneath stopped being checked.
// A redesign that quietly drops one of these is exactly the failure the spec
// was written to prevent.

test('critical alerts are never folded away', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  // Seed the condition rather than hoping the fixture happens to produce it —
  // a shift with somebody on it and no hours is a red alert.
  // TWO of them. With one, a mutation that shows only the first red still
  // shows it, and the test passes while the rule is broken.
  const w = new Database(DB);
  const emp = w.prepare('SELECT id FROM employees LIMIT 1').get().id;
  const shifts = [2, 3].map((d) => {
    const id = w.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'cafe', 'open')").run(back(d)).lastInsertRowid;
    w.prepare("INSERT INTO work (shift_id, employee_id, role, hours) VALUES (?, ?, 'server', 0)").run(id, emp);
    return id;
  });
  w.close();
  try {
    const html = await page(owner);
    const crit = (html.match(/bs-item-k red/g) || []).length;
    assert.ok(crit >= 2, `at least two red alerts exist, got ${crit}`);

    // Everything red sits above the fold. An alert that needs a tap to be seen
    // is not an alert.
    const fold = html.indexOf('class="bs-fold"');
    const shown = fold === -1 ? html : html.slice(0, fold);
    assert.strictEqual((shown.match(/bs-item-k red/g) || []).length, crit,
      'every critical item is above the fold');
  } finally {
    const w2 = new Database(DB);
    for (const id of shifts) {
      w2.prepare('DELETE FROM work WHERE shift_id = ?').run(id);
      w2.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    }
    w2.close();
  }
});

test('warnings show two and the rest collapse', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await page(owner);
  const fold = html.indexOf('class="bs-fold"');
  if (fold === -1) return;                       // not enough alerts to fold
  const shown = html.slice(0, fold);
  assert.ok((shown.match(/bs-item-k amber/g) || []).length <= 2, 'at most two warnings shown');
  assert.ok((shown.match(/bs-item-k blue/g) || []).length === 0, 'and nothing informational');
});

test('the last service is the last one with figures, not the last one logged', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const before = await page(owner);
  const shown = before.match(/Last service — ([^<]+)/)[1].trim();

  // A service logged after it but never filled in must not become "last".
  // Dated today, so it sorts last. Dated earlier it would not be the
  // candidate for "last service" whether the rule held or not.
  const w = new Database(DB);
  const id = w.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'dinner', 'open')")
    .run(iso(new Date())).lastInsertRowid;
  w.close();
  try {
    const after = await page(owner);
    assert.match(after, new RegExp(`Last service — ${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'the empty service did not take its place');
  } finally {
    const w2 = new Database(DB);
    w2.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    w2.close();
  }
});


test('the record is five rows, not the whole log', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  // Eight events, so a cap of five is observable. With four in the fixture the
  // assertion passes whatever the cap is, which is no assertion at all.
  const w = new Database(DB);
  const made = [];
  for (let i = 0; i < 8; i++) {
    made.push(w.prepare("INSERT INTO m_vendors (name, category, created_at) VALUES (?, 'Food', datetime('now'))")
      .run(`Feed Test ${i}`).lastInsertRowid);
  }
  w.close();
  try {
    const html = await page(owner);
    const rows = (html.match(/class="bs-rec"/g) || []).length;
    assert.ok(rows > 0, 'the feed has rows');
    // Ten was a log, and there is somewhere else to read the log.
    assert.strictEqual(rows, 5, `exactly five, got ${rows}`);
  } finally {
    const w2 = new Database(DB);
    for (const id of made) w2.prepare('DELETE FROM m_vendors WHERE id = ?').run(id);
    w2.close();
  }
});
