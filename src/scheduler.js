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
  pubForEmployee: db.prepare(`SELECT * FROM published_schedule
    WHERE employee_id = @emp AND business_date BETWEEN @from AND @to
    ORDER BY starts_at`),
  pubById: db.prepare('SELECT * FROM published_schedule WHERE scheduled_shift_id = ?'),
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
  validate({ employeeId, position, startsAt, endsAt });

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

module.exports = {
  create, edit, cancel, publish, duplicate,
  byId, inRange, weekFor, weekWindowFor, weekTotals,
  publishedFor, overlapsFor, copyWeek,
  spanMinutes, paidMinutes,
  serviceFor, businessDateFor, heldPositions, heldPositionsFor,
  q, DAYPARTS, STATUSES, ScheduleError,
  WINDOW_BACK, WINDOW_FORWARD,
};
