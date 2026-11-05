'use strict';

/**
 * Webhook discovery: scans webhooks/ once directory entries change.
 *
 * A webhook is a directory webhooks/<name>/ containing:
 *   - index.js          (exports { handler, auth? })
 *   - config.json       (optional; e.g. { "useGlobalAuth": true })
 *   - package.json      (recommended; own node_modules for isolated deps)
 *
 * Discovery is mtime-based: the directory is re-scanned only when it has
 * changed since the last scan (stat is cheap), so handlers are loaded from
 * disk on every request (nodemon restarts also work fine).
 */

const fs = require('fs');
const path = require('path');

const WEBHOOKS_DIR = path.join(__dirname, '..', 'webhooks');

/**
 * Built-in test webhooks (the demo endpoints from the AGENTS.md verification
 * matrix). Set DISABLE_TEST_WEBHOOKS=true|1|yes to keep them from being
 * discovered: they then behave exactly like unknown webhooks (404,
 * auth=denied) and never show up in the startup log or GET /api/webhooks.
 * The flag is re-read per lookup (like config.json), so it can be flipped
 * without a restart under nodemon.
 */
const TEST_WEBHOOKS = new Set(['example', 'open', 'gated']);

function testWebhooksDisabled() {
  return ['true', '1', 'yes'].includes(String(process.env.DISABLE_TEST_WEBHOOKS || '').trim().toLowerCase());
}

let lastDirMtimeMs = 0;

function dirHasChanged() {
  let stat;
  try {
    stat = fs.statSync(WEBHOOKS_DIR);
  } catch {
    return false; // no webhooks dir at all
  }
  return stat.mtimeMs !== lastDirMtimeMs;
}

/**
 * Read + parse webhooks/<name>/config.json ('{}' when absent). Invalid JSON
 * is logged and treated as {} so a typo cannot take a webhook down.
 */
function readConfig(dir) {
  const configPath = path.join(dir, 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`[discover] ${path.basename(dir)}: invalid config.json: ${e.message}`);
    return {};
  }
}

function scan() {
  lastDirMtimeMs = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(WEBHOOKS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(WEBHOOKS_DIR, entry.name);
    const index = path.join(dir, 'index.js');
    if (!fs.existsSync(index)) continue;
    out.push({ name: entry.name, dir, config: readConfig(dir) });
  }
  return out;
}

/** List webhook directories (re-scanning when the dir's mtime changed). */
let cachedWebhooks = null;

function listWebhooks() {
  if (!cachedWebhooks || dirHasChanged()) cachedWebhooks = scan();
  return testWebhooksDisabled()
    ? cachedWebhooks.filter((w) => !TEST_WEBHOOKS.has(w.name))
    : cachedWebhooks;
}

/** Load (and cache) a module's handler/auth exports from its index.js. */
const moduleCache = new Map();

function loadModule(name) {
  const found = listWebhooks().find((w) => w.name === name);
  if (!found) return null;

  const indexPath = path.join(found.dir, 'index.js');
  const key = indexPath + '@' + fs.statSync(indexPath).mtimeMs;
  let mod = moduleCache.get(key);
  if (!mod) {
    // require() from the module's own directory => its node_modules resolve first,
    // giving per-webhook dependency isolation without any loader plumbing.
    const cached = require.cache[indexPath];
    if (cached) {
      moduleCache.set(key, cached.exports);
      return cached.exports;
    }
    mod = require(indexPath);
    moduleCache.set(key, mod);
  }
  return mod;
}

/**
 * Look up one webhook by name.
 * Returns { name, dir, config, module } where config is the parsed
 * content of config.json ({ } when the file is absent) and module is the
 * index.js exports (null when the directory does not exist, or the exports
 * are cached from require()).
 *
 * config.json is re-read on EVERY call (cheap), so editing it does not
 * require a restart — this holds for in-place edits too, which leave the
 * cached scan entries (listWebhooks) untouched. Handlers get this fresh
 * config as ctx.config (see invoke.js), making config.json a live
 * module-owned settings file, not just engine plumbing.
 */
function getWebhook(name) {
  const found = listWebhooks().find((w) => w.name === name);
  if (!found) return null;
  return { name: found.name, dir: found.dir, config: readConfig(found.dir), module: loadModule(found.name) };
}

module.exports = {
  listWebhooks,
  loadModule,
  getWebhook,
  testWebhooksDisabled,
  TEST_WEBHOOKS,
  WEBHOOKS_DIR,
};
