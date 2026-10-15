#!/usr/bin/env node
// Unit tests for the session-start hook's configSummary line (gh:196).
// Run: node .claude/hooks/session-start.test.mjs
//
// The summary must state what workspace.json says — never a default the
// scripts don't apply: broken tracker/forge/repos values surface as
// `invalid`, an unset forge type surfaces as origin-picked, and only
// sessionModel falls back ("session", matching how /start-work routes
// absent config).
import { configSummary } from './_utils.mjs';

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

console.log('# session-start configSummary');

// 1. Fully configured: every field printed, primary repo marked
assertEq(
  configSummary({
    workspace: {
      sessionModel: 'task',
      tracker: { type: 'github-issues', repo: 'acme/monorepo' },
      forge: { type: 'gitlab' },
    },
    repos: {
      'my-app': { remote: 'git@github.com:acme/my-app.git', branch: 'main', primary: true },
      'my-api': { remote: 'git@github.com:acme/my-api.git', branch: 'main' },
    },
  }),
  'sessionModel: task | tracker: github-issues on acme/monorepo | forge: gitlab | repos: my-app (primary), my-api',
  'a fully configured workspace prints every field',
);

// 2. Fresh-scaffold shape: tracker null, forge typed, empty manifest
assertEq(
  configSummary({
    workspace: { name: 'demo', sessionModel: 'session', tracker: null, forge: { type: 'github' } },
    repos: {},
  }),
  'sessionModel: session | tracker: off | forge: github | repos: none',
  'a fresh scaffold summarizes to its defaults',
);

// 3. Absent everything: sessionModel falls back to "session", an unset
//    forge type leaves each repo's origin to pick its adapter
assertEq(
  configSummary({}),
  'sessionModel: session | tracker: off | forge: auto (from origin) | repos: none',
  'an empty config degrades without inventing values',
);
assertEq(
  configSummary({ workspace: { sessionModel: 'task', forge: {} } }),
  'sessionModel: task | tracker: off | forge: auto (from origin) | repos: none',
  'a forge object without a type is origin-picked, not "github"',
);

// 4. sessionModel: a non-string value routes like absent config in
//    /start-work, so it prints as the fallback rather than raw garbage
assertEq(
  configSummary({ workspace: { sessionModel: 5 } }),
  'sessionModel: session | tracker: off | forge: auto (from origin) | repos: none',
  'a non-string sessionModel prints the "session" fallback',
);

// 5. Tracker without a type — the adapter would throw, so the line says so
assertEq(
  configSummary({ workspace: { tracker: { repo: 'acme/monorepo' } } }),
  'sessionModel: session | tracker: invalid (no type) | forge: auto (from origin) | repos: none',
  'a tracker object without a type is invalid (no type)',
);

// 6. A truthy non-object tracker — nothing createTracker could take
assertEq(
  configSummary({ workspace: { tracker: 'github-issues' } }),
  'sessionModel: session | tracker: invalid | forge: auto (from origin) | repos: none',
  'a non-object tracker is invalid',
);

// 7. Forge: false disables forge ops; a string forge is not a config
assertEq(
  configSummary({ workspace: { forge: false } }),
  'sessionModel: session | tracker: off | forge: off | repos: none',
  'forge: false prints off',
);
assertEq(
  configSummary({ workspace: { forge: 'gitlab' } }),
  'sessionModel: session | tracker: off | forge: invalid | repos: none',
  'a string forge is invalid',
);

// 8. Repos: absent/null reads as an empty manifest (what the scripts see via
//    `Object.keys(repos || {})`); anything else non-object is invalid
assertEq(
  configSummary({ repos: null }),
  'sessionModel: session | tracker: off | forge: auto (from origin) | repos: none',
  'repos: null is an empty manifest, not invalid',
);
assertEq(
  configSummary({ repos: ['my-app'] }),
  'sessionModel: session | tracker: off | forge: auto (from origin) | repos: invalid',
  'an array repos value is invalid',
);
assertEq(
  configSummary({ repos: 'my-app' }),
  'sessionModel: session | tracker: off | forge: auto (from origin) | repos: invalid',
  'a string repos value is invalid',
);
assertEq(
  configSummary({ repos: { 'my-app': { primary: true }, 'my-api': {} } }),
  'sessionModel: session | tracker: off | forge: auto (from origin) | repos: my-app (primary), my-api',
  'repos entries print with primary marked',
);

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
