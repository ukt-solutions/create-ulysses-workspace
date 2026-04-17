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
  sessionWorktreePath,
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
    // The tracker lives inside the session worktree on the session branch,
    // so the auto-commit must run from inside the worktree.
    const trackerPath = sessionFilePath(mainRoot, pointer.name);
    if (existsSync(trackerPath)) {
      const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const safetyEntry = `\n### Session ended (${timestamp})\n\nReason: ${reason}. Chat session ${sessionId || 'unknown'}.\n`;
      appendFileSync(trackerPath, safetyEntry);

      // Auto-commit from inside the worktree. Best-effort — non-fatal if
      // the commit fails (hook blocked, nothing to commit, etc.).
      try {
        const worktreeCwd = sessionWorktreePath(mainRoot, pointer.name);
        execSync('git add session.md', { cwd: worktreeCwd, stdio: 'pipe' });
        execSync(
          `git commit -m "chore: session-end safety capture for ${pointer.name}"`,
          { cwd: worktreeCwd, stdio: 'pipe' }
        );
      } catch {
        // Non-fatal
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
