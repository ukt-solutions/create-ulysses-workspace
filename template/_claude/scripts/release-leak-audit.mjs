#!/usr/bin/env node
// Release leak audit (gh:203): scan exactly what a release would publish
// against the leak patterns the workspace configured, before the tag is
// pushed and the publish becomes permanent.
//
// /release keeps the process honest — the bump rides a PR, the tag marks
// the merge — but no step of it looks at content. A credential pasted into
// a shipped file or a commit subject is public from the moment the tag is
// pushed, and deleting a tag does not unpublish a tarball or a clone
// somebody already fetched. This script is the optional content gate: it
// resolves the release surface — the npm pack file list for a publishable
// package, else the files changed in the tag range — plus the release's
// commit subjects (they ride the pushed history and the release notes),
// and matches every text line against the configured patterns.
//
// It is opt-in: with no patterns configured it exits 0 having scanned
// nothing, so workspaces that never configure any keep the release flow
// they had. And it never edits anything — on a match it reports
// { file, line, pattern, excerpt } and exits 1. Whether a match is a true
// leak, an over-broad pattern, or a release to redo is the operator's
// decision, made before the tag exists.
//
// Patterns (workspace.json, arrays of strings):
//   repos.{repo}.release.leakPatterns   this repo alone
//   workspace.release.leakPatterns      every repo — and, as with
//                                       repos.{repo}.merge, the workspace
//                                       repo "." itself reads this block
// A pattern written "/body/flags" (flags from d g i m s u v y) is that
// regex; any other string is a case-insensitive literal. Restricting the
// flag charset is what lets slashed literals exist at all: "/data/keys"
// ends in a tail that is not a flags run, so it stays a literal, while
// "/data/keys/" is the regex "data/keys". Scanning is line-based; `g` in
// flags is ignored (each line is tested independently).
//
// Usage:
//   node release-leak-audit.mjs --root <launcher> --repo <repo>
//                               [--tag-range <from>..<to>]
//
// --tag-range overrides the range that otherwise defaults to
// <last tag>..HEAD — the whole history from the root commit when no tag
// exists yet (a first release has a surface too). It bounds both the
// changed-file list and the commit subjects.
//
// Output on stdout: { scanned: N, matches: [{ file, line, pattern,
// excerpt }] } — scanned counts the text files and commit subjects
// actually searched; binary files (a NUL byte — git's own heuristic) and
// unreadable ones (deleted in the range) are skipped. Exit codes:
// 0 — clean, or nothing configured; 1 — matches found; 2 — configuration
// or environment error before anything was scanned.

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
const EXCERPT_MAX = 160;

// npm on Windows is npm.cmd, which spawnSync cannot execute without a
// shell. The args are fixed flags with no interpolated value, so the
// joined command line stays honest — the same shape lib/payload.mjs uses.
function defaultNpmFn(cmd, args, opts = {}) {
  if (process.platform !== 'win32') return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return spawnSync('npm.cmd', args.map((a) => `"${a}"`), { shell: true, encoding: 'utf8', ...opts });
}

function gitRun(gitFn, repoDir, args) {
  const res = gitFn('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`git: ${res.error.message}`);
  return res;
}

// Compile one configured pattern. The regex form is only the full
// /body/flags shape with known flags; everything else is a literal, so a
// slashed string whose tail is not a flags run ("/data/keys") still works
// as the path literal its author meant.
const REGEX_FORM = /^\/(.+)\/([dgimsuvy]*)$/;

function compilePattern(raw) {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`leak patterns must be non-empty strings, got: ${JSON.stringify(raw)}`);
  }
  const m = raw.match(REGEX_FORM);
  if (!m) {
    const needle = raw.toLowerCase();
    return { raw, test: (line) => line.toLowerCase().includes(needle) };
  }
  // `g` would make .test stateful across lines; distinct flags only.
  const flags = [...new Set(m[2])].filter((f) => f !== 'g').join('');
  try {
    const re = new RegExp(m[1], flags);
    return { raw, test: (line) => re.test(line) };
  } catch (err) {
    throw new Error(`leak pattern ${JSON.stringify(raw)} is not a valid regex: ${err.message}`);
  }
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
// publish — its pack list is the release surface. Anything else (no
// package.json, private, or a file that does not parse) publishes through
// git alone, so the tag range is the surface instead.
function isPublishedPackage(repoDir) {
  const pkgPath = join(repoDir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8'))?.private !== true;
  } catch {
    return false;
  }
}

function packFileList(npmFn, repoDir) {
  const res = npmFn('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoDir, encoding: 'utf8', timeout: NPM_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`npm pack --dry-run failed in ${repoDir}: ${String(res.stderr || res.error?.message || '').trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(res.stdout || ''));
  } catch (err) {
    throw new Error(`npm pack --dry-run --json in ${repoDir} printed unparseable output: ${err.message}`);
  }
  const files = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files;
  if (!Array.isArray(files)) {
    throw new Error(`npm pack --dry-run --json in ${repoDir} returned no file list`);
  }
  return files.map((f) => f?.path).filter((p) => typeof p === 'string' && p !== '');
}

// The release range: explicit --tag-range, else the last tag..HEAD, else
// (a first release, no tag yet) the root commit..HEAD. Null only for a
// repository with no commits at all.
function resolveRange(gitFn, repoDir, tagRange) {
  if (tagRange !== null) {
    if (!tagRange.includes('..')) {
      throw new Error(`--tag-range must look like <from>..<to>, got: ${tagRange}`);
    }
    return tagRange;
  }
  const describe = gitRun(gitFn, repoDir, ['describe', '--tags', '--abbrev=0']);
  if (describe.status === 0) {
    const last = String(describe.stdout || '').trim();
    if (last) return `${last}..HEAD`;
  }
  const root = gitRun(gitFn, repoDir, ['rev-list', '--max-parents=0', 'HEAD']);
  const first = String(root.status === 0 ? root.stdout || '' : '').split(/\r?\n/).find((l) => l.trim() !== '');
  return first ? `${first.trim()}..HEAD` : null;
}

function changedFiles(gitFn, repoDir, range) {
  const res = gitRun(gitFn, repoDir, ['diff', '--name-only', range]);
  if (res.status !== 0) {
    throw new Error(`git diff --name-only ${range} failed in ${repoDir}: ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
}

// Oldest first (--reverse), the order the release itself tells its story
// in. A match lands as file "commit <short-sha>", line 1 — the subject is
// one line by construction.
function commitSubjects(gitFn, repoDir, range) {
  const res = gitRun(gitFn, repoDir, ['log', '--reverse', '--format=%h %s', range]);
  if (res.status !== 0) {
    throw new Error(`git log ${range} failed in ${repoDir}: ${String(res.stderr || '').trim()}`);
  }
  return String(res.stdout || '').split(/\r?\n/).filter((l) => l.trim() !== '')
    .map((l) => {
      const sp = l.indexOf(' ');
      return sp > 0 ? { sha: l.slice(0, sp), subject: l.slice(sp + 1) } : null;
    })
    .filter(Boolean);
}

// Read one candidate file as text, or null when it cannot be searched:
// missing (deleted in the range), a directory, unreadable, or binary — a
// NUL byte anywhere means there is no text line to match, and decoding it
// would only produce garbage excerpts.
function readTextIfText(fileAbs) {
  let buf;
  try {
    buf = readFileSync(fileAbs);
  } catch {
    return null;
  }
  return buf.includes(0) ? null : buf.toString('utf8');
}

function scanText(label, text, patterns, matches) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of patterns) {
      if (p.test(lines[i])) {
        matches.push({ file: label, line: i + 1, pattern: p.raw, excerpt: lines[i].trim().slice(0, EXCERPT_MAX) });
      }
    }
  }
}

const VALUE_FLAGS = new Set(['--root', '--repo', '--tag-range']);

function parseArgs(argv) {
  const args = { root: '.', repo: null, tagRange: null };
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
    throw new Error(`unknown argument: ${a}`);
  }
  if (!args.repo) throw new Error('--repo is required (the workspace repo itself is ".")');
  return args;
}

/**
 * Run one audit. `argv` is a process.argv-shaped array; `deps` is
 * injectable so tests can fake git and npm:
 *   { gitFn(cmd, args, opts), npmFn(cmd, args, opts) }
 * Resolves with { scanned, matches, note? } — note rides along only when
 * nothing was configured. Throws on any configuration or environment
 * failure; the CLI maps a non-empty matches to exit 1.
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
    return { scanned: 0, matches: [], note: 'no leak patterns configured' };
  }

  // Subjects need a range even on the npm path, so git is probed first; a
  // directory that is not a git repo at all has no subjects to leak.
  const isGit = gitRun(d.gitFn, repoDir, ['rev-parse', '--git-dir']).status === 0;
  const range = isGit ? resolveRange(d.gitFn, repoDir, args.tagRange) : null;

  const files = isPublishedPackage(repoDir)
    ? packFileList(d.npmFn, repoDir)
    : range ? changedFiles(d.gitFn, repoDir, range) : [];

  const matches = [];
  let scanned = 0;
  for (const rel of files) {
    const text = readTextIfText(join(repoDir, rel));
    if (text === null) continue;
    scanned += 1;
    scanText(rel, text, patterns, matches);
  }
  if (range) {
    for (const { sha, subject } of commitSubjects(d.gitFn, repoDir, range)) {
      scanned += 1;
      scanText(`commit ${sha}`, subject, patterns, matches);
    }
  }
  return { scanned, matches };
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
