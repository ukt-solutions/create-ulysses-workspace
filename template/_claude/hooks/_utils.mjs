import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

export function getWorkspaceRoot(importMetaUrl) {
  const hookDir = dirname(fileURLToPath(importMetaUrl));
  return resolve(hookDir, '..', '..');
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function respond(additionalContext) {
  if (additionalContext) {
    console.log(JSON.stringify({ additionalContext }));
  } else {
    console.log('{}');
  }
}

/**
 * Resolve the work-sessions directory (default "work-sessions") and the
 * workspace scratchpad dir (default "workspace-scratchpad") from workspace.json.
 *
 * `workSessionsDir` names a directory the template no longer writes: sessions
 * were the work lifecycle earlier versions had. The key stays read because
 * updates never remove keys, and it is what listLegacySessions and
 * migrate-sessions.mjs look under for the sessions a workspace has left.
 */
export function getWorkspacePaths(root) {
  const config = readJSON(join(root, 'workspace.json'));
  return {
    workSessionsDir: join(root, config?.workspace?.workSessionsDir || 'work-sessions'),
    scratchpadDir: join(root, config?.workspace?.scratchpadDir || 'workspace-scratchpad'),
  };
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The `Workspace config (workspace.json):` summary line session-start injects
 * (gh:196): tracker, forge, and the repo names (primary marked). The labels
 * mirror what the scripts reading workspace.json actually do — no invented
 * defaults: an absent tracker is `off`, a tracker object without a type (or
 * a non-object in its place) is `invalid`, an absent forge type leaves each
 * repo's origin to pick its adapter, and `repos` that isn't a plain object
 * is `invalid` rather than a silent empty manifest.
 *
 * sessionModel is deliberately absent. Nothing routes on it — new work is
 * always a task — and a workspace's file may still hold it, often as
 * `"session"`: printed, that would read as a lifecycle in use. Whether the
 * workspace still holds sessions from that lifecycle is a fact about the
 * sessions directory, and it has its own line (listLegacySessions below).
 */
export function configSummary(config) {
  const w = config?.workspace || {};
  const parts = [];

  let tracker;
  if (!w.tracker) tracker = 'off';
  else if (!isPlainObject(w.tracker)) tracker = 'invalid';
  else if (typeof w.tracker.type !== 'string' || !w.tracker.type) tracker = 'invalid (no type)';
  else tracker = w.tracker.repo ? `${w.tracker.type} on ${w.tracker.repo}` : w.tracker.type;
  parts.push(`tracker: ${tracker}`);

  let forge;
  if (w.forge === false) forge = 'off';
  else if (!isPlainObject(w.forge)) forge = w.forge ? 'invalid' : 'auto (from origin)';
  else if (typeof w.forge.type !== 'string' || !w.forge.type) forge = 'auto (from origin)';
  else forge = w.forge.type;
  parts.push(`forge: ${forge}`);

  let repos;
  if (!isPlainObject(config?.repos)) repos = config?.repos ? 'invalid' : 'none';
  else {
    const names = Object.keys(config.repos);
    repos = names.length === 0 ? 'none'
      : names.map((n) => (config.repos[n]?.primary ? `${n} (primary)` : n)).join(', ');
  }
  parts.push(`repos: ${repos}`);
  return parts.join(' | ');
}

/**
 * The one line session-start prints when this machine's per-user setup is
 * incomplete (gh:130), or null when nothing is missing. A clone of a
 * workspace a teammate already initialized is the common case: repos/ is
 * empty and there is no user identity yet. /workspace-init handles that as
 * a join — it no longer refuses an initialized workspace — so the hint says
 * "join" there and keeps the plain "initialize" wording for a workspace
 * that was never initialized.
 *
 * @param {object} s
 * @param {boolean} s.initialized  workspace.json → workspace.initialized
 * @param {string[]} s.missingRepos repos in workspace.json absent under repos/
 * @param {boolean} s.hasUser       settings.local.json carries workspace.user
 * @param {boolean} s.hasClaudeLocal CLAUDE.local.md exists
 */
export function setupHint({ initialized, missingRepos = [], hasUser, hasClaudeLocal }) {
  const gaps = [];
  if (missingRepos.length > 0) gaps.push(`missing repos: ${missingRepos.join(', ')}`);
  if (!hasUser) gaps.push('no user set in .claude/settings.local.json');
  else if (!hasClaudeLocal) gaps.push('no CLAUDE.local.md');
  if (gaps.length === 0) return null;
  const action = initialized
    ? 'Run /workspace-init to join this workspace — it sets up only what this machine is missing'
    : 'Run /workspace-init to initialize this workspace';
  return `Setup incomplete (${gaps.join('; ')}). ${action}.`;
}

/**
 * The launcher root for a process running at `root`.
 *
 * The session lifecycle — the one earlier template versions had, removed
 * now — wrote a small pointer file at {root}/.claude/.active-session.json
 * inside each of its workspace worktrees, naming the session and the
 * launcher it belonged to. Nothing writes that file any more, and no hook
 * reads it: this is its one remaining reader, kept for
 * migrate-session-layout.mjs (the pre-v0.10 migrator), which can be run from
 * inside one of those worktrees and needs the launcher rather than the
 * worktree. With no pointer, or one without a rootPath, the root is its own
 * launcher.
 */
export function getMainRoot(root) {
  const pointer = readJSON(join(root, '.claude', '.active-session.json'));
  return pointer?.rootPath || root;
}

/**
 * The sessions a workspace still holds under the legacy session lifecycle:
 * the names directly under the sessions directory that do not start with a
 * dot, sorted. New work is always a task, so an entry here is work that
 * predates the task lifecycle and waits to be drained with /migrate-sessions.
 * This is the one place that decides whether a workspace "still has legacy
 * sessions" — the session-start hook's nudge, the maintenance audit's info
 * line and /workspace-update's report all count the same thing.
 *
 * Dot entries are the migration's own (.archived/) or tooling noise, and
 * never count. Every other entry counts whatever it holds — a session
 * folder, an orphan shell — because the inventory is what says which is
 * which. The directory alone decides: a missing or unreadable one means
 * none. workspace.sessionModel is never read — the key is kept for older
 * workspaces and selects nothing.
 */
export function listLegacySessions(root) {
  const { workSessionsDir } = getWorkspacePaths(root);
  let entries;
  try {
    entries = readdirSync(workSessionsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => !name.startsWith('.')).sort();
}
