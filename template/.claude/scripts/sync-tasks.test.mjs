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

import { parseTasksSection } from './sync-tasks.mjs';

const SAMPLE_WITH_TASKS = `---
type: session-tracker
name: demo
---

# Work Session

## Tasks

> Linked: gh:42 — Auth timeout on mobile

- [x] Start work
- [x] Reproduce on iOS Safari
- [ ] Identify race condition
- [ ] Complete work

## Progress

(stuff)
`;

const SAMPLE_NO_TASKS = `---
type: session-tracker
name: demo
---

# Work Session

## Progress

(stuff)
`;

const SAMPLE_NO_LINK = `---
type: session-tracker
name: demo
---

## Tasks

- [x] Start work
- [ ] Complete work
`;

console.log('\n# parseTasksSection');
assertEq(
  parseTasksSection(SAMPLE_WITH_TASKS).linked,
  { id: 'gh:42', title: 'Auth timeout on mobile' },
  'parses linked blockquote'
);
assertEq(
  parseTasksSection(SAMPLE_WITH_TASKS).todos.length,
  4,
  'parses 4 todos'
);
assertEq(
  parseTasksSection(SAMPLE_WITH_TASKS).todos[0],
  { content: 'Start work', activeForm: 'Starting work', status: 'completed' },
  'first todo completed'
);
assertEq(
  parseTasksSection(SAMPLE_WITH_TASKS).todos[2],
  { content: 'Identify race condition', activeForm: 'Identifying race condition', status: 'pending' },
  'pending todo'
);
assertEq(
  parseTasksSection(SAMPLE_NO_TASKS),
  { linked: null, todos: [] },
  'missing section returns empty'
);
assertEq(
  parseTasksSection(SAMPLE_NO_LINK).linked,
  null,
  'no blockquote → linked: null'
);
assertEq(
  parseTasksSection(SAMPLE_NO_LINK).todos.length,
  2,
  'no blockquote → still parses todos'
);

import { renderTasksSection, enforceBookends } from './sync-tasks.mjs';

console.log('\n# enforceBookends');
assertEq(
  enforceBookends([]).map(t => t.content),
  ['Start work', 'Complete work'],
  'empty list → bookends inserted'
);
assertEq(
  enforceBookends([
    { content: 'Do thing', activeForm: 'Doing thing', status: 'pending' },
  ]).map(t => t.content),
  ['Start work', 'Do thing', 'Complete work'],
  'middle task gets wrapped in bookends'
);
assertEq(
  enforceBookends([
    { content: 'Complete work', activeForm: 'Completing work', status: 'pending' },
    { content: 'Do thing', activeForm: 'Doing thing', status: 'pending' },
    { content: 'Start work', activeForm: 'Starting work', status: 'completed' },
  ]).map(t => t.content),
  ['Start work', 'Do thing', 'Complete work'],
  'misplaced bookends moved to ends'
);
assertEq(
  enforceBookends([{ content: 'Start work', activeForm: 'Starting work', status: 'completed' }])[0].status,
  'completed',
  'preserves Start work status when present'
);
assertEq(
  enforceBookends([])[0].status,
  'completed',
  'inserted Start work defaults to completed'
);
assertEq(
  enforceBookends([])[1].status,
  'pending',
  'inserted Complete work defaults to pending'
);

console.log('\n# renderTasksSection');
assertEq(
  renderTasksSection({
    linked: null,
    todos: [
      { content: 'Start work', activeForm: 'Starting work', status: 'completed' },
      { content: 'Do thing', activeForm: 'Doing thing', status: 'pending' },
      { content: 'Complete work', activeForm: 'Completing work', status: 'pending' },
    ],
  }),
  '## Tasks\n\n- [x] Start work\n- [ ] Do thing\n- [ ] Complete work\n',
  'no link → no blockquote'
);
assertEq(
  renderTasksSection({
    linked: { id: 'gh:42', title: 'Auth timeout on mobile' },
    todos: [
      { content: 'Start work', activeForm: 'Starting work', status: 'completed' },
      { content: 'Complete work', activeForm: 'Completing work', status: 'pending' },
    ],
  }),
  '## Tasks\n\n> Linked: gh:42 — Auth timeout on mobile\n\n- [x] Start work\n- [ ] Complete work\n',
  'with link → blockquote rendered'
);
assertEq(
  renderTasksSection({
    linked: { id: 'gh:42', title: null },
    todos: [
      { content: 'Start work', activeForm: 'Starting work', status: 'completed' },
      { content: 'Complete work', activeForm: 'Completing work', status: 'pending' },
    ],
  }),
  '## Tasks\n\n> Linked: gh:42\n\n- [x] Start work\n- [ ] Complete work\n',
  'link with null title → bare ID'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
