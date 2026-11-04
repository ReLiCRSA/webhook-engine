'use strict';

/**
 * Process entry point: env loading, database check (non-fatal), server startup.
 */

require('dotenv').config();

const logger = require('./logger');
const db = require('./db');
const discover = require('./discover');
const { createGenericAuth } = require('./generic-auth');
const { createApp } = require('./app');

async function main() {
  const log = logger.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    sinks: (process.env.LOG_SINKS || 'stdout').split(',').map((s) => s.trim()).filter(Boolean),
    file: process.env.LOG_FILE || './logs/webhook-engine.log',
    logstashUrl: process.env.LOGSTASH_URL || null,
  });

  const startup = log.child('startup');

  // Database check — degrade gracefully rather than refusing to start.
  let dbUp = false;
  try {
    await db.ping();
    dbUp = true;
    startup.info('database connection OK');
  } catch (e) {
    dbUp = false;
    startup.warn(`database unavailable (${e.message}) — call logging disabled, will retry per request`);
  }

  const genericAuth = createGenericAuth();
  if (genericAuth) {
    const parts = [];
    if (genericAuth.bearerActive) parts.push('bearer token');
    if (genericAuth.hmacActive) parts.push(`hmac (${genericAuth.hmacSecrets.length} secret(s))`);
    startup.info(`generic auth enabled: ${parts.join(' + ')}`);
  } else {
    startup.warn('generic auth disabled (AUTH_MODE empty) — webhooks without their own auth and /api/* are OPEN');
  }

  // Discover webhooks once at startup and report auth posture.
  const webhooks = discover.listWebhooks();
  if (webhooks.length === 0) {
    startup.warn('no webhooks found under webhooks/');
  }
  for (const w of webhooks) {
    let mod = null;
    try {
      mod = discover.loadModule(w.name);
    } catch (e) {
      startup.error(`${w.name}: failed to load index.js: ${e.message}`);
      continue;
    }
    const hasModuleAuth = mod && typeof mod.auth === 'function';
    const usesGeneric = !hasModuleAuth && (w.config && w.config.useGlobalAuth === true);
    let note;
    if (hasModuleAuth) note = 'auth: module (own auth(ctx) exported)';
    else if (usesGeneric) note = genericAuth ? 'auth: generic (config.json useGlobalAuth)' : 'OPEN: useGlobalAuth set but generic auth disabled';
    else note = 'OPEN: no auth — add auth(ctx) or set "useGlobalAuth": true in config.json';
    startup.info(`webhook ${w.name} → ${note}`);
  }

  const { app } = createApp({ logger: log, genericAuth });
  const port = Number(process.env.PORT || 3000);

  const server = app.listen(port, () => {
    startup.info(`listening on http://127.0.0.1:${port} (db=${dbUp ? 'up' : 'down'})`);
  });

  const shutdown = (signal) => {
    startup.info(`${signal} received — shutting down`);
    server.close(() => {
      log.close();
      db.getPrisma().$disconnect().finally(() => process.exit(0));
    });
    // hard exit if close drags
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('fatal startup error:', e);
  process.exit(1);
});
