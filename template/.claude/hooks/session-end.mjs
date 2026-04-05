#!/usr/bin/env node
// SessionEnd hook — update session marker, write safety-net to inflight tracker
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getWorkspaceRoot, readStdin, readJSON, respond, getActiveSessionPointer, getMainRoot, readSessionMarker, writeSessionMarker } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const mainRoot = getMainRoot(root);
const scratchpad = join(mainRoot, '.claude-scratchpad');
const logFile = join(scratchpad, 'session-log.jsonl');
const settings = readJSON(join(root, '.claude', 'settings.local.json'));

const input = await readStdin();
const reason = input.reason || 'unknown';
const sessionId = input.session_id || null;
const user = settings?.workspace?.user || 'unknown';

let branch = 'unknown';
try {
  branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {}

// Update session marker — mark this chat as ended
const pointer = getActiveSessionPointer(root);
if (pointer) {
  const marker = readSessionMarker(mainRoot, pointer.name);
  if (marker && sessionId) {
    const chatEntry = marker.chatSessions?.find(c => c.id === sessionId && c.ended === null);
    if (chatEntry) {
      chatEntry.ended = new Date().toISOString();
      writeSessionMarker(mainRoot, pointer.name, marker);
    }
  }

  // Write safety-net entry to inflight tracker
  const trackerPath = join(root, 'shared-context', user, 'inflight', `session-${pointer.name}.md`);
  if (existsSync(trackerPath)) {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const safetyEntry = `\n### Session ended (${timestamp})\n\nReason: ${reason}. Chat session ${sessionId || 'unknown'}.\n`;
    appendFileSync(trackerPath, safetyEntry);

    // Auto-commit the tracker update to the workspace branch
    try {
      execSync(`git add "shared-context/${user}/inflight/session-${pointer.name}.md"`, { cwd: root, stdio: 'pipe' });
      execSync(`git commit -m "chore: session-end safety capture for ${pointer.name}" --allow-empty`, { cwd: root, stdio: 'pipe' });
    } catch {
      // Commit may fail if nothing changed or hooks block — not fatal
    }
  }
}

// Log to session-log.jsonl (existing behavior)
if (!existsSync(scratchpad)) mkdirSync(scratchpad, { recursive: true });

const entry = JSON.stringify({
  event: 'session_end',
  date: new Date().toISOString(),
  user,
  reason,
  session_id: sessionId,
  workspace_branch: branch,
  work_session: pointer?.name || null,
});

appendFileSync(logFile, entry + '\n');
respond();
