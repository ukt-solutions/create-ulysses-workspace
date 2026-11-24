#!/usr/bin/env node
// Create a work session: workspace worktree + nested project worktrees +
// session.md tracker. Produces a self-contained work-sessions/{name}/ folder.
import '../lib/require-node.mjs';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import {
  getWorkspaceRoot,
  readJSON,
  sessionFilePath,
  sessionFolderPath,
  createSessionTracker,
  writeActiveSessionPointer,
} from '../hooks/_utils.mjs';

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};

const sessionName = getArg('session-name');
const branch = getArg('branch');
const repoArg = getArg('repo');
const user = getArg('user');
const description = getArg('description') || '';

if (!sessionName || !branch || !repoArg || !user) {
  console.error('Usage: create-work-session.mjs --session-name NAME --branch BRANCH --repo REPO[,REPO2,...] --user USER [--description DESC]');
  process.exit(1);
}

const repos = repoArg.split(',').map(r => r.trim()).filter(Boolean);
const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(join(root, 'workspace.json'));
const reposDir = join(root, 'repos');

// SECURITY (gh:129): the session name, branch and repo names come from chat,
// and each repo's branch comes from the committed workspace.json. Every git
// call below is an argv array through execFileSync — never shell text — and
// these checks run before anything is created, so a crafted value is
// rejected with no branch, worktree or folder left behind.

// A session name becomes a path segment under work-sessions/: one segment,
// no separators or absolute paths, no leading dot (the same rule as
// migrate-sessions.mjs).
function isSessionSegment(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) return false;
  const segs = name.split(/[\\/]/);
  if (segs.length !== 1) return false;
  return !segs[0].startsWith('.');
}

// A project repo name: one path segment under repos/, not dots.
function isRepoSegment(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) return false;
  const segs = name.split(/[\\/]/);
  return segs.length === 1 && !/^\.+$/.test(segs[0]);
}

// git's own format check is the authority on branch names. `--branch`
// expands @{-N} to an earlier branch's name, so the name must come back
// unchanged; a leading dash would read as an option.
function validBranch(cwd, name) {
  if (typeof name !== 'string' || name === '' || name.startsWith('-')) return false;
  const r = spawnSync('git', ['check-ref-format', '--branch', name], { cwd, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === name;
}

function validationError() {
  if (!isSessionSegment(sessionName)) {
    return `Invalid session name "${sessionName}": it must be a single path segment that does not start with a dot`;
  }
  if (!validBranch(root, branch)) {
    return `Invalid branch "${branch}": git check-ref-format rejected it`;
  }
  for (const repo of repos) {
    if (!isRepoSegment(repo)) {
      return `Invalid repo "${repo}": it must be a single path segment`;
    }
    const repoBranch = config?.repos?.[repo]?.branch || 'main';
    if (!validBranch(root, repoBranch)) {
      return `Invalid branch "${repoBranch}" for repo "${repo}" in workspace.json: git check-ref-format rejected it`;
    }
  }
  return null;
}

const invalid = validationError();
if (invalid) {
  console.log(JSON.stringify({ success: false, error: invalid }));
  process.exit(1);
}

const sessionFolder = sessionFolderPath(root, sessionName);
const wsWorktree = join(sessionFolder, 'workspace');

try {
  // Ensure the work-sessions/ parent and the session folder exist
  mkdirSync(sessionFolder, { recursive: true });

  // Create the workspace branch and worktree
  execFileSync('git', ['branch', '--', branch, 'main'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['worktree', 'add', '--', wsWorktree, branch], { cwd: root, stdio: 'pipe' });

  // Real repos/ directory inside the workspace worktree (no symlink).
  // The workspace .gitignore pattern `repos` (no slash) covers both the
  // workspace root's repos/ and this one.
  const nestedReposDir = join(wsWorktree, 'repos');
  mkdirSync(nestedReposDir, { recursive: true });

  // Create each project branch and nest its worktree inside the workspace worktree
  const projWorktrees = [];
  for (const repo of repos) {
    const repoBranch = config?.repos?.[repo]?.branch || 'main';
    const repoDir = join(reposDir, repo);
    const projWorktree = join(nestedReposDir, repo);

    execFileSync('git', ['fetch', 'origin'], { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
    execFileSync('git', ['branch', '--', branch, `origin/${repoBranch}`], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['worktree', 'add', '--', projWorktree, branch], { cwd: repoDir, stdio: 'pipe' });

    projWorktrees.push(projWorktree);
  }

  // Copy settings.local.json into the workspace worktree if present at root
  const settingsSrc = join(root, '.claude', 'settings.local.json');
  const settingsDst = join(wsWorktree, '.claude', 'settings.local.json');
  if (existsSync(settingsSrc)) {
    copyFileSync(settingsSrc, settingsDst);
  }

  // Write the active-session pointer inside the worktree's .claude/ dir so
  // hooks running inside the worktree know which session is in scope.
  writeActiveSessionPointer(wsWorktree, { name: sessionName, rootPath: root });

  // Write the unified session.md tracker inside the worktree (at the top of
  // the session branch) and commit it on the branch as the branch's first
  // commit above main. Frontmatter holds machine state; body holds human
  // content. Hooks and skills update the frontmatter via session-frontmatter
  // helpers; humans update the body directly.
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  createSessionTracker(
    root,
    sessionName,
    {
      type: 'session-tracker',
      name: sessionName,
      description,
      status: 'active',
      branch,
      created: now,
      user,
      repos,
      chatSessions: [],
      author: user,
      updated: today,
    },
    `\n# Work Session: ${sessionName}\n\n${description}\n\n## Progress\n\n(Updated as the session progresses)\n`
  );
  execFileSync('git', ['add', '--', 'session.md'], { cwd: wsWorktree, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', `chore: initialize session tracker for ${sessionName}`], {
    cwd: wsWorktree,
    stdio: 'pipe',
  });

  // Paths for the success payload, relative to the workspace root
  const rel = (p) => p.startsWith(root + '/') ? p.slice(root.length + 1) : p;

  console.log(JSON.stringify({
    success: true,
    sessionFolder: rel(sessionFolder),
    wsWorktree: rel(wsWorktree),
    projWorktrees: projWorktrees.map(rel),
    tracker: rel(sessionFilePath(root, sessionName)),
  }));
} catch (err) {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
}
