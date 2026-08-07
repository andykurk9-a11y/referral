'use strict';

/**
 * Staff worklist. Vanilla JS, no build step — same approach as the DME tracker
 * so anyone who can maintain that can maintain this.
 */

// ── tiny helpers ────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const ORDER_TYPE = { pt: 'Physical therapy', ot: 'Occupational therapy', mri: 'MRI', ct: 'CT', other: 'Other' };
const AUTH_LABEL = {
  not_required: 'Not required', requested: 'Requested', pending: 'Pending',
  approved: 'Approved', denied: 'Denied', p2p: 'Peer-to-peer', appealed: 'Appealed',
};
const REVIEW_LABEL = { awaiting: 'Awaiting review', reviewed: 'Reviewed', response_sent: 'Response sent' };
const OUTCOME_LABEL = {
  result_received: 'Result received', patient_no_show: 'Patient no-showed',
  went_elsewhere: 'Went to another facility', cancelled_by_provider: 'Cancelled by provider',
  cancelled_by_carrier: 'Cancelled by carrier', patient_discharged: 'Patient discharged',
  claim_closed: 'Claim closed', other: 'Other',
};

const VIEW_HINT = {
  worklist: 'Open orders whose result has not arrived and whose follow-up is within ten business days. Work top-down; every row needs a documented outcome.',
  auth: 'Authorizations that are requested, pending, denied or under appeal — oldest first. These stall long before the follow-up gets close.',
  review: 'Results that have arrived and are waiting on the ordering provider.',
  pt_response: 'Reviewed progress notes where our response has not gone back to PT. The loop is not closed until it does.',
  open: 'Every open order at this site.',
};

function describe(o) {
  const bits = [ORDER_TYPE[o.order_type] || o.order_type];
  if (o.body_part) bits.push(o.body_part);
  if (o.laterality && o.laterality !== 'na') bits.push(o.laterality);
  return bits.join(' · ');
}

function fmtDays(n) {
  if (n == null) return '—';
  if (n < 0) return `${Math.abs(n)}d ago`;
  if (n === 0) return 'today';
  return `${n}d`;
}

// ── state ───────────────────────────────────────────────────────────────────

const state = { site: null, view: 'worklist', reference: null, config: null };

// ── sign in ─────────────────────────────────────────────────────────────────

async function boot() {
  state.config = await api('/api/config');
  if (state.config.demo_banner && sessionStorage.getItem('demoDismissed') !== '1') {
    $('#demoBanner').hidden = false;
  }

  const me = await api('/api/site/me');
  if (me.signed_in) {
    state.site = me.site;
    await showApp();
  } else {
    await showSignin();
  }
}

async function showSignin() {
  $('#app').hidden = true;
  $('#signin').hidden = false;
  const sites = await api('/api/sites');
  const sel = $('#siteSelect');
  sel.innerHTML = '';
  if (!sites.length) {
    sel.appendChild(el('option', null, 'No sites configured'));
    sel.disabled = true;
    return;
  }
  for (const s of sites) {
    const o = el('option', null, s.name);
    o.value = s.id;
    sel.appendChild(o);
  }
}

$('#signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#signinError');
  err.hidden = true;
  try {
    const r = await api('/api/site/login', {
      method: 'POST',
      body: { site_id: Number($('#siteSelect').value), pin: $('#pinInput').value },
    });
    state.site = r.site;
    $('#pinInput').value = '';
    await showApp();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
});

$('#signoutBtn').addEventListener('click', async () => {
  await api('/api/site/logout', { method: 'POST' });
  state.site = null;
  await showSignin();
});

$('#dismissBanner').addEventListener('click', () => {
  sessionStorage.setItem('demoDismissed', '1');
  $('#demoBanner').hidden = true;
});

async function showApp() {
  $('#signin').hidden = true;
  $('#app').hidden = false;
  $('#siteName').textContent = state.site.name;
  state.reference = await api('/api/reference');
  fillReferenceSelects();
  await refresh();
}

// ── tabs ────────────────────────────────────────────────────────────────────

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    state.view = tab.dataset.tab;
    refresh();
  });
});

// ── list ────────────────────────────────────────────────────────────────────

async function refresh() {
  $('#viewHint').textContent = VIEW_HINT[state.view] || '';

  const [orders, counts] = await Promise.all([
    api(`/api/orders?view=${encodeURIComponent(state.view)}`),
    api('/api/counts'),
  ]);

  for (const [key, value] of Object.entries(counts)) {
    const badge = $(`[data-count="${key}"]`);
    if (badge) badge.textContent = value;
  }

  const list = $('#list');
  list.innerHTML = '';

  if (!orders.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('strong', null, 'Nothing here'));
    empty.appendChild(el('div', null,
      state.view === 'worklist'
        ? 'No results are outstanding for a follow-up in the next ten business days.'
        : 'No orders match this view.'));
    list.appendChild(empty);
    return;
  }

  for (const o of orders) list.appendChild(renderRow(o));
}

function renderRow(o) {
  const sev = o.top ? o.top.severity : 'none';
  const row = el('button', `row sev-${sev}`);
  row.type = 'button';
  row.addEventListener('click', () => openDrawer(o.id));

  row.appendChild(el('div', `rung sev-${sev}`, o.top ? o.top.code : '—'));

  const main = el('div', 'row-main');
  const title = el('div', 'row-title');
  title.appendChild(el('span', 'row-ref', o.reference));
  title.appendChild(el('span', 'row-desc', describe(o)));
  if (o.case_type === 'wc') title.appendChild(el('span', 'pill wc', 'Work comp'));
  main.appendChild(title);

  if (o.top) main.appendChild(el('div', 'row-action', o.top.action));

  const meta = [];
  if (o.facility_name) meta.push(o.facility_name);
  if (o.provider_name) meta.push(o.provider_name);
  if (o.auth_status && o.auth_status !== 'not_required') meta.push(`Auth: ${AUTH_LABEL[o.auth_status]}`);
  if (meta.length) main.appendChild(el('div', 'row-meta', meta.join(' · ')));
  row.appendChild(main);

  const right = el('div', 'row-right');
  if (state.view === 'auth') {
    right.appendChild(el('div', 'row-days', fmtDays(o.days_auth_pending)));
    right.appendChild(el('div', 'row-days-label', 'pending'));
  } else {
    right.appendChild(el('div', 'row-days', fmtDays(o.days_until_followup)));
    right.appendChild(el('div', 'row-days-label', 'to follow-up'));
  }
  row.appendChild(right);

  return row;
}

// ── drawer ──────────────────────────────────────────────────────────────────

function closeDrawer() { $('#drawer').hidden = true; }
$$('[data-close-drawer]').forEach((n) => n.addEventListener('click', closeDrawer));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#drawer').hidden) closeDrawer();
  else if (!$('#newOrder').hidden) closeNew();
});

async function openDrawer(id) {
  const { order, events } = await api(`/api/orders/${id}`);
  $('#drawerTitle').textContent = order.reference;
  $('#drawerSub').textContent = `${describe(order)} · ${order.status}`;
  const body = $('#drawerBody');
  body.innerHTML = '';

  // Why this order is on a list, and what to do about it.
  if (order.rungs && order.rungs.length) {
    const card = el('div', 'card');
    card.appendChild(el('h3', null, 'Why this is on the list'));
    for (const r of order.rungs) {
      const item = el('div', 'rung-item');
      item.appendChild(el('div', `rung sev-${r.severity}`, r.code));
      const right = el('div');
      right.appendChild(el('div', 'action', r.action));
      if (r.days != null) right.appendChild(el('div', 'row-meta', `${fmtDays(r.days)}`));
      item.appendChild(right);
      card.appendChild(item);
    }
    body.appendChild(card);
  }

  body.appendChild(detailCard(order));
  body.appendChild(actionsCard(order));
  body.appendChild(logCard(events));

  $('#drawer').hidden = false;
}

function detailCard(o) {
  const card = el('div', 'card');
  card.appendChild(el('h3', null, 'Detail'));
  const dl = el('dl', 'kv');
  const add = (k, v) => {
    if (v == null || v === '') return;
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, v));
  };
  add('Order type', ORDER_TYPE[o.order_type]);
  add('Case type', o.case_type === 'wc' ? 'Work comp' : 'Non-work-comp');
  add('Body part', o.body_part);
  add('Laterality', o.laterality && o.laterality !== 'na' ? o.laterality : null);
  add('Provider', o.provider_name);
  add('Facility', o.facility_name);
  add('Carrier / payer', o.carrier_name);
  add('Ordered', o.ordered_on);
  add('Authorization', AUTH_LABEL[o.auth_status]);
  add('Auth requested', o.auth_requested_on);
  add('Auth decided', o.auth_decided_on);
  add('Auth expires', o.auth_expires_on);
  add('Scheduled', o.scheduled_on);
  add('Result expected', o.expected_result_on);
  add('Follow-up', o.followup_on);
  add('Result received', o.result_received_on);
  add('Review', REVIEW_LABEL[o.review_status]);
  add('Response sent', o.response_sent_on);
  add('Owner', o.owner_name);
  add('Outcome', OUTCOME_LABEL[o.outcome]);
  // Present only when leadership has enabled the escalation block.
  add('Claim number', o.claim_number);
  add('Employer', o.employer);
  add('Adjuster', o.adjuster_name);
  add('Adjuster contact', o.adjuster_contact);
  add('Case manager', o.case_manager);
  card.appendChild(dl);
  return card;
}

function actionsCard(o) {
  const card = el('div', 'card');
  card.appendChild(el('h3', null, 'Actions'));

  const msg = el('p');
  msg.hidden = true;

  const run = async (fn) => {
    msg.hidden = true;
    try {
      await fn();
      closeDrawer();
      await refresh();
    } catch (e) {
      msg.className = 'error';
      msg.textContent = e.message;
      msg.hidden = false;
    }
  };

  const actions = el('div', 'actions');
  const button = (label, kind, handler) => {
    const b = el('button', kind, label);
    b.type = 'button';
    b.addEventListener('click', handler);
    actions.appendChild(b);
    return b;
  };

  if (o.status === 'open') {
    // Touchpoint 3
    if (!o.result_received_on) {
      button('Result received', 'primary', () => run(() =>
        api(`/api/orders/${o.id}/result`, { method: 'POST', body: {} })));
    }
    // Touchpoint 4
    if (o.result_received_on && o.review_status === 'awaiting') {
      button('Provider reviewed', 'primary', () => run(() =>
        api(`/api/orders/${o.id}/review`, { method: 'POST', body: {} })));
    }
    // The return leg
    if (o.review_status === 'reviewed' && !o.response_sent_on) {
      button('Response sent to PT', 'primary', () => run(async () => {
        const next = prompt(
          'Date the next progress note is expected (YYYY-MM-DD).\n\n' +
          'Leave blank only if the plan of care has ended — without this date, ' +
          'a note that never arrives raises no alarm.');
        if (next === null) return;
        await api(`/api/orders/${o.id}/response`, {
          method: 'POST',
          body: next ? { next_expected_on: next } : { end_plan_of_care: true },
        });
      }));
    }

    button('Log outreach', 'ghost', () => run(async () => {
      const note = prompt('Who did you contact, and what was the outcome?\n\n' +
        'This log is part of the record and may be read by an attorney — keep it factual.');
      if (!note) return;
      await api(`/api/orders/${o.id}/outreach`, { method: 'POST', body: { note } });
    }));

    button('Update authorization', 'ghost', () => run(async () => {
      const status = prompt('Authorization status:\n' +
        'not_required, requested, pending, approved, denied, p2p, appealed');
      if (!status) return;
      await api(`/api/orders/${o.id}/auth`, { method: 'POST', body: { auth_status: status.trim() } });
    }));

    button('Close order', 'ghost', () => run(async () => {
      const outcome = prompt('Outcome:\n' + Object.keys(OUTCOME_LABEL).join(', '));
      if (!outcome) return;
      await api(`/api/orders/${o.id}/close`, { method: 'POST', body: { outcome: outcome.trim() } });
    }));
  } else {
    button('Reopen', 'ghost', () => run(() =>
      api(`/api/orders/${o.id}/reopen`, { method: 'POST', body: {} })));
  }

  button('Add note', 'ghost', () => run(async () => {
    const note = prompt('Note');
    if (!note) return;
    await api(`/api/orders/${o.id}/note`, { method: 'POST', body: { note } });
  }));

  card.appendChild(actions);
  card.appendChild(msg);
  return card;
}

function logCard(events) {
  const card = el('div', 'card');
  card.appendChild(el('h3', null, `History — ${events.length} entr${events.length === 1 ? 'y' : 'ies'}`));
  const ul = el('ul', 'log');
  for (const e of events) {
    const li = el('li');
    const head = el('div');
    head.appendChild(el('span', `kind ${e.kind}`, e.kind.replace(/_/g, ' ')));
    head.appendChild(document.createTextNode(e.note || ''));
    li.appendChild(head);
    li.appendChild(el('div', 'when', `${e.created_at}${e.actor ? ` · ${e.actor}` : ''}`));
    ul.appendChild(li);
  }
  card.appendChild(ul);
  return card;
}

// ── new order ───────────────────────────────────────────────────────────────

function fillReferenceSelects() {
  const fill = (id, rows) => {
    const sel = $(id);
    sel.innerHTML = '<option value="">—</option>';
    for (const r of rows) {
      const o = el('option', null, r.name);
      o.value = r.id;
      sel.appendChild(o);
    }
  };
  fill('#f_provider_id', state.reference.providers);
  fill('#f_facility_id', state.reference.facilities);
  fill('#f_carrier_id', state.reference.carriers);

  const on = state.reference.wc_block_enabled;
  $('#wcFields').hidden = !on;
  $('#wcOffNote').hidden = on;
}

function closeNew() { $('#newOrder').hidden = true; }
$$('[data-close-new]').forEach((n) => n.addEventListener('click', closeNew));

$('#newOrderBtn').addEventListener('click', () => {
  $('#newOrderForm').reset();
  $('#newOrderError').hidden = true;
  $('#f_ordered_on').value = new Date().toISOString().slice(0, 10);
  $('#newOrder').hidden = false;
  $('#f_reference').focus();
});

$('#newOrderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#newOrderError');
  err.hidden = true;

  const body = {};
  for (const [k, v] of new FormData(e.target).entries()) {
    if (v !== '') body[k] = v;
  }

  try {
    await api('/api/orders', { method: 'POST', body });
    closeNew();
    await refresh();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
});

// ── go ──────────────────────────────────────────────────────────────────────

function bootFailure(e) {
  // A 502/503 here means the API function itself failed to start — almost always
  // missing database environment variables on a fresh serverless deploy. Say so,
  // rather than showing a bare status code.
  const gateway = /\((50[234])\)/.test(e.message);
  const hint = gateway
    ? 'The API did not start. On a new Netlify deploy this is nearly always missing ' +
      'TURSO_DATABASE_URL / TURSO_AUTH_TOKEN — set them, then redeploy with ' +
      '"Clear cache and deploy site". The exact error is in Netlify \u2192 Functions \u2192 api \u2192 Logs.'
    : 'Reload the page. If it keeps happening, check the server logs.';
  document.body.innerHTML =
    '<div class="wrap"><div class="card"><h2>Could not start</h2>' +
    '<p class="error">' + e.message + '</p><p>' + hint + '</p></div></div>';
}

boot().catch(bootFailure);
