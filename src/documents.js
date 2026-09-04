'use strict';

// Documents: what people are given to read, and the record that they did.
//
// THE ONE IDEA THIS FILE IS BUILT ON is that those are two different things and
// must never be stored as one.
//
//   WHO CAN SEE IT is a question about right now. It is computed, every time,
//   from live assignments and live group membership. Move somebody out of
//   Servers and the server documents leave their portal the same day.
//
//   WHO SIGNED WHAT is a question about the past. It is written down once,
//   against an exact version, and nothing afterwards may touch it — not moving
//   groups, not a new version, not archiving the document, not deactivating the
//   employee. It is evidence.
//
// Every table below sits on one side of that line, and the line is why there is
// no `assigned_employees` table: a snapshot of who was assigned in March would
// answer the first question with the second question's data, and be quietly
// wrong from the day anybody changed teams.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { db } = require('./db');

// Beside the invoice uploads, not inside them. Same disk and the same Render
// mount so it survives a redeploy, but its own directory — these are corrective
// actions and employment agreements, and they should not be one path-traversal
// bug away from a vendor's photographed receipt.
const DOC_DIR = process.env.DOC_DIR
  || path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'documents');
try { fs.mkdirSync(DOC_DIR, { recursive: true }); } catch { /* exists, or read-only in a test */ }

db.exec(`
CREATE TABLE IF NOT EXISTS doc_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Membership is a row, not a column, because somebody is a Server AND front of
-- house AND on the training team, and a column would make that a fight.
CREATE TABLE IF NOT EXISTS doc_group_members (
  group_id    INTEGER NOT NULL REFERENCES doc_groups(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, employee_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT,
  category     TEXT NOT NULL DEFAULT 'other',
  -- 'reference' | 'sign'. Not a boolean: a third behaviour is coming (a quiz, a
  -- countersignature, a read receipt with a deadline) and widening an enum is a
  -- migration nobody notices, while widening a boolean is a rename.
  kind         TEXT NOT NULL DEFAULT 'reference',
  allow_download INTEGER NOT NULL DEFAULT 1,
  ack_text     TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  archived_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   TEXT
);

-- A version is a FILE. Uploading a new one never touches the old row, because
-- somebody signed that exact file and the signature is a claim about its
-- contents.
CREATE TABLE IF NOT EXISTS doc_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,
  stored_name TEXT NOT NULL,            -- on disk; never shown, never guessable
  orig_name   TEXT,                     -- what they uploaded, for the download name
  mime        TEXT NOT NULL DEFAULT 'application/pdf',
  bytes       INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT,                     -- what was signed, provable later
  pages       INTEGER,
  effective_on TEXT,
  due_on      TEXT,
  -- Exactly one version of a document is current. Enforced by an index below
  -- rather than by remembering to clear the flag.
  is_current  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_one_current
  ON doc_versions (document_id) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_doc_versions ON doc_versions (document_id, id DESC);

-- WHO CAN SEE IT. Live, and only ever live.
--   target 'all'      -> everyone active
--   target 'group'    -> target_id is a doc_groups.id
--   target 'employee' -> target_id is an employees.id
CREATE TABLE IF NOT EXISTS doc_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target      TEXT NOT NULL,
  target_id   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_assign_once
  ON doc_assignments (document_id, target, COALESCE(target_id, -1));

-- WHO SIGNED WHAT. The other side of the line.
--
-- Keyed on the VERSION, not the document, so a new version is a new obligation
-- and an old signature can never be dragged forward onto a file its signer
-- never saw. employee_name is copied in deliberately: it is who signed, as they
-- were called that day, and renaming somebody later must not rewrite history.
CREATE TABLE IF NOT EXISTS doc_signatures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id    INTEGER NOT NULL REFERENCES doc_versions(id),
  document_id   INTEGER NOT NULL REFERENCES documents(id),
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  employee_name TEXT NOT NULL,
  ack_text      TEXT NOT NULL,
  signed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  method        TEXT NOT NULL DEFAULT 'typed',   -- room for 'drawn' later
  ip            TEXT,
  user_agent    TEXT,
  voided_at     TEXT,                            -- corrected by adding, never by editing
  voided_by     TEXT,
  void_reason   TEXT
);
-- ONE signature per person per version. This is the idempotency: a double tap
-- on a slow phone raises a constraint rather than filing twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_sig_once
  ON doc_signatures (version_id, employee_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_doc_sig_emp ON doc_signatures (employee_id, signed_at DESC);

-- Opened, and how far. Operational, not evidential — it says somebody put the
-- document on their screen, which is not the same as having read it, and the
-- app should never claim otherwise.
CREATE TABLE IF NOT EXISTS doc_views (
  version_id  INTEGER NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  first_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_page   INTEGER NOT NULL DEFAULT 1,
  pages_seen  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (version_id, employee_id)
);
-- WHERE THE SIGNATURE GOES, on the page.
--
-- Keyed on the VERSION, not the document, for the same reason signatures are:
-- a field describes a spot on a specific file, and the next version is a
-- different file whose "Employee signature:" line may be two inches lower. A
-- new version starts with no fields and is given its own, optionally copied
-- from the last one — which is a starting point, not an inheritance.
--
-- COORDINATES ARE FRACTIONS OF THE PAGE, 0 to 1. Never pixels: the same field
-- has to land in the same place on a 390px iPhone, a 1400px desktop and a
-- rotated tablet, and a pixel is a statement about one of those.
CREATE TABLE IF NOT EXISTS doc_fields (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- 'signature' | 'date'; more later
  page        INTEGER NOT NULL DEFAULT 1,
  x           REAL NOT NULL,              -- 0..1 across the page
  y           REAL NOT NULL,              -- 0..1 down the page
  w           REAL NOT NULL DEFAULT 0.34,
  h           REAL NOT NULL DEFAULT 0.055,
  required    INTEGER NOT NULL DEFAULT 1,
  label       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_doc_fields ON doc_fields (version_id, page, sort);

-- WHAT THEY PUT IN IT. Written at submit, inside the same transaction as the
-- signature, and never updated afterwards — the value, the field it was in and
-- the version it belonged to are one indivisible fact about a moment.
CREATE TABLE IF NOT EXISTS doc_field_values (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  field_id     INTEGER NOT NULL REFERENCES doc_fields(id),
  signature_id INTEGER REFERENCES doc_signatures(id) ON DELETE CASCADE,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  value        TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_fv_once ON doc_field_values (field_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_doc_fv_sig ON doc_field_values (signature_id);
`);

const CATEGORIES = [
  ['handbook', 'Handbook'], ['policy', 'Policy'], ['cleaning', 'Cleaning & duties'],
  ['training', 'Training'], ['standards', 'Position standards'], ['sop', 'SOP'],
  ['hr', 'HR'], ['safety', 'Safety'], ['other', 'Other'],
];
const catName = (k) => (CATEGORIES.find(([v]) => v === k) || [k, k])[1];
const DEFAULT_ACK = 'I acknowledge that I have reviewed and understand this document.';


// --- groups ----------------------------------------------------------------

const groups = {
  all: (opts = {}) => db.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM doc_group_members m JOIN employees e ON e.id = m.employee_id
        WHERE m.group_id = g.id AND e.active = 1) AS members
     FROM doc_groups g ${opts.includeArchived ? '' : 'WHERE g.active = 1'}
     ORDER BY g.active DESC, g.name`).all(),
  get: (id) => db.prepare('SELECT * FROM doc_groups WHERE id = ?').get(id) || null,
  create: (name) => {
    const n = String(name || '').trim();
    if (!n) throw new Error('A group needs a name.');
    return Number(db.prepare('INSERT INTO doc_groups (name) VALUES (?)').run(n).lastInsertRowid);
  },
  rename: (id, name) => {
    const n = String(name || '').trim();
    if (!n) throw new Error('A group needs a name.');
    db.prepare('UPDATE doc_groups SET name = ? WHERE id = ?').run(n, id);
  },
  archive: (id) => db.prepare('UPDATE doc_groups SET active = 0 WHERE id = ?').run(id),
  restore: (id) => db.prepare('UPDATE doc_groups SET active = 1 WHERE id = ?').run(id),
  members: (id) => db.prepare(`SELECT e.id, e.name FROM doc_group_members m
      JOIN employees e ON e.id = m.employee_id
     WHERE m.group_id = ? AND e.active = 1 ORDER BY e.name`).all(id),
  memberIds: (id) => db.prepare('SELECT employee_id FROM doc_group_members WHERE group_id = ?')
    .all(id).map((r) => r.employee_id),
  forEmployee: (empId) => db.prepare(`SELECT g.id, g.name FROM doc_group_members m
      JOIN doc_groups g ON g.id = m.group_id
     WHERE m.employee_id = ? AND g.active = 1 ORDER BY g.name`).all(empId),
  /**
   * Set a group's whole roster.
   *
   * Scoped to the GROUP and looping over people — the mirror of the mistake
   * that would be easy here, which is looping over groups for one person and
   * quietly removing them from every other one they belong to.
   */
  setMembers: (id, employeeIds) => {
    const want = new Set((employeeIds || []).map(Number).filter(Boolean));
    const have = new Set(db.prepare('SELECT employee_id FROM doc_group_members WHERE group_id = ?')
      .all(id).map((r) => r.employee_id));
    const add = db.prepare('INSERT OR IGNORE INTO doc_group_members (group_id, employee_id) VALUES (?, ?)');
    const del = db.prepare('DELETE FROM doc_group_members WHERE group_id = ? AND employee_id = ?');
    db.transaction(() => {
      for (const e of want) if (!have.has(e)) add.run(id, e);
      for (const e of have) if (!want.has(e)) del.run(id, e);
    })();
  },
};

// --- documents and versions -------------------------------------------------

const currentVersion = (docId) => db.prepare(
  'SELECT * FROM doc_versions WHERE document_id = ? AND is_current = 1').get(docId) || null;
const versionById = (id) => db.prepare('SELECT * FROM doc_versions WHERE id = ?').get(id) || null;
const versionsOf = (docId) => db.prepare(
  'SELECT * FROM doc_versions WHERE document_id = ? ORDER BY id DESC').all(docId);
const byId = (id) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id) || null;

/**
 * Add a version and make it current.
 *
 * `is_current` is cleared inside the same transaction as the insert, because a
 * partial unique index means the database itself refuses two current versions —
 * which is the point. Getting this wrong would not corrupt anything, it would
 * throw, which is the failure mode worth having.
 */
function addVersion(docId, v) {
  return db.transaction(() => {
    db.prepare('UPDATE doc_versions SET is_current = 0 WHERE document_id = ?').run(docId);
    return Number(db.prepare(`INSERT INTO doc_versions
      (document_id, version, stored_name, orig_name, mime, bytes, sha256, pages,
       effective_on, due_on, is_current, created_by)
      VALUES (@document_id, @version, @stored_name, @orig_name, @mime, @bytes, @sha256, @pages,
              @effective_on, @due_on, 1, @created_by)`)
      .run({ document_id: docId, pages: null, effective_on: null, due_on: null,
        orig_name: null, sha256: null, created_by: null, mime: 'application/pdf', bytes: 0, ...v })
      .lastInsertRowid);
  })();
}

// --- WHO CAN SEE IT ---------------------------------------------------------

/**
 * The access rule, in one place, used by every route that serves a document or
 * a file. Written once precisely so that "can this person open this?" has
 * exactly one answer and no page can accidentally disagree with another.
 *
 * An archived document is not visible to employees at all — but a signature
 * against it survives, and the completed record stays openable, because that is
 * evidence rather than access.
 */
const assignmentsFor = (docId) => db.prepare(
  'SELECT * FROM doc_assignments WHERE document_id = ?').all(docId);

function canEmployeeSee(docId, empId) {
  const doc = byId(docId);
  if (!doc || !doc.active) return false;
  return db.prepare(`SELECT 1 FROM doc_assignments a
     WHERE a.document_id = @doc
       AND ( a.target = 'all'
          OR (a.target = 'employee' AND a.target_id = @emp)
          OR (a.target = 'group' AND EXISTS (
                SELECT 1 FROM doc_group_members m
                  JOIN doc_groups g ON g.id = m.group_id
                 WHERE m.group_id = a.target_id AND m.employee_id = @emp AND g.active = 1)))
     LIMIT 1`).get({ doc: docId, emp: empId }) ? true : false;
}

/** Everyone a document currently reaches. The same rule, from the other end. */
function audienceOf(docId) {
  return db.prepare(`SELECT DISTINCT e.id, e.name FROM employees e
     WHERE e.active = 1 AND EXISTS (
       SELECT 1 FROM doc_assignments a
        WHERE a.document_id = @doc
          AND ( a.target = 'all'
             OR (a.target = 'employee' AND a.target_id = e.id)
             OR (a.target = 'group' AND EXISTS (
                   SELECT 1 FROM doc_group_members m
                     JOIN doc_groups g ON g.id = m.group_id
                    WHERE m.group_id = a.target_id AND m.employee_id = e.id AND g.active = 1))))
     ORDER BY e.name`).all({ doc: docId });
}

/** Every document this employee can currently open, newest obligation first. */
function forEmployee(empId) {
  const rows = db.prepare(`SELECT d.*, v.id AS version_id, v.version, v.due_on, v.pages,
        v.mime, v.orig_name
     FROM documents d
     JOIN doc_versions v ON v.document_id = d.id AND v.is_current = 1
    WHERE d.active = 1
      AND EXISTS (SELECT 1 FROM doc_assignments a
                   WHERE a.document_id = d.id
                     AND ( a.target = 'all'
                        OR (a.target = 'employee' AND a.target_id = @emp)
                        OR (a.target = 'group' AND EXISTS (
                              SELECT 1 FROM doc_group_members m
                                JOIN doc_groups g ON g.id = m.group_id
                               WHERE m.group_id = a.target_id AND m.employee_id = @emp
                                 AND g.active = 1))))
    ORDER BY d.title`).all({ emp: empId });
  const sig = db.prepare(`SELECT * FROM doc_signatures
     WHERE version_id = ? AND employee_id = ? AND voided_at IS NULL`);
  const view = db.prepare('SELECT * FROM doc_views WHERE version_id = ? AND employee_id = ?');
  return rows.map((r) => ({
    ...r,
    signature: sig.get(r.version_id, empId) || null,
    view: view.get(r.version_id, empId) || null,
  }));
}

// --- WHO SIGNED WHAT --------------------------------------------------------

/**
 * File a signature. Idempotent by construction.
 *
 * A slow phone and an impatient thumb send this twice. The unique index refuses
 * the second, and rather than surfacing a constraint error to somebody who has
 * done nothing wrong, the existing signature is returned — they signed once,
 * they see the confirmation, and there is one record.
 */
function sign({ versionId, employeeId, employeeName, ackText, ip, userAgent, values }) {
  const v = versionById(versionId);
  if (!v) throw new Error('No such document version.');
  const existing = db.prepare(`SELECT * FROM doc_signatures
     WHERE version_id = ? AND employee_id = ? AND voided_at IS NULL`).get(versionId, employeeId);
  if (existing) return { signature: existing, fresh: false };
  try {
    // ONE TRANSACTION. The signature and the values that appear inside the
    // document are the same fact — a signature with no rendered name, or a name
    // sitting in a field with no signature behind it, is a record that says
    // something nobody did.
    const id = db.transaction(() => {
      const sid = Number(db.prepare(`INSERT INTO doc_signatures
        (version_id, document_id, employee_id, employee_name, ack_text, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(versionId, v.document_id, employeeId, employeeName, ackText,
          ip || null, userAgent || null).lastInsertRowid);
      const put = db.prepare(`INSERT INTO doc_field_values
        (field_id, signature_id, employee_id, value) VALUES (?, ?, ?, ?)`);
      for (const f of fieldsFor(versionId)) {
        // The date is the SERVER's, taken from the signature row that was just
        // written, so what the document shows and what the audit says are the
        // same timestamp rather than two readings of two clocks.
        const val = f.kind === 'date' ? null : (values && values[String(f.id)]);
        if (f.kind === 'date') put.run(f.id, sid, employeeId, '@signed');
        else if (val != null && String(val).trim()) put.run(f.id, sid, employeeId, String(val).trim());
      }
      return sid;
    })();
    return { signature: db.prepare('SELECT * FROM doc_signatures WHERE id = ?').get(id), fresh: true };
  } catch (e) {
    // Two requests raced past the SELECT. The index held; return the winner.
    const now = db.prepare(`SELECT * FROM doc_signatures
       WHERE version_id = ? AND employee_id = ? AND voided_at IS NULL`).get(versionId, employeeId);
    if (now) return { signature: now, fresh: false };
    throw e;
  }
}

const signaturesFor = (docId) => db.prepare(`SELECT s.*, v.version FROM doc_signatures s
   JOIN doc_versions v ON v.id = s.version_id
  WHERE s.document_id = ? ORDER BY s.signed_at DESC`).all(docId);

const signaturesForEmployee = (empId) => db.prepare(`SELECT s.*, v.version, d.title, d.category
   FROM doc_signatures s
   JOIN doc_versions v ON v.id = s.version_id
   JOIN documents d ON d.id = s.document_id
  WHERE s.employee_id = ? ORDER BY s.signed_at DESC`).all(empId);

/** Opened. Recorded on the version, so progress does not survive a new file. */
function noteView(versionId, employeeId, page, pages) {
  const p = Math.max(1, Number(page) || 1);
  db.prepare(`INSERT INTO doc_views (version_id, employee_id, last_page, pages_seen)
    VALUES (@v, @e, @p, @p)
    ON CONFLICT(version_id, employee_id) DO UPDATE SET
      last_at = datetime('now'),
      last_page = @p,
      pages_seen = MAX(pages_seen, @p)`).run({ v: versionId, e: employeeId, p });
  if (pages) db.prepare('UPDATE doc_versions SET pages = ? WHERE id = ? AND pages IS NULL')
    .run(Number(pages) || null, versionId);
}

/**
 * Where a document stands, for the admin list.
 *
 * Counted against the CURRENT version only: a handbook whose version 2 nobody
 * has signed yet is 0 of 21 complete, however many signed version 1. That is
 * the honest number, and the reason versions exist.
 */
function statsFor(docId) {
  const v = currentVersion(docId);
  const audience = audienceOf(docId);
  const ids = new Set(audience.map((a) => a.id));
  if (!v) return { assigned: audience.length, signed: 0, viewed: 0, pending: audience.length, overdue: 0, version: null };
  const signed = db.prepare(`SELECT employee_id FROM doc_signatures
     WHERE version_id = ? AND voided_at IS NULL`).all(v.id)
    .map((r) => r.employee_id).filter((e) => ids.has(e));
  const viewed = db.prepare('SELECT employee_id FROM doc_views WHERE version_id = ?').all(v.id)
    .map((r) => r.employee_id).filter((e) => ids.has(e));
  const signedSet = new Set(signed);
  const pending = audience.length - signedSet.size;
  const overdue = v.due_on && v.due_on < new Date().toISOString().slice(0, 10) ? pending : 0;
  return { assigned: audience.length, signed: signedSet.size,
    viewed: new Set(viewed).size, pending, overdue, version: v };
}

// --- fields on a page -------------------------------------------------------

const FIELD_KINDS = ['signature', 'date'];
const fieldsFor = (versionId) => db.prepare(
  'SELECT * FROM doc_fields WHERE version_id = ? ORDER BY page, sort, id').all(versionId);

/** Clamped on the way in. A field cannot be placed off its own page. */
function addField(versionId, f) {
  const kind = FIELD_KINDS.includes(f.kind) ? f.kind : 'signature';
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  const w = num(f.w, kind === 'date' ? 0.22 : 0.34, 0.04, 1);
  const h = num(f.h, 0.055, 0.015, 0.5);
  return Number(db.prepare(`INSERT INTO doc_fields
    (version_id, kind, page, x, y, w, h, required, label, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(versionId, kind, Math.max(1, Math.round(Number(f.page) || 1)),
      num(f.x, 0.1, 0, 1 - w), num(f.y, 0.8, 0, 1 - h), w, h,
      f.required === false ? 0 : 1,
      f.label || (kind === 'date' ? 'Date' : 'Signature'),
      Number(f.sort) || 0).lastInsertRowid);
}

/**
 * Move or resize a field — but ONLY while nothing has been signed against it.
 *
 * This is the rule that stops history being rewritten by dragging: once one
 * person has signed this version, its fields describe where their signature
 * actually sits, and moving the box would move their signature with it. The
 * answer to "the field is in the wrong place" after a signature exists is a new
 * version, which is a new obligation and leaves the old record standing.
 */
function fieldLocked(versionId) {
  return !!db.prepare(`SELECT 1 FROM doc_signatures
     WHERE version_id = ? AND voided_at IS NULL LIMIT 1`).get(versionId);
}
function moveField(id, f) {
  const row = db.prepare('SELECT * FROM doc_fields WHERE id = ?').get(id);
  if (!row) return false;
  if (fieldLocked(row.version_id)) return false;
  const num = (v, d, lo, hi) => {
    const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  const w = num(f.w, row.w, 0.04, 1);
  const h = num(f.h, row.h, 0.015, 0.5);
  db.prepare('UPDATE doc_fields SET page = ?, x = ?, y = ?, w = ?, h = ? WHERE id = ?')
    .run(Math.max(1, Math.round(Number(f.page) || row.page)),
      num(f.x, row.x, 0, 1 - w), num(f.y, row.y, 0, 1 - h), w, h, id);
  return true;
}
function removeField(id) {
  const row = db.prepare('SELECT * FROM doc_fields WHERE id = ?').get(id);
  if (!row || fieldLocked(row.version_id)) return false;
  db.prepare('DELETE FROM doc_fields WHERE id = ?').run(id);
  return true;
}

/** Start a new version from the last one's layout, when the pages line up. */
function copyFields(fromVersionId, toVersionId) {
  const rows = fieldsFor(fromVersionId);
  const ins = db.prepare(`INSERT INTO doc_fields
    (version_id, kind, page, x, y, w, h, required, label, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const f of rows) ins.run(toVersionId, f.kind, f.page, f.x, f.y, f.w, f.h, f.required, f.label, f.sort);
  })();
  return rows.length;
}

/** What one person has put into this version's fields. */
const valuesFor = (versionId, employeeId) => db.prepare(`SELECT v.* FROM doc_field_values v
   JOIN doc_fields f ON f.id = v.field_id
  WHERE f.version_id = ? AND v.employee_id = ?`).all(versionId, employeeId);

/**
 * HAS THIS PERSON ACTUALLY BEEN THROUGH IT?
 *
 * Answered from doc_views, which the viewer posts as pages come into sight, and
 * read HERE at submit time — the client can decorate its own buttons however it
 * likes, and this is the sentence that decides. Nothing in the request says
 * whether the document was read.
 *
 * Deliberately forgiving: the last page mostly-reached counts, because a footer
 * two pixels below the fold is not a compliance question. What it will not
 * accept is a document that was opened and never moved.
 */
function reviewComplete(versionId, employeeId) {
  const v = db.prepare('SELECT pages FROM doc_versions WHERE id = ?').get(versionId);
  const seen = db.prepare('SELECT pages_seen FROM doc_views WHERE version_id = ? AND employee_id = ?')
    .get(versionId, employeeId);
  if (!seen) return false;
  // Page count is learned from the renderer on first open. Until it is known,
  // any real movement through the document counts — refusing everybody because
  // the server has not been told how long the file is would be worse.
  const total = Number(v && v.pages) || 0;
  if (!total) return Number(seen.pages_seen) >= 1;
  return Number(seen.pages_seen) >= total;
}

/**
 * What a field shows, once signed.
 *
 * A date is stored as the sentinel '@signed' rather than as text, so the date
 * printed in the document is derived from the signature's own timestamp every
 * time it is rendered. Storing a formatted string would let the two drift the
 * first time anybody changed how dates are shown — and a document whose visible
 * date disagrees with its audit trail is worse than one with no date at all.
 */
function renderValue(field, value, signature, tz) {
  if (!value) return '';
  if (field.kind === 'date' || value === '@signed') {
    const at = signature && signature.signed_at;
    if (!at) return '';
    const d = new Date(String(at).replace(' ', 'T') + 'Z');
    try {
      return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric',
        timeZone: tz || 'America/New_York' }).format(d);
    } catch { return String(at).slice(0, 10); }
  }
  return String(value);
}

module.exports = { DOC_DIR, CATEGORIES, catName, DEFAULT_ACK, renderValue,
  FIELD_KINDS, fieldsFor, addField, moveField, removeField, copyFields,
  fieldLocked, valuesFor, reviewComplete,
  // The routes hash and write the uploaded bytes; handing them the same node
  // built-ins this file already loaded keeps one idea of where documents live.
  crypto, fs, path,
  groups, byId, currentVersion, versionById, versionsOf, addVersion,
  assignmentsFor, canEmployeeSee, audienceOf, forEmployee,
  sign, signaturesFor, signaturesForEmployee, noteView, statsFor };

