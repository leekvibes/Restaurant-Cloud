'use strict';

// ===========================================================================
// The calendar — obligations, appointments, and the recurring work of running
// a restaurant.
// ===========================================================================
//
// This replaces the Recurring Tasks tracker. It is NOT the Scheduler: nothing
// here touches scheduled_shifts, published_schedule, work, or a punch. The
// Scheduler answers "who is working". The calendar answers "what has to
// happen" — a hood clean, a licence renewal, a vendor meeting.
//
// THE ONE DECISION EVERYTHING ELSE FOLLOWS FROM
//
// Occurrences are DERIVED, never stored. A series holds a rule; expand() walks
// that rule across the range being looked at. There is no table of generated
// occurrences and there never will be.
//
// The same choice as Phase 4's Issues engine, for the same reasons, and it has
// held up there. It also fixes the defect the old tracker was built on: if the
// occurrences come from the rule, then completing one CANNOT move the next.
//
//   old:  next_due = today + interval        every late completion shifted
//                                            the whole future schedule
//   new:  occurrences come from the rule     completing Sep 1 on Sep 5 leaves
//         completion is a separate record    December 1 exactly where it was
//
// SCHEDULE and COMPLETION are different things. Keeping them in one column is
// what made the old model unable to answer "when were the last four hood
// cleanings" — there was only ever room for one answer.
//
// DATES ARE CALENDAR DATES. Not business dates. A September 1 inspection does
// not roll at the 4am cutoff; it is paperwork, not a service. Times are stored
// as minutes past midnight in restaurant local time, which keeps every
// comparison integer and avoids parsing a bare 'YYYY-MM-DD' into a Date and
// hoping the host's timezone agrees.

const { db } = require('./db');
const { isoDate, startOfToday, addDays } = require('./dates');

// ---------------------------------------------------------------------------
// Schema. Owned here, like timeclock.js and scheduler.js own theirs, so the
// module can be required by a test or a script without server.js booting.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS cal_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What it IS, which decides how it behaves. An event happens and is then
  -- over; a task can be completed and can be overdue. A vendor meeting that
  -- was yesterday is not "overdue" — it happened.
  kind          TEXT NOT NULL DEFAULT 'event',   -- event | task
  title         TEXT NOT NULL,
  category      TEXT,
  notes         TEXT,
  -- Free text, deliberately. The responsible party for a grease trap is a
  -- contractor, not somebody on payroll, and forcing an employee id here would
  -- break the commonest case. The two columns below are set only when the text
  -- happened to resolve to something we know, and nothing reads them yet.
  responsible       TEXT,
  responsible_kind  TEXT,
  responsible_id    INTEGER,

  starts_on     TEXT NOT NULL,        -- YYYY-MM-DD, the first occurrence
  ends_on       TEXT,                 -- multi-day only
  all_day       INTEGER NOT NULL DEFAULT 1,
  start_min     INTEGER,              -- minutes past local midnight
  end_min       INTEGER,

  -- Recurrence as COLUMNS, not an RRULE string and not a library.
  --
  -- A string has to be reparsed on every read and cannot be indexed or grepped;
  -- this codebase keeps rules in columns you can read in sqlite3. A library is
  -- 40KB for the fraction we would use, against seven runtime dependencies in
  -- the whole app. The names below are deliberately RRULE's own, so swapping a
  -- real parser in later is mechanical rather than a redesign.
  --
  -- rrule_freq IS NULL means "does not repeat". One column answers the question
  -- the composer asks first, and a one-time item costs no second table.
  rrule_freq        TEXT,             -- daily | weekly | monthly | yearly
  rrule_interval    INTEGER NOT NULL DEFAULT 1,
  rrule_byday       TEXT,             -- 'MO,TH'
  rrule_bymonthday  INTEGER,          -- 1..31, or -1 for the last day
  rrule_bysetpos    INTEGER,          -- 1..4 or -1, with byday: "first Monday"
  rrule_until       TEXT,             -- YYYY-MM-DD inclusive
  rrule_count       INTEGER,

  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cal_start ON cal_items (starts_on);
CREATE INDEX IF NOT EXISTS idx_cal_freq  ON cal_items (rrule_freq);
CREATE INDEX IF NOT EXISTS idx_cal_kind  ON cal_items (kind, archived_at);

-- One occurrence that differs from its rule.
--
-- Keyed on the occurrence's ORIGINAL date, because that is the only stable
-- identity an unstored occurrence has. Moving one to another day does not
-- change the key; the key is which instance of the rule this is about.
CREATE TABLE IF NOT EXISTS cal_exceptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES cal_items(id) ON DELETE CASCADE,
  occurs_on      TEXT NOT NULL,
  status         TEXT NOT NULL,       -- skipped | moved
  moved_to_date  TEXT,
  moved_start_min INTEGER,
  moved_end_min   INTEGER,
  title_override TEXT,
  notes_override TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, occurs_on)
);

-- The history the old model could not hold.
--
-- One row per completion, keyed to the occurrence it belongs to. "When were the
-- last four hood cleanings" is now a query rather than an unanswerable
-- question, and undo deletes a known row by id rather than trusting two dates
-- posted back through a querystring.
CREATE TABLE IF NOT EXISTS cal_completions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL REFERENCES cal_items(id) ON DELETE CASCADE,
  occurs_on     TEXT NOT NULL,
  completed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  completed_by  TEXT,
  notes         TEXT,
  UNIQUE (item_id, occurs_on)
);
CREATE INDEX IF NOT EXISTS idx_cal_done ON cal_completions (item_id, occurs_on);

CREATE TABLE IF NOT EXISTS cal_reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES cal_items(id) ON DELETE CASCADE,
  offset_min  INTEGER NOT NULL,       -- minutes BEFORE the occurrence; 0 = at
  channel     TEXT NOT NULL DEFAULT 'inapp',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cal_rem ON cal_reminders (item_id);
`);

// The table the calendar replaced, kept alive on purpose.
//
// Its definition used to come from the modules.js registry entry, and removing
// that entry — which is what stops the generic /c/ CRUD answering for recurring
// tasks — took the table with it. Existing installs are unaffected, because the
// table is already there with rows in it. A FRESH install had nothing for
// migrateRecurring() to read and nothing for anything else to reference.
//
// So the definition lives here now, beside the migration that is its only
// reader. Unread by anything else, never written, and dropped a release later
// once the migration itself is retired — which is exactly what the plan said
// leaving it in place meant.
db.exec(`
CREATE TABLE IF NOT EXISTS m_recurring (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  name        TEXT,
  frequency   TEXT,
  next_due    TEXT,
  last_done   TEXT,
  responsible TEXT,
  notes       TEXT,
  category    TEXT
);
`);

class CalendarError extends Error {
  constructor(message, code) { super(message); this.name = 'CalendarError'; this.code = code || 'invalid'; }
}

const CATEGORIES = ['Cleaning', 'Maintenance', 'Safety', 'Pest Control', 'Compliance', 'Other'];
const KINDS = ['event', 'task'];
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// A hard ceiling on how many instances one rule may produce for one call.
// The old calendar had `guard++ < 500` for the same reason: a malformed rule
// must not be able to hang a page render.
const MAX_PER_ITEM = 400;

// ---------------------------------------------------------------------------
// Date helpers. Every one works on 'YYYY-MM-DD' strings and never leaves them
// as Dates for longer than an arithmetic step, so no timezone can get in.
// ---------------------------------------------------------------------------

const toParts = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d };
};
const fromParts = (y, m, d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
};
/** Days in a month, 1-indexed month. Handles February and leap years. */
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
/** 0 = Sunday. Built at local noon so no DST shift can move the weekday. */
const weekdayOf = (iso) => {
  const { y, m, d } = toParts(iso);
  return new Date(y, m - 1, d, 12).getDay();
};
const addMonths = (iso, n) => {
  const { y, m, d } = toParts(iso);
  const total = (y * 12) + (m - 1) + n;
  return { y: Math.floor(total / 12), m: (total % 12) + 1, d };
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const q = {
  insert: db.prepare(`INSERT INTO cal_items
    (kind, title, category, notes, responsible, responsible_kind, responsible_id,
     starts_on, ends_on, all_day, start_min, end_min,
     rrule_freq, rrule_interval, rrule_byday, rrule_bymonthday, rrule_bysetpos,
     rrule_until, rrule_count)
    VALUES (@kind, @title, @category, @notes, @responsible, @responsible_kind, @responsible_id,
     @starts_on, @ends_on, @all_day, @start_min, @end_min,
     @rrule_freq, @rrule_interval, @rrule_byday, @rrule_bymonthday, @rrule_bysetpos,
     @rrule_until, @rrule_count)`),
  update: db.prepare(`UPDATE cal_items SET
     kind=@kind, title=@title, category=@category, notes=@notes,
     responsible=@responsible, responsible_kind=@responsible_kind, responsible_id=@responsible_id,
     starts_on=@starts_on, ends_on=@ends_on, all_day=@all_day, start_min=@start_min, end_min=@end_min,
     rrule_freq=@rrule_freq, rrule_interval=@rrule_interval, rrule_byday=@rrule_byday,
     rrule_bymonthday=@rrule_bymonthday, rrule_bysetpos=@rrule_bysetpos,
     rrule_until=@rrule_until, rrule_count=@rrule_count,
     updated_at=datetime('now')
   WHERE id=@id`),
  setUntil: db.prepare("UPDATE cal_items SET rrule_until=@until, updated_at=datetime('now') WHERE id=@id"),
  byId: db.prepare('SELECT * FROM cal_items WHERE id = ?'),
  del: db.prepare('DELETE FROM cal_items WHERE id = ?'),
  archive: db.prepare("UPDATE cal_items SET archived_at=datetime('now') WHERE id=?"),
  // Everything that could possibly touch a window. A recurring series may have
  // started years ago, so recurring rows are never filtered by date here — the
  // expander decides. One-time items are, because they cannot move.
  live: db.prepare(`SELECT * FROM cal_items
    WHERE archived_at IS NULL
      AND (rrule_freq IS NOT NULL
           OR (COALESCE(ends_on, starts_on) >= @from AND starts_on <= @to))
    ORDER BY starts_on, id`),
  all: db.prepare('SELECT * FROM cal_items WHERE archived_at IS NULL ORDER BY starts_on, id'),

  exFor: db.prepare('SELECT * FROM cal_exceptions WHERE item_id = ?'),
  exAdd: db.prepare(`INSERT INTO cal_exceptions
    (item_id, occurs_on, status, moved_to_date, moved_start_min, moved_end_min, title_override, notes_override)
    VALUES (@item_id, @occurs_on, @status, @moved_to_date, @moved_start_min, @moved_end_min, @title_override, @notes_override)
    ON CONFLICT(item_id, occurs_on) DO UPDATE SET
      status=excluded.status, moved_to_date=excluded.moved_to_date,
      moved_start_min=excluded.moved_start_min, moved_end_min=excluded.moved_end_min,
      title_override=excluded.title_override, notes_override=excluded.notes_override`),
  exDelFrom: db.prepare('DELETE FROM cal_exceptions WHERE item_id = ? AND occurs_on >= ?'),

  doneFor: db.prepare('SELECT * FROM cal_completions WHERE item_id = ? ORDER BY occurs_on DESC'),
  doneAdd: db.prepare(`INSERT INTO cal_completions (item_id, occurs_on, completed_by, notes)
    VALUES (@item_id, @occurs_on, @completed_by, @notes)
    ON CONFLICT(item_id, occurs_on) DO NOTHING`),
  doneById: db.prepare('SELECT * FROM cal_completions WHERE id = ?'),
  doneDel: db.prepare('DELETE FROM cal_completions WHERE id = ?'),
  doneOn: db.prepare('SELECT * FROM cal_completions WHERE item_id = ? AND occurs_on = ?'),

  remFor: db.prepare('SELECT * FROM cal_reminders WHERE item_id = ? ORDER BY offset_min DESC'),
  remAdd: db.prepare('INSERT INTO cal_reminders (item_id, offset_min, channel) VALUES (@item_id, @offset_min, @channel)'),
  remClear: db.prepare('DELETE FROM cal_reminders WHERE item_id = ?'),
};

// ---------------------------------------------------------------------------
// The expander
// ---------------------------------------------------------------------------

/**
 * Every date this rule produces inside [from, to].
 *
 * Returns bare 'YYYY-MM-DD' strings; exceptions and completions are applied by
 * expand() on top. Kept separate so the recurrence maths can be tested without
 * a database row anywhere near it.
 *
 * COUNT-limited rules walk from the beginning, because "the 10th occurrence"
 * can only be known by counting from the first — and a count is small by
 * definition. Unlimited rules skip ahead to the window, so a daily rule running
 * since 2020 costs the same as one that started last week.
 */
function datesFor(rule, from, to) {
  const out = [];
  const { starts_on: start } = rule;
  if (!start) return out;
  const freq = rule.rrule_freq;
  const until = rule.rrule_until || null;
  const count = rule.rrule_count || null;
  const step = Math.max(1, Number(rule.rrule_interval) || 1);
  const stop = until && until < to ? until : to;

  // Does not repeat: one date, and it either lands in the window or it does not.
  if (!freq) {
    if (start >= from && start <= to) out.push(start);
    return out;
  }

  let made = 0;                      // instances generated from the very start
  const take = (d) => {
    made += 1;
    if (d >= from && d <= stop) out.push(d);
  };
  const done = () => (count && made >= count) || out.length >= MAX_PER_ITEM;

  if (freq === 'daily') {
    // A whole-day stride, so the first candidate inside the window is
    // arithmetic rather than a loop — unless a count forces us to walk.
    let k = 0;
    if (!count && start < from) {
      const days = Math.round(
        (Date.parse(`${from}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
      k = Math.max(0, Math.floor(days / step));
      made = k;
    }
    for (let i = 0; i < MAX_PER_ITEM * 2; i++) {
      const d = addDays(start, (k + i) * step);
      if (d > stop) break;
      take(d);
      if (done()) break;
    }
    return out;
  }

  if (freq === 'weekly') {
    const byday = String(rule.rrule_byday || '').split(',').filter(Boolean);
    // No weekdays named means "the same weekday as the start date".
    const wanted = byday.length ? byday.map((d) => DAYS.indexOf(d)).filter((n) => n >= 0)
      : [weekdayOf(start)];
    wanted.sort((a, b) => a - b);
    // The Sunday of the week the series starts in — every stride is measured
    // from there, so "every 2 weeks on Mon+Thu" keeps both days in the same week.
    const anchor = addDays(start, -weekdayOf(start));
    let w = 0;
    if (!count && start < from) {
      const weeks = Math.floor(Math.round(
        (Date.parse(`${from}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86400000) / 7);
      w = Math.max(0, Math.floor(weeks / step));
      made = w * wanted.length;      // an estimate; only used to honour count,
    }                                // and count-limited rules never get here
    for (let i = 0; i < MAX_PER_ITEM; i++) {
      const weekStart = addDays(anchor, (w + i) * step * 7);
      if (weekStart > stop) break;
      for (const dow of wanted) {
        const d = addDays(weekStart, dow);
        if (d < start || d > stop) continue;
        take(d);
        if (done()) return out;
      }
      if (done()) break;
    }
    return out;
  }

  if (freq === 'monthly') {
    const byday = String(rule.rrule_byday || '').split(',').filter(Boolean);
    const setpos = rule.rrule_bysetpos;
    const monthday = rule.rrule_bymonthday;
    let k = 0;
    if (!count && start < from) {
      const a = toParts(start); const b = toParts(from);
      const months = ((b.y - a.y) * 12) + (b.m - a.m);
      k = Math.max(0, Math.floor(months / step));
      made = k;
    }
    for (let i = 0; i < MAX_PER_ITEM; i++) {
      const { y, m } = addMonths(start, (k + i) * step);
      if (fromParts(y, m, 1) > stop) break;
      let d = null;

      if (byday.length && setpos) {
        // "first Monday", "last Friday".
        const dow = DAYS.indexOf(byday[0]);
        const dim = daysInMonth(y, m);
        const hits = [];
        for (let day = 1; day <= dim; day++) {
          if (weekdayOf(fromParts(y, m, day)) === dow) hits.push(day);
        }
        const pick = setpos === -1 ? hits[hits.length - 1] : hits[setpos - 1];
        if (pick) d = fromParts(y, m, pick);
      } else {
        const want = monthday || toParts(start).d;
        const dim = daysInMonth(y, m);
        if (want === -1) d = fromParts(y, m, dim);
        // A month too short SKIPS rather than clamping. Clamping "the 31st" to
        // February 28 invents a date nobody asked for, and the next month would
        // silently disagree with it.
        else if (want <= dim) d = fromParts(y, m, want);
      }

      if (d && d >= start && d <= stop) take(d);
      else if (d && d >= start && d > stop) break;
      if (done()) break;
    }
    return out;
  }

  // yearly
  const { m: sm, d: sd } = toParts(start);
  let k = 0;
  if (!count && start < from) {
    k = Math.max(0, Math.floor((toParts(from).y - toParts(start).y) / step));
    made = k;
  }
  for (let i = 0; i < MAX_PER_ITEM; i++) {
    const y = toParts(start).y + ((k + i) * step);
    if (fromParts(y, 1, 1) > stop) break;
    // Feb 29 in a common year skips, for the same reason as the 31st does.
    if (sd <= daysInMonth(y, sm)) {
      const d = fromParts(y, sm, sd);
      if (d >= start && d <= stop) take(d);
    }
    if (done()) break;
  }
  return out;
}

/**
 * Occurrences of one item in a window, with exceptions and completions applied.
 *
 * One resolved list, so no caller has to remember to check three tables and
 * none of them can forget one.
 */
function expand(item, from, to, opts = {}) {
  const ex = new Map();
  for (const e of q.exFor.all(item.id)) ex.set(e.occurs_on, e);
  const done = new Map();
  for (const c of q.doneFor.all(item.id)) done.set(c.occurs_on, c);

  // A moved occurrence can land inside the window from a rule date outside it,
  // so the raw walk is widened and the results filtered on the final date.
  const pad = ex.size ? 31 : 0;
  const raw = datesFor(item, addDays(from, -pad), addDays(to, pad));
  const out = [];
  for (const date of raw) {
    const e = ex.get(date);
    if (e && e.status === 'skipped') continue;
    const on = (e && e.status === 'moved' && e.moved_to_date) ? e.moved_to_date : date;
    if (on < from || on > to) continue;
    out.push({
      itemId: item.id,
      kind: item.kind,
      title: (e && e.title_override) || item.title,
      category: item.category || 'Other',
      notes: (e && e.notes_override) || item.notes,
      responsible: item.responsible,
      // The rule's own date. The stable identity of this instance, and what
      // every write keys on — moving one must not orphan its completion.
      occursOn: date,
      date: on,
      allDay: !!item.all_day,
      startMin: e && e.status === 'moved' && e.moved_start_min != null ? e.moved_start_min : item.start_min,
      endMin: e && e.status === 'moved' && e.moved_end_min != null ? e.moved_end_min : item.end_min,
      recurring: !!item.rrule_freq,
      moved: !!(e && e.status === 'moved'),
      completion: done.get(date) || null,
      completed: done.has(date),
    });
  }
  if (opts.includeSkipped) {
    for (const [date, e] of ex) {
      if (e.status === 'skipped' && date >= from && date <= to) {
        out.push({ itemId: item.id, occursOn: date, date, skipped: true, title: item.title });
      }
    }
  }
  return out;
}

/** Every occurrence of every live item in a window, in date order. */
function range(from, to, opts = {}) {
  const items = q.live.all({ from, to });
  const out = [];
  for (const item of items) {
    if (opts.categories && opts.categories.length
      && !opts.categories.includes(item.category || 'Other')) continue;
    if (opts.kind && item.kind !== opts.kind) continue;
    for (const o of expand(item, from, to)) out.push(o);
  }
  out.sort((a, b) => a.date.localeCompare(b.date)
    || ((a.startMin == null ? -1 : a.startMin) - (b.startMin == null ? -1 : b.startMin))
    || String(a.title).localeCompare(String(b.title)));
  return out;
}

/** The first occurrence on or after a date. Null when the series has ended. */
function nextOccurrence(item, onOrAfter) {
  const from = onOrAfter || isoDate(startOfToday());
  // A year is enough for every frequency the composer offers; a rule with a
  // longer gap than that answers null, which reads as "nothing scheduled".
  const dates = datesFor(item, from, addDays(from, 366));
  return dates.length ? dates[0] : null;
}

// ---------------------------------------------------------------------------
// Status — only ever for tasks
// ---------------------------------------------------------------------------

/**
 * What state a TASK is in. Events do not have one.
 *
 * The old page applied "overdue" to everything it held, which was fine when
 * everything it held was a chore. On a calendar it would mean a vendor meeting
 * that happened yesterday is reported as a failure. An event happened; only a
 * task can be late.
 */
function statusOf(item, today = isoDate(startOfToday())) {
  if (item.kind !== 'task') return { key: 'none', label: '', overdue: false };
  const dueList = datesFor(item, addDays(today, -3650), addDays(today, 366));
  const done = new Set(q.doneFor.all(item.id).map((c) => c.occurs_on));
  const outstanding = dueList.filter((d) => !done.has(d));

  const late = outstanding.filter((d) => d < today);
  if (late.length) {
    const worst = late[0];
    const days = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${worst}T00:00:00Z`)) / 86400000);
    return { key: 'over', label: days === 1 ? '1 day late' : `${days} days late`,
      overdue: true, due: worst, missed: late.length };
  }
  const next = outstanding.find((d) => d >= today);
  if (!next) return { key: 'none', label: 'Nothing scheduled', overdue: false, due: null };
  const days = Math.round(
    (Date.parse(`${next}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (done.has(today) || (q.doneOn.get(item.id, today))) {
    return { key: 'done', label: 'Complete', overdue: false, due: next };
  }
  if (days === 0) return { key: 'soon', label: 'Due today', overdue: false, due: next };
  if (days === 1) return { key: 'soon', label: 'Due tomorrow', overdue: false, due: next };
  if (days <= 7) return { key: 'soon', label: `Due in ${days} days`, overdue: false, due: next };
  return { key: 'sched', label: `In ${days} days`, overdue: false, due: next };
}

/** Every task with an outstanding occurrence in the past. For the dashboard. */
function overdueTasks(today = isoDate(startOfToday())) {
  return q.all.all()
    .filter((i) => i.kind === 'task')
    .map((i) => ({ item: i, status: statusOf(i, today) }))
    .filter((x) => x.status.overdue);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function normalise(patch, base = {}) {
  const v = { ...base, ...patch };
  const title = String(v.title == null ? '' : v.title).trim();
  if (!title) throw new CalendarError('Give it a title.', 'title');
  if (!isDate(v.starts_on)) throw new CalendarError('Choose a date.', 'date');
  if (v.ends_on && !isDate(v.ends_on)) throw new CalendarError('That end date is not a date.', 'date');
  if (v.ends_on && v.ends_on < v.starts_on) {
    throw new CalendarError('It cannot end before it starts.', 'date');
  }
  const freq = v.rrule_freq ? String(v.rrule_freq).toLowerCase() : null;
  if (freq && !FREQS.includes(freq)) throw new CalendarError('That is not a repeat option.', 'repeat');
  const allDay = v.all_day === undefined ? 1 : (v.all_day ? 1 : 0);
  const num = (x) => (x === '' || x == null ? null : Number(x));
  const startMin = allDay ? null : num(v.start_min);
  const endMin = allDay ? null : num(v.end_min);
  if (!allDay && startMin != null && endMin != null && endMin < startMin) {
    throw new CalendarError('It cannot end before it starts.', 'time');
  }
  if (v.rrule_until && !isDate(v.rrule_until)) {
    throw new CalendarError('That end date is not a date.', 'repeat');
  }
  if (v.rrule_until && v.rrule_until < v.starts_on) {
    throw new CalendarError('The repeat ends before it begins.', 'repeat');
  }
  return {
    kind: KINDS.includes(v.kind) ? v.kind : 'event',
    title,
    category: CATEGORIES.includes(v.category) ? v.category : 'Other',
    notes: String(v.notes || '').trim() || null,
    responsible: String(v.responsible || '').trim() || null,
    responsible_kind: v.responsible_kind || null,
    responsible_id: v.responsible_id == null ? null : Number(v.responsible_id),
    starts_on: v.starts_on,
    ends_on: v.ends_on || null,
    all_day: allDay,
    start_min: startMin,
    end_min: endMin,
    rrule_freq: freq,
    rrule_interval: freq ? Math.max(1, Number(v.rrule_interval) || 1) : 1,
    rrule_byday: freq ? (String(v.rrule_byday || '').split(',')
      .map((s) => s.trim().toUpperCase()).filter((s) => DAYS.includes(s)).join(',') || null) : null,
    rrule_bymonthday: freq === 'monthly' && v.rrule_bymonthday != null && v.rrule_bymonthday !== ''
      ? Number(v.rrule_bymonthday) : null,
    rrule_bysetpos: freq === 'monthly' && v.rrule_bysetpos != null && v.rrule_bysetpos !== ''
      ? Number(v.rrule_bysetpos) : null,
    rrule_until: freq ? (v.rrule_until || null) : null,
    rrule_count: freq && v.rrule_count ? Math.max(1, Number(v.rrule_count)) : null,
  };
}

function create(patch) {
  const row = normalise(patch);
  const id = Number(q.insert.run(row).lastInsertRowid);
  if (Array.isArray(patch.reminders)) setReminders(id, patch.reminders);
  return q.byId.get(id);
}

/**
 * Change a series, or one occurrence of it, or the rest of it.
 *
 * scope 'all'      the rule itself changes
 *       'one'      an exception row; the rule is untouched
 *       'future'   a SPLIT: the old series is closed the day before, and a new
 *                  one begins. Not a rewrite — the occurrences that already
 *                  happened keep the shape they actually had, which is the
 *                  whole point of doing it this way rather than editing in
 *                  place and calling the past something it was not.
 */
function update(id, patch, scope = 'all', occursOn = null) {
  const item = q.byId.get(id);
  if (!item) throw new CalendarError('That item is no longer there.', 'missing');

  if (scope === 'one') {
    if (!isDate(occursOn)) throw new CalendarError('Which occurrence?', 'occurrence');
    q.exAdd.run({
      item_id: id,
      occurs_on: occursOn,
      status: 'moved',
      moved_to_date: patch.starts_on && patch.starts_on !== occursOn ? patch.starts_on : null,
      moved_start_min: patch.start_min == null || patch.start_min === '' ? null : Number(patch.start_min),
      moved_end_min: patch.end_min == null || patch.end_min === '' ? null : Number(patch.end_min),
      title_override: patch.title ? String(patch.title).trim() : null,
      notes_override: patch.notes ? String(patch.notes).trim() : null,
    });
    return q.byId.get(id);
  }

  if (scope === 'future') {
    if (!isDate(occursOn)) throw new CalendarError('Which occurrence?', 'occurrence');
    if (!item.rrule_freq) throw new CalendarError('That item does not repeat.', 'repeat');
    let made = null;
    db.transaction(() => {
      q.setUntil.run({ id, until: addDays(occursOn, -1) });
      // Exceptions and completions from the split point belong to the new
      // series, not the old one. Left behind they would apply to dates the old
      // rule can no longer produce.
      q.exDelFrom.run(id, occursOn);
      const row = normalise({ ...patch, starts_on: patch.starts_on || occursOn }, item);
      made = Number(q.insert.run(row).lastInsertRowid);
      for (const r of q.remFor.all(id)) {
        q.remAdd.run({ item_id: made, offset_min: r.offset_min, channel: r.channel });
      }
    })();
    return q.byId.get(made);
  }

  const row = normalise(patch, item);
  q.update.run({ ...row, id });
  if (Array.isArray(patch.reminders)) setReminders(id, patch.reminders);
  return q.byId.get(id);
}

/** scope: 'one' skips an occurrence · 'future' ends the series · 'all' removes it. */
function remove(id, scope = 'all', occursOn = null) {
  const item = q.byId.get(id);
  if (!item) throw new CalendarError('That item is no longer there.', 'missing');
  if (scope === 'one') {
    if (!isDate(occursOn)) throw new CalendarError('Which occurrence?', 'occurrence');
    q.exAdd.run({ item_id: id, occurs_on: occursOn, status: 'skipped',
      moved_to_date: null, moved_start_min: null, moved_end_min: null,
      title_override: null, notes_override: null });
    return { removed: 'occurrence' };
  }
  if (scope === 'future') {
    if (!isDate(occursOn)) throw new CalendarError('Which occurrence?', 'occurrence');
    if (occursOn <= item.starts_on) { q.del.run(id); return { removed: 'series' }; }
    q.setUntil.run({ id, until: addDays(occursOn, -1) });
    q.exDelFrom.run(id, occursOn);
    return { removed: 'future' };
  }
  q.del.run(id);
  return { removed: 'series' };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Record that one occurrence was done.
 *
 * Note what this does NOT do: touch the rule. The old model's "mark done"
 * rewrote next_due, so a task finished five days late had its whole future
 * shifted five days and the cadence drifted a little further every time.
 * Completing the September 1 hood clean on September 5 now leaves December 1
 * exactly where the rule put it.
 */
function complete(itemId, occursOn, by = null, notes = null) {
  const item = q.byId.get(itemId);
  if (!item) throw new CalendarError('That item is no longer there.', 'missing');
  if (item.kind !== 'task') throw new CalendarError('Only a task can be completed.', 'kind');
  if (!isDate(occursOn)) throw new CalendarError('Which occurrence?', 'occurrence');
  q.doneAdd.run({ item_id: itemId, occurs_on: occursOn, completed_by: by, notes });
  return q.doneOn.get(itemId, occursOn);
}

/** Undo by the completion's own id — never by dates handed back through a URL. */
function uncomplete(completionId) {
  const row = q.doneById.get(Number(completionId));
  if (!row) throw new CalendarError('That was already undone.', 'missing');
  q.doneDel.run(row.id);
  return row;
}

/** The answer to "when were the last four hood cleanings". */
const history = (itemId, limit = 20) => q.doneFor.all(itemId).slice(0, limit);

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

// Only offsets a daily sweep can actually honour are offered. The data layer
// stores anything, but a control that cannot fire is a lie, and the sweep that
// would deliver these runs once a day. Sub-day offsets ship when a finer tick
// exists — see docs/ZWIN-CALENDAR-PLAN.md §7.
const REMINDER_OFFSETS = [
  { min: 0, label: 'On the day' },
  { min: 1440, label: '1 day before' },
  { min: 2880, label: '2 days before' },
  { min: 10080, label: '1 week before' },
];

function setReminders(itemId, offsets) {
  db.transaction(() => {
    q.remClear.run(itemId);
    for (const o of [...new Set(offsets.map(Number).filter((n) => Number.isFinite(n) && n >= 0))]) {
      q.remAdd.run({ item_id: itemId, offset_min: o, channel: 'inapp' });
    }
  })();
  return q.remFor.all(itemId);
}
const reminders = (itemId) => q.remFor.all(itemId);

/**
 * Reminders that have come due in a window, as notification intentions.
 *
 * Returns what SHOULD be sent; sending is somebody else's job. Keeping the two
 * apart is what lets this be tested without a push subscription, and what stops
 * a delivery failure from being mistaken for a scheduling bug.
 */
function dueReminders(from, to) {
  const out = [];
  for (const item of q.all.all()) {
    const rem = q.remFor.all(item.id);
    if (!rem.length) continue;
    // Far enough ahead to catch a week-before reminder for a future occurrence.
    for (const o of expand(item, from, addDays(to, 8))) {
      if (o.completed) continue;
      for (const r of rem) {
        const fireOn = addDays(o.date, -Math.floor(r.offset_min / 1440));
        if (fireOn >= from && fireOn <= to) {
          out.push({
            key: `cal:${item.id}:${o.occursOn}:${r.offset_min}`,
            itemId: item.id, title: item.title, category: o.category,
            occursOn: o.occursOn, date: o.date, fireOn, offsetMin: r.offset_min,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migration from m_recurring
// ---------------------------------------------------------------------------

const FREQ_MAP = {
  weekly: { rrule_freq: 'weekly', rrule_interval: 1 },
  monthly: { rrule_freq: 'monthly', rrule_interval: 1 },
  quarterly: { rrule_freq: 'monthly', rrule_interval: 3 },
  annual: { rrule_freq: 'yearly', rrule_interval: 1 },
};

/**
 * Bring the old tracker's rows across, once.
 *
 * Additive and idempotent: it runs only when cal_items is empty, and it does
 * not touch m_recurring. The old table stays readable so a mistake here can be
 * seen rather than argued about; it gets dropped a release later, deliberately.
 *
 * Nothing is invented. Quarterly becomes every 3 months because that is what it
 * meant; last_done becomes ONE completion because that is the only completion
 * the old model could hold. No earlier history is fabricated.
 */
function migrateRecurring() {
  const has = db.prepare('SELECT COUNT(*) n FROM cal_items').get().n;
  if (has) return { migrated: 0, skipped: 'already populated' };
  let old = [];
  try { old = db.prepare('SELECT * FROM m_recurring').all(); }
  catch { return { migrated: 0, skipped: 'no m_recurring table' }; }
  if (!old.length) return { migrated: 0, skipped: 'nothing to migrate' };

  let n = 0;
  db.transaction(() => {
    for (const r of old) {
      const f = FREQ_MAP[String(r.frequency || '').toLowerCase()] || FREQ_MAP.monthly;
      const startsOn = isDate(r.next_due) ? r.next_due
        : (isDate(String(r.created_at || '').slice(0, 10)) ? String(r.created_at).slice(0, 10)
          : isoDate(startOfToday()));
      const id = Number(q.insert.run({
        kind: 'task',
        title: String(r.name || 'Untitled task').trim() || 'Untitled task',
        category: CATEGORIES.includes(r.category) ? r.category : 'Other',
        notes: r.notes || null,
        responsible: r.responsible || null,
        responsible_kind: null,
        responsible_id: null,
        starts_on: startsOn,
        ends_on: null,
        all_day: 1,
        start_min: null,
        end_min: null,
        rrule_freq: f.rrule_freq,
        rrule_interval: f.rrule_interval,
        rrule_byday: null,
        rrule_bymonthday: null,
        rrule_bysetpos: null,
        rrule_until: null,
        rrule_count: null,
      }).lastInsertRowid);
      if (isDate(r.last_done)) {
        q.doneAdd.run({ item_id: id, occurs_on: r.last_done,
          completed_by: null, notes: null });
      }
      n += 1;
    }
  })();
  return { migrated: n };
}

module.exports = {
  create, update, remove,
  complete, uncomplete, history,
  expand, range, datesFor, nextOccurrence,
  statusOf, overdueTasks,
  setReminders, reminders, dueReminders, REMINDER_OFFSETS,
  migrateRecurring,
  q, CATEGORIES, KINDS, FREQS, DAYS, CalendarError,
};
