'use strict';

/**
 * The work-comp escalation block gate.
 *
 * claim_number / employer / adjuster_name / adjuster_contact / case_manager are
 * genuinely useful — they are who you call when an authorization stalls — but a
 * claim number and an employer are identifying, so they are OFF by default.
 *
 * The gate is enforced HERE, on the server, not by hiding inputs in the UI. A
 * hidden field is a UI convenience; a rejected field is a control. When the
 * block is off the API refuses these keys outright (400) rather than silently
 * dropping them, so nobody can believe they recorded an adjuster's number that
 * was never stored.
 */

const auth = require('./auth');

const WC_FIELDS = ['claim_number', 'employer', 'adjuster_name', 'adjuster_contact', 'case_manager'];

const SETTING_KEY = 'wc_block_enabled';

/** Is the work-comp escalation block currently turned on? Default: no. */
async function enabled() {
  return (await auth.getSetting(SETTING_KEY)) === '1';
}

async function setEnabled(on) {
  await auth.setSetting(SETTING_KEY, on ? '1' : '0');
}

/**
 * Throw a 400 if the payload carries work-comp escalation fields while the
 * block is disabled. Empty strings and nulls are ignored — a form that posts
 * blank keys is not an attempt to store anything.
 */
async function assertAllowed(payload) {
  if (!payload) return;
  const present = WC_FIELDS.filter((f) => {
    const v = payload[f];
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
  if (!present.length) return;
  if (await enabled()) return;

  const e = new Error(
    `The work-comp escalation block is turned off, so ${present.join(', ')} cannot be stored. ` +
    'Leadership can enable it in Settings once Compliance has signed off.'
  );
  e.status = 400;
  throw e;
}

/** Strip the block from a row on the way out when it is disabled. */
async function redact(row) {
  if (!row) return row;
  if (await enabled()) return row;
  const copy = { ...row };
  for (const f of WC_FIELDS) delete copy[f];
  return copy;
}

async function redactAll(rows) {
  if (await enabled()) return rows;
  return rows.map((r) => {
    const copy = { ...r };
    for (const f of WC_FIELDS) delete copy[f];
    return copy;
  });
}

module.exports = { WC_FIELDS, SETTING_KEY, enabled, setEnabled, assertAllowed, redact, redactAll };
