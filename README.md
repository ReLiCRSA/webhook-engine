# webhook-engine

A generic Node.js webhook engine. Each webhook lives in its own directory
(`webhooks/<name>/`) with its own `package.json`/`node_modules`, requests are
normalized into a single context object, auth is per-module or generic
(env-configured), every call is logged to PostgreSQL via Prisma, the logger
is pluggable (stdout / file / logstash), and a small React dashboard visualizes
call traffic.

## Quick start

```bash
# 1. dependencies (root + dashboard)
npm install
npm --prefix web install

# 2. configuration — copy/edit .env (see table below); docker-compose.yml reads the same vars
cp .env.example .env     # or edit .env in place

# 3. database — Docker Compose Postgres on 127.0.0.1:5432 (needs a running Docker daemon)
npm run db:up            # = docker compose up -d; data kept in the `pgdata` volume
# The Prisma CLI loads .env itself and only sees the split DB_* vars — export
# the assembled URL first (same recipe as src/db.js resolveDatabaseUrl()):
set -a && . ./.env && set +a
export DATABASE_URL="postgresql://$DB_USER:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=${DB_SCHEMA}"
npx prisma migrate deploy

# 4. build the dashboard (must happen BEFORE the engine starts serving /)
npm run web:build

# 5. run
npm start                # or: npm run dev (nodemon)
```

The engine listens on `PORT` (default `3000`). Open
`http://localhost:3000/` — the dashboard prompts for the bearer token
(`AUTH_BEARER_TOKEN`) on first load and stores it in the browser's
localStorage.

## Layout

```
src/            engine core
  server.js     entry: env, DB check (non-fatal), startup auth-posture report
  app.js        Express app: routing, raw-body capture, /api router, static web/dist
  discover.js   scans webhooks/ per request (mtime-based), loads index.js modules
  normalize.js  buildContext → { webhook, headers, method, path, query, body }
  generic-auth.js  bearer + multi-secret HMAC-SHA256 rotation
  invoke.js     pipeline: auth → handler → response-wrap → record
  db.js         Prisma singleton, call recording, header redaction, listCalls
  logger.js     pluggable logger (stdout | file | logstash)
webhooks/       one directory per webhook (example/, open/, gated/)
web/            React dashboard (Vite); built output in web/dist, served at /
prisma/         schema + migrations (WebhookCall model)
docker-compose.yml  Postgres 16 on 127.0.0.1:5432 (npm run db:up / db:down)
```

## Environment

All config comes from the environment (loaded from `.env`):

| Variable              | Default                             | Meaning |
|-----------------------|-------------------------------------|---------|
| `PORT`                | `3000`                              | HTTP listen port. |
| `DB_HOST`             | `127.0.0.1`                         | Postgres host. Used by `docker-compose.yml` too (published port side). |
| `DB_PORT`             | `5432`                              | Postgres port. `docker-compose.yml` publishes `127.0.0.1:$DB_PORT:5432`. |
| `DB_USER`             | `postgres`                          | Postgres user (also `POSTGRES_USER` in the container). |
| `DB_PASSWORD`         | —                                   | Postgres password for `DB_USER` (also `POSTGRES_PASSWORD` in the container). |
| `DB_NAME`             | `webhook`                           | Database name (also `POSTGRES_DB` in the container). |
| `DB_SCHEMA`           | `public`                            | Prisma schema name. |
| `DATABASE_URL`        | —                                   | Explicit full connection string; **overrides** the `DB_*` split vars if set. |
| `LOG_SINKS`           | `stdout`                            | Comma-separated: `stdout`, `file`, `logstash`. |
| `LOG_LEVEL`           | `info`                              | `debug`, `info`, `warn`, `error`. |
| `LOG_FILE`            | `./logs/webhook-engine.log`         | Target for the `file` sink. |
| `LOGSTASH_URL`        | `http://127.0.0.1:9200/_bulk`       | `_bulk` endpoint for the `logstash` sink (NDJSON batches). |
| `AUTH_MODE`           | `bearer`                            | `bearer` \| `hmac` \| `hmac,bearer`. **Empty = generic auth disabled** (engine starts with a warning; endpoints without their own auth stay open and are listed at startup). With both modes set, a request must satisfy *both*. |
| `AUTH_BEARER_TOKEN`   | —                                   | Token for `Authorization: Bearer <token>` (bearer mode). |
| `AUTH_HMAC_SECRETS`   | —                                   | Comma-separated secrets for `X-Signature` (hmac mode). The header must equal `HMAC-SHA256(rawBody, secret)` hex for **at least one** configured secret — multiple secrets enable rotation (old secrets stay valid until removed from the list). |
| `DISABLE_TEST_WEBHOOKS` | empty (tests served)              | `true`/`1`/`yes` stops the built-in test webhooks (`example`, `open`, `gated`) from being discovered: requests to them 404 like unknown webhooks (`auth=denied` rows) and they vanish from the startup log and `GET /api/webhooks`. Re-read per request — flip it without a restart under nodemon. |

Notes:

- If the database is down the engine **still starts** (degraded): calls are
  served normally, row recording is skipped with a log line, and each request
  retries the connection.
- Generic auth applies to `/api/*` **always** (a disabled AUTH_MODE leaves the
  API open too — set a token before exposing the engine).

## Webhook module authoring

A webhook is a directory `webhooks/<name>/`:

```
webhooks/my-hook/
  index.js         required — module.exports = { handler, auth? }
  config.json      optional — e.g. { "useGlobalAuth": true }
  package.json     recommended — own deps, installed into its own node_modules
```

Discovered directories:

- `index.js` exporting `handler` → webhook is routable at
  `POST|GET|... /webhook/<name>` (any HTTP method, including sub-paths like
  `/webhook/<name>/anything`).
- missing `handler` or a load error → reported in the startup log, route 500s.
- `config.json` is **re-read on every request** — editing it does not require a
  restart. `index.js` changes are picked up on restart (nodemon handles that).

### `handler(ctx, req, res)`

The module writes the response itself (`res.status(200).json(...)` etc.):

```js
module.exports = {
  async handler(ctx, req, res) {
    res.status(200).json({ got: ctx.body.json });
  },
};
```

`ctx` is the normalized context:

```
ctx = {
  webhook,              // directory name of the webhook
  headers,              // name -> value, names lower-cased
  method,               // upper-cased HTTP method
  path,                 // full request URL path, no query string
  query,                // parsed query params; {} when empty
  body: {
    url:  { … },           // application/x-www-form-urlencoded; {} when not sent
    post: { … },           // multipart/form-data (multipart-parser); {} when not sent
    json: { … } | null,    // application/json body; null when not sent
    raw:  "exact bytes"    // raw body string, what the client actually sent —
                           // sign this for HMAC verification
  }
}
```

The raw body is captured **before** anything else reads the stream, so the
parsed views and `body.raw` always describe the same bytes.

`req`/`res` are the original Express objects, available for edge cases.

### `auth(ctx)` — module-level auth

Exporting `auth(ctx)` (returning `Promise<boolean>`, or a boolean) makes it the
**sole** auth for this webhook — the engine's generic auth is not applied:

```js
module.exports = {
  async auth(ctx) {
    const header = String(ctx.headers['authorization'] || '');
    const m = header.match(/^Bearer\s+(\S+)$/i);
    return !!m && m[1] === process.env.ENV_FOR_MY_HOOK_TOKEN;
  },
  async handler(ctx, req, res) { /* … */ },
};
```

Put any logic in it you like: API keys, IP allowlists, OAuth, signature checks
against `ctx.body.raw`, database lookups, …

### `config.json` — opting into the generic auth

A webhook with **no** `auth` export stays open unless its `config.json` opts
in:

```json
{ "useGlobalAuth": true }
```

With that flag, the engine applies its env-configured generic auth
(bearer/hmac/both), so `/webhook/my-hook` follows `AUTH_*` settings with zero
code.

### Auth decision order (per webhook)

```
1. module exports auth(ctx)            → only module auth is enforced
2. else config.json useGlobalAuth===true → engine's generic auth (env)
3. else                                → OPEN (logged at startup + per call)
```

`/api/*` is **always** gated by the generic auth regardless of module config.
Auth failures → `401`; unknown webhook names → `404`. All of these are
recorded.

### Using the database from a module

All DB access goes through Prisma. Modules can use the engine's shared
client (same connection, same generated client — no extra Prisma install
needed):

```js
const { getPrisma } = require('../../src/db');

async handler(ctx, req, res) {
  const db = getPrisma();
  const row = await db.webhookCall.findFirst({ orderBy: { id: 'desc' } });
  res.json({ last: row });
}
```

If a module needs its own model, add it to `prisma/schema.prisma` and run
`npm run prisma:generate` — it stays available through the shared client.

## Request lifecycle

```
/webhook/<name>/<any path>            (any method)
  ↓ capture raw body (always, first)
  ↓ buildContext(raw, req, name)
  ↓ auth chain (module → generic-if-opted-in → open)     401 on deny, 404 if unknown
  ↓ handler(ctx, req, res)                       module writes the response
  ↓ response wrap observes status + duration
  ↓ (safety timer: 30 s, writes 500 if the handler never responds)
  ↓ recordWebhookCall(ctx, status, auth, durationMs) → Postgres (never blocks the reply)
```

Logged `auth` values: `none` (open), `generic`, `module`, `denied` (auth
failure **and** unknown-webhook 404s).

## Call log

Every webhook call is stored in `webhook_calls` (Prisma model `WebhookCall`):
id, webhook, method, path, query, headers, body (url/post/json/raw), status,
auth, durationMs, replayedFromId (set when the call was created by replaying
another call — see “Replay” below), createdAt. Auth failures and unknown
webhooks are included.

Header handling: only `authorization`, `x-signature`, `content-type`,
`user-agent`, `x-forwarded-for` and other `x-*` headers are stored; the
`Authorization` value is redacted (`Bearer dev-t…`), never stored verbatim.

### Dashboard API

| Endpoint | Query params | Effect |
|---|---|---|
| `GET /api/webhooks` | — | Discovered webhooks + effective auth mode (`module` / `generic` / `none`). |
| `GET /api/calls` | `webhook`, `method`, `status`, `since` (ISO date), `limit` (≤500, default 100), `offset` | Newest-first call rows with total count. |
| `POST /api/calls/:id/replay` | — | Re-execute recorded call `:id`; returns `{ original, status, responseBytes, call }` where `call` is the freshly recorded replay row. 404 unknown id, 400 non-numeric id, 503 database unavailable. |

All require the generic auth (401 without it).

```bash
curl 'http://localhost:3000/api/calls?limit=10' \
  -H 'Authorization: Bearer <token>'

curl 'http://localhost:3000/api/calls?webhook=example&status=401' \
  -H 'Authorization: Bearer <token>'

curl -X POST 'http://localhost:3000/api/calls/42/replay' \
  -H 'Authorization: Bearer <token>'
```

### Replay

`POST /api/calls/:id/replay` (and the ↻ replay button in the dashboard)
re-executes a stored call through the **full live dispatch pipeline**: the
engine rebuilds the request (method, path, query string from the stored
query JSON, stored allowlisted headers, the exact `body.raw` bytes) and
re-sends it to **itself** over loopback HTTP (`src/replay.js`). So raw-body
capture, `buildContext`, the auth chain, the safety timer and the call-log
insert all behave exactly as for a real client. The replay is recorded as a
**new row** whose `replayedFromId` points at the row it replayed (the
loopback request carries an `X-Replay: <id>` header, persisted by
`recordWebhookCall`). Replaying a replay is allowed — `replayedFromId` then
points at the immediate parent, so chains stay visible.

Credentials: stored `Authorization` values are redacted at rest, so the
original ones are unrecoverable. The replay instead forwards the
**Authorization header of the API caller** who triggered it, and when
generic HMAC auth is active the body is **re-signed** with the engine's
current secret (`X-Signature`). The replay therefore authenticates however
it actually authenticates — an `auth=denied` row can replay successfully
when the caller supplies valid credentials; the recorded `auth` value is
never inherited from the original.

Known limitations:

- Headers outside the log allowlist were never stored, so they cannot be
  replayed (the stored `Authorization` is a redaction placeholder and the
  stored `X-Signature` is replaced with a fresh one).
- `body.raw` is stored as a UTF-8 string: text bodies (JSON, forms) replay
  byte-exact; binary/multipart payloads are not guaranteed byte-identical.
- Module-level `auth(ctx)` schemes the engine can't reproduce (API-key
  lookups, IP allowlists, provider signatures) simply see the replay as any
  other request — typically 401, recorded honestly as `auth=denied`.
- A live client may send `X-Replay` itself and self-tag its row; the column
  is cosmetic provenance, not a trust boundary.
- The replay endpoint always answers 200 when the replay *ran* — a 401/500
  from the webhook is data in the new row, not an API error.

## Logging

Line format (stdout and file sinks):

```
2026-11-02T21:40:05.456Z [INFO ] [webhook:example] POST /webhook/example → 200 (12ms) auth=generic bytes_in=134
```

Scopes: engine core logs as `engine`; webhook traffic as `webhook:<name>`;
boot lines as `startup`. The `logstash` sink sends structured NDJSON records
(`@timestamp`, `level`, `scope`, `message`, `service`) in batches to
`LOGSTASH_URL`; flush failures are throttled to stderr and never crash the
engine.

## Dashboard

React + Vite, no router/UI libs. Served by the engine at `/` from `web/dist`
(the directory must exist **before** the engine starts — rebuild and restart
after changing the frontend). Features: bearer-token prompt (401 → prompt →
localStorage), filterable table (webhook / method / status / since), 100-row
pages with load-more, 5 s auto-refresh (toggleable), per-row ↻ replay button
(result + new-row id shown inline) and `↻#<id>` badges on replayed rows.

Development (hot reload; Vite proxies `/api` to `:3000`):

```bash
npm run web:dev        # another terminal: npm start
```

## Database management

Postgres is centrally hosted via `docker-compose.yml` (image `postgres:16`,
loopback-only port `127.0.0.1:5432`, named volume `pgdata`). Requires a
running Docker daemon.

- `npm run db:up` — `docker compose up -d` (starts detached; container
  `webhook-engine-pg`, restart policy `unless-stopped`).
- `npm run db:down` — `docker compose down` (stops and removes the
  container; the `pgdata` volume and its data are kept).
  `npm run db:down -- -v` also removes stored data.
- `npm run prisma:deploy` (`prisma migrate deploy`) — the safe, non-interactive
  apply path (see "Prisma CLI with the split env vars" below).
- `npm run prisma:migrate` (`prisma migrate dev`) is **interactive only**
  (Prisma ≥ 5 refuses it without a TTY) and **drift-detects against webhook
  extension tables**, offering to *reset the whole schema*, wiping all data.
  Do not run it once webhook migrations are applied; it is unusable in CI too.
- `docker-compose.yml` reads `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`
  from the same `.env`, so the container's credentials/port always match
  the engine's split config.
- For production, point the engine at any Postgres via the `DB_*` vars (or
  an explicit `DATABASE_URL`) and use the same Prisma migrations.

### Prisma CLI with the split env vars

The engine assembles its connection string from `DB_HOST`/`DB_PORT`/`DB_USER`/
`DB_PASSWORD`/`DB_NAME`/`DB_SCHEMA` in `src/db.js` (`resolveDatabaseUrl()`; an
explicit `DATABASE_URL` always wins). The **Prisma CLI does not** — it loads
`.env` by itself and therefore fails with `P1012: Environment variable not
found: DATABASE_URL`. Export the assembled URL in the same shell before any
`npx prisma *` / `npm run prisma:*` call:

```bash
set -a && . ./.env && set +a
export DATABASE_URL="postgresql://$DB_USER:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=${DB_SCHEMA}"
npx prisma migrate deploy        # or: prisma generate, migrate diff, db execute, …
```

One-shot alternative without touching the shell:

```bash
DATABASE_URL="postgresql://$DB_USER:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=${DB_SCHEMA}" \
npx prisma migrate deploy
```

Useful non-interactive diagnostics (read-only):

```bash
# schema drift between the live DB and prisma/schema.prisma
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --script
```

⚠️ Once any webhook extension tables exist, this diff will list them (it
wants to `DROP` them — that's not real drift, it's the per-webhook
extensions below). That's exactly why `prisma migrate dev` must stay off the
table.

## Per-webhook database migrations

Webhooks can own database migrations in their own directory, alongside the
engine's Prisma migrations. This is a **manual, documented flow** (no engine
code or npm script is involved — by design):

```
webhooks/<name>/migrations/
  <timestamp>_<slug>/
    migration.sql      plain Postgres DDL in one BEGIN … COMMIT block
```

Example (from `webhooks/example`):

```
webhooks/example/migrations/20261103095217_example_events/migration.sql
```

```sql
BEGIN;
CREATE TABLE example_events (
  id         BIGSERIAL PRIMARY KEY,
  payload    JSONB     NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
COMMIT;
```

### Rules

1. **Layout:** `webhooks/<name>/migrations/<timestamp>_<slug>/migration.sql`.
   The folder **name** (not the path) is the migration's identity.
2. **Timestamp:** same convention as Prisma migrations —
   `YYYYMMDDHHMMSS` from **UTC** (`date -u +%Y%m%d%H%M%S`). It must be strictly
   newer than the newest migration already applied to the database
   (`_prisma_migrations`, both engine and webhook rows), so history stays
   chronological no matter which directory a migration came from.
3. **Append-only.** Never rename, backdate, or edit a migration folder that
   has been applied anywhere. New change → new timestamped folder.
4. **One transaction:** wrap the DDL in `BEGIN; … COMMIT;`. The engine's
   baseline in `prisma/migrations/` always stays the oldest history — never
   put webhook DDL there.
5. **No Prisma models.** Extension tables are addressed from modules via
   `getPrisma().$queryRaw` / `$executeRaw` (below) — they are *not* added to
   `prisma/schema.prisma`, which keeps the engine's schema the diff/deploy
   source of truth.
6. **Do not run `prisma migrate dev` after any webhook migration has been
   applied** — it drift-detects the extension tables and offers to reset the
   whole schema (data loss). Only `prisma migrate deploy` is safe; it re-checks
   the ledger, sees nothing pending, and exits 0.

### Applying migrations (engine + webhook, in order)

Two steps; both use the assembled `DATABASE_URL` from
[Prisma CLI with the split env vars](#prisma-cli-with-the-split-env-vars).

**Step 1 — engine baseline:**

```bash
npx prisma migrate deploy
```

**Step 2 — every remaining migration, engine *and* webhook, oldest first,
skipping what the ledger already has** (ledger = the `_prisma_migrations`
table Prisma keeps in the database; `db execute` aborts the whole script on
any SQL error, so the ledger `INSERT` at the end is only reached when the DDL
succeeded):

```bash
# requires docker for the ledger lookups (host psql is not needed)
for f in prisma/migrations/*/migration.sql webhooks/*/*/*/migration.sql; do
  [ -f "$f" ] || continue
  name=$(basename "$(dirname "$f")")
  if docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" \
       -tAc "SELECT 1 FROM _prisma_migrations WHERE migration_name = '$name'" \
       | grep -q 1; then
    echo "skip $name (already applied)"
    continue
  fi
  checksum=$(sha256sum "$f" | cut -d' ' -f1)
  { cat "$f"
    # record the migration in Prisma's ledger — same row shape `migrate deploy`
    # would write (checksum = sha256 of migration.sql; deploy tolerates rows
    # it does not know about)
    printf 'INSERT INTO "_prisma_migrations"
            (id, checksum, started_at, finished_at, migration_name, applied_steps_count)
            SELECT gen_random_uuid(), %s, now(), now(), %s, 1
            WHERE NOT EXISTS (
              SELECT 1 FROM _prisma_migrations WHERE migration_name = %s);' \
      "'$checksum'" "'$name'" "'$name'"
  } | DATABASE_URL="$DATABASE_URL" npx prisma db execute --stdin
done
```

- Runs with `DB_*` vars exported (from the `export DATABASE_URL=…` block
  above), and with the Postgres container up.
- `npx prisma db execute --stdin` needs no client config and takes the whole
  script (DDL + ledger `INSERT`) in one shot.
- Re-running is a no-op: applied migrations are skipped, unapplied files are
  applied. Idempotent by construction.
- After applying, `npx prisma migrate deploy` stays green ("No pending
  migrations to apply") and the ledger rows sort chronologically with the
  engine ones.

### Using extension tables from a module

All DB access still goes through the Prisma client — no extra dependency:

```js
const { getPrisma } = require('../../src/db');

async handler(ctx, req, res) {
  const db = getPrisma();
  const payload = JSON.stringify({ event: 'created', data: ctx.body.json });
  const ins = await db.$queryRaw`INSERT INTO example_events (payload)
                       VALUES (${payload}::jsonb) RETURNING id`;
  const rows = await db.$queryRaw`SELECT id, payload, "createdAt"
                       FROM example_events ORDER BY id DESC LIMIT 10`;
  res.json({ stored: ins[0].id, recent: rows });
}
```

Notes:

- Cast JSONB literals: `::jsonb` (string parameters are of type `text`).
- Quote Prisma-style column names (`"createdAt"`) in raw SQL.
- `$executeRaw` has no result set — use it for pure DML.
- Raw queries are untyped; validate shape before trusting results.

### Troubleshooting

- `prisma migrate dev` / `migrate diff` reporting webhook tables as drift (or
  offering a schema reset): expected — the extensions are on purpose
  (rule 6); use `migrate deploy` and the ledger check instead.
- A webhook table exists but its ledger row is missing (e.g. the DDL was
  applied by hand through `psql`): insert the ledger row with the same
  `INSERT` from step 2 (guarded by `WHERE NOT EXISTS`) — `prisma migrate
  deploy` tolerates rows it does not know about.
- `P1012: Environment variable not found: DATABASE_URL`: the CLI didn't get
  the assembled URL — see the section above.

## Smoke test

With the default `.env` (`AUTH_MODE=bearer`, token `dev-token-change-me`):

```bash
B=http://127.0.0.1:3000
T='Authorization: Bearer dev-token-change-me'

curl -s -X POST $B/webhook/example -H "$T" -H 'content-type: application/json' -d '{"hello":"world"}'   # 200, auth=module
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/webhook/example -H 'Authorization: Bearer wrong' -d '{}'    # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/webhook/nope -d 'x'                                       # 404
curl -s -o /dev/null -w '%{http_code}\n' "$B/webhook/open?x=1"                                               # 200, auth=none
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/webhook/gated -d '{}'                                    # 401 (useGlobalAuth)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/webhook/gated -H "$T" -d '{}'                           # 201, auth=generic
curl -s -o /dev/null -w '%{http_code}\n' $B/api/calls                                                     # 401
curl -s -o /dev/null -w '%{http_code}\n' $B/                                                             # 200 (dashboard)
curl -s -X POST $B/api/calls/1/replay -H "$T" | head -c 400                                             # 200; new row with replayedFromId=1
```

HMAC mode, two secrets (rotation in effect):

```bash
BODY='{"k":"v"}'
SIG=$(node -e 'console.log(require("crypto").createHmac("sha256","secret-a").update(process.argv[1],"utf8").digest("hex"))' "$BODY")
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/webhook/gated -H "X-Signature: $SIG" -H 'content-type: application/json' -d "$BODY"  # 201
```
