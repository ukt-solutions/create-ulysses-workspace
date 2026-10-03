#!/usr/bin/env node
// Tests for release-leak-audit.mjs
// Run: node .claude/scripts/release-leak-audit.test.mjs
//
// Git runs for real under tmpdir (describe, diff, log — the parts users
// get); npm is always a fake runner returning a canned pack list, so the
// npm-path tests assert the surface selection without a registry or a
// real pack. Every subprocess is an argv array, never a shell string.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
// - local-notes.md line 2 is longer than the excerpt cap
const CONFIG_JS = [
  '// deployed config',
  "const env = 'prod';",
  'const token = "SK-LIVE-abcdef1234567890";',
  'const registryKey = "JFROG-KEY-42";',
  'const lower = "jfrog-key-7";',
].join('\n') + '\n';
const LOCAL_NOTES = `scratch: internal-scratch\n${'N'.repeat(100)} sk-live-abcdef ${'M'.repeat(100)}\n`;
const LOGO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), Buffer.from('PNG-ish payload\n')]);
const SUBJECT = 'feat: rotate the sk-live-abcdef token';

// A launcher root with one project repo under repos/app carrying the
// release range every test scans: a tagged base, a leak commit (config
// file, a git-only scratch file, a binary asset, a notes file — and a
// subject that leaks), then a clean tidy commit deleting the notes file.
// `pkg` adds a package.json at the base (an object as-is, so
// `private: true` is one field away); `tag` drops the v1.0.0 tag for the
// no-tags fallback.
function makeLauncher({ pkg = null, repoPatterns = null, wsPatterns = null, tag = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'leak-audit-'));
  const dir = join(root, 'repos', 'app');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
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
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', SUBJECT]);
  const sha = git(dir, ['log', '-1', '--format=%h']).trim();

  git(dir, ['rm', '-q', 'notes.md']);
  git(dir, ['commit', '-q', '-m', 'chore: tidy']);

  const config = { workspace: { name: 'fixture' }, repos: { app: { branch: 'main' } } };
  if (wsPatterns) config.workspace.release = { leakPatterns: wsPatterns };
  if (repoPatterns) config.repos.app.release = { leakPatterns: repoPatterns };
  writeFileSync(join(root, 'workspace.json'), JSON.stringify(config, null, 2));
  return { root, dir, sha };
}

// A npmFn fake returning a canned pack file list and recording its calls,
// so tests assert the argv array (never a shell string) and the cwd.
function fakeNpm(files, log = []) {
  return (cmd, args, opts = {}) => {
    log.push({ cmd, args, cwd: opts.cwd });
    return {
      status: 0,
      stdout: JSON.stringify([{ id: 'app@1.0.0', files: files.map((path) => ({ path, size: 10, mode: 420 })) }]),
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
  const ok = parseArgs(['node', 's', '--root', '/w', '--repo', '.', '--tag-range', 'v1.0.0..HEAD']);
  assertEq([ok.root, ok.repo, ok.tagRange], ['/w', '.', 'v1.0.0..HEAD'], 'flags map to camelCase values');
  assertEq(parseArgs(['node', 's', '--repo', 'app']).root, '.', 'root defaults to the current directory');
}

console.log('# no leak patterns configured: exit-0 fast path, nothing scanned');
{
  const { root } = makeLauncher();
  try {
    const gitCalls = [];
    const npmCalls = [];
    const out = run(audit(root), { gitFn: neverGit(gitCalls), npmFn: fakeNpm(['README.md'], npmCalls) });
    assertEq(out, { scanned: 0, matches: [], note: 'no leak patterns configured' }, 'the note rides along, nothing was scanned');
    assertEq(gitCalls.length, 0, 'git was never consulted');
    assertEq(npmCalls.length, 0, 'npm was never consulted');
  } finally { clean(root); }
}

console.log('# git-range path: literal and regex patterns, line numbers, subjects, skips');
{
  const { root, sha } = makeLauncher({ repoPatterns: ['sk-live-abcdef', '/JFROG-KEY-\\d+/'] });
  try {
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }); // would list nothing leaky — must not be used
    assertEq(out.matches, [
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "SK-LIVE-abcdef1234567890";' },
      { file: 'lib/config.js', line: 4, pattern: '/JFROG-KEY-\\d+/', excerpt: 'const registryKey = "JFROG-KEY-42";' },
      { file: 'local-notes.md', line: 2, pattern: 'sk-live-abcdef', excerpt: LOCAL_NOTES.split('\n')[1].trim().slice(0, 160) },
      { file: `commit ${sha}`, line: 1, pattern: 'sk-live-abcdef', excerpt: SUBJECT },
    ], 'matches carry file, line, pattern, and a capped excerpt');
    // Scanned = the two text files git changed (notes.md was deleted before
    // the scan, logo.png is binary) plus the two commit subjects.
    assertEq(out.scanned, 4, 'binary and deleted files are skipped, not scanned');
  } finally { clean(root); }
}

console.log('# npm pack path: the file list is the surface, not the tag range');
{
  const { root, sha } = makeLauncher({
    pkg: { name: 'app', version: '1.0.0' },
    repoPatterns: ['sk-live-abcdef', '/JFROG-KEY-\\d+/', 'internal-scratch'],
  });
  try {
    const npmCalls = [];
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md', 'lib/config.js', 'assets/logo.png', 'no-such.artifact'], npmCalls) });
    assertEq(out.matches, [
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "SK-LIVE-abcdef1234567890";' },
      { file: 'lib/config.js', line: 4, pattern: '/JFROG-KEY-\\d+/', excerpt: 'const registryKey = "JFROG-KEY-42";' },
      { file: `commit ${sha}`, line: 1, pattern: 'sk-live-abcdef', excerpt: SUBJECT },
    ], 'only packed files and commit subjects match');
    // local-notes.md carries two patterns but is not packed; the binary and
    // the missing artifact are skipped — scanned counts what was searched.
    assertEq(out.scanned, 4, 'README + config.js + the two subjects were searched');
    assertEq(out.matches.filter((m) => m.file === 'local-notes.md').length, 0, 'a changed file outside the pack list is never read');
    assertEq(npmCalls.length, 1, 'npm pack ran once');
    assertEq(npmCalls[0].cmd, 'npm', 'npm is invoked by name');
    assertEq(npmCalls[0].args, ['pack', '--dry-run', '--json'], 'npm args are an argv array with no interpolated values');
    assertEq(npmCalls[0].cwd, join(root, 'repos', 'app'), 'npm pack ran in the repo directory');
  } finally { clean(root); }
}

console.log('# "private": true falls back to the tag range; npm is never consulted');
{
  const { root } = makeLauncher({
    pkg: { name: 'app', version: '1.0.0', private: true },
    repoPatterns: ['internal-scratch'],
  });
  try {
    const npmCalls = [];
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md'], npmCalls) });
    assertEq(out.matches, [
      { file: 'local-notes.md', line: 1, pattern: 'internal-scratch', excerpt: 'scratch: internal-scratch' },
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
      { file: 'lib/config.js', line: 3, pattern: 'sk-live-abcdef', excerpt: 'const token = "SK-LIVE-abcdef1234567890";' },
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

console.log('# --tag-range: explicit equals default, and a bad range fails loudly');
{
  const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'] });
  try {
    const explicit = run(audit(root, ['--tag-range', 'v1.0.0..HEAD']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    const implicit = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    assertEq(explicit, implicit, 'an explicit v1.0.0..HEAD matches the default last-tag range');

    rejects(() => run(audit(root, ['--tag-range', 'v1.0.0']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
      'a range without .. rejected', 'must look like <from>..<to>');
    rejects(() => run(audit(root, ['--tag-range', 'v9.9.9..HEAD']), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) }),
      'an unknown rev rejected', 'git diff --name-only v9.9.9..HEAD failed');
  } finally { clean(root); }
}

console.log('# no tags yet: the whole history from the root commit is the range');
{
  const { root } = makeLauncher({ repoPatterns: ['sk-live-abcdef'], tag: false });
  try {
    const out = run(audit(root), { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    // The range is endpoint-to-endpoint, so notes.md (added then deleted)
    // nets out to unchanged and never appears; every commit since the root
    // contributes a subject.
    assertEq(out.matches.map((m) => (m.file.startsWith('commit ') ? 'commit' : m.file)).sort(),
      ['commit', 'lib/config.js', 'local-notes.md'],
      'a first release scans everything from the root commit');
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
    const out = run(['node', 'release-leak-audit.mjs', '--root', root, '--repo', '.'], { gitFn: gitWithEnv(), npmFn: fakeNpm(['README.md']) });
    // The range is the seed commit..HEAD, so secret.md (changed) is scanned
    // while workspace.json (unchanged in the range) is not — the patterns
    // file does not trip over its own pattern lines.
    assertEq(out.matches, [
      { file: 'secret.md', line: 1, pattern: 'marker-leak-77', excerpt: 'the marker-leak-77 key lives here' },
    ], 'the launcher itself is scanned');
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
    assertEq(JSON.parse(bad.stdout).matches.length, 3, 'stdout is the JSON result');

    const ok = spawnSync(process.execPath, [script, '--root', none.root, '--repo', 'app'], { encoding: 'utf-8', env: ENV });
    assertEq(ok.status, 0, 'no patterns exit 0');
    assertEq(JSON.parse(ok.stdout).note, 'no leak patterns configured', 'the note prints on stdout');

    const err = spawnSync(process.execPath, [script, '--root', none.root], { encoding: 'utf-8', env: ENV });
    assertEq(err.status, 2, 'a missing --repo exits 2');
    assert(String(err.stderr || '').startsWith('release-leak-audit:'), 'stderr names the script');
  } finally { clean(hit.root); clean(none.root); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
