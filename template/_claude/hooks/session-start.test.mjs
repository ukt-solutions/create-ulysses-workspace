#!/usr/bin/env node
// Tests for the session-start hook.
// Run: node .claude/hooks/session-start.test.mjs
//
// Three kinds of case. Most call the hook's helpers directly. The repo-remotes
// cases and the legacy-session cases at the end run the hook itself, against
// a real workspace built in a temp directory the way session-end.test.mjs
// builds its fixture.
//
// The config summary must state what workspace.json says — never a default the
// scripts don't apply: broken tracker/forge/repos values surface as
// `invalid`, an unset forge type surfaces as origin-picked, and only
// sessionModel falls back ("task": new work is always a task, so that is what
// an unset value means — a workspace still holding "session" is told so).
//
// The legacy-session nudge counts the sessions directory and nothing else:
// an entry whose name does not start with a dot is a legacy session, so an
// archive alone is none, and workspace.sessionModel is never consulted.
import { execFileSync, spawnSync } from 'child_process';
import {
  cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { configSummary, setupHint } from './_utils.mjs';

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

console.log('# session-start configSummary');

// 1. Fully configured: every field printed, primary repo marked
assertEq(
  configSummary({
    workspace: {
      sessionModel: 'task',
      tracker: { type: 'github-issues', repo: 'acme/monorepo' },
      forge: { type: 'gitlab' },
    },
    repos: {
      'my-app': { remote: 'git@github.com:acme/my-app.git', branch: 'main', primary: true },
      'my-api': { remote: 'git@github.com:acme/my-api.git', branch: 'main' },
    },
  }),
  'sessionModel: task | tracker: github-issues on acme/monorepo | forge: gitlab | repos: my-app (primary), my-api',
  'a fully configured workspace prints every field',
);

// 2. Fresh-scaffold shape: the template's own values
assertEq(
  configSummary({
    workspace: { name: 'demo', sessionModel: 'task', tracker: null, forge: { type: 'github' } },
    repos: {},
  }),
  'sessionModel: task | tracker: off | forge: github | repos: none',
  'a fresh scaffold summarizes to its defaults',
);

// 3. Absent everything: sessionModel reads as "task", an unset forge type
//    leaves each repo's origin to pick its adapter
assertEq(
  configSummary({}),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: none',
  'an empty config degrades without inventing values',
);
assertEq(
  configSummary({ workspace: { forge: {} } }),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: none',
  'a forge object without a type is origin-picked, not "github"',
);

// 4. sessionModel: the key routes nothing now — new work is always a task —
//    so an empty or non-string value prints the task lifecycle rather than
//    raw garbage, and the legacy value is reported as the file has it
assertEq(
  configSummary({ workspace: { sessionModel: '' } }),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: none',
  'an empty sessionModel prints the task lifecycle',
);
assertEq(
  configSummary({ workspace: { sessionModel: 5 } }),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: none',
  'a non-string sessionModel prints the task lifecycle',
);
assertEq(
  configSummary({ workspace: { sessionModel: 'session' } }),
  'sessionModel: session | tracker: off | forge: auto (from origin) | repos: none',
  'a workspace still holding the legacy value is told what its file says',
);

// 5. Tracker without a type — the adapter would throw, so the line says so
assertEq(
  configSummary({ workspace: { tracker: { repo: 'acme/monorepo' } } }),
  'sessionModel: task | tracker: invalid (no type) | forge: auto (from origin) | repos: none',
  'a tracker object without a type is invalid (no type)',
);

// 6. A truthy non-object tracker — nothing createTracker could take
assertEq(
  configSummary({ workspace: { tracker: 'github-issues' } }),
  'sessionModel: task | tracker: invalid | forge: auto (from origin) | repos: none',
  'a non-object tracker is invalid',
);

// 7. Forge: false disables forge ops; a string forge is not a config
assertEq(
  configSummary({ workspace: { forge: false } }),
  'sessionModel: task | tracker: off | forge: off | repos: none',
  'forge: false prints off',
);
assertEq(
  configSummary({ workspace: { forge: 'gitlab' } }),
  'sessionModel: task | tracker: off | forge: invalid | repos: none',
  'a string forge is invalid',
);

// 8. Repos: absent/null reads as an empty manifest (what the scripts see via
//    `Object.keys(repos || {})`); anything else non-object is invalid
assertEq(
  configSummary({ repos: null }),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: none',
  'repos: null is an empty manifest, not invalid',
);
assertEq(
  configSummary({ repos: ['my-app'] }),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: invalid',
  'an array repos value is invalid',
);
assertEq(
  configSummary({ repos: 'my-app' }),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: invalid',
  'a string repos value is invalid',
);
assertEq(
  configSummary({ repos: { 'my-app': { primary: true }, 'my-api': {} } }),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: my-app (primary), my-api',
  'repos entries print with primary marked',
);

console.log('# session-start setupHint (gh:130)');

// 9. Fully set up machine: no hint
assertEq(
  setupHint({ initialized: true, missingRepos: [], hasUser: true, hasClaudeLocal: true }),
  null,
  'a complete setup prints no hint',
);

// 10. Teammate's fresh clone: initialized, nothing local — points at join
assertEq(
  setupHint({ initialized: true, missingRepos: ['my-app', 'my-api'], hasUser: false, hasClaudeLocal: false }),
  'Setup incomplete (missing repos: my-app, my-api; no user set in .claude/settings.local.json). Run /workspace-init to join this workspace — it sets up only what this machine is missing.',
  'a fresh clone of an initialized workspace is told to join',
);

// 11. User set but CLAUDE.local.md missing still counts as incomplete
assertEq(
  setupHint({ initialized: true, missingRepos: [], hasUser: true, hasClaudeLocal: false }),
  'Setup incomplete (no CLAUDE.local.md). Run /workspace-init to join this workspace — it sets up only what this machine is missing.',
  'a missing CLAUDE.local.md is reported when the user is set',
);

// 12. Never-initialized workspace keeps the initialize wording
assertEq(
  setupHint({ initialized: false, missingRepos: ['my-app'], hasUser: true, hasClaudeLocal: true }),
  'Setup incomplete (missing repos: my-app). Run /workspace-init to initialize this workspace.',
  'an uninitialized workspace is told to initialize, not join',
);

console.log('# session-start hook: repo remotes');

// Each case builds a real workspace in a temp directory (a workspace repo, a
// project repo with a bare origin, a copy of .claude/) and runs the hook as a
// subprocess with a SessionStart payload on stdin. The fixture copies .claude/
// rather than symlinking it: the hook derives the workspace root from
// import.meta.url, and a symlink would resolve it to the template's real path
// instead of the fixture. HOME is pointed into the fixture as well, because
// the hook reads the session registry from there.
const gitForHook = spawnSync('git', ['--version'], { encoding: 'utf-8' });
if (gitForHook.error || gitForHook.status !== 0) {
  console.log('  (skip: git is not available on this machine)');
} else {
  const CLAUDE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  // repoRemotes, when given, is written to workspace.json as-is.
  function makeRepoRemotesFixture({ repoRemotes } = {}) {
    // realpath: macOS tmpdir() is a /var → /private/var symlink, while the
    // hook's root comes from import.meta.url, which Node resolves.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ss-remotes-')));
    const ws = join(base, 'ws');
    const cwd = join(base, 'cwd');
    const home = join(base, 'home');
    writeFileSync(join(base, 'gitconfig'), '');
    mkdirSync(ws);
    mkdirSync(cwd);
    mkdirSync(home);
    // Hermetic git: a fixed identity and an empty global config, so the
    // user's signing, hooks, or default-branch settings cannot change the
    // outcome.
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf-8', stdio: 'pipe' });

    git(ws, 'init', '-q', '-b', 'main');
    cpSync(CLAUDE_DIR, join(ws, '.claude'), { recursive: true });
    const workspace = { name: 'fixture', scratchpadDir: 'workspace-scratchpad', workSessionsDir: 'work-sessions' };
    if (repoRemotes !== undefined) workspace.repoRemotes = repoRemotes;
    writeFileSync(join(ws, 'workspace.json'), JSON.stringify({
      workspace,
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
    return { base, ws, cwd, env, git, origin };
  }

  function runSessionStart(fx) {
    const r = spawnSync(process.execPath, [join(fx.ws, '.claude', 'hooks', 'session-start.mjs')], {
      cwd: fx.cwd,
      env: fx.env,
      encoding: 'utf-8',
      input: JSON.stringify({ session_id: 'session-1', hook_event_name: 'SessionStart', source: 'startup' }),
    });
    let context = null;
    try { context = JSON.parse(r.stdout).additionalContext ?? ''; } catch {}
    return { status: r.status, context, stderr: r.stderr };
  }

  function repoRemotesLines(context) {
    return (context ?? '').split('\n').filter((line) => line.startsWith('Repo remotes:'));
  }

  function withRepoRemotesFixture(opts, fn) {
    const fx = makeRepoRemotesFixture(opts);
    try {
      fn(fx);
    } finally {
      try { rmSync(fx.base, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }

  // 13. The clone is registered as a remote of the workspace repo, and a
  // session is told once.
  withRepoRemotesFixture({}, (fx) => {
    const first = runSessionStart(fx);
    assertEq(first.status, 0, `the hook exits 0 (stderr: ${first.stderr.trim().slice(0, 200)})`);
    assert(typeof first.context === 'string' && first.context.startsWith('Workspace: fixture'), 'and injects its context as before');
    assertEq(repoRemotesLines(first.context), ['Repo remotes: added repo-app'], 'the new remote is announced on one line');
    assertEq(String(fx.git(fx.ws, 'config', '--get', 'remote.repo-app.url')).trim(), fx.origin, 'the remote carries the clone\'s origin');

    const second = runSessionStart(fx);
    assertEq(second.status, 0, 'a second start exits 0');
    assertEq(repoRemotesLines(second.context), [], 'with nothing changed, nothing is said');
    assert(typeof second.context === 'string' && second.context.includes('Workspace: fixture'), 'the rest of the context is still there');
  });

  // 14. workspace.repoRemotes: false makes the hook clean up instead: what an
  // earlier start added is taken away, and said once.
  withRepoRemotesFixture({}, (fx) => {
    assertEq(repoRemotesLines(runSessionStart(fx).context), ['Repo remotes: added repo-app'], 'control: the first start adds the remote');
    writeFileSync(join(fx.ws, 'workspace.json'), JSON.stringify({
      workspace: { name: 'fixture', repoRemotes: false },
      repos: { app: { remote: 'none', branch: 'main' } },
    }, null, 2));
    const off = runSessionStart(fx);
    assertEq(off.status, 0, 'the hook exits 0');
    assertEq(repoRemotesLines(off.context), ['Repo remotes: removed repo-app'], 'the remote is taken away, on one line');
    assertEq(String(fx.git(fx.ws, 'remote')).trim(), '', 'and none is left');
    assertEq(repoRemotesLines(runSessionStart(fx).context), [], 'the next start has nothing to say');
  });

  // 15. A workspace whose update left repo-remotes.mjs out still starts: the
  // hook must never fail over this.
  withRepoRemotesFixture({}, (fx) => {
    rmSync(join(fx.ws, '.claude', 'scripts', 'repo-remotes.mjs'));
    const r = runSessionStart(fx);
    assertEq(r.status, 0, `the hook exits 0 without the script (stderr: ${r.stderr.trim().slice(0, 200)})`);
    assert(typeof r.context === 'string' && r.context.startsWith('Workspace: fixture'), 'and still injects its context');
    assertEq(repoRemotesLines(r.context), [], 'with no remote line');
  });

  // 16. A clone that cannot get its remote, because a remote of that name
  // exists and was not made by the sync, is worth a line.
  withRepoRemotesFixture({}, (fx) => {
    const other = join(fx.base, 'origins', 'other.git');
    mkdirSync(other, { recursive: true });
    fx.git(other, 'init', '-q', '--bare', '-b', 'main');
    fx.git(fx.ws, 'remote', 'add', 'repo-app', other);
    fx.git(fx.ws, 'config', '--local', 'remote.repo-app.pushurl', other);
    const before = fx.git(fx.ws, 'config', '--local', '--get-regexp', '^remote\\.repo-app\\.');
    const r = runSessionStart(fx);
    assertEq(r.status, 0, 'the hook exits 0');
    const lines = repoRemotesLines(r.context);
    assertEq(lines.length, 1, 'the conflict is announced');
    assert(lines[0]?.startsWith('Repo remotes: conflict repos/app: '), `and says which clone: ${lines[0]}`);
    assertEq(fx.git(fx.ws, 'config', '--local', '--get-regexp', '^remote\\.repo-app\\.'), before, 'the remote it collided with is untouched');
  });

  // The legacy-session nudge, one line, counted from the sessions directory.
  const NUDGE = 'This workspace still has {n} work session(s) under the old session model — /migrate-sessions can inventory and drain them.';
  const nudgeLines = (context) => (context ?? '').split('\n').filter((line) => line.startsWith('This workspace still has'));
  const writeWorkspaceJson = (fx, workspace) => writeFileSync(join(fx.ws, 'workspace.json'), JSON.stringify({
    workspace,
    repos: { app: { remote: 'none', branch: 'main' } },
  }, null, 2));

  // 17. A workspace with no sessions directory: no nudge, no error, and the
  // config line already says the task lifecycle for an unset key.
  withRepoRemotesFixture({}, (fx) => {
    const r = runSessionStart(fx);
    assertEq(r.status, 0, `the hook exits 0 with no sessions directory (stderr: ${r.stderr.trim().slice(0, 200)})`);
    assertEq(nudgeLines(r.context), [], 'no sessions directory, no nudge');
    assert(typeof r.context === 'string' && r.context.includes('sessionModel: task |'), 'an unset sessionModel reads as the task lifecycle');
  });

  // 18. Only an archive under work-sessions/: .archived/ and other dot
  // entries are not sessions.
  withRepoRemotesFixture({}, (fx) => {
    mkdirSync(join(fx.ws, 'work-sessions', '.archived', 'old--20260101T000000', 'workspace'), { recursive: true });
    writeFileSync(join(fx.ws, 'work-sessions', '.archived', 'old--20260101T000000', 'workspace', 'session.md'), '---\n---\n');
    writeFileSync(join(fx.ws, 'work-sessions', '.DS_Store'), '');
    const r = runSessionStart(fx);
    assertEq(r.status, 0, 'the hook exits 0 with only an archive present');
    assertEq(nudgeLines(r.context), [], 'an archive alone is not a legacy session');
  });

  // 19. One real entry is the nudge — and the file's sessionModel changes
  // nothing, in either direction.
  withRepoRemotesFixture({}, (fx) => {
    mkdirSync(join(fx.ws, 'work-sessions', 'fix-auth', 'workspace'), { recursive: true });
    const first = runSessionStart(fx);
    assertEq(first.status, 0, 'the hook exits 0 with a legacy session present');
    assertEq(nudgeLines(first.context), [NUDGE.replace('{n}', 1)], 'one real entry is one line naming the count and /migrate-sessions');
    for (const sessionModel of ['task', 'session', '']) {
      writeWorkspaceJson(fx, { name: 'fixture', sessionModel, workSessionsDir: 'work-sessions' });
      assertEq(nudgeLines(runSessionStart(fx).context), [NUDGE.replace('{n}', 1)], `sessionModel ${JSON.stringify(sessionModel)} in the file does not hide the session`);
    }
    mkdirSync(join(fx.ws, 'work-sessions', 'second', 'workspace'), { recursive: true });
    assertEq(nudgeLines(runSessionStart(fx).context), [NUDGE.replace('{n}', 2)], 'a second entry is counted');
  });

  // 20. A custom workSessionsDir is the directory that counts: missing, it
  // is no nudge and no error — even with entries under the default name —
  // and present, its entries are the count.
  withRepoRemotesFixture({}, (fx) => {
    writeWorkspaceJson(fx, { name: 'fixture', workSessionsDir: 'legacy-sessions' });
    mkdirSync(join(fx.ws, 'work-sessions', 'not-the-configured-directory'), { recursive: true });
    const absent = runSessionStart(fx);
    assertEq(absent.status, 0, `the hook exits 0 when the configured directory is missing (stderr: ${absent.stderr.trim().slice(0, 200)})`);
    assertEq(nudgeLines(absent.context), [], 'a missing custom directory is no nudge, and the default name does not stand in for it');
    mkdirSync(join(fx.ws, 'legacy-sessions', 'beta'), { recursive: true });
    mkdirSync(join(fx.ws, 'legacy-sessions', 'alpha'), { recursive: true });
    mkdirSync(join(fx.ws, 'legacy-sessions', '.archived'), { recursive: true });
    const present = runSessionStart(fx);
    assertEq(present.status, 0, 'the hook exits 0 with entries under the custom directory');
    assertEq(nudgeLines(present.context), [NUDGE.replace('{n}', 2)], 'the custom directory\'s entries are the count, dot entries aside');
  });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
