#!/usr/bin/env node
// Helper: create workspace + project worktrees, marker, pointer, and inflight tracker
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { getWorkspaceRoot, readJSON, writeSessionMarker } from '../hooks/_utils.mjs';

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

const wsWorktreeName = `${sessionName}___wt-workspace`;
const wsWorktree = join(reposDir, wsWorktreeName);

try {
  // Create workspace branch and worktree
  execSync(`git branch "${branch}" main`, { cwd: root, stdio: 'pipe' });
  execSync(`git worktree add "${wsWorktree}" "${branch}"`, { cwd: root, stdio: 'pipe' });

  // Create project branches and worktrees
  const projWorktrees = [];
  for (const repo of repos) {
    const repoBranch = config?.repos?.[repo]?.branch || 'main';
    const repoDir = join(reposDir, repo);
    const projWorktreeName = `${sessionName}___wt-${repo}`;
    const projWorktree = join(reposDir, projWorktreeName);

    execSync(`git fetch origin`, { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
    execSync(`git branch "${branch}" "origin/${repoBranch}"`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`git worktree add "${projWorktree}" "${branch}"`, { cwd: repoDir, stdio: 'pipe' });

    projWorktrees.push({ repo, worktreeName: projWorktreeName });
  }

  // Symlink repos/ into workspace worktree
  // Windows: junctions work without elevation but require absolute paths
  // Unix: relative symlinks for portability
  const reposLink = join(wsWorktree, 'repos');
  if (!existsSync(reposLink)) {
    if (process.platform === 'win32') {
      symlinkSync(resolve(reposDir, '..'), reposLink, 'junction');
    } else {
      symlinkSync('../..', reposLink);
    }
  }

  // Copy settings.local.json into worktree if it exists
  const settingsSrc = join(root, '.claude', 'settings.local.json');
  const settingsDst = join(wsWorktree, '.claude', 'settings.local.json');
  if (existsSync(settingsSrc)) {
    copyFileSync(settingsSrc, settingsDst);
  }

  // Create .claude-scratchpad in worktree with active-session pointer
  const wsScratchpad = join(wsWorktree, '.claude-scratchpad');
  mkdirSync(wsScratchpad, { recursive: true });
  writeFileSync(
    join(wsScratchpad, '.active-session.json'),
    JSON.stringify({ name: sessionName, rootPath: root }, null, 2) + '\n'
  );

  // Create inflight directory and tracker in workspace worktree
  const inflightDir = join(wsWorktree, 'shared-context', user, 'inflight');
  mkdirSync(inflightDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(inflightDir, `session-${sessionName}.md`),
    `---\nstate: ephemeral\nlifecycle: active\ntype: tracker\ntopic: session-${sessionName}\nbranch: ${branch}\nrepos: ${repos.join(', ')}\nauthor: ${user}\nupdated: ${today}\n---\n\n# Work Session: ${sessionName}\n\n${description}\n\n## Progress\n\n(Updated as the session progresses)\n`
  );

  // Write session marker to main root's scratchpad
  writeSessionMarker(root, sessionName, {
    name: sessionName,
    description,
    branch,
    repos,
    status: 'active',
    created: new Date().toISOString(),
    user,
    chatSessions: [],
  });

  console.log(JSON.stringify({
    success: true,
    wsWorktree: `repos/${wsWorktreeName}`,
    projWorktrees: projWorktrees.map(p => `repos/${p.worktreeName}`),
    marker: `.claude-scratchpad/.work-session-${sessionName}.json`,
    tracker: `shared-context/${user}/inflight/session-${sessionName}.md`,
  }));
} catch (err) {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
}
