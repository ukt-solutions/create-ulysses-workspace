// Unit tests for repo-remotes.mjs
// Run: node template/_claude/scripts/repo-remotes.test.mjs
//
// Every case builds a real workspace in a temp directory — a git repo at the
// root, bare repositories as origins, and clones of them under repos/ — so
// the push, fetch and config behaviour is git's own, not a stand-in's.
//
// Git config is isolated in PROCESS.ENV, before any git is spawned: the
// module runs git itself, and env inheritance is the only isolation that
// reaches those processes.
//
// The safety cases each pair an assertion with a control that passes when
// the protection is absent — a plain remote fetched the same way does gain
// tracking refs — so a protection that quietly stopped working fails here
// instead of passing because nothing could have shown up.

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  managedRemoteNames, remoteNameFor, repoRemotesLine, syncRepoRemotes,
} from './repo-remotes.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'repo-remotes.mjs');

// Isolation first. A fixed identity and an empty global config keep the
// user's signing, hooks and URL rewrites out of the results.
const GIT_CFG = mkdtempSync(join(tmpdir(), 'repo-remotes-cfg-'));
writeFileSync(join(GIT_CFG, 'global'), '');
process.env.GIT_CONFIG_GLOBAL = join(GIT_CFG, 'global');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test User';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test User';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const gitOnPath = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitOnPath.error || gitOnPath.status !== 0) {
  console.log('skipped: git is not available on this machine, and every case needs real repositories');
  rmSync(GIT_CFG, { recursive: true, force: true });
  process.exit(0);
}

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${label}${detail ? `\n    ${detail}` : ''}`);
  }
  return ok;
}
// JSON with object keys sorted, so two objects compare by content and not
// by the order git happened to write their keys in.
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function assertEq(actual, expected, label) {
  const a = canon(actual);
  const e = canon(expected);
  check(label, a === e, `expected: ${e}\n    actual:   ${a}`);
}

// === fixtures ===

// A workspace root that is a git repo. Origins and clones are added per case.
function makeFixture() {
  // realpath: macOS tmpdir() is a /var → /private/var symlink, and the paths
  // git prints are the resolved ones.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'repo-remotes-')));
  const root = join(base, 'root');
  mkdirSync(root);
  run(root, 'init', '-q', '-b', 'main');
  return { base, root };
}

// git that throws on a non-zero exit, for arranging a fixture.
function run(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${dir}: ${r.error ? r.error.message : r.stderr}`);
  }
  return r.stdout.trim();
}
// git that reports, for the behaviour under test.
function tryRun(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return { status: r.status, error: r.error ? r.error.code : null, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

// A bare repository with one commit on main, and a seed clone that can push
// more to it.
function makeOrigin(fx, name) {
  const bare = join(fx.base, 'origins', `${name}.git`);
  mkdirSync(bare, { recursive: true });
  run(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = join(fx.base, 'seeds', name);
  mkdirSync(seed, { recursive: true });
  run(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'file.txt'), `${name}\n`);
  run(seed, 'add', '-A');
  run(seed, 'commit', '-q', '-m', 'init');
  run(seed, 'push', '-q', bare, 'main');
  return { bare, seed };
}

function addClone(fx, name, bare) {
  const dir = join(fx.root, 'repos', name);
  mkdirSync(join(fx.root, 'repos'), { recursive: true });
  run(fx.root, 'clone', '-q', bare, dir);
  return dir;
}

function withFixture(fn) {
  const fx = makeFixture();
  try {
    fn(fx);
  } finally {
    try { rmSync(fx.base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }
}

// What `git config --local` holds for one remote, as { key: value } with
// only the last part of each key, lowercased the way git reports it. null
// when the remote does not exist.
function remoteConfig(fx, remote) {
  const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const r = tryRun(fx.root, 'config', '--local', '--null', '--get-regexp', `^remote\\.${escaped}\\.`);
  if (r.status === 1) return null;
  if (r.status !== 0) throw new Error(`reading remote ${remote}: ${r.stderr}`);
  const out = {};
  for (const entry of r.stdout.split('\0').filter(Boolean)) {
    const nl = entry.indexOf('\n');
    const key = entry.slice(0, nl).toLowerCase();
    out[key.slice(key.lastIndexOf('.') + 1)] = entry.slice(nl + 1);
  }
  return out;
}

// The managed shape for the remote of the clone named `name`.
const MANAGED = { pushurl: 'no-push', skipfetchall: 'true', skipdefaultupdate: 'true', ulyssesmanaged: 'true' };
function managedConfig(url) {
  return { url, ...MANAGED };
}

function localConfigList(fx) {
  return run(fx.root, 'config', '--list', '--local');
}

// gitFn for the module under test that records every call it passes on.
function recordingGitFn() {
  const calls = [];
  const gitFn = (cmd, args, opts = {}) => {
    calls.push(args.slice(4));
    return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  };
  const writes = () => calls.filter((args) => (
    (args[0] === 'config' && (args.includes('--replace-all') || args.includes('--unset-all')))
    || (args[0] === 'remote' && args[1] === 'remove')
  ));
  return { gitFn, calls, writes };
}

const EMPTY = { added: [], updated: [], removed: [], adopted: [], skipped: [] };

// === naming ===

console.log('# remote name');
assertEq(remoteNameFor('my-app'), 'repo-my-app', 'a plain directory name is kept');
assertEq(remoteNameFor('My_App.2'), 'repo-My_App.2', 'letters, digits, dot, underscore and dash survive');
assertEq(remoteNameFor('my app'), 'repo-my-app', 'a space becomes a dash');
assertEq(remoteNameFor('a/b'), 'repo-a-b', 'a separator becomes a dash');
assertEq(remoteNameFor('répo'), 'repo-r-po', 'a character outside ASCII letters becomes a dash');

// === add ===

console.log('# add: two clones give two managed remotes with exactly the managed shape');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const api = makeOrigin(fx, 'api');
  addClone(fx, 'app', app.bare);
  addClone(fx, 'api', api.bare);
  const result = syncRepoRemotes(fx.root);
  assertEq(result, { ...EMPTY, added: ['repo-api', 'repo-app'] }, 'both remotes added, nothing else reported');
  assertEq(remoteConfig(fx, 'repo-app'), managedConfig(app.bare), 'repo-app holds exactly the managed config');
  assertEq(remoteConfig(fx, 'repo-api'), managedConfig(api.bare), 'repo-api holds exactly the managed config');
  check(!Object.keys(remoteConfig(fx, 'repo-app')).some((key) => key.endsWith('.fetch')), 'no fetch refspec on a managed remote');
  assertEq(run(fx.root, 'remote'), 'repo-api\nrepo-app', '`git remote` lists both');
  // The config file is something people read; the keys keep their documented spelling.
  const file = readFileSync(join(fx.root, '.git', 'config'), 'utf8');
  check(file.includes('ulyssesManaged = true') && file.includes('skipFetchAll = true') && file.includes('skipDefaultUpdate = true'),
    'the config file spells the keys as documented');
});

// === idempotent ===

console.log('# idempotent: a second run reports nothing and writes nothing');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  addClone(fx, 'app', app.bare);
  syncRepoRemotes(fx.root);
  const before = localConfigList(fx);
  const configFile = join(fx.root, '.git', 'config');
  const bytesBefore = readFileSync(configFile);
  const mtimeBefore = statSync(configFile).mtimeMs;

  const rec = recordingGitFn();
  const second = syncRepoRemotes(fx.root, { gitFn: rec.gitFn });
  assertEq(second, EMPTY, 'the second run reports no change');
  assertEq(rec.writes(), [], 'the second run issues no config write and no remote remove');
  assertEq(localConfigList(fx), before, '`git config --list --local` is identical before and after');
  assertEq(readFileSync(configFile).equals(bytesBefore), true, 'the config file holds the same bytes');
  check(statSync(configFile).mtimeMs === mtimeBefore, 'the config file was not rewritten', `mtime ${mtimeBefore} → ${statSync(configFile).mtimeMs}`);
  assertEq(repoRemotesLine(second), '', 'nothing to tell a session about');
});

// === update ===

console.log('# update: the remote follows a changed origin, and lost keys come back');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const moved = makeOrigin(fx, 'moved');
  const clone = addClone(fx, 'app', app.bare);
  syncRepoRemotes(fx.root);
  run(clone, 'remote', 'set-url', 'origin', moved.bare);
  const result = syncRepoRemotes(fx.root);
  assertEq(result, { ...EMPTY, updated: ['repo-app'] }, 'the changed origin is reported as an update');
  assertEq(remoteConfig(fx, 'repo-app'), managedConfig(moved.bare), 'the remote now carries the new origin');
  assertEq(syncRepoRemotes(fx.root), EMPTY, 'and settles there');

  // Keys removed by hand are restored; a refspec added by hand is removed.
  run(fx.root, 'config', '--local', '--unset-all', 'remote.repo-app.skipFetchAll');
  run(fx.root, 'config', '--local', '--add', 'remote.repo-app.fetch', '+refs/heads/*:refs/remotes/repo-app/*');
  const repaired = syncRepoRemotes(fx.root);
  assertEq(repaired, { ...EMPTY, updated: ['repo-app'] }, 'a managed remote out of shape is reported as updated, not adopted');
  assertEq(remoteConfig(fx, 'repo-app'), managedConfig(moved.bare), 'the skip flag is restored and the refspec removed');
  assertEq(syncRepoRemotes(fx.root), EMPTY, 'and it settles there');

  // With the marker gone the remote looks like one made by hand under this
  // convention, so it is adopted — which puts the marker back.
  run(fx.root, 'config', '--local', '--unset-all', 'remote.repo-app.ulyssesManaged');
  assertEq(syncRepoRemotes(fx.root), { ...EMPTY, adopted: ['repo-app'] }, 'a managed remote that lost its marker is adopted');
  assertEq(remoteConfig(fx, 'repo-app').ulyssesmanaged, 'true', 'and marked again');

  // A pushurl pointing somewhere real would make the remote pushable again.
  run(fx.root, 'commit', '-q', '--allow-empty', '-m', 'workspace commit');
  run(fx.root, 'config', '--local', '--replace-all', 'remote.repo-app.pushurl', moved.bare);
  assertEq(tryRun(fx.root, 'push', 'repo-app', 'HEAD:refs/heads/pushed').status, 0, 'control: with a real pushurl the remote can be pushed to');
  check(run(moved.bare, 'for-each-ref', 'refs/heads/pushed', '--format=%(refname)') !== '', 'control: the push landed');
  syncRepoRemotes(fx.root);
  assertEq(remoteConfig(fx, 'repo-app').pushurl, 'no-push', 'a pushurl other than no-push is put back');
  assertEq(tryRun(fx.root, 'push', 'repo-app', 'HEAD:refs/heads/pushed-again').status, 128, 'so the remote cannot be pushed to again');
});

// === remove ===

console.log('# remove: a deleted clone takes its managed remote with it');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const api = makeOrigin(fx, 'api');
  addClone(fx, 'app', app.bare);
  addClone(fx, 'api', api.bare);
  syncRepoRemotes(fx.root);
  rmSync(join(fx.root, 'repos', 'api'), { recursive: true, force: true });
  const result = syncRepoRemotes(fx.root);
  assertEq(result, { ...EMPTY, removed: ['repo-api'] }, 'the orphaned remote is removed');
  assertEq(run(fx.root, 'remote'), 'repo-app', 'the other managed remote stays');
  assertEq(remoteConfig(fx, 'repo-api'), null, 'its config is gone');
  assertEq(syncRepoRemotes(fx.root), EMPTY, 'and nothing further happens');

  rmSync(join(fx.root, 'repos', 'app'), { recursive: true, force: true });
  assertEq(syncRepoRemotes(fx.root), { ...EMPTY, removed: ['repo-app'] }, 'the last clone going takes the last remote');
  assertEq(run(fx.root, 'remote'), '', 'no managed remote is left');
  assertEq(syncRepoRemotes(fx.root), EMPTY, 'an empty repos/ settles');
});

// === leave alone ===

console.log('# leave alone: other remotes are untouched, and a blocked name is a conflict');
withFixture((fx) => {
  const ws = makeOrigin(fx, 'ws');
  const other = makeOrigin(fx, 'upstream');
  const x = makeOrigin(fx, 'x');
  run(fx.root, 'remote', 'add', 'origin', ws.bare);
  run(fx.root, 'remote', 'add', 'upstream', other.bare);
  // Made with `git remote add`, then given a push target of its own.
  run(fx.root, 'remote', 'add', 'repo-x', x.bare);
  run(fx.root, 'config', '--local', 'remote.repo-x.pushurl', other.bare);
  const before = localConfigList(fx);

  addClone(fx, 'x', x.bare);
  const result = syncRepoRemotes(fx.root);
  check(result.skipped.length === 1 && result.skipped[0].name === 'x', 'the clone is reported as skipped', JSON.stringify(result));
  check(result.skipped[0]?.reason.startsWith('conflict: '), 'and the reason names it a conflict', result.skipped[0]?.reason);
  assertEq([result.added, result.updated, result.removed, result.adopted], [[], [], [], []], 'nothing was changed');
  assertEq(localConfigList(fx), before, 'origin, upstream and the unmarked repo-x are exactly as they were');
  assertEq(remoteConfig(fx, 'repo-x').pushurl, other.bare, 'repo-x keeps the pushurl it was given');
});

console.log('# leave alone: an unmarked repo-<name> remote is adopted only when its pushurl is no-push');
withFixture((fx) => {
  const x = makeOrigin(fx, 'x');
  // The plain `git remote add` shape: a fetch refspec, no pushurl.
  run(fx.root, 'remote', 'add', 'repo-x', x.bare);
  addClone(fx, 'x', x.bare);
  const result = syncRepoRemotes(fx.root);
  check(result.adopted.length === 0 && result.skipped[0]?.reason.startsWith('conflict: '), 'a plain repo-x remote is a conflict, not adopted', JSON.stringify(result));
  assertEq(remoteConfig(fx, 'repo-x').fetch, '+refs/heads/*:refs/remotes/repo-x/*', 'its refspec is left alone');
});

console.log('# leave alone: a remote not named repo-* is never adopted');
withFixture((fx) => {
  const x = makeOrigin(fx, 'x');
  run(fx.root, 'remote', 'add', 'mirror-x', x.bare);
  run(fx.root, 'config', '--local', 'remote.mirror-x.pushurl', 'no-push');
  const before = run(fx.root, 'config', '--local', '--get-regexp', '^remote\\.mirror-x\\.');
  addClone(fx, 'x', x.bare);
  const result = syncRepoRemotes(fx.root);
  assertEq(result, { ...EMPTY, added: ['repo-x'] }, 'the clone gets a remote of its own instead');
  assertEq(run(fx.root, 'config', '--local', '--get-regexp', '^remote\\.mirror-x\\.'), before, 'mirror-x is untouched');
  assertEq(remoteConfig(fx, 'mirror-x').ulyssesmanaged, undefined, 'and is not marked');
});

// === adopt ===

console.log('# adopt: a hand-made repo-y with pushurl no-push is marked and loses its refspec');
withFixture((fx) => {
  const old = makeOrigin(fx, 'old');
  const fresh = makeOrigin(fx, 'fresh');
  run(fx.root, 'remote', 'add', 'repo-y', old.bare);
  run(fx.root, 'config', '--local', 'remote.repo-y.pushurl', 'no-push');
  run(fx.root, 'fetch', '-q', 'repo-y');
  const stale = run(fx.root, 'rev-parse', 'refs/remotes/repo-y/main');
  check(stale !== '', 'the hand-made remote has a tracking branch, as a real one would');

  addClone(fx, 'y', fresh.bare);
  const result = syncRepoRemotes(fx.root);
  assertEq(result, { ...EMPTY, adopted: ['repo-y'] }, 'reported as adopted');
  assertEq(remoteConfig(fx, 'repo-y'), managedConfig(fresh.bare), 'brought to the managed shape, origin included');
  assertEq(syncRepoRemotes(fx.root), EMPTY, 'and it settles there');

  // The refspec is gone in effect, not only in config: a fetch by name
  // writes FETCH_HEAD and leaves the tracking ref where it was.
  const fetched = tryRun(fx.root, 'fetch', 'repo-y');
  assertEq(fetched.status, 0, '`git fetch repo-y` still succeeds');
  assertEq(run(fx.root, 'rev-parse', 'refs/remotes/repo-y/main'), stale, 'the tracking ref is not moved by it');
  const head = run(fx.root, 'rev-parse', 'FETCH_HEAD');
  check(head === run(fresh.seed, 'rev-parse', 'HEAD') && head !== stale, 'FETCH_HEAD is what the fetch wrote');
});

// === skips ===

console.log('# skips: what is not a clone with an origin is passed over and reported');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  addClone(fx, 'app', app.bare);
  mkdirSync(join(fx.root, 'repos', 'plain'));
  // A dot-directory holding a real repo with an origin: still not a candidate.
  const hidden = join(fx.root, 'repos', '.hidden');
  mkdirSync(hidden);
  run(hidden, 'init', '-q', '-b', 'main');
  run(hidden, 'remote', 'add', 'origin', app.bare);
  const noOrigin = join(fx.root, 'repos', 'no-origin');
  mkdirSync(noOrigin);
  run(noOrigin, 'init', '-q', '-b', 'main');
  // origin exists as a remote, with no URL behind it.
  const noUrl = join(fx.root, 'repos', 'no-url');
  mkdirSync(noUrl);
  run(noUrl, 'init', '-q', '-b', 'main');
  run(noUrl, 'config', '--local', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  // A stray file is not a directory and not a candidate.
  writeFileSync(join(fx.root, 'repos', 'notes.txt'), 'x');

  const result = syncRepoRemotes(fx.root);
  assertEq(result.added, ['repo-app'], 'the one real clone is registered');
  assertEq(result.skipped.map((s) => s.name), ['no-origin', 'no-url', 'plain'], 'each passed-over directory is reported, in name order');
  assertEq(result.skipped.find((s) => s.name === 'plain').reason, 'not a git repository', 'a directory without .git');
  assertEq(result.skipped.find((s) => s.name === 'no-origin').reason, 'no origin remote', 'a repo whose origin is not configured');
  assertEq(result.skipped.find((s) => s.name === 'no-url').reason, 'no origin remote', 'an origin with no URL has not resolved');
  assertEq(run(fx.root, 'remote'), 'repo-app', 'none of them got a remote — the workspace repo\'s own origin would have answered for a plain directory');
  assertEq(repoRemotesLine(result), 'Repo remotes: added repo-app', 'an ordinary skip costs a session nothing');
});

console.log('# skips: two clones that map to one remote name — the first keeps it, the other is a conflict');
withFixture((fx) => {
  const one = makeOrigin(fx, 'one');
  const two = makeOrigin(fx, 'two');
  addClone(fx, 'a-b', one.bare);
  addClone(fx, 'a b', two.bare);
  const result = syncRepoRemotes(fx.root);
  assertEq(result.added, ['repo-a-b'], 'one remote, not one overwritten by the other');
  assertEq(result.skipped.map((s) => s.name), ['a-b'], 'the later directory in name order is the one passed over');
  check(result.skipped[0]?.reason.startsWith('conflict: '), 'and it is reported as a conflict', result.skipped[0]?.reason);
  assertEq(remoteConfig(fx, 'repo-a-b').url, two.bare, 'the remote belongs to "a b", which sorts first');
});

console.log('# skips: a symlink under repos/ is not followed');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const elsewhere = join(fx.base, 'elsewhere');
  run(fx.base, 'clone', '-q', app.bare, elsewhere);
  mkdirSync(join(fx.root, 'repos'), { recursive: true });
  try {
    symlinkSync(elsewhere, join(fx.root, 'repos', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if (!['EPERM', 'EACCES', 'EINVAL', 'ENOSYS'].includes(err.code)) throw err;
    console.log('  (skip: symlink unavailable on this machine)');
    return;
  }
  const result = syncRepoRemotes(fx.root);
  assertEq(result, { ...EMPTY, skipped: [{ name: 'linked', reason: 'a symlink, not followed' }] }, 'reported, not registered');
  assertEq(run(fx.root, 'remote'), '', 'no remote was made for it');
});

// === safety ===

console.log('# safety: a managed remote cannot be pushed to, and is not fetched by --all or update');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const api = makeOrigin(fx, 'api');
  addClone(fx, 'app', app.bare);
  addClone(fx, 'api', api.bare);
  syncRepoRemotes(fx.root);
  run(fx.root, 'commit', '-q', '--allow-empty', '-m', 'workspace commit');
  const head = run(fx.root, 'rev-parse', 'HEAD');

  // Something new on each origin, so a fetch that reached them would show.
  for (const { seed, bare } of [app, api]) {
    writeFileSync(join(seed, 'file.txt'), 'second\n');
    run(seed, 'commit', '-qam', 'second');
    run(seed, 'push', '-q', bare, 'main');
  }
  const newSha = run(api.bare, 'rev-parse', 'refs/heads/main');
  const branchesBefore = run(api.bare, 'for-each-ref', 'refs/heads', '--format=%(refname)');
  const hasObject = (sha) => tryRun(fx.root, 'cat-file', '-e', `${sha}^{commit}`).status === 0;
  check(!hasObject(newSha), 'control: the workspace repo does not hold the new commit yet');

  for (const refspec of ['main', 'HEAD', 'HEAD:refs/heads/leaked']) {
    const pushed = tryRun(fx.root, 'push', 'repo-api', refspec);
    check(pushed.status !== 0, `git push repo-api ${refspec} fails`);
    check(/no-push/.test(pushed.stderr), `git push repo-api ${refspec} fails on the pushurl`, pushed.stderr);
  }
  check(tryRun(fx.root, 'push', 'repo-api').status !== 0, 'git push repo-api fails');
  assertEq(run(api.bare, 'for-each-ref', 'refs/heads', '--format=%(refname)'), branchesBefore, 'nothing reached the origin');

  const fetchedAll = tryRun(fx.root, 'fetch', '--all');
  assertEq(fetchedAll.status, 0, '`git fetch --all` succeeds');
  const updated = tryRun(fx.root, 'remote', 'update');
  assertEq(updated.status, 0, '`git remote update` succeeds');
  assertEq(run(fx.root, 'for-each-ref', 'refs/remotes'), '', 'neither created a remote-tracking ref');
  check(!hasObject(newSha), 'and neither fetched anything from a managed remote');

  const byName = tryRun(fx.root, 'fetch', 'repo-api');
  assertEq(byName.status, 0, '`git fetch repo-api` succeeds');
  assertEq(run(fx.root, 'for-each-ref', 'refs/remotes'), '', 'and creates no refs/remotes/repo-api/*');
  assertEq(run(fx.root, 'for-each-ref', 'refs/remotes/repo-*'), '', 'no refs/remotes/repo-* exists at all');
  check(readFileSync(join(fx.root, '.git', 'FETCH_HEAD'), 'utf8').includes(newSha), 'the fetch by name reached FETCH_HEAD, which is all it writes');
  assertEq(tryRun(fx.root, 'rev-parse', '--verify', '--quiet', 'repo-api/main').status, 1, 'so no branch can be named repo-api/main');

  // Control: an ordinary remote fetched the same ways does gain tracking refs
  // and does bring the commit home.
  run(fx.root, 'remote', 'add', 'origin', api.bare);
  run(fx.root, 'fetch', '-q', '--all');
  assertEq(run(fx.root, 'rev-parse', 'refs/remotes/origin/main'), newSha, 'control: a plain remote is fetched by --all into refs/remotes');
});

// === where it runs ===

console.log('# not at top level: a subdirectory of the repo changes nothing');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const other = makeOrigin(fx, 'other');
  addClone(fx, 'app', app.bare);
  syncRepoRemotes(fx.root);
  const before = localConfigList(fx);
  // A subdirectory that holds clones of its own is the case the rule exists
  // for: a run from here would register those and take the root's remotes
  // for clones it cannot see.
  const nested = join(fx.root, 'scratch');
  run(fx.base, 'clone', '-q', other.bare, join(nested, 'repos', 'other'));
  check(existsSync(join(nested, 'repos', 'other', '.git')), 'control: the subdirectory holds a clone with an origin');
  const rec = recordingGitFn();
  assertEq(syncRepoRemotes(nested, { gitFn: rec.gitFn }), EMPTY, 'the subdirectory reports nothing');
  assertEq(rec.writes(), [], 'and writes nothing');
  assertEq(localConfigList(fx), before, 'the root\'s managed remote is still the only one');
});

console.log('# where it runs: not a git repo, a bare repo and a linked worktree are left alone');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  addClone(fx, 'app', app.bare);
  const plain = join(fx.base, 'not-a-repo');
  mkdirSync(plain);
  assertEq(syncRepoRemotes(plain), EMPTY, 'a directory that is not a git repo reports nothing');

  const bare = join(fx.base, 'bare.git');
  mkdirSync(bare);
  run(bare, 'init', '-q', '--bare', '-b', 'main');
  run(fx.base, 'clone', '-q', app.bare, join(bare, 'repos', 'app'));
  assertEq(syncRepoRemotes(bare), EMPTY, 'a bare repo reports nothing, clones under it or not');
  assertEq(tryRun(bare, 'config', '--local', '--get-regexp', '^remote\\.').status, 1, 'and its config holds no remote');

  // A linked worktree shares the root's remotes, but its repos/ is not the
  // source clones. Letting it decide would remove remotes for clones it
  // does not happen to hold.
  syncRepoRemotes(fx.root);
  const api = makeOrigin(fx, 'api');
  addClone(fx, 'api', api.bare);
  syncRepoRemotes(fx.root);
  const before = localConfigList(fx);
  run(fx.root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = join(fx.base, 'worktree');
  run(fx.root, 'worktree', 'add', '-q', '-b', 'side', worktree);
  assertEq(tryRun(worktree, 'rev-parse', '--show-prefix').status === 0 && tryRun(worktree, 'rev-parse', '--show-prefix').stdout === '', true,
    'control: git calls a linked worktree a top level too');
  mkdirSync(join(worktree, 'repos'), { recursive: true });
  assertEq(syncRepoRemotes(worktree), EMPTY, 'a linked worktree reports nothing');
  assertEq(localConfigList(fx), before, 'the shared remote config is untouched');

  // A main worktree whose .git is a file — a separate git dir — is still
  // the main worktree.
  const separate = join(fx.base, 'separate');
  mkdirSync(separate);
  run(separate, 'init', '-q', '-b', 'main', `--separate-git-dir=${join(fx.base, 'separate.git')}`);
  check(statSync(join(separate, '.git')).isFile(), 'control: its .git is a file');
  mkdirSync(join(separate, 'repos'), { recursive: true });
  addClone({ root: separate, base: fx.base }, 'app', app.bare);
  assertEq(syncRepoRemotes(separate), { ...EMPTY, added: ['repo-app'] }, 'a separate git dir does not block the sync');
});

console.log('# no repos/: nothing to do, and nothing written');
withFixture((fx) => {
  const rec = recordingGitFn();
  assertEq(syncRepoRemotes(fx.root, { gitFn: rec.gitFn }), EMPTY, 'no repos/ directory');
  assertEq(rec.writes(), [], 'no write');
});

// === failing git ===

console.log('# failing git: nothing throws, and the rest of the run still completes');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const api = makeOrigin(fx, 'api');
  addClone(fx, 'app', app.bare);
  addClone(fx, 'api', api.bare);
  // git that hangs past its timeout when asked for one clone's origin.
  const timedOut = (cmd, args, opts = {}) => (
    args.includes('get-url') && args.some((a) => a.endsWith('app'))
      ? { status: null, error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
      : spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  );
  let result = null;
  try { result = syncRepoRemotes(fx.root, { gitFn: timedOut }); } catch (err) { check('a timed-out git call does not throw', false, err.message); }
  assertEq(result, { added: ['repo-api'], updated: [], removed: [], adopted: [], skipped: [{ name: 'app', reason: 'reading origin failed' }] },
    'the clone git could not answer for is skipped and reported, the other is registered');

  // No git at all: every call fails to spawn.
  const noGit = () => ({ status: null, error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }) });
  result = null;
  try { result = syncRepoRemotes(fx.root, { gitFn: noGit }); } catch (err) { check('git missing from the machine does not throw', false, err.message); }
  assertEq(result, EMPTY, 'and nothing is reported or written');

  const throwing = () => { throw new Error('boom'); };
  result = null;
  try { result = syncRepoRemotes(fx.root, { gitFn: throwing }); } catch (err) { check('a gitFn that throws does not propagate', false, err.message); }
  assertEq(result, EMPTY, 'and nothing is reported or written');
});

// === turning it off ===

console.log('# turned off: enabled false removes exactly the managed remotes');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const api = makeOrigin(fx, 'api');
  const ws = makeOrigin(fx, 'ws');
  const other = makeOrigin(fx, 'other');
  addClone(fx, 'app', app.bare);
  addClone(fx, 'api', api.bare);
  syncRepoRemotes(fx.root);
  // Remotes that are not the sync's to remove: the workspace's own, a second
  // one, and a repo-* name this sync did not make.
  run(fx.root, 'remote', 'add', 'origin', ws.bare);
  run(fx.root, 'remote', 'add', 'upstream', other.bare);
  run(fx.root, 'remote', 'add', 'repo-x', other.bare);
  run(fx.root, 'config', '--local', 'remote.repo-x.pushurl', other.bare);
  const own = ['origin', 'upstream', 'repo-x'].map((name) => [name, remoteConfig(fx, name)]);
  assertEq(run(fx.root, 'remote'), 'origin\nrepo-api\nrepo-app\nrepo-x\nupstream', 'control: all five remotes are there to begin with');

  const result = syncRepoRemotes(fx.root, { enabled: false });
  assertEq(result, { ...EMPTY, removed: ['repo-api', 'repo-app'] }, 'the two managed remotes are removed, and nothing else is reported');
  assertEq(run(fx.root, 'remote'), 'origin\nrepo-x\nupstream', 'they are gone from the list');
  assertEq(['origin', 'upstream', 'repo-x'].map((name) => [name, remoteConfig(fx, name)]), own, 'and the other three are exactly as they were');
  assertEq(repoRemotesLine(result), 'Repo remotes: removed repo-api; removed repo-app', 'the hook has one line to say, a phrase per removal');

  const before = localConfigList(fx);
  const rec = recordingGitFn();
  assertEq(syncRepoRemotes(fx.root, { gitFn: rec.gitFn, enabled: false }), EMPTY, 'a second run reports nothing');
  assertEq(rec.writes(), [], 'and issues no write');
  assertEq(localConfigList(fx), before, '`git config --list --local` is identical before and after');
});

console.log('# turned off: an adopted hand-made remote goes too, and the clones are not consulted');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const old = makeOrigin(fx, 'old');
  addClone(fx, 'app', app.bare);
  // A clone of the same name is what a hand-made remote is adopted for.
  addClone(fx, 'hand', old.bare);
  run(fx.root, 'remote', 'add', 'repo-hand', old.bare);
  run(fx.root, 'config', '--local', 'remote.repo-hand.pushurl', 'no-push');
  assertEq(syncRepoRemotes(fx.root), { ...EMPTY, added: ['repo-app'], adopted: ['repo-hand'] }, 'control: the hand-made remote is adopted');
  rmSync(join(fx.root, 'repos'), { recursive: true, force: true });

  const rec = recordingGitFn();
  assertEq(syncRepoRemotes(fx.root, { gitFn: rec.gitFn, enabled: false }), { ...EMPTY, removed: ['repo-hand', 'repo-app'] }, 'both go, with repos/ already gone');
  assertEq(rec.calls.filter((args) => args[0] === 'remote' && args[1] === 'get-url'), [], 'and no clone is asked for its origin');
});

console.log('# turned off: a marked remote of another name is kept by a sync and removed by a cleanup');
withFixture((fx) => {
  const other = makeOrigin(fx, 'other');
  run(fx.root, 'remote', 'add', 'hand-marked', other.bare);
  run(fx.root, 'config', '--local', 'remote.hand-marked.pushurl', 'no-push');
  run(fx.root, 'config', '--local', 'remote.hand-marked.ulyssesManaged', 'yes');
  assertEq(syncRepoRemotes(fx.root), EMPTY, 'a sync leaves a marked remote it did not name alone');
  assertEq(remoteConfig(fx, 'hand-marked').ulyssesmanaged, 'yes', 'control: it is still there');
  assertEq(syncRepoRemotes(fx.root, { enabled: false }), { ...EMPTY, removed: ['hand-marked'] }, 'the cleanup removes every marked remote, whatever its name');
});

console.log('# turned off: the same guards apply, so a cleanup removes only from the workspace root');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  addClone(fx, 'app', app.bare);
  syncRepoRemotes(fx.root);
  const before = localConfigList(fx);
  mkdirSync(join(fx.root, 'scratch'));
  assertEq(syncRepoRemotes(join(fx.root, 'scratch'), { enabled: false }), EMPTY, 'a subdirectory removes nothing');
  const plain = join(fx.base, 'not-a-repo');
  mkdirSync(plain);
  assertEq(syncRepoRemotes(plain, { enabled: false }), EMPTY, 'nor does a directory that is not a git repo');
  const worktree = join(fx.base, 'worktree');
  run(fx.root, 'commit', '-q', '--allow-empty', '-m', 'init');
  run(fx.root, 'worktree', 'add', '-q', '-b', 'side', worktree);
  assertEq(syncRepoRemotes(worktree, { enabled: false }), EMPTY, 'nor does a linked worktree');
  const noGit = () => ({ status: null, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
  assertEq(syncRepoRemotes(fx.root, { gitFn: noGit, enabled: false }), EMPTY, 'nor does a git that cannot answer');
  assertEq(localConfigList(fx), before, 'the managed remote is still there after all four');
});

// === the marker, for other scripts ===

console.log('# managedRemoteNames: the remotes that carry the marker, and only those');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const other = makeOrigin(fx, 'other');
  addClone(fx, 'app', app.bare);
  syncRepoRemotes(fx.root);
  run(fx.root, 'remote', 'add', 'origin', other.bare);
  run(fx.root, 'remote', 'add', 'repo-said-false', other.bare);
  run(fx.root, 'config', '--local', 'remote.repo-said-false.ulyssesManaged', 'false');
  run(fx.root, 'config', '--local', 'remote.hand-marked.pushurl', 'no-push');
  run(fx.root, 'config', '--local', 'remote.hand-marked.ulyssesManaged', 'yes');
  assertEq([...managedRemoteNames(spawnSync, fx.root)].sort(), ['hand-marked', 'repo-app'], 'marked remotes of any name, by the value git reads as true');
  const noGit = () => ({ status: null, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
  assertEq([...managedRemoteNames(noGit, fx.root)], [], 'a git that cannot answer gives an empty set rather than throwing');
});

// === the hook line ===

console.log('# repoRemotesLine: one line when something happened, nothing otherwise');
assertEq(repoRemotesLine(EMPTY), '', 'nothing to say');
assertEq(repoRemotesLine({ ...EMPTY, added: ['repo-foo'] }), 'Repo remotes: added repo-foo', 'an addition');
assertEq(
  repoRemotesLine({ added: ['repo-a'], updated: ['repo-b'], removed: ['repo-c'], adopted: ['repo-d'], skipped: [{ name: 'plain', reason: 'not a git repository' }] }),
  'Repo remotes: added repo-a; updated repo-b; removed repo-c; adopted repo-d',
  'every kind of change, and an ordinary skip left out',
);
assertEq(
  repoRemotesLine({ ...EMPTY, skipped: [{ name: 'x', reason: 'conflict: remote repo-x already exists and this sync did not make it' }] }),
  'Repo remotes: conflict repos/x: remote repo-x already exists and this sync did not make it',
  'a conflict is worth a line on its own',
);

// === CLI ===

console.log('# CLI');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  addClone(fx, 'app', app.bare);
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', fx.root, ...args], { encoding: 'utf8' });

  const json = cli('--json');
  assertEq(json.status, 0, '--json exits 0');
  assertEq(JSON.parse(json.stdout), { ...EMPTY, added: ['repo-app'] }, '--json prints the result as JSON');
  assertEq(json.stderr, '', 'and nothing on stderr');

  const again = cli();
  assertEq(again.status, 0, 'a run with nothing to do exits 0');
  assertEq(again.stdout, '', 'and prints nothing when nothing changed');
  assertEq(again.stderr, '', 'with nothing on stderr');

  rmSync(join(fx.root, 'repos', 'app'), { recursive: true, force: true });
  const human = cli();
  assertEq(human.stdout, 'Repo remotes: removed repo-app\n', 'one human line per change');

  const bad = cli('--bogus');
  assertEq(bad.status, 2, 'an unknown argument exits 2');
  check(bad.stderr.includes('unknown argument: --bogus'), 'and says which', bad.stderr);
  const dangling = cli('--root');
  assertEq(dangling.status, 2, '--root without a directory exits 2');

  // Default --root is the working directory.
  addClone(fx, 'app', app.bare);
  const here = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', cwd: fx.root });
  assertEq(here.status, 0, 'with no --root the script works in the current directory');
  assertEq(JSON.parse(here.stdout).added, ['repo-app'], 'and registers the clone there');
});

console.log('# CLI: workspace.repoRemotes false cleans up instead of syncing');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  addClone(fx, 'app', app.bare);
  const configPath = join(fx.root, 'workspace.json');
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', fx.root, ...args], { encoding: 'utf8' });
  const setFlag = (value) => {
    const workspace = { name: 'fixture' };
    if (value !== undefined) workspace.repoRemotes = value;
    writeFileSync(configPath, JSON.stringify({ workspace, repos: {} }));
  };

  setFlag(false);
  const off = cli('--json');
  assertEq(off.status, 0, 'the run exits 0');
  assertEq(JSON.parse(off.stdout), EMPTY, 'with nothing marked there is nothing to remove');
  assertEq(run(fx.root, 'remote'), '', 'and no remote is added');

  setFlag(true);
  assertEq(JSON.parse(cli('--json').stdout).added, ['repo-app'], 'true syncs as usual');

  setFlag(false);
  const removed = cli();
  assertEq(removed.stdout, 'Repo remotes: removed repo-app\n', 'false removes what the sync added, one line per change');
  assertEq(run(fx.root, 'remote'), '', 'and leaves no remote behind');
  assertEq(cli().stdout, '', 'a second run prints nothing');

  setFlag(undefined);
  assertEq(JSON.parse(cli('--json').stdout).added, ['repo-app'], 'an absent key means on');
  writeFileSync(configPath, '{ not json');
  assertEq(JSON.parse(cli('--json').stdout), EMPTY, 'a workspace.json that cannot be parsed is treated as absent, not as a failure');
});

console.log('# CLI: --remove-all cleans up whatever workspace.json says');
withFixture((fx) => {
  const app = makeOrigin(fx, 'app');
  const api = makeOrigin(fx, 'api');
  const other = makeOrigin(fx, 'other');
  addClone(fx, 'app', app.bare);
  addClone(fx, 'api', api.bare);
  run(fx.root, 'remote', 'add', 'origin', other.bare);
  writeFileSync(join(fx.root, 'workspace.json'), JSON.stringify({ workspace: { name: 'fixture', repoRemotes: true }, repos: {} }));
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', fx.root, ...args], { encoding: 'utf8' });
  syncRepoRemotes(fx.root);
  assertEq(run(fx.root, 'remote'), 'origin\nrepo-api\nrepo-app', 'control: the sync ran with the key on');

  const json = cli('--remove-all', '--json');
  assertEq(json.status, 0, '--remove-all --json exits 0');
  assertEq(JSON.parse(json.stdout), { ...EMPTY, removed: ['repo-api', 'repo-app'] }, 'and reports the removals, though workspace.json says true');
  assertEq(run(fx.root, 'remote'), 'origin', 'origin stays');
  assertEq(cli('--remove-all').stdout, '', 'with nothing marked, --remove-all prints nothing');

  assertEq(syncRepoRemotes(fx.root).added, ['repo-api', 'repo-app'], 'the next sync puts them back');
  const human = cli('--remove-all');
  assertEq(human.stdout, 'Repo remotes: removed repo-api\nRepo remotes: removed repo-app\n', 'one human line per removal');
  assertEq(cli('--root', fx.root, '--remove-all').status, 0, 'it combines with an explicit --root');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
rmSync(GIT_CFG, { recursive: true, force: true, maxRetries: 3 });
process.exitCode = failed > 0 ? 1 : 0;
