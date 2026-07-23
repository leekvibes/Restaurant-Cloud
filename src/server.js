'use strict';

// Load .env if present (Node 20.6+ has this built in — no dependency needed).
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* no .env, fine */ }

const path = require('path');
const fs = require('fs');
const express = require('express');
const { db, q, s, w, users, submissions, positions, kindOf, supportSlugs, shiftInputs } = require('./db');
const { runShift } = require('./engine');
const { buildEmails, buildPeriodEmails, managerShiftEmail, sendEmails, sendTest, mailStatus } = require('./email');
const { fmt, toCents } = require('./money');
const { layout, flash, esc, money, dp, RESTAURANT, BUILD, icon, setViewContext, canWrite, navAllowed } = require('./views');
const { mountModules, MODULES, pagesOf } = require('./modules');
const { policyForShift, currentForDaypart, historyForDaypart, saveRules, revertTo } = require('./policy');
const { defaultRules } = require('./engine');
const { aggregatePayroll, buildWorkbook, aggregateCosts, shiftTotalSales, WAGE_RATE_SQL } = require('./reports');
const { readReport, readInvoice, readDocument, readExpense } = require('./reader');
const { isoDate, startOfToday, addDays } = require('./dates');
const MX = require('./metrics');
const CH = require('./charts');
// Required here, not down beside the Products routes, because this module
// migrates the schema — it adds m_invoices.ai_lines, which invQ.add names in
// its INSERT. A prepared statement is compiled the moment it is created, so
// requiring it late meant the app booted fine on a database that already had
// the column and died on startup on one that didn't. Which is every fresh
// deploy. test/boot.test.js now covers exactly this.
const { q: prodQ, CATEGORIES: PROD_CATS, trendOf, reviewRows,
  learnAlias, mergeProducts, likelyDuplicates, groupRows, nearMisses, pendingCount, aliasIndex } = require('./products');
// Same reason as products above: cash.js creates cash_recon and adds its
// columns, and the dashboard alert below reads them.
const CASH = require('./cash');
const { currentPeriod, recentPeriods, labelFor, isPeriod, sendRecord, markSent, anchor, setSetting,
  skipRecord, markSkipped, unskipPeriod } = require('./periods');
const multer = require('multer');
const reportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// COMPRESSION
//
// Nothing was compressed. A year of the invoice ledger is 640KB of HTML, and
// the two stylesheets are another 290KB on top of it — approaching a megabyte
// of text on a first load, sent verbatim. Gzipped it is about 90KB. That is
// the single largest thing standing between this app and a phone on a café's
// wifi, and it costs nothing but a few milliseconds of CPU.
//
// Deliberately not the `compression` package, and deliberately not a stream
// wrapper. zlib is already in the stack, and the general middleware has to
// intercept res.write/res.end to handle streaming — which is exactly where its
// edge cases live (HEAD, 304, early errors, headers already flushed). This app
// answers every page with a single res.send of a complete string, so the whole
// problem collapses to "gzip a string before it goes out", which can be got
// right by reading it.
//
// Uploads are untouched: they are served by express.static below, never
// through res.send, and a JPEG or a PDF is already compressed.
const zlib = require('zlib');
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|manifest))/i;
const GZIP_FLOOR = 1024;          // below this the header costs more than it saves

app.use((req, res, next) => {
  if (!/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) return next();
  const send = res.send.bind(res);
  res.send = (body) => {
    // Only complete strings. Buffers and streams take the untouched path.
    if (typeof body !== 'string' || body.length < GZIP_FLOOR) return send(body);
    if (res.getHeader('Content-Encoding')) return send(body);
    // res.send sets Content-Type itself when nothing has set it — and for a
    // string that default is HTML. It has to be pinned down BEFORE the body
    // becomes a Buffer, because res.send's default for a Buffer is
    // application/octet-stream, and a page sent as that is a page the browser
    // downloads instead of rendering. res.json sets the header first, so its
    // own type is already here and is kept.
    const type = String(res.getHeader('Content-Type') || 'text/html; charset=utf-8');
    if (!COMPRESSIBLE.test(type)) return send(body);

    // Async, so a 600KB page does not block the event loop while it deflates.
    zlib.gzip(body, { level: 6 }, (err, buf) => {
      if (err || res.headersSent) return send(body);   // any doubt: send it plain
      res.setHeader('Content-Type', type);             // or the Buffer default wins
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');              // express sets it from the buffer
      send(buf);
    });
    return res;
  };
  next();
});

// The stylesheets never change between restarts, so they are gzipped once at
// boot rather than on every request. Everything else in public/ — icons, the
// fonts — is already compressed and is served untouched below.
const STATIC_GZ = new Map();
try {
  for (const f of fs.readdirSync(PUBLIC_DIR)) {
    if (!/\.(css|js|webmanifest)$/i.test(f)) continue;
    const raw = fs.readFileSync(path.join(PUBLIC_DIR, f));
    if (raw.length < GZIP_FLOOR) continue;
    STATIC_GZ.set(f, zlib.gzipSync(raw, { level: 9 }));
  }
} catch (e) { console.error('[static] pre-compression skipped:', e.message); }

app.use('/static', (req, res, next) => {
  const name = req.path.replace(/^\//, '');
  const buf = STATIC_GZ.get(name);
  if (!buf || !/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) return next();
  res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css; charset=utf-8'
    : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/manifest+json');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  // Same caching the static handler would have applied — these are already
  // cache-busted by the ?v= stamp in every URL the app writes.
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(buf);
});
app.use('/static', express.static(PUBLIC_DIR));
// PWA files must be served from the site root so the service worker's scope
// covers the whole app (a /static/sw.js could only control /static/*).
for (const f of ['sw.js', 'manifest.webmanifest', 'manifest-tips.webmanifest', 'apple-touch-icon.png']) {
  app.get('/' + f, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, f)));
}

const PORT = Number(process.env.PORT || 4000);
const DAYPARTS = ['cafe', 'dinner'];
// Positions are data now (see the positions table), so these read live rather
// than being a fixed list — adding a job in Settings shows up everywhere.
/** Everything someone can be put on a shift as, servers aside. */
const shiftRoles = () => positions.active.all().filter((p) => p.kind !== 'server').map((p) => p.slug);
/** Every job, for the staff "main role" picker. */
const allRoles = () => positions.active.all().map((p) => p.slug);
const posName = (slug) => (positions.bySlug.get(slug) || {}).name || slug;

// ---------------------------------------------------------------------------
// Auth — one shared manager password. Staff pages (/tips) stay open, since
// staff authenticate with their own name + PIN. Stateless signed cookie, so a
// redeploy doesn't sign you out and there's no session store to run.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || APP_PASSWORD || 'insecure-dev-secret';
const COOKIE = 'rc_auth';
const THIRTY_DAYS = 30 * 86400000;

const sign = (v) => crypto.createHmac('sha256', SECRET).update(String(v)).digest('hex').slice(0, 32);

// --- passwords: scrypt, which ships with Node — no dependency to add -------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const want = Buffer.from(keyHex, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(got, want);
}

/** The master owner password, compared in constant time. */
function checkPassword(input) {
  if (!APP_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// --- session token ---------------------------------------------------------
// Carries WHO, so the app can tell accounts apart. `m` is the master session
// from APP_PASSWORD, kept so you can never lock yourself out of your own app.
const makeToken = (uid) => {
  const exp = Date.now() + THIRTY_DAYS;
  return `${uid}.${exp}.${sign(`${uid}.${exp}`)}`;
};
function readToken(t) {
  const [uid, exp, sig] = String(t || '').split('.');
  if (!uid || !exp || sig !== sign(`${uid}.${exp}`)) return null;
  if (Number(exp) < Date.now()) return null;
  return uid;
}
const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
};

// --- what an account can reach --------------------------------------------
// Page-level, deliberately. Finer rules (edit shifts but not delete, see
// payroll totals but not individual wages) get impossible to hold in your head,
// and access control you can't state plainly is access control you can't trust.
// Areas come from src/nav.js, which the sidebar reads too — one list, so a
// module cannot appear in navigation without also being gated.
const { AREAS, areaFor: featureFor, CREATE_ACTIONS, SETTINGS_GROUPS } = require('./nav');
const FEATURES = AREAS;
const MASTER = { id: 'm', name: 'Owner', role: 'editor', features: [], master: true };

/** Whether the current request's account may open a path. Mirrors the sidebar. */
function navAllowedFor(href) {
  const store = reqCtx.getStore();
  const u = store && store.user;
  if (!u || u.master || !u.features || !u.features.length) return true;
  const key = featureFor(href);
  return !key || u.features.includes(key);
}

function currentUser(req) {
  const uid = readToken(readCookie(req, COOKIE));
  if (!uid) return null;
  if (uid === 'm') return MASTER;
  const row = users.byId.get(Number(uid));
  // Checked every request, so deactivating someone signs them out on their
  // next click rather than whenever a 30-day cookie happens to lapse.
  if (!row || !row.active) return null;
  return {
    id: row.id, name: row.name, email: row.email, role: row.role,
    features: row.features ? row.features.split(',').filter(Boolean) : [],
    master: false,
  };
}
const canSee = (user, key) => !user ? false : (user.master || !user.features.length || !key || user.features.includes(key));

// Nav and page rendering need the current user without threading it through
// every layout() call. AsyncLocalStorage keeps it correct across awaits.
const reqCtx = new AsyncLocalStorage();
setViewContext(reqCtx);

const OPEN_PATHS = [/^\/login$/, /^\/logout$/, /^\/tips(\/|$)/, /^\/version$/,
  /^\/static\//, /^\/sw\.js$/, /^\/manifest/, /^\/apple-touch-icon\.png$/, /^\/webhook\//];

app.use((req, res, next) => {
  const user = currentUser(req);
  req.user = user;
  // The path rides along so the nav can mark itself active without every
  // route remembering to pass it down.
  reqCtx.run({ user, path: req.path }, () => {
    if (!APP_PASSWORD) return next();                               // not configured → open (banner warns)
    if (OPEN_PATHS.some((re) => re.test(req.path))) return next();
    if (!user) {
      if (req.method === 'GET') return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
      return res.status(401).send('Session expired — reload and sign in again.');
    }
    // View-only accounts can open anything they're allowed to see, and change
    // none of it. Blocking at the verb is what makes that actually true.
    if (user.role === 'viewer' && req.method !== 'GET') {
      return res.status(403).send('Your account is view-only.');
    }
    const key = featureFor(req.path);
    if (!canSee(user, key)) {
      if (req.method === 'GET') return res.status(403).send(layout('Not available', `
        <div class="empty2"><div class="empty2-t">You don't have access to this area</div>
        <div class="empty2-s">Ask ${esc(RESTAURANT)} to turn it on for your account.</div>
        <a class="btn btn-primary" href="/">Back to the dashboard</a></div>`));
      return res.status(403).send('Not available on your account.');
    }
    if (!user.master) users.seen.run(user.id);
    next();
  });
});

app.get('/login', (req, res) => {
  if (!APP_PASSWORD) return res.redirect('/');
  const bad = req.query.bad === '1';
  // The last screen on the old look — a white card with a 20px radius and a
  // drop shadow, floating on solid blue. Rebuilt on the staff portal's shell,
  // which is the right reference: both are one centred column, one task, often
  // on a phone. The submit sits outside the <form> and reaches it by id, so it
  // can live in the sticky footer the way the report's does.
  res.send(layout('Sign in', `
    <div class="tp">
      <div class="tp-top">
        <span class="tp-mark">${esc(markOf(RESTAURANT))}</span>
        <div class="tp-who">
          <div class="tp-brand">${esc(RESTAURANT)}</div>
          <div class="tp-name">Back office</div>
        </div>
      </div>

      <div class="tp-body">
        <h1 class="tp-h">Sign in.</h1>
        <p class="tp-lead">Staff logging tips don't need this &mdash; they use the tips link.</p>
        ${bad ? '<div class="tp-err">That email and password don\'t match. Try again.</div>' : ''}

        <form method="post" action="/login" id="signin">
          <input type="hidden" name="next" value="${esc(req.query.next || '/')}">
          <div class="tp-field">
            <label class="tp-label" for="li-email">Email</label>
            <input class="tp-in" id="li-email" name="email" type="email"
              autocomplete="username" autofocus placeholder="you@restaurant.com">
            <p class="tp-help">Leave blank if you sign in with the owner password.</p>
          </div>
          <div class="tp-field">
            <label class="tp-label" for="li-pass">Password</label>
            <input class="tp-in" id="li-pass" name="password" type="password"
              autocomplete="current-password" required>
          </div>
        </form>
      </div>

      <div class="tp-foot">
        <button class="tp-go" type="submit" form="signin">Sign in &rarr;</button>
      </div>
      <div class="tp-build">${esc(RESTAURANT)} &middot; v${esc(BUILD)}</div>
    </div>`, { bare: true }));
});

app.post('/login', (req, res) => {
  const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '/';
  const fail = () => res.redirect('/login?bad=1&next=' + encodeURIComponent(next));
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');

  let uid = null;
  if (email) {
    const u = users.byEmail.get(email);
    // Hash regardless of whether the account exists, so a wrong email and a
    // wrong password take the same time and can't be told apart.
    const ok = verifyPassword(password, u ? u.pass_hash : hashPassword('no-such-account'));
    if (u && u.active && ok) uid = String(u.id);
  } else if (checkPassword(password)) {
    uid = 'm';
  }
  if (!uid) return fail();

  const https = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(uid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${THIRTY_DAYS / 1000}${https ? '; Secure' : ''}`);
  res.redirect(next);
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Everything about a shift that the dashboard and the shifts list both need,
// as correlated subqueries rather than a per-shift engine run. The engine
// costs ~1ms a shift; these pages read many shifts at once, so at a few
// hundred that difference is the page feeling instant or visibly stalling.
// One definition, so the two pages can never disagree about what a shift did.
// ---------------------------------------------------------------------------
const SHIFT_ROLLUP_COLS = `
    (SELECT COALESCE(SUM(w.hours), 0) FROM work w WHERE w.shift_id = sh.id) AS hours,
    (SELECT COUNT(*) FROM work w WHERE w.shift_id = sh.id) AS people,
    (SELECT COUNT(*) FROM work w WHERE w.shift_id = sh.id AND (w.hours IS NULL OR w.hours = 0)) AS no_hours,
    (SELECT COALESCE(SUM(ss.food_cents + ss.coffee_cents + ss.alcohol_cents), 0)
       FROM server_sales ss WHERE ss.shift_id = sh.id) AS server_sales,
    (SELECT COALESCE(SUM(ss.card_tips_cents + ss.cash_tips_cents), 0)
       FROM server_sales ss WHERE ss.shift_id = sh.id) AS tips,
    (SELECT COUNT(*) FROM server_sales ss WHERE ss.shift_id = sh.id
       AND ss.note IS NOT NULL AND TRIM(ss.note) <> '') AS notes,
    (SELECT COUNT(*) FROM tip_submissions ts WHERE ts.shift_id = sh.id) AS subs,
    -- People, not submissions: someone correcting a mistake submits twice, and
    -- "6 of 5 submitted" would be nonsense on the progress bar.
    (SELECT COUNT(DISTINCT ts.employee_id) FROM tip_submissions ts WHERE ts.shift_id = sh.id) AS submitters,
    -- Wage cost: hours x rate, summed. This has to resolve the wage exactly
    -- the way shiftInputs() does — per-shift override, then the wage set for
    -- THAT role, then the employee's default — because someone covering a
    -- second position is paid their rate for that position, not their usual
    -- one. Salaried people are left out: their pay doesn't move with the
    -- shift, so folding it in would make a quiet Tuesday look as expensive
    -- as a full Saturday. test/engine.test.js pins this to shiftInputs.
    (SELECT COALESCE(ROUND(SUM(w.hours * ${WAGE_RATE_SQL})), 0)
       FROM work w JOIN employees e ON e.id = w.employee_id
       LEFT JOIN employee_roles er ON er.employee_id = w.employee_id AND er.role = w.role
      WHERE w.shift_id = sh.id AND COALESCE(e.pay_type, 'hourly') <> 'salary') AS wage_cents,
    -- Anyone who worked hours with no wage on file: they cost real money the
    -- figure above can't see, so the card says when it's short.
    (SELECT COUNT(*) FROM work w JOIN employees e ON e.id = w.employee_id
       LEFT JOIN employee_roles er ON er.employee_id = w.employee_id AND er.role = w.role
      WHERE w.shift_id = sh.id AND w.hours > 0
        AND COALESCE(e.pay_type, 'hourly') <> 'salary'
        AND ${WAGE_RATE_SQL} = 0) AS no_wage`;

// ---------------------------------------------------------------------------
// DASHBOARD — the command centre. It answers one question: what do I need to
// know before I start running the restaurant today?
//
// Deliberately NOT a copy of every other page. Anything here is either about
// today, waiting on a decision, or one tap from the next action. Trend
// analysis lives on Performance and Shifts, which is why the 14-day sales chart
// that used to sit at the top is gone — it was the thing people looked at
// least and it pushed the open shift below the fold.
// ---------------------------------------------------------------------------

/** "Good morning" / "Good afternoon" / "Good evening", by local clock. */
function greeting(now) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const DASH_DATE = { weekday: 'long', month: 'long', day: 'numeric' };
/** "18m ago", "3h ago", "Tuesday" — activity feeds read worse with timestamps. */
function ago(iso, now) {
  if (!iso) return '';
  // SQLite datetime('now') is UTC without a zone marker; Date would read it as
  // local and every entry would look hours off.
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(t)) return '';
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round(mins / 1440);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const dashQ = {
  onDate: db.prepare(`SELECT sh.*, ${SHIFT_ROLLUP_COLS} FROM shifts sh WHERE sh.date = ? ORDER BY sh.daypart`),
  recent: db.prepare(`SELECT sh.*, ${SHIFT_ROLLUP_COLS} FROM shifts sh ORDER BY sh.date DESC, sh.daypart DESC LIMIT ?`),
  staffToday: db.prepare(`SELECT COUNT(DISTINCT w.employee_id) n FROM work w
    JOIN shifts sh ON sh.id = w.shift_id WHERE sh.date = ?`),
  // Only an unpaid invoice can be overdue, and the unpaid pile stays small
  // however many years of paid ones pile up behind it.
  openInvoices: db.prepare("SELECT * FROM m_invoices WHERE status <> 'Paid' ORDER BY due_date"),
  // Dated trackers are asked for one table at a time rather than through
  // expiringSoon(), which folds three modules into one list and returns no id
  // — so its rows can't be linked to the thing they're about.
  expiring: db.prepare(`SELECT id, name, expires_on AS due FROM m_expirations
    WHERE expires_on IS NOT NULL ORDER BY expires_on LIMIT 40`),
  warranties: db.prepare(`SELECT id, name, warranty_expires AS due FROM m_equipment
    WHERE warranty_expires IS NOT NULL ORDER BY warranty_expires LIMIT 40`),
  // An invoice whose lines were read but never imported. The read is the
  // cheap half; the products only move when somebody confirms the matches,
  // so an invoice sitting here is cost data the app has and isn't using.
  unimported: db.prepare(`SELECT id, invoice_number, amount_cents FROM m_invoices
    WHERE ai_lines IS NOT NULL AND ai_lines <> '' AND ai_lines <> '[]'
      AND COALESCE(lines_imported, 0) = 0 ORDER BY invoice_date DESC LIMIT 20`),
};

/** The whole activity feed in one query, newest first. */
const ACTIVITY_SQL = `
  SELECT * FROM (
    SELECT 'shift'   AS kind, ts.created_at AS at, e.name AS who,
           sh.daypart AS what, ts.shift_id AS ref
      FROM tip_submissions ts
      LEFT JOIN employees e ON e.id = ts.employee_id
      LEFT JOIN shifts sh ON sh.id = ts.shift_id
    UNION ALL
    -- Compared as numbers: vendor_id is a TEXT column that has held values
    -- like "1.0", so a string comparison against m_vendors.id silently
    -- matches nothing and every invoice reads as "A vendor".
    SELECT 'invoice', i.created_at, COALESCE(v.name, 'A vendor'), i.invoice_number, i.id
      FROM m_invoices i LEFT JOIN m_vendors v ON CAST(v.id AS REAL) = CAST(i.vendor_id AS REAL)
    UNION ALL SELECT 'vendor',    created_at, name, category,    id FROM m_vendors
    UNION ALL SELECT 'incident',  created_at, logged_by, type,   id FROM m_incidents
    UNION ALL SELECT 'note',      created_at, NULL, title,       id FROM m_notes
    UNION ALL SELECT 'cash',      created_at, closed_by, daypart, id FROM cash_recon
    UNION ALL SELECT 'payroll',   sent_at,    NULL, period_start, NULL FROM period_sends
  ) WHERE at IS NOT NULL ORDER BY at DESC LIMIT ?`;
const activityFeed = db.prepare(ACTIVITY_SQL);

// ---------------------------------------------------------------------------
// DASHBOARD — the page every account opens on.
//
// It answers four questions, in this order, and nothing is on the page that
// doesn't serve one of them:
//
//   1. What needs my attention?      Needs attention, grouped by severity.
//   2. How is the business doing?    The snapshot band and the charts.
//   3. What changed?                 Recent services, recent activity.
//   4. What should I do next?        Today, Upcoming, Quick actions.
//
// Two rules the figures follow:
//
//   Today is not a measurement. A shift that is halfway through has half its
//   sales and none of its tips, so the headline numbers use COMPLETED shifts
//   over a trailing window. Today gets its own strip, where "in progress" is
//   the point rather than a distortion.
//
//   A percentage of nothing is withheld, not printed as zero. With no
//   invoices logged, food cost isn't 0% — it's unknown, and printing 0% reads
//   as extraordinarily good news.
//
// Everything comes from metrics.js, which Performance and Sales also use, so
// the three pages cannot disagree about what a week sold.
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  const now = new Date();
  const today = startOfToday();
  const toStr = isoDate(today);
  const from7 = addDays(toStr, -6);
  const from30 = addDays(toStr, -29);
  const from56 = addDays(toStr, -55);

  // What this account is allowed to see, so the dashboard never offers a
  // shortcut to a page that answers with 403.
  const me = currentUser(req);
  const may = (key) => !me || me.master || !me.features || !me.features.length || me.features.includes(key);
  const canWrite = !me || me.role !== 'viewer';
  // Two different permissions, deliberately not one. Shift takings and what
  // a service costs in wages belong to whoever runs the floor; what the food
  // costs and what the business keeps is the costs area. Lumping them into
  // one "can see money" flag handed a shift supervisor the P&L.
  const seeShifts = may('shifts') || may('sales');
  const seeCosts = may('costs');

  // --- the numbers ---------------------------------------------------------
  const p7 = seeShifts || seeCosts ? MX.period(from7, toStr) : null;
  const prev7 = seeShifts || seeCosts ? MX.previous(from7, toStr) : null;
  const p30 = seeShifts ? MX.period(from30, toStr) : null;
  const daily = seeShifts ? MX.days(from30, toStr) : [];
  // Eight weeks of history is what the sparklines are drawn from. One pass
  // over the days, bucketed here, rather than eight period() calls.
  const weekly = [];
  if (seeShifts || seeCosts) {
    const invByWeek = new Map(MX.invoiceWeeks(from56, toStr).map((w) => [w.week, w.cents]));
    const byWeek = new Map();
    for (const d of MX.days(from56, toStr)) {
      const dow = (new Date(d.date + 'T00:00:00').getDay() + 6) % 7;   // Monday = 0
      const wk = addDays(d.date, -dow);
      const b = byWeek.get(wk) || { week: wk, sales: 0, wages: 0, hours: 0 };
      b.sales += d.sales; b.wages += d.wages; b.hours += d.hours;
      byWeek.set(wk, b);
    }
    for (const b of [...byWeek.values()].sort((a, x) => a.week.localeCompare(x.week))) {
      const cogs = invByWeek.get(b.week) || 0;
      weekly.push({
        ...b, cogs,
        laborPct: b.sales > 0 ? (b.wages / b.sales) * 100 : null,
        foodPct: b.sales > 0 && cogs > 0 ? (cogs / b.sales) * 100 : null,
        primePct: b.sales > 0 && cogs > 0 ? ((b.wages + cogs) / b.sales) * 100 : null,
        profit: b.sales - b.wages - cogs,
      });
    }
  }
  const sparkOf = (f) => weekly.map(f).filter((v) => Number.isFinite(v));

  // --- today ---------------------------------------------------------------
  const todays = may('shifts') ? dashQ.onDate.all(toStr) : [];
  const openToday = todays.filter((x) => x.status !== 'emailed');
  const todaySales = todays.reduce((a, x) => a + shiftSales(x), 0);

  // --- needs attention -----------------------------------------------------
  // Every entry names the specific thing and links to it. A count with no
  // route attached is a nag, not a to-do.
  const attn = [];
  const push = (tone, ico, title, sub, href) => attn.push({ tone, ico, title, sub, href });
  // Things that haven't happened yet. Separate from attention on purpose: a
  // deadline on Friday is not a problem, and mixing the two turns the
  // attention list into a list you stop reading.
  const soon = [];
  const due = (ico, title, sub, href) => soon.push({ ico, title, sub, href });

  /** "Jul 19 Dinner" — an ISO date in a to-do list reads like a serial number. */
  if (may('shifts')) {
    for (const x of dashQ.recent.all(30)) {
      if (x.status === 'emailed' || x.date === toStr) continue;
      const when = whenOf(x.date, x.daypart);
      if (x.no_hours) push('red', 'shifts', `${when} — hours missing`,
        `${x.no_hours} ${x.no_hours === 1 ? 'person has' : 'people have'} no hours entered`, `/shifts/${x.id}`);
      else if (x.people) push('blue', 'shifts', `${when} — ready to send`, 'Everything is in; staff are waiting on it', `/shifts/${x.id}`);
      if (x.notes) push('blue', 'notes', `${when} — ${x.notes === 1 ? 'a note' : x.notes + ' notes'} from staff`, 'Read it before you close the shift', `/shifts/${x.id}`);
    }
  }

  if (may('trackers')) {
    for (const r of recurQ.all.all()) {
      const st = statusOf(r);
      const d = daysTo(r.next_due);
      if (st.key === 'over') push('red', 'recurring', `${r.name} — ${st.label.toLowerCase()}`, r.responsible || 'Recurring task', `/c/recurring`);
      else if (st.key === 'soon' && d <= 0) push('amber', 'recurring', `${r.name} — due today`, r.responsible || 'Recurring task', `/c/recurring`);
      else if (st.key === 'soon' && d <= 7) due('recurring', r.name, `due ${d === 1 ? 'tomorrow' : `in ${d} days`}`, '/c/recurring');
    }
    for (const i of dashQ.openInvoices.all()) {
      const st = invStatus(i);
      if (st.key === 'overdue') push('red', 'invoices', `Invoice ${i.invoice_number || '#' + i.id} — ${st.label}`, money(i.amount_cents), `/c/invoices`);
      else if (st.key === 'soon') due('invoices', `Invoice ${i.invoice_number || '#' + i.id}`, `${st.label} · ${money(i.amount_cents)}`, '/c/invoices');
    }
    for (const i of dashQ.unimported.all()) {
      push('blue', 'invoices', `Invoice ${i.invoice_number || '#' + i.id} — lines not imported`,
        `${money(i.amount_cents)} read but product costs unchanged`, `/c/invoices/${i.id}/import`);
    }
    for (const [rows, slug, what] of [[dashQ.expiring.all(), 'expirations', 'Expires'], [dashQ.warranties.all(), 'equipment', 'Warranty ends']]) {
      for (const r of rows) {
        const d = daysTo(r.due);
        if (d === null || d > 30) continue;
        if (d > 7) { due(slug === 'equipment' ? 'equipment' : 'expirations', r.name, `${what.toLowerCase()} in ${d} days`, `/c/${slug}/${r.id}`); continue; }
        push(d < 0 ? 'red' : 'amber', slug === 'equipment' ? 'equipment' : 'expirations',
          `${r.name} — ${d < 0 ? 'expired' : d === 0 ? 'expires today' : `${d} day${d === 1 ? '' : 's'} left`}`,
          `${what} ${whenOf(r.due)}`, `/c/${slug}/${r.id}`);
      }
    }
    // The "at reorder point" nag is gone with par levels. It counted on an
    // on-hand number nobody could keep true without POS depletion, and
    // Products deliberately doesn't show one — so the alert had no page left
    // to send you to. The columns are still on the table for when inventory
    // counts exist and it can come back meaning something.
  }

  if (may('cash')) {
    for (const r of CASH.q.recent.all()) {
      if (r.date < addDays(toStr, -13)) break;                  // list is newest-first
      const st = CASH.status(r);
      if (st.key !== 'review' && st.key !== 'critical') continue;
      const who = r.counted_by || r.closed_by;
      push(st.key === 'critical' ? 'red' : 'amber', 'cash',
        `${whenOf(r.date, r.daypart)} — ${st.label}`,
        who ? `Counted by ${who}` : 'Nobody recorded as counting it', `/cash/${r.id}`);
    }
    // A service that sold cash and was never counted is not a variance — it
    // is a drawer nobody looked at, which is the one nobody notices.
    if (may('shifts')) {
      const counted = new Set(CASH.q.recent.all().map((r) => `${r.date}|${r.daypart}`));
      for (const x of dashQ.recent.all(14)) {
        if (x.date === toStr || x.date < addDays(toStr, -6)) continue;
        if (shiftSales(x) <= 0 || counted.has(`${x.date}|${x.daypart}`)) continue;
        push('amber', 'cash', `${whenOf(x.date, x.daypart)} — drawer never counted`,
          `${money(shiftSales(x))} rung and no reconciliation`, '/cash/new');
      }
    }
  }

  if (may('payroll')) {
    const justEnded = recentPeriods(2)[1];
    // A skipped period is one the owner has said they are not running, so it
    // is not outstanding and must not keep asking.
    if (justEnded && !sendRecord(justEnded.start) && !skipRecord(justEnded.start)) {
      push('blue', 'payroll', `Payroll ready — ${labelFor(justEnded)}`, 'The period has ended and nothing has gone out', '/payroll');
    }
    const cur = currentPeriod();
    if (cur) {
      const d = daysTo(cur.end);
      if (d !== null && d >= 0 && d <= 7) due('payroll', `Payroll — ${labelFor(cur)}`, d === 0 ? 'period ends today' : `period ends in ${d} day${d === 1 ? '' : 's'}`, '/payroll');
    }
  }

  // Worst first, so a drawer that came up short is never buried under six
  // expiry reminders.
  const TONE_RANK = { red: 0, amber: 1, blue: 2 };
  attn.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  const bad = attn.filter((a) => a.tone === 'red').length;

  // --- rendering: today ----------------------------------------------------
  const svc = (x) => dp(x.daypart);
  const stateOf = (x) => shiftState(x, toStr);

  // Today is a strip of notices rather than one card, because on a real
  // evening there is more than one thing true at once: a service running, a
  // drawer waiting, payroll ready to go.
  const notices = [];
  const notice = (tone, ico, title, sub, cta, href) => notices.push({ tone, ico, title, sub, cta, href });

  if (may('shifts')) {
    for (const x of openToday) {
      const st = stateOf(x);
      const pct = x.people ? Math.round((Math.min(x.submitters, x.people) / x.people) * 100) : 0;
      const bits = [`${x.people} on`];
      if (x.hours) bits.push(`${Math.round(x.hours * 10) / 10} hrs`);
      if (x.tips) bits.push(`${money(x.tips)} tips`);
      notice('live', 'shifts', `${svc(x)} · ${st.label.toLowerCase()}`,
        `${bits.join(' · ')} — ${Math.min(x.submitters, x.people)} of ${x.people} submitted`,
        'Open shift', `/shifts/${x.id}`, pct);
      notices[notices.length - 1].pct = pct;
      notices[notices.length - 1].warn = x.no_hours
        ? `${x.no_hours} still ${x.no_hours === 1 ? 'has' : 'have'} no hours`
        : x.notes ? `${x.notes === 1 ? 'A note' : x.notes + ' notes'} from staff to read` : null;
    }
    if (!todays.length) {
      notice('idle', 'shifts', 'No shift started today',
        'Start one and staff can submit their tips from their phones.',
        canWrite ? "Log today's shift" : null, '/shifts/new');
    } else if (!openToday.length) {
      notice('done', 'policy', 'Today is closed out',
        `${todays.length} service${todays.length === 1 ? '' : 's'} sent · ${money(todaySales)} rung`,
        'All shifts', '/shifts');
    }
  }
  if (may('cash')) {
    const need = todays.filter((x) => shiftSales(x) > 0
      && !CASH.q.recent.all().some((r) => r.date === x.date && r.daypart === x.daypart));
    if (need.length && canWrite) {
      notice('todo', 'cash', `Cash reconciliation due · ${need.map(svc).join(' and ')}`,
        'The drawer has not been counted for today yet.', 'Count the drawer', '/cash/new');
    }
  }
  if (may('payroll')) {
    const justEnded = recentPeriods(2)[1];
    if (justEnded && !sendRecord(justEnded.start) && !skipRecord(justEnded.start)) {
      notice('todo', 'payroll', 'Payroll ready to send', labelFor(justEnded), 'Review payroll', '/payroll');
    }
  }
  if (may('trackers')) {
    const waiting = dashQ.unimported.all();
    if (waiting.length) notice('todo', 'invoices', `${waiting.length} invoice${waiting.length === 1 ? '' : 's'} awaiting review`,
      'Lines have been read but the product costs have not been updated.',
      'Review lines', waiting.length === 1 ? `/c/invoices/${waiting[0].id}/import` : '/c/invoices');
  }


  // --- rendering: the shift KPI band ---------------------------------------
  // Averages divide by shifts that HAVE figures. Counting a shift that was
  // logged but never filled in halves the average and makes every service
  // look worse than it was.
  const withSales = p30 ? p30.rows.filter((r) => r.sales > 0) : [];
  const lastShift = withSales.length ? withSales[withSales.length - 1] : null;
  const shiftSeries = withSales.slice(-12);
  const avgWage = withSales.length ? Math.round(p30.wages / withSales.length) : null;


  // --- rendering: the business snapshot ------------------------------------
  const pct1 = (v) => (v === null || v === undefined ? '—' : (Math.round(v * 10) / 10) + '%');
  // With no invoices in the range, cost of goods is 0 — but 0 means "nothing
  // logged", not "the food was free". Printing 0% food cost, and a prime cost
  // that is really just labor, would read as good news.
  const hasCogs = p7 && p7.cogs > 0;

  // --- quick actions --------------------------------------------------------
  // --- rendering: quick actions --------------------------------------------
  const ACTIONS = [
    { href: '/shifts/new', ico: 'shifts', label: 'Log a shift', blurb: 'Hours, sales and tips for a service', feat: 'shifts' },
    { href: '/cash/new', ico: 'cash', label: 'Count the drawer', blurb: 'Reconcile cash and record the deposit', feat: 'cash' },
    { href: '/c/invoices', ico: 'invoices', label: 'Upload an invoice', blurb: 'Read the lines and update product costs', feat: 'trackers' },
    { href: '/menu/new', ico: 'costs', label: 'Cost a menu item', blurb: 'Build a recipe and see its margin', feat: 'menu' },
    { href: '/c/vendors', ico: 'vendors', label: 'Add a vendor', blurb: 'Contacts, terms and where the login lives', feat: 'trackers' },
    { href: '/c/incidents', ico: 'incidents', label: 'Log an incident', blurb: 'Write it down while it is fresh', feat: 'trackers' },
  ].filter((a) => may(a.feat));

  // --- rendering: activity --------------------------------------------------
  const FEED = {
    shift: (r) => {
      const who = r.names && r.names.length > 1
        ? (r.names.length === 2 ? `<b>${esc(r.names[0])}</b> and <b>${esc(r.names[1])}</b>`
          : `<b>${esc(r.names[0])}</b> and ${r.names.length - 1} others`)
        : `<b>${esc(r.who || 'Someone')}</b>`;
      return { ico: 'tips', text: `${who} submitted for ${esc(dp(r.what || 'shift'))}`, href: r.ref ? `/shifts/${r.ref}` : null };
    },
    invoice: (r) => ({ ico: 'invoices', text: `Invoice added${r.who ? ` from <b>${esc(r.who)}</b>` : ''}${r.what ? ` · ${esc(r.what)}` : ''}`, href: '/c/invoices' }),
    vendor: (r) => ({ ico: 'vendors', text: `<b>${esc(r.who || 'A vendor')}</b> added to vendors`, href: '/c/vendors' }),
    incident: (r) => ({ ico: 'incidents', text: `Incident logged${r.what ? ` · ${esc(r.what)}` : ''}`, href: '/c/incidents' }),
    note: (r) => ({ ico: 'notes', text: `Decision logged${r.what ? ` · ${esc(r.what)}` : ''}`, href: '/c/notes' }),
    cash: (r) => ({ ico: 'cash', text: `Drawer reconciled${r.what ? ` · ${esc(dp(r.what))}` : ''}${r.who ? ` by <b>${esc(r.who)}</b>` : ''}`, href: '/cash' }),
    payroll: (r) => ({ ico: 'payroll', text: `Payroll sent${r.what ? ` · period from ${esc(r.what)}` : ''}`, href: '/payroll' }),
  };
  const FEED_FEAT = { shift: 'shifts', invoice: 'trackers', vendor: 'trackers', incident: 'trackers', note: 'trackers', cash: 'cash', payroll: 'payroll' };
  // A busy close puts one line per person per submission into the log, which
  // is right for the audit trail and useless as a feed — seven of eight rows
  // become "someone submitted" and everything else falls off the bottom. All
  // the submissions for a shift collapse into one entry naming who.
  const byShift = new Map();
  const events = [];
  for (const r of activityFeed.all(80)) {
    if (!may(FEED_FEAT[r.kind] || 'dashboard')) continue;
    if (r.kind === 'shift') {
      const g = byShift.get(r.ref);
      if (g) { if (r.who && !g.names.includes(r.who)) g.names.push(r.who); continue; }
      const ev = { ...r, names: r.who ? [r.who] : [] };
      byShift.set(r.ref, ev);
      events.push(ev);
    } else {
      events.push(r);
    }
    if (events.length >= 24) break;   // room to group before trimming
  }

  // =========================================================================
  // BROADSHEET RENDER
  // -------------------------------------------------------------------------
  // The front page of a newspaper. A headline that states the day, a notices
  // band across the top, then three columns: what needs doing, what the
  // numbers say, and what has happened.
  //
  // Every figure and every rule above this line is unchanged — this is the
  // rendering only. The annotations on the mockup ("NEVER FOLDED", "COMPLETED
  // SHIFTS ONLY", "withheld, not 0%") describe behaviour that already existed
  // and still does.
  // =========================================================================

  const M = (c) => `<span class="bs-fig">${money(c)}</span>`;

  // --- the headline ---------------------------------------------------------
  // A verdict, not a greeting. It states the day, then names the biggest
  // outstanding thing — "Two drawers still uncounted" rather than "3 items",
  // because a count is something you have to go and interpret.
  const THEME = {
    cash: (n) => `${n === 1 ? 'One drawer' : n === 2 ? 'Two drawers' : `${n} drawers`} still uncounted.`,
    shifts: (n) => `${n === 1 ? 'One service' : `${n} services`} still to close out.`,
    recurring: (n) => `${n === 1 ? 'A task is' : `${n} tasks are`} overdue.`,
    invoices: (n) => `${n === 1 ? 'An invoice needs' : `${n} invoices need`} looking at.`,
    expirations: (n) => `${n === 1 ? 'Something expires' : `${n} things expire`} soon.`,
    equipment: (n) => `${n === 1 ? 'A warranty is' : `${n} warranties are`} running out.`,
    payroll: () => 'Payroll is ready to send.',
    notes: (n) => `${n === 1 ? 'A note' : `${n} notes`} from staff to read.`,
  };
  const headline = (() => {
    const day = openToday.length
      ? `${esc(openToday.map(svc).join(' and '))} ${openToday.length === 1 ? 'is' : 'are'} open.`
      : todays.length ? 'Day closed out.'
      : 'Nothing logged today.';

    // The loudest theme among things that actually matter.
    const urgent = attn.filter((a) => a.tone === 'red' || a.tone === 'amber');
    const byTheme = new Map();
    for (const a of urgent) byTheme.set(a.ico, (byTheme.get(a.ico) || 0) + 1);
    const top = [...byTheme.entries()].sort((a, b) => b[1] - a[1])[0];

    const tail = top && THEME[top[0]]
      ? `<span class="warn">${esc(THEME[top[0]](top[1]))}</span>`
      : urgent.length ? `<span class="warn">${urgent.length} thing${urgent.length === 1 ? '' : 's'} need${urgent.length === 1 ? 's' : ''} your attention.</span>`
      : attn.length ? '' : '<span class="ok">Everything is counted.</span>';
    return `${day} ${tail}`;
  })();

  const headMeta = attn.length
    ? `${attn.length} item${attn.length === 1 ? '' : 's'} · ${bad ? `${bad} urgent` : 'nothing urgent'}`
    : 'nothing outstanding';

  // The masthead line is a billboard: the verdict, then whatever else is true
  // right now, each sliding through in turn. Every message is in the DOM from
  // the start — the rotation is presentation, so a screen reader gets the lot
  // and a browser with JS off shows the first one, which is the verdict.
  const billboard = [
    headline,
    ...notices.map((n) => `${esc(n.title)} <span class="bs-bb-s">${esc(n.sub)}</span>`
      + (n.href && n.cta ? ` <a class="bs-act" href="${n.href}">${esc(n.cta)} →</a>` : '')),
  ];

  // --- the notices band -----------------------------------------------------
  // Only what is true right now: a service running, a drawer waiting. When the
  // day is closed out there is nothing here and the band does not draw.
  const noticeCard = (n) => `
    <div class="bs-notice">
      <div class="bs-notice-t">
        <b>${esc(n.title)}</b> <span>${esc(n.sub)}</span>
        ${n.href && n.cta ? `<a class="bs-act" href="${n.href}">${esc(n.cta)} →</a>` : ''}
      </div>
      ${n.pct != null ? `<div class="bs-prog"><span style="width:${n.pct}%"></span></div>` : ''}
      ${n.warn ? `<div class="bs-notice-w">${esc(n.warn)}</div>` : ''}
    </div>`;
  const todayBlock = notices.length
    ? `<div class="bs-notices">${notices.map(noticeCard).join('')}</div>` : '';

  // --- column 1: needs attention -------------------------------------------
  // One list, ordered worst first, with the severity in each item's kicker
  // rather than in three separate headed sections. The fold rule is unchanged:
  // everything critical shows, two warnings show, the rest collapses.
  const TONE_WORD = { red: 'Critical', amber: 'Warning', blue: 'Info' };
  // Alerts carry their date inside the title — "Jul 19 Dinner — hours missing".
  // The kicker wants the date and the title wants the rest, so the two are
  // split for display only. Nothing that builds an alert changes, and a title
  // that does not match this shape is simply shown whole.
  const splitTitle = (t) => {
    const m = String(t).match(/^([A-Z][a-z]{2} \d{1,2}(?:\s+\S+)?)\s+—\s+(.+)$/);
    return m ? { when: m[1], rest: m[2] } : { when: null, rest: t };
  };
  const nitem = (a) => {
    const { when, rest } = splitTitle(a.title);
    return `<a class="bs-item" href="${a.href}">
      <span class="bs-item-k ${a.tone}">${when ? esc(when.toUpperCase()) + ' · ' : ''}${TONE_WORD[a.tone].toUpperCase()}</span>
      <span class="bs-item-t">${esc(rest)}</span>
      <span class="bs-item-s">${esc(a.sub)}<span class="bs-sep" aria-hidden="true"> · </span><span class="bs-act">Open →</span></span>
    </a>`;
  };

  const reds = attn.filter((a) => a.tone === 'red');
  const ambers = attn.filter((a) => a.tone === 'amber');
  const blues = attn.filter((a) => a.tone === 'blue');
  // Critical never folds. Two warnings show. Everything else is behind the fold.
  const shown = [...reds, ...ambers.slice(0, 2)];
  const folded = [...ambers.slice(2), ...blues];

  const attnBlock = attn.length ? `
    <div class="bs-sec-h warn"><span class="bs-kicker">Needs attention</span></div>
    <div class="bs-items">${shown.map(nitem).join('')}</div>
    ${folded.length ? `<details class="bs-fold">
      <summary>${folded.length} more item${folded.length === 1 ? '' : 's'} <span aria-hidden="true">▾</span></summary>
      <div class="bs-items">${folded.map(nitem).join('')}</div></details>` : ''}`
    : `<div class="bs-sec-h"><span class="bs-kicker">Needs attention</span></div>
       <p class="bs-clear">Nothing needs your attention right now.</p>`;

  // --- column 2: the week in numbers ---------------------------------------
  const figCell = (label, value, sub) =>
    `<div class="bs-figcell"><span class="bs-figlabel">${label}</span><span class="bs-stat">${value}</span>${sub ? `<span class="bs-figsub">${sub}</span>` : ''}</div>`;

  const weekBand = p7 && seeCosts ? `
    <div class="bs-sec-h"><span class="bs-kicker">The week in numbers</span>
      ${may('costs') ? '<a class="bs-act" href="/costs">Performance →</a>' : ''}</div>
    <div class="bs-grid2">
      ${figCell('Sales', money(p7.sales), CH.delta(p7.sales, prev7.sales))}
      ${figCell('Labor', pct1(p7.laborPct), p7.laborPct === null ? 'no sales' : 'of sales')}
      ${figCell('Food', hasCogs ? pct1(p7.foodPct) : '—', hasCogs ? 'of sales' : 'no invoices — withheld, not 0%')}
      ${figCell('Prime cost', hasCogs ? pct1(p7.primePct) : '—', hasCogs ? 'labor + goods' : 'needs food cost')}
    </div>
    ${sparkOf((w) => w.sales).length >= 3 ? `
      <p class="bs-sparklabel">Sales, trailing 8 weeks</p>
      <div class="bs-spark">${CH.lineChart(
        [{ label: 'Sales', values: sparkOf((w) => w.sales).map((v) => ({ x: '', y: v })), area: true }],
        { height: 96, empty: '' })}</div>` : ''}
    ${soon.length ? `
      <div class="bs-sec-h bs-soon-h"><span class="bs-kicker">Coming up</span></div>
      <div class="bs-soon">
        ${soon.slice(0, 6).map((u) => `<a class="bs-soon-r" href="${u.href}">
          <span>${esc(u.title)}</span><b class="bs-fig">${esc(u.sub)}</b></a>`).join('')}
      </div>` : ''}` : '';

  // --- column 3: last service, and the record ------------------------------
  const row = (label, value) => `<div class="bs-lrow"><span>${label}</span><b class="bs-fig">${value}</b></div>`;
  const lastBand = lastShift ? `
    <div class="bs-sec-h"><span class="bs-kicker">Last service — ${esc(whenOf(lastShift.date, lastShift.daypart))}</span>
      ${may('shifts') ? `<a class="bs-act" href="/shifts/${lastShift.id}">Open →</a>` : ''}</div>
    <div class="bs-lrows">
      ${row('Sales', money(lastShift.sales))}
      ${row('Tips', lastShift.tips ? money(lastShift.tips) : '—')}
      ${row('Hours', lastShift.hours ? (Math.round(lastShift.hours * 10) / 10).toFixed(1) : '—')}
      ${row('Staff', lastShift.people || '—')}
    </div>` : '';

  const feedRows = events.slice(0, 5).map((r) => {
    const f = FEED[r.kind](r);
    const inner = `<span class="bs-rec-t">${f.text}</span> <span class="bs-rec-w">— ${ago(r.at, now)}</span>`;
    return f.href ? `<a class="bs-rec" href="${f.href}">${inner}</a>` : `<div class="bs-rec">${inner}</div>`;
  }).join('');
  const record = `
    <div class="bs-sec-h bs-rec-h"><span class="bs-kicker">The record</span></div>
    ${feedRows ? `<div class="bs-recs">${feedRows}</div>` : '<p class="bs-clear">Nothing has happened yet.</p>'}`;

  const dblk = (cls, inner) => (inner ? `<section class="bs-dblk bs-dblk-${cls}">${inner}</section>` : '');

  const bodyHtml = `
    ${flash(req)}
    <div class="bs-page">
      <div class="bs-head">
        <div class="bs-headwrap">
          <p class="bs-greet">${greeting(now)}${me && me.name && !me.master ? `, ${esc(me.name.split(' ')[0])}` : ''}<span class="bs-greet-d">${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span></p>
          <div class="bs-bb" id="bs-bb" data-n="${billboard.length}">
            ${billboard.map((m, i) => `<h1 class="bs-headline bs-bb-i${i === 0 ? ' on' : ''}">${m}</h1>`).join('')}
          </div>
        </div>
        <span class="bs-headmeta">${esc(headMeta)}</span>
      </div>
      <!-- Each block is wrapped so a phone can reorder them without the desktop
           columns moving. On a wide screen these wrappers style nothing; below
           1180px the columns become display:contents and the wrappers are the
           grid items, ordered last service · the week · attention · the record.
           Wrapped only when it has content, so an absent block leaves no stray
           gap in the stack. -->
      <div class="bs-cols3">
        <div class="bs-col">${dblk('attn', attnBlock)}</div>
        <div class="bs-col">${dblk('week', weekBand)}</div>
        <div class="bs-col">${dblk('last', lastBand)}${dblk('rec', record)}</div>
      </div>
    </div>`;

  res.send(layout('Dashboard', bodyHtml));
});

// ---------------------------------------------------------------------------
// Shifts — list of all shifts + "log a shift"
// ---------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Jul 16 Dinner" — the way a service is named everywhere it is mentioned. */
const whenOf = (date, daypart) =>
  `${MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3)} ${Number(date.slice(8, 10))}${daypart ? ' ' + dp(daypart) : ''}`;
// ---------------------------------------------------------------------------
// SHIFTS — the command centre. Today first, then anything needing attention,
// then history by month.
//
// Row figures come from one SQL pass rather than running the tip engine per
// shift: the engine costs ~1ms each, which is five seconds at five thousand
// shifts. It's still run — but only for the handful that aren't closed out,
// because that's the only place its answers are needed.
// ---------------------------------------------------------------------------
const shiftRollup = db.prepare(`SELECT sh.*, ${SHIFT_ROLLUP_COLS}
  FROM shifts sh ORDER BY sh.date DESC, sh.daypart DESC`);

/** Total sales for a shift: what was rung overall, or server sales if not entered. */
const shiftSales = (x) =>
  (x.total_food_cents + x.total_coffee_cents + x.total_alcohol_cents + x.total_other_cents) || x.server_sales;

function shiftState(x, today) {
  if (x.status === 'emailed') return { key: 'sent', label: 'Sent', cls: 's-done' };
  if (x.date === today) return { key: 'open', label: 'Open', cls: 's-sched' };
  if (!x.people) return { key: 'empty', label: 'Nobody on it', cls: 's-none' };
  if (x.no_hours) return { key: 'review', label: 'Needs review', cls: 's-soon' };
  return { key: 'ready', label: 'Ready to send', cls: 's-ready' };
}

app.get('/shifts', (req, res) => {
  const today = isoDate(startOfToday());
  const thisMonth = today.slice(0, 7);
  const all = shiftRollup.all();
  const st = all.map((x) => ({ x, s: shiftState(x, today) }));

  const years = [...new Set(all.map((x) => x.date.slice(0, 4)))].sort().reverse();
  const year = years.includes(req.query.y) ? req.query.y : (years[0] || today.slice(0, 4));
  const rows = st.filter(({ x }) => x.date.slice(0, 4) === year);

  const monthRows = st.filter(({ x }) => x.date.slice(0, 7) === thisMonth);
  const sum = (list, f) => list.reduce((a, r) => a + f(r), 0);
  const monthSales = sum(monthRows, ({ x }) => shiftSales(x));
  const monthHours = sum(monthRows, ({ x }) => x.hours);
  const monthWages = sum(monthRows, ({ x }) => x.wage_cents);
  const monthNoWage = sum(monthRows, ({ x }) => x.no_wage);
  const openOnes = st.filter(({ s }) => s.key === 'open' || s.key === 'review' || s.key === 'ready');

  // Averages are per shift, so a month with no shifts has no answer to give —
  // better a dash than a confident $0.00.
  const n = monthRows.length;
  // A shift that's logged but has nothing in it yet — tonight's, or one still
  // waiting on hours — is not a shift that performed badly. Counting it drags
  // every average toward zero and makes a good month look middling, so the
  // averages divide by the shifts that actually have figures against them.
  const counted = monthRows.filter(({ x }) => x.hours > 0 || shiftSales(x) > 0);
  const k = counted.length;
  const per = (total, by) => (by ? money(Math.round(total / by)) : '—');
  const laborPct = monthSales && monthWages ? Math.round((monthWages / monthSales) * 100) : null;
  const skipped = n - k;
  const salesSub = !k ? 'nothing to average yet'
    : skipped ? `÷ ${k} shift${k === 1 ? '' : 's'} with figures`
    : 'total sales ÷ shifts';
  const wageSub = !k ? 'no wages logged yet'
    : monthNoWage ? `${monthNoWage} without a wage set`
    // Kept short on purpose: .mcard-sub is a single ellipsised line, and at
    // 375px anything past ~24 characters gets cut off mid-word.
    : laborPct !== null ? `${laborPct}% of sales · no tips`
    : 'wages only, no tips';

  const kpi = (tone, ico, label, value, sub) => `
    <div class="mcard mcard-${tone}"><div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body"><div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div><div class="mcard-sub">${sub}</div></div></div>`;

  // How each shift performed, not just what it took in. The count of unsent
  // shifts used to sit here; it moved out because the attention panel right
  // below names them individually, which is the more useful form of it.
  const todays = st.filter(({ x }) => x.date === today && x.status !== 'emailed');

  // --- history by month ------------------------------------------------------
  const byMonth = new Map();
  for (const r of rows) {
    const m = r.x.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  const months = [...byMonth.keys()].sort().reverse();

  // =========================================================================
  // BROADSHEET — the shifts ledger
  // -------------------------------------------------------------------------
  // A stat strip that excludes open shifts (today is never a measurement),
  // then months as ruled ledgers. Every figure and every state is unchanged.
  // =========================================================================

  const statCell = (label, value, sub) =>
    `<div class="bs-strip-c"><span class="bs-strip-l">${label}</span><span class="bs-stat">${value}</span><span class="bs-strip-s">${sub}</span></div>`;

  const statStrip = `
    <section class="bs-panel bs-strip">
      ${statCell('Sales this month', money(monthSales), `${k} completed shift${k === 1 ? '' : 's'}`)}
      ${statCell('Avg sales a shift', per(monthSales, k), esc(salesSub))}
      ${statCell('Avg wage cost a shift', per(monthWages, k), esc(wageSub))}
      ${statCell('Sales per labor hour', monthHours ? money(Math.round(monthSales / monthHours)) : '—',
        monthHours ? `÷ ${(Math.round(monthHours * 10) / 10).toLocaleString('en-US')} hrs worked` : 'no hours yet')}
      <span class="bs-strip-note">open shifts excluded —<br>today is never a measurement</span>
    </section>`;

  // Open right now, across the top of the ledger.
  const openBlock = todays.length ? `
    <section class="bs-panel bs-panel-warn">
      <div class="bs-sec-h"><span class="bs-kicker">Open right now</span>
        <span class="bs-sec-note">${todays.length}</span></div>
      <div class="bs-open">
      ${todays.map(({ x, s }) => `<a class="bs-open-r" href="/shifts/${x.id}">
        <span class="bs-open-d ${s.key}"></span>
        <b>${esc(dp(x.daypart))} · ${esc(s.label.toLowerCase())}</b>
        <span>${x.people} on · ${Math.min(x.submitters, x.people)} of ${x.people} submitted${x.tips ? ` · ${money(x.tips)} tips so far` : ''}</span>
        <span class="bs-act">Open →</span>
      </a>`).join('')}
      </div>
    </section>` : '';

  const monthBlocks = months.map((m) => {
    const list = byMonth.get(m);
    const sales = sum(list, ({ x }) => shiftSales(x));
    const tips = sum(list, ({ x }) => x.tips);
    const hrs = sum(list, ({ x }) => x.hours);
    const open = list.filter(({ s }) => s.key !== 'sent').length;
    const label = `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

    // Weeks, so twenty-one identical rows become three groups your eye can
    // hold — and a week subtotal is a question the page could not answer
    // before. Monday starts the week, matching the payroll period.
    const weekOf = (d) => {
      const dt = new Date(d + 'T00:00:00');
      return addDays(d, -((dt.getDay() + 6) % 7));
    };
    const inWeeks = (items) => {
      const out = [];
      for (const it of items) {
        const wk = weekOf(it.x.date);
        if (!out.length || out[out.length - 1].wk !== wk) out.push({ wk, list: [] });
        out[out.length - 1].list.push(it);
      }
      return out;
    };
    const weekBlock = (items) => inWeeks(items).map(({ wk, list: wl }) => {
      const wSales = sum(wl, ({ x }) => shiftSales(x));
      const wTips = sum(wl, ({ x }) => x.tips);
      return `<div class="bs-week">
        ${wl.map(row).join('')}
        <div class="bs-week-f"><span>week of ${esc(whenOf(wk))}</span>
          <b class="bs-fig">${money(wSales)}</b>
          <i class="bs-fig">${wTips ? money(wTips) + ' tips' : ''}</i></div>
      </div>`;
    }).join('');

    const row = ({ x, s }) => {
      const search = [x.date, dp(x.daypart), s.label, label].join(' ').toLowerCase();
      const none = shiftSales(x) === 0;
      const dow = new Date(x.date + 'T00:00:00').getDay();
      const weekend = dow === 0 || dow === 5 || dow === 6;
      return `<a class="bs-lr bs-shiftrow${weekend ? ' wknd' : ''}" href="/shifts/${x.id}" data-shift data-status="${s.key}"
         data-service="${esc(x.daypart)}" data-search="${esc(search)}">
        <span class="bs-lr-d">${new Date(x.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} ${Number(x.date.slice(8, 10))}</span>
        <span class="bs-lr-s">${esc(dp(x.daypart))}</span>
        <span class="bs-lr-st ${s.key}">${esc(s.label.toUpperCase())}</span>
        <span class="bs-lr-n">${none ? '—' : money(shiftSales(x))}</span>
        <span class="bs-lr-n muted">${x.tips ? money(x.tips) : '—'}</span>
        <span class="bs-lr-n muted">${x.hours ? (Math.round(x.hours * 10) / 10).toFixed(1) : '—'}${x.no_hours ? `<i class="bs-lr-miss">${x.no_hours} missing</i>` : ''}</span>
        <span class="bs-lr-n muted">${x.people || 0}</span>
        <span class="bs-lr-go">→</span>
      </a>`;
    };

    // Every month starts closed and every month behaves the same. You arrive
    // looking for a particular stretch of days, so the page opens as a list of
    // months you can take in at once — total, hours, how many are unsent — and
    // you go into the one you want.
    //
    // An open month shows all of its days. Folding the first six and hiding
    // the rest behind "N earlier days" made sense when the newest month opened
    // by default; now it is a second click to reach what the first one asked
    // for. The week rules are what keep a thirty-day month scannable.
    return `<details class="bs-month" data-month>
      <summary class="bs-month-h">
        <span class="bs-kicker">${esc(label)}</span>
        <span class="bs-month-meta">${list.length} shift${list.length === 1 ? '' : 's'} · ${Math.round(hrs).toLocaleString('en-US')} hrs ·
          ${open ? `<b class="warn">${open} not sent</b>` : '<b class="ok">all sent</b>'}</span>
        <span class="bs-month-tot"><b>${money(sales)}</b>${tips ? ` + ${money(tips)} tips` : ''}</span>
        <span class="bs-act bs-month-go">open <span aria-hidden="true">▸</span></span>
      </summary>
      <div class="bs-lhead bs-shifthead">
        <span>Date</span><span>Service</span><span>Status</span>
        <span class="r">Sales</span><span class="r">Tips</span><span class="r">Hrs</span><span class="r">Staff</span><span></span>
      </div>
      <div class="bs-lrows">${weekBlock(list)}</div>
    </details>`;
  }).join('');

  const notSent = st.filter(({ s }) => s.key !== 'sent' && s.key !== 'open').length;
  const headline = all.length
    ? `Shifts — ${all.length} logged, ${notSent ? `${notSent} still to send.` : 'all sent.'}`
    : 'No shifts logged yet.';
  const subline = all.length
    ? (todays.length ? `${todays.length} open now. Staff submissions start a shift on their own.`
       : notSent ? 'Staff submissions start a shift on their own.'
       : 'Nothing open, nothing waiting on you.')
    : 'A shift starts itself the moment a staff member submits their tips.';

  const body = all.length ? `
    ${statStrip}
    ${openBlock}
    <div class="bs-filter">
      <span class="bs-filter-l">Filter:</span>
      <button class="bs-fchip on" data-f="all" data-v="">All ${rows.length}</button>
      <button class="bs-fchip" data-f="service" data-v="cafe">Café</button>
      <button class="bs-fchip" data-f="service" data-v="dinner">Dinner</button>
      <button class="bs-fchip" data-f="status" data-v="open">Open</button>
      <button class="bs-fchip" data-f="status" data-v="review">Needs review</button>
      <button class="bs-fchip" data-f="status" data-v="ready">Ready</button>
      <button class="bs-fchip" data-f="status" data-v="sent">Sent</button>
      <span class="bs-filter-sp"></span>
      ${years.length > 1 ? years.map((y) => `<a class="bs-ytab${y === year ? ' on' : ''}" href="/shifts?y=${y}">${y}</a>`).join('') : ''}
      <input id="ssearch" class="bs-search-inline" type="search" placeholder="Search a date, month or service…" autocomplete="off">
    </div>
    ${monthBlocks}
    <div class="bs-clear" id="snone" style="display:none">Nothing matches. Try a different search or filter.</div>`
    : `<p class="bs-clear">Nothing yet. ${canWrite() ? '<a href="/shifts/new">Log a shift →</a>' : ''}</p>`;

  res.send(layout('Shifts', `
    ${flash(req)}
    <div class="bs-page">
      <div class="bs-head">
        <div>
          <h1 class="bs-headline">${esc(headline)}</h1>
          <p class="bs-subline">${esc(subline)}</p>
        </div>
        ${canWrite() ? '<a class="bs-btn" href="/shifts/new">+ Log a shift</a>' : ''}
      </div>
      ${body}
    </div>
    <script>
      (function () {
        var q = '', mode = 'all', val = '';
        function apply() {
          var shown = 0;
          document.querySelectorAll('[data-month]').forEach(function (g) {
            var n = 0;
            g.querySelectorAll('[data-shift]').forEach(function (el) {
              var ok = mode === 'all' ? true
                : mode === 'service' ? el.getAttribute('data-service') === val
                : el.getAttribute('data-status') === val;
              if (ok && q) ok = el.getAttribute('data-search').indexOf(q) !== -1;
              el.style.display = ok ? '' : 'none';
              if (ok) { n++; shown++; }
            });
            g.style.display = n ? '' : 'none';
            if (n && (q || mode !== 'all')) g.open = true;
          });
          var none = document.getElementById('snone');
          if (none) none.style.display = shown ? 'none' : '';
        }
        var si = document.getElementById('ssearch');
        if (si) si.addEventListener('input', function () { q = this.value.toLowerCase(); apply(); });
        document.querySelectorAll('.fchip').forEach(function (b) {
          b.addEventListener('click', function () {
            document.querySelectorAll('.fchip').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            mode = b.getAttribute('data-f'); val = b.getAttribute('data-v'); apply();
          });
        });
      })();
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
/** Notes staff left with their submission. Renders nothing when there are none. */
function notesBlock(notes) {
  if (!notes.length) return '';
  return `
    <h2>Notes from staff</h2>
    <p class="muted">Thoughts, comments or concerns left with their tip submission.</p>
    <div class="notes">
      ${notes.map((n) => `
        <div class="note-card">
          <div class="note-who">${esc(n.name)}${n.role ? ` <span class="pill">${esc(n.role)}</span>` : ''}</div>
          <div class="note-body">${esc(n.note)}</div>
        </div>`).join('')}
    </div>`;
}

/**
 * Every submission for a shift, newest first. The most recent per person is
 * what the shift currently holds; earlier ones are marked superseded, since
 * the point of keeping them is seeing what someone said BEFORE they corrected
 * it — and whether the correction was theirs or yours.
 */
/** "6 submissions filed, 3 later replaced" — the sheet's one-line summary. */
function subCount(shiftId) {
  const rows = submissions.forShift.all(shiftId);
  const real = rows.filter((r) => r.source !== 'imported');
  const dupes = real.length - new Set(real.map((r) => r.employee_id)).size;
  if (!rows.length) return 'No submissions filed';
  return `${rows.length} submission${rows.length === 1 ? '' : 's'} filed`
    + (dupes ? `, ${dupes} later replaced` : '');
}

function submissionsPanel(shiftId) {
  const rows = submissions.forShift.all(shiftId);
  if (!rows.length) {
    return `
    <h2>Submissions</h2>
    <p class="muted">Nothing submitted yet. Every entry staff make on the tips page — and every change you make here — is recorded, so a corrected figure never hides what it replaced.</p>`;
  }
  const seen = new Set();
  const money0 = (c) => (c === null || c === undefined ? null : money(c));

  const items = rows.map((r) => {
    const key = r.employee_id;
    const current = !seen.has(key);
    seen.add(key);
    const imported = r.source === 'imported';
    // An imported row is a reconstruction from the current figures, not a
    // recorded event — so it shows the shift date, not a time it never had.
    const when = imported ? String(r.created_at || '').slice(0, 10)
      : String(r.created_at || '').replace('T', ' ').slice(0, 16);
    const figures = [
      ['Cash', money0(r.cash_tips_cents)], ['Card', money0(r.card_tips_cents)],
      ['Food', money0(r.food_cents)], ['Coffee', money0(r.coffee_cents)], ['Alcohol', money0(r.alcohol_cents)],
    ].filter(([, v]) => v !== null);

    return `
    <details class="sub${current ? '' : ' sub-old'}">
      <summary>
        <span class="sub-dot ${imported ? 'sub-imp' : r.source === 'manager' ? 'sub-mgr' : 'sub-staff'}"></span>
        <span class="sub-who">${esc(r.name)}</span>
        <span class="sub-role">${esc(r.role || '')}</span>
        <span class="sub-tag">${imported ? 'on file before logging started' : r.source === 'manager' ? 'you edited' : 'submitted'}</span>
        ${current ? '<span class="sub-cur">current</span>' : '<span class="sub-sup">superseded</span>'}
        <span class="sub-when">${esc(when)}</span>
      </summary>
      <div class="sub-body">
        ${figures.length
          ? `<div class="sub-figs">${figures.map(([k, v]) => `<div class="sub-fig"><span>${k}</span><b>${v}</b></div>`).join('')}</div>`
          : '<div class="panel-empty">No figures in this entry.</div>'}
        ${r.note ? `<div class="sub-note">${esc(r.note)}</div>` : ''}
        ${imported ? '<div class="sub-imp-note">Reconstructed from what this shift currently holds. Anything it replaced was overwritten before submissions were logged and can\'t be recovered.</div>' : ''}
      </div>
    </details>`;
  }).join('');

  const dupes = rows.filter((r) => r.source !== 'imported').length - new Set(rows.filter((r) => r.source !== 'imported').map((r) => r.employee_id)).size;
  return `
    <h2>Submissions <span class="sec-n">${rows.length}</span></h2>
    <p class="muted">Newest first. ${dupes ? `<b>${dupes}</b> ${dupes === 1 ? 'entry was' : 'entries were'} later replaced — open one to see what it said.` : 'Nothing has been resubmitted.'}</p>
    <div class="subs">${items}</div>`;
}

app.get('/shifts/:id', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).send(layout('Not found', '<h1>Shift not found</h1>'));
  const inp = shiftInputs(sh.id);
  const r = runShift(inp, policyForShift(sh));
  const { warn, notes } = shiftWarnings(sh, inp, r);
  const staff = q.nonManagerList.all();
  const people = [...inp.servers, ...inp.support];

  // --- per-person state -------------------------------------------------
  // What still needs doing for THIS person, so the fix is next to the card
  // that needs it rather than in a list at the top you have to map back.
  const stateOf = (p, isServer) => {
    const miss = [];
    if (!Number(p.hours) && !p.salaried) miss.push('hours');
    if (isServer) {
      const tips = toCents(p.cardTips) + toCents(p.cashTips);
      const sales = toCents(p.food) + toCents(p.coffee) + toCents(p.alcohol);
      if (!p.cashEnteredBy) miss.push('cash tips');
      if (tips > 0 && sales === 0) miss.push('sales');
    }
    if (!p.email) miss.push('email');
    if (!miss.length) return { key: 'ok', label: 'Ready', cls: 's-done', miss };
    if (miss.includes('hours')) return { key: 'blocked', label: 'Needs hours', cls: 's-over', miss };
    return { key: 'check', label: 'Needs ' + miss[0], cls: 's-soon', miss };
  };

  const serverStates = inp.servers.map((p) => ({ p, st: stateOf(p, true) }));
  const supportStates = inp.support.map((p) => ({ p, st: stateOf(p, false) }));
  const allStates = [...serverStates, ...supportStates];
  const ready = allStates.filter((x) => x.st.key === 'ok').length;
  const withHours = people.filter((p) => Number(p.hours) || p.salaried).length;

  const totalSales = inp.servers.reduce((a, p) => a + toCents(p.food) + toCents(p.coffee) + toCents(p.alcohol), 0);
  const totalTips = r.reconciliation.totalTipsCollected;
  const poolCash = r.pool.cash;
  const poolCard = r.pool.togoCard;

  // --- header + KPIs ----------------------------------------------------
  const pct = people.length ? Math.round((withHours / people.length) * 100) : 0;
  const statusPill = sh.status === 'emailed'
    ? '<span class="tstatus s-done">Emails sent</span>'
    : warn.length ? '<span class="tstatus s-soon">Needs review</span>' : '<span class="tstatus s-sched">Ready to send</span>';

  const kpi = (tone, ico, label, value, sub) => `
    <div class="mcard mcard-${tone}"><div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body"><div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div><div class="mcard-sub">${sub}</div></div></div>`;

  // --- attention panel --------------------------------------------------
  const attention = warn.length || notes.length ? `
    <section class="attn${warn.length ? '' : ' attn-soft'}">
      <div class="attn-h">${icon(warn.length ? 'incidents' : 'expirations')}
        <span>${warn.length ? `${warn.length} thing${warn.length === 1 ? '' : 's'} to sort out` : 'Worth knowing'}</span></div>
      <ul class="attn-list">
        ${warn.map((wn) => `<li class="attn-bad">${esc(wn)}</li>`).join('')}
        ${notes.map((n) => `<li class="attn-note">${esc(n)}</li>`).join('')}
      </ul>
    </section>`
    : `<section class="attn attn-ok">
        <div class="attn-h">${icon('policy')}<span>Everything checks out</span></div>
        <p>Hours are in for everyone, tips reconcile, and nobody is missing an email. This shift is ready to send.</p>
      </section>`;

  // --- person card ------------------------------------------------------
  const initials = (n) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const fig = (label, value, editKey, step, ph) => `
    <div class="pfig"${editKey ? ` data-edit="${editKey}" data-step="${step || '0.01'}"${ph ? ` data-ph="${ph}"` : ''}` : ''}>
      <span>${label}</span><b>${value}</b></div>`;

  const personCard = ({ p, st }, kind) => {
    const isServer = kind === 'server';
    const c = isServer ? '#4f46e5' : '#0d9488';
    return `
    <article class="pcard ${st.cls}" data-emp="${p.employeeId}" data-kind="${kind}" style="--c:${c}">
      <div class="pcard-top">
        <span class="pavatar">${esc(initials(p.name))}</span>
        <div class="pcard-head">
          <div class="pcard-name">${esc(p.name)}</div>
          <div class="pcard-role">${esc(isServer ? 'server' : p.role)}${p.salaried ? ' · salaried' : ''}</div>
        </div>
        <span class="tstatus ${st.cls}">${esc(st.label)}</span>
      </div>
      <div class="pfigs">
        ${isServer ? fig('Food', money(toCents(p.food)), 'food') : ''}
        ${isServer ? fig('Coffee', money(toCents(p.coffee)), 'coffee') : ''}
        ${isServer ? fig('Card tips', money(toCents(p.cardTips)), 'card_tips') : ''}
        ${isServer
          ? fig('Cash tips', p.cashEnteredBy ? money(toCents(p.cashTips)) : '<i class="unset">not in</i>', 'cash_tips', '0.01', 'not entered')
          : fig('Cash tips', toCents(p.cashTips) ? money(toCents(p.cashTips)) : '<i class="unset">none</i>', 'cash_tips', '0.01', 'none')}
        ${isServer ? '' : fig('To-go card', toCents(p.cardTips) ? money(toCents(p.cardTips)) : '<i class="unset">none</i>', 'card_tips', '0.01', 'none')}
        ${fig('Hours', Number(p.hours) ? p.hours : '<i class="unset">—</i>', 'hours', '0.01', '0')}
        ${fig('Wage', toCents(p.hourlyRate) ? money(toCents(p.hourlyRate)) + '/h' : '<i class="unset">default</i>', 'wage', '0.01', 'default')}
      </div>
      <div class="pcard-act row-actions">
        <button type="button" class="btn btn-sm" onclick="startEdit(${p.employeeId},'${kind}')">Edit</button>
        <form method="post" action="/shifts/${sh.id}/remove" onsubmit="return confirm('Take ${esc(p.name).replace(/'/g, "\\'")} off this shift?')" style="margin:0">
          <input type="hidden" name="employee_id" value="${p.employeeId}">
          <button class="btn btn-sm btn-ghost">Remove</button>
        </form>
      </div>
    </article>`;
  };

  // --- prefill map for the add forms (re-adding = editing) --------------
  const salesMap = new Map(w.salesForShift.all(sh.id).map((x) => [x.employee_id, x]));
  const entries = {};
  const d = (c) => (c ? (c / 100).toFixed(2) : '');
  for (const row of w.workForShift.all(sh.id)) {
    const sr = salesMap.get(row.employee_id) || {};
    entries[row.employee_id] = {
      role: row.role, hours: row.hours || '', wage: d(row.shift_rate_cents),
      food: d(sr.food_cents), coffee: d(sr.coffee_cents), alcohol: d(sr.alcohol_cents),
      card_tips: d(sr.card_tips_cents), cash_tips: d(sr.cash_tips_cents),
    };
  }
  const staffOptions = staff.map((e) => `<option value="${e.id}" data-role="${e.role}" data-rate="${((e.hourly_rate_cents || 0) / 100).toFixed(2)}">${esc(e.name)} · ${e.role}</option>`).join('');
  const roleOpts = (sel) => shiftRoles().map((x) => `<option value="${x}"${x === sel ? ' selected' : ''}>${esc(posName(x))}</option>`).join('');

  // --- notes as message cards -------------------------------------------
  const noteRows = w.notesForShift.all(sh.id);
  const notesSection = noteRows.length ? `
    <section class="sect">
      <div class="sect-h"><h2>${icon('notes')} Notes from staff</h2>
        <span class="sect-n">${noteRows.length}</span></div>
      <div class="msgs">
        ${noteRows.map((n) => `
          <div class="msg">
            <span class="pavatar msg-av">${esc(initials(n.name))}</span>
            <div class="msg-b">
              <div class="msg-h"><b>${esc(n.name)}</b>${n.role ? `<span class="msg-role">${esc(n.role)}</span>` : ''}</div>
              <div class="msg-t">${esc(n.note)}</div>
            </div>
          </div>`).join('')}
      </div>
    </section>` : '';

  // --- tip pool ----------------------------------------------------------
  const eligible = r.support.filter((p) => p.tipEligible !== false);
  const poolSection = `
    <section class="sect">
      <div class="sect-h"><h2>${icon('cash')} Shared tip pool</h2></div>
      <div class="pool">
        <div class="pool-side">
          <div class="pool-box pool-cash">
            <div class="pool-lbl">Cash pool</div>
            <div class="pool-amt">${money(poolCash)}</div>
            <div class="pool-parts">
              <span>You counted <b>${money(toCents(inp.pool.jar))}</b></span>
              <span>Staff reported <b>${money(poolCash - toCents(inp.pool.jar))}</b></span>
            </div>
          </div>
          <div class="pool-box pool-card">
            <div class="pool-lbl">To-go card pool</div>
            <div class="pool-amt">${money(poolCard)}</div>
            <div class="pool-parts">
              <span>You counted <b>${money(toCents(inp.pool.togoCard))}</b></span>
              <span>Staff reported <b>${money(poolCard - toCents(inp.pool.togoCard))}</b></span>
            </div>
          </div>
          <form method="post" action="/shifts/${sh.id}/pool" class="pool-form">
            <label>Cash you counted <input name="jar" type="number" step="0.01" min="0" value="${sh.pool_jar_cents ? (sh.pool_jar_cents / 100).toFixed(2) : ''}" placeholder="0.00"></label>
            <label>To-go card you counted <input name="togo_card" type="number" step="0.01" min="0" value="${sh.pool_togo_card_cents ? (sh.pool_togo_card_cents / 100).toFixed(2) : ''}" placeholder="0.00"></label>
            <button class="btn" type="submit">Save pool</button>
          </form>
          <p class="pool-hint">Enter only what <b>you</b> counted — anything staff reported on the tips page is already added above.</p>
        </div>
        <div class="pool-dist">
          <div class="pool-lbl">Where it goes${eligible.length ? ` · split by hours across ${eligible.length}` : ''}</div>
          ${eligible.length ? `<div class="dist">${eligible.map((p) => `
            <div class="dist-row">
              <span class="dist-who">${esc(p.name)}<i>${esc(p.role)} · ${p.hours}h</i></span>
              <span class="dist-amt">${money(p.poolCash + p.poolCard)}</span>
            </div>`).join('')}</div>`
            : '<div class="panel-empty">Nobody eligible on this shift yet — add support staff and the pool will split across them.</div>'}
          ${(poolCash + poolCard) > 0 && !eligible.length
            ? `<div class="dist-warn">${money(poolCash + poolCard)} in the pool with nobody to receive it.</div>` : ''}
        </div>
      </div>
    </section>`;

  // =========================================================================
  // BROADSHEET — the shift sheet
  // -------------------------------------------------------------------------
  // A verdict, a stat strip, and a table of who was on. Every form the old
  // workspace had is still here — the person cards became rows, and Edit
  // drives the same startEdit() the cards did, posting to the same endpoint.
  // =========================================================================

  const todayStr = isoDate(startOfToday());
  const verdict = warn.length
    ? `${esc(sh.date === todayStr ? 'Today' : cashDayLabel(sh.date))} · ${esc(dp(sh.daypart))} — <span class="warn">${warn.length === 1 ? 'one thing to sort out' : `${warn.length} things to sort out`}.</span>`
    : `${esc(sh.date === todayStr ? 'Today' : cashDayLabel(sh.date))} · ${esc(dp(sh.daypart))} — <span class="ok">everything checks out.</span>`;

  const statusWord = sh.status === 'emailed' ? 'Emails sent'
    : withHours < people.length ? 'Needs review'
    : people.length ? 'Ready to send' : 'Nobody on it';
  const statusCls = sh.status === 'emailed' ? 'ok' : withHours < people.length ? 'warn' : 'ready';
  const statusLine = `${people.length} on shift · ${ready} of ${people.length} ready · ${withHours}/${people.length} hours in`
    + (warn.length ? ` — ${esc(warn[0])}` : ' — tips reconcile, nobody missing an email');

  const sCell = (label, value, sub, tone) =>
    `<div class="bs-strip-c"><span class="bs-strip-l">${label}</span><span class="bs-stat${tone ? ' ' + tone : ''}">${value}</span><span class="bs-strip-s">${sub}</span></div>`;

  const money0 = (c) => (c ? money(c) : '<span class="bs-em">—</span>');

  // Alcohol is $0 on every service so far. The column only appears if somebody
  // actually rang some — a permanently empty column is a column that teaches
  // you to stop reading the row.
  const anyAlcohol = inp.servers.some((p) => toCents(p.alcohol) > 0);

  const num = (name, val) =>
    `<label class="bs-pill"><span>${name}</span><input name="${name === 'Kitchen' ? 'food' : name.toLowerCase()}" type="text" inputmode="decimal" value="${val || ''}" placeholder="0.00"></label>`;

  const staffRow = ({ p, st: st2 }, isServer) => {
    const e = entries[p.employeeId] || {};
    const id = `edit-${p.employeeId}`;
    return `<details class="bs-srow" id="${id}">
      <summary class="bs-sr bs-staffrow${st2.key === 'ok' ? '' : ' warn'}">
        <span class="bs-sr-n">${esc(p.name)}</span>
        <span class="bs-sr-r">${esc(isServer ? 'server' : p.role)}${p.salaried ? ' · salaried' : ''}</span>
        <span class="bs-sr-f">${isServer ? money0(toCents(p.food)) : '<span class="bs-em">—</span>'}</span>
        <span class="bs-sr-f">${isServer ? money0(toCents(p.coffee)) : '<span class="bs-em">—</span>'}</span>
        ${anyAlcohol ? `<span class="bs-sr-f">${isServer ? money0(toCents(p.alcohol)) : '<span class="bs-em">—</span>'}</span>` : ''}
        <span class="bs-sr-f">${money0(toCents(p.cardTips))}</span>
        <span class="bs-sr-f">${money0(toCents(p.cashTips))}</span>
        <span class="bs-sr-f${Number(p.hours) ? '' : ' miss'}">${Number(p.hours) ? (Math.round(p.hours * 100) / 100).toFixed(2) : 'missing'}</span>
        <span class="bs-sr-f">${p.hourlyRate ? money(toCents(p.hourlyRate)) : '<span class="bs-em">—</span>'}</span>
        ${canWrite() ? '<span class="bs-sr-e">Edit</span>' : '<span></span>'}
      </summary>
      ${canWrite() ? `
      <form class="bs-inline" method="post" action="/shifts/${sh.id}/${isServer ? 'server' : 'support'}">
        <input type="hidden" name="employee_id" value="${p.employeeId}">
        ${isServer ? `
          ${num('Kitchen', e.food)}
          ${num('Coffee', e.coffee)}
          ${num('Alcohol', e.alcohol)}
        ` : `<label class="bs-pill"><span>Role</span><select name="role">${roleOpts(p.role)}</select></label>`}
        <!-- Both tip figures, for everyone. The summary row above has always
             shown card + cash together, the POST has always accepted both, and
             the prefill has always carried both — but the form only ever
             offered card, and only to servers. So a cash figure a staff member
             got wrong could be seen and never corrected. -->
        <label class="bs-pill"><span>Card tips</span><input name="card_tips" type="text" inputmode="decimal" value="${e.card_tips || ''}" placeholder="0.00"></label>
        <label class="bs-pill"><span>Cash tips</span><input name="cash_tips" type="text" inputmode="decimal" value="${e.cash_tips || ''}" placeholder="0.00"></label>
        <label class="bs-pill"><span>Hours</span><input name="hours" type="text" inputmode="decimal" value="${e.hours || ''}" placeholder="0.00"></label>
        <label class="bs-pill"><span>Wage/hr</span><input name="wage" type="text" inputmode="decimal" value="${e.wage || ''}" placeholder="default"></label>
        <button class="bs-btn" type="submit">Save</button>
        <button class="bs-inline-x" type="button" onclick="this.closest('details').open=false">Cancel</button>
      </form>
      ${isServer ? '' : `<p class="bs-inline-note">Tips entered here go into the shared pool and are split
        across support by hours — they are not kept by ${esc(p.name.split(' ')[0])}.</p>`}
      <form class="bs-inline-rm" method="post" action="/shifts/${sh.id}/remove"
            onsubmit="return confirm('Take ${esc(p.name).replace(/'/g, "\\'")} off this shift?')">
        <input type="hidden" name="employee_id" value="${p.employeeId}">
        <button type="submit">Take off this shift</button>
      </form>` : ''}
    </details>`;
  };

  const splitRows = eligible.length ? eligible.map((p) => `
    <div class="bs-lrow"><span>${esc(p.name)} <i class="bs-em">${(Math.round(p.hours * 100) / 100).toFixed(2)}h</i></span>
      <b class="bs-fig">${money(p.poolShare || 0)}</b></div>`).join('') : '';

  const toolScript = `
    <script>
      // One pane at a time. Opening a second closes the first, so the tools
      // never push the table off the screen between them.
      function bsTool(id) {
        var el = document.getElementById(id);
        if (!el) return;
        var open = !el.open;
        document.querySelectorAll('.bs-toolpanes details').forEach(function (d) { d.open = false; });
        el.open = open;
        if (open) el.scrollIntoView({ block: 'nearest' });
      }
      // Saving a staff row used to return you to the top of the sheet. On a
      // seven-person night that meant finding your place again after every
      // single save.
      ${returnToRowScript('edit-', false)}
    </script>`;

  const body = `
    ${flash(req)}
    <div class="bs-page bs-sheet">
      <a class="bs-back" href="/shifts">← Shifts</a>
      <div class="bs-head">
        <div>
          <h1 class="bs-headline">${verdict}</h1>
          <p class="bs-status"><span class="bs-status-w ${statusCls}">${esc(statusWord.toUpperCase())}</span> ${esc(statusLine)}</p>
        </div>
        ${canWrite() ? `<a class="bs-btn" href="/shifts/${sh.id}/results">Preview &amp; send →</a>` : ''}
      </div>

      <div class="bs-strip">
        ${sCell('Server sales', money(totalSales), `${inp.servers.length} server${inp.servers.length === 1 ? '' : 's'}`)}
        ${sCell('Tips collected', money(totalTips), 'card + cash')}
        ${sCell('Shared pool', money(poolCash + poolCard), `${money(poolCash)} cash · ${money(poolCard)} card`)}
        ${sCell('To sort out', String(warn.length), warn.length ? 'see the rows below' : 'nothing outstanding', warn.length ? 'bad' : 'ok')}
      </div>

      ${attention}

      ${canWrite() ? `<div class="bs-tools">
        <button type="button" class="bs-tool" onclick="bsTool('add-staff')">Add a server or edit their numbers</button>
        <button type="button" class="bs-tool" onclick="bsTool('read-photo')">Read from a report photo</button>
        <button type="button" class="bs-tool" onclick="bsTool('the-record')">The record</button>
        <button type="button" class="bs-tool bs-tool-danger" onclick="bsTool('danger')">Delete this shift</button>
      </div>` : ''}
      <div class="bs-toolpanes">
        ${canWrite() ? `
          <details class="bs-x" id="read-photo">
            <summary>Read from a report photo</summary>
            <form method="post" action="/shifts/${sh.id}/read-report" enctype="multipart/form-data" class="bs-form">
              <p class="bs-clear">Snap the end-of-day report (several photos OK). It fills in each server's sales and card tips for you to check.${process.env.ANTHROPIC_API_KEY ? '' : ' <b>Needs an ANTHROPIC_API_KEY in .env first.</b>'}</p>
              <label>Photo(s) <input type="file" name="photos" accept="image/*" multiple ${process.env.ANTHROPIC_API_KEY ? '' : 'disabled'}></label>
              <button class="bs-btn-quiet" type="submit" ${process.env.ANTHROPIC_API_KEY ? '' : 'disabled'}>Read photo</button>
            </form>
          </details>

          <details class="bs-x" id="add-staff">
            <summary>Add a server, or edit their numbers</summary>
            <form method="post" action="/shifts/${sh.id}/server" class="bs-form" id="server-form">
              <label>Server <select name="employee_id" required id="server-emp">${staffOptions}</select></label>
              <label>Food sales <input name="food" type="number" step="0.01" min="0" placeholder="0.00"></label>
              <label>Coffee sales <input name="coffee" type="number" step="0.01" min="0" placeholder="0.00"></label>
              <label>Alcohol sales <input name="alcohol" type="number" step="0.01" min="0" placeholder="0.00"></label>
              <label>Card tips <input name="card_tips" type="number" step="0.01" min="0" placeholder="0.00"></label>
              <label>Hours <input name="hours" type="number" step="0.01" min="0" placeholder="0"></label>
              <label>Wage/hr <input name="wage" type="number" step="0.01" min="0" placeholder="staff default"></label>
              <button class="bs-btn-quiet" type="submit">Save server</button>
            </form>
            <form method="post" action="/shifts/${sh.id}/support" class="bs-form" id="support-form">
              <label>Support <select name="employee_id" required id="support-emp">${staffOptions}</select></label>
              <label>Role <select name="role" id="support-role">${roleOpts('kitchen')}</select></label>
              <label>Hours <input name="hours" type="number" step="0.01" min="0" placeholder="0"></label>
              <label>Wage/hr <input name="wage" type="number" step="0.01" min="0" placeholder="staff default"></label>
              <button class="bs-btn-quiet" type="submit">Save support</button>
            </form>
          </details>` : ''}

          <details class="bs-x" id="the-record"><summary>The record</summary>${submissionsPanel(sh.id)}</details>
          ${notesSection}

        ${canWrite() ? `<details class="bs-x bs-x-danger" id="danger">
            <summary>Delete this shift</summary>
            <p class="bs-clear">Removes the shift and everyone's hours, sales and tips on it. Emails already sent cannot be recalled.</p>
            <form method="post" action="/shifts/${sh.id}/delete"
                  onsubmit="return confirm('Delete the ${sh.date} ${dp(sh.daypart)} shift and all ${Object.keys(entries).length} entries on it? This cannot be undone.')">
              <button class="bs-btn-quiet bs-danger" type="submit">Delete shift</button>
            </form>
          </details>` : ''}
      </div>

      <div class="bs-cols2">
        <div class="bs-col">
          <div class="bs-sec-h"><span class="bs-kicker">On shift · ${people.length}</span></div>

          ${people.length ? `
            <div class="bs-shead bs-staffhead${anyAlcohol ? ' has-alc' : ''}">
              <span>Name</span><span>Role</span><span class="r">Kitchen</span><span class="r">Coffee</span>
              ${anyAlcohol ? '<span class="r">Alcohol</span>' : ''}
              <span class="r">Card</span><span class="r">Cash</span><span class="r">Hrs</span><span class="r">Wage</span><span></span>
            </div>
            <div class="bs-srows${anyAlcohol ? ' has-alc' : ''}">
              ${serverStates.map((x) => staffRow(x, true)).join('')}
              ${supportStates.map((x) => staffRow(x, false)).join('')}
            </div>`
            : '<p class="bs-clear">Nobody on this shift yet. They appear here when they submit, or add them below.</p>'}

          <p class="bs-sheet-note">${subCount(sh.id)} · <a href="#the-record" onclick="document.getElementById('the-record').open=true">Read the record ▸</a></p>

        </div>

        <div class="bs-col">
          <div class="bs-sec-h"><span class="bs-kicker">Shared tip pool</span></div>
          <div class="bs-lrows">
            <div class="bs-lrow"><span>Cash pool</span><b class="bs-fig">${money(poolCash)}</b></div>
            <div class="bs-lrow"><span>To-go card <i class="bs-em">· you ${money(toCents(inp.pool.togoCard))}</i></span><b class="bs-fig">${money(poolCard)}</b></div>
          </div>
          ${eligible.length ? `
            <div class="bs-sec-h bs-split-h"><span class="bs-kicker">Split by hours · ${eligible.length}</span></div>
            <div class="bs-lrows">${splitRows}</div>`
            : `<p class="bs-clear">Nobody eligible yet — add support staff and the pool will split across them.</p>`}
          ${(poolCash + poolCard) > 0 && !eligible.length
            ? `<p class="bs-clear warn">${money(poolCash + poolCard)} in the pool with nobody to receive it.</p>` : ''}
          <p class="bs-sheet-note">Tips staff logged go to the shared pool and split by hours — not kept by whoever reported them.</p>
          ${canWrite() ? `<details class="bs-x">
            <summary>Edit what you counted</summary>
            <form method="post" action="/shifts/${sh.id}/pool" class="bs-form">
              <label>Cash you counted <input name="jar" type="number" step="0.01" min="0" value="${sh.pool_jar_cents ? (sh.pool_jar_cents / 100).toFixed(2) : ''}" placeholder="0.00"></label>
              <label>To-go card you counted <input name="togo_card" type="number" step="0.01" min="0" value="${sh.pool_togo_card_cents ? (sh.pool_togo_card_cents / 100).toFixed(2) : ''}" placeholder="0.00"></label>
              <button class="bs-btn-quiet" type="submit">Save pool</button>
            </form>
          </details>` : ''}
        </div>
      </div>
    </div>
    ${toolScript}

    <div class="stickybar">
      <div class="sticky-in">
        <div class="sticky-txt">
          <b>${sh.date} · ${dp(sh.daypart)}</b>
          <span>${warn.length ? `${warn.length} to sort out` : 'Nothing outstanding'} · ${withHours}/${people.length} hours in</span>
        </div>
        <a class="btn btn-primary" href="/shifts/${sh.id}/results">Preview &amp; send →</a>
      </div>
    </div>

    <script>
      var ENTRIES = ${JSON.stringify(entries)};
      function setVal(form, name, v) { var el = form.querySelector('[name="' + name + '"]'); if (el) el.value = v == null ? '' : v; }
      (function () {
        var f = document.getElementById('server-form'), emp = document.getElementById('server-emp');
        if (!f || !emp) return;
        function sync() {
          var e = ENTRIES[emp.value] || {};
          ['food', 'coffee', 'alcohol', 'card_tips', 'hours', 'wage'].forEach(function (k) { setVal(f, k, e[k]); });
        }
        emp.addEventListener('change', sync); sync();
      })();
      (function () {
        var f = document.getElementById('support-form'), emp = document.getElementById('support-emp'), role = document.getElementById('support-role');
        if (!f || !emp) return;
        function sync() {
          var e = ENTRIES[emp.value] || {};
          var opt = emp.options[emp.selectedIndex];
          if (role) role.value = e.role || (opt && opt.getAttribute('data-role')) || role.value;
          ['hours', 'wage'].forEach(function (k) { setVal(f, k, e[k]); });
        }
        emp.addEventListener('change', sync); sync();
      })();

      // In-place editing, kept from the table version: tapping Edit swaps just
      // that card's figures for inputs. No modal, no page jump, no losing your
      // place halfway down a shift.
      function startEdit(emp, kind) {
        var card = document.querySelector('.pcard[data-emp="' + emp + '"][data-kind="' + kind + '"]');
        var e = ENTRIES[emp] || {};
        card.classList.add('pcard-editing');
        card.querySelectorAll('[data-edit]').forEach(function (cell) {
          var f = cell.getAttribute('data-edit'),
              step = cell.getAttribute('data-step') || '0.01',
              ph = cell.getAttribute('data-ph') || '';
          var lab = cell.querySelector('span').textContent;
          cell.innerHTML = '<span>' + lab + '</span>' +
            '<input class="cell-in" data-f="' + f + '" type="number" step="' + step + '" min="0" placeholder="' + ph + '" value="' + (e[f] == null ? '' : e[f]) + '">';
        });
        card.querySelector('.pcard-act').innerHTML =
          '<button type="button" class="btn btn-sm btn-primary" onclick="saveEdit(' + emp + ',\\'' + kind + '\\')">Save</button>' +
          '<button type="button" class="btn btn-sm btn-ghost" onclick="location.reload()">Cancel</button>';
        var first = card.querySelector('.cell-in'); if (first) first.focus();
      }
      function saveEdit(emp, kind) {
        var card = document.querySelector('.pcard[data-emp="' + emp + '"][data-kind="' + kind + '"]');
        var e = ENTRIES[emp] || {};
        var form = document.createElement('form');
        form.method = 'post';
        form.action = '/shifts/${sh.id}/' + (kind === 'server' ? 'server' : 'support');
        function add(n, v) { var i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v == null ? '' : v; form.appendChild(i); }
        add('employee_id', emp);
        card.querySelectorAll('.cell-in').forEach(function (inp) { add(inp.getAttribute('data-f'), inp.value); });
        if (kind === 'server') { add('alcohol', e.alcohol || 0); }   // not shown on the card, keep it
        else { add('role', e.role); }                                 // keep their role
        document.body.appendChild(form); form.submit();
      }
    </script>`;
  res.send(layout(`${sh.date} ${sh.daypart}`, body));
});

app.post('/shifts/:id/delete', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  s.deleteShift(sh.id);
  res.redirect('/shifts?msg=' + encodeURIComponent(`Deleted the ${sh.date} ${dp(sh.daypart)} shift and everything on it.`));
});

// Blank means "leave it alone", so the add-a-server form (which has no cash
// field) can't wipe what staff already reported. An explicit 0 still writes —
// that's how you record someone who genuinely took nothing home.
function writeTipsIfGiven(shiftId, empId, body) {
  const given = (k) => body[k] !== undefined && String(body[k]).trim() !== '';
  if (given('cash_tips')) {
    w.setCashTips.run({ shift_id: shiftId, employee_id: empId, cash_tips_cents: toCents(body.cash_tips), by: 'manager' });
  }
  if (given('card_tips')) {
    w.setCardTips.run({ shift_id: shiftId, employee_id: empId, card_tips_cents: toCents(body.card_tips) });
  }
}

/**
 * Record a manager edit alongside staff submissions, so the history answers
 * "who changed this" and not just "what did staff say". Only logged when a
 * figure was actually supplied — saving hours alone isn't a tip correction.
 */
function logManagerEdit(shiftId, empId, role, body) {
  const given = (k) => body[k] !== undefined && String(body[k]).trim() !== '';
  if (!['cash_tips', 'card_tips', 'food', 'coffee', 'alcohol'].some(given)) return;
  submissions.add.run({
    shift_id: shiftId, employee_id: empId, role: role || null,
    cash_tips_cents: given('cash_tips') ? toCents(body.cash_tips) : null,
    card_tips_cents: given('card_tips') ? toCents(body.card_tips) : null,
    food_cents: given('food') ? toCents(body.food) : null,
    coffee_cents: given('coffee') ? toCents(body.coffee) : null,
    alcohol_cents: given('alcohol') ? toCents(body.alcohol) : null,
    note: null, source: 'manager',
  });
}

app.post('/shifts/:id/server', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  const empId = Number(req.body.employee_id);
  w.upsertWork.run({ shift_id: sh.id, employee_id: empId, role: 'server', hours: Number(req.body.hours) || 0, hourly_rate_cents: toCents(req.body.wage) });
  w.upsertSales.run({
    shift_id: sh.id, employee_id: empId,
    food_cents: toCents(req.body.food), coffee_cents: toCents(req.body.coffee),
    alcohol_cents: toCents(req.body.alcohol),
  });
  writeTipsIfGiven(sh.id, empId, req.body);
  logManagerEdit(sh.id, empId, 'server', req.body);
  res.redirect(`/shifts/${sh.id}?msg=` + encodeURIComponent('Server saved.') + `#edit-${empId}`);
});

app.post('/shifts/:id/support', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  const empId = Number(req.body.employee_id);
  w.upsertWork.run({
    shift_id: sh.id, employee_id: empId,
    role: req.body.role, hours: Number(req.body.hours) || 0, hourly_rate_cents: toCents(req.body.wage),
  });
  writeTipsIfGiven(sh.id, empId, req.body);
  logManagerEdit(sh.id, empId, req.body.role, req.body);
  res.redirect(`/shifts/${sh.id}?msg=` + encodeURIComponent('Support saved.') + `#edit-${empId}`);
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
      alcohol_cents: toCents(row.alcohol),
    });
    // Card tips are written separately now — upsertSales no longer owns them,
    // so a blank field cannot zero a figure somebody already reported.
    if (row.card_tips != null && String(row.card_tips).trim() !== '') {
      w.setCardTips.run({ shift_id: sh.id, employee_id: emp.id, card_tips_cents: toCents(row.card_tips) });
    }
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

/**
 * Everything worth knowing before a shift's emails go out. Shared by the
 * results page and the manager's own copy, so the two can't drift apart.
 */
function shiftWarnings(sh, inp, r) {
  const warn = [];
  const notes = [];
  if (!r.reconciliation.balanced) warn.push('Tip totals do not reconcile — check the numbers.');
  for (const o of r.orphanedPots) warn.push(`${money(o.cents)} is owed to “${o.role}” but nobody worked that role. Add them or the money is unassigned.`);
  for (const c of r.poolConflicts) warn.push(`Your tip-out policy has two rules paying out the same ${c.source === 'card' ? 'to-go card' : 'cash jar'} money (the “${c.rule}” rule). It was only paid once — fix the duplicate on the tip-out policy page.`);
  // Nobody worked a tipped-out role, so it wasn't charged. Running without a
  // busser is a normal short-staffed night; running without a cook is almost
  // always someone forgotten on the shift, so that one gets flagged louder.
  for (const sk of r.skippedPots) {
    const line = `No ${sk.role} worked this shift, so the ${sk.role} tip-out wasn’t charged — servers kept ${money(sk.cents)}.`;
    if (sk.role === 'busser') notes.push(line);
    else warn.push(line + ` If ${sk.role} was actually working, add them below and the tip-out will apply.`);
  }
  // Staff who report on the tips page land on the shift with 0 hours until you
  // enter them. Everything is split by hours, so leaving it at 0 pays them
  // nothing — including their own share of tips they reported.
  const noHours = inp.support.filter((p) => !Number(p.hours)).map((p) => p.name);
  if (noHours.length) {
    warn.push('No hours entered for: ' + noHours.join(', ')
      + ' — the pool is split by hours, so they get $0 until you add them.');
  }
  // Servers land here too — from the tips page, the photo reader, or the POS
  // feed, none of which know hours. Their tip-out is sales-based so it stays
  // right, but the wage on their email and in payroll would read $0.
  const noHoursServers = inp.servers.filter((p) => !Number(p.hours) && !p.salaried).map((p) => p.name);
  if (noHoursServers.length) {
    warn.push('No hours entered for: ' + noHoursServers.join(', ')
      + ' — their tips are correct, but their wage and payroll hours will be $0.');
  }
  const missingEmail = [...inp.servers, ...inp.support].filter((p) => !p.email).map((p) => p.name);
  if (missingEmail.length) warn.push('No email on file for: ' + missingEmail.join(', ') + '. Add it under Staff.');
  const noCash = inp.servers.filter((sv) => !sv.cashEnteredBy).map((sv) => sv.name);
  if (noCash.length) warn.push('Cash tips not entered yet for: ' + noCash.join(', ') + '. They can add them on the cash-tip page.');
  // A server with tips but no sales means the tip-out is being computed off $0.
  const noSales = inp.servers
    .filter((sv) => (toCents(sv.cardTips) + toCents(sv.cashTips)) > 0 && (toCents(sv.food) + toCents(sv.coffee) + toCents(sv.alcohol)) === 0)
    .map((sv) => sv.name);
  if (noSales.length) warn.push('No sales recorded for: ' + noSales.join(', ') + ' — their tip-out will calculate as $0. Add their sales below.');
  return { warn, notes };
}

app.get('/shifts/:id/results', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).send(layout('Not found', '<h1>Shift not found</h1>'));
  const inp = shiftInputs(sh.id);
  const r = runShift(inp, policyForShift(sh));
  const { warn, notes } = shiftWarnings(sh, inp, r);


  // Per-person send. Someone not receiving theirs shouldn't mean re-sending to
  // everybody — and showing the address inline is how you spot the typo that
  // caused it in the first place.
  const emailOf = new Map([...inp.servers, ...inp.support].map((p) => [p.employeeId, p.email]));
  const sendRow = (empId, name) => {
    const to = emailOf.get(empId);
    if (!to) {
      return `<div class="card-send card-send-none">
        <span title="Add an address under Staff">No email on file</span>
        <a class="btn btn-sm" href="/employees">Add it</a>
      </div>`;
    }
    return `<div class="card-send">
      <span class="send-to" title="${esc(to)}">${esc(to)}</span>
      <span class="send-acts">
        <a class="link" href="/shifts/${sh.id}/email/${empId}" target="_blank">Preview</a>
        <form method="post" action="/shifts/${sh.id}/send-one" style="margin:0"
              onsubmit="return confirm('Send ${esc(name).replace(/'/g, "\\'")} their summary again?')">
          <input type="hidden" name="employee_id" value="${empId}">
          <button class="link" type="submit">Send</button>
        </form>
      </span>
    </div>`;
  };

  const serverCards = r.servers.map((p) => `
    <div class="card">
      <div class="card-head"><strong>${esc(p.name)}</strong><span class="pill">server · ${p.hours}h</span></div>
      <div class="kv"><span>Total tips</span><b>${money(p.totalTips)}</b></div>
      <div class="kv sub"><span>tip-out</span><span>-${money(p.tipoutTotal)}</span></div>
      <div class="kv total"><span>Keeps</span><b class="pos">${money(p.tipsKept)}</b></div>
      ${sendRow(p.employeeId, p.name)}
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
      ${sendRow(p.employeeId, p.name)}
    </div>`;
  }).join('');

  const potTiles = Object.keys(r.pots).filter((role) => r.pots[role]).map((role) =>
    `<div class="pot"><span>${role} pool</span><b>${money(r.pots[role])}</b></div>`).join('');
  const poolTile = r.pool.total ? `<div class="pot"><span>Jar + to-go pool</span><b>${money(r.pool.total)}</b></div>` : '';

  const mailReady = mailStatus().ready;
  const totalTips = r.reconciliation.totalTipsCollected;
  const body = `
    ${flash(req)}
    <a class="back" href="/shifts/${sh.id}">← Back to entry</a>
    <div class="page-head"><div><h1>${sh.date} · ${dp(sh.daypart)}</h1><p class="sub">Tip-out results — review, then send everyone their email.</p></div>
      <form method="post" action="/shifts/${sh.id}/send" style="margin:0"><button class="btn btn-primary" type="submit">${mailReady ? 'Send emails to all' : 'Generate previews'}</button></form></div>
    ${warn.length ? `<div class="flash flash-warn"><div><b>Before you send:</b><ul>${warn.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
    ${notes.length ? `<div class="flash flash-info"><div><ul>${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
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

/** Where the manager's own copy goes. */
function managerEmail() {
  const mgr = q.allEmployees.all().find((e) => e.role === 'manager' && e.email);
  return (mgr && mgr.email) || process.env.MAIL_FROM || process.env.GMAIL_USER || null;
}

app.post('/shifts/:id/send-one', async (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  const empId = Number(req.body.employee_id);
  const back = (msg, err) => res.redirect(`/shifts/${sh.id}/results?msg=` + encodeURIComponent(msg) + (err ? '&err=1' : ''));

  const inp = shiftInputs(sh.id);
  const r = runShift(inp, policyForShift(sh));
  const one = buildEmails(r, { date: sh.date, daypart: sh.daypart }, peopleMap(inp))
    .find((e) => e.employeeId === empId);
  if (!one) return back('That person is not on this shift.', true);
  if (!one.to) return back(`${one.name} has no email address. Add one under Staff, then send again.`, true);

  const out = await sendEmails([one]);
  if (out.errors.length) return back(`Could not send to ${one.name}: ${out.errors[0]}`, true);
  return back(out.sent
    ? `Sent ${one.name}'s summary to ${one.to}.`
    : `Mail isn't connected, so ${one.name}'s email was written as a preview file instead.`, !out.sent);
});

app.post('/shifts/:id/send', async (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  const inp = shiftInputs(sh.id);
  const r = runShift(inp, policyForShift(sh));
  const emails = buildEmails(r, { date: sh.date, daypart: sh.daypart }, peopleMap(inp));
  const result = await sendEmails(emails);
  s.markEmailed.run(sh.id);

  // Your own copy: confirmation of who received what, and the totals. Sent
  // after the staff emails so it reports what actually happened, and kept
  // separate so a failure here can't stop staff getting theirs.
  const to = managerEmail();
  if (to) {
    try {
      const receipt = managerShiftEmail(r, {
        date: sh.date, daypart: sh.daypart, managerEmail: to,
        warnings: shiftWarnings(sh, inp, r).warn,
      }, result);
      await sendEmails([{ ...receipt, name: 'manager-receipt' }]);
    } catch { /* your copy is a convenience — never let it break the send */ }
  }

  let msg;
  if (result.sent) msg = `Sent ${result.sent} emails.` + (result.errors.length ? ` ${result.errors.length} failed.` : '') + (to ? ` A copy went to ${to}.` : '');
  else msg = `Wrote ${result.previewed} preview files to /previews (open them to see each email).`;
  res.redirect(`/shifts/${sh.id}/results?msg=` + encodeURIComponent(msg) + (result.errors.length ? '&err=1' : ''));
});

// ---------------------------------------------------------------------------
// Staff cash-tip page (NO LOGIN — name + PIN)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// STAFF TIP PAGE — PIN in, then the form. The PIN identifies the person, so it
// never leaves the server: step 2 carries a short-lived signed token instead.
// ---------------------------------------------------------------------------
const TIPS_TTL = 45 * 60 * 1000; // long enough to fill the form, short enough to expire on a shared phone

function tipsToken(empId) {
  const exp = Date.now() + TIPS_TTL;
  return `${empId}.${exp}.${sign(`tips:${empId}:${exp}`)}`;
}

function readTipsToken(raw) {
  const [id, exp, sig] = String(raw || '').split('.');
  if (!id || !exp || !sig) return null;
  if (sig !== sign(`tips:${id}:${exp}`)) return null;
  if (Number(exp) < Date.now()) return null;
  const emp = q.employee.get(Number(id));
  return emp && emp.active ? emp : null;
}

/** The jobs this person can report, from what you've assigned them in Staff. */
function rolesForEmployee(emp) {
  const extra = q.rolesForEmployee.all(emp.id).map((r) => r.role);
  const list = [...new Set([emp.role, ...extra])].filter((r) => r && r !== 'manager');
  return list.length ? list : allRoles().filter((r) => r !== 'manager');
}

// Staff keep this on a home screen for months, so a cached copy can outlive a
// change to the form and post fields the server no longer expects. Never cache
// the HTML — it's a few KB, and a stale copy costs someone their tips at 1am.
// Tiny endpoint the pages poll to notice they're out of date. It also reports
// the server's clock: every business date comes from local time, so a host left
// on UTC files a late close under the next day with nothing looking wrong.
app.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = new Date();
  res.json({
    build: BUILD,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    businessDate: isoDate(now),
    localTime: now.toLocaleString('en-US', { hour12: true }),
  });
});

app.use(['/tips', '/tips/start'], (req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});

app.get('/tips', (req, res) => {
  // Success screen after a submit.
  if (req.query.done === '1') {
    const card = String(req.query.card || '');
    const cash = String(req.query.cash || '0.00');
    const tot = (Number(cash) || 0) + (card === '' ? 0 : Number(card) || 0);
    const row = (k, v) => `<div class="tp-tot-r"><span>${k}</span><b>${v}</b></div>`;
    // Thousands separators, same as everywhere else money is printed. "$1280.50"
    // is a figure you have to stop and parse; "$1,280.50" you just read.
    const usd = (v) => '$' + (Number(v) || 0).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const body = `
      <div class="tp">
        <div class="tp-navbar">
          <span></span>
          <span class="tp-navt">Recorded</span>
          <span class="tp-count"><b>3</b> / 3</span>
        </div>

        <div class="tp-body">
          <div class="tp-prog"><span class="on"></span><span class="on"></span><span class="on"></span></div>
          <p class="tp-done-k">Sent to your manager</p>
          <h1 class="tp-h">Thanks${req.query.name ? ', ' + esc(req.query.name) : ''}.</h1>
          <p class="tp-lead">Your tips are logged. You'll get an email with your full breakdown
            once your manager closes the shift.</p>

          <div class="tp-receipt">
            <div class="tp-tot-h">What you sent</div>
            ${row('Date', esc(req.query.date || '') + (req.query.shift ? ' &middot; ' + esc(req.query.shift) : ''))}
            ${req.query.position ? row('Worked as', esc(String(req.query.position).replace(/^./, (c) => c.toUpperCase()))) : ''}
            ${req.query.sales ? row('Sales rung', esc(usd(req.query.sales))) : ''}
            ${row('Cash tips', esc(usd(cash)))}
            ${card !== '' ? row('Card tips', esc(usd(card))) : ''}
            <div class="tp-tot-r sum"><span>Total tips</span><b>${esc(usd(tot))}</b></div>
          </div>

          <p class="tp-help">Wrong? Submit again with the right details &mdash; the newest one wins,
            and your manager can correct anything.</p>
        </div>

        <div class="tp-foot">
          <a class="tp-go" href="/tips">Log another shift</a>
        </div>
        <div class="tp-build">${esc(RESTAURANT)} &middot; v${esc(BUILD)}</div>
      </div>`;
    return res.send(layout('Recorded', body, { bare: true, staff: true }));
  }

  // Sign in. Nobody's name is on the page until a PIN is verified, so an open
  // link never publishes the staff roster.
  const err = req.query.err === '1'
    ? `<div class="tp-err">${esc(req.query.msg || 'Something went wrong.')}</div>` : '';

  const body = `
    <div class="tp">
      <div class="tp-top">
        <span class="tp-mark">${esc(markOf(RESTAURANT))}</span>
        <div class="tp-who">
          <div class="tp-brand">${esc(RESTAURANT)}</div>
          <div class="tp-name">Staff portal</div>
        </div>
      </div>

      <div class="tp-body">
        <h1 class="tp-h">Log your tips.</h1>
        <p class="tp-lead">Enter your ${PIN_LEN}-digit PIN to start. Ask your manager if you don't have one.</p>
        ${err}

        <form method="post" action="/tips/start" id="pinform">
          <div class="tp-sec tp-signin">
            <div class="tp-seck">Your PIN</div>
            <div class="tp-pin" id="cells">
              ${Array.from({ length: PIN_LEN }, (_, i) =>
                `<div class="tp-cell${i === 0 ? ' at' : ''}" data-i="${i}"></div>`).join('')}
            </div>
            <p class="tp-pinmsg" id="pinmsg" hidden>Enter all ${PIN_LEN} digits.</p>
          </div>

          <!-- The keypad is ours, not the phone's. A system numeric keyboard
               covers two thirds of the screen, shows a "done" button that does
               nothing here, and on iOS drags the layout around when it opens.
               The input stays in the DOM so a desktop keyboard and password
               managers still work; it is just never focused on a touch device. -->
          <input type="text" name="pin" id="pin" inputmode="none" autocomplete="off"
            maxlength="${PIN_LEN}" pattern="[0-9]*" required
            style="position:absolute;opacity:0;width:1px;height:1px;padding:0;border:0">

          <div class="tp-keys" id="keys">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
              `<button type="button" data-k="${n}">${n}</button>`).join('')}
            <span></span>
            <button type="button" data-k="0">0</button>
            <button type="button" class="ghost" data-k="del" aria-label="Delete">&#9003;</button>
          </div>
        </form>
      </div>

      <div class="tp-foot">
        <button class="tp-go" type="submit" form="pinform" id="go">Continue &rarr;</button>
      </div>
      <div class="tp-build">${esc(RESTAURANT)} &middot; v${esc(BUILD)}</div>
    </div>
    ${pinScript()}`;
  res.send(layout('Log your tips', body, { bare: true, staff: true }));
});

/**
 * The PIN is four digits everywhere — the staff form says so, and every PIN on
 * record is four long. The keypad draws exactly this many cells, so the two
 * cannot drift: /employees refuses to save any other length.
 */
const PIN_LEN = 4;

/** Two letters for the round mark in the staff header — "Palm Vintage" → PV. */
const markOf = (name) => String(name || 'ZWIN')
  .split(/\s+/).map((w) => w[0]).filter(Boolean).join('').slice(0, 2).toUpperCase() || 'Z';

function pinScript() {
  return `<script>
  (function () {
    var input = document.getElementById('pin');
    var cells = document.getElementById('cells');
    var keys = document.getElementById('keys');
    var go = document.getElementById('go');
    var form = document.getElementById('pinform');
    if (!input || !cells || !keys || !go || !form) return;
    var LEN = ${PIN_LEN};

    function draw() {
      var v = input.value;
      var boxes = cells.children;
      for (var i = 0; i < boxes.length; i++) {
        boxes[i].className = 'tp-cell' + (i < v.length ? ' filled' : (i === v.length ? ' at' : ''));
      }
      if (v.length) document.getElementById('pinmsg').hidden = true;
    }
    function push(d) {
      if (input.value.length >= LEN) return;
      input.value += d;
      draw();
      // Four digits in and there is nothing else to decide, so go. Saves a tap
      // at the one moment the person is holding a till float in the other hand.
      if (input.value.length === LEN) setTimeout(function () { form.requestSubmit ? form.requestSubmit() : form.submit(); }, 130);
    }
    // Solid from the first paint, the way the design has it — an incomplete
    // PIN is answered in words rather than by a button that looks broken.
    // Native validation would point its bubble at an input nobody can see.
    document.getElementById('pinform').addEventListener('submit', function (e) {
      if (input.value.length !== LEN) { e.preventDefault(); document.getElementById('pinmsg').hidden = false; }
    });
    keys.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-k]');
      if (!b) return;
      if (b.dataset.k === 'del') { input.value = input.value.slice(0, -1); draw(); return; }
      push(b.dataset.k);
    });
    // A real keyboard still works — desktop, and anyone using a bluetooth one.
    document.addEventListener('keydown', function (e) {
      if (e.key >= '0' && e.key <= '9') { push(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { input.value = input.value.slice(0, -1); draw(); e.preventDefault(); }
    });
    draw();
  })();
  </script>`;
}

/**
 * The end-of-shift report, in two steps.
 *
 * One <form> and one POST — the steps are two panels the page switches
 * between, not two round trips. That keeps the server contract exactly as it
 * was, means nothing is half-saved if someone closes the tab on step 2, and
 * degrades to the old single scroll if the JavaScript never runs: step 2 is
 * hidden by script, not by markup.
 *
 * The progress bar reads "of 3". The third is the confirmation screen, which
 * is a real step from where the person is standing — they are not finished
 * until they have seen it.
 */
function tipsFormPage(emp, opts = {}) {
  const today = isoDate();
  const err = opts.err ? `<div class="tp-err">${esc(opts.err)}</div>` : '';
  const token = tipsToken(emp.id);
  const first = emp.name.split(' ')[0];

  // Only the jobs you've given them in Staff. One role each for most people,
  // so it shows as a fixed line rather than a menu they could get wrong.
  const roles = rolesForEmployee(emp);
  const label = (r) => r[0].toUpperCase() + r.slice(1);
  const positionField = roles.length > 1
    ? `<div class="tp-row">
         <select name="position" id="tip-position" class="tp-sel-role" required>
           ${roles.map((r) => `<option value="${r}"${r === emp.role ? ' selected' : ''}>${label(r)}</option>`).join('')}
         </select>
         <span class="tp-row-h">pick what you actually did &mdash; it decides how your tips are handled</span>
       </div>`
    : `<div class="tp-row">
         <span class="tp-row-v">${esc(label(roles[0]))}</span>
         <input type="hidden" name="position" id="tip-position" value="${esc(roles[0])}">
         <span class="tp-row-h">worked something else? tell your manager</span>
       </div>`;

  const money = (name, extra = '') =>
    `<div class="tp-money${extra.includes('big') ? ' big' : ''}">
      <span class="cur">$</span>
      <input name="${name}" id="f-${name}" type="text" inputmode="decimal"
        autocomplete="off" placeholder="0.00" data-money>
      <span class="tp-step2">
        <button type="button" tabindex="-1" data-bump="${name}" data-by="1" aria-label="Add a dollar">&#9650;</button>
        <button type="button" tabindex="-1" data-bump="${name}" data-by="-1" aria-label="Take off a dollar">&#9660;</button>
      </span>
    </div>`;

  const body = `
    <div class="tp">
      <!-- step 1 header: who you are -->
      <div class="tp-top" data-when="1">
        <span class="tp-mark">${esc(markOf(RESTAURANT))}</span>
        <div class="tp-who">
          <div class="tp-brand">${esc(RESTAURANT)}</div>
          <div class="tp-name">Hi ${esc(first)}</div>
        </div>
        <a href="/tips">Not you?</a>
      </div>

      <!-- step 2 header: back out of it -->
      <div class="tp-navbar" data-when="2" hidden>
        <button type="button" class="tp-back" data-goto="1">&larr; Back</button>
        <span class="tp-navt">Your tips</span>
        <span class="tp-count"><b>2</b> / 3</span>
      </div>

      <form method="post" action="/tips" id="report">
        <input type="hidden" name="token" value="${token}">

        <div class="tp-body">
          <div data-when="1">
            <h1 class="tp-h">End-of-shift report.</h1>
            <p class="tp-lead">Fill this in when you close out. Your manager only sees the totals.</p>
            ${err}
          </div>

          <div class="tp-prog">
            <span class="on"></span><span data-seg="2"></span><span data-seg="3"></span>
          </div>
          <p class="tp-stepk" id="stepk">Step 1 of 3 &middot; who &amp; when</p>

          <!-- ---------------- step 1 ---------------- -->
          <div id="step1">
            <div class="tp-sec">
              <div class="tp-seck">What you worked</div>
              ${positionField}
            </div>

            <div class="tp-sec">
              <div class="tp-seck">Date you worked</div>
              <div class="tp-row">
                <span class="tp-date" id="datetext">${esc(usDate(today))}</span>
                <input type="date" name="date" id="f-date" value="${today}" max="${today}" required hidden>
                <button type="button" class="tp-link" id="datechange">change</button>
              </div>
            </div>

            <div class="tp-sec">
              <div class="tp-seck">Which shift</div>
              <!-- Nothing is preselected. A default here is a guess, and a
                   guess that is wrong files somebody's tips against the wrong
                   service — which the manager then has to unpick by hand. -->
              <div class="tp-toggle">
                <input type="radio" name="daypart" id="dp-cafe" value="cafe" required>
                <label for="dp-cafe">Caf&eacute; <span class="tick">&#10003;</span></label>
                <input type="radio" name="daypart" id="dp-dinner" value="dinner" required>
                <label for="dp-dinner">Dinner <span class="tick">&#10003;</span></label>
              </div>
              <p class="tp-pick" id="pickshift" hidden>Choose which shift you worked to carry on.</p>
            </div>

            <div class="tp-sec" id="server-sales">
              <div class="tp-seck">Your sales tonight</div>
              <div class="tp-field">
                <span class="tp-label">Kitchen / food sales</span>
                ${money('food')}
              </div>
              <div class="tp-field">
                <span class="tp-label">Coffee &amp; beverage sales</span>
                ${money('coffee')}
              </div>
              <div class="tp-field">
                <span class="tp-label">Alcohol sales <i>&middot; leave blank if none</i></span>
                ${money('alcohol')}
              </div>
            </div>
          </div>

          <!-- ---------------- step 2 ---------------- -->
          <div id="step2">
            <div class="tp-field" style="margin-top:0">
              <span class="tp-label">Cash tips you took home</span>
              ${money('cash_tips', 'big')}
            </div>

            <div class="tp-field">
              <span class="tp-label">Card tips</span>
              ${money('card_tips')}
              <p class="tp-help">From your closeout slip. Leave blank if you don't have it.</p>
            </div>

            <div class="tp-field">
              <span class="tp-label">Note <i>&middot; optional</i></span>
              <textarea name="note" class="tp-note" maxlength="500"
                placeholder="Anything unusual about tonight's numbers, or a message for your manager&hellip;"></textarea>
            </div>

            <div class="tp-tot">
              <div class="tp-tot-h">Tonight's totals &mdash; what your manager sees</div>
              <div class="tp-tot-r" id="row-sales"><span>Sales rung</span><b id="t-sales">$0.00</b></div>
              <div class="tp-tot-r"><span>Cash tips</span><b id="t-cash">$0.00</b></div>
              <div class="tp-tot-r"><span>Card tips</span><b id="t-card">$0.00</b></div>
              <div class="tp-tot-r sum"><span>Total tips</span><b id="t-tips">$0.00</b></div>
            </div>
          </div>
        </div>
      </form>

      <div class="tp-foot">
        <button class="tp-go" type="button" id="next" data-when="1">Next: your tips &rarr;</button>
        <button class="tp-go" type="submit" form="report" data-when="2" hidden>Submit report</button>
        <p class="tp-reassure" data-when="2" hidden>You can edit until your manager sends the shift.</p>
      </div>
      <div class="tp-build" data-when="1">${esc(RESTAURANT)} &middot; v${esc(BUILD)}</div>
    </div>
    ${reportScript()}`;
  return layout('Log your tips', body, { bare: true, staff: true });
}

/** 2026-07-22 → "07 / 22 / 2026", the way the mock reads a date back. */
function usDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${m} / ${d} / ${y}`;
}

function reportScript() {
  return `<script>
  (function () {
    var form = document.getElementById('report');
    if (!form) return;
    var $ = function (id) { return document.getElementById(id); };
    var at = 1;

    // Step 2 is hidden HERE rather than in the markup: if this script never
    // runs, the page is the single long form it has always been, and the
    // submit button at the bottom still posts every field.
    $('step2').hidden = true;
    var showFor = function (n) {
      var all = document.querySelectorAll('[data-when]');
      for (var i = 0; i < all.length; i++) all[i].hidden = all[i].dataset.when !== String(n);
    };

    function go(n) {
      at = n;
      $('step1').hidden = n !== 1;
      $('step2').hidden = n !== 2;
      showFor(n);
      $('stepk').textContent = n === 1 ? 'Step 1 of 3 · who & when' : 'Step 2 of 3 · your tips';
      var seg = document.querySelector('[data-seg="2"]');
      if (seg) seg.className = n >= 2 ? 'on' : '';
      window.scrollTo(0, 0);
      total();
    }
    go(1);

    // --- step 1 gate -------------------------------------------------------
    // The shift is deliberately unset, so this is the one thing that can stop
    // you moving on. Everything else is allowed to be blank.
    $('next').addEventListener('click', function () {
      var picked = form.querySelector('input[name="daypart"]:checked');
      if (!picked) {
        $('pickshift').hidden = false;
        $('pickshift').scrollIntoView({ block: 'center' });
        return;
      }
      go(2);
    });
    form.addEventListener('change', function (e) {
      if (e.target.name === 'daypart') $('pickshift').hidden = true;
    });
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-goto]');
      if (b) go(Number(b.dataset.goto));
    });

    // --- the date reads as text until you want to change it ----------------
    var dc = $('datechange');
    if (dc) dc.addEventListener('click', function () {
      var f = $('f-date');
      f.hidden = false; $('datetext').hidden = true; dc.hidden = true;
      if (f.showPicker) { try { f.showPicker(); } catch (err) { f.focus(); } } else f.focus();
    });

    // --- steppers ----------------------------------------------------------
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-bump]');
      if (!b) return;
      var f = $('f-' + b.dataset.bump);
      var v = Math.round((parseFloat(f.value) || 0) * 100) + Number(b.dataset.by) * 100;
      if (v < 0) v = 0;
      f.value = (v / 100).toFixed(2);
      total();
    });

    // --- sales are a server thing ------------------------------------------
    var pos = $('tip-position');
    var sales = $('server-sales');
    function syncSales() {
      var isServer = pos.value === 'server';
      sales.hidden = !isServer;
      $('row-sales').hidden = !isServer;
      total();
    }
    if (pos && sales) { pos.addEventListener('change', syncSales); syncSales(); }

    // --- running totals ----------------------------------------------------
    // The trust feature. Someone who can see what their manager will see is
    // far less likely to submit a number they meant to fix later.
    function cents(id) { return Math.round((parseFloat(($(id) || {}).value) || 0) * 100); }
    function usd(c) { return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function total() {
      var isServer = !pos || pos.value === 'server';
      var s = isServer ? cents('f-food') + cents('f-coffee') + cents('f-alcohol') : 0;
      var cash = cents('f-cash_tips');
      var card = cents('f-card_tips');
      $('t-sales').textContent = usd(s);
      $('t-cash').textContent = usd(cash);
      $('t-card').textContent = usd(card);
      $('t-tips').textContent = usd(cash + card);
    }
    form.addEventListener('input', total);

    // Tidy a figure when you leave it: "128" reads back as "128.00", the way
    // the totals panel below already prints it. Done on blur, never while
    // typing — reformatting under someone's fingers moves the caret.
    form.addEventListener('focusout', function (e) {
      var el = e.target;
      if (!el.hasAttribute || !el.hasAttribute('data-money')) return;
      var raw = String(el.value).trim();
      if (raw === '') return;
      var n = parseFloat(raw);
      el.value = isFinite(n) && n >= 0 ? n.toFixed(2) : '';
      total();
    });
    total();
  })();
  </script>`;
}

app.post('/tips/start', (req, res) => {
  const pin = String(req.body.pin || '').trim();
  const matches = pin ? q.staffByPin.all(pin) : [];
  if (matches.length !== 1) {
    return res.redirect('/tips?err=1&msg=' + encodeURIComponent(
      matches.length > 1
        ? 'That PIN is set up for more than one person. Tell your manager so it can be fixed.'
        : "That PIN wasn't recognised. Check it and try again, or ask your manager."));
  }
  res.send(tipsFormPage(matches[0]));
});

/**
 * A phone still showing the pre-PIN-first page posts a name and PIN with no
 * token. That page is perfectly valid to its user — they typed their PIN and
 * pressed submit — so accept it rather than losing their entry. Same check the
 * old flow made, so no weaker than what it replaced.
 */
function legacyAuth(body) {
  const id = Number(body.employee_id);
  const pin = String(body.pin || '').trim();
  if (!id || !pin) return null;
  const e = q.employee.get(id);
  if (!e || !e.active || e.role === 'manager') return null;
  return String(e.pin || '') === pin ? e : null;
}

app.post('/tips', (req, res) => {
  const fail = (msg) => res.redirect('/tips?err=1&msg=' + encodeURIComponent(msg));
  const emp = readTipsToken(req.body.token) || legacyAuth(req.body);
  if (!emp) {
    // Distinguish a genuinely stale token from a wrong PIN on an old page.
    return fail(req.body.employee_id
      ? "That PIN doesn't match the name selected. Check it and try again — nothing was saved."
      : 'That took too long and timed out. Enter your PIN and try again — nothing was saved.');
  }

  const date = String(req.body.date || '').slice(0, 10);
  const daypart = DAYPARTS.includes(req.body.daypart) ? req.body.daypart : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !daypart) {
    return res.send(tipsFormPage(emp, { err: 'Please choose the date and which shift you worked.' }));
  }

  // Find the shift — or start it. Staff often report before the manager has
  // opened the close, which is what used to leave the picker empty.
  s.getOrIgnore.run(date, daypart);
  const sh = s.findShift.get(date, daypart);
  policyForShift(sh); // lock in the tip-out policy version that's current now

  // What they say they worked drives whether their tips are kept (server) or
  // pooled (support). If you've already put them on the shift, your role wins.
  // Only a job they're actually assigned — a hand-crafted POST can't file
  // itself as a server (and keep the tips) when they're rostered as support.
  const allowed = rolesForEmployee(emp);
  const position = allowed.includes(req.body.position) ? req.body.position : (emp.role || allowed[0]);
  w.insertWorkIfAbsent.run({ shift_id: sh.id, employee_id: emp.id, role: position });
  const cash = toCents(req.body.cash_tips);
  w.setCashTips.run({ shift_id: sh.id, employee_id: emp.id, cash_tips_cents: cash, by: 'staff' });
  const cardRaw = String(req.body.card_tips || '').trim();
  if (cardRaw !== '') w.setCardTips.run({ shift_id: sh.id, employee_id: emp.id, card_tips_cents: toCents(cardRaw) });
  // Blank clears a previous note rather than being ignored — resubmitting is
  // how someone corrects themselves, and a stale note would mislead you.
  w.setNote.run({ shift_id: sh.id, employee_id: emp.id, note: String(req.body.note || '').trim().slice(0, 500) || null });

  // Servers report their own sales as part of closing. Only write if they
  // actually entered something, so a blank form never wipes your numbers.
  let salesNote = '';
  if (position === 'server') {
    const anySales = ['food', 'coffee', 'alcohol'].some((k) => String(req.body[k] || '').trim() !== '');
    if (anySales) {
      w.setSales.run({
        shift_id: sh.id, employee_id: emp.id,
        food_cents: toCents(req.body.food), coffee_cents: toCents(req.body.coffee), alcohol_cents: toCents(req.body.alcohol),
      });
      salesNote = (toCents(req.body.food) + toCents(req.body.coffee) + toCents(req.body.alcohol)) / 100;
    }
  }

  // Log it before redirecting. Append-only, so a resubmission to fix a typo
  // leaves both the original and the correction visible.
  submissions.add.run({
    shift_id: sh.id, employee_id: emp.id, role: position,
    cash_tips_cents: cash,
    card_tips_cents: cardRaw === '' ? null : toCents(cardRaw),
    food_cents: position === 'server' ? toCents(req.body.food) : null,
    coffee_cents: position === 'server' ? toCents(req.body.coffee) : null,
    alcohol_cents: position === 'server' ? toCents(req.body.alcohol) : null,
    note: String(req.body.note || '').trim() || null,
    source: 'staff',
  });

  const p = new URLSearchParams({
    done: '1', name: emp.name.split(' ')[0], cash: (cash / 100).toFixed(2),
    card: cardRaw === '' ? '' : (toCents(cardRaw) / 100).toFixed(2),
    shift: dp(daypart), date, position,
    sales: salesNote === '' ? '' : Number(salesNote).toFixed(2),
  });
  res.redirect('/tips?' + p.toString());
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
  const roles = [...allRoles(), 'manager'];
  const counts = staff.reduce((a, e) => { a[e.role] = (a[e.role] || 0) + 1; return a; }, {});
  // The PIN is now how staff sign in to the tips page, so no PIN = locked out.
  const noPin = staff.filter((e) => e.role !== 'manager' && !e.pin).map((e) => e.name);
  // Duplicates can predate the uniqueness guard (or arrive by import), and a
  // shared PIN blocks BOTH people from signing in — worth catching here rather
  // than when someone can't log their tips at close.
  const byPin = {};
  for (const e of staff) {
    if (!e.pin || e.role === 'manager') continue;
    (byPin[e.pin] = byPin[e.pin] || []).push(e.name);
  }
  const dupes = Object.values(byPin).filter((names) => names.length > 1);
  const pinWarn = [
    dupes.length ? `<b>Same PIN:</b> ${dupes.map((n) => esc(n.join(' and '))).join('; ')}. Neither can sign in until each has their own — give one of them a different PIN.` : '',
    noPin.length ? `<b>No PIN yet:</b> ${esc(noPin.join(', '))}. They sign in to the tips page with their PIN, so they can't log tips until you give them one.` : '',
  ].filter(Boolean);
  const pinBanner = pinWarn.length
    ? `<div class="flash flash-warn"><div><ul>${pinWarn.map((w) => `<li>${w}</li>`).join('')}</ul></div></div>`
    : '';
  const body = `
    ${flash(req)}
    <div class="page-head"><div><h1>Staff</h1><p class="sub">${staff.length} on the team · ${counts.server || 0} servers · open anyone to set roles &amp; wages.</p></div>
      <a class="btn btn-primary" href="#add">＋ Add staff</a></div>
    ${pinBanner}
    ${staff.length > 8 ? '<div class="toolbar"><div class="search"><input type="search" id="mod-search" placeholder="Search staff…" oninput="modFilter()"></div></div>' : ''}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Role</th><th class="num">Wage</th><th>Email</th><th>PIN</th><th></th></tr></thead>
      <tbody id="mod-body">${rows || '<tr><td colspan="6" class="muted">No staff yet — add your first below.</td></tr>'}</tbody></table></div>
    <h2 id="add">Add staff</h2>
    <form method="post" action="/employees" class="card form grid">
      <label>Name <input name="name" required></label>
      <label>Main role <select name="role">${roles.map((r) => `<option value="${r}">${r}</option>`).join('')}</select></label>
      <label>Email <input name="email" type="email" placeholder="for daily summary"></label>
      <label>4-digit PIN <input name="pin" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" placeholder="servers only"></label>
      <label>Pay type <select name="pay_type"><option value="hourly">Hourly</option><option value="salary">Salary</option></select></label>
      <label>Hourly wage <input name="rate" type="number" step="0.01" min="0" placeholder="0.00"></label>
      <label>Benugin ID <input name="pos_id" placeholder="optional"></label>
      <button class="btn btn-primary" type="submit">Add</button>
    </form>
    <p class="sub">Add the person first, then open them to set <b>multiple roles &amp; wages</b> (e.g. server $11, busser $13) or mark them salaried.</p>
    <script>function modFilter(){var q=(document.getElementById('mod-search').value||'').toLowerCase();document.querySelectorAll('#mod-body tr').forEach(function(r){r.style.display=r.textContent.toLowerCase().indexOf(q)!==-1?'':'none';});}</script>`;
  res.send(layout('Staff', body));
});

// Staff sign in to the tips page with their PIN alone, so a shared PIN would
// silently file one person's tips under the other. Caught here, where you can
// still do something about it, rather than at 1am on a close.
/**
 * A PIN is exactly PIN_LEN digits, or nothing at all.
 *
 * The staff keypad draws a fixed number of cells and submits the moment they
 * are full, so a five-digit PIN saved here would lock that person out of the
 * tips page with no way to tell why. Refused at the door rather than truncated
 * — silently storing a different PIN than the one that was typed is worse.
 */
function badPin(pin) {
  const clean = String(pin == null ? '' : pin).trim();
  if (clean === '') return null;
  return new RegExp(`^\\d{${PIN_LEN}}$`).test(clean)
    ? null
    : `A PIN has to be exactly ${PIN_LEN} digits — staff type it on a ${PIN_LEN}-key pad, so nothing else will let them in.`;
}

function pinTaken(pin, exceptId) {
  const clean = String(pin || '').trim();
  if (!clean) return null;
  return q.employeeByPin.get(clean, exceptId || 0) || null;
}

app.post('/employees', (req, res) => {
  const { name, role, email, pin, rate, pos_id, pay_type } = req.body;
  if (!name || !role) return res.redirect('/employees?err=1&msg=' + encodeURIComponent('Name and role required.'));
  const pinErr = badPin(pin);
  if (pinErr) return res.redirect('/employees?err=1&msg=' + encodeURIComponent(pinErr));
  const clash = pinTaken(pin, 0);
  if (clash) {
    return res.redirect('/employees?err=1&msg=' + encodeURIComponent(
      `${clash.name} already uses PIN ${String(pin).trim()}. Give ${name.trim()} a different one — staff sign in to the tips page with their PIN, so it has to be unique.`));
  }
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
  const roles = [...allRoles(), 'manager'];
  const val = (v) => esc(v == null ? '' : v);
  const payRoles = allRoles();
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
      <label>4-digit PIN <input name="pin" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" value="${val(e.pin)}"></label>
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
  const pinErr = badPin(pin);
  if (pinErr) return res.redirect(`/employees/${e.id}/edit?err=1&msg=` + encodeURIComponent(pinErr));
  const clash = pinTaken(pin, e.id);
  if (clash) {
    return res.redirect(`/employees/${e.id}/edit?err=1&msg=` + encodeURIComponent(
      `${clash.name} already uses PIN ${String(pin).trim()}. Pick a different one — staff sign in to the tips page with their PIN.`));
  }
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
  const today = startOfToday();
  const to = isoDate(today);
  return { from: addDays(to, -13), to };
}

/** YYYY-MM-DD minus N days (for showing the week-1 end date). */
function shiftBack(dateStr, days) {
  return addDays(dateStr, -days);
}

// --- Pay period UI ---------------------------------------------------------

/**
 * Periods as chips, the older ones behind a select, and a custom range.
 *
 * The four most recent are one tap each because they are the four anybody
 * opens; going back further is rare enough to deserve a menu rather than a
 * row of twelve identical dates.
 */
function periodBar(from, to) {
  const list = recentPeriods(8);
  const cur = currentPeriod();
  const custom = !isPeriod(from, to);
  const near = list.slice(0, 4);

  const chips = near.map((p) => `<a class="bs-fchip${p.start === from && p.end === to ? ' on' : ''}"
    href="/payroll?from=${p.start}&to=${p.end}">${esc(labelFor(p))}${p.start === cur.start ? ' <i>now</i>' : ''}</a>`).join('');

  const older = list.slice(4);
  const olderSel = older.length ? `
    <form class="bs-inline-pick" method="get" action="/payroll">
      <select name="period" aria-label="Earlier pay period"
        onchange="var v=this.value.split('|');if(!v[1])return;this.form.from.value=v[0];this.form.to.value=v[1];this.form.submit();">
        <option value="">Earlier…</option>
        ${older.map((p) => `<option value="${p.start}|${p.end}"${p.start === from && p.end === to ? ' selected' : ''}>${esc(labelFor(p))}</option>`).join('')}
      </select>
      <input type="hidden" name="from" value="${esc(from)}"><input type="hidden" name="to" value="${esc(to)}">
    </form>` : '';

  return `
    <div class="bs-filter">
      <span class="bs-filter-l">Period:</span>
      ${chips}${custom ? '<span class="bs-fchip on">Custom</span>' : ''}
      ${olderSel}
      <form class="bs-inline-range" method="get" action="/payroll">
        <input type="date" name="from" value="${esc(from)}"><span>to</span>
        <input type="date" name="to" value="${esc(to)}">
        <button class="bs-btn-sm" type="submit">Go</button>
      </form>
    </div>`;
}

/**
 * Everything that could make a period's numbers wrong, checked before you send.
 * Payroll adds up whatever is in the database whether or not you ever reviewed
 * it, so across a two-week backfill this is where mistakes hide.
 */
function periodIssues(from, to, rows) {
  const issues = [];
  const shifts = s.shiftsInRange.all(from, to);
  if (!shifts.length) return [{ text: 'No shifts logged in this period at all.', bad: true }];

  const zeroHours = [];
  const noSales = [];
  const noCash = [];
  for (const sh of shifts) {
    const inp = shiftInputs(sh.id);
    const where = `${sh.date} ${dp(sh.daypart)}`;
    for (const p of [...inp.servers, ...inp.support]) {
      if (!Number(p.hours) && !p.salaried) zeroHours.push(`${p.name} (${where})`);
    }
    for (const sv of inp.servers) {
      const tips = toCents(sv.cardTips) + toCents(sv.cashTips);
      const sales = toCents(sv.food) + toCents(sv.coffee) + toCents(sv.alcohol);
      if (tips > 0 && sales === 0) noSales.push(`${sv.name} (${where})`);
      if (!sv.cashEnteredBy) noCash.push(`${sv.name} (${where})`);
    }
  }
  const open = shifts.filter((sh) => sh.status !== 'emailed').map((sh) => `${sh.date} ${dp(sh.daypart)}`);
  const noEmail = rows.filter((r) => !r.email).map((r) => r.name);

  // Over a fortnight these lists run to twenty-odd entries, and a paragraph
  // that long stops being read at all — which is the opposite of what a
  // pre-send check is for. Lead with the count, name the first few, and say
  // how many more there are.
  const list = (arr, cap = 5) => (arr.length <= cap
    ? arr.join(', ')
    : `${arr.slice(0, cap).join(', ')}, and ${arr.length - cap} more`);
  const PLURAL = { person: 'people' };
  const many = (arr, noun) => `${arr.length} ${arr.length === 1 ? noun : (PLURAL[noun] || noun + 's')}`;

  if (zeroHours.length) issues.push({ bad: true,
    text: `No hours entered on ${many(zeroHours, 'shift')} — ${list(zeroHours)}. They earn $0 wages and no share of any pool.` });
  if (noSales.length) issues.push({ bad: true,
    text: `Tips but no sales on ${many(noSales, 'shift')} — ${list(noSales)}. Their tip-out calculated off $0.` });
  if (noEmail.length) issues.push({ bad: true,
    text: `No email on file for ${many(noEmail, 'person')} — ${list(noEmail)}. They won't receive anything.` });
  if (open.length) issues.push({ bad: false,
    text: `${many(open, 'service')} never closed out — ${list(open)}. The numbers are still counted, but you haven't reviewed them.` });
  if (noCash.length) issues.push({ bad: false,
    text: `Cash tips never entered on ${many(noCash, 'shift')} — ${list(noCash)}.` });
  return issues;
}

/**
 * The checks, then the send.
 *
 * Ordered deliberately: what could be wrong comes before the button that
 * mails it to everybody. A blocking issue leaves the button reachable — this
 * is his restaurant and he may know why a figure looks odd — but it stops
 * being the emphatic one.
 */
function periodSendBlock(from, to, rows) {
  if (!isPeriod(from, to)) return `
    <section class="bs-panel">
      <div class="bs-sec-h"><span class="bs-kicker">Send the summary</span></div>
      <p class="bs-note">This is a custom range, not a pay period, so there is nothing to send from
        it — and the Wk&nbsp;1 / Wk&nbsp;2 split below assumes the period starts on ${esc(from)}, which may
        not line up. Pick a pay period above to send.</p>
    </section>`;

  const p = { start: from, end: to };
  const done = sendRecord(from);
  const skipped = skipRecord(from);

  // A period the owner is not running: say so plainly and offer the way back,
  // rather than the checks and the send button for something nobody intends
  // to send.
  if (skipped && !done) return `
    <section class="bs-panel">
      <div class="bs-sec-h"><span class="bs-kicker">Not running this period</span></div>
      <p class="bs-note"><b>${esc(labelFor(p))} is marked as not running.</b>
        Nothing has been sent and payroll has stopped asking about it${
          skipped.skipped_by ? ` — ${esc(skipped.skipped_by)} marked it` : ''} on
        ${esc(String(skipped.skipped_at).slice(0, 16))}. The hours and figures below are
        still recorded; they are simply not going out.</p>
      <form class="bs-sendrow" method="post" action="/payroll/unskip">
        <input type="hidden" name="from" value="${from}"><input type="hidden" name="to" value="${to}">
        <button class="bs-btn-sm" type="submit">Put it back on the list</button>
      </form>
    </section>`;

  const issues = periodIssues(from, to, rows);
  const blocking = issues.filter((i) => i.bad);
  const recipients = rows.filter((r) => r.email && (r.hours > 0 || r.takeHome > 0 || r.cashTips > 0)).length;

  const checks = issues.length ? `
    <section class="bs-panel${blocking.length ? ' bs-panel-warn' : ''}">
      <div class="bs-sec-h${blocking.length ? ' warn' : ''}">
        <span class="bs-kicker">${blocking.length ? 'Check before sending' : 'Worth knowing'}</span>
        <span class="bs-sec-note">${issues.length} note${issues.length === 1 ? '' : 's'}</span>
      </div>
      <ul class="bs-checks">
        ${issues.map((i) => `<li class="${i.bad ? 'bad' : ''}"><span class="bs-check-k">${i.bad ? 'Check' : 'Note'}</span>${esc(i.text)}</li>`).join('')}
      </ul>
    </section>`
    : `<section class="bs-panel">
        <div class="bs-sec-h ok"><span class="bs-kicker">Checks</span></div>
        <p class="bs-note"><b>Nothing looks off in this period.</b> Every shift has hours, every server
          with tips has sales against them, and everybody who worked has an email on file.</p>
       </section>`;

  const sentNote = done
    ? `<p class="bs-note"><b>Already sent</b> on ${esc(String(done.sent_at).slice(0, 16))} to
        ${done.sent_count} ${done.sent_count === 1 ? 'person' : 'people'}. Sending again gives everyone a
        second email — only do it if the numbers have changed since.</p>` : '';

  return `
    ${checks}
    <section class="bs-panel">
    <div class="bs-sec-h"><span class="bs-kicker">Send the summary</span></div>
    <p class="bs-note">One email each with their hours, wages and card tips for
      <b>${esc(labelFor(p))}</b>. It restates the shift emails they already got — it is not extra pay.</p>
    ${sentNote}
    <form class="bs-sendrow" method="post" action="/payroll/send"
      onsubmit="return confirm('Email the ${esc(labelFor(p))} summary to ${recipients} ${recipients === 1 ? 'person' : 'people'}?')">
      <input type="hidden" name="from" value="${from}"><input type="hidden" name="to" value="${to}">
      <button class="${blocking.length ? 'bs-btn-sm' : 'bs-btn'}" type="submit"${recipients ? '' : ' disabled'}>
        ${done ? 'Send again' : 'Send'} to ${recipients} ${recipients === 1 ? 'person' : 'people'}
      </button>
      ${recipients ? '' : '<span class="bs-sendnote">Nobody in this period has an email on file.</span>'}
      ${blocking.length && recipients ? '<span class="bs-sendnote">Sending is still allowed — the checks above are yours to judge.</span>' : ''}
    </form>
    ${done ? '' : `<form class="bs-sendrow" method="post" action="/payroll/skip"
      onsubmit="return confirm('Mark ${esc(labelFor(p))} as not running? Nothing will be sent and payroll will stop asking about it.')">
      <input type="hidden" name="from" value="${from}"><input type="hidden" name="to" value="${to}">
      <button class="bs-btn-quiet" type="submit">Not running this period</button>
      <span class="bs-sendnote">Stops the reminders without sending anything. Reversible.</span>
    </form>`}
    </section>`;
}

app.post('/payroll/skip', (req, res) => {
  const from = String(req.body.from || '');
  const to = String(req.body.to || '');
  if (!isPeriod(from, to)) return res.redirect('/payroll?err=1&msg=' + encodeURIComponent('That range is not a pay period.'));
  // Who chose to skip it, so the record answers "who decided that" later.
  markSkipped(from, to, (req.user && req.user.name) || null);
  return res.redirect(`/payroll?from=${from}&to=${to}&msg=`
    + encodeURIComponent(`${labelFor({ start: from, end: to })} marked as not running. Payroll will stop asking about it.`));
});

app.post('/payroll/unskip', (req, res) => {
  const from = String(req.body.from || '');
  const to = String(req.body.to || '');
  unskipPeriod(from);
  return res.redirect(`/payroll?from=${from}&to=${to}&msg=`
    + encodeURIComponent(`${labelFor({ start: from, end: to })} is back on the list.`));
});

app.post('/payroll/send', async (req, res) => {
  const from = String(req.body.from || '');
  const to = String(req.body.to || '');
  const back = (msg, err) => res.redirect(`/payroll?from=${from}&to=${to}&msg=${encodeURIComponent(msg)}${err ? '&err=1' : ''}`);
  if (!isPeriod(from, to)) return back('That range is not a pay period.', true);

  const { rows } = aggregatePayroll(from, to);
  const people = new Map(rows.map((r) => [r.employeeId, { email: r.email }]));
  const emails = buildPeriodEmails(rows, { from, to }, people);
  if (!emails.length) return back('Nobody in this period to email.', true);

  const out = await sendEmails(emails);
  markSent(from, to, out.sent || out.previewed);
  const problems = out.errors.length ? ` ${out.errors.length} problem${out.errors.length === 1 ? '' : 's'}: ${out.errors.join('; ')}` : '';
  return back(out.sent
    ? `Sent the ${labelFor({ start: from, end: to })} summary to ${out.sent} people.${problems}`
    : `Mail isn't connected, so ${out.previewed} previews were written instead.${problems}`, !!out.errors.length);
});

/**
 * One person, one period, shift by shift.
 *
 * Everything here is the same aggregation the payroll table runs — the detail
 * rows it already builds, filtered to one employee. No second calculation, so
 * the breakdown cannot disagree with the row it opened from.
 */
// The id is constrained to digits, and that constraint is load-bearing: this
// route is registered before /payroll/export, so without it Express hands
// "export" to this handler, Number('export') is NaN, and Export to Excel has
// been answering 404 "No such person" since the drill-down shipped. Matching
// on \d+ makes the two routes independent of the order they are declared in.
app.get('/payroll/:employeeId(\\d+)', (req, res) => {
  const id = Number(req.params.employeeId);
  const emp = q.allEmployees.all().find((e) => e.id === id);
  if (!emp) return res.status(404).send(layout('Not found', '<div class="bs-page"><h1 class="bs-headline">No such person</h1></div>'));

  const cur = currentPeriod();
  const justEnded = recentPeriods(2)[1];
  // "All time" means from the first shift on record to the last.
  const span = db.prepare('SELECT MIN(date) a, MAX(date) b FROM shifts').get();
  const all = req.query.range === 'all';
  const from = all ? (span.a || justEnded.start) : (req.query.from || justEnded.start);
  const to = all ? (span.b || justEnded.end) : (req.query.to || justEnded.end);

  const { rows, detail } = aggregatePayroll(from, to);
  const me = rows.find((r) => r.employeeId === id);
  const mine = detail.filter((d) => d.employeeId === id)
    .sort((a, b) => (b.date + b.daypart).localeCompare(a.date + a.daypart));

  const cell = (label, value, sub) =>
    `<div class="bs-figcell"><span class="bs-figlabel">${label}</span><span class="bs-stat">${value}</span>${sub ? `<span class="bs-figsub">${sub}</span>` : ''}</div>`;

  const ranges = [
    ['This period', cur.start, cur.end],
    ['Last period', justEnded.start, justEnded.end],
    ['All time', span.a, span.b],
  ];

  res.send(layout(`${emp.name} · payroll`, `
    ${flash(req)}
    <div class="bs-page">
      <a class="bs-back" href="/payroll?from=${from}&to=${to}">← Payroll</a>
      <div class="bs-head">
        <div class="bs-headwrap">
          <p class="bs-greet">${esc(isPeriod(from, to) ? labelFor({ start: from, end: to }) : `${from} — ${to}`)}<span
            class="bs-greet-d">${mine.length} shift${mine.length === 1 ? '' : 's'}</span></p>
          <h1 class="bs-headline">${esc(emp.name)}</h1>
        </div>
      </div>

      <div class="bs-filter">
        <span class="bs-filter-l">Range:</span>
        ${ranges.map(([label, a, b]) => a ? `<a class="bs-fchip${from === a && to === b ? ' on' : ''}"
          href="/payroll/${id}?from=${a}&to=${b}">${label}</a>` : '').join('')}
        <form class="bs-inline-range" method="get" action="/payroll/${id}">
          <input type="date" name="from" value="${esc(from)}"><span>to</span>
          <input type="date" name="to" value="${esc(to)}">
          <button class="bs-btn-sm" type="submit">Go</button>
        </form>
      </div>

      ${me ? `<div class="bs-grid2 bs-paygrid">
        ${cell('Hours', me.hours, `${me.wk1Hours} + ${me.wk2Hours} by week`)}
        ${cell('Wages', money(me.wage), esc(me.roles))}
        ${cell('Card tip payout', money(me.paycheckTips), 'goes on the paycheck')}
        ${cell('On the check', money(me.takeHome), me.cashHome || me.weeklyCash ? `plus ${money(me.cashHome + me.weeklyCash)} in cash` : 'wages + card tips')}
      </div>` : '<p class="bs-clear">Nothing worked in this range.</p>'}

      ${mine.length ? `
      <div class="bs-sec-h"><span class="bs-kicker">Shift by shift</span></div>
      <div class="bs-lhead bs-payhead">
        <span>Date</span><span>Service</span><span>Role</span>
        <span class="r">Hours</span><span class="r">Wage</span><span class="r">Tips kept</span><span class="r">On the check</span><span></span>
      </div>
      <div class="bs-lrows">
        ${mine.map((d) => `<a class="bs-lr bs-payrow" href="/shifts/${d.shiftId}">
          <span class="bs-lr-d">${esc(whenOf(d.date))}</span>
          <span class="bs-lr-s">${esc(dp(d.daypart))}</span>
          <span class="bs-lr-s muted">${esc(d.role)}</span>
          <span class="bs-lr-n">${(Math.round(d.hours * 100) / 100).toFixed(2)}</span>
          <span class="bs-lr-n">${money(d.wage)}</span>
          <span class="bs-lr-n muted">${d.tipsKept ? money(d.tipsKept) : '—'}</span>
          <span class="bs-lr-n">${money(d.paycheck)}</span>
          <span class="bs-lr-go">→</span>
        </a>`).join('')}
      </div>` : ''}
    </div>`));
});

app.get('/payroll', (req, res) => {
  // Open on the newest period — the one running now. It used to open on the
  // period that just ended, on the reasoning that it is the one you are about
  // to run; in practice that meant every visit landed a fortnight behind and
  // had to be clicked forward. The one that just ended is the second chip and
  // still one tap away.
  const cur = currentPeriod();
  const justEnded = recentPeriods(2)[1];
  const from = req.query.from || cur.start;
  const to = req.query.to || cur.end;
  const { rows, totals, shiftCount, midDate } = aggregatePayroll(from, to);

  // =========================================================================
  // BROADSHEET — the payroll run
  // -------------------------------------------------------------------------
  // A verdict on the period, the four totals, the checks, the send, then the
  // roster. Every figure the old nine-column table carried is still here: the
  // shift count moved under the name, and Wk 1 / Wk 2 under the hours, because
  // they are readings OF those columns rather than columns of their own. That
  // is what took the table from nine columns to six and let it survive a
  // phone without a horizontal scrollbar.
  // =========================================================================
  const today = isoDate(startOfToday());
  const period = isPeriod(from, to);
  const sent = period ? sendRecord(from) : null;
  const issues = period ? periodIssues(from, to, rows) : [];
  const blocking = issues.filter((i) => i.bad).length;
  const paid = rows.filter((r) => r.hours > 0 || r.takeHome > 0);

  // The headline answers the only question this page is opened with: can I run
  // payroll, and is anything going to bite me. Not the name of the page — the
  // nav already says Payroll, and a masthead that repeats itself wastes the
  // one line the reader actually reads.
  const verdict = !shiftCount
    ? { t: 'nothing logged in this range.', k: 'warn' }
    : to > today
      ? { t: 'this period is still running.', k: '' }
      : sent
        ? { t: `sent to ${sent.sent_count} ${sent.sent_count === 1 ? 'person' : 'people'}.`, k: 'ok' }
        : !period
          ? { t: `${paid.length} ${paid.length === 1 ? 'person' : 'people'}, ${totals.hours} hours.`, k: '' }
          : blocking
            ? { t: `${blocking} thing${blocking === 1 ? '' : 's'} to check before you send.`, k: 'warn' }
            : { t: 'ready to send.', k: 'ok' };

  const statCell = (label, value, sub) =>
    `<div class="bs-strip-c"><span class="bs-strip-l">${label}</span><span class="bs-stat">${value}</span><span class="bs-strip-s">${sub}</span></div>`;

  // --- the roster ------------------------------------------------------------
  const roster = rows.map((r) => `
    <a class="bs-lr bs-rrow" href="/payroll/${r.employeeId}?from=${from}&to=${to}">
      <span class="bs-rr-n">${esc(r.name)}
        <i>${esc(r.roles)} · ${r.shifts} shift${r.shifts === 1 ? '' : 's'}</i></span>
      <span class="bs-lr-n">${r.hours}<i>${r.wk1Hours} + ${r.wk2Hours}</i></span>
      <span class="bs-lr-n">${money(r.wage)}</span>
      <span class="bs-lr-n muted">${r.cashTips ? money(r.cashTips) : '<span class="bs-em">—</span>'}</span>
      <span class="bs-lr-n strong">${money(r.paycheckTips)}</span>
      <span class="bs-lr-n strong">${money(r.takeHome)}</span>
      <span class="bs-lr-go">→</span>
    </a>`).join('');

  res.send(layout('Payroll', `
    ${flash(req)}
    <div class="bs-page">
      <div class="bs-head">
        <div class="bs-headwrap">
          <h1 class="bs-headline">Payroll — <span class="${verdict.k}">${esc(verdict.t)}</span></h1>
          <p class="bs-subline">${esc(period ? labelFor({ start: from, end: to }) : `${from} to ${to}`)} ·
            ${shiftCount} shift${shiftCount === 1 ? '' : 's'}. Hours and card tip payout are what Gusto asks for.</p>
        </div>
        <a class="bs-btn-sm" href="/payroll/export?from=${from}&to=${to}">Export to Excel</a>
      </div>

      ${periodBar(from, to)}

      <section class="bs-panel bs-strip">
        ${statCell('Hours', totals.hours, `wk 1 ${totals.wk1Hours} · wk 2 ${totals.wk2Hours}`)}
        ${statCell('Wages', money(totals.wage), `${paid.length} ${paid.length === 1 ? 'person' : 'people'} worked`)}
        ${statCell('Card tip payout', money(totals.paycheckTips), 'goes into Gusto')}
        ${statCell('On the checks', money(totals.takeHome), 'wages + card tips')}
        <span class="bs-strip-note">cash tips are not in this —<br>they already have that money</span>
      </section>

      ${periodSendBlock(from, to, rows)}

      <section class="bs-panel">
      <div class="bs-sec-h"><span class="bs-kicker">Everyone who worked</span>
        <span class="bs-sec-note">hours and card tip payout are the two figures Gusto asks for</span></div>
      ${rows.length ? `
      <div class="bs-lhead bs-rhead">
        <span>Person</span><span class="r">Hours</span><span class="r">Wages</span>
        <span class="r">Cash tips</span><span class="r">Card payout</span><span class="r">On the check</span><span></span>
      </div>
      <div class="bs-lrows">${roster}</div>
      <div class="bs-lr bs-rrow bs-rtot">
        <span class="bs-rr-n">Total<i>${totals.shifts} shift${totals.shifts === 1 ? '' : 's'} between them,
          across ${shiftCount} service${shiftCount === 1 ? '' : 's'}</i></span>
        <span class="bs-lr-n">${totals.hours}<i>${totals.wk1Hours} + ${totals.wk2Hours}</i></span>
        <span class="bs-lr-n">${money(totals.wage)}</span>
        <span class="bs-lr-n muted">${money(totals.cashTips)}</span>
        <span class="bs-lr-n strong">${money(totals.paycheckTips)}</span>
        <span class="bs-lr-n strong">${money(totals.takeHome)}</span>
        <span></span>
      </div>` : '<p class="bs-clear">Nobody worked in this range.</p>'}
      </section>

      <p class="bs-note bs-note-wide">
        <b>Card tip payout</b> is what goes into Gusto — card tips net of tip-out, owed on the paycheck.
        <b>On the check</b> is wages plus that payout.
        <b>Cash tips</b> — taken home nightly, plus the weekly jar and to-go share — are here for reference
        and are deliberately not in the check total: they already walked out with that money.
        Wk&nbsp;1 is ${esc(from)} → ${esc(shiftBack(midDate, 1))}, Wk&nbsp;2 is ${esc(midDate)} → ${esc(to)}.</p>
    </div>`));
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
// ---------------------------------------------------------------------------
// PERFORMANCE — how the restaurant is doing over time, and why.
//
// Not the Dashboard, which answers "what needs me today". This answers "how
// are we doing, and what moved it". Costs live here; revenue lives on Sales.
// Anything that belongs to another module links out rather than being
// reimplemented — the fastest way to two different answers is two owners.
// ---------------------------------------------------------------------------
app.get('/costs', (req, res) => {
  const today = isoDate(startOfToday());
  const key = MX.RANGES.some(([k]) => k === req.query.r) || req.query.r === 'custom' ? req.query.r : '30';
  const r = MX.range(key, today, { from: req.query.from, to: req.query.to });
  const cur = MX.period(r.from, r.to);
  const prev = MX.previous(r.from, r.to);
  const series = MX.days(r.from, r.to);

  // Targets. Rules of thumb until they're configurable — stated on the page
  // rather than hidden in the colour of a tile.
  const TGT = { labor: 30, food: 32, prime: 60 };
  const dm = (d) => d.date.slice(5).replace('-', '/');

  const kpi = (tone, ico, label, value, sub, spark) => `
    <div class="mcard mcard-${tone}"><div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body"><div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div><div class="mcard-sub">${sub}</div></div>
      ${spark ? `<div class="mcard-spark">${spark}</div>` : ''}</div>`;

  const vs = (v, target) => {
    if (v === null) return 'no data yet';
    const d = v - target;
    if (Math.abs(d) < 0.1) return `on the ${target}% target`;
    return `${Math.abs(d).toFixed(1)} pts ${d > 0 ? 'over' : 'under'} target`;
  };
  const band = (v, target) => (v === null ? 'blue' : v <= target ? 'green' : v <= target * 1.1 ? 'amber' : 'red');

  const salesSpark = CH.spark(series.map((d) => d.sales));
  const laborSpark = CH.spark(series.filter((d) => d.sales > 0).map((d) => (d.wages / d.sales) * 100), { invert: true });

  const cards = `<div class="mcards mcards-3">
    ${kpi('blue', 'sales', 'Sales', money(cur.sales),
      `${CH.delta(cur.sales, prev.sales)} vs the period before`, salesSpark)}
    ${kpi(band(cur.laborPct, TGT.labor), 'payroll', 'Labor %', cur.laborPct === null ? '—' : cur.laborPct + '%',
      vs(cur.laborPct, TGT.labor), laborSpark)}
    ${kpi(cur.foodPct === null ? 'blue' : band(cur.foodPct, TGT.food), 'invoices', 'Food cost %',
      cur.foodPct === null ? '—' : cur.foodPct + '%',
      cur.foodPct === null ? 'no invoices in this range' : vs(cur.foodPct, TGT.food))}
    ${kpi(cur.primePct === null ? 'blue' : band(cur.primePct, TGT.prime), 'costs', 'Prime cost',
      cur.primePct === null ? '—' : cur.primePct + '%',
      cur.primePct === null ? 'needs invoices' : vs(cur.primePct, TGT.prime))}
    ${kpi('green', 'cash', 'Gross profit', money(cur.grossProfit),
      `${CH.delta(cur.grossProfit, prev.grossProfit)} · after wages${cur.cogs ? ' and goods' : ''}`)}
    ${kpi('violet', 'shifts', 'Average daily sales', cur.avgDaily === null ? '—' : money(cur.avgDaily),
      cur.dayCount ? `over ${cur.dayCount} day${cur.dayCount === 1 ? '' : 's'} traded` : 'nothing traded yet')}
  </div>`;

  // --- what moved -----------------------------------------------------------
  const drivers = [];
  if (prev.laborPct !== null && cur.laborPct !== null) {
    const d = cur.laborPct - prev.laborPct;
    if (Math.abs(d) >= 0.5) {
      const hoursMoved = cur.hours - prev.hours;
      drivers.push({ bad: d > 0, text: `Labor ${d > 0 ? 'rose' : 'fell'} ${Math.abs(d).toFixed(1)} points to ${cur.laborPct}%`,
        why: hoursMoved ? `${Math.abs(Math.round(hoursMoved * 10) / 10)} ${hoursMoved > 0 ? 'more' : 'fewer'} hours worked` : 'sales moved, hours held' });
    }
  }
  if (prev.foodPct !== null && cur.foodPct !== null) {
    const d = cur.foodPct - prev.foodPct;
    if (Math.abs(d) >= 0.5) drivers.push({ bad: d > 0, text: `Food cost ${d > 0 ? 'rose' : 'fell'} ${Math.abs(d).toFixed(1)} points to ${cur.foodPct}%`, why: `${money(cur.cogs)} invoiced against ${money(cur.sales)} of sales`, href: '/c/invoices' });
  }
  // Products whose price moved most in this window, from real purchase data.
  let risers = [];
  try {
    risers = PRODUCTS.q.all.all({ from_month: r.from, from_year: r.from })
      .map((p) => ({ p, t: PRODUCTS.trendOf(p) }))
      .filter((x) => x.t !== null && x.t >= 5 && x.p.spend_year > 0)
      .sort((a, b) => b.t - a.t).slice(0, 4);
  } catch { risers = []; }
  if (risers.length) {
    drivers.push({ bad: true, text: `${risers.length} ingredient${risers.length === 1 ? '' : 's'} costing more than they were`,
      why: risers.map((x) => `${x.p.name} +${x.t}%`).join(' · '), href: '/c/products' });
  }
  if (prev.sales > 0) {
    const d = ((cur.sales - prev.sales) / prev.sales) * 100;
    if (Math.abs(d) >= 2) drivers.push({ bad: d < 0, text: `Sales ${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)}% on the previous period`, why: `${money(cur.sales)} against ${money(prev.sales)}`, href: '/sales' });
  }

  const driversBlock = `
    <section class="pcard">
      <div class="pcard-h"><b>What's driving performance</b><span class="muted">${esc(r.label.toLowerCase())} vs the period before</span></div>
      ${drivers.length ? `<div class="drivers">${drivers.map((d) => `
        ${d.href ? `<a class="driver" href="${d.href}">` : '<div class="driver">'}
          <span class="driver-dot ${d.bad ? 'bad' : 'good'}"></span>
          <span class="driver-b"><b>${esc(d.text)}</b><i>${esc(d.why)}</i></span>
          ${d.href ? '<span class="driver-go">›</span>' : ''}
        ${d.href ? '</a>' : '</div>'}`).join('')}</div>`
        : `<div class="panel-empty">Nothing moved much this period${prev.sales ? '' : ', and there is no earlier period to compare against yet'}.</div>`}
    </section>`;

  // --- charts ---------------------------------------------------------------
  const salesLine = CH.lineChart([{ label: 'Sales', values: series.map((d) => ({ x: dm(d), y: d.sales })), area: true }], { height: 190 });
  const laborLine = CH.lineChart([
    { label: 'Sales', values: series.map((d) => ({ x: dm(d), y: d.sales })), color: '#2563eb' },
    { label: 'Wages', values: series.map((d) => ({ x: dm(d), y: d.wages })), color: '#d97706' },
  ], { height: 180 });
  const invWeeks = MX.invoiceWeeks(r.from, r.to);
  const invBar = CH.barChart(invWeeks.map((w) => ({ x: w.week.slice(5).replace('-', '/'), y: w.cents })), { height: 150, color: '#0891b2' });

  // --- labour and food ------------------------------------------------------
  const fact = (k, v) => `<div class="tfact"><span>${k}</span><b>${v}</b></div>`;
  const topVendors = db.prepare(`SELECT v.name, SUM(i.amount_cents) c FROM m_invoices i
    LEFT JOIN m_vendors v ON CAST(v.id AS REAL) = CAST(i.vendor_id AS REAL)
    WHERE i.invoice_date >= ? AND i.invoice_date <= ? GROUP BY i.vendor_id ORDER BY c DESC LIMIT 4`).all(r.from, r.to);

  // --- menu margin ----------------------------------------------------------
  let menuAlerts = [];
  try {
    menuAlerts = MENU.q.all.all().filter((m) => m.status === 'active').map((m) => MENU.costItem(m.id))
      .filter((c) => c.foodCostPct !== null && !c.unresolved && c.foodCostPct > c.target)
      .sort((a, b) => (b.foodCostPct - b.target) - (a.foodCostPct - a.target)).slice(0, 5);
  } catch { menuAlerts = []; }

  res.send(layout('Performance', `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t"><h1>Performance</h1>
        <p class="phead-s">How the restaurant is doing over time, and what moved it.</p></div>
    </div>
    <div class="rangebar">
      ${MX.RANGES.map(([k, label]) => `<a class="rchip${key === k ? ' on' : ''}" href="/costs?r=${k}">${label}</a>`).join('')}
      <form class="rcustom" method="get" action="/costs">
        <input type="hidden" name="r" value="custom">
        <input type="date" name="from" value="${esc(r.from)}"><span>to</span>
        <input type="date" name="to" value="${esc(r.to)}">
        <button class="btn btn-sm" type="submit">Go</button>
      </form>
    </div>
    <p class="rangenote">${esc(r.label)} · ${esc(r.from)} to ${esc(r.to)} · ${cur.completedShifts} shift${cur.completedShifts === 1 ? '' : 's'} with figures</p>

    ${cards}
    ${driversBlock}

    <div class="pgrid2">
      <section class="pcard"><div class="pcard-h"><b>Sales</b><span class="muted">daily</span></div>${salesLine}</section>
      <section class="pcard"><div class="pcard-h"><b>Sales against wages</b><span class="muted">where labor % comes from</span></div>${laborLine}</section>
    </div>

    <div class="pgrid2">
      <section class="pcard">
        <div class="pcard-h"><b>Labor</b><a class="panel-link" href="/payroll">Payroll →</a></div>
        ${fact('Wages', money(cur.wages))}
        ${fact('Hours worked', cur.hours ? String(Math.round(cur.hours * 10) / 10) : '<i class="unset">none</i>')}
        ${fact('Labor %', cur.laborPct === null ? '<i class="unset">—</i>' : cur.laborPct + '%')}
        ${fact('Sales per labor hour', cur.salesPerHour === null ? '<i class="unset">—</i>' : money(cur.salesPerHour))}
        ${fact('Wage cost per sales dollar', cur.sales ? '$' + (cur.wages / cur.sales).toFixed(3) : '<i class="unset">—</i>')}
      </section>
      <section class="pcard">
        <div class="pcard-h"><b>Food &amp; goods</b><a class="panel-link" href="/c/invoices">Invoices →</a></div>
        ${fact('Invoiced this period', money(cur.invoiceTotal))}
        ${fact('Of that, food &amp; drink', cur.cogs ? money(cur.cogs) : '<i class="unset">none tagged</i>')}
        ${fact('Food cost %', cur.foodPct === null ? '<i class="unset">needs invoices</i>' : cur.foodPct + '%')}
        ${topVendors.length ? topVendors.map((v) => fact(esc(v.name || 'Unknown vendor'), money(v.c))).join('') : '<div class="panel-empty">No invoices in this range.</div>'}
      </section>
    </div>

    <div class="pgrid2">
      <section class="pcard"><div class="pcard-h"><b>Invoice spending</b><span class="muted">by week</span></div>${invBar}</section>
      <section class="pcard">
        <div class="pcard-h"><b>Menu margin alerts</b><a class="panel-link" href="/menu">Menu costing →</a></div>
        ${menuAlerts.length ? menuAlerts.map((c) => `
          <a class="driver" href="/menu/${c.item.id}">
            <span class="driver-dot bad"></span>
            <span class="driver-b"><b>${esc(c.item.name)} — ${c.foodCostPct.toFixed(1)}% food cost</b>
              <i>target ${c.target}% · ${money(c.totalCents)} to make, sells for ${money(c.sellCents)}</i></span>
            <span class="driver-go">›</span></a>`).join('')
          : '<div class="panel-empty">No active menu item is over its target. Items without a full cost are not counted.</div>'}
      </section>
    </div>

    <p class="rangenote">Targets are rules of thumb for now — labor under ${TGT.labor}%, food under ${TGT.food}%, prime under ${TGT.prime}%.
      Food and prime cost only count invoices you have logged, so they read low until the month's invoices are in.</p>`));
});

// ---------------------------------------------------------------------------
// Cash reconciliation — count the drawer each shift, flag over/short
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CASH RECONCILIATION — history, a four-step workspace, and a detail record.
//
// The old page put the history table and the entry form on one screen, which
// meant the form was always open and the numbers it produced were never shown
// back. This separates them: a list you can scan, a workspace you work in.
// ---------------------------------------------------------------------------

const cashMonth = (d) => (d || '').slice(0, 7);
/** Audit values are stored as raw column values; cents columns read as cents. */
const cashAuditVal = (field, v) => (v == null || v === '' ? '—'
  : /_cents$/.test(field) && /^-?\d+$/.test(v) ? CASH.money(Number(v)) : String(v));
const cashDayLabel = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

app.get('/cash', (req, res) => {
  const today = isoDate(startOfToday());
  const key = MX.RANGES.some(([k]) => k === req.query.r) || req.query.r === 'custom' ? req.query.r : '90';
  const r = MX.range(key, today, { from: req.query.from, to: req.query.to });
  const filt = String(req.query.f || 'all');

  const all = CASH.q.inRange.all(r.from, r.to).map((row) => ({ row, c: CASH.compute(row), s: CASH.status(row) }));
  const live = all.filter((x) => x.row.status !== 'void');
  const counted = live.filter((x) => x.c.counted != null);

  const net = counted.reduce((a, x) => a + x.c.variance, 0);
  const deposited = live.reduce((a, x) => a + (x.c.actualDeposit ?? x.c.calcDeposit ?? 0), 0);
  const avgVar = counted.length ? Math.round(counted.reduce((a, x) => a + Math.abs(x.c.variance), 0) / counted.length) : null;
  const biggest = counted.slice().sort((a, b) => Math.abs(b.c.variance) - Math.abs(a.c.variance))[0];

  const card = (tone, ico, label, value, sub) => `
    <div class="mcard mcard-${tone}"><div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body"><div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div><div class="mcard-sub">${sub}</div></div></div>`;

  // Four, not five. How many counts there are is already on every month
  // header, and a fifth card only ever wrapped onto a row of its own.
  const cards = `<div class="mcards mcards-4">
    ${card(net === 0 ? 'green' : Math.abs(net) <= CASH.tolerance().critical ? 'amber' : 'red', 'costs', 'Net over / short',
      counted.length ? CASH.money(net) : '—', counted.length ? (net === 0 ? 'balanced' : net > 0 ? 'over across the period' : 'short across the period') : 'nothing counted yet')}
    ${card('violet', 'sales', 'Average variance', avgVar === null ? '—' : CASH.money(avgVar),
      live.length > counted.length ? `${live.length - counted.length} still open` : `across ${counted.length} count${counted.length === 1 ? '' : 's'}`)}
    ${card(biggest && Math.abs(biggest.c.variance) > CASH.tolerance().critical ? 'red' : 'amber', 'incidents', 'Largest variance',
      biggest ? CASH.money(Math.abs(biggest.c.variance)) : '—',
      biggest ? `${cashDayLabel(biggest.row.date)} ${dp(biggest.row.daypart)}` : 'none yet')}
    ${card('green', 'payroll', 'Total deposited', CASH.money(deposited),
      live.some((x) => x.row.legacy) ? 'excludes pre-deposit records' : 'to safe or bank')}
  </div>`;

  const pass = (x) => {
    if (filt === 'all') return true;
    if (filt === 'draft') return x.row.status === 'draft';
    if (filt === 'void') return x.row.status === 'void';
    if (filt === 'exact') return x.s.key === 'exact';
    if (filt === 'over') return x.c.variance > 0;
    if (filt === 'short') return x.c.variance < 0;
    if (filt === 'review') return x.s.key === 'review' || x.s.key === 'critical';
    return true;
  };
  const shown = all.filter(pass);

  // Grouped by month, like Invoices and Shifts.
  const months = new Map();
  for (const x of shown) {
    const m = cashMonth(x.row.date) || 'undated';
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(x);
  }
  const MONTH_LABEL = (m) => (m === 'undated' ? 'No date'
    : new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));

  const blocks = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([m, list], idx) => {
    const mNet = list.filter((x) => x.c.counted != null).reduce((a, x) => a + x.c.variance, 0);
    const mDep = list.reduce((a, x) => a + (x.c.actualDeposit ?? x.c.calcDeposit ?? 0), 0);
    return `<details class="mgroup" data-month${idx === 0 ? ' open' : ''}>
      <summary class="mgroup-h"><span class="mgroup-chev">▸</span><span class="mgroup-name">${esc(MONTH_LABEL(m))}</span>
        <span class="mgroup-stats"><span>${list.length} count${list.length === 1 ? '' : 's'}</span>
          <span class="mg-total">${CASH.money(mDep)} deposited</span>
          <span class="${mNet === 0 ? 'mg-paid' : 'mg-over'}">${mNet === 0 ? 'balanced' : CASH.money(mNet)}</span></span></summary>
      <div class="crows">${list.map((x) => `
        <a class="crow${x.row.status === 'void' ? ' crow-void' : ''}" href="/cash/${x.row.id}">
          <span class="crow-d"><b>${Number((x.row.date || '--').slice(8))}</b><i>${cashDayLabel(x.row.date).split(' ')[0]}</i></span>
          <span class="crow-m"><span class="crow-t">${esc(dp(x.row.daypart))}</span>
            <span class="pill ${x.s.cls}">${esc(x.s.label)}</span>
            ${x.row.legacy ? '<span class="pill">pre-deposit records</span>' : ''}</span>
          <span class="crow-n"><i>Expected</i><b>${CASH.money(x.c.expected)}</b></span>
          <span class="crow-n"><i>Counted</i><b>${x.c.counted == null ? '—' : CASH.money(x.c.counted)}</b></span>
          <span class="crow-n"><i>Deposit</i><b>${(x.c.actualDeposit ?? x.c.calcDeposit) == null ? '—' : CASH.money(x.c.actualDeposit ?? x.c.calcDeposit)}</b></span>
          <span class="crow-n"><i>Counted by</i><b>${esc(x.row.counted_by || x.row.closed_by || '—')}</b></span>
          <span class="crow-go">›</span>
        </a>`).join('')}</div>
    </details>`;
  }).join('');

  const chip = (k, label) => `<a class="rchip${filt === k ? ' on' : ''}" href="/cash?r=${key}&f=${k}">${label}</a>`;

  res.send(layout('Cash reconciliation', `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t"><h1>Cash reconciliation</h1>
        <p class="phead-s">Reconcile each drawer, document variances, and track deposits.</p></div>
      ${canWrite() ? `<a class="btn btn-primary" href="/cash/new">＋ New reconciliation</a>` : ''}
    </div>
    <div class="rangebar">
      ${MX.RANGES.map(([k, label]) => `<a class="rchip${key === k ? ' on' : ''}" href="/cash?r=${k}&f=${filt}">${label}</a>`).join('')}
    </div>
    <div class="rangebar">
      ${chip('all', 'All')}${chip('exact', 'Exact')}${chip('over', 'Over')}${chip('short', 'Short')}
      ${chip('review', 'Needs review')}${chip('draft', 'Draft')}${chip('void', 'Voided')}
    </div>
    ${all.length ? cards : ''}
    ${shown.length ? blocks : `<div class="empty2"><div class="empty2-t">${all.length ? 'Nothing matches that filter' : 'No reconciliations in this period'}</div>
      <div class="empty2-s">${all.length ? 'Try another filter or period.' : canWrite() ? 'Count a drawer at close and it will show up here.' : 'Counts appear here once they are recorded.'}</div></div>`}`));
});

// --- the workspace ----------------------------------------------------------
// Four steps down the page with a summary that follows: shift details, cash
// activity, the count, closing the drawer. Every figure the summary shows is
// derived on the server from the same function the saved record uses, so what
// you see while entering is what gets stored.

function cashForm(row, movements, denoms, req) {
  // -------------------------------------------------------------------------
  // Closing at 10:30pm, standing at the register, phone in one hand.
  //
  // A reconciliation needs exactly two numbers that only a human can know:
  // what the POS says was taken in cash, and what is physically in the drawer.
  // Everything else is either already known (the date, the service, the $200
  // till) or derived from those two (expected, variance, deposit).
  //
  // So those two are the page. The other seventeen fields still exist —
  // nothing was removed — but they sit behind Change and Advanced, where the
  // one close in twenty that needs them can find them. The rest of the time
  // they are noise between a tired manager and going home.
  // -------------------------------------------------------------------------
  const isNew = !row.id;
  const drawers = CASH.q.drawers.all();
  const staff = q.allEmployees.all();
  const dflt = CASH.defaultFloat();
  const m = (v) => (v == null ? '' : (v / 100).toFixed(2));
  const me = (req.user && req.user.name) || '';

  const paid = movements.filter((x) => x.movement_type !== 'cash_added');
  const added = movements.filter((x) => x.movement_type === 'cash_added');

  // A committed entry: a line you can read, with the fields that post it
  // hidden behind. The old form left every entry as three live inputs, which
  // gave no signal that anything had been recorded — you typed $75 into a box
  // and the box just sat there looking like a box.
  const mvItem = (x, i, kind) => {
    const out = kind === 'paid';
    return `<div class="mvi" data-kind="${kind}">
      <span class="mvi-i ${out ? 'out' : 'in'}">${out ? '↓' : '↑'}</span>
      <span class="mvi-t"><b>${esc(x.reason || (out ? 'Paid out' : 'Cash added'))}</b>
        ${x.recipient ? `<i>${out ? 'to' : 'by'} ${esc(x.recipient)}</i>` : ''}</span>
      <b class="mvi-a ${out ? 'out' : 'in'}">${out ? '−' : '+'}${CASH.money(x.amount_cents)}</b>
      <button type="button" class="mvi-x" onclick="cashRemove(this)" aria-label="Remove">✕</button>
      <input type="hidden" name="${kind}_amt_${i}" value="${m(x.amount_cents)}">
      <input type="hidden" name="${kind}_reason_${i}" value="${esc(x.reason || '')}">
      <input type="hidden" name="${kind}_who_${i}" value="${esc(x.recipient || '')}">
    </div>`;
  };

  // The line you type into. Nothing here is named, so a half-finished entry
  // cannot post — it is committed by Add, or swept up on submit.
  const mvDraft = (kind) => `
    <div class="mvd" data-draft="${kind}">
      <span class="mvd-cur">$</span>
      <input class="mvd-amt" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"
        aria-label="${kind === 'paid' ? 'Amount paid out' : 'Amount added'}">
      <select class="mvd-reason minisel" aria-label="Reason">
        ${(kind === 'paid' ? CASH.PAID_REASONS : CASH.ADDED_REASONS).map((rr) => `<option>${rr}</option>`).join('')}
      </select>
      <input class="mvd-who" placeholder="${kind === 'paid' ? 'Paid to' : 'Added by'}"
        aria-label="${kind === 'paid' ? 'Paid to' : 'Added by'}">
      <button type="button" class="btn btn-sm btn-primary mvd-go" onclick="cashCommit('${kind}')">Add</button>
    </div>`;

  const theDate = row.date || isoDate(startOfToday());
  const pretty = new Date(theDate + 'T00:00:00')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  // Open the drawers to whatever needs attention, so nothing hides from
  // somebody who is mid-correction.
  const openMoney = paid.length > 0 || added.length > 0;
  const openAdv = !!(row.deposit_destination || row.deposit_bag || row.deposit_reference
    || row.verified_by || row.note || row.override_reason || denoms.length
    || (row.ending_float_cents != null && row.ending_float_cents !== dflt)
    || (row.actual_deposit_cents != null));
  const openCtx = !isNew && (row.float_cents !== dflt || drawers.length > 1);

  return layout(isNew ? 'Close the drawer' : `Reconciliation · ${row.date}`, `
    ${flash(req)}
    <form method="post" action="${isNew ? '/cash' : `/cash/${row.id}`}" id="cashform">
    <div class="cq">
      <div class="phead">
        <div class="phead-t">
          <a class="link back" href="${isNew ? '/cash' : `/cash/${row.id}`}">← Cash reconciliation</a>
          <h1>${isNew ? 'Close the drawer' : 'Edit reconciliation'}</h1>
        </div>
      </div>

      <!-- What we already know. One line, and a way in if any of it is wrong. -->
      <div class="cq-ctx">
        <span class="cq-ctx-t"><b id="cq-when">${esc(pretty)}</b>
          <i><span id="cq-svc">${esc(dp(row.daypart || 'cafe'))}</span> · opening till <span id="cq-till">${CASH.money(row.float_cents == null ? dflt : row.float_cents)}</span></i></span>
        <button type="button" class="cq-ctx-b" onclick="cashToggle('cq-ctxbox', this)"
          aria-expanded="${openCtx ? 'true' : 'false'}">Change</button>
      </div>
      <div class="cq-box" id="cq-ctxbox"${openCtx ? '' : ' hidden'}>
        <div class="fld-row3">
          <label class="fld">Date<input name="date" type="date" required value="${esc(theDate)}"></label>
          <label class="fld">Service<select name="daypart">
            ${DAYPARTS.map((d) => `<option value="${d}"${(row.daypart || 'cafe') === d ? ' selected' : ''}>${dp(d)}</option>`).join('')}
          </select></label>
          <label class="fld">Opening till<input name="float" id="c-float" type="number" step="0.01" min="0" inputmode="decimal"
            value="${row.float_cents == null ? m(dflt) : m(row.float_cents)}"></label>
        </div>
        ${drawers.length > 1 ? `<label class="fld">Drawer<select name="drawer_id">
          ${drawers.map((d) => `<option value="${d.id}"${Number(row.drawer_id) === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select></label>` : `<input type="hidden" name="drawer_id" value="${drawers[0] ? drawers[0].id : ''}">`}
        <label class="fld inv-hide" id="c-floatwhy">Why is the till different?
          <select name="float_override_reason">
            <option value="">Choose a reason…</option>
            ${['Different opening float', 'Temporary change fund', 'Register transfer', 'Correction', 'Other']
              .map((x) => `<option${row.float_override_reason === x ? ' selected' : ''}>${x}</option>`).join('')}
          </select></label>
      </div>

      <!-- The two numbers. Big, and first. -->
      <div class="cq-two">
        <label class="cq-n">
          <span class="cq-n-l">Cash sales</span>
          <span class="cq-n-h">what the POS rang in cash</span>
          <span class="cq-n-f"><i>$</i><input name="cash_sales" id="c-sales" type="number" step="0.01" min="0"
            inputmode="decimal" value="${m(row.cash_sales_cents)}" placeholder="0.00" autocomplete="off"></span>
        </label>
        <label class="cq-n">
          <span class="cq-n-l">Counted in the drawer</span>
          <span class="cq-n-h">everything, before you pull the deposit</span>
          <span class="cq-n-f"><i>$</i><input name="counted" id="c-counted" type="number" step="0.01" min="0"
            inputmode="decimal" value="${m(row.counted_cents)}" placeholder="0.00" autocomplete="off"></span>
        </label>
      </div>

      <!-- The answer, in words, the moment both numbers exist. -->
      <div class="cq-verdict" id="cq-v">
        <div class="cq-v-head"><span class="cq-v-dot"></span><b id="cq-v-t">Enter the two numbers above</b></div>
        <div class="cq-v-sub" id="cq-v-s">Everything else works itself out.</div>
        <div class="cq-v-do" id="cq-v-do" hidden></div>
      </div>

      <div class="cq-box cq-warnbox" id="cq-varwrap" hidden>
        <label class="fld"><b id="cq-varlabel">Why is the drawer out?</b>
          <textarea name="variance_note" rows="2" id="c-varnote"
            placeholder="What happened — a miscount, a missed paid-out, a till error">${esc(row.variance_note || '')}</textarea></label>
      </div>

      <label class="fld cq-who">Counted by
        <input name="counted_by" list="c-staff" value="${esc(row.counted_by || row.closed_by || (isNew ? me : ''))}" placeholder="Who counted it" required>
      </label>
      <datalist id="c-staff">${staff.map((e) => `<option value="${esc(e.name)}">`).join('')}</datalist>

      <div class="cq-act">
        <button class="btn btn-primary cq-save" type="submit" name="status" value="final">${isNew ? 'Save the count' : 'Save changes'}</button>
        <button class="btn btn-ghost btn-sm" type="submit" name="status" value="draft">Finish later</button>
      </div>

      <!-- Everything below here is the one close in twenty. -->
      <div class="cq-more">
        <button type="button" class="cq-more-b" onclick="cashToggle('cq-money', this)" aria-expanded="${openMoney ? 'true' : 'false'}">
          ＋ Money in or out of the drawer</button>
        <button type="button" class="cq-more-b" onclick="cashToggle('cq-adv', this)" aria-expanded="${openAdv ? 'true' : 'false'}">
          Advanced</button>
      </div>

      <div class="cq-box" id="cq-money"${openMoney ? '' : ' hidden'}>
        <div class="mvblock">
          <div class="mv-h"><b>Paid out / taken from the drawer</b>
            <span class="mv-tot" id="paid-total"></span></div>
          <div class="fld-hint">Reimbursements, petty cash, an approved purchase. This lowers what the drawer should hold.</div>
          <div id="paid-list" class="mvlist">${paid.map((x, i) => mvItem(x, i, 'paid')).join('')}</div>
          ${mvDraft('paid')}
        </div>
        <div class="mvblock">
          <div class="mv-h"><b>Cash added</b>
            <span class="mv-tot" id="added-total"></span></div>
          <div class="fld-hint">Change brought in, a correction, a transfer from another register.</div>
          <div id="added-list" class="mvlist">${added.map((x, i) => mvItem(x, i, 'added')).join('')}</div>
          ${mvDraft('added')}
        </div>
      </div>

      <div class="cq-box" id="cq-adv"${openAdv ? '' : ' hidden'}>
        <div class="fld-row3">
          <label class="fld">Leave in the register<input name="ending" id="c-ending" type="number" step="0.01" min="0" inputmode="decimal"
            value="${row.ending_float_cents == null ? m(dflt) : m(row.ending_float_cents)}"></label>
          <label class="fld">Deposit<input name="deposit" id="c-deposit" type="number" step="0.01" min="0" inputmode="decimal"
            value="${m(row.actual_deposit_cents)}" placeholder="calculated"></label>
          <label class="fld">Destination<select name="deposit_destination">
            <option value="">—</option>
            ${CASH.DESTINATIONS.map((d) => `<option${row.deposit_destination === d ? ' selected' : ''}>${d}</option>`).join('')}
          </select></label>
        </div>
        <label class="fld inv-hide" id="c-overwhy">Why does the deposit differ?
          <textarea name="override_reason" rows="2">${esc(row.override_reason || '')}</textarea></label>
        <div class="fld-row3">
          <label class="fld">Bag number<input name="deposit_bag" value="${esc(row.deposit_bag || '')}" placeholder="Optional"></label>
          <label class="fld">Reference<input name="deposit_reference" value="${esc(row.deposit_reference || '')}" placeholder="Optional"></label>
          <label class="fld">Verified by<input name="verified_by" list="c-staff" value="${esc(row.verified_by || '')}" placeholder="Optional"></label>
        </div>
        <label class="fld">Closing manager<input name="closed_by" list="c-staff" value="${esc(row.closed_by || '')}" placeholder="Optional"></label>
        <details class="rl-adv" id="c-denoms"${denoms.length ? ' open' : ''}>
          <summary>Count by denomination</summary>
          <div class="denoms">
            ${CASH.DENOMS.map((d) => {
              const found = denoms.find((x) => x.denom_cents === d);
              return `<label class="denom"><span>${CASH.DENOM_LABEL[d]}</span>
                <input name="denom_${d}" type="number" min="0" step="1" inputmode="numeric" value="${found && found.qty ? found.qty : ''}" placeholder="0" data-denom="${d}"></label>`;
            }).join('')}
          </div>
          <div class="denom-total">Denominations add to <b id="c-denomtotal">$0.00</b>
            <button type="button" class="btn btn-sm" onclick="cashUseDenoms()">Use this as the counted amount</button></div>
        </details>
        <label class="fld">Closing notes<textarea name="note" rows="2">${esc(row.note || '')}</textarea></label>
      </div>
    </div>
    <input type="hidden" name="paid_n" id="paid-n" value="${Math.max(1, paid.length)}">
    <input type="hidden" name="added_n" id="added-n" value="${added.length}">
    </form>
    <script>
      window.CASH_DEFAULT = ${dflt};
      window.CASH_TOL = ${JSON.stringify(CASH.tolerance())};
      window.CASH_PAID_REASONS = ${JSON.stringify(CASH.PAID_REASONS)};
      window.CASH_ADDED_REASONS = ${JSON.stringify(CASH.ADDED_REASONS)};
    </script>
    <script>${cashScript()}</script>`);
}

function cashScript() {
  return `
  function cmoney(c){ var n=Math.abs(Math.round(c)); return (c<0?'-$':'$')+(n/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function cnum(id){ var e=document.getElementById(id); return e&&e.value!=='' ? Math.round(parseFloat(e.value)*100)||0 : null; }
  function cashToggle(id, btn){
    var el=document.getElementById(id);
    el.hidden = !el.hidden;
    btn.setAttribute('aria-expanded', el.hidden ? 'false' : 'true');
    if(!el.hidden){ var f=el.querySelector('input,select,textarea'); if(f) f.focus(); }
  }
  // --- money in and out ------------------------------------------------------
  // Typing into a row gave no sign that anything had been recorded, and "Add"
  // produced a second empty row — so a manager who typed $75 and pressed Add
  // saw their entry apparently vanish. An entry is committed now: it becomes a
  // line you can read, with the fields that post it hidden behind.

  function cashRemove(btn){
    var item = btn.closest('.mvi');
    var kind = item.getAttribute('data-kind');
    item.remove();
    cashRenumber(kind);
    cashCalc();
  }

  // Indices have to stay contiguous from zero. The server walks paid_amt_0
  // upwards and a gap would silently drop everything after it.
  function cashRenumber(kind){
    var items = document.querySelectorAll('#'+kind+'-list .mvi');
    items.forEach(function(el, i){
      el.querySelectorAll('input[type=hidden]').forEach(function(h){
        h.name = h.name.replace(/_(amt|reason|who)_\\d+$/, function(_, f){ return '_'+f+'_'+i; });
      });
    });
  }

  function cmoneyLine(kind, cents){
    return (kind==='paid' ? '−' : '+') + cmoney(cents);
  }

  /** Move whatever is in the draft line into the list. Returns true if it did. */
  function cashCommit(kind, quiet){
    var draft = document.querySelector('[data-draft="'+kind+'"]');
    if(!draft) return false;
    var amtEl = draft.querySelector('.mvd-amt');
    var cents = amtEl.value==='' ? null : Math.round(parseFloat(amtEl.value)*100);
    if(!cents){
      // Nothing to add. Say so rather than doing nothing, which is what made
      // the old version feel broken.
      if(!quiet){ amtEl.focus(); amtEl.classList.add('mvd-nudge');
        setTimeout(function(){ amtEl.classList.remove('mvd-nudge'); }, 600); }
      return false;
    }
    var reason = draft.querySelector('.mvd-reason').value;
    var who = draft.querySelector('.mvd-who').value.trim();
    var list = document.getElementById(kind+'-list');
    var i = list.querySelectorAll('.mvi').length;
    var out = kind === 'paid';

    var el = document.createElement('div');
    el.className = 'mvi'; el.setAttribute('data-kind', kind);
    el.innerHTML =
      '<span class="mvi-i '+(out?'out':'in')+'">'+(out?'↓':'↑')+'</span>'
      + '<span class="mvi-t"><b></b>'+(who?'<i></i>':'')+'</span>'
      + '<b class="mvi-a '+(out?'out':'in')+'">'+cmoneyLine(kind, cents)+'</b>'
      + '<button type="button" class="mvi-x" onclick="cashRemove(this)" aria-label="Remove">✕</button>'
      + '<input type="hidden" name="'+kind+'_amt_'+i+'">'
      + '<input type="hidden" name="'+kind+'_reason_'+i+'">'
      + '<input type="hidden" name="'+kind+'_who_'+i+'">';
    // textContent, not innerHTML — a recipient is somebody's name and goes in
    // as text, never as markup.
    el.querySelector('.mvi-t b').textContent = reason || (out ? 'Paid out' : 'Cash added');
    if(who) el.querySelector('.mvi-t i').textContent = (out ? 'to ' : 'by ') + who;
    var hid = el.querySelectorAll('input[type=hidden]');
    hid[0].value = (cents/100).toFixed(2);
    hid[1].value = reason;
    hid[2].value = who;
    list.appendChild(el);

    amtEl.value = ''; draft.querySelector('.mvd-who').value = '';
    if(!quiet) amtEl.focus();
    cashCalc();
    return true;
  }
  function cashUseDenoms(){
    var t=0; document.querySelectorAll('[data-denom]').forEach(function(i){ t += (parseInt(i.value,10)||0) * parseInt(i.dataset.denom,10); });
    document.getElementById('c-counted').value=(t/100).toFixed(2); cashCalc();
  }

  function cashCalc(){
    var sum=function(kind){
      var t=0;
      document.querySelectorAll('#'+kind+'-list input[name$="_amt_0"],#'+kind+'-list input[type=hidden]')
        .forEach(function(i){ if(/_amt_\\d+$/.test(i.name)) t+=Math.round((parseFloat(i.value)||0)*100); });
      // A draft line the manager has typed but not pressed Add on still counts
      // towards the arithmetic, so the verdict never lags behind the screen.
      var draft=document.querySelector('[data-draft="'+kind+'"] .mvd-amt');
      if(draft && draft.value!=='') t+=Math.round(parseFloat(draft.value)*100)||0;
      return t;
    };
    var open=cnum('c-float'); if(open==null) open=CASH_DEFAULT;
    var sales=cnum('c-sales'), paid=sum('paid'), added=sum('added');
    var counted=cnum('c-counted');
    var end=cnum('c-ending'); if(end==null) end=CASH_DEFAULT;
    var exp=open+(sales||0)+added-paid;

    // The context line restates what the page is assuming, so a wrong date or
    // a wrong till is visible without opening anything.
    var t=document.getElementById('cq-till'); if(t) t.textContent=cmoney(open);
    var dsel=document.querySelector('[name=daypart]'), svc=document.getElementById('cq-svc');
    if(dsel && svc) svc.textContent=dsel.options[dsel.selectedIndex].text;
    var dt2=document.querySelector('[name=date]'), whn=document.getElementById('cq-when');
    if(dt2 && whn && dt2.value){
      whn.textContent=new Date(dt2.value+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
    }
    document.getElementById('c-floatwhy').classList.toggle('inv-hide', open===CASH_DEFAULT);

    ['paid','added'].forEach(function(k){
      var el=document.getElementById(k+'-total');
      if(!el) return;
      var n=document.querySelectorAll('#'+k+'-list .mvi').length;
      var t=k==='paid'?paid:added;
      el.textContent = t ? cmoneyLine(k, t) + (n>1 ? ' · '+n+' entries' : '') : '';
      el.className = 'mv-tot' + (t ? ' on '+k : '');
    });

    var dtot=0; document.querySelectorAll('[data-denom]').forEach(function(i){ dtot += (parseInt(i.value,10)||0)*parseInt(i.dataset.denom,10); });
    var dte=document.getElementById('c-denomtotal'); if(dte) dte.textContent=cmoney(dtot);

    var box=document.getElementById('cq-v'), ttl=document.getElementById('cq-v-t'),
        sub=document.getElementById('cq-v-s'), doo=document.getElementById('cq-v-do'),
        vw=document.getElementById('cq-varwrap'), vl=document.getElementById('cq-varlabel');

    // Nothing yet, or only half of it. Say what is still needed rather than
    // showing a variance against a number nobody has entered.
    if(sales==null || counted==null){
      box.className='cq-verdict';
      if(sales==null && counted==null){ ttl.textContent='Enter the two numbers above'; sub.textContent='Everything else works itself out.'; }
      else if(counted==null){ ttl.textContent='The drawer should hold '+cmoney(exp); sub.textContent='Count it and put the total in.'; }
      else { ttl.textContent='Now add the cash sales'; sub.textContent='From the POS report, so the count has something to check against.'; }
      doo.hidden=true; vw.hidden=true;
      return;
    }

    var v=counted-exp, mag=Math.abs(v);
    var tier = v===0 ? 'exact' : mag<=CASH_TOL.minor ? 'near' : mag<=CASH_TOL.critical ? 'review' : 'bad';
    box.className='cq-verdict cq-v-'+tier;
    ttl.textContent = v===0 ? 'The drawer is exact'
      : cmoney(mag)+(v>0?' over':' short');
    sub.textContent = 'Should hold '+cmoney(exp)+' · counted '+cmoney(counted)
      + (tier==='near' ? ' · within tolerance' : '');

    // What to physically do next, which is the part they came for.
    var dep=counted-end, typed=cnum('c-deposit');
    var dest=document.querySelector('[name=deposit_destination]');
    var where=(dest && dest.value) ? dest.value.toLowerCase() : 'the safe';
    var lines=[];
    if(dep>0) lines.push('<b>Take '+cmoney(dep)+'</b> to '+where+', leave '+cmoney(end)+' in the register.');
    else if(dep===0) lines.push('Nothing to deposit — the '+cmoney(end)+' stays in the register.');
    else lines.push('<b>Short '+cmoney(-dep)+'</b> of the '+cmoney(end)+' the register should keep.');
    if(typed!=null && typed!==dep){
      var un=dep-typed;
      lines.push(cmoney(Math.abs(un))+' would be unaccounted for. Say why under Advanced, or clear the deposit to use '+cmoney(dep)+'.');
    }
    doo.innerHTML=lines.join('<br>'); doo.hidden=false;
    document.getElementById('c-overwhy').classList.toggle('inv-hide', !(typed!=null && typed!==dep));

    // The note is asked for the moment it is owed, not refused at the end.
    var needNote = mag>CASH_TOL.minor;
    vw.hidden = !needNote;
    if(needNote) vl.textContent = tier==='bad'
      ? 'This one needs explaining before it can be saved'
      : 'Why is the drawer out?';
  }
  document.addEventListener('input', function(e){ if(e.target.closest('#cashform')) cashCalc(); });
  document.addEventListener('change', function(e){ if(e.target.closest('#cashform')) cashCalc(); });

  // Enter adds the line rather than submitting the whole count.
  document.addEventListener('keydown', function(e){
    var d = e.target.closest && e.target.closest('[data-draft]');
    if(d && e.key === 'Enter'){ e.preventDefault(); cashCommit(d.getAttribute('data-draft')); }
  });

  // A typed-but-not-added line is swept up on submit. Requiring Add would be a
  // new way to lose an entry, which is the bug this replaced.
  var form = document.getElementById('cashform');
  if(form) form.addEventListener('submit', function(){
    cashCommit('paid', true); cashCommit('added', true);
  });

  cashCalc();`;
}

app.get('/cash/new', (req, res) => {
  if (!canWrite()) return res.redirect('/cash');
  const drawer = CASH.q.drawers.all()[0];
  const today = isoDate(startOfToday());
  // Whatever service actually ran today, rather than a guess. A café that
  // never serves dinner should not have to correct the field every night.
  const ran = db.prepare('SELECT daypart FROM shifts WHERE date = ? ORDER BY id DESC LIMIT 1').get(today);
  res.send(cashForm({
    date: today, daypart: ran ? ran.daypart : 'cafe', drawer_id: drawer ? drawer.id : null,
    float_cents: CASH.defaultFloat(), ending_float_cents: CASH.defaultFloat(),
  }, [], [], req));
});

app.get('/cash/:id/edit', (req, res) => {
  const row = CASH.q.one.get(Number(req.params.id));
  if (!row) return res.status(404).send(layout('Not found', '<div class="empty2"><div class="empty2-t">No such reconciliation</div></div>'));
  if (!canWrite()) return res.redirect(`/cash/${row.id}`);
  res.send(cashForm(row, CASH.q.movements.all(row.id), CASH.q.denoms.all(row.id), req));
});

/** Read the posted form into a row plus its movements and denominations. */
function cashBody(body) {
  const n = (v) => (v === '' || v == null ? null : toCents(v));
  const movements = [];
  for (const kind of ['paid', 'added']) {
    for (let i = 0; i < 40; i++) {
      const amt = body[`${kind}_amt_${i}`];
      if (amt === undefined) continue;
      const cents = toCents(amt);
      if (!cents) continue;
      movements.push({
        movement_type: kind === 'paid' ? 'paid_out' : 'cash_added',
        amount_cents: cents,
        reason: String(body[`${kind}_reason_${i}`] || '').trim() || null,
        recipient: String(body[`${kind}_who_${i}`] || '').trim() || null,
      });
    }
  }
  const denoms = CASH.DENOMS.map((d) => ({ denom_cents: d, qty: parseInt(body[`denom_${d}`], 10) || 0 })).filter((x) => x.qty > 0);
  const paidTotal = movements.filter((m) => m.movement_type !== 'cash_added').reduce((a, m) => a + m.amount_cents, 0);
  const addedTotal = movements.filter((m) => m.movement_type === 'cash_added').reduce((a, m) => a + m.amount_cents, 0);

  const counted = n(body.counted);
  const ending = n(body.ending);
  const typedDeposit = n(body.deposit);
  const row = {
    date: String(body.date || '').slice(0, 10) || null,
    daypart: DAYPARTS.includes(body.daypart) ? body.daypart : 'dinner',
    location: 'Palm Vintage',
    drawer_id: body.drawer_id ? Number(body.drawer_id) : null,
    float_cents: n(body.float) ?? CASH.defaultFloat(),
    cash_sales_cents: n(body.cash_sales) ?? 0,
    paid_out_cents: paidTotal,
    cash_added_cents: addedTotal,
    counted_cents: counted,
    // Assumed, like the opening till. Both live behind Advanced now, so the
    // parser has to know the default rather than trusting a hidden field to
    // always be posted — otherwise a close that never opens Advanced has no
    // ending float, and the deposit silently comes out null.
    ending_float_cents: ending ?? CASH.defaultFloat(),
    // Left blank means "whatever the drawer says", which is the normal case.
    actual_deposit_cents: typedDeposit ?? (counted != null ? counted - (ending ?? CASH.defaultFloat()) : null),
    deposit_destination: String(body.deposit_destination || '').trim() || null,
    deposit_reference: String(body.deposit_reference || '').trim() || null,
    deposit_bag: String(body.deposit_bag || '').trim() || null,
    counted_by: String(body.counted_by || '').trim() || null,
    verified_by: String(body.verified_by || '').trim() || null,
    closed_by: String(body.closed_by || '').trim() || null,
    status: body.status === 'draft' ? 'draft' : 'final',
    note: String(body.note || '').trim() || null,
    variance_note: String(body.variance_note || '').trim() || null,
    override_reason: String(body.override_reason || '').trim() || null,
    float_override_reason: String(body.float_override_reason || '').trim() || null,
  };
  return { row, movements, denoms };
}

const saveCash = db.transaction((id, row, movements, denoms, actor) => {
  const before = id ? CASH.q.one.get(id) : null;
  let recId = id;
  const finalized = row.status === 'final' ? (before && before.finalized_at ? before.finalized_at : new Date().toISOString().slice(0, 19).replace('T', ' ')) : null;
  if (recId) CASH.q.update.run({ ...row, finalized_at: finalized, id: recId });
  else recId = CASH.q.add.run({ ...row, finalized_at: finalized, created_by: actor || null }).lastInsertRowid;

  CASH.q.clearMovements.run(recId);
  for (const m of movements) CASH.q.addMovement.run({ ...m, recon_id: recId, notes: null, occurred_at: row.date, created_by: actor || null });
  CASH.q.clearDenoms.run(recId);
  for (const d of denoms) CASH.q.addDenom.run(recId, d.denom_cents, d.qty);

  CASH.auditDiff(recId, actor, before, { ...row, id: recId }, row.override_reason || row.variance_note || null);
  return recId;
});

function cashSave(req, res, existingId) {
  const { row, movements, denoms } = cashBody(req.body);
  const check = CASH.validate(row);
  if (!check.ok) {
    return res.redirect(`${existingId ? `/cash/${existingId}/edit` : '/cash/new'}?err=1&msg=` + encodeURIComponent(check.errors[0]));
  }
  const who = (req.user && req.user.name) || 'Owner';
  const id = saveCash(existingId, row, movements, denoms, who);
  res.redirect(`/cash/${id}?msg=` + encodeURIComponent(row.status === 'draft' ? 'Saved as a draft.' : 'Reconciliation saved.'));
}

app.post('/cash', (req, res) => cashSave(req, res, null));
app.post('/cash/:id', (req, res) => {
  const row = CASH.q.one.get(Number(req.params.id));
  if (!row) return res.status(404).end();
  // A finalised record is not edited quietly. It can be reopened, which is
  // recorded, or voided and replaced.
  if (row.status === 'final' && !req.body.reopen_reason && row.legacy !== 1) {
    CASH.q.addAudit.run({ recon_id: row.id, actor: (req.user && req.user.name) || 'Owner',
      action: 'reopen', field: null, old_value: null, new_value: null, reason: 'edited after finalising' });
  }
  cashSave(req, res, row.id);
});

app.post('/cash/:id/void', (req, res) => {
  const row = CASH.q.one.get(Number(req.params.id));
  if (!row) return res.status(404).end();
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.redirect(`/cash/${row.id}?err=1&msg=` + encodeURIComponent('Voiding a reconciliation needs a reason.'));
  const who = (req.user && req.user.name) || 'Owner';
  CASH.q.voidIt.run(who, reason, row.id);
  CASH.q.addAudit.run({ recon_id: row.id, actor: who, action: 'void', field: null, old_value: row.status, new_value: 'void', reason });
  res.redirect(`/cash/${row.id}?msg=` + encodeURIComponent('Voided. The record stays for the audit trail.'));
});

app.post('/cash/:id/delete', (req, res) => {
  const row = CASH.q.one.get(Number(req.params.id));
  if (!row) return res.status(404).end();
  // Drafts are working notes. Anything finalised is a financial record and
  // gets voided instead, so the history stays whole.
  if (row.status !== 'draft') {
    return res.redirect(`/cash/${row.id}?err=1&msg=` + encodeURIComponent('Finalised reconciliations are voided, not deleted.'));
  }
  CASH.q.del.run(row.id);
  res.redirect('/cash?msg=' + encodeURIComponent('Draft deleted.'));
});

// --- detail -----------------------------------------------------------------
app.get('/cash/:id', (req, res) => {
  // -------------------------------------------------------------------------
  // How the drawer closed that night — not a database record with a UI on top.
  //
  // The page answers five questions in order, and the order is the point:
  //
  //   1. Was the drawer right?      the hero line, readable in about a second
  //   2. How was that worked out?   a receipt, because the arithmetic IS the
  //                                 explanation and a table of labels isn't
  //   3. What moved?                only rendered when something did
  //   4. What was banked?           beside the receipt, not buried under it
  //   5. Who closed it?             one byline, not a panel
  //
  // Everything else — denominations, the audit trail, references, voiding —
  // is behind a disclosure. It was previously a fourteen-row list restating
  // the four cards directly above it, which is how a page ends up long
  // without ever saying anything twice as clearly.
  // -------------------------------------------------------------------------
  const row = CASH.q.one.get(Number(req.params.id));
  if (!row) return res.status(404).send(layout('Not found', '<div class="empty2"><div class="empty2-t">No such reconciliation</div></div>'));
  const c = CASH.compute(row);
  const st = CASH.status(row);
  const movements = CASH.q.movements.all(row.id);
  const denoms = CASH.q.denoms.all(row.id);
  const audit = CASH.q.audit.all(row.id);
  const M = CASH.money;
  const voided = row.status === 'void';
  const draft = row.status === 'draft';

  // --- 1. was it right ------------------------------------------------------
  const tone = c.counted == null ? 'none'
    : st.key === 'exact' ? 'exact' : st.key === 'within' ? 'near'
    : st.key === 'review' ? 'review' : 'bad';
  const headline = c.counted == null ? 'Not counted yet'
    : c.variance === 0 ? 'The drawer was exact'
    : `${M(Math.abs(c.variance))} ${c.variance > 0 ? 'over' : 'short'}`;
  const headsub = c.counted == null
    ? 'This one was saved before the drawer was counted.'
    : `${M(c.counted)} counted against ${M(c.expected)} expected`
      + (st.key === 'within' ? ' · within tolerance' : '');

  // --- 2. the receipt -------------------------------------------------------
  const line = (label, value, cls = '') =>
    `<div class="cr-l ${cls}"><span>${label}</span><b>${value}</b></div>`;
  const receipt = [
    line('Opening till', M(c.opening)),
    line('Cash sales', '+ ' + M(c.sales)),
    c.added ? line('Cash added', '+ ' + M(c.added)) : '',
    c.paidOut ? line('Paid out', '− ' + M(c.paidOut)) : '',
    line('Should be in the drawer', M(c.expected), 'cr-sum'),
    c.counted == null ? '' : line('Actually counted', M(c.counted)),
    c.counted == null ? '' : line('Variance',
      c.variance === 0 ? 'Exact' : (c.variance > 0 ? '+ ' : '− ') + M(Math.abs(c.variance)),
      'cr-sum cr-var cr-var-' + tone),
  ].filter(Boolean).join('');

  // --- 4. the deposit -------------------------------------------------------
  const dep = c.actualDeposit ?? c.calcDeposit;
  const depBlock = row.legacy
    ? `<div class="cr-dep cr-dep-none"><div class="cr-dep-l">Deposit</div>
        <div class="cr-dep-empty">Not recorded — this night pre-dates deposit tracking.</div></div>`
    : dep == null
      ? `<div class="cr-dep cr-dep-none"><div class="cr-dep-l">Deposit</div>
          <div class="cr-dep-empty">Nothing banked yet.</div></div>`
      : `<div class="cr-dep">
          <div class="cr-dep-l">${dep > 0 ? 'Banked' : 'Nothing banked'}</div>
          <div class="cr-dep-v">${M(dep)}</div>
          <div class="cr-dep-w">${row.deposit_destination ? 'to the ' + esc(row.deposit_destination.toLowerCase()) : 'destination not recorded'}</div>
          <div class="cr-dep-rest">
            <span>Left in the register</span><b>${c.ending == null ? '—' : M(c.ending)}</b>
          </div>
          ${row.deposit_bag || row.deposit_reference
            ? `<div class="cr-dep-ref">${[row.deposit_bag && 'Bag ' + esc(row.deposit_bag), row.deposit_reference && 'Ref ' + esc(row.deposit_reference)].filter(Boolean).join(' · ')}</div>` : ''}
        </div>`;

  // --- 3. what moved --------------------------------------------------------
  const mvBlock = movements.length ? `
    <section class="cr-card">
      <div class="cr-card-h"><b>What moved in and out</b><span>${movements.length} entr${movements.length === 1 ? 'y' : 'ies'}</span></div>
      <div class="cr-mv">${movements.map((mv) => {
        const out = mv.movement_type !== 'cash_added';
        return `<div class="cr-mv-r">
          <span class="cr-mv-i ${out ? 'out' : 'in'}">${out ? '↓' : '↑'}</span>
          <span class="cr-mv-t"><b>${esc(mv.reason || (out ? 'Paid out' : 'Cash added'))}</b>
            ${mv.recipient ? `<i>${out ? 'to' : 'by'} ${esc(mv.recipient)}</i>` : ''}</span>
          <b class="cr-mv-a ${out ? 'out' : 'in'}">${out ? '−' : '+'}${M(mv.amount_cents)}</b>
        </div>`;
      }).join('')}</div>
    </section>` : '';

  const denomTotal = denoms.reduce((a, d) => a + d.denom_cents * d.qty, 0);
  const when = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : '');

  res.send(layout(`Cash · ${row.date}`, `
    ${flash(req)}
    <div class="cr">
      <div class="cr-top">
        <div class="cr-top-t">
          <a class="link back" href="/cash">← Cash reconciliation</a>
          <h1>${esc(cashDayLabel(row.date))} · ${esc(dp(row.daypart))}</h1>
        </div>
        ${canWrite() && !voided ? `<a class="btn btn-primary btn-sm" href="/cash/${row.id}/edit">Edit</a>` : ''}
      </div>

      ${voided ? `<div class="cr-void">
        <b>This reconciliation was voided</b>
        <span>${esc(row.void_reason || 'No reason recorded')}${row.voided_by ? ' — ' + esc(row.voided_by) : ''}${row.voided_at ? ' · ' + esc(when(row.voided_at)) : ''}</span>
        <i>The figures below are kept as they were. A financial record is cancelled, never deleted.</i>
      </div>` : ''}
      ${draft ? '<div class="cr-draft">Saved as a draft — not finalised.</div>' : ''}

      <!-- 1. Was the drawer correct? -->
      <div class="cr-hero cr-hero-${tone}">
        <div class="cr-hero-m"><span class="cr-hero-dot"></span><b>${esc(headline)}</b></div>
        <div class="cr-hero-s">${esc(headsub)}</div>
        ${row.variance_note ? `<div class="cr-hero-n">${esc(row.variance_note)}</div>` : ''}
      </div>

      ${c.unaccounted ? `<div class="cr-flag">
        <b>${M(Math.abs(c.unaccounted))} unaccounted for</b>
        <span>The drawer said to bank ${M(c.calcDeposit)} and ${M(c.actualDeposit)} was recorded.
          ${row.override_reason ? esc(row.override_reason) : 'No reason was given.'}</span>
      </div>` : ''}

      <!-- 2. How was it worked out?   4. What was banked? -->
      <div class="cr-grid">
        <section class="cr-card">
          <div class="cr-card-h"><b>How that was worked out</b></div>
          <div class="cr-receipt">${receipt}</div>
        </section>
        ${depBlock}
      </div>

      <!-- 3. What moved? -->
      ${mvBlock}

      <!-- 5. Who closed it? -->
      <div class="cr-by">
        <span><b>${esc(row.counted_by || row.closed_by || 'Nobody recorded')}</b> counted it</span>
        ${row.verified_by ? `<span>· verified by <b>${esc(row.verified_by)}</b></span>` : ''}
        ${row.finalized_at ? `<span>· finalised ${esc(when(row.finalized_at))}</span>` : ''}
      </div>
      ${row.note ? `<div class="cr-note">${esc(row.note)}</div>` : ''}

      <!-- Everything a normal review never needs -->
      <div class="cr-extras">
        ${denoms.length ? `<details class="cr-x">
          <summary>Counted by denomination<i>${M(denomTotal)}</i></summary>
          <div class="cr-denoms">${denoms.map((d) => `<div class="cr-dn">
            <span>${CASH.DENOM_LABEL[d.denom_cents]}</span><i>× ${d.qty}</i><b>${M(d.denom_cents * d.qty)}</b></div>`).join('')}</div>
          ${denomTotal !== c.counted && c.counted != null
            ? `<p class="cr-x-note">These add to ${M(denomTotal)}, and ${M(c.counted)} was recorded as the count.</p>` : ''}
        </details>` : ''}

        <details class="cr-x">
          <summary>History<i>${audit.length} entr${audit.length === 1 ? 'y' : 'ies'}</i></summary>
          ${audit.length ? `<ol class="cr-tl">${audit.slice(0, 40).map((a) => `
            <li class="cr-tl-i">
              <span class="cr-tl-d"></span>
              <div class="cr-tl-b">
                <b>${esc(a.action === 'create' ? 'Counted and saved' : a.action)}${a.actor ? ` · ${esc(a.actor)}` : ''}</b>
                ${a.field ? `<i>${esc(a.field.replace(/_cents$/, '').replace(/_/g, ' '))}: ${esc(cashAuditVal(a.field, a.old_value))} → ${esc(cashAuditVal(a.field, a.new_value))}</i>`
                  : a.action === 'create' && a.new_value ? `<i>drawer came to ${CASH.money(Number(a.new_value))}</i>` : ''}
                ${a.reason ? `<i>${esc(a.reason)}</i>` : ''}
                <time>${esc(when(a.created_at))}</time>
              </div>
            </li>`).join('')}</ol>
            ${audit.length > 40 ? `<p class="cr-x-note">Showing the last 40 of ${audit.length}.</p>` : ''}`
            : '<p class="cr-x-note">This record pre-dates the audit trail.</p>'}
        </details>

        ${canWrite() && !voided ? `<details class="cr-x cr-x-danger">
          <summary>${draft ? 'Delete this draft' : 'Void this reconciliation'}<i>careful</i></summary>
          ${draft
            ? `<p class="cr-x-note">A draft was never finalised, so it can be removed outright.</p>
               <form method="post" action="/cash/${row.id}/delete" onsubmit="return confirm('Delete this draft?')">
                 <button class="btn btn-danger btn-sm" type="submit">Delete draft</button></form>`
            : `<p class="cr-x-note">A finalised count is a financial record. Voiding keeps every figure and marks it cancelled — it cannot be deleted.</p>
               <form method="post" action="/cash/${row.id}/void" class="voidform">
                 <input name="reason" placeholder="Why is this being voided?" required>
                 <button class="btn btn-danger btn-sm" type="submit">Void</button></form>`}
        </details>` : ''}
      </div>
    </div>`));
});

// ---------------------------------------------------------------------------
// Tip-out policy — calm read-only view + rule builder, versioned with history
// ---------------------------------------------------------------------------
const RLBL = { kitchen: 'Kitchen', barista: 'Barista', bartender: 'Bartender', busser: 'Busser' };
const BLBL = { food: "each server's food sales", coffee: "each server's coffee sales", alcohol: "each server's alcohol sales", total_sales: "each server's total sales", total_tips: "each server's total tips", remaining: 'server tips left after other tip-outs' };
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

// ---------------------------------------------------------------------------
// EMAIL SETTINGS — connection status and a test send, so a bad password shows
// up here rather than on a shift you're trying to close out at 1am.
// ---------------------------------------------------------------------------
app.get('/email', (req, res) => {
  const st = mailStatus();
  const mgr = q.allEmployees.all().find((e) => e.role === 'manager' && e.email);
  const testTo = req.query.to || (mgr && mgr.email) || st.from || '';

  const banner = st.ready
    ? `<div class="flash flash-ok"><div>Connected as <b>${esc(st.from)}</b>. Staff emails will send from this address.</div></div>`
    : `<div class="flash flash-warn"><div><b>Not sending yet.</b> ${esc(st.problem)}</div></div>`;

  const setup = st.ready ? '' : `
    <div class="card">
      <div class="card-head"><strong>Connect a Gmail account</strong></div>
      <ol class="steps">
        <li>Sign in to the Gmail account you want the emails to come from.</li>
        <li>Turn on <b>2-Step Verification</b> at <code>myaccount.google.com/security</code> — App Passwords don't exist without it.</li>
        <li>Go to <code>myaccount.google.com/apppasswords</code>, name it “ZWIN”, and create it.</li>
        <li>Google shows a 16-character password. Put it in your <code>.env</code> file yourself — never paste it into a chat:
          <pre>GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=the16charpassword
RESTAURANT_NAME=Your Restaurant</pre></li>
        <li>Restart the app, then send yourself a test below.</li>
      </ol>
      <p class="muted">Spaces in the App Password are fine — they get stripped automatically.</p>
    </div>`;

  const body = `
    ${flash(req)}
    <div class="page-head"><div><h1>Email</h1><p class="sub">Where nightly tip summaries send from.</p></div></div>
    ${banner}
    ${setup}
    <div class="card">
      <div class="card-head"><strong>Send a test</strong></div>
      <p class="muted">Checks the login and delivers one message. Nothing goes to staff.</p>
      <form method="post" action="/email/test" class="row-form">
        <input type="email" name="to" value="${esc(testTo)}" placeholder="you@example.com" required>
        <button class="btn btn-primary" type="submit"${st.ready ? '' : ' disabled'}>Send test email</button>
      </form>
      ${st.ready ? '' : '<p class="muted">Connect an account first.</p>'}
    </div>`;
  res.send(layout('Email', body));
});

app.post('/email/test', async (req, res) => {
  const to = (req.body.to || '').trim();
  if (!to) return res.redirect('/email?err=1&msg=' + encodeURIComponent('Enter an address to send the test to.'));
  try {
    await sendTest(to);
    res.redirect('/email?msg=' + encodeURIComponent(`Test email sent to ${to}. Check the inbox (and spam).`));
  } catch (err) {
    res.redirect('/email?err=1&msg=' + encodeURIComponent(err.message));
  }
});

// ---------------------------------------------------------------------------
// SALES — what the whole restaurant rang, not just what went through a server.
// Server sales stay per-person for tip-outs; these totals are what labor %,
// food cost % and prime cost are measured against.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// SALES — where the money came from.
//
// Revenue only. Labor %, food cost and prime cost moved to Performance: two
// pages quoting the same percentage is two chances to disagree, and this one
// is about the top line. If a number is about what things cost, it belongs
// next door.
// ---------------------------------------------------------------------------
app.get('/sales', (req, res) => {
  const today = isoDate(startOfToday());
  // "Jump to a month" posts ?m=YYYY-MM — a custom range over that whole month,
  // which is the quickest way to reach a day once there are months of them.
  const jump = /^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : null;
  const key = jump ? 'custom'
    : MX.RANGES.some(([k]) => k === req.query.r) || req.query.r === 'custom' ? req.query.r : '30';
  const r = jump
    ? { from: `${jump}-01`,
        to: isoDate(new Date(Date.UTC(Number(jump.slice(0, 4)), Number(jump.slice(5, 7)), 0))),
        label: 'Custom' }
    : MX.range(key, today, { from: req.query.from, to: req.query.to });
  const svc = ['cafe', 'dinner'].includes(req.query.svc) ? req.query.svc : '';

  // The range travels on every link into a service, so saving comes back here
  // rather than to a default thirty days.
  const retQ = [`r=${key}`, svc ? `svc=${svc}` : '', key === 'custom' ? `from=${r.from}&to=${r.to}` : '']
    .filter(Boolean).join('&');
  const openSale = (id) => `/sales/${id}?${retQ}`;

  const all = MX.period(r.from, r.to);
  const prev = MX.previous(r.from, r.to);
  const rows = svc ? all.rows.filter((x) => x.daypart === svc) : all.rows;
  const traded = rows.filter((x) => x.sales > 0);
  const series = MX.days(r.from, r.to);
  const dm = (d) => d.date.slice(5).replace('-', '/');

  const sales = rows.reduce((a, x) => a + x.sales, 0);
  const tips = rows.reduce((a, x) => a + x.tips, 0);
  const byDay = new Map();
  for (const x of traded) byDay.set(x.date, (byDay.get(x.date) || 0) + x.sales);
  const dayList = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
  const best = dayList[0], worst = dayList[dayList.length - 1];
  const avgDaily = byDay.size ? Math.round(sales / byDay.size) : null;
  const weekday = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

  const kpi = (tone, ico, label, value, sub, spark) => `
    <div class="mcard mcard-${tone}"><div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body"><div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div><div class="mcard-sub">${sub}</div></div>
      ${spark ? `<div class="mcard-spark">${spark}</div>` : ''}</div>`;

  // One headline, then the supporting figures as a strip. Six equal cards made
  // the reader decide which of six was the answer; "what happened" has one.
  // The "Average ticket — comes with the POS" card is gone: a card whose value
  // is a dash and whose subtitle is a roadmap earns nothing, and the POS
  // section at the foot of the page already says what is coming.
  const prevSales = svc ? prev.rows.filter((x) => x.daypart === svc).reduce((a, x) => a + x.sales, 0) : prev.sales;
  const brief = (cents) => (Math.abs(cents) >= 100000
    ? '$' + Math.round(cents / 100).toLocaleString('en-US') : money(cents));
  const scell = (label, value, exact, sub) => `<div class="dstrip-c"><i>${label}</i>
    <b${exact ? ` title="${esc(exact)}"` : ''}>${value}</b>${sub ? `<u>${sub}</u>` : ''}</div>`;
  // Per service divides by services that HAVE figures. A logged-but-unfilled
  // service would otherwise halve it and make every night look worse.
  const perService = traded.length ? Math.round(sales / traded.length) : null;

  const cards = `
    <section class="shero">
      <div class="shero-top">
        <div class="shero-n">
          <div class="shero-v" title="${esc(money(sales))}">${brief(sales)}</div>
          <div class="shero-l">total sales ${CH.delta(sales, prevSales)} <span>vs the period before</span></div>
        </div>
        ${series.length >= 3 ? `<div class="shero-spark">${CH.spark(series.map((d) => d.sales), { width: 120, height: 40 })}</div>` : ''}
      </div>
      <div class="dstrip-r shero-r">
        ${scell('Avg day', avgDaily === null ? '—' : brief(avgDaily), avgDaily === null ? '' : money(avgDaily),
          byDay.size ? `${byDay.size} day${byDay.size === 1 ? '' : 's'}` : 'none traded')}
        ${scell('Per service', perService === null ? '—' : brief(perService), perService === null ? '' : money(perService),
          traded.length ? `${traded.length} service${traded.length === 1 ? '' : 's'}` : 'none yet')}
        ${scell('Best day', best ? brief(best[1]) : '—', best ? money(best[1]) : '',
          best ? whenOf(best[0]) : 'nothing yet')}
        ${scell('Tips', tips ? brief(tips) : '—', tips ? money(tips) : '', tips ? 'collected' : 'none reported')}
      </div>
    </section>`;

  // --- revenue mix ----------------------------------------------------------
  const m = svc
    ? rows.reduce((a, x) => ({ food: a.food + x.food, coffee: a.coffee + x.coffee, alcohol: a.alcohol + x.alcohol,
        other: a.other + x.other, unsplit: a.unsplit + (x.food + x.coffee + x.alcohol + x.other > 0 ? 0 : x.server_sales) }),
      { food: 0, coffee: 0, alcohol: 0, other: 0, unsplit: 0 })
    : all.mix;
  const mixRows = [
    { label: 'Food', value: m.food, color: '#16a34a' },
    { label: 'Coffee', value: m.coffee, color: '#a16207' },
    { label: 'Alcohol', value: m.alcohol, color: '#7c3aed' },
    { label: 'Other', value: m.other, color: '#64748b' },
  ].filter((x) => x.value > 0);

  // --- service split --------------------------------------------------------
  const services = [['cafe', 'Café'], ['dinner', 'Dinner']].map(([k, label]) => {
    const list = all.rows.filter((x) => x.daypart === k && x.sales > 0);
    return { k, label, sales: list.reduce((a, x) => a + x.sales, 0), shifts: list.length };
  }).filter((x) => x.shifts);

  // --- highlights: only things the data actually supports -------------------
  const hi = [];
  if (best) hi.push(`Best day was <b>${weekday(best[0])} ${best[0].slice(5)}</b> at <b>${money(best[1])}</b>.`);
  if (prevSales > 0) {
    const d = ((sales - prevSales) / prevSales) * 100;
    hi.push(`Sales are <b>${d >= 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)}%</b> on the period before.`);
  }
  const mixTotal = mixRows.reduce((a, x) => a + x.value, 0);
  if (mixTotal) {
    const top = [...mixRows].sort((a, b) => b.value - a.value)[0];
    hi.push(`<b>${top.label}</b> was <b>${Math.round((top.value / mixTotal) * 100)}%</b> of revenue.`);
  }
  if (services.length > 1) {
    const t = [...services].sort((a, b) => b.sales - a.sales)[0];
    hi.push(`<b>${t.label}</b> brought in the most, at <b>${money(t.sales)}</b>.`);
  }
  if (byDay.size >= 7 && avgDaily) {
    const quiet = dayList.filter(([, v]) => v < avgDaily * 0.82);
    if (quiet.length) hi.push(`${quiet.length} day${quiet.length === 1 ? ' was' : 's were'} more than 18% below the average.`);
  }

  // --- daily rows -----------------------------------------------------------
  // Every service in the range, not only the ones that already have figures.
  // Listing `traded` hid the one row anybody actually needed to click: a
  // service with no sales entered yet is exactly what you came here to fix,
  // and it was invisible on the page whose job is entering them.
  // A closed day is answered, not outstanding: staff worked, there were no
  // sales, and that is the whole story. Leaving it in here would nag forever.
  const awaiting = rows.filter((x) => x.sales === 0 && !x.closed);
  // Days standing on server sales because no restaurant total was ever entered.
  const serverOnlyCount = rows.filter((x) =>
    x.sales > 0 && x.food + x.coffee + x.alcohol + x.other === 0 && x.server_sales > 0).length;
  const dayRows = [...rows].sort((a, b) => (b.date + b.daypart).localeCompare(a.date + a.daypart)).slice(0, 60).map((x) => {
    const split = x.food + x.coffee + x.alcohol + x.other > 0;
    const none = x.sales === 0;
    return `<a class="srow2${none ? ' srow2-todo' : ''}" href="${openSale(x.id)}">
      <span class="s2-d"><b>${Number(x.date.slice(8))}</b><i>${new Date(x.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' })}</i></span>
      <span class="s2-s">${dp(x.daypart)}${none ? '<span class="s2-tag">no sales yet</span>' : ''}</span>
      <span class="s2-n"><i>Sales</i><b>${none ? '—' : money(x.sales)}</b></span>
      <span class="s2-n"><i>Food</i><b>${split ? money(x.food) : '—'}</b></span>
      <span class="s2-n"><i>Coffee</i><b>${split ? money(x.coffee) : '—'}</b></span>
      <span class="s2-n"><i>Alcohol</i><b>${split ? money(x.alcohol) : '—'}</b></span>
      <span class="s2-n"><i>Tips</i><b>${money(x.tips)}</b></span>
      <span class="s2-go">${canWrite() ? (none ? 'Enter' : 'Edit') : ''} ›</span>
    </a>`;
  }).join('');

  // --- the day ledger -------------------------------------------------------
  // Grouped by month and collapsed, because after two months of backfill this
  // is 60+ services and a flat stack of cards is unusable. Each row is one
  // line to scan; the detail opens in place rather than on another page.
  const perDay = new Map();
  for (const x of rows) {
    const d = perDay.get(x.date) || { date: x.date, sales: 0, food: 0, coffee: 0, alcohol: 0, other: 0, tips: 0 };
    d.sales += x.sales; d.food += x.food; d.coffee += x.coffee;
    d.alcohol += x.alcohol; d.other += x.other; d.tips += x.tips;
    perDay.set(x.date, d);
  }

  const cash = new Map();
  if (navAllowed('/cash')) for (const c of CASH.q.recent.all()) cash.set(`${c.date}|${c.daypart}`, c);

  const MONTH_LBL = (ym) => new Date(ym + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const ordered = [...rows].sort((a, b) => (b.date + b.daypart).localeCompare(a.date + a.daypart));
  const months = [];
  for (const x of ordered) {
    const ym = x.date.slice(0, 7);
    if (!months.length || months[months.length - 1].ym !== ym) months.push({ ym, list: [] });
    months[months.length - 1].list.push(x);
  }

  const ledgerRow = (x) => {
    const split = x.food + x.coffee + x.alcohol + x.other > 0;
    const none = x.sales === 0 && !x.closed;
    const serverOnly = !none && !split && x.server_sales > 0;
    const st = shiftState(x, today);
    const cr = cash.get(`${x.date}|${x.daypart}`);
    const cs = cr ? CASH.status(cr) : null;
    const dow = new Date(x.date + 'T00:00:00').getDay();
    const weekend = dow === 0 || dow === 5 || dow === 6;

    return `<details class="bs-srow bs-dayrow${weekend ? ' wknd' : ''}" id="s${x.id}">
      <summary class="bs-sr">
        <span class="bs-lr-d">${new Date(x.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} ${Number(x.date.slice(8))}</span>
        <span class="bs-lr-s">${esc(dp(x.daypart))}${serverOnly ? '<i class="bs-tag">server only</i>' : ''}${none ? '<i class="bs-tag warn">no sales</i>' : ''}${x.closed ? '<i class="bs-tag">closed</i>' : ''}</span>
        <span class="bs-sr-f">${none ? '<span class="bs-em">—</span>' : money(x.sales)}</span>
        <span class="bs-sr-f muted">${split && x.food ? money(x.food) : '<span class="bs-em">—</span>'}</span>
        <span class="bs-sr-f muted">${split && x.coffee ? money(x.coffee) : '<span class="bs-em">—</span>'}</span>
        <span class="bs-sr-f muted">${x.tips ? money(x.tips) : '<span class="bs-em">—</span>'}</span>
        <span class="bs-sr-e">${canWrite() ? (none ? 'Enter' : 'Edit') : ''}</span>
      </summary>
      <div class="bs-dayx">
        <div class="bs-daygrid">
          ${[['Kitchen', x.food], ['Coffee', x.coffee], ['Alcohol', x.alcohol], ['Other', x.other]]
            .map(([l, val]) => `<div><i>${l}</i><b>${split ? money(val) : '—'}</b></div>`).join('')}
          <div><i>Tips</i><b>${x.tips ? money(x.tips) : '—'}</b></div>
          <div><i>Hours</i><b>${x.hours ? (Math.round(x.hours * 10) / 10).toFixed(1) : '—'}</b></div>
          <div><i>Staff</i><b>${x.people || '—'}</b></div>
          <div><i>Status</i><b>${esc(st.label)}</b></div>
          <div><i>Drawer</i><b>${cs ? esc(cs.label) : '—'}</b></div>
        </div>
        <div class="bs-dayacts">
          ${canWrite() ? `<a class="bs-btn-sm" href="${openSale(x.id)}">${none ? 'Enter sales' : 'Edit sales'}</a>` : ''}
          ${navAllowed('/shifts') ? `<a class="bs-act" href="/shifts/${x.id}">Open the shift →</a>` : ''}
          ${cr ? `<a class="bs-act" href="/cash/${cr.id}">Drawer →</a>` : ''}
        </div>
      </div>
    </details>`;
  };

  const ledger = months.map((mo) => {
    const tot = mo.list.reduce((a, x) => a + x.sales, 0);
    const tips2 = mo.list.reduce((a, x) => a + x.tips, 0);
    const todo = mo.list.filter((x) => x.sales === 0 && !x.closed).length;
    return `<details class="bs-month" data-month>
      <summary class="bs-month-h">
        <span class="bs-kicker">${esc(MONTH_LBL(mo.ym))}</span>
        <span class="bs-month-meta">${mo.list.length} service${mo.list.length === 1 ? '' : 's'}
          ${todo ? `· <b class="warn">${todo} without sales</b>` : '· <b class="ok">all entered</b>'}</span>
        <span class="bs-month-tot"><b>${money(tot)}</b>${tips2 ? ` + ${money(tips2)} tips` : ''}</span>
        <span class="bs-act bs-month-go">open <span aria-hidden="true">▸</span></span>
      </summary>
      <div class="bs-shead bs-dayhead">
        <span>Date</span><span>Service</span>
        <span class="r">Sales</span><span class="r">Kitchen</span><span class="r">Coffee</span><span class="r">Tips</span><span></span>
      </div>
      <div class="bs-srows">${mo.list.map(ledgerRow).join('')}</div>
    </details>`;
  }).join('');

  // --- the filter sheet -----------------------------------------------------
  // One control and a sheet rather than eight pills and a date form. Built on
  // <details> so it works with no JavaScript at all: the sheet is a disclosure
  // and every option inside it is a link.
  const qs = (over) => {
    const o = { r: key, svc, from: r.from, to: r.to, ...over };
    const p = [`r=${o.r}`];
    if (o.svc) p.push(`svc=${o.svc}`);
    if (o.r === 'custom') p.push(`from=${o.from}`, `to=${o.to}`);
    return '/sales?' + p.join('&');
  };
  // Two months of history behind a thirty-day default is two months nobody
  // finds. The page said "26 services with sales" and gave no hint that 46
  // more existed before the window — so the backfill looked like it had only
  // half arrived.
  const span = db.prepare('SELECT MIN(date) a, MAX(date) b, COUNT(*) n FROM shifts').get();
  const outside = span.n
    ? db.prepare('SELECT COUNT(*) n FROM shifts WHERE date < ? OR date > ?').get(r.from, r.to).n
    : 0;
  const allFrom = span.a && span.a < r.from ? span.a : r.from;
  const allTo = span.b && span.b > r.to ? span.b : r.to;

  const ALL_RANGES = [...MX.RANGES, ['all', 'All time'], ['custom', 'Custom range']];
  const activeLabel = (ALL_RANGES.find(([k]) => k === key) || ['', r.label])[1];

  const filterSheet = `
    <details class="fsheet" id="salesfilter">
      <summary class="fs-btn">${esc(activeLabel)} <span class="fs-caret">▾</span></summary>
      <div class="fs-body">
        <div class="fs-scrim" aria-hidden="true"></div>
        <div class="fs-panel">
          <div class="fs-h">Period</div>
          <div class="fs-opts">
            ${ALL_RANGES.map(([k, label]) => `<a class="fs-o${key === k ? ' on' : ''}" href="${k === 'all' ? `/sales?r=custom&from=${allFrom}&to=${allTo}${svc ? `&svc=${svc}` : ''}` : qs({ r: k })}">${esc(label)}</a>`).join('')}
          </div>
          ${key === 'custom' ? `<form class="fs-dates" method="get" action="/sales">
            <input type="hidden" name="r" value="custom">${svc ? `<input type="hidden" name="svc" value="${svc}">` : ''}
            <label>From<input type="date" name="from" value="${esc(r.from)}"></label>
            <label>To<input type="date" name="to" value="${esc(r.to)}"></label>
            <button class="btn btn-sm btn-primary" type="submit">Apply</button>
          </form>` : ''}
          ${services.length > 1 ? `<div class="fs-h">Service</div>
          <div class="fs-opts">
            <a class="fs-o${svc ? '' : ' on'}" href="${qs({ svc: '' })}">All services</a>
            ${services.map((x) => `<a class="fs-o${svc === x.k ? ' on' : ''}" href="${qs({ svc: x.k })}">${esc(x.label)}</a>`).join('')}
          </div>` : ''}
          <div class="fs-h">Jump to a month</div>
          <form class="fs-jump" method="get" action="/sales">
            <input type="hidden" name="r" value="custom">${svc ? `<input type="hidden" name="svc" value="${svc}">` : ''}
            <input type="month" name="m" value="${esc(r.to.slice(0, 7))}" aria-label="Month">
            <button class="btn btn-sm" type="submit">Go</button>
          </form>
        </div>
      </div>
    </details>`;

  const ctxLine = `${esc(r.from)} – ${esc(r.to)}${svc ? ` · ${esc(dp(svc))}` : ''} · ${traded.length} service${traded.length === 1 ? '' : 's'} with sales`;
  const outsideLine = outside
    ? `<a class="sp-more" href="/sales?r=custom&from=${allFrom}&to=${allTo}${svc ? `&svc=${svc}` : ''}">
        ${outside} service${outside === 1 ? '' : 's'} outside this range — show everything from ${esc(whenOf(span.a))}</a>`
    : '';

  // --- the chart, with a day's detail on tap --------------------------------
  // A day with no service is a gap in the line, not a zero. `MX.days` marks
  // them; drawing them at the axis would report every closed Monday as a
  // catastrophic Monday.
  // Two kinds of day have nothing to plot, and neither of them is a zero: a
  // day the restaurant was shut, and a day whose service exists but whose
  // sales have not been entered yet. Drawing either at the axis reports a
  // closed Monday, or an unfinished Tuesday, as a catastrophe. The gap is
  // honest, and the "Needs sales entry" list says which days are which.
  const chartVals = series.map((d) => ({ x: dm(d), y: d.had && d.sales > 0 ? d.sales : null }));
  const dayJson = {};
  for (const d of series) {
    const p = perDay.get(d.date);
    dayJson[dm(d)] = p
      ? { d: d.date, s: p.sales, f: p.food, c: p.coffee, a: p.alcohol, o: p.other, t: p.tips }
      : null;
  }

  const statCell = (label, value, sub) =>
    `<div class="bs-strip-c"><span class="bs-strip-l">${label}</span><span class="bs-stat">${value}</span><span class="bs-strip-s">${sub}</span></div>`;

  // The page's name leads the headline, the way Shifts does it — "Sales — …",
  // not a bare verdict under an 11px kicker. A reader landing here should be
  // told which page they are on in the largest thing on it.
  const headline = sales
    ? `Sales — ${brief(sales)} rung${svc ? ` on ${esc(dp(svc))}` : ''}${prevSales ? `, ${
        sales >= prevSales ? 'up' : 'down'} ${Math.abs(((sales - prevSales) / prevSales) * 100).toFixed(1)}% on the period before.` : '.'}`
    : 'Sales — nothing rung in this period.';

  res.send(layout('Sales', `
    ${flash(req)}
    <div class="bs-page">
      <div class="bs-head">
        <div class="bs-headwrap">
          <h1 class="bs-headline">${headline}</h1>
          <p class="bs-subline">${esc(whenOf(r.from))} to ${esc(whenOf(r.to))}${svc ? ` · ${esc(dp(svc))}` : ''}.
            Where the money came from — what it cost is on
            <a class="bs-act" href="/costs">Performance</a>.</p>
        </div>
        <div class="sp-filters">${filterSheet}</div>
      </div>

      <section class="bs-panel bs-strip">
        ${statCell('Total sales', brief(sales), `${traded.length} service${traded.length === 1 ? '' : 's'} with figures`)}
        ${statCell('Average day', avgDaily === null ? '—' : brief(avgDaily), byDay.size ? `over ${byDay.size} day${byDay.size === 1 ? '' : 's'} traded` : 'nothing traded')}
        ${statCell('Per service', perService === null ? '—' : brief(perService), 'services with figures only')}
        ${statCell('Best day', best ? brief(best[1]) : '—', best ? esc(whenOf(best[0])) : 'nothing yet')}
        ${statCell('Tips', tips ? brief(tips) : '—', tips ? 'collected in the period' : 'none reported')}
      </section>

      ${outsideLine}

      <div class="bs-cols2">
        <section class="bs-panel">
          <div class="bs-sec-h"><span class="bs-kicker">Sales, day by day</span>
            <span class="bs-sec-note">${svc ? esc(dp(svc)) : 'whole restaurant'}</span></div>
          <div class="bs-chart">${CH.lineChart([{ label: 'Sales', values: chartVals, area: true }],
            { height: 240, empty: 'No days with sales in this period.' })}</div>
          <div class="sp-point" id="sp-point" hidden></div>
        </section>
        <section class="bs-panel">
          <div class="bs-sec-h"><span class="bs-kicker">Where it came from</span>
            <span class="bs-sec-note">${mixTotal ? money(mixTotal) + ' split' : 'not split'}</span></div>
          ${mixRows.length ? `<div class="bs-share">${mixRows.map((x) => {
            const pct = (x.value / mixTotal) * 100;
            return `<div class="bs-share-r">
              <span class="bs-share-n">${esc(x.label)}</span>
              <b class="bs-fig">${money(x.value)}</b>
              <i class="bs-share-p">${pct.toFixed(0)}%</i>
              <span class="bs-share-t"><span style="width:${pct.toFixed(1)}%"></span></span>
            </div>`;
          }).join('')}</div>` : '<p class="bs-clear">No category totals entered for this period.</p>'}
          ${m.unsplit ? `<p class="bs-note">${money(m.unsplit)} came from services entered before
            category totals existed, so it cannot be split.</p>` : ''}

          ${services.length > 1 ? `
            </section>
            <section class="bs-panel">
            <div class="bs-sec-h"><span class="bs-kicker">By service</span></div>
            <div class="bs-share">${services.map((x) => {
              const t = services.reduce((a, y) => a + y.sales, 0) || 1;
              const pct = (x.sales / t) * 100;
              return `<div class="bs-share-r"><span class="bs-share-n">${esc(x.label)}</span>
                <b class="bs-fig">${money(x.sales)}</b><i class="bs-share-p">${pct.toFixed(0)}%</i>
                <span class="bs-share-t"><span style="width:${pct.toFixed(1)}%"></span></span></div>`;
            }).join('')}</div>` : ''}

          ${hi.length ? `
            </section>
            <section class="bs-panel">
            <div class="bs-sec-h"><span class="bs-kicker">Worth noting</span></div>
            <ul class="bs-hilite">${hi.map((h) => `<li>${h}</li>`).join('')}</ul>` : ''}
        </section>
      </div>

      ${awaiting.length ? `
        <section class="bs-panel bs-panel-warn">
        <div class="bs-sec-h warn"><span class="bs-kicker">Needs sales entry</span>
          <span class="bs-sec-note">${awaiting.length}</span></div>
        <div class="bs-items">
          ${awaiting.slice(0, 6).map((x) => `<a class="bs-item" href="${openSale(x.id)}">
            <span class="bs-item-k amber">${esc(whenOf(x.date, x.daypart).toUpperCase())}</span>
            <span class="bs-item-t">${x.tips ? 'Tips were submitted, no sales entered' : 'Logged with no sales'}</span>
            <span class="bs-item-s">${x.people ? `${x.people} on · ${Math.round(x.hours)} hrs` : 'nobody on it'}<span class="bs-sep"> · </span><span class="bs-act">Enter →</span></span>
          </a>`).join('')}
        </div>
        ${awaiting.length > 6 ? `<p class="bs-note">${awaiting.length - 6} more in this period, marked in the ledger below.</p>` : ''}
        </section>` : ''}

      ${serverOnlyCount ? `<p class="bs-note bs-note-wide"><b>${serverOnlyCount} service${serverOnlyCount === 1 ? '' : 's'} show what servers rang, not a POS total.</b>
        Counter and to-go revenue is not in those figures, so they are a floor. Open any day below and the real
        total replaces the estimate everywhere.</p>` : ''}

      <section class="bs-panel">
        <div class="bs-sec-h"><span class="bs-kicker">The ledger</span>
          <span class="bs-sec-note">${rows.length} service${rows.length === 1 ? '' : 's'}</span></div>
        ${ledger || '<p class="bs-clear">No services in this range. Pick a different period, or log a shift.</p>'}
      </section>

      <details class="bs-pos">
        <summary>With a POS connected<i>8 more measures</i></summary>
        <div class="bs-future">
          ${['Average check', 'Transactions', 'Items sold', 'Peak hours', 'Hourly sales', 'Payment methods', 'Discounts', 'Voids']
            .map((f) => `<span>${esc(f)}</span>`).join('')}
        </div>
        <p class="bs-note">These need per-transaction data. Nothing here is estimated in the meantime.</p>
      </details>
    </div>
    <script>window.SP_DAYS = ${JSON.stringify(dayJson)};</script>
    <script>${salesScript()}</script>`));
});

/**
 * Land back on the row you just saved, centred and marked.
 *
 * Saving redirects to `#<prefix><id>`, and the row is usually inside a month
 * that is shut — which the browser cannot scroll to at all. So: open every
 * <details> above it, then place it.
 *
 * `prefix` is matched as a plain string and the rest checked for digits, in
 * place of emitting a regex. A pattern written into a template literal has to
 * have its backslashes doubled, and `/^#s\d+$/` has already gone out as
 * `/^#sd+$/` three times in this file.
 *
 * `openSelf` opens the target too. The sales ledger wants that — the row is
 * the day and its detail is the figures you just entered. The staff sheet does
 * not: the target there is the edit form, and re-opening it after a save shows
 * you the form again instead of the result.
 */
function returnToRowScript(prefix, openSelf) {
  return `
  (function(){
    var h = location.hash ? location.hash.slice(1) : '';
    var p = ${JSON.stringify(prefix)};
    if (h.slice(0, p.length) !== p) return;
    var rest = h.slice(p.length);
    if (!rest || /[^0-9]/.test(rest)) return;
    var row = document.getElementById(h);
    if (!row) return;

    // Stop the browser putting back the scroll position it remembers for this
    // URL after we have already placed the row.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

    var el = ${openSelf ? 'row' : 'row.parentElement'};
    while(el){ if(el.tagName === 'DETAILS') el.open = true; el = el.parentElement; }

    // Centre the row LINE, not the whole open block. scrollIntoView centres an
    // element's box, and that box is a <details> — so its middle sits somewhere
    // down in the detail and the line you were actually looking at ends up well
    // above the fold. That is why coming back from a save still meant scrolling
    // up to find your place.
    var line = row.querySelector('summary') || row;
    var moved = false;
    ['wheel','touchstart','keydown'].forEach(function(ev){
      window.addEventListener(ev, function(){ moved = true; }, { passive: true, once: true });
    });
    function centre(){
      if(moved) return;
      var r = line.getBoundingClientRect();
      window.scrollTo(0, Math.max(0, r.top + window.pageYOffset - (window.innerHeight - r.height) / 2));
    }
    centre();
    // Again once the layout has settled. The first pass runs before the
    // self-hosted fonts have swapped in, and the reflow that follows shifts
    // every row above this one — landing you a little under where you were.
    requestAnimationFrame(centre);
    window.addEventListener('load', centre);

    row.classList.add('bs-justsaved');
    setTimeout(function(){ row.classList.remove('bs-justsaved'); }, 2200);
  })();`;
}

function salesScript() {
  return `
  ${returnToRowScript('s', true)}

  (function(){
    var box=document.getElementById('sp-point');
    if(!box || !window.SP_DAYS) return;
    var money=function(c){ return '$'+(Math.round(c)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    function show(key){
      var d=SP_DAYS[key];
      if(!d){ box.hidden=true; return; }
      var when=new Date(d.d+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
      var parts=[['Food',d.f],['Coffee',d.c],['Alcohol',d.a],['Other',d.o],['Tips',d.t]]
        .filter(function(p){ return p[1]; })
        .map(function(p){ return '<span><i>'+p[0]+'</i><b>'+money(p[1])+'</b></span>'; }).join('');
      box.innerHTML='<div class="spp-h"><b>'+when+'</b><span>'+money(d.s)+'</span></div>'
        + (parts ? '<div class="spp-g">'+parts+'</div>' : '<div class="spp-n">Not split by category.</div>');
      box.hidden=false;
    }
    // The chart's hit targets already exist for the tooltip; this reuses them
    // rather than adding a second set of listeners over the same pixels.
    var svg=document.querySelector('.sp-chart .chart-svg');
    if(!svg) return;
    var hits=svg.querySelectorAll('.ch-hit');
    var ticks=[].map.call(svg.querySelectorAll('.ch-tick'), function(t){ return t.textContent; });
    hits.forEach(function(g,i){
      var t=g.querySelector('title');
      var key=t ? (t.textContent.split(' — ')[0]) : ticks[i];
      var pick=function(){ show(key); hits.forEach(function(o){ o.classList.remove('on'); }); g.classList.add('on'); };
      g.addEventListener('click', pick);
      g.addEventListener('mouseenter', pick);
    });
  })();`;
}

/**
 * Entering what the POS rang for one service.
 *
 * The range you were looking at travels with you. Saving used to drop you back
 * on /sales with the default thirty days, so anyone working through May had to
 * re-pick "all time" and scroll back down after every single day. The filter
 * rides in hidden fields and comes back in the redirect, with an anchor on the
 * row you just saved so the browser returns you to it.
 */
function salesReturn(q) {
  const p = [];
  if (q.r) p.push(`r=${encodeURIComponent(q.r)}`);
  if (q.from) p.push(`from=${encodeURIComponent(q.from)}`);
  if (q.to) p.push(`to=${encodeURIComponent(q.to)}`);
  if (q.svc) p.push(`svc=${encodeURIComponent(q.svc)}`);
  return p;
}

app.get('/sales/:id', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).send(layout('Not found',
    '<div class="bs-page"><h1 class="bs-headline">No such service</h1><p class="bs-clear"><a href="/sales">← Sales</a></p></div>'));
  const inp = shiftInputs(sh.id);
  const rung = inp.servers.reduce((a, p) => a + toCents(p.food) + toCents(p.coffee) + toCents(p.alcohol), 0);
  const v = (c) => (c ? (c / 100).toFixed(2) : '');
  const back = salesReturn(req.query);
  const backTo = `/sales${back.length ? '?' + back.join('&') : ''}`;

  const entered = sh.total_food_cents + sh.total_coffee_cents + sh.total_alcohol_cents + sh.total_other_cents;
  const field = (name, label, val, hint) => `
    <label class="bs-field">
      <span class="bs-field-l">${label}</span>
      <span class="bs-field-w"><i>$</i><input name="${name}" type="text" inputmode="decimal"
        value="${val}" placeholder="0.00" autocomplete="off"></span>
      ${hint ? `<span class="bs-field-h">${hint}</span>` : ''}
    </label>`;

  res.send(layout(`Sales · ${sh.date}`, `
    ${flash(req)}
    <div class="bs-page bs-narrow">
      <a class="bs-back" href="${backTo}">← Sales</a>
      <div class="bs-head">
        <div class="bs-headwrap">
          <p class="bs-greet">${esc(dp(sh.daypart))}<span class="bs-greet-d">${esc(whenOf(sh.date))}</span></p>
          <h1 class="bs-headline">${entered ? 'What the POS rang' : 'Enter what the POS rang'}</h1>
        </div>
      </div>
      <p class="bs-lede">Net sales for the whole service — before tips, excluding tax.
        ${rung ? `Servers accounted for <b>${money(rung)}</b> of it; the rest is counter, to-go and anything without a server.`
        : 'No server sales are recorded against this one.'}</p>

      <form method="post" action="/sales/${sh.id}" class="bs-entry">
        ${back.map((kv) => { const [k, val] = kv.split('='); return `<input type="hidden" name="${k}" value="${esc(decodeURIComponent(val))}">`; }).join('')}
        <div class="bs-fields">
          ${field('food', 'Kitchen', v(sh.total_food_cents))}
          ${field('coffee', 'Coffee', v(sh.total_coffee_cents))}
          ${field('alcohol', 'Alcohol', v(sh.total_alcohol_cents))}
          ${field('other', 'Other', v(sh.total_other_cents))}
        </div>
        <label class="bs-field bs-field-wide">
          <span class="bs-field-l">Note</span>
          <span class="bs-field-w"><input name="note" value="${esc(sh.sales_note || '')}"
            placeholder="optional — the POS was down for an hour, say"></span>
        </label>
        <div class="bs-entry-act">
          <button class="bs-btn" type="submit">Save sales</button>
          <a class="bs-act" href="${backTo}">Cancel</a>
          ${navAllowed('/shifts') ? `<a class="bs-act bs-entry-alt" href="/shifts/${sh.id}">Open the shift →</a>` : ''}
        </div>
      </form>

      <p class="bs-note">Leave a category at zero if you do not sell it. These figures replace the
        server-sales estimate everywhere they appear.</p>

      <!-- The alternative to typing zeros. A day staff worked but the room
           never opened is not a $0 day: entering zeros makes it one, and it
           then drags the averages and sits in "needs sales entry" forever. -->
      <section class="bs-pos-block">
        <div class="bs-sec-h bs-sec-gap"><span class="bs-kicker">Or: nobody was served</span></div>
        ${sh.closed_at ? `
          <p class="bs-note"><b>Marked as closed.</b> ${esc(String(sh.closed_at).slice(0, 16))} —
            staff hours and wages still count, and this service is not waiting on sales.</p>
          <form method="post" action="/sales/${sh.id}/open" class="bs-entry-act">
            ${back.map((kv) => { const [k, val] = kv.split('='); return `<input type="hidden" name="${k}" value="${esc(decodeURIComponent(val))}">`; }).join('')}
            <button class="bs-btn-sm" type="submit">We were open after all</button>
          </form>`
        : `
          <p class="bs-note">Use this when the restaurant did not open but people still came in —
            a deep clean, a private booking that fell through, a holiday with prep. Their hours and
            wages are unchanged; this service just stops asking for sales, and stays out of the
            averages instead of counting as a zero.</p>
          <form method="post" action="/sales/${sh.id}/closed" class="bs-entry-act">
            ${back.map((kv) => { const [k, val] = kv.split('='); return `<input type="hidden" name="${k}" value="${esc(decodeURIComponent(val))}">`; }).join('')}
            <button class="bs-btn-sm" type="submit">Restaurant was closed</button>
          </form>`}
      </section>
    </div>`));
});

/** Mark a service closed — staff worked, the room never opened. */
app.post('/sales/:id/closed', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  db.prepare("UPDATE shifts SET closed_at = datetime('now') WHERE id = ?").run(sh.id);
  const back = salesReturn(req.body);
  res.redirect(`/sales?${back.join('&')}#s${sh.id}`);
});

app.post('/sales/:id/open', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  db.prepare('UPDATE shifts SET closed_at = NULL WHERE id = ?').run(sh.id);
  const back = salesReturn(req.body);
  res.redirect(`/sales?${back.join('&')}#s${sh.id}`);
});

app.post('/sales/:id', (req, res) => {
  const sh = s.shiftById.get(req.params.id);
  if (!sh) return res.status(404).end();
  s.setTotalSales.run({
    id: sh.id, food: toCents(req.body.food), coffee: toCents(req.body.coffee),
    alcohol: toCents(req.body.alcohol), other: toCents(req.body.other),
    note: (req.body.note || '').trim() || null,
  });
  // Back to the range you were in, at the row you just saved.
  const back = salesReturn(req.body);
  back.push('msg=' + encodeURIComponent(`Saved — ${whenOf(sh.date, sh.daypart)}.`));
  res.redirect(`/sales?${back.join('&')}#s${sh.id}`);
});

// ---------------------------------------------------------------------------
// POSITIONS — the jobs someone can work. `kind` is what decides how their tips
// are handled, so it's the one field that has real consequences.
// ---------------------------------------------------------------------------
const KINDS = {
  server: { label: 'Server', help: 'Keeps their own tips and tips out to everyone else.' },
  support: { label: 'Support', help: 'Shares the tip-out pots and the shared pool, split by hours.' },
  non_tipped: { label: 'Not tipped', help: 'Hourly only — in no pool at all. Use for training.' },
};
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

app.get('/positions', (req, res) => {
  const rows = positions.all.all().map((p) => {
    const used = positions.inUse.get(p.slug).n;
    return `<tr${p.active ? '' : ' class="row-muted"'}>
      <td>${esc(p.name)}${p.active ? '' : ' <span class="pill">inactive</span>'}</td>
      <td><span class="pill ${p.kind === 'non_tipped' ? 'pill-amber' : 'pill-blue'}">${KINDS[p.kind] ? KINDS[p.kind].label : p.kind}</span></td>
      <td class="sub">${esc(KINDS[p.kind] ? KINDS[p.kind].help : '')}</td>
      <td class="num">${used}</td>
      <td class="row-actions">
        <a href="/positions/${p.id}/edit">edit</a>
        <form method="post" action="/positions/${p.id}/active" style="margin:0">
          <input type="hidden" name="active" value="${p.active ? 0 : 1}">
          <button class="link${p.active ? '-danger' : ''}">${p.active ? 'retire' : 'restore'}</button>
        </form>
      </td></tr>`;
  }).join('');

  res.send(layout('Positions', `
    ${flash(req)}
    <div class="page-head"><div><h1>Positions</h1><p class="sub">The jobs someone can be put on a shift as.</p></div>
      <a class="btn btn-primary" href="#add" onclick="document.getElementById('add-panel').open=true">＋ Add position</a></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Position</th><th>Tips</th><th>What that means</th><th class="num">Shifts used</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted">Retiring a position keeps past shifts intact — it just stops appearing when you add someone new.</p>
    <details class="add-panel" id="add-panel">
      <summary id="add">＋ Add a position</summary>
      <form method="post" action="/positions" class="card form grid">
        <label>Name <input name="name" required placeholder="e.g. Training"></label>
        <label>Tip handling <select name="kind">
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === 'support' ? ' selected' : ''}>${v.label} — ${v.help}</option>`).join('')}
        </select></label>
        <button class="btn btn-primary" type="submit">Add position</button>
      </form>
    </details>`));
});

app.post('/positions', (req, res) => {
  const name = String(req.body.name || '').trim();
  const kind = KINDS[req.body.kind] ? req.body.kind : 'support';
  if (!name) return res.redirect('/positions?err=1&msg=' + encodeURIComponent('Give the position a name.'));
  const slug = slugify(name);
  if (!slug) return res.redirect('/positions?err=1&msg=' + encodeURIComponent('That name has no letters or numbers in it.'));
  if (positions.bySlug.get(slug)) {
    return res.redirect('/positions?err=1&msg=' + encodeURIComponent(`There's already a position called "${name}".`));
  }
  const sort = (positions.all.all().reduce((a, p) => Math.max(a, p.sort), 0) || 0) + 10;
  positions.add.run({ slug, name, kind, sort });
  res.redirect('/positions?msg=' + encodeURIComponent(`${name} added — you can now put someone on a shift as ${name}.`));
});

app.get('/positions/:id/edit', (req, res) => {
  const p = positions.byId.get(Number(req.params.id));
  if (!p) return res.status(404).send(layout('Not found', '<h1>Position not found</h1>'));
  const used = positions.inUse.get(p.slug).n;
  res.send(layout(`Edit ${p.name}`, `
    ${flash(req)}
    <a class="back" href="/positions">← Positions</a>
    <h1>Edit ${esc(p.name)}</h1>
    ${used ? `<div class="flash flash-warn"><div>Used on <b>${used}</b> shift${used === 1 ? '' : 's'}. Changing how tips are handled affects how those shifts calculate from now on — past emails already sent aren't changed.</div></div>` : ''}
    <form method="post" action="/positions/${p.id}" class="card form grid">
      <label>Name <input name="name" value="${esc(p.name)}" required></label>
      <label>Tip handling <select name="kind">
        ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${v.label} — ${v.help}</option>`).join('')}
      </select></label>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>`));
});

app.post('/positions/:id', (req, res) => {
  const p = positions.byId.get(Number(req.params.id));
  if (!p) return res.status(404).end();
  const name = String(req.body.name || '').trim() || p.name;
  const kind = KINDS[req.body.kind] ? req.body.kind : p.kind;
  positions.update.run({ id: p.id, name, kind, sort: p.sort });
  res.redirect('/positions?msg=' + encodeURIComponent(`${name} updated.`));
});

app.post('/positions/:id/active', (req, res) => {
  const p = positions.byId.get(Number(req.params.id));
  if (!p) return res.status(404).end();
  positions.setActive.run(req.body.active === '1' ? 1 : 0, p.id);
  res.redirect('/positions?msg=' + encodeURIComponent(`${p.name} ${req.body.active === '1' ? 'restored' : 'retired'}.`));
});


// ---------------------------------------------------------------------------
// USERS — logins for owners, partners and anyone else who needs the back
// office. Only accounts with Settings access can reach this page.
// ---------------------------------------------------------------------------
const ROLE_LABEL = { editor: 'Editor', viewer: 'View only' };

app.get('/users', (req, res) => {
  const rows = users.all.all();
  const me = req.user || {};

  const cards = rows.map((u) => {
    const feats = u.features ? u.features.split(',').filter(Boolean) : [];
    const seeing = feats.length
      ? feats.map((k) => (FEATURES.find((f) => f.key === k) || {}).label).filter(Boolean).join(', ')
      : 'Everything';
    return `
    <article class="ucard${u.active ? '' : ' ucard-off'}">
      <div class="ucard-top">
        <div class="uavatar">${esc(u.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</div>
        <div class="ucard-head">
          <div class="ucard-name">${esc(u.name)}${u.active ? '' : ' <span class="pill">disabled</span>'}</div>
          <div class="ucard-email">${esc(u.email)}</div>
        </div>
        <span class="urole ur-${u.role}">${ROLE_LABEL[u.role] || u.role}</span>
      </div>
      <div class="ucard-facts">
        <div class="tfact"><span>Can open</span><b>${esc(seeing)}</b></div>
        <div class="tfact"><span>Last signed in</span><b>${u.last_seen ? esc(String(u.last_seen).slice(0, 10)) : '<i class="unset">Never</i>'}</b></div>
      </div>
      <div class="ucard-act">
        <a class="btn btn-sm" href="/users/${u.id}/edit">Edit</a>
        <form method="post" action="/users/${u.id}/active" style="margin:0">
          <input type="hidden" name="active" value="${u.active ? 0 : 1}">
          <button class="btn btn-sm ${u.active ? 'btn-ghost' : 'btn-primary'}" type="submit">${u.active ? 'Disable' : 'Re-enable'}</button>
        </form>
      </div>
    </article>`;
  }).join('');

  res.send(layout('Users', `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t"><h1>Users</h1>
        <p class="phead-s">Logins for owners and partners. Staff logging tips don't need one.</p></div>
      ${canWrite() ? `<button class="btn btn-primary" type="button" onclick="rcDrawer(true)">＋ New user</button>` : ''}
    </div>

    <div class="flash flash-info"><div>
      You're signed in ${me.master ? 'with the <b>owner password</b>, which always has full access' : `as <b>${esc(me.name || '')}</b>`}.
      Disabling someone takes effect on their next click, not whenever their session expires.
    </div></div>

    ${rows.length ? `<div class="ugrid">${cards}</div>` : `
      <div class="empty2">
        <div class="empty2-t">No user accounts yet</div>
        <div class="empty2-s">Create one for each owner or partner. They sign in with their own email, so you can disable one without changing anything for everyone else.</div>
        ${canWrite() ? `<button class="btn btn-primary" type="button" onclick="rcDrawer(true)">＋ New user</button>` : ''}
      </div>`}

    <div class="drawer-scrim" onclick="rcDrawer(false)"></div>
    <aside class="drawer" id="rc-drawer" aria-label="New user">
      <div class="drawer-h">
        <div><div class="drawer-t">New user</div><div class="drawer-s">They sign in with this email and password.</div></div>
        <button class="drawer-x" type="button" onclick="rcDrawer(false)" aria-label="Close">✕</button>
      </div>
      <form method="post" action="/users" class="drawer-b">
        <label class="fld">Name <input name="name" required placeholder="e.g. Dana Reyes"></label>
        <label class="fld">Email <input name="email" type="email" required placeholder="dana@example.com"></label>
        <label class="fld">Starting password
          <input name="password" required minlength="8" placeholder="At least 8 characters">
          <span class="fldhint">Tell them this directly — they can't reset it themselves yet.</span>
        </label>
        <label class="fld">Access
          <select name="role">
            <option value="viewer" selected>View only — sees everything, changes nothing</option>
            <option value="editor">Editor — can add and change</option>
          </select>
        </label>
        <div class="fld">What they can open
          <div class="fgrid">
            ${FEATURES.map((f) => `<label class="fcheck"><input type="checkbox" name="features" value="${f.key}" checked><span>${f.label}</span></label>`).join('')}
          </div>
          <span class="fldhint">Untick anything they shouldn't see. Payroll and Staff include wages and personal details.</span>
        </div>
        <div class="drawer-f">
          <button class="btn btn-ghost" type="button" onclick="rcDrawer(false)">Cancel</button>
          <button class="btn btn-primary" type="submit">Create user</button>
        </div>
      </form>
    </aside>
    <script>
      function rcDrawer(open) {
        document.body.classList.toggle('drawer-open', !!open);
        if (open) setTimeout(function () { var f = document.querySelector('#rc-drawer input[name=name]'); if (f) f.focus(); }, 180);
      }
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') rcDrawer(false); });
    </script>`));
});

const featureList = (body) => {
  const raw = body.features;
  const picked = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((k) => FEATURES.some((f) => f.key === k));
  // All ticked is stored as "everything", so a feature added later is included
  // rather than silently hidden from people who already had full access.
  return picked.length === FEATURES.length ? '' : picked.join(',');
};

app.post('/users', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const back = (msg) => res.redirect('/users?err=1&msg=' + encodeURIComponent(msg));
  if (!name || !email) return back('Name and email are both needed.');
  if (password.length < 8) return back('Give them a starting password of at least 8 characters.');
  if (users.byEmail.get(email)) return back(`${email} already has an account.`);
  users.add.run({
    name, email, pass_hash: hashPassword(password),
    role: req.body.role === 'editor' ? 'editor' : 'viewer',
    features: featureList(req.body),
  });
  res.redirect('/users?msg=' + encodeURIComponent(`${name} can now sign in with ${email}.`));
});

app.get('/users/:id/edit', (req, res) => {
  const u = users.byId.get(Number(req.params.id));
  if (!u) return res.status(404).send(layout('Not found', '<h1>User not found</h1>'));
  const has = u.features ? u.features.split(',').filter(Boolean) : [];
  const on = (k) => (!has.length || has.includes(k) ? ' checked' : '');
  res.send(layout(`Edit ${u.name}`, `
    ${flash(req)}
    <a class="back" href="/users">← Users</a>
    <h1>${esc(u.name)}</h1>
    <p class="sub">${esc(u.email)} · ${ROLE_LABEL[u.role] || u.role}${u.active ? '' : ' · disabled'}</p>

    <form method="post" action="/users/${u.id}" class="card form grid">
      <label>Name <input name="name" value="${esc(u.name)}" required></label>
      <label>Email <input name="email" type="email" value="${esc(u.email)}" required></label>
      <label>Access <select name="role">
        <option value="viewer"${u.role === 'viewer' ? ' selected' : ''}>View only — sees everything, changes nothing</option>
        <option value="editor"${u.role === 'editor' ? ' selected' : ''}>Editor — can add and change</option>
      </select></label>
      <div class="wide">What they can open
        <div class="fgrid">
          ${FEATURES.map((f) => `<label class="fcheck"><input type="checkbox" name="features" value="${f.key}"${on(f.key)}><span>${f.label}</span></label>`).join('')}
        </div>
      </div>
      <button class="btn btn-primary" type="submit">Save changes</button>
    </form>

    <h2>Set a new password</h2>
    <form method="post" action="/users/${u.id}/password" class="card form grid">
      <label>New password <input name="password" required minlength="8" placeholder="At least 8 characters"></label>
      <button class="btn" type="submit">Change password</button>
    </form>

    <div class="danger-zone">
      <div><b>Delete this account</b><p class="muted">Removes the login entirely. Disabling is usually better — it keeps the record of who had access.</p></div>
      <form method="post" action="/users/${u.id}/delete" style="margin:0"
            onsubmit="return confirm('Delete ${esc(u.name)}\\'s account? Disabling keeps the record instead.')">
        <button class="btn btn-danger" type="submit">Delete</button>
      </form>
    </div>`));
});

app.post('/users/:id', (req, res) => {
  const u = users.byId.get(Number(req.params.id));
  if (!u) return res.status(404).end();
  const email = String(req.body.email || '').trim();
  const clash = users.byEmail.get(email);
  if (clash && clash.id !== u.id) {
    return res.redirect(`/users/${u.id}/edit?err=1&msg=` + encodeURIComponent(`${email} is already used by ${clash.name}.`));
  }
  users.update.run({
    id: u.id, name: String(req.body.name || '').trim() || u.name, email: email || u.email,
    role: req.body.role === 'editor' ? 'editor' : 'viewer',
    features: featureList(req.body),
  });
  res.redirect('/users?msg=' + encodeURIComponent(`${req.body.name || u.name} updated.`));
});

app.post('/users/:id/password', (req, res) => {
  const u = users.byId.get(Number(req.params.id));
  if (!u) return res.status(404).end();
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.redirect(`/users/${u.id}/edit?err=1&msg=` + encodeURIComponent('Use at least 8 characters.'));
  users.setPass.run(hashPassword(pw), u.id);
  res.redirect('/users?msg=' + encodeURIComponent(`${u.name}'s password changed — tell them the new one.`));
});

app.post('/users/:id/active', (req, res) => {
  const u = users.byId.get(Number(req.params.id));
  if (!u) return res.status(404).end();
  const on = req.body.active === '1';
  users.setActive.run(on ? 1 : 0, u.id);
  res.redirect('/users?msg=' + encodeURIComponent(`${u.name} ${on ? 're-enabled' : 'disabled — they lose access on their next click'}.`));
});

app.post('/users/:id/delete', (req, res) => {
  const u = users.byId.get(Number(req.params.id));
  if (!u) return res.status(404).end();
  users.del.run(u.id);
  res.redirect('/users?msg=' + encodeURIComponent(`${u.name}'s account deleted.`));
});

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
      alcohol_cents: toCents(row.alcohol),
    });
    // Card tips are written separately now — upsertSales no longer owns them,
    // so a blank field cannot zero a figure somebody already reported.
    if (row.card_tips != null && String(row.card_tips).trim() !== '') {
      w.setCardTips.run({ shift_id: sh.id, employee_id: emp.id, card_tips_cents: toCents(row.card_tips) });
    }
    if (row.cash_tips != null) {
      w.setCashTips.run({ shift_id: sh.id, employee_id: emp.id, cash_tips_cents: toCents(row.cash_tips), by: 'pos' });
    }
    matched.push(emp.name);
  }
  res.json({ ok: true, shift_id: sh.id, matched, unmatched });
});

// Mount all the collection modules (expirations, invoices, vendors, contacts,
// equipment, incident log, notes/decisions log).

// ---------------------------------------------------------------------------
// RECURRING TASKS
// Category drives colour, status drives urgency, and the two are kept apart on
// purpose: category tells you what kind of job it is, status tells you whether
// you're late. Mixing them into one colour would lose both signals.
// ---------------------------------------------------------------------------
const FREQ = ['Weekly', 'Monthly', 'Quarterly', 'Annual'];
const CATEGORIES = {
  'Cleaning':     { color: '#2563eb', tint: '#eff6ff', icon: 'cleaning' },
  'Maintenance':  { color: '#ea580c', tint: '#fff7ed', icon: 'equipment' },
  'Safety':       { color: '#dc2626', tint: '#fef2f2', icon: 'incidents' },
  'Pest Control': { color: '#059669', tint: '#ecfdf5', icon: 'pest' },
  'Compliance':   { color: '#7c3aed', tint: '#f5f3ff', icon: 'policy' },
  'Other':        { color: '#64748b', tint: '#f8fafc', icon: 'recurring' },
};
const catOf = (name) => CATEGORIES[name] || CATEGORIES.Other;

function advanceDate(iso, frequency) {
  const d = new Date(iso + 'T00:00:00');
  const f = String(frequency || '').toLowerCase();
  if (f.includes('week')) d.setDate(d.getDate() + 7);
  else if (f.includes('quarter')) d.setMonth(d.getMonth() + 3);
  else if (f.includes('annual') || f.includes('year')) d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return isoDate(d);
}
const daysTo = (iso) => (iso ? Math.round((new Date(iso + 'T00:00:00') - startOfToday()) / 86400000) : null);

/** Red overdue → amber due-soon → blue scheduled, plus green when just done. */
function statusOf(row) {
  const today = isoDate(startOfToday());
  if (row.last_done === today) return { key: 'done', label: 'Complete', cls: 's-done' };
  const d = daysTo(row.next_due);
  if (d === null) return { key: 'none', label: 'No date', cls: 's-none' };
  if (d < 0) return { key: 'over', label: d === -1 ? '1 day late' : `${-d} days late`, cls: 's-over' };
  if (d === 0) return { key: 'soon', label: 'Due today', cls: 's-soon' };
  if (d <= 7) return { key: 'soon', label: d === 1 ? 'Due tomorrow' : `Due in ${d} days`, cls: 's-soon' };
  return { key: 'sched', label: `In ${d} days`, cls: 's-sched' };
}

const niceDate = (iso) => (iso
  ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  : '—');

const recurQ = {
  all: db.prepare('SELECT * FROM m_recurring ORDER BY next_due IS NULL, next_due, name'),
  one: db.prepare('SELECT * FROM m_recurring WHERE id = ?'),
  setDates: db.prepare('UPDATE m_recurring SET last_done = @last_done, next_due = @next_due WHERE id = @id'),
};

app.get('/c/recurring', (req, res) => {
  const rows = recurQ.all.all();
  const view = req.query.view === 'calendar' ? 'calendar' : 'board';
  const today = isoDate(startOfToday());
  const st = rows.map((r) => ({ r, s: statusOf(r) }));

  const overdue = st.filter((x) => x.s.key === 'over');
  const week = st.filter((x) => x.s.key === 'soon');
  const doneMonth = rows.filter((r) => r.last_done && r.last_done.slice(0, 7) === today.slice(0, 7));
  const nextUp = st.find((x) => x.s.key === 'soon' || x.s.key === 'sched');

  // --- summary cards: tinted, iconned, one number each --------------------
  const card = (tone, ico, label, value, sub) => `
    <div class="mcard mcard-${tone}">
      <div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body">
        <div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div>
        <div class="mcard-sub">${sub}</div>
      </div>
    </div>`;
  const cards = `<div class="mcards">
    ${card('red', 'incidents', 'Overdue', String(overdue.length),
      overdue.length ? esc(overdue[0].r.name) + (overdue.length > 1 ? ` +${overdue.length - 1} more` : '') : 'Nothing late')}
    ${card('amber', 'expirations', 'Due this week', String(week.length),
      week.length ? esc(week[0].r.name) + (week.length > 1 ? ` +${week.length - 1} more` : '') : 'Clear this week')}
    ${card('blue', 'recurring', 'Active tasks', String(rows.length), `${new Set(rows.map((r) => r.category || 'Other')).size} categories`)}
    ${card('green', 'policy', 'Done this month', String(doneMonth.length),
      nextUp ? `Next: ${esc(nextUp.r.name)}` : 'Nothing scheduled')}
  </div>`;

  // --- filter bar ---------------------------------------------------------
  const used = [...new Set(rows.map((r) => r.category || 'Other'))];
  const chips = used.map((c) => {
    const cc = catOf(c);
    return `<button class="fchip" data-cat="${esc(c)}" style="--c:${cc.color};--ct:${cc.tint}">
      <i class="fdot"></i>${esc(c)}<span class="fcount">${rows.filter((r) => (r.category || 'Other') === c).length}</span></button>`;
  }).join('');

  const toolbar = `<div class="toolbar2">
    <div class="searchbox">
      ${icon('search')}
      <input id="tsearch" type="search" placeholder="Search tasks, people, categories…" autocomplete="off">
    </div>
    <div class="fchips">
      <button class="fchip on" data-cat="" style="--c:var(--ink-2);--ct:var(--surface-3)">All<span class="fcount">${rows.length}</span></button>
      ${chips}
    </div>
    <div class="seg-view">
      <a class="${view === 'board' ? 'on' : ''}" href="/c/recurring">${icon('list')} List</a>
      <a class="${view === 'calendar' ? 'on' : ''}" href="/c/recurring?view=calendar">${icon('calendar')} Calendar</a>
    </div>
  </div>`;

  const main = view === 'calendar' ? recurCalendar(rows, req.query.m || today.slice(0, 7), today) : recurBoard(st);

  res.send(layout('Recurring tasks', `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t">
        <h1>Recurring tasks</h1>
        <p class="phead-s">Everything that has to happen again — and how close it is.</p>
      </div>
      ${canWrite() ? `<button class="btn btn-primary" type="button" onclick="rcDrawer(true)">＋ New recurring task</button>` : ''}
    </div>
    ${cards}
    ${toolbar}
    ${main}
    ${canWrite() ? recurDrawer(today) : ''}
    <script>
      // Live filter: search text + category chip, both narrowing the same set.
      (function () {
        var q = '', cat = '';
        function apply() {
          var shown = 0;
          document.querySelectorAll('[data-task]').forEach(function (el) {
            var okCat = !cat || el.getAttribute('data-cat') === cat;
            var okQ = !q || el.getAttribute('data-search').indexOf(q) !== -1;
            var on = okCat && okQ;
            el.style.display = on ? '' : 'none';
            if (on) shown++;
          });
          document.querySelectorAll('[data-group]').forEach(function (g) {
            var any = g.querySelectorAll('[data-task]:not([style*="none"])').length;
            g.style.display = any ? '' : 'none';
          });
          var none = document.getElementById('tnone');
          if (none) none.style.display = shown ? 'none' : '';
        }
        var si = document.getElementById('tsearch');
        if (si) si.addEventListener('input', function () { q = this.value.toLowerCase(); apply(); });
        document.querySelectorAll('.fchip').forEach(function (b) {
          b.addEventListener('click', function () {
            document.querySelectorAll('.fchip').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            cat = b.getAttribute('data-cat');
            apply();
          });
        });
      })();
      function rcDrawer(open) {
        document.body.classList.toggle('drawer-open', !!open);
        if (open) setTimeout(function () { var f = document.querySelector('#rc-drawer input[name=name]'); if (f) f.focus(); }, 180);
      }
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') rcDrawer(false); });
    </script>`));
});

/** Task cards, grouped by urgency. */
function recurBoard(st) {
  if (!st.length) {
    return `<div class="empty2">
      <div class="empty2-ico">${icon('recurring')}</div>
      <div class="empty2-t">No recurring tasks yet</div>
      <div class="empty2-s">Add the ones that bite when they're forgotten — hood cleaning, grease trap, pest control.</div>
      ${canWrite() ? `<button class="btn btn-primary" type="button" onclick="rcDrawer(true)">＋ New recurring task</button>` : ''}
    </div>`;
  }
  const groups = [
    { key: 'over', title: 'Overdue', items: st.filter((x) => x.s.key === 'over') },
    { key: 'soon', title: 'This week', items: st.filter((x) => x.s.key === 'soon') },
    { key: 'sched', title: 'Scheduled', items: st.filter((x) => x.s.key === 'sched') },
    { key: 'done', title: 'Completed today', items: st.filter((x) => x.s.key === 'done') },
    { key: 'none', title: 'No date set', items: st.filter((x) => x.s.key === 'none') },
  ].filter((g) => g.items.length);

  return groups.map((g) => `
    <section class="tgroup" data-group>
      <div class="tgroup-h"><span class="tgroup-dot t-${g.key}"></span>${g.title}<span class="tgroup-n">${g.items.length}</span></div>
      <div class="tgrid">
        ${g.items.map(({ r, s }) => {
          const c = catOf(r.category || 'Other');
          const search = [r.name, r.category, r.responsible, r.frequency].filter(Boolean).join(' ').toLowerCase();
          return `
          <article class="tcard ${s.cls}" data-task data-cat="${esc(r.category || 'Other')}" data-search="${esc(search)}" style="--c:${c.color};--ct:${c.tint}">
            <div class="tcard-top">
              <div class="tcard-ico">${icon(c.icon)}</div>
              <div class="tcard-head">
                <a class="tcard-name" href="/c/recurring/${r.id}">${esc(r.name)}</a>
                <div class="tcard-cat">${esc(r.category || 'Other')}</div>
              </div>
              <span class="tstatus ${s.cls}">${esc(s.label)}</span>
            </div>
            <div class="tcard-facts">
              <div class="tfact"><span>Next due</span><b>${esc(niceDate(r.next_due))}</b></div>
              <div class="tfact"><span>Frequency</span><b>${esc(r.frequency || 'Monthly')}</b></div>
              <div class="tfact"><span>Assigned</span><b>${r.responsible ? esc(r.responsible) : '<i class="unset">Unassigned</i>'}</b></div>
              <div class="tfact"><span>Last done</span><b>${r.last_done ? esc(niceDate(r.last_done)) : '<i class="unset">Never</i>'}</b></div>
            </div>
            <div class="tcard-act">
              <form method="post" action="/c/recurring/${r.id}/done" style="margin:0">
                ${canWrite() ? `<button class="btn btn-sm ${s.key === 'over' || s.key === 'soon' ? 'btn-primary' : ''}" type="submit">✓ Mark done</button>` : ''}
              </form>
              <a class="btn btn-sm btn-ghost" href="/c/recurring/${r.id}/edit">Edit</a>
            </div>
          </article>`;
        }).join('')}
      </div>
    </section>`).join('')
    + '<div class="empty2" id="tnone" style="display:none"><div class="empty2-t">Nothing matches</div><div class="empty2-s">Try a different search or category.</div></div>';
}

/** Slide-in panel — creating a task shouldn't cost the page half its height. */
function recurDrawer(today) {
  return `
    <div class="drawer-scrim" onclick="rcDrawer(false)"></div>
    <aside class="drawer" id="rc-drawer" aria-label="New recurring task">
      <div class="drawer-h">
        <div><div class="drawer-t">New recurring task</div><div class="drawer-s">It'll reappear on its own schedule.</div></div>
        <button class="drawer-x" type="button" onclick="rcDrawer(false)" aria-label="Close">✕</button>
      </div>
      <form method="post" action="/c/recurring" class="drawer-b">
        <label class="fld">Task name <input name="name" required placeholder="e.g. Hood cleaning"></label>
        <label class="fld">Category
          <select name="category">${Object.keys(CATEGORIES).map((c) => `<option${c === 'Cleaning' ? ' selected' : ''}>${c}</option>`).join('')}</select>
        </label>
        <div class="fld-row">
          <label class="fld">How often <select name="frequency">${FREQ.map((f) => `<option${f === 'Monthly' ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
          <label class="fld">Next due <input name="next_due" type="date" value="${today}"></label>
        </div>
        <label class="fld">Assigned to <input name="responsible" placeholder="Optional — who owns it"></label>
        <label class="fld">Notes <textarea name="notes" rows="3" placeholder="Optional — vendor, access notes, anything worth remembering"></textarea></label>
        <div class="drawer-f">
          <button class="btn btn-ghost" type="button" onclick="rcDrawer(false)">Cancel</button>
          <button class="btn btn-primary" type="submit">Create task</button>
        </div>
      </form>
    </aside>`;
}

function recurCalendar(rows, month, today) {
  const [y, mo] = month.split('-').map(Number);
  if (!y || !mo) return '<p class="muted">Bad month.</p>';
  const pad = (n) => String(n).padStart(2, '0');
  const monthStart = `${y}-${pad(mo)}-01`;
  const daysInMonth = new Date(y, mo, 0).getDate();
  const monthEnd = `${y}-${pad(mo)}-${pad(daysInMonth)}`;
  const firstWeekday = new Date(y, mo - 1, 1).getDay();

  const byDay = {};
  for (const r of rows) {
    if (!r.next_due) continue;
    let d = r.next_due, guard = 0, first = true;
    while (d <= monthEnd && guard++ < 500) {
      if (d >= monthStart) (byDay[d] = byDay[d] || []).push({ r, projected: !first });
      d = advanceDate(d, r.frequency);
      first = false;
    }
  }
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`;
  const nextM = mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
  const title = new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  let cells = '';
  for (let i = 0; i < firstWeekday; i++) cells += '<div class="cal-cell cal-out"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${y}-${pad(mo)}-${pad(day)}`;
    const items = byDay[iso] || [];
    cells += `<div class="cal-cell${iso === today ? ' cal-today' : ''}">
      <div class="cal-day">${day}</div>
      ${items.map(({ r, projected }) => {
        const c = catOf(r.category || 'Other');
        const s = statusOf({ ...r, next_due: iso });
        return `<a class="cal-task ${projected ? 'cal-proj' : s.cls}" style="--c:${c.color};--ct:${c.tint}"
          href="/c/recurring/${r.id}" title="${esc(r.name)} · ${esc(r.category || 'Other')}${projected ? ' (projected)' : ''}">${esc(r.name)}</a>`;
      }).join('')}
    </div>`;
  }

  return `
    <div class="cal-head">
      <a class="btn btn-sm" href="/c/recurring?view=calendar&m=${prev}">←</a>
      <strong>${esc(title)}</strong>
      <a class="btn btn-sm" href="/c/recurring?view=calendar&m=${nextM}">→</a>
      <a class="btn btn-sm btn-ghost" href="/c/recurring?view=calendar">Today</a>
    </div>
    <div class="cal">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <p class="calnote">Solid chips are real due dates. Dashed ones are the cycle projected forward — they firm up as each task is marked done.</p>`;
}

app.post('/c/recurring', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/c/recurring?err=1&msg=' + encodeURIComponent('Give the task a name.'));
  db.prepare(`INSERT INTO m_recurring (name, category, frequency, next_due, responsible, notes)
              VALUES (@name, @category, @frequency, @next_due, @responsible, @notes)`).run({
    name,
    category: CATEGORIES[req.body.category] ? req.body.category : 'Other',
    frequency: FREQ.includes(req.body.frequency) ? req.body.frequency : 'Monthly',
    next_due: String(req.body.next_due || '').slice(0, 10) || null,
    responsible: String(req.body.responsible || '').trim() || null,
    notes: String(req.body.notes || '').trim() || null,
  });
  res.redirect('/c/recurring?msg=' + encodeURIComponent(`${name} added.`));
});

// Undo matters here: this advances by the frequency, so a mis-tap on a
// quarterly task pushes it three months out with no way back by hand.
app.post('/c/recurring/:id/done', (req, res) => {
  const row = recurQ.one.get(Number(req.params.id));
  if (!row) return res.status(404).end();
  const today = isoDate(startOfToday());
  const next = advanceDate(today, row.frequency);
  recurQ.setDates.run({ id: row.id, last_done: today, next_due: next });
  const undo = `/c/recurring/${row.id}/undo?d=${encodeURIComponent(row.next_due || '')}&l=${encodeURIComponent(row.last_done || '')}`;
  res.redirect('/c/recurring?msg=' + encodeURIComponent(`${row.name} done — next due ${niceDate(next)}.`) + '&undo=' + encodeURIComponent(undo));
});

app.post('/c/recurring/:id/undo', (req, res) => {
  const row = recurQ.one.get(Number(req.params.id));
  if (!row) return res.status(404).end();
  recurQ.setDates.run({
    id: row.id,
    next_due: String(req.query.d || '').slice(0, 10) || null,
    last_done: String(req.query.l || '').slice(0, 10) || null,
  });
  res.redirect('/c/recurring?msg=' + encodeURIComponent(`Undone — ${row.name} is back to ${niceDate(req.query.d)}.`));
});

// ---------------------------------------------------------------------------
// INVOICES
// Built around capture, not data entry: photograph or drop an invoice, the AI
// reads it, you check the numbers and save. Manual entry stays available, but
// it's the fallback rather than the design.
// ---------------------------------------------------------------------------
const INV_CATEGORIES = {
  Food:     { color: '#059669', tint: '#ecfdf5' },
  Coffee:   { color: '#b45309', tint: '#fffbeb' },
  Beverage: { color: '#0891b2', tint: '#ecfeff' },
  Alcohol:  { color: '#7c3aed', tint: '#f5f3ff' },
  Supplies: { color: '#2563eb', tint: '#eff6ff' },
  Repairs:  { color: '#ea580c', tint: '#fff7ed' },
  Services: { color: '#0d9488', tint: '#f0fdfa' },
  Other:    { color: '#64748b', tint: '#f8fafc' },
};
const invCat = (c) => INV_CATEGORIES[c] || INV_CATEGORIES.Other;

const invQ = {
  all: db.prepare('SELECT * FROM m_invoices ORDER BY invoice_date DESC, id DESC'),
  one: db.prepare('SELECT * FROM m_invoices WHERE id = ?'),
  // ai_lines holds the reader's line-item read as JSON until someone reviews
  // it on the import screen. It is not shown on the invoice itself — invoices
  // stay an accounting record.
  add: db.prepare(`INSERT INTO m_invoices
    (invoice_date, due_date, vendor_id, invoice_number, amount_cents, subtotal_cents, tax_cents, category, status, payment_method, file, pages, notes, ai_status, ai_confidence, ai_lines)
    VALUES (@invoice_date, @due_date, @vendor_id, @invoice_number, @amount_cents, @subtotal_cents, @tax_cents, @category, @status, @payment_method, @file, @pages, @notes, @ai_status, @ai_confidence, @ai_lines)`),
  vendors: db.prepare('SELECT id, name FROM m_vendors ORDER BY name'),
  addVendor: db.prepare('INSERT INTO m_vendors (name) VALUES (?)'),
};

/**
 * Unpaid + past due = Overdue. Derived rather than stored, so it can't go stale
 * — a stored status would need something to sweep it every night.
 */
function invStatus(row) {
  if (row.status === 'Paid') return { key: 'paid', label: 'Paid', cls: 's-done' };
  const d = row.due_date ? Math.round((new Date(row.due_date + 'T00:00:00') - startOfToday()) / 86400000) : null;
  if (d === null) return { key: 'unpaid', label: 'Unpaid', cls: 's-sched' };
  if (d < 0) return { key: 'overdue', label: d === -1 ? '1 day overdue' : `${-d} days overdue`, cls: 's-over' };
  if (d <= 7) return { key: 'due', label: d === 0 ? 'Due today' : `Due in ${d} days`, cls: 's-soon' };
  return { key: 'unpaid', label: `Due ${niceDate(row.due_date)}`, cls: 's-sched' };
}

/** Match an extracted supplier name to a vendor you already have. */
function matchVendor(name) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  if (!n) return null;
  const list = invQ.vendors.all();
  return list.find((v) => norm(v.name) === n)
    || list.find((v) => n.startsWith(norm(v.name)) || norm(v.name).startsWith(n))
    || list.find((v) => n.includes(norm(v.name)) || norm(v.name).includes(n))
    || null;
}

/**
 * The expanded half of an invoice row. Rendered on demand rather than inside
 * every row: at ~1.7KB each it was three quarters of the page weight, for
 * detail that is closed until you ask for it. A year of a busy restaurant's
 * invoices would have been a multi-megabyte page.
 */
function invoicePanel(r, vName) {
  const ai = aiBadge(r);
  const isImg = r.file && /\.(jpe?g|png|webp|gif|heic)$/i.test(r.file);
  const fact = (l, v) => `<div class="bs-ivf"><span>${l}</span><b>${v}</b></div>`;
  const none = '<i class="bs-em">—</i>';
  return `
        <div class="bs-ivx">
          <div class="bs-ivl">
            <a class="bs-ivthumb${r.file ? '' : ' none'}" ${r.file ? `href="/uploads/${esc(r.file)}" target="_blank"` : ''}>
              ${isImg ? `<img src="/uploads/${esc(r.file)}" alt="">` : icon(r.file ? 'invoices' : 'documents')}
            </a>
            <span class="bs-tag ${ai.cls === 'ai-check' ? 'warn' : ''}" title="${esc(ai.title)}">${ai.label}</span>
          </div>
          <div class="bs-ivr">
            <div class="bs-ivgrid">
              ${fact('Invoice #', r.invoice_number ? esc(r.invoice_number) : none)}
              ${fact('Subtotal', r.subtotal_cents ? money(r.subtotal_cents) : none)}
              ${fact('Tax', r.tax_cents ? money(r.tax_cents) : none)}
              ${fact('Due', r.due_date ? esc(niceDate(r.due_date)) : none)}
              ${fact('Paid by', r.payment_method ? esc(r.payment_method) : none)}
            </div>
            ${r.notes ? `<div class="bs-ivnote">${esc(r.notes)}</div>` : ''}
            <div class="bs-ivacts">
              <form method="post" action="/c/invoices/${r.id}/status" style="margin:0">
                <input type="hidden" name="status" value="${r.status === 'Paid' ? 'Unpaid' : 'Paid'}">
                <button class="${r.status === 'Paid' ? 'bs-btn-sm' : 'bs-btn'}" type="submit">${r.status === 'Paid' ? 'Mark unpaid' : 'Mark paid'}</button>
              </form>
              <a class="bs-btn-sm" href="/c/invoices/${r.id}/edit">Edit</a>
              ${/* The only product-related thing on the invoice page: a way out
                    to the import screen. The lines themselves stay off here —
                    an invoice is an accounting record.

                    Three states, not two. "Imported" and "still to review" left
                    nowhere to put an invoice that was read, needed nothing, and
                    imported nothing — a page of delivery fees — so it wore the
                    reviewing label permanently. */
                (() => {
                  if (!r.ai_lines || r.ai_lines === '[]') return '';
                  // The flag decides whether this invoice is finished; the
                  // count only says how much is left when it isn't. Recounting
                  // an invoice already marked done would undo a legitimate
                  // answer: skipping a line resolves it without importing
                  // anything, so a re-match still sees it as outstanding and
                  // the button would ask about it again for good.
                  const left = needsProductReview(r) ? pendingOnInvoice(r) : 0;
                  if (left) return `<a class="bs-btn" href="/c/invoices/${r.id}/import">Review ${left} product line${left === 1 ? '' : 's'}</a>`;
                  const bought = prodQ.purchasesForInvoice.all(r.id).length;
                  return `<a class="bs-act bs-ivdone" href="/c/invoices/${r.id}/import">${bought ? 'Products imported ✓' : 'No products to import'}</a>`;
                })()}
              ${pageLinks(r)}
              ${r.vendor_id ? `<a class="bs-act" href="/c/vendors/${Number(r.vendor_id)}">Vendor →</a>` : ''}
              ${/* Last, and quiet. The confirm names what actually goes: an
                    invoice whose lines were imported is also a set of purchase
                    records, and somebody deleting a duplicate should be told
                    that before it happens, not after. */''}
              ${canWrite() ? (() => {
                const n = prodQ.purchasesForInvoice.all(r.id).length;
                const what = `${vName ? esc(vName.get(Number(r.vendor_id)) || 'this invoice') : 'this invoice'}${r.invoice_number ? ' ' + esc(r.invoice_number) : ''}`;
                return `<form method="post" action="/c/invoices/${r.id}/delete" class="bs-ivdel"
                  onsubmit="return confirm('Delete ${what} for ${money(r.amount_cents || 0)}?${
                    n ? ` ${n} purchase${n === 1 ? '' : 's'} will be removed from your product history.` : ''} The uploaded file is kept.')">
                  <button class="bs-act danger" type="submit">Delete invoice</button></form>`;
              })() : ''}
            </div>
          </div>
        </div>`;
}

app.get('/c/invoices/:id/panel', (req, res) => {
  const r = db.prepare('SELECT * FROM m_invoices WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).send('<div class="panel-empty">That invoice is gone.</div>');
  res.send(invoicePanel(r));
});

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * How this invoice got its numbers. Read-by-AI and read-then-corrected are
 * different things: the first still wants a glance, the second has already had
 * one. Low confidence is the only state that actually asks for attention.
 */
function aiBadge(row) {
  const st = row.ai_status || (row.file ? 'manual' : 'manual');
  if (st === 'ai_edited') return { label: 'Edited', cls: 'ai-edit', title: 'Read by AI, then corrected by you' };
  if (st === 'ai') {
    return (row.ai_confidence === 'low' || row.ai_confidence === 'medium')
      ? { label: 'Check', cls: 'ai-check', title: `Read by AI with ${row.ai_confidence} confidence — worth verifying` }
      : { label: 'AI read', cls: 'ai-ok', title: 'Read by AI with high confidence' };
  }
  return { label: 'Manual', cls: 'ai-man', title: 'Entered by hand' };
}

/**
 * Has this invoice been read, with product work still on it?
 *
 * Deliberately the stored flag and not a re-match: this is asked for every
 * invoice on the page, and scoring every line of every invoice against every
 * product to draw a list would get slower with every invoice ever filed.
 * autoImport stamps the flag the moment nothing is left to decide, so the flag
 * is the answer. `[]` is a read that found no item table — also not work, and
 * the reason for the check: it is a non-empty string, so truthiness alone
 * called an invoice with no line items unfinished forever.
 */
const needsProductReview = (r) => !!r.ai_lines && r.ai_lines !== '[]' && !r.lines_imported;

/**
 * What is actually left to decide on this invoice.
 *
 * The panel is fetched one invoice at a time, on demand, so it can afford the
 * match the list cannot — and it has to, because the honest number is the
 * whole point of the button. Counting the stored lines instead offered
 * "Review 12 product lines" for an invoice where ten went in on save and one
 * was a delivery fee: three times the work that was really waiting.
 */
function pendingOnInvoice(inv) {
  let lines = [];
  try { lines = JSON.parse(inv.ai_lines || '[]'); } catch { return 0; }
  if (!lines.length) return 0;
  const rows = reviewRows(lines, prodQ.plain.all(), inv.vendor_id ? Number(inv.vendor_id) : null);
  return pendingCount(rows, importedIdx(inv));
}

// ---------------------------------------------------------------------------
// EXPENSES
//
// The Costco run, a bag of ice, a part from the hardware shop. Money that
// leaves the business without an invoice behind it, usually out of somebody's
// own pocket, and usually forgotten by the time payroll comes round.
//
// The table and the generic add/edit/delete come from the module config, the
// same as every other collection. What is here is the page worth reading: a
// ledger, and one figure that matters more than the rest — what the restaurant
// currently owes its own staff.
// ---------------------------------------------------------------------------
const EXP_CATS = ['Groceries', 'Ice', 'Supplies', 'Cleaning', 'Repairs', 'Equipment',
  'Kitchen', 'Bar', 'Office', 'Travel', 'Other'];
const EXP_PAID = ['Their own money', 'Company card', 'Company cash', 'Drawer cash', 'Other'];

/** Somebody is owed for this: they used their own money and have not been paid back. */
const owedBack = (r) => r.paid_with === 'Their own money' && !r.reimbursed_on;

// ---------------------------------------------------------------------------
// DOCUMENTS
//
// The filing cabinet. A lease, a 941, a certificate of insurance, the letter
// from the health department. What makes them worth a page rather than a
// folder is that several of them run out, and the one you needed to renew is
// never the one you happen to be looking at.
//
// The reader fills the form; a person confirms it. Same shape as invoices,
// with one deliberate difference — it does not read identifiers off the page.
// See the note above DOC_SCHEMA in reader.js.
// ---------------------------------------------------------------------------
const DOC_CATS = ['Payroll', 'Tax', 'Lease', 'Insurance', 'HR', 'Permit', 'Licence',
  'Banking', 'Legal', 'Utilities', 'Other'];

/** Shorten to a word, not to a character. "Federal Ta" reads as a bug. */
const clip = (s, n) => (s.length <= n ? s
  : s.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s,.;:—-]+$/, '') + '…');

/**
 * What this document wants from you, if anything.
 *
 * Whichever date lands first wins: a lease that ends in a fortnight and a
 * filing due in March are one deadline, not two, and it is the near one you
 * need to see. daysTo is the app's own, and NaN out of a half-typed date has
 * to be dropped or it sorts first and every document reads as urgent.
 */
function docState(r) {
  const days = (iso) => { const d = daysTo(iso); return Number.isFinite(d) ? d : null; };
  const exp = days(r.expires_on);
  const act = days(r.action_by);
  const soonest = [exp, act].filter((d) => d !== null).sort((a, b) => a - b)[0];
  if (soonest === undefined) return { key: 'filed', label: 'Filed', cls: 'ok' };
  if (soonest < 0) return { key: 'lapsed', label: exp !== null && exp < 0 ? 'Expired' : 'Overdue', cls: 'bad' };
  if (soonest <= 45) return { key: 'soon', label: soonest === 0 ? 'Today' : `${soonest} day${soonest === 1 ? '' : 's'}`, cls: 'warn' };
  return { key: 'filed', label: 'Filed', cls: 'ok' };
}

// Its own instance rather than the invoice one: that is declared further down
// the file, and reaching for it from here reads it before it exists.
const docScan = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/c/expenses/read', docScan.array('scan', 8), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.json({ error: 'No file received.' });
    const data = await readExpense(req.files);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[reader] receipt read failed:', e.message);
    res.json({ error: e.code === 'NO_KEY' ? e.message : `Could not read that — ${e.message}` });
  }
});

app.post('/c/documents/read', docScan.array('scan', 8), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.json({ error: 'No file received.' });
    const data = await readDocument(req.files);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[reader] document read failed:', e.message);
    res.json({ error: e.code === 'NO_KEY' ? e.message : `Could not read that — ${e.message}` });
  }
});

// ---------------------------------------------------------------------------
// CAPTURE
//
// One way in, for an invoice, a document or an expense: drop the paper, watch
// it read, confirm it against the paper. An overlay rather than a route,
// because the list behind it stays mounted — Cancel and Save put you back on
// the row you were looking at, with your filter and your scroll, which a page
// navigation cannot do without rebuilding both.
//
// The three kinds share the shell, the reading state and the document viewer,
// and differ only in the fields they confirm and where they post. That is the
// whole reason it is one component: the flow is identical, so a fix to it is
// one fix rather than three that drift.
// ---------------------------------------------------------------------------

/** A field in the confirm panel. `read` marks it as something the AI filled. */
const capField = (o) => `
  <div class="cap-f${o.wide ? ' wide' : ''}" data-f="${o.name}">
    <label class="cap-lab" for="cap_${o.name}">${esc(o.label)}<span class="cap-mark" data-for="${o.name}"></span></label>
    ${o.type === 'select'
      ? `<select id="cap_${o.name}" name="${o.name}">${o.options.map((c) => `<option${c === o.value ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`
      : o.type === 'money'
        ? `<div class="cap-money"><input id="cap_${o.name}" name="${o.name}" type="number" step="0.01" min="0" placeholder="0.00"${o.required ? ' required' : ''}></div>`
        : `<input id="cap_${o.name}" name="${o.name}" type="${o.type || 'text'}"${o.value ? ` value="${esc(o.value)}"` : ''}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.required ? ' required' : ''}${o.list ? ` list="${o.list}"` : ''}>`}
  </div>`;

/**
 * The overlay, for whichever kinds this page can add.
 *
 * @param kinds  'invoice' | 'document' | 'expense', in the order the toggle shows them
 */
function captureOverlay(kinds, args) {
  const vendors = invQ.vendors.all();
  const people = [...new Set(q.allEmployees.all().map((e) => e.name).filter(Boolean))];
  const today = args.today;

  const panels = {
    invoice: `
      <div class="cap-kick">Invoice details</div>
      <div class="cap-grid">
        ${capField({ name: 'vendor_name', label: 'Vendor', list: 'cap-vendors', placeholder: 'Who billed you' })}
        ${capField({ name: 'invoice_number', label: 'Invoice no.', placeholder: 'As printed' })}
        ${capField({ name: 'invoice_date', label: 'Date', type: 'date', value: today })}
        ${capField({ name: 'due_date', label: 'Due date', type: 'date' })}
        ${capField({ name: 'amount', label: 'Total', type: 'money', required: true })}
        ${capField({ name: 'category', label: 'Category', type: 'select', options: INV_CATS, value: 'Food' })}
        ${capField({ name: 'subtotal', label: 'Subtotal', type: 'money' })}
        ${capField({ name: 'tax', label: 'Tax', type: 'money' })}
        ${/* These three were on the old drawer and were dropped when it became
              this overlay. Status decides whether an invoice ever appears as
              owed, payment method is how the books reconcile it, and notes is
              where "short two cases, credit promised" goes. None of them can
              be reconstructed later from the paper. */''}
        ${capField({ name: 'status', label: 'Status', type: 'select', options: ['Unpaid', 'Paid'], value: 'Unpaid' })}
        ${capField({ name: 'payment_method', label: 'Paid how', type: 'select', options: ['', ...PAY_METHODS] })}
        ${capField({ name: 'notes', label: 'Notes', wide: true, placeholder: 'Anything worth remembering about this delivery' })}
      </div>
      <div class="cap-lines" id="cap-lines" hidden></div>
      <p class="cap-note">Everything ZWIN read is editable — click any value. Amber fields are worth
        a glance before saving. Line items are matched to Products after you save.</p>
      <datalist id="cap-vendors">${vendors.map((v) => `<option value="${esc(v.name)}"></option>`).join('')}</datalist>`,

    expense: `
      <div class="cap-kick">What was bought</div>
      <div class="cap-grid">
        ${capField({ name: 'name', label: 'What was bought', required: true, wide: true, placeholder: 'Bag of ice, Costco run' })}
        ${capField({ name: 'amount_cents', label: 'Amount', type: 'money', required: true })}
        ${capField({ name: 'spent_on', label: 'Date', type: 'date', value: today })}
        ${capField({ name: 'where_bought', label: 'Where', placeholder: 'Costco, Home Depot' })}
        ${capField({ name: 'category', label: 'Category', type: 'select', options: EXP_CATS, value: 'Groceries' })}
        ${capField({ name: 'paid_by', label: 'Who paid', required: true, list: 'cap-people', placeholder: 'Name' })}
        ${capField({ name: 'paid_with', label: 'Paid with', type: 'select', options: EXP_PAID })}
      </div>
      <p class="cap-note">A receipt does not say whose card it was, so ZWIN leaves “paid with” alone —
        set it yourself, because that is what decides whether somebody is owed the money back.</p>
      <datalist id="cap-people">${people.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>`,

    document: `
      <div class="cap-kick">What this is</div>
      <div class="cap-grid">
        ${capField({ name: 'title', label: 'Title', required: true, wide: true, placeholder: 'Form 941 — Q1 2026' })}
        ${capField({ name: 'issuer', label: 'Who it is from', placeholder: 'IRS, Gusto, landlord' })}
        ${capField({ name: 'category', label: 'Kind', type: 'select', options: DOC_CATS, value: 'Other' })}
        ${capField({ name: 'doc_date', label: 'Date on it', type: 'date' })}
        ${capField({ name: 'reference', label: 'Reference', placeholder: 'Form or policy no.' })}
        ${capField({ name: 'period_start', label: 'Covers from', type: 'date' })}
        ${capField({ name: 'period_end', label: 'Covers to', type: 'date' })}
        ${capField({ name: 'expires_on', label: 'Expires / renews', type: 'date' })}
        ${capField({ name: 'action_by', label: 'Something due by', type: 'date' })}
        ${capField({ name: 'summary', label: 'What it is', wide: true, placeholder: 'One line' })}
      </div>
      <p class="cap-note">Identifiers are deliberately not read — no tax ID, account or card number
        reaches the database. They stay in the file, which is kept exactly as you uploaded it.</p>`,
  };

  const LABEL = { invoice: 'Vendor invoice', expense: 'Expense · receipt', document: 'Document' };
  const SAVE = { invoice: 'Save invoice', expense: 'Save expense', document: 'File it' };
  const ACTION = { invoice: '/c/invoices', expense: '/c/expenses', document: '/c/documents' };

  return `
  <div class="cap-scrim" data-cap-close></div>
  <div class="cap-wrap" role="dialog" aria-modal="true" aria-label="Add a document" data-cap>
    <div class="cap-card">
      <div class="cap-head">
        <a class="cap-back" href="#" data-cap-close>← Back</a>
        <h2 class="cap-title" id="cap-title">Add an invoice or expense</h2>
        <span class="cap-pill" id="cap-pill" hidden>Read by ZWIN · confirm each field</span>
        <div class="cap-acts">
          <a class="bs-btn-sm" href="#" data-cap-close>Cancel</a>
          <button class="bs-btn" type="submit" form="cap-form" id="cap-save" hidden>Save</button>
        </div>
      </div>

      ${/* Step one. The type toggle only appears where more than one kind can
            be added from this page — a page that adds one thing should not ask
            which thing. */''}
      <div class="cap-body" id="cap-step-drop">
        ${kinds.length > 1 ? `<div class="cap-toggle" role="group" aria-label="What are you adding">
          ${kinds.map((k, i) => `<button type="button" data-kind="${k}" aria-pressed="${i === 0}">${LABEL[k]}</button>`).join('')}
        </div>` : ''}
        <div class="cap-drop" id="cap-drop">
          <div class="cap-drop-i">${icon('documents')}</div>
          <p class="cap-drop-t">Drop a PDF or photo here</p>
          <p class="cap-drop-s" id="cap-drop-s">ZWIN reads the vendor, invoice number, date and line items
            so you just confirm. Or start blank and type it in.</p>
          <div class="cap-drop-b">
            <button class="bs-btn cap-primary" type="button" id="cap-choose">Choose a file</button>
            <button class="bs-btn-sm" type="button" id="cap-photo">Take a photo</button>
            ${/* Not offered where the file IS the record. An invoice or an
                   expense can be typed from memory; a document with no
                   document is a title with nothing behind it. */''}
            ${kinds.every((k) => k === 'document') ? ''
              : '<button class="bs-btn-sm" type="button" id="cap-manual">Enter manually</button>'}
          </div>
          <p class="cap-fmt">PDF · JPG · PNG · HEIC — up to 20MB</p>
        </div>
      </div>

      ${/* Steps two and three are one layout: the document arrives, the right
            side reads, then the right side becomes the form. Keeping them in
            one node is what stops the document jumping when the read lands. */''}
      <div class="cap-work" id="cap-step-work" hidden>
        <div class="cap-doc">
          <div class="cap-doc-bar">
            <span id="cap-docname">—</span>
            <span class="cap-tool">
              <button type="button" id="cap-zoom">+ zoom</button>
              <button type="button" id="cap-rotate">⟳ rotate</button>
              <button type="button" id="cap-replace">⇪ replace</button>
            </span>
          </div>
          <div class="cap-sheet" id="cap-sheet"><span class="cap-none">No document — typed in by hand</span></div>
        </div>
        <div class="cap-fields">
          <div id="cap-reading" hidden>
            <div class="cap-read"><span class="cap-spin"></span><span id="cap-reading-t">Reading it…</span></div>
            <div class="cap-skel"></div><div class="cap-skel"></div><div class="cap-skel"></div>
            <p class="cap-note">You can start typing now — it won't overwrite what you touch.</p>
          </div>
          ${kinds.map((k) => `<form method="post" action="${ACTION[k]}" enctype="multipart/form-data"
            class="cap-panel" data-panel="${k}" id="${k === kinds[0] ? 'cap-form' : `cap-form-${k}`}" hidden>
            ${panels[k]}
            <input type="file" name="file" class="cap-file" hidden multiple>
            <input type="hidden" name="ai_status" class="cap-ai" value="manual">
            <input type="hidden" name="ai_lines" class="cap-ailines">
            <input type="hidden" name="ai_confidence" class="cap-aiconf">
            <input type="hidden" name="vendor_id" class="cap-vendorid">
            ${/* What the reader said, before anybody touched it. The save
                  handler compares the posted figures against this to decide
                  between "read by AI" and "read, then corrected" — without it
                  that check silently always says unchanged. */''}
            <input type="hidden" name="ai_snapshot" class="cap-snap">
          </form>`).join('')}
        </div>
      </div>
    </div>
  </div>
  <input type="file" id="cap-pick" accept="image/*,application/pdf" multiple hidden>
  <input type="file" id="cap-pick-cam" accept="image/*" capture="environment" multiple hidden>
  <div class="cap-toast" id="cap-toast"><span class="tag">Saved ✓</span><span id="cap-toast-t"></span></div>
  <datalist id="cap-empty"></datalist>`;
}

/**
 * The overlay's behaviour.
 *
 * Written against the DOM the component above emits. Two rules shape most of
 * it: the document is never blocked on the read, and the read never overwrites
 * a field somebody has touched — the whole promise of "you can start typing
 * now" is that typing wins.
 */
/**
 * Logging an expense that has no document.
 *
 * The big dropzone asks the wrong question for a bag of ice: there is often no
 * receipt worth scanning, and making somebody dismiss a document-first screen
 * to type four fields is friction for its own sake. So a compact modal with
 * the fields to hand — and a receipt tile big enough to actually hit, rather
 * than the native file button, which on a phone is a 20px sliver.
 *
 * The photo is optional here and the tile says so. Where the overlay is for
 * "read this for me", this is for "I already know what it says".
 */
function quickExpense(today) {
  const people = [...new Set(q.allEmployees.all().map((e) => e.name).filter(Boolean))];
  return `
  <div class="cap-scrim" data-qx-close></div>
  <div class="cap-wrap" role="dialog" aria-modal="true" aria-label="Log an expense" data-qx>
    <div class="cap-card cap-quick">
      <div class="cap-head">
        <div>
          <h2 class="cap-title">Log an expense</h2>
          <p class="bs-subline" style="margin:2px 0 0">Something bought without an invoice.</p>
        </div>
        <div class="cap-acts"><a class="bs-btn-sm" href="#" data-qx-close aria-label="Close">✕</a></div>
      </div>
      <form method="post" action="/c/expenses" enctype="multipart/form-data" id="qx-form">
        <div class="cap-body">
          <div>
            <div class="cap-grid">
              <div class="cap-f wide"><label class="cap-lab" for="qx_name">What was bought<span class="cap-mark" data-for="name"></span></label>
                <input id="qx_name" name="name" required placeholder="Bag of ice, Costco run"></div>
              <div class="cap-f"><label class="cap-lab" for="qx_amt">Amount<span class="cap-mark" data-for="amount_cents"></span></label>
                <div class="cap-money"><input id="qx_amt" name="amount_cents" type="number" step="0.01" min="0" required placeholder="0.00"></div></div>
              <div class="cap-f"><label class="cap-lab" for="qx_date">Date<span class="cap-mark" data-for="spent_on"></span></label>
                <input id="qx_date" name="spent_on" type="date" value="${today}" required></div>
              <div class="cap-f"><label class="cap-lab" for="qx_where">Where<span class="cap-mark" data-for="where_bought"></span></label>
                <input id="qx_where" name="where_bought" placeholder="Costco, Home Depot"></div>
              <div class="cap-f"><label class="cap-lab" for="qx_cat">Category<span class="cap-mark" data-for="category"></span></label>
                <select id="qx_cat" name="category">${EXP_CATS.map((c) => `<option${c === 'Groceries' ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
              <div class="cap-f"><label class="cap-lab" for="qx_who">Who paid</label>
                <input id="qx_who" name="paid_by" required list="qx-people" placeholder="Name"></div>
              <div class="cap-f"><label class="cap-lab" for="qx_with">Paid with</label>
                <select id="qx_with" name="paid_with">${EXP_PAID.map((c) => `<option>${c}</option>`).join('')}</select></div>
            </div>
            <datalist id="qx-people">${people.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
          </div>
          <div>
            <span class="cap-lab">Receipt photo</span>
            <label class="cap-tile" id="qx-tile">
              <input type="file" name="file" id="qx-file" accept="image/*,application/pdf" capture="environment" multiple hidden>
              <span class="cap-tile-p" id="qx-plus">+</span>
              <span class="cap-tile-t" id="qx-tile-t">Add a photo</span>
              <span class="cap-tile-s" id="qx-tile-s">drag in · or take one · ZWIN reads it</span>
            </label>
            <p class="cap-note" id="qx-note" hidden></p>
          </div>
        </div>
        <div class="cap-foot">
          <a class="bs-btn-sm" href="#" data-qx-close>Cancel</a>
          <button class="bs-btn" type="submit">Save expense</button>
        </div>
      </form>
    </div>
  </div>`;
}

function quickExpenseScript() {
  return `<script>
  (function () {
    var wrap = document.querySelector('[data-qx]');
    if (!wrap) return;
    var was = null;
    window.capQuick = function () {
      was = document.activeElement;
      document.body.classList.add('cap-open', 'qx-open');
      setTimeout(function () { var f = document.getElementById('qx_name'); if (f) f.focus(); }, 60);
    };
    function close() {
      document.body.classList.remove('cap-open', 'qx-open');
      if (was && was.focus) was.focus();
    }
    wrap.parentNode.querySelectorAll('[data-qx-close]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); close(); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('qx-open')) { e.preventDefault(); close(); }
    });

    // The tile shows what you attached. A dashed box that looks identical
    // before and after is a box people press twice.
    var tile = document.getElementById('qx-tile');
    var file = document.getElementById('qx-file');
    var form = document.getElementById('qx-form');
    var touched = {};

    function say(msg, bad) {
      var n = document.getElementById('qx-note');
      n.hidden = false; n.textContent = msg;
      n.style.color = bad ? 'var(--negative)' : 'var(--muted)';
    }

    // Typing wins here too: somebody who filled the amount in while the photo
    // was still uploading keeps their number.
    function set(name, value, low) {
      if (value === undefined || value === null || value === '' || value === 0) return;
      if (touched[name]) return;
      var f = form.querySelector('[name="' + name + '"]');
      if (!f) return;
      f.value = value;
      var mark = form.querySelector('.cap-mark[data-for="' + name + '"]');
      if (mark) mark.innerHTML = low ? ' <span class="chk">· check this</span>' : ' <span class="ok">✓ read</span>';
      if (low) { var box = f.closest('.cap-f'); if (box) box.classList.add('warn'); }
    }

    // A photo attached here is a receipt, and a receipt has the answers on it.
    // Reading it is the whole reason to photograph it rather than type it.
    function read() {
      var list = [].slice.call(file.files || []);
      if (!list.length) return;
      document.getElementById('qx-tile-s').textContent = 'reading it…';
      say('Reading the receipt — keep typing if you like, it will not overwrite what you touch.');
      var fd = new FormData();
      list.forEach(function (f) { fd.append('scan', f); });
      fetch('/c/expenses/read', { method: 'POST', body: fd })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(t.slice(0, 120) || r.status); });
          return r.json();
        })
        .then(function (j) {
          document.getElementById('qx-tile-s').textContent = 'drag in · or take one';
          if (j.error) { say(j.error + ' Type it in — the photo is still attached.', true); return; }
          var d = j.data || {};
          var low = d.confidence === 'low' || d.confidence === 'medium';
          set('name', d.name, low);
          set('where_bought', d.where_bought, low);
          set('amount_cents', d.total, low);
          set('spent_on', d.spent_on, low);
          set('category', d.category, low);
          // Only when the receipt actually says so. Whose card it was is not
          // printed on it, and guessing wrong invents a debt to somebody.
          if (d.paid_with) set('paid_with', d.paid_with, low);
          say(low ? 'Read it, but not clearly — check the amount and the date before saving.'
            : 'Read it. Check it against the receipt and save.');
        })
        .catch(function (e) {
          document.getElementById('qx-tile-s').textContent = 'drag in · or take one';
          say('Could not read it — ' + e.message + '. Type it in; the photo is still attached.', true);
        });
    }

    form.addEventListener('input', function (e) {
      if (!e.target.name) return;
      touched[e.target.name] = true;
      var mark = form.querySelector('.cap-mark[data-for="' + e.target.name + '"]');
      if (mark) mark.textContent = '';
      var box = e.target.closest('.cap-f'); if (box) box.classList.remove('warn');
    });

    function shown() {
      var n = (file.files || []).length;
      if (!n) return;
      document.getElementById('qx-tile-t').textContent = n === 1 ? file.files[0].name : n + ' photos attached';
      var f = file.files[0];
      if (/^image\\//.test(f.type)) {
        var img = tile.querySelector('img') || document.createElement('img');
        img.alt = 'The receipt you attached';
        img.src = URL.createObjectURL(f);
        var plus = document.getElementById('qx-plus');
        if (plus) plus.replaceWith(img); else if (!img.parentNode) tile.prepend(img);
      }
      read();
    }
    file.addEventListener('change', shown);
    ['dragenter', 'dragover'].forEach(function (t) {
      tile.addEventListener(t, function (e) { e.preventDefault(); tile.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      tile.addEventListener(t, function (e) { e.preventDefault(); tile.classList.remove('over'); });
    });
    tile.addEventListener('drop', function (e) {
      e.preventDefault();
      var dt = new DataTransfer();
      [].slice.call(e.dataTransfer.files).forEach(function (f) { dt.items.add(f); });
      file.files = dt.files; shown();
    });

    document.getElementById('qx-form').addEventListener('submit', function () {
      try { sessionStorage.setItem('cap-saved', 'expense'); } catch (err) { /* private mode */ }
    });
  })();
  </script>`;
}

function captureScript(kinds) {
  return `<script>
  (function () {
    var wrap = document.querySelector('[data-cap]');
    if (!wrap) return;
    var KINDS = ${JSON.stringify(kinds)};
    var kind = KINDS[0];
    var files = [];
    var touched = {};          // fields the person has edited — never overwritten
    var lastFocus = null;
    var rot = 0, zoom = 1;

    var READ_URL = { invoice: '/c/invoices/read', expense: '/c/expenses/read', document: '/c/documents/read' };
    var READING = { invoice: 'Reading the invoice…', expense: 'Reading the receipt…', document: 'Reading the document…' };
    var TITLE = { invoice: 'Reviewing a new invoice', expense: 'Reviewing a receipt', document: 'Reviewing a document' };
    var SAVE = { invoice: 'Save invoice', expense: 'Save expense', document: 'File it' };
    var HINT = {
      invoice: 'ZWIN reads the vendor, invoice number, date and line items so you just confirm. Or start blank and type it in.',
      expense: 'ZWIN reads what it was, where, how much and when. Or start blank and type it in.',
      document: 'ZWIN reads the title, who sent it and the dates that matter. Or start blank and type it in.'
    };

    var el = function (id) { return document.getElementById(id); };
    var panel = function (k) { return wrap.querySelector('[data-panel="' + (k || kind) + '"]'); };

    // --- opening and closing ------------------------------------------------
    function open(k) {
      lastFocus = document.activeElement;
      if (k) setKind(k);
      document.body.classList.remove('qx-open');
      document.body.classList.add('cap-open');
      var b = el('cap-choose'); if (b) setTimeout(function () { b.focus(); }, 60);
    }
    function close() {
      document.body.classList.remove('cap-open', 'qx-open');
      reset();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function reset() {
      files = []; touched = {}; rot = 0; zoom = 1;
      el('cap-step-drop').hidden = false;
      el('cap-step-work').hidden = true;
      el('cap-save').hidden = true;
      el('cap-pill').hidden = true;
      el('cap-title').textContent = 'Add ' + (KINDS.length > 1 ? 'an invoice or expense' : KINDS[0] === 'document' ? 'a document' : 'an expense');
      el('cap-sheet').innerHTML = '<span class="cap-none">No document — typed in by hand</span>';
      el('cap-docname').textContent = '—';
      wrap.querySelectorAll('.cap-panel').forEach(function (f) { f.reset(); f.hidden = true; });
      wrap.querySelectorAll('.cap-mark').forEach(function (m) { m.textContent = ''; });
      wrap.querySelectorAll('.cap-f').forEach(function (f) { f.classList.remove('warn'); });
      var lines = el('cap-lines'); if (lines) { lines.hidden = true; lines.innerHTML = ''; }
    }
    window.capOpen = open;

    wrap.parentNode.querySelectorAll('[data-cap-close]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); close(); });
    });
    document.addEventListener('keydown', function (e) {
      if (!document.body.classList.contains('cap-open')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      // Focus stays in the overlay: behind it is a list that is still there and
      // still tabbable, and falling into it is how a modal stops being one.
      var f = wrap.querySelectorAll('a[href], button:not([hidden]), input:not([type=hidden]), select, textarea');
      var live = [].filter.call(f, function (x) { return x.offsetParent !== null && !x.disabled; });
      if (!live.length) return;
      var first = live[0], last = live[live.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // --- which kind ----------------------------------------------------------
    function setKind(k) {
      kind = k;
      wrap.querySelectorAll('[data-kind]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.kind === k));
      });
      var s = el('cap-drop-s'); if (s) s.textContent = HINT[k];
      var sv = el('cap-save'); if (sv) { sv.textContent = SAVE[k]; sv.setAttribute('form', panel(k).id); }
    }
    wrap.querySelectorAll('[data-kind]').forEach(function (b) {
      b.addEventListener('click', function () { setKind(b.dataset.kind); });
    });

    // --- picking a file ------------------------------------------------------
    el('cap-choose').addEventListener('click', function () { el('cap-pick').click(); });
    el('cap-photo').addEventListener('click', function () { el('cap-pick-cam').click(); });
    var manual = el('cap-manual');
    if (manual) manual.addEventListener('click', function () { toWork(); showForm(); });
    ['cap-pick', 'cap-pick-cam'].forEach(function (id) {
      el(id).addEventListener('change', function () { take(this.files); this.value = ''; });
    });
    var dz = el('cap-drop');
    ['dragenter', 'dragover'].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e) { take(e.dataTransfer.files); });
    el('cap-replace').addEventListener('click', function () { el('cap-pick').click(); });

    function toWork() {
      el('cap-step-drop').hidden = true;
      el('cap-step-work').hidden = false;
      el('cap-title').textContent = TITLE[kind];
      el('cap-save').hidden = false;
      el('cap-save').textContent = SAVE[kind];
      el('cap-save').setAttribute('form', panel().id);
    }
    function showForm() {
      el('cap-reading').hidden = true;
      wrap.querySelectorAll('.cap-panel').forEach(function (f) { f.hidden = f.dataset.panel !== kind; });
    }

    function take(picked) {
      var list = [].slice.call(picked || []);
      if (!list.length) return;
      files = list;
      toWork();

      // The document goes up first and on its own. Whatever the reader does or
      // fails to do, the paper is on screen and the form underneath it works.
      preview(list);
      // Every page rides into the save, not just the first.
      var dt = new DataTransfer();
      list.forEach(function (f) { dt.items.add(f); });
      panel().querySelector('.cap-file').files = dt.files;

      el('cap-reading').hidden = false;
      el('cap-reading-t').textContent = READING[kind];
      wrap.querySelectorAll('.cap-panel').forEach(function (f) { f.hidden = true; });
      el('cap-pill').hidden = true;

      var fd = new FormData();
      list.forEach(function (f) { fd.append('scan', f); });
      fetch(READ_URL[kind], { method: 'POST', body: fd })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(t.slice(0, 120) || r.status); });
          return r.json();
        })
        .then(function (j) {
          showForm();
          if (j.error) { note(j.error); return; }
          // Two shapes in the wild: the documents and expenses readers answer
          // {ok, data}, and the invoice reader — which predates them — answers
          // the fields flat alongside its vendor match and line tally. Reading
          // only j.data meant every invoice read landed as an empty object and
          // filled nothing, while the "read by ZWIN" pill still appeared.
          var d = j.data || j;
          if (!d || !Object.keys(d).length) { note('Nothing could be read off that. Type it in — the file is still attached.'); return; }
          fill(d);
          el('cap-pill').hidden = false;
        })
        .catch(function (e) { showForm(); note('Could not read it — ' + e.message + '. Type it in; the file is still attached.'); });
    }

    function note(msg) {
      var p = panel().querySelector('.cap-note');
      if (p) { p.textContent = msg; p.style.color = 'var(--negative)'; }
    }

    function preview(list) {
      var f = list[0];
      el('cap-docname').textContent = f.name + (list.length > 1 ? ' · 1 of ' + list.length : '');
      var url = URL.createObjectURL(f);
      el('cap-sheet').innerHTML = /pdf/i.test(f.type)
        ? '<iframe src="' + url + '" title="The document"></iframe>'
        : '<img alt="The document you uploaded" src="' + url + '">';
      applyView();
    }
    function applyView() {
      var m = el('cap-sheet').querySelector('img');
      if (m) m.style.transform = 'rotate(' + rot + 'deg) scale(' + zoom + ')';
    }
    el('cap-rotate').addEventListener('click', function () { rot = (rot + 90) % 360; applyView(); });
    el('cap-zoom').addEventListener('click', function () { zoom = zoom >= 2 ? 1 : zoom + 0.5; applyView(); });

    // --- what the reader found ----------------------------------------------
    // Typing wins. A field somebody has edited is theirs, and a read that
    // landed a moment later must not take it back.
    function set(name, value, low) {
      if (value === undefined || value === null || value === '' || value === 0) return;
      if (touched[name]) return;
      var f = panel().querySelector('[name="' + name + '"]');
      if (!f) return;
      f.value = value;
      var mark = panel().querySelector('.cap-mark[data-for="' + name + '"]');
      if (mark) mark.innerHTML = low ? ' <span class="chk">· check this</span>' : ' <span class="ok">✓ read</span>';
      if (low) { var box = f.closest('.cap-f'); if (box) box.classList.add('warn'); }
    }

    function fill(d) {
      var low = d.confidence === 'low' || d.confidence === 'medium';
      panel().querySelector('.cap-ai').value = 'ai';
      if (d.confidence) panel().querySelector('.cap-aiconf').value = d.confidence;
      var snap = panel().querySelector('.cap-snap');
      if (snap) {
        // Same five fields, same order, as the save handler re-joins to compare.
        snap.value = [d.total || '', d.subtotal || '', d.tax || '',
          d.vendor_id || '', d.category || ''].join('|');
      }

      if (kind === 'invoice') {
        // The endpoint already matched the read name against the vendor list.
        // Prefer its match, so "SYSCO FOODS INC" fills as the vendor actually
        // on file rather than creating a near-duplicate of it on save.
        set('vendor_name', d.matched_vendor || d.vendor_name, low);
        if (d.vendor_id) panel().querySelector('.cap-vendorid').value = d.vendor_id;
        set('invoice_number', d.invoice_number, low);
        set('invoice_date', d.invoice_date, low);
        set('due_date', d.due_date, low);
        set('amount', d.total, low);
        set('subtotal', d.subtotal, low);
        set('tax', d.tax, low);
        set('category', d.category, low);
        if (d.line_items && d.line_items.length) {
          panel().querySelector('.cap-ailines').value = JSON.stringify(d.line_items);
          lines(d.line_items, d.total);
        }
      } else if (kind === 'expense') {
        set('name', d.name, low);
        set('where_bought', d.where_bought, low);
        set('amount_cents', d.total, low);
        set('spent_on', d.spent_on, low);
        set('category', d.category, low);
        set('paid_with', d.paid_with, low);
      } else {
        set('title', d.title, low);
        set('issuer', d.issuer, low);
        set('category', d.category, low);
        set('doc_date', d.doc_date, low);
        set('reference', d.reference, low);
        set('period_start', d.period_start, low);
        set('period_end', d.period_end, low);
        set('expires_on', d.expires_on, low);
        set('action_by', d.action_by, low);
        set('summary', d.summary, low);
      }
    }

    // What was read off the item table, and whether it adds up. The match
    // status is deliberately not claimed here — matching happens on save,
    // against the product list, and saying "matched" before that has run would
    // be a guess dressed as a fact.
    function lines(items, total) {
      var box = el('cap-lines');
      if (!box) return;
      var sum = 0;
      var rows = items.map(function (l) {
        sum += Number(l.total) || 0;
        return '<div class="cap-line"><span class="cap-line-d">' + String(l.description || '')
          .replace(/[<>&]/g, '') + '</span><span class="cap-line-q">' + (l.qty ? '×' + l.qty : '')
          + '</span><span class="cap-line-a">$' + (Number(l.total) || 0).toFixed(2) + '</span></div>';
      }).join('');
      var off = Math.abs(sum - (Number(total) || 0)) > 0.02;
      box.innerHTML = '<div class="cap-kick" style="margin:0;padding:9px 13px;border-bottom:1px solid var(--field-b,#d3c6ac)">'
        + 'Lines read · ' + items.length + '</div>' + rows
        + '<div class="cap-recon"><span>Lines total vs. ' + (off ? 'invoice — check' : 'invoice') + '</span>'
        + '<b class="' + (off ? 'off' : 'ok') + '">$' + sum.toFixed(2) + (off ? '' : ' ✓') + '</b></div>';
      box.hidden = false;
    }

    // --- typing wins ---------------------------------------------------------
    wrap.addEventListener('input', function (e) {
      var f = e.target.closest('.cap-f');
      if (!f || !e.target.name) return;
      touched[e.target.name] = true;
      var mark = wrap.querySelector('.cap-mark[data-for="' + e.target.name + '"]');
      if (mark) mark.textContent = '';
      f.classList.remove('warn');
      var ai = panel().querySelector('.cap-ai');
      if (ai && ai.value === 'ai') ai.value = 'ai_edited';
    });

    // --- saving --------------------------------------------------------------
    // A normal form post. The overlay is a nicer way to fill the same form the
    // server has always taken, and keeping the post ordinary is what lets the
    // duplicate check, the auto-import and every guard behind them keep working
    // untouched. Where you were is restored on the way back.
    wrap.addEventListener('submit', function (e) {
      // The file is the record for a document. There is no manual door into
      // this form, but a form can still be submitted with the field emptied.
      if (kind === 'document' && !(panel().querySelector('.cap-file').files || []).length) {
        e.preventDefault();
        note('A document needs the file itself — drop it in above.');
        return;
      }
      try { sessionStorage.setItem('cap-saved', kind); } catch (err) { /* private mode */ }
      var s = el('cap-save'); if (s) { s.disabled = true; s.textContent = 'Saving…'; }
    });

    try {
      var was = sessionStorage.getItem('cap-saved');
      if (was) {
        sessionStorage.removeItem('cap-saved');
        var t = el('cap-toast');
        if (t) {
          el('cap-toast-t').textContent = was === 'invoice' ? 'Invoice added.'
            : was === 'expense' ? 'Expense logged.' : 'Document filed.';
          t.classList.add('on');
          setTimeout(function () { t.classList.remove('on'); }, 4000);
        }
      }
    } catch (e) { /* private mode */ }
  })();
  </script>`;
}

app.get('/c/documents', (req, res) => {
  const all = db.prepare('SELECT * FROM m_documents ORDER BY COALESCE(doc_date, created_at) DESC, id DESC').all();

  const withState = all.map((r) => ({ r, st: docState(r) }));
  const lapsed = withState.filter((x) => x.st.key === 'lapsed');
  const soon = withState.filter((x) => x.st.key === 'soon');
  const cats = [...new Set(all.map((r) => r.category || 'Other'))];

  const statCell = (label, value, sub, tone) =>
    `<div class="bs-strip-c"><span class="bs-strip-l">${label}</span><span class="bs-stat${tone ? ' ' + tone : ''}">${value}</span><span class="bs-strip-s">${sub}</span></div>`;

  const soonestOf = (r) => [daysTo(r.expires_on), daysTo(r.action_by)]
    .filter((d) => Number.isFinite(d)).sort((x, y) => x - y)[0];
  const nextUp = [...lapsed, ...soon].sort((a, b) => soonestOf(a.r) - soonestOf(b.r))[0];

  const strip = `<section class="bs-panel bs-strip">
    ${statCell('On file', String(all.length), `${cats.length} kind${cats.length === 1 ? '' : 's'}`)}
    ${statCell('Expired or overdue', String(lapsed.length),
      lapsed.length ? 'needs sorting out' : 'nothing has lapsed', lapsed.length ? 'bad' : 'ok')}
    ${statCell('Due within 45 days', String(soon.length),
      soon.length ? 'renew or file these' : 'nothing coming up', soon.length ? 'warn' : 'ok')}
    ${statCell('Next', nextUp ? esc(nextUp.st.label) : '—',
      nextUp ? esc(clip(nextUp.r.title || '', 42)) : 'nothing dated', nextUp ? nextUp.st.cls : '')}
  </section>`;

  const dateFacts = (r) => [
    r.doc_date ? `Dated ${niceDate(r.doc_date)}` : '',
    r.period_start || r.period_end
      ? `Covers ${r.period_start ? niceDate(r.period_start) : '?'} – ${r.period_end ? niceDate(r.period_end) : '?'}` : '',
    r.expires_on ? `Expires ${niceDate(r.expires_on)}` : '',
    r.action_by ? `Due ${niceDate(r.action_by)}` : '',
  ].filter(Boolean);

  const items = withState.map(({ r, st }) => {
    const isImg = r.file && /\.(jpe?g|png|webp|gif|heic)$/i.test(r.file);
    const search = [r.title, r.issuer, r.category, r.reference, r.summary, r.notes]
      .filter(Boolean).join(' ').toLowerCase();
    return `
    <details class="bs-srow bs-docrow" data-doc data-id="${r.id}" data-state="${st.key}"
      data-cat="${esc(r.category || 'Other')}" data-search="${esc(search)}"
      data-date="${esc(r.doc_date || r.created_at || '')}" data-title="${esc((r.title || '').toLowerCase())}">
      <summary class="bs-sr bs-dr">
        <span class="bs-dr-t">${esc(r.title || 'Untitled')}${r.reference ? `<u>${esc(r.reference)}</u>` : ''}</span>
        <span class="bs-dr-i">${esc(r.issuer || '—')}</span>
        <span class="bs-dr-c">${esc(r.category || 'Other')}</span>
        <span class="bs-dr-d">${esc(r.doc_date ? niceDate(r.doc_date) : '—')}</span>
        <span class="bs-tag ${st.cls} bs-dr-s">${esc(st.label)}</span>
        <span class="bs-sr-e">Open</span>
      </summary>
      <div class="bs-ivx">
        <div class="bs-ivl">
          <a class="bs-ivthumb${r.file ? '' : ' none'}" ${r.file ? `href="/uploads/${esc(r.file)}" target="_blank"` : ''}>
            ${isImg ? `<img src="/uploads/${esc(r.file)}" alt="">` : icon('documents')}
          </a>
          ${r.ai_status === 'ai' ? '<span class="bs-tag">Read by AI</span>'
            : r.ai_status === 'ai_edited' ? '<span class="bs-tag">Read, then corrected</span>'
            : '<span class="bs-tag">Filed by hand</span>'}
        </div>
        <div class="bs-ivr">
          ${r.summary ? `<p class="bs-ivsum">${esc(r.summary)}</p>` : ''}
          <div class="bs-ivgrid">
            ${dateFacts(r).map((f) => `<div class="bs-ivf"><span>${esc(f.split(' ')[0])}</span><b>${esc(f.split(' ').slice(1).join(' '))}</b></div>`).join('')
              || '<div class="bs-ivf"><span>Dates</span><b><i class="bs-em">none on it</i></b></div>'}
          </div>
          ${r.notes ? `<div class="bs-ivnote">${esc(r.notes)}</div>` : ''}
          <div class="bs-ivacts">
            ${pageLinks(r, 'Open')}
            <a class="bs-btn-sm" href="/c/documents/${r.id}/edit">Edit</a>
            ${canWrite() ? `<form method="post" action="/c/documents/${r.id}/delete" class="bs-ivdel"
              onsubmit="return confirm('Delete ${esc((r.title || 'this document').replace(/'/g, ''))}? The uploaded file is kept.')">
              <button class="bs-act danger" type="submit">Delete</button></form>` : ''}
          </div>
        </div>
      </div>
    </details>`;
  }).join('');

  const toolbar = `
    <div class="bs-tools">
      <div class="bs-isearch">${icon('search')}
        <input id="dsearch" type="search" placeholder="Title, who it is from, reference…" autocomplete="off"></div>
      <div class="bs-quick">
        <button class="fchip on" data-f="all" data-v="">All <b>${all.length}</b></button>
        ${lapsed.length ? `<button class="fchip" data-f="state" data-v="lapsed"><i class="bs-pip dupe"></i>Expired <b>${lapsed.length}</b></button>` : ''}
        ${soon.length ? `<button class="fchip" data-f="state" data-v="soon"><i class="bs-pip rev"></i>Due soon <b>${soon.length}</b></button>` : ''}
      </div>
      <details class="fsheet">
        <summary class="fs-btn">Sort &amp; filter <span class="fs-caret">▾</span></summary>
        <div class="fs-body"><div class="fs-scrim" aria-hidden="true"></div>
          <div class="fs-panel">
            <div class="fs-h">Sort</div>
            <select id="dsort" class="bs-sel">
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="title">Title, A–Z</option>
            </select>
            ${cats.length ? `<div class="fs-h">Kind</div><div class="fs-opts">
              ${cats.map((c) => `<button class="fs-o fchip" type="button" data-f="cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}
            </div>` : ''}
          </div></div>
      </details>
    </div>`;

  const body = all.length ? `<div class="bs-shead bs-dochead">
      <span>Document</span><span>From</span><span>Kind</span><span>Dated</span><span></span><span></span>
    </div><div class="bs-srows docs">${items}</div>`
    : `<div class="bs-hero">
        <div class="bs-hero-k">Nothing filed yet</div>
        <h2 class="bs-hero-t">The lease, the 941, the certificate of insurance, the letter from the health department.</h2>
        <p class="bs-hero-s">${canWrite()
          ? 'Upload a PDF or a photo and it reads the title, who sent it and the dates that matter — including the one it runs out on. You confirm before anything is filed.'
          : 'Once the owner files documents, they show up here.'}</p>
        ${canWrite() ? '<button class="bs-btn" type="button" onclick="capOpen()">File the first one</button>' : ''}
      </div>`;

  const headline = all.length
    ? (lapsed.length
      ? `Documents — <span class="warn">${lapsed.length} expired or overdue</span>.`
      : soon.length ? `Documents — ${soon.length} coming up in the next 45 days.`
      : `Documents — ${all.length} on file, nothing running out.`)
    : 'Documents — nothing filed yet.';

  res.send(layout('Documents', `
    ${flash(req)}
    <div class="bs-page">
      <div class="bs-head">
        <div class="bs-headwrap">
          <h1 class="bs-headline">${headline}</h1>
          <p class="bs-subline">Leases, tax filings, licences and letters. The file is kept as you uploaded it.</p>
        </div>
        ${canWrite() ? '<button class="bs-btn" type="button" onclick="capOpen()">File a document</button>' : ''}
      </div>
      ${all.length ? strip : ''}
      ${all.length ? toolbar : ''}
      ${body}
      <div class="bs-blank" id="dnone" style="display:none"><b>Nothing matches</b><span>Try a different search or filter.</span></div>
    </div>
    ${canWrite() ? captureOverlay(['document'], { today: isoDate(startOfToday()) }) : ''}
    <script>
      (function () {
        var q = '', mode = 'all', val = '';
        function apply() {
          var shown = 0;
          document.querySelectorAll('[data-doc]').forEach(function (el) {
            var ok = true;
            if (mode === 'state' && el.getAttribute('data-state') !== val) ok = false;
            if (mode === 'cat' && el.getAttribute('data-cat') !== val) ok = false;
            if (q && el.getAttribute('data-search').indexOf(q) === -1) ok = false;
            el.style.display = ok ? '' : 'none'; if (ok) shown++;
          });
          var none = document.getElementById('dnone');
          if (none) none.style.display = shown ? 'none' : '';
        }
        var si = document.getElementById('dsearch');
        if (si) si.addEventListener('input', function () { q = this.value.toLowerCase(); apply(); });
        var so = document.getElementById('dsort');
        if (so) so.addEventListener('change', function () {
          var box = document.querySelector('.docs'); if (!box) return;
          var items = [].slice.call(box.querySelectorAll('[data-doc]'));
          items.sort(function (a, b) {
            var how = so.value;
            if (how === 'title') return a.getAttribute('data-title').localeCompare(b.getAttribute('data-title'));
            var A = a.getAttribute('data-date') || '', B = b.getAttribute('data-date') || '';
            return how === 'date-asc' ? A.localeCompare(B) : B.localeCompare(A);
          });
          items.forEach(function (el) { box.appendChild(el); });
        });
        document.querySelectorAll('.fchip').forEach(function (b) {
          b.addEventListener('click', function () {
            document.querySelectorAll('.fchip').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            mode = b.getAttribute('data-f'); val = b.getAttribute('data-v'); apply();
          });
        });
      })();
    </script>
    ${canWrite() ? captureScript(['document']) : ''}`));
});



app.get('/c/expenses', (req, res) => {
  const all = db.prepare('SELECT * FROM m_expenses ORDER BY spent_on DESC, id DESC').all();
  const today = isoDate(startOfToday());
  const thisMonth = today.slice(0, 7);

  const years = [...new Set(all.map((r) => (r.spent_on || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const year = years.includes(req.query.y) ? req.query.y : (years[0] || today.slice(0, 4));
  const rows = all.filter((r) => (r.spent_on || '').slice(0, 4) === year);

  const brief = (cents) => (Math.abs(cents) >= 100000
    ? '$' + Math.round(cents / 100).toLocaleString('en-US') : money(cents));
  const statCell = (label, value, sub, tone) =>
    `<div class="bs-strip-c"><span class="bs-strip-l">${label}</span><span class="bs-stat${tone ? ' ' + tone : ''}">${value}</span><span class="bs-strip-s">${sub}</span></div>`;

  const spendMonth = all.filter((r) => (r.spent_on || '').slice(0, 7) === thisMonth)
    .reduce((a, r) => a + (r.amount_cents || 0), 0);
  const owed = all.filter(owedBack);
  const owedTotal = owed.reduce((a, r) => a + (r.amount_cents || 0), 0);
  // Who is owed the most, because that is the name you settle up with first.
  const byPerson = new Map();
  for (const r of owed) byPerson.set(r.paid_by || '—', (byPerson.get(r.paid_by || '—') || 0) + (r.amount_cents || 0));
  const topOwed = [...byPerson.entries()].sort((a, b) => b[1] - a[1])[0];
  const noReceipt = rows.filter((r) => !r.file).length;
  const yearSpend = rows.reduce((a, r) => a + (r.amount_cents || 0), 0);

  const strip = `<section class="bs-panel bs-strip">
    ${statCell('Spent this month', brief(spendMonth), MONTHS[Number(thisMonth.slice(5, 7)) - 1] + ' ' + thisMonth.slice(0, 4))}
    ${statCell('Owed back', brief(owedTotal), owed.length
      ? `${owed.length} to settle${topOwed ? ` · most to ${esc(topOwed[0])}` : ''}` : 'Nobody is out of pocket',
      owedTotal ? 'warn' : 'ok')}
    ${statCell('No receipt', String(noReceipt), noReceipt ? 'photograph them before they fade' : 'every one has a photo',
      noReceipt ? 'warn' : 'ok')}
    ${statCell(`Spent in ${esc(year)}`, brief(yearSpend), `${rows.length} expense${rows.length === 1 ? '' : 's'}`)}
  </section>`;

  const byMonth = new Map();
  for (const r of rows) {
    const m = (r.spent_on || '').slice(0, 7) || 'undated';
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  const months = [...byMonth.keys()].sort().reverse();

  const monthBlocks = months.map((m, idx) => {
    const list = byMonth.get(m);
    const total = list.reduce((a, r) => a + (r.amount_cents || 0), 0);
    const owing = list.filter(owedBack).length;
    const label = m === 'undated' ? 'No date' : `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

    const items = list.map((r) => {
      const isImg = r.file && /\.(jpe?g|png|webp|gif|heic)$/i.test(r.file);
      const owe = owedBack(r);
      const search = [r.name, r.where_bought, r.paid_by, r.category, r.notes,
        ((r.amount_cents || 0) / 100).toFixed(2)].filter(Boolean).join(' ').toLowerCase();
      return `
      <details class="bs-srow bs-exrow" data-exp data-id="${r.id}"
        data-owed="${owe ? '1' : '0'}" data-cat="${esc(r.category || 'Other')}"
        data-amt="${(r.amount_cents || 0) / 100}" data-date="${esc(r.spent_on || '')}"
        data-who="${esc((r.paid_by || '').toLowerCase())}" data-search="${esc(search)}">
        <summary class="bs-sr bs-xr">
          <span class="bs-xr-d">${esc(niceDate(r.spent_on))}</span>
          <span class="bs-xr-w">${esc(r.name || 'Something')}${
            r.where_bought ? `<u>${esc(r.where_bought)}</u>` : ''}</span>
          <span class="bs-xr-c">${esc(r.category || '—')}</span>
          <span class="bs-xr-p">${esc(r.paid_by || '—')}${
            owe ? '<i class="bs-tag warn">owed back</i>'
            : r.reimbursed_on ? '<i class="bs-tag ok">paid back</i>' : ''}</span>
          <span class="bs-sr-f">${money(r.amount_cents || 0)}</span>
          <span class="bs-xr-r">${r.file ? '<i class="bs-pip has" title="Receipt attached"></i>' : '<i class="bs-pip none" title="No receipt"></i>'}</span>
          <span class="bs-sr-e">Open</span>
        </summary>
        <div class="bs-ivx">
          <div class="bs-ivl">
            <a class="bs-ivthumb${r.file ? '' : ' none'}" ${r.file ? `href="/uploads/${esc(r.file)}" target="_blank"` : ''}>
              ${isImg ? `<img src="/uploads/${esc(r.file)}" alt="">` : icon(r.file ? 'invoices' : 'documents')}
            </a>
            <span class="bs-tag">${r.file ? 'Receipt' : 'No receipt'}</span>
          </div>
          <div class="bs-ivr">
            <div class="bs-ivgrid">
              <div class="bs-ivf"><span>Amount</span><b>${money(r.amount_cents || 0)}</b></div>
              <div class="bs-ivf"><span>Who paid</span><b>${esc(r.paid_by || '—')}</b></div>
              <div class="bs-ivf"><span>Paid with</span><b>${esc(r.paid_with || '—')}</b></div>
              <div class="bs-ivf"><span>Where</span><b>${esc(r.where_bought || '—')}</b></div>
              <div class="bs-ivf"><span>Paid back</span><b>${r.reimbursed_on ? esc(niceDate(r.reimbursed_on)) : '<i class="bs-em">not yet</i>'}</b></div>
            </div>
            ${r.notes ? `<div class="bs-ivnote">${esc(r.notes)}</div>` : ''}
            <div class="bs-ivacts">
              ${canWrite() && owe ? `<form method="post" action="/c/expenses/${r.id}/reimburse" style="margin:0">
                <button class="bs-btn" type="submit">Mark paid back</button></form>` : ''}
              ${canWrite() && r.reimbursed_on ? `<form method="post" action="/c/expenses/${r.id}/reimburse" style="margin:0">
                <input type="hidden" name="undo" value="1">
                <button class="bs-btn-sm" type="submit">Not paid back after all</button></form>` : ''}
              <a class="bs-btn-sm" href="/c/expenses/${r.id}/edit">Edit</a>
              ${pageLinks(r, 'Open receipt')}
            </div>
          </div>
        </div>
      </details>`;
    }).join('');

    return `
      <details class="bs-month" data-month${idx === 0 ? ' open' : ''}>
        <summary class="bs-month-h">
          <span class="bs-kicker">${esc(label)}</span>
          <span class="bs-month-meta">${list.length} expense${list.length === 1 ? '' : 's'}
            ${owing ? `· <b class="warn">${owing} owed back</b>` : '· <b class="ok">all settled</b>'}</span>
          <span class="bs-month-tot"><b>${money(total)}</b></span>
          <span class="bs-act bs-month-go">open <span aria-hidden="true">▸</span></span>
        </summary>
        <div class="bs-shead bs-exhead">
          <span>Date</span><span>What</span><span>Category</span><span>Who paid</span>
          <span class="r">Amount</span><span></span><span></span>
        </div>
        <div class="bs-srows exps">${items}</div>
      </details>`;
  }).join('');

  const usedCats = [...new Set(rows.map((r) => r.category || 'Other'))];
  const toolbar = `
    <div class="bs-tools">
      <div class="bs-isearch">${icon('search')}
        <input id="xsearch" type="search" placeholder="What, where, who paid, amount…" autocomplete="off"></div>
      <div class="bs-quick">
        <button class="fchip on" data-f="all" data-v="">All <b>${rows.length}</b></button>
        <button class="fchip" data-f="owed" data-v="1"><i class="bs-pip unpaid"></i>Owed back</button>
        <button class="fchip" data-f="owed" data-v="0"><i class="bs-pip paid"></i>Settled</button>
      </div>
      <details class="fsheet" id="expfilter">
        <summary class="fs-btn">Sort &amp; filter <span class="fs-caret">▾</span></summary>
        <div class="fs-body">
          <div class="fs-scrim" aria-hidden="true"></div>
          <div class="fs-panel">
            <div class="fs-h">Year</div>
            <div class="fs-opts">
              ${years.length ? years.map((y) => `<a class="fs-o${y === year ? ' on' : ''}" href="/c/expenses?y=${y}">${y}</a>`).join('')
                : `<span class="fs-o on">${esc(year)}</span>`}
            </div>
            <div class="fs-h">Sort</div>
            <select id="xsort" class="bs-sel">
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="amt-desc">Amount, high to low</option>
              <option value="amt-asc">Amount, low to high</option>
              <option value="who">Who paid, A–Z</option>
            </select>
            ${usedCats.length ? `<div class="fs-h">Category</div>
            <div class="fs-opts">
              ${usedCats.map((c) => `<button class="fs-o fchip" type="button" data-f="cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}
            </div>` : ''}
          </div>
        </div>
      </details>
    </div>`;

  const body = rows.length ? monthBlocks : (all.length
    ? `<div class="bs-blank"><b>Nothing in ${esc(year)}</b><span>Pick another year in Sort &amp; filter.</span></div>`
    : `<div class="bs-hero">
        <div class="bs-hero-k">Nothing logged yet</div>
        <h2 class="bs-hero-t">The Costco run, a bag of ice, a part from the hardware shop.</h2>
        <p class="bs-hero-s">${canWrite()
          ? 'Everything bought without an invoice behind it. Log it with a photo of the receipt and who paid, and the money somebody is owed stops being something they have to remember to ask for.'
          : 'Once the owner logs expenses, they show up here.'}</p>
        ${canWrite() ? `<button class="bs-btn" type="button" onclick="capQuick()">Log the first expense</button>
          <button class="bs-btn-sm" type="button" onclick="capOpen()">Scan a receipt</button>` : ''}
      </div>`);

  const headline = all.length
    ? `Expenses — ${brief(yearSpend)} in ${esc(year)}${owedTotal
        ? `, <span class="warn">${brief(owedTotal)} owed back</span>.` : ', nobody out of pocket.'}`
    : 'Expenses — nothing logged yet.';

  res.send(layout('Expenses', `
    ${flash(req)}
    <div class="bs-page">
      <div class="bs-head">
        <div class="bs-headwrap">
          <h1 class="bs-headline">${headline}</h1>
          <p class="bs-subline">Anything bought outside an invoice. Bills from a vendor belong on
            <a class="bs-act" href="/c/invoices">Invoices</a>.</p>
        </div>
        ${canWrite() ? `<button class="bs-btn-sm" type="button" onclick="capOpen()">Scan a receipt</button>
          <button class="bs-btn" type="button" onclick="capQuick()">Log an expense</button>` : ''}
      </div>
      ${all.length ? strip : ''}
      ${all.length ? toolbar : ''}
      ${body}
      <div class="bs-blank" id="xnone" style="display:none"><b>Nothing matches</b><span>Try a different search or filter.</span></div>
    </div>
    ${canWrite() ? captureOverlay(['expense'], { today }) + quickExpense(today) : ''}
    <script>
      (function () {
        var q = '', mode = 'all', val = '';
        function pass(el) {
          if (mode === 'owed' && el.getAttribute('data-owed') !== val) return false;
          if (mode === 'cat' && el.getAttribute('data-cat') !== val) return false;
          if (q && el.getAttribute('data-search').indexOf(q) === -1) return false;
          return true;
        }
        function apply() {
          var shown = 0;
          document.querySelectorAll('[data-month]').forEach(function (g) {
            var n = 0;
            g.querySelectorAll('[data-exp]').forEach(function (el) {
              var ok = pass(el); el.style.display = ok ? '' : 'none'; if (ok) { n++; shown++; }
            });
            g.style.display = n ? '' : 'none';
            if (n && (q || mode !== 'all')) g.open = true;
          });
          var none = document.getElementById('xnone');
          if (none) none.style.display = shown ? 'none' : '';
        }
        function sortNow(how) {
          document.querySelectorAll('[data-month] .exps').forEach(function (box) {
            var items = [].slice.call(box.querySelectorAll('[data-exp]'));
            items.sort(function (a, b) {
              var A = function (k) { return a.getAttribute(k) || ''; }, B = function (k) { return b.getAttribute(k) || ''; };
              switch (how) {
                case 'date-asc': return A('data-date').localeCompare(B('data-date'));
                case 'amt-desc': return parseFloat(B('data-amt')) - parseFloat(A('data-amt'));
                case 'amt-asc': return parseFloat(A('data-amt')) - parseFloat(B('data-amt'));
                case 'who': return A('data-who').localeCompare(B('data-who'));
                default: return B('data-date').localeCompare(A('data-date'));
              }
            });
            items.forEach(function (el) { box.appendChild(el); });
          });
        }
        var si = document.getElementById('xsearch');
        if (si) si.addEventListener('input', function () { q = this.value.toLowerCase(); apply(); });
        var so = document.getElementById('xsort');
        if (so) so.addEventListener('change', function () { sortNow(this.value); });
        document.querySelectorAll('.fchip').forEach(function (b) {
          b.addEventListener('click', function () {
            document.querySelectorAll('.fchip').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            mode = b.getAttribute('data-f'); val = b.getAttribute('data-v'); apply();
          });
        });
      })();
    </script>
    ${canWrite() ? captureScript(['expense']) + quickExpenseScript() : ''}`));
});

/**
 * Paid back, or not after all.
 *
 * A date rather than a flag: "when" answers questions a yes cannot, and the
 * settle-up conversation is always about a week, not a boolean.
 */
app.post('/c/expenses/:id/reimburse', (req, res) => {
  if (!canWrite()) return res.status(403).end();
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM m_expenses WHERE id = ?').get(id);
  if (!row) return res.status(404).end();
  const undo = req.body.undo === '1';
  db.prepare('UPDATE m_expenses SET reimbursed_on = ? WHERE id = ?')
    .run(undo ? null : isoDate(startOfToday()), id);
  res.redirect('/c/expenses?msg=' + encodeURIComponent(undo ? 'Marked as still owed.' : 'Marked paid back.'));
});



app.get('/c/invoices', (req, res) => {
  const all = invQ.all.all();
  const vendors = invQ.vendors.all();
  const vName = new Map(vendors.map((v) => [Number(v.id), v.name]));
  const today = isoDate(startOfToday());
  const thisMonth = today.slice(0, 7);

  // Years present in the data, newest first. One year is loaded at a time:
  // a restaurant with several years of history would otherwise ship every
  // invoice it has ever had into one page of HTML.
  const years = [...new Set(all.map((r) => (r.invoice_date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const year = years.includes(req.query.y) ? req.query.y : (years[0] || today.slice(0, 4));
  const rows = all.filter((r) => (r.invoice_date || '').slice(0, 4) === year);

  // KPIs stay whole-history where that's the useful reading, and year-scoped
  // where it isn't — "spend this month" means nothing scoped to 2024.
  const spendMonth = all.filter((r) => (r.invoice_date || '').slice(0, 7) === thisMonth)
    .reduce((a, r) => a + (r.amount_cents || 0), 0);
  const stAll = all.map((r) => ({ r, s: invStatus(r) }));
  const unpaid = stAll.filter((x) => x.s.key !== 'paid');
  const overdue = stAll.filter((x) => x.s.key === 'overdue');
  const yearSpend = rows.reduce((a, r) => a + (r.amount_cents || 0), 0);

  // Four figures on one ruled band, the way Sales and Shifts read. The tinted
  // icon cards said "dashboard"; this page is a ledger and should look like
  // one. Colour is meaning here and nothing else: outstanding money is amber
  // only while it is outstanding, overdue is red only while something is.
  const brief = (cents) => (Math.abs(cents) >= 100000
    ? '$' + Math.round(cents / 100).toLocaleString('en-US') : money(cents));
  const statCell = (label, value, sub, tone) =>
    `<div class="bs-strip-c"><span class="bs-strip-l">${label}</span><span class="bs-stat${tone ? ' ' + tone : ''}">${value}</span><span class="bs-strip-s">${sub}</span></div>`;

  const outstanding = unpaid.reduce((a, x) => a + (x.r.amount_cents || 0), 0);
  const strip = `<section class="bs-panel bs-strip">
    ${statCell('Spend this month', brief(spendMonth), MONTH_NAMES[Number(thisMonth.slice(5, 7)) - 1] + ' ' + thisMonth.slice(0, 4))}
    ${statCell('Outstanding', brief(outstanding), unpaid.length ? `${unpaid.length} unpaid` : 'All settled', outstanding ? 'warn' : 'ok')}
    ${statCell('Overdue', String(overdue.length), overdue.length ? esc(vName.get(Number(overdue[0].r.vendor_id)) || 'Unknown vendor') : 'Nothing past due', overdue.length ? 'bad' : 'ok')}
    ${statCell(`Spend in ${esc(year)}`, brief(yearSpend), `${rows.length} invoice${rows.length === 1 ? '' : 's'}`)}
  </section>`;

  // Two invoices that would have stopped each other at the door. Grouped
  // rather than compared pairwise so a third copy joins the same pile, and
  // keyed exactly the way the save-time check is keyed — a chip that found a
  // different set of duplicates than the gate blocks would be its own bug.
  const dupKeys = new Map();
  for (const r of rows) {
    const v = Number(r.vendor_id || 0);
    const n = normNum(r.invoice_number);
    const key = n ? `n:${v}:${n}`
      : (r.invoice_date && r.amount_cents) ? `d:${v}:${r.invoice_date}:${r.amount_cents}` : null;
    if (!key) continue;
    if (!dupKeys.has(key)) dupKeys.set(key, []);
    dupKeys.get(key).push(r.id);
  }
  const dupIds = new Set([...dupKeys.values()].filter((g) => g.length > 1).flat());

  // --- month groups -------------------------------------------------------
  const byMonth = new Map();
  for (const r of rows) {
    const m = (r.invoice_date || '').slice(0, 7) || 'undated';
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  const months = [...byMonth.keys()].sort().reverse();

  const monthBlocks = months.map((m, idx) => {
    const list = byMonth.get(m).slice().sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || '') || b.id - a.id);
    const sts = list.map((r) => invStatus(r));
    const paid = sts.filter((s) => s.key === 'paid').length;
    const over = sts.filter((s) => s.key === 'overdue').length;
    const out = list.length - paid;
    const total = list.reduce((a, r) => a + (r.amount_cents || 0), 0);
    const label = m === 'undated' ? 'No date' : `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

    const items = list.map((r) => {
      const s = invStatus(r);
      const c = invCat(r.category || 'Other');
      const ai = aiBadge(r);
      const vn = vName.get(Number(r.vendor_id)) || 'Unknown vendor';
      const isImg = r.file && /\.(jpe?g|png|webp|gif|heic)$/i.test(r.file);
      const search = [vn, r.invoice_number, r.category, r.notes, ((r.amount_cents || 0) / 100).toFixed(2)]
        .filter(Boolean).join(' ').toLowerCase();
      const rev = needsProductReview(r);
      return `
      <details class="bs-srow bs-invrow" data-inv data-id="${r.id}" data-status="${s.key}" data-cat="${esc(r.category || 'Other')}"
        data-vendor="${esc(String(r.vendor_id || ''))}" data-amt="${(r.amount_cents || 0) / 100}"
        data-date="${esc(r.invoice_date || '')}" data-due="${esc(r.due_date || '')}"
        data-vname="${esc(vn.toLowerCase())}" data-added="${esc(String(r.created_at || ''))}"
        data-search="${esc(search)}" data-review="${rev ? '1' : '0'}" data-dupe="${dupIds.has(r.id) ? '1' : '0'}"
        style="--c:${c.color}">
        <summary class="bs-sr bs-ir">
          <span class="bs-ir-v"><i class="bs-catdot"></i>${esc(vn)}${r.invoice_number ? `<u>${esc(r.invoice_number)}</u>` : ''}</span>
          <span class="bs-ir-c">${esc(r.category || 'Other')}</span>
          ${/* invStatus carries both a key and a class; the key is the one with
                 the four values worth colouring. Two tags fit here and the row
                 then stands two lines tall, which breaks the rhythm the ledger
                 is for — so only the actionable one rides along, and the AI's
                 own confidence stays in the panel where it can be read. */''}
          <span class="bs-ir-t ${s.key}"><i class="bs-pip ${s.key}"></i>${esc(s.label)}${
            rev ? '<i class="bs-tag rev">review</i>' : ''}</span>
          <span class="bs-ir-d">${esc(niceDate(r.invoice_date))}</span>
          <span class="bs-sr-f">${money(r.amount_cents || 0)}</span>
          <span class="bs-sr-e">Open</span>
        </summary>
        <div class="inv-lazy"><div class="bs-loading">Loading…</div></div>
      </details>`;
    }).join('');

    // Only the newest month opens by default — an accountant scrolling 2024
    // wants the headline figures, not 60 rows they have to scroll past.
    return `
      <details class="bs-month" data-month${idx === 0 ? ' open' : ''}>
        <summary class="bs-month-h">
          <span class="bs-kicker">${esc(label)}</span>
          <span class="bs-month-meta">${list.length} invoice${list.length === 1 ? '' : 's'}
            ${over ? `· <b class="warn">${over} overdue</b>` : out ? `· <b>${out} outstanding</b>` : '· <b class="ok">all paid</b>'}</span>
          <span class="bs-month-tot"><b>${money(total)}</b></span>
          <span class="bs-act bs-month-go">open <span aria-hidden="true">▸</span></span>
        </summary>
        <div class="bs-shead bs-invhead">
          <span>Vendor</span><span>Category</span><span>Status</span><span>Date</span>
          <span class="r">Amount</span><span></span>
        </div>
        <div class="bs-srows invs">${items}</div>
      </details>`;
  }).join('');

  // Read but not yet imported — the queue an operator actually works through.
  const needsReview = rows.filter(needsProductReview).length;
  const usedCats = [...new Set(rows.map((r) => r.category || 'Other'))];
  const usedVendors = vendors.filter((v) => rows.some((r) => Number(r.vendor_id) === Number(v.id)));

  // Search and the four quick verdicts stay on the page — those are the ones
  // reached constantly. Everything that narrows further goes in the sheet, the
  // same disclosure Sales uses: eleven controls in a row was a control panel,
  // and a control panel is what you build when you cannot decide what matters.
  // Every id and data- hook is unchanged, so the filtering script never learns
  // the furniture moved.
  const toolbar = `
    <div class="bs-tools">
      <div class="bs-isearch">${icon('search')}
        <input id="isearch" type="search" placeholder="Vendor, invoice #, notes, amount…" autocomplete="off"></div>
      <div class="bs-quick">
        <button class="fchip on" data-f="all" data-v="">All <b>${rows.length}</b></button>
        <button class="fchip" data-f="status" data-v="unpaid"><i class="bs-pip unpaid"></i>Unpaid</button>
        <button class="fchip" data-f="status" data-v="overdue"><i class="bs-pip overdue"></i>Overdue</button>
        <button class="fchip" data-f="status" data-v="paid"><i class="bs-pip paid"></i>Paid</button>
        ${needsReview ? `<button class="fchip" data-f="review" data-v="1"><i class="bs-pip rev"></i>To review <b>${needsReview}</b></button>` : ''}
        ${dupIds.size ? `<button class="fchip" data-f="dupe" data-v="1"><i class="bs-pip dupe"></i>Possible duplicates <b>${dupIds.size}</b></button>` : ''}
      </div>
      <details class="fsheet" id="invfilter">
        <summary class="fs-btn">Sort &amp; filter <span class="fs-caret">▾</span></summary>
        <div class="fs-body">
          <div class="fs-scrim" aria-hidden="true"></div>
          <div class="fs-panel">
            <div class="fs-h">Year</div>
            <div class="fs-opts">
              ${years.length ? years.map((y) => `<a class="fs-o${y === year ? ' on' : ''}" href="/c/invoices?y=${y}">${y}</a>`).join('')
                : `<span class="fs-o on">${esc(year)}</span>`}
            </div>
            <div class="fs-h">Sort</div>
            <select id="isort" class="bs-sel">
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="amt-desc">Amount, high to low</option>
              <option value="amt-asc">Amount, low to high</option>
              <option value="vendor">Vendor A–Z</option>
              <option value="due">Due date</option>
              <option value="added">Recently uploaded</option>
            </select>
            <div class="fs-h">Vendor</div>
            <select id="ivendor" class="bs-sel">
              <option value="">All vendors</option>
              ${usedVendors.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}
            </select>
            <div class="fs-h">Amount</div>
            <select id="iamt" class="bs-sel">
              <option value="">Any amount</option>
              <option value="0-100">Under $100</option>
              <option value="100-500">$100 – $500</option>
              <option value="500-1000">$500 – $1,000</option>
              <option value="1000-999999">Over $1,000</option>
            </select>
            ${usedCats.length ? `<div class="fs-h">Category</div>
            <div class="fs-opts">
              ${usedCats.map((c) => `<button class="fs-o fchip" type="button" data-f="cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}
            </div>` : ''}
          </div>
        </div>
      </details>
    </div>`;

  const body = rows.length ? monthBlocks : (all.length
    ? `<div class="bs-blank"><b>No invoices in ${esc(year)}</b><span>Pick another year in Sort &amp; filter.</span></div>`
    : `<div class="bs-hero">
        <div class="bs-hero-k">Nothing on file yet</div>
        <h2 class="bs-hero-t">Photograph an invoice and it fills itself in.</h2>
        <p class="bs-hero-s">${canWrite()
          ? 'Vendor, dates, amounts and category are read for you — you only check the numbers. The original stays attached to the record.'
          : 'Once the owner uploads invoices, they show up here.'}</p>
        ${canWrite() ? `<button class="bs-btn" type="button" onclick="capOpen()">Add the first invoice</button>
        <div class="bs-hero-w"><span>Take a photo</span><span>Upload a PDF</span><span>Drag &amp; drop</span></div>` : ''}
      </div>`);

  // The page names itself in the largest thing on it and then says what the
  // year came to — the same shape as "Sales — $X rung".
  const headline = all.length
    ? `Invoices — ${brief(yearSpend)} billed in ${esc(year)}${overdue.length
        ? `, <span class="warn">${overdue.length} overdue</span>.` : unpaid.length
        ? `, ${unpaid.length} still to pay.` : ', all settled.'}`
    : 'Invoices — nothing on file yet.';

  res.send(layout('Invoices', `
    ${flash(req)}
    <div class="bs-page">
      <div class="bs-head">
        <div class="bs-headwrap">
          <h1 class="bs-headline">${headline}</h1>
          <p class="bs-subline">${canWrite()
            ? 'Photograph or drop an invoice and it reads the details for you. What you buy is on <a class="bs-act" href="/c/products">Products</a>.'
            : 'Every invoice on file, with the original attached.'}</p>
        </div>
        ${canWrite() ? `<button class="bs-btn" type="button" onclick="capOpen()">Add invoice</button>` : ''}
      </div>
      ${all.length ? strip : ''}
      ${all.length ? toolbar : ''}
      ${body}
      <div class="bs-blank" id="inone" style="display:none"><b>Nothing matches</b><span>Try a different search or filter.</span></div>
    </div>
    ${canWrite() ? captureOverlay(['invoice', 'expense'], { today }) : ''}
    <script>
      // Filters combine, and sorting reorders within each month rather than
      // flattening the grouping — the month totals are the point of the page.
      (function () {
        var q = '', mode = 'all', val = '', vendor = '', amt = '';
        function pass(el) {
          if (mode === 'status' && el.getAttribute('data-status') !== val) return false;
          if (mode === 'cat' && el.getAttribute('data-cat') !== val) return false;
          if (mode === 'review' && el.getAttribute('data-review') !== val) return false;
          if (mode === 'dupe' && el.getAttribute('data-dupe') !== val) return false;
          if (vendor && el.getAttribute('data-vendor') !== vendor) return false;
          if (amt) {
            var a = parseFloat(el.getAttribute('data-amt')) || 0, p = amt.split('-');
            if (a < parseFloat(p[0]) || a > parseFloat(p[1])) return false;
          }
          if (q && el.getAttribute('data-search').indexOf(q) === -1) return false;
          return true;
        }
        function apply() {
          var shown = 0;
          document.querySelectorAll('[data-month]').forEach(function (g) {
            var n = 0;
            g.querySelectorAll('[data-inv]').forEach(function (el) {
              var ok = pass(el); el.style.display = ok ? '' : 'none'; if (ok) { n++; shown++; }
            });
            g.style.display = n ? '' : 'none';
            // Anything narrowed down is worth showing straight away.
            if (n && (q || mode !== 'all' || vendor || amt)) g.open = true;
          });
          var none = document.getElementById('inone');
          if (none) none.style.display = shown ? 'none' : '';
        }
        function sortNow(how) {
          document.querySelectorAll('[data-month] .invs').forEach(function (box) {
            var items = [].slice.call(box.querySelectorAll('[data-inv]'));
            items.sort(function (a, b) {
              var A = function (k) { return a.getAttribute(k) || ''; }, B = function (k) { return b.getAttribute(k) || ''; };
              switch (how) {
                case 'date-asc': return A('data-date').localeCompare(B('data-date'));
                case 'amt-desc': return parseFloat(B('data-amt')) - parseFloat(A('data-amt'));
                case 'amt-asc': return parseFloat(A('data-amt')) - parseFloat(B('data-amt'));
                case 'vendor': return A('data-vname').localeCompare(B('data-vname'));
                case 'due': return (A('data-due') || '9999').localeCompare(B('data-due') || '9999');
                case 'added': return B('data-added').localeCompare(A('data-added'));
                default: return B('data-date').localeCompare(A('data-date'));
              }
            });
            items.forEach(function (el) { box.appendChild(el); });
          });
        }
        var si = document.getElementById('isearch');
        if (si) si.addEventListener('input', function () { q = this.value.toLowerCase(); apply(); });
        var sv = document.getElementById('ivendor');
        if (sv) sv.addEventListener('change', function () { vendor = this.value; apply(); });
        var sa = document.getElementById('iamt');
        if (sa) sa.addEventListener('change', function () { amt = this.value; apply(); });
        var so = document.getElementById('isort');
        if (so) so.addEventListener('change', function () { sortNow(this.value); });
        document.querySelectorAll('.fchip').forEach(function (b) {
          b.addEventListener('click', function () {
            document.querySelectorAll('.fchip').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            mode = b.getAttribute('data-f'); val = b.getAttribute('data-v'); apply();
          });
        });
      })();
      // Detail is fetched the first time a row opens, then kept.
      document.addEventListener('toggle', function (e) {
        var el = e.target;
        if (!el.matches || !el.matches('[data-inv]') || !el.open) return;
        var box = el.querySelector('.inv-lazy');
        if (!box || box.dataset.loaded) return;
        box.dataset.loaded = '1';
        fetch('/c/invoices/' + el.getAttribute('data-id') + '/panel')
          .then(function (r) { return r.text(); })
          .then(function (h) { box.outerHTML = h; })
          .catch(function () { box.innerHTML = '<div class="panel-empty">Could not load that invoice.</div>'; });
      }, true);
    </script>
    ${canWrite() ? captureScript(['invoice', 'expense']) : ''}`));
});

const INV_CATS = Object.keys(INV_CATEGORIES);
// How an invoice was paid. Accounting detail, not inventory — it lives on the
// invoice and nowhere near Products.
const PAY_METHODS = ['Cash', 'Check', 'ACH', 'Credit card', 'Auto pay', 'Other'];



// The AI step: returns JSON for the drawer to fill in. Kept separate from the
// save so a failed read never costs you the upload.
const INV_UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const invoiceUpload = multer({
  storage: multer.diskStorage({
    destination: INV_UPLOAD_DIR,
    filename: (rq, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/c/invoices/read', scanUpload.array('scan', 8), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.json({ error: 'No file received.' });
    const data = await readInvoice(req.files);
    const match = matchVendor(data.vendor_name);
    // The line items are matched here, before anything is saved, purely so the
    // drawer can say what it found. Counting is free and it's the difference
    // between trusting the read and hoping.
    const preview = reviewRows(data.line_items || [], prodQ.plain.all(), match ? match.id : null);
    const tally = {
      lines: preview.length,
      matched: preview.filter((r) => r.confidence === 'high').length,
      asks: preview.filter((r) => r.confidence === 'medium').length,
      fresh: preview.filter((r) => r.confidence === 'low' && !r.fee).length,
      fees: preview.filter((r) => r.fee).length,
    };
    res.json({
      ...data,
      vendor_id: match ? match.id : null,
      matched_vendor: match ? match.name : null,
      tally,
    });
  } catch (e) {
    res.json({ error: e.message || 'Could not read that invoice.' });
  }
});

/**
 * Every page of a scan, as links.
 *
 * One page renders as it always did — Open / Download — so nothing changes for
 * the ordinary case. More than one and it says how many there are and offers
 * each, because "Open original" on an eight-page lease that silently opens
 * page one is worse than no link at all.
 */
function pageLinks(row, label = 'Open original') {
  const pages = pagesOf(row);
  if (!pages.length) return '';
  if (pages.length === 1) {
    return `<a class="bs-act" href="/uploads/${esc(pages[0])}" target="_blank">${label} →</a>
            <a class="bs-act" href="/uploads/${esc(pages[0])}" download>Download</a>`;
  }
  return `<span class="bs-pages"><span class="bs-pages-l">${pages.length} pages</span>${
    pages.map((f, i) => `<a class="bs-act" href="/uploads/${esc(f)}" target="_blank">${i + 1}</a>`).join('')
  }</span>`;
}

/**
 * An invoice already on file that this one may be a second copy of.
 *
 * Two signals, and the difference between them matters. A vendor's own invoice
 * number is unique by definition — the same number from the same vendor twice
 * is the same piece of paper, not a coincidence. Without a number, the same
 * vendor billing the same amount on the same day is very probably one delivery
 * entered twice, but it is not certain: two identical small deliveries in a day
 * do happen. So one says "this is", the other says "this looks like", and
 * neither refuses the save.
 *
 * Deliberately not matched on the file: two photographs of the same invoice are
 * different bytes, and the same PDF re-saved is different bytes again. It would
 * miss the case that actually happens.
 */
const normNum = (v) => String(v || '').trim().toLowerCase().replace(/[\s._\/-]/g, '');
function duplicateInvoice({ vendorId, number, date, amountCents, exceptId }) {
  const rows = db.prepare('SELECT * FROM m_invoices').all()
    .filter((r) => Number(r.id) !== Number(exceptId));
  const v = vendorId ? Number(vendorId) : null;
  const n = normNum(number);
  if (n) {
    const hit = rows.find((r) => normNum(r.invoice_number) === n
      && Number(r.vendor_id || 0) === Number(v || 0));
    if (hit) return { row: hit, certain: true, why: `invoice number ${String(number).trim()}` };
  }
  if (date && amountCents) {
    const hit = rows.find((r) => r.invoice_date === date
      && Number(r.amount_cents) === Number(amountCents)
      && Number(r.vendor_id || 0) === Number(v || 0));
    if (hit) return { row: hit, certain: false, why: 'the same vendor, day and total' };
  }
  return null;
}

/**
 * Delete an invoice — and the purchases it put into your product history.
 *
 * The generic delete removes the row and nothing else. For most collections
 * that is the whole story; for an invoice it is not. Importing its lines wrote
 * purchase records, and those are what every product's last-paid price, average
 * and trend are built from. Deleting only the invoice would leave them behind,
 * still counting, pointing at an invoice that no longer exists — and the
 * duplicate you deleted would go on inflating what you appear to spend.
 *
 * The uploaded file stays on disk. It is the only copy of the original, there
 * is no backup, and unlinking it is the one step here that cannot be undone.
 */
app.post('/c/invoices/:id/delete', (req, res) => {
  if (!canWrite()) return res.status(403).end();
  const id = Number(req.params.id);
  const inv = invQ.one.get(id);
  if (!inv) return res.status(404).end();

  const bought = prodQ.purchasesForInvoice.all(id);
  const touched = [...new Set(bought.map((b) => Number(b.product_id)))];
  db.transaction(() => {
    prodQ.clearInvoice.run(id);
    db.prepare('DELETE FROM m_invoices WHERE id = ?').run(id);
  })();
  // Every dish built on those products is now costed from one fewer purchase.
  if (touched.length) {
    try { MENU.recalcForProducts(touched, 'invoice'); }
    catch (e) { console.error('[menu] recalc after invoice delete failed:', e.message); }
  }
  res.redirect('/c/invoices?msg=' + encodeURIComponent(
    `Invoice deleted${bought.length ? `, and ${bought.length} purchase${bought.length === 1 ? '' : 's'} removed from your product history` : ''}.`));
});

app.post('/c/invoices', invoiceUpload.array('file', 12), (req, res) => {
  const total = toCents(req.body.amount);
  if (!total) return res.redirect('/c/invoices?err=1&msg=' + encodeURIComponent('An invoice needs a total.'));

  // The file multer has already written. Carried by name through the duplicate
  // question below so answering it does not mean picking the file again —
  // sanitised to a bare filename because it comes back from a form, and a
  // path is not a filename.
  const shot = (req.files || []).map((f) => f.filename);
  const safe = (v) => (String(v || '').match(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) || [null])[0];
  // Kept through the duplicate question below by name. Both of them: answering
  // it must not quietly reduce a four-page invoice to its first page.
  const keptPages = String(req.body.kept_pages || '').split(',').map(safe).filter(Boolean);
  const pages = shot.length ? shot : keptPages;
  const uploaded = pages[0] || null;

  // The capture overlay types the vendor rather than picking an id — a name
  // read off the paper is what it has, and asking somebody to find it in a
  // menu is asking them to do the matching by hand. Resolve it here: the same
  // fuzzy match the reader's preview uses, and a new vendor if it is genuinely
  // new, because an invoice filed against nobody drops out of vendor totals,
  // out of the duplicate check, and out of alias matching on its own products.
  let vendorId = req.body.vendor_id ? Number(req.body.vendor_id) : null;
  const typedVendor = String(req.body.vendor_name || '').trim();
  if (!vendorId && typedVendor) {
    const hit = matchVendor(typedVendor);
    vendorId = hit ? Number(hit.id) : Number(invQ.addVendor.run(typedVendor.slice(0, 80)).lastInsertRowid);
  }

  const invDate = String(req.body.invoice_date || '').slice(0, 10) || null;
  const dup = req.body.dup_ok === '1' ? null : duplicateInvoice({
    vendorId, number: req.body.invoice_number,
    date: invDate, amountCents: total,
  });
  if (dup) {
    // Asked, not refused. The reason this is a question is that the answer is
    // sometimes yes: a vendor really can bill the same amount on the same day
    // twice, and a flat block would leave no way to file the second one.
    const keep = Object.entries({
      amount: req.body.amount, subtotal: req.body.subtotal, tax: req.body.tax,
      invoice_date: req.body.invoice_date, due_date: req.body.due_date,
      vendor_id: vendorId || '', invoice_number: req.body.invoice_number,
      category: req.body.category, status: req.body.status,
      payment_method: req.body.payment_method, notes: req.body.notes,
      ai_status: req.body.ai_status, ai_confidence: req.body.ai_confidence,
      ai_snapshot: req.body.ai_snapshot, ai_lines: req.body.ai_lines,
      kept_pages: pages.join(','),
    }).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(String(v == null ? '' : v))}">`).join('');
    const vn = dup.row.vendor_id
      ? (invQ.vendors.all().find((v) => Number(v.id) === Number(dup.row.vendor_id)) || {}).name : null;
    return res.send(layout('Already have this one?', `
      <div class="bs-page">
        <div class="bs-head"><div class="bs-headwrap">
          <a class="bs-act" href="/c/invoices">← Invoices</a>
          <h1 class="bs-headline">${dup.certain ? 'You already have this invoice.' : 'This looks like one you already have.'}</h1>
          <p class="bs-subline">Matched on ${esc(dup.why)}. ${dup.certain
            ? 'An invoice number is unique to the vendor, so this is almost certainly the same piece of paper twice.'
            : 'Not certain — a vendor can bill the same amount twice in a day. Worth a look before you file it.'}</p>
        </div></div>
        <section class="bs-panel bs-dupcmp">
          <div class="bs-dupc">
            <div class="bs-kicker">Already filed</div>
            <b>${esc(vn || 'No vendor')}${dup.row.invoice_number ? ' · ' + esc(dup.row.invoice_number) : ''}</b>
            <span>${esc(niceDate(dup.row.invoice_date))} · ${money(dup.row.amount_cents || 0)} · ${esc(dup.row.status || '')}</span>
            <a class="bs-act" href="/c/invoices#inv-${dup.row.id}">Open the one you have →</a>
          </div>
          <div class="bs-dupc new">
            <div class="bs-kicker">Trying to save</div>
            <b>${esc(req.body.invoice_number || 'No number')}</b>
            <span>${esc(niceDate(invDate))} · ${money(total)}</span>
            ${uploaded ? '<span class="bs-em">the file you just uploaded is kept either way</span>' : ''}
          </div>
        </section>
        <form method="post" action="/c/invoices" class="bs-dupacts">
          ${keep}<input type="hidden" name="dup_ok" value="1">
          <a class="bs-btn-sm" href="/c/invoices">Don't save it</a>
          <button class="bs-btn" type="submit">Save it anyway</button>
        </form>
      </div>`));
  }

  // Read-and-kept and read-then-corrected are different states: the first still
  // wants a glance, the second has already had one.
  let aiStatus = req.body.ai_status === 'ai' ? 'ai' : 'manual';
  if (aiStatus === 'ai') {
    const now = [req.body.amount, req.body.subtotal, req.body.tax, req.body.vendor_id || '', req.body.category || ''].join('|');
    const wasNums = String(req.body.ai_snapshot || '').split('|');
    const nowNums = now.split('|');
    const changed = nowNums.some((v, i) => {
      const a = parseFloat(v), b = parseFloat(wasNums[i]);
      return (Number.isFinite(a) && Number.isFinite(b)) ? Math.abs(a - b) > 0.005 : String(v) !== String(wasNums[i] || '');
    });
    if (changed) aiStatus = 'ai_edited';
  }

  // The reader's line items ride along in a hidden field. Parsed and re-
  // serialised rather than trusted through: it arrives as a string from a form
  // post, and anything that isn't a well-formed array of lines is worth
  // dropping quietly rather than storing for the import screen to trip over.
  let lineJson = null, lineCount = 0;
  try {
    const parsed = JSON.parse(req.body.ai_lines || '[]');
    const clean = (Array.isArray(parsed) ? parsed : [])
      .filter((l) => l && String(l.description || '').trim())
      .slice(0, 200)
      .map((l) => ({
        description: String(l.description).trim().slice(0, 200),
        // Carried through, not dropped: the item code is the single strongest
        // signal for recognising this product on the next invoice, and brand
        // and pack size are what keep a 1 L bottle apart from a 4/3 L case.
        // Leaving them out here quietly reduced matching to name-only for
        // every invoice that actually went through the upload flow.
        code: String(l.code || '').trim().slice(0, 60),
        brand: String(l.brand || '').trim().slice(0, 60),
        pack_size: String(l.pack_size || '').trim().slice(0, 40),
        qty: Number(l.qty) || 0, unit: String(l.unit || '').trim().slice(0, 20),
        unit_price: Number(l.unit_price) || 0, total: Number(l.total) || 0,
      }));
    lineCount = clean.length;
    if (lineCount) lineJson = JSON.stringify(clean);
  } catch { /* not readable as lines — the invoice still saves */ }

  invQ.add.run({
    invoice_date: String(req.body.invoice_date || '').slice(0, 10) || null,
    due_date: String(req.body.due_date || '').slice(0, 10) || null,
    vendor_id: vendorId ? String(vendorId) : null,
    invoice_number: String(req.body.invoice_number || '').trim() || null,
    amount_cents: total,
    subtotal_cents: toCents(req.body.subtotal),
    tax_cents: toCents(req.body.tax),
    category: INV_CATS.includes(req.body.category) ? req.body.category : 'Other',
    status: req.body.status === 'Paid' ? 'Paid' : 'Unpaid',
    payment_method: PAY_METHODS.includes(req.body.payment_method) ? req.body.payment_method : null,
    file: uploaded,
    // The first page is `file`, as it always was. Every page is here beside it.
    pages: pages.length > 1 ? JSON.stringify(pages) : null,
    notes: String(req.body.notes || '').trim() || null,
    ai_status: aiStatus,
    ai_confidence: String(req.body.ai_confidence || '').trim() || null,
    ai_lines: lineJson,
  });
  const saved = db.prepare('SELECT id FROM m_invoices ORDER BY id DESC LIMIT 1').get();
  if (!lineCount || !saved) return res.redirect('/c/invoices?msg=' + encodeURIComponent('Invoice saved.'));

  // Anything the matcher is sure of goes straight in. Hundreds of historical
  // invoices is hundreds of review screens otherwise, and a high-confidence
  // match is one the vendor's own item code or an exact name-plus-pack-plus-
  // unit agreement produced — not a guess worth stopping a person for. What's
  // left is only what genuinely needs a decision, and the whole import can be
  // undone in one click if the read was wrong.
  const auto = autoImport(saved.id);
  const left = auto.pending;
  const done = `${auto.added} product${auto.added === 1 ? '' : 's'} imported`;
  if (left) {
    return res.redirect(`/c/invoices/${saved.id}/import?msg=` + encodeURIComponent(
      `Invoice saved${auto.added ? `, ${done}` : ''}. ${left} line${left === 1 ? '' : 's'} need${left === 1 ? 's' : ''} a decision.`));
  }
  res.redirect('/c/invoices?msg=' + encodeURIComponent(
    auto.added ? `Invoice saved and ${done} automatically.` : 'Invoice saved.'));
});

app.post('/c/invoices/:id/status', (req, res) => {
  db.prepare('UPDATE m_invoices SET status = ? WHERE id = ?')
    .run(req.body.status === 'Paid' ? 'Paid' : 'Unpaid', Number(req.params.id));
  res.redirect('/c/invoices?msg=' + encodeURIComponent(`Marked ${req.body.status === 'Paid' ? 'paid' : 'unpaid'}.`));
});


// ---------------------------------------------------------------------------
// VENDORS — the directory everything else points at. Invoices match against it,
// and purchase orders, deliveries and contracts will hang off the same record,
// so the profile is built in sections that take another one without a redesign.
// ---------------------------------------------------------------------------
const VEND_CATEGORIES = {
  'Produce':     { color: '#059669', tint: '#ecfdf5', icon: 'par' },
  'Meat':        { color: '#dc2626', tint: '#fef2f2', icon: 'vendors' },
  'Seafood':     { color: '#0891b2', tint: '#ecfeff', icon: 'vendors' },
  'Dairy':       { color: '#ca8a04', tint: '#fefce8', icon: 'par' },
  'Dry goods':   { color: '#a16207', tint: '#fefce8', icon: 'par' },
  'Coffee':      { color: '#92400e', tint: '#fef3c7', icon: 'tips' },
  'Beverage':    { color: '#7c3aed', tint: '#f5f3ff', icon: 'tips' },
  'Alcohol':     { color: '#9333ea', tint: '#faf5ff', icon: 'tips' },
  'Cleaning':    { color: '#2563eb', tint: '#eff6ff', icon: 'cleaning' },
  'Paper goods': { color: '#64748b', tint: '#f8fafc', icon: 'documents' },
  'Equipment':   { color: '#ea580c', tint: '#fff7ed', icon: 'equipment' },
  'Services':    { color: '#0d9488', tint: '#f0fdfa', icon: 'policy' },
  'Other':       { color: '#64748b', tint: '#f8fafc', icon: 'vendors' },
};
const vendCat = (c) => VEND_CATEGORIES[c] || VEND_CATEGORIES.Other;
const VEND_CATS = Object.keys(VEND_CATEGORIES);
const ORDER_METHODS = ['Rep / text', 'Phone', 'Email', 'Online portal', 'App', 'Standing order'];
const yes = (v) => v === '1' || v === 1 || v === 'yes' || v === 'on';

const vendQ = {
  all: db.prepare('SELECT * FROM m_vendors ORDER BY name'),
  one: db.prepare('SELECT * FROM m_vendors WHERE id = ?'),
  add: db.prepare(`INSERT INTO m_vendors
    (name, category, ordering_method, favorite, inactive, website, account_number,
     login_username, login_hint, rep_name, phone, email, order_notes)
    VALUES (@name, @category, @ordering_method, @favorite, @inactive, @website, @account_number,
            @login_username, @login_hint, @rep_name, @phone, @email, @order_notes)`),
  update: db.prepare(`UPDATE m_vendors SET
    name=@name, category=@category, ordering_method=@ordering_method, favorite=@favorite, inactive=@inactive,
    website=@website, account_number=@account_number, login_username=@login_username, login_hint=@login_hint,
    rep_name=@rep_name, phone=@phone, email=@email, order_notes=@order_notes WHERE id=@id`),
  toggle: db.prepare('UPDATE m_vendors SET favorite = ? WHERE id = ?'),
  setInactive: db.prepare('UPDATE m_vendors SET inactive = ? WHERE id = ?'),
  // Invoice rollups. vendor_id is TEXT in the module schema, so compare as a
  // number — rows written by different paths hold "1" or "1.0".
  stats: db.prepare(`SELECT COUNT(*) n, MAX(invoice_date) last, COALESCE(SUM(amount_cents),0) spend
                     FROM m_invoices WHERE CAST(vendor_id AS INTEGER) = ?`),
  // The same rollup for every vendor at once. The list page asked for it one
  // vendor at a time, which is one query per row — fine at ten vendors, forty
  // queries at forty, and every one of them a full scan of the invoice table
  // before idx_inv_vendor existed. Grouped here so the page costs one read
  // whatever the vendor list grows to.
  allStats: db.prepare(`SELECT CAST(vendor_id AS INTEGER) AS vid, COUNT(*) n,
                          MAX(invoice_date) last, COALESCE(SUM(amount_cents),0) spend
                        FROM m_invoices GROUP BY CAST(vendor_id AS INTEGER)`),
  invoices: db.prepare(`SELECT * FROM m_invoices WHERE CAST(vendor_id AS INTEGER) = ?
                        ORDER BY invoice_date DESC, id DESC LIMIT 12`),
};

const hasContact = (v) => !!(v.phone || v.email || v.rep_name);

app.get('/c/vendors', (req, res) => {
  // One grouped read rather than one per vendor. A vendor with no invoices has
  // no row in the rollup and keeps the zeroes the per-vendor query returned.
  const stats = new Map(vendQ.allStats.all().map((r) => [Number(r.vid), r]));
  const rows = vendQ.all.all().map((v) => {
    const s = stats.get(Number(v.id));
    return { ...v, n: s ? s.n : 0, last: s ? s.last : null, spend: s ? s.spend : 0 };
  });
  const active = rows.filter((v) => !yes(v.inactive));
  const cats = [...new Set(active.map((v) => v.category || 'Other'))];
  const noContact = rows.filter((v) => !yes(v.inactive) && !hasContact(v));
  const recent = rows.filter((v) => v.created_at && Date.now() - new Date(v.created_at + 'Z').getTime() < 30 * 86400000);

  const card = (tone, ico, label, value, sub) => `
    <div class="mcard mcard-${tone}"><div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body"><div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div><div class="mcard-sub">${sub}</div></div></div>`;

  const cards = `<div class="mcards">
    ${card('blue', 'vendors', 'Vendors', String(active.length), rows.length > active.length ? `${rows.length - active.length} no longer used` : 'All in use')}
    ${card('green', 'par', 'Categories', String(cats.length), cats.length ? esc(cats.slice(0, 3).join(', ')) : 'None yet')}
    ${card('amber', 'invoices', 'Invoiced this year', money(rows.reduce((a, v) => a + (v.spend || 0), 0)), `${rows.reduce((a, v) => a + (v.n || 0), 0)} invoices`)}
    ${card(noContact.length ? 'red' : 'green', noContact.length ? 'incidents' : 'contacts', 'Missing contact', String(noContact.length),
      noContact.length ? esc(noContact.slice(0, 2).map((v) => v.name).join(', ')) : 'Everyone reachable')}
  </div>`;

  const toolbar = `<div class="toolbar2">
    <div class="searchbox">${icon('search')}
      <input id="vsearch" type="search" placeholder="Search vendor, rep, category…" autocomplete="off"></div>
    <div class="fchips">
      <button class="fchip on" data-f="all" data-v="" style="--c:var(--ink-2);--ct:var(--surface-3)">All<span class="fcount">${active.length}</span></button>
      <button class="fchip" data-f="fav" data-v="1" style="--c:#ca8a04;--ct:#fefce8"><i class="fdot"></i>Preferred<span class="fcount">${active.filter((v) => yes(v.favorite)).length}</span></button>
      ${cats.map((c) => { const cc = vendCat(c); return `<button class="fchip" data-f="cat" data-v="${esc(c)}" style="--c:${cc.color};--ct:${cc.tint}"><i class="fdot"></i>${esc(c)}<span class="fcount">${active.filter((v) => (v.category || 'Other') === c).length}</span></button>`; }).join('')}
      ${rows.length > active.length ? `<button class="fchip" data-f="off" data-v="1" style="--c:#64748b;--ct:#f1f5f9"><i class="fdot"></i>No longer used<span class="fcount">${rows.length - active.length}</span></button>` : ''}
    </div>
  </div>`;

  const grid = rows.length ? `<div class="vgrid">${rows.map((v) => {
    const c = vendCat(v.category || 'Other');
    const off = yes(v.inactive);
    const search = [v.name, v.category, v.rep_name, v.email, v.phone, v.account_number].filter(Boolean).join(' ').toLowerCase();
    return `
    <article class="vcard${off ? ' vcard-off' : ''}" data-vend data-cat="${esc(v.category || 'Other')}"
      data-fav="${yes(v.favorite) ? '1' : ''}" data-off="${off ? '1' : ''}" data-search="${esc(search)}"
      style="--c:${c.color};--ct:${c.tint}">
      <div class="vcard-top">
        <div class="vcard-ico">${icon(c.icon)}</div>
        <div class="vcard-head">
          <a class="vcard-name" href="/c/vendors/${v.id}">${esc(v.name)}${yes(v.favorite) ? ' <span class="vstar" title="Preferred vendor">★</span>' : ''}</a>
          <div class="vcard-cat">${esc(v.category || 'Other')}${off ? ' · no longer used' : ''}</div>
        </div>
        <form method="post" action="/c/vendors/${v.id}/favorite" style="margin:0">
          <input type="hidden" name="favorite" value="${yes(v.favorite) ? '' : '1'}">
          <button class="vfav${yes(v.favorite) ? ' on' : ''}" type="submit" title="${yes(v.favorite) ? 'Remove from preferred' : 'Mark preferred'}">★</button>
        </form>
      </div>
      <div class="vcard-facts">
        <div class="tfact"><span>Rep</span><b>${v.rep_name ? esc(v.rep_name) : '<i class="unset">None</i>'}</b></div>
        <div class="tfact"><span>Invoices</span><b>${v.n || 0}${v.last ? ` · last ${esc(niceDate(v.last))}` : ''}</b></div>
      </div>
      <div class="vcard-contact">
        ${v.phone ? `<a href="tel:${esc(v.phone)}" title="Call">${icon('contacts')}${esc(v.phone)}</a>` : ''}
        ${v.email ? `<a href="mailto:${esc(v.email)}" title="Email">${icon('email')}Email</a>` : ''}
        ${v.website ? `<a href="${esc(v.website)}" target="_blank" title="Website">${icon('documents')}Site</a>` : ''}
        ${!hasContact(v) ? '<span class="vmissing">No contact details</span>' : ''}
      </div>
    </article>`;
  }).join('')}</div>
  <div class="empty2" id="vnone" style="display:none"><div class="empty2-t">Nothing matches</div><div class="empty2-s">Try a different search or category.</div></div>`
  : `<div class="upload-hero">
      <div class="uh-ico">${icon('vendors')}</div>
      <div class="uh-t">No vendors yet</div>
      <div class="uh-s">Vendors added here show up automatically when you upload an invoice — and later for purchase orders, deliveries and inventory.</div>
      ${canWrite() ? `<button class="btn btn-primary btn-lg" type="button" onclick="vDrawer(true)">＋ Add your first vendor</button>` : ''}
    </div>`;

  res.send(layout('Vendors', `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t"><h1>Vendors</h1>
        <p class="phead-s">Everyone you order from. Invoices match against this list automatically.</p></div>
      ${canWrite() ? `<button class="btn btn-primary" type="button" onclick="vDrawer(true)">＋ Add vendor</button>` : ''}
    </div>
    ${rows.length ? cards + toolbar : ''}
    ${grid}
    ${canWrite() ? vendorDrawer() : ''}
    <script>
      (function () {
        var q = '', mode = 'all', val = '';
        function apply() {
          var shown = 0;
          document.querySelectorAll('[data-vend]').forEach(function (el) {
            var off = el.getAttribute('data-off') === '1';
            var ok = mode === 'off' ? off
              : off ? false
              : mode === 'all' ? true
              : mode === 'fav' ? el.getAttribute('data-fav') === '1'
              : el.getAttribute('data-cat') === val;
            if (ok && q) ok = el.getAttribute('data-search').indexOf(q) !== -1;
            el.style.display = ok ? '' : 'none';
            if (ok) shown++;
          });
          var n = document.getElementById('vnone'); if (n) n.style.display = shown ? 'none' : '';
        }
        var si = document.getElementById('vsearch');
        if (si) si.addEventListener('input', function () { q = this.value.toLowerCase(); apply(); });
        document.querySelectorAll('.fchip').forEach(function (b) {
          b.addEventListener('click', function () {
            document.querySelectorAll('.fchip').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            mode = b.getAttribute('data-f'); val = b.getAttribute('data-v'); apply();
          });
        });
        apply();
      })();
      function vDrawer(open) {
        document.body.classList.toggle('drawer-open', !!open);
        if (open) setTimeout(function () { var f = document.querySelector('#v-drawer input[name=name]'); if (f) f.focus(); }, 180);
      }
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') vDrawer(false); });
    </script>`));
});

function vendorDrawer() {
  return `
    <div class="drawer-scrim" onclick="vDrawer(false)"></div>
    <aside class="drawer" id="v-drawer" aria-label="Add vendor">
      <div class="drawer-h">
        <div><div class="drawer-t">Add a vendor</div><div class="drawer-s">They'll appear whenever you upload an invoice.</div></div>
        <button class="drawer-x" type="button" onclick="vDrawer(false)" aria-label="Close">✕</button>
      </div>
      <form method="post" action="/c/vendors" class="drawer-b">
        <label class="fld">Vendor name <input name="name" required placeholder="e.g. Baldor Specialty Foods"></label>
        <div class="fld-row">
          <label class="fld">Supplies <select name="category">${VEND_CATS.map((c) => `<option${c === 'Produce' ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
          <label class="fld">How you order <select name="ordering_method"><option value="">—</option>${ORDER_METHODS.map((m) => `<option>${m}</option>`).join('')}</select></label>
        </div>
        <label class="fld">Your rep <input name="rep_name" placeholder="Optional"></label>
        <div class="fld-row">
          <label class="fld">Phone <input name="phone" type="tel" placeholder="Optional"></label>
          <label class="fld">Email <input name="email" type="email" placeholder="Optional"></label>
        </div>
        <label class="fld">Website <input name="website" type="url" placeholder="https://…"></label>
        <label class="fld">Account # <input name="account_number" placeholder="Optional"></label>
        <div class="portal-box">
          <div class="portal-t">Portal login</div>
          <label class="fld">Username <input name="login_username" placeholder="Optional"></label>
          <label class="fld">Where the password is kept <input name="login_hint" placeholder="e.g. 1Password"></label>
          <div class="portal-warn">Never type the password itself — this database isn't encrypted. Store the location, not the secret.</div>
        </div>
        <label class="fld">Ordering notes <textarea name="order_notes" rows="3" placeholder="e.g. Delivers Tue &amp; Fri, order by 4pm, $250 minimum"></textarea></label>
        <label class="fcheck"><input type="checkbox" name="favorite" value="1"><span>Preferred vendor</span></label>
        <div class="drawer-f">
          <button class="btn btn-ghost" type="button" onclick="vDrawer(false)">Cancel</button>
          <button class="btn btn-primary" type="submit">Add vendor</button>
        </div>
      </form>
    </aside>`;
}

const vendorBody = (b) => ({
  name: String(b.name || '').trim(),
  category: VEND_CATS.includes(b.category) ? b.category : 'Other',
  ordering_method: ORDER_METHODS.includes(b.ordering_method) ? b.ordering_method : null,
  favorite: b.favorite ? '1' : null,
  inactive: b.inactive ? '1' : null,
  website: String(b.website || '').trim() || null,
  account_number: String(b.account_number || '').trim() || null,
  login_username: String(b.login_username || '').trim() || null,
  login_hint: String(b.login_hint || '').trim() || null,
  rep_name: String(b.rep_name || '').trim() || null,
  phone: String(b.phone || '').trim() || null,
  email: String(b.email || '').trim() || null,
  order_notes: String(b.order_notes || '').trim() || null,
});

app.post('/c/vendors', (req, res) => {
  const data = vendorBody(req.body);
  if (!data.name) return res.redirect('/c/vendors?err=1&msg=' + encodeURIComponent('A vendor needs a name.'));
  vendQ.add.run(data);
  res.redirect('/c/vendors?msg=' + encodeURIComponent(`${data.name} added.`));
});

app.post('/c/vendors/:id/favorite', (req, res) => {
  vendQ.toggle.run(req.body.favorite ? '1' : null, Number(req.params.id));
  res.redirect('/c/vendors');
});

app.post('/c/vendors/:id/inactive', (req, res) => {
  const v = vendQ.one.get(Number(req.params.id));
  if (!v) return res.status(404).end();
  const off = req.body.inactive === '1';
  vendQ.setInactive.run(off ? '1' : null, v.id);
  res.redirect(`/c/vendors/${v.id}?msg=` + encodeURIComponent(`${v.name} marked ${off ? 'no longer used' : 'in use'}.`));
});

// Called from the invoice drawer when the AI reads a vendor with no match, so
// you never have to leave the invoice half-finished to go and create one.
app.post('/c/vendors/quick', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.json({ error: 'A vendor needs a name.' });
  const existing = vendQ.all.all().find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (existing) return res.json({ id: existing.id, name: existing.name, existed: true });
  const info = vendQ.add.run({ ...vendorBody({ name }), category: req.body.category || 'Other' });
  res.json({ id: info.lastInsertRowid, name });
});

app.get('/c/vendors/:id', (req, res) => {
  const v = vendQ.one.get(Number(req.params.id));
  if (!v) return res.status(404).send(layout('Not found', '<h1>Vendor not found</h1>'));
  const c = vendCat(v.category || 'Other');
  const stats = vendQ.stats.get(v.id);
  const invs = vendQ.invoices.all(v.id);
  const off = yes(v.inactive);

  const row = (label, value, raw) => `<div class="prow"><div class="prow-k">${label}</div><div class="prow-v">${raw ? value : (value ? esc(value) : '<i class="unset">Not set</i>')}</div></div>`;
  const unpaid = invs.filter((i) => i.status !== 'Paid');

  res.send(layout(v.name, `
    ${flash(req)}
    <a class="back" href="/c/vendors">← Vendors</a>
    <div class="vhead" style="--c:${c.color};--ct:${c.tint}">
      <div class="vhead-ico">${icon(c.icon)}</div>
      <div class="vhead-t">
        <h1>${esc(v.name)}${yes(v.favorite) ? ' <span class="vstar">★</span>' : ''}</h1>
        <div class="vhead-s"><span class="vcatbadge">${esc(v.category || 'Other')}</span>${off ? '<span class="pill">no longer used</span>' : ''}${v.ordering_method ? ` · order by ${esc(v.ordering_method)}` : ''}</div>
      </div>
      <div class="vhead-acts">
        ${v.phone ? `<a class="btn btn-sm" href="tel:${esc(v.phone)}">Call</a>` : ''}
        ${v.email ? `<a class="btn btn-sm" href="mailto:${esc(v.email)}">Email</a>` : ''}
        <a class="btn btn-sm btn-primary" href="/c/vendors/${v.id}/edit">Edit</a>
      </div>
    </div>

    <div class="mcards">
      <div class="mcard mcard-blue"><div class="mcard-ico">${icon('invoices')}</div><div class="mcard-body">
        <div class="mcard-label">Invoices</div><div class="mcard-value">${stats.n || 0}</div>
        <div class="mcard-sub">${stats.last ? 'Last ' + esc(niceDate(stats.last)) : 'None yet'}</div></div></div>
      <div class="mcard mcard-green"><div class="mcard-ico">${icon('payroll')}</div><div class="mcard-body">
        <div class="mcard-label">Total invoiced</div><div class="mcard-value">${money(stats.spend || 0)}</div>
        <div class="mcard-sub">${stats.n ? 'Avg ' + money(Math.round(stats.spend / stats.n)) : 'No spend yet'}</div></div></div>
      <div class="mcard mcard-${unpaid.length ? 'amber' : 'green'}"><div class="mcard-ico">${icon('expirations')}</div><div class="mcard-body">
        <div class="mcard-label">Unpaid</div><div class="mcard-value">${money(unpaid.reduce((a, i) => a + (i.amount_cents || 0), 0))}</div>
        <div class="mcard-sub">${unpaid.length ? unpaid.length + ' outstanding' : 'All settled'}</div></div></div>
    </div>

    <div class="vpanels">
      <section class="panel">
        <div class="panel-h">${icon('contacts')}<span>Contact</span></div>
        ${row('Representative', v.rep_name)}
        ${row('Phone', v.phone ? `<a href="tel:${esc(v.phone)}">${esc(v.phone)}</a>` : '', true)}
        ${row('Email', v.email ? `<a href="mailto:${esc(v.email)}">${esc(v.email)}</a>` : '', true)}
        ${row('Website', v.website ? `<a href="${esc(v.website)}" target="_blank">${esc(String(v.website).replace(/^https?:\/\//, ''))}</a>` : '', true)}
        ${row('Account #', v.account_number)}
        ${row('How you order', v.ordering_method)}
      </section>

      <section class="panel">
        <div class="panel-h">${icon('policy')}<span>Portal</span></div>
        ${row('Username', v.login_username)}
        ${row('Password kept in', v.login_hint)}
        <div class="panel-note">Passwords are never stored here — this database isn't encrypted. Keep the secret in your password manager and note its location above.</div>
      </section>

      <section class="panel panel-wide">
        <div class="panel-h">${icon('notes')}<span>Ordering notes</span></div>
        ${v.order_notes ? `<div class="panel-body">${esc(v.order_notes)}</div>`
          : '<div class="panel-empty">Nothing noted. Delivery days, order cut-offs and minimums go here.</div>'}
      </section>

      <section class="panel panel-wide">
        <div class="panel-h">${icon('invoices')}<span>Invoice history</span>
          <a class="panel-link" href="/c/invoices">All invoices →</a></div>
        ${invs.length ? `<div class="vinv">${invs.map((i) => {
          const s = invStatus(i);
          return `<a class="vinv-row" href="/c/invoices/${i.id}">
            <span class="vinv-date">${esc(niceDate(i.invoice_date))}</span>
            <span class="vinv-num">${i.invoice_number ? '#' + esc(i.invoice_number) : '<i class="unset">no number</i>'}</span>
            <span class="tstatus ${s.cls}">${esc(s.label)}</span>
            <span class="vinv-amt">${money(i.amount_cents || 0)}</span>
          </a>`;
        }).join('')}</div>` : '<div class="panel-empty">No invoices from this vendor yet. Upload one and it will match here automatically.</div>'}
      </section>
    </div>

    <div class="danger-zone">
      <div><b>${off ? 'Bring this vendor back' : 'Stop using this vendor'}</b>
        <p class="muted">${off ? 'They will show in the list and be offered on invoices again.'
          : 'They stay on past invoices and keep their history — they just stop appearing as a choice.'}</p></div>
      <form method="post" action="/c/vendors/${v.id}/inactive" style="margin:0">
        <input type="hidden" name="inactive" value="${off ? '0' : '1'}">
        <button class="btn ${off ? 'btn-primary' : 'btn-danger'}" type="submit">${off ? 'Mark in use' : 'No longer used'}</button>
      </form>
    </div>`));
});

app.get('/c/vendors/:id/edit', (req, res) => {
  const v = vendQ.one.get(Number(req.params.id));
  if (!v) return res.status(404).send(layout('Not found', '<h1>Vendor not found</h1>'));
  const val = (x) => esc(v[x] == null ? '' : v[x]);
  res.send(layout(`Edit ${v.name}`, `
    ${flash(req)}
    <a class="back" href="/c/vendors/${v.id}">← ${esc(v.name)}</a>
    <h1>Edit ${esc(v.name)}</h1>
    <form method="post" action="/c/vendors/${v.id}" class="card form grid">
      <label>Vendor name <input name="name" value="${val('name')}" required></label>
      <label>Supplies <select name="category">${VEND_CATS.map((c) => `<option${c === v.category ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>How you order <select name="ordering_method"><option value="">—</option>${ORDER_METHODS.map((m) => `<option${m === v.ordering_method ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Your rep <input name="rep_name" value="${val('rep_name')}"></label>
      <label>Phone <input name="phone" type="tel" value="${val('phone')}"></label>
      <label>Email <input name="email" type="email" value="${val('email')}"></label>
      <label>Website <input name="website" type="url" value="${val('website')}"></label>
      <label>Account # <input name="account_number" value="${val('account_number')}"></label>
      <label>Portal username <input name="login_username" value="${val('login_username')}"></label>
      <label>Where the password is kept <input name="login_hint" value="${val('login_hint')}" placeholder="e.g. 1Password — never the password itself"></label>
      <label class="wide">Ordering notes <textarea name="order_notes" rows="3">${val('order_notes')}</textarea></label>
      <label class="fcheck"><input type="checkbox" name="favorite" value="1"${yes(v.favorite) ? ' checked' : ''}><span>Preferred vendor</span></label>
      <button class="btn btn-primary" type="submit">Save changes</button>
    </form>`));
});

app.post('/c/vendors/:id', (req, res) => {
  const v = vendQ.one.get(Number(req.params.id));
  if (!v) return res.status(404).end();
  const data = vendorBody(req.body);
  if (!data.name) return res.redirect(`/c/vendors/${v.id}/edit?err=1&msg=` + encodeURIComponent('A vendor needs a name.'));
  vendQ.update.run({ ...data, inactive: v.inactive, id: v.id });
  res.redirect(`/c/vendors/${v.id}?msg=` + encodeURIComponent('Saved.'));
});


// ---------------------------------------------------------------------------
// PRODUCTS — purchasing intelligence, not live inventory.
//
// This replaces the par-level tracker. The question it answers is not "what's
// on the shelf" — without POS ingredient depletion nobody can answer that
// honestly — but "what do I buy, from whom, what do I pay, and is that
// moving". Every figure comes from an invoice line, so every figure is
// defensible.
//
// The par/on-hand columns still exist on the table and are deliberately not
// surfaced. When inventory counts arrive they slot in without a migration.
// ---------------------------------------------------------------------------

const PROD_CAT_COLORS = {
  Produce: { color: '#16a34a', tint: '#f0fdf4' }, Meat: { color: '#dc2626', tint: '#fef2f2' },
  Seafood: { color: '#0891b2', tint: '#ecfeff' }, Dairy: { color: '#2563eb', tint: '#eff6ff' },
  'Dry goods': { color: '#a16207', tint: '#fefce8' }, Bakery: { color: '#d97706', tint: '#fffbeb' },
  Coffee: { color: '#78350f', tint: '#fef3c7' }, Beverage: { color: '#0ea5e9', tint: '#f0f9ff' },
  Alcohol: { color: '#7c3aed', tint: '#f5f3ff' }, Supplies: { color: '#64748b', tint: '#f8fafc' },
  Cleaning: { color: '#0d9488', tint: '#f0fdfa' }, Other: { color: '#6b7280', tint: '#f9fafb' },
};
const prodCat = (c) => PROD_CAT_COLORS[c] || PROD_CAT_COLORS.Other;
const monthStart = (iso) => iso.slice(0, 8) + '01';
const yearStart = (iso) => iso.slice(0, 4) + '-01-01';

/** Up / down / steady, as a badge. Null when there's nothing to compare to. */
function trendBadge(p) {
  const t = trendOf(p);
  if (t === null) return '<span class="tr tr-none">—</span>';
  if (Math.abs(t) < 3) return '<span class="tr tr-flat">steady</span>';
  return `<span class="tr ${t > 0 ? 'tr-up' : 'tr-down'}">${t > 0 ? '▲' : '▼'} ${Math.abs(t)}%</span>`;
}

const prodRollupArgs = () => {
  const today = isoDate(startOfToday());
  return { from_month: monthStart(today), from_year: yearStart(today), today };
};

app.get('/c/par', (_req, res) => res.redirect(301, '/c/products'));

app.get('/c/products', (req, res) => {
  const args = prodRollupArgs();
  const all = prodQ.all.all(args);
  const vendors = invQ.vendors.all();
  const spendMonth = all.reduce((a, p) => a + p.spend_month, 0);
  const spendYear = all.reduce((a, p) => a + p.spend_year, 0);
  const priced = all.filter((p) => trendOf(p) !== null);
  const rising = priced.filter((p) => trendOf(p) >= 3);
  const tracked = all.filter((p) => p.buys > 0).length;

  const card = (tone, ico, label, value, sub) => `
    <div class="mcard mcard-${tone}"><div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body"><div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div><div class="mcard-sub">${sub}</div></div></div>`;

  const cards = `<div class="mcards mcards-4">
    ${card('blue', 'par', 'Products', String(all.length), tracked ? `${tracked} with purchase history` : 'none bought yet')}
    ${card('green', 'invoices', 'Spend this month', money(spendMonth), spendYear ? `${money(spendYear)} this year` : 'nothing yet')}
    ${card(rising.length ? 'amber' : 'green', 'sales', 'Getting pricier', String(rising.length),
      rising.length ? `of ${priced.length} comparable` : priced.length ? 'nothing is up' : 'need 2 buys to compare')}
    ${card('violet', 'vendors', 'Vendors used', String(new Set(all.filter((p) => p.vendor_id).map((p) => p.vendor_id)).size),
      `across ${all.length} product${all.length === 1 ? '' : 's'}`)}
  </div>`;

  // --- insights: only what the data actually supports --------------------
  const insights = [];
  // Phrased with a dash rather than a verb: product names are singular and
  // plural and nothing here can tell which, so "Avocados is up" is one bad
  // guess away on every line.
  const bump = [...rising].sort((a, b) => trendOf(b) - trendOf(a))[0];
  if (bump) insights.push(`<b>${esc(bump.name)}</b> — up ${trendOf(bump)}% on what you used to pay.`);
  const drop = priced.filter((p) => trendOf(p) <= -3).sort((a, b) => trendOf(a) - trendOf(b))[0];
  if (drop) insights.push(`<b>${esc(drop.name)}</b> — down ${Math.abs(trendOf(drop))}%.`);
  const share = prodQ.vendorShare.all(args.from_year).filter((v) => v.c > 0);
  const shareTotal = share.reduce((a, v) => a + v.c, 0);
  if (share.length > 1 && shareTotal) {
    const top = share[0];
    insights.push(`<b>${esc(top.name || 'One vendor')}</b> supplies ${Math.round((top.c / shareTotal) * 100)}% of what you've spent this year.`);
  }
  const cat = prodQ.categorySpend.all(args.from_month).filter((c) => c.c > 0)[0];
  if (cat) insights.push(`You've spent <b>${money(cat.c)}</b> on ${esc(cat.cat.toLowerCase())} this month.`);
  const often = [...all].sort((a, b) => b.buys - a.buys)[0];
  if (often && often.buys >= 3) insights.push(`<b>${esc(often.name)}</b> — bought ${often.buys} times, more than anything else.`);
  const insightBlock = insights.length
    ? `<div class="insights"><div class="ins-h">${icon('sales')} What the invoices say</div>
        <ul class="ins-list">${insights.slice(0, 4).map((t) => `<li>${t}</li>`).join('')}</ul></div>`
    : '';

  const usedCats = [...new Set(all.map((p) => p.category).filter(Boolean))].sort();
  const usedVendors = vendors.filter((v) => all.some((p) => Number(p.vendor_id) === Number(v.id)));

  const rows = all.map((p) => {
    const cc = prodCat(p.category);
    const t = trendOf(p);
    const search = [p.name, p.category, p.vendor_name, p.sku, p.unit].filter(Boolean).join(' ').toLowerCase();
    return `<a class="pitem" href="/c/products/${p.id}"
        data-prod data-search="${esc(search)}" data-cat="${esc(p.category || '')}"
        data-vendor="${p.vendor_id || ''}" data-trend="${t === null ? '' : t >= 3 ? 'up' : t <= -3 ? 'down' : 'flat'}"
        data-bought="${p.buys ? '1' : '0'}"
        data-spend="${p.spend_all}" data-buys="${p.buys || 0}" data-rise="${t === null ? -999 : t}" data-last="${p.last_on || ''}">
      <span class="pitem-main">
        <span class="pitem-n">${esc(p.name)}</span>
        <span class="pitem-meta">
          ${p.category ? `<span class="pchip" style="--c:${cc.color};--ct:${cc.tint}">${esc(p.category)}</span>` : ''}
          ${p.vendor_name ? `<span class="pitem-v">${esc(p.vendor_name)}</span>` : '<span class="pitem-v unset">No vendor set</span>'}
          ${p.pack_size || p.unit ? `<span class="pitem-u">${esc(p.pack_size || p.unit)}</span>` : ''}
        </span>
      </span>
      <span class="pitem-f">
        <span class="pf"><i>Last paid</i><b>${p.last_price ? money(p.last_price) : '—'}</b></span>
        <span class="pf"><i>Average</i><b>${p.avg_price ? money(p.avg_price) : '—'}</b></span>
        <span class="pf"><i>Trend</i><b>${trendBadge(p)}</b></span>
        <span class="pf"><i>Bought</i><b>${p.buys || 0}×</b></span>
        <span class="pf"><i>Spent</i><b>${money(p.spend_all)}</b></span>
        <span class="pf pf-w"><i>Last bought</i><b>${p.last_on ? esc(niceDate(p.last_on)) : '—'}</b></span>
      </span>
      <span class="pitem-go">›</span>
    </a>`;
  }).join('');

  const toolbar = `
    <div class="toolbar2">
      <div class="searchbox">${icon('search')}<input id="psearch" type="search" placeholder="Search a product, vendor or SKU..." autocomplete="off"></div>
      <select id="pvendor" class="minisel">
        <option value="">Any vendor</option>
        ${usedVendors.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}
      </select>
      <select id="psort" class="minisel">
        <option value="name">Sort: name</option>
        <option value="spend">Sort: most spent</option>
        <option value="buys">Sort: bought most</option>
        <option value="rise">Sort: biggest rise</option>
        <option value="recent">Sort: last bought</option>
      </select>
    </div>
    <div class="fchips">
      <button class="fchip on" data-f="all" data-v="" style="--c:var(--ink-2);--ct:var(--surface-3)">All<span class="fcount">${all.length}</span></button>
      <button class="fchip" data-f="trend" data-v="up" style="--c:#dc2626;--ct:#fef2f2"><i class="fdot"></i>Going up</button>
      <button class="fchip" data-f="trend" data-v="down" style="--c:#059669;--ct:#ecfdf5"><i class="fdot"></i>Going down</button>
      <button class="fchip" data-f="bought" data-v="0" style="--c:#64748b;--ct:#f8fafc"><i class="fdot"></i>Never bought</button>
      ${usedCats.map((c) => { const cc = prodCat(c); return `<button class="fchip" data-f="cat" data-v="${esc(c)}" style="--c:${cc.color};--ct:${cc.tint}"><i class="fdot"></i>${esc(c)}</button>`; }).join('')}
    </div>`;

  const body = all.length
    ? `${cards}${insightBlock}${toolbar}<div class="pitems" id="plist">${rows}</div>
       <div class="empty2" id="pnone" style="display:none"><div class="empty2-t">Nothing matches</div><div class="empty2-s">Try a different search or filter.</div></div>`
    : `<div class="upload-hero">
        <div class="uh-ico">${icon('par')}</div>
        <div class="uh-t">No products yet</div>
        <div class="uh-s">${canWrite()
          ? 'Add what you buy, or let it build itself — when you photograph an invoice, its lines can be imported straight in here with the prices you paid.'
          : 'Once products are added, what you pay for each of them shows up here.'}</div>
        ${canWrite() ? `<button class="btn btn-primary btn-lg" type="button" onclick="prodDrawer(true)">＋ Add your first product</button>` : ''}
      </div>`;

  res.send(layout('Products', `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t"><h1>Products</h1><p class="phead-s">What you buy, what it costs, and whether that's moving.</p></div>
      ${canWrite() ? `<button class="btn btn-primary" type="button" onclick="prodDrawer(true)">＋ Add product</button>` : ''}
    </div>
    ${body}
    ${canWrite() ? productDrawer(vendors) : ''}
    <script>${productListScript()}</script>`));
});

/** The add-product drawer, shared by the list and the empty state. */
function productDrawer(vendors, p) {
  const v = p || {};
  return `
  <div class="drawer-scrim" onclick="prodDrawer(false)"></div>
  <aside class="drawer" id="prod-drawer" aria-hidden="true">
    <div class="drawer-h"><b>${p ? 'Edit product' : 'Add a product'}</b>
      <button class="btn btn-ghost btn-sm" type="button" onclick="prodDrawer(false)">Close</button></div>
    <form method="post" action="${p ? `/c/products/${p.id}` : '/c/products'}">
      <div class="drawer-b">
        <label class="fld">Name<input name="name" required value="${esc(v.name || '')}" placeholder="e.g. Roma tomatoes"></label>
        <div class="fld-row">
          <label class="fld">Category<select name="category">
            <option value="">—</option>
            ${PROD_CATS.map((c) => `<option${v.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
          </select></label>
          <label class="fld">Vendor<select name="vendor_id">
            <option value="">—</option>
            ${vendors.map((x) => `<option value="${x.id}"${Number(v.vendor_id) === Number(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
          </select></label>
        </div>
        <div class="fld-row3">
          <label class="fld">Unit<input name="unit" value="${esc(v.unit || '')}" placeholder="case, lb, each"></label>
          <label class="fld">Pack size<input name="pack_size" value="${esc(v.pack_size || '')}" placeholder="6/#10"></label>
          <label class="fld">Item code / SKU<input name="sku" value="${esc(v.sku || '')}"></label>
        </div>
        <label class="fld">Brand<input name="brand" value="${esc(v.brand || '')}" placeholder="optional — helps match invoice lines"></label>
        <div class="fld-row3">
          <label class="fld">Price paid<input name="price" type="number" step="0.01" min="0" placeholder="14.99"></label>
          <label class="fld">One purchase unit holds<input name="pack_qty" type="number" step="0.01" min="0" placeholder="12"></label>
          <label class="fld">of<select name="pack_unit">
            <option value="">—</option>
            ${UNITS.UNIT_GROUPS.map((g) => `<optgroup label="${g.label}">${g.units.map((u) => `<option value="${u}">${UNITS.unitLabel(u)}</option>`).join('')}</optgroup>`).join('')}
          </select></label>
        </div>
        <div class="fld-hint">Menu costing needs to know what one purchase unit contains — 12 in a package, 25 lb in a case. Leave the price blank for anything you buy on invoice.</div>
        <label class="fld">Notes<textarea name="notes" rows="2">${esc(v.notes || '')}</textarea></label>
      </div>
      <div class="drawer-f">
        <button class="btn btn-ghost" type="button" onclick="prodDrawer(false)">Cancel</button>
        <button class="btn btn-primary" type="submit">${p ? 'Save' : 'Add product'}</button>
      </div>
    </form>
  </aside>`;
}

function productListScript() {
  return `
  function prodDrawer(on){ document.getElementById('prod-drawer').setAttribute('aria-hidden', on?'false':'true');
    document.body.classList.toggle('drawer-open', !!on);
    if(on){ var i=document.querySelector('#prod-drawer input[name=name]'); if(i) i.focus(); } }
  (function(){
    var q='', mode='all', val='', vend='';
    var list=document.getElementById('plist'); if(!list) return;
    var rows=[].slice.call(list.querySelectorAll('[data-prod]'));
    var none=document.getElementById('pnone');
    function pass(el){
      if(q && el.dataset.search.indexOf(q)<0) return false;
      if(vend && el.dataset.vendor!==vend) return false;
      if(mode==='cat' && el.dataset.cat!==val) return false;
      if(mode==='trend' && el.dataset.trend!==val) return false;
      if(mode==='bought' && el.dataset.bought!==val) return false;
      return true;
    }
    function apply(){ var n=0; rows.forEach(function(el){ var ok=pass(el); el.style.display=ok?'':'none'; if(ok)n++; });
      if(none) none.style.display=n?'none':''; }
    var s=document.getElementById('psearch');
    if(s) s.addEventListener('input', function(){ q=this.value.trim().toLowerCase(); apply(); });
    var v=document.getElementById('pvendor');
    if(v) v.addEventListener('change', function(){ vend=this.value; apply(); });
    document.querySelectorAll('.fchip').forEach(function(c){ c.addEventListener('click', function(){
      document.querySelectorAll('.fchip').forEach(function(x){ x.classList.remove('on'); });
      c.classList.add('on'); mode=c.dataset.f; val=c.dataset.v; apply(); }); });
    var so=document.getElementById('psort');
    if(so) so.addEventListener('change', function(){
      var k=this.value;
      var num=function(el,a){ return parseFloat(el.dataset[a]||'0')||0; };
      var sorted=rows.slice().sort(function(a,b){
        if(k==='name') return a.querySelector('.pitem-n').textContent.localeCompare(b.querySelector('.pitem-n').textContent);
        if(k==='spend') return num(b,'spend')-num(a,'spend');
        if(k==='buys') return num(b,'buys')-num(a,'buys');
        if(k==='rise') return num(b,'rise')-num(a,'rise');
        return (b.dataset.last||'').localeCompare(a.dataset.last||'');
      });
      sorted.forEach(function(el){ list.appendChild(el); });
    });
  })();`;
}

app.post('/c/products', (req, res) => {
  // ?json=1 is the menu workspace adding an ingredient mid-recipe. A redirect
  // would navigate away and take the unsaved recipe with it.
  const wantsJson = req.query.json === '1';
  const bail = (msg) => (wantsJson ? res.json({ error: msg })
    : res.redirect('/c/products?err=1&msg=' + encodeURIComponent(msg)));
  const name = (req.body.name || '').trim();
  if (!name) return bail('A product needs a name.');
  if (prodQ.byName.get(name)) return bail(`You already track "${name}".`);
  const id = prodQ.add.run({
    name, category: (req.body.category || '').trim() || null,
    vendor_id: req.body.vendor_id ? Number(req.body.vendor_id) : null,
    unit: (req.body.unit || '').trim() || null,
    pack_size: (req.body.pack_size || '').trim() || null,
    sku: (req.body.sku || '').trim() || null,
    brand: (req.body.brand || '').trim() || null,
    notes: (req.body.notes || '').trim() || null,
  }).lastInsertRowid;

  // A manual price and what one purchase unit holds, so a product created from
  // the recipe screen can be costed straight away instead of arriving broken.
  const price = toCents(req.body.price);
  const packQty = Number(req.body.pack_qty);
  const packUnit = UNITS.normalizeUnit(req.body.pack_unit);
  const parsed = UNITS.parsePack(req.body.pack_size);
  db.prepare(`UPDATE products SET manual_price_cents=?, manual_price_on=?,
      pack_qty=?, pack_unit=?, pack_source=?, yield_pct=? WHERE id=?`)
    .run(price || null, price ? isoDate(startOfToday()) : null,
      packQty > 0 ? packQty : (parsed ? parsed.qty : null),
      packUnit || (parsed ? parsed.unit : null),
      packQty > 0 && packUnit ? 'manual' : (parsed ? 'parsed' : null),
      Number(req.body.yield_pct) > 0 ? Number(req.body.yield_pct) : null, id);

  if (wantsJson) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    const pr = MENU_priceLabel(p);
    return res.json({ id, name: p.name, price: pr.text, source: pr.source,
      meta: [p.brand, p.pack_size || p.unit].filter(Boolean).join(' · '),
      units: PRODUCTS.costableUnits(p) });
  }
  res.redirect('/c/products?msg=' + encodeURIComponent('Product added.'));
});

app.get('/c/products/:id', (req, res) => {
  const args = prodRollupArgs();
  const p = prodQ.one.get({ ...args, id: Number(req.params.id) });
  if (!p) return res.status(404).send(layout('Not found', '<div class="empty2"><div class="empty2-t">No such product</div></div>'));
  const history = prodQ.history.all(p.id);
  const vendors = invQ.vendors.all();
  const aliases = prodQ.aliases.all(p.id);
  const allProducts = prodQ.plain.all();
  const others = allProducts.filter((x) => x.id !== p.id);
  const dupes = likelyDuplicates(p, allProducts);
  const t = trendOf(p);

  const fact = (k, v) => `<div class="tfact"><span>${k}</span><b>${v}</b></div>`;
  const unset = '<i class="unset">—</i>';

  // A tiny sparkline of unit price over time. Drawn only with three or more
  // priced purchases, below which a "line" is just two dots and a story.
  const priced = history.filter((h) => h.unit_price_cents > 0).slice().reverse();
  let spark = '';
  if (priced.length >= 3) {
    const vals = priced.map((h) => h.unit_price_cents);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const W = 260, H = 46;
    const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - ((v - lo) / span) * (H - 8) - 4).toFixed(1)}`);
    spark = `<div class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline points="${pts.join(' ')}" fill="none" stroke="${t > 0 ? '#dc2626' : t < 0 ? '#059669' : '#2563eb'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg><div class="spark-l"><span>${money(lo)}</span><span>${priced.length} priced purchases</span><span>${money(hi)}</span></div></div>`;
  }

  const histRows = history.length ? history.map((h) => `
    <tr>
      <td>${esc(niceDate(h.purchased_on))}</td>
      <td>${esc(h.vendor_name || '—')}</td>
      <td>${h.invoice_id ? `<a href="/c/invoices/${h.invoice_id}">${esc(h.invoice_number || '#' + h.invoice_id)}</a>` : '<span class="muted">manual</span>'}</td>
      <td class="num">${h.qty ? esc(String(h.qty)) + (h.unit ? ' ' + esc(h.unit) : '') : '—'}</td>
      <td class="num">${h.unit_price_cents ? money(h.unit_price_cents) : '—'}</td>
      <td class="num">${money(h.total_cents)}</td>
      <td><form method="post" action="/c/products/purchase/${h.id}/delete" onsubmit="return confirm('Remove this purchase from the history?')">
        <button class="btn btn-ghost btn-sm" type="submit">Remove</button></form></td>
    </tr>`).join('') : '';

  const cc = prodCat(p.category);
  res.send(layout(p.name, `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t">
        <a class="link back" href="/c/products">← Products</a>
        <h1>${esc(p.name)}</h1>
        <p class="phead-s">
          ${p.category ? `<span class="pchip" style="--c:${cc.color};--ct:${cc.tint}">${esc(p.category)}</span>` : ''}
          ${p.vendor_name ? esc(p.vendor_name) : '<span class="muted">no vendor set</span>'}
          ${p.pack_size || p.unit ? ' · ' + esc(p.pack_size || p.unit) : ''}
        </p>
      </div>
      <div class="phead-acts">
        <button class="btn" type="button" onclick="prodDrawer(true)">Edit</button>
      </div>
    </div>

    <div class="mcards mcards-4">
      <div class="mcard mcard-blue"><div class="mcard-ico">${icon('invoices')}</div><div class="mcard-body">
        <div class="mcard-label">Last paid</div><div class="mcard-value">${p.last_price ? money(p.last_price) : '—'}</div>
        <div class="mcard-sub">${p.last_on ? 'on ' + esc(niceDate(p.last_on)) : 'never bought'}</div></div></div>
      <div class="mcard mcard-green"><div class="mcard-ico">${icon('sales')}</div><div class="mcard-body">
        <div class="mcard-label">Average price</div><div class="mcard-value">${p.avg_price ? money(p.avg_price) : '—'}</div>
        <div class="mcard-sub">${p.low_price ? `${money(p.low_price)} – ${money(p.high_price)}` : 'no prices yet'}</div></div></div>
      <div class="mcard mcard-${t > 2 ? 'red' : t < -2 ? 'green' : 'violet'}"><div class="mcard-ico">${icon('costs')}</div><div class="mcard-body">
        <div class="mcard-label">Price trend</div><div class="mcard-value">${t === null ? '—' : (t > 0 ? '+' : '') + t + '%'}</div>
        <div class="mcard-sub">${t === null ? 'needs two purchases' : 'vs what you used to pay'}</div></div></div>
      <div class="mcard mcard-amber"><div class="mcard-ico">${icon('payroll')}</div><div class="mcard-body">
        <div class="mcard-label">Total spent</div><div class="mcard-value">${money(p.spend_all)}</div>
        <div class="mcard-sub">${p.buys} purchase${p.buys === 1 ? '' : 's'}${p.spend_year ? ` · ${money(p.spend_year)} this year` : ''}</div></div></div>
    </div>

    <div class="vpanels">
      <section class="panel">
        <div class="panel-h"><b>Details</b></div>
        ${fact('Primary vendor', p.vendor_name ? esc(p.vendor_name) : unset)}
        ${fact('Category', p.category ? esc(p.category) : unset)}
        ${fact('Unit', p.unit ? esc(p.unit) : unset)}
        ${fact('Pack size', p.pack_size ? esc(p.pack_size) : unset)}
        ${fact('SKU', p.sku ? esc(p.sku) : unset)}
        ${fact('Spend this month', money(p.spend_month))}
        ${fact('Spend this year', money(p.spend_year))}
        ${fact('First bought', p.first_on ? esc(niceDate(p.first_on)) : unset)}
        ${p.notes ? `<div class="inv-notes">${esc(p.notes)}</div>` : ''}
        ${spark}
      </section>

      <section class="panel">
        <div class="panel-h"><b>Add a purchase</b><span class="panel-link muted">for anything not on an invoice</span></div>
        <form method="post" action="/c/products/${p.id}/purchase" class="phist-add">
          <div class="fld-row3">
            <label class="fld">Date<input name="purchased_on" type="date" required value="${esc(args.today)}"></label>
            <label class="fld">Quantity<input name="qty" type="number" step="0.01" min="0" placeholder="1"></label>
            <label class="fld">Total paid<input name="total" type="number" step="0.01" min="0" required placeholder="0.00"></label>
          </div>
          <label class="fld">Vendor<select name="vendor_id">
            <option value="">—</option>
            ${vendors.map((x) => `<option value="${x.id}"${Number(p.vendor_id) === Number(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
          </select></label>
          <button class="btn btn-primary btn-sm" type="submit">Add purchase</button>
        </form>
      </section>
    </div>

    <div class="head-row"><h2>Purchase history</h2><span class="muted">${p.buys} record${p.buys === 1 ? '' : 's'}</span></div>
    ${history.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Vendor</th><th>Invoice</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>${histRows}</tbody></table></div>`
      : `<div class="empty2"><div class="empty2-t">Nothing bought yet</div>
          <div class="empty2-s">Import an invoice's lines, or add a purchase above.</div></div>`}

    <div class="vpanels">
      <section class="panel">
        <div class="panel-h"><b>Merge into another product</b></div>
        <div class="panel-note">Every purchase and invoice line moves across. This one is then removed.
          ${dupes.length ? 'The suggestions come from the same matching used on invoices.' : ''}</div>
        <form method="post" action="/c/products/${p.id}/merge" class="mergef"
          onsubmit="return confirm('Move all ${p.buys} purchase' + (${p.buys} === 1 ? '' : 's') + ' into the chosen product and remove ${esc(p.name)}?')">
          <select name="into" class="minisel" required>
            <option value="">Choose a product…</option>
            ${dupes.length ? `<optgroup label="Looks like the same thing">
              ${dupes.map((d) => `<option value="${d.product.id}">${esc(d.product.name)} — ${d.score}% match</option>`).join('')}
            </optgroup>` : ''}
            <optgroup label="All products">
              ${others.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}
            </optgroup>
          </select>
          <button class="btn btn-sm" type="submit">Merge</button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-h"><b>What vendors call it</b></div>
        ${aliases.length
          ? aliases.map((a) => `<div class="tfact"><span>${esc(a.vendor_name || 'Any vendor')}</span><b>${a.code ? `#${esc(a.code)} ` : ''}${esc(a.alias || '')}</b></div>`).join('')
          : '<div class="panel-empty">Nothing learned yet. Importing an invoice line records the code and wording that vendor uses, so the next one matches straight away.</div>'}
      </section>
    </div>

    <div class="danger-zone">
      <form method="post" action="/c/products/${p.id}/delete" onsubmit="return confirm('Delete ${esc(p.name)} and its purchase history?')">
        <button class="btn btn-danger btn-sm" type="submit">Delete product</button>
      </form>
    </div>
    ${canWrite() ? productDrawer(vendors, p) : ''}
    <script>${productListScript()}</script>`));
});

app.post('/c/products/:id', (req, res) => {
  const p = prodQ.one.get({ ...prodRollupArgs(), id: Number(req.params.id) });
  if (!p) return res.status(404).end();
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(`/c/products/${p.id}?err=1&msg=` + encodeURIComponent('A product needs a name.'));
  const clash = prodQ.byName.get(name);
  if (clash && clash.id !== p.id) return res.redirect(`/c/products/${p.id}?err=1&msg=` + encodeURIComponent(`"${name}" is already tracked.`));
  prodQ.update.run({
    id: p.id, name, category: (req.body.category || '').trim() || null,
    vendor_id: req.body.vendor_id ? Number(req.body.vendor_id) : null,
    unit: (req.body.unit || '').trim() || null,
    pack_size: (req.body.pack_size || '').trim() || null,
    sku: (req.body.sku || '').trim() || null,
    brand: (req.body.brand || '').trim() || null,
    notes: (req.body.notes || '').trim() || null,
  });
  res.redirect(`/c/products/${p.id}?msg=` + encodeURIComponent('Saved.'));
});

app.post('/c/products/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  // A recipe line pointing at a product that no longer exists is a dish with a
  // hole in it, so the database refuses the delete. Say which dishes rather
  // than letting the constraint surface as a 500.
  const used = menuUsedBy(id);
  if (used.length) {
    const names = used.slice(0, 3).map((m) => m.name).join(', ');
    return res.redirect(`/c/products/${id}?err=1&msg=` + encodeURIComponent(
      `Used by ${used.length} menu item${used.length === 1 ? '' : 's'} (${names}${used.length > 3 ? '…' : ''}). Remove it from ${used.length === 1 ? 'that recipe' : 'those recipes'} first.`));
  }
  prodQ.del.run(id);
  res.redirect('/c/products?msg=' + encodeURIComponent('Product deleted.'));
});

app.post('/c/products/:id/purchase', (req, res) => {
  const id = Number(req.params.id);
  const total = toCents(req.body.total);
  if (!total) return res.redirect(`/c/products/${id}?err=1&msg=` + encodeURIComponent('A purchase needs an amount.'));
  const qty = Number(req.body.qty) > 0 ? Number(req.body.qty) : null;
  prodQ.addPurchase.run({
    product_id: id, invoice_id: null,
    vendor_id: req.body.vendor_id ? Number(req.body.vendor_id) : null,
    purchased_on: req.body.purchased_on || isoDate(startOfToday()),
    qty, unit: null,
    unit_price_cents: qty ? Math.round(total / qty) : total,
    total_cents: total, raw_text: null,
  });
  res.redirect(`/c/products/${id}?msg=` + encodeURIComponent('Purchase added.'));
});

// Merging is the other half of matching conservatively: when the app isn't
// sure it makes a new product, and this is how two records for one thing
// become one without losing an invoice line.
app.post('/c/products/:id/merge', (req, res) => {
  const fromId = Number(req.params.id);
  const intoId = Number(req.body.into);
  if (!intoId || intoId === fromId) {
    return res.redirect(`/c/products/${fromId}?err=1&msg=` + encodeURIComponent('Pick a different product to merge into.'));
  }
  try {
    const { moved, name } = mergeProducts(fromId, intoId);
    res.redirect(`/c/products/${intoId}?msg=` + encodeURIComponent(
      `Merged ${name} in — ${moved} purchase${moved === 1 ? '' : 's'} moved across.`));
  } catch (e) {
    res.redirect(`/c/products/${fromId}?err=1&msg=` + encodeURIComponent(e.message));
  }
});

app.post('/c/products/purchase/:pid/delete', (req, res) => {
  const row = db.prepare('SELECT product_id FROM product_purchases WHERE id = ?').get(Number(req.params.pid));
  prodQ.delPurchase.run(Number(req.params.pid));
  res.redirect(row ? `/c/products/${row.product_id}?msg=Removed.` : '/c/products');
});

// ---------------------------------------------------------------------------
// IMPORT — invoice lines into products.
//
// Kept off the invoice page on purpose: invoices are an accounting record and
// stay that way. This is a separate, reviewable step, because matching a
// printed "TOM RMA 6/6" to a product called "Roma tomatoes" is a guess until
// someone agrees with it. Nothing is written until the form is submitted.
// ---------------------------------------------------------------------------
/** Line indexes already imported for an invoice. */
function importedIdx(inv) {
  try {
    const a = JSON.parse(inv.imported_idx || '[]');
    return new Set(Array.isArray(a) ? a.map(Number) : []);
  } catch { return new Set(); }
}
const saveIdx = (invoiceId, set) =>
  db.prepare('UPDATE m_invoices SET imported_idx = ? WHERE id = ?')
    .run(JSON.stringify([...set].sort((a, b) => a - b)), invoiceId);

/**
 * Import every line the matcher is confident about, and report what's left.
 * Fees are dropped here too — they are accounting, not products.
 *
 * Runs on save and is idempotent by line: a line already imported for this
 * invoice is skipped, so calling it twice can't double-count a delivery.
 */
function autoImport(invoiceId) {
  const inv = invQ.one.get(invoiceId);
  if (!inv) return { added: 0, pending: 0 };
  let lines = [];
  try { lines = JSON.parse(inv.ai_lines || '[]'); } catch { lines = []; }
  if (!lines.length) return { added: 0, pending: 0 };

  const vendorId = inv.vendor_id ? Number(inv.vendor_id) : null;
  const on = inv.invoice_date || isoDate(startOfToday());
  const rows = reviewRows(lines, prodQ.plain.all(), vendorId);
  const already = importedIdx(inv);

  const run = db.transaction(() => {
    let added = 0;
    for (const r of rows) {
      if (r.confidence !== 'high' || !r.match) continue;
      if (already.has(r.i)) continue;
      prodQ.addPurchase.run({
        product_id: r.match.id, invoice_id: invoiceId, vendor_id: vendorId,
        purchased_on: on, qty: r.qty, unit: r.unit,
        unit_price_cents: r.unit_price_cents, total_cents: r.total_cents, raw_text: r.desc,
      });
      learnAlias(r.match.id, vendorId, r.code, r.desc);
      already.add(r.i);
      added++;
    }
    if (added) saveIdx(invoiceId, already);
    return added;
  });
  const added = run();
  // One recalculation for the whole delivery, not one per line: fifty products
  // moving should leave one record per affected dish, not fifty.
  if (added) {
    try {
      const touched = rows.filter((r) => r.confidence === 'high' && r.match).map((r) => r.match.id);
      MENU.recalcForProducts(touched, 'invoice');
    } catch (e) { console.error('[menu] recalc after import failed:', e.message); }
  }
  // Everything that still wants a person: uncertain matches and genuinely new
  // products. Charges are not pending — they are deliberately never products.
  const pending = pendingCount(rows, already);
  // Stamped whenever nothing is left to decide, not only when something went
  // in. An invoice carrying nothing but a delivery fee imports nothing and is
  // finished the moment it is read; under the old rule it never earned the
  // stamp, so the list and the dashboard advertised product work that the
  // import screen then said did not exist.
  if (!pending) db.prepare("UPDATE m_invoices SET lines_imported = datetime('now') WHERE id = ?").run(invoiceId);
  return { added, pending };
}

// --- one-time repair -------------------------------------------------------
// The stamp above used to require that a line actually went in, so an invoice
// carrying nothing but charges never earned it: nothing to import, and yet
// listed as needing product review for good. The rule is fixed for everything
// read from here on. These are the invoices already on disk under the old one,
// and they will never be re-read, so nothing else would ever correct them.
//
// Only the flag moves. No purchase is written, no price recalculated, no line
// imported — and an invoice is touched only when every line still outstanding
// is a charge, which is exactly the case where there was never anything to
// import. Anything uncertain, anything new, or a confident line that somehow
// missed its import all leave the invoice alone, flagged, for a person.
const repairReviewFlags = db.transaction(() => {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'invoice_review_flag_repaired'").get()) return 0;
  const stale = db.prepare(`SELECT * FROM m_invoices
    WHERE ai_lines IS NOT NULL AND ai_lines <> '' AND ai_lines <> '[]'
      AND COALESCE(lines_imported, 0) = 0`).all();
  const products = prodQ.plain.all();
  const stamp = db.prepare("UPDATE m_invoices SET lines_imported = datetime('now') WHERE id = ?");
  let n = 0;
  for (const inv of stale) {
    let lines = [];
    try { lines = JSON.parse(inv.ai_lines || '[]'); } catch { continue; }
    if (!lines.length) continue;
    const rows = reviewRows(lines, products, inv.vendor_id ? Number(inv.vendor_id) : null);
    if (pendingCount(rows, importedIdx(inv))) continue;
    stamp.run(inv.id);
    n++;
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('invoice_review_flag_repaired', ?)").run(String(n));
  return n;
});
try {
  const repaired = repairReviewFlags();
  if (repaired) console.log(`[invoices] ${repaired} invoice${repaired === 1 ? '' : 's'} had no product work left; review flag cleared.`);
} catch (e) { console.error('[invoices] review-flag repair skipped:', e.message); }

app.get('/c/invoices/:id/import', (req, res) => {
  const inv = invQ.one.get(Number(req.params.id));
  if (!inv) return res.status(404).send(layout('Not found', '<div class="empty2"><div class="empty2-t">No such invoice</div></div>'));
  let lines = [];
  try { lines = JSON.parse(inv.ai_lines || '[]'); } catch { lines = []; }
  const already = prodQ.purchasesForInvoice.all(inv.id);
  const products = prodQ.plain.all();
  const allRows = reviewRows(lines, products, inv.vendor_id ? Number(inv.vendor_id) : null);
  // The confident lines went in when the invoice was saved. What's on this
  // screen is only what a person still has to decide — showing the rest again
  // would be asking twice for the same answer.
  const done = importedIdx(inv);
  // Charges used to be dropped from this screen altogether. They still default
  // to skip and still import nothing — but a delivery fee the reader mistook
  // for a line item was invisible and unfixable, so they are shown, folded
  // away, and overridable.
  const rows = allRows.filter((r) => !done.has(r.i) && r.confidence !== 'high');
  const vendors = invQ.vendors.all();
  const vName = new Map(vendors.map((v) => [Number(v.id), v.name]));

  const head = `
    ${flash(req)}
    <div class="bs-head bs-ihead">
      <div class="bs-headwrap">
        <a class="bs-act bs-back" href="/c/invoices">← Invoices</a>
        <h1 class="bs-headline">Import products</h1>
        <p class="bs-subline">${esc(vName.get(Number(inv.vendor_id)) || 'Invoice')}${inv.invoice_number ? ' · ' + esc(inv.invoice_number) : ''}${inv.invoice_date ? ' · ' + esc(inv.invoice_date) : ''}</p>
      </div>
    </div>`;

  // Charges are on the screen now, but they are not work: they import nothing
  // and default to skip. An invoice whose only leftovers are a delivery fee is
  // finished, and should say so rather than showing a to-do list that cannot
  // be completed.
  const gAll = groupRows(rows);
  const outstanding = gAll.review.length + gAll.likelyNew.length;

  if (!outstanding && already.length) {
    return res.send(layout('Import products', `<div class="bs-page">${head}
      <div class="bs-note ok"><b>All products imported</b>
        <span>${already.length} line${already.length === 1 ? '' : 's'} from this invoice ${already.length === 1 ? 'is' : 'are'} in your product history. Nothing else needs a decision.</span></div>
      <div class="table-wrap"><table class="table bs-table">
        <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead>
        <tbody>${already.map((a) => `<tr><td><a href="/c/products/${a.product_id}">${esc(a.name)}</a></td>
          <td class="num">${a.qty || '—'}</td><td class="num">${a.unit_price_cents ? money(a.unit_price_cents) : '—'}</td>
          <td class="num">${money(a.total_cents)}</td></tr>`).join('')}</tbody></table></div>
      <form method="post" action="/c/invoices/${inv.id}/import/undo" class="bs-undo"
        onsubmit="return confirm('Remove these purchases from your product history?')">
        <button class="bs-btn-sm bs-danger" type="submit">Undo this import</button></form></div>`));
  }

  if (!outstanding) {
    return res.send(layout('Import products', `<div class="bs-page">${head}
      <div class="bs-blank"><b>${allRows.length ? 'Nothing left to decide' : 'No line items on this invoice'}</b>
        <span>The reader either couldn't make out the item table, or this invoice was entered by hand. You can still add purchases from a product's own page.</span>
        <a class="bs-btn-sm" href="/c/products" style="margin-top:14px">Go to Products</a></div></div>`));
  }

  const g = gAll;
  const aliases = aliasIndex();
  const skipped = g.charges.length;

  // Reasons the matcher already produced, as chips rather than a comma list —
  // "different pack size" is the whole answer to "why is this uncertain", and
  // it was being truncated into prose.
  const WHY_TONE = (t) => (/^different|likely duplicate/.test(t) ? ' why-warn'
    : /^same|matches|% of the words/.test(t) ? ' why-ok' : '');
  const whyChips = (why) => (why || []).slice(0, 4)
    .map((t) => `<span class="why${WHY_TONE(t)}">${esc(t)}</span>`).join('');

  const facts = (r) => [r.code ? `#${esc(r.code)}` : '', r.brand ? esc(r.brand) : '', r.pack_size ? esc(r.pack_size) : '']
    .filter(Boolean).join(' · ');

  const line = (r, opts = {}) => {
    // Near-misses only for lines about to become a new product: that is the
    // only moment a duplicate gets created.
    const near = opts.warnDupes
      ? nearMisses({ desc: r.desc, code: r.code, brand: r.brand, pack_size: r.pack_size,
          unit: r.unit, vendor_id: inv.vendor_id ? Number(inv.vendor_id) : null }, products, aliases)
      : [];
    return `
    <div class="iline${opts.ask ? ' iline-ask' : ''}${near.length ? ' iline-dupe' : ''}" data-row="${r.i}">
      <div class="iline-l">
        <div class="iline-d">${esc(r.desc) || '<i>no description</i>'}</div>
        <div class="iline-m">${facts(r) ? facts(r) + ' · ' : ''}${r.qty ? `${r.qty}${r.unit ? ' ' + esc(r.unit) : ''} · ` : ''}${r.unit_price_cents ? money(r.unit_price_cents) + ' each · ' : ''}<b>${money(r.total_cents)}</b></div>
        ${r.match ? `<div class="iline-why"><span class="iline-sug">Looks like <b>${esc(r.match.name)}</b></span>${whyChips(r.why)}</div>` : ''}
        ${near.length ? `<div class="iline-dup">
          <b>Already have something close</b> — creating this makes a second record.
          ${near.map((d) => `<label class="dupopt">
            <input type="radio" name="pick_${r.i}" data-picks="${d.product.id}">
            <span>Use <b>${esc(d.product.name)}</b></span>${whyChips(d.why)}</label>`).join('')}
          ${/* Without a way back, picking one of these was a one-way door. */''}
          <label class="dupopt"><input type="radio" name="pick_${r.i}" data-picks="" checked>
            <span>Create it as new anyway</span></label>
        </div>` : ''}
      </div>
      <div class="iline-r">
        ${/* A tick, not a dropdown, where the only two answers are yes and no.
              These lines have no match — "Add to existing" was rendered
              disabled on every one of them — so the dropdown was really a
              two-item menu that read like a decision already taken: it said
              "Create new product" whether or not you had looked at it. Six
              lines you did not want were six menus to hunt down and change.

              Unticked posts no action_N at all, which the handler already
              treats exactly as skip, so nothing here needed a server change
              and the box works with no JavaScript at all. */''}
        ${opts.pick ? `<label class="ipick">
          <input type="checkbox" name="action_${r.i}" value="create" class="ipick-b">
          <span class="ipick-t">Create</span></label>
          ${near.length ? `<input type="hidden" name="product_${r.i}" value="">` : ''}`
        : `<select name="action_${r.i}" class="minisel iline-act"${opts.ask ? ' required' : ''}>
          ${opts.ask ? '<option value="" selected>Choose…</option>' : ''}
          <option value="match"${r.action === 'match' ? ' selected' : ''}${r.match ? '' : ' disabled'}>Add to existing</option>
          <option value="create"${r.action === 'create' ? ' selected' : ''}>Create new product</option>
          <option value="skip"${r.action === 'skip' ? ' selected' : ''}>Skip</option>
        </select>`}
        ${/* Which product to add it to — only ever meaningful when there is a
              product to add it to. It used to render on every row, listing the
              whole catalogue next to lines that had no match and could not be
              matched, so it read as a question with no bearing on anything. */''}
        ${r.match && !opts.pick ? `<select name="product_${r.i}" class="minisel iline-prod">
          ${products.map((p) => `<option value="${p.id}"${r.match.id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>` : ''}
        <input type="hidden" name="desc_${r.i}" value="${esc(r.desc)}">
        <input type="hidden" name="code_${r.i}" value="${esc(r.code || '')}">
        <input type="hidden" name="brand_${r.i}" value="${esc(r.brand || '')}">
        <input type="hidden" name="pack_${r.i}" value="${esc(r.pack_size || '')}">
        <input type="hidden" name="qty_${r.i}" value="${r.qty || ''}">
        <input type="hidden" name="unit_${r.i}" value="${esc(r.unit || '')}">
        <input type="hidden" name="total_${r.i}" value="${r.total_cents}">
        <input type="hidden" name="price_${r.i}" value="${r.unit_price_cents || ''}">
        ${r.fee && !r.match ? '<span class="iline-tag fee">not a product</span>'
          : opts.ask ? '<span class="iline-tag ask">not sure</span>'
          : '<span class="iline-tag new">new</span>'}
      </div>
    </div>`;
  };

  // Bulk actions only ever set the same <select> values a person would click,
  // so the form posts exactly what it always did and the server is untouched.
  const group = (key, title, sub, list, opts, bulk) => (list.length ? `
    <section class="igroup" data-group="${key}">
      <div class="igroup-h">
        <span class="igroup-t">${title}</span>
        <span class="igroup-n">${list.length}</span>
        ${bulk ? (bulk.toggle
          ? `<button type="button" class="btn btn-sm btn-ghost ibulk" data-group="${key}" data-toggle="1">${bulk.label}</button>`
          : `<button type="button" class="btn btn-sm btn-ghost ibulk" data-group="${key}" data-set="${bulk.set}">${bulk.label}</button>`) : ''}
      </div>
      ${sub ? `<p class="igroup-s">${sub}</p>` : ''}
      <div class="ilines">${list.map((r) => line(r, opts)).join('')}</div>
    </section>` : '');

  const body = [
    group('review', 'Needs your decision', 'A close but uncertain match. Nothing here imports until you choose.',
      g.review, { ask: true }, { set: 'match', label: 'Accept all suggested matches' }),
    group('new', 'Likely new products', 'No existing product came close. Tick the ones you want in Products — nothing here is created unless you tick it.',
      g.likelyNew, { warnDupes: true, pick: true }, { toggle: true, label: 'Select all' }),
    group('charges', 'Charges and fees', 'Read from the invoice but not stock — skipped unless you say otherwise.',
      g.charges, {}, { set: 'skip', label: 'Skip all' }),
  ].join('');

  const ask = g.review.length;
  res.send(layout('Import products', `<div class="bs-page">${head}
    ${/* Green means finished. Lines still waiting are not finished, so the
           no-uncertain-lines case is plain rather than reassuring. */''}
    <div class="bs-note${ask ? ' ask' : ''}"><b>${
      ask ? `${ask} line${ask === 1 ? '' : 's'} need${ask === 1 ? 's' : ''} your decision`
          : `${rows.length} line${rows.length === 1 ? '' : 's'} left to import`}</b>
      <span>${already.length ? `${already.length} confident line${already.length === 1 ? ' was' : 's were'} imported automatically when you saved. ` : ''}${
        g.likelyNew.length ? `${g.likelyNew.length} look${g.likelyNew.length === 1 ? 's' : ''} new — tick the ones you want. ` : ''}${
        skipped ? `${skipped} look${skipped === 1 ? 's' : ''} like a charge and will be skipped. ` : ''}Nothing is saved until you press Import.</span></div>
    <form method="post" action="/c/invoices/${inv.id}/import" id="importform">
      <input type="hidden" name="count" value="${rows.length}">
      <input type="hidden" name="idx" value="${rows.map((r) => r.i).join(',')}">
      ${body}
      <div class="stickybar stickybar-keep">
        <div class="sticky-in">
          <div class="sticky-txt">
            <b><span id="impn2">0</span> selected</b>
            <span>Nothing is saved until you press Import.</span>
          </div>
          <div class="sticky-acts">
            <a class="btn btn-ghost" href="/c/invoices">Cancel</a>
            ${/* One text node, not four. .btn is a flex row with a gap, so
                   "Import ", <span>0</span>, " line", <span>s</span> came out
                   spaced as "Import 0 line s". */''}
            <button class="btn btn-primary" type="submit"><span id="impbtn">Import 0 lines</span></button>
          </div>
        </div>
      </div>
    </form>
    </div>
    ${importScript()}`));
});

/**
 * Bulk actions and the live count.
 *
 * Everything here sets the value of a <select> that is already on the page —
 * the same thing a person does by hand. The form posts exactly the fields it
 * always did, so the server never learns that a button was involved and the
 * import logic is untouched.
 */
function importScript() {
  return `<script>
  (function () {
    var form = document.getElementById('importform');
    if (!form) return;

    // Only ever show the product menu when there is a product to choose. On a
    // row set to create or skip it is answering a question nobody asked.
    function syncProd(sel) {
      var row = sel.closest('[data-row]');
      var prod = row && row.querySelector('.iline-prod');
      if (prod) prod.style.display = sel.value === 'match' ? '' : 'none';
    }

    function recount() {
      var n = 0;
      form.querySelectorAll('select.iline-act').forEach(function (sel) {
        if (sel.value === 'match' || sel.value === 'create') n++;
      });
      form.querySelectorAll('.ipick-b').forEach(function (cb) { if (cb.checked) n++; });
      var b = document.getElementById('impbtn');
      if (b) b.textContent = 'Import ' + n + ' line' + (n === 1 ? '' : 's');
      var el2 = document.getElementById('impn2');
      if (el2) el2.textContent = n;
    }

    form.addEventListener('click', function (e) {
      var b = e.target.closest('.ibulk');
      if (!b) return;
      var scope = form.querySelector('[data-group="' + b.dataset.group + '"]');
      if (!scope) return;
      if (b.dataset.toggle) {
        // Select all, then clear — the same button, because after ticking
        // everything the next thing anyone wants is to untick everything.
        var boxes = scope.querySelectorAll('.ipick-b');
        var every = boxes.length && [].every.call(boxes, function (c) { return c.checked; });
        boxes.forEach(function (c) { c.checked = !every; });
        b.textContent = every ? 'Select all' : 'Clear all';
      } else {
        scope.querySelectorAll('select.iline-act').forEach(function (sel) {
          // Never choose "add to existing" where there is nothing to add it to.
          var opt = sel.querySelector('option[value="' + b.dataset.set + '"]');
          if (opt && !opt.disabled) { sel.value = b.dataset.set; syncProd(sel); }
        });
      }
      recount();
    });

    // The duplicate radios are a shortcut for "match, and use this product".
    form.addEventListener('change', function (e) {
      if (e.target.matches('.dupopt input[type="radio"]')) {
        var row = e.target.closest('[data-row]');
        var picks = e.target.dataset.picks;
        var act = row.querySelector('select.iline-act');
        var box = row.querySelector('.ipick-b');
        var prod = row.querySelector('[name^="product_"]');
        if (prod) prod.value = picks;
        // On a tick-box row the box IS the action, so the choice moves its
        // value rather than a menu's: ticked and "match" adds to the product
        // you picked, ticked and "create" makes a new one.
        if (box) {
          box.value = picks ? 'match' : 'create';
          if (picks) box.checked = true;
          var t = row.querySelector('.ipick-t');
          if (t) t.textContent = picks ? 'Use existing' : 'Create';
        } else if (act) {
          act.value = 'match';
          syncProd(act);
        }
      }
      if (e.target.matches('select.iline-act')) { syncProd(e.target); recount(); }
      if (e.target.matches('.ipick-b')) recount();
    });

    form.querySelectorAll('select.iline-act').forEach(syncProd);
    recount();
  })();
  </script>`;
}

app.post('/c/invoices/:id/import', (req, res) => {
  const inv = invQ.one.get(Number(req.params.id));
  if (!inv) return res.status(404).end();
  // Confident lines are already in from the save, so a whole-invoice refusal
  // would block the leftovers. Duplicates are avoided per line instead.
  const seen = importedIdx(inv);
  // Which lines this form actually carried.
  //
  // The fields are named for the line's index in the WHOLE invoice —
  // action_3, action_7 — because that is what `seen` is keyed on. The loop
  // used to run 0..count-1, where count was the number of rows on screen. The
  // two only line up when the reviewable lines happen to be the first ones, so
  // any decision on a line past that position was read as undefined and thrown
  // away: the operator chose, pressed Import, and was told "Imported 0 lines".
  //
  // The form now states its indexes. `count` is still honoured for a page that
  // was already open when this shipped, so nobody loses a screen of work.
  const listed = String(req.body.idx || '').split(',').map(Number).filter(Number.isInteger);
  const n = Number(req.body.count) || 0;
  const indexes = listed.length ? listed : Array.from({ length: n }, (_, i) => i);
  const vendorId = inv.vendor_id ? Number(inv.vendor_id) : null;
  const on = inv.invoice_date || isoDate(startOfToday());

  const touchedProducts = new Set();
  const run = db.transaction(() => {
    let added = 0, created = 0;
    for (const i of indexes) {
      const action = req.body[`action_${i}`];
      if (action !== 'match' && action !== 'create') continue;
      const desc = (req.body[`desc_${i}`] || '').trim();
      const total = Number(req.body[`total_${i}`]) || 0;
      if (!desc && action === 'create') continue;
      if (seen.has(i)) continue;                 // already imported on save

      let productId;
      if (action === 'create') {
        // Someone may have created it a moment ago on another line, or it may
        // already exist under exactly this name — reuse rather than collide
        // with the unique index on name.
        const existing = prodQ.byName.get(desc);
        productId = existing ? existing.id : prodQ.add.run({
          name: desc, category: inv.category === 'Food' ? null : inv.category || null,
          vendor_id: vendorId, unit: (req.body[`unit_${i}`] || '').trim() || null,
          pack_size: (req.body[`pack_${i}`] || '').trim() || null,
          sku: (req.body[`code_${i}`] || '').trim() || null,
          brand: (req.body[`brand_${i}`] || '').trim() || null, notes: null,
        }).lastInsertRowid;
        if (!existing) created++;
      } else {
        productId = Number(req.body[`product_${i}`]);
        if (!productId) continue;
      }
      const qty = Number(req.body[`qty_${i}`]) > 0 ? Number(req.body[`qty_${i}`]) : null;
      const price = Number(req.body[`price_${i}`]) > 0 ? Number(req.body[`price_${i}`])
        : qty && total ? Math.round(total / qty) : null;
      prodQ.addPurchase.run({
        product_id: productId, invoice_id: inv.id, vendor_id: vendorId,
        purchased_on: on, qty, unit: (req.body[`unit_${i}`] || '').trim() || null,
        unit_price_cents: price, total_cents: total, raw_text: desc,
      });
      touchedProducts.add(productId);
      // Record what this vendor called it. Confirming a match once is what
      // makes the next invoice from them recognise the line outright instead
      // of asking the same question again.
      learnAlias(productId, vendorId, (req.body[`code_${i}`] || '').trim(), desc);
      seen.add(i);
      added++;
    }
    saveIdx(inv.id, seen);
    db.prepare("UPDATE m_invoices SET lines_imported = datetime('now') WHERE id = ?").run(inv.id);
    return { added, created, products: [...touchedProducts] };
  });
  const { added, created, products } = run();
  try { MENU.recalcForProducts(products, 'invoice'); }
  catch (e) { console.error('[menu] recalc after import failed:', e.message); }
  res.redirect('/c/products?msg=' + encodeURIComponent(
    `Imported ${added} line${added === 1 ? '' : 's'}${created ? `, ${created} new product${created === 1 ? '' : 's'}` : ''}.`));
});

app.post('/c/invoices/:id/import/undo', (req, res) => {
  const id = Number(req.params.id);
  prodQ.clearInvoice.run(id);
  db.prepare('UPDATE m_invoices SET lines_imported = NULL, imported_idx = NULL WHERE id = ?').run(id);
  // Products the import created are left alone. One may have been renamed or
  // categorised since, and deleting someone's work to tidy up is the worse
  // mistake — the "Never bought" filter on Products finds any strays.
  res.redirect(`/c/invoices/${id}/import?msg=` + encodeURIComponent(
    'Import undone. Any products it created are still listed, now with no purchases.'));
});


// ---------------------------------------------------------------------------
// MENU COSTING — routes.
//
// Marked BETA in the nav on purpose. The arithmetic is well covered, but this
// is the first module where a wrong answer is a pricing decision rather than a
// display bug, and it wants real use before it is trusted quietly.
// ---------------------------------------------------------------------------
const MENU = require('./menu');
const menuUsedBy = MENU.usedBy;
const UNITS = require('./units');

const MENU_CAT_COLORS = {
  Breakfast: { color: '#d97706', tint: '#fffbeb' }, Sandwiches: { color: '#a16207', tint: '#fefce8' },
  Bowls: { color: '#16a34a', tint: '#f0fdf4' }, Salads: { color: '#059669', tint: '#ecfdf5' },
  Sides: { color: '#0891b2', tint: '#ecfeff' }, Desserts: { color: '#db2777', tint: '#fdf2f8' },
  Beverages: { color: '#0ea5e9', tint: '#f0f9ff' }, Cocktails: { color: '#7c3aed', tint: '#f5f3ff' },
  Other: { color: '#6b7280', tint: '#f9fafb' },
};
const menuCat = (c) => MENU_CAT_COLORS[c] || MENU_CAT_COLORS.Other;
const pct1 = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1) + '%');

/** Cost every menu item once. Small n, and the pages all want the same thing. */
function costAll() {
  return MENU.q.all.all().map((m) => MENU.costItem(m.id));
}

// --- list ------------------------------------------------------------------
app.get('/menu', (req, res) => {
  const all = costAll();
  const live = all.filter((c) => c.item.status !== 'archived');
  const priced = live.filter((c) => c.foodCostPct != null && !c.unresolved);
  const avgFc = priced.length ? priced.reduce((a, c) => a + c.foodCostPct, 0) / priced.length : null;
  const over = priced.filter((c) => c.foodCostPct > c.target);
  const incomplete = live.filter((c) => c.unresolved);
  const best = [...priced].filter((c) => c.grossProfit != null).sort((a, b) => b.grossProfit - a.grossProfit)[0];

  const card = (tone, ico, label, value, sub) => `
    <div class="mcard mcard-${tone}"><div class="mcard-ico">${icon(ico)}</div>
      <div class="mcard-body"><div class="mcard-label">${label}</div>
        <div class="mcard-value">${value}</div><div class="mcard-sub">${sub}</div></div></div>`;

  const cards = `<div class="mcards mcards-4">
    ${card('blue', 'costs', 'Average food cost', avgFc == null ? '—' : pct1(avgFc),
      priced.length ? `across ${priced.length} costed item${priced.length === 1 ? '' : 's'}` : 'nothing costed yet')}
    ${card(over.length ? 'amber' : 'green', 'sales', 'Above target', String(over.length),
      priced.length ? `of ${priced.length} with a target` : 'none to compare')}
    ${card('green', 'payroll', 'Best gross profit', best ? money(best.grossProfit) : '—',
      best ? esc(best.item.name) : 'needs a price and a recipe')}
    ${card(incomplete.length ? 'red' : 'green', incomplete.length ? 'incidents' : 'policy', 'Cost incomplete',
      String(incomplete.length), incomplete.length ? 'components without a price' : 'every recipe costs')}
  </div>`;

  const usedCats = [...new Set(all.map((c) => c.item.category).filter(Boolean))].sort();
  const rows = all.map((c) => {
    const m = c.item, cc = menuCat(m.category);
    const search = [m.name, m.category, m.status, m.is_prep ? 'prep' : ''].filter(Boolean).join(' ').toLowerCase();
    return `<a class="pitem" href="/menu/${m.id}"
        data-menu data-search="${esc(search)}" data-cat="${esc(m.category || '')}"
        data-status="${esc(m.status)}" data-cost="${c.status.key}"
        data-fc="${c.foodCostPct == null ? -1 : c.foodCostPct.toFixed(2)}"
        data-gp="${c.grossProfit == null ? -1 : c.grossProfit}" data-name="${esc(m.name.toLowerCase())}">
      <span class="pitem-main">
        <span class="pitem-n">${esc(m.name)}${m.is_prep ? ' <span class="prep-tag">prep</span>' : ''}</span>
        <span class="pitem-meta">
          ${m.category ? `<span class="pchip" style="--c:${cc.color};--ct:${cc.tint}">${esc(m.category)}</span>` : ''}
          <span class="pill ${c.status.cls}">${c.status.label}</span>
          ${m.status === 'draft' ? '<span class="pill">Draft</span>' : ''}
          ${m.status === 'archived' ? '<span class="pill">Archived</span>' : ''}
          <span class="pitem-u">${c.lines.length} component${c.lines.length === 1 ? '' : 's'}</span>
        </span>
      </span>
      <span class="pitem-f">
        <span class="pf"><i>Price</i><b>${m.selling_price_cents ? money(m.selling_price_cents) : '—'}</b></span>
        <span class="pf"><i>Cost</i><b>${c.lines.length ? money(c.totalCents) + (c.unresolved ? '+' : '') : '—'}</b></span>
        <span class="pf"><i>Food cost</i><b>${c.unresolved ? '<span class="tr tr-none">—</span>' : pct1(c.foodCostPct)}</b></span>
        <span class="pf"><i>Gross profit</i><b>${c.grossProfit == null ? '—' : money(c.grossProfit)}</b></span>
        <span class="pf pf-w"><i>Target</i><b>${pct1(c.target)}</b></span>
      </span>
      <span class="pitem-go">›</span>
    </a>`;
  }).join('');

  const toolbar = `
    <div class="toolbar2">
      <div class="searchbox">${icon('search')}<input id="msearch" type="search" placeholder="Search a menu item..." autocomplete="off"></div>
      <select id="msort" class="minisel">
        <option value="name">Sort: name</option>
        <option value="fc">Sort: highest food cost</option>
        <option value="gp">Sort: best gross profit</option>
      </select>
    </div>
    <div class="fchips">
      <button class="fchip on" data-f="all" data-v="" style="--c:var(--ink-2);--ct:var(--surface-3)">All<span class="fcount">${all.length}</span></button>
      <button class="fchip" data-f="status" data-v="active" style="--c:#059669;--ct:#ecfdf5"><i class="fdot"></i>Active</button>
      <button class="fchip" data-f="status" data-v="draft" style="--c:#64748b;--ct:#f8fafc"><i class="fdot"></i>Draft</button>
      <button class="fchip" data-f="status" data-v="archived" style="--c:#6b7280;--ct:#f9fafb"><i class="fdot"></i>Archived</button>
      <button class="fchip" data-f="cost" data-v="on" style="--c:#059669;--ct:#ecfdf5"><i class="fdot"></i>On target</button>
      <button class="fchip" data-f="cost" data-v="over" style="--c:#dc2626;--ct:#fef2f2"><i class="fdot"></i>Above target</button>
      <button class="fchip" data-f="cost" data-v="missing" style="--c:#d97706;--ct:#fffbeb"><i class="fdot"></i>Missing cost</button>
      ${usedCats.map((x) => { const k = menuCat(x); return `<button class="fchip" data-f="cat" data-v="${esc(x)}" style="--c:${k.color};--ct:${k.tint}"><i class="fdot"></i>${esc(x)}</button>`; }).join('')}
    </div>`;

  const body = all.length
    ? `${cards}${toolbar}<div class="pitems" id="mlist">${rows}</div>
       <div class="empty2" id="mnone" style="display:none"><div class="empty2-t">Nothing matches</div><div class="empty2-s">Try a different search or filter.</div></div>`
    : `<div class="upload-hero">
        <div class="uh-ico">${icon('costs')}</div>
        <div class="uh-t">No menu items yet</div>
        <div class="uh-s">${canWrite()
          ? 'Build a recipe from the products you already buy and it will tell you what the dish costs — and keep telling you as prices move.'
          : 'Once menu items are added, what each dish costs shows up here.'}</div>
        ${canWrite() ? `<a class="btn btn-primary btn-lg" href="/menu/new">＋ Create your first menu item</a>` : ''}
      </div>`;

  res.send(layout('Menu costing', `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t"><h1>Menu costing <span class="beta">BETA</span></h1>
        <p class="phead-s">What each dish costs to make, from the prices you actually paid.</p></div>
      ${canWrite() ? `<a class="btn btn-primary" href="/menu/new">＋ Create menu item</a>` : ''}
    </div>
    ${body}
    <script>${menuListScript()}</script>`));
});

function menuListScript() {
  return `(function(){
    var q='', mode='all', val='';
    var list=document.getElementById('mlist'); if(!list) return;
    var rows=[].slice.call(list.querySelectorAll('[data-menu]'));
    var none=document.getElementById('mnone');
    function pass(el){
      if(q && el.dataset.search.indexOf(q)<0) return false;
      if(mode==='status' && el.dataset.status!==val) return false;
      if(mode==='cat' && el.dataset.cat!==val) return false;
      if(mode==='cost' && el.dataset.cost!==val) return false;
      return true;
    }
    function apply(){ var n=0; rows.forEach(function(el){ var ok=pass(el); el.style.display=ok?'':'none'; if(ok)n++; });
      if(none) none.style.display=n?'none':''; }
    var s=document.getElementById('msearch');
    if(s) s.addEventListener('input', function(){ q=this.value.trim().toLowerCase(); apply(); });
    document.querySelectorAll('.fchip').forEach(function(c){ c.addEventListener('click', function(){
      document.querySelectorAll('.fchip').forEach(function(x){ x.classList.remove('on'); });
      c.classList.add('on'); mode=c.dataset.f; val=c.dataset.v; apply(); }); });
    var so=document.getElementById('msort');
    if(so) so.addEventListener('change', function(){
      var k=this.value, num=function(el,a){ return parseFloat(el.dataset[a]||'-1'); };
      rows.slice().sort(function(a,b){
        if(k==='name') return (a.dataset.name||'').localeCompare(b.dataset.name||'');
        return num(b,k)-num(a,k);
      }).forEach(function(el){ list.appendChild(el); });
    });
  })();`;
}

// --- create / edit workspace ------------------------------------------------
// A full page, not a modal: building a recipe means looking at a growing cost
// while you add to it, and a dialog can't hold that.

/** Everything the ingredient picker can offer, products and preps together. */
function pickerOptions(excludeItemId) {
  const out = [];
  for (const p of prodQ.plain.all()) {
    const price = MENU_priceLabel(p);
    out.push({
      kind: 'product', id: p.id, name: p.name,
      meta: [p.brand, p.vendor_name, p.pack_size || p.unit].filter(Boolean).join(' · '),
      price: price.text, source: price.source, units: PRODUCTS.costableUnits(p),
      search: [p.name, p.brand, p.sku, p.pack_size, p.unit, p.category].filter(Boolean).join(' ').toLowerCase(),
    });
  }
  for (const m of MENU.q.preps.all()) {
    if (m.id === excludeItemId) continue;            // a prep can't contain itself
    const c = MENU.costItem(m.id);
    const per = m.prep_yield_qty > 0 ? c.totalMicros / m.prep_yield_qty : null;
    out.push({
      kind: 'prep', id: m.id, name: m.name,
      meta: m.prep_yield_qty ? `house prep · makes ${UNITS.fmtQty(m.prep_yield_qty)} ${UNITS.unitLabel(m.prep_yield_unit)}` : 'house prep',
      price: per && !c.unresolved ? money(UNITS.microsToCents(per)) + ' / ' + UNITS.unitLabel(m.prep_yield_unit) : 'cost incomplete',
      source: 'prep', units: m.prep_yield_unit ? [m.prep_yield_unit] : [],
      search: (m.name + ' prep').toLowerCase(),
    });
  }
  return out;
}
const PRODUCTS = require('./products');
function MENU_priceLabel(p) {
  const pr = PRODUCTS.priceOf(p);
  if (!pr) return { text: 'no price yet', source: 'none' };
  return { text: money(UNITS.microsToCents(pr.micros)) + ' / ' + UNITS.unitLabel(pr.unit || p.unit || 'unit'), source: pr.source };
}

const UNIT_OPTIONS = UNITS.UNIT_GROUPS.map((g) =>
  `<optgroup label="${g.label}">${g.units.map((u) => `<option value="${u}">${UNITS.unitLabel(u)}</option>`).join('')}</optgroup>`).join('');

function menuForm(m, comps, req) {
  const isNew = !m.id;
  const opts = pickerOptions(m.id || 0);
  const vendors = invQ.vendors.all();
  const cost = m.id ? MENU.costItem(m.id) : null;

  const lineRow = (c, i) => {
    const label = c.label || '';
    return `<div class="rline" data-line data-i="${i}">
      <span class="rl-drag" title="Drag to reorder">⋮⋮</span>
      <div class="rl-name">
        <b>${esc(label)}</b>
        <input type="hidden" name="ref_${i}" value="${c.refItemId ? 'i' + c.refItemId : 'p' + c.productId}">
        <span class="rl-meta">${esc(c.meta || '')}</span>
      </div>
      <select name="group_${i}" class="minisel rl-group">
        ${['', ...MENU.GROUPS].map((g) => `<option value="${esc(g)}"${(c.group || '') === g ? ' selected' : ''}>${g || 'No section'}</option>`).join('')}
      </select>
      <select name="type_${i}" class="minisel rl-type">
        ${MENU.TYPES.map((t) => `<option value="${t}"${c.type === t ? ' selected' : ''}>${MENU.TYPE_LABEL[t]}</option>`).join('')}
      </select>
      <input class="rl-qty" name="qty_${i}" type="number" step="0.001" min="0" value="${c.qty ?? ''}" placeholder="0">
      <select name="unit_${i}" class="minisel rl-unit">${UNIT_OPTIONS}</select>
      <span class="rl-cost" data-cost>—</span>
      <button type="button" class="rl-del" title="Remove" onclick="mnRemove(this)">✕</button>
      <details class="rl-adv">
        <summary>advanced</summary>
        <div class="rl-adv-b">
          <label>Waste %<input name="waste_${i}" type="number" step="0.1" min="0" max="99" value="${c.wastePct ?? ''}" placeholder="0"></label>
          <label>Prep note<input name="note_${i}" value="${esc(c.note || '')}" placeholder="optional"></label>
        </div>
      </details>
    </div>`;
  };

  return layout(isNew ? 'Create menu item' : `Edit ${m.name}`, `
    ${flash(req)}
    <form method="post" action="${isNew ? '/menu' : `/menu/${m.id}`}" id="mnform">
    <div class="phead">
      <div class="phead-t">
        <a class="link back" href="${isNew ? '/menu' : `/menu/${m.id}`}">← ${isNew ? 'Menu costing' : esc(m.name)}</a>
        <h1>${isNew ? 'Create menu item' : 'Edit menu item'} <span class="beta">BETA</span></h1>
      </div>
    </div>

    <div class="mnwrap">
      <div class="mnmain">
        <section class="panel">
          <div class="panel-h"><b>The item</b></div>
          <div class="fld-row">
            <label class="fld">Name<input name="name" required value="${esc(m.name || '')}" placeholder="e.g. PV Breakfast Sandwich"></label>
            <label class="fld">Category
              <input name="category" list="mn-cats" value="${esc(m.category || '')}" placeholder="Breakfast">
              <datalist id="mn-cats">${MENU.CATEGORIES.map((c) => `<option value="${c}">`).join('')}</datalist>
            </label>
          </div>
          <div class="fld-row3">
            <label class="fld">Selling price<input name="price" id="mn-price" type="number" step="0.01" min="0"
              value="${m.selling_price_cents ? (m.selling_price_cents / 100).toFixed(2) : ''}" placeholder="0.00"></label>
            <label class="fld">Target food cost %<input name="target" id="mn-target" type="number" step="0.1" min="1" max="100"
              value="${m.target_food_cost_pct ?? MENU.DEFAULT_TARGET}"></label>
            <label class="fld">Status<select name="status" id="mn-status">
              ${MENU.STATUSES.map((s) => `<option value="${s}"${(m.status || 'draft') === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
            </select></label>
          </div>
          <label class="fcheck"><input type="checkbox" name="is_prep" id="mn-isprep" value="1"${m.is_prep ? ' checked' : ''}>
            This is a house prep other items use as an ingredient</label>
          <div class="fld-row" id="mn-prepyield" style="${m.is_prep ? '' : 'display:none'}">
            <label class="fld">One batch makes<input name="yield_qty" type="number" step="0.01" min="0" value="${m.prep_yield_qty ?? ''}" placeholder="32"></label>
            <label class="fld">of<select name="yield_unit">${UNIT_OPTIONS}</select></label>
          </div>
          <label class="fld">Description<textarea name="description" rows="2">${esc(m.description || '')}</textarea></label>
          <label class="fld">Internal notes<textarea name="notes" rows="2">${esc(m.notes || '')}</textarea></label>
        </section>

        <section class="panel">
          <div class="panel-h"><b>Recipe components</b><span class="panel-link muted" id="mn-count"></span></div>
          <div class="combo" id="mn-combo">
            ${icon('search')}
            <input id="mn-pick" type="search" autocomplete="off" placeholder="Search products or add an ingredient...">
            <div class="combo-menu" id="mn-menu" hidden></div>
          </div>
          <div class="rlines" id="mn-lines">${comps.map(lineRow).join('')}</div>
          <div class="rl-empty" id="mn-empty"${comps.length ? ' hidden' : ''}>Nothing added yet. Search above to build the recipe.</div>
        </section>
      </div>

      <aside class="mnside">
        <div class="mncost" id="mn-summary">
          <div class="mnc-h">Cost summary</div>
          <div class="mnc-row"><span>Selling price</span><b id="s-sell">—</b></div>
          <div class="mnc-row"><span>Ingredients</span><b id="s-ing">—</b></div>
          <div class="mnc-row"><span>Packaging</span><b id="s-pack">—</b></div>
          <div class="mnc-row"><span>Garnish &amp; condiments</span><b id="s-other">—</b></div>
          <div class="mnc-row mnc-total"><span>Total cost</span><b id="s-total">—</b></div>
          <div class="mnc-row"><span>Food cost</span><b id="s-fc">—</b></div>
          <div class="mnc-row"><span>Gross profit</span><b id="s-gp">—</b></div>
          <div class="mnc-row"><span>Gross margin</span><b id="s-gm">—</b></div>
          <div class="mnc-row"><span>Target</span><b id="s-target">—</b></div>
          <div class="mnc-row"><span>Suggested price</span><b id="s-sugg">—</b></div>
          <div class="mnc-status" id="s-status">Add components to see the cost</div>
          <div class="mnc-warn" id="s-warn" hidden></div>
          <div class="mnc-act">
            <button class="btn btn-primary" type="submit">${isNew ? 'Create menu item' : 'Save changes'}</button>
            <a class="btn btn-ghost" href="${isNew ? '/menu' : `/menu/${m.id}`}">Cancel</a>
          </div>
        </div>
      </aside>
    </div>
    <input type="hidden" name="count" id="mn-n" value="${comps.length}">
    </form>

    ${productDrawer(vendors)}
    <script>
      window.MN_OPTS = ${JSON.stringify(opts)};
      window.MN_UNIT_HTML = ${JSON.stringify(UNIT_OPTIONS)};
      window.MN_TYPES = ${JSON.stringify(MENU.TYPES.map((t) => [t, MENU.TYPE_LABEL[t]]))};
      window.MN_GROUPS = ${JSON.stringify(['', ...MENU.GROUPS])};
      window.MN_START = ${JSON.stringify(comps.map((c) => ({ unit: c.unit, ref: c.refItemId ? 'i' + c.refItemId : 'p' + c.productId })))};
    </script>
    <script>${menuEditScript()}</script>
    <script>${productListScript()}</script>`);
}

app.get('/menu/new', (req, res) => {
  if (!canWrite()) return res.redirect('/menu');
  res.send(menuForm({ status: 'draft', target_food_cost_pct: MENU.DEFAULT_TARGET }, [], req));
});

app.get('/menu/:id/edit', (req, res) => {
  const m = MENU.q.one.get(Number(req.params.id));
  if (!m) return res.status(404).send(layout('Not found', '<div class="empty2"><div class="empty2-t">No such menu item</div></div>'));
  if (!canWrite()) return res.redirect(`/menu/${m.id}`);
  const c = MENU.costItem(m.id);
  res.send(menuForm(m, c.lines.map((l) => ({ ...l, meta: [l.brand, l.vendor, l.packSize].filter(Boolean).join(' · ') })), req));
});

function menuEditScript() {
  return `
  var MN = { n: 0, seq: 0 };
  function mnMoney(c){ return '$' + (Math.round(c)/100).toFixed(2); }

  // --- the ingredient picker ------------------------------------------------
  // A combobox, because a select with four hundred products in it is a list you
  // scroll, not one you search. Recently used first, so the things you reach
  // for most are one keystroke away.
  function mnRecent(){ try { return JSON.parse(localStorage.getItem('mn_recent')||'[]'); } catch(e){ return []; } }
  function mnRemember(ref){
    var r = mnRecent().filter(function(x){ return x!==ref; });
    r.unshift(ref); try { localStorage.setItem('mn_recent', JSON.stringify(r.slice(0,8))); } catch(e){}
  }
  function mnRender(q){
    var menu = document.getElementById('mn-menu');
    var used = {}; document.querySelectorAll('#mn-lines [name^=ref_]').forEach(function(i){ used[i.value]=1; });
    var list = MN_OPTS.filter(function(o){ return !q || o.search.indexOf(q)>=0; });
    if(!q){
      var rec = mnRecent();
      list = list.slice().sort(function(a,b){
        var ai=rec.indexOf(a.kind[0]+a.id), bi=rec.indexOf(b.kind[0]+b.id);
        if(ai<0&&bi<0) return a.name.localeCompare(b.name);
        if(ai<0) return 1; if(bi<0) return -1; return ai-bi;
      });
    }
    var html = list.slice(0,40).map(function(o){
      var ref=o.kind[0]+o.id, isUsed=used[ref];
      var badge = o.source==='invoice' ? '<span class="cb-src cb-inv">invoice</span>'
        : o.source==='prep' ? '<span class="cb-src cb-prep">prep</span>'
        : o.source==='manual' ? '<span class="cb-src cb-man">manual</span>'
        : '<span class="cb-src cb-none">no price</span>';
      return '<button type="button" class="cb-opt'+(isUsed?' cb-used':'')+'" data-ref="'+ref+'"'+(isUsed?' disabled':'')+'>'
        + '<span class="cb-l"><b>'+o.name.replace(/[<>&]/g,'')+'</b><i>'+(o.meta||'').replace(/[<>&]/g,'')+'</i></span>'
        + '<span class="cb-r">'+badge+'<span class="cb-p">'+o.price+'</span>'+(isUsed?'<span class="cb-in">already in</span>':'')+'</span></button>';
    }).join('');
    // Creating a missing ingredient without leaving a half-built recipe is the
    // whole reason this is inline.
    html += '<button type="button" class="cb-opt cb-new" id="cb-create">＋ Create a product that isn\\'t on file</button>';
    menu.innerHTML = html || '<div class="cb-none">Nothing matches</div>' + html;
    menu.hidden = false;
  }
  function mnAdd(ref, unit){
    var o = MN_OPTS.filter(function(x){ return x.kind[0]+x.id===ref; })[0];
    if(!o) return;
    var i = MN.n++;
    var wrap = document.createElement('div');
    wrap.className='rline'; wrap.setAttribute('data-line',''); wrap.dataset.i=i;
    wrap.innerHTML = '<span class="rl-drag" title="Drag to reorder">⋮⋮</span>'
      + '<div class="rl-name"><b>'+o.name.replace(/[<>&]/g,'')+'</b>'
      + '<input type="hidden" name="ref_'+i+'" value="'+ref+'">'
      + '<span class="rl-meta">'+(o.meta||'').replace(/[<>&]/g,'')+'</span></div>'
      + '<select name="group_'+i+'" class="minisel rl-group">'+MN_GROUPS.map(function(g){return '<option value="'+g+'">'+(g||'No section')+'</option>';}).join('')+'</select>'
      + '<select name="type_'+i+'" class="minisel rl-type">'+MN_TYPES.map(function(t){return '<option value="'+t[0]+'">'+t[1]+'</option>';}).join('')+'</select>'
      + '<input class="rl-qty" name="qty_'+i+'" type="number" step="0.001" min="0" value="1">'
      + '<select name="unit_'+i+'" class="minisel rl-unit">'+MN_UNIT_HTML+'</select>'
      + '<span class="rl-cost" data-cost>—</span>'
      + '<button type="button" class="rl-del" title="Remove" onclick="mnRemove(this)">✕</button>'
      + '<details class="rl-adv"><summary>advanced</summary><div class="rl-adv-b">'
      + '<label>Waste %<input name="waste_'+i+'" type="number" step="0.1" min="0" max="99" placeholder="0"></label>'
      + '<label>Prep note<input name="note_'+i+'" placeholder="optional"></label></div></details>';
    document.getElementById('mn-lines').appendChild(wrap);
    // Default the unit to something this product can actually be costed in,
    // so a fresh line starts resolvable instead of starting broken.
    var us = wrap.querySelector('.rl-unit');
    var want = unit || (o.units && o.units[0]);
    if(want) us.value = want;
    if(/pack|wrap|cup|box|bag|container|lid|napkin/i.test(o.name)) wrap.querySelector('.rl-type').value='packaging';
    mnRemember(ref);
    document.getElementById('mn-empty').hidden = true;
    mnCost();
  }
  function mnRemove(btn){ btn.closest('[data-line]').remove(); mnCost(); }

  // --- live costing ---------------------------------------------------------
  // Asks the server, because the conversion rules and the price lookups live
  // there and a second copy in the browser is a second set of answers.
  var mnTimer;
  function mnCost(){
    clearTimeout(mnTimer);
    mnTimer = setTimeout(function(){
      var lines=[];
      document.querySelectorAll('#mn-lines [data-line]').forEach(function(el){
        lines.push({
          ref: el.querySelector('[name^=ref_]').value,
          type: el.querySelector('.rl-type').value,
          qty: parseFloat(el.querySelector('.rl-qty').value)||0,
          unit: el.querySelector('.rl-unit').value,
          waste: parseFloat((el.querySelector('[name^=waste_]')||{}).value)||0,
        });
      });
      document.getElementById('mn-count').textContent = lines.length ? lines.length+' component'+(lines.length===1?'':'s') : '';
      // Typing fast puts several of these in flight at once. Without a
      // sequence check a slow earlier reply can land last and paint a total
      // that does not match the recipe on screen — which is the one thing a
      // live cost panel must never do.
      var seq = ++MN.seq;
      fetch('/menu/cost', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ lines: lines,
          price: parseFloat(document.getElementById('mn-price').value)||0,
          target: parseFloat(document.getElementById('mn-target').value)||0 }) })
        .then(function(r){ return r.json(); })
        .then(function(d){ if(seq === MN.seq) mnPaint(d); })
        .catch(function(){ if(seq === MN.seq) document.getElementById('s-status').textContent='Could not work out the cost just now.'; });
    }, 220);
  }
  function mnPaint(d){
    var els = document.querySelectorAll('#mn-lines [data-line]');
    d.lines.forEach(function(l, i){
      var cell = els[i] && els[i].querySelector('[data-cost]');
      if(!cell) return;
      if(l.ok){ cell.textContent = mnMoney(l.cents); cell.className='rl-cost'; cell.removeAttribute('title'); }
      else { cell.textContent='needs setup'; cell.className='rl-cost rl-bad'; cell.title=l.reason||''; }
      if(els[i]) els[i].classList.toggle('rline-bad', !l.ok);
    });
    var set=function(id,v){ document.getElementById(id).textContent=v; };
    set('s-sell', d.sellCents?mnMoney(d.sellCents):'—');
    set('s-ing', mnMoney(d.ingredient)); set('s-pack', mnMoney(d.packaging)); set('s-other', mnMoney(d.other));
    set('s-total', mnMoney(d.totalCents) + (d.unresolved?'+':''));
    set('s-fc', d.foodCostPct==null?'—':d.foodCostPct.toFixed(1)+'%');
    set('s-gp', d.grossProfit==null?'—':mnMoney(d.grossProfit));
    set('s-gm', d.grossMarginPct==null?'—':d.grossMarginPct.toFixed(1)+'%');
    set('s-target', d.target?d.target.toFixed(1)+'%':'—');
    set('s-sugg', d.suggestedCents?mnMoney(d.suggestedCents):'—');
    var st=document.getElementById('s-status');
    st.textContent=d.status.label; st.className='mnc-status st-'+d.status.key;
    var w=document.getElementById('s-warn');
    if(d.unresolved){
      w.hidden=false;
      w.innerHTML = d.unresolved+' component'+(d.unresolved===1?'':'s')+' can\\'t be costed yet, so this total is a floor, not the price.'
        + ' <a href="/c/products" target="_blank">Fix in Products →</a>';
    } else w.hidden=true;
  }

  // --- wiring ---------------------------------------------------------------
  (function(){
    var pick=document.getElementById('mn-pick'), menu=document.getElementById('mn-menu');
    if(!pick) return;
    MN.n = parseInt(document.getElementById('mn-n').value,10)||0;
    (window.MN_START||[]).forEach(function(s,i){
      var el=document.querySelectorAll('#mn-lines [data-line]')[i];
      if(el && s.unit) el.querySelector('.rl-unit').value=s.unit;
    });
    pick.addEventListener('focus', function(){ mnRender(''); });
    pick.addEventListener('input', function(){ mnRender(this.value.trim().toLowerCase()); });
    document.addEventListener('click', function(e){
      if(!e.target.closest('#mn-combo')) menu.hidden=true;
    });
    menu.addEventListener('click', function(e){
      var b=e.target.closest('.cb-opt'); if(!b) return;
      if(b.id==='cb-create'){ menu.hidden=true; mnNewProduct(pick.value.trim()); return; }
      if(b.disabled) return;
      mnAdd(b.dataset.ref); pick.value=''; menu.hidden=true;
    });
    ['mn-price','mn-target'].forEach(function(id){ document.getElementById(id).addEventListener('input', mnCost); });
    document.getElementById('mn-lines').addEventListener('input', mnCost);
    document.getElementById('mn-lines').addEventListener('change', mnCost);
    var ip=document.getElementById('mn-isprep');
    if(ip) ip.addEventListener('change', function(){ document.getElementById('mn-prepyield').style.display=this.checked?'':'none'; });

    // Renumber on submit so removed lines don't leave gaps the server has to
    // guess about.
    document.getElementById('mnform').addEventListener('submit', function(){
      var i=0;
      document.querySelectorAll('#mn-lines [data-line]').forEach(function(el){
        el.querySelectorAll('[name]').forEach(function(f){ f.name=f.name.replace(/_\\d+$/,'_'+i); });
        i++;
      });
      document.getElementById('mn-n').value=i;
    });

    // Drag to reorder.
    var dragging=null;
    document.getElementById('mn-lines').addEventListener('mousedown', function(e){
      if(!e.target.closest('.rl-drag')) return;
      dragging=e.target.closest('[data-line]'); dragging.classList.add('rl-dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e){
      if(!dragging) return;
      var over=document.elementFromPoint(e.clientX,e.clientY);
      var row=over&&over.closest('[data-line]');
      if(row&&row!==dragging){
        var r=row.getBoundingClientRect();
        row.parentNode.insertBefore(dragging, (e.clientY-r.top)/r.height>0.5?row.nextSibling:row);
      }
    });
    document.addEventListener('mouseup', function(){
      if(dragging){ dragging.classList.remove('rl-dragging'); dragging=null; }
    });

    mnCost();
  })();

  // --- creating a product without losing the recipe -------------------------
  function mnNewProduct(name){
    prodDrawer(true);
    var f=document.querySelector('#prod-drawer input[name=name]');
    if(f && name) f.value=name;
    var form=document.querySelector('#prod-drawer form');
    if(form.dataset.wired) return;
    form.dataset.wired='1';
    form.addEventListener('submit', function(e){
      // Posting normally would navigate away and take the unsaved recipe with
      // it. Send it in the background, then add the new product to the line
      // list where the person was already working.
      e.preventDefault();
      var btn=form.querySelector('button[type=submit]'); btn.disabled=true; btn.textContent='Adding…';
      fetch('/c/products?json=1', { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
        body: new URLSearchParams(new FormData(form)).toString() })
        .then(function(r){ return r.json(); })
        .then(function(out){
          btn.disabled=false; btn.textContent='Add product';
          if(out.error){ alert(out.error); return; }
          MN_OPTS.unshift({ kind:'product', id:out.id, name:out.name, meta:out.meta||'',
            price:out.price||'no price yet', source:out.source||'manual', units:out.units||[],
            search:(out.name+' '+(out.meta||'')).toLowerCase() });
          prodDrawer(false); form.reset();
          mnAdd('p'+out.id, (out.units||[])[0]);
        })
        .catch(function(){ btn.disabled=false; btn.textContent='Add product'; alert('Could not add that product.'); });
    });
  }
  `;
}

/** Turn posted line fields into component rows. Shared by save and preview. */
function menuLinesFrom(body) {
  const n = Number(body.count) || 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const ref = String(body[`ref_${i}`] || '');
    if (!ref) continue;
    const isPrep = ref[0] === 'i';
    const id = Number(ref.slice(1));
    if (!id) continue;
    out.push({
      product_id: isPrep ? null : id,
      ref_item_id: isPrep ? id : null,
      component_type: MENU.TYPES.includes(body[`type_${i}`]) ? body[`type_${i}`] : 'ingredient',
      qty: Number(body[`qty_${i}`]) || 0,
      usage_unit: UNITS.normalizeUnit(body[`unit_${i}`]) || null,
      prep_note: String(body[`note_${i}`] || '').trim() || null,
      waste_pct: body[`waste_${i}`] === '' || body[`waste_${i}`] == null ? null : Number(body[`waste_${i}`]),
      group_name: String(body[`group_${i}`] || '').trim() || null,
      sort_order: out.length,
    });
  }
  return out;
}

function menuFieldsFrom(body) {
  return {
    name: String(body.name || '').trim(),
    category: String(body.category || '').trim() || null,
    description: String(body.description || '').trim() || null,
    notes: String(body.notes || '').trim() || null,
    selling_price_cents: body.price === '' || body.price == null ? null : toCents(body.price),
    target_food_cost_pct: body.target === '' || body.target == null ? MENU.DEFAULT_TARGET : Number(body.target),
    status: MENU.STATUSES.includes(body.status) ? body.status : 'draft',
    is_prep: body.is_prep ? 1 : 0,
    prep_yield_qty: body.yield_qty === '' || body.yield_qty == null ? null : Number(body.yield_qty),
    prep_yield_unit: UNITS.normalizeUnit(body.yield_unit) || null,
  };
}

/**
 * Live cost for a recipe that hasn't been saved. Costs against a temporary row
 * inside a transaction that is always rolled back, so the preview uses exactly
 * the same code as the real thing rather than a second implementation that can
 * disagree with it.
 */
app.post('/menu/cost', (req, res) => {
  const body = req.body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const priceCents = toCents(body.price);
  const target = Number(body.target) || MENU.DEFAULT_TARGET;

  let out = null;
  db.exec('BEGIN');
  try {
    const id = MENU.q.add.run({
      name: '__preview__', category: null, description: null, notes: null,
      selling_price_cents: priceCents || null, target_food_cost_pct: target,
      status: 'draft', is_prep: 0, prep_yield_qty: null, prep_yield_unit: null,
    }).lastInsertRowid;
    lines.forEach((l, i) => {
      const ref = String(l.ref || '');
      const rid = Number(ref.slice(1));
      if (!rid) return;
      MENU.q.addComponent.run({
        menu_item_id: id,
        product_id: ref[0] === 'i' ? null : rid,
        ref_item_id: ref[0] === 'i' ? rid : null,
        component_type: MENU.TYPES.includes(l.type) ? l.type : 'ingredient',
        qty: Number(l.qty) || 0, usage_unit: UNITS.normalizeUnit(l.unit) || null,
        prep_note: null, waste_pct: Number(l.waste) || null, group_name: null, sort_order: i,
      });
    });
    const c = MENU.costItem(id);
    out = {
      lines: c.lines.map((l) => ({ ok: l.ok, cents: l.lineMicros == null ? 0 : UNITS.microsToCents(l.lineMicros), reason: l.reason })),
      ingredient: UNITS.microsToCents(c.byType.ingredient || 0),
      packaging: UNITS.microsToCents(c.byType.packaging || 0),
      other: UNITS.microsToCents((c.byType.garnish || 0) + (c.byType.condiment || 0) + (c.byType.other || 0)),
      totalCents: c.totalCents, sellCents: c.sellCents, unresolved: c.unresolved,
      foodCostPct: c.foodCostPct, grossProfit: c.grossProfit, grossMarginPct: c.grossMarginPct,
      target: c.target, suggestedCents: c.suggestedCents, status: c.status,
    };
  } finally {
    db.exec('ROLLBACK');
  }
  res.json(out);
});

const saveMenu = db.transaction((id, fields, lines) => {
  let itemId = id;
  if (itemId) MENU.q.update.run({ ...fields, id: itemId });
  else itemId = MENU.q.add.run(fields).lastInsertRowid;
  MENU.q.clearComponents.run(itemId);
  for (const l of lines) MENU.q.addComponent.run({ ...l, menu_item_id: itemId });
  return itemId;
});

function saveMenuItem(req, res, existingId) {
  const fields = menuFieldsFrom(req.body);
  const lines = menuLinesFrom(req.body);
  const check = MENU.validate(fields, lines.map((l) => ({ label: '', qty: l.qty, wastePct: l.waste_pct })));
  if (!check.ok) {
    return res.redirect(`${existingId ? `/menu/${existingId}/edit` : '/menu/new'}?err=1&msg=` + encodeURIComponent(check.errors[0]));
  }
  const id = saveMenu(existingId, fields, lines);
  MENU.snapshot(id, existingId ? 'edit' : 'create');
  const c = MENU.costItem(id);
  const warn = c.unresolved
    ? ` ${c.unresolved} component${c.unresolved === 1 ? '' : 's'} still need${c.unresolved === 1 ? 's' : ''} a cost.` : '';
  res.redirect(`/menu/${id}?msg=` + encodeURIComponent(`Saved.${warn}`));
}

app.post('/menu', (req, res) => saveMenuItem(req, res, null));
app.post('/menu/:id', (req, res) => {
  const m = MENU.q.one.get(Number(req.params.id));
  if (!m) return res.status(404).end();
  saveMenuItem(req, res, m.id);
});

app.post('/menu/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const to = MENU.STATUSES.includes(req.body.status) ? req.body.status : 'draft';
  MENU.q.setStatus.run(to, to, id);
  MENU.snapshot(id, 'status');
  res.redirect(`/menu/${id}?msg=` + encodeURIComponent(to === 'archived' ? 'Archived.' : `Marked ${to}.`));
});

app.post('/menu/:id/duplicate', (req, res) => {
  const m = MENU.q.one.get(Number(req.params.id));
  if (!m) return res.status(404).end();
  // The recipe carries over; the name, the history and the photo do not. A
  // duplicate that inherits its parent's cost history would be claiming
  // something that never happened to it.
  const base = `${m.name} (copy)`;
  let name = base, n = 2;
  while (db.prepare('SELECT 1 FROM menu_items WHERE name = ?').get(name)) name = `${base} ${n++}`;
  const copy = db.transaction(() => {
    const id = MENU.q.add.run({
      name, category: m.category, description: m.description, notes: m.notes,
      selling_price_cents: m.selling_price_cents, target_food_cost_pct: m.target_food_cost_pct,
      status: 'draft', is_prep: m.is_prep, prep_yield_qty: m.prep_yield_qty, prep_yield_unit: m.prep_yield_unit,
    }).lastInsertRowid;
    for (const c of MENU.q.components.all(m.id)) {
      MENU.q.addComponent.run({
        menu_item_id: id, product_id: c.product_id, ref_item_id: c.ref_item_id,
        component_type: c.component_type, qty: c.qty, usage_unit: c.usage_unit,
        prep_note: c.prep_note, waste_pct: c.waste_pct, group_name: c.group_name, sort_order: c.sort_order,
      });
    }
    return id;
  })();
  MENU.snapshot(copy, 'duplicate');
  res.redirect(`/menu/${copy}/edit?msg=` + encodeURIComponent('Copied — give it a name and adjust the recipe.'));
});

app.post('/menu/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const used = MENU.q.usingItem.all(id);
  if (used.length) {
    return res.redirect(`/menu/${id}?err=1&msg=` + encodeURIComponent(
      `This prep is used by ${used.length} other menu item${used.length === 1 ? '' : 's'}. Remove it from ${used.length === 1 ? 'that recipe' : 'those recipes'} first.`));
  }
  MENU.q.del.run(id);
  res.redirect('/menu?msg=' + encodeURIComponent('Menu item deleted.'));
});

// --- detail ----------------------------------------------------------------
app.get('/menu/:id', (req, res) => {
  const m = MENU.q.one.get(Number(req.params.id));
  if (!m) return res.status(404).send(layout('Not found', '<div class="empty2"><div class="empty2-t">No such menu item</div></div>'));
  const c = MENU.costItem(m.id);
  const snaps = MENU.q.snapshots.all(m.id);
  const cc = menuCat(m.category);

  // Group the recipe the way it was built.
  const groups = new Map();
  for (const l of c.lines) {
    const g = l.group || 'Recipe';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }
  const recipe = [...groups.entries()].map(([name, lines]) => `
    <div class="rgroup"><div class="rgroup-h">${esc(name)}</div>
      ${lines.map((l) => `
        <div class="rrow${l.ok ? '' : ' rrow-bad'}">
          <span class="rr-n">${esc(l.label)}${l.isPrep ? ' <span class="prep-tag">prep</span>' : ''}
            ${l.type !== 'ingredient' ? `<span class="rr-t">${MENU.TYPE_LABEL[l.type]}</span>` : ''}
            ${l.note ? `<i class="rr-note">${esc(l.note)}</i>` : ''}</span>
          <span class="rr-q">${UNITS.fmtQty(l.qty)} ${esc(UNITS.unitLabel(l.unit))}${l.wastePct ? ` · ${l.wastePct}% waste` : ''}</span>
          <span class="rr-u">${l.unitMicros == null ? '—' : money(UNITS.microsToCents(l.unitMicros)) + '/' + esc(UNITS.unitLabel(l.unit))}</span>
          <span class="rr-c">${l.ok ? money(UNITS.microsToCents(l.lineMicros))
            : `<a class="rr-fix" href="${l.productId ? `/c/products/${l.productId}` : `/menu/${l.refItemId}`}">${esc(l.reason || 'needs setup')} →</a>`}</span>
        </div>`).join('')}
    </div>`).join('');

  // Cost over time. Only drawn with three points — two dots is not a trend.
  let spark = '';
  const pts = snaps.slice(0, 24).reverse().filter((s) => s.total_micros > 0);
  if (pts.length >= 3) {
    const vals = pts.map((s) => s.total_micros);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const W = 520, H = 60;
    const d = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - ((v - lo) / span) * (H - 10) - 5).toFixed(1)}`);
    spark = `<div class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline points="${d.join(' ')}" fill="none" stroke="${vals[vals.length - 1] > vals[0] ? '#dc2626' : '#059669'}" stroke-width="2" stroke-linejoin="round"/>
    </svg><div class="spark-l"><span>${money(UNITS.microsToCents(lo))}</span><span>${pts.length} recalculations</span><span>${money(UNITS.microsToCents(hi))}</span></div></div>`;
  }

  const history = snaps.slice(0, 12).map((s, i) => {
    const older = snaps[i + 1];
    const d = older ? MENU.drivers(s, older) : [];
    const delta = older ? s.total_micros - older.total_micros : 0;
    return `<div class="hrow">
      <span class="hr-d">${esc(String(s.calculated_at).slice(0, 16))}</span>
      <span class="hr-c">${money(UNITS.microsToCents(s.total_micros))}${s.unresolved ? '+' : ''}</span>
      <span class="hr-x">${older ? `<span class="${delta > 0 ? 'tr tr-up' : delta < 0 ? 'tr tr-down' : 'tr tr-flat'}">${delta > 0 ? '+' : ''}${money(UNITS.microsToCents(delta))}</span>` : '<span class="muted">first</span>'}</span>
      <span class="hr-w">${esc(s.trigger || '')}${d.length ? ' · ' + d.slice(0, 2).map((x) => `${esc(x.label)} ${x.delta > 0 ? '+' : ''}${money(UNITS.microsToCents(x.delta))}`).join(', ') : ''}</span>
    </div>`;
  }).join('');

  const fact = (k, v) => `<div class="tfact"><span>${k}</span><b>${v}</b></div>`;
  res.send(layout(m.name, `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t">
        <a class="link back" href="/menu">← Menu costing</a>
        <h1>${esc(m.name)}${m.is_prep ? ' <span class="prep-tag">prep</span>' : ''}</h1>
        <p class="phead-s">
          ${m.category ? `<span class="pchip" style="--c:${cc.color};--ct:${cc.tint}">${esc(m.category)}</span>` : ''}
          <span class="pill ${c.status.cls}">${c.status.label}</span>
          ${m.status !== 'active' ? `<span class="pill">${m.status[0].toUpperCase() + m.status.slice(1)}</span>` : ''}
        </p>
      </div>
      ${canWrite() ? `<div class="phead-acts">
        <a class="btn btn-primary" href="/menu/${m.id}/edit">Edit recipe</a>
        <form method="post" action="/menu/${m.id}/duplicate" style="margin:0"><button class="btn" type="submit">Duplicate</button></form>
      </div>` : ''}
    </div>

    ${c.unresolved ? `<div class="attn"><div class="attn-h">${icon('incidents')} ${c.unresolved} component${c.unresolved === 1 ? '' : 's'} without a cost</div>
      <p>The total below is what the rest adds up to — a floor, not the real cost. Fix the flagged lines to complete it.</p></div>` : ''}

    <div class="mcards mcards-4">
      <div class="mcard mcard-blue"><div class="mcard-ico">${icon('sales')}</div><div class="mcard-body">
        <div class="mcard-label">Selling price</div><div class="mcard-value">${m.selling_price_cents ? money(m.selling_price_cents) : '—'}</div>
        <div class="mcard-sub">${m.is_prep ? 'a prep, not sold directly' : 'on the menu'}</div></div></div>
      <div class="mcard mcard-amber"><div class="mcard-ico">${icon('invoices')}</div><div class="mcard-body">
        <div class="mcard-label">Total cost</div><div class="mcard-value">${money(c.totalCents)}${c.unresolved ? '+' : ''}</div>
        <div class="mcard-sub">${c.lines.length} component${c.lines.length === 1 ? '' : 's'}</div></div></div>
      <div class="mcard mcard-${c.status.key === 'on' ? 'green' : c.status.key === 'over' ? 'red' : 'violet'}"><div class="mcard-ico">${icon('costs')}</div><div class="mcard-body">
        <div class="mcard-label">Food cost</div><div class="mcard-value">${c.unresolved ? '—' : pct1(c.foodCostPct)}</div>
        <div class="mcard-sub">target ${pct1(c.target)}</div></div></div>
      <div class="mcard mcard-green"><div class="mcard-ico">${icon('payroll')}</div><div class="mcard-body">
        <div class="mcard-label">Gross profit</div><div class="mcard-value">${c.grossProfit == null ? '—' : money(c.grossProfit)}</div>
        <div class="mcard-sub">${c.grossMarginPct == null ? 'needs a price' : pct1(c.grossMarginPct) + ' margin'}</div></div></div>
    </div>

    <div class="vpanels">
      <section class="panel panel-wide">
        <div class="panel-h"><b>Recipe</b><span class="panel-link muted">${c.lines.length} component${c.lines.length === 1 ? '' : 's'}</span></div>
        ${c.lines.length ? recipe : '<div class="panel-empty">No components yet.</div>'}
      </section>
    </div>

    <div class="vpanels">
      <section class="panel">
        <div class="panel-h"><b>Cost breakdown</b></div>
        ${fact('Ingredients', money(UNITS.microsToCents(c.byType.ingredient || 0)))}
        ${fact('Packaging', money(UNITS.microsToCents(c.byType.packaging || 0)))}
        ${fact('Garnish', money(UNITS.microsToCents(c.byType.garnish || 0)))}
        ${fact('Condiments', money(UNITS.microsToCents(c.byType.condiment || 0)))}
        ${fact('Other', money(UNITS.microsToCents(c.byType.other || 0)))}
        ${fact('Suggested price at target', c.suggestedCents ? money(c.suggestedCents) : '—')}
        ${fact('Last recalculated', snaps[0] ? esc(String(snaps[0].calculated_at).slice(0, 16)) : 'never')}
        ${m.is_prep ? fact('One batch makes', m.prep_yield_qty ? `${UNITS.fmtQty(m.prep_yield_qty)} ${esc(UNITS.unitLabel(m.prep_yield_unit))}` : '<i class="unset">not set</i>') : ''}
        ${m.description ? `<div class="inv-notes">${esc(m.description)}</div>` : ''}
        ${spark}
      </section>
      <section class="panel">
        <div class="panel-h"><b>Cost history</b><span class="panel-link muted">${snaps.length} record${snaps.length === 1 ? '' : 's'}</span></div>
        ${history || '<div class="panel-empty">Nothing recorded yet. A record is kept whenever the cost moves.</div>'}
      </section>
    </div>

    ${canWrite() ? `<div class="danger-zone">
      <div><b>${m.status === 'archived' ? 'Bring this back' : 'Archive this item'}</b>
        <p class="muted">${m.status === 'archived' ? 'It will appear on the menu list again.' : 'It stays costed and keeps its history — it just drops off the working list.'}</p></div>
      <form method="post" action="/menu/${m.id}/status" style="margin:0">
        <input type="hidden" name="status" value="${m.status === 'archived' ? 'draft' : 'archived'}">
        <button class="btn ${m.status === 'archived' ? '' : 'btn-danger'}" type="submit">${m.status === 'archived' ? 'Restore' : 'Archive'}</button>
      </form>
    </div>` : ''}`));
});


// ---------------------------------------------------------------------------
// SETTINGS — one place for everything about the restaurant and the account,
// so the sidebar can be about the day's work.
// ---------------------------------------------------------------------------
app.get('/settings', (req, res) => {
  const groups = SETTINGS_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => navAllowedFor(i.href)) }))
    .filter((g) => g.items.length);

  res.send(layout('Settings', `
    ${flash(req)}
    <div class="phead">
      <div class="phead-t"><h1>Settings</h1>
        <p class="phead-s">How this restaurant is set up, and who can see it.</p></div>
    </div>
    ${groups.map((g) => `
      <div class="head-row"><h2>${esc(g.title)}</h2></div>
      <div class="setgrid">
        ${g.items.map((i) => `
          <a class="setcard" href="${i.href}">
            <span class="setcard-ico">${icon(i.icon)}</span>
            <span class="setcard-b"><b>${esc(i.label)}</b><i>${esc(i.blurb)}</i></span>
            <span class="setcard-go">›</span>
          </a>`).join('')}
      </div>`).join('')}
    ${groups.length ? '' : '<div class="empty2"><div class="empty2-t">Nothing here for this account</div><div class="empty2-s">Settings are limited to accounts with access to them.</div></div>'}`));
});

// /performance is the name on the page now; /costs is where it has always
// lived and what every existing link and bookmark points at.
app.get('/performance', (_req, res) => res.redirect(301, '/costs'));


// ---------------------------------------------------------------------------
// SEARCH — one endpoint, filtered by what the account may open.
// ---------------------------------------------------------------------------
const { search: runSearch } = require('./search');

// Deliberately outside the area map, unlike every page. /menu was accidentally
// area-less and therefore open, so the distinction matters: search must be
// reachable by every signed-in account because it filters its own results, and
// the callback below is that filter. Anonymous requests never get here — the
// auth middleware redirects them. test/search.test.js holds this to it.
app.get('/search', (req, res) => {
  const out = runSearch(req.query.q, (area) => {
    const store = reqCtx.getStore();
    const u = store && store.user;
    if (!u || u.master || !u.features || !u.features.length) return true;
    return u.features.includes(area);
  });
  res.json(out);
});


mountModules(app);

// ---------------------------------------------------------------------------
// One-time data migration: the two months of history that pre-date ZWIN.
//
// It runs at boot because there is no other way in — the database lives on a
// Render disk with no shell. It is guarded three ways: a marker so it never
// runs twice, a date check so it never touches a service that already exists,
// and one transaction so a failure leaves nothing behind.
//
// It must never stop the app starting. A missing backfill is a thing you
// notice and re-run; a server that will not boot is an outage.
//
// Skipped under test, where every file gets an empty database and seventy-two
// services appearing in it would be seventy-two services nobody asked for.
// ---------------------------------------------------------------------------
if (process.env.ZWIN_SKIP_BACKFILL !== '1') {
  try {
    const BACKFILL = require('./backfill');
    // A one-row correction that has to reach databases the backfill already
    // ran on. Idempotent and outside the marker, so it applies once and then
    // finds nothing to do.
    const fixed = BACKFILL.fixJul11Wages();
    if (fixed.length) console.log(`\n  Backfill: corrected 11 Jul rates — ${fixed.join(', ')}.`);
    const out = BACKFILL.run();
    if (out.ran) {
      const r = out.report;
      console.log(`\n  Backfill: ${r.inserted.length} services imported, ${r.staff} staff rows, ${r.servers} server-sales rows.`);
      if (r.created.length) console.log(`  Backfill: created ${[...new Set(r.created)].join(', ')}.`);
      if (r.matched.length) console.log(`  Backfill: matched ${[...new Set(r.matched)].join('; ')}.`);
      if (r.skipped.length) console.log(`  Backfill: skipped ${r.skipped.length} (${r.skipped.map((x) => x.date).join(', ')}).`);
    }
  } catch (e) {
    console.error('\n  Backfill FAILED and was rolled back. The app is running without it.');
    console.error('  ' + (e && e.message ? e.message : e) + '\n');
  }
}

app.listen(PORT, () => {
  console.log(`\n  ${RESTAURANT} ops running →  http://localhost:${PORT}\n`);
  if (!process.env.GMAIL_USER && !process.env.SMTP_HOST) {
    console.log('  Email: PREVIEW MODE (no mail configured). "Send" writes files to /previews.\n');
  }
});

module.exports = app;
