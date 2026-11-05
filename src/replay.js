'use strict';

/**
 * Replay feature: re-execute a recorded webhook call.
 *
 * replayCall({ callId, port, callerAuthorization, logger }) loads a stored
 * webhook_calls row and re-sends it to THIS engine over loopback HTTP
 * (http://127.0.0.1:<port><stored path>). The replay therefore rides the
 * identical dispatch path a live client takes — raw body capture,
 * buildContext, the auth chain, wrapResponse, the safety timer, and the
 * call-log insert — with no special-cased in-process code path.
 *
 * Provenance: the request carries "X-Replay: <callId>"; recordWebhookCall
 * persists it as replayedFromId on the new row. Replaying a replay is
 * allowed — replayedFromId always points at the immediate parent row.
 *
 * Credentials: stored Authorization values are redacted at rest, so the
 * original ones are unrecoverable. The replay instead forwards the
 * Authorization header of the API caller who triggered it, and re-signs the
 * body with the engine's CURRENT HMAC secret when generic HMAC auth is
 * active. Module-level auth schemes the engine cannot reproduce (API keys,
 * IP allowlists, ...) see the replay like any other request — often 401,
 * recorded honestly as auth=denied.
 */

const http = require('node:http');

const { checksum } = require('./generic-auth');
const { HANDLER_TIMEOUT_MS } = require('./invoke');

// The invoke safety timer ends a stuck handler at HANDLER_TIMEOUT_MS; give
// the loopback client a small margin so the engine always answers first.
const REPLAY_TIMEOUT_MS = HANDLER_TIMEOUT_MS + 5_000;

// The webhook's answer is captured (transient — NOT stored in the call log)
// so the dashboard can show it in a modal. Bounded so a huge handler reply
// can't balloon the /api/calls/:id/replay JSON.
const MAX_CAPTURED_RESPONSE_BYTES = 64 * 1024;

// Headers never copied verbatim from the stored snapshot: hop-by-hop or
// replaced with fresh replay-appropriate values below.
const SKIP_HEADERS = new Set([
  'authorization', // redacted at rest — replaced with caller credentials
  'x-signature', // re-signed with the current secret (or dropped)
  'x-replay', // reserved for provenance
  'user-agent', // replaced with the replay marker
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length', // recomputed from the exact stored bytes
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rebuild the request target: stored path + query string from the stored query JSON. */
function buildTargetPath(call) {
  const base = call.path || `/webhook/${call.webhook}`;
  const q = call.query;
  if (!q || typeof q !== 'object' || !Object.keys(q).length) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else if (v !== null && v !== undefined) params.append(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Headers for the loopback request: stored snapshot minus skip-list, plus
 * caller credentials, a fresh HMAC signature when generic HMAC auth is
 * active, and the replay provenance tag.
 */
function buildReplayHeaders(call, { callerAuthorization, genericAuth, rawBody, callId }) {
  const headers = {};
  const stored = call.headers && typeof call.headers === 'object' ? call.headers : {};
  for (const [name, value] of Object.entries(stored)) {
    const lower = String(name).toLowerCase();
    if (SKIP_HEADERS.has(lower) || value === undefined || value === null) continue;
    headers[lower] = Array.isArray(value) ? value.map((v) => String(v)) : String(value);
  }
  if (callerAuthorization) headers['authorization'] = String(callerAuthorization);
  if (genericAuth && genericAuth.hmacActive && genericAuth.hmacSecrets.length) {
    headers['x-signature'] = checksum(rawBody, genericAuth.hmacSecrets[0]);
  }
  headers['x-replay'] = String(callId);
  headers['user-agent'] = `webhook-engine-replay/${callId}`;
  if (rawBody) headers['content-length'] = String(Buffer.byteLength(rawBody, 'utf8'));
  return headers;
}

/** One loopback HTTP round-trip; resolves with the webhook's answer.
 *  The response body/headers are captured (up to MAX_CAPTURED_RESPONSE_BYTES,
 *  flagged with `bodyTruncated` when cut) purely for the API caller's viewer —
 *  the call log still only records the REQUEST side. */
function sendReplay({ port, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, timeout: REPLAY_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        let bytes = 0;
        let captured = 0;
        let truncated = false;
        res.on('data', (c) => {
          bytes += c.length;
          if (captured < MAX_CAPTURED_RESPONSE_BYTES) {
            const slice = c.subarray(0, MAX_CAPTURED_RESPONSE_BYTES - captured);
            chunks.push(slice);
            captured += slice.length;
            if (bytes > MAX_CAPTURED_RESPONSE_BYTES) truncated = true;
          } else {
            truncated = true;
          }
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            responseBytes: bytes,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error(`replay timed out after ${REPLAY_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Replay one recorded call.
 * @param {object} opts
 * @param {number} opts.callId id of the stored WebhookCall row to replay
 * @param {number} opts.port port this engine is listening on (loopback target)
 * @param {string|null} opts.callerAuthorization Authorization header of the
 *   /api request that triggered this replay (forwarded to the target webhook)
 * @param {object|null} opts.genericAuth generic auth instance (HMAC re-signing)
 * @param {typeof import('./db')} opts.db db module (Prisma access stays here)
 * @param {object} opts.logger logger (uses .child())
 * @returns {Promise<object>} { notFound } or
 *   { original, status, responseBytes, response, call } — `response` is the
 *   webhook's captured answer ({ status, headers, body, truncated }, transient,
 *   never persisted); `call` is the freshly recorded replay row, or null when
 *   recording failed (e.g. DB hiccup).
 *   Throws Prisma errors (P1001...) when the database is unavailable.
 */
async function replayCall({ callId, port, callerAuthorization, genericAuth, db, logger }) {
  const child = logger.child(`replay:${callId}`);

  const original = await db.getCallById(callId); // throws when DB unreachable
  if (!original) return { notFound: true };

  const rawBody =
    original.body && original.body.raw != null ? String(original.body.raw) : '';
  const method = String(original.method || 'GET').toUpperCase();
  const path = buildTargetPath(original);
  const headers = buildReplayHeaders(original, { callerAuthorization, genericAuth, rawBody, callId });

  // Correlate the new row by id instead of timestamps (recording settles
  // asynchronously just after the response flush).
  const afterId = await db.maxCallId();

  const sent = await sendReplay({ port, method, path, headers, body: rawBody });
  child.info(
    `replayed #${callId} → ${method} ${path} answered ${sent.status} (body_in=${Buffer.byteLength(rawBody, 'utf8')})`
  );

  let call = null;
  for (let attempt = 0; attempt < 6 && !call; attempt++) {
    call = await db.findLatestReplayOf(callId, afterId).catch(() => null);
    if (!call) await sleep(300);
  }
  if (!call) child.warn(`replay of #${callId} answered ${sent.status}, but no new call row appeared`);

  return {
    original,
    status: sent.status,
    responseBytes: sent.responseBytes,
    response: { status: sent.status, headers: sent.headers, body: sent.body, truncated: sent.truncated },
    call,
  };
}

module.exports = { replayCall, REPLAY_TIMEOUT_MS, MAX_CAPTURED_RESPONSE_BYTES, buildTargetPath, buildReplayHeaders };
