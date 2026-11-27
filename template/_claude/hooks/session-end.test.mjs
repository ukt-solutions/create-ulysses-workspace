#!/usr/bin/env node
// Tests for session-end.mjs
// Run: node template/_claude/hooks/session-end.test.mjs
//
// Each case builds a real workspace in a temp directory (a workspace repo, a
// project repo with a bare origin, a copy of .claude/), builds a session's
// worktrees and tracker by hand (renaming its folder where a case needs a
// name no script ever accepted), points .claude/.active-session.json at it,
// and runs the hook as a subprocess with a SessionEnd payload on stdin.
// The pointer file is untrusted input: its session name becomes a path and a
// commit message. The cases below carry a shell payload that would create a
// file named PWNED and names that would escape work-sessions/; the hook must
// never run the payload, never touch a tracker outside work-sessions/, and
// never crash — a SessionEnd hook that throws breaks the user's session end.
//
// The fixture copies .claude/ rather than symlinking it: the hook derives
// the workspace root from import.meta.url, and a symlink would resolve it to
// the template's real path instead of the fixture.

import { execFileSync, spawnSync } from 'child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, mkdtempSync,
  readdirSync, realpathSync, renameSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`); }
}

// Hermetic git: a fixed identity and an empty global config, so the user's
// signing, hooks, or default-branch settings cannot change the outcome.
function gitEnv(base) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
}

function makeWorkspace() {
  // realpath: macOS tmpdir() is a /var → /private/var symlink, while the
  // hook's root comes from import.meta.url, which Node resolves.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'send-test-')));
  const ws = join(base, 'ws');
  const cwd = join(base, 'cwd');
  writeFileSync(join(base, 'gitconfig'), '');
  mkdirSync(ws);
  mkdirSync(cwd);
  const env = gitEnv(base);
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf-8', stdio: 'pipe' });

  git(ws, 'init', '-q', '-b', 'main');
  cpSync(CLAUDE_DIR, join(ws, '.claude'), { recursive: true });
  writeFileSync(join(ws, 'workspace.json'), JSON.stringify({
    workspace: { name: 'fixture', scratchpadDir: 'workspace-scratchpad', workSessionsDir: 'work-sessions' },
    repos: { app: { remote: 'none', branch: 'main' } },
  }, null, 2));
  writeFileSync(join(ws, '.gitignore'), '.claude\nrepos\nwork-sessions\nworkspace-scratchpad\n');
  writeFileSync(join(ws, 'README.md'), '# fixture\n');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');

  const origin = join(base, 'origins', 'app.git');
  const repo = join(ws, 'repos', 'app');
  mkdirSync(origin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');

  return { base, ws, cwd, env, git };
}

// A session as it exists on disk: one branch off main in every repo, the
// workspace worktree at work-sessions/{name}/workspace/ with the project
// worktree nested in its repos/, and a session.md committed on the branch.
function createSession(fx, name, branch) {
  const worktree = join(fx.ws, 'work-sessions', name, 'workspace');
  mkdirSync(join(fx.ws, 'work-sessions', name), { recursive: true });
  fx.git(fx.ws, 'branch', '--', branch, 'main');
  fx.git(fx.ws, 'worktree', 'add', '--', worktree, branch);
  mkdirSync(join(worktree, 'repos'), { recursive: true });
  fx.git(join(fx.ws, 'repos', 'app'), 'branch', '--', branch, 'origin/main');
  fx.git(join(fx.ws, 'repos', 'app'), 'worktree', 'add', '--', join(worktree, 'repos', 'app'), branch);
  const now = new Date().toISOString();
  writeFileSync(join(worktree, 'session.md'), [
    '---',
    'type: session-tracker',
    `name: ${name}`,
    'status: active',
    `branch: ${branch}`,
    `created: ${now}`,
    'user: u',
    'repos:',
    '  - app',
    'chatSessions: []',
    'author: u',
    `updated: ${now.slice(0, 10)}`,
    '---',
    '',
    `# Work Session: ${name}`,
    '',
    '## Progress',
    '',
    '(Updated as the session progresses)',
    '',
  ].join('\n'));
  fx.git(worktree, 'add', '--', 'session.md');
  fx.git(worktree, 'commit', '-q', '-m', `chore: initialize session tracker for ${name}`);
  return worktree;
}

// Run the hook with the active-session pointer naming `pointerName`.
function runHook(fx, pointerName) {
  writeFileSync(join(fx.ws, '.claude', '.active-session.json'),
    JSON.stringify({ name: pointerName, rootPath: fx.ws }));
  const r = spawnSync(process.execPath, [join(fx.ws, '.claude', 'hooks', 'session-end.mjs')], {
    cwd: fx.cwd, env: fx.env, encoding: 'utf-8',
    input: JSON.stringify({ session_id: 's1', reason: 'test' }),
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

// Every entry under dir (outside .git) named PWNED*: a payload that ran.
function findPwned(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      if (/^PWNED/.test(e.name)) hits.push(join(d, e.name));
      if (e.isDirectory()) walk(join(d, e.name));
    }
  };
  walk(dir);
  return hits;
}

function withFixture(fn) {
  const fx = makeWorkspace();
  try { fn(fx); }
  finally { try { rmSync(fx.base, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}

// === A valid session: the safety capture is committed on the session branch ===
withFixture((fx) => {
  const wt = createSession(fx, 'demo', 'feature/demo');
  const r = runHook(fx, 'demo');
  assertEq(r.status, 0, `valid session exits 0 (stderr: ${r.stderr.trim().slice(0, 200)})`);
  assertEq(r.stdout, '{}', 'valid session responds with {}');
  assertEq(fx.git(wt, 'log', '-1', '--format=%s').trim(), 'chore: session-end safety capture for demo',
    'safety capture committed');
  assert(/### Session ended/.test(readFileSync(join(wt, 'session.md'), 'utf-8')), 'tracker body gains the safety note');
  assertEq(r.stderr.trim(), '', 'valid session writes nothing to stderr');
});

// === An existing session with a shell-metacharacter name stays literal ===
// No script accepts such a name now, but a session created before that rule
// can still carry one, and the hook must finish it safely. Build it the way
// it would exist: create a session, then move its folder to the old name and
// let git repair the worktree links.
withFixture((fx) => {
  const name = 'a$(touch PWNED)';
  createSession(fx, 'legacy', 'feature/dollar');
  renameSync(join(fx.ws, 'work-sessions', 'legacy'), join(fx.ws, 'work-sessions', name));
  const wt = join(fx.ws, 'work-sessions', name, 'workspace');
  fx.git(fx.ws, 'worktree', 'repair', wt);
  fx.git(join(fx.ws, 'repos', 'app'), 'worktree', 'repair', join(wt, 'repos', 'app'));
  const r = runHook(fx, name);
  assertEq(r.status, 0, 'metacharacter name exits 0');
  assertEq(fx.git(wt, 'log', '-1', '--format=%s').trim(), `chore: session-end safety capture for ${name}`,
    'commit message carries the session name literally');
  assertEq(findPwned(fx.base), [], 'metacharacter name: no payload ran');
});

// === An invalid name in the pointer skips the capture and never crashes ===
for (const name of ['../escape', 'a/b', 'a\\b', '.hidden', '', 42, null]) {
  withFixture((fx) => {
    const wt = createSession(fx, 'demo', 'feature/demo');
    // A tracker planted where the invalid name would resolve, so a hook that
    // follows the name reads, appends to and commits it.
    const planted = typeof name === 'string' && name !== ''
      ? join(fx.ws, 'work-sessions', name, 'workspace', 'session.md')
      : null;
    let before = null;
    if (planted) {
      mkdirSync(dirname(planted), { recursive: true });
      writeFileSync(planted, readFileSync(join(wt, 'session.md'), 'utf-8'));
      before = readFileSync(planted, 'utf-8');
    }
    const mainHead = fx.git(fx.ws, 'rev-parse', 'HEAD').trim();
    const sessionHead = fx.git(wt, 'rev-parse', 'HEAD').trim();

    const label = `pointer name ${JSON.stringify(name)}`;
    const r = runHook(fx, name);
    assertEq(r.status, 0, `${label}: hook exits 0`);
    assertEq(r.stdout, '{}', `${label}: hook still responds with {}`);
    assert(/invalid session name/i.test(r.stderr), `${label}: stderr says why the capture was skipped (stderr: ${r.stderr.trim().slice(0, 200)})`);
    if (planted) assertEq(readFileSync(planted, 'utf-8'), before, `${label}: the tracker the name pointed at is untouched`);
    assertEq(fx.git(fx.ws, 'rev-parse', 'HEAD').trim(), mainHead, `${label}: main gained no commit`);
    assertEq(fx.git(wt, 'rev-parse', 'HEAD').trim(), sessionHead, `${label}: the real session gained no commit`);
    assert(existsSync(join(fx.ws, 'workspace-scratchpad', 'session-log.jsonl')), `${label}: the session log is still written`);
    assertEq(findPwned(fx.base), [], `${label}: no payload ran`);
  });
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
