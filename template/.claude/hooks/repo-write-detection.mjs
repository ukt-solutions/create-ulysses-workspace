#!/usr/bin/env node
// PreToolUse hook — enforce workspace root write restrictions
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { getWorkspaceRoot, readStdin, respond, getActiveSessionPointer } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const input = await readStdin();
const toolName = input.tool_name || '';

// Only check file-writing tools
if (!['Bash', 'Edit', 'Write'].includes(toolName)) {
  respond();
  process.exit(0);
}

// Extract file paths from tool input
const toolInput = input.tool_input || {};
const paths = [toolInput.file_path, toolInput.command, toolInput.path]
  .filter(Boolean)
  .join(' ');

// If we're in a workspace worktree, allow all writes
const pointer = getActiveSessionPointer(root);
if (pointer) {
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
}

// Check if this write targets repos/, shared-context/, or template files
const isRepoWrite = paths.includes('repos/') || paths.includes('___wt-');
const isContextWrite = paths.includes('shared-context/') && !basename(filePathArg).startsWith('local-only-');
const isTemplateWrite = paths.includes('.claude/') && !paths.includes('.claude-scratchpad');

if (isRepoWrite || isContextWrite || isTemplateWrite) {
  respond("You're on main. All work should happen in a workspace worktree. Run /start-work to create or resume a work session.");
}

respond();
