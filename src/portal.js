'use strict';

// ---------------------------------------------------------------------------
// THE STAFF PORTAL — the three things it holds that nothing else did
//
// Everything the portal shows about money already existed: hours, tips, the
// tip-out, what a person kept. That comes from the engine and is not stored
// again here. What is new is the three-way traffic between a manager and the
// floor, which had nowhere to live:
//
//   notes     — "before your shift", posted by a manager, expire on a date
//   specials  — today's board and what is 86'd, posted by a manager, read on the floor
//   stock     — "we're out of oat milk", reported from the floor, acted on by a manager
//
// Two of the three are manager → staff and one is staff → manager, which is
// why they are one module: they are the same conversation in both directions,
// and a manager wants them on one screen.
//
// Kept out of the module registry deliberately. That registry gives a table a
// generic list-and-form CRUD, and none of these three want it — a note has an
// expiry that decides whether it renders at all, the board is two lists that
// are really one list in two states, and a stock report is a queue with a
// lifecycle. The registry would have to grow three special cases to serve them.
// ---------------------------------------------------------------------------

const { db } = require('./db');
// A stock report joins products and m_vendors to name what was reported and
// who supplies it, and a prepared statement is compiled the moment this file
// is required — so both tables have to exist by then. modules.js makes
// m_vendors, products.js makes products. Declaring it here means this file can
// be loaded on its own by a test or a script instead of only working because
// server.js happens to require them first. Neither requires this file back, so
// there is no cycle.
require('./modules');
require('./products');

db.exec(`
-- Short-lived announcements. A note is written for a day or a few days and is
-- meant to stop mattering on its own: "private event tonight", "the left
-- grouphead is down". Without an expiry a board like this fills with stale
-- notices in a fortnight and staff stop reading it, which is worse than not
-- having one.
CREATE TABLE IF NOT EXISTS portal_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT,
  -- urgent | caution | fyi — the colour of the left bar, and the only thing
  -- colour means here.
  tone       TEXT NOT NULL DEFAULT 'fyi',
  starts_on  TEXT NOT NULL,
  ends_on    TEXT,                       -- NULL = only the day it starts
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_note_window ON portal_notes (starts_on, ends_on);

-- The board. One table for both halves of it: a dish that is 86'd is the same
-- dish, in a different state, and splitting them into two tables would mean
-- moving rows between them every time something sells out.
CREATE TABLE IF NOT EXISTS portal_specials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  service_date TEXT NOT NULL,
  name         TEXT NOT NULL,
  price_cents  INTEGER,
  description  TEXT,
  -- Free text on purpose: "6 left", "one portion", "until the lamb runs out".
  -- A number would force a count nobody is keeping.
  low_note     TEXT,
  -- NULL while it is running. A timestamp is what makes the board able to say
  -- "86'D 6PM", which is the part staff actually use to know if it went before
  -- or after they last looked.
  eighty_sixed_at TEXT,
  sold_out_note   TEXT,
  sort         INTEGER NOT NULL DEFAULT 100,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_special_day ON portal_specials (service_date DESC, sort);

-- What the floor has run out of. An event, not a flag on a product: the
-- manager's question is "what has been reported and have I dealt with it",
-- which needs a history and a person attached. Where a report names a product
-- we already buy, product_id links it — so the vendor is one join away and the
-- report can become an order.
CREATE TABLE IF NOT EXISTS portal_stock (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item        TEXT NOT NULL,
  product_id  INTEGER,
  -- out | low | order — how urgent, in the reporter's words.
  status      TEXT NOT NULL DEFAULT 'out',
  note        TEXT,
  employee_id INTEGER,
  reported_by TEXT,
  -- Everything sent in one press shares a batch, so the manager reads "Rosa
  -- sent 3 things at 4pm" rather than three unrelated rows.
  batch       TEXT,
  reported_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- ordered | restocked | dismissed. Set together with resolved_at, so a
  -- report is either open or answered and there is no third state.
  resolution  TEXT,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_stock_open ON portal_stock (reported_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_stock_all  ON portal_stock (reported_at DESC);
`);

// --- notifications ---------------------------------------------------------
// A small event feed the staff portal reads. Anything the floor should know the
// moment it changes — a special posted, a dish 86'd, a before-shift note, a
// shift's pay sent — is written here as one row, and each person sees what is
// new since they last looked. employee_id NULL means everyone; a value means
// just that person (their own earnings). This is also the seam push
// notifications hang off later: one place every event is born.
db.exec(`
CREATE TABLE IF NOT EXISTS portal_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,            -- special | special_86 | note | earnings
  title       TEXT NOT NULL,
  body        TEXT,
  employee_id INTEGER,                  -- NULL = every staff member
  href        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pevents ON portal_events (created_at DESC);

-- The highest event id each person has already seen, so "new" is per person
-- and immune to timestamp granularity — an event posted in the same second the
-- hub was opened still counts as new, because ids only ever go up.
CREATE TABLE IF NOT EXISTS portal_seen (
  employee_id INTEGER PRIMARY KEY,
  seen_id     INTEGER NOT NULL DEFAULT 0
);

-- Web Push subscriptions: one per device a staff member turned notifications on
-- from. Keyed by endpoint (the browser's unique push address) so re-subscribing
-- the same device updates rather than duplicates. A person can have several — a
-- phone and a tablet — and they all get the push.
CREATE TABLE IF NOT EXISTS portal_push (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  sub         TEXT NOT NULL,            -- the full PushSubscription JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_emp ON portal_push (employee_id);
`);

// --- admin notifications ----------------------------------------------------
// A second event feed, for the back office rather than the floor. Where
// portal_events tells staff what changed on their board, these tell the owner
// and managers when the day's operational milestones happen — a shift sent, a
// register closed, payroll out, an incident filed — and, always, when the floor
// reports something out of stock. Kept in its own tables, entirely separate
// from the staff ones above, so the two systems can never interfere: the staff
// portal's push, which the whole team just re-installed and confirmed working,
// is not touched by anything here.
db.exec(`
CREATE TABLE IF NOT EXISTS admin_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,     -- sales_day | shift | payroll | cash | floor | incident
  title      TEXT NOT NULL,
  body       TEXT,
  href       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_events ON admin_events (created_at DESC);

-- The highest event id each account has already seen. uid is 'm' for the owner
-- or the user row's id as text, so "new" is per person and immune to
-- same-second collisions, exactly as portal_seen is for staff.
CREATE TABLE IF NOT EXISTS admin_seen (
  uid     TEXT PRIMARY KEY,
  seen_id INTEGER NOT NULL DEFAULT 0
);

-- Web Push subscriptions for the back office: one per device an admin turned
-- notifications on from. Its own table, keyed by endpoint like portal_push, so
-- the staff and admin subscription lists never mix. uid records who turned it
-- on; every admin event pushes to every admin device, because these events are
-- addressed to "the office", not to one person.
CREATE TABLE IF NOT EXISTS admin_push (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  sub        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_push_uid ON admin_push (uid);

-- Some admin alerts come from a daily sweep, not a one-off action, so the same
-- situation ("this invoice is overdue", "this document expires in 14 days")
-- would fire again every morning. This records a stable key the first time an
-- alert is raised and stays silent after — the sweep can run as often as it
-- likes and each distinct situation is announced exactly once.
CREATE TABLE IF NOT EXISTS admin_notified (
  key        TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The same idea for staff. Separate from the admin table because the two are
-- decided by different code and a key collision between them would silence a
-- notification nobody could then explain.
CREATE TABLE IF NOT EXISTS staff_notified (
  key        TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Which positions hand in tips at the end of a shift.
//
// The portal has to know, because a kitchen cook opening it should not be
// asked for sales they never took or tips they never collected — and being
// asked is worse than useless, it implies the manager expects an answer.
//
// A column on positions rather than a list of role names in code: you already
// edit positions, the set is yours to change, and a hard-coded "kitchen and
// busser don't" would be wrong at the first restaurant that tips its cooks
// directly. Defaulted on, because that is what every position did before this
// existed — then turned off once for the two that seed with it, which is the
// arrangement here today and a starting point rather than a rule.
const posCols = db.prepare('PRAGMA table_info(positions)').all().map((c) => c.name);
if (!posCols.includes('takes_tips')) {
  db.exec('ALTER TABLE positions ADD COLUMN takes_tips INTEGER NOT NULL DEFAULT 1');
  // Off for the two that seed with it, and for anything already declared
  // non-tipped — a position whose own kind says it takes no tips should not
  // then be asked for them. Seeding by slug alone missed that: a "Training"
  // position of kind non_tipped came out asked-to-submit, which is a defect
  // rather than a preference.
  db.prepare(`UPDATE positions SET takes_tips = 0
    WHERE slug IN ('kitchen', 'busser') OR kind = 'non_tipped'`).run();
}

const q = {
  // --- notes ---------------------------------------------------------------
  // Live today: started, and either open-ended or not yet finished.
  notesFor: db.prepare(`SELECT * FROM portal_notes
    WHERE starts_on <= @on AND (ends_on IS NULL OR ends_on >= @on)
    ORDER BY CASE tone WHEN 'urgent' THEN 0 WHEN 'caution' THEN 1 ELSE 2 END, id`),
  notesAll: db.prepare('SELECT * FROM portal_notes ORDER BY starts_on DESC, id DESC'),
  addNote: db.prepare(`INSERT INTO portal_notes (title, body, tone, starts_on, ends_on, created_by)
    VALUES (@title, @body, @tone, @starts_on, @ends_on, @created_by)`),
  oneNote: db.prepare('SELECT * FROM portal_notes WHERE id = ?'),
  // Edit in place. The id does not move, so a note somebody has already read
  // stays the same note — correcting a typo is not a new announcement, and
  // delete-and-repost was the only way to do it before.
  updateNote: db.prepare(`UPDATE portal_notes
    SET title = @title, body = @body, tone = @tone, starts_on = @starts_on, ends_on = @ends_on
    WHERE id = @id`),
  delNote: db.prepare('DELETE FROM portal_notes WHERE id = ?'),

  // --- specials ------------------------------------------------------------
  // The board is evergreen: a special stays up until the manager deletes it, so
  // this — every special, ordered — is what the board shows everywhere. The
  // per-day specialsFor is kept for anything that still asks for a single day.
  specialsAll: db.prepare('SELECT * FROM portal_specials ORDER BY sort, id'),
  specialsFor: db.prepare('SELECT * FROM portal_specials WHERE service_date = ? ORDER BY sort, id'),
  specialsRecent: db.prepare(`SELECT * FROM portal_specials
    WHERE service_date >= ? ORDER BY service_date DESC, sort, id`),
  addSpecial: db.prepare(`INSERT INTO portal_specials (service_date, name, price_cents, description, low_note, sort)
    VALUES (@service_date, @name, @price_cents, @description, @low_note, @sort)`),
  // Edit the fields a manager can get wrong — not the 86 state, which has its
  // own actions, and not the day, which would move it to a board it was never
  // put on.
  updateSpecial: db.prepare(`UPDATE portal_specials
    SET name = @name, price_cents = @price_cents, description = @description, low_note = @low_note
    WHERE id = @id`),
  oneSpecial: db.prepare('SELECT * FROM portal_specials WHERE id = ?'),
  eightySix: db.prepare(`UPDATE portal_specials
    SET eighty_sixed_at = datetime('now'), sold_out_note = @note WHERE id = @id`),
  unEightySix: db.prepare("UPDATE portal_specials SET eighty_sixed_at = NULL, sold_out_note = NULL WHERE id = ?"),
  delSpecial: db.prepare('DELETE FROM portal_specials WHERE id = ?'),
  // The board's "UPDATED 2:15 PM" — the latest thing that happened to the board,
  // whenever it was; the board no longer resets by day.
  boardTouched: db.prepare(`SELECT MAX(COALESCE(eighty_sixed_at, created_at)) AS at
    FROM portal_specials`),

  // --- stock ---------------------------------------------------------------
  stockOpen: db.prepare(`SELECT s.*, p.name AS product_name, v.name AS vendor_name
    FROM portal_stock s
    LEFT JOIN products p ON p.id = s.product_id
    LEFT JOIN m_vendors v ON v.id = p.vendor_id
    WHERE s.resolved_at IS NULL ORDER BY s.reported_at DESC, s.id DESC`),
  stockRecent: db.prepare(`SELECT s.*, p.name AS product_name, v.name AS vendor_name
    FROM portal_stock s
    LEFT JOIN products p ON p.id = s.product_id
    LEFT JOIN m_vendors v ON v.id = p.vendor_id
    ORDER BY s.reported_at DESC, s.id DESC LIMIT 60`),
  // What this person sent recently, for the "recently sent" line on their own
  // report screen — their own reports only.
  stockMine: db.prepare(`SELECT * FROM portal_stock WHERE employee_id = ?
    ORDER BY reported_at DESC, id DESC LIMIT 6`),
  addStock: db.prepare(`INSERT INTO portal_stock (item, product_id, status, note, employee_id, reported_by, batch)
    VALUES (@item, @product_id, @status, @note, @employee_id, @reported_by, @batch)`),
  resolveStock: db.prepare(`UPDATE portal_stock
    SET resolution = @resolution, resolved_at = datetime('now'), resolved_by = @resolved_by
    WHERE id = @id`),
  reopenStock: db.prepare('UPDATE portal_stock SET resolution = NULL, resolved_at = NULL, resolved_by = NULL WHERE id = ?'),
  openCount: db.prepare('SELECT COUNT(*) n FROM portal_stock WHERE resolved_at IS NULL'),

  // --- notifications -------------------------------------------------------
  addEvent: db.prepare(`INSERT INTO portal_events (kind, title, body, employee_id, href)
    VALUES (@kind, @title, @body, @employee_id, @href)`),
  // Everything addressed to this person or to everyone, newest first.
  eventsFor: db.prepare(`SELECT * FROM portal_events
    WHERE employee_id IS NULL OR employee_id = @id
    ORDER BY created_at DESC, id DESC LIMIT 40`),
  // New since they last looked, by id. A first-time viewer (no seen row) sees
  // only events from the last two days, so a fresh sign-in never dumps the whole
  // history as "new".
  unseenFor: db.prepare(`SELECT * FROM portal_events
    WHERE (employee_id IS NULL OR employee_id = @id)
      AND id > COALESCE(
        (SELECT seen_id FROM portal_seen WHERE employee_id = @id),
        (SELECT COALESCE(MAX(id), 0) FROM portal_events WHERE created_at <= datetime('now','-2 days')))
    ORDER BY id DESC LIMIT 40`),
  // Mark everything up to the newest event as seen for this person.
  markSeen: db.prepare(`INSERT INTO portal_seen (employee_id, seen_id)
      VALUES (@id, (SELECT COALESCE(MAX(id), 0) FROM portal_events))
    ON CONFLICT(employee_id) DO UPDATE SET seen_id = excluded.seen_id`),
  // The first time we ever see a person, pin their baseline to right now — so a
  // brand-new employee (or one on a new device) starts with a clean slate and
  // only ever sees notifications posted after they arrive, never the backlog.
  // INSERT OR IGNORE: it sets the baseline once and never disturbs it again, so
  // it can't reset someone who has already been keeping up.
  ensureSeen: db.prepare(`INSERT OR IGNORE INTO portal_seen (employee_id, seen_id)
    VALUES (@id, (SELECT COALESCE(MAX(id), 0) FROM portal_events))`),

  // --- push subscriptions --------------------------------------------------
  savePush: db.prepare(`INSERT INTO portal_push (employee_id, endpoint, sub)
      VALUES (@employee_id, @endpoint, @sub)
    ON CONFLICT(endpoint) DO UPDATE SET employee_id = excluded.employee_id, sub = excluded.sub`),
  delPush: db.prepare('DELETE FROM portal_push WHERE endpoint = ?'),
  pushAll: db.prepare('SELECT endpoint, sub FROM portal_push'),
  pushFor: db.prepare('SELECT endpoint, sub FROM portal_push WHERE employee_id = @id'),
  pushCountFor: db.prepare('SELECT COUNT(*) n FROM portal_push WHERE employee_id = @id'),

  // --- admin notifications (back office) -----------------------------------
  adminAdd: db.prepare(`INSERT INTO admin_events (kind, title, body, href)
    VALUES (@kind, @title, @body, @href)`),
  adminEvents: db.prepare(`SELECT * FROM admin_events
    ORDER BY created_at DESC, id DESC LIMIT 40`),
  // New since this account last looked, by id — same first-time guard as staff.
  adminUnseenFor: db.prepare(`SELECT * FROM admin_events
    WHERE id > COALESCE(
      (SELECT seen_id FROM admin_seen WHERE uid = @uid),
      (SELECT COALESCE(MAX(id), 0) FROM admin_events WHERE created_at <= datetime('now','-2 days')))
    ORDER BY id DESC LIMIT 40`),
  adminUnseenCount: db.prepare(`SELECT COUNT(*) n FROM admin_events
    WHERE id > COALESCE(
      (SELECT seen_id FROM admin_seen WHERE uid = @uid),
      (SELECT COALESCE(MAX(id), 0) FROM admin_events WHERE created_at <= datetime('now','-2 days')))`),
  adminMarkSeen: db.prepare(`INSERT INTO admin_seen (uid, seen_id)
      VALUES (@uid, (SELECT COALESCE(MAX(id), 0) FROM admin_events))
    ON CONFLICT(uid) DO UPDATE SET seen_id = excluded.seen_id`),
  // The admin twin of ensureSeen: the first time an account (owner or manager)
  // is seen, baseline it to now so it never inherits the backlog. INSERT OR
  // IGNORE, so an account that already has a baseline is left exactly as it is.
  ensureAdminSeen: db.prepare(`INSERT OR IGNORE INTO admin_seen (uid, seen_id)
    VALUES (@uid, (SELECT COALESCE(MAX(id), 0) FROM admin_events))`),
  adminSavePush: db.prepare(`INSERT INTO admin_push (uid, endpoint, sub)
      VALUES (@uid, @endpoint, @sub)
    ON CONFLICT(endpoint) DO UPDATE SET uid = excluded.uid, sub = excluded.sub`),
  adminDelPush: db.prepare('DELETE FROM admin_push WHERE endpoint = ?'),
  adminPushAll: db.prepare('SELECT endpoint, sub FROM admin_push'),
  adminPushFor: db.prepare('SELECT endpoint, sub FROM admin_push WHERE uid = @uid'),
  adminPushCountFor: db.prepare('SELECT COUNT(*) n FROM admin_push WHERE uid = @uid'),
  adminFiredHas: db.prepare('SELECT 1 FROM admin_notified WHERE key = ?'),
  adminFiredAdd: db.prepare('INSERT OR IGNORE INTO admin_notified (key) VALUES (?)'),
  staffFiredHas: db.prepare('SELECT 1 FROM staff_notified WHERE key = ?'),
  staffFiredAt: db.prepare('SELECT created_at FROM staff_notified WHERE key = ?'),
  staffFiredAdd: db.prepare('INSERT OR IGNORE INTO staff_notified (key) VALUES (?)'),
};

/**
 * Record a portal event for the staff feed. employeeId null = every staff
 * member; a value = just that person (their own earnings). Never throws — a
 * notification failing must not fail the action that raised it.
 */
function notify(kind, title, { body = null, employeeId = null, href = null } = {}) {
  try {
    q.addEvent.run({ kind, title, body, employee_id: employeeId ?? null, href });
  } catch { /* best effort — the board/note/pay change still stands */ }
  // Then push it to any device that opted in — fire and forget, so a failed or
  // unconfigured push never fails the action that raised it.
  try { sendPush(employeeId ?? null, { title, body: body || '', url: href || '/portal' }); }
  catch { /* push is best effort; the event is already recorded */ }
}

// --- Web Push ----------------------------------------------------------------
// The public key is not secret and ships to the client; the private key is the
// one env var the deploy has to set (VAPID_PRIVATE_KEY). With no private key,
// push is simply off and the in-app "What's new" feed carries on alone.
const webpush = require('web-push');
const crypto = require('crypto');
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
// Derive the public key from the private, so the key the client subscribes with
// can never disagree with the key the server signs with (that mismatch is a
// silent 403 and the #1 way push "just doesn't arrive"). An explicit
// VAPID_PUBLIC_KEY still wins if set; otherwise we compute it, and only fall
// back to a committed default when there is no private key at all.
function derivePublic(priv) {
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(priv, 'base64url'));
    return ecdh.getPublicKey().toString('base64url');
  } catch { return ''; }
}
// No placeholder. A public key with no private half behind it is worse than
// nothing: the browser accepts it, the device subscribes against it, and the
// row is stored — a subscription that can never be sent to, by anybody, ever.
// Then when a real key is finally configured the push service rejects those
// old subscriptions on the key mismatch, and the browser will not replace one
// in place. Empty instead, so the control can say push is not set up rather
// than manufacture dead registrations.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY
  || (VAPID_PRIVATE && derivePublic(VAPID_PRIVATE))
  || '';
const pushOn = !!VAPID_PRIVATE;
if (pushOn) {
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:notifications@zwin.app', VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (e) { console.error('[push] bad VAPID key pair — push disabled:', e && e.message); }
} else {
  console.warn('[push] VAPID_PRIVATE_KEY not set — web push is off (in-app notifications still work)');
}

/** Store (or refresh) a device's push subscription for a staff member. */
function savePush(employeeId, subscription) {
  try {
    const endpoint = subscription && subscription.endpoint;
    if (!endpoint || !employeeId) return false;
    q.savePush.run({ employee_id: employeeId, endpoint, sub: JSON.stringify(subscription) });
    return true;
  } catch { return false; }
}

/**
 * Push a payload to a person's devices (employeeId), or to everyone who opted
 * in (null). Best effort: a device that has gone away (404/410) is dropped so
 * the list never fills with dead endpoints.
 */
function sendPush(employeeId, payload) {
  if (!pushOn) return;
  let subs;
  try { subs = employeeId == null ? q.pushAll.all() : q.pushFor.all({ id: employeeId }); }
  catch { return; }
  if (!subs.length) return;
  const data = JSON.stringify(payload);
  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.sub); } catch { continue; }
    try {
      webpush.sendNotification(sub, data).catch((err) => {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          try { q.delPush.run(row.endpoint); } catch { /* cleaned next time */ }
        } else {
          // A real failure (403 key mismatch, 401 subject, 4xx/5xx) — log it so
          // "subscribed but no banner" is never invisible again.
          console.error('[push] send failed', code || '', err && err.body ? String(err.body).slice(0, 200) : (err && err.message) || '');
        }
      });
    } catch { /* a malformed subscription — skip it, never throw into the caller */ }
  }
}

/**
 * Send a test push to one person's own devices and REPORT the result — used by
 * the "Send test" button so a staff member (and the owner) can see whether push
 * actually lands, and the real reason if it does not. Unlike sendPush this
 * awaits each send and surfaces the error instead of swallowing it.
 */
async function sendTest(employeeId) {
  let subs = [];
  try { subs = q.pushFor.all({ id: employeeId }); } catch { /* */ }
  // Counted before the early return, so "devices" is what is actually
  // registered rather than a zero that only means nobody looked. When push is
  // off on the server that number is the difference between "your phone never
  // registered" and "your phone is fine, the server is not set up".
  if (!pushOn) return { enabled: false, devices: subs.length, sent: 0, failed: 0, errors: [] };
  const data = JSON.stringify({
    title: 'Test notification',
    body: 'If you can see this, notifications are working.',
    url: '/portal', tag: 'zwin-test',
  });
  let sent = 0, failed = 0;
  const errors = [];
  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.sub); } catch { failed++; errors.push('bad subscription'); continue; }
    try {
      await webpush.sendNotification(sub, data);
      sent++;
    } catch (err) {
      failed++;
      const code = err && err.statusCode;
      errors.push(code ? `HTTP ${code}${err.body ? ': ' + String(err.body).slice(0, 120) : ''}`
        : (err && err.message ? String(err.message).slice(0, 120) : 'send failed'));
      if (code === 404 || code === 410) { try { q.delPush.run(row.endpoint); } catch { /* */ } }
    }
  }
  return { enabled: true, devices: subs.length, sent, failed, errors };
}

// --- admin push --------------------------------------------------------------
// The back-office half of the same push engine above. It reuses the one VAPID
// setup and webpush client — there is only ever one key pair — but reads and
// writes admin_push, never portal_push, so turning admin notifications on or off
// can never disturb a staff member's subscription.

/**
 * Record a back-office event and push it to every admin device. Mirrors
 * notify() for staff, but an admin event goes to the whole office — there is no
 * per-person addressing here — and it touches only the admin tables. Never
 * throws: a notification failing must not fail the action that raised it.
 */
function adminNotify(kind, title, { body = null, href = null } = {}) {
  try { q.adminAdd.run({ kind, title, body, href }); }
  catch { /* best effort — the action that raised it still stands */ }
  try { sendAdminPush({ title, body: body || '', url: href || '/notifications' }); }
  catch { /* push is best effort; the event is already recorded */ }
}

/**
 * Fire an admin notification at most once for a given situation. The key is a
 * stable string the caller controls (e.g. `inv:42:overdue`); the first call
 * with that key sends, every later call is a no-op. This is what lets the daily
 * sweep re-check the same state every morning without re-announcing it. Never
 * throws.
 */
function adminNotifyOnce(key, kind, title, opts = {}) {
  try { if (q.adminFiredHas.get(key)) return false; } catch { /* fall through and still try to notify */ }
  try { q.adminFiredAdd.run(key); } catch { /* best effort — worst case it repeats */ }
  adminNotify(kind, title, opts);
  return true;
}

/**
 * Tell one person something, at most once for a given situation.
 *
 * The staff twin of adminNotifyOnce. A reminder that fires every time a sweep
 * runs is not a reminder, it is a reason to turn notifications off — and the
 * sweep re-checks the same state every day by design. The key is the caller's
 * (e.g. `ts_remind:14:2026-07-19`). Never throws.
 */
/**
 * When a given notification was sent, or null. Lets a caller space a follow-up
 * off the first message rather than off the situation that caused it — which
 * is the difference between "two days later" and "the next time the sweep runs
 * after a late deploy".
 */
function notifiedAt(key) {
  try { return (q.staffFiredAt.get(key) || {}).created_at || null; } catch { return null; }
}

function notifyOnce(key, kind, title, opts = {}) {
  try { if (q.staffFiredHas.get(key)) return false; } catch { /* fall through and still try */ }
  try { q.staffFiredAdd.run(key); } catch { /* best effort — worst case it repeats */ }
  notify(kind, title, opts);
  return true;
}

/** Store (or refresh) a device's push subscription for an admin account. */
function saveAdminPush(uid, subscription) {
  try {
    const endpoint = subscription && subscription.endpoint;
    if (!endpoint || uid == null) return false;
    q.adminSavePush.run({ uid: String(uid), endpoint, sub: JSON.stringify(subscription) });
    return true;
  } catch { return false; }
}

/** Push a payload to every admin device that opted in. Best effort: a device
 *  that has gone away (404/410) is dropped so the list never fills with dead
 *  endpoints. */
function sendAdminPush(payload) {
  if (!pushOn) return;
  let subs;
  try { subs = q.adminPushAll.all(); } catch { return; }
  if (!subs.length) return;
  const data = JSON.stringify(payload);
  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.sub); } catch { continue; }
    try {
      webpush.sendNotification(sub, data).catch((err) => {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          try { q.adminDelPush.run(row.endpoint); } catch { /* cleaned next time */ }
        } else {
          console.error('[push] admin send failed', code || '', err && err.body ? String(err.body).slice(0, 200) : (err && err.message) || '');
        }
      });
    } catch { /* a malformed subscription — skip it, never throw into the caller */ }
  }
}

/** Send a test push to one admin's own devices and report the result — the
 *  admin twin of sendTest(). */
async function sendAdminTest(uid) {
  let subs = [];
  try { subs = q.adminPushFor.all({ uid: String(uid) }); } catch { /* */ }
  if (!pushOn) return { enabled: false, devices: subs.length, sent: 0, failed: 0, errors: [] };
  const data = JSON.stringify({
    title: 'Test notification',
    body: 'If you can see this, admin notifications are working.',
    url: '/notifications', tag: 'zwin-admin-test',
  });
  let sent = 0, failed = 0;
  const errors = [];
  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.sub); } catch { failed++; errors.push('bad subscription'); continue; }
    try {
      await webpush.sendNotification(sub, data);
      sent++;
    } catch (err) {
      failed++;
      const code = err && err.statusCode;
      errors.push(code ? `HTTP ${code}${err.body ? ': ' + String(err.body).slice(0, 120) : ''}`
        : (err && err.message ? String(err.message).slice(0, 120) : 'send failed'));
      if (code === 404 || code === 410) { try { q.adminDelPush.run(row.endpoint); } catch { /* */ } }
    }
  }
  return { enabled: true, devices: subs.length, sent, failed, errors };
}

/** The three tones a note can carry, worst first — the order they render in. */
const TONES = ['urgent', 'caution', 'fyi'];
/** How a reporter can describe a shortage, most urgent first. */
const STOCK_STATUS = ['out', 'low', 'order'];
/** How a manager can close one out. */
const STOCK_RESOLUTION = ['ordered', 'restocked', 'dismissed'];

/**
 * What this person's portal should offer them.
 *
 * One place, so the home screen and the routes behind it can never disagree
 * about whether somebody is asked for tips — a screen that hides the button
 * while the route still accepts the post is not a permission, it is a
 * decoration.
 */
function shapeFor(position) {
  const takesTips = position ? position.takes_tips !== 0 : true;
  return {
    // Anyone who collects tips hands them in; a cook typically does not.
    //
    // Whether they are also asked for sales is deliberately not here. The hub
    // says the same thing to everyone — "Submit sales or tips" — and the form
    // behind it decides by the role the person is filing under, which for
    // somebody who works two jobs is a choice they make on the screen and can
    // change. A per-position answer kept here could only ever be the other
    // one, and two answers to one question is how they drift apart.
    tips: takesTips,
    // Everything else is for everyone. Hours and pay especially: a person who
    // submits nothing still works, and is still owed a way to see it.
    earnings: true,
    specials: true,
    stock: true,
  };
}

module.exports = {
  q, TONES, STOCK_STATUS, STOCK_RESOLUTION, shapeFor, notify,
  savePush, sendPush, sendTest, VAPID_PUBLIC, pushEnabled: pushOn,
  notifyOnce, notifiedAt,
  adminNotify, adminNotifyOnce, saveAdminPush, sendAdminPush, sendAdminTest,
};
