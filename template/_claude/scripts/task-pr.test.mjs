#!/usr/bin/env node
// Tests for task-pr.mjs
// Run: node .claude/scripts/task-pr.test.mjs
//
// Git runs for real under tmpdir (rev-list, remote get-url, log — the parts
// users get); push and pull are intercepted so nothing leaves the machine,
// and the forge and tracker are injected — fakes, or the real gitlab adapter
// over a mocked glab, matching the adapters' spawnFn pattern. Every git call
// is an argv array, never a shell string.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseArgs, parseForgeRemote, mergeModeFor, mergeApprovalFor } from './task-pr.mjs';
import { createGitlabAdapter } from './forges/gitlab.mjs';
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
// report PRs as already merged, hold pre-existing open PRs, fail PR
// creation per repo, answer prChecks per id (a function value answers
// per call — a poll that flips states), or report a PR's createdAt per id
// (what the young-'none' settle keys on). The per-repo config (type, host,
// repo) is logged so adapter selection is observable.
function fakeForgeFactory(log, {
  failMergeIds = [], mergedIds = [], openPrsFor = null, failCreateRepos = [], checks = {},
  createdAtFor = {},
} = {}) {
  let n = 0;
  const cfg = (config) => ({ type: config.type, host: config.host, repo: config.repo });
  return (config) => ({
    async prCreate({ title, body, head, base }) {
      if (failCreateRepos.includes(config.repo)) throw new Error('create rejected by the forge');
      n += 1;
      const number = 100 + n;
      log.push({ op: 'prCreate', ...cfg(config), title, body, head, base });
      return { id: `${config.repo}#${number}`, number, url: `https://github.com/${config.repo}/pull/${number}` };
    },
    async prList({ state, head, base }) {
      log.push({ op: 'prList', ...cfg(config), state, head, base });
      return (openPrsFor?.[config.repo] ?? [])
        .filter((p) => p.headRefName === head && (base ? p.baseRefName === base : true))
        .map((p) => ({
          id: `${config.repo}#${p.number}`, number: p.number, title: p.title ?? 'existing',
          url: p.url, headRefName: p.headRefName, baseRefName: p.baseRefName,
          mergedAt: null, state,
        }));
    },
    async prView({ id }) {
      log.push({ op: 'prView', ...cfg(config), id });
      return { id, state: mergedIds.includes(id) ? 'MERGED' : 'OPEN', number: Number(String(id).split('#')[1]), createdAt: createdAtFor[id] ?? null };
    },
    async prChecks({ id }) {
      // Default 'none' — no CI configured — so the gate stays transparent
      // for tests that do not care about checks.
      const base = checks[id];
      const result = typeof base === 'function'
        ? base()
        : (base ?? { state: 'none', url: `https://ci.example/${id}`, failing: [] });
      log.push({ op: 'prChecks', ...cfg(config), id, state: result.state });
      return result;
    },
    async prMerge({ id, strategy, deleteBranch }) {
      if (failMergeIds.includes(id)) throw new Error('merge rejected by the forge');
      log.push({ op: 'prMerge', ...cfg(config), id, strategy, deleteBranch });
      return { merged: true, url: `https://github.com/${config.repo}/pull/${id.split('#')[1]}` };
    },
  });
}

// A tracker factory that records calls; issueRef/issueUrl mirror the real
// adapters' contracts so the closing-line shape is observable end to end.
// `issueUrl: false` mimics github-issues (no issueUrl method — only the
// gitlab-issues adapter mints URLs).
function fakeTrackerFactory(log, { repo = 'acme/app', title = 'The issue title', issueUrl = false } = {}) {
  const url = (id) => `https://tracker.example/${id.replace(':', '/')}`;
  return () => ({
    async getIssue(id) { log.push({ op: 'getIssue', id }); return { id, title, url: url(id) }; },
    issueRef(id, { fromRepo } = {}) {
      log.push({ op: 'issueRef', id, fromRepo });
      return fromRepo && fromRepo !== repo ? `${repo}#${id.slice(3)}` : `#${id.slice(3)}`;
    },
    ...(issueUrl ? { issueUrl: url } : {}),
    async closeIssue(id, { comment } = {}) { log.push({ op: 'closeIssue', id, comment }); },
  });
}

const argvCreate = (extra = []) => ['node', 'task-pr.mjs', '--create', ...extra];

console.log('# parseForgeRemote shapes');
{
  const gh = { owner: 'acme', name: 'app', slug: 'acme/app', host: 'github.com', forge: 'github' };
  assertEq(parseForgeRemote('git@github.com:acme/app.git'), gh, 'ssh URL parses');
  assertEq(parseForgeRemote('https://github.com/acme/app.git'), gh, 'https URL parses');
  assertEq(parseForgeRemote('https://github.com/acme/app'), gh, 'https URL without .git parses');
  assertEq(parseForgeRemote('ssh://git@github.com/acme/app.git'), gh, 'ssh scheme URL parses');
  // GitLab nested groups: the slug keeps the full path, "owner" is the
  // namespace (any depth), "name" the project.
  assertEq(parseForgeRemote('git@gitlab.com:group/sub/proj.git'),
    { owner: 'group/sub', name: 'proj', slug: 'group/sub/proj', host: 'gitlab.com', forge: 'gitlab' }, 'gitlab ssh URL parses nested groups');
  assertEq(parseForgeRemote('https://gitlab.com/group/sub/proj'),
    { owner: 'group/sub', name: 'proj', slug: 'group/sub/proj', host: 'gitlab.com', forge: 'gitlab' }, 'gitlab https URL parses');
  assertEq(parseForgeRemote('ssh://git@gitlab.com/group/proj.git'),
    { owner: 'group', name: 'proj', slug: 'group/proj', host: 'gitlab.com', forge: 'gitlab' }, 'gitlab ssh scheme URL parses');
  // A self-managed host parses only when configured.
  assertEq(parseForgeRemote('git@gitlab.example.com:acme/app.git'), null, 'unconfigured host is not forge-hosted');
  assertEq(parseForgeRemote('git@gitlab.example.com:acme/app.git', { hosts: ['gitlab.example.com'] }),
    { owner: 'acme', name: 'app', slug: 'acme/app', host: 'gitlab.example.com', forge: 'gitlab' }, 'configured self-managed host parses');
  // Ports: an explicit non-default port stays in the host (so a configured
  // host carries it); a default port drops.
  assertEq(parseForgeRemote('https://gitlab.example.com:8443/team/deep/inner.git', { hosts: ['gitlab.example.com:8443'] }),
    { owner: 'team/deep', name: 'inner', slug: 'team/deep/inner', host: 'gitlab.example.com:8443', forge: 'gitlab' }, 'non-default port stays in the host');
  assertEq(parseForgeRemote('https://gitlab.example.com:8443/team/inner.git', { hosts: ['gitlab.example.com'] }),
    null, 'a port-carrying host does not match a bare host entry');
  assertEq(parseForgeRemote('https://github.com:443/acme/app.git'), gh, 'a default port drops');
  assertEq(parseForgeRemote('/tmp/origin.git'), null, 'local path is not forge-hosted');
  assertEq(parseForgeRemote('file:///srv/bare/app.git'), null, 'file URL is not forge-hosted');
  assertEq(parseForgeRemote('git@gitlab.com:solo.git'), null, 'a namespace-less gitlab path is not forge-hosted');
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

console.log('# mergeApprovalFor: default ask, per-repo and workspace overrides, typo throws');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git' });
  try {
    assertEq(mergeApprovalFor(root, 'app'), 'ask', 'absent resolves to ask');
    assertEq(mergeApprovalFor(root, '.'), 'ask', 'absent resolves to ask for the workspace repo');

    const wsPath = join(root, 'workspace.json');
    const ws = JSON.parse(readFileSync(wsPath, 'utf-8'));
    ws.repos.app.mergeApproval = 'operator';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    assertEq(mergeApprovalFor(root, 'app'), 'operator', 'repos.{repo}.mergeApproval overrides');
    assertEq(mergeApprovalFor(root, '.'), 'ask', "a repo's override does not leak to the workspace repo");

    ws.workspace.mergeApproval = 'operator';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    assertEq(mergeApprovalFor(root, '.'), 'operator', 'workspace.mergeApproval overrides for the workspace repo');

    ws.repos.app.mergeApproval = 'auto';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));
    let err = null;
    try { mergeApprovalFor(root, 'app'); } catch (e) { err = e; }
    assert(err && /repos\.app\.mergeApproval/.test(err.message), `a typo throws naming the setting: ${err?.message}`);
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --create stamps each entry with its resolved mergeApproval');
{
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git', lone: 'none' });
  try {
    const wsPath = join(root, 'workspace.json');
    const ws = JSON.parse(readFileSync(wsPath, 'utf-8'));
    ws.repos.app.mergeApproval = 'operator';
    writeFileSync(wsPath, JSON.stringify(ws, null, 2));

    for (const repo of ['app', 'lone']) {
      const wt = createTaskWorktree(root, { repo, branch: 'feature/x' });
      git(wt.path, ['commit', '-q', '--allow-empty', '-m', `feat: ${repo}`]);
    }
    const bodyFile = join(root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');
    const log = [];
    const out = await run(argvCreate(['--root', root, '--branch', 'feature/x', '--repo', 'app', '--repo', 'lone', '--body-file', `app=${bodyFile}`]),
      { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.prs.map((p) => [p.repo, p.mergeApproval]), [['lone', 'ask'], ['app', 'operator']], 'each entry carries its resolved policy');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a mixed GitHub/GitLab workspace: one forge adapter per repo, chosen by its origin');
{
  // The workspace block names an explicit github type AND a self-managed
  // gitlab host — neither can speak for every repo, so each origin wins.
  const { root, bares } = makeLauncher({
    app: 'git@github.com:acme/app.git',
    gl: 'git@gitlab.com:group/sub/gl.git',
    hosted: 'git@gitlab.example.com:team/deep/inner.git',
  }, {
    forge: { type: 'github', host: 'gitlab.example.com' },
    tracker: { type: 'gitlab-issues', repo: 'group/sub/gl' },
  });
  try {
    assertEq(mergeModeFor(root, 'app'), 'forge', 'a github.com origin is forge mode');
    assertEq(mergeModeFor(root, 'gl'), 'forge', 'a gitlab.com origin is forge mode');
    assertEq(mergeModeFor(root, 'hosted'), 'forge', 'the configured self-managed gitlab origin is forge mode');

    for (const repo of ['app', 'gl', 'hosted']) {
      const wt = createTaskWorktree(root, { repo, branch: 'feature/x' });
      writeFileSync(join(wt.path, 'work.txt'), 'done\n');
      git(wt.path, ['add', '-A']);
      git(wt.path, ['commit', '-q', '-m', 'feat: do the thing']);
      writeFileSync(join(root, `body-${repo}.md`), `Summary for ${repo}.\n`);
    }

    const log = [];
    const out = await run(argvCreate([
      '--root', root, '--branch', 'feature/x', '--work-item', 'gl:7',
      '--repo', 'app', '--repo', 'gl', '--repo', 'hosted',
      '--body-file', `app=${join(root, 'body-app.md')}`,
      '--body-file', `gl=${join(root, 'body-gl.md')}`,
      '--body-file', `hosted=${join(root, 'body-hosted.md')}`,
    ]), { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log, { repo: 'group/sub/gl', issueUrl: true }) });

    const creates = log.filter((e) => e.op === 'prCreate');
    assertEq(creates.map((c) => [c.repo, c.type, c.host]), [
      ['acme/app', 'github', 'github.com'],
      ['group/sub/gl', 'gitlab', 'gitlab.com'],
      ['team/deep/inner', 'gitlab', 'gitlab.example.com'],
    ], 'each repo got a forge matching its origin, not the workspace type');
    // The GitHub PR cannot resolve the GitLab tracker's `group/sub#N`
    // reference, so its closing line is the issue URL the tracker mints;
    // the GitLab PR — same project as the issue — keeps the native ref,
    // and the self-managed one names the tracker project (same forge).
    assertEq(log.filter((e) => e.op === 'issueRef').map((e) => e.fromRepo),
      ['acme/app', 'group/sub/gl', 'team/deep/inner'], 'issueRef got each PR repo as fromRepo');
    assert(creates[0].body.endsWith('Closes https://tracker.example/gl/7\n'), `cross-forge closing line: ${JSON.stringify(creates[0].body)}`);
    assert(creates[1].body.endsWith('Closes #7\n'), `same-project closing line: ${JSON.stringify(creates[1].body)}`);
    assert(creates[2].body.endsWith('Closes group/sub/gl#7\n'), `cross-project closing line: ${JSON.stringify(creates[2].body)}`);
    assertEq(out.prs.map((p) => [p.repo, p.forge, p.host]), [
      ['app', 'github', 'github.com'],
      ['gl', 'gitlab', 'gitlab.com'],
      ['hosted', 'gitlab', 'gitlab.example.com'],
    ], 'PR entries carry the per-repo forge and host');

    // --merge rebuilds the same per-repo forges from what --create wrote.
    const file = join(root, 'prs-mixed.json');
    writeFileSync(file, JSON.stringify(out));
    const mergeLog = [];
    const merged = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file],
      { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(mergeLog), trackerFactory: fakeTrackerFactory(mergeLog) });
    assertEq(mergeLog.filter((m) => m.op === 'prMerge').map((m) => [m.repo, m.type]), [
      ['acme/app', 'github'],
      ['group/sub/gl', 'gitlab'],
      ['team/deep/inner', 'gitlab'],
    ], '--merge rebuilds each repo forge from the entry');
    assertEq(merged.merged.length, 3, 'all three PRs merged');
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
      worktree: taskWorktreePath(root, 'app', 'feature/two'), commits: 1, mergeApproval: 'ask',
    }], 'the count is against the local main, not the stale origin ref');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# parseArgs validation');
{
  await rejects(() => run(['node', 'task-pr.mjs']), 'one of --create, --merge, --checks is required');
  await rejects(() => run(argvCreate(['--root', '/w'])), '--create needs a branch');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b'])), '--create needs repos');
  await rejects(() => run(['node', 'task-pr.mjs', '--merge', '--root', '/w']), '--merge requires --prs');
  await rejects(() => run(['node', 'task-pr.mjs', '--checks', '--root', '/w']), '--checks requires --prs');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b', '--repo', 'app', '--prs', 'x.json'])), '--prs rejected with --create');
  await rejects(() => run(['node', 'task-pr.mjs', '--merge', '--root', '/w', '--prs', 'x.json', '--force-with-lease']), '--force-with-lease rejected with --merge');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b', '--repo', 'app', '--body-file', 'nopath'])), '--body-file needs repo=path');
  await rejects(() => run(['node', 'task-pr.mjs', '--merge', '--root', '/w', '--prs', 'x.json', '--out', 'y.json']), '--out rejected with --merge');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b', '--repo', 'app', '--bogus'])), 'unknown flag rejected');
  // The check-gate flags are --merge's alone, and --wait-timeout rides on --wait.
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b', '--repo', 'app', '--skip-checks'])), '--skip-checks rejected with --create');
  await rejects(() => run(argvCreate(['--root', '/w', '--branch', 'b', '--repo', 'app', '--approved'])), '--approved rejected with --create');
  await rejects(() => run(['node', 'task-pr.mjs', '--merge', '--root', '/w', '--prs', 'x.json', '--wait-timeout', '10']), '--wait-timeout needs --wait');
  await rejects(() => run(['node', 'task-pr.mjs', '--merge', '--root', '/w', '--prs', 'x.json', '--wait', '--wait-timeout', 'soon']), 'wait-timeout needs a number');
  await rejects(() => run(['node', 'task-pr.mjs', '--checks', '--root', '/w', '--prs', 'x.json', '--wait']), '--wait rejected with --checks');
  await rejects(() => run(['node', 'task-pr.mjs', '--checks', '--root', '/w', '--prs', 'x.json', '--approved']), '--approved rejected with --checks');
  const ok = parseArgs(['node', 's', '--create', '--root', '/w', '--branch', 'feature/x',
    '--work-item', 'gh:163', '--repo', 'app', '--repo', '.', '--body-file', 'app=/tmp/a.md', '--body-file', '.=/tmp/w.md',
    '--out', '/tmp/prs.json']);
  assertEq([ok.mode, ok.branch, ok.workItem, ok.repos, ok.out], ['create', 'feature/x', 'gh:163', ['app', '.'], '/tmp/prs.json'], 'repeated --repo accumulates');
  assertEq([...ok.bodyFiles.entries()], [['app', '/tmp/a.md'], ['.', '/tmp/w.md']], 'body files map repo to path');
  const waiting = parseArgs(['node', 's', '--merge', '--root', '/w', '--prs', 'x.json', '--wait', '--wait-timeout', '15', '--skip-checks', '--approved']);
  assertEq([waiting.mode, waiting.wait, waiting.waitTimeout, waiting.skipChecks, waiting.approved], ['merge', true, '15', true, true], 'merge flags parse');
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
    let urlParses = false;
    try { urlParses = new URL(out.prs[0].url).protocol === 'https:'; } catch { /* not a URL */ }
    assert(typeof out.prs[0].number === 'number' && urlParses, 'PR entry carries number and url');
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

console.log('# --create cross-forge: the closing line carries the issue URL, not an unresolvable reference');
{
  // GitHub tracker + GitLab repo: `owner/repo#N` cannot resolve on GitLab,
  // and github-issues has no issueUrl — the line falls back to Refs with
  // the URL getIssue returned.
  const gh = makeLauncher({ app: 'git@gitlab.com:group/sub/app.git' }, {
    tracker: { type: 'github-issues', repo: 'acme/tracker' }, forge: { type: 'gitlab' },
  });
  try {
    const wt = createTaskWorktree(gh.root, { repo: 'app', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'work.txt'), 'done\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'feat: do the thing']);
    const bodyFile = join(gh.root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');
    const log = [];
    await run(argvCreate(['--root', gh.root, '--branch', 'feature/x', '--work-item', 'gh:163',
      '--repo', 'app', '--body-file', `app=${bodyFile}`]),
      { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log, { repo: 'acme/tracker' }) });
    const create = log.find((e) => e.op === 'prCreate');
    assert(create.body.endsWith('Refs https://tracker.example/gh/163\n'),
      `cross-forge fallback line: ${JSON.stringify(create.body)}`);
  } finally { clean(gh.root); gh.bares.forEach(clean); }

  // GitLab tracker + GitHub repo: the gitlab-issues adapter mints URLs
  // (issueUrl), so the same situation still closes — by URL.
  const gl = makeLauncher({ app: 'git@github.com:acme/app.git' }, {
    tracker: { type: 'gitlab-issues', repo: 'group/tracker' },
  });
  try {
    const wt = createTaskWorktree(gl.root, { repo: 'app', branch: 'feature/x' });
    writeFileSync(join(wt.path, 'work.txt'), 'done\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-q', '-m', 'feat: do the thing']);
    const bodyFile = join(gl.root, 'body-app.md');
    writeFileSync(bodyFile, 'Summary.\n');
    const log = [];
    await run(argvCreate(['--root', gl.root, '--branch', 'feature/x', '--work-item', 'gl:7',
      '--repo', 'app', '--body-file', `app=${bodyFile}`]),
      { gitFn: gitWith([pushOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log, { repo: 'group/tracker', issueUrl: true }) });
    const create = log.find((e) => e.op === 'prCreate');
    assert(create.body.endsWith('Closes https://tracker.example/gl/7\n'),
      `cross-forge URL close line: ${JSON.stringify(create.body)}`);
  } finally { clean(gl.root); gl.bares.forEach(clean); }
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
      worktree: taskWorktreePath(root, 'app', 'feature/x'), commits: 1, mergeApproval: 'ask',
    }], 'a local entry is recorded instead of a PR');
    assertEq(log.filter((e) => e.op.startsWith('pr')).length, 0, 'the forge was never consulted');
    assertEq(gitFn.calls.filter((c) => c.args.includes('push')).length, 0, 'no push was attempted');

    const file = prsFile(root, out.prs);
    const deps = { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) };
    const merged = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--work-item', 'gh:173'], deps);
    assertEq(merged.merged, [{ repo: 'app', mode: 'local', branch: 'feature/x', base: 'main' }], 'the local merge is reported');
    assertEq(log.filter((e) => e.op === 'prChecks').length, 0, 'a local entry never reads checks');
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

// The "repo: url" entries of a merge-stopped error's Still-open clause,
// parsed out so tests compare the list exactly — a substring check against
// a URL is what CodeQL's incomplete-url-substring-sanitization flags.
function stillOpenFrom(err) {
  const clause = err?.message.split('Still open: ')[1]?.split('. The workspace repo')[0] ?? '';
  return clause.split(', ').filter(Boolean);
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
    let err = null;
    try {
      await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs)],
        { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log, { failMergeIds: ['acme/workspace#3'] }), trackerFactory: fakeTrackerFactory(log) });
    } catch (e) { err = e; }
    assert(err && /merge stopped/.test(err.message), `failed workspace merge errors: ${err?.message}`);
    assertEq(stillOpenFrom(err), ['.: https://github.com/acme/workspace/pull/3'],
      'the workspace PR is reported as still open');
    assertEq(log.filter((e) => e.op === 'prMerge').length, 1, 'only the project PR merged');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a queued GitLab MR merge (glab exits 0, MR still open) stops the whole run — e2e');
{
  // The real gitlab adapter runs against a mocked glab: the project MR's
  // merge only queues behind a running pipeline (glab exits 0, the MR stays
  // OPEN), so --merge must stop before the workspace MR, close nothing, and
  // report both PRs as still open — the CLI exits non-zero on this
  // rejection.
  const { root, bares } = makeLauncher({});
  try {
    const mr = (n, repo, over = {}) => JSON.stringify({
      iid: n, title: 'The MR', state: 'opened', draft: false,
      source_branch: 'feature/x', target_branch: 'main',
      web_url: `https://gitlab.com/${repo}/-/merge_requests/${n}`,
      detailed_merge_status: 'ci_still_running', merged_at: null, has_conflicts: false,
      ...over,
    });
    const glabCalls = [];
    const spawnFn = (cmd, args) => {
      const key = args.join(' ');
      glabCalls.push(key);
      if (key === 'mr view 1 --repo acme/app --output json') return { status: 0, stdout: mr(1, 'acme/app'), stderr: '' };
      // The check gate reads the MR's head pipeline through glab api —
      // green, so the merge is attempted and the queue trap plays out.
      if (key === 'api projects/acme%2Fapp/merge_requests/1 --hostname gitlab.com') {
        return {
          status: 0,
          stdout: mr(1, 'acme/app', { head_pipeline: { id: 7, status: 'success', web_url: 'https://gitlab.com/acme/app/-/pipelines/7' } }),
          stderr: '',
        };
      }
      // The gate reads every not-yet-merged entry up front, the workspace
      // MR included — no pipeline there, so 'none' (its view reports no
      // created_at, keeping the young-'none' settle out of the test).
      if (key === 'api projects/acme%2Fworkspace/merge_requests/3 --hostname gitlab.com') {
        return { status: 0, stdout: mr(3, 'acme/workspace'), stderr: '' };
      }
      // The queued merge: glab exits 0, but the MR never landed.
      if (key === 'mr merge 1 --repo acme/app --yes --auto-merge=false --squash --remove-source-branch') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (key === 'mr view 3 --repo acme/workspace --output json') return { status: 0, stdout: mr(3, 'acme/workspace'), stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected glab call: ${key}` };
    };
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app!1',
        url: 'https://gitlab.com/acme/app/-/merge_requests/1', isWorkspace: false, forge: 'gitlab' },
      { repo: '.', owner: 'acme', name: 'workspace', number: 3, id: 'acme/workspace!3',
        url: 'https://gitlab.com/acme/workspace/-/merge_requests/3', isWorkspace: true, forge: 'gitlab' },
    ];
    const log = [];
    let err = null;
    try {
      await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs), '--work-item', 'gh:163'],
        { gitFn: gitWith(), forgeFactory: (config) => createGitlabAdapter(config, { spawnFn }), trackerFactory: fakeTrackerFactory(log) });
    } catch (e) { err = e; }
    assert(err && /queued, not applied/.test(err.message), `the queued merge stops the run: ${err?.message}`);
    assertEq(stillOpenFrom(err), [
      'app: https://gitlab.com/acme/app/-/merge_requests/1',
      '.: https://gitlab.com/acme/workspace/-/merge_requests/3',
    ], 'both PRs are listed as still open');
    assertEq(glabCalls.filter((c) => c.startsWith('mr merge')),
      ['mr merge 1 --repo acme/app --yes --auto-merge=false --squash --remove-source-branch'],
      'only the project MR merge was attempted — the workspace MR was never touched');
    assertEq(log.filter((e) => e.op === 'closeIssue').length, 0, 'the issue was not closed');
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

console.log('# --merge: a red project PR stops the run before any merge — green siblings included');
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
        { gitFn, forgeFactory: fakeForgeFactory(log, {
          checks: {
            'acme/app#1': { state: 'success', url: 'https://ci.example/1', failing: [] },
            'acme/api#2': { state: 'failure', url: 'https://ci.example/2', failing: [{ name: 'test', url: 'https://ci.example/2/test' }] },
          },
        }), trackerFactory: fakeTrackerFactory(log) }),
      'a failing check stops the merge',
      'nothing merged',
    );
    // The pre-flight gate reads every entry up front and merges nothing:
    // even the green PR ahead of the red one stays open.
    assertEq(log.filter((e) => e.op === 'prMerge').length, 0, 'nothing at all merged');
    assertEq(log.filter((e) => e.op === 'prChecks').map((e) => e.id),
      ['acme/app#1', 'acme/api#2', 'acme/workspace#3'], 'every entry was checked first');
    assertEq(gitFn.calls.filter((c) => c.args.includes('pull')).length, 0, 'no pull after red CI');
    assertEq(log.filter((e) => e.op === 'closeIssue').length, 0, 'no issue close after red CI');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge: a red workspace PR stops the run with the green projects unmerged');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false },
      { repo: '.', owner: 'acme', name: 'workspace', number: 3, id: 'acme/workspace#3', url: 'https://github.com/acme/workspace/pull/3', isWorkspace: true },
    ];
    let err = null;
    try {
      await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs), '--work-item', 'gh:163'],
        { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log, {
          checks: {
            'acme/app#1': { state: 'success', url: 'https://ci.example/1', failing: [] },
            'acme/workspace#3': { state: 'failure', url: 'https://ci.example/3', failing: [{ name: 'docs', url: 'https://ci.example/3/docs' }] },
          },
        }), trackerFactory: fakeTrackerFactory(log) });
    } catch (e) { err = e; }
    assert(err && /nothing merged/.test(err.message), `the red workspace PR stops the run: ${err?.message}`);
    assert(/app: success/.test(err.message) && /\.: failure/.test(err.message), `every entry's state is listed: ${err?.message}`);
    assertEq(log.filter((e) => e.op === 'prMerge').length, 0, 'the green project PR was not merged either');
    assertEq(log.filter((e) => e.op === 'closeIssue').length, 0, 'nothing closed');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge: pending checks stop the run; --wait polls to green');
{
  const { root, bares } = makeLauncher({});
  try {
    const file = prsFile(root, [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false },
    ]);
    const stopped = [];
    await rejects(
      () => run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file],
        { gitFn: gitWith(), forgeFactory: fakeForgeFactory(stopped, { checks: { 'acme/app#1': { state: 'pending', url: 'https://ci.example/1' } } }), trackerFactory: fakeTrackerFactory(stopped) }),
      'pending checks stop the merge',
      'nothing merged',
    );
    assertEq(stopped.filter((e) => e.op === 'prMerge').length, 0, 'nothing merged while pending');

    const log = [];
    let reads = 0;
    const sleeps = [];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--wait'],
      { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log, {
        checks: { 'acme/app#1': () => ({ state: reads++ >= 2 ? 'success' : 'pending', url: 'https://ci.example/1', failing: [] }) },
      }), trackerFactory: fakeTrackerFactory(log), sleepFn: (ms) => { sleeps.push(ms); } });
    assertEq(out.merged.map((m) => m.repo), ['app'], 'the PR merged once checks turned green');
    assertEq(sleeps, [20000, 20000], 'polling waited the interval between reads');
    assertEq(log.filter((e) => e.op === 'prChecks').length, 4, 'four reads: two pending, green, and the confirming sweep');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge --wait gives up at --wait-timeout and stays re-runnable');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    let err = null;
    try {
      await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, [
        { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'u1', isWorkspace: false },
      ]), '--wait', '--wait-timeout', '0.001'],
        { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log, { checks: { 'acme/app#1': { state: 'pending', url: 'https://ci.example/1' } } }), trackerFactory: fakeTrackerFactory(log), sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    } catch (e) { err = e; }
    assert(err && /still pending after 0\.001 minutes/i.test(err.message), `the timeout names the bound: ${err?.message}`);
    assertEq(log.filter((e) => e.op === 'prMerge').length, 0, 'nothing merged at the timeout');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --wait re-reads every entry before merging — a green that went red during the wait is caught');
{
  // The confirming sweep: app turns green on its second read and red on
  // its third; api lags one poll and lands green. Without one last read of
  // everything, app's early green would stand and both PRs would merge.
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const reads = { 'acme/app#1': 0, 'acme/api#2': 0 };
    const plan = {
      'acme/app#1': ['pending', 'success', 'failure'],
      'acme/api#2': ['pending', 'pending', 'success', 'success'],
    };
    const sleeps = [];
    let err = null;
    try {
      await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, [
        { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://ci.example/1', isWorkspace: false },
        { repo: 'api', owner: 'acme', name: 'api', number: 2, id: 'acme/api#2', url: 'https://ci.example/2', isWorkspace: false },
      ]), '--wait'],
        { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log, {
          checks: {
            'acme/app#1': () => { reads['acme/app#1'] += 1; return { state: plan['acme/app#1'][reads['acme/app#1'] - 1] ?? 'success', url: 'https://ci.example/1', failing: [] }; },
            'acme/api#2': () => { reads['acme/api#2'] += 1; return { state: plan['acme/api#2'][reads['acme/api#2'] - 1] ?? 'success', url: 'https://ci.example/2', failing: [] }; },
          },
        }), trackerFactory: fakeTrackerFactory(log), sleepFn: (ms) => { sleeps.push(ms); } });
    } catch (e) { err = e; }
    assert(err && /nothing merged/.test(err.message), `the red flip stops the merge: ${err?.message}`);
    assert(/app: failure/.test(err.message) && /api: success/.test(err.message), `both states are listed: ${err?.message}`);
    assertEq(log.filter((e) => e.op === 'prMerge').length, 0, 'nothing merged');
    assertEq(sleeps, [20000, 20000], 'two poll rounds before the sweep');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge --skip-checks bypasses the gate and says so in the output');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'u1', isWorkspace: false },
    ]), '--skip-checks'],
      { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log, {
        checks: { 'acme/app#1': { state: 'failure', url: 'https://ci.example/1', failing: [{ name: 'test', url: 'https://ci.example/1/test' }] } },
      }), trackerFactory: fakeTrackerFactory(log) });
    assertEq(log.filter((e) => e.op === 'prChecks').length, 0, 'checks were never read');
    assertEq(out.checksSkipped, true, 'the skip is recorded in the JSON');
    assertEq(out.merged.map((m) => m.repo), ['app'], 'the merge proceeded anyway');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# an operator merge in the forge UI: --merge re-runs clean, closing and reporting');
{
  // gh:202's operator path: the PRs were merged by hand in the forge UI.
  // The re-run detects them merged — skipping the operator refusal (no
  // --approved needed: the operator already acted), the merge, and the
  // check gate; red CI on an already-merged PR must not block — and
  // finishes the pull and the close.
  const { root, bares } = makeLauncher({}, { launcherOrigin: true });
  try {
    const log = [];
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false, mergeApproval: 'operator' },
      { repo: '.', owner: 'acme', name: 'workspace', number: 3, id: 'acme/workspace#3', url: 'https://github.com/acme/workspace/pull/3', isWorkspace: true, mergeApproval: 'operator' },
    ];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs), '--work-item', 'gh:163'],
      { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log, {
        mergedIds: ['acme/app#1', 'acme/workspace#3'],
        checks: { 'acme/workspace#3': { state: 'failure', url: 'https://ci.example/3', failing: [] } },
      }), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out.merged.map((m) => m.repo), ['app', '.'], 'both PRs count as merged');
    assertEq(log.filter((e) => e.op === 'prMerge').length, 0, 'nothing re-merged');
    assertEq(log.filter((e) => e.op === 'prChecks').length, 0, 'an already-merged PR reads no checks');
    assertEq(out.closed, 'gh:163', 'the re-run completed the close');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --merge refuses an operator entry without --approved — one governs the whole task');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    // app is the operator repo, api only "ask" — one operator entry is
    // enough to hold the whole task, api's PR included.
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'u1', isWorkspace: false, mergeApproval: 'operator' },
      { repo: 'api', owner: 'acme', name: 'api', number: 2, id: 'acme/api#2', url: 'u2', isWorkspace: false, mergeApproval: 'ask' },
    ];
    const file = prsFile(root, prs);
    const deps = { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) };
    let err = null;
    try {
      await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file], deps);
    } catch (e) { err = e; }
    assert(err && /mergeApproval "operator" is set for app/.test(err.message) && /--approved/.test(err.message),
      `the refusal names the policy and the remedy: ${err?.message}`);
    assertEq(log.filter((e) => e.op === 'prMerge').length, 0, 'nothing merged by the refusal — the ask entry included');
    assertEq(log.filter((e) => e.op === 'prChecks').length, 0, 'approval comes first: checks were not even read');

    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--approved'], deps);
    assertEq(out.merged.map((m) => m.repo), ['app', 'api'], 'the approved run merges every entry');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a v0.23 PRs file — entries with no mergeApproval field — reads as ask');
{
  // Entries from before gh:202 carry no mergeApproval; they must keep
  // completing without --approved, exactly as they did when written.
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const prs = [
      { repo: 'app', mode: 'forge', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false },
    ];
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, prs), '--work-item', 'gh:163'],
      { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) });
    assertEq(log.filter((e) => e.op === 'prMerge').length, 1, 'the pre-feature file merges without --approved');
    assertEq(out.merged.map((m) => m.repo), ['app'], 'the entry is treated as ask, not operator');
    assertEq(out.closed, 'gh:163', 'the issue closed');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a local operator entry already contained in its default branch needs no --approved');
{
  // The local-mode twin of a forge-UI merge: once the branch is in the
  // source clone's default branch — by hand or an earlier run — the entry
  // is done, and the refusal would only block the finishing run.
  const { root, bares } = makeLauncher({ app: 'git@github.com:acme/app.git', lone: 'none' });
  try {
    const wt = createTaskWorktree(root, { repo: 'lone', branch: 'feature/x' });
    git(wt.path, ['commit', '-q', '--allow-empty', '-m', 'feat: lone']);
    const log = [];
    const prs = [
      { repo: 'lone', mode: 'local', branch: 'feature/x', base: 'main', mergeApproval: 'operator' },
      { repo: 'app', mode: 'forge', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'https://github.com/acme/app/pull/1', isWorkspace: false, mergeApproval: 'ask' },
    ];
    const file = prsFile(root, prs);
    const deps = { gitFn: gitWith([pullOk]), forgeFactory: fakeForgeFactory(log), trackerFactory: fakeTrackerFactory(log) };
    let err = null;
    try {
      await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--work-item', 'gh:173'], deps);
    } catch (e) { err = e; }
    assert(err && /mergeApproval "operator" is set for lone/.test(err.message), `an unmerged local operator entry still refuses: ${err?.message}`);
    assertEq(log.filter((e) => e.op === 'prMerge').length, 0, 'nothing merged by the refusal');

    git(join(root, 'repos', 'lone'), ['merge', '-q', '--ff-only', 'feature/x']);
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', file, '--work-item', 'gh:173'], deps);
    assertEq(out.merged.map((m) => m.repo), ['lone', 'app'], 'the contained entry finishes the run without --approved');
    assertEq(out.closed, 'gh:173', 'the issue closed');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# a young PR reporting no checks is re-read before "none" is accepted');
{
  const { root, bares } = makeLauncher({});
  try {
    const fresh = new Date(Date.now() - 5000).toISOString();
    const log = [];
    const sleeps = [];
    let reads = 0;
    const out = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'u1', isWorkspace: false },
    ])], {
      gitFn: gitWith(),
      forgeFactory: fakeForgeFactory(log, {
        createdAtFor: { 'acme/app#1': fresh },
        checks: { 'acme/app#1': () => (++reads === 3
          ? { state: 'success', url: 'https://ci.example/1', failing: [] }
          : { state: 'none', url: 'https://ci.example/1', failing: [] }) },
      }),
      trackerFactory: fakeTrackerFactory(log),
      sleepFn: (ms) => { sleeps.push(ms); },
    });
    assertEq(out.merged.map((m) => m.repo), ['app'], 'the race resolved to green and the PR merged');
    assertEq(sleeps, [30000, 30000], 'two settle pauses before believing a young none');
    assertEq(log.filter((e) => e.op === 'prChecks').length, 3, 'three reads: none, none, success');

    // A young 'none' that stays none through both retries is accepted —
    // the PR genuinely has no CI.
    const stays = [];
    let stayReads = 0;
    const out2 = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, [
      { repo: 'app', owner: 'acme', name: 'app', number: 2, id: 'acme/app#2', url: 'u2', isWorkspace: false },
    ])], {
      gitFn: gitWith(),
      forgeFactory: fakeForgeFactory(stays, {
        createdAtFor: { 'acme/app#2': fresh },
        checks: { 'acme/app#2': () => { stayReads += 1; return { state: 'none', url: 'https://ci.example/2', failing: [] }; } },
      }),
      trackerFactory: fakeTrackerFactory(stays),
      sleepFn: (ms) => { stays.push(`sleep:${ms}`); },
    });
    assertEq(out2.merged.map((m) => m.repo), ['app'], 'a none that survives the settle is a verdict');
    assertEq(stays.filter((s) => String(s).startsWith('sleep:')), ['sleep:30000', 'sleep:30000'], 'both settle pauses were taken');
    assertEq(stayReads, 3, 'three reads: none, none, none');

    // An old PR's 'none' is accepted at once — no pause, no re-read.
    const old = [];
    const out3 = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, [
      { repo: 'app', owner: 'acme', name: 'app', number: 3, id: 'acme/app#3', url: 'u3', isWorkspace: false },
    ])], {
      gitFn: gitWith(),
      forgeFactory: fakeForgeFactory(old, { createdAtFor: { 'acme/app#3': new Date(Date.now() - 10 * 60000).toISOString() } }),
      trackerFactory: fakeTrackerFactory(old),
      sleepFn: (ms) => { old.push(`sleep:${ms}`); },
    });
    assertEq(out3.merged.map((m) => m.repo), ['app'], 'an old none merges at once');
    assertEq(old.filter((s) => String(s).startsWith('sleep:')), [], 'no settle for a PR old enough to know its own mind');
    assertEq(old.filter((e) => e.op === 'prChecks').length, 1, 'a single read');

    // Two young 'none's settle together — one pause per round serves both,
    // and an entry that stops reading 'none' stops being re-read.
    const pair = [];
    const pairReads = { 'acme/app#4': 0, 'acme/api#5': 0 };
    const out4 = await run(['node', 'task-pr.mjs', '--merge', '--root', root, '--prs', prsFile(root, [
      { repo: 'app', owner: 'acme', name: 'app', number: 4, id: 'acme/app#4', url: 'u4', isWorkspace: false },
      { repo: 'api', owner: 'acme', name: 'api', number: 5, id: 'acme/api#5', url: 'u5', isWorkspace: false },
    ])], {
      gitFn: gitWith(),
      forgeFactory: fakeForgeFactory(pair, {
        createdAtFor: { 'acme/app#4': fresh, 'acme/api#5': fresh },
        checks: {
          'acme/app#4': () => { pairReads['acme/app#4'] += 1; return { state: pairReads['acme/app#4'] >= 2 ? 'success' : 'none', url: 'https://ci.example/4', failing: [] }; },
          'acme/api#5': () => { pairReads['acme/api#5'] += 1; return { state: 'none', url: 'https://ci.example/5', failing: [] }; },
        },
      }),
      trackerFactory: fakeTrackerFactory(pair),
      sleepFn: (ms) => { pair.push(`sleep:${ms}`); },
    });
    assertEq(out4.merged.map((m) => m.repo), ['app', 'api'], 'both settled entries merge');
    assertEq(pair.filter((s) => String(s).startsWith('sleep:')), ['sleep:30000', 'sleep:30000'], 'one shared pause per round, not per PR');
    assertEq(pairReads, { 'acme/app#4': 2, 'acme/api#5': 3 }, 'the flipped entry stopped being re-read');
  } finally { clean(root); bares.forEach(clean); }
}

console.log('# --checks reads each entry state: forge through the adapter, local none');
{
  const { root, bares } = makeLauncher({});
  try {
    const log = [];
    const prs = [
      { repo: 'app', owner: 'acme', name: 'app', number: 1, id: 'acme/app#1', url: 'u1', isWorkspace: false },
      { repo: 'lone', mode: 'local', branch: 'feature/x', base: 'main' },
    ];
    const out = await run(['node', 'task-pr.mjs', '--checks', '--root', root, '--prs', prsFile(root, prs)],
      { gitFn: gitWith(), forgeFactory: fakeForgeFactory(log, { checks: { 'acme/app#1': { state: 'pending', url: 'https://ci.example/1', failing: [], note: 'pipeline waiting on a manual job' } } }), trackerFactory: fakeTrackerFactory(log) });
    assertEq(out, { checks: [
      { repo: 'app', mode: 'forge', state: 'pending', url: 'https://ci.example/1', failing: [], note: 'pipeline waiting on a manual job' },
      { repo: 'lone', mode: 'local', state: 'none', url: null, failing: [] },
    ] }, 'one check line per entry');
    assertEq(log.filter((e) => e.op === 'prMerge').length, 0, 'nothing merged by --checks');
    assertEq(log.filter((e) => e.op === 'closeIssue').length, 0, 'nothing closed by --checks');
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
