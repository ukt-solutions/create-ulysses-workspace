#!/usr/bin/env node
// Helper: add a repo to an existing work session mid-flight
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot, readJSON, readSessionMarker, writeSessionMarker } from '../hooks/_utils.mjs';

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

const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(join(root, 'workspace.json'));
const marker = readSessionMarker(root, sessionName);

if (!marker) {
  console.log(JSON.stringify({ success: false, error: `No session marker found for "${sessionName}"` }));
  process.exit(1);
}

if (!config?.repos?.[repo]) {
  console.log(JSON.stringify({ success: false, error: `Repo "${repo}" not found in workspace.json` }));
  process.exit(1);
}

if (marker.repos.includes(repo)) {
  console.log(JSON.stringify({ success: false, error: `Repo "${repo}" is already in this session` }));
  process.exit(1);
}

const repoBranch = config.repos[repo].branch || 'main';
const reposDir = join(root, 'repos');
const repoDir = join(reposDir, repo);
const projWorktreeName = `${sessionName}___wt-${repo}`;
const projWorktree = join(reposDir, projWorktreeName);

try {
  execSync(`git fetch origin`, { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
  execSync(`git branch "${marker.branch}" "origin/${repoBranch}"`, { cwd: repoDir, stdio: 'pipe' });
  execSync(`git worktree add "${projWorktree}" "${marker.branch}"`, { cwd: repoDir, stdio: 'pipe' });

  // Update marker
  marker.repos.push(repo);
  writeSessionMarker(root, sessionName, marker);

  // Update inflight tracker frontmatter if it exists
  const trackerPath = join(root, 'shared-context', marker.user, 'inflight', `session-${sessionName}.md`);
  if (existsSync(trackerPath)) {
    let content = readFileSync(trackerPath, 'utf-8');
    content = content.replace(/^repos:.*$/m, `repos: ${marker.repos.join(', ')}`);
    writeFileSync(trackerPath, content);
  }

  console.log(JSON.stringify({
    success: true,
    projWorktree: `repos/${projWorktreeName}`,
    repos: marker.repos,
  }));
} catch (err) {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
}
