'use strict';

/**
 * Email reminders, one digest per site per day.
 *
 * The digest is split into three role-tagged sections mirroring the three
 * ladders, because the person who chases a facility is usually not the person
 * who works authorizations, and neither is the provider who owes PT a response:
 *
 *   1. Results due before a follow-up   → tracker owner
 *   2. Authorizations aging             → referral & authorization coordinator
 *   3. PT notes awaiting review/response → ordering provider
 *
 * Two deliberate behaviours:
 *
 *   - At most one digest per site per calendar day unless forced, so the cron
 *     can run more than once a day safely.
 *   - When SMTP is not configured the digest is BUILT and logged but not sent,
 *     and the function returns a reason instead of throwing. The app has to be
 *     fully usable and demonstrable before anyone has wired up credentials.
 */

const db = require('../db');
const auth = require('./auth');
const mailer = require('./mailer');
const ladders = require('./ladders');

const SEVERITY_COLOR = {
  critical: '#b6302f',
  urgent: '#9c4a24',
  watch: '#8a5a00',
  calm: '#0c8f0c',
};

const ORDER_TYPE_LABEL = {
  pt: 'PT', ot: 'OT', mri: 'MRI', ct: 'CT', other: 'Other',
};

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function getSetting(key, fallback = null) {
  const v = await auth.getSetting(key);
  return v == null ? fallback : v;
}

async function remindersEnabled() {
  return (await getSetting('reminders_enabled', '0')) === '1';
}

/** Ladder thresholds from settings, falling back to the documented defaults. */
async function thresholds() {
  const raw = await getSetting('ladder_thresholds');
  if (!raw) return ladders.DEFAULT_THRESHOLDS;
  try {
    return { ...ladders.DEFAULT_THRESHOLDS, ...JSON.parse(raw) };
  } catch (e) {
    return ladders.DEFAULT_THRESHOLDS;
  }
}

// --- Recipients ------------------------------------------------------------

async function recipientsOverview() {
  const sites = await db.all('SELECT id, name FROM sites WHERE active = 1 ORDER BY name');
  const rows = await db.all('SELECT id, site_id, email FROM alert_recipients ORDER BY email');
  const bySite = new Map();
  for (const r of rows) {
    if (!bySite.has(r.site_id)) bySite.set(r.site_id, []);
    bySite.get(r.site_id).push({ id: r.id, email: r.email });
  }
  return sites.map((s) => ({
    site_id: s.id,
    site_name: s.name,
    recipients: bySite.get(s.id) || [],
  }));
}

async function recipientsForSite(siteId) {
  const rows = await db.all(
    'SELECT email FROM alert_recipients WHERE site_id = ? ORDER BY email', [siteId]);
  return rows.map((r) => r.email);
}

async function addRecipient(siteId, email) {
  email = String(email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    const e = new Error('Enter a valid email address');
    e.status = 400;
    throw e;
  }
  const site = await db.get('SELECT id FROM sites WHERE id = ? AND active = 1', [siteId]);
  if (!site) {
    const e = new Error('Unknown site');
    e.status = 400;
    throw e;
  }
  try {
    await db.run('INSERT INTO alert_recipients(site_id, email) VALUES(?, ?)', [siteId, email]);
  } catch (err) {
    const e = new Error('That email is already added for this site');
    e.status = 409;
    throw e;
  }
}

async function removeRecipient(id) {
  await db.run('DELETE FROM alert_recipients WHERE id = ?', [id]);
}

// --- Digest contents -------------------------------------------------------

/**
 * The three sections for one site. Each entry carries the order plus the rung
 * that put it there, so the email can say *why* the row is listed.
 */
async function digestSections(siteId, asOf = ladders.today()) {
  const t = await thresholds();
  const rows = await db.all(
    `SELECT o.*, f.name AS facility_name, p.name AS provider_name, c.name AS carrier_name
       FROM orders o
       LEFT JOIN facilities f ON f.id = o.facility_id
       LEFT JOIN providers  p ON p.id = o.provider_id
       LEFT JOIN carriers   c ON c.id = o.carrier_id
      WHERE o.site_id = ? AND o.status = 'open'`,
    [siteId]
  );

  const followup = [];
  const authorization = [];
  const ptLoop = [];

  for (const o of rows) {
    const f = ladders.followupRung(o, asOf, t);
    if (f) followup.push({ order: o, rung: f });
    const a = ladders.authRung(o, asOf, t);
    if (a) authorization.push({ order: o, rung: a });
    const p = ladders.ptRung(o, asOf, t);
    if (p) ptLoop.push({ order: o, rung: p });
  }

  const bySeverity = (x, y) => {
    const s = ladders.SEVERITY_ORDER[x.rung.severity] - ladders.SEVERITY_ORDER[y.rung.severity];
    if (s !== 0) return s;
    return (x.rung.days ?? 0) - (y.rung.days ?? 0);
  };
  followup.sort(bySeverity);
  authorization.sort(bySeverity);
  ptLoop.sort(bySeverity);

  return { followup, authorization, ptLoop };
}

function countCritical(sections) {
  return [...sections.followup, ...sections.authorization, ...sections.ptLoop]
    .filter((x) => x.rung.severity === 'critical').length;
}

function totalRows(sections) {
  return sections.followup.length + sections.authorization.length + sections.ptLoop.length;
}

function describe(entry) {
  const o = entry.order;
  const type = ORDER_TYPE_LABEL[o.order_type] || o.order_type;
  const bits = [type];
  if (o.body_part) bits.push(o.body_part);
  if (o.laterality && o.laterality !== 'na') bits.push(o.laterality);
  return `${o.reference} — ${bits.join(' ')}`;
}

function contextLine(entry) {
  const o = entry.order;
  const parts = [];
  if (o.facility_name) parts.push(o.facility_name);
  if (o.provider_name) parts.push(`ordered by ${o.provider_name}`);
  if (o.followup_on) parts.push(`follow-up ${o.followup_on}`);
  return parts.join(' · ');
}

function buildDigest(siteName, sections, asOf) {
  const total = totalRows(sections);
  const critical = countCritical(sections);
  const subject =
    `Referral tracker — ${siteName}: ${total} item${total === 1 ? '' : 's'} need attention` +
    (critical ? ` (${critical} critical)` : '');

  // ---- plain text ----
  const textSection = (title, entries, owner) => {
    if (!entries.length) return '';
    const lines = entries.map((e) =>
      `  • [${e.rung.code}] ${describe(e)}\n` +
      `      ${contextLine(e)}\n` +
      `      ${e.rung.action}`);
    return `${title} (${owner}) — ${entries.length}\n${lines.join('\n')}\n\n`;
  };

  const text =
    `Referral & results tracker — ${siteName}\n` +
    `As of ${asOf}. ${total} open item${total === 1 ? '' : 's'} need attention.\n\n` +
    textSection('RESULTS DUE BEFORE A FOLLOW-UP', sections.followup, 'tracker owner') +
    textSection('AUTHORIZATIONS AGING', sections.authorization, 'authorization coordinator') +
    textSection('PT NOTES AWAITING REVIEW OR RESPONSE', sections.ptLoop, 'ordering provider') +
    `Open the worklist to action these. Every row needs a documented outcome, even if that outcome is "called, left message".\n`;

  // ---- html ----
  const htmlSection = (title, entries, owner) => {
    if (!entries.length) return '';
    const rows = entries.map((e) => `<tr>
        <td style="padding:7px 10px;white-space:nowrap;vertical-align:top">
          <b style="color:${SEVERITY_COLOR[e.rung.severity]};font-family:ui-monospace,Menlo,Consolas,monospace">${e.rung.code}</b>
        </td>
        <td style="padding:7px 10px;vertical-align:top">
          <b>${escapeHtml(describe(e))}</b>
          <div style="color:#5b6478;font-size:12px">${escapeHtml(contextLine(e))}</div>
          <div style="color:#16213a;font-size:13px;margin-top:3px">${escapeHtml(e.rung.action)}</div>
        </td>
      </tr>`).join('');
    return `<h3 style="margin:22px 0 2px;font-size:14px;letter-spacing:.04em;text-transform:uppercase;color:#003592">
        ${escapeHtml(title)}
      </h3>
      <div style="color:#5b6478;font-size:12px;margin-bottom:6px">${escapeHtml(owner)} · ${entries.length} item${entries.length === 1 ? '' : 's'}</div>
      <table style="border-collapse:collapse;font-size:14px;width:100%">${rows}</table>`;
  };

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16213a;max-width:660px">
      <h2 style="margin:0 0 2px;color:#003592">Referral &amp; results tracker</h2>
      <div style="color:#5b6478;margin:0 0 4px">${escapeHtml(siteName)} · as of ${escapeHtml(asOf)}</div>
      <div style="color:#5b6478;font-size:13px">${total} open item${total === 1 ? '' : 's'} need attention${critical ? ` — <b style="color:#b6302f">${critical} critical</b>` : ''}.</div>
      ${htmlSection('Results due before a follow-up', sections.followup, 'Tracker owner')}
      ${htmlSection('Authorizations aging', sections.authorization, 'Authorization coordinator')}
      ${htmlSection('PT notes awaiting review or response', sections.ptLoop, 'Ordering provider')}
      <p style="color:#5b6478;font-size:12px;margin-top:24px;border-top:1px solid #dde2ee;padding-top:12px">
        Every row needs a documented outcome — even if that outcome is &ldquo;called, left message&rdquo;.
      </p>
    </div>`;

  return { subject, text, html };
}

// --- Sending ---------------------------------------------------------------

/**
 * Build and (if possible) send one site's digest.
 *
 * Returns a result object rather than throwing for the ordinary "not ready"
 * cases — no recipients, nothing to report, already sent today, SMTP absent —
 * so a caller can report status without exception handling.
 */
async function runForSite(siteId, opts = {}) {
  const { force = false, test = false, asOf = ladders.today() } = opts;

  const site = await db.get('SELECT id, name FROM sites WHERE id = ? AND active = 1', [siteId]);
  if (!site) return { sent: false, reason: 'Unknown site' };

  const to = await recipientsForSite(siteId);
  if (!to.length) return { sent: false, reason: 'No recipients configured for this site' };

  if (test) {
    if (!mailer.isConfigured()) {
      return { sent: false, reason: 'SMTP is not configured — set SMTP_HOST and SMTP_PORT to send' };
    }
    await mailer.send({
      to,
      subject: `Referral tracker — test email (${site.name})`,
      text: `This is a test from the referral & results tracker for ${site.name}. ` +
            `Reminder emails are wired up correctly.`,
    });
    return { sent: true, test: true, recipients: to.length };
  }

  if (!force && !(await remindersEnabled())) return { sent: false, reason: 'Reminders are turned off' };

  const sections = await digestSections(siteId, asOf);
  const total = totalRows(sections);
  if (!total) return { sent: false, reason: 'Nothing needs attention', count: 0 };

  const dateKey = `last_digest_date_site_${siteId}`;
  if (!force && (await getSetting(dateKey)) === asOf) {
    return { sent: false, reason: 'Already sent today', count: total };
  }

  const { subject, text, html } = buildDigest(site.name, sections, asOf);

  // No SMTP: build it, log it, report it — but do not throw. The app stays
  // usable and demonstrable before credentials exist.
  if (!mailer.isConfigured()) {
    console.log(`[reminders] would send to ${to.length} recipient(s) for ${site.name}: ${subject}`);
    return {
      sent: false,
      reason: 'SMTP is not configured — digest built but not sent',
      count: total,
      recipients: to.length,
      preview: { subject, text },
    };
  }

  await mailer.send({ to, subject, text, html });
  await auth.setSetting(dateKey, asOf);

  // Record on each order that a reminder went out, so the outreach trail is
  // complete — an auditor should be able to see the system chased it.
  const ids = [...new Set([
    ...sections.followup, ...sections.authorization, ...sections.ptLoop,
  ].map((e) => e.order.id))];
  for (const id of ids) {
    await db.run(
      'INSERT INTO order_events(order_id, kind, note, actor) VALUES(?, ?, ?, ?)',
      [id, 'reminder_sent', `Included in the ${asOf} digest for ${site.name}`, 'system']
    );
  }

  return { sent: true, count: total, recipients: to.length };
}

/** Run the check for every active site. Used by the scheduled function. */
async function runScheduledCheck(opts = {}) {
  if (!opts.force && !(await remindersEnabled())) {
    return { checked: 0, results: [], reason: 'Reminders are turned off' };
  }
  const sites = await db.all('SELECT id FROM sites WHERE active = 1');
  const results = [];
  for (const s of sites) {
    try {
      results.push({ site_id: s.id, ...(await runForSite(s.id, opts)) });
    } catch (e) {
      results.push({ site_id: s.id, sent: false, reason: e.message });
    }
  }
  return { checked: sites.length, results };
}

/** Always-on hosts only: hourly tick. Serverless uses the scheduled function. */
let timer = null;
function startScheduler() {
  if (timer) return;
  const tick = () =>
    runScheduledCheck().catch((e) => console.error('Reminder check failed:', e.message));
  timer = setInterval(tick, 60 * 60 * 1000);
  setTimeout(tick, 10 * 1000);
}

module.exports = {
  remindersEnabled,
  thresholds,
  recipientsOverview,
  recipientsForSite,
  addRecipient,
  removeRecipient,
  digestSections,
  buildDigest,
  runForSite,
  runScheduledCheck,
  startScheduler,
};
