#!/usr/bin/env node
// Add a project repo to an existing work session mid-flight. Creates a
// nested project worktree inside the workspace worktree's repos/ dir and
// appends the new repo to the session tracker's `repos:` list.
import '../lib/require-node.mjs';
import { execSync } from 'child_process';
import { join } from 'path';
import {
  getWorkspaceRoot,
  getMainRoot,
  readJSON,
  readSessionTracker,
  updateSessionTracker,
  sessionFolderPath,
  normalizeRepos,
} from '../hooks/_utils.mjs';

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};

const sessionName = getArg('session-name');
const repo = getArg('repo');

if (!sessionName || !repo) {
  console.error('Usage: add-repo-to-session.mjs --session-name NAME --repo REPO');
  process.exit(1);
}

// Promote to the launcher root via the active-session pointer so session
// paths resolve correctly whether the script is invoked from the launcher
// or from inside a worktree.
const root = getMainRoot(getWorkspaceRoot(import.meta.url));
const config = readJSON(join(root, 'workspace.json'));
const tracker = readSessionTracker(root, sessionName);

if (!tracker) {
  console.log(JSON.stringify({ success: false, error: `No session tracker found for "${sessionName}"` }));
  process.exit(1);
}

if (!config?.repos?.[repo]) {
  console.log(JSON.stringify({ success: false, error: `Repo "${repo}" not found in workspace.json` }));
  process.exit(1);
}

const existingRepos = normalizeRepos(tracker.repos);
if (existingRepos.includes(repo)) {
  console.log(JSON.stringify({ success: false, error: `Repo "${repo}" is already in this session` }));
  process.exit(1);
}

const repoBranch = config.repos[repo].branch || 'main';
const reposDir = join(root, 'repos');
const repoDir = join(reposDir, repo);
const wsWorktree = join(sessionFolderPath(root, sessionName), 'workspace');
const projWorktree = join(wsWorktree, 'repos', repo);

try {
  execSync(`git fetch origin`, { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
  execSync(`git branch "${tracker.branch}" "origin/${repoBranch}"`, { cwd: repoDir, stdio: 'pipe' });
  execSync(`git worktree add "${projWorktree}" "${tracker.branch}"`, { cwd: repoDir, stdio: 'pipe' });

  const newRepos = [...existingRepos, repo];
  const today = new Date().toISOString().slice(0, 10);
  updateSessionTracker(root, sessionName, { repos: newRepos, updated: today });

  const rel = (p) => p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
  console.log(JSON.stringify({
    success: true,
    projWorktree: rel(projWorktree),
    repos: newRepos,
  }));
} catch (err) {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
}
