#!/usr/bin/env node
// Unit tests for repo-write-detection.mjs.
// Run: node .claude/hooks/_repo-write-detection.test.mjs
//
// Two layers:
//  - the pure isTaskWorktreeWrite predicate (path arithmetic, incl.
//    symlinked workspaces and traversal attempts);
//  - spawn-level runs of the real hook, covering the entry guard through a
//    symlinked hook path (gh:132 round 2, N1) and the Bash carve-out's
//    judge-what-remains semantics (N2).
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdtempSync, mkdirSync, symlinkSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTaskWorktreeWrite } from './repo-write-detection.mjs';

let failed = 0;
let passed = 0;

function check(actual, expected, label, detail) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}\n    detail: ${detail}\n    expected: ${expected}, got: ${actual}`);
  }
}

// === Pure predicate ===
const root = '/w';

check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', '.claude', 'worktrees', 'feature-x', 'src', 'a.ts')), true, 'file inside a task worktree', 'deep file');
check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', '.claude', 'worktrees', 'feature-x')), true, 'the worktree directory itself', 'worktree root');
check(isTaskWorktreeWrite(root, join(root, 'repos', 'my-repo', '.claude', 'worktrees', 'bugfix-y', 'lib', 'b.js')), true, 'different repo name', 'second repo');

check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', 'src', 'a.ts')), false, 'write to the source clone', 'repos/app/src');
check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', '.claude', 'settings.json')), false, 'write to a repo .claude file', 'not under worktrees');
check(isTaskWorktreeWrite(root, join(root, 'repos', '.claude', 'worktrees', 'x', 'f')), false, 'missing repo segment', 'no repo between repos/ and .claude');
check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', '.claude', 'worktrees')), false, 'the worktrees dir itself', 'no slug segment');
check(isTaskWorktreeWrite(root, join(root, 'work-sessions', 'alpha', 'workspace', 'f.md')), false, 'session-model write', 'not a task path');
check(isTaskWorktreeWrite(root, join(root, 'workspace-context', 'notes.md')), false, 'context write', 'unrelated');
check(isTaskWorktreeWrite(root, join('/elsewhere', 'repos', 'app', '.claude', 'worktrees', 'x', 'f')), false, 'outside the given root', 'other tree');
check(isTaskWorktreeWrite(root, ''), false, 'empty path', 'empty');
check(isTaskWorktreeWrite(root, null), false, 'null path', 'null');
check(isTaskWorktreeWrite('', join(root, 'repos', 'app', '.claude', 'worktrees', 'x', 'f')), false, 'empty root', 'no root');

// Raw strings, not join(): join would normalize ".." away before the
// predicate's resolve() ever sees it, and the lexical normalization is
// exactly what must keep these out.
check(isTaskWorktreeWrite(root, '/w/repos/app/.claude/worktrees/x/../../../src/a.ts'), false, '.. climbs out of the worktree', 'traversal');
check(isTaskWorktreeWrite(root, '/w/repos/../secret.txt'), false, '.. right after repos', 'traversal at repos');

// A relative string is resolved against cwd before judging — during this
// test run cwd is not /w, so it must not blind-match.
check(isTaskWorktreeWrite(root, 'repos/app/.claude/worktrees/x/f'), false, 'relative path is resolved, not blind-matched', 'relative');

// === Spawn-level: the hook through a symlinked workspace (N1) ===
// The fixture copies .claude/ rather than symlinking it: a symlinked .claude
// would make getWorkspaceRoot() resolve to the template, not the fixture.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = resolve(HERE, '..');

function makeFixture() {
  const fx = mkdtempSync(join(tmpdir(), 'rwd-fx-'));
  // Leave machine-local state behind: copied from inside a session worktree,
  // .active-session.json would make the fixture look like a session and
  // route the hook down the session branch instead of the launcher checks.
  const LOCAL = new Set(['.active-session.json', 'settings.local.json']);
  cpSync(CLAUDE_DIR, join(fx, '.claude'), {
    recursive: true,
    filter: (src) => !LOCAL.has(basename(src)),
  });
  return fx;
}

function runHook(scriptPath, payload, cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    timeout: 30000,
  });
}

const WARN = "You're on main";
const fx = makeFixture();
try {
  const hook = join(fx, '.claude', 'hooks', 'repo-write-detection.mjs');
  const sourceEdit = { tool_name: 'Edit', tool_input: { file_path: join(fx, 'repos', 'app', 'src', 'x.ts') } };

  // Direct spawn: a source-clone Edit from the launcher must warn.
  const direct = runHook(hook, sourceEdit, fx);
  check(direct.status, 0, 'hook exits 0 (direct)', 'direct spawn');
  check(String(direct.stdout).includes(WARN), true, 'source-clone edit warns (direct)', 'direct spawn');

  // Symlinked spawn: import.meta.url realpaths through the link while
  // argv[1] keeps it — the entry guard must realpath both (N1).
  let link = null;
  try {
    const linkParent = mkdtempSync(join(tmpdir(), 'rwd-link-'));
    link = join(linkParent, 'ws-link');
    symlinkSync(fx, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (['EPERM', 'EACCES', 'EINVAL', 'ENOSYS'].includes(err.code)) {
      console.log('  (skip: symlink unavailable on this machine — direct spawn case above still ran)');
    } else {
      throw err;
    }
  }
  if (link) {
    const viaLink = runHook(join(link, '.claude', 'hooks', 'repo-write-detection.mjs'), sourceEdit, link);
    check(viaLink.status, 0, 'hook exits 0 (via symlink)', 'symlinked spawn');
    check(String(viaLink.stdout).includes(WARN), true, 'source-clone edit warns through a symlinked hook path', 'symlinked spawn — entry guard realpaths argv[1]');

    // N8: the predicate must agree across the symlinked and real roots.
    const wtDir = join(fx, 'repos', 'app', '.claude', 'worktrees', 'x');
    mkdirSync(wtDir, { recursive: true });
    check(isTaskWorktreeWrite(link, join(fx, 'repos', 'app', '.claude', 'worktrees', 'x', 'new.ts')), true, 'symlinked root, real worktree path', 'root through link');
    check(isTaskWorktreeWrite(fx, join(link, 'repos', 'app', '.claude', 'worktrees', 'x', 'new.ts')), true, 'real root, symlinked worktree path', 'file through link');
    check(isTaskWorktreeWrite(link, join(fx, 'repos', 'app', 'src', 'y.ts')), false, 'symlinked root still rejects the source clone', 'not a worktree');
  }

  // === Spawn-level: the Bash carve-out judges what remains (N2) ===
  mkdirSync(join(fx, 'repos', 'app', '.claude', 'worktrees', 'x'), { recursive: true });
  const wt = join(fx, 'repos', 'app', '.claude', 'worktrees', 'x');

  const mixed = runHook(hook, { tool_name: 'Bash', tool_input: { command: `rm -rf "${wt}/src" && rm -rf "${fx}/repos/app/src"` } }, fx);
  check(String(mixed.stdout).includes(WARN), true, 'worktree + source clone in one command warns', 'judged on the source-clone token');

  const cpOut = runHook(hook, { tool_name: 'Bash', tool_input: { command: `cp "${wt}/a" .claude/settings.json` } }, fx);
  check(String(cpOut.stdout).includes(WARN), true, 'copying out of a worktree into .claude warns', 'judged on the .claude token');

  const pure = runHook(hook, { tool_name: 'Bash', tool_input: { command: `rm -rf "${wt}/src"` } }, fx);
  check(String(pure.stdout).includes(WARN), false, 'a pure task-worktree command does not warn', 'nothing left to judge');

  const editInWt = runHook(hook, { tool_name: 'Edit', tool_input: { file_path: join(wt, 'src', 'a.ts') } }, fx);
  check(String(editInWt.stdout).includes(WARN), false, 'an Edit inside a worktree does not warn', 'single task path exempt');
} finally {
  rmSync(fx, { recursive: true, force: true });
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
