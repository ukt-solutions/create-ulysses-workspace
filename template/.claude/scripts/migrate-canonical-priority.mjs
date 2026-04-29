#!/usr/bin/env node
// Idempotent migrator: back-fill `priority: critical` on locked workspace-context
// files that lack the field. Default-to-critical preserves existing behavior —
// no surprise drops on upgrade.
//
// Usage:
//   node migrate-canonical-priority.mjs [--root <path>]
//
// Walks <root>/workspace-context/shared/locked/*.md. For each file:
//   - Skip non-.md files and files without parseable frontmatter (warn to stderr).
//   - If `priority` is already set (any value), leave the file untouched.
//   - Otherwise add `priority: critical` losslessly via updateSessionContent.
//
// Returns { status, files: { applied, unchanged } } where status is 'applied'
// when at least one file was modified, else 'noop'. Always exits 0 — idempotent
// migrations don't fail.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionContent, updateSessionContent } from '../lib/session-frontmatter.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function parseArgs(argv) {
  const args = { root: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

export function migrateCanonicalPriority({ root }) {
  const absRoot = resolve(root);
  const lockedDir = join(absRoot, 'workspace-context', 'shared', 'locked');
  const files = { applied: [], unchanged: [] };

  if (!existsSync(lockedDir)) {
    return { status: 'noop', files };
  }

  let entries;
  try {
    entries = readdirSync(lockedDir).sort();
  } catch {
    return { status: 'noop', files };
  }

  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = join(lockedDir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) continue;

    const raw = readFileSync(full, 'utf-8');
    let parsed;
    try {
      parsed = parseSessionContent(raw);
    } catch {
      console.error(`warning: skipping ${full}: no parseable frontmatter`);
      continue;
    }

    if (parsed?.fields?.priority !== undefined) {
      files.unchanged.push(name);
      continue;
    }

    const updated = updateSessionContent(raw, { priority: 'critical' });
    writeFileSync(full, updated);
    files.applied.push(name);
  }

  return {
    status: files.applied.length > 0 ? 'applied' : 'noop',
    files,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const result = migrateCanonicalPriority({ root: args.root });
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`migrate-canonical-priority: ${err.message}\n`);
    process.exit(1);
  }
}
