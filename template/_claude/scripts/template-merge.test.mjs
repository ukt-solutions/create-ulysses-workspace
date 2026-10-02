#!/usr/bin/env node
// Unit tests for template-merge.mjs
// Run: node template/_claude/scripts/template-merge.test.mjs
//
// Three-way merge of `differs` files against the staged template base, all
// in fixture directories — a clean merge, a real conflict, the two noBase
// cases (no staged base; a base the baseline disproves), the untouched
// workspace file, and the --files / --out / CLI surface.
import { mergeTemplateFiles, MERGED_DIR, TEMPLATE_BASE_DIR } from './template-merge.mjs';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

const sha = (s) => createHash('sha256').update(s).digest('hex');

// The payload's files are staged under .template-base/ with the SAME
// relative paths the payload itself installs — baseFor('x') is the payload
// tree's ancestor of 'x'.
const at = (baseDir, rel) => join(baseDir, ...rel.split('/'));

function writeRel(baseDir, rel, content) {
  const p = at(baseDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// ---- fixture: five differs files covering every outcome ----

const CLEAN = '.claude/skills/demo/clean.md';
const CONFLICT = '.claude/skills/demo/conflict.md';
const MISMATCH = '.claude/skills/demo/mismatch.md';
const NO_BASE = '.claude/skills/demo/no-base.md';
const NO_ENTRY = '.claude/skills/demo/no-entry.md';

const cleanBase = 'line1\nline2\nline3\n';
const cleanLocal = 'local top\nline1\nline2\nline3\n';
const cleanTemplate = 'line1\nline2\nline3\ntemplate bottom\n';

const conflictBase = 'a\nb\nc\n';
const conflictLocal = 'a\nb local\nc\n';
const conflictTemplate = 'a\nb template\nc\n';

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'template-merge-test-'));
  const payload = join(root, '.workspace-update');
  const base = join(payload, TEMPLATE_BASE_DIR);

  writeRel(root, CLEAN, cleanLocal);
  writeRel(payload, CLEAN, cleanTemplate);
  writeRel(base, CLEAN, cleanBase);

  writeRel(root, CONFLICT, conflictLocal);
  writeRel(payload, CONFLICT, conflictTemplate);
  writeRel(base, CONFLICT, conflictBase);

  // Baseline disproves the staged base: its entry is not the base's hash.
  writeRel(root, MISMATCH, 'mismatch local\n');
  writeRel(payload, MISMATCH, 'mismatch template\n');
  writeRel(base, MISMATCH, 'stale base\n');

  // Base never staged at all.
  writeRel(root, NO_BASE, 'mine without a base\n');
  writeRel(payload, NO_BASE, 'template without a base\n');

  // No baseline entry for the path: the staged base is used as-is.
  writeRel(root, NO_ENTRY, 'local x\nx\ny\n');
  writeRel(payload, NO_ENTRY, 'x\ny\ntemplate z\n');
  writeRel(base, NO_ENTRY, 'x\ny\n');

  writeRel(root, '.claude/.template-baseline.json', JSON.stringify({
    templateVersion: '0.22.0',
    files: {
      [CLEAN]: sha(cleanBase),
      [CONFLICT]: sha(conflictBase),
      [MISMATCH]: sha('tampered\n'),
      [NO_BASE]: sha('base content never staged\n'),
    },
  }, null, 2) + '\n');
  return { root, payload, base };
}

console.log('# template-merge');

// 1. The five outcomes in one payload: clean merges land in `merged`, a real
//    conflict in `conflicted` with its count, a base the baseline disproves
//    and a never-staged base both report noBase, and a path without a
//    baseline entry still merges against its staged base.
{
  const { root, payload } = buildFixture();
  try {
    const before = Object.fromEntries(
      [CLEAN, CONFLICT, MISMATCH, NO_BASE, NO_ENTRY].map(
        (rel) => [rel, readFileSync(at(root, rel), 'utf8')],
      ),
    );
    const result = mergeTemplateFiles({ root });

    assertEq(result.merged.map((e) => e.path), [CLEAN, NO_ENTRY], 'clean merges listed, sorted');
    assertTrue(result.merged.every((e) => e.conflicts === 0), 'clean merges carry conflicts: 0');
    assertEq(result.conflicted.map((e) => e.path), [CONFLICT], 'conflicted lists the conflicting file');
    assertEq(result.conflicted[0].conflicts, 1, 'conflict count comes from git merge-file');
    assertEq(result.noBase, [MISMATCH, NO_BASE], 'noBase lists hash-mismatched and never-staged bases');
    assertEq(result.errors, [], 'no errors on a well-formed payload');

    // Default output dir mirrors paths inside the payload, never the workspace.
    assertEq(result.out, join(payload, MERGED_DIR), 'output defaults to <payload>/.merged');
    assertEq(result.templateBase, join(payload, TEMPLATE_BASE_DIR), 'templateBase names the staged base');
    const cleanOut = at(join(payload, MERGED_DIR), CLEAN);
    assertEq(result.merged[0].out, cleanOut, 'merged entries carry the output path');
    assertEq(
      readFileSync(cleanOut, 'utf8'),
      'local top\nline1\nline2\nline3\ntemplate bottom\n',
      'clean merge keeps both sides',
    );
    const conflictOut = at(join(payload, MERGED_DIR), CONFLICT);
    const conflictedText = readFileSync(conflictOut, 'utf8');
    assertTrue(conflictedText.includes('<<<<<<< local'), 'conflict output marks the local side');
    assertTrue(conflictedText.includes('>>>>>>> template'), 'conflict output marks the template side');

    // The workspace files are untouched — merged text never lands there.
    for (const [rel, content] of Object.entries(before)) {
      assertEq(readFileSync(at(root, rel), 'utf8'), content, `workspace file untouched: ${rel}`);
    }
    assertTrue(!existsSync(join(root, MERGED_DIR)), 'no .merged dir inside the workspace tree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 2. No .template-base/ at all (the CLI could not fetch the installed
//    version): every differs file reports noBase, nothing merges, and
//    templateBase is null.
{
  const root = mkdtempSync(join(tmpdir(), 'template-merge-nobase-'));
  const payload = join(root, '.workspace-update');
  try {
    writeRel(root, CLEAN, cleanLocal);
    writeRel(payload, CLEAN, cleanTemplate);
    // No baseline file: classification is two-way, which still files the
    // pair as differs.
    const result = mergeTemplateFiles({ root });
    assertEq(result.merged, [], 'nothing merged without a base');
    assertEq(result.conflicted, [], 'nothing conflicted without a base');
    assertEq(result.noBase, [CLEAN], 'every differs file reports noBase');
    assertEq(result.templateBase, null, 'templateBase is null when none was staged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 3. --files selects a subset; a path outside the differs list is an error,
//    not a merge attempt.
{
  const { root } = buildFixture();
  try {
    const result = mergeTemplateFiles({ root, files: `${CONFLICT},.claude/skills/kept/SKILL.md` });
    assertEq(result.conflicted.map((e) => e.path), [CONFLICT], 'only the requested differs file merges');
    assertEq(result.merged, [], 'other files left aside');
    assertEq(result.noBase, [], 'unselected files do not report noBase');
    assertEq(
      result.errors,
      [{ path: '.claude/skills/kept/SKILL.md', message: 'not classified as differs — only differs files can be merged' }],
      'a non-differs path lands in errors with the reason',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 4. --out redirects the merged text; the payload's .merged/ stays absent.
{
  const { root, payload } = buildFixture();
  try {
    const custom = join(root, 'custom-merged');
    const result = mergeTemplateFiles({ root, out: custom, files: CLEAN });
    assertEq(result.out, custom, 'out reflects --out');
    assertEq(
      readFileSync(at(custom, CLEAN), 'utf8'),
      'local top\nline1\nline2\nline3\ntemplate bottom\n',
      'merged text lands in the custom dir',
    );
    assertTrue(!existsSync(join(payload, MERGED_DIR)), 'default .merged dir not created under --out');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 5. A missing payload is an error naming the path.
{
  const root = mkdtempSync(join(tmpdir(), 'template-merge-nopayload-'));
  try {
    let threw = null;
    try {
      mergeTemplateFiles({ root });
    } catch (e) {
      threw = e;
    }
    assertTrue(threw !== null, 'missing payload throws');
    assertTrue(threw.message.includes('.workspace-update'), 'error names the payload path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 6. CLI: --root/--payload print the same JSON and write the same files;
//    an unknown argument exits 1 with the script name on stderr.
{
  const { root, payload } = buildFixture();
  try {
    const run = spawnSync(process.execPath, [
      join(here, 'template-merge.mjs'), '--root', root, '--payload', payload,
    ], { encoding: 'utf8' });
    assertEq(run.status, 0, 'CLI exits 0 on a good payload');
    const parsed = JSON.parse(run.stdout);
    assertEq(parsed.merged.map((e) => e.path), [CLEAN, NO_ENTRY], 'CLI reports the same clean merges');
    assertTrue(
      existsSync(at(join(payload, MERGED_DIR), CLEAN)),
      'CLI writes the merged file',
    );

    const bad = spawnSync(process.execPath, [
      join(here, 'template-merge.mjs'), '--root', root, '--nonsense',
    ], { encoding: 'utf8' });
    assertEq(bad.status, 1, 'unknown argument exits 1');
    assertTrue(bad.stderr.includes('template-merge:'), 'error output names the script');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 7. Non-UTF-8 bytes survive a clean merge: the merged output holds the
//    exact latin1 byte (0xe9), not its UTF-8 replacement (U+FFFD).
{
  const root = mkdtempSync(join(tmpdir(), 'template-merge-latin1-'));
  const payload = join(root, '.workspace-update');
  const base = join(payload, TEMPLATE_BASE_DIR);
  const rel = '.claude/skills/demo/latin1.md';
  const baseBytes = Buffer.from('line caf\xe9\nmiddle\nline3\n', 'latin1');
  try {
    writeRel(root, rel, Buffer.from('// local caf\xe9 top\nline caf\xe9\nmiddle\nline3\n', 'latin1'));
    writeRel(payload, rel, Buffer.from('line caf\xe9\nmiddle\nline3\n// template tail\n', 'latin1'));
    writeRel(base, rel, baseBytes);
    writeRel(root, '.claude/.template-baseline.json', JSON.stringify({
      templateVersion: '0.22.0',
      files: { [rel]: sha(baseBytes) },
    }, null, 2) + '\n');

    const result = mergeTemplateFiles({ root });
    assertEq(result.merged.map((e) => e.path), [rel], 'non-UTF-8 file merges cleanly');
    const merged = readFileSync(at(join(payload, MERGED_DIR), rel));
    assertTrue(merged.equals(
      Buffer.from('// local caf\xe9 top\nline caf\xe9\nmiddle\nline3\n// template tail\n', 'latin1'),
    ), 'merged output keeps the exact latin1 bytes');
    assertTrue(merged.includes(0xe9), 'the 0xe9 byte is preserved');
    assertTrue(!merged.includes(Buffer.from([0xef, 0xbf, 0xbd])), 'no U+FFFD replacement bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 8. A CRLF working copy against LF base/template would conflict on every
//    line under byte-exact merge: the merge runs on LF-folded copies and
//    the result comes back in the local CRLF style, both edits applied.
{
  const root = mkdtempSync(join(tmpdir(), 'template-merge-crlf-'));
  const payload = join(root, '.workspace-update');
  const base = join(payload, TEMPLATE_BASE_DIR);
  const rel = '.claude/skills/demo/crlf.md';
  const baseText = 'line1\nline2\nline3\n';
  try {
    writeRel(root, rel, Buffer.from('local edit\r\nline2\r\nline3\r\n'));
    writeRel(payload, rel, 'line1\nline2\nline3 template\n');
    writeRel(base, rel, baseText);
    writeRel(root, '.claude/.template-baseline.json', JSON.stringify({
      templateVersion: '0.22.0',
      files: { [rel]: sha(baseText) },
    }, null, 2) + '\n');

    const result = mergeTemplateFiles({ root });
    assertEq(result.merged.map((e) => e.path), [rel], 'CRLF local merges cleanly against LF inputs');
    assertEq(result.merged[0].conflicts, 0, 'line-ending difference alone raises no conflict');
    const merged = readFileSync(at(join(payload, MERGED_DIR), rel), 'utf8');
    assertEq(merged, 'local edit\r\nline2\r\nline3 template\r\n', 'both edits present, CRLF style restored');
    // The folded copies were temp files: nothing landed inside the payload
    // besides .merged/, and the workspace file keeps its CRLF bytes.
    assertEq(readFileSync(at(root, rel), 'utf8'), 'local edit\r\nline2\r\nline3\r\n', 'workspace file untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
