'use strict';

/**
 * Express application: routing, raw-body capture, dashboard API, static web.
 *
 * Routes:
 *   /webhook/:name(/...)   dispatch to webhooks/<name> via the invoke pipeline
 *   /api/webhooks          list discovered webhooks + their auth mode
 *   /api/calls?webhook=&method=&status=&since=&limit=&offset=
 *   /api/calls/:id/replay  replay one recorded call (loopback re-dispatch)
 *   /api/whoami            how this caller authenticated (master|db-token|hmac)
 *   /api/tokens            db bearer tokens — GET list, POST create, DELETE :id
 *                          (master-token principals only; other callers 403)
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
const apiTokens = require('./api-tokens');
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

/**
 * config.json may carry module secrets (webhook secrets, API tokens). The
 * dashboard API must never echo them: string values under keys that look
 * secret-bearing (secret/token/password/key/credential/signature…) are
 * replaced with '***'. Keys ending in Comment/Help are documentation-only
 * and pass through. Structure and non-secret settings stay visible.
 */
const SECRET_KEY_RE = /(secret|token|password|passwd|credential|apikey|api_key|authorization|signature|access_key|private_key)/i;
const DOC_KEY_RE = /(comment|help|note|description|instructions)$/i;

function redactConfig(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactConfig(v, k);
    return out;
  }
  if (DOC_KEY_RE.test(key)) return value;
  if (SECRET_KEY_RE.test(key) && value != null && value !== '') return '***';
  return value;
}

/**
 * Generic-auth gate for /api/* and anything else marked protected. Beyond the
 * boolean gate it tags req.authPrincipal ({ source: master|db-token|hmac, … })
 * so the token-management routes can enforce the master-only rule: the env
 * bearer token (AUTH_BEARER_TOKEN) is the only credential allowed to
 * create/list/revoke db tokens; db tokens access everything else.
 */
function makeAuthGuard(genericAuth, logger) {
  return async function guard(req, res, next) {
    if (!genericAuth) return next();
    const raw = await captureRawBody(req).catch(() => '');
    const ctx = buildContext(raw, req, 'api');
    const { ok, principal } = await genericAuth.verifyIdentity(ctx, raw);
    if (!ok) {
      logger.warn(`api ${req.method} ${req.path} → 401 (auth failed)`);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.authPrincipal = principal || { source: 'unknown' };
    next();
  };
}

/** Master-only gate for the /api/tokens routes (403 for everyone else). */
function makeMasterOnlyGuard(logger) {
  return function masterOnly(req, res) {
    if (!req.authPrincipal || req.authPrincipal.source !== 'master') {
      logger.warn(
        `api ${req.method} ${req.path} → 403 (token management requires the env master bearer token; caller: ` +
          `${req.authPrincipal ? req.authPrincipal.source : 'none'}`
      );
      res.status(403).json({ error: 'master token required' });
      return false;
    }
    return true;
  };
}

function mapTokenError(res, e, route, log) {
  if (e instanceof apiTokens.TokenInputError) {
    res.status(400).json({ error: e.message });
    return;
  }
  if (db.isDbUnreachable(e)) {
    log.warn(`${route}: database unavailable (${e.message})`);
    res.status(503).json({ error: 'database unavailable' });
    return;
  }
  log.error(`${route} failed: ${e.stack || e.message}`);
  res.status(500).json({ error: 'internal error' });
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
      return { name: w.name, auth: authMode, config: redactConfig(config) };
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

  // Who am I? The dashboard uses this to decide whether the current caller
  // is the env MASTER (may manage db tokens) or a db token (may not).
  apiRouter.get('/whoami', (req, res) => {
    res.json({ principal: req.authPrincipal || { source: 'none' } });
  });

  // --- db-managed bearer tokens (master-only management) ---------------------
  // GET  /tokens             → metadata for every token (never hash or plaintext)
  // POST /tokens             → { name, expiresAt? } ; response carries the ONLY
  //                            copy of the plaintext (sha256 at rest, rule 7)
  // POST /tokens/:id/revoke  → soft revoke (sets revokedAt; row kept as audit
  //                            trail) — same shape as /calls/:id/replay
  const masterOnly = makeMasterOnlyGuard(logger);

  apiRouter.get('/tokens', (req, res) => {
    if (!masterOnly(req, res)) return;
    apiTokens
      .listTokens()
      .then((tokens) => res.json({ total: tokens.length, tokens }))
      .catch((e) => mapTokenError(res, e, 'api /tokens', logger));
  });

  apiRouter.post('/tokens', (req, res) => {
    if (!masterOnly(req, res)) return;
    let input;
    try {
      input = apiTokens.parseTokenRequest(req._rawBody || '');
    } catch (e) {
      res.status(400).json({ error: e.message });
      return;
    }
    apiTokens
      .createToken(input)
      .then(({ plaintext, token }) => {
        logger.info(`api POST /tokens → created db token "${token.name}" (#${token.id}) by master`);
        res.status(201).json({ token, plaintext });
      })
      .catch((e) => mapTokenError(res, e, 'api POST /tokens', logger));
  });

  apiRouter.post('/tokens/:id/revoke', (req, res) => {
    if (!masterOnly(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'expected numeric token id' });
      return;
    }
    apiTokens
      .revokeToken(id)
      .then((token) => {
        if (!token) {
          res.status(404).json({ error: `token not found: ${id}` });
          return;
        }
        logger.info(`api POST /tokens/${id}/revoke → revoked db token "${token.name}" by master`);
        res.json({ token });
      })
      .catch((e) => mapTokenError(res, e, `api POST /tokens/${id}/revoke`, logger));
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
