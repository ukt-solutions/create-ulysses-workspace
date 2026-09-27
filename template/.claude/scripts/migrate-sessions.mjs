#!/usr/bin/env node
// Per-workspace migration from the session lifecycle to the task model
// (gh:147).
//
// Workspaces that predate the task model accumulate entries under
// work-sessions/ — some finished-but-never-completed, some abandoned,
// some still live. This script is the mechanical half of draining them:
//
//   --inventory   read-only evidence + a proposal (ACTIVE / ABANDONED /
//                 MERGEABLE / UNKNOWN / REMOVE_SHELL / LEAVE) per session
//   --backup      tag each tip the session holds that no remote branch or
//                 tag already points at, push the tag, verify it
//                 (--dry-run reports the plan with no side effects)
//   --archive     move the session out of the active lifecycle — the whole
//                 folder is renamed into {sessions}/.archived/ and git's
//                 worktree links are repaired to follow it
//   --enable-task-model
//                 flip workspace.sessionModel to "task" (accepts a task
//                 worktree root — the one mode allowed off the launcher)
//
// NOTHING HERE DELETES. Draining a session means taking it out of the
// active lifecycle, not destroying it. An earlier design tore sessions
// down behind a "prove it is safe to delete" check; four independent
// reviews each found a new place git keeps state that the check missed
// (tracker drift, ignored files, stale tracking refs, submodules,
// per-worktree refs, assume-unchanged edits, embedded repositories). A
// rename keeps all of it by construction: every file, every ref, every
// index flag travels with the folder, and `git worktree repair` keeps the
// repositories pointing at it. Deleting an archive is a separate, manual
// decision the operator makes with their own eyes on it.
//
// HARD BOUNDARY: the process only ever touches the workspace it is run
// in. --root must resolve (real path) to a directory containing
// workspace.json; every path read or acted on must resolve inside it; a
// --session name must be a single path segment; and git is only ever run
// in the workspace repo at the root, the repos under root/repos/, and
// worktrees under the sessions directory. A session holding a worktree
// of any other repository is refused, never touched. Remote contact
// (ls-remote, push) verifies and creates backup tags — it never deletes a
// remote branch or tag.
//
// Output contract: JSON on stdout. Inventory also prints a human-readable
// table to stderr. A precondition refusal prints {refused: true,
// reasons: [...]} and exits 1; any other error goes to stderr and exits 2.

import {
  readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, statSync, mkdirSync, renameSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, resolve, relative, dirname, sep, isAbsolute } from 'node:path';
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
// Remote contact must never hang or prompt an operator who is not there:
// prompts are disabled and both commands get hard timeouts. A timed-out
// ls-remote degrades the inventory answer to "unknown" and makes backup
// refuse rather than guess.
const LS_REMOTE_TIMEOUT_MS = 15000;
const PUSH_TIMEOUT_MS = 60000;

function netOpts(timeoutMs) {
  return { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
}

// Session artifacts live at the top of the workspace worktree on the
// session branch (workspace-structure.md). They are process output, not
// content — a branch whose only diff is these files carries nothing
// worth merging, and a dirty artifact is not dirty content.
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

// A project repo name: one path segment under repos/. This is the guard
// that keeps a crafted tracker (repos: ['../../elsewhere']) from pointing
// any git command at a repo outside the workspace.
function isRepoSegment(name) {
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

function insideDir(dir, p) {
  const rp = realPath(p);
  return rp === realPath(dir) || rp.startsWith(realPath(dir) + sep);
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

// Session entries with their nature: a symlinked entry is foreign — it
// may point anywhere, so it is reported and never followed (N3).
function listSessionEntries(rootDir) {
  const dir = sessionsDirOf(rootDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      // Dot entries are the script's own (.archived/) or tooling noise —
      // never sessions.
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, foreign: e.isSymbolicLink() }))
      .filter((e) => e.foreign || lstatSync(join(dir, e.name)).isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function listSessionNames(rootDir) {
  return listSessionEntries(rootDir).filter((e) => !e.foreign).map((e) => e.name);
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

// Porcelain v1 -z records: "XY <path>", NUL-separated, with the rename
// source in a second NUL field. Ignored entries only appear when
// --ignored=matching is requested. Null return = git failed, which every
// caller treats as fail-closed.
function statusRecords(gitFn, path, extraArgs = []) {
  const res = run(gitFn, path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...extraArgs]);
  if (res.status !== 0) return null;
  const parts = String(res.stdout || '').split('\0');
  const records = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p === '') continue;
    const xy = p.slice(0, 2);
    const entryPath = p.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // the next NUL field is the rename source
    records.push({ xy, path: entryPath });
  }
  return records;
}

// The base the session branched from, as a ref: origin/{default} when
// the remote ref exists (the truth about the integration branch), else
// the local {default}.
function baseRef(gitFn, path, defaultBranch) {
  const hasOrigin = run(gitFn, path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultBranch}`]).status === 0;
  return hasOrigin ? `origin/${defaultBranch}` : defaultBranch;
}

function ownRange(gitFn, path, defaultBranch) {
  return `${baseRef(gitFn, path, defaultBranch)}..HEAD`;
}

// Commits not on the repo's default branch, or null when the question
// cannot be answered (e.g. the configured default branch does not exist
// in this repo — B3). null is "unknown", never "zero": the unbacked and
// classification logic treats it with suspicion.
function aheadCount(gitFn, path, range) {
  const res = run(gitFn, path, ['rev-list', '--count', range]);
  if (res.status !== 0) return null;
  const n = parseInt(String(res.stdout).trim(), 10);
  return Number.isFinite(n) ? n : null;
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
// 'unknown' — an inventory must report, not crash, and never hang.
function lsRemoteBranch(gitFn, cwd, remote, branch) {
  const res = gitFn('git', ['-C', cwd, 'ls-remote', '--heads', remote, branch], netOpts(LS_REMOTE_TIMEOUT_MS));
  if (res.error || res.status !== 0) return { exists: 'unknown', sha: null };
  const line = okLines(res)[0];
  if (!line) return { exists: false, sha: null };
  const [sha] = line.trim().split(/\s+/);
  return { exists: true, sha };
}

// === S1: remote state per remote ===
//
// For each remote holding the branch, record how the local tip relates:
// same / local-ahead / local-behind / diverged (with counts) when the
// remote commit is known locally, not-fetched when it is not. This is
// what tells the operator "finishing needs a force-push decision" BEFORE
// they choose Finish, rather than after /complete-work's push bounces.
function remoteStatesFor(gitFn, wtPath, branch, head) {
  const out = {};
  if (!branch) return out;
  for (const remote of remotesOf(gitFn, wtPath)) {
    const probe = lsRemoteBranch(gitFn, wtPath, remote, branch);
    if (probe.exists === 'unknown') {
      out[remote] = { exists: false, sha: null, state: 'unknown' };
      continue;
    }
    if (!probe.exists) {
      out[remote] = { exists: false, sha: null, state: 'none' };
      continue;
    }
    const { sha } = probe;
    if (sha === head) {
      out[remote] = { exists: true, sha, state: 'same' };
      continue;
    }
    const known = run(gitFn, wtPath, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;
    if (!known) {
      out[remote] = { exists: true, sha, state: 'not-fetched' };
      continue;
    }
    const lr = run(gitFn, wtPath, ['rev-list', '--left-right', '--count', `${sha}...HEAD`]);
    if (lr.status !== 0) {
      out[remote] = { exists: true, sha, state: 'unknown' };
      continue;
    }
    const counts = String(lr.stdout).trim().split(/\s+/).map(Number);
    const remoteOnly = counts[0]; // left side: commits only the remote has
    const localOnly = counts[1]; // right side: commits only HEAD has
    if (remoteOnly === 0 && localOnly === 0) out[remote] = { exists: true, sha, state: 'same' };
    else if (localOnly > 0 && remoteOnly === 0) out[remote] = { exists: true, sha, state: 'local-ahead', ahead: localOnly };
    else if (localOnly === 0 && remoteOnly > 0) out[remote] = { exists: true, sha, state: 'local-behind', behind: remoteOnly };
    else out[remote] = { exists: true, sha, state: 'diverged', ahead: localOnly, behind: remoteOnly };
  }
  return out;
}

function describeRemote(name, r) {
  switch (r.state) {
    case 'same': return `${name}:same`;
    case 'local-ahead': return `${name}:ahead +${r.ahead}`;
    case 'local-behind': return `${name}:behind -${r.behind}`;
    case 'diverged': return `${name}:diverged +${r.ahead}/-${r.behind}`;
    default: return `${name}:${r.state}`;
  }
}

// The tip is machine-safe on a remote when the remote's copy leaves
// nothing local-only (same, or local purely behind). Any other state —
// or no remote holding the branch at all — leaves local-only commits.
function backedByRemote(remotes) {
  for (const [name, r] of Object.entries(remotes)) {
    if (r.exists && (r.state === 'same' || r.state === 'local-behind')) return name;
  }
  return null;
}

// The unbacked message names the repo (two worktrees on the same branch
// would otherwise print identical lines) and counts the commits that are
// neither on the primary holding remote nor on the default branch —
// `rev-list --count HEAD ^<remoteSha> ^<base>` when the base resolves.
function unbackedMessage(gitFn, rootDir, wt) {
  const parts = Object.entries(wt.remotes).map(([name, r]) => describeRemote(name, r)).join(', ');
  const diverged = Object.values(wt.remotes).some((r) => r.state === 'diverged');
  const holderEntry = Object.entries(wt.remotes).find(([, r]) => r.exists) ?? Object.entries(wt.remotes)[0];
  let count = null;
  if (wt.base) {
    const abs = join(rootDir, wt.path);
    if (holderEntry && holderEntry[1].sha) {
      const res = run(gitFn, abs, ['rev-list', '--count', 'HEAD', `^${holderEntry[1].sha}`, `^${wt.base}`]);
      if (res.status === 0) count = Number(String(res.stdout).trim());
    }
    if (count == null || !Number.isFinite(count)) {
      const res = run(gitFn, abs, ['rev-list', '--count', `${wt.base}..HEAD`]);
      count = res.status === 0 ? Number(String(res.stdout).trim()) : null;
    }
  }
  const label = repoLabel(wt);
  const head = count != null && Number.isFinite(count)
    ? `${label}: ${count} commit(s) on ${wt.branch} are on no remote and not on ${wt.base} (${parts})`
    : `${label}: commit(s) on ${wt.branch} are on no remote (${parts})`;
  // A diverged remote means a rebase rewrote history that was already
  // pushed: a plain push will be rejected, and deciding to force is the
  // operator's, never the script's.
  return diverged ? `${head} — diverged from a remote; finishing needs a force-push decision` : head;
}

// === S2(c): activity signals beyond commits ===

// Newest HEAD-reflog timestamp for a worktree (unix seconds), read from
// the reflog ENTRY's own time. `--date=unix --format=%gd` renders the
// selector as HEAD@{<unix-ts>} — the entry timestamp, not %ct (which is
// the referenced commit's date and reads "old" for a fresh worktree
// checked out on an old branch). Absence is normal and tolerated.
function reflogTs(gitFn, wtPath) {
  try {
    const res = gitFn('git', ['-C', wtPath, 'log', '-g', '-1', '--date=unix', '--format=%gd'], { encoding: 'utf8' });
    if (!res || res.status !== 0) return null;
    const m = String(res.stdout).trim().match(/@\{(\d+)\}$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Newest mtime among content (non-artifact) dirty paths — a session with
// no commits and no reflog can still show fresh uncommitted work.
// Artifact paths are excluded: an uncommitted session.md edit is bookkeeping,
// not work, and would otherwise make UNKNOWN unreachable.
function dirtyContentMtimeMs(gitFn, wtPath, kind) {
  const records = statusRecords(gitFn, wtPath);
  if (!records) return null;
  let newest = null;
  for (const r of records) {
    if (r.xy === '!!') continue; // statusRecords without --ignored never yields these; guard anyway
    if (kind === 'workspace' && isSessionArtifact(r.path)) continue;
    try {
      const m = statSync(join(wtPath, r.path)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch { /* deleted/renamed away between status and stat — skip */ }
  }
  return newest;
}

// === Session shape ===

function readTracker(wsDir) {
  const trackerPath = join(wsDir, 'session.md');
  if (!existsSync(trackerPath)) return null;
  try {
    const fields = readSessionFields(trackerPath);
    // normalizeRepos parity with cleanup-work-session.mjs: a scalar or
    // null repos field must never iterate as characters.
    const rawRepos = fields.repos;
    const repos = Array.isArray(rawRepos) ? rawRepos.map(String)
      : rawRepos == null || rawRepos === '' ? [] : [String(rawRepos)];
    return {
      status: typeof fields.status === 'string' ? fields.status : null,
      workItem: typeof fields.workItem === 'string' ? fields.workItem : null,
      branch: typeof fields.branch === 'string' ? fields.branch : null,
      updated: fields.updated != null ? String(fields.updated) : null,
      repos,
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
function inspectWorktree(gitFn, rootDir, kind, repo, wtPath) {
  const branch = currentBranch(gitFn, wtPath);
  const defaultBranch = defaultBranchFor(rootDir, repo, gitFn);
  const range = ownRange(gitFn, wtPath, defaultBranch);
  const base = range.slice(0, -('..HEAD'.length)); // the surviving-ref side of the range
  const head = headSha(gitFn, wtPath);
  const dirtyRecords = statusRecords(gitFn, wtPath) || [];
  const info = {
    kind,
    repo,
    path: relative(rootDir, realPath(wtPath)),
    branch,
    dirty: dirtyRecords.length,
    ahead: aheadCount(gitFn, wtPath, range),
    lastOwnCommit: lastOwnCommitIso(gitFn, wtPath, range),
    base,
    defaultBranch,
    reflogAt: reflogTs(gitFn, wtPath),
    remotes: {},
    backedBy: null,
  };
  if (kind === 'workspace') {
    info.trackerBranch = null; // filled by the caller when the tracker is read
    info.contentFiles = countContentFiles(gitFn, wtPath, defaultBranch);
    info.dirtyContent = dirtyRecords.filter((r) => !isSessionArtifact(r.path)).length;
  }
  info.remotes = remoteStatesFor(gitFn, wtPath, branch, head);
  info.backedBy = backedByRemote(info.remotes);
  return info;
}

// The session's worktrees as they exist right now — nested project
// worktrees discovered from the directory listing (the tracker's repos
// list can drift or be missing), each entry recognized as a worktree by
// its .git link so plain directories are skipped, symlinked entries
// surfaced as foreign rather than followed.
function collectSessionWorktrees(gitFn, rootDir, folder) {
  const out = [];
  const wsDir = join(folder, 'workspace');
  if (existsSync(join(wsDir, '.git'))) {
    out.push({ kind: 'workspace', repo: WORKSPACE_REPO, path: wsDir });
  }
  const nested = join(wsDir, 'repos');
  if (existsSync(nested)) {
    for (const entry of readdirSync(nested, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const p = join(nested, entry.name);
      if (entry.isSymbolicLink()) {
        out.push({ kind: 'foreign', repo: entry.name, path: p });
        continue;
      }
      if (!existsSync(join(p, '.git'))) continue;
      out.push({ kind: 'project', repo: entry.name, path: p });
    }
  }
  return out;
}

/**
 * Pure classifier: given a session's computed metrics, return its
 * proposal and the human-readable reasons for it. No activity signal at
 * all → UNKNOWN (never ABANDONED — absence of evidence is not
 * abandonment). Active-ness is lastActivity within N days, or any dirty
 * worktree with lastActivity within 2N days. Everything else splits on
 * whether real content survives — committed content files, uncommitted
 * content paths, or project commits mean MERGEABLE; artifact-only,
 * clean, and quiet means ABANDONED. A session that fits neither (e.g.
 * uncommitted project changes on a stale session) falls to MERGEABLE —
 * real uncommitted work is content, and the dirty warning carries the
 * caution.
 */
function classify(session, activeDays, now = Date.now()) {
  const ws = session.worktrees.find((w) => w.kind === 'workspace') || null;
  const projects = session.worktrees.filter((w) => w.kind === 'project');
  const lastMs = session.lastActivity != null ? Date.parse(session.lastActivity) : NaN;
  const within = (days) => Number.isFinite(lastMs) && now - lastMs <= days * DAY_MS;
  const anyDirty = session.worktrees.some((w) => w.dirty > 0);

  if (session.lastActivity == null) {
    return {
      proposal: 'UNKNOWN',
      reasons: ['no activity signal — no session commits, no reflog entries, no content-dirty files, no tracker updated date'],
    };
  }
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
  const dirtyContent = ws ? ws.dirtyContent : 0;
  const aheadProjects = projects.filter((p) => p.ahead > 0);
  const dirtyProjects = projects.filter((p) => p.dirty > 0);
  // An unresolvable default branch means "no content" is UNPROVEN, not
  // established — never ABANDONED on the back of an unknown count.
  const unknownBase = session.worktrees.some((w) => w.ahead == null);
  if (unknownBase) {
    return {
      proposal: 'MERGEABLE',
      reasons: [
        `last activity ${session.lastActivity} is older than ${activeDays} days`,
        'commits-ahead could not be verified (a default branch does not resolve) — content is unknown, so abandonment is not provable',
      ],
    };
  }
  if (content === 0 && dirtyContent === 0 && aheadProjects.length === 0 && dirtyProjects.length === 0) {
    return {
      proposal: 'ABANDONED',
      reasons: [
        `last activity ${session.lastActivity} is older than ${activeDays} days`,
        ...(ws ? [`workspace branch carries only session artifacts (${ws.ahead ?? '?'} commit(s), no content files, no uncommitted content)`] : []),
        'no project worktree has commits ahead or uncommitted changes',
      ],
    };
  }
  const reasons = [];
  if (content > 0) reasons.push(`${content} content file(s) beyond session artifacts on the workspace branch`);
  if (dirtyContent > 0) reasons.push(`${dirtyContent} uncommitted content path(s) in the workspace worktree`);
  for (const p of aheadProjects) reasons.push(`repo "${p.repo}" is ${p.ahead} commit(s) ahead of its default branch`);
  for (const p of dirtyProjects) reasons.push(`repo "${p.repo}" has ${p.dirty} uncommitted change(s)`);
  return { proposal: 'MERGEABLE', reasons };
}

function collectWarnings(gitFn, rootDir, worktrees, active, trackerBranch) {
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
        message: `${repoLabel({ kind: wt.kind, repo: wt.repo })} has ${wt.dirty} uncommitted change(s) on a session that is not active`,
        repo: wt.repo,
        files: wt.dirty,
      });
    }
    if (wt.ahead > 0 && !wt.backedBy) {
      warnings.push({
        kind: 'unbacked',
        unbacked: true,
        message: unbackedMessage(gitFn, rootDir, wt),
        repo: wt.repo,
        branch: wt.branch,
        ahead: wt.ahead,
      });
    }
    if (wt.ahead == null) {
      warnings.push({
        kind: 'unknown-base',
        message: `${repoLabel({ kind: wt.kind, repo: wt.repo })}: commits-ahead could not be counted (default branch "${wt.defaultBranch}" does not resolve here) — treat every count as unknown and the content as unverifiable`,
        repo: wt.repo,
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
  const rawWorktrees = collectSessionWorktrees(gitFn, rootDir, folder);
  const worktrees = rawWorktrees
    .filter((w) => w.kind !== 'foreign')
    .map((w) => inspectWorktree(gitFn, rootDir, w.kind, w.repo, w.path));
  const wsWt = worktrees.find((w) => w.kind === 'workspace');
  if (wsWt && tracker) {
    wsWt.trackerBranch = tracker.branch;
    wsWt.branchDrift = Boolean(tracker.branch && wsWt.branch && tracker.branch !== wsWt.branch);
  }

  // lastActivity: the newest fact we have — own commits, reflog entries,
  // content-dirty file mtimes, or the tracker's updated field.
  let lastMs = NaN;
  let lastActivity = null;
  const consider = (value) => {
    if (value == null) return;
    const t = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(t)) return;
    if (!Number.isFinite(lastMs) || t > lastMs) {
      lastMs = t;
      lastActivity = new Date(t).toISOString();
    }
  };
  for (const wt of worktrees) {
    consider(wt.lastOwnCommit);
    consider(wt.reflogAt != null ? wt.reflogAt * 1000 : null);
    consider(dirtyContentMtimeMs(gitFn, join(rootDir, wt.path), wt.kind));
  }
  consider(tracker?.updated ?? null);

  const { proposal, reasons } = classify({ name, worktrees, lastActivity }, activeDays, now);
  const warnings = collectWarnings(gitFn, rootDir, worktrees, proposal === 'ACTIVE', tracker?.branch ?? null);
  return {
    name,
    kind: 'session',
    status: tracker?.status ?? null,
    workItem: tracker?.workItem ?? null,
    lastActivity,
    proposal,
    reasons,
    warnings,
    worktrees,
  };
}

/**
 * Read-only inventory of every session under the workspace's sessions
 * directory. The proposal each session gets is a proposal — the note in
 * the result says so, and the skill says so again to the operator.
 * Symlinked entries are reported as foreign (LEAVE) and never followed.
 */
function inventory(root, { activeDays = 14, gitFn = spawnSync, now = Date.now() } = {}) {
  const rootDir = resolveRoot(root);
  const sessionsDir = sessionsDirOf(rootDir);
  const sessions = listSessionEntries(rootDir).map((entry) => (
    entry.foreign
      ? {
        name: entry.name,
        kind: 'foreign',
        proposal: 'LEAVE',
        reasons: ['entry is a symlink, not a session directory — never followed; reconcile manually'],
      }
      : inspectSession(gitFn, rootDir, sessionsDir, entry.name, activeDays, now)
  ));
  return {
    root: rootDir,
    activeDays,
    note: 'Proposals are proposals — inventory evidence only; the operator decides each session.',
    sessions,
  };
}

// === Backup ===
//
// A backup tag is worth pushing only where no remote already holds the
// commit. Local refs never count as "already held": a stale
// refs/remotes/* entry or a local tag whose push failed prove nothing.

function repoLabel(wt) {
  return wt.kind === 'workspace' ? 'the workspace repo' : `repo "${wt.repo}"`;
}

// Does a remote's URL point somewhere OTHER than the workspace itself? A
// remote whose URL resolves to a local path inside root shares its fate
// with the thing being deleted (a remote pointing at the repo, or at a
// sibling repo under root, holds the same objects in the same store), so
// "the remote has it" proves nothing. file:// URLs and plain paths are
// local; scheme URLs and scp-style git@host:path are real remotes.
function parseRemoteUrl(url) {
  if (url.startsWith('file://')) return { local: true, path: fileURLToPath(url) };
  if (/:\/\//.test(url)) return { local: false };
  if (/^[^:@/\s]+@[^:\s]+:/.test(url)) return { local: false };
  return { local: true, path: url };
}

function remoteQualifies(safety, repoDir, remote) {
  const key = `${repoDir}\0${remote}`;
  if (safety.qualCache.has(key)) return safety.qualCache.get(key);
  let qualifies = false;
  const res = run(safety.gitFn, repoDir, ['remote', 'get-url', remote]);
  if (res.status === 0) {
    const parsed = parseRemoteUrl(String(res.stdout).trim());
    // Relative local paths resolve against the repo, the way git does.
    qualifies = !parsed.local || !insideRoot(safety.rootDir, realPath(resolve(repoDir, parsed.path)));
  }
  // An unreadable URL proves nothing (fail closed).
  safety.qualCache.set(key, qualifies);
  return qualifies;
}

// Every branch and tag a remote holds, mapped by commit sha. Other
// advertised refs (HEAD, a forge's refs/pull/N/*) are ephemeral and never
// count. No refspec pattern: patterns silently drop the peeled ^{} lines,
// which are the ones comparable with commit tips. A failed or timed-out
// query returns null (unknown) — it proves nothing.
function remoteRefs(safety, repoDir, remote) {
  const key = `${repoDir}\0${remote}`;
  if (safety.lsCache.has(key)) return safety.lsCache.get(key);
  let map = null;
  const res = safety.gitFn('git', ['-C', repoDir, 'ls-remote', remote], netOpts(LS_REMOTE_TIMEOUT_MS));
  if (!res.error && res.status === 0) {
    map = new Map();
    for (const line of okLines(res)) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (!ref || !/^refs\/(heads|tags)\//.test(ref)) continue;
      if (!map.has(sha)) map.set(sha, ref);
    }
  }
  safety.lsCache.set(key, map);
  return map;
}

// Does a qualifying remote hold a branch or tag at exactly this commit,
// right now? This only decides whether --backup can skip a tag; archive
// never depends on it, so it stays deliberately simple — no ancestry
// walk, no fetch, nothing written locally.
function tipSafety(safety, repoDir, sha) {
  for (const remote of safety.remotes(repoDir)) {
    if (!remoteQualifies(safety, repoDir, remote)) continue;
    const refs = remoteRefs(safety, repoDir, remote);
    if (!refs) continue;
    const exact = refs.get(sha);
    if (exact) return { safe: true, by: 'remote', remote, ref: exact };
  }
  return { safe: false };
}

function makeSafety(gitFn, rootDir) {
  const safety = {
    gitFn,
    rootDir,
    lsCache: new Map(),
    qualCache: new Map(),
    remotesCache: new Map(),
    remotes(repoDir) {
      if (!safety.remotesCache.has(repoDir)) {
        const res = run(gitFn, repoDir, ['remote']);
        safety.remotesCache.set(repoDir, res.status === 0 ? okLines(res) : []);
      }
      return safety.remotesCache.get(repoDir);
    },
  };
  return safety;
}

// The real path of a worktree's shared git directory — which repository
// it belongs to.
function commonDirOf(gitFn, wtPath) {
  const res = run(gitFn, wtPath, ['rev-parse', '--git-common-dir']);
  if (res.status !== 0) return null;
  return realPath(resolve(wtPath, String(res.stdout).trim()));
}

// The tips a session holds, for --backup: the session branch in the
// workspace repo and in every project repo it names (the tracker's
// branch: and repos:, falling back to the workspace worktree's branch and
// the directories under workspace/repos/), plus every worktree's current
// HEAD, branch or detached. Repo names that are not single in-root
// segments are skipped here — git is never run in them — and reported by
// validateTrackerShape.
function sessionTips(gitFn, rootDir, folder) {
  const wsDir = join(folder, 'workspace');
  const tracker = readTracker(wsDir);
  const rawWorktrees = collectSessionWorktrees(gitFn, rootDir, folder);
  const worktrees = rawWorktrees.map((w) => ({
    ...w,
    rootDir,
    branch: w.kind === 'foreign' ? null : currentBranch(gitFn, w.path),
    head: w.kind === 'foreign' ? null : headSha(gitFn, w.path),
    commonDir: w.kind === 'foreign' ? null : commonDirOf(gitFn, w.path),
  }));

  let branch = tracker?.branch || null;
  let repos = tracker ? [...tracker.repos] : [];
  const discovered = repos.length === 0;
  if (discovered) {
    const nested = join(wsDir, 'repos');
    if (existsSync(nested)) {
      // Mirror cleanup's discovery: every entry that statSync reports as
      // a directory (symlinks to directories included). Entries that are
      // not really worktrees are caught by the structure allowlist, but
      // the deletion set stays a superset either way.
      repos = readdirSync(nested).filter((n) => {
        try {
          return statSync(join(nested, n)).isDirectory();
        } catch {
          return false;
        }
      });
    }
  }
  if (!branch) {
    const wsWt = worktrees.find((w) => w.kind === 'workspace');
    branch = wsWt ? wsWt.branch : null;
  }

  // Tips: the branch ref in every repo cleanup will delete it from, plus
  // every worktree HEAD. Deduped per repo+sha, branch names preferred.
  const tips = [];
  const seen = new Map();
  const addTip = (repoDir, repo, kind, ref, sha) => {
    if (!sha || !existsSync(repoDir)) return;
    const key = `${repoDir}\0${sha}`;
    const prev = seen.get(key);
    if (prev) {
      if (!prev.ref && ref) prev.ref = ref;
      return;
    }
    const tip = { repoDir, repo, kind, ref: ref ?? null, sha };
    seen.set(key, tip);
    tips.push(tip);
  };
  if (branch) {
    addTip(rootDir, WORKSPACE_REPO, 'workspace', branch, branchTip(gitFn, rootDir, branch));
    const reposRoot = realPath(join(rootDir, 'repos'));
    for (const repo of repos) {
      if (!isRepoSegment(repo)) continue;
      const repoDir = join(rootDir, 'repos', repo);
      if (!insideDir(reposRoot, repoDir)) continue;
      addTip(repoDir, repo, 'project', branch, branchTip(gitFn, repoDir, branch));
    }
  }
  for (const wt of worktrees) {
    if (wt.kind === 'foreign') continue;
    addTip(realPath(wt.commonDir ? dirname(wt.commonDir) : wt.path), wt.repo, wt.kind, wt.branch, wt.head);
  }

  return { folder, branch, repos, discovered, tracker, worktrees, tips };
}

function branchTip(gitFn, repoDir, branch) {
  const res = run(gitFn, repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return res.status === 0 ? String(res.stdout).trim() : null;
}

// The tracker is data from a branch — never trusted as a path or a ref
// name. Repo names must be single in-root segments, and the branch must
// satisfy git's own ref format, before --backup acts on either.
function validateTrackerShape(gitFn, rootDir, del) {
  const reasons = [];
  if (del.branch) {
    const res = gitFn('git', ['check-ref-format', '--branch', del.branch], { encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      reasons.push(`tracker branch "${del.branch}" is not a valid branch name — reconcile the tracker first`);
    }
  }
  const reposRoot = realPath(join(rootDir, 'repos'));
  for (const repo of del.repos) {
    if (!isRepoSegment(repo)) {
      reasons.push(`tracker repos entry "${repo}" is not a single path segment — reconcile the tracker first`);
      continue;
    }
    if (!insideDir(reposRoot, join(rootDir, 'repos', repo))) {
      reasons.push(`tracker repos entry "${repo}" escapes ${relative(rootDir, join(rootDir, 'repos'))}/ — reconcile the tracker first`);
    }
  }
  return reasons;
}

// --backup acts only on a session of the known shape: workspace/ a
// worktree of the workspace repo, each workspace/repos/{name} a worktree
// of root/repos/{name}, tracker consistent with both. Anything else is
// refused by name and left for the operator (archive still works — it
// keeps everything regardless of shape).
function structureReasons(gitFn, rootDir, folder, del) {
  const reasons = [];
  const wsDir = join(folder, 'workspace');

  for (const entry of readdirSync(folder)) {
    if (entry !== 'workspace') {
      reasons.push(`unexpected entry "${entry}" beside workspace/ — a session folder holds only workspace/; reconcile first`);
    }
  }

  const wsWt = del.worktrees.find((w) => w.kind === 'workspace');
  if (!wsWt) {
    reasons.push('workspace/ is not a git worktree — reconcile first');
  } else if (!wsWt.commonDir || wsWt.commonDir !== realPath(join(rootDir, '.git'))) {
    reasons.push(`workspace/ is not a worktree of the workspace repo (common dir ${wsWt.commonDir ?? 'unknown'}) — reconcile first`);
  }

  const nestedDir = join(wsDir, 'repos');
  const nestedNames = [];
  if (existsSync(nestedDir)) {
    for (const entry of readdirSync(nestedDir, { withFileTypes: true })) {
      const p = join(nestedDir, entry.name);
      if (entry.isSymbolicLink()) {
        reasons.push(`repos/${entry.name} is a symlink, not a worktree — reconcile first`);
        continue;
      }
      if (entry.isFile()) {
        reasons.push(`repos/${entry.name} is a file, not a worktree — reconcile first`);
        continue;
      }
      if (!entry.isDirectory()) continue; // sockets/fifos and the like: unreadable, refuse via the file branch if git ever lists them
      if (!existsSync(join(p, '.git'))) {
        reasons.push(`repos/${entry.name} is a plain directory, not a worktree — reconcile first`);
        continue;
      }
      const expected = realPath(join(rootDir, 'repos', entry.name, '.git'));
      const common = commonDirOf(gitFn, p);
      if (!common || common !== expected) {
        reasons.push(`repos/${entry.name} is not a worktree of repos/${entry.name} (plain clone or foreign repository; common dir ${common ?? 'unknown'}) — reconcile first`);
        continue;
      }
      nestedNames.push(entry.name);
    }
  }

  if (del.tracker && del.tracker.repos.length > 0) {
    const tracked = [...del.tracker.repos].map(String).sort();
    if (JSON.stringify(tracked) !== JSON.stringify([...nestedNames].sort())) {
      reasons.push(`tracker repos [${tracked.join(', ')}] do not match the nested worktrees [${[...nestedNames].sort().join(', ')}] — reconcile the tracker first`);
    }
  }

  if (del.tracker?.branch) {
    for (const w of del.worktrees) {
      if (w.kind !== 'foreign' && w.branch && w.branch !== del.tracker.branch) {
        reasons.push(`tracker says branch ${del.tracker.branch} but the ${w.kind} worktree is on ${w.branch} (drift) — reconcile the tracker first`);
        break;
      }
    }
  }
  return reasons;
}

// Guards shared by every acting mode: the session folder must be a real
// directory inside the root (a symlinked entry may point anywhere), and
// the session hosting the current chat is never acted on from inside
// itself — on Windows a directory that is a live process's cwd cannot
// even be renamed.
function sessionFolderGuards(rootDir, sessionsDir, session, cwd) {
  const folder = join(sessionsDir, session);
  if (!existsSync(folder)) {
    return { folder, refusal: { refused: true, reasons: [`no session named "${session}" under ${relative(rootDir, sessionsDir)}`] } };
  }
  let st = null;
  try { st = lstatSync(folder); } catch { /* handled below */ }
  if (!st || !st.isDirectory() || st.isSymbolicLink()) {
    return { folder, refusal: { refused: true, reasons: [`session entry "${session}" is not a real directory (symlink or missing) — never followed; reconcile manually`] } };
  }
  if (!insideRoot(rootDir, folder)) {
    return { folder, refusal: { refused: true, reasons: [`session folder "${session}" resolves outside the workspace root — refusing`] } };
  }
  const cwdReal = realPath(resolve(cwd || '.'));
  if (cwdReal.startsWith(realPath(folder) + sep) || cwdReal === realPath(folder)) {
    return { folder, refusal: { refused: true, reasons: [`session "${session}" hosts the current chat — run its backup/archive from the workspace root, not from inside the session`] } };
  }
  return { folder, refusal: null };
}

// The local peeled SHA of an existing tag, or null when the tag is
// absent. Refnames cannot contain ^{ (check-ref-format forbids ^), so
// appending ^{} to interpolate the peel is safe.
function peeledTagSha(gitFn, cwd, tag) {
  const res = run(gitFn, cwd, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{}`]);
  return res.status === 0 ? String(res.stdout).trim() : null;
}

// Does {tag} exist on {remote} at exactly {commit}? Deliberately no
// refspec pattern: a pattern filters out the peeled `^{}` line (the
// tag object's sha is not the commit's), and the peeled line is exactly
// what "at this commit" needs. An annotated tag answers via the peel; a
// lightweight tag's only line already is the commit.
function tagOnRemoteAt(gitFn, cwd, remote, tag, commit) {
  const res = gitFn('git', ['-C', cwd, 'ls-remote', '--tags', remote], netOpts(LS_REMOTE_TIMEOUT_MS));
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

// S4: where a backup tag is pushed — branch.<b>.pushRemote, then
// remote.pushDefault, then branch.<b>.remote, then origin, then the
// first configured remote. An explicit --remote overrides everything.
function resolvePushRemote(gitFn, repoDir, branch, override, remotes) {
  if (override) {
    return remotes.includes(override)
      ? { remote: override }
      : { remote: null, reason: `--remote ${override} is not configured for this repo (has: ${remotes.join(', ') || 'none'})` };
  }
  const cfg = (key) => {
    const res = run(gitFn, repoDir, ['config', '--get', key]);
    return res.status === 0 ? String(res.stdout).trim() : null;
  };
  const chain = branch
    ? [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`]
    : ['remote.pushDefault'];
  for (const key of chain) {
    const value = cfg(key);
    if (value && remotes.includes(value)) return { remote: value };
  }
  if (remotes.includes('origin')) return { remote: 'origin' };
  if (remotes.length > 0) return { remote: remotes[0] };
  return { remote: null };
}

/**
 * Back up every tip the session holds that no qualifying remote already
 * has as a branch or tag: an annotated, session-scoped `drain/{session}/…`
 * tag at the tip, pushed to the resolved remote and verified there — an
 * off-machine copy of the session's commits before it is archived, and
 * the thing to check before the operator ever deletes an archive. With dryRun the
 * plan is reported per tip (remote, tag, already-safe) with no side
 * effects — backup is a decision, and the operator sees exactly what
 * would be pushed where before saying yes. Idempotent — an existing tag
 * at the same commit is fine; at a different commit (the branch moved)
 * the operator must decide, so it refuses.
 */
function backupSession(root, { session, remote: remoteOverride = null, dryRun = false, gitFn = spawnSync, cwd = process.cwd() } = {}) {
  const rootDir = resolveRoot(root);
  if (!isSessionSegment(session)) {
    throw new Error(`session name must be a single path segment, got: ${session}`);
  }
  const sessionsDir = sessionsDirOf(rootDir);
  const { folder, refusal } = sessionFolderGuards(rootDir, sessionsDir, session, cwd);
  if (refusal) return refusal;

  const del = sessionTips(gitFn, rootDir, folder);
  const reasons = [...validateTrackerShape(gitFn, rootDir, del)];
  if (existsSync(join(folder, 'workspace', '.git'))) {
    reasons.push(...structureReasons(gitFn, rootDir, folder, del));
  }
  const branches = [];
  const skipped = [];
  const planned = [];
  if (reasons.length === 0 && existsSync(join(folder, 'workspace', '.git'))) {
    const safety = makeSafety(gitFn, rootDir);
    for (const tip of del.tips) {
      const verdict = tipSafety(safety, tip.repoDir, tip.sha);
      if (verdict.safe) {
        // Already provably on a qualifying remote — pushing a tag for it
        // would only add noise (and possibly land in a public repo).
        skipped.push({ repo: tip.repo, ref: tip.ref ?? 'HEAD', commit: tip.sha, safeOn: verdict.remote, safeRef: verdict.ref });
        continue;
      }
      const shortSha = tip.sha.slice(0, 10);
      const tagName = tip.ref
        ? `drain/${session}/${slugForBranch(tip.ref)}`
        : `drain/${session}/${tip.kind === 'workspace' ? 'workspace' : tip.repo}-detached-${shortSha}`;
      const tagDir = tip.repoDir;
      const remotes = safety.remotes(tagDir);
      if (remotes.length === 0) {
        reasons.push(`${repoLabel(tip)} has no remote to push the backup tag ${tagName} to — decide manually where to back up ${tip.ref ?? shortSha}`);
        continue;
      }
      const { remote, reason } = resolvePushRemote(gitFn, tagDir, tip.ref, remoteOverride, remotes);
      if (!remote) {
        reasons.push(reason || `${repoLabel(tip)}: no push remote resolves — decide manually`);
        continue;
      }
      const existing = peeledTagSha(gitFn, tagDir, tagName);
      if (existing && existing !== tip.sha) {
        reasons.push(`${repoLabel(tip)}: tag ${tagName} already points at ${existing.slice(0, 10)}…, not the current tip (${shortSha}…); the branch moved — decide manually`);
        continue;
      }
      if (dryRun) {
        planned.push({
          repo: tip.repo,
          branch: tip.ref,
          detached: !tip.ref,
          commit: tip.sha,
          tag: tagName,
          remote,
          alreadySafe: false,
          wouldCreate: !existing,
        });
        continue;
      }
      let createdThisRun = false;
      if (!existing) {
        const created = run(gitFn, tagDir, ['tag', '-a', tagName, '-m', `backup before draining session ${session}`, tip.sha]);
        if (created.status !== 0) {
          reasons.push(`${repoLabel(tip)}: git tag ${tagName} failed: ${String(created.stderr || '').trim()}`);
          continue;
        }
        createdThisRun = true;
      }
      const pushed = gitFn('git', ['-C', tagDir, 'push', remote, `refs/tags/${tagName}`], netOpts(PUSH_TIMEOUT_MS));
      if (pushed.error || pushed.status !== 0) {
        // A local tag that never reached a remote masquerades as a
        // backup (and local refs prove nothing) — remove the one we made.
        if (createdThisRun) run(gitFn, tagDir, ['tag', '-d', tagName]);
        const detail = pushed.error ? `timed out after ${PUSH_TIMEOUT_MS / 1000}s` : String(pushed.stderr || '').trim();
        reasons.push(`${repoLabel(tip)}: pushing ${tagName} to ${remote} failed (${detail}) — treat ${tip.ref ?? shortSha} as unbacked`);
        continue;
      }
      const verified = tagOnRemoteAt(gitFn, tagDir, remote, tagName, tip.sha);
      if (!verified) {
        if (createdThisRun) run(gitFn, tagDir, ['tag', '-d', tagName]);
        reasons.push(`${repoLabel(tip)}: tag ${tagName} not found on ${remote} after pushing — treat ${tip.ref ?? shortSha} as unbacked`);
        continue;
      }
      branches.push({
        repo: tip.repo,
        branch: tip.ref,
        detached: !tip.ref,
        tag: tagName,
        commit: tip.sha,
        remote,
        pushed: true,
        verified: true,
      });
    }
  }
  if (reasons.length > 0) return { refused: true, reasons };
  if (dryRun) return { session, dryRun: true, tips: planned, skipped };
  return { session, branches, skipped };
}

// Every `.git` FILE under a directory marks a linked worktree; its
// gitdir: line names the repository that owns it. Embedded repositories
// (`.git` directories) need no bookkeeping — they move with the folder.
// Symlinks are never followed.
function worktreeMarkers(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.name === '.git') {
      if (entry.isFile()) acc.push(p);
      continue; // never descend into a git directory
    }
    if (entry.isDirectory()) worktreeMarkers(p, acc);
  }
  return acc;
}

// The admin directory a worktree's .git file points at, or null.
function gitdirOfMarker(markerPath) {
  try {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(markerPath, 'utf8'));
    return m ? realPath(resolve(dirname(markerPath), m[1].trim())) : null;
  } catch {
    return null;
  }
}

// The repositories this workspace owns: the workspace repo and every
// root/repos/{name} clone. Only these are ever repaired.
function workspaceRepos(rootDir) {
  const repos = [{ repo: WORKSPACE_REPO, dir: rootDir, gitDir: realPath(join(rootDir, '.git')) }];
  const reposRoot = join(rootDir, 'repos');
  if (existsSync(reposRoot)) {
    for (const entry of readdirSync(reposRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isRepoSegment(entry.name)) continue;
      const dir = join(reposRoot, entry.name);
      if (existsSync(join(dir, '.git'))) repos.push({ repo: entry.name, dir, gitDir: realPath(join(dir, '.git')) });
    }
  }
  return repos;
}

function archiveStamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

// Point every repository at the worktrees' current location, then prove
// it: each worktree resolves its own top level and its owning repo lists
// it at that path.
function repairWorktrees(gitFn, owned, worktreePaths) {
  const problems = [];
  const byRepo = new Map();
  for (const w of worktreePaths) {
    if (!byRepo.has(w.owner.dir)) byRepo.set(w.owner.dir, []);
    byRepo.get(w.owner.dir).push(w.path);
  }
  for (const [repoDir, paths] of byRepo) {
    const res = run(gitFn, repoDir, ['worktree', 'repair', ...paths]);
    if (res.status !== 0) problems.push(`git worktree repair in ${repoDir} failed: ${String(res.stderr || '').trim()}`);
  }
  for (const w of worktreePaths) {
    const top = run(gitFn, w.path, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0 || realPath(String(top.stdout).trim()) !== realPath(w.path)) {
      problems.push(`worktree at ${w.path} does not resolve to itself after repair`);
      continue;
    }
    const listed = run(gitFn, w.owner.dir, ['worktree', 'list', '--porcelain']);
    const paths = okLines(listed).filter((l) => l.startsWith('worktree ')).map((l) => realPath(l.slice(9)));
    if (!paths.includes(realPath(w.path))) problems.push(`${w.owner.dir} does not list the worktree at ${w.path} after repair`);
  }
  return problems;
}

/**
 * Take a session out of the active lifecycle without destroying anything:
 * rename its folder into {sessions}/.archived/{session}--{stamp}/ and
 * repair git's worktree links so every repository follows it. Every
 * file, ref, stash, index flag and embedded repository is kept, because
 * nothing is deleted. The session's branches stay checked out in the
 * archived worktrees until the operator removes them.
 *
 * Refused, with nothing moved, when a worktree inside the folder belongs
 * to a repository outside this workspace (repairing it would mean running
 * git there) or its link is unreadable. If repair fails after the rename,
 * the folder is renamed back and repaired again.
 */
function archiveSession(root, { session, gitFn = spawnSync, cwd = process.cwd(), now = Date.now() } = {}) {
  const rootDir = resolveRoot(root);
  if (!isSessionSegment(session)) {
    throw new Error(`session name must be a single path segment, got: ${session}`);
  }
  const sessionsDir = sessionsDirOf(rootDir);
  const { folder, refusal } = sessionFolderGuards(rootDir, sessionsDir, session, cwd);
  if (refusal) return refusal;

  const owned = workspaceRepos(rootDir);
  const ownedByGitDir = new Map(owned.map((o) => [o.gitDir, o]));
  const reasons = [];
  const found = [];
  for (const marker of worktreeMarkers(folder)) {
    const admin = gitdirOfMarker(marker);
    const wtPath = dirname(marker);
    const rel = relative(folder, wtPath) || '.';
    if (!admin) {
      reasons.push(`${relative(rootDir, marker)} has no readable gitdir — reconcile this worktree manually first`);
      continue;
    }
    // Admin dirs live at {gitDir}/worktrees/{id}.
    const owner = ownedByGitDir.get(realPath(dirname(dirname(admin))));
    if (!owner || realPath(dirname(admin)) !== join(owner.gitDir, 'worktrees')) {
      reasons.push(`${relative(rootDir, wtPath)} is a worktree of a repository outside this workspace (${admin}) — refusing to touch it; move or remove it manually`);
      continue;
    }
    found.push({ rel, owner });
  }
  if (reasons.length > 0) return { refused: true, reasons };

  const archiveDir = join(sessionsDir, '.archived');
  const dest = join(archiveDir, `${session}--${archiveStamp(now)}`);
  if (existsSync(dest)) {
    return { refused: true, reasons: [`${relative(rootDir, dest)} already exists — wait a second and retry`] };
  }
  mkdirSync(archiveDir, { recursive: true });
  try {
    renameSync(folder, dest);
  } catch (err) {
    return { refused: true, reasons: [`could not move ${relative(rootDir, folder)}: ${err.code || err.message} — close anything using files in it (editors, terminals, dev servers) and retry`] };
  }

  const moved = found.map((f) => ({ owner: f.owner, path: f.rel === '.' ? dest : join(dest, f.rel) }));
  const problems = repairWorktrees(gitFn, owned, moved);
  if (problems.length > 0) {
    // Put it back exactly where it was; nothing has been lost either way.
    let restored = false;
    try {
      renameSync(dest, folder);
      restored = true;
      repairWorktrees(gitFn, owned, found.map((f) => ({ owner: f.owner, path: f.rel === '.' ? folder : join(folder, f.rel) })));
    } catch { /* reported below */ }
    return {
      refused: true,
      reasons: [
        ...problems,
        restored
          ? `the session was moved back to ${relative(rootDir, folder)}; nothing was lost`
          : `the session is at ${relative(rootDir, dest)} and could not be moved back; nothing was deleted — run \`git worktree repair\` in each repo, naming the moved worktree paths`,
      ],
    };
  }

  return {
    session,
    archived: true,
    from: relative(rootDir, folder),
    to: relative(rootDir, dest),
    worktrees: moved.map((m) => ({ repo: m.owner.repo, path: relative(rootDir, m.path) })),
  };
}

// The launcher root is the main worktree of the workspace repo; every
// other checkout is a linked worktree. Acting modes require the
// launcher; --enable-task-model is the exception (it edits workspace.json
// inside a task worktree by design — S6).
function isLinkedWorktree(gitFn, rootDir) {
  const gitDir = run(gitFn, rootDir, ['rev-parse', '--git-dir']);
  const commonDir = run(gitFn, rootDir, ['rev-parse', '--git-common-dir']);
  if (gitDir.status !== 0 || commonDir.status !== 0) return false; // not a git repo at all; other checks will fail loudly
  return realPath(resolve(rootDir, String(gitDir.stdout).trim()))
    !== realPath(resolve(rootDir, String(commonDir.stdout).trim()));
}

/**
 * Switch the workspace to the task model. From the launcher this also
 * reports the remaining sessions; from a task worktree (the S6 flow)
 * there is no sessions directory to read — remainingSessions is null
 * and the note says where the real list comes from.
 */
function enableTaskModel(root, { gitFn = spawnSync } = {}) {
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
  const linked = isLinkedWorktree(gitFn, rootDir);
  return linked
    ? {
      sessionModel: 'task',
      remainingSessions: null,
      note: 'run from a task worktree — remaining sessions come from --inventory at the launcher root',
    }
    : { sessionModel: 'task', remainingSessions: listSessionNames(rootDir) };
}

// Human-readable inventory rendering for stderr — the operator's table;
// the JSON on stdout is the machine copy.
function renderTable(result) {
  const lines = [`${result.sessions.length} session(s); proposals are proposals — the operator decides each one.`];
  for (const s of result.sessions) {
    lines.push('');
    lines.push(`${s.name}  ${s.kind === 'broken' ? 'broken shell' : s.kind === 'foreign' ? 'foreign entry' : s.proposal}` +
      (s.kind === 'broken' || s.kind === 'foreign' ? '' : `  (status ${s.status ?? '—'}, last activity ${s.lastActivity ?? '—'}, work item ${s.workItem ?? '—'})`));
    for (const w of s.worktrees || []) {
      const remotes = Object.entries(w.remotes)
        .map(([r, v]) => describeRemote(r, v))
        .join(' ') || 'no remotes';
      const extra = w.kind === 'workspace' ? `  content:${w.contentFiles}` : '';
      lines.push(`    ${w.kind === 'workspace' ? '(workspace)' : w.repo}  ${w.branch ?? 'detached'}  ahead:${w.ahead ?? '?'} dirty:${w.dirty}${extra}  [${remotes}]`);
    }
    for (const r of s.reasons || []) lines.push(`    · ${r}`);
    for (const w of s.warnings || []) lines.push(`    ! ${w.message}`);
  }
  return `${lines.join('\n')}\n`;
}

const MODE_FLAGS = new Set(['--inventory', '--backup', '--archive', '--enable-task-model']);
const VALUE_FLAGS = new Map([
  ['--root', 'root'],
  ['--session', 'session'],
  ['--active-days', 'activeDays'],
  ['--remote', 'remote'],
]);

function parseArgs(argv) {
  const args = { root: '.', mode: null, session: null, activeDays: null, remote: null, dryRun: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (MODE_FLAGS.has(a)) {
      if (args.mode) throw new Error(`only one mode flag may be given (already have --${args.mode})`);
      args.mode = a.slice(2);
      continue;
    }
    if (a === '--dry-run') { args.dryRun = true; continue; }
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
  if (!args.mode) throw new Error('one of --inventory, --backup, --archive, --enable-task-model is required');
  if ((args.mode === 'backup' || args.mode === 'archive') && !args.session) {
    throw new Error(`--${args.mode} requires --session`);
  }
  if (args.session != null && args.mode !== 'backup' && args.mode !== 'archive') {
    throw new Error('--session is only valid with --backup or --archive');
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
  if (args.remote != null && args.mode !== 'backup') {
    throw new Error('--remote is only valid with --backup');
  }
  if (args.dryRun && args.mode !== 'backup') {
    throw new Error('--dry-run is only valid with --backup');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = resolveRoot(args.root);
  // S5: every acting mode runs from the launcher; only the task-model
  // switch is allowed to aim at a (task) worktree root.
  if (args.mode !== 'enable-task-model' && isLinkedWorktree(spawnSync, rootDir)) {
    throw new Error(`--root ${rootDir} is a linked worktree — run from the workspace root (the launcher)`);
  }
  let out;
  let code = 0;
  if (args.mode === 'inventory') {
    out = inventory(rootDir, { activeDays: args.activeDays ?? 14 });
    process.stderr.write(renderTable(out));
  } else if (args.mode === 'backup') {
    out = backupSession(rootDir, { session: args.session, remote: args.remote, dryRun: args.dryRun });
  } else if (args.mode === 'archive') {
    out = archiveSession(rootDir, { session: args.session });
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

export { inventory, backupSession, archiveSession, enableTaskModel, classify, parseArgs };
