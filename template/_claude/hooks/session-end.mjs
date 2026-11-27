#!/usr/bin/env node
// SessionEnd hook — append one line to the workspace session log.
//
// workspace-scratchpad/session-log.jsonl is machine-local and disposable, but
// it is the only record of when chats ended and why. /maintenance reads it for
// its session statistics and workspace-diagnostics.mjs aggregates it by event
// and reason. Nothing here may keep a chat from ending: a failure to read the
// settings or git leaves its field at the default and the line is still
// written.
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  getWorkspaceRoot,
  readStdin,
  readJSON,
  respond,
  getWorkspacePaths,
} from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const { scratchpadDir } = getWorkspacePaths(root);
const logFile = join(scratchpadDir, 'session-log.jsonl');
const settings = readJSON(join(root, '.claude', 'settings.local.json'));

const input = await readStdin();
const reason = input.reason || 'unknown';
const sessionId = input.session_id || null;
const user = settings?.workspace?.user || 'unknown';

let branch = 'unknown';
try {
  branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {}

if (!existsSync(scratchpadDir)) mkdirSync(scratchpadDir, { recursive: true });
const entry = JSON.stringify({
  event: 'session_end',
  date: new Date().toISOString(),
  user,
  reason,
  session_id: sessionId,
  workspace_branch: branch,
});
appendFileSync(logFile, entry + '\n');

respond();
