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
const initialized = config?.workspace?.initialized === true || !!config?.workspace?.templateVersion;
const action = manifest?.action || (initialized ? 'upgrade' : 'init');
const version = manifest?.templateVersion || 'unknown';

// Check if payload is stale (older than 5 minutes = likely survived a previous session)
const stale = manifest?.timestamp
  ? (Date.now() - new Date(manifest.timestamp).getTime()) > 5 * 60 * 1000
  : false;
const urgency = stale
  ? `URGENT: This update payload has been pending since ${manifest.timestamp}. It was not completed in a previous session. `
  : '';
const skipAudit = stale
  ? 'Skip the pre-update audit and proceed directly to comparing and applying changes. '
  : '';

if (action === 'init' || !initialized) {
  respond(`MANDATORY: ${urgency}A workspace init payload (template v${version}) is pending at .workspace-update/.
Read .workspace-update/.claude/skills/workspace-init/SKILL.md and follow it before doing anything else.
${skipAudit}Do not proceed with the user's request until initialization is complete.`);
} else {
  const from = manifest?.fromVersion || 'unknown';
  respond(`MANDATORY: ${urgency}A workspace upgrade payload (v${from} → v${version}) is pending at .workspace-update/.
Read .workspace-update/.claude/skills/workspace-update/SKILL.md and follow it before doing anything else.
${skipAudit}Do not proceed with the user's request until the update is complete.`);
}
