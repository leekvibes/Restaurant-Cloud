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

test('a receipt does not lead back into the flow that produced it', () => {
  // Pressing Back on a receipt landed on the form that made it — restored from
  // the browser's cache mid-submit, button disabled, reading "Submitting…".
  // It looked like the app had hung, and tapping the button did nothing
  // because it was disabled.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  // The corner link on a receipt is a plain link to the section, not the
  // history.back() every other portal page upgrades to.
  assert.match(src, /label: 'Documents', exact: true \}, 'Signed'\)/,
    'the signed receipt opts out of history.back()');
  assert.match(src, /label: 'Home', exact: true \}, 'Sales & tips'\)/,
    'and so does the tips receipt');
  assert.match(src, /\$\{back\.exact \? '' : ' data-pt-back'\}/,
    'and portalTop honours it — the upgrade script only touches data-pt-back');

  // And the browser's own Back leaves the flow rather than re-entering it.
  assert.match(src, /doneHome: '\/portal\/documents'/, 'the signed receipt names where Back goes');
  assert.match(src, /doneHome: '\/portal'/, 'so does the tips receipt');
  assert.match(src, /location\.replace\(\$\{JSON\.stringify\(home\)\}\)/,
    'and it replaces rather than pushing, so Back does not bounce');
});

test('a page restored from the browser cache is not left mid-submit', () => {
  // Nothing had reset it because nothing ran: a restored page fires pageshow
  // with persisted = true and does not re-run the document.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /window\.addEventListener\('pageshow', function \(ev\) \{\s*\n\s*if \(!ev\.persisted\) return;/,
    'it listens for a restore specifically');
  assert.match(src, /b\.disabled = false;/, 'and re-enables the button');
  assert.match(src, /b\.dataset\.ptLabel/, 'putting back the label it started with, not a guess');
  assert.match(src, /'\.pdv-sheet, \.pt-sheet'/, 'and closes anything modal that came back open');
  // Every portal page, not just the documents one — the tips form disables its
  // button in exactly the same way.
  assert.match(src, /\}\$\{portalRestoreScript\(\)\}\$\{/, 'emitted from portalPage for all of them');
});

// ---------------------------------------------------------------------------
// JUMP TO THE FIELD.
//
// A handbook is forty pages and the thing somebody came here to do is on page
// forty. A policy agreed in person needs signing, not re-reading. Scrolling to
// hunt for a box is not part of the job.
// ---------------------------------------------------------------------------

test('the reader offers a way straight to the next field it needs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /id="pdv-jump">Jump to signature<\/button>/, 'the control exists');
  assert.match(src, /<div class="pdv-bar" id="pdv-bar">[\s\S]{0,400}?id="pdv-jump"/,
    'in the bar, which is fixed to the bottom and reachable from anywhere');
  assert.match(src, /jb\.textContent = n\.kind === 'date' \? 'Jump to date' : 'Jump to signature'/,
    'and it names what it is actually taking you to');
});

test('it goes to the FIRST thing outstanding, in reading order', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /open\.sort\(function \(a, b\) \{ return a\.page - b\.page \|\| a\.y - b\.y \|\| a\.x - b\.x; \}\);/,
    'earliest page, then highest on it — a signature and its date sit side by '
    + 'side, and jumping to the date first reads as skipping the thing it is named after');
  assert.match(src, /placed\.filter\(function \(f\) \{ return !mine\[f\.id\]; \}\)/,
    'and only at fields still to fill');
});

test('it draws the page before it measures, and corrects until it settles', () => {
  // The reason this is not scrollIntoView. Pages are drawn lazily and released
  // behind, so an undrawn page is a box of roughly the right height and not the
  // right height — scroll to page 40 and the 39 above it settle on the way, and
  // you arrive near the field rather than at it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function jumpTo(f) {'), src.indexOf('var jumpBtn ='));
  assert.match(fn, /draw\(f\.page\); if \(f\.page > 1\) draw\(f\.page - 1\);/,
    'the target page and the one above it are drawn first');
  assert.match(fn, /if \(\+\+tries < 4\)/, 'and it checks where it actually landed, more than once');
  assert.match(fn, /window\.innerHeight \* 0\.33/,
    'a third down, not centred — the bar is fixed over the bottom of the window '
    + 'and a centred field sits behind the sheet that opens when you tap it');
  assert.match(fn, /Math\.max\(0, Math\.min\(to, max\)\)/, 'and it never scrolls past either end');
});

test('nothing left to fill means nothing to jump to', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /jb\.hidden = !n;/,
    'the button stands down — one that scrolls to a field already signed appears to do nothing');
});

test('the jump button cannot shoulder the submit off the screen', () => {
  // .tc-btn is width:100%, and a flex item that may not shrink takes that as
  // its basis. `flex: none` alone made the button 1248px wide and pushed
  // Complete & submit clean off the right of the bar.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  assert.match(css, /\.pdv-bar \.pdv-jump \{ flex: 0 0 auto; width: auto;/,
    'width: auto is the load-bearing half');
  assert.match(css, /\.pdv-bar \.tc-btn-go \{ flex: 0 0 auto; width: auto;/,
    'and the submit is sized the same way');
  assert.match(css, /@media \(max-width: 460px\) \{[\s\S]{0,240}?\.pdv-bar \.pdv-bar-t \{ display: none; \}/,
    'on a small phone the status line goes, not one of the buttons');
});

// ---------------------------------------------------------------------------
// ASSIGNING IS NOT REACHING.
//
// A document assigned to somebody who cannot get into the staff portal is
// filed correctly, listed correctly, and seen by nobody. The app said "Added."
// and nothing else — so uploading a handbook, assigning it to yourself and
// finding nothing on the portal looked like the upload had failed.
// ---------------------------------------------------------------------------

test('it says who cannot open a document, and why', () => {
  const D2 = require('../src/documents');
  const mgr = { id: 1, name: 'Owner', role: 'manager', pin: '1111', active: 1 };
  const nopin = { id: 2, name: 'Nopin', role: 'server', pin: null, active: 1 };
  const gone = { id: 3, name: 'Gone', role: 'server', pin: '2222', active: 0 };
  const fine = { id: 4, name: 'Fine', role: 'server', pin: '3333', active: 1 };

  // Managers use the portal now, so a manager with a PIN reaches their documents
  // like anybody else. This asserted the opposite while that was the rule.
  assert.strictEqual(D2.cannotOpen(mgr), null, 'a manager with a PIN can open it');
  assert.ok(D2.cannotOpen(nopin), 'and no PIN is no portal — the PIN is the whole of that sign-in');
  assert.ok(D2.cannotOpen(gone), 'nor somebody no longer active');
  assert.strictEqual(D2.cannotOpen(fine), null, 'anybody else can');

  // Two grammars: a tag beside a name, and a fragment after one. Lowercasing
  // the tag to fit the sentence turned "No PIN" into "no pin".
  assert.match(D2.cannotOpen(nopin).tag, /No PIN/, 'the tag keeps the field its own name');
  assert.match(D2.cannotOpen(nopin).after, /^has no PIN/, 'and the sentence form follows a name');
});

test('the audience carries what deciding that needs', () => {
  // audienceOf selected id and name only, so cannotOpen saw no role and no PIN
  // and called everybody inactive — the check silently could not work.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'documents.js'), 'utf8');
  assert.match(src, /SELECT DISTINCT e\.id, e\.name, e\.role, e\.pin, e\.active FROM employees e/,
    'the audience query returns what cannotOpen reads');
  assert.match(src, /const reachOf = \(docId\) => audienceOf\(docId\)\.map/,
    'and reach is built ON the audience, not beside it — two copies of "who is '
    + 'this assigned to" is two answers waiting to disagree');
});

test('a document assigned to nobody who can open it says so on upload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /Added, but nobody it is assigned to can open it yet/,
    'the case that started this');
  assert.match(src, /Added, and \$\{reach\.length - stuck\.length\} of \$\{reach\.length\} can open it/,
    'and a partial one counts both halves');
  assert.match(src, /Added — but it is assigned to nobody yet/, 'and assigned to no one at all');
  assert.match(src, /\+ \(stuck\.length \? '&err=1' : ''\)/,
    'flagged, not buried in a success message');
});

test('the picker warns before the choice, and the document page after it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /const no = DOCS\.cannotOpen\(e\); return `<label class="tca-p\$\{no \? ' is-off' : ''\}"/,
    'the picker marks them as you choose');
  assert.match(src, /const state = no \? \{ k: 'bad', t: no\.tag \}/,
    'and on the document it beats every other state — "Not started" against '
    + 'somebody with no way to start reads as their fault');
});
