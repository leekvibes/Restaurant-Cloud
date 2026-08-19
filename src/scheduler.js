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

const { db, positions } = require('./db');
const { isoDate, addDays } = require('./dates');
const TC = require('./timeclock');
// Read only, and only periodFor(). The pay period owns the definition of a
// workweek; the scheduler borrows it rather than keeping a second one.
const P = require('./periods');

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

// ---------------------------------------------------------------------------
// Phase 6 — availability and time off.
//
// TWO TABLES, DELIBERATELY, and the reason is lifecycle rather than storage:
// availability is STATED by an employee and takes effect on save; time off is
// REQUESTED and a manager decides it. Merging them because both end in "cannot
// work" would put an approval workflow on a preference.
//
// THE INVARIANT THAT MATTERS MOST: no rows means AVAILABLE. Every employee has
// zero rows the moment these tables ship, and any other reading would mark the
// whole roster unavailable on deploy and light the board with issues for a
// schedule that was correct yesterday. This is also why "available" is never
// stored — a stored "available all day Monday" makes the default ambiguous the
// first time somebody deletes it. Asserted in test/schedule-availability.test.js.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS availability_rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- NOT a bare 'unavailable' column. Three things in this codebase already
    -- answer to that word and none of them is this one: PORTAL_NAV.availability
    -- is a nav tab state, "Earnings unavailable" is a pay state, and
    -- kind:'unavailable' in the pay feed means a shift the tip engine could not
    -- cost. The column name carries the domain so a grep lands in the right one.
    avail_kind     TEXT NOT NULL,          -- 'unavailable' | 'prefer'
    -- ONE TABLE SERVES BOTH SHAPES: weekday set = recurring, on_date set =
    -- one-off. Exactly one, enforced below. Precedence then falls out of
    -- specificity rather than needing a rules engine.
    weekday        INTEGER,                -- 0=Sunday..6, NULL for a one-off
    on_date        TEXT,                   -- 'YYYY-MM-DD', NULL for a recurring rule
    all_day        INTEGER NOT NULL DEFAULT 0,
    -- Local wall clock, minutes from midnight. NOT UTC: "I can't work Tuesday
    -- evenings" is a statement about the clock on the wall, and storing it as an
    -- instant would make it drift an hour twice a year.
    start_min      INTEGER,
    -- END_MIN <= START_MIN MEANS IT ENDS THE NEXT DAY. Friday 22:00-02:00 is one
    -- rule, not two, and it belongs to the weekday its START falls on. This is
    -- the same discipline scheduled_shifts already uses ("ends_at ... may be on
    -- the next calendar day"), and it is why every comparison resolves to
    -- instants before overlapping rather than comparing day labels.
    end_min        INTEGER,
    -- Both nullable = indefinite in that direction. Both INCLUSIVE.
    -- Without these, somebody changing their regular Tuesday retroactively
    -- rewrites whether last month's schedule was ever valid. Editing a rule
    -- closes the old row with effective_until and inserts a new one; it never
    -- updates in place. Same reason policy_versions supersedes instead of
    -- editing, and the same reason a deactivated employee gets effective_until
    -- set rather than their rules deleted.
    effective_from  TEXT,
    effective_until TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (avail_kind IN ('unavailable', 'prefer')),
    -- Exactly one of weekday / on_date. A row with both is a rule nobody can
    -- reason about, and a row with neither applies to nothing.
    CHECK ((weekday IS NULL) <> (on_date IS NULL)),
    CHECK (weekday IS NULL OR (weekday BETWEEN 0 AND 6)),
    -- A timed rule must actually carry its times. An all-day rule need not.
    CHECK (all_day = 1 OR (start_min IS NOT NULL AND end_min IS NOT NULL)),
    CHECK (start_min IS NULL OR (start_min BETWEEN 0 AND 1439)),
    CHECK (end_min   IS NULL OR (end_min   BETWEEN 0 AND 1440))
  );
  CREATE INDEX IF NOT EXISTS idx_avail_emp_wd   ON availability_rules (employee_id, weekday);
  CREATE INDEX IF NOT EXISTS idx_avail_emp_date ON availability_rules (employee_id, on_date);

  -- Modelled on time_corrections, which is the strongest request-lifecycle
  -- precedent in the codebase: actor and timestamp on BOTH sides, the manager's
  -- note kept separate from the employee's reason, and a decision guarded
  -- against being made twice.
  --
  -- What is deliberately NOT copied is 'applied_at'. For a time correction,
  -- "applied" means a punch was rewritten, so the decision and its effect are
  -- two writes. For time off, APPROVAL IS THE EFFECT — the issues engine reads
  -- the status directly and there is no second write to record.
  CREATE TABLE IF NOT EXISTS time_off_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- UTC instants, like scheduled_shifts. A multi-day absence is ONE row, not
    -- one per day: daily rows would make approving and withdrawing a loop, and
    -- a partial day is the same row with a narrower window.
    starts_at      TEXT NOT NULL,
    ends_at        TEXT NOT NULL,
    -- A display and comparison convenience, not a different entity. A full day
    -- is a range too.
    all_day        INTEGER NOT NULL DEFAULT 0,
    reason         TEXT,                   -- optional, the employee's own words
    status         TEXT NOT NULL DEFAULT 'pending',
    requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by     TEXT,
    decided_at     TEXT,
    decision_note  TEXT,                   -- the manager's, and the employee sees it
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    CHECK (ends_at > starts_at)
  );
  CREATE INDEX IF NOT EXISTS idx_timeoff_emp    ON time_off_requests (employee_id, starts_at);
  CREATE INDEX IF NOT EXISTS idx_timeoff_status ON time_off_requests (status);
  -- Idempotency at the schema, not at a disabled button. A double-tapped submit
  -- or a retried POST lands the identical row twice otherwise, and the office
  -- gets two notifications for one absence. Scoped to pending so that a request
  -- rejected once can legitimately be asked for again.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_timeoff_no_dupe
    ON time_off_requests (employee_id, starts_at, ends_at)
    WHERE status = 'pending';
`);

db.exec(`
  -- PHASE 7 — a saved shape for a shift, not a saved shift.
  --
  -- It holds a POSITION and a TIME OF DAY and nothing else: no employee, no
  -- date. "Server Dinner 4-10" is a pattern the restaurant runs, and attaching a
  -- person to it would make it a shift that never happened — with all the
  -- questions that follow about what it means when they leave.
  --
  -- Times are local minutes from midnight, like availability rules and for the
  -- same reason: "dinner starts at four" is a statement about the clock on the
  -- wall, and storing it as an instant would drift an hour twice a year.
  -- end_min <= start_min means it finishes the next day, which is the ordinary
  -- case for a close.
  CREATE TABLE IF NOT EXISTS shift_templates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    position       TEXT NOT NULL,
    start_min      INTEGER NOT NULL,
    end_min        INTEGER NOT NULL,
    break_minutes  INTEGER,
    break_paid     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (start_min BETWEEN 0 AND 1439),
    CHECK (end_min BETWEEN 0 AND 1440)
  );
  -- One name, one shape. Two templates called "Dinner" is a way to pick the
  -- wrong one every time.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tmpl_name ON shift_templates (name COLLATE NOCASE);
`);

/** Every saved shape, in the order somebody would look for them. */
function templates() {
  return db.prepare('SELECT * FROM shift_templates ORDER BY position, start_min, name').all();
}

/**
 * Save a shape. Re-saving a name REPLACES it, because a manager correcting
 * "Dinner starts at 4:30 now" means the one called Dinner, not a second one.
 */
function saveTemplate({ name, position, startMin, endMin, breakMinutes, breakPaid }) {
  const label = String(name || '').trim().slice(0, 60);
  if (!label) throw new ScheduleError('Give the template a name.', 'name');
  if (!position) throw new ScheduleError('Choose the position.', 'position');
  const a = Number(startMin); const b = Number(endMin);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new ScheduleError('Enter a start and an end.', 'time');
  if (a === b) throw new ScheduleError('The start and end are the same.', 'time');
  db.prepare(`INSERT INTO shift_templates (name, position, start_min, end_min, break_minutes, break_paid)
    VALUES (@name, @position, @a, @b, @brk, @paid)
    ON CONFLICT(name COLLATE NOCASE) DO UPDATE SET
      position = excluded.position, start_min = excluded.start_min,
      end_min = excluded.end_min, break_minutes = excluded.break_minutes,
      break_paid = excluded.break_paid`)
    .run({ name: label, position, a, b,
      brk: Number(breakMinutes) > 0 ? Number(breakMinutes) : null, paid: breakPaid ? 1 : 0 });
  return db.prepare('SELECT * FROM shift_templates WHERE name = ? COLLATE NOCASE').get(label);
}

const deleteTemplate = (id) => db.prepare('DELETE FROM shift_templates WHERE id = ?').run(Number(id)).changes > 0;

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
  // ONE statement for any number of shifts. A board week is ~40 shifts; asking
  // per shift is 40 round trips to answer one question. json_each takes the ids
  // as a bound JSON array, so this stays a single prepared statement instead of
  // SQL assembled per call with a different placeholder count each time.
  breaksForMany: db.prepare(`SELECT b.* FROM scheduled_breaks b
    JOIN json_each(?) j ON j.value = b.scheduled_shift_id
    ORDER BY b.scheduled_shift_id, b.id`),
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
  // The reactivation boundary lives in the WHERE clause, not in a filter the
  // caller has to remember. Somebody brought back at 2pm gets tonight's shift
  // and not this morning's — compared on starts_at, because a business date
  // cannot express an instant. NULL threshold (everybody who has never been
  // deactivated) passes everything, so this changes nothing for them.
  pubForEmployee: db.prepare(`SELECT p.* FROM published_schedule p
    JOIN employees e ON e.id = p.employee_id
    WHERE p.employee_id = @emp AND p.business_date BETWEEN @from AND @to
      AND (e.schedule_visible_from_at IS NULL OR p.starts_at >= e.schedule_visible_from_at)
    ORDER BY p.starts_at`),
  pubById: db.prepare('SELECT * FROM published_schedule WHERE scheduled_shift_id = ?'),
  // Reconciliation reads BOTH sides of the week. inRange hides cancelled rows
  // because the board must not draw them; publishing has to see them, because a
  // cancellation is exactly the change that has to reach the floor.
  inRangeAll: db.prepare(`SELECT * FROM scheduled_shifts
    WHERE business_date BETWEEN ? AND ?`),
  // And the published rows sitting in this week, so a shift dragged OUT of it
  // is still reconciled — otherwise the old date would linger for the employee
  // with nothing left in the draft week to notice it.
  pubInRange: db.prepare(`SELECT * FROM published_schedule
    WHERE business_date BETWEEN ? AND ? ORDER BY employee_id, starts_at`),
  pubForWeek: db.prepare(`SELECT p.* FROM published_schedule p
    JOIN employees e ON e.id = p.employee_id
    WHERE p.employee_id = @emp AND p.business_date BETWEEN @from AND @to
      AND (e.schedule_visible_from_at IS NULL OR p.starts_at >= e.schedule_visible_from_at)
    ORDER BY p.starts_at, p.scheduled_shift_id`),
};

const emp = {
  byId: db.prepare('SELECT * FROM employees WHERE id = ?'),
  heldRoles: db.prepare('SELECT role FROM employee_roles WHERE employee_id = ?'),
  manyById: db.prepare(`SELECT e.* FROM employees e
    JOIN json_each(?) j ON j.value = e.id`),
  manyRoles: db.prepare(`SELECT r.employee_id, r.role FROM employee_roles r
    JOIN json_each(?) j ON j.value = r.employee_id`),
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

/**
 * heldPositions for many employees at once.
 *
 * Same rule, same exclusion of 'manager', one pair of queries instead of two
 * per person. The board needs this for every name in the week.
 */
function heldPositionsFor(ids) {
  const list = [...new Set((ids || []).filter((n) => n != null).map(Number))];
  const out = {};
  if (!list.length) return out;
  const json = JSON.stringify(list);
  const extra = {};
  for (const r of emp.manyRoles.all(json)) {
    (extra[r.employee_id] || (extra[r.employee_id] = [])).push(r.role);
  }
  for (const e of emp.manyById.all(json)) {
    out[e.id] = [...new Set([e.role, ...(extra[e.id] || [])])]
      .filter((r) => r && r !== 'manager');
  }
  return out;
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

function validate({ employeeId, position, startsAt, endsAt, keepPosition }) {
  if (!position) throw new ScheduleError('Choose the position for this shift.', 'position');

  // The position has to be one the restaurant still runs.
  //
  // heldPositions answers "does this person do that job" and deliberately never
  // joins positions, so before this check a deactivated position was still
  // schedulable — the qualification rule passed and nothing else looked. New
  // work could be planned into a job that had been retired.
  //
  // keepPosition is the position a shift ALREADY carries. An existing shift
  // whose position was retired underneath it stays editable: a manager must be
  // able to move its times, or fix the person, without being forced to
  // re-assign the job in the same motion. Choosing a different inactive
  // position is still refused, because that is a new assignment. Deactivation
  // preserves what exists and prevents what is new — the same rule the
  // scheduler already applies to inactive employees.
  const known = positions.bySlug.get(position);
  if (!known) throw new ScheduleError('That position no longer exists.', 'position');
  if (!known.active && position !== keepPosition) {
    throw new ScheduleError(`${known.name} is not an active position any more.`, 'position-inactive');
  }

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
  if (minutesBetween(startsAt, endsAt) > 24 * 60) {
    throw new ScheduleError('That shift is longer than a day — check the dates.', 'time');
  }
}

/**
 * D5 — planned breaks are checked, not quietly discarded.
 *
 * A planned start is OPTIONAL and stays that way: a manager usually knows
 * somebody gets half an hour, not when they will take it. The rule is that a
 * break which HAS a start must have a workable one.
 *
 * Until now `writeBreaks` dropped anything with minutes <= 0 without a word, so
 * a mistyped break vanished and the shift silently kept its full paid hours.
 * Refusal is the honest answer.
 *
 * `alreadyUtc` distinguishes form input (local, needs converting) from stamps
 * already in the database (copy, duplicate, re-check after a time change). It
 * is passed explicitly rather than guessed from the string's shape.
 */
function normalizeBreaks(breaks, startsAt, endsAt, alreadyUtc = false) {
  const list = breaks || [];
  if (!list.length) return [];
  const span = minutesBetween(startsAt, endsAt);
  const out = [];
  let total = 0;

  for (const b of list) {
    const minutes = Math.round(Number(b.minutes));
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new ScheduleError('A break needs a length in minutes.', 'break');
    }
    total += minutes;
    if (total > span) {
      throw new ScheduleError(
        list.length > 1
          ? 'Those breaks add up to more than the shift.'
          : 'That break is longer than the shift.',
        'break',
      );
    }

    const raw = b.plannedStartAt !== undefined ? b.plannedStartAt : b.planned_start_at;
    let plannedStartAt = null;
    if (raw) {
      plannedStartAt = alreadyUtc ? String(raw) : toUtc(raw);
      // String comparison is exact on 'YYYY-MM-DD HH:MM:SS' UTC stamps.
      if (plannedStartAt < startsAt) {
        throw new ScheduleError('A break cannot start before the shift does.', 'break');
      }
      if (addMinutesUtc(plannedStartAt, minutes) > endsAt) {
        throw new ScheduleError('A break cannot run past the end of the shift.', 'break');
      }
    }

    out.push({
      minutes,
      planned_start_at: plannedStartAt,
      paid: b.paid ? 1 : 0,
      note: String(b.note || '').trim() || null,
    });
  }
  return out;
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
  // Before the transaction, not inside it. A rollback would be correct either
  // way; refusing first means the shift is never half-created in the first
  // place, and the error names the break rather than the write.
  const breakRows = normalizeBreaks(input.breaks, startsAt, endsAt);

  let id = null;
  db.transaction(() => {
    const info = q.insert.run({
      employee_id: employeeId, position, business_date: businessDate,
      starts_at: startsAt, ends_at: endsAt, daypart,
      status: 'draft', note: String(input.note || '').trim() || null,
      created_by: input.createdBy || null,
    });
    id = Number(info.lastInsertRowid);
    writeBreaks(id, breakRows);
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
  // keepPosition: this shift's existing job stays legal on edit even if it has
  // since been retired, so a stale shift can still be fixed. duplicate() and
  // copyWeek() pass nothing, because both write NEW assignments.
  validate({ employeeId, position, startsAt, endsAt, keepPosition: row.position });

  // Re-stamped only when the START actually moves. An edit to the note or the
  // end time leaves the service alone, and a service-window change elsewhere
  // never reaches an existing shift at all.
  const daypart = patch.daypart !== undefined && DAYPARTS.includes(patch.daypart) ? patch.daypart
    : (startsAt !== row.starts_at ? serviceFor(startsAt) : row.daypart);
  const businessDate = startsAt !== row.starts_at ? businessDateFor(startsAt) : row.business_date;
  const note = patch.note !== undefined ? (String(patch.note || '').trim() || null) : row.note;

  let breakRows = null;
  if (patch.breaks !== undefined) {
    breakRows = normalizeBreaks(patch.breaks, startsAt, endsAt);
  } else if (startsAt !== row.starts_at || endsAt !== row.ends_at) {
    // The breaks were valid against the OLD span. Shorten an 8-hour shift to
    // twenty minutes and an untouched hour-long break would survive it, making
    // paid hours negative on the board and in every total built from them.
    // Validate in place; do not silently rewrite what the manager did not edit.
    normalizeBreaks(q.breaksFor.all(id), startsAt, endsAt, true);
  }

  // Phase 3 — material means "what an employee can SEE has gone stale", and
  // nothing else. The flag drives one thing: telling a manager the floor is
  // looking at something older than the draft.
  //
  // Deliberately NOT material: the note (manager-private, never rendered to an
  // employee), the daypart (internal service stamping — Time Clock semantics
  // are untouched, employees are never shown Cafe/Dinner), a break's internal
  // note, and a breaks patch that normalises to what was already there. Before
  // this, ANY breaks patch counted, so re-saving a drawer without touching the
  // break marked a published week stale and asked for a republish that would
  // change nothing an employee sees.
  const seenBreaks = (rows) => rows
    .map((b) => `${b.minutes}|${b.planned_start_at || ''}|${b.paid ? 1 : 0}`).join(';');
  const breaksChanged = breakRows !== null
    && seenBreaks(breakRows) !== seenBreaks(q.breaksFor.all(id));

  const material = employeeId !== row.employee_id     // includes assigned <-> open
    || position !== row.position
    || startsAt !== row.starts_at                     // business date derives from this
    || endsAt !== row.ends_at
    || breaksChanged;

  db.transaction(() => {
    q.update.run({
      id, employee_id: employeeId, position, business_date: businessDate,
      starts_at: startsAt, ends_at: endsAt, daypart, note,
      changed_after_publish: row.status === 'published' && material ? 1 : row.changed_after_publish,
    });
    if (breakRows) writeBreaks(id, breakRows);
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

/** Attach planned breaks to a set of shifts in one query, not one each. */
function withBreaks(rows) {
  if (!rows.length) return rows;
  const grouped = {};
  for (const b of q.breaksForMany.all(JSON.stringify(rows.map((r) => r.id)))) {
    (grouped[b.scheduled_shift_id] || (grouped[b.scheduled_shift_id] = [])).push(b);
  }
  return rows.map((r) => ({ ...r, breaks: grouped[r.id] || [] }));
}

/**
 * The manager board: everything not cancelled, in a date range.
 *
 * D1 — two queries for a week, not one per shift. Batched rather than cached:
 * a cache would go stale the moment a break is edited, and the board is the
 * screen that has to be right immediately after an edit.
 */
function inRange(from, to) {
  return withBreaks(q.inRange.all(from, to));
}

/**
 * Which week a business date falls in — THE definition, used everywhere.
 *
 * Not Monday. Not Saturday. The pay period's own workweek, because that is the
 * seven days overtime is measured against:
 *
 *   reports.js:120   const midDate = shiftDate(from, 7);
 *                    const weekKey = (d) => (d < midDate ? 'wk1' : 'wk2');
 *
 * The OT workweek is the period start and start + 7, whatever weekday that is —
 * a Saturday, as the anchor currently stands. A board showing Monday to Sunday
 * would total a different seven days from the one deciding whether hour 41 is
 * paid at time and a half, and nobody would notice until a pay run.
 *
 * Derived from periods.js rather than restated here, so moving the anchor or
 * the period length moves the board with it and changes no scheduler code.
 *
 * Pure ISO-date arithmetic: no getDay(), no bare `new Date(string)`, nothing
 * that reads the server's zone.
 */
function weekWindowFor(businessDate) {
  const p = P.periodFor(businessDate);
  const offset = daysApart(p.start, businessDate);
  const start = addDays(p.start, Math.floor(offset / 7) * 7);
  // A period whose length is not a whole number of weeks leaves a short final
  // stretch. Clamp to the period rather than running a week past its end and
  // colliding with the next one.
  const end = addDays(start, 6);
  return { start, end: end > p.end ? p.end : end };
}

/** The week window plus the shifts in it, for the board. */
function weekFor(anyDate) {
  const { start, end } = weekWindowFor(anyDate);
  return { start, end, shifts: inRange(start, end) };
}

// ---------------------------------------------------------------------------
// Hours (D4, Q3)
// ---------------------------------------------------------------------------

/**
 * Two different numbers, both kept.
 *
 *   span = how long the person is at work
 *   paid = span minus the breaks they are NOT paid for
 *
 * They are not interchangeable. Span is what a manager pictures when they place
 * an 11-to-7; paid is what the hours cost. Collapsing them into one figure means
 * one of the two screens is lying, and which one depends on where you look.
 *
 * Nothing here writes, and nothing here is payroll. These are PLANNED minutes —
 * what was intended. Paid hours come from the clock, through aggregatePayroll,
 * and this module never feeds it.
 */
function spanMinutes(shift) {
  return minutesBetween(shift.starts_at, shift.ends_at);
}

function paidMinutes(shift) {
  const unpaid = (shift.breaks || [])
    .filter((b) => !b.paid)
    .reduce((n, b) => n + Number(b.minutes || 0), 0);
  // Clamped as a floor, not as a fix. normalizeBreaks makes a break longer than
  // its shift impossible; if that ever fails, the board shows 0 rather than a
  // negative that would look like a real figure.
  return Math.max(0, spanMinutes(shift) - unpaid);
}

/**
 * Week totals for the board — per employee, per day, and overall.
 *
 * Cancelled shifts are excluded: a plan that was called off is not hours. Open
 * shifts (no employee) are counted in the day and grand totals under the key
 * 'open', so a week's staffing does not silently shrink by ignoring them.
 */
function weekTotals(shifts) {
  const blank = () => ({ spanMinutes: 0, paidMinutes: 0, count: 0 });
  const bump = (bucket, span, paid) => {
    bucket.spanMinutes += span; bucket.paidMinutes += paid; bucket.count += 1;
  };

  const byEmployee = {}; const byDate = {}; const byCell = {};
  const total = blank();

  for (const s of shifts) {
    if (s.status === 'cancelled') continue;
    const span = spanMinutes(s);
    const paid = paidMinutes(s);
    const who = s.employee_id == null ? 'open' : String(s.employee_id);
    const day = s.business_date;

    bump(byEmployee[who] || (byEmployee[who] = blank()), span, paid);
    bump(byDate[day] || (byDate[day] = blank()), span, paid);
    bump(byCell[`${who}|${day}`] || (byCell[`${who}|${day}`] = blank()), span, paid);
    bump(total, span, paid);
  }
  return { byEmployee, byDate, byCell, total };
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
 * Take a shift back off the employee's schedule, WITHOUT cancelling it.
 *
 * Three different things a manager might mean, kept apart on purpose:
 *   edit      changes the draft; the floor still sees the last published truth
 *   cancel    the shift is off — a plan that was called off, kept as a record
 *   unpublish the shift is still planned, but nobody should be looking at it
 *             yet. The draft stays exactly where it was on the board.
 *
 * Status returns to 'draft' because that is what it now is: something the
 * manager holds and the floor cannot see. changed_after_publish clears with
 * it — there is no published truth left for the draft to be stale against.
 */
function unpublish(id) {
  const row = q.byId.get(id);
  if (!row) throw new ScheduleError('That shift is no longer there.', 'missing');
  db.transaction(() => {
    q.pubDelete.run(id);
    if (row.status === 'published') q.setStatus.run({ id, status: 'draft' });
    q.clearChanged.run({ id });
  })();
  return byId(id);
}

/**
 * Publish a whole week by RECONCILING it, not by trusting a flag.
 *
 * The union of two sets, because either alone is wrong:
 *
 *   drafts dated in the week   — including cancelled ones, which inRange hides
 *                                from the board but which publishing must see,
 *                                since a cancellation is the change that most
 *                                needs to reach the floor
 *   published rows dated in the week — so a shift DRAGGED OUT of this week is
 *                                still reconciled. Without this the employee
 *                                would keep the old date forever: nothing in
 *                                the draft week would be left to notice it.
 *
 * publish() then does the right thing per id — upsert to its CURRENT date,
 * delete on cancelled, skip open — so a cross-week move updates the one
 * logical published shift rather than leaving two copies of it. One
 * transaction: a half-published week is worse than an unpublished one.
 */
function publishWeek(anyDate) {
  const w = weekWindowFor(anyDate);
  const ids = new Set();
  for (const r of q.inRangeAll.all(w.start, w.end)) ids.add(r.id);
  for (const r of q.pubInRange.all(w.start, w.end)) ids.add(r.scheduled_shift_id);
  return { week: w, results: publish([...ids]) };
}

/**
 * What an employee can currently SEE for a week, as a comparable string.
 *
 * The identity a publish notification is deduped on. Deliberately derived from
 * the RESULT rather than from the act: retrying the same publish produces the
 * same fingerprint and therefore the same key, so the second attempt notifies
 * nobody — while a genuinely different outcome produces a different key and
 * does notify. A timestamp would change on every retry and defeat the point.
 *
 * Only employee-visible fields. The note is absent because employees never see
 * it, and the daypart because they are never shown the service — so neither can
 * manufacture a notification about something invisible.
 */
function publishedFingerprint(employeeId, from, to) {
  return q.pubForWeek.all({ emp: employeeId, from, to })
    .map((r) => {
      const breaks = (r.breaks_json ? JSON.parse(r.breaks_json) : [])
        .map((b) => `${b.minutes}/${b.plannedStartAt || ''}/${b.paid ? 1 : 0}`).join(',');
      return `${r.scheduled_shift_id}:${r.business_date}:${r.starts_at}:${r.ends_at}:${r.position}:${breaks}`;
    })
    .join('|');
}

/**
 * Duplicate one shift into the same cell — same person, same day, same times.
 *
 * The common case is a split shift or a second person on the same station, and
 * making a manager retype an identical row is how a scheduler earns its
 * reputation. Deliberately not a drawer: one click, one row, edit after.
 *
 * The daypart is CARRIED, not re-derived. A copy of this exact shift is this
 * exact shift; if a manager hand-set it to cafe, the duplicate is cafe too.
 * (copyWeek re-derives because a new week is a new plan. Same rule, read from
 * opposite ends: the stamp follows the shift, not the calendar.)
 */
function duplicate(id, opts = {}) {
  const src = byId(id);
  if (!src) throw new ScheduleError('That shift is no longer there.', 'missing');
  if (src.status === 'cancelled') throw new ScheduleError('That shift was cancelled.', 'cancelled');

  // Re-checked, not assumed. The original may have been placed weeks ago and
  // the person has since left the position or the roster.
  validate({
    employeeId: src.employee_id, position: src.position,
    startsAt: src.starts_at, endsAt: src.ends_at,
  });
  const breakRows = normalizeBreaks(src.breaks, src.starts_at, src.ends_at, true);

  let made = null;
  db.transaction(() => {
    const info = q.insert.run({
      employee_id: src.employee_id, position: src.position,
      business_date: src.business_date,
      starts_at: src.starts_at, ends_at: src.ends_at,
      daypart: src.daypart,
      // Always a draft, whatever the original was. A duplicate has never been
      // published, so it must not inherit a published status or the hint flag.
      status: 'draft', note: src.note, created_by: opts.createdBy || null,
    });
    made = Number(info.lastInsertRowid);
    writeBreaks(made, breakRows);
  })();
  return byId(made);
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
/**
 * PHASE 7 — one day's staffing onto another day.
 *
 * copyWeek already existed and this is its smaller sibling, written the same way
 * on purpose: same duplicate key, same "creates drafts", same refusal to publish.
 * Saturday usually looks like Friday, and rebuilding it card by card is the work
 * this phase exists to remove.
 *
 * Shifts are matched by BUSINESS DATE, not calendar date, so a Friday close
 * running to 2am Saturday copies as part of Friday — which is what a manager
 * clicking Friday means, and the only reading that keeps a night in one piece.
 */
function copyDay(fromDate, toDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate))) {
    throw new ScheduleError('Pick a day to copy from and a day to copy into.', 'range');
  }
  if (fromDate === toDate) throw new ScheduleError('Choose a different day to copy into.', 'range');
  const offset = daysApart(fromDate, toDate);
  if (!Number.isFinite(offset) || offset === 0) throw new ScheduleError('Choose a different day.', 'range');

  const source = q.inRangeAll.all(fromDate, fromDate).filter((r) => r.status !== 'cancelled');
  const existing = q.inRangeAll.all(toDate, toDate).filter((r) => r.status !== 'cancelled');
  const seen = new Set(existing.map((r) => `${r.employee_id}|${r.starts_at}|${r.position}`));

  const made = []; const skipped = [];
  for (const src of source) {
    // An OPEN shift has nobody on it. Copying one forward is meaningful later,
    // when Phase 8 gives it a way to be claimed; today it would just be an empty
    // card nobody can act on, so it is skipped and counted rather than silently
    // dropped.
    if (src.employee_id == null) { skipped.push({ reason: 'open shift' }); continue; }
    const startsAt = shiftUtcByDays(src.starts_at, offset);
    if (seen.has(`${src.employee_id}|${startsAt}|${src.position}`)) {
      skipped.push({ reason: 'already there' });
      continue;
    }
    try {
      made.push(create({
        employeeId: src.employee_id,
        position: src.position,
        startsAt: TC.utcToLocalInput(startsAt).replace('T', ' '),
        endsAt: TC.utcToLocalInput(shiftUtcByDays(src.ends_at, offset)).replace('T', ' '),
        note: src.note || null,
        createdBy: 'copy-day',
      }));
      seen.add(`${src.employee_id}|${startsAt}|${src.position}`);
    } catch (e) {
      // Somebody deactivated, or a position retired since. One refusal must not
      // sink the rest of the day.
      skipped.push({ reason: (e && e.message) || 'could not be created' });
    }
  }
  return { made, skipped };
}

function copyWeek(fromStart, toStart, opts = {}) {
  // Both bounded by the same week definition the board uses, so a short final
  // week of a period cannot pull shifts out of the next one — and so that any
  // day in a week means that week, which is what a manager clicking a board
  // column expects.
  const from = weekWindowFor(fromStart);
  const to = weekWindowFor(toStart);
  // Measured between the WEEK STARTS, not the dates handed in. Otherwise
  // copying Tuesday's week onto Friday's week would slide every shift three
  // days sideways.
  const offset = daysApart(from.start, to.start);
  if (!Number.isFinite(offset) || offset === 0) {
    throw new ScheduleError('Choose a different week to copy into.', 'range');
  }
  const source = inRange(from.start, from.end);
  const existing = inRange(to.start, to.end);
  const seen = new Set(existing.map((s) => `${s.employee_id}|${s.starts_at}|${s.position}`));

  const made = []; const skipped = [];
  db.transaction(() => {
    for (const s of source) {
      const starts = shiftUtcByDays(s.starts_at, offset);
      const ends = shiftUtcByDays(s.ends_at, offset);
      const landing = businessDateFor(starts);

      // D6 — the SAME rule as the drawer, called rather than restated. This is
      // the whole fix: copyWeek used to insert straight through q.insert and so
      // could place a shift the create form would have refused — somebody who
      // had left the position, or left the roster entirely.
      try {
        validate({ employeeId: s.employee_id, position: s.position, startsAt: starts, endsAt: ends });
      } catch (e) {
        // The error's own wording, so the report reads 'They are not assigned
        // to that position' rather than a code the manager has to decode.
        skipped.push({ id: s.id, who: s.employee_name, why: e.message, code: e.code });
        continue;
      }

      if (landing < to.start || landing > to.end) {
        skipped.push({
          id: s.id, who: s.employee_name,
          why: 'That day falls outside the week being copied into.', code: 'range',
        });
        continue;
      }
      if (seen.has(`${s.employee_id}|${starts}|${s.position}`)) {
        skipped.push({
          id: s.id, who: s.employee_name,
          why: 'That shift is already on the target week.', code: 'duplicate',
        });
        continue;
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
      writeBreaks(id, normalizeBreaks(
        s.breaks.map((b) => ({
          ...b,
          planned_start_at: b.planned_start_at ? shiftUtcByDays(b.planned_start_at, offset) : null,
        })),
        starts, ends, true,
      ));
      seen.add(`${s.employee_id}|${starts}|${s.position}`);
      made.push(id);
    }
  })();
  return { made, skipped };
}

/**
 * PHASE 7 — one shift, repeated.
 *
 * The whole point is that a manager stops typing the same Friday six times. What
 * it must NOT become is a second way to make a shift: every occurrence goes
 * through create() so the inactive-employee guard, the held-position check, the
 * daypart stamp and the break rules all apply exactly as they do to a shift made
 * by hand. A recurrence that could place a shift an ordinary create would refuse
 * is a hole, not a feature.
 *
 * IT MAKES DRAFTS. The roadmap states this outright and it is worth restating
 * where somebody might be tempted: generating a month of shifts and publishing
 * them in the same motion sends a month of notifications nobody reviewed.
 *
 * SKIPS RATHER THAN DUPLICATES, on the same key copyWeek uses
 * (employee|starts_at|position). Running it twice must not double the week — a
 * manager who is not sure whether it worked will run it again, and that is the
 * behaviour that has to be safe.
 *
 * @param {object} base   the same shape create() takes — the FIRST occurrence
 * @param {object} repeat {everyWeeks, weekdays, weeks, until}
 */
const SERIES_CAP = 60;

function createSeries(base, repeat = {}) {
  const every = Math.max(1, Math.min(8, Number(repeat.everyWeeks) || 1));
  // weekdays is OPTIONAL. Without it the series lands on the day the first
  // shift already falls on, which is what "repeat weekly" means to a person.
  const days = Array.isArray(repeat.weekdays) && repeat.weekdays.length
    ? [...new Set(repeat.weekdays.map(Number).filter((d) => d >= 0 && d <= 6))].sort()
    : null;
  const weeks = Math.max(0, Math.min(SERIES_CAP, Number(repeat.weeks) || 0));
  const until = /^\d{4}-\d{2}-\d{2}$/.test(String(repeat.until || '')) ? repeat.until : null;

  // Work out WHEN before creating anything, so the whole series can be checked
  // against what is already there in one pass.
  const startUtc = toUtc(base.startsAt);
  const endUtc = toUtc(base.endsAt);
  const baseDate = localDateOf(startUtc);
  const baseDow = new Date(`${baseDate}T00:00:00Z`).getUTCDay();

  const offsets = new Set([0]);
  if (weeks || until) {
    if (days) for (const d of days) { const o = d - baseDow; if (o > 0) offsets.add(o); }
    for (let w = 1; w <= SERIES_CAP; w += 1) {
      if (weeks && w > weeks) break;
      const weekOffset = w * 7 * every;
      if (days) { for (const d of days) offsets.add(weekOffset + (d - baseDow)); }
      else offsets.add(weekOffset);
    }
  }

  const wanted = [];
  for (const off of [...offsets].sort((a, b) => a - b)) {
    if (off < 0) continue;
    const sAt = shiftUtcByDays(startUtc, off);
    if (until && localDateOf(sAt) > until) continue;
    wanted.push({ startsAt: sAt, endsAt: shiftUtcByDays(endUtc, off) });
    if (wanted.length >= SERIES_CAP) break;
  }

  // ALREADY THERE? Then leave it alone. create() does NOT refuse a duplicate —
  // overlaps are a warning by deliberate Phase 2 decision, because split shifts
  // and doubles are real. That is right for one shift made on purpose and wrong
  // for a series: a manager unsure whether the repeat worked will run it again,
  // and the second run must not double the month. Same key copyWeek uses.
  const first = wanted[0];
  const last = wanted[wanted.length - 1];
  const existing = first
    ? q.inRangeAll.all(localDateOf(first.startsAt), addDays(localDateOf(last.startsAt), 1))
    : [];
  const seen = new Set(existing
    .filter((r) => r.status !== 'cancelled')
    .map((r) => `${r.employee_id}|${r.starts_at}|${r.position}`));

  const made = []; const skipped = [];
  for (const occ of wanted) {
    const key = `${base.employeeId}|${occ.startsAt}|${base.position}`;
    if (seen.has(key)) { skipped.push({ startsAt: occ.startsAt, reason: 'already on the schedule' }); continue; }
    try {
      made.push(create({
        ...base,
        startsAt: TC.utcToLocalInput(occ.startsAt).replace('T', ' '),
        endsAt: TC.utcToLocalInput(occ.endsAt).replace('T', ' '),
      }));
      seen.add(key);
    } catch (e) {
      // One refusal must not sink the series. Telling somebody "six made, one
      // refused because they no longer hold that position" is more use than
      // refusing all seven and explaining nothing.
      skipped.push({ startsAt: occ.startsAt, reason: (e && e.message) || 'could not be created' });
    }
  }
  return { made, skipped, capped: wanted.length >= SERIES_CAP };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAYPARTS = ['cafe', 'dinner'];

/**
 * Whole days between two ISO dates.
 *
 * Parsed as explicit UTC. `new Date('2026-08-07T00:00:00')` without the Z is
 * parsed in the SERVER's zone, which is right until the server moves and wrong
 * silently when it does — and across a DST boundary two such parses are an
 * hour apart, which a naive divide turns into a fractional day.
 */
const daysApart = (a, b) => Math.round(
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000,
);

const parseUtc = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);
const fmtUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Whole minutes between two UTC stamps. */
const minutesBetween = (a, b) => Math.round((parseUtc(b) - parseUtc(a)) / 60000);

/** Move a UTC stamp forward by minutes. */
const addMinutesUtc = (utc, mins) => fmtUtc(parseUtc(utc) + mins * 60000);

/** Move a UTC stamp by whole days, keeping the clock time. */
function shiftUtcByDays(utc, days) {
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Writes rows that normalizeBreaks has already checked. Validates nothing. */
function writeBreaks(shiftId, rows) {
  q.clearBreaks.run(shiftId);
  for (const r of rows) q.addBreak.run({ scheduled_shift_id: shiftId, ...r });
}

// ===========================================================================
// ISSUES — what is wrong with this week, derived on read
// ===========================================================================
//
// Phase 4. Four conditions, computed from the week's current state every time
// somebody asks. No table, no cache, no dismissal.
//
// DERIVED, NOT STORED, and that is the design rather than a shortcut. A week of
// 50 shifts derives in a quarter of a millisecond; a stored copy would need
// invalidating from ten different mutation points and would be wrong the first
// time one was missed. It also settles something Phase 2 left open: duplicate
// and copy-week deliberately do NOT warn about the overlaps they create,
// because warning mid-bulk-action is noise. Derived issues catch those on the
// next render with no route-specific code at all.
//
// TWO SEVERITIES, no more:
//
//   review   worth a look. Overlap — a real plan a manager may have meant
//   action   the schedule is wrong under today's rules, or the floor is
//            looking at something the manager is not
//
// Nothing here blocks a save or a publish. Phase 4 makes problems visible; it
// does not change who is allowed to do what.
//
// Returns DATA, not sentences. The route owns the wording, because it has the
// employee names and the position names already loaded for the board.

/** review = worth a look. action = wrong under today's rules. */
// Phase 6 adds two and nothing structural. 'timeoff' is an ACTION because a
// manager personally approved that absence and has now scheduled over it;
// 'unavailable' is a REVIEW because the employee stated a constraint the manager
// is explicitly allowed to override. Neither ever blocks.
const ISSUE_SEVERITY = { overlap: 'review', qualification: 'action', 'position-retired': 'action', 'cancelled-live': 'action',
  timeoff: 'action', unavailable: 'review' };

/**
 * Every issue in one week.
 *
 * @param {string} anyDate  any day in the week to examine
 * @returns {{week: object, issues: Array}} issues sorted by day, then severity
 */
function issuesFor(anyDate) {
  const week = weekWindowFor(anyDate);
  const rows = q.inRangeAll.all(week.start, week.end);   // cancelled included
  const issues = [];
  const seen = new Set();
  const add = (i) => { if (!seen.has(i.key)) { seen.add(i.key); issues.push(i); } };

  const live = rows.filter((r) => r.status !== 'cancelled');
  const held = heldPositionsFor(live.map((r) => r.employee_id));
  // ONE load for the whole week. The measured cost of asking per shift was 28.6ms
  // against Phase 4's 0.25ms budget for this entire function; loading once and
  // resolving in memory brings it back under a millisecond. See the note above
  // availabilityContext.
  const avCtx = availabilityContext(
    live.filter((r) => r.employee_id != null).map((r) => r.employee_id),
    live.reduce((m, r) => (r.starts_at < m ? r.starts_at : m), '9999'),
    live.reduce((m, r) => (r.ends_at > m ? r.ends_at : m), '0000'));
  const active = new Set(positions.active.all().map((p) => p.slug));

  for (const s of live) {
    // --- overlap -----------------------------------------------------------
    // One clash is ONE issue. overlapsFor asks from a single side, so a pair
    // reports itself twice — once from A, once from B. Sorting the two ids into
    // the key collapses them, which is what makes the count mean "how many
    // clashes" rather than "how many cards are involved in one".
    for (const other of overlapsFor(s)) {
      const [a, b] = [s.id, other.id].sort((x, y) => x - y);
      add({
        key: `overlap:${a}:${b}`,
        kind: 'overlap',
        severity: ISSUE_SEVERITY.overlap,
        employeeId: s.employee_id,
        businessDate: s.business_date < other.business_date ? s.business_date : other.business_date,
        shiftIds: [a, b],
        // Both sides, so the route can say which two shifts without re-querying.
        pair: [s.id === a ? s : other, s.id === a ? other : s],
      });
    }

    // --- the position is no longer theirs ----------------------------------
    // Valid when it was made. A role was removed, or the employee's primary
    // role was rewritten, and neither route looks at the schedule.
    if (s.employee_id != null && !(held[s.employee_id] || []).includes(s.position)) {
      add({
        key: `qualification:${s.id}`,
        kind: 'qualification',
        severity: ISSUE_SEVERITY.qualification,
        employeeId: s.employee_id,
        businessDate: s.business_date,
        shiftIds: [s.id],
        position: s.position,
      });
    }

    // --- Phase 6: an absence, or a stated constraint ------------------------
    //
    // DERIVED, never stored, exactly like every other issue here. There is no
    // dismissal and no override flag: fix the schedule or fix the request and
    // the issue goes. An override flag would be dismissal by another name, and
    // Phase 4 settled that.
    //
    // A PENDING request is deliberately absent from this list. It is context for
    // the drawer, not a count on the board — otherwise an employee can put a
    // warning on their manager's week simply by asking.
    if (s.employee_id != null) {
      const av = resolveAvailability(avCtx, s.employee_id, s.starts_at, s.ends_at);
      if (av.timeOff && av.timeOff.status === 'approved') {
        add({
          key: `timeoff:${s.id}:${av.timeOff.id}`,
          kind: 'timeoff',
          severity: ISSUE_SEVERITY.timeoff,
          employeeId: s.employee_id,
          businessDate: s.business_date,
          shiftIds: [s.id],
          requestId: av.timeOff.id,
        });
      } else if (av.state === 'unavailable' && av.rule) {
        add({
          key: `unavailable:${s.id}:${av.rule.id}`,
          kind: 'unavailable',
          severity: ISSUE_SEVERITY.unavailable,
          employeeId: s.employee_id,
          businessDate: s.business_date,
          shiftIds: [s.id],
          ruleId: av.rule.id,
        });
      }
    }

    // --- the position itself was retired -----------------------------------
    // Only reachable for shifts that already existed when it was deactivated;
    // new ones are refused at the write. That is what keeps this list finite.
    if (!active.has(s.position)) {
      add({
        key: `position-retired:${s.id}`,
        kind: 'position-retired',
        severity: ISSUE_SEVERITY['position-retired'],
        employeeId: s.employee_id,
        businessDate: s.business_date,
        shiftIds: [s.id],
        position: s.position,
      });
    }
  }

  // --- cancelled, but the floor still sees it -------------------------------
  // The manager called the shift off and has not published the cancellation, so
  // two people are reading two different plans. Publishing resolves it — no
  // separate action needed, which is why there is no resolve workflow.
  for (const s of rows) {
    if (s.status !== 'cancelled') continue;
    if (!q.pubById.get(s.id)) continue;
    add({
      key: `cancelled-live:${s.id}`,
      kind: 'cancelled-live',
      severity: ISSUE_SEVERITY['cancelled-live'],
      employeeId: s.employee_id,
      businessDate: s.business_date,
      shiftIds: [s.id],
      position: s.position,
    });
  }

  // Action before review, then by day, so the list opens on what matters.
  const rank = { action: 0, review: 1 };
  issues.sort((x, y) => rank[x.severity] - rank[y.severity]
    || String(x.businessDate).localeCompare(String(y.businessDate))
    || x.key.localeCompare(y.key));
  return { week, issues };
}

module.exports = {
  create, createSeries, edit, cancel, publish, duplicate, unpublish, publishWeek,
  templates, saveTemplate, deleteTemplate,
  publishedFingerprint, issuesFor, ISSUE_SEVERITY,
  byId, inRange, weekFor, weekWindowFor, weekTotals,
  publishedFor, overlapsFor, copyWeek, copyDay,
  spanMinutes, paidMinutes,
  serviceFor, businessDateFor, heldPositions, heldPositionsFor,
  availabilityFor, availabilityForMany, availabilityEnabled, ruleWindowOn,
  availabilityContext, resolveAvailability, approvedTimeOffOverlapping,
  q, DAYPARTS, STATUSES, ScheduleError,
  WINDOW_BACK, WINDOW_FORWARD,
};

// ===========================================================================
// Phase 6 — resolving availability.
// ===========================================================================
//
// ONE ANSWER, ONE DEFINITION. The Issues engine, the create/edit warning, the
// drawer's context line and (later) Day View all ask this and nothing else. The
// mistake to avoid is the one sbOverlapNote made by living in a route: two
// copies of a rule drift, and duplicate/copy-week silently stopped warning.
//
// IT RETURNS FACTS, NOT A BOOLEAN. Phase 8's claim/replacement eligibility is
// specified to consume availability and approved time off through a shared
// evaluator rather than re-deriving them. A boolean would force exactly that
// re-derivation: 'preferred' is not a weaker 'available' when you are ranking
// volunteers, and a pending request is a different verdict from an approved one.
//
// QUALIFICATION IS NOT IN HERE. heldPositions() answers "does this person do
// that job" and stays separate, so there is deliberately no `position` argument
// below — availability is employee-wide, and a position parameter would be the
// seam through which qualification leaked into availability storage. Phase 8
// composes the two; it does not merge them.
//
// IT IS SPLIT INTO A LOAD AND A RESOLVE, AND THAT SPLIT WAS MEASURED RATHER
// THAN GUESSED. The Phase 6 audit predicted this would "stay comfortably
// synchronous with no caching", reasoning from Phase 4 deriving a real week of
// issues in 0.25 ms. The first version here queried inside every call, which is
// the shape the audit imagined, and a 50-shift week cost 28.6 ms — about 114x
// the entire budget it was being added to, because the Issues engine asks once
// per shift. Loading the week once and resolving in memory is what makes the
// original prediction true. Keep new callers on a context if they ask more than
// once.

// Local wall clock <-> UTC, memoised.
//
// MEASURED: TC.localInputToUtc costs ~104us per call and utcToLocalInput ~50us,
// because each one goes through Intl timezone machinery. The resolver asks for
// the same handful of local instants over and over — a week has a few hundred
// distinct (date, time) pairs and a roster asks about each of them repeatedly —
// so the conversions, not the queries, were the whole cost of deriving a week.
//
// Safe to cache for the life of the process: the mapping from a local wall
// clock string to an instant is fixed by the zone's rules, which do not change
// while the server is running. Bounded so a long-lived process cannot grow it
// without limit; clearing is free because every entry is recomputable.
// THE ZONE IS PART OF THE KEY, and that is not paranoia. timeclock.js reads the
// zone as `const TZ = () => process.env.TZ || 'America/New_York'` — a FUNCTION,
// evaluated per call, not a constant captured at load. So '2026-08-21 22:00' does
// not name one instant; it names one instant PER ZONE, and a cache keyed on the
// string alone would hand back a New York answer to a London question. Nothing in
// production changes TZ today, but the whole point of a cache key is that it does
// not depend on that staying true.
//
// DST needs nothing extra, because the key carries the full local date AND time.
// '2026-11-01 01:30' is one key with one answer; the probe loop inside
// localInputToUtc resolves the ambiguous hour the same way every time, so the
// cache can only ever repeat a decision it did not make.
const tzKey = () => process.env.TZ || 'America/New_York';
const TZ_MEMO = new Map();
function localToUtc(local) {
  const key = `${tzKey()}|${local}`;
  let v = TZ_MEMO.get(key);
  if (v === undefined) {
    v = TC.localInputToUtc(local);
    if (TZ_MEMO.size > 8192) TZ_MEMO.clear();
    TZ_MEMO.set(key, v);
  }
  return v;
}
const UTC_MEMO = new Map();
function utcToLocal(utc) {
  const key = `${tzKey()}|${utc}`;
  let v = UTC_MEMO.get(key);
  if (v === undefined) {
    v = TC.utcToLocalInput(utc);
    if (UTC_MEMO.size > 8192) UTC_MEMO.clear();
    UTC_MEMO.set(key, v);
  }
  return v;
}

/** Minutes-from-midnight as local 'HH:MM'. */
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * One occurrence of a rule, anchored on a local date, as a UTC window.
 *
 * END BEFORE OR EQUAL TO START MEANS IT ENDS THE NEXT DAY. Friday 22:00-02:00 is
 * one rule, and it belongs to the weekday its START falls on. The employee never
 * learns this; they enter a day, a start and an end, and the UI says "ends 2:00am
 * the next day" when the end is the earlier number.
 *
 * Everything comes back as an instant because that is the only thing safe to
 * compare. A shift at 1am Saturday and a rule anchored on Friday disagree about
 * every label available — calendar date, business date, weekday — and agree
 * about the only thing that matters, which is when they actually are.
 */
function ruleWindowOn(rule, localDate) {
  if (rule.all_day) {
    return { start: localToUtc(`${localDate} 00:00`),
      end: localToUtc(`${addDays(localDate, 1)} 00:00`) };
  }
  const endsNextDay = rule.end_min <= rule.start_min || rule.end_min >= 1440;
  const endDate = endsNextDay ? addDays(localDate, 1) : localDate;
  return { start: localToUtc(`${localDate} ${hhmm(rule.start_min)}`),
    end: localToUtc(`${endDate} ${hhmm(rule.end_min % 1440)}`) };
}

/** The local calendar date an instant falls on. */
const localDateOf = (utc) => String(utcToLocal(utc)).slice(0, 10);

/**
 * Is the availability feature switched on?
 *
 * ABSENT MEANS ON. getSetting returns the fallback for a missing row, so the
 * test is negative — an installation that has never touched the setting gets the
 * feature, because zero rules already behaves exactly like the feature being off
 * and shipping it dark would be the dead toggle the roadmap forbids.
 *
 * It governs AVAILABILITY RULES ONLY. Time off is unconditional: requests can
 * still be made and decided, and an approved absence still conflicts with a
 * shift, because that is a commitment a manager personally made.
 */
function availabilityEnabled() {
  return P.getSetting('sch_availability', '1') !== '0';
}

/** Strict overlap, identical to the shift-overlap test this module already uses. */
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

const BLANK = () => ({ state: 'available', rule: null, timeOff: null, reasons: [] });

/**
 * Load everything needed to answer for these people across this span, once.
 *
 * Two queries total, however many times you then resolve against it. Callers
 * that ask about a whole week of shifts should build one of these and reuse it;
 * see the measurement note above for what happens when they do not.
 */
function availabilityContext(employeeIds, fromUtc, toUtc) {
  const ids = [...new Set((employeeIds || []).map(Number).filter(Boolean))];
  const ctx = { ids, enabled: availabilityEnabled(), rules: new Map(), requests: new Map() };
  if (!ids.length) return ctx;
  const holes = ids.map(() => '?').join(',');

  // Approved first so the resolver can stop at the first hit it finds.
  for (const r of db.prepare(
    `SELECT id, employee_id, starts_at, ends_at, all_day, status
       FROM time_off_requests
      WHERE employee_id IN (${holes})
        AND status IN ('approved', 'pending')
        AND starts_at < ? AND ends_at > ?
      ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, id`).all(...ids, String(toUtc), String(fromUtc))) {
    if (!ctx.requests.has(r.employee_id)) ctx.requests.set(r.employee_id, []);
    ctx.requests.get(r.employee_id).push(r);
  }

  if (ctx.enabled) {
    for (const r of db.prepare(
      `SELECT id, employee_id, avail_kind, weekday, on_date, all_day,
              start_min, end_min, effective_from, effective_until
         FROM availability_rules
        WHERE employee_id IN (${holes})`).all(...ids)) {
      if (!ctx.rules.has(r.employee_id)) ctx.rules.set(r.employee_id, []);
      ctx.rules.get(r.employee_id).push(r);
    }
  }
  return ctx;
}

/**
 * Resolve one employee over one window against a loaded context. Pure — it
 * touches no database, which is the whole point of the split.
 *
 * PRECEDENCE, deterministic and in this order, because a rules engine for four
 * cases would be four times the code and one more thing to be wrong:
 *
 *   1. approved time off   — beats everything, and forces state 'unavailable'
 *   2. a one-off rule      — beats a recurring rule on the same day
 *   3. a recurring rule    — the weekly pattern
 *   4. nothing stated      — available
 *
 * Within a tier, 'unavailable' beats 'prefer'. A PENDING request never changes
 * state: it is reported so the drawer can show context, but an employee must not
 * be able to put a warning on the manager's board simply by asking.
 */
function resolveAvailability(ctx, employeeId, startsAt, endsAt) {
  const id = Number(employeeId);
  const rec = BLANK();
  const qs = String(startsAt);
  const qe = String(endsAt);

  for (const r of ctx.requests.get(id) || []) {
    if (!overlaps(r.starts_at, r.ends_at, qs, qe)) continue;
    rec.timeOff = { id: r.id, status: r.status, allDay: !!r.all_day,
      startsAt: r.starts_at, endsAt: r.ends_at };
    if (r.status === 'approved') {
      rec.state = 'unavailable';
      rec.reasons.push(`timeoff:${r.id}`);
      return rec;                     // nothing outranks an approved absence
    }
    break;                            // a pending one is context; keep looking at rules
  }

  const rules = ctx.rules.get(id);
  if (!rules || !rules.length) return rec;

  // A rule anchored on the previous local day can still reach into this window
  // (that is the whole point of the overnight case), so widen by a day at each
  // end and let the instant comparison decide.
  const firstDate = addDays(localDateOf(qs), -1);
  const lastDate = localDateOf(qe);

  for (const rule of rules) {
    for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
      if (rule.on_date) { if (rule.on_date !== date) continue; }
      else if (new Date(`${date}T00:00:00Z`).getUTCDay() !== rule.weekday) continue;

      // Effective dates are INCLUSIVE and tested against the day the occurrence
      // STARTS. A rule effective through Friday keeps its whole Friday
      // occurrence, tail past midnight included — truncating it at midnight
      // would silently shorten the last one somebody ever stated.
      if (rule.effective_from && date < rule.effective_from) continue;
      if (rule.effective_until && date > rule.effective_until) continue;

      if (!overlaps(...Object.values(ruleWindowOn(rule, date)), qs, qe)) continue;

      const specific = !!rule.on_date;
      const hard = rule.avail_kind === 'unavailable';
      const held = rec.rule;
      const wins = !held
        || (specific && !held.oneOff)
        || (specific === held.oneOff && hard && rec.state !== 'unavailable');
      if (!wins) continue;

      rec.rule = { id: rule.id, kind: rule.avail_kind, oneOff: specific,
        weekday: rule.weekday, onDate: rule.on_date, allDay: !!rule.all_day,
        startMin: rule.start_min, endMin: rule.end_min };
      rec.state = hard ? 'unavailable' : 'preferred';
    }
  }
  if (rec.rule) rec.reasons.push(`${rec.state === 'preferred' ? 'prefer' : 'unavailable'}:${rec.rule.id}`);
  return rec;
}

/**
 * Convenience for a caller that asks once — the drawer's context line, a single
 * create/edit check. Builds a context and throws it away, which is exactly the
 * wrong thing to do in a loop.
 */
function availabilityFor(employeeId, startsAt, endsAt) {
  const ctx = availabilityContext([employeeId], startsAt, endsAt);
  return resolveAvailability(ctx, employeeId, startsAt, endsAt);
}

/**
 * An approved absence overlapping this window, or null.
 *
 * IT LIVES HERE, not in the route that needs it. There is exactly one
 * definition of "these two spans overlap" in this codebase and this module owns
 * it; a copy of the comparison in a route is how the create/edit path and the
 * Issues engine drifted apart before Phase 4 pulled them together. A test pins
 * that server.js carries no second copy.
 *
 * Approved only. A pending request is a question, not a commitment, and
 * refusing a new request because of an unanswered one would let an employee
 * lock their own calendar by asking.
 */
function approvedTimeOffOverlapping(employeeId, startsAt, endsAt) {
  return db.prepare(
    `SELECT id, starts_at, ends_at, all_day FROM time_off_requests
      WHERE employee_id = ? AND status = 'approved'
        AND starts_at < ? AND ends_at > ? LIMIT 1`)
    .get(Number(employeeId), String(endsAt), String(startsAt)) || null;
}

/** The same question for a roster over one window. Returns Map(id -> facts). */
function availabilityForMany(employeeIds, startsAt, endsAt) {
  const ctx = availabilityContext(employeeIds, startsAt, endsAt);
  const out = new Map();
  for (const id of ctx.ids) out.set(id, resolveAvailability(ctx, id, startsAt, endsAt));
  return out;
}
