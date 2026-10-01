#!/usr/bin/env node
// Idempotent migrator: ensures CLAUDE.md includes @local-only-template-freshness.md.
// Appends one line at end if missing. Preserves the rest of the file byte-for-byte.
//
// Run standalone: node .claude/scripts/migrate-claude-md-freshness-include.mjs
// Or import { runMigration } and call programmatically.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
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

// CLI entry point — workspace root is two levels up from this file
// (.claude/scripts/migrate-... → workspace root).
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..', '..');
  const result = runMigration({ workspaceRoot: root });
  console.log(JSON.stringify(result));
}
