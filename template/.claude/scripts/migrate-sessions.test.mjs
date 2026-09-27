#!/usr/bin/env node
// Tests for migrate-sessions.mjs (gh:147)
// Run: node .claude/scripts/migrate-sessions.test.mjs
//
// Every case builds its fixture with real git under tmpdir — the same
// worktree/branch/remote mechanics users get, including bare repos as
// remotes so ls-remote, tag pushes, and the never-delete-a-remote
// guarantees are exercised for real. Git config is isolated (no
// global/system file) and the identity pinned IN PROCESS.ENV, because
// unlike task-worktree's suite this module also spawns git internally
// (and spawns cleanup-work-session.mjs as a child) — env inheritance is
// the only isolation that reaches all of those processes.
//
// Round 2 adds the teardown-invariant fixtures (drift, detached HEADs,
// unresolvable default branches, ignored files, rebases in progress,
// symlinked and foreign entries) and the remote-state matrix.

import { execSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync,
  symlinkSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inventory, backupSession, teardownSession, enableTaskModel, classify, parseArgs,
} from './migrate-sessions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = resolve(HERE, '..');
const SCRIPT = join(HERE, 'migrate-sessions.mjs');
const DAY_MS = 24 * 60 * 60 * 1000;

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

// Isolation FIRST, before any git spawn (this module's own included):
// mutating process.env means every child — the module's spawnSync calls
// and the spawned cleanup script — sees the same empty global config
// and pinned identity.
const GIT_CFG = mkdtempSync(join(tmpdir(), 'mig-git-cfg-'));
writeFileSync(join(GIT_CFG, 'global'), '');
process.env.GIT_CONFIG_GLOBAL = join(GIT_CFG, 'global');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test User';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test User';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

function git(cwd, args, extraEnv = {}) {
  return execSync(`git -C "${cwd}" ${args}`, {
    stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...extraEnv },
  });
}
function gitOk(cwd, args, extraEnv = {}) {
  try { git(cwd, args, extraEnv); return true; } catch { return false; }
}
// gitFn for the module under test — identical to spawnSync but isolated
// the same way as the test's own execSync calls.
function gitFn(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env || {}) } });
}

const daysAgoIso = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

function commitAll(cwd, message, dateIso = null) {
  git(cwd, 'add -A');
  const env = dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {};
  git(cwd, `commit -q -m "${message}"`, env);
}

// A workspace root shaped like a real one: a git repo at the root with
// an origin bare remote, a project source clone at repos/app with its
// own bare remote, and a copy of .claude/ so teardown can spawn the
// real cleanup-work-session.mjs from inside the fixture (real
// workspaces ship .claude/ as a copy, never a symlink).
function makeWorkspace({ appDefaultBranch = 'main', configAppBranch = 'main', includeApp = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mig-ws-'));
  const wsOrigin = join(mkdtempSync(join(tmpdir(), 'mig-ws-origin-')), 'origin.git');
  execSync(`git init -q --bare "${wsOrigin}"`, { stdio: 'pipe' });
  const reposCfg = includeApp ? { app: { branch: configAppBranch, remote: 'none' } } : {};
  writeFileSync(join(root, 'workspace.json'), `${JSON.stringify({
    workspace: { name: 'fixture', workSessionsDir: 'work-sessions', sessionModel: 'session' },
    repos: reposCfg,
  }, null, 2)}\n`);
  git(root, 'init -q -b main');
  writeFileSync(join(root, '.gitignore'), '.claude\nrepos\nwork-sessions\n');
  writeFileSync(join(root, 'README.md'), '# launcher\n');
  commitAll(root, 'init');
  git(root, `remote add origin "${wsOrigin}"`);
  git(root, 'push -q origin main');
  git(root, 'fetch -q origin');
  // A bare repo made with `git init --bare` does not advertise a HEAD
  // symref that `set-head -a` can resolve, so point it explicitly — the
  // point is only that defaultBranchFor(".") reads origin/main here.
  git(root, 'remote set-head origin main');

  const app = join(root, 'repos', 'app');
  mkdirSync(app, { recursive: true });
  const appOrigin = join(mkdtempSync(join(tmpdir(), 'mig-app-origin-')), 'origin.git');
  execSync(`git init -q --bare "${appOrigin}"`, { stdio: 'pipe' });
  git(app, `init -q -b ${appDefaultBranch}`);
  writeFileSync(join(app, 'README.md'), '# app\n');
  commitAll(app, 'init');
  git(app, `remote add origin "${appOrigin}"`);
  git(app, `push -q origin ${appDefaultBranch}`);
  git(app, 'fetch -q origin');

  cpSync(CLAUDE_DIR, join(root, '.claude'), { recursive: true });
  return { root, app, wsOrigin, appOrigin };
}

// `git worktree add` writes reflog entries at creation time — the
// worktree's HEAD reflog AND the branch's — always "now" in a fixture,
// and `git log -g` reads through to the branch reflog when the worktree
// one is gone. Both must go, or every date-controlled session looks
// active through the S2(c) reflog signal. A dated commit then re-adds
// reflog entries at that exact date (commits honor GIT_COMMITTER_DATE).
function stripReflog(wtPath, branch) {
  rmSync(resolve(wtPath, git(wtPath, 'rev-parse --git-path logs/HEAD').trim()), { force: true });
  rmSync(resolve(wtPath, git(wtPath, `rev-parse --git-path "logs/refs/heads/${branch}"`).trim()), { force: true });
}

// A session in the real layout: a workspace worktree on {branch} plus
// one nested project worktree per repo, and a session.md tracker.
// tracker: null skips session.md entirely (the no-tracker fixtures).
function makeSession(fx, { name, branch, repos = ['app'], tracker = {} }) {
  const wsWt = join(fx.root, 'work-sessions', name, 'workspace');
  git(fx.root, `worktree add -q -b "${branch}" "${wsWt}"`);
  stripReflog(wsWt, branch);
  const projWts = {};
  for (const r of repos) {
    const p = join(wsWt, 'repos', r);
    mkdirSync(dirname(p), { recursive: true });
    git(join(fx.root, 'repos', r), `worktree add -q -b "${branch}" "${p}"`);
    stripReflog(p, branch);
    projWts[r] = p;
  }
  if (tracker !== null) {
    const lines = ['---', 'type: session-tracker', `name: ${name}`];
    for (const [k, v] of Object.entries(tracker)) {
      if (Array.isArray(v)) { lines.push(`${k}:`, ...v.map((i) => `  - ${i}`)); } else { lines.push(`${k}: ${v}`); }
    }
    lines.push('---', '', `# Work Session: ${name}`, '');
    writeFileSync(join(wsWt, 'session.md'), `${lines.join('\n')}\n`);
  }
  return { wsWt, projWts };
}

const clean = (...dirs) => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };
const byName = (inv, name) => inv.sessions.find((s) => s.name === name);

console.log('# boundary: root must be a workspace, session a single segment');
{
  const notAWorkspace = mkdtempSync(join(tmpdir(), 'mig-not-ws-'));
  throws(() => inventory(notAWorkspace), 'a --root without workspace.json throws');
  throws(() => enableTaskModel(notAWorkspace), 'enableTaskModel on a non-workspace throws');
  clean(notAWorkspace);

  throws(() => parseArgs(['node', 's', '--backup', '--session', '../x']), '--session ../x rejected');
  throws(() => parseArgs(['node', 's', '--backup', '--session', 'a/b']), '--session a/b rejected');
  throws(() => parseArgs(['node', 's', '--teardown', '--session', '..']), '--session ".." rejected');

  const fx = makeWorkspace();
  try {
    throws(() => backupSession(fx.root, { session: '../x' }), 'backupSession rejects an escaping session name');
    throws(() => teardownSession(fx.root, { session: 'a/b' }), 'teardownSession rejects a path-like session name');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# parseArgs validation');
{
  throws(() => parseArgs(['node', 's']), 'a mode is required');
  throws(() => parseArgs(['node', 's', '--inventory', '--backup', '--session', 'x']), 'two modes rejected');
  throws(() => parseArgs(['node', 's', '--backup']), '--backup requires --session');
  throws(() => parseArgs(['node', 's', '--inventory', '--session', 'x']), '--session only with --backup/--teardown');
  throws(() => parseArgs(['node', 's', '--backup', '--session', 'x', '--active-days', '7']), '--active-days only with --inventory');
  throws(() => parseArgs(['node', 's', '--inventory', '--active-days', '0']), '--active-days must be positive');
  throws(() => parseArgs(['node', 's', '--inventory', '--active-days']), 'dangling value flag rejected');
  throws(() => parseArgs(['node', 's', '--inventory', '--discard-uncommitted']), '--discard-uncommitted only with --teardown');
  throws(() => parseArgs(['node', 's', '--inventory', '--discard-ignored']), '--discard-ignored only with --teardown');
  throws(() => parseArgs(['node', 's', '--teardown', '--session', 'x', '--remote', 'origin']), '--remote only with --backup');
  throws(() => parseArgs(['node', 's', '--inventory', '--bogus']), 'unknown flag rejected');
  const inv = parseArgs(['node', 's', '--root', '/w', '--inventory']);
  assertEq([inv.mode, inv.root, inv.activeDays], ['inventory', '/w', null], 'inventory defaults parse');
  const td = parseArgs(['node', 's', '--teardown', '--session', 'x', '--discard-uncommitted', '--discard-ignored']);
  assertEq([td.mode, td.session, td.discardUncommitted, td.discardIgnored], ['teardown', 'x', true, true], 'teardown with both discards parses');
  const bk = parseArgs(['node', 's', '--backup', '--session', 'x', '--remote', 'upstream']);
  assertEq([bk.mode, bk.remote], ['backup', 'upstream'], '--backup with --remote parses');
  const days = parseArgs(['node', 's', '--inventory', '--active-days', '7']);
  assertEq(days.activeDays, 7, '--active-days parses as an integer');
}

console.log('# classify: pure proposal logic');
{
  const ws = (over = {}) => ({ kind: 'workspace', repo: '.', dirty: 0, ahead: 1, contentFiles: 0, dirtyContent: 0, ...over });
  const proj = (over = {}) => ({ kind: 'project', repo: 'app', dirty: 0, ahead: 0, ...over });
  assertEq(classify({ worktrees: [ws()], lastActivity: new Date().toISOString() }, 14).proposal, 'ACTIVE', 'recent activity is ACTIVE');
  assertEq(classify({ worktrees: [ws({ dirty: 1 })], lastActivity: daysAgoIso(20) }, 14).proposal, 'ACTIVE', 'dirty within 2N days is ACTIVE');
  assertEq(classify({ worktrees: [ws({ dirty: 1 })], lastActivity: daysAgoIso(40) }, 14).proposal, 'ABANDONED', 'dirty beyond 2N days is not ACTIVE');
  assertEq(
    classify({ worktrees: [ws()], lastActivity: daysAgoIso(40) }, 14).proposal,
    'ABANDONED',
    'artifact-only workspace with clean projects is ABANDONED',
  );
  assertEq(
    classify({ worktrees: [ws({ contentFiles: 2 })], lastActivity: daysAgoIso(40) }, 14).proposal,
    'MERGEABLE',
    'content files make MERGEABLE',
  );
  assertEq(
    classify({ worktrees: [ws({ dirtyContent: 3 })], lastActivity: daysAgoIso(40) }, 14).proposal,
    'MERGEABLE',
    'uncommitted content paths are content — never ABANDONED (S2a)',
  );
  assertEq(
    classify({ worktrees: [ws(), proj({ ahead: 3 })], lastActivity: daysAgoIso(40) }, 14).proposal,
    'MERGEABLE',
    'project commits ahead make MERGEABLE',
  );
  assertEq(
    classify({ worktrees: [ws(), proj({ dirty: 2 })], lastActivity: daysAgoIso(40) }, 14).proposal,
    'MERGEABLE',
    'uncommitted project changes fall to MERGEABLE, never silently ABANDONED',
  );
  assertEq(
    classify({ worktrees: [ws()], lastActivity: null }, 14).proposal,
    'UNKNOWN',
    'null activity proposes UNKNOWN, never ABANDONED (S2b)',
  );
}

console.log('# inventory: ACTIVE by recency');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'alpha', branch: 'bugfix/alpha', tracker: { status: 'active', branch: 'bugfix/alpha', repos: ['app'], workItem: 'gh:1', updated: new Date().toISOString() } });
    commitAll(join(fx.root, 'work-sessions', 'alpha', 'workspace'), 'tracker', new Date().toISOString());
    const inv = inventory(fx.root);
    const s = byName(inv, 'alpha');
    assertEq(s.proposal, 'ACTIVE', 'recent session proposes ACTIVE');
    assertEq(s.status, 'active', 'status comes from the tracker');
    assertEq(s.workItem, 'gh:1', 'workItem comes from the tracker');
    assert(inv.note.includes('Proposals are proposals'), 'the output says proposals are only proposals');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: ABANDONED with only session.md (artifact-dirty stays ABANDONED)');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'stale', branch: 'bugfix/stale', tracker: { status: 'paused', branch: 'bugfix/stale', repos: ['app'], updated: daysAgoIso(40) } });
    const wsWt = join(fx.root, 'work-sessions', 'stale', 'workspace');
    commitAll(wsWt, 'tracker only', daysAgoIso(40));
    writeFileSync(join(wsWt, 'session.md'), '---\ntype: session-tracker\nstatus: paused\n---\n\nedited but never committed\n');
    const s = byName(inventory(fx.root), 'stale');
    assertEq(s.proposal, 'ABANDONED', 'artifact-only old session proposes ABANDONED');
    assertEq(s.worktrees[0].contentFiles, 0, 'session.md is not a content file');
    assertEq(s.worktrees[0].dirtyContent, 0, 'a dirty session.md is not dirty content');
    assertEq(s.worktrees[0].dirty, 1, 'the edit still counts as dirty');
    assertEq(s.worktrees[0].ahead, 1, 'the tracker commit is ahead of main');
    assertEq(s.worktrees.find((w) => w.repo === 'app').ahead, 0, 'project worktree has nothing ahead');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: MERGEABLE with a content file, and with workspace-only dirty content');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'docs', branch: 'bugfix/docs', tracker: { status: 'active', branch: 'bugfix/docs', repos: ['app'], updated: daysAgoIso(40) } });
    const wsWt = join(fx.root, 'work-sessions', 'docs', 'workspace');
    commitAll(wsWt, 'tracker', daysAgoIso(40));
    writeFileSync(join(wsWt, 'NOTES.md'), 'real content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    const s = byName(inventory(fx.root), 'docs');
    assertEq(s.proposal, 'MERGEABLE', 'content on the workspace branch proposes MERGEABLE');
    assertEq(s.worktrees[0].contentFiles, 1, 'content file counted');

    makeSession(fx, { name: 'drafty', branch: 'bugfix/drafty', tracker: { status: 'active', branch: 'bugfix/drafty', repos: ['app'], updated: daysAgoIso(40) } });
    const draft = join(fx.root, 'work-sessions', 'drafty', 'workspace', 'DRAFT.md');
    writeFileSync(draft, 'uncommitted\n');
    // The mtime of dirty content is itself an activity signal (S2c) — a
    // draft written "now" means someone just worked here. Age it so this
    // fixture tests classification, not freshness.
    utimesSync(draft, new Date(Date.now() - 40 * DAY_MS), new Date(Date.now() - 40 * DAY_MS));
    const d = byName(inventory(fx.root), 'drafty');
    assertEq(d.proposal, 'MERGEABLE', 'uncommitted workspace content is not ABANDONED (S2a)');
    assertEq(d.worktrees[0].dirtyContent, 1, 'the draft counts as dirty content');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: MERGEABLE with project commits (and no-remote ahead fallback)');
{
  const fx = makeWorkspace();
  try {
    // repos/solo has no remote and no workspace.json entry — ahead must
    // fall back to plain main..HEAD, not origin/main..HEAD.
    const solo = join(fx.root, 'repos', 'solo');
    mkdirSync(solo, { recursive: true });
    git(solo, 'init -q -b main');
    writeFileSync(join(solo, 'README.md'), '# solo\n');
    commitAll(solo, 'init');
    makeSession(fx, { name: 'code', branch: 'bugfix/code', repos: ['app', 'solo'], tracker: { status: 'active', branch: 'bugfix/code', repos: ['app', 'solo'], updated: daysAgoIso(40) } });
    writeFileSync(join(fx.root, 'work-sessions', 'code', 'workspace', 'repos', 'app', 'fix.txt'), 'fix\n');
    commitAll(join(fx.root, 'work-sessions', 'code', 'workspace', 'repos', 'app'), 'project fix', daysAgoIso(40));
    writeFileSync(join(fx.root, 'work-sessions', 'code', 'workspace', 'repos', 'solo', 'fix.txt'), 'fix\n');
    commitAll(join(fx.root, 'work-sessions', 'code', 'workspace', 'repos', 'solo'), 'solo fix', daysAgoIso(40));
    const s = byName(inventory(fx.root), 'code');
    assertEq(s.proposal, 'MERGEABLE', 'project commits propose MERGEABLE');
    assertEq(s.worktrees.find((w) => w.repo === 'app').ahead, 1, 'app ahead via origin/main');
    assertEq(s.worktrees.find((w) => w.repo === 'solo').ahead, 1, 'solo ahead via the no-origin fallback');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: UNKNOWN when no activity signal exists (S2b)');
{
  const fx = makeWorkspace();
  try {
    // No tracker, no commits (so no reflog entries in the worktrees), no
    // dirty files: the only honest answer is "unknown".
    makeSession(fx, { name: 'quiet', branch: 'bugfix/quiet', tracker: null });
    const s = byName(inventory(fx.root), 'quiet');
    assertEq(s.proposal, 'UNKNOWN', 'no activity signal proposes UNKNOWN');
    assertEq(s.lastActivity, null, 'lastActivity is null');
    assert(s.reasons.some((r) => r.includes('no activity signal')), 'the reason says why');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: broken shell');
{
  const fx = makeWorkspace();
  try {
    mkdirSync(join(fx.root, 'work-sessions', 'empty'), { recursive: true });
    mkdirSync(join(fx.root, 'work-sessions', 'shell', 'workspace'), { recursive: true });
    const inv = inventory(fx.root);
    assertEq(byName(inv, 'empty').kind, 'broken', 'a bare session directory is broken');
    assertEq(byName(inv, 'empty').proposal, 'REMOVE_SHELL', 'proposal is REMOVE_SHELL');
    assertEq(byName(inv, 'shell').kind, 'broken', 'an empty workspace/ shell is broken');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: branch drift warning');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'drift', branch: 'bugfix/drift', tracker: { status: 'active', branch: 'bugfix/elsewhere', repos: ['app'], updated: daysAgoIso(40) } });
    commitAll(join(fx.root, 'work-sessions', 'drift', 'workspace'), 'tracker', daysAgoIso(40));
    const s = byName(inventory(fx.root), 'drift');
    const wsWt = s.worktrees[0];
    assertEq(wsWt.trackerBranch, 'bugfix/elsewhere', 'trackerBranch read from session.md');
    assertEq(wsWt.branchDrift, true, 'branchDrift true when tracker and worktree disagree');
    assert(s.warnings.some((w) => w.kind === 'branch-drift'), 'a branch-drift warning is present');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: unbacked warning for commits on no remote');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'localonly', branch: 'bugfix/localonly', tracker: { status: 'active', branch: 'bugfix/localonly', repos: ['app'], updated: daysAgoIso(40) } });
    const wsWt = join(fx.root, 'work-sessions', 'localonly', 'workspace');
    writeFileSync(join(wsWt, 'NOTES.md'), 'unpushed\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    const s = byName(inventory(fx.root), 'localonly');
    const warn = s.warnings.find((w) => w.kind === 'unbacked');
    assert(warn && warn.unbacked === true, 'unbacked warning carries unbacked: true');
    assertEq(s.worktrees[0].remotes.origin.exists, false, 'branch does not exist on origin');
    assertEq(s.worktrees[0].remotes.origin.state, 'none', 'state is none when no remote holds the branch');
    assertEq(s.worktrees[0].backedBy, null, 'no remote backs the commits');
    assert(warn.message.includes('exist on no remote') && warn.message.includes('origin:none'), 'the warning states count and state');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# S1: remote states — same, ahead, not-fetched, behind, diverged');
{
  const fx = makeWorkspace();
  const otherClone = mkdtempSync(join(tmpdir(), 'mig-states-clone-'));
  try {
    // Session "states": same → local-ahead.
    const { wsWt, projWts } = makeSession(fx, { name: 'states', branch: 'bugfix/states', tracker: { status: 'active', branch: 'bugfix/states', repos: ['app'], updated: daysAgoIso(40) } });
    commitAll(wsWt, 'tracker', daysAgoIso(40));
    const appWt = projWts.app;
    writeFileSync(join(appWt, 'one.txt'), '1\n');
    commitAll(appWt, 'one', daysAgoIso(40));
    git(appWt, 'push -q origin bugfix/states');

    const same = byName(inventory(fx.root), 'states').worktrees.find((w) => w.repo === 'app');
    assertEq(same.remotes.origin.state, 'same', 'pushed tip is same');
    assertEq(same.backedBy, 'origin', 'same is backed');

    writeFileSync(join(appWt, 'two.txt'), '2\n');
    commitAll(appWt, 'two', daysAgoIso(40));
    const ahead = byName(inventory(fx.root), 'states').worktrees.find((w) => w.repo === 'app');
    assertEq(ahead.remotes.origin.state, 'local-ahead', 'a local-only commit is local-ahead');
    assertEq(ahead.remotes.origin.ahead, 1, 'ahead count is 1');
    assertEq(ahead.backedBy, null, 'local-ahead is not backed');

    // Session "quietr": same → remote advances → not-fetched, then behind
    // after a fetch, then diverged once local moves too.
    const { projWts: quietWts } = makeSession(fx, { name: 'quietr', branch: 'bugfix/quietr', tracker: { status: 'active', branch: 'bugfix/quietr', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(quietWts.app, 'one.txt'), '1\n');
    commitAll(quietWts.app, 'one', daysAgoIso(40));
    git(quietWts.app, 'push -q origin bugfix/quietr');

    execSync(`git clone -q "${fx.appOrigin}" "${otherClone}"`, { stdio: 'pipe', env: process.env });
    git(otherClone, 'checkout -q bugfix/quietr');
    writeFileSync(join(otherClone, 'r1.txt'), 'r\n');
    commitAll(otherClone, 'remote advance');
    git(otherClone, 'push -q origin bugfix/quietr');

    const notFetched = byName(inventory(fx.root), 'quietr').worktrees.find((w) => w.repo === 'app');
    assertEq(notFetched.remotes.origin.state, 'not-fetched', 'an unknown remote commit is not-fetched');
    assertEq(notFetched.backedBy, null, 'not-fetched is not backed');

    git(quietWts.app, 'fetch -q origin');
    const behind = byName(inventory(fx.root), 'quietr').worktrees.find((w) => w.repo === 'app');
    assertEq(behind.remotes.origin.state, 'local-behind', 'after fetch, purely behind');
    assertEq(behind.remotes.origin.behind, 1, 'behind count is 1');
    assertEq(behind.backedBy, 'origin', 'local-behind still backs the local tip');

    writeFileSync(join(quietWts.app, 'two.txt'), '2\n');
    commitAll(quietWts.app, 'two', daysAgoIso(40));
    const s = byName(inventory(fx.root), 'quietr');
    const appInfo = s.worktrees.find((w) => w.repo === 'app');
    assertEq(appInfo.remotes.origin.state, 'diverged', 'both sides moved is diverged');
    assertEq(appInfo.remotes.origin.ahead, 1, 'diverged ahead count');
    assertEq(appInfo.remotes.origin.behind, 1, 'diverged behind count');
    const warn = s.warnings.find((w) => w.kind === 'unbacked' && w.repo === 'app');
    assert(warn && warn.message.includes('force-push'), 'the unbacked warning flags the force-push decision');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, otherClone); }
}

console.log('# S1: table renders remote states');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'tbl', branch: 'bugfix/tbl', tracker: { status: 'active', branch: 'bugfix/tbl', repos: ['app'], updated: daysAgoIso(40) } });
    const inv = inventory(fx.root);
    const app = byName(inv, 'tbl').worktrees.find((w) => w.repo === 'app');
    assertEq(app.remotes.origin.state, 'none', 'unpushed branch is none');
    const r = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--inventory'], { encoding: 'utf8' });
    assert(r.stderr.includes('[origin:none]'), 'table renders [origin:none]');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# ls-remote timeout degrades to unknown (S3, injected gitFn)');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'hang', branch: 'bugfix/hang', tracker: { status: 'active', branch: 'bugfix/hang', repos: ['app'], updated: new Date().toISOString() } });
    writeFileSync(join(fx.root, 'work-sessions', 'hang', 'workspace', 'NOTES.md'), 'unpushed\n');
    commitAll(join(fx.root, 'work-sessions', 'hang', 'workspace'));
    // A hung remote: every ls-remote returns an ETIMEDOUT error object,
    // exactly as spawnSync does past its timeout. Everything else is real.
    const hungLsGitFn = (cmd, args, opts = {}) => (
      args.includes('ls-remote')
        ? { status: null, error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
        : gitFn(cmd, args, opts)
    );
    const s = byName(inventory(fx.root, { gitFn: hungLsGitFn }), 'hang');
    const wsWt = s.worktrees[0];
    assertEq(wsWt.remotes.origin.state, 'unknown', 'a timed-out ls-remote records unknown');
    assertEq(wsWt.backedBy, null, 'unknown proves nothing');
    const warn = s.warnings.find((w) => w.kind === 'unbacked');
    assert(warn && warn.message.includes('origin:unknown'), 'the warning names the unknown remote');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# backup: creates, pushes, and verifies session-scoped drain tags (idempotent)');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'drain', branch: 'bugfix/drain', tracker: { status: 'active', branch: 'bugfix/drain', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'project fix', daysAgoIso(40));

    const out = backupSession(fx.root, { session: 'drain' });
    assertEq(out.refused, undefined, 'backup is not refused');
    assertEq(out.branches.length, 2, 'one backup entry per unsafe tip');
    const wsEntry = out.branches.find((b) => b.repo === '.');
    const appEntry = out.branches.find((b) => b.repo === 'app');
    assert(wsEntry && wsEntry.tag === 'drain/drain/bugfix-drain' && wsEntry.pushed === true && wsEntry.verified === true, 'workspace tip backed up under a session-scoped tag');
    assert(wsEntry.remote === 'origin', 'the remote used is reported');
    assert(appEntry && appEntry.tag === 'drain/drain/bugfix-drain' && appEntry.verified === true, 'project tip backed up');
    assertEq(wsEntry.commit, git(wsWt, 'rev-parse HEAD').trim(), 'tag commit is the branch tip');

    assert(git(fx.root, 'tag -l drain/drain/bugfix-drain').trim() !== '', 'tag exists in the workspace repo');
    assert(git(fx.app, 'tag -l drain/drain/bugfix-drain').trim() !== '', 'tag exists in the project repo');
    assert(git(fx.wsOrigin, 'tag -l drain/drain/bugfix-drain').trim() !== '', 'tag pushed to the workspace origin');
    assert(git(fx.appOrigin, 'tag -l drain/drain/bugfix-drain').trim() !== '', 'tag pushed to the project origin');
    assert(
      git(fx.root, "for-each-ref refs/tags/drain/drain/bugfix-drain --format='%(contents:subject)'").trim()
        === 'backup before draining session drain',
      'annotated tag carries the backup message',
    );

    const again = backupSession(fx.root, { session: 'drain' });
    assertEq(again.refused, undefined, 'second backup run is not refused');
    assertEq(again.branches.length, 2, 'idempotent re-run reports the same tips');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# backup: skips tips already contained in a surviving ref');
{
  const fx = makeWorkspace();
  try {
    const { wsWt } = makeSession(fx, { name: 'merged', branch: 'bugfix/merged', repos: [], tracker: { status: 'active', branch: 'bugfix/merged', repos: [], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    // Merge the session branch into main: its tip now survives via main.
    git(fx.root, 'merge -q --no-ff -m merge bugfix/merged');
    git(fx.root, 'push -q origin main');
    const out = backupSession(fx.root, { session: 'merged' });
    assertEq(out.refused, undefined, 'backup is not refused');
    assertEq(out.branches.length, 0, 'a merged tip needs no tag');
    assertEq(out.skipped.length, 1, 'the merged tip is reported as skipped-safe');
    assert(out.skipped[0].containedIn.startsWith('refs/heads/main'), 'the containing ref is reported');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# backup: refuses a moved tag, a repo with no remote, and a failed push');
{
  const fx = makeWorkspace();
  const solo = join(fx.root, 'repos', 'solo');
  try {
    mkdirSync(solo, { recursive: true });
    git(solo, 'init -q -b main');
    writeFileSync(join(solo, 'README.md'), '# solo\n');
    commitAll(solo, 'init');

    const { wsWt } = makeSession(fx, { name: 'moved', branch: 'bugfix/moved', repos: [], tracker: { branch: 'bugfix/moved', repos: [], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'one\n');
    commitAll(wsWt, 'first', daysAgoIso(40));
    assertEq(backupSession(fx.root, { session: 'moved' }).branches.length, 1, 'first backup succeeds');
    writeFileSync(join(wsWt, 'NOTES.md'), 'two\n');
    commitAll(wsWt, 'second', daysAgoIso(40));
    const moved = backupSession(fx.root, { session: 'moved' });
    assertEq(moved.refused, true, 'a branch that moved past its tag refuses');
    assert(moved.reasons.some((r) => r.includes('already points at')), 'the refusal explains the moved tag');

    makeSession(fx, { name: 'offline', branch: 'bugfix/offline', repos: ['solo'], tracker: { branch: 'bugfix/offline', repos: ['solo'], updated: daysAgoIso(40) } });
    writeFileSync(join(fx.root, 'work-sessions', 'offline', 'workspace', 'repos', 'solo', 'fix.txt'), 'fix\n');
    commitAll(join(fx.root, 'work-sessions', 'offline', 'workspace', 'repos', 'solo'), 'solo work', daysAgoIso(40));
    const offline = backupSession(fx.root, { session: 'offline' });
    assertEq(offline.refused, true, 'a repo with no remote refuses');
    assert(offline.reasons.some((r) => r.includes('no remote')), 'the refusal names the missing remote');

    // A broken origin URL makes the push itself fail — refusal, never a
    // silent "probably fine".
    const { projWts: brokenWts } = makeSession(fx, { name: 'brokenpush', branch: 'bugfix/brokenpush', tracker: { branch: 'bugfix/brokenpush', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(brokenWts.app, 'fix.txt'), 'fix\n');
    commitAll(brokenWts.app, 'fix', daysAgoIso(40));
    git(fx.app, 'remote set-url origin /nonexistent/repo.git');
    const broken = backupSession(fx.root, { session: 'brokenpush' });
    assertEq(broken.refused, true, 'a failed push refuses');
    assert(broken.reasons.some((r) => r.includes('failed') || r.includes('timed out')), 'the refusal names the push failure');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# S4: push-remote resolution — first remote without origin, and --remote override');
{
  const fx = makeWorkspace();
  const upstream = join(mkdtempSync(join(tmpdir(), 'mig-upstream-')), 'upstream.git');
  try {
    execSync(`git init -q --bare "${upstream}"`, { stdio: 'pipe' });
    git(fx.app, 'remote remove origin');
    git(fx.app, `remote add upstream "${upstream}"`);
    const { projWts } = makeSession(fx, { name: 'nomigin', branch: 'bugfix/nomigin', tracker: { branch: 'bugfix/nomigin', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'fix', daysAgoIso(40));
    const out = backupSession(fx.root, { session: 'nomigin' });
    assertEq(out.refused, undefined, 'backup resolves without origin');
    const appEntry = out.branches.find((b) => b.repo === 'app');
    assert(appEntry && appEntry.remote === 'upstream', 'the first configured remote is used and reported');
    assert(git(upstream, 'tag -l drain/nomigin/bugfix-nomigin').trim() !== '', 'the tag landed on upstream');

    const badOverride = backupSession(fx.root, { session: 'nomigin', remote: 'nosuch' });
    assertEq(badOverride.refused, true, 'an unknown --remote refuses');
    assert(badOverride.reasons.some((r) => r.includes('nosuch')), 'the refusal names the override');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, upstream); }
}

console.log('# teardown: refuses without a backup (unsafe tip)');
{
  const fx = makeWorkspace();
  try {
    const { projWts } = makeSession(fx, { name: 'risky', branch: 'bugfix/risky', tracker: { branch: 'bugfix/risky', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'unbacked work', daysAgoIso(40));
    const out = teardownSession(fx.root, { session: 'risky' });
    assertEq(out.refused, true, 'teardown refuses');
    assert(out.reasons.some((r) => r.includes('no copy on any remote') && r.includes('bugfix/risky')), 'the refusal names the unsafe tip');
    assert(existsSync(join(fx.root, 'work-sessions', 'risky')), 'the session is untouched after the refusal');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# teardown: refuses a dirty tree even after a backup');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'messy', branch: 'bugfix/messy', tracker: { branch: 'bugfix/messy', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    const backup = backupSession(fx.root, { session: 'messy' });
    assertEq(backup.refused, undefined, 'backup runs');
    assertEq(backup.branches.filter((b) => b.repo === '.').length, 1, 'the workspace tip is backed up');
    writeFileSync(join(projWts.app, 'loose.txt'), 'uncommitted\n');
    const out = teardownSession(fx.root, { session: 'messy' });
    assertEq(out.refused, true, 'teardown refuses the dirty worktree');
    assert(out.reasons.some((r) => r.includes('loose.txt') && r.includes('--discard-uncommitted')), 'the refusal lists the exact path and the waiver');
    assert(existsSync(join(fx.root, 'work-sessions', 'messy')), 'nothing was torn down');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# teardown: succeeds after backup; remote branch and tag survive');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'done', branch: 'bugfix/done', tracker: { branch: 'bugfix/done', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'project fix', daysAgoIso(40));
    git(wsWt, 'push -q origin bugfix/done');
    git(projWts.app, 'push -q origin bugfix/done');
    assertEq(backupSession(fx.root, { session: 'done' }).branches.length, 2, 'both tips backed up');

    const out = teardownSession(fx.root, { session: 'done' });
    assertEq(out.refused, undefined, 'teardown is not refused');
    assertEq(out.removed, true, 'session folder removed');
    assert(!existsSync(join(fx.root, 'work-sessions', 'done')), 'the session folder is gone');
    assert(!git(fx.root, 'worktree list --porcelain').includes('done'), 'no workspace worktree record remains');
    assert(!git(fx.app, 'worktree list --porcelain').includes('done'), 'no project worktree record remains');
    assert(!gitOk(fx.root, 'show-ref --verify --quiet refs/heads/bugfix/done'), 'local workspace branch deleted');
    assert(!gitOk(fx.app, 'show-ref --verify --quiet refs/heads/bugfix/done'), 'local project branch deleted');
    // Never delete a remote branch or tag — the whole point of the backup.
    assert(gitOk(fx.wsOrigin, 'show-ref --verify --quiet refs/heads/bugfix/done'), 'remote workspace branch still exists');
    assert(gitOk(fx.appOrigin, 'show-ref --verify --quiet refs/heads/bugfix/done'), 'remote project branch still exists');
    assert(gitOk(fx.wsOrigin, 'show-ref --verify --quiet refs/tags/drain/done/bugfix-done'), 'remote workspace tag still exists');
    assert(gitOk(fx.appOrigin, 'show-ref --verify --quiet refs/tags/drain/done/bugfix-done'), 'remote project tag still exists');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# teardown: --discard-uncommitted drops a dirty, zero-ahead session');
{
  const fx = makeWorkspace();
  try {
    const { wsWt } = makeSession(fx, { name: 'scratch', branch: 'bugfix/scratch', tracker: { branch: 'bugfix/scratch', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'loose.txt'), 'never committed\n');
    const refused = teardownSession(fx.root, { session: 'scratch' });
    assertEq(refused.refused, true, 'without the flag the dirty worktree refuses');
    const out = teardownSession(fx.root, { session: 'scratch', discardUncommitted: true });
    assertEq(out.removed, true, '--discard-uncommitted tears the session down');
    assert(!existsSync(join(fx.root, 'work-sessions', 'scratch')), 'the session folder is gone');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# B4: ignored files refuse teardown unless --discard-ignored');
{
  const fx = makeWorkspace();
  try {
    // Commit an ignore rule on app's main before the session so every
    // worktree inherits it, then drop an ignored file in the worktree.
    writeFileSync(join(fx.app, '.gitignore'), 'secrets.txt\n');
    commitAll(fx.app, 'ignore rule');
    git(fx.app, 'push -q origin main');
    const { wsWt, projWts } = makeSession(fx, { name: 'ig', branch: 'bugfix/ig', tracker: { branch: 'bugfix/ig', repos: ['app'], updated: daysAgoIso(40) } });
    commitAll(wsWt, 'tracker', daysAgoIso(40)); // keep the tree check focused on the ignored file
    git(wsWt, 'push -q origin bugfix/ig'); // and the tip safety out of the way
    writeFileSync(join(projWts.app, 'secrets.txt'), 'would be silently lost\n');
    const refused = teardownSession(fx.root, { session: 'ig' });
    assertEq(refused.refused, true, 'an ignored file refuses teardown');
    assert(refused.reasons.some((r) => r.includes('secrets.txt') && r.includes('ignored') && r.includes('--discard-ignored')), 'the refusal lists the ignored path and its waiver');
    assert(existsSync(join(projWts.app, 'secrets.txt')), 'the ignored file survives the refusal');

    const out = teardownSession(fx.root, { session: 'ig', discardIgnored: true });
    assertEq(out.removed, true, '--discard-ignored tears the session down');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# B1: tracker drift refuses teardown');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'drifted', branch: 'bugfix/drifted', tracker: { branch: 'bugfix/elsewhere', repos: ['app'], updated: daysAgoIso(40) } });
    commitAll(join(fx.root, 'work-sessions', 'drifted', 'workspace'), 'tracker', daysAgoIso(40));
    const out = teardownSession(fx.root, { session: 'drifted' });
    assertEq(out.refused, true, 'drift between tracker and worktree refuses');
    assert(out.reasons.some((r) => r.includes('drift')), 'the refusal says drift and asks to reconcile');
    assert(existsSync(join(fx.root, 'work-sessions', 'drifted')), 'nothing was torn down');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# B2: detached HEAD with commits refuses until tagged, then tears down');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'det', branch: 'bugfix/det', tracker: { branch: 'bugfix/det', repos: ['app'], updated: daysAgoIso(40) } });
    commitAll(wsWt, 'tracker', daysAgoIso(40));
    git(projWts.app, 'checkout -q --detach');
    writeFileSync(join(projWts.app, 'detached.txt'), 'work on a detached head\n');
    commitAll(projWts.app, 'detached work', daysAgoIso(40));

    const refused = teardownSession(fx.root, { session: 'det' });
    assertEq(refused.refused, true, 'a detached HEAD with unbacked commits refuses');
    assert(refused.reasons.some((r) => r.includes('detached HEAD')), 'the refusal names the detached tip');

    const backup = backupSession(fx.root, { session: 'det' });
    assertEq(backup.refused, undefined, 'backup handles the detached session');
    const detachedEntry = backup.branches.find((b) => b.detached === true);
    const branchEntry = backup.branches.find((b) => b.detached === false);
    assert(detachedEntry && detachedEntry.repo === 'app' && /^drain\/det\/app-detached-[0-9a-f]+$/.test(detachedEntry.tag), 'the detached tip gets a session-scoped detached tag');
    assert(branchEntry && branchEntry.repo === '.', 'the workspace branch tip is also backed up');
    assert(git(fx.appOrigin, 'tag -l').includes('detached'), 'the detached tag reached the remote');

    const out = teardownSession(fx.root, { session: 'det' });
    assertEq(out.refused, undefined, 'teardown proceeds once the detached tip is backed up');
    assertEq(out.removed, true, 'the session is gone');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# B3: unresolvable default branch fails closed');
{
  const fx = makeWorkspace({ appDefaultBranch: 'master', includeApp: false });
  try {
    // app really lives on master, but workspace.json says nothing about
    // it — the configured default ("main") does not exist in the repo.
    makeSession(fx, { name: 'b3', branch: 'bugfix/b3', tracker: { branch: 'bugfix/b3', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(fx.root, 'work-sessions', 'b3', 'workspace', 'repos', 'app', 'fix.txt'), 'fix\n');
    commitAll(join(fx.root, 'work-sessions', 'b3', 'workspace', 'repos', 'app'), 'work', daysAgoIso(40));

    const s = byName(inventory(fx.root), 'b3');
    assertEq(s.worktrees.find((w) => w.repo === 'app').ahead, null, 'ahead is unknown, not a silent 0');
    assert(s.warnings.some((w) => w.kind === 'unknown-ahead'), 'a warning says the count is unknown');

    const out = teardownSession(fx.root, { session: 'b3' });
    assertEq(out.refused, true, 'teardown fails closed');
    assert(out.reasons.some((r) => r.includes('no copy on any remote')), 'the refusal is the unsafe tip');
    assert(existsSync(join(fx.root, 'work-sessions', 'b3')), 'nothing was torn down');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# invariant: a rebase in progress refuses');
{
  const fx = makeWorkspace();
  try {
    const { projWts } = makeSession(fx, { name: 'rebasey', branch: 'bugfix/rebasey', tracker: { branch: 'bugfix/rebasey', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'work', daysAgoIso(40));
    // Simulate the exact on-disk marker a rebase leaves behind.
    const marker = git(projWts.app, 'rev-parse --git-path rebase-merge').trim();
    mkdirSync(resolve(projWts.app, marker), { recursive: true });
    writeFileSync(join(resolve(projWts.app, marker), 'onto'), 'abc123\n');
    const out = teardownSession(fx.root, { session: 'rebasey' });
    assertEq(out.refused, true, 'a rebase in progress refuses');
    assert(out.reasons.some((r) => r.includes('rebase-merge') && r.includes('in progress')), 'the refusal names the operation');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# N3: symlinked session entries are foreign and never acted on');
{
  const fx = makeWorkspace();
  const target = mkdtempSync(join(tmpdir(), 'mig-foreign-target-'));
  try {
    mkdirSync(join(fx.root, 'work-sessions'), { recursive: true });
    try {
      symlinkSync(target, join(fx.root, 'work-sessions', 'outsider'));
    } catch {
      console.log('  (symlinks unsupported on this filesystem — case skipped)');
    }
    if (existsSync(join(fx.root, 'work-sessions', 'outsider'))) {
      const s = byName(inventory(fx.root), 'outsider');
      assertEq(s.kind, 'foreign', 'a symlinked entry reports foreign');
      assertEq(s.proposal, 'LEAVE', 'the proposal is LEAVE');
      const td = teardownSession(fx.root, { session: 'outsider' });
      assertEq(td.refused, true, 'teardown refuses a symlinked session');
      const bk = backupSession(fx.root, { session: 'outsider' });
      assertEq(bk.refused, true, 'backup refuses a symlinked session');
      assert(existsSync(join(fx.root, 'work-sessions', 'outsider')), 'the symlink is untouched');
    }
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, target); }
}

console.log('# N4: a nested worktree belonging to a foreign repo refuses');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'host', branch: 'bugfix/host', tracker: { branch: 'bugfix/host', repos: ['app'], updated: daysAgoIso(40) } });
    commitAll(join(fx.root, 'work-sessions', 'host', 'workspace'), 'tracker', daysAgoIso(40));
    // An intruder: a worktree of repos/app squatting where a workspace
    // worktree of a repo named "intruder" would be — its git common dir
    // is app's, not repos/intruder's.
    git(fx.app, `worktree add -q -b bugfix/intruder "${join(fx.root, 'work-sessions', 'host', 'workspace', 'repos', 'intruder')}"`);
    const out = teardownSession(fx.root, { session: 'host' });
    assertEq(out.refused, true, 'a foreign common dir refuses');
    assert(out.reasons.some((r) => r.includes('foreign git repository')), 'the refusal explains the foreign repo');
    git(fx.app, `worktree remove --force "${join(fx.root, 'work-sessions', 'host', 'workspace', 'repos', 'intruder')}"`);
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# S5: the session hosting the current chat refuses backup and teardown');
{
  const fx = makeWorkspace();
  try {
    const { wsWt } = makeSession(fx, { name: 'self', branch: 'bugfix/self', tracker: { branch: 'bugfix/self', repos: ['app'], updated: daysAgoIso(40) } });
    const inside = join(fx.root, 'work-sessions', 'self', 'workspace');
    const td = teardownSession(fx.root, { session: 'self', cwd: inside });
    assertEq(td.refused, true, 'teardown from inside the session refuses');
    assert(td.reasons.some((r) => r.includes('hosts the current chat')), 'the refusal explains why');
    const bk = backupSession(fx.root, { session: 'self', cwd: join(inside, 'repos', 'app') });
    assertEq(bk.refused, true, 'backup from inside the session refuses');

    // From the launcher the self-host refusal is gone: make the session
    // fully drainable and confirm teardown actually completes.
    commitAll(wsWt, 'tracker', daysAgoIso(40));
    git(wsWt, 'push -q origin bugfix/self');
    const ok = teardownSession(fx.root, { session: 'self', cwd: fx.root });
    assertEq(ok.refused, undefined, 'from the launcher root there is no self-host refusal');
    assertEq(ok.removed, true, 'and the teardown completes');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# teardown: broken shells — empty removes, a file refuses');
{
  const fx = makeWorkspace();
  try {
    mkdirSync(join(fx.root, 'work-sessions', 'shell', 'workspace', 'repos'), { recursive: true });
    const out = teardownSession(fx.root, { session: 'shell' });
    assertEq(out.removed, true, 'an empty shell directory is removed');
    assert(!existsSync(join(fx.root, 'work-sessions', 'shell')), 'the shell folder is gone');

    mkdirSync(join(fx.root, 'work-sessions', 'debris', 'workspace'), { recursive: true });
    writeFileSync(join(fx.root, 'work-sessions', 'debris', 'workspace', 'stray.md'), 'a file\n');
    const refused = teardownSession(fx.root, { session: 'debris' });
    assertEq(refused.refused, true, 'a shell containing a file refuses');
    assert(refused.reasons.some((r) => r.includes('stray.md')), 'the refusal names the file');
    assert(existsSync(join(fx.root, 'work-sessions', 'debris')), 'the debris folder is untouched');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# enable-task-model preserves the rest of workspace.json');
{
  const fx = makeWorkspace();
  try {
    mkdirSync(join(fx.root, 'work-sessions', 'alpha'), { recursive: true });
    const out = enableTaskModel(fx.root);
    assertEq(out.sessionModel, 'task', 'reports the switch');
    assertEq(out.remainingSessions, ['alpha'], 'remaining sessions are reported');
    const raw = readFileSync(join(fx.root, 'workspace.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    assertEq(cfg.workspace.sessionModel, 'task', 'sessionModel set to task');
    assertEq(cfg.workspace.name, 'fixture', 'sibling keys preserved');
    assertEq(cfg.workspace.workSessionsDir, 'work-sessions', 'nested sibling keys preserved');
    assertEq(cfg.repos.app.branch, 'main', 'the repos block is untouched');
    assert(raw.endsWith('}\n') && !raw.endsWith('\n\n'), 'trailing newline, exactly one');
    assert(/^{\n  "workspace"/.test(raw), '2-space JSON formatting');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# S6: enable-task-model from a task worktree; acting modes refuse a linked root');
{
  const fx = makeWorkspace();
  try {
    git(fx.root, 'worktree add -q -b chore/enable-task-model ".claude/worktrees/chore-enable-task-model"');
    const wt = join(fx.root, '.claude', 'worktrees', 'chore-enable-task-model');
    const out = enableTaskModel(wt);
    assertEq(out.sessionModel, 'task', 'the switch applies to the worktree');
    assertEq(out.remainingSessions, null, 'no sessions list from a worktree');
    assert(out.note.includes('launcher root'), 'the note points at the launcher');
    assertEq(JSON.parse(readFileSync(join(wt, 'workspace.json'), 'utf-8')).workspace.sessionModel, 'task', 'the worktree file is the one edited');
    assertEq(JSON.parse(readFileSync(join(fx.root, 'workspace.json'), 'utf-8')).workspace.sessionModel, 'session', 'the launcher file is untouched');

    const inv = spawnSync(process.execPath, [SCRIPT, '--root', wt, '--inventory'], { encoding: 'utf8' });
    assertEq(inv.status, 2, 'a linked-worktree root is refused for acting modes');
    assert(inv.stderr.includes('workspace root'), 'the error says where to run from');

    const cli = spawnSync(process.execPath, [SCRIPT, '--enable-task-model', '--root', wt], { encoding: 'utf8' });
    assertEq(cli.status, 0, '--enable-task-model accepts the worktree root');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# CLI: inventory table on stderr, refusals exit 1, errors exit 2');
{
  const fx = makeWorkspace();
  try {
    const { wsWt } = makeSession(fx, { name: 'cli', branch: 'bugfix/cli', tracker: { branch: 'bugfix/cli', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));

    const inv = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--inventory'], { encoding: 'utf8' });
    assertEq(inv.status, 0, 'inventory exits 0');
    const parsed = JSON.parse(inv.stdout);
    assertEq(parsed.sessions.length, 1, 'inventory JSON on stdout');
    assert(inv.stderr.includes('cli') && inv.stderr.toLowerCase().includes('proposal'), 'human table on stderr');

    const refuse = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--teardown', '--session', 'cli'], { encoding: 'utf8' });
    assertEq(refuse.status, 1, 'a teardown refusal exits 1');
    assertEq(JSON.parse(refuse.stdout).refused, true, 'refusal JSON on stdout');

    const bad = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--bogus'], { encoding: 'utf8' });
    assertEq(bad.status, 2, 'an argument error exits 2');

    const notWs = spawnSync(process.execPath, [SCRIPT, '--root', GIT_CFG, '--inventory'], { encoding: 'utf8' });
    assertEq(notWs.status, 2, 'a --root without workspace.json exits 2');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
