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
  writeFileSync(
    join(nestedScripts, 'template-baseline.mjs'),
    readFileSync(join(here, 'template-baseline.mjs'), 'utf8'),
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
  // The nested copies themselves (classifier plus the siblings it imports) are
  // genuinely new to this workspace.
  assertEq(
    parsed.new,
    [
      '.claude/lib/session-frontmatter.mjs',
      '.claude/scripts/build-workspace-context.mjs',
      '.claude/scripts/classify-update.mjs',
      '.claude/scripts/template-baseline.mjs',
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
//     workspace's CLAUDE.md, prints the result
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
  assertTrue(r.stdout.includes('## Workspace: acme'), '{{project-name}} substituted from workspace.json');
  assertTrue(r.stdout.includes('- `/acme-deploy` — ours'), 'workspace skill entries survive the CLI merge');
  assertTrue(readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('## Workspace: acme'),
    'the mode prints only — the workspace file is untouched until the skill writes it');

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
  rmSync(bare, { recursive: true, force: true });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
