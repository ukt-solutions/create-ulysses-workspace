#!/usr/bin/env node
// Classify an upgrade payload's files against the workspace so /workspace-update
// can batch the safe cases and ask only where a decision is needed.
//
// Usage:
//   node classify-update.mjs [--root <dir>] [--payload <dir>]
//
// --root    workspace root; defaults to the current working directory (never
//           derived from this script's location — the upgrade payload runs
//           this file from <workspace>/.workspace-update/.claude/scripts/)
// --payload the staged payload; defaults to <root>/.workspace-update
//
// Prints JSON: { "new": [...], "identical": [...], "differs": [...] }
//   new       — no installed counterpart; safe to batch-apply after one confirm
//   identical — installed file already equals the payload byte-for-byte
//   differs   — installed file differs; needs a per-file decision
//
// Only verbatim-installed files are classified: everything under .claude/,
// plus .mcp.json and .claudeignore. The payload's templates (*.tmpl, which
// install with {{project-name}} substitution), _gitignore (merged line-by-line
// into the workspace's .gitignore), and .manifest.json (payload metadata) are
// handled by their own steps in /workspace-update and are excluded here.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), payload: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--payload') args.payload = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

// Payload-relative paths that install verbatim at the same relative path.
// Everything else in the payload is a template or metadata handled elsewhere.
const VERBATIM_ROOTS = ['.claude', '.mcp.json', '.claudeignore'];

function isClassified(payloadRelPath) {
  const first = payloadRelPath.split('/')[0];
  return VERBATIM_ROOTS.includes(first);
}

function* walkFiles(dir, prefix = '') {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(full, rel);
    else if (st.isFile()) yield rel;
  }
}

export function classifyUpdate({ root, payload }) {
  const absRoot = resolve(root);
  const absPayload = resolve(payload ?? join(absRoot, '.workspace-update'));
  if (!existsSync(absPayload)) {
    throw new Error(`No payload found at ${absPayload} — run npx @ulysses-ai/create-workspace --upgrade first`);
  }

  const result = { new: [], identical: [], differs: [] };
  for (const rel of walkFiles(absPayload)) {
    if (!isClassified(rel)) continue;
    const installed = join(absRoot, rel);
    if (!existsSync(installed)) {
      result.new.push(rel);
      continue;
    }
    const payloadBytes = readFileSync(join(absPayload, rel));
    const installedBytes = readFileSync(installed);
    if (Buffer.compare(payloadBytes, installedBytes) === 0) {
      result.identical.push(rel);
    } else {
      result.differs.push(rel);
    }
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  const result = classifyUpdate({ root: args.root, payload: args.payload });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`classify-update: ${err.message}\n`);
    process.exit(1);
  }
}
