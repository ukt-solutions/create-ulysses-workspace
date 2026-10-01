#!/usr/bin/env node
// Write CLAUDE.local.md at the workspace root with the per-user import.
//
// CLAUDE.local.md is gitignored — it carries user-scoped context that
// shouldn't propagate across team members. The single source of identity
// is `.claude/settings.local.json` → `workspace.user`.
//
// Usage:
//   node generate-claude-local.mjs [--root <path>] [--force]
//
// Behavior:
//   - Reads workspace.user from .claude/settings.local.json
//   - Refuses to overwrite an existing CLAUDE.local.md unless --force
//   - Idempotent: same input → same content
//
// Exit codes:
//   0 — wrote (or would have written) the file
//   1 — error (missing settings, settings missing user, refusal to overwrite)

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--force') args.force = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

function readWorkspaceUser(root) {
  const settingsPath = join(root, '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) {
    throw new Error(`Missing ${settingsPath} — run /workspace-init first`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch (e) {
    throw new Error(`Could not parse ${settingsPath}: ${e.message}`);
  }
  const user = parsed?.workspace?.user;
  if (!user || typeof user !== 'string') {
    throw new Error(`workspace.user not set in ${settingsPath}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(user)) {
    throw new Error(`workspace.user "${user}" must be alphanumeric (with optional - or _)`);
  }
  return user;
}

function renderClaudeLocal(user) {
  return `## My Context
@workspace-context/team-member/${user}/index.md
`;
}

function generateClaudeLocal(root, { force = false } = {}) {
  const user = readWorkspaceUser(root);
  const target = join(root, 'CLAUDE.local.md');
  const content = renderClaudeLocal(user);

  if (existsSync(target) && !force) {
    const existing = readFileSync(target, 'utf-8');
    if (existing === content) {
      return { path: target, status: 'unchanged' };
    }
    throw new Error(
      `${target} already exists with different content. Re-run with --force to overwrite.`,
    );
  }

  writeFileSync(target, content);
  return { path: target, status: existsSync(target) ? 'written' : 'written' };
}

// The per-user index CLAUDE.local.md imports is generated, not tracked
// (gh:132) — so on a fresh clone it does not exist yet, and writing an
// importer for a missing file leaves a dangling @-import. Regenerate the
// workspace-context artifacts here, where the importer is created, rather
// than leaving the gap for /workspace-init to remember.
function ensurePerUserIndex(root) {
  const builder = join(root, '.claude', 'scripts', 'build-workspace-context.mjs');
  if (!existsSync(builder)) return { regenerated: false, reason: 'builder not present' };
  const r = spawnSync(process.execPath, [builder, '--write', '--root', root], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    return { regenerated: false, reason: (r.stderr || '').trim() || `exit ${r.status}` };
  }
  return { regenerated: true };
}

function main() {
  const args = parseArgs(process.argv);
  const root = resolve(args.root);
  const result = generateClaudeLocal(root, { force: args.force });
  const index = ensurePerUserIndex(root);
  process.stdout.write(JSON.stringify({ ...result, index }) + '\n');
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`generate-claude-local: ${err.message}\n`);
    process.exit(1);
  }
}

export { readWorkspaceUser, renderClaudeLocal, generateClaudeLocal, ensurePerUserIndex };
