'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { fmt, toCents } = require('./money');

const { RESTAURANT } = require('./brand');
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

// ---------------------------------------------------------------------------
// The broadsheet, in email.
//
// Ported from the approved templates in emails-redesigned/. Three constraints
// come with the medium and none of them are negotiable:
//
//   · Every row is its own two-cell <table>. Gmail and Outlook strip
//     display:flex, which once collapsed every row into "Date2026-07-16".
//   · No web fonts. Newsreader and Geist do not render in most clients, so the
//     app's three faces fall back to Georgia / system sans / SFMono.
//   · Everything inline. No stylesheet survives the trip.
//
// Colour still means what it means everywhere else: green is money coming to
// you, red is money leaving or a delivery that failed. There is no blue.
// ---------------------------------------------------------------------------

const MONO = "'SFMono-Regular',Consolas,Menlo,monospace";
const SANS = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

const INK = '#1f1d1a';
const LABEL = '#5c5647';
const MUTED = '#77705f';
const FAINT = '#a89f8a';
const HAIR = '#e5dac2';
const EDGE = '#ddd0b8';
const GREEN = '#1a7a3c';
const RED = '#9a2c1d';

/**
 * @param title    serif headline
 * @param bodyRows the sections
 * @param opts     { subline, hero: { label, value, color, sub } }
 */
function shell(title, bodyRows, opts = {}) {
  const { subline, hero } = opts;
  const heroBlock = hero ? `<tr><td style="padding:22px 26px 18px;border-bottom:1px solid ${EDGE}">
      <div style="font:600 11px/1 ${MONO};letter-spacing:.12em;color:${MUTED};text-transform:uppercase">${hero.label}</div>
      <div style="font:${hero.serif ? `400 40px/1 ${SERIF}` : `700 44px/1 ${MONO}`};color:${hero.color || INK};letter-spacing:${hero.serif ? '-.01em' : '-.02em'};margin-top:8px">${hero.value}${
        hero.sub ? `<span style="font-size:26px;color:${FAINT}"> ${hero.sub}</span>` : ''}</div>
    </td></tr>` : '';

  // The charset is declared in the document, not only in the MIME headers.
  // Nodemailer sets the header, so a normal send has always been fine — but
  // anything that renders this HTML on its own (a client's "view in browser",
  // a forward that drops the headers, the preview files written to previews/)
  // falls back to latin-1 and turns every · into Â· and every — into â€".
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#f4ead9;font-family:${SANS};color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4ead9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:100%;background:#f7eee0;border:1px solid ${EDGE}">
  <tr><td style="padding:18px 26px;border-bottom:2px solid ${INK}">
    <div style="font:600 11px/1 ${MONO};letter-spacing:.16em;color:${MUTED};text-transform:uppercase">${RESTAURANT}</div>
    <div style="font:400 26px/1.1 ${SERIF};color:${INK};margin-top:6px">${title}</div>
    ${subline ? `<div style="font:400 13px/1.4 ${SANS};color:${MUTED};margin-top:4px">${subline}</div>` : ''}
  </td></tr>
  ${heroBlock}
  <tr><td style="padding:16px 26px 24px">${bodyRows}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/**
 * One label/value row. Its own table, deliberately — see the note above.
 * `border: false` on the first row of a section, since the kicker's rule is
 * already sitting directly above it.
 */
function line(label, value, opts = {}) {
  const strong = opts.strong;
  const zero = /^\$?0(\.00)?$/.test(String(value).trim());
  const color = opts.color || (zero && !strong ? FAINT : INK);
  const border = opts.border === false ? '' : ` style="border-top:1px solid ${HAIR}"`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${border}><tr>
      <td align="left" style="padding:${strong ? 10 : 9}px 0;color:${strong ? INK : LABEL};font-size:14px${strong ? ';font-weight:600' : ''}">${label}</td>
      <td align="right" style="padding:${strong ? 10 : 9}px 0;font-size:${strong ? 16 : 14}px;font-weight:${strong ? 700 : 600};color:${color};white-space:nowrap;font-family:${MONO}">${value}</td>
    </tr></table>`;
}

/** A full-width row with no figure — the "who didn't get one" list. */
function noteRow(html) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="padding:9px 0;color:${INK};font-size:14px;font-weight:600">${html}</td>
    </tr></table>`;
}

/** Muted caption under a row. */
function hint(text) {
  return `<div style="margin:2px 0 0;font-size:12px;color:${MUTED};line-height:1.5">${text}</div>`;
}

/** Section kicker: mono, uppercase, with a rule under it. */
function section(title, opts = {}) {
  const c = opts.color || INK;
  // `first` when the section opens the body — the shell's own padding is
  // already above it, and 22px more pushes it away from the hero rule.
  const margin = opts.first ? '0 0 8px' : '22px 0 8px';
  return `<div style="margin:${margin};font:600 11px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:${c};border-bottom:1px solid ${c};padding-bottom:7px">${title}</div>`;
}

/** Build the email for one server. `p` is a server payout object from the engine. */
function serverEmail(p, ctx) {
  const wage = wageCents(p.hours, ctx.hourlyRate);
  const paycheckAdj = p.tipsKept - p.cashTips; // + owed on paycheck, - taken home in excess

  // The who / role / date rows moved into the masthead subline. Same values,
  // one line instead of three, which is what buys the room for the hero.
  let body = '';
  body += line('Hours worked', `${p.hours}`, { border: false });
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
    body += line(ROLE_LABEL[role] || role, '-' + fmt(p.tipouts[role]), { border: i !== 0, color: RED });
  });
  if (p.tipoutTotal > 0) body += line('Total tip-out', '-' + fmt(p.tipoutTotal), { color: RED });
  // Explain the roles that DIDN'T take a cut, so a short-staffed night doesn't
  // read as a missing line the server has to wonder about.
  const skipped = (ctx.skipped || []).map((sk) => ROLE_LABEL[sk.role] || sk.role);
  if (skipped.length) {
    const list = skipped.length === 1 ? skipped[0]
      : skipped.slice(0, -1).join(', ') + ' or ' + skipped[skipped.length - 1];
    body += hint(`No ${list.toLowerCase()} worked this shift, so no tip-out went to them — you keep it.`);
  }
  body += line('Tips you keep', fmt(p.tipsKept), { strong: true, color: GREEN });

  // The clarity line: you already took the cash home; here's how it nets out.
  body += section('How this reaches you');
  body += line('Cash you took home tonight', fmt(p.cashTips), { border: false });
  if (paycheckAdj >= 0) {
    body += line('Added to your next paycheck', '+' + fmt(paycheckAdj), { color: GREEN });
  } else {
    body += line('Adjusted from your next paycheck', '-' + fmt(-paycheckAdj), { color: RED });
    body += `<div style="margin-top:8px;font-size:12px;color:${MUTED};line-height:1.5">You took home more cash than your net tips (because part funds the kitchen/busser tip-out), so your paycheck is reduced by that difference. Your total is still ${fmt(p.tipsKept)}${wage > 0 ? ' in tips, plus your wage' : ''}.</div>`;
  }

  const subject = `${RESTAURANT}: your ${ctx.date} ${ctx.daypart} summary — ${fmt(p.tipsKept)} in tips`;
  return { to: ctx.email, subject, html: shell('Your shift summary', body, {
    subline: [p.name, ROLE_LABEL.server, ctx.date, ctx.daypart === 'cafe' ? 'Café' : 'Dinner'].filter(Boolean).join(' · '),
    hero: { label: 'Tips you keep', value: fmt(p.tipsKept), color: GREEN },
  }) };
}

/** Build the email for a support-role employee (kitchen/busser/barista/bartender). */
function supportEmail(p, ctx) {
  const wage = wageCents(p.hours, ctx.hourlyRate);
  let body = '';
  body += line('Hours worked', `${p.hours}`, { border: false });
  if (ctx.salaried) body += line('Pay', 'Salaried');
  else if (wage > 0) body += line('Estimated wage', fmt(wage));

  // Three plain lines — where the money came from, nothing about when or how
  // it lands. Staff already know that; spelling it out just adds noise.
  const cashTips = p.cashTotal != null ? p.cashTotal : 0;
  const togoCard = p.poolCard || 0;
  const serverTipout = p.tipShare || 0;
  const total = cashTips + togoCard + serverTipout;

  body += section('Your tips');
  body += line('Cash tips', fmt(cashTips), { border: false });
  body += line('To-go card tips', fmt(togoCard));
  body += line('Server tip-out (card)', fmt(serverTipout));
  body += line('Total tips', fmt(total), { strong: true, color: GREEN });

  const subject = `${RESTAURANT}: your ${ctx.date} ${ctx.daypart} summary — ${fmt(total)} in tips`;
  return { to: ctx.email, subject, html: shell('Your shift summary', body, {
    subline: [p.name, ROLE_LABEL[p.role] || p.role, ctx.date, ctx.daypart === 'cafe' ? 'Café' : 'Dinner'].filter(Boolean).join(' · '),
    hero: { label: 'Total tips', value: fmt(total), color: GREEN },
  }) };
}

/**
 * Pay-period summary for one person — the same money their nightly emails
 * already covered, totalled up. `r` is a row from aggregatePayroll().
 */
/**
 * Your receipt after sending a shift: who actually received their numbers, who
 * didn't and why, and the totals — so a failed send is something you find in
 * your inbox rather than next payday.
 *
 * @param results  engine.runShift() output
 * @param delivery { sent, previewed, errors:[], recipients:[{name,to,total}] }
 */
function managerShiftEmail(results, meta, delivery) {
  const dayLabel = meta.daypart === 'cafe' ? 'Café' : 'Dinner';
  const failed = delivery.errors || [];
  const ok = delivery.recipients || [];
  const preview = !delivery.sent && delivery.previewed;

  // The shift and the delivery count are the hero and the subline now, so the
  // body opens on whatever actually went wrong.
  let body = '';
  if (failed.length) {
    body += section('Did not go out', { color: RED, first: true });
    // A name and its reason, not a figure — the split is "Joseph — no email
    // on file", so the name carries weight and the reason does not.
    failed.forEach((e) => {
      const t = String(e);
      const cut = t.indexOf('—');
      body += noteRow(cut === -1 ? t
        : `${t.slice(0, cut).trim()} <span style="font-weight:400;color:${MUTED}">— ${t.slice(cut + 1).trim()}</span>`);
    });
    body += hint('These people have no summary for tonight — fix and send again from the shift page.');
  }

  const totalTips = results.reconciliation.totalTipsCollected;
  const potsTotal = Object.values(results.pots).reduce((a, b) => a + b, 0);
  body += section('Tonight');
  body += line('Tips collected', fmt(totalTips), { border: false });
  body += line('Tipped out to support', fmt(potsTotal));
  body += line('Shared pool', fmt(results.pool.cash + results.pool.togoCard));
  if (!results.reconciliation.balanced) {
    body += line('Reconciles', 'NO — check the shift', { strong: true, color: RED });
  }

  if (results.servers.length) {
    body += section('Servers');
    results.servers.forEach((p, i) => {
      body += line(p.name, `${fmt(p.tipsKept)} kept`, { border: i !== 0 });
    });
  }
  if (results.support.length) {
    body += section('Support');
    results.support.forEach((p, i) => {
      const total = (p.tipShare || 0) + (p.poolShare || 0);
      body += line(`${p.name} · ${p.role}`, fmt(total), { border: i !== 0 });
    });
  }

  // Things that were true at send time and are easy to miss on the screen.
  if ((meta.warnings || []).length) {
    body += section('Worth checking');
    meta.warnings.forEach((w) => { body += noteRow(String(w)); });
  }

  const headline = preview ? `${delivery.previewed} previews` : `${delivery.sent} sent`;
  const subject = `${RESTAURANT}: ${meta.date} ${dayLabel} — ${headline}${failed.length ? `, ${failed.length} failed` : ''}`;
  return {
    to: meta.managerEmail,
    subject,
    // "6 of 7" — the total is the quiet half, so it rides as the hero's sub
    // rather than as a second figure. Red the moment one did not land.
    html: shell('Shift sent', body, {
      subline: `${meta.date} · ${dayLabel}`,
      hero: preview
        ? { label: 'Previews written', value: String(delivery.previewed) }
        : { label: 'Emails delivered', value: String(delivery.sent),
            sub: `of ${ok.length + failed.length}`, color: failed.length ? RED : GREEN },
    }),
  };
}

/** "2026-07-04" -> "Jul 4". Kept local so email.js stays free of db imports. */
function shortDate(iso) {
  const [, m, d] = String(iso).split('-').map(Number);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return MON[m - 1] ? `${MON[m - 1]} ${d}` : iso;
}

function periodEmail(r, ctx) {
  const range = `${shortDate(ctx.from)} – ${shortDate(ctx.to)}`;
  let body = '';
  body += line('Shifts worked', String(r.shifts), { border: false });
  body += line('Total hours', String(r.hours));
  if (r.wk1Hours || r.wk2Hours) body += hint(`Week 1: ${r.wk1Hours} hrs · Week 2: ${r.wk2Hours} hrs`);

  body += section('On your paycheck');
  body += line('Wages', fmt(r.wage), { border: false });
  body += line('Card tips', fmt(r.paycheckTips));
  body += line('Total on this check', fmt(r.takeHome), { strong: true, color: GREEN });

  if (r.cashTips) {
    body += section('Already paid to you');
    body += line('Cash tips', fmt(r.cashTips), { border: false });
    body += hint('You already have this — it is not on the check.');
  }

  // The one point staff would otherwise get wrong: this is not additional
  // money. It used to lean on a shell footer that also said "not a pay stub";
  // that footer is gone, so this line now carries the whole job.
  body += `<div style="margin:16px 0 0;padding-top:14px;border-top:1px solid ${EDGE};font-size:12px;color:${MUTED};line-height:1.5">This adds up the shift emails you already received — it isn't extra pay.</div>`;

  const subject = `${RESTAURANT}: pay period ${range} — ${fmt(r.takeHome)} on this check`;
  return { to: ctx.email, subject, html: shell('Pay period summary', body, {
    subline: [r.name, range].filter(Boolean).join(' · '),
    hero: { label: 'On this check', value: fmt(r.takeHome), color: GREEN },
  }) };
}

/** One email per person with anything to report in the period. */
function buildPeriodEmails(rows, meta, people) {
  return rows
    .filter((r) => r.hours > 0 || r.wage > 0 || r.paycheckTips > 0 || r.cashTips > 0)
    .map((r) => {
      const info = people.get(r.employeeId) || {};
      return { employeeId: r.employeeId, name: r.name, ...periodEmail(r, { ...meta, email: info.email }) };
    });
}

/**
 * Build every employee's email for a shift.
 * @param results  engine.runShift() output
 * @param meta     { date, daypart }
 * @param people   Map employeeId -> { email, hourlyRate }
 */
function buildEmails(results, meta, people) {
  const emails = [];
  const skipped = results.skippedPots || [];
  for (const p of results.servers) {
    const info = people.get(p.employeeId) || {};
    emails.push({ employeeId: p.employeeId, name: p.name, ...serverEmail(p, { ...meta, skipped, email: info.email, hourlyRate: info.hourlyRate, salaried: info.salaried }) });
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
      html: shell('Test email',
        line('Status', 'Working', { border: false, color: GREEN })
        + `<div style="margin:12px 0 0;font-size:13px;color:${LABEL};line-height:1.5">If you can read this, ${RESTAURANT} can send nightly tip summaries to your staff.</div>`,
        // Serif, not mono: "Connected." is a word, and the mono face is for
        // figures. The one hero on any of these that is not a number.
        { hero: { label: 'Mail', value: 'Connected.', color: GREEN, serif: true } }),
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
  const out = { sent: 0, previewed: 0, files: [], errors: [], recipients: [] };

  if (!t) {
    // Preview mode: write HTML files so you can eyeball them before wiring email.
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    for (const e of emails) {
      const safe = (e.name || 'employee').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      const file = path.join(PREVIEW_DIR, `${safe}.html`);
      fs.writeFileSync(file, e.html);
      out.files.push(file);
      out.previewed++;
      out.recipients.push({ name: e.name, to: e.to });
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
      out.recipients.push({ name: e.name, to: e.to });
    } catch (err) {
      out.errors.push(`${e.name}: ${friendlyMailError(err)}`);
    }
  }
  return out;
}

module.exports = { buildEmails, buildPeriodEmails, managerShiftEmail, sendEmails, sendTest, mailStatus, friendlyMailError, serverEmail, supportEmail, periodEmail, PREVIEW_DIR, RESTAURANT };
