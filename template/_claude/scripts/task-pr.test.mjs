#!/usr/bin/env node
// Tests for task-pr.mjs
// Run: node .claude/scripts/task-pr.test.mjs
//
// Git runs for real under tmpdir (rev-list, remote get-url, log — the parts
// users get); push and pull are intercepted so nothing leaves the machine,
// and the forge and tracker are injected fakes, matching the adapters'
// spawnFn pattern. Every git call is an argv array, never a shell string.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseArgs, parseForgeRemote, mergeModeFor } from './task-pr.mjs';
import { createTaskWorktree, taskWorktreePath } from './task-worktree.mjs';
import { reconcile, addTask } from './chat-record.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}`); }
}
function assertEq(a, e, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(e);
  if (x === y) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}\n    expected: ${y}\n    actual:   ${x}`); }
}
async function rejects(fn, msg, expect) {
  try { await fn(); failed += 1; console.error(`  FAIL: ${msg} (did not throw)`); }
  catch (err) {
    if (expect && !String(err.message).includes(expect)) {
      failed += 1; console.error(`  FAIL: ${msg}\n    wanted substring: ${expect}\n    got:              ${err.message}`);
    } else { passed += 1; }
  }
}

// Isolate git config so a developer's global hooks/aliases cannot change
// behavior, and pin an identity so commits work with no user config.
const GIT_CFG = mkdtempSync(join(tmpdir(), 'task-pr-git-cfg-'));
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(GIT_CFG, 'global'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', env: ENV });
  if (res.status !== 0) throw new Error(`git -C ${cwd} ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

const clean = (r) => rmSync(r, { recursive: true, force: true });

// A launcher root with project repos under repos/. Each repo is a clone on
// main with a bare local origin; `github` maps repo → the forge-shaped URL
// its origin is rewritten to, `'none'` gives the repo no origin at all
// (local mode, gh:173), and null keeps the local bare URL (a non-forge
// origin). The launcher itself gets no origin unless `launcherOrigin` is
// passed: `true` wires a bare remote that main tracks (the post-merge pull
// runs), `'forge'` a forge-shaped origin that main has no upstream for
// (the pull is skipped for having nothing to pull from).
function makeLauncher(repos, {
  forge = { type: 'github' }, tracker = { type: 'github-issues', repo: 'acme/tracker' }, launcherOrigin = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'task-pr-'));
  const config = { workspace: { name: 'fixture', forge, ...(tracker ? { tracker } : {}) }, repos: {} };
  const bares = [];
  for (const repo of Object.keys(repos)) {
    config.repos[repo] = { branch: 'main', remote: 'none' };
    const dir = join(root, 'repos', repo);
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'README.md'), `# ${repo}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
    if (repos[repo] === 'none') continue; // no origin — the local-mode repo
    const bare = mkdtempSync(join(tmpdir(), `task-pr-origin-${repo}-`));
    git(dir, ['init', '-q', '--bare', join(bare, 'origin.git')]);
    git(dir, ['remote', 'add', 'origin', join(bare, 'origin.git')]);
    git(dir, ['push', '-q', 'origin', 'main']);
    bares.push(bare);
    if (repos[repo]) git(dir, ['remote', 'set-url', 'origin', repos[repo]]);
  }
  writeFileSync(join(root, 'workspace.json'), JSON.stringify(config, null, 2));
  // The launcher is itself a git repo on main — a real launcher always is,
  // and --merge reads its checked-out branch before pulling.
  writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\nrepos\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  if (launcherOrigin) {
    const bare = mkdtempSync(join(tmpdir(), 'task-pr-launcher-origin-'));
    git(root, ['init', '-q', '--bare', join(bare, 'origin.git')]);
    git(root, ['remote', 'add', 'origin', join(bare, 'origin.git')]);
    git(root, ['push', '-q', ...(launcherOrigin === true ? ['-u'] : []), 'origin', 'main']);
    if (launcherOrigin === 'forge') git(root, ['remote', 'set-url', 'origin', 'git@github.com:acme/workspace.git']);
    bares.push(bare);
  }
  return { root, bares };
}

// gitFn that delegates to real git except where an override matches.
function gitWith(overrides = []) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    for (const o of overrides) {
      if (o.match(args)) { calls.push({ args, intercepted: true }); return o.result(args); }
    }
    calls.push({ args, intercepted: false });
    return spawnSync(cmd, args, { encoding: 'utf8', env: ENV, ...opts });
  };
  fn.calls = calls;
  return fn;
}
const pushOk = { match: (a) => a.includes('push'), result: () => ({ status: 0, stdout: '', stderr: '' }) };
const pullOk = { match: (a) => a.includes('pull'), result: () => ({ status: 0, stdout: 'Already up to date.', stderr: '' }) };
const pullFails = {
  match: (a) => a.includes('pull'),
  result: () => ({ status: 1, stdout: '', stderr: 'error: not possible to fast-forward' }),
};
const pushNonFF = {
  match: (a) => a.includes('push'),
  result: () => ({ status: 1, stdout: '', stderr: ' ! [rejected] feature/x -> feature/x (non-fast-forward)\nerror: failed to push some refs' }),
};

// A forge factory that records every call and can be told to fail merges,
// report PRs as already merged, hold pre-existing open PRs, or fail PR
// creation per repo.
function fakeForgeFactory(log, {
  failMergeIds = [], mergedIds = [], openPrsFor = null, failCreateRepos = [],
} = {}) {
  let n = 0;
  return (config) => ({
    async prCreate({ title, body, head, base }) {
      if (failCreateRepos.includes(config.repo)) throw new Error('create rejected by the forge');
      n += 1;
      const number = 100 + n;
      log.push({ op: 'prCreate', repo: config.repo, title, body, head, base });
      return { id: `${config.repo}#${number}`, number, url: `https://github.com/${config.repo}/pull/${number}` };
    },
    async prList({ state, head, base }) {
      log.push({ op: 'prList', repo: config.repo, state, head, base });
      return (openPrsFor?.[config.repo] ?? [])
        .filter((p) => p.headRefName === head && (base ? p.baseRefName === base : true))
        .map((p) => ({
          id: `${config.repo}#${p.number}`, number: p.number, title: p.title ?? 'existing',
          url: p.url, headRefName: p.headRefName, baseRefName: p.baseRefName,
          mergedAt: null, state,
        }));
    },
    async prView({ id }) {
      log.push({ op: 'prView', repo: config.repo, id });
      return { id, state: mergedIds.includes(id) ? 'MERGED' : 'OPEN', number: Number(String(id).split('#')[1]) };
    },
    async prMerge({ id, strategy, deleteBranch }) {
      if (failMergeIds.includes(id)) throw new Error('merge rejected by the forge');
      log.push({ op: 'prMerge', repo: config.repo, id, strategy, deleteBranch });
      return { merged: true, url: `https://github.com/${config.repo}/pull/${id.split('#')[1]}` };
    },
  });
}

// A tracker factory that records calls; issueRef mirrors the github-issues
// adapter's contract so the closing-line shape is observable end to end.
function fakeTrackerFactory(log, { repo = 'acme/app', title = 'The issue title' } = {}) {
  return () => ({
    async getIssue(id) { log.push({ op: 'getIssue', id }); return { id, title }; },
    issueRef(id, { fromRepo } = {}) {
      log.push({ op: 'issueRef', id, fromRepo });
      return fromRepo && fromRepo !== repo ? `${repo}#${id.slice(3)}` : `#${id.slice(3)}`;
    },
    async closeIssue(id, { comment } = {}) { log.push({ op: 'closeIssue', id, comment }); },
  });
}

const argvCreate = (extra = []) => ['node', 'task-pr.mjs', '--create', ...extra];

console.log('# parseForgeRemote shapes');
{
  assertEq(parseForgeRemote('git@github.com:acme/app.git'), { owner: 'acme', name: 'app' }, 'ssh URL parses');
  assertEq(parseForgeRemote('https://github.com/acme/app.git'), { owner: 'acme', name: 'app' }, 'https URL parses');
  assertEq(parseForgeRemote('https://github.com/acme/app'), { owner: 'acme', name: 'app' }, 'https URL without .git parses');
  assertEq(parseForgeRemote('ssh://git@github.com/acme/app.git'), { owner: 'acme', name: 'app' }, 'ssh scheme URL parses');
  assertEq(parseForgeRemote('/tmp/origin.git'), null, 'local path is not forge-hosted');
  assertEq(parseForgeRemote('file:///srv/bare/app.git'), null, 'file URL is not forge-hosted');
  assertEq(parseForgeRemote('git@gitlab.example.com:acme/app.git'), null, 'unknown host is not forge-hosted');
}

console.log('# mergeModeFor: override, no origin, forge, non-forge origin');
{
  const { root, bares } = makeLauncher({
    app: 'git@github.com:acme/app.git',
    fork: 'git@github.com:acme/fork.git',
    lone: 'none',
    mirror: null,
  });
  try {
    assertEq(mergeModeFor(root, 'app'), 'forge', 'a forge-hosted origin is forge mode');
    assertEq(mergeModeFor(root, 'mirror'), null, 'a non-forge origin without an override does not resolve');
    assertEq(mergeModeFor(root, 'lone'), 'local', 'no origin at all is local mode');

    // The override exists for a clone whose origin is a third-party upstream
    // nobody here may push to — the URL parses, the repo still merges locally.
    const wsPath = join(root, 'workspace.json');
    const ws = JSON.parse(readFileSync(wsPath, 'utf-8'));
    ws.repos.fork.merge = 'local';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    assertEq(mergeModeFor(root, 'fork'), 'local', 'repos.{repo}.merge "local" overrides a forge origin');

    ws.workspace.merge = 'local';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    assertEq(mergeModeFor(root, '.'), 'local', 'workspace.merge "local" overrides for the workspace repo');

    delete ws.workspace.merge;
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    assertEq(mergeModeFor(root, '.'), 'local', 'the launcher with no origin is local mode');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a merge: "local" override repo counts commits against its local default branch');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    // The override case: origin parses as a forge, but merges land locally —
    // so the local main, never the origin ref, is what a task builds on.
    const wsPath = join(root, 'workspace.json');
    const ws = JSON.parse(readFileSync(wsPath, 'utf-8'));
    ws.repos.app.merge = 'local';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));

    // Task one merges locally, advancing repos/app's main; origin/main
    // stays where it was pushed at setup.
    const one = createTaskWorktree(root, { repo: 'app', branch: 'feature/one' });
    writeFileSync(join(one.path, 'one.txt'), 'one\n');
    git(one.path, ['add', '-A']);
    git(one.path, ['commit', '-q', '-m', 'feat: one']);
    git(join(root, 'repos', 'app'), ['merge', '-q', '--ff-only', 'feature/one']);

    // Task two: one commit over the locally-advanced main — two over the
    // stale origin/main, if the count used the wrong base.
    const two = createTaskWorktree(root, { repo: 'app', branch: 'feature/two' });
    assertEq(git(two.path, ['log', '-1', '--format=%s']).trim(), 'feat: one', 'the second task started from the locally-merged main');
    git(two.path, ['commit', '-q', '--allow-empty', '-m', 'feat: two']);

    const log = [];
    const out = await run(argvCreate(['--root', root, '--branch', 'feature/two', '--repo', 'app']),
      { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.prs, [{
      repo: 'app', mode: 'local', branch: 'feature/two', base: 'main',
      worktree: taskWorktreePath(root, 'app', 'feature/two'), commits: 1,
    }], 'the count is against the local main, not the stale origin ref');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# parseArgs validation');
{
  await rejects(() => run(['node', 'task-pr.mjs']), 'a mode is required');
  await rejects(() => run(argvCreate(['--root', '/w'])), '--create needs a branch');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b'])), '--create needs repos');
  await rejects(() => run(['node', 'task-pr.mjs', '--merge', '--root', '/w']), '--merge needs --prs');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b', '--repo', 'app', '--prs', 'x.json'])), '--prs rejected with --create');
  await rejects(() => run(['node', 'task-pr.mjs', '--merge', '--root', '/w', '--prs', 'x.json', '--force-with-lease']), '--force-with-lease rejected with --merge');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b', '--repo', 'app', '--body-file', 'nopath'])), '--body-file needs repo=path');
  await rejects(() => run(['node', 'task-pr.mjs', '--merge', '--root', '/w', '--prs', 'x.json', '--out', 'y.json']), '--out rejected with --merge');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b', '--repo', 'app', '--bogus'])), 'unknown flag rejected');
  const ok = parseArgs(['node', 's', '--create', '--root', '/w', '--branch', 'feature/x',
    '--work-item', 'gh:163', '--repo', 'app', '--repo', '.', '--body-file', 'app=/tmp/a.md', '--body-file', '.=/tmp/w.md',
    '--out', '/tmp/prs.json']);
  assertEq([ok.mode, ok.branch, ok.workItem, ok.repos, ok.out], ['create', 'feature/x', 'gh:163', ['app', '.'], '/tmp/prs.json'], 'repeated --repo accumulates');
  assertEq([...ok.bodyFiles.entries()], [['app', '/tmp/a.md'], ['.', '/tmp/w.md']], 'body files map repo to path');
}

console.log('# --create with a work item: push, PR, closing line (same-repo ref)');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'work.txt'), 'done\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'feat: do the thing']);
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'What changed and why.\n\n## Verification\n- tests\n');

    const log = [];
    const gitFn = gitWith([pushOk]);
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--work-item', 'gh:163',
      '--repo', 'app', '--body-file', `app=${bodyFile}`,
    ]), { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log, { repo: 'acme/app' }) });

    assertEq(out.empty, [], 'nothing reported empty');
    assertEq(out.prs.length, 1, 'one PR created');
    assertEq([out.prs[0].repo, out.prs[0].owner, out.prs[0].name, out.prs[0].isWorkspace],
      ['app', 'acme', 'app', false], 'PR entry carries repo identity');
    assert(typeof out.prs[0].number === 'number' && out.prs[0].url.startsWith('https://'), 'PR entry carries number and url');
    assertEq(out.prs[0].commits, 1, 'the forge entry carries its commit count');
    const create = log.find((e) => e.op === 'prCreate');
    assertEq(create.title, 'The issue title', 'title comes from the linked issue');
    assertEq(create.head, 'feature/x', 'PR head is the task branch');
    assertEq(create.base, 'main', 'PR base is the repo default branch');
    assert(create.body.endsWith('Closes #163\n'), `body closes with a same-repo ref: ${JSON.stringify(create.body)}`);
    assert(create.body.includes('## Verification'), 'body file content is included');
    assertEq(log.find((e) => e.op === 'issueRef').fromRepo, 'acme/app', 'issueRef got the PR repo as fromRepo');
    const push = gitFn.calls.find((c) => c.intercepted);
    assert(push && push.args.join(' ').endsWith('push -u origin -- feature/x'), 'branch pushed with -u (after --) before the PR');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --create cross-repo ref: the closing line names the tracker repo');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'work.txt'), 'done\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'feat: do the thing']);
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n\n## Verification\n- tests\n');

    const log = [];
    await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--work-item', 'gh:163',
      '--repo', 'app', '--body-file', `app=${bodyFile}`,
    ]), { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log, { repo: 'acme/tracker' }) });

    const create = log.find((e) => e.op === 'prCreate');
    assert(create.body.endsWith('Closes acme/tracker#163\n'), `cross-repo closing line: ${JSON.stringify(create.body)}`);
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --create without a work item: title is the first commit subject');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'work.txt'), 'done\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'feat: first commit']);
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'chore: second commit']);
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');

    const log = [];
    await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--repo', 'app', '--body-file', `app=${bodyFile}`,
    ]), { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });

    const create = log.find((e) => e.op === 'prCreate');
    assertEq(create.title, 'feat: first commit', 'title is the earliest commit subject');
    assert(!create.body.includes('Closes'), 'no closing line without a work item');
    assert(!log.some((e) => e.op === 'getIssue'), 'no issue fetched without a work item');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# an empty branch is skipped: no push, no PR, no body file needed');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git', idle: null });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'work.txt'), 'done\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'feat: do the thing']);
    createTaskWorktree(root, { repo: 'idle', branch: 'feature/x' }); // 0 commits over origin/main
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');

    const log = [];
    const gitFn = gitWith([pushOk]);
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--repo', 'app', '--repo', 'idle', '--body-file', `app=${bodyFile}`,
    ]), { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });

    assertEq(out.empty, ['idle'], 'the idle repo is reported empty');
    assertEq(out.prs.map((p) => p.repo), ['app'], 'only the repo with commits gets a PR');
    const pushes = gitFn.calls.filter((c) => c.args.includes('push'));
    assertEq(pushes.length, 1, 'one push — the empty branch is never pushed');
    assert(pushes[0].args.join(' ').includes(join('repos', 'app')), 'the push came from the app worktree');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a non-forge origin stops before anything is pushed, suggesting the override');
{
  const { root, bares } = makeLauncher({ app: null }); // origin stays the local bare path
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: do the thing']);
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');

    const log = [];
    const gitFn = gitWith([pushOk]);
    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app', '--body-file', `app=${bodyFile}`]),
        { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) }),
      'non-forge origin errors',
      'Set repos.app.merge to "local"',
    );
    assertEq(gitFn.calls.filter((c) => c.args.includes('push')).length, 0, 'nothing was pushed');
    assertEq(log.filter((e) => e.op === 'prCreate').length, 0, 'no PR was created');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a missing body file errors before anything is pushed');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: do the thing']);
    const gitFn = gitWith([pushOk]);
    const log = [];
    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app', '--body-file', `app=${join(root, 'nope.md')}`]),
        { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) }),
      'absent body file errors',
      'body file not found',
    );
    assertEq(gitFn.calls.filter((c) => c.args.includes('push')).length, 0, 'nothing was pushed');

    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app']),
        { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) }),
      'missing --body-file flag errors',
      'no --body-file',
    );
    assertEq(gitFn.calls.filter((c) => c.args.includes('push')).length, 0, 'still nothing pushed');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# workspace.forge: false refuses before pushing');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' }, { forge: false });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: do the thing']);
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');
    const gitFn = gitWith([pushOk]);
    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app', '--body-file', `app=${bodyFile}`]), { gitFn }),
      'disabled forge errors',
      'forge operations are disabled',
    );
    assertEq(gitFn.calls.filter((c) => c.args.includes('push')).length, 0, 'nothing was pushed');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a non-fast-forward push asks for --force-with-lease, never forces');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: do the thing']);
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');
    const log = [];
    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app', '--body-file', `app=${bodyFile}`]),
        { gitFn: gitWith([pushNonFF]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) }),
      'non-fast-forward push errors',
      '--force-with-lease',
    );
    assertEq(log.filter((e) => e.op === 'prCreate').length, 0, 'no PR after a failed push');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# the workspace repo (".") rides the same path as a project repo');
{
  // A launcher that is itself a git repo with a forge-shaped origin.
  const root = mkdtempSync(join(tmpdir(), 'task-pr-ws-'));
  const bare = mkdtempSync(join(tmpdir(), 'task-pr-ws-origin-'));
  try {
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({
      workspace: { name: 'fixture', forge: { type: 'github' }, tracker: { type: 'github-issues', repo: 'acme/tracker' } },
      repos: {},
    }, null, 2));
    git(root, ['init', '-q', '-b', 'main']);
    writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\nrepos\n');
    writeFileSync(join(root, 'README.md'), '# launcher\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    git(root, ['init', '-q', '--bare', join(bare, 'origin.git')]);
    git(root, ['remote', 'add', 'origin', join(bare, 'origin.git')]);
    git(root, ['push', '-q', 'origin', 'main']);
    git(root, ['remote', 'set-url', 'origin', 'git@github.com:acme/workspace.git']);

    const wt = createTaskWorktree(root, { repo: '.', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'ctx.md'), 'context\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'context: promote thinking']);
    const bodyFile = join(root, 'body-ws.md');
    writeFileSync(bodyFile, 'Promotions.\n');

    const log = [];
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--work-item', 'gh:163',
      '--repo', '.', '--body-file', `.=${bodyFile}`,
    ]), { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log, { repo: 'acme/tracker' }) });

    assertEq(out.prs.length, 1, 'one workspace PR');
    assertEq([out.prs[0].repo, out.prs[0].owner, out.prs[0].name, out.prs[0].isWorkspace],
      ['.', 'acme', 'workspace', true], 'workspace PR entry is flagged isWorkspace');
    assert(log.find((e) => e.op === 'prCreate').repo === 'acme/workspace', 'the forge aimed at the workspace worktree own origin');
  } finally { clean(root); clean(bare); }
}

console.log('# a no-origin launcher on master merges "." against master, not a phantom main');
{
  const root = mkdtempSync(join(tmpdir(), 'task-pr-ws-'));
  // The workspace repo merges in the launcher itself, which must sit clean —
  // so the PRs file lives outside it.
  const scratch = mkdtempSync(join(tmpdir(), 'task-pr-ws-scratch-'));
  try {
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({
      workspace: { name: 'fixture', forge: { type: 'github' }, tracker: { type: 'github-issues', repo: 'acme/tracker' } },
      repos: {},
    }, null, 2));
    writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\nrepos\n');
    git(root, ['init', '-q', '-b', 'master']);
    writeFileSync(join(root, 'README.md'), '# launcher\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);

    const wt = createTaskWorktree(root, { repo: '.', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'ctx.md'), 'context\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'context: promote thinking']);

    const log = [];
    const out = await run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', '.']),
      { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.prs[0].base, 'master', "the local entry's base is the launcher's own master");

    const gitFn = gitWith();
    const merged = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(scratch, out.prs), '--work-item', 'gh:173'],
      { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(merged.merged, [{ repo: '.', mode: 'local', branch: 'feature/x', base: 'master' }], 'merged against master');
    assertEq(git(root, ['log', '-1', '--format=%s']).trim(), 'context: promote thinking', 'the launcher master fast-forwarded');
    assertEq(merged.pullSkipped, 'workspace merged locally', 'the pull is skipped — the work is already in the launcher');
  } finally { clean(root); clean(scratch); }
}

console.log('# an all-local task: create records local entries, merge fast-forwards the source clones');
{
  const { root, bares } = makeLauncher({ app: 'none', idle: 'none' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'work.txt'), 'done\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'feat: do the thing']);
    createTaskWorktree(root, { repo: 'idle', branch: 'feature/x' }); // 0 commits over main
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Accepted but ignored for a local repo.\n');

    const log = [];
    const gitFn = gitWith();
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--work-item', 'gh:173', '--repo', 'app', '--repo', 'idle',
      '--body-file', `app=${bodyFile}`, // optional for a local repo — ignored
    ]), { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });

    assertEq(out.empty, ['idle'], 'the idle repo is reported empty');
    assertEq(out.pushed, [], 'nothing was pushed');
    assertEq(out.prs, [{
      repo: 'app', mode: 'local', branch: 'feature/x', base: 'main',
      worktree: taskWorktreePath(root, 'app', 'feature/x'), commits: 1,
    }], 'a local entry is recorded instead of a PR');
    assertEq(log.filter((e) => e.op.startsWith('pr')).length, 0, 'the forge was never consulted');
    assertEq(gitFn.calls.filter((c) => c.args.includes('push')).length, 0, 'no push was attempted');

    const file = prsFile(root, out.prs);
    const deps = { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) };
    const merged = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--work-item', 'gh:173'], deps);
    assertEq(merged.merged, [{ repo: 'app', mode: 'local', branch: 'feature/x', base: 'main' }], 'the local merge is reported');
    assertEq(git(join(root, 'repos', 'app'), ['log', '-1', '--format=%s']).trim(), 'feat: do the thing', "the source clone's main fast-forwarded to the task branch");
    assertEq(merged.closed, 'gh:173', 'the issue closed with the tracker configured');

    // Re-runnable: the branch is now an ancestor of main, so it counts as
    // merged and nothing errors or merges twice.
    const again = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--work-item', 'gh:173'], deps);
    assertEq(again.merged.map((m) => m.repo), ['app'], 'a re-run counts the merged branch as done');
    assertEq(git(join(root, 'repos', 'app'), ['log', '-1', '--format=%s']).trim(), 'feat: do the thing', 'the re-run merged nothing new');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a mixed task: local entries and forge PRs, projects first, workspace last');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git', lone: 'none' });
  // The workspace repo merges in the launcher itself, which must sit clean —
  // so every scratch file lives outside the launcher.
  const scratch = mkdtempSync(join(tmpdir(), 'task-pr-mixed-'));
  try {
    // The launcher has no origin, so the workspace repo (".") is local too.
    const wts = {};
    for (const repo of ['app', 'lone', '.']) {
      wts[repo] = createTaskWorktree(root, { repo, branch: 'feature/x' });
      writeFileSync(join(wts[repo].path, `${repo === '.' ? 'ctx' : 'work'}.txt`), 'done\n');
      git(wts[repo].path, ['add', '-A']);
      git(wts[repo].path, ['commit', '-q', '-m', `feat: ${repo}`]);
    }
    const bodyFile = join(scratch, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');

    const log = [];
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--work-item', 'gh:173',
      '--repo', 'app', '--repo', 'lone', '--repo', '.', '--body-file', `app=${bodyFile}`,
    ]), { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });

    assertEq(out.prs.map((p) => [p.repo, p.mode]), [['lone', 'local'], ['.', 'local'], ['app', 'forge']], 'both entry kinds ride the same list');
    assertEq(out.pushed, ['app'], 'only the forge repo was pushed');
    assertEq(log.filter((e) => e.op === 'prCreate').length, 1, 'one PR for the one forge repo');

    const file = prsFile(scratch, out.prs);
    const gitFn = gitWith([pushOk]);
    const merged = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--work-item', 'gh:173'],
      { gitFn, forgeFactory: fakeForgeFactory(log, { mergedIds: ['acme/app#101'] }), trackerFactory: fakeTrackerFactory(log) });

    assertEq(merged.merged.map((m) => [m.repo, m.mode]), [['lone', 'local'], ['app', 'forge'], ['.', 'local']], 'projects merged first, the workspace last');
    assertEq(git(join(root, 'repos', 'lone'), ['log', '-1', '--format=%s']).trim(), 'feat: lone', "lone's source clone fast-forwarded");
    assertEq(git(root, ['log', '-1', '--format=%s']).trim(), 'feat: .', 'the launcher itself fast-forwarded for the local "." merge');
    assertEq(merged.pullSkipped, 'workspace merged locally', 'the pull is skipped — the launcher already has the work');
    assertEq(gitFn.calls.filter((c) => c.args.includes('pull')).length, 0, 'no pull was attempted');
    assertEq(log.find((e) => e.op === 'closeIssue').comment,
      'Merged: lone feature/x->main https://github.com/acme/app/pull/101 . feature/x->main',
      'the close comment names local branches and PR URLs alike');
    // Order in the git stream too: the project's local merge strictly
    // before the workspace repo's.
    const loneMergeAt = gitFn.calls.findIndex((c) => c.args.includes('merge') && c.args.join(' ').includes(join('repos', 'lone')));
    const wsMergeAt = gitFn.calls.findIndex((c) => c.args.includes('merge') && c.args.includes(root) && !c.args.join(' ').includes(join('repos', 'lone')));
    assert(loneMergeAt >= 0 && wsMergeAt >= 0 && loneMergeAt < wsMergeAt, 'the project local merge preceded the workspace merge');
  } finally { clean(root); bares.forEach(clean); clean(scratch); }
}

console.log('# a local merge that is not fast-forwardable stops and says to rebase');
{
  const { root, bares } = makeLauncher({ app: 'none' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: branch work']);
    // Diverge the source clone's main after the branch was cut.
    writeFileSync(join(root, 'repos', 'app', 'main.txt'), 'moved on\n');
    git(join(root, 'repos', 'app'), ['add', '-A']);
    git(join(root, 'repos', 'app'), ['commit', '-q', '-m', 'main moved on']);

    const log = [];
    const out = await run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app']),
      { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    const deps = { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) };
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, out.prs), '--work-item', 'gh:173'], deps),
      'a diverged local merge errors',
      'rebase the task branch onto main',
    );
    assertEq(git(join(root, 'repos', 'app'), ['log', '-1', '--format=%s']).trim(), 'main moved on', 'main was left where it was');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a local merge refuses a dirty source clone or one off its default branch');
{
  const { root, bares } = makeLauncher({ app: 'none' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: do the thing']);
    const log = [];
    const out = await run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app']),
      { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    const deps = { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) };

    writeFileSync(join(root, 'repos', 'app', 'loose.txt'), 'uncommitted\n');
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, out.prs)], deps),
      'a dirty source clone errors',
      'uncommitted changes',
    );
    rmSync(join(root, 'repos', 'app', 'loose.txt'));

    git(join(root, 'repos', 'app'), ['checkout', '-q', '-b', 'side-branch']);
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, out.prs)], deps),
      'a source clone off its default branch errors',
      'not main',
    );
    assertEq(git(join(root, 'repos', 'app'), ['log', '-1', '--format=%s']).trim(), 'init', 'nothing merged by either refusal');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# without a tracker: no issue read, nothing closed, the JSON says why');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' }, { tracker: null });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: first commit']);
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');

    const log = [];
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--work-item', 'gh:173', '--repo', 'app', '--body-file', `app=${bodyFile}`,
    ]), { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(log.find((e) => e.op === 'prCreate').title, 'feat: first commit', 'the title fell back to the first commit subject');
    assert(!log.find((e) => e.op === 'prCreate').body.includes('Closes'), 'no closing line without a tracker');

    const merged = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, out.prs), '--work-item', 'gh:173'],
      { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(merged.closed, null, 'nothing was closed');
    assertEq(merged.closeSkipped, 'no tracker configured', 'the skip is reported in the JSON');
    assertEq(log.filter((e) => e.op === 'closeIssue').length, 0, 'no close call was made');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --chat resolves the task repos from the chat record');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git', api: 'git@github.com:acme/api.git' });
  try {
    for (const repo of ['app', 'api']) {
      const wt = createTaskWorktree(root, { repo, branch: 'feature/x' });
      git(wt.path, ['commit', '-q', '--allow-empty', '-m', `feat: ${repo}`]);
    }
    writeFileSync(join(root, 'a.md'), 'Summary a.\n');
    writeFileSync(join(root, 'b.md'), 'Summary b.\n');
    reconcile(root, { sessionId: 'sid-1', name: 'worker' });
    addTask(root, 'worker', { workItem: 'gh:163', branch: 'feature/x', repo: 'app' });
    addTask(root, 'worker', { workItem: 'gh:163', branch: 'feature/x', repo: 'api' });
    addTask(root, 'worker', { workItem: 'gh:9', branch: 'feature/other', repo: 'app' });

    const log = [];
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--chat', 'worker',
      '--body-file', `app=${join(root, 'a.md')}`, '--body-file', `api=${join(root, 'b.md')}`,
    ]), { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.prs.map((p) => p.repo).sort(), ['api', 'app'], 'both entries for the branch became PRs');

    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'feature/none', '--chat', 'worker']),
        { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) }),
      'a branch with no record entries errors',
      'no task entries',
    );
  } finally { clean(root); bares.forEach(clean); }
}

// A --merge input file shaped like --create's output.
function prsFile(dir, prs) {
  const p = join(dir, `prs-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ prs, empty: [] }));
  return p;
}

console.log('# --merge: projects first, workspace last, then pull and close');
{
  // launcherOrigin: true — the launcher tracks its origin, so the post-merge
  // pull has an upstream to pull from.
  const { root, bares } = makeLauncher({}, { launcherOrigin: true });
  try {
    const log = [];
    const gitFn = gitWith([pullOk]);
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false },
      { repo: '.', owner: 'acme', name: 'workspace', number: 2, id: 'acme/workspace#2', url: 'https://github.com/acme/workspace/pull/2', isWorkspace: true },
    ];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs), '--work-item', 'gh:163'],
      { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });

    const merges = log.filter((e) => e.op === 'prMerge');
    assertEq(merges.map((m) => m.repo), ['acme/app', 'acme/workspace'], 'project PR merged before the workspace PR');
    assertEq(merges.every((m) => m.strategy === 'squash' && m.deleteBranch === true), true, 'squash + delete branch');
    assertEq(out.merged.map((m) => m.repo), ['app', '.'], 'merged list reported');
    assertEq(out.closed, 'gh:163', 'issue closed');
    assertEq(log.find((e) => e.op === 'closeIssue').comment,
      'Merged: https://github.com/acme/app/pull/1 https://github.com/acme/workspace/pull/2',
      'close comment names the merged URLs');
    const pull = gitFn.calls.find((c) => c.args.includes('pull'));
    assert(pull && pull.args.join(' ').endsWith('pull --ff-only'), 'launcher pulled --ff-only after the merges');
    assert(log.findIndex((e) => e.op === 'closeIssue') > log.findIndex((e) => e.op === 'prMerge'), 'close happened after the merges');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge without a work item closes nothing');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const prs = [{ repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'u1', isWorkspace: false }];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs)],
      { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.closed, null, 'nothing closed');
    assertEq(log.filter((e) => e.op === 'closeIssue').length, 0, 'no close call made');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a failed project merge leaves the workspace PR open and stops');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const gitFn = gitWith([pullOk]);
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false },
      { repo: 'api', owner: 'acme', name: 'api', number: 2, id: 'acme/api#2', url: 'https://github.com/acme/api/pull/2', isWorkspace: false },
      { repo: '.', owner: 'acme', name: 'workspace', number: 3, id: 'acme/workspace#3', url: 'https://github.com/acme/workspace/pull/3', isWorkspace: true },
    ];
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs), '--work-item', 'gh:163'],
        { gitFn, forgeFactory: fakeForgeFactory(log, { failMergeIds: ['acme/api#2'] }), trackerFactory: fakeTrackerFactory(log) }),
      'failed merge errors',
      'Still open',
    );
    const merges = log.filter((e) => e.op === 'prMerge').map((m) => m.repo);
    assertEq(merges, ['acme/app'], 'the PRs before the failure merged, nothing after');
    assertEq(gitFn.calls.filter((c) => c.args.includes('pull')).length, 0, 'no pull after a failure');
    assertEq(log.filter((e) => e.op === 'closeIssue').length, 0, 'no issue close after a failure');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a failed workspace merge still reports the PRs left open');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false },
      { repo: '.', owner: 'acme', name: 'workspace', number: 3, id: 'acme/workspace#3', url: 'https://github.com/acme/workspace/pull/3', isWorkspace: true },
    ];
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs)],
        { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log, { failMergeIds: ['acme/workspace#3'] }), trackerFactory: fakeTrackerFactory(log) }),
      'failed workspace merge errors',
      'https://github.com/acme/workspace/pull/3',
    );
    assertEq(log.filter((e) => e.op === 'prMerge').length, 1, 'only the project PR merged');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a missing task worktree refuses up front');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'feature/never', '--repo', 'app']),
        { gitFn: gitWith(), forgeFactory: fakeForgeFactory([]), trackerFactory: fakeTrackerFactory([]) }),
      'missing worktree errors',
      'no task worktree',
    );
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# an invalid branch name is refused before any other git call');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    const gitFn = gitWith();
    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'bad..name', '--repo', 'app']),
        { gitFn, forgeFactory: fakeForgeFactory([]), trackerFactory: fakeTrackerFactory([]) }),
      'invalid branch errors',
      'invalid branch name',
    );
    assert(gitFn.calls.length === 1 && gitFn.calls[0].args.includes('check-ref-format'),
      'the format check is the only git call made');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --create reuses a PR already open for the branch instead of duplicating it');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    const wt = createTaskWorktree(root, { repo: 'app', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: do the thing']);
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');
    const log = [];
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--repo', 'app', '--body-file', `app=${bodyFile}`,
    ]), {
      gitFn: gitWith([pushOk]),
      forgeFactory: fakeForgeFactory(log, {
        openPrsFor: { 'acme/app': [{ number: 55, url: 'https://github.com/acme/app/pull/55', headRefName: 'feature/x', baseRefName: 'main' }] },
      }),
      trackerFactory: fakeTrackerFactory(log),
    });
    assertEq(log.filter((e) => e.op === 'prCreate').length, 0, 'no duplicate PR is created');
    assertEq([out.prs[0].number, out.prs[0].url, out.prs[0].id],
      [55, 'https://github.com/acme/app/pull/55', 'acme/app#55'], 'the existing PR is reused');
    assertEq(log.find((e) => e.op === 'prList').head, 'feature/x', 'the lookup filtered by the task branch');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a mid-create failure still writes what landed to --out, and a re-run completes the set');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git', api: 'git@github.com:acme/api.git' });
  try {
    for (const repo of ['app', 'api']) {
      const wt = createTaskWorktree(root, { repo, branch: 'feature/x' });
      git(wt.path, ['commit', '-q', '--allow-empty', '-m', `feat: ${repo}`]);
    }
    writeFileSync(join(root, 'a.md'), 'Summary a.\n');
    writeFileSync(join(root, 'b.md'), 'Summary b.\n');
    const common = [
      '--root', root, '--branch', 'feature/x', '--repo', 'app', '--repo', 'api',
      '--body-file', `app=${join(root, 'a.md')}`, '--body-file', `api=${join(root, 'b.md')}`,
    ];
    const outFile = join(root, 'drawer', 'prs.json');
    const log = [];
    await rejects(
      () => run(argvCreate([...common, '--out', outFile]),
        { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log, { failCreateRepos: ['acme/api'] }), trackerFactory: fakeTrackerFactory(log) }),
      'a PR-create failure errors',
      'create rejected',
    );
    const partial = JSON.parse(readFileSync(outFile, 'utf8'));
    assertEq(partial.prs.map((p) => p.repo), ['app'], 'the PR that landed is in the partial output');
    assertEq(partial.pushed.sort(), ['api', 'app'], 'both pushes are recorded');
    assertEq(partial.empty, [], 'empty list rides along');

    // A failure before the first push writes nothing — an earlier run's
    // file must survive a guard refusal untouched.
    const earlier = join(root, 'earlier.json');
    writeFileSync(earlier, '{"prs":[{"stub":true}],"empty":[]}');
    await rejects(
      () => run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app', '--body-file', `app=${join(root, 'nope.md')}`, '--out', earlier]),
        { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) }),
      'a guard refusal still errors',
      'body file not found',
    );
    assertEq(JSON.parse(readFileSync(earlier, 'utf8')).prs[0].stub, true, 'the earlier file was not clobbered');

    // The re-run seeds the reuse from the partial output and completes.
    const seeded = {};
    for (const p of partial.prs) seeded[`${p.owner}/${p.name}`] = [{ number: p.number, url: p.url, headRefName: 'feature/x', baseRefName: 'main' }];
    const done = await run(argvCreate([...common, '--out', outFile]),
      { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log, { openPrsFor: seeded }), trackerFactory: fakeTrackerFactory(log) });
    assertEq(done.prs.map((p) => p.repo).sort(), ['api', 'app'], 'the re-run completed the set');
    assertEq(JSON.parse(readFileSync(outFile, 'utf8')).prs.length, 2, '--out now holds the full result');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge refuses a PRs file entry whose repo is not "." or a plain name');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const gitFn = gitWith([pullOk]);
    const deps = { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) };
    // A local entry's repo becomes a path under repos/ — anything but "." or
    // a plain single segment must never reach git.
    for (const bad of ['../evil', '..', 'a/b', '']) {
      const file = prsFile(root, [{ repo: bad, mode: 'local', branch: 'feature/x', base: 'main' }]);
      await rejects(
        () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file], deps),
        `repo "${bad}" is rejected`,
        'invalid repo name',
      );
    }
    assertEq(gitFn.calls.filter((c) => c.args.includes('merge')).length, 0, 'nothing was merged from an invalid entry');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge refuses an empty or malformed PRs file and closes nothing');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const deps = { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) };
    const empty = join(root, 'empty.json');
    writeFileSync(empty, JSON.stringify({ prs: [], empty: ['app'] }));
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', empty, '--work-item', 'gh:163'], deps),
      'an empty PR list errors',
      'lists no PRs',
    );
    const malformed = join(root, 'malformed.json');
    writeFileSync(malformed, JSON.stringify({ empty: [] }));
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', malformed], deps),
      'a prs value that is not an array errors',
      'malformed',
    );
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', join(root, 'nope.json')], deps),
      'a missing file errors',
      'cannot read PRs file',
    );
    writeFileSync(join(root, 'garbage.json'), 'not json');
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', join(root, 'garbage.json')], deps),
      'an unparseable file errors',
      'cannot read PRs file',
    );
    assertEq(log.filter((e) => e.op === 'closeIssue').length, 0, 'no issue was closed by any refusal');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge re-run: PRs already merged count as done, and the completing run closes');
{
  const { root, bares } = makeLauncher({});
  try {
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false },
      { repo: '.', owner: 'acme', name: 'workspace', number: 3, id: 'acme/workspace#3', url: 'https://github.com/acme/workspace/pull/3', isWorkspace: true },
    ];
    const file = prsFile(root, prs);
    const log1 = [];
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--work-item', 'gh:163'],
        { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log1, { failMergeIds: ['acme/workspace#3'] }), trackerFactory: fakeTrackerFactory(log1) }),
      'the first run stops at the failed workspace merge',
      'Still open',
    );
    const log2 = [];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--work-item', 'gh:163'],
      { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log2, { mergedIds: ['acme/app#1'] }), trackerFactory: fakeTrackerFactory(log2) });
    assertEq(log2.filter((e) => e.op === 'prMerge').map((m) => m.id), ['acme/workspace#3'], 'only the still-open PR is merged');
    assertEq(out.merged.map((m) => m.repo), ['app', '.'], 'both PRs count as merged');
    assertEq(out.closed, 'gh:163', 'the issue closes on the completing run');
    assertEq(log2.find((e) => e.op === 'closeIssue').comment,
      'Merged: https://github.com/acme/app/pull/1 https://github.com/acme/workspace/pull/3',
      'the close comment names every merged URL');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a failed launcher pull is a reported flag, not a failed merge');
{
  const { root, bares } = makeLauncher({}, { launcherOrigin: true });
  try {
    const log = [];
    const prs = [{ repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false }];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs), '--work-item', 'gh:163'],
      { gitFn: gitWith([pullFails]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.pullFailed, true, 'the pull failure is flagged in the JSON');
    assertEq(out.closed, 'gh:163', 'the issue still closes once every PR merged');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# the pull is skipped when the launcher is not on its default branch');
{
  const { root, bares } = makeLauncher({});
  try {
    git(root, ['checkout', '-q', '-b', 'feature/side']);
    const log = [];
    const gitFn = gitWith([pullOk]);
    const prs = [{ repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false }];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs), '--work-item', 'gh:163'],
      { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.pullSkipped, 'launcher on feature/side', 'the skip names the branch the launcher is on');
    assertEq(gitFn.calls.filter((c) => c.args.includes('pull')).length, 0, 'no pull was attempted');
    assertEq(out.closed, 'gh:163', 'the issue still closes');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# the pull is skipped for a local workspace repo or a launcher with no upstream');
{
  // A project-only task whose workspace repo is local: no forge merge of
  // "." happened, so there is nothing for a launcher pull to fetch.
  const local = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    const wsPath = join(local.root, 'workspace.json');
    const ws = JSON.parse(readFileSync(wsPath, 'utf-8'));
    ws.workspace.merge = 'local';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    const log = [];
    const gitFn = gitWith([pullOk]);
    const prs = [{ repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false }];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', local.root, '--prs', prsFile(local.root, prs), '--work-item', 'gh:163'],
      { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.pullSkipped, 'workspace repo is local', 'the skip names the local workspace repo');
    assertEq(out.pullFailed, undefined, 'no false pullFailed');
    assertEq(gitFn.calls.filter((c) => c.args.includes('pull')).length, 0, 'no pull was attempted');
  } finally { clean(local.root); local.bares.forEach(clean); }

  // A launcher with an origin but no upstream for its default branch: the
  // pull would fail with "no tracking information", which is a skip, not a
  // failure of anything that mattered.
  const untracked = makeLauncher({ app: 'git@github.com:acme/app.git' }, { launcherOrigin: 'forge' });
  try {
    const log = [];
    const gitFn = gitWith([pullOk]);
    const prs = [{ repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false }];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', untracked.root, '--prs', prsFile(untracked.root, prs), '--work-item', 'gh:163'],
      { gitFn, forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.pullSkipped, 'launcher has no upstream', 'the skip names the missing upstream');
    assertEq(out.pullFailed, undefined, 'no false pullFailed');
    assertEq(gitFn.calls.filter((c) => c.args.includes('pull')).length, 0, 'no pull was attempted');
  } finally { clean(untracked.root); untracked.bares.forEach(clean); }
}

console.log('# --merge tolerates a UTF-8 BOM in the PRs file');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const prs = [{ repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false }];
    const bomFile = join(root, 'bom.json');
    writeFileSync(bomFile, `﻿${JSON.stringify({ prs, empty: [] })}`);
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', bomFile, '--work-item', 'gh:163'],
      { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.merged.map((m) => m.repo), ['app'], 'the BOM-prefixed file parses and merges');
  } finally { clean(root); bares.forEach(clean); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
