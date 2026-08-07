'use strict';

/** Leadership view. Vanilla JS, no build step. */

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

function flash(node, message, ok = true) {
  node.textContent = message;
  node.className = ok ? 'ok' : 'error';
  node.hidden = false;
  setTimeout(() => { node.hidden = true; }, 6000);
}

/** Build a table from a column spec. Keeps every table on one code path. */
function table(target, columns, rows, emptyText) {
  const t = $(target);
  t.innerHTML = '';
  if (!rows.length) {
    const tb = el('tbody');
    const tr = el('tr');
    const td = el('td', 'muted', emptyText || 'Nothing yet');
    td.colSpan = columns.length;
    tr.appendChild(td);
    tb.appendChild(tr);
    t.appendChild(tb);
    return;
  }
  const thead = el('thead');
  const hr = el('tr');
  for (const c of columns) {
    const th = el('th', c.num ? 'num' : null, c.label);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);

  const tb = el('tbody');
  rows.forEach((r, i) => {
    const tr = el('tr');
    for (const c of columns) {
      const td = el('td', c.num ? 'num' : null);
      const v = c.render ? c.render(r, i) : r[c.key];
      if (v instanceof Node) td.appendChild(v);
      else td.textContent = v == null || v === '' ? '—' : String(v);
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  });
  t.appendChild(tb);
}

const ORDER_TYPE = { pt: 'PT', ot: 'OT', mri: 'MRI', ct: 'CT', other: 'Other' };
const AUTH_LABEL = {
  not_required: 'Not required', requested: 'Requested', pending: 'Pending',
  approved: 'Approved', denied: 'Denied', p2p: 'Peer-to-peer', appealed: 'Appealed',
};

const state = { sites: [], siteId: '', settings: null };

// ── sign in ─────────────────────────────────────────────────────────────────

async function boot() {
  const cfg = await api('/api/config');
  if (cfg.demo_banner) $('#demoBanner').hidden = false;

  const status = await api('/api/admin/status');
  if (status.signed_in) await showApp();
  else $('#signin').hidden = false;
}

$('#signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#signinError');
  err.hidden = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
    $('#pw').value = '';
    $('#signin').hidden = true;
    await showApp();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
});

$('#signoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  location.reload();
});

async function showApp() {
  $('#app').hidden = false;
  state.sites = await api('/api/admin/sites');

  const filter = $('#siteFilter');
  filter.innerHTML = '<option value="">All sites</option>';
  for (const s of state.sites) {
    const o = el('option', null, s.name);
    o.value = s.id;
    filter.appendChild(o);
  }
  filter.addEventListener('change', () => {
    state.siteId = filter.value;
    loadDashboard();
    loadOrders();
  });

  await Promise.all([
    loadDashboard(), loadScorecard(), loadOrders(),
    loadReference(), loadRecipients(), loadSettings(),
  ]);
}

// ── tabs ────────────────────────────────────────────────────────────────────

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $$('[data-panel-body]').forEach((p) => {
      p.hidden = p.dataset.panelBody !== tab.dataset.panel;
    });
  });
});

// ── dashboard ───────────────────────────────────────────────────────────────

async function loadDashboard() {
  const q = state.siteId ? `?site_id=${state.siteId}` : '';
  const d = await api(`/api/admin/dashboard${q}`);

  $('#readiness').textContent = d.readiness_pct == null ? 'No data yet' : `${d.readiness_pct}%`;
  $('#readinessSub').textContent = d.readiness_sample
    ? `${d.readiness_sample} follow-up${d.readiness_sample === 1 ? '' : 's'} whose date has passed · as of ${d.as_of}`
    : 'No follow-up dates have passed yet — this fills in as the tracker is used.';

  const stats = [
    { v: d.open_orders, l: 'Open orders' },
    { v: d.severity.critical, l: 'At a critical rung', flag: d.severity.critical > 0 },
    { v: d.median_turnaround_days == null ? '—' : `${d.median_turnaround_days}d`, l: 'Median order → result' },
    { v: d.median_auth_days == null ? '—' : `${d.median_auth_days}d`, l: 'Median auth decision' },
    { v: d.auth_denied, l: 'Authorizations denied', flag: d.auth_denied > 0 },
    { v: d.awaiting_review, l: 'Awaiting provider review' },
    { v: d.pt_response_outstanding, l: 'PT responses outstanding' },
    { v: d.pt_missing_expected_date, l: 'Therapy orders with no expected date', flag: d.pt_missing_expected_date > 0 },
  ];
  const grid = $('#stats');
  grid.innerHTML = '';
  for (const s of stats) {
    const card = el('div', `stat${s.flag ? ' flag' : ''}`);
    card.appendChild(el('div', 'stat-value', String(s.v)));
    card.appendChild(el('div', 'stat-label', s.l));
    grid.appendChild(card);
  }

  const total = Object.values(d.severity).reduce((a, b) => a + b, 0) || 1;
  const bars = $('#sevBars');
  bars.innerHTML = '';
  for (const key of ['critical', 'urgent', 'watch', 'calm']) {
    const row = el('div', 'sev-row');
    row.appendChild(el('div', 'sev-name', key));
    const track = el('div', 'sev-track');
    const fill = el('div', `sev-fill ${key}`);
    fill.style.width = `${Math.round((d.severity[key] / total) * 100)}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'sev-num', String(d.severity[key])));
    bars.appendChild(row);
  }
}

// ── scorecard ───────────────────────────────────────────────────────────────

async function loadScorecard() {
  const rows = await api('/api/admin/scorecard');
  const slowest = Math.max(1, ...rows.map((r) => r.median_days || 0));
  table('#scorecardTable', [
    { label: '#', render: (r, i) => el('span', 'rank', String(i + 1)) },
    { label: 'Facility', key: 'name' },
    { label: 'Type', render: (r) => (r.kind === 'pt' ? 'PT' : r.kind === 'imaging' ? 'Imaging' : 'Both') },
    { label: 'Median days', num: true, render: (r) => (r.median_days == null ? '—' : `${r.median_days}`) },
    {
      label: '', render: (r) => {
        const wrap = el('div', 'bar-cell');
        const bar = el('div', `bar${r.median_days >= slowest * 0.8 ? ' slow' : ''}`);
        bar.style.width = `${Math.round(((r.median_days || 0) / slowest) * 100)}%`;
        wrap.appendChild(bar);
        return wrap;
      },
    },
    { label: 'Slowest', num: true, render: (r) => (r.slowest_days == null ? '—' : `${r.slowest_days}d`) },
    { label: 'Orders', num: true, key: 'orders' },
    { label: 'Outstanding', num: true, key: 'outstanding' },
  ], rows, 'No orders have been linked to a facility yet.');
}

// ── orders ──────────────────────────────────────────────────────────────────

async function loadOrders() {
  const q = state.siteId ? `?site_id=${state.siteId}` : '';
  const rows = await api(`/api/admin/orders${q}`);
  table('#ordersTable', [
    {
      label: 'Rung', render: (r) => {
        const s = r.top ? r.top.severity : 'none';
        return el('span', `rung sev-${s}`, r.top ? r.top.code : '—');
      },
    },
    { label: 'Reference', key: 'reference' },
    { label: 'Site', key: 'site_name' },
    { label: 'Type', render: (r) => ORDER_TYPE[r.order_type] || r.order_type },
    { label: 'Body part', key: 'body_part' },
    { label: 'Facility', key: 'facility_name' },
    { label: 'Auth', render: (r) => AUTH_LABEL[r.auth_status] },
    { label: 'Follow-up', key: 'followup_on' },
    { label: 'Result', key: 'result_received_on' },
    { label: 'Status', key: 'status' },
  ], rows.slice(0, 250), 'No orders yet.');
}

// ── reference data ──────────────────────────────────────────────────────────

async function loadReference() {
  const [sites, facilities, carriers, providers] = await Promise.all([
    api('/api/admin/sites'), api('/api/admin/facilities'),
    api('/api/admin/carriers'), api('/api/admin/providers'),
  ]);
  state.sites = sites;

  table('#sitesTable', [
    { label: 'Site', key: 'name' },
    { label: 'Staff PIN', render: (r) => (r.has_pin ? 'Set' : 'Not set — staff cannot sign in') },
    { label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
  ], sites);

  table('#facilitiesTable', [
    { label: 'Facility', key: 'name' },
    { label: 'Type', render: (r) => (r.kind === 'pt' ? 'PT' : r.kind === 'imaging' ? 'Imaging' : 'Both') },
    { label: 'Phone', key: 'phone' },
    { label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
  ], facilities);

  table('#carriersTable', [
    { label: 'Carrier', key: 'name' },
    { label: 'Phone', key: 'phone' },
    { label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
  ], carriers);

  const siteName = (id) => (sites.find((s) => s.id === id) || {}).name || 'Any site';
  table('#providersTable', [
    { label: 'Provider', key: 'name' },
    { label: 'Site', render: (r) => siteName(r.site_id) },
    { label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
  ], providers);

  const ps = $('#providerSite');
  ps.innerHTML = '<option value="">Any site</option>';
  for (const s of sites) {
    const o = el('option', null, s.name);
    o.value = s.id;
    ps.appendChild(o);
  }
}

function wireCreate(formId, path, after) {
  $(formId).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of new FormData(e.target).entries()) if (v !== '') body[k] = v;
    try {
      await api(path, { method: 'POST', body });
      e.target.reset();
      await after();
    } catch (e2) {
      alert(e2.message);
    }
  });
}
wireCreate('#siteForm', '/api/admin/sites', loadReference);
wireCreate('#facilityForm', '/api/admin/facilities', loadReference);
wireCreate('#carrierForm', '/api/admin/carriers', loadReference);
wireCreate('#providerForm', '/api/admin/providers', loadReference);

// ── reminders ───────────────────────────────────────────────────────────────

async function loadRecipients() {
  const overview = await api('/api/admin/recipients');

  const box = $('#recipients');
  box.innerHTML = '';
  for (const s of overview) {
    const wrap = el('div', 'recipient-site');
    wrap.appendChild(el('h4', null, s.site_name));
    const list = el('div', 'recipient-list');
    if (!s.recipients.length) {
      list.appendChild(el('span', 'recipient-none', 'No recipients — this site gets no digest.'));
    }
    for (const r of s.recipients) {
      const chip = el('span', 'recipient');
      chip.appendChild(document.createTextNode(r.email));
      const x = el('button', null, '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${r.email}`);
      x.addEventListener('click', async () => {
        await api(`/api/admin/recipients/${r.id}`, { method: 'DELETE' });
        await loadRecipients();
      });
      chip.appendChild(x);
      list.appendChild(chip);
    }
    wrap.appendChild(list);
    box.appendChild(wrap);
  }

  const sel = $('#recipientSite');
  sel.innerHTML = '';
  for (const s of overview) {
    const o = el('option', null, s.site_name);
    o.value = s.site_id;
    sel.appendChild(o);
  }
}

$('#recipientForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const [k, v] of new FormData(e.target).entries()) body[k] = v;
  try {
    await api('/api/admin/recipients', { method: 'POST', body });
    e.target.reset();
    await loadRecipients();
    flash($('#recipientMsg'), 'Recipient added.');
  } catch (e2) {
    flash($('#recipientMsg'), e2.message, false);
  }
});

function digestSite() {
  return state.siteId || ($('#recipientSite').value || (state.sites[0] || {}).id);
}

$('#previewBtn').addEventListener('click', async () => {
  try {
    const d = await api(`/api/admin/digest/preview?site_id=${digestSite()}`);
    $('#digestPreview').textContent = `SUBJECT: ${d.subject}\n\n${d.text}`;
    $('#digestPreview').hidden = false;
    flash($('#digestMsg'),
      `Built for ${d.site}: ${d.counts.followup} follow-up, ${d.counts.authorization} authorization, ${d.counts.pt} PT.`);
  } catch (e) {
    flash($('#digestMsg'), e.message, false);
  }
});

$('#testBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/digest/test', { method: 'POST', body: { site_id: Number(digestSite()) } });
    flash($('#digestMsg'),
      r.sent ? `Test sent to ${r.recipients} recipient(s).` : r.reason, !!r.sent);
  } catch (e) {
    flash($('#digestMsg'), e.message, false);
  }
});

$('#runBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/digest/run', { method: 'POST', body: {} });
    const sent = r.results.filter((x) => x.sent).length;
    const reasons = [...new Set(r.results.filter((x) => !x.sent).map((x) => x.reason))];
    flash($('#digestMsg'),
      `Checked ${r.checked} site(s); sent ${sent}.` + (reasons.length ? ` Not sent: ${reasons.join('; ')}` : ''),
      sent > 0);
  } catch (e) {
    flash($('#digestMsg'), e.message, false);
  }
});

// ── settings ────────────────────────────────────────────────────────────────

const THRESHOLD_LABELS = {
  followup_sweep: 'Follow-up · status sweep (T-10)',
  followup_outreach: 'Follow-up · first outreach (T-7)',
  followup_escalate: 'Follow-up · escalate (T-3)',
  followup_decision: 'Follow-up · decision required (T-1)',
  auth_followup: 'Auth · chase carrier (A-1)',
  auth_escalate: 'Auth · escalate (A-2)',
  auth_formal: 'Auth · formal escalation (A-3)',
  auth_unscheduled: 'Auth · approved not scheduled (A-5)',
  pt_review_reminder: 'PT · review reminder (P-2)',
  pt_review_escalate: 'PT · review escalate (P-3)',
  pt_response_due: 'PT · response due (P-4)',
};

async function loadSettings() {
  const s = await api('/api/admin/settings');
  state.settings = s;

  $('#setReminders').checked = s.reminders_enabled;
  $('#setWc').checked = s.wc_block_enabled;
  $('#setDemo').checked = s.demo_banner;

  const grid = $('#thresholds');
  grid.innerHTML = '';
  for (const [key, label] of Object.entries(THRESHOLD_LABELS)) {
    const field = el('div', 'field');
    const lab = el('label', null, label);
    lab.setAttribute('for', `th_${key}`);
    const input = el('input');
    input.type = 'number';
    input.id = `th_${key}`;
    input.dataset.threshold = key;
    input.min = '0';
    input.max = '365';
    input.value = s.thresholds[key];
    field.appendChild(lab);
    field.appendChild(input);
    grid.appendChild(field);
  }

  const smtp = $('#smtpCard');
  smtp.innerHTML = '';
  smtp.appendChild(el('h3', null, 'Email transport'));
  if (s.smtp_configured) {
    smtp.appendChild(el('p', 'callout good', `SMTP is configured — sending as ${s.smtp_from}.`));
  } else {
    smtp.appendChild(el('p', 'callout warn',
      'SMTP is not configured. Digests are still built and can be previewed, but nothing is sent. ' +
      'Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in the environment to enable delivery.'));
  }

  const sys = $('#sysInfo');
  sys.innerHTML = '';
  const add = (k, v) => {
    sys.appendChild(el('dt', null, k));
    sys.appendChild(el('dd', null, v));
  };
  add('Database', s.database);
  add('Email', s.smtp_configured ? 'Configured' : 'Not configured');
  if (s.default_password) add('Warning', 'The leadership password is still the default — change it.');
}

async function saveSetting(patch) {
  await api('/api/admin/settings', { method: 'POST', body: patch });
}

$('#setReminders').addEventListener('change', (e) => saveSetting({ reminders_enabled: e.target.checked }));
$('#setDemo').addEventListener('change', (e) => saveSetting({ demo_banner: e.target.checked }));

$('#setWc').addEventListener('change', async (e) => {
  if (e.target.checked) {
    const ok = confirm(
      'Turning this on lets staff store claim numbers, employer names and adjuster contacts.\n\n' +
      'These are identifying. Confirm Privacy & Compliance has signed off before continuing.');
    if (!ok) { e.target.checked = false; return; }
  }
  await saveSetting({ wc_block_enabled: e.target.checked });
});

$('#saveThresholds').addEventListener('click', async () => {
  const thresholds = {};
  for (const input of $$('[data-threshold]')) thresholds[input.dataset.threshold] = Number(input.value);
  try {
    await saveSetting({ thresholds });
    await loadSettings();
    await loadDashboard();
    flash($('#thresholdMsg'), 'Thresholds saved. The worklist and digests use them immediately.');
  } catch (e) {
    flash($('#thresholdMsg'), e.message, false);
  }
});

$('#resetThresholds').addEventListener('click', async () => {
  try {
    await saveSetting({ thresholds: state.settings.default_thresholds });
    await loadSettings();
    flash($('#thresholdMsg'), 'Thresholds reset to the proposal defaults.');
  } catch (e) {
    flash($('#thresholdMsg'), e.message, false);
  }
});

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = new FormData(e.target).get('password');
  try {
    await api('/api/admin/password', { method: 'POST', body: { password: pw } });
    e.target.reset();
    flash($('#pwMsg'), 'Password changed.');
  } catch (e2) {
    flash($('#pwMsg'), e2.message, false);
  }
});

// ── go ──────────────────────────────────────────────────────────────────────

boot().catch((e) => {
  document.body.innerHTML =
    `<div class="wrap"><p class="error">Could not start: ${e.message}</p></div>`;
});
