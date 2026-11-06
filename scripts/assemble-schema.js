#!/usr/bin/env node
'use strict';

/**
 * Shared assembler for the *generation* schema.
 *
 *   prisma/schema.prisma (engine: datasource + generator + engine models)
 * + webhooks/<name>/model.prisma   (per-webhook fragments: models/enums only)
 * → prisma/generated/schema.prisma (gitignored build output)
 *
 * The assembled schema is what `prisma generate` must see so webhook extension
 * tables get typed client models. The *migration* path (`prisma migrate
 * deploy`, `npm run db:migrate`) deliberately keeps using the engine-only
 * `prisma/schema.prisma` — adding fragments to the engine schema would make
 * `migrate dev`/`deploy` claim ownership of webhook DDL they never applied
 * (README rule 4/6).
 *
 * Used by scripts/prisma-generate.js and scripts/db-check.js.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINE_SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
const OUT_FILE = path.join(ROOT, 'prisma', 'generated', 'schema.prisma');
const OUT_REL = path.join('prisma', 'generated', 'schema.prisma');

// Top-level blocks a fragment may define. Anything else (datasource,
// generator, …) belongs to the engine schema and is rejected.
const FRAGMENT_BLOCK_OK = /^(model|enum|type)\s+\w+/;
const ANY_BLOCK = /^(model|enum|type|view|datasource|generator)\s+\w+/gm;
const BLOCK_NAME = /^(model|enum|type)\s+(\w+)/gm;
const MAP_NAME = /@@map\(\s*"([^"]+)"\s*\)/g;

// Discover every fragment: webhooks/<name>/model.prisma, sorted by webhook.
function findFragments() {
  const out = [];
  const webhooksDir = path.join(ROOT, 'webhooks');
  if (!fs.existsSync(webhooksDir)) return out;
  for (const hook of fs.readdirSync(webhooksDir, { withFileTypes: true })) {
    if (!hook.isDirectory()) continue;
    const file = path.join(webhooksDir, hook.name, 'model.prisma');
    if (fs.existsSync(file)) out.push({ webhook: hook.name, file });
  }
  return out.sort((a, b) => (a.webhook < b.webhook ? -1 : 1));
}

// Parse the top-level declarations a schema source contributes, so we can
// catch collisions before Prisma (or the generated client) does.
function declarations(text) {
  const blocks = new Set();
  const maps = new Set();
  for (const m of text.matchAll(BLOCK_NAME)) blocks.add(`${m[1]} ${m[2]}`);
  for (const m of text.matchAll(MAP_NAME)) maps.add(m[1]);
  return { blocks, maps };
}

/**
 * Assemble and write prisma/generated/schema.prisma.
 * @param {(msg: string) => void} log progress sink
 * @returns {{ outFile: string, outRel: string, fragments: {webhook:string}[], errors: string[] }}
 *          errors non-empty → nothing was written.
 */
function assembleSchema(log = () => {}) {
  const errors = [];
  const engine = fs.readFileSync(ENGINE_SCHEMA, 'utf8');
  const fragments = findFragments();

  const seenBlocks = declarations(engine);
  const owner = new Map();
  for (const key of seenBlocks.blocks) owner.set(key, 'prisma/schema.prisma');
  for (const tbl of seenBlocks.maps) owner.set(`table ${tbl}`, 'prisma/schema.prisma');

  const parts = [engine.trimEnd()];
  for (const f of fragments) {
    const rel = path.relative(ROOT, f.file);
    const text = fs.readFileSync(f.file, 'utf8');

    // Fragments define models/enums only — no datasource/generator blocks.
    for (const m of text.matchAll(ANY_BLOCK)) {
      if (!FRAGMENT_BLOCK_OK.test(m[0])) {
        errors.push(`${rel}: top-level "${m[0]}" is not allowed in a webhook ` +
          'fragment (models, enums and types only)');
      }
    }

    const decl = declarations(text);
    for (const key of decl.blocks) {
      if (owner.has(key)) {
        errors.push(`${rel}: ${key} collides with ${owner.get(key)}`);
      } else {
        owner.set(key, rel);
      }
    }
    for (const tbl of decl.maps) {
      const key = `table ${tbl}`;
      if (owner.has(key)) {
        errors.push(`${rel}: @@map("${tbl}") collides with ${owner.get(key)}`);
      } else {
        owner.set(key, rel);
      }
    }

    if (text.trim()) parts.push(text.trimEnd());
    log(`fragment ${rel}`);
  }

  if (errors.length > 0) return { fragments, errors, outFile: null, outRel: null };

  const out = parts.join('\n\n') + '\n';
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, out);
  return { fragments, errors, outFile: OUT_FILE, outRel: OUT_REL };
}

module.exports = { assembleSchema, OUT_REL };

// Allow direct invocation for a quick peek: node scripts/assemble-schema.js
if (require.main === module) {
  const res = assembleSchema((msg) => console.log(`[schema] ${msg}`));
  if (res.errors.length) {
    for (const e of res.errors) console.error(`[schema] ERROR: ${e}`);
    process.exit(1);
  }
  console.log(`[schema] wrote ${res.outRel}`);
}
