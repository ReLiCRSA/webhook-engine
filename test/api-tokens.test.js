'use strict';

/**
 * Unit tests for engine-managed API bearer tokens (src/api-tokens.js) and the
 * master / db-token principal split in src/generic-auth.js.
 *
 * No database, no network: the store runs against a fake Prisma client and
 * generic auth against injected hooks (npm test contract).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  ApiTokenStore,
  TokenInputError,
  parseTokenRequest,
  generateTokenMaterial,
  hashToken,
  validateName,
  parseExpiresAt,
  tokenStatus,
  TOKEN_PREFIX,
} = require('../src/api-tokens');
const { GenericAuth, createGenericAuth, checksum } = require('../src/generic-auth');

/** Minimal fake of the Prisma apiToken model (Map keyed by tokenHash/id). */
function fakePrisma() {
  const rows = new Map();
  let seq = 0n;
  const clone = (r) => ({ ...r });
  return {
    _rows: rows,
    apiToken: {
      create: async ({ data }) => {
        const row = { id: ++seq, createdAt: new Date(), revokedAt: null, lastUsedAt: null, expiresAt: null, ...data };
        rows.set(`hash:${row.tokenHash}`, row);
        return clone(row);
      },
      findUnique: async ({ where }) => {
        if (where.tokenHash !== undefined) {
          const r = rows.get(`hash:${where.tokenHash}`);
          return r ? clone(r) : null;
        }
        if (where.id !== undefined) {
          for (const r of rows.values()) if (r.id === where.id) return clone(r);
        }
        return null;
      },
      findMany: async () => [...rows.values()].reverse().map(clone),
      update: async ({ where, data }) => {
        for (const r of rows.values()) {
          if (r.id === where.id) {
            Object.assign(r, data);
            return clone(r);
          }
        }
        throw new Error('P2025: no such row');
      },
    },
  };
}

function newStore() {
  const prisma = fakePrisma();
  return { store: new ApiTokenStore(() => prisma), prisma };
}

// --- token material -----------------------------------------------------------

test('generateTokenMaterial: whk_ + 32 base64url chars, unique, sha256 hash, display prefix', () => {
  const a = generateTokenMaterial();
  const b = generateTokenMaterial();
  assert.match(a.plaintext, /^whk_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a.plaintext, b.plaintext);
  assert.equal(a.tokenHash, crypto.createHash('sha256').update(a.plaintext, 'utf8').digest('hex'));
  assert.equal(a.prefix, a.plaintext.slice(0, a.prefix.length));
  assert.ok(a.prefix.startsWith(TOKEN_PREFIX));
  assert.ok(a.prefix.length < a.plaintext.length);
});

test('hashToken: matches sha256 and is stable', () => {
  assert.equal(hashToken('abc'), crypto.createHash('sha256').update('abc', 'utf8').digest('hex'));
  assert.equal(hashToken('abc'), hashToken('abc'));
});

test('validateName: trims, rejects empty and oversized', () => {
  assert.equal(validateName('  ci-deploy  '), 'ci-deploy');
  assert.throws(() => validateName(''), TokenInputError);
  assert.throws(() => validateName('   '), TokenInputError);
  assert.throws(() => validateName('x'.repeat(101)), TokenInputError);
});

test('parseExpiresAt: null/empty = never; YYYY-MM-DD = end of UTC day; ISO passthrough; junk throws', () => {
  assert.equal(parseExpiresAt(null), null);
  assert.equal(parseExpiresAt(undefined), null);
  assert.equal(parseExpiresAt(''), null);
  assert.equal(parseExpiresAt('2030-01-15').toISOString(), '2030-01-15T23:59:59.999Z');
  assert.equal(parseExpiresAt('2030-06-01T12:00:00Z').toISOString(), '2030-06-01T12:00:00.000Z');
  assert.throws(() => parseExpiresAt('not-a-date'), TokenInputError);
});

test('parseTokenRequest: JSON body {name, expiresAt}; bad JSON / non-object throws TokenInputError', () => {
  assert.deepEqual(parseTokenRequest('{"name":"ci","expiresAt":"2030-01-15"}'), { name: 'ci', expiresAt: '2030-01-15' });
  assert.deepEqual(parseTokenRequest(''), { name: undefined, expiresAt: undefined });
  assert.throws(() => parseTokenRequest('{oops'), TokenInputError);
  assert.throws(() => parseTokenRequest('[1,2]'), TokenInputError);
});

test('tokenStatus: revoked beats expired beats active', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  assert.equal(tokenStatus({ revokedAt: null, expiresAt: null }, now), 'active');
  assert.equal(tokenStatus({ revokedAt: null, expiresAt: new Date(now - 1) }, now), 'expired');
  assert.equal(tokenStatus({ revokedAt: null, expiresAt: new Date(now + 1) }, now), 'active');
  assert.equal(tokenStatus({ revokedAt: new Date(now), expiresAt: new Date(now + 1) }, now), 'revoked');
});

// --- store ------------------------------------------------------------------

test('create: stores only the sha256 hash, returns plaintext + metadata once', async () => {
  const { store, prisma } = newStore();
  const { plaintext, token } = await store.create({ name: ' ci ' });
  assert.match(plaintext, /^whk_[A-Za-z0-9_-]{32}$/);
  assert.equal(token.name, 'ci');
  assert.equal(token.status, 'active');
  assert.equal(token.expiresAt, null);
  assert.equal(token.plaintext, undefined);
  assert.equal(token.tokenHash, undefined);
  const rows = [...prisma._rows.keys()];
  assert.deepEqual(rows, [`hash:${hashToken(plaintext)}`]); // nothing else at rest
  const storedStrings = [...prisma._rows.values()]
    .flatMap((r) => Object.values(r))
    .filter((v) => typeof v === 'string');
  assert.ok(!storedStrings.some((s) => s.includes(plaintext))); // plaintext never persisted
});

test('create: invalid name / expiresAt throw TokenInputError (API maps to 400)', async () => {
  const { store } = newStore();
  await assert.rejects(() => store.create({ name: '' }), TokenInputError);
  await assert.rejects(() => store.create({ name: 'x', expiresAt: 'bogus' }), TokenInputError);
});

test('verifyBearer: accepts active tokens, rejects unknown/revoked/expired/wrong-prefix', async () => {
  const { store } = newStore();
  const live = await store.create({ name: 'ci' });
  const gone = await store.create({ name: 'old', expiresAt: '2000-01-01' });
  const doomed = await store.create({ name: 'soon' });
  await store.revoke(doomed.token.id);

  assert.deepEqual(await store.verifyBearer(live.plaintext), { tokenId: live.token.id, name: 'ci' });
  assert.equal(await store.verifyBearer(gone.plaintext), null); // expired
  assert.equal(await store.verifyBearer(doomed.plaintext), null); // revoked
  assert.equal(await store.verifyBearer('whk_never_seen_before_000000000000'), null);
  assert.equal(await store.verifyBearer('not-a-whk-token'), null);
  assert.equal(await store.verifyBearer(''), null);
  assert.equal(await store.verifyBearer(null), null);
});

test('verifyBearer: database unreachable returns null (rule 14 — master keeps working)', async () => {
  const store = new ApiTokenStore(() => {
    const e = new Error('Can\'t reach database server');
    e.code = 'P1001';
    throw e;
  });
  assert.equal(await store.verifyBearer('whk_anything'), null);
});

test('revoke: soft (sets revokedAt, row kept), idempotent, unknown id → null', async () => {
  const { store, prisma } = newStore();
  const { plaintext, token } = await store.create({ name: 'laptop' });
  const revoked = await store.revoke(token.id);
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.revokedAt instanceof Date);
  const again = await store.revoke(token.id); // idempotent: same revoked row
  assert.equal(again.status, 'revoked');
  assert.equal(again.id, token.id);
  assert.equal(await store.revoke(999999), null);
  assert.equal(await store.revoke('abc'), null);
  assert.equal(prisma._rows.size, 1); // audit trail preserved
  assert.equal(await store.verifyBearer(plaintext), null);
});

test('list: metadata only — tokenHash/plaintext never present', async () => {
  const { store } = newStore();
  const a = await store.create({ name: 'a' });
  const b = await store.create({ name: 'b', expiresAt: '2030-01-01' });
  const listed = await store.list();
  assert.equal(listed.length, 2);
  for (const t of listed) {
    assert.ok(!('tokenHash' in t));
    assert.ok(!('plaintext' in t));
  }
  const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
  assert.equal(byName.a.status, 'active');
  assert.equal(byName.b.status, 'active');
  assert.ok(byName.b.expiresAt instanceof Date);
  assert.ok(byName.a.prefix.startsWith('whk_'));
  void a;
});

// --- generic auth principals ------------------------------------------------

function ctxWith(headers) {
  return { headers };
}

test('bearer: env master authenticates as the master principal', async () => {
  const auth = createGenericAuth({ AUTH_MODE: 'bearer', AUTH_BEARER_TOKEN: 'master-tok' });
  const r = await auth.verifyIdentity(ctxWith({ authorization: 'Bearer master-tok' }), '');
  assert.equal(r.ok, true);
  assert.deepEqual(r.principal, { source: 'master' });
});

test('bearer: non-master goes through extraBearerVerify; db-token principal carries id+name', async () => {
  const hook = async (t) => (t === 'dbtok' ? { tokenId: 7, name: 'ci' } : null);
  const auth = createGenericAuth({ AUTH_MODE: 'bearer', AUTH_BEARER_TOKEN: 'master-tok' }, { extraBearerVerify: hook });
  const r = await auth.verifyIdentity(ctxWith({ authorization: 'Bearer dbtok' }), '');
  assert.equal(r.ok, true);
  assert.deepEqual(r.principal, { source: 'db-token', tokenId: 7, name: 'ci' });
  const bad = await auth.verifyIdentity(ctxWith({ authorization: 'Bearer nope' }), '');
  assert.equal(bad.ok, false);
  assert.equal(bad.principal, null);
});

test('bearer: no hook wired → master-only, unchanged legacy behaviour', async () => {
  const auth = createGenericAuth({ AUTH_MODE: 'bearer', AUTH_BEARER_TOKEN: 'master-tok' });
  assert.equal(await auth.verifyRaw(ctxWith({ authorization: 'Bearer dbtok' }), ''), false);
  assert.equal(await auth.verifyRaw(ctxWith({ authorization: 'Bearer master-tok' }), ''), true);
});

test('bearer: a throwing hook must not break auth (treated as no match)', async () => {
  const auth = createGenericAuth(
    { AUTH_MODE: 'bearer', AUTH_BEARER_TOKEN: 'master-tok' },
    { extraBearerVerify: async () => { throw new Error('boom'); } }
  );
  const r = await auth.verifyIdentity(ctxWith({ authorization: 'Bearer whatever' }), '');
  assert.equal(r.ok, false);
});

test('hmac,bearer combined: db bearer + valid signature ok; db bearer + bad signature denied', async () => {
  const hook = async (t) => (t === 'dbtok' ? { tokenId: 1, name: 'ci' } : null);
  const auth = createGenericAuth(
    { AUTH_MODE: 'hmac,bearer', AUTH_BEARER_TOKEN: 'master-tok', AUTH_HMAC_SECRETS: 's3cr3t' },
    { extraBearerVerify: hook }
  );
  const body = '{"a":1}';
  const good = await auth.verifyIdentity(
    { headers: { authorization: 'Bearer dbtok', 'x-signature': checksum(body, 's3cr3t') } },
    body
  );
  assert.equal(good.ok, true);
  assert.equal(good.principal.source, 'db-token');
  const bad = await auth.verifyIdentity(
    { headers: { authorization: 'Bearer dbtok', 'x-signature': 'deadbeef' } },
    body
  );
  assert.equal(bad.ok, false);
});

test('hmac only: principal is hmac; master/db-token rules do not apply', async () => {
  const auth = createGenericAuth({ AUTH_MODE: 'hmac', AUTH_HMAC_SECRETS: 'k1' });
  const body = 'x';
  const r = await auth.verifyIdentity({ headers: { 'x-signature': checksum(body, 'k1') } }, body);
  assert.equal(r.ok, true);
  assert.deepEqual(r.principal, { source: 'hmac' });
});

test('GenericAuth direct construction keeps working without the new option', async () => {
  const auth = new GenericAuth({ bearerToken: 't', hmacSecrets: [], modes: ['bearer'] });
  assert.equal(await auth.verifyRaw(ctxWith({ authorization: 'Bearer t' }), ''), true);
});
