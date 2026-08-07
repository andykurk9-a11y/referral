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

const db = require('../db');
const auth = require('./auth');

// IMPORTANT: these must be STATIC require paths so serverless bundlers (Netlify
// esbuild) inline the JSON into the function. Reading them at runtime with
// fs.readFileSync(path.join(__dirname, ...)) silently finds nothing once
// bundled — the app then comes up with no sites and an empty sign-in dropdown.
let sitesConfig = null;
let facilitiesConfig = null;
let carriersConfig = null;
let providersConfig = null;
try { sitesConfig = require('../sites.json'); } catch (e) { sitesConfig = null; }
try { facilitiesConfig = require('../facilities.json'); } catch (e) { facilitiesConfig = null; }
try { carriersConfig = require('../carriers.json'); } catch (e) { carriersConfig = null; }
try { providersConfig = require('../providers.json'); } catch (e) { providersConfig = null; }

/** Config files carry a leading "_comment" key; accept a bare array or an object wrapping one. */
function rows(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  for (const key of Object.keys(parsed)) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

async function provisionSites() {
  for (const s of rows(sitesConfig)) {
    if (!s || !s.name) continue;
    const existing = await db.get('SELECT id FROM sites WHERE name = ?', [s.name]);
    if (existing) continue;
    const info = await db.run('INSERT INTO sites(name) VALUES(?)', [s.name]);
    if (s.pin) await auth.setSitePin(info.lastInsertRowid, String(s.pin));
  }
}

async function provisionFacilities() {
  for (const f of rows(facilitiesConfig)) {
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
  for (const c of rows(carriersConfig)) {
    if (!c || !c.name) continue;
    const existing = await db.get('SELECT id FROM carriers WHERE name = ?', [c.name]);
    if (existing) continue;
    await db.run('INSERT INTO carriers(name, phone) VALUES(?, ?)', [c.name, c.phone || null]);
  }
}

async function provisionProviders() {
  for (const p of rows(providersConfig)) {
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
