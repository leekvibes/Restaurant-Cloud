'use strict';

// ===========================================================================
// The scheduler — planned work, and nothing else.
// ===========================================================================
//
// A scheduled shift is a PLAN. Esther is meant to work Friday 4–10. Whether
// she does, when she actually arrives, and what she is paid for it are three
// separate questions answered by the time clock, `work`, and Payroll — none of
// which this module writes to, ever.
//
// The hard rule, restated because it is the whole reason this file is separate
// from timeclock.js: nothing in here creates a punch, a `work` row, worked
// hours, a wage or a Payroll entry. Deleting a scheduled shift removes a plan
// and touches no record of anything that happened. Those are assertions in
// test/scheduler.test.js, not merely a promise in a comment.
//
// TWO OBJECTS ARE CALLED "SHIFT" IN THIS CODEBASE
//
//   shifts             a SERVICE the restaurant runs. One row per
//                      (date, daypart), UNIQUE on that pair, restaurant-wide.
//                      The tip engine pools against it; `policy_id` versions
//                      it; `server_sales` hangs off it.
//   scheduled_shifts   one employee, arbitrary times, many per day.
//
// They cannot share a table — the UNIQUE constraint stops you at the second
// server — and they must not share a word in conversation either, which is why
// the owner-facing page for the first is called Services.

const { db } = require('./db');
const { isoDate, addDays } = require('./dates');
const TC = require('./timeclock');

// ---------------------------------------------------------------------------
// Schema. This module owns it, the way timeclock.js owns its own, so the file
// can be required by a test or a script without server.js having run first.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_shifts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL is an OPEN shift: nobody assigned yet. Deliberately the same row an
    -- assigned shift lives in, so a future claim is an UPDATE rather than a
    -- migration between tables.
    employee_id    INTEGER REFERENCES employees(id) ON DELETE CASCADE,
    position       TEXT NOT NULL,          -- slug, checked against held positions
    business_date  TEXT NOT NULL,          -- via TC.businessDateOf(); the query key
    starts_at      TEXT NOT NULL,          -- UTC 'YYYY-MM-DD HH:MM:SS'
    ends_at        TEXT NOT NULL,          -- UTC; may be on the next calendar day
    -- Stamped once, at creation, and never re-derived. Moving the service
    -- boundary later must not silently rewrite shifts somebody already read —
    -- the same discipline as shifts.policy_id locking a tip-out version.
    daypart        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'draft',   -- draft | published | cancelled
    -- A MANAGER HINT and nothing more. It says "there are edits the floor has
    -- not seen"; it is never consulted for what an employee is shown, because
    -- that comes from published_schedule.
    changed_after_publish INTEGER NOT NULL DEFAULT 0,
    note           TEXT,                   -- employee-visible
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_by     TEXT,
    updated_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sched_date ON scheduled_shifts (business_date);
  CREATE INDEX IF NOT EXISTS idx_sched_emp  ON scheduled_shifts (employee_id, business_date);
  CREATE INDEX IF NOT EXISTS idx_sched_open ON scheduled_shifts (status, business_date);

  -- What employees see. Written by publish() and by nothing else.
  --
  -- This is a separate table rather than a status flag because a status flag
  -- cannot hold two truths at once. Publish Esther 4–10, then edit the row to
  -- 5–11 without republishing, and a single-row model has overwritten the only
  -- copy of the published times: Esther opens her phone and sees 5–11, a
  -- schedule nobody ever released. A 'changed_after_publish' flag records THAT
  -- something changed and never what it was.
  --
  -- With the published copy in its own table, the employee query reads here and
  -- cannot see a draft — not because the query is careful, but because drafts
  -- are not in the table.
  CREATE TABLE IF NOT EXISTS published_schedule (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduled_shift_id INTEGER NOT NULL
                       REFERENCES scheduled_shifts(id) ON DELETE CASCADE,
    employee_id        INTEGER NOT NULL,
    position           TEXT NOT NULL,
    business_date      TEXT NOT NULL,
    starts_at          TEXT NOT NULL,
    ends_at            TEXT NOT NULL,
    daypart            TEXT NOT NULL,
    note               TEXT,
    breaks_json        TEXT,               -- frozen copy of the planned breaks
    published_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scheduled_shift_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pub_emp ON published_schedule (employee_id, business_date);

  -- Planned breaks live here and NOT in time_breaks, and that is structural
  -- rather than stylistic: time_breaks.time_entry_id is NOT NULL, so a break
  -- with no punch behind it is refused by the schema before any of the twelve
  -- triggers on that table gets a chance to run.
  --
  -- 'minutes' is required, 'planned_start_at' is not. A manager usually knows
  -- somebody gets half an hour and does not know when — service decides that.
  -- Recording a time nobody will keep is worse than recording none. Day view
  -- draws a real gap when the time is known and annotates the bar when it is
  -- not.
  CREATE TABLE IF NOT EXISTS scheduled_breaks (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduled_shift_id INTEGER NOT NULL
                       REFERENCES scheduled_shifts(id) ON DELETE CASCADE,
    minutes            INTEGER NOT NULL,
    planned_start_at   TEXT,               -- NULL = "somewhere in the shift"
    paid               INTEGER NOT NULL DEFAULT 0,
    note               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sbreak_shift ON scheduled_breaks (scheduled_shift_id);
`);

const STATUSES = ['draft', 'published', 'cancelled'];

/** Refusals a caller is meant to show, distinct from a genuine crash. */
class ScheduleError extends Error {
  constructor(message, code) { super(message); this.name = 'ScheduleError'; this.code = code || 'invalid'; }
}

// ---------------------------------------------------------------------------
// Which service is this?
// ---------------------------------------------------------------------------

/**
 * The service a shift starting at this instant belongs to.
 *
 * A thin wrapper, deliberately. `TC.suggestDaypart` already implements exactly
 * these semantics — one configurable boundary (`tc_dinner_from`, default 16:00)
 * with everything at or after it counting as dinner — and the clock has been
 * using it to pre-fill its own form for months.
 *
 * Writing a second implementation here, even an identical one, would be two
 * definitions of "which service is this" that agree until somebody edits one.
 * A single boundary also cannot leave a gap or an overlap the way two
 * independent windows could: every minute of the day resolves, and to exactly
 * one service.
 *
 * The result is STAMPED at creation. This function is never used to re-derive
 * an existing shift.
 */
function serviceFor(utc) {
  return TC.suggestDaypart(utc, TC.settings().dinnerFrom);
}

/** The business date this instant falls in, by the clock's own cutoff. */
function businessDateFor(utc) {
  return TC.businessDateOf(utc, TC.settings().cutoffHour);
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------
const q = {
  byId: db.prepare('SELECT * FROM scheduled_shifts WHERE id = ?'),
  insert: db.prepare(`INSERT INTO scheduled_shifts
    (employee_id, position, business_date, starts_at, ends_at, daypart,
     status, note, created_by)
    VALUES (@employee_id, @position, @business_date, @starts_at, @ends_at, @daypart,
            @status, @note, @created_by)`),
  update: db.prepare(`UPDATE scheduled_shifts SET
      employee_id = @employee_id, position = @position, business_date = @business_date,
      starts_at = @starts_at, ends_at = @ends_at, daypart = @daypart,
      note = @note, changed_after_publish = @changed_after_publish,
      updated_at = datetime('now')
    WHERE id = @id`),
  setStatus: db.prepare(`UPDATE scheduled_shifts
    SET status = @status, updated_at = datetime('now') WHERE id = @id`),
  clearChanged: db.prepare(`UPDATE scheduled_shifts
    SET changed_after_publish = 0, updated_at = datetime('now') WHERE id = @id`),

  // The manager board. Drafts and published alike; cancelled rows are history.
  inRange: db.prepare(`SELECT s.*, e.name AS employee_name, e.active AS employee_active
    FROM scheduled_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business_date BETWEEN ? AND ? AND s.status <> 'cancelled'
    ORDER BY s.business_date, s.starts_at, s.id`),

  // Overlap check, for the validation engine and for copy-week.
  overlapping: db.prepare(`SELECT * FROM scheduled_shifts
    WHERE employee_id = @employee_id AND status <> 'cancelled' AND id <> @id
      AND starts_at < @ends_at AND ends_at > @starts_at`),

  breaksFor: db.prepare('SELECT * FROM scheduled_breaks WHERE scheduled_shift_id = ? ORDER BY id'),
  addBreak: db.prepare(`INSERT INTO scheduled_breaks
    (scheduled_shift_id, minutes, planned_start_at, paid, note)
    VALUES (@scheduled_shift_id, @minutes, @planned_start_at, @paid, @note)`),
  clearBreaks: db.prepare('DELETE FROM scheduled_breaks WHERE scheduled_shift_id = ?'),

  // --- published ---------------------------------------------------------
  pubUpsert: db.prepare(`INSERT INTO published_schedule
    (scheduled_shift_id, employee_id, position, business_date, starts_at, ends_at,
     daypart, note, breaks_json, published_at)
    VALUES (@scheduled_shift_id, @employee_id, @position, @business_date, @starts_at,
            @ends_at, @daypart, @note, @breaks_json, datetime('now'))
    ON CONFLICT(scheduled_shift_id) DO UPDATE SET
      employee_id = excluded.employee_id, position = excluded.position,
      business_date = excluded.business_date, starts_at = excluded.starts_at,
      ends_at = excluded.ends_at, daypart = excluded.daypart, note = excluded.note,
      breaks_json = excluded.breaks_json, published_at = excluded.published_at`),
  pubDelete: db.prepare('DELETE FROM published_schedule WHERE scheduled_shift_id = ?'),
  pubForEmployee: db.prepare(`SELECT * FROM published_schedule
    WHERE employee_id = @emp AND business_date BETWEEN @from AND @to
    ORDER BY starts_at`),
  pubById: db.prepare('SELECT * FROM published_schedule WHERE scheduled_shift_id = ?'),
};

const emp = {
  byId: db.prepare('SELECT * FROM employees WHERE id = ?'),
  heldRoles: db.prepare('SELECT role FROM employee_roles WHERE employee_id = ?'),
};

/**
 * The jobs this person may be scheduled for.
 *
 * The same strict answer the tips workflow uses: the employee row's own
 * position plus anything in employee_roles, and nothing else. `rolesForEmployee`
 * elsewhere falls back to EVERY role when somebody has none recorded, which is
 * a reasonable default for "what might they pick" and a terrible one for "what
 * are they allowed to do".
 */
function heldPositions(employeeId) {
  const e = emp.byId.get(employeeId);
  if (!e) return [];
  const extra = emp.heldRoles.all(employeeId).map((r) => r.role);
  return [...new Set([e.role, ...extra])].filter((r) => r && r !== 'manager');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Accepts 'YYYY-MM-DD HH:MM' or 'YYYY-MM-DDTHH:MM' local, returns UTC. */
function toUtc(local) {
  const utc = TC.localInputToUtc(local);
  if (!utc) throw new ScheduleError('Enter a date and time.', 'time');
  return utc;
}

function validate({ employeeId, position, startsAt, endsAt }) {
  if (!position) throw new ScheduleError('Choose the position for this shift.', 'position');

  // An open shift has no employee yet, and that is legal — it is how a shift
  // waits to be claimed. What is not legal is naming somebody who cannot work.
  if (employeeId != null) {
    const e = emp.byId.get(employeeId);
    if (!e) throw new ScheduleError('That employee no longer exists.', 'employee');
    // A create-time guard rather than an issue raised later: an inactive
    // employee's shifts are hidden from the board, so a warning about one would
    // point at something nobody can see.
    if (!e.active) {
      throw new ScheduleError('That employee is not active. Reactivate them first.', 'inactive');
    }
    if (!heldPositions(employeeId).includes(position)) {
      throw new ScheduleError('They are not assigned to that position.', 'qualification');
    }
  }

  if (!(startsAt < endsAt)) {
    throw new ScheduleError('The shift has to end after it starts.', 'time');
  }
  // A whole day is already implausible for one shift; anything past it is a
  // typo in the date, which would otherwise sit on the board for a week.
  const hours = (Date.parse(`${endsAt.replace(' ', 'T')}Z`)
    - Date.parse(`${startsAt.replace(' ', 'T')}Z`)) / 3600000;
  if (hours > 24) throw new ScheduleError('That shift is longer than a day — check the dates.', 'time');
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Create one planned assignment.
 *
 * Always ONE employee, even when a manager is filling a whole service — five
 * people is five rows. Each can then be edited, published, claimed, swapped and
 * validated on its own, which is what every later phase needs.
 *
 * Creates a draft. Publishing is a separate, deliberate act.
 */
function create(input) {
  const startsAt = toUtc(input.startsAt);
  const endsAt = toUtc(input.endsAt);
  const employeeId = input.employeeId == null || input.employeeId === '' ? null : Number(input.employeeId);
  const position = String(input.position || '').trim();
  validate({ employeeId, position, startsAt, endsAt });

  // Both stamped from the START of the shift. A shift running to 2am belongs to
  // the night it began on, in both senses — the same rule the clock uses, so a
  // punch against it lands on the same business date.
  const daypart = DAYPARTS.includes(input.daypart) ? input.daypart : serviceFor(startsAt);
  const businessDate = businessDateFor(startsAt);

  let id = null;
  db.transaction(() => {
    const info = q.insert.run({
      employee_id: employeeId, position, business_date: businessDate,
      starts_at: startsAt, ends_at: endsAt, daypart,
      status: 'draft', note: String(input.note || '').trim() || null,
      created_by: input.createdBy || null,
    });
    id = Number(info.lastInsertRowid);
    writeBreaks(id, input.breaks);
  })();
  return byId(id);
}

/**
 * Edit a planned assignment.
 *
 * A material change to something already published sets the manager's hint
 * flag. It does NOT touch published_schedule — the floor keeps reading what it
 * was given until somebody publishes again, which is the whole point of the
 * two tables.
 */
function edit(id, patch) {
  const row = q.byId.get(id);
  if (!row) throw new ScheduleError('That shift is no longer there.', 'missing');
  if (row.status === 'cancelled') throw new ScheduleError('That shift was cancelled.', 'cancelled');

  const startsAt = patch.startsAt !== undefined ? toUtc(patch.startsAt) : row.starts_at;
  const endsAt = patch.endsAt !== undefined ? toUtc(patch.endsAt) : row.ends_at;
  const employeeId = patch.employeeId !== undefined
    ? (patch.employeeId === '' || patch.employeeId == null ? null : Number(patch.employeeId))
    : row.employee_id;
  const position = patch.position !== undefined ? String(patch.position).trim() : row.position;
  validate({ employeeId, position, startsAt, endsAt });

  // Re-stamped only when the START actually moves. An edit to the note or the
  // end time leaves the service alone, and a service-window change elsewhere
  // never reaches an existing shift at all.
  const daypart = patch.daypart !== undefined && DAYPARTS.includes(patch.daypart) ? patch.daypart
    : (startsAt !== row.starts_at ? serviceFor(startsAt) : row.daypart);
  const businessDate = startsAt !== row.starts_at ? businessDateFor(startsAt) : row.business_date;
  const note = patch.note !== undefined ? (String(patch.note || '').trim() || null) : row.note;

  const material = employeeId !== row.employee_id
    || position !== row.position
    || startsAt !== row.starts_at
    || endsAt !== row.ends_at
    || daypart !== row.daypart
    || patch.breaks !== undefined;

  db.transaction(() => {
    q.update.run({
      id, employee_id: employeeId, position, business_date: businessDate,
      starts_at: startsAt, ends_at: endsAt, daypart, note,
      changed_after_publish: row.status === 'published' && material ? 1 : row.changed_after_publish,
    });
    if (patch.breaks !== undefined) writeBreaks(id, patch.breaks);
  })();
  return byId(id);
}

/**
 * Cancel a planned assignment.
 *
 * The row stays — a cancelled plan is still a record of what was planned — but
 * it leaves the board and, once the cancellation is published, the employee's
 * schedule. Until then the floor still sees what it was told, which is right:
 * a cancellation nobody has been informed of has not happened yet.
 *
 * Touches no punch, no `work` row and no service. Deleting a plan is not an
 * edit to anything that occurred.
 */
function cancel(id) {
  const row = q.byId.get(id);
  if (!row) throw new ScheduleError('That shift is no longer there.', 'missing');
  db.transaction(() => {
    q.setStatus.run({ id, status: 'cancelled' });
    if (row.status === 'published') {
      // Published, so the floor has to be told. Flagged, not silently removed.
      db.prepare('UPDATE scheduled_shifts SET changed_after_publish = 1 WHERE id = ?').run(id);
    }
  })();
  return byId(id);
}

/**
 * Publish. THE ONLY WRITER of published_schedule.
 *
 * One function, so there is one place where the employee-visible truth can
 * change and one place to test. A cancelled shift publishes as a removal.
 */
function publish(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  const done = [];
  db.transaction(() => {
    for (const id of list) {
      const row = q.byId.get(id);
      if (!row) continue;
      if (row.status === 'cancelled') {
        q.pubDelete.run(id);
        q.clearChanged.run({ id });
        done.push({ id, action: 'removed' });
        continue;
      }
      // An open shift has nobody to publish TO. It becomes visible to
      // employees when Phase 8 gives it a claim surface, not before.
      if (row.employee_id == null) { done.push({ id, action: 'skipped-open' }); continue; }
      q.pubUpsert.run({
        scheduled_shift_id: id, employee_id: row.employee_id, position: row.position,
        business_date: row.business_date, starts_at: row.starts_at, ends_at: row.ends_at,
        daypart: row.daypart, note: row.note,
        breaks_json: JSON.stringify(q.breaksFor.all(id).map((b) => ({
          minutes: b.minutes, plannedStartAt: b.planned_start_at, paid: !!b.paid, note: b.note,
        }))),
      });
      q.setStatus.run({ id, status: 'published' });
      q.clearChanged.run({ id });
      done.push({ id, action: 'published' });
    }
  })();
  return done;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** One shift with its planned breaks. */
function byId(id) {
  const row = q.byId.get(id);
  if (!row) return null;
  return { ...row, breaks: q.breaksFor.all(id) };
}

/** The manager board: everything not cancelled, in a date range. */
function inRange(from, to) {
  return q.inRange.all(from, to).map((r) => ({ ...r, breaks: q.breaksFor.all(r.id) }));
}

/** A Monday-anchored week. */
function weekFor(anyDate) {
  const d = new Date(`${anyDate}T00:00:00`);
  const back = (d.getDay() + 6) % 7;                    // Monday = 0
  const start = addDays(anyDate, -back);
  return { start, end: addDays(start, 6), shifts: inRange(start, addDays(start, 6)) };
}

/** How far back and forward an employee's own schedule reaches. */
const WINDOW_BACK = 7;
const WINDOW_FORWARD = 90;

/**
 * What an employee sees. Reads published_schedule and nothing else.
 *
 * A rolling tail rather than "the current week": a calendar boundary erases
 * Sunday night every Monday morning, which is exactly the shift somebody wants
 * to check when they are wondering whether they were paid for it.
 */
function publishedFor(employeeId, opts = {}) {
  const today = businessDateFor(TC.nowUtc());
  const from = opts.from || addDays(today, -WINDOW_BACK);
  const to = opts.to || addDays(today, WINDOW_FORWARD);
  return q.pubForEmployee.all({ emp: employeeId, from, to }).map((r) => ({
    ...r,
    breaks: r.breaks_json ? JSON.parse(r.breaks_json) : [],
  }));
}

/** Does this shift clash with another of the same person's? */
function overlapsFor(shift) {
  if (shift.employee_id == null) return [];
  return q.overlapping.all({
    employee_id: shift.employee_id, id: shift.id || 0,
    starts_at: shift.starts_at, ends_at: shift.ends_at,
  });
}

/**
 * Copy a week's plan onto another week.
 *
 * Restaurants repeat: this Tuesday looks like last Tuesday, and hand-placing
 * forty shifts to say so is the fastest way to make a scheduler unused.
 *
 * Always drafts. Skips anybody who has since gone inactive, and skips a shift
 * that would duplicate one already in the target week — running it twice must
 * not double the schedule.
 */
function copyWeek(fromStart, toStart, opts = {}) {
  const offset = Math.round(
    (Date.parse(`${toStart}T00:00:00Z`) - Date.parse(`${fromStart}T00:00:00Z`)) / 86400000,
  );
  if (!Number.isFinite(offset) || offset === 0) {
    throw new ScheduleError('Choose a different week to copy into.', 'range');
  }
  const source = inRange(fromStart, addDays(fromStart, 6));
  const existing = inRange(toStart, addDays(toStart, 6));
  const seen = new Set(existing.map((s) => `${s.employee_id}|${s.starts_at}|${s.position}`));

  const made = []; const skipped = [];
  db.transaction(() => {
    for (const s of source) {
      if (s.employee_id != null && !s.employee_active) { skipped.push({ id: s.id, why: 'inactive' }); continue; }
      const starts = shiftUtcByDays(s.starts_at, offset);
      const ends = shiftUtcByDays(s.ends_at, offset);
      if (seen.has(`${s.employee_id}|${starts}|${s.position}`)) {
        skipped.push({ id: s.id, why: 'already there' }); continue;
      }
      const info = q.insert.run({
        employee_id: s.employee_id, position: s.position,
        business_date: businessDateFor(starts),
        starts_at: starts, ends_at: ends,
        // Re-derived on purpose: a copy is a NEW plan, so it takes the service
        // rules as they stand today rather than inheriting a months-old stamp.
        daypart: serviceFor(starts),
        status: 'draft', note: s.note, created_by: opts.createdBy || null,
      });
      const id = Number(info.lastInsertRowid);
      for (const b of s.breaks) {
        q.addBreak.run({
          scheduled_shift_id: id, minutes: b.minutes,
          planned_start_at: b.planned_start_at ? shiftUtcByDays(b.planned_start_at, offset) : null,
          paid: b.paid, note: b.note,
        });
      }
      seen.add(`${s.employee_id}|${starts}|${s.position}`);
      made.push(id);
    }
  })();
  return { made, skipped };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAYPARTS = ['cafe', 'dinner'];

/** Move a UTC stamp by whole days, keeping the clock time. */
function shiftUtcByDays(utc, days) {
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function writeBreaks(shiftId, breaks) {
  q.clearBreaks.run(shiftId);
  for (const b of breaks || []) {
    const minutes = Math.round(Number(b.minutes));
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    q.addBreak.run({
      scheduled_shift_id: shiftId, minutes,
      planned_start_at: b.plannedStartAt ? toUtc(b.plannedStartAt) : null,
      paid: b.paid ? 1 : 0, note: String(b.note || '').trim() || null,
    });
  }
}

module.exports = {
  create, edit, cancel, publish,
  byId, inRange, weekFor, publishedFor, overlapsFor, copyWeek,
  serviceFor, businessDateFor, heldPositions,
  q, DAYPARTS, STATUSES, ScheduleError,
  WINDOW_BACK, WINDOW_FORWARD,
};
