'use strict';

// Load .env if present (Node 20.6+ has this built in — no dependency needed).
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* no .env, fine */ }

const path = require('path');
const express = require('express');
const { db, q, s, w, shiftInputs } = require('./db');
const { runShift } = require('./engine');
const { buildEmails, sendEmails } = require('./email');
const { fmt, toCents } = require('./money');
const { layout, flash, esc, money, dp, RESTAURANT } = require('./views');
const { mountModules, MODULES, expiringSoon } = require('./modules');
const { policyForShift, currentForDaypart, historyForDaypart, saveRules, revertTo } = require('./policy');
const { defaultRules } = require('./engine');
const { aggregatePayroll, buildWorkbook, aggregateCosts } = require('./reports');
const { readReport } = require('./reader');
const multer = require('multer');
const reportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use('/static', express.static(PUBLIC_DIR));
// PWA files must be served from the site root so the service worker's scope
// covers the whole app (a /static/sw.js could only control /static/*).
for (const f of ['sw.js', 'manifest.webmanifest', 'manifest-tips.webmanifest', 'apple-touch-icon.png']) {
  app.get('/' + f, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, f)));
}

const PORT = Number(process.env.PORT || 4000);
const DAYPARTS = ['cafe', 'dinner'];
const SUPPORT_ROLES = ['kitchen', 'barista', 'bartender', 'busser'];

// Cash reconciliation — daily drawer over/short by shift.
db.exec(`CREATE TABLE IF NOT EXISTS cash_recon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, daypart TEXT NOT NULL,
  float_cents INTEGER DEFAULT 0, cash_sales_cents INTEGER DEFAULT 0,
  paid_out_cents INTEGER DEFAULT 0, counted_cents INTEGER DEFAULT 0,
  closed_by TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
const cashQ = {
  list: db.prepare('SELECT * FROM cash_recon ORDER BY date DESC, id DESC LIMIT 90'),
  insert: db.prepare(`INSERT INTO cash_recon (date, daypart, float_cents, cash_sales_cents, paid_out_cents, counted_cents, closed_by, note)
    VALUES (@date, @daypart, @float_cents, @cash_sales_cents, @paid_out_cents, @counted_cents, @closed_by, @note)`),
  del: db.prepare('DELETE FROM cash_recon WHERE id = ?'),
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function salesChart(dailySales, today) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const ds = d.toISOString().slice(0, 10);
    days.push({ ds, c: dailySales[ds] || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.c));
  const W = 600, H = 150, pad = 10, bw = (W - pad * 2) / days.length;
  const bars = days.map((d, i) => {
    const h = Math.max(2, Math.round((d.c / max) * (H - 34)));
    const x = pad + i * bw + bw * 0.16, y = H - 20 - h, w = bw * 0.68;
    const lbl = i % 3 === 0 ? `<text class="bar-lbl" x="${x + w / 2}" y="${H - 5}" text-anchor="middle">${d.ds.slice(5)}</text>` : '';
    return `<rect class="bar" x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="3"><title>${d.ds}: ${money(d.c)}</title></rect>${lbl}`;
  }).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}">${bars}</svg></div>`;
}

app.get('/', (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = (d) => d.toISOString().slice(0, 10);
  const toStr = iso(today);
  const from7 = iso(new Date(today.getTime() - 6 * 86400000));
  const from14 = iso(new Date(today.getTime() - 13 * 86400000));

  const costs = aggregateCosts(from7, toStr); // sales, laborPct, primePct, wow (sales vs prior 7d)

  // One pass over the last 14 days: daily sales for the chart + this/prior week tips.
  const dailySales = {};
  let tips7 = 0, tipsPrev = 0;
  for (const sh of s.shiftsInRange.all(from14, toStr)) {
    const inp = shiftInputs(sh.id);
    const r = runShift(inp, policyForShift(sh));
    const sales = r.servers.reduce((a, x) => a + x.sales.food + x.sales.coffee + x.sales.alcohol, 0);
    dailySales[sh.date] = (dailySales[sh.date] || 0) + sales;
    if (sh.date >= from7) tips7 += r.reconciliation.totalTipsCollected;
    else tipsPrev += r.reconciliation.totalTipsCollected;
  }
  const tipsDelta = tipsPrev ? Math.round(((tips7 - tipsPrev) / tipsPrev) * 100) : null;
  const openCount = db.prepare("SELECT COUNT(*) n FROM shifts WHERE status != 'emailed'").get().n;
  const deltaTag = (v) => (v === null ? '' : `<span class="delta ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}%</span> vs prev week`);

  const stats = `
    <div class="stats">
      <div class="stat"><div class="stat-label">Sales · this week</div><div class="stat-value">${money(costs.sales)}</div><div class="stat-sub">${deltaTag(costs.wow)}</div></div>
      <div class="stat"><div class="stat-label">Tips · this week</div><div class="stat-value">${money(tips7)}</div><div class="stat-sub">${deltaTag(tipsDelta)}</div></div>
      <div class="stat"><div class="stat-label">Labor %</div><div class="stat-value">${costs.laborPct === null ? '—' : costs.laborPct + '%'}</div><div class="stat-sub">wages ÷ sales</div></div>
      <div class="stat"><div class="stat-label">Prime cost %</div><div class="stat-value">${costs.primePct === null ? '—' : costs.primePct + '%'}</div><div class="stat-sub">labor + goods</div></div>
    </div>`;

  // Needs attention
  const attn = [];
  const exp = expiringSoon().filter((e) => e.days <= 30);
  if (exp.length) attn.push({ cls: 'red', ico: '⏰', title: `${exp.length} expiring within 30 days`, sub: exp.slice(0, 3).map((e) => `${e.name} (${e.days < 0 ? 'expired' : e.days + 'd'})`).join(' · '), href: '/c/expirations' });
  const lowPar = db.prepare('SELECT item FROM m_par WHERE on_hand IS NOT NULL AND reorder_point IS NOT NULL AND on_hand <= reorder_point').all();
  if (lowPar.length) attn.push({ cls: 'amber', ico: '📦', title: `${lowPar.length} item${lowPar.length > 1 ? 's' : ''} at reorder point`, sub: lowPar.slice(0, 4).map((x) => x.item).join(' · '), href: '/c/par' });
  const shorts = cashQ.list.all().filter((r) => r.date >= from14 && r.counted_cents < r.float_cents + r.cash_sales_cents - r.paid_out_cents).length;
  if (shorts) attn.push({ cls: 'red', ico: '💵', title: `${shorts} cash short${shorts > 1 ? 's' : ''} in the last 2 weeks`, sub: 'Review who closed the drawer', href: '/cash' });
  if (openCount) attn.push({ cls: 'blue', ico: '📋', title: `${openCount} shift${openCount > 1 ? 's' : ''} not sent yet`, sub: 'Finish the close and email staff', href: '/shifts' });
  const attnHtml = attn.length
    ? `<div class="attn">${attn.map((a) => `<a class="attn-item" href="${a.href}"><span class="attn-ico ${a.cls}">${a.ico}</span><span class="attn-main"><span class="attn-title">${a.title}</span><br><span class="attn-sub">${esc(a.sub)}</span></span><span class="attn-go">›</span></a>`).join('')}</div>`
    : '<div class="all-clear">✓ Nothing needs your attention right now.</div>';

  const recent = s.recentShifts.all(6).map((sh) => {
    const inp = shiftInputs(sh.id);
    const r = runShift(inp, policyForShift(sh));
    const sales = r.servers.reduce((a, x) => a + x.sales.food + x.sales.coffee + x.sales.alcohol, 0);
    return `<tr>
      <td><a href="/shifts/${sh.id}">${sh.date}</a></td><td>${dp(sh.daypart)}</td>
      <td class="num">${money(sales)}</td><td class="num">${money(r.reconciliation.totalTipsCollected)}</td>
      <td>${sh.status === 'emailed' ? '<span class="pill pill-ok">emailed</span>' : '<span class="pill pill-blue">open</span>'}</td>
    </tr>`;
  }).join('');

  const tiles = [...MODULES.map((m) => ({ href: `/c/${m.slug}`, ico: m.icon, name: m.title, desc: m.blurb })),
    { href: '/costs', ico: '📈', name: 'Cost %', desc: 'Labor, food, prime cost' },
    { href: '/cash', ico: '💵', name: 'Cash count', desc: 'Drawer over / short' },
    { href: '/payroll', ico: '💰', name: 'Payroll', desc: 'Roll-up for Gusto' },
    { href: '/policy', ico: '⚖️', name: 'Tip-out policy', desc: 'Edit rates, versioned' },
    { href: '/employees', ico: '🧑‍🍳', name: 'Staff', desc: 'People, roles, wages' },
  ].map((t) => `<a class="tile" href="${t.href}"><span class="tile-ico">${t.ico}</span><span class="tile-name">${t.name}</span><span class="tile-desc">${t.desc}</span></a>`).join('');

  const body = `
    ${flash(req)}
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="sub">Here's how your restaurant is doing.</p></div>
      <a class="btn btn-primary" href="/shifts/new">➕ Log a shift</a>
    </div>
    ${stats}
    <div class="chart-card">
      <div class="chart-head"><span class="t">Sales · last 14 days</span><span class="sub">${money(costs.sales)} this week</span></div>
      ${salesChart(dailySales, today)}
    </div>
    <h2>Needs attention</h2>
    ${attnHtml}
    <div class="head-row"><h2>Recent shifts</h2><a class="link" href="/shifts">See all →</a></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Service</th><th class="num">Sales</th><th class="num">Tips</th><th>Status</th></tr></thead>
      <tbody>${recent || '<tr><td colspan="5" class="muted">No shifts yet — tap “Log a shift”.</td></tr>'}</tbody>
    </table></div>
    <h2>Everything else</h2>
    <div class="tiles">${tiles}</div>`;
  res.send(layout('Dashboard', body));
});

// ---------------------------------------------------------------------------
// Shifts — list of all shifts + "log a shift"
// ---------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
app.get('/shifts', (req, res) => {
  const all = s.allShifts.all().map((sh) => {
    const inp = shiftInputs(sh.id);
    const r = runShift(inp, policyForShift(sh));
    const sales = r.servers.reduce((a, x) => a + x.sales.food + x.sales.coffee + x.sales.alcohol, 0);
    return { sh, sales, tips: r.reconciliation.totalTipsCollected, staff: inp.servers.length + inp.support.length };
  });

  // Group by month (YYYY-MM), newest first.
  const groups = [];
  const byMonth = new Map();
  for (const x of all) {
    const key = x.sh.date.slice(0, 7);
    if (!byMonth.has(key)) { byMonth.set(key, { key, items: [], sales: 0, tips: 0 }); groups.push(byMonth.get(key)); }
    const g = byMonth.get(key); g.items.push(x); g.sales += x.sales; g.tips += x.tips;
  }

  let bodyRows = '';
  groups.forEach((g, gi) => {
    const [y, m] = g.key.split('-');
    const label = `${MONTHS[Number(m) - 1]} ${y}`;
    bodyRows += `<tr class="group-row" data-month="${g.key}" onclick="toggleMonth('${g.key}')">
      <td colspan="5"><span class="caret">▾</span> ${label}
        <span class="g-sum">· ${g.items.length} shift${g.items.length > 1 ? 's' : ''} · ${money(g.sales)} sales · ${money(g.tips)} tips</span></td></tr>`;
    bodyRows += g.items.map((x) => `<tr class="shift-row" data-month="${g.key}" data-service="${x.sh.daypart}" data-status="${x.sh.status === 'emailed' ? 'emailed' : 'open'}" data-date="${x.sh.date}">
      <td><a href="/shifts/${x.sh.id}">${x.sh.date}</a></td>
      <td>${dp(x.sh.daypart)}</td>
      <td class="num">${money(x.sales)}</td>
      <td class="num">${money(x.tips)}</td>
      <td>${x.sh.status === 'emailed' ? '<span class="pill pill-ok">emailed</span>' : '<span class="pill pill-blue">open</span>'}</td>
    </tr>`).join('');
  });

  res.send(layout('Shifts', `
    ${flash(req)}
    <div class="page-head"><div><h1>Shifts</h1><p class="sub">${all.length} logged. Grouped by month — search or filter to narrow down.</p></div>
      <a class="btn btn-primary" href="/shifts/new">➕ Log a shift</a></div>
    <div class="toolbar">
      <div class="search"><input id="shift-search" type="search" placeholder="Search a date (e.g. 07-16)" oninput="filterShifts()"></div>
      <div class="chips" data-filter="service">
        <button class="chip active" data-v="" onclick="chip(this)">All</button>
        <button class="chip" data-v="cafe" onclick="chip(this)">Café</button>
        <button class="chip" data-v="dinner" onclick="chip(this)">Dinner</button>
      </div>
      <div class="chips" data-filter="status">
        <button class="chip active" data-v="" onclick="chip(this)">Any status</button>
        <button class="chip" data-v="open" onclick="chip(this)">Open</button>
        <button class="chip" data-v="emailed" onclick="chip(this)">Emailed</button>
      </div>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Service</th><th class="num">Sales</th><th class="num">Tips</th><th>Status</th></tr></thead>
      <tbody id="shift-body">${bodyRows || '<tr><td colspan="5" class="muted">No shifts yet — tap “Log a shift”.</td></tr>'}</tbody>
    </table></div>
    <p class="sub" id="no-match" style="display:none">No shifts match those filters.</p>
    <script>
      var F = { service: '', status: '', q: '' };
      function chip(btn) {
        var group = btn.parentElement, key = group.getAttribute('data-filter');
        group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active'); F[key] = btn.getAttribute('data-v'); filterShifts();
      }
      function toggleMonth(k) {
        var g = document.querySelector('.group-row[data-month="' + k + '"]');
        g.classList.toggle('collapsed');
        var hide = g.classList.contains('collapsed');
        document.querySelectorAll('.shift-row[data-month="' + k + '"]').forEach(function (r) { r.dataset.userCollapsed = hide ? '1' : ''; });
        filterShifts();
      }
      function filterShifts() {
        F.q = (document.getElementById('shift-search').value || '').trim().toLowerCase();
        var anyShown = false;
        var monthHas = {};
        document.querySelectorAll('.shift-row').forEach(function (r) {
          var ok = (!F.service || r.dataset.service === F.service)
            && (!F.status || r.dataset.status === F.status)
            && (!F.q || r.dataset.date.indexOf(F.q) !== -1);
          var collapsed = r.dataset.userCollapsed === '1' && !F.q && !F.service && !F.status;
          r.style.display = ok && !collapsed ? '' : 'none';
          if (ok) { anyShown = true; monthHas[r.dataset.month] = true; }
        });
        document.querySelectorAll('.group-row').forEach(function (g) {
          g.style.display = monthHas[g.dataset.month] ? '' : 'none';
        });
        document.getElementById('no-match').style.display = anyShown ? 'none' : '';
      }
    </script>`));
});

app.get('/shifts/new', (req, res) => {
  const body = `
    <a class="back" href="/shifts">← Shifts</a>
    <h1>Log a shift</h1>
    <p class="sub">Pick the day and which service (café or dinner). You'll enter sales, tips &amp; hours next.</p>
    <form method="post" action="/shifts" class="card form">
      <label>Date <input type="date" name="date" required></label>
      <label>Service
        <select name="daypart">${DAYPARTS.map((d) => `<option value="${d}">${dp(d)}</option>`).join('')}</select>
      </label>
      <button class="btn btn-primary" type="submit">Start</button>
    </form>`;
  res.send(layout('Log a shift', body));
});

app.post('/shifts', (req, res) => {
  const { date, daypart } = req.body;
  if (!date || !DAYPARTS.includes(daypart)) return res.redirect('/shifts/new?err=1&msg=' + encodeURIComponent('Pick a date and service.'));
  s.getOrIgnore.run(date, daypart);
  const sh = s.findShift.get(date, daypart);
  policyForShift(sh); // lock in the tip-out policy version that's current right now
  res.redirect(`/shifts/${sh.id}`);
});

// ---------------------------------------------------------------------------
// Shift entry screen
// ---------------------------------------------------------------------------
app.get('/shifts/:id', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).send(layout('Not found', '<h1>Shift not found</h1>'));
  const inp = shiftInputs(sh.id);
  // Anyone (except managers) can be dropped into either section — position and
  // wage are per-shift, so someone can server one day and busse the next.
  const staff = q.nonManagerList.all();
  const rate = (c) => (c ? money(c) + '/h' : '<span class="muted">default</span>');

  const serverRows = inp.servers.map((sv) => `
    <tr data-emp="${sv.employeeId}" data-kind="server">
      <td>${esc(sv.name)}</td>
      <td class="num" data-edit="food" data-step="0.01">${money(toCents(sv.food))}</td>
      <td class="num" data-edit="coffee" data-step="0.01">${money(toCents(sv.coffee))}</td>
      <td class="num" data-edit="card_tips" data-step="0.01">${money(toCents(sv.cardTips))}</td>
      <td class="num">${sv.cashEnteredBy ? money(toCents(sv.cashTips)) : '<span class="muted">—</span>'}</td>
      <td class="num" data-edit="hours" data-step="0.25">${sv.hours}</td>
      <td class="num" data-edit="wage" data-step="0.01" data-ph="default">${rate(toCents(sv.hourlyRate))}</td>
      <td class="row-actions">
        <button type="button" class="link" onclick="startEdit(${sv.employeeId},'server')">edit</button>
        <form method="post" action="/shifts/${sh.id}/remove"><input type="hidden" name="employee_id" value="${sv.employeeId}"><button class="link-danger">remove</button></form></td>
    </tr>`).join('');

  const supportRows = inp.support.map((p) => `
    <tr data-emp="${p.employeeId}" data-kind="support">
      <td>${esc(p.name)}</td>
      <td>${p.role}</td>
      <td class="num" data-edit="hours" data-step="0.25">${p.hours}</td>
      <td class="num" data-edit="wage" data-step="0.01" data-ph="default">${rate(toCents(p.hourlyRate))}</td>
      <td class="row-actions">
        <button type="button" class="link" onclick="startEdit(${p.employeeId},'support')">edit</button>
        <form method="post" action="/shifts/${sh.id}/remove"><input type="hidden" name="employee_id" value="${p.employeeId}"><button class="link-danger">remove</button></form></td>
    </tr>`).join('');

  const staffOptions = staff.map((e) => `<option value="${e.id}" data-role="${e.role}" data-rate="${((e.hourly_rate_cents || 0) / 100).toFixed(2)}">${esc(e.name)} · ${e.role}</option>`).join('');
  const roleOpts = (sel) => SUPPORT_ROLES.map((r) => `<option value="${r}"${r === sel ? ' selected' : ''}>${r}</option>`).join('');

  // Current entries, so picking someone already on the shift pre-fills their
  // numbers (re-adding = editing; no accidental wipe of sales).
  const salesMap = new Map(w.salesForShift.all(sh.id).map((r) => [r.employee_id, r]));
  const entries = {};
  const d = (c) => (c ? (c / 100).toFixed(2) : '');
  for (const row of w.workForShift.all(sh.id)) {
    const sr = salesMap.get(row.employee_id) || {};
    entries[row.employee_id] = {
      role: row.role, hours: row.hours || '', wage: d(row.shift_rate_cents),
      food: d(sr.food_cents), coffee: d(sr.coffee_cents), alcohol: d(sr.alcohol_cents), card_tips: d(sr.card_tips_cents),
    };
  }

  const body = `
    ${flash(req)}
    <a class="back" href="/shifts">← Shifts</a>
    <div class="page-head">
      <div><h1>${sh.date} · ${dp(sh.daypart)} ${sh.status === 'emailed' ? '<span class="pill pill-ok">emailed</span>' : '<span class="pill pill-blue">open</span>'}</h1>
        <p class="sub">Enter sales, tips &amp; hours. Tap <b>edit</b> on any row to change numbers in place.</p></div>
      <a class="btn btn-primary" href="/shifts/${sh.id}/results">Preview &amp; send →</a>
    </div>

    <h2>Servers</h2>
    <p class="muted">Sales &amp; card tips come from Benugin (enter manually for now). Cash tips come from staff on the <a href="/tips">cash-tip page</a>.</p>
    <form method="post" action="/shifts/${sh.id}/read-report" enctype="multipart/form-data" class="card form photo-form">
      <div>
        <strong>📸 Read from a report photo</strong>
        <p class="muted" style="margin:2px 0 0">Snap the end-of-day report (several photos OK). It fills in each server's sales + card tips below for you to check.${process.env.ANTHROPIC_API_KEY ? '' : ' <b>Needs an ANTHROPIC_API_KEY in .env first.</b>'}</p>
      </div>
      <label>Photo(s) <input type="file" name="photos" accept="image/*" multiple ${process.env.ANTHROPIC_API_KEY ? '' : 'disabled'}></label>
      <button class="btn" type="submit" ${process.env.ANTHROPIC_API_KEY ? '' : 'disabled'}>Read photo</button>
    </form>
    <table class="table">
      <thead><tr><th>Server</th><th class="num">Food</th><th class="num">Coffee</th><th class="num">Card tips</th><th class="num">Cash tips</th><th class="num">Hours</th><th class="num">Wage</th><th></th></tr></thead>
      <tbody>${serverRows || '<tr><td colspan="8" class="muted">No servers yet.</td></tr>'}</tbody>
    </table>
    <form method="post" action="/shifts/${sh.id}/server" class="card form grid" id="server-form">
      <label>Server <select name="employee_id" required id="server-emp">${staffOptions}</select></label>
      <label>Food sales <input name="food" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Coffee sales <input name="coffee" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Alcohol sales <input name="alcohol" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Card tips <input name="card_tips" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Hours <input name="hours" type="number" step="0.25" min="0" placeholder="0"></label>
      <label>Wage/hr <input name="wage" type="number" step="0.01" min="0" placeholder="staff default"></label>
      <button class="btn" type="submit">Save server</button>
    </form>

    <h2>Support — kitchen, busser, barista</h2>
    <p class="muted">Their hours (and wage, if different today). Their tip-out share is the pool split by hours.</p>
    <table class="table">
      <thead><tr><th>Name</th><th>Role</th><th class="num">Hours</th><th class="num">Wage</th><th></th></tr></thead>
      <tbody>${supportRows || '<tr><td colspan="5" class="muted">No support staff yet.</td></tr>'}</tbody>
    </table>
    <form method="post" action="/shifts/${sh.id}/support" class="card form grid" id="support-form">
      <label>Employee <select name="employee_id" required id="support-emp">${staffOptions}</select></label>
      <label>Role <select name="role" id="support-role">${roleOpts()}</select></label>
      <label>Hours <input name="hours" type="number" step="0.25" min="0" placeholder="0" required></label>
      <label>Wage/hr <input name="wage" type="number" step="0.01" min="0" placeholder="staff default"></label>
      <button class="btn" type="submit">Save support</button>
    </form>

    <h2>Shared tip pool</h2>
    <p class="muted">Support tips for the shift. How each part is paid out (weekly cash vs. paycheck) is set on the <a href="/policy">tip-out policy</a>.</p>
    <form method="post" action="/shifts/${sh.id}/pool" class="card form grid">
      <label>Cash tips (jar) <input name="jar" type="number" step="0.01" min="0" value="${sh.pool_jar_cents ? (sh.pool_jar_cents / 100).toFixed(2) : ''}" placeholder="0.00"></label>
      <label>To-go card tips <input name="togo_card" type="number" step="0.01" min="0" value="${sh.pool_togo_card_cents ? (sh.pool_togo_card_cents / 100).toFixed(2) : ''}" placeholder="0.00"></label>
      <button class="btn" type="submit">Save pool</button>
    </form>
    <script>
      var ENTRIES = ${JSON.stringify(entries)};
      function setVal(form, name, v) { var el = form.querySelector('[name="' + name + '"]'); if (el) el.value = v == null ? '' : v; }
      // Server form: picking someone already on the shift loads their current numbers.
      (function () {
        var f = document.getElementById('server-form'), emp = document.getElementById('server-emp');
        if (!f || !emp) return;
        function sync() {
          var e = ENTRIES[emp.value] || {};
          ['food', 'coffee', 'alcohol', 'card_tips', 'hours', 'wage'].forEach(function (k) { setVal(f, k, e[k]); });
        }
        emp.addEventListener('change', sync); sync();
      })();
      // Support form: default role to their usual position; load hours/wage if already on shift.
      (function () {
        var f = document.getElementById('support-form'), emp = document.getElementById('support-emp'), role = document.getElementById('support-role');
        if (!f || !emp || !role) return;
        function sync() {
          var opt = emp.options[emp.selectedIndex], e = ENTRIES[emp.value] || {};
          var r = e.role || opt.getAttribute('data-role');
          for (var i = 0; i < role.options.length; i++) if (role.options[i].value === r) role.selectedIndex = i;
          setVal(f, 'hours', e.hours); setVal(f, 'wage', e.wage);
        }
        emp.addEventListener('change', sync); sync();
      })();
      // Inline row editing — turn the cells into inputs right where they are.
      var SHIFT = ${sh.id};
      function startEdit(emp, kind) {
        var tr = document.querySelector('tr[data-emp="' + emp + '"][data-kind="' + kind + '"]');
        if (!tr || tr.dataset.editing) return;
        tr.dataset.editing = '1';
        var e = ENTRIES[emp] || {};
        tr.querySelectorAll('[data-edit]').forEach(function (td) {
          var f = td.getAttribute('data-edit'), step = td.getAttribute('data-step') || '0.01', ph = td.getAttribute('data-ph') || '';
          td.innerHTML = '<input class="cell-in" data-f="' + f + '" type="number" step="' + step + '" min="0" placeholder="' + ph + '" value="' + (e[f] == null ? '' : e[f]) + '">';
        });
        tr.querySelector('.row-actions').innerHTML =
          '<button type="button" class="link" onclick="saveEdit(' + emp + ',\\'' + kind + '\\')">save</button>' +
          '<button type="button" class="link-danger" onclick="location.reload()">cancel</button>';
        var first = tr.querySelector('.cell-in'); if (first) first.focus();
      }
      function saveEdit(emp, kind) {
        var tr = document.querySelector('tr[data-emp="' + emp + '"][data-kind="' + kind + '"]');
        var e = ENTRIES[emp] || {};
        var form = document.createElement('form');
        form.method = 'post';
        form.action = '/shifts/' + SHIFT + '/' + (kind === 'server' ? 'server' : 'support');
        function add(n, v) { var i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v == null ? '' : v; form.appendChild(i); }
        add('employee_id', emp);
        tr.querySelectorAll('.cell-in').forEach(function (inp) { add(inp.getAttribute('data-f'), inp.value); });
        if (kind === 'server') { add('alcohol', e.alcohol || 0); }       // not shown, keep it
        else { add('role', e.role); }                                    // keep their role
        document.body.appendChild(form); form.submit();
      }
    </script>`;
  res.send(layout(`${sh.date} ${sh.daypart}`, body));
});

app.post('/shifts/:id/server', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  const empId = Number(req.body.employee_id);
  w.upsertWork.run({ shift_id: sh.id, employee_id: empId, role: 'server', hours: Number(req.body.hours) || 0, hourly_rate_cents: toCents(req.body.wage) });
  w.upsertSales.run({
    shift_id: sh.id, employee_id: empId,
    food_cents: toCents(req.body.food), coffee_cents: toCents(req.body.coffee),
    alcohol_cents: toCents(req.body.alcohol), card_tips_cents: toCents(req.body.card_tips),
  });
  res.redirect(`/shifts/${sh.id}?msg=` + encodeURIComponent('Server saved.'));
});

app.post('/shifts/:id/support', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  w.upsertWork.run({
    shift_id: sh.id, employee_id: Number(req.body.employee_id),
    role: req.body.role, hours: Number(req.body.hours) || 0, hourly_rate_cents: toCents(req.body.wage),
  });
  res.redirect(`/shifts/${sh.id}?msg=` + encodeURIComponent('Support saved.'));
});

app.post('/shifts/:id/remove', (req, res) => {
  w.deleteWork.run(req.params.id, Number(req.body.employee_id));
  res.redirect(`/shifts/${req.params.id}?msg=` + encodeURIComponent('Removed.'));
});

app.post('/shifts/:id/pool', (req, res) => {
  s.setPool.run({ id: Number(req.params.id), jar: toCents(req.body.jar), togo_card: toCents(req.body.togo_card) });
  res.redirect(`/shifts/${req.params.id}?msg=` + encodeURIComponent('Tip pool saved.'));
});

// Read a photo of the POS report → extract per-server numbers → pre-fill the shift.
app.post('/shifts/:id/read-report', reportUpload.array('photos', 12), async (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  const back = (msg, err) => res.redirect(`/shifts/${sh.id}?msg=` + encodeURIComponent(msg) + (err ? '&err=1' : ''));
  const files = (req.files || []).map((f) => ({ buffer: f.buffer, mimetype: f.mimetype }));
  if (!files.length) return back('Attach at least one photo.', true);

  let data;
  try {
    data = await readReport(files);
  } catch (e) {
    return back('Could not read the photo — ' + e.message, true);
  }

  // Match extracted names to staff (exact, then first-name), pre-fill their sales.
  const staff = q.nonManagerList.all();
  const lc = (v) => String(v || '').trim().toLowerCase();
  const matched = [];
  const unmatched = [];
  for (const row of data.servers || []) {
    const emp = staff.find((e) => lc(e.name) === lc(row.name))
      || staff.find((e) => lc(e.name).split(' ')[0] === lc(row.name).split(' ')[0] && lc(row.name));
    if (!emp) { unmatched.push(row.name || '(unnamed)'); continue; }
    w.insertWorkIfAbsent.run({ shift_id: sh.id, employee_id: emp.id, role: 'server' });
    w.upsertSales.run({
      shift_id: sh.id, employee_id: emp.id,
      food_cents: toCents(row.food), coffee_cents: toCents(row.coffee),
      alcohol_cents: toCents(row.alcohol), card_tips_cents: toCents(row.card_tips),
    });
    matched.push(emp.name);
  }
  let msg = matched.length
    ? `Read ${matched.length} server${matched.length === 1 ? '' : 's'}: ${matched.join(', ')}. Check the numbers below, then send.`
    : 'No servers could be matched from the photo.';
  if (unmatched.length) msg += ` Couldn't match: ${unmatched.join(', ')} (add them under Staff or fix the spelling).`;
  return back(msg, matched.length === 0);
});

// ---------------------------------------------------------------------------
// Results + email preview / send
// ---------------------------------------------------------------------------
function peopleMap(inp) {
  const m = new Map();
  for (const p of [...inp.servers, ...inp.support]) m.set(p.employeeId, { email: p.email, hourlyRate: p.hourlyRate, salaried: p.salaried });
  return m;
}

app.get('/shifts/:id/results', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).send(layout('Not found', '<h1>Shift not found</h1>'));
  const inp = shiftInputs(sh.id);
  const r = runShift(inp, policyForShift(sh));

  const warn = [];
  if (!r.reconciliation.balanced) warn.push('Tip totals do not reconcile — check the numbers.');
  for (const o of r.orphanedPots) warn.push(`${money(o.cents)} is owed to “${o.role}” but nobody worked that role. Add them or the money is unassigned.`);
  const missingEmail = [...inp.servers, ...inp.support].filter((p) => !p.email).map((p) => p.name);
  if (missingEmail.length) warn.push('No email on file for: ' + missingEmail.join(', ') + '. Add it under Staff.');
  const noCash = inp.servers.filter((sv) => !sv.cashEnteredBy).map((sv) => sv.name);
  if (noCash.length) warn.push('Cash tips not entered yet for: ' + noCash.join(', ') + '. They can add them on the cash-tip page.');

  const serverCards = r.servers.map((p) => `
    <div class="card">
      <div class="card-head"><strong>${esc(p.name)}</strong><span class="pill">server · ${p.hours}h</span></div>
      <div class="kv"><span>Total tips</span><b>${money(p.totalTips)}</b></div>
      <div class="kv sub"><span>tip-out</span><span>-${money(p.tipoutTotal)}</span></div>
      <div class="kv total"><span>Keeps</span><b class="pos">${money(p.tipsKept)}</b></div>
      <a class="view-email" href="/shifts/${sh.id}/email/${p.employeeId}" target="_blank">View email →</a>
    </div>`).join('');

  const poolLbl = { weekly_cash: 'Pool (weekly cash)', paycheck: 'Pool (paycheck)', nightly_cash: 'Pool (cash tonight)' };
  const supportCards = r.support.map((p) => {
    const poolLines = Object.keys(p.poolShares || {}).filter((k) => p.poolShares[k])
      .map((k) => `<div class="kv"><span>${poolLbl[k] || 'Pool'}</span><b>${money(p.poolShares[k])}</b></div>`).join('');
    return `
    <div class="card">
      <div class="card-head"><strong>${esc(p.name)}</strong><span class="pill">${p.role} · ${p.hours}h</span></div>
      ${p.tipShare ? `<div class="kv"><span>Tip-out (paycheck)</span><b>${money(p.tipShare)}</b></div>` : ''}
      ${poolLines}
      <div class="kv total"><span>Total</span><b class="pos">${money(p.tipShare + p.poolShare)}</b></div>
      <a class="view-email" href="/shifts/${sh.id}/email/${p.employeeId}" target="_blank">View email →</a>
    </div>`;
  }).join('');

  const potTiles = Object.keys(r.pots).filter((role) => r.pots[role]).map((role) =>
    `<div class="pot"><span>${role} pool</span><b>${money(r.pots[role])}</b></div>`).join('');
  const poolTile = r.pool.total ? `<div class="pot"><span>Jar + to-go pool</span><b>${money(r.pool.total)}</b></div>` : '';

  const mailReady = process.env.GMAIL_USER || process.env.SMTP_HOST;
  const totalTips = r.reconciliation.totalTipsCollected;
  const body = `
    ${flash(req)}
    <a class="back" href="/shifts/${sh.id}">← Back to entry</a>
    <div class="page-head"><div><h1>${sh.date} · ${dp(sh.daypart)}</h1><p class="sub">Tip-out results — review, then send everyone their email.</p></div>
      <form method="post" action="/shifts/${sh.id}/send" style="margin:0"><button class="btn btn-primary" type="submit">${mailReady ? '✉ Send emails to all' : '✉ Generate previews'}</button></form></div>
    ${warn.length ? `<div class="flash flash-warn"><div><b>Before you send:</b><ul>${warn.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
    <div class="stats">
      <div class="stat"><div class="stat-label">Total tips collected</div><div class="stat-value">${money(totalTips)}</div></div>
      ${Object.keys(r.pots).filter((role) => r.pots[role]).map((role) => `<div class="stat"><div class="stat-label">${role} pool</div><div class="stat-value">${money(r.pots[role])}</div></div>`).join('')}
      ${r.pool.total ? `<div class="stat"><div class="stat-label">Jar + to-go pool</div><div class="stat-value">${money(r.pool.total)}</div></div>` : ''}
    </div>
    <h2>Servers</h2><div class="cards">${serverCards || '<p class="muted">None.</p>'}</div>
    <h2>Support</h2><div class="cards">${supportCards || '<p class="muted">None.</p>'}</div>
    <div class="send-bar">
      <form method="post" action="/shifts/${sh.id}/send" style="margin:0"><button class="btn btn-primary" type="submit">${mailReady ? 'Send emails to all staff' : 'Generate email previews'}</button></form>
      <span class="muted">${mailReady ? 'Sends now to everyone with an email.' : 'No mail configured yet — this writes preview files you can open.'}</span>
    </div>`;
  res.send(layout('Results', body));
});

// Preview one employee's actual email in the browser (opens the real HTML).
app.get('/shifts/:id/email/:employeeId', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).send('Shift not found');
  const inp = shiftInputs(sh.id);
  const r = runShift(inp, policyForShift(sh));
  const emails = buildEmails(r, { date: sh.date, daypart: sh.daypart }, peopleMap(inp));
  const one = emails.find((e) => String(e.employeeId) === String(req.params.employeeId));
  if (!one) return res.status(404).send('No email for that person on this shift');
  res.send(one.html);
});

app.post('/shifts/:id/send', async (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  const inp = shiftInputs(sh.id);
  const r = runShift(inp, policyForShift(sh));
  const emails = buildEmails(r, { date: sh.date, daypart: sh.daypart }, peopleMap(inp));
  const result = await sendEmails(emails);
  s.markEmailed.run(sh.id);
  let msg;
  if (result.sent) msg = `Sent ${result.sent} emails.` + (result.errors.length ? ` ${result.errors.length} failed.` : '');
  else msg = `Wrote ${result.previewed} preview files to /previews (open them to see each email).`;
  res.redirect(`/shifts/${sh.id}/results?msg=` + encodeURIComponent(msg) + (result.errors.length ? '&err=1' : ''));
});

// ---------------------------------------------------------------------------
// Staff cash-tip page (NO LOGIN — name + PIN)
// ---------------------------------------------------------------------------
app.get('/tips', (req, res) => {
  // Success screen after a submit.
  if (req.query.done === '1') {
    const body = `
      <div class="tips-screen">
        <div class="tips-card tips-done">
          <div class="tips-check">✓</div>
          <div class="tips-done-title">Nice work${req.query.name ? ', ' + esc(req.query.name) : ''}! 🎉</div>
          <div class="tips-done-amt">${esc(req.query.amt || '')}</div>
          <div class="tips-done-sub">cash recorded${req.query.shift ? ' for ' + esc(req.query.shift) : ''}. You're all set.</div>
          <a class="tips-submit" href="/tips">Log another</a>
        </div>
      </div>`;
    return res.send(layout('Done', body, { bare: true }));
  }

  const servers = q.serversList.all();
  const shifts = s.recentShifts.all(6);
  const err = req.query.err === '1' ? `<div class="tips-error">${esc(req.query.msg || 'Something went wrong.')}</div>` : '';
  const body = `
    <div class="tips-screen">
      <div class="tips-card">
        <div class="tips-brand">${esc(RESTAURANT)}</div>
        <div class="tips-title">💵 Log your cash tips</div>
        <div class="tips-lead">Takes 10 seconds. Only you can see your PIN — your manager just sees the totals.</div>
        ${err}
        <form method="post" action="/tips" class="tips-form">
          <label class="tips-field">Who are you?
            <select name="employee_id" class="tips-in" required>${servers.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
          </label>
          <label class="tips-field">Which shift?
            <select name="shift_id" class="tips-in" required>${shifts.map((sh) => `<option value="${sh.id}">${sh.date} · ${dp(sh.daypart)}</option>`).join('')}</select>
          </label>
          <label class="tips-field">Your PIN
            <input name="pin" class="tips-in tips-pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••" required>
          </label>
          <label class="tips-field">Cash you took home
            <div class="tips-money"><span>$</span><input name="cash_tips" class="tips-in" type="number" step="0.01" min="0" placeholder="0.00" required></div>
          </label>
          <button class="tips-submit" type="submit">Submit my tips →</button>
        </form>
      </div>
    </div>`;
  res.send(layout('Cash tips', body, { bare: true }));
});

app.post('/tips', (req, res) => {
  const emp = q.employee.get(Number(req.body.employee_id));
  if (!emp || String(emp.pin || '') !== String(req.body.pin || '')) {
    return res.redirect('/tips?err=1&msg=' + encodeURIComponent('Name or PIN did not match — try again.'));
  }
  const sh = s.shiftById.get(Number(req.body.shift_id));
  if (!sh) return res.redirect('/tips?err=1&msg=' + encodeURIComponent('Pick a valid shift.'));
  w.insertWorkIfAbsent.run({ shift_id: sh.id, employee_id: emp.id, role: 'server' });
  w.setCashTips.run({ shift_id: sh.id, employee_id: emp.id, cash_tips_cents: toCents(req.body.cash_tips), by: 'staff' });
  const amt = '$' + (toCents(req.body.cash_tips) / 100).toFixed(2);
  res.redirect('/tips?done=1&name=' + encodeURIComponent(emp.name.split(' ')[0]) + '&amt=' + encodeURIComponent(amt) + '&shift=' + encodeURIComponent(dp(sh.daypart)));
});

// ---------------------------------------------------------------------------
// Staff management
// ---------------------------------------------------------------------------
app.get('/employees', (req, res) => {
  const staff = q.allEmployees.all();
  const initials = (n) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const rows = staff.map((e) => {
    const extraRoles = q.rolesForEmployee.all(e.id).length;
    const wage = e.pay_type === 'salary' ? '<span class="pill">salary</span>'
      : e.hourly_rate_cents ? money(e.hourly_rate_cents) + '/h' : '<span class="muted">—</span>';
    return `<tr>
      <td><div class="person"><span class="avatar">${initials(e.name)}</span><span>${esc(e.name)}</span></div></td>
      <td><span class="pill pill-blue">${e.role}</span>${extraRoles ? ` <span class="sub">+${extraRoles}</span>` : ''}</td>
      <td class="num">${wage}</td>
      <td>${esc(e.email) || '<span class="muted">—</span>'}</td>
      <td>${e.pin ? '••••' : '<span class="muted">—</span>'}</td>
      <td><a href="/employees/${e.id}/edit">edit</a></td></tr>`;
  }).join('');
  const roles = ['server', ...SUPPORT_ROLES, 'manager'];
  const counts = staff.reduce((a, e) => { a[e.role] = (a[e.role] || 0) + 1; return a; }, {});
  const body = `
    ${flash(req)}
    <div class="page-head"><div><h1>🧑‍🍳 Staff</h1><p class="sub">${staff.length} on the team · ${counts.server || 0} servers · open anyone to set roles &amp; wages.</p></div>
      <a class="btn btn-primary" href="#add">＋ Add staff</a></div>
    ${staff.length > 8 ? '<div class="toolbar"><div class="search"><input type="search" id="mod-search" placeholder="Search staff…" oninput="modFilter()"></div></div>' : ''}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Role</th><th class="num">Wage</th><th>Email</th><th>PIN</th><th></th></tr></thead>
      <tbody id="mod-body">${rows || '<tr><td colspan="6" class="muted">No staff yet — add your first below.</td></tr>'}</tbody></table></div>
    <h2 id="add">Add staff</h2>
    <form method="post" action="/employees" class="card form grid">
      <label>Name <input name="name" required></label>
      <label>Main role <select name="role">${roles.map((r) => `<option value="${r}">${r}</option>`).join('')}</select></label>
      <label>Email <input name="email" type="email" placeholder="for daily summary"></label>
      <label>4-digit PIN <input name="pin" inputmode="numeric" maxlength="6" placeholder="servers only"></label>
      <label>Pay type <select name="pay_type"><option value="hourly">Hourly</option><option value="salary">Salary</option></select></label>
      <label>Hourly wage <input name="rate" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Benugin ID <input name="pos_id" placeholder="optional"></label>
      <button class="btn btn-primary" type="submit">Add</button>
    </form>
    <p class="sub">Add the person first, then open them to set <b>multiple roles &amp; wages</b> (e.g. server $11, busser $13) or mark them salaried.</p>
    <script>function modFilter(){var q=(document.getElementById('mod-search').value||'').toLowerCase();document.querySelectorAll('#mod-body tr').forEach(function(r){r.style.display=r.textContent.toLowerCase().indexOf(q)!==-1?'':'none';});}</script>`;
  res.send(layout('Staff', body));
});

app.post('/employees', (req, res) => {
  const { name, role, email, pin, rate, pos_id, pay_type } = req.body;
  if (!name || !role) return res.redirect('/employees?err=1&msg=' + encodeURIComponent('Name and role required.'));
  q.addEmployee.run({
    name: name.trim(), role, email: (email || '').trim() || null,
    pin: (pin || '').trim() || null, hourly_rate_cents: toCents(rate), pos_id: (pos_id || '').trim() || null,
    pay_type: pay_type === 'salary' ? 'salary' : 'hourly', salary_cents: toCents(req.body.salary),
  });
  res.redirect('/employees?msg=' + encodeURIComponent(`${name} added.`));
});

app.get('/employees/:id/edit', (req, res) => {
  const e = q.employee.get(Number(req.params.id));
  if (!e) return res.status(404).send(layout('Not found', '<h1>Staff member not found</h1>'));
  const roles = ['server', ...SUPPORT_ROLES, 'manager'];
  const val = (v) => esc(v == null ? '' : v);
  const payRoles = ['server', ...SUPPORT_ROLES];
  const roleRows = q.rolesForEmployee.all(e.id).map((r) => `
    <tr><td>${r.role}</td><td class="num">${money(r.wage_cents)}/h</td>
      <td><form method="post" action="/employees/${e.id}/roles/delete"><input type="hidden" name="role" value="${r.role}"><button class="link-danger">remove</button></form></td></tr>`).join('');
  const isSalary = e.pay_type === 'salary';
  const body = `
    ${flash(req)}
    <a class="back" href="/employees">← Staff</a>
    <h1>Edit ${esc(e.name)}</h1>
    <form method="post" action="/employees/${e.id}" class="card form grid">
      <label>Name <input name="name" value="${val(e.name)}" required></label>
      <label>Main role <select name="role">${roles.map((r) => `<option value="${r}"${r === e.role ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
      <label>Email <input name="email" type="email" value="${val(e.email)}"></label>
      <label>4-digit PIN <input name="pin" inputmode="numeric" maxlength="6" value="${val(e.pin)}"></label>
      <label>Pay type <select name="pay_type"><option value="hourly"${isSalary ? '' : ' selected'}>Hourly</option><option value="salary"${isSalary ? ' selected' : ''}>Salary</option></select></label>
      <label>Default hourly wage <input name="rate" type="number" step="0.01" min="0" value="${e.hourly_rate_cents ? (e.hourly_rate_cents / 100).toFixed(2) : ''}"></label>
      <label>Salary (if salaried) <input name="salary" type="number" step="0.01" min="0" value="${e.salary_cents ? (e.salary_cents / 100).toFixed(2) : ''}" placeholder="per pay period"></label>
      <label>Benugin ID <input name="pos_id" value="${val(e.pos_id)}"></label>
      <button class="btn btn-primary" type="submit">Save changes</button>
    </form>

    <h2>Roles &amp; wages</h2>
    <p class="sub">Add each role this person works and the wage for it. On a shift, the wage for the role they worked applies automatically — no need to type it each time. (Salaried staff don't need wages here.)</p>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Role</th><th class="num">Wage</th><th></th></tr></thead>
      <tbody>${roleRows || '<tr><td colspan="3" class="muted">None yet — falls back to the default wage above.</td></tr>'}</tbody>
    </table></div>
    <form method="post" action="/employees/${e.id}/roles" class="card form grid">
      <label>Role <select name="role">${payRoles.map((r) => `<option value="${r}">${r}</option>`).join('')}</select></label>
      <label>Wage/hr <input name="wage" type="number" step="0.01" min="0" placeholder="0.00" required></label>
      <button class="btn" type="submit">Add role &amp; wage</button>
    </form>

    <form method="post" action="/employees/${e.id}/deactivate" onsubmit="return confirm('Remove ${esc(e.name)} from active staff? Their past shifts stay intact.')" style="margin-top:18px">
      <button class="link-danger">Deactivate this person</button>
    </form>`;
  res.send(layout('Edit staff', body));
});

app.post('/employees/:id', (req, res) => {
  const e = q.employee.get(Number(req.params.id));
  if (!e) return res.status(404).end();
  const { name, role, email, pin, rate, pos_id, pay_type } = req.body;
  if (!name || !role) return res.redirect(`/employees/${e.id}/edit?err=1&msg=` + encodeURIComponent('Name and role required.'));
  q.updateEmployee.run({
    id: e.id, name: name.trim(), role, email: (email || '').trim() || null,
    pin: (pin || '').trim() || null, hourly_rate_cents: toCents(rate), pos_id: (pos_id || '').trim() || null,
    pay_type: pay_type === 'salary' ? 'salary' : 'hourly', salary_cents: toCents(req.body.salary),
  });
  res.redirect('/employees?msg=' + encodeURIComponent(`${name} updated.`));
});

app.post('/employees/:id/roles', (req, res) => {
  q.setRole.run({ employee_id: Number(req.params.id), role: req.body.role, wage_cents: toCents(req.body.wage) });
  res.redirect(`/employees/${req.params.id}/edit?msg=` + encodeURIComponent('Role & wage saved.'));
});

app.post('/employees/:id/roles/delete', (req, res) => {
  q.deleteRole.run(Number(req.params.id), req.body.role);
  res.redirect(`/employees/${req.params.id}/edit?msg=` + encodeURIComponent('Role removed.'));
});

app.post('/employees/:id/deactivate', (req, res) => {
  q.setActive.run({ id: Number(req.params.id), active: 0 });
  res.redirect('/employees?msg=' + encodeURIComponent('Staff member deactivated.'));
});

// ---------------------------------------------------------------------------
// Payroll — roll up shift records over a date range
// ---------------------------------------------------------------------------
function defaultRange() {
  // Last 14 days ending today.
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const fromD = new Date(today.getTime() - 13 * 86400000);
  return { from: fromD.toISOString().slice(0, 10), to };
}

/** YYYY-MM-DD minus N days (for showing the week-1 end date). */
function shiftBack(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

app.get('/payroll', (req, res) => {
  const def = defaultRange();
  const from = req.query.from || def.from;
  const to = req.query.to || def.to;
  const { rows, totals, shiftCount, midDate } = aggregatePayroll(from, to);

  const body = rows.map((r) => `
    <tr>
      <td><div class="person"><span class="avatar">${r.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span><span>${esc(r.name)}</span></div>
        <div class="sub" style="margin-left:40px">${esc(r.roles)}</div></td>
      <td class="num">${r.shifts}</td>
      <td class="num"><b>${r.hours}</b></td>
      <td class="num">${money(r.wage)}</td>
      <td class="num">${money(r.cashTips)}</td>
      <td class="num pos strong">${money(r.paycheckTips)}</td>
      <td class="num strong">${money(r.takeHome)}</td>
      <td class="num muted">${r.wk1Hours}</td>
      <td class="num muted">${r.wk2Hours}</td>
    </tr>`).join('');

  res.send(layout('Payroll', `
    ${flash(req)}
    <div class="page-head">
      <div><h1>💰 Payroll</h1><p class="sub">${shiftCount} shift${shiftCount === 1 ? '' : 's'} · ${from} → ${to}. Enter <b>hours</b> and <b>card tip payout</b> into Gusto.</p></div>
      <a class="btn btn-primary" href="/payroll/export?from=${from}&to=${to}">⬇ Export to Excel</a>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Total hours</div><div class="stat-value">${totals.hours}</div><div class="stat-sub">wk1 ${totals.wk1Hours} · wk2 ${totals.wk2Hours}</div></div>
      <div class="stat"><div class="stat-label">Wages</div><div class="stat-value">${money(totals.wage)}</div></div>
      <div class="stat"><div class="stat-label">Card tip payout</div><div class="stat-value pos">${money(totals.paycheckTips)}</div><div class="stat-sub">→ enter into Gusto</div></div>
      <div class="stat"><div class="stat-label">Total take-home</div><div class="stat-value">${money(totals.takeHome)}</div><div class="stat-sub">wages + all tips</div></div>
    </div>
    <form method="get" action="/payroll" class="card form inline-range">
      <label>From <input type="date" name="from" value="${from}"></label>
      <label>To <input type="date" name="to" value="${to}"></label>
      <button class="btn" type="submit">Update range</button>
    </form>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>Employee</th><th class="num">Shifts</th><th class="num">Total hours</th><th class="num">Wage earning</th>
        <th class="num">Cash tips</th><th class="num">Card tip payout</th><th class="num">Total take-home</th>
        <th class="num">Wk 1 hrs</th><th class="num">Wk 2 hrs</th>
      </tr></thead>
      <tbody>${body || '<tr><td colspan="9" class="muted">No shifts in this range.</td></tr>'}</tbody>
      <tfoot><tr>
        <td><b>Total</b></td><td class="num"><b>${totals.shifts}</b></td><td class="num"><b>${totals.hours}</b></td>
        <td class="num"><b>${money(totals.wage)}</b></td><td class="num"><b>${money(totals.cashTips)}</b></td>
        <td class="num"><b>${money(totals.paycheckTips)}</b></td><td class="num"><b>${money(totals.takeHome)}</b></td>
        <td class="num"><b>${totals.wk1Hours}</b></td><td class="num"><b>${totals.wk2Hours}</b></td>
      </tr></tfoot>
    </table></div>
    <p class="sub"><b>Card tip payout</b> is what goes into Gusto — it's the tips owed on the paycheck (card tips net of tip-out), and excludes cash they already have.
      <b>Cash tips</b> = cash taken home nightly + the weekly jar/to-go cash. <b>Total take-home</b> = wages + cash tips + card tip payout.
      Wk 1 = ${from} → ${shiftBack(midDate, 1)}, Wk 2 = ${midDate} → ${to}.</p>`));
});

app.get('/payroll/export', async (req, res) => {
  const def = defaultRange();
  const from = req.query.from || def.from;
  const to = req.query.to || def.to;
  const wb = await buildWorkbook(from, to, RESTAURANT);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="payroll_${from}_to_${to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------------------------------------------------------------------------
// Cost dashboard — the calculated numbers (labor %, food cost %, prime cost)
// ---------------------------------------------------------------------------
app.get('/costs', (req, res) => {
  const def = defaultRange();
  const from = req.query.from || def.from;
  const to = req.query.to || def.to;
  const c = aggregateCosts(from, to);
  const pct = (v) => (v === null ? '<span class="muted">—</span>' : v + '%');
  const wowBadge = c.wow === null ? '<span class="muted">no prior period</span>'
    : c.wow >= 0 ? `<span class="pos">▲ ${c.wow}%</span>` : `<span style="color:var(--danger)">▼ ${-c.wow}%</span>`;

  // Simple health coloring on the headline percentages (industry rules of thumb).
  const band = (v, warn, bad) => (v === null ? '' : v >= bad ? 'stat-bad' : v >= warn ? 'stat-warn' : 'stat-ok');

  res.send(layout('Cost %', `
    ${flash(req)}
    <div class="page-head"><div><h1>Cost dashboard</h1>
      <p class="sub">The numbers you actually check — not just the raw data. Sales &amp; labor come from your closes; food cost from invoices tagged Food/Coffee/Beverage/Alcohol.</p></div></div>
    <form method="get" action="/costs" class="card form inline-range">
      <label>From <input type="date" name="from" value="${from}"></label>
      <label>To <input type="date" name="to" value="${to}"></label>
      <button class="btn" type="submit">Update</button>
    </form>
    <div class="stats">
      <div class="stat"><div class="stat-label">Net sales</div><div class="stat-value">${money(c.sales)}</div><div class="stat-sub">vs. prior period ${wowBadge}</div></div>
      <div class="stat ${band(c.laborPct, 30, 40)}"><div class="stat-label">Labor %</div><div class="stat-value">${pct(c.laborPct)}</div><div class="stat-sub">${money(c.labor)} in wages</div></div>
      <div class="stat ${band(c.foodPct, 32, 40)}"><div class="stat-label">Food cost %</div><div class="stat-value">${pct(c.foodPct)}</div><div class="stat-sub">${money(c.cogs)} purchased</div></div>
      <div class="stat ${band(c.primePct, 60, 70)}"><div class="stat-label">Prime cost %</div><div class="stat-value">${pct(c.primePct)}</div><div class="stat-sub">${money(c.prime)} (labor + goods)</div></div>
    </div>
    <div class="table-wrap"><table class="table">
      <tbody>
        <tr><td>Net sales</td><td class="num">${money(c.sales)}</td></tr>
        <tr><td>Labor cost (wages)</td><td class="num">${money(c.labor)}</td></tr>
        <tr><td>Cost of goods (invoices)</td><td class="num">${money(c.cogs)}</td></tr>
        <tr><td><b>Prime cost</b> (labor + goods)</td><td class="num"><b>${money(c.prime)}</b></td></tr>
      </tbody>
    </table></div>
    <p class="sub">Rules of thumb: labor under ~30%, food cost under ~32%, prime cost under ~60% is healthy — amber/red tiles flag when a number runs high. Food cost % only counts invoices you've logged, so keep them current.</p>`));
});

// ---------------------------------------------------------------------------
// Cash reconciliation — count the drawer each shift, flag over/short
// ---------------------------------------------------------------------------
app.get('/cash', (req, res) => {
  const list = cashQ.list.all();
  let netOS = 0, shortCount = 0;
  const rows = list.map((r) => {
    const expected = r.float_cents + r.cash_sales_cents - r.paid_out_cents;
    const os = r.counted_cents - expected;
    netOS += os; if (os < 0) shortCount++;
    const badge = os === 0 ? '<span class="pill pill-ok">exact</span>'
      : os > 0 ? `<span class="pill pill-yellow">+${money(os)} over</span>`
        : `<span class="pill pill-red">${money(-os)} short</span>`;
    return `<tr${os < 0 ? ' class="row-warn"' : ''}>
      <td>${r.date}</td><td>${dp(r.daypart)}</td>
      <td class="num">${money(expected)}</td>
      <td class="num">${money(r.counted_cents)}</td>
      <td>${badge}</td>
      <td>${esc(r.closed_by) || '<span class="muted">—</span>'}</td>
      <td><form method="post" action="/cash/${r.id}/delete" onsubmit="return confirm('Delete this count?')" style="margin:0"><button class="link-danger">delete</button></form></td>
    </tr>`;
  }).join('');
  const netCls = netOS < 0 ? 'neg' : netOS > 0 ? '' : 'pos';
  res.send(layout('Cash reconciliation', `
    ${flash(req)}
    <div class="page-head"><div><h1>💵 Cash reconciliation</h1>
      <p class="sub">Count the drawer each shift. Over/short is where variance — and theft — shows up.</p></div>
      <a class="btn btn-primary" href="#add">＋ Add count</a></div>
    ${list.length ? `<div class="stats">
      <div class="stat"><div class="stat-label">Counts logged</div><div class="stat-value">${list.length}</div></div>
      <div class="stat ${shortCount ? 'stat-bad' : 'stat-ok'}"><div class="stat-label">Shorts</div><div class="stat-value">${shortCount}</div><div class="stat-sub">drawers came up short</div></div>
      <div class="stat"><div class="stat-label">Net over / short</div><div class="stat-value ${netCls}">${netOS < 0 ? '-' : ''}${money(Math.abs(netOS))}</div></div>
    </div>` : ''}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Service</th><th class="num">Expected</th><th class="num">Counted</th><th>Over / short</th><th>Closed by</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">No counts yet — add one below.</td></tr>'}</tbody>
    </table></div>
    <h2 id="add">Add a count</h2>
    <form method="post" action="/cash" class="card form grid">
      <label>Date <input type="date" name="date" required></label>
      <label>Service <select name="daypart">${DAYPARTS.map((d) => `<option value="${d}">${dp(d)}</option>`).join('')}</select></label>
      <label>Starting float <input name="float" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Cash sales <input name="cash_sales" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Cash paid out <input name="paid_out" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Counted in drawer <input name="counted" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Closed by <input name="closed_by" placeholder="who counted"></label>
      <label class="wide">Note <input name="note" placeholder="optional"></label>
      <button class="btn btn-primary" type="submit">Save count</button>
    </form>
    <p class="sub">Over / short = counted − (float + cash sales − paid out).</p>`));
});

app.post('/cash', (req, res) => {
  if (!req.body.date) return res.redirect('/cash?err=1&msg=' + encodeURIComponent('Pick a date.'));
  cashQ.insert.run({
    date: req.body.date, daypart: DAYPARTS.includes(req.body.daypart) ? req.body.daypart : 'dinner',
    float_cents: toCents(req.body.float), cash_sales_cents: toCents(req.body.cash_sales),
    paid_out_cents: toCents(req.body.paid_out), counted_cents: toCents(req.body.counted),
    closed_by: (req.body.closed_by || '').trim() || null, note: (req.body.note || '').trim() || null,
  });
  res.redirect('/cash?msg=' + encodeURIComponent('Count saved.'));
});

app.post('/cash/:id/delete', (req, res) => {
  cashQ.del.run(req.params.id);
  res.redirect('/cash?msg=' + encodeURIComponent('Deleted.'));
});

// ---------------------------------------------------------------------------
// Tip-out policy — calm read-only view + rule builder, versioned with history
// ---------------------------------------------------------------------------
const RLBL = { kitchen: 'Kitchen', barista: 'Barista', bartender: 'Bartender', busser: 'Busser' };
const BLBL = { food: "each server's food sales", coffee: "each server's coffee sales", alcohol: "each server's alcohol sales", total_tips: "each server's total tips", remaining: 'server tips left after other tip-outs' };
const SLBL = { hours: 'by hours worked', even: 'evenly', sales: 'by sales' };
const SRC = { jar: 'the cash tip jar', togo_card: 'to-go card tips', jar_togo: 'the cash jar + to-go card' };
const AMG = { all_support: 'all support (kitchen, busser, barista)', kitchen: 'kitchen only', foh: 'busser + barista' };
const PAY = { weekly_cash: 'weekly, in cash', paycheck: 'on the paycheck', nightly_cash: 'nightly, in cash' };

function describeRules(rules) {
  const items = ['Servers keep their own tips.'];
  for (const r of rules) {
    if (r.type === 'tipout') items.push(`<b>${RLBL[r.recipient] || r.recipient}</b> gets <b>${r.percent}%</b> of ${BLBL[r.base] || r.base}, split <b>${SLBL[r.split] || r.split}</b>.`);
    else items.push(`<b>${SRC[r.source] || r.source}</b> is pooled and split <b>${SLBL[r.split] || r.split}</b> among <b>${AMG[r.among] || r.among}</b>, paid <b>${PAY[r.payout] || r.payout}</b>.`);
  }
  return items;
}

app.get('/policy', (req, res) => {
  const daypart = DAYPARTS.includes(req.query.daypart) ? req.query.daypart : 'dinner';
  const cur = currentForDaypart(daypart);
  const rules = cur ? cur.rules : defaultRules();
  const hist = historyForDaypart(daypart);

  const tabs = DAYPARTS.map((d) => `<a href="/policy?daypart=${d}" class="tab ${d === daypart ? 'active' : ''}">${dp(d)}</a>`).join('');
  const summary = describeRules(rules).map((x) => `<li>${x}</li>`).join('');

  const histRows = hist.map((h, i) => `
    <tr${i === 0 ? ' class="row-current"' : ''}>
      <td>${esc(h.effective_from)}${i === 0 ? ' <span class="pill pill-ok">current</span>' : ''}</td>
      <td>${esc(h.note) || '<span class="muted">—</span>'}</td>
      <td>${i === 0 ? '' : `<form method="post" action="/policy/revert" onsubmit="return confirm('Make this the current policy? It applies to future shifts only.')"><input type="hidden" name="id" value="${h.id}"><button class="link-btn">revert to this</button></form>`}</td>
    </tr>`).join('');

  res.send(layout('Tip-out policy', `
    ${flash(req)}
    <div class="page-head"><div><h1>Tip-out policy</h1>
      <p class="sub">How tips are shared. Editing applies only to shifts created <b>after</b> you save — past shifts never change, and you can revert anytime.</p></div></div>
    <div class="tabs-row">${tabs}</div>

    <div id="view-read">
      <div class="card summary-card">
        <div class="summary-head"><h2>${dp(daypart)} — how tips are shared</h2><button class="btn" id="edit-btn">Edit policy</button></div>
        <ol class="plain-list">${summary}</ol>
      </div>
    </div>

    <div id="view-edit" style="display:none">
      <form method="post" action="/policy/save" id="policy-form">
        <input type="hidden" name="daypart" value="${daypart}">
        <input type="hidden" name="rules_json" id="rules_json">
        <div id="builder-rules"></div>
        <div class="add-rule-btns">
          <button type="button" class="btn" id="add-tipout">＋ Add tip-out rule</button>
          <button type="button" class="btn" id="add-pool">＋ Add shared pool</button>
        </div>
        <div class="card summary-card"><h3 class="hist-title">In plain English</h3><ol class="plain-list" id="live-summary"></ol></div>
        <label class="wide" style="display:block;margin:14px 0;font-size:13px;color:var(--muted);font-weight:600">Note (why the change?) <input name="note" placeholder="optional" style="display:block;width:100%;margin-top:5px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:15px"></label>
        <div class="send-bar">
          <button class="btn btn-primary" type="submit">Save policy</button>
          <button class="btn" type="button" id="cancel-btn">Cancel</button>
          <span class="sub">Saves as a new version. Past shifts are untouched.</span>
        </div>
      </form>
    </div>

    <h2>History</h2>
    <div class="table-wrap"><table class="table small">
      <thead><tr><th>Effective from</th><th>Note</th><th></th></tr></thead>
      <tbody>${histRows}</tbody>
    </table></div>

    <script>window.POLICY_RULES = ${JSON.stringify(rules)};</script>
    <script src="/static/policy-builder.js"></script>`));
});

app.post('/policy/save', (req, res) => {
  const { daypart } = req.body;
  if (!DAYPARTS.includes(daypart)) return res.redirect('/policy?err=1&msg=' + encodeURIComponent('Bad daypart.'));
  let rules;
  try { rules = JSON.parse(req.body.rules_json); } catch { rules = null; }
  if (!Array.isArray(rules) || !rules.length) return res.redirect(`/policy?daypart=${daypart}&err=1&msg=` + encodeURIComponent('Add at least one rule.'));
  saveRules(daypart, rules, req.body.note);
  res.redirect(`/policy?daypart=${daypart}&msg=` + encodeURIComponent(`New ${dp(daypart)} policy saved — applies to shifts from now on.`));
});

app.post('/policy/revert', (req, res) => {
  const { byId } = require('./policy');
  const row = byId(Number(req.body.id));
  revertTo(Number(req.body.id));
  res.redirect(`/policy?daypart=${row ? row.daypart : 'dinner'}&msg=` + encodeURIComponent('Reverted — this is now the current policy for new shifts.'));
});

// ---------------------------------------------------------------------------
// Benugin webhook — POS pushes end-of-batch data here
// ---------------------------------------------------------------------------
app.post('/webhook/benugin', (req, res) => {
  const secret = req.get('x-webhook-secret');
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'bad or missing secret' });
  }
  const { date, daypart, servers } = req.body || {};
  if (!date || !DAYPARTS.includes(daypart) || !Array.isArray(servers)) {
    return res.status(400).json({ ok: false, error: 'need { date, daypart: cafe|dinner, servers: [...] }' });
  }
  s.getOrIgnore.run(date, daypart);
  const sh = s.findShift.get(date, daypart);

  const matched = [];
  const unmatched = [];
  for (const row of servers) {
    // Match by Benugin id first, then by exact name.
    let emp = row.pos_id ? q.employeeByPosId.get(String(row.pos_id)) : null;
    if (!emp && row.name) emp = q.allEmployees.all().find((e) => e.name.toLowerCase() === String(row.name).toLowerCase());
    if (!emp) { unmatched.push(row.name || row.pos_id || 'unknown'); continue; }

    // Register the server on the shift; only set hours if the POS actually sent them.
    w.insertWorkIfAbsent.run({ shift_id: sh.id, employee_id: emp.id, role: 'server' });
    if (row.hours != null && Number(row.hours) > 0) {
      w.setHours.run({ shift_id: sh.id, employee_id: emp.id, hours: Number(row.hours) });
    }
    w.upsertSales.run({
      shift_id: sh.id, employee_id: emp.id,
      food_cents: toCents(row.food), coffee_cents: toCents(row.coffee),
      alcohol_cents: toCents(row.alcohol), card_tips_cents: toCents(row.card_tips),
    });
    if (row.cash_tips != null) {
      w.setCashTips.run({ shift_id: sh.id, employee_id: emp.id, cash_tips_cents: toCents(row.cash_tips), by: 'pos' });
    }
    matched.push(emp.name);
  }
  res.json({ ok: true, shift_id: sh.id, matched, unmatched });
});

// Mount all the collection modules (expirations, invoices, vendors, contacts,
// equipment, incident log, notes/decisions log).
mountModules(app);

app.listen(PORT, () => {
  console.log(`\n  ${RESTAURANT} ops running →  http://localhost:${PORT}\n`);
  if (!process.env.GMAIL_USER && !process.env.SMTP_HOST) {
    console.log('  Email: PREVIEW MODE (no mail configured). "Send" writes files to /previews.\n');
  }
});

module.exports = app;
