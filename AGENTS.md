# AGENTS.md

Working rules for agents (and humans) in this repository. The README.md holds
setup and API reference; this file holds the invariants that must not be
broken.

## Hard rules

1. **One directory per webhook.** `webhooks/<name>/index.js` exports
   `{ handler, auth? }`. A webhook must never import another webhook's code.
2. **The engine owns the response lifecycle; the module owns the reply.**
   Modules write the response via `res` inside `handler(ctx, req, res)`. The
   engine observes (status, duration) via the `wrapResponse`/`invoke`
   pipeline in `src/invoke.js` and must never short-circuit a module that
   already responded (the safety timer writes 500 only if the handler never
   responds/throws within 30 s).
3. **Auth chain order is fixed:** module `auth(ctx)` → generic auth **only if**
   `webhooks/<name>/config.json` has `"useGlobalAuth": true` → open. Auth
   failure → 401 (`auth=denied`); unknown webhook → 404 (`auth=denied`, row
   stores the requested name). `/api/*` is always gated by generic auth.
4. **All DB access goes through the Prisma client** (`src/db.js` — singleton
   `getPrisma()`). No hand-written SQL in engine or modules. New models go in
   `prisma/schema.prisma` + `npm run prisma:migrate`. **Module-owned extension
   tables are the exception to "no raw SQL":** they live in
   `webhooks/<name>/migrations/<timestamp>_<slug>/migration.sql` (plain
   Postgres DDL in one `BEGIN … COMMIT`, UTC timestamp strictly newer than
   every row in `_prisma_migrations`, append-only — never renamed/backdated),
   and are accessed only via `getPrisma().$queryRaw` / `$executeRaw`. They are
   **not** Prisma models (never added to `prisma/schema.prisma`), and
   `prisma migrate dev` must not run against a database that has webhook
   extensions — it drift-detects them and offers a full schema reset
   (data loss); only `prisma migrate deploy` (no-op, tolerates unknown ledger
   rows) + the two-step apply flow from the README is safe.
5. **Record every webhook call** (success, auth failure, unknown webhook) via
   `recordWebhookCall(ctx, status, auth, durationMs)` *after* the response
   ends. Recording errors are logged, never thrown into the request path.
6. **Capture the raw body before anything reads the stream** (see
   `captureRawBody` in `src/app.js`). `ctx.body.raw` must be the exact bytes
   sent by the client — HMAC auth signs them, and the parsed views
   (`url`/`post`/`json`) must describe that same body.
7. **Never store secrets verbatim.** `Authorization` is redacted before
   persistence (`redactAuthorization` in `src/db.js`). Any new header stored
   for logging must be checked for secret material first.
8. **Logger contract:** single-argument `log[level]("message")`, scopes via
   `logger.createLogger(...)` children. Keep the line format and the
   structured NDJSON shape of the logstash sink stable; sinks are selected by
   `LOG_SINKS` (`stdout|file|logstash`).
9. **config.json is re-read per request; index.js is cached.** Treat
   `webhooks/<name>/config.json` as a live config file (no restart to change
   auth mode); module restarts require a server restart (or nodemon).
10. **Dashboard is built output, not live source.** `web/dist` is served at
    `/` and is checked for existence at `createApp` time — rebuild with
    `npm run web:build` **and restart the engine** after frontend changes.
    Dev workflow: `npm run web:dev` (Vite on 5173, proxies `/api` → 3000).
11. **Node version:** repo runs on Node 26. Avoid deprecated stdlib APIs
    (e.g. `url.parse` for form data — use `URLSearchParams`/`querystring`).
12. **npm install scripts** are gated by `allowScripts`; approve only
    reviewed packages. Approvals for a package must run from the directory
    whose lockfile it belongs to (`cd web && npm install-scripts approve ...`
    for dashboard deps) — root-level approval fails with ENOMATCH.
13. **Killing processes:** identify the exact PID with `pgrep -af 'node src/server\.js'` and `kill <PID>`. **Never** `pkill -f` broad patterns — they
    match the calling shell's own command line.
14. **DB is optional at runtime.** A down database must not prevent startup,
    must not fail requests, and must not crash the engine; expect
    per-request retry logging instead.
15. **Auth values in the call log** are exactly `none | generic | module |
    denied`. Do not introduce new values without updating the dashboard and
    schema docs.

## Verification matrix

Run against a live server (defaults from `.env`: `AUTH_MODE=bearer`,
`AUTH_BEARER_TOKEN=dev-token-change-me`, `DISABLE_TEST_WEBHOOKS` **unset**).
All rows must hold:

| # | Request | Expected status | Expected `auth` in DB row |
|---|---------|-----------------|---------------------------|
| 1 | `POST /webhook/example` with `Authorization: Bearer dev-token-change-me`, JSON body | 200 | `module` |
| 2 | `POST /webhook/example` with wrong bearer token | 401 | `denied` |
| 3 | `POST /webhook/nope` (unknown webhook) | 404 | `denied` |
| 4 | `GET /webhook/open?x=1` | 200 | `none` |
| 5 | `POST /webhook/open` with form body | 200 | `none` |
| 6 | `POST /webhook/gated`, no credentials (config.json `useGlobalAuth`) | 401 | `denied` |
| 7 | `POST /webhook/gated` with `Authorization: Bearer dev-token-change-me` | 201 | `generic` |
| 8 | `GET /api/calls` without token | 401 | (no row; API is not a webhook) |
| 9 | `GET /api/calls?limit=10` with token → contains rows 1–7 | 200 | — |
| 10 | `GET /` | 200, dashboard `index.html` | — |
| 11 | `GET /api/webhooks` with token | 200, `example→module`, `gated→generic`, `open→none` | — |
| 12 | (hmac mode) `POST /webhook/gated` with `X-Signature` from secret A or from rotated secret B | 201 | `generic` |
| 13 | (hmac mode) `POST /webhook/gated` with wrong `X-Signature` | 401 | `denied` |
| 14 | (hmac mode) `GET /webhook/open` | 200 | `none` (open webhooks ignore AUTH_MODE) |
| 15 | `_prisma_migrations` after the demo webhook migration is applied | 3 rows: `20261102224736_init`, `20261103095217_example_events`, `20261105124922_add_replay_column` (chronological) | — |
| 16 | `npx prisma migrate deploy` after step 15 (with assembled `DATABASE_URL`) | 200 / "No pending migrations to apply", exit 0; `example_events` exists | — |
| 17 | `POST /api/calls/<row-4-id>/replay` with token | 200 (replay answered 200); new row for `open`, GET, query rebuilt | `none`, `replayedFromId` = id of row 4 |
| 18 | `POST /api/calls/<row-7-id>/replay` with token | 200 (replay answered 201) | `generic` (replay forwards the **caller's** Authorization; stored originals are redacted), `replayedFromId` set |
| 19 | `POST /api/calls/999999/replay` with token → 404; without token → 401; `POST /api/calls/abc/replay` with token → 400 | — | (401 stores no row; API is not a webhook) |
| 20 | (hmac mode) `POST /api/calls/<row-12-id>/replay` with valid API credentials | 200 (replay answered 201) | `generic` (body re-signed with the engine's current secret), `replayedFromId` set |

Invariants to re-check after any change:

- Startup log prints one line per webhook with its effective auth posture
  (`module` / `generic (config.json useGlobalAuth)` / `OPEN: no auth`), and
  lists open webhooks as warnings.
- With `DISABLE_TEST_WEBHOOKS=true`: startup prints a "test webhooks disabled"
  line, the built-in webhooks (`example`, `open`, `gated`) are absent from the
  startup log and `GET /api/webhooks`, and requests to them 404 like unknown
  webhooks (`auth=denied`). Unset: the full matrix above must pass.
- `GET /` serves the built dashboard only when `web/dist` exists **before**
  the engine starts (otherwise the placeholder page is shown — restart needed
  after a build).
- The dashboard's 401 → token prompt → localStorage flow works with a fresh
  browser profile; stored tokens survive reload.
- With `LOG_SINKS=stdout,file,logstash`: file sink lines are identical to
  stdout; the logstash sink delivers NDJSON batches (no crash on flush
  failure when the endpoint is down).
- `node --check` passes on every `src/*.js`.
