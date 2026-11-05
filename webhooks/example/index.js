'use strict';

/**
 * Example webhook module.
 *
 * Demonstrates MODULE-LEVEL AUTH: exporting `auth(ctx)` replaces the engine's
 * generic (env-configured) auth for this webhook. Here we happen to check the
 * same Bearer token the engine would check (read from env so the module stays
 * self-contained), but any logic works: IP allowlists, API keys, OAuth,
 * signature checks against ctx.body.raw, database lookups via the Prisma
 * client (see src/db.js getPrisma()), ...
 *
 * Exports:
 *   auth(ctx)     -> Promise<boolean>  (required here; absence = open unless
 *                                       config.json "useGlobalAuth": true)
 *   handler(ctx, req, res)             -> write the response yourself
 */

module.exports = {
  // ctx: { webhook, headers, method, path, query, body: { url, post, json, raw } }
  async auth(ctx) {
    const header = String(ctx.headers['authorization'] || '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const expected = process.env.AUTH_BEARER_TOKEN;
    // In real life you'd compare with crypto.timingSafeEqual.
    return !!match && !!expected && match[1] === expected;
  },

  async handler(ctx, req, res) {
    // Module-owned config lives in webhooks/example/config.json — the engine
    // re-reads it on every request and hands it to us as ctx.config ({} when
    // absent). So editing "settings.response" changes this reply live, with
    // no restart. The engine itself only reads "useGlobalAuth".
    const settings = (ctx.config && ctx.config.settings) || {};
    const response = settings.response || { message: 'hello world (add settings.response to config.json)' };

    res.status(200).json({
      // The configured reply comes first (top level): {"message":"hello solar system",...}
      ...response,
      // Then everything the engine normalized, so you can still watch traffic
      // shapes in the dashboard (and the Postgres call log).
      webhook: ctx.webhook,
      method: ctx.method,
      path: ctx.path,
      query: ctx.query,
      body: {
        url: ctx.body.url,
        post: ctx.body.post,
        json: ctx.body.json,
        raw: ctx.body.raw,
      },
    });
  },
};
