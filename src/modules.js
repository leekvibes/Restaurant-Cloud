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
        options: ['Food', 'Coffee', 'Beverage', 'Alcohol', 'Supplies', 'Repairs', 'Services', 'Other'] },
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
        options: ['Payroll', 'Tax', 'Lease', 'Insurance', 'HR', 'Permit', 'Other'] },
      { name: 'file', label: 'File', type: 'file', required: true, list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
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
    const current = has
      ? `<span class="file-current">Attached: <a href="/uploads/${esc(cur)}" target="_blank">open</a> — choosing a file replaces it</span>`
      : '';
    return `<input type="file" name="${f.name}"${need}>${current}`;
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function mountModules(app) {
  app.use('/uploads', require('express').static(UPLOAD_DIR));

  app.get('/c/:slug', (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
    const rows = db.prepare(`SELECT * FROM ${m.table} ORDER BY ${m.orderBy}`).all();
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
    const formFields = m.fields.map((f) => `<label>${esc(f.label)} ${renderInput(f)}</label>`).join('');

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
      if (f.type === 'file') {
        const file = (req.files || []).find((x) => x.fieldname === f.name);
        data[f.name] = file ? file.filename : null;
      } else if (f.type === 'money') {
        data[f.name] = toCents(req.body[f.name]);
      } else if (f.type === 'number') {
        data[f.name] = req.body[f.name] === '' ? null : Number(req.body[f.name]);
      } else {
        data[f.name] = (req.body[f.name] || '').trim() || null;
      }
    }
    const cols = m.fields.map((f) => f.name);
    db.prepare(`INSERT INTO ${m.table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(data);
    res.redirect(`/c/${m.slug}?msg=` + encodeURIComponent('Saved.'));
  });

  // Everything you entered for one entry — including the fields the list is
  // too narrow to show, which is where most of the useful detail lives.
  app.get('/c/:slug/:id', (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m) return res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
    const row = db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send(layout('Not found', `<h1>That ${esc(m.title.toLowerCase())} entry no longer exists</h1><a class="btn" href="/c/${m.slug}">← Back</a>`));

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
    const isMultipart = m.fields.some((f) => f.type === 'file');

    res.send(layout(`Edit ${rowTitle(m, row)}`, `
      ${flash(req)}
      <a class="back" href="/c/${m.slug}/${row.id}">← ${esc(rowTitle(m, row))}</a>
      <h1>Edit ${esc(rowTitle(m, row))}</h1>
      <form method="post" action="/c/${m.slug}/${row.id}" class="card form grid"${isMultipart ? ' enctype="multipart/form-data"' : ''}>
        ${m.fields.map((f) => `<label>${esc(f.label)} ${renderInput(f, row)}</label>`).join('')}
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
      if (f.type === 'file') {
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

module.exports = { mountModules, MODULES, expiringSoon };
