'use strict';

// Config-driven "collections" — each entry below becomes a full section with a
// list page, an add form, file uploads, and (unless append-only) delete. Adding
// a new tracker later is just another object in MODULES; no new plumbing.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db } = require('./db');
const { layout, flash, esc, money } = require('./views');
const { toCents } = require('./money');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
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
      { name: 'vendor_id', label: 'Vendor', type: 'select', list: true, options: vendorOptions },
      { name: 'amount_cents', label: 'Amount', type: 'money', list: true },
      { name: 'category', label: 'Category', type: 'select', list: true,
        options: ['Food', 'Coffee', 'Beverage', 'Alcohol', 'Supplies', 'Repairs', 'Services', 'Other'] },
      { name: 'status', label: 'Status', type: 'select', list: true, options: ['Unpaid', 'Paid'] },
      { name: 'file', label: 'Invoice file (PDF or photo)', type: 'file', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    slug: 'vendors', table: 'm_vendors', title: 'Vendors', icon: '🚚',
    blurb: 'Who you order from, sites & logins',
    orderBy: 'name ASC',
    fields: [
      { name: 'name', label: 'Vendor name', type: 'text', required: true, list: true },
      { name: 'category', label: 'Supplies', type: 'text', list: true, placeholder: 'produce, meat, coffee…' },
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
  {
    slug: 'par', table: 'm_par', title: 'Par levels', icon: '📦',
    blurb: 'What to keep on hand & when to reorder',
    orderBy: 'item ASC',
    // Flag anything at or below its reorder point.
    flag: (row) => (row.on_hand == null || row.reorder_point == null ? null
      : Number(row.on_hand) <= Number(row.reorder_point) ? { text: '⚠ reorder', cls: 'pill-red', warn: true } : { text: 'ok', cls: 'pill-ok' }),
    fields: [
      { name: 'item', label: 'Item', type: 'text', required: true, list: true, placeholder: 'e.g. ribeye, to-go cups' },
      { name: 'vendor_id', label: 'Vendor', type: 'select', list: true, options: vendorOptions },
      { name: 'unit', label: 'Unit', type: 'text', list: true, placeholder: 'case, lb, each' },
      { name: 'par_level', label: 'Par (target)', type: 'number', list: true },
      { name: 'reorder_point', label: 'Reorder at', type: 'number', list: true },
      { name: 'on_hand', label: 'On hand', type: 'number', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    slug: 'recurring', table: 'm_recurring', title: 'Recurring tasks', icon: '🔁',
    blurb: 'Grease trap, hood, pest control, deep cleans',
    orderBy: 'next_due ASC',
    dateField: 'next_due',
    // "mark done" advances the next-due date by the frequency.
    rowActions: (row) => `<form method="post" action="/c/recurring/${row.id}/done" style="margin:0"><button class="link">mark done</button></form>`,
    fields: [
      { name: 'name', label: 'Task', type: 'text', required: true, list: true, placeholder: 'Hood cleaning' },
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

function renderInput(f) {
  const req = f.required ? ' required' : '';
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  if (f.type === 'textarea') return `<textarea name="${f.name}"${req}${ph} rows="2"></textarea>`;
  if (f.type === 'select') {
    const opts = resolveOptions(f).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    return `<select name="${f.name}"${req}><option value="">—</option>${opts}</select>`;
  }
  if (f.type === 'file') return `<input type="file" name="${f.name}"${req}>`;
  if (f.type === 'money') return `<input name="${f.name}" type="number" step="0.01" min="0"${req} placeholder="0.00">`;
  const map = { date: 'date', number: 'number', url: 'url', tel: 'tel', email: 'email' };
  return `<input name="${f.name}" type="${map[f.type] || 'text'}"${req}${ph}>`;
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
    const listFields = m.fields.filter((f) => f.list);

    const head = listFields.map((f) => `<th${['money'].includes(f.type) ? ' class="num"' : ''}>${esc(f.label)}</th>`).join('')
      + (m.flag ? '<th>Status</th>' : '');
    const body = rows.map((row) => {
      const flag = m.flag ? m.flag(row) : null;
      const dueWarn = m.dateField && daysUntil(row[m.dateField]) !== null && daysUntil(row[m.dateField]) <= 30;
      const cls = dueWarn || (flag && flag.warn) ? ' class="row-warn"' : '';
      const cells = listFields.map((f) => `<td${f.type === 'money' ? ' class="num"' : ''}>${cellValue(m, f, row)}</td>`).join('');
      const statusCell = m.flag ? `<td>${flag ? `<span class="pill ${flag.cls}">${flag.text}</span>` : '<span class="muted">—</span>'}</td>` : '';
      const del = m.appendOnly ? '' : `<form method="post" action="/c/${m.slug}/${row.id}/delete" onsubmit="return confirm('Delete this?')" style="margin:0"><button class="link-danger">delete</button></form>`;
      const actions = (m.rowActions ? m.rowActions(row, m) : '') + del;
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
        <a class="btn btn-primary" href="#add">＋ Add</a>
      </div>
      ${vendorHint}${appendHint}
      ${searchBar}
      ${tableOrEmpty}
      <h2 id="add">Add ${esc(m.title.toLowerCase().replace(/s$/, '')) || 'entry'}</h2>
      <form method="post" action="/c/${m.slug}" class="card form grid"${isMultipart ? ' enctype="multipart/form-data"' : ''}>
        ${formFields}
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
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
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const next = new Date(today);
    const f = (row.frequency || '').toLowerCase();
    if (f.includes('week')) next.setDate(next.getDate() + 7);
    else if (f.includes('quarter')) next.setMonth(next.getMonth() + 3);
    else if (f.includes('annual') || f.includes('year')) next.setFullYear(next.getFullYear() + 1);
    else next.setMonth(next.getMonth() + 1); // monthly default
    const iso = (d) => d.toISOString().slice(0, 10);
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
