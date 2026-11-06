#!/usr/bin/env node
'use strict';

/**
 * Generate the Prisma client from the assembled schema: the engine schema
 * (prisma/schema.prisma) plus every webhook's model fragment
 * (webhooks/<name>/model.prisma), written to prisma/generated/schema.prisma.
 *
 *   npm run prisma:generate
 *
 * Webhook extension tables then get typed client models
 * (getPrisma().exampleEvent.findMany(), ...). The migration path is
 * untouched — `prisma migrate deploy` and `npm run db:migrate` still use the
 * engine-only schema (scripts/assemble-schema.js header explains why).
 *
 * Like prisma-studio.js, DATABASE_URL is assembled from the split DB_* vars
 * so the CLI never hits P1012. Extra CLI args are forwarded, e.g.:
 *
 *   npm run prisma:generate -- --watch
 */

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { resolveDatabaseUrl } = require('../src/db');
const { assembleSchema, OUT_REL } = require('./assemble-schema');

function log(msg) {
  console.log(`[prisma:generate] ${msg}`);
}

const { fragments, errors, outRel } = assembleSchema((msg) =>
  log(msg.replace('[schema] ', '')));

if (errors.length > 0) {
  for (const e of errors) console.error(`[prisma:generate] ERROR: ${e}`);
  console.error('[prisma:generate] fix the fragments above — nothing generated');
  process.exit(1);
}

log(`assembled ${outRel} (+${fragments.length} webhook fragment(s))`);

process.env.DATABASE_URL = resolveDatabaseUrl();

const args = ['generate', '--schema', outRel, ...process.argv.slice(2)];
const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const res = spawnSync(bin, ['prisma', ...args], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(res.status ?? 1);
