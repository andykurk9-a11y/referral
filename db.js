'use strict';

/**
 * Database layer (libSQL / SQLite-compatible).
 *
 * Two modes, chosen by environment:
 *   - Local file (default): `file:data/referral.db`. Used for local dev and any
 *     host with a persistent disk (Docker, a VM, Railway, Render, on-prem).
 *   - Turso (remote): set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN). Used on hosts
 *     with no persistent disk, e.g. Netlify Functions.
 *
 * The SQL is plain SQLite, so both modes share one schema. The client API is
 * async: use `await db.get/all/run(sql, params)` and `await db.tx(fn)`.
 *
 * ---------------------------------------------------------------------------
 * A NOTE ON WHAT IS *NOT* IN THIS SCHEMA
 * ---------------------------------------------------------------------------
 * There is deliberately no patient name, date of birth, phone number, or
 * address column anywhere. The only handle on a patient is `orders.reference`,
 * a free-text value the clinic chooses (an EMR order number, an internal ticket
 * id) which staff resolve back to a person inside the EMR.
 *
 * The work-comp escalation columns (claim_number, employer, adjuster_*,
 * case_manager) exist but are refused by the API unless the `wc_block_enabled`
 * setting is turned on by leadership. See lib/wcblock.js.
 *
 * This is NOT HIPAA Safe Harbor de-identification — the dates alone rule that
 * out, and the tracker cannot function without them. It is a "no direct
 * identifiers" posture. See README.md.
 */

const path = require('path');
const fs = require('fs');

/**
 * Read a configuration variable, tolerating the wrong capitalisation.
 *
 * Environment variable names are case-sensitive on Linux, but a hosting
 * dashboard is a free-text box — "Turso_Database_URL" saves happily and then
 * the app cannot see it, which is indistinguishable from never setting it at
 * all. Accept a case-insensitive match so a redeploy is not wasted, but say so
 * loudly: the name should still be corrected.
 */
function envLookup(name) {
  if (process.env[name]) return process.env[name];
  const match = Object.keys(process.env).find(
    (k) => k.toLowerCase() === name.toLowerCase() && process.env[k]
  );
  if (match) {
    console.warn(
      `[config] Found "${match}" and using it as ${name}. Environment variable names are ` +
      `case-sensitive — rename it to ${name} so this keeps working elsewhere.`
    );
    return process.env[match];
  }
  return null;
}

const TURSO_URL = envLookup('TURSO_DATABASE_URL');
const TURSO_TOKEN = envLookup('TURSO_AUTH_TOKEN');

let client;
if (TURSO_URL) {
  // HTTP-only client — pure JS, no native binary. Statically required so
  // serverless bundlers (Netlify esbuild) include it.
  const { createClient } = require('@libsql/client/web');
  client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
} else {
  // Serverless hosts have a read-only filesystem, so falling back to a local
  // SQLite file there fails with an opaque EROFS while the module is loading —
  // which surfaces to the browser as a bare 502 with nothing to go on. Say what
  // is actually wrong instead.
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT) {
    // List the names (never the values) of the configuration this function can
    // actually see. That distinguishes "the variable was never set" from "it is
    // set but scoped away from Functions, or spelled differently" — which the
    // bare message cannot, and which is otherwise a guessing game.
    const visible = Object.keys(process.env)
      .filter((k) => /TURSO|DATABASE|LIBSQL|^REF_|^SMTP_/i.test(k))
      .sort();

    throw new Error(
      'TURSO_DATABASE_URL is not set. A serverless deploy has no persistent disk, so it ' +
      'needs a hosted database.\n' +
      `Config variables visible to this function: ${visible.length ? visible.join(', ') : '(none)'}\n` +
      (visible.some((k) => k.toLowerCase() === 'turso_database_url')
        ? 'One of those matches TURSO_DATABASE_URL apart from capitalisation — but it is empty.\n'
        : '') +
      'If TURSO_DATABASE_URL is listed above, it is set but empty. If it is not listed, either ' +
      'it was never saved, or its Scopes exclude Functions, or its value is limited to a deploy ' +
      'context other than the one serving this request. Check Site configuration → Environment ' +
      'variables → TURSO_DATABASE_URL → Scopes (must include Functions) and Deploy contexts. ' +
      'Then redeploy. See DEPLOY.md.'
    );
  }

  const DATA_DIR = process.env.REF_DATA_DIR || path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const DB_PATH = process.env.REF_DB_PATH || path.join(DATA_DIR, 'referral.db');
  // Native client for local files. The dynamic module name keeps serverless
  // bundlers from pulling its native binary into the Netlify function bundle
  // (that path is never used when TURSO_DATABASE_URL is set).
  const localClientModule = '@libsql/client';
  const { createClient } = require(localClientModule);
  client = createClient({ url: 'file:' + DB_PATH });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1,
  pin_hash    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ordering providers, scoped to a site. Used to attribute an order and to
-- measure provider-side review SLA compliance.
CREATE TABLE IF NOT EXISTS providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Where the order was sent: a PT clinic or an imaging centre. This is the
-- dimension the vendor scorecard aggregates turnaround time over.
CREATE TABLE IF NOT EXISTS facilities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'both' CHECK (kind IN ('pt','imaging','both')),
  phone       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Work comp carrier / TPA, or the payer for non-work-comp. An organisation,
-- not a person — safe to hold regardless of the wc_block setting.
CREATE TABLE IF NOT EXISTS carriers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  phone       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id            INTEGER NOT NULL REFERENCES sites(id),
  reference          TEXT NOT NULL,
  case_type          TEXT NOT NULL DEFAULT 'wc' CHECK (case_type IN ('wc','non_wc')),

  order_type         TEXT NOT NULL CHECK (order_type IN ('pt','ot','mri','ct','other')),
  body_part          TEXT,
  laterality         TEXT CHECK (laterality IN ('left','right','bilateral','na') OR laterality IS NULL),
  provider_id        INTEGER REFERENCES providers(id) ON DELETE SET NULL,
  facility_id        INTEGER REFERENCES facilities(id) ON DELETE SET NULL,
  carrier_id         INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  ordered_on         TEXT NOT NULL,

  -- Authorization lifecycle
  auth_required      TEXT NOT NULL DEFAULT 'unknown' CHECK (auth_required IN ('yes','no','unknown')),
  auth_status        TEXT NOT NULL DEFAULT 'not_required'
                     CHECK (auth_status IN ('not_required','requested','pending','approved','denied','p2p','appealed')),
  auth_number        TEXT,
  auth_requested_on  TEXT,
  auth_decided_on    TEXT,
  auth_expires_on    TEXT,
  visits_authorized  INTEGER,

  -- Scheduling
  scheduled_on       TEXT,
  service_completed  INTEGER NOT NULL DEFAULT 0,
  expected_result_on TEXT,
  followup_on        TEXT,

  -- Result + provider review
  result_received_on TEXT,
  review_status      TEXT NOT NULL DEFAULT 'awaiting'
                     CHECK (review_status IN ('awaiting','reviewed','response_sent')),
  response_sent_on   TEXT,

  -- Workflow
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete','cancelled')),
  outcome            TEXT,
  owner_name         TEXT,

  -- Work-comp escalation block. Refused by the API unless wc_block_enabled = 1.
  claim_number       TEXT,
  employer           TEXT,
  adjuster_name      TEXT,
  adjuster_contact   TEXT,
  case_manager       TEXT,

  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The two worklist sorts.
CREATE INDEX IF NOT EXISTS idx_orders_followup ON orders(site_id, status, followup_on);
CREATE INDEX IF NOT EXISTS idx_orders_auth     ON orders(auth_status, auth_requested_on);
CREATE INDEX IF NOT EXISTS idx_orders_review   ON orders(status, review_status, result_received_on);

-- Append-only history. Every state change and every outreach attempt lands
-- here. In work comp this log is discoverable, so it is never edited or
-- deleted, only added to.
CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN
                ('created','outreach','auth_update','result_received','reviewed',
                 'response_sent','status_change','note','reminder_sent','edited')),
  note        TEXT,
  actor       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id, created_at);

CREATE TABLE IF NOT EXISTS alert_recipients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, email)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// Normalize params: libSQL rejects `undefined`; map to null.
function norm(params) {
  return (params || []).map((p) => (p === undefined ? null : p));
}

async function columnExists(table, column) {
  const r = await client.execute(`PRAGMA table_info(${table})`);
  return r.rows.some((c) => c.name === column);
}
async function addColumn(table, column, definition) {
  if (!(await columnExists(table, column))) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

let initPromise = null;
async function init() {
  // Pragmas: harmless/no-op on remote Turso; apply on local file.
  try { await client.execute('PRAGMA foreign_keys = ON'); } catch (e) { /* ignore */ }
  await client.executeMultiple(SCHEMA);
  // Migrations go here as the schema evolves, e.g.:
  // await addColumn('orders', 'new_column', 'TEXT');
}
function ensureReady() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

function toRunResult(r) {
  return {
    lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined,
    changes: r.rowsAffected,
  };
}

async function all(sql, params) {
  await ensureReady();
  const r = await client.execute({ sql, args: norm(params) });
  return r.rows;
}
async function get(sql, params) {
  const rows = await all(sql, params);
  return rows[0];
}
async function run(sql, params) {
  await ensureReady();
  const r = await client.execute({ sql, args: norm(params) });
  return toRunResult(r);
}

// Interactive write transaction. `fn` receives {get, all, run} scoped to the tx.
async function tx(fn) {
  await ensureReady();
  const t = await client.transaction('write');
  const scoped = {
    all: async (sql, params) => (await t.execute({ sql, args: norm(params) })).rows,
    get: async (sql, params) => (await t.execute({ sql, args: norm(params) })).rows[0],
    run: async (sql, params) => toRunResult(await t.execute({ sql, args: norm(params) })),
  };
  try {
    const result = await fn(scoped);
    await t.commit();
    return result;
  } catch (e) {
    try { await t.rollback(); } catch (_) { /* ignore */ }
    throw e;
  }
}

// Run a multi-statement SQL script (used by the seed's bulk wipe).
async function exec(sqlScript) {
  await ensureReady();
  await client.executeMultiple(sqlScript);
}

// Run many statements in a single round trip (atomic). Each item: {sql, args}.
async function batch(statements) {
  await ensureReady();
  const res = await client.batch(
    statements.map((s) => ({ sql: s.sql, args: norm(s.args) })),
    'write'
  );
  return res.map(toRunResult);
}

module.exports = { get, all, run, tx, exec, batch, ensureReady, addColumn, isRemote: !!TURSO_URL };
