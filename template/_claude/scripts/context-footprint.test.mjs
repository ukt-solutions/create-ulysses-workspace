#!/usr/bin/env node
// Tests for context-footprint.mjs.
//
// Every case builds its own fixture tree under tmpdir. Nothing here reads the
// real workspace: a test that measures the live repo would change its own
// expected numbers every time someone edits a rule.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  measure, projectCost, parseArgs, readBudget, frontmatterHasPaths,
  DESTINATIONS, BYTES_PER_TOKEN, CONTEXT_WINDOW,
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
    assert(m.conditional.totalBytes === 0 && m.conditional.files.length === 0, 'no conditional files');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# frontmatterHasPaths detects a top-level paths: key, and only there');
{
  assert(frontmatterHasPaths('---\npaths:\n  - "work-sessions/**"\n---\nbody'), 'block-style paths detected');
  assert(frontmatterHasPaths('---\npaths: ["a/**"]\n---\nbody'), 'inline paths detected');
  assert(!frontmatterHasPaths('---\nname: x\nupdated: 2026-01-01\n---\nbody'), 'frontmatter without paths is not conditional');
  assert(!frontmatterHasPaths('# no frontmatter\npaths: x\n'), 'file without frontmatter');
  assert(!frontmatterHasPaths('---\nname: x\n---\npaths: after the close\n'), 'paths after the closing delimiter ignored');
  assert(!frontmatterHasPaths('---\npaths:\n  - "a/**"\nname: unclosed\n'), 'unclosed frontmatter is not frontmatter');
  assert(!frontmatterHasPaths('description: mentions paths: inline\n'), 'no leading delimiter');
}

console.log('# rules with paths: frontmatter are conditional and excluded from the total');
{
  const root = fixture();
  try {
    const claudeMd = 'x'.repeat(100);
    const plain = 'y'.repeat(50);
    const fmNoPaths = '---\nname: whatever\n---\n' + 'z'.repeat(40);
    const scoped = '---\npaths:\n  - "work-sessions/**"\n---\n' + 'w'.repeat(70);
    write(root, 'CLAUDE.md', claudeMd);
    write(root, '.claude/rules/plain.md', plain);
    write(root, '.claude/rules/fm-no-paths.md', fmNoPaths);
    write(root, '.claude/rules/scoped.md', scoped);
    const m = measure({ root });
    assert(
      m.totalBytes === claudeMd.length + plain.length + fmNoPaths.length,
      `scoped rule leaked into total: ${m.totalBytes}`,
    );
    assert(!m.files.some((f) => f.path.endsWith('scoped.md')), 'scoped rule not in always-loaded files[]');
    assert(m.files.some((f) => f.path.endsWith('fm-no-paths.md') && f.kind === 'rule'), 'frontmatter without paths still counts as a rule');
    assert(m.conditional.files.length === 1, 'exactly one conditional rule');
    assert(m.conditional.files[0].kind === 'rule-scoped', 'conditional rule tagged rule-scoped');
    assert(m.conditional.totalBytes === scoped.length, 'conditional subtotal is the scoped rule alone');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# readBudget reads workspace.alwaysLoadedBudgetBytes');
{
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', 'x'.repeat(10));
    assert(readBudget(root) === null, 'no workspace.json -> null');
    write(root, 'workspace.json', JSON.stringify({ workspace: { alwaysLoadedBudgetBytes: 512 } }));
    assert(readBudget(root) === 512, 'budget read from workspace.json');
    write(root, 'workspace.json', JSON.stringify({ workspace: {} }));
    assert(readBudget(root) === null, 'missing field -> null');
    write(root, 'workspace.json', JSON.stringify({ workspace: { alwaysLoadedBudgetBytes: 'big' } }));
    assert(readBudget(root) === null, 'non-numeric field -> null');
    write(root, 'workspace.json', 'not json{');
    throws(() => readBudget(root), 'malformed workspace.json throws rather than hiding the budget');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# projectCost reports the budget outcome of an addition');
{
  const root = fixture();
  try {
    write(root, 'CLAUDE.md', 'x'.repeat(1000));
    const m = measure({ root });
    const over = projectCost(m, 4000, 'rule', 2000);
    assert(over.budgetBytes === 2000, 'projection carries the budget');
    assert(over.overBudgetAfter === true, 'addition that lands over is flagged');
    assert(projectCost(m, 500, 'rule', 2000).overBudgetAfter === false, 'addition within budget');
    assert(projectCost(m, 99999, 'rule-scoped', 2000).overBudgetAfter === false, 'rule-scoped addition stays free');
    const unbudgeted = projectCost(m, 4000, 'rule');
    assert(!('overBudgetAfter' in unbudgeted) && !('budgetBytes' in unbudgeted), 'no budget -> no budget fields');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('# parseArgs accepts --budget');
{
  const a = parseArgs(['node', 's', '--root', '/tmp/x', '--budget', '1000']);
  assert(a.budget === 1000, '--budget parsed');
  assert(parseArgs(['node', 's']).budget === null, 'budget defaults to null');
  assert(parseArgs(['node', 's', '--budget', '0']).budget === 0, 'zero budget is a valid budget');
  throws(() => parseArgs(['node', 's', '--budget', 'abc']), 'non-numeric --budget');
  throws(() => parseArgs(['node', 's', '--budget', '-5']), 'negative --budget');
  throws(() => parseArgs(['node', 's', '--budget']), 'missing --budget value');
}

console.log('# CLI: budget line, exit codes, and --budget override');
{
  const root = fixture();
  const scriptPath = fileURLToPath(new URL('./context-footprint.mjs', import.meta.url));
  const run = (...cliArgs) =>
    spawnSync(process.execPath, [scriptPath, ...cliArgs], { encoding: 'utf8' });
  try {
    write(root, 'CLAUDE.md', 'x'.repeat(100));
    write(root, '.claude/rules/scoped.md', '---\npaths: ["a/**"]\n---\n' + 'y'.repeat(50));

    const none = run('--root', root);
    assert(none.status === 0, `no budget configured -> exit 0, got ${none.status}`);
    assert(!none.stdout.includes('BUDGET'), 'no BUDGET line without a budget');

    write(root, 'workspace.json', JSON.stringify({ workspace: { alwaysLoadedBudgetBytes: 50 } }));
    const over = run('--root', root);
    assert(over.status === 1, `over budget -> exit 1, got ${over.status}`);
    assert(over.stdout.includes('BUDGET  100/50 bytes — OVER'), `BUDGET OVER line printed:\n${over.stdout}`);
    assert(over.stdout.includes('conditional (loads only on matching paths'), 'conditional section printed');

    const ok = run('--root', root, '--budget', '4096');
    assert(ok.status === 0, '--budget override can clear the violation');
    assert(ok.stdout.includes('BUDGET  100/4096 bytes — ok'), 'override budget used in the BUDGET line');

    const forced = run('--root', root, '--budget', '99');
    assert(forced.status === 1, '--budget override can create a violation');

    const json = JSON.parse(run('--root', root, '--json').stdout);
    assert(json.budget === 50, 'json carries the budget');
    assert(json.overBudget === true, 'json carries overBudget');
    assert(Array.isArray(json.conditional.files) && json.conditional.files.length === 1, 'json carries the conditional list');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
