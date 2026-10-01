#!/usr/bin/env node
// Unit tests for classify-update.mjs
// Run: node template/_claude/scripts/classify-update.test.mjs
import { classifyUpdate } from './classify-update.mjs';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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

function setupWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'classify-test-'));
  mkdirSync(join(root, '.claude', 'skills', 'kept'), { recursive: true });
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  return root;
}

function setupPayload(root) {
  const payload = join(root, '.workspace-update');
  mkdirSync(join(payload, '.claude', 'skills', 'new-skill'), { recursive: true });
  mkdirSync(join(payload, '.claude', 'skills', 'kept'), { recursive: true });
  mkdirSync(join(payload, '.claude', 'hooks'), { recursive: true });
  return payload;
}

console.log('# classify-update');

// 1. new / identical / differs across .claude, .mcp.json, .claudeignore
{
  const root = setupWorkspace();
  const payload = setupPayload(root);

  // new: no installed counterpart
  writeFileSync(join(payload, '.claude', 'skills', 'new-skill', 'SKILL.md'), '# New\n');
  // identical: installed file matches the payload byte-for-byte
  writeFileSync(join(payload, '.claude', 'skills', 'kept', 'SKILL.md'), '# Same\n');
  writeFileSync(join(root, '.claude', 'skills', 'kept', 'SKILL.md'), '# Same\n');
  // differs: installed file was locally modified
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// locally modified\n');
  // .mcp.json new, .claudeignore identical
  writeFileSync(join(payload, '.mcp.json'), '{"mcpServers":{}}\n');
  writeFileSync(join(payload, '.claudeignore'), 'scratch/\n');
  writeFileSync(join(root, '.claudeignore'), 'scratch/\n');

  const result = classifyUpdate({ root });
  assertEq(result.new, ['.claude/skills/new-skill/SKILL.md', '.mcp.json'], 'new lists uninstalled files, sorted');
  assertEq(result.identical, ['.claude/skills/kept/SKILL.md', '.claudeignore'], 'identical lists byte-equal files, sorted');
  assertEq(result.differs, ['.claude/hooks/session-start.mjs'], 'differs lists locally modified files');
  rmSync(root, { recursive: true, force: true });
}

// 2. templates, _gitignore, and the manifest are excluded — they install
//    with substitution or merge, so byte comparison would misclassify them.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.manifest.json'), '{"action":"upgrade"}\n');
  writeFileSync(join(payload, '_gitignore'), 'repos\n');
  writeFileSync(join(payload, 'CLAUDE.md.tmpl'), '## Workspace: {{project-name}}\n');
  writeFileSync(join(payload, 'workspace.json.tmpl'), '{"workspace":{}}\n');
  // Even when a .tmpl counterpart exists installed-side, it must not be classified.
  writeFileSync(join(root, 'CLAUDE.md'), '## Workspace: my-workspace\n');

  const result = classifyUpdate({ root });
  assertEq(result.new, [], 'no template or metadata file classified as new');
  assertEq(result.identical, [], 'nothing identical');
  assertEq(result.differs, [], 'nothing differs');
  rmSync(root, { recursive: true, force: true });
}

// 3. missing payload → throws with the payload path named
{
  const root = setupWorkspace();
  let threw = null;
  try {
    classifyUpdate({ root });
  } catch (e) {
    threw = e;
  }
  assertTrue(threw !== null, 'missing payload throws');
  assertTrue(threw.message.includes('.workspace-update'), 'error names the payload path');
  rmSync(root, { recursive: true, force: true });
}

// 4. CLI from a payload-like nested location honors --root and defaults the
//    payload to <root>/.workspace-update. The script must never derive the
//    workspace root from its own location.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'skills', 'new-skill', 'SKILL.md'), '# New\n');
  // The classifier itself sits inside the payload, as the upgrade ships it.
  const nestedScripts = join(payload, '.claude', 'scripts');
  mkdirSync(nestedScripts, { recursive: true });
  const nestedScript = join(nestedScripts, 'classify-update.mjs');
  writeFileSync(nestedScript, readFileSync(join(here, 'classify-update.mjs'), 'utf8'));

  const r = spawnSync(
    process.execPath,
    [nestedScript, '--root', root],
    { cwd: tmpdir(), encoding: 'utf-8' },
  );
  assertEq(r.status, 0, `CLI exits 0 from nested location (stderr: ${r.stderr.trim().slice(0, 200)})`);
  const parsed = JSON.parse(r.stdout);
  // The nested script copy itself is genuinely new to this workspace.
  assertEq(
    parsed.new,
    ['.claude/scripts/classify-update.mjs', '.claude/skills/new-skill/SKILL.md'],
    'CLI classifies the --root workspace',
  );
  rmSync(root, { recursive: true, force: true });
}

// 5. CLI with --payload pointing elsewhere classifies that payload
{
  const root = setupWorkspace();
  const elsewhere = mkdtempSync(join(tmpdir(), 'classify-payload-'));
  mkdirSync(join(elsewhere, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(elsewhere, '.claude', 'scripts', 'helper.mjs'), '// x\n');

  const r = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', root, '--payload', elsewhere],
    { cwd: tmpdir(), encoding: 'utf-8' },
  );
  assertEq(r.status, 0, 'CLI exits 0 with explicit --payload');
  const parsed = JSON.parse(r.stdout);
  assertEq(parsed.new, ['.claude/scripts/helper.mjs'], 'explicit payload classified');
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
