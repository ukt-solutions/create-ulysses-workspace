// Repo remotes — one remote on the workspace repo per project clone under
// repos/, so that a pull request opened in a project repo is recognised as
// belonging to a chat that runs at the workspace root.
//
// Claude Code Desktop decides whether a pull request belongs to a chat by
// comparing the PR's owner/name with every git remote of the chat's folders.
// A chat runs at the workspace root, whose own remote is the workspace repo,
// so a PR in a project repo matched nothing there. This script mirrors each
// clone's origin onto the workspace repo as a remote named repo-{name}.
//
// Such a remote exists to be matched, nothing more:
//
//   remote.repo-<name>.url                the clone's origin
//   remote.repo-<name>.pushurl            no-push  — a push cannot resolve it
//   remote.repo-<name>.skipFetchAll       true     — `git fetch --all` skips it
//   remote.repo-<name>.skipDefaultUpdate  true     — `git remote update` skips it
//   remote.repo-<name>.ulyssesManaged     true     — marks it as this script's
//
// and no fetch refspec. `git remote add` would write one, so the keys are set
// with `git config` instead: without a refspec, `git fetch repo-<name>` writes
// FETCH_HEAD alone, and no refs/remotes/repo-* branch ever appears. A managed
// remote therefore owns no tracking refs. The ones a hand-made remote had
// already fetched are deleted when it is adopted, and deleted again on every
// remove path, because `git remote remove` only takes the refs that match a
// refspec and a managed remote has none.
//
// Usage:
//   node .claude/scripts/repo-remotes.mjs --root <dir> [--json]
//   node .claude/scripts/repo-remotes.mjs --root <dir> --remove-all [--json]
//
// A run keeps the remotes in step with the clones. For every clone under
// <root>/repos/ it:
//
//   adds     a repo-<name> remote, when the clone has none yet
//   updates  a managed remote whose url is no longer the clone's origin, that
//            lacks one of the keys above, or that carries a fetch refspec
//   adopts   an unmarked repo-<name> remote whose pushurl is no-push: it was
//            made by hand under this convention, so it is marked and brought
//            to the shape above
//
// and it removes a managed remote when the clone's directory is gone from
// repos/ — only then. A directory that is still there but cannot be read at
// that moment, because git timed out or its .git or its origin is missing,
// keeps its remote and is reported as skipped. Every other remote is left
// alone: origin, anything not named repo-*, and an unmarked repo-<name>
// whose pushurl is something else. A clone facing that last case gets no
// remote and is reported as a conflict.
//
// `workspace.repoRemotes: false` in <root>/workspace.json, or --remove-all on
// the command line, makes the run a cleanup instead. It removes every remote
// that carries the marker — the ones this script added and the ones it
// adopted — and touches nothing else: no remote is added, and every unmarked
// remote stays as it is. A second run finds nothing to remove.
//
// The sync runs only at the top level of the workspace repo — never from a
// subdirectory, never from a linked worktree — and does nothing when <root>
// is not a git repository. The cleanup runs under the same guards.
//
// The result is { added, updated, removed, adopted, skipped }, where the
// first four hold remote names and skipped holds { name, reason } for each
// directory under repos/ that was passed over, `name` being its directory
// name. A conflict is a skipped entry whose reason starts with "conflict: ".
// --json prints the result; without it the script prints one line per change
// and nothing when nothing changed.
//
// Reads and writes git config. Makes no network calls.

import '../lib/require-node.mjs';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// import.meta.url is the real file while argv[1] keeps the path as typed, so
// the two are compared through realpath: they differ in a symlinked scripts
// folder and, through a macOS temp dir, in /var against /private/var.
function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const GIT_TIMEOUT_MS = 5000;
// Managed remotes are named repo-<clone> and live under the remote. section.
const REMOTE_PREFIX = 'repo-';
const CONFIG_SECTION = 'remote.';
// Not a URL. A push resolves it as a path, finds no repository there, and
// stops before anything leaves the machine.
const NO_PUSH = 'no-push';
// The ownership marker, remote.<name>.ulyssesManaged. Other scripts ask
// which remotes carry it through managedRemoteNames(), so the name is
// spelled in this file alone.
const MARKER = 'ulyssesManaged';
// How each field of the managed shape is spelled in the config file. git
// reads variable names case-insensitively and reports them lowercased.
const CONFIG_KEY = {
  url: 'url',
  pushurl: 'pushurl',
  fetch: 'fetch',
  skipfetchall: 'skipFetchAll',
  skipdefaultupdate: 'skipDefaultUpdate',
  [MARKER.toLowerCase()]: MARKER,
};
// The order a remote's keys are written in. The ones that make it safe come
// first and the marker last, so a run that stops between two calls leaves
// either nothing or a remote that cannot be pushed to or fetched from; one
// left just short of the marker has pushurl no-push and is adopted next time.
const WRITE_ORDER = ['pushurl', 'skipfetchall', 'skipdefaultupdate', 'url', 'fetch', MARKER.toLowerCase()];
const CHANGE_KINDS = ['added', 'updated', 'removed', 'adopted'];
const CONFLICT = 'conflict: ';
const LABEL = 'Repo remotes: ';
// What git reads as false for a boolean: the spelled-out words, zero, and
// an empty value. Anything else is true, a valueless key included.
const GIT_FALSE = new Set(['false', 'no', 'off', '0', '']);

// .native resolves Windows 8.3 short names; the plain fallback covers
// filesystems where the native binding is unavailable.
function realPath(p) {
  try { return realpathSync.native(p); } catch { /* fall through */ }
  try { return realpathSync(p); } catch { /* fall through */ }
  return resolve(p);
}

// gitFn is injectable so callers (or tests) can observe or fake git; the
// default is spawnSync itself, called as (command, args, options). No shell,
// every value its own argument, and a hard timeout on each call. A call that
// cannot run at all is as failed as one that exits non-zero: nothing here
// throws over git.
function gitCall(gitFn, dir, args) {
  let res = null;
  try {
    res = gitFn('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  } catch { /* a gitFn that throws answers nothing */ }
  const ran = Boolean(res) && !res.error;
  return {
    ok: ran && res.status === 0,
    status: ran ? res.status : null,
    stdout: ran ? String(res.stdout ?? '') : '',
  };
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function emptyResult() {
  return { added: [], updated: [], removed: [], adopted: [], skipped: [] };
}

// The remote a clone owns: repo- and its directory name, with every
// character outside [A-Za-z0-9._-] replaced by a dash.
export function remoteNameFor(cloneName) {
  return REMOTE_PREFIX + String(cloneName).replace(/[^A-Za-z0-9._-]/g, '-');
}

// Splits one `git config --null --get-regexp` line, which is a key, a
// newline, and the value verbatim. A key written with no value at all —
// `ulyssesManaged` on a line of its own — has no newline, and its value is
// null.
function splitConfigEntry(entry) {
  const nl = entry.indexOf('\n');
  return nl === -1
    ? { key: entry, value: null }
    : { key: entry.slice(0, nl), value: entry.slice(nl + 1) };
}

// Whether a config value reads as the ownership marker set to true. A key
// with no value is true to git, the same as `ulyssesManaged = true`; an
// empty value is false, like the words and the zero.
function isMarkerValue(value) {
  if (value === null) return true;
  return !GIT_FALSE.has(value.trim().toLowerCase());
}

// Every remote.<name>.<key> in the repository's own config file, as a Map
// of remote name to a Map of lowercased key to its values. Only that file is
// read, because it is the only one this script writes: a key held in another
// scope — a fetch refspec in the global config, say — can be seen but never
// cleared, and a plan that kept proposing it would report an update on
// every run. A remote that lives in another scope alone is not here, so
// before a name is added git is asked about it (definedOutsideLocalConfig).
// Null when git could not answer.
function readRemoteConfig(gitFn, dir) {
  const res = gitCall(gitFn, dir, ['config', '--local', '--null', '--get-regexp', '^remote\\.']);
  // Exit code 1 is git's "nothing matches": an empty answer, not a failure.
  if (!res.ok && res.status !== 1) return null;
  const remotes = new Map();
  for (const entry of res.stdout.split('\0')) {
    if (entry === '') continue;
    const { key, value } = splitConfigEntry(entry);
    const lastDot = key.lastIndexOf('.');
    if (lastDot <= CONFIG_SECTION.length) continue;
    const name = key.slice(CONFIG_SECTION.length, lastDot);
    if (!remotes.has(name)) remotes.set(name, new Map());
    const fields = remotes.get(name);
    const field = key.slice(lastDot + 1).toLowerCase();
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return remotes;
}

function isMarked(fields) {
  const values = fields.get(MARKER.toLowerCase()) ?? [];
  return values.some(isMarkerValue);
}

// Whether a remote of this name is configured in any scope other than the
// repository's own config file: the global one, an included file, a
// worktree's. `git remote` lists it all the same, so it is somebody's
// remote and not a name for this sync to take over.
function definedOutsideLocalConfig(gitFn, rootDir, remote) {
  const name = remote.replace(/[\\.*+?^${}()|[\]]/g, '\\$&');
  return gitCall(gitFn, rootDir, ['config', '--get-regexp', `^remote\\.${name}\\.`]).ok;
}

/**
 * The names of every remote in the repository at `dir` that carries the
 * ownership marker, whatever `remote.<name>.ulyssesManaged` resolves to. A
 * script that walks a repository's remotes subtracts these: a managed remote
 * is a label for matching pull requests, never a place anything is fetched
 * from, backed up to, or pushed from. Never throws — a git that cannot answer
 * gives an empty set, which leaves the caller with git's own list.
 */
export function managedRemoteNames(gitFn, dir) {
  const res = gitCall(gitFn, dir, ['config', '--null', '--get-regexp', `^remote\\..*\\.${MARKER.toLowerCase()}$`]);
  const names = new Set();
  if (!res.ok && res.status !== 1) return names;
  for (const entry of res.stdout.split('\0')) {
    if (entry === '') continue;
    const { key, value } = splitConfigEntry(entry);
    if (isMarkerValue(value)) names.add(key.slice('remote.'.length, key.length - MARKER.length - 1));
  }
  return names;
}

// True when `rootDir` is the top level of a repository's main worktree.
// --show-prefix does not settle that by itself: it is empty in a linked
// worktree and in a bare repository as well. So the directory has to be
// inside a work tree, at its top, and its git dir has to be the common dir —
// a linked worktree's own git dir sits inside the common one. Remotes are one
// configuration shared by every worktree, so a worktree whose repos/ holds
// something other than the source clones must not be the one that decides
// what they are.
function isMainWorktreeTop(gitFn, rootDir) {
  const res = gitCall(gitFn, rootDir, [
    'rev-parse', '--show-prefix', '--is-inside-work-tree', '--git-dir', '--git-common-dir',
  ]);
  if (!res.ok) return false;
  const [prefix, insideWorkTree, gitDir, commonDir] = res.stdout.split('\n').map((line) => line.replace(/\r$/, ''));
  if (prefix !== '' || insideWorkTree !== 'true') return false;
  // Relative paths are printed relative to the directory git ran in.
  const x = realPath(resolve(rootDir, gitDir ?? ''));
  const y = realPath(resolve(rootDir, commonDir ?? ''));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// The entries directly under repos/ with the dot-entries left out, in name
// order (readdirSync order is the filesystem's). Null when the directory
// cannot be listed.
function listRepos(reposDir) {
  try {
    return readdirSync(reposDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return null;
  }
}

// Whether an entry under repos/ is a directory, a link to one included.
function isRepoDirectory(reposDir, entry) {
  return entry.isDirectory() || isDirectory(join(reposDir, entry.name));
}

// Of the entries under repos/, the directories that are git repositories
// with an origin. Each directory passed over is reported through `skipped`;
// a plain file is not a candidate and is not.
function findClones(gitFn, reposDir, entries, skipped) {
  const clones = [];
  for (const entry of entries) {
    // A link is not followed: where it points was not laid down under repos/.
    if (entry.isSymbolicLink()) {
      skipped.push({ name: entry.name, reason: 'a symlink, not followed' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const dir = join(reposDir, entry.name);
    // The .git check comes before any git call in the directory on purpose.
    // Run inside a plain directory here, git walks up and answers for the
    // workspace repo, whose origin is not this directory's.
    if (!existsSync(join(dir, '.git'))) {
      skipped.push({ name: entry.name, reason: 'not a git repository' });
      continue;
    }
    const res = gitCall(gitFn, dir, ['remote', 'get-url', 'origin']);
    let url = res.ok ? (res.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '') : '';
    // An origin with no URL of its own has not resolved, but git still
    // answers get-url for it, with the remote's name in place of a URL.
    if (url === 'origin') url = '';
    if (url === '') {
      skipped.push({
        name: entry.name,
        reason: res.status === 0 || res.status === 2 ? 'no origin remote' : 'reading origin failed',
      });
      continue;
    }
    clones.push({ name: entry.name, url });
  }
  return clones;
}

// What has to change for remote `fields` (a Map from readRemoteConfig, or an
// empty one for a remote that does not exist yet) to hold the managed shape
// for a clone at `url`. Each item is { field, value }; a null value removes
// the key.
function planWrites(fields, url) {
  const writes = [];
  const want = (field, value) => {
    const have = fields.get(field) ?? [];
    if (have.length !== 1 || have[0] !== value) writes.push({ field, value });
  };
  want('pushurl', NO_PUSH);
  want('skipfetchall', 'true');
  want('skipdefaultupdate', 'true');
  want('url', url);
  if ((fields.get('fetch') ?? []).length > 0) writes.push({ field: 'fetch', value: null });
  if (!isMarked(fields)) writes.push({ field: MARKER.toLowerCase(), value: 'true' });
  return writes.sort((a, b) => WRITE_ORDER.indexOf(a.field) - WRITE_ORDER.indexOf(b.field));
}

function applyWrites(gitFn, rootDir, remote, writes) {
  for (const { field, value } of writes) {
    const key = `remote.${remote}.${CONFIG_KEY[field]}`;
    const res = value === null
      ? gitCall(gitFn, rootDir, ['config', '--local', '--unset-all', key])
      : gitCall(gitFn, rootDir, ['config', '--local', '--replace-all', key, value]);
    // --unset-all exits 5 when the key is already absent, which is the
    // state it was asked for.
    if (!res.ok && !(value === null && res.status === 5)) return false;
  }
  return true;
}

// What is worth telling a person about: one short phrase per change, and per
// clone that lost its remote to a conflict.
function notable(result) {
  const parts = [];
  for (const kind of CHANGE_KINDS) {
    for (const remote of result[kind]) parts.push(`${kind} ${remote}`);
  }
  for (const { name, reason } of result.skipped) {
    if (reason.startsWith(CONFLICT)) parts.push(`conflict repos/${name}: ${reason.slice(CONFLICT.length)}`);
  }
  return parts;
}

// The one line the session-start hook injects, or '' when there is nothing
// to say.
export function repoRemotesLine(result) {
  const parts = notable(result);
  return parts.length === 0 ? '' : LABEL + parts.join('; ');
}

/**
 * Bring the workspace repo at `root` in step with the clones under repos/:
 * one managed remote per clone, as described at the top of this file.
 *
 * `enabled: false` (workspace.repoRemotes: false) makes the run a cleanup
 * instead: every remote that carries the marker is removed, nothing is
 * added, and the clones are not looked at.
 *
 * Never throws, and never fails: anything git cannot answer ends the run
 * with whatever was done up to that point reported.
 */
export function syncRepoRemotes(root, { gitFn = spawnSync, enabled = true } = {}) {
  const result = emptyResult();
  const rootDir = resolve(root);
  if (!isMainWorktreeTop(gitFn, rootDir)) return result;
  if (enabled === false) {
    const marked = readRemoteConfig(gitFn, rootDir);
    if (marked) removeMarked(gitFn, rootDir, result, marked);
    return result;
  }
  const reposDir = join(rootDir, 'repos');
  if (!isDirectory(reposDir)) return result;

  const entries = listRepos(reposDir);
  // Nothing can be told about the clones, so nothing may be removed either.
  if (!entries) return result;

  const clones = findClones(gitFn, reposDir, entries, result.skipped);
  const config = readRemoteConfig(gitFn, rootDir);
  if (!config) return result;

  // The clone each remote name ended up belonging to.
  const ownerOf = new Map();
  for (const clone of clones) {
    const remote = remoteNameFor(clone.name);
    const first = ownerOf.get(remote);
    if (first !== undefined) {
      result.skipped.push({
        name: clone.name,
        reason: `${CONFLICT}repos/${first} already owns the remote name ${remote}`,
      });
      continue;
    }
    ownerOf.set(remote, clone.name);

    const fields = config.get(remote);
    if (!fields) {
      if (definedOutsideLocalConfig(gitFn, rootDir, remote)) {
        result.skipped.push({
          name: clone.name,
          reason: `${CONFLICT}remote ${remote} is configured outside this repository's own config`,
        });
        continue;
      }
      if (applyWrites(gitFn, rootDir, remote, planWrites(new Map(), clone.url))) result.added.push(remote);
      else result.skipped.push({ name: clone.name, reason: `writing remote ${remote} failed` });
      continue;
    }
    const writes = planWrites(fields, clone.url);
    if (isMarked(fields)) {
      if (writes.length === 0) continue;
      if (applyWrites(gitFn, rootDir, remote, writes)) result.updated.push(remote);
      else result.skipped.push({ name: clone.name, reason: `writing remote ${remote} failed` });
    } else if ((fields.get('pushurl') ?? []).includes(NO_PUSH)) {
      // The refs it fetched as a hand-made remote go before it is marked,
      // for the same reason as on a removal: a run that stops in between
      // adopts it again next time and finds nothing left to delete.
      if (!deleteTrackingRefs(gitFn, rootDir, remote)) {
        result.skipped.push({ name: clone.name, reason: `removing the tracking refs of remote ${remote} failed` });
        continue;
      }
      if (applyWrites(gitFn, rootDir, remote, writes)) result.adopted.push(remote);
      else result.skipped.push({ name: clone.name, reason: `writing remote ${remote} failed` });
    } else {
      result.skipped.push({
        name: clone.name,
        reason: `${CONFLICT}remote ${remote} already exists and this sync did not make it`,
      });
    }
  }

  // A managed remote goes only when no directory of its name is left under
  // repos/. One that is there but cannot be read at the moment — git timed
  // out, or its .git or its origin is missing — keeps the remote it has and
  // is reported as skipped.
  const present = new Set(
    entries.filter((entry) => isRepoDirectory(reposDir, entry)).map((entry) => remoteNameFor(entry.name)),
  );
  removeMarked(gitFn, rootDir, result, config, { keep: present, prefix: REMOTE_PREFIX });
  return result;
}

// Delete every tracking ref under refs/remotes/<remote>/. Only that prefix
// is listed, so no other remote's ref is ever a candidate, and --no-deref
// deletes a HEAD symref itself instead of following it to the branch it
// points at, which may belong to another remote. False when git could not
// answer or a ref would not go, so that the caller leaves the remote in
// place and the next run tries again.
function deleteTrackingRefs(gitFn, rootDir, remote) {
  // The prefix is a ref name, so only a name from this script's own
  // alphabet is used as one.
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) return true;
  const prefix = `refs/remotes/${remote}/`;
  const listed = gitCall(gitFn, rootDir, ['for-each-ref', '--format=%(refname)', prefix]);
  if (!listed.ok) return false;
  for (const ref of listed.stdout.split('\n').map((line) => line.replace(/\r$/, ''))) {
    if (ref === '') continue;
    if (!ref.startsWith(prefix)) continue;
    if (!gitCall(gitFn, rootDir, ['update-ref', '--no-deref', '-d', ref]).ok) return false;
  }
  return true;
}

// Remove the marked remotes in `config`, reporting each in `result.removed`.
// A remote whose name `keep` holds stays: its directory is still under
// repos/. With `prefix`, only names starting with it are candidates, which
// keeps a sync from removing a marked remote it did not name.
function removeMarked(gitFn, rootDir, result, config, { keep = new Set(), prefix = '' } = {}) {
  for (const [remote, fields] of config) {
    if (!isMarked(fields) || keep.has(remote)) continue;
    if (prefix !== '' && !remote.startsWith(prefix)) continue;
    // The refs go first, while the remote is still there to be found again:
    // a run that stops here retries the whole removal next time.
    if (!deleteTrackingRefs(gitFn, rootDir, remote)) {
      result.skipped.push({ name: remote, reason: `removing the tracking refs of remote ${remote} failed` });
      continue;
    }
    if (gitCall(gitFn, rootDir, ['remote', 'remove', remote]).ok) result.removed.push(remote);
    else result.skipped.push({ name: remote, reason: `removing remote ${remote} failed` });
  }
}

function parseArgs(argv) {
  const args = { root: '.', json: false, removeAll: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--root') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--root expects a directory');
      args.root = value;
      i += 1;
      continue;
    }
    if (a === '--json') {
      args.json = true;
      continue;
    }
    if (a === '--remove-all') {
      args.removeAll = true;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// workspace.repoRemotes is on unless it is exactly false. A workspace.json
// that is missing or cannot be parsed leaves it on, the same as an absent key.
function repoRemotesEnabled(rootDir) {
  try {
    const raw = JSON.parse(readFileSync(join(rootDir, 'workspace.json'), 'utf8'));
    return raw?.workspace?.repoRemotes !== false;
  } catch {
    return true;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = resolve(args.root);
  // --remove-all cleans up whatever workspace.json says.
  const enabled = args.removeAll ? false : repoRemotesEnabled(rootDir);
  const result = syncRepoRemotes(rootDir, { enabled });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const lines = notable(result).map((part) => LABEL + part);
  if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n');
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`repo-remotes: ${err.message}\n`);
    process.exitCode = 2;
  }
}
