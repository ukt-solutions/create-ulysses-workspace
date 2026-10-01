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

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
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
//    workspace root from its own location. The payload carries the sibling
//    script the classifier imports, so copy that alongside it.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'skills', 'new-skill', 'SKILL.md'), '# New\n');
  // The classifier itself sits inside the payload, as the upgrade ships it.
  const nestedScripts = join(payload, '.claude', 'scripts');
  mkdirSync(nestedScripts, { recursive: true });
  writeFileSync(
    join(nestedScripts, 'classify-update.mjs'),
    readFileSync(join(here, 'classify-update.mjs'), 'utf8'),
  );
  writeFileSync(
    join(nestedScripts, 'build-workspace-context.mjs'),
    readFileSync(join(here, 'build-workspace-context.mjs'), 'utf8'),
  );
  mkdirSync(join(payload, '.claude', 'lib'), { recursive: true });
  writeFileSync(
    join(payload, '.claude', 'lib', 'session-frontmatter.mjs'),
    readFileSync(join(here, '..', 'lib', 'session-frontmatter.mjs'), 'utf8'),
  );
  const nestedScript = join(nestedScripts, 'classify-update.mjs');

  const r = spawnSync(
    process.execPath,
    [nestedScript, '--root', root],
    { cwd: tmpdir(), encoding: 'utf-8' },
  );
  assertEq(r.status, 0, `CLI exits 0 from nested location (stderr: ${r.stderr.trim().slice(0, 200)})`);
  const parsed = JSON.parse(r.stdout);
  // The nested copies themselves (classifier plus the sibling it imports) are
  // genuinely new to this workspace.
  assertEq(
    parsed.new,
    [
      '.claude/lib/session-frontmatter.mjs',
      '.claude/scripts/build-workspace-context.mjs',
      '.claude/scripts/classify-update.mjs',
      '.claude/skills/new-skill/SKILL.md',
    ],
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

// 6. activated: a .skip rule whose active twin is installed was deliberately
//    activated — reported as activated, never as new, and the active rule is
//    not removed.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  mkdirSync(join(payload, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(payload, '.claude', 'rules', 'optional.md.skip'), '# Optional\n');
  writeFileSync(join(root, '.claude', 'rules', 'optional.md'), '# Optional, activated\n');
  // A still-skipped rule stays an ordinary new file, not activated.
  writeFileSync(join(payload, '.claude', 'rules', 'dormant.md.skip'), '# Dormant\n');

  const result = classifyUpdate({ root });
  assertEq(
    result.activated,
    [{ skip: '.claude/rules/optional.md.skip', active: '.claude/rules/optional.md' }],
    'activated pairs the payload .skip with the installed active rule',
  );
  assertTrue(!result.new.includes('.claude/rules/optional.md.skip'), 'activated .skip is not new');
  assertTrue(!result.removed.includes('.claude/rules/optional.md'), 'the active rule is not removed');
  assertEq(result.new, ['.claude/rules/dormant.md.skip'], 'a rule the workspace never had stays new');
  rmSync(root, { recursive: true, force: true });
}

// 7. removed: installed files with no payload counterpart, minus what the
//    workspace owns (tests, localFiles, gitignored paths, worktrees).
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// template\n');
  // genuinely removed: the template stopped shipping it
  writeFileSync(join(root, '.claude', 'hooks', 'legacy-hook.mjs'), '// old\n');
  // workspace-owned: a test file, a localFiles path, a localFiles glob, and
  // files inside .claude/worktrees/
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(root, '.claude', 'scripts', 'helper.test.mjs'), '// test\n');
  writeFileSync(join(root, '.claude', 'scripts', 'my-helper.mjs'), '// mine\n');
  mkdirSync(join(root, '.claude', 'skills', 'custom'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'custom', 'SKILL.md'), '# Mine\n');
  mkdirSync(join(root, '.claude', 'worktrees', 'fix-x', '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'worktrees', 'fix-x', '.claude', 'settings.json'), '{}\n');
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({ workspace: { localFiles: ['scripts/my-helper.mjs', 'skills/custom/**'] } }, null, 2) + '\n',
  );

  const result = classifyUpdate({ root });
  assertEq(result.removed, ['.claude/hooks/legacy-hook.mjs'], 'removed lists only unowned missing counterparts');
  rmSync(root, { recursive: true, force: true });
}

// 7b. gitignored files are machine-local, not removed-by-template
{
  const root = setupWorkspace();
  setupPayload(root);
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(root, '.claude', 'scripts', 'scratch.mjs'), '// local\n');
  writeFileSync(join(root, '.gitignore'), '.claude/scripts/scratch.mjs\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'Fixture']);

  const result = classifyUpdate({ root });
  assertEq(result.removed, [], 'gitignored files are never removed');
  rmSync(root, { recursive: true, force: true });
}

// 7c. .mcp.json and .claudeignore are classified roots on both sides
{
  const root = setupWorkspace();
  setupPayload(root);
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{}}\n');

  const result = classifyUpdate({ root });
  assertEq(result.removed, ['.mcp.json'], 'a payload-dropped .mcp.json reads as removed');
  rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
