#!/usr/bin/env node
// Unit tests for _utils.mjs: the config summary line the session-start hook
// injects, and the legacy-session detection the nudge, the audit and
// /workspace-update share.
// Run: node .claude/hooks/_utils.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
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

// configSummary leaves sessionModel out of the line, whatever the file holds
{
  // What the line says when tracker, forge and repos are all absent.
  const BARE = 'tracker: off | forge: auto (from origin) | repos: none';

  // A scaffolded workspace prints the bare line, whether or not its file
  // carries the key.
  assertEq(
    configSummary({ workspace: { sessionModel: 'task' }, repos: {} }),
    BARE,
    'a scaffolded workspace prints tracker, forge and repos, and no sessionModel',
  );
  assertEq(configSummary({ workspace: {} }), BARE, 'an absent sessionModel changes nothing');
  assertEq(configSummary({}), BARE, 'a config with no workspace object degrades to the same line');
  assertEq(configSummary(null), BARE, 'a null config degrades to the same line');

  // Why the key is left out: nothing routes on it, and an older workspace
  // still holds "session" — printed, that would be read as the lifecycle in
  // use. The line never carries it, whatever the value.
  for (const sessionModel of ['session', 'task', '', '   ', null, 5]) {
    assertEq(
      configSummary({ workspace: { sessionModel } }),
      BARE,
      `sessionModel ${JSON.stringify(sessionModel)} is not in the line`,
    );
  }
  assertEq(
    configSummary({ workspace: { sessionModel: 'session', tracker: { type: 'github-issues' } } }),
    'tracker: github-issues | forge: auto (from origin) | repos: none',
    'a legacy value leaves the rest of the line untouched',
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
