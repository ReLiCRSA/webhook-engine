'use strict';

/**
 * Generic (global) authentication.
 *
 * Config (env):
 *   AUTH_MODE          "bearer" | "hmac" | "hmac,bearer"   (empty = disabled)
 *   AUTH_BEARER_TOKEN  token to compare against "Authorization: Bearer <token>"
 *   AUTH_HMAC_SECRETS  comma-separated hex/ascii secrets; request must send
 *                      header "X-Signature" = HMAC-SHA256(rawBody, key) in hex
 *                      for at least one configured secret (rotation support:
 *                      multiple secrets stay valid simultaneously, old ones
 *                      are dropped by removing them from the comma list).
 *
 * Behavior:
 *   - createGenericAuth() returns null when AUTH_MODE is empty → engine leaves
 *     endpoints without their own auth open (and lists them at startup).
 *   - otherwise verifyRaw(ctx, rawBody) resolves to true when the request
 *     satisfies every configured mode (bearer AND hmac when both are set),
 *     and false otherwise.
 */

const crypto = require('crypto');

function parseMode(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ['bearer', 'hmac'].includes(s));
}

function checksum(body, key) {
  return crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');
}

class GenericAuth {
  constructor({ bearerToken, hmacSecrets, modes }) {
    this.modes = modes;
    this.bearerToken = bearerToken || null;
    this.hmacSecrets = (hmacSecrets || []).map((s) => String(s)).filter(Boolean);
    // a mode is only active when it has usable configuration
    this.bearerActive = this.modes.includes('bearer') && !!this.bearerToken;
    this.hmacActive = this.modes.includes('hmac') && this.hmacSecrets.length > 0;
    this.active = this.bearerActive || this.hmacActive;
  }

  /** @returns {Promise<boolean>} */
  async verifyRaw(ctx, rawBody) {
    if (!this.active) return false;
    if (this.bearerActive) {
      const header = String(ctx.headers['authorization'] || '');
      const match = header.match(/^Bearer\s+(\S+)$/i);
      const ok = match && this._constEq(match[1], this.bearerToken);
      if (!ok) return false;
    }
    if (this.hmacActive) {
      const provided = String(ctx.headers['x-signature'] || '').toLowerCase();
      if (!provided) return false;
      const expected = new Set(this.hmacSecrets.map((s) => checksum(rawBody, s)));
      if (!expected.has(provided)) return false;
    }
    return true;
  }

  _constEq(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }
}

/**
 * @returns {GenericAuth | null} null => generic auth disabled.
 */
function createGenericAuth(env = process.env) {
  const modes = parseMode(env.AUTH_MODE);
  const hmacSecrets = String(env.AUTH_HMAC_SECRETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const auth = new GenericAuth({
    bearerToken: env.AUTH_BEARER_TOKEN,
    hmacSecrets,
    modes,
  });
  return auth.active ? auth : null;
}

module.exports = { createGenericAuth, GenericAuth, checksum };
