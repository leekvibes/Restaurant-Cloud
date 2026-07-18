'use strict';

const { fmt } = require('./money');

const RESTAURANT = process.env.RESTAURANT_NAME || 'Our Restaurant';

// Grouped navigation — organized instead of one long list.
const NAV_GROUPS = [
  { title: null, links: [['/', '🏠', 'Dashboard'], ['/shifts', '📋', 'Shifts'], ['/costs', '📈', 'Cost %'], ['/cash', '💵', 'Cash count'], ['/payroll', '💰', 'Payroll']] },
  { title: 'Track', links: [
    ['/c/expirations', '⏰', 'Expirations'], ['/c/invoices', '🧾', 'Invoices'], ['/c/vendors', '🚚', 'Vendors'],
    ['/c/par', '📦', 'Par levels'], ['/c/contacts', '📇', 'Contacts'], ['/c/equipment', '🔧', 'Equipment'], ['/c/documents', '📁', 'Documents'],
  ] },
  { title: 'Tasks & logs', links: [['/c/recurring', '🔁', 'Recurring tasks'], ['/c/incidents', '🚨', 'Incident log'], ['/c/notes', '📝', 'Decisions log']] },
  { title: 'Settings', links: [['/employees', '🧑‍🍳', 'Staff'], ['/policy', '⚖️', 'Tip-out policy'], ['/tips', '💵', 'Cash tips (staff)']] },
];

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const money = (c) => fmt(c);
const dp = (d) => (d === 'cafe' ? 'Café' : 'Dinner');

function sidebar() {
  const groups = NAV_GROUPS.map((g) => `
    ${g.title ? `<div class="side-group">${g.title}</div>` : ''}
    ${g.links.map(([href, ico, label]) => `<a class="side-link" href="${href}"><span class="side-ico">${ico}</span>${label}</a>`).join('')}
  `).join('');
  return `<aside class="sidebar">
    <a href="/" class="side-brand">${esc(RESTAURANT)}</a>
    <nav class="side-nav">${groups}</nav>
  </aside>`;
}

function layout(title, body, opts = {}) {
  if (opts.bare) {
    return `<!doctype html><html lang="en"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${esc(title)} · ${esc(RESTAURANT)}</title>
      <link rel="stylesheet" href="/static/styles.css"></head>
      <body class="bare"><main class="wrap">${body}</main></body></html>`;
  }
  return `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)} · ${esc(RESTAURANT)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/styles.css"></head>
    <body>
      <div class="topbar">
        <button class="menu-btn" onclick="document.body.classList.toggle('nav-open')" aria-label="Menu">☰</button>
        <span class="topbar-brand">${esc(RESTAURANT)}</span>
      </div>
      <div class="app">
        ${sidebar()}
        <div class="scrim" onclick="document.body.classList.remove('nav-open')"></div>
        <main class="content"><div class="wrap">${body}</div></main>
      </div>
      <script>
        // Highlight the active nav link.
        (function () {
          var p = location.pathname;
          document.querySelectorAll('.side-link').forEach(function (a) {
            if (a.getAttribute('href') === p) a.classList.add('active');
          });
        })();
      </script>
    </body></html>`;
}

function flash(req) {
  const m = req.query.msg;
  if (!m) return '';
  const err = req.query.err === '1';
  return `<div class="flash ${err ? 'flash-err' : 'flash-ok'}">${esc(m)}</div>`;
}

module.exports = { layout, flash, esc, money, dp, RESTAURANT };
