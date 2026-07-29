'use strict';

// Have I already filed this?
//
// The invoice half of this question is covered end-to-end in
// invoice-flow.test.js, through the real save route. Expenses and documents
// are asked on the upload — the /read endpoints — and those call an AI reader
// that needs a key, so what is tested here is the judgement itself: given what
// was read off the paper, is this a second copy?
//
// The rule being defended, in the owner's words: the number is the red flag,
// not the price.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-dp-'));
process.env.DB_PATH = path.join(dir, 'dp.db');
process.env.TZ = process.env.TZ || 'America/New_York';
process.env.ZWIN_SKIP_BACKFILL = '1';

const { db } = require('../src/db');
require('../src/modules');                       // builds m_expenses and m_documents
const D = require('../src/dupes');

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const expense = (o) => db.prepare(`INSERT INTO m_expenses
  (spent_on, name, where_bought, category, amount_cents, paid_by)
  VALUES (@spent_on, @name, @where_bought, @category, @amount_cents, @paid_by)`)
  .run({ category: 'Food', paid_by: 'Malek', where_bought: null, ...o }).lastInsertRowid;
const document = (o) => db.prepare(`INSERT INTO m_documents
  (title, category, issuer, doc_date, reference)
  VALUES (@title, @category, @issuer, @doc_date, @reference)`)
  .run({ category: 'Legal', issuer: null, doc_date: null, reference: null, ...o }).lastInsertRowid;

const wipe = () => { db.prepare('DELETE FROM m_expenses').run(); db.prepare('DELETE FROM m_documents').run(); };

// --- the normaliser --------------------------------------------------------

test('a number printed differently is the same number', () => {
  const same = (a, b) => assert.strictEqual(D.normNum(a), D.normNum(b), `${a} = ${b}`);
  same('INV-0042', 'INV-42');
  same('#12345', '12345');
  same('BLD ZERO 7', 'bld-zero-007');
  same('a/b/c-1', 'A.B.C_1');
  assert.notStrictEqual(D.normNum('INV-2007'), D.normNum('INV-27'),
    'but a year inside the number is not zero-padding');
  assert.notStrictEqual(D.normNum('INV-1'), D.normNum('INV-2'), 'and two different numbers stay different');
});

// --- expenses --------------------------------------------------------------

test('the same shop, day and amount is a possible second photograph', () => {
  wipe();
  expense({ spent_on: '2026-07-20', name: 'Coffee beans', where_bought: 'Blue Bottle', amount_cents: 4250 });
  const hit = D.duplicateExpense(db, { where: 'blue bottle', spentOn: '2026-07-20', amountCents: 4250 });
  assert.ok(hit, 'found');
  assert.strictEqual(hit.certain, false,
    'and hedged — two coffees on one card in one afternoon come to the same money');
  assert.match(hit.label, /Coffee beans/, 'and says which one it already has');
});

test('a receipt with no legible shop still matches, because that is the one people re-photograph', () => {
  wipe();
  expense({ spent_on: '2026-07-20', name: 'Sundries', where_bought: null, amount_cents: 1899 });
  assert.ok(D.duplicateExpense(db, { where: 'Corner Store', spentOn: '2026-07-20', amountCents: 1899 }),
    'blank on the stored side does not veto it');
  wipe();
  expense({ spent_on: '2026-07-20', name: 'Sundries', where_bought: 'Corner Store', amount_cents: 1899 });
  assert.ok(D.duplicateExpense(db, { where: '', spentOn: '2026-07-20', amountCents: 1899 }),
    'nor on the incoming side');
});

test('a different day, a different shop, or a cent apart is a different expense', () => {
  wipe();
  expense({ spent_on: '2026-07-20', name: 'Coffee beans', where_bought: 'Blue Bottle', amount_cents: 4250 });
  assert.strictEqual(D.duplicateExpense(db, { where: 'Blue Bottle', spentOn: '2026-07-21', amountCents: 4250 }), null, 'next day');
  assert.strictEqual(D.duplicateExpense(db, { where: 'Blue Bottle', spentOn: '2026-07-20', amountCents: 4251 }), null, 'a cent apart');
  assert.strictEqual(D.duplicateExpense(db, { where: 'Costco', spentOn: '2026-07-20', amountCents: 4250 }), null, 'another shop');
  // The check that stops it being useless by being eager: if everything looks
  // like a duplicate, nobody can file anything.
  assert.strictEqual(D.duplicateExpense(db, { where: 'Blue Bottle', spentOn: null, amountCents: 4250 }), null,
    'and with no date there is nothing to go on');
});

test('editing an expense does not find itself', () => {
  wipe();
  const id = expense({ spent_on: '2026-07-20', name: 'Coffee beans', where_bought: 'Blue Bottle', amount_cents: 4250 });
  assert.strictEqual(
    D.duplicateExpense(db, { where: 'Blue Bottle', spentOn: '2026-07-20', amountCents: 4250, exceptId: id }),
    null, 'the row being edited is not its own duplicate');
});

// --- documents -------------------------------------------------------------

test('a document reference is the red flag, the way an invoice number is', () => {
  wipe();
  document({ title: 'Lease 2026', issuer: 'Landlord Co', doc_date: '2026-01-15', reference: 'LSE-0042' });
  const hit = D.duplicateDocument(db, { reference: '#LSE-42', issuer: 'Somebody Else', title: 'Scan 3' });
  assert.ok(hit, 'found on the reference alone');
  assert.strictEqual(hit.certain, true, 'and stated, not hedged');
  assert.match(hit.why, /reference/, 'saying what it matched on');
  assert.match(hit.label, /Lease 2026/, 'and which document');
});

test('without a reference, the same date from the same source is only a maybe', () => {
  wipe();
  document({ title: 'Rent notice', issuer: 'Landlord Co', doc_date: '2026-03-01' });
  const hit = D.duplicateDocument(db, { issuer: 'landlord co', docDate: '2026-03-01', title: 'Untitled scan' });
  assert.ok(hit, 'found');
  assert.strictEqual(hit.certain, false, 'hedged — two letters can be dated the same day');
  assert.strictEqual(
    D.duplicateDocument(db, { issuer: 'Insurance Ltd', docDate: '2026-03-01', title: 'Untitled scan' }),
    null, 'a different source on the same day is a different document');
});

test('a document with nothing to identify it is not guessed at', () => {
  wipe();
  document({ title: 'Lease 2026', issuer: 'Landlord Co', doc_date: '2026-01-15', reference: 'LSE-0042' });
  assert.strictEqual(D.duplicateDocument(db, { title: 'Some scan' }), null,
    'no reference and no date — say nothing rather than guess');
});
