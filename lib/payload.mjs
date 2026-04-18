// lib/payload.mjs
import { existsSync, cpSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
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
