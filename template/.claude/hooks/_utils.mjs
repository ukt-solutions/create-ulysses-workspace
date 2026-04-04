import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export function getWorkspaceRoot(importMetaUrl) {
  const hookDir = dirname(fileURLToPath(importMetaUrl));
  return resolve(hookDir, '..', '..');
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function respond(additionalContext) {
  if (additionalContext) {
    console.log(JSON.stringify({ additionalContext }));
  } else {
    console.log('{}');
  }
}
