#!/usr/bin/env node
// Unit tests for template-baseline.mjs
// Run: node template/_claude/scripts/template-baseline.test.mjs
import { buildBaseline, writeBaseline, readBaseline, LIVE_PAIRS, INERT_PAIRS, BASELINE_PATH } from './template-baseline.mjs';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function assertTrue(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

function setupPayload(root) {
  const payload = join(root, '.workspace-update');
  mkdirSync(join(payload, '.claude', 'skills', 'demo'), { recursive: true });
  mkdirSync(join(payload, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(payload, '.claude', 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  writeFileSync(join(payload, '.claude', 'rules', 'core.md'), 'Core.\n');
  writeFileSync(join(payload, '.claude', 'settings.json'), '{}\n');
  writeFileSync(join(payload, '.mcp.json'), '{"mcpServers":{}}\n');
  writeFileSync(join(payload, '.claudeignore'), 'scratch/\n');
  return payload;
}

console.log('# template-baseline');

// 1. buildBaseline hashes every verbatim root, sorted, version from manifest
{
  const root = mkdtempSync(join(tmpdir(), 'baseline-test-'));
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.manifest.json'), JSON.stringify({ templateVersion: '9.9.9' }) + '\n');

  const baseline = buildBaseline(payload);
  assertEq(baseline.templateVersion, '9.9.9', 'version read from the payload manifest');
  assertEq(Object.keys(baseline.files), [
    '.claude/rules/core.md',
    '.claude/settings.json',
    '.claude/skills/demo/SKILL.md',
    '.claudeignore',
    '.mcp.json',
  ], 'covers .claude/** plus .mcp.json and .claudeignore, keys sorted');
  assertEq(baseline.files['.claude/rules/core.md'], sha('Core.\n'), 'hash is sha256 of the payload content');
  rmSync(root, { recursive: true, force: true });
}

// 2. tests and machine-local files are never baselined; worktrees/ never walked
{
  const root = mkdtempSync(join(tmpdir(), 'baseline-test-'));
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'demo.test.mjs'), '// test\n');
  writeFileSync(join(payload, '.claude', 'settings.local.json'), '{"workspace":{}}\n');
  writeFileSync(join(payload, '.claude', '.active-session.json'), '{}\n');
  mkdirSync(join(payload, '.claude', 'worktrees', 'fix-x'), { recursive: true });
  writeFileSync(join(payload, '.claude', 'worktrees', 'fix-x', 'CLAUDE.md'), 'nested\n');

  const baseline = buildBaseline(payload, { version: '1.0.0' });
  assertTrue(!('demo.test.mjs' in baseline.files) && !('.claude/demo.test.mjs' in baseline.files),
    '*.test.mjs is excluded');
  assertTrue(!('.claude/settings.local.json' in baseline.files), 'settings.local.json is excluded');
  assertTrue(!('.claude/.active-session.json' in baseline.files), '.active-session.json is excluded');
  assertTrue(Object.keys(baseline.files).every((k) => !k.includes('worktrees')), '.claude/worktrees/ is never walked');
  assertEq(baseline.templateVersion, '1.0.0', 'explicit version overrides the manifest');
  rmSync(root, { recursive: true, force: true });
}

// 3. inert pairs: the template tree's _claude//_mcp.json map to installed keys
{
  const root = mkdtempSync(join(tmpdir(), 'baseline-test-'));
  const tmpl = join(root, 'template');
  mkdirSync(join(tmpl, '_claude', 'scripts'), { recursive: true });
  writeFileSync(join(tmpl, '_claude', 'scripts', 'helper.mjs'), '// x\n');
  writeFileSync(join(tmpl, '_mcp.json'), '{"mcpServers":{}}\n');
  writeFileSync(join(tmpl, '.claudeignore'), 'scratch/\n');

  const baseline = buildBaseline(tmpl, { pairs: INERT_PAIRS, version: '2.0.0' });
  assertEq(Object.keys(baseline.files), [
    '.claude/scripts/helper.mjs',
    '.claudeignore',
    '.mcp.json',
  ], 'inert source names map to installed keys');
  assertEq(baseline.templateVersion, '2.0.0', 'version passed explicitly without a manifest');
  rmSync(root, { recursive: true, force: true });
}

// 4. write/read round-trip; absent or corrupt baseline reads as null
{
  const root = mkdtempSync(join(tmpdir(), 'baseline-test-'));
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.manifest.json'), JSON.stringify({ templateVersion: '3.0.0' }) + '\n');

  assertTrue(readBaseline(root) === null, 'no baseline yet reads as null');
  const written = writeBaseline(root, payload);
  assertEq(written.templateVersion, '3.0.0', 'writeBaseline returns the written object');
  const raw = JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8'));
  assertEq(raw, written, 'on-disk JSON matches the returned baseline');
  const reread = readBaseline(root);
  assertEq(reread.files['.mcp.json'], sha('{"mcpServers":{}}\n'), 'readBaseline round-trips hashes');

  writeFileSync(join(root, BASELINE_PATH), '{ not json\n');
  assertTrue(readBaseline(root) === null, 'corrupt baseline reads as null, not a crash');
  rmSync(root, { recursive: true, force: true });
}

// 5. the baseline's own path and LIVE_PAIRS default
{
  assertEq(BASELINE_PATH, '.claude/.template-baseline.json', 'baseline lives under .claude/');
  assertEq(LIVE_PAIRS.map((p) => p[0]), ['.claude', '.mcp.json', '.claudeignore'], 'live pairs cover the verbatim roots');
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
