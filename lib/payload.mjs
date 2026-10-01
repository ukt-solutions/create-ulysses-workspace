// lib/payload.mjs
import { existsSync, cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'template');

export function getTemplateVersion() {
  return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version;
}

export function stagePayload(targetDir, { action, fromVersion = null }) {
  const payloadDir = join(targetDir, '.workspace-update');
  const toVersion = getTemplateVersion();

  // Clean any existing payload
  if (existsSync(payloadDir)) {
    rmSync(payloadDir, { recursive: true });
  }

  // Copy template to payload directory
  cpSync(TEMPLATE_DIR, payloadDir, { recursive: true });

  // The template stores .claude/ and .mcp.json under the inert names
  // _claude/ and _mcp.json (Claude Code protects the live names from
  // headless edits). The staged payload is an on-disk format shared with
  // the /workspace-update skill ALREADY INSTALLED in the workspace, which
  // reads .workspace-update/.claude/... — so it must keep the live names
  // exactly as older package versions staged them. _gitignore stays inert:
  // the skills have always merged it under that name.
  for (const [from, to] of [
    ['_claude', '.claude'],
    ['_mcp.json', '.mcp.json'],
  ]) {
    const src = join(payloadDir, from);
    if (existsSync(src)) {
      renameSync(src, join(payloadDir, to));
    }
  }

  // Write manifest
  const manifest = {
    action,
    templateVersion: toVersion,
    timestamp: new Date().toISOString(),
    source: '@ulysses-ai/create-workspace',
  };
  if (fromVersion) manifest.fromVersion = fromVersion;

  writeFileSync(join(payloadDir, '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  return { payloadDir, toVersion, fromVersion };
}

export function cleanPayload(targetDir) {
  const payloadDir = join(targetDir, '.workspace-update');
  if (existsSync(payloadDir)) {
    rmSync(payloadDir, { recursive: true });
  }
}
