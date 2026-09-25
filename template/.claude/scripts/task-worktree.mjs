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
// detectWorkModel tells a skill which lifecycle the current directory is
// under, so /complete-work can stay thin: one command, then the right flow.
//
// Usage:
//   node task-worktree.mjs --root <dir> --create --repo <r> --branch <b> [--base <ref>]
//   node task-worktree.mjs --root <dir> --remove --repo <r> --branch <b> [--force]
//   node task-worktree.mjs --root <dir> --detect [--cwd <dir>]

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, realpathSync,
} from 'node:fs';
import { join, resolve, relative, sep, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const WORKTREES_DIR = join('.claude', 'worktrees');
// Exclude patterns are git syntax: forward slashes on every platform.
const EXCLUDE_LINE = '.claude/worktrees/';

function readConfig(root) {
  try {
    return JSON.parse(readFileSync(join(resolve(root), 'workspace.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function defaultBranchFor(root, repo) {
  const branch = readConfig(root)?.repos?.[repo]?.branch;
  return typeof branch === 'string' && branch ? branch : 'main';
}

function sessionsDirName(root) {
  const dir = readConfig(root)?.workspace?.workSessionsDir;
  return typeof dir === 'string' && dir ? dir : 'work-sessions';
}

// gitFn is injectable so callers (or tests) can observe or fake git; the
// default is spawnSync itself, called as (command, args, options).
function run(gitFn, cwd, args) {
  const res = gitFn('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`git: ${res.error.message}`);
  return res;
}

function refExists(gitFn, cwd, ref) {
  return run(gitFn, cwd, ['rev-parse', '--verify', '--quiet', ref]).status === 0;
}

function slugForBranch(branch) {
  return branch.split('/').join('-');
}

function taskWorktreePath(root, repo, branch) {
  return join(resolve(root), 'repos', repo, WORKTREES_DIR, slugForBranch(branch));
}

// Normalize both sides to forward slashes before comparing, so a root that
// reached us through a symlink or a Windows drive still matches the path
// git recorded at creation time.
function samePath(a, b) {
  const norm = (p) => {
    try { return realpathSync(p); } catch { return resolve(p); }
  };
  return norm(a).split(sep).join('/') === norm(b).split(sep).join('/');
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

/**
 * Create (or return) the task worktree for {branch} in {repo}.
 *
 * Idempotent: a worktree already at the path on the same branch is a
 * success — /start-work is not guaranteed to run exactly once per task. A
 * path held by anything else is a collision and refuses rather than
 * guessing. If the branch already exists (a prior remove kept it), it is
 * checked out instead of recreated, so an abandoned task resumes with its
 * commits intact.
 */
function createTaskWorktree(root, { repo, branch, base = null, gitFn = spawnSync } = {}) {
  if (!repo) throw new Error('createTaskWorktree: repo is required');
  if (!branch) throw new Error('createTaskWorktree: branch is required');
  const rootDir = resolve(root);
  const repoDir = join(rootDir, 'repos', repo);
  if (!existsSync(repoDir)) throw new Error(`createTaskWorktree: no repo "${repo}" under ${join(rootDir, 'repos')}`);
  const path = taskWorktreePath(rootDir, repo, branch);
  const branchRef = `refs/heads/${branch}`;

  if (existsSync(path)) {
    const existing = listWorktrees(gitFn, repoDir).find((w) => samePath(w.path, path));
    if (!existing) throw new Error(`createTaskWorktree: ${path} exists but is not a git worktree`);
    if (existing.branch !== branchRef) {
      throw new Error(`createTaskWorktree: ${path} is on ${existing.branch ?? 'a detached HEAD'}, not ${branch}`);
    }
    ensureExcluded(repoDir);
    return { repo, branch, path, created: false };
  }

  // Base tracks what has actually merged when origin exists, so new work
  // starts from the remote's default branch rather than a possibly stale
  // local clone.
  const defaultBranch = defaultBranchFor(rootDir, repo);
  const resolvedBase = base
    || (refExists(gitFn, repoDir, `refs/remotes/origin/${defaultBranch}`)
      ? `origin/${defaultBranch}`
      : defaultBranch);

  const args = refExists(gitFn, repoDir, branchRef)
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, resolvedBase];
  const res = run(gitFn, repoDir, args);
  if (res.status !== 0) {
    throw new Error(`createTaskWorktree: git worktree add failed: ${String(res.stderr || '').trim()}`);
  }
  ensureExcluded(repoDir);
  return { repo, branch, path, created: true };
}

/**
 * Remove the task worktree for {branch} in {repo}. The branch is
 * deliberately NOT deleted — re-creating the task after a failed PR needs
 * it, and post-merge branch cleanup is the forge's job (deleteBranch).
 * A missing worktree is a no-op so cleanup can run unconditionally.
 */
function removeTaskWorktree(root, { repo, branch, force = false, gitFn = spawnSync } = {}) {
  if (!repo) throw new Error('removeTaskWorktree: repo is required');
  if (!branch) throw new Error('removeTaskWorktree: branch is required');
  const rootDir = resolve(root);
  const repoDir = join(rootDir, 'repos', repo);
  const path = taskWorktreePath(rootDir, repo, branch);
  if (!existsSync(path)) return { repo, branch, path, removed: false };

  // The worktree holds the only copy of uncommitted work until the branch
  // is pushed. git refuses too, but without saying what the user should do.
  const status = run(gitFn, path, ['status', '--porcelain']);
  if (status.status === 0 && String(status.stdout).trim() !== '' && !force) {
    throw new Error(`removeTaskWorktree: ${path} has uncommitted changes; re-run with force to discard them`);
  }

  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
  const res = run(gitFn, repoDir, args);
  if (res.status !== 0) {
    throw new Error(`removeTaskWorktree: git worktree remove failed: ${String(res.stderr || '').trim()}`);
  }
  run(gitFn, repoDir, ['worktree', 'prune']);
  return { repo, branch, path, removed: true };
}

function realPath(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

// relative() output is "inside" when it is a plain descent — not '', '..',
// a '..'-prefixed climb, or a cross-volume absolute path (Windows drives).
function isDescent(rel) {
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function currentBranch(gitFn, path) {
  try {
    const res = gitFn('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    return res && res.status === 0 ? String(res.stdout).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Tell a skill which lifecycle the current directory belongs to.
 *
 * The old model's sessions nest project worktrees under themselves, so
 * anywhere at or below work-sessions/{name}/workspace is 'session'. The
 * task model's worktrees sit at repos/{repo}/.claude/worktrees/{slug} and
 * are 'task'. Everything else — including the workspace root and the bare
 * session folder above a workspace/ — is 'none'.
 */
function detectWorkModel(cwd, root, { gitFn = spawnSync } = {}) {
  const rootReal = realPath(resolve(root));
  const cwdReal = realPath(resolve(cwd));

  const sessionsDir = join(rootReal, sessionsDirName(rootReal));
  const relSession = relative(sessionsDir, cwdReal);
  if (isDescent(relSession)) {
    const parts = relSession.split(sep);
    if (parts.length >= 2 && parts[1] === 'workspace') {
      return {
        model: 'session',
        sessionName: parts[0],
        workspaceDir: join(sessionsDir, parts[0], 'workspace'),
      };
    }
  }

  const reposDir = join(rootReal, 'repos');
  const relRepo = relative(reposDir, cwdReal);
  if (isDescent(relRepo)) {
    const parts = relRepo.split(sep);
    if (parts.length >= 4 && parts[1] === '.claude' && parts[2] === 'worktrees') {
      const path = join(reposDir, parts[0], WORKTREES_DIR, parts[3]);
      return { model: 'task', repo: parts[0], branch: currentBranch(gitFn, path), path };
    }
  }

  return { model: 'none' };
}

function parseArgs(argv) {
  const args = { root: '.', mode: null, repo: null, branch: null, base: null, cwd: null, force: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--root') { args.root = rest[++i]; continue; }
    if (a === '--create') { args.mode = 'create'; continue; }
    if (a === '--remove') { args.mode = 'remove'; continue; }
    if (a === '--detect') { args.mode = 'detect'; continue; }
    if (a === '--repo') { args.repo = rest[++i]; continue; }
    if (a === '--branch') { args.branch = rest[++i]; continue; }
    if (a === '--base') { args.base = rest[++i]; continue; }
    if (a === '--cwd') { args.cwd = rest[++i]; continue; }
    if (a === '--force') { args.force = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  if (!args.mode) throw new Error('one of --create, --remove, --detect is required');
  if (args.mode === 'create' && (!args.repo || !args.branch)) {
    throw new Error('--create requires --repo and --branch');
  }
  if (args.mode === 'remove' && (!args.repo || !args.branch)) {
    throw new Error('--remove requires --repo and --branch');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  let out;
  if (args.mode === 'create') {
    out = createTaskWorktree(args.root, { repo: args.repo, branch: args.branch, base: args.base });
  } else if (args.mode === 'remove') {
    out = removeTaskWorktree(args.root, { repo: args.repo, branch: args.branch, force: args.force });
  } else {
    out = detectWorkModel(args.cwd || process.cwd(), args.root);
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
  slugForBranch, taskWorktreePath, createTaskWorktree, removeTaskWorktree,
  detectWorkModel, parseArgs, WORKTREES_DIR, EXCLUDE_LINE,
};
