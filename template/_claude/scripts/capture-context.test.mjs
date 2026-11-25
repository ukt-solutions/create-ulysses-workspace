#!/usr/bin/env node
// Tests for capture-context.mjs
// Run: node template/_claude/scripts/capture-context.test.mjs
//
// Two layers. The unit cases call the exported functions directly, with git
// scripted wherever the root guard needs an answer. The CLI cases spawn the
// real script: three against a plain temp directory, which is no repository,
// and the root-guard block against a real repository taken through the
// states a workspace root and its worktrees pass through.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  validate,
  computeDir,
  computeBaseFilename,
  resolveCollision,
  buildFrontmatter,
  renderFrontmatter,
  isDefaultBranchCheckout,
  plan,
  write,
} from './capture-context.mjs';

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function assertThrows(fn, matcher, msg) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${msg} (expected throw)`);
  } catch (e) {
    if (matcher.test(e.message)) { passed++; }
    else { failed++; console.error(`  FAIL: ${msg}\n    error: ${e.message}`); }
  }
}

// The inverse: a call that must succeed is reported under its own label
// when it throws, instead of aborting the run from an uncaught exception.
function assertOk(fn, msg) {
  try {
    const value = fn();
    passed++;
    return value;
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${msg}\n    threw: ${e.message}`);
    return undefined;
  }
}

function setupRoot() {
  return mkdtempSync(join(tmpdir(), 'cap-test-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

console.log('# validate');

{
  assertThrows(
    () => validate({ type: null, topic: 'x', scope: 'shared' }),
    /--type must be one of/,
    'rejects missing type',
  );
}

{
  assertThrows(
    () => validate({ type: 'memo', topic: 'x', scope: 'shared' }),
    /--type must be one of/,
    'rejects invalid type',
  );
}

{
  assertThrows(
    () => validate({ type: 'braindump', topic: 'BadCase', scope: 'shared' }),
    /kebab-case/,
    'rejects non-kebab-case topic',
  );
}

{
  assertThrows(
    () => validate({ type: 'braindump', topic: 'x', scope: 'invalid' }),
    /--scope must be one of/,
    'rejects invalid scope',
  );
}

{
  assertThrows(
    () => validate({ type: 'braindump', topic: 'x', scope: 'team-member' }),
    /--user is required/,
    'rejects team-member scope without user',
  );
}

{
  assertThrows(
    () => validate({ type: 'braindump', topic: 'x', scope: 'team-member', user: 'bad/name' }),
    /--user must be alphanumeric/,
    'rejects user with slash',
  );
}

{
  // valid input doesn't throw
  validate({ type: 'braindump', topic: 'my-topic', scope: 'shared' });
  validate({ type: 'handoff', topic: 'my-topic', scope: 'team-member', user: 'alice' });
  passed += 2;
}

console.log('# parseArgs');

{
  // The flag that once waved a tracked capture through the guard is gone. A
  // skill copy that still passes it gets an error, not a silent success.
  assertThrows(
    () => parseArgs(['node', 'capture-context.mjs', '--allow-tracked']),
    /Unknown arg/,
    'the removed --allow-tracked is rejected as an unknown argument',
  );
}

console.log('# computeDir');

{
  const sharedDir = computeDir({ scope: 'shared', root: '/ws' });
  assertEq(sharedDir, '/ws/workspace-context/shared', 'shared scope path');

  const userDir = computeDir({ scope: 'team-member', user: 'alice', root: '/ws' });
  assertEq(userDir, '/ws/workspace-context/team-member/alice', 'team-member scope path');
}

console.log('# computeBaseFilename');

{
  assertEq(
    computeBaseFilename({ type: 'braindump', topic: 'my-thing', localOnly: false }),
    'braindump_my-thing.md',
    'standard naming',
  );
  assertEq(
    computeBaseFilename({ type: 'research', topic: 'my-thing', localOnly: true }),
    'local-only-research_my-thing.md',
    'local-only prefix applied',
  );
  assertEq(
    computeBaseFilename({ type: 'handoff', topic: 'workstream-x', localOnly: false }),
    'handoff_workstream-x.md',
    'handoff prefix',
  );
}

console.log('# resolveCollision');

{
  const root = setupRoot();
  const path1 = resolveCollision(root, 'braindump_x.md', false);
  assertEq(path1, join(root, 'braindump_x.md'), 'no collision returns base');
  cleanup(root);
}

{
  const root = setupRoot();
  writeFileSync(join(root, 'braindump_x.md'), 'first');
  const path2 = resolveCollision(root, 'braindump_x.md', false);
  assertEq(path2, join(root, 'braindump_x-2.md'), 'first collision → -2');
  writeFileSync(path2, 'second');
  const path3 = resolveCollision(root, 'braindump_x.md', false);
  assertEq(path3, join(root, 'braindump_x-3.md'), 'second collision → -3');
  cleanup(root);
}

{
  const root = setupRoot();
  writeFileSync(join(root, 'braindump_x.md'), 'first');
  const path = resolveCollision(root, 'braindump_x.md', true);
  assertEq(path, join(root, 'braindump_x.md'), '--update returns base even when exists');
  cleanup(root);
}

console.log('# buildFrontmatter');

{
  const fm = buildFrontmatter({
    type: 'braindump',
    topic: 'my-thing',
    scope: 'shared',
  });
  assertEq(fm.state, 'ephemeral', 'state ephemeral');
  assertEq(fm.lifecycle, 'active', 'lifecycle active');
  assertEq(fm.type, 'braindump', 'type set');
  assertEq(fm.topic, 'my-thing', 'topic set');
  assert(!('author' in fm), 'no author for shared scope');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(fm.updated), 'updated is ISO date');
}

{
  const fm = buildFrontmatter({
    type: 'research',
    topic: 'idea',
    scope: 'team-member',
    user: 'alice',
    variant: 'aside',
    description: 'A neat idea.',
  });
  assertEq(fm.author, 'alice', 'author from --user');
  assertEq(fm.variant, 'aside', 'variant included');
  assertEq(fm.description, 'A neat idea.', 'description included');
}

console.log('# renderFrontmatter');

{
  const out = renderFrontmatter({
    state: 'ephemeral',
    type: 'braindump',
    topic: 'x',
  });
  assertEq(
    out,
    '---\nstate: ephemeral\ntype: braindump\ntopic: x\n---',
    'frontmatter rendered with --- fences',
  );
}

console.log('# plan');

{
  const root = setupRoot();
  const planned = plan({
    type: 'braindump',
    topic: 'my-topic',
    scope: 'team-member',
    user: 'alice',
    root,
    localOnly: false,
    update: false,
  });
  assertEq(
    planned.filePath,
    join(root, 'workspace-context', 'team-member', 'alice', 'braindump_my-topic.md'),
    'planned path includes type prefix and user dir',
  );
  cleanup(root);
}

{
  const root = setupRoot();
  const args = {
    type: 'research',
    topic: 'idea',
    scope: 'team-member',
    user: 'alice',
    root,
    localOnly: true,
    update: false,
    variant: 'aside',
  };
  const planned = plan(args);
  assertEq(
    planned.filePath,
    join(root, 'workspace-context', 'team-member', 'alice', 'local-only-research_idea.md'),
    'local-only flag prefixes filename',
  );
  cleanup(root);
}

console.log('# write end-to-end');

{
  const root = setupRoot();
  const filePath = write(
    {
      type: 'braindump',
      topic: 'my-topic',
      scope: 'team-member',
      user: 'alice',
      description: 'Captured my topic.',
      root,
      localOnly: false,
      update: false,
    },
    '## Section\n\nBody text.\n',
  );
  assert(existsSync(filePath), 'file written');
  const content = readFileSync(filePath, 'utf-8');
  assert(content.startsWith('---\n'), 'starts with frontmatter');
  assert(content.includes('type: braindump'), 'frontmatter has type');
  assert(content.includes('topic: my-topic'), 'frontmatter has topic');
  assert(content.includes('author: alice'), 'frontmatter has author');
  assert(content.includes('description: Captured my topic.'), 'frontmatter has description');
  assert(content.includes('## Section\n\nBody text.'), 'body preserved');
  cleanup(root);
}

{
  // collision: second write becomes -2
  const root = setupRoot();
  const args = {
    type: 'braindump',
    topic: 'topic',
    scope: 'shared',
    root,
    localOnly: false,
    update: false,
  };
  const path1 = write(args, 'first body');
  const path2 = write(args, 'second body');
  assert(path1 !== path2, 'collision creates new path');
  assert(path2.endsWith('braindump_topic-2.md'), 'second is -2');
  cleanup(root);
}

{
  // --update: overwrites existing
  const root = setupRoot();
  const args = {
    type: 'braindump',
    topic: 'topic',
    scope: 'shared',
    root,
    localOnly: false,
    update: false,
  };
  const path1 = write(args, 'first body');
  const path2 = write({ ...args, update: true }, 'updated body');
  assertEq(path1, path2, '--update overwrites same path');
  const content = readFileSync(path1, 'utf-8');
  assert(content.includes('updated body'), 'content overwritten');
  assert(!content.includes('first body'), 'old content gone');
  cleanup(root);
}

console.log('# root guard');

// The three questions the guard asks git, spelled as it spells them.
const SHOW_PREFIX = 'rev-parse --show-prefix';
const HEAD = 'symbolic-ref --short HEAD';
const ORIGIN_HEAD = 'symbolic-ref --short refs/remotes/origin/HEAD';

// A stand-in for spawnSync that answers each `git -C <root> <args>` from a
// table keyed by the arguments after the root. Anything unlisted fails the
// way git does for a ref or a repository it cannot find, and every call is
// recorded so a test can see which questions were asked and how.
function scriptedGit(answers) {
  const calls = [];
  const gitFn = (command, argv, options) => {
    calls.push({ command, argv, options });
    const out = answers[argv.slice(2).join(' ')];
    return out === undefined ? { status: 128, stdout: '' } : { status: 0, stdout: `${out}\n` };
  };
  gitFn.calls = calls;
  return gitFn;
}

// A workspace root with no remote, sitting on {branch}: what a freshly
// scaffolded workspace looks like.
function launcherGit(branch = 'main') {
  return scriptedGit({ [SHOW_PREFIX]: '', [HEAD]: branch });
}

{
  assertEq(isDefaultBranchCheckout('/ws', launcherGit()), true, 'a top-level checkout on main with no remote is the launcher');
  assertEq(isDefaultBranchCheckout('/ws', launcherGit('master')), true, 'master with no remote is a default branch too');
  assertEq(isDefaultBranchCheckout('/ws', launcherGit('feature/some-task')), false, 'a worktree branch is not the default');
  // The documented fail-open case: origin/HEAD absent, which is what a remote
  // added by hand leaves until a fetch or set-head records it, under a
  // default branch named anything else. Nothing tells it from a worktree.
  assertEq(isDefaultBranchCheckout('/ws', launcherGit('trunk')), false, 'a default branch under another name is not recognised: the guard fails open');
}

{
  // Once the repository has a remote, origin/HEAD is the authority.
  const named = scriptedGit({ [SHOW_PREFIX]: '', [HEAD]: 'develop', [ORIGIN_HEAD]: 'origin/develop' });
  assertEq(isDefaultBranchCheckout('/ws', named), true, 'origin/HEAD names the default branch');
  assertEq(named.calls[0].command, 'git', 'git is spawned by name');
  assertEq(named.calls[0].argv, ['-C', '/ws', 'rev-parse', '--show-prefix'], 'the root and the question are separate arguments');
  assertEq(named.calls[0].options.shell, undefined, 'no shell is involved');
  const other = scriptedGit({ [SHOW_PREFIX]: '', [HEAD]: 'main', [ORIGIN_HEAD]: 'origin/develop' });
  assertEq(isDefaultBranchCheckout('/ws', other), false, 'main is a worktree branch when origin/HEAD names develop');
}

{
  // Nothing git cannot vouch for is read as the launcher.
  const noRepo = scriptedGit({});
  assertEq(isDefaultBranchCheckout('/ws', noRepo), false, 'a directory that is no repository');
  assertEq(noRepo.calls.length, 1, 'and git is not asked anything further');

  const nested = scriptedGit({ [SHOW_PREFIX]: 'notes/', [HEAD]: 'main' });
  assertEq(isDefaultBranchCheckout('/ws', nested), false, 'a directory inside another repository is not a launcher');

  const detached = scriptedGit({ [SHOW_PREFIX]: '' });
  assertEq(isDefaultBranchCheckout('/ws', detached), false, 'a detached HEAD is on no branch');

  const absent = () => ({ error: { code: 'ENOENT' }, status: null });
  assertEq(isDefaultBranchCheckout('/ws', absent), false, 'git not installed');

  const killed = () => ({ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM' });
  assertEq(isDefaultBranchCheckout('/ws', killed), false, 'a git that did not finish');

  const thrown = () => { throw new Error('spawn failed'); };
  assertEq(isDefaultBranchCheckout('/ws', thrown), false, 'a spawn that throws');
}

{
  // What the guard does to a capture at the launcher.
  const root = setupRoot();
  const capture = { type: 'handoff', topic: 'root-check', scope: 'team-member', user: 'ada', root, update: false };
  const userDir = join(root, 'workspace-context', 'team-member', 'ada');

  assertThrows(
    () => write({ ...capture, localOnly: false }, 'Body.\n', { gitFn: launcherGit() }),
    /default branch/,
    'a tracked capture at the launcher is refused',
  );
  assert(!existsSync(join(root, 'workspace-context')), 'and a refused write creates nothing');

  assertThrows(
    () => plan({ ...capture, localOnly: false }, { gitFn: launcherGit() }),
    /--local-only.*worktree/,
    'the refusal names both ways out',
  );

  const local = assertOk(
    () => write({ ...capture, localOnly: true }, 'Body.\n', { gitFn: launcherGit() }),
    'a local-only capture is not refused at the launcher',
  );
  assertEq(local, join(userDir, 'local-only-handoff_root-check.md'), 'and is written under the local-only- name');

  const inWorktree = assertOk(
    () => write(
      { ...capture, localOnly: false, topic: 'in-a-worktree' },
      'Body.\n',
      { gitFn: launcherGit('feature/some-task') },
    ),
    'a tracked capture is not refused off the default branch',
  );
  assertEq(inWorktree, join(userDir, 'handoff_in-a-worktree.md'), 'and needs no flag there');
  cleanup(root);
}

console.log('# CLI end-to-end');

// The real script. These three run against a plain temp directory, which is
// no repository, so the root guard has nothing to say.
const SCRIPT = fileURLToPath(new URL('./capture-context.mjs', import.meta.url));

function runCli(args, input = '') {
  return spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf-8' });
}

{
  const root = setupRoot();
  const result = runCli(
    ['--type', 'braindump', '--topic', 'cli-test', '--scope', 'shared', '--root', root],
    '## Body\n\nFrom stdin.\n',
  );
  assertEq(result.status, 0, 'CLI exits 0');
  const printedPath = result.stdout.trim();
  assert(printedPath.endsWith('braindump_cli-test.md'), 'CLI prints path with prefix');
  const content = readFileSync(printedPath, 'utf-8');
  assert(content.includes('From stdin.'), 'stdin body written');
  cleanup(root);
}

{
  // --print-only: no stdin needed, no file written
  const root = setupRoot();
  const result = runCli([
    '--type', 'handoff',
    '--topic', 'no-write',
    '--scope', 'team-member',
    '--user', 'bob',
    '--root', root,
    '--print-only',
  ]);
  assertEq(result.status, 0, '--print-only exits 0');
  const printedPath = result.stdout.trim();
  assert(printedPath.endsWith('handoff_no-write.md'), 'planned path printed');
  assert(!existsSync(printedPath), 'no file written in print-only mode');
  cleanup(root);
}

{
  // bad arg
  const root = setupRoot();
  const result = runCli(
    ['--type', 'invalid', '--topic', 'x', '--scope', 'shared', '--root', root],
    'body',
  );
  assertEq(result.status, 1, 'invalid type exits 1');
  assert(result.stderr.includes('--type must be one of'), 'error message piped to stderr');
  cleanup(root);
}

console.log('# root guard against a real repository');

{
  const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (spawnSync('git', ['--version']).error) {
    console.log('  (skip: git unavailable on this machine — the scripted-git cases above still ran)');
  } else {
    const area = setupRoot();
    const root = join(area, 'launcher');
    // -b names the branch, so a machine's init.defaultBranch cannot change
    // what the fixture is; the -c settings keep a global sign or hook setting
    // from touching its commit. A fixture step that fails says which.
    const fixture = (...args) => {
      const res = git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args);
      assertEq(res.status, 0, `fixture: git ${args[0]} (${String(res.stderr).trim()})`);
      return res;
    };
    try {
      assertEq(spawnSync('git', ['init', '-q', '-b', 'main', root]).status, 0, 'fixture: git init');
      cpSync(fileURLToPath(new URL('../../_gitignore', import.meta.url)), join(root, '.gitignore'));

      const capture = ['--type', 'handoff', '--topic', 'root-check', '--scope', 'team-member', '--user', 'ada', '--root', root];
      const CONTEXT = join(root, 'workspace-context');
      const body = '## Status\n\nBody.\n';

      // Freshly initialised, before its first commit: on the default branch.
      const refused = runCli(capture, body);
      assertEq(refused.status, 1, 'a tracked capture at the launcher exits 1');
      assert(refused.stderr.includes('default branch'), 'stderr says the checkout is on its default branch');
      assertEq(refused.stdout, '', 'and prints no path');
      assert(!existsSync(CONTEXT), 'a refused capture writes nothing');

      assertEq(runCli([...capture, '--print-only']).status, 1, '--print-only is refused the same way');

      const local = runCli([...capture, '--local-only'], body);
      assertEq(local.status, 0, '--local-only is accepted at the launcher');
      const localPath = local.stdout.trim();
      assert(localPath.endsWith('local-only-handoff_root-check.md'), 'the capture carries the local-only- prefix');
      assert(existsSync(localPath), 'and is written');
      assertEq(git(root, 'check-ignore', '-q', localPath).status, 0, "git ignores it under the template's .gitignore");

      // A remote's HEAD recorded, then a branch off main: a worktree's state.
      fixture('commit', '-q', '--allow-empty', '-m', 'init');
      fixture('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      fixture('checkout', '-q', '-b', 'feature/some-task');
      const tracked = runCli(capture, body);
      assertEq(tracked.status, 0, 'off the default branch a tracked capture needs no flag');
      assert(tracked.stdout.trim().endsWith(join('team-member', 'ada', 'handoff_root-check.md')), 'and is the tracked name');

      // Back on main, which origin/HEAD now names. The tracked file written on
      // the other branch carried over and shows as untracked; the local-only
      // one stays out of git's sight. --untracked-files=all lists each file,
      // where the default would collapse the whole directory to one line.
      fixture('checkout', '-q', 'main');
      assertEq(runCli(capture, body).status, 1, 'origin/HEAD naming main refuses a tracked capture there');
      const status = git(root, 'status', '--porcelain', '--untracked-files=all').stdout;
      assert(/^..\s+\S*\/handoff_root-check\.md\s*$/m.test(status), 'the tracked capture shows up as untracked');
      assert(!status.includes('local-only-'), 'the local-only one does not');

      // A linked worktree is the same repository on another branch.
      const worktree = join(area, 'worktree');
      fixture('worktree', 'add', '-q', '-b', 'feature/linked', worktree);
      const linked = runCli(['--type', 'braindump', '--topic', 'linked', '--scope', 'shared', '--root', worktree], body);
      assertEq(linked.status, 0, 'a tracked capture inside a linked worktree is accepted');
      assert(existsSync(linked.stdout.trim()), 'and is written there');

      // The documented fail-open case, against real git: origin/HEAD absent —
      // the ref only a clone, a fetch or set-head records — and the checkout
      // on a branch under another name. Nothing tells it from a worktree, so
      // the tracked capture passes.
      fixture('symbolic-ref', '-d', 'refs/remotes/origin/HEAD');
      fixture('checkout', '-q', '-b', 'trunk');
      const unrecognised = runCli(capture, body);
      assertEq(unrecognised.status, 0, 'with no origin/HEAD, a checkout on trunk is not recognised as the launcher: the guard fails open');
    } finally {
      cleanup(area);
    }
  }
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
