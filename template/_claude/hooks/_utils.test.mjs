#!/usr/bin/env node
// Unit tests for _utils.mjs: the session tracker path helpers, and the
// config summary line the session-start hook injects.
// Run: node .claude/hooks/_utils.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  sessionFilePath,
  sessionWorktreePath,
  sessionFolderPath,
  getSessionTrackers,
  configSummary,
} from './_utils.mjs';

let failed = 0;
let passed = 0;

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'utils-test-'));
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace: { workSessionsDir: 'work-sessions', scratchpadDir: 'workspace-scratchpad' },
    })
  );
  mkdirSync(join(root, 'work-sessions', 'demo', 'workspace'), { recursive: true });
  writeFileSync(
    join(root, 'work-sessions', 'demo', 'workspace', 'session.md'),
    '---\ntype: session-tracker\nname: demo\nstatus: active\n---\n\nbody\n'
  );
  return root;
}

// sessionFilePath points inside the worktree
{
  const root = fixture();
  try {
    assertEq(
      sessionFilePath(root, 'demo'),
      join(root, 'work-sessions', 'demo', 'workspace', 'session.md'),
      'sessionFilePath resolves to in-worktree tracker'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// sessionWorktreePath returns the workspace worktree root
{
  const root = fixture();
  try {
    assertEq(
      sessionWorktreePath(root, 'demo'),
      join(root, 'work-sessions', 'demo', 'workspace'),
      'sessionWorktreePath returns worktree root'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// sessionFolderPath still returns the session parent folder
{
  const root = fixture();
  try {
    assertEq(
      sessionFolderPath(root, 'demo'),
      join(root, 'work-sessions', 'demo'),
      'sessionFolderPath unchanged'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// getSessionTrackers walks the in-worktree path
{
  const root = fixture();
  try {
    const trackers = getSessionTrackers(root);
    assertEq(trackers.length, 1, 'getSessionTrackers finds demo session');
    assertEq(trackers[0].name, 'demo', 'tracker name parsed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// configSummary leads with the lifecycle, and reports the task model for
// every value that names none
{
  // The rest of the line, which these cases do not vary.
  const TAIL = 'tracker: off | forge: auto (from origin) | repos: none';
  const line = (model) => `sessionModel: ${model} | ${TAIL}`;

  // The template ships "task", so this is what a fresh scaffold prints.
  assertEq(
    configSummary({ workspace: { sessionModel: 'task' }, repos: {} }),
    line('task'),
    'a scaffolded workspace reports task',
  );
  // Nothing routes on the key any more: new work is always a task, so an
  // unset value means the task lifecycle rather than the old default.
  assertEq(configSummary({ workspace: {} }), line('task'), 'an absent sessionModel reports task');
  assertEq(configSummary({}), line('task'), 'a config with no workspace object reports task');
  assertEq(configSummary(null), line('task'), 'a null config reports task');
  assertEq(configSummary({ workspace: { sessionModel: '' } }), line('task'), 'an empty sessionModel reports task');
  assertEq(configSummary({ workspace: { sessionModel: '   ' } }), line('task'), 'a blank sessionModel reports task');
  assertEq(configSummary({ workspace: { sessionModel: null } }), line('task'), 'a null sessionModel reports task');
  assertEq(configSummary({ workspace: { sessionModel: 5 } }), line('task'), 'a non-string sessionModel reports task');

  // A workspace that still holds the legacy value is told what its file
  // says: the value is reported, not rewritten and not hidden.
  assertEq(
    configSummary({ workspace: { sessionModel: 'session' } }),
    line('session'),
    'an explicit legacy value is reported as written',
  );
  assertEq(
    configSummary({ workspace: { sessionModel: ' task ' } }),
    line('task'),
    'surrounding whitespace is not part of the value',
  );
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
