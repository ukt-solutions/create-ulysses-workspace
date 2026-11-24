#!/usr/bin/env node
// Tests for migrate-session-layout.mjs
// Run: node .claude/scripts/migrate-session-layout.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { execFileSync, execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { migrateSession, migrateMain } from './migrate-session-layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function assertTrue(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// Spin up a fake workspace with a session worktree on a session branch.
// Uses real git so we test end-to-end. `extraSpecs` are additional spec/plan
// filenames the launcher tracks alongside design-demo.md.
function buildFixture(extraSpecs = []) {
  const root = mkdtempSync(join(tmpdir(), 'migrator-test-'));
  execSync('git init -q -b main', { cwd: root });
  execSync('git config user.email test@example.com', { cwd: root });
  execSync('git config user.name Test', { cwd: root });

  writeFileSync(join(root, 'workspace.json'), JSON.stringify({
    workspace: { workSessionsDir: 'work-sessions', templateVersion: '0.8.0' },
  }, null, 2) + '\n');

  const oldGitignore = [
    '# Work sessions — the folder and worktrees are local, but the session tracker,',
    '# specs, and plans are tracked so durable thinking travels across machines.',
    'work-sessions/**',
    '!work-sessions/*/',
    '!work-sessions/*/session.md',
    '!work-sessions/*/design-*.md',
    '!work-sessions/*/plan-*.md',
    '',
  ].join('\n');
  writeFileSync(join(root, '.gitignore'), oldGitignore);
  execSync('git add -A && git commit -q -m "init"', { cwd: root });

  // Session "demo" — tracker + spec exist at launcher-side paths, tracked on main.
  mkdirSync(join(root, 'work-sessions', 'demo'), { recursive: true });
  writeFileSync(join(root, 'work-sessions', 'demo', 'session.md'),
    '---\ntype: session-tracker\nname: demo\nstatus: active\n---\n\nbody\n');
  const specs = ['design-demo.md', ...extraSpecs];
  for (const name of specs) {
    writeFileSync(join(root, 'work-sessions', 'demo', name), '---\ntopic: demo\n---\n\nspec body\n');
  }
  execFileSync('git', ['add', '--', 'work-sessions/demo/session.md', ...specs.map((n) => `work-sessions/demo/${n}`)],
    { cwd: root });
  execSync('git commit -q -m "add demo tracker and spec"', { cwd: root });

  // Create branch + worktree for demo. Branch inherits the tracker.
  execSync('git branch feature/demo main', { cwd: root });
  execSync('git worktree add -q work-sessions/demo/workspace feature/demo', { cwd: root });

  return root;
}

// migrateSession copies launcher tracker+spec into worktree, removes ghosts,
// and commits on the session branch.
{
  const root = buildFixture();
  try {
    const result = migrateSession(root, 'demo');
    assertEq(result.status, 'migrated', 'first migration returns migrated');

    const inWorktreeTracker = join(root, 'work-sessions', 'demo', 'workspace', 'session.md');
    assertTrue(existsSync(inWorktreeTracker), 'tracker exists at worktree top');

    const inWorktreeSpec = join(root, 'work-sessions', 'demo', 'workspace', 'design-demo.md');
    assertTrue(existsSync(inWorktreeSpec), 'spec exists at worktree top');

    const worktree = join(root, 'work-sessions', 'demo', 'workspace');
    const listed = execSync('git ls-files', { cwd: worktree }).toString();
    assertTrue(listed.includes('\nsession.md\n') || listed.startsWith('session.md\n'),
      'top-level session.md is tracked on branch');
    assertTrue(listed.includes('design-demo.md'),
      'top-level design-demo.md is tracked on branch');
    assertTrue(!listed.includes('work-sessions/demo/session.md'),
      'branch no longer tracks ghost work-sessions/demo/session.md');

    const log = execSync('git log --oneline feature/demo', { cwd: root }).toString();
    assertTrue(log.includes('migrate session content into worktree'),
      'branch has migration commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Idempotency: re-running on an already-migrated session is a no-op.
{
  const root = buildFixture();
  try {
    migrateSession(root, 'demo');
    const result = migrateSession(root, 'demo');
    assertEq(result.status, 'already-migrated', 'second run reports already-migrated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// migrateMain updates .gitignore, git rm --cached's tracker paths, bumps
// templateVersion, and commits on main.
{
  const root = buildFixture();
  try {
    migrateSession(root, 'demo');
    const result = migrateMain(root);
    assertEq(result.status, 'migrated', 'main migration returns migrated');

    const gi = readFileSync(join(root, '.gitignore'), 'utf-8');
    assertTrue(gi.includes('work-sessions/'), '.gitignore has work-sessions/ line');
    assertTrue(!gi.includes('!work-sessions/*/session.md'),
      '.gitignore exception removed');

    const mainTracked = execSync('git ls-files', { cwd: root }).toString();
    assertTrue(!mainTracked.includes('work-sessions/demo/session.md'),
      'main no longer tracks work-sessions/demo/session.md');
    assertTrue(!mainTracked.includes('work-sessions/demo/design-demo.md'),
      'main no longer tracks work-sessions/demo/design-demo.md');

    const ws = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf-8'));
    assertEq(ws.workspace.templateVersion, '0.9.0', 'templateVersion bumped to 0.9.0');

    const mainLog = execSync('git log --oneline main -1', { cwd: root }).toString();
    assertTrue(mainLog.includes('migrate workspace to in-worktree session layout'),
      'main has migration commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// CLI run from a payload-like nested location: --root must win over both the
// script's location and the cwd. The upgrade payload executes this file from
// <workspace>/.workspace-update/.claude/scripts/ — a script-relative root
// would migrate the payload directory instead of the workspace.
{
  const root = buildFixture();
  try {
    // Stage a payload-shaped copy: the whole .claude/scripts+hooks+lib tree,
    // as the real upgrade payload carries it.
    const payloadClaude = join(root, '.workspace-update', '.claude');
    mkdirSync(payloadClaude, { recursive: true });
    cpSync(here, join(payloadClaude, 'scripts'), { recursive: true });
    cpSync(join(here, '..', 'hooks'), join(payloadClaude, 'hooks'), { recursive: true });
    cpSync(join(here, '..', 'lib'), join(payloadClaude, 'lib'), { recursive: true });
    const nestedScript = join(payloadClaude, 'scripts', 'migrate-session-layout.mjs');

    const r = spawnSync(
      process.execPath,
      [nestedScript, '--session-name', 'demo', '--root', root],
      { cwd: tmpdir(), encoding: 'utf-8' },
    );
    assertEq(r.status, 0, `CLI exits 0 from nested payload location (stderr: ${r.stderr.trim().slice(0, 200)})`);
    const parsed = JSON.parse(r.stdout);
    assertEq(parsed.session.status, 'migrated', 'CLI migrated the --root workspace');

    const worktree = join(root, 'work-sessions', 'demo', 'workspace');
    assertTrue(existsSync(join(worktree, 'session.md')),
      'tracker landed in the --root workspace, not beside the script');
    assertTrue(!existsSync(join(root, '.workspace-update', 'work-sessions')),
      'nothing was created inside the payload directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Tracked filenames are untrusted input: a committed name carrying shell
// syntax (command substitution, backticks, spaces) must reach git as a
// literal argument. The payloads would create files named PWNED and PWNED2
// in whichever directory git ran; neither may exist anywhere afterwards.
// (`"` is not a legal Windows filename character, so it is not used here.)
{
  const specs = ['design-$(touch PWNED).md', 'plan-`touch PWNED2`.md'];
  const root = buildFixture(specs);
  try {
    const worktree = join(root, 'work-sessions', 'demo', 'workspace');
    const lsFiles = (cwd) =>
      execFileSync('git', ['ls-files', '-z'], { cwd }).toString().split('\0').filter(Boolean);
    const findPwned = (dir) => {
      const hits = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.name === '.git') continue;
          if (/^PWNED/.test(e.name)) hits.push(join(d, e.name));
          if (e.isDirectory()) walk(join(d, e.name));
        }
      };
      walk(dir);
      return hits;
    };

    const result = migrateSession(root, 'demo');
    assertEq(result.status, 'migrated', 'session with shell-syntax filenames migrates');
    const inBranch = lsFiles(worktree);
    for (const name of specs) {
      assertTrue(inBranch.includes(name), `worktree tracks ${name} at its top level`);
    }
    assertTrue(!inBranch.some((f) => f.startsWith('work-sessions/')),
      'branch no longer tracks any ghost, including the shell-syntax names');

    const main = migrateMain(root);
    assertEq(main.status, 'migrated', 'main migration with shell-syntax filenames succeeds');
    assertTrue(!lsFiles(root).some((f) => f.startsWith('work-sessions/')),
      'main no longer tracks any session file, including the shell-syntax names');
    assertEq(findPwned(root), [], 'no payload ran in the launcher or the worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A filename is a literal path, not a glob: `design-[a].md` must be staged
// and removed on its own, never together with the unrelated `design-a.md`
// that the pattern `design-[a].md` would also match.
{
  const specs = ['design-[a].md', 'design-a.md'];
  const root = buildFixture(specs);
  try {
    const worktree = join(root, 'work-sessions', 'demo', 'workspace');
    const lsFiles = (cwd) =>
      execFileSync('git', ['ls-files', '-z'], { cwd }).toString().split('\0').filter(Boolean);

    let result;
    try {
      result = migrateSession(root, 'demo');
    } catch (err) {
      result = { status: `threw: ${String(err.message).split('\n')[0]}` };
    }
    assertEq(result.status, 'migrated', 'session with glob-character filenames migrates');
    const inBranch = lsFiles(worktree);
    for (const name of specs) {
      assertTrue(inBranch.includes(name), `worktree tracks ${name} at its top level`);
    }
    assertTrue(!inBranch.some((f) => f.startsWith('work-sessions/')),
      'branch no longer tracks any ghost, glob-character names included');

    let main;
    try {
      main = migrateMain(root);
    } catch (err) {
      main = { status: `threw: ${String(err.message).split('\n')[0]}` };
    }
    assertEq(main.status, 'migrated', 'main migration with glob-character filenames succeeds');
    assertEq(main.removed?.length, 4, 'main untracks the tracker and all three specs, each by its own path');
    assertTrue(!lsFiles(root).some((f) => f.startsWith('work-sessions/')),
      'main no longer tracks any session file, glob-character names included');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
