# Kerala Commerce Career Connection Kit

Single-page career kit for B.Com and BBA students, presented by Finishing School India (FSI). It follows the approved design in `career2.html` and the copy in the *KCCC Kit For Website 30.10* deck. The production backend adds enquiry capture, CRM forwarding, a WhatsApp hand-off, an admin leads view and drop-off analytics.

No dependencies. Needs Node 18 or later.

```bash
cp .env.example .env    # then set ADMIN_PASSWORD, WHATSAPP_NUMBER, CRM_WEBHOOK_URL
npm start               # http://localhost:3000   admin: http://localhost:3000/admin
```

## Files

| Path | What it is |
|---|---|
| `public/index.html` | The student kit (hub + 7 levels in modals). All deck copy lives in the DATA block at the top of the script. |
| `public/assets/logos.js` | FSI, software and professional body logos taken from the deck, as data URIs. |
| `admin/admin.html` | Admin view, served at `/admin` behind HTTP Basic auth. Not publicly reachable. |
| `server.js` | Static server + API + storage. |
| `build.js` | Builds `dist/kccc-kit.html`, the kit as one self-contained HTML file. |
| `data/` | `leads.json` (enquiries) and `events.jsonl` (analytics). Back this folder up. |

## What happens to data

- **While a student uses the kit**, the profile and answers stay in their browser (`localStorage`). Nothing is sent.
- **Privacy notice**: shown before Level 1 the first time, with an "I understand, continue" step. It is also linked from the footer and the enquiry form. It includes a "Clear my saved data on this device" button. The notice version (`2026-11-v1`) is stored with each lead's consent.
- **Enquiry** (Level 7): `POST /api/leads` with the profile, contact, labelled answers, suggested areas, preferred path, explored area and summary. The server checks the name, the phone number (10–15 digits) and consent. It also has a honeypot field against bots and a limit of 10 enquiries per IP per hour. The Level 6F mini-challenge notes are **never** sent, because the kit tells students "Your notes stay on this device".
- **CRM**: if `CRM_WEBHOOK_URL` is set, each lead is POSTed as `{"event":"lead.created","lead":{…}}` and retried up to 3 times. If `CRM_WEBHOOK_SECRET` is set, the request carries `X-KCCC-Signature: sha256=<hmac>`. The delivery status appears in the admin CRM column.
- **WhatsApp**: if `WHATSAPP_NUMBER` is set, the confirmation screen shows "Continue on WhatsApp". It opens `wa.me` with a short prefilled message: reference, name, area and topic (no phone number).
- **Analytics**: anonymous events (`visit`, `open` level n, `complete` level n), keyed by a random ID kept in `localStorage`. Enquiries are counted on the server. The admin funnel shows unique visitors who opened and completed each level, and the drop-off percentage, for 7, 30 or 90 days or all time.

## Admin

`/admin`: KPIs, the drop-off funnel, and a searchable enquiry table with status (new / contacted / enrolled / closed). Click a row to see the full snapshot, consent record and answers, add a counsellor note, or delete the enquiry (for erasure requests). **Export CSV** downloads every lead. Cells are guarded against spreadsheet formula injection.

## Standalone HTML

```bash
node build.js https://kit.your-domain.example
```

This writes `dist/kccc-kit.html`, with the logos inlined and enquiries and analytics posted to that server. Add the page's origin to `ALLOWED_ORIGINS` on the server. Without a URL, the file posts to wherever it is served from. Opened straight from disk, it works through all seven levels, but an enquiry shows a "could not send" error.

## Deploying

Run `npm start` behind HTTPS (nginx, Caddy, Render, Railway, a VPS…). Set `TRUST_PROXY=1` behind a proxy and keep `data/` on persistent disk. Change `ADMIN_PASSWORD` from the default in `.env`.

## Before going live — needs FSI review

- **Privacy notice wording** (`PRIVACY` in `public/index.html`) is a draft, not in the deck. Have it checked against FSI's policy and India's DPDP Act. Add a contact email or phone for data requests. If enquiries are shared with ENS Global Education (named on the expert slide), the notice must say so.
- **Brand colours** come from the crest in the deck. If fsiedu.com publishes official hex codes, replace the tokens at the top of the CSS in both HTML files.
- **Deck copy**: two body names were shortened in the reference build and are now restored word for word (CPA, ACCA). The deck's typos on slide 15 (PGD-AIFA) stay corrected as they were in the approved build.
