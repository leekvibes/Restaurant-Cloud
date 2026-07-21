'use strict';

// ---------------------------------------------------------------------------
// GLOBAL SEARCH.
//
// This is the one feature that reads from everything by design, which makes it
// the obvious way to leak. Every source names the area it belongs to, and the
// caller drops the sources the signed-in account may not open BEFORE any query
// runs — a viewer without payroll access typing a name must not get payroll
// rows back, and must not get them back and have them hidden in the browser
// either. Areas come from nav.js, so search and the sidebar agree by
// construction.
//
// Plain LIKE, no index. At this size a scan is a millisecond and a search
// index is a second copy of the data to keep true. If it ever gets slow the
// answer is SQLite FTS5, not caching.
// ---------------------------------------------------------------------------

const { db } = require('./db');

/** LIKE treats % and _ as wildcards, so a query containing them would match
 *  far more than it looks like it should. */
const like = (q) => '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';

const has = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

/** Money for a result subtitle, without pulling in the whole view layer. */
const cash = (cents) => (cents == null ? '' : '$' + (Math.round(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Each source: what it is, who may see it, and how to find things in it.
// `sql` takes one bound parameter (the LIKE pattern) and a limit.
const SOURCES = [
  {
    key: 'product', label: 'Product', area: 'trackers', icon: 'par',
    run: (p, n) => db.prepare(`SELECT pr.id, pr.name, pr.brand, pr.pack_size, pr.unit, v.name AS vendor
      FROM products pr LEFT JOIN m_vendors v ON v.id = pr.vendor_id
      WHERE pr.name LIKE ? ESCAPE '\\' OR pr.brand LIKE ? ESCAPE '\\' OR pr.sku LIKE ? ESCAPE '\\'
         OR pr.category LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\'
      ORDER BY pr.name COLLATE NOCASE LIMIT ?`).all(p, p, p, p, p, n)
      .map((r) => ({ title: r.name, sub: [r.brand, r.vendor, r.pack_size || r.unit].filter(Boolean).join(' · '), href: `/c/products/${r.id}` })),
  },
  {
    key: 'menu', label: 'Menu item', area: 'menu', icon: 'costs',
    run: (p, n) => db.prepare(`SELECT id, name, category, status, selling_price_cents FROM menu_items
      WHERE name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'
      ORDER BY name COLLATE NOCASE LIMIT ?`).all(p, p, n)
      .map((r) => ({ title: r.name, sub: [r.category, r.status !== 'active' ? r.status : '', cash(r.selling_price_cents)].filter(Boolean).join(' · '), href: `/menu/${r.id}` })),
    when: () => has('menu_items'),
  },
  {
    key: 'vendor', label: 'Vendor', area: 'trackers', icon: 'vendors',
    run: (p, n) => db.prepare(`SELECT id, name, category, rep_name, phone FROM m_vendors
      WHERE name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR rep_name LIKE ? ESCAPE '\\'
         OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
      ORDER BY name COLLATE NOCASE LIMIT ?`).all(p, p, p, p, p, n)
      .map((r) => ({ title: r.name, sub: [r.category, r.rep_name, r.phone].filter(Boolean).join(' · '), href: `/c/vendors/${r.id}` })),
  },
  {
    key: 'invoice', label: 'Invoice', area: 'trackers', icon: 'invoices',
    // vendor_id is TEXT and has held "1" and "1.0", so compare as numbers.
    run: (p, n) => db.prepare(`SELECT i.id, i.invoice_number, i.invoice_date, i.amount_cents, i.status, v.name AS vendor
      FROM m_invoices i LEFT JOIN m_vendors v ON CAST(v.id AS REAL) = CAST(i.vendor_id AS REAL)
      WHERE i.invoice_number LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR i.notes LIKE ? ESCAPE '\\'
      ORDER BY i.invoice_date DESC, i.id DESC LIMIT ?`).all(p, p, p, n)
      .map((r) => ({ title: r.invoice_number ? `Invoice ${r.invoice_number}` : `Invoice #${r.id}`,
        sub: [r.vendor, r.invoice_date, cash(r.amount_cents), r.status].filter(Boolean).join(' · '), href: '/c/invoices' })),
  },
  {
    key: 'shift', label: 'Shift', area: 'shifts', icon: 'shifts',
    run: (p, n) => db.prepare(`SELECT id, date, daypart, status FROM shifts
      WHERE date LIKE ? ESCAPE '\\' OR daypart LIKE ? ESCAPE '\\'
      ORDER BY date DESC LIMIT ?`).all(p, p, n)
      .map((r) => ({ title: `${r.date} · ${r.daypart === 'cafe' ? 'Café' : 'Dinner'}`,
        sub: r.status === 'emailed' ? 'sent' : 'open', href: `/shifts/${r.id}` })),
  },
  {
    key: 'staff', label: 'Staff', area: 'staff', icon: 'staff',
    run: (p, n) => db.prepare(`SELECT id, name, role, email, active FROM employees
      WHERE name LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
      ORDER BY name COLLATE NOCASE LIMIT ?`).all(p, p, p, n)
      .map((r) => ({ title: r.name, sub: [r.role, r.active ? '' : 'inactive'].filter(Boolean).join(' · '), href: '/employees' })),
  },
  {
    key: 'user', label: 'User', area: 'settings', icon: 'users',
    run: (p, n) => db.prepare(`SELECT id, name, email, role FROM users
      WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
      ORDER BY name COLLATE NOCASE LIMIT ?`).all(p, p, n)
      .map((r) => ({ title: r.name, sub: [r.email, r.role === 'viewer' ? 'view only' : 'editor'].filter(Boolean).join(' · '), href: '/users' })),
  },
  {
    key: 'task', label: 'Recurring task', area: 'trackers', icon: 'recurring',
    run: (p, n) => db.prepare(`SELECT id, name, next_due, responsible FROM m_recurring
      WHERE name LIKE ? ESCAPE '\\' OR responsible LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'
      ORDER BY next_due LIMIT ?`).all(p, p, p, n)
      .map((r) => ({ title: r.name, sub: [r.responsible, r.next_due ? `due ${r.next_due}` : ''].filter(Boolean).join(' · '), href: '/c/recurring' })),
  },
  {
    key: 'expiration', label: 'Expiration', area: 'trackers', icon: 'expirations',
    run: (p, n) => db.prepare(`SELECT id, name, expires_on FROM m_expirations
      WHERE name LIKE ? ESCAPE '\\' ORDER BY expires_on LIMIT ?`).all(p, n)
      .map((r) => ({ title: r.name, sub: r.expires_on ? `expires ${r.expires_on}` : '', href: `/c/expirations/${r.id}` })),
  },
  {
    key: 'document', label: 'Document', area: 'trackers', icon: 'documents',
    run: (p, n) => db.prepare(`SELECT id, name, notes FROM m_documents
      WHERE name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT ?`).all(p, p, n)
      .map((r) => ({ title: r.name, sub: r.notes || '', href: `/c/documents/${r.id}` })),
  },
  {
    key: 'contact', label: 'Contact', area: 'trackers', icon: 'contacts',
    run: (p, n) => db.prepare(`SELECT id, name, role, phone, email FROM m_contacts
      WHERE name LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
      ORDER BY name COLLATE NOCASE LIMIT ?`).all(p, p, p, p, n)
      .map((r) => ({ title: r.name, sub: [r.role, r.phone].filter(Boolean).join(' · '), href: `/c/contacts/${r.id}` })),
  },
  {
    key: 'equipment', label: 'Equipment', area: 'trackers', icon: 'equipment',
    run: (p, n) => db.prepare(`SELECT id, name, location FROM m_equipment
      WHERE name LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT ?`).all(p, p, n)
      .map((r) => ({ title: r.name, sub: r.location || '', href: `/c/equipment/${r.id}` })),
  },
  {
    key: 'incident', label: 'Incident', area: 'trackers', icon: 'incidents',
    run: (p, n) => db.prepare(`SELECT id, type, occurred_at, description FROM m_incidents
      WHERE type LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR people LIKE ? ESCAPE '\\'
      ORDER BY occurred_at DESC LIMIT ?`).all(p, p, p, n)
      .map((r) => ({ title: r.type || 'Incident', sub: [r.occurred_at, r.description].filter(Boolean).join(' · ').slice(0, 90), href: '/c/incidents' })),
  },
  {
    key: 'decision', label: 'Decision', area: 'trackers', icon: 'notes',
    run: (p, n) => db.prepare(`SELECT id, title, note_date FROM m_notes
      WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' ORDER BY note_date DESC LIMIT ?`).all(p, p, n)
      .map((r) => ({ title: r.title, sub: r.note_date || '', href: `/c/notes/${r.id}` })),
  },
];

/**
 * Search everything this account may open.
 *
 * @param q      what was typed
 * @param allow  (areaKey) => boolean — the caller's permission check
 * @param opts   {perSource, total}
 * @returns {{groups: Array, total: number, truncated: boolean}}
 */
function search(q, allow, opts = {}) {
  const term = String(q || '').trim();
  // One or two characters matches most of the database and answers nothing.
  if (term.length < 2) return { groups: [], total: 0, truncated: false };

  const perSource = opts.perSource || 5;
  const total = opts.total || 24;
  const pattern = like(term);
  const groups = [];
  let count = 0, truncated = false;

  for (const s of SOURCES) {
    // The gate runs before the query, not after it. Filtering results in the
    // browser would still have sent them.
    if (typeof allow === 'function' && !allow(s.area)) continue;
    if (s.when && !s.when()) continue;
    let rows;
    try { rows = s.run(pattern, perSource + 1); }
    catch (e) { console.error(`[search] ${s.key} failed:`, e.message); continue; }
    if (!rows.length) continue;
    if (rows.length > perSource) { truncated = true; rows = rows.slice(0, perSource); }
    if (count + rows.length > total) { rows = rows.slice(0, Math.max(0, total - count)); truncated = true; }
    if (!rows.length) continue;
    groups.push({ key: s.key, label: s.label, icon: s.icon, results: rows });
    count += rows.length;
    if (count >= total) { truncated = true; break; }
  }
  return { groups, total: count, truncated };
}

module.exports = { search, SOURCES };
