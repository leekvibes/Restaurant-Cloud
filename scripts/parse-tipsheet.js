'use strict';

// ---------------------------------------------------------------------------
// PARSE THE TIP WORKBOOK
//
// Reads the Google Sheets markdown export and produces one clean record per
// service day. Deliberately strict: anything it cannot parse becomes a hard
// error rather than a silently-skipped row, because a day that quietly fails
// to import is a day somebody does not get paid for.
//
//   node scripts/parse-tipsheet.js <export.txt> <out.json>
// ---------------------------------------------------------------------------

const fs = require('node:fs');

const cents = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '').replace(/\\/g, '');
  if (s === '' || s === '-') return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(neg ? s.slice(1, -1) : s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
};

const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** "05/07/2026", "5/7/2026" and "05/23" (no year) all mean one date. */
function isoOf(raw, fallbackYear) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${fallbackYear}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return null;
}

const cellsOf = (line) => {
  if (!line.startsWith('|')) return null;
  return line.slice(1, line.endsWith('|') ? -1 : undefined)
    .split('|').map((c) => c.replace(/\\/g, '').trim());
};

function parse(text, year = 2026) {
  // The export concatenates every sheet. A day tab is anything containing the
  // calculator's title row or its Section A header.
  const lines = text.split('\n');
  const marks = [];
  lines.forEach((l, i) => {
    if (/DAILY SHIFT TIP-OUT CALCULATOR/.test(l) || /SECTION A .*Server Sales/.test(l)) marks.push(i);
  });

  // Group into blocks: from one title to the next.
  const starts = [];
  for (const i of marks) {
    if (!starts.length || i - starts[starts.length - 1] > 20) starts.push(i);
  }

  const days = [];
  const problems = [];

  for (let b = 0; b < starts.length; b++) {
    const from = Math.max(0, starts[b] - 6);
    const to = b + 1 < starts.length ? starts[b + 1] - 6 : lines.length;
    const block = lines.slice(from, to);

    let date = null, busser = null;
    let section = null;
    const servers = [];
    let totals = null;
    const pools = {};
    const counter = { jar: null, card: null, total: null };
    const staff = [];
    let sanity = null;
    let hoursHeader = null;

    for (const line of block) {
      const c = cellsOf(line);
      if (!c) continue;
      const joined = c.join(' ');

      if (!date && /^Date:/.test(c[0])) date = isoOf(c[1], year);
      if (/^Busser worked today\?/.test(c[0])) busser = /yes/i.test(c[1] || '');

      if (/SECTION A/.test(joined)) { section = 'A'; continue; }
      if (/SECTION B/.test(joined)) { section = 'B'; continue; }
      if (/SECTION C/.test(joined)) { section = 'C'; continue; }
      if (/SECTION D/.test(joined)) { section = 'D'; continue; }
      if (/SANITY CHECK/.test(joined)) { section = 'S'; continue; }
      if (/NOTES|HOURS CONVERTER/.test(joined)) { section = null; continue; }

      if (section === 'A') {
        if (/^Server Name/i.test(c[0])) continue;
        if (/^TOTALS$/i.test(c[0])) {
          totals = { food: cents(c[1]), coffee: cents(c[2]), alcohol: cents(c[3]),
            total: cents(c[4]), cashTips: cents(c[5]), cardTips: cents(c[6]),
            totalTips: cents(c[7]), tipOut: cents(c[8]), kept: cents(c[9]) };
          continue;
        }
        if (c[0] && cents(c[4]) != null) {
          servers.push({ name: c[0], food: cents(c[1]) || 0, coffee: cents(c[2]) || 0,
            alcohol: cents(c[3]) || 0, total: cents(c[4]) || 0,
            cashTips: cents(c[5]) || 0, cardTips: cents(c[6]) || 0,
            totalTips: cents(c[7]) || 0, tipOut: cents(c[8]) || 0, kept: cents(c[9]) || 0 });
        }
      }

      if (section === 'B') {
        if (/Kitchen pool/i.test(c[0])) pools.kitchen = cents(c[1]);
        else if (/Barista pool/i.test(c[0])) pools.barista = cents(c[1]);
        else if (/Bartender pool/i.test(c[0])) pools.bartender = cents(c[1]);
        else if (/Busser pool/i.test(c[0])) pools.busser = cents(c[1]);
        else if (/^TOTAL$/i.test(c[0])) pools.total = cents(c[1]);
      }

      if (section === 'C') {
        if (/Cash tip jar/i.test(c[0])) counter.jar = cents(c[1]) || 0;
        else if (/take-?out|counter orders/i.test(c[0])) counter.card = cents(c[1]) || 0;
        else if (/^TOTAL counter/i.test(c[0])) counter.total = cents(c[1]) || 0;
        // 06/28 has its label cell overwritten with "G28" and 05/22 has a blank
        // section header. Fall back on position when the label is unreadable.
        else if (counter.card == null && /^[A-Z]\d+$/.test(c[0]) && cents(c[1]) != null) counter.card = cents(c[1]);
      }

      if (section === 'D') {
        if (/^Employee Name/i.test(c[0])) { hoursHeader = c[2]; continue; }
        if (/^TOTAL/i.test(c[0])) continue;
        if (c[0] && num(c[2]) != null) {
          staff.push({ name: c[0], role: c[1] || '', hours: num(c[2]),
            wage: cents(c[3]), wageEarnings: cents(c[4]), tipOutShare: cents(c[5]) || 0,
            counterShare: cents(c[6]) || 0,
            cashTaken: c[7] === '' ? null : (cents(c[7]) || 0),
            takeHome: cents(c[8]), cardPayout: cents(c[9]) || 0 });
        }
      }

      if (section === 'S' && /Difference/i.test(c[0])) sanity = cents(c[1]);
    }

    if (!date) { problems.push({ block: b, why: 'no Date: cell' }); continue; }
    if (days.some((d) => d.date === date)) { problems.push({ date, why: 'duplicate tab' }); continue; }

    days.push({ date, busser, servers, totals, pools, counter, staff, sanity, hoursHeader });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, problems };
}

if (require.main === module) {
  const [, , inPath, outPath] = process.argv;
  const raw = JSON.parse(fs.readFileSync(inPath, 'utf8')).fileContent;
  const { days, problems } = parse(raw);
  fs.writeFileSync(outPath, JSON.stringify(days, null, 1));
  console.log(`parsed ${days.length} day tabs -> ${outPath}`);
  if (problems.length) console.log('problems:', JSON.stringify(problems));
  const withSales = days.filter((d) => d.totals && d.totals.total > 0);
  console.log(`${withSales.length} with sales, ${days.length - withSales.length} without`);
  console.log('range:', days[0].date, '->', days[days.length - 1].date);
}

module.exports = { parse, cents, num, isoOf };
