'use strict';

/**
 * First-run provisioning from JSON config files, so a fresh deploy comes up
 * with real sites, facilities, carriers and providers without anyone typing
 * them into a form.
 *
 * Idempotent by design: existing rows are never overwritten, so edits made in
 * the app survive every redeploy. Adding a name to a JSON file creates it on
 * the next boot; removing one leaves the existing row alone (deactivate it in
 * the app instead).
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('./auth');

function readConfig(filename) {
  const file = path.join(__dirname, '..', filename);
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Config files carry a leading "_comment" key; accept either a bare array
    // or an object with a named array inside it.
    if (Array.isArray(parsed)) return parsed;
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    return [];
  } catch (e) {
    console.error(`Could not read ${filename}:`, e.message);
    return [];
  }
}

async function provisionSites() {
  const rows = readConfig('sites.json');
  for (const s of rows) {
    if (!s || !s.name) continue;
    const existing = await db.get('SELECT id FROM sites WHERE name = ?', [s.name]);
    if (existing) continue;
    const info = await db.run('INSERT INTO sites(name) VALUES(?)', [s.name]);
    if (s.pin) await auth.setSitePin(info.lastInsertRowid, String(s.pin));
  }
}

async function provisionFacilities() {
  for (const f of readConfig('facilities.json')) {
    if (!f || !f.name) continue;
    const existing = await db.get('SELECT id FROM facilities WHERE name = ?', [f.name]);
    if (existing) continue;
    await db.run('INSERT INTO facilities(name, kind, phone) VALUES(?, ?, ?)', [
      f.name,
      ['pt', 'imaging', 'both'].includes(f.kind) ? f.kind : 'both',
      f.phone || null,
    ]);
  }
}

async function provisionCarriers() {
  for (const c of readConfig('carriers.json')) {
    if (!c || !c.name) continue;
    const existing = await db.get('SELECT id FROM carriers WHERE name = ?', [c.name]);
    if (existing) continue;
    await db.run('INSERT INTO carriers(name, phone) VALUES(?, ?)', [c.name, c.phone || null]);
  }
}

async function provisionProviders() {
  for (const p of readConfig('providers.json')) {
    if (!p || !p.name) continue;
    const existing = await db.get('SELECT id FROM providers WHERE name = ?', [p.name]);
    if (existing) continue;
    let siteId = null;
    if (p.site) {
      const s = await db.get('SELECT id FROM sites WHERE name = ?', [p.site]);
      siteId = s ? s.id : null;
    }
    await db.run('INSERT INTO providers(site_id, name) VALUES(?, ?)', [siteId, p.name]);
  }
}

/** Defaults that make the app safe and usable on first boot. */
async function provisionDefaults() {
  if ((await auth.getSetting('wc_block_enabled')) == null) {
    await auth.setSetting('wc_block_enabled', '0'); // off until Compliance signs off
  }
  if ((await auth.getSetting('demo_banner')) == null) {
    await auth.setSetting('demo_banner', '1'); // on until someone turns it off
  }
  if ((await auth.getSetting('reminders_enabled')) == null) {
    await auth.setSetting('reminders_enabled', '0'); // opt in once recipients exist
  }
}

async function provisionAll() {
  await provisionDefaults();
  await provisionSites();      // sites first — providers reference them
  await provisionFacilities();
  await provisionCarriers();
  await provisionProviders();
}

module.exports = {
  provisionAll,
  provisionSites,
  provisionFacilities,
  provisionCarriers,
  provisionProviders,
  provisionDefaults,
};
