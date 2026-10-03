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
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, rmSync } from 'node:fs';
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

// A launcher root with one project repo under repos/app carrying the
// release range every test scans: a tagged base, a leak commit (config
// file, a git-only scratch file, a binary asset, a notes file — and a
// subject that leaks), then a clean tidy commit deleting the notes file.
// `pkg` adds a package.json at the base (an object as-is, so
// `private: true` is one field away); `tag` drops the v1.0.0 tag for the
// no-tags fallback; `weird` adds non-ASCII/quoted/space-leaden paths and
// a rename, proving raw -z paths and disabled rename detection.
function makeLauncher({ pkg = null, repoPatterns = null, wsPatterns = null, tag = true, weird = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'leak-audit-'));
  const dir = join(root, 'repos', 'app');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  if (weird) mkdirSync(join(dir, 'data'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# app\n');
  if (pkg) writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: init']);
  if (tag) git(dir, ['tag', 'v1.0.0']);

  writeFileSync(join(dir, 'lib', 'config.js'), CONFIG_JS);
  writeFileSync(join(dir, 'local-notes.md'), LOCAL_NOTES);
  writeFileSync(join(dir, 'notes.md'), 'plain notes\n');
  writeFileSync(join(dir, 'assets', 'logo.png'), LOGO);
  if (weird) {
    writeFileSync(join(dir, 'data', ' leading space.md'), 'space: sk-live-abcdef buried\n');
    writeFileSync(join(dir, 'data', 'quoté "file".js'), 'const q = "sk-live-abcdef-here";\n');
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
  if (wsPatterns) config.workspace.release = { leakPatterns: wsPatterns };
  if (repoPatterns) config.repos.app.release = { leakPatterns: repoPatterns };
  writeFileSync(join(root, 'workspace.json'), JSON.stringify(config, null, 2));
  return { root, dir, sha };
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

console.log('# no tags yet: the empty tree and the whole history, root commit included');
{
  const { root, sha } = makeLauncher({ repoPatterns: ['sk-live-abcdef'], tag: false });
  try {
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    // The diff runs against the empty tree (README.md now included; notes.md
    // still nets out) and the log is unbounded, so the root commit's
    // message is scanned too — that is c1 "chore: init", no leak.
    assertEq(out.matches, [
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "[match:14 chars]1234567890";' },
      { file: 'local-notes.md', line: 2, pattern: 'sk-live-abcdef', excerpt: LONG_MASKED },
      { file: `commit ${sha}`, line: 1, pattern: 'sk-live-abcdef', excerpt: 'feat: rotate the [match:14 chars] token' },
    ], 'a first release scans everything that exists now');
    assertEq(out.scanned, 6, 'README + two leak files + three commit messages');
    assertEq(out.skippedBinary, 1, 'the binary asset still counted');
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
      { file: 'data/quoté "file".js', line: 1, pattern: 'sk-live-abcdef', excerpt: 'const q = "[match:14 chars]-here";' },
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
