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
  delNote: db.prepare('DELETE FROM portal_notes WHERE id = ?'),

  // --- specials ------------------------------------------------------------
  specialsFor: db.prepare('SELECT * FROM portal_specials WHERE service_date = ? ORDER BY sort, id'),
  specialsRecent: db.prepare(`SELECT * FROM portal_specials
    WHERE service_date >= ? ORDER BY service_date DESC, sort, id`),
  addSpecial: db.prepare(`INSERT INTO portal_specials (service_date, name, price_cents, description, low_note, sort)
    VALUES (@service_date, @name, @price_cents, @description, @low_note, @sort)`),
  eightySix: db.prepare(`UPDATE portal_specials
    SET eighty_sixed_at = datetime('now'), sold_out_note = @note WHERE id = @id`),
  unEightySix: db.prepare("UPDATE portal_specials SET eighty_sixed_at = NULL, sold_out_note = NULL WHERE id = ?"),
  delSpecial: db.prepare('DELETE FROM portal_specials WHERE id = ?'),
  // The board's "UPDATED 2:15 PM" — the latest thing that happened to it today.
  boardTouched: db.prepare(`SELECT MAX(COALESCE(eighty_sixed_at, created_at)) AS at
    FROM portal_specials WHERE service_date = ?`),

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
};

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

module.exports = { q, TONES, STOCK_STATUS, STOCK_RESOLUTION, shapeFor };
