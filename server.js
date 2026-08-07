'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const auth = require('./lib/auth');
const ladders = require('./lib/ladders');
const reminders = require('./lib/reminders');
const mailer = require('./lib/mailer');
const provision = require('./lib/provision');
const wcblock = require('./lib/wcblock');
const pkg = require('./package.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function wrap(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        const status = err.status || 500;
        if (status >= 500) console.error(err);
        if (!res.headersSent) res.status(status).json({ error: err.message || 'Server error' });
      });
  };
}

function setCookie(res, name, value, maxAgeMs) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (process.env.NODE_ENV === 'production' || db.isRemote) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A YYYY-MM-DD string, or null. Rejects anything else so bad dates never reach the ladders. */
function dateOrNull(v, field) {
  if (v == null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !ladders.parseDate(s)) {
    throw httpError(400, `${field} must be a date in YYYY-MM-DD form`);
  }
  return s;
}

function oneOf(v, allowed, field, fallback) {
  if (v == null || v === '') return fallback;
  if (!allowed.includes(v)) throw httpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

const ORDER_SELECT = `
  SELECT o.*,
         s.name AS site_name,
         f.name AS facility_name,
         p.name AS provider_name,
         c.name AS carrier_name
    FROM orders o
    LEFT JOIN sites      s ON s.id = o.site_id
    LEFT JOIN facilities f ON f.id = o.facility_id
    LEFT JOIN providers  p ON p.id = o.provider_id
    LEFT JOIN carriers   c ON c.id = o.carrier_id
`;

async function logEvent(orderId, kind, note, actor) {
  await db.run(
    'INSERT INTO order_events(order_id, kind, note, actor) VALUES(?, ?, ?, ?)',
    [orderId, kind, note || null, actor || null]
  );
}

async function touch(orderId) {
  await db.run("UPDATE orders SET updated_at = datetime('now') WHERE id = ?", [orderId]);
}

/** Fetch, decorate with ladder rungs, and redact the WC block if it is off. */
async function loadOrder(id) {
  const row = await db.get(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
  if (!row) throw httpError(404, 'Order not found');
  const t = await reminders.thresholds();
  return wcblock.redact(ladders.decorate(row, ladders.today(), t));
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

app.get('/api/version', (req, res) => res.json({ version: pkg.version }));

// Sites available to sign in to (only those with a PIN set).
app.get('/api/sites', wrap(async (req, res) => {
  res.json(await db.all(
    'SELECT id, name FROM sites WHERE active = 1 AND pin_hash IS NOT NULL ORDER BY name'
  ));
}));

// Flags the front-ends need before sign-in.
app.get('/api/config', wrap(async (req, res) => {
  res.json({
    version: pkg.version,
    demo_banner: (await auth.getSetting('demo_banner')) !== '0',
    wc_block_enabled: await wcblock.enabled(),
    smtp_configured: mailer.isConfigured(),
  });
}));

app.post('/api/site/login', wrap(async (req, res) => {
  const { site_id, pin } = req.body || {};
  const token = await auth.siteLogin(num(site_id), pin);
  if (!token) throw httpError(401, 'That PIN does not match this site');
  setCookie(res, 'ref_site', token, 30 * 24 * 60 * 60 * 1000);
  const site = await db.get('SELECT id, name FROM sites WHERE id = ?', [num(site_id)]);
  res.json({ ok: true, site });
}));

app.post('/api/site/logout', (req, res) => {
  clearCookie(res, 'ref_site');
  res.json({ ok: true });
});

app.get('/api/site/me', wrap(async (req, res) => {
  const token = auth.parseCookies(req).ref_site;
  const id = token ? await auth.siteFromToken(token) : null;
  if (id == null) return res.json({ signed_in: false });
  const site = await db.get('SELECT id, name FROM sites WHERE id = ? AND active = 1', [id]);
  if (!site) return res.json({ signed_in: false });
  res.json({ signed_in: true, site });
}));

// ---------------------------------------------------------------------------
// Staff API — everything below needs a signed-in site
// ---------------------------------------------------------------------------

const staff = express.Router();

// The staff router is mounted on the whole of /api, so it would otherwise apply
// the site guard to /api/admin/* as well. The leadership router is mounted
// first and handles those, but skip them here too so an unknown admin path 404s
// instead of being rejected with a misleading "sign in to your site".
staff.use((req, res, next) => {
  if (req.path === '/admin' || req.path.startsWith('/admin/')) return next();
  return auth.requireSite(req, res, next);
});

// Reference data for the order form.
staff.get('/reference', wrap(async (req, res) => {
  const [facilities, carriers, providers] = await Promise.all([
    db.all('SELECT id, name, kind, phone FROM facilities WHERE active = 1 ORDER BY name'),
    db.all('SELECT id, name, phone FROM carriers WHERE active = 1 ORDER BY name'),
    db.all('SELECT id, name FROM providers WHERE active = 1 AND (site_id IS NULL OR site_id = ?) ORDER BY name',
      [req.siteId]),
  ]);
  res.json({ facilities, carriers, providers, wc_block_enabled: await wcblock.enabled() });
}));

/**
 * The five worklist views. Each is the same decorated order list under a
 * different filter — the filters are the operational rituals from the SOP.
 */
staff.get('/orders', wrap(async (req, res) => {
  const view = String(req.query.view || 'worklist');
  const t = await reminders.thresholds();
  const asOf = ladders.today();

  const rows = await db.all(`${ORDER_SELECT} WHERE o.site_id = ?`, [req.siteId]);
  let decorated = rows.map((o) => ladders.decorate(o, asOf, t));

  if (view === 'worklist') {
    // Open, result not in, follow-up inside the sweep window (or already past).
    decorated = decorated.filter((o) =>
      o.status === 'open' && !o.result_received_on && o.followup_on &&
      o.days_until_followup !== null && o.days_until_followup <= t.followup_sweep);
  } else if (view === 'auth') {
    decorated = decorated.filter((o) =>
      o.status === 'open' &&
      ['requested', 'pending', 'denied', 'p2p', 'appealed'].includes(o.auth_status));
    decorated.sort((a, b) => (b.days_auth_pending ?? -1) - (a.days_auth_pending ?? -1));
    return res.json(await wcblock.redactAll(decorated));
  } else if (view === 'review') {
    decorated = decorated.filter((o) =>
      o.status === 'open' && o.result_received_on && o.review_status === 'awaiting');
  } else if (view === 'pt_response') {
    decorated = decorated.filter((o) =>
      o.status === 'open' && ['pt', 'ot'].includes(o.order_type) &&
      o.review_status === 'reviewed' && !o.response_sent_on);
  } else if (view === 'open') {
    decorated = decorated.filter((o) => o.status === 'open');
  } else if (view === 'all') {
    /* everything */
  } else {
    throw httpError(400, 'Unknown view');
  }

  decorated.sort(ladders.bySeverity);
  res.json(await wcblock.redactAll(decorated));
}));

/** Counts for the tab badges — one query, so the UI does not fetch five lists. */
staff.get('/counts', wrap(async (req, res) => {
  const t = await reminders.thresholds();
  const asOf = ladders.today();
  const rows = await db.all(`${ORDER_SELECT} WHERE o.site_id = ?`, [req.siteId]);
  const d = rows.map((o) => ladders.decorate(o, asOf, t));

  res.json({
    worklist: d.filter((o) => o.status === 'open' && !o.result_received_on && o.followup_on &&
      o.days_until_followup !== null && o.days_until_followup <= t.followup_sweep).length,
    auth: d.filter((o) => o.status === 'open' &&
      ['requested', 'pending', 'denied', 'p2p', 'appealed'].includes(o.auth_status)).length,
    review: d.filter((o) => o.status === 'open' && o.result_received_on &&
      o.review_status === 'awaiting').length,
    pt_response: d.filter((o) => o.status === 'open' && ['pt', 'ot'].includes(o.order_type) &&
      o.review_status === 'reviewed' && !o.response_sent_on).length,
    open: d.filter((o) => o.status === 'open').length,
    critical: d.filter((o) => o.top && o.top.severity === 'critical').length,
  });
}));

staff.get('/orders/:id', wrap(async (req, res) => {
  const order = await loadOrder(num(req.params.id));
  if (order.site_id !== req.siteId) throw httpError(404, 'Order not found');
  const events = await db.all(
    'SELECT id, kind, note, actor, created_at FROM order_events WHERE order_id = ? ORDER BY created_at DESC, id DESC',
    [order.id]
  );
  res.json({ order, events });
}));

staff.post('/orders', wrap(async (req, res) => {
  const b = req.body || {};

  // Refuse work-comp escalation fields unless leadership has enabled them.
  await wcblock.assertAllowed(b);

  const reference = String(b.reference || '').trim();
  if (!reference) throw httpError(400, 'A reference is required — the value staff use to find this in the EMR');
  if (reference.length > 60) throw httpError(400, 'Reference is too long');

  const orderType = oneOf(b.order_type, ['pt', 'ot', 'mri', 'ct', 'other'], 'order_type', null);
  if (!orderType) throw httpError(400, 'Choose an order type');

  const orderedOn = dateOrNull(b.ordered_on, 'ordered_on') || ladders.today();
  const authStatus = oneOf(b.auth_status,
    ['not_required', 'requested', 'pending', 'approved', 'denied', 'p2p', 'appealed'],
    'auth_status', 'not_required');

  const info = await db.run(
    `INSERT INTO orders(
        site_id, reference, case_type, order_type, body_part, laterality,
        provider_id, facility_id, carrier_id, ordered_on,
        auth_required, auth_status, auth_number, auth_requested_on, auth_decided_on,
        auth_expires_on, visits_authorized,
        scheduled_on, expected_result_on, followup_on, owner_name,
        claim_number, employer, adjuster_name, adjuster_contact, case_manager)
     VALUES(?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?,?)`,
    [
      req.siteId, reference,
      oneOf(b.case_type, ['wc', 'non_wc'], 'case_type', 'wc'),
      orderType,
      b.body_part ? String(b.body_part).trim() : null,
      oneOf(b.laterality, ['left', 'right', 'bilateral', 'na'], 'laterality', null),
      num(b.provider_id), num(b.facility_id), num(b.carrier_id), orderedOn,
      oneOf(b.auth_required, ['yes', 'no', 'unknown'], 'auth_required', 'unknown'),
      authStatus,
      b.auth_number ? String(b.auth_number).trim() : null,
      dateOrNull(b.auth_requested_on, 'auth_requested_on'),
      dateOrNull(b.auth_decided_on, 'auth_decided_on'),
      dateOrNull(b.auth_expires_on, 'auth_expires_on'),
      num(b.visits_authorized),
      dateOrNull(b.scheduled_on, 'scheduled_on'),
      dateOrNull(b.expected_result_on, 'expected_result_on'),
      dateOrNull(b.followup_on, 'followup_on'),
      b.owner_name ? String(b.owner_name).trim() : null,
      b.claim_number || null, b.employer || null,
      b.adjuster_name || null, b.adjuster_contact || null, b.case_manager || null,
    ]
  );

  await logEvent(info.lastInsertRowid, 'created', `Order created: ${reference}`, b.actor);
  res.status(201).json(await loadOrder(info.lastInsertRowid));
}));

/** Editable fields. Anything not listed here can only change via a workflow action. */
const EDITABLE = [
  'reference', 'case_type', 'order_type', 'body_part', 'laterality',
  'provider_id', 'facility_id', 'carrier_id', 'ordered_on',
  'auth_required', 'auth_number', 'auth_expires_on', 'visits_authorized',
  'scheduled_on', 'expected_result_on', 'followup_on', 'owner_name',
  'claim_number', 'employer', 'adjuster_name', 'adjuster_contact', 'case_manager',
];
const DATE_FIELDS = new Set([
  'ordered_on', 'auth_expires_on', 'scheduled_on', 'expected_result_on', 'followup_on',
]);

staff.patch('/orders/:id', wrap(async (req, res) => {
  const id = num(req.params.id);
  const existing = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!existing || existing.site_id !== req.siteId) throw httpError(404, 'Order not found');

  const b = req.body || {};
  await wcblock.assertAllowed(b);

  const sets = [];
  const args = [];
  const changed = [];
  for (const field of EDITABLE) {
    if (!(field in b)) continue;
    let v = b[field];
    if (DATE_FIELDS.has(field)) v = dateOrNull(v, field);
    else if (field === 'provider_id' || field === 'facility_id' || field === 'carrier_id' ||
             field === 'visits_authorized') v = num(v);
    else if (field === 'case_type') v = oneOf(v, ['wc', 'non_wc'], field, existing.case_type);
    else if (field === 'order_type') v = oneOf(v, ['pt', 'ot', 'mri', 'ct', 'other'], field, existing.order_type);
    else if (field === 'laterality') v = oneOf(v, ['left', 'right', 'bilateral', 'na'], field, null);
    else if (field === 'auth_required') v = oneOf(v, ['yes', 'no', 'unknown'], field, existing.auth_required);
    else if (typeof v === 'string') v = v.trim() || null;

    if (String(existing[field] ?? '') === String(v ?? '')) continue;
    sets.push(`${field} = ?`);
    args.push(v);
    changed.push(field);
  }

  if (!sets.length) return res.json(await loadOrder(id));

  args.push(id);
  await db.run(`UPDATE orders SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, args);

  // A moved follow-up date is the single most consequential edit — the entire
  // reminder ladder keys off it — so it gets its own line in the log.
  const note = changed.includes('followup_on')
    ? `Follow-up date changed to ${b.followup_on || 'none'} (also: ${changed.filter((c) => c !== 'followup_on').join(', ') || 'no other fields'})`
    : `Edited: ${changed.join(', ')}`;
  await logEvent(id, 'edited', note, b.actor);

  res.json(await loadOrder(id));
}));

// --- Workflow actions ------------------------------------------------------

/** Touchpoint 3 — the result arrived. */
staff.post('/orders/:id/result', wrap(async (req, res) => {
  const id = num(req.params.id);
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!o || o.site_id !== req.siteId) throw httpError(404, 'Order not found');

  const on = dateOrNull(req.body && req.body.received_on, 'received_on') || ladders.today();
  await db.run(
    "UPDATE orders SET result_received_on = ?, review_status = 'awaiting', service_completed = 1 WHERE id = ?",
    [on, id]
  );
  await logEvent(id, 'result_received', `Result received ${on}`, req.body && req.body.actor);
  await touch(id);
  res.json(await loadOrder(id));
}));

/**
 * Touchpoint 4 — the provider reviewed it.
 *
 * Imaging closes here. Therapy does NOT: it goes back to open awaiting the
 * response to PT, and after that the next progress-note cycle. A PT record's
 * life is measured in months.
 */
staff.post('/orders/:id/review', wrap(async (req, res) => {
  const id = num(req.params.id);
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!o || o.site_id !== req.siteId) throw httpError(404, 'Order not found');
  if (!o.result_received_on) throw httpError(400, 'Mark the result received before reviewing it');

  const isTherapy = o.order_type === 'pt' || o.order_type === 'ot';
  if (isTherapy) {
    await db.run("UPDATE orders SET review_status = 'reviewed' WHERE id = ?", [id]);
    await logEvent(id, 'reviewed', 'Provider reviewed the progress note — response to PT now due',
      req.body && req.body.actor);
  } else {
    await db.run("UPDATE orders SET review_status = 'reviewed', status = 'complete' WHERE id = ?", [id]);
    await logEvent(id, 'reviewed', 'Provider reviewed the report — imaging order complete',
      req.body && req.body.actor);
    await logEvent(id, 'status_change', 'Closed: result reviewed', req.body && req.body.actor);
  }
  await touch(id);
  res.json(await loadOrder(id));
}));

/** The return leg — our response goes back to PT. This is what closes the loop. */
staff.post('/orders/:id/response', wrap(async (req, res) => {
  const id = num(req.params.id);
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!o || o.site_id !== req.siteId) throw httpError(404, 'Order not found');
  if (o.review_status !== 'reviewed') throw httpError(400, 'Review the note before sending a response');

  const on = dateOrNull(req.body && req.body.sent_on, 'sent_on') || ladders.today();
  const continuing = !(req.body && req.body.end_plan_of_care);

  // Continuing care: reset for the next progress-note cycle rather than closing.
  // Ending care: the order is done.
  if (continuing) {
    const nextExpected = dateOrNull(req.body && req.body.next_expected_on, 'next_expected_on');
    await db.run(
      `UPDATE orders
          SET response_sent_on = ?, review_status = 'awaiting',
              result_received_on = NULL, expected_result_on = ?
        WHERE id = ?`,
      [on, nextExpected, id]
    );
    await logEvent(id, 'response_sent',
      `Response sent to PT ${on}. Awaiting the next progress note` +
      (nextExpected ? `, expected ${nextExpected}` : ' (no expected date set — this order is invisible to the P-5 catch)'),
      req.body && req.body.actor);
  } else {
    await db.run(
      "UPDATE orders SET response_sent_on = ?, review_status = 'response_sent', status = 'complete' WHERE id = ?",
      [on, id]
    );
    await logEvent(id, 'response_sent', `Response sent to PT ${on} — plan of care ended`, req.body && req.body.actor);
    await logEvent(id, 'status_change', 'Closed: plan of care ended', req.body && req.body.actor);
  }
  await touch(id);
  res.json(await loadOrder(id));
}));

/** Authorization status change. */
staff.post('/orders/:id/auth', wrap(async (req, res) => {
  const id = num(req.params.id);
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!o || o.site_id !== req.siteId) throw httpError(404, 'Order not found');

  const b = req.body || {};
  const status = oneOf(b.auth_status,
    ['not_required', 'requested', 'pending', 'approved', 'denied', 'p2p', 'appealed'],
    'auth_status', null);
  if (!status) throw httpError(400, 'Choose an authorization status');

  // Stamp the dates that drive the aging ladder, without clobbering existing ones.
  const requestedOn = dateOrNull(b.auth_requested_on, 'auth_requested_on') ||
    (status === 'requested' && !o.auth_requested_on ? ladders.today() : o.auth_requested_on);
  const decidedOn = dateOrNull(b.auth_decided_on, 'auth_decided_on') ||
    (['approved', 'denied'].includes(status) && !o.auth_decided_on ? ladders.today() : o.auth_decided_on);

  await db.run(
    `UPDATE orders SET auth_status = ?, auth_requested_on = ?, auth_decided_on = ?,
            auth_number = COALESCE(?, auth_number), auth_expires_on = COALESCE(?, auth_expires_on),
            visits_authorized = COALESCE(?, visits_authorized), updated_at = datetime('now')
      WHERE id = ?`,
    [status, requestedOn, decidedOn,
     b.auth_number ? String(b.auth_number).trim() : null,
     dateOrNull(b.auth_expires_on, 'auth_expires_on'),
     num(b.visits_authorized), id]
  );
  await logEvent(id, 'auth_update',
    `Authorization ${status.replace('_', ' ')}${b.note ? ` — ${String(b.note).trim()}` : ''}`, b.actor);
  res.json(await loadOrder(id));
}));

/** Log an outreach attempt. This is the discoverable trail. */
staff.post('/orders/:id/outreach', wrap(async (req, res) => {
  const id = num(req.params.id);
  const o = await db.get('SELECT id, site_id FROM orders WHERE id = ?', [id]);
  if (!o || o.site_id !== req.siteId) throw httpError(404, 'Order not found');

  const note = String((req.body && req.body.note) || '').trim();
  if (!note) throw httpError(400, 'Describe what happened — who you contacted and the outcome');
  await logEvent(id, 'outreach', note, req.body && req.body.actor);
  await touch(id);
  res.json({ ok: true });
}));

/** Free-text note, no state change. */
staff.post('/orders/:id/note', wrap(async (req, res) => {
  const id = num(req.params.id);
  const o = await db.get('SELECT id, site_id FROM orders WHERE id = ?', [id]);
  if (!o || o.site_id !== req.siteId) throw httpError(404, 'Order not found');
  const note = String((req.body && req.body.note) || '').trim();
  if (!note) throw httpError(400, 'Enter a note');
  await logEvent(id, 'note', note, req.body && req.body.actor);
  res.json({ ok: true });
}));

/**
 * Close an order with an outcome. The non-happy-path outcomes matter as much as
 * the happy one — a patient who no-showed to PT or went elsewhere has to be
 * expressible, or staff bury it in a note where no report can find it.
 */
const OUTCOMES = [
  'result_received', 'patient_no_show', 'went_elsewhere', 'cancelled_by_provider',
  'cancelled_by_carrier', 'patient_discharged', 'claim_closed', 'other',
];

staff.post('/orders/:id/close', wrap(async (req, res) => {
  const id = num(req.params.id);
  const o = await db.get('SELECT id, site_id FROM orders WHERE id = ?', [id]);
  if (!o || o.site_id !== req.siteId) throw httpError(404, 'Order not found');

  const b = req.body || {};
  const outcome = oneOf(b.outcome, OUTCOMES, 'outcome', null);
  if (!outcome) throw httpError(400, `Choose an outcome: ${OUTCOMES.join(', ')}`);
  const status = outcome === 'result_received' ? 'complete' : 'cancelled';

  await db.run("UPDATE orders SET status = ?, outcome = ?, updated_at = datetime('now') WHERE id = ?",
    [status, outcome, id]);
  await logEvent(id, 'status_change',
    `Closed as ${outcome.replace(/_/g, ' ')}${b.note ? ` — ${String(b.note).trim()}` : ''}`, b.actor);
  res.json(await loadOrder(id));
}));

/** Reopen — e.g. a plan of care resumes, or an order was closed in error. */
staff.post('/orders/:id/reopen', wrap(async (req, res) => {
  const id = num(req.params.id);
  const o = await db.get('SELECT id, site_id FROM orders WHERE id = ?', [id]);
  if (!o || o.site_id !== req.siteId) throw httpError(404, 'Order not found');
  await db.run("UPDATE orders SET status = 'open', outcome = NULL, updated_at = datetime('now') WHERE id = ?", [id]);
  await logEvent(id, 'status_change', 'Reopened', req.body && req.body.actor);
  res.json(await loadOrder(id));
}));

// ---------------------------------------------------------------------------
// Leadership API
//
// Registered BEFORE the staff router is mounted on /api, so /api/admin/* is
// matched here first and never reaches the staff site guard.
// ---------------------------------------------------------------------------

app.get('/api/admin/status', wrap(async (req, res) => {
  const token = auth.parseCookies(req).ref_session;
  res.json({
    signed_in: !!(token && await auth.isValidToken(token)),
    configured: await auth.isConfigured(),
    default_password: await auth.isDefaultPassword(),
  });
}));

app.post('/api/admin/login', wrap(async (req, res) => {
  const token = await auth.login((req.body || {}).password);
  if (!token) throw httpError(401, 'Incorrect password');
  setCookie(res, 'ref_session', token, 12 * 60 * 60 * 1000);
  res.json({ ok: true });
}));

app.post('/api/admin/logout', (req, res) => {
  clearCookie(res, 'ref_session');
  res.json({ ok: true });
});

const admin = express.Router();
admin.use(auth.requireLeadership);

admin.post('/password', wrap(async (req, res) => {
  const pw = String((req.body || {}).password || '');
  if (pw.length < 8) throw httpError(400, 'Use at least 8 characters');
  await auth.setPassword(pw);
  res.json({ ok: true });
}));

// --- Dashboard -------------------------------------------------------------

/**
 * The north-star metric and the ladder load, region-wide or per site.
 *
 * "Follow-ups ready" is the proportion of follow-up appointments that had every
 * expected result in hand by the appointment date — the one number the whole
 * project exists to move.
 */
admin.get('/dashboard', wrap(async (req, res) => {
  const siteId = num(req.query.site_id);
  const t = await reminders.thresholds();
  const asOf = ladders.today();

  const rows = siteId
    ? await db.all(`${ORDER_SELECT} WHERE o.site_id = ?`, [siteId])
    : await db.all(ORDER_SELECT);
  const d = rows.map((o) => ladders.decorate(o, asOf, t));

  // North star: of orders whose follow-up date has passed, how many had the
  // result in hand on or before that date?
  const withPastFollowup = d.filter((o) => o.followup_on && o.followup_on <= asOf);
  const readyOnTime = withPastFollowup.filter(
    (o) => o.result_received_on && o.result_received_on <= o.followup_on);
  const readiness = withPastFollowup.length
    ? Math.round((readyOnTime.length / withPastFollowup.length) * 100)
    : null;

  const open = d.filter((o) => o.status === 'open');
  const sev = { critical: 0, urgent: 0, watch: 0, calm: 0 };
  for (const o of open) if (o.top) sev[o.top.severity]++;

  const turnarounds = d.map((o) => o.turnaround_days).filter((n) => n != null).sort((a, b) => a - b);
  const median = (arr) => (arr.length
    ? (arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2)
    : null);

  const authDecided = d.filter((o) => o.auth_requested_on && o.auth_decided_on);
  const authDays = authDecided
    .map((o) => ladders.calendarDaysBetween(o.auth_requested_on, o.auth_decided_on))
    .filter((n) => n != null).sort((a, b) => a - b);

  const therapyOpen = open.filter((o) => ['pt', 'ot'].includes(o.order_type));

  res.json({
    as_of: asOf,
    readiness_pct: readiness,
    readiness_sample: withPastFollowup.length,
    open_orders: open.length,
    severity: sev,
    median_turnaround_days: median(turnarounds),
    median_auth_days: median(authDays),
    auth_denied: d.filter((o) => o.auth_status === 'denied').length,
    awaiting_review: open.filter((o) => o.result_received_on && o.review_status === 'awaiting').length,
    pt_response_outstanding: therapyOpen.filter(
      (o) => o.review_status === 'reviewed' && !o.response_sent_on).length,
    // The blind spot worth surfacing: therapy orders with no expected-result
    // date can never trigger the P-5 "note never arrived" catch.
    pt_missing_expected_date: therapyOpen.filter(
      (o) => !o.result_received_on && !o.expected_result_on).length,
  });
}));

/**
 * Vendor scorecard — median days from order to result, by facility.
 *
 * This falls out of data staff already enter, and it is the argument that turns
 * the project from cost-avoidance into a performance-management capability.
 */
admin.get('/scorecard', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT f.id, f.name, f.kind, o.ordered_on, o.result_received_on, o.status
       FROM orders o JOIN facilities f ON f.id = o.facility_id
      WHERE o.facility_id IS NOT NULL`
  );

  const byFacility = new Map();
  for (const r of rows) {
    if (!byFacility.has(r.id)) {
      byFacility.set(r.id, { id: r.id, name: r.name, kind: r.kind, days: [], total: 0, outstanding: 0 });
    }
    const f = byFacility.get(r.id);
    f.total++;
    if (r.result_received_on) {
      const n = ladders.calendarDaysBetween(r.ordered_on, r.result_received_on);
      if (n != null) f.days.push(n);
    } else if (r.status === 'open') {
      f.outstanding++;
    }
  }

  const out = [...byFacility.values()].map((f) => {
    const s = f.days.slice().sort((a, b) => a - b);
    const median = s.length
      ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2)
      : null;
    return {
      id: f.id, name: f.name, kind: f.kind,
      orders: f.total, completed: s.length, outstanding: f.outstanding,
      median_days: median,
      slowest_days: s.length ? s[s.length - 1] : null,
    };
  });

  // Slowest first — the point of the list is to see who is holding us up.
  out.sort((a, b) => (b.median_days ?? -1) - (a.median_days ?? -1));
  res.json(out);
}));

// --- Orders across all sites ----------------------------------------------

admin.get('/orders', wrap(async (req, res) => {
  const t = await reminders.thresholds();
  const asOf = ladders.today();
  const siteId = num(req.query.site_id);
  const rows = siteId
    ? await db.all(`${ORDER_SELECT} WHERE o.site_id = ? ORDER BY o.updated_at DESC`, [siteId])
    : await db.all(`${ORDER_SELECT} ORDER BY o.updated_at DESC`);
  const d = rows.map((o) => ladders.decorate(o, asOf, t));
  d.sort(ladders.bySeverity);
  res.json(await wcblock.redactAll(d));
}));

// --- Reference data management --------------------------------------------

function crud(routeName, table, fields) {
  admin.get(`/${routeName}`, wrap(async (req, res) => {
    res.json(await db.all(`SELECT * FROM ${table} ORDER BY name`));
  }));

  admin.post(`/${routeName}`, wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw httpError(400, 'Name is required');
    const cols = ['name'];
    const vals = [name];
    for (const f of fields) {
      if (f in b) { cols.push(f); vals.push(b[f] === '' ? null : b[f]); }
    }
    try {
      const info = await db.run(
        `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, vals);
      res.status(201).json(await db.get(`SELECT * FROM ${table} WHERE id = ?`, [info.lastInsertRowid]));
    } catch (e) {
      throw httpError(409, `A ${routeName.replace(/s$/, '')} with that name already exists`);
    }
  }));

  admin.patch(`/${routeName}/:id`, wrap(async (req, res) => {
    const b = req.body || {};
    const sets = [];
    const args = [];
    for (const f of ['name', 'active', ...fields]) {
      if (!(f in b)) continue;
      sets.push(`${f} = ?`);
      args.push(f === 'active' ? (b[f] ? 1 : 0) : (b[f] === '' ? null : b[f]));
    }
    if (!sets.length) throw httpError(400, 'Nothing to update');
    args.push(num(req.params.id));
    await db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, args);
    res.json(await db.get(`SELECT * FROM ${table} WHERE id = ?`, [num(req.params.id)]));
  }));
}

crud('facilities', 'facilities', ['kind', 'phone']);
crud('carriers', 'carriers', ['phone']);
crud('providers', 'providers', ['site_id']);

admin.get('/sites', wrap(async (req, res) => {
  const rows = await db.all('SELECT id, name, active, created_at FROM sites ORDER BY name');
  for (const r of rows) r.has_pin = await auth.siteHasPin(r.id);
  res.json(rows);
}));

admin.post('/sites', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  let info;
  try {
    info = await db.run('INSERT INTO sites(name) VALUES(?)', [name]);
  } catch (e) {
    throw httpError(409, 'A site with that name already exists');
  }
  if (b.pin) await auth.setSitePin(info.lastInsertRowid, String(b.pin));
  res.status(201).json(await db.get('SELECT id, name, active FROM sites WHERE id = ?', [info.lastInsertRowid]));
}));

admin.patch('/sites/:id', wrap(async (req, res) => {
  const id = num(req.params.id);
  const b = req.body || {};
  if (b.name != null) await db.run('UPDATE sites SET name = ? WHERE id = ?', [String(b.name).trim(), id]);
  if (b.active != null) await db.run('UPDATE sites SET active = ? WHERE id = ?', [b.active ? 1 : 0, id]);
  if (b.pin != null) await auth.setSitePin(id, String(b.pin) || null);
  res.json(await db.get('SELECT id, name, active FROM sites WHERE id = ?', [id]));
}));

// --- Recipients + reminders ------------------------------------------------

admin.get('/recipients', wrap(async (req, res) => res.json(await reminders.recipientsOverview())));

admin.post('/recipients', wrap(async (req, res) => {
  const b = req.body || {};
  await reminders.addRecipient(num(b.site_id), b.email);
  res.status(201).json({ ok: true });
}));

admin.delete('/recipients/:id', wrap(async (req, res) => {
  await reminders.removeRecipient(num(req.params.id));
  res.json({ ok: true });
}));

/** Preview a site's digest without sending — useful in a demo. */
admin.get('/digest/preview', wrap(async (req, res) => {
  const siteId = num(req.query.site_id);
  const site = await db.get('SELECT id, name FROM sites WHERE id = ?', [siteId]);
  if (!site) throw httpError(400, 'Choose a site');
  const asOf = ladders.today();
  const sections = await reminders.digestSections(siteId, asOf);
  const built = reminders.buildDigest(site.name, sections, asOf);
  res.json({
    site: site.name,
    counts: {
      followup: sections.followup.length,
      authorization: sections.authorization.length,
      pt: sections.ptLoop.length,
    },
    ...built,
  });
}));

admin.post('/digest/test', wrap(async (req, res) => {
  res.json(await reminders.runForSite(num((req.body || {}).site_id), { test: true }));
}));

admin.post('/digest/run', wrap(async (req, res) => {
  res.json(await reminders.runScheduledCheck({ force: true }));
}));

// --- Settings --------------------------------------------------------------

admin.get('/settings', wrap(async (req, res) => {
  res.json({
    reminders_enabled: (await auth.getSetting('reminders_enabled')) === '1',
    wc_block_enabled: await wcblock.enabled(),
    demo_banner: (await auth.getSetting('demo_banner')) !== '0',
    thresholds: await reminders.thresholds(),
    default_thresholds: ladders.DEFAULT_THRESHOLDS,
    smtp_configured: mailer.isConfigured(),
    smtp_from: mailer.isConfigured() ? mailer.fromAddress() : null,
    database: db.isRemote ? 'Turso (remote)' : 'local file',
    default_password: await auth.isDefaultPassword(),
  });
}));

admin.post('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  if ('reminders_enabled' in b) await auth.setSetting('reminders_enabled', b.reminders_enabled ? '1' : '0');
  if ('demo_banner' in b) await auth.setSetting('demo_banner', b.demo_banner ? '1' : '0');
  if ('wc_block_enabled' in b) await wcblock.setEnabled(!!b.wc_block_enabled);
  if ('thresholds' in b && b.thresholds && typeof b.thresholds === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(b.thresholds)) {
      if (!(k in ladders.DEFAULT_THRESHOLDS)) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 365) clean[k] = Math.round(n);
    }
    await auth.setSetting('ladder_thresholds', JSON.stringify(clean));
  }
  res.json({ ok: true });
}));

// --- Export ----------------------------------------------------------------

admin.get('/export.csv', wrap(async (req, res) => {
  const t = await reminders.thresholds();
  const asOf = ladders.today();
  const rows = await db.all(`${ORDER_SELECT} ORDER BY o.id`);
  const decorated = await wcblock.redactAll(rows.map((o) => ladders.decorate(o, asOf, t)));

  const header = [
    'id', 'site_name', 'reference', 'case_type', 'order_type', 'body_part', 'laterality',
    'provider_name', 'facility_name', 'carrier_name', 'ordered_on',
    'auth_status', 'auth_requested_on', 'auth_decided_on', 'auth_expires_on',
    'scheduled_on', 'expected_result_on', 'followup_on',
    'result_received_on', 'review_status', 'response_sent_on',
    'status', 'outcome', 'turnaround_days', 'days_until_followup', 'top_rung',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header.join(',')].concat(
    decorated.map((r) => header.map((h) =>
      esc(h === 'top_rung' ? (r.top ? r.top.code : '') : r[h])).join(','))
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="referral-orders.csv"');
  res.send(csv);
}));

app.use('/api/admin', admin);

// Staff routes last: this mount covers all of /api, so everything more specific
// must already be registered above it.
app.use('/api', staff);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const bootstrap = (async () => {
  const initial = await auth.ensureDefaultPassword();
  await provision.provisionAll();
  return initial;
})();

if (require.main === module) {
  bootstrap.then((initial) => {
    app.listen(PORT, () => {
      console.log(`Referral & results tracker running on http://localhost:${PORT}`);
      console.log(`  Staff worklist:  http://localhost:${PORT}/`);
      console.log(`  Leadership:      http://localhost:${PORT}/admin.html`);
      if (initial) {
        console.log(`\n  Leadership password not set — using default "${initial}".`);
        console.log('  Sign in and change it immediately.\n');
      }
      console.log(`  Database: ${db.isRemote ? 'Turso (remote)' : 'local file'}`);
      console.log(`  Email:    ${mailer.isConfigured()
        ? 'SMTP configured'
        : 'SMTP not configured — reminders will build but not send (set SMTP_* to enable)'}`);
      reminders.startScheduler();
    });
  });
}

module.exports = app;
module.exports.bootstrap = bootstrap;
