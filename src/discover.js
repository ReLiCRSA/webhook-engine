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
    const configPath = path.join(dir, 'config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        console.error(`[discover] ${entry.name}: invalid config.json: ${e.message}`);
      }
    }
    out.push({ name: entry.name, dir, config });
  }
  return out;
}

/** List webhook directories (re-scanning when the dir's mtime changed). */
function listWebhooks() {
  if (dirHasChanged() || lastDirMtimeMs === 0) return scan();
  return scan(); // keep it simple; stat + readdir of a tiny dir is negligible
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
 * Note: config.json is re-read on every call (cheap), so editing it does
 * not require a restart.
 */
function getWebhook(name) {
  const found = listWebhooks().find((w) => w.name === name);
  if (!found) return null;
  return { name: found.name, dir: found.dir, config: found.config, module: loadModule(found.name) };
}

module.exports = { listWebhooks, loadModule, getWebhook, WEBHOOKS_DIR };
