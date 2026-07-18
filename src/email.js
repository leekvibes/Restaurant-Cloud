'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { fmt, toCents } = require('./money');

const RESTAURANT = process.env.RESTAURANT_NAME || 'Restaurant Cloud';
const PREVIEW_DIR = path.join(__dirname, '..', 'previews');

const ROLE_LABEL = {
  server: 'Server',
  kitchen: 'Kitchen',
  barista: 'Barista',
  bartender: 'Bartender',
  busser: 'Busser',
};

function wageCents(hours, hourlyRateDollars) {
  return Math.round(toCents(hourlyRateDollars) * (Number(hours) || 0)) / 1;
}

function shell(title, bodyRows, hero) {
  const heroBlock = hero ? `<div style="padding:22px 22px 6px;text-align:center">
      <div style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">${hero.label}</div>
      <div style="font-size:42px;font-weight:800;color:#2563eb;letter-spacing:-.02em;margin-top:2px;line-height:1">${hero.value}</div>
    </div>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f7fc;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e6ecf4;box-shadow:0 6px 24px rgba(15,23,42,.06)">
      <div style="background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);color:#fff;padding:20px 22px">
        <div style="font-size:12px;opacity:.85;letter-spacing:.06em;text-transform:uppercase;font-weight:600">${RESTAURANT}</div>
        <div style="font-size:20px;font-weight:800;margin-top:3px;letter-spacing:-.01em">${title}</div>
      </div>
      ${heroBlock}
      <div style="padding:10px 22px 20px">${bodyRows}</div>
      <div style="padding:14px 22px;border-top:1px solid #eef2f7;color:#94a3b8;font-size:12px;line-height:1.5">
        This is a summary, not a pay stub — final amounts are set in payroll.
      </div>
    </div>
  </div></body></html>`;
}

function line(label, value, opts = {}) {
  const strong = opts.strong ? 'font-weight:700;font-size:16px' : 'font-weight:500';
  const color = opts.color || '#0f172a';
  const border = opts.border === false ? '' : 'border-top:1px solid #eef2f7';
  return `<div style="display:flex;justify-content:space-between;padding:9px 0;${border}">
    <span style="color:#64748b">${label}</span>
    <span style="${strong};color:${color}">${value}</span></div>`;
}

function section(title) {
  return `<div style="margin:18px 0 2px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8">${title}</div>`;
}

/** Build the email for one server. `p` is a server payout object from the engine. */
function serverEmail(p, ctx) {
  const wage = wageCents(p.hours, ctx.hourlyRate);
  const paycheckAdj = p.tipsKept - p.cashTips; // + owed on paycheck, - taken home in excess

  let body = '';
  body += line('Date', `${ctx.date} · ${ctx.daypart === 'cafe' ? 'Café' : 'Dinner'}`, { border: false });
  body += line('Hours worked', `${p.hours}`);
  if (ctx.salaried) body += line('Pay', 'Salaried');
  else if (wage > 0) body += line('Estimated wage', fmt(wage));

  body += section('Your sales');
  body += line('Food', fmt(p.sales.food), { border: false });
  if (p.sales.coffee) body += line('Coffee', fmt(p.sales.coffee));
  if (p.sales.alcohol) body += line('Alcohol', fmt(p.sales.alcohol));

  body += section('Your tips');
  body += line('Card tips', fmt(p.cardTips), { border: false });
  body += line('Cash tips', fmt(p.cashTips));
  body += line('Total tips collected', fmt(p.totalTips), { strong: true });

  body += section('Tip-out');
  const tipoutRoles = Object.keys(p.tipouts).filter((r) => p.tipouts[r]);
  if (tipoutRoles.length === 0) body += line('No tip-out', fmt(0), { border: false });
  tipoutRoles.forEach((role, i) => {
    body += line('→ ' + (ROLE_LABEL[role] || role), '-' + fmt(p.tipouts[role]), { border: i === 0 ? false : true, color: '#dc2626' });
  });
  body += line('Tips you keep', fmt(p.tipsKept), { strong: true, color: '#059669' });

  // The clarity line: you already took the cash home; here's how it nets out.
  body += section('How this reaches you');
  body += line('Cash you took home tonight', fmt(p.cashTips), { border: false });
  if (paycheckAdj >= 0) {
    body += line('Added to your next paycheck', '+' + fmt(paycheckAdj), { color: '#059669' });
  } else {
    body += line('Adjusted from your next paycheck', '-' + fmt(-paycheckAdj), { color: '#dc2626' });
    body += `<div style="margin-top:8px;font-size:12px;color:#94a3b8;line-height:1.5">You took home more cash than your net tips (because part funds the kitchen/busser tip-out), so your paycheck is reduced by that difference. Your total is still ${fmt(p.tipsKept)}${wage > 0 ? ' in tips, plus your wage' : ''}.</div>`;
  }

  const subject = `${RESTAURANT}: your ${ctx.date} ${ctx.daypart} summary — ${fmt(p.tipsKept)} in tips`;
  return { to: ctx.email, subject, html: shell(`${ROLE_LABEL.server} summary`, body, { label: 'Tips you keep', value: fmt(p.tipsKept) }) };
}

/** Build the email for a support-role employee (kitchen/busser/barista/bartender). */
function supportEmail(p, ctx) {
  const wage = wageCents(p.hours, ctx.hourlyRate);
  let body = '';
  body += line('Date', `${ctx.date} · ${ctx.daypart === 'cafe' ? 'Café' : 'Dinner'}`, { border: false });
  body += line('Role', ROLE_LABEL[p.role] || p.role);
  body += line('Hours worked', `${p.hours}`);
  if (ctx.salaried) body += line('Pay', 'Salaried');
  else if (wage > 0) body += line('Estimated wage', fmt(wage));

  const POOL_LABEL = { weekly_cash: 'Pool share (weekly cash)', paycheck: 'Pool share (on paycheck)', nightly_cash: 'Pool share (cash tonight)' };
  const shares = p.poolShares || {};
  const total = (p.tipShare || 0) + (p.poolShare || 0);

  body += section('Tips');
  let first = true;
  if (p.tipShare) { body += line('Tip-out share (on paycheck)', fmt(p.tipShare), { border: false }); first = false; }
  for (const payout of Object.keys(shares)) {
    if (!shares[payout]) continue;
    body += line(POOL_LABEL[payout] || 'Pool share', fmt(shares[payout]), { border: first ? false : true });
    first = false;
  }
  body += line('Total tips', fmt(total), { strong: true, color: '#059669' });
  body += `<div style="margin-top:8px;font-size:12px;color:#94a3b8;line-height:1.5">Your tip-out share (split by hours) lands on your Gusto paycheck. Shared-pool amounts are paid however the policy sets for each part — weekly cash and/or on your paycheck.</div>`;

  const subject = `${RESTAURANT}: your ${ctx.date} ${ctx.daypart} summary — ${fmt(total)} in tips`;
  return { to: ctx.email, subject, html: shell(`${ROLE_LABEL[p.role] || p.role} summary`, body, { label: 'Total tips', value: fmt(total) }) };
}

/**
 * Build every employee's email for a shift.
 * @param results  engine.runShift() output
 * @param meta     { date, daypart }
 * @param people   Map employeeId -> { email, hourlyRate }
 */
function buildEmails(results, meta, people) {
  const emails = [];
  for (const p of results.servers) {
    const info = people.get(p.employeeId) || {};
    emails.push({ employeeId: p.employeeId, name: p.name, ...serverEmail(p, { ...meta, email: info.email, hourlyRate: info.hourlyRate, salaried: info.salaried }) });
  }
  for (const p of results.support) {
    const info = people.get(p.employeeId) || {};
    emails.push({ employeeId: p.employeeId, name: p.name, ...supportEmail(p, { ...meta, email: info.email, hourlyRate: info.hourlyRate, salaried: info.salaried }) });
  }
  return emails;
}

// Google shows App Passwords as "abcd efgh ijkl mnop" — everybody pastes the
// spaces, and Gmail then rejects the login with a useless 535. Strip them.
const appPassword = () => (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

/**
 * What mail is configured, and what's missing if it isn't. Drives the settings
 * page and decides whether "send" really sends or just writes previews.
 * @returns {{ready:boolean, mode:string, from:string|null, problem:string|null}}
 */
function mailStatus() {
  const gmailUser = (process.env.GMAIL_USER || '').trim();
  if (gmailUser) {
    if (!appPassword()) {
      return { ready: false, mode: 'gmail', from: gmailUser,
        problem: 'GMAIL_USER is set but GMAIL_APP_PASSWORD is empty. Gmail needs a 16-character App Password — your normal account password will not work.' };
    }
    return { ready: true, mode: 'gmail', from: gmailUser, problem: null };
  }
  if (process.env.SMTP_HOST) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return { ready: false, mode: 'smtp', from: process.env.MAIL_FROM || null,
        problem: 'SMTP_HOST is set but SMTP_USER / SMTP_PASS are missing.' };
    }
    return { ready: true, mode: 'smtp', from: process.env.MAIL_FROM || process.env.SMTP_USER, problem: null };
  }
  return { ready: false, mode: 'none', from: null,
    problem: 'No mail account connected yet. Emails are written as preview files instead of being sent.' };
}

function transport() {
  const st = mailStatus();
  if (!st.ready) return null;
  if (st.mode === 'gmail') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER.trim(), pass: appPassword() },
    });
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

/** Gmail's SMTP errors are cryptic. Turn them into something actionable. */
function friendlyMailError(err) {
  const msg = err.message || String(err);
  if (err.code === 'EAUTH' || /535|Username and Password not accepted|Invalid login/i.test(msg)) {
    return 'Gmail rejected the login. Use the 16-character App Password from myaccount.google.com/apppasswords — not your normal Gmail password. (2-Step Verification must be on for that page to exist.)';
  }
  if (/5\.4\.5|Daily user sending (limit|quota) exceeded/i.test(msg)) {
    return 'Gmail’s daily sending limit was hit (about 500 messages). It resets in 24 hours.';
  }
  if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || /ENOTFOUND|ECONNREFUSED/.test(msg)) {
    return 'Could not reach the mail server — check the internet connection on the host.';
  }
  if (/Message failed: 550/i.test(msg)) return 'The recipient address was rejected — check it for typos.';
  return msg;
}

/** From header: "Palm Vintage <malek...@gmail.com>" reads better than a bare address. */
function fromAddress() {
  const st = mailStatus();
  const address = process.env.MAIL_FROM || st.from || 'noreply@restaurant.local';
  // If MAIL_FROM already carries a display name, leave it exactly as given.
  if (/</.test(address)) return address;
  return { name: RESTAURANT, address };
}

/** Prove the credentials work without emailing the whole staff. */
async function sendTest(to) {
  const t = transport();
  if (!t) throw new Error(mailStatus().problem);
  try {
    await t.verify();
    await t.sendMail({
      from: fromAddress(),
      to,
      subject: `${RESTAURANT}: test email`,
      html: shell('Test email', line('Status', 'Working', { border: false })
        + `<div style="margin-top:10px;font-size:13px;color:#64748b;line-height:1.5">If you can read this, ${RESTAURANT} can send nightly tip summaries to your staff.</div>`,
      { label: 'Mail', value: 'Connected' }),
    });
  } catch (err) {
    throw new Error(friendlyMailError(err));
  }
}

/**
 * Send (or, if no mail is configured, preview) the emails.
 * Returns { sent, previewed, files, errors }.
 */
async function sendEmails(emails) {
  const t = transport();
  const from = fromAddress();
  const out = { sent: 0, previewed: 0, files: [], errors: [] };

  if (!t) {
    // Preview mode: write HTML files so you can eyeball them before wiring email.
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    for (const e of emails) {
      const safe = (e.name || 'employee').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      const file = path.join(PREVIEW_DIR, `${safe}.html`);
      fs.writeFileSync(file, e.html);
      out.files.push(file);
      out.previewed++;
    }
    return out;
  }

  // Fail fast on a bad password rather than reporting the same auth error
  // eight times, once per employee.
  try {
    await t.verify();
  } catch (err) {
    out.errors.push(friendlyMailError(err));
    return out;
  }

  for (const e of emails) {
    if (!e.to) { out.errors.push(`${e.name}: no email on file`); continue; }
    try {
      await t.sendMail({ from, to: e.to, subject: e.subject, html: e.html });
      out.sent++;
    } catch (err) {
      out.errors.push(`${e.name}: ${friendlyMailError(err)}`);
    }
  }
  return out;
}

module.exports = { buildEmails, sendEmails, sendTest, mailStatus, friendlyMailError, serverEmail, supportEmail, PREVIEW_DIR, RESTAURANT };
