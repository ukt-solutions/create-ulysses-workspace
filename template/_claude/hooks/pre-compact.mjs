#!/usr/bin/env node
// PreCompact hook — context capture nudge.
import { respond } from './_utils.mjs';

respond(`Context is about to be compacted — earlier conversation details will be lost.\n\nIf this session produced decisions or progress worth keeping:\n  /braindump [name] — capture discussion and reasoning\n  /handoff [name]   — capture workstream state and next steps\n\nFiles in workspace-context/ will persist. Conversation details won't.`);
