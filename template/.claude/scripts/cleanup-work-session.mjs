#!/usr/bin/env node
// Tear down a work session's worktrees, branches, and folder.
//
// Teardown order is MANDATORY:
//   1. Remove each project worktree from its project repo
//   2. Remove the workspace worktree from the workspace repo
//   3. Prune each project repo (belt-and-suspenders)
//   4. Delete all local branches
//   5. Remove the whole work-sessions/{name}/ folder
//
// Workspace-first removal silently deletes the nested project worktrees'
// .git files and leaves orphan worktree records in the project repos.
// The safe order keeps both sides of the relationship in sync.
//
// State discovery is defensive: the session tracker (session.md) may have
// been stripped by /complete-work Step 7 before this script runs, leaving
// no `repos:` or `branch:` to read. When that happens we discover repos
// from the work-sessions/{name}/workspace/repos/ directory listing and the
// branch from `git branch --show-current` on the workspace worktree —
// BEFORE removing anything. Without that, the per-repo loops silently
// no-op and the script reports success while leaving orphans behind
// (gh:119).
//
// SECURITY (gh:147/B5): the tracker is session-controlled input. Every
// git call is an argv array through execFileSync — never a shell string —
// because a crafted tracker (`branch: 'x"; touch pwn; echo "'`) used to
// reach execSync as shell text and execute. Beyond injection, the
// validated values must stay INSIDE this workspace: repos entries must be
// single path segments resolving under root/repos/ (a tracker claiming
// `repos: ['../../outside']` used to delete branches in a repo outside
// the workspace), branch names must pass `git check-ref-format`, and the
// session name must be a single path segment. All validation runs before
// anything is touched.
//
// `success: true` means VERIFIED: every project worktree record is gone
// (no prunable entries left over), every local branch is deleted, and the
// session folder is removed. The script post-verifies all of these and
// surfaces any leftover state as an error rather than swallowing it. If
// any step records an error, the session folder is KEPT (N6) — removing
// it would destroy the tracker and worktrees the next run needs to
// recover with.
import '../lib/require-node.mjs';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync, lstatSync, realpathSync } from 'fs';
import { join, resolve, isAbsolute, sep } from 'path';
import {
  getWorkspaceRoot,
  readSessionTracker,
  deleteSessionFolder,
  sessionFolderPath,
  normalizeRepos,
} from '../hooks/_utils.mjs';

// No shell anywhere: args go to execFileSync as an array, so metachar-
// acters in tracker-controlled values are data, never syntax. A failed
// call returns {ok:false} with git's stderr — the caller decides whether
// that is a skip or an error.
function git(cwd, args) {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: String(err.stdout ?? ''), err: String(err.stderr ?? err.message).trim() };
  }
}

// .native resolves Windows 8.3 short names; the plain fallback covers
// filesystems where the native binding is unavailable.
function realOf(p) {
  try { return realpathSync.native(p); } catch { /* fall through */ }
  try { return realpathSync(p); } catch { /* fall through */ }
  return resolve(p);
}

// One path segment, not dots, not absolute — the shape of a repo name
// under root/repos/. "./x", "../y", "a/b", and absolute paths all fail.
function isRepoSegment(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) return false;
  const segs = name.split(/[\\/]/);
  if (segs.length !== 1) return false;
  return !/^\.+$/.test(segs[0]);
}

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};

const sessionName = getArg('session-name');
if (!sessionName) {
  console.error('Usage: cleanup-work-session.mjs --session-name NAME');
  process.exit(1);
}

// Same segment rule as the repo names: the session name becomes a path
// under the sessions directory, and traversal out of it is not cleanup.
const isSessionSegment = (name) => isRepoSegment(name);
if (!isSessionSegment(sessionName)) {
  console.log(JSON.stringify({
    success: false,
    errors: [`invalid session name "${sessionName}" — must be a single path segment`],
  }));
  process.exit(1);
}

const root = getWorkspaceRoot(import.meta.url);
const reposDir = join(root, 'repos');
const sessionFolder = sessionFolderPath(root, sessionName);
const wsWorktree = join(sessionFolder, 'workspace');

const removed = [];
const skipped = [];
const errors = [];

// The real path of root/repos/ — the hard boundary every repos entry
// must resolve inside (computed once; root itself is trusted).
const reposRootReal = realOf(reposDir);

// === Discovery: where session.md is silent or missing, fall back to disk ===
//
// The tracker may have been stripped before this script runs. Read whatever
// is still there, then fill gaps from the live worktree state.

const tracker = readSessionTracker(root, sessionName);
let repos = normalizeRepos(tracker?.repos);
let branch = tracker?.branch || null;

// If repos is empty, discover from work-sessions/{name}/workspace/repos/.
// That directory is the workspace worktree's nested-project-worktrees dir;
// each entry is one project repo this session checked out.
let discovered = false;
if (repos.length === 0) {
  const nestedReposDir = join(wsWorktree, 'repos');
  if (existsSync(nestedReposDir)) {
    try {
      const found = readdirSync(nestedReposDir).filter((entry) => {
        try {
          return statSync(join(nestedReposDir, entry)).isDirectory();
        } catch {
          return false;
        }
      });
      if (found.length > 0) {
        repos = found;
        discovered = true;
        skipped.push({
          step: 'discovery',
          reason: `Tracker missing repos; discovered ${found.length} from ${nestedReposDir}: ${found.join(', ')}`,
        });
      }
    } catch (err) {
      skipped.push({ step: 'discovery', reason: `Failed to list ${nestedReposDir}: ${err.message}` });
    }
  }
}

// Validate every repo entry BEFORE any git runs against it (B5): each
// must be a single path segment whose real path stays inside root/repos/
// — a crafted tracker (`repos: ['../../outside']`) must never point this
// script at a repository outside the workspace. Entries discovered from
// disk are validated too: they become paths just the same.
//
// One supported exception: repos/{name} may be a SYMLINK to the source
// clone that owns the nested worktree (a layout some machines use to
// share clones). That is allowed only when the nested worktree's git
// common dir resolves into the very repository the symlink points at —
// anything else is an unverified entry and refused.
const nestedCommonDir = (repo) => {
  const wt = join(wsWorktree, 'repos', repo);
  if (!existsSync(wt)) return null;
  const res = git(wt, ['rev-parse', '--git-common-dir']);
  if (!res.ok) return null;
  return realOf(resolve(wt, res.out.trim()));
};
const repoCommonDir = (repoDir) => {
  const res = git(repoDir, ['rev-parse', '--git-common-dir']);
  if (!res.ok) return null;
  return realOf(resolve(repoDir, res.out.trim()));
};
for (const repo of repos) {
  const source = discovered ? 'discovered from disk' : 'in the session tracker';
  if (!isRepoSegment(repo)) {
    errors.push(`Invalid repos entry "${repo}" ${source}: must be a single path segment`);
    continue;
  }
  const dir = join(reposDir, repo);
  let st = null;
  try { st = lstatSync(dir); } catch { /* handled below */ }
  if (st && st.isSymbolicLink()) {
    const target = realOf(dir);
    const targetCommon = existsSync(target) ? repoCommonDir(target) : null;
    const nestedCommon = nestedCommonDir(repo);
    if (!targetCommon || !nestedCommon || targetCommon !== nestedCommon) {
      errors.push(`Invalid repos entry "${repo}" ${source}: repos/${repo} is a symlink whose target is not the repository the nested worktree belongs to`);
    }
    continue;
  }
  const dirReal = realOf(dir);
  if (dirReal !== reposRootReal && !dirReal.startsWith(reposRootReal + sep)) {
    errors.push(`Invalid repos entry "${repo}" ${source}: resolves outside ${reposDir}`);
  }
}

// If branch is missing, ask the workspace worktree itself.
if (!branch && existsSync(wsWorktree)) {
  const res = git(wsWorktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (res.ok && res.out.trim() !== '' && res.out.trim() !== 'HEAD') {
    branch = res.out.trim();
    skipped.push({ step: 'discovery', reason: `Tracker missing branch; discovered from worktree: ${branch}` });
  }
}

// A tracker that lists fewer repos than the session actually holds must
// not decide the teardown: removing the workspace worktree takes every
// nested directory with it, so an unlisted live worktree — with whatever
// work is in it — would go too. Refuse, and name the unlisted entries.
if (!discovered && repos.length > 0) {
  const nestedReposDir = join(wsWorktree, 'repos');
  if (existsSync(nestedReposDir)) {
    let onDisk = [];
    try { onDisk = readdirSync(nestedReposDir); } catch { /* unreadable: nothing to compare */ }
    const unlisted = onDisk.filter((entry) => !repos.includes(entry));
    if (unlisted.length > 0) {
      errors.push(`The session tracker lists repos [${repos.join(', ')}] but ${nestedReposDir} also holds [${unlisted.join(', ')}] — removing the workspace worktree would delete them; add them to the tracker or move them out first`);
    }
  }
}

// Branch names become refs and git command arguments; git's own format
// check is the authority and also rejects shell-metacharacter payloads
// long before any later use.
if (branch) {
  const res = git(root, ['check-ref-format', '--branch', branch]);
  if (!res.ok) {
    errors.push(`Invalid branch "${branch}" in the session tracker: git check-ref-format rejected it`);
  }
}

if (errors.length > 0) {
  console.log(JSON.stringify({
    success: false,
    removed,
    skipped: skipped.length > 0 ? skipped : undefined,
    errors,
  }));
  process.exit(1);
}

// === Step 1: Remove each project worktree FIRST, from its project repo ===
for (const repo of repos) {
  const projWorktree = join(wsWorktree, 'repos', repo);
  const repoDir = join(reposDir, repo);
  if (!existsSync(projWorktree)) {
    skipped.push({ step: 'remove-project-worktree', repo, reason: `${projWorktree} does not exist` });
    continue;
  }
  if (!existsSync(repoDir)) {
    errors.push(`Cannot remove ${repo} worktree: source clone missing at ${repoDir}`);
    continue;
  }
  const res = git(repoDir, ['worktree', 'remove', projWorktree, '--force']);
  if (res.ok) {
    removed.push(`project worktree ${repo}`);
  } else {
    errors.push(`Failed to remove ${repo} worktree: ${res.err || res.out}`);
  }
}

// === HARD STOP if step 1 recorded any error ===
//
// A nested entry that could not be removed is an entry whose nature was
// never verified (a plain directory, a foreign clone, a live worktree in
// an unexpected state). Continuing would run `branch -D` in repos whose
// nested entry was not verified as its worktree, and would delete the
// session folder around whatever survived — the exact data-loss shape
// the review probes demonstrated. Stop, report, keep everything.
if (errors.length > 0) {
  errors.push('Stopped after step 1 (nested worktree removal) — steps 2-5 skipped; nothing else was touched');
  console.log(JSON.stringify({
    success: false,
    removed,
    skipped: skipped.length > 0 ? skipped : undefined,
    errors,
  }));
  process.exit(1);
}

// === Step 2: Remove the workspace worktree AFTER project worktrees are gone ===
if (existsSync(wsWorktree)) {
  const res = git(root, ['worktree', 'remove', wsWorktree, '--force']);
  if (res.ok) {
    removed.push('workspace worktree');
  } else {
    errors.push(`Failed to remove workspace worktree: ${res.err || res.out}`);
  }
} else {
  skipped.push({ step: 'remove-workspace-worktree', reason: `${wsWorktree} does not exist` });
}

// === Step 3: Prune each project repo to mop up orphans ===
for (const repo of repos) {
  const repoDir = join(reposDir, repo);
  if (!existsSync(repoDir)) continue;
  const res = git(repoDir, ['worktree', 'prune']);
  if (!res.ok) {
    // Prune is a safety net, but if it fails on a repo we touched, surface
    // it — verification below will catch leftover orphans either way.
    errors.push(`Prune failed in ${repo}: ${res.err || res.out}`);
  }
}

// === Step 4: Delete local branches ===
if (branch) {
  for (const repo of repos) {
    const repoDir = join(reposDir, repo);
    if (!existsSync(repoDir)) continue;
    const listed = git(repoDir, ['branch', '--list', branch]);
    if (!listed.ok) continue; // Repo broken; verification will catch downstream impact.
    if (listed.out.trim() === '') continue; // Already gone (e.g., gh pr merge --delete-branch did it).
    const del = git(repoDir, ['branch', '-D', branch]);
    if (!del.ok) {
      errors.push(`Failed to delete branch ${branch} in ${repo}: ${del.err || del.out}`);
    }
  }
  // Same for the workspace repo (root).
  const listed = git(root, ['branch', '--list', branch]);
  if (listed.ok && listed.out.trim() !== '') {
    const del = git(root, ['branch', '-D', branch]);
    if (!del.ok) {
      errors.push(`Failed to delete branch ${branch} in workspace repo: ${del.err || del.out}`);
    }
  }
}

// === Post-verification: success means VERIFIED, not "no try/catch threw" ===
//
// Without these checks, an empty repos list (the gh:119 root cause) lets
// every silent skip add up to a "success" output while leaving orphans
// behind. The verification turns silent skips into honest errors.

if (existsSync(sessionFolder)) {
  // The folder is still there — either Step 5 has not run (errors above)
  // or it failed. Only delete it when everything before it succeeded
  // (N6): the folder holds the tracker and any remaining worktrees the
  // next recovery run needs.
  if (errors.length === 0) {
    try {
      deleteSessionFolder(root, sessionName);
    } catch (err) {
      errors.push(`Failed to delete session folder ${sessionFolder}: ${err.message.trim()}`);
    }
  } else {
    errors.push('Session folder kept — earlier steps failed; reconcile and re-run');
  }
} else {
  skipped.push({ step: 'delete-session-folder', reason: `${sessionFolder} does not exist` });
}

if (existsSync(sessionFolder)) {
  errors.push(`Session folder still present after cleanup: ${sessionFolder}`);
}

const wsPath = wsWorktree; // canonical path the worktree had
for (const repo of repos) {
  const repoDir = join(reposDir, repo);
  if (!existsSync(repoDir)) continue;
  const listRes = git(repoDir, ['worktree', 'list', '--porcelain']);
  if (!listRes.ok) {
    errors.push(`Could not list worktrees in ${repo}: ${listRes.err || listRes.out}`);
    continue;
  }
  const wtList = listRes.out;
  if (wtList.includes('prunable')) {
    errors.push(`Prunable worktree record remains in ${repo} after cleanup (gh:119 symptom)`);
  }
  if (wtList.includes(wsPath)) {
    errors.push(`${repo} still has a worktree record referencing the session path`);
  }
  if (branch) {
    const stillRes = git(repoDir, ['branch', '--list', branch]);
    if (stillRes.ok && stillRes.out.trim() !== '') {
      errors.push(`Branch ${branch} still present in ${repo} after cleanup`);
    }
  }
}

if (branch) {
  const stillRes = git(root, ['branch', '--list', branch]);
  if (stillRes.ok && stillRes.out.trim() !== '') {
    errors.push(`Branch ${branch} still present in workspace repo after cleanup`);
  }
}

console.log(JSON.stringify({
  success: errors.length === 0,
  removed,
  skipped: skipped.length > 0 ? skipped : undefined,
  errors: errors.length > 0 ? errors : undefined,
}));

if (errors.length > 0) process.exit(1);
