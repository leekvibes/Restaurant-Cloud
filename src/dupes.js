'use strict';

/**
 * Have I already filed this?
 *
 * One question, asked of three different kinds of paper, and the answer is
 * never "yes/no" — it is "this is the same piece of paper" or "this looks like
 * one you already have", which are different enough to be worth saying
 * differently. Nothing here refuses a save. A vendor really can reissue a
 * credit under a number you already have, and two coffees on the same card in
 * the same afternoon really do come to the same money; a hard block would leave
 * nowhere to put the second one.
 *
 * The rule underneath all of it: match on what NAMES the document, not on what
 * it costs. An invoice number, a policy reference — those identify one piece of
 * paper. A total is a coincidence that happens most weeks, and a check built on
 * one either misses the real duplicates or questions the honest ones until
 * people learn to click straight through the question that matters.
 *
 * Nothing matches on the file itself. The duplicate that actually happens is a
 * second photograph of the same receipt, or the same PDF re-saved — different
 * bytes both times, so a content hash would miss precisely the case it is for.
 */

/**
 * Two printings of the same number.
 *
 * Punctuation, a leading #, and zero-padding are all printing choices. INV-0042
 * off the PDF and INV-42 typed in by hand are one invoice. Zeros are stripped
 * per run of digits so a year inside the number survives: 2007 is not 27.
 */
const normNum = (v) => String(v || '').trim().toLowerCase()
  .replace(/[\s._\/#-]/g, '')
  .replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ''));

/** Loose equality for names typed by different people on different days. */
const normName = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A receipt already on file that this one may be a second photograph of.
 *
 * There is no number to lean on: a receipt reader captures what was bought,
 * where, when and how much, and nothing that identifies the transaction. So the
 * key is the shop, the day and the amount to the cent — and because that is
 * genuinely weaker evidence, this never says "certain".
 *
 * A blank shop on either side does not veto the match. A receipt read with no
 * legible shop name is exactly the one somebody re-photographs.
 */
function duplicateExpense(db, { where, spentOn, amountCents, exceptId } = {}) {
  if (!spentOn || !amountCents) return null;
  const w = normName(where);
  const hit = db.prepare('SELECT * FROM m_expenses WHERE spent_on = ? AND amount_cents = ?')
    .all(spentOn, Math.round(amountCents))
    .filter((r) => Number(r.id) !== Number(exceptId))
    .find((r) => !w || !normName(r.where_bought) || normName(r.where_bought) === w);
  if (!hit) return null;
  return {
    certain: false,
    field: 'amount_cents',
    id: hit.id,
    why: [hit.where_bought, hit.spent_on].filter(Boolean).join(', '),
    label: [hit.name, hit.paid_by ? `paid by ${hit.paid_by}` : null].filter(Boolean).join(' · '),
  };
}

/**
 * A document already on file that this one may be a second copy of.
 *
 * Documents DO carry something that identifies them — the reference on a lease,
 * a policy number, a permit number — and it was being captured off the scan and
 * then used for nothing at all. It is read here the way an invoice number is:
 * the one field on the page that names this document rather than describing it.
 *
 * Failing that, the same date from the same source. Two different letters from
 * the landlord dated the same day is possible, so that one stays a maybe.
 */
function duplicateDocument(db, { reference, issuer, title, docDate, exceptId } = {}) {
  const rows = db.prepare('SELECT * FROM m_documents').all()
    .filter((r) => Number(r.id) !== Number(exceptId));
  const describe = (r) => [r.title, r.issuer, r.doc_date].filter(Boolean).join(' · ');

  const ref = normNum(reference);
  if (ref) {
    const hit = rows.find((r) => normNum(r.reference) === ref);
    if (hit) {
      return { certain: true, field: 'reference', id: hit.id,
        why: `reference ${String(reference).trim()}`, label: describe(hit) };
    }
  }
  if (docDate && (issuer || title)) {
    const hit = rows.find((r) => r.doc_date === docDate
      && ((issuer && normName(r.issuer) === normName(issuer))
        || (title && normName(r.title) === normName(title))));
    if (hit) {
      return { certain: false, field: 'doc_date', id: hit.id,
        why: 'the same date, from the same source', label: describe(hit) };
    }
  }
  return null;
}

module.exports = { normNum, normName, duplicateExpense, duplicateDocument };
