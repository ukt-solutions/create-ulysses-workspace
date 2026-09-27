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

import { execSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync,
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
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'mig-ws-'));
  const wsOrigin = join(mkdtempSync(join(tmpdir(), 'mig-ws-origin-')), 'origin.git');
  execSync(`git init -q --bare "${wsOrigin}"`, { stdio: 'pipe' });
  writeFileSync(join(root, 'workspace.json'), `${JSON.stringify({
    workspace: { name: 'fixture', workSessionsDir: 'work-sessions', sessionModel: 'session' },
    repos: { app: { branch: 'main', remote: 'none' } },
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
  git(app, 'init -q -b main');
  writeFileSync(join(app, 'README.md'), '# app\n');
  commitAll(app, 'init');
  git(app, `remote add origin "${appOrigin}"`);
  git(app, 'push -q origin main');
  git(app, 'fetch -q origin');

  cpSync(CLAUDE_DIR, join(root, '.claude'), { recursive: true });
  return { root, app, wsOrigin, appOrigin };
}

// A session in the real layout: a workspace worktree on {branch} plus
// one nested project worktree per repo, and a session.md tracker.
function makeSession(fx, { name, branch, repos = ['app'], tracker = {} }) {
  const wsWt = join(fx.root, 'work-sessions', name, 'workspace');
  git(fx.root, `worktree add -q -b "${branch}" "${wsWt}"`);
  const projWts = {};
  for (const r of repos) {
    const p = join(wsWt, 'repos', r);
    mkdirSync(dirname(p), { recursive: true });
    git(join(fx.root, 'repos', r), `worktree add -q -b "${branch}" "${p}"`);
    projWts[r] = p;
  }
  const lines = ['---', 'type: session-tracker', `name: ${name}`];
  for (const [k, v] of Object.entries(tracker)) {
    if (Array.isArray(v)) { lines.push(`${k}:`, ...v.map((i) => `  - ${i}`)); } else { lines.push(`${k}: ${v}`); }
  }
  lines.push('---', '', `# Work Session: ${name}`, '');
  writeFileSync(join(wsWt, 'session.md'), `${lines.join('\n')}\n`);
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
  throws(() => parseArgs(['node', 's', '--inventory', '--bogus']), 'unknown flag rejected');
  const inv = parseArgs(['node', 's', '--root', '/w', '--inventory']);
  assertEq([inv.mode, inv.root, inv.activeDays], ['inventory', '/w', null], 'inventory defaults parse');
  const td = parseArgs(['node', 's', '--teardown', '--session', 'x', '--discard-uncommitted']);
  assertEq([td.mode, td.session, td.discardUncommitted], ['teardown', 'x', true], 'teardown with discard parses');
  const days = parseArgs(['node', 's', '--inventory', '--active-days', '7']);
  assertEq(days.activeDays, 7, '--active-days parses as an integer');
}

console.log('# classify: pure proposal logic');
{
  const ws = (over = {}) => ({ kind: 'workspace', repo: '.', dirty: 0, ahead: 1, contentFiles: 0, ...over });
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
    classify({ worktrees: [ws(), proj({ ahead: 3 })], lastActivity: daysAgoIso(40) }, 14).proposal,
    'MERGEABLE',
    'project commits ahead make MERGEABLE',
  );
  assertEq(
    classify({ worktrees: [ws(), proj({ dirty: 2 })], lastActivity: daysAgoIso(40) }, 14).proposal,
    'MERGEABLE',
    'uncommitted project changes fall to MERGEABLE, never silently ABANDONED',
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

console.log('# inventory: ABANDONED with only session.md');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'stale', branch: 'bugfix/stale', tracker: { status: 'paused', branch: 'bugfix/stale', repos: ['app'], updated: daysAgoIso(40) } });
    const wsWt = join(fx.root, 'work-sessions', 'stale', 'workspace');
    commitAll(wsWt, 'tracker only', daysAgoIso(40));
    const s = byName(inventory(fx.root), 'stale');
    assertEq(s.proposal, 'ABANDONED', 'artifact-only old session proposes ABANDONED');
    assertEq(s.worktrees[0].contentFiles, 0, 'session.md is not a content file');
    assertEq(s.worktrees[0].ahead, 1, 'the tracker commit is ahead of main');
    assertEq(s.worktrees.find((w) => w.repo === 'app').ahead, 0, 'project worktree has nothing ahead');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: MERGEABLE with a content file');
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
    assertEq(s.worktrees[0].remotes.origin, false, 'branch does not exist on origin');
    assertEq(s.worktrees[0].backedBy, null, 'no remote backs the commits');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: ls-remote per remote (branch on one of two)');
{
  const fx = makeWorkspace();
  const second = join(mkdtempSync(join(tmpdir(), 'mig-app-second-')), 'second.git');
  try {
    execSync(`git init -q --bare "${second}"`, { stdio: 'pipe' });
    git(fx.app, `remote add second "${second}"`);
    const { wsWt, projWts } = makeSession(fx, { name: 'twin', branch: 'bugfix/twin', tracker: { status: 'active', branch: 'bugfix/twin', repos: ['app'], updated: daysAgoIso(40) } });
    commitAll(wsWt, 'tracker', daysAgoIso(40));
    git(wsWt, 'push -q origin bugfix/twin');
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'project fix', daysAgoIso(40));
    git(projWts.app, 'push -q second bugfix/twin');

    const s = byName(inventory(fx.root), 'twin');
    const wsInfo = s.worktrees[0];
    const appInfo = s.worktrees.find((w) => w.repo === 'app');
    assertEq(wsInfo.remotes, { origin: true }, 'workspace branch found on origin');
    assertEq(appInfo.remotes.origin, false, 'app branch missing on origin');
    assertEq(appInfo.remotes.second, true, 'app branch present on second');
    assertEq(appInfo.backedBy, 'second', 'the remote holding the tip backs the commits');
    assert(!s.warnings.some((w) => w.kind === 'unbacked' && w.repo === 'app'), 'no unbacked warning for the app branch');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, second); }
}

console.log('# backup: creates, pushes, and verifies drain tags (idempotent)');
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
    assertEq(out.branches.length, 2, 'one backup entry per ahead branch');
    const wsEntry = out.branches.find((b) => b.repo === '.');
    const appEntry = out.branches.find((b) => b.repo === 'app');
    assert(wsEntry && wsEntry.tag === 'drain/bugfix-drain' && wsEntry.pushed === true && wsEntry.verified === true, 'workspace branch backed up');
    assert(appEntry && appEntry.tag === 'drain/bugfix-drain' && appEntry.verified === true, 'project branch backed up');
    assertEq(wsEntry.commit, git(wsWt, 'rev-parse HEAD').trim(), 'tag commit is the branch tip');

    assert(git(fx.root, 'tag -l drain/bugfix-drain').trim() !== '', 'tag exists in the workspace repo');
    assert(git(fx.app, 'tag -l drain/bugfix-drain').trim() !== '', 'tag exists in the project repo');
    assert(git(fx.wsOrigin, 'tag -l drain/bugfix-drain').trim() !== '', 'tag pushed to the workspace origin');
    assert(git(fx.appOrigin, 'tag -l drain/bugfix-drain').trim() !== '', 'tag pushed to the project origin');
    assert(
      git(fx.root, "for-each-ref refs/tags/drain/bugfix-drain --format='%(contents:subject)'").trim()
        === 'backup before draining session drain',
      'annotated tag carries the backup message',
    );

    const again = backupSession(fx.root, { session: 'drain' });
    assertEq(again.refused, undefined, 'second backup run is not refused');
    assertEq(again.branches.length, 2, 'idempotent re-run reports the same branches');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# backup: refuses a moved tag and a repo with no remote');
{
  const fx = makeWorkspace();
  const solo = join(fx.root, 'repos', 'solo');
  try {
    mkdirSync(solo, { recursive: true });
    git(solo, 'init -q -b main');
    writeFileSync(join(solo, 'README.md'), '# solo\n');
    commitAll(solo, 'init');

    const { wsWt } = makeSession(fx, { name: 'moved', branch: 'bugfix/moved', tracker: { branch: 'bugfix/moved', repos: [], updated: daysAgoIso(40) } });
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
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# teardown: refuses without a backup');
{
  const fx = makeWorkspace();
  try {
    const { projWts } = makeSession(fx, { name: 'risky', branch: 'bugfix/risky', tracker: { branch: 'bugfix/risky', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'unbacked work', daysAgoIso(40));
    const out = teardownSession(fx.root, { session: 'risky' });
    assertEq(out.refused, true, 'teardown refuses');
    assert(out.reasons.some((r) => r.includes('no verified drain/bugfix-risky')), 'the refusal names the missing backup tag');
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
    assertEq(backupSession(fx.root, { session: 'messy' }).branches.length, 1, 'backup runs');
    writeFileSync(join(projWts.app, 'loose.txt'), 'uncommitted\n');
    const out = teardownSession(fx.root, { session: 'messy' });
    assertEq(out.refused, true, 'teardown refuses the dirty worktree');
    assert(out.reasons.some((r) => r.includes('uncommitted')), 'the refusal names the uncommitted changes');
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
    assertEq(backupSession(fx.root, { session: 'done' }).branches.length, 2, 'both branches backed up');

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
    assert(gitOk(fx.wsOrigin, 'show-ref --verify --quiet refs/tags/drain/bugfix-done'), 'remote workspace tag still exists');
    assert(gitOk(fx.appOrigin, 'show-ref --verify --quiet refs/tags/drain/bugfix-done'), 'remote project tag still exists');
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
