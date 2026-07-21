'use strict';

const { fmt } = require('./money');

// APP_NAME is the product (shown in the app chrome + PWA). RESTAURANT is the
// venue's own name, used to brand staff emails — set RESTAURANT_NAME in .env.
const { APP_NAME, RESTAURANT } = require('./brand');

// Grouped navigation — organized instead of one long list.

// Line icons drawn at 24×24 in currentColor. Emoji were the single biggest
// thing making the rail look unfinished — they render differently on every
// platform, sit off the baseline, and can't take the item's accent colour.
const ICON = {
  dashboard: '<path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z"/>',
  shifts: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9zM9 11h6M9 15h4"/>',
  sales: '<path d="M4 19h16"/><path d="m5 15 4-5 3.5 3L19 6"/><path d="M19 6h-3.5M19 6v3.5"/>',
  costs: '<circle cx="9" cy="9" r="2"/><circle cx="15" cy="15" r="2"/><path d="M18 6 6 18"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 12h.01M17.5 12h.01"/>',
  payroll: '<path d="M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2"/><rect x="3" y="8" width="18" height="11" rx="2"/><path d="M16 13h2"/>',
  expirations: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
  invoices: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9.5 8h5M9.5 12h5"/>',
  vendors: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
  par: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  contacts: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="10" r="2.4"/><path d="M8 16.5a4.2 4.2 0 0 1 8 0"/>',
  equipment: '<path d="M15.5 4.5a4.5 4.5 0 0 0-5.9 5.9L4 16v4h4l5.6-5.6a4.5 4.5 0 0 0 5.9-5.9L16.5 12 12 7.5l3.5-3Z"/>',
  documents: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  recurring: '<path d="M4 11a8 8 0 0 1 13.3-5.9L20 7"/><path d="M20 3v4h-4"/><path d="M20 13a8 8 0 0 1-13.3 5.9L4 17"/><path d="M4 21v-4h4"/>',
  incidents: '<path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
  notes: '<path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M14 4v5h5M8 13h8M8 17h5"/>',
  staff: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><path d="M16 6.2a3.2 3.2 0 0 1 0 6M17 14.5a5.5 5.5 0 0 1 4 4.5"/>',
  policy: '<path d="M12 4v16M7 20h10M5 8h14"/><path d="M5 8 2.5 14h5L5 8ZM19 8l-2.5 6h5L19 8Z"/>',
  positions: '<path d="m12 5 9 4-9 4-9-4 9-4Z"/><path d="M7 11v4.5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V11"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  tips: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M14.5 9.5A2.5 2.5 0 0 0 12 8h-.4a2.1 2.1 0 0 0-.4 4.1l1.6.3a2.1 2.1 0 0 1-.4 4.2H12a2.5 2.5 0 0 1-2.5-1.5"/>',
  signout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8 6 12l4 4M6 12h10"/>',
  pin: '<path d="M4 5v14"/><path d="M20 12H9"/><path d="m13 8-4 4 4 4"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 19a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9.5" r="2.4"/><path d="M16.5 14.6a5 5 0 0 1 5 4.4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  cleaning: '<path d="M12 3v6.5"/><path d="M9.2 9.5h5.6l1.2 4.5H8l1.2-4.5Z"/><path d="M8 14h8v4.5a2.5 2.5 0 0 1-2.5 2.5h-3A2.5 2.5 0 0 1 8 18.5V14Z"/>',
  pest: '<ellipse cx="12" cy="13.5" rx="4" ry="5"/><path d="M12 8.5V6M10.5 4.5 12 6l1.5-1.5"/><path d="M8 11H4.5M8 14.5H4M8 18H5M16 11h3.5M16 14.5h4M16 18h3"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ICON.dashboard}</svg>`;

// Each item carries its own accent. Colour here is wayfinding, not decoration:
// the rail stays recognisable when collapsed to icons, and the page you're on
// picks up its accent in the header — so Payroll never looks like Sales.
const { SECTIONS, areaFor, CREATE_ACTIONS } = require('./nav');

/** Accent plus the two tints the active pill needs, from one hex. */
const accentVars = (hex) => `--ac:${hex};--ac-soft:${hex}14;--ac-soft2:${hex}24`;

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const money = (c) => fmt(c);
const dp = (d) => (d === 'cafe' ? 'Café' : 'Dinner');

// Set by server.js so the nav can be drawn for whoever is signed in, without
// threading a user object through every layout() call site.
let viewCtx = null;
const setViewContext = (als) => { viewCtx = als; };
const currentViewUser = () => (viewCtx && viewCtx.getStore() ? viewCtx.getStore().user : null);

/**
 * Whether the signed-in account may change anything. A null user means auth is
 * switched off entirely, which is the local default.
 *
 * Pages use this to not offer what the server will refuse — a view-only
 * account being shown an upload button it cannot use means finding out after
 * choosing a file, which is the worst possible moment.
 */
function canWrite() {
  const u = currentViewUser();
  return !u || u.role !== 'viewer';
}

/** Which nav areas this account can open. Null user = auth off, show all. */
function navAllowed(href) {
  const u = currentViewUser();
  if (!u || u.master || !u.features || !u.features.length) return true;
  const key = areaFor(href);
  return !key || u.features.includes(key);
}

/**
 * The bar across the top: what is useful from anywhere, as opposed to the
 * sidebar, which is where the day's work happens.
 *
 * Deliberately not here yet: search, notifications, an assistant and help.
 * Each of those is a control that would do nothing, and chrome that lies
 * about what the app can do is worse than a gap where it will go.
 */
function topbar() {
  const u = currentViewUser();
  const create = CREATE_ACTIONS.filter((a) => navAllowed(a.href));
  const initials = (n) => String(n || '').split(/\s+/).map((w) => w[0]).filter(Boolean).join('').slice(0, 2).toUpperCase() || '·';
  return `
    <header class="topbar">
      <button class="menu-btn" onclick="document.body.classList.toggle('nav-open')" aria-label="Menu">☰</button>
      <a class="topbar-brand" href="/">
        <img class="brand-mark" src="/static/brand-mark.png" alt="" width="26" height="26">
        <img class="brand-word" src="/static/brand-word.png" alt="${esc(APP_NAME)}" width="70" height="15">
      </a>
      <!-- A label, not a picker. There is one restaurant in the data and a
           dropdown would promise switching that does not exist. -->
      <span class="topbar-site" title="${esc(RESTAURANT)}">${esc(RESTAURANT)}</span>
      <div class="tsearch" id="rc-search">
        ${icon('search')}
        <input id="rc-q" type="search" autocomplete="off" spellcheck="false"
          placeholder="Search products, invoices, vendors, staff…" aria-label="Search">
        <kbd>⌘K</kbd>
        <div class="tsearch-pop" id="rc-out" hidden></div>
      </div>
      <span class="topbar-gap"></span>
      ${canWrite() && create.length ? `
      <details class="tmenu" id="tb-create">
        <summary class="btn btn-primary btn-sm">＋ New</summary>
        <div class="tmenu-pop">
          ${create.map((a) => `<a href="${a.href}">${icon(a.icon)}${esc(a.label)}</a>`).join('')}
        </div>
      </details>` : ''}
      <details class="tmenu tmenu-right" id="tb-user">
        <summary class="avatar" title="${esc(u && u.name ? u.name : 'Account')}">${esc(initials(u && u.name ? u.name : 'Owner'))}</summary>
        <div class="tmenu-pop">
          <div class="tmenu-who"><b>${esc(u && u.name ? u.name : 'Owner')}</b>
            <i>${esc(u && u.email ? u.email : 'signed in')}${u && u.role === 'viewer' ? ' · view only' : ''}</i></div>
          ${navAllowed('/settings') ? `<a href="/settings">${icon('policy')}Settings</a>` : ''}
          ${navAllowed('/users') ? `<a href="/users">${icon('users')}Users &amp; access</a>` : ''}
          <a href="/logout">${icon('signout')}Sign out</a>
        </div>
      </details>
    </header>`;
}

function searchScript() {
  return `
  var RCS = { seq: 0, sel: -1, timer: null };
  function rcEsc(s){ return String(s==null?'':s).replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];}); }
  function rcClose(){ var o=document.getElementById('rc-out'); if(o){ o.hidden=true; o.innerHTML=''; } RCS.sel=-1; }
  function rcOpenResults(html){ var o=document.getElementById('rc-out'); o.innerHTML=html; o.hidden=false; }

  function rcPaint(d){
    RCS.sel = -1;
    if(!d || !d.groups.length){ rcOpenResults('<div class="ts-hint">Nothing found.</div>'); return; }
    var html='';
    d.groups.forEach(function(g){
      html += '<div class="ts-g">'+rcEsc(g.label)+'</div>';
      g.results.forEach(function(r){
        html += '<a class="ts-r" href="'+r.href+'"><span class="ts-t">'+rcEsc(r.title)+'</span>'
          + (r.sub ? '<span class="ts-s">'+rcEsc(r.sub)+'</span>' : '') + '</a>';
      });
    });
    if(d.truncated) html += '<div class="ts-hint">More matches than shown — keep typing.</div>';
    rcOpenResults(html);
  }
  function rcSel(step){
    var rows=document.querySelectorAll('#rc-out .ts-r');
    if(!rows.length) return;
    RCS.sel = (RCS.sel + step + rows.length) % rows.length;
    rows.forEach(function(r,i){ r.classList.toggle('on', i===RCS.sel); });
    rows[RCS.sel].scrollIntoView({ block:'nearest' });
  }

  (function(){
    var q=document.getElementById('rc-q');
    if(!q) return;
    // Never opens on its own. The results panel starts empty and only appears
    // once there is something to show — an overlay that greets you on page
    // load is the app shouting over whatever you came here to do.
    rcClose();

    q.addEventListener('input', function(){
      var term=this.value.trim();
      clearTimeout(RCS.timer);
      if(term.length < 2){ rcClose(); return; }
      RCS.timer = setTimeout(function(){
        // Sequence-checked: typing fast puts several in flight, and a slow
        // earlier reply must not overwrite a newer one.
        var seq = ++RCS.seq;
        fetch('/search?q='+encodeURIComponent(term))
          .then(function(r){ return r.json(); })
          .then(function(d){ if(seq===RCS.seq) rcPaint(d); })
          .catch(function(){ if(seq===RCS.seq) rcOpenResults('<div class="ts-hint">Search is not answering right now.</div>'); });
      }, 160);
    });

    q.addEventListener('keydown', function(e){
      if(e.key==='Escape'){ this.value=''; rcClose(); this.blur(); return; }
      var rows=document.querySelectorAll('#rc-out .ts-r');
      if(e.key==='ArrowDown'){ e.preventDefault(); rcSel(1); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); rcSel(-1); }
      else if(e.key==='Enter'){
        var pick = rows[RCS.sel] || rows[0];
        if(pick){ e.preventDefault(); location.href = pick.getAttribute('href'); }
      }
    });

    // Re-open on focus if there is still a term worth showing.
    q.addEventListener('focus', function(){ if(this.value.trim().length >= 2) this.dispatchEvent(new Event('input')); });
    document.addEventListener('click', function(e){ if(!e.target.closest('#rc-search')) rcClose(); });

    document.addEventListener('keydown', function(e){
      if((e.metaKey||e.ctrlKey) && (e.key==='k'||e.key==='K')){ e.preventDefault(); q.focus(); q.select(); }
    });
  })();`;
}

function sidebar() {
  const groups = SECTIONS.map((g) => {
    const links = g.links.filter(([href]) => navAllowed(href));
    if (!links.length) return '';           // a group with nothing left just goes
    return `
    ${g.title ? `<div class="side-group">${g.title}</div>` : ''}
    ${links.map(([href, ico, label, accent, , tag]) => `<a class="side-link" href="${href}" style="${accentVars(accent)}" title="${esc(label)}"><span class="side-ico">${icon(ico)}</span><span class="side-label">${label}${tag ? `<span class="side-tag">${esc(tag)}</span>` : ''}</span></a>`).join('')}
  `;
  }).join('');
  const who = currentViewUser();
  const signOut = process.env.APP_PASSWORD
    ? `<div class="side-group">${who && !who.master ? esc(who.name) : 'Account'}</div>
       <a class="side-link" href="/logout" style="--ac:#64748b;--ac-soft:#64748b14;--ac-soft2:#64748b24"><span class="side-ico">${icon('signout')}</span><span class="side-label">Sign out</span></a>`
    : '';
  return `<aside class="sidebar">
    <div class="side-top">
      <span class="side-spacer"></span>
      <button class="side-pin" type="button" onclick="rcPin()" aria-label="Collapse or pin the menu" title="Collapse / pin the menu">${icon('pin')}</button>
    </div>
    <nav class="side-nav">${groups}${signOut}</nav>
  </aside>`;
}

/** Loud warning when the app is reachable with no password set. */
const openWarning = () => (process.env.APP_PASSWORD ? '' :
  `<div class="open-warn">⚠️ <b>No password set.</b> Anyone with this link can see payroll and staff data. Set <code>APP_PASSWORD</code> to lock it down.</div>`);

/** Standing notice for a view-only account, so nothing it can't do is a shock. */
const viewerNote = () => (canWrite() ? '' :
  `<div class="viewer-warn">${icon('users')}<span><b>View only.</b> You can see everything here and change nothing. Ask the owner if you need to edit.</span></div>`);

/** Shared <head> bits: fonts, icons, PWA manifest, theme colour. */
function head(title, opts = {}) {
  const staff = !!opts.bare;
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>${esc(title)} · ${esc(staff ? RESTAURANT : APP_NAME)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/styles.css?v=${BUILD}">
    <link rel="manifest" href="${staff ? '/manifest-tips.webmanifest' : '/manifest.webmanifest'}">
    <meta name="theme-color" content="${staff ? '#2563eb' : '#ffffff'}">
    <link rel="icon" href="/static/icon-192.png">
    <link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="${staff ? 'black-translucent' : 'default'}">
    <meta name="apple-mobile-web-app-title" content="${staff ? 'Cash Tips' : APP_NAME}">
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
      ${topbar()}
      <div class="app">
        ${sidebar()}
        <div class="scrim" onclick="document.body.classList.remove('nav-open')"></div>
        <main class="content">${openWarning()}${viewerNote()}<div class="wrap">${body}</div></main>
      </div>
      <script>${searchScript()}</script>
      <script>
        // Pin / unpin the rail, remembered between sessions.
        function rcPin() {
          var root = document.documentElement;
          var on = root.classList.toggle('side-pinned');
          try { localStorage.setItem('rc_side', on ? 'pinned' : 'rail'); } catch (e) {}
          if (!on) {
            // The pointer is still over the rail after the click, so hover
            // would immediately re-open it. Hold the peek off until the mouse
            // genuinely leaves, or the toggle looks like it did nothing.
            root.classList.add('no-peek');
            var sb = document.querySelector('.sidebar');
            sb.addEventListener('mouseleave', function off() {
              root.classList.remove('no-peek');
              sb.removeEventListener('mouseleave', off);
            });
          }
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
  // An action that moved a date can pass ?undo=<path> to offer a way back.
  // Only same-site paths, so a crafted link can't post anywhere else.
  const undo = String(req.query.undo || '');
  const safeUndo = /^\/[A-Za-z0-9/_?=&.%-]*$/.test(undo) ? undo : '';
  const undoBtn = safeUndo
    ? `<form method="post" action="${esc(safeUndo)}" class="flash-undo"><button class="link" type="submit">Undo</button></form>`
    : '';
  return `<div class="flash ${err ? 'flash-err' : 'flash-ok'}"><span>${esc(m)}</span>${undoBtn}</div>`;
}

module.exports = { layout, flash, esc, money, dp, RESTAURANT, APP_NAME, BUILD, icon, setViewContext, canWrite };
