#!/usr/bin/env node
// Unit tests for cleanup-work-session.mjs
// Run: node template/.claude/scripts/cleanup-work-session.test.mjs
//
// These tests build a minimal real workspace in a temp directory (two git
// repos, two worktrees on a session branch, a session.md tracker), invoke
// the cleanup script as a subprocess, and assert the post-state matches
// the mandatory teardown contract from workspace-structure.md:
//   - no leftover worktree records (including no `prunable` orphans)
//   - no leftover local branches in either repo
//   - the work-sessions/{name}/ folder is gone
//   - success: true iff all of the above hold

import { execFileSync, execSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, cpSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = .claude/scripts/, so .claude/ is one up.
const CLAUDE_DIR = resolve(HERE, '..');
const SCRIPT_REL = '.claude/scripts/cleanup-work-session.mjs';

// The fixture copies .claude/ rather than symlinking it. Symlinking would
// cause `import.meta.url` inside the script to resolve through the symlink
// to the template's real path, making getWorkspaceRoot() return the template
// directory instead of the fixture root — silently breaking every step of
// the script. Real workspaces ship a dogfood copy of .claude/ (not a
// symlink), so copy matches production.

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function git(repo, args, opts = {}) {
  return execSync(`git -C "${repo}" ${args}`, { stdio: 'pipe', encoding: 'utf-8', ...opts });
}

function makeFixture(sessionName = 'test', branch = 'bugfix/test', repoNames = ['proj']) {
  const T = join(tmpdir(), `cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(T, { recursive: true });

  // Workspace repo at T
  execSync(`git init -q -b main "${T}"`, { stdio: 'pipe' });
  // Copy .claude/ so the cleanup script's relative imports resolve AND
  // import.meta.url stays under T (see note above on why a symlink is wrong).
  cpSync(CLAUDE_DIR, join(T, '.claude'), { recursive: true });
  writeFileSync(join(T, 'workspace.json'), JSON.stringify({
    workspace: {
      name: 'fixture',
      scratchpadDir: 'workspace-scratchpad',
      workSessionsDir: 'work-sessions',
      releaseNotesDir: 'workspace-context/release-notes',
    },
    repos: Object.fromEntries(repoNames.map(n => [n, { remote: 'none', branch: 'main' }])),
  }, null, 2));
  // .gitignore so the workspace repo doesn't try to commit the symlinked .claude
  writeFileSync(join(T, '.gitignore'), '.claude\nrepos\nwork-sessions\n');
  writeFileSync(join(T, 'README.md'), '# fixture\n');
  git(T, '-c user.email=t@t -c user.name=t add -A');
  git(T, '-c user.email=t@t -c user.name=t commit -q -m init');

  // Project repo(s) at T/repos/{name}/
  const projRepos = {};
  for (const name of repoNames) {
    const repo = join(T, 'repos', name);
    mkdirSync(repo, { recursive: true });
    execSync(`git init -q -b main "${repo}"`, { stdio: 'pipe' });
    writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
    git(repo, '-c user.email=t@t -c user.name=t add -A');
    git(repo, '-c user.email=t@t -c user.name=t commit -q -m init');
    projRepos[name] = repo;
  }

  // Workspace worktree on the session branch
  const wsWt = join(T, 'work-sessions', sessionName, 'workspace');
  git(T, `worktree add -q -b "${branch}" "${wsWt}"`);
  // Nested project worktrees on the session branch
  const projWts = {};
  for (const name of repoNames) {
    const projWt = join(wsWt, 'repos', name);
    mkdirSync(dirname(projWt), { recursive: true });
    git(projRepos[name], `worktree add -q -b "${branch}" "${projWt}"`);
    projWts[name] = projWt;
  }

  // session.md (minimal but valid for readSessionTracker)
  const sessionMd = `---
type: session-tracker
name: ${sessionName}
status: active
branch: ${branch}
user: t
repos:
${repoNames.map(n => `  - ${n}`).join('\n')}
---

# Session
`;
  writeFileSync(join(wsWt, 'session.md'), sessionMd);

  return { T, sessionName, branch, repoNames, projRepos, wsWt, projWts };
}

function teardownFixture(T) {
  try { rmSync(T, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

function runCleanup(T, sessionName) {
  const scriptPath = join(T, SCRIPT_REL);
  const out = execFileSync('node', [scriptPath, '--session-name', sessionName], {
    cwd: T, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Script prints a single JSON line.
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

function inspectPostState(T, fx) {
  const wsList = git(T, 'worktree list --porcelain');
  const projLists = Object.fromEntries(
    fx.repoNames.map(n => [n, git(fx.projRepos[n], 'worktree list --porcelain')]),
  );
  const wsBranches = git(T, `branch --list "${fx.branch}"`).trim();
  const projBranches = Object.fromEntries(
    fx.repoNames.map(n => [n, git(fx.projRepos[n], `branch --list "${fx.branch}"`).trim()]),
  );
  return { wsList, projLists, wsBranches, projBranches };
}

// === Test 1: happy path — full session, run cleanup, verify clean ===
console.log('# happy path: full session teardown');
{
  const fx = makeFixture();
  assert(existsSync(fx.wsWt), 'pre: workspace worktree exists on disk');
  assert(existsSync(fx.projWts.proj), 'pre: project worktree exists on disk');

  let result;
  try {
    result = runCleanup(fx.T, fx.sessionName);
  } catch (e) {
    console.error(`  cleanup invocation threw: ${e.message}`);
    console.error(`  stderr: ${e.stderr?.toString() || ''}`);
    failed++;
    teardownFixture(fx.T);
    process.exit(1);
  }
  console.log(`  cleanup output: ${JSON.stringify(result)}`);

  const post = inspectPostState(fx.T, fx);
  console.log(`  post: ws worktrees: ${post.wsList.replace(/\n+/g, ' | ')}`);
  console.log(`  post: proj worktrees: ${post.projLists.proj.replace(/\n+/g, ' | ')}`);

  assertEq(result.success, true, 'success === true');
  assert(!existsSync(join(fx.T, 'work-sessions', fx.sessionName)),
    'session folder is removed from disk');
  assert(!post.wsList.includes(`work-sessions/${fx.sessionName}`),
    'workspace repo has no worktree record for the session');
  assert(!post.projLists.proj.includes(`work-sessions/${fx.sessionName}`),
    'project repo has no worktree record for the session');
  assert(!post.wsList.includes('prunable'),
    'workspace repo: no prunable worktree records');
  assert(!post.projLists.proj.includes('prunable'),
    'project repo: no prunable worktree records (the gh:119 symptom)');
  assertEq(post.wsBranches, '', 'workspace repo: session branch deleted');
  assertEq(post.projBranches.proj, '', 'project repo: session branch deleted');

  teardownFixture(fx.T);
}

// === Test 2: pre-orphaned project worktree (simulates partial prior cleanup) ===
console.log('# orphan recovery: project worktree directory pre-removed (e.g., a prior workspace-first removal)');
{
  const fx = makeFixture('orphan-test', 'bugfix/orphan-test');
  // Simulate the symptom: nuke the project worktree directory WITHOUT
  // git's knowledge, so the project repo carries a prunable record going in.
  rmSync(fx.projWts.proj, { recursive: true, force: true });
  assert(!existsSync(fx.projWts.proj), 'pre: project worktree dir is gone');
  const preList = git(fx.projRepos.proj, 'worktree list --porcelain');
  assert(preList.includes('prunable') || preList.includes(`work-sessions/${fx.sessionName}`),
    'pre: project repo has the orphan record');

  let result;
  try {
    result = runCleanup(fx.T, fx.sessionName);
  } catch (e) {
    console.error(`  cleanup invocation threw: ${e.message}`);
    failed++;
    teardownFixture(fx.T);
    process.exit(1);
  }
  console.log(`  cleanup output: ${JSON.stringify(result)}`);

  const post = inspectPostState(fx.T, fx);
  assertEq(result.success, true, 'success === true even with pre-existing orphan');
  assert(!post.projLists.proj.includes('prunable'),
    'orphan record is cleaned (prune ran)');
  assert(!post.projLists.proj.includes(`work-sessions/${fx.sessionName}`),
    'project repo no longer references the session');
  assertEq(post.projBranches.proj, '', 'project branch deleted despite the orphan');

  teardownFixture(fx.T);
}

// === Test 3: idempotency — second run on already-clean state ===
console.log('# idempotency: running cleanup twice does not regress success');
{
  const fx = makeFixture('idem-test', 'bugfix/idem-test');
  runCleanup(fx.T, fx.sessionName);
  // Re-make the fixture for a SECOND fresh session? No — the test is whether
  // a second invocation against an already-gone session is harmless.
  let result2;
  try {
    result2 = runCleanup(fx.T, fx.sessionName);
  } catch (e) {
    console.error(`  second cleanup invocation threw: ${e.message}`);
    failed++;
    teardownFixture(fx.T);
    process.exit(1);
  }
  console.log(`  second-run output: ${JSON.stringify(result2)}`);
  assertEq(result2.success, true, 'second-run success === true (idempotent)');
  teardownFixture(fx.T);
}

// === Test 4: gh:119 regression — session.md stripped before cleanup runs ===
// Simulates /complete-work Step 7 (strip session artifacts) running BEFORE
// Step 12 (cleanup). The script must discover repos and branch from the
// live worktree state, not silently treat repos as [] and leave orphans.
console.log('# gh:119: session.md stripped before cleanup (the production failure mode)');
await (async () => {
  const fx = makeFixture('strip-test', 'bugfix/strip-test');
  // Simulate the /complete-work strip step before cleanup runs.
  rmSync(join(fx.wsWt, 'session.md'));
  assert(!existsSync(join(fx.wsWt, 'session.md')), 'pre: session.md is gone');

  let result;
  try {
    result = runCleanup(fx.T, fx.sessionName);
  } catch (e) {
    // The fix returns success: true with errors=undefined and exit 0;
    // the OLD script returned success: true but left orphans (no throw).
    // If execFileSync threw, the script exited non-zero — that's the new
    // honest-error behavior on a regression. Parse and surface the result.
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    console.error(`  cleanup invocation exited non-zero: ${out}`);
    failed++;
    teardownFixture(fx.T);
    return;
  }
  console.log(`  cleanup output: ${JSON.stringify(result)}`);

  const post = inspectPostState(fx.T, fx);
  console.log(`  post: ws worktrees: ${post.wsList.replace(/\n+/g, ' | ')}`);
  console.log(`  post: proj worktrees: ${post.projLists.proj.replace(/\n+/g, ' | ')}`);

  assertEq(result.success, true, 'success === true after stripped-tracker cleanup');
  assert(result.removed.includes('project worktree proj'),
    'project worktree was actually removed (not silently skipped)');
  assert(result.removed.includes('workspace worktree'),
    'workspace worktree was removed');
  assert((result.skipped || []).some(s => s.step === 'discovery'),
    'discovery step logged a skip explaining the fallback');
  assert(!post.wsList.includes('prunable'),
    'no prunable orphan in workspace repo');
  assert(!post.projLists.proj.includes('prunable'),
    'no prunable orphan in project repo (the gh:119 symptom)');
  assert(!post.projLists.proj.includes(`work-sessions/${fx.sessionName}`),
    'project repo no longer references the session');
  assertEq(post.wsBranches, '', 'workspace branch deleted after discovery');
  assertEq(post.projBranches.proj, '', 'project branch deleted after discovery');
  assert(!existsSync(join(fx.T, 'work-sessions', fx.sessionName)),
    'session folder removed');

  teardownFixture(fx.T);
})();

// (A 5th test exercising the honest-error path for a stuck branch was
// considered but dropped: constructing a scenario where `git branch -D`
// genuinely fails requires either checking the branch out in a second
// worktree (rejected by git for the same branch name) or fabricating a
// scenario the cleanup script can't realistically encounter. The
// post-verification code path is a 2-line `if (branchStill) errors.push`
// and is hard to regress without Test 4's discovery+verification flow
// noticing.)

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
