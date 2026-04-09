#!/usr/bin/env node
// PreToolUse hook — enforce workspace root write restrictions and detect out-of-session repo writes
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { getWorkspaceRoot, readStdin, respond, getActiveSessionPointer, readSessionMarker, readJSON } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const input = await readStdin();
const toolName = input.tool_name || '';

// Only check file-writing tools
if (!['Bash', 'Edit', 'Write'].includes(toolName)) {
  respond();
  process.exit(0);
}

// Extract file paths from tool input — normalize to forward slashes for cross-platform matching
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
  const marker = readSessionMarker(mainRoot, pointer.name);

  if (marker && config?.repos) {
    // Extract repo name from path: repos/{repo-name}/... or repos/{session}___wt-{repo}/...
    const repoMatch = paths.match(/repos\/([^/\s]+)/);
    if (repoMatch) {
      let targetRepo = repoMatch[1];
      // If it's a worktree path, extract the repo name after ___wt-
      const wtMatch = targetRepo.match(/___wt-(.+)/);
      if (wtMatch) {
        targetRepo = wtMatch[1];
        // Skip "workspace" worktree — that's always allowed
        if (targetRepo === 'workspace') {
          respond();
          process.exit(0);
        }
      }
      // Check if target repo exists in workspace.json but not in session
      if (config.repos[targetRepo] && !marker.repos.includes(targetRepo)) {
        respond(`You're about to write to ${targetRepo}, which isn't part of this session. Consider adding it first so changes land on the session branch.`);
        process.exit(0);
      }
    }
  }

  respond();
  process.exit(0);
}

// We're at the workspace root (main) — restrict writes

// Allow writes to .claude-scratchpad/
if (paths.includes('.claude-scratchpad')) {
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
  if (cmd.includes('.claude-scratchpad') || cmd.includes('local-only-')) {
    respond();
    process.exit(0);
  }
  // Allow helper script invocations from the workspace root
  if (/node\s+.*\.claude\/scripts\//.test(cmd)) {
    respond();
    process.exit(0);
  }
}

// Check if this write targets repos/, shared-context/, or template files
const isRepoWrite = paths.includes('repos/') || paths.includes('___wt-');
const isContextWrite = paths.includes('shared-context/') && !basename(filePathArg).startsWith('local-only-');
const isTemplateWrite = paths.includes('.claude/') && !paths.includes('.claude-scratchpad');

if (isRepoWrite || isContextWrite || isTemplateWrite) {
  respond("You're on main. All work should happen in a workspace worktree. Run /start-work to create or resume a work session.");
  process.exit(0);
}

respond();
