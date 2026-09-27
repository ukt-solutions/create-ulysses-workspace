#!/usr/bin/env node
// Per-workspace migration from the session lifecycle to the task model
// (gh:147).
//
// Workspaces that predate the task model accumulate entries under
// work-sessions/ — some finished-but-never-completed, some abandoned,
// some still live. This script is the mechanical half of draining them:
//
//   --inventory   read-only evidence + a proposal (ACTIVE / ABANDONED /
//                 MERGEABLE / REMOVE_SHELL) per session
//   --backup      tag every ahead branch `drain/*` and push the tag, so
//                 nothing unique is lost before teardown
//   --teardown    re-check the safety preconditions, then delegate the
//                 actual teardown to cleanup-work-session.mjs (the ordered
//                 teardown lives there — this script never reimplements it)
//   --enable-task-model
//                 flip workspace.sessionModel to "task"
//
// HARD BOUNDARY: the process only ever touches the workspace it is run
// in. --root must resolve (real path) to a directory containing
// workspace.json; every path read or acted on must resolve inside it; a
// --session name must be a single path segment; and git is only ever run
// in the workspace repo at the root and in worktrees under the sessions
// directory (worktrees share refs with their repos, so tags, pushes and
// rev-lists issued from a worktree act on exactly those repos and no
// others). Remote contact (ls-remote, push) verifies and creates backups
// — it never deletes a remote branch or tag.
//
// Output contract: JSON on stdout. Inventory also prints a human-readable
// table to stderr. A precondition refusal prints {refused: true,
// reasons: [...]} and exits 1; any other error goes to stderr and exits 2.

import {
  readFileSync, writeFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSessionFields } from '../lib/session-frontmatter.mjs';
import { defaultBranchFor, slugForBranch, WORKSPACE_REPO } from './task-worktree.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const DAY_MS = 24 * 60 * 60 * 1000;
// ls-remote contacts real remotes; a hung one must degrade the answer to
// "unknown" rather than hanging the whole inventory.
const LS_REMOTE_TIMEOUT_MS = 15000;

// Session artifacts live at the top of the workspace worktree on the
// session branch (workspace-structure.md). They are process output, not
// content — a branch whose only diff is these files carries nothing
// worth merging.
const SESSION_ARTIFACT_PATTERNS = [
  /^session\.md$/,
  /^design-.*\.md$/,
  /^plan-.*\.md$/,
  /^goal-.*\.md$/,
  /^research-.*\.md$/,
  /^crossref-.*\.md$/,
];

function isSessionArtifact(file) {
  // "at the worktree top" — the path has no separator at all.
  if (file.includes('/')) return false;
  return SESSION_ARTIFACT_PATTERNS.some((re) => re.test(file));
}

// .native resolves Windows 8.3 short names; the plain fallback covers
// filesystems where the native binding is unavailable. Same contract as
// task-worktree.mjs.
function realPath(p) {
  try { return realpathSync.native(p); } catch { /* fall through */ }
  try { return realpathSync(p); } catch { /* fall through */ }
  return resolve(p);
}

// gitFn is injectable so tests can observe or fake git; the default is
// spawnSync itself, called as (command, args, options).
function run(gitFn, cwd, args, opts = {}) {
  const res = gitFn('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts });
  if (res.error) throw new Error(`git: ${res.error.message}`);
  return res;
}

function okLines(res) {
  return String(res.stdout || '').split(/\r?\n/).filter((l) => l.trim() !== '');
}

// A session name becomes a path segment under the sessions directory —
// one segment only, no separators, dot segments, or absolute paths.
// Unlike repo names there is no "." exception: a session is always a
// directory, never the root itself.
function isSessionSegment(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) return false;
  const segs = name.split(/[\\/]/);
  if (segs.length !== 1) return false;
  return !/^\.+$/.test(segs[0]);
}

// The root must be a workspace root — otherwise the script would be
// operating on (and writing into) an arbitrary directory, which is the
// one thing the hard boundary forbids.
function resolveRoot(root) {
  const rootDir = realPath(resolve(root));
  if (!existsSync(join(rootDir, 'workspace.json'))) {
    throw new Error(`no workspace.json at ${rootDir} — not a workspace root`);
  }
  return rootDir;
}

function insideRoot(rootDir, p) {
  const rp = realPath(p);
  return rp === rootDir || rp.startsWith(rootDir + sep);
}

function readConfig(rootDir) {
  try {
    return JSON.parse(readFileSync(join(rootDir, 'workspace.json'), 'utf-8'));
  } catch {
    return null;
  }
}

// The sessions directory is configurable, but a configuration pointing
// outside the root would violate the boundary — refuse it outright.
function sessionsDirOf(rootDir) {
  const dir = readConfig(rootDir)?.workspace?.workSessionsDir;
  const name = typeof dir === 'string' && dir !== '' ? dir : 'work-sessions';
  const path = resolve(rootDir, name);
  if (!insideRoot(rootDir, path)) {
    throw new Error(`workspace.workSessionsDir (${name}) resolves outside the workspace root`);
  }
  return path;
}

function listSessionNames(rootDir) {
  const dir = sessionsDirOf(rootDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
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

function headSha(gitFn, path) {
  try {
    const res = run(gitFn, path, ['rev-parse', 'HEAD']);
    return res.status === 0 ? String(res.stdout).trim() : null;
  } catch {
    return null;
  }
}

function countDirty(gitFn, path) {
  const res = run(gitFn, path, ['status', '--porcelain']);
  if (res.status !== 0) return 0;
  return okLines(res).length;
}

// The base the session branched from, as a ref: origin/{default} when
// the remote ref exists (the truth about the integration branch), else
// the local {default}.
function baseRef(gitFn, path, defaultBranch) {
  const hasOrigin = run(gitFn, path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultBranch}`]).status === 0;
  return hasOrigin ? `origin/${defaultBranch}` : defaultBranch;
}

// Commits not on the repo's default branch. origin/{default} is the
// truth when the remote ref exists; without one (a repo with no remote
// configured, or nothing fetched yet) {default}..HEAD is the only
// question git can still answer — a stale answer beats none, and the
// unbacked warning is the safety net for the difference.
function ownRange(gitFn, path, defaultBranch) {
  return `${baseRef(gitFn, path, defaultBranch)}..HEAD`;
}

function aheadCount(gitFn, path, range) {
  const res = run(gitFn, path, ['rev-list', '--count', range]);
  if (res.status !== 0) return 0;
  const n = parseInt(String(res.stdout).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// When this worktree last got session work of its own: the committer
// date of the newest commit not on the default branch. An ahead=0
// worktree's HEAD is just the base tip — its date describes the repo,
// not the session, and counting it would make every stale session look
// active whenever the default branch moves. Null = no session commits.
function lastOwnCommitIso(gitFn, path, range) {
  const res = run(gitFn, path, ['log', '-1', '--format=%cI', range]);
  if (res.status !== 0) return null;
  const s = String(res.stdout).trim();
  return s === '' ? null : s;
}

// Files changed vs the default branch minus session artifacts — the
// number that answers "is there real content on this branch?".
function countContentFiles(gitFn, path, defaultBranch) {
  const base = baseRef(gitFn, path, defaultBranch);
  const res = run(gitFn, path, ['diff', '--name-only', `${base}...HEAD`]);
  if (res.status !== 0) return 0;
  const files = okLines(res).filter((f) => !isSessionArtifact(f));
  return files.length;
}

function remotesOf(gitFn, path) {
  const res = run(gitFn, path, ['remote']);
  if (res.status !== 0) return [];
  return okLines(res);
}

// Does {branch} exist on {remote}, and at what commit? Local tracking
// refs prove nothing (they are stale the moment anything fetches), so
// the remote is asked directly. Timeouts and failures degrade to
// 'unknown' — an inventory must report, not crash.
function lsRemoteBranch(gitFn, cwd, remote, branch) {
  const res = gitFn('git', ['-C', cwd, 'ls-remote', '--heads', remote, branch], {
    encoding: 'utf8', timeout: LS_REMOTE_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) return { exists: 'unknown', sha: null };
  const line = okLines(res)[0];
  if (!line) return { exists: false, sha: null };
  const [sha] = line.trim().split(/\s+/);
  return { exists: true, sha };
}

// Does {tag} exist on {remote} at exactly {commit}? Deliberately no
// refspec pattern: a pattern filters out the peeled `^{}` line (the
// tag object's sha is not the commit's), and the peeled line is exactly
// what "at this commit" needs. An annotated tag answers via the peel; a
// lightweight tag's only line already is the commit.
function tagOnRemoteAt(gitFn, cwd, remote, tag, commit) {
  const res = gitFn('git', ['-C', cwd, 'ls-remote', '--tags', remote], {
    encoding: 'utf8', timeout: LS_REMOTE_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) return false;
  const peeledRef = `refs/tags/${tag}^{}`;
  const plainRef = `refs/tags/${tag}`;
  let plainSha = false;
  for (const line of okLines(res)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === peeledRef) return sha === commit;
    if (ref === plainRef) plainSha = sha;
  }
  return plainSha === commit;
}

// The local peeled SHA of an existing tag, or null when the tag is
// absent. Refnames cannot contain ^{ (check-ref-format forbids ^), so
// appending ^{} to interpolate the peel is safe.
function peeledTagSha(gitFn, cwd, tag) {
  const res = run(gitFn, cwd, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{}`]);
  return res.status === 0 ? String(res.stdout).trim() : null;
}

function repoLabel(wt) {
  return wt.kind === 'workspace' ? 'the workspace repo' : `repo "${wt.repo}"`;
}

function readTracker(wsDir) {
  const trackerPath = join(wsDir, 'session.md');
  if (!existsSync(trackerPath)) return null;
  try {
    const fields = readSessionFields(trackerPath);
    return {
      status: typeof fields.status === 'string' ? fields.status : null,
      workItem: typeof fields.workItem === 'string' ? fields.workItem : null,
      branch: typeof fields.branch === 'string' ? fields.branch : null,
      updated: fields.updated != null ? String(fields.updated) : null,
    };
  } catch {
    // An unparseable tracker is evidence about the tracker, not the
    // session; the worktrees below still carry the real state.
    return null;
  }
}

// One worktree of a session — the workspace worktree (repo ".") or one
// nested project worktree (repo = its directory name under repos/).
// A session's workspace branch and its code are different things, so
// each is reported on its own line.
function inspectWorktree(gitFn, rootDir, kind, repo, wtPath, trackerBranch) {
  const branch = currentBranch(gitFn, wtPath);
  const defaultBranch = defaultBranchFor(rootDir, repo, gitFn);
  const range = ownRange(gitFn, wtPath, defaultBranch);
  const info = {
    kind,
    repo,
    path: relative(rootDir, realPath(wtPath)),
    branch,
    dirty: countDirty(gitFn, wtPath),
    ahead: branch ? aheadCount(gitFn, wtPath, range) : 0,
    lastCommit: lastOwnCommitIso(gitFn, wtPath, range),
    remotes: {},
    backedBy: null,
  };
  if (kind === 'workspace') {
    info.trackerBranch = trackerBranch;
    info.branchDrift = Boolean(trackerBranch && branch && trackerBranch !== branch);
    info.contentFiles = countContentFiles(gitFn, wtPath, defaultBranch);
  }
  const head = headSha(gitFn, wtPath);
  if (branch) {
    for (const remote of remotesOf(gitFn, wtPath)) {
      const probe = lsRemoteBranch(gitFn, wtPath, remote, branch);
      info.remotes[remote] = probe.exists;
      // The branch tip matching on ANY remote means the ahead commits
      // are not machine-local-only — that is what "backed" means here.
      if (probe.exists === true && probe.sha && probe.sha === head) {
        info.backedBy = info.backedBy || remote;
      }
    }
  }
  return info;
}

// The worktrees of a session as they exist right now — nested project
// worktrees are discovered from the directory listing (the tracker's
// repos list can drift or be missing), each entry recognized as a
// worktree by its .git link so plain directories are skipped.
function collectWorktrees(gitFn, rootDir, folder) {
  const out = [];
  const wsDir = join(folder, 'workspace');
  if (existsSync(join(wsDir, '.git'))) {
    out.push(inspectWorktree(gitFn, rootDir, 'workspace', WORKSPACE_REPO, wsDir, readTracker(wsDir)?.branch ?? null));
  }
  const nested = join(wsDir, 'repos');
  if (existsSync(nested)) {
    for (const entry of readdirSync(nested, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const p = join(nested, entry.name);
      if (!existsSync(join(p, '.git'))) continue;
      out.push(inspectWorktree(gitFn, rootDir, 'project', entry.name, p, null));
    }
  }
  return out;
}

/**
 * Pure classifier: given a session's computed metrics, return its
 * proposal and the human-readable reasons for it. Active-ness is
 * lastActivity within N days, or any dirty worktree with lastActivity
 * within 2N days (a paused-but-touched session deserves a human look,
 * not an abandonment proposal). Everything else splits on whether real
 * content survives: content files or project commits mean MERGEABLE;
 * artifact-only and clean project worktrees mean ABANDONED. A session
 * that fits neither (e.g. uncommitted project changes on a stale
 * session) falls to MERGEABLE — real uncommitted work is content, and
 * the dirty warning carries the caution.
 */
function classify(session, activeDays, now = Date.now()) {
  const ws = session.worktrees.find((w) => w.kind === 'workspace') || null;
  const projects = session.worktrees.filter((w) => w.kind === 'project');
  const lastMs = session.lastActivity != null ? Date.parse(session.lastActivity) : NaN;
  const within = (days) => Number.isFinite(lastMs) && now - lastMs <= days * DAY_MS;
  const anyDirty = session.worktrees.some((w) => w.dirty > 0);

  if (within(activeDays)) {
    return { proposal: 'ACTIVE', reasons: [`last activity ${session.lastActivity} is within ${activeDays} days`] };
  }
  if (anyDirty && within(activeDays * 2)) {
    return {
      proposal: 'ACTIVE',
      reasons: [`dirty worktree(s) with last activity ${session.lastActivity} within ${activeDays * 2} days`],
    };
  }

  const content = ws ? ws.contentFiles : 0;
  const aheadProjects = projects.filter((p) => p.ahead > 0);
  const dirtyProjects = projects.filter((p) => p.dirty > 0);
  if (content === 0 && aheadProjects.length === 0 && dirtyProjects.length === 0) {
    return {
      proposal: 'ABANDONED',
      reasons: [
        `last activity ${session.lastActivity ?? 'unknown'} is older than ${activeDays} days`,
        ...(ws ? [`workspace branch carries only session artifacts (${ws.ahead} commit(s), no content files)`] : []),
        'no project worktree has commits ahead or uncommitted changes',
      ],
    };
  }
  const reasons = [];
  if (content > 0) reasons.push(`${content} content file(s) beyond session artifacts on the workspace branch`);
  for (const p of aheadProjects) reasons.push(`repo "${p.repo}" is ${p.ahead} commit(s) ahead of its default branch`);
  for (const p of dirtyProjects) reasons.push(`repo "${p.repo}" has ${p.dirty} uncommitted change(s)`);
  return { proposal: 'MERGEABLE', reasons };
}

function collectWarnings(worktrees, active) {
  const warnings = [];
  for (const wt of worktrees) {
    if (wt.kind === 'workspace' && wt.branchDrift) {
      warnings.push({
        kind: 'branch-drift',
        message: `tracker says branch ${wt.trackerBranch} but the workspace worktree is on ${wt.branch}`,
        branch: wt.branch,
        trackerBranch: wt.trackerBranch,
      });
    }
    if (!active && wt.dirty > 0) {
      warnings.push({
        kind: 'dirty',
        message: `${repoLabel(wt)} has ${wt.dirty} uncommitted change(s) on a session that is not active`,
        repo: wt.repo,
        files: wt.dirty,
      });
    }
    if (wt.ahead > 0 && !wt.backedBy) {
      warnings.push({
        kind: 'unbacked',
        unbacked: true,
        message: `${repoLabel(wt)}: ${wt.ahead} commit(s) on ${wt.branch} exist on no remote`,
        repo: wt.repo,
        branch: wt.branch,
        ahead: wt.ahead,
      });
    }
  }
  return warnings;
}

function inspectSession(gitFn, rootDir, sessionsDir, name, activeDays, now) {
  const folder = join(sessionsDir, name);
  const wsDir = join(folder, 'workspace');
  if (!existsSync(join(wsDir, '.git'))) {
    const reason = existsSync(wsDir)
      ? `workspace/ at ${relative(rootDir, wsDir)} is not a git worktree (empty shell)`
      : `no workspace worktree at ${relative(rootDir, folder)}${sep}workspace`;
    return { name, kind: 'broken', proposal: 'REMOVE_SHELL', reasons: [reason] };
  }

  const tracker = readTracker(wsDir);
  const worktrees = collectWorktrees(gitFn, rootDir, folder);

  // lastActivity: the newest fact we have — any worktree's HEAD date or
  // the tracker's updated field, whichever is later.
  let lastMs = NaN;
  let lastActivity = null;
  const consider = (value) => {
    if (value == null) return;
    const t = Date.parse(value);
    if (!Number.isFinite(t)) return;
    if (!Number.isFinite(lastMs) || t > lastMs) {
      lastMs = t;
      lastActivity = new Date(t).toISOString();
    }
  };
  for (const wt of worktrees) consider(wt.lastCommit);
  consider(tracker?.updated ?? null);

  const { proposal, reasons } = classify({ name, worktrees, lastActivity }, activeDays, now);
  return {
    name,
    kind: 'session',
    status: tracker?.status ?? null,
    workItem: tracker?.workItem ?? null,
    lastActivity,
    proposal,
    reasons,
    warnings: collectWarnings(worktrees, proposal === 'ACTIVE'),
    worktrees,
  };
}

/**
 * Read-only inventory of every session under the workspace's sessions
 * directory. The proposal each session gets is a proposal — the note in
 * the result says so, and the skill says so again to the operator.
 */
function inventory(root, { activeDays = 14, gitFn = spawnSync, now = Date.now() } = {}) {
  const rootDir = resolveRoot(root);
  const sessionsDir = sessionsDirOf(rootDir);
  const sessions = listSessionNames(rootDir)
    .map((name) => inspectSession(gitFn, rootDir, sessionsDir, name, activeDays, now));
  return {
    root: rootDir,
    activeDays,
    note: 'Proposals are proposals — inventory evidence only; the operator decides each session.',
    sessions,
  };
}

/**
 * Back up every ahead branch of a session: an annotated `drain/*` tag at
 * the branch tip, pushed to a remote and verified there, so teardown can
 * never be the last copy of unique commits. Idempotent — an existing tag
 * at the same commit is fine; at a different commit (the branch moved)
 * the operator must decide, so it refuses.
 */
function backupSession(root, { session, gitFn = spawnSync } = {}) {
  const rootDir = resolveRoot(root);
  if (!isSessionSegment(session)) {
    throw new Error(`session name must be a single path segment, got: ${session}`);
  }
  const folder = join(sessionsDirOf(rootDir), session);
  if (!existsSync(folder)) {
    return { refused: true, reasons: [`no session named "${session}" under ${relative(rootDir, sessionsDirOf(rootDir))}`] };
  }

  const reasons = [];
  const branches = [];
  for (const wt of collectWorktrees(gitFn, rootDir, folder)) {
    if (!wt.branch || wt.ahead <= 0) continue; // nothing unique to lose
    const tag = `drain/${slugForBranch(wt.branch)}`;
    const tip = headSha(gitFn, join(rootDir, wt.path));
    if (!tip) {
      reasons.push(`${repoLabel(wt)}: cannot resolve the tip of ${wt.branch} — decide manually`);
      continue;
    }
    const existing = peeledTagSha(gitFn, join(rootDir, wt.path), tag);
    if (existing && existing !== tip) {
      reasons.push(
        `${repoLabel(wt)}: tag ${tag} already points at ${existing.slice(0, 10)}…, not the current tip of ${wt.branch} (${tip.slice(0, 10)}…); the branch moved — decide manually`,
      );
      continue;
    }
    const remotes = remotesOf(gitFn, join(rootDir, wt.path));
    if (remotes.length === 0) {
      reasons.push(`${repoLabel(wt)} has no remote to push the backup tag ${tag} to — decide manually where to back up ${wt.branch}`);
      continue;
    }
    const target = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!existing) {
      const created = run(gitFn, join(rootDir, wt.path), [
        'tag', '-a', tag, '-m', `backup before draining session ${session}`, tip,
      ]);
      if (created.status !== 0) {
        reasons.push(`${repoLabel(wt)}: git tag ${tag} failed: ${String(created.stderr || '').trim()}`);
        continue;
      }
    }
    const pushed = run(gitFn, join(rootDir, wt.path), ['push', target, `refs/tags/${tag}`]);
    if (pushed.status !== 0) {
      reasons.push(`${repoLabel(wt)}: pushing ${tag} to ${target} failed: ${String(pushed.stderr || '').trim()}`);
      continue;
    }
    const verified = tagOnRemoteAt(gitFn, join(rootDir, wt.path), target, tag, tip);
    if (!verified) {
      reasons.push(`${repoLabel(wt)}: tag ${tag} not found on ${target} after pushing — treat ${wt.branch} as unbacked`);
      continue;
    }
    branches.push({ repo: wt.repo, branch: wt.branch, tag, commit: tip, pushed: true, verified: true });
  }
  if (reasons.length > 0) return { refused: true, reasons };
  return { session, branches };
}

// Only empty directory shells are removed automatically. A file anywhere
// under the folder is content the script cannot judge — refuse and let
// the operator look first. Symlinks count as files: never follow one.
function firstFileUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() || entry.isSymbolicLink()) return p;
    if (entry.isDirectory()) {
      const hit = firstFileUnder(p);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Tear a session down. Preconditions are re-checked now — never trusted
 * from an earlier inventory, which is already stale. The actual teardown
 * is delegated to cleanup-work-session.mjs (the ordered teardown with
 * its own post-verification lives there); a broken shell has no
 * worktrees, so it is just an empty-directory removal. Remote branches
 * and tags are never deleted.
 */
function teardownSession(root, { session, discardUncommitted = false, gitFn = spawnSync } = {}) {
  const rootDir = resolveRoot(root);
  if (!isSessionSegment(session)) {
    throw new Error(`session name must be a single path segment, got: ${session}`);
  }
  const sessionsDir = sessionsDirOf(rootDir);
  const folder = join(sessionsDir, session);
  if (!existsSync(folder)) {
    return { refused: true, reasons: [`no session named "${session}" under ${relative(rootDir, sessionsDir)}`] };
  }

  const wsDir = join(folder, 'workspace');
  if (!existsSync(join(wsDir, '.git'))) {
    const stray = firstFileUnder(folder);
    if (stray) {
      return {
        refused: true,
        reasons: [`session folder ${relative(rootDir, folder)} contains ${relative(rootDir, stray)} — only empty directory shells are removed automatically`],
      };
    }
    rmSync(folder, { recursive: true, force: true });
    return { session, kind: 'broken', removed: true };
  }

  const reasons = [];
  for (const wt of collectWorktrees(gitFn, rootDir, folder)) {
    if (wt.branch && wt.ahead > 0) {
      const tag = `drain/${slugForBranch(wt.branch)}`;
      const tip = headSha(gitFn, join(rootDir, wt.path));
      const verified = tip && remotesOf(gitFn, join(rootDir, wt.path))
        .some((remote) => tagOnRemoteAt(gitFn, join(rootDir, wt.path), remote, tag, tip));
      if (!verified) {
        reasons.push(`${repoLabel(wt)}: branch ${wt.branch} is ${wt.ahead} commit(s) ahead with no verified ${tag} backup tag on any remote — run --backup --session ${session} first`);
      }
    }
    if (wt.dirty > 0 && !discardUncommitted) {
      reasons.push(`${repoLabel(wt)}: ${wt.dirty} uncommitted change(s) in ${wt.path} — commit them, or pass --discard-uncommitted to drop them`);
    }
  }
  if (reasons.length > 0) return { refused: true, reasons };

  const script = join(rootDir, '.claude', 'scripts', 'cleanup-work-session.mjs');
  if (!existsSync(script)) {
    throw new Error(`cleanup script missing at ${relative(rootDir, script)} — cannot tear down`);
  }
  const res = spawnSync(process.execPath, [script, '--session-name', session], {
    cwd: rootDir, encoding: 'utf8',
  });
  if (res.error) throw new Error(`spawning cleanup-work-session.mjs failed: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`cleanup-work-session.mjs exited ${res.status}: ${String(res.stderr || '').trim()}`);
  }
  let cleanup = null;
  try {
    cleanup = JSON.parse(String(res.stdout).trim().split('\n').filter(Boolean).pop());
  } catch { /* report the removal below; the JSON is best-effort detail */ }
  return { session, kind: 'session', removed: !existsSync(folder), cleanup };
}

/**
 * Switch the workspace to the task model. Remaining sessions are fine —
 * they keep resuming and completing under the session lifecycle; they
 * are reported so the operator knows what is still around.
 */
function enableTaskModel(root) {
  const rootDir = resolveRoot(root);
  const cfgPath = join(rootDir, 'workspace.json');
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch (err) {
    throw new Error(`workspace.json unreadable: ${err.message}`);
  }
  // Spread-then-set keeps an existing sessionModel in place and every
  // other key untouched; 2-space JSON with a trailing newline is the
  // file's house format.
  cfg.workspace = { ...(cfg.workspace || {}), sessionModel: 'task' };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return { sessionModel: 'task', remainingSessions: listSessionNames(rootDir) };
}

// Human-readable inventory rendering for stderr — the operator's table;
// the JSON on stdout is the machine copy.
function renderTable(result) {
  const lines = [`${result.sessions.length} session(s); proposals are proposals — the operator decides each one.`];
  for (const s of result.sessions) {
    lines.push('');
    lines.push(`${s.name}  ${s.kind === 'broken' ? 'broken shell' : s.proposal}` +
      (s.kind === 'broken' ? '' : `  (status ${s.status ?? '—'}, last activity ${s.lastActivity ?? '—'}, work item ${s.workItem ?? '—'})`));
    for (const w of s.worktrees || []) {
      const remotes = Object.entries(w.remotes)
        .map(([r, v]) => `${r}:${v === true ? 'yes' : v === false ? 'no' : '?'}`)
        .join(' ') || 'no remotes';
      const extra = w.kind === 'workspace' ? `  content:${w.contentFiles}` : '';
      lines.push(`    ${w.kind === 'workspace' ? '(workspace)' : w.repo}  ${w.branch ?? 'detached'}  ahead:${w.ahead} dirty:${w.dirty}${extra}  [${remotes}]`);
    }
    for (const r of s.reasons || []) lines.push(`    · ${r}`);
    for (const w of s.warnings || []) lines.push(`    ! ${w.message}`);
  }
  return `${lines.join('\n')}\n`;
}

const MODE_FLAGS = new Set(['--inventory', '--backup', '--teardown', '--enable-task-model']);
const VALUE_FLAGS = new Map([
  ['--root', 'root'],
  ['--session', 'session'],
  ['--active-days', 'activeDays'],
]);

function parseArgs(argv) {
  const args = { root: '.', mode: null, session: null, activeDays: null, discardUncommitted: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (MODE_FLAGS.has(a)) {
      if (args.mode) throw new Error(`only one mode flag may be given (already have --${args.mode})`);
      args.mode = a.slice(2);
      continue;
    }
    if (a === '--discard-uncommitted') { args.discardUncommitted = true; continue; }
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
  if (!args.mode) throw new Error('one of --inventory, --backup, --teardown, --enable-task-model is required');
  if ((args.mode === 'backup' || args.mode === 'teardown') && !args.session) {
    throw new Error(`--${args.mode} requires --session`);
  }
  if (args.session != null && args.mode !== 'backup' && args.mode !== 'teardown') {
    throw new Error('--session is only valid with --backup or --teardown');
  }
  if (args.session != null && !isSessionSegment(args.session)) {
    throw new Error(`--session must be a single path segment, got: ${args.session}`);
  }
  if (args.activeDays != null) {
    if (args.mode !== 'inventory') throw new Error('--active-days is only valid with --inventory');
    const n = Number(args.activeDays);
    if (!Number.isInteger(n) || n <= 0) throw new Error('--active-days must be a positive integer');
    args.activeDays = n;
  }
  if (args.discardUncommitted && args.mode !== 'teardown') {
    throw new Error('--discard-uncommitted is only valid with --teardown');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = resolveRoot(args.root);
  let out;
  let code = 0;
  if (args.mode === 'inventory') {
    out = inventory(rootDir, { activeDays: args.activeDays ?? 14 });
    process.stderr.write(renderTable(out));
  } else if (args.mode === 'backup') {
    out = backupSession(rootDir, { session: args.session });
  } else if (args.mode === 'teardown') {
    out = teardownSession(rootDir, { session: args.session, discardUncommitted: args.discardUncommitted });
  } else {
    out = enableTaskModel(rootDir);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (out && out.refused) {
    process.stderr.write(`migrate-sessions: refused — ${out.reasons.join('; ')}\n`);
    code = 1;
  }
  return code;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`migrate-sessions: ${err.message}\n`);
    process.exit(2);
  }
}

export { inventory, backupSession, teardownSession, enableTaskModel, classify, parseArgs };
