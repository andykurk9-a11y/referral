# Deploying the Referral &amp; Results Tracker

Three supported shapes, easiest first:

| | Signups | Database | Best for |
|---|---|---|---|
| **A — Render** | one | none needed | getting a demo in front of people today |
| **B — Netlify + Turso** | two | Turso | matching how the DME Stock Tracker is hosted |
| **C — anywhere Node runs** | none | none needed | Docker, a VM, on-prem |

The difference that matters: **Netlify Functions have no writable disk**, which is the
entire reason that path needs a separate hosted database. Render and any ordinary Node
host have a filesystem, so the app just uses a local SQLite file and there is no database
step at all.

> **Before real patient data:** read the *Data protection* section of `README.md`.
> The app ships with a demo banner enabled and the work-comp escalation block disabled,
> and neither should change before Privacy &amp; Compliance has signed off. Confirm the
> host is covered by an appropriate BAA, or host somewhere that is.

---

## Option A — Render

One signup, no database service, no environment-variable scoping to get wrong.

### 1. Deploy

1. Sign in at **render.com** (GitHub login is easiest).
2. **New → Blueprint**.
3. Pick **`andykurk9-a11y/referral`**. Render reads `render.yaml` from the repo and
   proposes a service called `referral-tracker` — you do not have to fill in the build
   command, start command or any other setting.
4. It will prompt for **`REF_LEADERSHIP_PASSWORD`**. Choose something strong; that is
   your first sign-in. Everything else is already set in the blueprint.
5. **Apply / Create**. First build takes 3–5 minutes.

### 2. Open it

Render gives you a URL like `https://referral-tracker.onrender.com`.

- Staff worklist: `/`
- Leadership: `/admin.html`

The blueprint sets `REF_AUTOSEED=true`, so the demo data is already there — sign in with
PIN **5218** (Portage), **5220** (Kalamazoo) or **5231** (Battle Creek) and the worklist
is populated. Change those PINs in Leadership → Sites &amp; facilities.

### 3. Know the free-tier trade-offs

- **The disk is ephemeral.** Every restart and redeploy wipes the database. `REF_AUTOSEED`
  repopulates the demo data on boot — but only ever into a completely empty orders table,
  so it can never overwrite real work.
- **The service sleeps after ~15 minutes idle.** The first request afterwards takes
  roughly 50 seconds to wake it. Load the page a minute before a demo starts.

Neither matters for showing people how it works. Both matter the moment it holds anything
real — see *Keeping data* below.

### 4. Keeping data (when it stops being a demo)

1. Upgrade the service to **Starter**.
2. In `render.yaml`, uncomment the `disk:` block at the bottom and move it under the
   service.
3. Set `REF_DATA_DIR=/var/data` and `REF_AUTOSEED=false`.
4. Redeploy, then wipe the demo data from Leadership before entering anything real.

---

## Option B — Netlify + Turso

Matches the DME Stock Tracker's hosting. Netlify serves `public/` from its CDN and runs
Express as a single Function; `netlify.toml` already has the routing, bundling and the
scheduled reminder job.

### 1. Create the database

Netlify Functions have no disk, so this step is not optional.

1. **app.turso.tech** → sign up → **Create Database**, named e.g. `referral-tracker`.
2. Copy the **connection URL** (starts `libsql://`).
3. **Create Token** and copy it — usually shown only once.

Or via the CLI:

```bash
turso db create referral-tracker
turso db show referral-tracker --url
turso db tokens create referral-tracker
```

The schema builds itself on first boot; there is no migration to run.

### 2. Create the site

**Add new site → Import an existing project → GitHub → `andykurk9-a11y/referral`.**
Leave every build setting alone — they come from `netlify.toml`.

### 3. Environment variables

**Site configuration → Environment variables.**

| Variable | Required | Notes |
|---|---|---|
| `TURSO_DATABASE_URL` | yes | from step 1 |
| `TURSO_AUTH_TOKEN` | yes | from step 1 |
| `REF_LEADERSHIP_PASSWORD` | yes | change again in Settings after first sign-in |
| `REF_SESSION_SECRET` | recommended | any long random string |
| `SMTP_*` | for email | see below |

Two settings on each variable decide whether the running function can actually see it,
and both are easy to miss:

- **Scopes** must include **Functions**. A variable scoped to Builds only is visible
  during `npm install` and invisible to the app at runtime.
- **Deploy contexts** — the value must apply to **Production**, not just deploy previews.

Then **Deploys → Trigger deploy → Deploy project** (the option formerly called *Clear
cache and deploy site* is now *Deploy project without cache*; either picks up new
variables, the no-cache one just also discards `node_modules`).

### 4. If the site returns 502

The function logs the reason. **Functions → `api` → Logs**, reload the site, and read the
newest entry — it names the missing variable and lists which configuration variables the
function can actually see, which distinguishes "never set" from "scoped away from
Functions".

---

## Option C — anywhere Node runs

```bash
git clone https://github.com/andykurk9-a11y/referral.git
cd referral
npm install
REF_LEADERSHIP_PASSWORD='choose-something-strong' npm start
```

Serves on port 3000 (`PORT` to change), storing the database at `data/referral.db` —
persist that directory and you keep everything. In this mode the app runs its own hourly
reminder scheduler, so no cron service is needed.

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

## Email

Optional to run. With no `SMTP_*` set, digests are still built and previewable in
**Leadership → Reminders → Preview digest**; nothing is sent and the UI says so rather
than failing.

| Variable | Example |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` for 587, `true` for 465 |
| `SMTP_USER` | the sending mailbox |
| `SMTP_PASS` | see below |
| `SMTP_FROM` | `Referral Tracker <alerts@yourclinic.org>` |

- **Gmail** needs an **App Password**, not the account password, and App Passwords require
  2-Step Verification to be enabled first.
- **Brevo / Sendinblue** returned `535 authentication failed` during the DME rollout — its
  SMTP key is generated separately from the login password.
- **Microsoft 365** was ruled out there; basic SMTP auth is disabled on most tenants.

Then: **Reminders → Send test email** to prove it, and **Settings → Send daily reminder
digests** to turn it on.

---

## After deploying

- [ ] Leadership password changed from whatever you set at deploy time
- [ ] Site PINs changed from the demo values (5218 / 5220 / 5231)
- [ ] Facilities and carriers match how staff actually refer to them — the scorecard
      aggregates on facility, so duplicates split one partner into two rows
- [ ] Recipients configured per site
- [ ] Test email delivered
- [ ] Reminders switched on
- [ ] Ladder thresholds reviewed — the defaults are a starting point to tune after ~60 days
      of real data, not a finding
- [ ] Weekly reconciliation against an EMR order report scheduled, with a named owner —
      the control against the highest-severity failure mode, an order placed but never
      entered
- [ ] `REF_AUTOSEED` set to `false` and demo data cleared before any real use
- [ ] Demo banner turned off **only** after Compliance sign-off
