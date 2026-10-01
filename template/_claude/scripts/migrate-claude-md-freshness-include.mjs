#!/usr/bin/env node
// Idempotent migrator: ensures CLAUDE.md includes @local-only-template-freshness.md.
// Appends one line at end if missing. Preserves the rest of the file byte-for-byte.
//
// Run standalone: node migrate-claude-md-freshness-include.mjs [--root <dir>]
// Or import { runMigration } and call programmatically.
//
// The root is --root when given, else the current working directory. It is
// never derived from this script's location: the upgrade payload runs this
// file from <workspace>/.workspace-update/.claude/scripts/, and a
// script-relative root would point inside the payload instead of at the
// workspace.
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const INCLUDE_LINE = '@local-only-template-freshness.md';

export function runMigration({ workspaceRoot }) {
  const path = join(workspaceRoot, 'CLAUDE.md');
  if (!existsSync(path)) return { action: 'skipped', reason: 'no-claude-md' };
  const before = readFileSync(path, 'utf-8');
  if (before.includes(INCLUDE_LINE)) return { action: 'unchanged' };
  const after = before.endsWith('\n') ? before + INCLUDE_LINE + '\n' : before + '\n' + INCLUDE_LINE + '\n';
  writeFileSync(path, after);
  return { action: 'appended' };
}

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

if (isMainModule(import.meta.url)) {
  try {
    const args = parseArgs(process.argv);
    const result = runMigration({ workspaceRoot: resolve(args.root) });
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(`migrate-claude-md-freshness-include: ${err.message}`);
    process.exit(1);
  }
}
