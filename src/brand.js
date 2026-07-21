'use strict';

// Two different names, and keeping them straight matters.
//
// APP_NAME is the software — the chrome, the manager's PWA, the page titles.
// RESTAURANT is whoever is running on it, and it is what staff see on the tips
// page and what goes out on payroll emails and exports.
//
// They live here rather than in views.js because email.js needs the restaurant
// name too, and it had its own copy of the fallback. Two copies of a default
// that must agree is a default that eventually won't.
//
// RESTAURANT deliberately does not fall back to APP_NAME. It used to, which
// meant an unset RESTAURANT_NAME printed the product's name in the place the
// restaurant's belongs — on the staff tips screen, on their payroll email. A
// placeholder asks to be configured. A confident wrong name doesn't.
const APP_NAME = 'ZWIN';
const RESTAURANT = process.env.RESTAURANT_NAME || 'Your restaurant';

module.exports = { APP_NAME, RESTAURANT };
