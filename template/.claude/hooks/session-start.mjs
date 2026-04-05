#!/usr/bin/env node
// SessionStart hook — surface active work sessions and shared context
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { execSync } from 'child_process';
import { getWorkspaceRoot, readJSON, respond, getSessionMarkers, getActiveSessionPointer, timeAgo } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(join(root, 'workspace.json'));
const contextDir = join(root, 'shared-context');
const reposDir = join(root, 'repos');
const lines = [];

if (!config) {
  respond('No workspace.json found. Run /setup to initialize this workspace.');
  process.exit(0);
}

lines.push(`Workspace: ${config.workspace?.name || 'unnamed'}`);

// Check if we're in a workspace worktree
const pointer = getActiveSessionPointer(root);
if (pointer) {
  lines.push(`Active work session: ${pointer.name}`);
  lines.push(`Working in workspace worktree. Main root: ${pointer.rootPath}`);
  respond(lines.join('\n'));
  process.exit(0);
}

// We're at the main workspace root — surface work sessions and context

// Sync repos
const repoNames = Object.keys(config.repos || {});
const missing = [];
const existing = [];

for (const name of repoNames) {
  const repoPath = join(reposDir, name);
  if (existsSync(repoPath)) {
    existing.push(name);
    try {
      execSync('git fetch --quiet', { cwd: repoPath, stdio: 'pipe', timeout: 10000 });
    } catch {}
  } else {
    missing.push(name);
  }
}

if (missing.length > 0) lines.push(`Missing repos: ${missing.join(', ')}. Run /setup to clone them.`);
if (existing.length > 0) lines.push(`Repos synced: ${existing.join(', ')}`);

// Surface active work sessions
const markers = getSessionMarkers(root);
if (markers.length > 0) {
  lines.push('');
  lines.push('Active work sessions:');

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const wsWorktree = join(reposDir, `${m.name}___wt-workspace`);
    const worktreeExists = existsSync(wsWorktree);

    if (!worktreeExists) {
      lines.push(`  ${i + 1}. ${m.name} (orphaned — worktree missing)`);
      continue;
    }

    const lastChat = m.chatSessions?.[m.chatSessions.length - 1];
    const lastEnded = lastChat?.ended;
    const statusDetail = m.status === 'paused'
      ? `paused ${timeAgo(lastEnded)}`
      : lastEnded
        ? `active, last chat ended ${timeAgo(lastEnded)}`
        : 'active';

    lines.push(`  ${i + 1}. ${m.name} (${statusDetail})`);
    lines.push(`     "${m.description}"`);
    lines.push(`     Branch: ${m.branch} | Repo: ${m.repo}`);
    lines.push(`     Worktree: repos/${m.name}___wt-workspace/`);
    lines.push('');
  }

  lines.push('Use /start-work to resume a session or start new work.');
}

// Surface shared context (secondary)
if (existsSync(contextDir)) {
  const entries = [];

  function scanDir(dir, depth = 0) {
    if (depth > 3) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === 'locked' || entry === '.keep') continue;
        scanDir(fullPath, depth + 1);
      } else if (entry.endsWith('.md') && entry !== '.keep' && !entry.startsWith('local-only-')) {
        const relPath = relative(contextDir, fullPath);
        if (relPath.startsWith('locked/')) continue;

        const content = readFileSync(fullPath, 'utf-8');
        const topicMatch = content.match(/^topic:\s*(.+)$/m);
        const lifecycleMatch = content.match(/^lifecycle:\s*(.+)$/m);
        const topic = topicMatch ? topicMatch[1].trim() : basename(entry, '.md');
        const lifecycle = lifecycleMatch ? lifecycleMatch[1].trim() : 'active';
        const mtime = stat.mtime.toISOString().slice(0, 16).replace('T', ' ');

        entries.push(`- ${topic} (${lifecycle}, updated ${mtime}) — ${relPath}`);
      }
    }
  }

  scanDir(contextDir);

  if (entries.length > 0) {
    lines.push('');
    lines.push('Shared context:');
    lines.push(...entries);
  }
}

respond(lines.join('\n'));
