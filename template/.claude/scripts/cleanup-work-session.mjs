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
// `success: true` means VERIFIED: every project worktree record is gone
// (no prunable entries left over), every local branch is deleted, and the
// session folder is removed. The script post-verifies all of these and
// surfaces any leftover state as an error rather than swallowing it.
import '../lib/require-node.mjs';
import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  getWorkspaceRoot,
  readSessionTracker,
  deleteSessionFolder,
  sessionFolderPath,
  normalizeRepos,
} from '../hooks/_utils.mjs';

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

const root = getWorkspaceRoot(import.meta.url);
const reposDir = join(root, 'repos');
const sessionFolder = sessionFolderPath(root, sessionName);
const wsWorktree = join(sessionFolder, 'workspace');

const removed = [];
const skipped = [];
const errors = [];

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
if (repos.length === 0) {
  const nestedReposDir = join(wsWorktree, 'repos');
  if (existsSync(nestedReposDir)) {
    try {
      const discovered = readdirSync(nestedReposDir).filter((entry) => {
        try {
          return statSync(join(nestedReposDir, entry)).isDirectory();
        } catch {
          return false;
        }
      });
      if (discovered.length > 0) {
        repos = discovered;
        skipped.push({
          step: 'discovery',
          reason: `Tracker missing repos; discovered ${discovered.length} from ${nestedReposDir}: ${discovered.join(', ')}`,
        });
      }
    } catch (err) {
      skipped.push({ step: 'discovery', reason: `Failed to list ${nestedReposDir}: ${err.message}` });
    }
  }
}

// If branch is missing, ask the workspace worktree itself.
if (!branch && existsSync(wsWorktree)) {
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: wsWorktree, stdio: 'pipe', encoding: 'utf-8' }).trim();
    if (branch) {
      skipped.push({ step: 'discovery', reason: `Tracker missing branch; discovered from worktree: ${branch}` });
    }
  } catch (err) {
    skipped.push({ step: 'discovery', reason: `Failed to read branch from ${wsWorktree}: ${err.message}` });
  }
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
  try {
    execSync(`git worktree remove "${projWorktree}" --force`, { cwd: repoDir, stdio: 'pipe' });
    removed.push(`project worktree ${repo}`);
  } catch (err) {
    errors.push(`Failed to remove ${repo} worktree: ${err.message.trim()}`);
  }
}

// === Step 2: Remove the workspace worktree AFTER project worktrees are gone ===
if (existsSync(wsWorktree)) {
  try {
    execSync(`git worktree remove "${wsWorktree}" --force`, { cwd: root, stdio: 'pipe' });
    removed.push('workspace worktree');
  } catch (err) {
    errors.push(`Failed to remove workspace worktree: ${err.message.trim()}`);
  }
} else {
  skipped.push({ step: 'remove-workspace-worktree', reason: `${wsWorktree} does not exist` });
}

// === Step 3: Prune each project repo to mop up orphans ===
for (const repo of repos) {
  const repoDir = join(reposDir, repo);
  if (!existsSync(repoDir)) continue;
  try {
    execSync('git worktree prune', { cwd: repoDir, stdio: 'pipe' });
  } catch (err) {
    // Prune is a safety net, but if it fails on a repo we touched, surface
    // it — verification below will catch leftover orphans either way.
    errors.push(`Prune failed in ${repo}: ${err.message.trim()}`);
  }
}

// === Step 4: Delete local branches ===
if (branch) {
  for (const repo of repos) {
    const repoDir = join(reposDir, repo);
    if (!existsSync(repoDir)) continue;
    try {
      execSync(`git branch --list "${branch}"`, { cwd: repoDir, stdio: 'pipe', encoding: 'utf-8' });
    } catch {
      continue; // Repo broken; verification will catch downstream impact.
    }
    const exists = execSync(`git branch --list "${branch}"`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    if (!exists) continue; // Already gone (e.g., gh pr merge --delete-branch did it).
    try {
      execSync(`git branch -D "${branch}"`, { cwd: repoDir, stdio: 'pipe' });
    } catch (err) {
      errors.push(`Failed to delete branch ${branch} in ${repo}: ${err.message.trim()}`);
    }
  }
  // Same for the workspace repo (root).
  try {
    const exists = execSync(`git branch --list "${branch}"`, { cwd: root, encoding: 'utf-8' }).trim();
    if (exists) {
      try {
        execSync(`git branch -D "${branch}"`, { cwd: root, stdio: 'pipe' });
      } catch (err) {
        errors.push(`Failed to delete branch ${branch} in workspace repo: ${err.message.trim()}`);
      }
    }
  } catch {
    // workspace root not a git repo — unusual, skip.
  }
}

// === Step 5: Delete the whole work-sessions/{name}/ folder ===
try {
  deleteSessionFolder(root, sessionName);
} catch (err) {
  errors.push(`Failed to delete session folder ${sessionFolder}: ${err.message.trim()}`);
}

// === Post-verification: success means VERIFIED, not "no try/catch threw" ===
//
// Without these checks, an empty repos list (the gh:119 root cause) lets
// every silent skip add up to a "success" output while leaving orphans
// behind. The verification turns silent skips into honest errors.

if (existsSync(sessionFolder)) {
  errors.push(`Session folder still present after cleanup: ${sessionFolder}`);
}

const wsPath = wsWorktree; // canonical path the worktree had
for (const repo of repos) {
  const repoDir = join(reposDir, repo);
  if (!existsSync(repoDir)) continue;
  let wtList = '';
  try {
    wtList = execSync('git worktree list --porcelain', { cwd: repoDir, encoding: 'utf-8' });
  } catch (err) {
    errors.push(`Could not list worktrees in ${repo}: ${err.message.trim()}`);
    continue;
  }
  if (wtList.includes('prunable')) {
    errors.push(`Prunable worktree record remains in ${repo} after cleanup (gh:119 symptom)`);
  }
  if (wtList.includes(wsPath)) {
    errors.push(`${repo} still has a worktree record referencing the session path`);
  }
  if (branch) {
    const branchStill = execSync(`git branch --list "${branch}"`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    if (branchStill) {
      errors.push(`Branch ${branch} still present in ${repo} after cleanup`);
    }
  }
}

if (branch) {
  try {
    const branchStill = execSync(`git branch --list "${branch}"`, { cwd: root, encoding: 'utf-8' }).trim();
    if (branchStill) {
      errors.push(`Branch ${branch} still present in workspace repo after cleanup`);
    }
  } catch {
    // not a git repo — already noted
  }
}

console.log(JSON.stringify({
  success: errors.length === 0,
  removed,
  skipped: skipped.length > 0 ? skipped : undefined,
  errors: errors.length > 0 ? errors : undefined,
}));

if (errors.length > 0) process.exit(1);
