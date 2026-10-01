#!/usr/bin/env node
// Unit tests for _utils.mjs tracker path helpers.
// Run: node .claude/hooks/_utils.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  sessionFilePath,
  sessionWorktreePath,
  sessionFolderPath,
  getSessionTrackers,
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

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
