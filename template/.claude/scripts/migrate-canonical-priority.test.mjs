#!/usr/bin/env node
// Unit tests for migrate-canonical-priority.mjs
// Run: node template/.claude/scripts/migrate-canonical-priority.test.mjs

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { migrateCanonicalPriority } from './migrate-canonical-priority.mjs';

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

function setupRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  mkdirSync(join(root, 'workspace-context', 'shared', 'locked'), { recursive: true });
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function lockedPath(root, name) {
  return join(root, 'workspace-context', 'shared', 'locked', name);
}

function writeLocked(root, name, fm, body) {
  const path = lockedPath(root, name);
  mkdirSync(dirname(path), { recursive: true });
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(path, `---\n${yaml}\n---\n${body}`);
  return path;
}

// Body extraction: everything from the second '---' line onwards (i.e.,
// what comes after the closing frontmatter delimiter, including the
// newline that follows it). This is what should be byte-identical pre/post.
function extractBody(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return content;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { endIdx = i; break; }
  }
  if (endIdx === -1) return content;
  return lines.slice(endIdx).join('\n');
}

function captureStderr(fn) {
  const original = console.error;
  const captured = [];
  console.error = (...args) => { captured.push(args.join(' ')); };
  try {
    return { result: fn(), stderr: captured };
  } finally {
    console.error = original;
  }
}

console.log('# 1. fresh workspace with one locked file lacking priority');
{
  const root = setupRoot();
  const path = writeLocked(
    root,
    'cross-platform.md',
    { state: 'locked', type: 'reference' },
    '\n# Cross-Platform\n\nThe rule.\n',
  );
  const before = readFileSync(path, 'utf-8');
  const beforeBody = extractBody(before);

  const result = migrateCanonicalPriority({ root });
  assertEq(result.status, 'applied', 'status applied');
  assertEq(result.files.applied, ['cross-platform.md'], 'applied list');
  assertEq(result.files.unchanged, [], 'unchanged empty');

  const after = readFileSync(path, 'utf-8');
  assert(after.includes('priority: critical'), 'priority: critical present in file');
  assert(after !== before, 'file content changed');
  // Body bytes preserved
  const afterBody = extractBody(after);
  assertEq(afterBody, beforeBody, 'body bytes byte-for-byte identical');
  cleanup(root);
}

console.log('# 2. all files already have priority');
{
  const root = setupRoot();
  writeLocked(
    root,
    'a.md',
    { state: 'locked', priority: 'critical' },
    '\n# A\n',
  );
  writeLocked(
    root,
    'b.md',
    { state: 'locked', priority: 'reference' },
    '\n# B\n',
  );
  const beforeA = readFileSync(lockedPath(root, 'a.md'), 'utf-8');
  const beforeB = readFileSync(lockedPath(root, 'b.md'), 'utf-8');

  const result = migrateCanonicalPriority({ root });
  assertEq(result.status, 'noop', 'status noop');
  assertEq(result.files.applied, [], 'applied empty');
  assertEq(result.files.unchanged.sort(), ['a.md', 'b.md'], 'unchanged lists both');

  // Files untouched byte-for-byte
  assertEq(readFileSync(lockedPath(root, 'a.md'), 'utf-8'), beforeA, 'a.md unchanged');
  assertEq(readFileSync(lockedPath(root, 'b.md'), 'utf-8'), beforeB, 'b.md unchanged');
  cleanup(root);
}

console.log('# 3. mixed: one has priority, two do not');
{
  const root = setupRoot();
  writeLocked(
    root,
    'has-priority.md',
    { state: 'locked', priority: 'critical' },
    '\n# Has\n',
  );
  writeLocked(
    root,
    'needs-one.md',
    { state: 'locked', type: 'reference' },
    '\n# Needs One\n',
  );
  writeLocked(
    root,
    'needs-two.md',
    { state: 'locked', type: 'reference' },
    '\n# Needs Two\n',
  );

  const result = migrateCanonicalPriority({ root });
  assertEq(result.status, 'applied', 'status applied');
  assertEq(result.files.applied.sort(), ['needs-one.md', 'needs-two.md'], 'applied list');
  assertEq(result.files.unchanged, ['has-priority.md'], 'unchanged list');

  assert(
    readFileSync(lockedPath(root, 'needs-one.md'), 'utf-8').includes('priority: critical'),
    'needs-one got priority',
  );
  assert(
    readFileSync(lockedPath(root, 'needs-two.md'), 'utf-8').includes('priority: critical'),
    'needs-two got priority',
  );
  cleanup(root);
}

console.log('# 4. idempotence: second run is noop and files match byte-for-byte');
{
  const root = setupRoot();
  writeLocked(
    root,
    'foo.md',
    { state: 'locked', type: 'reference' },
    '\n# Foo\n',
  );

  const r1 = migrateCanonicalPriority({ root });
  assertEq(r1.status, 'applied', 'first run applied');
  const afterFirst = readFileSync(lockedPath(root, 'foo.md'), 'utf-8');

  const r2 = migrateCanonicalPriority({ root });
  assertEq(r2.status, 'noop', 'second run noop');
  assertEq(r2.files.applied, [], 'second run no applied');
  assertEq(r2.files.unchanged, ['foo.md'], 'second run lists foo as unchanged');

  const afterSecond = readFileSync(lockedPath(root, 'foo.md'), 'utf-8');
  assertEq(afterSecond, afterFirst, 'file byte-for-byte identical between runs');
  cleanup(root);
}

console.log('# 5. malformed frontmatter: skipped with stderr warning, others still processed');
{
  const root = setupRoot();
  // Malformed: no closing ---
  writeFileSync(
    lockedPath(root, 'broken.md'),
    '---\nstate: locked\nno closing delimiter\n\n# Broken\n',
  );
  // Also malformed: no opening ---
  writeFileSync(
    lockedPath(root, 'no-fm.md'),
    '# Just a heading, no frontmatter\n',
  );
  // Valid file lacking priority
  writeLocked(
    root,
    'valid.md',
    { state: 'locked', type: 'reference' },
    '\n# Valid\n',
  );
  const beforeBroken = readFileSync(lockedPath(root, 'broken.md'), 'utf-8');
  const beforeNoFm = readFileSync(lockedPath(root, 'no-fm.md'), 'utf-8');

  const { result, stderr } = captureStderr(() => migrateCanonicalPriority({ root }));

  assertEq(result.status, 'applied', 'status applied (valid file processed)');
  assertEq(result.files.applied, ['valid.md'], 'only valid.md applied');
  assertEq(result.files.unchanged, [], 'no unchanged');
  // Malformed files are skipped — they appear in neither list.
  assert(!result.files.applied.includes('broken.md'), 'broken.md not in applied');
  assert(!result.files.unchanged.includes('broken.md'), 'broken.md not in unchanged');
  assert(!result.files.applied.includes('no-fm.md'), 'no-fm.md not in applied');
  assert(!result.files.unchanged.includes('no-fm.md'), 'no-fm.md not in unchanged');

  // Stderr warnings emitted naming each malformed file
  assert(stderr.length >= 2, 'at least two stderr warnings');
  assert(
    stderr.some((line) => line.includes('broken.md') && line.includes('warning')),
    'warning mentions broken.md',
  );
  assert(
    stderr.some((line) => line.includes('no-fm.md') && line.includes('warning')),
    'warning mentions no-fm.md',
  );

  // Malformed files untouched
  assertEq(readFileSync(lockedPath(root, 'broken.md'), 'utf-8'), beforeBroken, 'broken.md untouched');
  assertEq(readFileSync(lockedPath(root, 'no-fm.md'), 'utf-8'), beforeNoFm, 'no-fm.md untouched');

  // Valid file got priority
  assert(
    readFileSync(lockedPath(root, 'valid.md'), 'utf-8').includes('priority: critical'),
    'valid.md got priority',
  );
  cleanup(root);
}

console.log('# 6. priority: reference is preserved (counts toward unchanged)');
{
  const root = setupRoot();
  const path = writeLocked(
    root,
    'reference-doc.md',
    { state: 'locked', priority: 'reference' },
    '\n# Reference\n',
  );
  const before = readFileSync(path, 'utf-8');

  const result = migrateCanonicalPriority({ root });
  assertEq(result.status, 'noop', 'status noop');
  assertEq(result.files.applied, [], 'applied empty');
  assertEq(result.files.unchanged, ['reference-doc.md'], 'reference-doc in unchanged');

  const after = readFileSync(path, 'utf-8');
  assertEq(after, before, 'file byte-for-byte identical');
  assert(after.includes('priority: reference'), 'priority: reference preserved');
  assert(!after.includes('priority: critical'), 'priority: critical NOT added');
  cleanup(root);
}

console.log('# 7. body bytes preserved when priority already set (defensive no-op)');
{
  const root = setupRoot();
  const body = '\n# Title\n\nFirst paragraph.\n\n## Section\n\nSecond paragraph with `code` and trailing newline.\n';
  const path = writeLocked(
    root,
    'with-body.md',
    { state: 'locked', priority: 'critical', type: 'reference' },
    body,
  );
  const before = readFileSync(path, 'utf-8');
  const beforeBody = extractBody(before);

  const result = migrateCanonicalPriority({ root });
  assertEq(result.status, 'noop', 'status noop');
  assertEq(result.files.unchanged, ['with-body.md'], 'unchanged contains with-body');

  const after = readFileSync(path, 'utf-8');
  const afterBody = extractBody(after);
  assertEq(afterBody, beforeBody, 'body bytes byte-for-byte identical');
  assertEq(after, before, 'whole file byte-for-byte identical');
  cleanup(root);
}

console.log('# 8. missing locked dir: noop');
{
  const root = mkdtempSync(join(tmpdir(), 'mcp-nodir-'));
  // No workspace-context/ at all
  const result = migrateCanonicalPriority({ root });
  assertEq(result.status, 'noop', 'status noop');
  assertEq(result.files, { applied: [], unchanged: [] }, 'empty file lists');
  assert(!existsSync(join(root, 'workspace-context')), 'no workspace-context created');
  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
