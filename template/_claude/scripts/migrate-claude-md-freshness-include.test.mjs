#!/usr/bin/env node
// Unit tests for migrate-claude-md-freshness-include.mjs
// Run: node template/.claude/scripts/migrate-claude-md-freshness-include.test.mjs
import { runMigration } from './migrate-claude-md-freshness-include.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let failed = 0;
let passed = 0;
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-md-mig-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('# migrate-claude-md-freshness-include');

// CLAUDE.md missing → no-op
withTemp((dir) => {
  const result = runMigration({ workspaceRoot: dir });
  assertEq(result.action, 'skipped', 'no CLAUDE.md is skipped');
});

// CLAUDE.md missing the include → appended
withTemp((dir) => {
  const path = join(dir, 'CLAUDE.md');
  writeFileSync(path, '# Workspace\n@workspace.json\n');
  const result = runMigration({ workspaceRoot: dir });
  assertEq(result.action, 'appended', 'missing line is appended');
  const after = readFileSync(path, 'utf-8');
  assertEq(after.includes('@local-only-template-freshness.md'), true, 'line present after migration');
});

// CLAUDE.md already has the include → no-op
withTemp((dir) => {
  const path = join(dir, 'CLAUDE.md');
  const original = '# Workspace\n@workspace.json\n@local-only-template-freshness.md\n';
  writeFileSync(path, original);
  const result = runMigration({ workspaceRoot: dir });
  assertEq(result.action, 'unchanged', 'already-present line is unchanged');
  assertEq(readFileSync(path, 'utf-8'), original, 'file content unchanged');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
