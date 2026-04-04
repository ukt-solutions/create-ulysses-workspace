#!/usr/bin/env node
// SessionStart + PreToolUse hook — detect pending workspace update payload
import { existsSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot, readJSON, respond } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const payloadDir = join(root, '.workspace-update');

// Fast bail if no payload exists
if (!existsSync(payloadDir)) {
  respond();
  process.exit(0);
}

const manifest = readJSON(join(payloadDir, '.manifest.json'));
const config = readJSON(join(root, 'workspace.json'));
const initialized = config?.workspace?.initialized === true;
const action = manifest?.action || (initialized ? 'upgrade' : 'init');
const version = manifest?.templateVersion || 'unknown';

if (action === 'init' || !initialized) {
  respond(`MANDATORY: A workspace init payload (template v${version}) is pending at .workspace-update/.
Read .workspace-update/.claude/skills/workspace-init/SKILL.md and follow it before doing anything else.
Do not proceed with the user's request until initialization is complete.`);
} else {
  const from = manifest?.fromVersion || 'unknown';
  respond(`MANDATORY: A workspace upgrade payload (v${from} → v${version}) is pending at .workspace-update/.
Read .workspace-update/.claude/skills/workspace-update/SKILL.md and follow it before doing anything else.
Do not proceed with the user's request until the update is complete.`);
}
