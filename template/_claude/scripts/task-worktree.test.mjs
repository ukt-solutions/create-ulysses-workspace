#!/usr/bin/env node
// Tests for task-worktree.mjs
// Run: node .claude/scripts/task-worktree.test.mjs
//
// Every case builds its fixture with real git under tmpdir — the worktree
// add/remove/prune mechanics exercised here are the ones users get. Git
// config is isolated (no global/system file) and the identity pinned in
// the env, so the suite behaves the same on any machine.

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slugForBranch, taskWorktreePath, createTaskWorktree, removeTaskWorktree,
  detectWorkModel, parseArgs, defaultBranchFor,
} from './task-worktree.mjs';
import { reconcile, addTask } from './chat-record.mjs';

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

// Isolate git config so a developer's global hooks/aliases/identity cannot
// change behavior, and pin an identity so commits work with no user config.
const GIT_CFG = mkdtempSync(join(tmpdir(), 'task-git-cfg-'));
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(GIT_CFG, 'global'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');

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

// A bare origin wired to repos/app, with main pushed.
function makeOrigin(app) {
  const bare = mkdtempSync(join(tmpdir(), 'task-origin-'));
  git(app, `init -q --bare "${join(bare, 'origin.git')}"`);
  git(app, `remote add origin "${join(bare, 'origin.git')}"`);
  git(app, 'push -q origin main');
  return bare;
}

// A workspace root that is itself a git repo (the launcher) with an origin
// bare remote — the shape repo "." operates on. The .gitignore carries the
// template's .claude/worktrees/ line, and no refs/remotes/origin/HEAD is
// set, so the default-branch fallback is "main" until a test sets one.
function makeLauncherRoot() {
  const root = mkdtempSync(join(tmpdir(), 'task-worktree-'));
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({
    workspace: { name: 'fixture' },
    repos: {},
  }, null, 2));
  git(root, 'init -q -b main');
  writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\n');
  writeFileSync(join(root, 'README.md'), '# launcher\n');
  git(root, 'add -A');
  git(root, 'commit -q -m init');
  const bare = makeOrigin(root);
  return { root, bare };
}

const clean = (r) => rmSync(r, { recursive: true, force: true });
const real = (p) => realpathSync(p);

console.log('# slug and path');
{
  assertEq(slugForBranch('feature/foo-bar'), 'feature-foo-bar', 'slash becomes dash');
  assertEq(slugForBranch('main'), 'main', 'plain branch unchanged');
  assertEq(
    taskWorktreePath('/w', 'app', 'feature/x'),
    join('/w', 'repos', 'app', '.claude', 'worktrees', 'feature-x'),
    'path is the native worktree location',
  );
  assertEq(
    taskWorktreePath('/w', '.', 'feature/x'),
    join('/w', '.claude', 'worktrees', 'feature-x'),
    'workspace repo path is the native worktree location at the root',
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
    throws(() => createTaskWorktree(root, { repo: 'app', branch: 'bad..name' }), 'invalid branch name rejected');
    throws(() => createTaskWorktree(root, { repo: 'nope', branch: 'b' }), 'unknown repo throws');
  } finally { clean(root); }
}

console.log('# base prefers origin/{defaultBranch} when the remote ref exists');
{
  const { root, app } = makeRoot();
  const bare = makeOrigin(app);
  try {
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

console.log('# a repo with no origin bases the worktree on the local default branch');
{
  const { root, app } = makeRoot(); // makeRoot wires no origin — local mode (gh:173)
  try {
    // Advance the local default branch itself: with no origin there is no
    // fresher ref the base could be, so the worktree must land on this.
    writeFileSync(join(app, 'later.txt'), 'local advance\n');
    git(app, 'add -A');
    git(app, 'commit -q -m local-advance');
    const res = createTaskWorktree(root, { repo: 'app', branch: 'feature/no-remote' });
    assertEq(git(res.path, 'log -1 --format=%s').trim(), 'local-advance', 'worktree started from the local default branch');
    assertEq(git(res.path, 'rev-parse --abbrev-ref HEAD').trim(), 'feature/no-remote', 'worktree is on the task branch');
    assert(!gitOk(app, 'rev-parse --abbrev-ref "feature/no-remote@{u}"'), 'no upstream without an origin');
  } finally { clean(root); }
}

console.log('# new branches do not track the base');
{
  const { root, app } = makeRoot();
  const bare = makeOrigin(app);
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/no-track' });
    assert(!gitOk(app, 'rev-parse --abbrev-ref "feature/no-track@{u}"'), 'no upstream configured for the new branch');
  } finally { clean(root); clean(bare); }
}

console.log('# a remote-only branch resumes tracked from origin');
{
  const { root, app } = makeRoot();
  const bare = makeOrigin(app);
  try {
    // Build the branch, push it, then delete every local trace: the task
    // now exists only on the remote, as if started on another machine.
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/remote' });
    writeFileSync(join(wt.path, 'work.txt'), 'remote work\n');
    git(wt.path, 'add -A');
    git(wt.path, 'commit -q -m "remote work"');
    git(wt.path, 'push -q origin feature/remote');
    removeTaskWorktree(root, { repo: 'app', branch: 'feature/remote', deleteBranch: true });
    assert(!gitOk(app, 'show-ref --verify --quiet refs/heads/feature/remote'), 'local branch gone — remote-only now');

    const again = createTaskWorktree(root, { repo: 'app', branch: 'feature/remote' });
    assertEq(git(again.path, 'rev-parse --abbrev-ref HEAD').trim(), 'feature/remote', 'branch recreated');
    assertEq(git(again.path, 'log -1 --format=%s').trim(), 'remote work', 'landed on the remote commit');
    assertEq(git(app, 'rev-parse --abbrev-ref "feature/remote@{u}"').trim(), 'origin/feature/remote', 'upstream tracks origin');
  } finally { clean(root); clean(bare); }
}

console.log('# a hung origin fetch does not fail create');
{
  const { root } = makeRoot();
  try {
    // spawnSync with a timeout returns an error object (ETIMEDOUT) rather
    // than a status; create must treat that as "offline", not as a failure.
    const hungFetchGitFn = (cmd, args, opts) => (
      args.includes('fetch')
        ? { status: null, error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
        : spawnSync(cmd, args, { encoding: 'utf8', ...opts })
    );
    const res = createTaskWorktree(root, { repo: 'app', branch: 'feature/hang', gitFn: hungFetchGitFn });
    assert(res.created === true, 'create succeeds despite the hung fetch');
    assertEq(git(res.path, 'rev-parse --abbrev-ref HEAD').trim(), 'feature/hang', 'worktree is on the branch');
  } finally { clean(root); }
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

console.log('# a worktree directory deleted out of band recovers on create');
{
  const { root, app } = makeRoot();
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/stale' });
    rmSync(wt.path, { recursive: true, force: true }); // stale record remains
    const again = createTaskWorktree(root, { repo: 'app', branch: 'feature/stale' });
    assert(again.created === true, 'create succeeds over a stale worktree record');
    const lines = git(app, 'worktree list --porcelain').split(/\r?\n/)
      .filter((l) => l.startsWith('worktree ') && l.endsWith('feature-stale'));
    assertEq(lines.length, 1, 'exactly one record for the path — prune ran');
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
    assert(!listed.includes('.claude/worktrees'), 'no orphan worktree record — prune ran');
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

console.log('# remove refuses a slug collision (M5)');
{
  const { root } = makeRoot();
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/y' }); // slug: feature-y
    throws(() => removeTaskWorktree(root, { repo: 'app', branch: 'feature-y' }), 'colliding branch name refuses remove');
    assert(existsSync(taskWorktreePath(root, 'app', 'feature/y')), 'the real worktree is untouched');
    const res = removeTaskWorktree(root, { repo: 'app', branch: 'feature/y' });
    assert(res.removed === true, 'the real branch removes');
  } finally { clean(root); }
}

console.log('# deleteBranch removes the local branch after the worktree');
{
  const { root, app } = makeRoot();
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/bye' });
    const res = removeTaskWorktree(root, { repo: 'app', branch: 'feature/bye', deleteBranch: true });
    assert(res.removed === true, 'worktree removed');
    assert(res.branchDeleted === true, 'branch deletion reported');
    assert(!gitOk(app, 'show-ref --verify --quiet refs/heads/feature/bye'), 'local branch deleted');
  } finally { clean(root); }
}

console.log('# a retry after a hand-deleted worktree still honors deleteBranch');
{
  const { root, app } = makeRoot();
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/leak' });
    rmSync(taskWorktreePath(root, 'app', 'feature/leak'), { recursive: true, force: true });
    const res = removeTaskWorktree(root, { repo: 'app', branch: 'feature/leak', deleteBranch: true });
    assert(res.removed === false, 'no worktree to remove');
    assert(res.branchDeleted === true, 'but the branch is deleted — no leak');
    assert(!gitOk(app, 'show-ref --verify --quiet refs/heads/feature/leak'), 'branch ref gone');
    const again = removeTaskWorktree(root, { repo: 'app', branch: 'feature/leak', deleteBranch: true });
    assertEq(again.branchDeleted, false, 'an empty retry reports branchDeleted: false without throwing');
  } finally { clean(root); }
}

console.log('# workspace repo ("."): create, idempotency, collisions, remove');
{
  const { root, bare } = makeLauncherRoot();
  try {
    const res = createTaskWorktree(root, { repo: '.', branch: 'feature/ws' });
    assert(res.created === true, 'created flag set');
    assertEq(res.path, taskWorktreePath(root, '.', 'feature/ws'), 'worktree path returned');
    assertEq(res.path, join(root, '.claude', 'worktrees', 'feature-ws'), 'worktree at the native location at the root');
    assertEq(git(res.path, 'rev-parse --abbrev-ref HEAD').trim(), 'feature/ws', 'worktree is on the task branch');
    assert(gitOk(root, 'show-ref --verify --quiet refs/heads/feature/ws'), 'branch exists in the workspace repo');

    const again = createTaskWorktree(root, { repo: '.', branch: 'feature/ws' });
    assert(again.created === false, 're-create reports created: false');
    assertEq(again.path, res.path, 'same path returned');

    // The slug is lossy here too — a colliding branch name must refuse.
    throws(() => createTaskWorktree(root, { repo: '.', branch: 'feature-ws' }), 'same path on another branch throws');

    const rm = removeTaskWorktree(root, { repo: '.', branch: 'feature/ws' });
    assert(rm.removed === true, 'removed flag set');
    assert(!existsSync(rm.path), 'worktree directory gone');
    assert(gitOk(root, 'show-ref --verify --quiet refs/heads/feature/ws'), 'branch survives remove');
  } finally { clean(root); clean(bare); }
}

console.log('# workspace repo: no .git/info/exclude write when .gitignore covers the path');
{
  const { root, bare } = makeLauncherRoot();
  try {
    createTaskWorktree(root, { repo: '.', branch: 'feature/no-exclude' });
    // git init ships an exclude file with template comments — what must not
    // appear is our line: the workspace .gitignore covers the path instead.
    const excludePath = join(root, '.git', 'info', 'exclude');
    const content = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    assert(!content.split(/\r?\n/).includes('.claude/worktrees/'), 'no exclude line written for "."');
  } finally { clean(root); clean(bare); }
}

console.log('# workspace repo: a legacy .gitignore without the line gets the exclude');
{
  const { root, bare } = makeLauncherRoot();
  try {
    // A workspace created before the .claude/worktrees/ line shipped: the
    // worktree would stage as an embedded repo on the next `git add -A` at
    // the launcher unless the machine-local exclude covers it.
    writeFileSync(join(root, '.gitignore'), 'repos\n');
    createTaskWorktree(root, { repo: '.', branch: 'feature/legacy' });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8');
    assert(exclude.split(/\r?\n/).includes('.claude/worktrees/'), 'exclude line written as a safety net');
    assertEq(git(root, 'check-ignore -q .claude/worktrees/probe && echo ignored').trim(), 'ignored', 'git now ignores the worktree path');
  } finally { clean(root); clean(bare); }
}

console.log('# workspace repo: default branch from origin HEAD, main fallback');
{
  const { root, bare } = makeLauncherRoot();
  try {
    // Point origin's HEAD at trunk so the resolution is observable — a
    // hardcoded "main" cannot land a worktree on the trunk-only commit.
    git(root, 'checkout -q -b trunk');
    writeFileSync(join(root, 'trunk.txt'), 'from trunk\n');
    git(root, 'add -A');
    git(root, 'commit -q -m trunk-advance');
    git(root, 'push -q origin trunk');
    git(root, 'checkout -q main');
    git(root, 'remote set-head origin trunk');
    assertEq(defaultBranchFor(root, '.'), 'trunk', 'origin HEAD resolves the default branch');

    const res = createTaskWorktree(root, { repo: '.', branch: 'feature/on-trunk' });
    assertEq(git(res.path, 'log -1 --format=%s').trim(), 'trunk-advance', 'worktree started from origin/trunk, not the stale local main');

    // Without refs/remotes/origin/HEAD the fallback is main.
    git(root, 'remote set-head origin -d');
    assertEq(defaultBranchFor(root, '.'), 'main', 'unset origin HEAD falls back to main');
  } finally { clean(root); clean(bare); }
}

console.log('# deleteBranch refuses the default branch, workspace and project alike');
{
  const { root, bare } = makeLauncherRoot();
  try {
    // main is the workspace's default branch (no origin HEAD set → main
    // fallback) — even with a detached-HEAD launcher that no worktree
    // check would protect, deletion must refuse up front.
    throws(() => removeTaskWorktree(root, { repo: '.', branch: 'main', deleteBranch: true }), 'workspace default branch refuses deleteBranch');
    assert(gitOk(root, 'show-ref --verify --quiet refs/heads/main'), 'main survives');

    createTaskWorktree(root, { repo: '.', branch: 'feature/bye' });
    const rm = removeTaskWorktree(root, { repo: '.', branch: 'feature/bye', deleteBranch: true });
    assertEq(rm.branchDeleted, true, 'a task branch deletes after the worktree');
    assert(!gitOk(root, 'show-ref --verify --quiet refs/heads/feature/bye'), 'local branch deleted');
  } finally { clean(root); clean(bare); }
}

console.log('# deleteBranch refuses a project repo\'s configured default branch');
{
  const { root } = makeRoot(); // repos.app is configured with branch: main
  try {
    createTaskWorktree(root, { repo: 'app', branch: 'feature/keep' });
    throws(() => removeTaskWorktree(root, { repo: 'app', branch: 'main', deleteBranch: true }), 'configured default branch refuses deleteBranch');
    assert(gitOk(join(root, 'repos', 'app'), 'show-ref --verify --quiet refs/heads/main'), 'app main survives');
  } finally { clean(root); }
}

console.log('# a stale non-worktree directory under worktrees/ detects as none');
{
  const { root } = makeRoot();
  try {
    // A plain directory squatting under .claude/worktrees/ must not detect
    // as a task: rev-parse from inside it resolves to the repo around it —
    // for the workspace layout, to the launcher itself, whose main a naive
    // detect would then rebase and push (gh:146 round 1, S5).
    const wsLeftover = join(root, '.claude', 'worktrees', 'leftover');
    mkdirSync(wsLeftover, { recursive: true });
    assertEq(detectWorkModel(wsLeftover, root).model, 'none', 'a stale directory at {root}/.claude/worktrees detects as none');

    const projLeftover = join(root, 'repos', 'app', '.claude', 'worktrees', 'leftover');
    mkdirSync(projLeftover, { recursive: true });
    assertEq(detectWorkModel(projLeftover, root).model, 'none', 'a stale directory at repos/{repo}/.claude/worktrees detects as none');

    // A real worktree beside the leftovers still detects.
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/real' });
    assertEq(detectWorkModel(wt.path, root).model, 'task', 'a real worktree beside the leftovers still detects');
  } finally { clean(root); }
}

console.log('# a workspace worktree on the default branch never detects as a task');
{
  const { root, bare } = makeLauncherRoot();
  try {
    // If origin's HEAD names trunk the default is trunk — a worktree on
    // trunk is the launcher's own line of work, not a task.
    git(root, 'checkout -q -b trunk');
    git(root, 'push -q origin trunk');
    git(root, 'checkout -q main');
    git(root, 'remote set-head origin trunk');
    const wt = createTaskWorktree(root, { repo: '.', branch: 'trunk' });
    assertEq(detectWorkModel(wt.path, root).model, 'none', 'the default branch does not surface as a task');
  } finally { clean(root); clean(bare); }
}

console.log('# workspace repo: detection from inside the worktree');
{
  const { root, bare } = makeLauncherRoot();
  try {
    reconcile(root, { sessionId: 'sid-w', name: 'wsworker' });
    addTask(root, 'wsworker', { workItem: 'gh:9', branch: 'feature/ws-det', repo: '.' });
    const wt = createTaskWorktree(root, { repo: '.', branch: 'feature/ws-det' });

    assertEq(
      detectWorkModel(wt.path, root, { chat: 'wsworker' }),
      {
        model: 'task', source: 'worktree', repo: '.', branch: 'feature/ws-det',
        path: join(real(root), '.claude', 'worktrees', 'feature-ws-det'),
        tasks: [{ workItem: 'gh:9', branch: 'feature/ws-det', repo: '.' }],
      },
      'workspace task worktree detects with its matching record tasks',
    );
    assertEq(detectWorkModel(root, root, { chat: 'wsworker' }).source, 'chat-record', 'at the launcher the record drives detection');
    assertEq(detectWorkModel(join(root, '.claude'), root).model, 'none', '.claude itself is none');
    assertEq(detectWorkModel(join(root, '.claude', 'worktrees'), root).model, 'none', '.claude/worktrees itself is none');
  } finally { clean(root); clean(bare); }
}

console.log('# workspace repo: CLI --repo "." round-trip');
{
  const { root, bare } = makeLauncherRoot();
  try {
    const script = fileURLToPath(new URL('./task-worktree.mjs', import.meta.url));
    const out = JSON.parse(execFileSync(
      process.execPath, [script, '--root', root, '--create', '--repo', '.', '--branch', 'feature/cli-ws'],
      { cwd: root, encoding: 'utf-8', env: ENV },
    ));
    assertEq(out.repo, '.', 'repo round-trips as "."');
    assertEq(out.path, join(root, '.claude', 'worktrees', 'feature-cli-ws'), 'worktree created at the native location');

    const det = JSON.parse(execFileSync(
      process.execPath, [script, '--root', root, '--detect', '--cwd', out.path],
      { cwd: root, encoding: 'utf-8', env: ENV },
    ));
    assertEq([det.model, det.source, det.repo, det.branch], ['task', 'worktree', '.', 'feature/cli-ws'], 'CLI --detect from inside the workspace worktree');

    const rm = JSON.parse(execFileSync(
      process.execPath, [script, '--root', root, '--remove', '--repo', '.', '--branch', 'feature/cli-ws'],
      { cwd: root, encoding: 'utf-8', env: ENV },
    ));
    assertEq(rm.removed, true, 'CLI --remove works for "."');
    assert(!existsSync(out.path), 'worktree gone');
  } finally { clean(root); clean(bare); }
}

console.log('# session layout and task worktree coexist and detect independently');
{
  const { root } = makeRoot();
  try {
    // Detection resolves real paths, so expectations must too — on macOS
    // the tmpdir lives behind the /var -> /private/var symlink.
    const realRoot = real(root);
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
      { model: 'task', source: 'worktree', repo: 'app', branch: 'feature/both', path: join(realRoot, 'repos', 'app', '.claude', 'worktrees', 'feature-both') },
      'task worktree detects as task with its branch',
    );
    const deep = join(wt.path, 'sub', 'dir');
    mkdirSync(deep, { recursive: true });
    assertEq(detectWorkModel(deep, root).model, 'task', 'deep inside the task worktree is still task');
    assertEq(detectWorkModel(root, root).model, 'none', 'the workspace root itself is none');
    assertEq(detectWorkModel(join(root, 'repos', 'app'), root).model, 'none', 'the source clone is none');
    assertEq(detectWorkModel(join(root, 'work-sessions', 'alpha'), root).model, 'none', 'session folder without workspace/ is none');
  } finally { clean(root); }
}

console.log('# detection from inside a real session worktree');
{
  const { root } = makeRoot();
  try {
    // A workspace repo at the root, with a REAL session worktree under
    // work-sessions/{name}/workspace — the old model's own layout.
    git(root, 'init -q -b main');
    writeFileSync(join(root, '.gitignore'), 'repos\nwork-sessions\n');
    git(root, 'add -A');
    git(root, 'commit -q -m init');
    const wsWt = join(root, 'work-sessions', 'alpha', 'workspace');
    git(root, 'worktree add -q -b "session/alpha" "work-sessions/alpha/workspace"');
    const expected = { model: 'session', sessionName: 'alpha', workspaceDir: real(wsWt) };
    assertEq(detectWorkModel(wsWt, root), expected, 'root = launcher detects session');
    assertEq(detectWorkModel(wsWt, join(root, 'work-sessions', 'alpha')), expected, 'root = session dir detects session');
    assertEq(detectWorkModel(wsWt, wsWt), expected, 'root = the session worktree itself detects session');
    // And a task worktree elsewhere in the same root still detects as task.
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/side' });
    assertEq(detectWorkModel(wt.path, root).model, 'task', 'task worktree still detects as task');
  } finally { clean(root); }
}

console.log('# detached HEAD reports branch null');
{
  const { root } = makeRoot();
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/detach' });
    git(wt.path, 'checkout -q --detach');
    const d = detectWorkModel(wt.path, root);
    assertEq(d.model, 'task', 'still a task worktree');
    assertEq(d.branch, null, 'detached HEAD reports branch null');
  } finally { clean(root); }
}

console.log('# detection with a chat name finds record tasks (H1)');
{
  const { root } = makeRoot();
  try {
    reconcile(root, { sessionId: 'sid-1', name: 'worker' });
    addTask(root, 'worker', { workItem: 'gh:5', branch: 'feature/rec', repo: 'app' });

    // At the launcher: cwd is the root itself — only the record knows.
    const atRoot = detectWorkModel(root, root, { chat: 'worker' });
    assertEq(atRoot.model, 'task', 'record tasks make the root detect as task');
    assertEq(atRoot.source, 'chat-record', 'source is the chat record');
    assertEq(atRoot.tasks, [{ workItem: 'gh:5', branch: 'feature/rec', repo: 'app' }], 'the record tasks are returned');

    // Inside the matching worktree: the branch matches, so tasks attach.
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/rec' });
    const inWt = detectWorkModel(wt.path, root, { chat: 'worker' });
    assertEq(inWt.model, 'task', 'worktree detects as task');
    assertEq(inWt.source, 'worktree', 'source is the worktree');
    assertEq(inWt.tasks, [{ workItem: 'gh:5', branch: 'feature/rec', repo: 'app' }], 'matching tasks attached');

    // A record with no tasks does not make the root a task.
    reconcile(root, { sessionId: 'sid-2', name: 'idle' });
    assertEq(detectWorkModel(root, root, { chat: 'idle' }).model, 'none', 'empty record is none');
    assertEq(detectWorkModel(root, root, { chat: 'ghost' }).model, 'none', 'missing record is none');
  } finally { clean(root); }
}

console.log('# parseArgs validation');
{
  throws(() => parseArgs(['node', 's']), 'a mode is required');
  throws(() => parseArgs(['node', 's', '--create', '--remove', '--repo', 'app', '--branch', 'b']), 'two modes rejected');
  throws(() => parseArgs(['node', 's', '--create', '--repo', 'app', '--branch', 'b', '--root']), 'dangling value flag rejected');
  throws(() => parseArgs(['node', 's', '--create', '--repo', 'app', '--branch', '--force']), 'flag-looking value rejected');
  throws(() => parseArgs(['node', 's', '--create', '--repo', 'a/b', '--branch', 'b']), 'repo with a slash rejected');
  throws(() => parseArgs(['node', 's', '--create', '--repo', '..', '--branch', 'b']), 'repo ".." rejected');
  throws(() => parseArgs(['node', 's', '--create', '--repo', './x', '--branch', 'b']), 'repo "./x" rejected');
  throws(() => parseArgs(['node', 's', '--create', '--repo', '/abs', '--branch', 'b']), 'absolute repo rejected');
  const ws = parseArgs(['node', 's', '--root', '/w', '--create', '--repo', '.', '--branch', 'feature/x']);
  assertEq([ws.mode, ws.repo, ws.branch], ['create', '.', 'feature/x'], '"." parses as the workspace repo');
  const ok = parseArgs(['node', 's', '--root', '/w', '--create', '--repo', 'app', '--branch', 'feature/x', '--base', 'main']);
  assertEq([ok.root, ok.mode, ok.repo, ok.branch, ok.base], ['/w', 'create', 'app', 'feature/x', 'main'], 'valid create args parse');
  const rm = parseArgs(['node', 's', '--remove', '--repo', 'app', '--branch', 'b', '--force', '--delete-branch']);
  assert(rm.force === true && rm.deleteBranch === true, 'force and delete-branch flags parse');
  const det = parseArgs(['node', 's', '--detect', '--chat', 'worker']);
  assertEq([det.mode, det.chat, det.cwd], ['detect', 'worker', null], 'detect parses chat, defaults cwd');
}

console.log('# parseArgs mode/flag pairing');
{
  throws(() => parseArgs(['node', 's', '--delete-branch', '--repo', 'app', '--branch', 'b']), '--delete-branch without --remove rejected');
  throws(() => parseArgs(['node', 's', '--create', '--repo', 'app']), '--create needs a branch');
  throws(() => parseArgs(['node', 's', '--remove', '--branch', 'b']), '--remove needs a repo');
  throws(() => parseArgs(['node', 's', '--detect', '--bogus']), 'unknown flag rejected');
}

console.log('# CLI round-trip');
{
  const { root } = makeRoot();
  try {
    reconcile(root, { sessionId: 'sid-1', name: 'worker' });
    addTask(root, 'worker', { workItem: 'gh:7', branch: 'feature/cli', repo: 'app' });
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/cli' });
    const script = fileURLToPath(new URL('./task-worktree.mjs', import.meta.url));

    const fromWt = JSON.parse(execFileSync(
      process.execPath, [script, '--root', root, '--detect', '--chat', 'worker'],
      { cwd: wt.path, encoding: 'utf-8', env: ENV },
    ));
    assertEq(fromWt.model, 'task', 'CLI --detect from a worktree reports task');
    assertEq(fromWt.branch, 'feature/cli', 'CLI --detect reports the branch');
    assertEq(fromWt.tasks.length, 1, 'CLI --detect attaches the matching record tasks');

    const fromRoot = JSON.parse(execFileSync(
      process.execPath, [script, '--root', root, '--detect', '--chat', 'worker'],
      { cwd: root, encoding: 'utf-8', env: ENV },
    ));
    assertEq(fromRoot.source, 'chat-record', 'CLI --detect --chat from the launcher uses the record');
    assertEq(fromRoot.tasks, [{ workItem: 'gh:7', branch: 'feature/cli', repo: 'app' }], 'CLI returns the record tasks');

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
