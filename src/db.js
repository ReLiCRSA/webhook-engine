'use strict';

/**
 * Database access. All DB work in the engine and in modules goes through Prisma.
 *
 * - A single PrismaClient instance for the whole process.
 * - recordWebhookCall(ctx, status, auth, durationMs) fires after a response is
 *   flushed (success or failure); DB errors are logged, never thrown at the
 *   request path.
 * - listCalls(params) backs the dashboard API with filters and pagination.
 */

const { PrismaClient, Prisma } = require('@prisma/client');

let client;

/**
 * Build the Prisma connection URL from split env vars (DB_HOST, DB_PORT,
 * DB_USER, DB_PASSWORD, DB_NAME, DB_SCHEMA). An explicit DATABASE_URL always
 * takes precedence, so a full URL can still be supplied for special hosts.
 */
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DB_PORT || '5432';
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || 'password';
  const name = process.env.DB_NAME || 'webhook';
  const schema = process.env.DB_SCHEMA || 'public';
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgresql://${auth}@${host}:${port}/${name}?schema=${schema}`;
}

function getPrisma() {
  if (!client) {
    // Prisma reads DATABASE_URL off process.env at instantiation time.
    process.env.DATABASE_URL = resolveDatabaseUrl();
    client = new PrismaClient();
  }
  return client;
}

async function ping() {
  const db = getPrisma();
  await db.$queryRaw`SELECT 1`;
  return true;
}

/**
 * Record one webhook invocation.
 * @param {object} ctx normalized context (from normalize.buildContext)
 * @param {number} status HTTP status written by the handler (or 401/404/500)
 * @param {string} auth "none" | "generic" | "module" | "denied"
 * @param {number|null} durationMs wall clock time of the request (ms)
 */
async function recordWebhookCall(ctx, status, auth, durationMs) {
  const db = getPrisma();
  try {
    await db.webhookCall.create({
      data: {
        webhook: ctx.webhook,
        method: ctx.method,
        path: ctx.path,
        query: ctx.query && Object.keys(ctx.query).length ? ctx.query : null,
        headers: sanitizeHeaders(ctx.headers),
        body: ctx.body ? { url: ctx.body.url, post: ctx.body.post, json: ctx.body.json, raw: ctx.body.raw } : null,
        status,
        auth,
        durationMs,
        replayedFromId: extractReplayedFromId(ctx),
      },
    });
  } catch (e) {
    // DB problems must never break the request path.
    console.error(`[db] failed to record webhook call for ${ctx.webhook}: ${e.message}`);
  }
}

/**
 * Provenance for replayed calls: the engine's replay feature (src/replay.js)
 * tags its loopback request with "X-Replay: <originalCallId>" and
 * recordWebhookCall persists it as replayedFromId. A live client can send the
 * header itself and self-tag its row — cosmetic metadata only.
 */
function extractReplayedFromId(ctx) {
  const v = ctx && ctx.headers ? ctx.headers['x-replay'] : undefined;
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined || s === null || s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? BigInt(n) : null;
}

function sanitizeHeaders(headers = {}) {
  const keep = ['authorization', 'x-signature', 'content-type', 'user-agent', 'x-forwarded-for'];
  const out = {};
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (keep.includes(lk) || lk.startsWith('x-')) {
      const v = headers[k];
      // Never store whole Authorization header values verbatim; redact tokens.
      out[lk] = lk === 'authorization' ? redactAuthorization(v) : Array.isArray(v) ? v.map(String) : String(v);
    }
  }
  return out;
}

function redactAuthorization(v) {
  const m = String(v).match(/^Bearer\s+(\S+)$/i);
  if (!m) return String(v);
  return `Bearer ${m[1].slice(0, 4)}…`;
}

/**
 * Dashboard query:
 *   listCalls({ webhook?, method?, status?, since?, limit = 100, offset = 0 })
 */
async function listCalls({ webhook, method, status, since, limit = 100, offset = 0 } = {}) {
  const db = getPrisma();
  const where = {};
  if (webhook) where.webhook = webhook;
  if (method) where.method = String(method).toUpperCase();
  if (status) where.status = Number(status);
  if (since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) where.createdAt = { gte: d };
  }
  const rows = await db.webhookCall.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(1, Number(limit) || 100), 500),
    skip: Math.max(0, Number(offset) || 0),
  });
  const total = await db.webhookCall.count({ where });
  return { rows: rows.map(mapRow), total };
}

function mapRow(r) {
  return {
    id: r.id ? Number(r.id) : null,
    webhook: r.webhook,
    method: r.method,
    path: r.path,
    query: r.query,
    headers: r.headers,
    body: r.body,
    status: r.status,
    auth: r.auth,
    durationMs: r.durationMs,
    replayedFromId: r.replayedFromId ? Number(r.replayedFromId) : null,
    createdAt: r.createdAt,
  };
}

/**
 * Look up one recorded call by numeric id. Throws with `code='P1001'` when the
 * database is unreachable; callers map that to 503.
 */
async function getCallById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const db = getPrisma();
  const row = await db.webhookCall.findUnique({ where: { id: BigInt(n) } });
  return row ? mapRow(row) : null;
}

/** Newest recorded call with replayedFromId = callId and id > afterId, or null. */
async function findLatestReplayOf(callId, afterId) {
  const db = getPrisma();
  const row = await db.webhookCall.findFirst({
    where: { replayedFromId: BigInt(callId), id: { gt: BigInt(afterId) } },
    orderBy: { id: 'desc' },
  });
  return row ? mapRow(row) : null;
}

/** Highest recorded call id (0 when the table is empty). */
async function maxCallId() {
  const db = getPrisma();
  const row = await db.webhookCall.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  return row && row.id ? Number(row.id) : 0;
}

/** True when a Prisma error means "database unreachable" (map to HTTP 503). */
function isDbUnreachable(e) {
  if (!e) return false;
  return e.code === 'P1001' || e.code === 'P1017' || e.name === 'PrismaClientInitializationError';
}

module.exports = {
  getPrisma,
  ping,
  recordWebhookCall,
  listCalls,
  resolveDatabaseUrl,
  getCallById,
  findLatestReplayOf,
  maxCallId,
  isDbUnreachable,
};
