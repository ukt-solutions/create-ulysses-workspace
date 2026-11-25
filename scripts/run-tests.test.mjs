#!/usr/bin/env node
// Tests for run-tests.mjs, the runner behind `npm test`.
// Run: node scripts/run-tests.test.mjs
//
// The runner exists so that a failing test is noticed, so what is tested is
// what it reports: a file that fails or is killed makes the run exit 1, and a
// run that selects no file exits 1 too instead of passing on a technicality.
// The runner is copied into small fixture repositories holding fake test
// files and run there — copied, never linked, because it finds the
// repository root from its own location. The timeout is not exercised: it is
// ten minutes by default, so a hanging file cannot be tried in a short run,
// and a file killed for any other reason takes the same path.
//
// scripts/ is not part of the published package.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(SCRIPTS, 'run-tests.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'run-tests-test-'));

let failed = 0;
let passed = 0;
function check(label, ok, extra = '') {
  if (ok) passed++;
  else { failed++; console.error(`  FAIL: ${label}${extra ? `\n    ${extra}` : ''}`); }
}

// A fixture repository: the runner under scripts/ and, wherever each one
// belongs, a fake test file per [path, source] pair.
function fixture(name, files) {
  const root = join(TMP, name);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(RUNNER, join(root, 'scripts', 'run-tests.mjs'));
  for (const [rel, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), source);
  }
  return root;
}

function runIn(root, ...args) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'run-tests.mjs'), ...args], { encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines };
}

// The one line a file is reported by, without its timing.
const fileLines = (r) => r.lines
  .filter((line) => /^(ok|FAIL) /.test(line))
  .map((line) => line.replace(/ \(\d+\.\d+s\)$/, ''));
// Why the runner reported one file: the line under its own.
const reasonFor = (r, file) => {
  const i = r.lines.findIndex((line) => line.startsWith(`FAIL ${file} (`));
  return i === -1 ? null : r.lines[i + 1].trim();
};
const shown = (r) => `status ${r.status}\n${r.stdout}${r.stderr}`;

// The file that kills itself ends by TerminateProcess on Windows, which
// gives it exit status 1: there is no signal there, and none to report.
// Everywhere else it dies without an exit status and the runner names the
// signal.
const KILLED = process.platform === 'win32' ? 'exited with status 1' : 'killed by SIGKILL';

const E_RAN = join(TMP, 'full', 'e-ran');
const full = fixture('full', {
  // Fails after printing more lines than the runner keeps.
  'lib/a-failing.test.mjs': [
    'for (let n = 1; n <= 40; n++) console.log(`out line ${n}`);',
    "console.error('FAIL: a check that did not hold');",
    'process.exitCode = 1;',
  ].join('\n'),
  // Dies without an exit status, the way a crash does.
  'lib/b-killed.test.mjs': "process.kill(process.pid, 'SIGKILL');\nsetTimeout(() => {}, 5000);",
  'scripts/c-passing.test.mjs': "console.log('c ran');",
  'template/_claude/d.test.mjs': "console.error('d wrote to stderr');",
  // Would leave a marker behind if it ever ran. It must not: the runner skips
  // node_modules.
  'lib/node_modules/dep/e.test.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(E_RAN)}, '');\n`,
});

try {
  // --- One run over everything ---
  const r = runIn(full);
  check('a failing file makes the run exit 1', r.status === 1, shown(r));
  check('every test file is reported once, in sorted order, passing or not',
    JSON.stringify(fileLines(r)) === JSON.stringify([
      'FAIL lib/a-failing.test.mjs',
      'FAIL lib/b-killed.test.mjs',
      'ok   scripts/c-passing.test.mjs',
      'ok   template/_claude/d.test.mjs',
    ]), shown(r));
  check('node_modules is not searched', !existsSync(E_RAN));
  check('the summary counts the files',
    /^4 test files: 2 passed, 2 failed in \d+s$/m.test(r.stdout), shown(r));
  check('the failed files are listed after the summary',
    r.lines.at(-2) === '  lib/a-failing.test.mjs' && r.lines.at(-1) === '  lib/b-killed.test.mjs', shown(r));
  check('a file that exits non-zero is reported with its status',
    r.stdout.includes('\n      exited with status 1\n'), shown(r));
  check(process.platform === 'win32'
    ? 'a file that kills itself is reported with the exit status Windows gives it'
    : 'a file that dies without an exit status is reported as killed',
    reasonFor(r, 'lib/b-killed.test.mjs') === KILLED, shown(r));
  check('the last lines of a failing file\'s stdout are printed',
    r.stdout.includes('[stdout] out line 11\n') && r.stdout.includes('[stdout] out line 40\n'), shown(r));
  check('the earlier lines are left out, and the cut is marked',
    !r.stdout.includes('[stdout] out line 10\n') && r.stdout.includes('[stdout: 10 earlier lines not shown]\n'), shown(r));
  check('the last lines of a failing file\'s stderr are printed',
    r.stdout.includes('[stderr] FAIL: a check that did not hold\n'), shown(r));
  check('the output of a passing file is dropped',
    !r.stdout.includes('c ran') && !r.stdout.includes('d wrote to stderr'), shown(r));

  // --- Filters ---
  {
    const one = runIn(full, 'passing');
    check('a filter runs only the files whose path contains it',
      one.status === 0 && JSON.stringify(fileLines(one)) === JSON.stringify(['ok   scripts/c-passing.test.mjs']), shown(one));
    check('the summary counts one file',
      /^1 test file: 1 passed, 0 failed in \d+s$/m.test(one.stdout), shown(one));
  }
  {
    const two = runIn(full, 'passing', '_claude');
    check('several filters run the files matching any of them',
      two.status === 0 && fileLines(two).length === 2
        && fileLines(two)[1] === 'ok   template/_claude/d.test.mjs', shown(two));
  }
  {
    const none = runIn(full, '--help');
    check('a filter that matches no file exits 1 and runs nothing',
      none.status === 1 && none.stdout === '' && none.stderr.includes('"--help"'), shown(none));
  }

  // --- Nothing to run ---
  {
    const blank = fixture('blank', {});
    for (const dir of ['lib', 'template']) mkdirSync(join(blank, dir));
    const r = runIn(blank);
    check('a repository with no test file is not a pass',
      r.status === 1 && r.stdout === '' && r.stderr.includes('No test files found'), shown(r));
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
