#!/usr/bin/env node
// Tests for context-footprint.mjs.
//
// Every case builds its own fixture tree under tmpdir. Nothing here reads the
// real workspace: a test that measures the live repo would change its own
// expected numbers every time someone edits a rule.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  measure, projectCost, parseArgs, DESTINATIONS, BYTES_PER_TOKEN, CONTEXT_WINDOW,
} from './context-footprint.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}`); }
}

function throws(fn, msg) {
  try { fn(); failed += 1; console.error(`  FAIL: ${msg} (did not throw)`); }
  catch { passed += 1; }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-footprint-'));
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
  return dir;
}

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

console.log('# counts CLAUDE.md and rules, excludes .md.skip');
{
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', 'x'.repeat(100));
    write(root, '.claude/rules/a.md', 'y'.repeat(50));
    write(root, '.claude/rules/b.md.skip', 'z'.repeat(9999));
    const m = measure({ root });
    assert(m.totalBytes === 150, `expected 150, got ${m.totalBytes}`);
    assert(m.files.length === 2, `expected 2 files, got ${m.files.length}`);
    assert(!m.files.some((f) => f.path.endsWith('.skip')), '.md.skip must be excluded');
    assert(m.files[0].bytes >= m.files[1].bytes, 'files must be sorted by bytes desc');
    assert(m.totalTokens === Math.round(150 / BYTES_PER_TOKEN), 'token estimate');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# @-imports are followed transitively, relative to the importing file');
{
  const root = fixture();
  try {
    // CLAUDE.md -> ctx/index.md -> ctx/deep/facts.md
    // The second hop is written relative to ctx/, so resolving against the
    // workspace root instead of the importing file's dir would miss it.
    write(root, 'CLAUDE.md', '@ctx/index.md\n' + 'a'.repeat(10));
    write(root, 'ctx/index.md', '@deep/facts.md\n' + 'b'.repeat(20));
    write(root, 'ctx/deep/facts.md', 'c'.repeat(30));
    const m = measure({ root });
    const paths = m.files.map((f) => f.path).sort();
    assert(paths.includes('ctx/index.md'), 'first-hop import counted');
    assert(paths.includes('ctx/deep/facts.md'), 'second hop resolved against importing file dir');
    // CLAUDE.md  = '@ctx/index.md' (13) + '\n' + 10 = 24
    // index.md   = '@deep/facts.md' (14) + '\n' + 20 = 35
    // facts.md   = 30
    assert(m.totalBytes === 24 + 35 + 30, `total was ${m.totalBytes}`);
    assert(m.files.some((f) => f.kind === 'import'), 'imports tagged with kind=import');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# an import cycle terminates and counts each file once');
{
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', '@a.md\n');
    write(root, 'a.md', '@b.md\n');
    write(root, 'b.md', '@a.md\n');
    const m = measure({ root });
    const aCount = m.files.filter((f) => f.path === 'a.md').length;
    const bCount = m.files.filter((f) => f.path === 'b.md').length;
    assert(aCount === 1, `a.md counted ${aCount} times`);
    assert(bCount === 1, `b.md counted ${bCount} times`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# a missing import is skipped and recorded');
{
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', '@nope.md\n@real.md\n');
    write(root, 'real.md', 'r'.repeat(5));
    const m = measure({ root });
    assert(m.missingImports.includes('nope.md'), 'dangling import recorded');
    assert(m.files.some((f) => f.path === 'real.md'), 'resolvable sibling still counted');
    assert(!m.files.some((f) => f.path === 'nope.md'), 'missing file not counted');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# CLAUDE.local.md is excluded from the shared total');
{
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', 'x'.repeat(10));
    write(root, 'CLAUDE.local.md', 'y'.repeat(500));
    const m = measure({ root });
    assert(m.totalBytes === 10, `shared total polluted by local: ${m.totalBytes}`);
    assert(m.local.totalBytes === 500, `local total was ${m.local.totalBytes}`);
    assert(!m.files.some((f) => f.path === 'CLAUDE.local.md'), 'local file must not be in files[]');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# projectCost charges each destination correctly');
{
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', 'x'.repeat(1000));
    const m = measure({ root });
    const N = 4000;
    assert(projectCost(m, N, 'rule').alwaysLoadedDelta === N, 'rule charges full size');
    assert(projectCost(m, N, 'locked').alwaysLoadedDelta === N, 'locked charges full size');
    assert(projectCost(m, N, 'rule-scoped').alwaysLoadedDelta === 0, 'rule-scoped is free');
    assert(projectCost(m, N, 'nowhere').alwaysLoadedDelta === 0, 'nowhere is free');
    for (const d of ['shared', 'team-member', 'memory', 'skill']) {
      const p = projectCost(m, N, d);
      assert(p.alwaysLoadedDelta > 0 && p.alwaysLoadedDelta < N, `${d} charges a small fixed cost, got ${p.alwaysLoadedDelta}`);
    }
    assert(projectCost(m, N, 'rule').newTotalBytes === 1000 + N, 'new total adds the delta');
    assert(typeof projectCost(m, N, 'rule').note === 'string', 'projection carries a note');
    throws(() => projectCost(m, N, 'bogus'), 'unknown destination must throw');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# parseArgs validates --add / --as pairing');
{
  throws(() => parseArgs(['node', 's', '--add', '100']), '--add without --as');
  throws(() => parseArgs(['node', 's', '--as', 'rule']), '--as without --add');
  throws(() => parseArgs(['node', 's', '--add', '100', '--as', 'bogus']), 'unknown --as value');
  throws(() => parseArgs(['node', 's', '--add', 'abc', '--as', 'rule']), 'non-numeric --add');
  const ok = parseArgs(['node', 's', '--root', '/tmp/x', '--add', '100', '--as', 'rule']);
  assert(ok.root === '/tmp/x' && ok.add === 100 && ok.as === 'rule', 'valid args parse');
  assert(parseArgs(['node', 's']).root === '.', 'root defaults to .');
}

console.log('# every destination in DESTINATIONS is well-formed');
{
  for (const [name, d] of Object.entries(DESTINATIONS)) {
    assert(typeof d.alwaysLoadedCost === 'function', `${name} has a cost function`);
    assert(typeof d.note === 'string' && d.note.length > 20, `${name} has a real note`);
  }
  assert(CONTEXT_WINDOW === 200000, 'context window constant');
}

console.log('# measure does not depend on process.cwd() and writes nothing (gh:142 regression)');
{
  const root = fixture();
  const elsewhere = mkdtempSync(join(tmpdir(), 'ctx-cwd-'));
  const originalCwd = process.cwd();
  try {
    write(root, 'CLAUDE.md', 'x'.repeat(100));
    write(root, '.claude/rules/a.md', 'y'.repeat(50));
    process.chdir(elsewhere);
    const m = measure({ root });
    assert(m.totalBytes === 150, `wrong total when cwd is elsewhere: ${m.totalBytes}`);
    assert(m.files.length === 2, 'files found regardless of cwd');
    assert(readdirSync(elsewhere).length === 0, 'measure() must not write into cwd');
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
}

console.log('# an empty workspace measures zero without throwing');
{
  const root = fixture();
  try {
    const m = measure({ root });
    assert(m.totalBytes === 0, 'empty workspace is zero bytes');
    assert(m.percentOfWindow === 0, 'empty workspace is 0%');
    assert(Array.isArray(m.files) && m.files.length === 0, 'no files');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
