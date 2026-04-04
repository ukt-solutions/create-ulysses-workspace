#!/usr/bin/env node
// WorktreeCreate hook — scan for stale worktrees and flag them
import { readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { getWorkspaceRoot, respond } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const reposDir = join(root, 'repos');
const stale = [];

if (!existsSync(reposDir)) {
  respond();
  process.exit(0);
}

for (const entry of readdirSync(reposDir)) {
  const repoPath = join(reposDir, entry);
  if (!existsSync(join(repoPath, '.git'))) continue;
  if (entry.includes('___wt-')) continue;

  let worktreeOutput;
  try {
    worktreeOutput = execSync('git worktree list', { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { continue; }

  for (const line of worktreeOutput.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    const wtPath = parts[0];
    if (!wtPath || wtPath === repoPath) continue;
    if (!existsSync(wtPath)) continue;

    const branchMatch = line.match(/\[(.+?)\]/);
    const branch = branchMatch ? branchMatch[1] : 'unknown';

    try {
      const lastCommit = execSync('git log -1 --format=%ci', { cwd: wtPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const daysAgo = Math.floor((Date.now() - new Date(lastCommit).getTime()) / 86400000);
      if (daysAgo > 3) {
        stale.push(`- ${basename(wtPath)} (${branch}): no commits in ${daysAgo} days`);
      }
    } catch {}
  }
}

if (stale.length > 0) {
  respond(`Stale worktrees found:\n${stale.join('\n')}\n\nConsider cleaning up with: git worktree remove {path}`);
} else {
  respond();
}
