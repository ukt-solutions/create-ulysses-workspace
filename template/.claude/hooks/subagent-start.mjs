#!/usr/bin/env node
// SubagentStart hook — inject workspace-context/shared/locked/ into subagent context
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { getWorkspaceRoot, readJSON, respond } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(join(root, 'workspace.json'));
const lockedDir = join(root, 'workspace-context', 'shared', 'locked');

const maxBytes = config?.workspace?.subagentContextMaxBytes || 10240;

if (!existsSync(lockedDir)) {
  respond();
  process.exit(0);
}

const files = readdirSync(lockedDir)
  .filter(f => f.endsWith('.md') && f !== '.keep')
  .sort();

if (files.length === 0) {
  respond();
  process.exit(0);
}

let context = '';
for (const file of files) {
  const name = basename(file, '.md');
  const content = readFileSync(join(lockedDir, file), 'utf-8');
  context += `\n--- ${name} ---\n${content}\n`;
}

if (Buffer.byteLength(context) > maxBytes) {
  const summary = files.map(f => {
    const content = readFileSync(join(lockedDir, f), 'utf-8');
    const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('---'))?.replace(/^#*\s*/, '') || '';
    return `- ${basename(f, '.md')}: ${firstLine}`;
  }).join('\n');

  context = `[Locked shared context exceeds ${maxBytes} byte limit (${Buffer.byteLength(context)} bytes). Summary of ${files.length} files:]\n${summary}\n[Read individual files from workspace-context/shared/locked/ if you need full content.]`;
}

respond(context);