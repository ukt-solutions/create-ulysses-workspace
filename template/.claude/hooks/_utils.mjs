import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
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

export function getSessionMarkers(root) {
  const scratchpad = join(root, '.claude-scratchpad');
  if (!existsSync(scratchpad)) return [];
  return readdirSync(scratchpad)
    .filter(f => f.startsWith('.work-session-') && f.endsWith('.json'))
    .map(f => {
      const data = readJSON(join(scratchpad, f));
      return data ? { ...data, _file: f } : null;
    })
    .filter(Boolean);
}

export function readSessionMarker(root, sessionName) {
  return readJSON(join(root, '.claude-scratchpad', `.work-session-${sessionName}.json`));
}

export function writeSessionMarker(root, sessionName, data) {
  const scratchpad = join(root, '.claude-scratchpad');
  if (!existsSync(scratchpad)) mkdirSync(scratchpad, { recursive: true });
  writeFileSync(
    join(scratchpad, `.work-session-${sessionName}.json`),
    JSON.stringify(data, null, 2) + '\n'
  );
}

export function deleteSessionMarker(root, sessionName) {
  const file = join(root, '.claude-scratchpad', `.work-session-${sessionName}.json`);
  if (existsSync(file)) unlinkSync(file);
}

export function getActiveSessionPointer(root) {
  return readJSON(join(root, '.claude-scratchpad', '.active-session.json'));
}

export function getMainRoot(root) {
  const pointer = getActiveSessionPointer(root);
  return pointer?.rootPath || root;
}

export function timeAgo(isoString) {
  if (!isoString) return 'unknown';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function getCurrentChatId(root) {
  const chatIdFile = join(root, '.claude-scratchpad', '.current-chat-id');
  try {
    return readFileSync(chatIdFile, 'utf-8').trim();
  } catch {
    return null;
  }
}
