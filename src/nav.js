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
  { key: 'shifts',    label: 'Shifts & tip-outs', paths: ['/shifts'] },
  { key: 'sales',     label: 'Sales',           paths: ['/sales'] },
  // Renamed from "Cost %" in the UI. The key stays put: it is written into
  // every account's feature list.
  { key: 'costs',     label: 'Performance',     paths: ['/costs', '/performance'] },
  { key: 'cash',      label: 'Cash',            paths: ['/cash'] },
  { key: 'payroll',   label: 'Payroll',         paths: ['/payroll'] },
  { key: 'trackers',  label: 'Trackers & logs', paths: ['/c/'] },
  { key: 'menu',      label: 'Menu costing',    paths: ['/menu'] },
  { key: 'staff',     label: 'Staff',           paths: ['/employees'] },
  { key: 'settings',  label: 'Settings & users', paths: ['/settings', '/policy', '/positions', '/email', '/users'] },
];

const byKey = new Map(AREAS.map((a) => [a.key, a]));

/** Which area a path belongs to, or null when nothing claims it. */
function areaFor(path) {
  const p = String(path || '');
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
// [href, icon, label, accent, area, tag?]
const SECTIONS = [
  { title: null, links: [
    ['/', 'dashboard', 'Dashboard', '#2563eb', 'dashboard'],
  ] },
  { title: 'Operations', links: [
    ['/shifts', 'shifts', 'Shifts', '#4f46e5', 'shifts'],
    ['/sales', 'sales', 'Sales', '#059669', 'sales'],
    ['/costs', 'costs', 'Performance', '#0891b2', 'costs'],
    ['/cash', 'cash', 'Cash', '#d97706', 'cash'],
    ['/payroll', 'payroll', 'Payroll', '#7c3aed', 'payroll'],
  ] },
  { title: 'Purchasing', links: [
    ['/c/invoices', 'invoices', 'Invoices', '#0891b2', 'trackers'],
    ['/c/expenses', 'cash', 'Expenses', '#b45309', 'trackers'],
    ['/c/vendors', 'vendors', 'Vendors', '#ea580c', 'trackers'],
    ['/c/products', 'par', 'Products', '#ca8a04', 'trackers'],
    ['/menu', 'costs', 'Menu costing', '#7c3aed', 'menu', 'BETA'],
  ] },
  { title: 'Restaurant', links: [
    ['/c/expirations', 'expirations', 'Expirations', '#dc2626', 'trackers'],
    ['/c/equipment', 'equipment', 'Equipment', '#64748b', 'trackers'],
    ['/c/documents', 'documents', 'Documents', '#6366f1', 'trackers'],
    ['/c/contacts', 'contacts', 'Contacts', '#0d9488', 'trackers'],
  ] },
  { title: 'Tasks & logs', links: [
    ['/c/recurring', 'recurring', 'Recurring tasks', '#059669', 'trackers'],
    ['/c/incidents', 'incidents', 'Incident log', '#dc2626', 'trackers'],
    ['/c/notes', 'notes', 'Decisions log', '#7c3aed', 'trackers'],
  ] },
  { title: 'Team', links: [
    ['/employees', 'staff', 'Staff', '#2563eb', 'staff'],
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
  { href: '/shifts/new', icon: 'shifts', label: 'Shift', area: 'shifts' },
  { href: '/c/invoices', icon: 'invoices', label: 'Invoice', area: 'trackers' },
  { href: '/c/vendors', icon: 'vendors', label: 'Vendor', area: 'trackers' },
  { href: '/c/products', icon: 'par', label: 'Product', area: 'trackers' },
  { href: '/menu/new', icon: 'costs', label: 'Menu item', area: 'menu' },
  { href: '/c/incidents', icon: 'incidents', label: 'Incident', area: 'trackers' },
  { href: '/cash/new', icon: 'cash', label: 'Cash count', area: 'cash' },
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
