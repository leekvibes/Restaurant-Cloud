'use strict';

// The five emails ZWIN sends.
//
// These are the only thing the restaurant produces that leaves the building.
// Nobody sees a broken one until a staff member mentions it, and by then it
// has gone out fourteen times.

const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/email');

// --- fixtures ---------------------------------------------------------------
// Deliberately hand-built rather than read from a database: these assert on the
// envelope every email shares, and a fixture that needs a seeded DB to exist is
// a fixture that stops running the first time the schema moves.

const server = {
  employeeId: 1, name: 'Rosa Diaz', hours: 7.25,
  sales: { food: 185075, coffee: 12050, alcohol: 0 },
  cardTips: 29999, cashTips: 5500, totalTips: 35499,
  tipouts: { kitchen: 2776, barista: 181, busser: 4230 },
  tipoutTotal: 7187, tipsKept: 28312,
};
const serverCtx = { date: '2026-07-16', daypart: 'dinner', email: 'r@example.com', hourlyRate: 7.25, skipped: [] };

const support = { employeeId: 2, name: 'Ana Ortiz', role: 'barista', hours: 7, cashTotal: 6013, poolCard: 7359, tipShare: 316 };
const supportCtx = { date: '2026-07-16', daypart: 'dinner', email: 'a@example.com', hourlyRate: 15 };

const periodRow = {
  employeeId: 1, name: 'Rosa Diaz', shifts: 1, hours: 4, wk1Hours: 0, wk2Hours: 4,
  wage: 4400, paycheckTips: 10678, takeHome: 15078, cashTips: 6000,
};
const periodCtx = { from: '2026-07-04', to: '2026-07-17', email: 'r@example.com' };

// Shaped to what managerShiftEmail actually reads — reconciliation, pots and
// pool, not a `totals` bag. Guessing that wrong is how a fixture ends up
// asserting nothing, so these key names came from the function, not memory.
const shiftResults = {
  servers: [{ ...server }],
  support: [{ ...support, poolShare: 0 }],
  pots: { kitchen: 2776, barista: 181, busser: 4230 },
  pool: { cash: 0, togoCard: 0 },
  reconciliation: { totalTipsCollected: 35499, balanced: true },
  skipped: [],
};
const delivery = { sent: 1, previewed: 0, errors: ['Joseph — no email on file'], recipients: [{ name: 'Rosa Diaz', to: 'r@example.com', total: 28312 }] };

/** Every template, built. Named so a failure says which one. */
function everyEmail() {
  return [
    ['server nightly', E.serverEmail(server, serverCtx)],
    ['support nightly', E.supportEmail(support, supportCtx)],
    ['pay period', E.periodEmail(periodRow, periodCtx)],
    ['manager receipt', E.managerShiftEmail(shiftResults, { date: '2026-07-16', daypart: 'dinner' }, delivery)],
  ].map(([name, e]) => [name, typeof e === 'string' ? e : e.html]);
}

test('every email declares its own character set, early enough to count', () => {
  // Nodemailer sets the MIME charset, so a normal send was always fine. What
  // was not fine: anything rendering this HTML on its own — a client's "view in
  // browser", a forward that drops the headers, the files written to previews/.
  // With no declaration in the document those fall back to latin-1, and every
  // "·" becomes "Â·" and every "—" becomes "â€".
  //
  // Two things are asserted, because only the pair actually works. The meta has
  // to be inside the first 1024 bytes — that is as far as the HTML spec lets a
  // parser sniff before it gives up — and it has to come BEFORE the first
  // non-ASCII byte, or the parser has already guessed wrong and restarts.
  for (const [name, html] of everyEmail()) {
    const meta = html.search(/<meta[^>]+charset\s*=\s*["']?utf-8/i);
    assert.ok(meta !== -1, `${name}: declares a charset`);
    assert.ok(meta < 1024, `${name}: charset at byte ${meta}, past the 1024-byte sniffing window`);

    const bytes = Buffer.from(html, 'utf8');
    const firstHighByte = bytes.findIndex((b) => b > 127);
    if (firstHighByte !== -1) {
      const metaBytes = Buffer.from(html.slice(0, meta), 'utf8').length;
      assert.ok(metaBytes < firstHighByte,
        `${name}: charset declared at byte ${metaBytes}, after the first non-ASCII byte at ${firstHighByte}`);
    }
  }
});

test('the characters that used to break actually survive a naive decode', () => {
  // The failure was never abstract: it was these two characters. Decode each
  // email the way a client with no charset information would, and check the
  // mojibake is absent — which it can only be because the document says utf-8.
  for (const [name, html] of everyEmail()) {
    assert.ok(!/Â·|â€"|â€™|Ã©/.test(html), `${name}: no mojibake in the source`);
    const naive = Buffer.from(html, 'utf8').toString('latin1');
    if (/·|—/.test(html)) {
      assert.match(naive, /Â·|â€/,
        `${name}: should mangle when decoded as latin-1 — if it does not, the test is checking nothing`);
    }
  }
});

test('the pay-stub footer is gone from every email', () => {
  for (const [name, html] of everyEmail()) {
    assert.ok(!/not a pay stub/i.test(html), `${name}: no footer`);
    assert.ok(!/final amounts are set in payroll/i.test(html), `${name}: no footer`);
  }
});

test('the period email still says the money is not additional', () => {
  // That line used to lean on the footer for half its meaning — the footer
  // said "not a pay stub", this said "not extra pay". Only one of them is
  // left, so it has to carry the point on its own.
  const html = E.periodEmail(periodRow, periodCtx).html;
  assert.match(html, /isn't extra pay/i);
});

test('an email is still a complete document', () => {
  // Adding a <head> is the kind of change that quietly loses the <body>.
  for (const [name, html] of everyEmail()) {
    assert.match(html, /^<!doctype html>/i, `${name}: has a doctype`);
    assert.match(html, /<html>/i, `${name}: has <html>`);
    assert.match(html, /<body/i, `${name}: has <body>`);
    assert.match(html, /<\/body><\/html>$/i, `${name}: closes cleanly`);
    assert.ok(html.indexOf('<head>') < html.indexOf('<body'), `${name}: head before body`);
  }
});

test('every row is still a table, because Gmail strips flex', () => {
  // The oldest lesson in this file: display:flex collapsed every row into
  // "Date2026-07-16" in Gmail. Two-cell tables are the only layout email
  // clients agree on, and a redesign is exactly when that gets forgotten.
  for (const [name, html] of everyEmail()) {
    assert.ok(!/display:\s*flex/i.test(html), `${name}: no flex — Gmail drops it`);
    assert.ok(!/display:\s*grid/i.test(html), `${name}: no grid — same reason`);
    assert.ok(/<table[^>]+role="presentation"/i.test(html), `${name}: rows are tables`);
  }
});

// ---------------------------------------------------------------------------
// The port.
//
// emails-redesigned/ holds the approved HTML. These check that what the code
// emits still matches it, and that nothing the old emails carried was dropped
// on the way — the spec was explicit that this is a reskin, not a content
// change.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const APPROVED = path.join(__dirname, '..', 'emails-redesigned');

/**
 * The DISTINCT inline styles a template uses, sorted.
 *
 * Not the sequence: the approved manager receipt was rendered from a night
 * with two servers and seven support staff, and the fixture here has one of
 * each, so the same styling produces 32 rules against 53. Comparing the set
 * asks the question that matters — has any styling drifted — without pinning
 * the test to how many people happened to be on that shift. A row that lost
 * its styling adds or removes a member; a row that merely repeats does not.
 */
const skeleton = (html) => [...new Set(html.match(/style="[^"]*"/g) || [])].sort().join('|');

test('every template still matches the approved markup', () => {
  const pairs = [
    ['1-server-nightly.html', E.serverEmail(server, serverCtx).html],
    ['2-support-nightly.html', E.supportEmail(support, supportCtx).html],
    ['4-pay-period.html', E.periodEmail(periodRow, periodCtx).html],
    ['3-manager-receipt.html',
      E.managerShiftEmail(shiftResults, { date: '2026-07-16', daypart: 'dinner' }, delivery).html],
  ];
  for (const [file, mine] of pairs) {
    const approved = fs.readFileSync(path.join(APPROVED, file), 'utf8');
    assert.strictEqual(skeleton(mine), skeleton(approved),
      `${file}: the rendered styling has drifted from the approved template`);
  }
});

test('no blue survives the reskin', () => {
  // The old templates were built on #2563eb with a gradient masthead. Colour
  // means something now: green is money to you, red is money leaving or a
  // send that failed, and there is no third meaning.
  const OLD = [/#2563eb/i, /#1d4ed8/i, /#0f172a/i, /#f4f7fc/i, /#64748b/i, /#94a3b8/i,
    /#dc2626/i, /#059669/i, /linear-gradient/i, /border-radius:\s*[1-9]/i, /box-shadow/i];
  for (const [name, html] of everyEmail()) {
    for (const re of OLD) {
      assert.ok(!re.test(html), `${name}: still carries ${re}`);
    }
  }
});

test('the reskin dropped none of the information', () => {
  // The spec's own checklist, verbatim.
  const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const need = {
    'server nightly': ['Hours worked', 'Estimated wage', 'Your sales', 'Food', 'Coffee',
      'Your tips', 'Card tips', 'Cash tips', 'Total tips collected', 'Tip-out', 'Kitchen',
      'Barista', 'Busser', 'Total tip-out', 'Tips you keep', 'How this reaches you',
      'Cash you took home tonight', 'paycheck'],
    'support nightly': ['Hours worked', 'Estimated wage', 'Your tips', 'Cash tips',
      'To-go card tips', 'Server tip-out', 'Total tips'],
    'pay period': ['Shifts worked', 'Total hours', 'Week 1', 'Week 2', 'On your paycheck',
      'Wages', 'Card tips', 'Total on this check', 'Already paid to you', "isn't extra pay"],
    'manager receipt': ['Did not go out', 'Tonight', 'Tips collected', 'Tipped out to support',
      'Shared pool', 'Servers', 'Support', 'kept'],
  };
  for (const [name, html] of everyEmail()) {
    const text = strip(html);
    for (const item of need[name] || []) {
      assert.ok(text.includes(item), `${name}: lost "${item}"`);
    }
  }
});

test('who and when moved into the masthead rather than being dropped', () => {
  // Three rows became one subline. The values still have to be there.
  const s = E.serverEmail(server, serverCtx).html;
  assert.match(s, /Rosa Diaz · Server · 2026-07-16 · Dinner/);
  const p = E.periodEmail(periodRow, periodCtx).html;
  assert.match(p, /Rosa Diaz · Jul 4 – Jul 17/);
});
