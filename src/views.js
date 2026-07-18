'use strict';

const { fmt } = require('./money');

// APP_NAME is the product (shown in the app chrome + PWA). RESTAURANT is the
// venue's own name, used to brand staff emails — set RESTAURANT_NAME in .env.
const APP_NAME = 'Restaurant Cloud';
const RESTAURANT = process.env.RESTAURANT_NAME || APP_NAME;

// Grouped navigation — organized instead of one long list.
const NAV_GROUPS = [
  { title: null, links: [['/', '🏠', 'Dashboard'], ['/shifts', '📋', 'Shifts'], ['/costs', '📈', 'Cost %'], ['/cash', '💵', 'Cash count'], ['/payroll', '💰', 'Payroll']] },
  { title: 'Track', links: [
    ['/c/expirations', '⏰', 'Expirations'], ['/c/invoices', '🧾', 'Invoices'], ['/c/vendors', '🚚', 'Vendors'],
    ['/c/par', '📦', 'Par levels'], ['/c/contacts', '📇', 'Contacts'], ['/c/equipment', '🔧', 'Equipment'], ['/c/documents', '📁', 'Documents'],
  ] },
  { title: 'Tasks & logs', links: [['/c/recurring', '🔁', 'Recurring tasks'], ['/c/incidents', '🚨', 'Incident log'], ['/c/notes', '📝', 'Decisions log']] },
  { title: 'Settings', links: [['/employees', '🧑‍🍳', 'Staff'], ['/policy', '⚖️', 'Tip-out policy'], ['/positions', '🎓', 'Positions'], ['/email', '✉️', 'Email'], ['/tips', '💵', 'Cash tips (staff)']] },
];

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const money = (c) => fmt(c);
const dp = (d) => (d === 'cafe' ? 'Café' : 'Dinner');

function sidebar() {
  const groups = NAV_GROUPS.map((g) => `
    ${g.title ? `<div class="side-group">${g.title}</div>` : ''}
    ${g.links.map(([href, ico, label]) => `<a class="side-link" href="${href}"><span class="side-ico">${ico}</span>${label}</a>`).join('')}
  `).join('');
  const signOut = process.env.APP_PASSWORD
    ? '<div class="side-group">Account</div><a class="side-link" href="/logout"><span class="side-ico">🚪</span>Sign out</a>'
    : '';
  return `<aside class="sidebar">
    <a href="/" class="side-brand"><img src="/static/logo.png" alt="" width="28" height="28">${esc(APP_NAME)}</a>
    <nav class="side-nav">${groups}${signOut}</nav>
  </aside>`;
}

/** Loud warning when the app is reachable with no password set. */
const openWarning = () => (process.env.APP_PASSWORD ? '' :
  `<div class="open-warn">⚠️ <b>No password set.</b> Anyone with this link can see payroll and staff data. Set <code>APP_PASSWORD</code> to lock it down.</div>`);

/** Shared <head> bits: fonts, icons, PWA manifest, theme colour. */
function head(title, opts = {}) {
  const staff = !!opts.bare;
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>${esc(title)} · ${esc(staff ? RESTAURANT : APP_NAME)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/styles.css">
    <link rel="manifest" href="${staff ? '/manifest-tips.webmanifest' : '/manifest.webmanifest'}">
    <meta name="theme-color" content="${staff ? '#2563eb' : '#ffffff'}">
    <link rel="icon" href="/static/icon-192.png">
    <link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="${staff ? 'black-translucent' : 'default'}">
    <meta name="apple-mobile-web-app-title" content="${staff ? 'Cash Tips' : 'Restaurant Cloud'}">
    <meta name="mobile-web-app-capable" content="yes">`;
}

const swScript = `<script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}</script>`;

function layout(title, body, opts = {}) {
  if (opts.bare) {
    // No .wrap here — the staff screen owns the full viewport.
    return `<!doctype html><html lang="en"><head>${head(title, opts)}</head>
      <body class="bare">${body}${swScript}</body></html>`;
  }
  return `<!doctype html><html lang="en"><head>${head(title, opts)}</head>
    <body>
      <div class="topbar">
        <button class="menu-btn" onclick="document.body.classList.toggle('nav-open')" aria-label="Menu">☰</button>
        <span class="topbar-brand"><img src="/static/logo.png" alt="" width="22" height="22">${esc(APP_NAME)}</span>
      </div>
      <div class="app">
        ${sidebar()}
        <div class="scrim" onclick="document.body.classList.remove('nav-open')"></div>
        <main class="content">${openWarning()}<div class="wrap">${body}</div></main>
      </div>
      <script>
        // Highlight the active nav link.
        (function () {
          var p = location.pathname;
          document.querySelectorAll('.side-link').forEach(function (a) {
            if (a.getAttribute('href') === p) a.classList.add('active');
          });
        })();
        // Copy each column's heading onto its cells so tables can restack as
        // cards on a phone (see the mobile table rules in styles.css). Doing it
        // here means every table gets it, including ones added later.
        (function () {
          document.querySelectorAll('table.table').forEach(function (t) {
            var heads = [].map.call(t.querySelectorAll('thead th'), function (th) {
              return th.textContent.trim();
            });
            if (!heads.length) return;
            [].forEach.call(t.querySelectorAll('tbody tr, tfoot tr'), function (tr) {
              [].forEach.call(tr.children, function (td, i) {
                // Skip the first cell — it's the card title, not a value.
                if (i > 0 && heads[i]) td.setAttribute('data-label', heads[i]);
              });
            });
          });
        })();
      </script>
      ${swScript}
    </body></html>`;
}

function flash(req) {
  const m = req.query.msg;
  if (!m) return '';
  const err = req.query.err === '1';
  return `<div class="flash ${err ? 'flash-err' : 'flash-ok'}">${esc(m)}</div>`;
}

module.exports = { layout, flash, esc, money, dp, RESTAURANT, APP_NAME };
