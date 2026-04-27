#!/usr/bin/env node
// PreToolUse hook — enforce workspace root write restrictions and detect
// out-of-session repo writes.
//
// New layout paths:
//   Workspace worktree: work-sessions/{name}/workspace/
//   Project worktree:   work-sessions/{name}/workspace/repos/{repo}/
//   Bare clone:         repos/{repo}/  (at workspace root)
import { join, basename } from 'path';
import {
  getWorkspaceRoot,
  readStdin,
  respond,
  getActiveSessionPointer,
  readSessionTracker,
  readJSON,
  getWorkspacePaths,
} from './_utils.mjs';

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
