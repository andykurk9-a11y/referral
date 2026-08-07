'use strict';

/**
 * Email transport. SMTP credentials come from environment variables so secrets
 * never live in the database. Recipients and the on/off toggle are configured
 * in the leadership Settings UI (stored in the settings table).
 *
 * Required env for real sending:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * Optional:
 *   SMTP_SECURE=true (use TLS on connect, typically port 465)
 *   SMTP_FROM="DME Stock <alerts@yourclinic.org>"
 */

const nodemailer = require('nodemailer');

let cachedTransport = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT);
}

function transport() {
  if (!isConfigured()) return null;
  if (cachedTransport) return cachedTransport;
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure, // true = implicit TLS (port 465); false = STARTTLS (port 587)
    requireTLS: !secure, // never send credentials over an unencrypted connection
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return cachedTransport;
}

function fromAddress() {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'dme-stock@localhost';
}

async function send({ to, subject, text, html }) {
  const t = transport();
  if (!t) throw new Error('Email is not configured. Set SMTP_HOST and SMTP_PORT (and credentials) in the environment.');
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  if (!recipients) throw new Error('No recipients configured.');
  return t.sendMail({ from: fromAddress(), to: recipients, subject, text, html });
}

module.exports = { isConfigured, send, fromAddress };
