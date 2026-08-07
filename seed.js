'use strict';

/**
 * Demo data generator: `npm run seed`.
 *
 * Orders are placed *deliberately* at every rung of all three ladders rather
 * than randomly, so the worklist, the digest and the dashboard all have
 * something real to show the moment the app starts — and so ladder behaviour
 * can be eyeballed without waiting for time to pass.
 *
 * All dates are computed backwards/forwards from today, so the seed stays
 * meaningful whenever it is run.
 *
 * NOTE ON THE DATA: references are invented strings like "ORD-40218". There are
 * no names, dates of birth, or contact details here or anywhere in the schema —
 * see README.md.
 */

const db = require('./db');
const auth = require('./lib/auth');
const provision = require('./lib/provision');

// --- date helpers ----------------------------------------------------------

function iso(d) {
  return d.toISOString().slice(0, 10);
}
function shift(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
/** Business days from today (negative = in the past), landing on a weekday. */
function bizFromToday(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  // If today is a weekend and n was 0, nudge to the next weekday.
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + step || 1);
  return iso(d);
}

/**
 * Business-day lag added to each facility's result date, indexed by the
 * facility's position in its pool. Turns a flat scorecard into a ranked one:
 * the third facility in each list is visibly the slow one.
 */
const FACILITY_LAG = [0, 3, 8];

// Side-neutral: the laterality column supplies left/right, so a body part must
// not carry a side of its own or the two contradict each other in the UI.
const BODY_PARTS = ['Lumbar spine', 'Shoulder', 'Knee', 'Cervical spine',
  'Wrist', 'Ankle', 'Hip', 'Thoracic spine'];

let refCounter = 40200;
function nextRef() {
  refCounter += Math.floor(Math.random() * 7) + 3;
  return `ORD-${refCounter}`;
}

/**
 * Generate the demo data.
 *
 * `wipe: true` (the CLI default) clears existing orders first. `wipe: false` is
 * used by the boot-time auto-seed, which only ever runs against an empty table —
 * nothing this function does may destroy data someone cares about unless they
 * explicitly asked for it.
 */
async function run({ wipe = true, quiet = false } = {}) {
  const say = (...a) => { if (!quiet) console.log(...a); };
  await db.ensureReady();

  if (wipe) {
    say('Clearing existing demo data…');
    await db.exec(`
      DELETE FROM order_events;
      DELETE FROM orders;
      DELETE FROM alert_recipients;
    `);
  }

  // Make sure reference data exists (sites, facilities, carriers, providers).
  await provision.provisionAll();

  const sites = await db.all('SELECT id, name FROM sites WHERE active = 1 ORDER BY name');
  if (!sites.length) throw new Error('No sites found — check sites.json.');
  const pt = await db.all("SELECT id, name FROM facilities WHERE kind = 'pt' AND active = 1");
  const imaging = await db.all("SELECT id, name FROM facilities WHERE kind = 'imaging' AND active = 1");
  const carriers = await db.all('SELECT id, name FROM carriers WHERE active = 1');
  const providers = await db.all('SELECT id, name, site_id FROM providers WHERE active = 1');

  const pick = (arr, i) => arr[i % arr.length];

  /**
   * Each spec describes one order positioned at a known rung. `note` explains
   * which rung it is meant to demonstrate — handy when checking the worklist.
   */
  const specs = [
    // ---- Follow-up readiness ladder (imaging) ----
    { note: 'T-10 · status sweep', type: 'mri', followup: 10, ordered: -6, auth: 'approved', authReq: -8, authDec: -5, scheduled: 3 },
    { note: 'T-7 · first outreach', type: 'ct', followup: 7, ordered: -9, auth: 'approved', authReq: -11, authDec: -8, scheduled: -1 },
    { note: 'T-3 · escalate', type: 'mri', followup: 3, ordered: -14, auth: 'approved', authReq: -16, authDec: -12, scheduled: -4 },
    { note: 'T-1 · decision required', type: 'mri', followup: 1, ordered: -18, auth: 'approved', authReq: -20, authDec: -16, scheduled: -8 },
    { note: 'T-0 · visit today, no result', type: 'ct', followup: 0, ordered: -21, auth: 'approved', authReq: -24, authDec: -19, scheduled: -10 },
    { note: 'T-0 · follow-up already missed', type: 'mri', followup: -3, ordered: -30, auth: 'approved', authReq: -32, authDec: -28, scheduled: -15 },

    // ---- Authorization aging ladder ----
    { note: 'A-1 · chase the carrier', type: 'mri', followup: 18, ordered: -5, auth: 'pending', authReq: -3 },
    { note: 'A-2 · escalate to supervisor', type: 'mri', followup: 20, ordered: -10, auth: 'pending', authReq: -8 },
    { note: 'A-3 · formal escalation', type: 'ct', followup: 25, ordered: -18, auth: 'requested', authReq: -15 },
    { note: 'A-4 · denied, peer-to-peer needed', type: 'mri', followup: 14, ordered: -12, auth: 'denied', authReq: -10, authDec: -2 },
    { note: 'A-5 · approved but never scheduled', type: 'ct', followup: 22, ordered: -14, auth: 'approved', authReq: -12, authDec: -7 },

    // ---- PT progress-note ladder ----
    { note: 'P-1 · note just received', type: 'pt', followup: 12, ordered: -20, received: 0, review: 'awaiting', expected: -1 },
    { note: 'P-2 · review reminder', type: 'pt', followup: 11, ordered: -24, received: -3, review: 'awaiting', expected: -4 },
    { note: 'P-3 · review overdue', type: 'pt', followup: 9, ordered: -28, received: -6, review: 'awaiting', expected: -7 },
    { note: 'P-4 · response to PT overdue', type: 'pt', followup: 8, ordered: -32, received: -5, review: 'reviewed', expected: -6 },
    { note: 'P-5 · expected note never arrived', type: 'pt', followup: 13, ordered: -34, expected: -4 },
    { note: 'P-5 · OT note never arrived', type: 'ot', followup: 16, ordered: -30, expected: -2 },

    // ---- Healthy / completed, so the dashboard has real denominators ----
    { note: 'clean imaging, result in hand', type: 'mri', followup: 6, ordered: -20, auth: 'approved', authReq: -18, authDec: -15, scheduled: -9, received: -4 },
    { note: 'clean CT, result in hand', type: 'ct', followup: 9, ordered: -16, auth: 'approved', authReq: -14, authDec: -11, scheduled: -6, received: -2 },
    { note: 'completed imaging (closed on time)', type: 'mri', followup: -10, ordered: -40, auth: 'approved', authReq: -38, authDec: -35, scheduled: -28, received: -18, closed: 'complete' },
    { note: 'completed CT (closed on time)', type: 'ct', followup: -16, ordered: -46, auth: 'approved', authReq: -44, authDec: -40, scheduled: -34, received: -25, closed: 'complete' },
    { note: 'completed PT cycle', type: 'pt', followup: -12, ordered: -50, received: -22, review: 'response_sent', response: -20, expected: -24, closed: 'complete' },
    { note: 'missed — result arrived after the visit', type: 'mri', followup: -8, ordered: -36, auth: 'approved', authReq: -34, authDec: -30, scheduled: -20, received: -4, closed: 'complete' },
    { note: 'missed — patient no-showed to imaging', type: 'ct', followup: -6, ordered: -28, auth: 'approved', authReq: -26, authDec: -22, scheduled: -14, closed: 'cancelled', outcome: 'patient_no_show' },
    { note: 'cancelled — went to another facility', type: 'mri', followup: -4, ordered: -25, auth: 'approved', authReq: -23, authDec: -20, closed: 'cancelled', outcome: 'went_elsewhere' },

    // ---- Non-work-comp, to prove the design is not WC-only ----
    { note: 'non-WC · prior auth pending', type: 'mri', followup: 15, ordered: -7, auth: 'pending', authReq: -5, nonWc: true },
    { note: 'non-WC · PT in progress', type: 'pt', followup: 10, ordered: -18, received: -2, review: 'awaiting', expected: -3, nonWc: true },
    { note: 'non-WC · imaging complete', type: 'ct', followup: -14, ordered: -38, auth: 'approved', authReq: -36, authDec: -33, scheduled: -26, received: -20, closed: 'complete', nonWc: true },
  ];

  say(`Seeding ${specs.length * sites.length} orders across ${sites.length} sites…`);

  let n = 0;
  for (const [si, site] of sites.entries()) {
    const siteProviders = providers.filter((p) => p.site_id === site.id || p.site_id == null);

    for (const [i, s] of specs.entries()) {
      const isTherapy = s.type === 'pt' || s.type === 'ot';
      const pool = isTherapy ? pt : imaging;
      const fIdx = pool.length ? (i + si) % pool.length : 0;
      const facility = pool[fIdx] || null;
      const provider = siteProviders.length ? pick(siteProviders, i + si) : null;
      const carrier = pick(carriers, i + si);

      // Give each facility its own turnaround profile, so the vendor scorecard
      // actually ranks. A scorecard where every facility scores identically
      // proves nothing — and differentiating slow partners from fast ones is
      // the whole reason the scorecard is worth having.
      const bodyPart = pick(BODY_PARTS, i + si);
      const received = s.received != null ? s.received + FACILITY_LAG[fIdx % FACILITY_LAG.length] : null;

      const authStatus = s.auth || (isTherapy ? 'not_required' : 'not_required');

      const info = await db.run(
        `INSERT INTO orders(
            site_id, reference, case_type, order_type, body_part, laterality,
            provider_id, facility_id, carrier_id, ordered_on,
            auth_required, auth_status, auth_number,
            auth_requested_on, auth_decided_on, auth_expires_on,
            scheduled_on, service_completed, expected_result_on, followup_on,
            result_received_on, review_status, response_sent_on,
            status, outcome, owner_name)
         VALUES(?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?, ?,?,?, ?,?,?)`,
        [
          site.id,
          nextRef(),
          s.nonWc ? 'non_wc' : 'wc',
          s.type,
          bodyPart,
          // Spines have no side; limbs do.
          /spine/i.test(bodyPart) ? 'na' : pick(['left', 'right', 'bilateral'], i),
          provider ? provider.id : null,
          facility ? facility.id : null,
          carrier ? carrier.id : null,
          iso(shift(s.ordered)),
          isTherapy ? 'no' : 'yes',
          authStatus,
          authStatus === 'approved' ? `AUTH-${100000 + i * 37 + si}` : null,
          // Business days, not calendar — the authorization ladder measures in
          // business days, so a calendar offset lands an order on the wrong rung.
          s.authReq != null ? bizFromToday(s.authReq) : null,
          s.authDec != null ? bizFromToday(s.authDec) : null,
          authStatus === 'approved' ? iso(shift(45)) : null,
          s.scheduled != null ? iso(shift(s.scheduled)) : null,
          received != null ? 1 : 0,
          s.expected != null ? bizFromToday(s.expected) : null,
          s.followup != null ? bizFromToday(s.followup) : null,
          received != null ? bizFromToday(received) : null,
          s.review || 'awaiting',
          s.response != null ? iso(shift(s.response)) : null,
          s.closed || 'open',
          s.outcome || (s.closed === 'complete' ? 'result_received' : null),
          pick(['Dana R.', 'Marcus T.', 'Priya S.'], i + si),
        ]
      );

      await db.run(
        'INSERT INTO order_events(order_id, kind, note, actor) VALUES(?, ?, ?, ?)',
        [info.lastInsertRowid, 'created', `Order created — demo scenario: ${s.note}`, 'seed']
      );

      // A little outreach history on the ones being chased, so the event log
      // and the "discoverable trail" idea are visible in the demo.
      if (['T-7', 'T-3', 'T-1', 'T-0', 'A-2', 'A-3'].some((c) => s.note.startsWith(c))) {
        await db.run(
          'INSERT INTO order_events(order_id, kind, note, actor) VALUES(?, ?, ?, ?)',
          [info.lastInsertRowid, 'outreach',
            `Called ${facility ? facility.name : 'the facility'} — spoke to front desk, ` +
            'report not yet dictated. Will call back.', 'Dana R.']
        );
      }
      n++;
    }
  }

  // A couple of recipients so the digest has somewhere to go in a demo. These
  // are example.org addresses, which cannot receive mail.
  for (const site of sites) {
    await db.run('INSERT INTO alert_recipients(site_id, email) VALUES(?, ?)',
      [site.id, `worklist.${site.name.toLowerCase().replace(/\s+/g, '')}@example.org`]);
  }

  await auth.setSetting('demo_banner', '1');
  await auth.setSetting('wc_block_enabled', '0');

  const sitePins = require('./sites.json').sites || [];
  say(`\nSeeded ${n} orders.`);
  say('\nSign in to the staff worklist with:');
  for (const s of sitePins) say(`  ${s.name.padEnd(14)} PIN ${s.pin}`);
  say(`\nLeadership password: ${process.env.REF_LEADERSHIP_PASSWORD || 'changeme'}`);
  say('\nReminders are OFF and the work-comp block is OFF by default — both in Leadership → Settings.\n');
  return n;
}

/**
 * Populate demo data only when the orders table is completely empty.
 *
 * Used by REF_AUTOSEED on hosts with an ephemeral disk, so a demo deployment
 * comes back up populated after a restart instead of showing an empty worklist.
 * It never deletes anything and never runs when any order already exists, so it
 * cannot overwrite real work.
 */
async function seedIfEmpty() {
  await db.ensureReady();
  const row = await db.get('SELECT COUNT(*) AS c FROM orders');
  if (row && Number(row.c) > 0) return { seeded: false, reason: 'orders already present' };
  const n = await run({ wipe: false, quiet: true });
  return { seeded: true, orders: n };
}

module.exports = { run, seedIfEmpty };

if (require.main === module) {
  run({ wipe: true }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
