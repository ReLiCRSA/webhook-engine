'use strict';

/**
 * Gated webhook: NO auth export of its own, but config.json opts in to the
 * engine's generic (env-configured) auth via "useGlobalAuth": true.
 *
 * With AUTH_MODE=bearer (the default .env) a request must carry
 *   Authorization: Bearer <AUTH_BEARER_TOKEN>
 * to get through. With AUTH_MODE=hmac it needs X-Signature; with
 * hmac,bearer both. Change AUTH_* env vars and this endpoint follows.
 */

module.exports = {
  async handler(ctx, req, res) {
    // Modules can reach the shared Prisma client without installing their
    // own, via the engine's db module (same connection, same schema):
    //   const { getPrisma } = require('../../src/db');
    res.status(201).json({ webhook: ctx.webhook, note: 'gated by generic auth (config.json useGlobalAuth)', method: ctx.method });
  },
};
