'use strict';

// ---------------------------------------------------------------------------
// NAVIGATION AND ACCESS, from one list.
//
// These were two lists before: NAV_GROUPS drew the sidebar, FEATURES decided
// what an account could open, and nothing connected them. Menu costing shipped
// in the first and not the second, so every signed-in account could read
// recipe costs and supplier pricing regardless of what it was restricted to —
// featureFor() returns null for an unlisted path, and null means open.
//
// So an AREA owns both jobs. A nav item names the area it belongs to, an area
// owns the path prefixes that belong to it, and adding a link without an area
// throws at startup rather than quietly opening a door.
//
// AREA KEYS ARE STORED on user accounts. Renaming one revokes access for
// everyone who had it, so they are left alone even where the label moved on —
// 'costs' still keys the page now called Performance.
// ---------------------------------------------------------------------------

const AREAS = [
  { key: 'dashboard', label: 'Dashboard',       paths: ['/'] },
  // The restaurant-wide (date, daypart) object is a SERVICE. A scheduled
  // shift is one employee's planned work — a different thing entirely, and
  // sharing a word with it made every conversation ambiguous. The KEY stays
  // put, exactly as 'costs' did when it was relabelled Performance: it is
  // written into every account's feature list.
  { key: 'shifts',    label: 'Services & tip-outs', paths: ['/shifts'] },
  // A NEW key, and new keys are closed by default: an account with a
  // restricted feature list does not have 'schedule' in it, so the gate at
  // server.js refuses the page until an owner ticks it on the Users page.
  // That is the intended direction — a planning surface should not appear for
  // somebody who was only ever given Sales.
  { key: 'schedule',  label: 'Schedule',        paths: ['/schedule'] },
  { key: 'sales',     label: 'Sales',           paths: ['/sales'] },
  // Renamed from "Cost %" in the UI. The key stays put: it is written into
  // every account's feature list.
  { key: 'costs',     label: 'Performance',     paths: ['/costs', '/performance'] },
  { key: 'cash',      label: 'Cash',            paths: ['/cash'] },
  { key: 'payroll',   label: 'Payroll',         paths: ['/payroll'] },   // includes /payroll/timesheets
  { key: 'trackers',  label: 'Trackers & logs', paths: ['/c/', '/calendar'] },
  { key: 'menu',      label: 'Menu costing',    paths: ['/menu'] },
  // The portal's manager side sits with Staff: it is about the people, and
  // anybody trusted with the roster is the person who posts the board and
  // answers what the floor has run out of.
  { key: 'staff',     label: 'Staff',           paths: ['/employees', '/staff-portal', '/timeclock', '/documents'] },
  { key: 'settings',  label: 'Settings & users', paths: ['/settings', '/policy', '/positions', '/email', '/users'] },
];

const byKey = new Map(AREAS.map((a) => [a.key, a]));

/** Which area a path belongs to, or null when nothing claims it. */
function areaFor(path) {
  // Lowercased before matching, as a second lock on the same door. Express is
  // configured case-sensitive so /Payroll never reaches a handler at all — but
  // this function is also called with hrefs from templates and with paths from
  // other call sites, and a permission check that depends on somebody else's
  // configuration being right is a permission check waiting to be wrong.
  // Every prefix in AREAS is lowercase, so this changes nothing else.
  const p = String(path || '').toLowerCase();
  let best = null;
  for (const a of AREAS) {
    for (const prefix of a.paths) {
      const hit = prefix === '/' ? p === '/' : p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') || p === prefix;
      // Longest prefix wins, so /menu doesn't lose to a shorter neighbour.
      if (hit && (!best || prefix.length > best.len)) best = { key: a.key, len: prefix.length };
    }
  }
  return best ? best.key : null;
}

// --- the sidebar -----------------------------------------------------------
// Daily work only. Anything about the account or the configuration of the
// restaurant lives on the Settings page, reached from the top bar.
//
// HIDDEN, NOT REMOVED (Sep 2026, at the owner's request): Cash, Menu costing,
// Expirations, Equipment and the Decisions log are off the sidebar because the
// restaurant stopped using them. Their pages, their data and their AREAS are
// untouched, so the addresses still open for anybody allowed, access settings
// on user accounts keep meaning what they meant, and putting a line back here
// brings one back exactly as it was.
//
// Grouped the way the week runs: the night's work and its numbers, the people
// from rota to paycheck, what the restaurant buys, the paperwork, and last the
// two pages that set the rules everything else is worked out by.
//
// [href, icon, label, accent, area, tag?]
const SECTIONS = [
  { title: null, links: [
    ['/', 'dashboard', 'Dashboard', '#2563eb', 'dashboard'],
  ] },
  { title: 'Daily', links: [
    ['/shifts', 'shifts', 'Services', '#4f46e5', 'shifts'],
    ['/sales', 'sales', 'Sales', '#059669', 'sales'],
    ['/costs', 'costs', 'Performance', '#0891b2', 'costs'],
    ['/calendar', 'calendar', 'Calendar', '#059669', 'trackers'],
  ] },
  { title: 'Team', links: [
    ['/schedule', 'calendar', 'Schedule', '#be185d', 'schedule'],
    ['/timeclock', 'shifts', 'Time clock', '#b45309', 'staff'],
    ['/payroll', 'payroll', 'Payroll', '#7c3aed', 'payroll'],
    ['/employees', 'staff', 'Staff', '#2563eb', 'staff'],
    ['/staff-portal', 'tips', 'Portal', '#1a7a3c', 'staff'],
    // "Employee documents", not "Documents" — /c/documents already exists and is
    // the business paperwork tracker (leases, tax, permits). Two identical
    // labels in one sidebar is a coin toss every time somebody goes looking.
    ['/documents', 'documents', 'Employee documents', '#0f766e', 'staff'],
  ] },
  { title: 'Purchasing', links: [
    ['/c/invoices', 'invoices', 'Invoices', '#0891b2', 'trackers'],
    ['/c/expenses', 'cash', 'Expenses', '#b45309', 'trackers'],
    ['/c/vendors', 'vendors', 'Vendors', '#ea580c', 'trackers'],
    ['/c/products', 'par', 'Products', '#ca8a04', 'trackers'],
  ] },
  { title: 'Records', links: [
    ['/c/documents', 'documents', 'Documents', '#6366f1', 'trackers'],
    ['/c/contacts', 'contacts', 'Contacts', '#0d9488', 'trackers'],
    ['/c/incidents', 'incidents', 'Incident log', '#dc2626', 'trackers'],
  ] },
  { title: 'Setup', links: [
    ['/positions', 'positions', 'Positions', '#7c3aed', 'settings'],
    ['/policy', 'policy', 'Tip-out policy', '#0891b2', 'settings'],
  ] },
];

// Every link must name an area that exists. This is the check that would have
// caught menu costing: it throws on boot rather than serving an open page.
for (const s of SECTIONS) {
  for (const [href, , label, , area] of s.links) {
    if (!area) throw new Error(`nav: "${label}" (${href}) has no area — it would be reachable by every account`);
    if (!byKey.has(area)) throw new Error(`nav: "${label}" names area "${area}", which does not exist`);
    if (areaFor(href) !== area) {
      throw new Error(`nav: "${label}" (${href}) resolves to area "${areaFor(href)}", not "${area}" — add the path to that area`);
    }
  }
}

/** What the universal create button offers. Each entry names its area so it
 *  disappears for an account that cannot use it. */
const CREATE_ACTIONS = [
  { href: '/shifts/new', icon: 'shifts', label: 'Service', area: 'shifts' },
  { href: '/c/invoices', icon: 'invoices', label: 'Invoice', area: 'trackers' },
  { href: '/c/vendors', icon: 'vendors', label: 'Vendor', area: 'trackers' },
  { href: '/c/products', icon: 'par', label: 'Product', area: 'trackers' },
  // Menu item and Cash count went with their pages off the sidebar (see
  // SECTIONS). A create button for a page nobody can find is a way in to it.
  { href: '/c/incidents', icon: 'incidents', label: 'Incident', area: 'trackers' },
  { href: '/employees', icon: 'staff', label: 'Employee', area: 'staff' },
];

/** The Settings page, and the profile menu that reaches it. */
const SETTINGS_GROUPS = [
  { title: 'Restaurant', items: [
    { href: '/policy', icon: 'policy', label: 'Tip-out policy', blurb: 'Rates and who pays whom, versioned.' },
    { href: '/positions', icon: 'positions', label: 'Positions', blurb: 'The jobs people can work, and how they are tipped.' },
    { href: '/employees', icon: 'staff', label: 'Staff', blurb: 'People, roles, wages and PINs.' },
  ] },
  { title: 'Account', items: [
    { href: '/users', icon: 'users', label: 'Users & access', blurb: 'Who can sign in, and what each of them may see.' },
    { href: '/email', icon: 'email', label: 'Email', blurb: 'Where nightly summaries and payroll go out from.' },
  ] },
  { title: 'Staff-facing', items: [
    { href: '/tips', icon: 'tips', label: 'Cash tips page', blurb: 'The PIN screen staff use at the end of a shift.' },
  ] },
];

module.exports = { AREAS, SECTIONS, CREATE_ACTIONS, SETTINGS_GROUPS, areaFor, byKey };
