#!/usr/bin/env node
// SessionStart hook — sync workspace, surface active context
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { execSync } from 'child_process';
import { getWorkspaceRoot, readJSON, respond } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(join(root, 'workspace.json'));
const contextDir = join(root, 'shared-context');
const reposDir = join(root, 'repos');
const lines = [];

if (!config) {
  respond('No workspace.json found. Run /setup to initialize this workspace.');
  process.exit(0);
}

lines.push(`Workspace: ${config.workspace?.name || 'unnamed'}`);

// Check repos status
const repoNames = Object.keys(config.repos || {});
const missing = [];
const existing = [];

for (const name of repoNames) {
  const repoPath = join(reposDir, name);
  if (existsSync(repoPath)) {
    existing.push(name);
    try {
      execSync('git fetch --quiet', { cwd: repoPath, stdio: 'pipe', timeout: 10000 });
    } catch {}
  } else {
    missing.push(name);
  }
}

if (missing.length > 0) lines.push(`Missing repos: ${missing.join(', ')}. Run /setup to clone them.`);
if (existing.length > 0) lines.push(`Repos synced: ${existing.join(', ')}`);

// Surface active shared-context entries
if (existsSync(contextDir)) {
  const entries = [];

  function scanDir(dir, depth = 0) {
    if (depth > 3) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === 'locked' || entry === '.keep') continue;
        scanDir(fullPath, depth + 1);
      } else if (entry.endsWith('.md') && entry !== '.keep' && !entry.startsWith('local-only-')) {
        const relPath = relative(contextDir, fullPath);
        if (relPath.startsWith('locked/')) continue;

        const content = readFileSync(fullPath, 'utf-8');
        const topicMatch = content.match(/^topic:\s*(.+)$/m);
        const lifecycleMatch = content.match(/^lifecycle:\s*(.+)$/m);
        const topic = topicMatch ? topicMatch[1].trim() : basename(entry, '.md');
        const lifecycle = lifecycleMatch ? lifecycleMatch[1].trim() : 'active';
        const mtime = stat.mtime.toISOString().slice(0, 16).replace('T', ' ');

        entries.push(`- ${topic} (${lifecycle}, updated ${mtime}) — ${relPath}`);
      }
    }
  }

  scanDir(contextDir);

  if (entries.length > 0) {
    lines.push('');
    lines.push('Active shared context:');
    lines.push(...entries);
    lines.push('');
    lines.push('Use /start-work handoff to resume, or /start-work blank for new work.');
  }
}

respond(lines.join('\n'));
