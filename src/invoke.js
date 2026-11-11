'use strict';

/**
 * Invocation pipeline for a webhook route (/webhook/:name/*).
 *
 *   auth (module auth → generic auth if config.json "useGlobalAuth" → open) → handler → record
 *
 * - The response object is wrapped so the engine observes the status code and
 *   total duration without taking control of the reply away from the module.
 * - A safety-net timer writes a 500 if the handler neither responds nor throws
 *   within HANDLER_TIMEOUT_MS; the call is still recorded.
 * - Auth failures short-circuit with 401 (auth=denied); unknown webhook names
 *   404 (recorded with the requested name).
 */

const HANDLER_TIMEOUT_MS = 30_000;

/**
 * Wrap res so onEnd(statusCode) fires exactly once, on whatever path (end,
 * send, json, or the safety timer) actually ends the response.
 */
function wrapResponse(res) {
  const state = { ended: false, statusCode: 500, onEnd: null };

  const settle = () => {
    if (state.ended) return;
    state.ended = true;
    if (state.onEnd) state.onEnd(state.statusCode);
  };

  const originalEnd = res.end.bind(res);
  const originalSend = res.send.bind(res);
  const originalJson = res.json.bind(res);

  const originalWriteHead = res.writeHead.bind(res);
  const originalStatus = res.status.bind(res);

  res.end = (...args) => {
    settle();
    return originalEnd(...args);
  };
  res.send = (body) => {
    settle();
    return originalSend(body);
  };
  res.json = (data) => {
    settle();
    return originalJson(data);
  };
  res.writeHead = (status, ...rest) => {
    if (typeof status === 'number') state.statusCode = status;
    return originalWriteHead(status, ...rest);
  };
  res.status = (code) => {
    state.statusCode = code;
    return originalStatus(code);
  };

  return state;
}

/**
 * @param {object} opts
 * @param {import('express').Request} opts.req
 * @param {import('express').Response} opts.res
 * @param {string} opts.webhookName requested name (request path segment)
 * @param {string} opts.rawBody exact request body bytes (string, captured upstream)
 * @param {object} opts.ctx normalized context (see normalize.buildContext)
 * @param {import('./db')} opts.db
 * @param {import('./logger')} opts.logger
 * @param {import('./discover')} opts.discover
 * @param {import('./generic-auth').GenericAuth|null} opts.genericAuth
 */
async function invoke({ req, res, webhookName, rawBody, ctx, db, logger, discover, genericAuth }) {
  const started = Date.now();
  const child = logger.child(`webhook:${webhookName}`);

  let done = false;
  let authResult = 'none';
  let genericTokenName = null; // set when generic auth passed via a db token (log line only; the auth column stays 'generic' — rule 15)

  const finish = (finalStatus) => {
    if (done) return Promise.resolve();
    done = true;
    const durationMs = Date.now() - started;
    child.info(
      `${ctx.method} ${ctx.path} → ${finalStatus} (${durationMs}ms) auth=${authResult}` +
        `${genericTokenName ? ` token="${genericTokenName}"` : ''} bytes_in=${rawBody.length}`
    );
    return db
      .recordWebhookCall(ctx, finalStatus, authResult, durationMs)
      .catch(() => {
        /* errors are logged inside db.recordWebhookCall */
      });
  };

  // Wrap BEFORE any branch can write, so every answer (module 200, 401, 404,
  // safety 500) is observed exactly once.
  const state = wrapResponse(res);
  state.onEnd = (statusCode) => {
    finish(statusCode || 500);
  };

  // --- auth ---------------------------------------------------------------
  let entry = null;
  let mod = null;
  try {
    entry = discover.getWebhook(webhookName);
    mod = entry ? entry.module : null;
  } catch (e) {
    child.error(`failed to load module: ${e.stack || e.message}`);
    res.status(500).end('Internal error loading webhook module');
    await finish(res.statusCode || 500);
    return;
  }

  if (!mod) {
    // Unknown webhook: still recorded, with the requested name.
    authResult = 'denied';
    res.status(404).json({ error: `unknown webhook: ${webhookName}` });
    await finish(404);
    return;
  }

  // Live module config: config.json re-read this very request by
  // discover.getWebhook ({} when absent). Visible to auth(ctx) and handler.
  ctx.config = entry.config || {};

  if (typeof mod.auth === 'function') {
    // Module-provided auth REPLACES global auth for this webhook.
    let ok = false;
    try {
      ok = await mod.auth(ctx);
    } catch (e) {
      child.error(`module auth threw: ${e.stack || e.message}`);
      ok = false;
    }
    if (!ok) {
      authResult = 'denied';
      res.status(401).json({ error: 'unauthorized' });
      await finish(401);
      return;
    }
    authResult = 'module';
  } else if (genericAuth && entry && entry.config && entry.config.useGlobalAuth === true) {
    // No module auth, but config.json opted in to the engine's generic auth.
    // verifyIdentity distinguishes the env master from a db-managed token so
    // the log line can name the token; the recorded auth value stays 'generic'.
    const { ok, principal } = await genericAuth.verifyIdentity(ctx, rawBody);
    if (!ok) {
      authResult = 'denied';
      res.status(401).json({ error: 'unauthorized' });
      await finish(401);
      return;
    }
    authResult = 'generic';
    if (principal && principal.source === 'db-token') genericTokenName = principal.name;
  } else {
    child.warn('open endpoint (no auth) — add auth(ctx) or set "useGlobalAuth": true in config.json');
    authResult = 'none';
  }

  // --- handler ---------------------------------------------------------------
  if (typeof mod.handler !== 'function') {
    res.status(500).json({ error: `webhook ${webhookName} has no handler` });
    await finish(500);
    return;
  }

  // Safety net: end the response with 500 if the handler never answers.
  let safetyArmed = true;
  const safetyTimer = setTimeout(() => {
    safetyArmed = false;
    if (!done && res.writableEnded === false) {
      child.error(`handler did not end the response within ${HANDLER_TIMEOUT_MS}ms — writing 500`);
      res.status(500).json({ error: 'handler timeout' }); // wrapped write calls finish()
    }
  }, HANDLER_TIMEOUT_MS);
  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    if (safetyArmed) {
      safetyArmed = false;
      clearTimeout(safetyTimer);
    }
    return originalEnd(...args);
  };

  try {
    await mod.handler(ctx, req, res);
  } catch (e) {
    child.error(`handler threw: ${e.stack || e.message}`);
    if (res.writableEnded === false) {
      res.status(500).json({ error: 'internal error' });
    }
  }

  // Short grace period for handlers that end the async; then finalize so the
  // connection never hangs open.
  setTimeout(() => {
    if (!done && res.writableEnded === false) {
      child.warn('handler left response open — finalizing with 500');
      res.status(500).json({ error: 'internal error' });
    }
  }, 50).unref();

  // Belt-and-braces: if the response already ended through a path the wrapper
  // did not observe (raw writeHead + end), make sure it was recorded.
  if (!done && res.writableEnded) {
    finish(res.statusCode || 500);
  }
}

module.exports = { invoke, HANDLER_TIMEOUT_MS, wrapResponse };
