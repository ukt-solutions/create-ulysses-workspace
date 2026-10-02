#!/usr/bin/env node
// Unit tests for maintenance-audit.mjs
// Run: node template/_claude/scripts/maintenance-audit.test.mjs
//
// Every test builds its own fixture workspace under mkdtempSync(os.tmpdir())
// and points runAudit at it. Freshness never touches the network — unit
// tests either pass --offline or inject a fetchFn, and CLI tests always pass
// --offline.

import { runAudit, renderReport, parseArgs } from './maintenance-audit.mjs';
import { regenerateAll } from './build-workspace-context.mjs';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
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

/**
 * A mostly-clean fixture workspace. `mutate(root)` applies the per-test
 * breakage after the baseline is committed. `opts.git` false skips the repo
 * entirely (audit must not assume one).
 */
function makeWorkspace(opts = {}, mutate = null) {
  const root = mkdtempSync(join(tmpdir(), 'audit-test-'));
  mkdirSync(join(root, '.claude', 'skills', 'demo'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'workspace-context', 'shared', 'locked'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\n# Demo\n');
  writeFileSync(join(root, '.claude', 'rules', 'keep.md'), 'Be tidy.\n');
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'truth.md'),
    '---\ndescription: A locked truth.\npriority: critical\n---\nTruths are true.\n',
  );
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '## Workspace: fixture\n\n'
      + '## Skills\n'
      + '- `/demo` — demonstrate\n\n'
      + '## Config\n'
      + '@workspace.json\n'
      + '@workspace-context/canonical.md\n'
      + '@workspace-context/index.md\n',
  );
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace: { name: 'fixture', templateVersion: '0.1.0', alwaysLoadedBudgetBytes: 65536 },
      repos: {},
    }, null, 2) + '\n',
  );
  writeCatalogs(root);
  if (mutate) mutate(root);
  if (opts.git !== false) {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'fixture@example.com']);
    git(root, ['config', 'user.name', 'Fixture']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'init']);
  }
  return root;
}

/** Regenerate index.md/canonical.md the way --write does, so section 5 is clean. */
function writeCatalogs(root) {
  for (const a of regenerateAll(root)) {
    mkdirSync(dirname(a.path), { recursive: true });
    writeFileSync(a.path, a.content);
  }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const CURRENT = async () => ({ ok: true, json: async () => ({ latest: '0.1.0' }) });
const NOW = new Date('2026-10-01T12:00:00.000Z');

async function audit(root, opts = {}) {
  return runAudit({ root, offline: true, nowFn: () => NOW, ...opts });
}

function bySection(result, section) {
  return result.issues.filter((f) => f.section === section);
}

console.log('# maintenance-audit');

// 1. clean workspace — no issues, no warnings, exit 0
{
  const root = makeWorkspace();
  const result = await audit(root, { offline: false, fetchFn: CURRENT });
  assertEq(result.summary.issues, 0, 'clean workspace has no issue findings');
  assertEq(result.summary.warnings, 0, 'clean workspace has no warnings');
  assertEq(result.summary.exitCode, 0, 'clean workspace exits 0');
  assertEq(result.summary.freshness.status, 'current', 'freshness current via injected fetch');
  assertTrue(result.summary.alwaysLoaded && result.summary.alwaysLoaded.overBudget === false, 'budget summary present and within');
  cleanup(root);
}

// 2. section 1 — skill list both directions, dangling imports, local-only info
{
  const root = makeWorkspace({}, (r) => {
    mkdirSync(join(r, '.claude', 'skills', 'hidden'), { recursive: true });
    writeFileSync(join(r, '.claude', 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: x.\n---\n');
    writeFileSync(
      join(r, 'CLAUDE.md'),
      '## Workspace: fixture\n\n'
        + '## Skills\n'
        + '- `/demo` — demonstrate\n'
        + '- `/ghost` — does not exist\n\n'
        + '@workspace.json\n'
        + '@workspace-context/missing.md\n'
        + '@local-only-template-freshness.md\n',
    );
    // put the catalogs back so section 5 stays quiet about index/canonical
    writeCatalogs(r);
  });
  const result = await audit(root);
  const cross = bySection(result, 'cross-reference');
  assertTrue(cross.some((f) => f.severity === 'issue' && f.file === 'CLAUDE.md' && f.message.includes('/ghost')),
    'listed-but-missing skill is an issue on CLAUDE.md');
  assertTrue(cross.some((f) => f.severity === 'issue' && f.file === '.claude/skills/hidden/SKILL.md'),
    'installed-but-unlisted skill is an issue on the skill file');
  assertTrue(cross.some((f) => f.severity === 'issue' && f.message.includes('workspace-context/missing.md')),
    'dangling non-local import is an issue');
  assertTrue(cross.some((f) => f.severity === 'info' && f.message.includes('local-only-template-freshness.md')),
    'missing local-only import is info, not issue');
  assertEq(result.summary.exitCode, 1, 'cross-reference issues exit 1');
  cleanup(root);
}

// 3. section 2 — frontmatter integrity across the mechanical checks
{
  const root = makeWorkspace({}, (r) => {
    mkdirSync(join(r, 'workspace-context', 'shared'), { recursive: true });
    writeFileSync(join(r, 'workspace-context', 'shared', 'broken.md'), '---\nname: never closed\n');
    writeFileSync(join(r, 'workspace-context', 'shared', 'plain.md'), 'Just prose, no frontmatter.\n');
    writeFileSync(
      join(r, 'workspace-context', 'shared', 'stale.md'),
      '---\ndescription: Stale.\nlifecycle: active\nupdated: 2026-09-01\n---\nOld.\n',
    );
    writeFileSync(
      join(r, 'workspace-context', 'shared', 'done.md'),
      '---\ndescription: Done.\nlifecycle: resolved\nupdated: 2026-09-01\n---\nDone.\n',
    );
    writeFileSync(
      join(r, 'workspace-context', 'shared', 'unsure.md'),
      '---\ndescription: Unsure.\nconfidence: maybe\n---\nHm.\n',
    );
    mkdirSync(join(r, 'work-sessions', 'demo', 'workspace'), { recursive: true });
    writeFileSync(
      join(r, 'work-sessions', 'demo', 'workspace', 'session.md'),
      '---\nstatus: active\nbranch: bugfix/gone\nrepos:\n  - ghost-repo\nupdated: 2026-09-30\n---\nWork.\n',
    );
    writeCatalogs(r);
  });
  const result = await audit(root);
  const fm = bySection(result, 'frontmatter');
  assertTrue(fm.some((f) => f.severity === 'issue' && f.file === 'workspace-context/shared/broken.md' && f.message.includes('parse')),
    'unparseable frontmatter is an issue');
  assertTrue(fm.some((f) => f.severity === 'warning' && f.file === 'workspace-context/shared/plain.md'),
    'missing frontmatter is a warning');
  assertTrue(fm.some((f) => f.severity === 'warning' && f.file === 'workspace-context/shared/stale.md' && f.message.includes('stale')),
    'active and untouched past the staleness window is a warning');
  assertTrue(fm.some((f) => f.severity === 'info' && f.message.includes('1 lifecycle resolved file(s)') && f.message.includes('done.md')),
    'resolved lifecycles collapse into one info line naming the file (gh:190)');
  assertTrue(fm.some((f) => f.severity === 'warning' && f.file === 'workspace-context/shared/unsure.md' && f.message.includes('confidence')),
    'invalid confidence value is a warning');
  const tracker = 'work-sessions/demo/workspace/session.md';
  assertTrue(fm.some((f) => f.severity === 'warning' && f.file === tracker && f.message.includes("'name'")),
    'tracker missing required field is a warning');
  assertTrue(fm.some((f) => f.severity === 'warning' && f.file === tracker && f.message.includes('bugfix/gone')),
    'tracker referencing a deleted branch is a warning');
  assertTrue(fm.some((f) => f.severity === 'warning' && f.file === tracker && f.message.includes('ghost-repo')),
    'tracker referencing an unknown repo is a warning');
  assertEq(result.summary.exitCode, 1, 'frontmatter issue exits 1');
  cleanup(root);
}

// 3b. section 2 — a tracker whose repos all resolve finds nothing
{
  const root = makeWorkspace({}, (r) => {
    const config = JSON.parse(readFileSync(join(r, 'workspace.json'), 'utf8'));
    config.repos['my-app'] = { remote: 'x', branch: 'main' };
    writeFileSync(join(r, 'workspace.json'), JSON.stringify(config, null, 2) + '\n');
    mkdirSync(join(r, 'work-sessions', 'demo', 'workspace'), { recursive: true });
    writeFileSync(
      join(r, 'work-sessions', 'demo', 'workspace', 'session.md'),
      '---\nname: demo\nstatus: active\nbranch: main\nrepos:\n  - my-app\n  - .\nupdated: 2026-09-30\n---\nWork.\n',
    );
    writeCatalogs(r);
  });
  const result = await audit(root);
  const fm = bySection(result, 'frontmatter');
  assertEq(fm.filter((f) => f.file.includes('session.md')), [], 'clean tracker produces no frontmatter findings');
  cleanup(root);
}

// 4. section 3 — workspace.json and manifest structure
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(join(r, 'workspace.json'), '{ not json\n');
    writeCatalogs(r);
  });
  const result = await audit(root);
  const st = bySection(result, 'structure');
  assertTrue(st.some((f) => f.severity === 'issue' && f.file === 'workspace.json' && f.message.includes('parse')),
    'unparseable workspace.json is an issue');
  assertEq(result.summary.exitCode, 1, 'structure issue exits 1');
  cleanup(root);
}
{
  const root = makeWorkspace({}, (r) => {
    const config = JSON.parse(readFileSync(join(r, 'workspace.json'), 'utf8'));
    config.repos['my-app'] = { remote: 'x', branch: 'main' };
    writeFileSync(join(r, 'workspace.json'), JSON.stringify(config, null, 2) + '\n');
    writeCatalogs(r);
  });
  const result = await audit(root);
  const st = bySection(result, 'structure');
  assertTrue(st.some((f) => f.severity === 'warning' && f.file === 'workspace.json' && f.message.includes('my-app')),
    'uncloned manifest repo is a warning');
  assertEq(result.summary.exitCode, 0, 'structure warning alone exits 0');
  cleanup(root);
}

// 5. section 4 — git state
{
  const root = makeWorkspace({ git: false });
  const result = await audit(root);
  const g = bySection(result, 'git');
  assertTrue(g.some((f) => f.severity === 'info' && f.message.includes('not a git repository')),
    'non-repo workspace reports info and skips git checks');
  assertEq(result.summary.exitCode, 0, 'non-repo workspace still exits 0 when otherwise clean');
  cleanup(root);
}
{
  const root = makeWorkspace();
  git(root, ['checkout', '-b', 'feature/detour']);
  writeFileSync(join(root, '.claude', 'rules', 'keep.md'), 'Be tidy. (edited)\n');
  writeFileSync(join(root, 'stray.txt'), 'untracked\n');
  const result = await audit(root);
  const g = bySection(result, 'git');
  assertTrue(g.some((f) => f.severity === 'warning' && f.message.includes("on branch 'feature/detour'")),
    'launcher off its default branch is a warning');
  assertTrue(g.some((f) => f.severity === 'warning' && f.message.includes('uncommitted') && f.message.includes('.claude/rules/keep.md')),
    'modified tracked file is a warning naming the file');
  assertTrue(g.some((f) => f.severity === 'info' && f.message.includes('untracked')),
    'untracked path is info');
  assertEq(result.summary.exitCode, 0, 'git findings are warnings/infos, exit 0');
  cleanup(root);
}

// 6. section 5 — auto-file drift
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(join(r, 'workspace-context', 'canonical.md'), 'hand edited\n');
    rmSync(join(r, 'workspace-context', 'index.md'));
  });
  const result = await audit(root);
  const af = bySection(result, 'auto-files');
  assertTrue(af.some((f) => f.severity === 'issue' && f.file === 'workspace-context/canonical.md' && f.message.includes('stale')),
    'stale canonical.md is an issue');
  assertTrue(af.some((f) => f.severity === 'issue' && f.file === 'workspace-context/index.md' && f.message.includes('missing')),
    'missing index.md is an issue');
  assertEq(result.summary.exitCode, 1, 'auto-file drift exits 1');
  cleanup(root);
}
{
  // A gitignored per-user index is regenerable per machine: absent is info.
  const root = makeWorkspace({}, (r) => {
    mkdirSync(join(r, 'workspace-context', 'team-member', 'alice'), { recursive: true });
    writeFileSync(
      join(r, 'workspace-context', 'team-member', 'alice', 'research_x.md'),
      '---\ndescription: Alice research.\ntype: research\nauthor: alice\nupdated: 2026-09-30\n---\nNotes.\n',
    );
    writeFileSync(join(r, '.gitignore'), 'workspace-context/team-member/alice/index.md\n');
    writeCatalogs(r);
    rmSync(join(r, 'workspace-context', 'team-member', 'alice', 'index.md'));
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'alice']);
  const result = await audit(root);
  const af = bySection(result, 'auto-files');
  assertTrue(af.some((f) => f.severity === 'info' && f.file === 'workspace-context/team-member/alice/index.md'),
    'missing gitignored per-user index is info, not issue');
  assertEq(result.summary.exitCode, 0, 'regenerable absence exits 0');
  cleanup(root);
}
{
  // Over-budget canonical after regeneration: warning with the excess named.
  const root = makeWorkspace({}, (r) => {
    const config = JSON.parse(readFileSync(join(r, 'workspace.json'), 'utf8'));
    config.workspace.canonicalBudgetBytes = 64;
    writeFileSync(join(r, 'workspace.json'), JSON.stringify(config, null, 2) + '\n');
    writeFileSync(
      join(r, 'workspace-context', 'shared', 'locked', 'truth.md'),
      '---\ndescription: A locked truth.\npriority: critical\n---\n' + 'truth '.repeat(100) + '\n',
    );
    writeCatalogs(r);
  });
  const result = await audit(root);
  const af = bySection(result, 'auto-files');
  assertTrue(af.some((f) => f.severity === 'warning' && f.file === 'workspace-context/canonical.md' && f.message.includes('exceeds')),
    'over-budget canonical is a warning');
  assertEq(result.summary.canonical.status, 'over-budget', 'summary carries the canonical status');
  assertEq(result.summary.exitCode, 0, 'over-budget canonical alone exits 0');
  cleanup(root);
}

// 7. section 6 — always-loaded budget
{
  const root = makeWorkspace({}, (r) => {
    const config = JSON.parse(readFileSync(join(r, 'workspace.json'), 'utf8'));
    config.workspace.alwaysLoadedBudgetBytes = 10;
    writeFileSync(join(r, 'workspace.json'), JSON.stringify(config, null, 2) + '\n');
    writeCatalogs(r);
  });
  const result = await audit(root);
  const b = bySection(result, 'budget');
  assertTrue(b.some((f) => f.severity === 'warning' && f.message.includes('always-loaded') && f.message.includes('contributors')),
    'over-budget context is a warning naming contributors');
  assertTrue(result.summary.alwaysLoaded.overBudget, 'summary flags overBudget');
  assertEq(result.summary.exitCode, 0, 'budget warning alone exits 0');
  cleanup(root);
}

// 8. section 7 — freshness outcomes
{
  const neverFetch = async () => { throw new Error('network must not be touched'); };
  const root = makeWorkspace();
  const result = await audit(root, { offline: true, fetchFn: neverFetch });
  assertEq(bySection(result, 'freshness'), [], '--offline emits no freshness finding');
  assertEq(result.summary.freshness, { status: 'skipped', reason: 'offline' }, 'summary records the skip');
  cleanup(root);
}
{
  const root = makeWorkspace();
  const result = await audit(root, {
    offline: false,
    fetchFn: async () => ({ ok: true, json: async () => ({ latest: '0.9.0' }) }),
  });
  assertTrue(bySection(result, 'freshness').some((f) => f.severity === 'warning' && f.message.includes('0.9.0')),
    'outdated template is a warning naming the version');
  assertTrue(existsSync(join(root, 'local-only-template-freshness.md')), 'outdated result writes the banner, as /maintenance always has');
  cleanup(root);
}
{
  const root = makeWorkspace();
  const result = await audit(root, {
    offline: false,
    fetchFn: async () => { throw new Error('offline'); },
  });
  assertTrue(bySection(result, 'freshness').some((f) => f.severity === 'warning' && f.message.includes('npm registry')),
    'unreachable registry is a warning');
  assertEq(result.summary.freshness.status, 'unknown', 'summary records unknown');
  cleanup(root);
}
{
  const root = makeWorkspace({}, (r) => {
    const config = JSON.parse(readFileSync(join(r, 'workspace.json'), 'utf8'));
    config.workspace.templateVersion = '0.0.0';
    writeFileSync(join(r, 'workspace.json'), JSON.stringify(config, null, 2) + '\n');
    writeCatalogs(r);
  });
  const result = await audit(root, { offline: false, fetchFn: async () => { throw new Error('must not fetch'); } });
  assertTrue(bySection(result, 'freshness').some((f) => f.severity === 'info' && f.message.includes('not initialized')),
    'uninitialized workspace freshness is info');
  cleanup(root);
}

// 9. --changed marking (unit level)
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(
      join(r, 'CLAUDE.md'),
      '## Skills\n- `/demo` — demonstrate\n\n@workspace.json\n@workspace-context/gone.md\n',
    );
    writeCatalogs(r);
  });
  const marked = await audit(root, { changed: ['CLAUDE.md', '/abs/elsewhere'] });
  const dangling = marked.issues.find((f) => f.message.includes('workspace-context/gone.md'));
  assertTrue(dangling && dangling.fromUpdate === true, 'finding on a changed file is marked fromUpdate');
  const unmarked = await audit(root);
  const dangling2 = unmarked.issues.find((f) => f.message.includes('workspace-context/gone.md'));
  assertTrue(dangling2 && dangling2.fromUpdate === undefined, 'without --changed nothing is marked');
  cleanup(root);
}

// 9b. gh:190 audit-noise rules: a missing @local-only-* import stays ambient
//     info even when CLAUDE.md is on the --changed list (machine-local files
//     never materialize inside an update worktree), and many resolved
//     lifecycles collapse into one info line, not one per file.
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(
      join(r, 'CLAUDE.md'),
      '## Skills\n- `/demo` — demonstrate\n\n@workspace.json\n@local-only-template-freshness.md\n',
    );
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(
        join(r, 'workspace-context', 'shared', `done-${name}.md`),
        '---\ndescription: Done.\nlifecycle: resolved\nupdated: 2026-09-01\n---\nDone.\n',
      );
    }
    writeCatalogs(r);
  });
  const result = await audit(root, { changed: ['CLAUDE.md'] });
  const localOnly = result.issues.find((f) => f.message.includes('local-only-template-freshness.md'));
  assertTrue(localOnly && localOnly.severity === 'info', 'missing local-only import is info');
  assertTrue(localOnly && localOnly.fromUpdate === undefined, 'missing local-only import is never "(from this update)"');
  const resolved = bySection(result, 'frontmatter').filter((f) => f.message.includes('lifecycle resolved'));
  assertEq(resolved.length, 1, 'three resolved files yield one collapsed info finding');
  assertTrue(resolved[0].message.includes('3 lifecycle resolved file(s)'), 'the collapsed info carries the count');
  assertEq(result.summary.infos > 0, true, 'summary still counts infos');
  cleanup(root);
}

// 10. renderReport — fromUpdate marker and clean budget line
{
  const root = makeWorkspace();
  const result = await audit(root, { changed: ['.claude/rules/keep.md'] });
  const text = renderReport(result);
  assertTrue(text.includes('Workspace audit —'), 'report has a header');
  assertTrue(text.includes('✓ Always-loaded context:'), 'clean run renders a budget OK line');
  assertTrue(text.endsWith('exit 0'), 'report ends with the exit summary');
  cleanup(root);
}
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(join(r, 'workspace-context', 'canonical.md'), 'hand edited\n');
  });
  const result = await audit(root, { changed: ['workspace-context/canonical.md'] });
  const text = renderReport(result);
  assertTrue(text.includes('is stale'), 'report renders the stale finding');
  assertTrue(text.includes('(from this update)'), 'report marks fromUpdate findings');
  cleanup(root);
}

// 11. CLI — exit codes, --json shape, --changed as list file and repeated flag
{
  const root = makeWorkspace();
  const r = spawnSync(process.execPath, [join(here, 'maintenance-audit.mjs'), '--root', root, '--offline'], { encoding: 'utf8' });
  assertEq(r.status, 0, `CLI exits 0 on a clean workspace (stderr: ${r.stderr.slice(0, 200)})`);
  assertTrue(r.stdout.includes('Workspace audit —'), 'CLI prints the human report by default');
  cleanup(root);
}
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(join(r, 'workspace-context', 'canonical.md'), 'hand edited\n');
  });
  const listFile = join(root, 'changed.txt');
  writeFileSync(listFile, 'workspace-context/canonical.md\nCLAUDE.md\n');
  const r = spawnSync(
    process.execPath,
    [join(here, 'maintenance-audit.mjs'), '--root', root, '--offline', '--json', '--changed', listFile],
    { encoding: 'utf8' },
  );
  assertEq(r.status, 1, 'CLI exits 1 when an issue-severity finding exists');
  const parsed = JSON.parse(r.stdout);
  assertTrue(Array.isArray(parsed.issues) && parsed.issues.length > 0, '--json has a non-empty issues array');
  assertTrue(parsed.issues.every((f) => 'section' in f && 'severity' in f && 'file' in f && 'message' in f),
    'each --json finding carries section/severity/file/message');
  const stale = parsed.issues.find((f) => f.message.includes('stale'));
  assertTrue(stale && stale.fromUpdate === true, '--changed list file marks matching findings');
  assertTrue(parsed.summary.exitCode === 1 && typeof parsed.summary.issues === 'number', 'summary carries counts and exit code');
  cleanup(root);
}
{
  const root = makeWorkspace({}, (r) => {
    mkdirSync(join(r, '.claude', 'skills', 'hidden'), { recursive: true });
    writeFileSync(join(r, '.claude', 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: x.\n---\n');
    writeFileSync(
      join(r, 'CLAUDE.md'),
      '## Skills\n- `/demo` — demonstrate\n\n@workspace.json\n@workspace-context/gone.md\n',
    );
    writeCatalogs(r);
  });
  const r = spawnSync(
    process.execPath,
    [
      join(here, 'maintenance-audit.mjs'), '--root', root, '--offline', '--json',
      '--changed', 'CLAUDE.md', '--changed', 'workspace.json',
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(r.stdout);
  const dangling = parsed.issues.find((f) => f.message.includes('workspace-context/gone.md'));
  assertTrue(dangling && dangling.fromUpdate === true, 'repeated --changed flags mark findings');
  const unlisted = parsed.issues.find((f) => f.file === '.claude/skills/hidden/SKILL.md');
  assertTrue(unlisted && unlisted.fromUpdate === undefined, 'non-changed findings stay unmarked');
  cleanup(root);
}
{
  const root = makeWorkspace();
  const r = spawnSync(
    process.execPath,
    [join(here, 'maintenance-audit.mjs'), '--root', root, '--offline', '--changed', 'no/such/path.md'],
    { encoding: 'utf8' },
  );
  assertEq(r.status, 0, 'a --changed value that is not a file is treated as one path, not an error');
  cleanup(root);
}

// 12. CLI from a payload-like nested location honors --root and never audits
//     its own directory. The payload carries the sibling scripts and lib/
//     helpers the audit imports, so copy those alongside it.
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(join(r, 'workspace-context', 'canonical.md'), 'hand edited\n');
  });
  const payloadClaude = join(root, '.workspace-update', '.claude');
  const nestedScripts = join(payloadClaude, 'scripts');
  mkdirSync(nestedScripts, { recursive: true });
  for (const f of ['maintenance-audit.mjs', 'context-footprint.mjs', 'build-workspace-context.mjs', 'template-baseline.mjs']) {
    writeFileSync(join(nestedScripts, f), readFileSync(join(here, f), 'utf8'));
  }
  mkdirSync(join(payloadClaude, 'lib'), { recursive: true });
  for (const f of ['freshness.mjs', 'registry-check.mjs', 'require-node.mjs', 'session-frontmatter.mjs']) {
    writeFileSync(join(payloadClaude, 'lib', f), readFileSync(join(here, '..', 'lib', f), 'utf8'));
  }
  const r = spawnSync(
    process.execPath,
    [join(nestedScripts, 'maintenance-audit.mjs'), '--root', root, '--offline'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assertEq(r.status, 1, `nested payload copy exits on the --root workspace's findings (stderr: ${r.stderr.slice(0, 200)})`);
  assertTrue(r.stdout.includes('canonical.md is stale'), 'nested copy audits the workspace, not the payload');
  cleanup(root);
}

// 13. parseArgs rejects unknown flags
{
  let threw = null;
  try { parseArgs(['node', 'x', '--wat']); } catch (e) { threw = e; }
  assertTrue(threw !== null && threw.message.includes('--wat'), 'unknown argument throws');
}

// 14. identical findings are reported once — a file reached through two
//     walk roots (here: the sessions dir nested inside workspace-context,
//     so the tracker is both walked and appended) must not double-report.
{
  const root = makeWorkspace({}, (r) => {
    const config = JSON.parse(readFileSync(join(r, 'workspace.json'), 'utf8'));
    config.workspace.workSessionsDir = 'workspace-context/work-sessions';
    writeFileSync(join(r, 'workspace.json'), JSON.stringify(config, null, 2) + '\n');
    mkdirSync(join(r, 'workspace-context', 'work-sessions', 'demo', 'workspace'), { recursive: true });
    writeFileSync(
      join(r, 'workspace-context', 'work-sessions', 'demo', 'workspace', 'session.md'),
      '---\nname: demo\nstatus: active\nbranch: bugfix/gone\nupdated: 2026-09-30\n---\nWork.\n',
    );
    writeCatalogs(r);
  });
  const result = await audit(root);
  const dup = result.issues.filter(
    (f) => f.section === 'frontmatter' && f.message.includes('bugfix/gone'),
  );
  assertEq(dup.length, 1, 'the same file walked twice yields one finding, not two');
  cleanup(root);
}

// 15. historical material is not audited: .indexignore-excluded paths and
//     archive/ directories hold release history whose branches are gone by
//     design; live files keep their findings.
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(join(r, 'workspace-context', '.indexignore'), 'scaffolder-release-history/\nrelease-notes/\n');
    const hist = (p) => {
      mkdirSync(join(r, dirname(p)), { recursive: true });
      writeFileSync(
        join(r, p),
        '---\ndescription: History.\nlifecycle: active\nbranch: bugfix/gone\nupdated: 2026-09-01\n---\nOld.\n',
      );
    };
    hist('workspace-context/scaffolder-release-history/archive/v0.1.0/notes-abc.md');
    hist('workspace-context/shared/archive/old-notes.md');
    // A frontmatter-less file inside another ignored path.
    mkdirSync(join(r, 'workspace-context', 'release-notes', 'v0.2.0'), { recursive: true });
    writeFileSync(join(r, 'workspace-context', 'release-notes', 'v0.2.0', 'notes-def.md'), 'no frontmatter at all\n');
    // A live file still flags the same branch and staleness.
    writeFileSync(
      join(r, 'workspace-context', 'shared', 'live.md'),
      '---\ndescription: Live.\nlifecycle: active\nbranch: bugfix/gone\nupdated: 2026-09-01\n---\nNow.\n',
    );
    writeCatalogs(r);
  });
  const result = await audit(root);
  const fm = bySection(result, 'frontmatter');
  assertEq(
    fm.filter((f) => f.message.includes('bugfix/gone')).map((f) => f.file),
    ['workspace-context/shared/live.md'],
    'branch-gone flags only the live file; .indexignore and archive/ paths are skipped',
  );
  assertTrue(
    !fm.some((f) => f.file.includes('release-notes')),
    'a frontmatter-less file inside an ignored path raises no warning',
  );
  assertTrue(
    fm.some((f) => f.file === 'workspace-context/shared/live.md' && f.message.includes('stale')),
    'live stale candidates are still flagged',
  );
  cleanup(root);
}

// 15b. closed-out lifecycles skip the branch check (the branch was deleted
//      at completion) but keep the resolved info; unlabeled files stay live.
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(
      join(r, 'workspace-context', 'shared', 'done.md'),
      '---\ndescription: Done.\nlifecycle: resolved\nbranch: bugfix/gone\nupdated: 2026-09-01\n---\nDone.\n',
    );
    writeCatalogs(r);
  });
  const result = await audit(root);
  const fm = bySection(result, 'frontmatter');
  assertTrue(
    !fm.some((f) => f.file === 'workspace-context/shared/done.md' && f.message.includes('no longer exists')),
    'resolved lifecycle does not flag its (deleted) branch',
  );
  assertTrue(
    fm.some((f) => f.severity === 'info' && f.message.includes('1 lifecycle resolved file(s)')),
    'resolved lifecycle still reports its one collapsed info',
  );
  cleanup(root);
}

// 16. cross-reference: only list entries are skill references — a `/name`
//     inside prose (the /goal-driven-work line mentioning the built-in
//     /goal) is not a claim, and built-ins never count even as entries.
{
  const root = makeWorkspace({}, (r) => {
    writeFileSync(
      join(r, 'CLAUDE.md'),
      '## Skills\n'
        + '- `/demo [audit|cleanup]` — arg hints inside the backticks still list the skill\n'
        + '- `/goal-driven-work` — run multi-phase work under `/goal` (built-in)\n'
        + '- `/rename` — label chats (also a built-in, listed as an entry)\n'
        + '- `/ghost` — does not exist\n'
        + '\n@workspace.json\n',
    );
    writeCatalogs(r);
  });
  const result = await audit(root);
  const cross = bySection(result, 'cross-reference');
  assertTrue(
    cross.some((f) => f.severity === 'issue' && f.message.includes('/ghost')),
    'a genuine list entry with no installed skill is still flagged',
  );
  assertTrue(
    !cross.some((f) => f.message.includes('lists /goal but')),
    'prose mentions of built-ins (/goal) are not skill references',
  );
  assertTrue(
    !cross.some((f) => f.message.includes('/rename')),
    'a built-in listed as an entry (/rename) is exempt too',
  );
  assertTrue(
    !cross.some((f) => f.file === '.claude/skills/demo/SKILL.md'),
    'an installed skill listed with argument hints is fine',
  );
  cleanup(root);
}

// 17. renderReport collapses a severity group past 5 findings into one
//     summary line with the count, first 3 files, and a --json pointer.
{
  const root = makeWorkspace({}, (r) => {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      writeFileSync(
        join(r, 'workspace-context', 'shared', `old-${name}.md`),
        `---\ndescription: Old ${name}.\nlifecycle: active\nupdated: 2026-09-01\n---\nOld.\n`,
      );
    }
    writeCatalogs(r);
  });
  const result = await audit(root);
  const text = renderReport(result);
  const collapsed = text.split('\n').find((l) => l.includes('warning(s) —'));
  assertTrue(collapsed !== undefined, 'a 7-finding warning group renders one summary line');
  assertTrue(collapsed.includes('7 warning(s)'), 'summary line carries the count');
  assertTrue(collapsed.includes('old-a.md') && collapsed.includes('old-c.md'), 'summary line names the first 3 files');
  assertTrue(collapsed.includes('--json'), 'summary line points at --json');
  assertTrue(!text.includes('old-f.md:'), 'individual findings past the cap are not printed');
  assertEq(result.summary.warnings, 7, 'counts stay complete even when the report collapses');
  cleanup(root);
}

// 18. auditing from a linked worktree (a task worktree of the workspace repo):
//     launcher-level checks — manifest repos cloned, the launcher's branch,
//     the launcher's dirty tracked tree — resolve against the launcher; the
//     worktree's own feature branch and dirty tree are in-flight work,
//     reported as info, never false warnings (gh:183). The mid-update state
//     --upgrade leaves in the launcher — .claude/skills/workspace-update/
//     replaced with the staged payload's copy — is expected bootstrap, info
//     rather than a dirty-tree warning, unless it diverges from the payload
//     (gh:190). Uses a real repo with a real worktree.
{
  const root = makeWorkspace({}, (r) => {
    const config = JSON.parse(readFileSync(join(r, 'workspace.json'), 'utf8'));
    config.repos['my-app'] = { remote: 'x', branch: 'main' };
    writeFileSync(join(r, 'workspace.json'), JSON.stringify(config, null, 2) + '\n');
    // cloned at the launcher only — the worktree will not carry it
    mkdirSync(join(r, 'repos', 'my-app'), { recursive: true });
    // a real file so the directory materializes in the worktree checkout
    // (git does not track empty directories)
    writeFileSync(join(r, '.claude', 'scripts', 'noop.mjs'), '// noop\n');
    // the installed workspace-update skill the upgrade replaces
    mkdirSync(join(r, '.claude', 'skills', 'workspace-update'), { recursive: true });
    writeFileSync(join(r, '.claude', 'skills', 'workspace-update', 'SKILL.md'), '# v0.15 skill\n');
    writeFileSync(
      join(r, 'CLAUDE.md'),
      '## Workspace: fixture\n\n## Skills\n- `/demo` — demonstrate\n- `/workspace-update` — apply updates\n',
    );
    writeCatalogs(r);
  });
  const wt = join(root, 'wt-update');
  const added = git(root, ['worktree', 'add', '-b', 'chore/template-update-0.21.0', wt]);
  assertEq(added.status, 0, `worktree created (stderr: ${added.stderr.trim().slice(0, 200)})`);
  // mid-update worktree: a modified tracked file and an untracked path
  writeFileSync(join(wt, '.claude', 'rules', 'keep.md'), 'Be tidy. (updating)\n');
  writeFileSync(join(wt, 'untracked.txt'), 'x\n');
  // mid-update launcher: --upgrade staged the payload and replaced its copy
  // of the skill with the payload's
  const payloadSkill = join(root, '.workspace-update', '.claude', 'skills', 'workspace-update', 'SKILL.md');
  mkdirSync(dirname(payloadSkill), { recursive: true });
  writeFileSync(payloadSkill, '# v0.23 skill\n');
  writeFileSync(join(root, '.claude', 'skills', 'workspace-update', 'SKILL.md'), '# v0.23 skill\n');

  const result = await audit(wt);
  const g = bySection(result, 'git');
  const st = bySection(result, 'structure');
  assertTrue(g.some((f) => f.severity === 'info' && f.message.includes('worktree')),
    'an info names the worktree context');
  assertTrue(g.some((f) => f.severity === 'info' && f.message.includes('uncommitted-changes check skipped')),
    'the skipped dirty check is reported as info');
  assertTrue(
    g.some((f) => f.severity === 'info' && f.message.includes('workspace-update') && f.message.includes('--upgrade')),
    'the bootstrap skill replacement matching the payload is info',
  );
  assertTrue(
    !g.some((f) => f.message.includes('uncommitted changes:')),
    'a dirty worktree raises no uncommitted-changes warning',
  );
  assertTrue(
    !g.some((f) => f.message.includes("on branch 'chore/template-update-0.21.0'")),
    'the worktree feature branch is not a launcher-branch warning',
  );
  assertTrue(!st.some((f) => f.message.includes('my-app')), 'a repo cloned at the launcher is not reported missing');
  assertEq(result.summary.warnings, 0, 'a healthy launcher audited through a worktree has no warnings');

  // a launcher skill copy that diverges from the payload is real drift again
  writeFileSync(join(root, '.claude', 'skills', 'workspace-update', 'SKILL.md'), '# locally edited\n');
  const result1b = await audit(wt);
  assertTrue(
    bySection(result1b, 'git').some(
      (f) => f.severity === 'warning' && f.message.includes('workspace-update/SKILL.md'),
    ),
    'a skill modification that differs from the payload stays a dirty warning',
  );
  // back to the bootstrap state for the launcher checks below
  writeFileSync(join(root, '.claude', 'skills', 'workspace-update', 'SKILL.md'), '# v0.23 skill\n');

  // an unhealthy launcher still warns from inside the worktree
  git(root, ['checkout', '-b', 'feature/oops']);
  const result2 = await audit(wt);
  assertTrue(
    bySection(result2, 'git').some((f) => f.severity === 'warning' && f.message.includes("launcher is on branch 'feature/oops'")),
    'a launcher off its default branch warns even when audited from a worktree',
  );

  // a dirty launcher tracked tree warns too — the worktree's own dirty files
  // above raised nothing, the launcher's are drift
  writeFileSync(join(root, 'CLAUDE.md'), '## Workspace: fixture (uncommitted edit)\n');
  const result2b = await audit(wt);
  assertTrue(
    bySection(result2b, 'git').some(
      (f) => f.severity === 'warning' && f.message.includes('launcher has 1 tracked file(s) with uncommitted changes: CLAUDE.md'),
    ),
    'a dirty launcher tree warns even when audited from a worktree',
  );

  // a repo missing at the launcher still warns too
  const wsPath = join(wt, 'workspace.json');
  const config = JSON.parse(readFileSync(wsPath, 'utf8'));
  config.repos['ghost'] = { remote: 'x', branch: 'main' };
  writeFileSync(wsPath, JSON.stringify(config, null, 2) + '\n');
  const result3 = await audit(wt);
  assertTrue(
    bySection(result3, 'structure').some((f) => f.message.includes('ghost')),
    'a repo missing at the launcher warns from a worktree',
  );
  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
