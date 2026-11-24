#!/usr/bin/env node
// Tests for dist-tag.mjs — the tag → npm dist-tag mapping the publish
// workflow runs before it installs anything.
// Run: node scripts/dist-tag.test.mjs
//
// The mistake that cannot be undone is a pre-release on `latest`, the tag a
// bare `npx @ulysses-ai/create-workspace` installs. So every accepted shape
// is checked for its exact mapping, and each way a tag can be wrong is
// checked for a thrown error that names the tag.
//
// The CLI is run through spawnSync with an argument array (no shell), the
// way the workflow runs it. Its stdout is appended to $GITHUB_OUTPUT
// verbatim, so a rejected tag must leave stdout empty, not only exit
// non-zero. And a run the script does not recognise as a direct run would
// exit 0 without printing a dist-tag, leaving `npm publish --tag` with an
// empty value; the last block covers that. scripts/ is not part of the
// published package.

import { distTagFor, PRERELEASE_CHANNELS } from './dist-tag.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(SCRIPTS, 'dist-tag.mjs');
const output = (dist, isPrerelease) => `dist=${dist}\nis_prerelease=${isPrerelease}\n`;

let failed = 0;
let passed = 0;
function check(label, ok, extra = '') {
  if (ok) passed++;
  else { failed++; console.error(`  FAIL: ${label}${extra ? `\n    ${extra}` : ''}`); }
}

// distTagFor's result, or the error it threw.
function attempt(tag) {
  try {
    return distTagFor(tag);
  } catch (err) {
    return err;
  }
}
const mapsTo = (result, dist, isPrerelease) =>
  !(result instanceof Error) && result.dist === dist && result.isPrerelease === isPrerelease;
const shown = (result) => (result instanceof Error ? `threw: ${result.message}` : JSON.stringify(result));

// Importing the module must not run the CLI. This process imported it above
// with no tag argument, which the CLI would have answered with an exit code.
check('importing the module does not run the CLI', process.exitCode === undefined || process.exitCode === 0,
  `exitCode is ${process.exitCode}`);

// --- Accepted tags ---

check('channels are beta, rc, canary and next', PRERELEASE_CHANNELS.join(',') === 'beta,rc,canary,next',
  `got ${PRERELEASE_CHANNELS.join(', ')}`);

for (const [tag, dist, isPrerelease] of [
  ['1.0.0', 'latest', false],
  ['v1.0.0', 'latest', false],
  ['v0.26.0', 'latest', false],
  ['1.0.0-rc.0', 'rc', true],
  ['v1.0.0-rc.12', 'rc', true],
  ['0.26.0-beta.0', 'beta', true],
  ['0.1.0-canary.3', 'canary', true],
  ['2.0.0-next.1', 'next', true],
]) {
  const result = attempt(tag);
  check(`${tag} → ${dist}${isPrerelease ? ' (pre-release)' : ''}`, mapsTo(result, dist, isPrerelease), shown(result));
}

// Every exported channel is a dist-tag of the same name, with and without
// the leading `v`.
for (const channel of PRERELEASE_CHANNELS) {
  for (const tag of [`3.2.1-${channel}.0`, `v3.2.1-${channel}.7`]) {
    const result = attempt(tag);
    check(`${tag} → ${channel}`, mapsTo(result, channel, true), shown(result));
  }
}

// --- Rejected tags: one entry per way a tag can be wrong ---
const rejected = [
  ['1.0.0-foo.0', 'an unknown pre-release identifier'],
  ['v1.0.0-alpha.1', 'an unknown pre-release identifier'],
  ['1.0.0-beta', 'no counter'],
  ['v1.0.0-rc', 'no counter'],
  ['1.0.0-rc.0.1', 'a second pre-release segment'],
  ['1.0.0+build.1', 'build metadata'],
  ['1.0.0-rc.1+build.1', 'build metadata on a pre-release'],
  ['1.0', 'two version numbers'],
  ['1.0.0.0', 'four version numbers'],
  ['1.0.0-', 'a hyphen with nothing after it'],
  ['01.0.0', 'a leading zero in the version'],
  ['1.0.0-rc.01', 'a leading zero in the counter'],
  ['1.0.0-rc.-1', 'a signed counter'],
  ['v1.0.0-RC.0', 'an upper-case channel'],
  ['V1.0.0', 'an upper-case v'],
  ['1.0.0-rc.0\n', 'a trailing newline'],
  [' 1.0.0', 'a leading space'],
  ['latest', 'a dist-tag where the tag goes'],
  ['', 'the empty string'],
  [undefined, 'not a string'],
  [null, 'not a string'],
];
for (const [tag, why] of rejected) {
  const result = attempt(tag);
  const label = JSON.stringify(tag) ?? String(tag);
  check(`${label} (${why}) throws an error naming the tag`,
    result instanceof Error && result.message.includes(label),
    result instanceof Error ? result.message : `returned ${shown(result)}`);
}
{
  const { message } = attempt('1.0.0-foo.0');
  check('the error lists the accepted forms',
    ['vX.Y.Z', 'vX.Y.Z-<channel>.<n>', ...PRERELEASE_CHANNELS].every((form) => message.includes(form)),
    message);
}

// --- The CLI, run the way the workflow runs it ---
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const detail = (r) => `status ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)}`;

{
  const r = cli(['v1.0.0-rc.0']);
  check('CLI: v1.0.0-rc.0 exits 0', r.status === 0, detail(r));
  check('CLI: v1.0.0-rc.0 prints dist=rc and is_prerelease=true', r.stdout === output('rc', true), detail(r));
}
{
  const r = cli(['v1.0.0']);
  check('CLI: v1.0.0 exits 0 and prints dist=latest and is_prerelease=false',
    r.status === 0 && r.stdout === output('latest', false), detail(r));
}
{
  const r = cli(['v1.0.0-foo.0']);
  check('CLI: v1.0.0-foo.0 exits 1', r.status === 1, detail(r));
  check('CLI: v1.0.0-foo.0 prints nothing to stdout', r.stdout === '', detail(r));
  check('CLI: v1.0.0-foo.0 names the tag on stderr', r.stderr.includes('"v1.0.0-foo.0"'), detail(r));
}
for (const [label, args] of [
  ['no argument', []],
  ['an empty argument', ['']],
  ['a second argument', ['v1.0.0', 'v1.0.0']],
]) {
  const r = cli(args);
  check(`CLI: ${label} exits 1 with nothing on stdout`,
    r.status === 1 && r.stdout === '' && r.stderr !== '', detail(r));
}
{
  // The workflow's own call: a path relative to the repository root.
  const r = spawnSync(process.execPath, ['scripts/dist-tag.mjs', 'v0.26.0-beta.0'],
    { cwd: join(SCRIPTS, '..'), encoding: 'utf8' });
  check('CLI: runs by a path relative to the repository root',
    r.status === 0 && r.stdout === output('beta', true), detail(r));
}

// --- Direct-run detection through a symlink ---
// import.meta.url resolves to the real file while argv[1] keeps the path as
// typed, so a script reached through a symlink is where a naive comparison
// sees no direct run.
{
  const parent = mkdtempSync(join(tmpdir(), 'dist-tag-test-'));
  const link = join(parent, 'scripts');
  try {
    symlinkSync(SCRIPTS, link, process.platform === 'win32' ? 'junction' : 'dir');
    const r = spawnSync(process.execPath, [join(link, 'dist-tag.mjs'), 'v1.0.0-rc.0'], { encoding: 'utf8' });
    check('CLI: prints a dist-tag when run through a symlink',
      r.status === 0 && r.stdout === output('rc', true), detail(r));
  } catch (err) {
    if (!['EPERM', 'EACCES', 'EINVAL', 'ENOSYS'].includes(err.code)) throw err;
    console.log('  (skip: symlink unavailable on this machine)');
  } finally {
    // Remove the link itself, never what it points at.
    rmSync(link, { force: true });
    rmdirSync(parent);
  }
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
