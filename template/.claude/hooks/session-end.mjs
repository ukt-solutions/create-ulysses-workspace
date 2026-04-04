#!/usr/bin/env node
// SessionEnd hook — log session summary to session-log.jsonl
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getWorkspaceRoot, readStdin, readJSON, respond } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const scratchpad = join(root, '.claude-scratchpad');
const logFile = join(scratchpad, 'session-log.jsonl');
const settings = readJSON(join(root, '.claude', 'settings.local.json'));

const input = await readStdin();
const reason = input.reason || 'unknown';
const user = settings?.workspace?.user || 'unknown';

let branch = 'unknown';
try {
  branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {}

if (!existsSync(scratchpad)) mkdirSync(scratchpad, { recursive: true });

const entry = JSON.stringify({
  event: 'session_end',
  date: new Date().toISOString(),
  user,
  reason,
  workspace_branch: branch,
});

appendFileSync(logFile, entry + '\n');
respond();
