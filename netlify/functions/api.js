'use strict';

/**
 * Netlify Function that runs the Express app. `netlify.toml` redirects
 * `/api/*` here. We normalize the path so Express always sees the original
 * `/api/...` route regardless of how Netlify presents it, then hand off to
 * serverless-http.
 */

const serverless = require('serverless-http');
const app = require('../../server');

const handler = serverless(app);

exports.handler = async (event, context) => {
  // Keep the Lambda warm-ish and don't wait on the event loop for the response.
  context.callbackWaitsForEmptyEventLoop = false;

  // Ensure the DB/schema/default-password bootstrap has completed.
  if (app.bootstrap) await app.bootstrap;

  // Normalize the path back to /api/* for Express routing.
  if (event.path && !event.path.startsWith('/api')) {
    const stripped = event.path.replace(/^\/\.netlify\/functions\/api/, '');
    event.path = '/api' + (stripped.startsWith('/') ? stripped : '/' + stripped);
  }
  return handler(event, context);
};
