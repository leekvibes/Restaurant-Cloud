'use strict';

// These run the app the way it runs on the host: APP_PASSWORD set, so the
// manager auth middleware is live. Locally that variable is usually unset,
// which disables auth entirely — so every earlier test exercised the app with
// the middleware switched off, and a staff route left out of OPEN_PATHS went
// unnoticed until a staff member hit "Session expired" at close.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

async function up() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), APP_PASSWORD: 'test-manager-password', ZWIN_SKIP_BACKFILL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/version`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}

test.before(up);
test.after(() => child && child.kill());

const get = (p) => fetch(BASE + p, { redirect: 'manual' });
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

test('staff can reach every step of the tips flow without the manager password', async () => {
  assert.strictEqual((await get('/tips')).status, 200, 'PIN screen');
  // /tips/start is the PIN step. Leaving it out of OPEN_PATHS is what made
  // staff see "Session expired" — a wall they had no way past.
  const start = await post('/tips/start', { pin: 'nope-not-a-real-pin' });
  assert.notStrictEqual(start.status, 401, 'must not hit the manager auth wall');
  assert.ok(start.status === 200 || start.status === 302, `got ${start.status}`);
});

test('the version check staff pages rely on is reachable', async () => {
  const res = await get('/version');
  assert.strictEqual(res.status, 200);
  assert.ok((await res.json()).build, 'returns a build stamp');
});

test('manager pages stay behind the password', async () => {
  for (const p of ['/', '/payroll', '/employees', '/shifts', '/positions', '/email']) {
    const res = await get(p);
    assert.strictEqual(res.status, 302, `${p} should redirect to login`);
    assert.match(res.headers.get('location') || '', /^\/login/, `${p} redirects to /login`);
  }
});

test('manager POSTs are refused without the password', async () => {
  const res = await post('/employees', { name: 'Should Not Exist', role: 'server' });
  assert.strictEqual(res.status, 401);
  const { db } = require('../src/db');
  const found = db.prepare('SELECT COUNT(*) n FROM employees WHERE name = ?').get('Should Not Exist').n;
  assert.strictEqual(found, 0, 'blocked POST must not write anything');
});

// --- user accounts, roles and per-area access -------------------------------
// Access control is worth testing precisely because it fails silently: a page
// that should be blocked and isn't looks completely normal to whoever opens it.

const { users } = require('../src/db');

async function login(body) {
  const res = await post('/login', body);
  const c = res.headers.get('set-cookie') || '';
  return (c.match(/rc_auth=([^;]*)/) || [])[1] || '';
}
const as = (cookie, p, opts = {}) => fetch(BASE + p, {
  ...opts, redirect: 'manual', headers: { cookie: `rc_auth=${cookie}`, ...(opts.headers || {}) },
});

test('a view-only account can open its areas and is refused every write', async () => {
  users.byEmail.get('viewer@test.local') && users.del.run(users.byEmail.get('viewer@test.local').id);
  const owner = await login({ password: 'test-manager-password' });
  await as(owner, '/users', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['name', 'Read Only'], ['email', 'viewer@test.local'],
      ['password', 'viewer-password-1'], ['role', 'viewer'],
      ['features', 'dashboard'], ['features', 'sales']]).toString(),
  });
  const v = await login({ email: 'viewer@test.local', password: 'viewer-password-1' });
  assert.ok(v, 'the account can sign in');

  assert.strictEqual((await as(v, '/')).status, 200, 'dashboard allowed');
  assert.strictEqual((await as(v, '/sales')).status, 200, 'sales allowed');
  assert.strictEqual((await as(v, '/payroll')).status, 403, 'payroll withheld');
  // Menu costing exposes recipe costs and supplier pricing. It shipped
  // unlisted in FEATURES, which meant every signed-in account could read it.
  assert.strictEqual((await as(v, '/menu')).status, 403, 'menu costing withheld');
  assert.strictEqual((await as(v, '/employees')).status, 403, 'staff withheld');
  assert.strictEqual((await as(v, '/users')).status, 403, 'cannot reach user admin');

  // View-only means view-only even on a page they ARE allowed to open.
  const write = await as(v, '/sales/1', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'food=999999',
  });
  assert.strictEqual(write.status, 403, 'writes refused');
});

// The dashboard pulls from every module at once, so it is the one page where
// a permissions mistake shows up as content rather than as a 403 — a viewer
// would just see payroll and cost figures on their home page and never know
// they weren't supposed to.
test('the dashboard shows nothing from areas the account cannot open', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const existing = users.byEmail.get('dash@test.local');
  if (existing) users.del.run(existing.id);
  await as(owner, '/users', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['name', 'Dash Viewer'], ['email', 'dash@test.local'],
      ['password', 'dash-password-1'], ['role', 'viewer'],
      ['features', 'dashboard'], ['features', 'shifts']]).toString(),
  });
  const v = await login({ email: 'dash@test.local', password: 'dash-password-1' });
  // finally, not a trailing line: a failed assertion would otherwise leave the
  // account sitting in the real database until someone noticed it.
  try {
    const res = await as(v, '/');
    assert.strictEqual(res.status, 200, 'dashboard itself is allowed');
    const html = await res.text();

    // The attention list is headed by its severity kickers now, not by a
    // section title. CRITICAL only renders when there is something critical,
    // so the stable marker is the column itself.
    assert.ok(html.includes('bs-cols3'), 'still gets the sections it may see');
    // A section only counts as withheld if an owner actually gets it —
    // otherwise the assertion passes because the string was renamed and stops
    // testing anything. These are checked against the owner's page below.
    const ownerHtml = await (await as(owner, '/')).text();
    for (const withheld of ['The week in numbers']) {
      assert.ok(ownerHtml.includes(withheld), `${withheld} must exist for an owner, or this proves nothing`);
      assert.ok(!html.includes(withheld), `${withheld} must not render for a viewer`);
    }
    // Shift takings belong to whoever runs the floor. What the food costs and
    // what the business keeps do not, and they travel together in the
    // snapshot — so they are checked by name, not by section heading.
    for (const figure of ['Food cost', 'Prime cost', 'Gross profit', 'Invoices this week']) {
      assert.ok(!html.includes(figure), `${figure} is a costs figure and must not reach a shifts viewer`);
    }
    // Quick actions are writes; a view-only account gets none of them at all.
    assert.ok(!html.includes('class="qact"'), 'no write shortcuts for a viewer');
    // And nothing from the trackers/payroll/cash areas leaks into the lists.
    for (const leak of ['/c/invoices', '/c/recurring', '/c/products', '/payroll', '/cash']) {
      assert.ok(!html.includes(`href="${leak}"`), `must not link to ${leak}`);
    }
  } finally {
    const owned = users.byEmail.get('dash@test.local');
    if (owned) users.del.run(owned.id);
  }
});

test('an owner does see the full dashboard', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const html = await (await as(owner, '/')).text();
  // Today is a strip of notices rather than a headed section, so it is checked
  // by the notice markup. "Upcoming" is now "Coming up" and only renders when
  // something is actually due; Insights moved to Performance, which is the
  // page that exists to explain why a number moved.
  for (const section of ['File an entry', 'The week in numbers', 'Last service', 'The record']) {
    assert.ok(html.includes(section), `${section} renders for the owner`);
  }
  assert.match(html, /id="bs-bb"/, 'and the billboard');
});

// A view-only account being refused a write is correct. Being *offered* the
// write first is not: someone signed in as a viewer, picked an invoice,
// waited for it to be read, and got an error blaming the file. The server did
// its job — it was the page that shouldn't have asked.
test('a view-only account is not offered writes it cannot perform', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const gone = users.byEmail.get('ro@test.local');
  if (gone) users.del.run(gone.id);
  await as(owner, '/users', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['name', 'Read Only Two'], ['email', 'ro@test.local'],
      ['password', 'ro-password-1'], ['role', 'viewer'],
      ['features', 'dashboard'], ['features', 'shifts'], ['features', 'trackers'],
      ['features', 'cash']]).toString(),
  });
  const v = await login({ email: 'ro@test.local', password: 'ro-password-1' });
  try {
    for (const path of ['/c/invoices', '/c/products', '/c/vendors', '/c/recurring',
      '/c/expirations', '/c/contacts', '/shifts']) {
      const res = await as(v, path);
      assert.strictEqual(res.status, 200, `${path} is readable`);
      const html = await res.text();
      // Everything that opens or submits a write.
      for (const trap of ['invDrawer(true)', 'prodDrawer(true)', 'vDrawer(true)',
        'rcDrawer(true)', 'class="add-panel"', 'Save invoice', 'Mark done']) {
        assert.ok(!html.includes(trap), `${path} still offers "${trap}" to a viewer`);
      }
      // The standing notice is a bs-notice-bar now, same job, one shape for
      // every message the app puts in front of you.
      assert.match(html, /bs-notice-k">View only</, `${path} says the account is view-only`);
    }

    // And the upload endpoint refuses in a way the page can explain, rather
    // than returning something that blows up JSON.parse on the client.
    const refused = await as(v, '/c/invoices/read', { method: 'POST' });
    assert.strictEqual(refused.status, 403);
    assert.match(await refused.text(), /view-only/i, 'says why, so the UI can too');
  } finally {
    const row = users.byEmail.get('ro@test.local');
    if (row) users.del.run(row.id);
  }
});

test('the owner still gets every write control', async () => {
  const owner = await login({ password: 'test-manager-password' });
  const html = await (await as(owner, '/c/invoices')).text();
  assert.ok(html.includes('invDrawer(true)'), 'upload is offered');
  assert.ok(!/bs-notice-k">View only</.test(html), 'and no view-only notice');
});

test('disabling an account revokes it immediately, not at cookie expiry', async () => {
  const v = await login({ email: 'viewer@test.local', password: 'viewer-password-1' });
  assert.strictEqual((await as(v, '/sales')).status, 200);

  const row = users.byEmail.get('viewer@test.local');
  users.setActive.run(0, row.id);
  // Same cookie: still correctly signed, still unexpired. Access is gone
  // because the account is re-checked on every request.
  assert.strictEqual((await as(v, '/sales')).status, 302, 'bounced to login');

  users.setActive.run(1, row.id);
  assert.strictEqual((await as(v, '/sales')).status, 200, 're-enabling restores it');
  users.del.run(row.id);
});

test('a wrong password is refused, and a forged cookie gets nothing', async () => {
  assert.strictEqual(await login({ email: 'viewer@test.local', password: 'wrong' }), '');
  const forged = '1.' + (Date.now() + 8.64e7) + '.deadbeefdeadbeefdeadbeefdeadbeef';
  assert.strictEqual((await as(forged, '/payroll')).status, 302, 'forged token rejected');
});

// ---------------------------------------------------------------------------
// The sign-in page's appearance, and the stylesheet it depends on.
//
// /login was the last screen still on the old look — a white card with a 20px
// radius and a drop shadow, floating on solid blue — and it was the only thing
// still holding the `.tips-*` rules alive. Moving it onto the staff portal's
// shell made those rules dead, and deleting dead CSS is where the damage
// happens: an earlier attempt at exactly this deleted rules the page still
// needed, and the check that was supposed to catch it was written wrong and
// reported nothing either way.
//
// So the guard is the honest direction: whatever these pages emit must have a
// rule somewhere in the stylesheets they load.
// ---------------------------------------------------------------------------

const fs = require('node:fs');

/** Every class name that has at least one rule across the linked stylesheets. */
function styledClasses() {
  const css = ['styles.css', 'broadsheet.css', 'staff.css']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')).join('\n');
  // Comments blanked length-preserving, so a comment can never read as a
  // selector — that mistake is what deleted live rules the first time.
  const noc = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const out = new Set();
  for (const rule of noc.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const sel = rule[1].trim();
    if (!sel) continue;
    for (const c of sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)) out.add(c[1]);
  }
  return out;
}

/** Classes in the markup, ignoring <script> bodies — a class attribute built
 *  from a template literal is not a class, and counting it as one produces
 *  nonsense like `.'+(out?'out':'in')+'`. */
function emittedClasses(html) {
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const out = new Set();
  for (const m of markup.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

test('the sign-in page is on the broadsheet shell, not the old card', async () => {
  const html = await (await get('/login')).text();
  assert.match(html, /<div class="tp">/, 'the staff portal shell');
  assert.match(html, /class="tp-h">Sign in\./, 'a serif headline');
  assert.match(html, /class="tp-go"[^>]*form="signin"/, 'a full-width button reaching the form by id');
  for (const dead of ['tips-screen', 'tips-card', 'tips-title', 'tips-lead', 'tips-error',
    'tips-field', 'tips-in', 'tips-hint', 'tips-submit']) {
    assert.ok(!emittedClasses(html).has(dead), `.${dead} is gone from the markup`);
  }
});

test('the old sign-in styles are gone from the stylesheet too', () => {
  // Left behind, they are 11 rules nothing can ever match, and the next person
  // reading styles.css has to work out which of two sign-in designs is live.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(!/\.tips-/.test(css), 'no .tips-* rules remain');
});

test('every class the staff-facing pages emit has a rule behind it', async () => {
  // Scoped to the two pages this change touched. The rest of the app has a
  // handful of long-standing unstyled classes; widening this test would mean
  // fixing those, which is a different job.
  const styled = styledClasses();
  const pages = ['/login', '/login?bad=1', '/tips'];
  const bare = [];
  let seen = 0;
  for (const p of pages) {
    const res = await get(p);
    assert.strictEqual(res.status, 200, `${p} renders`);
    const emitted = emittedClasses(await res.text());
    assert.ok(emitted.size > 8, `${p} emitted ${emitted.size} classes`);
    seen += emitted.size;
    for (const c of emitted) if (!styled.has(c)) bare.push(`${p}: .${c}`);
  }
  assert.ok(seen > 40, `checked ${seen} class uses`);
  assert.deepStrictEqual(bare, [], 'a class with no rule means CSS was deleted that a page still needs');
});

test('signing in still works, and still cannot be pointed off-site', async () => {
  // The markup changed; the handler did not. Proving that is the point.
  const bad = await post('/login', { password: 'wrong', next: '/payroll' });
  assert.strictEqual(bad.status, 302);
  assert.match(bad.headers.get('location'), /^\/login\?bad=1/, 'back to the form, flagged');
  assert.ok(!(bad.headers.get('set-cookie') || '').includes('rc_auth='), 'and no session handed out');

  const ok = await post('/login', { password: 'test-manager-password', next: '/payroll' });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.headers.get('location'), '/payroll', 'sent where you were going');
  assert.match(ok.headers.get('set-cookie') || '', /rc_auth=/, 'with a session');

  const away = await post('/login', { password: 'test-manager-password', next: 'https://evil.example' });
  assert.strictEqual(away.headers.get('location'), '/', 'an off-site next is ignored');
});

test('the login screen installs the manager app, not the tip form', async () => {
  // /login is rendered "bare" — no app chrome — and that flag was also being
  // read as "this is the staff portal", so it served manifest-tips, whose
  // start_url is /tips. Adding the login screen to a home screen produced a
  // shortcut that opened the tip form. This only shows up where APP_PASSWORD
  // is set, which is why it lives here.
  const html = await (await get('/login')).text();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/,
    'the manager manifest, so the shortcut opens the dashboard');
  assert.ok(!/manifest-tips/.test(html), 'not the staff one');
  assert.match(html, /apple-mobile-web-app-title" content="ZWIN"/, 'and it is named ZWIN on the home screen');
});
