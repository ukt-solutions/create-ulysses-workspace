#!/usr/bin/env node
// Unit tests for classify-update.mjs
// Run: node template/_claude/scripts/classify-update.test.mjs
import { classifyUpdate, mergeClaudeMd } from './classify-update.mjs';
import { createHash } from 'node:crypto';
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
  // .claudeignore identical; .mcp.json routes to `config` (test 12), not `new`
  writeFileSync(join(payload, '.mcp.json'), '{"mcpServers":{}}\n');
  writeFileSync(join(payload, '.claudeignore'), 'scratch/\n');
  writeFileSync(join(root, '.claudeignore'), 'scratch/\n');

  const result = classifyUpdate({ root });
  assertEq(result.new, ['.claude/skills/new-skill/SKILL.md'], 'new lists uninstalled files, sorted');
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
  writeFileSync(
    join(nestedScripts, 'template-baseline.mjs'),
    readFileSync(join(here, 'template-baseline.mjs'), 'utf8'),
  );
  writeFileSync(
    join(nestedScripts, 'template-modifications.mjs'),
    readFileSync(join(here, 'template-modifications.mjs'), 'utf8'),
  );
  mkdirSync(join(payload, '.claude', 'lib'), { recursive: true });
  for (const f of ['session-frontmatter.mjs', 'registry-check.mjs', 'require-node.mjs']) {
    writeFileSync(
      join(payload, '.claude', 'lib', f),
      readFileSync(join(here, '..', 'lib', f), 'utf8'),
    );
  }
  const nestedScript = join(nestedScripts, 'classify-update.mjs');

  const r = spawnSync(
    process.execPath,
    [nestedScript, '--root', root],
    { cwd: tmpdir(), encoding: 'utf-8' },
  );
  assertEq(r.status, 0, `CLI exits 0 from nested location (stderr: ${r.stderr.trim().slice(0, 200)})`);
  const parsed = JSON.parse(r.stdout);
  // The nested copies themselves (classifier plus the siblings it imports) are
  // genuinely new to this workspace.
  assertEq(
    parsed.new,
    [
      '.claude/lib/registry-check.mjs',
      '.claude/lib/require-node.mjs',
      '.claude/lib/session-frontmatter.mjs',
      '.claude/scripts/build-workspace-context.mjs',
      '.claude/scripts/classify-update.mjs',
      '.claude/scripts/template-baseline.mjs',
      '.claude/scripts/template-modifications.mjs',
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

// 7c. a payload-dropped config file is the workspace's to keep: .mcp.json
//     and .claude/settings.json hold user content (its MCP servers), so the
//     template stopping shipping one never reads as a removal.
{
  const root = setupWorkspace();
  setupPayload(root);
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{"mine":{"command":"npx"}}}\n');

  const result = classifyUpdate({ root });
  assertEq(result.removed, [], 'a payload-dropped .mcp.json is never removed');
  assertEq(result.config, [], 'a payload-dropped .mcp.json carries no config entry');
  rmSync(root, { recursive: true, force: true });
}

// 7d. removed-entry markers (gh:190): a removed hook that a workspace-only
//     settings.json entry still registers is linked to the config-diff paths
//     (so the skill removes the pair, never leaves the entry dangling), and
//     a removed file the baseline never recorded is the workspace's own —
//     userOwned, offered a workspace.localFiles entry instead of deletion.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  // a real template removal: baseline records it, payload dropped it
  writeFileSync(join(root, '.claude', 'hooks', 'old-hook.mjs'), '// template v1\n');
  // a removed hook the workspace's settings.json still registers — once via
  // a workspace-only event key, once via a workspace-only element of an
  // event both sides carry
  writeFileSync(join(root, '.claude', 'hooks', 'worktree-create.mjs'), '// template v1\n');
  writeFileSync(join(payload, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node .claude/hooks/guard.mjs' }] }],
    },
  }) + '\n');
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      WorktreeCreate: [{ type: 'command', command: 'node .claude/hooks/worktree-create.mjs' }],
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'node .claude/hooks/guard.mjs' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/worktree-create.mjs' }] },
      ],
    },
  }) + '\n');
  // the workspace's own skill: no baseline entry, no payload counterpart
  mkdirSync(join(root, '.claude', 'skills', 'custom'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'custom', 'SKILL.md'), '# Mine\n');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.20.0',
    files: {
      '.claude/hooks/old-hook.mjs': sha('// template v1\n'),
      '.claude/hooks/worktree-create.mjs': sha('// template v1\n'),
    },
  }) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.removed, [
    '.claude/hooks/old-hook.mjs',
    { file: '.claude/hooks/worktree-create.mjs', referencedBy: ['settings.json hooks.PreToolUse', 'settings.json hooks.WorktreeCreate'] },
    { file: '.claude/skills/custom/SKILL.md', userOwned: true },
  ], 'removed hooks link their settings references; unrecorded files are userOwned; recorded ones stay plain');
  rmSync(root, { recursive: true, force: true });
}

// 7e. without a baseline nothing can be inferred: every removal stays a
//     plain path, never a userOwned claim (test 7's case, made explicit).
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  mkdirSync(join(root, '.claude', 'skills', 'custom'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'custom', 'SKILL.md'), '# Mine\n');
  writeFileSync(join(payload, '.claude', 'settings.json'), '{"hooks":{}}\n');
  writeFileSync(join(root, '.claude', 'settings.json'), '{"hooks":{}}\n');

  const result = classifyUpdate({ root });
  assertEq(result.removed, ['.claude/skills/custom/SKILL.md'], 'no baseline means plain removals, no userOwned markers');
  rmSync(root, { recursive: true, force: true });
}

// 7f. an activated optional rule is template-shipped even though its baseline
//     entry is the .skip twin: when the payload drops the rule entirely, the
//     removal stays plain — never a userOwned/localFiles suggestion (gh:190).
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  // activated here, optional in the template this workspace came from
  writeFileSync(join(root, '.claude', 'rules', 'optional.md'), '# Activated\n');
  // contrast: a rule with no baseline entry at all is the workspace's own
  writeFileSync(join(root, '.claude', 'rules', 'mine.md'), '# Mine\n');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.20.0',
    files: { '.claude/rules/optional.md.skip': sha('# Optional\n') },
  }) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.removed, [
    { file: '.claude/rules/mine.md', userOwned: true },
    '.claude/rules/optional.md',
  ], 'the .skip baseline twin proves the template shipped an activated rule; unrecorded files stay userOwned');
  rmSync(root, { recursive: true, force: true });
}

// 8. three-way classification with a baseline: a file the template changed
//    that the user never touched is `updated`, a real local edit is `differs`.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  // untouched-then-template-changed → updated: workspace holds the baseline
  // bytes, the payload ships new ones
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v2\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// template v1\n');
  // locally edited → differs: workspace matches neither baseline nor payload
  mkdirSync(join(payload, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(payload, '.claude', 'rules', 'core.md'), 'core v2\n');
  writeFileSync(join(root, '.claude', 'rules', 'core.md'), 'my local take\n');
  // already applied by hand → identical even though it differs from baseline
  writeFileSync(join(payload, '.claudeignore'), 'scratch/ v2\n');
  writeFileSync(join(root, '.claudeignore'), 'scratch/ v2\n');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.20.0',
    files: {
      '.claude/hooks/session-start.mjs': sha('// template v1\n'),
      '.claude/rules/core.md': sha('core v1\n'),
      '.claudeignore': sha('scratch/ v1\n'),
    },
  }) + '\n');

  const result = classifyUpdate({ root });
  assertTrue(result.hasBaseline, 'hasBaseline true when the baseline exists');
  assertEq(result.updated, ['.claude/hooks/session-start.mjs'], 'workspace==baseline≠payload classifies as updated');
  assertEq(result.differs, ['.claude/rules/core.md'], 'workspace≠baseline≠payload classifies as differs');
  assertEq(result.identical, ['.claudeignore'], 'workspace==payload classifies as identical regardless of baseline');
  assertTrue(!result.removed.includes('.claude/.template-baseline.json'), 'the baseline itself is never a removal');
  rmSync(root, { recursive: true, force: true });
}

// 8b. no baseline (pre-v0.21 workspace): template changes land in differs —
//     the old two-way behavior — and hasBaseline is false so the skill can say
//     the first update asks per file.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v2\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// template v1\n');

  const result = classifyUpdate({ root });
  assertTrue(!result.hasBaseline, 'hasBaseline false without a baseline');
  assertEq(result.updated, [], 'nothing classifies as updated without a baseline');
  assertEq(result.differs, ['.claude/hooks/session-start.mjs'], 'template change falls back to differs');
  rmSync(root, { recursive: true, force: true });
}

// 8d. localOnly: the workspace holds a local edit to a file the template did
//     NOT change since the baseline (payload == baseline ≠ workspace). Listed
//     for information only — never differs, never asked about, never applied.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  // locally edited, template unchanged: payload and baseline agree
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v1\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// my take\n');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.21.0',
    files: { '.claude/hooks/session-start.mjs': sha('// template v1\n') },
  }) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.localOnly, ['.claude/hooks/session-start.mjs'], 'local edit on an unchanged template file is localOnly');
  assertEq(result.differs, [], 'localOnly files are never differs');
  assertEq(result.updated, [], 'localOnly files are never updated');
  rmSync(root, { recursive: true, force: true });
}

// 8e. deletedLocally: the baseline records a file, the payload still ships it,
//     but it is missing from the workspace — deleted locally (or never
//     installed). Reported for a restore offer, not batch-installed as new.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v2\n');
  // a genuinely new file for contrast: payload ships it, baseline never did
  writeFileSync(join(payload, '.claude', 'skills', 'new-skill', 'SKILL.md'), '# New\n');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.20.0',
    files: { '.claude/hooks/session-start.mjs': sha('// template v1\n') },
  }) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.deletedLocally, ['.claude/hooks/session-start.mjs'], 'baseline-recorded missing file is deletedLocally');
  assertTrue(!result.new.includes('.claude/hooks/session-start.mjs'), 'deletedLocally files are never new');
  assertEq(result.new, ['.claude/skills/new-skill/SKILL.md'], 'a file the baseline never recorded stays new');
  rmSync(root, { recursive: true, force: true });
}

// 8h. modification reasons (gh:194): a path registered in
//     .claude/template-modifications.json's `modifications` map carries its
//     reason on every list where a local divergence is visible — differs,
//     localOnly, deletedLocally, and removed — while unregistered paths stay
//     plain strings, and the registry file itself is never offered as a
//     removal (workspace-owned, the template never ships it).
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  // differs: a registered local edit meeting a template change
  mkdirSync(join(payload, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(payload, '.claude', 'rules', 'core.md'), 'core v2\n');
  writeFileSync(join(root, '.claude', 'rules', 'core.md'), 'my local take\n');
  // an unregistered differs file for contrast
  writeFileSync(join(payload, '.claude', 'rules', 'other.md'), 'other v2\n');
  writeFileSync(join(root, '.claude', 'rules', 'other.md'), 'other local\n');
  // localOnly: a registered local edit on a file the template didn't touch
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v1\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// my take\n');
  // deletedLocally: baseline records it, payload ships it, workspace lacks it
  writeFileSync(join(payload, '.claude', 'rules', 'missing.md'), 'missing v2\n');
  // removed: baseline records it, payload dropped it, workspace keeps it
  mkdirSync(join(root, '.claude', 'skills', 'gone'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'gone', 'SKILL.md'), '# Gone\n');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.22.0',
    files: {
      '.claude/rules/core.md': sha('core v1\n'),
      '.claude/rules/other.md': sha('other v1\n'),
      '.claude/hooks/session-start.mjs': sha('// template v1\n'),
      '.claude/rules/missing.md': sha('missing v1\n'),
      '.claude/skills/gone/SKILL.md': sha('# Gone\n'),
    },
  }) + '\n');
  writeFileSync(join(root, '.claude', 'template-modifications.json'), JSON.stringify({
    localFiles: [],
    modifications: {
      'rules/core.md': 'kept our stricter lint gate',
      'hooks/session-start.mjs': 'local hook tweak',
      'rules/missing.md': 'removed on purpose',
      'skills/gone/SKILL.md': 'kept for the legacy flow',
    },
  }, null, 2) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.differs, [
    { file: '.claude/rules/core.md', reason: 'kept our stricter lint gate' },
    '.claude/rules/other.md',
  ], 'a registered differs entry carries its reason; unregistered ones stay plain');
  assertEq(result.localOnly,
    [{ file: '.claude/hooks/session-start.mjs', reason: 'local hook tweak' }],
    'a registered localOnly entry carries its reason');
  assertEq(result.deletedLocally,
    [{ file: '.claude/rules/missing.md', reason: 'removed on purpose' }],
    'a registered deletedLocally entry carries its reason');
  assertEq(result.removed,
    [{ file: '.claude/skills/gone/SKILL.md', reason: 'kept for the legacy flow' }],
    'a registered removed entry carries its reason');
  assertTrue(!result.removed.some((e) => (typeof e === 'string' ? e : e.file) === '.claude/template-modifications.json'),
    'the registry file itself is never a removal');
  assertEq(result.legacyKeys, [], 'no legacy keys when workspace.json carries none');
  rmSync(root, { recursive: true, force: true });
}

// 8h-b. a reason rides on a userOwned removed entry too, alongside its
//       existing marker fields (gh:194).
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  mkdirSync(join(root, '.claude', 'skills', 'custom'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'custom', 'SKILL.md'), '# Mine\n');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.22.0',
    files: {},
  }) + '\n');
  writeFileSync(join(root, '.claude', 'template-modifications.json'), JSON.stringify({
    modifications: { 'skills/custom/SKILL.md': 'our team-specific skill' },
  }, null, 2) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.removed,
    [{ file: '.claude/skills/custom/SKILL.md', userOwned: true, reason: 'our team-specific skill' }],
    'a userOwned removal keeps its marker and gains the reason');
  rmSync(root, { recursive: true, force: true });
}

// 8i. staleModifications (gh:194): a registration whose installed file now
//     equals the payload — the workspace already took the template's version
//     — is offered for dropping. A registration whose file still differs, or
//     whose file is absent (a deliberate deletion, explained via
//     deletedLocally), is live and never reports.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  mkdirSync(join(payload, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  // took the template's version already: installed == payload
  writeFileSync(join(payload, '.claude', 'rules', 'same.md'), 'v2\n');
  writeFileSync(join(root, '.claude', 'rules', 'same.md'), 'v2\n');
  // still locally edited: differs from the payload
  writeFileSync(join(payload, '.claude', 'rules', 'kept.md'), 'v2\n');
  writeFileSync(join(root, '.claude', 'rules', 'kept.md'), 'ours\n');
  // deleted deliberately: installed missing, payload ships it
  writeFileSync(join(payload, '.claude', 'rules', 'absent.md'), 'v2\n');
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.22.0',
    files: {
      '.claude/rules/same.md': sha('v1\n'),
      '.claude/rules/kept.md': sha('v1\n'),
      '.claude/rules/absent.md': sha('v1\n'),
    },
  }) + '\n');
  writeFileSync(join(root, '.claude', 'template-modifications.json'), JSON.stringify({
    modifications: {
      'rules/same.md': 'took the template back',
      'rules/kept.md': 'still ours',
      'rules/absent.md': 'deleted deliberately',
    },
  }, null, 2) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.staleModifications,
    [{ file: '.claude/rules/same.md', reason: 'took the template back' }],
    'only the registration matching the payload reports stale');
  assertEq(result.deletedLocally,
    [{ file: '.claude/rules/absent.md', reason: 'deleted deliberately' }],
    'an absent registered file is a live deletion decision, not stale');
  assertTrue(!result.staleModifications.some((e) => e.file === '.claude/rules/kept.md'),
    'a still-edited registration is not stale');
  rmSync(root, { recursive: true, force: true });
}

// 8i-b. non-file and escaped registry keys (gh:194 review): a key naming a
//       directory — present as a directory on BOTH sides — or one that
//       normalizes away ('.claude/') must not crash the stale check (only
//       regular files compare), and a key escaping .claude/ passes through
//       as ignoredKeys for the operator to fix.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  // .claude/scripts exists as a directory on both sides
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  mkdirSync(join(payload, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(root, '.claude', 'template-modifications.json'), JSON.stringify({
    modifications: {
      scripts: 'a directory key',
      '.claude/': 'normalizes away',
      '../CLAUDE.md': 'a root file the registry does not cover',
    },
  }, null, 2) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.staleModifications, [],
    'directory keys and keys normalizing away never report stale — and never crash');
  assertEq(result.ignoredKeys, ['../CLAUDE.md'],
    'a key escaping .claude/ passes through as ignoredKeys');
  rmSync(root, { recursive: true, force: true });
}

// 8j. registry localFiles exclude removals (gh:194), the legacy
//     workspace.json array still works and reports legacyKeys, and a broken
//     registry surfaces modificationsError without inventing reasons.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  mkdirSync(join(root, '.claude', 'skills', 'custom'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'custom', 'SKILL.md'), '# Mine\n');
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v2\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// my take\n');
  writeFileSync(join(root, '.claude', 'template-modifications.json'), JSON.stringify({
    localFiles: ['skills/custom/**'],
  }, null, 2) + '\n');

  let result = classifyUpdate({ root });
  assertEq(result.removed, [], 'a registry localFiles glob excludes the file from removal');
  assertEq(result.legacyKeys, [], 'no registry file means no legacyKeys either way');
  assertEq(result.modificationsError, undefined, 'no modificationsError on a clean registry');

  // legacy fallback: the same exclusion from workspace.json, with legacyKeys
  // naming what /workspace-update offers to migrate
  rmSync(join(root, '.claude', 'template-modifications.json'));
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({ workspace: { localFiles: ['skills/custom/**'] } }, null, 2) + '\n',
  );
  result = classifyUpdate({ root });
  assertEq(result.removed, [], 'the legacy workspace.json localFiles array still excludes');
  assertEq(result.legacyKeys, ['localFiles'], 'legacyKeys names the unmigrated workspace.json key');

  // a broken registry: the error surfaces, reasons/exclusions from the file
  // are unavailable, content decisions stay plain — never guessed at — and
  // every removal fails closed as unverifiable: the file's ownership claims
  // cannot be read, so nothing is offered as a plain removal
  mkdirSync(join(root, '.claude', 'skills', 'claimed'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'claimed', 'SKILL.md'), '# Claimed by the broken registry\n');
  writeFileSync(join(root, '.claude', 'template-modifications.json'), '{ not json\n');
  result = classifyUpdate({ root });
  assertTrue(typeof result.modificationsError === 'string' && result.modificationsError.length > 0,
    'a broken registry reports modificationsError');
  assertEq(result.differs, ['.claude/hooks/session-start.mjs'], 'a broken registry attaches no reasons');
  assertEq(result.removed, [{ file: '.claude/skills/claimed/SKILL.md', unverifiable: true }],
    'a file only the broken registry could claim is never offered as a plain removal');
  rmSync(root, { recursive: true, force: true });
}

// 8f. CRLF: an autocrlf checkout stores CRLF where the payload ships LF. All
//     sides hash with CRLF normalized, so the file classifies as identical —
//     not as locally modified on every update.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template\n// v2\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// template\r\n// v2\r\n');

  const result = classifyUpdate({ root });
  assertEq(result.identical, ['.claude/hooks/session-start.mjs'], 'a CRLF checkout of an LF payload classifies as identical');
  assertEq(result.differs, [], 'line endings alone never read as local edits');
  assertEq(result.localOnly, [], 'line endings alone never read as local-only edits either');
  rmSync(root, { recursive: true, force: true });
}

// 8g. a declined `updated` batch stays `updated`: writing the baseline keeps
//     the OLD entry when the workspace still holds the baseline content and
//     the payload ships something new, so the change is offered again next
//     update instead of being filed away.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v2\n');
  // the user declined the update: the workspace keeps the baseline content
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// template v1\n');
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.20.0',
    files: { '.claude/hooks/session-start.mjs': sha('// template v1\n') },
  }) + '\n');

  const before = classifyUpdate({ root });
  assertEq(before.updated, ['.claude/hooks/session-start.mjs'], 'the change presents as updated before the baseline rewrite');

  const r = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', root, '--payload', payload, '--write-baseline'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r.status, 0, `--write-baseline exits 0 (stderr: ${r.stderr.trim().slice(0, 200)})`);

  const after = classifyUpdate({ root });
  assertEq(after.updated, ['.claude/hooks/session-start.mjs'], 'an unapplied update still presents as updated after the baseline rewrite');
  assertEq(after.differs, [], 'an unapplied update never demotes to differs');
  assertEq(after.localOnly, [], 'an unapplied update never demotes to localOnly');
  rmSync(root, { recursive: true, force: true });
}

// 12. config: .mcp.json and .claude/settings.json are never classified by
//     content — never new/updated/differs/identical, whatever the baseline
//     says — and carry a nested key-level diff instead, so the skill merges
//     key by key instead of copying wholesale and wiping the workspace's
//     own MCP servers (gh:186).
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  // Payload .mcp.json: a server the workspace lacks, a server it changed,
  // a server both hold identically, and a template-only top-level key.
  writeFileSync(join(payload, '.mcp.json'), JSON.stringify({
    mcpServers: {
      playwright: { command: 'npx', args: ['@playwright/mcp@v2'] },
      brandnew: { command: 'npx' },
      shared: { command: 'node' },
    },
    enableAllProjectMcpServers: true,
  }, null, 2) + '\n');
  // Workspace .mcp.json: its own server, its own top-level key, a changed
  // playwright, and the identical shared server.
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      playwright: { command: 'npx', args: ['@playwright/mcp@v1'] },
      mine: { command: 'npx' },
      shared: { command: 'node' },
    },
    customTopLevel: { a: 1 },
  }, null, 2) + '\n');
  // The bytes differ from the baseline too — irrelevant for a config file.
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.21.0',
    files: {
      '.mcp.json': sha('{"mcpServers":{}}\n'),
      '.claude/settings.json': sha('{}\n'),
    },
  }) + '\n');
  // settings.json: identical on both sides — empty diff, nothing to ask.
  writeFileSync(join(payload, '.claude', 'settings.json'), '{"permissions":{"deny":[]}}\n');
  writeFileSync(join(root, '.claude', 'settings.json'), '{"permissions":{"deny":[]}}\n');

  const result = classifyUpdate({ root });
  assertEq(result.config, [
    { path: '.claude/settings.json', added: [], workspaceOnly: [], changed: [], arrays: [] },
    {
      path: '.mcp.json',
      added: ['enableAllProjectMcpServers', 'mcpServers/brandnew'],
      workspaceOnly: ['customTopLevel', 'mcpServers/mine'],
      changed: ['mcpServers/playwright'],
      arrays: [],
    },
  ], 'config carries the key-level diff at unit depth, sorted paths');
  for (const list of [result.new, result.updated, result.differs, result.identical, result.localOnly, result.removed]) {
    assertTrue(!list.includes('.mcp.json') && !list.includes('.claude/settings.json'),
      'config files never appear in a content list');
  }
  rmSync(root, { recursive: true, force: true });
}

// 12b. config with no installed counterpart: nothing of the workspace's is
//      at risk, so the payload's copy can be installed as-is.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.mcp.json'), '{"mcpServers":{"playwright":{"command":"npx"}}}\n');

  const result = classifyUpdate({ root });
  assertEq(result.config, [{ path: '.mcp.json', notInstalled: true }], 'a missing workspace config flags notInstalled');
  assertTrue(!result.new.includes('.mcp.json'), 'a missing config file is never new');
  rmSync(root, { recursive: true, force: true });
}

// 12c. broken JSON on either side flags unparseable — the skill must ask,
//      never merge blind and never copy wholesale.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.mcp.json'), '{ not json\n');
  writeFileSync(join(payload, '.claude', 'settings.json'), '{"hooks":{}}\n');
  writeFileSync(join(root, '.claude', 'settings.json'), '{ also not json\n');

  const result = classifyUpdate({ root });
  assertEq(result.config, [
    { path: '.claude/settings.json', unparseable: true },
    { path: '.mcp.json', unparseable: true },
  ], 'unparseable configs are flagged, one per side');
  assertTrue(!result.differs.includes('.mcp.json'), 'an unparseable config is still never differs');
  rmSync(root, { recursive: true, force: true });
}

// 12d. Array-valued config keys diff by ELEMENT: hooks event lists and
//      permissions.allow/deny are sets both sides extend, so the skill
//      union-merges them (keep the workspace's elements, add the template's)
//      instead of choosing one side whole — never a `changed` ask (gh:186).
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'a.mjs' }] },
        { matcher: 'Edit', hooks: [] },
      ],
    },
    permissions: { allow: ['Bash(node:*)', 'WebFetch'], deny: ['Bash(rm:*)'] },
  }) + '\n');
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'a.mjs' }] },
        { matcher: 'Read', hooks: [] },
      ],
    },
    permissions: { allow: ['Bash(node:*)', 'Bash(git:*)'], deny: [] },
  }) + '\n');

  const result = classifyUpdate({ root });
  assertEq(result.config, [{
    path: '.claude/settings.json',
    added: [],
    workspaceOnly: [],
    changed: [],
    arrays: [
      {
        path: 'hooks/PreToolUse',
        added: [{ matcher: 'Edit', hooks: [] }],
        workspaceOnly: [{ matcher: 'Read', hooks: [] }],
      },
      { path: 'permissions/allow', added: ['WebFetch'], workspaceOnly: ['Bash(git:*)'] },
      { path: 'permissions/deny', added: ['Bash(rm:*)'], workspaceOnly: [] },
    ],
  }], 'arrays diff by element with the key path, never as changed');
}

// 13. Baseline resolution order (gh:186): the workspace's own baseline
//     wins, the payload's .template-baseline.reconstructed.json (staged by
//     --upgrade for pre-baseline workspaces) is the fallback an explicit
//     --baseline overrides, and a corrupt root baseline counts as absent.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v2\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// template v1\n');
  writeFileSync(join(payload, '.template-baseline.reconstructed.json'), JSON.stringify({
    templateVersion: '0.20.0',
    reconstructed: true,
    files: { '.claude/hooks/session-start.mjs': sha('// template v1\n') },
  }) + '\n');

  // no root baseline: the payload's reconstructed one drives three-way
  // classification — the worktree-flow case, where <root> is a worktree
  // that cannot see the launcher's files
  let result = classifyUpdate({ root });
  assertTrue(result.hasBaseline, 'the payload reconstructed baseline is found without a root one');
  assertEq(result.baselineSource, '.workspace-update/.template-baseline.reconstructed.json',
    'baselineSource names the reconstructed file');
  assertTrue(result.baselineReconstructed, 'baselineReconstructed flags a reconstructed baseline');
  assertEq(result.updated, ['.claude/hooks/session-start.mjs'],
    'the reconstructed baseline drives three-way classification (updated, not differs)');

  // a root baseline wins over the payload fallback
  writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
    templateVersion: '0.19.0',
    files: { '.claude/hooks/session-start.mjs': sha('// something else\n') },
  }) + '\n');
  result = classifyUpdate({ root });
  assertEq(result.baselineSource, '.claude/.template-baseline.json',
    'the root baseline wins over the payload fallback');
  assertTrue(!result.baselineReconstructed, 'the root baseline is not flagged reconstructed');
  assertEq(result.differs, ['.claude/hooks/session-start.mjs'],
    'the root baseline hashes drive classification, not the reconstructed ones');

  // an explicit --baseline beats both, on the CLI as in the API
  const explicit = join(root, 'explicit-baseline.json');
  writeFileSync(explicit, JSON.stringify({
    templateVersion: '0.20.0',
    files: { '.claude/hooks/session-start.mjs': sha('// template v1\n') },
  }) + '\n');
  result = classifyUpdate({ root, baseline: explicit });
  assertEq(result.baselineSource, explicit, 'an explicit baseline wins');
  assertEq(result.updated, ['.claude/hooks/session-start.mjs'], 'the explicit baseline drives classification');
  const cli = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', root, '--payload', payload, '--baseline', explicit],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(cli.status, 0, `CLI accepts --baseline (stderr: ${cli.stderr.trim().slice(0, 200)})`);
  assertEq(JSON.parse(cli.stdout).baselineSource, explicit, 'CLI --baseline drives classification');

  // a corrupt root baseline counts as absent — the fallback applies
  writeFileSync(join(root, '.claude', '.template-baseline.json'), '{ broken\n');
  result = classifyUpdate({ root });
  assertEq(result.baselineSource, '.workspace-update/.template-baseline.reconstructed.json',
    'a corrupt root baseline falls through to the reconstructed one');
  assertEq(result.updated, ['.claude/hooks/session-start.mjs'],
    'the reconstructed baseline classifies after a corrupt root file');
  rmSync(root, { recursive: true, force: true });
}

// 14. implicitDefaults (gh:190): the canonical budget was an implicit default
//     only between v0.15.0-beta.1 (which introduced it — absent meant a
//     40960-byte budget) and v0.19.0-beta.0 (which made it opt-in — absent
//     means off since). An upgrade from inside that window into a workspace
//     that never wrote the key reports it, so the skill writes the value
//     explicitly instead of letting trimming silently stop. Outside the window
//     nothing reports: before v0.15 there was no budget to preserve, and
//     reporting one would turn trimming ON. Prerelease ordering must hold on
//     both edges: 0.15.0-beta.1 is inside, 0.19.0-beta.0 is not.
{
  const mk = (fromVersion, workspace) => {
    const root = setupWorkspace();
    const payload = setupPayload(root);
    if (fromVersion !== null) {
      writeFileSync(join(payload, '.manifest.json'), JSON.stringify({ fromVersion, templateVersion: '0.23.0-beta.0' }) + '\n');
    }
    if (workspace !== undefined) {
      writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace }, null, 2) + '\n');
    }
    return classifyUpdate({ root }).implicitDefaults;
  };
  const expected = [{
    key: 'canonicalBudgetBytes',
    value: 40960,
    reason: 'absent meant a 40960-byte canonical budget before v0.19 and means off since — write the value explicitly or trimming silently stops',
  }];
  assertEq(mk('0.14.0-beta.3', { name: 'demo' }), [], 'fromVersion 0.14.0-beta.3 does not — no budget existed to preserve');
  assertEq(mk('0.15.0-beta.1', { name: 'demo' }), expected, 'fromVersion 0.15.0-beta.1 reports the lost implicit default');
  assertEq(mk('0.17.2', { name: 'demo' }), expected, 'fromVersion 0.17.2 reports it too');
  assertEq(mk('0.18.2', { name: 'demo' }), expected, 'fromVersion 0.18.2 reports it too — still inside the window');
  assertEq(mk('0.19.0', { name: 'demo' }), [], 'fromVersion 0.19.0 does not — absent already meant off');
  assertEq(mk('0.19.0-beta.0', { name: 'demo' }), [], 'fromVersion 0.19.0-beta.0 does not — the beta that shipped the change');
  assertEq(mk('0.15.0-beta.1', { name: 'demo', canonicalBudgetBytes: 40960 }), [],
    'an explicit key is never reported, whatever the fromVersion');
  assertEq(mk(null, { name: 'demo' }), [], 'no manifest means nothing to infer');
  assertEq(mk('0.15.0-beta.1', undefined), [], 'no workspace.json means nowhere to write the key');
}

// 15. --write-baseline resolves its previous baseline the same way: in the
//     worktree flow (root has no baseline yet) a declined update keeps its
//     old entry from the payload's reconstructed baseline, instead of the
//     change being silently filed away as applied.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v2\n');
  writeFileSync(join(payload, '.manifest.json'), JSON.stringify({ templateVersion: '0.22.0' }) + '\n');
  // the user declined the update: the workspace keeps the old content
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// template v1\n');
  writeFileSync(join(payload, '.template-baseline.reconstructed.json'), JSON.stringify({
    templateVersion: '0.20.0',
    reconstructed: true,
    files: { '.claude/hooks/session-start.mjs': sha('// template v1\n') },
  }) + '\n');

  const r = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', root, '--payload', payload, '--write-baseline'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r.status, 0, `--write-baseline exits 0 with a reconstructed previous (stderr: ${r.stderr.trim().slice(0, 200)})`);
  const baseline = JSON.parse(readFileSync(join(root, '.claude', '.template-baseline.json'), 'utf8'));
  assertEq(baseline.files['.claude/hooks/session-start.mjs'], sha('// template v1\n'),
    'a declined update keeps its old hash from the payload reconstructed baseline');
  rmSync(root, { recursive: true, force: true });
}

// 8c. staleTests: *.test.mjs under .claude/ with no payload counterpart are
//     listed for removal, never counted as template removals.
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template\n');
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// template\n');
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(root, '.claude', 'scripts', 'helper.test.mjs'), '// stale\n');
  mkdirSync(join(root, '.claude', 'worktrees', 'fix-x'), { recursive: true });
  writeFileSync(join(root, '.claude', 'worktrees', 'fix-x', 'nested.test.mjs'), '// inside a worktree\n');
  // a test the payload DOES carry is not stale — it updates with the template
  mkdirSync(join(payload, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(payload, '.claude', 'scripts', 'current.test.mjs'), '// current\n');
  writeFileSync(join(root, '.claude', 'scripts', 'current.test.mjs'), '// current\n');

  const result = classifyUpdate({ root });
  assertEq(result.staleTests, ['.claude/scripts/helper.test.mjs'], 'staleTests lists orphaned test files only');
  assertEq(result.removed, [], 'test files are never template removals');
  assertTrue(result.identical.includes('.claude/scripts/current.test.mjs'), 'a payload-carried test classifies normally');
  rmSync(root, { recursive: true, force: true });
}

// 9. CLI --write-baseline: records the payload hashes (the template's content,
//    regardless of what the workspace holds) and prints a confirmation.
{
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, '.manifest.json'), JSON.stringify({ templateVersion: '0.21.0' }) + '\n');
  writeFileSync(join(payload, '.claude', 'hooks', 'session-start.mjs'), '// template v2\n');
  // the user kept a local edit; the baseline must still record the payload hash
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.mjs'), '// my version\n');
  writeFileSync(join(root, '.claude', 'skills', 'kept', 'SKILL.md'), '# Same\n');
  writeFileSync(join(payload, '.claude', 'skills', 'kept', 'SKILL.md'), '# Same\n');

  const r = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', root, '--payload', payload, '--write-baseline'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r.status, 0, `--write-baseline exits 0 (stderr: ${r.stderr.trim().slice(0, 200)})`);
  const parsed = JSON.parse(r.stdout);
  assertEq(parsed.written, true, 'confirmation JSON says written');
  assertEq(parsed.templateVersion, '0.21.0', 'confirmation carries the payload version');
  const baseline = JSON.parse(readFileSync(join(root, '.claude', '.template-baseline.json'), 'utf8'));
  assertEq(baseline.templateVersion, '0.21.0', 'baseline records the payload version');
  assertEq(baseline.files['.claude/hooks/session-start.mjs'], sha('// template v2\n'),
    'a kept local edit records the PAYLOAD hash — the divergence stays visible next update');
  assertEq(baseline.files['.claude/skills/kept/SKILL.md'], sha('# Same\n'), 'applied files record the payload hash too');
  assertTrue(Object.keys(baseline.files).every((k) => !k.endsWith('.test.mjs')), 'tests are never baselined');

  // with the fresh baseline, the same workspace classifies the kept file as
  // localOnly — the divergence is visible but the template didn't change the
  // file since, so it is listed for information, never re-asked per file
  const result = classifyUpdate({ root });
  assertEq(result.localOnly, ['.claude/hooks/session-start.mjs'], 'kept local edit reads as localOnly against the payload-hash baseline');
  assertEq(result.differs, [], 'nothing reads as differs');
  assertEq(result.updated, [], 'nothing reads as updated');
  rmSync(root, { recursive: true, force: true });
}

// 10. mergeClaudeMd — template lines update, workspace lines survive
{
  const current = [
    '## Workspace: demo',
    '',
    'This is a claude-workspace.',
    '',
    '## Skills',
    '- `/start-work [handoff|blank]` — begin a work session (reworded locally)',
    '- `/my-skill` — added by this workspace',
    '',
    '## Local Conventions',
    'Deploy on Fridays only.',
    '',
  ].join('\n') + '\n';
  const next = [
    '## Workspace: demo',
    '',
    'This is a claude-workspace. All conventions are defined in .claude/rules/.',
    '',
    '## Skills',
    '- `/start-work [handoff|blank]` — begin a work session',
    '- `/brand-new` — shipped by the new template',
    '',
    '## Freshness',
    'New template section.',
    '',
  ].join('\n') + '\n';

  const merged = mergeClaudeMd(current, next);
  const lines = merged.split('\n');
  assertTrue(merged.includes('All conventions are defined in .claude/rules/.'), 'template prose lines update');
  assertTrue(lines.includes('- `/start-work [handoff|blank]` — begin a work session'),
    'a skill entry the template reworded takes the template line (matched by /name)');
  assertTrue(!merged.includes('reworded locally'), 'the workspace stale rewording of that entry is dropped');
  assertTrue(lines.includes('- `/my-skill` — added by this workspace'), 'a workspace-only skill entry is kept');
  assertTrue(lines.includes('- `/brand-new` — shipped by the new template'), 'a new template entry lands');
  assertTrue(merged.includes('## Local Conventions') && merged.includes('Deploy on Fridays only.'),
    'a workspace-only section survives');
  assertTrue(merged.includes('## Freshness') && merged.includes('New template section.'),
    'a new template section is appended');
  assertTrue(merged.indexOf('## Local Conventions') < merged.indexOf('## Freshness'),
    'workspace sections keep their place before appended template sections');
}

// 10b. mergeClaudeMd — identical inputs round-trip byte-for-byte
{
  const text = readFileSync(join(here, '..', '..', '..', 'template', 'CLAUDE.md.tmpl'), 'utf8')
    .replace(/\{\{project-name\}\}/g, 'demo');
  assertEq(mergeClaudeMd(text, text), text, 'merging a file with itself changes nothing');
  assertEq(mergeClaudeMd('', text), text, 'an empty current file takes the template as-is');
}

// 10c. mergeClaudeMd — any `## Workspace:` heading is the same section: a
//      renamed workspace merges its intro with the template's instead of
//      keeping two intro sections side by side.
{
  const current = '## Workspace: old-name\n\nIntro prose.\n\n## Skills\n- `/a` — one\n';
  const next = '## Workspace: new-name\n\nIntro prose, reworded.\n\n## Skills\n- `/a` — one\n';
  const merged = mergeClaudeMd(current, next);

  const introHeadings = merged.split('\n').filter((l) => l.startsWith('## Workspace:'));
  assertEq(introHeadings, ['## Workspace: new-name'], 'one intro heading survives, the template\'s wording wins');
  assertTrue(merged.includes('Intro prose, reworded.'), 'the template intro body lands');
  assertTrue(
    merged.indexOf('Intro prose, reworded.') < merged.indexOf('Intro prose.'),
    'the workspace\'s old intro line is kept only as a trailing line of the merged section, never as a second intro section',
  );
}

// 10d. mergeClaudeMd — `## ` lines inside fenced code blocks are content, not
//      section headings.
{
  const current = [
    '## Skills',
    'Example config:',
    '',
    '```markdown',
    '## Workspace: fake',
    'not a heading',
    '```',
    '',
    '## Notes',
    'Real section.',
  ].join('\n') + '\n';
  const next = '## Skills\n- `/a` — one\n';
  const merged = mergeClaudeMd(current, next);

  assertTrue(merged.includes('## Workspace: fake') && merged.includes('not a heading'),
    'the fenced pseudo-heading stays inside its section');
  assertTrue(merged.indexOf('## Workspace: fake') < merged.indexOf('## Notes'),
    'content after a fenced pseudo-heading stays in the enclosing section');
  const fakeIdx = merged.split('\n').indexOf('## Workspace: fake');
  assertTrue(
    fakeIdx > 0 && merged.split('\n')[fakeIdx - 1] === '```markdown',
    'the pseudo-heading stays fenced content (the line before it is the fence opener)',
  );
}

// 10e. mergeClaudeMd — line endings follow the current file: CRLF in, CRLF out
{
  const current = '## Skills\r\n- `/a` — ours\r\n- `/b` — mine\r\n';
  const next = '## Skills\n- `/a` — theirs\n';
  const merged = mergeClaudeMd(current, next);

  assertTrue(merged.includes('\r\n'), 'a CRLF workspace file merges to CRLF');
  assertTrue(!/[^\r]\n/.test(merged), 'no bare LF sneaks into a CRLF result');
  assertTrue(merged.includes('- `/a` — theirs\r\n'), 'template lines arrive, re-wrapped in CRLF');
  assertTrue(merged.includes('- `/b` — mine\r\n'), 'workspace lines keep their CRLF');
}

// 11. CLI --merge-claude-md — substitutes {{project-name}}, merges with the
//     workspace's CLAUDE.md, and prints JSON { claudeMd, droppedIncludes,
//     missingIncludes }: the merged text, the retired @-includes it dropped
//     from the workspace's copy because this payload no longer ships them
//     (gh:196), and every `@{path}` include it carries whose target is absent
//     at the root, minus machine-local local-only-* targets (gh:190).
{
  const root = setupWorkspace();
  const payload = setupPayload(root);
  writeFileSync(join(payload, 'CLAUDE.md.tmpl'), '## Workspace: {{project-name}}\n\n## Skills\n- `/start-work` — begin\n');
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: { name: 'acme' } }) + '\n');
  writeFileSync(join(root, 'CLAUDE.md'), '## Workspace: acme\n\n## Skills\n- `/start-work` — begin\n- `/acme-deploy` — ours\n');

  const r = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', root, '--payload', payload, '--merge-claude-md'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r.status, 0, `--merge-claude-md exits 0 (stderr: ${r.stderr.trim().slice(0, 200)})`);
  const parsed = JSON.parse(r.stdout);
  assertTrue(parsed.claudeMd.includes('## Workspace: acme'), '{{project-name}} substituted from workspace.json');
  assertTrue(parsed.claudeMd.includes('- `/acme-deploy` — ours'), 'workspace skill entries survive the CLI merge');
  assertEq(parsed.missingIncludes, [], 'no include lines in the merge, nothing missing');
  assertEq(parsed.droppedIncludes, [], 'nothing retired to drop when the workspace carries no retired include');
  assertTrue(readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('## Workspace: acme'),
    'the mode prints only — the workspace file is untouched until the skill writes it');

  // gained includes: only absent, non-machine-local targets report — the
  // merged text still carries every line, the decision is the skill's
  const gained = setupWorkspace();
  const gainedPayload = setupPayload(gained);
  writeFileSync(
    join(gainedPayload, 'CLAUDE.md.tmpl'),
    '## Workspace: {{project-name}}\n\n@CODEBASE.md\n@workspace.json\n@local-only-draft.md\n',
  );
  writeFileSync(join(gained, 'workspace.json'), JSON.stringify({ workspace: { name: 'acme' } }) + '\n');
  writeFileSync(join(gained, 'CLAUDE.md'), '## Workspace: acme\n');
  const r3 = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', gained, '--payload', gainedPayload, '--merge-claude-md'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r3.status, 0, `--merge-claude-md with gained includes exits 0 (stderr: ${r3.stderr.trim().slice(0, 200)})`);
  const parsed3 = JSON.parse(r3.stdout);
  assertEq(parsed3.missingIncludes, ['CODEBASE.md'],
    'only the absent non-machine-local include reports, in line order');
  for (const line of ['@CODEBASE.md', '@workspace.json', '@local-only-draft.md']) {
    assertTrue(parsed3.claudeMd.includes(line), `the merged text carries ${line} — reporting never drops it`);
  }
  assertEq(parsed3.droppedIncludes, [],
    'an include this payload still ships is never dropped, only merged');

  // retired include: the workspace carries @workspace.json, the payload's
  // template no longer does — the merge drops the line and names it (gh:196)
  const retired = setupWorkspace();
  const retiredPayload = setupPayload(retired);
  writeFileSync(
    join(retiredPayload, 'CLAUDE.md.tmpl'),
    '## Workspace: {{project-name}}\n\n## Workspace Config\n@local-only-template-freshness.md\n',
  );
  writeFileSync(join(retired, 'workspace.json'), JSON.stringify({ workspace: { name: 'acme' } }) + '\n');
  writeFileSync(
    join(retired, 'CLAUDE.md'),
    '## Workspace: acme\n\n## Workspace Config\n@workspace.json\n@local-only-template-freshness.md\n\n## Skills\n- `/acme-deploy` — ours\n',
  );
  const r4 = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', retired, '--payload', retiredPayload, '--merge-claude-md'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r4.status, 0, `--merge-claude-md with a retired include exits 0 (stderr: ${r4.stderr.trim().slice(0, 200)})`);
  const parsed4 = JSON.parse(r4.stdout);
  assertEq(parsed4.droppedIncludes, ['workspace.json'],
    'the retired include the workspace still carries is named in droppedIncludes');
  assertTrue(!parsed4.claudeMd.includes('@workspace.json'),
    'the merged text no longer carries the retired include');
  assertTrue(parsed4.claudeMd.includes('@local-only-template-freshness.md'),
    'the include the template still ships survives the merge');
  assertTrue(parsed4.claudeMd.includes('- `/acme-deploy` — ours'),
    'workspace content around the dropped line survives');

  // same drop under CRLF: stripping the line must not rewrite the file's EOLs
  const crlf = setupWorkspace();
  const crlfPayload = setupPayload(crlf);
  writeFileSync(
    join(crlfPayload, 'CLAUDE.md.tmpl'),
    '## Workspace: {{project-name}}\n\n## Workspace Config\n@local-only-template-freshness.md\n',
  );
  writeFileSync(join(crlf, 'workspace.json'), JSON.stringify({ workspace: { name: 'acme' } }) + '\n');
  writeFileSync(
    join(crlf, 'CLAUDE.md'),
    '## Workspace: acme\r\n\r\n## Workspace Config\r\n@workspace.json\r\n@local-only-template-freshness.md\r\n',
  );
  const r5 = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', crlf, '--payload', crlfPayload, '--merge-claude-md'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r5.status, 0, `--merge-claude-md with a retired include under CRLF exits 0 (stderr: ${r5.stderr.trim().slice(0, 200)})`);
  const parsed5 = JSON.parse(r5.stdout);
  assertEq(parsed5.droppedIncludes, ['workspace.json'], 'CRLF retires the include too');
  assertTrue(!/[^\r]\n/.test(parsed5.claudeMd), 'no bare LF sneaks into the CRLF result');
  assertTrue(!parsed5.claudeMd.includes('@workspace.json'), 'the retired include is gone under CRLF as well');
  rmSync(retired, { recursive: true, force: true });
  rmSync(crlf, { recursive: true, force: true });

  // no template in the payload → named error
  const bare = setupWorkspace();
  setupPayload(bare);
  const r2 = spawnSync(
    process.execPath,
    [join(here, 'classify-update.mjs'), '--root', bare, '--payload', join(bare, '.workspace-update'), '--merge-claude-md'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r2.status, 1, 'missing CLAUDE.md.tmpl exits 1');
  assertTrue(r2.stderr.includes('CLAUDE.md.tmpl'), 'error names the missing template');
  rmSync(root, { recursive: true, force: true });
  rmSync(gained, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
