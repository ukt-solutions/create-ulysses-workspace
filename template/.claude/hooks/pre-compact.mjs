#!/usr/bin/env node
// PreCompact hook — session-aware context capture nudge
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot, readJSON, respond, getActiveSessionPointer, timeAgo } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const settings = readJSON(join(root, '.claude', 'settings.local.json'));
const user = settings?.workspace?.user || 'unknown';

const pointer = getActiveSessionPointer(root);

if (pointer) {
  // In an active work session — check tracker freshness
  const trackerPath = join(root, 'shared-context', user, 'inflight', `session-${pointer.name}.md`);

  if (existsSync(trackerPath)) {
    const stat = statSync(trackerPath);
    const minsAgo = Math.floor((Date.now() - stat.mtimeMs) / 60000);

    if (minsAgo > 30) {
      respond(`Context is about to be compacted. Your session tracker for "${pointer.name}" was last updated ${timeAgo(stat.mtime.toISOString())}.\n\nConsider /handoff to update the tracker before context is lost.`);
    } else {
      respond(`Context compacting. Session tracker for "${pointer.name}" is recent (updated ${minsAgo}m ago). Earlier conversation details may still be lost — use /handoff if needed.`);
    }
  } else {
    respond(`Context is about to be compacted. No session tracker found for "${pointer.name}". Use /handoff to capture progress before context is lost.`);
  }
} else {
  // No active session — generic message
  respond(`Context is about to be compacted — earlier conversation details will be lost.\n\nIf this session produced decisions or progress worth keeping:\n  /braindump [name] — capture discussion and reasoning\n  /handoff [name]   — capture workstream state and next steps\n\nFiles in shared-context/${user}/ will persist. Conversation details won't.`);
}
