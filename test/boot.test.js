'use strict';

// The app boots against a database it has never seen on every fresh deploy,
// and against a database one version behind on every ordinary one. Neither is
// what a developer runs: a working copy has been through every migration
// already, in whatever order they happened to be written.
//
// That gap shipped a broken build. A prepared statement naming a column was
// created before the module that adds that column had been required, so the
// server died on startup everywhere except the machine it was written on —
// and the host kept serving the previous build, which looked exactly like
// nothing had deployed.
//
// These boot a real server against a throwaway database and check it answers.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

/** Boot the app against `dbPath`, return {ok, status, log}. Always cleans up. */
async function boot(dbPath, port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  try {
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) return { ok: false, status: 0, log };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/c/products`, { redirect: 'manual' });
        return { ok: true, status: res.status, log };
      } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return { ok: false, status: 0, log: log + '\n(timed out)' };
  } finally {
    child.kill();
  }
}

function tmpDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-boot-'));
  return { path: path.join(dir, name), dir };
}

test('the app boots against a database it has never seen', async () => {
  const { path: dbPath, dir } = tmpDb('fresh.db');
  try {
    const { ok, status, log } = await boot(dbPath, 3971);
    assert.ok(ok, `server did not come up:\n${log}`);
    assert.strictEqual(status, 200, 'Products answers on a brand new database');
    // A migration that skips itself is worse than one that fails: nothing is
    // wrong until months later, when the thing it should have moved is missing.
    assert.ok(!/migration skipped/i.test(log), `a migration skipped itself:\n${log}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the app boots against a database from before Products existed', async () => {
  // The shape that actually deploys: the previous release's tables, with rows
  // in the old par-level tracker and no products tables at all.
  const { path: dbPath, dir } = tmpDb('old.db');
  try {
    const Database = require('better-sqlite3');
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE m_par (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT,
        item TEXT, vendor_id TEXT, unit TEXT, par_level REAL, reorder_point REAL, on_hand REAL, notes TEXT);
      INSERT INTO m_par (item, vendor_id, unit, par_level, reorder_point, on_hand)
        VALUES ('Ribeye', '6', 'lb', 40, 15, 30), ('To-go cups', '8', 'case', 10, 3, 2);
    `);
    old.close();

    const { ok, status, log } = await boot(dbPath, 3972);
    assert.ok(ok, `server did not come up on an old database:\n${log}`);
    assert.strictEqual(status, 200);

    const check = new Database(dbPath, { readonly: true });
    const names = check.prepare('SELECT name FROM products ORDER BY name').all().map((r) => r.name);
    const par = check.prepare('SELECT COUNT(*) n FROM m_par').get().n;
    check.close();
    assert.deepStrictEqual(names, ['Ribeye', 'To-go cups'], 'par rows were carried over');
    assert.strictEqual(par, 2, 'and the old table is left alone as the only copy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A test file that never sets DB_PATH inherits the default, which is data.db —
// the database somebody is actually developing against. schedule-issues.test.js
// did that for as long as it existed, seeding two employees per run and
// cleaning up neither: the dev roster reached 320 fixture rows against 14 real
// people, and the schedule board was mostly strangers named "Issue Anna".
//
// Nothing failed, which is why it lasted. A leak into a database no assertion
// reads has no symptom until somebody looks at the app.
test('every test file that touches the database gets one of its own', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = __dirname;

  // engine.test.js is deliberately different: it compares the SQL wage rule
  // against the JS one across whatever shifts REALLY exist, which is the whole
  // point of it — a fresh database has none to compare. It only reads, and the
  // one place it writes is wrapped in BEGIN/ROLLBACK. Any other file added
  // here needs the same two properties spelled out.
  const READS_LIVE_DATA = new Set(['engine.test.js']);

  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // An actual require, not any mention of one — this very file names the
    // module as a search string two lines up, and matched itself the first
    // time this ran.
    const m = /=\s*require\('\.\.\/src\/db'\)/.exec(src);
    if (!m) continue;
    const usesDb = m.index;
    if (READS_LIVE_DATA.has(f)) {
      // Hold the exception to its bargain rather than trusting the comment.
      assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(src) || /db\.exec\('ROLLBACK'\)/.test(src),
        `${f} is exempt from DB_PATH, so every write it makes must be rolled back`);
      continue;
    }
    const setsPath = src.indexOf('process.env.DB_PATH');
    assert.notStrictEqual(setsPath, -1,
      `${f} requires src/db without setting DB_PATH — it will write into data.db`);
    // db.js reads DB_PATH when it is required, so setting it afterwards is the
    // same as not setting it at all, and looks correct while it happens.
    assert.ok(setsPath < usesDb,
      `${f} sets DB_PATH after requiring src/db, which is too late to matter`);
  }
});

// Two files binding the same port is not a test failure, it is a coin toss:
// the suite runs them in parallel and whichever loses shows up as a dozen
// unrelated assertions failing in a file you did not touch. Cheaper to check
// than to diagnose again.
test('every test file that spawns a server claims its own port', () => {
  const dir = require('node:path').join(__dirname);
  const seen = new Map();
  // EVERY port a file binds, not only its top-level `const PORT`.
  //
  // The old rule matched `^const PORT = n;` and nothing else, so a second
  // server spawned inside a test body was invisible to it. portal.test.js did
  // exactly that on 3995 — schedule-board.test.js's port — and the two raced
  // for the socket on every parallel run. Whichever lost sent its requests to
  // the other app, and one assertion failed with nothing wrong in the code it
  // was testing. That is the failure this guard exists to prevent, and it
  // walked straight past it.
  for (const f of require('node:fs').readdirSync(dir).filter((x) => x.endsWith('.test.js'))) {
    const src = require('node:fs').readFileSync(require('node:path').join(dir, f), 'utf8');
    const ports = new Set();
    for (const m of src.matchAll(/^const PORT = (\d+);/gm)) ports.add(Number(m[1]));
    // A port declared anywhere else in the file — inside a test, in a spawn env.
    for (const m of src.matchAll(/\bconst port = (\d{4});/g)) ports.add(Number(m[1]));
    for (const m of src.matchAll(/PORT: String\((\d{4})\)/g)) ports.add(Number(m[1]));
    if (!ports.size) continue;
    for (const port of ports) {
      assert.ok(!seen.has(port) || seen.get(port) === f,
        `${f} and ${seen.get(port)} both bind ${port}`);
      seen.set(port, f);
    }
    // dashboard.test.js starts a second server on PORT + 1.
    for (const port of ports) {
      assert.ok(!seen.has(port + 1) || seen.get(port + 1) === f,
        `${f} may also use ${port + 1}, which ${seen.get(port + 1)} claims`);
    }
  }
  assert.ok(seen.size >= 4, `found ${seen.size} spawning files, expected several`);
});
