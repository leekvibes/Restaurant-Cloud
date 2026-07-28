'use strict';

// Config-driven "collections" — each entry below becomes a full section with a
// list page, an add form, file uploads, and (unless append-only) delete. Adding
// a new tracker later is just another object in MODULES; no new plumbing.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db } = require('./db');
const { layout, flash, esc, money, canWrite } = require('./views');
const { toCents } = require('./money');
const { isoDate, startOfToday } = require('./dates');

// On a host like Render, point UPLOAD_DIR at the mounted persistent disk
// (e.g. /var/data/uploads) so invoice photos survive restarts and redeploys.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Options for the invoice "vendor" dropdown, loaded live from the vendors table.
const vendorOptions = () =>
  db.prepare('SELECT id, name FROM m_vendors ORDER BY name').all().map((v) => ({ value: v.id, label: v.name }));

// ---------------------------------------------------------------------------
// MODULE DEFINITIONS
// ---------------------------------------------------------------------------
const MODULES = [
  {
    slug: 'expirations', table: 'm_expirations', title: 'Expirations', icon: '⏰',
    blurb: 'Licenses, permits, insurance — soonest first',
    orderBy: 'expires_on ASC',
    dateField: 'expires_on',
    fields: [
      { name: 'name', label: 'What', type: 'text', required: true, list: true },
      { name: 'category', label: 'Type', type: 'select', list: true,
        options: ['License', 'Permit', 'Certification', 'Insurance', 'Inspection', 'Lease', 'Contract', 'Other'] },
      { name: 'expires_on', label: 'Expires on', type: 'date', required: true, list: true },
      { name: 'responsible', label: 'Who renews it', type: 'text', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    // Money spent outside the invoice flow: the Costco run, a bag of ice, a
    // part from the hardware shop. An invoice is a bill from a vendor you have
    // an account with and settle later; this is somebody standing at a till.
    // The two do not belong in one table — an expense has no vendor, no due
    // date and no terms, and it usually has something an invoice never does,
    // which is a person who is now owed their money back.
    slug: 'expenses', table: 'm_expenses', title: 'Expenses', icon: '🧺',
    blurb: 'Anything bought outside an invoice — and who is owed for it',
    orderBy: 'spent_on DESC, id DESC',
    dateField: null,
    fields: [
      { name: 'spent_on', label: 'Date', type: 'date', required: true, list: true },
      { name: 'name', label: 'What was bought', type: 'text', required: true, list: true },
      { name: 'where_bought', label: 'Where', type: 'text', list: true },
      { name: 'category', label: 'Category', type: 'select', list: true,
        options: ['Groceries', 'Ice', 'Supplies', 'Packaging', 'Cleaning', 'Repairs', 'Equipment',
          'Utilities', 'Rent', 'Software', 'Insurance', 'Marketing', 'Recruiting', 'Professional',
          'Kitchen', 'Bar', 'Office', 'Travel', 'Other'] },
      { name: 'amount_cents', label: 'Amount', type: 'money', required: true, list: true },
      { name: 'paid_by', label: 'Who paid', type: 'text', required: true, list: true },
      // Whether the restaurant has already parted with the money, or a person
      // has and is waiting. This is the whole reason "who paid" is worth
      // recording, so it sits next to it rather than in the notes.
      { name: 'paid_with', label: 'Paid with', type: 'select',
        options: ['Their own money', 'Company card', 'Company cash', 'Drawer cash', 'Other'] },
      { name: 'reimbursed_on', label: 'Paid back on', type: 'date' },
      // Where the money came from when they were paid back — so a cash-drawer
      // payout is traceable, not just "settled at some point". For a drawer
      // payout, `reimbursed_on` is the day it left the drawer.
      { name: 'reimbursed_via', label: 'Paid back via', type: 'select',
        options: ['Cash drawer', 'Company cash', 'Company card', 'Check', 'Bank transfer', 'Other'] },
      { name: 'file', label: 'Receipt photo', type: 'file', list: true, multiple: true },
      { name: 'pages', label: 'Pages', type: 'pages', pagesOf: 'file' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    // If someone paid out of their own pocket and hasn't been paid back, tell the
    // back office so they get reimbursed instead of having to chase it. Only that
    // case — a company-card buy needs no follow-up. Lazily required, like the
    // incident hook, so the registry never has to know the notification module.
    onCreate(row) {
      if (row.paid_with !== 'Their own money' || row.reimbursed_on) return;
      const amt = '$' + ((Number(row.amount_cents) || 0) / 100).toFixed(2);
      const who = row.paid_by || 'Someone';
      require('./portal').adminNotify('expense', `${who} is owed ${amt}`,
        { body: `Paid their own money for ${row.name || 'an expense'}${row.where_bought ? ' at ' + row.where_bought : ''}`,
          href: `/c/expenses/${row.id}` });
    },
  },
  {
    slug: 'invoices', table: 'm_invoices', title: 'Invoices', icon: '🧾',
    blurb: 'Upload & assign to a vendor',
    orderBy: 'invoice_date DESC, id DESC',
    fields: [
      { name: 'invoice_date', label: 'Date', type: 'date', list: true },
      { name: 'due_date', label: 'Due date', type: 'date', list: true },
      { name: 'vendor_id', label: 'Vendor', type: 'select', list: true, options: vendorOptions },
      { name: 'invoice_number', label: 'Invoice #', type: 'text' },
      // Total INCLUDES tax — it's money actually paid, so it's what cost
      // percentages should measure. Subtotal and tax are kept alongside it so
      // the split is visible rather than buried in one figure.
      { name: 'amount_cents', label: 'Total', type: 'money', list: true },
      { name: 'subtotal_cents', label: 'Subtotal (before tax)', type: 'money' },
      { name: 'tax_cents', label: 'Tax', type: 'money' },
      { name: 'category', label: 'Category', type: 'select', list: true,
        options: ['Food', 'Coffee', 'Beverage', 'Alcohol', 'Packaging', 'Supplies', 'Cleaning',
          'Repairs', 'Equipment', 'Utilities', 'Rent', 'Software', 'Insurance', 'Marketing',
          'Recruiting', 'Professional', 'Services', 'Other'] },
      { name: 'status', label: 'Status', type: 'select', list: true, options: ['Unpaid', 'Paid'] },
      // How it was paid. Declared here as well as on the upload drawer so the
      // generic edit form can correct it later — the two have to agree or a
      // field is silently uneditable after it's saved.
      { name: 'payment_method', label: 'Paid by', type: 'select',
        options: ['Cash', 'Check', 'ACH', 'Credit card', 'Auto pay', 'Other'] },
      { name: 'file', label: 'Invoice file (PDF or photo)', type: 'file', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
      // How this invoice got its figures: read by AI, read then corrected, or
      // typed by hand. Drives the badge that says which ones to double-check.
      { name: 'ai_status', label: 'Entered by', type: 'text' },
      { name: 'ai_confidence', label: 'Read confidence', type: 'text' },
    ],
  },
  {
    slug: 'vendors', table: 'm_vendors', title: 'Vendors', icon: '🚚',
    blurb: 'Who you order from, sites & logins',
    orderBy: 'name ASC',
    fields: [
      { name: 'name', label: 'Vendor name', type: 'text', required: true, list: true },
      { name: 'category', label: 'Supplies', type: 'select', list: true,
        options: ['Produce', 'Meat', 'Seafood', 'Dairy', 'Dry goods', 'Coffee', 'Beverage', 'Alcohol',
          'Cleaning', 'Paper goods', 'Equipment', 'Services', 'Other'] },
      { name: 'ordering_method', label: 'How you order', type: 'select',
        options: ['Rep / text', 'Phone', 'Email', 'Online portal', 'App', 'Standing order'] },
      { name: 'favorite', label: 'Preferred vendor', type: 'text' },
      { name: 'inactive', label: 'No longer used', type: 'text' },
      { name: 'website', label: 'Website', type: 'url', list: true },
      { name: 'account_number', label: 'Account #', type: 'text' },
      { name: 'login_username', label: 'Login username', type: 'text' },
      { name: 'login_hint', label: 'Where the password is kept', type: 'text', placeholder: 'e.g. 1Password — not stored here' },
      { name: 'rep_name', label: 'Your rep', type: 'text', list: true },
      { name: 'phone', label: 'Phone', type: 'tel', list: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'order_notes', label: 'Order notes / schedule', type: 'textarea' },
    ],
  },
  {
    slug: 'contacts', table: 'm_contacts', title: 'Contacts', icon: '📇',
    blurb: 'Plumber, HVAC, POS support, health dept',
    orderBy: 'name ASC',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      { name: 'role', label: 'Role', type: 'text', list: true, placeholder: 'Plumber, HVAC, POS support…' },
      { name: 'company', label: 'Company', type: 'text', list: true },
      { name: 'phone', label: 'Phone', type: 'tel', list: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    slug: 'equipment', table: 'm_equipment', title: 'Equipment', icon: '🔧',
    blurb: 'Model, serial, warranty, who to call',
    orderBy: 'name ASC',
    dateField: 'warranty_expires',
    fields: [
      { name: 'name', label: 'Equipment', type: 'text', required: true, list: true, placeholder: 'Walk-in cooler' },
      { name: 'model', label: 'Model', type: 'text', list: true },
      { name: 'serial', label: 'Serial #', type: 'text', list: true },
      { name: 'location', label: 'Location', type: 'text' },
      { name: 'warranty_expires', label: 'Warranty expires', type: 'date', list: true },
      { name: 'service_contact', label: 'Service contact', type: 'text', list: true },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'notes', label: 'Service history / notes', type: 'textarea' },
    ],
  },
  {
    slug: 'documents', table: 'm_documents', title: 'Documents', icon: '📁',
    blurb: 'Payroll, tax, lease, HR files',
    orderBy: 'created_at DESC',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, list: true },
      { name: 'category', label: 'Category', type: 'select', list: true,
        options: ['Payroll', 'Tax', 'Lease', 'Insurance', 'HR', 'Permit', 'Licence',
          'Banking', 'Legal', 'Utilities', 'Other'] },
      { name: 'issuer', label: 'Who it is from', type: 'text', list: true },
      // Four different dates, because a document has up to four and they are
      // not interchangeable. The date on a lease is not when it runs out, and
      // the quarter a 941 covers is neither.
      { name: 'doc_date', label: 'Date on it', type: 'date', list: true },
      { name: 'period_start', label: 'Covers from', type: 'date' },
      { name: 'period_end', label: 'Covers to', type: 'date' },
      { name: 'expires_on', label: 'Expires / renews on', type: 'date', list: true },
      { name: 'action_by', label: 'Something due by', type: 'date' },
      // A form number or policy number. Never a tax ID or an account number —
      // see the note above DOC_SCHEMA in reader.js for why.
      { name: 'reference', label: 'Reference', type: 'text' },
      { name: 'summary', label: 'What it is', type: 'textarea' },
      { name: 'file', label: 'File', type: 'file', required: true, list: true, multiple: true },
      { name: 'pages', label: 'Pages', type: 'pages', pagesOf: 'file' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
      { name: 'ai_status', label: 'Entered by', type: 'text' },
    ],
  },
  {
    slug: 'incidents', table: 'm_incidents', title: 'Incident log', icon: '🚨',
    blurb: 'Injuries, refusals, write-ups (append-only)',
    orderBy: 'created_at DESC',
    appendOnly: true,
    fields: [
      { name: 'occurred_at', label: 'Date', type: 'date', list: true },
      { name: 'type', label: 'Type', type: 'select', list: true,
        options: ['Guest injury', 'Alcohol refusal', 'Employee write-up', 'Guest complaint', 'Theft / loss', 'Other'] },
      { name: 'people', label: 'People involved', type: 'text', list: true },
      { name: 'description', label: 'What happened', type: 'textarea', required: true },
      { name: 'logged_by', label: 'Logged by', type: 'text', list: true },
    ],
    // When an incident is filed, tell the back office — the owner wants to hear
    // about it the moment it is written down. Required lazily so this low-level
    // registry never has to know the notification module at load time.
    onCreate(row) {
      const type = row.type || 'Incident';
      const who = row.logged_by ? ` by ${row.logged_by}` : '';
      const detail = String(row.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      require('./portal').adminNotify('incident', `Incident logged: ${type}${who}`,
        { body: detail || null, href: `/c/incidents/${row.id}` });
    },
  },
  {
    slug: 'notes', table: 'm_notes', title: 'Decisions log', icon: '📝',
    blurb: 'What you changed and why',
    orderBy: 'created_at DESC',
    fields: [
      { name: 'note_date', label: 'Date', type: 'date', list: true },
      { name: 'title', label: 'Decision', type: 'text', required: true, list: true },
      { name: 'body', label: 'What & why', type: 'textarea', required: true },
    ],
  },
  // Par levels used to live here. It is now Products — a hand-written
  // section in server.js backed by its own tables, because purchasing history
  // needs more than the generic one-table CRUD this registry provides. The
  // m_par table is left in place; src/products.js migrated its rows once.
  {
    slug: 'recurring', table: 'm_recurring', title: 'Recurring tasks', icon: '🔁',
    blurb: 'Grease trap, hood, pest control, deep cleans',
    orderBy: 'next_due ASC',
    dateField: 'next_due',
    // "mark done" advances the next-due date by the frequency.
    rowActions: (row) => `<form method="post" action="/c/recurring/${row.id}/done" style="margin:0"><button class="link">mark done</button></form>`,
    fields: [
      { name: 'name', label: 'Task', type: 'text', required: true, list: true, placeholder: 'Hood cleaning' },
      { name: 'category', label: 'Category', type: 'select', list: true,
        options: ['Cleaning', 'Maintenance', 'Safety', 'Pest Control', 'Compliance', 'Other'] },
      { name: 'frequency', label: 'How often', type: 'select', list: true, options: ['Weekly', 'Monthly', 'Quarterly', 'Annual'] },
      { name: 'next_due', label: 'Next due', type: 'date', list: true },
      { name: 'last_done', label: 'Last done', type: 'date', list: true },
      { name: 'responsible', label: 'Who', type: 'text', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
];

const bySlug = Object.fromEntries(MODULES.map((m) => [m.slug, m]));

// ---------------------------------------------------------------------------
// Schema — generated from the field configs (single source of truth)
// ---------------------------------------------------------------------------
function sqlType(f) {
  if (f.type === 'money') return 'INTEGER DEFAULT 0';
  if (f.type === 'number') return 'REAL';
  return 'TEXT';
}

/**
 * Every page of a document, as JSON, alongside the single `file` that has
 * always been there.
 *
 * A photographed lease is eight pictures, not one. The reader was already
 * given all of them — it is the storing that kept page one and dropped the
 * rest.
 *
 * Deliberately additive. `file` still holds the first page and every existing
 * link, thumbnail and download in the app goes on reading it without knowing
 * this exists; a row saved before today, or by the generic edit form, has no
 * `pages` at all and falls back to exactly what it did before.
 */
function pagesOf(row) {
  if (!row) return [];
  try {
    const a = JSON.parse(row.pages || 'null');
    if (Array.isArray(a) && a.length) return a.filter((x) => typeof x === 'string' && x);
  } catch { /* not JSON — fall through to the single file */ }
  return row.file ? [row.file] : [];
}
for (const m of MODULES) {
  const cols = m.fields.map((f) => `  ${f.name} ${sqlType(f)}`).join(',\n');
  db.exec(`CREATE TABLE IF NOT EXISTS ${m.table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
${cols}
  );`);
  // CREATE IF NOT EXISTS does nothing to a table that already exists, so a
  // field added to the config above would silently never appear on an existing
  // database — the column just wouldn't be there, and writes to it would throw.
  const have = db.prepare(`PRAGMA table_info(${m.table})`).all().map((c) => c.name);
  for (const f of m.fields) {
    if (!have.includes(f.name)) db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${f.name} ${sqlType(f)}`);
  }
}

// ---------------------------------------------------------------------------
// Indexes for the collections that grow without bound.
//
// The registry creates tables but never indexed them, so every list page read
// these by full scan. That is invisible on a demo database and is the thing
// that decays first: a restaurant filing twenty invoices a week has four
// thousand of them inside four years, and each is a row SQLite has to touch to
// answer "show me this year" or "what has this vendor billed".
//
// Only the three that accumulate are indexed. Expirations, equipment, contacts
// and the rest hold tens of rows and stay faster unindexed than they would be
// with a b-tree to maintain on every write.
//
// Verified with EXPLAIN QUERY PLAN against three years of seeded data: each of
// these turned a SCAN into a SEARCH, or removed a temporary b-tree sort. None
// of them changes a result — an index cannot, it only changes how the same
// rows are found.
// idx_inv_vendor was first shipped as a single-column expression index. It is
// being widened to carry the sort keys, but CREATE INDEX IF NOT EXISTS keeps
// whatever already has that name — so a database from the earlier version would
// hold onto the narrow one and never gain the ordering. Drop it once, only when
// it is the old shape, so the CREATE below rebuilds the full index. A database
// that never had it, or already has the three-column version, is untouched.
try {
  const hasInvoices = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='m_invoices'").get();
  if (hasInvoices) {
    const keys = db.prepare('PRAGMA index_info(idx_inv_vendor)').all().length;
    if (keys > 0 && keys < 3) db.exec('DROP INDEX idx_inv_vendor;');
  }
} catch (e) { console.error('[index] idx_inv_vendor migration skipped:', e.message); }

db.exec(`
  -- The invoice ledger is read a year at a time, newest first.
  CREATE INDEX IF NOT EXISTS idx_inv_date ON m_invoices (invoice_date DESC);

  -- vendor_id is TEXT here — the registry types every column TEXT — and rows
  -- written by different paths hold "1" or "1.0", so every caller compares it
  -- as CAST(vendor_id AS INTEGER). A plain index on the column cannot serve
  -- that: the cast has to be indexed, not the column. This is why the vendor
  -- page scanned the whole table once per vendor.
  --
  -- The sort keys ride along after the filter. The vendor detail page reads one
  -- vendor's invoices "ORDER BY invoice_date DESC, id DESC", and with only the
  -- cast indexed it found the vendor's rows by index but still sorted them in a
  -- temporary b-tree. Carrying (invoice_date DESC, id DESC) in the same index,
  -- in that order after the vendor key, lets the ordered slice come straight
  -- off the index with no sort. The leading column is unchanged, so the
  -- filter-only callers — the grouped vendor rollup and the single-vendor
  -- count — use it exactly as before.
  CREATE INDEX IF NOT EXISTS idx_inv_vendor
    ON m_invoices (CAST(vendor_id AS INTEGER), invoice_date DESC, id DESC);

  -- Unpaid and overdue, which is a small slice of a large table and the one
  -- the dashboard asks for on every load. Partial, because a full index on
  -- status would be almost entirely 'Paid' rows nobody looks up this way, and
  -- "status <> 'Paid'" cannot use an ordinary index at all.
  CREATE INDEX IF NOT EXISTS idx_inv_open ON m_invoices (due_date) WHERE status <> 'Paid';

  -- Both lists are read in date order, and both were sorting the whole table
  -- in a temp b-tree to do it.
  CREATE INDEX IF NOT EXISTS idx_exp_date ON m_expenses (spent_on DESC, id DESC);

  -- The documents list orders by COALESCE(doc_date, created_at) DESC, id DESC —
  -- a filed date is not always the date typed on the paper, so it falls back to
  -- when the row was created. The index has to be on that whole expression, not
  -- on doc_date alone: an index on doc_date cannot order by COALESCE(doc_date,
  -- created_at), so the old idx_doc_date was never used and the list still
  -- scanned and sorted in a temp b-tree. Indexing the ordering expression
  -- itself lets the rows come back already in order. (The query returns every
  -- document — no filter — so the plan reads the index end to end; that read is
  -- the work, and it is no longer followed by a sort.)
  CREATE INDEX IF NOT EXISTS idx_doc_order ON m_documents (COALESCE(doc_date, created_at) DESC, id DESC);
`);

// The documents index used to be idx_doc_date on doc_date alone, which the real
// query could never use. A database that ran the earlier version still carries
// it — dead weight maintained on every write and never read. Drop it once.
db.exec('DROP INDEX IF EXISTS idx_doc_date;');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const resolveOptions = (f) => (typeof f.options === 'function' ? f.options() : (f.options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: o })));

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((then - now) / 86400000);
}

function expiryBadge(days) {
  if (days === null) return '';
  if (days < 0) return `<span class="pill pill-red">expired ${-days}d ago</span>`;
  if (days <= 7) return `<span class="pill pill-red">${days}d</span>`;
  if (days <= 30) return `<span class="pill pill-amber">${days}d</span>`;
  if (days <= 60) return `<span class="pill pill-yellow">${days}d</span>`;
  return `<span class="pill pill-ok">${days}d</span>`;
}

/** Display one field's value for the list table. */
function cellValue(m, f, row) {
  const v = row[f.name];
  if (f.type === 'money') return money(v || 0);
  if (f.type === 'file') return v ? `<a href="/uploads/${esc(v)}" target="_blank">open</a>` : '<span class="muted">—</span>';
  if (f.type === 'url') return v ? `<a href="${esc(v)}" target="_blank">${esc(v.replace(/^https?:\/\//, ''))}</a>` : '<span class="muted">—</span>';
  if (f.type === 'select' && typeof f.options === 'function') {
    const opt = resolveOptions(f).find((o) => String(o.value) === String(v));
    return opt ? esc(opt.label) : '<span class="muted">—</span>';
  }
  if (f.name === m.dateField && f.type === 'date') {
    return v ? `${esc(v)} ${expiryBadge(daysUntil(v))}` : '<span class="muted">—</span>';
  }
  return v ? esc(v) : '<span class="muted">—</span>';
}

/** @param row  existing values when editing; omit for a blank add form. */
function renderInput(f, row) {
  const cur = row ? row[f.name] : null;
  const has = cur !== null && cur !== undefined && cur !== '';
  const req = f.required ? ' required' : '';
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  if (f.type === 'textarea') return `<textarea name="${f.name}"${req}${ph} rows="3">${has ? esc(cur) : ''}</textarea>`;
  if (f.type === 'select') {
    const opts = resolveOptions(f).map((o) =>
      `<option value="${esc(o.value)}"${String(o.value) === String(cur) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    return `<select name="${f.name}"${req}><option value="">—</option>${opts}</select>`;
  }
  if (f.type === 'file') {
    // Required only when there's nothing on file yet — otherwise leaving it
    // blank keeps whatever is already attached.
    const need = f.required && !has ? ' required' : '';
    const multi = f.multiple ? ' multiple' : '';
    const current = has
      ? `<span class="file-current">Attached: <a href="/uploads/${esc(cur)}" target="_blank">open</a> — choosing ${f.multiple ? 'files replaces them' : 'a file replaces it'}</span>`
      : '';
    return `<input type="file" name="${f.name}"${need}${multi}>${current}`;
  }
  if (f.type === 'money') return `<input name="${f.name}" type="number" step="0.01" min="0"${req} placeholder="0.00" value="${has ? (Number(cur) / 100).toFixed(2) : ''}">`;
  const map = { date: 'date', number: 'number', url: 'url', tel: 'tel', email: 'email' };
  return `<input name="${f.name}" type="${map[f.type] || 'text'}"${req}${ph} value="${has ? esc(cur) : ''}">`;
}

/** Full value for the detail page — every field, not just the listed ones. */
function detailValue(m, f, row) {
  const v = row[f.name];
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  if (f.type === 'money') return money(v || 0);
  if (f.type === 'file') return `<a href="/uploads/${esc(v)}" target="_blank">open file</a>`;
  if (f.type === 'url') return `<a href="${esc(v)}" target="_blank">${esc(String(v).replace(/^https?:\/\//, ''))}</a>`;
  if (f.type === 'tel') return `<a href="tel:${esc(v)}">${esc(v)}</a>`;
  if (f.type === 'email') return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if (f.type === 'select' && typeof f.options === 'function') {
    const opt = resolveOptions(f).find((o) => String(o.value) === String(v));
    return opt ? esc(opt.label) : '<span class="muted">—</span>';
  }
  if (f.name === m.dateField && f.type === 'date') return `${esc(v)} ${expiryBadge(daysUntil(v))}`;
  if (f.type === 'textarea') return `<div class="detail-long">${esc(v)}</div>`;
  return esc(v);
}

/** The field that names an entry — used for links and page titles. */
const titleField = (m) => m.fields.find((f) => f.list) || m.fields[0];
const rowTitle = (m, row) => String(row[titleField(m).name] || `#${row.id}`);

function equipmentState(row) {
  const days = daysUntil(row.warranty_expires);
  if (days === null) return { key: 'unknown', label: 'Warranty not recorded', sub: 'Add a date to track coverage.', cls: 'empty' };
  if (days < 0) return { key: 'expired', label: `Expired ${-days}d ago`, sub: 'Warranty has run out.', cls: 'review' };
  if (days <= 14) return { key: 'soon', label: `${days}d left`, sub: 'Warranty ends soon.', cls: 'review' };
  if (days <= 45) return { key: 'watch', label: `${days}d left`, sub: 'Coming up next.', cls: 'ready' };
  return { key: 'covered', label: `${days}d left`, sub: 'Coverage still active.', cls: 'sent' };
}

function equipmentField(row, name) {
  return row[name] ? esc(row[name]) : '<span class="unset">—</span>';
}

function renderEquipmentList(m, req, rows) {
  const urgent = rows.filter((r) => {
    const days = daysUntil(r.warranty_expires);
    return days !== null && days <= 30;
  }).length;
  const withContact = rows.filter((r) => r.service_contact || r.phone).length;
  const located = rows.filter((r) => r.location).length;
  const searchBar = rows.length > 6
    ? `<div class="toolbar2">
        <label class="bs-isearch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
          <input type="search" id="eq-search" placeholder="Search equipment, model, serial, contact…" oninput="eqFilter()">
        </label>
        <span class="toolbar2-meta" id="eq-count">${rows.length} item${rows.length === 1 ? '' : 's'}</span>
      </div>`
    : '';
  const stripCell = (label, value, sub, tone = '') => `<div class="bs-strip-c">
    <span class="bs-strip-l">${label}</span>
    <span class="bs-stat${tone ? ' ' + tone : ''}">${value}</span>
    <span class="bs-strip-s">${sub}</span>
  </div>`;
  const body = rows.map((row) => {
    const st = equipmentState(row);
    const meta = [row.model, row.location].filter(Boolean).join(' · ');
    const contact = row.service_contact || row.phone || 'No contact yet';
    const serial = row.serial || 'No serial';
    return `<a class="bs-lr eq-row" href="/c/${m.slug}/${row.id}" data-eq-search="${esc(
      [row.name, row.model, row.serial, row.location, row.service_contact, row.phone].filter(Boolean).join(' ').toLowerCase())}">
      <span class="eq-row-main">
        <span class="bs-lr-d">Equipment</span>
        <span class="bs-lr-s">${esc(row.name || `#${row.id}`)}</span>
        <span class="eq-row-meta">${meta ? esc(meta) : 'Model or location not recorded yet.'}</span>
      </span>
      <span class="eq-row-facts">
        <span class="eq-row-pill ${st.cls}">${esc(st.label)}</span>
        <span class="eq-row-pair"><i>Service</i><b>${esc(contact)}</b></span>
        <span class="eq-row-pair"><i>Serial</i><b>${esc(serial)}</b></span>
      </span>
      <span class="bs-lr-go">Open ›</span>
    </a>`;
  }).join('');
  const isMultipart = m.fields.some((f) => f.type === 'file');
  const formFields = m.fields.filter((f) => f.type !== 'pages')
    .map((f) => `<label>${esc(f.label)} ${renderInput(f)}</label>`).join('');

  return layout(m.title, `
    ${flash(req)}
    <div class="bs-page eq-page">
      <a class="bs-back" href="/">← Dashboard</a>
      <div class="phead">
        <div class="phead-t">
          <div class="bs-kicker">Restaurant · Equipment</div>
          <h1>Equipment</h1>
          <p class="phead-s">Every machine, its warranty window, and who to call when it stops helping service.</p>
        </div>
        ${canWrite() ? `<div class="phead-acts"><a class="bs-btn" href="#eq-add">Add equipment</a></div>` : ''}
      </div>

      <section class="bs-panel bs-strip eq-strip">
        ${stripCell('Equipment', String(rows.length), rows.length === 1 ? '1 item on file' : 'tracked across the restaurant')}
        ${stripCell('Needs attention', String(urgent), urgent ? 'warranty expires within 30 days' : 'nothing due in the next 30 days', urgent ? 'warn' : '')}
        ${stripCell('Service contact', String(withContact), withContact ? 'someone to call is saved' : 'none recorded yet')}
        ${stripCell('Located', String(located), located ? 'items have a room or station' : 'locations still missing')}
      </section>

      <section class="bs-panel">
        <div class="bs-sec-h info"><span class="bs-kicker">On File</span><a class="bs-act" href="/c/expirations">See expirations →</a></div>
        <p class="bs-inline-note">Keep the numbers you need when something breaks close at hand: model, serial, warranty date, and the service contact.</p>
        ${searchBar}
        ${rows.length
          ? `<div class="bs-lrows" id="eq-list">${body}</div>`
          : `<div class="empty2 eq-empty"><div class="empty2-t">No equipment on file yet</div><div class="empty2-s">Start with the machines that stop service when they go down — the walk-in, espresso machine, ice machine, or dishwasher.</div></div>`}
      </section>

      ${!canWrite() ? '' : `
      <details class="bs-panel eq-add" id="eq-add-panel"${rows.length ? '' : ' open'}>
        <summary id="eq-add"><span class="bs-kicker">Add Equipment</span><b>Record a machine</b><i>Model, serial, warranty, service contact.</i></summary>
        <form method="post" action="/c/${m.slug}" class="card form grid eq-form"${isMultipart ? ' enctype="multipart/form-data"' : ''}>
          ${formFields}
          <button class="bs-btn" type="submit">Save equipment</button>
        </form>
      </details>`}
    </div>
    <script>
      function eqFilter(){
        var q=(document.getElementById('eq-search')||{}).value||'';
        q=q.toLowerCase().trim();
        var n=0;
        document.querySelectorAll('#eq-list .eq-row').forEach(function(r){
          var hay=(r.getAttribute('data-eq-search')||'');
          var show=!q || hay.indexOf(q)!==-1;
          r.style.display=show?'':'none';
          if(show) n++;
        });
        var c=document.getElementById('eq-count');
        if(c) c.textContent=n+' item'+(n===1?'':'s');
      }
    </script>`);
}

function renderEquipmentDetail(m, req, row) {
  const st = equipmentState(row);
  const nice = (label, value) => `<div class="eq-fact"><span>${label}</span><b>${value}</b></div>`;
  const note = row.notes
    ? `<section class="bs-panel"><div class="bs-sec-h"><span class="bs-kicker">Service Notes</span></div><div class="detail-long eq-notes">${esc(row.notes)}</div></section>`
    : '';
  return layout(rowTitle(m, row), `
    ${flash(req)}
    <div class="bs-page eq-page eq-detail">
      <a class="bs-back" href="/c/${m.slug}">← Equipment</a>
      <div class="phead">
        <div class="phead-t">
          <div class="bs-kicker">Equipment Record</div>
          <h1>${esc(rowTitle(m, row))}</h1>
          <p class="phead-s">${esc(st.sub)} ${row.location ? 'Located in ' + esc(row.location) + '.' : 'Location not recorded yet.'}</p>
        </div>
        ${m.appendOnly || !canWrite() ? '' : `<div class="phead-acts"><a class="bs-btn" href="/c/${m.slug}/${row.id}/edit">Edit</a></div>`}
      </div>

      <section class="bs-panel bs-strip eq-strip">
        <div class="bs-strip-c"><span class="bs-strip-l">Warranty</span><span class="bs-stat ${st.cls === 'review' ? 'warn' : ''}">${esc(st.label)}</span><span class="bs-strip-s">${esc(st.sub)}</span></div>
        <div class="bs-strip-c"><span class="bs-strip-l">Contact</span><span class="bs-stat eq-mini">${row.service_contact ? esc(row.service_contact) : '—'}</span><span class="bs-strip-s">${row.phone ? esc(row.phone) : 'phone not recorded'}</span></div>
        <div class="bs-strip-c"><span class="bs-strip-l">Model</span><span class="bs-stat eq-mini">${row.model ? esc(row.model) : '—'}</span><span class="bs-strip-s">${row.serial ? 'Serial on file' : 'serial not recorded'}</span></div>
      </section>

      <section class="bs-panel">
        <div class="bs-sec-h"><span class="bs-kicker">At A Glance</span></div>
        <div class="eq-facts">
          ${nice('Model', equipmentField(row, 'model'))}
          ${nice('Serial #', equipmentField(row, 'serial'))}
          ${nice('Location', equipmentField(row, 'location'))}
          ${nice('Warranty expires', row.warranty_expires ? `${esc(row.warranty_expires)} ${expiryBadge(daysUntil(row.warranty_expires))}` : '<i class="unset">—</i>')}
          ${nice('Service contact', equipmentField(row, 'service_contact'))}
          ${nice('Phone', detailValue(m, m.fields.find((f) => f.name === 'phone') || { type: 'text' }, row))}
        </div>
      </section>

      ${note}

      ${m.appendOnly || !canWrite() ? '' : `
      <div class="danger-zone">
        <div><b>Delete this record</b><p class="muted">Remove it permanently if this machine was added by mistake.</p></div>
        <form method="post" action="/c/${m.slug}/${row.id}/delete" onsubmit="return confirm('Delete ${esc(rowTitle(m, row)).replace(/'/g, "\\'")}?')" style="margin:0">
          <button class="btn btn-danger" type="submit">Delete</button>
        </form>
      </div>`}
    </div>`);
}

function renderEquipmentEdit(m, req, row) {
  const isMultipart = m.fields.some((f) => f.type === 'file');
  return layout(`Edit ${rowTitle(m, row)}`, `
    ${flash(req)}
    <div class="bs-page eq-page eq-detail">
      <a class="bs-back" href="/c/${m.slug}/${row.id}">← ${esc(rowTitle(m, row))}</a>
      <div class="phead">
        <div class="phead-t">
          <div class="bs-kicker">Equipment Record</div>
          <h1>Edit ${esc(rowTitle(m, row))}</h1>
          <p class="phead-s">Keep the service details current so the next breakdown is one phone call, not a hunt.</p>
        </div>
      </div>
      <section class="bs-panel">
        <div class="bs-sec-h"><span class="bs-kicker">Update Details</span></div>
        <form method="post" action="/c/${m.slug}/${row.id}" class="card form grid eq-form"${isMultipart ? ' enctype="multipart/form-data"' : ''}>
          ${m.fields.filter((f) => f.type !== 'pages').map((f) => `<label>${esc(f.label)} ${renderInput(f, row)}</label>`).join('')}
          <div class="eq-form-actions">
            <button class="bs-btn" type="submit">Save changes</button>
            <a class="bs-btn-quiet" href="/c/${m.slug}/${row.id}">Cancel</a>
          </div>
        </form>
      </section>
    </div>`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function mountModules(app) {
  app.use('/uploads', require('express').static(UPLOAD_DIR));

  app.get('/c/:slug', (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
    const rows = db.prepare(`SELECT * FROM ${m.table} ORDER BY ${m.orderBy}`).all();
    if (m.slug === 'equipment') return res.send(renderEquipmentList(m, req, rows));
    const listFields = m.fields.filter((f) => f.list);

    const head = listFields.map((f) => `<th${['money'].includes(f.type) ? ' class="num"' : ''}>${esc(f.label)}</th>`).join('')
      + (m.flag ? '<th>Status</th>' : '');
    const body = rows.map((row) => {
      const flag = m.flag ? m.flag(row) : null;
      const dueWarn = m.dateField && daysUntil(row[m.dateField]) !== null && daysUntil(row[m.dateField]) <= 30;
      const cls = dueWarn || (flag && flag.warn) ? ' class="row-warn"' : '';
      // The first cell opens the entry — that's where everything you typed
      // lives, including the fields too wide to fit in the list.
      const cells = listFields.map((f, i) => {
        const inner = cellValue(m, f, row);
        return `<td${f.type === 'money' ? ' class="num"' : ''}>${i === 0 ? `<a class="row-open" href="/c/${m.slug}/${row.id}">${inner}</a>` : inner}</td>`;
      }).join('');
      const statusCell = m.flag ? `<td>${flag ? `<span class="pill ${flag.cls}">${flag.text}</span>` : '<span class="muted">—</span>'}</td>` : '';
      const view = `<a href="/c/${m.slug}/${row.id}">${m.appendOnly ? 'view' : 'open'}</a>`;
      const actions = view + (m.rowActions ? m.rowActions(row, m) : '');
      return `<tr${cls}>${cells}${statusCell}<td class="row-actions">${actions}</td></tr>`;
    }).join('');
    const emptyCols = listFields.length + (m.flag ? 1 : 0) + 1;

    const isMultipart = m.fields.some((f) => f.type === 'file');
    const formFields = m.fields.filter((f) => f.type !== 'pages')
      .map((f) => `<label>${esc(f.label)} ${renderInput(f)}</label>`).join('');

    const vendorHint = m.slug === 'vendors'
      ? '<p class="muted">Tip: don\'t paste real passwords here — store the username and note where the password lives (your password manager). This file isn\'t encrypted.</p>'
      : '';
    const appendHint = m.appendOnly ? '<p class="muted">Append-only: entries can\'t be edited or deleted, so the log stays trustworthy if it\'s ever needed.</p>' : '';

    const searchBar = rows.length > 6
      ? `<div class="toolbar"><div class="search"><input type="search" id="mod-search" placeholder="Search ${esc(m.title.toLowerCase())}…" oninput="modFilter()"></div><span class="sub" id="mod-count">${rows.length} items</span></div>`
      : '';
    const tableOrEmpty = rows.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr>${head}<th></th></tr></thead>
          <tbody id="mod-body">${body}</tbody>
        </table></div>
        <p class="sub" id="mod-count-b" style="margin-top:8px">${rows.length} total</p>`
      : `<div class="empty"><div class="empty-ico">${m.icon}</div><div class="empty-t">No ${esc(m.title.toLowerCase())} yet</div><div class="empty-s">Add your first one with the form below.</div></div>`;

    res.send(layout(m.title, `
      ${flash(req)}
      <a class="back" href="/">← Dashboard</a>
      <div class="page-head">
        <div><h1>${m.icon} ${esc(m.title)}</h1><p class="sub">${esc(m.blurb)}</p></div>
        ${canWrite() ? `<a class="btn btn-primary" href="#add" onclick="document.getElementById('add-panel').open=true">＋ Add</a>` : ''}
      </div>
      ${vendorHint}${appendHint}
      ${searchBar}
      ${tableOrEmpty}
      ${!canWrite() ? '' : `
      <details class="add-panel" id="add-panel"${rows.length ? '' : ' open'}>
        <summary id="add">＋ Add ${esc(m.title.toLowerCase().replace(/s$/, '')) || 'entry'}</summary>
        <form method="post" action="/c/${m.slug}" class="card form grid"${isMultipart ? ' enctype="multipart/form-data"' : ''}>
          ${formFields}
          <button class="btn btn-primary" type="submit">Save</button>
        </form>
      </details>`}
      <script>function modFilter(){var q=(document.getElementById('mod-search').value||'').toLowerCase(),n=0;document.querySelectorAll('#mod-body tr').forEach(function(r){var show=r.textContent.toLowerCase().indexOf(q)!==-1;r.style.display=show?'':'none';if(show)n++;});var c=document.getElementById('mod-count');if(c)c.textContent=n+' items';}</script>`));
  });

  app.post('/c/:slug', upload.any(), (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m) return res.status(404).end();
    const data = {};
    for (const f of m.fields) {
      if (f.type === 'pages') {
        // Only when there is more than one. A single-page upload leaves the row
        // exactly as it would have been before any of this existed — `file`
        // and nothing else — so one page has one representation, not two.
        const all = (req.files || []).filter((x) => x.fieldname === f.pagesOf && x.filename);
        data[f.name] = all.length > 1 ? JSON.stringify(all.map((x) => x.filename)) : null;
      } else if (f.type === 'file') {
        // The first page stays in `file`, which is what the rest of the app
        // reads. Every page is kept by the `pages` field beside it.
        const file = (req.files || []).find((x) => x.fieldname === f.name);
        data[f.name] = file ? file.filename : null;
      } else if (f.type === 'money') {
        data[f.name] = toCents(req.body[f.name]);
      } else if (f.type === 'number') {
        data[f.name] = req.body[f.name] === '' ? null : Number(req.body[f.name]);
      } else if (f.type === 'date') {
        // A required date left blank falls back to today — the day it was
        // recorded. `required` is only an HTML hint; nothing enforced it on the
        // server, so an entry could save with no date and then drop out of a
        // date-keyed list. An expense marked paid on the company card, whose
        // receipt scan missed the date, was exactly this: saved, but nowhere in
        // history. Now every entry lands with a date and has a place to show.
        data[f.name] = (req.body[f.name] || '').trim() || (f.required ? isoDate(startOfToday()) : null);
      } else {
        data[f.name] = (req.body[f.name] || '').trim() || null;
      }
    }
    const cols = m.fields.map((f) => f.name);
    const info = db.prepare(`INSERT INTO ${m.table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(data);
    // A module can ask to be told the moment one of its rows is created — the
    // incident log uses it to notify the back office. Best effort: a hook that
    // throws must never fail the save that has already happened.
    if (typeof m.onCreate === 'function') {
      try { m.onCreate({ id: info.lastInsertRowid, ...data }); } catch { /* the row is saved regardless */ }
    }
    res.redirect(`/c/${m.slug}?msg=` + encodeURIComponent('Saved.'));
  });

  // Everything you entered for one entry — including the fields the list is
  // too narrow to show, which is where most of the useful detail lives.
  app.get('/c/:slug/:id', (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
    const row = db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send(layout('Not found', `<h1>That ${esc(m.title.toLowerCase())} entry no longer exists</h1><a class="btn" href="/c/${m.slug}">← Back</a>`));
    if (m.slug === 'equipment') return res.send(renderEquipmentDetail(m, req, row));

    const rows = m.fields.map((f) => `
      <div class="detail-row"><div class="detail-k">${esc(f.label)}</div><div class="detail-v">${detailValue(m, f, row)}</div></div>`).join('');
    const flag = m.flag ? m.flag(row) : null;

    res.send(layout(rowTitle(m, row), `
      ${flash(req)}
      <a class="back" href="/c/${m.slug}">← ${esc(m.title)}</a>
      <div class="page-head">
        <div><h1>${esc(rowTitle(m, row))}</h1>
          <p class="sub">${flag ? `<span class="pill ${flag.cls}">${flag.text}</span> · ` : ''}Added ${esc(String(row.created_at || '').slice(0, 10))}</p></div>
        ${m.appendOnly || !canWrite() ? '' : `<a class="btn btn-primary" href="/c/${m.slug}/${row.id}/edit">Edit</a>`}
      </div>
      ${m.appendOnly ? '<p class="muted">This log is append-only, so entries can\'t be changed after the fact.</p>' : ''}
      <div class="card detail">${rows}</div>
      ${m.appendOnly || !canWrite() ? '' : `
        <div class="danger-zone">
          <div><b>Delete this entry</b><p class="muted">Removes it permanently. This can't be undone.</p></div>
          <form method="post" action="/c/${m.slug}/${row.id}/delete" onsubmit="return confirm('Delete ${esc(rowTitle(m, row)).replace(/'/g, "\\'")}?')" style="margin:0">
            <button class="btn btn-danger" type="submit">Delete</button>
          </form>
        </div>`}
    `));
  });

  app.get('/c/:slug/:id/edit', (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m || m.appendOnly) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
    const row = db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
    if (m.slug === 'equipment') return res.send(renderEquipmentEdit(m, req, row));
    const isMultipart = m.fields.some((f) => f.type === 'file');

    res.send(layout(`Edit ${rowTitle(m, row)}`, `
      ${flash(req)}
      <a class="back" href="/c/${m.slug}/${row.id}">← ${esc(rowTitle(m, row))}</a>
      <h1>Edit ${esc(rowTitle(m, row))}</h1>
      <form method="post" action="/c/${m.slug}/${row.id}" class="card form grid"${isMultipart ? ' enctype="multipart/form-data"' : ''}>
        ${m.fields.filter((f) => f.type !== 'pages').map((f) => `<label>${esc(f.label)} ${renderInput(f, row)}</label>`).join('')}
        <button class="btn btn-primary" type="submit">Save changes</button>
      </form>
      <p class="muted"><a href="/c/${m.slug}/${row.id}">Cancel</a></p>
    `));
  });

  app.post('/c/:slug/:id', upload.any(), (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m || m.appendOnly) return res.status(404).end();
    const row = db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).end();

    const data = { id: row.id };
    for (const f of m.fields) {
      if (f.type === 'pages') {
        // Replacing a five-page scan with one photo has to clear the other
        // four, or the row keeps pointing at pages of a document it no longer
        // holds. Uploading nothing at all keeps what is there.
        const all = (req.files || []).filter((x) => x.fieldname === f.pagesOf && x.filename);
        data[f.name] = all.length ? (all.length > 1 ? JSON.stringify(all.map((x) => x.filename)) : null)
          : row[f.name];
      } else if (f.type === 'file') {
        const file = (req.files || []).find((x) => x.fieldname === f.name && x.filename);
        // No new upload means keep the existing attachment, not clear it.
        data[f.name] = file ? file.filename : row[f.name];
      } else if (f.type === 'money') {
        data[f.name] = toCents(req.body[f.name]);
      } else if (f.type === 'number') {
        data[f.name] = req.body[f.name] === '' ? null : Number(req.body[f.name]);
      } else {
        data[f.name] = (req.body[f.name] || '').trim() || null;
      }
    }
    const sets = m.fields.map((f) => `${f.name} = @${f.name}`).join(', ');
    db.prepare(`UPDATE ${m.table} SET ${sets} WHERE id = @id`).run(data);
    res.redirect(`/c/${m.slug}/${row.id}?msg=` + encodeURIComponent('Saved.'));
  });

  app.post('/c/:slug/:id/delete', (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m || m.appendOnly) return res.status(404).end();
    db.prepare(`DELETE FROM ${m.table} WHERE id = ?`).run(req.params.id);
    res.redirect(`/c/${m.slug}?msg=` + encodeURIComponent('Deleted.'));
  });

  // Recurring task: mark done → stamp last_done today, advance next_due by frequency.
  app.post('/c/recurring/:id/done', (req, res) => {
    const row = db.prepare('SELECT * FROM m_recurring WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).end();
    const today = startOfToday();
    const next = new Date(today);
    const f = (row.frequency || '').toLowerCase();
    if (f.includes('week')) next.setDate(next.getDate() + 7);
    else if (f.includes('quarter')) next.setMonth(next.getMonth() + 3);
    else if (f.includes('annual') || f.includes('year')) next.setFullYear(next.getFullYear() + 1);
    else next.setMonth(next.getMonth() + 1); // monthly default
    const iso = (d) => isoDate(d);
    db.prepare('UPDATE m_recurring SET last_done = ?, next_due = ? WHERE id = ?').run(iso(today), iso(next), row.id);
    res.redirect('/c/recurring?msg=' + encodeURIComponent('Done ✓ — next due ' + iso(next) + '.'));
  });
}

/** Used by the dashboard banner: anything expiring within 60 days (or expired). */
function expiringSoon() {
  const out = [];
  for (const m of MODULES) {
    if (!m.dateField) continue;
    for (const row of db.prepare(`SELECT * FROM ${m.table}`).all()) {
      const days = daysUntil(row[m.dateField]);
      if (days !== null && days <= 60) out.push({ name: row.name, days });
    }
  }
  return out.sort((a, b) => a.days - b.days).slice(0, 6);
}

module.exports = { mountModules, MODULES, expiringSoon, pagesOf };
