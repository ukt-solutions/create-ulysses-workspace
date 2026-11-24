#!/usr/bin/env node
// Add a project repo to an existing work session mid-flight. Creates a
// nested project worktree inside the workspace worktree's repos/ dir and
// appends the new repo to the session tracker's `repos:` list.
import '../lib/require-node.mjs';
import { execFileSync, spawnSync } from 'child_process';
import { isAbsolute, join } from 'path';
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

// SECURITY (gh:129): the session name comes from chat, the tracker's branch
// from the committed session.md, and the repo's branch from the committed
// workspace.json. Every git call below is an argv array through
// execFileSync — never shell text — and these values are checked before
// anything is created.

// A session name becomes a path segment under work-sessions/: one segment,
// no separators or absolute paths, no leading dot (the same rule as
// migrate-sessions.mjs).
function isSessionSegment(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) return false;
  const segs = name.split(/[\\/]/);
  if (segs.length !== 1) return false;
  return !segs[0].startsWith('.');
}

// git's own format check is the authority on branch names. `--branch`
// expands @{-N} to an earlier branch's name, so the name must come back
// unchanged; a leading dash would read as an option.
function validBranch(cwd, name) {
  if (typeof name !== 'string' || name === '' || name.startsWith('-')) return false;
  const r = spawnSync('git', ['check-ref-format', '--branch', name], { cwd, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === name;
}

function fail(error) {
  console.log(JSON.stringify({ success: false, error }));
  process.exit(1);
}

if (!isSessionSegment(sessionName)) {
  fail(`Invalid session name "${sessionName}": it must be a single path segment that does not start with a dot`);
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
if (!validBranch(root, tracker.branch)) {
  fail(`Invalid branch "${tracker.branch}" in the session tracker: git check-ref-format rejected it`);
}
if (!validBranch(root, repoBranch)) {
  fail(`Invalid branch "${repoBranch}" for repo "${repo}" in workspace.json: git check-ref-format rejected it`);
}
const reposDir = join(root, 'repos');
const repoDir = join(reposDir, repo);
const wsWorktree = join(sessionFolderPath(root, sessionName), 'workspace');
const projWorktree = join(wsWorktree, 'repos', repo);

try {
  execFileSync('git', ['fetch', 'origin'], { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
  execFileSync('git', ['branch', '--', tracker.branch, `origin/${repoBranch}`], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['worktree', 'add', '--', projWorktree, tracker.branch], { cwd: repoDir, stdio: 'pipe' });

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
