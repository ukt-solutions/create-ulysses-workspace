#!/usr/bin/env node
// Unit tests for template-modifications.mjs
// Run: node template/_claude/scripts/template-modifications.test.mjs
import {
  readTemplateModifications,
  TEMPLATE_MODIFICATIONS_PATH,
  LEGACY_KEYS,
} from './template-modifications.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'template-mods-test-'));
}

function writeRegistry(root, obj) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  const parts = TEMPLATE_MODIFICATIONS_PATH.split('/');
  writeFileSync(join(root, ...parts), JSON.stringify(obj, null, 2) + '\n');
}

function writeWorkspaceJson(root, workspace) {
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace }, null, 2) + '\n');
}

console.log('# template-modifications');

// 1. the new file alone: both fields read, keys normalized to .claude/-relative
//    and sorted, prefix-stripping applied to modifications keys and localFiles
//    entries alike.
{
  const root = makeRoot();
  writeRegistry(root, {
    localFiles: ['skills/custom/**', '.claude/rules/mine.md', '.claude/.claude/deep.md'],
    modifications: {
      'rules/core.md': 'kept our stricter lint gate',
      '.claude/skills/keep/SKILL.md': 'trimmed the flow for our team',
    },
  });

  const mods = readTemplateModifications(root);
  assertEq(mods.localFiles, ['skills/custom/**', 'rules/mine.md', 'deep.md'],
    'localFiles normalized: leading .claude/ prefixes stripped, repeated ones collapsed');
  assertEq(mods.modifications, {
    'rules/core.md': 'kept our stricter lint gate',
    'skills/keep/SKILL.md': 'trimmed the flow for our team',
  }, 'modifications normalized to .claude/-relative keys, sorted');
  assertEq(mods.legacyKeys, [], 'no legacy keys when workspace.json carries none');
  assertEq(mods.parseError, null, 'a well-formed file parses clean');
  rmSync(root, { recursive: true, force: true });
}

// 2. legacy fallback: workspace.json's workspace.localFiles array and the
//    improvised workspace.templateModifications map (with .claude/ prefixes)
//    are read when the file doesn't exist, and legacyKeys names both.
{
  const root = makeRoot();
  writeWorkspaceJson(root, {
    name: 'demo',
    localFiles: ['.claude/skills/custom/**'],
    templateModifications: { '.claude/rules/core.md': 'our lint gate' },
  });

  const mods = readTemplateModifications(root);
  assertEq(mods.localFiles, ['skills/custom/**'], 'legacy localFiles read and normalized');
  assertEq(mods.modifications, { 'rules/core.md': 'our lint gate' }, 'legacy templateModifications read and normalized');
  assertEq(mods.legacyKeys, LEGACY_KEYS, 'both legacy keys reported while still in workspace.json');
  rmSync(root, { recursive: true, force: true });
}

// 3. the file wins per modification path; localFiles union — a half-finished
//    migration never loses an exclusion or hides a reason — and legacyKeys
//    still reports keys awaiting migration.
{
  const root = makeRoot();
  writeWorkspaceJson(root, {
    name: 'demo',
    localFiles: ['skills/custom/**'],
    templateModifications: {
      'rules/core.md': 'old wording',
      'rules/other.md': 'only in legacy',
    },
  });
  writeRegistry(root, {
    localFiles: ['rules/mine.md'],
    modifications: { 'rules/core.md': 'new wording' },
  });

  const mods = readTemplateModifications(root);
  assertEq(mods.localFiles, ['skills/custom/**', 'rules/mine.md'], 'localFiles union across file and legacy');
  assertEq(mods.modifications, {
    'rules/core.md': 'new wording',
    'rules/other.md': 'only in legacy',
  }, 'file wins per path; legacy-only paths survive');
  assertEq(mods.legacyKeys, LEGACY_KEYS, 'legacy keys report until removed from workspace.json');
  rmSync(root, { recursive: true, force: true });
}

// 4. migration round-trip: moving both legacy keys into the file (and
//    removing them from workspace.json) yields the same data with an empty
//    legacyKeys — what /workspace-update's migration step produces.
{
  const root = makeRoot();
  writeWorkspaceJson(root, {
    name: 'demo',
    localFiles: ['skills/custom/**', 'rules/mine.md'],
    templateModifications: { '.claude/rules/core.md': 'our lint gate' },
  });
  const before = readTemplateModifications(root);

  writeRegistry(root, {
    localFiles: before.localFiles,
    modifications: before.modifications,
  });
  writeWorkspaceJson(root, { name: 'demo' });

  const after = readTemplateModifications(root);
  assertEq(after.localFiles, before.localFiles, 'localFiles survive the migration unchanged');
  assertEq(after.modifications, before.modifications, 'modifications survive the migration unchanged');
  assertEq(after.legacyKeys, [], 'after migration no legacy keys report');
  rmSync(root, { recursive: true, force: true });
}

// 5. nothing registered anywhere: empty result, no error — the common
//    fresh-workspace state (the template never ships the file).
{
  const root = makeRoot();
  writeWorkspaceJson(root, { name: 'demo' });
  const mods = readTemplateModifications(root);
  assertEq(mods, { localFiles: [], modifications: {}, ignoredKeys: [], legacyKeys: [], parseError: null },
    'absent file and absent legacy keys read as an empty registry');
  rmSync(root, { recursive: true, force: true });
}

// 6. a file that doesn't parse: parseError carries the message, the content
//    is treated as absent (never guessed at), and legacy data still applies.
{
  const root = makeRoot();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'template-modifications.json'), '{ not json\n');
  writeWorkspaceJson(root, { name: 'demo', localFiles: ['skills/custom/**'] });

  const mods = readTemplateModifications(root);
  assertTrue(mods.parseError !== null && mods.parseError.length > 0, 'a broken file reports parseError');
  assertEq(mods.localFiles, ['skills/custom/**'], 'legacy data still applies when the file is broken');
  assertEq(mods.modifications, {}, 'a broken file contributes no modifications');
  rmSync(root, { recursive: true, force: true });
}

// 7. junk tolerance: non-string entries and reasons, empty strings, and
//    wrong-typed fields are skipped, never thrown on.
{
  const root = makeRoot();
  writeRegistry(root, {
    localFiles: ['skills/ok/**', 42, '', null],
    modifications: {
      'rules/ok.md': 'fine',
      'rules/no-reason.md': '',
      'rules/numbered.md': 7,
      '': 'empty key',
    },
  });
  writeWorkspaceJson(root, {
    name: 'demo',
    localFiles: 'not-an-array',
    templateModifications: ['also', 'wrong'],
  });

  const mods = readTemplateModifications(root);
  assertEq(mods.localFiles, ['skills/ok/**'], 'only usable localFiles entries survive');
  assertEq(mods.modifications, { 'rules/ok.md': 'fine' }, 'only string-reasoned modifications survive');
  assertEq(mods.parseError, null, 'junk fields are skipped, not parse errors');
  rmSync(root, { recursive: true, force: true });
}

// 8. path normalization hardening (gh:194 review): Windows backslashes and
//    leading './' collapse the way '.claude/' prefixes do, keys that
//    normalize away ('.', '.claude/') are dropped, and keys that escape
//    .claude/ ('../CLAUDE.md', absolute paths, drive letters) report in
//    ignoredKeys instead of sitting silently inert — for localFiles entries
//    and modifications keys alike, from the file and the legacy keys.
{
  const root = makeRoot();
  writeWorkspaceJson(root, {
    name: 'demo',
    localFiles: ['../.mcp.json'],
    templateModifications: { '.\\rules\\win.md': 'windows legacy form' },
  });
  writeRegistry(root, {
    localFiles: ['.\\skills\\custom\\**', './rules/mine.md', '.claude/', '.'],
    modifications: {
      '.claude\\rules\\core.md': 'windows form',
      './skills/keep/SKILL.md': 'dot-slash form',
      '.claude/': 'normalizes away',
      '': 'empty key',
      '../CLAUDE.md': 'root file',
      '/etc/hosts': 'absolute',
      'C:/tmp/x.md': 'drive letter',
      '..': 'parent',
    },
  });

  const mods = readTemplateModifications(root);
  assertEq(mods.localFiles, ['skills/custom/**', 'rules/mine.md'],
    'backslashes and leading ./ normalize; entries normalizing away are dropped');
  assertEq(mods.modifications, {
    'rules/core.md': 'windows form',
    'rules/win.md': 'windows legacy form',
    'skills/keep/SKILL.md': 'dot-slash form',
  }, 'modifications keys normalize from every tolerated form');
  assertEq(mods.ignoredKeys, ['..', '../.mcp.json', '../CLAUDE.md', '/etc/hosts', 'C:/tmp/x.md'],
    'keys escaping .claude/ report in ignoredKeys, sorted, from both fields and both sources');
  rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
