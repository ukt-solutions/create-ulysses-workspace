#!/usr/bin/env node
// PreToolUse hook — enforce workspace root write restrictions and detect
// out-of-session repo writes.
//
// New layout paths:
//   Workspace worktree: work-sessions/{name}/workspace/
//   Project worktree:   work-sessions/{name}/workspace/repos/{repo}/
//   Bare clone:         repos/{repo}/  (at workspace root)
//   Task worktree:      repos/{repo}/.claude/worktrees/{slug}/  (gh:132)
import { join, basename, resolve, relative, sep, isAbsolute } from 'path';
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

// Only run the hook body when invoked directly (not when imported by tests).
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/**
 * True when filePath sits inside repos/{repo}/.claude/worktrees/{slug}/ —
 * the task model's work area (gh:132). Task chats run at the workspace
 * root and edit there by design, so these writes are legitimate and must
 * not trip the "you're on main" repo/template warnings.
 *
 * Pure path arithmetic (relative + segment split), so it is sep-safe on
 * Windows and never touches the filesystem.
 */
export function isTaskWorktreeWrite(root, filePath) {
  if (!root || !filePath) return false;
  const rel = relative(resolve(root, 'repos'), resolve(filePath));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
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

  // Allow task-worktree writes: repos/{repo}/.claude/worktrees/{slug}/ is
  // the task model's work area at the root (gh:132). Edit/Write carry one
  // clean path; a Bash command is scanned token-wise (quotes stripped) so
  // embedded paths still match.
  const taskCandidates = toolName === 'Bash'
    ? String(toolInput.command || '').split(/\s+/).map((t) => t.replace(/^["']+|["']+$/g, ''))
    : [filePathArg || toolInput.path || ''];
  if (taskCandidates.some((c) => c && isTaskWorktreeWrite(root, c))) {
    respond();
    process.exit(0);
  }

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
  const isRepoWrite = /(?:^|[\s/])repos\//.test(paths) || paths.includes('work-sessions/');
  const isContextWrite = paths.includes('workspace-context/') && !basename(filePathArg).startsWith('local-only-');
  const isTemplateWrite = paths.includes('.claude/') && !paths.includes(scratchpadName);

  if (isRepoWrite || isContextWrite || isTemplateWrite) {
    respond("You're on main. All work should happen in a workspace worktree. Run /start-work to create or resume a work session.");
    process.exit(0);
  }

  respond();
}

if (isEntry) {
  await main();
}
