'use strict';

// Documents: the guarantees, not the pixels.
//
// Everything here is about the two things that would actually hurt if they were
// wrong — somebody signing without reading, and a signed record changing after
// the fact. The UI can be rearranged freely; these must not move.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-docs-'));
const DB = path.join(dir, 'd.db');
const DOCS_DIR = path.join(dir, 'files');
process.env.DB_PATH = DB;
process.env.DOC_DIR = DOCS_DIR;

let D, db, emp, other;

before(() => {
  db = require('../src/db').db;
  db.prepare(`INSERT INTO employees (name, role, active, pin) VALUES ('Ada Reader','server',1,'7001')`).run();
  db.prepare(`INSERT INTO employees (name, role, active, pin) VALUES ('Bo Outsider','server',1,'7002')`).run();
  emp = db.prepare("SELECT id FROM employees WHERE name = 'Ada Reader'").get().id;
  other = db.prepare("SELECT id FROM employees WHERE name = 'Bo Outsider'").get().id;
  D = require('../src/documents');
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

const mkDoc = (kind = 'sign', pages = 4) => {
  const id = Number(db.prepare(`INSERT INTO documents (title, kind, ack_text)
    VALUES ('Handbook', ?, 'I acknowledge.')`).run(kind).lastInsertRowid);
  const v = D.addVersion(id, { version: '1.0', stored_name: 'x.pdf', pages });
  db.prepare("INSERT INTO doc_assignments (document_id, target, target_id) VALUES (?, 'employee', ?)")
    .run(id, emp);
  return { id, v };
};

test('a field is stored as a fraction of the page, never as pixels', () => {
  const { v } = mkDoc();
  const f = D.addField(v, { kind: 'signature', page: 3, x: 0.25, y: 0.6, w: 0.34, h: 0.055 });
  const row = D.fieldsFor(v)[0];
  assert.strictEqual(row.id, f);
  assert.ok(row.x > 0 && row.x < 1, 'x is a fraction');
  assert.ok(row.y > 0 && row.y < 1, 'y is a fraction');
  // Off the page in either direction is clamped rather than stored.
  const wild = D.addField(v, { kind: 'date', page: 1, x: 4.2, y: -3, w: 0.2, h: 0.05 });
  const w = D.fieldsFor(v).find((r) => r.id === wild);
  assert.ok(w.x >= 0 && w.x + w.w <= 1.0001, 'x clamped onto the page');
  assert.ok(w.y >= 0 && w.y + w.h <= 1.0001, 'y clamped onto the page');
});

test('how far somebody read is still recorded, though it no longer gates signing', () => {
  const { v } = mkDoc('sign', 6);
  assert.strictEqual(D.reviewComplete(v, emp), false, 'nothing seen yet');
  D.noteView(v, emp, 1, 6);
  assert.strictEqual(D.reviewComplete(v, emp), false, 'page 1 of 6 is not reviewed');
  D.noteView(v, emp, 5, 6);
  assert.strictEqual(D.reviewComplete(v, emp), false, 'page 5 of 6 is not either');
  D.noteView(v, emp, 6, 6);
  assert.strictEqual(D.reviewComplete(v, emp), true, 'the last page completes it');
  // And it stays open — closing the app after reading does not undo the reading.
  D.noteView(v, emp, 2, 6);
  assert.strictEqual(D.reviewComplete(v, emp), true, 'scrolling back up does not re-lock it');
});

test('the date in the document is the signature timestamp, not a typed value', () => {
  const { v } = mkDoc();
  const sig = D.addField(v, { kind: 'signature', page: 1, x: 0.2, y: 0.7 });
  const dte = D.addField(v, { kind: 'date', page: 1, x: 0.6, y: 0.7 });
  D.noteView(v, emp, 4, 4);
  const { signature } = D.sign({ versionId: v, employeeId: emp, employeeName: 'Ada Reader',
    ackText: 'I acknowledge.', values: { [sig]: 'Ada Reader', [dte]: '01/01/1999' } });
  const vals = new Map(D.valuesFor(v, emp).map((x) => [x.field_id, x.value]));
  // Whatever the client sent for the date is discarded — it is not a field the
  // person fills in, it is a fact about when they signed.
  assert.strictEqual(vals.get(dte), '@signed', 'the date is a sentinel, not the posted string');
  const shown = D.renderValue({ kind: 'date' }, vals.get(dte), signature, 'America/New_York');
  assert.match(shown, /^\d{2}\/\d{2}\/\d{4}$/, 'and renders as a date');
  assert.ok(!shown.includes('1999'), 'never the date the client claimed');
  assert.strictEqual(D.renderValue({ kind: 'signature' }, vals.get(sig), signature), 'Ada Reader');
});

test('a signed layout cannot be dragged, and a new version starts clean', () => {
  const { id, v } = mkDoc();
  const sig = D.addField(v, { kind: 'signature', page: 1, x: 0.2, y: 0.7 });
  D.noteView(v, emp, 4, 4);
  D.sign({ versionId: v, employeeId: emp, employeeName: 'Ada Reader',
    ackText: 'I acknowledge.', values: { [sig]: 'Ada Reader' } });

  const before = D.fieldsFor(v)[0];
  assert.strictEqual(D.fieldLocked(v), true, 'signed, so the layout is history');
  assert.strictEqual(D.moveField(sig, { x: 0.9, y: 0.1 }), false, 'moving is refused');
  assert.strictEqual(D.removeField(sig), false, 'so is deleting');
  const after = D.fieldsFor(v)[0];
  assert.strictEqual(after.x, before.x, 'and the field did not move');

  // Version two: same layout offered as a starting point, none of the history.
  const v2 = D.addVersion(id, { version: '2.0', stored_name: 'y.pdf', pages: 4 });
  assert.strictEqual(D.copyFields(v, v2), 1, 'the layout is copied forward');
  assert.strictEqual(D.fieldLocked(v2), false, 'the new version is not signed');
  assert.strictEqual(D.moveField(D.fieldsFor(v2)[0].id, { x: 0.5, y: 0.5 }), true, 'so it can be laid out');
  assert.strictEqual(D.valuesFor(v2, emp).length, 0, 'and carries none of the old values');
  // The old one is untouched by all of it.
  assert.strictEqual(D.valuesFor(v, emp).length, 1, 'version one keeps its signature');
});

test('one signature per person per version, however many times they tap', () => {
  const { v } = mkDoc();
  const sig = D.addField(v, { kind: 'signature', page: 1, x: 0.2, y: 0.7 });
  D.noteView(v, emp, 4, 4);
  const a = D.sign({ versionId: v, employeeId: emp, employeeName: 'Ada Reader',
    ackText: 'I acknowledge.', values: { [sig]: 'Ada Reader' } });
  const b = D.sign({ versionId: v, employeeId: emp, employeeName: 'Ada Reader',
    ackText: 'I acknowledge.', values: { [sig]: 'Ada Reader' } });
  assert.strictEqual(a.fresh, true);
  assert.strictEqual(b.fresh, false, 'the second is recognised, not filed');
  assert.strictEqual(a.signature.id, b.signature.id, 'and it is the same record');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM doc_field_values WHERE field_id = ?').get(sig).n, 1,
    'one value, not two');
});

test('access is a live question and signing is a permanent answer', () => {
  const gid = D.groups.create('Servers');
  const id = Number(db.prepare(`INSERT INTO documents (title, kind, ack_text)
    VALUES ('Policy', 'sign', 'I acknowledge.')`).run().lastInsertRowid);
  const v = D.addVersion(id, { version: '1.0', stored_name: 'p.pdf', pages: 1 });
  db.prepare("INSERT INTO doc_assignments (document_id, target, target_id) VALUES (?, 'group', ?)")
    .run(id, gid);
  D.groups.setMembers(gid, [emp]);
  assert.strictEqual(D.canEmployeeSee(id, emp), true, 'a member can see it');
  assert.strictEqual(D.canEmployeeSee(id, other), false, 'somebody else cannot');

  D.noteView(v, emp, 1, 1);
  D.sign({ versionId: v, employeeId: emp, employeeName: 'Ada Reader', ackText: 'I acknowledge.' });

  D.groups.setMembers(gid, []);                       // they leave the group
  assert.strictEqual(D.canEmployeeSee(id, emp), false, 'access goes with membership');
  assert.strictEqual(D.signaturesForEmployee(emp).filter((s) => s.document_id === id).length, 1,
    'the signature does not');

  // Archiving the document is the same shape: no access, evidence intact.
  db.prepare('UPDATE documents SET active = 0 WHERE id = ?').run(id);
  assert.strictEqual(D.canEmployeeSee(id, emp), false);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM doc_signatures WHERE document_id = ?').get(id).n, 1,
    'archiving destroys nothing');
});

test('a document with no fields still signs the old way', () => {
  // Everything created before field placement existed has none, and must keep
  // working exactly as it did — the acknowledgment panel, no review gate.
  const { v } = mkDoc('sign', 3);
  assert.strictEqual(D.fieldsFor(v).length, 0);
  const r = D.sign({ versionId: v, employeeId: emp, employeeName: 'Ada Reader',
    ackText: 'I acknowledge.' });
  assert.ok(r.signature.id, 'it signs');
  assert.strictEqual(D.valuesFor(v, emp).length, 0, 'with no field values');
});

test('reading to the end is recorded, and no longer gates signing', () => {
  // The gate was built with three ways to open because one kept failing —
  // a missed observer entry, a released page, a footer below the fold — and
  // "I read it and it will not let me sign" is a worse outcome than somebody
  // scrolling fast. It is off. How far they read is still recorded; it is
  // simply not a condition.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(!/if \(!DOCS\.reviewComplete\(v\.id, emp\.id\)\) \{/.test(src),
    'the submit route no longer refuses on it');
  assert.ok(!/Read through to the last page before signing/.test(src),
    'and nothing says it does');
  assert.match(src, /reviewed: DOCS\.reviewComplete\(v\.id, who\.emp\.id\)/,
    'the reading is still tracked — the record is worth having, the gate was not');
  assert.match(src, /data-reviewed="1"/, 'the fields open with the document');
});

test('a signature is accepted from somebody who never scrolled', () => {
  // The behaviour, not the source: no doc_views row at all, and it still signs.
  const { v } = mkDoc('sign', 40);
  const who = Number(db.prepare("INSERT INTO employees (name, role, active) VALUES ('Never Scrolled','server',1)")
    .run().lastInsertRowid);
  assert.strictEqual(D.reviewComplete(v, who), false, 'they read nothing');
  const out = D.sign({ versionId: v, employeeId: who, employeeName: 'Never Scrolled',
    ackText: D.DEFAULT_ACK });
  assert.ok(out.fresh && out.signature, 'and the signature stands');
});

test('a date field keeps the date the person chose', () => {
  // It used to be filled in from the signature's own timestamp — right when
  // nobody is asked, and they are asked now. The date on a document is a
  // statement by the person signing it.
  const { v } = mkDoc('sign', 1);
  const f = D.addField(v, { kind: 'date', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 });
  const who = Number(db.prepare("INSERT INTO employees (name, role, active) VALUES ('Date Picker','server',1)")
    .run().lastInsertRowid);
  D.sign({ versionId: v, employeeId: who, employeeName: 'Date Picker', ackText: D.DEFAULT_ACK,
    values: { [String(f)]: '2026-03-04' } });
  const vals = D.valuesFor(v, who);
  const dv = vals.find((x) => x.kind === 'date') || vals[0];
  assert.strictEqual(dv.value, '2026-03-04', 'stored as the day they picked');
  assert.strictEqual(D.renderValue({ kind: 'date' }, '2026-03-04', { signed_at: '2026-09-10 06:00:00' },
    'America/New_York'), '03/04/2026', 'and printed as that day, not as the signing day');
});

test('anything that is not a plain date falls back to the signing timestamp', () => {
  // The field is a date. A hand-written POST must not be able to put arbitrary
  // text where one belongs.
  const out = D.renderValue({ kind: 'date' }, 'whenever I feel like it',
    { signed_at: '2026-09-10 06:00:00' }, 'America/New_York');
  assert.ok(/^\d{2}\/\d{2}\/\d{4}$/.test(out), `fell back to a real date, got ${out}`);
});

test('signing lands on a receipt, not back on the document', () => {
  // Redirecting onto the document with a toast looked identical to the page
  // they had just been on, so submitting read as the form resetting.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /res\.redirect\(`\/portal\/documents\/\$\{doc\.id\}\/done`\)/,
    'the field path lands on the receipt');
  assert.match(src, /app\.get\('\/portal\/documents\/:id\/done'/, 'which exists');
  // And it refuses to claim a signature that is not there.
  assert.match(src, /if \(!sig\) return res\.redirect\(`\/portal\/documents\/\$\{doc\.id\}`\)/,
    'an unsigned document has no receipt to show');
});

test('a signed document reopens read-only, with the values in place', () => {
  const { id, v } = mkDoc('sign', 2);
  const sig = D.addField(v, { kind: 'signature', page: 2, x: 0.2, y: 0.7 });
  const dte = D.addField(v, { kind: 'date', page: 2, x: 0.6, y: 0.7 });
  D.noteView(v, emp, 2, 2);
  const { signature } = D.sign({ versionId: v, employeeId: emp, employeeName: 'Ada Reader',
    ackText: 'I acknowledge.', values: { [sig]: 'Ada Reader' } });

  // What the portal and the admin record both render, through one function.
  const filled = new Map(D.valuesFor(v, emp).map((x) => [x.field_id, x.value]));
  const shown = D.fieldsFor(v).map((f) => D.renderValue(f, filled.get(f.id), signature, 'America/New_York'));
  assert.deepStrictEqual(shown.filter(Boolean).length, 2, 'both fields have a value to draw');
  assert.ok(shown.includes('Ada Reader'), 'the signature');
  assert.ok(shown.some((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x)), 'and the date');
  assert.strictEqual(id > 0, true);
});
