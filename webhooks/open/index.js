'use strict';

/**
 * Open webhook: NO auth export and no config.json.
 *
 * The engine leaves such endpoints open and lists them in a startup warning —
 * handy for development and for webhooks that do their own transport-level
 * security (IP allowlists, CDN signatures, etc.). To gate it with the
 * generic auth instead, either export `auth(ctx)` here or add
 * config.json with { "useGlobalAuth": true }.
 */

module.exports = {
  async handler(ctx, req, res) {
    res.status(200).json({ webhook: ctx.webhook, note: 'open endpoint — no auth configured for this webhook' });
  },
};
