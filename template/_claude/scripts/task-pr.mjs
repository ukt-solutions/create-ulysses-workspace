#!/usr/bin/env node
// PR creation and merge for the task lifecycle (gh:163).
//
// The task path of /complete-work used to end with two hand-written
// JavaScript blocks — one to push and open a PR per repo, one to merge them
// in order and close the issue. Every run re-typed them, and every
// re-typing was a fresh chance to drop a guard: origins must be parsed
// before anything is pushed, body files must exist for every repo that
// gets a PR, and the workspace PR must never merge ahead of the project
// PRs it describes. This script is those blocks written once.
//
// It runs from the launcher and owns only this slice: the rebase and the
// drawer routing happen in the skill's earlier steps, and teardown stays
// in task-worktree.mjs --remove.
//
// Usage:
//   node task-pr.mjs --create --root <launcher> --branch <branch>
//                    [--work-item gh:N] [--chat <name> | --repo <r> ...]
//                    --body-file <repo>=<path> ... [--force-with-lease]
//   node task-pr.mjs --merge --root <launcher> --prs <json-from-create>
//                    [--work-item gh:N]
//
// --create resolves the task's repos from the chat record's entries for
// the branch (--chat) or from repeated --repo flags, skips repos whose
// branch has no commits over origin/{default} (reported as empty), pushes
// each remaining branch, and opens one PR per repo through a per-repo
// forge. The PR title is the linked issue's title when --work-item is
// given, else the branch's first commit subject; the body is the repo's
// body file with `Closes <ref>` appended. Prints `{ prs, empty }`.
//
// --merge merges the project PRs first (squash, delete branch), the
// workspace PR only when every project merge succeeded, then pulls the
// launcher --ff-only and closes the linked issue. On any failure it stops
// and names the PRs still open.

import '../lib/require-node.mjs';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { taskWorktreePath, defaultBranchFor, WORKSPACE_REPO } from './task-worktree.mjs';
import { readRecord } from './chat-record.mjs';
import { createForge } from './forges/interface.mjs';
import { createTracker } from './trackers/interface.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

// Same remote shapes the forge adapters resolve a repo from. A URL that
// does not match is not forge-hosted, and this path supports forge-hosted
// repos only — a local/bare remote has no PR concept to aim at.
const FORGE_REMOTE_RE = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/;

function parseForgeRemote(url) {
  const m = String(url).trim().match(FORGE_REMOTE_RE);
  return m ? { owner: m[1], name: m[2] } : null;
}

function readWorkspace(rootDir) {
  try {
    return JSON.parse(readFileSync(join(rootDir, 'workspace.json'), 'utf-8'));
  } catch {
    throw new Error(`cannot read ${join(rootDir, 'workspace.json')} — is --root the launcher?`);
  }
}

// `workspace.forge: false` is an explicit opt-out; spreading it into a
// per-repo config would silently produce a default GitHub forge instead.
function assertForgeEnabled(ws) {
  if (ws?.workspace?.forge === false) {
    throw new Error('workspace.forge is false — forge operations are disabled here. Nothing was pushed; open the PR by hand.');
  }
}

function gitCheck(gitFn, cwd, args) {
  const res = gitFn('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`git: ${res.error.message}`);
  return res;
}

function gitOut(gitFn, cwd, args) {
  const res = gitCheck(gitFn, cwd, args);
  if (res.status !== 0) {
    throw new Error(`git -C ${cwd} ${args.join(' ')} failed: ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '').trim();
}

// The merge base for "is this branch empty" and for the fallback PR title.
// origin/{default} is the truth the PR will merge against; the local branch
// covers a repo whose remote-tracking ref is missing.
function baseRefFor(gitFn, worktree, defaultBranch) {
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    if (gitCheck(gitFn, worktree, ['rev-parse', '--verify', '--quiet', ref]).status === 0) return ref;
  }
  return null;
}

function commitsOverBase(gitFn, worktree, branch, defaultBranch) {
  const base = baseRefFor(gitFn, worktree, defaultBranch);
  // No base ref at all: the branch cannot be proven empty, so it proceeds.
  if (!base) return null;
  return parseInt(gitOut(gitFn, worktree, ['rev-list', '--count', `${base}..${branch}`]), 10) || 0;
}

function firstCommitSubject(gitFn, worktree, branch, defaultBranch) {
  const base = baseRefFor(gitFn, worktree, defaultBranch);
  const range = base ? `${base}..${branch}` : branch;
  const subjects = gitOut(gitFn, worktree, ['log', '--reverse', '--format=%s', range])
    .split(/\r?\n/).filter((l) => l.trim() !== '');
  if (subjects.length > 0) return subjects[0].trim();
  return gitOut(gitFn, worktree, ['log', '-1', '--format=%s', branch]);
}

function pushBranch(gitFn, worktree, repo, branch, { forceWithLease = false } = {}) {
  const res = gitCheck(gitFn, worktree, [
    'push', '-u', 'origin', ...(forceWithLease ? ['--force-with-lease'] : []), branch,
  ]);
  if (res.status === 0) return;
  const stderr = String(res.stderr || '').trim();
  if (!forceWithLease && /non-fast-forward|fetch first/i.test(stderr)) {
    throw new Error(
      `repo "${repo}": push rejected as non-fast-forward — the branch already exists on origin and the rebase rewrote it. Confirm and re-run with --force-with-lease; this script never forces on its own.`,
    );
  }
  throw new Error(`repo "${repo}": git push failed: ${stderr}`);
}

function resolveTaskRepos(rootDir, { chat, branch, repos }) {
  if (repos.length > 0) return [...new Set(repos)];
  if (!chat) {
    throw new Error("--create needs the task's repos: pass --chat <name> (its record entries for the branch) or repeat --repo");
  }
  const rec = readRecord(rootDir, chat);
  const entries = (rec?.tasks ?? []).filter((t) => t.branch === branch && t.repo);
  if (entries.length === 0) {
    throw new Error(`chat record "${chat}" has no task entries for branch ${branch} — pass --repo explicitly`);
  }
  return [...new Set(entries.map((t) => t.repo))];
}

async function createPrs(args, deps) {
  const rootDir = resolve(args.root);
  const ws = readWorkspace(rootDir);
  assertForgeEnabled(ws);

  const targets = resolveTaskRepos(rootDir, args).map((repo) => {
    const worktree = taskWorktreePath(rootDir, repo, args.branch);
    if (!existsSync(worktree)) {
      throw new Error(`no task worktree at ${worktree} for repo "${repo}" — create it with task-worktree.mjs --create`);
    }
    return {
      repo, worktree, isWorkspace: repo === WORKSPACE_REPO,
      defaultBranch: defaultBranchFor(rootDir, repo, deps.gitFn),
    };
  });

  for (const t of targets) t.commits = commitsOverBase(deps.gitFn, t.worktree, args.branch, t.defaultBranch);
  const empty = targets.filter((t) => t.commits === 0).map((t) => t.repo);
  const active = targets.filter((t) => t.commits !== 0);

  // Every guard runs before the first push: a repo whose origin cannot
  // host a PR, or whose body file is missing, must stop the whole task
  // with nothing pushed and nothing half-opened.
  for (const t of active) {
    const url = gitOut(deps.gitFn, t.worktree, ['remote', 'get-url', 'origin']);
    const parsed = parseForgeRemote(url);
    if (!parsed) {
      throw new Error(`repo "${t.repo}": origin (${url}) is not a forge-hosted repository — stopped before pushing anything. Complete this repo under the session model.`);
    }
    Object.assign(t, parsed);
  }
  for (const t of active) {
    const bodyFile = args.bodyFiles.get(t.repo);
    if (!bodyFile) {
      throw new Error(`repo "${t.repo}" has commits to merge but no --body-file — one is required for every repo that gets a PR`);
    }
    if (!existsSync(bodyFile)) {
      throw new Error(`repo "${t.repo}": body file not found: ${bodyFile}`);
    }
  }

  let issueTitle = null;
  let issueRefs = null;
  if (args.workItem) {
    const tracker = deps.trackerFactory(ws.workspace?.tracker);
    issueTitle = (await tracker.getIssue(args.workItem)).title;
    issueRefs = new Map(active.map((t) => [t.repo, tracker.issueRef(args.workItem, { fromRepo: `${t.owner}/${t.name}` })]));
  }

  for (const t of active) {
    pushBranch(deps.gitFn, t.worktree, t.repo, args.branch, { forceWithLease: args.forceWithLease });
  }

  const prs = [];
  for (const t of active) {
    const forge = deps.forgeFactory({ ...(ws.workspace?.forge ?? {}), repo: `${t.owner}/${t.name}` });
    const title = issueTitle ?? firstCommitSubject(deps.gitFn, t.worktree, args.branch, t.defaultBranch);
    let body = readFileSync(args.bodyFiles.get(t.repo), 'utf8').replace(/\s*$/, '');
    if (issueRefs) body = `${body}\n\nCloses ${issueRefs.get(t.repo)}\n`;
    const pr = await forge.prCreate({ title, body, head: args.branch, base: t.defaultBranch });
    prs.push({
      repo: t.repo, owner: t.owner, name: t.name,
      number: pr.number, id: pr.id, url: pr.url, isWorkspace: t.isWorkspace,
    });
  }
  return { prs, empty };
}

async function mergePrs(args, deps) {
  const rootDir = resolve(args.root);
  const ws = readWorkspace(rootDir);
  assertForgeEnabled(ws);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(args.prs, 'utf-8'));
  } catch (err) {
    throw new Error(`cannot read PRs file ${args.prs}: ${err.message}`);
  }
  const prs = Array.isArray(parsed?.prs) ? parsed.prs : [];
  for (const p of prs) {
    if (!p || !p.owner || !p.name || !p.id) {
      throw new Error(`PRs file entry is missing owner/name/id: ${JSON.stringify(p)}`);
    }
  }
  const forgeFor = (p) => deps.forgeFactory({ ...(ws.workspace?.forge ?? {}), repo: `${p.owner}/${p.name}` });

  const merged = [];
  const failures = [];
  for (const p of prs.filter((x) => !x.isWorkspace)) {
    try {
      await forgeFor(p).prMerge({ id: p.id, strategy: 'squash', deleteBranch: true });
      merged.push(p);
    } catch (err) { failures.push(`${p.repo}: ${err.message}`); }
  }
  const workspacePr = prs.find((x) => x.isWorkspace) ?? null;
  if (failures.length === 0 && workspacePr) {
    try {
      await forgeFor(workspacePr).prMerge({ id: workspacePr.id, strategy: 'squash', deleteBranch: true });
      merged.push(workspacePr);
    } catch (err) { failures.push(`${workspacePr.repo}: ${err.message}`); }
  }
  if (failures.length > 0) {
    const open = prs.filter((p) => !merged.includes(p)).map((p) => `${p.repo}: ${p.url}`);
    throw new Error(
      `merge stopped (${failures.join('; ')}). PRs still open: ${open.join(', ')}. The workspace PR is never merged ahead of the project PRs — fix the failure and re-run --merge.`,
    );
  }

  // The launcher sat on its default branch waiting on the workspace merge;
  // a project-only task pulls after the project merges instead. Either way
  // the pull only happens once every merge above succeeded.
  const pull = gitCheck(deps.gitFn, rootDir, ['pull', '--ff-only']);
  if (pull.status !== 0) {
    throw new Error(`git -C ${rootDir} pull --ff-only failed: ${String(pull.stderr || '').trim()} — the merges landed; pull by hand before teardown`);
  }

  let closed = null;
  if (args.workItem) {
    const tracker = deps.trackerFactory(ws.workspace?.tracker);
    await tracker.closeIssue(args.workItem, { comment: `Merged: ${merged.map((p) => p.url).join(' ')}` });
    closed = args.workItem;
  }
  return { merged: merged.map(({ repo, number, url }) => ({ repo, number, url })), closed };
}

const MODE_FLAGS = new Set(['--create', '--merge']);
const VALUE_FLAGS = new Set(['--root', '--branch', '--work-item', '--chat', '--prs']);

function parseArgs(argv) {
  const args = {
    root: '.', mode: null, branch: null, workItem: null, chat: null,
    repos: [], bodyFiles: new Map(), prs: null, forceWithLease: false,
  };
  const rest = argv.slice(2);
  const value = (i, flag) => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (MODE_FLAGS.has(a)) {
      if (args.mode) throw new Error(`only one of --create, --merge may be given (already have --${args.mode})`);
      args.mode = a.slice(2);
      continue;
    }
    if (a === '--repo') { args.repos.push(value(i, a)); i += 1; continue; }
    if (a === '--body-file') {
      const v = value(i, a);
      const eq = v.indexOf('=');
      if (eq <= 0) throw new Error(`--body-file expects <repo>=<path>, got: ${v}`);
      args.bodyFiles.set(v.slice(0, eq), v.slice(eq + 1));
      i += 1;
      continue;
    }
    if (a === '--force-with-lease') { args.forceWithLease = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value(i, a);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  if (!args.mode) throw new Error('one of --create, --merge is required');
  if (args.mode === 'create') {
    if (!args.branch) throw new Error('--create requires --branch');
    if (!args.chat && args.repos.length === 0) throw new Error('--create requires --chat or at least one --repo');
    if (args.prs) throw new Error('--prs is only valid with --merge');
  } else {
    if (!args.prs) throw new Error('--merge requires --prs');
    for (const flag of ['branch', 'chat']) {
      if (args[flag]) throw new Error(`--${flag} is only valid with --create`);
    }
    if (args.repos.length > 0) throw new Error('--repo is only valid with --create');
    if (args.bodyFiles.size > 0) throw new Error('--body-file is only valid with --create');
    if (args.forceWithLease) throw new Error('--force-with-lease is only valid with --create');
  }
  return args;
}

/**
 * Run one task-pr command. `argv` is a process.argv-shaped array; `deps`
 * is injectable so tests can fake git, the forge, and the tracker:
 *   { gitFn, forgeFactory, trackerFactory }
 * Resolves with the command's JSON result; throws on any failure.
 */
async function run(argv, deps = {}) {
  const resolved = {
    gitFn: spawnSync,
    forgeFactory: createForge,
    trackerFactory: createTracker,
    ...deps,
  };
  const args = parseArgs(argv);
  return args.mode === 'create' ? createPrs(args, resolved) : mergePrs(args, resolved);
}

async function main() {
  const out = await run(process.argv);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`task-pr: ${err.message}\n`);
    process.exit(2);
  });
}

export { run, parseArgs, parseForgeRemote };
