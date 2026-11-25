#!/usr/bin/env node
// Tests for release-leak-audit.mjs
// Run: node .claude/scripts/release-leak-audit.test.mjs
//
// Git runs for real under tmpdir (describe, diff, log, show — the parts
// users get), with one test also running a real `npm pack --dry-run` on a
// tiny fixture; every other npm call is a fake runner returning a canned
// pack list behind realistic notice noise. Every subprocess is an argv
// array, never a shell string.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, parseArgs } from './release-leak-audit.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}`); }
}
function assertEq(a, e, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(e);
  if (x === y) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}\n    expected: ${y}\n    actual:   ${x}`); }
}
function rejects(fn, msg, expect) {
  try { fn(); failed += 1; console.error(`  FAIL: ${msg} (did not throw)`); }
  catch (err) {
    if (expect && !String(err.message).includes(expect)) {
      failed += 1; console.error(`  FAIL: ${msg}\n    wanted substring: ${expect}\n    got:              ${err.message}`);
    } else { passed += 1; }
  }
}

// Isolate git config so a developer's global hooks/aliases cannot change
// behavior, and pin an identity so commits work with no user config.
const GIT_CFG = mkdtempSync(join(tmpdir(), 'leak-audit-git-cfg-'));
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(GIT_CFG, 'global'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', env: ENV });
  if (res.status !== 0) throw new Error(`git -C ${cwd} ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

const clean = (r) => rmSync(r, { recursive: true, force: true });

// A gitFn for run() that delegates to real git under the isolated config,
// matching the shape the script's own default gitFn has.
function gitWithEnv() {
  return (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', env: ENV, ...opts });
}

// The fixture's leak carriers, shared by every test so the expected match
// lists stay comparable across the git-range and npm-pack surfaces:
// - SK-LIVE… (uppercase) proves literal patterns match case-insensitively
// - JFROG-KEY-42 vs jfrog-key-7 proves regex flags are honored as written
//   (no i flag: the lowercase twin does not match)
// - local-notes.md line 2 is far longer than the excerpt context window
const CONFIG_JS = [
  '// deployed config',
  "const env = 'prod';",
  'const token = "SK-LIVE-abcdef1234567890";',
  'const registryKey = "JFROG-KEY-42";',
  'const lower = "jfrog-key-7";',
].join('\n') + '\n';
const LOCAL_NOTES = `scratch: internal-scratch\n${'N'.repeat(100)} sk-live-abcdef ${'M'.repeat(100)}\n`;
const LONG_MASKED = `...${'N'.repeat(39)} [match:14 chars] ${'M'.repeat(39)}...`;
const LOGO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), Buffer.from('PNG-ish payload\n')]);
const SUBJECT = 'feat: rotate the sk-live-abcdef token';

// The file name that makes git quote a path. A double quote is an ordinary
// byte in a POSIX file name; NTFS refuses to hold one at all, so on Windows
// the non-ASCII name alone plays the part — git quotes that one too.
const QUOTE_BAIT = process.platform === 'win32' ? 'quoté file.js' : 'quoté "file".js';

// A launcher root with one project repo under repos/app carrying the
// release range every test scans: a tagged base, a leak commit (config
// file, a git-only scratch file, a binary asset, a notes file — and a
// subject that leaks), then a clean tidy commit deleting the notes file.
// `pkg` adds a package.json at the base (an object as-is, so
// `private: true` is one field away); `tag` drops the v1.0.0 tag for the
// no-tags fallback; `weird` adds non-ASCII/quoted/space-leaden paths and
// a rename, proving raw -z paths and disabled rename detection;
// `baseFiles` ({ path: text }) are committed at the base alongside the
// README, so they sit unchanged in the release range; `repoRelease` and
// `wsRelease` merge extra keys (consumerFacing, say) into the repo-level
// and workspace-level `release` blocks.
function makeLauncher({
  pkg = null, repoPatterns = null, wsPatterns = null, tag = true, weird = false,
  baseFiles = {}, repoRelease = {}, wsRelease = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'leak-audit-'));
  const dir = join(root, 'repos', 'app');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  if (weird) mkdirSync(join(dir, 'data'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# app\n');
  if (pkg) writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeTree(dir, baseFiles);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  if (tag) git(dir, ['tag', 'v1.0.0']);

  writeFileSync(join(dir, 'lib', 'config.js'), CONFIG_JS);
  writeFileSync(join(dir, 'local-notes.md'), LOCAL_NOTES);
  writeFileSync(join(dir, 'notes.md'), 'plain notes\n');
  writeFileSync(join(dir, 'assets', 'logo.png'), LOGO);
  if (weird) {
    writeFileSync(join(dir, 'data', ' leading space.md'), 'space: sk-live-abcdef buried\n');
    writeFileSync(join(dir, 'data', QUOTE_BAIT), 'const q = "sk-live-abcdef-here";\n');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', SUBJECT]);
  const sha = git(dir, ['log', '-1', '--format=%h']).trim();

  git(dir, ['rm', '-q', 'notes.md']);
  git(dir, ['commit', '-q', '-m', 'chore: tidy']);
  if (weird) {
    git(dir, ['mv', 'local-notes.md', 'moved-notes.md']);
    git(dir, ['commit', '-q', '-m', 'chore: move notes']);
  }

  const config = { workspace: { name: 'fixture' }, repos: { app: { branch: 'main' } } };
  const wsBlock = { ...(wsPatterns ? { leakPatterns: wsPatterns } : {}), ...wsRelease };
  const repoBlock = { ...(repoPatterns ? { leakPatterns: repoPatterns } : {}), ...repoRelease };
  if (Object.keys(wsBlock).length > 0) config.workspace.release = wsBlock;
  if (Object.keys(repoBlock).length > 0) config.repos.app.release = repoBlock;
  writeFileSync(join(root, 'workspace.json'), JSON.stringify(config, null, 2));
  return { root, dir, sha };
}

// Write { relative/path: text } under dir, creating parent directories.
function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

// A launcher whose repos/app is an npm-workspaces monorepo. Tagged v1.0.0
// carries everything below; one root file changes after the tag, so the
// package READMEs are on the release surface only if packing finds them.
//   packages/a      public,  README holds MONO-LEAK-1
//   packages/b      private, README holds MONO-LEAK-1 as well
//   packages/c      public,  README holds MONO-LEAK-2
//   packages/tools  no package.json at all
function makeMonorepo({ workspaces = ['packages/*'], rootPrivate = true, patterns = ['MONO-LEAK-1'], repoRelease = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'leak-audit-mono-'));
  const dir = join(root, 'repos', 'app');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  const pkg = (name, extra = {}) => `${JSON.stringify({ name, version: '1.0.0', ...extra }, null, 2)}\n`;
  writeTree(dir, {
    'package.json': pkg('mono', { private: rootPrivate, workspaces }),
    'README.md': '# mono\n',
    'packages/a/package.json': pkg('@mono/a'),
    'packages/a/README.md': '# a\nsee MONO-LEAK-1 here\n',
    'packages/a/index.js': 'export const a = 1;\n',
    'packages/b/package.json': pkg('@mono/b', { private: true }),
    'packages/b/README.md': '# b\nsee MONO-LEAK-1 here\n',
    'packages/c/package.json': pkg('@mono/c'),
    'packages/c/README.md': '# c\nsee MONO-LEAK-2 here\n',
    'packages/tools/README.md': '# tools\n',
  });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  git(dir, ['tag', 'v1.0.0']);
  writeFileSync(join(dir, 'root-note.txt'), 'a note\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: note']);
  const release = { leakPatterns: patterns, ...repoRelease };
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({
    workspace: { name: 'fixture' },
    repos: { app: { branch: 'main', release } },
  }, null, 2));
  return { root, dir };
}

// A npmFn fake returning a canned pack file list behind the notice noise
// npm prints before its JSON, recording its calls so tests assert the argv
// array (never a shell string) and the cwd.
function fakeNpm(files, log = []) {
  return (cmd, args, opts = {}) => {
    log.push({ cmd, args, cwd: opts.cwd });
    return {
      status: 0,
      stdout: 'npm notice noise [with brackets] before the json\nnpm warn coverage not configured\n'
        + JSON.stringify([{ id: 'app@1.0.0', files: files.map((path) => ({ path, size: 10, mode: 420 })) }]),
      stderr: '',
    };
  };
}

// A npmFn fake answering per working directory — a monorepo has one pack
// list per package. A value is a file list, or { status, stderr } to fail
// that package; an unlisted cwd fails loudly, so a stray call (a private
// package, a directory with no package.json) surfaces in `skipped`.
function fakeNpmByCwd(byCwd, log = []) {
  return (cmd, args, opts = {}) => {
    const entry = byCwd[opts.cwd];
    if (entry === undefined) {
      log.push({ cmd, args, cwd: opts.cwd });
      return { status: 1, stdout: '', stderr: `unexpected cwd ${opts.cwd}` };
    }
    if (!Array.isArray(entry)) {
      log.push({ cmd, args, cwd: opts.cwd });
      return { status: entry.status, stdout: '', stderr: entry.stderr };
    }
    return fakeNpm(entry, log)(cmd, args, opts);
  };
}

// A gitFn fake that records calls and answers none of them — for tests
// asserting the fast path never reaches git.
function neverGit(log = []) {
  const fn = (cmd, args) => {
    log.push({ cmd, args });
    return { status: 1, stdout: '', stderr: 'not a git repo' };
  };
  fn.calls = log;
  return fn;
}

const audit = (root, extra = []) => ['node', 'release-leak-audit.mjs', '--root', root, '--repo', 'app', ...extra];

console.log('# parseArgs validation');
{
  rejects(() => parseArgs(['node', 's']), 'a repo is required', '--repo is required');
  rejects(() => parseArgs(['node', 's', '--repo', 'app', '--bogus']), 'unknown flag rejected', 'unknown argument');
  rejects(() => parseArgs(['node', 's', '--repo', '--root', '/w']), 'a flag value cannot be a flag', 'requires a value');
  rejects(() => parseArgs(['node', 's', '--tag-range', 'v1..v2']), 'tag-range without repo rejected', '--repo is required');
  const ok = parseArgs(['node', 's', '--root', '/w', '--repo', '.', '--tag-range', 'v1.0.0..HEAD', '--allow-dirty']);
  assertEq([ok.root, ok.repo, ok.tagRange, ok.allowDirty], ['/w', '.', 'v1.0.0..HEAD', true], 'flags map to camelCase values');
  assertEq(parseArgs(['node', 's', '--repo', 'app', '--allow-dirty']).allowDirty, true, '--allow-dirty stands alone');
  assertEq(parseArgs(['node', 's', '--repo', 'app']).root, '.', 'root defaults to the current directory');
  assertEq(parseArgs(['node', 's', '--repo', 'app']).allowDirty, false, 'the worktree must be clean by default');
  assertEq(parseArgs(['node', 's', '--repo', 'app']).listConsumerFacing, false, 'the scan is the default mode');
  assertEq(parseArgs(['node', 's', '--repo', 'app', '--list-consumer-facing']).listConsumerFacing, true,
    '--list-consumer-facing stands alone');
}

console.log('# no leak patterns configured: exit-0 fast path, nothing scanned');
{
  const { root } = makeLauncher();
  try {
    const gitCalls = [];
    const npmCalls = [];
    const out = run(audit(root), { gitFn: neverGit(gitCalls), npmFn: fakeNpm(['README.md'], npmCalls) });
    assertEq(out, { scanned: 0, matches: [], skipped: [], skippedBinary: 0, note: 'no leak patterns configured' },
      'the note rides along, nothing was scanned');
    assertEq(gitCalls.length, 0, 'git was never consulted');
    assertEq(npmCalls.length, 0, 'npm was never consulted');
  } finally { clean(root); }
}

console.log('# git-range path: literal and regex patterns, masked excerpts, skips counted');
{
  const { root, sha } = makeLauncher({ repoPatterns: ['sk-live-abcdef', '/JFROG-KEY-\\d+/'] });
  try {
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }); // would list nothing leaky — must not be used
    assertEq(out.matches, [
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "[match:14 chars]1234567890";' },
      { file: 'lib/config.js', line: 4, pattern: '/JFROG-KEY-\\d+/', excerpt: 'const registryKey = "[match:12 chars]";' },
      { file: 'local-notes.md', line: 2, pattern: 'sk-live-abcdef', excerpt: LONG_MASKED },
      { file: `commit ${sha}`, line: 1, pattern: 'sk-live-abcdef', excerpt: 'feat: rotate the [match:14 chars] token' },
    ], 'matches carry file, line, pattern, and a masked excerpt — never the secret');
    // Scanned = the two text files git changed (notes.md nets out of the
    // endpoint diff, logo.png is binary) plus the two commit messages.
    assertEq(out.scanned, 4, 'binary and deleted files are skipped, not scanned');
    assertEq(out.skippedBinary, 1, 'the binary asset is counted, not silently dropped');
    assertEq(out.skipped, [], 'nothing on this surface was unreadable');
  } finally { clean(root); }
}

console.log('# sticky patterns: lastIndex is reset, so every line is tested at position 0');
{
  const root = mkdtempSync(join(tmpdir(), 'leak-audit-sticky-'));
  try {
    const dir = join(root, 'repos', 'app');
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'README.md'), '# app\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: init']);
    git(dir, ['tag', 'v1.0.0']);
    writeFileSync(join(dir, 'sticky.txt'), 'KEY-alpha deployed\nKEY-beta staged\nKEY-gamma prod\nalso KEY-tail here\nnothing here\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: add sticky']);
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({
      workspace: { name: 'fixture' },
      repos: { app: { branch: 'main', release: { leakPatterns: ['/KEY/y'] } } },
    }, null, 2));
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches.map((m) => [m.file, m.line, m.excerpt]), [
      ['sticky.txt', 1, '[match:3 chars]-alpha deployed'],
      ['sticky.txt', 2, '[match:3 chars]-beta staged'],
      ['sticky.txt', 3, '[match:3 chars]-gamma prod'],
    ], 'three consecutive matches survive a sticky pattern; a non-initial KEY still does not match');
  } finally { clean(root); }
}

console.log('# npm pack path: pack list UNION changed files, noise-tolerant JSON, no scripts');
{
  const { root, sha } = makeLauncher({
    pkg: { name: 'app', version: '1.0.0' },
    repoPatterns: ['sk-live-abcdef', '/JFROG-KEY-\\d+/', 'internal-scratch'],
  });
  try {
    const npmCalls = [];
    const out = run(audit(root), {
      gitFn: gitWithEnv(),
      npmFn: fakeNpm(['README.md', 'lib/config.js', 'assets/logo.png', 'no-such.artifact'], npmCalls),
    });
    // Surface = pack list (README, config.js, logo.png, no-such.artifact)
    // union range changes (config.js, local-notes.md; notes.md nets out;
    // logo.png binary). The git-only scratch file IS scanned in npm mode.
    assertEq(out.matches, [
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "[match:14 chars]1234567890";' },
      { file: 'lib/config.js', line: 4, pattern: '/JFROG-KEY-\\d+/', excerpt: 'const registryKey = "[match:12 chars]";' },
      { file: 'local-notes.md', line: 1, pattern: 'internal-scratch', excerpt: 'scratch: [match:16 chars]' },
      { file: 'local-notes.md', line: 2, pattern: 'sk-live-abcdef', excerpt: LONG_MASKED },
      { file: `commit ${sha}`, line: 1, pattern: 'sk-live-abcdef', excerpt: 'feat: rotate the [match:14 chars] token' },
    ], 'the union scans packed files and changed files alike');
    assertEq(out.scanned, 5, 'README + config.js + local-notes.md + the two subjects were searched');
    assertEq(out.skippedBinary, 1, 'the packed binary is counted');
    assertEq(out.skipped, [], 'a pack entry that never existed on disk is a deletion, not a skip');
    assertEq(npmCalls.length, 1, 'npm pack ran once');
    assertEq(npmCalls[0].cmd, 'npm', 'npm is invoked by name');
    assertEq(npmCalls[0].args, ['pack', '--dry-run', '--ignore-scripts', '--json'],
      'npm args are an argv array, with scripts disabled');
    assertEq(npmCalls[0].cwd, join(root, 'repos', 'app'), 'npm pack ran in the repo directory');
  } finally { clean(root); }
}

console.log('# "private": true: the range carries the surface; npm is never consulted');
{
  const { root } = makeLauncher({
    pkg: { name: 'app', version: '1.0.0', private: true },
    repoPatterns: ['internal-scratch'],
  });
  try {
    const npmCalls = [];
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md'], npmCalls) });
    assertEq(out.matches, [
      { file: 'local-notes.md', line: 1, pattern: 'internal-scratch', excerpt: 'scratch: [match:16 chars]' },
    ], 'the git-only scratch file is the surface');
    assertEq(npmCalls.length, 0, 'a private package has no pack list to consult');
  } finally { clean(root); }
}

console.log('# workspace-wide patterns apply to every repo and dedupe against repo-level ones');
{
  const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'], wsPatterns: ['sk-live-abcdef', 'internal-scratch'] });
  try {
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches.filter((m) => m.file === 'lib/config.js'), [
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "[match:14 chars]1234567890";' },
    ], 'a pattern configured twice matches once');
    assert(out.matches.some((m) => m.file === 'local-notes.md' && m.pattern === 'internal-scratch'),
      'the workspace-wide pattern reached the repo');
  } finally { clean(root); }

  // A repo with no repo-level block gets the workspace patterns alone.
  const { root: root2 } = makeLauncher({ wsPatterns: ['internal-scratch'] });
  try {
    const out = run(audit(root2), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches.length, 1, 'a repo with only workspace-wide patterns is still audited');
  } finally { clean(root2); }
}

console.log('# --tag-range: explicit equals default, and bad ranges fail loudly');
{
  const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
  try {
    const explicit = run(audit(root, ['--tag-range', 'v1.0.0..HEAD']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    const implicit = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(explicit, implicit, 'an explicit v1.0.0..HEAD matches the default last-tag range');

    rejects(() => run(audit(root, ['--tag-range', 'v1.0.0']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
      'a range without .. rejected', 'must look like <from>..<to>');
    rejects(() => run(audit(root, ['--tag-range', 'v1.0.0..']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
      'an empty end rejected', 'must look like <from>..<to>');
    rejects(() => run(audit(root, ['--tag-range', 'v1.0.0...HEAD']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
      'a symmetric three-dot range rejected', 'must look like <from>..<to>');
    rejects(() => run(audit(root, ['--tag-range', 'v1.0.0..v9.9.9']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
      'an unknown end rejected', 'is not a commit');
    rejects(() => run(audit(root, ['--tag-range', 'v9.9.9..HEAD']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
      'an unknown start rejected', 'git diff --name-only v9.9.9..HEAD failed');
  } finally { clean(root); }
}

console.log('# no tags yet: every file at HEAD and the whole history, root commit included');
{
  const { root, sha } = makeLauncher({ repoPatterns: ['sk-live-abcdef'], tag: false });
  try {
    const dir = join(root, 'repos', 'app');
    const objectsBefore = git(dir, ['count-objects']).trim();
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    // The surface is ls-tree of HEAD (README.md now included; notes.md was
    // deleted so it is not at HEAD) and the log is unbounded, so the root
    // commit's message is scanned too — that is c1 "chore: init", no leak.
    assertEq(out.matches, [
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "[match:14 chars]1234567890";' },
      { file: 'local-notes.md', line: 2, pattern: 'sk-live-abcdef', excerpt: LONG_MASKED },
      { file: `commit ${sha}`, line: 1, pattern: 'sk-live-abcdef', excerpt: 'feat: rotate the [match:14 chars] token' },
    ], 'a first release scans everything that exists now');
    assertEq(out.scanned, 6, 'README + two leak files + three commit messages');
    assertEq(out.skippedBinary, 1, 'the binary asset still counted');
    assertEq(git(dir, ['count-objects']).trim(), objectsBefore,
      'a no-tag run writes nothing to the repository — the object count is unchanged');
  } finally { clean(root); }
}

console.log('# no tags, one commit: a root-commit-only leak is still caught');
{
  const root = mkdtempSync(join(tmpdir(), 'leak-audit-root-'));
  try {
    const dir = join(root, 'repos', 'app');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'lib', 'seed-token.js'), 'export const token = "sk-live-abcdef";\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: seed the sk-live-abcdef token']);
    const sha = git(dir, ['log', '-1', '--format=%h']).trim();
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({
      workspace: { name: 'fixture' },
      repos: { app: { branch: 'main', release: { leakPatterns: ['sk-live-abcdef'] } } },
    }, null, 2));
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches, [
      { file: 'lib/seed-token.js', line: 1, pattern: 'sk-live-abcdef', excerpt: 'export const token = "[match:14 chars]";' },
      { file: `commit ${sha}`, line: 1, pattern: 'sk-live-abcdef', excerpt: 'chore: seed the [match:14 chars] token' },
    ], 'a single-commit repo surfaces its file and its root commit message');
    assertEq(out.scanned, 2, 'one file + one message');
  } finally { clean(root); }
}

console.log('# raw -z paths: non-ASCII, quoted, and space-leading names; renames off');
{
  const { root, sha } = makeLauncher({ repoPatterns: ['sk-live-abcdef'], weird: true });
  try {
    const calls = [];
    const recordingGit = (cmd, args, opts) => {
      calls.push(args);
      return gitWithEnv()(cmd, args, opts);
    };
    const out = run(audit(root), { gitFn: recordingGit, npmFn: fakeNpm(['README.md']) });
    const diffCall = calls.find((a) => a.includes('diff'));
    assert(!!diffCall && diffCall.includes('-z') && diffCall.includes('--no-renames'),
      'the changed-file diff is NUL-delimited with rename detection off');
    assertEq(out.matches, [
      { file: 'data/ leading space.md', line: 1, pattern: 'sk-live-abcdef', excerpt: 'space: [match:14 chars] buried' },
      { file: `data/${QUOTE_BAIT}`, line: 1, pattern: 'sk-live-abcdef', excerpt: 'const q = "[match:14 chars]-here";' },
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "[match:14 chars]1234567890";' },
      { file: 'moved-notes.md', line: 2, pattern: 'sk-live-abcdef', excerpt: LONG_MASKED },
      { file: `commit ${sha}`, line: 1, pattern: 'sk-live-abcdef', excerpt: 'feat: rotate the [match:14 chars] token' },
    ], 'paths arrive raw — no quoting, no trimmed leading space — and the renamed file matches at its new path');
    assert(!out.matches.some((m) => m.file === 'local-notes.md'),
      'the pre-rename path published nothing at either endpoint');
    assertEq(out.skipped, [], 'no weird path was dropped as unreadable');
  } finally { clean(root); }
}

console.log('# an unreadable file is reported in skipped, never silently ignored');
{
  if (process.platform === 'win32') {
    console.log('  (skipped on win32 — chmod does not make files unreadable there)');
  } else {
    const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
    const cfg = join(root, 'repos', 'app', 'lib', 'config.js');
    chmodSync(cfg, 0o000);
    try {
      // chmod itself dirties the tree from git's view (it must open the
      // file to re-hash and cannot), so audit past that on purpose.
      const out = run(audit(root, ['--allow-dirty']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
      assertEq(out.skipped, [{ file: 'lib/config.js', reason: 'EACCES' }],
        'the unreadable file and its reason are reported');
      assertEq(out.scanned, 3, 'local-notes.md and the two messages were still searched');
      assertEq(out.matches.length, 2, 'local-notes.md:2 and the subject still match');
    } finally {
      chmodSync(cfg, 0o644);
      clean(root);
    }
  }
}

console.log('# a dirty worktree is refused unless --allow-dirty');
{
  const { root, sha } = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
  try {
    appendFileSync(join(root, 'repos', 'app', 'lib', 'config.js'), 'const dirty = "sk-live-abcdef-dirty";\n');
    let refused = null;
    try {
      run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    } catch (err) {
      refused = err;
    }
    assert(refused !== null, 'uncommitted changes refuse the audit');
    assert(refused !== null && String(refused.message).includes('lib/config.js')
      && String(refused.message).includes('--allow-dirty'),
      'the refusal names the file and the override');
    const out = run(audit(root, ['--allow-dirty']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches.map((m) => `${m.file}:${m.line}`), [
      'lib/config.js:3',
      'lib/config.js:6',
      'local-notes.md:2',
      `commit ${sha}:1`,
    ], '--allow-dirty audits the dirty disk as it stands');
  } finally { clean(root); }
}

console.log('# invalid pattern configuration fails loudly');
{
  const { root } = makeLauncher({ repoPatterns: [42] });
  try {
    rejects(() => run(audit(root)), 'non-string patterns rejected', 'must be an array of non-empty strings');
  } finally { clean(root); }
  const { root: root2 } = makeLauncher({ repoPatterns: 'sk-live' }); // a string, not an array
  try {
    rejects(() => run(audit(root2)), 'a bare string rejected', 'must be an array of non-empty strings');
  } finally { clean(root2); }
  const { root: root3 } = makeLauncher({ repoPatterns: ['/[/'] });
  try {
    rejects(() => run(audit(root3)), 'an unparseable regex rejected', 'not a valid regex');
  } finally { clean(root3); }
}

console.log('# full commit messages are scanned, squash-merge bodies included');
{
  const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
  try {
    const dir = join(root, 'repos', 'app');
    writeFileSync(join(dir, 'lib', 'extra.js'), 'export const x = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: body leak', '-m', 'details: the sk-live-abcdef rotation failed']);
    const sha4 = git(dir, ['log', '-1', '--format=%h']).trim();
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches.filter((m) => m.file === `commit ${sha4}`), [
      { file: `commit ${sha4}`, line: 3, pattern: 'sk-live-abcdef', excerpt: 'details: the [match:14 chars] rotation failed' },
    ], 'a body line matches with its line number inside the message');
    assertEq(out.scanned, 6, 'config, local-notes, extra.js, and three messages');
  } finally { clean(root); }
}

console.log('# --tag-range ending away from HEAD reads contents from that commit, not the disk');
{
  const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
  try {
    const dir = join(root, 'repos', 'app');
    writeFileSync(join(dir, 'lib', 'post-range.js'), 'const late = "sk-live-abcdef-post";\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: late work']);
    // Uncommitted disk change that would match if the disk were read.
    appendFileSync(join(dir, 'lib', 'config.js'), 'const diskOnly = "sk-live-abcdef-disk";\n');
    const out = run(audit(root, ['--tag-range', 'v1.0.0..HEAD~1', '--allow-dirty']),
      { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches.length, 3, 'exactly the range surface matches (config, local-notes, the leak subject)');
    assert(out.matches.every((m) => !m.excerpt.includes('disk') && !m.excerpt.includes('late')),
      'contents came from the range end commit — disk-only and post-range text never appear');
    assert(!out.matches.some((m) => m.file === 'lib/post-range.js'), 'files added after the range end are not scanned');
  } finally { clean(root); }
}

console.log('# the workspace repo "." reads the workspace block for its patterns');
{
  const root = mkdtempSync(join(tmpdir(), 'leak-audit-ws-'));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    writeFileSync(join(root, 'README.md'), '# launcher\n');
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({
      workspace: { name: 'fixture', release: { leakPatterns: ['marker-leak-77'] } },
      repos: {},
    }, null, 2));
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'chore: seed']);
    writeFileSync(join(root, 'secret.md'), 'the marker-leak-77 key lives here\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'feat: add the secret']);
    const out = run(['node', 'release-leak-audit.mjs', '--root', root, '--repo', '.'],
      { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    // No tag exists, so the range is the empty tree..HEAD: workspace.json
    // is part of the surface and honestly self-matches its own pattern
    // line; secret.md matches on its own line.
    assertEq(out.matches, [
      { file: 'secret.md', line: 1, pattern: 'marker-leak-77', excerpt: 'the [match:14 chars] key lives here' },
      { file: 'workspace.json', line: 6, pattern: 'marker-leak-77', excerpt: '"[match:14 chars]"' },
    ], 'the launcher itself is scanned, patterns file included');
    assertEq(out.scanned, 5, 'README + secret.md + workspace.json + two messages');
  } finally { clean(root); }
}

const PACK_ARGS = ['pack', '--dry-run', '--ignore-scripts', '--json'];
const PKG_FILES = ['README.md', 'package.json', 'index.js'];
const UNSUPPORTED = 'unsupported workspaces pattern — packages under it were not enumerated';
const pkgDir = (dir, name) => join(dir, 'packages', name);

console.log('# monorepo: each public workspace package is packed from its own directory');
{
  const { root, dir } = makeMonorepo();
  try {
    const a = pkgDir(dir, 'a');
    const c = pkgDir(dir, 'c');
    const npmCalls = [];
    const out = run(audit(root), {
      gitFn: gitWithEnv(),
      npmFn: fakeNpmByCwd({ [a]: PKG_FILES, [c]: PKG_FILES }, npmCalls),
    });
    assertEq(out.matches, [
      { file: 'packages/a/README.md', line: 2, pattern: 'MONO-LEAK-1', excerpt: 'see [match:11 chars] here' },
    ], 'the public package README is on the surface with a repo-relative path — and the private twin is not');
    assertEq(npmCalls.map((call) => call.cwd), [a, c],
      'npm ran in each public package directory, never in the private one or the plain directory');
    assert(npmCalls.every((call) => call.cmd === 'npm' && JSON.stringify(call.args) === JSON.stringify(PACK_ARGS)),
      'every pack is an argv array with scripts disabled');
    assertEq(out.skipped, [], 'nothing on this surface was unreadable or unenumerated');
    // a: README + package.json + index.js; c: README + package.json (its
    // packed index.js was never on disk — a deletion, not a read); then
    // root-note.txt from the range and the one post-tag message.
    assertEq(out.scanned, 7, 'both packages\' files, root-note.txt, and the post-tag message were searched');
  } finally { clean(root); }
}

console.log('# monorepo: yarn object form, exact entries, and a public root all enumerate');
{
  const yarn = makeMonorepo({ workspaces: { packages: ['packages/*'] } });
  try {
    const a = pkgDir(yarn.dir, 'a');
    const c = pkgDir(yarn.dir, 'c');
    const npmCalls = [];
    const out = run(audit(yarn.root), {
      gitFn: gitWithEnv(), npmFn: fakeNpmByCwd({ [a]: PKG_FILES, [c]: PKG_FILES }, npmCalls),
    });
    assertEq(out.matches.map((m) => m.file), ['packages/a/README.md'], 'the { packages: [...] } form is enumerated');
    assertEq(npmCalls.map((call) => call.cwd), [a, c], 'both public packages were packed');
  } finally { clean(yarn.root); }

  const exact = makeMonorepo({ workspaces: ['packages/a', './packages/c/'] });
  try {
    const a = pkgDir(exact.dir, 'a');
    const c = pkgDir(exact.dir, 'c');
    const npmCalls = [];
    const out = run(audit(exact.root), {
      gitFn: gitWithEnv(), npmFn: fakeNpmByCwd({ [a]: PKG_FILES, [c]: PKG_FILES }, npmCalls),
    });
    assertEq(out.matches.map((m) => m.file), ['packages/a/README.md'], 'exact directory entries are enumerated');
    assertEq(npmCalls.map((call) => call.cwd), [a, c], 'a leading ./ and a trailing / are normalized away');
    assertEq(out.skipped, [], 'exact entries are fully supported');
  } finally { clean(exact.root); }

  const open = makeMonorepo({ rootPrivate: false });
  try {
    const a = pkgDir(open.dir, 'a');
    const c = pkgDir(open.dir, 'c');
    const npmCalls = [];
    const out = run(audit(open.root), {
      gitFn: gitWithEnv(),
      npmFn: fakeNpmByCwd({ [open.dir]: ['README.md', 'package.json'], [a]: PKG_FILES, [c]: PKG_FILES }, npmCalls),
    });
    assertEq(npmCalls.map((call) => call.cwd), [open.dir, a, c], 'a public root is packed first, then its packages');
    assertEq(out.matches.map((m) => m.file), ['packages/a/README.md'], 'root paths stay unprefixed, package paths are prefixed');
  } finally { clean(open.root); }
}

console.log('# monorepo: unsupported workspaces patterns are reported, never silently missed');
{
  const { root, dir } = makeMonorepo({
    workspaces: ['packages/*', 'tools/**', '!packages/b', 'apps/{x,y}', '../outside', 42],
  });
  try {
    const a = pkgDir(dir, 'a');
    const c = pkgDir(dir, 'c');
    const out = run(audit(root), {
      gitFn: gitWithEnv(), npmFn: fakeNpmByCwd({ [a]: PKG_FILES, [c]: PKG_FILES }),
    });
    assertEq(out.skipped, [
      { file: 'tools/**', reason: UNSUPPORTED },
      { file: '!packages/b', reason: UNSUPPORTED },
      { file: 'apps/{x,y}', reason: UNSUPPORTED },
      { file: '../outside', reason: UNSUPPORTED },
      { file: '42', reason: UNSUPPORTED },
    ], 'every unsupported entry is listed with the reason, in declaration order');
    assertEq(out.matches.map((m) => m.file), ['packages/a/README.md'],
      'the supported pattern beside them is still enumerated and scanned');
  } finally { clean(root); }
}

console.log('# monorepo: one failing package pack is reported and the others are still scanned');
{
  const { root, dir } = makeMonorepo({ patterns: ['MONO-LEAK-1', 'MONO-LEAK-2'] });
  try {
    const a = pkgDir(dir, 'a');
    const c = pkgDir(dir, 'c');
    const out = run(audit(root), {
      gitFn: gitWithEnv(),
      npmFn: fakeNpmByCwd({ [a]: { status: 1, stderr: 'boom: registry unreachable' }, [c]: PKG_FILES }),
    });
    assertEq(out.skipped.length, 1, 'exactly the failing package is reported');
    assertEq(out.skipped[0].file, 'packages/a/', 'the skip names the package directory');
    assert(out.skipped[0].reason.startsWith('npm pack failed: ') && out.skipped[0].reason.includes('boom: registry unreachable'),
      'the skip carries npm\'s own explanation');
    assertEq(out.matches.map((m) => m.file), ['packages/c/README.md'],
      'the surviving package is scanned; the failed one contributes nothing from the pack list');
  } finally { clean(root); }

  // The root package keeps its loud failure: it is the release itself.
  const open = makeMonorepo({ rootPrivate: false });
  try {
    rejects(() => run(audit(open.root), {
      gitFn: gitWithEnv(), npmFn: fakeNpmByCwd({ [open.dir]: { status: 1, stderr: 'root boom' } }),
    }), 'a failing root pack still throws', 'npm pack --dry-run failed');
  } finally { clean(open.root); }
}

console.log('# release.consumerFacing: configured paths join the surface even when unchanged');
{
  const { root, dir } = makeLauncher({
    repoPatterns: ['docs-leak-9'],
    baseFiles: {
      'docs/guide.md': '# guide\nsee DOCS-LEAK-9 here\n',
      'docs/deep/more.md': 'DOCS-LEAK-9 again\n',
      'openapi.yaml': 'info: DOCS-LEAK-9\n',
      'unlisted.md': 'DOCS-LEAK-9 but not configured\n',
    },
    repoRelease: { consumerFacing: ['docs/', 'openapi.yaml', 'missing/', 'ABSENT.md'] },
  });
  try {
    const calls = [];
    const recordingGit = (cmd, args, opts) => { calls.push(args); return gitWithEnv()(cmd, args, opts); };
    const out = run(audit(root), { gitFn: recordingGit, npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches, [
      { file: 'docs/deep/more.md', line: 1, pattern: 'docs-leak-9', excerpt: '[match:11 chars] again' },
      { file: 'docs/guide.md', line: 2, pattern: 'docs-leak-9', excerpt: 'see [match:11 chars] here' },
      { file: 'openapi.yaml', line: 1, pattern: 'docs-leak-9', excerpt: 'info: [match:11 chars]' },
    ], 'a directory prefix and an exact path both reach the scan; an unconfigured unchanged file does not');
    assertEq(out.skipped, [
      { file: 'missing/', reason: 'release.consumerFacing entry matched no tracked file at HEAD' },
      { file: 'ABSENT.md', reason: 'release.consumerFacing entry matched no tracked file at HEAD' },
    ], 'configured entries that match nothing are reported — a typo must not read as a clean audit');
    const lsDocs = calls.find((a) => a.includes('ls-tree') && a.includes('docs/'));
    assertEq(lsDocs?.slice(2), ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'docs/'],
      'entries expand through a read-only, NUL-delimited git ls-tree argv at the range end');

    // The end ref is the range end, not the worktree: a file added after it is not listed.
    writeFileSync(join(dir, 'docs', 'late.md'), 'DOCS-LEAK-9 added after the range\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: late docs']);
    const early = run(audit(root, ['--tag-range', 'v1.0.0..HEAD~1']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assert(!early.matches.some((m) => m.file === 'docs/late.md'), 'configured entries expand at the range end commit');
    assertEq(early.matches.length, 3, 'the three configured hits are still found at the earlier end');
  } finally { clean(root); }

  const ws = makeLauncher({
    repoPatterns: ['docs-leak-9'],
    baseFiles: { 'docs/guide.md': 'DOCS-LEAK-9\n', 'faq.md': 'DOCS-LEAK-9\n' },
    repoRelease: { consumerFacing: ['docs/'] },
    wsRelease: { consumerFacing: ['faq.md', 'docs/'] },
  });
  try {
    const out = run(audit(ws.root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.matches.map((m) => m.file), ['docs/guide.md', 'faq.md'],
      'workspace-wide entries add to the repo-level ones and a path configured twice is scanned once');
  } finally { clean(ws.root); }
}

console.log('# release.consumerFacing: invalid entries fail loudly');
{
  for (const [label, bad] of [
    ['an absolute path', ['/abs/path']],
    ['a parent segment', ['../x']],
    ['a nested parent segment', ['docs/../../x']],
    ['an empty entry', ['']],
    ['a bare ./ that normalizes to nothing', ['./']],
    ['a bare . naming the whole repository', ['.']],
    ['a non-string entry', [7]],
    ['a bare string instead of an array', 'docs/'],
  ]) {
    const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'], repoRelease: { consumerFacing: bad } });
    try {
      rejects(() => run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
        `${label} is rejected`, 'repos.app.release.consumerFacing');
    } finally { clean(root); }
  }
  // Validated even when no patterns are configured: a typo must not wait for the first audit that needs it.
  const { root } = makeLauncher({ repoRelease: { consumerFacing: ['../x'] } });
  try {
    rejects(() => run(audit(root), { gitFn: neverGit(), npmFn: fakeNpm([]) }),
      'bad config is rejected before the no-patterns fast path', 'repos.app.release.consumerFacing');
  } finally { clean(root); }
  const { root: root2 } = makeLauncher({ wsRelease: { consumerFacing: '/abs' } });
  try {
    rejects(() => run(audit(root2), { gitFn: neverGit(), npmFn: fakeNpm([]) }),
      'the workspace-wide setting is validated too', 'workspace.release.consumerFacing');
  } finally { clean(root2); }
}

console.log('# --list-consumer-facing: prose and package.json on the surface, with no patterns configured');
{
  const { root, dir } = makeLauncher({
    pkg: { name: 'app', version: '1.0.0' },
    baseFiles: {
      'docs/guide.md': '# guide\n',
      'openapi.yaml': 'info: {}\n',
      'CONTRIBUTING.md': '# contributing\n',
    },
    repoRelease: { consumerFacing: ['docs/', 'openapi.yaml'] },
  });
  try {
    appendFileSync(join(dir, 'README.md'), 'a new section\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# changes\n');
    writeFileSync(join(dir, 'lib', 'x.js'), 'export const x = 1;\n');
    git(dir, ['rm', '-q', 'CONTRIBUTING.md']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'docs: update the prose']);
    const gitCalls = [];
    const recordingGit = (cmd, args, opts) => { gitCalls.push(args); return gitWithEnv()(cmd, args, opts); };
    const out = run(audit(root, ['--list-consumer-facing']), {
      gitFn: recordingGit,
      npmFn: fakeNpm(['README.md', 'package.json', 'CHANGELOG.md', 'CONTRIBUTING.md', 'lib/config.js']),
    });
    assertEq(out, {
      mode: 'consumer-facing',
      range: { from: 'v1.0.0', to: 'HEAD' },
      files: [
        { path: 'CHANGELOG.md', changed: true },
        { path: 'README.md', changed: true },
        { path: 'docs/guide.md', changed: false },
        { path: 'openapi.yaml', changed: false },
        { path: 'package.json', changed: false },
      ],
      skipped: [],
    }, 'prose basenames, package.json, and configured entries are listed with their changed flag — '
      + 'code files, deleted files, and a deleted-but-packed CONTRIBUTING.md are not');
    assert(gitCalls.every((a) => !a.includes('log')), 'listing never reads commit messages');
  } finally { clean(root); }

  // Patterns configured as well: listing mode never scans, it only lists.
  const both = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
  try {
    const out = run(audit(both.root, ['--list-consumer-facing']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.mode, 'consumer-facing', 'configured patterns do not switch listing mode off');
    assert(!('matches' in out), 'the listing carries no scan result');
  } finally { clean(both.root); }
}

console.log('# --list-consumer-facing: monorepo package files, binaries dropped, unreadable files reported');
{
  const { root, dir } = makeMonorepo({ patterns: [] });
  try {
    const a = pkgDir(dir, 'a');
    const c = pkgDir(dir, 'c');
    const out = run(audit(root, ['--list-consumer-facing']), {
      gitFn: gitWithEnv(),
      npmFn: fakeNpmByCwd({ [a]: [...PKG_FILES, 'README.png'], [c]: { status: 1, stderr: 'no pack' } }),
    });
    assertEq(out.files.map((f) => f.path), ['packages/a/README.md', 'packages/a/package.json'],
      'the package README and package.json are listed; code is not');
    assertEq(out.skipped.map((f) => f.file), ['packages/c/'], 'a package that failed to pack is reported, not lost');
  } finally { clean(root); }
}

console.log('# --list-consumer-facing: a dirty tree is refused unless --allow-dirty');
{
  const { root, dir } = makeLauncher();
  try {
    appendFileSync(join(dir, 'README.md'), 'uncommitted\n');
    rejects(() => run(audit(root, ['--list-consumer-facing']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
      'uncommitted changes refuse the listing', '--allow-dirty');
    const out = run(audit(root, ['--list-consumer-facing', '--allow-dirty']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.mode, 'consumer-facing', '--allow-dirty lists the dirty disk as it stands');
  } finally { clean(root); }
}

console.log('# --list-consumer-facing: a first release marks every listed file changed');
{
  const { root } = makeLauncher({
    pkg: { name: 'app', version: '1.0.0' }, tag: false,
    baseFiles: { 'docs/guide.md': '# guide\n' },
    repoRelease: { consumerFacing: ['docs/'] },
  });
  try {
    const out = run(audit(root, ['--list-consumer-facing']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md', 'package.json']) });
    assertEq(out.range, { from: null, to: 'HEAD' }, 'a first release has no from-end');
    assertEq(out.files, [
      { path: 'README.md', changed: true },
      { path: 'docs/guide.md', changed: true },
      { path: 'package.json', changed: true },
    ], 'with no previous tag everything is new');
  } finally { clean(root); }
}

console.log('# no patterns: the default mode still never consults git or npm, configured paths or not');
{
  const { root } = makeLauncher({ repoRelease: { consumerFacing: ['docs/'] } });
  try {
    const gitCalls = [];
    const npmCalls = [];
    const out = run(audit(root), { gitFn: neverGit(gitCalls), npmFn: fakeNpm(['README.md'], npmCalls) });
    assertEq(out.note, 'no leak patterns configured', 'the fast path is unchanged');
    assertEq([gitCalls.length, npmCalls.length], [0, 0], 'valid consumerFacing config costs the fast path nothing');
  } finally { clean(root); }
}

console.log('# real npm pack in a workspace package directory');
{
  const probe = process.platform === 'win32'
    ? spawnSync('npm.cmd', ['--version'], { encoding: 'utf-8', shell: true })
    : spawnSync('npm', ['--version'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    console.log('  (skipped — npm is not available)');
  } else {
    const { root } = makeMonorepo({ patterns: ['MONO-LEAK-1'] });
    try {
      // Only gitFn is injected: npmFn stays the script's own, so this runs a
      // real `npm pack --dry-run --ignore-scripts --json` in packages/a and
      // packages/c — with no node_modules installed, as in a release worktree.
      const out = run(audit(root), { gitFn: gitWithEnv() });
      assertEq(out.matches.map((m) => `${m.file}:${m.line}`), ['packages/a/README.md:2'],
        'the real pack list of the public package carries its README, prefixed repo-relative');
      assertEq(out.skipped, [], 'both real packs succeeded');
    } finally { clean(root); }
  }
}

console.log('# --list-consumer-facing: a version-only package.json bump is not a prose change');
{
  const pkg = { name: 'app', version: '1.0.0', description: 'The app' };
  const { root, dir } = makeLauncher({ pkg });
  try {
    const commitPkg = (text, message) => {
      writeFileSync(join(dir, 'package.json'), text);
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', message]);
    };
    const asJson = (next) => `${JSON.stringify(next, null, 2)}\n`;
    const listing = () => run(audit(root, ['--list-consumer-facing']),
      { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md', 'package.json']) });
    const changedOf = (out) => out.files.find((f) => f.path === 'package.json')?.changed;

    commitPkg(asJson({ ...pkg, version: '1.1.0' }), 'chore: release v1.1.0');
    assertEq(listing().files, [
      { path: 'README.md', changed: false },
      { path: 'package.json', changed: false },
    ], '/release\'s own version bump leaves every consumer-facing file unchanged, so the review is skipped');

    commitPkg(`﻿${asJson({ ...pkg, version: '1.1.1' })}`, 'chore: bump again');
    assertEq(changedOf(listing()), false, 'a BOM on the current file does not make a version-only bump look like a change');

    commitPkg(asJson({ ...pkg, version: '1.2.0', description: 'A different app' }), 'docs: reword');
    assertEq(changedOf(listing()), true, 'a description change alongside the bump is a consumer-facing change');

    commitPkg('{ "name": "app", "version": \n', 'chore: broken json');
    assertEq(changedOf(listing()), true, 'a package.json that does not parse counts as changed');
  } finally { clean(root); }

  // No package.json at the previous tag: it is new, so it is changed.
  const fresh = makeLauncher();
  try {
    writeFileSync(join(fresh.dir, 'package.json'), `${JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2)}\n`);
    git(fresh.dir, ['add', '-A']);
    git(fresh.dir, ['commit', '-q', '-m', 'feat: add a package manifest']);
    const out = run(audit(fresh.root, ['--list-consumer-facing']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['package.json']) });
    assertEq(out.files.find((f) => f.path === 'package.json')?.changed, true, 'a package.json absent at the previous tag counts as changed');
  } finally { clean(fresh.root); }

  // The same rule holds for every workspace package and the root, bumped together.
  const mono = makeMonorepo({ patterns: [] });
  try {
    const bump = (rel, version) => {
      const file = join(mono.dir, rel);
      const next = JSON.parse(readFileSync(file, 'utf8'));
      next.version = version;
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    };
    bump('package.json', '1.1.0');
    bump('packages/a/package.json', '1.1.0');
    bump('packages/c/package.json', '1.1.0');
    git(mono.dir, ['add', '-A']);
    git(mono.dir, ['commit', '-q', '-m', 'chore: release v1.1.0']);
    const out = run(audit(mono.root, ['--list-consumer-facing']), {
      gitFn: gitWithEnv(),
      npmFn: fakeNpmByCwd({ [pkgDir(mono.dir, 'a')]: PKG_FILES, [pkgDir(mono.dir, 'c')]: PKG_FILES }),
    });
    assert(out.files.length > 0 && out.files.every((f) => f.changed === false),
      'a monorepo release bump leaves root and package manifests unchanged');
    assertEq(out.files.map((f) => f.path), [
      'package.json', 'packages/a/README.md', 'packages/a/package.json', 'packages/c/README.md', 'packages/c/package.json',
    ], 'the bumped manifests are still listed, just not as changed');
  } finally { clean(mono.root); }
}

console.log('# monorepo: a symlinked package directory is followed');
if (process.platform === 'win32') {
  console.log('  (skipped on win32 — creating a symlink needs privileges there)');
} else {
  const { root, dir } = makeMonorepo({ patterns: ['MONO-LEAK-1'] });
  try {
    symlinkSync('a', join(dir, 'packages', 'linked'), 'dir');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: link a package']);
    // The link belongs to the base, not the release range: a symlink that
    // changed in the range would be listed by the diff as a file and read
    // through to its directory (EISDIR), which is a different question.
    git(dir, ['tag', '-f', 'v1.0.0']);
    const [a, c, linked] = ['a', 'c', 'linked'].map((n) => pkgDir(dir, n));
    const npmCalls = [];
    const out = run(audit(root), {
      gitFn: gitWithEnv(),
      npmFn: fakeNpmByCwd({ [a]: PKG_FILES, [c]: PKG_FILES, [linked]: PKG_FILES }, npmCalls),
    });
    assertEq(npmCalls.map((call) => call.cwd), [a, c, linked], 'the symlinked directory is packed like any other package');
    assert(out.matches.some((m) => m.file === 'packages/linked/README.md'), 'its files are on the surface');
    assertEq(out.skipped, [], 'nothing was dropped');
  } finally { clean(root); }
}

console.log('# monorepo: a UTF-8 BOM on a package.json does not hide the package');
{
  const BOM = '﻿';
  const rewriteWithBom = (dir, rel) => {
    const file = join(dir, rel);
    writeFileSync(file, `${BOM}${readFileSync(file, 'utf8')}`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `chore: bom ${rel}`]);
  };

  const pkgBom = makeMonorepo({ patterns: ['MONO-LEAK-2'] });
  try {
    rewriteWithBom(pkgBom.dir, 'packages/c/package.json');
    const [a, c] = ['a', 'c'].map((n) => pkgDir(pkgBom.dir, n));
    const npmCalls = [];
    const out = run(audit(pkgBom.root), {
      gitFn: gitWithEnv(), npmFn: fakeNpmByCwd({ [a]: PKG_FILES, [c]: PKG_FILES }, npmCalls),
    });
    assertEq(npmCalls.map((call) => call.cwd), [a, c], 'a package whose manifest starts with a BOM is still enumerated');
    assertEq(out.matches.map((m) => m.file), ['packages/c/README.md'], 'and scanned');
    assertEq(out.skipped, [], 'it was not reported as unreadable either');
  } finally { clean(pkgBom.root); }

  // A BOM'd root: a public one is still packed, and either kind still names its workspaces.
  for (const rootPrivate of [false, true]) {
    const rootBom = makeMonorepo({ rootPrivate, patterns: ['MONO-LEAK-1'] });
    try {
      rewriteWithBom(rootBom.dir, 'package.json');
      const [a, c] = ['a', 'c'].map((n) => pkgDir(rootBom.dir, n));
      const npmCalls = [];
      run(audit(rootBom.root), {
        gitFn: gitWithEnv(),
        npmFn: fakeNpmByCwd({ [rootBom.dir]: ['README.md'], [a]: PKG_FILES, [c]: PKG_FILES }, npmCalls),
      });
      assertEq(npmCalls.map((call) => call.cwd), rootPrivate ? [a, c] : [rootBom.dir, a, c],
        `a BOM'd ${rootPrivate ? 'private' : 'public'} root is read correctly: ${rootPrivate ? 'not packed' : 'packed'}, packages enumerated`);
    } finally { clean(rootBom.root); }
  }
}

console.log('# monorepo: a workspace that cannot be read as a package is reported, not dropped');
{
  const { root, dir } = makeMonorepo({
    workspaces: ['packages/*', 'packages/tools', 'packages/nope', 'apps/*'],
  });
  try {
    writeTree(dir, { 'packages/broken/package.json': '{ not json\n' });
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'chore: broken manifest']);
    const [a, c] = ['a', 'c'].map((n) => pkgDir(dir, n));
    const npmCalls = [];
    const out = run(audit(root), {
      gitFn: gitWithEnv(), npmFn: fakeNpmByCwd({ [a]: PKG_FILES, [c]: PKG_FILES }, npmCalls),
    });
    assertEq(out.skipped, [
      { file: 'packages/broken/', reason: 'package.json is not valid JSON' },
      { file: 'packages/tools/', reason: 'no package.json found' },
      { file: 'packages/nope/', reason: 'no package.json found' },
      { file: 'apps/', reason: 'workspaces directory not found' },
    ], 'an unparseable manifest, exact entries with no manifest, and a missing /* base are each reported; '
      + 'a plain directory under a /* entry (packages/tools there) is not a package and stays quiet');
    assertEq(npmCalls.map((call) => call.cwd), [a, c], 'none of them was packed');
  } finally { clean(root); }
}

console.log('# release.consumerFacing: an entry that matches nothing is reported and never fails the audit');
{
  const { root } = makeLauncher({
    repoPatterns: ['no-such-pattern-anywhere'],
    repoRelease: { consumerFacing: ['nothing-here/'] },
  });
  try {
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(out.skipped, [
      { file: 'nothing-here/', reason: 'release.consumerFacing entry matched no tracked file at HEAD' },
    ], 'the entry is reported with the ref it was looked up at');
    assertEq(out.matches, [], 'and it is informational: nothing matched');
    const listed = run(audit(root, ['--list-consumer-facing']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(listed.skipped.map((f) => f.file), ['nothing-here/'], 'the listing reports it too');
    const script = join(dirname(fileURLToPath(import.meta.url)), 'release-leak-audit.mjs');
    const cli = spawnSync(process.execPath, [script, '--root', root, '--repo', 'app'], { encoding: 'utf-8', env: ENV });
    assertEq(cli.status, 0, 'a skipped entry never changes the exit code');
  } finally { clean(root); }
}

console.log('# --tag-range ends that look like options are refused before git sees them');
{
  const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
  try {
    for (const [side, range] of [['from', '-U5..HEAD'], ['to', 'v1.0.0..-U5']]) {
      for (const extra of [[], ['--list-consumer-facing']]) {
        const calls = [];
        const recordingGit = (cmd, args, opts) => { calls.push(args); return gitWithEnv()(cmd, args, opts); };
        rejects(() => run(audit(root, ['--tag-range', range, ...extra]), { gitFn: recordingGit, npmFn: fakeNpm(['README.md']) }),
          `a ${side} side that starts with - is rejected`, 'must name commits, not options');
        assert(!calls.some((a) => a.includes('diff') || a.includes('log')),
          `no diff or log ran with the ${side} side — git never saw it as an option`);
      }
    }
  } finally { clean(root); }
}

console.log('# CLI: exit 1 on matches, 0 unconfigured, 2 on error');
{
  const script = join(dirname(fileURLToPath(import.meta.url)), 'release-leak-audit.mjs');
  const hit = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
  const none = makeLauncher();
  try {
    const bad = spawnSync(process.execPath, [script, '--root', hit.root, '--repo', 'app'], { encoding: 'utf-8', env: ENV });
    assertEq(bad.status, 1, 'matches exit 1');
    const parsed = JSON.parse(bad.stdout);
    assertEq(parsed.matches.length, 3, 'stdout is the JSON result');
    assertEq(typeof parsed.skippedBinary, 'number', 'the JSON reports the binary-skip count');
    assertEq(parsed.skipped, [], 'the JSON reports the skipped list');

    const ok = spawnSync(process.execPath, [script, '--root', none.root, '--repo', 'app'], { encoding: 'utf-8', env: ENV });
    assertEq(ok.status, 0, 'no patterns exit 0');
    assertEq(JSON.parse(ok.stdout).note, 'no leak patterns configured', 'the note prints on stdout');

    const err = spawnSync(process.execPath, [script, '--root', none.root], { encoding: 'utf-8', env: ENV });
    assertEq(err.status, 2, 'a missing --repo exits 2');
    assert(String(err.stderr || '').startsWith('release-leak-audit:'), 'stderr names the script');

    // Listing mode reports, it does not judge: exit 0 even where the scan would exit 1 or note nothing.
    const listed = spawnSync(process.execPath, [script, '--root', hit.root, '--repo', 'app', '--list-consumer-facing'],
      { encoding: 'utf-8', env: ENV });
    assertEq(listed.status, 0, '--list-consumer-facing exits 0 on success');
    assertEq(JSON.parse(listed.stdout).mode, 'consumer-facing', 'the listing prints on stdout');
    const listedNone = spawnSync(process.execPath, [script, '--root', none.root, '--repo', 'app', '--list-consumer-facing'],
      { encoding: 'utf-8', env: ENV });
    assertEq(listedNone.status, 0, 'the listing works with no patterns configured');
  } finally { clean(hit.root); clean(none.root); }
}

console.log('# real npm pack: --ignore-scripts --json on a tiny fixture');
{
  const probe = process.platform === 'win32'
    ? spawnSync('npm.cmd', ['--version'], { encoding: 'utf-8', shell: true })
    : spawnSync('npm', ['--version'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    console.log('  (skipped — npm is not available)');
  } else {
    const root = mkdtempSync(join(tmpdir(), 'leak-audit-npm-'));
    try {
      const dir = join(root, 'repos', 'app');
      mkdirSync(join(dir, 'lib'), { recursive: true });
      git(dir, ['init', '-q', '-b', 'main']);
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2)}\n`);
      writeFileSync(join(dir, 'README.md'), '# app\n');
      writeFileSync(join(dir, 'lib', 'real-npm.js'), 'export const marker = "NPMREAL-LEAK-42";\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', 'chore: init']);
      git(dir, ['tag', 'v1.0.0']);
      writeFileSync(join(dir, 'lib', 'real-npm.js'), 'export const marker = "NPMREAL-LEAK-42";\nexport const two = 2;\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', 'feat: real npm surface']);
      writeFileSync(join(root, 'workspace.json'), JSON.stringify({
        workspace: { name: 'fixture' },
        repos: { app: { branch: 'main', release: { leakPatterns: ['npmreal-leak-42'] } } },
      }, null, 2));
      // Only gitFn is injected — npmFn stays the script's own, so this runs
      // a real `npm pack --dry-run --ignore-scripts --json`.
      const out = run(audit(root), { gitFn: gitWithEnv() });
      assertEq(out.matches, [
        { file: 'lib/real-npm.js', line: 1, pattern: 'npmreal-leak-42', excerpt: 'export const marker = "[match:15 chars]";' },
      ], 'the real pack list carries the leaky file');
      assertEq(out.skippedBinary, 0, 'no binary in this fixture');
      assertEq(out.skipped, [], 'every packed file was readable');
      assertEq(out.scanned, 4, 'README + real-npm.js + package.json + the one post-tag message');
    } finally { clean(root); }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
