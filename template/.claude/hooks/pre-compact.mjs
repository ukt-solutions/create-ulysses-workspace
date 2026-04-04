#!/usr/bin/env node
// PreCompact hook — prompt user to capture context before compaction
import { getWorkspaceRoot, readJSON, respond } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const settings = readJSON(`${root}/.claude/settings.local.json`);
const user = settings?.workspace?.user || 'unknown';

respond(`Context is about to be compacted — earlier conversation details will be lost.

If this session produced decisions, design choices, or progress worth keeping:
  /braindump [name] — capture discussion and reasoning
  /handoff [name]   — capture workstream state and next steps

Files in shared-context/${user}/ will persist. Conversation details won't.`);
