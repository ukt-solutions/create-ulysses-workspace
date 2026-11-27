#!/usr/bin/env node
// Unit tests for repo-write-detection.mjs.
// Run: node .claude/hooks/_repo-write-detection.test.mjs
//
// Three layers:
//  - the pure isTaskWorktreeWrite predicate (path arithmetic, incl.
//    symlinked workspaces and traversal attempts);
//  - spawn-level runs of the real hook, covering the entry guard through a
//    symlinked hook path (gh:132 round 2, N1) and the Bash carve-out's
//    judge-what-remains semantics (N2);
//  - a chat opened inside a leftover session worktree: the launcher is
//    found from the filesystem, and the warning carries one line pointing
//    at /migrate-sessions.
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTaskWorktreeWrite, leftoverSessionLauncher } from './repo-write-detection.mjs';

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
check(isTaskWorktreeWrite(root, join(root, 'work-sessions', 'alpha', 'workspace', 'f.md')), false, 'a path under a leftover work-sessions folder', 'not a task path');
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

// The workspace repo's own task worktrees: {root}/.claude/worktrees/{slug}/
// (gh:146) — same carve-out as project worktrees, one level up.
check(isTaskWorktreeWrite(root, join(root, '.claude', 'worktrees', 'feature-x', 'src', 'a.ts')), true, 'file inside a workspace task worktree', 'deep file');
check(isTaskWorktreeWrite(root, join(root, '.claude', 'worktrees', 'feature-x')), true, 'the workspace worktree directory itself', 'worktree root');
check(isTaskWorktreeWrite(root, join(root, '.claude', 'worktrees')), false, 'the workspace worktrees dir itself', 'no slug segment');
check(isTaskWorktreeWrite(root, join(root, '.claude')), false, '.claude itself', 'not inside a worktree');
check(isTaskWorktreeWrite(root, join(root, '.claude', 'rules', 'x.md')), false, 'a .claude path outside worktrees', 'rules file');
check(isTaskWorktreeWrite(root, join(root, '.claude', 'hooks', 'hook.mjs')), false, 'a hook file still warnable', 'hooks dir');
check(isTaskWorktreeWrite(root, root), false, 'the root itself', 'root');
check(isTaskWorktreeWrite(root, '/w/.claude/worktrees/x/../../../secret.txt'), false, '.. climbs out of the workspace worktree', 'traversal');

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
  // Leave machine-local state behind: settings.local.json names this
  // machine's user, which the fixture has none of.
  cpSync(CLAUDE_DIR, join(fx, '.claude'), {
    recursive: true,
    filter: (src) => basename(src) !== 'settings.local.json',
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

  // === Spawn-level: the workspace repo's own task worktrees (gh:146) ===
  const wsWt = join(fx, '.claude', 'worktrees', 'ws-task');
  mkdirSync(wsWt, { recursive: true });

  const wsEdit = runHook(hook, { tool_name: 'Edit', tool_input: { file_path: join(wsWt, 'README.md') } }, fx);
  check(String(wsEdit.stdout).includes(WARN), false, 'an Edit inside a workspace task worktree does not warn', 'single workspace task path exempt');

  const rulesEdit = runHook(hook, { tool_name: 'Edit', tool_input: { file_path: join(fx, '.claude', 'rules', 'x.md') } }, fx);
  check(String(rulesEdit.stdout).includes(WARN), true, 'an Edit to a .claude/rules file still warns', 'not under worktrees');

  const wsMixed = runHook(hook, { tool_name: 'Bash', tool_input: { command: `rm -rf "${wsWt}/src" && rm -rf "${fx}/.claude/rules/x.md"` } }, fx);
  check(String(wsMixed.stdout).includes(WARN), true, 'workspace worktree + .claude path in one command warns', 'judged on the .claude token');
} finally {
  rmSync(fx, { recursive: true, force: true });
}

// === A chat opened inside a leftover session worktree ===
// The session lifecycle of earlier template versions kept each session as a
// worktree inside the launcher's sessions directory. No skill resumes or
// completes one now, and nothing in such a worktree detects as a task, so
// the hook's warning carries one line saying where the checkout should go:
// /migrate-sessions, run from the launcher.
const fx2 = makeFixture();
try {
  const writeConfig = (dir, workspace) => writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ workspace, repos: {} }));
  writeConfig(fx2, { name: 'fixture', scratchpadDir: 'workspace-scratchpad' });
  const launcher = resolve(fx2);
  const sessionWt = join(fx2, 'work-sessions', 'alpha', 'workspace');
  // A worktree checks out the launcher's tracked files, so it carries its
  // own copy of .claude/ and of workspace.json.
  cpSync(join(fx2, '.claude'), join(sessionWt, '.claude'), { recursive: true });
  writeConfig(sessionWt, { name: 'fixture', scratchpadDir: 'workspace-scratchpad' });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // --- the launcher, from the filesystem alone ---
  check(same(leftoverSessionLauncher(sessionWt), { launcher, sessionsDir: join(launcher, 'work-sessions') }), true,
    'the launcher is found for a session worktree', `got ${JSON.stringify(leftoverSessionLauncher(sessionWt))}`);
  check(same(leftoverSessionLauncher(join(sessionWt, 'repos', 'app', 'src')), { launcher, sessionsDir: join(launcher, 'work-sessions') }), true,
    'and from deep inside one', 'a directory below the worktree root');
  check(leftoverSessionLauncher(fx2), null, 'the launcher itself is not inside its sessions directory', 'the sessions directory does not contain itself');
  const taskWt = join(fx2, '.claude', 'worktrees', 'ws-task');
  mkdirSync(taskWt, { recursive: true });
  check(leftoverSessionLauncher(taskWt), null, 'a task worktree of the workspace repo is not a session worktree', '.claude/worktrees/{slug}');
  check(leftoverSessionLauncher(join(fx2, 'elsewhere', 'nested')), null, 'an unrelated directory is not one either', 'the workspace.json above it names a sessions directory that does not contain it');

  // A configured sessions directory is the one that counts.
  writeConfig(fx2, { name: 'fixture', scratchpadDir: 'workspace-scratchpad', workSessionsDir: 'old-sessions' });
  const customWt = join(fx2, 'old-sessions', 'beta', 'workspace');
  mkdirSync(customWt, { recursive: true });
  check(same(leftoverSessionLauncher(customWt), { launcher, sessionsDir: join(launcher, 'old-sessions') }), true,
    'a custom workSessionsDir is honoured', 'workspace.workSessionsDir names the directory');
  check(leftoverSessionLauncher(sessionWt), null, 'and the default name no longer counts for it', 'work-sessions/ is ignored when unconfigured');
  writeConfig(fx2, { name: 'fixture', scratchpadDir: 'workspace-scratchpad' });

  // --- the real hook, run from each kind of checkout ---
  const sessionHook = join(sessionWt, '.claude', 'hooks', 'repo-write-detection.mjs');
  const taskHook = join(taskWt, '.claude', 'hooks', 'repo-write-detection.mjs');
  cpSync(CLAUDE_DIR, join(taskWt, '.claude'), { recursive: true }); // from the template: a folder cannot be copied into itself
  writeConfig(taskWt, { name: 'fixture', scratchpadDir: 'workspace-scratchpad' });
  const launcherHook = join(fx2, '.claude', 'hooks', 'repo-write-detection.mjs');
  // The hook answers with JSON; the warning is its additionalContext, a
  // string of lines.
  const contextOf = (r) => { try { return JSON.parse(r.stdout).additionalContext || ''; } catch { return ''; } };
  const pointerLines = (r) => contextOf(r).split('\n').filter((l) => l.includes('/migrate-sessions'));
  const stillWarns = (r) => contextOf(r).includes(WARN);
  const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path } });

  const inSession = runHook(sessionHook, edit(join(sessionWt, 'repos', 'app', 'src', 'a.ts')), sessionWt);
  check(inSession.status, 0, 'the hook exits 0 from inside a leftover session worktree', 'a hook that throws breaks the tool call');
  check(stillWarns(inSession), true, 'an Edit into the session\'s project worktree still warns', 'work belongs in a task worktree');
  check(pointerLines(inSession).length, 1, 'and the warning carries exactly one line pointing at /migrate-sessions', `got ${JSON.stringify(inSession.stdout)}`);
  check(pointerLines(inSession)[0]?.endsWith(realpathSync(launcher)), true, 'which names the launcher to run it from', `line: ${pointerLines(inSession)[0]}`);
  check(/inside work-sessions\/\./.test(contextOf(inSession)), true, 'and the sessions directory the checkout sits in', 'the default name');

  const inTask = runHook(taskHook, edit(join(taskWt, 'repos', 'app', 'src', 'a.ts')), taskWt);
  check(stillWarns(inTask) && pointerLines(inTask).length === 0, true, 'from a task worktree the warning has no such line', 'a task worktree is not inside the sessions directory');

  const atLauncher = runHook(launcherHook, edit(join(fx2, 'repos', 'app', 'src', 'a.ts')), fx2);
  check(stillWarns(atLauncher) && pointerLines(atLauncher).length === 0, true, 'nor from the launcher', 'the launcher is where /migrate-sessions runs from');

  const quiet = runHook(sessionHook, { tool_name: 'Write', tool_input: { file_path: join(sessionWt, 'workspace-scratchpad', 'note.md') } }, sessionWt);
  check(quiet.status === 0 && pointerLines(quiet).length === 0 && !stillWarns(quiet), true,
    'with no warning due, nothing is said', 'the line rides on the warning and is not one by itself');

  writeConfig(fx2, { name: 'fixture', scratchpadDir: 'workspace-scratchpad', workSessionsDir: 'old-sessions' });
  cpSync(join(fx2, '.claude'), join(customWt, '.claude'), { recursive: true });
  const inCustom = runHook(join(customWt, '.claude', 'hooks', 'repo-write-detection.mjs'), edit(join(customWt, 'repos', 'app', 'src', 'a.ts')), customWt);
  check(pointerLines(inCustom).length === 1 && /inside old-sessions\/\./.test(contextOf(inCustom)), true,
    'a custom workSessionsDir is named in the line', `got ${JSON.stringify(inCustom.stdout)}`);
} finally {
  rmSync(fx2, { recursive: true, force: true });
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
