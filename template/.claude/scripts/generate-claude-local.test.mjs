#!/usr/bin/env node
// Unit tests for generate-claude-local.mjs
// Run: node template/.claude/scripts/generate-claude-local.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  readWorkspaceUser,
  renderClaudeLocal,
  generateClaudeLocal,
} from './generate-claude-local.mjs';

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function assertThrows(fn, matcher, msg) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${msg} (expected throw)`);
  } catch (e) {
    if (matcher.test(e.message)) { passed++; }
    else { failed++; console.error(`  FAIL: ${msg}\n    error: ${e.message}`); }
  }
}

function setupRoot(settings) {
  const root = mkdtempSync(join(tmpdir(), 'gcl-test-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  if (settings !== null) {
    writeFileSync(
      join(root, '.claude', 'settings.local.json'),
      JSON.stringify(settings),
    );
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

console.log('# readWorkspaceUser');

{
  const root = setupRoot({ workspace: { user: 'alice' } });
  assertEq(readWorkspaceUser(root), 'alice', 'reads workspace.user');
  cleanup(root);
}

{
  const root = mkdtempSync(join(tmpdir(), 'gcl-test-'));
  assertThrows(
    () => readWorkspaceUser(root),
    /Missing.*settings\.local\.json/,
    'missing settings file',
  );
  cleanup(root);
}

{
  const root = setupRoot({ workspace: {} });
  assertThrows(
    () => readWorkspaceUser(root),
    /workspace\.user not set/,
    'missing user field',
  );
  cleanup(root);
}

{
  const root = setupRoot({ workspace: { user: 'bad/name' } });
  assertThrows(
    () => readWorkspaceUser(root),
    /must be alphanumeric/,
    'rejects user with slash',
  );
  cleanup(root);
}

{
  const root = mkdtempSync(join(tmpdir(), 'gcl-test-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.local.json'), 'not json');
  assertThrows(
    () => readWorkspaceUser(root),
    /Could not parse/,
    'invalid JSON',
  );
  cleanup(root);
}

console.log('# renderClaudeLocal');

{
  const out = renderClaudeLocal('alice');
  assert(out.includes('## My Context'), 'has heading');
  assert(out.includes('@workspace-context/team-member/alice/index.md'), 'has user-specific import');
}

console.log('# generateClaudeLocal');

{
  const root = setupRoot({ workspace: { user: 'alice' } });
  const result = generateClaudeLocal(root);
  assertEq(result.status, 'written', 'first write reports written');
  const content = readFileSync(result.path, 'utf-8');
  assert(content.includes('alice/index.md'), 'file written with user import');
  cleanup(root);
}

{
  // running twice with same content reports unchanged
  const root = setupRoot({ workspace: { user: 'alice' } });
  generateClaudeLocal(root);
  const result = generateClaudeLocal(root);
  assertEq(result.status, 'unchanged', 'idempotent on second run');
  cleanup(root);
}

{
  // refuses to overwrite divergent content without --force
  const root = setupRoot({ workspace: { user: 'alice' } });
  writeFileSync(join(root, 'CLAUDE.local.md'), '## Custom\nUser had custom content here\n');
  assertThrows(
    () => generateClaudeLocal(root),
    /already exists with different content/,
    'refuses to overwrite custom content',
  );
  cleanup(root);
}

{
  // --force overwrites
  const root = setupRoot({ workspace: { user: 'alice' } });
  writeFileSync(join(root, 'CLAUDE.local.md'), '## Custom\n');
  const result = generateClaudeLocal(root, { force: true });
  assertEq(result.status, 'written', '--force writes');
  const content = readFileSync(join(root, 'CLAUDE.local.md'), 'utf-8');
  assert(content.includes('alice/index.md'), 'content overwritten');
  cleanup(root);
}

console.log('# CLI end-to-end');

{
  const root = setupRoot({ workspace: { user: 'bob' } });
  const scriptPath = new URL('./generate-claude-local.mjs', import.meta.url).pathname;
  const result = spawnSync('node', [scriptPath, '--root', root], { encoding: 'utf-8' });
  assertEq(result.status, 0, 'CLI exits 0');
  const out = JSON.parse(result.stdout);
  assertEq(out.status, 'written', 'CLI reports written');
  assert(existsSync(join(root, 'CLAUDE.local.md')), 'file created');
  cleanup(root);
}

{
  // CLI exits 1 on missing settings
  const root = mkdtempSync(join(tmpdir(), 'gcl-test-'));
  const scriptPath = new URL('./generate-claude-local.mjs', import.meta.url).pathname;
  const result = spawnSync('node', [scriptPath, '--root', root], { encoding: 'utf-8' });
  assertEq(result.status, 1, 'CLI exits 1 on missing settings');
  assert(result.stderr.includes('generate-claude-local'), 'stderr labeled');
  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
