#!/usr/bin/env node
// Tests for create-work-session.mjs
// Run: node template/_claude/scripts/create-work-session.test.mjs
//
// Each case builds a real workspace in a temp directory — a workspace repo
// on main, a project repo with a bare origin, and a copy of .claude/ — and
// runs the script as a subprocess. Branch names, session names, repo names
// and workspace.json values are untrusted input: the malicious cases carry
// shell payloads that would create a file named PWNED, and every case
// asserts that no such file exists anywhere under the temp directory. The
// subprocess runs with its cwd inside that directory, so a stray execution
// would land where the assertions look.
//
// The fixture copies .claude/ rather than symlinking it: the script derives
// the workspace root from import.meta.url, and a symlink would resolve it to
// the template's real path instead of the fixture.

import { execFileSync, spawnSync } from 'child_process';
import {
  mkdirSync, writeFileSync, existsSync, rmSync, cpSync, mkdtempSync,
  readdirSync, realpathSync,
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

function makeWorkspace(repoNames = ['app']) {
  // realpath: macOS tmpdir() is a /var → /private/var symlink, while the
  // script's root comes from import.meta.url, which Node resolves.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cws-test-')));
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
    repos: Object.fromEntries(repoNames.map((n) => [n, { remote: 'none', branch: 'main' }])),
  }, null, 2));
  writeFileSync(join(ws, '.gitignore'), '.claude\nrepos\nwork-sessions\n');
  writeFileSync(join(ws, 'README.md'), '# fixture\n');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');

  for (const name of repoNames) {
    const origin = join(base, 'origins', `${name}.git`);
    const repo = join(ws, 'repos', name);
    mkdirSync(origin, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
  }
  return { base, ws, cwd, env, git };
}

// Run a script from the fixture's .claude/scripts/ with cwd inside the temp
// directory. The scripts print one JSON line on stdout.
function runScript(fx, script, args) {
  const r = spawnSync(process.execPath, [join(fx.ws, '.claude', 'scripts', script), ...args], {
    cwd: fx.cwd, env: fx.env, encoding: 'utf-8',
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()); } catch {}
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function create(fx, overrides = {}) {
  const a = { 'session-name': 'demo', branch: 'feature/demo', repo: 'app', user: 'u', ...overrides };
  return runScript(fx, 'create-work-session.mjs', Object.entries(a).flatMap(([k, v]) => [`--${k}`, v]));
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

const branches = (fx, dir) =>
  fx.git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
const worktrees = (fx, dir) =>
  fx.git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));

// The state after a rejected run: no side effect anywhere.
function assertUntouched(fx, label) {
  assertEq(findPwned(fx.base), [], `${label}: no payload ran`);
  assertEq(branches(fx, fx.ws), ['main'], `${label}: no workspace branch created`);
  assertEq(branches(fx, join(fx.ws, 'repos', 'app')), ['main'], `${label}: no project branch created`);
  assertEq(worktrees(fx, fx.ws).length, 1, `${label}: no workspace worktree created`);
  assert(!existsSync(join(fx.ws, 'work-sessions')), `${label}: no work-sessions/ folder created`);
}

function withFixture(fn, repoNames) {
  const fx = makeWorkspace(repoNames);
  try { fn(fx); }
  finally { try { rmSync(fx.base, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}

// === Happy path ===
withFixture((fx) => {
  const r = create(fx);
  assertEq(r.status, 0, `happy path exits 0 (stderr: ${r.stderr.trim().slice(0, 200)})`);
  assertEq(r.json?.success, true, 'happy path reports success');
  const wt = join(fx.ws, 'work-sessions', 'demo', 'workspace');
  assert(existsSync(join(wt, 'session.md')), 'session tracker written in the workspace worktree');
  assert(existsSync(join(wt, 'repos', 'app', '.git')), 'project worktree nested in the workspace worktree');
  assertEq(fx.git(wt, 'log', '-1', '--format=%s').trim(), 'chore: initialize session tracker for demo',
    'tracker committed with the init message');
  assertEq(fx.git(wt, 'ls-files', '--', 'session.md').trim(), 'session.md', 'session.md is tracked on the branch');
  assert(branches(fx, fx.ws).includes('feature/demo'), 'workspace branch created');
  assert(branches(fx, join(fx.ws, 'repos', 'app')).includes('feature/demo'), 'project branch created');
  assertEq(findPwned(fx.base), [], 'happy path: no payload ran');
});

// === Malicious branch: shell payload ===
withFixture((fx) => {
  const r = create(fx, { branch: 'x"; touch PWNED; "' });
  assert(r.status !== 0, 'payload branch exits non-zero');
  assertEq(r.json?.success, false, 'payload branch reports success:false');
  assertUntouched(fx, 'payload branch');
});

// === Malicious branch: option injection and ref expansion ===
withFixture((fx) => {
  const r = create(fx, { branch: '-fx' });
  assertEq(r.json?.success, false, 'branch starting with - is rejected');
  assertUntouched(fx, 'dash branch');
});

withFixture((fx) => {
  // `git check-ref-format --branch` expands @{-1} to the previous branch
  // name; the validator must not accept a name git rewrites.
  fx.git(fx.ws, 'checkout', '-q', '-b', 'other');
  fx.git(fx.ws, 'checkout', '-q', 'main');
  const r = create(fx, { branch: '@{-1}' });
  assertEq(r.json?.success, false, '@{-1} branch is rejected');
  assert(!existsSync(join(fx.ws, 'work-sessions')), '@{-1} branch: no work-sessions/ folder created');
  assertEq(findPwned(fx.base), [], '@{-1} branch: no payload ran');
});

// === Session names ===
// Separators, a leading dot or dash, shell syntax, spaces, non-ASCII and
// over-long names are all refused before anything is created.
for (const name of ['../escape', 'a/b', 'a\\b', '.hidden', '-x', 'a$(touch PWNED)', 'a`touch PWNED`', 'a;b', 'a b', "a'b", 'héllo', 'x'.repeat(65)]) {
  withFixture((fx) => {
    const r = create(fx, { 'session-name': name });
    assert(r.status !== 0, `session name ${JSON.stringify(name)} exits non-zero`);
    assertEq(r.json?.success, false, `session name ${JSON.stringify(name)} reports success:false`);
    assert(!existsSync(join(fx.ws, 'escape')), `session name ${JSON.stringify(name)}: nothing created outside work-sessions/`);
    assertEq(findPwned(fx.base), [], `session name ${JSON.stringify(name)}: no payload ran`);
    assertUntouched(fx, `session name ${JSON.stringify(name)}`);
  });
}

// Ordinary names, including the longest allowed, are accepted.
for (const [name, branch] of [['fix-auth', 'feature/fix-auth'], ['v0.25_rc.1', 'feature/rc'], ['A'.repeat(64), 'feature/long']]) {
  withFixture((fx) => {
    const r = create(fx, { 'session-name': name, branch });
    assertEq(r.json?.success, true, `session name ${JSON.stringify(name)} succeeds (error: ${r.json?.error})`);
    assert(existsSync(join(fx.ws, 'work-sessions', name, 'workspace')), `session name ${JSON.stringify(name)}: worktree created`);
  });
}

// === Malicious repo entries ===
for (const repo of ['../app', 'a/b', 'app,../app']) {
  withFixture((fx) => {
    const r = create(fx, { repo });
    assertEq(r.json?.success, false, `--repo ${JSON.stringify(repo)} reports success:false`);
    assertUntouched(fx, `--repo ${JSON.stringify(repo)}`);
  });
}

// === Malicious workspace.json repo branch ===
withFixture((fx) => {
  writeFileSync(join(fx.ws, 'workspace.json'), JSON.stringify({
    workspace: { name: 'fixture', workSessionsDir: 'work-sessions' },
    repos: { app: { remote: 'none', branch: 'main"; touch PWNED; "' } },
  }, null, 2));
  const r = create(fx);
  assert(r.status !== 0, 'payload repo branch exits non-zero');
  assertEq(r.json?.success, false, 'payload repo branch reports success:false');
  assertUntouched(fx, 'payload repo branch');
});

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
