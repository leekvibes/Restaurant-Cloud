'use strict';

// Loads a few sample employees + one sample dinner shift so you can click
// around immediately. Safe to re-run: it only seeds an empty database.

const { db, q, s, w } = require('./db');
const { toCents } = require('./money');

const count = db.prepare('SELECT COUNT(*) n FROM employees').get().n;
if (count > 0) {
  console.log('Database already has data — not seeding. (Delete data.db to reset.)');
  process.exit(0);
}

const people = [
  { name: 'Ana Reyes', role: 'server', email: 'ana@example.com', pin: '1234', rate: 11.0, pos_id: 'S-01' },
  { name: 'Ben Ortiz', role: 'server', email: 'ben@example.com', pin: '2345', rate: 11.0, pos_id: 'S-02' },
  { name: 'Cira Lund', role: 'server', email: 'cira@example.com', pin: '3456', rate: 11.0, pos_id: 'S-03' },
  { name: 'Dom Frey', role: 'kitchen', email: 'dom@example.com', rate: 18.0 },
  { name: 'Eli Park', role: 'kitchen', email: 'eli@example.com', rate: 17.0 },
  { name: 'Fran Diaz', role: 'busser', email: 'fran@example.com', rate: 12.0 },
  { name: 'Gia Moss', role: 'barista', email: 'gia@example.com', rate: 14.0 },
  { name: 'You (Manager)', role: 'manager', email: 'malekqibaa@gmail.com' },
];
const ids = {};
for (const p of people) {
  const info = q.addEmployee.run({
    name: p.name, role: p.role, email: p.email || null, pin: p.pin || null,
    hourly_rate_cents: toCents(p.rate), pos_id: p.pos_id || null,
  });
  ids[p.name] = info.lastInsertRowid;
}

const date = '2026-07-16';
s.getOrIgnore.run(date, 'dinner');
const sh = s.findShift.get(date, 'dinner');

function server(name, hours, food, coffee, card, cash) {
  w.upsertWork.run({ shift_id: sh.id, employee_id: ids[name], role: 'server', hours });
  w.upsertSales.run({
    shift_id: sh.id, employee_id: ids[name],
    food_cents: toCents(food), coffee_cents: toCents(coffee), alcohol_cents: 0,
  });
  w.setCardTips.run({ shift_id: sh.id, employee_id: ids[name], card_tips_cents: toCents(card) });
  w.setCashTips.run({ shift_id: sh.id, employee_id: ids[name], cash_tips_cents: toCents(cash), by: 'staff' });
}
function support(name, role, hours) {
  w.upsertWork.run({ shift_id: sh.id, employee_id: ids[name], role, hours });
}

server('Ana Reyes', 6, 2100, 180, 320, 140);
server('Ben Ortiz', 5.5, 1750, 90, 265, 120);
server('Cira Lund', 4, 980, 240, 150, 60);
support('Dom Frey', 'kitchen', 8);
support('Eli Park', 'kitchen', 6);
support('Fran Diaz', 'busser', 7);
support('Gia Moss', 'barista', 5);

console.log('Seeded 8 staff and one sample dinner shift (' + date + '). Open http://localhost:' + (process.env.PORT || 4000));
