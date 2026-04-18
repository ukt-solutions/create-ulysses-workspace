#!/usr/bin/env node
// One-shot migrator: move session content from launcher-side paths into
// each session's workspace worktree, collapse the .gitignore exception
// block, bump templateVersion, and clean main. Idempotent per session.
//
// Exports:
//   migrateSession(root, sessionName) — per-session branch migration
//   migrateMain(root) — main-side gitignore + rm --cached + version bump
//
// CLI:
//   node migrate-session-layout.mjs --session-name NAME
//   node migrate-session-layout.mjs --all
//   node migrate-session-layout.mjs --main
//   node migrate-session-layout.mjs --all --main     (runs all sessions then main)
//   Optional: --root PATH to override auto-detection
import '../lib/require-node.mjs';
import { execSync } from 'child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
  statSync,
} from 'fs';
import { join } from 'path';
import {
  getWorkspaceRoot,
  getWorkspacePaths,
  getMainRoot,
  readJSON,
} from '../hooks/_utils.mjs';

export function migrateSession(root, sessionName) {
  const { workSessionsDir } = getWorkspacePaths(root);
  const sessionFolder = join(workSessionsDir, sessionName);
  const worktree = join(sessionFolder, 'workspace');

  if (!existsSync(worktree)) {
    return { status: 'no-worktree', sessionName };
  }

  const inWorktreeTracker = join(worktree, 'session.md');

  // Quick idempotency check: if the tracker is already in-worktree AND no
  // ghosts remain in the branch tree, we're done.
  if (existsSync(inWorktreeTracker) && listGhostsInBranch(worktree).length === 0) {
    return { status: 'already-migrated', sessionName };
  }

  // Copy launcher-side tracker into the worktree (skip if already there)
  const launcherTracker = join(sessionFolder, 'session.md');
  if (existsSync(launcherTracker) && !existsSync(inWorktreeTracker)) {
    copyFileSync(launcherTracker, inWorktreeTracker);
  }

  // Copy launcher-side specs and plans into the worktree (skip-if-exists)
  const copiedDocs = [];
  if (existsSync(sessionFolder)) {
    for (const entry of readdirSync(sessionFolder)) {
      if (entry === 'workspace') continue;
      if (!/^(design|plan)-.*\.md$/.test(entry)) continue;
      const src = join(sessionFolder, entry);
      if (!statSync(src).isFile()) continue;
      const dst = join(worktree, entry);
      if (!existsSync(dst)) {
        copyFileSync(src, dst);
        copiedDocs.push(entry);
      }
    }
  }

  // Stage new files at the top of the worktree
  const toAdd = [];
  if (existsSync(inWorktreeTracker)) toAdd.push('session.md');
  for (const entry of readdirSync(worktree)) {
    if (/^(design|plan)-.*\.md$/.test(entry)) toAdd.push(entry);
  }
  if (toAdd.length > 0) {
    execSync(`git add ${toAdd.map((f) => `"${f}"`).join(' ')}`, {
      cwd: worktree,
      stdio: 'pipe',
    });
  }

  // Remove cross-contamination ghosts that this branch inherited from main
  const ghosts = listGhostsInBranch(worktree);
  for (const ghost of ghosts) {
    execSync(`git rm "${ghost}"`, { cwd: worktree, stdio: 'pipe' });
  }

  // Only commit if there are staged changes
  const staged = execSync('git diff --cached --name-only', { cwd: worktree })
    .toString()
    .trim();
  if (staged.length === 0) {
    return { status: 'no-changes', sessionName };
  }
  execSync('git commit -m "chore: migrate session content into worktree"', {
    cwd: worktree,
    stdio: 'pipe',
  });
  return {
    status: 'migrated',
    sessionName,
    added: toAdd,
    removedGhosts: ghosts,
    copiedDocs,
  };
}

function listGhostsInBranch(worktree) {
  const out = execSync(
    'git ls-files "work-sessions/*/session.md" "work-sessions/*/design-*.md" "work-sessions/*/plan-*.md"',
    { cwd: worktree }
  ).toString();
  return out.split('\n').filter(Boolean);
}

/**
 * Collapse the "Work sessions" block in .gitignore to a single
 * `work-sessions/` line. Line-based to avoid regex brittleness against the
 * multi-line commented version that mentions `work-sessions/**` inline.
 */
function collapseGitignoreBlock(content) {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => /^# Work sessions\b/.test(l));
  if (startIdx === -1) {
    throw new Error('Work sessions block not found in .gitignore');
  }
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^!work-sessions\/\*\/plan-\*\.md\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error('End of work-sessions block (!…plan-*.md) not found in .gitignore');
  }
  const replacement = [
    '# Work sessions — the folder is local-only at the workspace root.',
    "# Session content (tracker, specs, plans) lives inside each session's",
    '# workspace worktree at the top of the session branch, not on main.',
    'work-sessions/',
  ];
  lines.splice(startIdx, endIdx - startIdx + 1, ...replacement);
  return lines.join('\n');
}

export function migrateMain(root) {
  // Collapse the .gitignore block
  const gitignorePath = join(root, '.gitignore');
  const current = readFileSync(gitignorePath, 'utf-8');
  const collapsed = collapseGitignoreBlock(current);
  if (collapsed === current) {
    throw new Error('Gitignore collapse produced no change');
  }
  writeFileSync(gitignorePath, collapsed);

  // git rm --cached every launcher-tracked tracker/spec/plan file
  const listed = execSync(
    'git ls-files "work-sessions/*/session.md" "work-sessions/*/design-*.md" "work-sessions/*/plan-*.md"',
    { cwd: root }
  )
    .toString()
    .split('\n')
    .filter(Boolean);
  for (const path of listed) {
    execSync(`git rm --cached "${path}"`, { cwd: root, stdio: 'pipe' });
  }

  // Bump templateVersion in workspace.json
  const wsPath = join(root, 'workspace.json');
  const ws = readJSON(wsPath);
  if (ws?.workspace) {
    ws.workspace.templateVersion = '0.9.0';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2) + '\n');
  }

  // Stage and commit
  execSync('git add .gitignore workspace.json', { cwd: root, stdio: 'pipe' });
  execSync(
    'git commit -m "chore: migrate workspace to in-worktree session layout"',
    { cwd: root, stdio: 'pipe' }
  );

  return { status: 'migrated', removed: listed };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };

  // The script lives in either the launcher's .claude/scripts/ or a session
  // worktree's .claude/scripts/. getWorkspaceRoot returns the script's
  // grandparent; when that's a worktree, promote it to the launcher via
  // the .active-session.json pointer.
  const inferred = getWorkspaceRoot(import.meta.url);
  const root = getArg('root') || getMainRoot(inferred);

  const runAll = args.includes('--all');
  const runMain = args.includes('--main');
  const name = getArg('session-name');

  const results = {};

  if (runAll) {
    const { workSessionsDir } = getWorkspacePaths(root);
    const perSession = [];
    if (existsSync(workSessionsDir)) {
      for (const entry of readdirSync(workSessionsDir)) {
        perSession.push(migrateSession(root, entry));
      }
    }
    results.sessions = perSession;
  } else if (name) {
    results.session = migrateSession(root, name);
  }

  if (runMain) {
    results.main = migrateMain(root);
  }

  if (!runAll && !runMain && !name) {
    console.error(
      'Usage: migrate-session-layout.mjs (--session-name NAME | --all) [--main] [--root PATH]'
    );
    process.exit(1);
  }

  console.log(JSON.stringify(results, null, 2));
}
