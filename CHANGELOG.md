# Changelog

All notable changes to the Referral &amp; Results Tracker, newest first.

## [1.0.0] — 2026-08-07 — First working version

The tracker described in the *Physical Therapy &amp; Outpatient Imaging Results Tracker*
proposal, built so leadership and IT can use it rather than read about it.

**Tracking orders**

- Physical therapy, occupational therapy, MRI and CT orders, for work comp and
  non-work-comp patients alike.
- Four touchpoints: order placed, follow-up scheduled, result received, provider review.
- Imaging closes at provider review. **Therapy does not** — it returns to open awaiting the
  response back to PT, and then the next progress-note cycle, which is how the loop
  actually works.
- Outcomes that acknowledge reality: patient no-showed, went to another facility, cancelled
  by provider, cancelled by carrier, patient discharged, claim closed. Modelling only the
  happy path pushes real outcomes into free text where no report can find them.
- Append-only event log on every order — every status change and every outreach attempt.

**Three escalation ladders**

- Follow-up readiness (`T-10` → `T-0`) counting **down** to the appointment.
- Authorization aging (`A-1` → `A-5`) counting **up** from the request, so a stalled
  authorization surfaces long before the follow-up gets close.
- PT progress notes (`P-1` → `P-5`), including the catch for a note that never arrived.
- All thresholds are business days and editable in Settings without a deploy.

**Reminders by email**

- One digest per site per day, split into three role-tagged sections — results due before a
  follow-up, authorizations aging, PT notes awaiting review or response.
- At most one per site per calendar day, so the scheduled function is safe to run often.
- Preview and test-send from Leadership.
- Works with no SMTP configured: digests are built and previewable, nothing is sent, and
  the app says so instead of failing.

**Leadership**

- North-star metric: the percentage of follow-ups that had every expected result in hand.
- Vendor scorecard — median days from order to result by facility, slowest first.
- Open orders by severity, median authorization decision time, and a count of therapy
  orders with no expected-result date (those are invisible to the `P-5` catch).
- CSV export.

**Data protection**

- **No direct patient identifiers anywhere** — no name, date of birth, phone or address in
  the schema, API, UI or seed data. A free-text `reference` is the only handle, resolved in
  the EMR.
- The work-comp escalation block (claim number, employer, adjuster, case manager) is off by
  default and **rejected by the API**, not merely hidden, until leadership enables it.
- Demo banner enabled by default.

**Operations**

- Per-site staff PINs and a leadership password, on stateless signed cookies so it works on
  serverless hosts.
- Runs on Netlify + Turso, or anywhere Node runs with a local SQLite file and no
  configuration at all.
- Seed data placed deliberately at every rung of all three ladders, so the worklist,
  digest and dashboard have something real to show immediately.
- Ladder engine test suite (`npm test`).
