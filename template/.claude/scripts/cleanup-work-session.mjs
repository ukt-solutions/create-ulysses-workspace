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
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  getWorkspaceRoot,
  readSessionTracker,
  deleteSessionFolder,
  sessionFolderPath,
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
const tracker = readSessionTracker(root, sessionName);
const repos = tracker?.repos || [];
const branch = tracker?.branch;
const reposDir = join(root, 'repos');
const sessionFolder = sessionFolderPath(root, sessionName);
const wsWorktree = join(sessionFolder, 'workspace');

const removed = [];
const errors = [];

// Step 1: Remove each project worktree FIRST, from its project repo
for (const repo of repos) {
  const projWorktree = join(wsWorktree, 'repos', repo);
  const repoDir = join(reposDir, repo);
  if (existsSync(projWorktree)) {
    try {
      execSync(`git worktree remove "${projWorktree}" --force`, { cwd: repoDir, stdio: 'pipe' });
      removed.push(`project worktree ${repo}`);
    } catch (err) {
      errors.push(`Failed to remove ${repo} worktree: ${err.message}`);
    }
  }
}

// Step 2: Remove the workspace worktree AFTER project worktrees are gone
if (existsSync(wsWorktree)) {
  try {
    execSync(`git worktree remove "${wsWorktree}" --force`, { cwd: root, stdio: 'pipe' });
    removed.push('workspace worktree');
  } catch (err) {
    errors.push(`Failed to remove workspace worktree: ${err.message}`);
  }
}

// Step 3: Prune each project repo to mop up orphans from any prior misuses
for (const repo of repos) {
  const repoDir = join(reposDir, repo);
  try {
    execSync('git worktree prune', { cwd: repoDir, stdio: 'pipe' });
  } catch {
    // Non-fatal — prune is a safety net
  }
}

// Step 4: Delete local branches
if (branch) {
  for (const repo of repos) {
    const repoDir = join(reposDir, repo);
    try {
      execSync(`git branch -D "${branch}"`, { cwd: repoDir, stdio: 'pipe' });
    } catch {
      // Non-fatal — branch may already be gone or refuse to delete
    }
  }
  try {
    execSync(`git branch -D "${branch}"`, { cwd: root, stdio: 'pipe' });
  } catch {
    // Non-fatal
  }
}

// Step 5: Delete the whole work-sessions/{name}/ folder. The session.md,
// specs, plans, and any local-only artifacts vanish. Their content was
// archived into release notes by /complete-work before this script ran.
deleteSessionFolder(root, sessionName);

console.log(JSON.stringify({
  success: errors.length === 0,
  removed,
  errors: errors.length > 0 ? errors : undefined,
}));
