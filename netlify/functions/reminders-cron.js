'use strict';

/**
 * Scheduled Netlify Function — runs the daily reminder digest check.
 *
 * A serverless host cannot keep the always-on hourly scheduler alive, so the
 * schedule lives in netlify.toml ([functions."reminders-cron"].schedule),
 * default once a day at 12:00 UTC.
 *
 * runScheduledCheck() sends at most one digest per site per calendar day, and
 * only when reminders are enabled, the site has recipients, and something
 * actually needs attention — so running it more than once a day is harmless.
 */

const db = require('../../db');
const reminders = require('../../lib/reminders');

exports.handler = async () => {
  try {
    await db.ensureReady();
    const result = await reminders.runScheduledCheck();
    console.log('Scheduled reminder check:', JSON.stringify(result));
  } catch (e) {
    console.error('Scheduled reminder check failed:', e && e.message ? e.message : e);
  }
  return { statusCode: 200 };
};
