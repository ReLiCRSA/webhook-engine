'use strict';

/**
 * Express application: routing, raw-body capture, dashboard API, static web.
 *
 * Routes:
 *   /webhook/:name(/...)   dispatch to webhooks/<name> via the invoke pipeline
 *   /api/webhooks          list discovered webhooks + their auth mode
 *   /api/calls?webhook=&method=&status=&since=&limit=&offset=
 *   /api/calls/:id/replay  replay one recorded call (loopback re-dispatch)
 *   /                       static web/dist (dashboard)
 *
 * The raw request body is always captured first (as a string) so the invoke
 * pipeline can hand it to modules and sign it for HMAC auth before anything
 * else reads the stream.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const discover = require('./discover');
const { createGenericAuth } = require('./generic-auth');
const { buildContext } = require('./normalize');
const db = require('./db');
const { listCalls } = db;
const { invoke } = require('./invoke');
const { replayCall } = require('./replay');

const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');

async function captureRawBody(req) {
  if (req._rawBody !== undefined) return req._rawBody;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  req._rawBody = raw;
  return raw;
}

/** Generic-auth gate for /api/* and anything else marked protected. */
function makeAuthGuard(genericAuth, logger) {
  return async function guard(req, res, next) {
    if (!genericAuth) return next();
    const raw = await captureRawBody(req).catch(() => '');
    const ctx = buildContext(raw, req, 'api');
    const ok = await genericAuth.verifyRaw(ctx, raw);
    if (!ok) {
      logger.warn(`api ${req.method} ${req.path} → 401 (auth failed)`);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

function createApp({ logger, genericAuth, port }) {
  const app = express();
  const apiRouter = express.Router();

  // --- webhook dispatch (all methods: GET, POST, PATCH, DELETE, ...) -------
  // Mounted at /webhook (not /webhook/:name) so req.path is relative and the
  // name can be derived for every HTTP method. This middleware is TERMINAL:
  // it owns the response end-to-end and never calls next().
  app.use(
    '/webhook',
    async (req, res) => {
      const name = decodeURIComponent(req.path.split('/').filter(Boolean)[0] || '');
      if (!name) {
        res.status(400).json({ error: 'expected /webhook/<name>' });
        return;
      }
      try {
        // Capture the raw body stream once, before the module runs — modules
        // read it from ctx.body, and generic HMAC auth signs these exact bytes.
        const raw = await captureRawBody(req);
        const ctx = buildContext(raw, req, name);
        await invoke({ req, res, webhookName: name, rawBody: raw, ctx, db, logger, discover, genericAuth });
      } catch (e) {
        logger.error(`webhook dispatch error: ${e.stack || e.message}`);
        if (!res.headersSent) res.status(500).end('internal error');
      }
    }
  );

  // --- dashboard API ---------------------------------------------------------
  apiRouter.use(makeAuthGuard(genericAuth, logger));

  apiRouter.get('/webhooks', (req, res) => {
    const webhooks = discover.listWebhooks().map((w) => {
      // getWebhook re-reads config.json fresh (like the request path), so a
      // config edit is reflected here without a restart too.
      const entry = discover.getWebhook(w.name);
      const mod = entry ? entry.module : null;
      const config = (entry && entry.config) || {};
      let authMode;
      if (mod && typeof mod.auth === 'function') authMode = 'module';
      else if (config.useGlobalAuth === true) authMode = genericAuth ? 'generic' : 'none (global auth disabled)';
      else authMode = 'none';
      return { name: w.name, auth: authMode, config };
    });
    res.json({ webhooks });
  });

  apiRouter.get('/calls', async (req, res) => {
    const { webhook, method, status, since, limit, offset } = req.query;
    try {
      const result = await listCalls({ webhook, method, status, since, limit, offset });
      res.json({ total: result.total, limit: Number(limit) || 100, offset: Number(offset) || 0, rows: result.rows });
    } catch (e) {
      logger.error(`api /calls failed: ${e.message}`);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Replay one recorded call: re-dispatches it to this engine over loopback
  // (see src/replay.js). The replay authenticates with the CALLER's
  // credentials — the original ones were redacted at rest and are gone.
  apiRouter.post('/calls/:id/replay', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'expected numeric call id' });
      return;
    }
    if (!port) {
      logger.error('api /calls/:id/replay: engine port not configured (createApp port option)');
      res.status(500).json({ error: 'internal error' });
      return;
    }
    try {
      const result = await replayCall({
        callId: id,
        port,
        callerAuthorization: req.headers['authorization'] || null,
        genericAuth,
        db,
        logger,
      });
      if (result.notFound) {
        res.status(404).json({ error: `call not found: ${id}` });
        return;
      }
      // The replay RAN even if the webhook answered 401/500 — that outcome is
      // recorded as data (call row), not as an API error.
      res.json(result);
    } catch (e) {
      if (db.isDbUnreachable(e)) {
        logger.warn(`api /calls/${id}/replay: database unavailable (${e.message})`);
        res.status(503).json({ error: 'database unavailable' });
        return;
      }
      logger.error(`api /calls/${id}/replay failed: ${e.stack || e.message}`);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.use('/api', apiRouter);

  // --- static dashboard -------------------------------------------------------
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    // SPA-ish fallback for any GET that is not an API call, not a webhook, and
    // not a static asset hit by express.static above.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
        next();
        return;
      }
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.status(200).type('text/html').send(
        '<!doctype html><title>webhook-engine</title><h1>webhook-engine</h1>' +
          '<p>The dashboard is not built yet. Run <code>npm run web:build</code> and restart, or' +
          ' use <code>npm run web:dev</code> for development.</p>'
      );
    });
  }

  // --- 404 fallback -------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return { app, genericAuth, apiRouter };
}

module.exports = { createApp, captureRawBody, WEB_DIST };
