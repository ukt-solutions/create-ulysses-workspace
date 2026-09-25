#!/usr/bin/env node
// Tests for task-worktree.mjs
// Run: node .claude/scripts/task-worktree.test.mjs
//
// Every case builds its fixture with real git under tmpdir — the worktree
// add/remove/prune mechanics exercised here are the ones users get. The git
// identity is pinned in the env because CI machines have none.

import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slugForBranch, taskWorktreePath, createTaskWorktree, removeTaskWorktree,
  detectWorkModel, parseArgs,
} from './task-worktree.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}`); }
}
function assertEq(a, e, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(e);
  if (x === y) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}\n    expected: ${y}\n    actual:   ${x}`); }
}
function throws(fn, msg) {
  try { fn(); failed += 1; console.error(`  FAIL: ${msg} (did not throw)`); } catch { passed += 1; }
}

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, args) {
  return execSync(`git -C "${cwd}" ${args}`, { stdio: 'pipe', encoding: 'utf-8', env: ENV });
}
function gitOk(cwd, args) {
  try { execSync(`git -C "${cwd}" ${args}`, { stdio: 'pipe', env: ENV }); return true; } catch { return false; }
}

// A workspace root with one project repo at repos/app on main.
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'task-worktree-'));
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({
    workspace: { name: 'fixture' },
    repos: { app: { branch: 'main', remote: 'none' } },
  }, null, 2));
  const app = join(root, 'repos', 'app');
  mkdirSync(app, { recursive: true });
  git(app, 'init -q -b main');
  writeFileSync(join(app, 'README.md'), '# app\n');
  git(app, 'add -A');
  git(app, 'commit -q -m init');
  return { root, app };
}

const clean = (r) => rmSync(r, { recursive: true, force: true });

console.log('# slug and path');
{
  assertEq(slugForBranch('feature/foo-bar'), 'feature-foo-bar', 'slash becomes dash');
  assertEq(slugForBranch('main'), 'main', 'plain branch unchanged');
  assertEq(
    taskWorktreePath('/w', 'app', 'feature/x'),
    join('/w', 'repos', 'app', '.claude', 'worktrees', 'feature-x'),
    'path is the native worktree location',
  );
}

console.log('# create');
{
  const { root, app } = makeRoot();
  try {
    const res = createTaskWorktree(root, { repo: 'app', branch: 'feature/one' });
    assert(res.created === true, 'created flag set');
    assertEq(res.path, taskWorktreePath(root, 'app', 'feature/one'), 'worktree path returned');
    assert(existsSync(res.path), 'worktree directory exists');
    assertEq(git(res.path, 'rev-parse --abbrev-ref HEAD').trim(), 'feature/one', 'worktree is on the task branch');
    assert(gitOk(app, 'show-ref --verify --quiet refs/heads/feature/one'), 'branch exists in the source repo');
  } finally { clean(root); }
}

console.log('# base prefers origin/{defaultBranch} when the remote ref exists');
{
  const { root, app } = makeRoot();
  const bare = mkdtempSync(join(tmpdir(), 'task-origin-'));
  try {
    git(app, `init -q --bare "${join(bare, 'origin.git')}"`);
    git(app, `remote add origin "${join(bare, 'origin.git')}"`);
    git(app, 'push -q origin main');
    // Move origin ahead, then wind the local clone back: the only way the
    // worktree lands on "advance" is if the base really was origin/main.
    writeFileSync(join(app, 'extra.txt'), 'from origin\n');
    git(app, 'add -A');
    git(app, 'commit -q -m advance');
    git(app, 'push -q origin main');
    git(app, 'reset -q --hard HEAD~1');
    const res = createTaskWorktree(root, { repo: 'app', branch: 'feature/from-origin' });
    assertEq(git(res.path, 'log -1 --format=%s').trim(), 'advance', 'worktree started from origin/main, not the stale local main');
  } finally { clean(root); clean(bare); }
}

console.log('# idempotent re-create');
{
  const { root } = makeRoot();
  try {
    const first = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    const second = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    assert(second.created === false, 're-create reports created: false');
    assertEq(second.path, first.path, 'same path returned');
    assertEq(git(second.path, 'rev-parse --abbrev-ref HEAD').trim(), 'feature/x', 'worktree still on the branch');
  } finally { clean(root); }
}

console.log('# a path held by anything else refuses');
{
  const { root } = makeRoot();
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/x' }); // slug: feature-x
    // 'feature-x' slugs to the same path — a collision, not idempotency.
    throws(() => createTaskWorktree(root, { repo: 'app', branch: 'feature-x' }), 'same path on another branch throws');
    // A plain directory squatting on the path is also a refusal.
    mkdirSync(taskWorktreePath(root, 'app', 'stray/one'), { recursive: true });
    throws(() => createTaskWorktree(root, { repo: 'app', branch: 'stray/one' }), 'non-worktree directory at the path throws');
    throws(() => createTaskWorktree(root, { repo: 'nope', branch: 'b' }), 'unknown repo throws');
  } finally { clean(root); }
}

console.log('# an existing branch is checked out, not recreated');
{
  const { root } = makeRoot();
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/keep' });
    removeTaskWorktree(root, { repo: 'app', branch: 'feature/keep' }); // branch survives
    const again = createTaskWorktree(root, { repo: 'app', branch: 'feature/keep' });
    assert(again.created === true, 're-create after remove creates a worktree');
    assertEq(git(again.path, 'rev-parse --abbrev-ref HEAD').trim(), 'feature/keep', 'existing branch checked out');
  } finally { clean(root); }
}

console.log('# the exclude line is added exactly once across creates');
{
  const { root, app } = makeRoot();
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/a' });
    createTaskWorktree(root, { repo: 'app', branch: 'feature/a' }); // idempotent path
    createTaskWorktree(root, { repo: 'app', branch: 'feature/b' }); // second worktree
    const exclude = readFileSync(join(app, '.git', 'info', 'exclude'), 'utf-8');
    const count = exclude.split(/\r?\n/).filter((l) => l === '.claude/worktrees/').length;
    assertEq(count, 1, 'exclude line appears exactly once');
  } finally { clean(root); }
}

console.log('# remove clean');
{
  const { root, app } = makeRoot();
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/gone' });
    const res = removeTaskWorktree(root, { repo: 'app', branch: 'feature/gone' });
    assert(res.removed === true, 'removed flag set');
    assert(!existsSync(res.path), 'worktree directory gone');
    const listed = git(app, 'worktree list --porcelain');
    assert(!listed.includes(join('.claude', 'worktrees')), 'no orphan worktree record — prune ran');
    assert(gitOk(app, 'show-ref --verify --quiet refs/heads/feature/gone'), 'branch survives remove');
  } finally { clean(root); }
}

console.log('# remove refuses dirty work unless forced');
{
  const { root } = makeRoot();
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/dirty' });
    writeFileSync(join(wt.path, 'untracked.txt'), 'loose ends\n');
    throws(() => removeTaskWorktree(root, { repo: 'app', branch: 'feature/dirty' }), 'dirty worktree refuses remove');
    assert(existsSync(wt.path), 'worktree still there after the refusal');
    const forced = removeTaskWorktree(root, { repo: 'app', branch: 'feature/dirty', force: true });
    assert(forced.removed === true, 'force removes a dirty worktree');
    assert(!existsSync(wt.path), 'directory gone after force');
  } finally { clean(root); }
}

console.log('# remove missing is a no-op');
{
  const { root } = makeRoot();
  try {
    const res = removeTaskWorktree(root, { repo: 'app', branch: 'feature/never' });
    assert(res.removed === false, 'missing worktree reports removed: false');
  } finally { clean(root); }
}

console.log('# session layout and task worktree coexist and detect independently');
{
  const { root } = makeRoot();
  try {
    // Detection resolves real paths, so expectations must too — on macOS
    // the tmpdir lives behind the /var -> /private/var symlink.
    const realRoot = realpathSync(root);
    // An old-model session layout...
    const wsDir = join(realRoot, 'work-sessions', 'alpha', 'workspace');
    mkdirSync(join(root, 'work-sessions', 'alpha', 'workspace', 'repos', 'app'), { recursive: true });
    // ...and a task worktree, in the same root, at the same time.
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/both' });

    assertEq(
      detectWorkModel(join(root, 'work-sessions', 'alpha', 'workspace'), root),
      { model: 'session', sessionName: 'alpha', workspaceDir: wsDir },
      'session workspace detects as session',
    );
    assertEq(
      detectWorkModel(join(wsDir, 'repos', 'app'), root),
      { model: 'session', sessionName: 'alpha', workspaceDir: wsDir },
      'inside a nested project worktree is still session',
    );
    assertEq(
      detectWorkModel(wt.path, root),
      { model: 'task', repo: 'app', branch: 'feature/both', path: join(realRoot, 'repos', 'app', '.claude', 'worktrees', 'feature-both') },
      'task worktree detects as task with its branch',
    );
    const deep = join(wt.path, 'sub', 'dir');
    mkdirSync(deep, { recursive: true });
    assertEq(detectWorkModel(deep, root).model, 'task', 'deep inside the task worktree is still task');
    assertEq(detectWorkModel(root, root), { model: 'none' }, 'the workspace root itself is none');
    assertEq(detectWorkModel(join(root, 'repos', 'app'), root).model, 'none', 'the source clone is none');
    assertEq(detectWorkModel(join(root, 'work-sessions', 'alpha'), root).model, 'none', 'session folder without workspace/ is none');
  } finally { clean(root); }
}

console.log('# parseArgs validation');
{
  throws(() => parseArgs(['node', 's']), 'a mode is required');
  throws(() => parseArgs(['node', 's', '--create', '--repo', 'app']), '--create needs a branch');
  throws(() => parseArgs(['node', 's', '--remove', '--branch', 'b']), '--remove needs a repo');
  throws(() => parseArgs(['node', 's', '--detect', '--bogus']), 'unknown flag rejected');
  const ok = parseArgs(['node', 's', '--root', '/w', '--create', '--repo', 'app', '--branch', 'feature/x', '--base', 'main']);
  assertEq([ok.root, ok.mode, ok.repo, ok.branch, ok.base], ['/w', 'create', 'app', 'feature/x', 'main'], 'valid create args parse');
  const rm = parseArgs(['node', 's', '--remove', '--repo', 'app', '--branch', 'b', '--force']);
  assert(rm.force === true, 'force flag parses');
  const det = parseArgs(['node', 's', '--detect']);
  assertEq([det.mode, det.cwd], ['detect', null], 'detect leaves cwd to be filled from process.cwd()');
}

console.log('# CLI round-trip');
{
  const { root } = makeRoot();
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/cli' });
    const script = fileURLToPath(new URL('./task-worktree.mjs', import.meta.url));
    const out = JSON.parse(execFileSync(
      process.execPath,
      [script, '--root', root, '--detect'],
      { cwd: wt.path, encoding: 'utf-8', env: ENV },
    ));
    assertEq(out.model, 'task', 'CLI --detect from a worktree reports task');
    assertEq(out.branch, 'feature/cli', 'CLI --detect reports the branch');
    let exit = null;
    try {
      execFileSync(process.execPath, [script, '--root', root, '--bogus'], { encoding: 'utf-8', env: ENV });
    } catch (err) {
      exit = err.status;
    }
    assertEq(exit, 2, 'CLI errors exit 2');
  } finally { clean(root); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
