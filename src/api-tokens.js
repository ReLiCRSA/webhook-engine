'use strict';

/**
 * Engine-managed API bearer tokens (api_tokens table).
 *
 * Complements the env master token (AUTH_BEARER_TOKEN): the master stays in
 * env, is never stored in the database, and is the ONLY principal that can
 * create/list/revoke these tokens. DB tokens authenticate generic auth
 * (useGlobalAuth webhooks and /api/*) and are managed from the dashboard /
 * REST API without an engine restart.
 *
 * Security posture (AGENTS.md rule 7 — never store secrets verbatim):
 *   - The plaintext token exists only inside createToken() and the POST
 *     /api/tokens response; at rest only sha256(token) is stored (tokenHash).
 *   - prefix keeps the first DISPLAY_PREFIX_LEN chars for display only — the
 *     shown prefix of a 36-char token is not usable credential material.
 *   - A lost token is replaced (revoke + create), never recovered.
 *
 * DB-down behavior (rule 14): verifyBearer() returns null instead of
 * throwing, so the master token keeps working and requests never fail
 * because the token table is unreachable.
 */

const crypto = require('crypto');

const { getPrisma } = require('./db');

const TOKEN_PREFIX = 'whk_';
const RANDOM_BYTES = 24; // → 32 base64url chars (192 bits of entropy)
const DISPLAY_PREFIX_LEN = 10; // chars of the plaintext shown in the UI
const NAME_MAX_LEN = 100;
const USAGE_TOUCH_INTERVAL_MS = 60_000; // throttle for lastUsedAt writes

/** Error for invalid input → API maps to 400. */
class TokenInputError extends Error {}

/**
 * Parse the raw JSON body of POST /api/tokens. The engine installs no body
 * parser; the auth guard already captured the exact bytes (req._rawBody).
 * @returns {{ name: *, expiresAt: * }} field validation happens in create().
 */
function parseTokenRequest(raw) {
  let input;
  try {
    input = raw ? JSON.parse(String(raw)) : {};
  } catch {
    throw new TokenInputError('expected a JSON body: { "name": "...", "expiresAt": "YYYY-MM-DD"? }');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TokenInputError('expected a JSON object: { "name": "...", "expiresAt": "YYYY-MM-DD"? }');
  }
  return { name: input.name, expiresAt: input.expiresAt };
}

function generateTokenMaterial() {
  const plaintext = TOKEN_PREFIX + crypto.randomBytes(RANDOM_BYTES).toString('base64url');
  return {
    plaintext,
    tokenHash: hashToken(plaintext),
    prefix: plaintext.slice(0, DISPLAY_PREFIX_LEN),
  };
}

function hashToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext), 'utf8').digest('hex');
}

/** Trimmed, length-checked name or throws TokenInputError. */
function validateName(name) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) throw new TokenInputError('token name is required');
  if (trimmed.length > NAME_MAX_LEN) throw new TokenInputError(`token name too long (max ${NAME_MAX_LEN} chars)`);
  return trimmed;
}

/**
 * Parse the expiresAt input of POST /api/tokens to a Date (or null = never):
 *   - null / undefined / ''  → null
 *   - "YYYY-MM-DD"           → end of that UTC day (23:59:59.999Z) so the
 *                              date-picker value "expires on this day" behaves
 *                              like users expect
 *   - any other date string  → Date() parse (ISO timestamps pass through)
 * Throws TokenInputError on unparseable input. A date in the past is accepted
 * (the token is simply expired immediately and shown as such).
 */
function parseExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TokenInputError('invalid expiresAt');
    return value;
  }
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(`${s}T23:59:59.999Z`);
    if (Number.isNaN(d.getTime())) throw new TokenInputError(`invalid expiresAt: ${s}`);
    return d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new TokenInputError(`invalid expiresAt: ${s}`);
  return d;
}

/** Display state of a token row: active | expired | revoked. */
function tokenStatus(row, now = Date.now()) {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= now) return 'expired';
  return 'active';
}

/** Metadata shape handed to the API/dashboard — never the hash or plaintext. */
function mapToken(row) {
  return {
    id: row.id != null ? Number(row.id) : null,
    name: row.name,
    prefix: row.prefix,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    status: tokenStatus(row),
  };
}

/**
 * Prisma-backed store. The getter is injectable so the pure logic and the
 * store are unit-testable without a database (npm test contract).
 */
class ApiTokenStore {
  constructor(getDb = getPrisma) {
    this._getDb = getDb;
    this._lastTouch = new Map(); // tokenId -> epoch ms of last lastUsedAt write
  }

  /**
   * Create a token. @returns {{ plaintext: string, token: object }} — the
   * plaintext is generated here and returned once; it is never retrievable.
   */
  async create({ name, expiresAt = null } = {}) {
    const cleanName = validateName(name);
    const expiry = parseExpiresAt(expiresAt);
    const { plaintext, tokenHash, prefix } = generateTokenMaterial();
    const row = await this._getDb().apiToken.create({
      data: { name: cleanName, tokenHash, prefix, expiresAt: expiry },
    });
    return { plaintext, token: mapToken(row) };
  }

  /** All tokens, newest first, metadata only (tokenHash never leaves here). */
  async list() {
    const rows = await this._getDb().apiToken.findMany({ orderBy: { id: 'desc' } });
    return rows.map(mapToken);
  }

  /** Soft revoke (sets revokedAt). Null when no such id; idempotent. */
  async revoke(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    const db = this._getDb();
    const existing = await db.apiToken.findUnique({ where: { id: BigInt(n) } });
    if (!existing) return null;
    if (existing.revokedAt) return mapToken(existing);
    const row = await db.apiToken.update({
      where: { id: BigInt(n) },
      data: { revokedAt: new Date() },
    });
    this._lastTouch.delete(n);
    return mapToken(row);
  }

  /**
   * Authenticate a presented bearer token against the table.
   * @returns {{ tokenId: number, name: string } | null} null = not usable
   * (unknown, revoked, expired — or the database is unreachable, rule 14).
   */
  async verifyBearer(plaintext, now = Date.now()) {
    if (!plaintext || typeof plaintext !== 'string' || !plaintext.startsWith(TOKEN_PREFIX)) return null;
    let row;
    try {
      // Indexed exact lookup on the hash — the presented token never touches SQL.
      row = await this._getDb().apiToken.findUnique({ where: { tokenHash: hashToken(plaintext) } });
    } catch (e) {
      // Same posture as recordWebhookCall: log, never throw into the request.
      console.error(`[api-tokens] token lookup failed (db down?): ${e.message}`);
      return null;
    }
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now) return null;
    this._touch(row.id, now);
    return { tokenId: Number(row.id), name: row.name };
  }

  /** Fire-and-forget, throttled lastUsedAt marker; cosmetic, never throws. */
  _touch(id, now) {
    const n = Number(id);
    const last = this._lastTouch.get(n);
    if (last !== undefined && now - last < USAGE_TOUCH_INTERVAL_MS) return;
    this._lastTouch.set(n, now);
    Promise.resolve()
      .then(() => this._getDb().apiToken.update({ where: { id: BigInt(n) }, data: { lastUsedAt: new Date(now) } }))
      .catch(() => { /* cosmetic — the row simply keeps its older marker */ });
  }
}

/** Process-wide store (keeps the lastUsedAt throttle state across requests). */
const defaultStore = new ApiTokenStore();

module.exports = {
  ApiTokenStore,
  TokenInputError,
  parseTokenRequest,
  generateTokenMaterial,
  hashToken,
  validateName,
  parseExpiresAt,
  tokenStatus,
  mapToken,
  // default-store convenience bindings
  createToken: (input) => defaultStore.create(input),
  listTokens: () => defaultStore.list(),
  revokeToken: (id) => defaultStore.revoke(id),
  verifyBearer: (plaintext) => defaultStore.verifyBearer(plaintext),
  TOKEN_PREFIX,
  DISPLAY_PREFIX_LEN,
  USAGE_TOUCH_INTERVAL_MS,
};
