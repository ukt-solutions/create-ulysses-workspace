#!/usr/bin/env node
// Unit tests for sync-tasks.mjs
// Run: node template/.claude/scripts/sync-tasks.test.mjs
import { toActiveForm } from './sync-tasks.mjs';

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

console.log('# toActiveForm');
assertEq(toActiveForm('Start work'),                    'Starting work',                  'simple verb');
assertEq(toActiveForm('Write fix and test'),            'Writing fix and test',           'e-drop');
assertEq(toActiveForm('Run the tests'),                 'Running the tests',              'double consonant');
assertEq(toActiveForm('Identify race condition'),       'Identifying race condition',     'y-keep');
assertEq(toActiveForm('Complete work'),                 'Completing work',                'e-drop on Complete');
assertEq(toActiveForm('Reproduce on iOS Safari'),       'Reproducing on iOS Safari',      'e-drop multi-word');
assertEq(toActiveForm('Fix bug'),                       'Fixing bug',                     'simple');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
