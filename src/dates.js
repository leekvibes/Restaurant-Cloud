'use strict';

// Every date in this app is a *business* date — the day the restaurant was
// open — so it must be computed in the restaurant's local timezone, never UTC.
// Hosts run in UTC by default, which would roll the date over mid-dinner-service
// and file a Thursday close under Friday. Set TZ=America/New_York on the host.

/** YYYY-MM-DD for a Date, in local time (NOT toISOString, which is UTC). */
function isoDate(d = new Date()) {
  const t = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** Local midnight today — the anchor for "last 7 days" style windows. */
function startOfToday() {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

/** Shift a YYYY-MM-DD string by n days (negative goes back). */
function addDays(dateStr, n) {
  const d = new Date(String(dateStr) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

module.exports = { isoDate, startOfToday, addDays };
