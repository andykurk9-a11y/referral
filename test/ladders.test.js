'use strict';

/**
 * Tests for the rung engine. Run with `npm test`.
 *
 * No framework — assert plus a tiny runner, so this works with a bare
 * `npm install` and stays runnable on any host.
 */

const assert = require('assert');
const L = require('../lib/ladders');

let passed = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, message: e.message });
  }
}

// Base order: open, PT, everything else filled in per-test.
function order(over = {}) {
  return {
    status: 'open',
    order_type: 'mri',
    auth_status: 'not_required',
    review_status: 'awaiting',
    result_received_on: null,
    response_sent_on: null,
    scheduled_on: null,
    expected_result_on: null,
    followup_on: null,
    auth_requested_on: null,
    auth_decided_on: null,
    ordered_on: '2026-03-02',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Business-day arithmetic
// ---------------------------------------------------------------------------

// 2026-03-02 is a Monday; 2026-03-06 Friday; 2026-03-07 Sat; 2026-03-09 Monday.
t('business days across a normal week', () => {
  assert.strictEqual(L.businessDaysBetween('2026-03-02', '2026-03-06'), 4);
});

t('business days skip the weekend', () => {
  // Friday to the following Monday is one business day, not three.
  assert.strictEqual(L.businessDaysBetween('2026-03-06', '2026-03-09'), 1);
});

t('business days over a full week equal five', () => {
  assert.strictEqual(L.businessDaysBetween('2026-03-02', '2026-03-09'), 5);
});

t('business days are negative looking backwards', () => {
  assert.strictEqual(L.businessDaysBetween('2026-03-09', '2026-03-02'), -5);
});

t('same day is zero business days', () => {
  assert.strictEqual(L.businessDaysBetween('2026-03-02', '2026-03-02'), 0);
});

t('weekend detection', () => {
  assert.strictEqual(L.isWeekend(L.parseDate('2026-03-07')), true);  // Sat
  assert.strictEqual(L.isWeekend(L.parseDate('2026-03-08')), true);  // Sun
  assert.strictEqual(L.isWeekend(L.parseDate('2026-03-09')), false); // Mon
});

t('missing or malformed dates yield null rather than NaN', () => {
  assert.strictEqual(L.businessDaysBetween(null, '2026-03-02'), null);
  assert.strictEqual(L.businessDaysBetween('2026-03-02', 'not-a-date'), null);
});

// ---------------------------------------------------------------------------
// Ladder 1 — follow-up readiness
// ---------------------------------------------------------------------------

const asOf = '2026-03-02'; // Monday

t('T-10 fires at ten business days out', () => {
  // 10 business days after Mon 2026-03-02 is Mon 2026-03-16.
  const r = L.followupRung(order({ followup_on: '2026-03-16' }), asOf);
  assert.strictEqual(r.code, 'T-10');
  assert.strictEqual(r.severity, 'calm');
});

t('T-7 fires at seven business days out', () => {
  const r = L.followupRung(order({ followup_on: '2026-03-11' }), asOf);
  assert.strictEqual(r.code, 'T-7');
  assert.strictEqual(r.severity, 'watch');
});

t('T-3 fires at three business days out', () => {
  const r = L.followupRung(order({ followup_on: '2026-03-05' }), asOf);
  assert.strictEqual(r.code, 'T-3');
  assert.strictEqual(r.severity, 'urgent');
});

t('T-1 fires the business day before', () => {
  const r = L.followupRung(order({ followup_on: '2026-03-03' }), asOf);
  assert.strictEqual(r.code, 'T-1');
  assert.strictEqual(r.severity, 'critical');
});

t('T-0 fires on the day of the visit', () => {
  const r = L.followupRung(order({ followup_on: '2026-03-02' }), asOf);
  assert.strictEqual(r.code, 'T-0');
  assert.strictEqual(r.severity, 'critical');
});

t('a follow-up already missed stays critical', () => {
  const r = L.followupRung(order({ followup_on: '2026-02-25' }), asOf);
  assert.strictEqual(r.code, 'T-0');
  assert.strictEqual(r.severity, 'critical');
  assert.ok(r.days < 0, 'days should be negative for a passed appointment');
});

t('nothing fires when the follow-up is beyond the first rung', () => {
  assert.strictEqual(L.followupRung(order({ followup_on: '2026-04-30' }), asOf), null);
});

t('the countdown stops once the result has arrived', () => {
  const o = order({ followup_on: '2026-03-03', result_received_on: '2026-03-01' });
  assert.strictEqual(L.followupRung(o, asOf), null);
});

t('the countdown does not apply to a closed order', () => {
  const o = order({ followup_on: '2026-03-03', status: 'complete' });
  assert.strictEqual(L.followupRung(o, asOf), null);
});

t('no follow-up date means no countdown', () => {
  assert.strictEqual(L.followupRung(order({ followup_on: null }), asOf), null);
});

// ---------------------------------------------------------------------------
// Ladder 2 — authorization aging
// ---------------------------------------------------------------------------

t('A-1 fires after three business days pending', () => {
  const o = order({ auth_status: 'pending', auth_requested_on: '2026-02-25' });
  const r = L.authRung(o, asOf);
  assert.strictEqual(r.code, 'A-1');
  assert.strictEqual(r.severity, 'calm');
});

t('A-2 fires after seven business days pending', () => {
  const o = order({ auth_status: 'pending', auth_requested_on: '2026-02-19' });
  const r = L.authRung(o, asOf);
  assert.strictEqual(r.code, 'A-2');
});

t('A-3 fires after fourteen business days pending', () => {
  const o = order({ auth_status: 'requested', auth_requested_on: '2026-02-09' });
  const r = L.authRung(o, asOf);
  assert.strictEqual(r.code, 'A-3');
  assert.strictEqual(r.severity, 'urgent');
});

t('A-4 fires on denial regardless of age', () => {
  const r = L.authRung(order({ auth_status: 'denied' }), asOf);
  assert.strictEqual(r.code, 'A-4');
  assert.strictEqual(r.severity, 'critical');
});

t('A-5 catches an approval nobody scheduled', () => {
  const o = order({ auth_status: 'approved', auth_decided_on: '2026-02-20', scheduled_on: null });
  const r = L.authRung(o, asOf);
  assert.strictEqual(r.code, 'A-5');
});

t('an approved and scheduled order is quiet', () => {
  const o = order({ auth_status: 'approved', auth_decided_on: '2026-02-20', scheduled_on: '2026-03-10' });
  assert.strictEqual(L.authRung(o, asOf), null);
});

t('a freshly requested auth is quiet', () => {
  const o = order({ auth_status: 'requested', auth_requested_on: '2026-03-02' });
  assert.strictEqual(L.authRung(o, asOf), null);
});

t('auth ladder ignores orders needing no authorization', () => {
  assert.strictEqual(L.authRung(order({ auth_status: 'not_required' }), asOf), null);
});

// ---------------------------------------------------------------------------
// Ladder 3 — PT progress-note review
// ---------------------------------------------------------------------------

t('P-1 on a freshly received note', () => {
  const o = order({ order_type: 'pt', result_received_on: '2026-03-02', review_status: 'awaiting' });
  const r = L.ptRung(o, asOf);
  assert.strictEqual(r.code, 'P-1');
});

t('P-2 when review is three business days late', () => {
  const o = order({ order_type: 'pt', result_received_on: '2026-02-25', review_status: 'awaiting' });
  assert.strictEqual(L.ptRung(o, asOf).code, 'P-2');
});

t('P-3 when review is five business days late', () => {
  const o = order({ order_type: 'pt', result_received_on: '2026-02-23', review_status: 'awaiting' });
  assert.strictEqual(L.ptRung(o, asOf).code, 'P-3');
});

t('P-4 when the response back to PT is overdue', () => {
  const o = order({
    order_type: 'pt', result_received_on: '2026-02-25',
    review_status: 'reviewed', response_sent_on: null,
  });
  const r = L.ptRung(o, asOf);
  assert.strictEqual(r.code, 'P-4');
  assert.strictEqual(r.severity, 'critical');
});

t('P-5 catches a progress note that never arrived', () => {
  const o = order({ order_type: 'pt', expected_result_on: '2026-02-25', result_received_on: null });
  const r = L.ptRung(o, asOf);
  assert.strictEqual(r.code, 'P-5');
  assert.strictEqual(r.severity, 'urgent');
});

t('P-5 cannot fire without an expected-result date — the blind spot', () => {
  const o = order({ order_type: 'pt', expected_result_on: null, result_received_on: null });
  assert.strictEqual(L.ptRung(o, asOf), null);
});

t('the loop closes once the response is sent', () => {
  const o = order({
    order_type: 'pt', result_received_on: '2026-02-25',
    review_status: 'response_sent', response_sent_on: '2026-02-26',
  });
  assert.strictEqual(L.ptRung(o, asOf), null);
});

t('the PT ladder does not apply to imaging', () => {
  const o = order({ order_type: 'mri', result_received_on: '2026-02-20', review_status: 'awaiting' });
  assert.strictEqual(L.ptRung(o, asOf), null);
});

// ---------------------------------------------------------------------------
// Combination + decoration
// ---------------------------------------------------------------------------

t('the most severe rung wins across ladders', () => {
  // Ten days out (calm) but the authorization is denied (critical).
  const o = order({ followup_on: '2026-03-16', auth_status: 'denied' });
  const { top, rungs } = L.rungsFor(o, asOf);
  assert.strictEqual(rungs.length, 2);
  assert.strictEqual(top.code, 'A-4');
});

t('an order can sit on all three ladders at once', () => {
  const o = order({
    order_type: 'pt',
    followup_on: '2026-03-05',                 // T-3
    auth_status: 'pending', auth_requested_on: '2026-02-09', // A-3
    expected_result_on: '2026-02-25',          // P-5
  });
  assert.strictEqual(L.rungsFor(o, asOf).rungs.length, 3);
});

t('decorate exposes the day counts the UI renders', () => {
  const o = order({ followup_on: '2026-03-05', ordered_on: '2026-02-02', result_received_on: null });
  const d = L.decorate(o, asOf);
  assert.strictEqual(d.days_until_followup, 3);
  assert.strictEqual(d.turnaround_days, null);
});

t('turnaround is calendar days from order to result', () => {
  const o = order({ ordered_on: '2026-02-02', result_received_on: '2026-02-12' });
  assert.strictEqual(L.decorate(o, asOf).turnaround_days, 10);
});

t('severity sort puts critical first', () => {
  const rows = [
    L.decorate(order({ followup_on: '2026-03-16' }), asOf),                 // calm
    L.decorate(order({ followup_on: '2026-03-03' }), asOf),                 // critical
    L.decorate(order({ followup_on: '2026-03-11' }), asOf),                 // watch
  ];
  rows.sort(L.bySeverity);
  assert.strictEqual(rows[0].top.code, 'T-1');
  assert.strictEqual(rows[2].top.code, 'T-10');
});

t('thresholds are overridable without code changes', () => {
  const o = order({ followup_on: '2026-03-16' });
  // Narrow the sweep window to 5 days: a 10-day-out order should go quiet.
  assert.strictEqual(L.followupRung(o, asOf, { followup_sweep: 5 }), null);
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} failing, ${passed} passing\n`);
  failures.forEach((f) => console.error(`  ✗ ${f.name}\n      ${f.message}`));
  process.exit(1);
}
console.log(`${passed} passing`);
