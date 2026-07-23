'use strict';

// Documents: the filing cabinet.
//
// The reader is not exercised against the live API here — that would make the
// suite depend on a key, a network and somebody's bill. What is exercised is
// everything around it: the privacy scrub the reader's output passes through,
// the dates that decide whether a document is quietly filed or about to lapse,
// and the page that has to be right whether the reader ran or not.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3979;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-doc-'));
const DB = path.join(dir, 'doc.db');
const UPLOADS = path.join(dir, 'uploads');
let child;
let Database;

// Business dates, not UTC — a document expiring "in 30 days" has to be 30 days
// away from the restaurant's today, or the boundary tests drift after 8pm.
const { isoDate, startOfToday } = require('../src/dates');
const inDays = (n) => isoDate(new Date(startOfToday().getTime() + n * 86400000));

test.before(async () => {
  Database = require('better-sqlite3');
  fs.mkdirSync(UPLOADS, { recursive: true });
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '', UPLOAD_DIR: UPLOADS,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function fileDoc(fields, bytes = Buffer.from('%PDF-1.4 test')) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set('file', new Blob([bytes], { type: 'application/pdf' }), 'doc.pdf');
  return fetch(`${BASE}/c/documents`, { method: 'POST', body: fd, redirect: 'manual' });
}

const rows = () => {
  const db = new Database(DB, { readonly: true });
  const out = db.prepare('SELECT * FROM m_documents ORDER BY id').all();
  db.close();
  return out;
};

// ---------------------------------------------------------------------------
// The privacy rule. This is the part that would be expensive to get wrong:
// a number written into an unencrypted database is there for good, and nothing
// downstream would ever flag it.
// ---------------------------------------------------------------------------

test('the reader is told, in the schema itself, not to return identifiers', () => {
  const { DOC_SCHEMA } = require('../src/reader');
  const props = DOC_SCHEMA.properties;
  // The instruction has to live where the model will actually read it.
  assert.match(props.reference.description, /NEVER a social security number/i,
    'the reference field says what it must never be');
  assert.ok(!Object.keys(props).some((k) => /ssn|ein|tax_id|account|routing|card/i.test(k)),
    `no field invites an identifier: ${Object.keys(props).join(', ')}`);
});

test('and anything shaped like one is stripped out anyway', () => {
  // Belt and braces. A prompt is an instruction, not a guarantee, and the two
  // failures are not symmetrical: a redacted reference is an annoyance, an SSN
  // on disk is permanent.
  const { scrubIdentifiers } = require('../src/reader');
  const out = scrubIdentifiers({
    title: 'Form 941 — Q1 2026',
    reference: '941 · EIN 12-3456789',
    summary: 'Quarterly return for employee 123-45-6789, account 4012888888881881',
    issuer: 'Internal Revenue Service',
  });
  assert.ok(!/12-3456789/.test(out.reference), 'an EIN does not survive');
  assert.ok(!/123-45-6789/.test(out.summary), 'nor a social security number');
  assert.ok(!/4012888888881881/.test(out.summary), 'nor a card number');
  // And it has to leave the useful part alone, or it is just deleting data.
  assert.match(out.reference, /941/, 'the form number stays — that is the point of the field');
  assert.strictEqual(out.title, 'Form 941 — Q1 2026', 'the title is untouched');
  assert.strictEqual(out.issuer, 'Internal Revenue Service', 'so is who sent it');
});

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

test('the cabinet stands on its own before anything is filed', async () => {
  const res = await fetch(`${BASE}/c/documents`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Documents — nothing filed yet/);
  assert.match(html, /File the first one/, 'with a way in');
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(!/\$NaN|undefined|Infinity/.test(visible), 'and no arithmetic on an empty set leaks out');
});

test('a tax filing keeps the four dates that are not interchangeable', async () => {
  const res = await fileDoc({
    title: "Form 941 — Employer's Quarterly Federal Tax Return",
    issuer: 'Internal Revenue Service', category: 'Tax', reference: '941',
    doc_date: '2026-04-08', period_start: '2026-01-01', period_end: '2026-03-31',
    action_by: '2026-04-30', summary: 'Quarterly federal return for Q1, filed through Gusto.',
    ai_status: 'ai',
  });
  assert.strictEqual(res.status, 302);

  const [d] = rows();
  assert.strictEqual(d.doc_date, '2026-04-08', 'the date on it');
  assert.strictEqual(d.period_start, '2026-01-01', 'and the quarter it covers, which is not the same date');
  assert.strictEqual(d.period_end, '2026-03-31');
  assert.strictEqual(d.action_by, '2026-04-30', 'and when it had to be filed by');
  assert.strictEqual(d.expires_on, null, 'a return does not expire — that field stays empty');
  assert.ok(d.file, 'the PDF is kept');

  const html = await (await fetch(`${BASE}/c/documents`)).text();
  assert.match(html, /Form 941/, 'it is on the page');
  assert.match(html, /Internal Revenue Service/, 'with who it came from');
  assert.match(html, /Read by AI/, 'and how it got its fields');
});

test('what is running out is what the page leads with', async () => {
  // Three states, and the headline has to name the worst one. A lapsed permit
  // among forty filed documents is the only thing worth saying at the top.
  await fileDoc({ title: 'Certificate of insurance', category: 'Insurance',
    issuer: 'Hartford', expires_on: inDays(20) });
  await fileDoc({ title: 'Food handler permit', category: 'Permit',
    issuer: 'DOHMH', expires_on: inDays(-6) });
  await fileDoc({ title: 'Signed lease', category: 'Lease',
    issuer: 'Landlord', expires_on: inDays(900) });

  const html = await (await fetch(`${BASE}/c/documents`)).text();
  // Derived: the 941 filed above has a deadline in the past, so it is lapsed
  // too. Pinning a number here made this fail for being right.
  const today = isoDate(startOfToday());
  const lapsed = rows().filter((d) => (d.expires_on && d.expires_on < today)
    || (d.action_by && d.action_by < today)).length;
  assert.ok(lapsed >= 2, `more than one thing has lapsed — the precondition (${lapsed})`);
  assert.match(html, new RegExp(`${lapsed} expired or overdue`),
    'the headline leads with them, and counts every kind of lapse');

  const block = (title) => {
    const at = html.indexOf(title);
    const from = html.lastIndexOf('<details', at);
    return html.slice(from, html.indexOf('</summary>', at));
  };
  assert.match(block('Food handler permit'), /data-state="lapsed"/, 'the expired permit is lapsed');
  assert.match(block('Food handler permit'), /Expired/, 'and says so');
  assert.match(block('Certificate of insurance'), /data-state="soon"/, '20 days out is due soon');
  assert.match(block('Signed lease'), /data-state="filed"/, 'a lease with years left is just filed');
  // The 941 above has an action_by in the past but no expiry — it is overdue,
  // not expired, and calling it "Expired" would read as the wrong problem.
  assert.match(block('Form 941'), /Overdue/, 'a passed deadline reads as overdue, not expired');
});

test('the one coming up next is named, not just counted', async () => {
  const html = await (await fetch(`${BASE}/c/documents`)).text();
  const today = isoDate(startOfToday());
  const lapsed = rows().filter((d) => (d.expires_on && d.expires_on < today)
    || (d.action_by && d.action_by < today)).length;
  assert.match(html, new RegExp(`Expired or overdue</span><span class="bs-stat bad">${lapsed}<`),
    'the strip counts what has lapsed');
  assert.match(html, /Due within 45 days<\/span><span class="bs-stat warn">1</,
    'and what is about to');
  // Whichever is soonest, by whichever of its dates lands first.
  assert.match(html, /Next<\/span>[\s\S]{0,120}?(Food handler permit|Form 941)/,
    'and says which one is next rather than leaving you to look');
});

test('a document with no dates at all is filed, not flagged', async () => {
  // Most of a filing cabinet is like this, and a cabinet that shouts about
  // every item in it is one nobody reads.
  await fileDoc({ title: 'Old menu photographs', category: 'Other' });
  const html = await (await fetch(`${BASE}/c/documents`)).text();
  const at = html.indexOf('Old menu photographs');
  const block = html.slice(html.lastIndexOf('<details', at), html.indexOf('</summary>', at));
  assert.match(block, /data-state="filed"/, 'nothing to chase');
  assert.match(block, /Filed/, 'and it says so plainly');
});

test('the reader endpoint answers rather than throwing when there is no key', async () => {
  // The suite runs without ANTHROPIC_API_KEY. That is the same shape as a
  // key that has expired in production, and it must come back as a sentence
  // the drawer can show, not a 500.
  const fd = new FormData();
  fd.set('scan', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'd.pdf');
  const res = await fetch(`${BASE}/c/documents/read`, { method: 'POST', body: fd });
  assert.strictEqual(res.status, 200, 'it answers');
  const j = await res.json();
  assert.ok(j.error, 'with an error the drawer can print');
  assert.match(j.error, /ANTHROPIC_API_KEY|Could not read/, `and says what went wrong: ${j.error}`);
});

test('the drawer files a document with the reader switched off entirely', async () => {
  // The reader is a convenience. If it is down, or there is no key, or the
  // scan is unreadable, the cabinet still has to work.
  const html = await (await fetch(`${BASE}/c/documents`)).text();
  assert.match(html, /action="\/c\/documents"[^>]*enctype="multipart\/form-data"/,
    'the form posts on its own');
  assert.match(html, /name="title"[^>]*required/, 'a title is required whoever typed it');
  assert.match(html, /id="docfile"[^>]*required|required[^>]*id="docfile"/, 'and a file');
  for (const f of ['issuer', 'doc_date', 'period_start', 'period_end', 'expires_on', 'action_by', 'reference', 'summary']) {
    assert.match(html, new RegExp(`name="${f}"`), `${f} can be typed by hand`);
  }
});
