'use strict';

/**
 * The rung engine.
 *
 * Three independent escalation ladders decide what shows up on a worklist and
 * what an email digest says. Each is a pure function of one order row plus
 * today's date — no database access — so they are cheap to call in a loop and
 * trivial to test (see test/ladders.test.js).
 *
 *   Follow-up readiness (T-10 → T-0)  counts DOWN to the follow-up appointment.
 *   Authorization aging  (A-1 → A-5)  counts UP from the authorization request.
 *   PT note review       (P-1 → P-5)  tracks the two-way progress-note loop.
 *
 * Why three rather than one: an authorization can sit untouched for three weeks
 * while the follow-up is still comfortably distant. A single countdown keyed on
 * the appointment date would not surface it until far too late. Likewise a PT
 * note that never arrives produces no signal at all unless something is
 * watching the *expected* date. Each ladder catches what the others miss.
 *
 * Severity vocabulary is calm | watch | urgent | critical, which maps onto the
 * four-tier status scale already defined in public/common.css
 * (--good / --warn / --serious / --danger).
 */

const SEVERITY_ORDER = { critical: 0, urgent: 1, watch: 2, calm: 3 };

/** Default thresholds. Leadership can override these in Settings without a deploy. */
const DEFAULT_THRESHOLDS = {
  // Follow-up readiness — business days before the appointment.
  followup_sweep: 10,
  followup_outreach: 7,
  followup_escalate: 3,
  followup_decision: 1,
  // Authorization aging — business days since the request.
  auth_followup: 3,
  auth_escalate: 7,
  auth_formal: 14,
  auth_unscheduled: 5,
  // PT progress-note review — business days.
  pt_review_reminder: 3,
  pt_review_escalate: 5,
  pt_response_due: 2,
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD string to a UTC Date at midnight. Returns null if absent/invalid. */
function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Today as a YYYY-MM-DD string (UTC). */
function today() {
  return new Date().toISOString().slice(0, 10);
}

function isWeekend(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Business days from `from` to `to`, counting weekdays strictly between the two
 * dates and including the end date. Negative when `to` is in the past.
 *
 * Holidays are NOT accounted for — a Thanksgiving or Christmas week will read
 * one or two days more generous than reality. Documented rather than silently
 * approximated; if it matters, a holiday table is the fix.
 */
function businessDaysBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;

  const sign = b >= a ? 1 : -1;
  let count = 0;
  const cursor = new Date(a.getTime());
  while (cursor.getTime() !== b.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + sign);
    if (!isWeekend(cursor)) count += sign;
  }
  return count;
}

/** Calendar days between two YYYY-MM-DD strings. Negative when `to` precedes `from`. */
function calendarDaysBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// Ladder 1 — follow-up readiness (counts down)
// ---------------------------------------------------------------------------

/**
 * Where this order sits on the countdown to the patient's follow-up.
 *
 * Only applies while the order is open, a follow-up date is known, and the
 * result has NOT arrived — once the result is in, the whole point of the
 * countdown is satisfied and the order drops off the worklist.
 *
 * Returns null when the ladder does not apply or the appointment is still
 * further out than the first rung.
 */
function followupRung(o, asOf = today(), thresholds = DEFAULT_THRESHOLDS) {
  if (!o || o.status !== 'open') return null;
  if (o.result_received_on) return null;
  if (!o.followup_on) return null;

  const days = businessDaysBetween(asOf, o.followup_on);
  if (days === null) return null;

  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  // Past the appointment: the visit already happened without the result.
  if (days < 0) {
    return rung('T-0', 'critical', days,
      'Follow-up has passed without this result. Record the outcome and close or re-order.');
  }
  if (days === 0) {
    return rung('T-0', 'critical', days,
      'Visit is today and the result is not here. Flag the schedule so the provider knows before the room.');
  }
  if (days <= t.followup_decision) {
    return rung('T-1', 'critical', days,
      'Decision required: proceed without it, reschedule, or convert the visit type. Record the decision.');
  }
  if (days <= t.followup_escalate) {
    return rung('T-3', 'urgent', days,
      'Escalate. Second outreach to the facility; notify the ordering provider that the result is at risk.');
  }
  if (days <= t.followup_outreach) {
    return rung('T-7', 'watch', days,
      'First documented outreach to the facility. Log the contact name and the outcome.');
  }
  if (days <= t.followup_sweep) {
    return rung('T-10', 'calm', days,
      'Status sweep — confirm the scheduled or performed status with the facility.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ladder 2 — authorization aging (counts up)
// ---------------------------------------------------------------------------

/**
 * Where this order sits on the authorization ladder.
 *
 * A-4 (denied) fires on status alone regardless of age — a denial needs a
 * peer-to-peer decision whether it landed today or a fortnight ago.
 * A-5 catches the quiet failure of an approval that expires unused.
 */
function authRung(o, asOf = today(), thresholds = DEFAULT_THRESHOLDS) {
  if (!o || o.status !== 'open') return null;
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  if (o.auth_status === 'denied') {
    return rung('A-4', 'critical', null,
      'Peer-to-peer decision within 2 business days: pursue P2P, appeal, modify the order, or revise the plan.');
  }

  // Approved but nobody booked it — the approval can expire and reset everything.
  if (o.auth_status === 'approved' && !o.scheduled_on) {
    const since = o.auth_decided_on ? businessDaysBetween(o.auth_decided_on, asOf) : null;
    if (since !== null && since >= t.auth_unscheduled) {
      return rung('A-5', 'watch', since,
        'Approved but not scheduled. Contact the patient and facility; watch the authorization expiry.');
    }
    return null;
  }

  if (o.auth_status !== 'requested' && o.auth_status !== 'pending') return null;

  const since = businessDaysBetween(o.auth_requested_on, asOf);
  if (since === null) return null;

  if (since >= t.auth_formal) {
    return rung('A-3', 'urgent', since,
      'Formal escalation. Notify the provider that the plan may need revision.');
  }
  if (since >= t.auth_escalate) {
    return rung('A-2', 'watch', since,
      'Escalate to the adjuster supervisor or the nurse case manager.');
  }
  if (since >= t.auth_followup) {
    return rung('A-1', 'calm', since,
      'Follow up with the carrier or payer; document the contact.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ladder 3 — PT progress-note review (the two-way loop)
// ---------------------------------------------------------------------------

/**
 * Where a therapy order sits on the review-and-respond loop.
 *
 * P-5 is the "silent absence" catch: a note that never arrives generates no
 * signal unless something watches the expected date. It requires
 * expected_result_on to be set — without that date the app is blind, which is
 * exactly the failure the tracker exists to remove.
 */
function ptRung(o, asOf = today(), thresholds = DEFAULT_THRESHOLDS) {
  if (!o || o.status !== 'open') return null;
  if (o.order_type !== 'pt' && o.order_type !== 'ot') return null;
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  // Reviewed, but our response has not gone back. The loop is not closed.
  if (o.review_status === 'reviewed' && !o.response_sent_on) {
    const since = o.result_received_on ? businessDaysBetween(o.result_received_on, asOf) : null;
    if (since !== null && since >= t.pt_response_due) {
      return rung('P-4', 'critical', since,
        'The loop is not closed until PT has our response. Send it and record the date.');
    }
    return rung('P-4', 'watch', since,
      'Response back to PT is due. Send it and record the date.');
  }

  // Note received, awaiting provider review.
  if (o.result_received_on && o.review_status === 'awaiting') {
    const since = businessDaysBetween(o.result_received_on, asOf);
    if (since === null) return null;
    if (since >= t.pt_review_escalate) {
      return rung('P-3', 'urgent', since, 'Review overdue — escalate to the site lead.');
    }
    if (since >= t.pt_review_reminder) {
      return rung('P-2', 'watch', since, 'Progress note still awaiting provider review.');
    }
    return rung('P-1', 'calm', since, 'Progress note received — routed to the provider review queue.');
  }

  // Nothing received and the note was expected by now: the silent absence.
  if (!o.result_received_on && o.expected_result_on) {
    const overdue = businessDaysBetween(o.expected_result_on, asOf);
    if (overdue !== null && overdue > 0) {
      return rung('P-5', 'urgent', overdue,
        'Expected progress note never arrived. Outreach to the PT clinic.');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

function rung(code, severity, days, action) {
  return { code, severity, days, action };
}

/**
 * All applicable rungs for an order, most severe first, plus a convenience
 * `top` rung used for sorting and colouring a row.
 */
function rungsFor(o, asOf = today(), thresholds = DEFAULT_THRESHOLDS) {
  const list = [
    followupRung(o, asOf, thresholds),
    authRung(o, asOf, thresholds),
    ptRung(o, asOf, thresholds),
  ].filter(Boolean);

  list.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    // Within a severity, the more urgent is the smaller countdown / larger age.
    return (a.days ?? 0) - (b.days ?? 0);
  });

  return { rungs: list, top: list[0] || null };
}

/** Sort comparator for decorated orders: most severe first, then soonest follow-up. */
function bySeverity(a, b) {
  const at = a.top ? SEVERITY_ORDER[a.top.severity] : 99;
  const bt = b.top ? SEVERITY_ORDER[b.top.severity] : 99;
  if (at !== bt) return at - bt;
  const ad = a.days_until_followup ?? 9999;
  const bd = b.days_until_followup ?? 9999;
  return ad - bd;
}

/** Decorate an order row with its rungs and the derived day counts the UI shows. */
function decorate(o, asOf = today(), thresholds = DEFAULT_THRESHOLDS) {
  const { rungs, top } = rungsFor(o, asOf, thresholds);
  return {
    ...o,
    rungs,
    top,
    days_until_followup: o.followup_on ? businessDaysBetween(asOf, o.followup_on) : null,
    days_auth_pending:
      (o.auth_status === 'requested' || o.auth_status === 'pending') && o.auth_requested_on
        ? businessDaysBetween(o.auth_requested_on, asOf)
        : null,
    turnaround_days:
      o.ordered_on && o.result_received_on
        ? calendarDaysBetween(o.ordered_on, o.result_received_on)
        : null,
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  SEVERITY_ORDER,
  parseDate,
  today,
  isWeekend,
  businessDaysBetween,
  calendarDaysBetween,
  followupRung,
  authRung,
  ptRung,
  rungsFor,
  decorate,
  bySeverity,
};
