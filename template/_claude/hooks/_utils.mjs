import '../lib/require-node.mjs';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseSessionContent, updateSessionContent, writeSessionFile, readSessionFile } from '../lib/session-frontmatter.mjs';

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
 * (gh:196): sessionModel, tracker, forge, and the repo names (primary
 * marked). The labels mirror what the scripts reading workspace.json actually
 * do — no invented defaults: an absent tracker is `off`, a tracker object
 * without a type (or a non-object in its place) is `invalid`, an absent
 * forge type leaves each repo's origin to pick its adapter, and `repos` that
 * isn't a plain object is `invalid` rather than a silent empty manifest.
 * sessionModel defaults to "session", matching how /start-work routes absent
 * config.
 */
export function configSummary(config) {
  const w = config?.workspace || {};
  const model = typeof w.sessionModel === 'string' && w.sessionModel ? w.sessionModel : 'session';
  const parts = [`sessionModel: ${model}`];

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
 * Defensive normalization for a session tracker's `repos` field. A fresh
 * tracker written by create-work-session always holds an array, but an
 * older hand-edited tracker or a tracker migrated from the previous layout
 * might carry a scalar string (single repo) or null. Iterating a string
 * with `for (const x of s)` yields characters — this helper prevents that.
 */
export function normalizeRepos(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

// === Session tracker helpers ===

export function sessionFilePath(root, sessionName) {
  const { workSessionsDir } = getWorkspacePaths(root);
  return join(workSessionsDir, sessionName, 'workspace', 'session.md');
}

export function sessionFolderPath(root, sessionName) {
  const { workSessionsDir } = getWorkspacePaths(root);
  return join(workSessionsDir, sessionName);
}

export function sessionWorktreePath(root, sessionName) {
  const { workSessionsDir } = getWorkspacePaths(root);
  return join(workSessionsDir, sessionName, 'workspace');
}

/**
 * Walk work-sessions/ and return one descriptor per session.md found.
 * Each descriptor is { name, path, ...frontmatterFields }.
 */
export function getSessionTrackers(root) {
  const { workSessionsDir } = getWorkspacePaths(root);
  if (!existsSync(workSessionsDir)) return [];
  const results = [];
  for (const entry of readdirSync(workSessionsDir)) {
    const sessionPath = join(workSessionsDir, entry, 'workspace', 'session.md');
    if (!existsSync(sessionPath)) continue;
    try {
      const parsed = readSessionFile(sessionPath);
      results.push({
        ...parsed.fields,
        _path: sessionPath,
        _folder: join(workSessionsDir, entry),
      });
    } catch {
      // Skip malformed session files rather than crashing hooks
    }
  }
  return results;
}

/**
 * Read a single session tracker by name. Returns the parsed fields object
 * (not the full { fields, body, raw } shape). Returns null if missing.
 */
export function readSessionTracker(root, sessionName) {
  const path = sessionFilePath(root, sessionName);
  if (!existsSync(path)) return null;
  try {
    return readSessionFile(path).fields;
  } catch {
    return null;
  }
}

/**
 * Update specific fields in an existing session tracker. Lossless for
 * unchanged fields and the body. Creates the file if it does not exist.
 */
export function updateSessionTracker(root, sessionName, updates) {
  const path = sessionFilePath(root, sessionName);
  if (!existsSync(path)) {
    // Create a minimal stub; callers will usually supply all fields
    const folder = dirname(path);
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    writeSessionFile(path, updates, '\n# Work Session\n');
    return;
  }
  const content = readFileSync(path, 'utf-8');
  const next = updateSessionContent(content, updates);
  if (next !== content) writeFileSync(path, next);
}

/**
 * Create a brand-new session tracker file with the given fields and body.
 * Creates the work-sessions/{name}/ folder if it does not exist.
 */
export function createSessionTracker(root, sessionName, fields, body) {
  const path = sessionFilePath(root, sessionName);
  const folder = dirname(path);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  writeSessionFile(path, fields, body);
}

/**
 * Delete the entire work-sessions/{name}/ folder. Used by /complete-work
 * after the session is finalized and its artifacts promoted or discarded.
 * Caller is responsible for any git bookkeeping (branch deletes, prunes).
 */
export function deleteSessionFolder(root, sessionName) {
  const folder = sessionFolderPath(root, sessionName);
  if (!existsSync(folder)) return;
  rmSync(folder, { recursive: true, force: true });
}

// === Active session pointer (per-worktree) ===
// A workspace worktree writes a tiny JSON pointer file at:
//   {worktree}/.claude/.active-session.json
// to tell hooks which session is currently in scope. Scoped to the
// worktree itself — each worktree has its own pointer.

export function activeSessionPointerPath(worktreeRoot) {
  return join(worktreeRoot, '.claude', '.active-session.json');
}

export function getActiveSessionPointer(worktreeRoot) {
  return readJSON(activeSessionPointerPath(worktreeRoot));
}

export function writeActiveSessionPointer(worktreeRoot, data) {
  const path = activeSessionPointerPath(worktreeRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

export function getMainRoot(root) {
  const pointer = getActiveSessionPointer(root);
  return pointer?.rootPath || root;
}

export function timeAgo(isoString) {
  if (!isoString) return 'unknown';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
