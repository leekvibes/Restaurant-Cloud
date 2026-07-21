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
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', APP_PASSWORD: 'dash-owner-pw' },
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

test('the headline figures come from completed services, not from today', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await page(owner);

  // Every seeded service is closed and today has none, so an average that
  // included today would be diluted by an empty service.
  assert.match(html, /Average per service[\s\S]{0,220}\$1,250\.00/,
    'seven at $1,000 and seven at $1,500 average $1,250');
  assert.match(html, /Wage cost per service[\s\S]{0,220}\$200\.00/, '10 hours at $20');
  assert.match(html, /Sales per labor hour[\s\S]{0,220}\$125\.00/, '$1,250 over 10 hours');
});

test('an unfilled service does not drag the average down', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const before = await page(owner);
  assert.match(before, /Average per service[\s\S]{0,220}\$1,250\.00/);

  // A service logged but never filled in. It is a real row, and counting it
  // as a $0 service would report every night as worse than it was.
  const w = new Database(DB);
  w.prepare("INSERT INTO shifts (date, daypart, status) VALUES (?, 'cafe', 'open')").run(back(2));
  w.close();

  const after = await page(owner);
  assert.match(after, /Average per service[\s\S]{0,220}\$1,250\.00/, 'the average is unchanged');

  const back2 = new Database(DB);
  back2.prepare("DELETE FROM shifts WHERE daypart = 'cafe' AND status = 'open'").run();
  back2.close();
});

test('this week and last week are compared, and the direction is right', async () => {
  const owner = await login({ password: 'dash-owner-pw' });
  const html = await page(owner);
  // "This week" is the seven days ending today, and today has no service, so
  // it holds days 1-6: six at $1,500. The window before it is days 7-13, which
  // catches the last $1,500 night plus six at $1,000.
  assert.match(html, /Sales this week[\s\S]{0,220}\$9,000\.00/, 'six services at $1,500');
  assert.match(html, /Sales up 20\.0% on the previous week/, '$9,000 against $7,500');
});

test('a percentage of nothing is withheld, not printed as zero', async () => {
  // A fresh account with no invoices at all: food cost is unknown, not 0%,
  // and a prime cost that is really only labor would read as a good week.
  const port = PORT + 1;
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-dash2-'));
  const db2 = path.join(d2, 'e.db');
  const kid = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: db2, TZ: 'America/New_York', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${port}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /Food cost[\s\S]{0,160}no invoices logged/, 'says why, rather than showing 0%');
    assert.ok(!/Food cost[\s\S]{0,120}0(\.0)?%/.test(html), 'and never prints 0%');
    assert.match(html, /Prime cost[\s\S]{0,160}needs invoices/);
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
  assert.match(ownerHtml, /Prime cost/, 'and a prime cost');

  const floor = await account('floor@dash.test', 'viewer', ['dashboard', 'shifts']);
  const html = await page(floor);
  assert.match(html, /Average per service/, 'still gets its own service figures');
  for (const figure of ['Food cost', 'Prime cost', 'Gross profit', 'Invoices this week']) {
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
  assert.match(html, /class="qact"/, 'an editor does get quick actions');
  assert.match(html, /href="\/shifts\/new"/, 'including the one for its own area');
  for (const gone of ['/cash/new', '/c/invoices', '/c/vendors', '/menu/new', '/c/incidents']) {
    assert.ok(!html.includes(`href="${gone}"`), `must not offer ${gone}`);
  }
});

test('a view-only account is offered no quick actions at all', async () => {
  const ro = await account('ro@dash.test', 'viewer', ['dashboard', 'shifts', 'cash', 'trackers']);
  const html = await page(ro);
  assert.ok(!html.includes('class="qact"'), 'no write shortcuts');
  assert.ok(!html.includes('Quick actions'), 'and not an empty section either');
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
  assert.match(html, /class="tnotices"/);
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
  assert.match(html, /class="srow2[^"]*" href="\/sales\/\d+"/, 'services link to the entry form');
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
    assert.match(html, /no sales yet/, 'and is marked as needing them');
    assert.match(html, /services? without sales/, 'with a prompt to go and enter them');
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
