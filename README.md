# Referral &amp; Results Tracker

Tracks physical therapy and outpatient MRI/CT orders so the result is **in hand before
the patient's follow-up visit** — and escalates, by email, when it is not.

Built as a working example of the process described in the *Physical Therapy &amp;
Outpatient Imaging Results Tracker* proposal. Same stack as the DME Stock Tracker
(Express + libSQL/Turso + Netlify), so it deploys and is maintained the same way.

---

## The problem it solves

A provider orders PT or an MRI. The order leaves the building and enters a black box.
Nothing systematically tells us whether authorization was ever requested, whether the
patient attended, whether the report came back, or whether a provider reviewed it — and
above all, whether any of that will be true by the time the patient walks in for their
follow-up.

The existing process can only react to documents that *arrive*. **It is blind to the
ones that don't.** That is what this app fixes.

---

## What it does

### Three escalation ladders

Each order is continuously scored against three independent ladders. An order can sit on
all three at once; the most severe rung colours its row.

| Ladder | Direction | Rungs |
|---|---|---|
| **Follow-up readiness** | counts **down** to the appointment | `T-10` sweep → `T-7` first outreach → `T-3` escalate → `T-1` decision required → `T-0` flag the schedule |
| **Authorization aging** | counts **up** from the request | `A-1` chase carrier → `A-2` escalate → `A-3` formal escalation → `A-4` denied, peer-to-peer → `A-5` approved but never scheduled |
| **PT progress notes** | the two-way loop | `P-1` received → `P-2` review reminder → `P-3` review overdue → `P-4` response to PT overdue → `P-5` expected note never arrived |

Three ladders rather than one, because they fail on different clocks. An authorization
can stall for three weeks while the follow-up is still comfortably distant — a single
countdown keyed on the appointment would not surface it until far too late. And a
progress note that never arrives produces no signal at all unless something is watching
the date it was *expected*.

All thresholds are business days and are editable in **Leadership → Settings** without a
deploy.

### Five worklist views

Daily worklist · Authorizations aging · Awaiting provider review · PT response
outstanding · All open.

### Daily email digest

One email per site per day, split into three role-tagged sections — results due before a
follow-up (tracker owner), authorizations aging (authorization coordinator), PT notes
awaiting review or response (ordering provider). At most one per site per day.

### Vendor scorecard

Median days from order to result **by facility**, slowest first. This falls out of data
staff already enter, and it is what turns the tracker from a cost-avoidance story into a
performance-management capability.

### Four touchpoints, and the loop that reopens

1. **Order placed** — create the record.
2. **Follow-up scheduled** — link the appointment date. *The keystone: every reminder counts down to it.*
3. **Result received** — stamp it and route to the provider.
4. **Provider review** — imaging **closes** here; therapy does **not**. A PT order returns
   to open awaiting the response back to PT, and then the next progress-note cycle. A PT
   record's life is measured in months.

---

## Data protection — read this before deploying

**There are no direct patient identifiers in this application.** No name, date of birth,
phone number or address exists in the schema, the API, the UI or the seed data. The only
handle on a patient is `orders.reference` — a free-text value the clinic chooses (an EMR
order number, an internal ticket id) which staff resolve back to a person inside the EMR.

**This is not HIPAA Safe Harbor de-identification, and the app does not claim to be.**
Safe Harbor requires removing all dates more specific than a year; this tracker is built
*of* dates — follow-up, authorization request, expected result — and cannot function
without them. What it delivers is a *no direct identifiers* posture: materially safer and
far easier to sign off than name + date of birth + claim number, but still requiring
Privacy &amp; Compliance review before any real use.

### The work-comp escalation block

Claim number, employer, adjuster name and contact, and nurse case manager exist in the
schema but are **off by default**. While off:

- the fields are hidden in the UI, **and**
- the API **rejects** them with a 400 rather than silently dropping them, **and**
- they are stripped from every API response.

The gate is enforced server-side, in `lib/wcblock.js` — a hidden input is a convenience,
a rejected field is a control. Leadership can enable the block in **Settings** once
Compliance has signed off.

### Before real patient data goes in

- [ ] HIPAA security risk assessment addendum for this system
- [ ] Confirm the hosting provider (Netlify) and database provider (Turso) are covered by
      an appropriate BAA, or move to hosting that is
- [ ] Decide and document what goes in the `reference` field
- [ ] Apply the organisation's retention schedule
- [ ] Turn off the demo banner (Settings) only once the above are done

A demo banner reading *"do not enter real patient information"* ships **enabled**.

---

## Running it locally

No configuration needed — it uses a local SQLite file.

```bash
npm install
npm run seed     # demo data placed deliberately at every rung of all three ladders
npm start
```

- Staff worklist: <http://localhost:3000/>
- Leadership: <http://localhost:3000/admin.html>

The seed prints the site PINs. The default leadership password is `changeme` unless
`REF_LEADERSHIP_PASSWORD` is set — change it immediately in Settings.

```bash
npm test         # ladder engine tests
```

---

## Configuration

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL` | Hosted database. **Omit for a local SQLite file.** |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `REF_LEADERSHIP_PASSWORD` | Initial leadership password |
| `REF_SESSION_SECRET` | Session signing secret (auto-generated and stored if unset) |
| `REF_DATA_DIR` / `REF_DB_PATH` | Local database location |
| `SMTP_HOST`, `SMTP_PORT` | Required to actually send email |
| `SMTP_SECURE` | `true` for implicit TLS (port 465); `false` for STARTTLS (587) |
| `SMTP_USER`, `SMTP_PASS` | SMTP credentials |
| `SMTP_FROM` | e.g. `Referral Tracker <alerts@yourclinic.org>` |

**Email is optional to run.** With no `SMTP_*` set, digests are still built, still
previewable in Leadership → Reminders, and the app reports "SMTP is not configured"
rather than erroring. Nothing is delivered until credentials exist.

Reference data is seeded on first boot from `sites.json`, `facilities.json`,
`carriers.json` and `providers.json`. Provisioning is idempotent — existing rows and any
edits made in the app are never overwritten.

---

## How it is put together

```
db.js                 schema + migrations; local-file ↔ Turso switch
server.js             all API routes
seed.js               demo data generator
lib/ladders.js        the rung engine — pure functions, no DB access
lib/reminders.js      per-site digests, daily dedup, scheduled runner
lib/wcblock.js        server-side gate on the work-comp escalation fields
lib/auth.js           per-site staff PINs + leadership password (stateless signed cookies)
lib/mailer.js         SMTP wrapper
lib/provision.js      first-run seeding from the JSON config
public/               staff worklist and leadership pages (vanilla JS, no build step)
netlify/functions/    serverless entry point + the scheduled digest
test/ladders.test.js  ladder engine tests
```

Two design rules worth keeping:

**The EMR remains the clinical record.** This app holds workflow state only — that a
report was received and reviewed, never its content. It keeps the compliance footprint
small and means nothing clinical has to be migrated if this later moves into the EMR.

**The event log is append-only.** In work comp it is discoverable; it is never edited or
deleted, only added to.

---

## Known limitations

- **Business-day maths ignores public holidays.** A Thanksgiving week reads one day more
  generous than reality. A holiday table is the fix if it matters.
- **No per-person accounts.** Sign-in is per site, and actions are attributed by typed
  name. `lib/auth.js` is structured so per-user accounts can be layered on.
- **Orders are entered by hand.** The highest-severity failure mode is an order that is
  placed but never entered — the tracker then reports green while the patient is
  unprotected. Until an EMR order feed exists, reconcile weekly against an EMR order
  report.

See `DEPLOY.md` for hosting.
