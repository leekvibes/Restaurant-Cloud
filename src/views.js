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
/** Two letters for the avatar. Declared once; three places were spelling it. */
const initialsOf = (u) => String((u && u.name) || 'Owner')
  .split(/\s+/).map((w) => w[0]).filter(Boolean).join('').slice(0, 2).toUpperCase() || 'M';
const currentPath = () => (viewCtx && viewCtx.getStore() ? viewCtx.getStore().path : '') || '/';

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
      <button class="menu-btn" onclick="rcSide()" aria-label="Menu" title="Menu (⌘B)">☰</button>
      <a class="topbar-brand" href="/">
        <img class="brand-mark" src="/static/brand-mark.png" alt="" width="26" height="26">
        <img class="brand-word" src="/static/brand-word.png" alt="${esc(APP_NAME)}" width="70" height="15">
      </a>
      <!-- A label, not a picker. There is one restaurant in the data and a
           dropdown would promise switching that does not exist. -->
      <span class="topbar-site" title="${esc(RESTAURANT)}">${esc(RESTAURANT)}</span>
      <div class="tsearch" id="rc-search">
        <!-- A real button, not decoration. On a phone the field is collapsed to
             this icon and the button is what opens it; on the desktop the field
             is always open and the button just puts the cursor in it. Same
             markup either way, so there is one thing to keep accessible. -->
        <button type="button" class="tsearch-ico" id="rc-sbtn"
          aria-label="Search" aria-expanded="false" aria-controls="rc-q">${icon('search')}</button>
        <input id="rc-q" type="search" autocomplete="off" spellcheck="false"
          placeholder="Search products, invoices, vendors, staff…" aria-label="Search">
        <button type="button" class="tsearch-x" id="rc-sx" aria-label="Clear search" hidden>×</button>
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
  var RCS = { seq: 0, sel: -1, timer: null, idle: null };
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

  // --- the collapsed field on a phone ---------------------------------------
  // Below 821px the field is an icon until it is asked for. The width it opens
  // to is measured rather than guessed: the controls on the right differ per
  // account — not everyone gets "+ New" — so a hard-coded width is wrong for
  // somebody. Measured once per open, written as one custom property, and the
  // transition is the browser's from there.
  function rcMobile(){ return window.matchMedia('(max-width: 900px)').matches; }
  function rcBar(){ return document.querySelector('.bs-masthead') || document.querySelector('.topbar'); }

  function rcExpand(focus){
    var bar=rcBar(), box=document.getElementById('rc-search'), btn=document.getElementById('rc-sbtn');
    if(!bar || !box || bar.classList.contains('search-on')) { if(focus) document.getElementById('rc-q').focus(); return; }
    var barR=bar.getBoundingClientRect(), boxR=box.getBoundingClientRect();
    // Everything to the right of the field that must stay clear of it.
    var right=0;
    ['#tb-create','#tb-user'].forEach(function(sel){
      var el=bar.querySelector(sel); if(el) right += el.getBoundingClientRect().width + 8;
    });
    box.style.setProperty('--tsw', Math.max(120, barR.right - boxR.left - right - 10) + 'px');
    bar.classList.add('search-on');
    if(btn) btn.setAttribute('aria-expanded','true');
    // After the class, so the keyboard comes up with the field already on its
    // way open rather than over a 34px box.
    if(focus) document.getElementById('rc-q').focus();
    rcIdle();
  }

  function rcCollapse(){
    var bar=rcBar(), btn=document.getElementById('rc-sbtn'), q=document.getElementById('rc-q');
    if(!bar) return;
    bar.classList.remove('search-on');
    if(btn) btn.setAttribute('aria-expanded','false');
    if(q) q.blur();
    rcClose();
    clearTimeout(RCS.idle);
  }

  // Idle collapse, but never over somebody's query. A field with something in
  // it is work in progress; closing it would throw away what they typed, and
  // "it keeps clearing itself" is a worse bug than a field left open.
  function rcIdle(){
    clearTimeout(RCS.idle);
    if(!rcMobile()) return;
    RCS.idle = setTimeout(function(){
      var q=document.getElementById('rc-q');
      if(q && q.value.trim()) return;               // typed something: leave it
      if(document.activeElement === q) return;      // still in it: leave it
      rcCollapse();
    }, 3000);
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
      var x=document.getElementById('rc-sx');
      if(x) x.hidden = !this.value;
      clearTimeout(RCS.timer);
      rcIdle();
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
      if(e.key==='Escape'){ this.value=''; var x=document.getElementById('rc-sx'); if(x) x.hidden=true;
        rcClose(); rcCollapse(); return; }
      var rows=document.querySelectorAll('#rc-out .ts-r');
      if(e.key==='ArrowDown'){ e.preventDefault(); rcSel(1); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); rcSel(-1); }
      else if(e.key==='Enter'){
        var pick = rows[RCS.sel] || rows[0];
        if(pick){ e.preventDefault(); location.href = pick.getAttribute('href'); }
      }
    });

    // Re-open on focus if there is still a term worth showing.
    q.addEventListener('focus', function(){ clearTimeout(RCS.idle); if(this.value.trim().length >= 2) this.dispatchEvent(new Event('input')); });
    q.addEventListener('blur', function(){ rcIdle(); });

    // Listening on the box, not only the glyph: collapsed it is a 34px pill and
    // a thumb that lands on its edge should open it, not miss.
    var box=document.getElementById('rc-search');
    if(box) box.addEventListener('click', function(e){
      if(e.target.closest('#rc-sx') || e.target.closest('#rc-out')) return;
      if(rcMobile() && !rcBar().classList.contains('search-on')){ e.preventDefault(); rcExpand(true); }
      else if(e.target.closest('#rc-sbtn')){ e.preventDefault(); q.focus(); }
    });
    var x=document.getElementById('rc-sx');
    if(x) x.addEventListener('click', function(e){
      e.preventDefault(); q.value=''; x.hidden=true; rcClose(); q.focus(); rcIdle();
    });

    document.addEventListener('click', function(e){
      if(e.target.closest('#rc-search')) return;
      rcClose();
      // Tapping away closes it, but not out from under a query somebody is
      // part way through writing.
      if(rcMobile() && !q.value.trim()) rcCollapse();
    });

    document.addEventListener('keydown', function(e){
      if((e.metaKey||e.ctrlKey) && (e.key==='k'||e.key==='K')){ e.preventDefault(); rcExpand(false); q.focus(); q.select(); }
    });

    // Rotating a phone, or resizing a desktop window past the breakpoint,
    // leaves the expanded width measured against a bar that no longer exists.
    window.addEventListener('resize', function(){
      if(!rcMobile()) rcCollapse();
      else if(rcBar().classList.contains('search-on')){ rcBar().classList.remove('search-on'); rcExpand(false); }
    });
  })();`;
}

// ===========================================================================
// BROADSHEET CHROME
// ---------------------------------------------------------------------------
// A masthead and one nav row, replacing the icon rail. Built from the same
// SECTIONS list as the sidebar was, so a link cannot exist in one and not the
// other, and navAllowed still decides what is even drawn.
//
// The front row carries what a restaurant opens daily. Everything else goes
// under the overflow arrow — pushed down the page, never removed, because a
// page you cannot reach is a page you do not have.
// ===========================================================================

// The front row, in order. A group listed in FRONT_ROW shows every one of its
// links; a group in FRONT_ROW_NAMED shows only its name and lands you on its
// first page, where the sub-nav takes over. Anything named in neither falls
// through to the overflow — so adding a section to nav.js can never silently
// vanish from the UI, it just starts one tap further in.
const FRONT_ROW = ['Operations', 'Purchasing', 'Restaurant'];
const FRONT_ROW_NAMED = ['Team'];

/** The group a path belongs to, for the sub-nav. */
function groupFor(path) {
  for (const g of SECTIONS) {
    if (!g.title) continue;
    for (const [href] of g.links) {
      if (href === '/' ? path === '/' : path === href || path.startsWith(href + '/')) return g;
    }
  }
  return null;
}

/** Is this link the one we are on? Longest match wins, as with areaFor. */
function navOn(href, path) {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(href + '/');
}

function masthead(path) {
  const u = currentViewUser();
  const initials = (n) => String(n || '').split(/\s+/).map((w) => w[0]).filter(Boolean).join('').slice(0, 2).toUpperCase() || 'M';
  const now = new Date();
  const stamp = now.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' }).toUpperCase();
  const part = now.getHours() < 12 ? 'MORNING' : now.getHours() < 17 ? 'AFTERNOON' : 'EVENING';
  const name = (u && u.name) || 'Owner';
  const first = name.split(/\s+/)[0];
  const role = u && u.role === 'viewer' ? 'View only' : (u && u.master ? 'Owner' : 'Manager');
  // The "+ Log a shift" button is gone from the bar entirely. That action
  // lives on the Shifts page and in the ⌘K menu; a global button for one
  // page's verb is what made this row crowded.

  return `
    <header class="bs-masthead">
      <a class="bs-wordmark" href="/">ZWIN</a>
      <span class="bs-loc">${esc(RESTAURANT)} <span aria-hidden="true">▾</span></span>
      <div class="bs-search" id="rc-search">
        <button type="button" class="bs-search-ico" id="rc-sbtn" aria-label="Search"
          aria-expanded="false" aria-controls="rc-q">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 L14 14"/></svg>
        </button>
        <input id="rc-q" type="search" autocomplete="off" spellcheck="false"
          placeholder="Search products, invoices, vendors, staff…" aria-label="Search">
        <button type="button" class="bs-search-x" id="rc-sx" aria-label="Clear search" hidden
          style="border:0;background:none;cursor:pointer;color:var(--muted)">×</button>
        <span class="bs-kbd">⌘K</span>
        <div class="tsearch-pop" id="rc-out" hidden></div>
      </div>
      <span class="bs-date" id="bs-date">${esc(stamp)} — <span id="bs-part">${part}</span></span>
      <button type="button" class="bs-theme" id="bs-theme" aria-label="Switch theme" title="Switch day / night">☾</button>
      <details class="bs-acct">
        <summary class="bs-chip" title="${esc(name)}">
          <span class="bs-chip-av">${esc(initials(name))}</span>
          <span class="bs-chip-n">${esc(first)}</span>
          <span class="bs-chip-c" aria-hidden="true">▾</span>
        </summary>
        <div class="bs-pop">
          <div class="bs-pop-h"><b>${esc(name)}</b>
            <i>${esc(role)}${u && u.email ? ` · ${esc(u.email)}` : ''}</i></div>
          ${navAllowed('/settings') ? '<a href="/settings">Settings</a>' : ''}
          ${navAllowed('/users') ? '<a href="/users">Users &amp; access</a>' : ''}
          ${navAllowed('/settings') ? '<a href="/settings#billing">Billing &amp; usage</a>' : ''}
          ${navAllowed('/email') ? '<a href="/email">Email settings</a>' : ''}
          <a class="bs-out" href="/logout">Sign out</a>
        </div>
      </details>
    </header>`;
}

function navRow(path) {
  const allowed = (g) => ({ ...g, links: g.links.filter(([href]) => navAllowed(href)) });
  const groups = SECTIONS.map(allowed).filter((g) => g.links.length);

  const home = groups.find((g) => !g.title);
  const front = FRONT_ROW.map((t) => groups.find((g) => g.title === t)).filter(Boolean);
  const named = FRONT_ROW_NAMED.map((t) => groups.find((g) => g.title === t)).filter(Boolean);
  const onFront = new Set([...FRONT_ROW, ...FRONT_ROW_NAMED]);
  const rest = groups.filter((g) => g.title && !onFront.has(g.title));

  const link = ([href, , label, , , tag]) =>
    `<a href="${href}"${navOn(href, path) ? ' class="on"' : ''}>${esc(label)}${tag ? ` <span class="bs-colhead">${esc(tag)}</span>` : ''}</a>`;

  const sep = '<span class="bs-nav-sep"></span>';
  const frontHtml = [
    home ? home.links.map(([href, , label]) => `<a href="${href}"${navOn(href, path) ? ' class="on"' : ''}>${esc(label === 'Dashboard' ? 'Front page' : label)}</a>`).join('') : '',
    ...front.map((g) => g.links.map(link).join('')),
    // A named group is one tab. Its pages are reachable through the sub-nav
    // that appears once you are inside it.
    ...named.map((g) => {
      const inside = g.links.some(([href]) => navOn(href, path));
      return `<a href="${g.links[0][0]}"${inside ? ' class="on"' : ''}>${esc(g.title)}</a>`;
    }),
  ].filter(Boolean).join(sep);

  const overflow = rest.length ? `
    <details class="bs-more">
      <summary aria-label="More sections">More <span aria-hidden="true">▾</span></summary>
      <div class="bs-more-pop">
        ${rest.map((g) => `<div class="bs-more-grp">${esc(g.title)}</div>${g.links.map(link).join('')}`).join('')}
      </div>
    </details>` : '';

  // ---- the expanded state -------------------------------------------------
  // The same tabs, reflowed under their group names. Everything is visible
  // once open, so there is no "More" here.
  const GROUPS = [
    ['Overview', home ? home.links.map(([href, , label]) => [href, label === 'Dashboard' ? 'Front page' : label]) : []],
    ...[...front, ...named, ...rest].map((g) => [g.title, g.links.map(([href, , label, , , tag]) => [href, label, tag])]),
  ].filter(([, links]) => links.length);

  const groupHtml = GROUPS.map(([title, links]) => `
    <div class="bs-bandg">
      <span class="bs-bandg-t">${esc(title)}</span>
      <span class="bs-bandg-l">${links.map(([href, label, tag]) =>
        `<a href="${href}"${navOn(href, path) ? ' class="on"' : ''}>${esc(label)}${
          tag ? ` <span class="bs-colhead">${esc(tag)}</span>` : ''}</a>`).join('')}</span>
    </div>`).join('');

  // One hover container holding both layouts. The band grows and shrinks in
  // flow — it never floats over the page, so nothing underneath moves out of
  // reach while it is open.
  return `
    <nav class="bs-band" id="bs-band" aria-label="Sections">
      <button type="button" class="bs-band-tap" id="bs-band-tap" aria-expanded="false"
        aria-controls="bs-band-x" aria-label="Show section groups"></button>
      <div class="bs-band-c">
        <div class="bs-nav-scroll">${frontHtml}</div>${overflow}
      </div>
      <div class="bs-band-x" id="bs-band-x">${groupHtml}</div>
    </nav>`;
}

/**
 * The group you are inside, and its siblings. Only drawn for a group that has
 * more than one page — a sub-nav with one tab is a rule with nothing under it.
 */
function subNav(path) {
  const g = groupFor(path);
  if (!g || !g.title) return '';
  const links = g.links.filter(([href]) => navAllowed(href));
  if (links.length < 2) return '';
  return `
    <div class="bs-subnav">
      <span class="bs-subnav-name">${esc(g.title)}</span>
      <span class="bs-subnav-links">
        ${links.map(([href, , label, , , tag]) =>
          `<a href="${href}"${navOn(href, path) ? ' class="on"' : ''}>${esc(label)}${tag ? ` <span class="bs-colhead">${esc(tag)}</span>` : ''}</a>`).join('')}
      </span>
    </div>`;
}

/**
 * The four places a phone goes, plus Index.
 *
 * Index is not decoration: with the nav row scrolled off a small screen it is
 * the only route to two thirds of the app, so it opens a sheet listing every
 * section. Built on <details>, so it works with JavaScript off like the rest
 * of the chrome.
 */
const BOTTOM = [
  ['/', '▤', 'Home'],
  ['/shifts', '≡', 'Shifts'],
  ['/sales', '$', 'Sales'],
  ['/c/invoices', '▦', 'Invoices'],
];

/**
 * A live word beside the sections worth checking before you tap through.
 *
 * Three indexed counts, run only when the index is built. Lazily required so
 * this file has no load-time dependency on the database — views.js is imported
 * by scripts and tests that never open one.
 */
function indexHints() {
  try {
    const { db } = require('./db');
    const out = {};

    const sh = db.prepare("SELECT COUNT(*) n, SUM(status <> 'emailed') open FROM shifts").get();
    if (sh && sh.n) {
      out['/shifts'] = sh.open
        ? { text: `${sh.n} · ${sh.open} not sent`, tone: 'warn' }
        : { text: `${sh.n} · all sent`, tone: 'muted' };
    }

    // A service that rang cash and has no final count against it.
    const cash = db.prepare(`SELECT COUNT(*) n FROM shifts sh
      WHERE sh.date >= date('now','-6 days')
        AND (SELECT COALESCE(SUM(ss.food_cents+ss.coffee_cents+ss.alcohol_cents),0)
               FROM server_sales ss WHERE ss.shift_id = sh.id) > 0
        AND NOT EXISTS (SELECT 1 FROM cash_recon c
               WHERE c.date = sh.date AND c.daypart = sh.daypart AND c.status = 'final')`).get();
    if (cash && cash.n) out['/cash'] = { text: `${cash.n} open`, tone: 'warn' };

    const pay = db.prepare('SELECT COUNT(*) n FROM period_sends').get();
    const per = db.prepare("SELECT COUNT(*) n FROM shifts WHERE status <> 'emailed'").get();
    if (pay && per && !per.n) out['/payroll'] = { text: 'ready', tone: 'ok' };

    return out;
  } catch {
    // The index is navigation. It renders whether or not a count is available.
    return {};
  }
}

function bottomBar(path) {
  const tabs = BOTTOM.filter(([href]) => navAllowed(href)).map(([href, glyph, label]) =>
    `<a href="${href}"${navOn(href, path) ? ' class="on"' : ''}><span class="bs-bottom-g" aria-hidden="true">${glyph}</span>${label}</a>`).join('');

  const groups = SECTIONS
    .map((g) => ({ ...g, links: g.links.filter(([href]) => navAllowed(href)) }))
    .filter((g) => g.links.length);
  const hints = indexHints();
  const u = currentViewUser();

  return `
    <nav class="bs-bottom">
      ${tabs}
      <details class="bs-index">
        <summary><span class="bs-bottom-g" aria-hidden="true">⋯</span>Index</summary>
        <div class="bs-index-body">
          <div class="bs-index-sheet">
            <div class="bs-index-mast">
              <span class="bs-index-brand"><b>ZWIN</b><i>${esc(RESTAURANT)}</i></span>
              <button type="button" class="bs-index-x" aria-label="Close"
                onclick="this.closest('details').open=false">✕</button>
            </div>
            <div class="bs-index-scroll">
              <h1 class="bs-index-title">Index</h1>
            ${groups.map((g) => `
              <div class="bs-index-grp">${esc(g.title || 'Front page')}</div>
              <div class="bs-index-links">
                ${g.links.map(([href, , label, , , tag]) => {
                  const h = hints[href];
                  return `<a href="${href}"${navOn(href, path) ? ' class="on"' : ''}>
                    <span>${esc(label)}${tag ? ` <i>${esc(tag)}</i>` : ''}</span>
                    <b class="bs-index-hint ${h ? h.tone : 'go'}">${h ? esc(h.text) : '→'}</b>
                  </a>`;
                }).join('')}
              </div>`).join('')}

            </div>
            <div class="bs-index-me">
              <span class="bs-index-av">${esc(initialsOf(u))}</span>
              <span class="bs-index-who">
                <b>${esc((u && u.name) || 'Owner')}</b>
                <i>${esc(u && u.role === 'viewer' ? 'View only' : 'Owner')}${u && u.email ? ` · ${esc(u.email)}` : ''}</i>
              </span>
              ${navAllowed('/settings') ? '<a class="bs-act" href="/settings">Settings →</a>' : ''}
            </div>
            <div class="bs-index-acct">
              ${navAllowed('/users') ? '<a href="/users">Users &amp; access</a><span aria-hidden="true">·</span>' : ''}
              ${navAllowed('/settings') ? '<a href="/settings">Billing</a><span aria-hidden="true">·</span>' : ''}
              <a class="danger" href="/logout">Sign out</a>
            </div>
          </div>
        </div>
      </details>
    </nav>`;
}

/** "File an entry" plus the dateline. The dashboard's foot, on every page. */
function bsFooter() {
  const file = [
    ['/shifts/new', 'shift'], ['/cash/new', 'drawer count'],
    ['/c/invoices', 'invoice'], ['/c/vendors', 'vendor'], ['/c/incidents', 'incident'],
  ].filter(([href]) => navAllowed(href));
  const when = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return `
    <footer class="bs-foot">
      ${canWrite() && file.length ? `<span class="bs-foot-file">File an entry:
        ${file.map(([href, label], i) => `${i ? '<span aria-hidden="true">·</span>' : ''}<a href="${href}">${label}</a>`).join(' ')}
      </span>` : '<span></span>'}
      <span>${esc(APP_NAME)} · ${esc(RESTAURANT)} — ${esc(when)}</span>
    </footer>`;
}

function sidebar() {
  const who = currentViewUser();
  // The first section is Dashboard alone. It gets rendered as the sidebar's
  // header row with the collapse control beside it: the control used to own a
  // row of its own, which was a whole empty line above the navigation for one
  // 34px button.
  const [head, ...rest] = SECTIONS;
  const link = ([href, ico, label, accent, , tag]) =>
    `<a class="side-link" href="${href}" style="${accentVars(accent)}" title="${esc(label)}"><span class="side-ico">${icon(ico)}</span><span class="side-label">${label}${tag ? `<span class="side-tag">${esc(tag)}</span>` : ''}</span></a>`;

  const headLinks = head.links.filter(([href]) => navAllowed(href));
  const groups = rest.map((g) => {
    const links = g.links.filter(([href]) => navAllowed(href));
    if (!links.length) return '';           // a group with nothing left just goes
    return `${g.title ? `<div class="side-group">${g.title}</div>` : ''}${links.map(link).join('')}`;
  }).join('');

  const signOut = process.env.APP_PASSWORD
    ? `<div class="side-group">${who && !who.master ? esc(who.name) : 'Account'}</div>
       <a class="side-link" href="/logout" style="--ac:#64748b;--ac-soft:#64748b14;--ac-soft2:#64748b24"><span class="side-ico">${icon('signout')}</span><span class="side-label">Sign out</span></a>`
    : '';

  return `<aside class="sidebar">
    <div class="side-head">
      ${headLinks.map(link).join('')}
      <button class="side-pin" type="button" onclick="rcSide()" aria-label="Collapse or pin the menu" title="Collapse / pin the menu (⌘B)">${icon('pin')}</button>
    </div>
    <nav class="side-nav">${groups}${signOut}</nav>
  </aside>`;
}

/** Loud warning when the app is reachable with no password set. */
const openWarning = () => (process.env.APP_PASSWORD ? '' :
  `<div class="bs-notice-bar crit">
    <span class="bs-notice-k">Unlocked</span>
    <span class="bs-notice-t"><b>No password set.</b> Anyone with this link can see payroll and staff data.
      Set <code>APP_PASSWORD</code> to lock it down.</span>
  </div>`);

/** Standing notice for a view-only account, so nothing it can't do is a shock. */
const viewerNote = () => (canWrite() ? '' :
  `<div class="bs-notice-bar">
    <span class="bs-notice-k">View only</span>
    <span class="bs-notice-t">You can see everything here and change nothing. Ask the owner if you need to edit.</span>
  </div>`);

/** Shared <head> bits: fonts, icons, PWA manifest, theme colour. */
function head(title, opts = {}) {
  // `bare` means "no app chrome" and `staff` means "this is the staff portal".
  // They were one flag, so /login — which is bare but is the MANAGER app —
  // served the tips manifest. Its start_url is /tips, so adding the login
  // screen to a home screen produced a shortcut that opened the tip form.
  // Two flags, because they are two questions.
  const staff = !!opts.staff;
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>${esc(title)} · ${esc(staff ? RESTAURANT : APP_NAME)}</title>
    <link rel="stylesheet" href="/static/fonts.css?v=${BUILD}">
    <link rel="stylesheet" href="/static/styles.css?v=${BUILD}">
    <link rel="stylesheet" href="/static/broadsheet.css?v=${BUILD}">
    ${staff ? `<link rel="stylesheet" href="/static/staff.css?v=${BUILD}">` : ''}
    <link rel="manifest" href="${staff ? '/manifest-tips.webmanifest' : '/manifest.webmanifest'}">
    <meta name="theme-color" content="${staff ? '#f7eee0' : '#ffffff'}">
    <link rel="icon" href="/static/${staff ? 'tips-' : ''}icon-192.png?v=${BUILD}">
    <link rel="apple-touch-icon" href="/static/${staff ? 'tips-' : ''}apple-touch-icon.png?v=${BUILD}">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="${staff ? 'black-translucent' : 'default'}">
    <meta name="apple-mobile-web-app-title" content="${staff ? 'Cash Tips' : APP_NAME}">
    <meta name="mobile-web-app-capable" content="yes">
    <script>
      // Before first paint, or the page flashes the wrong theme on every load.
      try {
        var t = localStorage.getItem('zwin_theme');
        document.documentElement.setAttribute('data-theme', t === 'night' ? 'night' : 'day');
      } catch (e) { document.documentElement.setAttribute('data-theme', 'day'); }
    </script>`;
}

const bandScript = `<script>
(function () {
  var band = document.getElementById('bs-band');
  if (!band) return;
  var tap = document.getElementById('bs-band-tap');
  var timer = null;
  var OPEN_AFTER = 120;   // a cursor crossing the band should not flick it open
  var CLOSE_AFTER = 200;  // a diagonal move to a far group should not snap it shut

  function set(open) {
    band.classList.toggle('open', open);
    if (tap) tap.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function schedule(open) {
    clearTimeout(timer);
    timer = setTimeout(function () { set(open); }, open ? OPEN_AFTER : CLOSE_AFTER);
  }

  // mouseenter/mouseleave, not :hover. They fire on the band's real boundary
  // and do not re-evaluate as the box resizes, so the open state cannot chase
  // its own layout — which is what made it twitch.
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  if (fine.matches) {
    band.addEventListener('mouseenter', function () { schedule(true); });
    band.addEventListener('mouseleave', function () { schedule(false); });
  }

  // No hover on a touch screen, so a tap toggles and a tap outside shuts it.
  if (tap) tap.addEventListener('click', function () {
    clearTimeout(timer);
    set(!band.classList.contains('open'));
  });
  document.addEventListener('click', function (e) {
    if (!band.contains(e.target)) { clearTimeout(timer); set(false); }
  });

  // Tabbing in opens it, so a keyboard reaches every section without a cursor.
  band.addEventListener('focusin', function () { clearTimeout(timer); set(true); });
  band.addEventListener('focusout', function () {
    setTimeout(function () { if (!band.contains(document.activeElement)) set(false); }, 0);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { clearTimeout(timer); set(false); }
  });
})();
</script>`;

const swScript = `<script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}</script>`;

// A build stamp that changes whenever the code does. Staff keep the tips page
// on a home screen for months, so a copy can outlive a change to the form and
// post fields the server no longer understands — which is exactly how one
// staff member ended up stuck on "session timed out". The page checks this and
// refreshes itself rather than relying on anyone re-adding a bookmark.
const BUILD = (() => {
  const fs = require('fs');
  const path = require('path');
  // Every file whose contents the browser caches behind ?v=. broadsheet.css
  // and fonts.css were missing, so a CSS-only change shipped with an unchanged
  // BUILD and every returning browser kept the old stylesheet.
  const files = ['server.js', 'views.js'].map((f) => path.join(__dirname, f))
    .concat(['styles.css', 'broadsheet.css', 'staff.css', 'fonts.css']
      .map((f) => path.join(__dirname, '..', 'public', f)));
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
  const path = currentPath();
  return `<!doctype html><html lang="en"><head>${head(title, opts)}</head>
    <body class="bs">
      ${masthead(path)}
      ${navRow(path)}
      ${subNav(path)}
      ${openWarning()}${viewerNote()}
      <main class="bs-main">${body}</main>
      ${bsFooter()}
      ${bottomBar(path)}
      <script>
        (function () {
          var btn = document.getElementById('bs-theme');
          var root = document.documentElement;
          var paint = function () {
            var night = root.getAttribute('data-theme') === 'night';
            if (btn) btn.textContent = night ? '☀' : '☾';
            var part = document.getElementById('bs-part');
            // The masthead says NIGHT in night mode, which is the only place
            // the theme names itself.
            if (part && part.dataset.was === undefined) part.dataset.was = part.textContent;
            if (part) part.textContent = night ? 'NIGHT' : part.dataset.was;
          };
          paint();
          if (btn) btn.addEventListener('click', function () {
            var next = root.getAttribute('data-theme') === 'night' ? 'day' : 'night';
            root.setAttribute('data-theme', next);
            try { localStorage.setItem('zwin_theme', next); } catch (e) {}
            paint();
          });
        })();
      </script>
      <script>
        // The billboard. Pauses on hover and on focus inside it, so a link in
        // a message can actually be clicked before it slides away.
        (function () {
          var bb = document.getElementById('bs-bb');
          if (!bb) return;
          var items = bb.querySelectorAll('.bs-bb-i');
          if (items.length < 2) return;
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          var i = 0, hold = false;
          bb.addEventListener('mouseenter', function () { hold = true; });
          bb.addEventListener('mouseleave', function () { hold = false; });
          bb.addEventListener('focusin', function () { hold = true; });
          setInterval(function () {
            if (hold || document.hidden) return;
            var cur = items[i];
            i = (i + 1) % items.length;
            cur.classList.remove('on');
            cur.classList.add('out');
            // The incoming one waits until the outgoing has cleared, so you
            // watch the change happen instead of seeing two lines cross.
            setTimeout(function () { items[i].classList.add('on'); }, 420);
            setTimeout(function () { cur.classList.remove('out'); }, 1400);
          }, 7000);
        })();
      </script>
      <script>${searchScript()}</script>
      <script>
        // Pin / unpin the rail, remembered between sessions.
        // One entry point for the arrow, the hamburger and the keyboard, so the
        // three cannot drift into behaving differently. On a phone the sidebar
        // is an overlay drawer; on a desktop it pins and reflows.
        function rcSide() {
          if (window.matchMedia('(max-width: 820px)').matches) {
            document.body.classList.toggle('nav-open');
            return;
          }
          rcPin();
        }
        document.addEventListener('keydown', function (e) {
          if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); rcSide(); }
        });

        function rcPin() {
          var root = document.documentElement;
          var on = root.classList.toggle('side-pinned');
          try { localStorage.setItem('rc_side', on ? 'pinned' : 'rail'); } catch (e) {}
          if (on) root.classList.remove('no-peek');   // pinning ends the suppression
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
      ${bandScript}${swScript}${freshScript}
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
    ? `<form method="post" action="${esc(safeUndo)}" class="bs-notice-undo"><button type="submit">Undo</button></form>`
    : '';
  return `<div class="bs-notice-bar ${err ? 'crit' : 'ok'}">
    <span class="bs-notice-k">${err ? 'Refused' : 'Saved'}</span>
    <span class="bs-notice-t">${esc(m)}</span>${undoBtn}
  </div>`;
}

// navAllowed is the one gate the sidebar and the routes both read, so it is
// exported rather than reimplemented per page — a second copy is how a link
// ends up visible to somebody who gets a 403 when they follow it.
module.exports = { layout, flash, esc, money, dp, RESTAURANT, APP_NAME, BUILD, icon, setViewContext, canWrite, navAllowed };
