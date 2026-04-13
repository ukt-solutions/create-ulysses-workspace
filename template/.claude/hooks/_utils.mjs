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

// === Session tracker helpers ===

export function sessionFilePath(root, sessionName) {
  const { workSessionsDir } = getWorkspacePaths(root);
  return join(workSessionsDir, sessionName, 'session.md');
}

export function sessionFolderPath(root, sessionName) {
  const { workSessionsDir } = getWorkspacePaths(root);
  return join(workSessionsDir, sessionName);
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
    const sessionPath = join(workSessionsDir, entry, 'session.md');
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
 * after the session is finalized and archived into release notes.
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
// to tell hooks which session is currently in scope. This is the
// replacement for the old .claude-scratchpad/.active-session.json —
// now scoped to the worktree itself rather than a shared scratchpad.

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
