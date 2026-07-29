'use strict';

// ---------------------------------------------------------------------------
// THROTTLING THE ONE CREDENTIAL SOMEBODY CAN GUESS.
//
// A staff PIN is four digits. Ten thousand of them, and the portal sign-in used
// to answer as fast as the database could compare a string — a scripted guesser
// walks the whole space in minutes, on a page that then shows somebody's hours
// and lets a punch be filed in their name.
//
// Two buckets, both needed:
//
//   PER PERSON  — five wrong PINs for one employee locks THAT employee's PIN
//                 for ten minutes. Stops the obvious attack on one person.
//   PER SOURCE  — the same address failing over and over locks the address,
//                 at a higher count. Stops the same script spraying one PIN
//                 across every employee, which the per-person bucket never sees
//                 because no single person accumulates failures.
//
// Persisted rather than held in memory, because a restart is not a defence and
// a guesser can wait one out. The row IS the log: how many, when it started,
// when it was last tried. The PIN itself is never written anywhere.
//
// Nobody is locked out permanently. Both buckets expire on their own, and a
// correct PIN clears the person's bucket immediately — the lock is a speed
// limit, not a punishment, and a cook halfway through a shift must not be
// stranded because somebody else was careless.
// ---------------------------------------------------------------------------

const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS auth_attempts (
  scope        TEXT NOT NULL,          -- 'pin' | 'pin-ip'
  ident        TEXT NOT NULL,          -- employee id, or a source address
  fails        INTEGER NOT NULL DEFAULT 0,
  first_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_at      TEXT NOT NULL DEFAULT (datetime('now')),
  locked_until TEXT,
  PRIMARY KEY (scope, ident)
);
`);

const q = {
  get: db.prepare('SELECT * FROM auth_attempts WHERE scope = ? AND ident = ?'),
  bump: db.prepare(`INSERT INTO auth_attempts (scope, ident, fails)
    VALUES (@scope, @ident, 1)
    ON CONFLICT(scope, ident) DO UPDATE SET
      fails = auth_attempts.fails + 1, last_at = datetime('now')`),
  lock: db.prepare(`UPDATE auth_attempts SET locked_until = datetime('now', @secs)
    WHERE scope = @scope AND ident = @ident`),
  clear: db.prepare('DELETE FROM auth_attempts WHERE scope = ? AND ident = ?'),
  sweep: db.prepare(`DELETE FROM auth_attempts
    WHERE (locked_until IS NULL AND last_at < datetime('now', '-1 hour'))
       OR (locked_until IS NOT NULL AND locked_until < datetime('now', '-1 hour'))`),
};

// Deliberately generous on the address bucket, and tunable without a deploy.
//
// A restaurant is one router. Everyone on the floor shares an address, so the
// address bucket is the one that can hurt: trip it and the clock stops for
// everybody until it expires. That is the unavoidable cost of actually refusing
// to evaluate guesses — a lock that still checks the PIN stops nothing, because
// the guesser just keeps guessing through it.
//
// So the per-EMPLOYEE bucket is the tight one, and it is the real protection
// against somebody targeting a person. The address bucket sits far enough out
// that a shift-change flurry of fat fingers will not reach it, and exists to
// catch one PIN sprayed across the whole roster — which the per-employee bucket
// never sees, because no single person accumulates the failures.
//
// PIN_MAX / PIN_LOCK_SECS / PIN_IP_MAX / PIN_IP_LOCK_SECS override these.
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const LIMITS = {
  pin: {
    max: num(process.env.PIN_MAX, 5),
    lockSecs: num(process.env.PIN_LOCK_SECS, 600),
  },
  'pin-ip': {
    max: num(process.env.PIN_IP_MAX, 25),
    lockSecs: num(process.env.PIN_IP_LOCK_SECS, 900),
  },
};

const nowSql = () => db.prepare("SELECT datetime('now') n").get().n;

/** Seconds until a bucket unlocks, or 0 when it is open. */
function lockedFor(scope, ident) {
  if (!ident) return 0;
  const row = q.get.get(scope, String(ident));
  if (!row || !row.locked_until) return 0;
  const left = Math.ceil((Date.parse(row.locked_until + 'Z') - Date.parse(nowSql() + 'Z')) / 1000);
  return left > 0 ? left : 0;
}

/**
 * May this attempt even be checked?
 *
 * Called BEFORE comparing the PIN, so a locked bucket costs the guesser a round
 * trip and tells them nothing. Returns the longest wait of the buckets given.
 */
function mayTry(...buckets) {
  let worst = 0;
  for (const [scope, ident] of buckets) worst = Math.max(worst, lockedFor(scope, ident));
  return { ok: worst === 0, retryIn: worst };
}

/** Record a wrong PIN. Locks a bucket once it passes its limit. */
function failed(...buckets) {
  for (const [scope, ident] of buckets) {
    if (!ident) continue;
    const id = String(ident);
    q.bump.run({ scope, ident: id });
    const row = q.get.get(scope, id);
    const lim = LIMITS[scope] || LIMITS.pin;
    if (row && row.fails >= lim.max && !row.locked_until) {
      q.lock.run({ scope, ident: id, secs: `+${lim.lockSecs} seconds` });
      // The PIN is never in here — only that something failed, and how often.
      console.warn(`[guard] ${scope} ${id} locked for ${lim.lockSecs}s after ${row.fails} failures`);
    }
  }
}

/**
 * A correct PIN. Clears that person's bucket at once.
 *
 * The address bucket is deliberately NOT cleared: one lucky guess in a spray
 * should not reset the evidence of the spray.
 */
function passed(scope, ident) {
  if (ident) q.clear.run(scope, String(ident));
}

/** Best-effort source address, behind a proxy or not. */
function sourceOf(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** One line for a person who got it wrong, saying nothing about what was wrong. */
function waitMessage(secs) {
  const mins = Math.ceil(secs / 60);
  return `Too many tries. Wait ${mins} minute${mins === 1 ? '' : 's'} and try again, or ask your manager.`;
}

// Old rows are noise, not evidence, once everything has expired.
try { q.sweep.run(); } catch { /* first boot */ }

module.exports = { mayTry, failed, passed, sourceOf, waitMessage, lockedFor, LIMITS, _q: q };
