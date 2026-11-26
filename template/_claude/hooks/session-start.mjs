#!/usr/bin/env node
// SessionStart hook — register this chat in the active session tracker
// and surface open sessions + shared context.
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { execFileSync } from 'child_process';
import {
  getWorkspaceRoot,
  readJSON,
  readStdin,
  respond,
  getSessionTrackers,
  listLegacySessions,
  getActiveSessionPointer,
  readSessionTracker,
  updateSessionTracker,
  sessionFolderPath,
  timeAgo,
  configSummary,
  setupHint,
} from './_utils.mjs';
import { reconcile, readSessionRegistry, resolveChatName } from '../scripts/chat-record.mjs';
import { normalizeRoster, sessionStartLines, readGitEmail } from '../lib/team-roster.mjs';

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

// One compact config summary (gh:196). CLAUDE.md no longer imports
// workspace.json, so this line is what a session sees of the config without
// reading the file — it names the file so sessions know where the values
// live, and skills that need more than these fields read it on demand. Keep
// it small: every session pays for it, which is exactly why the import was
// dropped. configSummary (_utils.mjs) prints invalid/absent states rather
// than inventing defaults the scripts don't apply.
lines.push(`Workspace config (workspace.json): ${configSummary(config)}`);

// Keep this chat's record in step with its identity (gh:132). The record is
// keyed on sessionId and filed under the chat name, so a rename moves the file
// and its drawer rather than orphaning them.
//
// No live set is passed, deliberately: the registry lists running processes,
// not chats that exist, so a chat the operator merely closed is
// indistinguishable from one that is gone. Pruning here would delete the scope
// and open tasks of every chat not currently open.
if (chatId) {
  try {
    const registry = readSessionRegistry();
    const me = registry.find((r) => r.sessionId === chatId);
    // The registry only knows names for chats it has seen. An unnamed chat
    // keeps whatever name its record already carries rather than being
    // relabeled with its raw UUID; only a truly new chat falls back to the id.
    const name = resolveChatName(root, { sessionId: chatId, registryName: me?.name });
    const res = reconcile(root, { sessionId: chatId, name });
    if (res.renamed) {
      lines.push(`Chat renamed: ${res.renamed.from} -> ${res.renamed.to} (record and drawer moved)`);
    }
    // Name the record so a skill can find its own chat's state without
    // guessing (gh:132) — /start-work's task flow keys off this line.
    lines.push(`Chat record: ${name}`);
  } catch {
    // The chat record is a convenience, not a precondition for a session.
    // A failure here must never stop Claude from starting.
  }

  // Name the workspace root so skills can address it without deriving it
  // from git internals — which resolve to the source clone, not the
  // launcher, when a chat runs from inside a task worktree (gh:132).
  lines.push(`Workspace root: ${root}`);
}

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

// Fetch each project clone, then mirror the clones onto this repo as remotes
// a pull request can be matched by (repo-remotes.mjs). Both are conveniences:
// a failure in either changes what the session is told, never whether it
// starts.
const repoNames = Object.keys(config.repos || {});
const missing = [];
const existing = [];
for (const name of repoNames) {
  const repoPath = join(reposDir, name);
  if (existsSync(repoPath)) {
    existing.push(name);
    try {
      execFileSync('git', ['fetch', '--quiet'], { cwd: repoPath, stdio: 'pipe', timeout: 10000 });
    } catch {}
  } else {
    missing.push(name);
  }
}
// The module is imported here rather than at the top of the file so that a
// workspace whose update left the script out still starts: a module that
// cannot be loaded is one more failure for this try to absorb.
let repoRemotesNote = '';
try {
  const { syncRepoRemotes, repoRemotesLine } = await import('../scripts/repo-remotes.mjs');
  repoRemotesNote = repoRemotesLine(syncRepoRemotes(root, { enabled: config.workspace?.repoRemotes !== false }));
} catch {
  // These remotes only help match pull requests to a chat. A session that
  // starts without them has lost nothing it needs.
}
// A teammate's fresh clone of an initialized workspace has no repos/ and no
// user identity; point it at /workspace-init's join flow (gh:130).
const localSettings = readJSON(join(root, '.claude', 'settings.local.json'));
const localUser = typeof localSettings?.workspace?.user === 'string' && localSettings.workspace.user !== ''
  ? localSettings.workspace.user
  : null;
const hint = setupHint({
  initialized: config.workspace?.initialized === true,
  missingRepos: missing,
  hasUser: localUser !== null,
  hasClaudeLocal: existsSync(join(root, 'CLAUDE.local.md')),
});
if (hint) lines.push(hint);
// The team roster (gh:133). When workspace.json declares one, say so as
// soon as this machine's identity disagrees with it: workspace.user is an
// alias or missing from the roster, or git commits as someone else. Only
// local facts are checked here; the forge login needs the network, so
// /maintenance checks that one.
const roster = normalizeRoster(config.workspace?.team);
if (roster.present && localUser) {
  lines.push(...sessionStartLines(roster, { user: localUser, gitEmail: readGitEmail(root) }));
}
if (existing.length > 0) lines.push(`Repos synced: ${existing.join(', ')}`);
// One line, and only when a remote changed or a clone could not get one:
// every session pays for each line here.
if (repoRemotesNote) lines.push(repoRemotesNote);

// Sessions left under the legacy session lifecycle. New work is always a
// task now, so whatever is still under the sessions directory is work from
// before the task lifecycle: one line says how many there are and where to
// start draining them. The count is the directory's alone (listLegacySessions
// in _utils.mjs) — dot entries such as .archived/ never count, and
// workspace.sessionModel is not consulted, because the key selects nothing.
const legacySessions = listLegacySessions(root);
if (legacySessions.length > 0) {
  lines.push(`This workspace still has ${legacySessions.length} work session(s) under the old session model — /migrate-sessions can inventory and drain them.`);
}

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
