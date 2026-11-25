#!/usr/bin/env node
// Runs every test file in the repository and exits non-zero when any of them
// fails or hangs. `npm test` runs it, and .github/workflows/test.yml runs
// `npm test` on every pull request and on every push to main, so a failing
// test cannot sit on main unnoticed.
//
// A test file is a plain Node script named *.test.mjs that exits 0 when its
// checks pass; there is no test framework and nothing to install. The files
// live in three places — lib/ (the CLI), scripts/ (the publish and audit
// scripts) and template/ (what a scaffolded workspace receives) — and the
// walk below covers those, skipping node_modules.
//
// Usage:
//   node scripts/run-tests.mjs                every test file
//   node scripts/run-tests.mjs team-roster    only the files whose path
//                                             contains any of the words given
//
// Each file runs in its own process, with the repository root as its working
// directory, one after another. That keeps tests from sharing state and lets
// one crash or hang be reported without taking the rest of the run with it.
// A file gets 600 seconds by default (RUN_TESTS_TIMEOUT_SECONDS overrides);
// past that it is killed and counted as a failure.
//
// What is printed: one line per file (`ok` or `FAIL`, its path, the seconds
// it took), then a summary. The output of a passing file is dropped. For a
// failing file the last lines of its stderr and stdout follow its line, so
// the reason is in the log without a re-run.
//
// scripts/ is not part of the published package.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Where test files live, relative to the repository root.
const TEST_ROOTS = ['lib', 'scripts', 'template'];

// How long one test file may run before it is killed. The slowest file,
// migrate-sessions, spawns git hundreds of times: about 90 s on macOS and
// close to 300 s on a Windows runner, where process spawns are slow. Ten
// minutes leaves room for that while still ending a hang.
const DEFAULT_TIMEOUT_SECONDS = 600;
const envTimeout = Number(process.env.RUN_TESTS_TIMEOUT_SECONDS);
const FILE_TIMEOUT_MS = (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_SECONDS) * 1000;

// Lines printed from each output stream of a failing file.
const FAILURE_LINES = 30;

// Past this much stdout or stderr the process is killed and reported as
// failed. The default (1 MiB) would do that to a test that only talks a lot.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Every *.test.mjs under the test roots, as paths relative to the repository
// root, written with forward slashes and sorted: the run and its report come
// out in the same order on every operating system.
function findTestFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      // readdir reports a symlink as a link, not as the directory it points
      // to, so a linked folder is never descended into.
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.mjs')) files.push(relative(root, path).split(sep).join('/'));
    }
  };
  for (const name of TEST_ROOTS) walk(join(root, name));
  return files.sort();
}

// Why a run failed, or null when it passed.
function failureOf(result) {
  if (result.status === 0) return null;
  if (result.error?.code === 'ETIMEDOUT') return `timed out after ${FILE_TIMEOUT_MS / 1000}s`;
  if (result.error?.code === 'ENOBUFS') return `printed more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB`;
  if (result.error) return `could not run: ${result.error.message}`;
  if (result.signal) return `killed by ${result.signal}`;
  return `exited with status ${result.status}`;
}

// The last lines of one output stream, indented under the file's own line.
function printTail(stream, text) {
  if (!text) return;
  const lines = text.split('\n');
  // A stream that ends with a newline has an empty string for its last line.
  if (lines[lines.length - 1] === '') lines.pop();
  const omitted = lines.length - FAILURE_LINES;
  if (omitted > 0) {
    out(`      [${stream}: ${omitted} earlier line${omitted === 1 ? '' : 's'} not shown]`);
  }
  for (const line of lines.slice(-FAILURE_LINES)) out(`      [${stream}] ${line}`);
}

function out(text) {
  process.stdout.write(`${text}\n`);
}

function main(argv) {
  // Arguments are substrings; a file runs when its path contains any of them.
  const files = findTestFiles(REPO_ROOT);
  const selected = argv.length === 0
    ? files
    : files.filter((file) => argv.some((word) => file.includes(word)));

  // A run that tested nothing is not a pass, whichever way it got there.
  if (selected.length === 0) {
    const where = `${TEST_ROOTS.join(', ')} (under ${REPO_ROOT})`;
    throw new Error(argv.length === 0
      ? `No test files found under ${where}.`
      : `No test file under ${where} contains any of ${argv.map((word) => JSON.stringify(word)).join(', ')}.`);
  }

  const started = Date.now();
  const failed = [];
  for (const file of selected) {
    const fileStarted = Date.now();
    const result = spawnSync(process.execPath, [join(REPO_ROOT, file)], {
      cwd: REPO_ROOT,
      // A test has no terminal to ask questions of: stdin reads as closed.
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: FILE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const seconds = ((Date.now() - fileStarted) / 1000).toFixed(1);
    const failure = failureOf(result);
    if (failure) failed.push(file);
    // Both labels are padded to one width so the paths line up.
    out(`${failure ? 'FAIL' : 'ok'}${failure ? ' ' : '   '}${file} (${seconds}s)`);
    if (!failure) continue;
    out(`      ${failure}`);
    printTail('stderr', result.stderr);
    printTail('stdout', result.stdout);
  }

  const count = selected.length;
  const elapsed = Math.round((Date.now() - started) / 1000);
  out('');
  out(`${count} test file${count === 1 ? '' : 's'}: ${count - failed.length} passed, `
    + `${failed.length} failed in ${elapsed}s`);
  for (const file of failed) out(`  ${file}`);
  if (failed.length > 0) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`run-tests: ${err.message}\n`);
  process.exitCode = 1;
}
