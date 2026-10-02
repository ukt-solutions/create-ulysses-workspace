#!/usr/bin/env node
// PR creation and merge for the task lifecycle (gh:163), including local
// mode for repos with no forge to push to (gh:173).
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
//                    [--work-item gh:N|gl:N] [--chat <name> | --repo <r> ...]
//                    --body-file <forge-repo>=<path> ... [--out <file>]
//                    [--force-with-lease]
//   node task-pr.mjs --merge --root <launcher> --prs <json-from-create>
//                    [--work-item gh:N|gl:N]
//
// Every repo of the task resolves to a merge mode (mergeModeFor below):
// "forge" — its origin is forge-hosted (github.com, gitlab.com, or the
// configured self-managed GitLab host) — or "local" — no
// origin at all, or an explicit "local" override in workspace.json
// (repos.{repo}.merge / workspace.merge), the escape hatch for a clone
// whose origin is a third-party upstream nobody here may push to. An
// origin that is neither stops the run with the override spelled out.
//
// --create resolves the task's repos from the chat record's entries for
// the branch (--chat) or from repeated --repo flags, skips repos whose
// branch has no commits over the base — origin/{default} for a forge
// repo, the local {default} for a local repo, whose origin ref never
// advances — (reported as empty), pushes each remaining forge branch, and
// opens one PR per forge repo through a per-repo forge — a local repo is
// neither pushed nor PR'd, only recorded as a local entry for --merge (a
// body file is required per forge repo alone; one given for a local repo
// is ignored). The PR title is the linked issue's title when --work-item
// is given, else the branch's first commit subject; the body is the
// repo's body file with `Closes <ref>` appended. Prints
// `{ prs, empty, pushed }` — prs holds forge entries (mode "forge") and
// local entries (mode "local") alike, every entry carrying its commit
// count — and, with --out, writes the same JSON to a file — a mid-run
// failure still writes what has landed so far, so the state survives the
// error. A repo that already has an open PR for the branch gets it
// reused, so a re-run never opens a duplicate.
//
// --merge finishes every entry in the file: forge PRs first (squash,
// delete branch) and local branches as a `git merge --ff-only` in the
// repo's source clone — repos/{repo}, or the launcher itself for "." —
// which must sit clean on its default branch, and whose task branch must
// fast-forward or be rebased by hand. The project repos merge first, the
// workspace repo only when every project merge succeeded; a PR the forge
// reports as already MERGED and a local branch already contained in the
// default branch both count as done, which is what makes re-running after
// a partial failure safe. An empty or malformed PRs file — or one naming
// a repo other than "." or a plain repo name, since a local entry's repo
// becomes a path — is refused outright: no entries means nothing to merge
// and nothing to close. Once everything is merged the launcher is pulled
// --ff-only — only when it sits on the workspace default branch (else
// pullSkipped), never when "." was itself merged locally (the launcher
// already has that work), when the workspace repo is local (no forge
// merge happened that a pull could fetch), or when the launcher branch
// has no upstream to pull from — pullSkipped names which — and a failed
// pull is reported as pullFailed in the JSON rather than an error,
// because the merges stand and the issue still closes — and then the
// linked issue closes with a Merged: comment, but only when --work-item
// is given AND a tracker is configured; with no tracker the JSON reports
// closed: null and closeSkipped. On a merge failure it stops and names
// what is still open.

import '../lib/require-node.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { taskWorktreePath, defaultBranchFor } from './task-worktree.mjs';
import { WORKSPACE_REPO, repoDirFor, readWorkspace, parseForgeRemote, forgeHosts, mergeModeFor } from './merge-mode.mjs';
import { readRecord } from './chat-record.mjs';
import { createForge } from './forges/interface.mjs';
import { createTracker } from './trackers/interface.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

// `workspace.forge: false` is an explicit opt-out; spreading it into a
// per-repo config would silently produce a default GitHub forge instead.
function assertForgeEnabled(ws) {
  if (ws?.workspace?.forge === false) {
    throw new Error('workspace.forge is false — forge operations are disabled here. Nothing was pushed; open the PR by hand.');
  }
}

// The per-repo forge config: the workspace block (host, any shared
// settings) with the repo's own identity layered on. The origin's host and
// slug win over any workspace-level `type` — a workspace may mix GitHub
// and GitLab repos, and each repo's origin names where its PRs live, so
// one global type cannot speak for both.
function perRepoForge(ws, { forge, host, slug }) {
  return { ...(ws.workspace?.forge ?? {}), type: forge, host, repo: slug };
}

// Branch names become refs, refspecs, and (via the slug) paths; git's own
// format check is the authority, and its --branch variant also rejects
// names a later git call could mistake for an option. It needs no
// repository, so it runs before any other git call this script makes.
function assertBranchName(gitFn, branch) {
  const res = gitFn('git', ['check-ref-format', '--branch', branch], { encoding: 'utf8' });
  if (res.error || res.status !== 0) throw new Error(`invalid branch name: ${branch}`);
}

// The --prs file may have been written by a BOM-emitting writer (PowerShell
// redirection among them); JSON.parse chokes on the marker, so strip it.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function writeOut(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
// A forge repo counts against origin/{default} — the truth the PR will
// merge against — with the local branch as the fallback for a repo whose
// remote-tracking ref is missing. A local-mode repo counts against the
// local {default}, where its merges actually land: its origin ref never
// advances, so counting against it would re-count every already-merged
// commit (and misjudge every follow-up task as non-empty).
function baseRefFor(gitFn, target, branch) {
  const { worktree, defaultBranch, mode } = target;
  const refs = mode === 'local'
    ? [defaultBranch, `origin/${defaultBranch}`]
    : [`origin/${defaultBranch}`, defaultBranch];
  for (const ref of refs) {
    if (gitCheck(gitFn, worktree, ['rev-parse', '--verify', '--quiet', ref]).status === 0) return ref;
  }
  return null;
}

function commitsOverBase(gitFn, target, branch) {
  const base = baseRefFor(gitFn, target, branch);
  // No base ref at all: the branch cannot be proven empty, so it proceeds.
  if (!base) return null;
  return parseInt(gitOut(gitFn, target.worktree, ['rev-list', '--count', `${base}..${branch}`]), 10) || 0;
}

function firstCommitSubject(gitFn, target, branch) {
  const base = baseRefFor(gitFn, target, branch);
  const range = base ? `${base}..${branch}` : branch;
  const subjects = gitOut(gitFn, target.worktree, ['log', '--reverse', '--format=%s', range])
    .split(/\r?\n/).filter((l) => l.trim() !== '');
  if (subjects.length > 0) return subjects[0].trim();
  return gitOut(gitFn, target.worktree, ['log', '-1', '--format=%s', branch]);
}

function pushBranch(gitFn, worktree, repo, branch, { forceWithLease = false } = {}) {
  // `--` ends option parsing so the refspec can never read as a flag — git
  // accepts it on push. It is deliberately NOT used on the rev-parse /
  // rev-list / log calls, where git would flip the argument to a path.
  const res = gitCheck(gitFn, worktree, [
    'push', '-u', 'origin', ...(forceWithLease ? ['--force-with-lease'] : []), '--', branch,
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
  assertBranchName(deps.gitFn, args.branch);
  const rootDir = resolve(args.root);
  const ws = readWorkspace(rootDir);

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

  // Mode first, because the commit count itself depends on it: a local
  // repo counts against its local default branch, not the origin ref that
  // never advances (gh:173).
  for (const t of targets) t.mode = mergeModeFor(rootDir, t.repo, { gitFn: deps.gitFn });
  for (const t of targets) t.commits = commitsOverBase(deps.gitFn, t, args.branch);
  const empty = targets.filter((t) => t.commits === 0).map((t) => t.repo);
  const active = targets.filter((t) => t.commits !== 0);

  // Every guard runs before the first push: a repo whose origin can neither
  // host a PR nor opt out with "local", or whose body file is missing, must
  // stop the whole task with nothing pushed and nothing half-opened. The
  // same pass splits the task: local repos are recorded for --merge instead
  // of being pushed. An empty repo is exempt from the origin check — there
  // is nothing to merge however its remote is shaped.
  for (const t of active) {
    if (t.mode !== null) continue;
    const url = gitOut(deps.gitFn, t.worktree, ['remote', 'get-url', 'origin']);
    const setting = t.isWorkspace ? 'workspace.merge' : `repos.${t.repo}.merge`;
    throw new Error(`repo "${t.repo}": origin (${url}) is not a forge-hosted repository — stopped before pushing anything. Set ${setting} to "local" in workspace.json to merge this repo without a forge, or complete it under the session model.`);
  }
  const forgeActive = active.filter((t) => t.mode === 'forge');
  // Only the forge half of the task needs a forge; an all-local task must
  // still complete with forge operations disabled.
  if (forgeActive.length > 0) assertForgeEnabled(ws);
  for (const t of forgeActive) {
    Object.assign(t, parseForgeRemote(gitOut(deps.gitFn, t.worktree, ['remote', 'get-url', 'origin']), { hosts: forgeHosts(ws) }));
  }
  for (const t of forgeActive) {
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
  if (args.workItem && ws.workspace?.tracker) {
    const tracker = deps.trackerFactory(ws.workspace.tracker);
    issueTitle = (await tracker.getIssue(args.workItem)).title;
    issueRefs = new Map(forgeActive.map((t) => [t.repo, tracker.issueRef(args.workItem, { fromRepo: `${t.owner}/${t.name}` })]));
  }

  // Local entries are recorded up front, before anything can fail: they are
  // the run's only side effect for those repos, and losing one to a later
  // forge failure would leave --merge unable to finish the task.
  const prs = active
    .filter((t) => t.mode === 'local')
    .map((t) => ({
      repo: t.repo, mode: 'local', branch: args.branch, base: t.defaultBranch,
      worktree: t.worktree, commits: t.commits,
    }));
  const pushed = [];
  try {
    for (const t of forgeActive) {
      pushBranch(deps.gitFn, t.worktree, t.repo, args.branch, { forceWithLease: args.forceWithLease });
      pushed.push(t.repo);
    }

    for (const t of forgeActive) {
      const forge = deps.forgeFactory(perRepoForge(ws, t));
      // Idempotency: a re-run must not open a second PR for a branch that
      // already has one open against the same base. Reuse it as-is —
      // re-titling or re-bodying an existing PR is a decision, not a
      // default, and the one already open is the one reviewers watch.
      const existing = (await forge.prList({ state: 'open', head: args.branch, base: t.defaultBranch }))
        .find((p) => p.headRefName === args.branch && p.baseRefName === t.defaultBranch);
      const title = issueTitle ?? firstCommitSubject(deps.gitFn, t, args.branch);
      let body = readFileSync(args.bodyFiles.get(t.repo), 'utf8').replace(/\s*$/, '');
      if (issueRefs) body = `${body}\n\nCloses ${issueRefs.get(t.repo)}\n`;
      const pr = existing ?? await forge.prCreate({ title, body, head: args.branch, base: t.defaultBranch });
      prs.push({
        repo: t.repo, mode: 'forge', owner: t.owner, name: t.name,
        forge: t.forge, host: t.host,
        number: pr.number, id: pr.id, url: pr.url, isWorkspace: t.isWorkspace, commits: t.commits,
      });
    }
  } catch (err) {
    // A failure after the first push must not lose the run's state: the
    // pushes and PRs that landed go to --out so a re-run (or a --merge of
    // what exists) starts from reality. Before the first push nothing has
    // happened, and an earlier run's file stays untouched rather than
    // being clobbered with a no-op result.
    if (args.out && (pushed.length > 0 || prs.length > 0)) {
      writeOut(args.out, { prs, empty, pushed });
    }
    throw err;
  }
  const result = { prs, empty, pushed };
  if (args.out) writeOut(args.out, result);
  return result;
}

// Merge one local-mode entry in its repo's source clone — repos/{repo} for
// a project repo, the launcher itself for ".". The clone must be sitting
// clean on its default branch: merging anywhere else would strand the
// checkout or swallow uncommitted work. --ff-only because a task branch
// that diverged from the local default needs a rebase first — deciding how
// to combine is the user's, not this script's. A branch already contained
// in the default branch counts as merged, which is what makes a re-run
// after a partial failure safe.
function mergeLocalEntry(gitFn, rootDir, entry) {
  const repoDir = repoDirFor(rootDir, entry.repo);
  const base = entry.base || defaultBranchFor(rootDir, entry.repo, gitFn);
  const onBranch = gitOut(gitFn, repoDir, ['branch', '--show-current']);
  if (onBranch !== base) {
    throw new Error(`its source clone is on ${onBranch || 'a detached HEAD'}, not ${base} — check out ${base} and re-run --merge`);
  }
  if (String(gitCheck(gitFn, repoDir, ['status', '--porcelain']).stdout || '').trim() !== '') {
    throw new Error('its source clone has uncommitted changes — commit or stash them and re-run --merge');
  }
  if (gitCheck(gitFn, repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}`]).status !== 0) {
    throw new Error(`branch ${entry.branch} not found in its source clone — nothing to merge`);
  }
  if (gitCheck(gitFn, repoDir, ['merge-base', '--is-ancestor', entry.branch, base]).status === 0) {
    return { alreadyMerged: true };
  }
  const res = gitCheck(gitFn, repoDir, ['merge', '--ff-only', entry.branch]);
  if (res.status !== 0) {
    throw new Error(`${entry.branch} is not fast-forwardable onto ${base} — rebase the task branch onto ${base} and re-run --merge`);
  }
  return { alreadyMerged: false };
}

async function mergePrs(args, deps) {
  const rootDir = resolve(args.root);
  const ws = readWorkspace(rootDir);

  let parsed;
  try {
    parsed = JSON.parse(stripBom(readFileSync(args.prs, 'utf-8')));
  } catch (err) {
    throw new Error(`cannot read PRs file ${args.prs}: ${err.message}`);
  }
  // An empty or malformed file is a refusal, not a no-op: with nothing to
  // merge there is nothing that earns an issue close, and "Merged: " with
  // no URLs would tell the tracker a lie.
  if (!parsed || !Array.isArray(parsed.prs)) {
    throw new Error(`PRs file ${args.prs} is malformed — expected the JSON from a --create run ({ prs: [...] })`);
  }
  const prs = parsed.prs;
  if (prs.length === 0) {
    throw new Error(`PRs file ${args.prs} lists no PRs — nothing to merge and nothing to close; --merge refuses to close an issue on an empty merge`);
  }
  // Entries written before modes existed carry no `mode`; they are forge
  // PRs, the only kind --create used to emit. A local entry's repo becomes
  // a path under repos/, so the file cannot be allowed to name anything
  // but "." or a plain single segment.
  const modeOf = (p) => p?.mode ?? 'forge';
  const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
  for (const p of prs) {
    if (!p) throw new Error(`PRs file entry is missing owner/name/id: ${JSON.stringify(p)}`);
    if (p.repo !== WORKSPACE_REPO
      && (typeof p.repo !== 'string' || p.repo === '..' || !REPO_NAME_RE.test(p.repo))) {
      throw new Error(`PRs file entry has an invalid repo name: ${JSON.stringify(p.repo)} — expected "." or a plain repo name`);
    }
    if (modeOf(p) === 'local') {
      if (!p.branch) throw new Error(`PRs file entry is missing branch: ${JSON.stringify(p)}`);
    } else if (!p.owner || !p.name || !p.id) {
      throw new Error(`PRs file entry is missing owner/name/id: ${JSON.stringify(p)}`);
    }
  }
  if (prs.some((p) => modeOf(p) === 'forge')) assertForgeEnabled(ws);
  // Entries carry their repo's forge and host since GitLab support landed;
  // older files predate the fields and fall back to the workspace block —
  // the GitHub default those runs were built under.
  const forgeFor = (p) => deps.forgeFactory({
    ...(ws.workspace?.forge ?? {}),
    ...(p.forge ? { type: p.forge, host: p.host } : {}),
    repo: `${p.owner}/${p.name}`,
  });

  // State first, so a re-run knows what an earlier run already finished.
  // A PR the forge reports MERGED is done; anything else is offered to
  // prMerge, which reports its own failure if the PR cannot merge. If the
  // view itself fails, fall through to the merge attempt — that path
  // produces the honest error when something is genuinely wrong.
  const alreadyMerged = new Set();
  for (const p of prs) {
    if (modeOf(p) !== 'forge') continue;
    try {
      const view = await forgeFor(p).prView({ id: p.id });
      if (view?.state === 'MERGED') alreadyMerged.add(p.id);
    } catch { /* state unknown — the merge attempt below decides */ }
  }

  // Ordering rule: the project repos merge first — forge PRs and local
  // branches alike, in file order — and the workspace repo last, only when
  // every project merge succeeded: the workspace branch's promoted context
  // describes the project merges and must never land ahead of them.
  const merged = [];
  const failures = [];
  const workspaceEntry = prs.find((p) => p.repo === WORKSPACE_REPO) ?? null;
  const mergeOne = async (p) => {
    if (modeOf(p) === 'local') {
      await mergeLocalEntry(deps.gitFn, rootDir, p);
    } else if (!alreadyMerged.has(p.id)) {
      await forgeFor(p).prMerge({ id: p.id, strategy: 'squash', deleteBranch: true });
    }
    merged.push(p);
  };
  for (const p of prs.filter((x) => x !== workspaceEntry)) {
    try { await mergeOne(p); } catch (err) { failures.push(`${p.repo}: ${err.message}`); }
  }
  if (failures.length === 0 && workspaceEntry) {
    try { await mergeOne(workspaceEntry); } catch (err) { failures.push(`${workspaceEntry.repo}: ${err.message}`); }
  }
  if (failures.length > 0) {
    const open = prs.filter((p) => !merged.includes(p)).map((p) => `${p.repo}: ${p.url ?? p.branch}`);
    throw new Error(
      `merge stopped (${failures.join('; ')}). Still open: ${open.join(', ')}. The workspace repo is never merged ahead of the project repos — fix the failure and re-run --merge.`,
    );
  }

  // Every entry in the file is merged from here on. The launcher pull is a
  // convenience, not a gate: it happens only when the launcher sits on the
  // workspace default branch and "." itself was not merged locally — that
  // merge ran in the launcher, so it already has the work — a failure is a
  // reported flag rather than an error (the merges stand and the issue
  // still closes), and the user is told to pull by hand before teardown.
  const result = {
    merged: merged.map((p) => (modeOf(p) === 'local'
      ? { repo: p.repo, mode: 'local', branch: p.branch, base: p.base }
      : { repo: p.repo, mode: 'forge', number: p.number, url: p.url })),
    closed: null,
  };
  if (merged.some((p) => p.repo === WORKSPACE_REPO && modeOf(p) === 'local')) {
    result.pullSkipped = 'workspace merged locally';
  } else {
    const launcherBranch = gitOut(deps.gitFn, rootDir, ['branch', '--show-current']) || '(detached HEAD)';
    if (launcherBranch !== defaultBranchFor(rootDir, WORKSPACE_REPO, deps.gitFn)) {
      result.pullSkipped = `launcher on ${launcherBranch}`;
    } else if (mergeModeFor(rootDir, WORKSPACE_REPO, { gitFn: deps.gitFn }) === 'local') {
      // The workspace repo merges into the launcher itself — or was not part
      // of this task at all; either way no forge merge happened that a pull
      // could fetch.
      result.pullSkipped = 'workspace repo is local';
    } else if (gitCheck(deps.gitFn, rootDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).status !== 0) {
      result.pullSkipped = 'launcher has no upstream';
    } else {
      const pull = gitCheck(deps.gitFn, rootDir, ['pull', '--ff-only']);
      if (pull.status !== 0) result.pullFailed = true;
    }
  }

  // The close needs both halves: a work item to close, and a tracker to
  // close it on. A workspace without a tracker still merges everything —
  // it just reports the skipped close instead of pretending one happened.
  if (args.workItem) {
    if (!ws.workspace?.tracker) {
      result.closeSkipped = 'no tracker configured';
    } else {
      const tracker = deps.trackerFactory(ws.workspace.tracker);
      const parts = merged.map((p) => (modeOf(p) === 'local' ? `${p.repo} ${p.branch}->${p.base}` : p.url));
      await tracker.closeIssue(args.workItem, { comment: `Merged: ${parts.join(' ')}` });
      result.closed = args.workItem;
    }
  }
  return result;
}

const MODE_FLAGS = new Set(['--create', '--merge']);
const VALUE_FLAGS = new Set(['--root', '--branch', '--work-item', '--chat', '--prs', '--out']);

function parseArgs(argv) {
  const args = {
    root: '.', mode: null, branch: null, workItem: null, chat: null,
    repos: [], bodyFiles: new Map(), prs: null, out: null, forceWithLease: false,
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
    if (args.out) throw new Error('--out is only valid with --create');
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

export { run, parseArgs };
export { parseForgeRemote, mergeModeFor } from './merge-mode.mjs';
