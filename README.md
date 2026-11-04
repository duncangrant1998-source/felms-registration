# FEL Motorsports — Registration & Credential Desk

A small Node/Express app with two sides:

- **Team Portal** (`/portal`) — teams sign in with an access code staff gives them, add their
  drivers/crew (first name, last name, headshot), view weekend documents, and request extra
  credentials if they need more than their allowance.
- **Staff Desk** (`/staff`) — a single shared staff password. Staff create teams and set their
  credential allowances, see every team's roster compiled live as members register, check
  members in (credential / speed waiver / regs acknowledgement), print auto-generated hard cards,
  manage the document library, and review credential purchase requests.

Visual style matches the FEL Motorsports OS app (dark theme, red accent, bold uppercase display
type) and the original registration/credential-desk reference build.

## Stack

Plain Node.js + Express + EJS views + PostgreSQL (`pg`), sessions via `express-session`, file
uploads via `multer`. No build step, no frontend framework — it's one small server.

## Local setup

> This build was written without a local Node.js install available to test against — install
> Node 18+ and run through the steps below before you rely on it; flag anything that doesn't
> behave as described.

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — a Postgres connection string (local Postgres, or point it at your Railway
  Postgres instance for local testing against real data).
- `STAFF_PASSWORD` — the shared password staff use at `/staff/login`.
- `SESSION_SECRET` — any long random string.
- `EVENT_NAME` — shown in headers across the app.

```bash
npm start
```

The app creates its tables automatically on first boot (see `src/db.js`). Visit
`http://localhost:3000`, then:

1. Go to **Staff Login**, sign in with `STAFF_PASSWORD`.
2. Open **Teams & Allowances** and add a team — this generates an access code.
3. Hand that access code to the team (or test it yourself) at **Team Login**.
4. Add a member with a headshot in the portal, then check it in from the staff **Roster** view
   and print its card under **Hard Cards**.

## Deploying to Railway

1. Push this folder to a GitHub repo (or `railway up` directly from here) and create a new
   Railway service from it.
2. Add a **Postgres** plugin to the project — Railway sets `DATABASE_URL` on the service
   automatically; no extra config needed.
3. Attach a **Volume** to the service mounted at e.g. `/data`, and set `UPLOAD_DIR=/data/uploads`
   in the service's variables. Without a volume, uploaded headshots and documents are lost on
   every redeploy (Railway's filesystem is ephemeral otherwise).
4. Set `STAFF_PASSWORD`, `SESSION_SECRET`, and `EVENT_NAME` in the service's Variables tab.
5. Deploy. Railway runs `node server.js` (see `Procfile` / `railway.json`).
6. To fold this into the existing FEL Motorsports OS app, either link to this service's Railway
   domain from the main app's nav, or put it behind the same custom domain on a subpath/subdomain
   (e.g. `register.felmotorsports.com`) via Railway's domain settings.

## Payments (not wired up yet)

The **Credentials** page in the portal lets a team submit a request for extra credentials beyond
their allowance. Right now that just creates a row staff can see and action under **Credential
Requests** — there's no payment link or API call yet. When you're ready to wire up real payments:

- Add the payment provider's checkout/payment-link creation call in
  `src/routes/portal.js` (`POST /credentials/request`), store the resulting link/session id on
  the `credential_requests` row, and show it to the team.
- Handle the provider's webhook in a new route to mark the request `fulfilled` and bump the
  team's `annual_limit` / `single_limit` in `src/routes/staff.js`'s team-update logic (or do it
  automatically from the webhook).

## Data model

Four tables (`src/db.js`): `teams`, `members`, `documents`, `credential_requests`. Headshots and
uploaded documents are stored as files under `UPLOAD_DIR` (default `./uploads`), referenced by
path in the DB — not in the database itself.

## Notes / things to revisit before relying on this at an event

- Sessions use the default in-memory store — fine for one Railway instance, but sessions are lost
  on redeploy/restart and won't share state if you ever scale to multiple instances. Swap in
  `connect-pg-simple` (or similar) if that becomes a problem.
- Team access codes are a shared-secret per team, not individual logins — anyone with the code can
  edit that team's roster. That matches how the allowance/limits model already worked in the
  original reference file, but say the word if you'd rather have per-person accounts.
- Hard cards print via the browser's print dialog (`/staff/cards` → **Print this sheet**), sized
  for standard CR80 ID card stock (3.375" × 2.125"). Check actual alignment against your printer/
  card stock before an event and adjust `.cred-card` sizing in `public/css/theme.css` if needed.
