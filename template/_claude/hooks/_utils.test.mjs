#!/usr/bin/env node
// Unit tests for _utils.mjs: the session tracker path helpers, the config
// summary line the session-start hook injects, and the legacy-session
// detection the nudge, the audit and /workspace-update share.
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
  listLegacySessions,
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

// listLegacySessions counts what the sessions directory holds, and nothing else
{
  const roots = [];
  // A root with a workspace.json of the given workspace block (or none).
  const rootWith = (workspace) => {
    const root = mkdtempSync(join(tmpdir(), 'utils-legacy-'));
    roots.push(root);
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace, repos: {} }));
    return root;
  };
  try {
    // The four cases the nudge is specified by.
    const missing = rootWith({});
    const archived = rootWith({});
    mkdirSync(join(archived, 'work-sessions', '.archived', 'old--20260101T000000', 'workspace'), { recursive: true });
    writeFileSync(join(archived, 'work-sessions', '.archived', 'old--20260101T000000', 'workspace', 'session.md'), '---\n---\n');
    writeFileSync(join(archived, 'work-sessions', '.DS_Store'), '');
    const real = rootWith({});
    mkdirSync(join(real, 'work-sessions', 'fix-auth', 'workspace'), { recursive: true });
    const custom = rootWith({ workSessionsDir: 'legacy-sessions' });
    mkdirSync(join(custom, 'work-sessions', 'ignored-because-unconfigured'), { recursive: true });

    assertEq(listLegacySessions(missing), [], 'a missing sessions directory is no legacy session and no error');
    assertEq(listLegacySessions(archived), [], 'an archive and a dotfile alone are no legacy session');
    assertEq(listLegacySessions(real), ['fix-auth'], 'one real entry is one legacy session');
    assertEq(listLegacySessions(custom), [], 'a custom workSessionsDir that does not exist is no legacy session');

    // The custom directory is the one that counts, not the default name.
    mkdirSync(join(custom, 'legacy-sessions', 'beta'), { recursive: true });
    mkdirSync(join(custom, 'legacy-sessions', 'alpha'), { recursive: true });
    mkdirSync(join(custom, 'legacy-sessions', '.archived'), { recursive: true });
    assertEq(listLegacySessions(custom), ['alpha', 'beta'], 'a custom workSessionsDir is honoured, sorted, dot entries aside');

    // Every non-dot entry counts whatever it holds: an orphan shell with no
    // worktree is still something the operator has to drain or remove.
    mkdirSync(join(real, 'work-sessions', 'empty-shell', 'workspace'), { recursive: true });
    writeFileSync(join(real, 'work-sessions', 'stray.txt'), 'not a folder\n');
    assertEq(listLegacySessions(real), ['empty-shell', 'fix-auth', 'stray.txt'], 'shells and stray entries count — the inventory says which is which');

    // Detection never keys on sessionModel, in either direction: the value
    // cannot hide a session that is there, and cannot summon one that is not.
    for (const sessionModel of ['session', 'task', '', undefined]) {
      const typed = rootWith({ sessionModel, workSessionsDir: 'legacy-sessions' });
      const empty = rootWith({ sessionModel, workSessionsDir: 'legacy-sessions' });
      mkdirSync(join(typed, 'legacy-sessions', 'alpha'), { recursive: true });
      mkdirSync(join(empty, 'legacy-sessions'), { recursive: true });
      assertEq(listLegacySessions(typed), ['alpha'], `sessionModel ${JSON.stringify(sessionModel)} does not hide a session that is there`);
      assertEq(listLegacySessions(empty), [], `sessionModel ${JSON.stringify(sessionModel)} does not invent a session`);
    }

    // A workspace.json that does not parse reads as no configuration at all:
    // the default directory is used, and nothing is thrown.
    const broken = mkdtempSync(join(tmpdir(), 'utils-legacy-'));
    roots.push(broken);
    writeFileSync(join(broken, 'workspace.json'), '{ not json\n');
    mkdirSync(join(broken, 'work-sessions', 'alpha'), { recursive: true });
    assertEq(listLegacySessions(broken), ['alpha'], 'an unparseable workspace.json falls back to the default directory');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
