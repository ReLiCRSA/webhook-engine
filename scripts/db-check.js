#!/usr/bin/env node
'use strict';

/**
 * Drift guard for webhook model fragments: verify the *assembled* schema
 * (engine schema plus every webhook's model.prisma fragment, see
 * assemble-schema.js) matches the live database, so a fragment can't
 * silently disagree with the DDL its webhook's migrations actually applied.
 *
 *   npm run db:check
 *
 * Read-only (`prisma migrate diff`, nothing is applied). Exit codes:
 *   0  assembled schema == live database (no drift)
 *   1  drift, or the check could not run — the printed diff lists the delta
 */

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { resolveDatabaseUrl } = require('../src/db');
const { assembleSchema, OUT_REL } = require('./assemble-schema');

function log(msg) {
  console.log(`[db:check] ${msg}`);
}

function die(msg, hint) {
  console.error(`[db:check] ERROR: ${msg}`);
  if (hint) console.error(`[db:check] ${hint}`);
  process.exit(1);
}

const { errors, outRel } = assembleSchema((msg) =>
  log(msg.replace('[schema] ', '')));

if (errors.length > 0) {
  for (const e of errors) console.error(`[db:check] ERROR: ${e}`);
  die('fragments are inconsistent', 'fix the fragment collisions above');
}

const url = resolveDatabaseUrl();
log(`using DATABASE_URL ${url.replace(/(:\/\/)[^@/]*@/, '$1***@')}`);
log(`diffing live database against ${outRel}`);

const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const res = spawnSync(
  bin,
  ['prisma', 'migrate', 'diff',
    '--from-url', url,
    '--to-schema-datamodel', outRel,
    '--exit-code'],
  {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
);

if (res.status === 0) {
  log('no drift — model fragments match the live database');
  process.exit(0);
}
if (res.status === 2) {
  die('drift detected (diff above)',
    'a webhook migration and its model.prisma fragment disagree, or a ' +
    'pending migration was never applied — run npm run db:migrate, then fix ' +
    'the fragment and re-run npm run prisma:generate');
}
die(`prisma migrate diff failed (exit ${res.status ?? 'signal'})`,
  'is the database up? (npm run db:up) — see README "Prisma CLI with the ' +
  'split env vars" for P1012/P1001 issues');
