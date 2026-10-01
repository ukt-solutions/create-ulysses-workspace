#!/usr/bin/env node
// Unit tests for payload.mjs
// Run: node lib/payload.test.mjs
//
// The staged .workspace-update/ payload is an on-disk format shared with
// the /workspace-update skill already installed in existing workspaces,
// which reads .workspace-update/.claude/... and .workspace-update/.mcp.json.
// These tests pin that layout even though template/ itself stores the
// protected paths under the inert names _claude/ and _mcp.json.
import { stagePayload, cleanPayload } from './payload.mjs';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let failed = 0;
let passed = 0;
function check(label, ok) {
  if (ok) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'payload-test-'));

try {
  const { payloadDir, toVersion } = stagePayload(root, { action: 'init' });

  check('payload staged at .workspace-update/', existsSync(payloadDir));
  check('manifest written', existsSync(join(payloadDir, '.manifest.json')));
  check('returns the package version', typeof toVersion === 'string' && toVersion.length > 0);

  // The payload keeps the live names older workspaces' skills expect
  check('.claude/ staged under live name', existsSync(join(payloadDir, '.claude')));
  check('.claude/skills/workspace-update/SKILL.md staged', existsSync(join(payloadDir, '.claude', 'skills', 'workspace-update', 'SKILL.md')));
  check('.claude/settings.json staged', existsSync(join(payloadDir, '.claude', 'settings.json')));
  check('.mcp.json staged under live name', existsSync(join(payloadDir, '.mcp.json')));
  check('_gitignore stays inert (skills merge it under that name)', existsSync(join(payloadDir, '_gitignore')));

  // The template's inert names must not leak into the payload
  check('no _claude/ in payload', !existsSync(join(payloadDir, '_claude')));
  check('no _mcp.json in payload', !existsSync(join(payloadDir, '_mcp.json')));

  // cleanPayload removes the staging directory
  cleanPayload(root);
  check('cleanPayload removes .workspace-update/', !existsSync(payloadDir));
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
