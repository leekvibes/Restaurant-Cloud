'use strict';

// Throttling the one credential in this app that a person can guess.
//
// A staff PIN is four digits: ten thousand of them, against a comparison that
// used to answer as fast as the database could run it. These tests are about
// the guesser being stopped, the real employee not being punished for it, and
// the PIN never appearing anywhere it could be read back.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Schedule membership is explicit now: a person is on a schedule because a row
// says so, and there is no fallback. Employees created straight in SQL — as
// these fixtures do — therefore start on nothing and cannot clock in, exactly
// like a real employee added outside the app would. The app's own create route
// puts a new hire on every schedule; this is that, for fixtures.
function onAllSchedules() {
  try {
    db.exec(`INSERT OR IGNORE INTO employee_services (employee_id, service_slug)
             SELECT e.id, s.slug FROM employees e, services s`);
  } catch { /* services not seeded in this database */ }
}


const PORT = 3997;                     // unique across the suite
const BASE = `http://127.0.0.1:${PORT}`;

// A browser gets its CSRF token injected into every form it loads. These tests
// post straight at the routes, so they ask for one the same way the service
// worker does, and cache it per session.
const __csrf = new Map();
async function __token(cookie) {
  const key = cookie || '';
  if (!__csrf.has(key)) {
    const r = await fetch(BASE + '/csrf', { headers: key ? { cookie: key } : {} });
    __csrf.set(key, (await r.text()).trim());
  }
  return __csrf.get(key);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-gd-'));
const DB = path.join(dir, 'gd.db');
const LOG = path.join(dir, 'server.log');
process.env.DB_PATH = DB;
process.env.TZ = process.env.TZ || 'America/New_York';
let child, Database, db, logFd;

const post = async (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...body, _csrf: await __token(({} || {}).cookie) }).toString(),
});
const msgOf = (res) => decodeURIComponent((res.headers.get('location') || '').split('msg=')[1] || '');

const A = 91, B = 92;   // two employees, so isolation can be checked

test.before(async () => {
  Database = require('better-sqlite3');
  logFd = fs.openSync(LOG, 'a');
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    // Small limits, so the test does not have to make 25 requests to prove a
    // rule that is the same at 3.
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York',
      ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '',
      PIN_MAX: '3', PIN_LOCK_SECS: '2', PIN_IP_MAX: '50', PIN_IP_LOCK_SECS: '2' },
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new Database(DB);
  const ins = db.prepare("INSERT INTO employees (id, name, role, pin, hourly_rate_cents, active) VALUES (?,?,'server',?,1500,1)");
  onAllSchedules();
  ins.run(A, 'Guarded One', '4242');
  ins.run(B, 'Guarded Two', '5353');
  onAllSchedules();
});

// Fixtures are also created outside before-blocks and inside tests, so this
// runs again before each one rather than only at the start.
test.beforeEach(() => onAllSchedules());

test.after(() => {
  if (child) child.kill();
  try { db.close(); } catch {}
  try { fs.closeSync(logFd); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

const clear = () => db.prepare('DELETE FROM auth_attempts').run();

test('the right PIN gets in', async () => {
  clear();
  const res = await post('/tips/start', { pin: '4242' });
  assert.strictEqual(res.status, 302);
  assert.ok((res.headers.get('set-cookie') || '').includes('zwin_portal'), 'a session is issued');
});

test('a wrong PIN is refused, and says nothing about which part was wrong', async () => {
  clear();
  const res = await post('/tips/start', { pin: '0000' });
  const m = msgOf(res);
  assert.match(m, /wasn.t recognised/i, 'a generic refusal');
  assert.doesNotMatch(m, /4242|5353|Guarded/, 'no PIN and no name leaks back');
});

test('repeated wrong PINs against one employee lock that employee', async () => {
  clear();
  // Named directly, so the failures land on the employee bucket.
  for (let i = 0; i < 3; i++) await post('/tips', { employee_id: String(A), pin: '0000' });
  const res = await post('/tips', { employee_id: String(A), pin: '0000' });
  assert.match(msgOf(res), /timed out|PIN|try again/i, 'refused');
  const row = db.prepare("SELECT * FROM auth_attempts WHERE scope='pin' AND ident=?").get(String(A));
  assert.ok(row && row.locked_until, 'the employee bucket is locked');
});

test('the correct PIN is refused while that employee is locked', async () => {
  // Locked by the test above. This is the point of a lockout: it must refuse to
  // EVALUATE, or a guesser simply guesses through it.
  const row = db.prepare("SELECT * FROM auth_attempts WHERE scope='pin' AND ident=?").get(String(A));
  assert.ok(row && row.locked_until, 'still locked');
  const before = db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n;
  const res = await post('/tips', { employee_id: String(A), pin: '4242', date: '2026-07-04', daypart: 'dinner', cash_tips: '10' });
  // /tips redirects whether it worked or not, so the status says nothing — the
  // question is whether anything was actually accepted.
  const to = res.headers.get('location') || '';
  assert.match(to, /err=1/, 'refused, with the generic error');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM tip_submissions').get().n, before,
    'and nothing was filed under their name');
});

test('another employee is untouched by their colleague being locked', async () => {
  const res = await post('/tips/start', { pin: '5353' });
  assert.strictEqual(res.status, 302, 'the other PIN still works');
  assert.ok((res.headers.get('set-cookie') || '').includes('zwin_portal'));
});

test('the lock expires on its own — nobody is shut out for good', async () => {
  await new Promise((r) => setTimeout(r, 2400));   // PIN_LOCK_SECS=2
  const res = await post('/tips/start', { pin: '4242' });
  assert.strictEqual(res.status, 302, 'back in once it expires');
});

test('a correct PIN clears the failures behind it', async () => {
  clear();
  await post('/tips', { employee_id: String(A), pin: '0000' });
  assert.ok(db.prepare("SELECT * FROM auth_attempts WHERE scope='pin' AND ident=?").get(String(A)), 'a failure was recorded');
  await post('/tips/start', { pin: '4242' });
  assert.ok(!db.prepare("SELECT * FROM auth_attempts WHERE scope='pin' AND ident=?").get(String(A)),
    'and getting it right wipes the slate');
});

test('no PIN is ever written to the database or the log', async () => {
  clear();
  for (const p of ['4242', '9999', '0000']) await post('/tips/start', { pin: p });
  const rows = JSON.stringify(db.prepare('SELECT * FROM auth_attempts').all());
  assert.doesNotMatch(rows, /4242|9999|0000/, 'the attempts table holds counts, never credentials');
  const log = fs.readFileSync(LOG, 'utf8');
  assert.doesNotMatch(log, /4242/, 'and the real PIN is nowhere in the log');
  const ev = JSON.stringify(db.prepare("SELECT * FROM time_events").all());
  assert.doesNotMatch(ev, /4242/, 'nor in the audit history');
});

test('attempts survive a restart — waiting one out is not a way through', () => {
  clear();
  db.prepare("INSERT INTO auth_attempts (scope, ident, fails) VALUES ('pin','999',3)").run();
  const again = new Database(DB, { readonly: true });
  assert.ok(again.prepare("SELECT 1 FROM auth_attempts WHERE ident='999'").get(),
    'the record is on disk, not in a process that can be bounced');
  again.close();
});

// ---------------------------------------------------------------------------
// CSRF.
//
// The attack is one specific thing: a page on another site causing this
// browser to post, with this browser's cookies attached. Everything below is
// about that, and about not pretending to solve things a token cannot solve.
// ---------------------------------------------------------------------------

async function signedIn() {
  const res = await post('/tips/start', { pin: '5353' });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
const send = (p, body, headers) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});

test('every form a browser is served carries a token', async () => {
  const cookie = await signedIn();
  // Asking for gzip explicitly, because that is the path every real browser
  // takes and the one where this broke: the compressor wrapped res.send after
  // the injector did, so the injector was handed a Buffer, skipped it, and
  // served tokenless forms to everyone while curl — which does not ask for
  // gzip — showed a page that looked perfect.
  const html = await (await fetch(BASE + '/portal/clock?svc=cafe',
    { headers: { cookie, 'accept-encoding': 'gzip' } })).text();
  // Not a count — counting two things with two regexes measures the regexes.
  // Walk the form tags the injector walks, and require the token to be the very
  // next thing inside each one that posts.
  let posting = 0;
  for (const m of html.matchAll(/<form\b([^>]*)>/gi)) {
    if (!/method\s*=\s*["']?post/i.test(m[1])) continue;
    posting++;
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 120);
    assert.match(after, /^<input type="hidden" name="_csrf" value="[a-f0-9]{32}">/,
      `a posting form was served without a token: ${m[0].slice(0, 70)}`);
  }
  assert.ok(posting > 0, 'the page has posting forms to protect');
});

test('a session that renews itself does not invalidate the page it just drew', async () => {
  // This shipped broken and it took the time clock down for anybody standing
  // at it. The token was derived from the session cookie's BYTES, and a session
  // cookie ends in an expiry — while the portal deliberately re-issues one
  // every time somebody on the clock loads a page, so that a shift can never
  // sign itself out underneath them. The page went out stamped from the cookie
  // that arrived; the browser walked away holding a newly issued one; and the
  // next tap — Break, Clock out — came back "That form expired."
  //
  // So: walk the real sequence. Clock in, load the page the way a phone does,
  // and use exactly the token that page carries with exactly the cookie the
  // browser now holds.
  let cookie = await signedIn();
  const tokenIn = (html) => (html.match(/name="_csrf" value="([a-f0-9]{32})"/) || [])[1];

  const first = await (await fetch(BASE + '/portal/clock?svc=cafe', { headers: { cookie } })).text();
  const inRes = await send('/portal/clock/in',
    { daypart: 'dinner', position: 'server', _csrf: tokenIn(first) }, { cookie, origin: BASE });
  assert.notStrictEqual(inRes.status, 403, 'clocking in goes through');

  const page = await fetch(BASE + '/portal/clock?svc=cafe', { headers: { cookie } });
  const token = tokenIn(await page.text());
  const renewed = (page.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(renewed, 'loading the clock page while on the clock renews the session — that is the point');
  cookie = renewed;                                   // what the browser holds from here on

  const brk = await send('/portal/clock/break/start', { _csrf: token },
    { cookie, origin: BASE, referer: BASE + '/portal/clock' });
  assert.notStrictEqual(brk.status, 403,
    'and the token that page was drawn with still works against the cookie it handed out');
  const out = await send('/portal/clock/break/end', { _csrf: token }, { cookie, origin: BASE });
  assert.notStrictEqual(out.status, 403, 'and keeps working for the next action too');
});

test('the things that post with fetch instead of a form get a token too', async () => {
  // A <form> is not the only way this app posts. About a dozen places use
  // fetch() — the push-notification test and its subscribe/unsubscribe, the
  // clock's keep-alive ping, the invoice/receipt/document readers, the menu
  // coster — and none of them has a form tag to hang a hidden field on. They
  // were all being refused with "That form expired", which is a baffling thing
  // to be told when you are testing notifications on a new phone.
  //
  // The page hands the token to its own JS and wraps fetch once. This runs that
  // wrapper the way a browser would, in a sandbox, and watches what it sends.
  const vm = require('node:vm');
  const cookie = await signedIn();
  const html = await (await fetch(BASE + '/portal', { headers: { cookie } })).text();
  const script = (html.match(/<head[^>]*>\s*<script>([\s\S]*?)<\/script>/i) || [])[1];
  assert.ok(script, 'the page carries the wrapper, first thing in the head');

  const sent = [];
  const ctx = {
    Headers,
    location: { origin: 'https://zwin.example' },
    window: { fetch: (input, init) => { sent.push({ input, init }); return Promise.resolve('sent'); } },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);

  await ctx.window.fetch('/portal/push/test', { method: 'POST' });
  assert.strictEqual(sent.length, 1, 'the call still goes through');
  assert.match(sent[0].init.headers.get('x-csrf-token'), /^[a-f0-9]{32}$/,
    'and now carries the token the server will ask for');

  await ctx.window.fetch('/portal/clock/history');
  assert.strictEqual(sent[1].init.headers, undefined, 'a plain GET is left alone');

  await ctx.window.fetch('https://someone-else.example/collect', { method: 'POST' });
  assert.ok(!sent[2].init.headers || !sent[2].init.headers.get('x-csrf-token'),
    'and the token is never sent to another origin');
});

test('a fetch post carrying the header is accepted', async () => {
  // The other half: the server has to take it from the header, since a JSON
  // body has nowhere to put a form field.
  const cookie = await signedIn();
  const token = await (await fetch(BASE + '/csrf', { headers: { cookie } })).text();
  const res = await fetch(BASE + '/portal/clock/ping', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, origin: BASE, 'x-csrf-token': token.trim() },
  });
  assert.notStrictEqual(res.status, 403, 'the header is as good as the hidden field');
});

test('a post from another site is refused, token or no token', async () => {
  const cookie = await signedIn();
  const token = await (await fetch(BASE + '/csrf', { headers: { cookie } })).text();
  // The attack: the victim's cookie, sent by their browser, from somebody
  // else's page.
  const forged = await send('/portal/clock/in', { daypart: 'dinner' },
    { cookie, origin: 'https://evil.example' });
  assert.strictEqual(forged.status, 403, 'refused on where it came from');
  // Even holding a real token, because the origin is the tell.
  const withToken = await send('/portal/clock/in', { daypart: 'dinner', _csrf: token },
    { cookie, origin: 'https://evil.example' });
  assert.strictEqual(withToken.status, 403, 'a stolen token does not buy a cross-site post');
});

test('a browser form without its token is refused', async () => {
  const cookie = await signedIn();
  const res = await send('/portal/clock/in', { daypart: 'dinner' },
    { cookie, origin: BASE, referer: BASE + '/portal/clock' });
  assert.strictEqual(res.status, 403, 'a same-site browser post must carry one');
});

test('a token from somebody else\'s session is refused', async () => {
  const mine = await signedIn();
  const theirs = (await post('/tips/start', { pin: '4242' })).headers.get('set-cookie').split(';')[0];
  const theirToken = await (await fetch(BASE + '/csrf', { headers: { cookie: theirs } })).text();
  assert.notStrictEqual(theirToken, await (await fetch(BASE + '/csrf', { headers: { cookie: mine } })).text(),
    'the two sessions have different tokens');
  const res = await send('/portal/clock/in', { daypart: 'dinner', _csrf: theirToken },
    { cookie: mine, origin: BASE });
  assert.strictEqual(res.status, 403, 'a token is worth nothing outside its own session');
});

test('a real browser form with its own token goes through', async () => {
  const cookie = await signedIn();
  const token = await (await fetch(BASE + '/csrf', { headers: { cookie } })).text();
  const res = await send('/portal/clock/in', { daypart: 'dinner', _csrf: token },
    { cookie, origin: BASE, referer: BASE + '/portal/clock' });
  assert.notStrictEqual(res.status, 403, 'the legitimate case is not collateral damage');
});

test('the webhook is not asked for a browser token', async () => {
  // A machine with a shared secret, no cookies, and no browser to be tricked.
  const res = await fetch(BASE + '/webhook/benugin', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-04', daypart: 'dinner', servers: [] }),
  });
  assert.strictEqual(res.status, 401, 'refused on its own secret, not on CSRF');
});

// ---------------------------------------------------------------------------
// Sessions, cookies, and what a failure is allowed to say.
// ---------------------------------------------------------------------------

test('a session cookie is HttpOnly and SameSite, so script and other sites cannot use it', async () => {
  const res = await post('/tips/start', { pin: '5353' });
  const c = res.headers.get('set-cookie') || '';
  assert.match(c, /HttpOnly/i, 'no script reads it — the XSS that gets one does not also get the session');
  assert.match(c, /SameSite=Lax/i, 'and another site cannot ride it');
  assert.match(c, /Max-Age=\d+/i, 'and it does not live forever in the browser');
  // Secure is conditional on HTTPS and this harness is plain http, so asserting
  // it here would only assert the test's own scheme. The expiry that actually
  // matters is checked below: it is inside the signed token, not the cookie.
});

test('a session that has expired is refused, whatever the browser still holds', async () => {
  // The cookie's Max-Age is a request to the browser. The expiry that counts is
  // signed into the token and checked here, so an old cookie kept, copied, or
  // replayed is worth nothing.
  const cookie = await signedIn();
  const [name, value] = cookie.split('=');
  const [id, exp, sig] = value.split('.');
  assert.ok(id && exp && sig, 'the token carries its own expiry');
  assert.ok(Number(exp) > Date.now(), 'which is in the future while it is valid');
  // Move the expiry into the past. The signature no longer matches, which is
  // the point — you cannot extend your own session by editing it either.
  const stale = `${name}=${id}.${Date.now() - 1000}.${sig}`;
  const res = await fetch(BASE + '/portal/clock?svc=cafe', { headers: { cookie: stale }, redirect: 'manual' });
  assert.strictEqual(res.status, 302, 'sent back to the PIN screen');
});

test('an expired session never closes a punch', async () => {
  // The rule this protects: hours are earned by working, not by holding a
  // valid cookie. A session lapsing mid-shift — the phone locked, the tab
  // discarded, the 45 minutes simply passing — must leave the entry open for
  // the person to close when they actually stop working.
  const cookie = await signedIn();
  const token = await (await fetch(BASE + '/csrf', { headers: { cookie } })).text();
  await send('/portal/clock/in', { daypart: 'dinner', position: 'server', _csrf: token },
    { cookie, origin: BASE });
  const open = db.prepare("SELECT * FROM time_entries WHERE employee_id = ? AND status IN ('active','on_break')").get(B);
  assert.ok(open, 'on the clock');

  // Now go away for longer than the session lasts, and come back to a dead one.
  const [name, value] = cookie.split('=');
  const [id, , sig] = value.split('.');
  const dead = `${name}=${id}.${Date.now() - 1000}.${sig}`;
  await fetch(BASE + '/portal/clock?svc=cafe', { headers: { cookie: dead }, redirect: 'manual' });
  await fetch(BASE + '/portal', { headers: { cookie: dead }, redirect: 'manual' });
  await send('/portal/clock/out', { _csrf: token }, { cookie: dead, origin: BASE });

  const after = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(open.id);
  assert.strictEqual(after.clock_out_at, null, 'still open — the session died, the shift did not');
  assert.ok(['active', 'on_break'].includes(after.status), 'and still on the clock');
});

test('signing out clears both seats on the device', async () => {
  // The tablet by the pass is where a manager signs in to fix a shift and where
  // staff punch in. Clearing one and leaving the other is how the next person
  // to pick it up ends up holding somebody else's session.
  const res = await fetch(BASE + '/logout', { redirect: 'manual' });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const joined = set.join(' ; ');
  assert.match(joined, /rc_auth=;/, 'the office seat is cleared');
  assert.match(joined, /zwin_portal=;/, 'and so is the portal one');
  assert.match(joined, /Max-Age=0/, 'immediately, not eventually');
});

test('a request that fails says so without handing over the source tree', async () => {
  // Express's own error handler puts the stack trace in the response body
  // unless NODE_ENV happens to say production. That is absolute paths, the
  // shape of this repo, and sometimes the SQL and the values in it, handed to
  // whoever managed to make the request fail.
  const res = await fetch(BASE + '/webhook/benugin', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json at all',
  });
  const body = await res.text();
  assert.ok(res.status >= 400, 'it is refused');
  assert.doesNotMatch(body, /\bat\s+\S+\s+\(/, 'no stack frames');
  assert.doesNotMatch(body, /restaurant-ops|node_modules|\/src\//, 'no paths from this machine');
  assert.doesNotMatch(body, /SyntaxError|SqliteError|TypeError/, 'and no exception class names');
});

test('the login doors have no session to derive a token from', async () => {
  // Guarded by the password and the PIN throttle instead. Demanding a token
  // here would mean nobody could ever sign in.
  const res = await post('/tips/start', { pin: '0000' });
  assert.notStrictEqual(res.status, 403, 'the PIN screen still answers');
});
