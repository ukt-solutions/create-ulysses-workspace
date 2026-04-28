#!/usr/bin/env node
// Unit tests for capture-context.mjs
// Run: node template/.claude/scripts/capture-context.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseArgs,
  validate,
  computeDir,
  computeBaseFilename,
  resolveCollision,
  buildFrontmatter,
  renderFrontmatter,
  plan,
  write,
} from './capture-context.mjs';

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

function setupRoot() {
  return mkdtempSync(join(tmpdir(), 'cap-test-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

console.log('# validate');

{
  assertThrows(
    () => validate({ type: null, topic: 'x', scope: 'shared' }),
    /--type must be one of/,
    'rejects missing type',
  );
}

{
  assertThrows(
    () => validate({ type: 'memo', topic: 'x', scope: 'shared' }),
    /--type must be one of/,
    'rejects invalid type',
  );
}

{
  assertThrows(
    () => validate({ type: 'braindump', topic: 'BadCase', scope: 'shared' }),
    /kebab-case/,
    'rejects non-kebab-case topic',
  );
}

{
  assertThrows(
    () => validate({ type: 'braindump', topic: 'x', scope: 'invalid' }),
    /--scope must be one of/,
    'rejects invalid scope',
  );
}

{
  assertThrows(
    () => validate({ type: 'braindump', topic: 'x', scope: 'team-member' }),
    /--user is required/,
    'rejects team-member scope without user',
  );
}

{
  assertThrows(
    () => validate({ type: 'braindump', topic: 'x', scope: 'team-member', user: 'bad/name' }),
    /--user must be alphanumeric/,
    'rejects user with slash',
  );
}

{
  // valid input doesn't throw
  validate({ type: 'braindump', topic: 'my-topic', scope: 'shared' });
  validate({ type: 'handoff', topic: 'my-topic', scope: 'team-member', user: 'alice' });
  passed += 2;
}

console.log('# computeDir');

{
  const sharedDir = computeDir({ scope: 'shared', root: '/ws' });
  assertEq(sharedDir, '/ws/workspace-context/shared', 'shared scope path');

  const userDir = computeDir({ scope: 'team-member', user: 'alice', root: '/ws' });
  assertEq(userDir, '/ws/workspace-context/team-member/alice', 'team-member scope path');
}

console.log('# computeBaseFilename');

{
  assertEq(
    computeBaseFilename({ type: 'braindump', topic: 'my-thing', localOnly: false }),
    'braindump_my-thing.md',
    'standard naming',
  );
  assertEq(
    computeBaseFilename({ type: 'research', topic: 'my-thing', localOnly: true }),
    'local-only-research_my-thing.md',
    'local-only prefix applied',
  );
  assertEq(
    computeBaseFilename({ type: 'handoff', topic: 'workstream-x', localOnly: false }),
    'handoff_workstream-x.md',
    'handoff prefix',
  );
}

console.log('# resolveCollision');

{
  const root = setupRoot();
  const path1 = resolveCollision(root, 'braindump_x.md', false);
  assertEq(path1, join(root, 'braindump_x.md'), 'no collision returns base');
  cleanup(root);
}

{
  const root = setupRoot();
  writeFileSync(join(root, 'braindump_x.md'), 'first');
  const path2 = resolveCollision(root, 'braindump_x.md', false);
  assertEq(path2, join(root, 'braindump_x-2.md'), 'first collision → -2');
  writeFileSync(path2, 'second');
  const path3 = resolveCollision(root, 'braindump_x.md', false);
  assertEq(path3, join(root, 'braindump_x-3.md'), 'second collision → -3');
  cleanup(root);
}

{
  const root = setupRoot();
  writeFileSync(join(root, 'braindump_x.md'), 'first');
  const path = resolveCollision(root, 'braindump_x.md', true);
  assertEq(path, join(root, 'braindump_x.md'), '--update returns base even when exists');
  cleanup(root);
}

console.log('# buildFrontmatter');

{
  const fm = buildFrontmatter({
    type: 'braindump',
    topic: 'my-thing',
    scope: 'shared',
  });
  assertEq(fm.state, 'ephemeral', 'state ephemeral');
  assertEq(fm.lifecycle, 'active', 'lifecycle active');
  assertEq(fm.type, 'braindump', 'type set');
  assertEq(fm.topic, 'my-thing', 'topic set');
  assert(!('author' in fm), 'no author for shared scope');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(fm.updated), 'updated is ISO date');
}

{
  const fm = buildFrontmatter({
    type: 'research',
    topic: 'idea',
    scope: 'team-member',
    user: 'alice',
    variant: 'aside',
    description: 'A neat idea.',
  });
  assertEq(fm.author, 'alice', 'author from --user');
  assertEq(fm.variant, 'aside', 'variant included');
  assertEq(fm.description, 'A neat idea.', 'description included');
}

console.log('# renderFrontmatter');

{
  const out = renderFrontmatter({
    state: 'ephemeral',
    type: 'braindump',
    topic: 'x',
  });
  assertEq(
    out,
    '---\nstate: ephemeral\ntype: braindump\ntopic: x\n---',
    'frontmatter rendered with --- fences',
  );
}

console.log('# plan');

{
  const root = setupRoot();
  const planned = plan({
    type: 'braindump',
    topic: 'my-topic',
    scope: 'team-member',
    user: 'alice',
    root,
    localOnly: false,
    update: false,
  });
  assertEq(
    planned.filePath,
    join(root, 'workspace-context', 'team-member', 'alice', 'braindump_my-topic.md'),
    'planned path includes type prefix and user dir',
  );
  cleanup(root);
}

{
  const root = setupRoot();
  const args = {
    type: 'research',
    topic: 'idea',
    scope: 'team-member',
    user: 'alice',
    root,
    localOnly: true,
    update: false,
    variant: 'aside',
  };
  const planned = plan(args);
  assertEq(
    planned.filePath,
    join(root, 'workspace-context', 'team-member', 'alice', 'local-only-research_idea.md'),
    'local-only flag prefixes filename',
  );
  cleanup(root);
}

console.log('# write end-to-end');

{
  const root = setupRoot();
  const filePath = write(
    {
      type: 'braindump',
      topic: 'my-topic',
      scope: 'team-member',
      user: 'alice',
      description: 'Captured my topic.',
      root,
      localOnly: false,
      update: false,
    },
    '## Section\n\nBody text.\n',
  );
  assert(existsSync(filePath), 'file written');
  const content = readFileSync(filePath, 'utf-8');
  assert(content.startsWith('---\n'), 'starts with frontmatter');
  assert(content.includes('type: braindump'), 'frontmatter has type');
  assert(content.includes('topic: my-topic'), 'frontmatter has topic');
  assert(content.includes('author: alice'), 'frontmatter has author');
  assert(content.includes('description: Captured my topic.'), 'frontmatter has description');
  assert(content.includes('## Section\n\nBody text.'), 'body preserved');
  cleanup(root);
}

{
  // collision: second write becomes -2
  const root = setupRoot();
  const args = {
    type: 'braindump',
    topic: 'topic',
    scope: 'shared',
    root,
    localOnly: false,
    update: false,
  };
  const path1 = write(args, 'first body');
  const path2 = write(args, 'second body');
  assert(path1 !== path2, 'collision creates new path');
  assert(path2.endsWith('braindump_topic-2.md'), 'second is -2');
  cleanup(root);
}

{
  // --update: overwrites existing
  const root = setupRoot();
  const args = {
    type: 'braindump',
    topic: 'topic',
    scope: 'shared',
    root,
    localOnly: false,
    update: false,
  };
  const path1 = write(args, 'first body');
  const path2 = write({ ...args, update: true }, 'updated body');
  assertEq(path1, path2, '--update overwrites same path');
  const content = readFileSync(path1, 'utf-8');
  assert(content.includes('updated body'), 'content overwritten');
  assert(!content.includes('first body'), 'old content gone');
  cleanup(root);
}

console.log('# CLI end-to-end');

{
  const root = setupRoot();
  const scriptPath = new URL('./capture-context.mjs', import.meta.url).pathname;

  const result = spawnSync(
    'node',
    [scriptPath, '--type', 'braindump', '--topic', 'cli-test', '--scope', 'shared', '--root', root],
    { input: '## Body\n\nFrom stdin.\n', encoding: 'utf-8' },
  );
  assertEq(result.status, 0, 'CLI exits 0');
  const printedPath = result.stdout.trim();
  assert(printedPath.endsWith('braindump_cli-test.md'), 'CLI prints path with prefix');
  const content = readFileSync(printedPath, 'utf-8');
  assert(content.includes('From stdin.'), 'stdin body written');
  cleanup(root);
}

{
  // --print-only: no stdin needed, no file written
  const root = setupRoot();
  const scriptPath = new URL('./capture-context.mjs', import.meta.url).pathname;
  const result = spawnSync(
    'node',
    [
      scriptPath,
      '--type', 'handoff',
      '--topic', 'no-write',
      '--scope', 'team-member',
      '--user', 'bob',
      '--root', root,
      '--print-only',
    ],
    { encoding: 'utf-8' },
  );
  assertEq(result.status, 0, '--print-only exits 0');
  const printedPath = result.stdout.trim();
  assert(printedPath.endsWith('handoff_no-write.md'), 'planned path printed');
  assert(!existsSync(printedPath), 'no file written in print-only mode');
  cleanup(root);
}

{
  // bad arg
  const root = setupRoot();
  const scriptPath = new URL('./capture-context.mjs', import.meta.url).pathname;
  const result = spawnSync(
    'node',
    [scriptPath, '--type', 'invalid', '--topic', 'x', '--scope', 'shared', '--root', root],
    { input: 'body', encoding: 'utf-8' },
  );
  assertEq(result.status, 1, 'invalid type exits 1');
  assert(result.stderr.includes('--type must be one of'), 'error message piped to stderr');
  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
