#!/usr/bin/env node
// PreToolUse hook — enforce workspace root write restrictions and detect
// out-of-session repo writes.
//
// New layout paths:
//   Workspace worktree: work-sessions/{name}/workspace/
//   Project worktree:   work-sessions/{name}/workspace/repos/{repo}/
//   Bare clone:         repos/{repo}/  (at workspace root)
//   Task worktree:      repos/{repo}/.claude/worktrees/{slug}/  (gh:132)
//   Workspace task worktree: {root}/.claude/worktrees/{slug}/  (gh:146)
import { join, basename, resolve, relative, sep, isAbsolute, dirname } from 'path';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  getWorkspaceRoot,
  readStdin,
  respond,
  getActiveSessionPointer,
  readSessionTracker,
  readJSON,
  getWorkspacePaths,
} from './_utils.mjs';

// .native resolves Windows 8.3 short names; the plain fallback covers
// filesystems where the native binding is unavailable.
function realPath(p) {
  try { return realpathSync.native(p); } catch { /* fall through */ }
  try { return realpathSync(p); } catch { /* fall through */ }
  return resolve(p);
}

// Realpaths BOTH sides: Node resolves the module URL through symlinks
// (import.meta.url is the real path) while argv[1] stays exactly as the
// host passed it — a bare comparison silently disables the hook whenever
// the hook is reached through a symlinked workspace.
function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realPath(fileURLToPath(metaUrl)) === realPath(process.argv[1]);
  } catch { return false; }
}

// realpath the deepest existing ancestor and reattach the missing tail:
// the file being written may not exist yet, but the worktree directory it
// lands in does. When no ancestor exists at all, no symlink can be in
// play, so the resolved input is returned as-is.
function realPathDeepest(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try { return join(realpathSync.native(cur), ...tail); } catch { /* climb */ }
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    tail.unshift(basename(cur));
    cur = parent;
  }
}

// relative() output is "inside" when it is a plain descent — not '', '..',
// a '..'-prefixed climb, or a cross-volume absolute path (Windows drives).
function isDescent(rel) {
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * True when filePath sits inside repos/{repo}/.claude/worktrees/{slug}/ —
 * the task model's project work area (gh:132) — or inside
 * {root}/.claude/worktrees/{slug}/, the workspace repo's own task
 * worktrees (gh:146). Task chats run at the workspace root and edit there
 * by design, so these writes are legitimate and must not trip the "you're
 * on main" repo/template warnings. The worktrees directory itself and any
 * other {root}/.claude/... path stay warnable.
 *
 * Pure path arithmetic (realpath + relative + segment split), so it is
 * sep-safe on Windows, symlink-safe on macOS, and never stats the file
 * itself.
 */
export function isTaskWorktreeWrite(root, filePath) {
  if (!root || !filePath) return false;
  const rootReal = realPath(resolve(root));
  const fileReal = realPathDeepest(resolve(filePath));

  // The workspace repo's own worktrees: {root}/.claude/worktrees/{slug}/…
  const relRoot = relative(rootReal, fileReal);
  if (isDescent(relRoot)) {
    const rootParts = relRoot.split(sep);
    if (rootParts.length >= 3 && rootParts[0] === '.claude' && rootParts[1] === 'worktrees') return true;
  }

  // Project worktrees: repos/{repo}/.claude/worktrees/{slug}/…
  const rel = relative(realPath(join(rootReal, 'repos')), fileReal);
  if (!isDescent(rel)) return false;
  const parts = rel.split(sep);
  return parts.length >= 4 && parts[1] === '.claude' && parts[2] === 'worktrees';
}

async function main() {
  const root = getWorkspaceRoot(import.meta.url);
  const input = await readStdin();
  const toolName = input.tool_name || '';

  if (!['Bash', 'Edit', 'Write'].includes(toolName)) {
    respond();
    process.exit(0);
  }

  const toolInput = input.tool_input || {};
  const paths = [toolInput.file_path, toolInput.command, toolInput.path]
    .filter(Boolean)
    .join(' ')
    .replace(/\\/g, '/');

  // If we're in a workspace worktree, check for out-of-session repo writes
  const pointer = getActiveSessionPointer(root);
  if (pointer) {
    const mainRoot = pointer.rootPath || root;
    const config = readJSON(join(mainRoot, 'workspace.json'));
    const tracker = readSessionTracker(mainRoot, pointer.name);

    if (tracker && config?.repos) {
      // Find references to repos inside work-sessions/{name}/workspace/repos/{repo}/
      // and also the workspace-root repos/{repo}/ for direct writes.
      const wtMatch = paths.match(/work-sessions\/[^/\s]+\/workspace\/repos\/([^/\s]+)/);
      const cloneMatch = paths.match(/(?:^|\s|\/)repos\/([^/\s]+)/);
      const targetRepo = wtMatch ? wtMatch[1] : (cloneMatch ? cloneMatch[1] : null);
      if (targetRepo) {
        const sessionRepos = tracker.repos || [];
        if (config.repos[targetRepo] && !sessionRepos.includes(targetRepo)) {
          respond(`You're about to write to ${targetRepo}, which isn't part of this session. Consider adding it first so changes land on the session branch.`);
          process.exit(0);
        }
      }
    }

    respond();
    process.exit(0);
  }

  // We're at the main workspace root — restrict writes

  const { scratchpadDir } = getWorkspacePaths(root);
  const scratchpadName = scratchpadDir.slice(root.length + 1); // "workspace-scratchpad"

  // Allow writes to the workspace scratchpad
  if (paths.includes(scratchpadName)) {
    respond();
    process.exit(0);
  }

  // Allow writes to local-only-* files
  const filePathArg = toolInput.file_path || '';
  if (basename(filePathArg).startsWith('local-only-')) {
    respond();
    process.exit(0);
  }

  // Task-model writes: repos/{repo}/.claude/worktrees/{slug}/ is the task
  // model's work area at the root (gh:132). Those tokens are stripped from
  // what the warning checks judge — an Edit/Write inside a worktree leaves
  // nothing to judge and is exempt, while a Bash command that ALSO touches
  // the source clone or template files is judged on, and warned about,
  // everything else it names.
  const taskTokens = toolName === 'Bash'
    ? String(toolInput.command || '').split(/\s+/).map((t) => t.replace(/^["']+|["']+$/g, ''))
    : [toolInput.file_path, toolInput.path].filter(Boolean);
  const judged = taskTokens
    .filter((t) => !isTaskWorktreeWrite(root, t))
    .join(' ')
    .replace(/\\/g, '/');

  // For Bash commands, check if the command targets allowed paths
  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (/^\s*(git|ls|cat|head|tail|grep|rg|find|echo|pwd|cd|which|node\s+-c)\b/.test(cmd)) {
      respond();
      process.exit(0);
    }
    if (cmd.includes(scratchpadName) || cmd.includes('local-only-')) {
      respond();
      process.exit(0);
    }
    // Allow helper script invocations from the workspace root
    if (/node\s+.*\.claude\/scripts\//.test(cmd)) {
      respond();
      process.exit(0);
    }
  }

  // Check if this write targets repos/, workspace-context/, work-sessions/, or template files
  const isRepoWrite = /(?:^|[\s/])repos\//.test(judged) || judged.includes('work-sessions/');
  const isContextWrite = judged.includes('workspace-context/') && !basename(filePathArg).startsWith('local-only-');
  const isTemplateWrite = judged.includes('.claude/') && !judged.includes(scratchpadName);

  if (isRepoWrite || isContextWrite || isTemplateWrite) {
    respond("You're on main. All work should happen in a workspace worktree. Run /start-work to create or resume a work session.");
    process.exit(0);
  }

  respond();
}

if (isMainModule(import.meta.url)) {
  await main();
}
