#!/usr/bin/env node
// Release leak audit (gh:203): scan exactly what a release would publish
// against the leak patterns the workspace configured, before the tag is
// pushed and the publish becomes permanent.
//
// /release keeps the process honest — the bump rides a PR, the tag marks
// the merge — but no step of it looks at content. A credential pasted into
// a shipped file or a commit message is public from the moment the tag is
// pushed, and deleting a tag does not unpublish a tarball or a clone
// somebody already fetched. This script is the optional content gate.
//
// Patterns (workspace.json, arrays of strings):
//   repos.{repo}.release.leakPatterns   this repo alone
//   workspace.release.leakPatterns      every repo — and, as with
//                                       repos.{repo}.merge, the workspace
//                                       repo "." itself reads this block
// A pattern written "/body/flags" (flags from d g i m s u v y) is that
// regex; any other string is a case-insensitive literal. Mind the seam
// between the forms: a path-like literal whose tail parses as a flags run
// ("/keys/i") reads as a regex — write such literals without the leading
// slash ("keys/i"), or escape the separators as a regex. Global and
// sticky patterns are safe to configure: the scanner resets lastIndex
// before every line, so no match state leaks across lines.
//
// The surface is what this release publishes, unioned rather than either:
//   - the `npm pack --dry-run --ignore-scripts --json` file list, when the
//     repo's package.json is not "private": true — run with
//     --ignore-scripts because an audit must not execute a prepack or
//     prepare hook as a side effect. The list covers the root package
//     only (a monorepo's workspace packages are not enumerated) and is
//     built from the worktree, so build artifacts a publish workflow
//     generates only in CI are not on it — which is why the union below
//     matters;
//   - the files changed in the tag range (`git diff --name-only -z
//     --no-renames`, so paths with non-ASCII bytes, quotes, or leading
//     spaces arrive raw rather than quoted-and-trimmed).
// File contents are read from the worktree — except with an explicit
// --tag-range whose end is not HEAD, where they are read from that commit
// (git show), so the audit scans the state the range actually names.
//
// Every commit message in the range is scanned too (--format=%B): squash
// merges fold PR bodies into public history, so a body line is as
// published as a file line. A match cites the commit's short sha as its
// file ("commit <sha>") with the line inside the message.
//
// Usage:
//   node release-leak-audit.mjs --root <launcher> --repo <repo>
//                               [--tag-range <from>..<to>] [--allow-dirty]
//
// The range defaults to <last tag>..HEAD; a repo with no tag yet diffs
// against the empty tree and logs its whole history, so the root commit
// is part of a first release's surface too. --tag-range overrides both
// ends and must name commits ("a...b" symmetric ranges are rejected).
//
// The worktree must be clean: contents are read from disk, so auditing a
// dirty tree would scan changes that then ship differently. Uncommitted
// changes stop the audit (exit 2) unless --allow-dirty is passed.
//
// Output on stdout: { scanned, matches, skipped, skippedBinary }.
//   matches: [{ file, line, pattern, excerpt }] — the excerpt carries
//   ~40 chars of context with the matched span masked as
//   "[match:N chars]", so the report never echoes the secret it found.
//   skipped: [{ file, reason }] — every file that could not be read,
//   except ones deleted in the range (a deletion publishes nothing) and
//   binary ones (a NUL byte anywhere — git's own heuristic), which are
//   counted in skippedBinary instead. scanned counts the text files and
//   commit messages actually searched. Exit codes: 0 — clean, or nothing
//   configured; 1 — matches found; 2 — configuration or environment
//   error, including a dirty worktree.
//
// With no patterns configured it exits 0 having scanned nothing — the
// step runs and reports that there was nothing to look for, so a
// workspace that never opts in needs no special-casing. On a match it
// never edits anything; whether a match is a true leak, an over-broad
// pattern, or a release to redo is the operator's decision, made before
// the tag exists.

import '../lib/require-node.mjs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWorkspace, repoDirFor, WORKSPACE_REPO } from './merge-mode.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const NPM_TIMEOUT_MS = 120_000;
const CONTEXT_CHARS = 40;
// The well-known empty tree. Diffing against it means "everything that
// exists now" without naming a first commit; changedFiles materializes it
// (hash-object -w) first, because a fresh repo may not hold the object.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbc5aff';

// npm on Windows is npm.cmd, which spawnSync cannot execute without a
// shell. The args are fixed flags with no interpolated value, so the
// joined command line stays honest — the same shape lib/payload.mjs uses.
function defaultNpmFn(cmd, args, opts = {}) {
  if (process.platform !== 'win32') return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return spawnSync('npm.cmd', args.map((a) => `"${a}"`), { shell: true, encoding: 'utf8', ...opts });
}

function gitRun(gitFn, repoDir, args, opts = {}) {
  const res = gitFn('git', ['-C', repoDir, ...args], { encoding: 'utf8', ...opts });
  if (res.error) throw new Error(`git: ${res.error.message}`);
  return res;
}

// Compile one configured pattern. The regex form is only the full
// /body/flags shape with known flags; everything else is a literal, so a
// slashed string whose tail is not a flags run ("/data/keys") still works
// as the path literal its author meant. Literals compile to an escaped
// case-insensitive regex so the match index refers to the original line
// (lowercasing the whole line would shift indices for some Unicode).
const REGEX_FORM = /^\/(.+)\/([dgimsuvy]*)$/;
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function compilePattern(raw) {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`leak patterns must be non-empty strings, got: ${JSON.stringify(raw)}`);
  }
  const m = raw.match(REGEX_FORM);
  let re;
  if (!m) {
    try {
      re = new RegExp(raw.replace(REGEX_ESCAPE, '\\$&'), 'i');
    } catch (err) {
      throw new Error(`leak pattern ${JSON.stringify(raw)} is not a valid literal: ${err.message}`);
    }
  } else {
    // Keep every flag the author wrote (g and y included) — find() resets
    // lastIndex around each use, so stateful flags cannot leak across lines.
    const flags = [...new Set(m[2])].join('');
    try {
      re = new RegExp(m[1], flags);
    } catch (err) {
      throw new Error(`leak pattern ${JSON.stringify(raw)} is not a valid regex: ${err.message}`);
    }
  }
  return {
    raw,
    find: (line) => {
      re.lastIndex = 0;
      const hit = re.exec(line);
      re.lastIndex = 0;
      return hit === null ? null : { index: hit.index, length: hit[0].length };
    },
  };
}

// The combined pattern list for one repo: its own patterns first, then
// the workspace-wide ones, de-duplicated. The workspace repo "." has no
// repos.{repo} entry of its own — its per-repo settings live in the
// workspace block (the same split mergeModeFor makes for `merge`), which
// for leak patterns means one block serves both roles.
function leakPatternsFor(ws, repo) {
  const read = (value, setting) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((p) => typeof p !== 'string' || p === '')) {
      throw new Error(`${setting} must be an array of non-empty strings`);
    }
    return value;
  };
  const repoLevel = repo === WORKSPACE_REPO
    ? read(ws?.workspace?.release?.leakPatterns, 'workspace.release.leakPatterns')
    : read(ws?.repos?.[repo]?.release?.leakPatterns, `repos.${repo}.release.leakPatterns`);
  const allRepos = read(ws?.workspace?.release?.leakPatterns, 'workspace.release.leakPatterns');
  return [...new Set([...repoLevel, ...allRepos])];
}

// A package.json without "private": true describes a package npm would
// publish — its pack list is part of the release surface. Anything else
// (no package.json, private, or a file that does not parse) publishes
// through git alone, so the tag range carries the surface instead.
function isPublishedPackage(repoDir) {
  const pkgPath = join(repoDir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8'))?.private !== true;
  } catch {
    return false;
  }
}

// npm prints notices before the JSON; take the trailing JSON array and
// find the '[' that actually starts it (a notice may contain brackets).
function parsePackJson(stdout) {
  const out = String(stdout || '');
  const end = out.lastIndexOf(']');
  if (end === -1) throw new Error('no JSON array found in npm pack output');
  let idx = out.indexOf('[');
  while (idx !== -1 && idx < end) {
    try {
      const parsed = JSON.parse(out.slice(idx, end + 1));
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* this '[' was noise — try the next one */ }
    idx = out.indexOf('[', idx + 1);
  }
  throw new Error('npm pack printed unparseable JSON output');
}

function packFileList(npmFn, repoDir) {
  const res = npmFn('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: repoDir, encoding: 'utf8', timeout: NPM_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`npm pack --dry-run failed in ${repoDir}: ${String(res.stderr || res.error?.message || '').trim()}`);
  }
  const parsed = parsePackJson(res.stdout);
  const files = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files;
  if (!Array.isArray(files)) {
    throw new Error(`npm pack --dry-run --json in ${repoDir} returned no file list`);
  }
  return files.map((f) => f?.path).filter((p) => typeof p === 'string' && p !== '');
}

// The release range: explicit --tag-range, else <last tag>..HEAD, else (a
// first release, no tag yet) the empty tree..HEAD with rootMode set so
// the commit log runs unbounded and the root commit is included. Null
// only for a repository with no commits at all.
function resolveRange(gitFn, repoDir, tagRange) {
  const head = gitRun(gitFn, repoDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.status !== 0) return null;
  if (tagRange !== null) {
    const parts = tagRange.split('..');
    if (tagRange.includes('...') || parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      throw new Error(`--tag-range must look like <from>..<to>, got: ${tagRange}`);
    }
    const [from, to] = parts;
    const end = gitRun(gitFn, repoDir, ['rev-parse', '--verify', `${to}^{commit}`]);
    if (end.status !== 0) {
      throw new Error(`--tag-range end "${to}" is not a commit: ${String(end.stderr || '').trim()}`);
    }
    // When the range ends away from HEAD, file contents are read from that
    // end commit — the audit must scan the state the range names, not the
    // worktree's.
    const readRef = String(end.stdout || '').trim() !== String(head.stdout || '').trim() ? to : null;
    return { from, to, rootMode: false, readRef };
  }
  const describe = gitRun(gitFn, repoDir, ['describe', '--tags', '--abbrev=0']);
  if (describe.status === 0) {
    const last = String(describe.stdout || '').trim();
    if (last) return { from: last, to: 'HEAD', rootMode: false, readRef: null };
  }
  return { from: EMPTY_TREE, to: 'HEAD', rootMode: true, readRef: null };
}

// Raw NUL-delimited paths, no quoting and no trimming: a file named
// " notes.md" or "quoté \"file\".js" must arrive exactly as git stores it.
function changedFiles(gitFn, repoDir, range) {
  let from = range.from;
  if (range.rootMode) {
    // A repository young enough to have no tag may not hold the empty-tree
    // object yet; write it so the diff has a revision to name.
    const wrote = gitRun(gitFn, repoDir, ['hash-object', '-w', '-t', 'tree', '--stdin'], { input: '' });
    if (wrote.status === 0) from = String(wrote.stdout || '').trim();
  }
  const res = gitRun(gitFn, repoDir, ['diff', '--name-only', '-z', '--no-renames', from, range.to]);
  if (res.status !== 0) {
    throw new Error(`git diff --name-only ${from}..${range.to} failed in ${repoDir}: ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '').split('\0').filter((p) => p !== '');
}

// Full bodies (%B), oldest first: squash merges fold PR bodies into public
// history, so a body line is as much the release surface as the subject.
function commitMessages(gitFn, repoDir, range) {
  const revs = range.rootMode ? [range.to] : [`${range.from}..${range.to}`];
  const res = gitRun(gitFn, repoDir, ['log', '--reverse', '--format=%h%x1f%B%x1e', ...revs]);
  if (res.status !== 0) {
    throw new Error(`git log ${revs[0]} failed in ${repoDir}: ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '').split('\x1e')
    .map((record) => {
      // git separates log entries with a newline even after %x1e.
      const rec = record.replace(/^[\r\n]+/, '');
      const sep = rec.indexOf('\x1f');
      if (sep < 0) return null;
      const sha = rec.slice(0, sep);
      const body = rec.slice(sep + 1).replace(/\s+$/, '');
      return sha && body ? { sha, body } : null;
    })
    .filter(Boolean);
}

// Auditing reads the worktree, so an uncommitted change would be scanned
// and then ship differently — refuse instead, naming the files.
function ensureCleanTree(gitFn, repoDir, repo, allowDirty) {
  const res = gitRun(gitFn, repoDir, ['status', '--porcelain']);
  if (res.status !== 0) {
    throw new Error(`git status --porcelain failed in ${repoDir}: ${String(res.stderr || '').trim()}`);
  }
  const lines = String(res.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length > 0 && !allowDirty) {
    throw new Error(`repo "${repo}" has uncommitted changes — pass --allow-dirty to audit anyway:\n${lines.join('\n')}`);
  }
}

// ~40 chars of context with the matched span masked, so a report shown to
// a human never reproduces the secret it found.
function maskedExcerpt(line, index, length) {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(line.length, index + length + CONTEXT_CHARS);
  const window = `${line.slice(start, index)}[match:${length} chars]${line.slice(index + length, end)}`;
  return `${start > 0 ? '...' : ''}${window}${end < line.length ? '...' : ''}`.trim();
}

function scanText(label, text, patterns, matches) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of patterns) {
      const hit = p.find(lines[i]);
      if (hit !== null) {
        matches.push({
          file: label, line: i + 1, pattern: p.raw,
          excerpt: maskedExcerpt(lines[i], hit.index, hit.length),
        });
      }
    }
  }
}

// Reading one candidate file from the worktree. deleted = gone from disk
// (a deletion in the range publishes nothing); anything else unreadable
// is reported, never silently dropped.
function classifyDiskRead(fileAbs) {
  let buf;
  try {
    buf = readFileSync(fileAbs);
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'deleted' };
    return { kind: 'unreadable', reason: err.code || err.message };
  }
  if (buf.includes(0)) return { kind: 'binary' };
  return { kind: 'text', text: buf.toString('utf8') };
}

// Reading one candidate file out of a commit (--tag-range ending away
// from HEAD). A file that came from npm's pack list but is not committed
// at that ref (a generated artifact, say) is reported rather than silent;
// one that came from the range diff simply does not exist there.
function classifyShowRead(gitFn, repoDir, ref, path, source) {
  const res = gitRun(gitFn, repoDir, ['show', `${ref}:${path}`]);
  if (res.status !== 0) {
    const err = String(res.stderr || '').trim();
    if (/does not exist|invalid path|exists on disk/i.test(err)) {
      return source === 'pack'
        ? { kind: 'unreadable', reason: `not present at ${ref}` }
        : { kind: 'deleted' };
    }
    return { kind: 'unreadable', reason: err || `git show ${ref}:${path} failed` };
  }
  const out = String(res.stdout || '');
  if (out.includes('\0')) return { kind: 'binary' };
  return { kind: 'text', text: out };
}

const VALUE_FLAGS = new Set(['--root', '--repo', '--tag-range']);
const BOOL_FLAGS = new Set(['--allow-dirty']);

function parseArgs(argv) {
  const args = { root: '.', repo: null, tagRange: null, allowDirty: false };
  const rest = argv.slice(2);
  const value = (i, flag) => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) {
      args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value(i, a);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(a)) {
      args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  if (!args.repo) throw new Error('--repo is required (the workspace repo itself is ".")');
  return args;
}

/**
 * Run one audit. `argv` is a process.argv-shaped array; `deps` is
 * injectable so tests can fake git and npm:
 *   { gitFn(cmd, args, opts), npmFn(cmd, args, opts) }
 * Resolves with { scanned, matches, skipped, skippedBinary, note? } —
 * note rides along only when nothing was configured. Throws on any
 * configuration or environment failure; the CLI maps a non-empty matches
 * to exit 1.
 */
function run(argv, deps = {}) {
  const d = { gitFn: spawnSync, npmFn: defaultNpmFn, ...deps };
  const args = parseArgs(argv);
  const rootDir = resolve(args.root);
  const ws = readWorkspace(rootDir);

  // A repo name is "." or a directory name under repos/ — never a path
  // (same shape task-pr.mjs accepts for its entries).
  const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
  if (args.repo !== WORKSPACE_REPO && (args.repo === '..' || !REPO_NAME_RE.test(args.repo))) {
    throw new Error(`invalid repo name: ${args.repo} — expected "." or a plain repo name`);
  }
  const repoDir = repoDirFor(rootDir, args.repo);
  if (!existsSync(repoDir)) {
    throw new Error(`no repo directory at ${repoDir} — is "${args.repo}" cloned?`);
  }

  const patterns = leakPatternsFor(ws, args.repo).map(compilePattern);
  if (patterns.length === 0) {
    return { scanned: 0, matches: [], skipped: [], skippedBinary: 0, note: 'no leak patterns configured' };
  }

  // Messages need a range even on the npm path, so git is probed first; a
  // directory that is not a git repo at all has no messages to leak.
  const isGit = gitRun(d.gitFn, repoDir, ['rev-parse', '--git-dir']).status === 0;
  if (isGit) ensureCleanTree(d.gitFn, repoDir, args.repo, args.allowDirty);
  const range = isGit ? resolveRange(d.gitFn, repoDir, args.tagRange) : null;

  // The surface is the union, de-duplicated, pack list first: npm knows
  // what ships but not what CI generates; the range knows what changed
  // but not what the tarball would exclude.
  const surface = [];
  if (isPublishedPackage(repoDir)) {
    for (const path of packFileList(d.npmFn, repoDir)) surface.push({ path, source: 'pack' });
  }
  if (range) {
    for (const path of changedFiles(d.gitFn, repoDir, range)) surface.push({ path, source: 'diff' });
  }
  const seen = new Set();
  const files = surface.filter((f) => (seen.has(f.path) ? false : seen.add(f.path)));

  const matches = [];
  const skipped = [];
  let scanned = 0;
  let skippedBinary = 0;
  for (const { path, source } of files) {
    const cls = range?.readRef
      ? classifyShowRead(d.gitFn, repoDir, range.readRef, path, source)
      : classifyDiskRead(join(repoDir, path));
    if (cls.kind === 'deleted') continue;
    if (cls.kind === 'binary') { skippedBinary += 1; continue; }
    if (cls.kind === 'unreadable') { skipped.push({ file: path, reason: cls.reason }); continue; }
    scanned += 1;
    scanText(path, cls.text, patterns, matches);
  }
  if (range) {
    for (const { sha, body } of commitMessages(d.gitFn, repoDir, range)) {
      scanned += 1;
      scanText(`commit ${sha}`, body, patterns, matches);
    }
  }
  return { scanned, matches, skipped, skippedBinary };
}

function main() {
  const out = run(process.argv);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = out.matches.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`release-leak-audit: ${err.message}\n`);
    process.exit(2);
  }
}

export { run, parseArgs };
