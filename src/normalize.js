'use strict';

/**
 * Request normalization.
 *
 * buildContext(rawBody, req) returns the uniform context handed to every
 * module handler:
 *
 *   {
 *     webhook,          // directory name of the webhook (or requested name)
 *     headers,          // header name -> value, names lower-cased
 *     method,           // normalized upper-case HTTP method
 *     path,             // full request URL path (no query string)
 *     query,            // parsed query parameters, {} when empty
 *     config,           // webhooks/<name>/config.json (live, re-read per
 *                       // request); added by invoke.js, not present here
 *     body: {
 *       url:  {...} | {},        // parsed application/x-www-form-urlencoded
 *       post: {...} | {},        // parsed multipart/form-data (multipart-parser)
 *       json: {...} | null,      // parsed application/json body
 *       raw:  string             // exact bytes the client sent (string)
 *     }
 *   }
 *
 * The raw body is captured BEFORE any middleware or module reads req, so
 * HMAC-SHA256 over the exact bytes works and the parsed views stay in sync.
 */

/**
 * Parse application/x-www-form-urlencoded body text. Repeated keys become
 * arrays (first occurrence keeps the scalar shape, later values push).
 */
function parseForm(text) {
  const params = new URLSearchParams(text);
  const out = {};
  for (const [k, v] of params.entries()) {
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function multipartParser() {
  const p = require('multipart-parser');
  return new p();
}

/**
 * Build the normalized context.
 * @param {string} rawBody exact request body bytes (captured upstream)
 * @param {import('express').Request} req
 * @param {string} webhook webhook directory name, or requested name for unknown routes
 */
function buildContext(rawBody, req, webhook) {
  const method = String(req.method || 'GET').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

  // Full request path including any mount prefix (req.path is relative inside
  // mounted middleware; originalUrl carries the complete path, minus query).
  const fullPath = req.originalUrl ? req.originalUrl.split('?')[0] : req.path || req.url;

  const query = Object.fromEntries(Object.entries(req.query || {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

  const body = {
    url: {},
    post: {},
    json: null,
    raw: rawBody,
  };

  const contentType = String(req.headers['content-type'] || '');
  if (contentType.includes('application/x-www-form-urlencoded') || (method !== 'GET' && !contentType && rawBody)) {
    body.url = parseForm(rawBody);
  }
  if (contentType.includes('multipart/form-data')) {
    const parser = multipartParser();
    parser.on('field', (field) => {
      const name = String(field.name);
      if (body.post[name] === undefined) body.post[name] = String(field.value);
      else if (Array.isArray(body.post[name])) body.post[name].push(String(field.value));
      else body.post[name] = [body.post[name], String(field.value)];
    });
    parser.write(rawBuffer(rawBody)).on('error', (e) => {
      // multipart parse failure is non-fatal; the raw body is still available
      console.error(`[normalize] multipart parse failed: ${e.message}`);
    });
  }
  if (contentType.includes('application/json')) {
    body.json = parseJson(rawBody);
  }

  return { webhook, headers, method, path: fullPath, query, body };
}

function rawBuffer(str) {
  return typeof str === 'string' ? Buffer.from(str, 'utf8') : str;
}

module.exports = { buildContext, parseJson };
