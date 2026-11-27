#!/usr/bin/env node
// Tests for session-end.mjs
// Run: node template/_claude/hooks/session-end.test.mjs
//
// The hook has one job: append a line to the workspace session log. Each case
// builds a real workspace in a temp directory (a workspace repo and a copy of
// .claude/) and runs the hook as a subprocess with a SessionEnd payload on
// stdin. A SessionEnd hook that throws breaks the user's session end, so the
// line must be written whatever the hook is given — and nothing else may be
// written: the cases snapshot the workspace around the run.
//
// The fixture copies .claude/ rather than symlinking it: the hook derives
// the workspace root from import.meta.url, and a symlink would resolve it to
// the template's real path instead of the fixture.

import { execFileSync, spawnSync } from 'child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, mkdtempSync,
  realpathSync, readdirSync, statSync,
} from 'fs';
import { join, dirname, resolve, relative } from 'path';
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

// A workspace on branch main with .claude/ installed and one commit.
// workspace is written as the file's `workspace` object; withUser adds a
// settings.local.json naming the machine's user.
function makeWorkspace({ workspace = { name: 'fixture' }, withUser = true } = {}) {
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
  if (withUser) {
    writeFileSync(join(ws, '.claude', 'settings.local.json'), JSON.stringify({ workspace: { user: 'alice' } }, null, 2));
  }
  writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ workspace, repos: {} }, null, 2));
  // The scratchpad is ignored, so the log the hook writes never shows up as
  // a change to the tracked tree.
  writeFileSync(join(ws, '.gitignore'), '.claude/settings.local.json\nworkspace-scratchpad/\nscratch-custom/\n');
  writeFileSync(join(ws, 'README.md'), '# fixture\n');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
  return { base, ws, cwd, env, git };
}

function runHook(fx, payload) {
  const input = payload === undefined ? '' : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [join(fx.ws, '.claude', 'hooks', 'session-end.mjs')], {
    cwd: fx.cwd, env: fx.env, encoding: 'utf-8', input,
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

function readLog(fx, dir = 'workspace-scratchpad') {
  const path = join(fx.ws, dir, 'session-log.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// Every file under the workspace, outside .git and the scratchpads, with its
// bytes — what "the hook writes nothing but the log" is checked against.
function snapshot(fx) {
  const out = {};
  const skip = new Set(['workspace-scratchpad', 'scratch-custom']);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(fx.ws, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(fx.ws);
  return out;
}

function withFixture(opts, fn) {
  const fx = makeWorkspace(opts);
  try { fn(fx); }
  finally { try { rmSync(fx.base, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}

// === One end is one line, carrying what the hook was given ===
withFixture({}, (fx) => {
  const head = fx.git(fx.ws, 'rev-parse', 'HEAD').trim();
  const before = snapshot(fx);
  const r = runHook(fx, { session_id: 's1', reason: 'exit' });
  assertEq(r.status, 0, `the hook exits 0 (stderr: ${r.stderr.trim().slice(0, 200)})`);
  assertEq(r.stdout, '{}', 'it responds with {}');
  assertEq(r.stderr.trim(), '', 'and writes nothing to stderr');

  const log = readLog(fx);
  assertEq(log.length, 1, 'one end appends exactly one line');
  const entry = log[0];
  assertEq(entry.event, 'session_end', 'the line is a session_end event');
  assertEq(entry.reason, 'exit', "the payload's reason is recorded");
  assertEq(entry.session_id, 's1', "the payload's session id is recorded");
  assertEq(entry.user, 'alice', 'the user comes from .claude/settings.local.json');
  assertEq(entry.workspace_branch, 'main', 'the branch is the one the workspace repo is on');
  assert(!Number.isNaN(Date.parse(entry.date)), 'the date is an ISO timestamp');
  assertEq(Object.keys(entry).sort(), ['date', 'event', 'reason', 'session_id', 'user', 'workspace_branch'],
    'the line carries exactly these fields');

  assertEq(snapshot(fx), before, 'the hook writes nothing but the log');
  assertEq(fx.git(fx.ws, 'rev-parse', 'HEAD').trim(), head, 'no commit is made');
  assertEq(fx.git(fx.ws, 'status', '--porcelain').trim(), '', 'the tracked tree stays clean');
});

// === Each end is its own line, in order ===
withFixture({}, (fx) => {
  runHook(fx, { session_id: 's1', reason: 'exit' });
  const r = runHook(fx, { session_id: 's2', reason: 'other' });
  assertEq(r.status, 0, 'a second end exits 0');
  assertEq(readLog(fx).map((e) => [e.session_id, e.reason]), [['s1', 'exit'], ['s2', 'other']],
    'the second end appends after the first instead of replacing it');
});

// === What the hook is not given falls back to a default; nothing throws ===
withFixture({ withUser: false }, (fx) => {
  // No reason and no session id in the payload, and no user on this machine.
  const bare = runHook(fx, {});
  assertEq(bare.status, 0, 'a payload with no fields exits 0');
  const entry = readLog(fx)[0];
  assertEq(entry.reason, 'unknown', 'a missing reason is "unknown"');
  assertEq(entry.session_id, null, 'a missing session id is null');
  assertEq(entry.user, 'unknown', 'with no settings.local.json the user is "unknown"');

  // Stdin that is not JSON at all.
  const garbage = runHook(fx, undefined);
  assertEq([garbage.status, garbage.stdout], [0, '{}'], 'empty stdin still ends the chat cleanly');
  assertEq(readLog(fx).length, 2, 'and still appends a line');
  assertEq(readLog(fx)[1].reason, 'unknown', 'with the default reason');
});

// === A workspace that is not a git repository still gets its line ===
withFixture({}, (fx) => {
  rmSync(join(fx.ws, '.git'), { recursive: true, force: true });
  const r = runHook(fx, { session_id: 's1', reason: 'exit' });
  assertEq(r.status, 0, `the hook exits 0 outside a repository (stderr: ${r.stderr.trim().slice(0, 200)})`);
  assertEq(readLog(fx)[0]?.workspace_branch, 'unknown', 'with no branch to read, the field is "unknown"');
});

// === A detached HEAD ends the chat cleanly too ===
withFixture({}, (fx) => {
  fx.git(fx.ws, 'checkout', '-q', '--detach');
  const r = runHook(fx, { session_id: 's1', reason: 'exit' });
  assertEq(r.status, 0, 'the hook exits 0 on a detached HEAD');
  assertEq(readLog(fx).length, 1, 'and writes its line');
});

// === The log lands in the configured scratchpad ===
withFixture({ workspace: { name: 'fixture', scratchpadDir: 'scratch-custom' } }, (fx) => {
  // An older workspace.json still carries the keys of the session lifecycle;
  // they change nothing here.
  writeFileSync(join(fx.ws, 'workspace.json'), JSON.stringify({
    workspace: { name: 'fixture', scratchpadDir: 'scratch-custom', workSessionsDir: 'work-sessions', sessionModel: 'session' },
    repos: {},
  }, null, 2));
  const r = runHook(fx, { session_id: 's1', reason: 'exit' });
  assertEq(r.status, 0, 'the hook exits 0 with a custom scratchpad directory');
  assertEq(readLog(fx, 'scratch-custom').length, 1, 'the log is written under the configured scratchpadDir');
  assert(!existsSync(join(fx.ws, 'workspace-scratchpad')), 'and not under the default name');
  assert(statSync(join(fx.ws, 'scratch-custom')).isDirectory(), 'the directory is created when it is missing');
});

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
