# Restaurant Ops — Phase 1 (Nightly Close)

A back-office tool for the restaurant. Phase 1 covers the daily-friction stuff:
enter a shift's sales, tips, and hours → the tip-out is calculated to the penny →
every employee gets an email showing what they made.

## What's here now

**Nightly close (Phase 1)**
- **Tip-out engine** — your exact policy (per-server, based on their own sales;
  pools split among support staff by hours). Verified by tests.
- **Nightly-close screen** — enter servers' sales/card-tips/hours and support hours.
- **No-login cash-tip page** for staff (`/tips`) — name + PIN, 10 seconds.
- **Daily emails** — per employee, with the "cash-in-hand vs. what you keep" line.
- **Benugin webhook** (`/webhook/benugin`) — the POS pushes end-of-batch data,
  secured with a shared secret. Manual entry is the backup for any missed night.

**Trackers (Phase 2, all manual entry)** — config-driven sections in `src/modules.js`:
- **Expirations** ⏰ — licenses, permits, insurance; sorted soonest-first, color-coded
  (red ≤7d, amber ≤30d, yellow ≤60d), with a dashboard alert banner.
- **Invoices** 🧾 — upload a PDF/photo, assign to a vendor, amount, category, paid/unpaid.
- **Vendors** 🚚 — sites, account #, rep, order notes. (Stores a username + a note of
  *where* the password lives — never the password itself; the DB isn't encrypted.)
- **Contacts** 📇, **Equipment** 🔧 (warranty dates feed the expiry alerts),
  **Documents** 📁 (payroll/tax/lease uploads).
- **Incident log** 🚨 — append-only (can't be edited/deleted) for legal defensibility.
- **Decisions log** 📝 — what you changed and why.

Add a new tracker by appending one object to `MODULES` in `src/modules.js` — no new plumbing.

## Run it

```bash
npm install
npm run seed     # optional: sample staff + one demo shift
npm start        # → http://localhost:4000
npm test         # runs the tip-out math tests
```

Open **http://localhost:4000**. With the seed data, click the `2026-07-16 · Dinner`
shift → **Preview & send** to see the tip-out and generate email previews (written
to the `previews/` folder as HTML files you can open).

## Turning on real email

1. Copy `.env.example` to `.env`.
2. Add a Gmail **App Password** (Google account → Security → 2-Step Verification →
   App passwords). Put it in `GMAIL_APP_PASSWORD`.
3. Restart. Now "Send" actually emails staff.

## Connecting Benugin (when the developer is ready)

1. Set `WEBHOOK_SECRET` in `.env` to a long random string; give the dev the same value.
2. The dev POSTs JSON to `http://YOUR_HOST/webhook/benugin` with header
   `x-webhook-secret: <that value>`. Body shape:

```json
{
  "date": "2026-07-16",
  "daypart": "dinner",
  "servers": [
    { "pos_id": "S-01", "name": "Ana Reyes", "food": 2100, "coffee": 180,
      "alcohol": 0, "card_tips": 320, "hours": 6 }
  ]
}
```

Match is by `pos_id` (set it on each server under **Staff**), falling back to name.
`cash_tips` is optional — if Benugin doesn't send it, staff enter cash on `/tips`.

## The tip-out policy (edit in `src/engine.js`)

Each server tips out on **their own** sales:
kitchen 1.5% of food · barista 1.5% of coffee · bartender 5% of alcohol (dormant
until the liquor license) · busser 13% of what's left. Each pool is then split
among the people in that role **by hours worked**. Card tips land on the Gusto
paycheck; cash is taken home nightly and reconciled on the email.

## Roadmap (next phases)

- Pull hours from **Connecteam**, employees + pay rates from **Gusto**.
- Dashboard math: labor %, food cost %, prime cost, sales vs. last week.
- Expiration tracker (liquor license, health, insurance…) with 60/30/7 alerts.
- Then: vendors, receipts, equipment, contacts, par levels, incident log.
