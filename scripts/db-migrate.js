#!/usr/bin/env node
'use strict';

/**
 * Apply every database migration — engine (prisma/migrations) *and* webhook
 * extensions (webhooks/<name>/migrations) — in chronological order (README
 * "Applying migrations").
 *
 *   npm run db:migrate            # add -- --skip-generate to skip step 3
 *
 * Three steps, same semantics as the manual flow in the README:
 *   1. `prisma migrate deploy` for the engine baseline (assembling
 *      DATABASE_URL from the split DB_* vars first — see prisma-studio.js).
 *   2. Every remaining migration, oldest first, skipping what the
 *      `_prisma_migrations` ledger already has. Each migration's DDL and
 *      its ledger INSERT run in one transaction over `pg` (already a
 *      dependency), so a failing migration rolls back completely and is
 *      *not* recorded — re-running the script retries it.
 *   3. Regenerate the Prisma client from the assembled schema
 *      (scripts/prisma-generate.js: engine schema + every
 *      webhooks/<name>/model.prisma fragment), so typed extension models
 *      are never missing after a fresh clone or a new webhook migration.
 *      `--skip-generate` omits this step.
 *
 * Ledger rows have the same shape `migrate deploy` writes (checksum =
 * sha256 of migration.sql; deploy tolerates rows it does not know about).
 * Idempotent: re-running is a no-op when everything is applied.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');
const { resolveDatabaseUrl } = require('../src/db');

const ROOT = path.join(__dirname, '..');
const MIGRATION_NAME_RE = /^\d{14}_[A-Za-z0-9_-]+$/;

function log(msg) {
  console.log(`[db:migrate] ${msg}`);
}

function die(msg, hint) {
  console.error(`[db:migrate] ERROR: ${msg}`);
  if (hint) console.error(`[db:migrate] ${hint}`);
  process.exit(1);
}

// Discover every migration folder: prisma/migrations/* and
// webhooks/*/migrations/*; the 14-digit timestamp prefix sorts them
// chronologically. Returns [{ name, file }] oldest first.
function findMigrations() {
  const out = [];
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'migration.sql');
      if (fs.existsSync(file)) out.push({ name: entry.name, file });
    }
  };
  scan(path.join(ROOT, 'prisma', 'migrations'));
  const webhooksDir = path.join(ROOT, 'webhooks');
  if (fs.existsSync(webhooksDir)) {
    for (const hook of fs.readdirSync(webhooksDir, { withFileTypes: true })) {
      if (hook.isDirectory()) {
        scan(path.join(webhooksDir, hook.name, 'migrations'));
      }
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function applyOne(client, migration) {
  const sql = fs.readFileSync(migration.file, 'utf8');

  // Documented shape (README rule 4): the whole DDL in one BEGIN … COMMIT.
  // Strip the wrapper and run the body inside *our* transaction instead —
  // an inner COMMIT would otherwise end it before the ledger INSERT.
  const wrapped = /^\s*BEGIN\s*;([\s\S]*?)\s*COMMIT\s*;\s*$/i.exec(sql);
  if (!wrapped || /^\s*(BEGIN|COMMIT)\s*;/im.test(wrapped[1])) {
    die(`${migration.name}: migration.sql must be exactly one BEGIN … COMMIT ` +
      'block with no nested transaction statements',
      'README rule 4: one transaction per migration');
  }
  const body = wrapped[1];
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');

  await client.query('BEGIN');
  try {
    // Simple protocol (no params): the whole DDL body in one round trip.
    await client.query(body);
    // Ledger row, same shape `migrate deploy` writes.
    await client.query(
      'INSERT INTO "_prisma_migrations" ' +
      '(id, checksum, started_at, finished_at, migration_name, ' +
      'applied_steps_count) VALUES (gen_random_uuid(), $1, now(), now(), ' +
      '$2, 1)',
      [checksum, migration.name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function main() {
  // Step 0: assemble DATABASE_URL exactly like src/db.js does.
  const url = resolveDatabaseUrl();
  process.env.DATABASE_URL = url;
  const label = url.replace(/(:\/\/)[^@/]*@/, '$1***@');

  // Step 1: engine baseline via the Prisma CLI.
  log(`using DATABASE_URL ${label}`);
  const deploy = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (deploy.status !== 0) {
    die(`prisma migrate deploy failed (exit ${deploy.status ?? 'signal'})`,
      'fix the engine migrations before applying webhook extensions');
  }

  // Step 2: every remaining migration (engine *and* webhook), oldest first.
  const client = new Client({ connectionString: url });
  await client.connect().catch((err) =>
    die(`cannot connect to the database: ${err.message}`,
      'is the database up? (npm run db:up)'));

  try {
    // Read Prisma's ledger (empty on a database nothing was ever applied to).
    let rows;
    try {
      rows = (await client.query(
        'SELECT migration_name, finished_at FROM "_prisma_migrations"')).rows;
    } catch (err) {
      if (err.code === '42P01') rows = []; // undefined_table
      else throw err;
    }

    const failed = rows.filter((r) => r.finished_at === null);
    if (failed.length > 0) {
      die(`failed migrations in _prisma_migrations: ` +
        failed.map((r) => r.migration_name).join(', '),
        'resolve them first ("prisma migrate resolve", README ' +
        '"Troubleshooting")');
    }

    const applied = new Set(rows.map((r) => r.migration_name));
    const newestApplied = [...applied].sort().at(-1);

    const migrations = findMigrations();
    const seen = new Set();
    for (const m of migrations) {
      if (!MIGRATION_NAME_RE.test(m.name)) {
        die(`invalid migration folder name "${m.name}"`,
          'expected <YYYYMMDDHHMMSS>_<slug> (UTC), see README rules');
      }
      if (seen.has(m.name)) {
        die(`duplicate migration name "${m.name}"`,
          'the folder name is the migration identity — rename one copy ' +
          'with a fresh UTC timestamp (append-only rule)');
      }
      seen.add(m.name);
    }

    let count = 0;
    for (const m of migrations) {
      if (applied.has(m.name)) {
        log(`skip ${m.name} (already applied)`);
        continue;
      }
      // Ledger rule 2: timestamp strictly newer than the newest applied
      // row. Warn, don't fail: the apply itself is safe; only the history
      // stops sorting chronologically.
      if (newestApplied && m.name <= newestApplied) {
        log(`warning: ${m.name} is not newer than the newest applied ` +
          `migration (${newestApplied}) — ledger history will not sort ` +
          'chronologically');
      }
      try {
        await applyOne(client, m);
      } catch (err) {
        die(`applying ${m.name} failed (rolled back, not recorded): ` +
          err.message, 'fix the DDL and re-run — applied migrations are ' +
          'skipped');
      }
      applied.add(m.name);
      count += 1;
      log(`applied ${m.name}`);
    }

    if (count === 0) log('No pending migrations — up to date.');
    else log(`done: ${count} applied, ${migrations.length - count} skipped`);
  } finally {
    await client.end();
  }

  // Step 3: regenerate the Prisma client from the assembled schema (engine
  // + webhook model fragments), so typed extension models can't lag behind
  // the DDL that was just applied. DATABASE_URL is already in process.env.
  if (process.argv.includes('--skip-generate')) {
    log('step 3 skipped (--skip-generate) — run npm run prisma:generate later');
    return;
  }
  log('step 3: regenerating Prisma client (assembled schema)');
  const gen = spawnSync(process.execPath, ['scripts/prisma-generate.js'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (gen.status !== 0) {
    die('client regeneration failed — migrations were applied, but the ' +
        `generated client is stale (exit ${gen.status ?? 'signal'})`,
        'fix the model.prisma fragments (collisions above), then re-run ' +
        'npm run prisma:generate');
  }
}

main().catch((err) => die(err.message));
