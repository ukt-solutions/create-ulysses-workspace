#!/usr/bin/env node
// SessionStart hook — register this chat in the active session tracker
// and surface open sessions + shared context.
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { execSync } from 'child_process';
import {
  getWorkspaceRoot,
  readJSON,
  readStdin,
  respond,
  getSessionTrackers,
  getActiveSessionPointer,
  readSessionTracker,
  updateSessionTracker,
  sessionFolderPath,
  timeAgo,
} from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const input = await readStdin();
const config = readJSON(join(root, 'workspace.json'));

const chatId = input.session_id || null;
const contextDir = join(root, 'workspace-context');
const sharedDir = join(contextDir, 'shared');
const reposDir = join(root, 'repos');
const lines = [];

if (!config) {
  respond('No workspace.json found. Run /workspace-init to initialize this workspace.');
  process.exit(0);
}

lines.push(`Workspace: ${config.workspace?.name || 'unnamed'}`);

// If we're inside a workspace worktree, its .claude/.active-session.json
// tells us which session this is.
const pointer = getActiveSessionPointer(root);
if (pointer) {
  if (chatId) {
    const mainRoot = pointer.rootPath || root;
    const tracker = readSessionTracker(mainRoot, pointer.name);
    if (tracker) {
      const chats = tracker.chatSessions || [];
      if (!chats.some(c => c.id === chatId)) {
        chats.push({
          id: chatId,
          names: [],
          started: new Date().toISOString(),
          ended: null,
        });
        updateSessionTracker(mainRoot, pointer.name, {
          chatSessions: chats,
          updated: new Date().toISOString().slice(0, 10),
        });
      }
    }
  }
  lines.push(`Active work session: ${pointer.name}`);
  lines.push(`Working in workspace worktree. Main root: ${pointer.rootPath}`);
  respond(lines.join('\n'));
  process.exit(0);
}

// We're at the main workspace root — surface open sessions and context.

// Fetch project repos in the background (best effort)
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
if (missing.length > 0) lines.push(`Missing repos: ${missing.join(', ')}. Run /workspace-init to clone them.`);
if (existing.length > 0) lines.push(`Repos synced: ${existing.join(', ')}`);

// Surface active work sessions
const trackers = getSessionTrackers(root);
if (trackers.length > 0) {
  lines.push('');
  lines.push('Active work sessions:');
  for (let i = 0; i < trackers.length; i++) {
    const t = trackers[i];
    const wsWorktree = join(sessionFolderPath(root, t.name), 'workspace');
    const worktreeExists = existsSync(wsWorktree);
    if (!worktreeExists) {
      lines.push(`  ${i + 1}. ${t.name} (orphaned — worktree missing)`);
      continue;
    }
    const chats = t.chatSessions || [];
    const lastChat = chats[chats.length - 1];
    const lastEnded = lastChat?.ended;
    const statusDetail = t.status === 'paused'
      ? `paused ${timeAgo(lastEnded)}`
      : lastEnded
        ? `active, last chat ended ${timeAgo(lastEnded)}`
        : 'active';
    const repoList = Array.isArray(t.repos) ? t.repos.join(', ') : (t.repos || '—');
    lines.push(`  ${i + 1}. ${t.name} (${statusDetail})`);
    lines.push(`     "${t.description || ''}"`);
    lines.push(`     Branch: ${t.branch} | Repos: ${repoList}`);
    lines.push(`     Worktree: work-sessions/${t.name}/workspace/`);
    lines.push('');
  }
  lines.push('Use /start-work to resume a session or start new work.');
}

// Surface team-shared workspace context (secondary)
// Only scan shared/ — locked/ is now a sub-dir of shared/ and is included
// naturally. team-member/ is per-user (loaded via CLAUDE.local.md).
// release-notes/ is operational, not knowledge.
if (existsSync(sharedDir)) {
  const entries = [];

  function scanDir(dir, depth = 0) {
    if (depth > 3) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === '.keep') continue;
        scanDir(fullPath, depth + 1);
      } else if (entry.endsWith('.md') && entry !== '.keep' && !entry.startsWith('local-only-')) {
        const relPath = relative(contextDir, fullPath);
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

  scanDir(sharedDir);
  if (entries.length > 0) {
    lines.push('');
    lines.push('Workspace context:');
    lines.push(...entries);
  }
}

respond(lines.join('\n'));
