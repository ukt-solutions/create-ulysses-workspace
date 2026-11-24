#!/usr/bin/env node
// Tests for add-repo-to-session.mjs
// Run: node template/_claude/scripts/add-repo-to-session.test.mjs
//
// Each case builds a real workspace in a temp directory (a workspace repo,
// two project repos with bare origins, a copy of .claude/), creates a session
// with create-work-session.mjs, then adds the second repo with the script
// under test. The session tracker (committed in the session branch) and
// workspace.json are untrusted input: the malicious cases carry shell
// payloads that would create a file named PWNED, and every case asserts that
// no such file exists anywhere under the temp directory. The subprocess runs
// with its cwd inside that directory, so a stray execution would land where
// the assertions look.
//
// The fixture copies .claude/ rather than symlinking it: the scripts derive
// the workspace root from import.meta.url, and a symlink would resolve it to
// the template's real path instead of the fixture.

import { execFileSync, spawnSync } from 'child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, mkdtempSync,
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

function writeWorkspaceJson(ws, repoBranches) {
  writeFileSync(join(ws, 'workspace.json'), JSON.stringify({
    workspace: { name: 'fixture', scratchpadDir: 'workspace-scratchpad', workSessionsDir: 'work-sessions' },
    repos: Object.fromEntries(Object.entries(repoBranches).map(([n, b]) => [n, { remote: 'none', branch: b }])),
  }, null, 2));
}

// A workspace with repos app and api, plus a session "demo" holding app.
function makeWorkspace() {
  // realpath: macOS tmpdir() is a /var → /private/var symlink, while the
  // scripts' root comes from import.meta.url, which Node resolves.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'arts-test-')));
  const ws = join(base, 'ws');
  const cwd = join(base, 'cwd');
  writeFileSync(join(base, 'gitconfig'), '');
  mkdirSync(ws);
  mkdirSync(cwd);
  const env = gitEnv(base);
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf-8', stdio: 'pipe' });

  git(ws, 'init', '-q', '-b', 'main');
  cpSync(CLAUDE_DIR, join(ws, '.claude'), { recursive: true });
  writeWorkspaceJson(ws, { app: 'main', api: 'main' });
  writeFileSync(join(ws, '.gitignore'), '.claude\nrepos\nwork-sessions\n');
  writeFileSync(join(ws, 'README.md'), '# fixture\n');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');

  for (const name of ['app', 'api']) {
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

  const fx = { base, ws, cwd, env, git };
  const created = runScript(fx, 'create-work-session.mjs',
    ['--session-name', 'demo', '--branch', 'feature/demo', '--repo', 'app', '--user', 'u']);
  if (created.json?.success !== true) {
    throw new Error(`fixture session was not created: ${created.stdout}${created.stderr}`);
  }
  return fx;
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

const addRepo = (fx, sessionName = 'demo', repo = 'api') =>
  runScript(fx, 'add-repo-to-session.mjs', ['--session-name', sessionName, '--repo', repo]);

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

const trackerPath = (fx) => join(fx.ws, 'work-sessions', 'demo', 'workspace', 'session.md');

// The state after a rejected add: api untouched, no payload ran.
function assertApiUntouched(fx, label) {
  assertEq(findPwned(fx.base), [], `${label}: no payload ran`);
  assertEq(branches(fx, join(fx.ws, 'repos', 'api')), ['main'], `${label}: no api branch created`);
  assert(!existsSync(join(fx.ws, 'work-sessions', 'demo', 'workspace', 'repos', 'api')),
    `${label}: no api worktree created`);
  assert(!/^\s*-\s*api\s*$/m.test(readFileSync(trackerPath(fx), 'utf-8')),
    `${label}: tracker repos list unchanged`);
}

function withFixture(fn) {
  const fx = makeWorkspace();
  try { fn(fx); }
  finally { try { rmSync(fx.base, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}

// === Happy path ===
withFixture((fx) => {
  const r = addRepo(fx);
  assertEq(r.status, 0, `happy path exits 0 (stderr: ${r.stderr.trim().slice(0, 200)})`);
  assertEq(r.json?.success, true, 'happy path reports success');
  assertEq(r.json?.repos, ['app', 'api'], 'happy path reports both repos');
  const projWt = join(fx.ws, 'work-sessions', 'demo', 'workspace', 'repos', 'api');
  assert(existsSync(join(projWt, '.git')), 'api worktree nested in the workspace worktree');
  assertEq(fx.git(projWt, 'branch', '--show-current').trim(), 'feature/demo', 'api worktree is on the session branch');
  assert(/^\s*-\s*api\s*$/m.test(readFileSync(trackerPath(fx), 'utf-8')), 'tracker repos list gains api');
  assertEq(findPwned(fx.base), [], 'happy path: no payload ran');
});

// === Tampered tracker: branch carries a shell payload ===
withFixture((fx) => {
  const path = trackerPath(fx);
  writeFileSync(path, readFileSync(path, 'utf-8').replace(/^branch:.*$/m, 'branch: x"; touch PWNED; "'));
  const r = addRepo(fx);
  assert(r.status !== 0, 'tampered tracker branch exits non-zero');
  assertEq(r.json?.success, false, 'tampered tracker branch reports success:false');
  assertApiUntouched(fx, 'tampered tracker branch');
});

// === Tampered tracker: branch missing or not a string ===
for (const value of ['null', '42']) {
  withFixture((fx) => {
    const path = trackerPath(fx);
    writeFileSync(path, readFileSync(path, 'utf-8').replace(/^branch:.*$/m, `branch: ${value}`));
    const r = addRepo(fx);
    assertEq(r.json?.success, false, `tracker branch ${value} reports success:false`);
    assertApiUntouched(fx, `tracker branch ${value}`);
  });
}

// === Tampered workspace.json: repos.api.branch carries a shell payload ===
withFixture((fx) => {
  writeWorkspaceJson(fx.ws, { app: 'main', api: 'main"; touch PWNED; "' });
  const r = addRepo(fx);
  assert(r.status !== 0, 'tampered repo branch exits non-zero');
  assertEq(r.json?.success, false, 'tampered repo branch reports success:false');
  assertApiUntouched(fx, 'tampered repo branch');
});

// === Session name must be a single path segment ===
withFixture((fx) => {
  // A real tracker reachable only through a traversal: without the segment
  // check the script would operate on it.
  const evil = join(fx.ws, 'evil', 'workspace');
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, 'session.md'), readFileSync(trackerPath(fx), 'utf-8'));
  for (const name of ['../evil', 'a/b', '.hidden']) {
    const r = addRepo(fx, name);
    assertEq(r.json?.success, false, `session name ${JSON.stringify(name)} reports success:false`);
    assert(/session name/i.test(r.json?.error || ''),
      `session name ${JSON.stringify(name)} is rejected for its name (error: ${r.json?.error})`);
  }
  assert(!existsSync(join(evil, 'repos')), 'traversal session name: nothing created under the escaped folder');
  assertApiUntouched(fx, 'session name');
});

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
