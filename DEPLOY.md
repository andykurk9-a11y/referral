# Deploying the Referral &amp; Results Tracker

Two supported shapes:

- **Netlify + Turso** — serverless, no server to maintain. What the DME Stock Tracker uses.
- **Anywhere Node runs** — a single process with a local SQLite file. Docker, a VM,
  Railway, Render, on-prem.

> **Before real patient data:** read the *Data protection* section of `README.md`.
> The app ships with a demo banner enabled and the work-comp escalation block disabled,
> and neither should be changed before Privacy &amp; Compliance has signed off. Confirm
> that Netlify and Turso are covered by an appropriate BAA, or host somewhere that is.

---

## Option A — Netlify + Turso

### 1. Create the database

[Turso](https://turso.tech) free tier is enough to start.

```bash
turso db create referral-tracker
turso db show referral-tracker --url        # → TURSO_DATABASE_URL
turso db tokens create referral-tracker     # → TURSO_AUTH_TOKEN
```

The schema is created automatically on first boot — there is no migration step to run.

### 2. Connect the repository

In Netlify: **Add new site → Import an existing project → GitHub →
`andykurk9-a11y/referral`**.

Build settings come from `netlify.toml` and need no changes:

| Setting | Value |
|---|---|
| Build command | `npm install` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |

### 3. Set environment variables

**Site settings → Environment variables.**

| Variable | Required | Notes |
|---|---|---|
| `TURSO_DATABASE_URL` | yes | from step 1 |
| `TURSO_AUTH_TOKEN` | yes | from step 1 |
| `REF_LEADERSHIP_PASSWORD` | yes | strong; change again in Settings after first sign-in |
| `REF_SESSION_SECRET` | recommended | any long random string; otherwise generated and stored on first boot |
| `SMTP_HOST` | for email | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | for email | `587` |
| `SMTP_SECURE` | for email | `false` for port 587, `true` for 465 |
| `SMTP_USER` | for email | the sending mailbox |
| `SMTP_PASS` | for email | see the note below |
| `SMTP_FROM` | optional | `Referral Tracker <alerts@yourclinic.org>` |

Deploy. The site comes up with the sites, facilities, carriers and providers listed in
the JSON config files.

### 4. Turn on reminders

1. Sign in to `/admin.html`.
2. **Change the leadership password.**
3. **Reminders → Recipients** — add at least one address per site. A site with no
   recipients gets no digest.
4. **Reminders → Send test email** to prove the credentials work.
5. **Settings → Send daily reminder digests** — on.

The scheduled function `reminders-cron` runs daily at 12:00 UTC (`netlify.toml`). It
sends at most one digest per site per calendar day, so changing the cron to run more
often is safe.

---

## A note on SMTP

Email is the reminder mechanism, so it is worth getting right — and it is the one part
most likely to bite.

- **Gmail** requires an **App Password**, not the account password, and App Passwords
  require 2-Step Verification to be enabled first. Use
  `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`.
- **Brevo / Sendinblue** returned `535 authentication failed` during the DME tracker
  rollout; the SMTP key must be generated separately from the login password.
- **Microsoft 365** was ruled out during that rollout — basic SMTP auth is disabled by
  default on most tenants.

The app degrades gracefully: with no SMTP configured, digests are still built and can be
previewed in **Leadership → Reminders → Preview digest**. Nothing is sent, and the UI
says so plainly rather than failing.

---

## Option B — anywhere Node runs

No Turso, no Netlify. Uses a local SQLite file at `data/referral.db`.

```bash
git clone https://github.com/andykurk9-a11y/referral.git
cd referral
npm install
REF_LEADERSHIP_PASSWORD='choose-something-strong' npm start
```

Serves on port 3000 (`PORT` to change). In this mode the app runs its own hourly
scheduler, so the Netlify cron function is not used.

Persist the `data/` directory — that is the whole database.

### Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t referral-tracker .
docker run -d -p 3000:3000 \
  -v referral-data:/app/data \
  -e REF_LEADERSHIP_PASSWORD='choose-something-strong' \
  --name referral-tracker referral-tracker
```

---

## After deploying

- [ ] Leadership password changed from the default
- [ ] Sites and staff PINs set (**Sites &amp; facilities**)
- [ ] Facilities and carriers match how staff actually refer to them — the scorecard
      aggregates on facility, so duplicates split the data
- [ ] Recipients configured per site
- [ ] Test email delivered
- [ ] Reminders switched on
- [ ] Ladder thresholds reviewed (**Settings**) — the defaults are a starting point, to be
      tuned after ~60 days of real data, not a finding
- [ ] Weekly reconciliation against an EMR order report scheduled with a named owner —
      this is the control against the highest-severity failure mode, an order that is
      placed but never entered
- [ ] Demo banner turned off **only** after Compliance sign-off
