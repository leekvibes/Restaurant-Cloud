# Zwin Time Clock and Timesheet Audit

Audit date: July 29, 2026
Scope: read-only audit of the Time Clock and Timesheet feature across the employee portal and owner/admin side.

## 1. Executive summary

The Time Clock and Timesheet system is in much better shape than a normal early-stage ops product. The core model is coherent, the important state changes are mostly audited, the shift-linking logic is thoughtful, and the test coverage is unusually strong for a feature this wide.

Based on the code and tests reviewed, the feature is **safe after specific fixes**.

Why that rating:

- The core workflow is solid enough for real use now: punch in/out, breaks, corrections, timesheet submission, approval, reopening, and payroll-transfer snapshots are all implemented and heavily tested.
- I did **not** find a major data-integrity bug in the main timekeeping flow.
- I **did** find a few production-readiness gaps that should be addressed before treating this as a hardened long-term payroll-grade system, especially PIN brute-force protection, overtime scope, and a few places where protection lives in application logic rather than the database.

## 2. Overall readiness assessment

Readiness by area:

- Employee portal: Strong
- Admin live Time Clock: Strong
- Admin Timesheets workspace: Strong
- Shift/tip integration: Strong
- Audit history: Strong
- Permissions and route gating: Strong
- Database hardening: Good, but not complete
- Payroll/legal compliance depth: Partial
- Security hardening: Good, but not complete

Final rating: **Safe after specific fixes**

## 3. Architecture map

Confirmed implementation map:

- Core time-clock logic: `src/timeclock.js`
- Pay-period logic: `src/periods.js`
- Overtime rule engine: `src/overtime.js`
- Main routes and UI rendering: `src/server.js`
- Portal behavior helpers: `src/portal.js`
- Permission and nav-area mapping: `src/nav.js`
- Database helpers and shift/work writers: `src/db.js`

Confirmed database tables used by this feature:

- `time_entries`
- `time_breaks`
- `time_corrections`
- `time_events`
- `timesheets`
- `timesheet_approvals`
- `payroll_transfers`
- `settings`
- `employees`
- `employee_roles`
- `shifts`
- `work`
- `server_sales`

Confirmed route groups:

- Employee portal
  - `/tips/start`
  - `/portal`
  - `/portal/clock`
  - `/portal/clock/in`
  - `/portal/clock/out`
  - `/portal/clock/break/start`
  - `/portal/clock/break/end`
  - `/portal/clock/entry/:id`
  - `/portal/clock/fix`
  - `/portal/clock/history`
  - `/portal/timesheet`
  - `/portal/timesheet/day/:date`
  - `/portal/timesheet/submit`
- Owner/admin
  - `/timeclock`
  - `/timeclock/settings`
  - `/timeclock/new`
  - `/timeclock/:id`
  - `/timeclock/:id/edit`
  - `/timeclock/:id/break`
  - `/timeclock/break/:bid/delete`
  - `/timeclock/:id/delete`
  - `/timeclock/correction/:id`
  - `/payroll/timesheets`
  - `/payroll/timesheets/:empId`
  - `/payroll/timesheets/:empId/approve`
  - `/payroll/timesheets/approve-all`
  - `/payroll/timesheets/:empId/return`
  - `/payroll/timesheets/:empId/lock`
  - `/payroll/timesheets/:empId/reopen`
  - `/payroll/timesheets/:empId/transfer`

Confirmed core design rules:

- Server timestamps are authoritative.
- Raw punches are preserved through audit events.
- Shift hours are derived from time entries unless a manager explicitly overrides them.
- Timesheets do not duplicate punches; they summarize them.
- Approval and payroll transfer are separate recorded facts.

## 4. Employee portal findings

Verified:

- One-position employees clock in without being asked to choose.
- Multi-position employees must choose from their assigned positions only.
- Employees with no valid position are blocked from clock-in with an explanation.
- Clock-in and clock-out use server-side timestamps.
- Duplicate active entries are blocked by a partial unique index.
- Open unpaid breaks are deducted from live payable time.
- Business-date cutoff logic is implemented for overnight work.
- Employees can review current and historical entries.
- Timesheets can be submitted once per finished pay period.
- Returned and changed-after-submission periods correctly require resubmission.
- Correction requests preserve the original punch and apply automatically only after approval.
- Rejected corrections do not alter punches.

Behavior quality:

- Portal flow is operator-friendly and state-aware.
- Keepalive ping reduces timeout problems during long shifts.
- Staff isolation is enforced on entry/detail routes.

## 5. Owner/admin findings

Verified:

- The Today page distinguishes active work, on-break work, and historical missing-punch issues.
- Elapsed and payable-so-far logic is anchored to server time.
- Manager actions for add/edit/delete/break/correction review are implemented and audited.
- Timesheets support period navigation, custom read-only ranges, grid totals, filters, detail overlays, approval, return, lock, reopen, and payroll transfer.
- Custom date ranges are prevented from creating or mutating official timesheet records by start-date collision.

Behavior quality:

- The Timesheets workspace is unusually strong for an internal ops app.
- Overlay detail and fragment loading preserve review context well.

## 6. Permissions and locking findings

Verified:

- Time Clock and Timesheets are gated separately.
- Staff-only editors do not automatically get payroll authority.
- Payroll reviewers can open the source punch that blocks a timesheet.
- Viewer accounts remain read-only on both page and mutation routes.
- Alternate route capitalization is tested and blocked.
- Hidden UI is not the only protection; direct POSTs are checked.
- Submitted records are forced back into resubmission when hours change.
- Approved and locked records require reopening before punch changes.
- Transferred records are marked stale rather than silently updated.

Assessment:

- This is one of the strongest parts of the feature.

## 7. Database and concurrency findings

Verified database protections:

- One active entry per employee: enforced by partial unique index in `src/timeclock.js`
- One open break per entry: enforced by partial unique index in `src/timeclock.js`
- One timesheet per employee per period start: enforced by unique constraint in `src/timeclock.js`
- Duplicate service shifts are prevented by reusing existing shared shift rows
- Approved correction application is transactional and rollback-safe

Good transaction boundaries observed around:

- correction approval/application
- approval creation
- reopen
- transfer
- shift-hour sync side effects

Remaining concern:

- Some important integrity rules still depend on route logic instead of database constraints.

## 8. Calculation findings

Verified:

- Raw minutes, break minutes, payable minutes, and live payable-so-far math are coherent.
- Multiple entries on one shift are summed before hour conversion.
- Shift-only historical hours are included in timesheet totals without inventing fake punches.
- Overtime is only computed on official periods, not arbitrary custom ranges.
- Transfer snapshots preserve approved totals and fingerprints.
- Manager-entered hours are kept separate from clock-owned hours.

Important limit:

- Overtime logic is federal weekly-threshold math only. It is not a full state-rule engine.

## 9. Shift and tip integration findings

Verified:

- Tip submission and time clock activity converge on the same shared shift.
- Clock-first and tips-first both avoid duplicate shifts.
- Multiple employees share one shift row while keeping separate entries.
- POS hours can fill a gap, but the clock can take ownership back intentionally.
- Existing `work.hours` overrides are respected.

Assessment:

- This integration is one of the feature’s biggest strengths.

## 10. Payroll integration findings

Verified:

- Approval and transfer are distinct records.
- Transfer snapshots preserve prior states instead of overwriting history.
- Changed-after-transfer states correctly flag payroll as stale.
- Re-transfer supersedes prior snapshots instead of deleting them.
- Timesheet actions do not auto-send payroll.

Important limit:

- The feature prepares and records payroll hours well, but it is not yet a full legal payroll-compliance engine.

## 11. Security findings

### High

1. No brute-force protection on staff PIN authentication

- File/function: `src/server.js:5039` `app.post('/tips/start')`, `src/server.js:3979` `pinOk`
- Affected workflow: portal sign-in, correction confirmation, timesheet submission confirmation, optional PIN clock-out
- What happens now: PIN checks are direct equality checks with no visible rate limit, lockout, delay, or attempt tracking.
- What should happen: repeated failures should be throttled per employee and per IP, with audit logging.
- Reproduction: repeatedly POST different 4-digit PINs to `/tips/start`.
- Risk: a 4-digit credential with no throttling is guessable.
- Recommended fix: add server-side throttling and short lockouts around PIN checks; log repeated failures; optionally support longer PINs.
- Tests to add: repeated bad PIN attempts are slowed/locked; valid PIN still works after cooldown.

### Medium

2. Overtime engine is not state-specific

- File/function: `src/overtime.js`
- Affected workflow: timesheet totals, approval snapshots, payroll transfer snapshots when overtime is enabled
- What happens now: overtime is calculated using a weekly threshold and multiplier only.
- What should happen: if this becomes a payroll-trust feature across states, state-specific daily OT, double-time, seventh-day, and exemption rules need a configurable rules engine.
- Reproduction: review `rule()` and `overtimeFor()`; only FLSA-style weekly OT is implemented.
- Risk: misleading overtime totals if operators expect state-law payroll figures.
- Recommended fix: keep current logic clearly labeled as estimate unless/until a jurisdiction-aware rules layer exists.
- Tests to add: state-rule fixtures if you later support them.

3. Overlap protection for entries and breaks is application-level, not database-level

- File/function: `src/timeclock.js:444` `assertNoEntryOverlap`, `src/timeclock.js:454` `assertBreakFits`
- Affected workflow: manager edits, approved corrections, future import/backfill paths
- What happens now: overlaps are blocked through the audited code paths, but not by a database constraint.
- What should happen: every write path must keep calling these guards, or be centralized behind one write API.
- Reproduction: direct SQL insert can still create overlapping historical entries or breaks.
- Risk: a future bulk importer or shortcut route could bypass the guard and corrupt payroll totals.
- Recommended fix: centralize all punch writes through shared mutation helpers and add importer-side validations.
- Tests to add: import/backfill helpers must reject overlap just like routes do.

### Low

4. No dedicated CSRF token layer on authenticated form posts

- File/function: cookie/session handling in `src/server.js:377`, `src/server.js:3211`
- Affected workflow: owner/admin POST routes and portal POST routes
- What happens now: cookies are `HttpOnly` and `SameSite=Lax`, which reduces classic cross-site POST risk, but there is no explicit CSRF token system.
- What should happen: if the app is exposed broadly on the public web, a token layer would be stronger defense-in-depth.
- Reproduction: review cookie handling and absence of CSRF verification on POST routes.
- Risk: low today because `SameSite=Lax` helps, but still weaker than a full CSRF model.
- Recommended fix: add CSRF tokens for authenticated mutations if the app remains internet-facing.
- Tests to add: mutation POST without valid CSRF token is refused.

### Informational

5. Finalized payroll state exists in the model but I did not find a complete end-to-end final-payroll workflow in this feature slice

- File/function: `src/timeclock.js:1086`, `src/timeclock.js:1177`, `src/timeclock.js:1200`
- Affected workflow: post-transfer terminal-state governance
- What happens now: the model knows about `finalized`, but the audited time-clock/timesheet routes mainly operate through open/submitted/approved/locked/transferred/reopened states.
- What should happen: if “finalized payroll” becomes a real operator-facing state, it should have explicit route, UI, and reopen policy coverage.
- Risk: more of a product completeness gap than a current bug.
- Recommended fix: either document that transfer is the terminal state for now, or add the full finalize/reopen workflow later.

## 12. Test coverage findings

Existing tests reviewed:

- `test/timeclock.test.js`
- `test/clockhours.test.js`
- `test/portal.test.js`
- `test/auth.test.js`
- `test/overtime.test.js` exists but was not part of the focused run for this audit

Commands run:

```bash
TZ=America/New_York node --test test/timeclock.test.js
TZ=America/New_York node --test test/clockhours.test.js
TZ=America/New_York node --test test/portal.test.js
TZ=America/New_York node --test test/auth.test.js
```

Results:

- `test/timeclock.test.js`: 91 passed, 0 failed
- `test/clockhours.test.js`: 54 passed, 0 failed
- `test/portal.test.js`: 42 passed, 0 failed
- `test/auth.test.js`: 23 passed, 0 failed

Coverage strength:

- Excellent on workflow correctness
- Excellent on permission boundaries
- Strong on rollback and stale-transfer behavior
- Strong on overnight logic and shift linking

Missing or lighter coverage:

- brute-force/rate-limit behavior
- explicit CSRF protections
- jurisdiction-specific overtime rules
- bulk-import/backfill overlap safety if new import paths are added later

## 13. Confirmed strengths

- Clear source-of-truth model
- Strong audit history
- Thoughtful shift/tip/time convergence
- Good period safety around custom ranges
- Strong viewer/editor/payroll-area separation
- Real rollback behavior instead of fake “approved but not applied” states
- Good preservation of business intent when manager overrides exist
- Much better-than-average tests for an internal ops product

## 14. Known limitations

- Overtime is not state-law complete.
- Security hardening around PIN auth is still light.
- Some integrity rules depend on code discipline instead of hard database enforcement.
- “Finalized payroll” appears modeled more than fully operationalized in this slice.

## 15. Prioritized issues

Priority order:

1. Add PIN brute-force protection
2. Clearly label overtime as estimate unless/until state-aware logic exists
3. Centralize all punch-writing paths so overlap validation cannot be bypassed later
4. Add CSRF defense-in-depth if the app remains public-facing
5. Decide whether payroll transfer is the terminal state or whether finalized payroll needs a complete workflow

## 16. Final rating

**Safe after specific fixes**

Reason:

- The current implementation appears operationally strong for day-to-day restaurant use.
- I did not find a core punch, break, correction, submission, approval, transfer, or shift-linking failure in the audited paths.
- The remaining concerns are mostly hardening and legal/payroll-scope issues, not evidence that the main workflow is broken today.
