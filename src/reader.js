'use strict';

// Photo-of-report reader. Sends one or more images of the end-of-day POS report
// to Claude's vision API and gets back structured per-server numbers. This is
// the "extract" half of extract-then-confirm — the manager reviews on the close
// screen before anything sends.

const Anthropic = require('@anthropic-ai/sdk');

// Default to the most capable model; override with READER_MODEL in .env if you
// want a cheaper/faster tier (e.g. claude-sonnet-5, claude-haiku-4-5).
const MODEL = process.env.READER_MODEL || 'claude-opus-4-8';

const SCHEMA = {
  type: 'object',
  properties: {
    servers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          food: { type: 'number' },
          coffee: { type: 'number' },
          alcohol: { type: 'number' },
          card_tips: { type: 'number' },
        },
        required: ['name', 'food', 'coffee', 'alcohol', 'card_tips'],
        additionalProperties: false,
      },
    },
    reported_total_tips: { type: 'number' },
  },
  required: ['servers'],
  additionalProperties: false,
};

const PROMPT =
  "These image(s) are an end-of-day sales report from a restaurant POS. For EACH server/employee listed, extract their food sales, coffee sales, alcohol sales, and CARD tips (not cash). " +
  'Return dollar amounts as plain numbers (e.g. 2100.5) — no "$" and no commas. If a category is not shown for someone, use 0. ' +
  'Only include real servers/employees — do NOT include category subtotals, section headers, or the grand total row as a "server". ' +
  'If the report shows a grand total of tips, put it in reported_total_tips. If several images are provided, they are pages of the same report — merge them into one list.';

/**
 * @param {Array<{buffer: Buffer, mimetype: string}>} files
 * @returns {Promise<{servers: Array, reported_total_tips?: number}>}
 */
async function readReport(files) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('No ANTHROPIC_API_KEY set — add one to .env to enable photo reading.');
    e.code = 'NO_KEY';
    throw e;
  }
  const client = new Anthropic();
  const images = files.map((f) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: /png|webp|gif/.test(f.mimetype) ? f.mimetype : 'image/jpeg',
      data: f.buffer.toString('base64'),
    },
  }));

  // Note: no `effort` here on purpose — it's only supported on the Opus /
  // Sonnet-5 tier and 400s on Haiku, which is the cheap model we recommend.
  // Structured output is what actually matters for reliable extraction.
  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: [...images, { type: 'text', text: PROMPT }] }],
    });
  } catch (apiErr) {
    // Turn SDK/API errors into something a restaurant manager can act on.
    const status = apiErr.status;
    const detail = apiErr.error?.error?.message || apiErr.message || 'unknown error';
    if (status === 401) throw new Error('the API key was rejected. Check ANTHROPIC_API_KEY.');
    if (status === 400 && /model/i.test(detail)) throw new Error(`the model "${MODEL}" rejected the request (${detail}). Try removing READER_MODEL to use the default.`);
    if (status === 429) throw new Error('rate limited — wait a moment and try again.');
    if (status === 413 || /too large/i.test(detail)) throw new Error('the photo is too large. Try one page at a time.');
    throw new Error(detail);
  }

  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const e = new Error('The model did not return readable numbers — try a clearer photo.');
    e.code = 'PARSE';
    throw e;
  }
  return data;
}

module.exports = { readReport, MODEL };

// ---------------------------------------------------------------------------
// INVOICE READER
// Deliberately extracts subtotal, tax and total as three separate numbers. An
// invoice shows several plausible totals — subtotal, tax, freight, deposits,
// sometimes a previous balance and an "amount due" that differs from the
// invoice total. Picking one silently is the failure that matters, because a
// wrong total looks exactly as reasonable as a right one.
// ---------------------------------------------------------------------------
// Two schemas, deliberately. Constrained decoding compiles the schema into a
// grammar before generating, and the combined header-plus-line-items schema
// was too big for that: the API spent three minutes on it and then refused
// with "Schema is too complex". Measured separately, the header compiles in
// ~2s and the line items in ~10s. So they are two calls.
//
// It is also the safer shape. The header is what the books need and it must
// not fail; the line items feed Products and can be retried or skipped. One
// schema meant a line-item field could break invoice entry entirely, which is
// exactly what happened.
const HEADER_SCHEMA = {
  type: 'object',
  properties: {
    vendor_name: { type: 'string', description: 'Supplier name as printed, e.g. "Sysco Food Services"' },
    invoice_number: { type: 'string' },
    invoice_date: { type: 'string', description: 'YYYY-MM-DD' },
    due_date: { type: 'string', description: 'YYYY-MM-DD, empty if not shown' },
    subtotal: { type: 'number', description: 'Before tax. 0 if not shown.' },
    tax: { type: 'number', description: '0 if none' },
    total: { type: 'number', description: 'Final amount payable for THIS invoice, including tax' },
    is_credit: { type: 'boolean', description: 'True for a credit memo / refund, where the total reduces what is owed' },
    category: { type: 'string', enum: ['Food', 'Coffee', 'Beverage', 'Alcohol', 'Supplies', 'Repairs', 'Services', 'Other'] },
    notes: { type: 'string', description: 'One short line: what was bought, or anything unusual like a handwritten adjustment' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'low if the image is unclear or the totals are ambiguous' },
  },
  required: ['vendor_name', 'total', 'category', 'confidence'],
  additionalProperties: false,
};

const LINES_SCHEMA = {
  type: 'object',
  properties: {
    line_items: {
      type: 'array',
      description: 'Every product line on the invoice. Empty if the lines cannot be read clearly.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The product as printed, e.g. "TOMATO ROMA 25LB"' },
          code: { type: 'string', description: 'Vendor item code / SKU / product number for the line. "" if not shown.' },
          brand: { type: 'string', description: 'Brand or label if printed separately from the description. "" if not shown.' },
          pack_size: { type: 'string', description: 'Pack or size as printed, e.g. "6/#10", "25 LB", "4/3 L". "" if not shown.' },
          qty: { type: 'number', description: 'Quantity billed. 0 if not shown.' },
          unit: { type: 'string', description: 'case, lb, each, gal — as printed. "" if not shown.' },
          unit_price: { type: 'number', description: 'Price for one unit. 0 if not shown.' },
          total: { type: 'number', description: 'Extended line total as printed.' },
        },
        required: ['description', 'total'],
        additionalProperties: false,
      },
    },
  },
  required: ['line_items'],
  additionalProperties: false,
};

const INVOICE_PROMPT =
  'This is a supplier invoice for a restaurant. Extract the fields exactly as printed — do not calculate or infer numbers that are not shown.\n' +
  'TOTAL: the amount payable for THIS invoice including tax. If the document shows a previous balance or account balance, ignore it — we want this invoice only. ' +
  'If "amount due" and "invoice total" differ, use the invoice total.\n' +
  'Return money as plain numbers (1240.5), no currency symbols or commas. Use 0 for anything not shown, and "" for missing text.\n' +
  'CATEGORY: pick from the list based on what was actually bought. Produce, meat, dry goods → Food. Coffee beans → Coffee. Soda, juice → Beverage. ' +
  'Beer, wine, spirits → Alcohol. Paper goods, cleaning, to-go containers → Supplies. Repairs and maintenance → Repairs. Pest control, linen, services → Services.\n' +
  'If the invoice is mixed, choose the category covering the largest share and say so in notes.\n' +
  'CONFIDENCE: use "low" if the image is blurry or cut off, or if you had to choose between competing totals. Say why in notes.\n' +
  'If several pages are provided they are one invoice — merge them.';

const LINES_PROMPT =
  'This is a supplier invoice for a restaurant. List every product line from its item table, using the description exactly as printed — abbreviations and all.\n' +
  'Capture the vendor item code / SKU column if the invoice has one, and the pack size and brand when they are printed separately.\n' +
  'Skip anything that is not a product: delivery charges, fuel surcharges, fees, deposits, credits, and the subtotal, tax and total rows.\n' +
  'Return money as plain numbers (12.75), no currency symbols or commas. Use 0 for anything not shown, and "" for missing text.\n' +
  'If a line is unreadable, leave it out rather than guessing at it. Return an empty list if the item table cannot be read.\n' +
  'If several pages are provided they are one invoice — merge them.';

/** Turn uploads into content blocks. PDFs go as documents — the API reads
 *  them natively, which beats rasterising a page and hoping the small print
 *  survives. */
function invoiceContent(files) {
  return files.map((f) => {
    if (/pdf/i.test(f.mimetype)) {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } };
    }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: /png|webp|gif/.test(f.mimetype) ? f.mimetype : 'image/jpeg',
        data: f.buffer.toString('base64'),
      },
    };
  });
}

/** Manager-readable version of whatever the API said. */
function invoiceError(apiErr) {
  const status = apiErr.status;
  const detail = apiErr.error?.error?.message || apiErr.message || 'unknown error';
  if (status === 401) return new Error('the API key was rejected. Check ANTHROPIC_API_KEY.');
  if (status === 400 && /schema|grammar/i.test(detail)) {
    // Ours to fix, not the manager's — say so rather than blaming their photo.
    return new Error('the reader could not prepare that request (schema issue). This is a bug, not your file.');
  }
  if (status === 400 && /model/i.test(detail)) return new Error(`the model "${MODEL}" rejected the request (${detail}).`);
  if (status === 429) return new Error('rate limited — wait a moment and try again.');
  if (status === 413 || /too large/i.test(detail)) return new Error('that file is too large. Try a photo instead of a scan, or one page at a time.');
  if (/timeout|timed out|aborted/i.test(detail)) return new Error('the reader took too long. Try again, or enter it by hand.');
  return new Error(detail);
}

// A ceiling on any single read. Without one the client sat on a request for
// three minutes before the API gave up, and the person uploading had no idea
// whether it was working.
const READ_TIMEOUT_MS = Number(process.env.READER_TIMEOUT_MS || 90_000);

async function askJSON(client, content, prompt, schema, maxTokens) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: [...content, { type: 'text', text: prompt }] }],
  }, { timeout: READ_TIMEOUT_MS });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

/**
 * Read an invoice: the accounting header, and the product lines behind it.
 *
 * Two calls, because one schema covering both is too complex to compile (see
 * the note above the schemas). They are sequenced header-first so that the
 * part the books need is never held up by the part Products wants — if the
 * line-item read fails, the invoice still comes back fully filled in and the
 * only thing lost is the automatic product import.
 *
 * @param {Array<{buffer:Buffer, mimetype:string}>} files  images and/or PDFs
 */
async function readInvoice(files) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('No ANTHROPIC_API_KEY set — add one to .env to enable invoice reading.');
    e.code = 'NO_KEY';
    throw e;
  }
  const client = new Anthropic();
  const content = invoiceContent(files);

  // --- the header: essential. A failure here means hand entry.
  let data;
  try {
    data = await askJSON(client, content, INVOICE_PROMPT, HEADER_SCHEMA, 1024);
  } catch (apiErr) {
    if (apiErr instanceof SyntaxError) throw new Error('Could not read that invoice — try a clearer photo, or enter it by hand.');
    throw invoiceError(apiErr);
  }

  // --- the lines: best effort. Never allowed to sink the invoice.
  data.line_items = [];
  try {
    const lines = await askJSON(client, content, LINES_PROMPT, LINES_SCHEMA, 8192);
    if (Array.isArray(lines.line_items)) data.line_items = lines.line_items;
  } catch (e) {
    data.lines_error = invoiceError(e).message;
    console.error('[reader] line items unavailable:', data.lines_error);
  }

  // A credit memo reduces what you owe, so it belongs in the ledger as negative.
  if (data.is_credit) {
    for (const k of ['subtotal', 'tax', 'total']) if (data[k] > 0) data[k] = -data[k];
    // The lines go negative too, or returning a case of tomatoes would read as
    // buying one more and push the average price the wrong way.
    for (const l of data.line_items || []) {
      if (l.total > 0) l.total = -l.total;
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// DOCUMENTS
//
// A filing cabinet, not a ledger. What matters about a lease is when it ends,
// about a 941 which quarter it covers, about a certificate of insurance when
// it lapses — and none of that is money.
//
// What this deliberately does NOT read is identifiers. A W-2 or a 1099 carries
// a social security number, a 941 carries an EIN, a bank letter carries an
// account number. This database is a plain SQLite file with no encryption at
// rest, it lives on a hosted disk, and it is read by a web app behind one
// shared password. Lifting those numbers out of a PDF and into it would take a
// document that is already sitting in one protected place and copy its worst
// contents somewhere weaker — for no benefit, because nobody searches their
// filing cabinet by SSN. The file itself is kept and the number stays in it.
// ---------------------------------------------------------------------------
const DOC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What this document is, as a person would name it in a folder. Use the official name if it has one, e.g. "Form 941 — Employer\'s Quarterly Federal Tax Return". Never a filename.' },
    issuer: { type: 'string', description: 'Who issued or sent it, e.g. "Internal Revenue Service", "Gusto", the landlord, the insurer. "" if not shown.' },
    category: { type: 'string', enum: ['Payroll', 'Tax', 'Lease', 'Insurance', 'HR', 'Permit', 'Licence', 'Banking', 'Legal', 'Utilities', 'Other'] },
    doc_date: { type: 'string', description: 'The date on the document itself, YYYY-MM-DD. "" if not shown.' },
    period_start: { type: 'string', description: 'If it covers a period (a quarter, a policy year, a lease term), the first day, YYYY-MM-DD. "" if it covers no period.' },
    period_end: { type: 'string', description: 'The last day of that period, YYYY-MM-DD. "" if it covers no period.' },
    expires_on: { type: 'string', description: 'The date this stops being valid or must be renewed — a permit expiry, a policy end, a lease end. YYYY-MM-DD, "" if it does not expire.' },
    action_by: { type: 'string', description: 'A date something must be DONE by: a filing deadline, a payment due date, a signature date. YYYY-MM-DD, "" if nothing is required.' },
    reference: { type: 'string', description: 'A non-personal reference: a form number ("941"), policy number, permit number, case or account reference that is not a bank account. "" if none. NEVER a social security number, EIN, tax ID, bank account or card number.' },
    summary: { type: 'string', description: 'One plain sentence: what this is and why it was kept. No numbers from the document.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'low if the scan is unclear or you had to guess what it is' },
  },
  required: ['title', 'category', 'summary', 'confidence'],
  additionalProperties: false,
};

const DOC_PROMPT =
  'This is a business document a restaurant owner is filing: a tax form, a payroll report, a lease, a licence, an insurance certificate, a letter from an agency, or similar.\n' +
  'Identify what it is and the dates that make it worth keeping. Read the fields as printed — do not infer a date that is not there.\n' +
  'TITLE: what a person would write on the folder tab. Prefer the official name printed on it.\n' +
  'DATES: doc_date is the date ON it. period_start/period_end are the span it COVERS — for a quarterly return that is the quarter, e.g. Q1 2026 is 2026-01-01 to 2026-03-31. ' +
  'expires_on is when it stops being valid. action_by is when something must be done. Leave any of them "" rather than guessing.\n' +
  'PRIVACY — this matters more than completeness. Do NOT return any social security number, individual taxpayer number, EIN or other tax ID, bank account or routing number, card number, ' +
  'date of birth, or home address, in ANY field, including summary and reference. If the only reference on the document is one of those, return "" for reference. ' +
  'Do not restate an employee\'s pay or an individual\'s figures in the summary. Describe the document, not its contents.\n' +
  'If several pages are provided they are one document — read them as a whole and describe the whole.';

/**
 * Read a document well enough to file it.
 *
 * One call, unlike an invoice: there is no second half to fetch, and a
 * document that cannot be read is still worth keeping — the caller falls back
 * to a plain upload with the title typed by hand.
 *
 * @param {Array<{buffer:Buffer, mimetype:string}>} files  images and/or PDFs
 */
async function readDocument(files) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('No ANTHROPIC_API_KEY set — add one to .env to enable document reading.');
    e.code = 'NO_KEY';
    throw e;
  }
  const client = new Anthropic();
  try {
    const data = await askJSON(client, invoiceContent(files), DOC_PROMPT, DOC_SCHEMA, 1024);
    // A backstop for the prompt above. A model that ignores the instruction
    // once, on one document, would write the number into the database for
    // good — and nothing downstream would ever flag it.
    return scrubIdentifiers(data);
  } catch (apiErr) {
    if (apiErr instanceof SyntaxError) throw new Error('Could not read that document — try a clearer scan, or fill it in by hand.');
    throw invoiceError(apiErr);
  }
}

/**
 * Remove anything shaped like an identifier from what came back.
 *
 * Belt and braces on top of the prompt, because the cost of the two failures
 * is not symmetrical: a redacted reference is a small annoyance, an SSN in an
 * unencrypted database is permanent.
 */
const ID_SHAPES = [
  /\b\d{3}-\d{2}-\d{4}\b/g,          // social security number
  /\b\d{2}-\d{7}\b/g,                // EIN
  /\b\d{9,17}\b/g,                   // bank account / routing / long ID runs
  /\b(?:\d[ -]?){13,19}\b/g,           // card numbers, spaced or hyphenated
];
function scrubIdentifiers(data) {
  const clean = (v) => {
    if (typeof v !== 'string') return v;
    let out = v;
    for (const re of ID_SHAPES) out = out.replace(re, '[removed]');
    return out;
  };
  const out = {};
  for (const [k, v] of Object.entries(data || {})) out[k] = clean(v);
  return out;
}

// ---------------------------------------------------------------------------
// EXPENSES
//
// A till receipt, not an invoice. There is no vendor account, no invoice
// number and usually no line worth keeping — what is wanted is what it was,
// where, how much and when, so the person who paid does not have to type it
// one-handed in a car park.
//
// Scrubbed like a document, and for a sharper reason: a card receipt prints
// the last four digits, sometimes more, and an auth code that looks like an
// account number. None of that belongs in the database.
// ---------------------------------------------------------------------------
const EXPENSE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'What was bought, in a few words, as a person would write it on the expense: "Bag of ice", "Cleaning supplies", "Coffee filters and cups". Not the shop name, and not a full item list.' },
    where_bought: { type: 'string', description: 'The shop or merchant, e.g. "Costco", "Home Depot". "" if not shown.' },
    total: { type: 'number', description: 'The amount actually paid, including tax — the grand total at the foot, not the subtotal. Plain number, no currency symbol.' },
    spent_on: { type: 'string', description: 'The date on the receipt, YYYY-MM-DD. "" if not shown.' },
    category: { type: 'string', enum: ['Groceries', 'Ice', 'Supplies', 'Cleaning', 'Repairs', 'Equipment', 'Kitchen', 'Bar', 'Office', 'Travel', 'Other'] },
    paid_with: { type: 'string', enum: ['', 'Their own money', 'Company card', 'Company cash', 'Drawer cash', 'Other'], description: 'Only if the receipt actually says how it was paid — "CASH" or a card line. Otherwise "", because who owns the card is not on the receipt and guessing it wrong creates a debt that is not owed.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'low if the photo is cut off, creased or unreadable, or if you had to choose between competing totals' },
    notes: { type: 'string', description: 'One short line only if something is odd — a total that does not add up, a second receipt in shot. "" normally.' },
  },
  required: ['name', 'total', 'category', 'confidence'],
  additionalProperties: false,
};

const EXPENSE_PROMPT =
  'This is a till receipt for something bought for a restaurant — a shop run, a hardware part, a bag of ice.\n' +
  'TOTAL: the amount actually paid at the foot of the receipt, including tax. Not the subtotal, and not a single line. ' +
  'If the receipt shows change given, the total is still what was rung up, not the cash tendered.\n' +
  'NAME: a few words describing what was bought, the way somebody would write it in an expense log. If there are many items, summarise them ' +
  '("Cleaning supplies", "Produce and dry goods") rather than listing them.\n' +
  'PAID WITH: only if it is printed. A card receipt does not say whose card it is, so leave it "" unless the receipt itself is explicit.\n' +
  'PRIVACY: never return a card number or any part of one, an auth or approval code, a loyalty or member number, or a phone number, in ANY field. ' +
  'They are on the receipt and that is where they stay.\n' +
  'If several photos are provided they are one receipt, photographed in pieces — read them as one and give one total.';

/**
 * Read a till receipt.
 *
 * Same shape as readDocument: one call, and a failure is survivable because
 * the form behind it still works by hand.
 *
 * @param {Array<{buffer:Buffer, mimetype:string}>} files  images and/or PDFs
 */
async function readExpense(files) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('No ANTHROPIC_API_KEY set — add one to .env to enable receipt reading.');
    e.code = 'NO_KEY';
    throw e;
  }
  const client = new Anthropic();
  try {
    const data = await askJSON(client, invoiceContent(files), EXPENSE_PROMPT, EXPENSE_SCHEMA, 1024);
    return scrubIdentifiers(data);
  } catch (apiErr) {
    if (apiErr instanceof SyntaxError) throw new Error('Could not read that receipt — try a clearer photo, or type it in.');
    throw invoiceError(apiErr);
  }
}

module.exports.readExpense = readExpense;
module.exports.EXPENSE_SCHEMA = EXPENSE_SCHEMA;

module.exports.readDocument = readDocument;
module.exports.DOC_SCHEMA = DOC_SCHEMA;
module.exports.scrubIdentifiers = scrubIdentifiers;

module.exports.readInvoice = readInvoice;
// Exported for the regression test that keeps them apart.
module.exports.HEADER_SCHEMA = HEADER_SCHEMA;
module.exports.LINES_SCHEMA = LINES_SCHEMA;
