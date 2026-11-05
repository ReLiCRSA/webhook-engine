#!/usr/bin/env node
'use strict';

/**
 * Launch Prisma Studio against this project's database.
 *
 * The Prisma CLI only reads DATABASE_URL from the environment; it does not
 * assemble it from the split DB_* vars in .env (see README "P1012" note).
 * This wrapper does the same assembly as src/db.js, exports DATABASE_URL,
 * and starts `prisma studio`. Any extra CLI args are forwarded, e.g.:
 *
 *   npm run prisma:studio -- --port 5556
 */

const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { resolveDatabaseUrl } = require('../src/db');

const url = resolveDatabaseUrl();
process.env.DATABASE_URL = url;

const label = url.replace(/(:\/\/)[^@/]*@/, '$1***@');
console.log(`[prisma:studio] using DATABASE_URL ${label}`);

const args = ['studio', ...process.argv.slice(2)];
const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(bin, ['prisma', ...args], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
