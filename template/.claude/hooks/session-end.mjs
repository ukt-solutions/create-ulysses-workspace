#!/usr/bin/env node
// SessionEnd hook — mark this chat's `ended` timestamp in the session
// tracker and append a small safety-net note to the session.md body.
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  getWorkspaceRoot,
  readStdin,
  readJSON,
  respond,
  getActiveSessionPointer,
  getMainRoot,
  readSessionTracker,
  updateSessionTracker,
  sessionFilePath,
  getWorkspacePaths,
} from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const mainRoot = getMainRoot(root);
const { scratchpadDir } = getWorkspacePaths(mainRoot);
const logFile = join(scratchpadDir, 'session-log.jsonl');
const settings = readJSON(join(root, '.claude', 'settings.local.json'));

const input = await readStdin();
const reason = input.reason || 'unknown';
const sessionId = input.session_id || null;
const user = settings?.workspace?.user || 'unknown';

let branch = 'unknown';
try {
  branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {}

// Update session tracker: mark this chat as ended, append safety note
const pointer = getActiveSessionPointer(root);
if (pointer && sessionId) {
  const tracker = readSessionTracker(mainRoot, pointer.name);
  if (tracker) {
    const chats = tracker.chatSessions || [];
    const chat = chats.find(c => c.id === sessionId && c.ended === null);
    if (chat) {
      chat.ended = new Date().toISOString();
      updateSessionTracker(mainRoot, pointer.name, {
        chatSessions: chats,
        updated: new Date().toISOString().slice(0, 10),
      });
    }

    // Append a safety-net note to the session.md body so the next chat
    // can see that a previous chat ended without capturing explicitly.
    const trackerPath = sessionFilePath(mainRoot, pointer.name);
    if (existsSync(trackerPath)) {
      const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const safetyEntry = `\n### Session ended (${timestamp})\n\nReason: ${reason}. Chat session ${sessionId || 'unknown'}.\n`;
      appendFileSync(trackerPath, safetyEntry);

      // Auto-commit so the safety capture survives even if the user doesn't
      // explicitly handoff. Best-effort — non-fatal if the commit fails.
      try {
        const relPath = trackerPath.startsWith(mainRoot + '/')
          ? trackerPath.slice(mainRoot.length + 1)
          : trackerPath;
        execSync(`git add "${relPath}"`, { cwd: mainRoot, stdio: 'pipe' });
        execSync(`git commit -m "chore: session-end safety capture for ${pointer.name}"`, { cwd: mainRoot, stdio: 'pipe' });
      } catch {
        // Non-fatal — nothing changed, hook blocked, etc.
      }
    }
  }
}

// Append to the workspace session log (disposable)
if (!existsSync(scratchpadDir)) mkdirSync(scratchpadDir, { recursive: true });
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
