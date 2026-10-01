#!/usr/bin/env node
// SessionEnd hook — mark this chat's `ended` timestamp in the session
// tracker, append a small safety-net note to the session.md body, and
// write a disk-durable reflection record if the session.md ## Progress
// section contains heuristic correction-pattern sentences.
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
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

      // Disk-durable reflection sub-step (BP-10).
      // Read the ## Progress section of session.md (last 2000 chars max),
      // scan for heuristic correction-pattern sentences, and write any
      // candidates to workspace-scratchpad/session-reflect.json. The file
      // is gitignored (workspace-scratchpad/ is in _gitignore). We do NOT
      // emit additionalContext for this — per the canonical known limitation,
      // additionalContext does not always reach Claude. Disk is the primary
      // durable output.
      try {
        const sessionContent = readFileSync(trackerPath, 'utf8');

        // Extract ## Progress section — find the section and take last 2000 chars.
        const progressMatch = sessionContent.match(/^## Progress\s*\n([\s\S]*?)(?=\n^##|\s*$)/m);
        const progressText = progressMatch
          ? progressMatch[1].slice(-2000)
          : sessionContent.slice(-2000);

        // Split into sentences on '. ' or '.\n' boundaries.
        const sentences = progressText
          .split(/(?<=\.)\s+|\n/)
          .map(s => s.trim())
          .filter(s => s.length > 10);

        // Correction-pattern keywords — case-insensitive.
        const correctionPatterns = [
          /actually/i,
          /instead of/i,
          /the right way is/i,
          /i was wrong/i,
          /correction:/i,
        ];

        const candidates = sentences
          .filter(sentence => correctionPatterns.some(re => re.test(sentence)))
          .map(text => ({ text, source: '## Progress' }));

        if (candidates.length > 0) {
          if (!existsSync(scratchpadDir)) mkdirSync(scratchpadDir, { recursive: true });
          const reflectPath = join(scratchpadDir, 'session-reflect.json');

          // Read existing records to append (create-or-append pattern).
          let records = [];
          if (existsSync(reflectPath)) {
            try {
              records = JSON.parse(readFileSync(reflectPath, 'utf8'));
              if (!Array.isArray(records)) records = [records];
            } catch {
              records = [];
            }
          }

          records.push({
            sessionId: sessionId || `ts-${Date.now()}`,
            date: new Date().toISOString(),
            workSession: pointer.name,
            candidates,
          });

          writeFileSync(reflectPath, JSON.stringify(records, null, 2), 'utf8');
        }
      } catch {
        // Non-fatal — reflection is best-effort.
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
