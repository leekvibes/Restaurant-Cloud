'use strict';

// Documents: the line between access and evidence.
//
// Almost every test here is really the same test asked from a different angle —
// that "who can see this" is computed live and "who signed this" is written
// once. The two are easy to conflate into one table and impossible to separate
// afterwards, so they are pinned hard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Its own database and its own document directory, both set BEFORE ../src/db is
// required — db.js reads DB_PATH at module load.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwin-docs-'));
process.env.DB_PATH = path.join(dir, 'docs.db');
process.env.DOC_DIR = path.join(dir, 'files');
process.env.TZ = 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
const D = require('../src/documents');

let E = {};
test.before(() => {
  db.exec(`INSERT INTO employees (name, role, pin, active) VALUES
    ('Ada Server', 'server', '9101', 1),
    ('Ben Server', 'server', '9102', 1),
    ('Cass Cook', 'cook', '9103', 1),
    ('Dee Gone', 'server', '9104', 1)`);
  const by = (n) => db.prepare('SELECT id FROM employees WHERE name = ?').get(n).id;
  E = { ada: by('Ada Server'), ben: by('Ben Server'), cass: by('Cass Cook'), dee: by('Dee Gone') };
});

const mkDoc = (title, kind, extra = {}) => Number(db.prepare(
  `INSERT INTO documents (title, category, kind, ack_text) VALUES (?, ?, ?, ?)`)
  .run(title, extra.category || 'policy', kind, kind === 'sign' ? (extra.ack || D.DEFAULT_ACK) : null)
  .lastInsertRowid);
const mkVer = (docId, v, extra = {}) => D.addVersion(docId, {
  version: v, stored_name: `${v}-${Math.random().toString(16).slice(2)}.pdf`,
  orig_name: 'f.pdf', ...extra });
const assign = (docId, target, targetId) => db.prepare(
  'INSERT OR IGNORE INTO doc_assignments (document_id, target, target_id) VALUES (?, ?, ?)')
  .run(docId, target, targetId == null ? null : targetId);

test('a group is many people, and a person is many groups', () => {
  const servers = D.groups.create('Servers');
  const foh = D.groups.create('Front of house');
  D.groups.setMembers(servers, [E.ada, E.ben]);
  D.groups.setMembers(foh, [E.ada, E.cass]);
  assert.deepStrictEqual(D.groups.members(servers).map((m) => m.name), ['Ada Server', 'Ben Server']);
  assert.deepStrictEqual(D.groups.forEmployee(E.ada).map((g) => g.name).sort(),
    ['Front of house', 'Servers'], 'Ada is in both, and neither removed her from the other');
  // Setting one group's roster leaves every other group alone — the mirror of
  // the mistake that would be easy here.
  D.groups.setMembers(servers, [E.ben]);
  assert.deepStrictEqual(D.groups.forEmployee(E.ada).map((g) => g.name), ['Front of house']);
  D.groups.setMembers(servers, [E.ada, E.ben]);
});

test('access is computed live — a new group member gets the documents that day', () => {
  const g = D.groups.create('Bar');
  D.groups.setMembers(g, [E.ada]);
  const doc = mkDoc('Bar Closing Duties', 'reference');
  mkVer(doc, '1.0');
  assign(doc, 'group', g);

  assert.strictEqual(D.canEmployeeSee(doc, E.ada), true);
  assert.strictEqual(D.canEmployeeSee(doc, E.ben), false, 'not in the group');

  // Nobody reopens the document. The group changes, and access follows.
  D.groups.setMembers(g, [E.ada, E.ben]);
  assert.strictEqual(D.canEmployeeSee(doc, E.ben), true,
    'added to the group today, has the document today');
  assert.deepStrictEqual(D.audienceOf(doc).map((a) => a.name), ['Ada Server', 'Ben Server']);
});

test('leaving a group takes the document away and leaves the signature', () => {
  // The whole architecture in one test. Current visibility and historical
  // evidence are different questions and must give different answers here.
  const g = D.groups.create('Leavers');
  D.groups.setMembers(g, [E.dee]);
  const doc = mkDoc('Alcohol Policy', 'sign');
  const v = mkVer(doc, '1.0');
  assign(doc, 'group', g);

  D.sign({ versionId: v, employeeId: E.dee, employeeName: 'Dee Gone', ackText: D.DEFAULT_ACK });
  assert.strictEqual(D.canEmployeeSee(doc, E.dee), true);

  D.groups.setMembers(g, []);
  assert.strictEqual(D.canEmployeeSee(doc, E.dee), false, 'access is gone');
  const kept = D.signaturesForEmployee(E.dee);
  assert.strictEqual(kept.length, 1, 'and the signature is not');
  assert.strictEqual(kept[0].employee_name, 'Dee Gone');
});

test('deactivating somebody does not touch what they signed', () => {
  const doc = mkDoc('Handbook (leaver)', 'sign');
  const v = mkVer(doc, '1.0');
  assign(doc, 'employee', E.dee);
  D.sign({ versionId: v, employeeId: E.dee, employeeName: 'Dee Gone', ackText: D.DEFAULT_ACK });
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(E.dee);
  try {
    assert.strictEqual(D.signaturesForEmployee(E.dee).length, 2,
      'both signatures survive deactivation');
  } finally {
    db.prepare('UPDATE employees SET active = 1 WHERE id = ?').run(E.dee);
  }
});

test('one signature per person per version, however many times they tap', () => {
  const doc = mkDoc('Double Tap Policy', 'sign');
  const v = mkVer(doc, '1.0');
  assign(doc, 'employee', E.ada);
  const a = D.sign({ versionId: v, employeeId: E.ada, employeeName: 'Ada Server', ackText: D.DEFAULT_ACK });
  const b = D.sign({ versionId: v, employeeId: E.ada, employeeName: 'Ada Server', ackText: D.DEFAULT_ACK });
  assert.strictEqual(a.fresh, true);
  assert.strictEqual(b.fresh, false, 'the second is not a new record');
  assert.strictEqual(a.signature.id, b.signature.id, 'and it returns the first one');
  assert.strictEqual(db.prepare(
    'SELECT COUNT(*) n FROM doc_signatures WHERE version_id = ? AND employee_id = ?')
    .get(v, E.ada).n, 1);
});

test('a new version is a new obligation, and never inherits an old signature', () => {
  const doc = mkDoc('Employee Handbook', 'sign');
  const v1 = mkVer(doc, '1.0');
  assign(doc, 'employee', E.ada);
  D.sign({ versionId: v1, employeeId: E.ada, employeeName: 'Ada Server', ackText: D.DEFAULT_ACK });
  assert.strictEqual(D.statsFor(doc).signed, 1, 'signed, on version 1');

  const v2 = mkVer(doc, '2.0');
  assert.strictEqual(D.currentVersion(doc).id, v2, 'version 2 is current');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM doc_signatures WHERE version_id = ?').get(v2).n, 0,
    'nobody has signed version 2');
  assert.strictEqual(D.statsFor(doc).signed, 0,
    'and the document reads as unsigned, because that is the true state of the current file');
  // The old signature is untouched and still points at the file it was given.
  const old = db.prepare('SELECT version_id FROM doc_signatures WHERE document_id = ?').get(doc);
  assert.strictEqual(old.version_id, v1, 'the signature stayed on version 1');
  // And exactly one version is current, enforced by the database.
  assert.strictEqual(db.prepare(
    'SELECT COUNT(*) n FROM doc_versions WHERE document_id = ? AND is_current = 1').get(doc).n, 1);
});

test('archiving hides a document and keeps every signature against it', () => {
  const doc = mkDoc('Retired Policy', 'sign');
  const v = mkVer(doc, '1.0');
  assign(doc, 'all', null);
  D.sign({ versionId: v, employeeId: E.ben, employeeName: 'Ben Server', ackText: D.DEFAULT_ACK });
  db.prepare("UPDATE documents SET active = 0, archived_at = datetime('now') WHERE id = ?").run(doc);
  assert.strictEqual(D.canEmployeeSee(doc, E.ben), false, 'gone from the portal');
  assert.ok(D.signaturesFor(doc).length >= 1, 'the record is not');
  assert.ok(!D.forEmployee(E.ben).some((d) => d.id === doc), 'and not in their library');
});

test('assigned to everyone means everyone active, including whoever starts later', () => {
  const doc = mkDoc('House Standards', 'reference');
  mkVer(doc, '1.0');
  assign(doc, 'all', null);
  const before = D.audienceOf(doc).length;
  const id = Number(db.prepare(
    "INSERT INTO employees (name, role, active) VALUES ('New Starter', 'server', 1)").run().lastInsertRowid);
  try {
    assert.strictEqual(D.canEmployeeSee(doc, id), true, 'a person hired today has it today');
    assert.strictEqual(D.audienceOf(doc).length, before + 1);
  } finally {
    db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  }
});

test('viewing is recorded as opening, and never as having read it', () => {
  const doc = mkDoc('Training Guide', 'reference');
  const v = mkVer(doc, '1.0');
  assign(doc, 'employee', E.cass);
  assert.strictEqual(D.statsFor(doc).viewed, 0, 'appearing on their list is not viewing');
  D.noteView(v, E.cass, 3, 10);
  const row = db.prepare('SELECT * FROM doc_views WHERE version_id = ? AND employee_id = ?').get(v, E.cass);
  assert.strictEqual(row.last_page, 3);
  assert.strictEqual(D.statsFor(doc).viewed, 1);
  // Progress goes forward, not backwards — scrolling up is not un-reading.
  D.noteView(v, E.cass, 1, 10);
  const back = db.prepare('SELECT * FROM doc_views WHERE version_id = ? AND employee_id = ?').get(v, E.cass);
  assert.strictEqual(back.pages_seen, 3, 'the furthest page reached is kept');
  // And it is per VERSION, so a new file does not inherit their place in the old one.
  const v2 = mkVer(doc, '2.0');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM doc_views WHERE version_id = ?').get(v2).n, 0);
});

test('a signature records what was agreed, not just that something was', () => {
  const doc = mkDoc('Tip Policy', 'sign', { ack: 'I have read the tip policy and agree to it.' });
  const v = mkVer(doc, '1.0');
  assign(doc, 'employee', E.ben);
  const { signature } = D.sign({ versionId: v, employeeId: E.ben, employeeName: 'Ben Server',
    ackText: 'I have read the tip policy and agree to it.', ip: '10.0.0.9', userAgent: 'phone' });
  assert.strictEqual(signature.ack_text, 'I have read the tip policy and agree to it.',
    'the exact wording they agreed to, stored with the signature');
  assert.strictEqual(signature.employee_name, 'Ben Server');
  assert.strictEqual(signature.ip, '10.0.0.9');
  assert.ok(signature.signed_at, 'and a server timestamp');

  // Renaming the employee afterwards must not rewrite who signed.
  db.prepare('UPDATE employees SET name = ? WHERE id = ?').run('Benjamin Server', E.ben);
  try {
    const again = db.prepare('SELECT employee_name FROM doc_signatures WHERE id = ?').get(signature.id);
    assert.strictEqual(again.employee_name, 'Ben Server',
      'the name as it was on the day, not as it is now');
  } finally {
    db.prepare('UPDATE employees SET name = ? WHERE id = ?').run('Ben Server', E.ben);
  }
});

test('an employee only ever sees documents that reach them', () => {
  const mine = D.forEmployee(E.cass).map((d) => d.title);
  for (const t of mine) {
    const doc = db.prepare('SELECT id FROM documents WHERE title = ?').get(t);
    assert.strictEqual(D.canEmployeeSee(doc.id, E.cass), true,
      `${t} is on Cass's list and the gate agrees`);
  }
  // And the gate is the same one the list is built from — asked the other way.
  const all = db.prepare('SELECT id, title FROM documents WHERE active = 1').all();
  for (const d of all) {
    const listed = mine.includes(d.title);
    assert.strictEqual(D.canEmployeeSee(d.id, E.cass), listed,
      `${d.title}: the list and the gate cannot disagree`);
  }
});

// ---------------------------------------------------------------------------
// Over HTTP, because the gate has to hold against a typed URL and not merely
// against a missing button.
// ---------------------------------------------------------------------------

const { spawn } = require('node:child_process');
const PORT = 3960;
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

const form = (url, body, opts = {}) => fetch(`${BASE}${url}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
  body: new URLSearchParams(body).toString(),
});
const get = (url, opts = {}) => fetch(`${BASE}${url}`, {
  redirect: 'manual', headers: opts.cookie ? { cookie: opts.cookie } : {},
});
async function portalSession(pin) {
  const r = await form('/tips/start', { pin });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: process.env.DB_PATH,
      DOC_DIR: process.env.DOC_DIR, ZWIN_SKIP_BACKFILL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/version`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); });

test('a typed URL does not open somebody else\'s document', async () => {
  // The important half is the FILE. A page that hides a link while the bytes
  // stay fetchable has not protected anything, and a corrective action is the
  // document where that matters most.
  const priv = mkDoc('Corrective Action — Ada', 'sign');
  const v = mkVer(priv, '1.0');
  assign(priv, 'employee', E.ada);
  fs.mkdirSync(process.env.DOC_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.DOC_DIR,
    db.prepare('SELECT stored_name FROM doc_versions WHERE id = ?').get(v).stored_name), '%PDF-1.4 test');

  const ada = await portalSession('9101');
  const ben = await portalSession('9102');

  assert.strictEqual((await get(`/portal/documents/${priv}`, { cookie: ada })).status, 200,
    'the person it is about can open it');
  assert.strictEqual((await get(`/portal/documents/${priv}`, { cookie: ben })).status, 404,
    'somebody else cannot');
  assert.strictEqual((await get(`/portal/documents/${priv}/file`, { cookie: ben })).status, 404,
    'and cannot fetch the bytes either');
  // Not-found and not-yours give the same answer on purpose: a different one
  // for each lets somebody walk the id space and learn what exists.
  assert.strictEqual((await get('/portal/documents/999999', { cookie: ben })).status, 404);

  const anon = await get(`/portal/documents/${priv}/file`);
  assert.ok(anon.status === 302 || anon.status === 401 || anon.status === 403,
    `no session gets no file — was ${anon.status}`);
});

test('signing over HTTP needs the box, the name, and the version on screen', async () => {
  const doc = mkDoc('Safety Policy', 'sign');
  const v = mkVer(doc, '1.0');
  assign(doc, 'employee', E.cass);
  fs.writeFileSync(path.join(process.env.DOC_DIR,
    db.prepare('SELECT stored_name FROM doc_versions WHERE id = ?').get(v).stored_name), '%PDF-1.4 test');
  const cass = await portalSession('9103');
  const rows = () => db.prepare('SELECT COUNT(*) n FROM doc_signatures WHERE version_id = ?').get(v).n;

  await form(`/portal/documents/${doc}/sign`, { version_id: v, full_name: 'Cass Cook' }, { cookie: cass });
  assert.strictEqual(rows(), 0, 'no tick, no signature');
  await form(`/portal/documents/${doc}/sign`, { version_id: v, agree: '1', full_name: '' }, { cookie: cass });
  assert.strictEqual(rows(), 0, 'no name, no signature');

  // A version published while they had the page open. Their acknowledgment
  // would land on a file they never saw, so it is refused rather than moved.
  const v2 = mkVer(doc, '2.0');
  await form(`/portal/documents/${doc}/sign`, { version_id: v, agree: '1', full_name: 'Cass Cook' }, { cookie: cass });
  assert.strictEqual(rows(), 0, 'the stale version is refused');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM doc_signatures WHERE version_id = ?').get(v2).n, 0,
    'and is NOT quietly retargeted at the new one');

  await form(`/portal/documents/${doc}/sign`, { version_id: v2, agree: '1', full_name: 'Cass Cook' }, { cookie: cass });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM doc_signatures WHERE version_id = ?').get(v2).n, 1,
    'signing the version actually on screen works');

  // Somebody else cannot sign it for them.
  const ben = await portalSession('9102');
  await form(`/portal/documents/${doc}/sign`, { version_id: v2, agree: '1', full_name: 'Ben Server' }, { cookie: ben });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM doc_signatures WHERE version_id = ?').get(v2).n, 1,
    'a document that is not theirs cannot be signed by them');
});

test('the portal separates what needs doing from what is just there', async () => {
  const ada = await portalSession('9101');
  const html = await (await get('/portal/documents', { cookie: ada })).text();
  assert.match(html, /Needs your attention/, 'the two sections are named');
  assert.match(html, /Your documents/);
  assert.match(html, /pdv?-|pd-card/, 'and there are cards to act on');
  // The reader is the app's own, not the browser's PDF plugin in a frame.
  const doc = db.prepare("SELECT id FROM documents WHERE title = 'Corrective Action — Ada'").get();
  const page = await (await get(`/portal/documents/${doc.id}`, { cookie: ada })).text();
  assert.doesNotMatch(page, /<iframe/i, 'no iframe — that brings its own toolbar and its own scroll');
  assert.match(page, /pdf\.min\.js/, 'pdf.js renders the pages');
  assert.match(page, /pdf\.worker\.min\.js/, 'with its worker, served from our own origin');
});
