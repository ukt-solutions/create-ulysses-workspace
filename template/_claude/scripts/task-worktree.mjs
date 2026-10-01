#!/usr/bin/env node
// Task worktrees — the lightweight second lifecycle for work (gh:132).
//
// A work session is the right shape for a multi-chat effort: a folder, a
// workspace worktree, a tracker file. It is ceremony for the other common
// case — one issue, one branch, done in a chat. A task is exactly that: a
// tracker issue plus a branch plus one worktree per repo it touches,
// recorded on the chat record instead of in a session.md.
//
// Worktrees live at repos/{repo}/.claude/worktrees/{slug}/ — the same
// location Claude Code's native worktree feature uses — so a task created
// here and one created natively converge on a single layout instead of
// forking it.
//
// The workspace repo itself is addressed as "." everywhere a repo name is
// accepted (gh:146). Its worktree lives at {root}/.claude/worktrees/{slug}/
// — exactly where EnterWorktree puts worktrees of the repo Claude Code
// launched in — so the two converge there too, and the workspace's
// .gitignore covers the path for both.
//
// In the task model the chat runs at the workspace root (the launcher),
// not inside a worktree, so detection cannot rely on cwd alone: given a
// chat name it also consults the chat record, which is the only place
// open tasks are listed. /complete-work uses that to pick its flow.
//
// Usage:
//   node task-worktree.mjs --root <dir> --create --repo <r> --branch <b> [--base <ref>]
//   node task-worktree.mjs --root <dir> --remove --repo <r> --branch <b> [--force] [--delete-branch]
//   node task-worktree.mjs --root <dir> --detect [--cwd <dir>] [--chat <name>]

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRecord } from './chat-record.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const WORKTREES_DIR = join('.claude', 'worktrees');
// The workspace repo (the launcher) is addressed as "." — the one repo
// name that is not a directory under repos/.
const WORKSPACE_REPO = '.';
// Exclude patterns are git syntax: forward slashes on every platform.
const EXCLUDE_LINE = '.claude/worktrees/';

function isWorkspaceRepo(repo) {
  return repo === WORKSPACE_REPO;
}

function readConfig(root) {
  try {
    return JSON.parse(readFileSync(join(resolve(root), 'workspace.json'), 'utf-8'));
  } catch {
    return null;
  }
}

// The workspace repo has no workspace.json entry naming its default branch
// — origin's HEAD is the authority, with "main" as the fallback a fresh
// clone would get. Project repos keep their configured branch.
function defaultBranchFor(root, repo, gitFn = spawnSync) {
  if (isWorkspaceRepo(repo)) {
    const res = gitFn('git', ['-C', resolve(root), 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
    const name = res && res.status === 0 ? String(res.stdout).trim().replace(/^origin\//, '') : '';
    return name || 'main';
  }
  const branch = readConfig(root)?.repos?.[repo]?.branch;
  return typeof branch === 'string' && branch ? branch : 'main';
}

// resolve() rather than join(), so an absolute configured dir is honored.
function sessionsDirFor(root) {
  const dir = readConfig(root)?.workspace?.workSessionsDir;
  const name = typeof dir === 'string' && dir ? dir : 'work-sessions';
  return resolve(root, name);
}

// gitFn is injectable so callers (or tests) can observe or fake git; the
// default is spawnSync itself, called as (command, args, options).
function run(gitFn, cwd, args, opts = {}) {
  const res = gitFn('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts });
  if (res.error) throw new Error(`git: ${res.error.message}`);
  return res;
}

function refExists(gitFn, cwd, ref) {
  return run(gitFn, cwd, ['rev-parse', '--verify', '--quiet', ref]).status === 0;
}

// Branch names become paths and refs, so git's own check is the authority:
// --branch also rejects names ambiguous with other ref namespaces and names
// containing "..". It needs no repository, so it runs before anything else.
function assertBranchName(gitFn, branch) {
  const res = gitFn('git', ['check-ref-format', '--branch', branch], { encoding: 'utf8' });
  if (res.error || res.status !== 0) throw new Error(`invalid branch name: ${branch}`);
}

function slugForBranch(branch) {
  return branch.split('/').join('-');
}

function taskWorktreePath(root, repo, branch) {
  return join(repoDirFor(resolve(root), repo), WORKTREES_DIR, slugForBranch(branch));
}

// "." is the workspace repo itself — the git repo at the root. Every other
// name is a directory under repos/.
function repoDirFor(rootDir, repo) {
  return isWorkspaceRepo(repo) ? rootDir : join(rootDir, 'repos', repo);
}

// .native resolves Windows 8.3 short names; the plain fallback covers
// filesystems where the native binding is unavailable.
function realPath(p) {
  try { return realpathSync.native(p); } catch { /* fall through */ }
  try { return realpathSync(p); } catch { /* fall through */ }
  return resolve(p);
}

// Normalize both sides to forward slashes before comparing, so a root that
// reached us through a symlink or a Windows drive still matches the path
// git recorded at creation time.
function samePath(a, b) {
  return realPath(a).split(sep).join('/') === realPath(b).split(sep).join('/');
}

function listWorktrees(gitFn, repoDir) {
  const res = run(gitFn, repoDir, ['worktree', 'list', '--porcelain']);
  if (res.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of String(res.stdout).split(/\r?\n/)) {
    if (!line) { cur = null; continue; }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null };
      out.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length);
    }
  }
  return out;
}

// A branch checked out in any worktree cannot be deleted; report rather
// than error, so the partial-teardown retry can return a clean false.
function deleteLocalBranch(gitFn, repoDir, branch) {
  if (!refExists(gitFn, repoDir, `refs/heads/${branch}`)) return false;
  if (listWorktrees(gitFn, repoDir).some((w) => w.branch === `refs/heads/${branch}`)) return false;
  return run(gitFn, repoDir, ['branch', '-D', branch]).status === 0;
}

// A worktree inside the source clone's working tree would show up as
// untracked noise on every git status. The clone's local exclude file is
// the place to hide it: machine-local, so nothing is imposed on the shared
// .gitignore, and append-once so repeated creates cannot duplicate it.
function ensureExcluded(repoDir) {
  const gitDir = join(repoDir, '.git');
  let content = '';
  try {
    if (!statSync(gitDir).isDirectory()) return; // a linked worktree — no local exclude to write
    content = readFileSync(join(gitDir, 'info', 'exclude'), 'utf-8');
  } catch { /* no exclude file yet */ }
  if (content.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
  const excludePath = join(gitDir, 'info', 'exclude');
  mkdirSync(dirname(excludePath), { recursive: true });
  const gap = content === '' || content.endsWith('\n') ? '' : '\n';
  writeFileSync(excludePath, `${content}${gap}${EXCLUDE_LINE}\n`);
}

// The workspace's .gitignore normally covers .claude/worktrees/ (the
// template ships the line), so no machine-local exclude is needed — but a
// workspace whose .gitignore predates the line would stage the worktree as
// an embedded repo on the next `git add -A` at the launcher. Trust
// .gitignore only after git itself confirms the path is ignored.
function ensureWorkspaceExcluded(gitFn, rootDir) {
  const res = gitFn('git', ['-C', rootDir, 'check-ignore', '-q', `${EXCLUDE_LINE}probe`], { encoding: 'utf8' });
  if (res && res.status === 0) return;
  ensureExcluded(rootDir);
}

/**
 * Create (or return) the task worktree for {branch} in {repo}.
 *
 * Idempotent: a worktree already at the path on the same branch is a
 * success — /start-work is not guaranteed to run exactly once per task. A
 * path held by anything else is a collision and refuses rather than
 * guessing. Three creation cases, in order:
 *   - the local branch exists (a prior remove kept it) → check it out,
 *     keeping its commits;
 *   - only refs/remotes/origin/{branch} exists → the task was started on
 *     another machine; create a tracking branch from the remote;
 *   - neither → new branch from the base, --no-track so the default
 *     branch is never accidentally the push target.
 */
function createTaskWorktree(root, { repo, branch, base = null, gitFn = spawnSync } = {}) {
  if (!repo) throw new Error('createTaskWorktree: repo is required');
  if (!branch) throw new Error('createTaskWorktree: branch is required');
  assertBranchName(gitFn, branch);
  const rootDir = resolve(root);
  const repoDir = repoDirFor(rootDir, repo);
  if (!isWorkspaceRepo(repo) && !existsSync(repoDir)) {
    throw new Error(`createTaskWorktree: no repo "${repo}" under ${join(rootDir, 'repos')}`);
  }
  const path = taskWorktreePath(rootDir, repo, branch);
  const branchRef = `refs/heads/${branch}`;

  if (existsSync(path)) {
    const existing = listWorktrees(gitFn, repoDir).find((w) => samePath(w.path, path));
    if (!existing) throw new Error(`createTaskWorktree: ${path} exists but is not a git worktree`);
    if (existing.branch !== branchRef) {
      throw new Error(`createTaskWorktree: ${path} is on ${existing.branch ?? 'a detached HEAD'}, not ${branch}`);
    }
    // Project clones always get the machine-local exclude; the workspace
    // only when its .gitignore does not already cover the path.
    if (isWorkspaceRepo(repo)) ensureWorkspaceExcluded(gitFn, repoDir);
    else ensureExcluded(repoDir);
    return { repo, branch, path, created: false };
  }

  // Best-effort refresh before choosing anything from origin — deliberately
  // NOT via run(): a hung remote makes spawnSync return an ETIMEDOUT error
  // object, and run() throws on any error, which would turn "merely slow"
  // into a hard failure. The 10 s ceiling matches the session-start hook's
  // fetch budget; a failed or timed-out fetch just means a staler base.
  gitFn('git', ['-C', repoDir, 'fetch', 'origin'], { encoding: 'utf8', timeout: 10000 });
  run(gitFn, repoDir, ['worktree', 'prune']);

  // The base is a starting point, not a freshness guarantee: origin's
  // default branch as of the best-effort fetch above, and — for a repo with
  // no origin, whose task completes in local mode (gh:173) — the local
  // default branch itself, there being no remote ref to prefer.
  const defaultBranch = defaultBranchFor(rootDir, repo, gitFn);
  const resolvedBase = base
    || (refExists(gitFn, repoDir, `refs/remotes/origin/${defaultBranch}`)
      ? `origin/${defaultBranch}`
      : defaultBranch);

  let args;
  if (refExists(gitFn, repoDir, branchRef)) {
    args = ['worktree', 'add', path, branch];
  } else if (refExists(gitFn, repoDir, `refs/remotes/origin/${branch}`)) {
    args = ['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`];
  } else {
    args = ['worktree', 'add', '--no-track', '-b', branch, path, resolvedBase];
  }
  const res = run(gitFn, repoDir, args);
  if (res.status !== 0) {
    throw new Error(`createTaskWorktree: git worktree add failed: ${String(res.stderr || '').trim()}`);
  }
  if (isWorkspaceRepo(repo)) ensureWorkspaceExcluded(gitFn, repoDir);
  else ensureExcluded(repoDir);
  return { repo, branch, path, created: true };
}

/**
 * Remove the task worktree for {branch} in {repo}. The branch is kept by
 * default — re-creating the task after a failed PR needs it. With
 * deleteBranch: true it is deleted too, with -D because a squash merge is
 * never an ancestor; the forge's deleteBranch removed only the REMOTE
 * branch, so post-merge teardown passes this to clean the local clone.
 * deleteBranch always refuses the repo's default branch — the branch
 * checked out at the launcher root is protected by the worktree check in
 * deleteLocalBranch, but a detached-HEAD launcher would not be, and no
 * repo's default branch is ever a task branch to clean up. A missing
 * worktree is a no-op so cleanup can run unconditionally.
 */
function removeTaskWorktree(root, { repo, branch, force = false, deleteBranch = false, gitFn = spawnSync } = {}) {
  if (!repo) throw new Error('removeTaskWorktree: repo is required');
  if (!branch) throw new Error('removeTaskWorktree: branch is required');
  assertBranchName(gitFn, branch);
  const rootDir = resolve(root);
  const repoDir = repoDirFor(rootDir, repo);
  const path = taskWorktreePath(rootDir, repo, branch);
  if (deleteBranch && branch === defaultBranchFor(rootDir, repo, gitFn)) {
    throw new Error(`removeTaskWorktree: ${branch} is the default branch of ${isWorkspaceRepo(repo) ? 'the workspace repo' : `repo "${repo}"`}; refusing to delete it`);
  }
  if (!existsSync(path)) {
    // A hand-deleted worktree directory leaves a stale record — prune it so
    // a later create is clean, and still honor deleteBranch: a retry after
    // a partial teardown must not leak the branch.
    run(gitFn, repoDir, ['worktree', 'prune']);
    if (deleteBranch) {
      return { repo, branch, path, removed: false, branchDeleted: deleteLocalBranch(gitFn, repoDir, branch) };
    }
    return { repo, branch, path, removed: false };
  }

  // The slug is lossy — feature/y and feature-y share one. Resolve through
  // git's registry so the worktree at this path must really be {branch}'s;
  // otherwise refuse rather than remove someone else's tree.
  const entry = listWorktrees(gitFn, repoDir).find((w) => samePath(w.path, path));
  if (!entry) throw new Error(`removeTaskWorktree: ${path} exists but is not a git worktree`);
  if (entry.branch !== `refs/heads/${branch}`) {
    throw new Error(`removeTaskWorktree: ${path} is on ${entry.branch ?? 'a detached HEAD'}, not ${branch} (slug collision)`);
  }

  // The worktree holds the only copy of uncommitted work until the branch
  // is pushed. git refuses too, but without saying what the user should do.
  const status = run(gitFn, path, ['status', '--porcelain']);
  if (status.status === 0 && String(status.stdout).trim() !== '' && !force) {
    throw new Error(`removeTaskWorktree: ${path} has uncommitted changes; re-run with force to discard them`);
  }

  const res = run(gitFn, repoDir, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
  if (res.status !== 0) {
    throw new Error(`removeTaskWorktree: git worktree remove failed: ${String(res.stderr || '').trim()}`);
  }
  run(gitFn, repoDir, ['worktree', 'prune']);
  if (deleteBranch && !deleteLocalBranch(gitFn, repoDir, branch)) {
    throw new Error(`removeTaskWorktree: git branch -D failed for ${branch}`);
  }
  return deleteBranch
    ? { repo, branch, path, removed: true, branchDeleted: true }
    : { repo, branch, path, removed: true };
}

// relative() output is "inside" when it is a plain descent — not '', '..',
// a '..'-prefixed climb, or a cross-volume absolute path (Windows drives).
function isDescent(rel) {
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function currentBranch(gitFn, path) {
  try {
    const res = gitFn('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    if (!res || res.status !== 0) return null;
    const name = String(res.stdout).trim();
    return name === 'HEAD' ? null : name; // "HEAD" means detached
  } catch {
    return null;
  }
}

// The session check, in two steps. Primary: cwd under this root's own
// sessions dir at {sessionsDir}/{name}/workspace. Fallback: the chat may
// be running inside a session worktree with that worktree itself passed
// as --root, so the sessions dir is not under the root at all — the real
// path still carries the layout, so recognize the junction wherever it
// appears in cwd's own segments (deepest match wins).
function detectSession(cwdReal, rootReal) {
  const sessionsDir = sessionsDirFor(rootReal);
  const rel = relative(sessionsDir, cwdReal);
  if (isDescent(rel)) {
    const parts = rel.split(sep);
    if (parts.length >= 2 && parts[1] === 'workspace') {
      return { model: 'session', sessionName: parts[0], workspaceDir: join(sessionsDir, parts[0], 'workspace') };
    }
  }
  const segs = cwdReal.split(sep);
  const name = basename(sessionsDir);
  for (let i = segs.length - 3; i >= 0; i -= 1) {
    if (segs[i] === name && segs[i + 2] === 'workspace') {
      return { model: 'session', sessionName: segs[i + 1], workspaceDir: segs.slice(0, i + 3).join(sep) };
    }
  }
  return null;
}

// The chat record's open tasks, when a chat name is known. With a branch,
// only that branch's entries match (the worktree case); without one, any
// open task counts (the at-launcher case — cwd says nothing there).
function matchingTasks(rootDir, chat, branch) {
  if (!chat) return null;
  const rec = readRecord(rootDir, chat);
  if (!rec || !Array.isArray(rec.tasks) || rec.tasks.length === 0) return null;
  const tasks = branch === null ? rec.tasks : rec.tasks.filter((t) => t.branch === branch);
  return tasks.length > 0 ? tasks : null;
}

// One task worktree's detect payload, or null when {path} does not really
// hold a task: a stale plain directory under .claude/worktrees/ would
// otherwise detect through cwd and resolve to the repo around it — for the
// workspace layout, to the launcher itself, whose default branch
// /complete-work would then rebase and push. So require git to confirm the
// path is a worktree root, and never report the repo's default branch.
function taskWorktreeInfo(gitFn, rootReal, repo, path, chat) {
  try {
    const res = gitFn('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (!res || res.status !== 0) return null;
    if (!samePath(String(res.stdout).trim(), path)) return null;
    const branch = currentBranch(gitFn, path);
    if (branch && branch === defaultBranchFor(rootReal, repo, gitFn)) return null;
    const out = { model: 'task', source: 'worktree', repo, branch, path };
    const tasks = matchingTasks(rootReal, chat, branch);
    if (tasks) out.tasks = tasks;
    return out;
  } catch {
    return null;
  }
}

/**
 * Tell a skill which lifecycle the current directory is under, in order:
 * session (cwd in the old model's tree), task (cwd in a task worktree,
 * enriched with the chat's matching tasks when {chat} is given), then —
 * because task chats run at the launcher, where cwd is just the root —
 * task again if the named chat's record has open tasks. Else none.
 */
function detectWorkModel(cwd, root, { chat = null, gitFn = spawnSync } = {}) {
  const rootReal = realPath(resolve(root));
  const cwdReal = realPath(resolve(cwd));

  const session = detectSession(cwdReal, rootReal);
  if (session) return session;

  // The workspace repo's own task worktrees: {root}/.claude/worktrees/{slug}.
  // {root}/.claude or {root}/.claude/worktrees themselves are not inside a
  // worktree and fall through.
  const relRoot = relative(rootReal, cwdReal);
  if (isDescent(relRoot)) {
    const rootParts = relRoot.split(sep);
    if (rootParts.length >= 3 && rootParts[0] === '.claude' && rootParts[1] === 'worktrees') {
      const hit = taskWorktreeInfo(gitFn, rootReal, WORKSPACE_REPO, join(rootReal, WORKTREES_DIR, rootParts[2]), chat);
      if (hit) return hit;
    }
  }

  const reposDir = join(rootReal, 'repos');
  const relRepo = relative(reposDir, cwdReal);
  if (isDescent(relRepo)) {
    const parts = relRepo.split(sep);
    if (parts.length >= 4 && parts[1] === '.claude' && parts[2] === 'worktrees') {
      const hit = taskWorktreeInfo(gitFn, rootReal, parts[0], join(reposDir, parts[0], WORKTREES_DIR, parts[3]), chat);
      if (hit) return hit;
    }
  }

  const tasks = matchingTasks(rootReal, chat, null);
  if (tasks) return { model: 'task', source: 'chat-record', tasks };

  return { model: 'none' };
}

const MODE_FLAGS = new Set(['--create', '--remove', '--detect']);
const VALUE_FLAGS = new Map([
  ['--root', 'root'],
  ['--repo', 'repo'],
  ['--branch', 'branch'],
  ['--base', 'base'],
  ['--cwd', 'cwd'],
  ['--chat', 'chat'],
]);

// A repo name becomes a path segment under repos/ — one segment only, no
// separators, dot segments, or absolute paths. "." is the one exception:
// it addresses the workspace repo itself (gh:146); ".." and every other
// dots-only name stay rejected.
function isRepoSegment(repo) {
  if (typeof repo !== 'string' || repo === '' || isAbsolute(repo)) return false;
  const segs = repo.split(/[\\/]/);
  if (segs.length !== 1) return false;
  return segs[0] === WORKSPACE_REPO || !/^\.+$/.test(segs[0]);
}

function parseArgs(argv) {
  const args = { root: '.', mode: null, repo: null, branch: null, base: null, cwd: null, chat: null, force: false, deleteBranch: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (MODE_FLAGS.has(a)) {
      if (args.mode) throw new Error(`only one of --create, --remove, --detect may be given (already have --${args.mode})`);
      args.mode = a.slice(2);
      continue;
    }
    if (a === '--force') { args.force = true; continue; }
    if (a === '--delete-branch') { args.deleteBranch = true; continue; }
    const key = VALUE_FLAGS.get(a);
    if (key) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      args[key] = v;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  if (!args.mode) throw new Error('one of --create, --remove, --detect is required');
  if (args.mode === 'create' && (!args.repo || !args.branch)) {
    throw new Error('--create requires --repo and --branch');
  }
  if (args.mode === 'remove' && (!args.repo || !args.branch)) {
    throw new Error('--remove requires --repo and --branch');
  }
  if (args.deleteBranch && args.mode !== 'remove') {
    throw new Error('--delete-branch is only valid with --remove');
  }
  if (args.repo != null && !isRepoSegment(args.repo)) {
    throw new Error(`--repo must be a single path segment, got: ${args.repo}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  let out;
  if (args.mode === 'create') {
    out = createTaskWorktree(args.root, { repo: args.repo, branch: args.branch, base: args.base });
  } else if (args.mode === 'remove') {
    out = removeTaskWorktree(args.root, { repo: args.repo, branch: args.branch, force: args.force, deleteBranch: args.deleteBranch });
  } else {
    out = detectWorkModel(args.cwd || process.cwd(), args.root, { chat: args.chat });
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`task-worktree: ${err.message}\n`);
    process.exit(2);
  }
}

export {
  slugForBranch, taskWorktreePath, repoDirFor, createTaskWorktree, removeTaskWorktree,
  detectWorkModel, parseArgs, defaultBranchFor, WORKSPACE_REPO,
  WORKTREES_DIR, EXCLUDE_LINE,
};
