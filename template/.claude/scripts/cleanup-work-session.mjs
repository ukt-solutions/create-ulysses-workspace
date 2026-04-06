#!/usr/bin/env node
// Helper: remove workspace + project worktrees, branches, and session marker
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot, readSessionMarker, deleteSessionMarker } from '../hooks/_utils.mjs';

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
const marker = readSessionMarker(root, sessionName);
const repos = marker?.repos || [];
const branch = marker?.branch;
const reposDir = join(root, 'repos');

const wsWorktreeName = `${sessionName}___wt-workspace`;
const wsWorktree = join(reposDir, wsWorktreeName);
const removed = [];
const errors = [];

// Remove workspace worktree
if (existsSync(wsWorktree)) {
  try {
    execSync(`git worktree remove "${wsWorktree}" --force`, { cwd: root, stdio: 'pipe' });
    removed.push(wsWorktreeName);
  } catch (err) {
    errors.push(`Failed to remove workspace worktree: ${err.message}`);
  }
}

// Remove project worktrees and branches
for (const repo of repos) {
  const projWorktreeName = `${sessionName}___wt-${repo}`;
  const projWorktree = join(reposDir, projWorktreeName);
  const repoDir = join(reposDir, repo);

  if (existsSync(projWorktree)) {
    try {
      execSync(`git worktree remove "${projWorktree}" --force`, { cwd: repoDir, stdio: 'pipe' });
      removed.push(projWorktreeName);
    } catch (err) {
      errors.push(`Failed to remove ${repo} worktree: ${err.message}`);
    }
  }

  if (branch) {
    try {
      execSync(`git branch -d "${branch}"`, { cwd: repoDir, stdio: 'pipe' });
    } catch {
      // Branch may already be deleted or not fully merged — not fatal
    }
  }
}

// Delete workspace branch
if (branch) {
  try {
    execSync(`git branch -d "${branch}"`, { cwd: root, stdio: 'pipe' });
  } catch {
    // Branch may already be deleted — not fatal
  }
}

// Delete session marker
deleteSessionMarker(root, sessionName);

console.log(JSON.stringify({
  success: errors.length === 0,
  removed,
  errors: errors.length > 0 ? errors : undefined,
}));
