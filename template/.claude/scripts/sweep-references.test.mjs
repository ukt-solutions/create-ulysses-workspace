#!/usr/bin/env node
// Unit tests for sweep-references.mjs
// Run: node template/.claude/scripts/sweep-references.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyRules, sweep, DEFAULT_RULES } from './sweep-references.mjs';

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

function setupTree() {
  return mkdtempSync(join(tmpdir(), 'sweep-test-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

console.log('# applyRules ordering');

{
  const input = 'See shared-context/locked/x.md and shared-context/y.md and shared-context';
  const { content, total, perRule } = applyRules(input);
  assert(content.includes('workspace-context/shared/locked/x.md'), 'locked path expanded correctly');
  assert(content.includes('workspace-context/y.md'), 'plain shared-context/ rewritten');
  assert(content.includes('workspace-context'), 'bare shared-context rewritten');
  assert(!content.includes('shared-context'), 'no leftover shared-context');
  assertEq(total, 3, 'three replacements counted');
  assertEq(perRule.length, 3, 'three rule entries');
}

{
  // longest-first: shared-context/locked must NOT be touched by the shorter rules first
  const input = 'shared-context/locked/foo';
  const out = applyRules(input).content;
  assertEq(out, 'workspace-context/shared/locked/foo', 'longest-first wins');
}

{
  // sharedContextDir → workspaceContextDir
  const input = '"sharedContextDir": "shared-context"';
  const out = applyRules(input).content;
  assert(out.includes('workspaceContextDir'), 'config key renamed');
  assert(out.includes('"workspace-context"'), 'value renamed');
}

{
  // no replacements when input has nothing matching
  const input = 'totally unrelated content';
  const result = applyRules(input);
  assertEq(result.content, input, 'no-op leaves content alone');
  assertEq(result.total, 0, 'zero replacements');
}

console.log('# sweep walks tree');

{
  const root = setupTree();
  mkdirSync(join(root, 'rules'), { recursive: true });
  mkdirSync(join(root, 'skills', 'aside'), { recursive: true });
  writeFileSync(join(root, 'rules', 'a.md'), 'See shared-context/locked/x.md');
  writeFileSync(join(root, 'skills', 'aside', 'SKILL.md'), '`shared-context/{user}/`');
  writeFileSync(join(root, 'unrelated.md'), 'no matches here');
  const changes = sweep(root, { write: true });
  assertEq(changes.length, 2, 'two files changed');
  const a = readFileSync(join(root, 'rules', 'a.md'), 'utf-8');
  assert(a.includes('workspace-context/shared/locked/x.md'), 'a.md rewritten');
  const skill = readFileSync(join(root, 'skills', 'aside', 'SKILL.md'), 'utf-8');
  assert(skill.includes('workspace-context/{user}/'), 'SKILL.md rewritten');
  const unrelated = readFileSync(join(root, 'unrelated.md'), 'utf-8');
  assertEq(unrelated, 'no matches here', 'unrelated file unchanged');
  cleanup(root);
}

console.log('# sweep skip rules');

{
  const root = setupTree();
  mkdirSync(join(root, 'release-notes', 'archive', 'v0.1'), { recursive: true });
  mkdirSync(join(root, 'scaffolder-release-history'), { recursive: true });
  mkdirSync(join(root, 'live'), { recursive: true });
  writeFileSync(join(root, 'release-notes', 'archive', 'v0.1', 'old.md'), 'shared-context/x');
  writeFileSync(join(root, 'scaffolder-release-history', 'log.md'), 'shared-context/y');
  writeFileSync(join(root, 'live', 'doc.md'), 'shared-context/z');
  const changes = sweep(root, { write: true });
  assertEq(changes.length, 1, 'only live/ touched');
  assertEq(changes[0].path, join('live', 'doc.md'), 'live/doc.md is the only change');
  const archived = readFileSync(join(root, 'release-notes', 'archive', 'v0.1', 'old.md'), 'utf-8');
  assertEq(archived, 'shared-context/x', 'archive untouched');
  cleanup(root);
}

console.log('# sweep skips binary files');

{
  const root = setupTree();
  // Insert a literal null byte in the buffer
  const binary = Buffer.from([0x73, 0x68, 0x61, 0x72, 0x65, 0x64, 0x2d, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x78, 0x74, 0x00, 0x00]);
  writeFileSync(join(root, 'fake.bin'), binary);
  writeFileSync(join(root, 'real.md'), 'shared-context');
  const changes = sweep(root, { write: true });
  assertEq(changes.length, 1, 'only the text file changed');
  assertEq(changes[0].path, 'real.md', 'real.md identified');
  cleanup(root);
}

console.log('# sweep --check vs --write semantics');

{
  const root = setupTree();
  writeFileSync(join(root, 'a.md'), 'shared-context/locked/foo');

  // --check (write: false) reports but does not modify
  const checkChanges = sweep(root, { write: false });
  assertEq(checkChanges.length, 1, 'check reports one file');
  const stillOriginal = readFileSync(join(root, 'a.md'), 'utf-8');
  assertEq(stillOriginal, 'shared-context/locked/foo', 'check did not write');

  // --write applies
  sweep(root, { write: true });
  const updated = readFileSync(join(root, 'a.md'), 'utf-8');
  assertEq(updated, 'workspace-context/shared/locked/foo', 'write applied');
  cleanup(root);
}

console.log('# CLI end-to-end');

{
  const root = setupTree();
  writeFileSync(join(root, 'a.md'), 'shared-context/locked/foo and shared-context/bar');
  const scriptPath = new URL('./sweep-references.mjs', import.meta.url).pathname;

  // --check exits 1 when changes pending
  const check = spawnSync('node', [scriptPath, '--check', '--target', root], { encoding: 'utf-8' });
  assertEq(check.status, 1, '--check exits 1 with changes pending');
  const checkOut = JSON.parse(check.stdout);
  assertEq(checkOut.filesChanged, 1, 'reports one file');

  // --write exits 0 and modifies
  const write = spawnSync('node', [scriptPath, '--write', '--target', root], { encoding: 'utf-8' });
  assertEq(write.status, 0, '--write exits 0');
  const updated = readFileSync(join(root, 'a.md'), 'utf-8');
  assertEq(
    updated,
    'workspace-context/shared/locked/foo and workspace-context/bar',
    'sweep wrote both rules in correct order',
  );

  // --check after --write exits 0 (no changes pending)
  const recheck = spawnSync('node', [scriptPath, '--check', '--target', root], { encoding: 'utf-8' });
  assertEq(recheck.status, 0, '--check after --write exits 0');

  cleanup(root);
}

console.log('# DEFAULT_RULES order is intentional');

{
  // Sanity: rule[0] is longer than rule[1] (locked goes first)
  assert(
    DEFAULT_RULES[0].from.length > DEFAULT_RULES[1].from.length,
    'first rule is longest',
  );
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
