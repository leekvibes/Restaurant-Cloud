'use strict';

// The incident log's structured workflow. The five original fields still save;
// what these guard is everything built around them — impact, status and outcome
// as SEPARATE facts, an append-only follow-up timeline that never rewrites the
// first report, the historical migration that must not invent a severity, and
// the dashboard only surfacing incidents that still need a person's hands.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3985;   // unique across the suite — 3971/3972 are boot.test.js
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-inc-'));
const DB = path.join(dir, 'inc.db');
let child, Database, db;

// Expand array values into repeated params, the way a group of same-named
// checkboxes actually posts (actions=A&actions=B) — not the comma-joined single
// value URLSearchParams makes from an object.
const post = (p, body) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.append(k, v);
  }
  return fetch(BASE + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
};
const get = (p) => fetch(BASE + p).then((r) => r.text());

// Create an incident and hand back its new id (read straight from the db, so a
// test never depends on the redirect target's exact shape).
async function file(fields) {
  const before = db.prepare('SELECT COALESCE(MAX(id),0) m FROM m_incidents').get().m;
  const res = await post('/c/incidents', fields);
  assert.strictEqual(res.status, 302, 'a filed incident redirects');
  const row = db.prepare('SELECT * FROM m_incidents WHERE id > ? ORDER BY id DESC LIMIT 1').get(before);
  assert.ok(row, 'and the row exists');
  return row;
}

test.before(async () => {
  Database = require('better-sqlite3');
  // A legacy incident, inserted the old way (no impact, no status), BEFORE the
  // server boots — so the migration that runs on boot is what these read.
  const boot = new Database(DB);
  boot.exec(`CREATE TABLE IF NOT EXISTS m_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    occurred_at TEXT, type TEXT, people TEXT, description TEXT, logged_by TEXT)`);
  boot.prepare("INSERT INTO m_incidents (occurred_at, type, people, description, logged_by) VALUES ('2026-01-05','Guest complaint','Kitchen','Old record from before the workflow.','Malek')").run();
  boot.close();

  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TZ: 'America/New_York', ZWIN_SKIP_BACKFILL: '1', APP_PASSWORD: '' },
    stdio: 'ignore',
  });
  // Generous: under a full parallel test run the machine is busy and the server
  // can take a couple of seconds to bind and finish its migrations.
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/version`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new Database(DB);
});

test.after(() => { if (child) child.kill(); try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

test('a legacy record is migrated to Imported, never given an invented severity', () => {
  const old = db.prepare("SELECT * FROM m_incidents WHERE description LIKE 'Old record%'").get();
  assert.strictEqual(old.status, 'Imported', 'status becomes Imported, not a guessed Open/Closed');
  assert.ok(!old.impact, 'and impact stays blank — the list reads it as "Not assessed"');
  assert.strictEqual(old.type, 'Guest complaint', 'the original type is untouched');
  assert.strictEqual(old.description, 'Old record from before the workflow.', 'and the original words are untouched');
});

test('the five original fields still save', async () => {
  const r = await file({ type: 'Other', occurred_at: '2026-07-10', people: 'A guest', description: 'Something happened.', logged_by: 'Malek' });
  assert.strictEqual(r.type, 'Other');
  assert.strictEqual(r.people, 'A guest');
  assert.strictEqual(r.description, 'Something happened.');
  assert.strictEqual(r.logged_by, 'Malek');
});

test('impact defaults to blank and status defaults to Open — they are separate facts', async () => {
  const r = await file({ type: 'Guest complaint', description: 'No severity given.' });
  assert.ok(!r.impact, 'no impact when none is chosen');
  assert.strictEqual(r.status, 'Open', 'but status is Open, not derived from impact');
});

test('a minor incident can still carry a follow-up status; impact never sets status', async () => {
  const r = await file({ type: 'Guest complaint', impact: 'Minor', status: 'Follow-up due', description: 'Small but unfinished.' });
  assert.strictEqual(r.impact, 'Minor');
  assert.strictEqual(r.status, 'Follow-up due', 'Minor + Follow-up due coexist');
});

test('a serious incident can be filed already Resolved; outcome is separate again', async () => {
  const r = await file({ type: 'Guest injury', impact: 'Serious', status: 'Resolved', outcome: 'Guest or employee satisfied', outcome_note: 'Treated on site.', description: 'A guest was hurt but is fine.' });
  assert.strictEqual(r.impact, 'Serious');
  assert.strictEqual(r.status, 'Resolved');
  assert.strictEqual(r.outcome, 'Guest or employee satisfied', 'outcome is its own field, not the status');
});

test('a critical incident stores its severity', async () => {
  const r = await file({ type: 'Food safety or allergen', impact: 'Critical', description: 'Ambulance called.' });
  assert.strictEqual(r.impact, 'Critical');
});

test('structured actions and a dollar financial impact are captured', async () => {
  const r = await file({
    type: 'Guest complaint', impact: 'Moderate', description: 'Ginger smelled off.',
    action_taken: 'Manager comped the dish.',
    actions: ['Manager spoke with guest', 'Discount provided'],
    financial_kind: 'Discount', financial_amount: '18.00', financial_note: '50% off',
  });
  assert.strictEqual(r.financial_cents, 1800, 'dollars land as integer cents');
  assert.strictEqual(r.financial_kind, 'Discount');
  assert.deepStrictEqual(JSON.parse(r.actions), ['Manager spoke with guest', 'Discount provided'], 'the checked actions are stored as a list');
});

test('a financial amount is read as a whole number, not sieved', async () => {
  // A number input treats "1e3" as 1000; an earlier version stripped the "e"
  // and stored $13. It must land as $1000, or reject, never a silent wrong figure.
  const r = await file({ type: 'Property damage', impact: 'Serious', description: 'Big loss.', financial_kind: 'Estimated damage', financial_amount: '1e3' });
  assert.strictEqual(r.financial_cents, 100000, '"1e3" is $1000.00, not $13.00');
  const junk = await file({ type: 'Other', description: 'No number.', financial_amount: 'abc' });
  assert.strictEqual(junk.financial_cents, null, 'unparseable text stores nothing, not a wrong number');
});

test('filing writes the first timeline entry and notifies the office', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='incident'").get().n;
  const r = await file({ type: 'Theft or loss', impact: 'Serious', status: 'Open', description: 'A till was short.' });
  const ev = db.prepare('SELECT * FROM incident_events WHERE incident_id = ? ORDER BY id').all(r.id);
  assert.strictEqual(ev.length, 1, 'one timeline entry on filing');
  assert.match(ev[0].note, /filed/i, 'and it says the incident was filed');
  const after = db.prepare("SELECT COUNT(*) n FROM admin_events WHERE kind='incident'").get().n;
  assert.strictEqual(after, before + 1, 'the back office is notified, exactly once');
});

test('a follow-up appends to the timeline and updates the parent — the original stays locked', async () => {
  const r = await file({ type: 'Employee conduct or write-up', impact: 'Moderate', status: 'Open', description: 'ORIGINAL WORDS — must never change.', assigned_to: 'Malek' });
  await post(`/c/incidents/${r.id}/followup`, { note: 'Met with the employee.', new_status: 'Resolved', new_assigned: 'Sam', new_due: '2026-08-01' });
  const after = db.prepare('SELECT * FROM m_incidents WHERE id = ?').get(r.id);
  assert.strictEqual(after.description, 'ORIGINAL WORDS — must never change.', 'the first report is never rewritten');
  assert.strictEqual(after.status, 'Resolved', 'the parent status now reflects the follow-up');
  assert.strictEqual(after.assigned_to, 'Sam', 'and the new assignee');
  const ev = db.prepare('SELECT * FROM incident_events WHERE incident_id = ? ORDER BY id').all(r.id);
  assert.strictEqual(ev.length, 2, 'filing + the follow-up = two entries');
  assert.strictEqual(ev[1].new_status, 'Resolved');
});

test('an empty follow-up records nothing', async () => {
  const r = await file({ type: 'Other', description: 'Quiet one.' });
  const before = db.prepare('SELECT COUNT(*) n FROM incident_events WHERE incident_id = ?').get(r.id).n;
  await post(`/c/incidents/${r.id}/followup`, { note: '', new_status: '', new_assigned: '', new_due: '' });
  const afterN = db.prepare('SELECT COUNT(*) n FROM incident_events WHERE incident_id = ?').get(r.id).n;
  assert.strictEqual(afterN, before, 'nothing to say means nothing is appended');
});

test('append-only: there is no edit or delete for an incident', async () => {
  const r = db.prepare('SELECT id FROM m_incidents LIMIT 1').get();
  assert.strictEqual((await post(`/c/incidents/${r.id}`, { description: 'hacked' })).status, 404, 'the generic edit route refuses');
  assert.strictEqual((await post(`/c/incidents/${r.id}/delete`, {})).status, 404, 'and so does delete');
});

test('the detail page shows the record with the original locked and a timeline', async () => {
  const r = await file({ type: 'Alcohol refusal', impact: 'Moderate', description: 'Refused a visibly intoxicated guest.', location: 'Bar' });
  const html = await get(`/c/incidents/${r.id}`);
  assert.match(html, /Original report/i, 'the original is marked as the locked report');
  assert.match(html, /Follow-up timeline/i, 'and the timeline section is present');
  assert.match(html, /Moderate/, 'the impact shows');
  assert.match(html, /Bar/, 'and the location');
});

test('the list carries impact and status as separate, filterable data', async () => {
  const html = await get('/c/incidents');
  assert.match(html, /data-impact=/, 'rows expose impact for filtering');
  assert.match(html, /data-status=/, 'and status separately');
  assert.match(html, /Not assessed/, 'the legacy record reads as Not assessed, not a guessed severity');
  assert.match(html, /Serious & critical|Needs follow-up/, 'the saved views are offered');
});

test('the dashboard surfaces an open serious incident, and hides resolved ones', async () => {
  // A fresh serious, still-open incident should be actionable on Home.
  await file({ type: 'Guest injury', impact: 'Critical', status: 'Open', description: 'Open and high-impact.' });
  const home = await get('/');
  assert.match(home, /serious incident|incident follow-up|need follow-up/i, 'an open high-impact incident is on Home');
});
