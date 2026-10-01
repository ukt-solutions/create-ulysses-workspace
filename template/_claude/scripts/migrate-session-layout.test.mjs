#!/usr/bin/env node
// Tests for migrate-session-layout.mjs
// Run: node .claude/scripts/migrate-session-layout.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { migrateSession, migrateMain } from './migrate-session-layout.mjs';

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
// Uses real git so we test end-to-end.
function buildFixture() {
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
  writeFileSync(join(root, 'work-sessions', 'demo', 'design-demo.md'),
    '---\ntopic: demo\n---\n\nspec body\n');
  execSync('git add work-sessions/demo/session.md work-sessions/demo/design-demo.md && git commit -q -m "add demo tracker and spec"',
    { cwd: root });

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

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
