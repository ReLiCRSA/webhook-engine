'use strict';

/**
 * Generic (global) authentication.
 *
 * Config (env):
 *   AUTH_MODE          "bearer" | "hmac" | "hmac,bearer"   (empty = disabled)
 *   AUTH_BEARER_TOKEN  master token to compare against "Authorization: Bearer
 *                      <token>"; db-managed tokens (api_tokens, see
 *                      api-tokens.js) are additionally accepted via the
 *                      extraBearerVerify hook wired by server.js
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
 *
 * Bearer principals (see src/api-tokens.js):
 *   - The env token (AUTH_BEARER_TOKEN) is the MASTER: it authenticates
 *     everything and is the only principal allowed to manage db tokens.
 *   - When an `extraBearerVerify` hook is wired (db token store), a bearer
 *     that does not match the master is looked up there; a match is a
 *     `db-token` principal (full generic-auth access, no token management).
 *   - verifyIdentity() returns { ok, principal } with principal
 *     { source: 'master' } | { source: 'db-token', tokenId, name } |
 *     { source: 'hmac' }; verifyRaw() stays the boolean contract used by
 *     the webhook invoke pipeline.
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
  constructor({ bearerToken, hmacSecrets, modes, extraBearerVerify }) {
    this.modes = modes;
    this.bearerToken = bearerToken || null;
    this.hmacSecrets = (hmacSecrets || []).map((s) => String(s)).filter(Boolean);
    this.extraBearerVerify = typeof extraBearerVerify === 'function' ? extraBearerVerify : null;
    // a mode is only active when it has usable configuration
    this.bearerActive = this.modes.includes('bearer') && !!this.bearerToken;
    this.hmacActive = this.modes.includes('hmac') && this.hmacSecrets.length > 0;
    this.active = this.bearerActive || this.hmacActive;
  }

  /**
   * @returns {Promise<{ ok: boolean, principal: {source: string, tokenId?: number, name?: string} | null }>}
   */
  async verifyIdentity(ctx, rawBody) {
    if (!this.active) return { ok: false, principal: null };
    let principal = null;
    if (this.bearerActive) {
      const header = String(ctx.headers['authorization'] || '');
      const match = header.match(/^Bearer\s+(\S+)$/i);
      if (!match) return { ok: false, principal: null };
      if (this._constEq(match[1], this.bearerToken)) {
        principal = { source: 'master' };
      } else if (this.extraBearerVerify) {
        // Not the master: try db-managed tokens (revoked/expired handled there;
        // a store error must never throw here — api-tokens returns null).
        let meta = null;
        try {
          meta = await this.extraBearerVerify(match[1]);
        } catch {
          meta = null;
        }
        if (!meta) return { ok: false, principal: null };
        principal = { source: 'db-token', tokenId: meta.tokenId, name: meta.name };
      } else {
        return { ok: false, principal: null };
      }
    }
    if (this.hmacActive) {
      const provided = String(ctx.headers['x-signature'] || '').toLowerCase();
      if (!provided) return { ok: false, principal: null };
      const expected = new Set(this.hmacSecrets.map((s) => checksum(rawBody, s)));
      if (!expected.has(provided)) return { ok: false, principal: null };
      if (!principal) principal = { source: 'hmac' };
    }
    return { ok: true, principal };
  }

  /** @returns {Promise<boolean>} */
  async verifyRaw(ctx, rawBody) {
    return (await this.verifyIdentity(ctx, rawBody)).ok;
  }

  _constEq(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }
}

/**
 * @param {object} env
 * @param {{ extraBearerVerify?: (token: string) => Promise<{tokenId: number, name: string}|null> }} opts
 *        hook consulted when a bearer token is not the env master (db tokens).
 * @returns {GenericAuth | null} null => generic auth disabled.
 */
function createGenericAuth(env = process.env, { extraBearerVerify } = {}) {
  const modes = parseMode(env.AUTH_MODE);
  const hmacSecrets = String(env.AUTH_HMAC_SECRETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const auth = new GenericAuth({
    bearerToken: env.AUTH_BEARER_TOKEN,
    hmacSecrets,
    modes,
    extraBearerVerify,
  });
  return auth.active ? auth : null;
}

module.exports = { createGenericAuth, GenericAuth, checksum };
