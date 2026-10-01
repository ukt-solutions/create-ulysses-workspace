#!/usr/bin/env node
// Tests for migrate-sessions.mjs (gh:147)
// Run: node .claude/scripts/migrate-sessions.test.mjs
//
// Every case builds its fixture with real git under tmpdir — the same
// worktree/branch/remote mechanics users get, including bare repos as
// remotes so ls-remote, tag pushes, and the never-delete-a-remote
// guarantees are exercised for real. Git config is isolated (no
// global/system file) and the identity pinned IN PROCESS.ENV, because
// unlike task-worktree's suite this module also spawns git internally —
// env inheritance is the only isolation that reaches those processes.
//
// The archive cases fill a session with every kind of state the earlier
// teardown design was found to lose — unpushed commits, uncommitted,
// untracked and ignored files, assume-unchanged edits, per-worktree refs,
// embedded repositories, files beside workspace/ — and assert that all of
// it survives, with git still resolving the moved worktrees.

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync,
  symlinkSync, utimesSync, renameSync, realpathSync, chmodSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inventory, backupSession, archiveSession, enableTaskModel, classify, parseArgs,
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
// own bare remote, and a copy of .claude/ (real workspaces ship .claude/
// as a copy, never a symlink).
function makeWorkspace({ appDefaultBranch = 'main', configAppBranch = 'main', includeApp = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mig-ws-'));
  const wsOrigin = join(mkdtempSync(join(tmpdir(), 'mig-ws-origin-')), 'origin.git');
  execSync(`git init -q --bare "${wsOrigin}"`, { stdio: 'pipe' });
  const reposCfg = includeApp ? { app: { branch: configAppBranch, remote: 'none' } } : {};
  const wsCfg = { name: 'fixture', workSessionsDir: 'work-sessions', sessionModel: 'session' };
  writeFileSync(join(root, 'workspace.json'), `${JSON.stringify({
    workspace: wsCfg,
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
// stripLogs: false keeps the worktree-creation reflog entries (the
// fresh-worktree-is-recent reflog test).
function makeSession(fx, { name, branch, repos = ['app'], tracker = {}, stripLogs = true }) {
  const wsWt = join(fx.root, 'work-sessions', name, 'workspace');
  git(fx.root, `worktree add -q -b "${branch}" "${wsWt}"`);
  if (stripLogs) stripReflog(wsWt, branch);
  const projWts = {};
  for (const r of repos) {
    const p = join(wsWt, 'repos', r);
    mkdirSync(dirname(p), { recursive: true });
    git(join(fx.root, 'repos', r), `worktree add -q -b "${branch}" "${p}"`);
    if (stripLogs) stripReflog(p, branch);
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
  throws(() => parseArgs(['node', 's', '--archive', '--session', '..']), '--session ".." rejected');

  const fx = makeWorkspace();
  try {
    throws(() => backupSession(fx.root, { session: '../x' }), 'backupSession rejects an escaping session name');
    throws(() => archiveSession(fx.root, { session: 'a/b' }), 'archiveSession rejects a path-like session name');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# parseArgs validation');
{
  throws(() => parseArgs(['node', 's']), 'a mode is required');
  throws(() => parseArgs(['node', 's', '--inventory', '--backup', '--session', 'x']), 'two modes rejected');
  throws(() => parseArgs(['node', 's', '--backup']), '--backup requires --session');
  throws(() => parseArgs(['node', 's', '--inventory', '--session', 'x']), '--session only with --backup/--archive');
  throws(() => parseArgs(['node', 's', '--backup', '--session', 'x', '--active-days', '7']), '--active-days only with --inventory');
  throws(() => parseArgs(['node', 's', '--inventory', '--active-days', '0']), '--active-days must be positive');
  throws(() => parseArgs(['node', 's', '--inventory', '--active-days']), 'dangling value flag rejected');
  throws(() => parseArgs(['node', 's', '--archive', '--session', 'x', '--discard-uncommitted']), 'there is no discard flag — archive keeps everything');
  throws(() => parseArgs(['node', 's', '--teardown', '--session', 'x']), 'there is no teardown mode');
  throws(() => parseArgs(['node', 's', '--archive', '--session', 'x', '--remote']), '--remote only with --backup');
  throws(() => parseArgs(['node', 's', '--remote-allow', 'app=origin', '--backup', '--session', 'x']), '--remote-allow is gated behind --remote --backup');
  throws(() => parseArgs(['node', 's', '--backup', '--session', 'x', '--remote-allow-all']), '--remote-allow-all requires --remote');
  throws(() => parseArgs(['node', 's', '--inventory', '--remote', '--remote-allow', 'app=origin']), '--remote-allow only with --backup');
  throws(() => parseArgs(['node', 's', '--backup', '--session', 'x', '--allow-uncommitted']), '--allow-uncommitted only with --archive');
  throws(() => parseArgs(['node', 's', '--backup', '--session', 'x', '--remote', '--remote-allow']), 'a dangling --remote-allow value is rejected');
  throws(() => parseArgs(['node', 's', '--inventory', '--bogus']), 'unknown flag rejected');
  const inv = parseArgs(['node', 's', '--root', '/w', '--inventory']);
  assertEq([inv.mode, inv.root, inv.activeDays], ['inventory', '/w', null], 'inventory defaults parse');
  const ar = parseArgs(['node', 's', '--archive', '--session', 'x', '--allow-uncommitted']);
  assertEq([ar.mode, ar.session, ar.allowUncommitted], ['archive', 'x', true], '--archive --session --allow-uncommitted parses');
  const bk = parseArgs(['node', 's', '--backup', '--session', 'x', '--remote', '--remote-allow', 'app=origin', '--remote-allow', '.=upstream']);
  assertEq([bk.mode, bk.remote, bk.remoteAllow], ['backup', true, ['app=origin', '.=upstream']], '--remote-allow is repeatable and "." names the workspace repo');
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
    assert(warn.message.includes('are on no remote') && warn.message.includes('origin:none'), 'the warning states count and state');
    assert(warn.message.startsWith('the workspace repo'), 'the warning names the repo');
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

console.log('# S1: table renders remote states, and every remote shows its URL');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'tbl', branch: 'bugfix/tbl', tracker: { status: 'active', branch: 'bugfix/tbl', repos: ['app'], updated: daysAgoIso(40) } });
    const inv = inventory(fx.root);
    const app = byName(inv, 'tbl').worktrees.find((w) => w.repo === 'app');
    assertEq(app.remotes.origin.state, 'none', 'unpushed branch is none');
    assertEq(app.remoteUrls.origin, fx.appOrigin, 'the configured remote URL is reported alongside');
    const r = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--inventory'], { encoding: 'utf8' });
    assert(r.stderr.includes('[origin:none]'), 'table renders [origin:none]');
    assert(r.stderr.includes(fx.appOrigin), 'table lists the remote URL — "origin:none" never means "no origin"');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# inventory: a repo whose origin is unreachable still reports the remote and its URL');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'ghost', branch: 'bugfix/ghost', tracker: { status: 'active', branch: 'bugfix/ghost', repos: ['app'], updated: daysAgoIso(40) } });
    // Origin configured but pointing nowhere: ls-remote cannot answer,
    // local config still can. The URL is the fact that keeps "origin"
    // from being an anonymous label — it may be a third-party upstream.
    git(fx.app, 'remote set-url origin /nonexistent/remote.git');
    const app = byName(inventory(fx.root), 'ghost').worktrees.find((w) => w.repo === 'app');
    assertEq(app.remoteUrls.origin, '/nonexistent/remote.git', 'the URL comes from local config, not the network');
    assertEq(app.remotes.origin.url, '/nonexistent/remote.git', 'the remote state entry carries the URL too');
    assertEq(app.remotes.origin.state, 'unknown', 'the state is honestly unknown');
    const r = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--inventory'], { encoding: 'utf8' });
    assert(r.stderr.includes('/nonexistent/remote.git'), 'the table shows the URL even though the remote is unreachable');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

// gh:172 review: a detached worktree has no branch to compare against any
// remote, but it still HAS remotes — each is listed with state no-branch
// and its URLs, never collapsed into "no remotes".
console.log('# inventory: a detached worktree lists its remotes as no-branch');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'det', branch: 'bugfix/det', tracker: { branch: 'bugfix/det', repos: ['app'], updated: daysAgoIso(40) } });
    git(join(fx.root, 'work-sessions', 'det', 'workspace', 'repos', 'app'), 'checkout -q --detach');
    const app = byName(inventory(fx.root), 'det').worktrees.find((w) => w.repo === 'app');
    assertEq(app.branch, null, 'the worktree is detached');
    assertEq(app.remotes.origin.state, 'no-branch', 'the remote is listed with state no-branch');
    assertEq(app.remoteUrls.origin, fx.appOrigin, 'the fetch URL is still reported');
    assert(Array.isArray(app.remotePushUrls.origin) && app.remotePushUrls.origin[0] === fx.appOrigin, 'and the push target');
    const r = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--inventory'], { encoding: 'utf8' });
    assert(r.stderr.includes('origin:no-branch'), 'the table renders origin:no-branch');
    assert(r.stderr.includes(fx.appOrigin), 'with the URL beside it');
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

console.log('# backup: local tags by default; push mode needs an explicit allow (idempotent)');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'drain', branch: 'bugfix/drain', tracker: { status: 'active', branch: 'bugfix/drain', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'project fix', daysAgoIso(40));

    // Push mode with no allow is a plan, not a start: exit non-zero,
    // every target's exact URL listed, nothing tagged, nothing pushed.
    const cli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--backup', '--session', 'drain', '--remote'], { encoding: 'utf8' });
    assertEq(cli.status, 1, 'no allow → non-zero exit');
    const plan = JSON.parse(cli.stdout);
    assertEq(plan.refused, true, 'the plan reports as a refusal');
    assertEq(plan.needsAllow, true, 'the plan says what is missing');
    assertEq(plan.targets.length, 2, 'one target per unsafe tip');
    assert(plan.targets.every((t) => t.remote === 'origin' && typeof t.url === 'string' && t.url.includes('origin.git')), 'every target names the remote and its exact URL');
    assert(plan.targets.every((t) => Array.isArray(t.pushUrls) && t.pushUrls.length === 1 && t.pushUrls[0] === t.url), 'every target also names its push URL — same as fetch when no pushurl is set');
    assert(plan.reasons.some((r) => r.includes('--remote-allow')), 'the reasons say which flag to add');
    assertEq(git(fx.root, 'tag -l "drain/drain/*"').trim(), '', 'the plan created no tag');
    assertEq(git(fx.wsOrigin, 'tag -l "drain/drain/*"').trim(), '', 'the plan pushed nothing');

    // The dry-run form of the same plan exits non-zero too — pushing is
    // still waiting on a decision, wet or dry.
    const dryCli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--backup', '--session', 'drain', '--remote', '--dry-run'], { encoding: 'utf8' });
    assertEq(dryCli.status, 1, 'the dry-run plan also exits non-zero');
    const dryPlan = JSON.parse(dryCli.stdout);
    assertEq(dryPlan.needsAllow, true, 'the dry plan says what is missing');
    assertEq(dryPlan.targets.length, 2, 'with every target listed');

    // Plain --backup: local tags only, both repos, no pushes at all.
    const out = backupSession(fx.root, { session: 'drain' });
    assertEq(out.refused, undefined, 'local backup is not refused');
    assertEq(out.branches.length, 2, 'one backup entry per unsafe tip');
    const wsEntry = out.branches.find((b) => b.repo === '.');
    const appEntry = out.branches.find((b) => b.repo === 'app');
    assert(wsEntry && wsEntry.tag === 'drain/drain/bugfix-drain', 'workspace tip tagged under a session-scoped tag');
    assert(appEntry && appEntry.tag === 'drain/drain/bugfix-drain', 'project tip tagged');
    assert(out.branches.every((b) => b.pushed === false && b.localOnly === true), 'local backup entries are local-only');
    assertEq(wsEntry.commit, git(wsWt, 'rev-parse HEAD').trim(), 'tag commit is the branch tip');
    assert(git(fx.root, 'tag -l drain/drain/bugfix-drain').trim() !== '', 'tag exists in the workspace repo');
    assert(git(fx.app, 'tag -l drain/drain/bugfix-drain').trim() !== '', 'tag exists in the project repo');
    assertEq(git(fx.wsOrigin, 'tag -l "drain/drain/*"').trim(), '', 'nothing pushed to the workspace origin');
    assertEq(git(fx.appOrigin, 'tag -l "drain/drain/*"').trim(), '', 'nothing pushed to the project origin');
    assert(
      git(fx.root, "for-each-ref refs/tags/drain/drain/bugfix-drain --format='%(contents:subject)'").trim()
        === 'backup before draining session drain',
      'annotated tag carries the backup message',
    );

    // Allow-all: both existing tags pushed, verified, and reported with URLs.
    const pushed = backupSession(fx.root, { session: 'drain', remote: true, remoteAllowAll: true });
    assertEq(pushed.refused, undefined, 'the allow-all run is not refused');
    assertEq(pushed.branches.length, 2, 'both tips pushed');
    assert(pushed.branches.every((b) => b.pushed === true && b.verified === true), 'pushes are verified');
    assert(pushed.branches.every((b) => b.remote === 'origin' && typeof b.url === 'string'), 'each pushed entry reports remote and URL');
    assert(git(fx.wsOrigin, 'tag -l drain/drain/bugfix-drain').trim() !== '', 'tag pushed to the workspace origin');
    assert(git(fx.appOrigin, 'tag -l drain/drain/bugfix-drain').trim() !== '', 'tag pushed to the project origin');

    // The next run finds both tips provably on origin via the drain
    // tags it just pushed — remote-safe tips are never re-tagged.
    const again = backupSession(fx.root, { session: 'drain', remote: true, remoteAllowAll: true });
    assertEq(again.refused, undefined, 'second backup run is not refused');
    assertEq(again.branches.length, 0, 'already-remote tips are not tagged again');
    assertEq(again.skipped.length, 2, 'both tips report as already safe');
    assert(again.skipped.every((s2) => s2.safeOn === 'origin'), 'the safety is attributed to origin');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# backup: --remote-allow scopes the push to the repos the operator named');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'scoped', branch: 'bugfix/scoped', tracker: { status: 'active', branch: 'bugfix/scoped', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'project fix', daysAgoIso(40));

    // The dry plan never hides a destination: the repo the allow does not
    // name still shows the remote and URL a push there would use.
    const scopedPlan = backupSession(fx.root, { session: 'scoped', remote: true, dryRun: true, remoteAllow: ['app=origin'] });
    const wsPlan = scopedPlan.tips.find((t) => t.repo === '.');
    assert(wsPlan && wsPlan.remote === 'origin' && typeof wsPlan.url === 'string' && wsPlan.url.includes('origin.git'), 'a non-allowed repo names the remote and URL it would push to');
    assert(wsPlan && wsPlan.willPush === false, 'while still saying it will not push there');
    const appPlan = scopedPlan.tips.find((t) => t.repo === 'app');
    assert(appPlan && appPlan.willPush === true, 'the allowed repo is the one marked to push');

    const out = backupSession(fx.root, { session: 'scoped', remote: true, remoteAllow: ['app=origin'] });
    assertEq(out.refused, undefined, 'the allow-one run is not refused');
    const appEntry = out.branches.find((b) => b.repo === 'app');
    const wsEntry = out.branches.find((b) => b.repo === '.');
    assert(appEntry && appEntry.pushed === true && appEntry.verified === true, 'the allowed repo is pushed');
    assert(wsEntry && wsEntry.pushed === false && wsEntry.localOnly === true, 'the un-named repo keeps a local tag');
    assert(wsEntry.wouldPushTo && wsEntry.wouldPushTo.remote === 'origin' && typeof wsEntry.wouldPushTo.url === 'string', 'the un-pushed entry still names where it would have pushed');
    assert(git(fx.appOrigin, 'tag -l drain/scoped/bugfix-scoped').trim() !== '', 'the allowed repo’s tag landed');
    assertEq(git(fx.wsOrigin, 'tag -l "drain/scoped/*"').trim(), '', 'the un-named repo was not pushed');
    assert(git(fx.root, 'tag -l drain/scoped/bugfix-scoped').trim() !== '', 'the un-named repo keeps its local tag');

    // Bad allows refuse before anything is tagged — unknown repo, unknown
    // remote, malformed entry.
    const badRepo = backupSession(fx.root, { session: 'scoped', remote: true, remoteAllow: ['nosuch=origin'] });
    assertEq(badRepo.refused, true, 'an unknown repo in --remote-allow refuses');
    assert(badRepo.reasons.some((r) => r.includes('nosuch') && r.includes('does not hold')), 'the refusal names the unknown repo');
    const badRemote = backupSession(fx.root, { session: 'scoped', remote: true, remoteAllow: ['app=nosuch'] });
    assertEq(badRemote.refused, true, 'an unknown remote in --remote-allow refuses');
    assert(badRemote.reasons.some((r) => r.includes('nosuch') && r.includes('not configured')), 'the refusal names the unknown remote');
    const malformed = backupSession(fx.root, { session: 'scoped', remote: true, remoteAllow: ['app'] });
    assertEq(malformed.refused, true, 'a malformed --remote-allow entry refuses');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# backup: only an exact remote branch/tag counts as already held');
{
  const fx = makeWorkspace();
  try {
    const { wsWt } = makeSession(fx, { name: 'merged', branch: 'bugfix/merged', repos: [], tracker: { status: 'active', branch: 'bugfix/merged', repos: [], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    // Merged into the remote's main: the tip is an ancestor of a remote
    // ref, but no remote branch or tag is AT it. Backup does no ancestry
    // walk and no fetch — it tags. (Archive never depends on this.)
    git(fx.root, 'merge -q --no-ff -m merge bugfix/merged');
    git(fx.root, 'push -q origin main');
    const out = backupSession(fx.root, { session: 'merged', remote: true, remoteAllowAll: true });
    assertEq(out.refused, undefined, 'backup is not refused');
    assertEq(out.branches.length, 1, 'an ancestor-only tip still gets a tag');
    // Once the branch itself is on the remote, it is held exactly.
    git(wsWt, 'push -q origin bugfix/merged');
    const again = backupSession(fx.root, { session: 'merged' });
    assertEq(again.skipped.length, 1, 'an exact remote branch counts as already held');
    assert(again.skipped[0].safeOn === 'origin', 'attributed to origin');
    // Ephemeral refs never count: advertise the tip only under refs/pull/.
    const sha = git(wsWt, 'rev-parse HEAD').trim();
    git(fx.wsOrigin, `update-ref refs/pull/1/head ${sha}`);
    git(fx.wsOrigin, 'update-ref -d refs/heads/bugfix/merged');
    git(fx.wsOrigin, 'tag -d drain/merged/bugfix-merged');
    git(fx.root, 'tag -d drain/merged/bugfix-merged');
    const third = backupSession(fx.root, { session: 'merged', dryRun: true });
    assertEq(third.tips.length, 1, 'a refs/pull/* ref does not count as held');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# backup: refuses a moved tag and a failed push; a repo with no remote keeps a local tag');
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

    // A repo with no remote is not a refusal: its backup is the local
    // tag, and push mode says so per entry instead of failing the run.
    makeSession(fx, { name: 'offline', branch: 'bugfix/offline', repos: ['solo'], tracker: { branch: 'bugfix/offline', repos: ['solo'], updated: daysAgoIso(40) } });
    writeFileSync(join(fx.root, 'work-sessions', 'offline', 'workspace', 'repos', 'solo', 'fix.txt'), 'fix\n');
    commitAll(join(fx.root, 'work-sessions', 'offline', 'workspace', 'repos', 'solo'), 'solo work', daysAgoIso(40));
    const offline = backupSession(fx.root, { session: 'offline', remote: true, remoteAllowAll: true });
    assertEq(offline.refused, undefined, 'a repo with no remote does not fail the run');
    const soloEntry = offline.branches.find((b) => b.repo === 'solo');
    assert(soloEntry && soloEntry.pushed === false && soloEntry.localOnly === true, 'the no-remote repo keeps a local tag');
    assert(soloEntry.reason.includes('no remote'), 'the entry says why it was not pushed');
    assert(git(solo, 'tag -l drain/offline/bugfix-offline').trim() !== '', 'the local tag exists');

    // A broken origin URL makes an ALLOWED push fail — refusal, never a
    // silent "probably fine".
    const { projWts: brokenWts } = makeSession(fx, { name: 'brokenpush', branch: 'bugfix/brokenpush', tracker: { branch: 'bugfix/brokenpush', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(brokenWts.app, 'fix.txt'), 'fix\n');
    commitAll(brokenWts.app, 'fix', daysAgoIso(40));
    git(fx.app, 'remote set-url origin /nonexistent/repo.git');
    const broken = backupSession(fx.root, { session: 'brokenpush', remote: true, remoteAllowAll: true });
    assertEq(broken.refused, true, 'a failed push refuses');
    assert(broken.reasons.some((r) => r.includes('failed') || r.includes('timed out')), 'the refusal names the push failure');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# S4: push-remote resolution — first remote without origin, allow entries name the remote');
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
    // An allow naming a remote the repo does not configure is refused
    // before anything is tagged.
    const badAllow = backupSession(fx.root, { session: 'nomigin', remote: true, remoteAllow: ['app=origin'] });
    assertEq(badAllow.refused, true, 'an allow naming an unconfigured remote refuses');
    assert(badAllow.reasons.some((r) => r.includes('origin')), 'the refusal names the remote');
    // allow-all resolves the first configured remote when there is no origin.
    const out = backupSession(fx.root, { session: 'nomigin', remote: true, remoteAllowAll: true });
    assertEq(out.refused, undefined, 'allow-all resolves without origin');
    const appEntry = out.branches.find((b) => b.repo === 'app');
    assert(appEntry && appEntry.remote === 'upstream', 'the first configured remote is used and reported');
    assert(git(upstream, 'tag -l drain/nomigin/bugfix-nomigin').trim() !== '', 'the tag landed on upstream');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, upstream); }
}

// gh:172 review: the fetch URL is what the operator reads as "the remote",
// but `git push` sends to remote.<name>.pushurl — a decoy there must be
// visible in the plan, must not be reachable through --remote-allow-all,
// and the push (and its verification) must land on the printed decoy.
console.log('# backup: a pushurl decoy is shown in the plan, gated from allow-all, pushed to when explicitly allowed');
{
  const fx = makeWorkspace();
  const decoy = join(mkdtempSync(join(tmpdir(), 'mig-decoy-')), 'decoy.git');
  try {
    execSync(`git init -q --bare "${decoy}"`, { stdio: 'pipe' });
    const { projWts } = makeSession(fx, { name: 'decoy', branch: 'bugfix/decoy', tracker: { branch: 'bugfix/decoy', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'fix', daysAgoIso(40));
    git(fx.app, `remote set-url --push origin "${decoy}"`);

    // The no-allow plan shows BOTH sides: the fetch URL and where the
    // push would really go.
    const plan = backupSession(fx.root, { session: 'decoy', remote: true, dryRun: true });
    assertEq(plan.needsAllow, true, 'the plan asks for an allow');
    const target = plan.targets.find((t) => t.repo === 'app');
    assert(target && target.url === fx.appOrigin, 'the target shows the fetch URL');
    assert(target && Array.isArray(target.pushUrls) && target.pushUrls.length === 1 && target.pushUrls[0] === decoy, 'with the push target beside it');
    assert(plan.reasons.some((r) => r.includes(decoy) && r.includes('pushes to')), 'the reasons print the push target');

    // allow-all blesses fetch URLs only — the divergence refuses before
    // anything is tagged, in any repo.
    const blanket = backupSession(fx.root, { session: 'decoy', remote: true, remoteAllowAll: true });
    assertEq(blanket.refused, true, 'allow-all does not bless a divergent push URL');
    assert(blanket.reasons.some((r) => r.includes(decoy) && r.includes('--remote-allow app=origin')), 'the refusal shows the push target and the explicit way through');
    assertEq(git(fx.app, 'tag -l "drain/decoy/*"').trim(), '', 'nothing was tagged by the refused run');
    assertEq(git(fx.root, 'tag -l "drain/decoy/*"').trim(), '', 'in any repo — a refusal acts on nothing');

    // The explicit allow names the remote: the push goes where the plan
    // said, and verification confirms it THERE (the fetch origin never
    // sees the tag).
    const allowed = backupSession(fx.root, { session: 'decoy', remote: true, remoteAllow: ['app=origin'] });
    assertEq(allowed.refused, undefined, 'the explicit allow proceeds');
    const appPushed = allowed.branches.find((b) => b.repo === 'app');
    assert(appPushed && appPushed.pushed === true && appPushed.verified === true, 'the push is verified');
    assert(appPushed && Array.isArray(appPushed.pushUrls) && appPushed.pushUrls[0] === decoy, 'the entry reports the push URL it was verified against');
    assert(git(decoy, 'tag -l drain/decoy/bugfix-decoy').trim() !== '', 'the tag landed on the decoy — where git push sends');
    assertEq(git(fx.appOrigin, 'tag -l "drain/decoy/*"').trim(), '', 'and not on the fetch origin');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, decoy); }
}

// gh:172 review: url.*.pushInsteadOf rewrites push targets without any
// pushurl config — the resolution must catch that rewrite too (it comes
// from `remote get-url --push`, which expands insteadOf/pushInsteadOf).
console.log('# backup: a pushInsteadOf rewrite is resolved as the push target');
{
  const fx = makeWorkspace();
  const instead = join(mkdtempSync(join(tmpdir(), 'mig-instead-')), 'instead.git');
  try {
    execSync(`git init -q --bare "${instead}"`, { stdio: 'pipe' });
    const { projWts } = makeSession(fx, { name: 'insteadof', branch: 'bugfix/insteadof', tracker: { branch: 'bugfix/insteadof', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'fix', daysAgoIso(40));
    git(fx.app, `config "url.${instead}.pushInsteadOf" "${fx.appOrigin}"`);

    const plan = backupSession(fx.root, { session: 'insteadof', remote: true });
    assertEq(plan.needsAllow, true, 'the plan asks for an allow');
    const target = plan.targets.find((t) => t.repo === 'app');
    assert(target && target.url === fx.appOrigin && target.pushUrls[0] === instead, 'the rewritten push target is shown beside the fetch URL');
    assertEq(backupSession(fx.root, { session: 'insteadof', remote: true, remoteAllowAll: true }).refused, true, 'allow-all still refuses the divergence');
    const allowed = backupSession(fx.root, { session: 'insteadof', remote: true, remoteAllow: ['app=origin'] });
    assertEq(allowed.refused, undefined, 'the explicit allow proceeds');
    assert(git(instead, 'tag -l drain/insteadof/bugfix-insteadof').trim() !== '', 'the push went to the rewritten target');
    assertEq(git(fx.appOrigin, 'tag -l "drain/insteadof/*"').trim(), '', 'not to the fetch origin');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, instead); }
}

// gh:172 review: "verified" must mean verified at the push URL. The push
// here succeeds; only the ls-remote against the push URL is faked empty —
// exactly the gap the old fetch-URL check would have papered over.
console.log('# backup: a tag missing at the push URL fails verification and rolls back');
{
  const fx = makeWorkspace();
  const decoy = join(mkdtempSync(join(tmpdir(), 'mig-verify-')), 'decoy.git');
  try {
    execSync(`git init -q --bare "${decoy}"`, { stdio: 'pipe' });
    const { projWts } = makeSession(fx, { name: 'verify', branch: 'bugfix/verify', tracker: { branch: 'bugfix/verify', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'fix', daysAgoIso(40));
    git(fx.app, `remote set-url --push origin "${decoy}"`);
    const fakeLs = (cmd, args, opts = {}) => (
      args.includes('ls-remote') && args.includes('--tags') && args.includes(decoy)
        ? { status: 0, stdout: '', stderr: '' }
        : gitFn(cmd, args, opts)
    );
    const out = backupSession(fx.root, { session: 'verify', remote: true, remoteAllow: ['app=origin'], gitFn: fakeLs });
    assertEq(out.refused, true, 'a tag missing at the push URL refuses');
    assert(out.reasons.some((r) => r.includes('not found at the push URL')), 'the refusal names the push-URL check');
    assertEq(git(fx.app, 'tag -l "drain/verify/*"').trim(), '', 'the unverified local tag was rolled back');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, decoy); }
}

// gh:172 review: --remote-allow and --remote-allow-all combine — allow-all
// covers every repo, an entry only pinning which remote its repo uses.
// The plan must still print every push URL, allowed or not.
console.log('# backup: --remote-allow alongside --remote-allow-all covers every repo and prints every push URL');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'both', branch: 'bugfix/both', tracker: { branch: 'bugfix/both', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'project fix', daysAgoIso(40));

    const plan = backupSession(fx.root, { session: 'both', remote: true, dryRun: true, remoteAllow: ['app=origin'], remoteAllowAll: true });
    assertEq(plan.tips.length, 2, 'the plan covers both tips');
    assert(plan.tips.every((t) => t.willPush === true && t.remote === 'origin' && Array.isArray(t.pushUrls) && t.pushUrls.length === 1 && typeof t.pushUrls[0] === 'string'), 'every repo is covered and names its push URL');

    const out = backupSession(fx.root, { session: 'both', remote: true, remoteAllow: ['app=origin'], remoteAllowAll: true });
    assertEq(out.refused, undefined, 'the combined run is not refused');
    assertEq(out.branches.length, 2, 'both tips backed up');
    assert(out.branches.every((b) => b.pushed === true && b.verified === true), 'the explicit entry does not narrow allow-all');
    assert(git(fx.wsOrigin, 'tag -l drain/both/bugfix-both').trim() !== '', 'the un-named repo pushed');
    assert(git(fx.appOrigin, 'tag -l drain/both/bugfix-both').trim() !== '', 'and the named one');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# archive: moves the session and keeps every kind of state intact');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'keep', branch: 'bugfix/keep', tracker: { branch: 'bugfix/keep', repos: ['app'], updated: daysAgoIso(40) } });
    const app = projWts.app;
    // Unpushed commits in both repos.
    writeFileSync(join(wsWt, 'NOTES.md'), 'workspace content\n');
    commitAll(wsWt, 'ws content', daysAgoIso(40));
    writeFileSync(join(app, 'fix.txt'), 'project fix\n');
    commitAll(app, 'app fix', daysAgoIso(40));
    const wsTip = git(wsWt, 'rev-parse HEAD').trim();
    const appTip = git(app, 'rev-parse HEAD').trim();
    // Index-hidden, uncommitted, untracked, and ignored edits (the
    // commit comes first: commitAll stages everything).
    writeFileSync(join(app, 'hidden.txt'), 'v1\n');
    commitAll(app, 'hidden v1', daysAgoIso(40));
    writeFileSync(join(app, 'hidden.txt'), 'v2 hidden by assume-unchanged\n');
    git(app, 'update-index --assume-unchanged hidden.txt');
    writeFileSync(join(app, 'README.md'), '# app\nlocal edit\n');
    writeFileSync(join(app, 'untracked.txt'), 'untracked\n');
    writeFileSync(join(wsWt, '.gitignore'), 'local-only-*\nrepos\n');
    writeFileSync(join(wsWt, 'local-only-draft.md'), 'ignored draft\n');
    // A per-worktree ref and an embedded repository with its own history.
    git(app, `update-ref refs/worktree/keep ${appTip}`);
    const vendor = join(app, 'vendor-lib');
    mkdirSync(vendor, { recursive: true });
    git(vendor, 'init -q -b main');
    writeFileSync(join(vendor, 'lib.txt'), 'embedded\n');
    commitAll(vendor, 'embedded history');
    const vendorTip = git(vendor, 'rev-parse HEAD').trim();
    // Something beside workspace/ in the session folder.
    writeFileSync(join(fx.root, 'work-sessions', 'keep', 'notes.md'), 'beside workspace\n');

    const out = archiveSession(fx.root, { session: 'keep', cwd: fx.root, allowUncommitted: true, now: Date.UTC(2026, 8, 27, 12, 0, 0) });
    assertEq(out.refused, undefined, 'archive is not refused');
    assertEq(out.to, join('work-sessions', '.archived', 'keep--20260927T120000'), 'archived under .archived/ with a stamp');
    assert(!existsSync(join(fx.root, 'work-sessions', 'keep')), 'the session left the active lifecycle');
    const dest = join(fx.root, out.to);
    const dWs = join(dest, 'workspace');
    const dApp = join(dWs, 'repos', 'app');
    assertEq(readFileSync(join(dest, 'notes.md'), 'utf8'), 'beside workspace\n', 'a file beside workspace/ is kept');
    assertEq(readFileSync(join(dWs, 'local-only-draft.md'), 'utf8'), 'ignored draft\n', 'an ignored draft is kept');
    assertEq(readFileSync(join(dApp, 'untracked.txt'), 'utf8'), 'untracked\n', 'an untracked file is kept');
    assertEq(readFileSync(join(dApp, 'README.md'), 'utf8'), '# app\nlocal edit\n', 'an uncommitted edit is kept');
    assertEq(readFileSync(join(dApp, 'hidden.txt'), 'utf8'), 'v2 hidden by assume-unchanged\n', 'an assume-unchanged edit is kept');
    assert(git(dApp, 'ls-files -v hidden.txt').startsWith('h '), 'the assume-unchanged flag is kept');
    assertEq(git(join(dApp, 'vendor-lib'), 'rev-parse HEAD').trim(), vendorTip, 'the embedded repository and its history are kept');
    // Git follows the move.
    assertEq(realpathSync(git(dWs, 'rev-parse --show-toplevel').trim()), realpathSync(dWs), 'the workspace worktree resolves at its new path');
    assertEq(realpathSync(git(dApp, 'rev-parse --show-toplevel').trim()), realpathSync(dApp), 'the project worktree resolves at its new path');
    assertEq(git(dWs, 'rev-parse HEAD').trim(), wsTip, 'workspace branch tip unchanged');
    assertEq(git(dApp, 'rev-parse HEAD').trim(), appTip.length ? git(dApp, 'rev-parse bugfix/keep').trim() : '', 'project branch still checked out');
    assertEq(git(dApp, 'rev-parse refs/worktree/keep').trim(), appTip, 'the per-worktree ref is kept');
    assertEq(git(dApp, `cat-file -t ${appTip}`).trim(), 'commit', 'and the commit it names is still present');
    assert(git(fx.root, 'worktree list --porcelain').includes(realpathSync(dWs)), 'the workspace repo lists the moved worktree');
    assert(git(fx.app, 'worktree list --porcelain').includes(realpathSync(dApp)), 'the project repo lists the moved worktree');
    assertEq(git(fx.root, 'worktree prune --dry-run -v').trim(), '', 'nothing is prunable in the workspace repo');
    assertEq(git(fx.app, 'worktree prune --dry-run -v').trim(), '', 'nothing is prunable in the project repo');
    const st = git(dApp, 'status --porcelain');
    assert(st.includes(' M README.md') && st.includes('?? untracked.txt'), 'the worktree still reports its uncommitted and untracked files');
    assertEq(git(dApp, 'rev-list --count HEAD ^origin/main').trim(), '2', 'both unpushed project commits are still on the branch');
    // The archive is out of the inventory, and a new session may reuse the name.
    assertEq(byName(inventory(fx.root), 'keep'), undefined, 'the inventory no longer lists the archived session');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# archive: uncommitted changes refuse by default; --allow-uncommitted proceeds');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'notes', branch: 'bugfix/notes', tracker: { branch: 'bugfix/notes', repos: ['app'], updated: daysAgoIso(40) } });
    commitAll(wsWt, 'tracker', daysAgoIso(40)); // session.md committed clean
    writeFileSync(join(projWts.app, 'untracked.txt'), 'scratch\n'); // untracked project file
    writeFileSync(join(wsWt, 'session.md'), '---\ntype: session-tracker\nstatus: paused\n---\n\nedited, not committed\n'); // dirty session.md
    const out = archiveSession(fx.root, { session: 'notes', cwd: fx.root });
    assertEq(out.refused, true, 'uncommitted changes refuse the archive');
    assert(out.reasons.some((r) => r.includes('workspace') && r.includes('session.md')), 'the refusal names the uncommitted session.md');
    assert(out.reasons.some((r) => r.includes('untracked.txt')), 'the refusal names the project worktree’s untracked file');
    assert(out.reasons.some((r) => r.includes('--allow-uncommitted')), 'the refusal names the explicit way out');
    assert(existsSync(join(fx.root, 'work-sessions', 'notes', 'workspace')), 'nothing moved');

    // The operator’s explicit choice: proceed — the edits ride along.
    const ok = archiveSession(fx.root, { session: 'notes', cwd: fx.root, allowUncommitted: true, now: Date.UTC(2026, 8, 27, 12, 0, 0) });
    assertEq(ok.refused, undefined, '--allow-uncommitted archives');
    assert(readFileSync(join(fx.root, ok.to, 'workspace', 'session.md'), 'utf8').includes('edited, not committed'), 'the uncommitted session.md edit survives uncommitted');
    assertEq(readFileSync(join(fx.root, ok.to, 'workspace', 'repos', 'app', 'untracked.txt'), 'utf8'), 'scratch\n', 'the untracked file survives');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# archive: a failed repair moves the session back, nothing lost');
{
  const fx = makeWorkspace();
  try {
    const { wsWt } = makeSession(fx, { name: 'rb', branch: 'bugfix/rb', tracker: { branch: 'bugfix/rb', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'content\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    let failOnce = true;
    const flaky = (cmd, args, opts) => {
      if (failOnce && args.includes('worktree') && args.includes('repair')) {
        failOnce = false;
        return { status: 1, stdout: '', stderr: 'simulated repair failure' };
      }
      return gitFn(cmd, args, opts);
    };
    const out = archiveSession(fx.root, { session: 'rb', cwd: fx.root, gitFn: flaky });
    assertEq(out.refused, true, 'a failed repair refuses');
    assert(out.reasons.some((r) => r.includes('back at') && r.includes('nothing was lost')), 'the refusal reports a verified restore');
    assert(existsSync(join(fx.root, 'work-sessions', 'rb', 'workspace', 'NOTES.md')), 'the session is back where it was');
    assertEq(realpathSync(git(wsWt, 'rev-parse --show-toplevel').trim()), realpathSync(wsWt), 'and its worktree resolves there');
    assert(!existsSync(join(fx.root, 'work-sessions', '.archived', 'rb')), 'nothing was left in the archive');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# archive: a thrown git error during repair still rolls back consistently');
{
  const fx = makeWorkspace();
  try {
    const { wsWt } = makeSession(fx, { name: 'thr', branch: 'bugfix/thr', tracker: { branch: 'bugfix/thr', repos: ['app'], updated: daysAgoIso(40) } });
    // Clean worktrees, so the uncommitted-changes gate stays out of the
    // way — this case is about the repair throwing, not the dirty check.
    commitAll(wsWt, 'tracker', daysAgoIso(40));
    let fired = false;
    const throwing = (cmd, args, opts) => {
      if (!fired && args.includes('worktree') && args.includes('repair')) { fired = true; throw new Error('spawn exploded'); }
      return gitFn(cmd, args, opts);
    };
    const out = archiveSession(fx.root, { session: 'thr', cwd: fx.root, gitFn: throwing });
    assertEq(out.refused, true, 'a thrown error refuses instead of escaping');
    assert(out.reasons.some((r) => r.includes('nothing was lost')), 'the restore is verified');
    assertEq(realpathSync(git(wsWt, 'rev-parse --show-toplevel').trim()), realpathSync(wsWt), 'the session resolves where it was');
    assertEq(git(fx.root, 'worktree prune --dry-run -v').trim(), '', 'no broken links in the workspace repo');
    assertEq(git(fx.app, 'worktree prune --dry-run -v').trim(), '', 'no broken links in the project repo');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# archive: an unreadable directory refuses (it could hide a worktree)');
if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
  const fx = makeWorkspace();
  const priv = join(fx.root, 'work-sessions', 'hid', 'workspace', 'private');
  try {
    const { wsWt } = makeSession(fx, { name: 'hid', branch: 'bugfix/hid', tracker: { branch: 'bugfix/hid', repos: ['app'], updated: daysAgoIso(40) } });
    mkdirSync(priv, { recursive: true });
    git(fx.app, `worktree add -q -b bugfix/hidden "${join(priv, 'appwt')}"`);
    chmodSync(priv, 0o000);
    const out = archiveSession(fx.root, { session: 'hid', cwd: fx.root });
    chmodSync(priv, 0o755);
    assertEq(out.refused, true, 'an unreadable directory refuses');
    assert(out.reasons.some((r) => r.includes('cannot read')), 'the refusal names the unreadable directory');
    assert(existsSync(join(wsWt, 'private', 'appwt', '.git')), 'nothing was moved');
  } finally {
    try { chmodSync(priv, 0o755); } catch { /* already restored */ }
    clean(fx.root, fx.wsOrigin, fx.appOrigin);
  }
} else {
  console.log('  (skipped: needs a non-root POSIX user)');
}

console.log('# archive: a symlinked .archived directory refuses (would leave the workspace)');
{
  const fx = makeWorkspace();
  const elsewhere = mkdtempSync(join(tmpdir(), 'mig-elsewhere-'));
  try {
    makeSession(fx, { name: 'esc', branch: 'bugfix/esc', tracker: { branch: 'bugfix/esc', repos: ['app'], updated: daysAgoIso(40) } });
    let linked = true;
    try { symlinkSync(elsewhere, join(fx.root, 'work-sessions', '.archived')); } catch { linked = false; }
    if (linked) {
      const out = archiveSession(fx.root, { session: 'esc', cwd: fx.root });
      assertEq(out.refused, true, 'a symlinked archive directory refuses');
      assert(existsSync(join(fx.root, 'work-sessions', 'esc', 'workspace')), 'the session did not move');
      assertEq(readdirSync(elsewhere).length, 0, 'nothing landed outside the workspace');
    } else {
      console.log('  (symlinks unsupported here — case skipped)');
    }
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, elsewhere); }
}

console.log('# archive: a submodule checkout refuses with an accurate reason');
{
  const fx = makeWorkspace();
  const subSrc = mkdtempSync(join(tmpdir(), 'mig-sub-src-'));
  try {
    git(subSrc, 'init -q -b main');
    writeFileSync(join(subSrc, 's.txt'), 's\n');
    commitAll(subSrc, 'sub');
    const { projWts } = makeSession(fx, { name: 'sub', branch: 'bugfix/sub', tracker: { branch: 'bugfix/sub', repos: ['app'], updated: daysAgoIso(40) } });
    execSync(`git -c protocol.file.allow=always -C "${projWts.app}" submodule add -q "${subSrc}" vendor/sub`, { stdio: 'pipe', env: process.env });
    const out = archiveSession(fx.root, { session: 'sub', cwd: fx.root });
    assertEq(out.refused, true, 'a submodule checkout refuses');
    assert(out.reasons.some((r) => r.includes('submodule')), 'the reason says submodule, not "outside repository"');
    assert(existsSync(join(projWts.app, 'vendor', 'sub', 's.txt')), 'nothing was moved');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, subSrc); }
}

console.log('# archive: dot-prefixed session names are rejected by every mode');
{
  throws(() => parseArgs(['node', 's', '--archive', '--session', '.archived']), 'parseArgs rejects .archived');
  const fx = makeWorkspace();
  try {
    throws(() => archiveSession(fx.root, { session: '.archived' }), 'archiveSession rejects a dot name');
    throws(() => backupSession(fx.root, { session: '.hidden', dryRun: true }), 'backupSession rejects a dot name');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# archive: a destination that already exists refuses');
{
  const fx = makeWorkspace();
  try {
    makeSession(fx, { name: 'dup', branch: 'bugfix/dup', tracker: { branch: 'bugfix/dup', repos: ['app'], updated: daysAgoIso(40) } });
    const now = Date.UTC(2026, 8, 27, 9, 0, 0);
    mkdirSync(join(fx.root, 'work-sessions', '.archived', 'dup--20260927T090000'), { recursive: true });
    const out = archiveSession(fx.root, { session: 'dup', cwd: fx.root, now });
    assertEq(out.refused, true, 'an existing destination refuses');
    assert(existsSync(join(fx.root, 'work-sessions', 'dup', 'workspace')), 'the session is untouched');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# archive: a broken shell is archived, not deleted');
{
  const fx = makeWorkspace();
  try {
    mkdirSync(join(fx.root, 'work-sessions', 'shell', 'workspace', 'repos'), { recursive: true });
    writeFileSync(join(fx.root, 'work-sessions', 'shell', 'workspace', 'stray.md'), 'a file\n');
    const out = archiveSession(fx.root, { session: 'shell', cwd: fx.root });
    assertEq(out.archived, true, 'a broken shell archives');
    assertEq(out.worktrees.length, 0, 'it held no worktrees');
    assertEq(readFileSync(join(fx.root, out.to, 'workspace', 'stray.md'), 'utf8'), 'a file\n', 'its file is kept');
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
      const ar = archiveSession(fx.root, { session: 'outsider', cwd: fx.root });
      assertEq(ar.refused, true, 'archive refuses a symlinked session');
      const bk = backupSession(fx.root, { session: 'outsider' });
      assertEq(bk.refused, true, 'backup refuses a symlinked session');
      assert(existsSync(join(fx.root, 'work-sessions', 'outsider')), 'the symlink is untouched');
    }
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, target); }
}

console.log('# N4: a worktree of a repository outside the workspace refuses archive, untouched');
{
  const fx = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'mig-outside-repo-'));
  try {
    makeSession(fx, { name: 'host', branch: 'bugfix/host', tracker: { branch: 'bugfix/host', repos: ['app'], updated: daysAgoIso(40) } });
    git(outside, 'init -q -b main');
    writeFileSync(join(outside, 'x.txt'), 'x\n');
    commitAll(outside, 'outside');
    const intruder = join(fx.root, 'work-sessions', 'host', 'workspace', 'scratch-wt');
    git(outside, `worktree add -q -b feature/intruder "${intruder}"`);
    const before = git(outside, 'worktree list --porcelain');
    const out = archiveSession(fx.root, { session: 'host', cwd: fx.root });
    assertEq(out.refused, true, 'a worktree of an outside repository refuses');
    assert(out.reasons.some((r) => r.includes('outside this workspace')), 'the refusal names the outside repository');
    assert(existsSync(join(fx.root, 'work-sessions', 'host', 'workspace')), 'nothing was moved');
    assertEq(git(outside, 'worktree list --porcelain'), before, 'the outside repository was not touched');
    git(outside, `worktree remove --force "${intruder}"`);
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin, outside); }
}

console.log('# S5: the session hosting the current chat refuses backup and archive');
{
  const fx = makeWorkspace();
  try {
    const { wsWt } = makeSession(fx, { name: 'self', branch: 'bugfix/self', tracker: { branch: 'bugfix/self', repos: ['app'], updated: daysAgoIso(40) } });
    const inside = join(fx.root, 'work-sessions', 'self', 'workspace');
    const td = archiveSession(fx.root, { session: 'self', cwd: inside });
    assertEq(td.refused, true, 'archive from inside the session refuses');
    assert(td.reasons.some((r) => r.includes('hosts the current chat')), 'the refusal explains why');
    const bk = backupSession(fx.root, { session: 'self', cwd: join(inside, 'repos', 'app') });
    assertEq(bk.refused, true, 'backup from inside the session refuses');

    // From the launcher the self-host refusal is gone.
    commitAll(wsWt, 'tracker', daysAgoIso(40));
    const ok = archiveSession(fx.root, { session: 'self', cwd: fx.root });
    assertEq(ok.refused, undefined, 'from the launcher root there is no self-host refusal');
    assertEq(ok.archived, true, 'and the archive completes');
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

    const refuse = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--archive', '--session', 'no-such-session'], { encoding: 'utf8' });
    assertEq(refuse.status, 1, 'an archive refusal exits 1');
    assertEq(JSON.parse(refuse.stdout).refused, true, 'refusal JSON on stdout');

    const bad = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--bogus'], { encoding: 'utf8' });
    assertEq(bad.status, 2, 'an argument error exits 2');

    const notWs = spawnSync(process.execPath, [SCRIPT, '--root', GIT_CFG, '--inventory'], { encoding: 'utf8' });
    assertEq(notWs.status, 2, 'a --root without workspace.json exits 2');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# R3: --backup --dry-run reports the plan with no side effects');
{
  const fx = makeWorkspace();
  try {
    const { wsWt, projWts } = makeSession(fx, { name: 'dry', branch: 'bugfix/dry', tracker: { branch: 'bugfix/dry', repos: ['app'], updated: daysAgoIso(40) } });
    writeFileSync(join(wsWt, 'NOTES.md'), 'unpushed\n');
    commitAll(wsWt, 'content', daysAgoIso(40));
    writeFileSync(join(projWts.app, 'fix.txt'), 'fix\n');
    commitAll(projWts.app, 'fix', daysAgoIso(40));
    git(projWts.app, 'push -q origin bugfix/dry');
    const plan = backupSession(fx.root, { session: 'dry', dryRun: true });
    assertEq(plan.refused, undefined, 'the dry run is not refused');
    assertEq(plan.dryRun, true, 'the output says it was a dry run');
    assertEq(plan.tips.length, 1, 'only the unproven tip is planned');
    const t = plan.tips[0];
    assert(t.repo === '.' && t.tag === 'drain/dry/bugfix-dry' && t.willPush === false && t.wouldCreate === true, 'the local plan names the tag and says nothing is pushed');
    assertEq(plan.skipped.length, 1, 'the remote-safe tip is reported as skipped');
    assertEq(git(fx.root, 'tag -l "drain/dry/*"').trim(), '', 'no tag was created');
    assertEq(git(fx.wsOrigin, 'tag -l "drain/dry/*"').trim(), '', 'nothing was pushed');
    // The real local run performs exactly the plan; the allow-all push run
    // then takes the same tag to the remote.
    const real = backupSession(fx.root, { session: 'dry' });
    assertEq(real.branches.length, 1, 'the real run tags the planned tip');
    assertEq(git(fx.wsOrigin, 'tag -l "drain/dry/*"').trim(), '', 'the local run still pushed nothing');
    const pushRun = backupSession(fx.root, { session: 'dry', remote: true, remoteAllowAll: true });
    assertEq(pushRun.refused, undefined, 'the push run is not refused');
    assert(git(fx.wsOrigin, 'tag -l drain/dry/bugfix-dry').trim() !== '', 'the tag landed');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# R3/S2c: a fresh worktree on an old commit reads as recent');
{
  const fx = makeWorkspace();
  try {
    // Reflogs KEPT: the creation entry's own timestamp is "now", even
    // though the commit it references is old — %gd (entry time) is the
    // signal, not %ct (commit date).
    makeSession(fx, { name: 'fresh', branch: 'bugfix/fresh', tracker: { branch: 'bugfix/fresh', repos: ['app'], updated: daysAgoIso(40) }, stripLogs: false });
    const s = byName(inventory(fx.root), 'fresh');
    assert(s.worktrees.every((w) => w.reflogAt != null), 'the creation reflog is read');
    assertEq(s.proposal, 'ACTIVE', 'a fresh worktree reads as recent activity');
  } finally { clean(fx.root, fx.wsOrigin, fx.appOrigin); }
}

console.log('# R3: parseArgs --dry-run validation');
{
  throws(() => parseArgs(['node', 's', '--inventory', '--dry-run']), '--dry-run only with --backup');
  const ok = parseArgs(['node', 's', '--backup', '--session', 'x', '--dry-run', '--remote', '--remote-allow-all']);
  assertEq([ok.mode, ok.dryRun, ok.remote, ok.remoteAllowAll], ['backup', true, true, true], '--backup --dry-run --remote --remote-allow-all parses');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
