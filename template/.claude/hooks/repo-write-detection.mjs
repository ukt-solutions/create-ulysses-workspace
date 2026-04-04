#!/usr/bin/env node
// PreToolUse hook — detect writes to worktrees without active work session
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot, readStdin, respond } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const scratchpad = join(root, '.claude-scratchpad');

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

// Only care about writes to worktrees
if (!paths.includes('___wt-')) {
  respond();
  process.exit(0);
}

// Check if any work session is active
if (existsSync(scratchpad)) {
  const markers = readdirSync(scratchpad).filter(f => f.startsWith('.work-session-'));
  if (markers.length > 0) {
    respond();
    process.exit(0);
  }
}

respond("You're making changes to a worktree but no work session is active. Run /start-work to formalize this work session.");
