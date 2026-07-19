'use strict';

const { fmt } = require('./money');

// APP_NAME is the product (shown in the app chrome + PWA). RESTAURANT is the
// venue's own name, used to brand staff emails — set RESTAURANT_NAME in .env.
const APP_NAME = 'Restaurant Cloud';
const RESTAURANT = process.env.RESTAURANT_NAME || APP_NAME;

// Grouped navigation — organized instead of one long list.
// Each item carries its own accent. Colour here is wayfinding, not decoration:
// the rail stays recognisable when collapsed to icons, and the page you're on
// picks up its accent in the header — so Payroll never looks like Sales.
const NAV_GROUPS = [
  { title: null, links: [
    ['/', '🏠', 'Dashboard', '#2563eb'], ['/shifts', '📋', 'Shifts', '#4f46e5'],
    ['/sales', '📈', 'Sales', '#059669'], ['/costs', '🧮', 'Cost %', '#0891b2'],
    ['/cash', '💵', 'Cash count', '#d97706'], ['/payroll', '💰', 'Payroll', '#7c3aed'],
  ] },
  { title: 'Track', links: [
    ['/c/expirations', '⏰', 'Expirations', '#dc2626'], ['/c/invoices', '🧾', 'Invoices', '#0891b2'],
    ['/c/vendors', '🚚', 'Vendors', '#ea580c'], ['/c/par', '📦', 'Par levels', '#ca8a04'],
    ['/c/contacts', '📇', 'Contacts', '#0d9488'], ['/c/equipment', '🔧', 'Equipment', '#64748b'],
    ['/c/documents', '📁', 'Documents', '#6366f1'],
  ] },
  { title: 'Tasks & logs', links: [
    ['/c/recurring', '🔁', 'Recurring tasks', '#059669'], ['/c/incidents', '🚨', 'Incident log', '#dc2626'],
    ['/c/notes', '📝', 'Decisions log', '#7c3aed'],
  ] },
  { title: 'Settings', links: [
    ['/employees', '🧑‍🍳', 'Staff', '#2563eb'], ['/policy', '⚖️', 'Tip-out policy', '#0891b2'],
    ['/positions', '🎓', 'Positions', '#7c3aed'], ['/email', '✉️', 'Email', '#0d9488'],
    ['/tips', '💵', 'Cash tips (staff)', '#059669'],
  ] },
];

/** Accent plus the two tints the active pill needs, from one hex. */
const accentVars = (hex) => `--ac:${hex};--ac-soft:${hex}14;--ac-soft2:${hex}24`;

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const money = (c) => fmt(c);
const dp = (d) => (d === 'cafe' ? 'Café' : 'Dinner');

function sidebar() {
  const groups = NAV_GROUPS.map((g) => `
    ${g.title ? `<div class="side-group">${g.title}</div>` : ''}
    ${g.links.map(([href, ico, label, accent]) => `<a class="side-link" href="${href}" style="${accentVars(accent)}" title="${esc(label)}"><span class="side-ico">${ico}</span><span class="side-label">${label}</span></a>`).join('')}
  `).join('');
  const signOut = process.env.APP_PASSWORD
    ? '<div class="side-group">Account</div><a class="side-link" href="/logout" style="--ac:#64748b;--ac-soft:#64748b14;--ac-soft2:#64748b24"><span class="side-ico">🚪</span><span class="side-label">Sign out</span></a>'
    : '';
  return `<aside class="sidebar">
    <div class="side-top">
      <a href="/" class="side-brand" title="${esc(APP_NAME)}"><img src="/static/logo.png" alt="" width="30" height="30"><span>${esc(APP_NAME)}</span></a>
      <button class="side-pin" type="button" onclick="rcPin()" aria-label="Pin the menu open" title="Pin the menu open">⇥</button>
    </div>
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
    <meta name="mobile-web-app-capable" content="yes">
    <script>
      // Runs before first paint so a pinned sidebar never flashes collapsed.
      try { if (localStorage.getItem('rc_side') === 'pinned') document.documentElement.classList.add('side-pinned'); } catch (e) {}
    </script>`;
}

const swScript = `<script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}</script>`;

// A build stamp that changes whenever the code does. Staff keep the tips page
// on a home screen for months, so a copy can outlive a change to the form and
// post fields the server no longer understands — which is exactly how one
// staff member ended up stuck on "session timed out". The page checks this and
// refreshes itself rather than relying on anyone re-adding a bookmark.
const BUILD = (() => {
  const fs = require('fs');
  const path = require('path');
  const files = ['server.js', 'views.js'].map((f) => path.join(__dirname, f))
    .concat([path.join(__dirname, '..', 'public', 'styles.css')]);
  const h = require('crypto').createHash('sha1');
  for (const f of files) {
    try { h.update(fs.readFileSync(f)); } catch { /* missing file — ignore */ }
  }
  return h.digest('hex').slice(0, 10);
})();

/**
 * Reload a stale page when the user comes back to it, but never mid-entry:
 * if anything has been typed, leave it alone and let them submit — the server
 * accepts older submissions too.
 */
const freshScript = `<script>
(function () {
  var BUILD = ${JSON.stringify(BUILD)};
  function typedInto() {
    var els = document.querySelectorAll('input, textarea, select');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.type === 'hidden' || e.type === 'submit' || e.type === 'button') continue;
      if (e.tagName === 'SELECT') { if (e.selectedIndex > 0) return true; continue; }
      if (e.type === 'checkbox' || e.type === 'radio') { if (e.checked !== e.defaultChecked) return true; continue; }
      if (e.value && e.value !== e.defaultValue) return true;
    }
    return false;
  }
  function check() {
    if (document.hidden || typedInto()) return;
    fetch('/version', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.build && d.build !== BUILD && !sessionStorage.getItem('rc_reload_' + d.build)) {
          sessionStorage.setItem('rc_reload_' + d.build, '1'); // once per version, never a loop
          location.reload();
        }
      })
      .catch(function () { /* offline — keep what's on screen */ });
  }
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pageshow', check);
})();
</script>`;

function layout(title, body, opts = {}) {
  if (opts.bare) {
    // No .wrap here — the staff screen owns the full viewport.
    return `<!doctype html><html lang="en"><head>${head(title, opts)}</head>
      <body class="bare">${body}${swScript}${freshScript}</body></html>`;
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
        // Pin / unpin the rail, remembered between sessions.
        function rcPin() {
          var on = document.documentElement.classList.toggle('side-pinned');
          try { localStorage.setItem('rc_side', on ? 'pinned' : 'rail'); } catch (e) {}
        }
        // Highlight the active nav link, and let the page borrow its accent so
        // each screen reads as its own place rather than another blue page.
        (function () {
          var p = location.pathname;
          var best = null;
          document.querySelectorAll('.side-link').forEach(function (a) {
            var href = a.getAttribute('href');
            // Longest matching prefix wins, so /c/recurring/3 still lights up
            // Recurring tasks rather than falling back to Dashboard.
            if (p === href || (href !== '/' && p.indexOf(href) === 0)) {
              if (!best || href.length > best.getAttribute('href').length) best = a;
            }
          });
          if (best) {
            best.classList.add('active');
            var ac = best.style.getPropertyValue('--ac');
            if (ac) {
              var r = document.documentElement.style;
              r.setProperty('--accent', ac.trim());
              r.setProperty('--accent-soft', ac.trim() + '14');
            }
          }
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
      ${swScript}${freshScript}
    </body></html>`;
}

function flash(req) {
  const m = req.query.msg;
  if (!m) return '';
  const err = req.query.err === '1';
  return `<div class="flash ${err ? 'flash-err' : 'flash-ok'}">${esc(m)}</div>`;
}

module.exports = { layout, flash, esc, money, dp, RESTAURANT, APP_NAME, BUILD };
