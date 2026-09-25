#!/usr/bin/env node
// Unit tests for repo-write-detection.mjs's task-worktree predicate.
// Run: node .claude/hooks/repo-write-detection.test.mjs
//
// The hook body itself is exercised live by Claude Code; what needs
// guarding is the carve-out decision — which paths count as task-worktree
// writes and must never trip the "you're on main" warning (gh:132).
import { join } from 'path';
import { isTaskWorktreeWrite } from './repo-write-detection.mjs';

let failed = 0;
let passed = 0;

function check(actual, expected, label, detail) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}\n    path: ${detail}\n    expected: ${expected}, got: ${actual}`);
  }
}

const root = '/w';

// === Task-worktree writes: allowed ===
check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', '.claude', 'worktrees', 'feature-x', 'src', 'a.ts')), true, 'file inside a task worktree', 'deep file');
check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', '.claude', 'worktrees', 'feature-x')), true, 'the worktree directory itself', 'worktree root');
check(isTaskWorktreeWrite(root, join(root, 'repos', 'my-repo', '.claude', 'worktrees', 'bugfix-y', 'lib', 'b.js')), true, 'different repo name', 'second repo');

// === Not task-worktree writes: still warned ===
check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', 'src', 'a.ts')), false, 'write to the source clone', 'repos/app/src');
check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', '.claude', 'settings.json')), false, 'write to a repo .claude file', 'not under worktrees');
check(isTaskWorktreeWrite(root, join(root, 'repos', '.claude', 'worktrees', 'x', 'f')), false, 'missing repo segment', 'no repo between repos/ and .claude');
check(isTaskWorktreeWrite(root, join(root, 'repos', 'app', '.claude', 'worktrees')), false, 'the worktrees dir itself', 'no slug segment');
check(isTaskWorktreeWrite(root, join(root, 'work-sessions', 'alpha', 'workspace', 'f.md')), false, 'session-model write', 'not a task path');
check(isTaskWorktreeWrite(root, join(root, 'workspace-context', 'notes.md')), false, 'context write', 'unrelated');
check(isTaskWorktreeWrite(root, join('/elsewhere', 'repos', 'app', '.claude', 'worktrees', 'x', 'f')), false, 'outside the given root', 'other tree');
check(isTaskWorktreeWrite(root, ''), false, 'empty path', 'empty');
check(isTaskWorktreeWrite(root, null), false, 'null path', 'null');
check(isTaskWorktreeWrite('', join(root, 'repos', 'app', '.claude', 'worktrees', 'x', 'f')), false, 'empty root', 'no root');

// === Path traversal does not smuggle a write ===
// Raw strings, not join(): join would normalize ".." away before the
// predicate's resolve() ever sees it, and the lexical normalization is
// exactly what must keep these out.
check(isTaskWorktreeWrite(root, '/w/repos/app/.claude/worktrees/x/../../../src/a.ts'), false, '.. climbs out of the worktree', 'traversal');
check(isTaskWorktreeWrite(root, '/w/repos/../secret.txt'), false, '.. right after repos', 'traversal at repos');

// === Relative paths resolve against cwd before judging ===
// (The hook process runs at the workspace root; resolve() mirrors that, so
// a relative string never blind-matches — it must land under the root's
// own repos/ after resolution. cwd during this test run is not /w, so a
// relative repos/... path resolves outside the root and must not match.)
check(isTaskWorktreeWrite(root, 'repos/app/.claude/worktrees/x/f'), false, 'relative path is resolved, not blind-matched', 'relative');

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
